import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAppearanceSettings, lineHeightFor } from '@/features/settings/appearanceSettings';
import './workbench.css';

export interface WorkbenchChapter {
  id: string;
  title: string;
  meta: string;
  current?: boolean;
  /** 章号：搜索「2 / 第2章」时用 */
  chapterNumber?: number;
  /** 本章有未采用、未审阅的 AI 建议（会话内） */
  review?: boolean;
}

export interface WorkbenchChapterGroup {
  key: string;
  title: string;
  chapters: readonly WorkbenchChapter[];
  /** 分组级动作：外传的「写新章 / 编辑」等 */
  actions?: readonly { label: string; onClick: () => void }[];
}

export interface WorkbenchRailTab {
  key: string;
  label: string;
}

interface WorkbenchShellProps {
  workTitle: string;
  /** 章节栏标题；默认「章节」，预览壳可传卷名 */
  railTitle?: string;
  groups: readonly WorkbenchChapterGroup[];
  railFooter?: ReactNode;
  /** 点章节时由工作台父级决定（先 flush 再切章） */
  onSelectChapter?: (chapterId: string) => void;
  /** 右栏「本章」；传入后页头出现「本章」按钮 */
  sidePanel?: (close: () => void) => ReactNode;
  /** 页头动作：推演 / 待确认 / 导出等 */
  headerActions?: ReactNode;
  /** 左栏视图切换；提供时显示 tab，key 为 outline 的视图用 outlineView 渲染 */
  railTabs?: readonly WorkbenchRailTab[];
  outlineView?: ReactNode;
  /** 章节视图底部的动作：新建章节 / 新建外传 / 规划后续等 */
  railActions?: ReactNode;
  /** 移动端底部操作栏的 AI 菜单入口；不传则不显示 AI 按钮 */
  onOpenAi?: () => void;
  children: ReactNode;
}

/**
 * 写作工作台外壳。
 *
 * 只负责布局、章节栏/右栏开合与章节搜索；数据、编辑器逻辑由父级注入。
 * - ≥1280px：章节栏常驻 240px；
 * - 1024–1279px：章节栏浮层，页头按钮打开，Esc 关闭并归还焦点；
 * - <1024px：单栏，章节栏浮层；全局导航由 AppShell 换成底部栏。
 * - 左栏可在「章节 / 大纲」两个视图间切换；章节视图顶部有标题/序号搜索。
 */
