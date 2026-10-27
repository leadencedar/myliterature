/**
 * S1 独立验收：`rankEntryMentions` / `normalizeMentionText`（design §2）。
 *
 * 独立于开发测试：期望值按设计 §2.3 的评分表逐项手算，不复用开发用例的断言。
 * 重点覆盖「宁可漏、不可错」的精度边界：短名降权、泛化别名、全半角/零宽、排序全序。
 */
import { describe, expect, it } from 'vitest';
import { KnowledgeEntrySchema, type KnowledgeEntry } from '@/domain/schema';
import { normalizeMentionText, rankEntryMentions } from '@/domain/entryMention';

let seq = 0;
function entry(title: string, aliases: string[] = []): KnowledgeEntry {
  seq += 1;
  return KnowledgeEntrySchema.parse({
    id: `e-${String(seq).padStart(3, '0')}`,
    novelId: 'n1',
    categoryId: 'c-char',
    title,
    aliases,
    summary: '',
    fields: {},
    pinned: false,
    createdAt: seq,
    updatedAt: seq,
  });
}

/** 设计 §2.3 的分数公式：手算期望 */
function titleScore(name: string): number {
  const len = normalizeMentionText(name).length;
  let score = 100 + Math.min(len, 10) * 2;
  if (len === 2) score -= 20;
  return score;
}
function aliasScore(name: string): number {
  const len = normalizeMentionText(name).length;
  let score = 80 + Math.min(len, 10) * 2;
  if (len === 2) score -= 20;
  return score;
}

describe('normalizeMentionText · 只做不改变语义的归一（design §2.2）', () => {
  it('NFKC：全角字母/数字/括号转半角，英文统一小写', () => {
    expect(normalizeMentionText('Ａｓｈ（１２３）')).toBe('ash(123)');
  });

  it('去掉零宽字符（\\u200b-\\u200d / \\ufeff）', () => {
    expect(normalizeMentionText('沈\u200b硯\u200c\u200d\ufeff')).toBe('沈硯');
  });

  it('只裁首尾空白，保留内部空格与标点', () => {
    expect(normalizeMentionText('  A sh.  ')).toBe('a sh.');
    expect(normalizeMentionText('林 越。')).toBe('林 越。');
  });

  it('不做简繁转换（引入转换表会误伤，设计明确不做）', () => {
    expect(normalizeMentionText('沈硯')).toBe('沈硯');
    expect(normalizeMentionText('沈硯')).not.toBe(normalizeMentionText('沈砚'));
  });
});

describe('rankEntryMentions · 评分表（design §2.3）', () => {
  it('title 命中：100 + min(长度,10)*2；3 字 = 106', () => {
    const result = rankEntryMentions(['裴照之站在渡口'], [entry('裴照之')]);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(titleScore('裴照之'));
    expect(result[0]!.score).toBe(106);
    expect(result[0]!.kind).toBe('title');
    expect(result[0]!.matchedName).toBe('裴照之');
  });

  it('alias 命中：80 + min(长度,10)*2；3 字 = 86，2 字 = 64', () => {
    const three = rankEntryMentions(['阿越儿抬起头'], [entry('林越', ['阿越儿'])]);
    expect(three[0]).toMatchObject({ kind: 'alias', matchedName: '阿越儿' });
    expect(three[0]!.score).toBe(aliasScore('阿越儿'));
    expect(three[0]!.score).toBe(86);

    const two = rankEntryMentions(['阿越抬起头'], [entry('林越', ['阿越'])]);
    expect(two[0]!.score).toBe(64);
  });

  it('2 字名降 20：title 2 字 = 84，alias 2 字 = 64', () => {
    expect(rankEntryMentions(['裴照拔刀'], [entry('裴照')])[0]!.score).toBe(84);
    expect(rankEntryMentions(['阿越拔刀'], [entry('林越', ['阿越'])])[0]!.score).toBe(64);
  });

  it('长度加分封顶 10 个字：10 字与 11 字同分 120', () => {
    const ten = '一二三四五六七八九十';
    const eleven = `${ten}一`;
    expect(rankEntryMentions([ten], [entry(ten)])[0]!.score).toBe(120);
    expect(rankEntryMentions([eleven], [entry(eleven)])[0]!.score).toBe(120);
  });

  it('单字名称直接丢弃（不产生 score=0 命中）', () => {
    expect(rankEntryMentions(['刀在桌上'], [entry('刀')])).toEqual([]);
    expect(rankEntryMentions(['他来了'], [entry('林越', ['他'])])).toEqual([]);
  });

  it('泛化别名叠加惩罚：2 字泛化别名 = 80+4-20-50 = 14，仍可进但排最后', () => {
    const generic = entry('某师父', ['师父']);
    const real = entry('裴照');
    const result = rankEntryMentions(['师父看着裴照'], [generic, real]);
    expect(result.map((item) => item.entry.title)).toEqual(['裴照', '某师父']);
    expect(result[1]!.score).toBe(14);
  });

  it('同一条目多处命中只返回一条，取最高分并保留对应命中名', () => {
    const lin = entry('林越', ['阿越', '小舟']);
    const result = rankEntryMentions(['阿越看着林越'], [lin]);
    expect(result).toHaveLength(1);
    // title 2 字 = 84 > alias 2 字 = 64
    expect(result[0]).toMatchObject({ kind: 'title', matchedName: '林越', score: 84 });
  });

  it('别名更长时取别名分：title 2 字 84 < alias 3 字 86，返回别名', () => {
    const lin = entry('林越', ['林小舟']);
    const result = rankEntryMentions(['林小舟'], [lin]);
    expect(result[0]).toMatchObject({ kind: 'alias', matchedName: '林小舟', score: 86 });
  });

  it('全半角、大小写、零宽都能命中，matchedName 保留原始写法', () => {
    const ash = entry('Ash', ['Ａｓｈ']);
    const result = rankEntryMentions(['ASH 与 ＡＳＨ，还有 A\u200bsh'], [ash]);
    expect(result).toHaveLength(1);
    // title 归一化后 3 字 = 106；别名同一名字也命中但 title 基分更高
    expect(result[0]!.matchedName).toBe('Ash');
    expect(result[0]!.score).toBe(106);
  });
});

