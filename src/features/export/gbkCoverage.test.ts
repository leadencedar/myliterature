import { describe, expect, it } from 'vitest';
import { isGbkCodePoint, sanitizeForPdf } from './gbkCoverage';

/**
 * 覆盖表是生成物，这里把 design.md 里同一份紧凑数据独立再放一遍，逐码位对照实现：
 * 任何一段被手改、漏掉或并错，都会在「BMP 全量对齐」用例里暴露出来。
 * 这份常量是验收数据，不要跟着 gbkCoverage.ts 改。
 */
const SPEC_COMPACT_RANGES =
  '20-7F,A4-A4,A7-A8,B0-B1,B7-B7,D7-D7,E0-E1,E8-EA,EC-ED,F2-F3,F7-F7,F9-FA,FC-FC,101-101,113-113,11B-11B,12B-12B,144-144,148-148,14D-14D,16B-16B,1CE-1CE,1D0-1D0,1D2-1D2,1D4-1D4,1D6-1D6,1D8-1D8,1DA-1DA,1DC-1DC,251-251,261-261,2C7-2C7,2C9-2CB,2D9-2D9,391-3A1,3A3-3A9,3B1-3C1,3C3-3C9,401-401,410-44F,451-451,2010-2010,2013-2016,2018-2019,201C-201D,2025-2026,2030-2030,2032-2033,2035-2035,203B-203B,2103-2103,2105-2105,2109-2109,2116-2116,2121-2121,2160-216B,2170-2179,2190-2193,2196-2199,2208-2208,220F-220F,2211-2211,2215-2215,221A-221A,221D-2220,2223-2223,2225-2225,2227-222B,222E-222E,2234-2237,223D-223D,2248-2248,224C-224C,2252-2252,2260-2261,2264-2267,226E-226F,2295-2295,2299-2299,22A5-22A5,22BF-22BF,2312-2312,2460-2469,2474-249B,2500-254B,2550-2573,2581-258F,2593-2595,25A0-25A1,25B2-25B3,25BC-25BD,25C6-25C7,25CB-25CB,25CE-25CF,25E2-25E5,2605-2606,2609-2609,2640-2640,2642-2642,3000-3003,3005-3017,301D-301E,3021-3029,3041-3093,309B-309E,30A1-30F6,30FC-30FE,3105-3129,3220-3229,3231-3231,32A3-32A3,338E-338F,339C-339E,33A1-33A1,33C4-33C4,33CE-33CE,33D1-33D2,33D5-33D5,4E00-9FA5,F92C-F92C,F979-F979,F995-F995,F9E7-F9E7,F9F1-F9F1,FA0C-FA0F,FA11-FA11,FA13-FA14,FA18-FA18,FA1F-FA21,FA23-FA24,FA27-FA29,FE30-FE31,FE33-FE44,FE49-FE52,FE54-FE57,FE59-FE66,FE68-FE6B,FF01-FF5E,FFE0-FFE5';

function parseReferenceRanges(compact: string): (readonly [number, number])[] {
  return compact.split(',').map((part) => {
    const [startText = '', endText = ''] = part.split('-');
    return [Number.parseInt(startText, 16), Number.parseInt(endText, 16)] as const;
  });
}

const REFERENCE_RANGES = parseReferenceRanges(SPEC_COMPACT_RANGES);

