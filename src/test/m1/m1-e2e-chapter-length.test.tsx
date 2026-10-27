/**
 * S7 独立验收 · 交互层（US-4 / US-5 / 指标 4、5）：目标来源、max_tokens、截断/中断/null、400 回退。
 *
 * 全部用 stub fetch 确定性构造，不依赖真实模型；与开发的 GenerateChapterSheet.test.tsx
 * 相互独立（断言按设计与验收条目重写）。
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextRequest } from '@/context/ContextBuilder';
import type { Novel, OutlineNode } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { GenerateChapterSheet } from '@/features/writing/GenerateChapterSheet';

type SheetContext = Omit<
  ContextRequest,
  'selectedEntryIds' | 'recentSummaryCount' | 'excludedNormIds'
>;

let harness: TestHarness;
let novel: Novel;
let volume: OutlineNode;
let chapterNode: OutlineNode;
let context: SheetContext;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  const style = (await harness.repository.getStyleProfile(novel.id))!;
  const categories = await harness.repository.listCategories(novel.id);
  volume = await harness.repository.createOutlineNode(novel.id, {
    title: '第一卷 风起',
    synopsis: '主角被追杀。',
  });
  chapterNode = await harness.repository.createOutlineNode(novel.id, {
    title: '第1章 雪夜',
    synopsis: '追兵临门，主角负伤。',
    parentId: volume.id,
    targetWords: 6000,
  });
  const chapter = await harness.repository.createChapter(novel.id, {
    title: '第1章 雪夜',
    outlineNodeId: chapterNode.id,
  });
  context = {
    novel,
    style,
    categories,
    entries: [],
    outline: await harness.repository.listOutline(novel.id),
    chapters: await harness.repository.listChapters(novel.id),
    summaries: [],
    targetNodeId: chapterNode.id,
    targetChapterId: chapter.id,
  };
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- stubs

interface Body {
  max_tokens?: number;
  stream?: boolean;
  messages: { role: string; content: string }[];
}

/** 按顺序返回若干响应，并记录每次请求体 */
function stubFetchSequence(responses: (Response | (() => Response))[]) {
  const bodies: Body[] = [];
  const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Body);
    const next = responses[Math.min(bodies.length - 1, responses.length - 1)]!;
    return Promise.resolve(typeof next === 'function' ? next() : next);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { fetchSpy, bodies };
}

/** 正常/截断/未知 finishReason 的 SSE */
function streamResponse(deltas: string[], finishReason?: 'length' | null) {
  const extra =
    finishReason === 'length'
      ? [`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`]
      : [];
  return sseResponse(textDeltaEvents(deltas, extra));
}

/** 流出内容后保持打开的流：收到 abort 信号时以 AbortError 结束（模拟用户点「停止生成」） */
function stubAbortableStream(deltas: string[]) {
  const encoder = new TextEncoder();
  const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const delta of deltas) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
            ),
          );
        }
        // 不 close：等 abort 信号；模拟真实 fetch 在 signal abort 时让流读取失败
        signal?.addEventListener('abort', () => {
          try {
            controller.error(new DOMException('Aborted', 'AbortError'));
          } catch {
            // 流已关闭时忽略
          }
        });
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function renderSheet(overrides: Partial<SheetContext> = {}, existingContent = '') {
  const onAccept = vi.fn();
  const onClose = vi.fn();
  harness.renderUI(
    <GenerateChapterSheet
      open
      context={{ ...context, ...overrides }}
      existingContent={existingContent}
      onClose={onClose}
      onAccept={onAccept}
    />,
  );
  return { user: userEvent.setup(), onAccept, onClose };
}

async function startGeneration(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '开始生成' }));
  return screen.findByLabelText('生成结果（可直接修改）');
}

// ---------------------------------------------------------------- 用例

