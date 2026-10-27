/**
 * P0 独立验收 · 「未完成生成稿」会话内留痕（task-14 文学顾问 P0 / task-15 验证）。
 *
 * 期望行为（task-14 描述 + task-15 验收）：
 * - 截断/中断稿采用后，编辑器标题栏下出现「本章由未完成生成稿采用，可能缺少结尾；补写后再标「已完成」」；
 * - 点「知道了」消失；切「已完成」清除；完整采用清除；自动保存不清除；
 * - 只放内存 store，不持久化（刷新后不残留）。
 *
 * 独立于开发的 ChapterEditor.test.tsx：夹具、交互辅助与断言按验收条目重写。
 * 注意：本文件显式 import 并使用 `useIncompleteDrafts` 重置 store（createTestHarness 不会重置内存 store）。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Novel, OutlineNode } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { useIncompleteDrafts } from '@/features/writing/incompleteDrafts';
import { WritingPage } from '@/features/writing/WritingPage';

let harness: TestHarness;
let novel: Novel;
let chapterNode: OutlineNode;

/** 切「已完成」会自动触发摘要生成；给它一个合法 JSON，避免用例里出现无谓报错 */
const SUMMARY_RESULT = {
  summary: '只写了一半的摘要。',
  keyEvents: ['写到一半'],
  appearingEntries: [],
  newOpenThreads: [],
  resolvedThreads: [],
  rollingSummary: '写到一半。',
};

const HINT = /本章由未完成生成稿采用，可能缺少结尾/u;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  useIncompleteDrafts.setState({ chapterIds: {} });
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
  vi.restoreAllMocks();
});

/** 按请求的 stream 字段分流：流式正文（可截断），非流式摘要返回合法 JSON */
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

async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
}

/** 从大纲节点进入章节编辑器 */
async function enterEditor() {
  const user = userEvent.setup();
  harness.renderUI(<WritingPage />, '/write');
  await waitForLoaded();
  await user.click(await screen.findByRole('button', { name: '编辑「第1章 雪夜」' }));
  await user.click(await screen.findByRole('button', { name: '写这一章' }));
  await screen.findByLabelText('章节正文');
  return user;
}

/** 生成一次并采用；不完整稿会自动走二次确认 */
async function generateAndAdopt(
  user: ReturnType<typeof userEvent.setup>,
  options: { deltas: string[]; finishReason?: string },
  acceptLabel = '采用为正文',
) {
  stubChapterLlm(options);
  await user.click(screen.getByRole('button', { name: '生成本章' }));
  await screen.findByText('本次注入');
  await user.click(screen.getByRole('button', { name: '开始生成' }));
  await screen.findByLabelText('生成结果（可直接修改）');
  await user.click(screen.getByRole('button', { name: acceptLabel }));
  const confirm = screen.queryByRole('dialog', { name: '仍要采用不完整内容？' });
  if (confirm) await user.click(within(confirm).getByRole('button', { name: '仍要采用' }));
}

async function adoptTruncated(user: ReturnType<typeof userEvent.setup>) {
  await generateAndAdopt(user, { deltas: ['只写了一半的正文。'], finishReason: 'length' });
}

async function chapters() {
  return harness.repository.listChapters(novel.id);
}

describe('未完成稿留痕 store · 内存语义（P0）', () => {
  it('mark/clear 幂等；状态只有内存字段，没有持久化入口', () => {
    useIncompleteDrafts.getState().markIncomplete('ch-1');
    useIncompleteDrafts.getState().markIncomplete('ch-1'); // 幂等
    useIncompleteDrafts.getState().markIncomplete('ch-2');
    expect(useIncompleteDrafts.getState().chapterIds).toEqual({ 'ch-1': true, 'ch-2': true });

    useIncompleteDrafts.getState().clearIncomplete('ch-1');
    expect(useIncompleteDrafts.getState().chapterIds).toEqual({ 'ch-2': true });
    useIncompleteDrafts.getState().clearIncomplete('ch-2');
    expect(useIncompleteDrafts.getState().chapterIds).toEqual({});

    // 内存 store：没有 zustand persist 中间件，也不会写 localStorage（刷新即失）
    expect((useIncompleteDrafts as unknown as { persist?: unknown }).persist).toBeUndefined();
    expect(Object.keys(useIncompleteDrafts.getState()).sort()).toEqual([
      'chapterIds',
      'clearIncomplete',
      'markIncomplete',
    ]);
    expect(Object.keys(localStorage).some((key) => /incomplete/i.test(key))).toBe(false);
  });
});

