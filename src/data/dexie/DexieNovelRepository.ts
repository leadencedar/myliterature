import { BUILTIN_CATEGORIES } from '@/domain/defaults';
import { matchesKeyword } from '@/domain/entrySearch';
import { mergeGlossary, removeGlossaryEntry, setGlossaryEntry } from '@/domain/glossary';
import { countWords, newId, now, toLocalDate } from '@/domain/primitives';
import {
  CategorySchema,
  ChapterSchema,
  ChapterSummarySchema,
  DailyLogSchema,
  GlossarySchema,
  ImportJobSchema,
  RepositorySnapshotSchema,
  KnowledgeEntrySchema,
  MAX_SCENARIO_OPTIONS,
  NovelDraftSchema,
  NovelSchema,
  OutlineNodeSchema,
  ProposalSchema,
  ScenarioNodeSchema,
  ScenarioPathSummarySchema,
  ScenarioSchema,
  ScenarioOptionSchema,
  SideStorySchema,
  StyleProfileSchema,
  WorldlineDeltaSchema,
  WritingNormSchema,
  WritingPlanSchema,
  type Category,
  type Chapter,
  type ChapterSummary,
  type DailyLog,
  type Glossary,
  type GlossaryEntryData,
  type ImportDraft,
  type ImportJob,
  type ImportWorldviewChunk,
  type RepositorySnapshot,
  type KnowledgeEntry,
  type Novel,
  type NovelDraft,
  type NovelStats,
  type OutlineNode,
  type Proposal,
  type Scenario,
  type ScenarioNode,
  type ScenarioOption,
  type ScenarioSetup,
  type WorldlineDelta,
  type ShelfItem,
  type SideStory,
  type StyleProfile,
  type WritingNorm,
  type WritingNormScope,
  type WritingPlan,
} from '@/domain/schema';
import {
  chaptersOfTrack,
  isMainChapter,
  normalizeSideStoryTitle,
  sideStoryTitleKey,
} from '@/domain/sideStory';
import { ALL_NORM_SCOPES, compareNorms, normalizeNormScopes } from '@/domain/writingNorm';
import { arrivalKey, normalizeAction, pathTo, type ScenarioOutlinePlan } from '@/domain/scenario';
import { effectiveKnowledge, sanitizeDelta } from '@/domain/worldline';
import type {
  EntryCreateInput,
  EntryQuery,
  EntryUpdateInput,
  NovelRepository,
  ScenarioNodeInput,
  ScenarioSetupInput,
} from '../NovelRepository';
import { AppDatabase, db as defaultDb } from './db';

/** 不允许被 patch 覆盖的字段：身份与创建时间由仓储掌管 */
const PROTECTED_KEYS = ['id', 'novelId', 'createdAt'] as const;

function stripProtected<T extends object>(patch: T): T {
  const copy = { ...patch } as Record<string, unknown>;
  for (const key of PROTECTED_KEYS) delete copy[key];
  return copy as T;
}

/** 名称归一化：忽略大小写与首尾空白，用于条目重名匹配 */
function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/** 作用范围为通用（scope 缺失按通用：迁移之外的第二道防线） */
function isUniversal(entry: KnowledgeEntry): boolean {
  return (entry.scope?.kind ?? 'universal') === 'universal';
}

const SCENARIO_GONE = '这个推演已不存在，可能已被删除';
const NODE_GONE = '这一步已不存在';

export class DexieNovelRepository implements NovelRepository {
  constructor(private readonly db: AppDatabase = defaultDb) {}

  // ================================================================ 小说

