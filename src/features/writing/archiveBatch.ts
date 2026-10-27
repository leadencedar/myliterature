/**
 * 归档批次（M2 S1）。
 *
 * 「每章一次归档调用」产出的提案不能每章各自成一个收件箱：作者刚写完一章就被叫去
 * 确认一次，等于把收工打断五次。所以按批次归组 —— 3–5 章一批，作者可以攒着一起看。
 *
 * 批次状态只存 localStorage（D7 零迁移）：
 * - 键按作品隔离，切书不会把两本书的条目混进同一批；
 * - 结构里有「最近入批时间」，超过 24h 就开新批：隔天再写时上一批多半已经被
 *   采用或拒绝，继续往里塞只会让「本批待确认」越滚越大；
 * - 同一章重复归档必须复用原批次，否则待确认提案会被拆到两个 batch 里，
 *   作者点开「查看本批」却只看到一半。
 */
import { newId } from '@/domain/primitives';

/** 一批最多 5 章：作者一次确认的量要能在一屏内看完 */
export const ARCHIVE_BATCH_MAX_CHAPTERS = 5;
/** 批次有效期 24h；超过就开新批 */
export const ARCHIVE_BATCH_TTL_MS = 24 * 60 * 60 * 1000;
/** localStorage 键前缀，按作品 id 拼接 */
export const ARCHIVE_BATCH_KEY_PREFIX = 'myliterature.archive-batch:';

export interface ArchiveBatch {
  /** 提案的 batchId；同一批摘要/进展/条目提案共用 */
  id: string;
  /** 本批已归档的章节 id，用于同章幂等 */
  chapterIds: string[];
  /** 最近一次入批时间（epoch ms），用于 24h 轮转 */
  updatedAt: number;
}

/**
 * 本模块只依赖这三个方法，测试可以注入内存实现。
 * 不直接写 `Storage` 类型：jsdom 之外的环境（SSR/预渲染）没有它。
 */
export interface ArchiveBatchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 取默认存储；隐私模式或禁用存储时访问 localStorage 本身会抛错 */
function resolveStorage(storage?: ArchiveBatchStorage): ArchiveBatchStorage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function archiveBatchKey(novelId: string): string {
  return `${ARCHIVE_BATCH_KEY_PREFIX}${novelId}`;
}

/** 运行时校验：localStorage 的内容可能被手改、也可能来自旧版本，坏数据当没有处理 */
function isArchiveBatch(value: unknown): value is ArchiveBatch {
  if (typeof value !== 'object' || value === null) return false;
  const batch = value as Record<string, unknown>;
  return (
    typeof batch.id === 'string' &&
    batch.id.length > 0 &&
    Array.isArray(batch.chapterIds) &&
    batch.chapterIds.every((id) => typeof id === 'string' && id.length > 0) &&
    typeof batch.updatedAt === 'number' &&
    Number.isFinite(batch.updatedAt)
  );
}

/** 读本批。不存在或内容损坏时返回 null —— 归档不是核心写作路径，不能因此让「标记完成」失败 */
export function readArchiveBatch(
  novelId: string,
  storage?: ArchiveBatchStorage,
): ArchiveBatch | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(archiveBatchKey(novelId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isArchiveBatch(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 清掉本批状态。采用/拒绝整批后调用；存储不可用时静默返回 */
export function clearArchiveBatch(novelId: string, storage?: ArchiveBatchStorage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(archiveBatchKey(novelId));
  } catch {
    // 忽略：清不掉旧批次最多导致下次多开一批，不影响正确性
  }
}

/**
 * 取本章应归入的批次，必要时新建并写回。
 *
 * 规则顺序有意如此：
 * 1. 本章已在批内 → 原样复用（与批满、过期无关）。重试/草稿↔完成来回切会重复调用，
 *    必须回到原 batch，否则 pending 提案被拆散；
 * 2. 批满 5 章 → 新批；
 * 3. 距最近入批超过 24h → 新批；
 * 4. 否则接在现有批后。
 */
export function getOrCreateArchiveBatch(
  novelId: string,
  chapterId: string,
  now: number = Date.now(),
  storage?: ArchiveBatchStorage,
): ArchiveBatch {
  const current = readArchiveBatch(novelId, storage);

  if (current?.chapterIds.includes(chapterId)) return current;

  const rotate =
    current === null ||
    current.chapterIds.length >= ARCHIVE_BATCH_MAX_CHAPTERS ||
    now - current.updatedAt > ARCHIVE_BATCH_TTL_MS;

  const next: ArchiveBatch = rotate
    ? { id: newId(), chapterIds: [chapterId], updatedAt: now }
    : { ...current, chapterIds: [...current.chapterIds, chapterId], updatedAt: now };

  const store = resolveStorage(storage);
  if (store) {
    try {
      store.setItem(archiveBatchKey(novelId), JSON.stringify(next));
    } catch {
      // 配额满 / 隐私模式：退回「每次新批」，归档调用本身与提案落库不受影响
    }
  }
  return next;
}
