/**
 * RTF（富文本格式）导出。
 *
 * 为什么自己写而不是引库：RTF 在这里只需要「带一点格式的正文」—— 标题有字号、
 * 加粗、居中，正文能分段、两端对齐、1.5 倍行距。引库会拖进几百 KB 依赖，而这种
 * 逐字节导出的东西恰恰最需要自己盯着；两三百行纯函数就够。
 *
 * 输出刻意收敛成纯 ASCII：所有非 ASCII 都写成 `\uN?`。中文 Windows 的 Word/WPS
 * 对 UTF-8 无 BOM 的 RTF 支持并不可靠，而 `\uN?` 是 RTF 规范里最稳的写法 ——
 * 编码问题（UTF-8 / GBK 混写、乱码、BOM）因此彻底消失。
 *
 * 必须与 `src/features/import/rtf.ts` 的提取器往返一致：导出的章节要能被本产品
 * 重新导入。提取器认 `\uN` 和 `\par`，所以这里只产出这两种结构 —— 不写裸 CR/LF
 * 正文，也不写 `\'hh` 字节。
 */

export interface RtfDocument {
  /** 章节标题，如「第 3 章 灵潮」，必填 */
  title: string;
  /** 书名之类的副标题，可选；空串当作没有 */
  subtitle?: string;
  /** 正文段落；空行用空字符串表示。渲染时逐段输出，不做额外折行 */
  paragraphs: string[];
}

/**
 * 单个 UTF-16 码元 → RTF `\uN?`。
 *
 * N 必须是**有符号 16 位十进制**：RTF 阅读器按 16 位有符号数解读，>32767 时要减
 * 65536，否则 U+FFFD 这类码位会被读成非法的 65533。
 * 后跟的 `?` 是给不认 `\u` 的老阅读器的 fallback，`\uc1` 声明它占一个字符位。
 */
function escapeCodeUnit(codeUnit: number): string {
  const signed = codeUnit > 0x7fff ? codeUnit - 0x10000 : codeUnit;
  return `\\u${signed}?`;
}

/** 文本 → RTF 转义（导出的纯函数，供测试与 renderRtfDocument 使用） */
export function escapeRtf(text: string): string {
  let escaped = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (char === '\\') {
      escaped += '\\\\';
    } else if (char === '{') {
      escaped += '\\{';
    } else if (char === '}') {
      escaped += '\\}';
    } else if (char === '\t') {
      // 控制词后面补一个空格作分隔符；提取器会把这个分隔符当语法吃掉，不会多出空格
      escaped += '\\tab ';
    } else if (codePoint < 0x20 || codePoint === 0x7f) {
      // 换行由段落结构表达；其余控制字符在 RTF 正文里没有可见意义，直接丢弃
      continue;
    } else if (codePoint < 0x80) {
      escaped += char;
    } else {
      // 非 BMP 字符在字符串里是两个 UTF-16 码元，逐个输出两个相邻的 \uN?，
      // 提取器会把高/低代理拼回一个码位
      for (let index = 0; index < char.length; index += 1) {
        escaped += escapeCodeUnit(char.charCodeAt(index));
      }
    }
  }
  return escaped;
}

/** RTF 头：代码页 936（GBK）、默认字体宋体、语言 2052（简体中文）、`\uc1` 一个 fallback 字符 */
const RTF_HEADER =
  '{\\rtf1\\ansi\\ansicpg936\\deff0\\deflang2052\\uc1\n' +
  '{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}}\n';

/**
 * 每段前都用 `\pard` 重置段落属性：RTF 的段落/字符格式会沿着文档流继承，
 * 不重置的话标题的居中与加粗会漏到副标题和正文里。
 */
const TITLE_PARAGRAPH = '\\pard\\qc\\b\\fs36\\sa240 ';
const SUBTITLE_PARAGRAPH = '\\pard\\qc\\b0\\fs20\\sa240 ';
const BODY_PARAGRAPH = '\\pard\\qj\\b0\\fs24\\sl360\\slmult1 ';

function paragraph(format: string, text: string): string {
  return `{${format}${escapeRtf(text)}\\par}`;
}

/** 生成一份可直接给 Word / WPS / RTF 阅读器打开的 RTF 文本（纯 ASCII） */
export function renderRtfDocument(doc: RtfDocument): string {
  const parts: string[] = [RTF_HEADER, paragraph(TITLE_PARAGRAPH, doc.title)];
  const subtitle = doc.subtitle?.trim() ?? '';
  // 只有空白也算没有：一个 10pt 的空段落既没有排版意义，也会让提取出的文本多一行
  if (subtitle) parts.push(paragraph(SUBTITLE_PARAGRAPH, subtitle));
  for (const body of doc.paragraphs) parts.push(paragraph(BODY_PARAGRAPH, body));
  // 结尾的 } 与开头的 {\rtf1 配对；提取器靠花括号配对判断文档结束
  return `${parts.join('\n')}\n}`;
}
