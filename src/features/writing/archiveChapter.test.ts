import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ExtractEntry,
  type ExtractResult,
  buildExtractUserPrompt,
} from '@/features/import/extractSettings';
import { LlmError } from '@/llm/errors';
import type { LlmRunner } from '@/llm/useLlm';
import { buildCreateProposal } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import type {
  Category,
  Chapter,
  KnowledgeEntry,
  Novel,
  Proposal,
  SideStory,
} from '@/domain/schema';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { archiveBatchKey } from './archiveBatch';
import {
  archiveChapter,
  supersedePendingChapterSummary,
  type ArchiveChapterInput,
} from './archiveChapter';

let harness: TestHarness;
let novel: Novel;
let earlier: Chapter;
let chapter: Chapter;
let worldCategory: Category;
let characterCategory: Category;
let linYue: KnowledgeEntry;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  const categories = await harness.repository.listCategories(novel.id);
  worldCategory = categories.find((category) => category.kind === 'worldbuilding')!;
  characterCategory = categories.find((category) => category.kind === 'character')!;

  earlier = await harness.repository.createChapter(novel.id, { title: '第1章 渡口' });
  chapter = await harness.repository.createChapter(novel.id, {
    title: '第2章 雪夜',
    content: '林越在渡口醒来，裴照把刀递给他。',
  });
  await harness.repository.upsertSummary(novel.id, earlier.id, {
    summary: '林越在渡口醒来。',
    keyEvents: ['林越醒来'],
    openThreads: ['刀的主人'],
  });
  linYue = await harness.repository.createEntry(novel.id, {
    categoryId: characterCategory.id,
    title: '林越',
    aliases: ['阿越'],
    summary: '失忆剑客',
    fields: { goal: '复仇' },
    sourceChapterIds: [earlier.id],
  });
});

afterEach(async () => {
  await harness.cleanup();
});

// ---------------------------------------------------------------- 测试替身

interface FakeCall {
  task: string;
  options: Record<string, unknown>;
}

/** 只实现 runStructured 的 LlmRunner 替身；记录每次调用的任务与参数 */
function fakeLlm(
  handler: (
    task: string,
    options: Record<string, unknown>,
    callIndex: number,
  ) => Promise<{ data: unknown }>,
): { llm: LlmRunner; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const llm = {
    configured: true,
    runStructured: async (task: string, options: Record<string, unknown>) => {
      const callIndex = calls.length;
      calls.push({ task, options });
      const { data } = await handler(task, options, callIndex);
      return { data, attempts: 1 };
    },
  } as unknown as LlmRunner;
  return { llm, calls };
}

function extractResult(overrides: Partial<ExtractResult> = {}): ExtractResult {
  return {
    entries: [],
    summary: '林越在渡口醒来，被裴照带走。',
    keyEvents: ['林越醒来', '裴照出现'],
    appearingEntries: ['林越'],
    newOpenThreads: ['阿越的身世'],
    resolvedThreads: [],
    rollingSummary: '林越失忆，随裴照北上追查旧案。',
    ...overrides,
  };
}

function extractedEntry(
  input: { categoryName: string; title: string } & Partial<ExtractEntry>,
): ExtractEntry {
  return { aliases: [], summary: '', fields: [], ...input };
}

async function buildInput(
  overrides: Partial<ArchiveChapterInput> = {},
): Promise<ArchiveChapterInput> {
  return {
    novel: (await harness.repository.getNovel(novel.id))!,
    chapter,
    chapters: await harness.repository.listChapters(novel.id),
    summaries: await harness.repository.listSummaries(novel.id),
    entries: await harness.repository.listEntries(novel.id),
    categories: await harness.repository.listCategories(novel.id),
    options: { extractEntries: true },
    ...overrides,
  };
}

async function pendingProposals(): Promise<Proposal[]> {
  return harness.repository.listProposals(novel.id, { status: 'pending' });
}

function payload(proposal: Proposal): Record<string, unknown> {
  return proposal.payload as Record<string, unknown>;
}

// ---------------------------------------------------------------- 用例

