import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { KnowledgeEntry, OutlineNode } from '@/domain/schema';
import { ChapterEditorScreen, type ChapterEditorHandle } from '../ChapterEditorScreen';
import { Sheet } from '@/ui/Sheet';
import { ChapterPlanPanel } from './ChapterPlanPanel';
import {
  WorkbenchShell,
  type WorkbenchChapterGroup,
  type WorkbenchRailTab,
} from './WorkbenchShell';

type EditorProps = ComponentProps<typeof ChapterEditorScreen>;

interface WritingWorkbenchProps {
  workTitle: string;
  railTitle?: string;
  groups: readonly WorkbenchChapterGroup[];
  railFooter?: ReactNode;
  /** 复用编辑器全部 props；presentation / editorRef 由本组件接管 */
  editor: Omit<EditorProps, 'presentation' | 'editorRef'>;
  onSwitchChapter: (chapterId: string) => void;
  /** 把编辑器命令面交给父级（新建章节前 flush 用） */
  onEditorHandle?: (handle: ChapterEditorHandle | null) => void;
  /** 页头动作：推演 / 待确认 / 导出等 */
  headerActions?: ReactNode;
  /** 左栏视图切换 */
  railTabs?: readonly WorkbenchRailTab[];
  outlineView?: ReactNode;
  /** 章节视图底部动作 */
  railActions?: ReactNode;
  /** 右栏「本章」数据；不传则不显示本章面板 */
  panel?: {
    outlineNode?: OutlineNode;
    linkedEntries: readonly KnowledgeEntry[];
    sideBrief: string;
    onSaveGoal: (next: string) => Promise<boolean>;
  };
}

/**
 * 写作工作台：章节栏 + 中栏编辑器 + 右栏「本章」。
 *
 * 阶段 3 起是 `/write` 打开章节后的默认形态（不再需要 dev 查询参数）。
 * 切章前先让编辑器 flush，保存失败就不切；离开站内链接时先确认未保存内容，
 * beforeunload 兜底关闭/刷新；浏览器后退暂未拦截。
 */
export function WritingWorkbench({
  workTitle,
  railTitle,
  groups,
  railFooter,
  editor,
  onSwitchChapter,
  onEditorHandle,
  headerActions,
  railTabs,
  outlineView,
  railActions,
  panel,
}: WritingWorkbenchProps) {
  const navigate = useNavigate();
  const editorRef = useRef<ChapterEditorHandle | null>(null);

  // 把 flush/hasPendingChanges 交给写作页：新建章节前也要先保存当前章
  useEffect(() => {
    onEditorHandle?.(editorRef.current);
  }, [editor.chapter.id, onEditorHandle]);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [leaveHref, setLeaveHref] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
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
        headerActions={headerActions}
        railTabs={railTabs}
        outlineView={outlineView}
        railActions={railActions}
        onOpenAi={() => setAiOpen(true)}
        sidePanel={
          panel
            ? (close) => (
                <ChapterPlanPanel
                  chapter={editor.chapter}
                  outlineNode={panel.outlineNode}
                  linkedEntries={panel.linkedEntries}
                  sideBrief={panel.sideBrief}
                  onSaveGoal={panel.onSaveGoal}
                  onSaveNote={async (next) => (await editorRef.current?.saveNote(next)) ?? false}
                  onClose={close}
                />
              )
            : undefined
        }
      >
        <ChapterEditorScreen
          key={editor.chapter.id}
          {...editor}
          presentation="inline"
          editorRef={editorRef}
        />
      </WorkbenchShell>

      <Sheet
        open={aiOpen}
        title="AI 写作"
        description="选一个动作；生成/加工面板保持现有完整能力。"
        onClose={() => setAiOpen(false)}
        size="dialog"
      >
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              setAiOpen(false);
              editorRef.current?.openGenerate();
            }}
            className="rounded-lg bg-ink-900 px-3 py-2.5 text-sm font-medium text-paper"
          >
            生成本章
          </button>
          <button
            type="button"
            onClick={() => {
              setAiOpen(false);
              editorRef.current?.openRevise();
            }}
            className="rounded-lg border border-ink-100 bg-paper px-3 py-2.5 text-sm text-ink-700"
          >
            加工这一段
          </button>
        </div>
      </Sheet>

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
