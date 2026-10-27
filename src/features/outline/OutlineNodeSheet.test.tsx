import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
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
import { WritingPage } from '../writing/WritingPage';
import { OutlineNodeSheet } from './OutlineNodeSheet';

let harness: TestHarness;
let novel: Novel;
let style: StyleProfile;
let categories: Category[];
let worldCategory: Category;
let characterCategory: Category;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
  categories = await harness.repository.listCategories(novel.id);
  worldCategory = categories[0]!;
  characterCategory = categories[1]!;
  style = (await harness.repository.getStyleProfile(novel.id))!;
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 一次细化会拆出的两个子节点：梗概都点名沈砚与裴照，便于触发关联建议 */
const EXPAND_RESULT = {
  children: [
    {
      title: '渡口相遇',
      synopsis: '沈砚在渡口与裴照相遇，被迫接下去北方的差事。',
      targetWords: 1500,
    },
    { title: '北上之路', synopsis: '裴照押着沈砚北上，途中发现青冥宗旧物。', targetWords: 1500 },
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

async function outlineOf(): Promise<OutlineNode[]> {
  return harness.repository.listOutline(novel.id);
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

/** 点「细化这一节点」并等到提案确认面板出现 */
async function startExpand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '细化这一节点' }));
  await screen.findByRole('button', { name: /采用这份细目/u });
}

describe('细化前落盘', () => {
  it('改了梗概没保存就细化：先写库，并用新梗概构建 prompt', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '旧梗概：林越醒来。',
    });
    const bodies = stubExpand();
    const { user } = renderSheet(node);

    const synopsis = screen.getByLabelText('梗概');
    await user.clear(synopsis);
    await user.type(synopsis, '新梗概：沈砚在渡口遇见裴照。');
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    await screen.findByRole('button', { name: /采用这份细目/u });

    const saved = (await outlineOf()).find((item) => item.id === node.id);
    expect(saved?.synopsis).toBe('新梗概：沈砚在渡口遇见裴照。');
    const prompt = userPromptOf(bodies[0]!);
    expect(prompt).toContain('该节点梗概：新梗概：沈砚在渡口遇见裴照。');
    expect(prompt).not.toContain('旧梗概');
  });

  it('标题为空时不落盘也不发请求', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, { title: '第一卷 渡口' });
    const bodies = stubExpand();
    const { user } = renderSheet(node);

    await user.clear(screen.getByLabelText('标题'));
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));

    expect(await screen.findByText('标题不能为空')).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
    expect((await outlineOf())[0]?.title).toBe('第一卷 渡口');
  });
});

describe('注入清单', () => {
  it('展示核心设定 / 显式关联 / 名称命中与 token 估算', async () => {
    const pinned = await harness.repository.createEntry(novel.id, {
      categoryId: worldCategory.id,
      title: '归墟界',
      pinned: true,
    });
    const linked = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '裴照',
    });
    const mentioned = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '沈砚',
    });
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口遇见裴照。',
      linkedEntryIds: [linked.id],
    });
    const entries = await harness.repository.listEntries(novel.id);
    renderSheet(node, { entries });

    expect(await screen.findByText('本次参考设定')).toBeInTheDocument();
    expect(screen.getByText(/核心设定 1 条（始终注入）：归墟界/)).toBeInTheDocument();
    expect(screen.getByText(/相关设定：显式 1 条 \+ 提到 1 条，共/)).toBeInTheDocument();
    expect(screen.getByText('提到 · 沈砚')).toBeInTheDocument();
    expect(entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([pinned.id, linked.id, mentioned.id]),
    );
  });

  it('临时移除提到的条目后，prompt 不再包含它的完整字段', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '沈砚',
      summary: '失忆剑客',
      fields: { flaw: '妹妹' },
    });
    const entries = await harness.repository.listEntries(novel.id);
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口醒来。',
    });
    const bodies = stubExpand();
    const { user } = renderSheet(node, { entries });

    expect(screen.getByText('提到 · 沈砚')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '移除提到的设定：沈砚' }));
    expect(screen.queryByText('提到 · 沈砚')).not.toBeInTheDocument();
    expect(screen.queryByText('本次参考设定')).not.toBeInTheDocument();

    await startExpand(user);
    const prompt = userPromptOf(bodies[0]!);
    // 移除的是「注入的条目字段」，不是把梗概里的名字删掉
    expect(prompt).toContain('沈砚在渡口醒来');
    expect(prompt).not.toContain('## 沈砚');
    expect(prompt).not.toContain('软肋与恐惧：妹妹');
  });
});

