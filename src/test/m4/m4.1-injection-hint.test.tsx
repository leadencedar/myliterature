/**
 * M4.1-S2 独立验收：注入清单的「文风锚点只用于对齐语感，不会复述其中情节」说明。
 *
 * 覆盖 task-77：说明只在含锚点时出现；无锚点（第一章/无更早正文）不显示；
 * 本次注入的锚点 label 与锚点选择一致。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Novel } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { WritingPage } from '@/features/writing/WritingPage';

let harness: TestHarness;
let novel: Novel;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '注入提示之书', genre: '仙侠' });
  useActiveNovel.setState({ activeNovelId: novel.id });
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

const HINT = '文风锚点只用于对齐语感，不会复述其中情节。';

async function makeChapter(title: string, content: string, status: 'draft' | 'done' = 'draft') {
  const created = await harness.repository.createChapter(novel.id, { title, content });
  if (status === 'done') await harness.repository.updateChapter(created.id, { status: 'done' });
}

async function openGenerateSheet(buttonName: string) {
  const user = userEvent.setup();
  harness.renderUI(<WritingPage />, '/write');
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  await user.click(await screen.findByRole('button', { name: buttonName }));
  await screen.findByLabelText('章节正文');
  await user.click(screen.getByRole('button', { name: '生成本章' }));
  const dialog = await screen.findByRole('dialog', { name: '生成本章正文' });
  await within(dialog).findByText('本次注入');
  return { user, dialog };
}

describe('M4.1 · 注入清单锚点说明显隐', () => {
  it('有锚点时显示说明与「文风锚点 · 第 N 章开头」', async () => {
    // 首章已完成且开头含对白 → 成为锚点（M4.1 对白优先）
    await makeChapter('源头', `「官凭。」\n\n${'江雾'.repeat(200)}`, 'done');
    await makeChapter('目标章', '目标章正文。');
    const { dialog } = await openGenerateSheet('继续写第 2 章');

    expect(within(dialog).getByText('文风锚点 · 第 1 章开头')).toBeInTheDocument();
    expect(within(dialog).getByText(HINT)).toBeInTheDocument();
  });

  it('无锚点（第一章）：不显示锚点行与说明', async () => {
    await makeChapter('第一章', '第一章正文，没有更早内容。');
    const { dialog } = await openGenerateSheet('继续写第 1 章');

    expect(within(dialog).queryByText(/文风锚点 · 第 \d+ 章开头/u)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(HINT)).not.toBeInTheDocument();
  });
});
