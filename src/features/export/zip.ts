/**
 * 零依赖 ZIP 写入。
 *
 * 整本导出只需要「每章一个文件、整本一个压缩包」这一件事。引一个压缩库会给
 * 一个零运行时依赖、数据全在本地的应用凭空加几百 KB 和长期维护面；而浏览器与
 * Node 22 自带的 CompressionStream('deflate-raw') 产出的正是 ZIP method 8 所需的
 * raw deflate，剩下的只是按规范把头部拼起来。
 *
 * 只写经典 ZIP，不写 ZIP64：分章导出离 4 GB 很远，真超限就抛错，
 * 比悄悄产出解压器读不了的文件好。
 */

export interface ZipEntry {
  /** zip 内路径，用 / 分隔，UTF-8；不含开头的 / */
  path: string;
  data: string | Uint8Array;
}

export interface ZipOptions {
  /** 文件时间（DOS 时间戳），默认 new Date()；测试传固定值保证字节确定性 */
  now?: Date;
  /** 传 false 强制 store（不压缩），测试兜底路径用 */
  compress?: boolean;
}

/** general purpose bit 11：文件名按 UTF-8 解释，中文路径不乱码 */
const UTF8_FLAG = 0x0800;
/** 2.0：store 与 deflate 都从这一版开始 */
const ZIP_VERSION = 20;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
/** 这些长度/偏移字段是 32 位，条目数是 16 位，超了就只能上 ZIP64 —— 本模块不写 */
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const MAX_NAME_LENGTH = 0xffff;

const CRC_TABLE = createCrcTable();

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

/** 标准 CRC-32（IEEE，反射多项式 0xEDB88320），返回无符号 32 位整数 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface PreparedEntry {
  readonly nameBytes: Uint8Array;
  readonly payload: Uint8Array;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly uncompressedSize: number;
  /** local file header 在整包中的偏移，central directory 要指回来 */
  readonly offset: number;
  readonly dosTime: number;
  readonly dosDate: number;
}

/** 字节级日期的可读形态：DOS 时间没有时区，按传入 Date 的**本地**日历字段写 */
interface DosTimestamp {
  readonly time: number;
  readonly date: number;
}

function toDosTimestamp(now: Date): DosTimestamp {
  // DOS 年份只存 7 位、从 1980 起算；夹住两端而不是抛错，导出不该因为用户时钟不对失败
  const year = Math.min(2107, Math.max(1980, now.getFullYear()));
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  return concat(chunks, total);
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    output.set(chunk, at);
    at += chunk.length;
  }
  return output;
}

/**
 * raw deflate（ZIP method 8）。环境没有 CompressionStream、不支持
 * 'deflate-raw'、或压缩过程出错时返回 null，由调用方回退 store ——
 * 压缩是省体积的优化，不能成为导出失败的理由。
 */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new CompressionStream('deflate-raw');
    // Writer 只收普通 ArrayBuffer 支撑的视图；调用方传进来的 Uint8Array 可能挂着
    // SharedArrayBuffer，复制一份最省心（单章数据量很小，这点拷贝可以忽略）
    const input = new Uint8Array(data);
    // 必须边写边读：数据一大，只写不读会被流的背压卡死
    const compressed = collect(stream.readable);
    const written = (async () => {
      const writer = stream.writable.getWriter();
      await writer.write(input);
      await writer.close();
    })();
    const [output] = await Promise.all([compressed, written]);
    return output;
  } catch {
    return null;
  }
}

function writeLocalHeader(entry: PreparedEntry): Uint8Array {
  const header = new Uint8Array(LOCAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, entry.method, true);
  view.setUint16(10, entry.dosTime, true);
  view.setUint16(12, entry.dosDate, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.payload.length, true);
  view.setUint32(22, entry.uncompressedSize, true);
  view.setUint16(26, entry.nameBytes.length, true);
  // extra field 长度：不写扩展字段（ZIP64 就用不上了）
  view.setUint16(28, 0, true);
  return header;
}

function writeCentralHeader(entry: PreparedEntry): Uint8Array {
  const header = new Uint8Array(CENTRAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
  // 高字节 0 = 由 FAT/DOS 创建，低字节是版本号
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, entry.method, true);
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.payload.length, true);
  view.setUint32(24, entry.uncompressedSize, true);
  view.setUint16(28, entry.nameBytes.length, true);
  view.setUint16(30, 0, true); // extra field
  view.setUint16(32, 0, true); // file comment
  view.setUint16(34, 0, true); // 起始磁盘号
  view.setUint16(36, 0, true); // internal attributes
  view.setUint32(38, 0, true); // external attributes
  view.setUint32(42, entry.offset, true);
  return header;
}

function writeEndOfCentralDirectory(
  count: number,
  centralSize: number,
  centralOffset: number,
): Uint8Array {
  const eocd = new Uint8Array(EOCD_SIZE);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(4, 0, true); // 当前磁盘号
  view.setUint16(6, 0, true); // central directory 起始磁盘号
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true); // 注释长度
  return eocd;
}

/** 打包成 zip 字节。字符串按 UTF-8 编码 */
export async function createZip(
  entries: ZipEntry[],
  options: ZipOptions = {},
): Promise<Uint8Array> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`ZIP 条目过多：${entries.length}，经典 ZIP 上限 ${MAX_ENTRIES}`);
  }

  const encoder = new TextEncoder();
  const timestamp = toDosTimestamp(options.now ?? new Date());
  const compress = options.compress !== false;
  const prepared: PreparedEntry[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    if (nameBytes.length === 0) throw new Error('ZIP 条目路径不能为空');
    if (nameBytes.length > MAX_NAME_LENGTH) {
      throw new Error(`ZIP 条目路径过长：${entry.path}`);
    }

    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    if (raw.length > MAX_UINT32) throw new Error(`ZIP 条目超过 4 GB：${entry.path}`);
    const compressed = compress ? await deflateRaw(raw) : null;
    const payload = compressed ?? raw;
    const preparedEntry: PreparedEntry = {
      nameBytes,
      payload,
      method: compressed ? 8 : 0,
      crc: crc32(raw),
      uncompressedSize: raw.length,
      offset,
      dosTime: timestamp.time,
      dosDate: timestamp.date,
    };

    chunks.push(writeLocalHeader(preparedEntry), nameBytes, payload);
    offset += LOCAL_HEADER_SIZE + nameBytes.length + payload.length;
    if (offset > MAX_UINT32) {
      throw new Error(`ZIP 超过 4 GB，无法写入经典格式：${entry.path}`);
    }
    prepared.push(preparedEntry);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of prepared) {
    chunks.push(writeCentralHeader(entry), entry.nameBytes);
    centralSize += CENTRAL_HEADER_SIZE + entry.nameBytes.length;
  }
  if (centralOffset + centralSize > MAX_UINT32) throw new Error('ZIP 超过 4 GB，无法写入经典格式');

  chunks.push(writeEndOfCentralDirectory(prepared.length, centralSize, centralOffset));
  return concat(chunks, centralOffset + centralSize + EOCD_SIZE);
}
