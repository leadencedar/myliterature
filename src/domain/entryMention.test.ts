import { describe, expect, it } from 'vitest';
import { normalizeMentionText, rankEntryMentions } from './entryMention';
import { KnowledgeEntrySchema, type KnowledgeEntry } from './schema';

/** 名称匹配的评分规则是纯函数，测试直接按设计 §2.3 的表格算期望分 */
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

describe('normalizeMentionText', () => {
  it('NFKC 把全角字母、数字、括号折成半角', () => {
    expect(normalizeMentionText('Ａｓｈ')).toBe('ash');
    expect(normalizeMentionText('第１２章（上）')).toBe('第12章(上)');
  });

  it('英文统一小写', () => {
    expect(normalizeMentionText('ASH KETCHUM')).toBe('ash ketchum');
  });

  it('去掉零宽字符，但不改变可见字符', () => {
    expect(normalizeMentionText('沈\u200b砚\u200c\u200d\ufeff')).toBe('沈砚');
    expect(normalizeMentionText('沈\u200b砚在渡口')).toBe('沈砚在渡口');
  });

  it('只裁剪首尾空白，保留内部空格与标点', () => {
    expect(normalizeMentionText('  Ash Ketchum  ')).toBe('ash ketchum');
    expect(normalizeMentionText('沈 砚')).toBe('沈 砚');
    // NFKC 会把全角逗号折成半角（兼容分解的既有行为），但标点不会被删掉
    expect(normalizeMentionText('沈砚，字青冥。')).toBe('沈砚,字青冥。');
  });

  it('不做简繁转换', () => {
    expect(normalizeMentionText('歸墟')).toBe('歸墟');
    expect(normalizeMentionText('归墟')).toBe('归墟');
  });
});