describe('P0 · 采用截断/中断稿后编辑器留痕', () => {
  it('截断稿采用：出现提示 + 正文已写入 + 仍是草稿；点「知道了」关闭', async () => {
    const user = await enterEditor();
    await adoptTruncated(user);

    expect(await screen.findByText(HINT)).toBeInTheDocument();
    await waitFor(async () => {
      const list = await chapters();
      expect(list[0]?.content).toBe('只写了一半的正文。');
      expect(list[0]?.status).toBe('draft');
    });
    // 留痕不拦写：正文确实进了编辑器与库
    expect(useIncompleteDrafts.getState().chapterIds[chapterNode.id]).toBeUndefined();
    expect(Object.keys(useIncompleteDrafts.getState().chapterIds)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('切到「已完成」清除提示（作者认可定稿）', async () => {
    const user = await enterEditor();
    await adoptTruncated(user);
    expect(await screen.findByText(HINT)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '草稿' }));
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();

    // 标完成会自动弹摘要抽屉，关掉收尾
    const summary = screen.queryByRole('dialog', { name: '本章摘要' });
    if (summary) await user.click(within(summary).getByRole('button', { name: '关闭' }));
    await waitFor(async () => expect((await chapters())[0]?.status).toBe('done'));
  });

  it('完整采用不出现提示，并清掉之前留下的提示', async () => {
    const user = await enterEditor();
    await adoptTruncated(user);
    expect(await screen.findByText(HINT)).toBeInTheDocument();

    // 第二次完整生成并替换正文 → 之前的提醒清除
    await generateAndAdopt(user, { deltas: ['这次写完整了。'] }, '替换正文');

    await waitFor(async () => {
      const list = await chapters();
      expect(list[0]?.content).toBe('这次写完整了。');
    });
    await waitFor(() => expect(screen.queryByText(HINT)).not.toBeInTheDocument());
  });

  it('完整采用（首次）不出现提示', async () => {
    const user = await enterEditor();
    await generateAndAdopt(user, { deltas: ['完整的一章正文。'] });

    await waitFor(async () => expect((await chapters())[0]?.content).toBe('完整的一章正文。'));
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('自动保存不清除提示（只有「知道了 / 标完成 / 完整采用」才清除）', async () => {
    const user = await enterEditor();
    await adoptTruncated(user);
    expect(await screen.findByText(HINT)).toBeInTheDocument();

    await user.type(screen.getByLabelText('章节正文'), '补写一句。');
    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it('提示来自内存 store：重置（模拟刷新）后不残留，也不从库里恢复', async () => {
    const user = await enterEditor();
    await adoptTruncated(user);
    expect(await screen.findByText(HINT)).toBeInTheDocument();
    expect(Object.keys(useIncompleteDrafts.getState().chapterIds)).toHaveLength(1);

    // 刷新会丢掉内存 store；jsdom 里无法真正重载模块，用「重置 store」等价模拟
    useIncompleteDrafts.setState({ chapterIds: {} });
    await waitFor(() => expect(screen.queryByText(HINT)).not.toBeInTheDocument());

    // 正文仍在库里（提示消失不等于内容丢失）
    expect((await chapters())[0]?.content).toBe('只写了一半的正文。');
  });

  it('中断稿（aborted）同样留痕', async () => {
    const user = await enterEditor();
    // 先流出内容再中止：用 abortable 流
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
        if (!body.stream) {
          return Promise.resolve(jsonResponse(completion(JSON.stringify(SUMMARY_RESULT))));
        }
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: '中断前的一段' } }] })}\n\n`,
              ),
            );
            signal?.addEventListener('abort', () => {
              try {
                controller.error(new DOMException('Aborted', 'AbortError'));
              } catch {
                // 已关闭
              }
            });
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        );
      }),
    );

    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByRole('button', { name: '停止生成' });
    await user.click(screen.getByRole('button', { name: '停止生成' }));

    expect(await screen.findByText(/生成已中断，内容不完整/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    await user.click(await screen.findByRole('button', { name: '仍要采用' }));

    expect(await screen.findByText(HINT)).toBeInTheDocument();
  });
});

describe('P0 边界（task-17）· 已完成章节采用截断稿退回草稿', () => {
  it('done 章采用截断稿：状态退回草稿并落盘、提示出现、不自动弹摘要', async () => {
    const existing = await harness.repository.createChapter(novel.id, {
      title: '雪夜',
      content: '已经写完整的一章。',
      outlineNodeId: chapterNode.id,
      status: 'done',
    });
    const user = await enterEditor();
    // 进编辑器时确实是「已完成」
    expect(screen.getByRole('button', { name: '已完成' })).toBeInTheDocument();

    await generateAndAdopt(
      user,
      { deltas: ['只写了一半的正文。'], finishReason: 'length' },
      '替换正文',
    );

    // 与二次确认文案「采用后本章仍是草稿」一致
    expect(await screen.findByText(HINT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '草稿' })).toBeInTheDocument();
    await waitFor(async () => {
      const stored = (await chapters()).find((item) => item.id === existing.id);
      expect(stored?.status).toBe('draft');
      expect(stored?.content).toBe('只写了一半的正文。');
    });
    // 退回草稿不触发摘要生成（摘要只在作者重新标「已完成」时生成）
    expect(screen.queryByRole('dialog', { name: '本章摘要' })).not.toBeInTheDocument();
  });

  it('draft 章采用截断稿：状态保持草稿，正文写入并由提示留痕', async () => {
    const user = await enterEditor();
    await adoptTruncated(user);

    expect(await screen.findByText(HINT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '草稿' })).toBeInTheDocument();
    await waitFor(async () => {
      const stored = (await chapters())[0];
      expect(stored?.status).toBe('draft');
      expect(stored?.content).toBe('只写了一半的正文。');
    });
  });
});
