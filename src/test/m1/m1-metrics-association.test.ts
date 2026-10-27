/**
 * 指标 2 独立验收（关联质量：错配率 <5%，宁漏勿错）。
 *
 * 自动化部分用 20 个「采用后的子节点」夹具 + 陷阱条目（泛化别名、短名、同名、pinned、已删除、
 * 已抑制、父显式继承），断言建议集合没有“无中生有”的关联：
 * 每一条 mentioned 建议的名字必须真的出现在该子节点的标题/梗概里（可独立机械校验）。
 * 人工 20 例抽检见 verification-report 的 Demo 记录（本文件不硬判文学意义上的对错）。
 */
import { describe, expect, it } from 'vitest';
import {
  KnowledgeEntrySchema,
  OutlineNodeSchema,
  type KnowledgeEntry,
  type OutlineNode,
} from '@/domain/schema';
import { suggestOutlineLinks } from '@/features/outline/suggestOutlineLinks';

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

/** 独立于实现的名字归一（只做 NFKC + lower；夹具不含其它边界字符） */
function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

const realEntries = [
  entry('沈砚', { aliases: ['砚哥'] }),
  entry('裴照'),
  entry('林越', { aliases: ['阿越'] }),
  entry('青冥宗'),
  entry('渡口'),
];
const pinnedEntry = entry('灵气', { pinned: true });
const deletedEntry = entry('已删人物', { deletedAt: 1 });
const genericEntry = entry('无名师父', { aliases: ['师父'] });

const parent = node('第一卷', '', [realEntries[1]!.id]); // 父显式关联：裴照

/** 20 个「采用后」的子节点：名字/别名/泛化词/无命中混合 */
const CHILD_SPECS: { title: string; synopsis: string }[] = [
  { title: '渡口相遇', synopsis: '沈砚在渡口与裴照相遇。' },
  { title: '北上', synopsis: '沈砚的妹妹下落不明，裴照沉默。' },
  { title: '旧怨', synopsis: '裴照提起当年青冥宗的旧怨。' },
  { title: '阿越', synopsis: '阿越在渡口醒来。' },
  { title: '师父', synopsis: '师父看着沈砚，没有说话。' },
  { title: '风雪', synopsis: '风雪很大，没有人说话。' },
  { title: '重逢', synopsis: '林越与沈砚在青冥宗旧址重逢。' },
  { title: '砚哥', synopsis: '砚哥拔刀。' },
  { title: '旧物', synopsis: '青冥宗的旧物上刻着渡口的名字。' },
  { title: '兄妹', synopsis: '沈砚想起妹妹，于是拒绝北上。' },
  { title: '渡口夜话', synopsis: '裴照在渡口等了一夜。' },
  { title: '令牌', synopsis: '林越掏出一枚青冥宗令牌。' },
  { title: '雨夜', synopsis: '雨里只有脚步声。' },
  { title: '旧账', synopsis: '裴照与沈砚算起了旧账。' },
  { title: '师父的刀', synopsis: '师父的刀落在渡口。' },
  { title: '阿越北上', synopsis: '阿越跟着裴照北上。' },
  { title: '妹妹', synopsis: '妹妹的名字谁都不敢提。' },
  { title: '青冥旧事', synopsis: '青冥宗的旧事被重新提起。' },
  { title: '入城', synopsis: '两人入城，林越在城门口等候。' },
  { title: '断后', synopsis: '沈砚决定断后，让裴照带阿越先走。' },
];
const children = CHILD_SPECS.map((spec) => node(spec.title, spec.synopsis));

describe('指标 2 · 20 例关联建议的「不无中生有」不变量', () => {
  const suggestions = suggestOutlineLinks({
    parent,
    children,
    entries: [...realEntries, pinnedEntry, deletedEntry, genericEntry],
  });
  const byChild = new Map(suggestions.map((item) => [item.child.id, item.suggestions]));

  it('每条 mentioned 建议的名字确实出现在该子节点文本里（错配上限 0/20）', () => {
    let wrong = 0;
    for (const [childId, links] of byChild) {
      const child = children.find((item) => item.id === childId)!;
      const haystack = normalize(`${child.title}\n${child.synopsis}`);
      for (const link of links.filter((item) => item.reason === 'mentioned')) {
        const names = [link.entry.title, ...link.entry.aliases].map(normalize);
        if (!names.some((name) => haystack.includes(name))) wrong += 1;
      }
    }
    expect(wrong).toBe(0);
    expect(byChild.size).toBeLessThanOrEqual(20);
  });

  it('pinned 与已删除条目永不被建议', () => {
    for (const links of byChild.values()) {
      for (const link of links) {
        expect(link.entry.id).not.toBe(pinnedEntry.id);
        expect(link.entry.id).not.toBe(deletedEntry.id);
      }
    }
  });

  it('每个有建议的子节点：裴照（父显式关联）排最前且标 inherited', () => {
    for (const links of byChild.values()) {
      expect(links[0]).toMatchObject({ reason: 'inherited' });
      expect(links[0]!.entry.id).toBe(realEntries[1]!.id);
    }
  });

  it('没有命中且无继承的子节点不出现在结果里', () => {
    const alone = suggestOutlineLinks({
      parent: node('卷'),
      children: [node('风雪', '风雪很大。')],
      entries: realEntries,
    });
    expect(alone).toEqual([]);
  });

  it('matchedName 一定是条目的标题或别名之一（作者可判断关联的是哪个名字）', () => {
    for (const links of byChild.values()) {
      for (const link of links.filter((item) => item.reason === 'mentioned')) {
        const names = [link.entry.title, ...link.entry.aliases];
        expect(names).toContain(link.matchedName);
      }
    }
  });

  it('精度排序：同一子节点里真正的角色名排在泛化别名之前', () => {
    const child = node('师父', '师父看着沈砚，没有说话。');
    const result = suggestOutlineLinks({
      parent: node('卷'),
      children: [child],
      entries: [genericEntry, realEntries[0]!],
    });
    expect(result[0]!.suggestions.map((link) => link.entry.title)).toEqual(['沈砚', '无名师父']);
  });

  it('每个子节点建议数 ≤ 8（D1 上限）', () => {
    for (const links of byChild.values()) expect(links.length).toBeLessThanOrEqual(8);
  });

  it('抑制集与确定性：同一输入两次深相等，suppressed 生效', () => {
    const input = {
      parent,
      children,
      entries: [...realEntries, pinnedEntry, deletedEntry, genericEntry],
    };
    const first = suggestOutlineLinks(input);
    const second = suggestOutlineLinks(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // 抑制「渡口相遇」子节点上的沈砚：该条不再出现在这个子节点
    const target = children[0]!;
    const shen = realEntries[0]!;
    const suppressedResult = suggestOutlineLinks({
      ...input,
      suppressed: new Set([`${target.id}:${shen.id}`]),
    });
    const targetLinks = suppressedResult.find((item) => item.child.id === target.id)!.suggestions;
    expect(targetLinks.some((link) => link.entry.id === shen.id)).toBe(false);
  });
});
