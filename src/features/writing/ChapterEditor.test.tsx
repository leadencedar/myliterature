import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import { toLocalDate } from '@/domain/primitives';
import type { Category, Novel, OutlineNode } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { buildCreateProposal, buildReplaceProposal } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { useArchiveSettings } from './archiveSettings';
import { useIncompleteDrafts } from './incompleteDrafts';
import { WritingPage } from './WritingPage';

let harness: TestHarness;
let novel: Novel;
let charCategory: Category;
let chapterNode: OutlineNode;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  charCategory = (await harness.repository.listCategories(novel.id))[1]!;
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  // 「未完成稿留痕」是内存 store，用例之间不能串味
  useIncompleteDrafts.setState({ chapterIds: {} });
  // 默认关掉后台归档：M1 用例不测归档，M2 归档用例里再显式打开
  useArchiveSettings.setState({ autoArchive: false, extractEntries: true });
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });

  const volume = await harness.repository.createOutlineNode(novel.id, {
    title: '第一卷 风起',
    synopsis: '主角被追杀。',
  });
  chapterNode = await harness.repository.createOutlineNode(novel.id, {
    title: '第1章 雪夜',
    synopsis: '追兵临门，主角负伤。',
    parentId: volume.id,
    targetWords: 3000,
  });
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

/** 从大纲节点进入编辑器 */
async function enterEditor() {
  const user = userEvent.setup();
  renderPage();
  await waitForLoaded();
  await user.click(await screen.findByRole('button', { name: '编辑「第1章 雪夜」' }));
  await user.click(await screen.findByRole('button', { name: '写这一章' }));
  await screen.findByLabelText('章节正文');
  return user;
}

describe('从大纲进入写作', () => {
  it('叶子节点提供「写这一章」，有子节点的不提供', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: '编辑「第一卷 风起」' }));
    expect(screen.queryByRole('button', { name: '写这一章' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭' }));

    await user.click(await screen.findByRole('button', { name: '编辑「第1章 雪夜」' }));
    expect(screen.getByRole('button', { name: '写这一章' })).toBeInTheDocument();
  });

  it('首次进入会建章节、挂上大纲关联并把节点标为在写', async () => {
    await enterEditor();

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters).toHaveLength(1);
      expect(chapters[0]).toMatchObject({
        title: '第1章 雪夜',
        outlineNodeId: chapterNode.id,
        index: 1,
      });
    });

    const nodes = await harness.repository.listOutline(novel.id);
    expect(nodes.find((node) => node.id === chapterNode.id)?.status).toBe('drafting');
  });

  it('再次进入打开同一章，不重复创建', async () => {
    const user = await enterEditor();
    await user.click(screen.getByRole('button', { name: '返回' }));

    await user.click(await screen.findByRole('button', { name: '编辑「第1章 雪夜」' }));
    await user.click(await screen.findByRole('button', { name: '写这一章' }));
    await screen.findByLabelText('章节正文');

    expect(await harness.repository.listChapters(novel.id)).toHaveLength(1);
  });

  it('可以从章节列表继续写', async () => {
    const user = await enterEditor();
    await user.click(screen.getByRole('button', { name: '返回' }));

    await user.click(await screen.findByRole('button', { name: '继续写第 1 章' }));

    expect(await screen.findByLabelText('章节正文')).toBeInTheDocument();
  });
});

describe('编辑与自动保存', () => {
  it('输入后自动落盘，状态从「有改动」变「已保存」', async () => {
    const user = await enterEditor();

    await user.type(screen.getByLabelText('章节正文'), '雪落了整夜。');
    expect(screen.getByText('有改动')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument(), {
      timeout: 3000,
    });
    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters[0]?.content).toBe('雪落了整夜。');
  });

  it('实时显示字数', async () => {
    const user = await enterEditor();

    await user.type(screen.getByLabelText('章节正文'), '一二三四五');

    expect(screen.getByText('5 字')).toBeInTheDocument();
  });

  it('修改标题也会保存', async () => {
    const user = await enterEditor();

    const title = screen.getByLabelText('章节标题');
    await user.clear(title);
    await user.type(title, '雪夜追兵');

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.title).toBe('雪夜追兵');
    });
  });

  it('返回时立刻冲刷未落盘的改动，不等防抖', async () => {
    const user = await enterEditor();

    await user.type(screen.getByLabelText('章节正文'), '来不及等防抖就退出了。');
    await user.click(screen.getByRole('button', { name: '返回' }));

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe('来不及等防抖就退出了。');
    });
  });

  it('切换完成状态', async () => {
    const user = await enterEditor();

    await user.click(screen.getByRole('button', { name: '草稿' }));

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.status).toBe('done');
    });
    expect(screen.getByRole('button', { name: '已完成' })).toBeInTheDocument();
  });

  it('删除本章需二次确认并提示字数', async () => {
    const user = await enterEditor();
    await user.type(screen.getByLabelText('章节正文'), '一二三');
    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument(), { timeout: 3000 });

    await user.click(screen.getByRole('button', { name: '删除本章' }));
    expect(screen.getByText(/3 字）会被永久删除/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '永久删除' }));

    await waitFor(async () => {
      expect(await harness.repository.listChapters(novel.id)).toHaveLength(0);
    });
  });
});

