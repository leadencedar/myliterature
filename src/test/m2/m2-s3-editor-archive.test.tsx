/**
 * M2-S3 独立验收：标记完成后的后台归档 UI（design §3、§6.5/6.6/6.7）。
 *
 * 覆盖 task-23 要求：done 自动后台归档（不弹 Sheet、不阻塞）；状态行/查看 inbox/关闭不写；
 * autoArchive=false 不自动调用且可手动补摘要；未配置模型不调用；挂载恢复 pending 不重跑；
 * 失败重试；大纲节点完成提示点击才写；StrictMode 下只归档一次。
 *
 * 独立于开发的 ChapterEditor.test.tsx：夹具与断言按验收条目重写。
 */
import { StrictMode } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Category, Chapter, Novel, OutlineNode } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { useArchiveSettings } from '@/features/writing/archiveSettings';
import { useIncompleteDrafts } from '@/features/writing/incompleteDrafts';
import { WritingPage } from '@/features/writing/WritingPage';

let harness: TestHarness;
let novel: Novel;
let worldCategory: Category;
let characterCategory: Category;
let volume: OutlineNode;
let chapterNode: OutlineNode;
let chapter: Chapter;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  const categories = await harness.repository.listCategories(novel.id);
  worldCategory = categories.find((category) => category.kind === 'worldbuilding')!;
  characterCategory = categories.find((category) => category.kind === 'character')!;
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  useIncompleteDrafts.setState({ chapterIds: {} });
  useArchiveSettings.setState({ autoArchive: true, extractEntries: true });
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });

  volume = await harness.repository.createOutlineNode(novel.id, {
    title: '第一卷 风起',
    synopsis: '主角被追杀。',
  });
  chapterNode = await harness.repository.createOutlineNode(novel.id, {
    title: '第1章 雪夜',
    synopsis: '追兵临门，主角负伤。',
    parentId: volume.id,
    targetWords: 3000,
  });
  chapter = await harness.repository.createChapter(novel.id, {
    title: '雪夜',
    content: '雪夜里，追兵破门而入。林越提刀从后窗翻出去。',
    outlineNodeId: chapterNode.id,
  });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- mock

function archivePayload(entriesCount: number, resolvedThreads: string[] = []) {
  return {
    entries: Array.from({ length: entriesCount }, (_, index) => ({
      categoryName: characterCategory.name,
      title: `新角色${index + 1}`,
      aliases: [],
      summary: `新角色${index + 1}的摘要。`,
      fields: [{ key: 'identity', value: `身份${index + 1}` }],
    })),
    summary: '本章摘要：林越突围。',
    keyEvents: ['追兵破门', '林越翻窗'],
    appearingEntries: [],
    newOpenThreads: ['追兵背后是谁'],
    resolvedThreads,
    rollingSummary: '林越从雪夜突围，追兵不退。',
  };
}

interface ApiStubOptions {
  entriesCount?: number;
  failFirstNonStream?: boolean;
  resolvedThreads?: string[];
}

function stubApi(options: ApiStubOptions = {}) {
  const nonStreamBodies: Record<string, unknown>[] = [];
  let nonStreamCalls = 0;
  const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (body.stream === true) {
      throw new Error('测试未预期流式请求');
    }
    nonStreamBodies.push(body);
    nonStreamCalls += 1;
    if (options.failFirstNonStream && nonStreamCalls === 1) {
      return Promise.resolve(jsonResponse({ error: { message: '归档服务暂时不可用' } }, 500));
    }
    return Promise.resolve(
      jsonResponse(
        completion(
          JSON.stringify(archivePayload(options.entriesCount ?? 2, options.resolvedThreads)),
        ),
      ),
    );
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { fetchSpy, nonStreamBodies, getNonStreamCalls: () => nonStreamCalls };
}

// ---------------------------------------------------------------- helpers

async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
}

async function enterEditor(options: { strict?: boolean } = {}) {
  const user = userEvent.setup();
  harness.renderUI(
    options.strict ? (
      <StrictMode>
        <WritingPage />
      </StrictMode>
    ) : (
      <WritingPage />
    ),
    '/write',
  );
  await waitForLoaded();
  await user.click(await screen.findByRole('button', { name: '继续写第 1 章' }));
  await screen.findByLabelText('章节正文');
  return user;
}

