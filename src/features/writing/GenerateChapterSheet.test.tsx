import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextRequest } from '@/context/ContextBuilder';
import type { OutlineNode } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { GenerateChapterSheet } from './GenerateChapterSheet';

type SheetContext = Omit<
  ContextRequest,
  'selectedEntryIds' | 'recentSummaryCount' | 'excludedNormIds'
>;

let harness: TestHarness;
let context: SheetContext;
let volume: OutlineNode;
let chapterNode: OutlineNode;

beforeEach(async () => {
  harness = await createTestHarness();
  const novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
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

/** 模拟一次正常的流式响应；finishReason 不传时响应里没有 finish_reason（部分服务商如此） */
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

function renderSheet(overrides: Partial<SheetContext> = {}) {
  const onAccept = vi.fn();
  const onClose = vi.fn();
  harness.renderUI(
    <GenerateChapterSheet
      open
      context={{ ...context, ...overrides }}
      existingContent=""
      onClose={onClose}
      onAccept={onAccept}
    />,
  );
  return { user: userEvent.setup(), onAccept, onClose };
}

async function generate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '开始生成' }));
  await screen.findByLabelText('生成结果（可直接修改）');
}

describe('目标字数来源（US-4 / US-5）', () => {
  it('大纲节点有目标时显示「来源：大纲节点」', () => {
    renderSheet();
    expect(screen.getByText('目标字数：6000 字（来源：大纲节点）')).toBeInTheDocument();
  });

  it('大纲节点为空时显示「来源：默认 3000」', async () => {
    const defaultNode = await harness.repository.createOutlineNode(context.novel.id, {
      title: '第2章 旧识',
      parentId: volume.id,
    });
    renderSheet({
      outline: [...context.outline, defaultNode],
      targetNodeId: defaultNode.id,
    });
    expect(screen.getByText('目标字数：3000 字（来源：默认 3000）')).toBeInTheDocument();
  });

  it('场景数参考给出具体区间，而不是一句「按目标推算」', () => {
    renderSheet();
    // 6000 字 → 3–5 场（sceneRangeHint）；评审：没有数字等于没兑现结构承诺
    expect(
      screen.getByText('场景数参考：约 3–5 场；要修改请到「写作 → 大纲节点」里改。'),
    ).toBeInTheDocument();
  });

  it('默认目标 3000 字时给出 1–2 场参考', async () => {
    const defaultNode = await harness.repository.createOutlineNode(context.novel.id, {
      title: '第2章 旧识',
      parentId: volume.id,
    });
    renderSheet({
      outline: [...context.outline, defaultNode],
      targetNodeId: defaultNode.id,
    });
    expect(
      screen.getByText('场景数参考：约 1–2 场；要修改请到「写作 → 大纲节点」里改。'),
    ).toBeInTheDocument();
  });
});

describe('请求参数与结构文案', () => {
  it('按目标推导 max_tokens 传给请求，user prompt 换成结构文案', async () => {
    const fetchSpy = stubStream(['正文']);
    const { user } = renderSheet();
    await generate(user);

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      max_tokens?: number;
      messages: { role: string; content: string }[];
    };
    // 6000 字：ceil(6000×1.8)+800=11600，撞 8192 上夹
    expect(body.max_tokens).toBe(8192);
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;
    expect(userMessage).toContain('本章目标约 6000 字，场景数供参考：3–5 场。');
    expect(userMessage).toContain('以【本章要写的内容】的梗概节拍为准');
    expect(userMessage).toContain('结尾收在梗概承诺的钩子上');
    expect(userMessage).toContain('以本节目标为准');
    expect(userMessage).not.toContain('可上下浮动 15%');
  });
});

