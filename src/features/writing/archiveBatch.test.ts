import { beforeEach, describe, expect, it } from 'vitest';
import {
  ARCHIVE_BATCH_KEY_PREFIX,
  ARCHIVE_BATCH_MAX_CHAPTERS,
  ARCHIVE_BATCH_TTL_MS,
  archiveBatchKey,
  clearArchiveBatch,
  getOrCreateArchiveBatch,
  readArchiveBatch,
  type ArchiveBatchStorage,
} from './archiveBatch';

const NOVEL = 'novel-1';

/** 可注入的内存存储；failWrites 用来模拟隐私模式 / 配额满 */
function createMemoryStorage(failWrites = false): ArchiveBatchStorage & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error('QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function fillBatch(count: number, start = 1): void {
  for (let index = start; index < start + count; index += 1) {
    getOrCreateArchiveBatch(NOVEL, `ch-${index}`, 1_000 + index);
  }
}

beforeEach(() => {
  localStorage.clear();
});

describe('归档批次（localStorage）', () => {
  it('没有批次时新建并写回', () => {
    const batch = getOrCreateArchiveBatch(NOVEL, 'ch-1', 1_000);

    expect(batch.id).toBeTruthy();
    expect(batch.chapterIds).toEqual(['ch-1']);
    expect(batch.updatedAt).toBe(1_000);
    expect(readArchiveBatch(NOVEL)).toEqual(batch);

    // 键按作品拼接，和任务约定的前缀一致
    expect(archiveBatchKey(NOVEL)).toBe(`${ARCHIVE_BATCH_KEY_PREFIX}${NOVEL}`);
    expect(JSON.parse(localStorage.getItem(archiveBatchKey(NOVEL))!)).toEqual(batch);
  });

  it('同一章重复调用复用同一批，不重复入列、不刷新 updatedAt', () => {
    const first = getOrCreateArchiveBatch(NOVEL, 'ch-1', 1_000);
    const second = getOrCreateArchiveBatch(NOVEL, 'ch-1', 2_000);

    expect(second.id).toBe(first.id);
    expect(second.chapterIds).toEqual(['ch-1']);
    // updatedAt 表示「最近一次新章入批」，同章重试不该延长批次寿命
    expect(second.updatedAt).toBe(1_000);
  });

  it('不同章累计到同一批，满 5 章后开新批', () => {
    const first = getOrCreateArchiveBatch(NOVEL, 'ch-1', 1_000);
    let last = first;
    for (let index = 2; index <= ARCHIVE_BATCH_MAX_CHAPTERS; index += 1) {
      last = getOrCreateArchiveBatch(NOVEL, `ch-${index}`, 1_000 + index);
      expect(last.id).toBe(first.id);
    }
    expect(last.chapterIds).toEqual(['ch-1', 'ch-2', 'ch-3', 'ch-4', 'ch-5']);

    const sixth = getOrCreateArchiveBatch(NOVEL, 'ch-6', 2_000);
    expect(sixth.id).not.toBe(first.id);
    expect(sixth.chapterIds).toEqual(['ch-6']);
  });

  it('同章幂等优先于满批轮转：满批里重试仍回原批', () => {
    fillBatch(5);
    const original = readArchiveBatch(NOVEL)!;

    const retry = getOrCreateArchiveBatch(NOVEL, 'ch-3', 9_999);

    expect(retry.id).toBe(original.id);
    expect(retry.chapterIds).toHaveLength(5);
  });

  it('距最近入批超过 24h 时开新批', () => {
    const first = getOrCreateArchiveBatch(NOVEL, 'ch-1', 1_000);

    const fresh = getOrCreateArchiveBatch(NOVEL, 'ch-2', 1_000 + ARCHIVE_BATCH_TTL_MS + 1);

    expect(fresh.id).not.toBe(first.id);
    expect(fresh.chapterIds).toEqual(['ch-2']);
    expect(fresh.updatedAt).toBe(1_000 + ARCHIVE_BATCH_TTL_MS + 1);
  });

  it('恰好 24h 仍复用同一批（边界不提前轮转）', () => {
    const first = getOrCreateArchiveBatch(NOVEL, 'ch-1', 1_000);

    const second = getOrCreateArchiveBatch(NOVEL, 'ch-2', 1_000 + ARCHIVE_BATCH_TTL_MS);

    expect(second.id).toBe(first.id);
    expect(second.chapterIds).toEqual(['ch-1', 'ch-2']);
  });

  it('批次按作品隔离，切书不会混批', () => {
    const a = getOrCreateArchiveBatch('novel-a', 'ch-1', 1_000);
    const b = getOrCreateArchiveBatch('novel-b', 'ch-1', 1_000);

    expect(b.id).not.toBe(a.id);
    expect(readArchiveBatch('novel-a')!.chapterIds).toEqual(['ch-1']);
    expect(readArchiveBatch('novel-b')!.chapterIds).toEqual(['ch-1']);
  });

  it('非法 JSON 或结构不合法时容错为新批，而不是抛错', () => {
    localStorage.setItem(archiveBatchKey(NOVEL), '{not json');
    const first = getOrCreateArchiveBatch(NOVEL, 'ch-1', 1_000);
    expect(first.chapterIds).toEqual(['ch-1']);

    localStorage.setItem(
      archiveBatchKey(NOVEL),
      JSON.stringify({ id: 42, chapterIds: 'nope', updatedAt: '昨天' }),
    );
    const second = getOrCreateArchiveBatch(NOVEL, 'ch-2', 2_000);
    expect(second.chapterIds).toEqual(['ch-2']);
    expect(readArchiveBatch(NOVEL)).toEqual(second);
  });

  it('读取不存在或已清空时返回 null', () => {
    expect(readArchiveBatch(NOVEL)).toBeNull();

    getOrCreateArchiveBatch(NOVEL, 'ch-1', 1_000);
    clearArchiveBatch(NOVEL);

    expect(readArchiveBatch(NOVEL)).toBeNull();
    expect(localStorage.getItem(archiveBatchKey(NOVEL))).toBeNull();
  });

  it('存储不可写时仍返回可用批次（隐私模式/配额满不吃掉归档）', () => {
    const storage = createMemoryStorage(true);

    const batch = getOrCreateArchiveBatch(NOVEL, 'ch-1', 1_000, storage);

    expect(batch.chapterIds).toEqual(['ch-1']);
    expect(storage.data.size).toBe(0);
  });

  it('支持注入存储，便于隔离测试', () => {
    const storage = createMemoryStorage();

    const batch = getOrCreateArchiveBatch(NOVEL, 'ch-1', 1_000, storage);

    expect(readArchiveBatch(NOVEL, storage)).toEqual(batch);
    clearArchiveBatch(NOVEL, storage);
    expect(readArchiveBatch(NOVEL, storage)).toBeNull();
  });
});
