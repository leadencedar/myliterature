/**
 * 读取本地稿件文件。
 *
 * 为什么不能直接 `FileReader.readAsText`：它默认按 UTF-8 解码，而中文作者手里的
 * `.txt` 有相当比例是 **GB18030**（Windows 记事本的「ANSI」就是它）。按 UTF-8 读一个
 * GBK 文件，结果是整篇乱码 —— 而且是「看起来成功了」的那种失败，用户会以为是应用坏了。
 * 所以这里自己拿字节做编码探测。
 */

export type ManuscriptEncoding = 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be';

export const ENCODING_LABELS: Record<ManuscriptEncoding, string> = {
  'utf-8': 'UTF-8',
  gb18030: 'GB18030（中文 ANSI）',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
};

export interface ManuscriptReadResult {
  text: string;
  encoding: ManuscriptEncoding;
  /**
   * 解码后仍存在无法识别的字节（U+FFFD）。
   * 不阻止导入 —— 几十万字里错几个字符，用户自己改比被拒之门外好得多，
   * 但要明确告诉他，否则他会以为是自己当年写错了。
   */
  lossy: boolean;
}

/** 纯文本格式。刻意不收 .docx：它是个 zip，解压要额外依赖，而「另存为 txt」是一步操作 */
export const ACCEPTED_EXTENSIONS = ['.txt', '.text', '.md', '.markdown'] as const;

/** 20 MB 约等于一千万汉字，比任何单本小说都宽裕 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at === -1 ? '' : name.slice(at).toLowerCase();
}

/** 选文件后的第一道体检。返回错误文案，通过则返回 undefined */
export function checkManuscriptFile(file: { name: string; size: number }): string | undefined {
  const extension = extensionOf(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number])) {
    if (
      extension === '.doc' ||
      extension === '.docx' ||
      extension === '.rtf' ||
      extension === '.pdf'
    ) {
      return `暂不支持 ${extension} 文件，请在原软件里「另存为」纯文本（.txt）后再上传`;
    }
    return '只支持 .txt 与 .md 纯文本文件';
  }
  if (file.size === 0) return '这个文件是空的';
  if (file.size > MAX_FILE_BYTES) {
    return `文件有 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 ${
      MAX_FILE_BYTES / 1024 / 1024
    } MB 上限。可以拆成几个文件分批导入`;
  }
  return undefined;
}

/** 零宽不换行空格（BOM）出现在正文里没有意义，一律清掉 */
const BOM_CHAR = /\uFEFF/gu;

/** 统一换行并清掉 BOM。`\r` 结尾的老 Mac 文件也要处理 */
export function normalizeManuscript(text: string): string {
  return text.replace(BOM_CHAR, '').replace(/\r\n?/gu, '\n');
}

function decodeWith(bytes: Uint8Array, encoding: string, fatal: boolean): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * 粗判 BOM-less 的 UTF-16。
 *
 * UTF-16 存中文时每个字符必有一个 0x00 字节（ASCII 区）或没有（汉字区），
 * 但英文标点、数字、换行一定带 0x00。纯文本里出现大量 0x00 基本只有这一种解释 ——
 * GB18030 与 UTF-8 都不会产生 0x00。
 */
function sniffUtf16(bytes: Uint8Array): ManuscriptEncoding | undefined {
  // 太短的样本没有统计意义；空文件更是会让下面的比例判断退化成「0 >= 0」
  if (bytes.length < 4) return undefined;

  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] !== 0) continue;
    if (i % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }
  const zeros = evenZeros + oddZeros;
  if (zeros === 0 || zeros * 4 < sample.length) return undefined;
  // 0x00 落在奇数位 → 低字节在前 → LE
  return oddZeros >= evenZeros ? 'utf-16le' : 'utf-16be';
}

/**
 * 按字节探测编码并解码。
 *
 * 顺序是刻意的：
 * 1. 有 BOM 就信 BOM，这是唯一确定的信号
 * 2. 没有 BOM 时先用 **严格模式** 试 UTF-8。GB18030 的双字节序列几乎不可能同时是合法
 *    UTF-8（首字节 0x81–0xFE 后跟 0x40–0xFE 会构成非法续字节），所以「严格 UTF-8 解不通」
 *    就是「这是 GBK 系」的强证据
 * 3. 最后才退到 GB18030，它是 GBK 的超集，能覆盖到生僻字
 */
export function decodeManuscript(buffer: ArrayBuffer): ManuscriptReadResult {
  const bytes = new Uint8Array(buffer);

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return finish(decodeWith(bytes, 'utf-8', false) ?? '', 'utf-8');
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return finish(decodeWith(bytes, 'utf-16le', false) ?? '', 'utf-16le');
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return finish(decodeWith(bytes, 'utf-16be', false) ?? '', 'utf-16be');
  }

  const utf16 = sniffUtf16(bytes);
  if (utf16) {
    return finish(decodeWith(bytes, utf16, false) ?? '', utf16);
  }

  const strictUtf8 = decodeWith(bytes, 'utf-8', true);
  if (strictUtf8 !== undefined) return finish(strictUtf8, 'utf-8');

  return finish(decodeWith(bytes, 'gb18030', false) ?? '', 'gb18030');
}

function finish(raw: string, encoding: ManuscriptEncoding): ManuscriptReadResult {
  const text = normalizeManuscript(raw);
  return { text, encoding, lossy: text.includes('\uFFFD') };
}

export class ManuscriptReadError extends Error {}

/** 读取用户选择的稿件文件 */
export async function readManuscriptFile(file: File): Promise<ManuscriptReadResult> {
  const problem = checkManuscriptFile(file);
  if (problem) throw new ManuscriptReadError(problem);

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new ManuscriptReadError('文件读取失败，可以试着把它复制粘贴进来');
  }

  const result = decodeManuscript(buffer);
  if (!result.text.trim()) {
    throw new ManuscriptReadError('这个文件里没有可读的文字，可能不是纯文本');
  }
  return result;
}
