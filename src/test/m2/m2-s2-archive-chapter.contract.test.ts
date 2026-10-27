/**
 * M2-S2 独立验收：章节归档服务（design §2、§6.1/6.2/6.3/6.4/6.7）。
 *
 * 独立于开发的 archiveChapter.test.ts：用真实 Dexie 仓储 + 假 LlmRunner，
 * 逐项验证「一次调用出摘要+进展+条目」「幂等」「同批合并」「上限/人物豁免」
 * 「extractEntries=false 走摘要路径」「截断降级」「失败不写库」「批次轮转」。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '@/data/dexie/db';
import { DexieNovelRepository } from '@/data/dexie/DexieNovelRepository';
import type { NovelRepository } from '@/data/NovelRepository';
import type { Category, Chapter, KnowledgeEntry, Novel, Proposal } from '@/domain/schema';
import { LlmError } from '@/llm/errors';
import type { LlmRunner, StructuredRunOptions } from '@/llm/useLlm';
import type { TaskKind } from '@/llm/taskProfiles';
import { readArchiveBatch, archiveBatchKey } from '@/features/writing/archiveBatch';
import {
  ARCHIVE_EXTRACT_EXTRA_REQUIREMENT,
  MAX_ENTRY_PROPOSALS_PER_CHAPTER,
  archiveChapter,
  supersedePendingChapterSummary,
  type ArchiveChapterInput,
} from '@/features/writing/archiveChapter';
import { buildExtractUserPrompt } from '@/features/import/extractSettings';

let database: AppDatabase;
let repo: NovelRepository;
let novel: Novel;
let categories: Category[];
let characterCategory: Category;
let worldCategory: Category;

beforeEach(async () => {
  database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  repo = new DexieNovelRepository(database);
  novel = await repo.createNovel({ title: '归档之书', genre: '仙侠' });
  categories = await repo.listCategories(novel.id);
  worldCategory = categories.find((category) => category.kind === 'worldbuilding')!;
  characterCategory = categories.find((category) => category.kind === 'character')!;
  localStorage.clear();
});

afterEach(async () => {
  database.close();
  await database.delete();
  localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- fixtures

type Handler = (task: TaskKind, options: StructuredRunOptions<unknown>) => unknown;

interface LlmFixture {
  llm: LlmRunner;
  calls: { task: TaskKind; options: StructuredRunOptions<unknown> }[];
}

/** 假 LlmRunner：runStructured 走 handler，其余方法不应被调用 */
function fakeLlm(handler: Handler): LlmFixture {
  const calls: { task: TaskKind; options: StructuredRunOptions<unknown> }[] = [];
  const llm = {
    configured: true,
    client: {} as unknown,
    runStructured: vi.fn(async (task: TaskKind, options: StructuredRunOptions<unknown>) => {
      calls.push({ task, options });
      return { data: await handler(task, options), attempts: 1 };
    }),
    runStream: vi.fn(),
    runProseWithTail: vi.fn(),
  } as unknown as LlmRunner;
  return { llm, calls };
}

function extractEntry(
  categoryName: string,
  title: string,
  fields: Record<string, string> = {},
  aliases: string[] = [],
) {
  return {
    categoryName,
    title,
    aliases,
    summary: `${title}的摘要。`,
    fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
  };
}

function extractPayload(overrides: Record<string, unknown> = {}) {
  return {
    entries: [] as unknown[],
    summary: '本章摘要。',
    keyEvents: ['一个事件'],
    appearingEntries: [] as string[],
    newOpenThreads: ['新的伏笔'],
    resolvedThreads: [] as string[],
    rollingSummary: '全书进展到了本章。',
    ...overrides,
  };
}

async function makeChapter(
  title: string,
  content = '这是本章正文，足够用来归档。',
): Promise<Chapter> {
  return repo.createChapter(novel.id, { title, content });
}

function inputFor(
  chapter: Chapter,
  options: { extractEntries?: boolean; chapters?: Chapter[]; entries?: KnowledgeEntry[] } = {},
): ArchiveChapterInput {
  return {
    novel,
    chapter,
    chapters: options.chapters ?? [chapter],
    summaries: [],
    entries: options.entries ?? [],
    categories,
    options: { extractEntries: options.extractEntries ?? true },
  };
}

