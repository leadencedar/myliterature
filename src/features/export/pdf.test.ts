import { describe, expect, it } from 'vitest';
import { renderChapterPdf } from './pdf';

/** 输出全是 ASCII，逐字节还原成字符串即可；测试不依赖 TextDecoder / 外部 PDF 库 */
function decodeAscii(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

interface XrefEntry {
  offset: number;
  kind: string;
}

interface ParsedPdf {
  text: string;
  entries: XrefEntry[];
}

/** 解析并顺带校验最外层的文件头/尾、ASCII 约束与 xref 表格式 */
function parsePdf(bytes: Uint8Array): ParsedPdf {
  expect([...bytes].every((byte) => byte < 0x80)).toBe(true);
  const text = decodeAscii(bytes);
  expect(text.startsWith('%PDF-')).toBe(true);
  expect(text.endsWith('%%EOF')).toBe(true);

  const startxref = /startxref\n(\d+)\n%%EOF$/u.exec(text);
  expect(startxref).not.toBeNull();
  const xrefOffset = Number(startxref![1]);
  expect(text.startsWith('xref', xrefOffset)).toBe(true);

  const header = /^xref\n0 (\d+)\n/u.exec(text.slice(xrefOffset));
  expect(header).not.toBeNull();
  const size = Number(header![1]);
  const entriesStart = xrefOffset + `xref\n0 ${size}\n`.length;
  const entries: XrefEntry[] = [];
  for (let index = 0; index < size; index += 1) {
    const line = text.slice(entriesStart + index * 20, entriesStart + (index + 1) * 20);
    expect(line).toHaveLength(20);
    entries.push({ offset: Number(line.slice(0, 10)), kind: line.charAt(17) });
  }
  return { text, entries };
}

function objectBody(text: string, objectId: number): string {
  const marker = `\n${objectId} 0 obj\n`;
  const start = text.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = text.indexOf('\nendobj\n', bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return text.slice(bodyStart, end);
}

/** 取流数据，同时验证 `/Length` 与实际流字节数一致 */
function streamData(text: string, objectId: number): string {
  const body = objectBody(text, objectId);
  const lengthMatch = /^<< \/Length (\d+) >>\nstream\n/u.exec(body);
  expect(lengthMatch).not.toBeNull();
  const declared = Number(lengthMatch![1]);
  const data = body.slice(lengthMatch![0].length);
  expect(data.endsWith('\nendstream')).toBe(true);
  const stream = data.slice(0, -'endstream'.length);
  expect(stream).toHaveLength(declared);
  return stream;
}

interface TextRun {
  size: number;
  x: number;
  y: number;
  text: string;
}

function decodeUtf16BeHex(hex: string): string {
  let text = '';
  for (let index = 0; index < hex.length; index += 4) {
    text += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return text;
}

/** 从内容流里把 `/F0 N Tf` + `Tm` + `<hex> Tj` 还原成文本片段 */
function textRuns(stream: string): TextRun[] {
  const runs: TextRun[] = [];
  let size = 0;
  let x = 0;
  let y = 0;
  for (const line of stream.split('\n')) {
    const font = /^\/F0 (\d+(?:\.\d+)?) Tf$/u.exec(line);
    if (font) {
      size = Number(font[1]);
      continue;
    }
    const matrix = /^1 0 0 1 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) Tm$/u.exec(line);
    if (matrix) {
      x = Number(matrix[1]);
      y = Number(matrix[2]);
      continue;
    }
    const show = /^<([0-9A-F]*)> Tj$/u.exec(line);
    if (show) runs.push({ size, x, y, text: decodeUtf16BeHex(show[1]!) });
  }
  return runs;
}

interface AnalyzedPdf {
  text: string;
  objectCount: number;
  pageBodies: string[];
  pageStreams: string[];
  pageRuns: TextRun[][];
}

function analyze(bytes: Uint8Array): AnalyzedPdf {
  const { text, entries } = parsePdf(bytes);
  const objectCount = entries.length - 1;
  const pageBodies: string[] = [];
  const pageStreams: string[] = [];
  for (let objectId = 1; objectId <= objectCount; objectId += 1) {
    const body = objectBody(text, objectId);
    // `/Type /Pages` 不会命中：这里要求 Page 后面就是空格
    if (!body.startsWith('<< /Type /Page ')) continue;
    const contents = /\/Contents (\d+) 0 R/u.exec(body);
    expect(contents).not.toBeNull();
    pageBodies.push(body);
    pageStreams.push(streamData(text, Number(contents![1])));
  }
  return {
    text,
    objectCount,
    pageBodies,
    pageStreams,
    pageRuns: pageStreams.map((stream) => textRuns(stream)),
  };
}

function sizeRuns(runs: readonly TextRun[], size: number): TextRun[] {
  return runs.filter((run) => run.size === size);
}

function footerTexts(analyzed: AnalyzedPdf): string[] {
  return analyzed.pageRuns.map((runs) => sizeRuns(runs, 9)[0]?.text ?? '');
}

/** 测试侧复刻的宽度估算：CJK / 全角 1 em，ASCII 0.65 em */
function widthEm(text: string): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    width += codePoint >= 0x20 && codePoint <= 0x7e ? 0.65 : 1;
  }
  return width;
}

