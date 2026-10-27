/**
 * S4/S5 独立验收 · 交互链（US-1 / US-2 / US-3，反向测试 R14–R26）。
 *
 * 覆盖 Lead 点名的重点：未保存梗概先落盘、注入清单与临时移除、replace 告知与取消不发请求、
 * 采用后关联面板（默认全选/取消/全部跳过/被拒不弹/旧节点不重复/父链接继承/会话抑制）、
 * 只对新节点建议、一次 updateOutlineLinks 单事务。
 *
 * 与开发的 OutlineNodeSheet.test.tsx 相互独立：夹具与断言按验收条目重写。
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Category,
  Chapter,
  KnowledgeEntry,
  Novel,
  OutlineNode,
  StyleProfile,
} from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { useRepoQuery } from '@/data/useRepoQuery';
import { OutlineNodeSheet } from '@/features/outline/OutlineNodeSheet';

let harness: TestHarness;
let novel: Novel;
let style: StyleProfile;
let categories: Category[];
let characterCategory: Category;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  categories = await harness.repository.listCategories(novel.id);
  characterCategory = categories[1]!;
  style = (await harness.repository.getStyleProfile(novel.id))!;
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 默认细化结果：两个子节点，梗概点名沈砚/裴照，用于触发关联建议 */
const EXPAND_RESULT = {
  children: [
    {
      title: '渡口相遇',
      synopsis: '沈砚在渡口与裴照相遇，被迫接下去北方的差事。',
      targetWords: 1500,
    },
    { title: '北上之路', synopsis: '沈砚被押着北上，途中发现青冥宗旧物。', targetWords: 1500 },
  ],
};

function stubExpand(result: unknown = EXPAND_RESULT): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return jsonResponse(completion(JSON.stringify(result)));
    }),
  );
  return bodies;
}

function userPromptOf(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: string }[];
  return messages.find((message) => message.role === 'user')?.content ?? '';
}
function systemPromptOf(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: string }[];
  return messages.find((message) => message.role === 'system')?.content ?? '';
}

async function outlineOf(): Promise<OutlineNode[]> {
  return harness.repository.listOutline(novel.id);
}

async function entry(title: string, options: { pinned?: boolean; aliases?: string[] } = {}) {
  return harness.repository.createEntry(novel.id, {
    categoryId: characterCategory.id,
    title,
    aliases: options.aliases ?? [],
    summary: `${title}的一句话摘要。`,
    ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
    fields: { identity: `${title}的身份`, personality: `${title}的性格` },
  });
}

interface SheetOptions {
  nodes?: OutlineNode[];
  entries?: KnowledgeEntry[];
  chapters?: readonly Chapter[];
  openThreads?: readonly string[];
  rollingSummary?: string;
}

function renderSheet(node: OutlineNode, options: SheetOptions = {}) {
  const onClose = vi.fn();
  harness.renderUI(
    <OutlineNodeSheet
      open
      novel={novel}
      style={style}
      node={node}
      nodes={options.nodes ?? [node]}
      entries={options.entries ?? []}
      categories={categories}
      depth={0}
      chapters={options.chapters}
      openThreads={options.openThreads}
      rollingSummary={options.rollingSummary}
      onClose={onClose}
    />,
  );
  return { user: userEvent.setup(), onClose };
}

async function startExpand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '细化这一节点' }));
  await screen.findByRole('button', { name: /采用这份细目/u });
}

async function adoptAndWaitPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /采用这份细目/u }));
  return screen.findByRole('dialog', { name: '确认自动关联' });
}

/** 等一段异步链（onSettled 的仓储读取）跑完，用于断言「面板确实没有出现」 */
async function settleAsync() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
}

/**
 * 模拟真实 WritingPage：大纲节点随 invalidate 重查（stale-while-revalidate），
 * 面板保持挂载。会话抑制用例需要在「采用后 children 出现在 props 里」的同一组件实例上再细化。
 */
function LiveOutlineSheet({
  nodeId,
  entries,
  chapters,
}: {
  nodeId: string;
  entries: KnowledgeEntry[];
  chapters?: readonly Chapter[];
}) {
  const { data } = useRepoQuery((repo) => repo.listOutline(novel.id), [novel.id]);
  const nodes = data ?? [];
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  return (
    <OutlineNodeSheet
      open
      novel={novel}
      style={style}
      node={node}
      nodes={nodes}
      entries={entries}
      categories={categories}
      depth={0}
      chapters={chapters}
      onClose={() => {}}
    />
  );
}