  async listNovels(options?: { includeDeleted?: boolean }): Promise<Novel[]> {
    const rows = await this.db.novels.toArray();
    const visible = options?.includeDeleted ? rows : rows.filter((n) => n.deletedAt === null);
    return visible.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listShelfItems(): Promise<ShelfItem[]> {
    const novels = await this.listNovels();
    if (novels.length === 0) return [];

    // 一次取全量再在内存里分组，避免每本书都打一轮查询（N+1）
    const [chapters, entries, proposals] = await Promise.all([
      this.db.chapters.toArray(),
      this.db.entries.toArray(),
      this.db.proposals.toArray(),
    ]);

    return novels.map((novel) => ({
      novel,
      stats: computeStats(novel.id, chapters, entries, proposals),
    }));
  }

  async getNovel(id: string): Promise<Novel | undefined> {
    return this.db.novels.get(id);
  }

  async getNovelStats(novelId: string): Promise<NovelStats> {
    const [chapters, entries, proposals] = await Promise.all([
      this.db.chapters.where('novelId').equals(novelId).toArray(),
      this.db.entries.where('novelId').equals(novelId).toArray(),
      this.db.proposals.where('novelId').equals(novelId).toArray(),
    ]);
    return computeStats(novelId, chapters, entries, proposals);
  }

  async createNovel(draft: NovelDraft): Promise<Novel> {
    const parsedDraft = NovelDraftSchema.parse(draft);
    const timestamp = now();
    const novel = NovelSchema.parse({
      ...parsedDraft,
      id: newId(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // 内置分类与风格档案属于「一本书开箱即用」的一部分，必须与小说同生共死，
    // 因此放进同一个事务，避免出现有小说但没有分类的半成品状态。
    await this.db.transaction(
      'rw',
      [this.db.novels, this.db.categories, this.db.styleProfiles],
      async () => {
        await this.db.novels.add(novel);
        await this.db.categories.bulkAdd(
          BUILTIN_CATEGORIES.map((seed, index) =>
            CategorySchema.parse({
              id: newId(),
              novelId: novel.id,
              name: seed.name,
              kind: seed.kind,
              builtin: true,
              fieldTemplate: seed.fieldTemplate,
              order: index,
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          ),
        );
        await this.db.styleProfiles.add(
          StyleProfileSchema.parse({
            id: newId(),
            novelId: novel.id,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
      },
    );

    return novel;
  }

  async updateNovel(id: string, patch: Partial<Novel>): Promise<Novel> {
    const current = await this.db.novels.get(id);
    if (!current) throw new Error(`小说不存在：${id}`);
    const next = NovelSchema.parse({ ...current, ...stripProtected(patch), updatedAt: now() });
    await this.db.novels.put(next);
    return next;
  }

  async deleteNovel(id: string): Promise<void> {
    const tables = [
      this.db.novels,
      this.db.categories,
      this.db.entries,
      this.db.outlineNodes,
      this.db.chapters,
      this.db.chapterSummaries,
      this.db.styleProfiles,
      this.db.proposals,
      this.db.plans,
      this.db.dailyLogs,
      this.db.importJobs,
      this.db.glossaries,
      this.db.sideStories,
      this.db.writingNorms,
      this.db.scenarios,
      this.db.scenarioNodes,
    ];
    // 级联硬删：孤儿数据没有任何价值，只会让备份体积和统计口径失真
    await this.db.transaction('rw', tables, async () => {
      await Promise.all([
        this.db.scenarios.where('novelId').equals(id).delete(),
        this.db.scenarioNodes.where('novelId').equals(id).delete(),
        this.db.sideStories.where('novelId').equals(id).delete(),
        this.db.writingNorms.where('novelId').equals(id).delete(),
        this.db.categories.where('novelId').equals(id).delete(),
        this.db.entries.where('novelId').equals(id).delete(),
        this.db.outlineNodes.where('novelId').equals(id).delete(),
        this.db.chapters.where('novelId').equals(id).delete(),
        this.db.chapterSummaries.where('novelId').equals(id).delete(),
        this.db.styleProfiles.where('novelId').equals(id).delete(),
        this.db.proposals.where('novelId').equals(id).delete(),
        this.db.plans.where('novelId').equals(id).delete(),
        this.db.dailyLogs.where('novelId').equals(id).delete(),
        this.db.importJobs.where('novelId').equals(id).delete(),
        this.db.glossaries.where('novelId').equals(id).delete(),
      ]);
      await this.db.novels.delete(id);
    });
  }

  // ================================================================ 分类

  async listCategories(novelId: string): Promise<Category[]> {
    const rows = await this.db.categories.where('novelId').equals(novelId).toArray();
    return rows.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  async createCategory(
    novelId: string,
    input: Pick<Category, 'name'> & Partial<Category>,
  ): Promise<Category> {
    const existing = await this.listCategories(novelId);
    const timestamp = now();
    const category = CategorySchema.parse({
      order: existing.length,
      ...stripProtected(input),
      id: newId(),
      novelId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.categories.add(category);
    return category;
  }

  async updateCategory(id: string, patch: Partial<Category>): Promise<Category> {
    const current = await this.db.categories.get(id);
    if (!current) throw new Error(`分类不存在：${id}`);
    const next = CategorySchema.parse({
      ...current,
      ...stripProtected(patch),
      // 内置标记不可通过 patch 改动，否则内置分类会被绕过删除保护
      builtin: current.builtin,
      updatedAt: now(),
    });
    await this.db.categories.put(next);
    return next;
  }

  async deleteCategory(id: string): Promise<void> {
    const category = await this.db.categories.get(id);
    if (!category) return;
    if (category.builtin) {
      throw new Error('内置分类不可删除');
    }
    const used = await this.db.entries.where('categoryId').equals(id).count();
    if (used > 0) {
      throw new Error(`该分类下还有 ${used} 个条目，请先移动或删除条目`);
    }
    await this.db.categories.delete(id);
  }

  // ================================================================ 知识条目

  async listEntries(novelId: string, query?: EntryQuery): Promise<KnowledgeEntry[]> {
    let rows = await this.db.entries.where('novelId').equals(novelId).toArray();

    // 默认只给通用条目：限定到推演的条目不能漏进现有写作链路（「没有推演时 prompt 不变」）
    if ((query?.scope ?? 'worldview') === 'worldview') rows = rows.filter(isUniversal);
    if (!query?.includeDeleted) rows = rows.filter((e) => e.deletedAt === null);
    if (query?.categoryId) rows = rows.filter((e) => e.categoryId === query.categoryId);
    if (query?.pinnedOnly) rows = rows.filter((e) => e.pinned);

    // 匹配范围与界面上的即时过滤共用同一份实现，避免两处口径不一致
    if (query?.search?.trim()) {
      rows = rows.filter((entry) => matchesKeyword(entry, query.search!));
    }

    return rows.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }

  async getEntry(id: string): Promise<KnowledgeEntry | undefined> {
    return this.db.entries.get(id);
  }

  async createEntry(
    novelId: string,
    input: Pick<KnowledgeEntry, 'categoryId' | 'title'> & Partial<KnowledgeEntry>,
  ): Promise<KnowledgeEntry> {
    const timestamp = now();
    const entry = KnowledgeEntrySchema.parse({
      ...stripProtected(input),
      id: newId(),
      novelId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.entries.add(entry);
    return entry;
  }

  async updateEntry(id: string, patch: Partial<KnowledgeEntry>): Promise<KnowledgeEntry> {
    const current = await this.db.entries.get(id);
    if (!current) throw new Error(`条目不存在：${id}`);
    const next = KnowledgeEntrySchema.parse({
      ...current,
      ...stripProtected(patch),
      updatedAt: now(),
    });
    await this.db.entries.put(next);
    return next;
  }

  async softDeleteEntry(id: string): Promise<void> {
    await this.db.entries.update(id, { deletedAt: now(), updatedAt: now() });
  }

  async restoreEntry(id: string): Promise<void> {
    await this.db.entries.update(id, { deletedAt: null, updatedAt: now() });
  }

  async hardDeleteEntry(id: string): Promise<void> {
    // 在仓储拦而不是只在界面拦：这是唯一的写入口；硬删后推演没有主角，备份也会被校验拒绝
    await this.db.transaction('rw', [this.db.entries, this.db.scenarios], async () => {
      const entry = await this.db.entries.get(id);
      if (!entry) return;
      const owner = (await this.db.scenarios.where('novelId').equals(entry.novelId).toArray()).find(
        (scenario) => scenario.setup.cast.some((member) => member.entryId === id),
      );
      if (owner) throw new Error(`这个条目是推演《${owner.title}》的主角，先删除推演`);
      await this.db.entries.delete(id);
    });
  }

  async findEntryByName(novelId: string, name: string): Promise<KnowledgeEntry | undefined> {
    const target = normalizeName(name);
    if (!target) return undefined;
    const rows = await this.db.entries.where('novelId').equals(novelId).toArray();
    return (
      rows
        // 反向提取是世界观层的操作：同名的提取结果合并进通用条目，不碰推演专属的
        .filter((e) => e.deletedAt === null && isUniversal(e))
        .find(
          (entry) =>
            normalizeName(entry.title) === target ||
            entry.aliases.some((alias) => normalizeName(alias) === target),
        )
    );
  }

  // ================================================================ 大纲

  async listOutline(novelId: string): Promise<OutlineNode[]> {
    const rows = await this.db.outlineNodes.where('novelId').equals(novelId).toArray();
    return rows.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  async createOutlineNode(
    novelId: string,
    input: Pick<OutlineNode, 'title'> & Partial<OutlineNode>,
  ): Promise<OutlineNode> {
    const parentId = input.parentId ?? null;
    const siblings = (await this.listOutline(novelId)).filter((n) => n.parentId === parentId);
    const timestamp = now();
    const node = OutlineNodeSchema.parse({
      order: siblings.length,
      ...stripProtected(input),
      parentId,
      id: newId(),
      novelId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.outlineNodes.add(node);
    return node;
  }

  async updateOutlineNode(id: string, patch: Partial<OutlineNode>): Promise<OutlineNode> {
    const current = await this.db.outlineNodes.get(id);
    if (!current) throw new Error(`大纲节点不存在：${id}`);
    const next = OutlineNodeSchema.parse({
      ...current,
      ...stripProtected(patch),
      updatedAt: now(),
    });
    await this.db.outlineNodes.put(next);
    return next;
  }

  async deleteOutlineNode(id: string): Promise<void> {
    const node = await this.db.outlineNodes.get(id);
    if (!node) return;
    const all = await this.listOutline(node.novelId);

    // 广度优先收集整棵子树：留下悬空的子节点会让大纲树渲染时凭空消失
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of all) {
        if (!doomed.has(candidate.id) && candidate.parentId && doomed.has(candidate.parentId)) {
          doomed.add(candidate.id);
          grew = true;
        }
      }
    }

    await this.db.transaction('rw', [this.db.outlineNodes, this.db.chapters], async () => {
      await this.db.outlineNodes.bulkDelete([...doomed]);
      // 章节本身保留（正文是用户资产），仅解除与已删节点的关联
      const affected = await this.db.chapters.where('novelId').equals(node.novelId).toArray();
      const relinked = affected
        .filter((c) => c.outlineNodeId && doomed.has(c.outlineNodeId))
        .map((c) => ({ ...c, outlineNodeId: null, updatedAt: now() }));
      if (relinked.length > 0) await this.db.chapters.bulkPut(relinked);
    });
  }

  async reorderOutline(
    updates: { id: string; parentId: string | null; order: number }[],
  ): Promise<void> {
    if (updates.length === 0) return;
    const timestamp = now();
    await this.db.transaction('rw', this.db.outlineNodes, async () => {
      const rows = await this.db.outlineNodes.bulkGet(updates.map((u) => u.id));
      const next: OutlineNode[] = [];
      updates.forEach((update, index) => {
        const current = rows[index];
        if (!current) return;
        next.push({
          ...current,
          parentId: update.parentId,
          order: update.order,
          updatedAt: timestamp,
        });
      });
      await this.db.outlineNodes.bulkPut(next);
    });
  }

  // ================================================================ 章节

  async listChapters(novelId: string): Promise<Chapter[]> {
    const rows = await this.db.chapters.where('novelId').equals(novelId).toArray();
    return rows.sort((a, b) => a.index - b.index);
  }

  async getChapter(id: string): Promise<Chapter | undefined> {
    return this.db.chapters.get(id);
  }

  async createChapter(
    novelId: string,
    input: Partial<Chapter> & { index?: number },
  ): Promise<Chapter> {
    const sideStoryId = input.sideStoryId ?? null;
    if (sideStoryId !== null) {
      const story = await this.db.sideStories.get(sideStoryId);
      if (!story || story.novelId !== novelId) throw new Error('外传不存在');
      // 外传独立于主线的大纲；关联上去会让大纲进度把外传算进主线
      if ((input.outlineNodeId ?? null) !== null) throw new Error('外传章节不能关联大纲节点');
    }
    // 编号按线各自从 1 起：主线与每部外传互不影响
    const existing = chaptersOfTrack(await this.listChapters(novelId), sideStoryId);
    const nextIndex =
      input.index ?? (existing.length === 0 ? 1 : Math.max(...existing.map((c) => c.index)) + 1);
    const content = input.content ?? '';
    const timestamp = now();
    const chapter = ChapterSchema.parse({
      ...stripProtected(input),
      id: newId(),
      novelId,
      index: nextIndex,
      content,
      wordCount: countWords(content),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.chapters.add(chapter);
    return chapter;
  }

  async updateChapter(id: string, patch: Partial<Chapter>): Promise<Chapter> {
    const current = await this.db.chapters.get(id);
    if (!current) throw new Error(`章节不存在：${id}`);
    const safePatch = stripProtected(patch);
    // 跨线移动不支持：静默剥掉而不是抛错，调用方常传 `{ ...chapter, content }` 整对象，
    // 带的就是原值；剥掉也保证编号与摘要链不会悄悄错乱
    delete safePatch.sideStoryId;
    if ((current.sideStoryId ?? null) !== null && (safePatch.outlineNodeId ?? null) !== null) {
      throw new Error('外传章节不能关联大纲节点');
    }
    const merged = { ...current, ...safePatch };
    const next = ChapterSchema.parse({
      ...merged,
      // 字数始终由正文推导，不接受外部传入，避免两者不一致
      wordCount: countWords(merged.content),
      updatedAt: now(),
    });
    await this.db.chapters.put(next);
    return next;
  }

  async deleteChapter(id: string): Promise<void> {
    await this.db.transaction('rw', [this.db.chapters, this.db.chapterSummaries], async () => {
      await this.db.chapters.delete(id);
      await this.db.chapterSummaries.where('chapterId').equals(id).delete();
    });
  }

  // ================================================================ 外传

  async listSideStories(novelId: string): Promise<SideStory[]> {
    const rows = await this.db.sideStories.where('novelId').equals(novelId).toArray();
    return rows.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  async getSideStory(id: string): Promise<SideStory | undefined> {
    return this.db.sideStories.get(id);
  }

  async createSideStory(
    novelId: string,
    input: { title: string; synopsis?: string },
  ): Promise<SideStory> {
    const title = normalizeSideStoryTitle(input.title);
    // 查重与写入放进同一个事务，两处同时新建同名外传时只有一处成功
    return this.db.transaction('rw', this.db.sideStories, async () => {
      const existing = await this.listSideStories(novelId);
      const key = sideStoryTitleKey(title);
      const duplicate = key ? existing.find((s) => sideStoryTitleKey(s.title) === key) : undefined;
      if (duplicate) throw new Error(`已有同名外传『${duplicate.title}』`);
      const timestamp = now();
      const story = SideStorySchema.parse({
        title,
        synopsis: input.synopsis ?? '',
        id: newId(),
        novelId,
        order: existing.length === 0 ? 0 : Math.max(...existing.map((s) => s.order)) + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.db.sideStories.add(story);
      return story;
    });
  }

  async updateSideStory(
    id: string,
    patch: Partial<Pick<SideStory, 'title' | 'synopsis' | 'rollingSummary'>>,
  ): Promise<SideStory> {
    return this.db.transaction('rw', this.db.sideStories, async () => {
      const current = await this.db.sideStories.get(id);
      if (!current) throw new Error('这部外传已不存在，可能已被删除');
      // 签名只允许三个键，但调用方可能传整对象；身份、排序与创建时间由仓储掌管
      const safePatch = stripProtected(patch) as Record<string, unknown>;
      delete safePatch.order;
      delete safePatch.updatedAt;
      if (typeof safePatch.title === 'string') {
        const title = normalizeSideStoryTitle(safePatch.title);
        const key = sideStoryTitleKey(title);
        const siblings = await this.listSideStories(current.novelId);
        // 排除自身：只改大小写或去掉「外传·」前缀不算重名
        const duplicate = key
          ? siblings.find((s) => s.id !== id && sideStoryTitleKey(s.title) === key)
          : undefined;
        if (duplicate) throw new Error(`已有同名外传『${duplicate.title}』`);
        safePatch.title = title;
      }
      const next = SideStorySchema.parse({ ...current, ...safePatch, updatedAt: now() });
      await this.db.sideStories.put(next);
      return next;
    });
  }

  async deleteSideStory(id: string): Promise<void> {
    const tables = [this.db.sideStories, this.db.chapters, this.db.chapterSummaries];
    // 外传、它的章节与章节摘要同生共死；外传不存在时下面几步都是空操作（删除幂等）
    await this.db.transaction('rw', tables, async () => {
      const chapterIds = await this.db.chapters.where('sideStoryId').equals(id).primaryKeys();
      if (chapterIds.length > 0) {
        await this.db.chapterSummaries.where('chapterId').anyOf(chapterIds).delete();
        await this.db.chapters.bulkDelete(chapterIds);
      }
      await this.db.sideStories.delete(id);
    });
  }

  // ================================================================ 写作规范

  async listWritingNorms(novelId: string): Promise<WritingNorm[]> {
    const rows = await this.db.writingNorms.where('novelId').equals(novelId).toArray();
    return rows.sort(compareNorms);
  }

  async createWritingNorm(
    novelId: string,
    input: { title: string; content: string; enabled?: boolean; scopes?: WritingNormScope[] },
  ): Promise<WritingNorm> {
    // 读最大 order 与写入放进同一个事务，两处同时新建时不会拿到同一个 order
    return this.db.transaction('rw', this.db.writingNorms, async () => {
      const existing = await this.db.writingNorms.where('novelId').equals(novelId).toArray();
      const timestamp = now();
      const norm = WritingNormSchema.parse({
        title: input.title,
        // 作者原文：不 trim、不改写，存什么就是什么
        content: input.content,
        enabled: input.enabled ?? true,
        // 同样的选择存成同样的数组（去重 + 固定顺序），备份 diff 才稳定
        scopes:
          input.scopes === undefined ? [...ALL_NORM_SCOPES] : normalizeNormScopes(input.scopes),
        id: newId(),
        novelId,
        order: existing.length === 0 ? 0 : Math.max(...existing.map((n) => n.order)) + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.db.writingNorms.add(norm);
      return norm;
    });
  }

  async updateWritingNorm(
    id: string,
    patch: Partial<Pick<WritingNorm, 'title' | 'content' | 'enabled' | 'scopes'>>,
  ): Promise<WritingNorm> {
    return this.db.transaction('rw', this.db.writingNorms, async () => {
      const current = await this.db.writingNorms.get(id);
      if (!current) throw new Error('这份写作规范已不存在，可能已被删除');
      // 签名只允许四个键，但调用方可能传整对象；顺序只能经 reorder / 精简另存整批改，
      // 散在 update 里会出现重复 order
      const safePatch = stripProtected(patch) as Record<string, unknown>;
      delete safePatch.order;
      delete safePatch.updatedAt;
      if (Array.isArray(safePatch.scopes)) {
        safePatch.scopes = normalizeNormScopes(safePatch.scopes as WritingNormScope[]);
      }
      const next = WritingNormSchema.parse({ ...current, ...safePatch, updatedAt: now() });
      await this.db.writingNorms.put(next);
      return next;
    });
  }

  async deleteWritingNorm(id: string): Promise<void> {
    await this.db.writingNorms.delete(id);
  }

  async reorderWritingNorms(novelId: string, orderedIds: string[]): Promise<void> {
    await this.db.transaction('rw', this.db.writingNorms, async () => {
      const rows = await this.db.writingNorms.where('novelId').equals(novelId).toArray();
      const rowIds = new Set(rows.map((row) => row.id));
      // 不先去重：[a, a, b] 去重后会被误判为合法，a 被写两次、order 不再是 0..n-1。
      // 集合对不上说明另一处刚新建或删除过，按旧列表重排会丢行或写错，宁可整次拒绝
      const valid =
        orderedIds.length === rows.length &&
        new Set(orderedIds).size === rows.length &&
        orderedIds.every((rowId) => rowIds.has(rowId));
      if (!valid) throw new Error('规范列表已变化，请刷新后再调整顺序');

      const byId = new Map(rows.map((row) => [row.id, row]));
      const timestamp = now();
      const changed: WritingNorm[] = [];
      orderedIds.forEach((rowId, order) => {
        const row = byId.get(rowId)!;
        // 位置没变的不碰 updatedAt：它表示「内容或设置被改过」，不该因为别人挪动而刷新
        if (row.order !== order) changed.push({ ...row, order, updatedAt: timestamp });
      });
      if (changed.length > 0) await this.db.writingNorms.bulkPut(changed);
    });
  }

  async saveCondensedWritingNorm(
    sourceId: string,
    input: { title: string; content: string },
  ): Promise<WritingNorm> {
    // 新建精简版与停用原文同成同败：半成功会出现两份同时注入，或一份都不注入
    return this.db.transaction('rw', this.db.writingNorms, async () => {
      const source = await this.db.writingNorms.get(sourceId);
      if (!source) throw new Error('这份写作规范已不存在，可能已被删除');
      const timestamp = now();
      // 先 parse 再动任何一行：输入不合法时什么都不写
      const created = WritingNormSchema.parse({
        title: input.title,
        content: input.content,
        enabled: true,
        scopes: [...source.scopes],
        id: newId(),
        novelId: source.novelId,
        order: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      // 不用「order > source.order 的都 +1」：合并导入备份后同书可能有重复 order，
      // 那种写法保证不了新规范紧跟源规范。按全序排好后插入，再整本书重写 0..n-1
      const rows = (
        await this.db.writingNorms.where('novelId').equals(source.novelId).toArray()
      ).sort(compareNorms);
      const at = rows.findIndex((row) => row.id === sourceId);
      const sequence = [...rows.slice(0, at + 1), created, ...rows.slice(at + 1)];

      let saved = created;
      const changed: WritingNorm[] = [];
      sequence.forEach((row, order) => {
        if (row === created) {
          saved = { ...created, order };
          changed.push(saved);
          return;
        }
        const enabled = row.id === sourceId ? false : row.enabled;
        if (row.order === order && row.enabled === enabled) return;
        changed.push({ ...row, order, enabled, updatedAt: timestamp });
      });
      await this.db.writingNorms.bulkPut(changed);
      return saved;
    });
  }

  // ================================================================ 互动推演

  async listScenarios(novelId: string): Promise<Scenario[]> {
    const rows = await this.db.scenarios.where('novelId').equals(novelId).toArray();
    const key = (row: Scenario) => row.lastAdvancedAt ?? row.updatedAt;
    return rows.sort(
      (a, b) => key(b) - key(a) || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1),
    );
  }

  async getScenario(id: string): Promise<Scenario | undefined> {
    return this.db.scenarios.get(id);
  }

  async createScenario(
    novelId: string,
    input: {
      title: string;
      setup: ScenarioSetupInput;
      newOc?: { categoryId: string; title: string; fields: Record<string, string> };
    },
  ): Promise<Scenario> {
    // 推演与新建的主角同成同败：半成功会留下没有推演认领的限定人物，或没有主角的推演
    return this.db.transaction('rw', [this.db.scenarios, this.db.entries], async () => {
      const timestamp = now();
      const scenarioId = newId();
      let ocEntry: KnowledgeEntry | null = null;
      if (input.newOc) {
        ocEntry = KnowledgeEntrySchema.parse({
          id: newId(),
          novelId,
          categoryId: input.newOc.categoryId,
          title: input.newOc.title,
          fields: input.newOc.fields,
          scope: { kind: 'limited', targets: [{ scenarioId, fromNodeId: null, revealHint: '' }] },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      const cast = ocEntry
        ? [{ id: newId(), entryId: ocEntry.id }]
        : input.setup.cast.map((member) => ({ id: newId(), entryId: member.entryId }));
      // 先 parse 再查主角、再写：设定不合法时什么都不写
      const scenario = ScenarioSchema.parse({
        id: scenarioId,
        novelId,
        title: input.title,
        setup: { ...input.setup, cast },
        mainNodeId: null,
        cursorNodeId: null,
        lastAdvancedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (!ocEntry) {
        for (const member of scenario.setup.cast) {
          const entry = await this.db.entries.get(member.entryId);
          if (!entry || entry.novelId !== novelId || entry.deletedAt !== null) {
            throw new Error('选中的人物已不存在');
          }
        }
      } else {
        await this.db.entries.add(ocEntry);
      }
      await this.db.scenarios.add(scenario);
      return scenario;
    });
  }

  async updateScenario(
    id: string,
    patch: {
      title?: string;
      setup?: Partial<Pick<ScenarioSetup, 'goals' | 'milestones' | 'tone' | 'expectedSteps'>>;
    },
  ): Promise<Scenario> {
    return this.db.transaction('rw', this.db.scenarios, async () => {
      const current = await this.db.scenarios.get(id);
      if (!current) throw new Error(SCENARIO_GONE);
      // 主角与起点是根节点的前提，改了等于整棵树建立在另一套前提上：只取可改的四项
      const setup = patch.setup ?? {};
      const next = ScenarioSchema.parse({
        ...current,
        title: patch.title ?? current.title,
        setup: {
          ...current.setup,
          ...(setup.goals !== undefined ? { goals: setup.goals } : {}),
          ...(setup.milestones !== undefined ? { milestones: setup.milestones } : {}),
          ...(setup.tone !== undefined ? { tone: setup.tone } : {}),
          ...(setup.expectedSteps !== undefined ? { expectedSteps: setup.expectedSteps } : {}),
        },
        updatedAt: now(),
      });
      await this.db.scenarios.put(next);
      return next;
    });
  }

  async deleteScenario(id: string, options: { trashScopedEntries: boolean }): Promise<void> {
    const tables = [
      this.db.scenarios,
      this.db.scenarioNodes,
      this.db.outlineNodes,
      this.db.chapters,
      this.db.sideStories,
      this.db.entries,
    ];
    // 删推演与清引用同成同败：否则悬空的 scenarioSource 会让之后导出的备份恢复不了
    await this.db.transaction('rw', tables, async () => {
      const scenario = await this.db.scenarios.get(id);
      if (!scenario) throw new Error(SCENARIO_GONE);
      const novelId = scenario.novelId;
      const timestamp = now();
      await this.db.scenarioNodes.where('scenarioId').equals(id).delete();

      // 已沉淀的大纲、外传与章节保留，只是不再关联这个推演
      const outline = (await this.db.outlineNodes.where('novelId').equals(novelId).toArray())
        .filter((node) => node.scenarioSource?.scenarioId === id)
        .map((node) => ({ ...node, scenarioSource: null, updatedAt: timestamp }));
      if (outline.length > 0) await this.db.outlineNodes.bulkPut(outline);
      const chapters = (await this.db.chapters.where('novelId').equals(novelId).toArray())
        .filter((chapter) => chapter.scenarioSource?.scenarioId === id)
        .map((chapter) => ({ ...chapter, scenarioSource: null, updatedAt: timestamp }));
      if (chapters.length > 0) await this.db.chapters.bulkPut(chapters);
      const stories = (await this.db.sideStories.where('novelId').equals(novelId).toArray())
        .filter((story) => story.scenarioSource?.scenarioId === id)
        .map((story) => ({ ...story, scenarioSource: null, updatedAt: timestamp }));
      if (stories.length > 0) await this.db.sideStories.bulkPut(stories);

      if (options.trashScopedEntries) {
        const changed: KnowledgeEntry[] = [];
        for (const entry of await this.db.entries.where('novelId').equals(novelId).toArray()) {
          const scope = entry.scope;
          if (scope?.kind !== 'limited') continue;
          if (!scope.targets.some((target) => target.scenarioId === id)) continue;
          const rest = scope.targets.filter((target) => target.scenarioId !== id);
          if (rest.length === 0) {
            // 只属于这个推演：进回收站（可恢复）。作用范围原样留着，恢复后作者能看出它原来属于哪里
            if (entry.deletedAt === null)
              changed.push({ ...entry, deletedAt: timestamp, updatedAt: timestamp });
          } else {
            changed.push({
              ...entry,
              scope: { kind: 'limited', targets: rest },
              updatedAt: timestamp,
            });
          }
        }
        if (changed.length > 0) await this.db.entries.bulkPut(changed);
      }
      await this.db.scenarios.delete(id);
    });
  }

  async listScenarioNodes(scenarioId: string): Promise<ScenarioNode[]> {
    const rows = await this.db.scenarioNodes.where('scenarioId').equals(scenarioId).toArray();
    return rows.sort(
      (a, b) =>
        a.depth - b.depth || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /** 事务内：某节点处（含）沿路叠加的有效知识，给 sanitizeDelta 用 */
  private async knowledgeAt(scenario: Scenario, nodes: ScenarioNode[], nodeId: string | null) {
    const [entries, categories] = await Promise.all([
      this.db.entries.where('novelId').equals(scenario.novelId).toArray(),
      this.db.categories.where('novelId').equals(scenario.novelId).toArray(),
    ]);
    return {
      knowledge: effectiveKnowledge({ scenario, path: pathTo(nodes, nodeId), entries, categories }),
      categories,
    };
  }

  async appendScenarioNode(
    scenarioId: string,
    input: ScenarioNodeInput,
  ): Promise<{ node: ScenarioNode; scenario: Scenario }> {
    const tables = [this.db.scenarios, this.db.scenarioNodes, this.db.entries, this.db.categories];
    // 检查与写入在同一个事务里：两个标签页同时点同一选项时只有一个能成功
    return this.db.transaction('rw', tables, async () => {
      const scenario = await this.db.scenarios.get(scenarioId);
      if (!scenario) throw new Error(SCENARIO_GONE);
      const nodes = await this.db.scenarioNodes.where('scenarioId').equals(scenarioId).toArray();
      const parentId = input.parentId ?? null;
      let depth = 0;
      if (parentId === null) {
        if (nodes.some((node) => node.parentId === null)) throw new Error('这个推演已经开过局了');
        if (input.arrivedBy.kind !== 'start') throw new Error('要接着走的那一步已不存在');
      } else {
        const parent = nodes.find((node) => node.id === parentId);
        if (!parent) throw new Error('要接着走的那一步已不存在');
        if (parent.ending !== null) throw new Error('这条线已经结束，不能继续推进');
        if (input.arrivedBy.kind === 'start') throw new Error('这个推演已经开过局了');
        const by = input.arrivedBy;
        if (by.kind === 'option' && !parent.options.some((option) => option.id === by.optionId)) {
          throw new Error('要接着走的那一步已不存在');
        }
        const children = nodes.filter((node) => node.parentId === parentId);
        const key = arrivalKey(by);
        // 自由输入与已走过的选项规范化后相同，也算同一个选择
        const walkedTexts = new Set(
          children.flatMap((child) => {
            const arrived = child.arrivedBy;
            if (arrived.kind !== 'option') return [];
            const option = parent.options.find((item) => item.id === arrived.optionId);
            return option ? [normalizeAction(option.text)] : [];
          }),
        );
        if (
          children.some((child) => arrivalKey(child.arrivedBy) === key) ||
          (by.kind === 'free' && walkedTexts.has(normalizeAction(by.text)))
        ) {
          throw new Error('这个选择刚刚已经走过了');
        }
        depth = parent.depth + 1;
      }

      const id = newId();
      // 落库前再过一遍：生成管道已经过滤过，这里兜住任何绕过管道的写入（锁定字段永远进不了库）
      const { knowledge, categories } = await this.knowledgeAt(scenario, nodes, parentId);
      const sanitized = sanitizeDelta(WorldlineDeltaSchema.parse(input.delta), {
        knowledge,
        categories,
        nodeId: id,
      });
      const notices = [...(input.notices ?? [])];
      for (const item of sanitized.notices) {
        if (!notices.some((existing) => existing.message === item.message)) notices.push(item);
      }
      const timestamp = now();
      const node = ScenarioNodeSchema.parse({
        ...input,
        delta: sanitized.delta,
        notices,
        id,
        novelId: scenario.novelId,
        scenarioId,
        parentId,
        depth,
        pathSummary: null,
        deltaEditedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const nextScenario = ScenarioSchema.parse({
        ...scenario,
        mainNodeId: node.id,
        cursorNodeId: node.id,
        lastAdvancedAt: timestamp,
        updatedAt: timestamp,
      });
      await this.db.scenarioNodes.add(node);
      await this.db.scenarios.put(nextScenario);
      return { node, scenario: nextScenario };
    });
  }

  async setScenarioCursor(scenarioId: string, nodeId: string): Promise<void> {
    await this.db.transaction('rw', [this.db.scenarios, this.db.scenarioNodes], async () => {
      const scenario = await this.db.scenarios.get(scenarioId);
      if (!scenario) throw new Error(SCENARIO_GONE);
      const node = await this.db.scenarioNodes.get(nodeId);
      if (!node || node.scenarioId !== scenarioId) throw new Error(NODE_GONE);
      // 只查看不改主线（设计 D1.2），也不刷新排序用的时间
      await this.db.scenarios.put({ ...scenario, cursorNodeId: nodeId });
    });
  }

  async updateScenarioNodeDelta(nodeId: string, delta: WorldlineDelta): Promise<ScenarioNode> {
    const tables = [this.db.scenarios, this.db.scenarioNodes, this.db.entries, this.db.categories];
    return this.db.transaction('rw', tables, async () => {
      const node = await this.db.scenarioNodes.get(nodeId);
      if (!node) throw new Error(NODE_GONE);
      const scenario = await this.db.scenarios.get(node.scenarioId);
      if (!scenario) throw new Error(SCENARIO_GONE);
      const nodes = await this.db.scenarioNodes
        .where('scenarioId')
        .equals(node.scenarioId)
        .toArray();
      const parsed = WorldlineDeltaSchema.parse(delta);
      const { knowledge, categories } = await this.knowledgeAt(scenario, nodes, node.parentId);
      const result = sanitizeDelta(parsed, { knowledge, categories, nodeId });
      // 手动编辑不悄悄丢内容：有任何不合规就整次拒绝，让作者看到原因
      if (result.notices.length > 0) throw new Error(result.notices[0]!.message);
      const timestamp = now();
      const next = ScenarioNodeSchema.parse({
        ...node,
        delta: result.delta,
        deltaEditedAt: timestamp,
        updatedAt: timestamp,
      });
      await this.db.scenarioNodes.put(next);
      return next;
    });
  }

  async appendScenarioOptions(
    nodeId: string,
    options: Omit<ScenarioOption, 'id' | 'batch'>[],
  ): Promise<ScenarioNode> {
    return this.db.transaction('rw', this.db.scenarioNodes, async () => {
      const node = await this.db.scenarioNodes.get(nodeId);
      if (!node) throw new Error(NODE_GONE);
      if (node.options.length >= MAX_SCENARIO_OPTIONS) throw new Error('这一步的选项已经够多了');
      const seen = new Set(node.options.map((option) => normalizeAction(option.text)));
      const fresh: Omit<ScenarioOption, 'id' | 'batch'>[] = [];
      for (const option of options) {
        const key = normalizeAction(option.text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        fresh.push(option);
      }
      if (fresh.length < 2) throw new Error('没有新的选项');
      const batch = node.options.reduce((max, option) => Math.max(max, option.batch), 0) + 1;
      const added = fresh
        .slice(0, MAX_SCENARIO_OPTIONS - node.options.length)
        .map((option) => ScenarioOptionSchema.parse({ ...option, id: newId(), batch }));
      const next = ScenarioNodeSchema.parse({
        ...node,
        options: [...node.options, ...added],
        updatedAt: now(),
      });
      await this.db.scenarioNodes.put(next);
      return next;
    });
  }

  async setScenarioNodeSummary(
    nodeId: string,
    summary: { text: string; openThreads: string[] },
  ): Promise<ScenarioNode> {
    return this.db.transaction('rw', this.db.scenarioNodes, async () => {
      const node = await this.db.scenarioNodes.get(nodeId);
      if (!node) throw new Error(NODE_GONE);
      const next = ScenarioNodeSchema.parse({
        ...node,
        pathSummary: ScenarioPathSummarySchema.parse(summary),
        updatedAt: now(),
      });
      await this.db.scenarioNodes.put(next);
      return next;
    });
  }

  async promoteLineEntry(
    input: { nodeId: string; localId: string } & (
      { create: EntryCreateInput } | { mergeInto: string; patch: EntryUpdateInput }
    ),
  ): Promise<KnowledgeEntry> {
    // 建 / 改世界观条目与标记本线条目同成同败：半成功会让原线上出现同一人物的两份
    return this.db.transaction('rw', [this.db.scenarioNodes, this.db.entries], async () => {
      const node = await this.db.scenarioNodes.get(input.nodeId);
      const line = node?.delta.lineEntries.find((item) => item.localId === input.localId);
      if (!node || !line || line.promotedEntryId !== null) {
        throw new Error('这个本线条目已经提升过了');
      }
      const timestamp = now();
      let entry: KnowledgeEntry;
      if ('create' in input) {
        entry = KnowledgeEntrySchema.parse({
          ...stripProtected(input.create),
          id: newId(),
          novelId: node.novelId,
          // 提升 = 成为全书事实：作用范围一律通用
          scope: { kind: 'universal' },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await this.db.entries.add(entry);
      } else {
        const current = await this.db.entries.get(input.mergeInto);
        if (!current || current.novelId !== node.novelId || current.deletedAt !== null) {
          throw new Error('要合并进的条目已不存在');
        }
        entry = KnowledgeEntrySchema.parse({
          ...current,
          ...stripProtected(input.patch),
          updatedAt: timestamp,
        });
        await this.db.entries.put(entry);
      }
      const next = ScenarioNodeSchema.parse({
        ...node,
        delta: {
          ...node.delta,
          lineEntries: node.delta.lineEntries.map((item) =>
            item.localId === input.localId ? { ...item, promotedEntryId: entry.id } : item,
          ),
        },
        updatedAt: timestamp,
      });
      await this.db.scenarioNodes.put(next);
      return entry;
    });
  }

  async commitScenarioOutline(novelId: string, plan: ScenarioOutlinePlan): Promise<void> {
    const tables = [
      this.db.scenarios,
      this.db.scenarioNodes,
      this.db.outlineNodes,
      this.db.sideStories,
      this.db.chapters,
      this.db.entries,
    ];
    // 整段沉淀一个事务：任何一步失败都回滚，提案留在待确认里让作者改
    await this.db.transaction('rw', tables, async () => {
      const scenario = await this.db.scenarios.get(plan.scenarioId);
      if (!scenario || scenario.novelId !== novelId) throw new Error(SCENARIO_GONE);
      const live = new Set(
        await this.db.scenarioNodes.where('scenarioId').equals(plan.scenarioId).primaryKeys(),
      );
      const requireNodes = (ids: string[]) => {
        if (ids.length === 0 || ids.some((id) => !live.has(id))) {
          throw new Error('来源步骤不属于这个推演');
        }
      };
      const timestamp = now();

      if (plan.mode === 'main') {
        // 「出场」只关联通用条目：限定条目不在写作链路里，关联了也注入不进去
        const universal = new Set(
          (await this.db.entries.where('novelId').equals(novelId).toArray())
            .filter((entry) => entry.deletedAt === null && isUniversal(entry))
            .map((entry) => entry.id),
        );
        const outline = await this.db.outlineNodes.where('novelId').equals(novelId).toArray();
        // 一律追加在顶层末尾，不替换作者已有的大纲
        let order = outline.filter((node) => node.parentId === null).length;
        const rows: OutlineNode[] = [];
        for (const volume of plan.volumes) {
          const volumeNode = OutlineNodeSchema.parse({
            id: newId(),
            novelId,
            parentId: null,
            order: order++,
            title: volume.title,
            synopsis: volume.synopsis,
            targetWords: volume.targetWords,
            // 卷只是分组，溯源到步骤的是章
            scenarioSource: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          rows.push(volumeNode);
          volume.chapters.forEach((chapter, index) => {
            requireNodes(chapter.nodeIds);
            rows.push(
              OutlineNodeSchema.parse({
                id: newId(),
                novelId,
                parentId: volumeNode.id,
                order: index,
                title: chapter.title,
                synopsis: chapter.synopsis,
                targetWords: chapter.targetWords,
                linkedEntryIds: chapter.linkedEntryIds.filter((id) => universal.has(id)),
                scenarioSource: { scenarioId: plan.scenarioId, nodeIds: chapter.nodeIds },
                createdAt: timestamp,
                updatedAt: timestamp,
              }),
            );
          });
        }
        await this.db.outlineNodes.bulkAdd(rows);
        return;
      }

      let story: SideStory;
      if (plan.appendToSideStoryId !== null) {
        const existing = await this.db.sideStories.get(plan.appendToSideStoryId);
        if (!existing || existing.novelId !== novelId) throw new Error('要追加的外传已不存在');
        // 追加不改外传的名称、简介与分叉点
        story = existing;
      } else {
        if (!live.has(plan.forkNodeId)) throw new Error('来源步骤不属于这个推演');
        const title = normalizeSideStoryTitle(plan.title);
        const key = sideStoryTitleKey(title);
        const siblings = await this.listSideStories(novelId);
        const duplicate = key
          ? siblings.find((s) => sideStoryTitleKey(s.title) === key)
          : undefined;
        if (duplicate) throw new Error(`已有同名外传『${duplicate.title}』`);
        story = SideStorySchema.parse({
          id: newId(),
          novelId,
          title,
          synopsis: plan.synopsis,
          order: siblings.length === 0 ? 0 : Math.max(...siblings.map((s) => s.order)) + 1,
          scenarioSource: { scenarioId: plan.scenarioId, forkNodeId: plan.forkNodeId },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await this.db.sideStories.add(story);
      }
      const track = chaptersOfTrack(
        await this.db.chapters.where('novelId').equals(novelId).toArray(),
        story.id,
      );
      const offset = track.reduce((max, chapter) => Math.max(max, chapter.index), 0);
      const chapters = plan.chapters.map((chapter, i) => {
        requireNodes(chapter.nodeIds);
        return ChapterSchema.parse({
          id: newId(),
          novelId,
          outlineNodeId: null,
          index: offset + i + 1,
          title: chapter.title,
          content: '',
          wordCount: 0,
          status: 'draft',
          source: 'ai',
          sideStoryId: story.id,
          // 外传不挂大纲树，逐章细纲挂在章节上
          scenarioSource: {
            scenarioId: plan.scenarioId,
            nodeIds: chapter.nodeIds,
            brief: chapter.brief,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      });
      await this.db.chapters.bulkAdd(chapters);
    });
  }

  /**
   * 合并导入整棵替换推演 scenarioId 的节点后，清理本地行里指向已不存在步骤的引用（设计 §4.2 末尾）。
   * 不清理的话合并之后导出的每一份备份都恢复不了，作者只在真要恢复时才发现。
   * - 大纲节点 / 章节：nodeIds 去掉不存在的，一个不剩时 scenarioSource = null（节点与正文保留）；
   * - 外传：分叉节点不在了就解除关联（外传与章节保留）；
   * - 限定条目：去掉 fromNodeId 指向已删节点的 target，而不是改成 null —— 那会让「只在某分支出现的人物」
   *   变成整个推演可见。targets 因此为空时进回收站（作用范围原样保留：空 targets 不合 schema）。
   * 只在 merge 分支调用：replace 整份来自快照，superRefine 已保证一致
   */
  private async pruneScenarioRefs(novelId: string, scenarioId: string): Promise<void> {
    const live = new Set(
      await this.db.scenarioNodes.where('scenarioId').equals(scenarioId).primaryKeys(),
    );
    const timestamp = now();

    const prune = <T extends { scenarioSource: { scenarioId: string; nodeIds: string[] } | null }>(
      rows: T[],
    ): T[] =>
      rows.flatMap((row) => {
        const source = row.scenarioSource;
        if (!source || source.scenarioId !== scenarioId) return [];
        const nodeIds = source.nodeIds.filter((id) => live.has(id));
        if (nodeIds.length === source.nodeIds.length) return [];
        return [
          {
            ...row,
            scenarioSource: nodeIds.length === 0 ? null : { ...source, nodeIds },
            updatedAt: timestamp,
          },
        ];
      });
    const outline = prune(await this.db.outlineNodes.where('novelId').equals(novelId).toArray());
    if (outline.length > 0) await this.db.outlineNodes.bulkPut(outline);
    const chapters = prune(await this.db.chapters.where('novelId').equals(novelId).toArray());
    if (chapters.length > 0) await this.db.chapters.bulkPut(chapters);

    const stories = (await this.db.sideStories.where('novelId').equals(novelId).toArray())
      .filter(
        (story) =>
          story.scenarioSource?.scenarioId === scenarioId &&
          !live.has(story.scenarioSource.forkNodeId),
      )
      .map((story) => ({ ...story, scenarioSource: null, updatedAt: timestamp }));
    if (stories.length > 0) await this.db.sideStories.bulkPut(stories);

    const entries: KnowledgeEntry[] = [];
    for (const entry of await this.db.entries.where('novelId').equals(novelId).toArray()) {
      const scope = entry.scope;
      if (scope?.kind !== 'limited') continue;
      const kept = scope.targets.filter(
        (target) =>
          target.scenarioId !== scenarioId ||
          (target.fromNodeId ?? null) === null ||
          live.has(target.fromNodeId!),
      );
      if (kept.length === scope.targets.length) continue;
      if (kept.length === 0) {
        if (entry.deletedAt === null)
          entries.push({ ...entry, deletedAt: timestamp, updatedAt: timestamp });
      } else {
        entries.push({ ...entry, scope: { kind: 'limited', targets: kept }, updatedAt: timestamp });
      }
    }
    if (entries.length > 0) await this.db.entries.bulkPut(entries);
  }

  // ================================================================ 章节摘要

  async listSummaries(novelId: string): Promise<ChapterSummary[]> {
    return this.db.chapterSummaries.where('novelId').equals(novelId).toArray();
  }

  async getSummaryByChapter(chapterId: string): Promise<ChapterSummary | undefined> {
    return this.db.chapterSummaries.where('chapterId').equals(chapterId).first();
  }

  async upsertSummary(
    novelId: string,
    chapterId: string,
    input: Partial<ChapterSummary>,
  ): Promise<ChapterSummary> {
    const current = await this.getSummaryByChapter(chapterId);
    const timestamp = now();
    const next = ChapterSummarySchema.parse({
      ...(current ?? { id: newId(), createdAt: timestamp }),
      ...stripProtected(input),
      novelId,
      chapterId,
      updatedAt: timestamp,
    });
    await this.db.chapterSummaries.put(next);
    return next;
  }

  // ================================================================ 风格档案

  async getStyleProfile(novelId: string): Promise<StyleProfile | undefined> {
    return this.db.styleProfiles.where('novelId').equals(novelId).first();
  }

  async upsertStyleProfile(novelId: string, patch: Partial<StyleProfile>): Promise<StyleProfile> {
    const current = await this.getStyleProfile(novelId);
    const timestamp = now();
    const next = StyleProfileSchema.parse({
      ...(current ?? { id: newId(), createdAt: timestamp }),
      ...stripProtected(patch),
      novelId,
      updatedAt: timestamp,
    });
    await this.db.styleProfiles.put(next);
    return next;
  }

  // ================================================================ Proposal

  async listProposals(
    novelId: string,
    query?: { status?: Proposal['status']; batchId?: string },
  ): Promise<Proposal[]> {
    let rows = await this.db.proposals.where('novelId').equals(novelId).toArray();
    if (query?.status) rows = rows.filter((p) => p.status === query.status);
    if (query?.batchId) rows = rows.filter((p) => p.batchId === query.batchId);
    // id 作为最后的决胜条件，保证排序在任何情况下都是确定的
    return rows.sort(
      (a, b) => a.createdAt - b.createdAt || a.order - b.order || a.id.localeCompare(b.id),
    );
  }

  async createProposals(items: Proposal[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.proposals.bulkAdd(items.map((item) => ProposalSchema.parse(item)));
  }

  async updateProposal(id: string, patch: Partial<Proposal>): Promise<Proposal> {
    const current = await this.db.proposals.get(id);
    if (!current) throw new Error(`Proposal 不存在：${id}`);
    const next = ProposalSchema.parse({ ...current, ...stripProtected(patch) });
    await this.db.proposals.put(next);
    return next;
  }

  async deleteProposal(id: string): Promise<void> {
    await this.db.proposals.delete(id);
  }

  // ================================================================ 写作计划

  async getPlan(novelId: string): Promise<WritingPlan | undefined> {
    return this.db.plans.where('novelId').equals(novelId).first();
  }

  async upsertPlan(novelId: string, patch: Partial<WritingPlan>): Promise<WritingPlan> {
    const current = await this.getPlan(novelId);
    const timestamp = now();
    const next = WritingPlanSchema.parse({
      ...(current ?? { id: newId(), createdAt: timestamp, startDate: toLocalDate() }),
      ...stripProtected(patch),
      novelId,
      updatedAt: timestamp,
    });
    await this.db.plans.put(next);
    return next;
  }

  async listDailyLogs(
    novelId: string,
    range?: { from?: string; to?: string },
  ): Promise<DailyLog[]> {
    let rows = await this.db.dailyLogs.where('novelId').equals(novelId).toArray();
    if (range?.from) rows = rows.filter((log) => log.date >= range.from!);
    if (range?.to) rows = rows.filter((log) => log.date <= range.to!);
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }

  async addDailyProgress(
    novelId: string,
    date: string,
    delta: { words?: number; chaptersCompleted?: number },
  ): Promise<DailyLog> {
    return this.db.transaction('rw', this.db.dailyLogs, async () => {
      const current = await this.db.dailyLogs
        .where('[novelId+date]')
        .equals([novelId, date])
        .first();
      const next = DailyLogSchema.parse({
        id: current?.id ?? newId(),
        novelId,
        date,
        words: (current?.words ?? 0) + (delta.words ?? 0),
        chaptersCompleted: (current?.chaptersCompleted ?? 0) + (delta.chaptersCompleted ?? 0),
        updatedAt: now(),
      });
      await this.db.dailyLogs.put(next);
      return next;
    });
  }

  // ================================================================ 旧稿导入任务

  async getImportJob(novelId: string): Promise<ImportJob | undefined> {
    // &novelId 唯一索引，一本书同时只有一个导入任务
    return this.db.importJobs.where('novelId').equals(novelId).first();
  }

  async upsertImportJob(novelId: string, patch: Partial<ImportJob>): Promise<ImportJob> {
    const current = await this.getImportJob(novelId);
    const timestamp = now();
    const next = ImportJobSchema.parse({
      ...(current ?? { id: newId(), createdAt: timestamp }),
      ...stripProtected(patch),
      novelId,
      updatedAt: timestamp,
    });
    await this.db.importJobs.put(next);
    return next;
  }

  async deleteImportJob(novelId: string): Promise<void> {
    await this.db.importJobs.where('novelId').equals(novelId).delete();
  }

  /**
   * 事务内读任务并 safeParse。读取路径不做 parse，库里可能躺着迁移时原样留下的坏行；
   * 阶段写入只认 parse 得过的行，坏行一律视同没有任务。
   */
  private async readParsedImportJob(novelId: string): Promise<ImportJob | undefined> {
    const raw = await this.db.importJobs.where('novelId').equals(novelId).first();
    if (!raw) return undefined;
    const parsed = ImportJobSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * 导入任务阶段写入的公共前置检查（commitImportChapters / commitImportWorldview 第 1 步）。
   * 「目的地提交至多一次」靠的是库里的状态：先读再写必须在同一个事务里才挡得住跨标签页。
   */
  private async requireDraftJob(novelId: string): Promise<ImportJob> {
    const job = await this.readParsedImportJob(novelId);
    if (!job) throw new Error('没有进行中的导入任务');
    if (job.destination !== null) throw new Error('这批稿件已经写入过了');
    if (job.drafts.length === 0) throw new Error('没有可写入的章节');
    return job;
  }

  async saveImportDrafts(
    novelId: string,
    input: { batchId: string; drafts: ImportDraft[]; expectedJobId: string | null },
  ): Promise<ImportJob> {
    return this.db.transaction('rw', this.db.importJobs, async () => {
      const raw = await this.db.importJobs.where('novelId').equals(novelId).first();
      // parse 不过的残留坏行视同没有任务，不能挡住下一次导入
      const parsed = raw ? ImportJobSchema.safeParse(raw) : undefined;
      if (parsed?.success) {
        // 那个任务认领着已写入的章节和进行中的提取，绝不覆盖
        if (parsed.data.destination !== null) {
          throw new Error('已有一批稿件在提取中，先完成或放弃它');
        }
        // 可能是另一个标签页正在翻译、已经付过钱的草稿
        if (parsed.data.id !== input.expectedJobId) {
          throw new Error('另一处已经有一批稿件在处理中');
        }
      }
      const timestamp = now();
      // 新 id：让「同一个分章页重试」和「另一处的草稿」分得开
      const next = ImportJobSchema.parse({
        id: newId(),
        novelId,
        batchId: input.batchId,
        destination: null,
        drafts: input.drafts,
        chapters: [],
        worldviewChunks: [],
        entryDrafts: [],
        openThreads: [],
        rollingSummary: '',
        status: 'paused',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      // novelId 是唯一索引，新 id 的行写入前要先删掉旧行
      await this.db.importJobs.where('novelId').equals(novelId).delete();
      await this.db.importJobs.put(next);
      return next;
    });
  }

  async patchImportDrafts(
    novelId: string,
    patches: {
      index: number;
      patch: Partial<
        Pick<
          ImportDraft,
          | 'content'
          | 'sourceContent'
          | 'sourceLanguage'
          | 'translateStatus'
          | 'translateError'
          | 'translationPlan'
        >
      >;
    }[],
  ): Promise<ImportJob> {
    return this.db.transaction('rw', this.db.importJobs, async () => {
      const job = await this.readParsedImportJob(novelId);
      // 和 upsertImportJob 最要紧的区别：不在草稿阶段就拒绝，绝不新建行。
      // 放弃或提交之后，迟到的旧写入不能凭空造出任务，也不能给已提交的任务塞回草稿
      if (!job || job.destination !== null) {
        throw new Error('这批稿件已经不在翻译阶段了');
      }
      // 合并到库里当前的 drafts，不是调用方手里的副本：两个实例各译各的章，结果都要留下
      const drafts = job.drafts.map((draft) => ({ ...draft }));
      for (const { index, patch } of patches) {
        const at = drafts.findIndex((draft) => draft.index === index);
        if (at === -1) throw new Error(`找不到第 ${index} 章草稿`);
        const current = drafts[at]!;
        // 已译的草稿只读：译文是付过钱的，迟到的「标记失败」或误点的「重试」都不能伤到它。
        // 忽略不算错误
        if (current.translateStatus === 'done') continue;
        const next = { ...current };
        if (patch.content !== undefined) next.content = patch.content;
        if (patch.sourceContent !== undefined) next.sourceContent = patch.sourceContent;
        if (patch.sourceLanguage !== undefined) next.sourceLanguage = patch.sourceLanguage;
        if (patch.translateStatus !== undefined) next.translateStatus = patch.translateStatus;
        if (patch.translateError !== undefined) next.translateError = patch.translateError;
        if (patch.translationPlan !== undefined) next.translationPlan = patch.translationPlan;
        drafts[at] = next;
      }
      const saved = ImportJobSchema.parse({ ...job, drafts, updatedAt: now() });
      await this.db.importJobs.put(saved);
      return saved;
    });
  }

  async commitImportChapters(
    novelId: string,
    input: {
      target:
        | { kind: 'main' }
        | { kind: 'side'; sideStoryId: string }
        | { kind: 'newSide'; title: string };
      withStyle: boolean;
    },
  ): Promise<{ job: ImportJob; sideStory: SideStory | null }> {
    const tables = [
      this.db.importJobs,
      this.db.chapters,
      this.db.sideStories,
      this.db.chapterSummaries,
      this.db.novels,
    ];
    // 写章节与推进任务同成同败：中途失败不能留下没有任务认领的孤儿章节
    return this.db.transaction('rw', tables, async () => {
      const job = await this.requireDraftJob(novelId);
      const timestamp = now();

      let sideStory: SideStory | null = null;
      const { target } = input;
      if (target.kind === 'side') {
        const story = await this.db.sideStories.get(target.sideStoryId);
        if (!story || story.novelId !== novelId) {
          throw new Error('所选外传已不存在，可能已被删除');
        }
        sideStory = story;
      } else if (target.kind === 'newSide') {
        const title = normalizeSideStoryTitle(target.title);
        const key = sideStoryTitleKey(title);
        const existing = await this.listSideStories(novelId);
        const duplicate = key
          ? existing.find((s) => sideStoryTitleKey(s.title) === key)
          : undefined;
        if (duplicate) throw new Error(`已有同名外传『${duplicate.title}』`);
        sideStory = SideStorySchema.parse({
          title,
          id: newId(),
          novelId,
          order: existing.length === 0 ? 0 : Math.max(...existing.map((s) => s.order)) + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await this.db.sideStories.add(sideStory);
      }
      const sideStoryId = sideStory?.id ?? null;

      // 编号在事务内重新计算，以库里为准（界面上的「从第 M 章接着编号」只是预告）
      const track = chaptersOfTrack(
        await this.db.chapters.where('novelId').equals(novelId).toArray(),
        sideStoryId,
      );
      const offset = track.reduce((max, chapter) => Math.max(max, chapter.index), 0);
      const chapters = job.drafts.map((draft) =>
        ChapterSchema.parse({
          id: newId(),
          novelId,
          outlineNodeId: null,
          index: offset + draft.index,
          title: draft.title,
          content: draft.content,
          sourceContent: draft.sourceContent,
          sourceLanguage: draft.sourceLanguage,
          wordCount: countWords(draft.content),
          // 旧稿是写完的文字，直接记为已完成：否则进度看板会把几十万字算成待写
          status: 'done',
          source: 'imported',
          sideStoryId,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      await this.db.chapters.bulkAdd(chapters);

      // 链的起始状态按线取：主线接全书进展，外传接它自己的进展
      const rollingSummary =
        sideStory !== null
          ? sideStory.rollingSummary
          : ((await this.db.novels.get(novelId))?.rollingSummary ?? '');
      // 伏笔接本线 index 最大、且有摘要的那一章
      const summaries = await this.db.chapterSummaries.where('novelId').equals(novelId).toArray();
      const summaryByChapter = new Map(summaries.map((s) => [s.chapterId, s]));
      const lastSummarized = [...track].reverse().find((c) => summaryByChapter.has(c.id));
      const openThreads = lastSummarized
        ? (summaryByChapter.get(lastSummarized.id)?.openThreads ?? [])
        : [];

      const destination =
        sideStoryId !== null ? { kind: 'side' as const, sideStoryId } : { kind: 'main' as const };
      const saved = ImportJobSchema.parse({
        ...job,
        destination,
        drafts: [],
        worldviewChunks: [],
        withSummaries: true,
        withStyle: input.withStyle,
        status: 'paused',
        rollingSummary,
        openThreads,
        // 按草稿顺序一一对应；不会出现 pending / failed 翻译状态，恢复时正靠这一点识别旧版任务
        chapters: job.drafts.map((draft, i) => ({
          index: chapters[i]!.index,
          title: draft.title,
          chapterId: chapters[i]!.id,
          status: 'pending',
          error: '',
          translateStatus: draft.translateStatus === 'done' ? 'done' : 'none',
          translateError: '',
        })),
        updatedAt: timestamp,
      });
      await this.db.importJobs.put(saved);
      return { job: saved, sideStory };
    });
  }

  async commitImportWorldview(
    novelId: string,
    input: { chunks: ImportWorldviewChunk[] },
  ): Promise<ImportJob> {
    // 只开 importJobs：「世界观不写 Chapter」在事务范围上也成立
    return this.db.transaction('rw', this.db.importJobs, async () => {
      const job = await this.requireDraftJob(novelId);
      if (input.chunks.length === 0) throw new Error('没有可提取的内容');
      const saved = ImportJobSchema.parse({
        ...job,
        destination: { kind: 'worldview' },
        worldviewChunks: input.chunks,
        drafts: [],
        chapters: [],
        withSummaries: false,
        withStyle: false,
        rollingSummary: '',
        openThreads: [],
        status: 'paused',
        updatedAt: now(),
      });
      await this.db.importJobs.put(saved);
      return saved;
    });
  }

  // ================================================================ 译名表

  async getGlossary(novelId: string): Promise<Glossary | undefined> {
    return this.db.glossaries.where('novelId').equals(novelId).first();
  }

  /**
   * 合并译名的三个方法都走同一条写入路径。
   *
   * 合并规则（先到先得 / 覆盖 / 删除）来自 domain，在这里执行而不是交给调用方：
   * 批量翻译、单章翻译、译名表界面三处都要写，规则散出去必然有一处写漏。
   */
  private async writeGlossary(
    novelId: string,
    next: (current: GlossaryEntryData[]) => GlossaryEntryData[],
  ): Promise<Glossary> {
    return this.db.transaction('rw', this.db.glossaries, async () => {
      const current = await this.db.glossaries.where('novelId').equals(novelId).first();
      const timestamp = now();
      const row = GlossarySchema.parse({
        ...(current ?? { id: newId(), createdAt: timestamp }),
        novelId,
        terms: next(current?.terms ?? []),
        updatedAt: timestamp,
      });
      await this.db.glossaries.put(row);
      return row;
    });
  }

  async mergeGlossaryTerms(novelId: string, incoming: GlossaryEntryData[]): Promise<Glossary> {
    return this.writeGlossary(novelId, (current) => mergeGlossary(current, incoming));
  }

  async setGlossaryTerm(novelId: string, source: string, target: string): Promise<Glossary> {
    return this.writeGlossary(novelId, (current) => setGlossaryEntry(current, source, target));
  }

  async removeGlossaryTerm(novelId: string, source: string): Promise<Glossary> {
    return this.writeGlossary(novelId, (current) => removeGlossaryEntry(current, source));
  }

  // ================================================================ 备份

  /** 逐表全量导出。包含软删除的条目，否则恢复后回收站会凭空清空 */
  async exportSnapshot(): Promise<RepositorySnapshot> {
    const [
      novels,
      categories,
      entries,
      outlineNodes,
      chapters,
      chapterSummaries,
      styleProfiles,
      proposals,
      plans,
      dailyLogs,
      importJobs,
      glossaries,
      sideStories,
      writingNorms,
      scenarios,
      scenarioNodes,
    ] = await Promise.all([
      this.db.novels.toArray(),
      this.db.categories.toArray(),
      this.db.entries.toArray(),
      this.db.outlineNodes.toArray(),
      this.db.chapters.toArray(),
      this.db.chapterSummaries.toArray(),
      this.db.styleProfiles.toArray(),
      this.db.proposals.toArray(),
      this.db.plans.toArray(),
      this.db.dailyLogs.toArray(),
      this.db.importJobs.toArray(),
      this.db.glossaries.toArray(),
      this.db.sideStories.toArray(),
      this.db.writingNorms.toArray(),
      this.db.scenarios.toArray(),
      this.db.scenarioNodes.toArray(),
    ]);
    return {
      novels,
      categories,
      entries,
      outlineNodes,
      chapters,
      chapterSummaries,
      styleProfiles,
      proposals,
      plans,
      dailyLogs,
      importJobs,
      glossaries,
      sideStories,
      writingNorms,
      scenarios,
      scenarioNodes,
    };
  }

  async importSnapshot(snapshot: RepositorySnapshot, mode: 'replace' | 'merge'): Promise<void> {
    // 入参可能来自用户手改过的备份文件，落库前整份重新校验
    const data = RepositorySnapshotSchema.parse(snapshot);
    const tables = [
      this.db.novels,
      this.db.categories,
      this.db.entries,
      this.db.outlineNodes,
      this.db.chapters,
      this.db.chapterSummaries,
      this.db.styleProfiles,
      this.db.proposals,
      this.db.plans,
      this.db.dailyLogs,
      this.db.importJobs,
      this.db.glossaries,
      this.db.sideStories,
      this.db.writingNorms,
      this.db.scenarios,
      this.db.scenarioNodes,
    ];

    // 整份导入必须是一个事务：中途失败留下半套数据，比导入失败糟糕得多
    await this.db.transaction('rw', tables, async () => {
      if (mode === 'replace') {
        for (const table of tables) await table.clear();
      } else {
        /**
         * 合并按推演整棵替换节点，而不是逐行取并集：两台设备在同一选项下各推进了一步，
         * 并集后同一选项有两个子节点，本地新分支还会和备份带来的 mainNodeId 不一致。
         * 粒度与「推演行按 id 覆盖」一致，主线指针与树总是来自同一份快照；只在本地有的推演不动
         */
        for (const scenario of data.scenarios) {
          await this.db.scenarioNodes.where('scenarioId').equals(scenario.id).delete();
        }
      }
      await this.db.novels.bulkPut(data.novels);
      await this.db.categories.bulkPut(data.categories);
      await this.db.entries.bulkPut(data.entries);
      await this.db.outlineNodes.bulkPut(data.outlineNodes);
      await this.db.chapters.bulkPut(data.chapters);
      await this.db.chapterSummaries.bulkPut(data.chapterSummaries);
      await this.db.styleProfiles.bulkPut(data.styleProfiles);
      await this.db.proposals.bulkPut(data.proposals);
      await this.db.plans.bulkPut(data.plans);
      await this.db.dailyLogs.bulkPut(data.dailyLogs);
      await this.db.importJobs.bulkPut(data.importJobs);
      await this.db.glossaries.bulkPut(data.glossaries);
      await this.db.sideStories.bulkPut(data.sideStories);
      await this.db.writingNorms.bulkPut(data.writingNorms);
      await this.db.scenarios.bulkPut(data.scenarios);
      await this.db.scenarioNodes.bulkPut(data.scenarioNodes);
      if (mode === 'merge') {
        // 写完全部表之后再清理：被清理的只会是本地独有的行（来自备份的行由 superRefine 保证一致）
        for (const scenario of data.scenarios) {
          await this.pruneScenarioRefs(scenario.novelId, scenario.id);
        }
      }
    });
  }
}

/** 统计聚合，书架与详情页共用同一口径（定义在类外，纯函数便于复用） */
function computeStats(
  novelId: string,
  chapters: Chapter[],
  entries: KnowledgeEntry[],
  proposals: Proposal[],
): NovelStats {
  const ownChapters = chapters.filter((c) => c.novelId === novelId);
  // 章数与完成数只看主线（「第 N 章 / 共 M 章」的口径）；字数是写下的全部文字，含外传
  const mainChapters = ownChapters.filter(isMainChapter);
  const ownEntries = entries.filter((e) => e.novelId === novelId && e.deletedAt === null);
  const ownPending = proposals.filter((p) => p.novelId === novelId && p.status === 'pending');
  return {
    chapterCount: mainChapters.length,
    doneChapterCount: mainChapters.filter((c) => c.status === 'done').length,
    sideChapterCount: ownChapters.length - mainChapters.length,
    wordCount: ownChapters.reduce((sum, c) => sum + c.wordCount, 0),
    entryCount: ownEntries.length,
    pendingProposalCount: ownPending.length,
  };
}
