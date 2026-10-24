import { describe, expect, it } from 'vitest';
import { upgradeLegacyImportJob } from './importJob';
import { ImportJobSchema, RepositorySnapshotSchema } from './schema';

const ARRAY_KEYS = ['drafts', 'chapters', 'worldviewChunks', 'entryDrafts', 'openThreads'] as const;

const legacyChapterState = {
  index: 1,
  title: '离乡',
  chapterId: 'c1',
  status: 'pending',
  error: '',
  translateStatus: 'pending',
  translateError: '',
};

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job1',
    novelId: 'n1',
    batchId: 'b1',
    entryDrafts: [],
    openThreads: [],
    rollingSummary: '',
    withSummaries: true,
    withStyle: true,
    status: 'paused',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe('旧任务换算', () => {
  it('旧 worldview 任务转成 worldview，并给每段补上 title', () => {
    const out = asRecord(
      upgradeLegacyImportJob(
        base({
          importType: 'worldview',
          worldviewText: '整篇设定',
          chapters: [],
          worldviewChunks: [
            { index: 1, content: '甲', status: 'done', error: '' },
            { index: 2, content: '乙', status: 'pending', error: '' },
          ],
        }),
      ),
    );
    expect(out.destination).toEqual({ kind: 'worldview' });
    expect(out.worldviewChunks).toEqual([
      { index: 1, title: '', content: '甲', status: 'done', error: '' },
      { index: 2, title: '', content: '乙', status: 'pending', error: '' },
    ]);
  });

  it('旧章节任务转成 main，各章翻译状态原样保留', () => {
    const out = asRecord(
      upgradeLegacyImportJob(base({ importType: 'chapter', chapters: [legacyChapterState] })),
    );
    expect(out.destination).toEqual({ kind: 'main' });
    expect(out.chapters).toEqual([legacyChapterState]);
  });

  it('没有 importType 但有章节的更旧的行也转成 main', () => {
    const out = asRecord(upgradeLegacyImportJob(base({ chapters: [legacyChapterState] })));
    expect(out.destination).toEqual({ kind: 'main' });
  });

  it('空的旧任务转成 destination null', () => {
    const out = asRecord(upgradeLegacyImportJob(base({ importType: 'chapter', chapters: [] })));
    expect(out.destination).toBeNull();
  });

  it('destination 为 null 或对象时都原样保留，不再换算', () => {
    const asNull = asRecord(
      upgradeLegacyImportJob(base({ destination: null, chapters: [legacyChapterState] })),
    );
    expect(asNull.destination).toBeNull();

    const side = { kind: 'side', sideStoryId: 's1' };
    const asSide = asRecord(
      upgradeLegacyImportJob(base({ destination: side, importType: 'worldview', chapters: [] })),
    );
    expect(asSide.destination).toEqual(side);
  });

  it('每个分支都删掉 importType 与 worldviewText', () => {
    for (const raw of [
      base({ importType: 'worldview', worldviewText: 'x', worldviewChunks: [] }),
      base({ importType: 'chapter', worldviewText: '', chapters: [legacyChapterState] }),
      base({ importType: 'chapter', worldviewText: '' }),
      base({ destination: null, importType: 'chapter', worldviewText: '' }),
    ]) {
      const out = asRecord(upgradeLegacyImportJob(raw));
      expect(out).not.toHaveProperty('importType');
      expect(out).not.toHaveProperty('worldviewText');
    }
  });

  it('其余字段原样保留', () => {
    const out = asRecord(upgradeLegacyImportJob(base({ rollingSummary: '进展', chapters: [] })));
    expect(out).toMatchObject({ id: 'job1', novelId: 'n1', batchId: 'b1', rollingSummary: '进展' });
  });

  it('不修改入参', () => {
    const raw = base({
      importType: 'worldview',
      worldviewText: '设定',
      worldviewChunks: [{ index: 1, content: '甲', status: 'pending', error: '' }],
    });
    const snapshot = JSON.parse(JSON.stringify(raw));
    const out = upgradeLegacyImportJob(raw);
    expect(raw).toEqual(snapshot);
    expect(out).not.toBe(raw);
  });
});

