import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Category, Novel, OutlineNode } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { WritingPage } from './WritingPage';

let harness: TestHarness;
let novel: Novel;
let characterCategory: Category;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
  characterCategory = (await harness.repository.listCategories(novel.id))[1]!;
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  return harness.renderUI(<WritingPage />);
}

async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
}

interface SeededOutline {
  volume1: OutlineNode;
  chapter1: OutlineNode;
  chapter2: OutlineNode;
  volume2: OutlineNode;
}

/** 建一份两层大纲：卷一（含章一、章二）、卷二 */
async function seedOutline(): Promise<SeededOutline> {
  const volume1 = await harness.repository.createOutlineNode(novel.id, {
    title: '第一卷 风起',
    synopsis: '主角被追杀。',
    targetWords: 30_000,
  });
  const chapter1 = await harness.repository.createOutlineNode(novel.id, {
    title: '第1章 雪夜',
    synopsis: '追兵临门。',
    parentId: volume1.id,
    targetWords: 3000,
  });
  const chapter2 = await harness.repository.createOutlineNode(novel.id, {
    title: '第2章 旧识',
    parentId: volume1.id,
    targetWords: 3000,
  });
  const volume2 = await harness.repository.createOutlineNode(novel.id, {
    title: '第二卷 潮落',
  });
  return { volume1, chapter1, chapter2, volume2 };
}

async function outlineTitlesInOrder(): Promise<string[]> {
  const nodes = await harness.repository.listOutline(novel.id);
  const walk = (parentId: string | null, depth: number): string[] =>
    nodes
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.order - b.order)
      .flatMap((node) => [`${'  '.repeat(depth)}${node.title}`, ...walk(node.id, depth + 1)]);
  return walk(null, 0);
}

describe('空状态', () => {
  it('没有大纲时引导去立项或手动添加', async () => {
    renderPage();
    await waitForLoaded();

    expect(await screen.findByText('还没有大纲')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '手动添加第一个节点' })).toBeInTheDocument();
  });

  it('手动添加后自动打开该节点的编辑抽屉', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: '手动添加第一个节点' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('标题')).toHaveValue('第 1 卷');
  });
});

describe('大纲树展示', () => {
  it('按层级渲染，标出状态、目标字数与关联数', async () => {
    const { chapter1 } = await seedOutline();
    await harness.repository.updateOutlineNode(chapter1.id, {
      status: 'done',
      linkedEntryIds: ['x', 'y'],
    });

    renderPage();
    await waitForLoaded();

    expect(await screen.findByText('第一卷 风起')).toBeInTheDocument();
    expect(screen.getByText('第1章 雪夜')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('目标 3.0 万字')).toBeInTheDocument();
    expect(screen.getByText('关联 2 条设定')).toBeInTheDocument();
  });

  it('折叠节点时隐藏子树并提示内含数量', async () => {
    const user = userEvent.setup();
    await seedOutline();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: '折叠「第一卷 风起」' }));

    expect(screen.queryByText('第1章 雪夜')).not.toBeInTheDocument();
    expect(screen.getByText('内含 2 项')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '展开「第一卷 风起」' }));
    expect(screen.getByText('第1章 雪夜')).toBeInTheDocument();
  });

  it('展示全书进度：已写字数、目标字数与章节数', async () => {
    await seedOutline();
    await harness.repository.createChapter(novel.id, { content: '一二三四五' });

    renderPage();
    await waitForLoaded();

    const progress = (await screen.findByText('全书进度')).closest('section')!;
    expect(within(progress).getByText('5 字')).toBeInTheDocument();
    // 目标字数只累加叶子节点：章一 3000 + 章二 3000 + 卷二 0
    expect(within(progress).getByText('6000 字')).toBeInTheDocument();
    expect(within(progress).getByText('1 章')).toBeInTheDocument();
    expect(screen.getByText('4 个节点，0 个已完成')).toBeInTheDocument();
  });
});

