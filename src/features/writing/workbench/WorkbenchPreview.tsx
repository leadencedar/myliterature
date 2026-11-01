import { WorkbenchShell, type WorkbenchChapter } from './WorkbenchShell';

const SAMPLE_CHAPTERS: readonly WorkbenchChapter[] = [
  { id: 'chapter-1', title: '雨停之前', meta: '已定稿 · 63 字' },
  { id: 'chapter-2', title: '旧城来信', meta: '初稿 · 81 字', current: true },
  { id: 'chapter-3', title: '无声的渡口', meta: '待写 · 0 字' },
];

/**
 * UI v2 · 阶段 1 开发预览页。
 *
 * 只在 `import.meta.env.DEV` 下由 AppShell 注册到 `/__workbench`，用于验证
 * 工作台作用域令牌与空壳布局；不读仓库、不调用模型、不写数据。
 *
 * 章节与正文都是固定示例；阶段 2 会把它换成真实的 WritingPage + 编辑器。
 */
export function WorkbenchPreview() {
  return (
    <WorkbenchShell
      workTitle="雾港来信"
      railTitle="章节"
      groups={[{ key: 'main', title: '第一卷 · 潮汐', chapters: SAMPLE_CHAPTERS }]}
      railFooter={
        <p>
          作品字数 144
          <br />
          示例作品 · 本地预览
        </p>
      }
    >
      <div className="wb-preview-editor">
        <p className="wb-preview-devnote">
          开发预览 · `/__workbench` · 只验证工作台令牌与空壳布局，不保存、不调用模型。T5
          起由宽度验收脚本检查。
        </p>
        <p className="wb-preview-kicker">第一卷 / 第 2 章</p>
        <h1 className="wb-preview-title">旧城来信</h1>
        <p className="wb-preview-meta">初稿 · 81 字 · 阶段 1 空壳</p>
        <p className="wb-prose-probe mt-4 whitespace-pre-wrap" data-testid="editor-prose">
          旧城的雨，总比别处下得慢。林照沿着石阶往上走，鞋底带起细碎的水声。街角那家书店还亮着灯，灯光落在潮湿的地面上，像一页没有写完的信。她停在门前，想起那个人说过的话：有些故事，只有回到开始的地方，才知道该怎样继续。门内传来翻书的声音，她抬起手，却没有立刻推门。
        </p>
        <div className="wb-preview-actions">
          <button type="button" disabled>
            加工这一段
          </button>
          <button type="button" disabled>
            生成本章
          </button>
        </div>
      </div>
    </WorkbenchShell>
  );
}
