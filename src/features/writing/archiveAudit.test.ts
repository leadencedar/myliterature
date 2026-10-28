import { beforeEach, describe, expect, it } from 'vitest';
import {
  ARCHIVE_AUDIT_KEY_PREFIX,
  ARCHIVE_AUDIT_TTL_MS,
  archiveAuditKey,
  clearArchiveAudit,
  pruneArchiveAudit,
  readArchiveAudit,
  saveArchiveAudit,
  type ArchiveAuditStorage,
} from './archiveAudit';

const BATCH = 'batch-1';

function memoryStorage(failWrites = false): ArchiveAuditStorage & {
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

function chapterInput(overrides: Partial<Parameters<typeof saveArchiveAudit>[1]> = {}) {
  return {
    chapterId: 'ch-1',
    index: 2,
    title: '第2章 雪夜',
    opened: ['阿越的身世'],
    resolved: ['刀的主人'],
    open: ['阿越的身世'],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('归档伏笔流水（localStorage）', () => {
  it('保存后可按 batchId 读回，结构含 savedAt', () => {
    saveArchiveAudit(BATCH, chapterInput(), { now: 1_000 });

    expect(archiveAuditKey(BATCH)).toBe(`${ARCHIVE_AUDIT_KEY_PREFIX}${BATCH}`);
    const audit = readArchiveAudit(BATCH, { now: 1_000 });
    expect(audit.chapters).toHaveLength(1);
    expect(audit.chapters[0]).toEqual({
      chapterId: 'ch-1',
      index: 2,
      title: '第2章 雪夜',
      opened: ['阿越的身世'],
      resolved: ['刀的主人'],
      open: ['阿越的身世'],
      savedAt: 1_000,
    });
  });

  it('同章重跑替换旧记录，其他章节保留', () => {
    saveArchiveAudit(BATCH, chapterInput(), { now: 1_000 });
    saveArchiveAudit(BATCH, chapterInput({ chapterId: 'ch-2', index: 3, title: '第3章 旧识' }), {
      now: 2_000,
    });
    saveArchiveAudit(BATCH, chapterInput({ opened: ['新的伏笔'], open: ['新的伏笔'] }), {
      now: 3_000,
    });

    const audit = readArchiveAudit(BATCH, { now: 3_000 });
    expect(audit.chapters).toHaveLength(2);
    const first = audit.chapters.find((chapter) => chapter.chapterId === 'ch-1')!;
    expect(first).toMatchObject({ opened: ['新的伏笔'], savedAt: 3_000 });
    expect(audit.chapters.find((chapter) => chapter.chapterId === 'ch-2')).toBeDefined();
  });

  it('不存在、坏 JSON、坏结构时返回空清单而不是抛错', () => {
    expect(readArchiveAudit(BATCH).chapters).toEqual([]);

    localStorage.setItem(archiveAuditKey(BATCH), '{not json');
    expect(readArchiveAudit(BATCH).chapters).toEqual([]);

    localStorage.setItem(archiveAuditKey(BATCH), JSON.stringify({ chapters: 'nope' }));
    expect(readArchiveAudit(BATCH).chapters).toEqual([]);

    // 顶层合法但单章损坏：丢弃坏章，不连累整批
    localStorage.setItem(
      archiveAuditKey(BATCH),
      JSON.stringify({
        chapters: [{ chapterId: 42 }, { ...chapterInput(), savedAt: 1_000 }],
      }),
    );
    expect(readArchiveAudit(BATCH, { now: 1_000 }).chapters).toHaveLength(1);
  });

  it('读取时 prune 超过 7 天的章节并写回存储', () => {
    saveArchiveAudit(BATCH, chapterInput({ chapterId: 'old' }), { now: 0 });
    saveArchiveAudit(BATCH, chapterInput({ chapterId: 'fresh' }), {
      now: ARCHIVE_AUDIT_TTL_MS,
    });
    expect(readArchiveAudit(BATCH, { now: ARCHIVE_AUDIT_TTL_MS }).chapters).toHaveLength(2);

    // 第 8 天：old 超期被清，fresh 还在（距写入 1ms）
    const pruned = readArchiveAudit(BATCH, { now: ARCHIVE_AUDIT_TTL_MS + 1 });
    expect(pruned.chapters.map((chapter) => chapter.chapterId)).toEqual(['fresh']);
    const raw = JSON.parse(localStorage.getItem(archiveAuditKey(BATCH))!) as {
      chapters: { chapterId: string }[];
    };
    expect(raw.chapters.map((chapter) => chapter.chapterId)).toEqual(['fresh']);

    // 再往后全部超期：清单为空并删 key
    expect(readArchiveAudit(BATCH, { now: ARCHIVE_AUDIT_TTL_MS * 2 + 2 }).chapters).toEqual([]);
    expect(localStorage.getItem(archiveAuditKey(BATCH))).toBeNull();
  });

  it('7 天边界：恰好 7 天保留，第 7 天 + 1ms 清理', () => {
    const audit = { chapters: [{ ...chapterInput(), savedAt: 0 }] };
    expect(pruneArchiveAudit(audit, ARCHIVE_AUDIT_TTL_MS).chapters).toHaveLength(1);
    expect(pruneArchiveAudit(audit, ARCHIVE_AUDIT_TTL_MS + 1).chapters).toHaveLength(0);
  });

  it('clear 只清本批流水', () => {
    saveArchiveAudit(BATCH, chapterInput());
    saveArchiveAudit('batch-2', chapterInput());

    clearArchiveAudit(BATCH);

    expect(readArchiveAudit(BATCH).chapters).toEqual([]);
    expect(readArchiveAudit('batch-2').chapters).toHaveLength(1);
  });

  it('存储不可写时静默失败，读取返回空', () => {
    const storage = memoryStorage(true);

    expect(() => saveArchiveAudit(BATCH, chapterInput(), { storage })).not.toThrow();
    expect(readArchiveAudit(BATCH, { storage }).chapters).toEqual([]);
  });

  it('可注入存储，按 batchId 隔离', () => {
    const storage = memoryStorage();
    saveArchiveAudit(BATCH, chapterInput(), { storage, now: 1_000 });
    saveArchiveAudit('batch-2', chapterInput({ chapterId: 'ch-9' }), { storage, now: 1_000 });

    expect(readArchiveAudit(BATCH, { storage, now: 1_000 }).chapters[0]!.chapterId).toBe('ch-1');
    expect(readArchiveAudit('batch-2', { storage, now: 1_000 }).chapters[0]!.chapterId).toBe(
      'ch-9',
    );
    clearArchiveAudit(BATCH, storage);
    expect(readArchiveAudit(BATCH, { storage }).chapters).toEqual([]);
  });
});