describe('指标 5 · 目标字数与来源 100% 可见（US-4a / US-5a）', () => {
  it('大纲节点有目标：显示 6000 字 + 来源「大纲节点」+ 具体场景区间（P1）', () => {
    renderSheet();
    expect(screen.getByText('目标字数：6000 字（来源：大纲节点）')).toBeInTheDocument();
    expect(
      screen.getByText('场景数参考：约 3–5 场；要修改请到「写作 → 大纲节点」里改。'),
    ).toBeInTheDocument();
  });

  it('大纲节点为空：显示 3000 字 + 来源「默认 3000」，并提示去大纲修改', async () => {
    const defaultNode = await harness.repository.createOutlineNode(novel.id, {
      title: '第2章 旧识',
      parentId: volume.id,
    });
    renderSheet({ outline: [...context.outline, defaultNode], targetNodeId: defaultNode.id });
    expect(screen.getByText('目标字数：3000 字（来源：默认 3000）')).toBeInTheDocument();
    expect(
      screen.getByText('场景数参考：约 1–2 场；要修改请到「写作 → 大纲节点」里改。'),
    ).toBeInTheDocument();
  });
});

describe('US-4b / max_tokens · 请求参数与结构文案', () => {
  it('6000 字 → max_tokens 8192（1.8×+800 上夹），user prompt 含 3–5 场与节拍要求', async () => {
    const { bodies } = stubFetchSequence([streamResponse(['正文'])]);
    const { user } = renderSheet();
    await startGeneration(user);

    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.max_tokens).toBe(8192);
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;
    expect(userMessage).toContain('本章目标约 6000 字，场景数供参考：3–5 场。');
    expect(userMessage).toContain('以【本章要写的内容】的梗概节拍为准');
    expect(userMessage).toContain('自然收束');
    expect(userMessage).toContain('结尾收在梗概承诺的钩子上');
    expect(userMessage).toContain('以本节目标为准');
  });

  it('默认 3000 字 → max_tokens 6200，user prompt 含 1–2 场', async () => {
    const defaultNode = await harness.repository.createOutlineNode(novel.id, {
      title: '第2章 旧识',
      parentId: volume.id,
    });
    const { bodies } = stubFetchSequence([streamResponse(['正文'])]);
    const { user } = renderSheet({
      outline: [...context.outline, defaultNode],
      targetNodeId: defaultNode.id,
    });
    await startGeneration(user);

    expect(bodies[0]!.max_tokens).toBe(6200);
    const userMessage = bodies[0]!.messages.find((message) => message.role === 'user')!.content;
    expect(userMessage).toContain('本章目标约 3000 字，场景数供参考：1–2 场。');
  });
});