describe('rankEntryMentions', () => {
  it('标题命中：100 + min(长度,10)*2；2 字名再降 20', () => {
    const mentions = rankEntryMentions(['沈砚在渡口'], [entry()]);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.kind).toBe('title');
    expect(mentions[0]?.matchedName).toBe('沈砚');
    expect(mentions[0]?.score).toBe(84);
  });

  it('长标题按长度加分，最长封顶 10 个字', () => {
    const short = entry({ id: 'e1', title: '青冥宗' });
    const long = entry({ id: 'e2', title: '青冥宗灭门案' });
    const capped = entry({ id: 'e3', title: '青冥宗灭门案的真凶是谁' });
    const mentions = rankEntryMentions(['青冥宗灭门案的真凶是谁'], [short, long, capped]);

    const scoreOf = (id: string) => mentions.find((item) => item.entry.id === id)?.score;
    expect(scoreOf('e1')).toBe(100 + 3 * 2);
    expect(scoreOf('e2')).toBe(100 + 6 * 2);
    // 名称很长时只取前 10 个字计分，避免长句标题靠长度压过真正精确的短名
    expect(scoreOf('e3')).toBe(100 + 10 * 2);
  });

  it('别名命中：80 + min(长度,10)*2；2 字别名再降 20', () => {
    const mentions = rankEntryMentions(['小舟'], [entry({ aliases: ['小舟'] })]);
    expect(mentions[0]?.kind).toBe('alias');
    expect(mentions[0]?.matchedName).toBe('小舟');
    expect(mentions[0]?.score).toBe(80 + 2 * 2 - 20);
  });

  it('单字名称直接丢弃，不参与排序', () => {
    const text = '他走进渡口';
    expect(rankEntryMentions([text], [entry({ title: '他' })])).toEqual([]);
    expect(rankEntryMentions([text], [entry({ title: '沈砚', aliases: ['他'] })])).toEqual([]);
  });

  it('泛化别名降 50，排在同分区间之后但仍可进入', () => {
    const generic = entry({ id: 'e-generic', title: '无名老者', aliases: ['师父'] });
    const specific = entry({ id: 'e-specific', title: '老周', aliases: ['周叔'] });
    const mentions = rankEntryMentions(['师父看了看周叔'], [generic, specific]);

    expect(mentions.map((item) => item.entry.id)).toEqual(['e-specific', 'e-generic']);
    expect(mentions[0]?.score).toBe(80 + 2 * 2 - 20);
    expect(mentions[1]?.score).toBe(80 + 2 * 2 - 20 - 50);
  });

  it('同一条目多处命中（标题 + 别名）只返回一条，取最高分', () => {
    const mentions = rankEntryMentions(
      ['沈砚和沈砚之都在'],
      [entry({ title: '沈砚', aliases: ['沈砚之'] })],
    );
    expect(mentions).toHaveLength(1);
    // 「沈砚之」命中别名 3 字：80 + 6 = 86，高于标题 2 字的 84
    expect(mentions[0]?.kind).toBe('alias');
    expect(mentions[0]?.matchedName).toBe('沈砚之');
    expect(mentions[0]?.score).toBe(86);
  });

  it('全半角、大小写、零宽字符都能命中，matchedName 保留原始写法', () => {
    const fullWidth = entry({ id: 'e1', title: 'Ａｓｈ' });
    expect(rankEntryMentions(['ash'], [fullWidth])[0]?.matchedName).toBe('Ａｓｈ');

    const latin = entry({ id: 'e2', title: 'Pei Zhao' });
    expect(rankEntryMentions(['pei zhao'], [latin])[0]?.score).toBe(100 + 8 * 2);

    const spaced = entry({ id: 'e3', title: '沈砚' });
    expect(rankEntryMentions(['沈\u200b砚在渡口'], [spaced])[0]?.entry.id).toBe('e3');
  });

  it('排序：分数降序 → 命中名长度降序 → id 升序', () => {
    const twoChar = entry({ id: 'e-b', title: '沈砚' });
    const sameNameA = entry({ id: 'e-a', title: '裴照' });
    const longer = entry({ id: 'e-c', title: '青冥宗长老' });
    const mentions = rankEntryMentions(['沈砚、裴照、青冥宗长老'], [twoChar, sameNameA, longer]);

    expect(mentions.map((item) => item.entry.id)).toEqual(['e-c', 'e-a', 'e-b']);
  });

  it('同分同名长时按 id 升序，输入顺序不影响结果', () => {
    const a = entry({ id: 'e-a', title: '沈砚' });
    const b = entry({ id: 'e-b', title: '裴照' });
    expect(rankEntryMentions(['沈砚裴照'], [b, a]).map((item) => item.entry.id)).toEqual([
      'e-a',
      'e-b',
    ]);
  });

  it('默认最多 8 条，可显式指定上限', () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `e-${index}`, title: `角色甲${index}` }),
    );
    const text = entries.map((item) => item.title).join('、');

    expect(rankEntryMentions([text], entries)).toHaveLength(8);
    expect(rankEntryMentions([text], entries, { limit: 2 })).toHaveLength(2);
    expect(rankEntryMentions([text], entries, { limit: 0 })).toEqual([]);
  });

  it('excludeIds 排除指定条目', () => {
    const a = entry({ id: 'e-a', title: '沈砚' });
    const b = entry({ id: 'e-b', title: '裴照' });
    const mentions = rankEntryMentions(['沈砚与裴照'], [a, b], {
      excludeIds: new Set(['e-a']),
    });
    expect(mentions.map((item) => item.entry.id)).toEqual(['e-b']);
  });

  it('minScore 过滤低分命中', () => {
    const named = entry({ id: 'e-named', title: '沈砚' });
    const generic = entry({ id: 'e-generic', title: '无名老者', aliases: ['师父'] });
    const mentions = rankEntryMentions(['沈砚对师父行礼'], [named, generic], { minScore: 20 });
    expect(mentions.map((item) => item.entry.id)).toEqual(['e-named']);
  });

  it('多段文本合并匹配，空输入返回空', () => {
    const a = entry({ id: 'e-a', title: '沈砚' });
    const b = entry({ id: 'e-b', title: '裴照' });
    expect(rankEntryMentions(['沈砚', '', '裴照'], [a, b])).toHaveLength(2);
    expect(rankEntryMentions([], [a, b])).toEqual([]);
    expect(rankEntryMentions([''], [a, b])).toEqual([]);
    expect(rankEntryMentions(['沈砚'], [])).toEqual([]);
  });

  it('两次调用逐字节可复现', () => {
    const entries = [
      entry({ id: 'e-c', title: '青冥宗' }),
      entry({ id: 'e-a', title: '沈砚', aliases: ['小舟'] }),
      entry({ id: 'e-b', title: '裴照' }),
    ];
    const first = rankEntryMentions(['沈砚与裴照在青冥宗重逢'], entries);
    const second = rankEntryMentions(['沈砚与裴照在青冥宗重逢'], entries);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
