import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '@/data/dexie/db';
import { DexieNovelRepository } from '@/data/dexie/DexieNovelRepository';
import { emptyDelta } from '@/domain/schema';
import {
  BACKUP_VERSION,
  BackupError,
  buildBackupFile,
  exportBackup,
  parseBackup,
  restoreBackup,
  serializeBackup,
  summarizeBackup,
} from './backup';
import { REMIND_AFTER_WORDS, REMIND_INTERVAL_MS, shouldRemindBackup } from './backupReminder';

let database: AppDatabase;
let repo: DexieNovelRepository;

beforeEach(async () => {
  database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  repo = new DexieNovelRepository(database);
});

afterEach(async () => {
  database.close();
  await database.delete();
});

/** 造一本内容比较全的书，用于往返一致性检查 */
async function seedNovel() {
  const novel = await repo.createNovel({ title: '归墟纪', genre: '仙侠', oneLiner: '寻母。' });
  const categories = await repo.listCategories(novel.id);
  const entry = await repo.createEntry(novel.id, {
    categoryId: categories[1]!.id,
    title: '沈砚',
    aliases: ['砚哥'],
    summary: '寻母的少年',
    fields: { identity: '十七岁' },
    pinned: true,
  });
  const deleted = await repo.createEntry(novel.id, {
    categoryId: categories[1]!.id,
    title: '废弃条目',
  });
  await repo.softDeleteEntry(deleted.id);

  const volume = await repo.createOutlineNode(novel.id, { title: '第一卷' });
  await repo.createOutlineNode(novel.id, { title: '第1章', parentId: volume.id });

  const chapter = await repo.createChapter(novel.id, {
    title: '离乡',
    content: '天还没亮。',
    status: 'done',
  });
  await repo.upsertSummary(novel.id, chapter.id, {
    summary: '沈砚离乡。',
    keyEvents: ['离乡'],
    openThreads: ['玉佩的来历'],
  });
  await repo.upsertStyleProfile(novel.id, { tradition: 'literary', subGenre: '' });
  await repo.upsertPlan(novel.id, { mode: 'wordsPerDay', target: 3000 });
  await repo.addDailyProgress(novel.id, '2026-03-05', { words: 1200, chaptersCompleted: 1 });
  await repo.upsertImportJob(novel.id, { rollingSummary: '跑到第一章' });
  await repo.mergeGlossaryTerms(novel.id, [{ source: 'Ashford', target: '阿什福德' }]);
  const norm = await repo.createWritingNorm(novel.id, {
    title: '使用提示',
    content: '\n## 写作规则\n\n- 以本作当前时期为准。\n',
    scopes: ['writing', 'check'],
  });

  return { novel, entry, chapter, norm };
}

describe('导出快照', () => {
  it('覆盖全部表，且包含软删除的条目', async () => {
    const { novel } = await seedNovel();
    const snapshot = await repo.exportSnapshot();

    expect(snapshot.novels.map((item) => item.id)).toEqual([novel.id]);
    expect(snapshot.categories).toHaveLength(2);
    // 回收站里的条目也要带走，否则恢复后它凭空清空了
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries.some((item) => item.deletedAt !== null)).toBe(true);
    expect(snapshot.outlineNodes).toHaveLength(2);
    expect(snapshot.chapters).toHaveLength(1);
    expect(snapshot.chapterSummaries).toHaveLength(1);
    expect(snapshot.styleProfiles).toHaveLength(1);
    expect(snapshot.plans).toHaveLength(1);
    expect(snapshot.dailyLogs).toHaveLength(1);
    expect(snapshot.importJobs).toHaveLength(1);
    expect(snapshot.glossaries).toHaveLength(1);
    expect(snapshot.writingNorms).toHaveLength(1);
  });

  it('备份文件不含任何密钥字段', async () => {
    await seedNovel();
    const { text } = await exportBackup(repo);
    // 快照 schema 本身就不收集设置，这里从成品文件再确认一次
    expect(text).not.toMatch(/apiKey/u);
    expect(text).not.toMatch(/sk-/u);
    expect(Object.keys(JSON.parse(text))).toEqual(['app', 'version', 'exportedAt', 'data']);
  });

  it('文件头带应用标识与版本', async () => {
    const { file } = await exportBackup(repo, 1_700_000_000_000);
    expect(file).toMatchObject({
      app: 'myliterature',
      version: BACKUP_VERSION,
      exportedAt: 1_700_000_000_000,
    });
  });

  it('摘要统计可直接展示给用户', async () => {
    await seedNovel();
    const { file } = await exportBackup(repo);
    expect(summarizeBackup(file)).toMatchObject({
      novels: 1,
      chapters: 1,
      words: 5,
      entries: 2,
    });
  });
});