export function WorkbenchShell({
  workTitle,
  railTitle = '章节',
  groups,
  railFooter,
  onSelectChapter,
  sidePanel,
  headerActions,
  railTabs,
  outlineView,
  railActions,
  onOpenAi,
  children,
}: WorkbenchShellProps) {
  const appearance = useAppearanceSettings();
  const [railOpen, setRailOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [railView, setRailView] = useState(railTabs?.[0]?.key ?? 'chapters');
  const [chapterQuery, setChapterQuery] = useState('');
  const totalChapters = groups.reduce((sum, group) => sum + group.chapters.length, 0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const outlineKey = railTabs?.find((tab) => tab.key === 'outline')?.key;
  const showingOutline =
    outlineKey !== undefined && railView === outlineKey && outlineView !== undefined;
  const normalizedQuery = chapterQuery.trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      chapters: group.chapters.filter((chapter) =>
        `${chapter.title} ${chapter.meta} ${chapter.chapterNumber ?? ''} 第${chapter.chapterNumber ?? ''}章`
          .toLowerCase()
          .includes(normalizedQuery),
      ),
    }))
    .filter((group) => group.chapters.length > 0);
  const firstVisibleChapter = visibleGroups[0]?.chapters[0];
  const appearanceStyle = {
    '--wb-prose-family':
      appearance.font === 'serif' ? 'var(--wb-font-serif)' : 'var(--wb-font-sans)',
    '--wb-prose-size': `${appearance.size}px`,
    '--wb-prose-line': String(lineHeightFor(appearance.font)),
    '--wb-prose-max': `calc(40 * ${appearance.size}px)`,
  } as CSSProperties;
  const flatChapters = groups.flatMap((group) => group.chapters);
  const currentIndex = flatChapters.findIndex((chapter) => chapter.current);
  const previousChapter = currentIndex > 0 ? flatChapters[currentIndex - 1] : undefined;
  const nextChapter =
    currentIndex >= 0 && currentIndex < flatChapters.length - 1
      ? flatChapters[currentIndex + 1]
      : undefined;

  function closePanel() {
    setPanelOpen(false);
    window.requestAnimationFrame(() => panelToggleRef.current?.focus({ preventScroll: true }));
  }

  function selectChapter(chapterId: string) {
    setRailOpen(false);
    onSelectChapter?.(chapterId);
  }

  useEffect(() => {
    if (!railOpen || panelOpen) return;

    const firstChapter =
      railRef.current?.querySelector<HTMLButtonElement>('button[data-wb-chapter]');
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

  // 软键盘：用 visualViewport 把底部操作栏抬到键盘上方；不支持的环境保持原样
  useEffect(() => {
    const viewport = window.visualViewport;
    const shell = shellRef.current;
    if (!viewport || !shell) return;

    function updateKeyboardInset() {
      const inset = Math.max(0, window.innerHeight - viewport!.height - viewport!.offsetTop);
      shell!.style.setProperty('--wb-keyboard-inset', `${Math.round(inset)}px`);
    }

    updateKeyboardInset();
    viewport.addEventListener('resize', updateKeyboardInset);
    viewport.addEventListener('scroll', updateKeyboardInset);
    return () => {
      viewport.removeEventListener('resize', updateKeyboardInset);
      viewport.removeEventListener('scroll', updateKeyboardInset);
    };
  }, []);

  return (
    <div
      ref={shellRef}
      className="wb-shell wb-scope"
      data-font={appearance.font}
      style={appearanceStyle}
      data-testid="workbench-root"
      data-rail-open={String(railOpen)}
      data-panel-open={String(panelOpen)}
    >
      <header className="wb-shell-header" data-testid="workbench-header">
        <div className="wb-shell-heading">
          <span className="wb-shell-app">写作</span>
          <h1 className="wb-shell-work">{workTitle}</h1>
        </div>
        {headerActions ? (
          <div className="wb-shell-header-actions" data-testid="workbench-header-actions">
            {headerActions}
          </div>
        ) : null}
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
          aria-label="章节与大纲"
        >
          <div className="wb-shell-rail-heading">
            <span>{railTitle}</span>
            <span>{totalChapters} 章</span>
            <button
              type="button"
              className="wb-shell-rail-close"
              aria-label="关闭目录"
              onClick={() => setRailOpen(false)}
            >
              关闭
            </button>
          </div>

          {railTabs && railTabs.length > 1 ? (
            <div className="wb-shell-rail-tabs" role="tablist" aria-label="左栏视图">
              {railTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={railView === tab.key}
                  className="wb-shell-rail-tab"
                  onClick={() => setRailView(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}

          {showingOutline ? (
            <div className="wb-shell-rail-outline" data-testid="outline-rail-view">
              {outlineView}
            </div>
          ) : (
            <>
              <div className="wb-shell-search">
                <input
                  type="search"
                  aria-label="搜索章节"
                  placeholder="搜索标题或章号"
                  value={chapterQuery}
                  onChange={(event) => setChapterQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || !firstVisibleChapter) return;
                    event.preventDefault();
                    selectChapter(firstVisibleChapter.id);
                  }}
                />
                {chapterQuery ? (
                  <button type="button" aria-label="清除搜索" onClick={() => setChapterQuery('')}>
                    ×
                  </button>
                ) : null}
              </div>

              {visibleGroups.length > 0 ? (
                visibleGroups.map((group) => (
                  <section key={group.key} className="wb-shell-group" aria-label={group.title}>
                    <div className="wb-shell-group-head">
                      <h3 className="wb-shell-group-title">{group.title}</h3>
                      {group.actions?.map((action) => (
                        <button
                          key={action.label}
                          type="button"
                          className="wb-shell-group-action"
                          onClick={action.onClick}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                    <ol className="wb-shell-chapters">
                      {group.chapters.map((chapter, index) => (
                        <li key={chapter.id}>
                          <button
                            type="button"
                            className="wb-shell-chapter"
                            data-wb-chapter
                            aria-current={chapter.current ? 'page' : undefined}
                            onClick={() => selectChapter(chapter.id)}
                          >
                            <span className="wb-shell-chapter-number">
                              {String(index + 1).padStart(2, '0')}
                            </span>
                            <span className="wb-shell-chapter-copy">
                              <strong>{chapter.title}</strong>
                              <small>{chapter.meta}</small>
                              {chapter.review ? (
                                <em
                                  className="wb-shell-chapter-review"
                                  title="本章有未审阅的 AI 建议"
                                >
                                  待审
                                </em>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))
              ) : (
                <p className="wb-shell-empty">
                  没有匹配章节。
                  <button type="button" onClick={() => setChapterQuery('')}>
                    清除搜索
                  </button>
                </p>
              )}

              {railActions ? <div className="wb-shell-rail-actions">{railActions}</div> : null}
            </>
          )}

          {railFooter ? <div className="wb-shell-rail-footer">{railFooter}</div> : null}
        </aside>

        <main id="main" className="wb-shell-editor" data-testid="editor-pane">
          {children}
        </main>
      </div>

      <div
        className="wb-shell-scrim"
        data-open={railOpen || panelOpen ? 'true' : 'false'}
        aria-hidden="true"
        onClick={() => {
          setRailOpen(false);
          if (panelOpen) closePanel();
        }}
      />

      <nav className="wb-mobile-bar" aria-label="写作操作栏">
        <button
          type="button"
          aria-label="打开目录"
          aria-expanded={railOpen}
          aria-controls="wb-chapter-rail"
          onClick={() => {
            setPanelOpen(false);
            setRailOpen((open) => !open);
          }}
        >
          目录
        </button>
        <button
          type="button"
          aria-label="上一章"
          disabled={!previousChapter}
          onClick={() => previousChapter && selectChapter(previousChapter.id)}
        >
          上一章
        </button>
        <button
          type="button"
          aria-label="下一章"
          disabled={!nextChapter}
          onClick={() => nextChapter && selectChapter(nextChapter.id)}
        >
          下一章
        </button>
        <button
          type="button"
          aria-label="打开本章"
          aria-expanded={panelOpen}
          aria-controls="wb-chapter-panel"
          onClick={() => {
            setRailOpen(false);
            setPanelOpen((open) => !open);
          }}
        >
          本章
        </button>
        <button type="button" aria-label="AI 写作" disabled={!onOpenAi} onClick={onOpenAi}>
          AI
        </button>
      </nav>

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