describe('截断与中断防线（US-4）', () => {
  it('finishReason=length 时显示未完成/截断提示，不显示「生成完成」', async () => {
    stubStream(['只写了一半的正文'], 'length');
    const { user } = renderSheet();
    await generate(user);

    expect(screen.getByText('生成未完成')).toBeInTheDocument();
    expect(screen.getByText(/生成被截断，内容不完整/u)).toBeInTheDocument();
    // 红框与下方差额提示都写了这两条路：至少出现一次且文案并列
    expect(screen.getAllByText(/可以继续补写未落地场景，或重新生成/u).length).toBeGreaterThan(0);
    expect(screen.getByText('8 字 / 目标 6000 字')).toBeInTheDocument();
    expect(screen.queryByText('生成完成')).not.toBeInTheDocument();
  });

  it('finishReason 缺失视为未知：不判截断、不报错', async () => {
    stubStream(['完整正文']);
    const { user, onAccept } = renderSheet();
    await generate(user);

    // 完整但只写了几十字：标题带上「接近目标」，不误导成写满了
    expect(screen.getByText('生成完成（接近目标）')).toBeInTheDocument();
    expect(screen.getByText('4 字 / 目标 6000 字')).toBeInTheDocument();
    expect(screen.queryByText(/生成被截断/u)).not.toBeInTheDocument();

    // 正常完成直接采用，不弹二次确认
    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('完整正文', 'replace'));
    expect(screen.queryByRole('dialog', { name: '仍要采用不完整内容？' })).not.toBeInTheDocument();
  });

  it('截断结果的「采用」要二次确认：取消不写，确认才写', async () => {
    stubStream(['只写了一半的正文'], 'length');
    const { user, onAccept } = renderSheet();
    await generate(user);

    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    expect(onAccept).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: '仍要采用不完整内容？' });
    expect(confirm).toHaveTextContent(
      '采用后本章仍是草稿，可能缺少结尾。建议在编辑器里从末尾继续补写，补完再标「已完成」。',
    );

    // 先取消：什么都不写，结果还在
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByText(/生成被截断，内容不完整/u)).toBeInTheDocument();

    // 再确认：按原模式写入
    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    await user.click(screen.getByRole('button', { name: '仍要采用' }));
    await waitFor(() =>
      expect(onAccept).toHaveBeenCalledWith('只写了一半的正文', 'replace', {
        incomplete: 'truncated',
      }),
    );
  });

  it('用户中止时保留已生成内容并标记未完成，采用同样要二次确认', async () => {
    const encoder = new TextEncoder();
    const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: '写到一半' } }] })}\n\n`,
            ),
          );
          // 不主动 close：等用户点「停止生成」触发 abort
          signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { user, onAccept } = renderSheet();
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByText('写到一半');
    await user.click(screen.getByRole('button', { name: '停止生成' }));

    expect(await screen.findByText('生成未完成')).toBeInTheDocument();
    expect(screen.getByText(/生成已中断，内容不完整。/u)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    const dialog = await screen.findByRole('dialog', { name: '仍要采用不完整内容？' });
    await user.click(within(dialog).getByRole('button', { name: '仍要采用' }));
    await waitFor(() =>
      expect(onAccept).toHaveBeenCalledWith('写到一半', 'replace', { incomplete: 'aborted' }),
    );
  });
});

describe('400 max_tokens 兼容回退', () => {
  it('服务端点名拒绝 max_tokens 时去掉该参数重试一次，且不重复累计流式文本', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (bodies.length === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Invalid max_tokens value' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(sseResponse(textDeltaEvents(['重试后的正文'])));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { user } = renderSheet();
    await generate(user);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toHaveProperty('max_tokens');
    expect(bodies[1]).not.toHaveProperty('max_tokens');
    // 第一次请求在出字前就被拒，重试后正文只出现一遍
    expect(screen.getByLabelText('生成结果（可直接修改）')).toHaveValue('重试后的正文');
    expect(screen.getByText('生成完成（接近目标）')).toBeInTheDocument();
  });

  it('与 max_tokens 无关的 400 不静默重试，照常报错', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'model not found' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { user } = renderSheet();
    await user.click(screen.getByRole('button', { name: '开始生成' }));

    expect(
      await screen.findByText('请求被服务端拒绝，可能是模型名或参数不被支持'),
    ).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('生成差额与手动继续补写（S4）', () => {
  /** 3000 个汉字 = countWords 3000，相对 6000 目标正好一半（<85%） */
  const HALF = '字'.repeat(3000);

  /** 按调用顺序返回不同的流式响应，并记录每次请求体 */
  function stubSequence(responses: { deltas: string[]; finishReason?: string }[]) {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        const item = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        const extra = item.finishReason
          ? [
              `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: item.finishReason }],
              })}\n\n`,
            ]
          : [];
        return Promise.resolve(sseResponse(textDeltaEvents(item.deltas, extra)));
      }),
    );
    return bodies;
  }

  type ChatBody = {
    messages: { role: string; content: string }[];
    max_tokens?: number;
  };

  it('短稿显示差额提示，但不会自动续写', async () => {
    const bodies = stubSequence([{ deltas: [HALF] }]);
    const { user } = renderSheet();
    await generate(user);

    // 50%：完整但离目标远，标题也要如实标记「接近目标」而不是「生成完成」
    expect(screen.getByText('生成完成（接近目标）')).toBeInTheDocument();
    expect(screen.getByText('还有场景没落地？')).toBeInTheDocument();
    expect(screen.getByText('比目标少约 3000 字。')).toBeInTheDocument();
    expect(
      screen.getByText(/节拍已齐可直接标完成。补写只补本章还没落地的场景/u),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续补写' })).toBeInTheDocument();
    // 不自动：等提示渲染完也只有首次生成这一个请求
    expect(bodies).toHaveLength(1);
  });

  it('点「继续补写」用原 user + 当前正文作 history，结果追加到末尾', async () => {
    const bodies = stubSequence([{ deltas: [HALF] }, { deltas: ['补写内容。'] }]);
    const { user } = renderSheet();
    await generate(user);

    await user.click(screen.getByRole('button', { name: '继续补写' }));

    const preview = screen.getByLabelText('生成结果（可直接修改）');
    await waitFor(() => expect(preview).toHaveValue(`${HALF}\n\n补写内容。`));

    expect(bodies).toHaveLength(2);
    const body = bodies[1] as unknown as ChatBody;
    const messages = body.messages;
    // system + 原 user 提示词 + assistant 当前正文 + 续写指令
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[1]?.content).toContain('本章目标约 6000 字');
    expect(messages[2]?.content).toBe(HALF);
    expect(messages[3]?.content).toBe(
      '接着上面的内容继续写，只补本章尚未落地的场景；还差约 3000 字。不要重复已经写过的内容，不要总结。',
    );
    // 按剩余 3000 字推导：ceil(3000×1.8)+800=6200，而不是整章目标推导的 8192
    expect(body.max_tokens).toBe(6200);
  });

  it('完整但略低于目标（90%）：标题「接近目标」，不弹补写块', async () => {
    const nineTenths = await harness.repository.createOutlineNode(context.novel.id, {
      title: '第3章 九成',
      parentId: volume.id,
      targetWords: 3000,
    });
    // 2700/3000 = 90%：已经算写够了（不弹补写），但还没到目标，标题要如实说明
    stubSequence([{ deltas: ['字'.repeat(2700)] }]);
    const { user } = renderSheet({
      outline: [...context.outline, nineTenths],
      targetNodeId: nineTenths.id,
    });
    await generate(user);

    expect(screen.getByText('生成完成（接近目标）')).toBeInTheDocument();
    expect(screen.queryByText('还有场景没落地？')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续补写' })).not.toBeInTheDocument();
    expect(screen.queryByText(/比目标少约/u)).not.toBeInTheDocument();
  });

  it('完整且达到目标（100%）：标题是「生成完成」', async () => {
    const exactly = await harness.repository.createOutlineNode(context.novel.id, {
      title: '第4章 足额',
      parentId: volume.id,
      targetWords: 100,
    });
    stubSequence([{ deltas: ['字'.repeat(100)] }]);
    const { user } = renderSheet({
      outline: [...context.outline, exactly],
      targetNodeId: exactly.id,
    });
    await generate(user);

    expect(screen.getByText('生成完成')).toBeInTheDocument();
    expect(screen.queryByText('还有场景没落地？')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续补写' })).not.toBeInTheDocument();
  });

  it('补写到目标 85% 以上后差额提示消失', async () => {
    const shortNode = await harness.repository.createOutlineNode(context.novel.id, {
      title: '第2章 短章',
      parentId: volume.id,
      targetWords: 100,
    });
    stubSequence([{ deltas: ['短短短'] }, { deltas: ['续'.repeat(90)] }]);
    const { user } = renderSheet({
      outline: [...context.outline, shortNode],
      targetNodeId: shortNode.id,
    });
    await generate(user);
    expect(screen.getByText(/比目标少约/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '继续补写' }));

    await waitFor(() =>
      expect(screen.getByLabelText('生成结果（可直接修改）')).toHaveValue(
        `短短短\n\n${'续'.repeat(90)}`,
      ),
    );
    expect(screen.queryByText(/比目标少约/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续补写' })).not.toBeInTheDocument();
  });

  it('续写被截断仍标记未完成，可以再次补写', async () => {
    stubSequence([{ deltas: ['短稿。'] }, { deltas: ['补写被截断'], finishReason: 'length' }]);
    const { user } = renderSheet();
    await generate(user);

    await user.click(screen.getByRole('button', { name: '继续补写' }));

    await waitFor(() =>
      expect(screen.getByLabelText('生成结果（可直接修改）')).toHaveValue('短稿。\n\n补写被截断'),
    );
    expect(screen.getByText('生成未完成')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续补写' })).toBeInTheDocument();
  });

  it('续写过程中可以停止：保留已补部分并标记未完成', async () => {
    const encoder = new TextEncoder();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        if (call === 1) return Promise.resolve(sseResponse(textDeltaEvents(['短稿。'])));
        const signal = init?.signal ?? undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: '补到一半' } }] })}\n\n`,
              ),
            );
            // 不主动 close：等用户点「停止生成」触发 abort
            signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            );
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        );
      }),
    );

    const { user } = renderSheet();
    await generate(user);
    await user.click(screen.getByRole('button', { name: '继续补写' }));

    // 补写期间沿用流式预览与「停止生成」
    await screen.findByText(/补到一半/);
    await user.click(screen.getByRole('button', { name: '停止生成' }));

    await waitFor(() =>
      expect(screen.getByLabelText('生成结果（可直接修改）')).toHaveValue('短稿。\n\n补到一半'),
    );
    expect(screen.getByText('生成未完成')).toBeInTheDocument();
  });
});