describe('整章生成', () => {
  function stubStream(deltas: string[], finishReason?: string) {
    const extra = finishReason
      ? [`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`]
      : [];
    const fetchSpy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(sseResponse(textDeltaEvents(deltas, extra))),
    );
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  async function openGenerate() {
    const user = await enterEditor();
    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    return user;
  }

  it('生成前展示注入清单与预估 token', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: charCategory.id,
      title: '灵气',
      summary: '天地能量',
      pinned: true,
    });
    await openGenerate();

    const dialog = screen.getByRole('dialog', { name: '生成本章正文' });
    expect(within(dialog).getByText('作品信息与风格档案')).toBeInTheDocument();
    expect(within(dialog).getByText('核心设定 · 灵气')).toBeInTheDocument();
    expect(within(dialog).getByText(/大纲位置 · 第1章 雪夜/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/tokens/u)).toBeInTheDocument();
  });

  it('核心设定不可取消，并说明去哪里改', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: charCategory.id,
      title: '灵气',
      pinned: true,
    });
    await openGenerate();

    expect(screen.getByText(/核心设定（1 条）始终注入，不能取消/u)).toBeInTheDocument();
    // 核心设定不出现在可勾选的 chips 里
    expect(screen.queryByRole('button', { name: '灵气' })).not.toBeInTheDocument();
  });

  it('可以调整参与写作的设定，注入清单随之变化', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: charCategory.id,
      title: '林越',
      summary: '失忆剑客',
    });
    const user = await openGenerate();

    // 默认未勾选（节点没关联、也没有上一章）
    expect(screen.queryByText(/人物 · 林越/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '林越' }));

    expect(await screen.findByText('人物 · 林越')).toBeInTheDocument();
    expect(screen.getByText(/已选 1 项/u)).toBeInTheDocument();
  });

  it('默认预选大纲节点关联的条目', async () => {
    const entry = await harness.repository.createEntry(novel.id, {
      categoryId: charCategory.id,
      title: '林越',
      summary: '失忆剑客',
    });
    await harness.repository.updateOutlineNode(chapterNode.id, { linkedEntryIds: [entry.id] });

    await openGenerate();

    expect(screen.getByText('人物 · 林越')).toBeInTheDocument();
  });

  it('流式生成后进入可编辑预览，确认才写入正文', async () => {
    stubStream(['雪落了整夜，', '追兵在门外。']);
    const user = await openGenerate();

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    const preview = await screen.findByLabelText('生成结果（可直接修改）');
    expect(preview).toHaveValue('雪落了整夜，追兵在门外。');

    // 此刻正文还是空的
    let chapters = await harness.repository.listChapters(novel.id);
    expect(chapters[0]?.content).toBe('');

    await user.click(screen.getByRole('button', { name: '采用为正文' }));

    await waitFor(async () => {
      chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe('雪落了整夜，追兵在门外。');
    });
    expect(screen.getByLabelText('章节正文')).toHaveValue('雪落了整夜，追兵在门外。');
  });

  it('预览里可以先改再采用', async () => {
    stubStream(['原始生成内容']);
    const user = await openGenerate();
    await user.click(screen.getByRole('button', { name: '开始生成' }));

    const preview = await screen.findByLabelText('生成结果（可直接修改）');
    await user.clear(preview);
    await user.type(preview, '我改过的内容');
    await user.click(screen.getByRole('button', { name: '采用为正文' }));

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe('我改过的内容');
    });
  });

  it('正文已有内容时提供替换与追加两种方式', async () => {
    const user = await enterEditor();
    await user.type(screen.getByLabelText('章节正文'), '已经写好的开头。');
    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument(), { timeout: 3000 });

    stubStream(['新生成的段落。']);
    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');

    expect(screen.getByRole('button', { name: '替换正文' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '追加到正文末尾' }));

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe('已经写好的开头。\n\n新生成的段落。');
    });
  });

  it('请求按正文任务关闭思维链，并把稳定前缀放在 system', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: charCategory.id,
      title: '灵气',
      summary: '天地能量',
      pinned: true,
    });
    const fetchSpy = stubStream(['正文']);
    const user = await openGenerate();
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
      thinking?: { type: string };
      model: string;
      stream: boolean;
      max_tokens?: number;
    };
    const system = body.messages.find((message) => message.role === 'system')!.content;
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;

    // 稳定的东西进 system（作品信息、风格、核心设定）
    expect(system).toContain('归墟纪');
    expect(system).toContain('【必须遵守的核心设定】');
    expect(system).toContain('天地能量');
    // 易变的东西进 user（大纲位置、字数/场景结构要求）
    expect(userMessage).toContain('本章梗概：追兵临门，主角负伤。');
    expect(userMessage).toContain('本章目标约 3000 字，场景数供参考：1–2 场。');
    expect(userMessage).toContain('结尾收在梗概承诺的钩子上');
    // 输出上限按目标字数推导：ceil(3000×1.8)+800=6200
    expect(body.max_tokens).toBe(6200);
    // 正文创作关闭思维链、用常规模型、走流式
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(true);
  });

  it('额外要求会带进请求', async () => {
    const fetchSpy = stubStream(['正文']);
    const user = await openGenerate();

    await user.type(screen.getByLabelText('本章额外要求（可选）'), '多写对话');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages.find((m) => m.role === 'user')?.content).toContain('多写对话');
  });

  it('可以放弃生成结果回到设置', async () => {
    stubStream(['不要的内容']);
    const user = await openGenerate();
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');

    await user.click(screen.getByRole('button', { name: '放弃，重新设置' }));

    expect(screen.getByText('本次注入')).toBeInTheDocument();
    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters[0]?.content).toBe('');
  });

  it('接口报错时给出可操作提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'no balance' } }), { status: 402 }),
        ),
      ),
    );
    const user = await openGenerate();

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('余额不足');
  });

  it('未配置模型时禁用生成', async () => {
    useLlmSettings.getState().clearApiKey();
    await openGenerate();

    expect(screen.getByRole('button', { name: '开始生成' })).toBeDisabled();
    expect(screen.getByText(/需要先在「设置」里配置模型/u)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------- P0 截断稿留痕

  const SUMMARY_RESULT = {
    summary: '半章摘要。',
    keyEvents: ['写到一半'],
    appearingEntries: [],
    newOpenThreads: [],
    resolvedThreads: [],
    rollingSummary: '写到一半。',
  };

  /**
   * 按请求的 stream 字段分流：流式正文返回可截断的 SSE，非流式的摘要返回合法 JSON。
   * 采用截断稿后切「已完成」会自动弹摘要抽屉，不 mock 它会让用例里出现无谓的报错。
   */
  function stubChapterLlm(options: { deltas: string[]; finishReason?: string }) {
    const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (!body.stream) {
        return Promise.resolve(jsonResponse(completion(JSON.stringify(SUMMARY_RESULT))));
      }
      const extra = options.finishReason
        ? [
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: options.finishReason }],
            })}\n\n`,
          ]
        : [];
      return Promise.resolve(sseResponse(textDeltaEvents(options.deltas, extra)));
    });
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  const INCOMPLETE_HINT = /本章由未完成生成稿采用，可能缺少结尾/u;

  /** 点采用；不完整稿会弹二次确认，顺手确认 */
  async function adoptGenerated(user: ReturnType<typeof userEvent.setup>, label = '采用为正文') {
    await user.click(screen.getByRole('button', { name: label }));
    const confirm = screen.queryByRole('dialog', { name: '仍要采用不完整内容？' });
    if (confirm) await user.click(within(confirm).getByRole('button', { name: '仍要采用' }));
  }

  /** 生成一次截断稿并采用，返回仍在编辑器里的 user */
  async function adoptTruncated() {
    stubChapterLlm({ deltas: ['只写了一半的正文。'], finishReason: 'length' });
    const user = await enterEditor();
    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    expect(screen.getByText('生成未完成')).toBeInTheDocument();
    await adoptGenerated(user);
    return user;
  }

  it('采用截断稿后编辑器标题栏下出现会话内提示，点「知道了」关闭', async () => {
    const user = await adoptTruncated();

    expect(await screen.findByText(INCOMPLETE_HINT)).toBeInTheDocument();
    // 半章确实写入正文：提示不是拦写，而是留痕
    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe('只写了一半的正文。');
    });

    await user.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByText(INCOMPLETE_HINT)).not.toBeInTheDocument();
  });

  it('切到「已完成」时清除未完成提示', async () => {
    const user = await adoptTruncated();
    expect(await screen.findByText(INCOMPLETE_HINT)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '草稿' }));

    expect(screen.queryByText(INCOMPLETE_HINT)).not.toBeInTheDocument();
    // design §6.6：标记完成不再自动弹摘要面板
    expect(screen.queryByRole('dialog', { name: '本章摘要' })).not.toBeInTheDocument();
  });

  it('完整采用不出现提示，并清掉之前留下的提示', async () => {
    stubChapterLlm({ deltas: ['只写了一半的正文。'], finishReason: 'length' });
    const user = await enterEditor();
    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    await adoptGenerated(user);
    expect(await screen.findByText(INCOMPLETE_HINT)).toBeInTheDocument();

    // 第二次生成完整稿并替换正文 → 之前的提醒要清掉
    stubChapterLlm({ deltas: ['这次写完整了。'] });
    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    await adoptGenerated(user, '替换正文');

    await waitFor(() => expect(screen.queryByText(INCOMPLETE_HINT)).not.toBeInTheDocument());
  });

  it('完整采用后不出现提示', async () => {
    stubChapterLlm({ deltas: ['完整的一章正文。'] });
    const user = await enterEditor();
    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    await adoptGenerated(user);

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe('完整的一章正文。');
    });
    expect(screen.queryByText(INCOMPLETE_HINT)).not.toBeInTheDocument();
  });

  it('已完成的章节采用截断稿：状态退回草稿并落盘、提示保留、不自动触发摘要', async () => {
    const existing = await harness.repository.createChapter(novel.id, {
      title: '第1章 雪夜',
      content: '已经写完的一章。',
      outlineNodeId: chapterNode.id,
      status: 'done',
    });
    stubChapterLlm({ deltas: ['只写了一半的正文。'], finishReason: 'length' });
    const user = await enterEditor();
    // 进编辑器时这一章确实是「已完成」
    expect(screen.getByRole('button', { name: '已完成' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    await adoptGenerated(user, '替换正文');

    // 与二次确认文案「采用后本章仍是草稿」一致，也避免「已完成但只有半章」
    expect(await screen.findByText(INCOMPLETE_HINT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '草稿' })).toBeInTheDocument();
    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters.find((item) => item.id === existing.id)?.status).toBe('draft');
    });
    // 摘要只在作者重新标完成时生成，退回草稿这一步不该弹摘要抽屉
    expect(screen.queryByRole('dialog', { name: '本章摘要' })).not.toBeInTheDocument();
  });

  it('草稿章节采用截断稿：状态保持草稿', async () => {
    await adoptTruncated();

    expect(await screen.findByText(INCOMPLETE_HINT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '草稿' })).toBeInTheDocument();
    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.status).toBe('draft');
    });
  });
});

describe('续写时的上下文', () => {
  it('第二章会带上第一章的摘要与结尾原文', async () => {
    // 先写好第一章并给它一份摘要
    const first = await harness.repository.createChapter(novel.id, {
      title: '第1章 雪夜',
      content: '前面很多内容。最后一句是这样结尾的。',
      outlineNodeId: chapterNode.id,
      status: 'done',
    });
    await harness.repository.upsertSummary(novel.id, first.id, {
      summary: '主角负伤逃入雪山',
      keyEvents: ['遭遇追兵'],
      openThreads: ['黑衣人的身份'],
    });
    const secondNode = await harness.repository.createOutlineNode(novel.id, {
      title: '第2章 旧识',
      synopsis: '雪山木屋遇到故人。',
      parentId: chapterNode.parentId,
    });

    const fetchSpy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(sseResponse(textDeltaEvents(['第二章正文']))),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: '编辑「第2章 旧识」' }));
    await user.click(await screen.findByRole('button', { name: '写这一章' }));
    await screen.findByLabelText('章节正文');
    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');

    // 注入清单里能看到摘要与结尾原文
    expect(screen.getByText('第 1 章摘要')).toBeInTheDocument();
    expect(screen.getByText('第 1 章结尾原文')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;

    expect(userMessage).toContain('主角负伤逃入雪山');
    expect(userMessage).toContain('尚未收束的伏笔：黑衣人的身份');
    expect(userMessage).toContain('最后一句是这样结尾的。');
    expect(secondNode.id).toBeTruthy();
  });
});

describe('产出自动记入计划', () => {
  const today = toLocalDate();

  async function logToday() {
    const logs = await harness.repository.listDailyLogs(novel.id, { from: today, to: today });
    return logs[0];
  }

  it('写入的字数自动累计到当日日志', async () => {
    const user = await enterEditor();

    await user.type(screen.getByLabelText('章节正文'), '雪落了整夜。');
    await waitFor(async () => {
      expect((await logToday())?.words).toBe(6);
    });
  });

  it('删字不倒扣当日产出', async () => {
    const user = await enterEditor();

    await user.type(screen.getByLabelText('章节正文'), '一二三四五六七八');
    await waitFor(async () => {
      expect((await logToday())?.words).toBe(8);
    });

    await user.clear(screen.getByLabelText('章节正文'));
    await user.type(screen.getByLabelText('章节正文'), '一二');

    // 删掉的字不是没写过，只是被改掉了，没有理由从今天的产出里扣回去
    await waitFor(async () => {
      expect((await logToday())?.words).toBe(8);
    });
  });

  it('标记完成记一章，来回切换不重复计数', async () => {
    const user = await enterEditor();
    await user.type(screen.getByLabelText('章节正文'), '写完了。');

    await user.click(screen.getByRole('button', { name: '草稿' }));
    await waitFor(async () => {
      expect((await logToday())?.chaptersCompleted).toBe(1);
    });

    // design §6.6：标记完成不再自动弹摘要面板，直接继续用状态行
    await user.click(await screen.findByRole('button', { name: '已完成' }));
    await user.click(await screen.findByRole('button', { name: '草稿' }));

    await waitFor(async () => {
      expect((await logToday())?.chaptersCompleted).toBe(1);
    });
  });

  it('只改标题不产生空的日志记录', async () => {
    const user = await enterEditor();

    const title = screen.getByLabelText('章节标题');
    await user.clear(title);
    await user.type(title, '雪夜');

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.title).toBe('雪夜');
    });
    expect(await logToday()).toBeUndefined();
  });
});

describe('桌面端键盘', () => {
  /** 在 document 上派发一次按键，返回事件本身以便检查 defaultPrevented */
  function press(key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    document.dispatchEvent(event);
    return event;
  }

  it('Cmd+S 拦掉浏览器的「保存网页」并立即落盘', async () => {
    const user = await enterEditor();
    await user.type(screen.getByLabelText('章节正文'), '还没到防抖时间就想保存。');

    const event = press('s', { metaKey: true });
    // 不 preventDefault 的话浏览器会弹出保存网页对话框，那才是真的打断写作
    expect(event.defaultPrevented).toBe(true);

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe('还没到防抖时间就想保存。');
    });
  });

  it('Ctrl+S 同样生效', async () => {
    const user = await enterEditor();
    await user.type(screen.getByLabelText('章节正文'), 'Windows 上按的是 Ctrl。');

    expect(press('s', { ctrlKey: true }).defaultPrevented).toBe(true);

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe('Windows 上按的是 Ctrl。');
    });
  });

  it('不带修饰键的 s 是正常输入，不被拦下', async () => {
    await enterEditor();
    expect(press('s').defaultPrevented).toBe(false);
  });

  it('Esc 不关闭编辑器：中文输入法要用它取消候选词', async () => {
    await enterEditor();

    press('Escape');

    // 绑上 Esc 就等于写中文时随机退出编辑器
    expect(await screen.findByLabelText('章节正文')).toBeInTheDocument();
  });

  it('离开编辑器后不再监听快捷键', async () => {
    const user = await enterEditor();
    await user.click(screen.getByRole('button', { name: '返回' }));
    await waitFor(() => expect(screen.queryByLabelText('章节正文')).not.toBeInTheDocument());

    // 监听器没解绑的话会一直拦下整个应用的 Cmd+S
    expect(press('s', { metaKey: true }).defaultPrevented).toBe(false);
  });
});

describe('单章译成中文', () => {
  const EN = 'Ashford shouldered the pack before dawn and did not look back at the village.';
  const ZH = '阿什福德在黎明前背起行囊，没有回头看那座村子。';

  function stubTranslation(text: string, glossary = 'Ashford => 阿什福德') {
    const spy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(sseResponse(textDeltaEvents([`${text}\n---译名表---\n${glossary}`]))),
    );
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  /** 进编辑器并把正文换成英文 */
  async function enterWithEnglish() {
    const user = await enterEditor();
    const textarea = screen.getByLabelText('章节正文');
    await user.click(textarea);
    await user.clear(textarea);
    await user.paste(EN);
    return user;
  }

  it('中文正文看不到翻译入口', async () => {
    const user = await enterEditor();
    await user.click(screen.getByLabelText('章节正文'));
    await user.paste('他没有回头。这一章从头到尾都是中文，不该出现翻译按钮。');

    expect(screen.queryByRole('button', { name: '译成中文' })).not.toBeInTheDocument();
  });

  it('空白新章节也不该挂着翻译按钮', async () => {
    await enterEditor();
    // 空内容的语种是 unknown，不能当成「不是中文」就提示翻译
    expect(screen.getByLabelText('章节正文')).toHaveValue('');
    expect(screen.queryByRole('button', { name: '译成中文' })).not.toBeInTheDocument();
  });

  it('英文正文才出现「译成中文」', async () => {
    await enterWithEnglish();
    expect(await screen.findByRole('button', { name: '译成中文' })).toBeInTheDocument();
  });

  it('译文替换正文，原文留一份，且可以一键撤回', async () => {
    const user = await enterWithEnglish();
    stubTranslation(ZH);

    await user.click(await screen.findByRole('button', { name: '译成中文' }));
    // 编辑器本身也是 role="dialog"，用抽屉标题限定范围
    const dialog = screen.getByRole('dialog', { name: '译成中文' });
    await user.click(within(dialog).getByRole('button', { name: '翻译本章' }));

    const preview = await screen.findByLabelText('译文（可直接修改）');
    expect(preview).toHaveValue(ZH);
    // 本章译名列出来，供用户回填到条目别名里
    expect(screen.getByText('Ashford → 阿什福德')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '采用译文' }));

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe(ZH);
      // 翻译不可逆，原句必须留得住
      expect(chapters[0]?.sourceContent).toBe(EN);
      expect(chapters[0]?.sourceLanguage).toBe('en');
    });

    // 译得不对时一键退回外文原稿
    await user.click(screen.getByRole('button', { name: /撤销 AI 改动/u }));
    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe(EN);
    });
  });

  it('采用前可以直接改译文', async () => {
    const user = await enterWithEnglish();
    stubTranslation(ZH);

    await user.click(await screen.findByRole('button', { name: '译成中文' }));
    await user.click(screen.getByRole('button', { name: '翻译本章' }));

    const preview = await screen.findByLabelText('译文（可直接修改）');
    await user.clear(preview);
    await user.paste('我自己改过的译法。');
    await user.click(screen.getByRole('button', { name: '采用译文' }));

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe('我自己改过的译法。');
    });
  });

  it('放弃则什么都不动', async () => {
    const user = await enterWithEnglish();
    stubTranslation(ZH);

    await user.click(await screen.findByRole('button', { name: '译成中文' }));
    await user.click(screen.getByRole('button', { name: '翻译本章' }));
    await screen.findByLabelText('译文（可直接修改）');
    await user.click(screen.getByRole('button', { name: '放弃' }));

    expect(screen.getByLabelText('章节正文')).toHaveValue(EN);
  });

  it('译过的章节入口变「重译」，并提示会覆盖', async () => {
    const user = await enterWithEnglish();
    stubTranslation(ZH);

    await user.click(await screen.findByRole('button', { name: '译成中文' }));
    await user.click(screen.getByRole('button', { name: '翻译本章' }));
    await screen.findByLabelText('译文（可直接修改）');
    await user.click(screen.getByRole('button', { name: '采用译文' }));

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.sourceContent).toBe(EN);
    });

    // 正文已是中文，但译过一次之后入口要留着，方便重译
    await user.click(screen.getByRole('button', { name: '重译' }));
    expect(await screen.findByText(/再译一遍会覆盖现有译文/u)).toBeInTheDocument();
  });

  it('模型没给译文时报错，不动正文', async () => {
    const user = await enterWithEnglish();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(textDeltaEvents([' '])))),
    );

    await user.click(await screen.findByRole('button', { name: '译成中文' }));
    await user.click(screen.getByRole('button', { name: '翻译本章' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('模型没有返回译文');
    expect(screen.getByLabelText('章节正文')).toHaveValue(EN);
  });
});

describe('撤销翻译后不该再显示「重译」', () => {
  const EN = 'Ashford shouldered the pack before dawn and did not look back at the village.';
  const ZH = '阿什福德在黎明前背起行囊，没有回头看那座村子。';

  it('撤回译文后原文备份一并清掉', async () => {
    const user = await enterEditor();
    const textarea = screen.getByLabelText('章节正文');
    await user.click(textarea);
    await user.clear(textarea);
    await user.paste(EN);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(textDeltaEvents([ZH])))),
    );

    await user.click(await screen.findByRole('button', { name: '译成中文' }));
    await user.click(
      within(screen.getByRole('dialog', { name: '译成中文' })).getByRole('button', {
        name: '翻译本章',
      }),
    );
    await screen.findByLabelText('译文（可直接修改）');
    await user.click(screen.getByRole('button', { name: '采用译文' }));

    // 采用后立刻变「重译」，不等上游查询刷新回来
    expect(await screen.findByRole('button', { name: '重译' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /撤销 AI 改动/u }));

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters[0]?.content).toBe(EN);
      // 否则这一章会同时是「正文为原文」和「译过一次」
      expect(chapters[0]?.sourceContent).toBe('');
      expect(chapters[0]?.sourceLanguage).toBe('');
    });
    expect(screen.queryByRole('button', { name: '重译' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '译成中文' })).toBeInTheDocument();
  });
});

describe('外传章节', () => {
  async function enterSideEditor() {
    await harness.repository.updateNovel(novel.id, { rollingSummary: '主线：林越已离开雪山。' });
    const story = await harness.repository.createSideStory(novel.id, {
      title: '青冥旧事',
      synopsis: '二十年前的往事。',
    });
    await harness.repository.updateSideStory(story.id, { rollingSummary: '师父拜入青冥宗。' });
    await harness.repository.createChapter(novel.id, {
      sideStoryId: story.id,
      content: '第一章。',
    });
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, content: '' });

    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: '继续写外传《青冥旧事》第 2 章' }));
    const editor = await screen.findByRole('dialog', { name: '编辑外传《青冥旧事》第 2 章' });
    return { user, editor };
  }

  it('标题行和 aria-label 带「外传·X 第 N 章」', async () => {
    const { editor } = await enterSideEditor();
    expect(within(editor).getByText('外传·青冥旧事 第 2 章')).toBeInTheDocument();
    expect(within(editor).getByLabelText('章节标题')).toHaveAttribute(
      'placeholder',
      '外传·青冥旧事 第 2 章',
    );
  });

  it('生成面板注入外传说明块，默认没有主线进展；打开开关后出现', async () => {
    const { user, editor } = await enterSideEditor();
    await user.click(within(editor).getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    const dialog = screen.getByRole('dialog', { name: '生成本章正文' });

    expect(within(dialog).getByText('外传·青冥旧事 说明')).toBeInTheDocument();
    expect(within(dialog).getByText('外传进展摘要')).toBeInTheDocument();
    expect(within(dialog).getByText('外传第 1 章结尾原文')).toBeInTheDocument();
    expect(within(dialog).queryByText('主线全书进展（参考）')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('全书进展摘要')).not.toBeInTheDocument();

    const toggle = within(dialog).getByLabelText('参考主线进展');
    expect(toggle).not.toBeChecked();
    expect(
      within(dialog).getByText(
        '外传发生在主线之后、需要知道主线走到哪时再打开。前传打开它，人物容易提前知道后来的事。',
      ),
    ).toBeInTheDocument();
    await user.click(toggle);
    expect(within(dialog).getByText('主线全书进展（参考）')).toBeInTheDocument();

    const fetchSpy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(sseResponse(textDeltaEvents(['外传正文。']))),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await user.click(within(dialog).getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;
    expect(userMessage).toContain('【本章属于外传《青冥旧事》】');
    expect(userMessage).toContain('【外传至此】\n师父拜入青冥宗。');
    expect(userMessage).toContain(
      '【主线进展（仅供参考，外传不必衔接它）】\n主线：林越已离开雪山。',
    );
  });

  it('外传章节的字数照常记入当日日志', async () => {
    const { editor } = await enterSideEditor();
    const today = toLocalDate();

    const user = userEvent.setup();
    await user.type(within(editor).getByLabelText('章节正文'), '雪落了整夜。');
    await waitFor(async () => {
      const logs = await harness.repository.listDailyLogs(novel.id, { from: today, to: today });
      expect(logs[0]?.words).toBe(6);
    });
  });

  it('主线章节的生成面板没有「参考主线进展」开关', async () => {
    await harness.repository.updateNovel(novel.id, { rollingSummary: '主线进展。' });
    const user = await enterEditor();
    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    expect(screen.queryByLabelText('参考主线进展')).not.toBeInTheDocument();
  });
});

describe('标记完成后的后台归档（S3）', () => {
  const ARCHIVE_RESULT = {
    entries: [],
    summary: '本章摘要。',
    keyEvents: ['事件'],
    appearingEntries: [],
    newOpenThreads: ['新伏笔'],
    resolvedThreads: [],
    rollingSummary: '截至本章的进展。',
  };

  /** mock 归档用 extract-settings 响应，并记录请求体 */
  function stubArchive(result: unknown = ARCHIVE_RESULT) {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return Promise.resolve(jsonResponse(completion(JSON.stringify(result))));
      }),
    );
    return bodies;
  }

  async function markDoneWithContent(
    user: ReturnType<typeof userEvent.setup>,
    content = '雪落了整夜，追兵在门外。',
  ) {
    await user.type(screen.getByLabelText('章节正文'), content);
    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument(), { timeout: 3000 });
    await user.click(screen.getByRole('button', { name: '草稿' }));
  }

  it('标记完成触发一次后台归档，不弹摘要面板；查看并关闭不写库', async () => {
    useArchiveSettings.setState({ autoArchive: true, extractEntries: true });
    const bodies = stubArchive();
    const user = await enterEditor();
    await markDoneWithContent(user);

    // design §6.6：不再自动弹摘要面板
    expect(screen.queryByRole('dialog', { name: '本章摘要' })).not.toBeInTheDocument();
    expect(await screen.findByText(/本章摘要与设定已生成/)).toBeInTheDocument();
    // M2.1：摘要 create + 进展 replace = 2 项，计数要说全
    expect(screen.getByText(/2 项待确认（含摘要、进展、条目）/)).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    // 归档用的是编辑器里的最新正文，不必等防抖保存
    const body = bodies[0] as { messages: { role: string; content: string }[] };
    expect(body.messages.find((message) => message.role === 'user')?.content).toContain(
      '雪落了整夜',
    );

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    expect(within(dialog).getByRole('button', { name: /采用本批/u })).toBeInTheDocument();
    // M2.1-S2b：进展 replace 不再默认忽略（每章都有，否则摘要链会漏），无「默认不选」提示
    expect(within(dialog).queryByText(/本批含/u)).not.toBeInTheDocument();
    expect(within(dialog).getByText('本批伏笔流水')).toBeInTheDocument();
    // 无历史伏笔：现存就是本章新埋，明细不重复，计数行注明
    expect(
      within(dialog).getByText(/第 1 章：新埋 1 \/ 收束 0 \/ 现存 1（现存均为本章新埋）/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('新埋：新伏笔')).toBeInTheDocument();
    expect(within(dialog).queryByText('现存：新伏笔')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/若误收束，在摘要的「未收束伏笔」里加回/u)).toBeInTheDocument();

    // 关闭不写任何东西
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    const chapterId = (await harness.repository.listChapters(novel.id))[0]!.id;
    expect(await harness.repository.getSummaryByChapter(chapterId)).toBeUndefined();
    expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe('');
  });

  it('普通归档批次默认两项都选中，采用本批后摘要与进展都更新', async () => {
    useArchiveSettings.setState({ autoArchive: true });
    stubArchive();
    const user = await enterEditor();
    await markDoneWithContent(user);
    await screen.findByText(/本章摘要与设定已生成/);

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    // 摘要 create + 进展 replace 都默认选中（安全默认只针对已有知识条目）
    expect(within(dialog).queryByText('已标记为忽略')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /采用本批（2）/ }));

    const chapterId = (await harness.repository.listChapters(novel.id))[0]!.id;
    // 摘要/进展是逐条落库的：摘要先到不代表进展写完了，三条断言放进同一个 waitFor
    await waitFor(async () => {
      expect(await harness.repository.getSummaryByChapter(chapterId)).toMatchObject({
        summary: '本章摘要。',
      });
      expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe(
        '截至本章的进展。',
      );
      expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(
        0,
      );
    });
    await waitFor(() => expect(screen.queryByText(/本章摘要与设定已生成/)).not.toBeInTheDocument());
  });

  it('已有摘要时 replace 默认选中：采用本批后旧摘要被更新', async () => {
    useArchiveSettings.setState({ autoArchive: true });
    // 先建好本章与旧摘要，归档会产出「摘要 replace + 进展 replace」两项
    const existing = await harness.repository.createChapter(novel.id, {
      title: '第1章 雪夜',
      content: '雪落了整夜。',
      outlineNodeId: chapterNode.id,
    });
    await harness.repository.upsertSummary(novel.id, existing.id, {
      summary: '旧摘要',
      keyEvents: ['旧事件'],
    });
    stubArchive();
    const user = await enterEditor();
    await user.click(screen.getByRole('button', { name: '草稿' }));
    await screen.findByText(/本章摘要与设定已生成/);

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    // 摘要/进展的 replace 不是「已有知识条目」，默认选中
    expect(within(dialog).queryByText('已标记为忽略')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /采用本批（2）/ }));

    // 同样：摘要 replace 先落库时进展 replace 可能还在写，三条断言一起等
    await waitFor(async () => {
      expect(await harness.repository.getSummaryByChapter(existing.id)).toMatchObject({
        summary: '本章摘要。',
      });
      expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe(
        '截至本章的进展。',
      );
      expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(
        0,
      );
    });
  });

  /** 造一个「归档会合并已有条目」的批次：预建裴照 + extract 返回同名变更 */
  async function seedMergeArchive() {
    const existingEntry = await harness.repository.createEntry(novel.id, {
      categoryId: charCategory.id,
      title: '裴照',
      summary: '旧识',
      fields: { identity: '旧身份' },
    });
    stubArchive({
      entries: [
        {
          categoryName: '人物',
          title: '裴照',
          aliases: [],
          summary: '旧识',
          fields: [{ key: 'identity', value: '新身份' }],
        },
      ],
      summary: '本章摘要。',
      keyEvents: ['事件'],
      appearingEntries: ['裴照'],
      newOpenThreads: ['新伏笔'],
      resolvedThreads: ['旧伏笔'],
      rollingSummary: '截至本章的进展。',
    });
    return existingEntry;
  }

  it('只有知识条目的合并默认不选：摘要/进展照常写入，旧设定不被覆盖', async () => {
    useArchiveSettings.setState({ autoArchive: true });
    const existingEntry = await seedMergeArchive();
    const user = await enterEditor();
    await markDoneWithContent(user);
    await screen.findByText(/本章摘要与设定已生成/);
    // 摘要 create + 进展 replace + 条目 merge = 3 项
    expect(screen.getByText(/3 项待确认（含摘要、进展、条目）/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    // 安全提示动态化：本批共 3 项，其中 1 条合并默认不选，当前跳过 1 条 → 将写入 2 项
    expect(
      within(dialog).getByText(
        /本批共 3 项，其中 1 条对已有条目的合并\/替换默认不选；当前还有 1 条跳过（底部「采用本批」只计入将写入的 2 项）/u,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByText('已标记为忽略')).toHaveLength(1);
    // 有历史伏笔（收束 1 条）时仍显示三类，不做「现存均为本章新埋」去重
    expect(within(dialog).getByText(/第 1 章：新埋 1 \/ 收束 1 \/ 现存 1/u)).toBeInTheDocument();
    expect(within(dialog).queryByText(/（现存均为本章新埋）/u)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/现存：新伏笔/u)).toBeInTheDocument();

    // 摘要 create + 进展 replace 默认选中，直接采用；条目合并仍留在 pending
    await user.click(within(dialog).getByRole('button', { name: /采用本批（2）/ }));

    const chapterId = (await harness.repository.listChapters(novel.id))[0]!.id;
    await waitFor(async () => {
      expect(await harness.repository.getSummaryByChapter(chapterId)).toMatchObject({
        summary: '本章摘要。',
      });
    });
    expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe('截至本章的进展。');
    const entry = (await harness.repository.listEntries(novel.id)).find(
      (item) => item.id === existingEntry.id,
    );
    expect(entry?.fields.identity).toBe('旧身份');
    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.target).toBe('knowledgeEntry');
  });

  it('条目合并点「纳入本批」后才随本批写入，提示变为已全部纳入', async () => {
    useArchiveSettings.setState({ autoArchive: true });
    const existingEntry = await seedMergeArchive();
    const user = await enterEditor();
    await markDoneWithContent(user);
    await screen.findByText(/本章摘要与设定已生成/);

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    await user.click(within(dialog).getByRole('button', { name: '纳入本批' }));

    // 全部纳入后安全提示与底部计数同步
    expect(
      within(dialog).getByText(
        /本批共 3 项，其中 1 条对已有条目的合并\/替换已全部纳入（将写入 3 项）/u,
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /采用本批（3）/ }));

    await waitFor(async () => {
      const entry = (await harness.repository.listEntries(novel.id)).find(
        (item) => item.id === existingEntry.id,
      );
      expect(entry?.fields.identity).toBe('新身份');
    });
    expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe('截至本章的进展。');
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(0);
  });

  it('安全提示随「纳入本批」动态更新：部分跳过 → 已全部纳入', async () => {
    useArchiveSettings.setState({ autoArchive: true });
    // 两条已有条目都发生变更 → 2 条 merge 默认不选
    await harness.repository.createEntry(novel.id, {
      categoryId: charCategory.id,
      title: '裴照',
      fields: { identity: '旧身份' },
    });
    await harness.repository.createEntry(novel.id, {
      categoryId: charCategory.id,
      title: '灵潮',
      fields: { identity: '旧潮' },
    });
    stubArchive({
      entries: [
        {
          categoryName: '人物',
          title: '裴照',
          aliases: [],
          summary: '',
          fields: [{ key: 'identity', value: '新身份' }],
        },
        {
          categoryName: '人物',
          title: '灵潮',
          aliases: [],
          summary: '',
          fields: [{ key: 'identity', value: '新潮' }],
        },
      ],
      summary: '本章摘要。',
      keyEvents: ['事件'],
      appearingEntries: [],
      newOpenThreads: [],
      resolvedThreads: [],
      rollingSummary: '截至本章的进展。',
    });
    const user = await enterEditor();
    await markDoneWithContent(user);
    await screen.findByText(/本章摘要与设定已生成/);
    // 摘要 + 进展 + 2 条条目合并 = 4 项
    expect(screen.getByText(/4 项待确认（含摘要、进展、条目）/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    expect(
      within(dialog).getByText(
        /本批共 4 项，其中 2 条对已有条目的合并\/替换默认不选；当前还有 2 条跳过（底部「采用本批」只计入将写入的 2 项）/u,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '采用本批（2）' })).toBeInTheDocument();

    // 纳入一条：跳过数减一，将写入加一
    await user.click(within(dialog).getAllByRole('button', { name: '纳入本批' })[0]!);
    expect(
      within(dialog).getByText(/当前还有 1 条跳过（底部「采用本批」只计入将写入的 3 项）/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '采用本批（3）' })).toBeInTheDocument();

    // 全部纳入
    await user.click(within(dialog).getByRole('button', { name: '纳入本批' }));
    expect(
      within(dialog).getByText(
        /本批共 4 项，其中 2 条对已有条目的合并\/替换已全部纳入（将写入 4 项）/u,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '采用本批（4）' })).toBeInTheDocument();
  });

  it('自动归档关闭时不调用模型，只提示可手动补摘要', async () => {
    useArchiveSettings.setState({ autoArchive: false });
    const bodies = stubArchive();
    const user = await enterEditor();
    await markDoneWithContent(user);

    expect(await screen.findByText(/自动归档已关闭/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '本章摘要' })).not.toBeInTheDocument();
    expect(bodies).toHaveLength(0);

    // 手动入口不受影响
    await user.click(screen.getByRole('button', { name: '补摘要' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要' });
    expect(within(dialog).getByRole('button', { name: '提炼本章摘要' })).toBeInTheDocument();
  });

  it('未配置模型时不自动归档，提示去设置', async () => {
    useArchiveSettings.setState({ autoArchive: true });
    useLlmSettings.getState().clearApiKey();
    const bodies = stubArchive();
    const user = await enterEditor();
    await markDoneWithContent(user);

    expect(await screen.findByText(/未配置模型/)).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it('归档失败显示原因；重试成功后恢复', async () => {
    useArchiveSettings.setState({ autoArchive: true });
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        if (call === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: '服务暂时不可用' } }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(jsonResponse(completion(JSON.stringify(ARCHIVE_RESULT))));
      }),
    );
    const user = await enterEditor();
    await markDoneWithContent(user);

    expect(await screen.findByText(/本章摘要与设定生成失败/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText(/本章摘要与设定已生成/)).toBeInTheDocument();
  });

  it('打开已有 pending 档案的已完成章节：显示待确认，不重跑', async () => {
    useArchiveSettings.setState({ autoArchive: true });
    const existing = await harness.repository.createChapter(novel.id, {
      title: '第1章 雪夜',
      content: '雪落了整夜。',
      outlineNodeId: chapterNode.id,
      status: 'done',
    });
    await harness.repository.createProposals([
      buildCreateProposal({
        novelId: novel.id,
        batchId: 'batch-existing',
        origin: 'extract',
        target: 'chapterSummary',
        label: '第 1 章摘要',
        specs: fieldSpecsFor('chapterSummary'),
        payload: {
          chapterId: existing.id,
          summary: '上次归档的摘要',
          keyEvents: ['事件'],
          appearingEntryIds: [],
          openThreads: [],
        },
      }),
      // 进展 replace 也是本批 pending：挂载恢复要把它算进「2 项」
      buildReplaceProposal({
        novelId: novel.id,
        batchId: 'batch-existing',
        origin: 'extract',
        target: 'novel',
        label: '全书进展摘要',
        specs: fieldSpecsFor('novel'),
        targetId: novel.id,
        current: { rollingSummary: '' },
        payload: { rollingSummary: '上次归档的进展' },
      }),
    ]);
    const bodies = stubArchive();
    const user = await enterEditor();

    expect(await screen.findByText(/本章摘要与设定已生成/)).toBeInTheDocument();
    // 摘要 create + 进展 replace = 2 项；挂载恢复也要按整批计数
    expect(screen.getByText(/2 项待确认（含摘要、进展、条目）/)).toBeInTheDocument();
    expect(bodies).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要与设定待确认' });
    // 没有审计（旧批/清缓存）：一行 fallback，不阻塞收件箱
    expect(within(dialog).getByText('本批没有伏笔流水记录。')).toBeInTheDocument();
    // 进展 replace 不属于「已有知识条目」，默认选中，无安全提示
    expect(within(dialog).queryByText(/本批含/u)).not.toBeInTheDocument();
  });

  it('同节点下章节全部完成时提示大纲节点可标完成，点击才写', async () => {
    useArchiveSettings.setState({ autoArchive: false });
    const user = await enterEditor();
    await markDoneWithContent(user);

    expect(await screen.findByText(/大纲节点「第1章 雪夜」可以标为完成/)).toBeInTheDocument();
    const before = (await harness.repository.listOutline(novel.id)).find(
      (item) => item.id === chapterNode.id,
    );
    expect(before?.status).not.toBe('done');

    await user.click(screen.getByRole('button', { name: '标记完成' }));
    await waitFor(async () => {
      const after = (await harness.repository.listOutline(novel.id)).find(
        (item) => item.id === chapterNode.id,
      );
      expect(after?.status).toBe('done');
    });
    expect(screen.queryByText(/可以标为完成/)).not.toBeInTheDocument();
  });

  it('大纲完成提示可以「知道了」隐藏，且不写节点状态', async () => {
    useArchiveSettings.setState({ autoArchive: false });
    const user = await enterEditor();
    await markDoneWithContent(user);

    expect(await screen.findByText(/大纲节点「第1章 雪夜」可以标为完成/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '知道了' }));

    expect(screen.queryByText(/可以标为完成/)).not.toBeInTheDocument();
    const node = (await harness.repository.listOutline(novel.id)).find(
      (item) => item.id === chapterNode.id,
    );
    expect(node?.status).not.toBe('done');
  });

  it('连点完成不会重复发起归档（module 级 in-flight 去重）', async () => {
    useArchiveSettings.setState({ autoArchive: true });
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchSpy = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchSpy);

    const user = await enterEditor();
    await user.type(screen.getByLabelText('章节正文'), '雪落了整夜。');
    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument(), { timeout: 3000 });

    await user.click(screen.getByRole('button', { name: '草稿' }));
    expect(await screen.findByText(/正在生成本章摘要与设定/)).toBeInTheDocument();
    // 回到草稿再标完成：第一次请求还在飞，复用同一个 Promise，不重复计费
    await user.click(screen.getByRole('button', { name: '已完成' }));
    await user.click(screen.getByRole('button', { name: '草稿' }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse(completion(JSON.stringify(ARCHIVE_RESULT))));
    expect(await screen.findByText(/本章摘要与设定已生成/)).toBeInTheDocument();
  });
});
