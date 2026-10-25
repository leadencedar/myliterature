/**
 * RTF（富文本格式）→ 纯文本提取。
 *
 * 为什么自己写而不是引库：RTF 对这个产品的用途只有一个 —— 把 Word 保存的
 * `.rtf` 稿件变成纯文本，之后的分章、字数统计、翻译、提取全都只认纯文本。
 * 需要的只是一个确定性的提取器：控制词、`\uN` 与 `\'hh` 两种中文转义、
 * 整组跳过的目的地（fonttbl / colortbl / pict 等），两三百行纯函数就能覆盖
 * 中文作者实际会遇到的 RTF。引一个解析库会拖进几百 KB 依赖，而这个场景
 * 用不到它的树结构。
 *
 * 中文 RTF 有两种并存写法，都必须吃下：
 * - 老式：汉字按文件代码页（`\ansicpg`，中文几乎都是 936=GBK）编成字节，
 *   以 `\'hh` 十六进制转义内联在文本里；
 * - 新式：直接写 `\uN`（N 为 Unicode 码位，负数表示 65536+N），后跟一个
 *   供老阅读器显示的 fallback 字符（如 `?`），提取时跳过。
 */

export interface RtfExtractResult {
  text: string;
  /** 提取出的文本里有解码失败的位置（U+FFFD）。与纯文本读取的 lossy 同义 */
  lossy: boolean;
}

/** 判断一段已解码的文本是不是 RTF 标记：RTF 文件一律以 `{\rtf` 开头 */
export function isRtfMarkup(text: string): boolean {
  return text.trimStart().startsWith('{\\rtf');
}

/**
 * 整组跳过的目的地。这些组里是元数据或二进制内容
 * （字体表、颜色表、样式表、图片、页眉页脚、批注、域等），
 * 与正文无关 —— 不跳过的话 `\pict` 里的十六进制会被当成正文打出来。
 */
const SKIP_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'header',
  'headerl',
  'headerr',
  'headerf',
  'footer',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'footnotes',
  'annotation',
  'atnid',
  'atnauthor',
  'atnicn',
  'atnref',
  'latentstyles',
  'xmlnstbl',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'generator',
  'template',
  'themedata',
  'colorschememapping',
  'datastore',
  'docvar',
  'object',
  'oleobject',
  'objdata',
  'objclass',
  'objname',
  'objtime',
  'objemb',
  'objlink',
  'objhtml',
  'objautlink',
  'objpub',
  'objicemb',
  'objhtml',
  'background',
  'shp',
  'shppict',
  'nonshppict',
  'shpinst',
  'shprslt',
  'shpgrp',
  'sp',
  'sn',
  'sv',
  'nestedtableprops',
  'private',
  'oldprops',
  'userprops',
  'protend',
  'passwordtable',
  'pgptbl',
  'xcprops',
  'redv',
  'fchars',
  'lchars',
  'field',
  'fldinst',
  'fldrslt',
  'xe',
  'tc',
  'theme',
]);

/** 控制符号：`\` 后跟单个非字母字符 */
const CONTROL_SYMBOLS: Record<string, string> = {
  // 转义的语法字符还原成本身
  '\\': '\\',
  '{': '{',
  '}': '}',
  // 不换行空格 / 连字符：中文正文里一律按普通空格与空串处理
  '~': ' ',
  '-': '',
  _: '',
};

/** 有确定文字含义的控制词 */
const CONTROL_WORDS: Record<string, string> = {
  par: '\n',
  line: '\n',
  softline: '\n',
  sect: '\n',
  page: '\n',
  tab: '\t',
  cell: '\t',
  emdash: '—',
  endash: '–',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  bullet: '·',
  // 双向文本标记与不可见字符：对正文没有意义
  ltrmark: '',
  rtlmark: '',
  zwj: '',
  zwnj: '',
  zwsp: '',
};

/** `\ansicpg` 代码页 → TextDecoder 编码名。缺省按 RTF 规范的 1252（Windows ANSI） */
function decoderFor(codePage: number): TextDecoder {
  switch (codePage) {
    case 936:
      return new TextDecoder('gb18030');
    case 950:
      return new TextDecoder('big5');
    case 65001:
      return new TextDecoder('utf-8');
    case 932:
      return new TextDecoder('shift-jis');
    case 949:
      return new TextDecoder('euc-kr');
    default:
      return new TextDecoder('windows-1252');
  }
}

/** 从 `from` 起读一个控制词（纯字母），返回词与下一个位置 */
function peekWord(markup: string, from: number): { word: string; next: number } {
  let j = from;
  while (j < markup.length && /[a-zA-Z]/.test(markup[j]!)) j += 1;
  return { word: markup.slice(from, j).toLowerCase(), next: j };
}

