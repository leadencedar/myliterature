import type { KnowledgeEntry, Scenario, ScenarioNode } from '@/domain/schema';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { formatRelativeTime } from '@/ui/format';
import { scenarioOverview } from './scenarioView';

export interface ScenarioListItem {
  scenario: Scenario;
  nodes: ScenarioNode[];
}

/**
 * 「全部推演」：列表 + 新建（设计 §8.1）。数据由写作页卡片查好传进来，打开抽屉不再查一遍
 */
export function ScenarioListSheet({
  open,
  items,
  entries,
  onOpenScenario,
  onCreate,
  onClose,
}: {
  open: boolean;
  items: ScenarioListItem[];
  /** 本书全部条目（含限定、含已删除）：只为显示主角名 */
  entries: KnowledgeEntry[];
  onOpenScenario: (scenarioId: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={open}
      title="全部推演"
      onClose={onClose}
      footer={
        <Button variant="primary" size="lg" block onClick={onCreate}>
          新建推演
        </Button>
      }
    >
      {items.length === 0 ? (
        <p className="text-sm text-ink-500">还没有推演。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map(({ scenario, nodes }) => {
            const overview = scenarioOverview(scenario, nodes);
            const cast = entries.find((entry) => entry.id === scenario.setup.cast[0]?.entryId);
            const meta = [
              `主角 ${cast?.title ?? '（已不存在）'}`,
              overview.nodeCount === 0
                ? '还没有开局'
                : `${overview.nodeCount} 个节点 · 主线 ${overview.mainSteps} 步`,
              overview.endings > 0 ? `已到达 ${overview.endings} 个结局` : null,
              scenario.lastAdvancedAt
                ? `最后推进 ${formatRelativeTime(scenario.lastAdvancedAt)}`
                : null,
            ].filter(Boolean);
            return (
              <li key={scenario.id}>
                <button
                  type="button"
                  onClick={() => onOpenScenario(scenario.id)}
                  className="tap-target flex w-full cursor-pointer flex-col items-start gap-1 rounded-xl border border-ink-100 px-3 py-2.5 text-left transition-colors enabled:hover:bg-paper-sunken"
                >
                  <span className="text-sm font-medium text-ink-900">《{scenario.title}》</span>
                  <span className="text-xs text-ink-500">{meta.join(' · ')}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
