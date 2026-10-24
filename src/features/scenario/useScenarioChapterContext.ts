import { useMemo } from 'react';
import { useRepoQuery } from '@/data/useRepoQuery';
import { buildScenarioChapterContext, type ScenarioChapterResult } from './chapterContext';

export interface ScenarioChapterSource {
  scenarioId: string;
  nodeIds: readonly string[];
  /** 外传章节的细纲；主线章节没有 */
  brief?: string;
}

/**
 * 章节编辑器读推演材料（设计 §7.3）。source 为 null（不是推演沉淀的章节）时查询函数直接返回、不碰仓储，
 * 编辑器的行为与没有推演时相同。返回 null = 不是推演章节，或数据还没读回来
 */
export function useScenarioChapterContext(input: {
  novelId: string;
  source: ScenarioChapterSource | null;
  /** 外传章节所属外传的分叉点；主线章节为 null */
  forkNodeId: string | null;
}): ScenarioChapterResult | null {
  const { novelId, source, forkNodeId } = input;
  const { data } = useRepoQuery(
    async (repo) => {
      if (!source) return null;
      const scenario = await repo.getScenario(source.scenarioId);
      if (!scenario || scenario.novelId !== novelId) {
        return { scenario: undefined, nodes: [], entries: [], categories: [] };
      }
      const [nodes, entries, categories] = await Promise.all([
        repo.listScenarioNodes(scenario.id),
        // 限定条目（推演主角、本章登场的预设）不在写作页的条目列表里；含已删除的才能说清「主角在回收站」
        repo.listEntries(novelId, { scope: 'all', includeDeleted: true }),
        repo.listCategories(novelId),
      ]);
      return { scenario, nodes, entries, categories };
    },
    [novelId, source?.scenarioId ?? null, source?.nodeIds ?? null],
  );

  const brief = source?.brief;
  const nodeIdsKey = JSON.stringify(source?.nodeIds ?? null);
  return useMemo(() => {
    if (!source || !data) return null;
    return buildScenarioChapterContext({
      scenario: data.scenario,
      nodes: data.nodes,
      entries: data.entries,
      categories: data.categories,
      source: { nodeIds: source.nodeIds, ...(brief !== undefined ? { brief } : {}) },
      forkNodeId,
    });
    // source 每次渲染都可能是新对象，按内容比较
  }, [data, nodeIdsKey, brief, forkNodeId]);
}
