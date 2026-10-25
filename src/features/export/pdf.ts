import { sanitizeForPdf } from './gbkCoverage';

/**
 * 单章 PDF 导出。
 *
 * 为什么自己写 PDF 而不是引库：本产品零运行时依赖，而「导出能打印、能复制文字的
 * 一章节」只用到 PDF 很小的一个子集 —— 一个 Type0 中文字体、每页一段文本流、
 * 一张 xref 表。引 pdf-lib 之类会凭空多几百 KB，还意味着导出结果要交给无法审查的
 * 第三方代码。这里输出的整个 PDF 都是 ASCII 字符串（文本走 UTF-16BE 十六进制），
 * 对象编号与字节偏移肉眼可查。
 *
 * 为什么用**非嵌入**的 STSong-Light CID 字体：嵌中文字体要给仓库加数 MB 字体文件
 * 并自己实现 TTF/CFF 子集化，而阅读器普遍自带 Adobe-GB1 的宋体替代字体。代价是
 * 只有 GBK 覆盖范围内的字有正确字形 —— 范围外的生僻字与 emoji 会被画成别的字或空白，
 * 所以文本进 PDF 之前先过 sanitizeForPdf 换成 '□'（见 ./gbkCoverage.ts）。
 * 要原样保留这些字，用户应导出 TXT / MD / RTF，这是产品文档里写明的取舍。
 *
 * 为什么同步、不压缩：单章约 5–15 KB，PDF 内部只做文本，不引 CompressionStream ——
 * 少一个异步边界，打包层拿到的永远是确定性的 Uint8Array，而整包会由 zip 层统一 deflate。
 */

export interface PdfDocument {
  /** 章节标题，必填 */
  title: string;
  /** 副标题（书名），可选；空串当作没有 */
  subtitle?: string;
  /** 正文段落；空字符串表示一个空行 */
  paragraphs: string[];
}

/** A4 尺寸（pt）。595.28 × 841.89 是 210mm × 297mm 换算后的常用值 */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

/** 页边距：左右 70、上 78、下 72，都是印刷/阅读都舒服的取值 */
const MARGIN_LEFT = 70;
const MARGIN_RIGHT = 70;
const MARGIN_TOP = 78;
const MARGIN_BOTTOM = 72;

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
/** 内容区顶部（页面坐标从下往上数） */
const CONTENT_TOP = PAGE_HEIGHT - MARGIN_TOP;
/** 内容区底部；页码画在这条线下面 */
const CONTENT_BOTTOM = MARGIN_BOTTOM;

const TITLE_SIZE = 20;
const TITLE_LEADING = 28;
const SUBTITLE_SIZE = 10;
const SUBTITLE_LEADING = 16;
const BODY_SIZE = 12;
const BODY_LEADING = 20;
const FOOTER_SIZE = 9;
/** 页码基线：离页面底边 36pt，落在下边距的留白里 */
const FOOTER_BASELINE = 36;

/** 伪粗体描边宽度（pt）：非嵌入字体没有真粗体，用 2 Tr 描边再 0 Tr 复位 */
const BOLD_STROKE_WIDTH = 0.5;

/**
 * ASCII 按 0.65 em 估算宽度。实际多数拉丁字母约 0.5 em，这里**刻意取宽**：
 * 宁可提前换行，也不要让一行在阅读器里顶出右边距。
 */
const ASCII_WIDTH_EM = 0.65;

/** em 累加是浮点运算，容差避免「刚好填满」的一行被舍入挤下去 */
const EPSILON = 1e-9;

type PdfAlign = 'center' | 'left';

/** 排版阶段的一行：还没决定页码与基线，只描述内容与行距 */
interface FlowLine {
  text: string;
  size: number;
  leading: number;
  align: PdfAlign;
  bold: boolean;
  /** 这一行之后额外的垂直留白（标题与正文之间用） */
  gapAfter: number;
}

/** 落到具体某页坐标上的一段文字 */
interface PdfTextRun {
  text: string;
  size: number;
  x: number;
  y: number;
  bold: boolean;
}

/** 估算单个字符宽度（em）：CJK / 全角 / 净化后的 '□' 按 1 em，ASCII 按 0.65 em */
function charWidthEm(codePoint: number): number {
  return codePoint >= 0x20 && codePoint <= 0x7e ? ASCII_WIDTH_EM : 1;
}

