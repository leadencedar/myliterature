import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countWords } from '@/domain/primitives';
import {
  emptyDelta,
  type ImportDraft,
  type ImportJob,
  type ImportWorldviewChunk,
  type ScenarioNode,
  type ScenarioOption,
  type WritingNorm,
  type WritingNormScope,
} from '@/domain/schema';
import type {
  OutlineTreeInputNode,
  ScenarioNodeInput,
  ScenarioSetupInput,
} from '@/data/NovelRepository';
import { buildBackupFile, parseBackup, serializeBackup } from '@/features/export/backup';
import { AppDatabase } from './db';
import { DexieNovelRepository } from './DexieNovelRepository';

let database: AppDatabase;
let repo: DexieNovelRepository;

beforeEach(async () => {
  // 每个用例一个独立库，避免用例间互相污染
  database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  repo = new DexieNovelRepository(database);
});

afterEach(async () => {
  database.close();
  await database.delete();
});

async function seedNovel(title = '测试之书') {
  return repo.createNovel({ title });
}

/** 大纲子树入参：只描述内容，id / 顺序 / 时间戳由仓储在事务里生成 */
function treeInput(
  title: string,
  children: OutlineTreeInputNode[] = [],
  extra: { synopsis?: string; targetWords?: number | null; linkedEntryIds?: string[] } = {},
): OutlineTreeInputNode {
  return {
    title,
    synopsis: extra.synopsis ?? '',
    targetWords: extra.targetWords ?? null,
    ...(extra.linkedEntryIds ? { linkedEntryIds: extra.linkedEntryIds } : {}),
    children,
  };
}

describe('小说 CRUD', () => {
  it('创建小说时补齐默认值、内置分类与风格档案', async () => {
    const novel = await repo.createNovel({ title: '归墟' });

    expect(novel.id).toBeTruthy();
    expect(novel.oneLiner).toBe('');
    expect(novel.pov).toBe('third-limited');
    expect(novel.status).toBe('planning');
    expect(novel.deletedAt).toBeNull();
    expect(novel.createdAt).toBe(novel.updatedAt);

    const categories = await repo.listCategories(novel.id);
    expect(categories.map((c) => c.name)).toEqual(['世界观设定', '人物']);
    expect(categories.every((c) => c.builtin)).toBe(true);
    // 字段模板必须随分类一起落库，否则新建条目时无表单可渲染
    expect(categories[0]?.fieldTemplate.length).toBeGreaterThan(0);

    const style = await repo.getStyleProfile(novel.id);
    expect(style).toBeDefined();
    expect(style?.methodology).toBe('three-act');
  });

  it('书名为空时拒绝创建', async () => {
    await expect(repo.createNovel({ title: '' })).rejects.toThrow();
  });

  it('按 updatedAt 倒序列出，且排除软删除', async () => {
    const older = await repo.createNovel({ title: '旧书' });
    const newer = await repo.createNovel({ title: '新书' });
    const hidden = await repo.createNovel({ title: '已删' });

    // 直接改表来构造确定的时间序，避免依赖执行耗时
    await database.novels.update(older.id, { updatedAt: 1_000 });
    await database.novels.update(newer.id, { updatedAt: 2_000 });
    await database.novels.update(hidden.id, { updatedAt: 3_000, deletedAt: 3_000 });

    const list = await repo.listNovels();
    expect(list.map((n) => n.title)).toEqual(['新书', '旧书']);

    const withDeleted = await repo.listNovels({ includeDeleted: true });
    expect(withDeleted).toHaveLength(3);
  });

  it('更新小说会刷新 updatedAt，且不允许改 id 与 createdAt', async () => {
    const novel = await seedNovel();
    await database.novels.update(novel.id, { updatedAt: 1_000 });

    const updated = await repo.updateNovel(novel.id, {
      title: '改名之后',
      id: 'hacked',
      createdAt: 0,
    } as Partial<typeof novel>);

    expect(updated.id).toBe(novel.id);
    expect(updated.createdAt).toBe(novel.createdAt);
    expect(updated.title).toBe('改名之后');
    expect(updated.updatedAt).toBeGreaterThan(1_000);
  });

  it('更新不存在的小说时报错', async () => {
    await expect(repo.updateNovel('nope', { title: 'x' })).rejects.toThrow('小说不存在');
  });

  it('删除小说会级联清理全部从属数据', async () => {
    const novel = await seedNovel();
    const categories = await repo.listCategories(novel.id);
    const categoryId = categories[0]!.id;

    await repo.createEntry(novel.id, { categoryId, title: '灵气' });
    const node = await repo.createOutlineNode(novel.id, { title: '第一幕' });
    const chapter = await repo.createChapter(novel.id, { title: '第一章', content: '正文' });
    await repo.upsertSummary(novel.id, chapter.id, { summary: '摘要' });
    await repo.upsertPlan(novel.id, { target: 1 });
    await repo.addDailyProgress(novel.id, '2026-01-01', { words: 100 });
    await repo.createProposals([
      {
        id: crypto.randomUUID(),
        novelId: novel.id,
        batchId: null,
        order: 0,
        origin: 'generate',
        target: 'knowledgeEntry',
        action: 'create',
        targetId: null,
        label: '人物 · 某人',
        payload: {},
        diff: [],
        sourceRef: '',
        status: 'pending',
        createdAt: Date.now(),
        decidedAt: null,
      },
    ]);
    expect(node.id).toBeTruthy();

    await repo.deleteNovel(novel.id);

    expect(await repo.getNovel(novel.id)).toBeUndefined();
    expect(await repo.listCategories(novel.id)).toHaveLength(0);
    expect(await repo.listEntries(novel.id)).toHaveLength(0);
    expect(await repo.listOutline(novel.id)).toHaveLength(0);
    expect(await repo.listChapters(novel.id)).toHaveLength(0);
    expect(await repo.listSummaries(novel.id)).toHaveLength(0);
    expect(await repo.getStyleProfile(novel.id)).toBeUndefined();
    expect(await repo.getPlan(novel.id)).toBeUndefined();
    expect(await repo.listDailyLogs(novel.id)).toHaveLength(0);
    expect(await repo.listProposals(novel.id)).toHaveLength(0);
  });

  it('删除一本书不影响另一本', async () => {
    const keep = await repo.createNovel({ title: '留下' });
    const drop = await repo.createNovel({ title: '删掉' });
    const keepCategory = (await repo.listCategories(keep.id))[0]!;
    await repo.createEntry(keep.id, { categoryId: keepCategory.id, title: '保留条目' });

    await repo.deleteNovel(drop.id);

    expect(await repo.getNovel(keep.id)).toBeDefined();
    expect(await repo.listCategories(keep.id)).toHaveLength(2);
    expect(await repo.listEntries(keep.id)).toHaveLength(1);
  });
});

describe('书架统计', () => {
  it('聚合章节数、字数、条目数与待审数量', async () => {
    const novel = await seedNovel();
    const categoryId = (await repo.listCategories(novel.id))[0]!.id;

    await repo.createChapter(novel.id, { content: '一二三四五', status: 'done' });
    await repo.createChapter(novel.id, { content: '六七八', status: 'draft' });
    await repo.createEntry(novel.id, { categoryId, title: '条目一' });
    const removed = await repo.createEntry(novel.id, { categoryId, title: '条目二' });
    await repo.softDeleteEntry(removed.id);

    const items = await repo.listShelfItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.stats).toEqual({
      chapterCount: 2,
      doneChapterCount: 1,
      sideChapterCount: 0,
      wordCount: 8,
      // 软删除的条目不计入
      entryCount: 1,
      pendingProposalCount: 0,
    });

    // 单本查询与书架聚合必须同一口径
    expect(await repo.getNovelStats(novel.id)).toEqual(items[0]?.stats);
  });

  it('没有小说时返回空数组', async () => {
    expect(await repo.listShelfItems()).toEqual([]);
  });
});

describe('分类', () => {
  it('新建自定义分类时自动排在末尾', async () => {
    const novel = await seedNovel();
    const created = await repo.createCategory(novel.id, { name: '势力' });

    expect(created.builtin).toBe(false);
    expect(created.order).toBe(2);
    const all = await repo.listCategories(novel.id);
    expect(all.map((c) => c.name)).toEqual(['世界观设定', '人物', '势力']);
  });

  it('内置分类不可删除', async () => {
    const novel = await seedNovel();
    const builtin = (await repo.listCategories(novel.id))[0]!;
    await expect(repo.deleteCategory(builtin.id)).rejects.toThrow('内置分类不可删除');
  });

  it('分类下有条目时拒绝删除', async () => {
    const novel = await seedNovel();
    const category = await repo.createCategory(novel.id, { name: '道具' });
    await repo.createEntry(novel.id, { categoryId: category.id, title: '青铜镜' });

    await expect(repo.deleteCategory(category.id)).rejects.toThrow('还有 1 个条目');
  });

  it('空的自定义分类可以删除', async () => {
    const novel = await seedNovel();
    const category = await repo.createCategory(novel.id, { name: '地点' });
    await repo.deleteCategory(category.id);
    expect(await repo.listCategories(novel.id)).toHaveLength(2);
  });

  it('不能通过更新把内置分类改成非内置', async () => {
    const novel = await seedNovel();
    const builtin = (await repo.listCategories(novel.id))[0]!;
    const updated = await repo.updateCategory(builtin.id, { builtin: false, name: '世界设定' });

    expect(updated.builtin).toBe(true);
    expect(updated.name).toBe('世界设定');
  });
});

describe('知识条目', () => {
  async function setup() {
    const novel = await seedNovel();
    const categories = await repo.listCategories(novel.id);
    return { novel, worldId: categories[0]!.id, charId: categories[1]!.id };
  }

  it('创建条目时补齐默认值', async () => {
    const { novel, charId } = await setup();
    const entry = await repo.createEntry(novel.id, { categoryId: charId, title: '林越' });

    expect(entry.aliases).toEqual([]);
    expect(entry.fields).toEqual({});
    expect(entry.pinned).toBe(false);
    expect(entry.version).toBe(1);
    expect(entry.deletedAt).toBeNull();
  });

  it('按分类与 pinned 过滤', async () => {
    const { novel, worldId, charId } = await setup();
    await repo.createEntry(novel.id, { categoryId: worldId, title: '灵气', pinned: true });
    await repo.createEntry(novel.id, { categoryId: charId, title: '林越' });

    expect(await repo.listEntries(novel.id, { categoryId: worldId })).toHaveLength(1);
    const pinned = await repo.listEntries(novel.id, { pinnedOnly: true });
    expect(pinned.map((e) => e.title)).toEqual(['灵气']);
  });

  it('搜索覆盖标题、别名、摘要与字段值', async () => {
    const { novel, charId } = await setup();
    await repo.createEntry(novel.id, {
      categoryId: charId,
      title: '林越',
      aliases: ['阿越'],
      summary: '少年剑客',
      fields: { identity: '流亡贵族' },
    });
    await repo.createEntry(novel.id, { categoryId: charId, title: '沈清' });

    expect(await repo.listEntries(novel.id, { search: '阿越' })).toHaveLength(1);
    expect(await repo.listEntries(novel.id, { search: '剑客' })).toHaveLength(1);
    expect(await repo.listEntries(novel.id, { search: '流亡' })).toHaveLength(1);
    expect(await repo.listEntries(novel.id, { search: '不存在' })).toHaveLength(0);
  });

  it('软删除后默认不出现，可恢复', async () => {
    const { novel, charId } = await setup();
    const entry = await repo.createEntry(novel.id, { categoryId: charId, title: '林越' });

    await repo.softDeleteEntry(entry.id);
    expect(await repo.listEntries(novel.id)).toHaveLength(0);
    expect(await repo.listEntries(novel.id, { includeDeleted: true })).toHaveLength(1);

    await repo.restoreEntry(entry.id);
    expect(await repo.listEntries(novel.id)).toHaveLength(1);
  });

  it('硬删除后彻底消失', async () => {
    const { novel, charId } = await setup();
    const entry = await repo.createEntry(novel.id, { categoryId: charId, title: '临时' });
    await repo.hardDeleteEntry(entry.id);
    expect(await repo.listEntries(novel.id, { includeDeleted: true })).toHaveLength(0);
  });

  describe('按名称匹配（反向提取去重的基础）', () => {
    it('命中标题，忽略大小写与首尾空白', async () => {
      const { novel, charId } = await setup();
      await repo.createEntry(novel.id, { categoryId: charId, title: 'Lin Yue' });

      expect(await repo.findEntryByName(novel.id, '  lin yue ')).toBeDefined();
    });

    it('命中别名', async () => {
      const { novel, charId } = await setup();
      await repo.createEntry(novel.id, {
        categoryId: charId,
        title: '林越',
        aliases: ['阿越', '越哥'],
      });

      expect((await repo.findEntryByName(novel.id, '越哥'))?.title).toBe('林越');
    });

    it('软删除的条目不参与匹配', async () => {
      const { novel, charId } = await setup();
      const entry = await repo.createEntry(novel.id, { categoryId: charId, title: '林越' });
      await repo.softDeleteEntry(entry.id);

      expect(await repo.findEntryByName(novel.id, '林越')).toBeUndefined();
    });

    it('空名称与跨书不匹配', async () => {
      const { novel, charId } = await setup();
      const other = await repo.createNovel({ title: '另一本' });
      await repo.createEntry(novel.id, { categoryId: charId, title: '林越' });

      expect(await repo.findEntryByName(novel.id, '   ')).toBeUndefined();
      expect(await repo.findEntryByName(other.id, '林越')).toBeUndefined();
    });
  });
});

describe('大纲', () => {
  it('同层新增时自动递增 order', async () => {
    const novel = await seedNovel();
    const first = await repo.createOutlineNode(novel.id, { title: '第一幕' });
    const second = await repo.createOutlineNode(novel.id, { title: '第二幕' });
    const child = await repo.createOutlineNode(novel.id, { title: '第一章', parentId: first.id });

    expect(first.order).toBe(0);
    expect(second.order).toBe(1);
    // 子层独立计数
    expect(child.order).toBe(0);
  });

  it('删除节点时级联删除子树并解除章节关联', async () => {
    const novel = await seedNovel();
    const act = await repo.createOutlineNode(novel.id, { title: '第一幕' });
    const chapterNode = await repo.createOutlineNode(novel.id, {
      title: '第一章',
      parentId: act.id,
    });
    const grandchild = await repo.createOutlineNode(novel.id, {
      title: '第一节',
      parentId: chapterNode.id,
    });
    const survivor = await repo.createOutlineNode(novel.id, { title: '第二幕' });
    const chapter = await repo.createChapter(novel.id, {
      title: '第一章',
      outlineNodeId: grandchild.id,
    });

    await repo.deleteOutlineNode(act.id);

    const remaining = await repo.listOutline(novel.id);
    expect(remaining.map((n) => n.id)).toEqual([survivor.id]);
    // 正文是用户资产，节点删了也要留着，只解除关联
    const keptChapter = await repo.getChapter(chapter.id);
    expect(keptChapter).toBeDefined();
    expect(keptChapter?.outlineNodeId).toBeNull();
  });

  it('批量重排写入新的父子与顺序', async () => {
    const novel = await seedNovel();
    const a = await repo.createOutlineNode(novel.id, { title: 'A' });
    const b = await repo.createOutlineNode(novel.id, { title: 'B' });

    await repo.reorderOutline([
      { id: b.id, parentId: null, order: 0 },
      { id: a.id, parentId: b.id, order: 0 },
    ]);

    const nodes = await repo.listOutline(novel.id);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(b.id)?.order).toBe(0);
    expect(byId.get(a.id)?.parentId).toBe(b.id);
  });

  it('重排时忽略不存在的 id', async () => {
    const novel = await seedNovel();
    const a = await repo.createOutlineNode(novel.id, { title: 'A' });
    await expect(
      repo.reorderOutline([
        { id: a.id, parentId: null, order: 5 },
        { id: 'ghost', parentId: null, order: 0 },
      ]),
    ).resolves.toBeUndefined();
    expect((await repo.listOutline(novel.id))[0]?.order).toBe(5);
  });
});