function renderLiveSheet(nodeId: string, entries: KnowledgeEntry[], chapters?: readonly Chapter[]) {
  harness.renderUI(<LiveOutlineSheet nodeId={nodeId} entries={entries} chapters={chapters} />);
  return { user: userEvent.setup() };
}

describe('S4 · 细化前先落盘（反向 R24）', () => {
  it('改了梗概不点保存直接细化：先写库，请求使用新梗概', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '旧梗概：林越在渡口醒来。',
    });
    const bodies = stubExpand();
    const { user } = renderSheet(node);

    const synopsis = screen.getByLabelText('梗概');
    await user.clear(synopsis);
    await user.type(synopsis, '新梗概：沈砚在渡口接差事。');
    await startExpand(user);

    const saved = (await outlineOf()).find((item) => item.id === node.id)!;
    expect(saved.synopsis).toBe('新梗概：沈砚在渡口接差事。');
    expect(userPromptOf(bodies[0]!)).toContain('该节点梗概：新梗概：沈砚在渡口接差事。');
    expect(userPromptOf(bodies[0]!)).not.toContain('旧梗概');
    expect(saved.linkedEntryIds).toEqual(node.linkedEntryIds);
  });

  it('标题为空：不落盘、不发请求、显示校验错误（反向 R24）', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷',
      synopsis: '梗概。',
    });
    const bodies = stubExpand();
    const { user } = renderSheet(node);

    await user.clear(screen.getByLabelText('标题'));
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));

    expect(await screen.findByText('标题不能为空')).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
    expect((await outlineOf()).find((item) => item.id === node.id)!.title).toBe('第一卷');
  });
});

describe('S4 · 注入清单与临时移除（US-1a，反向 R26）', () => {
  it('展示核心/显式/提到与 token；移除提到的条目后请求不再包含它', async () => {
    const qi = await entry('灵气', { pinned: true });
    const pei = await entry('裴照');
    const shen = await entry('沈砚');
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口与裴照相遇。',
      linkedEntryIds: [pei.id],
    });
    const bodies = stubExpand();
    const { user } = renderSheet(node, { entries: [qi, pei, shen] });

    expect(screen.getByText('本次注入')).toBeInTheDocument();
    expect(screen.getByText(/核心设定 1 条（始终注入）：灵气/u)).toBeInTheDocument();
    expect(screen.getByText(/相关设定：手工关联 1 条 \+ 名字提到 1 条/u)).toBeInTheDocument();
    // P1：命中名与标题相同时不再重复写一遍（旧「沈砚 提到 · 沈砚」）
    expect(screen.getAllByText('名字提到').length).toBeGreaterThan(0);

    // 系统提示：核心设定进 system，逐节点条目进 user（缓存纪律）
    await startExpand(user);
    const system = systemPromptOf(bodies[0]!);
    const userPrompt = userPromptOf(bodies[0]!);
    expect(system).toContain('## 灵气（人物）');
    expect(system).not.toContain('## 沈砚（人物）');
    expect(userPrompt).toContain('## 裴照（人物）');
    expect(userPrompt).toContain('## 沈砚（人物）');
    expect(userPrompt).toContain('身份：沈砚的身份');
  });

  it('移除名字提到的设定：chips 消失，本次请求 prompt 不含该条目完整字段', async () => {
    const shen = await entry('沈砚');
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口等人。',
    });
    const bodies = stubExpand();
    const { user } = renderSheet(node, { entries: [shen] });

    await user.click(screen.getByRole('button', { name: '移除名字提到的设定：沈砚' }));
    expect(
      screen.queryByRole('button', { name: '移除名字提到的设定：沈砚' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('本次注入')).not.toBeInTheDocument();

    await startExpand(user);
    const prompt = userPromptOf(bodies[0]!);
    expect(prompt).not.toContain('## 沈砚（人物）');
    expect(prompt).not.toContain('身份：沈砚的身份');
  });
});