function textWidthEm(text: string): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined) width += charWidthEm(codePoint);
  }
  return width;
}

function estimateWidth(text: string, size: number): number {
  return textWidthEm(text) * size;
}

/**
 * 行内最小断行单位：连续 ASCII（字母数字与常见半角符号）视为一个拉丁词整体，
 * 其余字符（CJK、全角标点、□）各自成一个单位，可以任意断行。
 * 空格单独成词，让折行时知道可以在哪里吞掉它。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (char === ' ') {
      if (word) {
        tokens.push(word);
        word = '';
      }
      tokens.push(' ');
    } else if (codePoint >= 0x20 && codePoint <= 0x7e) {
      word += char;
    } else {
      if (word) {
        tokens.push(word);
        word = '';
      }
      tokens.push(char);
    }
  }
  if (word) tokens.push(word);
  return tokens;
}

/**
 * 避头尾（kinsoku）：中文排版的行首/行尾禁则。
 *
 * 行首禁则（NO_LINE_START）：闭合标点不能出现在行首 —— 中文里「，」「。」掉到
 * 下一行开头是明显的排版错误。放不下时让标点**悬挂**在上一行行尾：允许该行超出
 * 列宽，但最多 2 个全角字符，且加完仍在页面右边缘之内。
 * 行尾禁则（NO_LINE_END）：开引号/开括号不能留在行尾 —— 折行时把它带到下一行行首，
 * 否则下一行开头会是一个孤零零的「（」。
 *
 * 只收全角/CJK 标点：ASCII 标点已经跟着拉丁词 token 走，拆出来会把英文单词后面的
 * 句号/逗号甩到别的行，破坏「拉丁词不拆」的约定。
 */
const NO_LINE_START = new Set('。，、；：？！）〕〉》」』】…—～·”’＂＇｝］〗〙〛');
const NO_LINE_END = new Set('（〔〈《「『【｛［〖〘〝“‘');

/** 悬挂允许超出的上限：2 个全角字符（含悬挂的标点自身） */
const HANGING_LIMIT_EM = 2;

/** 单个字符的 em 宽度；codePoint 取不到时按全角兜底 */
function charWidthEmOf(char: string): number {
  const codePoint = char.codePointAt(0);
  return codePoint === undefined ? 1 : charWidthEm(codePoint);
}

/**
 * 能否把闭合标点悬挂在本行行尾：
 * 1) 超出列宽不超过 2 个全角字符；
 * 2) 从左边距起算的右端不能越过页面右边缘（左右各有 70pt 边距，2 em 有富余）。
 * 居中标题的 x 会向左收，同样不会越界。
 */
function canHangOnLine(lineEm: number, tokenEm: number, size: number, maxEm: number): boolean {
  const hangingEm = lineEm + tokenEm;
  return (
    hangingEm <= maxEm + HANGING_LIMIT_EM + EPSILON && MARGIN_LEFT + hangingEm * size <= PAGE_WIDTH
  );
}

/**
 * 折行。空串返回 `['']`，让「空行」在排版里照常占一行高度。
 * 拉丁词整体换行；CJK 任意断行；超长拉丁串按剩余宽度硬断；折行时应用避头尾。
 */