function inReferenceTable(codePoint: number): boolean {
  return REFERENCE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function hex(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

describe('GBK 覆盖表数据', () => {
  it('共 139 段、21887 个码位，覆盖 0x20 到 0xFFE5 之间的可编码码位', () => {
    expect(REFERENCE_RANGES).toHaveLength(139);
    const covered = REFERENCE_RANGES.reduce((sum, [start, end]) => sum + end - start + 1, 0);
    expect(covered).toBe(21887);
  });

  it('BMP 内的每个码位判定都与覆盖表逐一对齐', () => {
    const mismatched: string[] = [];
    for (let codePoint = 0x20; codePoint <= 0xffff; codePoint += 1) {
      if (isGbkCodePoint(codePoint) !== inReferenceTable(codePoint)) {
        mismatched.push(hex(codePoint));
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('每段首尾码位在覆盖内，段外紧邻码位不在', () => {
    const failures: string[] = [];
    for (const [start, end] of REFERENCE_RANGES) {
      if (!isGbkCodePoint(start)) failures.push(`${hex(start)} 是段首却未覆盖`);
      if (!isGbkCodePoint(end)) failures.push(`${hex(end)} 是段尾却未覆盖`);
      if (start > 0x20 && isGbkCodePoint(start - 1)) failures.push(`${hex(start - 1)} 不应覆盖`);
      if (end < 0xffe5 && isGbkCodePoint(end + 1)) failures.push(`${hex(end + 1)} 不应覆盖`);
    }
    expect(failures).toEqual([]);
  });
});

describe('isGbkCodePoint', () => {
  it('常见汉字、标点、全角符号、拼音字母都覆盖', () => {
    expect(isGbkCodePoint('中'.codePointAt(0)!)).toBe(true);
    expect(isGbkCodePoint('。'.codePointAt(0)!)).toBe(true);
    expect(isGbkCodePoint('，'.codePointAt(0)!)).toBe(true);
    expect(isGbkCodePoint('、'.codePointAt(0)!)).toBe(true);
    expect(isGbkCodePoint('￥'.codePointAt(0)!)).toBe(true);
    expect(isGbkCodePoint('□'.codePointAt(0)!)).toBe(true);
    expect(isGbkCodePoint('ā'.codePointAt(0)!)).toBe(true);
    expect(isGbkCodePoint('ǖ'.codePointAt(0)!)).toBe(true);
    expect(isGbkCodePoint('é'.codePointAt(0)!)).toBe(true);
  });

  it('覆盖范围的边界码位判定正确', () => {
    expect(isGbkCodePoint(0x20)).toBe(true);
    expect(isGbkCodePoint(0x1f)).toBe(false);
    expect(isGbkCodePoint(0x7f)).toBe(true);
    expect(isGbkCodePoint(0x80)).toBe(false);
    expect(isGbkCodePoint(0x4e00)).toBe(true);
    expect(isGbkCodePoint(0x9fa5)).toBe(true);
    expect(isGbkCodePoint(0x9fa6)).toBe(false);
    expect(isGbkCodePoint(0xff01)).toBe(true);
    expect(isGbkCodePoint(0xff5e)).toBe(true);
    expect(isGbkCodePoint(0xff5f)).toBe(false);
    expect(isGbkCodePoint(0xffe5)).toBe(true);
    expect(isGbkCodePoint(0xffe6)).toBe(false);
  });

  it('扩展区生僻字、emoji 与非 BMP 码位一律不覆盖', () => {
    expect(isGbkCodePoint('㵘'.codePointAt(0)!)).toBe(false);
    expect(isGbkCodePoint('䶮'.codePointAt(0)!)).toBe(false);
    expect(isGbkCodePoint('✔'.codePointAt(0)!)).toBe(false);
    expect(isGbkCodePoint('𠮷'.codePointAt(0)!)).toBe(false);
    expect(isGbkCodePoint('😀'.codePointAt(0)!)).toBe(false);
    expect(isGbkCodePoint(0x20000)).toBe(false);
    expect(isGbkCodePoint(0x10ffff)).toBe(false);
  });

  it('非法输入返回 false，不抛异常', () => {
    expect(isGbkCodePoint(-1)).toBe(false);
    expect(isGbkCodePoint(0x110000)).toBe(false);
    expect(isGbkCodePoint(Number.NaN)).toBe(false);
    expect(isGbkCodePoint(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isGbkCodePoint(0x4e00 + 0.5)).toBe(false);
  });
});

describe('sanitizeForPdf', () => {
  it('GBK 覆盖内的文本原样保留（含换行、制表与全角空格）', () => {
    const text = '中文，ABC abc 123！？\n第二行\r\n制表\t全角　空格';
    expect(sanitizeForPdf(text)).toBe(text);
  });

  it('GBK 外的生僻字与 emoji 逐个替换成一个 □', () => {
    expect(sanitizeForPdf('㵘')).toBe('□');
    expect(sanitizeForPdf('䶮')).toBe('□');
    expect(sanitizeForPdf('✔')).toBe('□');
    expect(sanitizeForPdf('😀')).toBe('□');
    expect(sanitizeForPdf('𠮷')).toBe('□');
    expect(sanitizeForPdf('灵㵘潮✔😀𠮷123')).toBe('灵□潮□□□123');
  });

  it('非 BMP 字符按码位计，一个字符只替换成一个 □', () => {
    expect(sanitizeForPdf('😀😀')).toBe('□□');
    expect(sanitizeForPdf('𠀀𠀁')).toBe('□□');
  });

  it('控制字符按原样留给上层处理', () => {
    expect(sanitizeForPdf('a\u0001b\u0007c')).toBe('a\u0001b\u0007c');
    expect(sanitizeForPdf('\n\t\r')).toBe('\n\t\r');
  });

  it('空串与纯空白不变', () => {
    expect(sanitizeForPdf('')).toBe('');
    expect(sanitizeForPdf('   ')).toBe('   ');
    expect(sanitizeForPdf('\n\n')).toBe('\n\n');
  });
});