describe('层级与顺序调整', () => {
  async function openReorder(title: string) {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: `调整「${title}」的位置` }));
    return user;
  }

  it('上移与前一个兄弟交换', async () => {
    await seedOutline();
    const user = await openReorder('第二卷 潮落');

    await user.click(screen.getByRole('button', { name: '上移「第二卷 潮落」' }));

    await waitFor(async () => {
      expect(await outlineTitlesInOrder()).toEqual([
        '第二卷 潮落',
        '第一卷 风起',
        '  第1章 雪夜',
        '  第2章 旧识',
      ]);
    });
  });

  it('降级成为上一个兄弟的子节点', async () => {
    await seedOutline();
    const user = await openReorder('第二卷 潮落');

    await user.click(screen.getByRole('button', { name: '降级「第二卷 潮落」' }));

    await waitFor(async () => {
      expect(await outlineTitlesInOrder()).toEqual([
        '第一卷 风起',
        '  第1章 雪夜',
        '  第2章 旧识',
        '  第二卷 潮落',
      ]);
    });
  });

  it('升级成为原父节点的下一个兄弟', async () => {
    await seedOutline();
    const user = await openReorder('第1章 雪夜');

    await user.click(screen.getByRole('button', { name: '升级「第1章 雪夜」' }));

    await waitFor(async () => {
      expect(await outlineTitlesInOrder()).toEqual([
        '第一卷 风起',
        '  第2章 旧识',
        '第1章 雪夜',
        '第二卷 潮落',
      ]);
    });
  });

  it('首位不能上移、顶层不能升级，按钮置灰', async () => {
    await seedOutline();
    await openReorder('第一卷 风起');

    expect(screen.getByRole('button', { name: '上移「第一卷 风起」' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '升级「第一卷 风起」' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '降级「第一卷 风起」' })).toBeDisabled();
  });

  it('一次只展开一行的排序操作条', async () => {
    await seedOutline();
    const user = await openReorder('第一卷 风起');

    expect(screen.getByRole('button', { name: '上移「第一卷 风起」' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '调整「第二卷 潮落」的位置' }));

    expect(screen.queryByRole('button', { name: '上移「第一卷 风起」' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上移「第二卷 潮落」' })).toBeInTheDocument();
  });
});

describe('节点编辑', () => {
  async function openNode(title: string) {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: `编辑「${title}」` }));
    return user;
  }

  it('编辑标题、梗概、字数与状态后写库', async () => {
    const { chapter1 } = await seedOutline();
    const user = await openNode('第1章 雪夜');

    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByLabelText('标题');
    await user.clear(title);
    await user.type(title, '第1章 雪夜追兵');
    await user.clear(within(dialog).getByLabelText('目标字数'));
    await user.type(within(dialog).getByLabelText('目标字数'), '4200');
    await user.click(within(dialog).getByRole('button', { name: '在写' }));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const nodes = await harness.repository.listOutline(novel.id);
      expect(nodes.find((node) => node.id === chapter1.id)).toMatchObject({
        title: '第1章 雪夜追兵',
        targetWords: 4200,
        status: 'drafting',
      });
    });
  });

  it('目标字数留空时存为 null', async () => {
    const { chapter1 } = await seedOutline();
    const user = await openNode('第1章 雪夜');

    await user.clear(within(screen.getByRole('dialog')).getByLabelText('目标字数'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const nodes = await harness.repository.listOutline(novel.id);
      expect(nodes.find((node) => node.id === chapter1.id)?.targetWords).toBeNull();
    });
  });

  it('标题为空时拦下', async () => {
    await seedOutline();
    const user = await openNode('第1章 雪夜');

    await user.clear(within(screen.getByRole('dialog')).getByLabelText('标题'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));

    expect(screen.getByRole('alert')).toHaveTextContent('标题不能为空');
  });

  it('关联知识条目，按分类分组选择', async () => {
    const { chapter1 } = await seedOutline();
    const entry = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '林越',
    });
    const user = await openNode('第1章 雪夜');

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '林越' }));
    expect(within(dialog).getByText(/已选 1 项/u)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const nodes = await harness.repository.listOutline(novel.id);
      expect(nodes.find((node) => node.id === chapter1.id)?.linkedEntryIds).toEqual([entry.id]);
    });
  });

  it('删除节点时提示会连带子节点，正文保留', async () => {
    await seedOutline();
    const user = await openNode('第一卷 风起');

    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '删除这个节点' }),
    );

    expect(screen.getByText(/及其 2 个子节点都会被删除/u)).toBeInTheDocument();
    expect(screen.getByText(/章节正文会保留/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(async () => {
      expect(await outlineTitlesInOrder()).toEqual(['第二卷 潮落']);
    });
  });
});

