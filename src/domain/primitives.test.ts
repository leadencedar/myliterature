import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  countWords,
  diffDays,
  isCjkCodePoint,
  newId,
  parseLocalDate,
  toLocalDate,
  weekdayOf,
} from './primitives';

/** 修正前的算法：去掉空白后数字符。用来证明纯中文的结果没有变 */
function legacyCountWords(text: string): number {
  return Array.from(text.replace(/\s+/gu, '')).length;
}

describe('字数 · 纯中文与旧算法完全一致', () => {
  const samples = [
    '他没有回头。',
    '　　沈砚背起行囊时天还没亮。渔村的雾压得很低。',
    '「你要走？」他问。',
    '灵潮在子夜翻涌起来，玉佩烫得几乎握不住。',
    '第一章　离乡',
    '他说,好。',
  ];

  it.each(samples)('「%s」', (text) => {
    // 既有作品的字数不该因为这次修正而变动
    expect(countWords(text)).toBe(legacyCountWords(text));
  });

  it('全角空格与换行不计入', () => {
    expect(countWords('　　他没有回头。\n\n第二天。')).toBe(countWords('他没有回头。第二天。'));
  });
});

describe('字数 · 英文按词计', () => {
  it('六个词就是六个字，不是三十', () => {
    const sentence = 'He shouldered the pack before dawn.';
    // 修正前这里返回 30：一章英文会虚报到五倍，写作计划跟着失真
    expect(legacyCountWords(sentence)).toBe(30);
    expect(countWords(sentence)).toBe(6);
  });

  it('多个空格、换行、制表符都只算一个分隔', () => {
    expect(countWords('He   left\n\nthe\tvillage')).toBe(4);
  });

  it('句末标点跟着词，不额外计数', () => {
    expect(countWords('Hello, world!')).toBe(2);
  });

  it('空字符串与纯空白是 0', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n　\t')).toBe(0);
  });
});

describe('字数 · 中英混排', () => {
  it('汉字按字、拉丁词按词，相加', () => {
    // 他说 = 2 字，hello world = 2 词
    expect(countWords('他说 hello world')).toBe(4);
  });

  it('紧贴在汉字旁边的拉丁词不会被吞掉', () => {
    expect(countWords('他用 Python 写的')).toBe(2 + 1 + 2);
    expect(countWords('他用Python写的')).toBe(2 + 1 + 2);
  });

  it('扩展区汉字不会被算成两个', () => {
    // U+20B9F 是扩展 B 区的汉字，UTF-16 里占两个码元
    expect(countWords('\u{20B9F}')).toBe(1);
  });
});

describe('CJK 判定', () => {
  it('汉字、假名、谚文、全角与 CJK 标点都算', () => {
    for (const char of ['他', '。', '、', '「', '，', '！', 'か', 'ア', '한']) {
      expect(isCjkCodePoint(char.codePointAt(0)!)).toBe(true);
    }
  });

  it('拉丁字母、数字、半角标点不算', () => {
    for (const char of ['a', 'Z', '1', ',', '.', '-']) {
      expect(isCjkCodePoint(char.codePointAt(0)!)).toBe(false);
    }
  });
});

describe('本地日期工具', () => {
  it('按本地时区格式化，不用 UTC', () => {
    expect(toLocalDate(new Date(2026, 2, 5))).toBe('2026-03-05');
  });

  it('加减天数跨月正确', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('跨月与跨年的天数差', () => {
    expect(diffDays('2026-02-28', '2026-03-01')).toBe(1);
    expect(diffDays('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('星期，0 = 周日', () => {
    // 2026-03-01 是周日
    expect(weekdayOf('2026-03-01')).toBe(0);
    expect(weekdayOf('2026-03-02')).toBe(1);
  });

  it('解析出的是本地零点', () => {
    const date = parseLocalDate('2026-03-05');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(5);
    expect(date.getHours()).toBe(0);
  });
});

/** UUID v4 的标准形状，含版本位与变体位 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('实体 ID', () => {
  const realCrypto = globalThis.crypto;

  afterEach(() => {
    vi.stubGlobal('crypto', realCrypto);
  });

  it('默认走 crypto.randomUUID', () => {
    expect(newId()).toMatch(UUID_V4);
    expect(new Set(Array.from({ length: 200 }, newId)).size).toBe(200);
  });

  it('非安全上下文下 randomUUID 不存在，退到 getRandomValues', () => {
    /**
     * 这正是用手机通过局域网 IP（http://192.168.x.x）访问时的真实情形：
     * crypto.randomUUID 只在安全上下文里存在，而 getRandomValues 不受此限制。
     * 这条路不通，整个应用连一本书都建不出来。
     */
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array<ArrayBuffer>) => realCrypto.getRandomValues(array),
    });

    const ids = Array.from({ length: 200 }, newId);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(200);
  });

  it('连 getRandomValues 都没有时仍然给得出 id', () => {
    vi.stubGlobal('crypto', undefined);

    const ids = Array.from({ length: 200 }, newId);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(200);
  });

  it('crypto 存在但两个方法都缺失也不抛错', () => {
    vi.stubGlobal('crypto', {});
    expect(newId()).toMatch(UUID_V4);
  });
});
