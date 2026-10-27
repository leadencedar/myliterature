/**
 * S6 独立验收 · 仓储层：`commitOutlineSubtree` / `updateOutlineLinks`（design §7.2 与 Lead 裁决）。
 *
 * 独立于开发的 DexieNovelRepository.test.ts：夹具与断言按设计规则重写，
 * 重点证明「一个事务」与「失败不留半棵树」，而不是复述开发用例。
 *
 * Lead 裁决（2026-10-27）：`replace + anchor=null` 允许，语义是「整本顶层替换」
 * （立项「重新生成立纲内容」），不得按「必须抛错」断言。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '@/data/dexie/db';
import { DexieNovelRepository } from '@/data/dexie/DexieNovelRepository';
import type { NovelRepository, OutlineTreeInputNode } from '@/data/NovelRepository';
import type { Novel } from '@/domain/schema';

let database: AppDatabase;
let repo: DexieNovelRepository;
let novel: Novel;
let otherNovel: Novel;

beforeEach(async () => {
  database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  repo = new DexieNovelRepository(database);
  novel = await repo.createNovel({ title: 'QA 事务之书' });
  otherNovel = await repo.createNovel({ title: '别的书' });
});

afterEach(async () => {
  database.close();
  await database.delete();
  vi.restoreAllMocks();
});

function leaf(title: string, overrides: Partial<OutlineTreeInputNode> = {}): OutlineTreeInputNode {
  return { title, synopsis: `${title}的梗概`, targetWords: null, children: [], ...overrides };
}

function tree(
  title: string,
  children: OutlineTreeInputNode[] = [],
  overrides: Partial<OutlineTreeInputNode> = {},
): OutlineTreeInputNode {
  return { title, synopsis: `${title}的梗概`, targetWords: 3000, children, ...overrides };
}

async function outline(novelId = novel.id) {
  return repo.listOutline(novelId);
}

describe('S6 · append', () => {
  it('接在现有兄弟之后、父先落库、按前序返回；父 id 与 order 正确', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    const existingA = await repo.createOutlineNode(novel.id, {
      title: '已有A',
      parentId: anchor.id,
    });
    const existingB = await repo.createOutlineNode(novel.id, {
      title: '已有B',
      parentId: anchor.id,
    });

    const created = await repo.commitOutlineSubtree(
      novel.id,
      anchor.id,
      [tree('新C', [leaf('新C1')]), tree('新D')],
      'append',
    );

    // 前序：父在子之前
    expect(created.map((node) => node.title)).toEqual(['新C', '新C1', '新D']);
    expect(created[0]!.id).toBe(created[1]!.parentId);
    expect(created.every((node) => node.novelId === novel.id)).toBe(true);

    const byTitle = new Map(created.map((node) => [node.title, node]));
    expect(byTitle.get('新C1')!.parentId).toBe(byTitle.get('新C')!.id);
    // 接在既有兄弟之后：order 2、3
    expect(byTitle.get('新C')!.order).toBe(2);
    expect(byTitle.get('新D')!.order).toBe(3);
    expect(byTitle.get('新C1')!.order).toBe(0);

    // 既有兄弟未被动过
    const all = await outline();
    expect(all.find((node) => node.id === existingA.id)!.order).toBe(0);
    expect(all.find((node) => node.id === existingB.id)!.order).toBe(1);
    // 返回的节点都真的落库了
    for (const node of created) expect(all.some((row) => row.id === node.id)).toBe(true);
  });

  it('anchor=null 时追加到顶层末尾（立项建树）', async () => {
    const root = await repo.createOutlineNode(novel.id, { title: '旧根' });

    const created = await repo.commitOutlineSubtree(novel.id, null, [tree('新卷')], 'append');
    expect(created.map((node) => node.title)).toEqual(['新卷']);
    expect(created[0]!.parentId).toBeNull();
    expect(created[0]!.order).toBe(1);
    expect((await outline()).find((node) => node.id === root.id)!.order).toBe(0);
  });

  it('空 nodes 抛错，且零写入', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    await expect(repo.commitOutlineSubtree(novel.id, anchor.id, [], 'append')).rejects.toThrow(
      /为空|没有可创建/u,
    );
    await expect(repo.commitOutlineSubtree(novel.id, null, [], 'append')).rejects.toThrow();
    expect(await outline()).toHaveLength(1);
  });

  it('中途失败整体回滚：不留下已建的前半棵树', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    const existing = await repo.createOutlineNode(novel.id, { title: '旧子', parentId: anchor.id });

    const bad: OutlineTreeInputNode = leaf('x'.repeat(201)); // 标题超 200 字，事务内 Zod 抛错
    await expect(
      repo.commitOutlineSubtree(novel.id, anchor.id, [tree('好的'), bad], 'append'),
    ).rejects.toThrow();

    const all = await outline();
    expect(all.map((node) => node.id).sort()).toEqual([anchor.id, existing.id].sort());
    expect(all.some((node) => node.title === '好的')).toBe(false);
  });

  it('预留的 linkedEntryIds 原样落库（M3 用）', async () => {
    const created = await repo.commitOutlineSubtree(
      novel.id,
      null,
      [tree('带关联', [], { linkedEntryIds: ['e1', 'e2'] })],
      'append',
    );
    expect(created[0]!.linkedEntryIds).toEqual(['e1', 'e2']);
    expect((await outline())[0]!.linkedEntryIds).toEqual(['e1', 'e2']);
  });
});

describe('S6 · replace', () => {
  async function seedBranch() {
    const anchor = await repo.createOutlineNode(novel.id, { title: '要替换的卷' });
    const c1 = await repo.createOutlineNode(novel.id, { title: '旧子一', parentId: anchor.id });
    const g1 = await repo.createOutlineNode(novel.id, { title: '旧孙', parentId: c1.id });
    const c2 = await repo.createOutlineNode(novel.id, { title: '旧子二', parentId: anchor.id });
    const otherAnchor = await repo.createOutlineNode(novel.id, { title: '另一卷' });
    const otherChild = await repo.createOutlineNode(novel.id, {
      title: '另一卷的子',
      parentId: otherAnchor.id,
    });
    return { anchor, c1, g1, c2, otherAnchor, otherChild };
  }

  it('删锚点下整棵子树、解链章节、锚点与其他分支保留；正文不丢', async () => {
    const { anchor, c1, g1, c2, otherAnchor, otherChild } = await seedBranch();
    const chG = await repo.createChapter(novel.id, {
      title: '挂孙节点',
      content: '这段正文必须保留。',
      outlineNodeId: g1.id,
    });
    const chC = await repo.createChapter(novel.id, {
      title: '挂子节点',
      content: '',
      outlineNodeId: c2.id,
    });
    const chOther = await repo.createChapter(novel.id, {
      title: '挂另一卷',
      outlineNodeId: otherChild.id,
      content: '别动我。',
    });
    const rootSibling = await repo.createOutlineNode(novel.id, { title: '无关根' });

    const created = await repo.commitOutlineSubtree(
      novel.id,
      anchor.id,
      [tree('新子一'), tree('新子二', [leaf('新孙')])],
      'replace',
    );
    expect(created.map((node) => node.title)).toEqual(['新子一', '新子二', '新孙']);

    const all = await outline();
    const ids = new Set(all.map((node) => node.id));
    // 旧子树全部删除
    for (const oldId of [c1.id, g1.id, c2.id]) expect(ids.has(oldId)).toBe(false);
    // 锚点、另一卷、无关根保留
    for (const keepId of [anchor.id, otherAnchor.id, otherChild.id, rootSibling.id]) {
      expect(ids.has(keepId)).toBe(true);
    }
    // 新子层 order 连续
    const newChildren = all
      .filter((node) => node.parentId === anchor.id)
      .sort((a, b) => a.order - b.order);
    expect(newChildren.map((node) => node.title)).toEqual(['新子一', '新子二']);
    expect(newChildren.map((node) => node.order)).toEqual([0, 1]);

    // 章节：正文保留、大纲关联解除；非受影响章节不动
    const keptG = await repo.getChapter(chG.id);
    expect(keptG).toMatchObject({ content: '这段正文必须保留。', outlineNodeId: null });
    expect((await repo.getChapter(chC.id))!.outlineNodeId).toBeNull();
    expect((await repo.getChapter(chOther.id))!.outlineNodeId).toBe(otherChild.id);
  });

  it('replace + anchor=null = 整本顶层替换（Lead 裁决允许，不是抛错）', async () => {
    const rootA = await repo.createOutlineNode(novel.id, { title: '旧根A' });
    const childA = await repo.createOutlineNode(novel.id, { title: '旧枝A', parentId: rootA.id });
    const rootB = await repo.createOutlineNode(novel.id, { title: '旧根B' });
    const chA = await repo.createChapter(novel.id, {
      title: '挂旧枝',
      content: '旧正文保留。',
      outlineNodeId: childA.id,
    });
    const chB = await repo.createChapter(novel.id, {
      title: '挂旧根',
      outlineNodeId: rootB.id,
    });

    const created = await repo.commitOutlineSubtree(
      novel.id,
      null,
      [tree('新根一', [leaf('新枝')]), tree('新根二')],
      'replace',
    );

    expect(created.map((node) => node.title)).toEqual(['新根一', '新枝', '新根二']);
    const all = await outline();
    expect(all.map((node) => node.title).sort()).toEqual(['新根一', '新根二', '新枝'].sort());
    expect(all.filter((node) => node.parentId === null).map((node) => node.order)).toEqual([0, 1]);
    // 旧根/旧枝全部删除、章节全部解链（正文保留）
    for (const oldId of [rootA.id, childA.id, rootB.id]) {
      expect(all.some((node) => node.id === oldId)).toBe(false);
    }
    expect(await repo.getChapter(chA.id)).toMatchObject({
      content: '旧正文保留。',
      outlineNodeId: null,
    });
    expect((await repo.getChapter(chB.id))!.outlineNodeId).toBeNull();
  });

  it('replace + anchor=null 中途失败：旧根与章节关联整体回滚', async () => {
    const rootA = await repo.createOutlineNode(novel.id, { title: '旧根A' });
    const childA = await repo.createOutlineNode(novel.id, { title: '旧枝A', parentId: rootA.id });
    const chA = await repo.createChapter(novel.id, {
      title: '挂旧枝',
      content: '旧正文。',
      outlineNodeId: childA.id,
    });

    await expect(
      repo.commitOutlineSubtree(novel.id, null, [tree('新根一'), leaf('x'.repeat(201))], 'replace'),
    ).rejects.toThrow();

    const all = await outline();
    expect(all.map((node) => node.title).sort()).toEqual(['旧根A', '旧枝A'].sort());
    expect((await repo.getChapter(chA.id))!.outlineNodeId).toBe(childA.id);
  });

  it('anchor 不存在/属于别的书时抛错，旧树与章节关联零变化', async () => {
    const { anchor, c1, g1, c2 } = await seedBranch();
    const ch = await repo.createChapter(novel.id, { title: '挂孙', outlineNodeId: g1.id });
    const before = await outline();
    const beforeChapter = await repo.getChapter(ch.id);

    await expect(
      repo.commitOutlineSubtree(novel.id, 'ghost-anchor', [tree('新')], 'replace'),
    ).rejects.toThrow();

    const foreign = await repo.createOutlineNode(otherNovel.id, { title: '别的书的节点' });
    await expect(
      repo.commitOutlineSubtree(novel.id, foreign.id, [tree('新')], 'replace'),
    ).rejects.toThrow();

    // 用别的书作为 novelId、拿本书 anchor 也一样
    await expect(
      repo.commitOutlineSubtree(otherNovel.id, anchor.id, [tree('新')], 'replace'),
    ).rejects.toThrow();

    expect(await outline()).toEqual(before);
    expect(await repo.getChapter(ch.id)).toEqual(beforeChapter);
    // 旧分支还在
    for (const id of [anchor.id, c1.id, g1.id, c2.id]) {
      expect(before.some((node) => node.id === id)).toBe(true);
    }
  });

  it('replace 空 nodes 抛错，旧树不变', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    await repo.createOutlineNode(novel.id, { title: '旧子', parentId: anchor.id });

    await expect(repo.commitOutlineSubtree(novel.id, anchor.id, [], 'replace')).rejects.toThrow();
    await expect(repo.commitOutlineSubtree(novel.id, null, [], 'replace')).rejects.toThrow();
    // 两个节点同层时 order 都是 0，listOutline 以 createdAt 兜底；并发的毫秒时间戳可能相同，
    // 用排序后的标题集合断言，避免依赖底层行序（全量并发跑时的偶发翻转）
    expect((await outline()).map((node) => node.title).sort()).toEqual(['旧子', '锚点'].sort());
  });
});

describe('S6 · updateOutlineLinks', () => {
  it('批量写入关联；标题/梗概/状态/顺序不动，updatedAt 更新', async () => {
    const a = await repo.createOutlineNode(novel.id, {
      title: '甲',
      synopsis: '甲的梗概',
      targetWords: 1200,
    });
    const b = await repo.createOutlineNode(novel.id, { title: '乙' });
    await new Promise((resolve) => setTimeout(resolve, 2));

    await repo.updateOutlineLinks([
      { id: a.id, linkedEntryIds: ['e1', 'e2'] },
      { id: b.id, linkedEntryIds: ['e3'] },
    ]);

    const afterA = (await outline()).find((node) => node.id === a.id)!;
    const afterB = (await outline()).find((node) => node.id === b.id)!;
    expect(afterA.linkedEntryIds).toEqual(['e1', 'e2']);
    expect(afterB.linkedEntryIds).toEqual(['e3']);
    expect(afterA).toMatchObject({
      title: '甲',
      synopsis: '甲的梗概',
      targetWords: 1200,
      status: a.status,
      order: a.order,
    });
    expect(afterA.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
  });

  it('任一 id 不存在时整批失败，已存在节点保持原关联', async () => {
    const a = await repo.createOutlineNode(novel.id, { title: '甲' });

    await expect(
      repo.updateOutlineLinks([
        { id: a.id, linkedEntryIds: ['e1'] },
        { id: 'ghost-node', linkedEntryIds: ['e2'] },
      ]),
    ).rejects.toThrow();

    expect((await outline()).find((node) => node.id === a.id)!.linkedEntryIds).toEqual([]);
  });

  it('空数组是 no-op；可以用空数组清空关联', async () => {
    const a = await repo.createOutlineNode(novel.id, { title: '甲', linkedEntryIds: ['e1'] });
    await expect(repo.updateOutlineLinks([])).resolves.toBeUndefined();
    expect((await outline())[0]!.linkedEntryIds).toEqual(['e1']);

    await repo.updateOutlineLinks([{ id: a.id, linkedEntryIds: [] }]);
    expect((await outline())[0]!.linkedEntryIds).toEqual([]);
  });
});

describe('S6 · 事务边界（design §7.2）', () => {
  it('commitOutlineSubtree 只开一个事务，且不调用公共 deleteOutlineNode（不嵌套事务）', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    const oldChild = await repo.createOutlineNode(novel.id, { title: '旧子', parentId: anchor.id });
    await repo.createChapter(novel.id, { title: '挂旧子', outlineNodeId: oldChild.id });

    const transactionSpy = vi.spyOn(database, 'transaction');
    const deleteSpy = vi.spyOn(DexieNovelRepository.prototype, 'deleteOutlineNode');

    await repo.commitOutlineSubtree(novel.id, anchor.id, [tree('新子')], 'replace');

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    // 事务参与表包含 outlineNodes 与 chapters
    const tableArg: unknown = transactionSpy.mock.calls[0]![1];
    const tables: readonly unknown[] = Array.isArray(tableArg) ? tableArg : [tableArg];
    expect(tables).toContain(database.outlineNodes);
    expect(tables).toContain(database.chapters);
    // 没有嵌套/旁路删除
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('失败路径也只有一个事务（回滚后无残留）', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    const transactionSpy = vi.spyOn(database, 'transaction');

    await expect(
      repo.commitOutlineSubtree(novel.id, anchor.id, [leaf('x'.repeat(201))], 'append'),
    ).rejects.toThrow();

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(await outline()).toHaveLength(1);
  });
});

describe('S6 · 接口契约（NovelRepository）', () => {
  it('仓储实现满足 NovelRepository 接口（方法存在且可调用）', () => {
    const asInterface: NovelRepository = repo;
    expect(typeof asInterface.commitOutlineSubtree).toBe('function');
    expect(typeof asInterface.updateOutlineLinks).toBe('function');
  });
});