describe('AI 细化为子节点', () => {
  const EXPANDED = {
    children: [
      { title: '第1节 雪落', synopsis: '主角在雪中醒来。', targetWords: 1500 },
      { title: '第2节 追兵', synopsis: '黑衣人破门而入。', targetWords: 1500 },
    ],
  };

  function stubExpand(result: unknown = EXPANDED) {
    const fetchSpy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(completion(JSON.stringify(result)))),
    );
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  async function openNode(title: string) {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: `编辑「${title}」` }));
    return user;
  }

  it('结果先进确认管道，确认后挂到该节点之下', async () => {
    const { chapter2 } = await seedOutline();
    stubExpand();
    const user = await openNode('第2章 旧识');

    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    const accept = await screen.findByRole('button', { name: /采用这份细目/u });

    // 确认之前大纲没有变化
    expect(await harness.repository.listOutline(novel.id)).toHaveLength(4);

    await user.click(accept);

    await waitFor(async () => {
      expect(await outlineTitlesInOrder()).toEqual([
        '第一卷 风起',
        '  第1章 雪夜',
        '  第2章 旧识',
        '    第1节 雪落',
        '    第2节 追兵',
        '第二卷 潮落',
      ]);
    });
    expect(chapter2.id).toBeTruthy();
  });

  it('提示词带上祖先链、同层节点与关联设定', async () => {
    await seedOutline();
    const entry = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '林越',
      summary: '失忆剑客',
    });
    const fetchSpy = stubExpand();
    const user = await openNode('第2章 旧识');

    // 先关联一个条目再细化
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '林越' }));
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    await screen.findByRole('button', { name: /采用这份细目/u });

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
      model: string;
      thinking?: { type: string };
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;

    expect(userMessage).toContain('所属层级：第一卷 风起');
    expect(userMessage).toContain('要拆分的节点：第2章 旧识');
    // 同层的兄弟要给出来划定边界
    expect(userMessage).toContain('第1章 雪夜');
    expect(userMessage).toContain('林越：失忆剑客');
    // 细化是结构化推理任务
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.model).toBe('deepseek-v4-pro');
    expect(entry.id).toBeTruthy();
  });

  it('已有子节点时用替换语义，可查看原有细目', async () => {
    await seedOutline();
    stubExpand();
    const user = await openNode('第一卷 风起');

    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    await screen.findByRole('button', { name: /采用这份细目/u });

    // 唯一一条提案默认已展开，只有折叠时才需要点开
    const toggle = await screen.findByRole('button', { name: /细化 · 第一卷 风起/u });
    if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);

    expect(screen.getByText('替换')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '看原值' }));

    // 限定在抽屉内查找：抽屉背后的大纲树里也有同名节点
    expect(within(screen.getByRole('dialog')).getByText(/第1章 雪夜/u)).toBeInTheDocument();
  });

  it('替换后旧子节点被清掉，不留重复', async () => {
    await seedOutline();
    stubExpand();
    const user = await openNode('第一卷 风起');

    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    await user.click(await screen.findByRole('button', { name: /采用这份细目/u }));

    await waitFor(async () => {
      expect(await outlineTitlesInOrder()).toEqual([
        '第一卷 风起',
        '  第1节 雪落',
        '  第2节 追兵',
        '第二卷 潮落',
      ]);
    });
  });

  it('到达层级上限时不提供细化入口', async () => {
    const { chapter1 } = await seedOutline();
    await harness.repository.createOutlineNode(novel.id, {
      title: '第1节 雪落',
      parentId: chapter1.id,
    });

    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: '编辑「第1节 雪落」' }));

    expect(screen.getByText(/已到第 3 层，不能再往下拆分/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '细化这一节点' })).not.toBeInTheDocument();
  });

  it('模型输出不合格且修复失败时给出可读错误', async () => {
    await seedOutline();
    stubExpand({ children: [] });
    const user = await openNode('第2章 旧识');

    await user.click(screen.getByRole('button', { name: '细化这一节点' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('模型输出不符合预期格式');
  });

  it('未配置模型时禁用细化', async () => {
    useLlmSettings.getState().clearApiKey();
    await seedOutline();
    await openNode('第2章 旧识');

    expect(screen.getByRole('button', { name: '细化这一节点' })).toBeDisabled();
  });
});

describe('导出与无大纲的旧稿', () => {
  it('从章节区打开导出面板', async () => {
    const user = userEvent.setup();
    await harness.repository.createOutlineNode(novel.id, { title: '第一卷' });
    await harness.repository.createChapter(novel.id, { title: '离乡', content: '天还没亮。' });

    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: '导出' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('导出正文')).toBeInTheDocument();
    expect(within(dialog).getByText(/# 归墟纪/u)).toHaveTextContent('天还没亮。');
  });

  it('没有章节时不显示导出入口', async () => {
    await harness.repository.createOutlineNode(novel.id, { title: '第一卷' });
    renderPage();
    await waitForLoaded();
    expect(screen.queryByRole('button', { name: '导出' })).not.toBeInTheDocument();
  });

  it('有章节但没大纲时仍能看到章节列表 —— 导入旧稿的情形', async () => {
    await harness.repository.createChapter(novel.id, {
      title: '离乡',
      content: '天还没亮。',
      source: 'imported',
    });

    renderPage();
    await waitForLoaded();

    expect(screen.queryByText('还没有大纲')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '继续写第 1 章' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加第一个大纲节点' })).toBeInTheDocument();
  });

  it('大纲与章节都为空时才显示空状态', async () => {
    renderPage();
    await waitForLoaded();
    expect(await screen.findByText('还没有大纲')).toBeInTheDocument();
  });
});

describe('外传', () => {
  async function seedSide(title = '青冥旧事') {
    return harness.repository.createSideStory(novel.id, { title, synopsis: '二十年前。' });
  }

  it('空作品也有外传区块，作为新建入口', async () => {
    renderPage();
    await waitForLoaded();
    expect(await screen.findByText('还没有大纲')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '外传' })).toBeInTheDocument();
    expect(
      screen.getByText('独立于主线的番外篇章：各自从第 1 章编号，不进主线的摘要链与进度。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建外传' })).toBeInTheDocument();
  });

  it('新建外传后写一章：章节出现在外传卡片里，不在主线列表里', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: '新建外传' }));
    const sheet = await screen.findByRole('dialog', { name: '新建外传' });
    await user.type(within(sheet).getByLabelText('名称'), '外传·青冥旧事');
    await user.type(within(sheet).getByLabelText('简介'), '二十年前的往事。');
    await user.click(within(sheet).getByRole('button', { name: '保存' }));

    const card = await screen.findByRole('region', { name: '外传·青冥旧事' });
    expect(within(card).getByText('0 章 · 0 字')).toBeInTheDocument();
    const [story] = await harness.repository.listSideStories(novel.id);
    expect(story).toMatchObject({ title: '青冥旧事', synopsis: '二十年前的往事。' });

    await user.click(within(card).getByRole('button', { name: '写新一章' }));
    const editor = await screen.findByRole('dialog', { name: '编辑外传《青冥旧事》第 1 章' });
    expect(within(editor).getByText('外传·青冥旧事 第 1 章')).toBeInTheDocument();
    expect(within(editor).getByLabelText('章节标题')).toHaveAttribute(
      'placeholder',
      '外传·青冥旧事 第 1 章',
    );
    await user.click(within(editor).getByRole('button', { name: '返回' }));

    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ sideStoryId: story!.id, index: 1, source: 'manual' });
    expect(
      await within(await screen.findByRole('region', { name: '外传·青冥旧事' })).findByRole(
        'button',
        { name: '继续写外传《青冥旧事》第 1 章' },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续写第 1 章' })).not.toBeInTheDocument();
  });

  it('「全书进度」不含外传字数与章数，卡片显示章数和字数', async () => {
    await harness.repository.createOutlineNode(novel.id, { title: '第一卷' });
    await harness.repository.createChapter(novel.id, { content: '一二三四五' });
    const story = await seedSide();
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, content: '甲乙丙' });
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, content: '丁戊' });

    renderPage();
    await waitForLoaded();

    const progress = (await screen.findByText('全书进度')).closest('section')!;
    expect(within(progress).getByText('5 字')).toBeInTheDocument();
    expect(within(progress).getByText('1 章')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '章节正文 1' })).toBeInTheDocument();

    const card = screen.getByRole('region', { name: '外传·青冥旧事' });
    expect(within(card).getByText('2 章 · 5 字')).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: '继续写外传《青冥旧事》第 2 章' }),
    ).toBeInTheDocument();
  });

  it('删除外传要二次确认，确认后级联删除章节，主线不受影响', async () => {
    const user = userEvent.setup();
    const main = await harness.repository.createChapter(novel.id, { content: '主线。' });
    const story = await seedSide();
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, content: '甲乙丙' });

    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: '编辑外传《青冥旧事》' }));
    const sheet = await screen.findByRole('dialog', { name: '编辑外传·青冥旧事' });
    await user.click(within(sheet).getByRole('button', { name: '删除这部外传' }));

    const confirm = await screen.findByRole('dialog', { name: '删除外传？' });
    expect(confirm).toHaveTextContent('外传·青冥旧事 及其 1 章（共 3 字）会被永久删除，无法恢复。');
    // 取消不删
    await user.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(await harness.repository.listSideStories(novel.id)).toHaveLength(1);

    await user.click(within(sheet).getByRole('button', { name: '删除这部外传' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: '删除外传？' })).getByRole('button', {
        name: '永久删除',
      }),
    );

    await waitFor(async () =>
      expect(await harness.repository.listSideStories(novel.id)).toEqual([]),
    );
    expect((await harness.repository.listChapters(novel.id)).map((chapter) => chapter.id)).toEqual([
      main.id,
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '外传·青冥旧事' })).not.toBeInTheDocument(),
    );
  });

  it('重名时错误显示在名称上，抽屉不关', async () => {
    const user = userEvent.setup();
    await seedSide();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: '新建外传' }));
    const sheet = await screen.findByRole('dialog', { name: '新建外传' });
    await user.type(within(sheet).getByLabelText('名称'), '番外：青冥旧事');
    await user.click(within(sheet).getByRole('button', { name: '保存' }));

    expect(await within(sheet).findByRole('alert')).toHaveTextContent('已有同名外传『青冥旧事』');
    expect(screen.getByRole('dialog', { name: '新建外传' })).toBeInTheDocument();
    expect(await harness.repository.listSideStories(novel.id)).toHaveLength(1);
  });

  it('编辑外传进展只读展示', async () => {
    const user = userEvent.setup();
    const story = await seedSide();
    await harness.repository.updateSideStory(story.id, { rollingSummary: '师父拜入青冥宗。' });
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: '编辑外传《青冥旧事》' }));
    const sheet = await screen.findByRole('dialog', { name: '编辑外传·青冥旧事' });
    expect(within(sheet).getByText('师父拜入青冥宗。')).toBeInTheDocument();
    expect(within(sheet).getByLabelText('名称')).toHaveValue('青冥旧事');

    await user.clear(within(sheet).getByLabelText('简介'));
    await user.type(within(sheet).getByLabelText('简介'), '新简介');
    await user.click(within(sheet).getByRole('button', { name: '保存' }));
    await waitFor(async () =>
      expect((await harness.repository.getSideStory(story.id))?.synopsis).toBe('新简介'),
    );
  });

  it('只有外传章节的作品也显示「导出」按钮', async () => {
    const story = await seedSide();
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, content: '甲乙丙' });
    renderPage();
    await waitForLoaded();
    expect(await screen.findByRole('button', { name: '导出' })).toBeInTheDocument();
    expect(screen.getByText('还没有章节')).toBeInTheDocument();
  });

  it('从外传卡片打开的编辑器拿到了对应的外传', async () => {
    const user = userEvent.setup();
    await harness.repository.createChapter(novel.id, { content: '主线第一章。' });
    await seedSide('渡口');
    const story = await seedSide();
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, content: '甲乙丙' });

    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: '继续写外传《青冥旧事》第 1 章' }));
    const editor = await screen.findByRole('dialog', { name: '编辑外传《青冥旧事》第 1 章' });
    expect(within(editor).getByText('外传·青冥旧事 第 1 章')).toBeInTheDocument();

    await user.click(within(editor).getByRole('button', { name: '删除本章' }));
    expect(await screen.findByRole('dialog', { name: '删除本章？' })).toHaveTextContent(
      '外传·青冥旧事 第 1 章的正文（3 字）会被永久删除，无法恢复。',
    );
  });
});
