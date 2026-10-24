import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { ConfirmDialog, Sheet, useAnyModalOpen } from './Sheet';

afterEach(() => {
  // 弹层会锁定 body 滚动，避免用例之间互相污染
  document.body.style.overflow = '';
});

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

describe('抽屉基本行为', () => {
  it('打开时暴露为模态对话框，带标题与描述', () => {
    render(
      <Sheet open title="调整计划" description="只用于本地提醒。" onClose={() => {}}>
        <p>内容</p>
      </Sheet>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('调整计划')).toBeInTheDocument();
    expect(within(dialog).getByText('只用于本地提醒。')).toBeInTheDocument();
  });

  it('关闭时整个弹层不渲染', () => {
    render(
      <Sheet open={false} title="调整计划" onClose={() => {}}>
        <p>内容</p>
      </Sheet>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('标题栏的关闭按钮触发 onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Sheet open title="调整计划" onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('底部操作区按传入内容渲染', () => {
    render(
      <Sheet open title="调整计划" onClose={() => {}} footer={<Button>保存</Button>}>
        <p>内容</p>
      </Sheet>,
    );
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
  });

  it('打开期间锁定背景滚动，关闭后恢复', () => {
    const { rerender } = render(<Sheet open title="调整计划" onClose={() => {}} />);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<Sheet open={false} title="调整计划" onClose={() => {}} />);
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});

describe('Esc 关闭与输入法', () => {
  it('按 Esc 关闭', () => {
    const onClose = vi.fn();
    render(<Sheet open title="调整计划" onClose={onClose} />);

    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('正在用输入法组字时按 Esc 不关闭', () => {
    const onClose = vi.fn();
    render(<Sheet open title="调整计划" onClose={onClose} />);

    // 中文输入法用 Esc 取消候选词。此时关掉弹层，用户一次误触就会
    // 丢掉整段还没提交的输入 —— 而他只是想撤掉一个选错的词
    press('Escape', { isComposing: true });
    expect(onClose).not.toHaveBeenCalled();

    // 组字结束后仍然可以正常关闭
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('其他按键不关闭', () => {
    const onClose = vi.fn();
    render(<Sheet open title="调整计划" onClose={onClose} />);

    press('Enter');
    press('s', { metaKey: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('关闭后不再响应 Esc', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Sheet open title="调整计划" onClose={onClose} />);
    rerender(<Sheet open={false} title="调整计划" onClose={onClose} />);

    press('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('全局弹层计数', () => {
  function Probe() {
    return <span data-testid="probe">{useAnyModalOpen() ? '有弹层' : '无弹层'}</span>;
  }

  it('打开弹层时页面级入口能感知到', () => {
    const { rerender } = render(
      <>
        <Probe />
        <Sheet open={false} title="调整计划" onClose={() => {}} />
      </>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('无弹层');

    rerender(
      <>
        <Probe />
        <Sheet open title="调整计划" onClose={() => {}} />
      </>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('有弹层');
  });

  it('弹层关闭后计数归零', () => {
    const { rerender } = render(
      <>
        <Probe />
        <Sheet open title="调整计划" onClose={() => {}} />
      </>,
    );
    rerender(
      <>
        <Probe />
        <Sheet open={false} title="调整计划" onClose={() => {}} />
      </>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('无弹层');
  });
});

describe('确认对话框', () => {
  it('确认与取消分别回调', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <ConfirmDialog
        open
        title="删除这本书？"
        message="无法恢复。"
        confirmLabel="永久删除"
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('无法恢复。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '永久删除' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('标题栏只有图标式「关闭」，不与底部的「取消」重名', () => {
    render(
      <ConfirmDialog
        open
        title="删除这本书？"
        message="无法恢复。"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // 同名可聚焦控件会让读屏与自动化都无法区分
    expect(screen.getAllByRole('button', { name: '取消' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });
});

describe('遮罩', () => {
  it('遮罩可点击关闭，但不暴露给读屏', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Sheet open title="调整计划" onClose={onClose} />);

    const overlay = container.querySelector('[aria-hidden="true"]');
    expect(overlay).not.toBeNull();
    await user.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);

    // 键盘与读屏用户已有 Esc 和标题栏关闭按钮两条通路，遮罩不该再成为一个可聚焦控件
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
