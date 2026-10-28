import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanningEntryBlock } from '@/context/planningContext';
import type { Category, KnowledgeEntry, Novel, OutlineNode, StyleProfile } from '@/domain/schema';
import { LlmError } from '@/llm/errors';
import type { LlmRunner } from '@/llm/useLlm';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import {
  FRONTIER_CHAPTER_MAX,
  FRONTIER_CHAPTER_MIN,
  FrontierOutlineSchema,
  buildOutlineContinueSystemPrompt,
  buildOutlineContinueUserPrompt,
  buildOutlineTail,
  composeFrontierSynopsis,
  resolveContinueParent,
  runOutlineContinue,
  type FrontierChapter,
  type FrontierOutlineResult,
  type OutlineContinueInput,
  type OutlineTailEntry,
  type RecentChapterPoint,
} from './outlineContinue';

let harness: TestHarness;
let novel: Novel;
let style: StyleProfile;
let categories: Category[];
let entries: KnowledgeEntry[];
let volume: OutlineNode;
let chapterNode: OutlineNode;

function fakeLlm(
  handler: (task: string, options: Record<string, unknown>) => Promise<{ data: unknown }>,
): { llm: LlmRunner; calls: { task: string; options: Record<string, unknown> }[] } {
  const calls: { task: string; options: Record<string, unknown> }[] = [];
  const llm = {
    configured: true,
    runStructured: async (task: string, options: Record<string, unknown>) => {
      calls.push({ task, options });
      const { data } = await handler(task, options);
      return { data, attempts: 1 };
    },
  } as unknown as LlmRunner;
  return { llm, calls };
}

function frontierResult(count = 3): FrontierOutlineResult {
  return {
    chapters: Array.from({ length: count }, (_, index) => ({
      title: `第${index + 2}章 追踪${index + 1}`,
      synopsis: `主角追查线索的第 ${index + 1} 步。`,
      targetWords: 3000,
      scenes: ['抵达旧宅', '与守门人周旋', '发现密信'],
      conflict: '线索指向自己人',
      hook: `门外传来第 ${index + 1} 次敲门声`,
      usesEntries: ['林越'],
      resolvesThreads: index === 0 ? ['刀的来历'] : [],
      plantsThreads: [`密信第 ${index + 1} 页`],
    })),
  };
}

function frontierChapter(overrides: Partial<FrontierChapter> = {}): FrontierChapter {
  return {
    title: '第2章 追踪',
    synopsis: '主角追查线索。',
    targetWords: 3000,
    scenes: ['抵达旧宅', '与守门人周旋', '发现密信'],
    conflict: '线索指向自己人',
    hook: '门外传来敲门声',
    usesEntries: ['林越'],
    resolvesThreads: ['刀的来历'],
    plantsThreads: ['密信'],
    ...overrides,
  };
}

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  await harness.repository.updateNovel(novel.id, { rollingSummary: '林越已北上追查旧案。' });
  style = (await harness.repository.getStyleProfile(novel.id))!;
  categories = await harness.repository.listCategories(novel.id);
  const character = categories.find((category) => category.kind === 'character')!;
  await harness.repository.createEntry(novel.id, {
    categoryId: character.id,
    title: '灵气',
    summary: '天地能量',
    pinned: true,
  });
  await harness.repository.createEntry(novel.id, {
    categoryId: character.id,
    title: '林越',
    summary: '失忆剑客',
  });

  for (let index = 1; index <= 5; index += 1) {
    const chapter = await harness.repository.createChapter(novel.id, {
      title: `第${index}章 事件${index}`,
      content: `第 ${index} 章正文。`,
    });
    await harness.repository.upsertSummary(novel.id, chapter.id, {
      summary: `第 ${index} 章的摘要。`,
      keyEvents: [`事件${index}`],
      openThreads: index === 5 ? ['刀的来历', '守门人的身份'] : [],
    });
  }

  volume = await harness.repository.createOutlineNode(novel.id, {
    title: '第一卷 风起',
    synopsis: '林越被追杀，逃向北方。',
    targetWords: 30000,
  });
  chapterNode = await harness.repository.createOutlineNode(novel.id, {
    title: '第5章 雪夜',
    synopsis: '追兵临门。',
    parentId: volume.id,
    targetWords: 3000,
  });
  entries = await harness.repository.listEntries(novel.id);
});

