import { NavLink } from 'react-router-dom';
import { TABS } from './navigation';

/**
 * 主导航。
 *
 * **一套 DOM、一组链接，靠断点换形态**：
 * - 窄屏：固定在视口底部的 Tab 栏，自动避让 iPhone home indicator，每项 44px 以上触控目标
 * - `lg` 以上：左侧常驻边栏，图标与文字横排，选中项用底色而不只是变色
 *
 * 之所以不按屏幕宽度渲染两套导航：同一组链接出现两遍会被读屏读两遍，
 * 自动化测试也会同时看到两份（CSS 的 display:none 在测试环境里并不生效）。
 *
 * DOM 顺序上导航排在内容之后，桌面端再用 `lg:order-first` 把它移到左侧。
 * 这样移动端读屏的阅读顺序仍是「内容 → 导航」（与 iOS/Android 的 Tab 栏惯例一致），
 * 代价是桌面端键盘 Tab 到侧边栏的顺序偏后 —— 由「跳到主内容」链接来补。
 */
export function AppNav() {
  return (
    <nav
      aria-label="主导航"
      className={[
        'fixed inset-x-0 bottom-0 z-40 safe-bottom border-t border-ink-100',
        'bg-paper-raised/95 backdrop-blur',
        // 桌面端：脱离固定定位，变成撑满视口高度的侧边栏
        'lg:sticky lg:inset-auto lg:top-0 lg:order-first lg:h-dvh lg:shrink-0',
        'lg:w-[var(--spacing-sidebar)]',
        'lg:flex lg:flex-col lg:border-t-0 lg:border-r lg:pb-0 lg:backdrop-blur-none',
      ].join(' ')}
    >
      {/* 品牌区只在桌面出现：移动端底部栏没有这个高度，硬塞会挤掉触控目标 */}
      <div className="hidden lg:block lg:border-b lg:border-ink-100 lg:px-4 lg:py-4">
        <p className="font-reading text-lg leading-none font-semibold tracking-tight text-ink-900">
          文墨
        </p>
        <p className="mt-1 text-xs text-ink-500">AI 小说创作</p>
      </div>

      <ul className="flex items-stretch justify-around lg:flex-col lg:justify-start lg:gap-0.5 lg:p-2">
        {TABS.map((tab) => (
          <li key={tab.path} className="flex-1 lg:flex-none">
            <NavLink
              to={tab.path}
              end={tab.path === '/'}
              className={({ isActive }) =>
                [
                  'tap-target flex h-15 flex-col items-center justify-center gap-0.5 text-[0.6875rem]',
                  'transition-colors active:bg-paper-sunken',
                  // 桌面端：横排、左对齐、可点区域是一整行
                  'lg:h-11 lg:flex-row lg:justify-start lg:gap-3 lg:rounded-xl lg:px-3 lg:text-sm',
                  'lg:hover:bg-paper-sunken',
                  isActive
                    ? 'text-seal lg:bg-seal-soft lg:hover:bg-seal-soft'
                    : 'text-ink-500 lg:text-ink-700',
                ].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  <tab.icon className="h-6 w-6 lg:h-5 lg:w-5" strokeWidth={isActive ? 2.1 : 1.7} />
                  <span className="lg:font-medium">{tab.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
