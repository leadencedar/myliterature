import './workbench.css';

/**
 * UI v2 · 阶段 1 开发预览页。
 *
 * 只在 `import.meta.env.DEV` 下由 AppShell 注册到 `/__workbench`，用于验证
 * 工作台作用域令牌与后续空壳布局；不读仓库、不调用模型、不写数据。
 *
 * 现在只渲染「令牌探针」段落；T3/T4 会把章节栏与编辑器占位接进来。
 */
export function WorkbenchPreview() {
  return (
    <div
      className="wb-scope min-h-dvh bg-paper px-4 pt-8 pb-24 text-ink-900 lg:px-8 lg:pb-8"
      data-testid="workbench-root"
    >
      <header className="mx-auto max-w-[var(--wb-prose-max)]">
        <p className="text-[0.6875rem] tracking-wide text-ink-300 uppercase">
          dev preview · /__workbench
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">写作工作台 · 阶段 1 预览</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">
          这里只验证 v2 的工作台令牌：黑体 17px / 1.85，正文上限 40×17 = 680px。真实空壳（章节栏 +
          编辑器占位）按 T3/T4 接入；此页面只在开发环境存在。
        </p>
      </header>

      <main id="main" className="mx-auto mt-6 max-w-[var(--wb-prose-max)]">
        <p className="rounded-lg border border-ink-100 bg-paper-raised px-4 py-3 text-xs text-ink-500">
          令牌探针 · Playwright 用 data-testid 读取；正文段落不再套卡片内边距，宽度应等于 40×字号。
        </p>
        <p className="wb-prose-probe mt-4 whitespace-pre-wrap" data-testid="editor-prose">
          旧城的雨，总比别处下得慢。林照沿着石阶往上走，鞋底带起细碎的水声。街角那家书店还亮着灯，灯光落在潮湿的地面上，像一页没有写完的信。她停在门前，想起那个人说过的话：有些故事，只有回到开始的地方，才知道该怎样继续。
        </p>
      </main>
    </div>
  );
}
