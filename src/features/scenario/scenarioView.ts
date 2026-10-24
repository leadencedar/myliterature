import { z } from 'zod';
import type { Scenario, ScenarioEnding, ScenarioNode } from '@/domain/schema';
import { mainPath, rootOf } from '@/domain/scenario';
import { LlmError } from '@/llm/errors';
import { GOAL_KIND_LABELS } from './scenarioPrompt';

/**
 * 推演界面共用的显示口径：「第 k 步」= depth + 1，与面包屑、导航、主线徽标、沉淀大纲同一编号。
 * 收在一处，几个面板里同一个节点的叫法才不会各说各的。
 */

/** 推演页的路由（属于写作 Tab：AppNav 对 /write 不设 end，子路径下「写作」仍高亮） */
export function scenarioPath(scenarioId: string): string {
  return `/write/scenario/${scenarioId}`;
}

export function stepNumber(node: Pick<ScenarioNode, 'depth'>): number {
  return node.depth + 1;
}

/** 面包屑与导航里的短名 */
export function crumbLabel(node: Pick<ScenarioNode, 'depth'>): string {
  return node.depth === 0 ? '开局' : `第 ${node.depth + 1} 步`;
}

/** 这一步是怎么走到的（一行摘要） */
export function actionSummary(node: Pick<ScenarioNode, 'arrivedBy'>): string {
  const by = node.arrivedBy;
  switch (by.kind) {
    case 'start':
      return '开局';
    case 'option':
      return `选「${by.text}」`;
    case 'free':
      return `尝试「${by.text}」`;
    case 'wrap-up':
      return '收尾';
  }
}

/** 正文区的步骤标题 */
export function stepHeading(node: Pick<ScenarioNode, 'depth' | 'arrivedBy'>): string {
  const step = `第 ${node.depth + 1} 步`;
  const by = node.arrivedBy;
  switch (by.kind) {
    case 'start':
      return `${step} · 开局`;
    case 'option':
      return `${step} · 你选择了：${by.text}`;
    case 'free':
      return `${step} · 你尝试：${by.text}`;
    case 'wrap-up':
      return `${step} · 收尾`;
  }
}

export function endingLabel(ending: Pick<ScenarioEnding, 'kind' | 'title'>): string {
  return `${GOAL_KIND_LABELS[ending.kind]}「${ending.title}」`;
}

/**
 * 落点（设计 §8.3 第 0 项）：cursorNodeId 有效用它，否则主线末端，再不行根节点；树为空返回 null。
 * 只在内存里决定显示哪个节点，不写库 —— 作者下一次跳转或推进才写 cursorNodeId
 */
export function landingNodeId(
  scenario: Pick<Scenario, 'cursorNodeId' | 'mainNodeId'>,
  nodes: readonly ScenarioNode[],
): string | null {
  const ids = new Set(nodes.map((node) => node.id));
  if (scenario.cursorNodeId && ids.has(scenario.cursorNodeId)) return scenario.cursorNodeId;
  if (scenario.mainNodeId && ids.has(scenario.mainNodeId)) return scenario.mainNodeId;
  return rootOf(nodes)?.id ?? null;
}

/** 列表与卡片用的概况 */
export function scenarioOverview(scenario: Scenario, nodes: readonly ScenarioNode[]) {
  const landingId = landingNodeId(scenario, nodes);
  const landing = landingId ? nodes.find((node) => node.id === landingId) : undefined;
  return {
    nodeCount: nodes.length,
    mainSteps: mainPath(scenario, nodes).length,
    endings: nodes.filter((node) => node.ending !== null).length,
    landingStep: landing ? stepNumber(landing) : null,
  };
}

/** 错误显示：仓储的中文 message、Zod 的第一条、LlmError 的 detail 小字 */
export function errorText(
  cause: unknown,
  fallback = '操作失败',
): { message: string; detail?: string } {
  if (cause instanceof z.ZodError) return { message: cause.issues[0]?.message ?? fallback };
  if (cause instanceof LlmError)
    return cause.detail
      ? { message: cause.message, detail: cause.detail }
      : { message: cause.message };
  if (cause instanceof Error) return { message: cause.message || fallback };
  return { message: fallback };
}