function wrapText(text: string, size: number, maxWidth: number): string[] {
  if (text === '') return [''];
  const maxEm = maxWidth / size;
  const lines: string[] = [];
  let line = '';
  let lineEm = 0;

  /** 把当前行收进结果；行尾的开引号/开括号被弹出并返回，交给下一行行首 */
  const flushLine = (): string => {
    let carry = '';
    while (line !== '' && NO_LINE_END.has(line.slice(-1))) {
      const char = line.slice(-1);
      carry = char + carry;
      line = line.slice(0, -1);
      lineEm -= charWidthEmOf(char);
    }
    if (line !== '') lines.push(line);
    line = '';
    lineEm = 0;
    return carry;
  };

  for (const token of tokenize(text)) {
    const tokenEm = textWidthEm(token);

    if (token === ' ') {
      // 行首空格没有意义；行尾放不下时换行把它吃掉，和常见的软换行行为一致
      if (line === '') continue;
      if (lineEm + tokenEm <= maxEm + EPSILON) {
        line += token;
        lineEm += tokenEm;
        continue;
      }
      line = flushLine();
      lineEm = textWidthEm(line);
      continue;
    }

    if (lineEm + tokenEm <= maxEm + EPSILON) {
      line += token;
      lineEm += tokenEm;
      continue;
    }

    // 行首禁则：闭合标点放不下时悬挂在本行行尾，不把它挤到下一行开头
    if (line !== '' && NO_LINE_START.has(token) && canHangOnLine(lineEm, tokenEm, size, maxEm)) {
      line += token;
      lineEm += tokenEm;
      continue;
    }

    // 正常折行：先把行尾禁则处理掉（开引号随下一行一起走）
    line = flushLine();
    lineEm = textWidthEm(line);
    if (lineEm + tokenEm <= maxEm + EPSILON) {
      line += token;
      lineEm += tokenEm;
      continue;
    }

    // 超长拉丁串：按当前行剩余宽度硬断（行首可能带着开引号）
    let remaining = token;
    while (remaining !== '') {
      const availableEm = maxEm - lineEm;
      let take = '';
      let takeEm = 0;
      for (const char of remaining) {
        const em = charWidthEmOf(char);
        if (takeEm + em > availableEm + EPSILON) break;
        take += char;
        takeEm += em;
      }
      // 理论上到不了：行首最多 2 个开引号，剩余宽度总放得下一个字符；
      // 真放不下就单独放一个字符，保证不吞字、不死循环
      if (take === '') {
        take = remaining.slice(0, 1);
        takeEm = charWidthEmOf(take);
      }
      line += take;
      lineEm += takeEm;
      remaining = remaining.slice(take.length);
      if (remaining !== '') {
        lines.push(line);
        line = '';
        lineEm = 0;
      }
    }
  }

  // 最后一行不再处理行尾禁则：后面没有行可带，弹出去只会丢字符
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
}

interface BlockStyle {
  size: number;
  leading: number;
  align: PdfAlign;
  bold: boolean;
  /** 这一段最后一个折行之后的额外留白 */
  gapAfter: number;
}

/** 把一段文本（可含裸换行）按样式折成排版行，追加到 target */
function appendBlock(target: FlowLine[], text: string, style: BlockStyle): void {
  // 正常输入已经一段一个字符串；裸换行来自导入的正文，按硬换行处理
  const segments = text.split(/\r\n|\r|\n/u);
  segments.forEach((segment, segmentIndex) => {
    const wrapped = wrapText(segment, style.size, CONTENT_WIDTH);
    wrapped.forEach((line, lineIndex) => {
      const isLast = segmentIndex === segments.length - 1 && lineIndex === wrapped.length - 1;
      target.push({
        text: line,
        size: style.size,
        leading: style.leading,
        align: style.align,
        bold: style.bold,
        gapAfter: isLast ? style.gapAfter : 0,
      });
    });
  });
}

/** 标题 20pt 居中伪粗体、副标题 10pt 居中、正文 12pt 左对齐 20pt 行高 */
function buildFlow(doc: PdfDocument): FlowLine[] {
  const title = sanitizeForPdf(doc.title);
  const subtitle = sanitizeForPdf(doc.subtitle ?? '');
  // 只有空白也算没有：空副标题不该在 PDF 里占一行
  const hasSubtitle = subtitle.trim() !== '';

  const lines: FlowLine[] = [];
  appendBlock(lines, title, {
    size: TITLE_SIZE,
    leading: TITLE_LEADING,
    align: 'center',
    bold: true,
    gapAfter: hasSubtitle ? 8 : 24,
  });
  if (hasSubtitle) {
    appendBlock(lines, subtitle, {
      size: SUBTITLE_SIZE,
      leading: SUBTITLE_LEADING,
      align: 'center',
      bold: false,
      gapAfter: 20,
    });
  }
  for (const paragraph of doc.paragraphs) {
    appendBlock(lines, sanitizeForPdf(paragraph), {
      size: BODY_SIZE,
      leading: BODY_LEADING,
      align: 'left',
      bold: false,
      gapAfter: 0,
    });
  }
  return lines;
}

