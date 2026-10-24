import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Novel } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { normTokens } from '@/prompt/sections';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { NORM_FIXTURE, NORM_FIXTURE_MARKER, createFixtureNorm } from '@/test/writingNormFixtures';
import { WritingPage } from './WritingPage';

/**
 * 写作规范的端到端注入：从仓储里的一份规范，到真正发出去的请求体。
 * 单元测试已经覆盖了渲染与构建器；这里守的是「数据流接线」——
 * WritingPage 查询、编辑器透传、面板本地的临时取消、摘要发请求前重读。
 */

let harness: TestHarness;
let novel: Novel;

const INITIAL = '第一段的内容。\n\n第二段的内容。\n\n第三段的内容。';

const SUMMARY_RESULT = {
  summary: '主角负伤逃入雪山。',
  keyEvents: ['遭遇追兵'],
  appearingEntries: [],
  newOpenThreads: [],
  resolvedThreads: [],
  rollingSummary: '开篇主角被追杀。',
};

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });

  const worldCategory = (await harness.repository.listCategories(novel.id))[0]!;
  // 核心设定让【必须遵守的核心设定】出现，才能断言规范排在它之前
  await harness.repository.createEntry(novel.id, {
    categoryId: worldCategory.id,
    title: '灵气',
    summary: '天地能量',
    pinned: true,
  });
  const node = await harness.repository.createOutlineNode(novel.id, {
    title: '第1章 雪夜',
    synopsis: '追兵临门。',
    targetWords: 3000,
  });
  await harness.repository.createChapter(novel.id, {
    title: '第1章 雪夜',
    content: INITIAL,
    outlineNodeId: node.id,
  });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

/** 流式请求（整章生成、段落加工）回一段正文，结构化请求（摘要）回 JSON */
function stubFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
    return Promise.resolve(
      request.stream
        ? sseResponse(textDeltaEvents(['生成的正文。']))
        : jsonResponse(completion(JSON.stringify(SUMMARY_RESULT))),
    );
  });
}

function systemOf(spy: ReturnType<typeof stubFetch>, index: number): string {
  const body = JSON.parse(String(spy.mock.calls[index]?.[1]?.body ?? '{}')) as {
    messages?: { role: string; content: string }[];
  };
  return body.messages?.find((message) => message.role === 'system')?.content ?? '';
}

async function openEditor() {
  const user = userEvent.setup();
  harness.renderUI(<WritingPage />);
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  await user.click(await screen.findByRole('button', { name: '继续写第 1 章' }));
  await screen.findByLabelText('章节正文');
  return user;
}

async function openGenerate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '生成本章' }));
  return screen.findByRole('dialog', { name: '生成本章正文' });
}

/** 在正文里选中一段并打开加工抽屉 */
async function openRevise(user: ReturnType<typeof userEvent.setup>, phrase = '第二段的内容。') {
  const textarea = screen.getByLabelText('章节正文') as HTMLTextAreaElement;
  const start = textarea.value.indexOf(phrase);
  textarea.setSelectionRange(start, start + phrase.length);
  await user.click(screen.getByRole('button', { name: '加工这一段' }));
  return screen.findByRole('dialog', { name: '加工这一段' });
}

function normChip(dialog: HTMLElement) {
  return within(dialog).getByRole('button', { name: /^使用提示（约 \d+ tokens）$/u });
}

async function normEnabled(): Promise<boolean | undefined> {
  const norms = await harness.repository.listWritingNorms(novel.id);
  return norms[0]?.enabled;
}

describe('整章生成', () => {
  it('注入清单列出规范与 token，请求按位置带上；临时取消后不带且库里仍启用', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const spy = stubFetch();
    const user = await openEditor();

    const dialog = await openGenerate(user);
    const item = within(dialog).getByText('写作规范 · 使用提示').closest('li')!;
    expect(item).toHaveTextContent(String(normTokens(NORM_FIXTURE)));
    expect(normChip(dialog)).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(dialog).getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');

    const system = systemOf(spy, 0);
    const at = system.indexOf(NORM_FIXTURE_MARKER);
    expect(at).toBeGreaterThan(system.indexOf('【作品信息】'));
    // 【结构方法】是风格档案里始终存在的最后一段
    expect(at).toBeGreaterThan(system.indexOf('【结构方法】'));
    expect(at).toBeLessThan(system.indexOf('【必须遵守的核心设定】'));

    // 回到设置、关掉再开：临时取消只影响这一次
    await user.click(screen.getByRole('button', { name: '放弃，重新设置' }));
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    const reopened = await openGenerate(user);
    await user.click(normChip(reopened));
    expect(normChip(reopened)).toHaveAttribute('aria-pressed', 'false');
    expect(within(reopened).queryByText('写作规范 · 使用提示')).not.toBeInTheDocument();

    await user.click(within(reopened).getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(systemOf(spy, 1)).not.toContain(NORM_FIXTURE_MARKER);
    expect(await normEnabled()).toBe(true);
  });

  it('关掉再打开面板，临时取消的规范恢复为带上', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const user = await openEditor();

    const dialog = await openGenerate(user);
    await user.click(normChip(dialog));
    expect(normChip(dialog)).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));

    const reopened = await openGenerate(user);
    expect(normChip(reopened)).toHaveAttribute('aria-pressed', 'true');
    expect(within(reopened).getByText('写作规范 · 使用提示')).toBeInTheDocument();
  });

  it('作用范围不含「写正文」时既不出现在面板里，也不进请求', async () => {
    await createFixtureNorm(harness.repository, novel.id, { scopes: ['extract'] });
    const spy = stubFetch();
    const user = await openEditor();

    const dialog = await openGenerate(user);
    expect(within(dialog).queryByText('写作规范 · 使用提示')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: /写作规范/u })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    expect(systemOf(spy, 0)).not.toContain(NORM_FIXTURE_MARKER);
  });
});

