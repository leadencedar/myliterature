/**
 * 旧导入任务的换算：把 importType / worldviewText 时代的行换成 destination / drafts 的新形状。
 *
 * **两处共用，规则只有这一份**：Dexie v5 的 upgrade，以及 ImportJobSchema 的 preprocess
 * （让旧备份文件里的进行中任务也走同一套换算）。两处各写一份必然漂移。
 *
 * **必须是全函数，对任何输入都不抛错。** 它跑在 upgrade 回调里，抛一次异常整个 v5 升级
 * 就会回滚，数据库打不开，用户的全部作品都读不到。旧行也不一定字段齐全（importType、
 * worldviewChunks 是 v2 之后才加的，当时没有迁移补齐）。所以：
 * - 输入不是普通对象（null、数组、原始值）时原样返回，交给 Zod 或面板处理；
 * - 数组一律按 Array.isArray 读，元素不是对象时原样保留；
 * - 返回新对象，不修改入参；
 * - 只做键名换算和补默认值，不调用 Zod，不做任何可能抛错的解析。
 *
 * 每个分支都补齐五个数组键：读取路径不做 Zod parse，ImportJob 的 TS 类型里这些是必填数组，
 * 少一个就是运行时 `undefined.some`，项目里没有 ErrorBoundary，等于整个应用白屏。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function upgradeLegacyImportJob(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;

  const { importType, worldviewText: _worldviewText, ...rest } = raw;
  const chapters = arr(raw.chapters);
  let worldviewChunks = arr(raw.worldviewChunks);

  let destination: unknown;
  if (raw.destination !== undefined) {
    // 已有 destination（null 也算已有）：不换算，只补齐形状
    destination = raw.destination;
  } else if (importType === 'worldview') {
    destination = { kind: 'worldview' };
    worldviewChunks = worldviewChunks.map((chunk) =>
      isPlainObject(chunk) && chunk.title === undefined ? { ...chunk, title: '' } : chunk,
    );
  } else if (chapters.length > 0) {
    // 各章的 translateStatus 原样保留：恢复时据此识别「旧版任务、翻译进度无法续跑」
    destination = { kind: 'main' };
  } else {
    // 空的旧任务：面板加载时静默清掉
    destination = null;
  }

  return {
    ...rest,
    destination,
    drafts: arr(raw.drafts),
    chapters,
    worldviewChunks,
    entryDrafts: arr(raw.entryDrafts),
    openThreads: arr(raw.openThreads),
  };
}