describe('归档服务：提取路径', () => {
  it('一次 extract-settings 调用产出摘要、进展与条目提案', async () => {
    const { llm, calls } = fakeLlm(async () => ({
      data: extractResult({
        entries: [
          extractedEntry({
            categoryName: '人物',
            title: '沈砚',
            aliases: ['小舟'],
            summary: '沉默剑客',
            fields: [{ key: 'goal', value: '寻找妹妹' }],
          }),
          extractedEntry({
            categoryName: '人物',
            title: '林越',
            summary: '林越的真实身份被揭开',
            fields: [{ key: 'goal', value: '复仇与真相' }],
          }),
        ],
      }),
    }));

    const result = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput(),
    );

    // 一次调用同时拿摘要与条目；提示词带上已有条目全文与累计伏笔
    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe('extract-settings');
    expect(calls[0]!.options.schemaName).toBe('ChapterArchive');
    expect(calls[0]!.options.failOnTruncation).toBe(true);
    expect(String(calls[0]!.options.system)).toContain('归墟纪');
    const userPrompt = String(calls[0]!.options.user);
    expect(userPrompt).toContain('裴照把刀递给他');
    expect(userPrompt).toContain('【本章涉及的已有条目（含现有完整内容）】');
    expect(userPrompt).toContain('【当前未收束的伏笔】\n- 刀的主人');
    // 归档路径追加龙套门槛；只影响归档，导入链路不受影响（见文末用例）
    expect(userPrompt).toContain('【归档额外要求】');
    expect(userPrompt).toContain('职务/一次性龙套不要建条目');

    expect(result.summaryCreated).toBe(true);
    expect(result.entriesDegraded).toBe(false);
    expect(result.entryCount).toBe(2);
    expect(result.pendingCount).toBe(2);

    const proposals = await pendingProposals();
    expect(proposals).toHaveLength(4);
    expect(proposals.every((proposal) => proposal.batchId === result.batchId)).toBe(true);

    const summaryProposal = proposals.find((proposal) => proposal.target === 'chapterSummary')!;
    expect(summaryProposal.action).toBe('create');
    expect(payload(summaryProposal)).toMatchObject({
      chapterId: chapter.id,
      summary: '林越在渡口醒来，被裴照带走。',
      keyEvents: ['林越醒来', '裴照出现'],
      appearingEntryIds: [linYue.id],
      // 上章遗留的伏笔保留，本章新伏笔并入
      openThreads: ['刀的主人', '阿越的身世'],
    });

    const progressProposal = proposals.find((proposal) => proposal.target === 'novel')!;
    expect(progressProposal.action).toBe('replace');
    expect(progressProposal.targetId).toBe(novel.id);
    expect(payload(progressProposal)).toEqual({
      rollingSummary: '林越失忆，随裴照北上追查旧案。',
    });

    const shen = proposals.find(
      (proposal) => proposal.target === 'knowledgeEntry' && payload(proposal).title === '沈砚',
    )!;
    expect(shen.action).toBe('create');
    expect(payload(shen)).toMatchObject({
      categoryId: characterCategory.id,
      aliases: ['小舟'],
      summary: '沉默剑客',
      fields: { goal: '寻找妹妹' },
      sourceChapterIds: [chapter.id],
    });

    const lin = proposals.find(
      (proposal) => proposal.target === 'knowledgeEntry' && payload(proposal).title === '林越',
    )!;
    expect(lin.action).toBe('merge');
    expect(lin.targetId).toBe(linYue.id);
    // 本章给的是「整合后的完整值」，字段取新值，溯源章节取并集
    expect(payload(lin).fields).toEqual({ goal: '复仇与真相' });
    expect(payload(lin).sourceChapterIds).toEqual(expect.arrayContaining([earlier.id, chapter.id]));
    expect(payload(lin).sourceChapterIds).toHaveLength(2);
  });

  it('重跑幂等：摘要只剩一条、条目提案不重复', async () => {
    const { llm, calls } = fakeLlm(async () => ({
      data: extractResult({
        entries: [
          extractedEntry({
            categoryName: '人物',
            title: '沈砚',
            summary: '沉默剑客',
            fields: [{ key: 'goal', value: '寻找妹妹' }],
          }),
        ],
      }),
    }));

    await archiveChapter({ repository: harness.repository, llm }, await buildInput());
    const firstEntries = (await pendingProposals()).filter(
      (proposal) => proposal.target === 'knowledgeEntry',
    );
    const second = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput(),
    );

    expect(calls).toHaveLength(2);
    expect(second.entryCount).toBe(0);

    const proposals = await pendingProposals();
    // 摘要按 chapterId 先清后建，重跑后仍然只有一条
    expect(
      proposals.filter(
        (proposal) =>
          proposal.target === 'chapterSummary' && payload(proposal).chapterId === chapter.id,
      ),
    ).toHaveLength(1);
    // 同名条目走 pending 合并，不新建
    const entryProposals = proposals.filter((proposal) => proposal.target === 'knowledgeEntry');
    expect(entryProposals.map((proposal) => proposal.id)).toEqual(
      firstEntries.map((proposal) => proposal.id),
    );
    // 进展就地更新，重跑不新增第二条
    expect(proposals.filter((proposal) => proposal.target === 'novel')).toHaveLength(1);
  });

  it('批内 pending 同名合并：跨章累计字段与溯源，不跨批改旧批', async () => {
    const chapter2 = await harness.repository.createChapter(novel.id, {
      title: '第3章 旧识',
      content: '沈砚在木屋出现，自称是小舟。',
    });
    const { llm } = fakeLlm(async (_task, _options, callIndex) => ({
      data: extractResult({
        entries: [
          extractedEntry({
            categoryName: '人物',
            title: '沈砚',
            summary: callIndex === 0 ? '沉默剑客' : '沉默剑客，左脸有疤',
            fields: [
              { key: 'goal', value: '寻找妹妹' },
              ...(callIndex === 1 ? [{ key: 'flaw', value: '怕水' }] : []),
            ],
          }),
        ],
      }),
    }));

    const first = await archiveChapter({ repository: harness.repository, llm }, await buildInput());
    const second = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput({ chapter: chapter2 }),
    );

    expect(second.batchId).toBe(first.batchId);
    expect(second.entryCount).toBe(1);
    expect(second.pendingCount).toBe(1);

    const proposals = await pendingProposals();
    const entryProposals = proposals.filter((proposal) => proposal.target === 'knowledgeEntry');
    expect(entryProposals).toHaveLength(1);
    expect(payload(entryProposals[0]!)).toMatchObject({
      title: '沈砚',
      summary: '沉默剑客，左脸有疤',
      fields: { goal: '寻找妹妹', flaw: '怕水' },
      sourceChapterIds: [chapter.id, chapter2.id],
    });
  });

  it('批内 pending 合并也覆盖「合并已存条目」提案，并重算 diff', async () => {
    const chapter2 = await harness.repository.createChapter(novel.id, {
      title: '第3章 旧识',
      content: '林越在木屋擦刀。',
    });
    const { llm } = fakeLlm(async (_task, _options, callIndex) => ({
      data: extractResult({
        entries: [
          extractedEntry({
            categoryName: '人物',
            title: '林越',
            fields: [
              { key: 'goal', value: '复仇' },
              { key: 'flaw', value: '怕水' },
              ...(callIndex === 0 ? [] : [{ key: 'voice', value: '短句、爱用反问' }]),
            ],
          }),
        ],
      }),
    }));

    await archiveChapter({ repository: harness.repository, llm }, await buildInput());
    const second = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput({ chapter: chapter2 }),
    );

    expect(second.entryCount).toBe(1);
    const entryProposals = (await pendingProposals()).filter(
      (proposal) => proposal.target === 'knowledgeEntry',
    );
    // 始终只有一条「合并林越」提案，第二次是就地更新
    expect(entryProposals).toHaveLength(1);
    const merged = entryProposals[0]!;
    expect(merged.action).toBe('merge');
    expect(merged.targetId).toBe(linYue.id);
    expect(payload(merged).fields).toMatchObject({
      goal: '复仇',
      flaw: '怕水',
      voice: '短句、爱用反问',
    });
    // 溯源并集：已存条目的旧溯源 + 本章 + 下一章
    expect(payload(merged).sourceChapterIds).toEqual([earlier.id, chapter.id, chapter2.id]);
    // 更新 payload 时必须同步重算 diff，否则确认界面显示的还是上一次的改动
    expect(merged.diff.some((item) => item.field === 'fields.voice')).toBe(true);
  });

  it('已存条目字段/摘要/别名都没变时跳过，不出提案', async () => {
    const { llm } = fakeLlm(async () => ({
      data: extractResult({
        entries: [
          extractedEntry({
            categoryName: '人物',
            title: '林越',
            aliases: ['阿越'],
            summary: '失忆剑客',
            fields: [{ key: 'goal', value: '复仇' }],
          }),
        ],
      }),
    }));

    const result = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput(),
    );

    expect(result.entryCount).toBe(0);
    const proposals = await pendingProposals();
    expect(proposals.filter((proposal) => proposal.target === 'knowledgeEntry')).toHaveLength(0);
    // 摘要与进展照常出
    expect(proposals).toHaveLength(2);
  });

  it('上限：普通条目每章 3 条，人物分类新条目另有 3 条豁免', async () => {
    const custom = await harness.repository.createCategory(novel.id, { name: '势力' });
    const { llm } = fakeLlm(async () => ({
      data: extractResult({
        entries: [
          extractedEntry({ categoryName: '世界观设定', title: '世界观1' }),
          extractedEntry({ categoryName: '人物', title: '人物1' }),
          extractedEntry({ categoryName: '世界观设定', title: '世界观2' }),
          extractedEntry({ categoryName: '人物', title: '人物2' }),
          extractedEntry({ categoryName: '世界观设定', title: '世界观3' }),
          extractedEntry({ categoryName: '人物', title: '人物3' }),
          extractedEntry({ categoryName: '世界观设定', title: '世界观4' }),
          extractedEntry({ categoryName: '人物', title: '人物4' }),
          extractedEntry({ categoryName: custom.name, title: '势力1' }),
        ],
      }),
    }));

    const result = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput(),
    );

    expect(result.entryCount).toBe(6);
    const titles = (await pendingProposals())
      .filter((proposal) => proposal.target === 'knowledgeEntry')
      .map((proposal) => payload(proposal).title);
    expect(titles.sort()).toEqual(
      ['世界观1', '世界观2', '世界观3', '人物1', '人物2', '人物3'].sort(),
    );
    // 自定义分类里的角色不享受人物豁免（按 kind=character 判断）
    expect(titles).not.toContain('势力1');
    expect(worldCategory.kind).toBe('worldbuilding');
  });

  it('已有已采用摘要时出 replace 提案而不是 create', async () => {
    const adopted = await harness.repository.upsertSummary(novel.id, chapter.id, {
      summary: '旧摘要',
      keyEvents: ['旧事件'],
      openThreads: [],
    });
    const { llm } = fakeLlm(async () => ({ data: extractResult() }));

    await archiveChapter({ repository: harness.repository, llm }, await buildInput());

    const summaryProposal = (await pendingProposals()).find(
      (proposal) => proposal.target === 'chapterSummary',
    )!;
    expect(summaryProposal.action).toBe('replace');
    expect(summaryProposal.targetId).toBe(adopted.id);
    expect(payload(summaryProposal).summary).toBe('林越在渡口醒来，被裴照带走。');
  });
});