describe('S4 · 传给模型的新上下文块（US-1b）', () => {
  it('openThreads 与顶层 rollingSummary 进 user prompt；无新输入时保持旧输出（反向 R14）', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '林越在渡口醒来。',
    });
    const withContext = stubExpand();
    const first = renderSheet(node, {
      openThreads: ['林越的身世', '刀的来历'],
      rollingSummary: '林越失去记忆，随裴照北上。',
    });
    await startExpand(first.user);
    const prompt = userPromptOf(withContext[0]!);
    expect(prompt).toContain('【当前未收束的伏笔】');
    expect(prompt).toContain('- 林越的身世');
    expect(prompt).toContain('【故事至此】');
    expect(prompt).toContain('林越失去记忆，随裴照北上。');
    await harness.cleanup();

    // 不传新 props：不出现新块，也没有【相关设定】空块
    harness = await createTestHarness();
    novel = await harness.repository.createNovel({ title: '归墟纪（旧调用）' });
    categories = await harness.repository.listCategories(novel.id);
    characterCategory = categories[1]!;
    style = (await harness.repository.getStyleProfile(novel.id))!;
    const legacyNode = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷',
      synopsis: '旧调用梗概。',
    });
    const legacyBodies = stubExpand();
    const legacy = renderSheet(legacyNode);
    await startExpand(legacy.user);
    const legacyPrompt = userPromptOf(legacyBodies[0]!);
    expect(legacyPrompt).not.toContain('【相关设定】');
    expect(legacyPrompt).not.toContain('【当前未收束的伏笔】');
    expect(legacyPrompt).not.toContain('【故事至此】');
  });
});

describe('S4 · replace 影响告知（US-3a，反向 R25）', () => {
  it('列出替换子节点数与解链章节数；取消不发请求，确认后才发', async () => {
    const volume = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '卷梗概。',
    });
    const childA = await harness.repository.createOutlineNode(novel.id, {
      title: '旧子一',
      parentId: volume.id,
    });
    const childB = await harness.repository.createOutlineNode(novel.id, {
      title: '旧子二',
      parentId: volume.id,
    });
    const chapterWithContent = await harness.repository.createChapter(novel.id, {
      title: '挂旧子一',
      content: '已有正文。',
      outlineNodeId: childA.id,
    });
    const chapterEmpty = await harness.repository.createChapter(novel.id, {
      title: '挂旧子二',
      outlineNodeId: childB.id,
    });
    const bodies = stubExpand();
    const nodes = await outlineOf();
    const { user } = renderSheet(volume, {
      nodes,
      chapters: await harness.repository.listChapters(novel.id),
    });

    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    const dialog = await screen.findByRole('dialog', { name: '替换现有的子节点？' });
    expect(within(dialog).getByText(/现有的 2 个子节点（含孙节点）/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/约 2 个已挂章节（1 个已有正文）/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/正文保留，不会删除，之后可以重新关联/u)).toBeInTheDocument();

    // 取消：不发请求
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '替换现有的子节点？' })).not.toBeInTheDocument(),
    );
    expect(bodies).toHaveLength(0);

    // 再点并确认：请求发出
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    const again = await screen.findByRole('dialog', { name: '替换现有的子节点？' });
    await user.click(within(again).getByRole('button', { name: '继续细化' }));
    await screen.findByRole('button', { name: /采用这份细目/u });
    expect(bodies).toHaveLength(1);
    // 提案存在、大纲尚未变化（采用前不删旧节点）
    expect((await outlineOf()).filter((item) => item.title === '旧子一')).toHaveLength(1);
    expect(chapterWithContent.id).toBeTruthy();
    expect(chapterEmpty.id).toBeTruthy();
  });
});

