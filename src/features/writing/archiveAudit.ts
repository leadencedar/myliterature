/**
 * 归档伏笔流水（M2.1 S1）。
 *
 * 作者用户测试暴露的 P0：归档提取会把「本章收束掉的伏笔」从摘要的累计清单里去掉，
 * 一旦确认了错误的收束，后续上下文里这条伏笔就凭空消失了。所以归档时把本章
 * 「新埋 / 收束 / 现存」落一份**只读流水**，收件箱里给作者核对：
 * 看到误收束，回到摘要的「未收束伏笔」编辑框里加回去即可。
 *
 * 存放纪律：
 * - 只存文本、只存 localStorage（零迁移），按 batchId 一份，7 天后读取时清理；
 * - **不参与幂等、不参与落库**：流水丢了/坏了只影响展示，提案与摘要数据完全不受影响；
 * - 写失败（隐私模式/配额满）静默吞掉 —— 不能因为展示用的辅助数据让归档失败。
 */

/** 一条流水保留 7 天：够作者在批次确认期内核对，又不至于长期占 localStorage */
export const ARCHIVE_AUDIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ARCHIVE_AUDIT_KEY_PREFIX = 'myliterature.archive-audit:';

export interface ArchiveAuditChapter {
  chapterId: string;
  /** 章节序号，用于「第 N 章」展示 */
  index: number;
  title: string;
  /** 本章新埋下的伏笔 */
  opened: string[];
  /** 本章收束掉的旧伏笔（模型原样返回的清单） */
  resolved: string[];
  /** 截至本章的累计未收束清单 */
  open: string[];
  /** 写入时间（epoch ms），用于 7 天 prune */
  savedAt: number;
}

export interface ArchiveAudit {
  chapters: ArchiveAuditChapter[];
}

/** 只依赖这三个方法，测试可注入内存实现 */
export interface ArchiveAuditStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ArchiveAuditOptions {
  /** 注入存储（测试隔离用）；不传用 localStorage */
  storage?: ArchiveAuditStorage;
  /** 注入当前时间（测试 7 天 prune 用）；不传用 Date.now() */
  now?: number;
}

function resolveStorage(storage?: ArchiveAuditStorage): ArchiveAuditStorage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 隐私模式/禁用存储：访问 localStorage 本身会抛错
    return null;
  }
}

export function archiveAuditKey(batchId: string): string {
  return `${ARCHIVE_AUDIT_KEY_PREFIX}${batchId}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isAuditChapter(value: unknown): value is ArchiveAuditChapter {
  if (typeof value !== 'object' || value === null) return false;
  const chapter = value as Record<string, unknown>;
  return (
    typeof chapter.chapterId === 'string' &&
    chapter.chapterId.length > 0 &&
    typeof chapter.index === 'number' &&
    Number.isFinite(chapter.index) &&
    typeof chapter.title === 'string' &&
    isStringArray(chapter.opened) &&
    isStringArray(chapter.resolved) &&
    isStringArray(chapter.open) &&
    typeof chapter.savedAt === 'number' &&
    Number.isFinite(chapter.savedAt)
  );
}

/** 顶层结构不合法返回 null；单章损坏则丢弃该章，不连累整批流水 */
function sanitizeAudit(value: unknown): ArchiveAudit | null {
  if (typeof value !== 'object' || value === null) return null;
  const chapters = (value as { chapters?: unknown }).chapters;
  if (!Array.isArray(chapters)) return null;
  return { chapters: chapters.filter(isAuditChapter) };
}

/** 去掉超过 7 天的章节；纯函数，便于测试与读取时复用 */
export function pruneArchiveAudit(audit: ArchiveAudit, now: number = Date.now()): ArchiveAudit {
  return {
    chapters: audit.chapters.filter((chapter) => now - chapter.savedAt <= ARCHIVE_AUDIT_TTL_MS),
  };
}

/**
 * 读本批流水。不存在/JSON 坏/结构坏时返回空清单（UI 显示「没有流水记录」即可）。
 * 读取时顺带 prune 超过 7 天的章，并把清理结果写回（清空时删 key）。
 */
export function readArchiveAudit(batchId: string, options: ArchiveAuditOptions = {}): ArchiveAudit {
  const store = resolveStorage(options.storage);
  if (!store) return { chapters: [] };

  let raw: string | null;
  try {
    raw = store.getItem(archiveAuditKey(batchId));
  } catch {
    return { chapters: [] };
  }
  if (raw === null) return { chapters: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { chapters: [] };
  }

  const sanitized = sanitizeAudit(parsed);
  if (sanitized === null) return { chapters: [] };

  const now = options.now ?? Date.now();
  const pruned = pruneArchiveAudit(sanitized, now);
  // 有章节被清掉（过期或损坏）时写回，避免坏数据一直留在存储里
  if (pruned.chapters.length !== sanitized.chapters.length) {
    try {
      if (pruned.chapters.length === 0) store.removeItem(archiveAuditKey(batchId));
      else store.setItem(archiveAuditKey(batchId), JSON.stringify(pruned));
    } catch {
      // 清不掉只是多占一点空间；本次读取结果已经正确
    }
  }
  return pruned;
}

/**
 * 写入本章流水。同章重跑时替换旧记录（不重复），其他章节保留。
 * 存储不可用/写失败时静默返回：流水是展示用数据，不能连累归档。
 */
export function saveArchiveAudit(
  batchId: string,
  chapter: Omit<ArchiveAuditChapter, 'savedAt'>,
  options: ArchiveAuditOptions = {},
): void {
  const now = options.now ?? Date.now();
  // 先读（含 prune），保证不会把过期章节带回去
  const current = readArchiveAudit(batchId, options);
  const chapters = current.chapters.filter((item) => item.chapterId !== chapter.chapterId);
  chapters.push({ ...chapter, savedAt: now });

  const store = resolveStorage(options.storage);
  if (!store) return;
  try {
    store.setItem(archiveAuditKey(batchId), JSON.stringify({ chapters }));
  } catch {
    // 配额满/隐私模式：放弃写入，作者只是看不到这条流水
  }
}

/** 清掉本批流水（例如整批处理完）。存储不可用时静默返回 */
export function clearArchiveAudit(batchId: string, storage?: ArchiveAuditStorage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(archiveAuditKey(batchId));
  } catch {
    // 清不掉不影响正确性，最多多占一点空间
  }
}
