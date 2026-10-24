import { describe, expect, it } from 'vitest';
import { OutlineNodeSchema, type OutlineNode } from '@/domain/schema';
import {
  buildTree,
  canIndent,
  canMoveDown,
  canMoveUp,
  canOutdent,
  flattenVisible,
  indent,
  moveDown,
  moveUp,
  outdent,
  outlineStats,
  type ReorderUpdate,
} from './outlineTree';

function node(
  id: string,
  parentId: string | null,
  order: number,
  overrides: Partial<OutlineNode> = {},
): OutlineNode {
  return OutlineNodeSchema.parse({
    id,
    novelId: 'n1',
    parentId,
    order,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

/**
 * 测试用的树：
 *   A          B
 *   ├─ A1      └─ B1
 *   │   └─ A1a
 *   └─ A2
 */
const NODES: OutlineNode[] = [
  node('A', null, 0),
  node('B', null, 1),
  node('A1', 'A', 0),
  node('A2', 'A', 1),
  node('A1a', 'A1', 0),
  node('B1', 'B', 0),
];

/** 把更新应用回节点列表，便于断言最终结构 */
function apply(nodes: OutlineNode[], updates: ReorderUpdate[]): OutlineNode[] {
  const byId = new Map(updates.map((update) => [update.id, update]));
  return nodes.map((item) => {
    const update = byId.get(item.id);
    return update ? { ...item, parentId: update.parentId, order: update.order } : item;
  });
}

/** 用「路径 → 顺序」的形式描述结构，断言更直观 */
function outline(nodes: OutlineNode[]): string[] {
  const lines: string[] = [];
  const walk = (items: ReturnType<typeof buildTree>) => {
    for (const item of items) {
      lines.push(`${'  '.repeat(item.depth)}${item.node.title}`);
      walk(item.children);
    }
  };
  walk(buildTree(nodes));
  return lines;
}

describe('建树', () => {
  it('按 parentId 与 order 还原层级', () => {
    expect(outline(NODES)).toEqual(['A', '  A1', '    A1a', '  A2', 'B', '  B1']);
  });

  it('order 相同时按创建时间兜底排序', () => {
    const tied = [node('晚', null, 0, { createdAt: 200 }), node('早', null, 0, { createdAt: 100 })];
    expect(outline(tied)).toEqual(['早', '晚']);
  });

  it('空列表返回空树', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('折叠展开', () => {
  it('展开时列出所有节点', () => {
    const rows = flattenVisible(buildTree(NODES), new Set());
    expect(rows.map((row) => row.node.title)).toEqual(['A', 'A1', 'A1a', 'A2', 'B', 'B1']);
  });

  it('折叠某节点时隐藏其整棵子树', () => {
    const rows = flattenVisible(buildTree(NODES), new Set(['A']));
    expect(rows.map((row) => row.node.title)).toEqual(['A', 'B', 'B1']);
  });

  it('标出是否有子节点与后代总数', () => {
    const rows = flattenVisible(buildTree(NODES), new Set(['A']));
    const a = rows.find((row) => row.node.title === 'A')!;

    expect(a.hasChildren).toBe(true);
    expect(a.collapsed).toBe(true);
    // A1、A1a、A2 共 3 个后代
    expect(a.descendantCount).toBe(3);

    const b1 = rows.find((row) => row.node.title === 'B1')!;
    expect(b1.hasChildren).toBe(false);
    expect(b1.descendantCount).toBe(0);
  });
});

describe('同层上下移动', () => {
  it('上移与前一个兄弟交换', () => {
    expect(outline(apply(NODES, moveUp(NODES, 'B')))).toEqual([
      'B',
      '  B1',
      'A',
      '  A1',
      '    A1a',
      '  A2',
    ]);
  });

  it('下移与后一个兄弟交换', () => {
    expect(outline(apply(NODES, moveDown(NODES, 'A1')))).toEqual([
      'A',
      '  A2',
      '  A1',
      '    A1a',
      'B',
      '  B1',
    ]);
  });

  it('移动时整棵子树跟着走', () => {
    const moved = apply(NODES, moveUp(NODES, 'A2'));
    expect(outline(moved)).toEqual(['A', '  A2', '  A1', '    A1a', 'B', '  B1']);
  });

  it('首位不能上移，末位不能下移', () => {
    expect(canMoveUp(NODES, 'A')).toBe(false);
    expect(moveUp(NODES, 'A')).toEqual([]);
    expect(canMoveDown(NODES, 'B')).toBe(false);
    expect(moveDown(NODES, 'B')).toEqual([]);
  });

  it('只在同层内移动，不会跨父节点', () => {
    // A2 是 A 的末位子节点，不能下移到 B 里去
    expect(canMoveDown(NODES, 'A2')).toBe(false);
  });

  it('不存在的 id 返回空更新', () => {
    expect(moveUp(NODES, 'ghost')).toEqual([]);
    expect(canMoveUp(NODES, 'ghost')).toBe(false);
  });

  it('只产出真正变化的节点', () => {
    const updates = moveUp(NODES, 'B');
    // 仅 A、B 两个根节点的 order 变了
    expect(updates.map((update) => update.id).sort()).toEqual(['A', 'B']);
  });
});

describe('降级（indent）', () => {
  it('成为上一个兄弟的最后一个子节点', () => {
    expect(outline(apply(NODES, indent(NODES, 'B')))).toEqual([
      'A',
      '  A1',
      '    A1a',
      '  A2',
      '  B',
      '    B1',
    ]);
  });

  it('首位没有可挂靠的兄弟，不能降级', () => {
    expect(canIndent(NODES, 'A')).toBe(false);
    expect(indent(NODES, 'A')).toEqual([]);
  });

  it('超过层级上限时拒绝降级', () => {
    // A2 降级后会挂到 A1 下（深度 2），其自身无子节点，刚好到第 3 层，允许
    expect(canIndent(NODES, 'A2')).toBe(true);

    // 给 A2 加一个子节点后，降级会产生第 4 层，应被拒绝
    const withChild = [...NODES, node('A2a', 'A2', 0)];
    expect(canIndent(withChild, 'A2')).toBe(false);
    expect(indent(withChild, 'A2')).toEqual([]);
  });
});

describe('升级（outdent）', () => {
  it('成为原父节点的下一个兄弟', () => {
    expect(outline(apply(NODES, outdent(NODES, 'A1')))).toEqual([
      'A',
      '  A2',
      'A1',
      '  A1a',
      'B',
      '  B1',
    ]);
  });

  it('深层节点升级一层', () => {
    expect(outline(apply(NODES, outdent(NODES, 'A1a')))).toEqual([
      'A',
      '  A1',
      '  A1a',
      '  A2',
      'B',
      '  B1',
    ]);
  });

  it('顶层节点不能升级', () => {
    expect(canOutdent(NODES, 'A')).toBe(false);
    expect(outdent(NODES, 'A')).toEqual([]);
  });

  it('升级后原兄弟重新编号，不留空洞', () => {
    const updates = outdent(NODES, 'A1');
    const a2 = updates.find((update) => update.id === 'A2');
    // A1 走了之后 A2 应该顶到 0 位
    expect(a2).toEqual({ id: 'A2', parentId: 'A', order: 0 });
  });
});

describe('操作的可逆性', () => {
  it('降级后再升级回到原结构', () => {
    const once = apply(NODES, indent(NODES, 'B'));
    const back = apply(once, outdent(once, 'B'));
    expect(outline(back)).toEqual(outline(NODES));
  });

  it('上移后再下移回到原结构', () => {
    const once = apply(NODES, moveUp(NODES, 'B'));
    const back = apply(once, moveDown(once, 'B'));
    expect(outline(back)).toEqual(outline(NODES));
  });
});

describe('统计', () => {
  it('统计总数、完成数与叶子节点的目标字数', () => {
    const nodes = [
      node('卷一', null, 0, { targetWords: 30_000 }),
      node('章一', '卷一', 0, { targetWords: 3000, status: 'done' }),
      node('章二', '卷一', 1, { targetWords: 3000 }),
      node('卷二', null, 1, { targetWords: 5000 }),
    ];

    expect(outlineStats(nodes)).toEqual({
      total: 4,
      done: 1,
      // 叶子是 章一、章二、卷二 → 3000 + 3000 + 5000
      targetWords: 11_000,
    });
  });

  it('空大纲的统计全为零', () => {
    expect(outlineStats([])).toEqual({ total: 0, done: 0, targetWords: 0 });
  });
});
