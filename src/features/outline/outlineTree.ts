import type { OutlineNode } from '@/domain/schema';

/**
 * 大纲树的结构操作。
 *
 * 全部做成纯函数：输入当前的扁平节点列表与一个操作，输出需要写库的
 * `{id, parentId, order}` 列表。这样层级与排序的正确性可以脱离 UI 单测，
 * 而界面只负责把结果交给 `reorderOutline`。
 *
 * 排序策略：任何操作之后都**重新归一化受影响分组的 order 为 0..n-1**，
 * 而不是在原有值上做增量调整。稀疏或重复的 order 一旦出现就很难查，
 * 每次重排一遍的代价可以忽略。
 */

/** 层级上限：卷 / 章 / 节。再深下去移动端缩进就没法看了 */
export const MAX_OUTLINE_DEPTH = 3;

export interface OutlineTreeNode {
  node: OutlineNode;
  children: OutlineTreeNode[];
  depth: number;
}

export interface ReorderUpdate {
  id: string;
  parentId: string | null;
  order: number;
}

/** 扁平列表 → 树，同层按 order 排序 */
export function buildTree(nodes: OutlineNode[]): OutlineTreeNode[] {
  const childrenOf = (parentId: string | null, depth: number): OutlineTreeNode[] =>
    nodes
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      .map((node) => ({ node, depth, children: childrenOf(node.id, depth + 1) }));

  return childrenOf(null, 0);
}

export interface VisibleRow {
  node: OutlineNode;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  /** 该节点下所有后代的数量，折叠时用于提示「内含 N 项」 */
  descendantCount: number;
}

/** 按折叠状态摊平成可渲染的行 */
export function flattenVisible(
  tree: OutlineTreeNode[],
  collapsed: ReadonlySet<string>,
): VisibleRow[] {
  const rows: VisibleRow[] = [];

  const walk = (items: OutlineTreeNode[]) => {
    for (const item of items) {
      const isCollapsed = collapsed.has(item.node.id);
      rows.push({
        node: item.node,
        depth: item.depth,
        hasChildren: item.children.length > 0,
        collapsed: isCollapsed,
        descendantCount: countDescendants(item),
      });
      if (!isCollapsed) walk(item.children);
    }
  };

  walk(tree);
  return rows;
}

function countDescendants(item: OutlineTreeNode): number {
  return item.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

/** 把整棵树按当前结构重新编号，产出与现状不同的那些更新 */
function normalize(tree: OutlineTreeNode[], original: OutlineNode[]): ReorderUpdate[] {
  const byId = new Map(original.map((node) => [node.id, node]));
  const updates: ReorderUpdate[] = [];

  const walk = (items: OutlineTreeNode[], parentId: string | null) => {
    items.forEach((item, index) => {
      const current = byId.get(item.node.id);
      if (!current || current.parentId !== parentId || current.order !== index) {
        updates.push({ id: item.node.id, parentId, order: index });
      }
      walk(item.children, item.node.id);
    });
  };

  walk(tree, null);
  return updates;
}

/** 在树中定位某节点及其所在的兄弟数组 */
function locate(
  tree: OutlineTreeNode[],
  id: string,
): { siblings: OutlineTreeNode[]; index: number; parent: OutlineTreeNode | undefined } | undefined {
  const search = (
    items: OutlineTreeNode[],
    parent: OutlineTreeNode | undefined,
  ):
    | { siblings: OutlineTreeNode[]; index: number; parent: OutlineTreeNode | undefined }
    | undefined => {
    const index = items.findIndex((item) => item.node.id === id);
    if (index !== -1) return { siblings: items, index, parent };
    for (const item of items) {
      const found = search(item.children, item);
      if (found) return found;
    }
    return undefined;
  };
  return search(tree, undefined);
}

/** 子树的最大相对深度，1 表示只有自己 */
function subtreeHeight(item: OutlineTreeNode): number {
  if (item.children.length === 0) return 1;
  return 1 + Math.max(...item.children.map(subtreeHeight));
}

export function canMoveUp(nodes: OutlineNode[], id: string): boolean {
  const found = locate(buildTree(nodes), id);
  return found !== undefined && found.index > 0;
}

export function canMoveDown(nodes: OutlineNode[], id: string): boolean {
  const found = locate(buildTree(nodes), id);
  return found !== undefined && found.index < found.siblings.length - 1;
}

/** 降级为上一个兄弟的子节点；受层级上限约束 */
export function canIndent(nodes: OutlineNode[], id: string): boolean {
  const tree = buildTree(nodes);
  const found = locate(tree, id);
  if (!found || found.index === 0) return false;
  const self = found.siblings[found.index]!;
  const target = found.siblings[found.index - 1]!;
  // 目标层级 = 新父节点深度 + 1，再加上自身子树高度
  return target.depth + 1 + subtreeHeight(self) <= MAX_OUTLINE_DEPTH;
}

export function canOutdent(nodes: OutlineNode[], id: string): boolean {
  const found = locate(buildTree(nodes), id);
  return found !== undefined && found.parent !== undefined;
}

export function moveUp(nodes: OutlineNode[], id: string): ReorderUpdate[] {
  const tree = buildTree(nodes);
  const found = locate(tree, id);
  if (!found || found.index === 0) return [];
  const { siblings, index } = found;
  [siblings[index - 1], siblings[index]] = [siblings[index]!, siblings[index - 1]!];
  return normalize(tree, nodes);
}

export function moveDown(nodes: OutlineNode[], id: string): ReorderUpdate[] {
  const tree = buildTree(nodes);
  const found = locate(tree, id);
  if (!found || found.index >= found.siblings.length - 1) return [];
  const { siblings, index } = found;
  [siblings[index], siblings[index + 1]] = [siblings[index + 1]!, siblings[index]!];
  return normalize(tree, nodes);
}

export function indent(nodes: OutlineNode[], id: string): ReorderUpdate[] {
  if (!canIndent(nodes, id)) return [];
  const tree = buildTree(nodes);
  const found = locate(tree, id)!;
  const [self] = found.siblings.splice(found.index, 1);
  found.siblings[found.index - 1]!.children.push(self!);
  return normalize(tree, nodes);
}

export function outdent(nodes: OutlineNode[], id: string): ReorderUpdate[] {
  if (!canOutdent(nodes, id)) return [];
  const tree = buildTree(nodes);
  const found = locate(tree, id)!;
  const parent = found.parent!;
  const [self] = found.siblings.splice(found.index, 1);

  // 插到原父节点之后，成为它的下一个兄弟
  const grandparent = locate(tree, parent.node.id)!;
  grandparent.siblings.splice(grandparent.index + 1, 0, self!);
  return normalize(tree, nodes);
}

/** 节点状态的展示文案 */
export const OUTLINE_STATUS_LABELS: Record<OutlineNode['status'], string> = {
  planned: '待写',
  drafting: '在写',
  done: '已完成',
};

/** 统计：节点总数、已完成数、目标字数合计 */
export function outlineStats(nodes: OutlineNode[]): {
  total: number;
  done: number;
  targetWords: number;
} {
  const leafTargets = nodes.filter((node) => !nodes.some((other) => other.parentId === node.id));
  return {
    total: nodes.length,
    done: nodes.filter((node) => node.status === 'done').length,
    // 只累加叶子节点，避免父子重复计数
    targetWords: leafTargets.reduce((sum, node) => sum + (node.targetWords ?? 0), 0),
  };
}