describe('S5 · 采用后关联确认（US-2，反向 R15–R21）', () => {
  it('默认全选；取消一条后只写选中的，一次批量写，父链接不变', async () => {
    const pei = await entry('裴照');
    const shen = await entry('沈砚');
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口与裴照相遇。',
      linkedEntryIds: [pei.id],
    });
    stubExpand();
    const updateSpy = vi.spyOn(harness.repository, 'updateOutlineLinks');
    const { user } = renderSheet(node, { entries: [pei, shen] });

    await startExpand(user);
    // P1：review 区给出本批细目数；单提案采用按钮不带含义不明的「（1）」
    expect(screen.getByText('共 2 章细目，采用后可继续编辑。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '采用这份细目' })).toBeInTheDocument();

    const dialog = await adoptAndWaitPanel(user);

    // P1：去掉与确认重复的「全部保留」；补「关闭不写入 / 取消项不再建议」说明
    expect(within(dialog).queryByRole('button', { name: '全部保留' })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/关闭面板不会写入任何关联/u)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/取消的条目在本次打开节点抽屉期间不再建议/u),
    ).toBeInTheDocument();

    // 默认全选：4 条建议（每子节点各继承裴照 + 提到沈砚）
    expect(within(dialog).getByRole('button', { name: '确认关联（4 条）' })).toBeInTheDocument();
    // 取消「渡口相遇」子节点的沈砚关联
    const shenChip = within(dialog).getByRole('button', { name: /关联建议：渡口相遇 · 沈砚/u });
    expect(shenChip).toHaveAttribute('aria-pressed', 'true');
    await user.click(shenChip);
    expect(shenChip).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(dialog).getByRole('button', { name: '确认关联（3 条）' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument(),
    );
    expect(updateSpy).toHaveBeenCalledTimes(1); // 一次批量事务调用

    const outline = await outlineOf();
    const first = outline.find((item) => item.title === '渡口相遇')!;
    const second = outline.find((item) => item.title === '北上之路')!;
    expect(first.linkedEntryIds).toEqual([pei.id]);
    expect(second.linkedEntryIds).toEqual(expect.arrayContaining([pei.id, shen.id]));
    // 父节点自身不变
    expect(outline.find((item) => item.id === node.id)!.linkedEntryIds).toEqual([pei.id]);
  });

  it('全部跳过：一条 links 都不写，会话内记住跳过项（反向 R16/R19）', async () => {
    const shen = await entry('沈砚');
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口等人。',
    });
    const bodies = stubExpand();
    const updateSpy = vi.spyOn(harness.repository, 'updateOutlineLinks');
    // 用「随 invalidate 重查」的 wrapper 模拟真实页面：采用后同一个组件实例拿到新 children
    const { user } = renderLiveSheet(node.id, [shen]);

    await startExpand(user);
    const dialog = await adoptAndWaitPanel(user);
    await user.click(within(dialog).getByRole('button', { name: '全部跳过' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument(),
    );
    expect(updateSpy).not.toHaveBeenCalled();
    const children = (await outlineOf()).filter((item) => item.parentId === node.id);
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.linkedEntryIds.length === 0)).toBe(true);

    // 再次细化（replace 会换新子节点 id）：条目级抑制保证「沈砚」不再被建议
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    const confirm = await screen.findByRole('dialog', { name: '替换现有的子节点？' });
    await user.click(within(confirm).getByRole('button', { name: '继续细化' }));
    await screen.findByRole('button', { name: /采用这份细目/u });
    await user.click(screen.getByRole('button', { name: /采用这份细目/u }));
    await settleAsync();

    expect(bodies.length).toBe(2);
    expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('提案被拒绝：不弹面板、不写 links、大纲不变（反向 R15）', async () => {
    const shen = await entry('沈砚');
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口等人。',
    });
    stubExpand();
    const updateSpy = vi.spyOn(harness.repository, 'updateOutlineLinks');
    const { user } = renderSheet(node, { entries: [shen] });

    await startExpand(user);
    await user.click(screen.getByRole('button', { name: '全部忽略' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '全部忽略' })).not.toBeInTheDocument(),
    );
    await settleAsync();

    expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(await outlineOf()).toHaveLength(1); // 只有父节点
  });

  it('父节点显式关联默认继承，面板标「继承」，确认后写进新子节点（反向 R20）', async () => {
    const pei = await entry('裴照');
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷',
      synopsis: '卷梗概。',
      linkedEntryIds: [pei.id],
    });
    // 子节点梗概不点名任何人：只剩继承建议
    stubExpand({
      children: [
        { title: '第一节', synopsis: '风雪交加。', targetWords: 1500 },
        { title: '第二节', synopsis: '继续赶路。', targetWords: 1500 },
      ],
    });
    const { user } = renderSheet(node, { entries: [pei] });

    await startExpand(user);
    const dialog = await adoptAndWaitPanel(user);
    const chips = within(dialog).getAllByRole('button', { name: /关联建议：.*· 裴照（继承）/u });
    expect(chips).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: '确认关联（2 条）' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument(),
    );

    const children = (await outlineOf()).filter((item) => item.parentId === node.id);
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.linkedEntryIds).toEqual([pei.id]);
    // 父节点自身链接不丢也不变
    expect((await outlineOf()).find((item) => item.id === node.id)!.linkedEntryIds).toEqual([
      pei.id,
    ]);
  });

  it('只对本次新子节点建议：旧子节点不出现在面板，也不被写 links（反向 R18）', async () => {
    const shen = await entry('沈砚');
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '卷梗概。',
    });
    await harness.repository.createOutlineNode(novel.id, {
      title: '旧子（上一版）',
      synopsis: '沈砚曾经来过。',
      parentId: node.id,
    });
    let nodes = await outlineOf();
    stubExpand({
      children: [
        { title: '新子一', synopsis: '沈砚再次来访。', targetWords: 1500 },
        { title: '新子二', synopsis: '风雪更大了。', targetWords: 1500 },
      ],
    });
    const { user } = renderSheet(node, { nodes, entries: [shen] });

    // 已有子节点 → replace 先弹告知，确认后才发请求
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    const replaceConfirm = await screen.findByRole('dialog', { name: '替换现有的子节点？' });
    await user.click(within(replaceConfirm).getByRole('button', { name: '继续细化' }));
    await screen.findByRole('button', { name: /采用这份细目/u });
    const dialog = await adoptAndWaitPanel(user);
    // 只有「新子一」提到沈砚，所以只有它出现在面板；无建议的子节点不出现（设计 §6.1）
    expect(within(dialog).getByText('新子一')).toBeInTheDocument();
    expect(within(dialog).queryByText('新子二')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('旧子（上一版）')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /确认关联（\d+ 条）/u }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument(),
    );

    nodes = await outlineOf();
    const children = nodes
      .filter((item) => item.parentId === node.id)
      .sort((a, b) => a.order - b.order);
    expect(children.map((item) => item.title)).toEqual(['新子一', '新子二']);
    expect(children[0]!.linkedEntryIds).toEqual([shen.id]); // 提到了沈砚
    expect(children[1]!.linkedEntryIds).toEqual([]); // 未点名
  });

  it('没有建议时不弹面板（无条目/不点名）', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷',
      synopsis: '旧调用梗概。',
    });
    stubExpand({
      children: [
        { title: '第一节', synopsis: '风雪很大。', targetWords: 1500 },
        { title: '第二节', synopsis: '继续赶路。', targetWords: 1500 },
      ],
    });
    const updateSpy = vi.spyOn(harness.repository, 'updateOutlineLinks');
    const { user } = renderSheet(node, { entries: [] });

    expect(screen.queryByText('本次注入')).not.toBeInTheDocument();
    await startExpand(user);
    await user.click(screen.getByRole('button', { name: /采用这份细目/u }));
    await settleAsync();

    expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
    expect((await outlineOf()).filter((item) => item.parentId === node.id)).toHaveLength(2);
  });
});