afterEach(async () => {
  await harness.cleanup();
});

async function buildInput(
  overrides: Partial<OutlineContinueInput> = {},
): Promise<OutlineContinueInput> {
  return {
    novel: (await harness.repository.getNovel(novel.id))!,
    style: (await harness.repository.getStyleProfile(novel.id))!,
    outline: await harness.repository.listOutline(novel.id),
    chapters: await harness.repository.listChapters(novel.id),
    summaries: await harness.repository.listSummaries(novel.id),
    entries: await harness.repository.listEntries(novel.id),
    categories: await harness.repository.listCategories(novel.id),
    count: 3,
    ...overrides,
  };
}

async function pendingProposals() {
  return harness.repository.listProposals(novel.id, { status: 'pending' });
}

function payloadOf(proposal: { payload: unknown }): Record<string, unknown> {
  return proposal.payload as Record<string, unknown>;
}

describe('FrontierOutlineSchema', () => {
  it('3–5 章、每章 3–5 个场景合法', () => {
    expect(FrontierOutlineSchema.safeParse(frontierResult(FRONTIER_CHAPTER_MIN)).success).toBe(
      true,
    );
    expect(FrontierOutlineSchema.safeParse(frontierResult(FRONTIER_CHAPTER_MAX)).success).toBe(
      true,
    );
    const nullWords = frontierResult(3);
    nullWords.chapters[0]!.targetWords = null;
    expect(FrontierOutlineSchema.safeParse(nullWords).success).toBe(true);
  });

  it('章数与场景数越界被拒绝', () => {
    expect(FrontierOutlineSchema.safeParse(frontierResult(2)).success).toBe(false);
    expect(FrontierOutlineSchema.safeParse(frontierResult(6)).success).toBe(false);

    const tooFewScenes = frontierResult(3);
    tooFewScenes.chapters[0]!.scenes = ['只有一个场景'];
    expect(FrontierOutlineSchema.safeParse(tooFewScenes).success).toBe(false);

    const tooManyScenes = frontierResult(3);
    tooManyScenes.chapters[0]!.scenes = ['一', '二', '三', '四', '五', '六'];
    expect(FrontierOutlineSchema.safeParse(tooManyScenes).success).toBe(false);
  });

  it('必填字段缺失被拒绝', () => {
    const broken = frontierResult(3);
    // 缺章末钩子
    const chapter = { ...broken.chapters[0]! } as Record<string, unknown>;
    delete chapter.hook;
    broken.chapters[0] = chapter as unknown as FrontierChapter;
    expect(FrontierOutlineSchema.safeParse(broken).success).toBe(false);
  });
});

