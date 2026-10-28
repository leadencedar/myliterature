/**
 * M2.1-S1 独立验收：归档待确认计数（pendingTotal）与伏笔流水审计。
 *
 * 独立于开发的 archiveChapter.test.ts / archiveAudit.test.ts：
 * - 服务集成（真实 Dexie 仓储 + 假 LlmRunner）：pendingTotal 口径、threads 返回、
 *   审计写入/同章覆盖/坏数据容错/失败不写；
 * - 审计单元（注入内存存储）：读写容错、7 天 prune、TTL 边界、写失败静默、clear。
 *
 * 关键纪律（design §1）：流水只是展示用数据，存 localStorage、不参与幂等/落库，
 * 丢失或损坏都不能影响归档结果与提案数据。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '@/data/dexie/db';
import { DexieNovelRepository } from '@/data/dexie/DexieNovelRepository';
import type { NovelRepository } from '@/data/NovelRepository';
import type { Category, Chapter, Novel } from '@/domain/schema';
import { LlmError } from '@/llm/errors';
import type { LlmRunner, StructuredRunOptions } from '@/llm/useLlm';
import type { TaskKind } from '@/llm/taskProfiles';
import {
  ARCHIVE_AUDIT_KEY_PREFIX,
  ARCHIVE_AUDIT_TTL_MS,
  archiveAuditKey,
  clearArchiveAudit,
  pruneArchiveAudit,
  readArchiveAudit,
  saveArchiveAudit,
  type ArchiveAuditChapter,
  type ArchiveAuditStorage,
} from '@/features/writing/archiveAudit';
import { archiveChapter, type ArchiveChapterInput } from '@/features/writing/archiveChapter';

let database: AppDatabase;
let repo: NovelRepository;
let novel: Novel;
let categories: Category[];
let characterCategory: Category;

beforeEach(async () => {
  database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  repo = new DexieNovelRepository(database);
  novel = await repo.createNovel({ title: '流水之书', genre: '悬疑' });
  categories = await repo.listCategories(novel.id);
  characterCategory = categories.find((category) => category.kind === 'character')!;
  localStorage.clear();
});

afterEach(async () => {
  database.close();
  await database.delete();
  localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- fixtures

interface LlmFixture {
  llm: LlmRunner;
  calls: { task: TaskKind; options: StructuredRunOptions<unknown> }[];
}

function fakeLlm(
  handler: (task: TaskKind, options: StructuredRunOptions<unknown>) => unknown,
): LlmFixture {
  const calls: { task: TaskKind; options: StructuredRunOptions<unknown> }[] = [];
  const llm = {
    configured: true,
    client: {} as unknown,
    runStructured: vi.fn(async (task: TaskKind, options: StructuredRunOptions<unknown>) => {
      calls.push({ task, options });
      return { data: await handler(task, options), attempts: 1 };
    }),
    runStream: vi.fn(),
    runProseWithTail: vi.fn(),
  } as unknown as LlmRunner;
  return { llm, calls };
}

function extractPayload(overrides: Record<string, unknown> = {}) {
  return {
    entries: [] as unknown[],
    summary: '本章摘要。',
    keyEvents: ['事件'],
    appearingEntries: [] as string[],
    newOpenThreads: ['新伏笔'],
    resolvedThreads: [] as string[],
    rollingSummary: '截至本章的进展。',
    ...overrides,
  };
}

function newCharacterEntry(title: string, identity: string) {
  return {
    categoryName: characterCategory.name,
    title,
    aliases: [],
    summary: `${title}的摘要。`,
    fields: [{ key: 'identity', value: identity }],
  };
}

async function makeChapter(title: string, index: number): Promise<Chapter> {
  const chapter = await repo.createChapter(novel.id, {
    title,
    content: `${title}的正文，足够用来归档。`,
  });
  if (chapter.index !== index) {
    // createChapter 按创建顺序自增 index；这里只用于断言审计里的「第 N 章」
    await repo.updateChapter(chapter.id, {});
  }
  return { ...chapter, index };
}

function inputFor(chapter: Chapter): ArchiveChapterInput {
  return {
    novel,
    chapter,
    chapters: [chapter],
    summaries: [],
    entries: [],
    categories,
    options: { extractEntries: true },
  };
}

/** 找出 localStorage 里所有审计 key（审计不认识 batchId 时用） */
function auditKeys(): string[] {
  const keys: string[] = [];
  for (let position = 0; position < localStorage.length; position += 1) {
    const key = localStorage.key(position);
    if (key?.startsWith(ARCHIVE_AUDIT_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

// ---------------------------------------------------------------- 服务集成

describe('M2.1-S1 · pendingTotal 与 threads', () => {
  it('一次归档：pendingTotal = 摘要 + 进展 + 条目；threads 返回并写入审计', async () => {
    const chapter = await makeChapter('第一章 雨夜', 1);
    const { llm } = fakeLlm(() =>
      extractPayload({
        entries: [newCharacterEntry('沈砚', '失忆剑客'), newCharacterEntry('裴照', '捕头')],
        newOpenThreads: ['旧簪来历', '青冥宗余党'],
        resolvedThreads: ['河灯旧案'],
      }),
    );

    const result = await archiveChapter({ repository: repo, llm }, inputFor(chapter));

    // 摘要 create + 进展 replace + 2 条条目 create = 4
    expect(result.pendingTotal).toBe(4);
    expect(result.pendingCount).toBe(2); // 旧口径：仅条目
    expect(result.threads).toEqual({
      opened: ['旧簪来历', '青冥宗余党'],
      resolved: ['河灯旧案'],
      open: ['旧簪来历', '青冥宗余党'],
    });

    const audit = readArchiveAudit(result.batchId);
    expect(audit.chapters).toHaveLength(1);
    const record = audit.chapters[0]!;
    expect(record.chapterId).toBe(chapter.id);
    expect(record.index).toBe(chapter.index);
    expect(record.title).toBe('第一章 雨夜');
    expect(record.opened).toEqual(['旧簪来历', '青冥宗余党']);
    expect(record.resolved).toEqual(['河灯旧案']);
    expect(record.open).toEqual(['旧簪来历', '青冥宗余党']);
    expect(typeof record.savedAt).toBe('number');
    // 只存 localStorage：键带固定前缀 + batchId
    expect(localStorage.getItem(archiveAuditKey(result.batchId))).not.toBeNull();
    expect(auditKeys()).toEqual([archiveAuditKey(result.batchId)]);
  });

  it('同批两章 pendingTotal 累计；审计每章一条；同章重跑原地替换不重复', async () => {
    const ch1 = await makeChapter('第一章', 1);
    const ch2 = await makeChapter('第二章', 2);
    let round = 0;
    const { llm } = fakeLlm((_task, options) => {
      round += 1;
      const isSecond = options.user.includes('第二章');
      return extractPayload({
        summary: isSecond ? '第二章摘要。' : '第一章摘要。',
        newOpenThreads: isSecond ? ['第二章新伏笔'] : ['第一章新伏笔'],
        resolvedThreads: isSecond ? ['第一章新伏笔'] : [],
      });
    });

    const first = await archiveChapter({ repository: repo, llm }, inputFor(ch1));
    expect(first.pendingTotal).toBe(2); // 摘要 + 进展
    const second = await archiveChapter({ repository: repo, llm }, inputFor(ch2));
    expect(second.batchId).toBe(first.batchId);
    // 摘要2 新增；进展 replace 就地更新不增加数量 → 3
    expect(second.pendingTotal).toBe(3);
    expect(readArchiveAudit(second.batchId).chapters).toHaveLength(2);

    // 同章重跑：摘要清旧建新（数量不变），审计仍 2 章（第一章被替换）
    await archiveChapter({ repository: repo, llm }, inputFor(ch1));
    expect(readArchiveAudit(first.batchId).chapters).toHaveLength(2);
    const ch1Audit = readArchiveAudit(first.batchId).chapters.find(
      (item) => item.chapterId === ch1.id,
    )!;
    expect(round).toBe(3);
    expect(ch1Audit.opened).toEqual(['第一章新伏笔']);
  });

  it('降级路径（extract 截断）也返回 threads 并写审计', async () => {
    const chapter = await makeChapter('降级章', 1);
    const { llm, calls } = fakeLlm((task) => {
      if (task === 'extract-settings') throw new LlmError('truncated', '模型输出被截断');
      return {
        summary: '降级摘要。',
        keyEvents: ['关键事件'],
        appearingEntries: [],
        newOpenThreads: ['降级新伏笔'],
        resolvedThreads: ['降级收束'],
        rollingSummary: '降级进展。',
      };
    });

    const result = await archiveChapter({ repository: repo, llm }, inputFor(chapter));

    expect(calls.map((call) => call.task)).toEqual(['extract-settings', 'chapter-summary']);
    expect(result.entriesDegraded).toBe(true);
    expect(result.threads).toEqual({
      opened: ['降级新伏笔'],
      resolved: ['降级收束'],
      open: ['降级新伏笔'],
    });
    const record = readArchiveAudit(result.batchId).chapters[0]!;
    expect(record.opened).toEqual(['降级新伏笔']);
    expect(record.resolved).toEqual(['降级收束']);
    expect(record.open).toEqual(['降级新伏笔']);
    expect(result.pendingTotal).toBe(2);
  });
});

describe('M2.1-S1 · 审计容错（不影响归档）', () => {
  it('审计数据损坏时归档照常成功，并覆盖成新流水', async () => {
    const chapter = await makeChapter('坏数据章', 1);
    const { llm } = fakeLlm(() => extractPayload());
    const first = await archiveChapter({ repository: repo, llm }, inputFor(chapter));
    expect(readArchiveAudit(first.batchId).chapters).toHaveLength(1);

    localStorage.setItem(archiveAuditKey(first.batchId), '{not-json');
    const second = await archiveChapter({ repository: repo, llm }, inputFor(chapter));

    expect(second.batchId).toBe(first.batchId);
    expect(second.pendingTotal).toBe(2);
    const repaired = readArchiveAudit(first.batchId);
    expect(repaired.chapters).toHaveLength(1);
    expect(repaired.chapters[0]!.chapterId).toBe(chapter.id);
  });

  it('localStorage 读取抛错时归档照常成功（写入静默/尽力）', async () => {
    const chapter = await makeChapter('存储异常章', 1);
    const { llm } = fakeLlm(() => extractPayload());
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: 存储被禁用');
    });
    try {
      const result = await archiveChapter({ repository: repo, llm }, inputFor(chapter));
      expect(result.pendingTotal).toBe(2);
      expect(await repo.listProposals(novel.id, { status: 'pending' })).toHaveLength(2);
    } finally {
      getItem.mockRestore();
    }
  });

  it('模型失败时不写任何审计、不写提案', async () => {
    const chapter = await makeChapter('失败章', 1);
    const { llm } = fakeLlm(() => {
      throw new LlmError('server', '归档服务不可用');
    });

    await expect(archiveChapter({ repository: repo, llm }, inputFor(chapter))).rejects.toThrow(
      '归档服务不可用',
    );
    expect(auditKeys()).toEqual([]);
    expect(await repo.listProposals(novel.id, { status: 'pending' })).toEqual([]);
  });

  it('审计写入失败（配额满）时归档照常成功', async () => {
    const chapter = await makeChapter('配额章', 1);
    const { llm } = fakeLlm(() => extractPayload());
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      const result = await archiveChapter({ repository: repo, llm }, inputFor(chapter));
      expect(result.pendingTotal).toBe(2);
      expect(await repo.listProposals(novel.id, { status: 'pending' })).toHaveLength(2);
    } finally {
      setItem.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- 审计单元

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  } satisfies ArchiveAuditStorage & { dump: () => Record<string, string> };
}

const T = 1_700_000_000_000;

function auditChapter(overrides: Partial<ArchiveAuditChapter> = {}): ArchiveAuditChapter {
  return {
    chapterId: 'ch-1',
    index: 1,
    title: '第一章',
    opened: ['新伏笔'],
    resolved: [],
    open: ['新伏笔'],
    savedAt: T,
    ...overrides,
  };
}

describe('M2.1-S1 · 审计单元：读写容错与 prune', () => {
  it('不存在/坏 JSON/结构不对时读回空清单', () => {
    const storage = memoryStorage({ x: '{}' });
    expect(readArchiveAudit('missing', { storage })).toEqual({ chapters: [] });

    storage.setItem(archiveAuditKey('bad'), '{bad');
    expect(readArchiveAudit('bad', { storage })).toEqual({ chapters: [] });

    storage.setItem(archiveAuditKey('shape'), JSON.stringify({ chapters: 'nope' }));
    expect(readArchiveAudit('shape', { storage })).toEqual({ chapters: [] });

    storage.setItem(archiveAuditKey('onebad'), JSON.stringify({ chapters: [{ chapterId: 1 }] }));
    expect(readArchiveAudit('onebad', { storage })).toEqual({ chapters: [] });
  });

  it('单章损坏只丢该章，其他章节仍可读', () => {
    const storage = memoryStorage();
    storage.setItem(
      archiveAuditKey('b1'),
      JSON.stringify({
        chapters: [auditChapter({ savedAt: Date.now() }), { chapterId: 'broken' }],
      }),
    );
    const audit = readArchiveAudit('b1', { storage });
    expect(audit.chapters).toHaveLength(1);
    expect(audit.chapters[0]!.chapterId).toBe('ch-1');
  });

  it('7 天边界：恰好 7 天保留，7 天 +1ms 清理并写回', () => {
    const storage = memoryStorage();
    saveArchiveAudit(
      'b1',
      {
        chapterId: 'ch-1',
        index: 1,
        title: '第一章',
        opened: [],
        resolved: [],
        open: [],
      },
      { storage, now: T },
    );
    expect(
      readArchiveAudit('b1', { storage, now: T + ARCHIVE_AUDIT_TTL_MS }).chapters,
    ).toHaveLength(1);

    const pruned = readArchiveAudit('b1', { storage, now: T + ARCHIVE_AUDIT_TTL_MS + 1 });
    expect(pruned.chapters).toEqual([]);
    // 全部过期时把 key 也删掉
    expect(storage.getItem(archiveAuditKey('b1'))).toBeNull();
  });

  it('只清过期章，保留新鲜章并写回', () => {
    const storage = memoryStorage();
    storage.setItem(
      archiveAuditKey('b1'),
      JSON.stringify({
        chapters: [
          auditChapter({ chapterId: 'old', savedAt: T - ARCHIVE_AUDIT_TTL_MS - 1 }),
          auditChapter({ chapterId: 'fresh', index: 2, savedAt: T }),
        ],
      }),
    );
    const audit = readArchiveAudit('b1', { storage, now: T });
    expect(audit.chapters.map((item) => item.chapterId)).toEqual(['fresh']);
    const written = JSON.parse(storage.getItem(archiveAuditKey('b1'))!) as {
      chapters: ArchiveAuditChapter[];
    };
    expect(written.chapters.map((item) => item.chapterId)).toEqual(['fresh']);
  });

  it('同章写入替换旧记录、其他章保留；savedAt 用注入时间', () => {
    const storage = memoryStorage();
    saveArchiveAudit(
      'b1',
      { chapterId: 'ch-1', index: 1, title: '第一章', opened: ['a'], resolved: [], open: ['a'] },
      { storage, now: T },
    );
    saveArchiveAudit(
      'b1',
      {
        chapterId: 'ch-2',
        index: 2,
        title: '第二章',
        opened: ['b'],
        resolved: [],
        open: ['a', 'b'],
      },
      { storage, now: T + 10 },
    );
    saveArchiveAudit(
      'b1',
      { chapterId: 'ch-1', index: 1, title: '第一章', opened: ['a2'], resolved: [], open: ['a2'] },
      { storage, now: T + 20 },
    );
    const audit = readArchiveAudit('b1', { storage, now: T + 20 });
    expect(audit.chapters.map((item) => item.chapterId)).toEqual(['ch-2', 'ch-1']);
    expect(audit.chapters.find((item) => item.chapterId === 'ch-1')!.opened).toEqual(['a2']);
    expect(audit.chapters.find((item) => item.chapterId === 'ch-1')!.savedAt).toBe(T + 20);
  });

  it('pruneArchiveAudit 纯函数不修改入参', () => {
    const audit = { chapters: [auditChapter(), auditChapter({ chapterId: 'old', savedAt: 0 })] };
    const pruned = pruneArchiveAudit(audit, T);
    expect(pruned.chapters).toHaveLength(1);
    expect(audit.chapters).toHaveLength(2);
  });

  it('写失败/读抛错时静默不抛；clear 删 key', () => {
    const throwing: ArchiveAuditStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readArchiveAudit('b1', { storage: throwing })).toEqual({ chapters: [] });
    expect(() =>
      saveArchiveAudit(
        'b1',
        { chapterId: 'ch', index: 1, title: '', opened: [], resolved: [], open: [] },
        { storage: throwing, now: T },
      ),
    ).not.toThrow();

    const storage = memoryStorage();
    saveArchiveAudit(
      'b1',
      { chapterId: 'ch', index: 1, title: '', opened: [], resolved: [], open: [] },
      { storage, now: T },
    );
    expect(storage.getItem(archiveAuditKey('b1'))).not.toBeNull();
    clearArchiveAudit('b1', storage);
    expect(storage.getItem(archiveAuditKey('b1'))).toBeNull();
  });
});
