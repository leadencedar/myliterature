import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  ManuscriptReadError,
  checkManuscriptFile,
  decodeManuscript,
  normalizeManuscript,
  readManuscriptFile,
} from './readManuscript';

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function utf8(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** UTF-16LE 编码，用于模拟 Windows 记事本的「Unicode」保存 */
function utf16le(text: string, bom = true): ArrayBuffer {
  const units = [...text].flatMap((char) => {
    const code = char.codePointAt(0)!;
    return [code & 0xff, code >> 8];
  });
  return new Uint8Array(bom ? [0xff, 0xfe, ...units] : units).buffer;
}

/**
 * 手写的 GB18030 字节。
 *
 * Node 没有内置的 GBK 编码器，所以这里直接写死码位：
 * 第=B5DA 一=D2BB 章=D5C2 你=C4E3 好=BAC3
 */
const GBK_DI_YI_ZHANG = [0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2];
const GBK_NI_HAO = [0xc4, 0xe3, 0xba, 0xc3];

describe('换行与 BOM 归一', () => {
  it('CRLF 与单独的 CR 都归成 LF', () => {
    expect(normalizeManuscript('第一章\r\n正文\r第二章')).toBe('第一章\n正文\n第二章');
  });

  it('清掉正文里任何位置的 BOM', () => {
    expect(normalizeManuscript('\uFEFF第一章\uFEFF正文')).toBe('第一章正文');
  });

  it('不动作者自己的全角缩进', () => {
    expect(normalizeManuscript('　　他没有回头。')).toBe('　　他没有回头。');
  });
});

describe('编码探测', () => {
  it('带 BOM 的 UTF-8', () => {
    const buffer = new Uint8Array([0xef, 0xbb, 0xbf, ...new Uint8Array(utf8('第一章'))]).buffer;
    expect(decodeManuscript(buffer)).toEqual({
      text: '第一章',
      encoding: 'utf-8',
      format: 'text',
      lossy: false,
    });
  });

  it('无 BOM 的 UTF-8', () => {
    expect(decodeManuscript(utf8('第一章 离乡\n他没有回头。'))).toMatchObject({
      text: '第一章 离乡\n他没有回头。',
      encoding: 'utf-8',
      lossy: false,
    });
  });

  it('GB18030：Windows 记事本存的中文 txt', () => {
    // 按 UTF-8 读这段字节会整篇乱码，而且是「看起来成功了」的那种失败
    const result = decodeManuscript(bytes(...GBK_DI_YI_ZHANG));
    expect(result.encoding).toBe('gb18030');
    expect(result.text).toBe('第一章');
    expect(result.lossy).toBe(false);
  });

  it('GB18030 混着 ASCII 与换行也能正确解出', () => {
    const result = decodeManuscript(bytes(...GBK_DI_YI_ZHANG, 0x0d, 0x0a, ...GBK_NI_HAO, 0x2e));
    expect(result.encoding).toBe('gb18030');
    expect(result.text).toBe('第一章\n你好.');
  });

  it('带 BOM 的 UTF-16LE', () => {
    expect(decodeManuscript(utf16le('第一章'))).toMatchObject({
      text: '第一章',
      encoding: 'utf-16le',
    });
  });

  it('无 BOM 的 UTF-16LE 靠 0x00 分布认出来', () => {
    // UTF-16 存 ASCII 时每个字符都带一个 0x00；UTF-8 与 GB18030 都不会产生 0x00
    const result = decodeManuscript(utf16le('Chapter One\nHe left.', false));
    expect(result.encoding).toBe('utf-16le');
    expect(result.text).toBe('Chapter One\nHe left.');
  });

  it('纯 ASCII 当作 UTF-8，不误判成 GBK', () => {
    expect(decodeManuscript(utf8('Chapter 1\nHe left.'))).toMatchObject({
      encoding: 'utf-8',
      text: 'Chapter 1\nHe left.',
    });
  });

  it('空文件不炸', () => {
    expect(decodeManuscript(bytes())).toEqual({
      text: '',
      encoding: 'utf-8',
      format: 'text',
      lossy: false,
    });
  });

  it('确实有坏字节时标记 lossy，但不丢掉其余内容', () => {
    // 0xFF 在 GB18030 里不是合法字节（注意 0x80 是合法的，它是欧元符号）
    const result = decodeManuscript(bytes(...GBK_DI_YI_ZHANG, 0xff, ...GBK_NI_HAO));
    expect(result.encoding).toBe('gb18030');
    expect(result.lossy).toBe(true);
    expect(result.text).toContain('第一章');
    expect(result.text).toContain('你好');
  });
});

describe('文件体检', () => {
  it('接受 txt、md 与 rtf', () => {
    expect(checkManuscriptFile({ name: '归墟纪.txt', size: 100 })).toBeUndefined();
    expect(checkManuscriptFile({ name: '归墟纪.MD', size: 100 })).toBeUndefined();
    expect(checkManuscriptFile({ name: 'a.markdown', size: 100 })).toBeUndefined();
    expect(checkManuscriptFile({ name: '归墟纪.RTF', size: 100 })).toBeUndefined();
  });

  it('Word / PDF 给出「另存为纯文本」的具体指引', () => {
    expect(checkManuscriptFile({ name: '归墟纪.docx', size: 100 })).toMatch(/另存为/u);
    expect(checkManuscriptFile({ name: '归墟纪.pdf', size: 100 })).toMatch(/另存为/u);
  });

  it('其他格式直接说明只收纯文本', () => {
    expect(checkManuscriptFile({ name: '封面.png', size: 100 })).toBe(
      '只支持 .txt、.md 与 .rtf 文件',
    );
    expect(checkManuscriptFile({ name: '没有扩展名', size: 100 })).toBeTruthy();
  });

  it('空文件与超大文件拦下', () => {
    expect(checkManuscriptFile({ name: 'a.txt', size: 0 })).toBe('这个文件是空的');
    const tooBig = checkManuscriptFile({ name: 'a.txt', size: MAX_FILE_BYTES + 1 });
    expect(tooBig).toMatch(/超过 20 MB/u);
    // 提示里要给出下一步做什么
    expect(tooBig).toMatch(/拆成几个文件/u);
  });
});

describe('读取文件', () => {
  function file(name: string, buffer: ArrayBuffer): File {
    return new File([buffer], name, { type: 'text/plain' });
  }

  it('读出 UTF-8 稿件', async () => {
    const result = await readManuscriptFile(file('归墟纪.txt', utf8('第一章 离乡\n他没有回头。')));
    expect(result.text).toBe('第一章 离乡\n他没有回头。');
    expect(result.encoding).toBe('utf-8');
  });

  it('读出 GB18030 稿件', async () => {
    const result = await readManuscriptFile(
      file('归墟纪.txt', bytes(...GBK_DI_YI_ZHANG, 0x0a, ...GBK_NI_HAO)),
    );
    expect(result.text).toBe('第一章\n你好');
    expect(result.encoding).toBe('gb18030');
    expect(result.format).toBe('text');
  });

  it('.rtf 提取成纯文本：\\par 是换行、\\uN 是汉字', async () => {
    const markup = '{\\rtf1\\ansi\\deff0 \\u31532?\\u19968?\\u31456?\\par \\u20320?\\u22909?}';
    const result = await readManuscriptFile(file('归墟纪.rtf', utf8(markup)));
    expect(result.format).toBe('rtf');
    expect(result.text).toBe('第一章\n你好');
    expect(result.lossy).toBe(false);
  });

  it('老式 GBK 转义的 RTF 也能解出中文', async () => {
    const markup =
      "{\\rtf1\\ansi\\ansicpg936 \\'b5\\'da\\'d2\\'bb\\'d5\\'c2\\par \\'c4\\'e3\\'ba\\'c3}";
    const result = await readManuscriptFile(file('旧稿.rtf', utf8(markup)));
    expect(result.format).toBe('rtf');
    expect(result.text).toBe('第一章\n你好');
  });

  it('被改名成 .txt 的 RTF 按内容识别，照样提取', async () => {
    const markup = '{\\rtf1\\ansi 改名保存的\\par 老稿子}';
    const result = await readManuscriptFile(file('老稿子.txt', utf8(markup)));
    expect(result.format).toBe('rtf');
    expect(result.text).toBe('改名保存的\n老稿子');
  });

  it('RTF 里没有任何正文时同样拦下', async () => {
    await expect(
      readManuscriptFile(file('空.rtf', utf8('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}}'))),
    ).rejects.toThrow(/没有可读的文字/u);
  });

  it('格式不对时抛出可以直接展示给用户的错误', async () => {
    await expect(readManuscriptFile(file('稿件.docx', utf8('x')))).rejects.toThrow(
      ManuscriptReadError,
    );
    await expect(readManuscriptFile(file('稿件.docx', utf8('x')))).rejects.toThrow(/另存为/u);
  });

  it('只有空白的文件也拦下', async () => {
    await expect(readManuscriptFile(file('空.txt', utf8('   \n\n  ')))).rejects.toThrow(
      /没有可读的文字/u,
    );
  });
});