describe('提示词', () => {
  it('system 带角色/风格/核心设定/任务约束', () => {
    const core: PlanningEntryBlock[] = [
      {
        entry: entries.find((entry) => entry.pinned)!,
        reason: 'core',
        tokens: 12,
        text: '## 灵气（人物）\n天地能量',
      },
    ];

    const system = buildOutlineContinueSystemPrompt(novel, style, undefined, core);

    expect(system).toContain('你是一位资深的小说策划编辑');
    expect(system).toContain('归墟纪');
    expect(system).toContain('【必须遵守的核心设定】');
    expect(system).toContain('天地能量');
    expect(system).toContain('只做规划，不要写正文');
    expect(system).toContain('不替作者决定人物的生死、感情归宿与最终凶手');
    expect(system).toContain('不引入超过 2 个新实体');
  });

  it('user 块顺序固定：大纲尾部 → 故事至此 → 最近章节 → 伏笔 → 相关设定 → 本次要求', () => {
    const outlineTail: OutlineTailEntry[] = [
      { title: '第一卷 风起', synopsis: '林越被追杀。', targetWords: 30000, depth: 0 },
      { title: '第5章 雪夜', synopsis: '追兵临门。', targetWords: 3000, depth: 1 },
    ];
    const recentSummaries: RecentChapterPoint[] = [
      { label: '第4章 旧识', summary: '林越遇见故人。', keyEvents: ['遇见故人'] },
    ];
    const relatedBlocks: PlanningEntryBlock[] = [
      {
        entry: entries.find((entry) => entry.title === '林越')!,
        reason: 'mentioned',
        matchedName: '林越',
        score: 10,
        tokens: 12,
        text: '## 林越（人物）\n失忆剑客',
      },
    ];

    const prompt = buildOutlineContinueUserPrompt({
      outlineTail,
      rollingSummary: '林越已北上。',
      recentSummaries,
      openThreads: ['刀的来历'],
      relatedBlocks,
      count: 4,
    });

    const order = [
      '【当前大纲尾部】',
      '【故事至此】',
      '【最近章节要点】',
      '【未收束伏笔】',
      '【相关设定】',
      '【本次要求】',
    ].map((heading) => prompt.indexOf(heading));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(prompt).toContain('- 第一卷 风起（目标 30000 字）：林越被追杀。');
    expect(prompt).toContain('  - 第5章 雪夜（目标 3000 字）：追兵临门。');
    expect(prompt).toContain('第4章 旧识\n林越遇见故人。');
    expect(prompt).toContain('关键事件：遇见故人');
    expect(prompt).toContain('- 刀的来历');
    expect(prompt).toContain('续写 4 章。');
  });

  it('可选块为空时整块省略，只剩本次要求', () => {
    const prompt = buildOutlineContinueUserPrompt({
      outlineTail: [],
      rollingSummary: '   ',
      recentSummaries: [],
      openThreads: [],
      relatedBlocks: [],
      count: 3,
    });

    expect(prompt).toBe('【本次要求】\n续写 3 章。');
  });
});

describe('大纲尾部与追加位置', () => {
  it('有分卷时取末卷与其下章节节点', async () => {
    const outline = await harness.repository.listOutline(novel.id);

    const tail = buildOutlineTail(outline);

    expect(tail).toEqual([
      { title: '第一卷 风起', synopsis: '林越被追杀，逃向北方。', targetWords: 30000, depth: 0 },
      { title: '第5章 雪夜', synopsis: '追兵临门。', targetWords: 3000, depth: 1 },
    ]);
    expect(resolveContinueParent(outline)).toEqual({
      parentId: volume.id,
      parentTitle: '第一卷 风起',
    });
  });

  it('没有分卷结构时取最近顶层节点，追加到顶层', async () => {
    const flat: OutlineNode = { ...chapterNode, parentId: null };

    const tail = buildOutlineTail([flat]);

    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ title: '第5章 雪夜', depth: 0 });
    expect(resolveContinueParent([flat])).toEqual({ parentId: null, parentTitle: null });
  });

  it('没有大纲时尾部为空、追加到顶层', () => {
    expect(buildOutlineTail([])).toEqual([]);
    expect(resolveContinueParent([])).toEqual({ parentId: null, parentTitle: null });
  });
});

describe('composeFrontierSynopsis', () => {
  it('把场清单/冲突/钩子/设定/伏笔合成为可读梗概', () => {
    const synopsis = composeFrontierSynopsis(frontierChapter());

    expect(synopsis).toContain('主角追查线索。');
    expect(synopsis).toContain('场清单：');
    expect(synopsis).toContain('- 抵达旧宅');
    expect(synopsis).toContain('主冲突：线索指向自己人');
    expect(synopsis).toContain('章末钩子：门外传来敲门声');
    expect(synopsis).toContain('引用设定：林越');
    expect(synopsis).toContain('回收伏笔：刀的来历');
    expect(synopsis).toContain('新埋伏笔：密信');
  });

  it('空列表字段整段不渲染', () => {
    const synopsis = composeFrontierSynopsis(
      frontierChapter({ usesEntries: [], resolvesThreads: [], plantsThreads: [] }),
    );

    expect(synopsis).toContain('场清单：');
    expect(synopsis).not.toContain('引用设定');
    expect(synopsis).not.toContain('回收伏笔');
    expect(synopsis).not.toContain('新埋伏笔');
  });
});