describe('归档服务：同批进展提案去重', () => {
  it('同批两章只保留一条进展提案，后一章就地更新 payload 与 diff', async () => {
    const chapter2 = await harness.repository.createChapter(novel.id, {
      title: '第3章 旧识',
      content: '林越在木屋擦刀。',
    });
    const { llm } = fakeLlm(async (_task, _options, callIndex) => ({
      data: extractResult({
        rollingSummary: callIndex === 0 ? '第一章后的进展。' : '第二章后的进展。',
      }),
    }));

    const first = await archiveChapter({ repository: harness.repository, llm }, await buildInput());
    const second = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput({ chapter: chapter2 }),
    );

    expect(second.batchId).toBe(first.batchId);
    const proposals = await pendingProposals();
    // 同批只留一条滚动进展提案
    const progressProposals = proposals.filter((proposal) => proposal.target === 'novel');
    expect(progressProposals).toHaveLength(1);
    const progress = progressProposals[0]!;
    expect(payload(progress).rollingSummary).toBe('第二章后的进展。');
    // 溯源自最近一章；diff 相对「已采用值」（这里为空）重算
    expect(progress.sourceRef).toBe('第 3 章');
    expect(progress.diff).toEqual([
      expect.objectContaining({
        field: 'rollingSummary',
        before: '',
        after: '第二章后的进展。',
        kind: 'added',
      }),
    ]);
    // 摘要仍按章各一条
    expect(proposals.filter((proposal) => proposal.target === 'chapterSummary')).toHaveLength(2);
    // 进展挪到本批末尾：阅读顺序是「本章摘要 → 截至本章的累计进展」
    const secondSummary = proposals.find(
      (proposal) =>
        proposal.target === 'chapterSummary' && payload(proposal).chapterId === chapter2.id,
    )!;
    expect(progress.order).toBeGreaterThan(secondSummary.order);
  });

  it('不同批各保留一条进展提案', async () => {
    const chapter2 = await harness.repository.createChapter(novel.id, {
      title: '第3章 旧识',
      content: '林越在木屋擦刀。',
    });
    const { llm } = fakeLlm(async (_task, _options, callIndex) => ({
      data: extractResult({ rollingSummary: `第 ${callIndex + 2} 章后的进展。` }),
    }));

    const first = await archiveChapter({ repository: harness.repository, llm }, await buildInput());
    // 清掉批次状态 = 开新批（相当于隔天再归档）
    localStorage.removeItem(archiveBatchKey(novel.id));
    const second = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput({ chapter: chapter2 }),
    );

    expect(second.batchId).not.toBe(first.batchId);
    const progressProposals = (await pendingProposals()).filter(
      (proposal) => proposal.target === 'novel',
    );
    expect(progressProposals).toHaveLength(2);
    expect(new Set(progressProposals.map((proposal) => proposal.batchId))).toEqual(
      new Set([first.batchId, second.batchId]),
    );
  });

  it('外传进展按 targetId 区分：同外传合并、不同外传各一条', async () => {
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    const latestStory: SideStory = (await harness.repository.getSideStory(story.id))!;
    const side1 = await harness.repository.createChapter(novel.id, {
      title: '第1章 旧事',
      content: '少年裴照走进六扇门。',
      sideStoryId: story.id,
    });
    const side2 = await harness.repository.createChapter(novel.id, {
      title: '第2章 旧案',
      content: '裴照翻出师父的旧案卷。',
      sideStoryId: story.id,
    });
    const storyB = await harness.repository.createSideStory(novel.id, { title: '海上花' });
    const latestStoryB: SideStory = (await harness.repository.getSideStory(storyB.id))!;
    const sideB = await harness.repository.createChapter(novel.id, {
      title: '第1章 花',
      content: '海船上有人唱歌。',
      sideStoryId: storyB.id,
    });
    const { llm } = fakeLlm(async (_task, _options, callIndex) => ({
      data: extractResult({ rollingSummary: `外传进展第 ${callIndex + 1} 版。` }),
    }));

    const first = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput({ chapter: side1, sideStory: latestStory }),
    );
    const second = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput({ chapter: side2, sideStory: latestStory }),
    );
    const third = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput({ chapter: sideB, sideStory: latestStoryB }),
    );

    expect(second.batchId).toBe(first.batchId);
    expect(third.batchId).toBe(first.batchId);
    const sideProgress = (await pendingProposals()).filter(
      (proposal) => proposal.target === 'sideStory',
    );
    // 同一部外传只留一条（最新一版），另一部外传各有一条，互不覆盖
    expect(sideProgress).toHaveLength(2);
    const forStory = sideProgress.find((proposal) => proposal.targetId === story.id)!;
    const forStoryB = sideProgress.find((proposal) => proposal.targetId === storyB.id)!;
    expect(payload(forStory).rollingSummary).toBe('外传进展第 2 版。');
    expect(payload(forStoryB).rollingSummary).toBe('外传进展第 3 版。');
    expect((await pendingProposals()).some((proposal) => proposal.target === 'novel')).toBe(false);
  });
});