/** 按行距把排版行分到各页，并算出每行的基线坐标 */
function layoutPages(lines: readonly FlowLine[]): PdfTextRun[][] {
  const pages: PdfTextRun[][] = [];
  let runs: PdfTextRun[] = [];
  let cursor = CONTENT_TOP;

  for (const line of lines) {
    // 先判断再落行：内容区底部就是下边距，别让最后一行压到页码上
    if (runs.length > 0 && cursor - line.leading < CONTENT_BOTTOM) {
      pages.push(runs);
      runs = [];
      cursor = CONTENT_TOP;
    }
    if (line.text !== '') {
      const x =
        line.align === 'center'
          ? Math.max(MARGIN_LEFT, (PAGE_WIDTH - estimateWidth(line.text, line.size)) / 2)
          : MARGIN_LEFT;
      // 基线放在行框顶部往下 0.8 倍字号：近似宋体 ascent，首行不会贴上边距
      runs.push({
        text: line.text,
        size: line.size,
        x,
        y: cursor - line.size * 0.8,
        bold: line.bold,
      });
    }
    cursor -= line.leading + line.gapAfter;
  }

  // 即使标题是空串也要有一页：没有页面对象的 PDF 是坏文件
  if (runs.length > 0 || pages.length === 0) pages.push(runs);
  return pages;
}

/** 保留两位小数并去掉无意义的尾零，避免坐标输出成一串浮点噪声 */
function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 文本 → UTF-16BE 十六进制串（PDF 里 `<...> Tj` 的 4 位一组的码元） */
function toUtf16BeHex(text: string): string {
  let hex = '';
  for (let index = 0; index < text.length; index += 1) {
    hex += text.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0');
  }
  return hex;
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * 生成 /ToUnicode CMap：把内容流里的码位（UTF-16BE 码元）恒等映射到 Unicode。
 *
 * 非嵌入字体必须自带这张表，否则阅读器只能靠字体猜字，复制出来是乱码。
 * 连续码位合并成一个 bfrange（`<lo> <hi> <lo>` 表示目标码位从 lo 起递增），
 * 孤立的字用 bfchar；每个 section 最多 100 条，这是规范的硬限制。
 */
function buildToUnicodeCmap(codeUnits: readonly number[]): string {
  const singles: number[] = [];
  const ranges: { start: number; end: number }[] = [];
  for (const codeUnit of codeUnits) {
    const last = ranges[ranges.length - 1];
    if (last && codeUnit === last.end + 1) last.end = codeUnit;
    else ranges.push({ start: codeUnit, end: codeUnit });
  }
  for (const range of ranges) {
    if (range.start === range.end) singles.push(range.start);
  }
  const multi = ranges.filter((range) => range.end > range.start);

  const lines: string[] = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  for (const group of chunk(singles, 100)) {
    lines.push(`${group.length} beginbfchar`);
    for (const codeUnit of group) lines.push(`<${hex4(codeUnit)}> <${hex4(codeUnit)}>`);
    lines.push('endbfchar');
  }
  for (const group of chunk(multi, 100)) {
    lines.push(`${group.length} beginbfrange`);
    for (const range of group) {
      lines.push(`<${hex4(range.start)}> <${hex4(range.end)}> <${hex4(range.start)}>`);
    }
    lines.push('endbfrange');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return `${lines.join('\n')}\n`;
}

/** 收集所有会进入文本层的 UTF-16 码元（正文 + 页码），供 ToUnicode 用 */
function collectCodeUnits(pages: readonly PdfTextRun[][], footers: readonly string[]): number[] {
  const used = new Set<number>();
  const addText = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) used.add(text.charCodeAt(index));
  };
  for (const runs of pages) {
    for (const run of runs) addText(run.text);
  }
  for (const footer of footers) addText(footer);
  return [...used].sort((left, right) => left - right);
}