const SAMPLE = {
  title: '第 3 章 灵潮',
  subtitle: '归墟纪',
  paragraphs: ['子夜，灵潮自海面翻涌而起。', '他握紧玉佩，听见潮声里有母亲的呼唤。'],
};

describe('PDF 文件结构', () => {
  it('是纯 ASCII 字节，以 %PDF- 开头、%%EOF 结尾', () => {
    const parsed = parsePdf(renderChapterPdf(SAMPLE));
    expect(parsed.text.length).toBeGreaterThan(0);
  });

  it('xref 的每个偏移都指向对应的 N 0 obj，startxref 可定位', () => {
    const { text, entries } = parsePdf(renderChapterPdf(SAMPLE));
    expect(entries[0]).toEqual({ offset: 0, kind: 'f' });
    entries.slice(1).forEach((entry, index) => {
      expect(entry.kind).toBe('n');
      expect(text.startsWith(`${index + 1} 0 obj`, entry.offset)).toBe(true);
    });
  });

  it('页面对象数量与 /Count 一致，每页都有 A4 MediaBox', () => {
    const analyzed = analyze(renderChapterPdf(SAMPLE));
    expect(analyzed.pageBodies.length).toBeGreaterThanOrEqual(1);
    expect(objectBody(analyzed.text, 2)).toContain(`/Count ${analyzed.pageBodies.length}`);
    for (const body of analyzed.pageBodies) {
      expect(body).toContain('/MediaBox [0 0 595.28 841.89]');
    }
  });

  it('每个内容流与 ToUnicode 流的实际长度都与 /Length 一致', () => {
    const analyzed = analyze(renderChapterPdf(SAMPLE));
    expect(analyzed.pageStreams).toHaveLength(analyzed.pageBodies.length);
    const toUnicode = /\/ToUnicode (\d+) 0 R/u.exec(analyzed.text);
    expect(toUnicode).not.toBeNull();
    expect(streamData(analyzed.text, Number(toUnicode![1]))).toContain('begincmap');
  });
});

