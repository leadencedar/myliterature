import Dexie, { type Table } from 'dexie';
import type {
  Category,
  Chapter,
  ChapterSummary,
  DailyLog,
  Glossary,
  ImportJob,
  KnowledgeEntry,
  Novel,
  OutlineNode,
  Proposal,
  Scenario,
  ScenarioNode,
  SideStory,
  StyleProfile,
  WritingNorm,
  WritingPlan,
} from '@/domain/schema';
import { upgradeLegacyImportJob } from '@/domain/importJob';
import { ALL_NORM_SCOPES_V6, addInteractiveScopeIfFull } from '@/domain/writingNorm';

/**
 * IndexedDB 架构。
 *
 * 索引选择说明：
 * - 软删除标记 deletedAt 刻意不建索引。IndexedDB 不会为 null 值建立索引项，
 *   「未删除」这个最常用的查询反而无法走索引，因此统一在内存里过滤 ——
 *   单本小说的条目数量在数百级别，代价可以忽略。
 * - styleProfiles 与 plans 对 novelId 建唯一索引（&），从架构上保证「一书一份」。
 *
 * 迁移约定：升级时**新增** version(n).stores({...})，不要修改已发布的 version(1)。
 * 需要数据变换时在 .upgrade() 里写迁移逻辑，例如：
 *
 *   this.version(2)
 *     .stores({ entries: 'id, novelId, categoryId, [novelId+categoryId], rating' })
 *     .upgrade((tx) => tx.table('entries').toCollection().modify((e) => { e.rating = 0; }));
 */
export class AppDatabase extends Dexie {
  novels!: Table<Novel, string>;
  categories!: Table<Category, string>;
  entries!: Table<KnowledgeEntry, string>;
  outlineNodes!: Table<OutlineNode, string>;
  chapters!: Table<Chapter, string>;
  chapterSummaries!: Table<ChapterSummary, string>;
  styleProfiles!: Table<StyleProfile, string>;
  proposals!: Table<Proposal, string>;
  plans!: Table<WritingPlan, string>;
  dailyLogs!: Table<DailyLog, string>;
  importJobs!: Table<ImportJob, string>;
  glossaries!: Table<Glossary, string>;
  sideStories!: Table<SideStory, string>;
  writingNorms!: Table<WritingNorm, string>;
  scenarios!: Table<Scenario, string>;
  scenarioNodes!: Table<ScenarioNode, string>;

