/**
 * GBK 覆盖表与 PDF 文本净化。
 *
 * 生成物，不要手改。数据生成自 CP936/GBK 编码表：对 `cp in range(0x20, 0x10000)`
 * 逐个尝试 `chr(cp).encode('gbk')`，成功即收录，等价于「GBK 能编码的 Unicode 码位」。
 * 139 段、21887 个码位，压成一行紧凑范围表 —— 摊成两万多行会把 diff 和 review 都毁掉。
 *
 * 用途见 ./pdf.ts：PDF 用非嵌入 CID 字体（STSong-Light + Adobe-GB1），阅读器只保证
 * GBK 范围内的字有正确字形；范围外的生僻字与全部非 BMP 字符（emoji、扩展 B 汉字）
 * 会显示成别的字或空白，而且不会报错。所以写进 PDF 文本层之前必须按这张表替换成
 * '□' —— 宁可见到一个明确的占位符，也不要看到错字。
 *
 * 为什么自己生成而不是引编码库：整张表只有 1.3 KB，二分查找几十行就够；
 * 本功能零运行时依赖，为一次查表引一个字符集库不值得。
 */

/** U+25A1，GBK 有字形，因此可以安全地进入 PDF 的文本层 */
const REPLACEMENT = '□';

/** 紧凑范围表：`起-止` 十六进制码位，逗号分隔，含首尾 */
const GBK_COMPACT_RANGES =
  '20-7F,A4-A4,A7-A8,B0-B1,B7-B7,D7-D7,E0-E1,E8-EA,EC-ED,F2-F3,F7-F7,F9-FA,FC-FC,101-101,113-113,11B-11B,12B-12B,144-144,148-148,14D-14D,16B-16B,1CE-1CE,1D0-1D0,1D2-1D2,1D4-1D4,1D6-1D6,1D8-1D8,1DA-1DA,1DC-1DC,251-251,261-261,2C7-2C7,2C9-2CB,2D9-2D9,391-3A1,3A3-3A9,3B1-3C1,3C3-3C9,401-401,410-44F,451-451,2010-2010,2013-2016,2018-2019,201C-201D,2025-2026,2030-2030,2032-2033,2035-2035,203B-203B,2103-2103,2105-2105,2109-2109,2116-2116,2121-2121,2160-216B,2170-2179,2190-2193,2196-2199,2208-2208,220F-220F,2211-2211,2215-2215,221A-221A,221D-2220,2223-2223,2225-2225,2227-222B,222E-222E,2234-2237,223D-223D,2248-2248,224C-224C,2252-2252,2260-2261,2264-2267,226E-226F,2295-2295,2299-2299,22A5-22A5,22BF-22BF,2312-2312,2460-2469,2474-249B,2500-254B,2550-2573,2581-258F,2593-2595,25A0-25A1,25B2-25B3,25BC-25BD,25C6-25C7,25CB-25CB,25CE-25CF,25E2-25E5,2605-2606,2609-2609,2640-2640,2642-2642,3000-3003,3005-3017,301D-301E,3021-3029,3041-3093,309B-309E,30A1-30F6,30FC-30FE,3105-3129,3220-3229,3231-3231,32A3-32A3,338E-338F,339C-339E,33A1-33A1,33C4-33C4,33CE-33CE,33D1-33D2,33D5-33D5,4E00-9FA5,F92C-F92C,F979-F979,F995-F995,F9E7-F9E7,F9F1-F9F1,FA0C-FA0F,FA11-FA11,FA13-FA14,FA18-FA18,FA1F-FA21,FA23-FA24,FA27-FA29,FE30-FE31,FE33-FE44,FE49-FE52,FE54-FE57,FE59-FE66,FE68-FE6B,FF01-FF5E,FFE0-FFE5';

interface GbkRange {
  readonly start: number;
  readonly end: number;
}

function parseRanges(compact: string): readonly GbkRange[] {
  return compact.split(',').map((part, index) => {
    const [startText = '', endText = ''] = part.split('-');
    const start = Number.parseInt(startText, 16);
    const end = Number.parseInt(endText, 16);
    // 表是生成物，格式错误只可能是手改坏了：直接抛，不要静默漏掉整段覆盖范围
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
      throw new Error(`GBK 覆盖表第 ${index + 1} 段损坏：${part}`);
    }
    return { start, end };
  });
}

/** 模块加载时解析一次；139 段线性扫也够快，二分只是顺手 */
const GBK_RANGES = parseRanges(GBK_COMPACT_RANGES);

/** 该 Unicode 码位能否用 GBK 编码（0x20..0xFFFF，已生成表） */
export function isGbkCodePoint(codePoint: number): boolean {
  if (!Number.isInteger(codePoint) || codePoint < 0x20 || codePoint > 0xffff) return false;
  let low = 0;
  let high = GBK_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = GBK_RANGES[middle]!;
    if (codePoint < range.start) {
      high = middle - 1;
    } else if (codePoint > range.end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * 控制字符（C0、DEL、C1）本身没有可见字形，但它们承担排版结构（换行、制表），
 * 由调用方按段落消费；这里原样保留，不替换成 '□'。
 */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * PDF 文本净化：码位不在 GBK 覆盖表内（含所有非 BMP：emoji、扩展 B 汉字等）时
 * 替换为 '□'（U+25A1，可被 GBK 覆盖）。控制字符（\n 除外）按原样留给上层处理，
 * 本函数不改空白/换行。
 */
export function sanitizeForPdf(text: string): string {
  let sanitized = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    sanitized += isControlCodePoint(codePoint) || isGbkCodePoint(codePoint) ? char : REPLACEMENT;
  }
  return sanitized;
}
