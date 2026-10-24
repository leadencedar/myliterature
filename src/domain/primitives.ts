/**
 * 领域基础工具：ID、时间、字数。
 * 这些函数被 schema 与仓储层共用，单独成文件避免循环依赖。
 */

/** 把 16 个随机字节拼成标准的 UUID v4 字面量 */
function formatUuidV4(bytes: Uint8Array): string {
  // 第 7 字节的高 4 位是版本号，第 9 字节的高 2 位是变体位
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * 生成实体 ID。
 *
 * **不能直接用 `crypto.randomUUID()`。** 它只在**安全上下文**（HTTPS 或 localhost）
 * 里存在；用手机 / 平板通过局域网 IP 访问开发服务器时是 `http://192.168.x.x`，
 * 属于非安全上下文，`crypto.randomUUID` 会是 `undefined` ——
 * 而这个函数是所有实体 id 的来源，它一挂，整个应用连一本书都建不出来。
 *
 * 所以按可用性降级：
 * 1. `crypto.randomUUID()` —— 安全上下文下最快也最规范
 * 2. `crypto.getRandomValues()` 自己拼 UUID v4 —— **它不受安全上下文限制**，
 *    是局域网 HTTP 访问时真正生效的那条路
 * 3. 时间戳 + `Math.random()` —— 只为极老的运行时兜底。密码学上不安全，
 *    但这里的 id 只用于本地主键，不用于任何安全判断
 */
export function newId(): string {
  const api = globalThis.crypto as Crypto | undefined;

  if (typeof api?.randomUUID === 'function') {
    return api.randomUUID();
  }

  if (typeof api?.getRandomValues === 'function') {
    return formatUuidV4(api.getRandomValues(new Uint8Array(16)));
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  // 掺进时间戳的低 32 位，降低无随机源环境下的碰撞概率。
  // 只取 4 个字节：JS 的位运算是 32 位的，再往上移会绕回去、白做一遍
  const stamp = Date.now() >>> 0;
  for (let i = 0; i < 4; i += 1) bytes[i] = (bytes[i]! ^ (stamp >>> (i * 8))) & 0xff;
  return formatUuidV4(bytes);
}

/** 当前时间戳（epoch 毫秒）。实体的 createdAt / updatedAt 统一用它 */
export function now(): number {
  return Date.now();
}

/**
 * 本地日历日，格式 YYYY-MM-DD。
 *
 * 写作计划（「每日一章」）关心的是用户所在时区的自然日，
 * 若用 UTC 时间戳做日界判断，跨时区或夏令时会算错连续天数，
 * 因此计划与日志一律以本地日期字符串为键。
 */
export function toLocalDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 把 YYYY-MM-DD 解析成本地时区当天零点的 Date */
export function parseLocalDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** 在本地日期上加减天数，返回新的 YYYY-MM-DD */
export function addDays(value: string, delta: number): string {
  const date = parseLocalDate(value);
  date.setDate(date.getDate() + delta);
  return toLocalDate(date);
}

/** 两个本地日期相差的天数（b - a） */
export function diffDays(a: string, b: string): number {
  const ms = parseLocalDate(b).getTime() - parseLocalDate(a).getTime();
  return Math.round(ms / 86_400_000);
}

/** 星期几，0 = 周日 */
export function weekdayOf(value: string): number {
  return parseLocalDate(value).getDay();
}

/**
 * 是否按「一个字符算一个字」计数的东方文字。
 *
 * 含 CJK 标点（。、「」）与全角形式（，！？），因为国内平台的字数是把它们算进去的。
 * 假名与谚文一并纳入：它们同样是一字一格，不按空格分词。
 */
export function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x303f) || // CJK 部首补充 … CJK 标点
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xffef) || // 半角与全角形式
    (code >= 0x20000 && code <= 0x2fa1f) // 扩展 B 及以后
  );
}

const WHITESPACE = /\s/u;

/**
 * 「字数」。
 *
 * 东方文字按字符数，拉丁文字按词数，混排就两者相加 ——
 * 国内平台数的是汉字个数，而英文一个词平均五个字母，
 * 若一律按字符数算，一章英文会虚报到五倍，写作计划的「每日 3000 字」
 * 和章节目标字数会跟着一起失真。
 *
 * 对**纯中文文本，结果与「去空白后的字符数」完全一致**（全角标点计入、
 * 全角空格 U+3000 属于 `\s` 被跳过），所以既有作品的字数不会因为这次修正而变动。
 *
 * 用 for...of 遍历，代理对（扩展区汉字、emoji）才不会被拆成两个。
 */
export function countWords(text: string): number {
  let count = 0;
  let inLatinRun = false;

  for (const char of text) {
    const code = char.codePointAt(0)!;

    if (WHITESPACE.test(char)) {
      inLatinRun = false;
      continue;
    }

    if (isCjkCodePoint(code)) {
      // 东方文字本身不参与分词，同时也终结前面的拉丁词
      inLatinRun = false;
      count += 1;
      continue;
    }

    // 连续的非空白、非 CJK 字符算作一个词
    if (!inLatinRun) {
      inLatinRun = true;
      count += 1;
    }
  }

  return count;
}