/** 点状态按钮「草稿」→ 标为已完成 */
async function markDone(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '草稿' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '已完成' })).toBeInTheDocument());
}

const DONE_ROW = /本章摘要与设定已生成/u;

describe('M2-S3 · 标记完成触发后台归档（不弹 Sheet、不阻塞）', () => {
  it('状态行从运行到完成；不弹摘要面板；只发 1 次非流式请求；编辑不阻塞', async () => {
    const { getNonStreamCalls } = stubApi({ entriesCount: 2 });
    const user = await enterEditor();

    await markDone(user);

    expect(await screen.findByText(DONE_ROW)).toBeInTheDocument();
    // M2.1：摘要 create + 进展 replace + 2 条条目 create = 4 项（全部 pending 口径）
    expect(screen.getByText(/4 项待确认（含摘要、进展、条目）/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument();
    // 不自动弹任何 Sheet
    expect(screen.queryByRole('dialog', { name: '本章摘要' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '本章摘要与设定待确认' })).not.toBeInTheDocument();
    // 后台运行不阻塞编辑：仍能继续输入
    await user.type(screen.getByLabelText('章节正文'), '又补了一句。');
    await waitFor(() =>
      expect((screen.getByLabelText('章节正文') as HTMLTextAreaElement).value).toContain(
        '又补了一句',
      ),
    );
    expect(getNonStreamCalls()).toBe(1);
  });

  it('StrictMode 下标记完成只归档一次', async () => {
    const { getNonStreamCalls } = stubApi();
    const user = await enterEditor({ strict: true });
    await markDone(user);
    expect(await screen.findByText(DONE_ROW)).toBeInTheDocument();
    expect(getNonStreamCalls()).toBe(1);
  });
});

describe('M2-S3 · 查看 inbox：关闭不写、采用才落库', () => {
  it('关闭「本章档案待确认」不写任何东西，状态行保留', async () => {
    stubApi({ entriesCount: 2 });
    const user = await enterEditor();
    await markDone(user);
    await screen.findByText(DONE_ROW);

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    expect(within(dialog).getByRole('button', { name: /采用本批/u })).toBeInTheDocument();
    // M2.1 伏笔流水：新埋 1 / 收束 0 / 现存 1 + 误收束提示
    expect(within(dialog).getByText('本批伏笔流水')).toBeInTheDocument();
    // M3.1：无历史伏笔时「现存」与「新埋」完全重合，计数行注明、明细不重复
    expect(
      within(dialog).getByText(/第 1 章：新埋 1 \/ 收束 0 \/ 现存 1（现存均为本章新埋）/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('新埋：追兵背后是谁')).toBeInTheDocument();
    expect(within(dialog).queryByText(/现存：追兵背后是谁/u)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/若误收束，在摘要的「未收束伏笔」里加回/u)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: '本章摘要与设定待确认' }),
      ).not.toBeInTheDocument(),
    );

    // 未写库
    expect(await harness.repository.listSummaries(novel.id)).toEqual([]);
    expect(await harness.repository.listEntries(novel.id)).toEqual([]);
    expect((await harness.repository.getNovel(novel.id))!.rollingSummary).toBe('');
    // 状态行仍在，作者可以再打开
    expect(screen.getByText(DONE_ROW)).toBeInTheDocument();
  });

  it('默认「采用本批」：摘要/进展/新建条目写入，仅已有条目的合并默认不选', async () => {
    const existing = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '新角色1',
      summary: '旧摘要。',
      fields: { identity: '旧身份' },
    });
    stubApi({ entriesCount: 1 });
    const user = await enterEditor();
    await markDone(user);
    await screen.findByText(DONE_ROW);
    // 摘要 create + 进展 replace（默认仍选中）+ 条目 merge（默认忽略）= 3 项
    expect(screen.getByText(/3 项待确认（含摘要、进展、条目）/u)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    // M3.1 动态安全提示：初始 1 条跳过、将写入 2
    expect(
      within(dialog).getByText(
        '本批共 3 项，其中 1 条对已有条目的合并/替换默认不选；当前还有 1 条跳过（底部「采用本批」只计入将写入的 2 项）。',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByText('已标记为忽略')).toHaveLength(1);
    // 默认只采用 2 项：摘要 + 进展（条目 merge 被忽略）
    await user.click(within(dialog).getByRole('button', { name: /采用本批（2）/u }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: '本章摘要与设定待确认' }),
      ).not.toBeInTheDocument(),
    );

    const unchanged = (await harness.repository.listEntries(novel.id)).find(
      (entry) => entry.id === existing.id,
    )!;
    expect(unchanged.fields.identity).toBe('旧身份');
    expect(unchanged.summary).toBe('旧摘要。');
    // 进展 replace 默认选中，随本批写入
    expect((await harness.repository.getNovel(novel.id))!.rollingSummary).toBe(
      '林越从雪夜突围，追兵不退。',
    );
    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(pending.map((proposal) => proposal.action)).toEqual(['merge']);
  });

  it('有历史伏笔时流水仍显示新埋/收束/现存三类，不做去重', async () => {
    stubApi({ entriesCount: 0, resolvedThreads: ['河灯旧案'] });
    const user = await enterEditor();
    await markDone(user);
    await screen.findByText(DONE_ROW);

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    expect(within(dialog).getByText(/第 1 章：新埋 1 \/ 收束 1 \/ 现存 1/u)).toBeInTheDocument();
    expect(within(dialog).queryByText(/现存均为本章新埋/u)).not.toBeInTheDocument();
    expect(
      within(dialog).getByText('新埋：追兵背后是谁；收束：河灯旧案；现存：追兵背后是谁'),
    ).toBeInTheDocument();
  });

  it('恢复默认忽略的条目合并后随本批写入，旧条目被更新', async () => {
    const existing = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '新角色1',
      summary: '旧摘要。',
      fields: { identity: '旧身份' },
    });
    stubApi({ entriesCount: 1 });
    const user = await enterEditor();
    await markDone(user);
    await screen.findByText(DONE_ROW);

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    await user.click(within(dialog).getByRole('button', { name: '纳入本批' }));
    // 纳入后提示即时变为「已全部纳入」，按钮数只算将写入项
    expect(
      within(dialog).getByText(
        '本批共 3 项，其中 1 条对已有条目的合并/替换已全部纳入（将写入 3 项）。',
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /采用本批（3）/u }));

    await waitFor(async () => {
      const updated = (await harness.repository.listEntries(novel.id)).find(
        (entry) => entry.id === existing.id,
      )!;
      expect(updated.fields.identity).toBe('身份1');
    });
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(0);
  });
});