describe('大纲子树事务（commitOutlineSubtree）', () => {
  it('追加：接在现有兄弟之后，父先落库子节点拿到 parentId，按前序返回', async () => {
    const novel = await seedNovel();
    const anchor = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    const existing = await repo.createOutlineNode(novel.id, {
      title: '旧第一章',
      parentId: anchor.id,
    });

    const created = await repo.commitOutlineSubtree(
      novel.id,
      anchor.id,
      [treeInput('第一章', [treeInput('第一节')]), treeInput('第二章')],
      'append',
    );

    // 前序：父在子之前，同层按入参顺序
    expect(created.map((node) => node.title)).toEqual(['第一章', '第一节', '第二章']);
    expect(created[0]).toMatchObject({ parentId: anchor.id, order: 1 });
    expect(created[1]).toMatchObject({ parentId: created[0]!.id, order: 0 });
    expect(created[2]).toMatchObject({ parentId: anchor.id, order: 2 });

    const nodes = await repo.listOutline(novel.id);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(created.every((node) => byId.has(node.id))).toBe(true);
    expect(byId.get(existing.id)?.order).toBe(0);
    expect(nodes.filter((node) => node.parentId === anchor.id)).toHaveLength(3);
  });

  it('追加：anchor 为 null 时接在顶层末尾（立项建树）', async () => {
    const novel = await seedNovel();
    const firstRoot = await repo.createOutlineNode(novel.id, { title: '旧卷一' });

    const created = await repo.commitOutlineSubtree(
      novel.id,
      null,
      [treeInput('卷一', [treeInput('第一章')]), treeInput('卷二')],
      'append',
    );

    expect(created.map((node) => node.order)).toEqual([1, 0, 2]);
    expect(created[0]!.parentId).toBeNull();
    expect(created[1]!.parentId).toBe(created[0]!.id);
    const roots = (await repo.listOutline(novel.id)).filter((node) => node.parentId === null);
    expect(roots.sort((a, b) => a.order - b.order).map((node) => node.title)).toEqual([
      '旧卷一',
      '卷一',
      '卷二',
    ]);
    expect(roots.find((node) => node.id === firstRoot.id)).toBeDefined();
  });

  it('替换：删除锚点下整棵子树并解除章节关联，锚点与其他分支保留', async () => {
    const novel = await seedNovel();
    const anchor = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    const oldChapter = await repo.createOutlineNode(novel.id, {
      title: '旧章',
      parentId: anchor.id,
      linkedEntryIds: ['entry-old'],
    });
    const oldSection = await repo.createOutlineNode(novel.id, {
      title: '旧节',
      parentId: oldChapter.id,
    });
    // 锚点之外的节点不应被 replace 波及
    const otherVolume = await repo.createOutlineNode(novel.id, { title: '第二卷' });
    const otherChapter = await repo.createOutlineNode(novel.id, {
      title: '第二章',
      parentId: otherVolume.id,
    });
    const chapter = await repo.createChapter(novel.id, {
      title: '旧章正文',
      outlineNodeId: oldSection.id,
    });

    const created = await repo.commitOutlineSubtree(
      novel.id,
      anchor.id,
      [treeInput('新章', [treeInput('新节')])],
      'replace',
    );

    const nodes = await repo.listOutline(novel.id);
    const ids = new Set(nodes.map((node) => node.id));
    // 旧子层连同孙节点一起消失，锚点自身保留
    expect(ids.has(oldChapter.id)).toBe(false);
    expect(ids.has(oldSection.id)).toBe(false);
    expect(ids.has(anchor.id)).toBe(true);
    expect(ids.has(otherVolume.id)).toBe(true);
    expect(ids.has(otherChapter.id)).toBe(true);
    expect(nodes.filter((node) => node.parentId === anchor.id)).toHaveLength(1);
    expect(created.map((node) => node.title)).toEqual(['新章', '新节']);
    expect(created[0]).toMatchObject({ parentId: anchor.id, order: 0 });
    expect(created[1]).toMatchObject({ parentId: created[0]!.id, order: 0 });

    // 正文是用户资产：只解除关联，不删章节
    const kept = await repo.getChapter(chapter.id);
    expect(kept).toBeDefined();
    expect(kept?.outlineNodeId).toBeNull();
  });

  it('整本替换（anchor 为 null）：清掉全部旧根与子树、解链章节，再按顶层重建', async () => {
    const novel = await seedNovel();
    const oldRoot = await repo.createOutlineNode(novel.id, { title: '旧第一卷' });
    const oldChapter = await repo.createOutlineNode(novel.id, {
      title: '旧第一章',
      parentId: oldRoot.id,
      linkedEntryIds: ['entry-old'],
    });
    const chapter = await repo.createChapter(novel.id, {
      title: '旧章正文',
      outlineNodeId: oldChapter.id,
    });

    const created = await repo.commitOutlineSubtree(
      novel.id,
      null,
      [treeInput('新第一卷', [treeInput('新第一章')]), treeInput('新第二卷')],
      'replace',
    );

    const nodes = await repo.listOutline(novel.id);
    // 旧根与旧子节点都被清掉，新树无重复
    expect(nodes.map((node) => node.id).sort()).toEqual(created.map((node) => node.id).sort());
    expect(nodes).toHaveLength(3);
    const roots = nodes.filter((node) => node.parentId === null).sort((a, b) => a.order - b.order);
    expect(roots.map((node) => node.title)).toEqual(['新第一卷', '新第二卷']);
    expect(roots.map((node) => node.order)).toEqual([0, 1]);
    expect(nodes.filter((node) => node.parentId === created[0]!.id)).toHaveLength(1);
    expect(created.map((node) => node.title)).toEqual(['新第一卷', '新第一章', '新第二卷']);

    const kept = await repo.getChapter(chapter.id);
    expect(kept?.outlineNodeId).toBeNull();
  });

  it('nodes 为空时抛错，且不删除任何旧节点', async () => {
    const novel = await seedNovel();
    const anchor = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    const child = await repo.createOutlineNode(novel.id, {
      title: '旧章',
      parentId: anchor.id,
    });

    await expect(repo.commitOutlineSubtree(novel.id, anchor.id, [], 'replace')).rejects.toThrow(
      '大纲内容为空',
    );
    await expect(repo.commitOutlineSubtree(novel.id, null, [], 'append')).rejects.toThrow(
      '大纲内容为空',
    );

    const nodes = await repo.listOutline(novel.id);
    expect(nodes.map((node) => node.id)).toContain(child.id);
  });

  it('anchor 不存在或属于别的书时抛错，什么都不写', async () => {
    const novel = await seedNovel();
    const other = await seedNovel('另一本书');
    const foreign = await repo.createOutlineNode(other.id, { title: '别处的卷' });

    await expect(
      repo.commitOutlineSubtree(novel.id, 'ghost', [treeInput('新章')], 'append'),
    ).rejects.toThrow('已不存在');
    await expect(
      repo.commitOutlineSubtree(novel.id, foreign.id, [treeInput('新章')], 'append'),
    ).rejects.toThrow('已不存在');
    await expect(
      repo.commitOutlineSubtree(novel.id, foreign.id, [treeInput('新章')], 'replace'),
    ).rejects.toThrow('已不存在');

    expect(await repo.listOutline(novel.id)).toHaveLength(0);
    // 别的书的大纲也不能被跨书删除
    expect((await repo.listOutline(other.id)).map((node) => node.id)).toEqual([foreign.id]);
  });

  it('替换中途失败整体回滚：旧子树、章节关联都还在，新节点一个也不留', async () => {
    const novel = await seedNovel();
    const anchor = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    const oldChapter = await repo.createOutlineNode(novel.id, {
      title: '旧章',
      parentId: anchor.id,
    });
    const chapter = await repo.createChapter(novel.id, {
      title: '正文',
      outlineNodeId: oldChapter.id,
    });

    // 第一棵子树合法（已写入），第二棵标题为空在 parse 时失败 —— 整批必须回滚
    await expect(
      repo.commitOutlineSubtree(
        novel.id,
        anchor.id,
        [treeInput('合法新章'), { ...treeInput('坏章'), title: '' }],
        'replace',
      ),
    ).rejects.toThrow();

    const nodes = await repo.listOutline(novel.id);
    expect(nodes.map((node) => node.id)).toContain(oldChapter.id);
    expect(nodes.some((node) => node.title === '合法新章')).toBe(false);
    expect((await repo.getChapter(chapter.id))?.outlineNodeId).toBe(oldChapter.id);
  });

  it('整本替换中途失败时回滚，不留半棵树', async () => {
    const novel = await seedNovel();
    const oldRoot = await repo.createOutlineNode(novel.id, { title: '旧第一卷' });
    const oldChapter = await repo.createOutlineNode(novel.id, {
      title: '旧第一章',
      parentId: oldRoot.id,
    });
    const chapter = await repo.createChapter(novel.id, {
      title: '正文',
      outlineNodeId: oldChapter.id,
    });

    // 新树的第一个根合法、其子节点标题为空：删除旧树与建新树必须是同一个原子单元
    await expect(
      repo.commitOutlineSubtree(
        novel.id,
        null,
        [treeInput('新第一卷', [{ ...treeInput('坏章'), title: '' }])],
        'replace',
      ),
    ).rejects.toThrow();

    const nodes = await repo.listOutline(novel.id);
    expect(nodes.map((node) => node.id).sort()).toEqual([oldRoot.id, oldChapter.id].sort());
    expect((await repo.getChapter(chapter.id))?.outlineNodeId).toBe(oldChapter.id);
  });

  it('内容字段与预留的 linkedEntryIds 原样落库（M3 用）', async () => {
    const novel = await seedNovel();

    const created = await repo.commitOutlineSubtree(
      novel.id,
      null,
      [
        treeInput('第一章', [], {
          synopsis: '主角在渡口等人。',
          targetWords: 6000,
          linkedEntryIds: ['entry-shenyan', 'entry-peizhao'],
        }),
      ],
      'append',
    );

    expect(created[0]).toMatchObject({
      title: '第一章',
      synopsis: '主角在渡口等人。',
      targetWords: 6000,
      linkedEntryIds: ['entry-shenyan', 'entry-peizhao'],
      status: 'planned',
    });
    expect((await repo.listOutline(novel.id))[0]?.linkedEntryIds).toEqual([
      'entry-shenyan',
      'entry-peizhao',
    ]);
  });
});

describe('大纲关联批量写（updateOutlineLinks）', () => {
  it('一次写入多个节点的关联，标题/梗概/顺序都不动', async () => {
    const novel = await seedNovel();
    const a = await repo.createOutlineNode(novel.id, {
      title: 'A',
      synopsis: '梗概 A',
      targetWords: 3000,
      linkedEntryIds: ['entry-old'],
    });
    const b = await repo.createOutlineNode(novel.id, { title: 'B' });

    await repo.updateOutlineLinks([
      { id: a.id, linkedEntryIds: ['entry-1', 'entry-2'] },
      { id: b.id, linkedEntryIds: [] },
    ]);

    const byId = new Map((await repo.listOutline(novel.id)).map((node) => [node.id, node]));
    expect(byId.get(a.id)).toMatchObject({
      title: 'A',
      synopsis: '梗概 A',
      targetWords: 3000,
      order: 0,
      linkedEntryIds: ['entry-1', 'entry-2'],
    });
    expect(byId.get(b.id)?.linkedEntryIds).toEqual([]);
  });

  it('任一 id 不存在时整批失败，已存在的节点保持原关联', async () => {
    const novel = await seedNovel();
    const a = await repo.createOutlineNode(novel.id, {
      title: 'A',
      linkedEntryIds: ['entry-old'],
    });

    await expect(
      repo.updateOutlineLinks([
        { id: a.id, linkedEntryIds: ['entry-1'] },
        { id: 'ghost', linkedEntryIds: ['entry-2'] },
      ]),
    ).rejects.toThrow('大纲节点不存在');

    // 回滚：不能留下「前一个节点已写、后一个失败」的半套关联
    expect((await repo.listOutline(novel.id))[0]?.linkedEntryIds).toEqual(['entry-old']);
  });

  it('空数组是 no-op', async () => {
    await expect(repo.updateOutlineLinks([])).resolves.toBeUndefined();
  });
});

describe('章节', () => {
  it('index 自动递增，字数由正文推导', async () => {
    const novel = await seedNovel();
    const first = await repo.createChapter(novel.id, { content: '你好 世界' });
    const second = await repo.createChapter(novel.id, {});

    expect(first.index).toBe(1);
    expect(second.index).toBe(2);
    // 「你好世界」= 4 字，空白不计入
    expect(first.wordCount).toBe(4);
  });

  it('更新正文时重算字数，且忽略外部传入的 wordCount', async () => {
    const novel = await seedNovel();
    const chapter = await repo.createChapter(novel.id, { content: '短' });

    const updated = await repo.updateChapter(chapter.id, {
      content: '一二三四五六七八九十',
      wordCount: 9999,
    });

    expect(updated.wordCount).toBe(10);
  });

  it('删除章节时一并删除其摘要', async () => {
    const novel = await seedNovel();
    const chapter = await repo.createChapter(novel.id, { content: '正文' });
    await repo.upsertSummary(novel.id, chapter.id, { summary: '摘要' });

    await repo.deleteChapter(chapter.id);

    expect(await repo.getChapter(chapter.id)).toBeUndefined();
    expect(await repo.getSummaryByChapter(chapter.id)).toBeUndefined();
  });

  it('按 index 升序返回', async () => {
    const novel = await seedNovel();
    await repo.createChapter(novel.id, { index: 3, title: '三' });
    await repo.createChapter(novel.id, { index: 1, title: '一' });
    await repo.createChapter(novel.id, { index: 2, title: '二' });

    expect((await repo.listChapters(novel.id)).map((c) => c.title)).toEqual(['一', '二', '三']);
  });
});