export function extractRtfText(markup: string): RtfExtractResult {
  let out = '';
  /** 待解码的 `\'hh` 字节：同一段正文里的字节与字面文字交错，攒到一起再整段解码 */
  let hexBytes: number[] = [];
  let codePage: number | null = null;
  /** `\ucN`：`\uN` 后跟的 fallback 字符个数，缺省 1 */
  let ucFallback = 1;
  let depth = 0;
  /** 不为 null 时正在跳过的组深度：内容一律丢弃，只追踪花括号配对 */
  let skipUntil: number | null = null;
  /** `\uN` 是 16 位码位，代理对由相邻两个 `\u` 拼成 */
  let pendingHigh: number | null = null;
  let lossy = false;

  function flushHex(): void {
    if (hexBytes.length === 0) return;
    const decoded = decoderFor(codePage ?? 1252).decode(new Uint8Array(hexBytes));
    if (decoded.includes('\uFFFD')) lossy = true;
    out += decoded;
    hexBytes = [];
  }

  /** 输出正文前先把积压的十六进制字节解码掉，保证顺序 */
  function emit(char: string): void {
    flushHex();
    out += char;
  }

  let i = 0;
  while (i < markup.length) {
    const ch = markup[i]!;

    if (skipUntil !== null) {
      // 跳过的组里只需分清「转义的花括号」和「真的花括号」，内容一律不看
      if (ch === '\\' && i + 1 < markup.length && '{}*\\'.includes(markup[i + 1]!)) {
        i += 2;
      } else if (ch === '{') {
        depth += 1;
        i += 1;
      } else if (ch === '}') {
        depth -= 1;
        i += 1;
        if (depth < skipUntil) skipUntil = null;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === '{') {
      depth += 1;
      i += 1;
      // 组开头的 \*（可忽略目的地）或跳表里的目的地 → 整组跳过
      if (markup[i] === '\\' && markup[i + 1] === '*') {
        skipUntil = depth;
        continue;
      }
      if (markup[i] === '\\') {
        const { word } = peekWord(markup, i + 1);
        if (SKIP_DESTINATIONS.has(word)) {
          skipUntil = depth;
        }
      }
      continue;
    }

    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }

    if (ch === '\\') {
      i += 1;
      if (i >= markup.length) break;
      const next = markup[i]!;

      if (next === "'") {
        // \'hh：十六进制字节，按 \ansicpg 声明的代码页统一解码
        const hex = markup.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          hexBytes.push(parseInt(hex, 16));
          i += 3;
        } else {
          // 畸形转义（\' 后面不是两位十六进制）：不吞字，把引号当普通文字
        }
        continue;
      }

      if (/[a-zA-Z]/.test(next)) {
        const { word, next: afterWord } = peekWord(markup, i);
        i = afterWord;
        // 可选参数：符号 + 数字
        let param: number | null = null;
        if (markup[i] === '-' || (markup[i] !== undefined && /[0-9]/.test(markup[i]!))) {
          let j = i;
          if (markup[j] === '-') j += 1;
          while (j < markup.length && /[0-9]/.test(markup[j]!)) j += 1;
          param = parseInt(markup.slice(i, j), 10);
          i = j;
        }
        // 参数后的一个空格是分隔符，不属于正文
        if (markup[i] === ' ') i += 1;

        switch (word) {
          case 'u': {
            if (param !== null) {
              const value = param < 0 ? param + 0x10000 : param;
              if (value !== 0) {
                if (pendingHigh !== null && value >= 0xdc00 && value <= 0xdfff) {
                  emit(
                    String.fromCodePoint(
                      ((pendingHigh - 0xd800) << 10) + (value - 0xdc00) + 0x10000,
                    ),
                  );
                  pendingHigh = null;
                } else {
                  if (pendingHigh !== null) emit(String.fromCharCode(pendingHigh));
                  pendingHigh = value >= 0xd800 && value <= 0xdbff ? value : null;
                  if (pendingHigh === null) emit(String.fromCharCode(value));
                }
              }
            }
            // 跳过 fallback 字符（个数由 \ucN 定，缺省 1）
            let skip = ucFallback;
            while (skip > 0 && i < markup.length) {
              if (markup[i] === '\\' && markup[i + 1] === "'" && i + 3 <= markup.length) {
                i += 4; // fallback 也可能是 \'hh
              } else if (markup[i] === '\\' && /[a-zA-Z]/.test(markup[i + 1] ?? '')) {
                i = peekWord(markup, i + 1).next; // 整个控制词算一个字符
              } else if (markup[i] === '{' || markup[i] === '}') {
                break;
              } else {
                i += 1;
              }
              skip -= 1;
            }
            break;
          }
          case 'ansicpg':
            if (param !== null) codePage = param;
            break;
          case 'cpg':
            if (param !== null && codePage === null) codePage = param;
            break;
          case 'uc':
            if (param !== null) ucFallback = param;
            break;
          default: {
            const mapped = CONTROL_WORDS[word];
            if (mapped !== undefined) emit(mapped);
            // 其余控制词（字体、字号、缩进、颜色……）对纯文本没有意义，直接忽略
          }
        }
        continue;
      }

      // 控制符号
      const mapped = CONTROL_SYMBOLS[next];
      if (mapped !== undefined) emit(mapped);
      i += 1;
      continue;
    }

    // 正文。RTF 里真实的换行是 \par；文件里的 CR/LF 只是排版空白，忽略掉
    if (ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    emit(ch);
    i += 1;
  }

  if (pendingHigh !== null) emit(String.fromCharCode(pendingHigh));
  flushHex();

  return { text: out, lossy };
}
