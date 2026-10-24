import { useRepoQuery } from '@/data/useRepoQuery';
import { mainPath } from '@/domain/scenario';
import type { OutlineNode } from '@/domain/schema';

/**
 * 这个大纲节点是不是「来自旧主线」（设计 D7.4）：带溯源、且对应的步骤不全在推演当前的主线上。
 * 现算、不存标记 —— 主线换回来，标记自然消失。没有溯源的节点不读仓储
 */
export function useFromOldMainline(source: OutlineNode['scenarioSource']): boolean {
  const { data } = useRepoQuery(
    async (repo) => {
      if (!source) return false;
      const scenario = await repo.getScenario(source.scenarioId);
      if (!scenario) return false;
      const onMain = new Set(
        mainPath(scenario, await repo.listScenarioNodes(scenario.id)).map((node) => node.id),
      );
      return !source.nodeIds.every((id) => onMain.has(id));
    },
    [source?.scenarioId ?? null, source?.nodeIds ?? null],
  );
  return data === true;
}