describe('runOutlineContinue', () => {
  it('一次 outline-continue 调用，产出草稿+注入清单+outlineTree 提案', async () => {
    const { llm, calls } = fakeLlm(async () => ({ data: frontierResult(3) }));

    const result = await runOutlineContinue(
      { repository: harness.repository, llm },
      await buildInput(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe('outline-continue');
    expect(calls[0]!.options.schemaName).toBe('FrontierOutline');
    expect(calls[0]!.options.failOnTruncation).toBe(true);
    const system = String(calls[0]!.options.system);
    const user = String(calls[0]!.options.user);
    expect(system).toContain('【必须遵守的核心设定】');
    expect(system).toContain('天地能量');
    expect(user).toContain('【当前大纲尾部】');
    expect(user).toContain('【故事至此】\n林越已北上追查旧案。');
    expect(user).toContain('【最近章节要点】');
    expect(user).toContain('【未收束伏笔】');
    expect(user).toContain('- 刀的来历');
    expect(user).toContain('【相关设定】');
    expect(user).toContain('续写 3 章。');

    expect(result.chapters).toHaveLength(3);
    expect(result.chapters[0]!.synopsis).toContain('场清单：');
    expect(result.chapters[0]!.synopsis).toContain('章末钩子：门外传来第 1 次敲门声');
    expect(result.outlineText).toContain('# 第2章 追踪1（约 3000 字）');
    expect(result.outlineText).toContain('主冲突：线索指向自己人');
    expect(result.parentId).toBe(volume.id);
    expect(result.parentTitle).toBe('第一卷 风起');
    expect(result.promptTokens).toBeGreaterThan(0);

    // 注入清单：pinned 进 core，名称命中的林越进 related，最近 3 章与累计伏笔带出
    expect(result.injection.core.map((block) => block.entry.title)).toEqual(['灵气']);
    expect(result.injection.related.map((block) => block.entry.title)).toContain('林越');
    expect(result.injection.recentSummaries.map((point) => point.label)).toEqual([
      '第3章 事件3',
      '第4章 事件4',
      '第5章 事件5',
    ]);
    expect(result.injection.openThreads).toEqual(['刀的来历', '守门人的身份']);
    expect(result.injection.outlineTail).toContain('第一卷 风起');

    // 已作为一条 pending outlineTree 提案落库，追加到末卷
    const pending = await pendingProposals();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      target: 'outlineTree',
      action: 'create',
      batchId: result.batchId,
      order: 0,
    });
    expect(payloadOf(pending[0]!)).toEqual({
      outlineText: result.outlineText,
      parentId: volume.id,
    });
  });

  it('没有分卷时提案追加到顶层（payload 不带 parentId）', async () => {
    const { llm } = fakeLlm(async () => ({ data: frontierResult(3) }));

    const result = await runOutlineContinue(
      { repository: harness.repository, llm },
      await buildInput({ outline: [{ ...chapterNode, parentId: null }] }),
    );

    expect(result.parentId).toBeNull();
    const pending = await pendingProposals();
    expect(payloadOf(pending[0]!)).toEqual({ outlineText: result.outlineText });
    expect(payloadOf(pending[0]!)).not.toHaveProperty('parentId');
  });

  it('章数非法时直接拒绝，不调用模型', async () => {
    const { llm, calls } = fakeLlm(async () => ({ data: frontierResult(3) }));

    await expect(
      runOutlineContinue({ repository: harness.repository, llm }, await buildInput({ count: 2 })),
    ).rejects.toThrow('续写章数需在 3–5 之间');
    await expect(
      runOutlineContinue({ repository: harness.repository, llm }, await buildInput({ count: 6 })),
    ).rejects.toThrow('续写章数需在 3–5 之间');
    expect(calls).toHaveLength(0);
  });

  it('没有章节也没有大纲时拒绝', async () => {
    const { llm, calls } = fakeLlm(async () => ({ data: frontierResult(3) }));

    await expect(
      runOutlineContinue(
        { repository: harness.repository, llm },
        await buildInput({ chapters: [], outline: [] }),
      ),
    ).rejects.toThrow('还没有已写章节或大纲');
    expect(calls).toHaveLength(0);
  });

  it('模型失败时抛错且不写提案', async () => {
    const { llm } = fakeLlm(async () => {
      throw new LlmError('truncated', '输出被截断');
    });

    await expect(
      runOutlineContinue({ repository: harness.repository, llm }, await buildInput()),
    ).rejects.toThrow('输出被截断');
    expect(await pendingProposals()).toHaveLength(0);
  });
});