describe('replace 影响告知', () => {
  async function seedChildren(): Promise<{
    node: OutlineNode;
    nodes: OutlineNode[];
    chapter: Chapter;
  }> {
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '林越醒来。',
    });
    const child1 = await harness.repository.createOutlineNode(novel.id, {
      title: '夜探青冥宗',
      synopsis: '发现血书。',
      parentId: node.id,
    });
    await harness.repository.createOutlineNode(novel.id, {
      title: '血书',
      parentId: node.id,
    });
    const chapter = await harness.repository.createChapter(novel.id, {
      title: '第1章 夜探',
      content: '青冥宗的夜里没有月亮。',
      outlineNodeId: child1.id,
    });
    return { node, nodes: await outlineOf(), chapter };
  }

  it('列出替换子节点数与解链章节数；取消不发请求，确认才发', async () => {
    const { node, nodes, chapter } = await seedChildren();
    const bodies = stubExpand();
    const { user } = renderSheet(node, { nodes, chapters: [chapter] });

    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    const dialog = await screen.findByRole('dialog', { name: '替换现有的子节点？' });
    expect(
      within(dialog).getByText(/将替换「第一卷 渡口」下现有的 2 个子节点（含孙节点）/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/其中约 1 个已挂章节（1 个已有正文）会解除大纲关联/),
    ).toBeInTheDocument();
    expect(bodies).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '替换现有的子节点？' })).not.toBeInTheDocument(),
    );
    expect(bodies).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    await user.click(await screen.findByRole('button', { name: '继续细化' }));
    await screen.findByRole('button', { name: /采用这份细目/u });
    expect(bodies).toHaveLength(1);
  });
});

describe('采用后的关联确认', () => {
  it('采用后按新子节点给出建议，默认全选；取消一条则只写选中的', async () => {
    const shen = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '沈砚',
    });
    const pei = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '裴照',
    });
    const entries = await harness.repository.listEntries(novel.id);
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口遇见裴照。',
    });
    stubExpand();
    const updateSpy = vi.spyOn(harness.repository, 'updateOutlineLinks');
    const { user } = renderSheet(node, { entries });

    await startExpand(user);
    await user.click(screen.getByRole('button', { name: /采用这份细目/u }));

    const dialog = await screen.findByRole('dialog', { name: '确认自动关联' });
    expect(within(dialog).getByRole('button', { name: '确认关联（4 条）' })).toBeInTheDocument();
    // 取消「渡口相遇」这个子节点的裴照关联
    await user.click(within(dialog).getByRole('button', { name: /关联建议：渡口相遇 · 裴照/ }));
    await user.click(within(dialog).getByRole('button', { name: '确认关联（3 条）' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument(),
    );
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const outline = await outlineOf();
    const firstChild = outline.find((item) => item.title === '渡口相遇')!;
    const secondChild = outline.find((item) => item.title === '北上之路')!;
    expect(firstChild.linkedEntryIds).toContain(shen.id);
    expect(firstChild.linkedEntryIds).not.toContain(pei.id);
    expect(secondChild.linkedEntryIds).toEqual(expect.arrayContaining([shen.id, pei.id]));
  });

  it('全部跳过：一条 links 都不写', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '沈砚',
    });
    const entries = await harness.repository.listEntries(novel.id);
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口醒来。',
    });
    stubExpand();
    const updateSpy = vi.spyOn(harness.repository, 'updateOutlineLinks');
    const { user } = renderSheet(node, { entries });

    await startExpand(user);
    await user.click(screen.getByRole('button', { name: /采用这份细目/u }));
    const dialog = await screen.findByRole('dialog', { name: '确认自动关联' });
    await user.click(within(dialog).getByRole('button', { name: '全部跳过' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument(),
    );
    expect(updateSpy).not.toHaveBeenCalled();
    const children = (await outlineOf()).filter((item) => item.parentId === node.id);
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.linkedEntryIds.length === 0)).toBe(true);
  });

  it('提案被拒绝时：不弹面板、不写 links、大纲不变', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '沈砚',
    });
    const entries = await harness.repository.listEntries(novel.id);
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口醒来。',
    });
    stubExpand();
    const updateSpy = vi.spyOn(harness.repository, 'updateOutlineLinks');
    const { user } = renderSheet(node, { entries });

    await startExpand(user);
    await user.click(screen.getByRole('button', { name: '全部忽略' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '全部忽略' })).not.toBeInTheDocument(),
    );
    // 等 onSettled 里「查 accepted 提案」的异步读取跑完，确认它确实没有开面板
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(await outlineOf()).toHaveLength(1);
  });

  it('父节点的显式关联默认继承到新子节点，父节点自身不变', async () => {
    const pei = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '裴照',
    });
    const entries = await harness.repository.listEntries(novel.id);
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '北上的路。',
      linkedEntryIds: [pei.id],
    });
    // 子节点梗概不提任何名字，建议只来自继承
    stubExpand({
      children: [
        { title: '渡口', synopsis: '北上的路从这里开始。', targetWords: 1500 },
        { title: '雪夜', synopsis: '风雪压城。', targetWords: 1500 },
      ],
    });
    const updateSpy = vi.spyOn(harness.repository, 'updateOutlineLinks');
    const { user } = renderSheet(node, { entries });

    await startExpand(user);
    await user.click(screen.getByRole('button', { name: /采用这份细目/u }));

    const dialog = await screen.findByRole('dialog', { name: '确认自动关联' });
    expect(
      within(dialog).getByRole('button', { name: /关联建议：渡口 · 裴照（继承）/ }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '全部保留' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument(),
    );
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const outline = await outlineOf();
    const parent = outline.find((item) => item.id === node.id)!;
    const children = outline.filter((item) => item.parentId === node.id);
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.linkedEntryIds.includes(pei.id))).toBe(true);
    expect(parent.linkedEntryIds).toEqual([pei.id]);
  });

  it('只对本次新子节点建议，旧子节点不重复出现', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '沈砚',
    });
    const entries = await harness.repository.listEntries(novel.id);
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口醒来。',
    });
    await harness.repository.createOutlineNode(novel.id, {
      title: '旧章 · 不该再被建议',
      synopsis: '沈砚的旧细目。',
      parentId: node.id,
    });
    const nodes = await outlineOf();
    stubExpand();
    const { user } = renderSheet(node, { entries, nodes });

    // 有旧子节点 → 先确认 replace 影响
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    await user.click(await screen.findByRole('button', { name: '继续细化' }));
    await user.click(await screen.findByRole('button', { name: /采用这份细目/u }));

    const dialog = await screen.findByRole('dialog', { name: '确认自动关联' });
    expect(within(dialog).getByText('渡口相遇')).toBeInTheDocument();
    expect(within(dialog).getByText('北上之路')).toBeInTheDocument();
    expect(within(dialog).queryByText('旧章 · 不该再被建议')).not.toBeInTheDocument();
  });
});