describe('外传', () => {
  it('新建时标题归一化，按 order 排在末尾', async () => {
    const novel = await seedNovel();
    const first = await repo.createSideStory(novel.id, { title: '  外传·青冥旧事 ' });
    const second = await repo.createSideStory(novel.id, { title: '番外：雪夜', synopsis: '简介' });

    expect(first).toMatchObject({ title: '青冥旧事', synopsis: '', rollingSummary: '', order: 0 });
    expect(second).toMatchObject({ title: '雪夜', synopsis: '简介', order: 1 });
    expect((await repo.listSideStories(novel.id)).map((s) => s.title)).toEqual([
      '青冥旧事',
      '雪夜',
    ]);
  });

  it('重名拒绝：含只差大小写、只差「外传·」前缀', async () => {
    const novel = await seedNovel();
    await repo.createSideStory(novel.id, { title: '青冥旧事' });
    await repo.createSideStory(novel.id, { title: 'Arc' });

    await expect(repo.createSideStory(novel.id, { title: '外传·青冥旧事' })).rejects.toThrow(
      '已有同名外传『青冥旧事』',
    );
    await expect(repo.createSideStory(novel.id, { title: 'arc' })).rejects.toThrow(
      '已有同名外传『Arc』',
    );
    expect(await repo.listSideStories(novel.id)).toHaveLength(2);
  });

  it('不同作品之间可以同名', async () => {
    const a = await seedNovel('甲');
    const b = await seedNovel('乙');
    await repo.createSideStory(a.id, { title: '青冥旧事' });
    await expect(repo.createSideStory(b.id, { title: '青冥旧事' })).resolves.toBeDefined();
  });

  it('不合法的标题与简介抛 schema 的中文 message', async () => {
    const novel = await seedNovel();
    await expect(repo.createSideStory(novel.id, { title: '外传·' })).rejects.toThrow(
      '外传名称不能为空',
    );
    await expect(repo.createSideStory(novel.id, { title: '长'.repeat(41) })).rejects.toThrow(
      '外传名称不能超过 40 字',
    );
    await expect(
      repo.createSideStory(novel.id, { title: '简介太长', synopsis: '字'.repeat(2001) }),
    ).rejects.toThrow('外传简介不能超过 2000 字');
  });

  it('updateSideStory：只改自身大小写或前缀不算重名，与别的外传重名被拒', async () => {
    const novel = await seedNovel();
    const arc = await repo.createSideStory(novel.id, { title: 'Arc' });
    await repo.createSideStory(novel.id, { title: '雪夜' });

    expect((await repo.updateSideStory(arc.id, { title: 'arc' })).title).toBe('arc');
    expect((await repo.updateSideStory(arc.id, { title: '外传·ARC' })).title).toBe('ARC');
    await expect(repo.updateSideStory(arc.id, { title: '番外·雪夜' })).rejects.toThrow(
      '已有同名外传『雪夜』',
    );
    expect((await repo.getSideStory(arc.id))?.title).toBe('ARC');
  });

  it('updateSideStory：patch 里的 order / novelId / id / createdAt 被剥掉', async () => {
    const novel = await seedNovel();
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });

    const updated = await repo.updateSideStory(story.id, {
      rollingSummary: '进展',
      order: 99,
      novelId: 'other',
      id: 'hijack',
      createdAt: 123,
    } as Parameters<typeof repo.updateSideStory>[1]);

    expect(updated).toMatchObject({
      id: story.id,
      novelId: novel.id,
      order: story.order,
      createdAt: story.createdAt,
      rollingSummary: '进展',
    });
    expect(await repo.getSideStory('hijack')).toBeUndefined();
  });

  it('updateSideStory：外传不存在时报错', async () => {
    await expect(repo.updateSideStory('ghost', { rollingSummary: 'x' })).rejects.toThrow(
      '这部外传已不存在，可能已被删除',
    );
  });

  it('getSideStory 返回最新值，不存在时为 undefined', async () => {
    const novel = await seedNovel();
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    await repo.updateSideStory(story.id, { synopsis: '新简介', rollingSummary: '新进展' });

    expect(await repo.getSideStory(story.id)).toMatchObject({
      synopsis: '新简介',
      rollingSummary: '新进展',
    });
    expect(await repo.getSideStory('ghost')).toBeUndefined();
  });

  it('删除外传级联删除其章节与摘要，主线与别的外传不受影响', async () => {
    const novel = await seedNovel();
    const doomed = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    const kept = await repo.createSideStory(novel.id, { title: '雪夜' });
    const main = await repo.createChapter(novel.id, { content: '主线' });
    const side1 = await repo.createChapter(novel.id, { sideStoryId: doomed.id, content: '外一' });
    const side2 = await repo.createChapter(novel.id, { sideStoryId: doomed.id, content: '外二' });
    const other = await repo.createChapter(novel.id, { sideStoryId: kept.id, content: '雪' });
    for (const c of [main, side1, side2, other]) {
      await repo.upsertSummary(novel.id, c.id, { summary: c.content });
    }

    await repo.deleteSideStory(doomed.id);

    expect(await repo.getSideStory(doomed.id)).toBeUndefined();
    expect((await repo.listChapters(novel.id)).map((c) => c.id).sort()).toEqual(
      [main.id, other.id].sort(),
    );
    expect(await repo.getSummaryByChapter(side1.id)).toBeUndefined();
    expect(await repo.getSummaryByChapter(side2.id)).toBeUndefined();
    expect((await repo.getSummaryByChapter(main.id))?.summary).toBe('主线');
    expect((await repo.getSummaryByChapter(other.id))?.summary).toBe('雪');
    expect(await repo.listSideStories(novel.id)).toHaveLength(1);
  });

  it('删除不存在的外传静默返回', async () => {
    await expect(repo.deleteSideStory('ghost')).resolves.toBeUndefined();
  });

  it('createChapter 按线编号：主线 1..3 与外传 1..2 互不影响', async () => {
    const novel = await seedNovel();
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });

    const m1 = await repo.createChapter(novel.id, {});
    const s1 = await repo.createChapter(novel.id, { sideStoryId: story.id });
    const m2 = await repo.createChapter(novel.id, {});
    const s2 = await repo.createChapter(novel.id, { sideStoryId: story.id });
    const m3 = await repo.createChapter(novel.id, {});

    expect([m1.index, m2.index, m3.index]).toEqual([1, 2, 3]);
    expect([s1.index, s2.index]).toEqual([1, 2]);
    expect([m1, m2, m3].every((c) => c.sideStoryId === null)).toBe(true);
    expect([s1, s2].every((c) => c.sideStoryId === story.id)).toBe(true);
    // listChapters 语义不变：返回全部章节
    expect(await repo.listChapters(novel.id)).toHaveLength(5);
  });

  it('createChapter：外传不存在或属于别的作品时拒绝', async () => {
    const novel = await seedNovel('甲');
    const other = await seedNovel('乙');
    const foreign = await repo.createSideStory(other.id, { title: '别人的外传' });

    await expect(repo.createChapter(novel.id, { sideStoryId: 'ghost' })).rejects.toThrow(
      '外传不存在',
    );
    await expect(repo.createChapter(novel.id, { sideStoryId: foreign.id })).rejects.toThrow(
      '外传不存在',
    );
    expect(await repo.listChapters(novel.id)).toEqual([]);
  });

  it('createChapter：外传章节关联大纲时拒绝', async () => {
    const novel = await seedNovel();
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    const node = await repo.createOutlineNode(novel.id, { title: '第一卷' });

    await expect(
      repo.createChapter(novel.id, { sideStoryId: story.id, outlineNodeId: node.id }),
    ).rejects.toThrow('外传章节不能关联大纲节点');
  });

  it('updateChapter 改不了 sideStoryId（静默剥掉，其余字段照常保存）', async () => {
    const novel = await seedNovel();
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    const main = await repo.createChapter(novel.id, { content: '主线' });
    const side = await repo.createChapter(novel.id, { sideStoryId: story.id, content: '外传' });

    const movedMain = await repo.updateChapter(main.id, {
      sideStoryId: story.id,
      content: '改过的主线',
    });
    const movedSide = await repo.updateChapter(side.id, {
      ...side,
      sideStoryId: null,
      title: '新',
    });

    expect(movedMain).toMatchObject({ sideStoryId: null, content: '改过的主线' });
    expect(movedSide).toMatchObject({ sideStoryId: story.id, title: '新' });
  });

  it('updateChapter：给外传章节设 outlineNodeId 被拒绝，主线章节照常', async () => {
    const novel = await seedNovel();
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    const node = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    const main = await repo.createChapter(novel.id, {});
    const side = await repo.createChapter(novel.id, { sideStoryId: story.id });

    await expect(repo.updateChapter(side.id, { outlineNodeId: node.id })).rejects.toThrow(
      '外传章节不能关联大纲节点',
    );
    expect((await repo.getChapter(side.id))?.outlineNodeId).toBeNull();
    // 带 outlineNodeId: null 的整对象保存不受影响
    await expect(repo.updateChapter(side.id, { ...side, content: '正文' })).resolves.toMatchObject({
      content: '正文',
    });
    expect((await repo.updateChapter(main.id, { outlineNodeId: node.id })).outlineNodeId).toBe(
      node.id,
    );
  });

  it('computeStats：章数与完成数只算主线，sideChapterCount 为外传章数，字数含外传', async () => {
    const novel = await seedNovel();
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    await repo.createChapter(novel.id, { content: '一二三', status: 'done' });
    await repo.createChapter(novel.id, { content: '四五', status: 'draft' });
    await repo.createChapter(novel.id, { sideStoryId: story.id, content: '外传', status: 'done' });

    const stats = await repo.getNovelStats(novel.id);
    expect(stats).toMatchObject({
      chapterCount: 2,
      doneChapterCount: 1,
      sideChapterCount: 1,
      wordCount: 7,
    });
    expect((await repo.listShelfItems())[0]?.stats).toEqual(stats);
  });

  it('deleteNovel 带走外传', async () => {
    const novel = await seedNovel();
    const keep = await seedNovel('留下的书');
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    const kept = await repo.createSideStory(keep.id, { title: '雪夜' });
    await repo.createChapter(novel.id, { sideStoryId: story.id });

    await repo.deleteNovel(novel.id);

    expect(await repo.getSideStory(story.id)).toBeUndefined();
    expect(await repo.listChapters(novel.id)).toEqual([]);
    expect(await repo.getSideStory(kept.id)).toBeDefined();
  });

  it('快照导出与导入（replace / merge）包含外传', async () => {
    const novel = await seedNovel();
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    const chapter = await repo.createChapter(novel.id, { sideStoryId: story.id, content: '外' });
    const snapshot = await repo.exportSnapshot();
    expect(snapshot.sideStories.map((s) => s.id)).toEqual([story.id]);

    for (const mode of ['replace', 'merge'] as const) {
      const other = new AppDatabase(`test-${crypto.randomUUID()}`);
      await other.open();
      const otherRepo = new DexieNovelRepository(other);
      const existing = await otherRepo.createNovel({ title: '本机的书' });
      const local = await otherRepo.createSideStory(existing.id, { title: '本机外传' });

      await otherRepo.importSnapshot(snapshot, mode);

      expect(await otherRepo.getSideStory(story.id)).toEqual(story);
      expect((await otherRepo.getChapter(chapter.id))?.sideStoryId).toBe(story.id);
      if (mode === 'replace') {
        expect(await otherRepo.getSideStory(local.id)).toBeUndefined();
      } else {
        expect(await otherRepo.getSideStory(local.id)).toBeDefined();
      }

      other.close();
      await other.delete();
    }
  });

  it('导入快照时拒绝指向不存在外传的章节，原有数据不变', async () => {
    const novel = await seedNovel();
    const snapshot = await repo.exportSnapshot();
    const broken = {
      ...snapshot,
      chapters: [
        {
          id: 'c-dangling',
          novelId: novel.id,
          outlineNodeId: null,
          index: 1,
          title: '',
          content: '',
          sourceContent: '',
          sourceLanguage: '',
          wordCount: 0,
          status: 'draft' as const,
          source: 'manual' as const,
          sideStoryId: 'ghost',
          scenarioSource: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };

    await expect(repo.importSnapshot(broken, 'replace')).rejects.toThrow('找不到所属外传');
    expect((await repo.getNovel(novel.id))?.title).toBe('测试之书');
  });
});

describe('章节摘要', () => {
  it('同一章节重复 upsert 只保留一条并就地更新', async () => {
    const novel = await seedNovel();
    const chapter = await repo.createChapter(novel.id, { content: '正文' });

    const first = await repo.upsertSummary(novel.id, chapter.id, {
      summary: '初版',
      openThreads: ['谁是凶手'],
    });
    const second = await repo.upsertSummary(novel.id, chapter.id, { summary: '修订版' });

    expect(second.id).toBe(first.id);
    expect(second.summary).toBe('修订版');
    expect(await repo.listSummaries(novel.id)).toHaveLength(1);
  });
});

describe('风格档案', () => {
  it('一本书只有一份档案，重复 upsert 就地更新', async () => {
    const novel = await seedNovel();
    const created = await repo.getStyleProfile(novel.id);

    const updated = await repo.upsertStyleProfile(novel.id, {
      tradition: 'web',
      subGenre: '仙侠',
      methodology: 'web-rhythm',
      voiceRefs: [{ refId: 'gulong', name: '古龙', weight: 70 }],
    });

    expect(updated.id).toBe(created?.id);
    expect(updated.subGenre).toBe('仙侠');
    expect(updated.voiceRefs).toHaveLength(1);
  });

  it('拒绝超过两位名家风格参考', async () => {
    const novel = await seedNovel();
    await expect(
      repo.upsertStyleProfile(novel.id, {
        voiceRefs: [
          { refId: 'a', name: '甲', weight: 50 },
          { refId: 'b', name: '乙', weight: 50 },
          { refId: 'c', name: '丙', weight: 50 },
        ],
      }),
    ).rejects.toThrow();
  });
});

describe('Proposal', () => {
  async function makeProposal(novelId: string, overrides: Record<string, unknown> = {}) {
    const id = crypto.randomUUID();
    await repo.createProposals([
      {
        id,
        novelId,
        batchId: null,
        order: 0,
        origin: 'generate',
        target: 'knowledgeEntry',
        action: 'create',
        targetId: null,
        label: '条目',
        payload: { title: '某物' },
        diff: [],
        sourceRef: '',
        status: 'pending',
        createdAt: Date.now(),
        decidedAt: null,
        ...overrides,
      },
    ]);
    return id;
  }

  it('按状态与批次过滤', async () => {
    const novel = await seedNovel();
    await makeProposal(novel.id);
    await makeProposal(novel.id, { status: 'accepted', batchId: 'batch-1' });

    expect(await repo.listProposals(novel.id)).toHaveLength(2);
    expect(await repo.listProposals(novel.id, { status: 'pending' })).toHaveLength(1);
    expect(await repo.listProposals(novel.id, { batchId: 'batch-1' })).toHaveLength(1);
  });

  it('可更新状态与删除', async () => {
    const novel = await seedNovel();
    const id = await makeProposal(novel.id);

    const updated = await repo.updateProposal(id, { status: 'rejected', decidedAt: 123 });
    expect(updated.status).toBe('rejected');

    await repo.deleteProposal(id);
    expect(await repo.listProposals(novel.id)).toHaveLength(0);
  });
});

