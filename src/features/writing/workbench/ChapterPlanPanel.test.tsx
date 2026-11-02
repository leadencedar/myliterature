import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Chapter, KnowledgeEntry, OutlineNode } from '@/domain/schema';
import { ChapterPlanPanel } from './ChapterPlanPanel';

const chapter = {
  id: 'c1',
  novelId: 'n1',
  index: 1,
  title: '雪夜',
  content: '',
  note: '',
  wordCount: 0,
  status: 'draft',
  sideStoryId: null,
  outlineNodeId: 'o1',
} as unknown as Chapter;

const outlineNode = {
  id: 'o1',
  novelId: 'n1',
  title: '第1章',
  synopsis: '旧城雨夜，林照回到书店，发现那封信。',
  linkedEntryIds: ['e1', 'e2'],
  targetWords: 3000,
} as unknown as OutlineNode;

const entries = [
  { id: 'e1', title: '人物·林照' },
  { id: 'e2', title: '地点·旧城书店' },
] as unknown as KnowledgeEntry[];

function renderPanel(overrides: Partial<Parameters<typeof ChapterPlanPanel>[0]> = {}) {
  const onSaveGoal = vi.fn().mockResolvedValue(true);
  const onSaveNote = vi.fn().mockResolvedValue(true);
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <ChapterPlanPanel
        chapter={chapter}
        outlineNode={outlineNode}
        linkedEntries={entries}
        sideBrief=""
        onSaveGoal={onSaveGoal}
        onSaveNote={onSaveNote}
        onClose={onClose}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onSaveGoal, onSaveNote, onClose };
}

describe('右栏「本章」', () => {
  it('默认展开本章目标，可编辑保存并回到摘要', async () => {
    const user = userEvent.setup();
    const { onSaveGoal } = renderPanel();

    expect(screen.getByText(outlineNode.synopsis)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '编辑' }));

    const goal = screen.getByLabelText('本章目标');
    await user.clear(goal);
    await user.type(goal, '新目标：先写雨夜归店。');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onSaveGoal).toHaveBeenCalledWith('新目标：先写雨夜归店。');
    expect(await screen.findByText('新目标：先写雨夜归店。')).toBeInTheDocument();
    expect(screen.queryByLabelText('本章目标')).not.toBeInTheDocument();
  });

  it('资料显示计数与条目，完整列表走知识库', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /资料/u }));

    expect(screen.getByText('2 条')).toBeInTheDocument();
    expect(screen.getByText('人物·林照')).toBeInTheDocument();
    expect(screen.getByText('地点·旧城书店')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /查看全部资料/u })).toHaveAttribute(
      'href',
      '/knowledge',
    );
  });

  it('作者备忘可编辑保存，内容只留在本章', async () => {
    const user = userEvent.setup();
    const { onSaveNote } = renderPanel();

    await user.click(screen.getByRole('button', { name: /作者备忘/u }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const memo = screen.getByLabelText('作者备忘');
    await user.type(memo, '明天回来删掉第三段。');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onSaveNote).toHaveBeenCalledWith('明天回来删掉第三段。');
    expect(screen.queryByLabelText('作者备忘')).not.toBeInTheDocument();
  });

  it('保存失败时保留编辑态并提示', async () => {
    const user = userEvent.setup();
    const failingSave = vi.fn().mockResolvedValue(false);
    renderPanel({ onSaveNote: failingSave });

    await user.click(screen.getByRole('button', { name: /作者备忘/u }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.type(screen.getByLabelText('作者备忘'), '这段不能丢。');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(failingSave).toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('作者备忘保存失败');
    expect(screen.getByLabelText('作者备忘')).toBeInTheDocument();
  });

  it('关闭按钮把控制权交回工作台', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();

    await user.click(screen.getByRole('button', { name: '关闭本章面板' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