describe('rankEntryMentions · 排序与截断（deterministic 全序）', () => {
  it('分数降序 → 命中名长度降序 → id 升序', () => {
    const long = entry('裴照之'); // 106
    const short = entry('裴照'); // 84
    const sameScoreA = entry('一二三'); // 106
    const sameScoreB = entry('四五六'); // 106
    const result = rankEntryMentions(
      ['裴照之 裴照 一二三 四五六'],
      [short, long, sameScoreB, sameScoreA],
    );
    // 106 档：裴照之(3 字) 与 一二三/四五六(3 字) 同名长 → 按 id 升序（创建顺序 long < sameScoreA < sameScoreB）
    const ids = result.map((item) => item.entry.id);
    expect(ids).toEqual([long.id, sameScoreA.id, sameScoreB.id, short.id]);
    expect(result.map((item) => item.score)).toEqual([106, 106, 106, 84]);
  });

  it('同分但命中名更长者在前', () => {
    const ten = entry('一二三四五六七八九十'); // 120
    const eleven = entry('一二三四五六七八九十一'); // 120
    const result = rankEntryMentions([`${ten.title}${eleven.title}`], [ten, eleven]);
    expect(result.map((item) => item.entry.title)).toEqual([eleven.title, ten.title]);
  });

  it('输入顺序不影响结果（两次调用逐字节可复现）', () => {
    const a = entry('裴照');
    const b = entry('林越');
    const c = entry('青冥宗', ['青冥']);
    const texts = ['裴照与林越在青冥宗旧址'];
    const first = rankEntryMentions(texts, [a, b, c]);
    const second = rankEntryMentions(texts, [c, a, b]);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('多段文本用换行拼接：不跨段拼出假名字，但各段都参与匹配', () => {
    const shen = entry('沈砚');
    // 第一段以「沈」结尾、第二段以「砚」开头，拼起来会误命中「沈砚」
    expect(rankEntryMentions(['他叫沈', '砚台很旧'], [shen])).toEqual([]);
    // 同一段/不同段各自出现完整名字都能命中
    expect(rankEntryMentions(['沈砚在此', '另一段'], [shen])).toHaveLength(1);
  });

  it('默认最多 8 条，limit 可显式指定；limit<=0 返回空', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry(`人物${String.fromCharCode(0x4e00 + i)}`),
    );
    const text = entries.map((item) => item.title).join('，');
    expect(rankEntryMentions([text], entries)).toHaveLength(8);
    expect(rankEntryMentions([text], entries, { limit: 3 })).toHaveLength(3);
    expect(rankEntryMentions([text], entries, { limit: 0 })).toEqual([]);
  });

  it('excludeIds 排除指定条目；minScore 过滤低分命中', () => {
    const lin = entry('林越', ['阿越']);
    const pei = entry('裴照');
    const both = rankEntryMentions(['林越与裴照'], [lin, pei], { excludeIds: new Set([lin.id]) });
    expect(both.map((item) => item.entry.title)).toEqual(['裴照']);

    const aliasOnly = rankEntryMentions(['阿越'], [lin], { minScore: 70 });
    expect(aliasOnly).toEqual([]); // alias 2 字 = 64 < 70
  });

  it('空输入返回空：空文本、空条目、全空文本数组', () => {
    expect(rankEntryMentions([], [entry('林越')])).toEqual([]);
    expect(rankEntryMentions(['林越'], [])).toEqual([]);
    expect(rankEntryMentions(['', '   '], [entry('林越')])).toEqual([]);
  });

  it('内部空格不删：条目「A sh」与文本「Ash」不互相命中', () => {
    const spaced = entry('A sh');
    expect(rankEntryMentions(['Ash'], [spaced])).toEqual([]);
    expect(rankEntryMentions(['A sh'], [spaced])).toHaveLength(1);
  });

  it('重叠名称都保留，长名因分高排在短名前', () => {
    const short = entry('裴照');
    const long = entry('裴照之');
    const result = rankEntryMentions(['裴照之'], [short, long]);
    expect(result.map((item) => item.entry.title)).toEqual(['裴照之', '裴照']);
  });
});
