import { useEffect, useId, useRef, type ReactNode } from 'react';
import { create } from 'zustand';
import { Button, IconButton } from './Button';
import { CloseIcon } from './icons';

/**
 * 当前打开的弹层数量。
 *
 * 用途是让页面级的「待确认」等入口在弹层打开时不渲染：抽屉本身可能也内嵌
 * 一个确认面板，两处同时存在会让同一条内容出现两个确认入口 —— 视觉上被遮住了，
 * 但读屏与自动化都能同时看到两份，用户也可能误操作两次。
 */
interface ModalCountState {
  count: number;
  push: () => void;
  pop: () => void;
}

const useModalCount = create<ModalCountState>((set) => ({
  count: 0,
  push: () => set((state) => ({ count: state.count + 1 })),
  pop: () => set((state) => ({ count: Math.max(0, state.count - 1) })),
}));

/** 是否有任何弹层处于打开状态 */
export function useAnyModalOpen(): boolean {
  return useModalCount((state) => state.count > 0);
}

/**
 * 桌面端的呈现形态。窄屏两者都是底部抽屉，差异只在 `lg` 以上。
 * - `drawer`：右侧竖直面板，撑满视口高度。内容多、要边看边改的场景用它
 * - `dialog`：居中小窗。只有一两句话加两个按钮的场景用它 —— 把一句确认文案
 *   拉成一条 1080px 高的右侧长条，荒谬且难读
 */
type SheetSize = 'drawer' | 'dialog';

interface SheetProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  /** 底部操作区 */
  footer?: ReactNode;
  size?: SheetSize;
  children?: ReactNode;
}

const CONTAINER_LAYOUT: Record<SheetSize, string> = {
  drawer: 'lg:items-stretch lg:justify-end',
  dialog: 'lg:items-center lg:justify-center',
};

const PANEL_LAYOUT: Record<SheetSize, string> = {
  drawer: 'lg:h-dvh lg:max-h-none lg:w-[28rem] lg:rounded-none lg:rounded-l-3xl',
  dialog: 'lg:max-h-[80dvh] lg:w-[32rem] lg:rounded-3xl',
};

/**
 * 抽屉 / 对话框。
 *
 * 窄屏一律从底部升起：更贴近拇指操作区，且键盘弹出时不会把内容顶出屏幕。
 * `lg` 以上换成右侧抽屉或居中对话框 —— 底部抽屉在宽屏上会变成一条贴着
 * 屏幕下沿的横带，视线要从页面中央一路扫到底，反而比居中更费劲。
 */
export function Sheet({
  open,
  title,
  description,
  onClose,
  footer,
  size = 'drawer',
  children,
}: SheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc 关闭 + 打开期间锁定背景滚动 + 登记到全局弹层计数
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      /**
       * 正在用输入法组字时不关闭。
       *
       * 中文输入法把 Esc 当作「取消当前候选词」，写作场景下这个键会被频繁按到。
       * 如果此时关掉弹层，用户一次误触就会丢掉整段还没提交的输入 ——
       * 而他本来只是想撤掉一个选错的词。
       */
      if (event.isComposing) return;
      onClose();
    }
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    useModalCount.getState().push();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      useModalCount.getState().pop();
    };
  }, [open, onClose]);

  // 打开后把焦点移入面板，读屏与键盘用户才能接管
  useEffect(() => {
    if (!open) return;
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className={`fixed inset-0 z-50 flex items-end ${CONTAINER_LAYOUT[size]}`}>
      {/* 背景遮罩点击可关闭。刻意不做成 button 也不暴露给读屏：
          键盘与读屏用户已有 Esc 和标题栏的关闭按钮两条通路，
          再加一个同名控件只会制造重复的可聚焦元素。 */}
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-ink-900/40" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={[
          'relative z-10 max-h-[88dvh] w-full overflow-y-auto rounded-t-3xl bg-paper-raised shadow-2xl',
          'pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] lg:pb-4',
          PANEL_LAYOUT[size],
        ].join(' ')}
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-ink-100 bg-paper-raised px-4 pt-4 pb-3 lg:px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-ink-500">
                {description}
              </p>
            ) : null}
          </div>
          {/* 用图标关闭而非文字「取消」：确认类对话框底部已有「取消」按钮，
              两个同名控件会让读屏用户和自动化测试都无法区分 */}
          <IconButton label="关闭" onClick={onClose} className="-mt-1 -mr-1 shrink-0">
            <CloseIcon className="h-5 w-5" />
          </IconButton>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4 lg:px-5">{children}</div>

        {/* 桌面端的右侧抽屉可能有整屏高度，主操作钉在底部才不用滚到最下面去找 */}
        {footer ? (
          <div className="flex gap-2 px-4 pb-2 lg:sticky lg:bottom-0 lg:bg-paper-raised lg:px-5 lg:pt-2">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 确认对话框。破坏性操作统一走它，避免各页面各写一套提示。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet
      open={open}
      title={title}
      onClose={onCancel}
      // 一句确认文案 + 两个按钮，桌面端居中小窗比整屏高的右侧长条合理得多
      size="dialog"
      footer={
        <>
          <Button variant="secondary" size="lg" block onClick={onCancel}>
            取消
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} size="lg" block onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-700">{message}</p>
    </Sheet>
  );
}