describe('会话内抑制', () => {
  it('跳过过的条目，同一次会话里再次细化不再建议', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '沈砚',
    });
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口醒来。',
    });
    stubExpand();

    harness.renderUI(<WritingPage />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: '编辑「第一卷 渡口」' }));

    // 第一次细化 → 采用 → 关联面板全部跳过（沈砚记入会话抑制集）
    await startExpand(user);
    await user.click(screen.getByRole('button', { name: /采用这份细目/u }));
    const firstPanel = await screen.findByRole('dialog', { name: '确认自动关联' });
    await user.click(within(firstPanel).getByRole('button', { name: '全部跳过' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument(),
    );
    // 等写作页刷新出新子节点：此时再次细化会走 replace 告知
    expect(await screen.findByText(/该节点已有 2 个子节点/)).toBeInTheDocument();

    // 第二次细化：同一会话，被跳过的沈砚不应再出现在建议里（本次无其他建议 → 面板不出现）
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    await user.click(await screen.findByRole('button', { name: '继续细化' }));
    await user.click(await screen.findByRole('button', { name: /采用这份细目/u }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /采用这份细目/u })).not.toBeInTheDocument(),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(screen.queryByRole('dialog', { name: '确认自动关联' })).not.toBeInTheDocument();
    expect(node.id).toBeTruthy();
  });
});

describe('注入清单 · 预算', () => {
  it('预算放不下的条目列出「未注入」原因', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: worldCategory.id,
      title: '归墟界',
      pinned: true,
      // 4 万个拉丁字符 ≈ 1 万 token，单条核心设定就吃满 8k 规划预算
      summary: 'x'.repeat(40_000),
    });
    const linked = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '裴照',
    });
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '沈砚',
    });
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口遇见裴照。',
      linkedEntryIds: [linked.id],
    });
    const entries = await harness.repository.listEntries(novel.id);
    renderSheet(node, { entries });

    expect(await screen.findByText(/未注入：/)).toBeInTheDocument();
    expect(screen.getByText(/裴照（显式关联超出篇幅）/)).toBeInTheDocument();
    expect(screen.getByText(/沈砚（超出篇幅）/)).toBeInTheDocument();
  });
});

describe('旧调用与新增上下文的兼容', () => {
  it('不传 chapters/openThreads/rollingSummary 时 prompt 不含新块', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, { title: '第一卷 渡口' });
    const bodies = stubExpand();
    const { user } = renderSheet(node);

    await startExpand(user);
    const prompt = userPromptOf(bodies[0]!);
    expect(prompt).not.toContain('【当前未收束的伏笔】');
    expect(prompt).not.toContain('【故事至此】');
    // 没有可注入的设定时也不渲染空的【相关设定】
    expect(prompt).not.toContain('【相关设定】');
  });

  it('传入主线伏笔与滚动摘要后进 user prompt', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '林越醒来。',
    });
    const bodies = stubExpand();
    const { user } = renderSheet(node, {
      openThreads: ['林越的身世', '刀的来历'],
      rollingSummary: '林越在渡口醒来，随裴照北上。',
    });

    await startExpand(user);
    const prompt = userPromptOf(bodies[0]!);
    expect(prompt).toContain('【当前未收束的伏笔】\n- 林越的身世\n- 刀的来历');
    expect(prompt).toContain('【故事至此】\n林越在渡口醒来，随裴照北上。');
  });
});

describe('D2 额外要求不落库的提示', () => {
  it('面板说明额外要求只影响本次细化', async () => {
    const node = await harness.repository.createOutlineNode(novel.id, { title: '第一卷 渡口' });
    renderSheet(node);
    expect(await screen.findByText(/额外要求只影响本次细化，不会保存/)).toBeInTheDocument();
  });
});