describe('US-4c / 指标 4 · 截断（finish_reason=length）', () => {
  it('显示未完成与截断说明；采用需二次确认，取消不写、确认才写', async () => {
    stubFetchSequence([streamResponse(['只写了一半的正文'], 'length')]);
    const { user, onAccept, onClose } = renderSheet();
    await startGeneration(user);

    expect(screen.getByText('生成未完成')).toBeInTheDocument();
    expect(screen.getByText(/生成被截断，内容不完整/u)).toBeInTheDocument();
    expect(
      screen.getByText(/生成被截断，内容不完整。可以继续补写未落地场景，或重新生成/u),
    ).toBeInTheDocument();

    // P1：结果标题给出「已生成 / 目标」对照
    expect(screen.getByText(/\d+ 字 \/ 目标 6000 字/u)).toBeInTheDocument();

    // 第一次点采用：只弹确认，不写
    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    expect(await screen.findByText('仍要采用不完整内容？')).toBeInTheDocument();
    // P0 文案改为「采用后本章仍是草稿…」，不再承诺结果页有续写按钮
    expect(
      screen.getByText(
        '采用后本章仍是草稿，可能缺少结尾。建议在编辑器里从末尾继续补写，补完再标「已完成」。',
      ),
    ).toBeInTheDocument();
    expect(onAccept).not.toHaveBeenCalled();

    // 取消：不写、仍保留结果
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByText('仍要采用不完整内容？')).not.toBeInTheDocument());
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('只写了一半的正文')).toBeInTheDocument();

    // 再点采用 → 确认 → 写入
    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    await user.click(await screen.findByRole('button', { name: '仍要采用' }));
    // 不完整稿采用时把 incomplete 事实作为第三参交给调用方（编辑器据此留痕）
    await waitFor(() =>
      expect(onAccept).toHaveBeenCalledWith('只写了一半的正文', 'replace', {
        incomplete: 'truncated',
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});

describe('US-4d / 指标 4 · 用户中止（aborted）', () => {
  it('保留已流出内容并标记中断；采用同样二次确认', async () => {
    stubAbortableStream(['中断前的一段']);

    const { user, onAccept } = renderSheet();
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    // 流保持打开：此时应处于 streaming，点停止
    await screen.findByRole('button', { name: '停止生成' });
    await user.click(screen.getByRole('button', { name: '停止生成' }));

    expect(await screen.findByText(/生成已中断，内容不完整/u)).toBeInTheDocument();
    expect(screen.getByText('生成未完成')).toBeInTheDocument();
    expect(screen.getByDisplayValue('中断前的一段')).toBeInTheDocument();

    expect(screen.getByText(/\d+ 字 \/ 目标 6000 字/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    await user.click(await screen.findByRole('button', { name: '仍要采用' }));
    await waitFor(() =>
      expect(onAccept).toHaveBeenCalledWith('中断前的一段', 'replace', { incomplete: 'aborted' }),
    );
  });
});

describe('指标 4 · finishReason=null 视为未知（不误报）', () => {
  it('正常完成、不显示未完成、采用不弹二次确认', async () => {
    stubFetchSequence([streamResponse(['完整正文。'])]); // 无 finish_reason 帧
    const { user, onAccept } = renderSheet();
    await startGeneration(user);

    expect(screen.getByText('生成完成')).toBeInTheDocument();
    expect(screen.getByText(/\d+ 字 \/ 目标 6000 字/u)).toBeInTheDocument();
    expect(screen.queryByText(/生成被截断/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/生成已中断/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('完整正文。', 'replace'));
    expect(screen.queryByText('仍要采用不完整内容？')).not.toBeInTheDocument();
  });
});

describe('400 max_tokens 回退（design §8.2）', () => {
  it('首次 400 且报错点名 max_tokens：自动去掉参数重试一次，内容不重复', async () => {
    const { fetchSpy, bodies } = stubFetchSequence([
      jsonResponse({ error: { message: 'Invalid max_tokens value: maximum is 8192' } }, 400),
      () => streamResponse(['重试成功的正文。']),
    ]);
    const { user, onAccept } = renderSheet();
    await startGeneration(user);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies[0]!.max_tokens).toBe(8192);
    expect(bodies[1]!.max_tokens).toBeUndefined(); // 重试不带 max_tokens
    expect(screen.getByDisplayValue('重试成功的正文。')).toBeInTheDocument();
    expect(screen.getByText('生成完成')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('重试成功的正文。', 'replace'));
  });

  it('400 但报错与 max_tokens 无关：不重试，直接显示错误', async () => {
    const { fetchSpy } = stubFetchSequence([
      jsonResponse({ error: { message: 'model not found' } }, 400),
    ]);
    const { user } = renderSheet();
    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/请求被服务端拒绝/u);
  });

  it('400 重试后仍失败：只重试一次，最终显示错误', async () => {
    const { fetchSpy } = stubFetchSequence([
      jsonResponse({ error: { message: 'invalid max_tokens' } }, 400),
      jsonResponse({ error: { message: 'invalid max_tokens again' } }, 400),
    ]);
    const { user } = renderSheet();
    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('正常生成路径不受影响', () => {
  it('已有正文时提供替换/追加；采用为追加时按 append 写入', async () => {
    stubFetchSequence([streamResponse(['新段落。'])]);
    const { user, onAccept } = renderSheet({}, '已有正文。');
    await startGeneration(user);

    const replaceButton = screen.getByRole('button', { name: '替换正文' });
    expect(replaceButton).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '追加到正文末尾' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '追加到正文末尾' }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('新段落。', 'append'));
  });

  it('生成结果可编辑，编辑内容随采用写入', async () => {
    stubFetchSequence([streamResponse(['原始。'])]);
    const { user, onAccept } = renderSheet();
    await startGeneration(user);

    const editor = screen.getByLabelText('生成结果（可直接修改）');
    await user.clear(editor);
    await user.type(editor, '改过的正文。');
    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('改过的正文。', 'replace'));
  });
});