describe('PDF 字体与文本层', () => {
  it('使用非嵌入 Type0 CID 字体：STSong-Light / UniGB-UTF16-H / Adobe-GB1 Supplement 4 / DW 1000', () => {
    const analyzed = analyze(renderChapterPdf(SAMPLE));
    expect(analyzed.text).toContain('/Subtype /Type0');
    expect(analyzed.text).toContain('/BaseFont /STSong-Light');
    expect(analyzed.text).toContain('/Encoding /UniGB-UTF16-H');
    expect(analyzed.text).toContain('/Subtype /CIDFontType0');
    expect(analyzed.text).toContain(
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >>',
    );
    expect(analyzed.text).toContain('/DW 1000');
  });

  it('文本层十六进制解码后包含标题、副标题与正文', () => {
    const analyzed = analyze(renderChapterPdf(SAMPLE));
    const decoded = analyzed.pageRuns
      .flat()
      .map((run) => run.text)
      .join('\n');
    expect(decoded).toContain('第 3 章 灵潮');
    expect(decoded).toContain('归墟纪');
    expect(decoded).toContain('子夜，灵潮自海面翻涌而起。');
    expect(decoded).toContain('他握紧玉佩，听见潮声里有母亲的呼唤。');
  });

  it('标题 20pt 伪粗体（2 Tr + 0.5 w 再 0 Tr 复位），副标题 10pt，正文 12pt', () => {
    const analyzed = analyze(renderChapterPdf(SAMPLE));
    const firstStream = analyzed.pageStreams[0]!;
    expect(firstStream).toContain('0.5 w');
    expect(firstStream).toContain('2 Tr');
    expect(firstStream).toContain('0 Tr');
    const firstPage = analyzed.pageRuns[0]!;
    expect(
      sizeRuns(firstPage, 20)
        .map((run) => run.text)
        .join(''),
    ).toBe('第 3 章 灵潮');
    expect(
      sizeRuns(firstPage, 10)
        .map((run) => run.text)
        .join(''),
    ).toBe('归墟纪');
    expect(sizeRuns(firstPage, 12)).toHaveLength(2);
  });

  it('/ToUnicode 对用到的字符做恒等映射，连续码位压成 bfrange', () => {
    const analyzed = analyze(renderChapterPdf({ title: '编号 123 章', paragraphs: ['ABC 789。'] }));
    const ref = /\/ToUnicode (\d+) 0 R/u.exec(analyzed.text);
    expect(ref).not.toBeNull();
    const cmap = streamData(analyzed.text, Number(ref![1]));
    expect(cmap).toContain('begincodespacerange');
    // 标题里的 1、2、3 与正文里的 7、8、9 都连续，应各压成一个恒等 bfrange
    expect(cmap).toMatch(/<0031> <0033> <0031>/u);
    expect(cmap).toMatch(/<0037> <0039> <0037>/u);
    // 孤立的汉字用 bfchar
    expect(cmap).toMatch(/<7F16> <7F16>/u);
  });

  it('GBK 覆盖外的生僻字与 emoji 在文本层变成 □，不出现代理码元', () => {
    const analyzed = analyze(
      renderChapterPdf({ title: '第 㵘 章', paragraphs: ['✔ 与 😀 与 𠮷。'] }),
    );
    const decodedRuns = analyzed.pageRuns.flat();
    const decoded = decodedRuns.map((run) => run.text).join('\n');
    expect((decoded.match(/□/gu) ?? []).length).toBe(4);
    for (const char of ['㵘', '✔', '😀', '𠮷']) {
      expect(decoded).not.toContain(char);
    }
    for (const run of decodedRuns) {
      expect(/[\uD800-\uDFFF]/u.test(run.text)).toBe(false);
    }
  });

  it('/Info 的 /Title 用 UTF-16BE+BOM 保留原始标题，/Producer 是 WenMo', () => {
    const analyzed = analyze(renderChapterPdf({ title: '第 1 章 㵘', paragraphs: [] }));
    const trailer = /\/Info (\d+) 0 R/u.exec(analyzed.text);
    expect(trailer).not.toBeNull();
    const info = objectBody(analyzed.text, Number(trailer![1]));
    const titleMatch = /\/Title <([0-9A-F]+)>/u.exec(info);
    expect(titleMatch).not.toBeNull();
    const hex = titleMatch![1]!;
    // 元信息不经过字体，超出 GBK 的标题也要原样保留
    expect(hex.startsWith('FEFF')).toBe(true);
    expect(decodeUtf16BeHex(hex.slice(4))).toBe('第 1 章 㵘');
    expect(info).toContain('/Producer (WenMo)');
  });
});