describe('解析备份文件', () => {
  it('不是 JSON 时提示可能选错了文件', () => {
    expect(() => parseBackup('这不是 json')).toThrow(BackupError);
    expect(() => parseBackup('这不是 json')).toThrow(/可能选错了文件/u);
  });

  it('不是本应用的备份时拒绝', () => {
    const foreign = JSON.stringify({ app: 'other', version: 1, exportedAt: 0, data: {} });
    expect(() => parseBackup(foreign)).toThrow(/不符合预期/u);
  });

  it('来自更新版本时明确说明读不了', () => {
    const future = JSON.stringify({
      app: 'myliterature',
      version: BACKUP_VERSION + 1,
      exportedAt: 0,
      data: {},
    });
    expect(() => parseBackup(future)).toThrow(/更新版本/u);
  });

  it('实体内容非法时逐条校验拦下', () => {
    const broken = JSON.stringify({
      app: 'myliterature',
      version: 1,
      exportedAt: 0,
      // title 缺失，Novel schema 应当拒绝
      data: { novels: [{ id: 'n1', createdAt: 0, updatedAt: 0 }] },
    });
    expect(() => parseBackup(broken)).toThrow(/不符合预期/u);
  });

  it('缺省的表补成空数组，不必手写完整结构', () => {
    const minimal = JSON.stringify({ app: 'myliterature', version: 1, exportedAt: 0, data: {} });
    expect(parseBackup(minimal).data.novels).toEqual([]);
  });

  it('当前文件版本为 4（加入互动推演）', () => {
    expect(BACKUP_VERSION).toBe(4);
  });

  it('版本 5 且正文里有不认识的枚举值时，报的仍是「来自更新版本」', () => {
    const future = JSON.stringify({
      app: 'myliterature',
      version: 5,
      exportedAt: 0,
      data: {
        novels: [{ id: 'n1', title: '书', createdAt: 0, updatedAt: 0, status: 'archived' }],
        proposals: [
          {
            id: 'p1',
            novelId: 'n1',
            origin: 'extract',
            target: 'somethingNew',
            action: 'replace',
            payload: {},
            createdAt: 0,
          },
        ],
        unknownTable: [{ id: 'x' }],
      },
    });
    expect(() => parseBackup(future)).toThrow(/更新版本/u);
    expect(() => parseBackup(future)).not.toThrow(/不符合预期/u);
  });

  it('文件头不对时沿用「不符合预期」的文案', () => {
    const noVersion = JSON.stringify({ app: 'myliterature', exportedAt: 0, data: {} });
    expect(() => parseBackup(noVersion)).toThrow(/不符合预期/u);
  });

  it('外传章节指向不存在的外传时被拒，并给出路径', () => {
    const dangling = JSON.stringify({
      app: 'myliterature',
      version: 2,
      exportedAt: 0,
      data: {
        novels: [{ id: 'n1', title: '书', createdAt: 0, updatedAt: 0 }],
        chapters: [
          { id: 'c1', novelId: 'n1', index: 1, sideStoryId: 'ghost', createdAt: 0, updatedAt: 0 },
        ],
      },
    });
    try {
      parseBackup(dangling);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).detail).toBe('data.chapters.0.sideStoryId：找不到所属外传');
    }
  });
});