describe('写作计划与日志', () => {
  it('一本书一份计划，重复 upsert 就地更新', async () => {
    const novel = await seedNovel();
    const first = await repo.upsertPlan(novel.id, { mode: 'chaptersPerDay', target: 1 });
    const second = await repo.upsertPlan(novel.id, { mode: 'wordsPerDay', target: 3000 });

    expect(second.id).toBe(first.id);
    expect(second.mode).toBe('wordsPerDay');
    expect(second.target).toBe(3000);
    expect(second.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('当日产出按日期累加而不是覆盖', async () => {
    const novel = await seedNovel();

    await repo.addDailyProgress(novel.id, '2026-03-01', { words: 1200 });
    await repo.addDailyProgress(novel.id, '2026-03-01', { words: 800, chaptersCompleted: 1 });
    const log = await repo.addDailyProgress(novel.id, '2026-03-02', { words: 500 });

    const logs = await repo.listDailyLogs(novel.id);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ date: '2026-03-01', words: 2000, chaptersCompleted: 1 });
    expect(log.words).toBe(500);
  });

  it('按日期区间筛选日志', async () => {
    const novel = await seedNovel();
    await repo.addDailyProgress(novel.id, '2026-03-01', { words: 1 });
    await repo.addDailyProgress(novel.id, '2026-03-05', { words: 1 });
    await repo.addDailyProgress(novel.id, '2026-03-10', { words: 1 });

    const ranged = await repo.listDailyLogs(novel.id, { from: '2026-03-02', to: '2026-03-06' });
    expect(ranged.map((l) => l.date)).toEqual(['2026-03-05']);
  });
});

describe('旧稿导入任务', () => {
  it('一本书只有一个导入任务，重复 upsert 复用同一条记录', async () => {
    const novel = await seedNovel();
    expect(await repo.getImportJob(novel.id)).toBeUndefined();

    const created = await repo.upsertImportJob(novel.id, { withSummaries: true });
    expect(created.id).toBeTruthy();
    expect(created.novelId).toBe(novel.id);
    expect(created.status).toBe('paused');
    expect(created.chapters).toEqual([]);
    expect(created.entryDrafts).toEqual([]);
    expect(created.openThreads).toEqual([]);
    expect(created.rollingSummary).toBe('');

    const updated = await repo.upsertImportJob(novel.id, { status: 'running' });
    expect(updated.id).toBe(created.id);
    expect(updated.status).toBe('running');
    // 未在 patch 里出现的字段必须保留，否则断点续跑会丢进度
    expect(updated.withSummaries).toBe(true);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('逐章推进的进度与累计草稿完整往返', async () => {
    const novel = await seedNovel();
    const categoryId = (await repo.listCategories(novel.id))[0]!.id;
    const chapter = await repo.createChapter(novel.id, { title: '第一章' });

    await repo.upsertImportJob(novel.id, {
      chapters: [
        {
          index: 1,
          title: '第一章',
          chapterId: chapter.id,
          status: 'pending',
          error: '',
          translateStatus: 'none',
          translateError: '',
        },
      ],
    });
    const job = await repo.upsertImportJob(novel.id, {
      chapters: [
        {
          index: 1,
          title: '第一章',
          chapterId: chapter.id,
          status: 'done',
          error: '',
          translateStatus: 'none',
          translateError: '',
        },
      ],
      entryDrafts: [
        {
          key: '沈砚',
          categoryId,
          title: '沈砚',
          aliases: ['砚哥'],
          summary: '主角',
          fields: { 性格: '嘴硬心软' },
          sourceChapterIds: [chapter.id],
        },
      ],
      openThreads: ['母亲的玉佩下落不明'],
      rollingSummary: '沈砚离乡。',
    });

    const loaded = await repo.getImportJob(novel.id);
    expect(loaded?.chapters).toEqual([
      {
        index: 1,
        title: '第一章',
        chapterId: chapter.id,
        status: 'done',
        error: '',
        translateStatus: 'none',
        translateError: '',
      },
    ]);
    expect(loaded?.entryDrafts[0]).toMatchObject({
      key: '沈砚',
      aliases: ['砚哥'],
      fields: { 性格: '嘴硬心软' },
      sourceChapterIds: [chapter.id],
    });
    expect(loaded?.openThreads).toEqual(['母亲的玉佩下落不明']);
    expect(loaded?.rollingSummary).toBe('沈砚离乡。');
    expect(job.updatedAt).toBe(loaded?.updatedAt);
  });

  it('删除任务与删除小说都会清掉导入任务', async () => {
    const a = await seedNovel('甲');
    const b = await seedNovel('乙');
    await repo.upsertImportJob(a.id, {});
    await repo.upsertImportJob(b.id, {});

    await repo.deleteImportJob(a.id);
    expect(await repo.getImportJob(a.id)).toBeUndefined();
    // 只删指定小说的任务，不能连带别人
    expect(await repo.getImportJob(b.id)).toBeDefined();

    await repo.deleteNovel(b.id);
    expect(await repo.getImportJob(b.id)).toBeUndefined();
  });
});

describe('导入任务的阶段写入', () => {
  function importDraft(index: number, overrides: Partial<ImportDraft> = {}): ImportDraft {
    return {
      index,
      title: `第${index}节`,
      content: `第${index}节正文。`,
      sourceContent: '',
      sourceLanguage: '',
      translateStatus: 'none',
      translateError: '',
      ...overrides,
    };
  }

  const CHUNK: ImportWorldviewChunk = {
    index: 1,
    title: '地理',
    content: '归墟在极北。',
    status: 'pending',
    error: '',
  };

  async function seedDrafts(
    novelId: string,
    drafts: ImportDraft[] = [importDraft(1), importDraft(2)],
  ) {
    return repo.saveImportDrafts(novelId, { batchId: 'batch-1', drafts, expectedJobId: null });
  }

  /** 绕过仓储直接写一条 parse 不过的原始行 */
  async function putBadRow(novelId: string) {
    const raw = { id: 'bad-row', novelId, destination: { kind: 'bogus' }, drafts: 'oops' };
    await database.importJobs.put(raw as unknown as ImportJob);
    return raw;
  }

  describe('saveImportDrafts', () => {
    it('没有任务时新建草稿任务，其余数组为空', async () => {
      const novel = await seedNovel();
      const drafts = [importDraft(1), importDraft(2, { translateStatus: 'pending' })];

      const job = await seedDrafts(novel.id, drafts);

      expect(job).toMatchObject({
        novelId: novel.id,
        batchId: 'batch-1',
        destination: null,
        drafts,
        chapters: [],
        worldviewChunks: [],
        entryDrafts: [],
        openThreads: [],
      });
      expect(await repo.getImportJob(novel.id)).toEqual(job);
    });

    it('destination 为 null 且 expectedJobId 是库里那一行时整行覆盖，换新 id', async () => {
      const novel = await seedNovel();
      const first = await seedDrafts(novel.id);

      const second = await repo.saveImportDrafts(novel.id, {
        batchId: 'batch-2',
        drafts: [importDraft(1, { content: '新的分章' })],
        expectedJobId: first.id,
      });

      expect(second.id).not.toBe(first.id);
      expect(second.batchId).toBe('batch-2');
      expect(second.drafts).toHaveLength(1);
      expect(await database.importJobs.where('novelId').equals(novel.id).count()).toBe(1);
      expect(await repo.getImportJob(novel.id)).toEqual(second);
    });

    it('库里有别处的草稿任务时拒绝，草稿和译文都不变', async () => {
      const novel = await seedNovel();
      await seedDrafts(novel.id);
      const translated = await repo.patchImportDrafts(novel.id, [
        {
          index: 1,
          patch: { content: '译文', sourceContent: 'source', translateStatus: 'done' },
        },
      ]);

      for (const expectedJobId of [null, 'someone-else']) {
        await expect(
          repo.saveImportDrafts(novel.id, {
            batchId: 'batch-x',
            drafts: [importDraft(1)],
            expectedJobId,
          }),
        ).rejects.toThrow('另一处已经有一批稿件在处理中');
      }
      expect(await repo.getImportJob(novel.id)).toEqual(translated);
    });

    it('库里的任务已选了目的地时拒绝，任务不变', async () => {
      const novel = await seedNovel();
      const draftJob = await seedDrafts(novel.id);
      const { job } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'main' },
        withStyle: true,
      });

      await expect(
        repo.saveImportDrafts(novel.id, {
          batchId: 'batch-x',
          drafts: [importDraft(1)],
          expectedJobId: draftJob.id,
        }),
      ).rejects.toThrow('已有一批稿件在提取中，先完成或放弃它');
      expect(await repo.getImportJob(novel.id)).toEqual(job);
    });

    it('库里的行 parse 失败时不论 expectedJobId 都直接覆盖', async () => {
      for (const expectedJobId of [null, 'whatever']) {
        const novel = await seedNovel();
        await putBadRow(novel.id);

        const job = await repo.saveImportDrafts(novel.id, {
          batchId: 'batch-1',
          drafts: [importDraft(1)],
          expectedJobId,
        });

        expect(job.destination).toBeNull();
        expect(await repo.getImportJob(novel.id)).toEqual(job);
      }
    });
  });

  describe('patchImportDrafts', () => {
    it('任务已选了目的地时被拒，任务不变', async () => {
      const novel = await seedNovel();
      await seedDrafts(novel.id);
      const { job } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'main' },
        withStyle: true,
      });

      await expect(
        repo.patchImportDrafts(novel.id, [{ index: 1, patch: { translateStatus: 'pending' } }]),
      ).rejects.toThrow('这批稿件已经不在翻译阶段了');
      expect(await repo.getImportJob(novel.id)).toEqual(job);
    });

    it('没有任务时被拒，也不新建行', async () => {
      const novel = await seedNovel();

      await expect(
        repo.patchImportDrafts(novel.id, [{ index: 1, patch: { translateStatus: 'pending' } }]),
      ).rejects.toThrow('这批稿件已经不在翻译阶段了');
      expect(await repo.getImportJob(novel.id)).toBeUndefined();
    });

    it('库里的行 parse 失败时被拒，行不变', async () => {
      const novel = await seedNovel();
      const raw = await putBadRow(novel.id);

      await expect(
        repo.patchImportDrafts(novel.id, [{ index: 1, patch: { translateStatus: 'pending' } }]),
      ).rejects.toThrow('这批稿件已经不在翻译阶段了');
      expect(await database.importJobs.get('bad-row')).toEqual(raw);
    });

    it('已译的草稿只读：降级、改写正文与错误都被忽略，不抛错', async () => {
      const novel = await seedNovel();
      await seedDrafts(novel.id, [importDraft(1, { translateStatus: 'pending' })]);
      const translated = await repo.patchImportDrafts(novel.id, [
        {
          index: 1,
          patch: {
            content: '译文',
            sourceContent: 'source',
            sourceLanguage: '英文',
            translateStatus: 'done',
          },
        },
      ]);
      const done = translated.drafts[0]!;
      expect(done).toMatchObject({
        content: '译文',
        sourceContent: 'source',
        translateStatus: 'done',
      });

      for (const patch of [
        { translateStatus: 'pending' as const },
        { translateStatus: 'failed' as const, translateError: '迟到的失败' },
        { translateStatus: 'none' as const },
        { content: '被改写', sourceContent: '', sourceLanguage: '' },
      ]) {
        const result = await repo.patchImportDrafts(novel.id, [{ index: 1, patch }]);
        expect(result.drafts[0]).toEqual(done);
      }
      expect((await repo.getImportJob(novel.id))?.drafts[0]).toEqual(done);
    });

    it('两次调用各改不同的章，两处结果都保留', async () => {
      const novel = await seedNovel();
      await seedDrafts(novel.id, [
        importDraft(1, { translateStatus: 'pending' }),
        importDraft(2, { translateStatus: 'pending' }),
      ]);

      // 两个实例各自手里的副本都是旧的；第二次调用不传第一次的返回值
      await repo.patchImportDrafts(novel.id, [
        { index: 1, patch: { content: '一译', sourceContent: '一原', translateStatus: 'done' } },
      ]);
      const after = await repo.patchImportDrafts(novel.id, [
        { index: 2, patch: { content: '二译', sourceContent: '二原', translateStatus: 'done' } },
      ]);

      expect(after.drafts.map((d) => [d.content, d.translateStatus])).toEqual([
        ['一译', 'done'],
        ['二译', 'done'],
      ]);
    });

    it('找不到的章号被拒，同一次调用里的其他 patch 也没有写入', async () => {
      const novel = await seedNovel();
      const before = await seedDrafts(novel.id);

      await expect(
        repo.patchImportDrafts(novel.id, [
          { index: 1, patch: { translateStatus: 'pending' } },
          { index: 9, patch: { translateStatus: 'pending' } },
        ]),
      ).rejects.toThrow('找不到第 9 章草稿');
      expect(await repo.getImportJob(novel.id)).toEqual(before);
    });

    it('一次传多条 patch 全部生效；数组长度、destination、batchId 不变', async () => {
      const novel = await seedNovel();
      const before = await seedDrafts(novel.id, [
        importDraft(1, { translateStatus: 'pending' }),
        importDraft(2, { translateStatus: 'failed', translateError: '超时' }),
        importDraft(3),
      ]);

      const after = await repo.patchImportDrafts(novel.id, [
        { index: 1, patch: { translateStatus: 'none' } },
        { index: 2, patch: { translateStatus: 'none', translateError: '' } },
      ]);

      expect(after.drafts.map((d) => [d.index, d.translateStatus, d.translateError])).toEqual([
        [1, 'none', ''],
        [2, 'none', ''],
        [3, 'none', ''],
      ]);
      expect(after.id).toBe(before.id);
      expect(after.destination).toBeNull();
      expect(after.batchId).toBe(before.batchId);
      expect(after.drafts).toHaveLength(3);
      expect(await repo.getImportJob(novel.id)).toEqual(after);
    });
  });

  describe('commitImportWorldview', () => {
    it('写入后不产生任何章节，阶段字段符合阶段表', async () => {
      const novel = await seedNovel();
      const draftJob = await seedDrafts(novel.id);

      const job = await repo.commitImportWorldview(novel.id, { chunks: [CHUNK] });

      expect(await repo.listChapters(novel.id)).toEqual([]);
      expect(job).toMatchObject({
        id: draftJob.id,
        batchId: draftJob.batchId,
        destination: { kind: 'worldview' },
        worldviewChunks: [CHUNK],
        drafts: [],
        chapters: [],
        withSummaries: false,
        withStyle: false,
        rollingSummary: '',
        openThreads: [],
      });
      expect(await repo.getImportJob(novel.id)).toEqual(job);
    });

    it('任务已提交为主线时被拒，任务不变', async () => {
      const novel = await seedNovel();
      await seedDrafts(novel.id);
      const { job } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'main' },
        withStyle: true,
      });

      await expect(repo.commitImportWorldview(novel.id, { chunks: [CHUNK] })).rejects.toThrow(
        '这批稿件已经写入过了',
      );
      expect(await repo.getImportJob(novel.id)).toEqual(job);
    });

    it('第二次调用被拒', async () => {
      const novel = await seedNovel();
      await seedDrafts(novel.id);
      const job = await repo.commitImportWorldview(novel.id, { chunks: [CHUNK] });

      await expect(repo.commitImportWorldview(novel.id, { chunks: [CHUNK] })).rejects.toThrow(
        '这批稿件已经写入过了',
      );
      expect(await repo.getImportJob(novel.id)).toEqual(job);
    });

    it('chunks 为空被拒，任务不变', async () => {
      const novel = await seedNovel();
      const draftJob = await seedDrafts(novel.id);

      await expect(repo.commitImportWorldview(novel.id, { chunks: [] })).rejects.toThrow(
        '没有可提取的内容',
      );
      expect(await repo.getImportJob(novel.id)).toEqual(draftJob);
    });

    it('没有任务时被拒', async () => {
      const novel = await seedNovel();
      await expect(repo.commitImportWorldview(novel.id, { chunks: [CHUNK] })).rejects.toThrow(
        '没有进行中的导入任务',
      );
    });
  });

  describe('commitImportChapters', () => {
    it('主线从主线最大章号接续，忽略外传章节', async () => {
      const novel = await seedNovel();
      await repo.createChapter(novel.id, { title: '主一' });
      await repo.createChapter(novel.id, { title: '主二' });
      const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
      for (let i = 0; i < 5; i += 1) await repo.createChapter(novel.id, { sideStoryId: story.id });
      await seedDrafts(novel.id);

      const { job, sideStory } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'main' },
        withStyle: true,
      });

      expect(sideStory).toBeNull();
      const main = (await repo.listChapters(novel.id)).filter((c) => c.sideStoryId === null);
      expect(main.map((c) => [c.index, c.title])).toEqual([
        [1, '主一'],
        [2, '主二'],
        [3, '第1节'],
        [4, '第2节'],
      ]);
      expect(job.destination).toEqual({ kind: 'main' });
      expect(job.chapters.map((c) => c.index)).toEqual([3, 4]);
    });

    it('已有外传从外传内部接续', async () => {
      const novel = await seedNovel();
      for (let i = 0; i < 4; i += 1) await repo.createChapter(novel.id, {});
      const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
      await repo.createChapter(novel.id, { sideStoryId: story.id });
      await seedDrafts(novel.id);

      const { job, sideStory } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'side', sideStoryId: story.id },
        withStyle: false,
      });

      expect(sideStory).toEqual(story);
      const side = (await repo.listChapters(novel.id)).filter((c) => c.sideStoryId === story.id);
      expect(side.map((c) => c.index)).toEqual([1, 2, 3]);
      for (const chapter of side.slice(1)) expect(chapter.outlineNodeId).toBeNull();
      expect(job.destination).toEqual({ kind: 'side', sideStoryId: story.id });
      expect(job.chapters.map((c) => c.index)).toEqual([2, 3]);
      expect(job.withStyle).toBe(false);
    });

    it('newSide 新建外传并从第 1 章编号，标题归一化，order 排在末尾', async () => {
      const novel = await seedNovel();
      const existing = await repo.createSideStory(novel.id, { title: '雪夜番外' });
      await seedDrafts(novel.id);

      const { job, sideStory } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'newSide', title: '  外传·青冥旧事 ' },
        withStyle: false,
      });

      expect(sideStory).toMatchObject({ novelId: novel.id, title: '青冥旧事', rollingSummary: '' });
      expect(sideStory!.order).toBe(existing.order + 1);
      expect(await repo.getSideStory(sideStory!.id)).toEqual(sideStory);
      expect(job.destination).toEqual({ kind: 'side', sideStoryId: sideStory!.id });
      const side = (await repo.listChapters(novel.id)).filter(
        (c) => c.sideStoryId === sideStory!.id,
      );
      expect(side.map((c) => c.index)).toEqual([1, 2]);
    });

    it('原文、语种照抄草稿，字数按译文算，章节记为已完成的导入稿', async () => {
      const novel = await seedNovel();
      await seedDrafts(novel.id, [
        importDraft(1, {
          title: 'Departure',
          content: '沈砚上了船，回头望了一眼渔村。',
          sourceContent: 'Shen Yan boarded the boat.',
          sourceLanguage: '英文',
          translateStatus: 'done',
        }),
      ]);

      const { job } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'main' },
        withStyle: true,
      });

      const [chapter] = await repo.listChapters(novel.id);
      expect(chapter).toMatchObject({
        id: job.chapters[0]!.chapterId,
        index: 1,
        title: 'Departure',
        content: '沈砚上了船，回头望了一眼渔村。',
        sourceContent: 'Shen Yan boarded the boat.',
        sourceLanguage: '英文',
        wordCount: countWords('沈砚上了船，回头望了一眼渔村。'),
        status: 'done',
        source: 'imported',
        sideStoryId: null,
        outlineNodeId: null,
      });
    });

    it('任务清空草稿，链的初值按线取：主线接全书进展与本线最后有摘要那章的伏笔', async () => {
      const novel = await seedNovel();
      await repo.updateNovel(novel.id, { rollingSummary: '主线进展' });
      const c1 = await repo.createChapter(novel.id, {});
      const c2 = await repo.createChapter(novel.id, {});
      await repo.createChapter(novel.id, {}); // 第 3 章没有摘要
      await repo.upsertSummary(novel.id, c1.id, { openThreads: ['旧伏笔'] });
      await repo.upsertSummary(novel.id, c2.id, { openThreads: ['玉佩的来历'] });
      // 外传章节的伏笔不该被主线接到
      const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
      await repo.updateSideStory(story.id, { rollingSummary: '外传进展' });
      for (let i = 0; i < 5; i += 1) {
        const sc = await repo.createChapter(novel.id, { sideStoryId: story.id });
        await repo.upsertSummary(novel.id, sc.id, { openThreads: [`外传伏笔${i}`] });
      }
      await seedDrafts(novel.id);

      const { job } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'main' },
        withStyle: true,
      });

      expect(job).toMatchObject({
        destination: { kind: 'main' },
        drafts: [],
        worldviewChunks: [],
        withSummaries: true,
        withStyle: true,
        status: 'paused',
        rollingSummary: '主线进展',
        openThreads: ['玉佩的来历'],
      });
      expect(await repo.getImportJob(novel.id)).toEqual(job);

      // 外传第二批：接外传自己的进展与伏笔
      await repo.deleteImportJob(novel.id);
      await seedDrafts(novel.id);
      const side = await repo.commitImportChapters(novel.id, {
        target: { kind: 'side', sideStoryId: story.id },
        withStyle: false,
      });
      expect(side.job.rollingSummary).toBe('外传进展');
      expect(side.job.openThreads).toEqual(['外传伏笔4']);
    });

    it('本线没有任何摘要时伏笔从空开始', async () => {
      const novel = await seedNovel();
      await repo.createChapter(novel.id, {});
      await seedDrafts(novel.id);

      const { job } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'main' },
        withStyle: true,
      });
      expect(job.openThreads).toEqual([]);
    });

    it('job.chapters 是线内章号、提取状态 pending，翻译状态只有 done / none', async () => {
      const novel = await seedNovel();
      await repo.createChapter(novel.id, {});
      await seedDrafts(novel.id, [
        importDraft(1, { translateStatus: 'done', sourceContent: 'src' }),
        importDraft(2, { translateStatus: 'pending' }),
        importDraft(3, { translateStatus: 'failed', translateError: '超时' }),
        importDraft(4),
      ]);

      const { job } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'main' },
        withStyle: true,
      });

      const chapters = await repo.listChapters(novel.id);
      expect(job.chapters).toEqual(
        [2, 3, 4, 5].map((index, i) => ({
          index,
          title: `第${i + 1}节`,
          chapterId: chapters.find((c) => c.index === index)!.id,
          status: 'pending',
          error: '',
          translateStatus: i === 0 ? 'done' : 'none',
          translateError: '',
        })),
      );
    });

    it('外传 id 无效时什么都不写，任务不变', async () => {
      const novel = await seedNovel();
      const other = await seedNovel('别的书');
      const foreign = await repo.createSideStory(other.id, { title: '别人的外传' });
      await repo.createChapter(novel.id, {});
      const draftJob = await seedDrafts(novel.id);
      const chaptersBefore = await repo.listChapters(novel.id);

      for (const sideStoryId of ['missing', foreign.id]) {
        await expect(
          repo.commitImportChapters(novel.id, {
            target: { kind: 'side', sideStoryId },
            withStyle: false,
          }),
        ).rejects.toThrow('所选外传已不存在，可能已被删除');
      }
      expect(await repo.listChapters(novel.id)).toEqual(chaptersBefore);
      expect(await repo.listSideStories(novel.id)).toEqual([]);
      expect(await repo.getImportJob(novel.id)).toEqual(draftJob);
    });

    it('重名的 newSide 被拒，什么都不写', async () => {
      const novel = await seedNovel();
      const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
      const draftJob = await seedDrafts(novel.id);

      await expect(
        repo.commitImportChapters(novel.id, {
          target: { kind: 'newSide', title: '番外：青冥旧事' },
          withStyle: false,
        }),
      ).rejects.toThrow('已有同名外传『青冥旧事』');
      expect(await repo.listSideStories(novel.id)).toEqual([story]);
      expect(await repo.listChapters(novel.id)).toEqual([]);
      expect(await repo.getImportJob(novel.id)).toEqual(draftJob);
    });

    it('第二次调用被拒，章节只有一份', async () => {
      const novel = await seedNovel();
      await seedDrafts(novel.id);
      const { job } = await repo.commitImportChapters(novel.id, {
        target: { kind: 'main' },
        withStyle: true,
      });

      await expect(
        repo.commitImportChapters(novel.id, { target: { kind: 'main' }, withStyle: true }),
      ).rejects.toThrow('这批稿件已经写入过了');
      expect(await repo.listChapters(novel.id)).toHaveLength(2);
      expect(await repo.getImportJob(novel.id)).toEqual(job);
    });

    it('没有任务、没有草稿时被拒', async () => {
      const novel = await seedNovel();
      await expect(
        repo.commitImportChapters(novel.id, { target: { kind: 'main' }, withStyle: true }),
      ).rejects.toThrow('没有进行中的导入任务');

      await seedDrafts(novel.id, []);
      await expect(
        repo.commitImportChapters(novel.id, { target: { kind: 'main' }, withStyle: true }),
      ).rejects.toThrow('没有可写入的章节');
      expect(await repo.listChapters(novel.id)).toEqual([]);
    });
  });
});