describe('超出目标的可见提示（M3.2）', () => {
  /** 用指定目标渲染并生成，返回 fetch spy（用于确认只发了一次请求） */
  async function renderAt(targetWords: number, written: number, finishReason?: string) {
    const node = await harness.repository.createOutlineNode(context.novel.id, {
      title: `第5章 ${targetWords}`,
      parentId: volume.id,
      targetWords,
    });
    const fetchSpy = stubStream(['字'.repeat(written)], finishReason);
    const { user } = renderSheet({
      outline: [...context.outline, node],
      targetNodeId: node.id,
    });
    await generate(user);
    return fetchSpy;
  }

  it('90%：仍是「接近目标」，无超出提示，也没有补写块', async () => {
    await renderAt(1000, 900);

    expect(screen.getByText('生成完成（接近目标）')).toBeInTheDocument();
    expect(screen.queryByText(/超出目标/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/比目标多约/u)).not.toBeInTheDocument();
    // 90% 已过 85% 门槛：不弹补写
    expect(screen.queryByRole('button', { name: '继续补写' })).not.toBeInTheDocument();
  });

  it('100%：显示「生成完成」，无超出提示', async () => {
    await renderAt(1000, 1000);

    expect(screen.getByText('生成完成')).toBeInTheDocument();
    expect(screen.queryByText(/超出目标/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/比目标多约/u)).not.toBeInTheDocument();
  });

  it('110%：仍显示「生成完成」，不提示超出', async () => {
    await renderAt(1000, 1100);

    expect(screen.getByText('生成完成')).toBeInTheDocument();
    expect(screen.queryByText(/超出目标/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/比目标多约/u)).not.toBeInTheDocument();
  });

  it('120%：标题「生成完成（超出目标）」+ 只提醒不自动压缩，不新增请求/按钮', async () => {
    const fetchSpy = await renderAt(1000, 1200);

    expect(screen.getByText('生成完成（超出目标）')).toBeInTheDocument();
    expect(screen.getByText(/比目标多约 200 字/u)).toBeInTheDocument();
    expect(screen.getByText(/不自动压缩，也不硬卡字数/u)).toBeInTheDocument();
    expect(screen.getByText(/采用后可手动删减/u)).toBeInTheDocument();
    // 不新增「收束/压缩」之类的按钮，也不追加请求
    expect(screen.queryByRole('button', { name: /压缩|收束|改写/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续补写' })).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('截断时即使字数超出也不显示超出提示（未完成优先）', async () => {
    await renderAt(1000, 1200, 'length');

    expect(screen.getByText('生成未完成')).toBeInTheDocument();
    expect(screen.queryByText(/超出目标/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/比目标多约/u)).not.toBeInTheDocument();
  });
});