describe('全函数：任何输入都不抛错', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'job'],
    ['数字', 42],
    ['数组', [base()]],
  ])('非普通对象（%s）原样返回', (_name, raw) => {
    expect(() => upgradeLegacyImportJob(raw)).not.toThrow();
    expect(upgradeLegacyImportJob(raw)).toBe(raw);
  });

  it('缺少 worldviewChunks 的 worldview 行', () => {
    const raw = base({ importType: 'worldview' });
    expect(() => upgradeLegacyImportJob(raw)).not.toThrow();
    const out = asRecord(upgradeLegacyImportJob(raw));
    expect(out.destination).toEqual({ kind: 'worldview' });
    expect(out.worldviewChunks).toEqual([]);
  });

  it('既没有 importType 也没有 chapters 的行', () => {
    const raw = { id: 'job1', novelId: 'n1' };
    expect(() => upgradeLegacyImportJob(raw)).not.toThrow();
    expect(asRecord(upgradeLegacyImportJob(raw)).destination).toBeNull();
  });

  it('chapters 不是数组', () => {
    const raw = base({ importType: 'chapter', chapters: 'oops' });
    expect(() => upgradeLegacyImportJob(raw)).not.toThrow();
    const out = asRecord(upgradeLegacyImportJob(raw));
    expect(out.chapters).toEqual([]);
    expect(out.destination).toBeNull();
  });

  it('worldviewChunks 里有非对象元素时原样保留', () => {
    const raw = base({
      importType: 'worldview',
      worldviewChunks: [null, 'x', 3, [1], { index: 1, content: '甲' }],
    });
    expect(() => upgradeLegacyImportJob(raw)).not.toThrow();
    expect(asRecord(upgradeLegacyImportJob(raw)).worldviewChunks).toEqual([
      null,
      'x',
      3,
      [1],
      { index: 1, content: '甲', title: '' },
    ]);
  });
});

describe('补齐形状', () => {
  it.each([
    ['旧 main 行', { id: 'j', importType: 'chapter', chapters: [legacyChapterState] }],
    ['旧 worldview 行', { id: 'j', importType: 'worldview', worldviewChunks: [] }],
    ['空的旧行', { id: 'j' }],
    ['已有 destination 但缺 drafts 的行', { id: 'j', destination: { kind: 'main' }, chapters: [] }],
  ])('%s 输出五个数组键', (_name, raw) => {
    const out = asRecord(upgradeLegacyImportJob(raw));
    for (const key of ARRAY_KEYS) expect(Array.isArray(out[key])).toBe(true);
    expect(out).not.toHaveProperty('importType');
    expect(out).not.toHaveProperty('worldviewText');
  });

  it('已有的数组原样带过去', () => {
    const drafts = [{ index: 1, content: '甲' }];
    const out = asRecord(upgradeLegacyImportJob({ id: 'j', destination: null, drafts }));
    expect(out.drafts).toEqual(drafts);
  });
});

describe('ImportJobSchema 接上 preprocess', () => {
  it('旧备份里的进行中任务经 preprocess 后能解析：世界观、章节两种', () => {
    const worldview = ImportJobSchema.parse(
      base({
        importType: 'worldview',
        worldviewText: '整篇设定',
        worldviewChunks: [{ index: 1, content: '归墟在极北。', status: 'pending', error: '' }],
        chapters: [],
      }),
    );
    expect(worldview.destination).toEqual({ kind: 'worldview' });
    expect(worldview.worldviewChunks[0]?.title).toBe('');
    expect(worldview.drafts).toEqual([]);
    expect(worldview).not.toHaveProperty('importType');
    expect(worldview).not.toHaveProperty('worldviewText');

    const main = ImportJobSchema.parse(
      base({ importType: 'chapter', chapters: [legacyChapterState] }),
    );
    expect(main.destination).toEqual({ kind: 'main' });
    // 旧版的翻译状态原样保留，面板据此给出「旧版任务」说明
    expect(main.chapters[0]?.translateStatus).toBe('pending');
  });

  it('RepositorySnapshotSchema 的 importJobs 仍可解析旧备份里的进行中任务', () => {
    const parsed = RepositorySnapshotSchema.parse({
      novels: [{ id: 'n1', title: '书', createdAt: 0, updatedAt: 0 }],
      importJobs: [
        base({ importType: 'chapter', worldviewText: '', chapters: [legacyChapterState] }),
      ],
    });
    expect(parsed.importJobs).toHaveLength(1);
    expect(parsed.importJobs[0]?.destination).toEqual({ kind: 'main' });
    expect(parsed.importJobs[0]).not.toHaveProperty('importType');
  });

  it('destination 不认识时 parse 失败（交给面板清掉），不会抛出未捕获异常', () => {
    expect(ImportJobSchema.safeParse(base({ destination: { kind: 'bogus' } })).success).toBe(false);
    expect(ImportJobSchema.safeParse(null).success).toBe(false);
  });
});