describe('归档服务：两类调用路径', () => {
  it('extractEntries=false 走 chapter-summary，只出摘要与进展', async () => {
    const { llm, calls } = fakeLlm(async () => ({
      data: {
        summary: '林越醒来了。',
        keyEvents: ['醒来'],
        appearingEntries: ['林越'],
        newOpenThreads: [],
        resolvedThreads: [],
        rollingSummary: '林越醒来。',
      },
    }));

    const result = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput({ options: { extractEntries: false } }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe('chapter-summary');
    expect(calls[0]!.options.schemaName).toBe('ChapterSummary');
    expect(String(calls[0]!.options.system)).toContain('归墟纪');
    expect(String(calls[0]!.options.user)).toContain('【可选的人物与设定名单】');
    // 只出摘要的路径不提取条目，也就不需要龙套门槛
    expect(String(calls[0]!.options.user)).not.toContain('【归档额外要求】');

    expect(result.entryCount).toBe(0);
    expect(result.entriesDegraded).toBe(false);
    const targets = (await pendingProposals()).map((proposal) => proposal.target);
    expect(targets.sort()).toEqual(['chapterSummary', 'novel']);
  });

  it('条目提取被截断时降级为摘要专用调用，摘要链不断', async () => {
    const { llm, calls } = fakeLlm(async (task) => {
      if (task === 'extract-settings') {
        throw new LlmError('truncated', '输出被截断');
      }
      return {
        data: {
          summary: '林越醒来了。',
          keyEvents: ['醒来'],
          appearingEntries: ['林越'],
          newOpenThreads: [],
          resolvedThreads: [],
          rollingSummary: '林越醒来。',
        },
      };
    });

    const result = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput(),
    );

    expect(calls.map((call) => call.task)).toEqual(['extract-settings', 'chapter-summary']);
    // 门槛只加在 extract 调用上；降级后的摘要 prompt 不带它
    expect(String(calls[0]!.options.user)).toContain('【归档额外要求】');
    expect(String(calls[1]!.options.user)).not.toContain('【归档额外要求】');
    expect(result.entriesDegraded).toBe(true);
    expect(result.entryCount).toBe(0);
    expect((await pendingProposals()).map((proposal) => proposal.target).sort()).toEqual([
      'chapterSummary',
      'novel',
    ]);
  });

  it('摘要专用调用也失败时整体失败，什么都不写', async () => {
    const { llm } = fakeLlm(async () => {
      throw new LlmError('server', '模型服务暂时不可用');
    });

    await expect(
      archiveChapter({ repository: harness.repository, llm }, await buildInput()),
    ).rejects.toThrow('模型服务暂时不可用');
    expect(await pendingProposals()).toHaveLength(0);
  });
});