/** 单页内容流：一段 BT/ET 里逐段设字体、定位、写十六进制文本 */
function renderContentStream(runs: readonly PdfTextRun[], footer: string): string {
  const operators: string[] = [
    'q',
    '0 0 0 rg',
    '0 0 0 RG',
    `${formatNumber(BOLD_STROKE_WIDTH)} w`,
    'BT',
  ];
  for (const run of runs) {
    operators.push(`/F0 ${formatNumber(run.size)} Tf`);
    operators.push(run.bold ? '2 Tr' : '0 Tr');
    operators.push(`1 0 0 1 ${formatNumber(run.x)} ${formatNumber(run.y)} Tm`);
    operators.push(`<${toUtf16BeHex(run.text)}> Tj`);
  }
  const footerWidth = estimateWidth(footer, FOOTER_SIZE);
  const footerX = Math.max(MARGIN_LEFT, (PAGE_WIDTH - footerWidth) / 2);
  operators.push(`/F0 ${formatNumber(FOOTER_SIZE)} Tf`);
  operators.push('0 Tr');
  operators.push(`1 0 0 1 ${formatNumber(footerX)} ${formatNumber(FOOTER_BASELINE)} Tm`);
  operators.push(`<${toUtf16BeHex(footer)}> Tj`);
  operators.push('ET', 'Q');
  return `${operators.join('\n')}\n`;
}

/** 把页面布局拼成完整的 PDF 文件（ASCII 字符串 → 字节） */
function buildPdf(pages: readonly PdfTextRun[][], title: string): Uint8Array {
  const pageCount = pages.length;
  // 对象编号：1 Catalog、2 Pages，之后每页一对（Page / Contents），最后是字体与 Info
  const pageObjectId = (index: number): number => 3 + index * 2;
  const contentObjectId = (index: number): number => 4 + index * 2;
  const type0FontId = 3 + pageCount * 2;
  const cidFontId = type0FontId + 1;
  const fontDescriptorId = type0FontId + 2;
  const toUnicodeId = type0FontId + 3;
  const infoId = type0FontId + 4;
  const objectCount = infoId;

  const footers = pages.map((_, index) => `第 ${index + 1} 页 / 共 ${pageCount} 页`);
  const cmap = buildToUnicodeCmap(collectCodeUnits(pages, footers));

  const objects: string[] = new Array<string>(objectCount);
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, index) => `${pageObjectId(index)} 0 R`).join(' ');
  objects[1] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;

  pages.forEach((runs, index) => {
    const stream = renderContentStream(runs, footers[index]!);
    objects[pageObjectId(index) - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F0 ${type0FontId} 0 R >> /ProcSet [/PDF /Text] >> ` +
      `/Contents ${contentObjectId(index)} 0 R >>`;
    objects[contentObjectId(index) - 1] =
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
  });

  // 非嵌入 CID 字体：只声明字体名与字符集，字形由阅读器自带的 Adobe-GB1 替代字体提供
  objects[type0FontId - 1] =
    `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UTF16-H ` +
    `/DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`;
  objects[cidFontId - 1] =
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light ` +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> ' +
    `/FontDescriptor ${fontDescriptorId} 0 R /DW 1000 >>`;
  objects[fontDescriptorId - 1] =
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 ' +
    '/FontBBox [-141 -263 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 ' +
    '/CapHeight 880 /StemV 80 >>';
  objects[toUnicodeId - 1] = `<< /Length ${cmap.length} >>\nstream\n${cmap}endstream`;
  // 标题按 UTF-16BE + BOM 存：文档属性里的元信息不必随字体降级成 □
  objects[infoId - 1] = `<< /Title <FEFF${toUtf16BeHex(title)}> /Producer (WenMo) >>`;

  // 按对象顺序累加字节偏移；所有动态内容都是 ASCII，字符数就是字节数
  const chunks: string[] = [];
  let byteOffset = 0;
  const write = (text: string): void => {
    chunks.push(text);
    byteOffset += text.length;
  };
  write('%PDF-1.4\n');
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(byteOffset);
    write(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefOffset = byteOffset;
  write(`xref\n0 ${objectCount + 1}\n`);
  // 对象 0 是规定好的空闲项：10 位偏移 + 5 位代 + f + 两个字符的行尾，整行 20 字节
  write('0000000000 65535 f \n');
  for (const offset of offsets) {
    write(`${offset.toString().padStart(10, '0')} 00000 n \n`);
  }
  write(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info ${infoId} 0 R >>\n`);
  write(`startxref\n${xrefOffset}\n%%EOF`);

  return new TextEncoder().encode(chunks.join(''));
}

/** 生成一份单章 PDF 的字节。纯同步、无 DOM、无网络 */
export function renderChapterPdf(doc: PdfDocument): Uint8Array {
  const pages = layoutPages(buildFlow(doc));
  return buildPdf(pages, doc.title);
}
