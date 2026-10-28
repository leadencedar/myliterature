/**
 * M3-S4 独立验收：前沿续写面板（入口 / 依据 / 生成 / 提案 / 采用 / 关闭 / 失败）。
 *
 * 独立于开发的 WritingPage.test.tsx：真 WritingPage + 真仓储，mock 只有网络层
 * （outline-continue 结构化响应），断言请求体块顺序、提案 append 位置与落库结果。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Category, Chapter, Novel } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { WritingPage } from '@/features/writing/WritingPage';

let harness: TestHarness;
let novel: Novel;
let categories: Category[];
let volumeId: string;
let chapterNodeId: string;
let chapter: Chapter;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '续写之书', genre: '仙侠' });
  categories = await harness.repository.listCategories(novel.id);
  useActiveNovel.setState({ activeNovelId: novel.id });
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });

  const volume = await harness.repository.createOutlineNode(novel.id, {
    title: '第一卷 渡口',
    synopsis: '沈砚在渡口被迫上船。',
  });
  volumeId = volume.id;
  const chapterNode = await harness.repository.createOutlineNode(novel.id, {
    title: '第1章 夜渡',
    synopsis: '夜渡北上。',
    parentId: volume.id,
    targetWords: 3000,
  });
  chapterNodeId = chapterNode.id;
  chapter = await harness.repository.createChapter(novel.id, {
    title: '第1章 夜渡',
    content: '正文。',
    outlineNodeId: chapterNode.id,
  });
  await harness.repository.updateChapter(chapter.id, { status: 'done' });
  await harness.repository.upsertSummary(novel.id, chapter.id, {
    summary: '沈砚上船，裴照提到青冥宗。',
    keyEvents: ['上船'],
    appearingEntryIds: [],
    openThreads: ['旧簪来历'],
  });
  await harness.repository.updateNovel(novel.id, {
    rollingSummary: '故事至此：沈砚与裴照同船北上。',
  });
  const worldCategory = categories.find((category) => category.kind === 'worldbuilding')!;
  const characterCategory = categories.find((category) => category.kind === 'character')!;
  await harness.repository.createEntry(novel.id, {
    categoryId: worldCategory.id,
    title: '渡口的规矩',
    pinned: true,
    summary: '渡口只认官凭。',
  });
  await harness.repository.createEntry(novel.id, {
    categoryId: characterCategory.id,
    title: '沈砚',
    summary: '失忆剑客。',
  });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- mock

function frontierPayload(count = 3) {
  return {
    chapters: Array.from({ length: count }, (_, index) => ({
      title: `续章${index + 1}`,
      synopsis: `第 ${index + 1} 章梗概：谁要什么、遇到阻碍。`,
      targetWords: 3000,
      scenes: [`场景${index + 1}-1`, `场景${index + 1}-2`, `场景${index + 1}-3`],
      conflict: `主冲突${index + 1}`,
      hook: `章末钩子${index + 1}`,
      usesEntries: ['沈砚'],
      // 只在第一章回收，避免同一伏笔在细目里重复出现（也贴合真实模型「不一次收光」）
      resolvesThreads: index === 0 ? ['旧簪来历'] : [],
      plantsThreads: [`新伏笔${index + 1}`],
    })),
  };
}

function stubContinue(payload: unknown = frontierPayload(3)) {
  const bodies: Record<string, unknown>[] = [];
  const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    bodies.push(body);
    return Promise.resolve(jsonResponse(completion(JSON.stringify(payload))));
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { fetchSpy, bodies };
}

async function renderPage() {
  harness.renderUI(<WritingPage />, '/write');
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
}

async function openContinuePanel() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '规划后续 3–5 章大纲' }));
  const dialog = await screen.findByRole('dialog', { name: '规划后续 3–5 章大纲' });
  return { user, dialog };
}

// ---------------------------------------------------------------- tests

describe('M3-S4 · 入口与互斥', () => {
  it('已有大纲 → 显示续写入口、不显示回溯入口', async () => {
    await renderPage();
    expect(await screen.findByRole('button', { name: '规划后续 3–5 章大纲' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '按已有章节生成大纲' })).not.toBeInTheDocument();
    // M3.1：大纲区块说明三种规划入口的关系
    expect(
      screen.getByText(
        /三种规划入口：细化＝拆当前节点；自动大纲＝按已有章节补结构或往后规划；互动推演沉淀＝先把推演出来的线变成大纲。/u,
      ),
    ).toBeInTheDocument();
  });

  it('无大纲但有主线章节 → 显示回溯入口、不显示续写入口（互斥）', async () => {
    const plain = await harness.repository.createNovel({ title: '纯章节书' });
    useActiveNovel.setState({ activeNovelId: plain.id });
    await harness.repository.createChapter(plain.id, { title: '第一章', content: '正文。' });
    await renderPage();

    expect(await screen.findByRole('button', { name: '按已有章节生成大纲' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '规划后续 3–5 章大纲' })).not.toBeInTheDocument();
  });

  it('无章节无大纲 → 两个自动入口都不出现', async () => {
    const plain = await harness.repository.createNovel({ title: '空白书' });
    useActiveNovel.setState({ activeNovelId: plain.id });
    await renderPage();
    expect(screen.queryByRole('button', { name: '规划后续 3–5 章大纲' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '按已有章节生成大纲' })).not.toBeInTheDocument();
  });
});

describe('M3-S4 · 面板依据与章数', () => {
  it('打开面板：标题/本次依据/章数选项/生成按钮', async () => {
    await renderPage();
    const { dialog } = await openContinuePanel();

    expect(within(dialog).getByText('本次依据')).toBeInTheDocument();
    expect(within(dialog).getByText(/大纲尾部：第一卷 渡口 \/ 第1章 夜渡/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/故事至此：已带上全书进展摘要/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/最近章节：1 章摘要/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/未收束伏笔：1 条/u)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '3 章' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '4 章' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '5 章' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '规划 3 章大纲' })).toBeInTheDocument();
  });

  it('选择 4 章后按钮与请求都按 4 章；关闭面板不写库不发请求', async () => {
    const { fetchSpy } = stubContinue();
    await renderPage();
    const { user, dialog } = await openContinuePanel();
    await user.click(within(dialog).getByRole('button', { name: '4 章' }));
    expect(within(dialog).getByRole('button', { name: '规划 4 章大纲' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '规划后续 3–5 章大纲' })).not.toBeInTheDocument(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toEqual([]);
    expect(await harness.repository.listOutline(novel.id)).toHaveLength(2); // 只有原有卷+章
  });

  it('未配置模型：生成按钮禁用并提示去设置', async () => {
    useLlmSettings.getState().clearApiKey();
    await renderPage();
    const { dialog } = await openContinuePanel();
    expect(within(dialog).getByRole('button', { name: '规划 3 章大纲' })).toBeDisabled();
    expect(
      within(dialog).getByText('需要先在「设置」里配置模型，才能续写大纲。'),
    ).toBeInTheDocument();
  });
});

describe('M3-S4 · 生成 → 提案 → 采用', () => {
  it('生成：请求体块顺序正确、出提案；采用后 append 到末卷、已有数据不变', async () => {
    const { bodies } = stubContinue();
    const chaptersBefore = await harness.repository.listChapters(novel.id);
    const entriesBefore = await harness.repository.listEntries(novel.id);
    await renderPage();
    const { user, dialog } = await openContinuePanel();

    await user.click(within(dialog).getByRole('button', { name: '规划 3 章大纲' }));
    expect(await within(dialog).findByText('已生成提案，确认后写入大纲。')).toBeInTheDocument();
    // 请求体：强模型、结构化、块顺序、续写章数
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe('deepseek-v4-pro');
    expect(bodies[0]!.stream).not.toBe(true);
    const messages = bodies[0]!.messages as { role: string; content: string }[];
    const system = messages.find((message) => message.role === 'system')!.content;
    const userPrompt = messages.filter((message) => message.role === 'user').pop()!.content;
    expect(system).toContain('只做规划，不要写正文');
    expect(system).toContain('渡口的规矩'); // 核心设定进 system
    const markers = [
      '【当前大纲尾部】',
      '【故事至此】',
      '【最近章节要点】',
      '【未收束伏笔】',
      '【相关设定】',
      '【本次要求】',
    ];
    const positions = markers.map((marker) => userPrompt.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(userPrompt).toContain('续写 3 章');

    // 本次注入 + 提案
    expect(within(dialog).getByText('本次注入')).toBeInTheDocument();
    expect(within(dialog).getByText(/核心设定 1 条（始终注入）：渡口的规矩/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/相关设定 \d+ 条/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/提示词约 .* tokens/u)).toBeInTheDocument();
    // P1：提案上方「续写细目」四要素，让作者采用前逐章核对
    expect(within(dialog).getByText('续写细目')).toBeInTheDocument();
    expect(within(dialog).getByText('续章1')).toBeInTheDocument();
    expect(within(dialog).getByText('主冲突：主冲突1')).toBeInTheDocument();
    expect(within(dialog).getByText('章末钩子：章末钩子1')).toBeInTheDocument();
    expect(within(dialog).getByText('将收束：旧簪来历')).toBeInTheDocument();
    expect(within(dialog).getByText('将新埋：新伏笔1')).toBeInTheDocument();
    // ProposalInbox 的提案是异步加载的：等采用按钮出现再断言/点击，避免全量并发下的竞态
    const adoptButton = await within(dialog).findByRole('button', { name: '采用这份续写' });
    expect(adoptButton).toBeInTheDocument();
    // M3.1：续写提案只有 1 条 → 不再渲染逐条「采用这条」（避免两个采用入口）
    expect(within(dialog).queryByRole('button', { name: '采用这条' })).not.toBeInTheDocument();
    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ target: 'outlineTree', action: 'create' });

    // 采用 → 面板关闭、新节点追加到末卷
    await user.click(adoptButton);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '规划后续 3–5 章大纲' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('button', { name: '编辑「续章1」' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑「续章3」' })).toBeInTheDocument();

    const nodes = await harness.repository.listOutline(novel.id);
    expect(nodes).toHaveLength(5); // 原卷+章节点 + 续写 3 章
    const added = nodes.filter((node) => node.title.startsWith('续章'));
    expect(added).toHaveLength(3);
    expect(added.every((node) => node.parentId === volumeId)).toBe(true);
    expect(added.map((node) => node.title)).toEqual(['续章1', '续章2', '续章3']);
    // 梗概已合成可读结构
    expect(added[0]!.synopsis).toContain('场清单：');
    expect(added[0]!.synopsis).toContain('章末钩子：章末钩子1');
    expect(added[0]!.synopsis).toContain('回收伏笔：旧簪来历');
    // 已有章节/设定/节点不变
    const chaptersAfter = await harness.repository.listChapters(novel.id);
    expect(chaptersAfter.map((item) => item.id)).toEqual(chaptersBefore.map((item) => item.id));
    expect(chaptersAfter.map((item) => item.content)).toEqual(
      chaptersBefore.map((item) => item.content),
    );
    expect(await harness.repository.listEntries(novel.id)).toHaveLength(entriesBefore.length);
    const originalNodes = nodes.filter((node) => node.id === volumeId || node.id === chapterNodeId);
    expect(originalNodes).toHaveLength(2);
  });

  it('schema 失败：role=alert、不写提案、可重试成功', async () => {
    // 只有 2 章 → 违反 schema min(3)，结构化解析失败（不可重试错误直接给用户）
    stubContinue({ chapters: frontierPayload(2).chapters });
    await renderPage();
    const { user, dialog } = await openContinuePanel();

    await user.click(within(dialog).getByRole('button', { name: '规划 3 章大纲' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toEqual([]);
    expect(within(dialog).getByRole('button', { name: '规划 3 章大纲' })).toBeInTheDocument();

    // 重试：换回合法响应
    stubContinue();
    await user.click(within(dialog).getByRole('button', { name: '规划 3 章大纲' }));
    expect(await within(dialog).findByText('已生成提案，确认后写入大纲。')).toBeInTheDocument();
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(1);
  });
});