describe('外传与旧版本备份', () => {
  it('v1 文件能恢复，章节全部成为主线', async () => {
    const v1 = JSON.stringify({
      app: 'myliterature',
      version: 1,
      exportedAt: 0,
      data: {
        novels: [{ id: 'n1', title: '旧书', createdAt: 0, updatedAt: 0 }],
        chapters: [
          { id: 'c1', novelId: 'n1', index: 1, content: '一', createdAt: 0, updatedAt: 0 },
          { id: 'c2', novelId: 'n1', index: 2, content: '二', createdAt: 0, updatedAt: 0 },
        ],
      },
    });

    await restoreBackup(repo, parseBackup(v1), 'replace');

    const chapters = await repo.listChapters('n1');
    expect(chapters.map((c) => c.sideStoryId)).toEqual([null, null]);
    expect(await repo.listSideStories('n1')).toEqual([]);
    expect((await repo.getNovelStats('n1')).chapterCount).toBe(2);
  });

  it('外传往返完整：外传本身、外传章节与其摘要都在', async () => {
    const { novel } = await seedNovel();
    const side = await repo.createSideStory(novel.id, {
      title: '青冥旧事',
      synopsis: '二十年前。',
    });
    await repo.updateSideStory(side.id, { rollingSummary: '师父下山。' });
    const sideChapter = await repo.createChapter(novel.id, {
      sideStoryId: side.id,
      content: '那年雪大。',
    });
    await repo.upsertSummary(novel.id, sideChapter.id, { summary: '雪夜。' });
    const before = await repo.exportSnapshot();
    expect(before.sideStories).toHaveLength(1);

    const text = serializeBackup(buildBackupFile(before, Date.now()));
    const fresh = new AppDatabase(`test-${crypto.randomUUID()}`);
    await fresh.open();
    const freshRepo = new DexieNovelRepository(fresh);

    await restoreBackup(freshRepo, parseBackup(text), 'replace');

    expect(await freshRepo.exportSnapshot()).toEqual(before);
    expect((await freshRepo.getSideStory(side.id))?.rollingSummary).toBe('师父下山。');
    const restored = await freshRepo.getChapter(sideChapter.id);
    expect(restored).toMatchObject({ sideStoryId: side.id, index: 1 });
    expect((await freshRepo.getSummaryByChapter(sideChapter.id))?.summary).toBe('雪夜。');

    fresh.close();
    await fresh.delete();
  });
});