describe('作品级译名表', () => {
  it('一开始是空的', async () => {
    const novel = await seedNovel();
    expect(await repo.getGlossary(novel.id)).toBeUndefined();
  });

  it('合并模型产出的译名，先到先得', async () => {
    const novel = await seedNovel();
    await repo.mergeGlossaryTerms(novel.id, [{ source: 'Ashford', target: '阿什福德' }]);
    const after = await repo.mergeGlossaryTerms(novel.id, [
      // 同一个人在后面的批次里换个名字，读者会以为是两个人
      { source: 'ashford', target: '艾许佛' },
      { source: 'Greymoor', target: '灰沼' },
    ]);

    expect(after.terms).toEqual([
      { source: 'Ashford', target: '阿什福德' },
      { source: 'Greymoor', target: '灰沼' },
    ]);
  });

  it('重复合并复用同一行，不会每次新建', async () => {
    const novel = await seedNovel();
    const first = await repo.mergeGlossaryTerms(novel.id, [{ source: 'A', target: '甲' }]);
    const second = await repo.mergeGlossaryTerms(novel.id, [{ source: 'B', target: '乙' }]);
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('用户显式设定会覆盖已有译名', async () => {
    const novel = await seedNovel();
    await repo.mergeGlossaryTerms(novel.id, [{ source: 'Ashford', target: '阿什福德' }]);

    const after = await repo.setGlossaryTerm(novel.id, 'Ashford', '艾许佛');
    // 与合并的先到先得刻意相反 —— 这是作者的决定
    expect(after.terms).toEqual([{ source: 'Ashford', target: '艾许佛' }]);
  });

  it('改过之后模型再产出旧译名也不会被改回去', async () => {
    const novel = await seedNovel();
    await repo.mergeGlossaryTerms(novel.id, [{ source: 'Ashford', target: '阿什福德' }]);
    await repo.setGlossaryTerm(novel.id, 'Ashford', '艾许佛');

    const after = await repo.mergeGlossaryTerms(novel.id, [
      { source: 'Ashford', target: '阿什福德' },
    ]);
    expect(after.terms).toEqual([{ source: 'Ashford', target: '艾许佛' }]);
  });

  it('可以删掉某个译名', async () => {
    const novel = await seedNovel();
    await repo.mergeGlossaryTerms(novel.id, [
      { source: 'Ashford', target: '阿什福德' },
      { source: 'Greymoor', target: '灰沼' },
    ]);

    const after = await repo.removeGlossaryTerm(novel.id, 'ashford');
    expect(after.terms).toEqual([{ source: 'Greymoor', target: '灰沼' }]);
  });

  it('两本书的译名表互不干扰', async () => {
    const a = await seedNovel('甲');
    const b = await seedNovel('乙');
    await repo.mergeGlossaryTerms(a.id, [{ source: 'Ashford', target: '阿什福德' }]);
    await repo.mergeGlossaryTerms(b.id, [{ source: 'Ashford', target: '艾许佛' }]);

    expect((await repo.getGlossary(a.id))?.terms[0]?.target).toBe('阿什福德');
    expect((await repo.getGlossary(b.id))?.terms[0]?.target).toBe('艾许佛');
  });

  it('删除作品会带走译名表', async () => {
    const novel = await seedNovel();
    await repo.mergeGlossaryTerms(novel.id, [{ source: 'Ashford', target: '阿什福德' }]);

    await repo.deleteNovel(novel.id);
    expect(await repo.getGlossary(novel.id)).toBeUndefined();
  });
});

describe('持久化与迁移', () => {
  it('当前架构版本为 7', () => {
    expect(database.verno).toBe(7);
  });

  it('v4 → v5：旧章节的 sideStoryId 补成 null，外传表可用', async () => {
    const name = `test-${crypto.randomUUID()}`;
    // 只声明到 v4 的原生 Dexie，模拟升级前的用户库
    const legacy = new Dexie(name);
    legacy.version(1).stores({
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
    legacy.version(2).stores({ importJobs: 'id, &novelId' });
    legacy.version(3).stores({});
    legacy.version(4).stores({ glossaries: 'id, &novelId' });
    await legacy.open();
    await legacy.table('novels').add({
      id: 'n1',
      title: '旧书',
      oneLiner: '',
      genre: '',
      pov: 'third-limited',
      targetWords: null,
      status: 'writing',
      rollingSummary: '',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    });
    await legacy.table('chapters').bulkAdd([
      {
        id: 'c1',
        novelId: 'n1',
        outlineNodeId: null,
        index: 1,
        title: '一',
        content: '旧章节',
        sourceContent: '',
        sourceLanguage: '',
        wordCount: 3,
        status: 'done',
        source: 'manual',
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'c2',
        novelId: 'n1',
        outlineNodeId: null,
        index: 2,
        title: '二',
        content: '又一章',
        sourceContent: '',
        sourceLanguage: '',
        wordCount: 3,
        status: 'draft',
        source: 'manual',
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    legacy.close();

    const upgraded = new AppDatabase(name);
    await upgraded.open();
    const upgradedRepo = new DexieNovelRepository(upgraded);

    expect(upgraded.verno).toBe(7);
    const chapters = await upgradedRepo.listChapters('n1');
    expect(chapters.map((c) => c.sideStoryId)).toEqual([null, null]);
    expect(await upgradedRepo.listSideStories('n1')).toEqual([]);
    // 升级后能直接建外传与外传章节，主线编号接着旧章节
    const story = await upgradedRepo.createSideStory('n1', { title: '青冥旧事' });
    expect((await upgradedRepo.createChapter('n1', { sideStoryId: story.id })).index).toBe(1);
    expect((await upgradedRepo.createChapter('n1', {})).index).toBe(3);

    upgraded.close();
    await upgraded.delete();
  });

  it('v4 → v5：旧导入任务换算成新形状；字段残缺的行也不会让升级失败', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({
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
    legacy.version(2).stores({ importJobs: 'id, &novelId' });
    legacy.version(3).stores({});
    legacy.version(4).stores({ glossaries: 'id, &novelId' });
    await legacy.open();
    await legacy.table('novels').add({
      id: 'n1',
      title: '旧书',
      oneLiner: '',
      genre: '',
      pov: 'third-limited',
      targetWords: null,
      status: 'writing',
      rollingSummary: '',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    });
    await legacy.table('chapters').add({
      id: 'c1',
      novelId: 'n1',
      outlineNodeId: null,
      index: 1,
      title: '一',
      content: 'He left before dawn.',
      sourceContent: '',
      sourceLanguage: '',
      wordCount: 4,
      status: 'done',
      source: 'imported',
      createdAt: 0,
      updatedAt: 0,
    });
    const common = {
      batchId: 'b',
      entryDrafts: [],
      openThreads: [],
      rollingSummary: '',
      withSummaries: true,
      withStyle: true,
      status: 'paused',
      createdAt: 0,
      updatedAt: 0,
    };
    // &novelId 唯一：每种旧行挂在不同的作品 id 上
    await legacy.table('importJobs').bulkAdd([
      {
        ...common,
        id: 'j-worldview',
        novelId: 'n-worldview',
        importType: 'worldview',
        worldviewText: '归墟在极北。',
        worldviewChunks: [{ index: 1, content: '归墟在极北。', status: 'pending', error: '' }],
        chapters: [],
      },
      {
        ...common,
        id: 'j-chapter',
        novelId: 'n1',
        importType: 'chapter',
        worldviewText: '',
        worldviewChunks: [],
        chapters: [
          {
            index: 1,
            title: '一',
            chapterId: 'c1',
            status: 'pending',
            error: '',
            translateStatus: 'pending',
            translateError: '',
          },
        ],
      },
      { ...common, id: 'j-empty', novelId: 'n-empty', importType: 'chapter', chapters: [] },
      // 字段残缺：没有 importType、没有 worldviewChunks、chapters 不是数组
      { id: 'j-broken', novelId: 'n-broken', chapters: 'oops' },
    ]);
    legacy.close();

    const upgraded = new AppDatabase(name);
    await upgraded.open();
    const upgradedRepo = new DexieNovelRepository(upgraded);
    expect(upgraded.verno).toBe(7);

    const worldview = (await upgraded.importJobs.get('j-worldview')) as unknown as Record<
      string,
      unknown
    >;
    expect(worldview.destination).toEqual({ kind: 'worldview' });
    expect(worldview).not.toHaveProperty('importType');
    expect(worldview).not.toHaveProperty('worldviewText');
    expect((worldview.worldviewChunks as { title: string }[])[0]?.title).toBe('');
    expect(worldview.drafts).toEqual([]);

    const chapter = await upgradedRepo.getImportJob('n1');
    expect(chapter?.destination).toEqual({ kind: 'main' });
    expect(chapter?.drafts).toEqual([]);
    // 旧版翻译状态原样保留，面板据此提示「翻译进度无法接着跑」
    expect(chapter?.chapters[0]?.translateStatus).toBe('pending');
    expect(chapter).not.toHaveProperty('importType');

    const empty = await upgradedRepo.getImportJob('n-empty');
    expect(empty?.destination).toBeNull();
    expect(empty?.drafts).toEqual([]);

    const broken = await upgradedRepo.getImportJob('n-broken');
    expect(broken?.destination).toBeNull();
    expect(broken?.chapters).toEqual([]);
    expect(broken?.worldviewChunks).toEqual([]);
    expect(broken?.drafts).toEqual([]);

    // 作品和章节都读得到
    expect((await upgradedRepo.getNovel('n1'))?.title).toBe('旧书');
    expect((await upgradedRepo.listChapters('n1')).map((c) => c.sideStoryId)).toEqual([null]);

    upgraded.close();
    await upgraded.delete();
  });

  it('章节的原文字段有默认值，不会是 undefined', async () => {
    const novel = await seedNovel();
    const chapter = await repo.createChapter(novel.id, { content: 'He left.' });
    // 界面上会直接 chapter.sourceContent.trim()，undefined 会当场抛错
    expect(chapter.sourceContent).toBe('');
    expect(chapter.sourceLanguage).toBe('');
  });

  it('原文与译文可以一起存，字数只按译文算', async () => {
    const novel = await seedNovel();
    const chapter = await repo.createChapter(novel.id, {
      content: 'He shouldered the pack before dawn.',
      sourceLanguage: 'en',
    });
    expect(chapter.wordCount).toBe(6);

    const translated = await repo.updateChapter(chapter.id, {
      content: '他在黎明前背起了行囊。',
      sourceContent: 'He shouldered the pack before dawn.',
      sourceLanguage: 'en',
    });
    expect(translated.content).toBe('他在黎明前背起了行囊。');
    expect(translated.sourceContent).toBe('He shouldered the pack before dawn.');
    // 原文不参与字数统计
    expect(translated.wordCount).toBe(11);
  });

  it('关闭后重开同名库，数据仍在', async () => {
    const novel = await repo.createNovel({ title: '持久之书' });
    const categoryId = (await repo.listCategories(novel.id))[0]!.id;
    await repo.createEntry(novel.id, { categoryId, title: '灵气' });
    await repo.upsertImportJob(novel.id, { status: 'running', rollingSummary: '跑到第三章' });
    await repo.mergeGlossaryTerms(novel.id, [{ source: 'Ashford', target: '阿什福德' }]);
    const name = database.name;

    database.close();

    const reopened = new AppDatabase(name);
    await reopened.open();
    const reopenedRepo = new DexieNovelRepository(reopened);

    expect((await reopenedRepo.getNovel(novel.id))?.title).toBe('持久之书');
    expect(await reopenedRepo.listEntries(novel.id)).toHaveLength(1);
    expect(await reopenedRepo.listCategories(novel.id)).toHaveLength(2);
    // 导入任务必须跨会话存活，否则刷新页面就等于重跑几十次提取
    expect(await reopenedRepo.getImportJob(novel.id)).toMatchObject({
      status: 'running',
      rollingSummary: '跑到第三章',
    });
    // 译名表更要活下来：它是跨导入批次保持人名一致的唯一依据
    expect((await reopenedRepo.getGlossary(novel.id))?.terms).toEqual([
      { source: 'Ashford', target: '阿什福德' },
    ]);

    reopened.close();
    // 交还给 afterEach 删除
    database = reopened;
  });
});

describe('写作规范', () => {
  /** 直接写表构造确定的时间与顺序，避免依赖执行耗时 */
  async function seedRawNorm(
    novelId: string,
    id: string,
    overrides: Partial<WritingNorm> = {},
  ): Promise<WritingNorm> {
    const row: WritingNorm = {
      id,
      novelId,
      title: id,
      content: `${id} 的正文`,
      enabled: true,
      scopes: ['writing', 'planning', 'summary', 'extract', 'check'],
      order: 0,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    };
    await database.writingNorms.put(row);
    return row;
  }

  it('新建时正文逐字符原样保存，默认启用、六项作用范围、order 递增', async () => {
    const novel = await seedNovel();
    const content = '\n  ## 写作规则\n\n- 以已导入资料为原作基线。\n\n【规范《X》结束】\n  ';

    const first = await repo.createWritingNorm(novel.id, { title: '使用提示', content });
    const second = await repo.createWritingNorm(novel.id, { title: '差异说明', content: '二' });
    const third = await repo.createWritingNorm(novel.id, { title: '第三份', content: '三' });

    expect(first.content).toBe(content);
    expect((await database.writingNorms.get(first.id))?.content).toBe(content);
    expect(first.enabled).toBe(true);
    expect(first.scopes).toEqual([
      'writing',
      'planning',
      'summary',
      'extract',
      'check',
      'interactive',
    ]);
    expect([first.order, second.order, third.order]).toEqual([0, 1, 2]);
    expect((await repo.listWritingNorms(novel.id)).map((n) => n.title)).toEqual([
      '使用提示',
      '差异说明',
      '第三份',
    ]);
  });

  it('新建时作用范围去重并按固定顺序存', async () => {
    const novel = await seedNovel();
    const norm = await repo.createWritingNorm(novel.id, {
      title: '只管写和查',
      content: '正文',
      scopes: ['check', 'writing', 'writing'],
    });
    expect(norm.scopes).toEqual(['writing', 'check']);
    expect((await database.writingNorms.get(norm.id))?.scopes).toEqual(['writing', 'check']);
  });

  it('新建时非法输入被拒绝且不写库', async () => {
    const novel = await seedNovel();
    await expect(
      repo.createWritingNorm(novel.id, { title: '  ', content: '正文' }),
    ).rejects.toThrow();
    await expect(
      repo.createWritingNorm(novel.id, { title: '标题', content: ' \n ' }),
    ).rejects.toThrow();
    await expect(
      repo.createWritingNorm(novel.id, {
        title: '标题',
        content: '正文',
        scopes: ['translate'] as unknown as WritingNormScope[],
      }),
    ).rejects.toThrow();
    expect(await repo.listWritingNorms(novel.id)).toEqual([]);
  });

  it('修改四项；身份、排序与创建时间改不动', async () => {
    const novel = await seedNovel();
    const norm = await repo.createWritingNorm(novel.id, { title: '旧标题', content: '旧正文' });
    await database.writingNorms.update(norm.id, { createdAt: 100, updatedAt: 100 });

    const updated = await repo.updateWritingNorm(norm.id, {
      title: '新标题',
      content: '  新正文\n',
      enabled: false,
      scopes: ['summary', 'writing', 'summary'],
      id: 'hacked',
      novelId: 'other',
      createdAt: 1,
      order: 9,
      updatedAt: 1,
    } as Partial<WritingNorm>);

    expect(updated).toMatchObject({
      id: norm.id,
      novelId: novel.id,
      title: '新标题',
      content: '  新正文\n',
      enabled: false,
      scopes: ['writing', 'summary'],
      order: 0,
      createdAt: 100,
    });
    expect(updated.updatedAt).toBeGreaterThan(100);
    expect(await database.writingNorms.get(norm.id)).toEqual(updated);
    expect(await database.writingNorms.get('hacked')).toBeUndefined();
  });

  it('修改不存在的规范时报错', async () => {
    await expect(repo.updateWritingNorm('missing', { title: '新' })).rejects.toThrow(
      '这份写作规范已不存在，可能已被删除',
    );
  });

  it('删除幂等；删除作品时级联删除规范', async () => {
    const novel = await seedNovel();
    const other = await seedNovel('另一本');
    const a = await repo.createWritingNorm(novel.id, { title: 'A', content: 'a' });
    await repo.createWritingNorm(novel.id, { title: 'B', content: 'b' });
    await repo.createWritingNorm(other.id, { title: 'C', content: 'c' });

    await repo.deleteWritingNorm(a.id);
    await repo.deleteWritingNorm(a.id);
    expect((await repo.listWritingNorms(novel.id)).map((n) => n.title)).toEqual(['B']);

    await repo.deleteNovel(novel.id);
    expect(await repo.listWritingNorms(novel.id)).toEqual([]);
    expect((await repo.listWritingNorms(other.id)).map((n) => n.title)).toEqual(['C']);
  });

  it('重排按数组下标重写 order，只有位置变了的才刷新 updatedAt', async () => {
    const novel = await seedNovel();
    await seedRawNorm(novel.id, 'a', { order: 0, updatedAt: 5 });
    await seedRawNorm(novel.id, 'b', { order: 1, updatedAt: 5 });
    await seedRawNorm(novel.id, 'c', { order: 2, updatedAt: 5 });

    await repo.reorderWritingNorms(novel.id, ['c', 'b', 'a']);

    const list = await repo.listWritingNorms(novel.id);
    expect(list.map((n) => [n.id, n.order])).toEqual([
      ['c', 0],
      ['b', 1],
      ['a', 2],
    ]);
    expect(list.find((n) => n.id === 'b')?.updatedAt).toBe(5);
    expect(list.find((n) => n.id === 'a')?.updatedAt).toBeGreaterThan(5);
  });

  it('重排时集合对不上一律拒绝，库里不变', async () => {
    const novel = await seedNovel();
    const other = await seedNovel('另一本');
    await seedRawNorm(novel.id, 'a', { order: 0, updatedAt: 5 });
    await seedRawNorm(novel.id, 'b', { order: 1, updatedAt: 5 });
    await seedRawNorm(novel.id, 'c', { order: 2, updatedAt: 5 });
    await seedRawNorm(other.id, 'x', { order: 0, updatedAt: 5 });
    const before = await repo.listWritingNorms(novel.id);

    // 缺一个 id
    await expect(repo.reorderWritingNorms(novel.id, ['c', 'a'])).rejects.toThrow(
      '规范列表已变化，请刷新后再调整顺序',
    );
    // 多一个别书的 id
    await expect(repo.reorderWritingNorms(novel.id, ['c', 'b', 'a', 'x'])).rejects.toThrow(
      '规范列表已变化，请刷新后再调整顺序',
    );
    // 重复 id：长度相等但集合不全
    await expect(repo.reorderWritingNorms(novel.id, ['a', 'a', 'b'])).rejects.toThrow(
      '规范列表已变化，请刷新后再调整顺序',
    );

    expect(await repo.listWritingNorms(novel.id)).toEqual(before);
  });

  it('精简另存：新规范紧跟源规范、沿用作用范围并启用，源停用且正文不变', async () => {
    const novel = await seedNovel();
    await seedRawNorm(novel.id, 'a', { order: 0 });
    await seedRawNorm(novel.id, 'b', {
      order: 1,
      content: '  原文 https://example.com/1\n',
      scopes: ['writing', 'check'],
    });
    await seedRawNorm(novel.id, 'c', { order: 2 });

    const created = await repo.saveCondensedWritingNorm('b', {
      title: 'b（精简）',
      content: '## 写作规则\n- 一条',
    });

    expect(created).toMatchObject({
      novelId: novel.id,
      title: 'b（精简）',
      content: '## 写作规则\n- 一条',
      enabled: true,
      scopes: ['writing', 'check'],
      order: 2,
    });
    const list = await repo.listWritingNorms(novel.id);
    expect(list.map((n) => [n.id, n.order])).toEqual([
      ['a', 0],
      ['b', 1],
      [created.id, 2],
      ['c', 3],
    ]);
    const source = list.find((n) => n.id === 'b');
    expect(source?.enabled).toBe(false);
    expect(source?.content).toBe('  原文 https://example.com/1\n');
    expect(await database.writingNorms.get(created.id)).toEqual(created);
  });

  it('精简另存：源不存在或输入不合法时什么都不写', async () => {
    const novel = await seedNovel();
    await seedRawNorm(novel.id, 'a', { order: 0, updatedAt: 5 });
    const before = await repo.listWritingNorms(novel.id);

    await expect(
      repo.saveCondensedWritingNorm('missing', { title: '精简', content: '正文' }),
    ).rejects.toThrow('这份写作规范已不存在，可能已被删除');
    await expect(
      repo.saveCondensedWritingNorm('a', { title: '精简', content: '  ' }),
    ).rejects.toThrow();

    expect(await repo.listWritingNorms(novel.id)).toEqual(before);
  });

  it('精简另存：重复 order 下仍紧跟源规范，整本书重写为 0..n-1', async () => {
    const novel = await seedNovel();
    // 合并导入备份后可能出现的形状：三份 order 都是 0，靠 createdAt 区分
    await seedRawNorm(novel.id, 'A', { order: 0, createdAt: 1 });
    await seedRawNorm(novel.id, 'B', { order: 0, createdAt: 2 });
    await seedRawNorm(novel.id, 'C', { order: 0, createdAt: 3 });

    const created = await repo.saveCondensedWritingNorm('A', {
      title: 'A（精简）',
      content: '精简',
    });

    const list = await repo.listWritingNorms(novel.id);
    expect(list.map((n) => [n.title, n.order])).toEqual([
      ['A', 0],
      ['A（精简）', 1],
      ['B', 2],
      ['C', 3],
    ]);
    expect(list[1]?.id).toBe(created.id);
  });
});

describe('v5 → v6 迁移', () => {
  it('只新增写作规范表：旧数据逐字段不变，新表为空且可写', async () => {
    const name = `test-${crypto.randomUUID()}`;
    // 只声明到 v5 的原生 Dexie，模拟升级前的用户库
    const legacy = new Dexie(name);
    legacy.version(1).stores({
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
    legacy.version(2).stores({ importJobs: 'id, &novelId' });
    legacy.version(3).stores({});
    legacy.version(4).stores({ glossaries: 'id, &novelId' });
    legacy.version(5).stores({
      chapters: 'id, novelId, [novelId+index], sideStoryId',
      sideStories: 'id, novelId',
    });
    await legacy.open();

    const novelRow = {
      id: 'n1',
      title: '旧书',
      oneLiner: '一句话',
      genre: '仙侠',
      pov: 'third-limited',
      targetWords: null,
      status: 'writing',
      rollingSummary: '进展',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    };
    const storyRow = {
      id: 's1',
      novelId: 'n1',
      title: '青冥旧事',
      synopsis: '前传',
      rollingSummary: '',
      order: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const chapterRows = [
      {
        id: 'c1',
        novelId: 'n1',
        outlineNodeId: null,
        index: 1,
        title: '一',
        content: '主线正文',
        sourceContent: '',
        sourceLanguage: '',
        wordCount: 4,
        status: 'done',
        source: 'manual',
        sideStoryId: null,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'c2',
        novelId: 'n1',
        outlineNodeId: null,
        index: 1,
        title: '外一',
        content: '外传正文',
        sourceContent: '',
        sourceLanguage: '',
        wordCount: 4,
        status: 'draft',
        source: 'manual',
        sideStoryId: 's1',
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const glossaryRow = {
      id: 'g1',
      novelId: 'n1',
      terms: [{ source: 'Ashford', target: '阿什福德' }],
      createdAt: 0,
      updatedAt: 0,
    };
    await legacy.table('novels').add(novelRow);
    await legacy.table('sideStories').add(storyRow);
    await legacy.table('chapters').bulkAdd(chapterRows);
    await legacy.table('glossaries').add(glossaryRow);
    legacy.close();

    const upgraded = new AppDatabase(name);
    await upgraded.open();
    const upgradedRepo = new DexieNovelRepository(upgraded);

    expect(upgraded.verno).toBe(7);
    expect(await upgraded.novels.get('n1')).toEqual(novelRow);
    // 打开时会一路升到 v7：v7 只给外传与章节补推演溯源的默认值 null，其余字段逐字段不变
    expect(await upgraded.sideStories.get('s1')).toEqual({ ...storyRow, scenarioSource: null });
    expect(await upgraded.chapters.bulkGet(['c1', 'c2'])).toEqual(
      chapterRows.map((row) => ({ ...row, scenarioSource: null })),
    );
    expect(await upgraded.glossaries.get('g1')).toEqual(glossaryRow);

    expect(await upgradedRepo.listWritingNorms('n1')).toEqual([]);
    const norm = await upgradedRepo.createWritingNorm('n1', { title: '使用提示', content: '正文' });
    expect((await upgradedRepo.listWritingNorms('n1')).map((n) => n.id)).toEqual([norm.id]);

    upgraded.close();
    await upgraded.delete();
  });
});

describe('v6 → v7 迁移', () => {
  it('补作用范围、锁定、推演溯源的默认值；五项全开的规范补上互动推演；其余字段逐字段不变', async () => {
    const name = `test-${crypto.randomUUID()}`;
    // 只声明到 v6 的原生 Dexie，模拟升级前的用户库
    const legacy = new Dexie(name);
    legacy.version(1).stores({
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
    legacy.version(2).stores({ importJobs: 'id, &novelId' });
    legacy.version(3).stores({});
    legacy.version(4).stores({ glossaries: 'id, &novelId' });
    legacy.version(5).stores({
      chapters: 'id, novelId, [novelId+index], sideStoryId',
      sideStories: 'id, novelId',
    });
    legacy.version(6).stores({ writingNorms: 'id, novelId' });
    await legacy.open();

    const novelRow = {
      id: 'n1',
      title: '旧书',
      oneLiner: '',
      genre: '',
      pov: 'third-limited',
      targetWords: null,
      status: 'writing',
      rollingSummary: '',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    };
    const categoryRow = {
      id: 'cat1',
      novelId: 'n1',
      name: '人物',
      kind: 'character',
      builtin: true,
      fieldTemplate: [{ key: 'identity', label: '身份', type: 'text', placeholder: '', hint: '' }],
      order: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const entryRow = {
      id: 'e1',
      novelId: 'n1',
      categoryId: 'cat1',
      title: '裴照',
      aliases: ['裴捕头'],
      summary: '捕头',
      fields: { identity: '捕头' },
      pinned: true,
      sourceChapterIds: ['c1'],
      version: 3,
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
    };
    const outlineRow = {
      id: 'o1',
      novelId: 'n1',
      parentId: null,
      order: 0,
      title: '第一卷',
      synopsis: '梗概',
      targetWords: null,
      status: 'planned',
      linkedEntryIds: ['e1'],
      createdAt: 0,
      updatedAt: 0,
    };
    const chapterRow = {
      id: 'c1',
      novelId: 'n1',
      outlineNodeId: 'o1',
      index: 1,
      title: '一',
      content: '正文',
      sourceContent: '',
      sourceLanguage: '',
      wordCount: 2,
      status: 'done',
      source: 'manual',
      sideStoryId: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const storyRow = {
      id: 's1',
      novelId: 'n1',
      title: '青冥旧事',
      synopsis: '',
      rollingSummary: '',
      order: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const normBase = {
      novelId: 'n1',
      content: '正文',
      enabled: true,
      order: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const fullNorm = {
      ...normBase,
      id: 'w-full',
      title: '全开',
      scopes: ['check', 'writing', 'planning', 'summary', 'extract'],
    };
    const writingOnly = { ...normBase, id: 'w-writing', title: '只写正文', scopes: ['writing'] };
    const noScopes = { ...normBase, id: 'w-none', title: '缺字段' };
    await legacy.table('novels').add(novelRow);
    await legacy.table('categories').add(categoryRow);
    await legacy.table('entries').add(entryRow);
    await legacy.table('outlineNodes').add(outlineRow);
    await legacy.table('chapters').add(chapterRow);
    await legacy.table('sideStories').add(storyRow);
    await legacy.table('writingNorms').bulkAdd([fullNorm, writingOnly, noScopes]);
    legacy.close();

    const upgraded = new AppDatabase(name);
    await upgraded.open();
    const upgradedRepo = new DexieNovelRepository(upgraded);
    expect(upgraded.verno).toBe(7);

    expect(await upgraded.novels.get('n1')).toEqual(novelRow);
    expect(await upgraded.categories.get('cat1')).toEqual(categoryRow);
    expect(await upgraded.entries.get('e1')).toEqual({
      ...entryRow,
      scope: { kind: 'universal' },
      fieldLocks: {},
    });
    expect(await upgraded.outlineNodes.get('o1')).toEqual({ ...outlineRow, scenarioSource: null });
    expect(await upgraded.chapters.get('c1')).toEqual({ ...chapterRow, scenarioSource: null });
    expect(await upgraded.sideStories.get('s1')).toEqual({ ...storyRow, scenarioSource: null });

    const norms = new Map((await upgraded.writingNorms.toArray()).map((norm) => [norm.id, norm]));
    const six = ['writing', 'planning', 'summary', 'extract', 'check', 'interactive'];
    expect(norms.get('w-full')).toEqual({ ...fullNorm, scopes: six });
    expect(norms.get('w-writing')).toEqual(writingOnly);
    expect(norms.get('w-none')).toEqual({ ...noScopes, scopes: six });

    // 推演表为空且可写
    expect(await upgradedRepo.listScenarios('n1')).toEqual([]);
    const scenario = await upgradedRepo.createScenario('n1', {
      title: '雾中渡',
      setup: {
        cast: [{ entryId: 'e1' }],
        start: { time: '', place: '', situation: '醒来' },
        goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
        milestones: [],
        tone: '',
        expectedSteps: 30,
      },
    });
    expect((await upgradedRepo.listScenarios('n1')).map((item) => item.id)).toEqual([scenario.id]);

    upgraded.close();
    await upgraded.delete();
  });
});

// ================================================================ 互动推演

describe('互动推演', () => {
  async function seedWorld() {
    const novel = await seedNovel();
    const [world, char] = await repo.listCategories(novel.id);
    const peizhao = await repo.createEntry(novel.id, {
      categoryId: char!.id,
      title: '裴照',
      aliases: ['裴捕头'],
      fields: { identity: '捕快', voice: '话少' },
    });
    const lingqi = await repo.createEntry(novel.id, {
      categoryId: world!.id,
      title: '灵气',
      fields: { rules: '吐纳入体', cost: '损寿元' },
      pinned: true,
    });
    return { novel, world: world!, char: char!, peizhao, lingqi };
  }

  function setup(entryId = ''): ScenarioSetupInput {
    return {
      cast: [{ entryId }],
      start: { time: '', place: '渡口', situation: '在渡口醒来' },
      goals: [
        { id: 'g1', kind: 'good', description: '找到船夫' },
        { id: 'g2', kind: 'bad', description: '沉江' },
      ],
      milestones: [{ id: 'm1', description: '找到空船' }],
      tone: '',
      expectedSteps: 30,
    };
  }

  async function seedScenario(title = '雾中渡') {
    const world = await seedWorld();
    const scenario = await repo.createScenario(world.novel.id, {
      title,
      setup: setup(),
      newOc: {
        categoryId: world.char.id,
        title: '沈砚',
        fields: { identity: '船夫', voice: '低声' },
      },
    });
    return { ...world, scenario, oc: (await repo.getEntry(scenario.setup.cast[0]!.entryId))! };
  }

  let optionSeq = 0;
  function options(...texts: string[]): ScenarioOption[] {
    return texts.map((text) => ({
      id: `opt-${++optionSeq}`,
      text,
      tendency: 'cautious' as const,
      risk: 'low' as const,
      batch: 0,
    }));
  }

  function input(
    parentId: string | null,
    arrivedBy: ScenarioNodeInput['arrivedBy'],
    extra: Partial<ScenarioNodeInput> = {},
  ): ScenarioNodeInput {
    return {
      parentId,
      arrivedBy,
      plot: '雾很大。',
      challenge: '船在下沉',
      options: options('拔刀', '跳江', '呼救'),
      delta: emptyDelta(),
      notices: [],
      progress: { reachedMilestoneIds: [], note: '' },
      ending: null,
      ...extra,
    };
  }

  const opt = (node: ScenarioNode, index: number) => ({
    kind: 'option' as const,
    optionId: node.options[index]!.id,
    text: node.options[index]!.text,
  });

  async function startOf(scenarioId: string) {
    return (await repo.appendScenarioNode(scenarioId, input(null, { kind: 'start' }))).node;
  }

  describe('新建推演', () => {
    it('引用已有人物作主角', async () => {
      const { novel, peizhao } = await seedWorld();
      const scenario = await repo.createScenario(novel.id, {
        title: '雾中渡',
        setup: setup(peizhao.id),
      });
      expect(scenario.setup.cast).toHaveLength(1);
      expect(scenario.setup.cast[0]!.entryId).toBe(peizhao.id);
      expect(scenario.setup.cast[0]!.id).toBeTruthy();
      expect(scenario.mainNodeId).toBeNull();
      expect(await repo.getScenario(scenario.id)).toEqual(scenario);
    });

    it('新建 OC：同一事务建出限定到本推演的人物条目；默认 listEntries 看不到，scope all 看得到', async () => {
      const { novel, oc, scenario } = await seedScenario();
      expect(oc.scope).toEqual({
        kind: 'limited',
        targets: [{ scenarioId: scenario.id, fromNodeId: null, revealHint: '' }],
      });
      expect(oc.fields).toEqual({ identity: '船夫', voice: '低声' });
      expect((await repo.listEntries(novel.id)).map((e) => e.title)).not.toContain('沈砚');
      expect((await repo.listEntries(novel.id, { scope: 'all' })).map((e) => e.title)).toContain(
        '沈砚',
      );
    });

    it('主角条目不存在或已删除时拒绝，什么都不写', async () => {
      const { novel, peizhao } = await seedWorld();
      await repo.softDeleteEntry(peizhao.id);
      await expect(
        repo.createScenario(novel.id, { title: '雾中渡', setup: setup(peizhao.id) }),
      ).rejects.toThrow('选中的人物已不存在');
      expect(await repo.listScenarios(novel.id)).toEqual([]);
    });

    it('updateScenario 只改名称与可改的设定；推演不存在时报错', async () => {
      const { scenario } = await seedScenario();
      const next = await repo.updateScenario(scenario.id, {
        title: '雾中渡·改',
        setup: { tone: '冷峻', expectedSteps: 40 },
      });
      expect(next.title).toBe('雾中渡·改');
      expect(next.setup.tone).toBe('冷峻');
      expect(next.setup.cast).toEqual(scenario.setup.cast);
      expect(next.setup.start).toEqual(scenario.setup.start);
      await expect(repo.updateScenario('ghost', { title: 'x' })).rejects.toThrow(
        '这个推演已不存在，可能已被删除',
      );
    });
  });

  describe('推进', () => {
    it('根唯一；主线与落点改为新节点', async () => {
      const { scenario } = await seedScenario();
      const { node: root, scenario: afterRoot } = await repo.appendScenarioNode(
        scenario.id,
        input(null, { kind: 'start' }),
      );
      expect(root.depth).toBe(0);
      expect(afterRoot.mainNodeId).toBe(root.id);
      expect(afterRoot.cursorNodeId).toBe(root.id);
      expect(afterRoot.lastAdvancedAt).not.toBeNull();
      await expect(
        repo.appendScenarioNode(scenario.id, input(null, { kind: 'start' })),
      ).rejects.toThrow('这个推演已经开过局了');
      const { node: child, scenario: afterChild } = await repo.appendScenarioNode(
        scenario.id,
        input(root.id, opt(root, 0)),
      );
      expect(child.depth).toBe(1);
      expect(afterChild.mainNodeId).toBe(child.id);
      expect((await repo.getScenario(scenario.id))?.cursorNodeId).toBe(child.id);
    });

    it('同一选项第二次、规范化后相同的自由输入、与已走过选项同文的自由输入都拒绝', async () => {
      const { scenario } = await seedScenario();
      const root = await startOf(scenario.id);
      await repo.appendScenarioNode(scenario.id, input(root.id, opt(root, 0)));
      await expect(
        repo.appendScenarioNode(scenario.id, input(root.id, opt(root, 0))),
      ).rejects.toThrow('这个选择刚刚已经走过了');
      await repo.appendScenarioNode(
        scenario.id,
        input(root.id, { kind: 'free', text: '跳进江里。' }),
      );
      await expect(
        repo.appendScenarioNode(
          scenario.id,
          input(root.id, { kind: 'free', text: ' 跳进 江里！' }),
        ),
      ).rejects.toThrow('这个选择刚刚已经走过了');
      await expect(
        repo.appendScenarioNode(scenario.id, input(root.id, { kind: 'free', text: '拔刀！' })),
      ).rejects.toThrow('这个选择刚刚已经走过了');
      expect(await repo.listScenarioNodes(scenario.id)).toHaveLength(3);
    });

    it('父节点不存在、父节点是结局时拒绝；收尾只能一次', async () => {
      const { scenario } = await seedScenario();
      const root = await startOf(scenario.id);
      await expect(
        repo.appendScenarioNode(scenario.id, input('ghost', { kind: 'free', text: '走' })),
      ).rejects.toThrow('要接着走的那一步已不存在');
      const { node: ending } = await repo.appendScenarioNode(
        scenario.id,
        input(
          root.id,
          { kind: 'wrap-up', goalId: 'g1', note: '' },
          {
            options: [],
            challenge: '',
            ending: { kind: 'good', goalId: 'g1', title: '归航', cause: '找到船夫' },
          },
        ),
      );
      await expect(
        repo.appendScenarioNode(
          scenario.id,
          input(root.id, { kind: 'wrap-up', goalId: null, note: '' }),
        ),
      ).rejects.toThrow('这个选择刚刚已经走过了');
      await expect(
        repo.appendScenarioNode(scenario.id, input(ending.id, { kind: 'free', text: '再走一步' })),
      ).rejects.toThrow('这条线已经结束，不能继续推进');
      await expect(
        repo.appendScenarioNode('ghost', input(null, { kind: 'start' })),
      ).rejects.toThrow('这个推演已不存在，可能已被删除');
    });

    it('落库时再丢一次锁定覆盖，并把原因记进 notices', async () => {
      const { scenario, lingqi, peizhao } = await seedScenario();
      const root = await startOf(scenario.id);
      const { node } = await repo.appendScenarioNode(
        scenario.id,
        input(root.id, opt(root, 0), {
          delta: {
            ...emptyDelta(),
            fieldOverrides: [
              {
                target: { kind: 'world', entryId: lingqi.id },
                fieldKey: 'rules',
                value: '无需代价',
              },
              {
                target: { kind: 'world', entryId: peizhao.id },
                fieldKey: 'identity',
                value: '叛徒',
              },
            ],
          },
        }),
      );
      expect(node.delta.fieldOverrides).toEqual([
        { target: { kind: 'world', entryId: peizhao.id }, fieldKey: 'identity', value: '叛徒' },
      ]);
      expect(node.notices).toEqual([
        { kind: 'locked-field', message: '「灵气」的「运作规则」是底层设定，本线不能改写，已丢弃' },
      ]);
    });

    it('推进、回退、编辑差异、结局之后 entries 表逐行不变（验收 4）', async () => {
      const { scenario, peizhao } = await seedScenario();
      const before = await database.entries.toArray();
      const root = await startOf(scenario.id);
      const { node: a } = await repo.appendScenarioNode(
        scenario.id,
        input(root.id, opt(root, 0), {
          delta: {
            ...emptyDelta(),
            fieldOverrides: [
              {
                target: { kind: 'world', entryId: peizhao.id },
                fieldKey: 'identity',
                value: '叛徒',
              },
            ],
            statusChanges: [
              { target: { kind: 'world', entryId: peizhao.id }, status: 'dead', note: '' },
            ],
          },
        }),
      );
      await repo.setScenarioCursor(scenario.id, root.id);
      await repo.appendScenarioNode(scenario.id, input(root.id, opt(root, 1)));
      await repo.updateScenarioNodeDelta(a.id, {
        ...emptyDelta(),
        fieldOverrides: [
          { target: { kind: 'world', entryId: peizhao.id }, fieldKey: 'goal', value: '复仇' },
        ],
      });
      await repo.appendScenarioNode(
        scenario.id,
        input(
          a.id,
          { kind: 'wrap-up', goalId: null, note: '' },
          {
            options: [],
            ending: { kind: 'bad', goalId: null, title: '坠江', cause: '贸然拔刀' },
          },
        ),
      );
      expect(await database.entries.toArray()).toEqual(before);
    });

    it('setScenarioCursor 只改落点，不改主线；节点不属于本推演时报错', async () => {
      const { scenario } = await seedScenario();
      const root = await startOf(scenario.id);
      const { node: child } = await repo.appendScenarioNode(
        scenario.id,
        input(root.id, opt(root, 0)),
      );
      await repo.setScenarioCursor(scenario.id, root.id);
      const after = await repo.getScenario(scenario.id);
      expect(after?.cursorNodeId).toBe(root.id);
      expect(after?.mainNodeId).toBe(child.id);
      await expect(repo.setScenarioCursor(scenario.id, 'ghost')).rejects.toThrow('这一步已不存在');
    });
  });

  describe('编辑差异与选项、摘要', () => {
    it('锁定字段的手动编辑被拒，库里不变（验收 8）；合法编辑写 deltaEditedAt', async () => {
      const { scenario, peizhao } = await seedScenario();
      const root = await startOf(scenario.id);
      const { node } = await repo.appendScenarioNode(scenario.id, input(root.id, opt(root, 0)));
      const stored = await database.scenarioNodes.get(node.id);
      await expect(
        repo.updateScenarioNodeDelta(node.id, {
          ...emptyDelta(),
          fieldOverrides: [
            { target: { kind: 'world', entryId: peizhao.id }, fieldKey: 'voice', value: '多话' },
          ],
        }),
      ).rejects.toThrow('「裴照」的「说话方式」是底层设定，本线不能改写，已丢弃');
      expect(await database.scenarioNodes.get(node.id)).toEqual(stored);

      const edited = await repo.updateScenarioNodeDelta(node.id, {
        ...emptyDelta(),
        fieldOverrides: [
          { target: { kind: 'world', entryId: peizhao.id }, fieldKey: 'identity', value: '叛徒' },
        ],
      });
      expect(edited.deltaEditedAt).not.toBeNull();
      expect(edited.delta.fieldOverrides).toHaveLength(1);
      await expect(repo.updateScenarioNodeDelta('ghost', emptyDelta())).rejects.toThrow(
        '这一步已不存在',
      );
    });

    it('appendScenarioOptions：去重、batch 递增、总数上限 8', async () => {
      const { scenario } = await seedScenario();
      const root = await startOf(scenario.id);
      const fresh = (...texts: string[]) =>
        texts.map((text) => ({ text, tendency: 'bold' as const, risk: 'high' as const }));
      await expect(repo.appendScenarioOptions(root.id, fresh('拔刀！', '新的'))).rejects.toThrow(
        '没有新的选项',
      );
      const once = await repo.appendScenarioOptions(root.id, fresh('潜水', '点火', '拔刀'));
      expect(once.options.map((o) => o.text)).toEqual(['拔刀', '跳江', '呼救', '潜水', '点火']);
      expect(once.options.slice(3).map((o) => o.batch)).toEqual([1, 1]);
      const twice = await repo.appendScenarioOptions(
        root.id,
        fresh('甲行动', '乙行动', '丙行动', '丁行动'),
      );
      expect(twice.options).toHaveLength(8);
      expect(twice.options.slice(5).map((o) => o.batch)).toEqual([2, 2, 2]);
      await expect(repo.appendScenarioOptions(root.id, fresh('戊行动', '己行动'))).rejects.toThrow(
        '这一步的选项已经够多了',
      );
    });

    it('setScenarioNodeSummary 写摘要', async () => {
      const { scenario } = await seedScenario();
      const root = await startOf(scenario.id);
      const next = await repo.setScenarioNodeSummary(root.id, {
        text: '前情',
        openThreads: ['船夫'],
      });
      expect(next.pathSummary).toEqual({ text: '前情', openThreads: ['船夫'] });
    });
  });

  describe('删除', () => {
    async function seedSediment() {
      const seeded = await seedScenario();
      const root = await startOf(seeded.scenario.id);
      const { node: a } = await repo.appendScenarioNode(
        seeded.scenario.id,
        input(root.id, opt(root, 0)),
      );
      await repo.commitScenarioOutline(seeded.novel.id, {
        scenarioId: seeded.scenario.id,
        mode: 'main',
        volumes: [
          {
            title: '第一卷',
            synopsis: '',
            targetWords: null,
            chapters: [
              {
                title: '第1章',
                synopsis: '',
                targetWords: null,
                linkedEntryIds: [],
                nodeIds: [root.id, a.id],
              },
            ],
          },
        ],
      });
      await repo.commitScenarioOutline(seeded.novel.id, {
        scenarioId: seeded.scenario.id,
        mode: 'side',
        appendToSideStoryId: null,
        title: '支线',
        synopsis: '',
        forkNodeId: root.id,
        chapters: [{ title: '外一', nodeIds: [a.id], brief: '细纲' }],
      });
      return { ...seeded, root, a };
    }

    it('trashScopedEntries：节点删光、溯源清空、只属于本推演的条目进回收站，限定到别处的只去掉这一项', async () => {
      const { novel, scenario, oc, char } = await seedSediment();
      const other = await repo.createScenario(novel.id, { title: '另一局', setup: setup(oc.id) });
      const shared = await repo.createEntry(novel.id, {
        categoryId: char.id,
        title: '青衣客',
        scope: {
          kind: 'limited',
          targets: [
            { scenarioId: scenario.id, fromNodeId: null, revealHint: '' },
            { scenarioId: other.id, fromNodeId: null, revealHint: '' },
          ],
        },
      });
      await repo.deleteScenario(scenario.id, { trashScopedEntries: true });
      expect(await repo.getScenario(scenario.id)).toBeUndefined();
      expect(await repo.listScenarioNodes(scenario.id)).toEqual([]);
      const outline = await repo.listOutline(novel.id);
      expect(outline.map((n) => n.scenarioSource)).toEqual([null, null]);
      expect(outline).toHaveLength(2);
      const [story] = await repo.listSideStories(novel.id);
      expect(story?.scenarioSource).toBeNull();
      const chapters = await repo.listChapters(novel.id);
      expect(chapters.map((c) => c.scenarioSource)).toEqual([null]);
      expect((await repo.getEntry(oc.id))?.deletedAt).not.toBeNull();
      const kept = await repo.getEntry(shared.id);
      expect(kept?.deletedAt).toBeNull();
      expect(kept?.scope).toEqual({
        kind: 'limited',
        targets: [{ scenarioId: other.id, fromNodeId: null, revealHint: '' }],
      });
    });

    it('trashScopedEntries 为假时条目原样保留；推演不存在时报错', async () => {
      const { scenario, oc } = await seedSediment();
      const before = await repo.getEntry(oc.id);
      await repo.deleteScenario(scenario.id, { trashScopedEntries: false });
      expect(await repo.getEntry(oc.id)).toEqual(before);
      await expect(repo.deleteScenario(scenario.id, { trashScopedEntries: false })).rejects.toThrow(
        '这个推演已不存在，可能已被删除',
      );
    });

    it('deleteNovel 级联两张新表', async () => {
      const { novel, scenario } = await seedSediment();
      await repo.deleteNovel(novel.id);
      expect(await database.scenarios.count()).toBe(0);
      expect(await database.scenarioNodes.where('scenarioId').equals(scenario.id).count()).toBe(0);
    });

    it('hardDeleteEntry 拒删推演主角（含主角已在回收站），条目仍在、deletedAt 不变', async () => {
      const { oc } = await seedScenario();
      await expect(repo.hardDeleteEntry(oc.id)).rejects.toThrow(
        '这个条目是推演《雾中渡》的主角，先删除推演',
      );
      await repo.softDeleteEntry(oc.id);
      const trashed = await repo.getEntry(oc.id);
      await expect(repo.hardDeleteEntry(oc.id)).rejects.toThrow(
        '这个条目是推演《雾中渡》的主角，先删除推演',
      );
      expect(await repo.getEntry(oc.id)).toEqual(trashed);
      // 普通条目照常彻底删除
      const { peizhao } = await seedWorld();
      await repo.hardDeleteEntry(peizhao.id);
      expect(await repo.getEntry(peizhao.id)).toBeUndefined();
    });
  });

  describe('沉淀落库', () => {
    it('主线：追加在顶层末尾，章级节点带溯源，卷为 null，关联只留通用条目', async () => {
      const { novel, scenario, oc, peizhao } = await seedScenario();
      const root = await startOf(scenario.id);
      const { node: a } = await repo.appendScenarioNode(scenario.id, input(root.id, opt(root, 0)));
      await repo.createOutlineNode(novel.id, { title: '作者的卷' });
      await repo.commitScenarioOutline(novel.id, {
        scenarioId: scenario.id,
        mode: 'main',
        volumes: [
          {
            title: '第二卷 渡口',
            synopsis: '卷梗概',
            targetWords: 30000,
            chapters: [
              {
                title: '雾',
                synopsis: '出场：沈砚、裴照',
                targetWords: 3000,
                linkedEntryIds: [peizhao.id, oc.id],
                nodeIds: [root.id],
              },
              { title: '刀', synopsis: '', targetWords: null, linkedEntryIds: [], nodeIds: [a.id] },
            ],
          },
        ],
      });
      const outline = await repo.listOutline(novel.id);
      const volume = outline.find((n) => n.title === '第二卷 渡口')!;
      expect(volume.parentId).toBeNull();
      expect(volume.order).toBe(1);
      expect(volume.scenarioSource).toBeNull();
      const children = outline.filter((n) => n.parentId === volume.id);
      expect(children.map((n) => [n.title, n.order, n.scenarioSource])).toEqual([
        ['雾', 0, { scenarioId: scenario.id, nodeIds: [root.id] }],
        ['刀', 1, { scenarioId: scenario.id, nodeIds: [a.id] }],
      ]);
      expect(children[0]!.linkedEntryIds).toEqual([peizhao.id]);
    });

    it('外传新建：记分叉节点，章节带细纲；追加：编号接续，名称简介不变', async () => {
      const { novel, scenario } = await seedScenario();
      const root = await startOf(scenario.id);
      const { node: a } = await repo.appendScenarioNode(scenario.id, input(root.id, opt(root, 0)));
      const { node: b } = await repo.appendScenarioNode(scenario.id, input(a.id, opt(a, 0)));
      await repo.commitScenarioOutline(novel.id, {
        scenarioId: scenario.id,
        mode: 'side',
        appendToSideStoryId: null,
        title: '外传·雾中支线',
        synopsis: '另一条路',
        forkNodeId: root.id,
        chapters: [{ title: '外一', nodeIds: [a.id], brief: '梗概：拔刀' }],
      });
      const [story] = await repo.listSideStories(novel.id);
      expect(story?.title).toBe('雾中支线');
      expect(story?.scenarioSource).toEqual({ scenarioId: scenario.id, forkNodeId: root.id });
      await repo.commitScenarioOutline(novel.id, {
        scenarioId: scenario.id,
        mode: 'side',
        appendToSideStoryId: story!.id,
        title: '',
        synopsis: '',
        forkNodeId: root.id,
        chapters: [{ title: '外二', nodeIds: [b.id], brief: '梗概：渡江' }],
      });
      const chapters = (await repo.listChapters(novel.id)).filter(
        (c) => c.sideStoryId === story!.id,
      );
      expect(chapters.map((c) => [c.index, c.title, c.content, c.scenarioSource])).toEqual([
        [1, '外一', '', { scenarioId: scenario.id, nodeIds: [a.id], brief: '梗概：拔刀' }],
        [2, '外二', '', { scenarioId: scenario.id, nodeIds: [b.id], brief: '梗概：渡江' }],
      ]);
      expect(await repo.getSideStory(story!.id)).toMatchObject({
        title: '雾中支线',
        synopsis: '另一条路',
      });
    });

    it('外传重名、追加目标已删、步骤不属于本推演时整体回滚', async () => {
      const { novel, scenario } = await seedScenario();
      const root = await startOf(scenario.id);
      await repo.createSideStory(novel.id, { title: '支线' });
      const side = (title: string, append: string | null, nodeIds = [root.id]) =>
        repo.commitScenarioOutline(novel.id, {
          scenarioId: scenario.id,
          mode: 'side',
          appendToSideStoryId: append,
          title,
          synopsis: '',
          forkNodeId: root.id,
          chapters: [{ title: '外一', nodeIds, brief: '' }],
        });
      await expect(side('支线', null)).rejects.toThrow('已有同名外传『支线』');
      await expect(side('', 'ghost')).rejects.toThrow('要追加的外传已不存在');
      await expect(side('新支线', null, ['ghost'])).rejects.toThrow('来源步骤不属于这个推演');
      expect((await repo.listSideStories(novel.id)).map((s) => s.title)).toEqual(['支线']);
      expect(await repo.listChapters(novel.id)).toEqual([]);
    });
  });

  describe('提升本线条目', () => {
    async function seedLine() {
      const seeded = await seedScenario();
      const root = await startOf(seeded.scenario.id);
      const { node } = await repo.appendScenarioNode(
        seeded.scenario.id,
        input(root.id, opt(root, 0), {
          delta: {
            ...emptyDelta(),
            lineEntries: [
              {
                localId: 'y',
                categoryId: seeded.char.id,
                title: '阿七',
                summary: '',
                fields: { identity: '孤儿' },
                promotedEntryId: null,
              },
            ],
          },
        }),
      );
      return { ...seeded, node };
    }

    it('create：建通用条目并标记本线条目；再次提升报错', async () => {
      const { novel, node, char } = await seedLine();
      const created = await repo.promoteLineEntry({
        nodeId: node.id,
        localId: 'y',
        create: { categoryId: char.id, title: '阿七', fields: { identity: '孤儿' } },
      });
      expect(created.scope).toEqual({ kind: 'universal' });
      expect((await repo.listEntries(novel.id)).map((e) => e.title)).toContain('阿七');
      const [stored] = (await repo.listScenarioNodes(node.scenarioId)).filter(
        (n) => n.id === node.id,
      );
      expect(stored?.delta.lineEntries[0]?.promotedEntryId).toBe(created.id);
      await expect(
        repo.promoteLineEntry({
          nodeId: node.id,
          localId: 'y',
          create: { categoryId: char.id, title: '阿七' },
        }),
      ).rejects.toThrow('这个本线条目已经提升过了');
    });

    it('mergeInto：更新已有条目、不新建；目标已删时报错、库里不变', async () => {
      const { novel, node, peizhao } = await seedLine();
      const count = (await repo.listEntries(novel.id, { scope: 'all' })).length;
      await repo.softDeleteEntry(peizhao.id);
      await expect(
        repo.promoteLineEntry({
          nodeId: node.id,
          localId: 'y',
          mergeInto: peizhao.id,
          patch: { summary: 'x' },
        }),
      ).rejects.toThrow('要合并进的条目已不存在');
      await repo.restoreEntry(peizhao.id);
      const merged = await repo.promoteLineEntry({
        nodeId: node.id,
        localId: 'y',
        mergeInto: peizhao.id,
        patch: { aliases: ['裴捕头', '阿七'] },
      });
      expect(merged.id).toBe(peizhao.id);
      expect(merged.aliases).toEqual(['裴捕头', '阿七']);
      expect((await repo.listEntries(novel.id, { scope: 'all' })).length).toBe(count);
      const stored = (await repo.listScenarioNodes(node.scenarioId)).find((n) => n.id === node.id);
      expect(stored?.delta.lineEntries[0]?.promotedEntryId).toBe(peizhao.id);
    });
  });

  it('重开数据库后树、差异、已走过与落点完整（验收 30）', async () => {
    const { scenario, peizhao } = await seedScenario();
    const root = await startOf(scenario.id);
    const { node: a } = await repo.appendScenarioNode(
      scenario.id,
      input(root.id, opt(root, 0), {
        delta: {
          ...emptyDelta(),
          fieldOverrides: [
            { target: { kind: 'world', entryId: peizhao.id }, fieldKey: 'identity', value: '叛徒' },
          ],
        },
      }),
    );
    await repo.setScenarioCursor(scenario.id, root.id);
    const nodes = await repo.listScenarioNodes(scenario.id);
    const name = database.name;
    database.close();
    const reopened = new AppDatabase(name);
    await reopened.open();
    const again = new DexieNovelRepository(reopened);
    expect(await again.listScenarioNodes(scenario.id)).toEqual(nodes);
    const after = await again.getScenario(scenario.id);
    expect(after?.cursorNodeId).toBe(root.id);
    expect(after?.mainNodeId).toBe(a.id);
    reopened.close();
    await database.open();
  });

  describe('合并导入按推演整棵替换', () => {
    async function seedMerge() {
      const seeded = await seedScenario();
      const { novel, scenario } = seeded;
      const root = await startOf(scenario.id);
      // 备份：推演 S 在选项 a 下有子节点 R
      const backup = await repo.exportSnapshot();
      const R: ScenarioNode = {
        ...root,
        id: 'node-R',
        parentId: root.id,
        depth: 1,
        arrivedBy: opt(root, 0),
        createdAt: root.createdAt + 1,
        updatedAt: root.createdAt + 1,
      };
      backup.scenarioNodes.push(R);
      backup.scenarios = backup.scenarios.map((s) =>
        s.id === scenario.id ? { ...s, mainNodeId: R.id, cursorNodeId: R.id } : s,
      );
      // 本地：同一选项下推进出 L；另有本地独有的推演 T
      const { node: L } = await repo.appendScenarioNode(scenario.id, input(root.id, opt(root, 0)));
      const T = await repo.createScenario(novel.id, {
        title: '另一局',
        setup: setup(seeded.peizhao.id),
      });
      return { ...seeded, root, R, L, T, backup };
    }

    it('本地 L 消失、节点集合与备份相同、mainNodeId 来自备份；本地独有的推演 T 保留', async () => {
      const { scenario, root, R, T, backup } = await seedMerge();
      await repo.importSnapshot(backup, 'merge');
      expect((await repo.listScenarioNodes(scenario.id)).map((n) => n.id).sort()).toEqual(
        [root.id, R.id].sort(),
      );
      expect((await repo.getScenario(scenario.id))?.mainNodeId).toBe(R.id);
      expect(await repo.getScenario(T.id)).toEqual(T);
    });

    it('清理本地指向 L 的五种引用 ①–⑤，之后导出的备份能被 parseBackup 读回', async () => {
      const { novel, scenario, root, L, T, char, backup } = await seedMerge();
      // ① 大纲节点 nodeIds = [R 的祖先, L]；② 大纲节点 nodeIds = [L]
      await repo.commitScenarioOutline(novel.id, {
        scenarioId: scenario.id,
        mode: 'main',
        volumes: [
          {
            title: '卷',
            synopsis: '',
            targetWords: null,
            chapters: [
              {
                title: '一',
                synopsis: '',
                targetWords: null,
                linkedEntryIds: [],
                nodeIds: [root.id, L.id],
              },
              { title: '二', synopsis: '', targetWords: null, linkedEntryIds: [], nodeIds: [L.id] },
            ],
          },
        ],
      });
      // ③ 外传 forkNodeId = L，章节 nodeIds = [L]
      await repo.commitScenarioOutline(novel.id, {
        scenarioId: scenario.id,
        mode: 'side',
        appendToSideStoryId: null,
        title: '支线',
        synopsis: '',
        forkNodeId: L.id,
        chapters: [{ title: '外一', nodeIds: [L.id], brief: '' }],
      });
      const [sideChapter] = (await repo.listChapters(novel.id)).filter(
        (c) => c.sideStoryId !== null,
      );
      await repo.updateChapter(sideChapter!.id, { content: '外传正文' });
      // ④ 只在 L 子树出现的限定条目；⑤ 同时限定到 T（整推演）
      const only = await repo.createEntry(novel.id, {
        categoryId: char.id,
        title: '老艄公',
        scope: {
          kind: 'limited',
          targets: [{ scenarioId: scenario.id, fromNodeId: L.id, revealHint: '' }],
        },
      });
      const both = await repo.createEntry(novel.id, {
        categoryId: char.id,
        title: '青衣客',
        scope: {
          kind: 'limited',
          targets: [
            { scenarioId: scenario.id, fromNodeId: L.id, revealHint: '' },
            { scenarioId: T.id, fromNodeId: null, revealHint: '' },
          ],
        },
      });

      await repo.importSnapshot(backup, 'merge');

      const outline = await repo.listOutline(novel.id);
      expect(outline.find((n) => n.title === '一')?.scenarioSource).toEqual({
        scenarioId: scenario.id,
        nodeIds: [root.id],
      });
      const second = outline.find((n) => n.title === '二');
      expect(second?.scenarioSource).toBeNull();
      const [story] = await repo.listSideStories(novel.id);
      expect(story?.scenarioSource).toBeNull();
      const chapter = await repo.getChapter(sideChapter!.id);
      expect(chapter?.scenarioSource).toBeNull();
      expect(chapter?.content).toBe('外传正文');
      expect((await repo.getEntry(only.id))?.deletedAt).not.toBeNull();
      const kept = await repo.getEntry(both.id);
      expect(kept?.deletedAt).toBeNull();
      expect(kept?.scope).toEqual({
        kind: 'limited',
        targets: [{ scenarioId: T.id, fromNodeId: null, revealHint: '' }],
      });
      // 合并之后导出的备份必须还能恢复（否则作者只在真要恢复时才发现）
      const text = serializeBackup(buildBackupFile(await repo.exportSnapshot(), 0));
      expect(() => parseBackup(text)).not.toThrow();
    });

    it('覆盖恢复不做清理：整份来自快照；合并导入才清理', async () => {
      const { scenario, root, R, backup } = await seedMerge();
      const prune = vi.spyOn(
        DexieNovelRepository.prototype as unknown as { pruneScenarioRefs: () => Promise<void> },
        'pruneScenarioRefs',
      );
      try {
        await repo.importSnapshot(backup, 'replace');
        expect(prune).not.toHaveBeenCalled();
        expect((await repo.listScenarioNodes(scenario.id)).map((n) => n.id).sort()).toEqual(
          [root.id, R.id].sort(),
        );
        await repo.importSnapshot(backup, 'merge');
        expect(prune).toHaveBeenCalledTimes(1);
      } finally {
        prune.mockRestore();
      }
    });
  });

  it('有限定条目（含推演 OC）时 listEntries 默认结果与只有通用条目时逐项相同；findEntryByName 匹配不到限定条目', async () => {
    const { novel, char } = await seedWorld();
    const universalOnly = await repo.listEntries(novel.id);
    await repo.createScenario(novel.id, {
      title: '雾中渡',
      setup: setup(),
      newOc: { categoryId: char.id, title: '沈砚', fields: {} },
    });
    await repo.createEntry(novel.id, {
      categoryId: char.id,
      title: '裴照之影',
      aliases: ['影子'],
      scope: {
        kind: 'limited',
        targets: [{ scenarioId: 'any', fromNodeId: null, revealHint: '' }],
      },
    });
    expect(await repo.listEntries(novel.id)).toEqual(universalOnly);
    expect(await repo.findEntryByName(novel.id, '沈砚')).toBeUndefined();
    expect(await repo.findEntryByName(novel.id, '影子')).toBeUndefined();
    expect((await repo.findEntryByName(novel.id, '裴捕头'))?.title).toBe('裴照');
  });
});
