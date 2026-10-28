/**
 * M3-S3 独立验收：前沿续写 3–5 章（服务层）。
 *
 * 覆盖 task-49 要求：prompt 块顺序/上下文（大纲尾部/推进/最近摘要/伏笔/相关设定）；
 * schema 3–5 章与场景数；合成梗概含场清单/冲突/钩子/引用；提案 append 到末卷；失败不写。
 *
 * 独立于开发的 outlineContinue.test.ts：用真实 Dexie 仓储 + 假 LlmRunner 走完整服务路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, Novel, StyleProfile } from '@/domain/schema';
import type { LlmRunner, StructuredRunOptions } from '@/llm/useLlm';
import type { TaskKind } from '@/llm/taskProfiles';
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
} from '@/features/outline/outlineContinue';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';

let harness: TestHarness;
let novel: Novel;
let style: StyleProfile;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '续写之书', genre: '仙侠' });
  style = (await harness.repository.getStyleProfile(novel.id))!;
  novel = await harness.repository.updateNovel(novel.id, {
    rollingSummary: '故事至此：主角已到渡口。',
  });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- fixtures

function frontierChapter(index: number, overrides: Partial<FrontierChapter> = {}): FrontierChapter {
  return {
    title: `续章${index}`,
    synopsis: `第 ${index} 章梗概：谁要什么、遇到阻碍。`,
    targetWords: 3000,
    scenes: [`场景${index}-1`, `场景${index}-2`, `场景${index}-3`],
    conflict: `主冲突${index}`,
    hook: `章末钩子${index}`,
    usesEntries: ['沈砚'],
    resolvesThreads: ['旧簪来历'],
    plantsThreads: [`新伏笔${index}`],
    ...overrides,
  };
}

interface LlmFixture {
  llm: LlmRunner;
  calls: { task: TaskKind; options: StructuredRunOptions<unknown> }[];
}

function fakeLlm(
  handler: (task: TaskKind, options: StructuredRunOptions<unknown>) => unknown,
): LlmFixture {
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

async function makeChapter(title: string, index?: number): Promise<Chapter> {
  return harness.repository.createChapter(novel.id, {
    title,
    content: '正文。',
    ...(index === undefined ? {} : { index }),
  });
}

async function addSummary(chapter: Chapter, summary: string, openThreads: string[] = []) {
  return harness.repository.upsertSummary(novel.id, chapter.id, {
    summary,
    keyEvents: [`${chapter.title}的关键事件`],
    appearingEntryIds: [],
    openThreads,
  });
}

function baseInput(count = 3) {
  return {
    novel,
    style,
    outline: [],
    chapters: [] as Chapter[],
    summaries: [],
    entries: [],
    categories: [],
    count,
  };
}

// ---------------------------------------------------------------- schema

describe('M3-S3 · FrontierOutlineSchema 边界', () => {
  it('接受 3–5 章、每章 3–5 个场景', () => {
    for (let count = FRONTIER_CHAPTER_MIN; count <= FRONTIER_CHAPTER_MAX; count += 1) {
      const chapters = Array.from({ length: count }, (_, index) => frontierChapter(index + 1));
      expect(FrontierOutlineSchema.safeParse({ chapters }).success).toBe(true);
    }
    // 场景数边界 3 与 5
    expect(
      FrontierOutlineSchema.safeParse({
        chapters: [
          frontierChapter(1, { scenes: ['a', 'b', 'c'] }),
          frontierChapter(2, { scenes: ['a', 'b', 'c', 'd', 'e'] }),
          frontierChapter(3),
        ],
      }).success,
    ).toBe(true);
  });

  it('拒绝 2/6 章、2/6 个场景、空标题/空钩子', () => {
    expect(FrontierOutlineSchema.safeParse({ chapters: [] }).success).toBe(false);
    expect(
      FrontierOutlineSchema.safeParse({
        chapters: Array.from({ length: 2 }, (_, index) => frontierChapter(index + 1)),
      }).success,
    ).toBe(false);
    expect(
      FrontierOutlineSchema.safeParse({
        chapters: Array.from({ length: 6 }, (_, index) => frontierChapter(index + 1)),
      }).success,
    ).toBe(false);
    expect(
      FrontierOutlineSchema.safeParse({
        chapters: [
          frontierChapter(1, { scenes: ['a', 'b'] }),
          frontierChapter(2),
          frontierChapter(3),
        ],
      }).success,
    ).toBe(false);
    expect(
      FrontierOutlineSchema.safeParse({
        chapters: [
          frontierChapter(1, {
            scenes: ['a', 'b', 'c', 'd', 'e', 'f'] as unknown as string[],
          }),
          frontierChapter(2),
          frontierChapter(3),
        ],
      }).success,
    ).toBe(false);
    expect(
      FrontierOutlineSchema.safeParse({
        chapters: [frontierChapter(1, { title: '' }), frontierChapter(2), frontierChapter(3)],
      }).success,
    ).toBe(false);
    expect(
      FrontierOutlineSchema.safeParse({
        chapters: [frontierChapter(1, { hook: '' }), frontierChapter(2), frontierChapter(3)],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- 大纲尾部 / prompt / 合成

describe('M3-S3 · 大纲尾部与 prompt 块顺序', () => {
  it('buildOutlineTail：末卷 + 其下章节点；平铺时取最近 5 个顶层', () => {
    const nodes = [
      {
        id: 'v1',
        parentId: null,
        order: 0,
        title: '第一卷',
        synopsis: '',
        targetWords: null,
        status: 'done',
        novelId: 'n',
        createdAt: 1,
      },
      {
        id: 'c1',
        parentId: 'v1',
        order: 0,
        title: '第1章',
        synopsis: '一',
        targetWords: 3000,
        status: 'done',
        novelId: 'n',
        createdAt: 2,
      },
      {
        id: 'c2',
        parentId: 'v1',
        order: 1,
        title: '第2章',
        synopsis: '二',
        targetWords: null,
        status: 'planned',
        novelId: 'n',
        createdAt: 3,
      },
      {
        id: 'v2',
        parentId: null,
        order: 1,
        title: '第二卷',
        synopsis: '卷概',
        targetWords: null,
        status: 'planned',
        novelId: 'n',
        createdAt: 4,
      },
      {
        id: 'c3',
        parentId: 'v2',
        order: 0,
        title: '第3章',
        synopsis: '三',
        targetWords: 5000,
        status: 'planned',
        novelId: 'n',
        createdAt: 5,
      },
    ] as unknown as Parameters<typeof buildOutlineTail>[0];
    const tail = buildOutlineTail(nodes);
    expect(tail.map((entry) => entry.title)).toEqual(['第二卷', '第3章']);
    expect(tail.map((entry) => entry.depth)).toEqual([0, 1]);
    expect(tail[1]!.targetWords).toBe(5000);

    const flatRoots = Array.from({ length: 7 }, (_, index) => ({
      id: `r${index}`,
      parentId: null,
      order: index,
      title: `顶层${index}`,
      synopsis: '',
      targetWords: null,
      status: 'planned',
      novelId: 'n',
      createdAt: index + 10,
    }));
    const flatTail = buildOutlineTail(
      flatRoots as unknown as Parameters<typeof buildOutlineTail>[0],
    );
    expect(flatTail).toHaveLength(5);
    expect(flatTail.map((entry) => entry.title)).toEqual([
      '顶层2',
      '顶层3',
      '顶层4',
      '顶层5',
      '顶层6',
    ]);

    expect(buildOutlineTail([])).toEqual([]);
  });

  it('user prompt 块顺序固定；空块省略；count 写入要求', () => {
    const prompt = buildOutlineContinueUserPrompt({
      outlineTail: [
        { title: '第二卷', synopsis: '卷概', targetWords: null, depth: 0 },
        { title: '第3章', synopsis: '章概', targetWords: 5000, depth: 1 },
      ],
      rollingSummary: '故事至此。',
      recentSummaries: [{ label: '第2章', summary: '最近摘要。', keyEvents: ['事件A'] }],
      openThreads: ['旧簪来历', '青冥宗'],
      relatedBlocks: [],
      count: 4,
    });
    const markers = [
      '【当前大纲尾部】',
      '【故事至此】',
      '【最近章节要点】',
      '【未收束伏笔】',
      '【本次要求】',
    ];
    const positions = markers.map((marker) => prompt.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).toContain('续写 4 章');
    expect(prompt).toContain('关键事件：事件A');
    expect(prompt).toContain('旧簪来历');

    const minimal = buildOutlineContinueUserPrompt({
      outlineTail: [],
      rollingSummary: '',
      recentSummaries: [],
      openThreads: [],
      relatedBlocks: [],
      count: 3,
    });
    expect(minimal).toBe('【本次要求】\n续写 3 章。');
  });

  it('system prompt 含三条红线/场景要求与核心设定；不传 norms/core 也稳定', () => {
    const system = buildOutlineContinueSystemPrompt(novel, style, undefined, [
      {
        entry: { title: '渡口的规矩' } as never,
        reason: 'core',
        text: '渡口只认官凭。',
        tokens: 20,
      },
    ]);
    expect(system).toContain('只做规划，不要写正文');
    expect(system).toContain('不替作者决定人物的生死、感情归宿与最终凶手');
    expect(system).toContain('不引入超过 2 个新实体');
    expect(system).toContain('每章给出 3–5 个场景清单');
    expect(system).toContain('【必须遵守的核心设定】');
    expect(system).toContain('渡口只认官凭。');
    // 同书同输入稳定（可缓存前缀）
    expect(buildOutlineContinueSystemPrompt(novel, style, undefined, [])).toBe(
      buildOutlineContinueSystemPrompt(novel, style, undefined, []),
    );
  });

  it('composeFrontierSynopsis：场清单/主冲突/章末钩子/引用/回收/新埋；空列表整段省略', () => {
    const full = composeFrontierSynopsis(frontierChapter(1));
    expect(full).toContain('场清单：');
    expect(full).toContain('- 场景1-1');
    expect(full).toContain('主冲突：主冲突1');
    expect(full).toContain('章末钩子：章末钩子1');
    expect(full).toContain('引用设定：沈砚');
    expect(full).toContain('回收伏笔：旧簪来历');
    expect(full).toContain('新埋伏笔：新伏笔1');

    const minimal = composeFrontierSynopsis(
      frontierChapter(1, {
        synopsis: '只有梗概。',
        usesEntries: [],
        resolvesThreads: [],
        plantsThreads: [],
      }),
    );
    expect(minimal).toContain('只有梗概。');
    expect(minimal).not.toContain('引用设定：');
    expect(minimal).not.toContain('回收伏笔：');
    expect(minimal).not.toContain('新埋伏笔：');
  });
});

// ---------------------------------------------------------------- 服务

describe('M3-S3 · runOutlineContinue 服务路径', () => {
  async function seedOutlineAndChapters() {
    const volume = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口被拦。',
    });
    const chapterNode = await harness.repository.createOutlineNode(novel.id, {
      title: '第3章 夜渡',
      synopsis: '夜渡北上。',
      parentId: volume.id,
      targetWords: 3000,
    });
    const chapters: Chapter[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const chapter = await makeChapter(`第${index}章`, index);
      await addSummary(
        chapter,
        `第${index}章摘要：沈砚继续赶路。`,
        index === 4 ? ['旧簪来历', '青冥宗余党'] : [],
      );
      chapters.push(chapter);
    }
    await harness.repository.updateChapter(chapters[3]!.id, { outlineNodeId: chapterNode.id });
    const pinned = await harness.repository.createEntry(novel.id, {
      categoryId: (await harness.repository.listCategories(novel.id)).find(
        (category) => category.kind === 'worldbuilding',
      )!.id,
      title: '渡口的规矩',
      pinned: true,
      summary: '渡口只认官凭。',
    });
    const mentioned = await harness.repository.createEntry(novel.id, {
      categoryId: (await harness.repository.listCategories(novel.id)).find(
        (category) => category.kind === 'character',
      )!.id,
      title: '沈砚',
      summary: '失忆剑客。',
    });
    return { volume, chapterNode, chapters, pinned, mentioned };
  }

  it('参数校验：章数 3–5；无章节且无大纲直接拒绝', async () => {
    const { llm, calls } = fakeLlm(() => ({ chapters: [] }));
    await expect(
      runOutlineContinue({ repository: harness.repository, llm }, baseInput(2)),
    ).rejects.toThrow(/3–5/u);
    await expect(
      runOutlineContinue({ repository: harness.repository, llm }, baseInput(6)),
    ).rejects.toThrow(/3–5/u);
    await expect(
      runOutlineContinue({ repository: harness.repository, llm }, baseInput(3)),
    ).rejects.toThrow(/无法续写/u);
    expect(calls).toHaveLength(0);
  });

  it('成功：一次 outline-continue 调用；上下文/块顺序/提案 append 到末卷', async () => {
    const { volume } = await seedOutlineAndChapters();
    const chapters = await harness.repository.listChapters(novel.id);
    const outline = await harness.repository.listOutline(novel.id);
    const summaries = await harness.repository.listSummaries(novel.id);
    const entries = await harness.repository.listEntries(novel.id);
    const categories = await harness.repository.listCategories(novel.id);
    const payload = {
      chapters: [frontierChapter(1), frontierChapter(2), frontierChapter(3)],
    };
    const { llm, calls } = fakeLlm(() => payload);

    const result = await runOutlineContinue(
      { repository: harness.repository, llm },
      {
        ...baseInput(3),
        outline,
        chapters,
        summaries,
        entries,
        categories,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe('outline-continue');
    expect(calls[0]!.options.failOnTruncation).toBe(true);
    expect(calls[0]!.options.schemaName).toBe('FrontierOutline');
    const system = calls[0]!.options.system;
    const user = calls[0]!.options.user;
    // 核心设定（pinned）在 system；相关设定（名称命中）在 user
    expect(system).toContain('渡口的规矩');
    expect(user).toContain('沈砚');
    // 块顺序：大纲尾部 → 故事至此 → 最近章节要点 → 未收束伏笔 → 相关设定 → 本次要求
    const markers = [
      '【当前大纲尾部】',
      '【故事至此】',
      '【最近章节要点】',
      '【未收束伏笔】',
      '【相关设定】',
      '【本次要求】',
    ];
    const positions = markers.map((marker) => user.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(user).toContain('续写 3 章');
    expect(user).toContain('第一卷 渡口');
    expect(user).toContain('青冥宗余党');
    // 最近摘要只取最后 3 章（第 2/3/4 章）
    expect(user).not.toContain('第1章摘要');
    expect(user).toContain('第2章摘要');
    expect(user).toContain('第4章摘要');

    // 返回：提案 pending、target outlineTree、append 到末卷（最后一个顶层节点）
    expect(result.parentId).toBe(volume.id);
    expect(result.parentTitle).toBe('第一卷 渡口');
    expect(result.chapters).toHaveLength(3);
    expect(result.chapters[0]!.synopsis).toContain('场清单：');
    expect(result.outlineText).toContain('续章1');
    expect(result.promptTokens).toBeGreaterThan(0);

    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      target: 'outlineTree',
      action: 'create',
      status: 'pending',
    });
    expect((pending[0]!.payload as { parentId: string }).parentId).toBe(volume.id);
    expect((pending[0]!.payload as { outlineText: string }).outlineText).toContain('主冲突：');
    expect((pending[0]!.payload as { outlineText: string }).outlineText).toContain('章末钩子：');

    // 只产提案，不改已有章节/大纲/设定
    const chaptersAfter = await harness.repository.listChapters(novel.id);
    expect(chaptersAfter.map((chapter) => chapter.id)).toEqual(
      chapters.map((chapter) => chapter.id),
    );
    expect(chaptersAfter.map((chapter) => chapter.outlineNodeId)).toEqual(
      chapters.map((chapter) => chapter.outlineNodeId),
    );
    expect(await harness.repository.listOutline(novel.id)).toHaveLength(outline.length);
    expect(await harness.repository.listEntries(novel.id)).toHaveLength(entries.length);
  });

  it('无大纲（仅章节）时 append 顶层；最近摘要不足 3 章也正常', async () => {
    const chapter = await makeChapter('唯一章', 1);
    await addSummary(chapter, '唯一章摘要。');
    const { llm } = fakeLlm(() => payloadOf3());
    const result = await runOutlineContinue(
      { repository: harness.repository, llm },
      {
        ...baseInput(3),
        chapters: [chapter],
        summaries: await harness.repository.listSummaries(novel.id),
        entries: [],
        categories: await harness.repository.listCategories(novel.id),
      },
    );
    expect(result.parentId).toBeNull();
    expect(result.parentTitle).toBeNull();
    expect((result.proposal.payload as { parentId?: string }).parentId).toBeUndefined();
  });

  it('模型失败：抛出且不写任何提案', async () => {
    const chapter = await makeChapter('第一章', 1);
    await addSummary(chapter, '摘要。');
    const { llm } = fakeLlm(() => {
      throw new Error('模型返回被截断');
    });

    await expect(
      runOutlineContinue(
        { repository: harness.repository, llm },
        {
          ...baseInput(3),
          chapters: [chapter],
          summaries: await harness.repository.listSummaries(novel.id),
          categories: await harness.repository.listCategories(novel.id),
        },
      ),
    ).rejects.toThrow('模型返回被截断');
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toEqual([]);
  });
});

function payloadOf3() {
  return { chapters: [frontierChapter(1), frontierChapter(2), frontierChapter(3)] };
}

describe('M3-S3 · resolveContinueParent', () => {
  it('最后一个顶层节点有子节点 → 作为 parent；否则 null', () => {
    const nodes = [
      { id: 'v1', parentId: null, order: 0, title: '第一卷', novelId: 'n', createdAt: 1 },
      { id: 'c1', parentId: 'v1', order: 0, title: '第1章', novelId: 'n', createdAt: 2 },
      { id: 'v2', parentId: null, order: 1, title: '第二卷', novelId: 'n', createdAt: 3 },
      { id: 'c2', parentId: 'v2', order: 0, title: '第2章', novelId: 'n', createdAt: 4 },
    ] as unknown as Parameters<typeof resolveContinueParent>[0];
    expect(resolveContinueParent(nodes)).toEqual({ parentId: 'v2', parentTitle: '第二卷' });

    const leafOnly = [
      { id: 'v1', parentId: null, order: 0, title: '第一卷', novelId: 'n', createdAt: 1 },
    ] as unknown as Parameters<typeof resolveContinueParent>[0];
    expect(resolveContinueParent(leafOnly)).toEqual({ parentId: null, parentTitle: null });
    expect(resolveContinueParent([])).toEqual({ parentId: null, parentTitle: null });
  });
});
