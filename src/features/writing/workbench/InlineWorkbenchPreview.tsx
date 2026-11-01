import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChapterEditorScreen, type ChapterEditorHandle } from '../ChapterEditorScreen';
import { WorkbenchShell, type WorkbenchChapterGroup } from './WorkbenchShell';

type EditorProps = ComponentProps<typeof ChapterEditorScreen>;

interface InlineWorkbenchPreviewProps {
  workTitle: string;
  railTitle?: string;
  groups: readonly WorkbenchChapterGroup[];
  railFooter?: ReactNode;
  /** 复用编辑器全部 props；presentation / editorRef 由本组件接管 */
  editor: Omit<EditorProps, 'presentation' | 'editorRef'>;
  onSwitchChapter: (chapterId: string) => void;
}

/**
 * 阶段 2 的开发预览：工作台壳 + 内联编辑器。
 *
 * 只在 `/write?inline-editor=1`（DEV/测试环境）下由 WritingPage 懒加载；
 * 不进入生产 bundle。切章前先让编辑器 flush，保存失败就不切。
 *
 * 离开当前页（点主导航链接）时，若有未保存内容，先弹出「保存并离开 / 放弃 /
 * 继续编辑」。浏览器关闭/刷新由 beforeunload 兜底；浏览器后退暂未拦截。
 */
export function InlineWorkbenchPreview({
  workTitle,
  railTitle,
  groups,
  railFooter,
  editor,
  onSwitchChapter,
}: InlineWorkbenchPreviewProps) {
  const navigate = useNavigate();
  const editorRef = useRef<ChapterEditorHandle | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [leaveHref, setLeaveHref] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  async function switchChapter(chapterId: string) {
    if (chapterId === editor.chapter.id) return;
    const canLeave = await editorRef.current?.flush();
    if (canLeave === false) return;
    onSwitchChapter(chapterId);
  }

  // 有未保存内容时拦截站内链接（主导航、页面内链），不让路由先卸载编辑器
  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      const anchor =
        target instanceof Element ? (target.closest('a[href]') as HTMLAnchorElement | null) : null;
      if (!anchor || anchor.hasAttribute('download') || anchor.target === '_blank') return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      if (!editorRef.current?.hasPendingChanges()) return;

      const next = new URL(href, window.location.href);
      if (next.origin !== window.location.origin) return;
      if (next.pathname === window.location.pathname && next.search === window.location.search) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setLeaveError(null);
      setLeaveHref(href);
    }

    document.addEventListener('click', onDocumentClick, true);
    return () => document.removeEventListener('click', onDocumentClick, true);
  }, []);

  // 关闭/刷新标签页时的兜底；SPA 内导航由上面的点击拦截处理
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!editorRef.current?.hasPendingChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // 离开确认弹层：默认把焦点放到「继续编辑」，Esc 取消
  useEffect(() => {
    if (!leaveHref) return;
    cancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return;
      setLeaveHref(null);
      setLeaveError(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [leaveHref]);

  async function saveAndLeave() {
    if (!leaveHref || !editorRef.current) return;
    setLeaving(true);
    setLeaveError(null);
    const saved = await editorRef.current.flush();
    if (!saved) {
      setLeaving(false);
      setLeaveError('保存失败，请重试；或选择放弃本次修改。');
      return;
    }
    navigate(leaveHref);
  }

  function discardAndLeave() {
    if (!leaveHref) return;
    editorRef.current?.discard();
    navigate(leaveHref);
  }

  return (
    <>
      <WorkbenchShell
        workTitle={workTitle}
        railTitle={railTitle}
        groups={groups}
        railFooter={railFooter}
        onSelectChapter={(chapterId) => void switchChapter(chapterId)}
      >
        <ChapterEditorScreen
          key={editor.chapter.id}
          {...editor}
          presentation="inline"
          editorRef={editorRef}
        />
      </WorkbenchShell>

      {leaveHref ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-ink-900/30 px-4"
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="wb-leave-title"
            className="w-full max-w-md rounded-xl bg-paper-raised p-5 shadow-xl"
          >
            <h2 id="wb-leave-title" className="text-base font-semibold text-ink-900">
              还有内容没保存
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-500">
              先保存再离开，或者放弃这次未保存的修改。关闭对话框可以继续写。
            </p>
            {leaveError ? (
              <p
                role="alert"
                className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent"
              >
                {leaveError}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                disabled={leaving}
                onClick={() => {
                  setLeaveHref(null);
                  setLeaveError(null);
                }}
                className="rounded-lg px-3 py-2 text-sm text-ink-500 disabled:opacity-50"
              >
                继续编辑
              </button>
              <button
                type="button"
                disabled={leaving}
                onClick={discardAndLeave}
                className="rounded-lg border border-ink-100 bg-paper px-3 py-2 text-sm text-ink-700 disabled:opacity-50"
              >
                放弃修改并离开
              </button>
              <button
                type="button"
                disabled={leaving}
                onClick={() => void saveAndLeave()}
                className="rounded-lg bg-ink-900 px-3 py-2 text-sm font-medium text-paper disabled:opacity-50"
              >
                {leaving ? '正在保存…' : '保存并离开'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
