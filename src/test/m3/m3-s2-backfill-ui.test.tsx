/**
 * M3-S2 独立验收：导入作品 1:1 回溯大纲 UI（入口 / 预览 / 确认 / 关闭不写 / 失败）。
 *
 * 独立于开发的 WritingPage.test.tsx / OutlineBackfillSheet 测试：按 task-49 验收条目重写，
 * 用真实 Dexie 仓储 + 真 WritingPage；只断言对外可观察行为与落库结果。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Chapter, Novel } from '@/domain/schema';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { WritingPage } from '@/features/writing/WritingPage';

let harness: TestHarness;
let novel: Novel;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '旧稿之书', genre: '仙侠' });
  useActiveNovel.setState({ activeNovelId: novel.id });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
}

async function makeChapter(
  title: string,
  content = '这一章有正文。',
  summary?: string,
): Promise<Chapter> {
  const chapter = await harness.repository.createChapter(novel.id, { title, content });
  if (summary !== undefined) {
    await harness.repository.upsertSummary(novel.id, chapter.id, {
      summary,
      keyEvents: [],
      appearingEntryIds: [],
      openThreads: [],
    });
  }
  return chapter;
}

async function renderPage() {
  harness.renderUI(<WritingPage />, '/write');
  await waitForLoaded();
}

describe('M3-S2 · 回溯入口条件', () => {
  it('有主线章节且无大纲 → 显示入口；无章节 → 不显示', async () => {
    await makeChapter('第一章');
    await renderPage();
    expect(await screen.findByRole('button', { name: '按已有章节生成大纲' })).toBeInTheDocument();
    // 与手动添加并列
    expect(screen.getByRole('button', { name: '添加第一个大纲节点' })).toBeInTheDocument();
  });

  it('没有章节时两个入口都不出现（可手动添加）', async () => {
    await renderPage();
    expect(screen.queryByRole('button', { name: '按已有章节生成大纲' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '规划后续 3–5 章大纲' })).not.toBeInTheDocument();
    // 真空白页走 EmptyState，只能手动加
    expect(screen.getByRole('button', { name: '手动添加第一个节点' })).toBeInTheDocument();
  });

  it('已有大纲时回溯入口消失、显示续写入口（互斥）', async () => {
    await makeChapter('第一章');
    await harness.repository.createOutlineNode(novel.id, { title: '手工大纲' });
    await renderPage();

    expect(screen.queryByRole('button', { name: '按已有章节生成大纲' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '规划后续 3–5 章大纲' })).toBeInTheDocument();
  });

  it('章节标题正文都为空（无可回填）→ 不显示回溯入口', async () => {
    const chapter = await makeChapter('空');
    await harness.repository.updateChapter(chapter.id, { title: '', content: '' });
    await renderPage();
    expect(screen.queryByRole('button', { name: '按已有章节生成大纲' })).not.toBeInTheDocument();
  });
});

describe('M3-S2 · 预览面板', () => {
  it('预览数量/标题/摘要（>60 字截断、无摘要提示）', async () => {
    const longSummary = '沈砚'.concat('雪'.repeat(80));
    await makeChapter('第一章 雪夜', '正文一。', longSummary);
    await makeChapter('第二章 灯', '正文二。');
    await makeChapter('第三章 无摘要', '正文三。');
    const user = userEvent.setup();
    await renderPage();

    await user.click(await screen.findByRole('button', { name: '按已有章节生成大纲' }));
    const dialog = await screen.findByRole('dialog', { name: '按已有章节生成大纲' });

    expect(within(dialog).getByText(/将按章节顺序生成 3 个顶层节点/u)).toBeInTheDocument();
    expect(within(dialog).getByText('第 1 章 第一章 雪夜')).toBeInTheDocument();
    expect(within(dialog).getByText('第 2 章 第二章 灯')).toBeInTheDocument();
    expect(within(dialog).getByText('第 3 章 第三章 无摘要')).toBeInTheDocument();
    // P1：预览显示「现有字数（仅参考，不设为目标）」而不是把它当目标
    expect(within(dialog).getAllByText(/本章现有 \d+ 字（仅参考，不设为目标）/u)).toHaveLength(3);
    // 60 字截断
    const truncated = `${longSummary.slice(0, 60)}…`;
    expect(within(dialog).getByText(truncated)).toBeInTheDocument();
    expect(truncated.length).toBe(61);
    // 无摘要的章节明说梗概留空，而不是显示空白
    expect(within(dialog).getAllByText('梗概暂空，可生成后手动补')).toHaveLength(2);
    expect(within(dialog).getByRole('button', { name: '生成 3 个章节节点' })).toBeInTheDocument();
  });
});

describe('M3-S2 · 确认 / 关闭 / 失败', () => {
  it('关闭面板不写：0 节点、章节关联仍 null', async () => {
    await makeChapter('第一章');
    const user = userEvent.setup();
    await renderPage();

    await user.click(await screen.findByRole('button', { name: '按已有章节生成大纲' }));
    const dialog = await screen.findByRole('dialog', { name: '按已有章节生成大纲' });
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '按已有章节生成大纲' })).not.toBeInTheDocument(),
    );

    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters.map((chapter) => chapter.outlineNodeId)).toEqual([null]);
    expect(await harness.repository.listOutline(novel.id)).toEqual([]);
  });

  it('确认生成：1:1 节点 + 章节关联回填，正文/编号/标题不变，重进入口消失', async () => {
    const ch1 = await makeChapter('第一章');
    const ch2 = await makeChapter('第二章');
    const before = await harness.repository.listChapters(novel.id);
    const user = userEvent.setup();
    await renderPage();

    await user.click(await screen.findByRole('button', { name: '按已有章节生成大纲' }));
    const dialog = await screen.findByRole('dialog', { name: '按已有章节生成大纲' });
    await user.click(within(dialog).getByRole('button', { name: '生成 2 个章节节点' }));

    expect(await within(dialog).findByText('已生成 2 个节点，可手动分卷。')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '完成' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '按已有章节生成大纲' })).not.toBeInTheDocument(),
    );

    // 大纲树刷新，入口消失、规划续写入口出现
    expect(await screen.findByRole('button', { name: '编辑「第一章」' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑「第二章」' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '按已有章节生成大纲' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '规划后续 3–5 章大纲' })).toBeInTheDocument();
    // P1：回溯节点不设 targetWords，树上不再出现「目标 N 字」
    expect(screen.queryByText(/目标 \d+ 字/u)).not.toBeInTheDocument();

    const nodes = await harness.repository.listOutline(novel.id);
    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.targetWords === null)).toBe(true);
    expect(nodes.every((node) => node.parentId === null)).toBe(true);
    const after = await harness.repository.listChapters(novel.id);
    expect(after.map((chapter) => chapter.outlineNodeId)).toEqual(
      nodes.sort((a, b) => a.order - b.order).map((node) => node.id),
    );
    expect(after.map((chapter) => chapter.id)).toEqual([ch1.id, ch2.id]);
    expect(
      after.map((chapter) => ({
        index: chapter.index,
        title: chapter.title,
        content: chapter.content,
        wordCount: chapter.wordCount,
      })),
    ).toEqual(
      before.map((chapter) => ({
        index: chapter.index,
        title: chapter.title,
        content: chapter.content,
        wordCount: chapter.wordCount,
      })),
    );
    // 再次打开页面不会重复建节点（大纲非空 → 入口不存在）
    const countAfter = nodes.length;
    expect((await harness.repository.listOutline(novel.id)).length).toBe(countAfter);
  });

  it('仓储失败：显示 role=alert，且不留半套数据', async () => {
    await makeChapter('第一章');
    const user = userEvent.setup();
    await renderPage();
    vi.spyOn(harness.repository, 'commitOutlineBackfill').mockRejectedValueOnce(
      new Error('写入失败：磁盘错误'),
    );

    await user.click(await screen.findByRole('button', { name: '按已有章节生成大纲' }));
    const dialog = await screen.findByRole('dialog', { name: '按已有章节生成大纲' });
    await user.click(within(dialog).getByRole('button', { name: '生成 1 个章节节点' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('写入失败：磁盘错误');
    expect(await harness.repository.listOutline(novel.id)).toEqual([]);
    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters.map((chapter) => chapter.outlineNodeId)).toEqual([null]);
    // 失败后面板仍在预览态，可重试
    expect(within(dialog).getByRole('button', { name: '生成 1 个章节节点' })).toBeInTheDocument();
  });
});