  constructor(name = 'myliterature') {
    super(name);
    this.version(1).stores({
      novels: 'id, updatedAt',
      categories: 'id, novelId, [novelId+order]',
      entries: 'id, novelId, categoryId, [novelId+categoryId]',
      outlineNodes: 'id, novelId, parentId, [novelId+parentId]',
      chapters: 'id, novelId, [novelId+index]',
      chapterSummaries: 'id, novelId, &chapterId',
      styleProfiles: 'id, &novelId',
      proposals: 'id, novelId, [novelId+status], batchId',
      plans: 'id, &novelId',
      dailyLogs: 'id, novelId, [novelId+date]',
    });

    /**
     * v2：旧稿导入任务。
     *
     * 一次导入可能要跑几十章，中途断网、切后台、关页面都很常见，
     * 因此进度必须落盘而不是留在组件状态里。放 IndexedDB 而不是 localStorage，
     * 是因为任务里会带上每章的标题与错误信息，长篇稿件下体积不小。
     *
     * 只新增表、不改动 v1 的既有结构，因此不需要 upgrade 回调 ——
     * 已有数据库打开时 Dexie 会自动补建这张表。
     */
    this.version(2).stores({
      importJobs: 'id, &novelId',
    });

    /**
     * v3：章节新增 `sourceContent` / `sourceLanguage`（翻译前的原文）。
     *
     * 两个字段都不建索引，因此**不需要改 stores**。之所以仍然升一个版本：
     * 旧行里这两个字段是 `undefined`，而读取路径（`getChapter` 等）为了性能
     * 不做 Zod parse，界面上 `chapter.sourceContent.trim()` 会直接抛错。
     * 用一次迁移把旧行补齐，比在几十个读取点各写一个 `?? ''` 可靠。
     */
    this.version(3).upgrade((tx) =>
      tx
        .table('chapters')
        .toCollection()
        .modify((chapter: { sourceContent?: string; sourceLanguage?: string }) => {
          chapter.sourceContent ??= '';
          chapter.sourceLanguage ??= '';
        }),
    );

    /**
     * v4：作品级译名表。
     *
     * 之前译名表挂在导入任务里，任务跑完就被删掉 —— 于是第二批外文素材进来时
     * 从空表开始，同一个人名可能换个译法。译名是作品的永久事实，不是任务的中间态，
     * 所以单独成表，与 plans / styleProfiles 同构（`&novelId` 一书一份）。
     */
    this.version(4).stores({
      glossaries: 'id, &novelId',
    });

    /**
     * v5：外传。
     * - 新增 sideStories 表：外传是具名的、一部一行，各自的进展摘要（rollingSummary）放在自己身上，
     *   与 Novel.rollingSummary 同理；不做成 Novel 上的数组，是因为删除、改名、备份都按行处理更简单。
     * - chapters 加 sideStoryId 索引：只为删除外传时级联删章节（where('sideStoryId').equals(id)）。
     *   IndexedDB 不给 null 建索引项，主线章节不进这个索引，索引只收录外传章节。
     * - [novelId+index] 本来就不是唯一索引，主线和外传编号重复不冲突，不用改。
     * - 读取路径不做 Zod parse，所以用 upgrade 把旧章节的 sideStoryId 补成 null、把旧导入任务换算成新形状。
     */
    this.version(5)
      .stores({
        chapters: 'id, novelId, [novelId+index], sideStoryId',
        sideStories: 'id, novelId',
      })
      .upgrade(async (tx) => {
        await tx
          .table('chapters')
          .toCollection()
          .modify((chapter: { sideStoryId?: string | null }) => {
            chapter.sideStoryId ??= null;
          });
        await tx
          .table('importJobs')
          .toCollection()
          .modify((job: Record<string, unknown>) => {
            try {
              // 全函数：任何形状的旧行都不抛错；返回新对象、不改入参
              const next = upgradeLegacyImportJob(job);
              if (next === job || typeof next !== 'object' || next === null) return;
              Object.assign(job, next);
              delete job.importType;
              delete job.worldviewText;
            } catch {
              // 第二道防线：这一行保持原样，面板加载时由 resumeStepOf 清掉（见 design 9 节）
            }
          });
      });

    /**
     * v6：作品级写作规范。
     * 只新增表、不碰已有表，所以没有 upgrade 回调 —— 已有数据库打开时 Dexie 自动补建。
     * 不加 [novelId+order] 复合索引：一本书的规范是个位数到几十份，取出来在内存里排序即可，
     * 与 sideStories 的做法一致。
     */
    this.version(6).stores({
      writingNorms: 'id, novelId',
    });

    /**
     * v7：互动推演。
     * - 新表 scenarios / scenarioNodes。节点按 scenarioId 取整棵树（一次查询，树在内存里拼）；
     *   parentId 索引只为删推演时级联 —— 不需要按父节点查询，但留着便宜。
     * - 读取路径不做 Zod parse，所以用 upgrade 给旧行补新字段的默认值（条目的作用范围与逐字段锁定、
     *   大纲 / 章节 / 外传的推演溯源），与 v3 / v5 同理：比在每个读取点写 `?? 默认值` 可靠。
     * - 写作规范：只有「五项全开」的老规范补上 interactive（设计 D13）；收窄过的是作者的选择，不动。
     *   缺 scopes 字段的行按 v6 的默认（五项全开）处理，而不是清空作用范围。
     */
    this.version(7)
      .stores({
        scenarios: 'id, novelId',
        scenarioNodes: 'id, novelId, scenarioId, parentId',
      })
      .upgrade(async (tx) => {
        await tx
          .table('entries')
          .toCollection()
          .modify((entry: Partial<KnowledgeEntry>) => {
            entry.scope ??= { kind: 'universal' };
            entry.fieldLocks ??= {};
          });
        for (const name of ['outlineNodes', 'chapters', 'sideStories']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: { scenarioSource?: unknown }) => {
              row.scenarioSource ??= null;
            });
        }
        await tx
          .table('writingNorms')
          .toCollection()
          .modify((norm: Partial<WritingNorm>) => {
            norm.scopes = addInteractiveScopeIfFull(norm.scopes ?? ALL_NORM_SCOPES_V6);
          });
      });
  }
}

/** 应用运行时共用的数据库实例 */
export const db = new AppDatabase();