describe('段落加工', () => {
  it('请求的系统提示带上规范', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const spy = stubFetch();
    const user = await openEditor();

    const dialog = await openRevise(user);
    await user.click(within(dialog).getByRole('button', { name: '开始改写' }));
    await screen.findByLabelText('结果（可直接修改）');

    const system = systemOf(spy, 0);
    expect(system).toContain(NORM_FIXTURE_MARKER);
    expect(system.indexOf(NORM_FIXTURE_MARKER)).toBeLessThan(
      system.indexOf('【必须遵守的核心设定】'),
    );
  });

  it('临时取消后不带、库里仍启用；关开后恢复并再次带上', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const spy = stubFetch();
    const user = await openEditor();

    const dialog = await openRevise(user);
    expect(normChip(dialog)).toHaveAttribute('aria-pressed', 'true');
    await user.click(normChip(dialog));
    expect(normChip(dialog)).toHaveAttribute('aria-pressed', 'false');

    await user.click(within(dialog).getByRole('button', { name: '开始改写' }));
    await screen.findByLabelText('结果（可直接修改）');
    expect(systemOf(spy, 0)).not.toContain(NORM_FIXTURE_MARKER);
    expect(await normEnabled()).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    const reopened = await openRevise(user);
    expect(normChip(reopened)).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(reopened).getByRole('button', { name: '开始改写' }));
    await screen.findByLabelText('结果（可直接修改）');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(systemOf(spy, 1)).toContain(NORM_FIXTURE_MARKER);
  });
});

describe('章节摘要', () => {
  it('标记完成触发的摘要请求带上规范', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const spy = stubFetch();
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: '草稿' }));
    await screen.findByRole('button', { name: /保存摘要/u });

    const system = systemOf(spy, 0);
    expect(system).toContain(NORM_FIXTURE_MARKER);
    expect(system).toContain('不要写进摘要或伏笔');
    expect(system.indexOf(NORM_FIXTURE_MARKER)).toBeLessThan(system.indexOf('【任务】'));
  });

  it('作用范围不含章节摘要时不带', async () => {
    await createFixtureNorm(harness.repository, novel.id, { scopes: ['writing'] });
    const spy = stubFetch();
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: '草稿' }));
    await screen.findByRole('button', { name: /保存摘要/u });

    expect(systemOf(spy, 0)).not.toContain(NORM_FIXTURE_MARKER);
  });
});

describe('细化大纲', () => {
  async function openNode() {
    const user = userEvent.setup();
    harness.renderUI(<WritingPage />);
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: '编辑「第1章 雪夜」' }));
    await screen.findByRole('dialog', { name: '大纲节点' });
    return user;
  }

  it('没有规范时不显示「将带上」提示行', async () => {
    await openNode();
    expect(screen.queryByText(/将带上 \d+ 份写作规范/u)).not.toBeInTheDocument();
  });

  it('有规划规范时显示提示行，细化请求的系统提示带上规范', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          completion(
            JSON.stringify({
              children: [
                { title: '一', synopsis: '甲。', targetWords: null },
                { title: '二', synopsis: '乙。', targetWords: null },
              ],
            }),
          ),
        ),
      ),
    );
    const user = await openNode();

    expect(await screen.findByText(/将带上 1 份写作规范（约 \d+ tokens）/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '细化这一节点' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    const system = systemOf(spy, 0);
    expect(system).toContain(NORM_FIXTURE_MARKER);
    expect(system.indexOf(NORM_FIXTURE_MARKER)).toBeLessThan(system.indexOf('【任务】'));
  });
});
