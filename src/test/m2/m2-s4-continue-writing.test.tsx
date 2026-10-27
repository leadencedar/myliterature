/**
 * M2-S4 独立验收：生成差额提示 + 手动「继续补写」（design §4、requirements US-A8）。
 *
 * 独立于开发的 GenerateChapterSheet.test.tsx：差额口径、请求体 history/剩余字数/maxTokens、
 * 空行追加、85% 边界、截断/中止语义、不自动触发，全部按设计手算断言。
 * 模型输出为 stub SSE，不依赖真实网络。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextRequest } from '@/context/ContextBuilder';
import type { Novel, OutlineNode } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { GenerateChapterSheet } from '@/features/writing/GenerateChapterSheet';

type SheetContext = Omit<
  ContextRequest,
  'selectedEntryIds' | 'recentSummaryCount' | 'excludedNormIds'
>;

let harness: TestHarness;
let novel: Novel;
let style: SheetContext['style'];
let categories: SheetContext['categories'];

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  style = (await harness.repository.getStyleProfile(novel.id))!;
  categories = await harness.repository.listCategories(novel.id);
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- 夹具与 stub

interface ChapterSetup {
  context: SheetContext;
  node: OutlineNode;
}

/** 建「卷 → 章节点 → 章节」并返回生成面板 context；targetWords=null 走默认 3000 */
async function setupChapter(targetWords: number | null): Promise<ChapterSetup> {
  const volume = await harness.repository.createOutlineNode(novel.id, {
    title: '第一卷 风起',
    synopsis: '主角被追杀。',
  });
  const node = await harness.repository.createOutlineNode(novel.id, {
    title: '第1章 雪夜',
    synopsis: '追兵临门，主角负伤。',
    parentId: volume.id,
    targetWords,
  });
  const chapter = await harness.repository.createChapter(novel.id, {
    title: '雪夜',
    outlineNodeId: node.id,
  });
  return {
    node,
    context: {
      novel,
      style,
      categories,
      entries: [],
      outline: await harness.repository.listOutline(novel.id),
      chapters: await harness.repository.listChapters(novel.id),
      summaries: [],
      targetNodeId: node.id,
      targetChapterId: chapter.id,
    },
  };
}

interface Message {
  role: string;
  content: string;
}
interface RequestBody {
  messages: Message[];
  max_tokens?: number;
  stream?: boolean;
}

interface StreamSpec {
  deltas?: string[];
  finishReason?: 'length';
  /** 流一段后保持打开，等 abort（模拟「停止生成」） */
  abortDeltas?: string[];
}

function sseFrame(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function abortableResponse(deltas: string[], signal: AbortSignal | undefined | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of deltas) {
        controller.enqueue(encoder.encode(sseFrame({ choices: [{ delta: { content: delta } }] })));
      }
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('Aborted', 'AbortError'));
        } catch {
          // 已关闭
        }
      });
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function stubLlm(responses: StreamSpec[]) {
  const bodies: RequestBody[] = [];
  const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as RequestBody;
    bodies.push(body);
    const spec = responses[Math.min(bodies.length - 1, responses.length - 1)]!;
    if (spec.abortDeltas) {
      return Promise.resolve(abortableResponse(spec.abortDeltas, init?.signal));
    }
    const extra = spec.finishReason
      ? [sseFrame({ choices: [{ delta: {}, finish_reason: spec.finishReason }] })]
      : [];
    return Promise.resolve(sseResponse(textDeltaEvents(spec.deltas ?? [], extra)));
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { fetchSpy, bodies };
}

/** 与 chapterLength 同公式的手算：ceil(words*1.8)+800，夹取 [4096,8192] */
function expectedMaxTokens(words: number): number {
  return Math.min(Math.max(Math.ceil(words * 1.8) + 800, 4096), 8192);
}

function renderSheet(context: SheetContext) {
  const onAccept = vi.fn();
  const rendered = harness.renderUI(
    <GenerateChapterSheet
      open
      context={context}
      existingContent=""
      onClose={vi.fn()}
      onAccept={onAccept}
    />,
  );
  return { user: userEvent.setup(), onAccept, unmount: rendered.unmount };
}

