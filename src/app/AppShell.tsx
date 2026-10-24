import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppNav } from './AppNav';

/**
 * 路由级懒加载：六个页面各自成块，首屏只载入当前 Tab 需要的代码。
 *
 * 之前全部静态 import，打包成一个 900 kB 的 chunk；「写作」与「导入」两个
 * 最重的分支只有进了对应 Tab 才需要。懒加载之后首屏体积显著下降，
 * 本地托管与局域网访问的冷启动更快。桌面端切换 Tab 时按需取块，代价可忽略。
 *
 * 页面组件是命名导出，lazy 需要默认导出，所以每个都包一层映射。
 */
const ShelfPage = lazy(() =>
  import('@/features/shelf/ShelfPage').then((m) => ({ default: m.ShelfPage })),
);
const KnowledgePage = lazy(() =>
  import('@/features/knowledge/KnowledgePage').then((m) => ({ default: m.KnowledgePage })),
);
const WritingPage = lazy(() =>
  import('@/features/writing/WritingPage').then((m) => ({ default: m.WritingPage })),
);
const ScenarioPage = lazy(() =>
  import('@/features/scenario/ScenarioPage').then((m) => ({ default: m.ScenarioPage })),
);
const PlanPage = lazy(() =>
  import('@/features/plan/PlanPage').then((m) => ({ default: m.PlanPage })),
);
const SettingsPage = lazy(() =>
  import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

/**
 * 应用外壳：路由表 + 常驻主导航。
 *
 * 不把 novelId 放进 URL，而是用「当前作品」这一全局状态驱动
 * 知识库 / 写作 / 计划三个 Tab —— Tab 切换必须是无参数的单击操作，
 * 否则每次切换都要拼装 id，且深链接在只有一个活跃作品的场景里没有收益。
 *
 * 布局：窄屏是单列 + 底部 Tab 栏；`lg` 以上变成「左侧边栏 + 内容区」的两列。
 * 导航在 DOM 里排在内容之后，桌面端由 `lg:order-first` 移到左侧，
 * 见 AppNav 的注释。
 */
export function AppShell() {
  return (
    <div className="lg:flex lg:items-start">
      {/* 键盘用户的逃生通道，聚焦时才滑入视口 */}
      <a href="#main" className="skip-link">
        跳到主内容
      </a>

      <div className="min-w-0 flex-1">
        {/* 块加载的瞬间占位：本地访问几乎不可见，避免切 Tab 时内容区闪空 */}
        <Suspense
          fallback={
            <div className="py-16 text-center text-sm text-ink-300" role="status">
              页面加载中…
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<ShelfPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/write" element={<WritingPage />} />
            {/* 互动推演：刷新后还在同一个推演；路径挂在 /write 下，信息架构上属于写作 */}
            <Route path="/write/scenario/:scenarioId" element={<ScenarioPage />} />
            <Route path="/plan" element={<PlanPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </div>

      <AppNav />
    </div>
  );
}