describe('归档服务：失败与边界', () => {
  it('模型失败时不写任何提案，本章旧的 pending 摘要也保留', async () => {
    const { llm: okLlm } = fakeLlm(async () => ({ data: extractResult() }));
    await archiveChapter({ repository: harness.repository, llm: okLlm }, await buildInput());
    const before = await pendingProposals();
    expect(before.length).toBeGreaterThan(0);

    const { llm: failingLlm } = fakeLlm(async () => {
      throw new LlmError('network', '无法连接模型服务');
    });
    await expect(
      archiveChapter({ repository: harness.repository, llm: failingLlm }, await buildInput()),
    ).rejects.toThrow('无法连接模型服务');

    const after = await pendingProposals();
    expect(after.map((proposal) => proposal.id)).toEqual(before.map((proposal) => proposal.id));
  });

  it('正文为空时直接拒绝，不调用模型', async () => {
    const { llm, calls } = fakeLlm(async () => ({ data: extractResult() }));
    await expect(
      archiveChapter(
        { repository: harness.repository, llm },
        await buildInput({ chapter: { ...chapter, content: '   ' } }),
      ),
    ).rejects.toThrow('本章还没有正文');
    expect(calls).toHaveLength(0);
  });

  it('外传章节缺少外传信息时拒绝，避免把外传进展写进主线', async () => {
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    const sideChapter = await harness.repository.createChapter(novel.id, {
      title: '第1章 旧事',
      content: '少年裴照走进六扇门。',
      sideStoryId: story.id,
    });
    const { llm, calls } = fakeLlm(async () => ({ data: extractResult() }));

    await expect(
      archiveChapter(
        { repository: harness.repository, llm },
        await buildInput({ chapter: sideChapter }),
      ),
    ).rejects.toThrow('需要传入所属外传');
    expect(calls).toHaveLength(0);
  });
});

