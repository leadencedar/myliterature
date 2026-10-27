/**
 * S6 独立验收 · apply 层：`outlineTree:create|merge|replace` 走事务方法（design §7.3）。
 *
 * 证明四件事：
 * 1) create/merge 走 append、replace 走 replace，节点与顺序正确；
 * 2) 挂载点校验收进事务（apply 不再预查 listOutline），apply 前被删 → 失败且提案仍 pending；
 * 3) 建树中途失败整批回滚（旧树、章节关联、提案状态都正确）；
 * 4) 立项的「重新生成大纲」= replace + parentId 缺省（Lead 裁决的整本顶层替换）仍然工作。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '@/data/dexie/db';
import { DexieNovelRepository } from '@/data/dexie/DexieNovelRepository';
import { now, newId } from '@/domain/primitives';
import { ProposalSchema, type Novel, type Proposal } from '@/domain/schema';
import { acceptProposals, applyProposal } from '@/proposal/apply';

let database: AppDatabase;
let repo: DexieNovelRepository;
let novel: Novel;
let batchSeq = 0;

beforeEach(async () => {
  database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  repo = new DexieNovelRepository(database);
  novel = await repo.createNovel({ title: 'QA apply 之书' });
  batchSeq = 0;
});

afterEach(async () => {
  database.close();
  await database.delete();
  vi.restoreAllMocks();
});

function outlineTreeProposal(
  action: 'create' | 'merge' | 'replace',
  outlineText: string,
  parentId?: string | null,
): Proposal {
  batchSeq += 1;
  return ProposalSchema.parse({
    id: newId(),
    novelId: novel.id,
    batchId: `batch-${batchSeq}`,
    order: 0,
    origin: 'generate',
    target: 'outlineTree',
    action,
    targetId: action === 'create' ? null : (parentId ?? novel.id),
    label: `QA 大纲树 ${action}`,
    payload: { outlineText, ...(parentId !== undefined ? { parentId } : {}) },
    diff: [],
    sourceRef: '',
    status: 'pending',
    createdAt: now(),
    decidedAt: null,
  });
}

async function pendingProposals(): Promise<Proposal[]> {
  return repo.listProposals(novel.id, { status: 'pending' });
}

async function titles(novelId = novel.id): Promise<string[]> {
  const rows = await repo.listOutline(novelId);
  return rows
    .filter((node) => node.parentId === null)
    .sort((a, b) => a.order - b.order)
    .flatMap((node) => {
      const children = rows
        .filter((child) => child.parentId === node.id)
        .sort((a, b) => a.order - b.order)
        .map((child) => `  ${child.title}`);
      return [node.title, ...children];
    });
}

describe('S6-apply · create / merge = append', () => {
  it('create 带 parentId：挂在锚点下，接在现有子节点之后', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    await repo.createOutlineNode(novel.id, { title: '旧第一章', parentId: anchor.id });

    await applyProposal(
      repo,
      outlineTreeProposal('create', '# 新第一章\n夜里落雪。\n# 新第二章\n追兵临门。', anchor.id),
    );

    expect(await titles()).toEqual(['第一卷', '  旧第一章', '  新第一章', '  新第二章']);
    const children = (await repo.listOutline(novel.id))
      .filter((node) => node.parentId === anchor.id)
      .sort((a, b) => a.order - b.order);
    expect(children.map((node) => node.order)).toEqual([0, 1, 2]);
  });

  it('create 不带 parentId：追加到顶层末尾', async () => {
    const root = await repo.createOutlineNode(novel.id, { title: '旧卷' });

    await applyProposal(repo, outlineTreeProposal('create', '# 新卷\n新卷梗概。'));

    expect(await titles()).toEqual(['旧卷', '新卷']);
    const roots = (await repo.listOutline(novel.id)).filter((node) => node.parentId === null);
    expect(roots.find((node) => node.title === '新卷')!.order).toBe(1);
    expect((await repo.listOutline(novel.id)).find((node) => node.id === root.id)!.order).toBe(0);
  });

  it('merge 也走 append（不删除既有节点）', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    await repo.createOutlineNode(novel.id, { title: '已有子', parentId: anchor.id });

    await applyProposal(repo, outlineTreeProposal('merge', '# 新增子\n梗概。', anchor.id));

    expect((await repo.listOutline(novel.id)).filter((n) => n.parentId === anchor.id)).toHaveLength(
      2,
    );
  });

  it('没有标题行时拒绝落库，零写入', async () => {
    const before = await repo.listOutline(novel.id);
    await expect(applyProposal(repo, outlineTreeProposal('create', '不是标题'))).rejects.toThrow(
      /大纲内容为空|标题行/u,
    );
    expect(await repo.listOutline(novel.id)).toEqual(before);
  });
});

describe('S6-apply · replace = 事务替换', () => {
  it('replace 带 parentId：替换该层、旧子树删除、章节解链但正文保留', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    const oldChild = await repo.createOutlineNode(novel.id, {
      title: '旧章',
      parentId: anchor.id,
    });
    const oldGrandchild = await repo.createOutlineNode(novel.id, {
      title: '旧节',
      parentId: oldChild.id,
    });
    const chapter = await repo.createChapter(novel.id, {
      title: '挂旧节',
      content: '正文是用户资产。',
      outlineNodeId: oldGrandchild.id,
    });

    await applyProposal(repo, outlineTreeProposal('replace', '# 新章\n新梗概。', anchor.id));

    const rows = await repo.listOutline(novel.id);
    expect(rows.map((node) => node.title)).not.toContain('旧章');
    expect(rows.map((node) => node.title)).not.toContain('旧节');
    expect(rows.map((node) => node.title)).toContain('新章');
    expect(await repo.getChapter(chapter.id)).toMatchObject({
      content: '正文是用户资产。',
      outlineNodeId: null,
    });
  });

  it('replace 不带 parentId：立项目径的整本顶层替换（Lead 裁决允许）', async () => {
    const oldRoot = await repo.createOutlineNode(novel.id, { title: '旧全书卷' });
    const oldChild = await repo.createOutlineNode(novel.id, {
      title: '旧全书章',
      parentId: oldRoot.id,
    });
    const chapter = await repo.createChapter(novel.id, {
      title: '挂旧章',
      content: '旧正文保留。',
      outlineNodeId: oldChild.id,
    });

    await applyProposal(repo, outlineTreeProposal('replace', '# 新全书卷\n## 新全书章\n新梗概。'));

    expect(await titles()).toEqual(['新全书卷', '  新全书章']);
    const rows = await repo.listOutline(novel.id);
    expect(rows.some((node) => node.id === oldRoot.id || node.id === oldChild.id)).toBe(false);
    expect(await repo.getChapter(chapter.id)).toMatchObject({
      content: '旧正文保留。',
      outlineNodeId: null,
    });
  });

  it('apply 前挂载点被删：失败、提案保持 pending、旧树与章节零变化', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    await repo.createOutlineNode(novel.id, { title: '旧子', parentId: anchor.id });
    const chapter = await repo.createChapter(novel.id, {
      title: '挂旧子',
      outlineNodeId: (await repo.listOutline(novel.id)).find((node) => node.title === '旧子')!.id,
    });
    const proposal = outlineTreeProposal('replace', '# 新子\n梗概。', anchor.id);
    await repo.createProposals([proposal]);
    await repo.deleteOutlineNode(anchor.id);

    await expect(applyProposal(repo, proposal)).rejects.toThrow(/已不存在|可能已被删除/u);

    expect(await repo.listOutline(novel.id)).toEqual([]);
    // 提案仍在待确认里（apply 失败不标记 accepted）
    const pending = await pendingProposals();
    expect(pending.map((item) => item.id)).toContain(proposal.id);
    expect((await repo.getChapter(chapter.id))!.outlineNodeId).toBeNull();
  });

  it('建树中途失败：整批回滚，提案保持 pending，不写任何新节点', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    const oldChild = await repo.createOutlineNode(novel.id, { title: '旧子', parentId: anchor.id });
    const chapter = await repo.createChapter(novel.id, {
      title: '挂旧子',
      outlineNodeId: oldChild.id,
      content: '旧正文。',
    });
    // 第二个节点标题超过 200 字：parse 在事务内抛错
    const badTitle = 'x'.repeat(201);
    const proposal = outlineTreeProposal('replace', `# 好节点\n## ${badTitle}\n梗概。`, anchor.id);

    await expect(applyProposal(repo, proposal)).rejects.toThrow();

    const rows = await repo.listOutline(novel.id);
    expect(rows.map((node) => node.title).sort()).toEqual(['锚点', '旧子'].sort());
    expect((await repo.getChapter(chapter.id))!.outlineNodeId).toBe(oldChild.id);
    expect((await repo.getChapter(chapter.id))!.content).toBe('旧正文。');
  });

  it('apply 不再预先 listOutline（存在性校验在事务内，无 TOCTOU 窗口）', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    const listSpy = vi.spyOn(DexieNovelRepository.prototype, 'listOutline');

    await applyProposal(repo, outlineTreeProposal('create', '# 新章\n梗概。', anchor.id));

    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('S6-apply · acceptProposals 与事务失败语义', () => {
  it('成功时标记 accepted；失败只标记 failed 项，成功的照常', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '锚点' });
    const good = outlineTreeProposal('create', '# 好节点\n梗概。', anchor.id);
    const bad = outlineTreeProposal(
      'create',
      '# 坏节点\n## ' + 'y'.repeat(201) + '\n梗概。',
      anchor.id,
    );
    await repo.createProposals([good, bad]);

    const result = await acceptProposals(repo, [good, bad]);

    expect(result.accepted).toEqual([good.id]);
    expect(result.failed.map((item) => item.proposalId)).toEqual([bad.id]);
    expect(result.failed[0]!.message.length).toBeGreaterThan(0);

    const goodStored = (await repo.listProposals(novel.id)).find((item) => item.id === good.id)!;
    const badStored = (await repo.listProposals(novel.id)).find((item) => item.id === bad.id)!;
    expect(goodStored.status).toBe('accepted');
    expect(badStored.status).toBe('pending');
    // 失败项没有留下半棵树
    expect((await repo.listOutline(novel.id)).map((node) => node.title).sort()).toEqual(
      ['好节点', '锚点'].sort(),
    );
  });
});