describe('M2-S3 · 设置/配置边界', () => {
  it('autoArchive=false：不调用模型，只提示可手动补摘要；补摘要手动打开', async () => {
    const { getNonStreamCalls } = stubApi();
    useArchiveSettings.setState({ autoArchive: false });
    const user = await enterEditor();
    await markDone(user);

    expect(await screen.findByText(/自动归档已关闭；可手动补摘要/u)).toBeInTheDocument();
    expect(getNonStreamCalls()).toBe(0);
    expect(screen.queryByRole('dialog', { name: '本章摘要' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '补摘要' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要' });
    expect(within(dialog).getByRole('button', { name: '提炼本章摘要' })).toBeInTheDocument();
  });

  it('未配置模型：不调用模型，提示去设置', async () => {
    const { getNonStreamCalls } = stubApi();
    useLlmSettings.getState().clearApiKey();
    const user = await enterEditor();
    await markDone(user);

    expect(await screen.findByText(/未配置模型，无法自动生成本章摘要与设定/u)).toBeInTheDocument();
    expect(getNonStreamCalls()).toBe(0);
  });

  it('归档失败显示原因；点「重试」成功后恢复完成态', async () => {
    const { getNonStreamCalls } = stubApi({ failFirstNonStream: true });
    const user = await enterEditor();
    await markDone(user);

    expect(await screen.findByText(/本章摘要与设定生成失败/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(getNonStreamCalls()).toBe(1);

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText(DONE_ROW)).toBeInTheDocument();
    expect(getNonStreamCalls()).toBe(2);
  });
});

describe('M2-S3 · 状态行计数不低估（M2.1）', () => {
  it('无条目变化时摘要 create + 进展 replace 也计 2 项（旧口径只报 0 条条目）', async () => {
    stubApi({ entriesCount: 0 });
    const user = await enterEditor();
    await markDone(user);

    expect(await screen.findByText(/2 项待确认（含摘要、进展、条目）/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument();
  });
});

describe('M2-S3 · 挂载恢复（不重跑）', () => {
  it('打开已有本章 pending 档案的已完成章节：显示待确认 + 查看，不发新请求', async () => {
    const { getNonStreamCalls } = stubApi();
    await harness.repository.updateChapter(chapter.id, { status: 'done' });
    const batchId = 'batch-restore';
    await harness.repository.createProposals([
      {
        id: crypto.randomUUID(),
        novelId: novel.id,
        batchId,
        order: 0,
        origin: 'refine',
        target: 'chapterSummary',
        action: 'create',
        targetId: null,
        label: '第 1 章摘要',
        payload: {
          chapterId: chapter.id,
          summary: '已有 pending 摘要。',
          keyEvents: [],
          appearingEntryIds: [],
          openThreads: [],
        },
        diff: [],
        sourceRef: '第 1 章',
        status: 'pending',
        createdAt: 0,
        decidedAt: null,
      },
      {
        id: crypto.randomUUID(),
        novelId: novel.id,
        batchId,
        order: 1,
        origin: 'refine',
        target: 'knowledgeEntry',
        action: 'create',
        targetId: null,
        label: '人物 · 新角色',
        payload: {
          categoryId: characterCategory.id,
          title: '新角色',
          aliases: [],
          summary: 's',
          fields: {},
          sourceChapterIds: [chapter.id],
        },
        diff: [],
        sourceRef: '第 1 章',
        status: 'pending',
        createdAt: 0,
        decidedAt: null,
      },
    ]);

    const user = await enterEditor();
    expect(await screen.findByText(DONE_ROW)).toBeInTheDocument();
    // 本批全部 pending：摘要 + 1 条条目 = 2 项
    expect(screen.getByText(/2 项待确认（含摘要、进展、条目）/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    // 没有审计记录（旧批/清缓存）时只提示一行，不阻塞
    expect(within(dialog).getByText('本批没有伏笔流水记录。')).toBeInTheDocument();
    expect(getNonStreamCalls()).toBe(0); // 只读恢复，不重跑
  });
});

describe('M2-S3 · 大纲节点完成提示（点击才写）', () => {
  it('同节点章节全部完成且节点未完成时提示；点击后才写节点状态', async () => {
    stubApi();
    const user = await enterEditor();
    await markDone(user);
    await screen.findByText(DONE_ROW);

    // 提示的是章节所挂的节点（章节点「第1章 雪夜」），不是它的父卷
    const prompt = await screen.findByText(/大纲节点「第1章 雪夜」可以标为完成/u);
    expect(prompt).toBeInTheDocument();
    // 未点之前节点状态未变
    expect(
      (await harness.repository.listOutline(novel.id)).find((node) => node.id === chapterNode.id)!
        .status,
    ).toBe('planned');

    await user.click(screen.getByRole('button', { name: '标记完成' }));
    await waitFor(async () => {
      const node = (await harness.repository.listOutline(novel.id)).find(
        (item) => item.id === chapterNode.id,
      )!;
      expect(node.status).toBe('done');
    });
    await waitFor(() =>
      expect(screen.queryByText(/大纲节点「第1章 雪夜」可以标为完成/u)).not.toBeInTheDocument(),
    );
    // 父卷不受影响
    expect(
      (await harness.repository.listOutline(novel.id)).find((node) => node.id === volume.id)!
        .status,
    ).toBe('planned');
  });
});

describe('M2-S3 · 大纲完成提示「知道了」隐藏（task-28）', () => {
  it('点「知道了」隐藏提示，节点状态保持未完成（不写库）', async () => {
    stubApi();
    const user = await enterEditor();
    await markDone(user);
    await screen.findByText(DONE_ROW);

    const prompt = await screen.findByText(/大纲节点「第1章 雪夜」可以标为完成/u);
    expect(prompt).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '知道了' }));

    expect(screen.queryByText(/大纲节点「第1章 雪夜」可以标为完成/u)).not.toBeInTheDocument();
    // 「知道了」只是本次会话隐藏，不写任何状态
    expect(
      (await harness.repository.listOutline(novel.id)).find((node) => node.id === chapterNode.id)!
        .status,
    ).toBe('planned');
  });
});

describe('M2-S3 · 汇总引用（防止未使用变量告警）', () => {
  it('夹具就绪：世界分类、章节节点存在', () => {
    expect(worldCategory.kind).toBe('worldbuilding');
    expect(chapterNode.parentId).toBe(volume.id);
    expect(chapter.outlineNodeId).toBe(chapterNode.id);
  });
});