describe('归档服务：外传', () => {
  it('外传章节的进展写外传而不是全书，prompt 带外传说明', async () => {
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    await harness.repository.updateSideStory(story.id, { rollingSummary: '师父刚拜入青冥宗。' });
    const latestStory: SideStory = (await harness.repository.getSideStory(story.id))!;
    const sideChapter = await harness.repository.createChapter(novel.id, {
      title: '第1章 旧事',
      content: '少年裴照走进六扇门。',
      sideStoryId: story.id,
    });
    const { llm, calls } = fakeLlm(async () => ({ data: extractResult() }));

    const result = await archiveChapter(
      { repository: harness.repository, llm },
      await buildInput({ chapter: sideChapter, sideStory: latestStory }),
    );

    const userPrompt = String(calls[0]!.options.user);
    expect(userPrompt).toContain('本批正文是外传《青冥旧事》');
    expect(userPrompt).toContain('【此前的外传进展摘要】\n师父刚拜入青冥宗。');

    const proposals = await pendingProposals();
    const progressProposal = proposals.find((proposal) => proposal.target === 'sideStory')!;
    expect(progressProposal).toBeDefined();
    expect(progressProposal.targetId).toBe(story.id);
    expect(progressProposal.label).toBe('外传进展摘要');
    expect(proposals.some((proposal) => proposal.target === 'novel')).toBe(false);

    const summaryProposal = proposals.find((proposal) => proposal.target === 'chapterSummary')!;
    expect(summaryProposal.sourceRef.startsWith('外传·青冥旧事')).toBe(true);
    expect(result.batchId).toBeTruthy();
  });
});