describe('写作规范与旧版本备份', () => {
  const v1Text = JSON.stringify({
    app: 'myliterature',
    version: 1,
    exportedAt: 0,
    // v1 没有 sideStories，也没有 writingNorms
    data: {
      novels: [{ id: 'n1', title: '旧书', createdAt: 0, updatedAt: 0 }],
      chapters: [
        { id: 'c1', novelId: 'n1', index: 1, content: '一', createdAt: 0, updatedAt: 0 },
        { id: 'c2', novelId: 'n1', index: 2, content: '二', createdAt: 0, updatedAt: 0 },
      ],
    },
  });

  const v2Text = JSON.stringify({
    app: 'myliterature',
    version: 2,
    exportedAt: 0,
    // v2 有外传，没有 writingNorms
    data: {
      novels: [{ id: 'n1', title: '旧书', createdAt: 0, updatedAt: 0 }],
      sideStories: [{ id: 's1', novelId: 'n1', title: '青冥旧事', createdAt: 0, updatedAt: 0 }],
      chapters: [
        { id: 'c1', novelId: 'n1', index: 1, content: '主线', createdAt: 0, updatedAt: 0 },
        {
          id: 'c2',
          novelId: 'n1',
          index: 1,
          content: '外传',
          sideStoryId: 's1',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    },
  });

  for (const mode of ['replace', 'merge'] as const) {
    it(`v1 文件${mode === 'replace' ? '覆盖恢复' : '合并导入'}：规范为空，其余照旧`, async () => {
      const kept = await repo.createNovel({ title: '本机原有的书' });

      await restoreBackup(repo, parseBackup(v1Text), mode);

      expect(await repo.listWritingNorms('n1')).toEqual([]);
      expect((await repo.getNovel('n1'))?.title).toBe('旧书');
      expect((await repo.listChapters('n1')).map((c) => [c.content, c.sideStoryId])).toEqual([
        ['一', null],
        ['二', null],
      ]);
      expect(await repo.getNovel(kept.id)).toEqual(mode === 'merge' ? kept : undefined);
    });

    it(`v2 文件${mode === 'replace' ? '覆盖恢复' : '合并导入'}：外传照旧，规范为空`, async () => {
      const kept = await repo.createNovel({ title: '本机原有的书' });

      await restoreBackup(repo, parseBackup(v2Text), mode);

      expect(await repo.listWritingNorms('n1')).toEqual([]);
      expect((await repo.listSideStories('n1')).map((s) => s.title)).toEqual(['青冥旧事']);
      expect((await repo.getChapter('c2'))?.sideStoryId).toBe('s1');
      expect((await repo.getNovelStats('n1')).chapterCount).toBe(1);
      expect(await repo.getNovel(kept.id)).toEqual(mode === 'merge' ? kept : undefined);
    });
  }

  it('新备份的版本为 4 且带上写作规范', async () => {
    const { norm } = await seedNovel();
    const { file, text } = await exportBackup(repo);

    expect(file.version).toBe(4);
    expect(file.data.writingNorms).toEqual([norm]);
    expect(parseBackup(text).data.writingNorms).toEqual([norm]);
  });

  const validNorm = {
    id: 'w1',
    novelId: 'n1',
    title: '使用提示',
    content: '正文',
    createdAt: 0,
    updatedAt: 0,
  };

  for (const [label, patch, path] of [
    ['标题为空', { title: '' }, 'data.writingNorms.0.title'],
    ['正文只有空白', { content: '  \n ' }, 'data.writingNorms.0.content'],
    ['作用范围含非法值', { scopes: ['translate'] }, 'data.writingNorms.0.scopes'],
  ] as const) {
    it(`规范${label}时整份被拒，库里不变`, async () => {
      await seedNovel();
      const before = await repo.exportSnapshot();
      const text = JSON.stringify({
        app: 'myliterature',
        version: 3,
        exportedAt: 0,
        data: {
          novels: [{ id: 'n1', title: '书', createdAt: 0, updatedAt: 0 }],
          writingNorms: [{ ...validNorm, ...patch }],
        },
      });

      let caught: unknown;
      try {
        await restoreBackup(repo, parseBackup(text), 'replace');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BackupError);
      expect((caught as BackupError).detail?.startsWith(path)).toBe(true);
      expect(await repo.exportSnapshot()).toEqual(before);
    });
  }
});

describe('往返一致性', () => {
  it('导出再导入，全部数据逐字段相同', async () => {
    const { novel, entry, chapter, norm } = await seedNovel();
    const before = await repo.exportSnapshot();
    const text = serializeBackup(buildBackupFile(before, Date.now()));

    // 换一个空库模拟「清过浏览器数据的新设备」
    const fresh = new AppDatabase(`test-${crypto.randomUUID()}`);
    await fresh.open();
    const freshRepo = new DexieNovelRepository(fresh);

    await restoreBackup(freshRepo, parseBackup(text), 'replace');

    const after = await freshRepo.exportSnapshot();
    expect(after).toEqual(before);

    // 通过正常读接口也能拿到
    expect((await freshRepo.getNovel(novel.id))?.title).toBe('归墟纪');
    expect((await freshRepo.getEntry(entry.id))?.aliases).toEqual(['砚哥']);
    expect((await freshRepo.getChapter(chapter.id))?.content).toBe('天还没亮。');
    expect(await freshRepo.listEntries(novel.id)).toHaveLength(1);
    expect((await freshRepo.getSummaryByChapter(chapter.id))?.openThreads).toEqual(['玉佩的来历']);
    expect((await freshRepo.getPlan(novel.id))?.target).toBe(3000);
    expect((await freshRepo.getImportJob(novel.id))?.rollingSummary).toBe('跑到第一章');
    // 译名表必须跟着备份走，否则换设备后同一个人名会换译法
    expect((await freshRepo.getGlossary(novel.id))?.terms).toEqual([
      { source: 'Ashford', target: '阿什福德' },
    ]);
    // 规范原文连首尾空白都要原样回来
    expect(await freshRepo.listWritingNorms(novel.id)).toEqual([norm]);

    fresh.close();
    await fresh.delete();
  });

  it('覆盖恢复会清掉目标库里原有的作品', async () => {
    const { novel } = await seedNovel();
    const snapshot = await repo.exportSnapshot();

    const other = new AppDatabase(`test-${crypto.randomUUID()}`);
    await other.open();
    const otherRepo = new DexieNovelRepository(other);
    const doomed = await otherRepo.createNovel({ title: '会被覆盖掉的书' });

    await otherRepo.importSnapshot(snapshot, 'replace');

    expect(await otherRepo.getNovel(doomed.id)).toBeUndefined();
    expect((await otherRepo.getNovel(novel.id))?.title).toBe('归墟纪');

    other.close();
    await other.delete();
  });

  it('合并导入保留现有作品', async () => {
    const { novel } = await seedNovel();
    const snapshot = await repo.exportSnapshot();

    const other = new AppDatabase(`test-${crypto.randomUUID()}`);
    await other.open();
    const otherRepo = new DexieNovelRepository(other);
    const kept = await otherRepo.createNovel({ title: '本机原有的书' });

    await otherRepo.importSnapshot(snapshot, 'merge');

    expect((await otherRepo.getNovel(kept.id))?.title).toBe('本机原有的书');
    expect((await otherRepo.getNovel(novel.id))?.title).toBe('归墟纪');
    expect(await otherRepo.listNovels()).toHaveLength(2);

    other.close();
    await other.delete();
  });

  it('合并导入时 id 相同的记录以备份为准', async () => {
    const { novel } = await seedNovel();
    const snapshot = await repo.exportSnapshot();

    await repo.updateNovel(novel.id, { title: '被本机改过的名字' });
    await repo.importSnapshot(snapshot, 'merge');

    expect((await repo.getNovel(novel.id))?.title).toBe('归墟纪');
  });

  it('导入前整份重新校验，坏数据不会落库', async () => {
    const { novel } = await seedNovel();
    const snapshot = await repo.exportSnapshot();
    const broken = {
      ...snapshot,
      chapters: [{ ...snapshot.chapters[0]!, index: -1 }],
    };

    await expect(repo.importSnapshot(broken, 'replace')).rejects.toThrow();
    // 事务失败后原有数据还在
    expect((await repo.getNovel(novel.id))?.title).toBe('归墟纪');
  });
});

describe('备份提醒', () => {
  const never = { lastBackupAt: null, dismissedAt: null };
  const now = 1_700_000_000_000;

  it('字数不够时不提醒 —— 太早提醒会被当成噪音', () => {
    expect(shouldRemindBackup(never, REMIND_AFTER_WORDS - 1, now)).toBe(false);
    expect(shouldRemindBackup(never, REMIND_AFTER_WORDS, now)).toBe(true);
  });

  it('刚备份过就不提醒', () => {
    expect(shouldRemindBackup({ lastBackupAt: now - 1000, dismissedAt: null }, 50_000, now)).toBe(
      false,
    );
  });

  it('距上次备份超过间隔又会提醒', () => {
    expect(
      shouldRemindBackup(
        { lastBackupAt: now - REMIND_INTERVAL_MS - 1, dismissedAt: null },
        50_000,
        now,
      ),
    ).toBe(true);
  });

  it('点过「以后再说」就安静一段时间', () => {
    expect(shouldRemindBackup({ lastBackupAt: null, dismissedAt: now - 1000 }, 50_000, now)).toBe(
      false,
    );
    expect(
      shouldRemindBackup(
        { lastBackupAt: null, dismissedAt: now - REMIND_INTERVAL_MS - 1 },
        50_000,
        now,
      ),
    ).toBe(true);
  });
});

// ================================================================ 互动推演（备份 v4）

describe('互动推演与备份 v4', () => {
  /** 带推演、多分支、差异、限定条目、锁定覆盖与沉淀溯源的种子数据 */
  async function seedScenario() {
    const { novel } = await seedNovel();
    const [, char] = await repo.listCategories(novel.id);
    const peizhao = await repo.createEntry(novel.id, {
      categoryId: char!.id,
      title: '裴照',
      fields: { identity: '捕快' },
    });
    const scenario = await repo.createScenario(novel.id, {
      title: '雾中渡',
      setup: {
        cast: [{ entryId: '' }],
        start: { time: '', place: '渡口', situation: '醒来' },
        goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
        milestones: [{ id: 'm1', description: '找到空船' }],
        tone: '',
        expectedSteps: 30,
      },
      newOc: { categoryId: char!.id, title: '阿七', fields: { identity: '孤儿' } },
    });
    const base = {
      challenge: '船在下沉',
      delta: emptyDelta(),
      notices: [],
      progress: { reachedMilestoneIds: [], note: '' },
      ending: null,
    };
    const opts = (...texts: string[]) =>
      texts.map((text, i) => ({
        id: `${text}-${i}`,
        text,
        tendency: 'bold' as const,
        risk: 'low' as const,
        batch: 0,
      }));
    const { node: root } = await repo.appendScenarioNode(scenario.id, {
      ...base,
      parentId: null,
      arrivedBy: { kind: 'start' },
      plot: '雾',
      options: opts('拔刀', '跳江'),
    });
    const { node: a } = await repo.appendScenarioNode(scenario.id, {
      ...base,
      parentId: root.id,
      arrivedBy: { kind: 'option', optionId: root.options[0]!.id, text: '拔刀' },
      plot: '刀光',
      options: opts('追上', '后退'),
      delta: {
        ...emptyDelta(),
        fieldOverrides: [
          { target: { kind: 'world', entryId: peizhao.id }, fieldKey: 'identity', value: '叛徒' },
        ],
        lineEntries: [
          {
            localId: 'y',
            categoryId: char!.id,
            title: '老周',
            summary: '',
            fields: { identity: '掌柜' },
            promotedEntryId: null,
          },
        ],
      },
    });
    const { node: b } = await repo.appendScenarioNode(scenario.id, {
      ...base,
      parentId: root.id,
      arrivedBy: { kind: 'free', text: '喊船夫' },
      plot: '无人应答',
      options: opts('等候', '离开'),
    });
    // 锁定覆盖：覆盖存下之后作者把这一栏改成了底层设定
    await repo.updateEntry(peizhao.id, { fieldLocks: { identity: 'locked' } });
    await repo.createEntry(novel.id, {
      categoryId: char!.id,
      title: '老艄公',
      scope: {
        kind: 'limited',
        targets: [{ scenarioId: scenario.id, fromNodeId: a.id, revealHint: '过江后' }],
      },
    });
    await repo.commitScenarioOutline(novel.id, {
      scenarioId: scenario.id,
      mode: 'main',
      volumes: [
        {
          title: '雾卷',
          synopsis: '',
          targetWords: null,
          chapters: [
            {
              title: '雾章',
              synopsis: '',
              targetWords: null,
              linkedEntryIds: [],
              nodeIds: [root.id],
            },
          ],
        },
      ],
    });
    await repo.commitScenarioOutline(novel.id, {
      scenarioId: scenario.id,
      mode: 'side',
      appendToSideStoryId: null,
      title: '呼喊',
      synopsis: '另一条路',
      forkNodeId: root.id,
      chapters: [{ title: '外一', nodeIds: [b.id], brief: '细纲' }],
    });
    return { novel, scenario, root, a, b };
  }

  for (const mode of ['replace', 'merge'] as const) {
    it(`往返（${mode === 'replace' ? '覆盖恢复' : '合并导入'}）：推演、节点、限定条目、溯源逐字段相同`, async () => {
      await seedScenario();
      const before = await repo.exportSnapshot();
      expect(before.scenarios).toHaveLength(1);
      expect(before.scenarioNodes).toHaveLength(3);
      const text = serializeBackup(buildBackupFile(before, 0));
      const fresh = new AppDatabase(`test-${crypto.randomUUID()}`);
      await fresh.open();
      const freshRepo = new DexieNovelRepository(fresh);
      await restoreBackup(freshRepo, parseBackup(text), mode);
      const after = await freshRepo.exportSnapshot();
      expect(after).toEqual(before);
      fresh.close();
      await fresh.delete();
    });
  }

  const legacyNovel = { id: 'n1', title: '旧书', createdAt: 0, updatedAt: 0 };
  const legacyData = {
    novels: [legacyNovel],
    entries: [
      { id: 'e1', novelId: 'n1', categoryId: 'c', title: '裴照', createdAt: 0, updatedAt: 0 },
    ],
    outlineNodes: [{ id: 'o1', novelId: 'n1', title: '卷', createdAt: 0, updatedAt: 0 }],
    sideStories: [{ id: 's1', novelId: 'n1', title: '青冥旧事', createdAt: 0, updatedAt: 0 }],
    chapters: [
      { id: 'c1', novelId: 'n1', index: 1, content: '主线', createdAt: 0, updatedAt: 0 },
      {
        id: 'c2',
        novelId: 'n1',
        index: 1,
        content: '外传',
        sideStoryId: 's1',
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  };
  const normRow = (id: string, scopes: string[]) => ({
    id,
    novelId: 'n1',
    title: id,
    content: '正文',
    scopes,
    createdAt: 0,
    updatedAt: 0,
  });
  const FIVE = ['writing', 'planning', 'summary', 'extract', 'check'];
  const SIX = [...FIVE, 'interactive'];

  for (const version of [1, 2, 3] as const) {
    for (const mode of ['replace', 'merge'] as const) {
      it(`v${version} 文件${mode === 'replace' ? '覆盖恢复' : '合并导入'}：推演为空、条目通用、溯源为 null`, async () => {
        const data =
          version === 1
            ? {
                novels: legacyData.novels,
                entries: legacyData.entries,
                outlineNodes: legacyData.outlineNodes,
                chapters: [legacyData.chapters[0]],
              }
            : version === 2
              ? legacyData
              : {
                  ...legacyData,
                  writingNorms: [
                    normRow('full', ['check', ...FIVE.slice(0, 4)]),
                    normRow('narrow', ['writing']),
                  ],
                };
        const text = JSON.stringify({ app: 'myliterature', version, exportedAt: 0, data });
        await restoreBackup(repo, parseBackup(text), mode);
        expect(await repo.listScenarios('n1')).toEqual([]);
        expect((await repo.getEntry('e1'))?.scope).toEqual({ kind: 'universal' });
        expect((await repo.getEntry('e1'))?.fieldLocks).toEqual({});
        expect((await repo.listOutline('n1')).map((n) => n.scenarioSource)).toEqual([null]);
        for (const chapter of await repo.listChapters('n1'))
          expect(chapter.scenarioSource).toBeNull();
        for (const story of await repo.listSideStories('n1'))
          expect(story.scenarioSource).toBeNull();
        if (version === 3) {
          const norms = new Map((await repo.listWritingNorms('n1')).map((n) => [n.id, n.scopes]));
          expect(norms.get('full')).toEqual(SIX);
          expect(norms.get('narrow')).toEqual(['writing']);
        }
      });
    }
  }

  it('v4 文件里五项的规范保持五项（作者主动去掉了互动推演）', () => {
    const text = JSON.stringify({
      app: 'myliterature',
      version: 4,
      exportedAt: 0,
      data: { novels: [legacyNovel], writingNorms: [normRow('five', FIVE)] },
    });
    expect(parseBackup(text).data.writingNorms[0]!.scopes).toEqual(FIVE);
  });

  /** 一份合法的 v4 数据；各用例改一处，验证规则 1–10 */
  function validData() {
    return {
      novels: [legacyNovel],
      entries: [
        { id: 'oc', novelId: 'n1', categoryId: 'c', title: '沈砚', createdAt: 0, updatedAt: 0 },
      ],
      scenarios: [
        {
          id: 'S',
          novelId: 'n1',
          title: '雾中渡',
          setup: {
            cast: [{ id: 'k', entryId: 'oc' }],
            start: { situation: '醒来' },
            goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
          },
          mainNodeId: 'b' as string | null,
          cursorNodeId: 'b' as string | null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      scenarioNodes: [
        {
          id: 'r',
          novelId: 'n1',
          scenarioId: 'S',
          parentId: null,
          depth: 0,
          arrivedBy: { kind: 'start' },
          plot: '雾',
          options: [
            { id: 'oa', text: '拔刀', tendency: 'bold', risk: 'low' },
            { id: 'ob', text: '跳江', tendency: 'bold', risk: 'high' },
          ],
          createdAt: 0,
          updatedAt: 0,
        } as Record<string, unknown>,
        {
          id: 'b',
          novelId: 'n1',
          scenarioId: 'S',
          parentId: 'r',
          depth: 1,
          arrivedBy: { kind: 'option', optionId: 'oa', text: '拔刀' },
          plot: '刀',
          createdAt: 1,
          updatedAt: 1,
        } as Record<string, unknown>,
      ],
      sideStories: [
        {
          id: 's1',
          novelId: 'n1',
          title: '支线',
          scenarioSource: { scenarioId: 'S', forkNodeId: 'r' },
          createdAt: 0,
          updatedAt: 0,
        },
      ] as Record<string, unknown>[],
      chapters: [
        {
          id: 'c1',
          novelId: 'n1',
          index: 1,
          sideStoryId: 's1',
          scenarioSource: { scenarioId: 'S', nodeIds: ['b'] },
          createdAt: 0,
          updatedAt: 0,
        },
      ] as Record<string, unknown>[],
      outlineNodes: [
        {
          id: 'o1',
          novelId: 'n1',
          title: '章',
          scenarioSource: { scenarioId: 'S', nodeIds: ['r'] },
          createdAt: 0,
          updatedAt: 0,
        },
      ] as Record<string, unknown>[],
    };
  }

  function fileOf(data: unknown): string {
    return JSON.stringify({ app: 'myliterature', version: 4, exportedAt: 0, data });
  }

  it('合法的 v4 数据能解析', () => {
    expect(() => parseBackup(fileOf(validData()))).not.toThrow();
  });

  type Data = ReturnType<typeof validData>;
  const node = (data: Data, i: number) => data.scenarioNodes[i]!;
  const cases: [string, (data: Data) => void, string, string][] = [
    [
      '规则 1：节点指向不存在的推演',
      (d) => void (node(d, 1).scenarioId = 'ghost'),
      'scenarioNodes.1.scenarioId',
      '找不到所属推演',
    ],
    [
      '规则 2：同一推演两个开局',
      (d) => void d.scenarioNodes.push({ ...node(d, 0), id: 'r2' }),
      'scenarioNodes.2.parentId',
      '一个推演只能有一个开局',
    ],
    [
      '规则 3：父节点不存在',
      (d) => void (node(d, 1).parentId = 'ghost'),
      'scenarioNodes.1.parentId',
      '找不到父节点',
    ],
    [
      '规则 3：层级不连续',
      (d) => void (node(d, 1).depth = 2),
      'scenarioNodes.1.parentId',
      '层级不连续',
    ],
    [
      '规则 4：选项不在父节点上',
      (d) => void (node(d, 1).arrivedBy = { kind: 'option', optionId: 'oz', text: '?' }),
      'scenarioNodes.1.arrivedBy',
      '父节点上没有这个选项',
    ],
    [
      '规则 5：结局之后还有节点',
      (d) => void (node(d, 0).ending = { kind: 'bad', goalId: null, title: '沉江', cause: '跳江' }),
      'scenarioNodes.1.parentId',
      '结局之后不能再有节点',
    ],
    [
      '规则 6：主线指向别处',
      (d) => void (d.scenarios[0]!.mainNodeId = 'ghost'),
      'scenarios.0.mainNodeId',
      '主线',
    ],
    [
      '规则 7：主角条目不存在',
      (d) => void (d.scenarios[0]!.setup.cast[0]!.entryId = 'ghost'),
      'scenarios.0.setup.cast.0.entryId',
      '找不到主角条目',
    ],
    [
      '规则 8：外传指向不存在的分叉节点',
      (d) => void (d.sideStories[0]!.scenarioSource = { scenarioId: 'S', forkNodeId: 'ghost' }),
      'sideStories.0.scenarioSource',
      '外传指向的分叉节点不存在',
    ],
    [
      '规则 9：大纲溯源指向别的推演的节点',
      (d) => {
        d.scenarios.push({ ...d.scenarios[0]!, id: 'T', mainNodeId: null, cursorNodeId: null });
        d.outlineNodes[0]!.scenarioSource = { scenarioId: 'T', nodeIds: ['r'] };
      },
      'outlineNodes.0.scenarioSource',
      '来源步骤不属于这个推演',
    ],
    [
      '规则 9：主线章节带推演溯源',
      (d) => void (d.chapters[0]!.sideStoryId = null),
      'chapters.0.scenarioSource',
      '主线章节不能直接关联推演',
    ],
    [
      '规则 10：同一父节点下同一选项有两个子节点',
      (d) => void d.scenarioNodes.push({ ...node(d, 1), id: 'b2' }),
      'scenarioNodes.2.arrivedBy',
      '同一个选择出现了两次',
    ],
  ];

  for (const [label, mutate, path, message] of cases) {
    it(`${label}：整份被拒，detail 以对应路径开头，库里不变`, async () => {
      await seedNovel();
      const before = await repo.exportSnapshot();
      const data = validData();
      mutate(data);
      let caught: unknown;
      try {
        await restoreBackup(repo, parseBackup(fileOf(data)), 'replace');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackupError);
      const detail = (caught as BackupError).detail ?? '';
      expect(detail.startsWith(`data.${path}`)).toBe(true);
      expect(detail).toContain(message);
      expect(await repo.exportSnapshot()).toEqual(before);
    });
  }
});
