import type { ReactNode } from 'react';

interface PageProps {
  title: string;
  /** 标题右侧操作区 */
  action?: ReactNode;
  /** 标题下方的副标题或说明 */
  subtitle?: ReactNode;
  /**
   * 内容区最大宽度。
   * 默认 `text` 适合以阅读为主的页面；`wide` 给要放多列网格的页面。
   */
  width?: 'text' | 'wide';
  children?: ReactNode;
}

const WIDTHS: Record<'text' | 'wide', string> = {
  text: 'max-w-3xl',
  wide: 'max-w-6xl',
};

/**
 * 页面骨架：粘性标题栏 + 可滚动内容区。
 *
 * 窄屏底部预留 Tab 栏高度避免内容被遮挡；`lg` 以上没有底部栏，
 * 改为把内容收进一个居中的限宽列 —— 桌面端最容易犯的错是让文字铺满
 * 整个宽屏，一行几十个汉字读起来会丢行。
 */
export function Page({ title, action, subtitle, width = 'text', children }: PageProps) {
  return (
    <div className="min-h-dvh bg-paper">
      <header className="sticky top-0 z-30 safe-top border-b border-ink-100 bg-paper/95 backdrop-blur">
        <div
          className={`mx-auto flex ${WIDTHS[width]} items-center justify-between gap-3 px-4 py-3 lg:px-8 lg:py-5`}
        >
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight lg:text-2xl">{title}</h1>
            {subtitle ? (
              <p className="mt-0.5 truncate text-xs text-ink-500 lg:text-sm">{subtitle}</p>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      </header>
      <main
        id="main"
        className={[
          'mx-auto px-4 pt-4 lg:px-8 lg:pt-6',
          WIDTHS[width],
          // 窄屏要躲开固定底部栏；桌面端没有底部栏，只留常规留白
          'pb-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom,0px)+1.5rem)] lg:pb-16',
        ].join(' ')}
      >
        {children}
      </main>
    </div>
  );
}

/** 分组区块，用于把长表单切成可扫读的段落 */
export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-5 lg:mb-6">
      <div className="mb-2.5 flex items-end justify-between gap-3 px-1">
        <div>
          <h2 className="text-sm font-semibold text-ink-900 lg:text-base">{title}</h2>
          {description ? (
            <p className="mt-1 text-xs leading-relaxed text-ink-500 lg:text-sm">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="flex flex-col gap-4 rounded-2xl border border-ink-100 bg-paper-raised p-4 lg:p-5">
        {children}
      </div>
    </section>
  );
}

/**
 * 并排区块容器：桌面端把若干 Section 排成两列。
 *
 * 窄屏仍是单列堆叠 —— 这里只是给「互不依赖、都比较矮」的区块一个横向利用空间的机会，
 * 不要用它包住需要从上到下顺序阅读的内容。
 */
export function SectionGrid({ children }: { children: ReactNode }) {
  return <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-6">{children}</div>;
}

/** 空状态占位，全局统一样式 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-ink-100 bg-paper-raised px-6 py-14 text-center lg:py-20">
      <p className="text-base font-medium text-ink-700 lg:text-lg">{title}</p>
      {description ? (
        <p className="max-w-xs text-sm leading-relaxed text-ink-500 lg:max-w-md">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