describe('PDF 分页与页码', () => {
  it('每页都有 9pt 页码「第 N 页 / 共 M 页」', () => {
    const analyzed = analyze(renderChapterPdf({ title: '长章', paragraphs: ['灵'.repeat(3000)] }));
    const total = analyzed.pageRuns.length;
    expect(total).toBeGreaterThanOrEqual(3);
    analyzed.pageRuns.forEach((runs, index) => {
      expect(sizeRuns(runs, 9)).toHaveLength(1);
      expect(footerTexts(analyzed)[index]).toBe(`第 ${index + 1} 页 / 共 ${total} 页`);
    });
  });

  it('空正文只有一页标题页，页码是「第 1 页 / 共 1 页」', () => {
    const analyzed = analyze(renderChapterPdf({ title: '独章', paragraphs: [] }));
    expect(analyzed.pageRuns).toHaveLength(1);
    expect(analyzed.pageRuns[0]!.map((run) => run.text)).toContain('独章');
    expect(footerTexts(analyzed)[0]).toBe('第 1 页 / 共 1 页');
  });

  it('3000 字长章自动分页，正文一个不丢', () => {
    const content = '灵'.repeat(3000);
    const analyzed = analyze(renderChapterPdf({ title: '第 12 章 灵潮', paragraphs: [content] }));
    // 37 字/行 × 82 行正文：首页 31 行、次页 34 行、末页 17 行，固定排版下正好 3 页
    expect(analyzed.pageRuns.length).toBe(3);
    const body = analyzed.pageRuns
      .map((runs) => sizeRuns(runs, 12))
      .flat()
      .map((run) => run.text)
      .join('');
    expect(body).toBe(content);
  });

  it('所有正文行都落在内容区内，页码在页脚区', () => {
    const analyzed = analyze(renderChapterPdf({ title: '长章', paragraphs: ['灵'.repeat(3000)] }));
    for (const runs of analyzed.pageRuns) {
      for (const run of runs) {
        if (run.size === 9) {
          expect(run.y).toBe(36);
        } else {
          expect(run.y).toBeGreaterThan(72);
          expect(run.y).toBeLessThanOrEqual(763.89);
        }
      }
    }
  });
});

describe('PDF 折行', () => {
  it('标题超宽自动折行，每行都居中', () => {
    const title = '潮'.repeat(50);
    const analyzed = analyze(renderChapterPdf({ title, paragraphs: [] }));
    const titleRuns = analyzed.pageRuns.flat().filter((run) => run.size === 20);
    expect(titleRuns.length).toBeGreaterThanOrEqual(2);
    expect(titleRuns.map((run) => run.text).join('')).toBe(title);
    for (const run of titleRuns) {
      const centeredX = (595.28 - widthEm(run.text) * 20) / 2;
      expect(Math.abs(run.x - centeredX)).toBeLessThan(0.02);
    }
  });

  it('空段落照常占一行高度，不产生文字', () => {
    const analyzed = analyze(
      renderChapterPdf({ title: '标题', paragraphs: ['第一段。', '', '第二段。'] }),
    );
    const paragraphs = sizeRuns(analyzed.pageRuns[0]!, 12);
    expect(paragraphs).toHaveLength(2);
    // 中间的空行占 20pt，所以两段基线相差 40pt
    expect(paragraphs[0]!.y - paragraphs[1]!.y).toBeCloseTo(40, 6);
  });

  it('拉丁词整体换行，超长拉丁串按字符硬断且不越界', () => {
    const word = 'abcdefghij'.repeat(5);
    const long = 'x'.repeat(100);
    const analyzed = analyze(renderChapterPdf({ title: '标题', paragraphs: [word, long] }));
    const runs = analyzed.pageRuns.flat().filter((run) => run.size === 12);
    expect(runs[0]!.text).toBe(word);
    expect(runs.map((run) => run.text).join('')).toBe(word + long);
    const maxEm = 455.28 / 12;
    for (const run of runs) expect(widthEm(run.text)).toBeLessThanOrEqual(maxEm + 1e-9);
  });

  it('空副标题当作没有：不产生 10pt 文本', () => {
    const analyzed = analyze(
      renderChapterPdf({ title: '标题', subtitle: '   ', paragraphs: ['正文'] }),
    );
    expect(analyzed.pageRuns.flat().filter((run) => run.size === 10)).toHaveLength(0);
  });

  it('同一份文档两次渲染字节完全一致（无时间、无随机）', () => {
    const doc = { title: '第 1 章 离乡', subtitle: '归墟纪', paragraphs: ['天还没亮。'] };
    expect(renderChapterPdf(doc)).toEqual(renderChapterPdf(doc));
  });
});