describe('反向 R17 · 连点细化只发一次请求', () => {
  it('running 期间按钮禁用，双击只请求一次', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷',
      synopsis: '梗概。',
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchSpy = vi.fn(async () => {
      await gate;
      return jsonResponse(completion(JSON.stringify(EXPAND_RESULT)));
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { user } = renderSheet(node);

    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    // 第一次点击后进入 running：按钮文案变化且禁用
    expect(await screen.findByRole('button', { name: '正在细化…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '正在细化…' }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    release?.();
    await screen.findByRole('button', { name: /采用这份细目/u });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('P1 · 关联确认面板（关闭不写入 / chip 文案不重复）', () => {
  it('关闭面板（X）：一条关联都不写，与「全部跳过」等价', async () => {
    const shen = await entry('沈砚');
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口等人。',
    });
    stubExpand();
    const updateSpy = vi.spyOn(harness.repository, 'updateOutlineLinks');
    const { user } = renderSheet(node, { entries: [shen] });

    await startExpand(user);
    const dialog = await adoptAndWaitPanel(user);
    expect(within(dialog).getByText(/关闭面板不会写入任何关联/u)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument(),
    );

    expect(updateSpy).not.toHaveBeenCalled();
    const children = (await outlineOf()).filter((item) => item.parentId === node.id);
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.linkedEntryIds.length === 0)).toBe(true);
  });

  it('别名命中：chip 显示「名字提到 · 小舟」，标题不重复一遍', async () => {
    const shen = await entry('沈砚', { aliases: ['小舟'] });
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '卷梗概。',
    });
    stubExpand({
      children: [
        { title: '渡口', synopsis: '小舟在渡口等人。', targetWords: 1500 },
        { title: '北上', synopsis: '继续赶路。', targetWords: 1500 },
      ],
    });
    const { user } = renderSheet(node, { entries: [shen] });

    await startExpand(user);
    const dialog = await adoptAndWaitPanel(user);
    // 命中名与标题不同 → 显示命中名；不再是「沈砚 提到 · 小舟」
    expect(
      within(dialog).getByRole('button', { name: /关联建议：渡口 · 沈砚（名字提到 · 小舟）/u }),
    ).toBeInTheDocument();
    // 没有同名重复的旧文案
    expect(within(dialog).queryByText(/提到 · 沈砚/u)).not.toBeInTheDocument();
  });
});