async function startGeneration(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '开始生成' }));
  return screen.findByLabelText('生成结果（可直接修改）');
}

/** 点「继续补写」并等到追加完成（回到 done 的可编辑结果） */
async function continueWriting(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '继续补写' }));
}

function headerText(): string {
  return screen.getByText(/\d+ 字 \/ 目标 \d+ 字/u).textContent ?? '';
}
function headerWords(): number {
  return Number(/\d+/u.exec(headerText())?.[0] ?? Number.NaN);
}

// ---------------------------------------------------------------- 用例

describe('M2-S4 · 差额提示（不发请求、不自动）', () => {
  it('短稿显示「比目标少约 X 字」+「继续补写」+ 不凑字数说明，且不会自动发第二次请求', async () => {
    const { context } = await setupChapter(6000);
    const { fetchSpy } = stubLlm([{ deltas: ['短稿'] }]);
    const { user } = renderSheet(context);
    await startGeneration(user);

    // 已生成 = 2 字 → 差额 5998
    expect(headerWords()).toBe(2);
    expect(screen.getByText(/比目标少约 5998 字/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续补写' })).toBeInTheDocument();
    expect(
      screen.getByText(/补写只补本章还没落地的场景，不是凑字数；不会自动继续。/u),
    ).toBeInTheDocument();

    // 不自动：等一会儿请求数仍是 1
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('完整且达到目标 85%：不显示差额提示/补写按钮', async () => {
    const { context } = await setupChapter(3000);
    const { fetchSpy } = stubLlm([{ deltas: ['字'.repeat(2800)] }]);
    const { user } = renderSheet(context);
    await startGeneration(user);

    expect(headerWords()).toBe(2800);
    expect(screen.queryByText(/比目标少约/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续补写' })).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('85% 边界：=85% 不提示，低 1 字提示（先卸载再重挂）', async () => {
    // 目标 3000 → 85% = 2550
    const exact = await setupChapter(3000);
    stubLlm([{ deltas: ['字'.repeat(2550)] }]);
    const first = renderSheet(exact.context);
    await startGeneration(first.user);
    expect(headerWords()).toBe(2550);
    expect(screen.queryByRole('button', { name: '继续补写' })).not.toBeInTheDocument();
    first.unmount();

    // 2549 字（差 1 字）→ 出现差额提示 451 字
    const below = await setupChapter(3000);
    stubLlm([{ deltas: ['字'.repeat(2549)] }]);
    const second = renderSheet(below.context);
    await startGeneration(second.user);
    expect(headerWords()).toBe(2549);
    expect(screen.getByText(/比目标少约 451 字/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续补写' })).toBeInTheDocument();
    second.unmount();
  });
});

describe('M2-S4 · 继续补写请求体与追加', () => {
  it('第二次请求带 history（原 user + 当前正文）、剩余字数指令、按剩余字数推导的 max_tokens；结果空行追加', async () => {
    const { context } = await setupChapter(6000);
    const firstText = '字'.repeat(4000);
    const addition = '补'.repeat(100);
    const { bodies, fetchSpy } = stubLlm([
      { deltas: [firstText] },
      { deltas: [addition] },
      { deltas: ['再补一点'] },
    ]);
    const { user } = renderSheet(context);
    await startGeneration(user);
    expect(headerWords()).toBe(4000);
    expect(screen.getByText(/比目标少约 2000 字/u)).toBeInTheDocument();

    await continueWriting(user);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByLabelText('生成结果（可直接修改）')).toHaveValue(
        `${firstText}\n\n${addition}`,
      ),
    );
    expect(headerWords()).toBe(4100);

    const firstBody = bodies[0]!;
    const secondBody = bodies[1]!;
    const firstUser = firstBody.messages.find((message) => message.role === 'user')!.content;
    const originalSystem = firstBody.messages.find((message) => message.role === 'system')!.content;

    // 顺序：[system, user(原始 prompt), assistant(当前正文), user(续写指令)]
    expect(secondBody.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(secondBody.messages[0]!.content).toBe(originalSystem);
    expect(secondBody.messages[1]!.content).toBe(firstUser);
    expect(secondBody.messages[2]!.content).toBe(firstText);
    expect(secondBody.messages[3]!.content).toContain('还差约 2000 字');
    expect(secondBody.messages[3]!.content).toContain('只补本章尚未落地的场景');
    expect(secondBody.messages[3]!.content).toContain('不要重复已经写过的内容');
    expect(secondBody.messages[3]!.content).toContain('不要总结');
    // max_tokens 按剩余 2000 字手算：ceil(3600)+800=4400（不是首次的 8192）
    expect(secondBody.max_tokens).toBe(4400);
    expect(expectedMaxTokens(2000)).toBe(4400);
    expect(firstBody.max_tokens).toBe(8192);
  });

  it('补到 85% 以上后提示与按钮消失，仍可继续手动补写（不会自动循环）', async () => {
    const { context } = await setupChapter(3000);
    const firstText = '字'.repeat(2000);
    const addition = '补'.repeat(600);
    const { fetchSpy } = stubLlm([{ deltas: [firstText] }, { deltas: [addition] }]);
    const { user } = renderSheet(context);
    await startGeneration(user);
    expect(screen.getByRole('button', { name: '继续补写' })).toBeInTheDocument();

    await continueWriting(user);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByLabelText('生成结果（可直接修改）')).toHaveValue(
        `${firstText}\n\n${addition}`,
      ),
    );
    expect(headerWords()).toBe(2600);
    expect(screen.queryByText(/比目标少约/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续补写' })).not.toBeInTheDocument();
    // 不自动循环
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('M2-S4 · 续写截断/中止语义', () => {
  it('续写被截断：仍标「生成未完成」且可再次补写（第三次请求按剩余 300 字推导 4096 下限）', async () => {
    const { context } = await setupChapter(3000);
    const firstText = '字'.repeat(2500);
    const secondText = '补'.repeat(200);
    const { bodies, fetchSpy } = stubLlm([
      { deltas: [firstText] },
      { deltas: [secondText], finishReason: 'length' },
      { deltas: ['再补'] },
    ]);
    const { user } = renderSheet(context);
    await startGeneration(user);

    await continueWriting(user);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('生成未完成')).toBeInTheDocument();
    // task-28：不完整红框把「继续补写 / 重新生成」两条路写在一起
    expect(
      screen.getByText(/生成被截断，内容不完整。可以继续补写未落地场景，或重新生成/u),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('生成结果（可直接修改）')).toHaveValue(
        `${firstText}\n\n${secondText}`,
      ),
    );
    // 仍可再次补写
    expect(screen.getByRole('button', { name: '继续补写' })).toBeInTheDocument();
    await continueWriting(user);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    const third = bodies[2]!;
    expect(third.messages[2]!.content).toBe(`${firstText}\n\n${secondText}`);
    expect(third.messages[3]!.content).toContain('还差约 300 字');
    expect(third.max_tokens).toBe(expectedMaxTokens(300));
    expect(third.max_tokens).toBe(4096); // 上限夹取下限
  });

  it('补写中「停止生成」：保留已补部分并标未完成；采用时仍走二次确认', async () => {
    const { context } = await setupChapter(6000);
    const firstText = '字'.repeat(4000);
    const partial = '补写中段';
    stubLlm([{ deltas: [firstText] }, { abortDeltas: [partial] }]);
    const { user } = renderSheet(context);
    await startGeneration(user);

    await continueWriting(user);
    await screen.findByRole('button', { name: '停止生成' });
    await user.click(screen.getByRole('button', { name: '停止生成' }));

    expect(await screen.findByText('生成未完成')).toBeInTheDocument();
    // 中止路径同样提示两条路（task-28）
    expect(
      screen.getByText(/生成已中断，内容不完整。可以继续补写未落地场景，或重新生成/u),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('生成结果（可直接修改）')).toHaveValue(
        `${firstText}\n\n${partial}`,
      ),
    );
    // 中止后的结果不完整：采用要二次确认
    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    const confirm = await screen.findByRole('dialog', { name: '仍要采用不完整内容？' });
    await user.click(within(confirm).getByRole('button', { name: '取消' }));
  });
});
