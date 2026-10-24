import type { ScenarioNode } from '@/domain/schema';
import { crumbLabel } from './scenarioView';

/**
 * 当前路径的面包屑（设计 §8.3 第 2 项）：「开局 › 第 2 步 › … › 第 7 步」，每项是按钮。
 *
 * 全部项都在 DOM 里，读屏与键盘能走到任何一步；窄屏只用 CSS 显示首项、末两项与一个「…」按钮
 * （点开世界线导航），md 起完整换行显示 —— 不做两套 DOM。
 * 「主线」标签放在按钮外：按钮的可访问名称保持「第 k 步」，标签照样被读到、也不只靠颜色。
 */
export function ScenarioBreadcrumb({
  path,
  mainIds,
  currentId,
  disabled,
  onJump,
  onShowAll,
}: {
  path: readonly ScenarioNode[];
  mainIds: ReadonlySet<string>;
  currentId: string;
  disabled: boolean;
  onJump: (nodeId: string) => void;
  onShowAll: () => void;
}) {
  const collapsible = path.length > 3;
  return (
    <nav aria-label="当前路径" className="mb-4">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
        {path.map((node, index) => {
          const current = node.id === currentId;
          // 窄屏只露首项与末两项
          const narrowHidden = collapsible && index > 0 && index < path.length - 2;
          return (
            <li
              key={node.id}
              className={['items-center gap-1', narrowHidden ? 'hidden md:flex' : 'flex'].join(' ')}
            >
              {index > 0 ? (
                <span aria-hidden="true" className="text-ink-300">
                  ›
                </span>
              ) : null}
              {collapsible && index === path.length - 2 ? (
                <button
                  type="button"
                  onClick={onShowAll}
                  aria-label="查看完整路径"
                  className="tap-target inline-flex items-center justify-center rounded-lg px-2 text-ink-500 md:hidden"
                >
                  …
                </button>
              ) : null}
              <button
                type="button"
                disabled={disabled}
                aria-current={current ? 'step' : undefined}
                onClick={() => onJump(node.id)}
                className={[
                  'tap-target inline-flex cursor-pointer items-center rounded-lg px-2 transition-colors disabled:cursor-not-allowed',
                  current
                    ? 'bg-paper-sunken font-medium text-ink-900'
                    : 'text-ink-700 enabled:hover:bg-paper-sunken',
                ].join(' ')}
              >
                {crumbLabel(node)}
              </button>
              {mainIds.has(node.id) ? (
                <span className="text-[0.6875rem] text-ink-500">主线</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
