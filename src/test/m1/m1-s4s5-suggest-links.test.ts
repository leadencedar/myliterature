/**
 * S5 独立验收 · 纯函数 `suggestOutlineLinks`（design §6.1，D1 精度优先）。
 *
 * 独立于开发的 suggestOutlineLinks.test.ts：覆盖继承/提到/上限/抑制/排除 pinned 与旧节点建议，
 * 并验证「宁漏勿错」的排序（泛化别名排在真正相关的人后面）。
 */
import { describe, expect, it } from 'vitest';
import {
  KnowledgeEntrySchema,
  OutlineNodeSchema,
  type KnowledgeEntry,
  type OutlineNode,
} from '@/domain/schema';
import {
  DEFAULT_LINKS_PER_CHILD,
  suggestOutlineLinks,
  type SuggestedLink,
} from '@/features/outline/suggestOutlineLinks';

let seq = 0;
function entry(
  title: string,
  options: { aliases?: string[]; pinned?: boolean; deletedAt?: number | null } = {},
): KnowledgeEntry {
  seq += 1;
  return KnowledgeEntrySchema.parse({
    id: `e-${String(seq).padStart(3, '0')}`,
    novelId: 'n1',
    categoryId: 'c1',
    title,
    aliases: options.aliases ?? [],
    summary: '',
    fields: {},
    pinned: options.pinned ?? false,
    deletedAt: options.deletedAt ?? null,
    createdAt: seq,
    updatedAt: seq,
  });
}

let nodeSeq = 0;
function node(title: string, synopsis = '', linkedEntryIds: string[] = []): OutlineNode {
  nodeSeq += 1;
  return OutlineNodeSchema.parse({
    id: `o-${String(nodeSeq).padStart(3, '0')}`,
    novelId: 'n1',
    title,
    synopsis,
    linkedEntryIds,
    createdAt: nodeSeq,
    updatedAt: nodeSeq,
  });
}

function titles(suggestion: { suggestions: SuggestedLink[] }): string[] {
  return suggestion.suggestions.map((link) => link.entry.title);
}

describe('suggestOutlineLinks · 继承父节点显式关联', () => {
  it('按父节点 linkedEntryIds 顺序继承，标 reason=inherited，排最前', () => {
    const pei = entry('裴照');
    const shen = entry('沈砚');
    const parent = node('卷', '', [pei.id, shen.id]);
    const child = node('渡口相遇', '两人在渡口相遇。');

    const result = suggestOutlineLinks({ parent, children: [child], entries: [pei, shen] });
    expect(result).toHaveLength(1);
    expect(result[0]!.suggestions.map((link) => link.reason)).toEqual(['inherited', 'inherited']);
    expect(titles(result[0]!)).toEqual(['裴照', '沈砚']);
  });

  it('不存在/已软删除/pinned 的父关联不继承（pinned 始终注入，不应写回 links）', () => {
    const gone = entry('已删人物', { deletedAt: 1 });
    const pinned = entry('灵气', { pinned: true });
    const pei = entry('裴照');
    const parent = node('卷', '', ['ghost', gone.id, pinned.id, pei.id]);
    const child = node('渡口相遇', '');

    const result = suggestOutlineLinks({
      parent,
      children: [child],
      entries: [gone, pinned, pei],
    });
    expect(titles(result[0]!)).toEqual(['裴照']);
  });
});

