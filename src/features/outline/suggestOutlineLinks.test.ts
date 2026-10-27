import { describe, expect, it } from 'vitest';
import {
  KnowledgeEntrySchema,
  OutlineNodeSchema,
  type KnowledgeEntry,
  type OutlineNode,
} from '@/domain/schema';
import { DEFAULT_LINKS_PER_CHILD, suggestOutlineLinks } from './suggestOutlineLinks';

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    id: 'e1',
    novelId: 'n1',
    categoryId: 'c1',
    title: '沈砚',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function child(overrides: Partial<OutlineNode> = {}): OutlineNode {
  return OutlineNodeSchema.parse({
    id: 'child-1',
    novelId: 'n1',
    parentId: 'parent',
    title: '第 1 章',
    synopsis: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function parent(overrides: Partial<OutlineNode> = {}): OutlineNode {
  return OutlineNodeSchema.parse({
    id: 'parent',
    novelId: 'n1',
    title: '第一卷',
    synopsis: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

describe('suggestOutlineLinks · 继承', () => {
  it('父节点显式关联排在建议最前，标 inherited；顺序与父节点一致', () => {
    const a = entry({ id: 'e-a', title: '裴照' });
    const b = entry({ id: 'e-b', title: '青冥宗' });
    const result = suggestOutlineLinks({
      parent: parent({ linkedEntryIds: ['e-b', 'e-a'] }),
      children: [child()],
      entries: [a, b],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.suggestions.map((item) => item.entry.id)).toEqual(['e-b', 'e-a']);
    expect(result[0]?.suggestions.every((item) => item.reason === 'inherited')).toBe(true);
  });

  it('父节点的已删除/不存在/核心条目关联不继承', () => {
    const alive = entry({ id: 'e-alive', title: '裴照' });
    const deleted = entry({ id: 'e-deleted', title: '旧人物', deletedAt: 1 });
    const pinned = entry({ id: 'e-pinned', title: '归墟界', pinned: true });
    const result = suggestOutlineLinks({
      parent: parent({ linkedEntryIds: ['missing', 'e-deleted', 'e-pinned', 'e-alive'] }),
      children: [child()],
      entries: [alive, deleted, pinned],
    });

    expect(result[0]?.suggestions.map((item) => item.entry.id)).toEqual(['e-alive']);
  });

  it('继承后即使子节点文本提到同一人也不重复建议', () => {
    const pei = entry({ id: 'e-pei', title: '裴照' });
    const result = suggestOutlineLinks({
      parent: parent({ linkedEntryIds: ['e-pei'] }),
      children: [child({ synopsis: '裴照在渡口等沈砚。' })],
      entries: [pei],
    });

    expect(result[0]?.suggestions).toHaveLength(1);
    expect(result[0]?.suggestions[0]?.reason).toBe('inherited');
  });
});

describe('suggestOutlineLinks · 名称命中', () => {
  it('从子节点标题与梗概里找提到的条目，按评分排序并带命中名', () => {
    const shen = entry({ id: 'e-shen', title: '沈砚' });
    const boat = entry({ id: 'e-boat', title: '林越', aliases: ['小舟'] });
    const world = entry({ id: 'e-world', title: '归墟界', categoryId: 'c-world' });
    const result = suggestOutlineLinks({
      parent: parent(),
      children: [child({ title: '渡口', synopsis: '沈砚与小舟在归墟界相遇。' })],
      entries: [shen, boat, world],
    });

    const mentions = result[0]?.suggestions ?? [];
    // 标题 2 字命中 84；别名 2 字命中 64；「归墟界」标题 3 字命中 106
    expect(mentions.map((item) => item.entry.id)).toEqual(['e-world', 'e-shen', 'e-boat']);
    expect(mentions.every((item) => item.reason === 'mentioned')).toBe(true);
    expect(mentions.find((item) => item.entry.id === 'e-boat')?.matchedName).toBe('小舟');
  });

  it('核心设定不进入建议（始终注入，不需要也不应该由作者再关联）', () => {
    const pinned = entry({ id: 'e-pinned', title: '归墟界', pinned: true });
    const result = suggestOutlineLinks({
      parent: parent(),
      children: [child({ synopsis: '归墟界下起了雪。' })],
      entries: [pinned],
    });
    expect(result).toEqual([]);
  });

  it('子节点已有的关联不重复建议', () => {
    const pei = entry({ id: 'e-pei', title: '裴照' });
    const result = suggestOutlineLinks({
      parent: parent(),
      children: [child({ synopsis: '裴照赶来。', linkedEntryIds: ['e-pei'] })],
      entries: [pei],
    });
    expect(result).toEqual([]);
  });

  it('没有建议的子节点不出现在结果里；全空时返回空数组', () => {
    const pei = entry({ id: 'e-pei', title: '裴照' });
    const result = suggestOutlineLinks({
      parent: parent(),
      children: [
        child({ id: 'c1', title: '无人出场' }),
        child({ id: 'c2', synopsis: '裴照出场。' }),
      ],
      entries: [pei],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.child.id).toBe('c2');

    expect(suggestOutlineLinks({ parent: parent(), children: [child()], entries: [] })).toEqual([]);
  });
});

describe('suggestOutlineLinks · 上限与抑制', () => {
  it('默认上限 8：继承的显式关联不占名额，提到项补足剩余名额', () => {
    const inherited = entry({ id: 'e-inherit', title: '裴照' });
    const many = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `e-${index}`, title: `角色名称${index}` }),
    );
    const result = suggestOutlineLinks({
      parent: parent({ linkedEntryIds: [inherited.id] }),
      children: [child({ synopsis: [inherited, ...many].map((item) => item.title).join('、') })],
      entries: [inherited, ...many],
    });

    const suggestions = result[0]?.suggestions ?? [];
    expect(DEFAULT_LINKS_PER_CHILD).toBe(8);
    expect(suggestions).toHaveLength(8);
    expect(suggestions[0]?.reason).toBe('inherited');
    expect(suggestions.filter((item) => item.reason === 'mentioned')).toHaveLength(7);
  });

  it('limitPerChild 可收窄提到项；继承项仍完整保留', () => {
    const a = entry({ id: 'e-a', title: '裴照' });
    const b = entry({ id: 'e-b', title: '沈砚' });
    const c = entry({ id: 'e-c', title: '青冥宗' });
    const result = suggestOutlineLinks({
      parent: parent({ linkedEntryIds: ['e-a', 'e-b'] }),
      children: [child({ synopsis: '裴照、沈砚、青冥宗。' })],
      entries: [a, b, c],
      limitPerChild: 2,
    });

    expect(result[0]?.suggestions.map((item) => item.entry.id)).toEqual(['e-a', 'e-b']);
  });

  it('suppressed 的 childId:entryId 不再建议，但不影响其他子节点', () => {
    const pei = entry({ id: 'e-pei', title: '裴照' });
    const result = suggestOutlineLinks({
      parent: parent(),
      children: [
        child({ id: 'c1', synopsis: '裴照登场。' }),
        child({ id: 'c2', synopsis: '裴照登场。' }),
      ],
      entries: [pei],
      suppressed: new Set(['c1:e-pei']),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.child.id).toBe('c2');
    expect(result[0]?.suggestions.map((item) => item.entry.id)).toEqual(['e-pei']);
  });

  it('两次调用完全深相等（确定性）', () => {
    const entries = [
      entry({ id: 'e-z', title: '青冥宗' }),
      entry({ id: 'e-a', title: '沈砚' }),
      entry({ id: 'e-b', title: '裴照' }),
    ];
    const input = {
      parent: parent({ linkedEntryIds: ['e-b'] }),
      children: [child({ id: 'c1', synopsis: '沈砚与裴照在青冥宗相见。' })],
      entries,
    };
    expect(suggestOutlineLinks(input)).toEqual(suggestOutlineLinks(input));
  });
});
