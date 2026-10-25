import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBinaryFile, saveTextFile } from './download';

let clicked: { href: string; download: string }[] = [];

beforeEach(() => {
  clicked = [];
  // jsdom 不实现真正的下载，拦下点击只看 href / download
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** 把 data: URL 里逗号后的部分按文本还原（saveTextFile 的兜底格式） */
function dataUrlText(href: string): string {
  return decodeURIComponent(href.slice(href.indexOf(',') + 1));
}

/** 把 data:...;base64, 的负载还原成字节（saveBinaryFile 的兜底格式） */
function dataUrlBytes(href: string): number[] {
  const payload = href.slice(href.indexOf(';base64,') + ';base64,'.length);
  return Array.from(atob(payload), (char) => char.charCodeAt(0));
}

describe('saveTextFile', () => {
  it('blob URL 不可用时退回文本 data URL，文件名原样保留', () => {
    saveTextFile('归墟纪.md', '# 归墟纪\n\n正文', 'text/markdown;charset=utf-8');

    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe('归墟纪.md');
    expect(clicked[0]!.href.startsWith('data:text/markdown;charset=utf-8,')).toBe(true);
    expect(dataUrlText(clicked[0]!.href)).toBe('# 归墟纪\n\n正文');
  });

  it('blob 可用时用 blob URL，并在下一轮任务里回收', () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    saveTextFile('a.txt', 'x');

    expect(clicked[0]!.href).toBe('blob:mock');
    // 立刻回收会让部分浏览器来不及开始下载
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:mock');
  });

  it('点击用的临时 <a> 会被移除，不留在文档里', () => {
    saveTextFile('a.txt', 'x');
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});

describe('saveBinaryFile', () => {
  it('data URL 兜底用 base64，且能逐字节还原（含 0x00 / 0xFF）', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f, 0x80]);
    saveBinaryFile('归墟纪.zip', bytes, 'application/zip');

    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe('归墟纪.zip');
    expect(clicked[0]!.href.startsWith('data:application/zip;base64,')).toBe(true);
    expect(dataUrlBytes(clicked[0]!.href)).toEqual([...bytes]);
  });

  it('blob 可用时用 blob URL 并延迟回收', () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    saveBinaryFile('a.zip', new Uint8Array([1, 2, 3]), 'application/zip');

    expect(clicked[0]!.href).toBe('blob:zip');
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:zip');
  });

  it('大字节数组分块 base64，不会炸调用栈', () => {
    // 200 KB 的 zip 完全可能：几十章 PDF 压在一起就是这个量级
    const bytes = new Uint8Array(200_000).fill(0x41);
    saveBinaryFile('big.zip', bytes, 'application/zip');

    expect(dataUrlBytes(clicked[0]!.href)).toHaveLength(bytes.length);
  });
});