describe('supersedePendingChapterSummary', () => {
  it('只清本章的 pending 摘要，别的章节不动', async () => {
    const otherChapter = await harness.repository.createChapter(novel.id, {
      title: '第3章 别章',
    });
    const specs = fieldSpecsFor('chapterSummary');
    const build = (chapterId: string, title: string) =>
      buildCreateProposal({
        novelId: novel.id,
        origin: 'refine',
        target: 'chapterSummary',
        label: title,
        specs,
        payload: {
          chapterId,
          summary: '摘要',
          keyEvents: ['事件'],
          appearingEntryIds: [],
          openThreads: [],
        },
      });
    await harness.repository.createProposals([
      build(chapter.id, '本章摘要'),
      build(otherChapter.id, '别章摘要'),
    ]);

    const removed = await supersedePendingChapterSummary(harness.repository, novel.id, chapter.id);

    expect(removed).toBe(1);
    const remaining = await pendingProposals();
    expect(remaining).toHaveLength(1);
    expect(payload(remaining[0]!)).toMatchObject({ chapterId: otherChapter.id });
  });
});

describe('归档额外要求（龙套门槛）', () => {
  it('导入链路的 buildExtractUserPrompt 不受影响，不含归档额外要求', () => {
    const prompt = buildExtractUserPrompt({
      chapter: { index: chapter.index, title: chapter.title, content: chapter.content },
      mentionedEntries: [],
      categories: [worldCategory, characterCategory],
      otherEntryNames: [],
      openThreads: [],
      rollingSummary: '',
    });

    expect(prompt).toContain('【本章正文（第 2 章 第2章 雪夜）】');
    expect(prompt).not.toContain('【归档额外要求】');
    expect(prompt).not.toContain('龙套');
  });
});
