import { useEffect, useRef, useState, type ReactNode } from 'react';
import './workbench.css';

export interface WorkbenchChapter {
  id: string;
  title: string;
  meta: string;
  current?: boolean;
}

export interface WorkbenchChapterGroup {
  key: string;
  title: string;
  chapters: readonly WorkbenchChapter[];
}

interface WorkbenchShellProps {
  workTitle: string;
  /** 章节栏标题；默认「章节」，预览壳可传卷名 */
  railTitle?: string;
  groups: readonly WorkbenchChapterGroup[];
  railFooter?: ReactNode;
  /** 点章节时由工作台父级决定（阶段 2：先 flush 再切章） */
  onSelectChapter?: (chapterId: string) => void;
  /** 右栏「本章」；传入后页头出现「本章」按钮 */
  sidePanel?: (close: () => void) => ReactNode;
  children: ReactNode;
}

/**
 * UI v2 工作台空壳（阶段 1 / T3–T4）。
 *
 * 只负责布局与章节栏开合；不含数据读取、编辑器逻辑或右栏。
 * - ≥1280px：章节栏常驻 240px；
 * - 1024–1279px：章节栏浮层，页头按钮打开，Esc 关闭并归还焦点；
 * - <1024px：单栏，章节栏浮层；全局导航由 AppShell 换成底部栏。
 */
export function WorkbenchShell({
  workTitle,
  railTitle = '章节',
  groups,
  railFooter,
  onSelectChapter,
  sidePanel,
  children,
}: WorkbenchShellProps) {
  const [railOpen, setRailOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const totalChapters = groups.reduce((sum, group) => sum + group.chapters.length, 0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  function closePanel() {
    setPanelOpen(false);
    window.requestAnimationFrame(() => panelToggleRef.current?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    if (!railOpen || panelOpen) return;

    const firstChapter = railRef.current?.querySelector<HTMLButtonElement>('button');
    firstChapter?.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      // 输入法组字时 Esc 用于取消候选，不应关闭浮层
      if (event.key !== 'Escape' || event.isComposing) return;
      setRailOpen(false);
      window.requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }));
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [railOpen, panelOpen]);

  // 右栏打开时聚焦其中第一个按钮；Esc 关闭并把焦点还给页头按钮
  useEffect(() => {
    if (!panelOpen) return;
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return;
      closePanel();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panelOpen]);

  return (
    <div
      className="wb-shell wb-scope"
      data-testid="workbench-root"
      data-rail-open={String(railOpen)}
      data-panel-open={String(panelOpen)}
    >
      <header className="wb-shell-header" data-testid="workbench-header">
        <div className="wb-shell-heading">
          <span className="wb-shell-app">写作</span>
          <h1 className="wb-shell-work">{workTitle}</h1>
        </div>
        <button
          ref={toggleRef}
          type="button"
          className="wb-shell-toggle"
          data-testid="rail-toggle"
          aria-expanded={railOpen}
          aria-controls="wb-chapter-rail"
          onClick={() => setRailOpen((open) => !open)}
        >
          章节
        </button>
        {sidePanel ? (
          <button
            ref={panelToggleRef}
            type="button"
            className="wb-shell-panel-toggle"
            data-testid="chapter-panel-toggle"
            aria-expanded={panelOpen}
            aria-controls="wb-chapter-panel"
            onClick={() => setPanelOpen((open) => !open)}
          >
            本章
          </button>
        ) : null}
      </header>

      <div className="wb-shell-body">
        <aside
          ref={railRef}
          id="wb-chapter-rail"
          className="wb-shell-rail"
          data-testid="chapter-rail"
          aria-label="章节"
        >
          <div className="wb-shell-rail-heading">
            <span>{railTitle}</span>
            <span>{totalChapters} 章</span>
          </div>
          {groups.map((group) => (
            <section key={group.key} className="wb-shell-group" aria-label={group.title}>
              <h3 className="wb-shell-group-title">{group.title}</h3>
              <ol className="wb-shell-chapters">
                {group.chapters.map((chapter, index) => (
                  <li key={chapter.id}>
                    <button
                      type="button"
                      className="wb-shell-chapter"
                      aria-current={chapter.current ? 'page' : undefined}
                      onClick={() => {
                        setRailOpen(false);
                        onSelectChapter?.(chapter.id);
                      }}
                    >
                      <span className="wb-shell-chapter-number">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="wb-shell-chapter-copy">
                        <strong>{chapter.title}</strong>
                        <small>{chapter.meta}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {railFooter ? <div className="wb-shell-rail-footer">{railFooter}</div> : null}
        </aside>

        <main id="main" className="wb-shell-editor" data-testid="editor-pane">
          {children}
        </main>
      </div>

      {sidePanel ? (
        <aside
          ref={panelRef}
          id="wb-chapter-panel"
          className="wb-shell-panel"
          data-testid="chapter-panel"
          aria-label="本章"
          aria-hidden={!panelOpen}
        >
          {sidePanel(closePanel)}
        </aside>
      ) : null}
    </div>
  );
}