async function pendingProposals(): Promise<Proposal[]> {
  return repo.listProposals(novel.id, { status: 'pending' });
}

function proposalsOf(proposals: Proposal[], target: Proposal['target']): Proposal[] {
  return proposals.filter((proposal) => proposal.target === target);
}

// ---------------------------------------------------------------- 用例

describe('M2-S2 · 一次调用产出摘要 + 进展 + 条目', () => {
  it('extract-settings 一次、failOnTruncation；摘要/进展/条目同 batch 且字段正确', async () => {
    const existing = await repo.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '裴照',
      summary: '旧摘要。',
    });
    const chapter = await makeChapter('夜渡', '沈砚与裴照夜渡，裴照提起青冥宗。');
    const { llm, calls } = fakeLlm((task) => {
      expect(task).toBe('extract-settings');
      return extractPayload({
        entries: [
          extractEntry(characterCategory.name, '沈砚', { identity: '流亡贵族' }, ['小舟']),
          extractEntry('人物', '裴照', { identity: '六扇门捕头' }), // 已存条目有变化
        ],
        appearingEntries: ['裴照'],
        newOpenThreads: ['青冥宗旧案'],
        rollingSummary: '两人夜渡北上。',
      });
    });

    const result = await archiveChapter(
      { repository: repo, llm },
      inputFor(chapter, { entries: [existing] }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe('extract-settings');
    expect(calls[0]!.options.failOnTruncation).toBe(true);
    // prompt 带上了本章正文与已存条目的完整字段（用于合并）
    expect(calls[0]!.options.user).toContain('本章正文');
    expect(calls[0]!.options.user).toContain('裴照');
    // task-27 行为契约：归档 extract 路径末尾以空行追加龙套门槛（导出常量可直接断言）
    expect(calls[0]!.options.user).toContain('【归档额外要求】');
    expect(calls[0]!.options.user).toContain('龙套');
    expect(calls[0]!.options.user.endsWith(`\n\n${ARCHIVE_EXTRACT_EXTRA_REQUIREMENT}`)).toBe(true);

    expect(result.summaryCreated).toBe(true);
    expect(result.entriesDegraded).toBe(false);
    expect(result.entryCount).toBeGreaterThanOrEqual(2);
    expect(result.pendingCount).toBe(result.entryCount);

    const pending = await pendingProposals();
    const summaries = proposalsOf(pending, 'chapterSummary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.batchId).toBe(result.batchId);
    expect(summaries[0]!.action).toBe('create');
    expect(summaries[0]!.payload).toMatchObject({
      chapterId: chapter.id,
      summary: '本章摘要。',
      keyEvents: ['一个事件'],
      openThreads: ['青冥宗旧案'],
    });
    // appearingEntries 名称解析为条目 id
    expect((summaries[0]!.payload as { appearingEntryIds: string[] }).appearingEntryIds).toEqual([
      existing.id,
    ]);

    const progress = proposalsOf(pending, 'novel');
    expect(progress).toHaveLength(1);
    expect(progress[0]!.batchId).toBe(result.batchId);
    expect(progress[0]!.action).toBe('replace');
    expect(progress[0]!.payload).toEqual({ rollingSummary: '两人夜渡北上。' });

    const entryProposals = proposalsOf(pending, 'knowledgeEntry');
    expect(
      entryProposals.map((proposal) => (proposal.payload as { title: string }).title).sort(),
    ).toEqual(['沈砚', '裴照']);
    expect(entryProposals.every((proposal) => proposal.batchId === result.batchId)).toBe(true);
    // 批次已写入 localStorage（供下一章复用）
    expect(readArchiveBatch(novel.id)?.chapterIds).toEqual([chapter.id]);
    expect(localStorage.getItem(archiveBatchKey(novel.id))).not.toBeNull();
  });
});

describe('M2-S2 · 幂等与同批合并', () => {
  it('同章重跑：只清本章 pending 摘要、进展仍一条、条目提案不重复', async () => {
    const chapter = await makeChapter('第一章');
    let round = 0;
    const { llm } = fakeLlm(() => {
      round += 1;
      return extractPayload({
        entries: [extractEntry(worldCategory.name, '灵气', { rules: `第 ${round} 版规则` })],
        summary: `第 ${round} 次摘要`,
        rollingSummary: `第 ${round} 版进展`,
      });
    });

    await archiveChapter({ repository: repo, llm }, inputFor(chapter));
    const firstEntryCount = proposalsOf(await pendingProposals(), 'knowledgeEntry').length;
    await archiveChapter({ repository: repo, llm }, inputFor(chapter));

    const pending = await pendingProposals();
    expect(proposalsOf(pending, 'chapterSummary')).toHaveLength(1); // 旧 pending 被清
    expect(proposalsOf(pending, 'novel')).toHaveLength(1); // 进展就地更新
    expect(proposalsOf(pending, 'knowledgeEntry')).toHaveLength(firstEntryCount); // 同名合并
    expect(
      (proposalsOf(pending, 'chapterSummary')[0]!.payload as { summary: string }).summary,
    ).toBe('第 2 次摘要');
    expect(
      (proposalsOf(pending, 'novel')[0]!.payload as { rollingSummary: string }).rollingSummary,
    ).toBe('第 2 版进展');
  });

  it('同批跨章同名条目合并：只留一条提案，字段/别名/溯源合并', async () => {
    const ch1 = await makeChapter('第一章');
    const ch2 = await makeChapter('第二章');
    const { llm } = fakeLlm((_task, options) => {
      const isSecond = options.user.includes('第二章');
      return extractPayload({
        entries: isSecond
          ? [
              extractEntry(characterCategory.name, '沈砚', { identity: '流亡贵族', goal: '查案' }, [
                '小舟',
              ]),
            ]
          : [extractEntry(characterCategory.name, '沈砚', { identity: '失忆剑客' })],
      });
    });

    await archiveChapter({ repository: repo, llm }, inputFor(ch1, { chapters: [ch1, ch2] }));
    await archiveChapter({ repository: repo, llm }, inputFor(ch2, { chapters: [ch1, ch2] }));

    const entryProposals = proposalsOf(await pendingProposals(), 'knowledgeEntry');
    expect(entryProposals).toHaveLength(1);
    const payload = entryProposals[0]!.payload as {
      title: string;
      fields: Record<string, string>;
      aliases: string[];
      sourceChapterIds: string[];
    };
    expect(payload.title).toBe('沈砚');
    expect(payload.fields).toMatchObject({ identity: '流亡贵族', goal: '查案' });
    expect(payload.aliases).toContain('小舟');
    expect(payload.sourceChapterIds).toEqual(expect.arrayContaining([ch1.id, ch2.id]));
    // 两章各一条摘要；同批只有一条进展
    const pending = await pendingProposals();
    expect(proposalsOf(pending, 'chapterSummary')).toHaveLength(2);
    expect(proposalsOf(pending, 'novel')).toHaveLength(1);
  });
});

describe('M2-S2 · 上限与人物豁免（design §6.3）', () => {
  it('普通条目每章 ≤3；人物新条目另有 3 条额度，两者互不挤占', async () => {
    const chapter = await makeChapter('群像章');
    const { llm } = fakeLlm(() =>
      extractPayload({
        entries: [
          ...Array.from({ length: 5 }, (_, index) =>
            extractEntry(worldCategory.name, `设定${index + 1}`, {
              definition: `定义${index + 1}`,
            }),
          ),
          ...Array.from({ length: 5 }, (_, index) =>
            extractEntry(characterCategory.name, `人物${index + 1}`, {
              identity: `身份${index + 1}`,
            }),
          ),
        ],
      }),
    );

    const result = await archiveChapter({ repository: repo, llm }, inputFor(chapter));
    const entryProposals = proposalsOf(await pendingProposals(), 'knowledgeEntry');
    const byTitle = new Map(
      entryProposals.map((proposal) => [
        (proposal.payload as { title: string }).title,
        proposal.payload as { categoryId: string },
      ]),
    );

    const worldTitles = [...byTitle.keys()].filter((title) => title.startsWith('设定'));
    const characterTitles = [...byTitle.keys()].filter((title) => title.startsWith('人物'));
    expect(worldTitles).toHaveLength(MAX_ENTRY_PROPOSALS_PER_CHAPTER);
    expect(characterTitles).toHaveLength(MAX_ENTRY_PROPOSALS_PER_CHAPTER);
    expect(
      entryProposals.map((proposal) => (proposal.payload as { categoryId: string }).categoryId),
    ).toEqual(expect.arrayContaining([worldCategory.id, characterCategory.id]));
    expect(result.entryCount).toBe(6);
  });
});

describe('M2-S2 · 两条调用路径与降级（design §6.1/6.2）', () => {
  it('extractEntries=false：走 chapter-summary，只出摘要与进展，不出条目', async () => {
    const chapter = await makeChapter('只摘要');
    const { llm, calls } = fakeLlm((task) => {
      expect(task).toBe('chapter-summary');
      return {
        summary: '摘要专用路径。',
        keyEvents: ['事件'],
        appearingEntries: [],
        newOpenThreads: [],
        resolvedThreads: [],
        rollingSummary: '摘要路径进展。',
      };
    });

    const result = await archiveChapter(
      { repository: repo, llm },
      inputFor(chapter, { extractEntries: false }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe('chapter-summary');
    expect(calls[0]!.options.failOnTruncation).toBe(true);
    // 摘要专用路径不经过条目门槛（task-27 契约 2）
    expect(calls[0]!.options.user).not.toContain('【归档额外要求】');
    expect(calls[0]!.options.user).not.toContain('龙套');
    expect(result.summaryCreated).toBe(true);
    expect(result.entryCount).toBe(0);
    expect(result.entriesDegraded).toBe(false);
    const pending = await pendingProposals();
    expect(proposalsOf(pending, 'chapterSummary')).toHaveLength(1);
    expect(proposalsOf(pending, 'novel')).toHaveLength(1);
    expect(proposalsOf(pending, 'knowledgeEntry')).toEqual([]);
  });

  it('条目提取被截断：降级为一次摘要专用调用，摘要链不断、条目标记降级', async () => {
    const chapter = await makeChapter('截断章');
    const { llm, calls } = fakeLlm((task) => {
      if (task === 'extract-settings') {
        throw new LlmError('truncated', '模型输出被截断');
      }
      return {
        summary: '降级后的摘要。',
        keyEvents: [],
        appearingEntries: [],
        newOpenThreads: [],
        resolvedThreads: [],
        rollingSummary: '降级后的进展。',
      };
    });

    const result = await archiveChapter({ repository: repo, llm }, inputFor(chapter));

    expect(calls.map((call) => call.task)).toEqual(['extract-settings', 'chapter-summary']);
    // task-27 契约 3：降级后的摘要调用不带条目门槛
    expect(calls[0]!.options.user).toContain('【归档额外要求】');
    expect(calls[1]!.options.user).not.toContain('【归档额外要求】');
    expect(result.entriesDegraded).toBe(true);
    expect(result.entryCount).toBe(0);
    expect(result.summaryCreated).toBe(true);
    const pending = await pendingProposals();
    expect(proposalsOf(pending, 'chapterSummary')).toHaveLength(1);
    expect(
      (proposalsOf(pending, 'chapterSummary')[0]!.payload as { summary: string }).summary,
    ).toBe('降级后的摘要。');
    expect(proposalsOf(pending, 'knowledgeEntry')).toEqual([]);
  });
});

describe('M2-S2 · 失败不写库与输入边界', () => {
  it('模型失败（非截断）：抛出且一条提案都不写、不创建批次', async () => {
    const chapter = await makeChapter('失败章');
    const { llm } = fakeLlm(() => {
      throw new LlmError('server', '模型服务暂时不可用');
    });

    await expect(archiveChapter({ repository: repo, llm }, inputFor(chapter))).rejects.toThrow(
      '模型服务暂时不可用',
    );
    expect(await pendingProposals()).toEqual([]);
    expect(readArchiveBatch(novel.id)).toBeNull();
  });

  it('正文为空：直接拒绝且不调用模型', async () => {
    const chapter = await makeChapter('空章', '');
    const { llm, calls } = fakeLlm(() => extractPayload());

    await expect(archiveChapter({ repository: repo, llm }, inputFor(chapter))).rejects.toThrow(
      /还没有正文/u,
    );
    expect(calls).toHaveLength(0);
    expect(await pendingProposals()).toEqual([]);
  });
});

describe('M2-S2 · supersedePendingChapterSummary', () => {
  it('只清本章 pending 摘要，别的章节/其他 target 不动', async () => {
    const ch1 = await makeChapter('第一章');
    const ch2 = await makeChapter('第二章');
    const makeProposal = (chapterId: string) => ({
      id: crypto.randomUUID(),
      novelId: novel.id,
      batchId: null,
      order: 0,
      target: 'chapterSummary' as const,
      action: 'create' as const,
      origin: 'refine' as const,
      targetId: null,
      label: chapterId,
      payload: { chapterId, summary: 's', keyEvents: [], appearingEntryIds: [], openThreads: [] },
      diff: [],
      sourceRef: '',
      status: 'pending' as const,
      createdAt: 0,
      decidedAt: null,
    });
    await repo.createProposals([makeProposal(ch1.id), makeProposal(ch2.id)]);
    const removed = await supersedePendingChapterSummary(repo, novel.id, ch1.id);

    expect(removed).toBe(1);
    const pending = await repo.listProposals(novel.id, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect((pending[0]!.payload as { chapterId: string }).chapterId).toBe(ch2.id);
  });
});

describe('M2-S2 · 批次跨章复用与轮转（配合 S1）', () => {
  it('同批最多 5 章共用 batchId；第 6 章换新批', async () => {
    const chapters: Chapter[] = [];
    for (let index = 1; index <= 6; index += 1) {
      chapters.push(await makeChapter(`第${index}章`));
    }
    const batchIds: string[] = [];
    const { llm } = fakeLlm(() => extractPayload());
    for (const chapter of chapters) {
      const result = await archiveChapter(
        { repository: repo, llm },
        inputFor(chapter, { chapters }),
      );
      batchIds.push(result.batchId);
    }
    expect(new Set(batchIds.slice(0, 5)).size).toBe(1);
    expect(batchIds[5]).not.toBe(batchIds[0]);
    expect(readArchiveBatch(novel.id)?.chapterIds).toEqual([chapters[5]!.id]);
  });
});

describe('M2-S2 · 归档额外要求（task-27 龙套门槛）', () => {
  it('导出常量含门槛原文；extract 路径以「空行 + 常量」结尾追加', () => {
    expect(ARCHIVE_EXTRACT_EXTRA_REQUIREMENT).toContain('【归档额外要求】');
    expect(ARCHIVE_EXTRACT_EXTRA_REQUIREMENT).toContain('船夫');
    expect(ARCHIVE_EXTRACT_EXTRA_REQUIREMENT).toContain('茶博士');
    expect(ARCHIVE_EXTRACT_EXTRA_REQUIREMENT).toContain('龙套');
    expect(ARCHIVE_EXTRACT_EXTRA_REQUIREMENT).toContain('已有条目即使戏份少也按合并规则补全');
  });

  it('导入链路的 buildExtractUserPrompt 逐字节不出现归档门槛（两条链路要求相反）', () => {
    const chapter = {
      id: 'ch-x',
      index: 1,
      title: '测试章',
      content: '船夫把缆绳解开。',
    } as unknown as Chapter;
    const prompt = buildExtractUserPrompt({
      chapter,
      mentionedEntries: [],
      categories,
      otherEntryNames: [],
      openThreads: [],
      rollingSummary: '',
    });
    expect(prompt).toContain('【本章正文（第 1 章 测试章）】');
    expect(prompt).not.toContain('【归档额外要求】');
    expect(prompt).not.toContain('龙套');
    expect(prompt).not.toContain(ARCHIVE_EXTRACT_EXTRA_REQUIREMENT);
  });
});
