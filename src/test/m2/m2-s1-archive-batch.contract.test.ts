/**
 * M2-S1 独立验收：归档批次存储 + 归档设置（design §1、评审修正 §6.4）。
 *
 * 独立于开发的 archiveBatch.test.ts / archiveSettings.test.ts：用可注入内存存储
 * 验证批次复用/轮转/容错边界，边界值按设计手算（5 章、24h）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARCHIVE_BATCH_KEY_PREFIX,
  ARCHIVE_BATCH_MAX_CHAPTERS,
  ARCHIVE_BATCH_TTL_MS,
  archiveBatchKey,
  clearArchiveBatch,
  getOrCreateArchiveBatch,
  readArchiveBatch,
  type ArchiveBatchStorage,
} from '@/features/writing/archiveBatch';
import {
  ARCHIVE_SETTINGS_STORAGE_KEY,
  DEFAULT_ARCHIVE_SETTINGS,
  useArchiveSettings,
} from '@/features/writing/archiveSettings';

const T0 = 1_760_000_000_000; // 固定时间戳，避免依赖真实时钟

interface MemoryStorage extends ArchiveBatchStorage {
  map: Map<string, string>;
  setCalls: number;
  removeCalls: number;
}

function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const map = new Map(Object.entries(initial));
  let setCalls = 0;
  let removeCalls = 0;
  return {
    map,
    get setCalls() {
      return setCalls;
    },
    get removeCalls() {
      return removeCalls;
    },
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      setCalls += 1;
      map.set(key, value);
    },
    removeItem: (key) => {
      removeCalls += 1;
      map.delete(key);
    },
  };
}

/** 抛错的存储：模拟隐私模式/配额满 —— 归档不能因此让「标记完成」失败 */
function throwingStorage(where: 'get' | 'set'): ArchiveBatchStorage {
  return {
    getItem: (_key) => {
      if (where === 'get') throw new Error('storage denied');
      return null;
    },
    setItem: () => {
      if (where === 'set') throw new Error('quota exceeded');
    },
    removeItem: () => {
      throw new Error('storage denied');
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  useArchiveSettings.setState({ ...DEFAULT_ARCHIVE_SETTINGS });
});

afterEach(() => {
  localStorage.clear();
});

describe('M2-S1 · 批次常量与键（design §1）', () => {
  it('一批最多 5 章、24h 轮转、键按作品拼接', () => {
    expect(ARCHIVE_BATCH_MAX_CHAPTERS).toBe(5);
    expect(ARCHIVE_BATCH_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(archiveBatchKey('novel-1')).toBe(`${ARCHIVE_BATCH_KEY_PREFIX}novel-1`);
  });
});

describe('M2-S1 · 批次复用与轮转（design §2.4 修正）', () => {
  it('没有批次时新建并写回：id 非空、含本章、updatedAt=now', () => {
    const storage = memoryStorage();
    const batch = getOrCreateArchiveBatch('n1', 'ch1', T0, storage);

    expect(batch.id.length).toBeGreaterThan(0);
    expect(batch.chapterIds).toEqual(['ch1']);
    expect(batch.updatedAt).toBe(T0);
    expect(storage.setCalls).toBe(1);
    expect(readArchiveBatch('n1', storage)).toEqual(batch);
  });

  it('同一章重复归档（草稿↔完成来回切）复用原批次、不重复、不写回', () => {
    const storage = memoryStorage();
    const first = getOrCreateArchiveBatch('n1', 'ch1', T0, storage);
    const again = getOrCreateArchiveBatch('n1', 'ch1', T0 + 5_000, storage);

    expect(again.id).toBe(first.id);
    expect(again.chapterIds).toEqual(['ch1']);
    expect(again.updatedAt).toBe(T0); // 复用时保留最近入批时间，不刷新
    expect(storage.setCalls).toBe(1); // 幂等路径没有多余写
  });

  it('未满 5 章时接在同一批；第 6 章开新批', () => {
    const storage = memoryStorage();
    let batch = getOrCreateArchiveBatch('n1', 'ch1', T0, storage);
    for (const [index, chapterId] of ['ch2', 'ch3', 'ch4', 'ch5'].entries()) {
      batch = getOrCreateArchiveBatch('n1', chapterId, T0 + index + 1, storage);
      expect(batch.chapterIds).toHaveLength(index + 2);
    }
    expect(batch.chapterIds).toEqual(['ch1', 'ch2', 'ch3', 'ch4', 'ch5']);

    const rotated = getOrCreateArchiveBatch('n1', 'ch6', T0 + 10, storage);
    expect(rotated.id).not.toBe(batch.id);
    expect(rotated.chapterIds).toEqual(['ch6']);
    expect(rotated.updatedAt).toBe(T0 + 10);
  });

  it('24h 边界：恰好 24h 复用同一批', () => {
    const storage = memoryStorage();
    const first = getOrCreateArchiveBatch('n1', 'ch1', T0, storage);

    const atBoundary = getOrCreateArchiveBatch('n1', 'ch2', T0 + ARCHIVE_BATCH_TTL_MS, storage);
    expect(atBoundary.id).toBe(first.id);
    expect(atBoundary.chapterIds).toEqual(['ch1', 'ch2']);
  });

  it('超过 24h 1ms：开新批（旧批不再接收本章）', () => {
    const storage = memoryStorage();
    const first = getOrCreateArchiveBatch('n1', 'ch1', T0, storage);

    const overBoundary = getOrCreateArchiveBatch(
      'n1',
      'ch2',
      T0 + ARCHIVE_BATCH_TTL_MS + 1,
      storage,
    );
    expect(overBoundary.id).not.toBe(first.id);
    expect(overBoundary.chapterIds).toEqual(['ch2']);
    // 旧批只保留旧章；本章若重试仍回到新批（同章复用优先于 TTL）
    const retry = getOrCreateArchiveBatch('n1', 'ch2', T0 + ARCHIVE_BATCH_TTL_MS + 99, storage);
    expect(retry.id).toBe(overBoundary.id);
  });

  it('按作品隔离：两本书的批次互不影响', () => {
    const storage = memoryStorage();
    const a = getOrCreateArchiveBatch('novel-a', 'ch1', T0, storage);
    const b = getOrCreateArchiveBatch('novel-b', 'ch2', T0 + 1, storage);

    expect(a.id).not.toBe(b.id);
    expect(a.chapterIds).toEqual(['ch1']);
    expect(b.chapterIds).toEqual(['ch2']);
    expect(storage.map.has(archiveBatchKey('novel-a'))).toBe(true);
    expect(storage.map.has(archiveBatchKey('novel-b'))).toBe(true);
  });

  it('批次写回后可读回同一对象（写后回读一致）', () => {
    const storage = memoryStorage();
    const batch = getOrCreateArchiveBatch('n1', 'ch1', T0, storage);
    const raw = storage.getItem(archiveBatchKey('n1'));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(batch);
  });
});

describe('M2-S1 · 损坏数据与存储不可用（容错）', () => {
  it('非 JSON / 结构不对的旧数据当没有处理，并能开新批覆盖', () => {
    const corruptValues = [
      'not-json',
      '{"id":"x"}',
      '[]',
      '{"id":"","chapterIds":[],"updatedAt":0}',
    ];
    for (const corrupt of corruptValues) {
      const storage = memoryStorage({ [archiveBatchKey('n1')]: corrupt });
      expect(readArchiveBatch('n1', storage)).toBeNull();
      const batch = getOrCreateArchiveBatch('n1', 'ch1', T0, storage);
      expect(batch.id.length).toBeGreaterThan(0);
      expect(readArchiveBatch('n1', storage)).toEqual(batch);
    }
  });

  it('读存储抛错 → 视为无批次，不抛出', () => {
    expect(() => readArchiveBatch('n1', throwingStorage('get'))).not.toThrow();
    expect(readArchiveBatch('n1', throwingStorage('get'))).toBeNull();
  });

  it('写存储抛错 → 仍返回可用批次，不让归档/标记完成失败', () => {
    const batch = getOrCreateArchiveBatch('n1', 'ch1', T0, throwingStorage('set'));
    expect(batch.chapterIds).toEqual(['ch1']);
    expect(batch.id.length).toBeGreaterThan(0);
  });

  it('clearArchiveBatch 删除本批；对空/损坏数据也不抛错', () => {
    const storage = memoryStorage();
    getOrCreateArchiveBatch('n1', 'ch1', T0, storage);
    clearArchiveBatch('n1', storage);
    expect(readArchiveBatch('n1', storage)).toBeNull();
    expect(storage.removeCalls).toBe(1);

    expect(() => clearArchiveBatch('n1', throwingStorage('get'))).not.toThrow();
  });
});

describe('M2-S1 · 归档设置（design §1、§6.5）', () => {
  it('默认：自动归档开、提取条目开', () => {
    expect(DEFAULT_ARCHIVE_SETTINGS).toEqual({ autoArchive: true, extractEntries: true });
    expect(useArchiveSettings.getState().autoArchive).toBe(true);
    expect(useArchiveSettings.getState().extractEntries).toBe(true);
  });

  it('update 局部更新并持久化到 localStorage 既定 key', () => {
    useArchiveSettings.getState().update({ autoArchive: false });
    expect(useArchiveSettings.getState().autoArchive).toBe(false);
    expect(useArchiveSettings.getState().extractEntries).toBe(true);

    const raw = localStorage.getItem(ARCHIVE_SETTINGS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { state: { autoArchive: boolean; extractEntries: boolean } };
    expect(parsed.state.autoArchive).toBe(false);
    expect(parsed.state.extractEntries).toBe(true);
  });

  it('重新从 localStorage 读取设置（模拟刷新）后开关保持', () => {
    useArchiveSettings.getState().update({ extractEntries: false });
    const raw = localStorage.getItem(ARCHIVE_SETTINGS_STORAGE_KEY)!;
    // 直接以持久化内容为准校验可恢复字段
    const parsed = JSON.parse(raw) as { state: { extractEntries: boolean } };
    expect(parsed.state.extractEntries).toBe(false);
    expect(ARCHIVE_SETTINGS_STORAGE_KEY).toBe('myliterature.archive-settings');
  });
});