describe('suggestOutlineLinks · 提到项', () => {
  it('只对传入子节点（本批新节点）建议；无建议的子节点不出现', () => {
    const shen = entry('沈砚');
    const childA = node('渡口相遇', '沈砚在渡口等人。');
    const childB = node('北上', '风雪很大。'); // 无命中

    const result = suggestOutlineLinks({
      parent: node('卷'),
      children: [childA, childB],
      entries: [shen],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.child.id).toBe(childA.id);
  });

  it('命中别名时保留 matchedName（作者能看出关联的是别名）', () => {
    const shen = entry('沈砚', { aliases: ['砚哥'] });
    const child = node('渡口', '砚哥拔刀。');
    const result = suggestOutlineLinks({ parent: node('卷'), children: [child], entries: [shen] });
    expect(result[0]!.suggestions[0]).toMatchObject({
      reason: 'mentioned',
      matchedName: '砚哥',
    });
  });

  it('排除继承项、子节点已有 links、pinned、已删除条目', () => {
    const inherited = entry('裴照');
    const own = entry('青冥宗');
    const pinned = entry('灵气', { pinned: true });
    const deleted = entry('旧设定', { deletedAt: 1 });
    const fresh = entry('沈砚');
    const parent = node('卷', '', [inherited.id]);
    const child = node('渡口相遇', '裴照 青冥宗 灵气 旧设定 沈砚 都在。', [own.id]);

    const result = suggestOutlineLinks({
      parent,
      children: [child],
      entries: [inherited, own, pinned, deleted, fresh],
    });
    expect(titles(result[0]!)).toEqual(['裴照', '沈砚']);
  });

  it('上限：继承项不占「提到」名额，但总建议数受 limitPerChild 约束', () => {
    const a = entry('人物甲');
    const b = entry('人物乙');
    const mentioned = Array.from({ length: 10 }, (_, index) =>
      entry(`角色${'一二三四五六七八九十'[index]}之`),
    );
    const parent = node('卷', '', [a.id, b.id]);
    const child = node('全部到齐', mentioned.map((item) => item.title).join(' '));

    const result = suggestOutlineLinks({
      parent,
      children: [child],
      entries: [a, b, ...mentioned],
    });
    expect(titles(result[0]!)).toHaveLength(DEFAULT_LINKS_PER_CHILD);
    expect(result[0]!.suggestions.slice(0, 2).map((link) => link.reason)).toEqual([
      'inherited',
      'inherited',
    ]);
    // 6 个提到名额
    expect(result[0]!.suggestions.filter((link) => link.reason === 'mentioned')).toHaveLength(6);

    const narrow = suggestOutlineLinks({
      parent,
      children: [child],
      entries: [a, b, ...mentioned],
      limitPerChild: 4,
    });
    expect(titles(narrow[0]!)).toHaveLength(4);
  });

  it('继承项超过 limit 时不被截断，只是「提到」名额为 0', () => {
    const inherited = Array.from({ length: 10 }, (_, index) => entry(`继承人物${index}`));
    const mentioned = entry('沈砚');
    const parent = node(
      '卷',
      '',
      inherited.map((item) => item.id),
    );
    const child = node('渡口', '沈砚也在。');

    const result = suggestOutlineLinks({
      parent,
      children: [child],
      entries: [...inherited, mentioned],
    });
    expect(result[0]!.suggestions).toHaveLength(10);
    expect(result[0]!.suggestions.every((link) => link.reason === 'inherited')).toBe(true);
  });

  it('抑制集：childId:entryId 命中的不出现', () => {
    const shen = entry('沈砚');
    const pei = entry('裴照');
    const child = node('渡口', '沈砚与裴照。');
    const suppressed = new Set([`${child.id}:${shen.id}`]);

    const result = suggestOutlineLinks({
      parent: node('卷'),
      children: [child],
      entries: [shen, pei],
      suppressed,
    });
    expect(titles(result[0]!)).toEqual(['裴照']);
  });

  it('精度优先：泛化别名排在真正的角色名之后', () => {
    const generic = entry('无名师父', { aliases: ['师父'] });
    const shen = entry('沈砚');
    const child = node('渡口', '师父看着沈砚。');

    const result = suggestOutlineLinks({
      parent: node('卷'),
      children: [child],
      entries: [generic, shen],
    });
    expect(titles(result[0]!)).toEqual(['沈砚', '无名师父']);
  });

  it('空输入/无命中返回空；两次调用深相等（确定性）', () => {
    const empty = suggestOutlineLinks({ parent: node('卷'), children: [], entries: [] });
    expect(empty).toEqual([]);

    const shen = entry('沈砚');
    const input = {
      parent: node('卷'),
      children: [node('渡口', '沈砚来了。')],
      entries: [shen],
    };
    const first = suggestOutlineLinks(input);
    expect(suggestOutlineLinks(input)).toEqual(first);
    expect(JSON.stringify(suggestOutlineLinks(input))).toBe(JSON.stringify(first));
  });
});
