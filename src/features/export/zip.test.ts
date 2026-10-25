import { describe, expect, it, vi } from 'vitest';
import { createZip, crc32, type ZipEntry } from './zip';

/**
 * 测试里自己解析 zip：要断言的是字节层面的格式契约（签名、偏移、标志位），
 * 用一个解析库反而会把「解压器容忍的偏差」也照单全收。
 */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const UTF8_FLAG = 0x0800;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface LocalEntry {
  path: string;
  flags: number;
  method: number;
  version: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  nameLength: number;
  extraLength: number;
  offset: number;
  /** local header 之后的原始（压缩或已存）数据 */
  payload: Uint8Array;
}

interface CentralEntry {
  path: string;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ParsedZip {
  local: LocalEntry[];
  central: CentralEntry[];
  centralOffset: number;
  centralSize: number;
  eocdOffset: number;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEocd(view: DataView, length: number): number {
  for (let at = length - EOCD_SIZE; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  throw new Error('找不到 EOCD 签名');
}

function decodeName(bytes: Uint8Array, start: number, length: number): string {
  return decoder.decode(bytes.subarray(start, start + length));
}

function parseZip(bytes: Uint8Array): ParsedZip {
  const view = dataView(bytes);
  const eocdOffset = findEocd(view, bytes.length);
  const count = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  const local: LocalEntry[] = [];
  let at = 0;
  while (at < centralOffset) {
    expect(view.getUint32(at, true), `偏移 ${at} 应是 local header`).toBe(LOCAL_SIGNATURE);
    const version = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 6, true);
    const method = view.getUint16(at + 8, true);
    const dosTime = view.getUint16(at + 10, true);
    const dosDate = view.getUint16(at + 12, true);
    const crc = view.getUint32(at + 14, true);
    const compressedSize = view.getUint32(at + 18, true);
    const uncompressedSize = view.getUint32(at + 22, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const nameStart = at + 30;
    const dataStart = nameStart + nameLength + extraLength;
    local.push({
      path: decodeName(bytes, nameStart, nameLength),
      flags,
      method,
      version,
      dosTime,
      dosDate,
      crc,
      compressedSize,
      uncompressedSize,
      nameLength,
      extraLength,
      offset: at,
      payload: bytes.subarray(dataStart, dataStart + compressedSize),
    });
    at = dataStart + compressedSize;
  }
  expect(at, 'local 区域应恰好结束于 central directory 开头').toBe(centralOffset);

  const central: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true), `偏移 ${cursor} 应是 central header`).toBe(
      CENTRAL_SIGNATURE,
    );
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    central.push({
      path: decodeName(bytes, cursor + 46, nameLength),
      flags: view.getUint16(cursor + 8, true),
      method: view.getUint16(cursor + 10, true),
      dosTime: view.getUint16(cursor + 12, true),
      dosDate: view.getUint16(cursor + 14, true),
      crc: view.getUint32(cursor + 16, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      localHeaderOffset: view.getUint32(cursor + 42, true),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor, 'central directory 大小应等于条目长度之和').toBe(centralOffset + centralSize);
  expect(centralOffset + centralSize).toBe(eocdOffset);
  expect(view.getUint16(eocdOffset + 8, true)).toBe(count);
  expect(view.getUint16(eocdOffset + 4, true)).toBe(0);
  expect(view.getUint16(eocdOffset + 6, true)).toBe(0);
  expect(view.getUint16(eocdOffset + 20, true)).toBe(0);

  return { local, central, centralOffset, centralSize, eocdOffset };
}

function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return (async () => {
    const reader = readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const output = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      output.set(chunk, at);
      at += chunk.length;
    }
    return output;
  })();
}

async function inflateRaw(payload: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const inflated = collect(stream.readable);
  const written = (async () => {
    const writer = stream.writable.getWriter();
    // 与 createZip 内部同理：Writer 只收普通 ArrayBuffer 支撑的视图
    await writer.write(new Uint8Array(payload));
    await writer.close();
  })();
  const [output] = await Promise.all([inflated, written]);
  return output;
}

/** 解开整包，按路径还原每个文件的内容 */
async function readFiles(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const parsed = parseZip(bytes);
  const files = new Map<string, Uint8Array>();
  for (const entry of parsed.local) {
    const data = entry.method === 0 ? entry.payload : await inflateRaw(entry.payload);
    expect(data.length, `${entry.path} 解压后长度`).toBe(entry.uncompressedSize);
    expect(crc32(data), `${entry.path} 的 CRC 应覆盖原始数据`).toBe(entry.crc);
    files.set(entry.path, data);
  }
  return files;
}

/** 统一的本地时间：DOS 时间没有时区，用本地字段构造保证换算与机器时区无关 */
const FIXED_NOW = new Date(2026, 9, 26, 3, 20, 8);

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

function rawBytes(entry: ZipEntry): Uint8Array {
  return typeof entry.data === 'string' ? text(entry.data) : entry.data;
}

describe('CRC-32', () => {
  it('标准向量「123456789」得到 0xCBF43926', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });

  it('空数据的 CRC 为 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('与公开向量一致', () => {
    expect(crc32(text('a'))).toBe(0xe8b7be43);
    expect(crc32(text('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('store 路径', () => {
  const entries: ZipEntry[] = [
    { path: '归墟纪/第001章 离乡.txt', data: '天还没亮，他就走了。\n' },
    { path: '归墟纪/外传·青冥旧事/第002章 夜渡.md', data: '## 夜渡\n\n青冥。\n' },
    { path: 'bin/empty.bin', data: new Uint8Array(0) },
    { path: 'bin/all-bytes.bin', data: Uint8Array.from({ length: 256 }, (_, index) => index) },
  ];

  it('compress: false 时全部 method 0，解回与原始数据一致', async () => {
    const bytes = await createZip(entries, { now: FIXED_NOW, compress: false });
    const parsed = parseZip(bytes);
    expect(parsed.local).toHaveLength(entries.length);
    for (const entry of parsed.local) expect(entry.method).toBe(0);

    const files = await readFiles(bytes);
    expect(decoder.decode(files.get('归墟纪/第001章 离乡.txt'))).toBe(entries[0]!.data);
    expect(decoder.decode(files.get('归墟纪/外传·青冥旧事/第002章 夜渡.md'))).toBe(
      entries[1]!.data,
    );
    expect(files.get('bin/empty.bin')).toEqual(new Uint8Array(0));
    expect(files.get('bin/all-bytes.bin')).toEqual(entries[3]!.data as Uint8Array);
  });

  it('空数据合法：CRC 为 0，压缩前后大小都是 0', async () => {
    const bytes = await createZip([{ path: 'empty.txt', data: '' }], {
      now: FIXED_NOW,
      compress: false,
    });
    const [entry] = parseZip(bytes).local;
    expect(entry!.crc).toBe(0);
    expect(entry!.compressedSize).toBe(0);
    expect(entry!.uncompressedSize).toBe(0);
    expect(await readFiles(bytes)).toEqual(new Map([['empty.txt', new Uint8Array(0)]]));
  });

  it('local 与 central 的标志位、CRC、大小、方法一一对应', async () => {
    const bytes = await createZip(entries, { now: FIXED_NOW, compress: false });
    const { local, central } = parseZip(bytes);
    for (let index = 0; index < local.length; index += 1) {
      const localEntry = local[index]!;
      const centralEntry = central[index]!;
      expect(centralEntry.path).toBe(localEntry.path);
      expect(centralEntry.localHeaderOffset).toBe(localEntry.offset);
      expect(centralEntry.flags).toBe(localEntry.flags);
      expect(centralEntry.method).toBe(localEntry.method);
      expect(centralEntry.crc).toBe(localEntry.crc);
      expect(centralEntry.compressedSize).toBe(localEntry.compressedSize);
      expect(centralEntry.uncompressedSize).toBe(localEntry.uncompressedSize);
      expect(centralEntry.crc).toBe(crc32(rawBytes(entries[index]!)));
      // 不写扩展字段：ZIP64 用不到，解析器对 extraLength 非零的兼容性千差万别
      expect(localEntry.extraLength).toBe(0);
    }
  });
});

describe('deflate 路径', () => {
  it('默认用 method 8（deflate-raw），DecompressionStream 能解回原数据', async () => {
    const entries: ZipEntry[] = [
      { path: 'chapter.txt', data: '灵潮'.repeat(400) + '\n' },
      { path: 'nested/中文 路径.md', data: '# 标题\n\n正文一段。\n' },
      { path: 'empty.txt', data: '' },
      { path: 'binary.bin', data: Uint8Array.from({ length: 512 }, (_, index) => index % 251) },
    ];
    const bytes = await createZip(entries, { now: FIXED_NOW });
    const parsed = parseZip(bytes);
    for (const entry of parsed.local) expect(entry.method).toBe(8);

    const files = await readFiles(bytes);
    expect(decoder.decode(files.get('chapter.txt'))).toBe(entries[0]!.data);
    expect(decoder.decode(files.get('nested/中文 路径.md'))).toBe(entries[1]!.data);
    expect(files.get('empty.txt')).toEqual(new Uint8Array(0));
    expect(files.get('binary.bin')).toEqual(entries[3]!.data as Uint8Array);
  });

  it('重复内容确实被压缩：压缩后小于原始大小', async () => {
    const content = '第 1 章 灵潮\n\n子夜翻涌，海面像一块被谁翻过来的铁。\n'.repeat(200);
    const bytes = await createZip([{ path: 'long.txt', data: content }], { now: FIXED_NOW });
    const [entry] = parseZip(bytes).local;
    expect(entry!.method).toBe(8);
    expect(entry!.compressedSize).toBeLessThan(entry!.uncompressedSize);
    expect(entry!.uncompressedSize).toBe(text(content).length);
  });

  it('环境没有 CompressionStream 时自动回退 store', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    try {
      const entries: ZipEntry[] = [{ path: '归墟纪/第001章.txt', data: '天还没亮。' }];
      const bytes = await createZip(entries, { now: FIXED_NOW });
      expect(parseZip(bytes).local[0]!.method).toBe(0);
      expect(decoder.decode((await readFiles(bytes)).get('归墟纪/第001章.txt'))).toBe('天还没亮。');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('compress 显式为 true 与默认一致', async () => {
    const entries: ZipEntry[] = [{ path: 'a.txt', data: '压缩我' }];
    const fallback = await createZip(entries, { now: FIXED_NOW });
    const explicit = await createZip(entries, { now: FIXED_NOW, compress: true });
    expect(explicit).toEqual(fallback);
    expect(parseZip(explicit).local[0]!.method).toBe(8);
  });
});

describe('文件名与结构', () => {
  it('中文路径在 local 与 central 都打 UTF-8 标志位，解回不乱码', async () => {
    const entries: ZipEntry[] = [
      { path: '归墟纪/外传·青冥旧事/第012章 拜师.pdf', data: 'fake pdf' },
    ];
    const bytes = await createZip(entries, { now: FIXED_NOW, compress: false });
    const parsed = parseZip(bytes);
    expect(parsed.local[0]!.flags).toBe(UTF8_FLAG);
    expect(parsed.central[0]!.flags).toBe(UTF8_FLAG);
    expect(parsed.local[0]!.path).toBe(entries[0]!.path);
    expect(parsed.central[0]!.path).toBe(entries[0]!.path);
  });

  it('条目顺序 = 传入顺序', async () => {
    const entries: ZipEntry[] = [
      { path: 'b.txt', data: 'b' },
      { path: 'a.txt', data: 'a' },
      { path: 'c/d.txt', data: 'd' },
    ];
    const parsed = parseZip(await createZip(entries, { now: FIXED_NOW, compress: false }));
    expect(parsed.local.map((entry) => entry.path)).toEqual(['b.txt', 'a.txt', 'c/d.txt']);
    expect(parsed.central.map((entry) => entry.path)).toEqual(['b.txt', 'a.txt', 'c/d.txt']);
    for (let index = 1; index < parsed.local.length; index += 1) {
      expect(parsed.local[index]!.offset).toBeGreaterThan(parsed.local[index - 1]!.offset);
    }
  });

  it('空条目列表也是合法 zip：只有 22 字节 EOCD', async () => {
    const bytes = await createZip([], { now: FIXED_NOW });
    expect(bytes.length).toBe(EOCD_SIZE);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(EOCD_SIGNATURE);
    const parsed = parseZip(bytes);
    expect(parsed.local).toHaveLength(0);
    expect(parsed.central).toHaveLength(0);
    expect(parsed.centralOffset).toBe(0);
    expect(parsed.centralSize).toBe(0);
  });

  it('签名齐全、版本号 2.0、不写 extra field', async () => {
    const bytes = await createZip([{ path: 'a.txt', data: 'a' }], {
      now: FIXED_NOW,
      compress: false,
    });
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(LOCAL_SIGNATURE);
    const parsed = parseZip(bytes);
    expect(parsed.local[0]!.version).toBe(20);
    expect(parsed.local[0]!.extraLength).toBe(0);
    expect(view.getUint32(parsed.centralOffset, true)).toBe(CENTRAL_SIGNATURE);
    expect(view.getUint32(parsed.eocdOffset, true)).toBe(EOCD_SIGNATURE);
  });
});

describe('DOS 时间戳', () => {
  it('由注入的 now 按本地日历换算', async () => {
    const parsed = parseZip(await createZip([{ path: 'a.txt', data: 'a' }], { now: FIXED_NOW }));
    const [entry] = parsed.local;
    // 03:20:08 → (3 << 11) | (20 << 5) | (8 >> 1)
    expect(entry!.dosTime).toBe(6788);
    // 2026-10-26 → ((2026 - 1980) << 9) | (10 << 5) | 26
    expect(entry!.dosDate).toBe(23898);
  });

  it('年份夹到 1980–2107', async () => {
    const before = parseZip(
      await createZip([{ path: 'a.txt', data: 'a' }], { now: new Date(1975, 0, 1, 0, 0, 0) }),
    );
    expect(before.local[0]!.dosDate).toBe(33); // 1980-01-01
    const after = parseZip(
      await createZip([{ path: 'a.txt', data: 'a' }], {
        now: new Date(2150, 11, 31, 23, 59, 58),
      }),
    );
    expect(after.local[0]!.dosDate).toBe(65439); // 2107-12-31
    expect(after.local[0]!.dosTime).toBe(49021); // 23:59:29（DOS 精确到 2 秒）
  });
});

describe('确定性', () => {
  const entries: ZipEntry[] = [
    { path: '归墟纪/第001章.txt', data: '天还没亮。' },
    { path: '归墟纪/第002章.txt', data: '雨下了三天。' },
  ];

  it('固定 now 后字节完全一致', async () => {
    const first = await createZip(entries, { now: FIXED_NOW });
    const second = await createZip(entries, { now: FIXED_NOW });
    expect(second).toEqual(first);
  });

  it('now 不同只改时间字段，正文与文件名不变', async () => {
    const first = await createZip(entries, { now: FIXED_NOW });
    const second = await createZip(entries, { now: new Date(2026, 9, 26, 3, 20, 10) });
    expect(second).not.toEqual(first);
    const a = parseZip(first);
    const b = parseZip(second);
    expect(b.local.map((entry) => entry.dosTime)).not.toEqual(
      a.local.map((entry) => entry.dosTime),
    );
    expect(b.central.map((entry) => entry.path)).toEqual(a.central.map((entry) => entry.path));
    const filesA = await readFiles(first);
    const filesB = await readFiles(second);
    for (const path of filesA.keys()) expect(filesB.get(path)).toEqual(filesA.get(path));
  });
});

describe('非法输入', () => {
  it('空路径抛错', async () => {
    await expect(createZip([{ path: '', data: 'x' }])).rejects.toThrow('路径不能为空');
  });

  it('路径超过 65535 字节抛错', async () => {
    await expect(createZip([{ path: 'a'.repeat(65536), data: 'x' }])).rejects.toThrow('路径过长');
  });

  it('条目数超过 65535 抛错（不写 ZIP64）', async () => {
    const tooMany = Array.from({ length: 65536 }, (_, index) => ({
      path: `f${index}.txt`,
      data: '',
    }));
    await expect(createZip(tooMany)).rejects.toThrow('条目过多');
  });
});