describe('PDF 避头尾（kinsoku）', () => {
  const MAX_EM = 455.28 / 12;

  /** 测试侧复刻的行首/行尾禁则表，与 pdf.ts 的实现独立核对 */
  const NO_LINE_START = new Set('。，、；：？！）〕〉》」』】…—～·”’＂＇｝］〗〙〛');
  const NO_LINE_END = new Set('（〔〈《「『【｛［〖〘〝“‘');

  function bodyTexts(analyzed: AnalyzedPdf): string[] {
    return analyzed.pageRuns
      .flat()
      .filter((run) => run.size === 12)
      .map((run) => run.text);
  }

  it('行首禁则：闭合标点悬挂在上一行行尾，不落到下一行开头', () => {
    const analyzed = analyze(
      renderChapterPdf({ title: '标题', paragraphs: ['一'.repeat(37) + '。' + '二'.repeat(10)] }),
    );
    const lines = bodyTexts(analyzed);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('一'.repeat(37) + '。');
    expect(lines[1]).toBe('二'.repeat(10));
    for (const text of lines) expect(NO_LINE_START.has(text.charAt(0))).toBe(false);
    // 悬挂行确实超出了列宽，但不超过 2 个全角字符
    expect(widthEm(lines[0]!)).toBeGreaterThan(MAX_EM);
    expect(widthEm(lines[0]!)).toBeLessThanOrEqual(MAX_EM + 2 + 1e-9);
  });

  it('行尾禁则：开引号/开括号被带到下一行行首', () => {
    const analyzed = analyze(
      renderChapterPdf({ title: '标题', paragraphs: ['甲'.repeat(36) + '（' + '乙'.repeat(20)] }),
    );
    const lines = bodyTexts(analyzed);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('甲'.repeat(36));
    expect(lines[1]).toBe('（' + '乙'.repeat(20));
    for (const text of lines) expect(NO_LINE_END.has(text.slice(-1))).toBe(false);
  });

  it('多段混排：所有行都满足行首/行尾禁则，且不越过页面右边缘', () => {
    const analyzed = analyze(
      renderChapterPdf({
        title: '标题',
        paragraphs: [
          '一'.repeat(37) + '。' + '二'.repeat(10),
          '甲'.repeat(36) + '（' + '乙'.repeat(20),
          '丙'.repeat(35) + '「' + '丁'.repeat(10) + '」' + '戊'.repeat(30),
        ],
      }),
    );
    const lines = bodyTexts(analyzed);
    expect(lines.length).toBeGreaterThan(3);
    for (const text of lines) {
      expect(NO_LINE_START.has(text.charAt(0))).toBe(false);
      expect(NO_LINE_END.has(text.slice(-1))).toBe(false);
      const width = widthEm(text) * 12;
      expect(width).toBeLessThanOrEqual(455.28 + 2 * 12 + 1e-9);
      expect(70 + width).toBeLessThanOrEqual(595.28);
    }
  });

  it('连续闭合标点悬挂最多超出 2 个全角字符，不会把行推到页面外', () => {
    const analyzed = analyze(
      renderChapterPdf({
        title: '标题',
        paragraphs: ['一'.repeat(37) + '，。、；' + '二'.repeat(5)],
      }),
    );
    const lines = bodyTexts(analyzed);
    for (const text of lines) {
      const width = widthEm(text) * 12;
      expect(width).toBeLessThanOrEqual(455.28 + 2 * 12 + 1e-9);
      expect(70 + width).toBeLessThanOrEqual(595.28);
    }
    // 至少有一行确实发生了悬挂，确保这条路径被覆盖
    expect(lines.some((text) => widthEm(text) > MAX_EM)).toBe(true);
  });
});
