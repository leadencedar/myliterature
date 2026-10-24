import type { Scenario, ScenarioNode } from '@/domain/schema';
import { childrenOf, latestLeafOf, mainPath, pathTo } from '@/domain/scenario';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { actionSummary, crumbLabel, endingLabel } from './scenarioView';

/**
 * 世界线导航（设计 §8.3）：「回到主线最新一步」、当前路径每一步及其直接分支、已到达的结局。
 *
 * 只渲染当前路径与它的直接分支，不渲染整棵树：几百个节点的推演在手机上也能用，读屏不会读到整棵树。
 * 跳转只调 onJump（页面只改 cursorNodeId），不发任何请求。
 */
export function WorldlineNavigatorSheet({
  open,
  scenario,
  nodes,
  currentId,
  onJump,
  onClose,
}: {
  open: boolean;
  scenario: Scenario;
  nodes: readonly ScenarioNode[];
  currentId: string;
  onJump: (nodeId: string) => void;
  onClose: () => void;
}) {
  const path = pathTo(nodes, currentId);
  const mainIds = new Set(mainPath(scenario, nodes).map((node) => node.id));
  const endings = nodes
    .filter((node) => node.ending !== null)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const mainLeaf =
    scenario.mainNodeId && nodes.some((node) => node.id === scenario.mainNodeId)
      ? scenario.mainNodeId
      : null;

  return (
    <Sheet open={open} title="世界线" onClose={onClose}>
      <Button
        variant="primary"
        block
        disabled={!mainLeaf}
        onClick={() => mainLeaf && onJump(mainLeaf)}
      >
        回到主线最新一步
      </Button>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink-900">当前路径</h3>
        <ol className="flex flex-col gap-2">
          {path.map((node, index) => {
            const next = path[index + 1];
            const branches = childrenOf(nodes, node.id).filter((child) => child.id !== next?.id);
            const label = crumbLabel(node);
            return (
              <li key={node.id} className="rounded-xl border border-ink-100 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-sm text-ink-900">
                    {label} · {actionSummary(node)}
                    {mainIds.has(node.id) ? (
                      <span className="ml-2 text-xs text-ink-500">主线</span>
                    ) : null}
                    {node.id === currentId ? (
                      <span className="ml-2 text-xs font-medium text-ink-700">当前</span>
                    ) : null}
                  </p>
                  {node.id === currentId ? null : (
                    <Button size="sm" onClick={() => onJump(node.id)}>
                      跳到这一步<span className="sr-only">（{label}）</span>
                    </Button>
                  )}
                </div>
                {branches.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-2 border-l-2 border-ink-100 pl-3">
                    {branches.map((child) => {
                      const latest = latestLeafOf(nodes, child.id) ?? child;
                      const walked = latest.depth - child.depth + 1;
                      const summary = actionSummary(child);
                      return (
                        <li key={child.id} className="flex flex-col gap-1.5">
                          <p className="text-xs leading-relaxed text-ink-700">
                            另一条线：{summary} · 已走 {walked} 步
                            {latest.ending ? ` · ${endingLabel(latest.ending)}` : ''}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="ghost" onClick={() => onJump(child.id)}>
                              看分叉处<span className="sr-only">（{summary}）</span>
                            </Button>
                            <Button size="sm" onClick={() => onJump(latest.id)}>
                              去这条线的最新一步<span className="sr-only">（{summary}）</span>
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink-900">已到达的结局</h3>
        {endings.length === 0 ? (
          <p className="text-sm text-ink-500">还没有走到结局。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {endings.map((node) => (
              <li key={node.id}>
                <Button size="sm" block onClick={() => onJump(node.id)}>
                  {crumbLabel(node)} · {endingLabel(node.ending!)}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Sheet>
  );
}
