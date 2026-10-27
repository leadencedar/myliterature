import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '@/data/dexie/db';
import { DexieNovelRepository } from '@/data/dexie/DexieNovelRepository';
import { emptyDelta, type Novel, type Proposal, type SideStory } from '@/domain/schema';
import { acceptProposals, applyProposal, rejectProposals } from './apply';
import { buildCreateProposal, buildMergeProposal, buildReplaceProposal, newBatchId } from './build';
import { entryFieldSpecs, fieldSpecsFor } from './fields';

let database: AppDatabase;
let repo: DexieNovelRepository;
let novel: Novel;
let characterCategoryId: string;

beforeEach(async () => {
  database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  repo = new DexieNovelRepository(database);
  novel = await repo.createNovel({ title: '提案之书' });
  const categories = await repo.listCategories(novel.id);
  characterCategoryId = categories[1]!.id;
});

afterEach(async () => {
  database.close();
  await database.delete();
});

async function characterSpecs() {
  const categories = await repo.listCategories(novel.id);
  return entryFieldSpecs(categories.find((c) => c.id === characterCategoryId));
}

describe('知识条目', () => {
  it('新建提案落库成新条目', async () => {
    const proposal = buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'knowledgeEntry',
      label: '人物 · 林越',
      specs: await characterSpecs(),
      payload: {
        categoryId: characterCategoryId,
        title: '林越',
        aliases: ['阿越'],
        summary: '少年剑客',
        fields: { identity: '流亡贵族' },
      },
    });

    await applyProposal(repo, proposal);

    const entries = await repo.listEntries(novel.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: '林越',
      aliases: ['阿越'],
      summary: '少年剑客',
      fields: { identity: '流亡贵族' },
      version: 1,
    });
  });

  it('缺少分类或条目名时拒绝落库', async () => {
    const specs = await characterSpecs();
    const noCategory = buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'knowledgeEntry',
      label: '坏数据',
      specs,
      payload: { title: '林越' },
    });
    await expect(applyProposal(repo, noCategory)).rejects.toThrow();

    const noTitle = buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'knowledgeEntry',
      label: '坏数据',
      specs,
      payload: { categoryId: characterCategoryId, title: '' },
    });
    await expect(applyProposal(repo, noTitle)).rejects.toThrow();
  });

  it('合并提案更新已有条目并递增版本号', async () => {
    const existing = await repo.createEntry(novel.id, {
      categoryId: characterCategoryId,
      title: '林越',
      aliases: ['阿越'],
      summary: '原摘要',
    });

    const proposal = buildMergeProposal({
      novelId: novel.id,
      origin: 'extract',
      target: 'knowledgeEntry',
      label: '人物 · 林越',
      specs: await characterSpecs(),
      targetId: existing.id,
      current: existing,
      incoming: { aliases: ['越哥'], summary: '整合后的摘要' },
      sourceRef: '第 3 章',
    });

    await applyProposal(repo, proposal);

    const updated = await repo.getEntry(existing.id);
    expect(updated).toMatchObject({
      aliases: ['阿越', '越哥'],
      summary: '整合后的摘要',
      version: 2,
    });
  });

  it('目标条目已被删除时给出可理解的报错', async () => {
    const existing = await repo.createEntry(novel.id, {
      categoryId: characterCategoryId,
      title: '林越',
    });
    const proposal = buildMergeProposal({
      novelId: novel.id,
      origin: 'extract',
      target: 'knowledgeEntry',
      label: '人物 · 林越',
      specs: await characterSpecs(),
      targetId: existing.id,
      current: existing,
      incoming: { summary: '新摘要' },
    });
    await repo.hardDeleteEntry(existing.id);

    await expect(applyProposal(repo, proposal)).rejects.toThrow('已不存在');
  });
});

describe('其他实体', () => {
  it('大纲节点新建与更新', async () => {
    const create = buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'outlineNode',
      label: '第一幕',
      specs: fieldSpecsFor('outlineNode'),
      payload: { title: '第一幕', synopsis: '主角被追杀', targetWords: 9000 },
    });
    await applyProposal(repo, create);

    const nodes = await repo.listOutline(novel.id);
    expect(nodes[0]).toMatchObject({ title: '第一幕', targetWords: 9000 });

    const update = buildReplaceProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'outlineNode',
      label: '第一幕',
      specs: fieldSpecsFor('outlineNode'),
      targetId: nodes[0]!.id,
      current: nodes[0],
      payload: { title: '第一幕（修订）', synopsis: '主角被追杀并逃入雪山' },
    });
    await applyProposal(repo, update);

    expect((await repo.listOutline(novel.id))[0]?.title).toBe('第一幕（修订）');
  });

  it('章节生成落库时标记来源为 AI', async () => {
    const proposal = buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'chapter',
      label: '第一章',
      specs: fieldSpecsFor('chapter'),
      payload: { title: '第一章', content: '雪落下来了。' },
    });

    await applyProposal(repo, proposal);

    const chapters = await repo.listChapters(novel.id);
    expect(chapters[0]).toMatchObject({ title: '第一章', source: 'ai', index: 1 });
    // 字数由正文推导
    expect(chapters[0]?.wordCount).toBe(6);
  });

  it('章节摘要按章节 upsert', async () => {
    const chapter = await repo.createChapter(novel.id, { content: '正文' });
    const proposal = buildCreateProposal({
      novelId: novel.id,
      origin: 'refine',
      target: 'chapterSummary',
      label: '第一章摘要',
      specs: fieldSpecsFor('chapterSummary'),
      payload: {
        chapterId: chapter.id,
        summary: '主角抵达雪山',
        keyEvents: ['遭遇追兵'],
        openThreads: ['黑衣人的身份'],
      },
    });

    await applyProposal(repo, proposal);

    const summary = await repo.getSummaryByChapter(chapter.id);
    expect(summary).toMatchObject({
      summary: '主角抵达雪山',
      openThreads: ['黑衣人的身份'],
    });
  });

  it('风格档案的自定义 rubric 落库', async () => {
    const proposal = buildReplaceProposal({
      novelId: novel.id,
      origin: 'refine',
      target: 'styleProfile',
      label: '文风取样',
      specs: fieldSpecsFor('styleProfile'),
      targetId: novel.id,
      current: {},
      payload: {
        customRubric: { sentenceRhythm: '短句为主，节奏顿挫', imagery: '偏爱冷色意象' },
      },
    });

    await applyProposal(repo, proposal);

    const style = await repo.getStyleProfile(novel.id);
    expect(style?.customRubric?.sentenceRhythm).toBe('短句为主，节奏顿挫');
    // 未提供的 rubric 字段补空串而不是 undefined
    expect(style?.customRubric?.avoid).toBe('');
  });

  it('小说级字段更新（全书滚动摘要）', async () => {
    const proposal = buildReplaceProposal({
      novelId: novel.id,
      origin: 'refine',
      target: 'novel',
      label: '全书进展',
      specs: fieldSpecsFor('novel'),
      targetId: novel.id,
      current: novel,
      payload: { rollingSummary: '主角已离开雪山，掌握第一条线索。' },
    });

    await applyProposal(repo, proposal);

    expect((await repo.getNovel(novel.id))?.rollingSummary).toBe(
      '主角已离开雪山，掌握第一条线索。',
    );
  });
});

describe('大纲树事务化（outlineTree）', () => {
  function outlineTreeCreate(payload: { outlineText: string; parentId?: string | null }): Proposal {
    return buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'outlineTree',
      label: '全书大纲',
      specs: fieldSpecsFor('outlineTree'),
      payload,
    });
  }

  it('create：按层级建树，挂在锚点下时接在既有子节点之后', async () => {
    const volume = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    const existing = await repo.createOutlineNode(novel.id, {
      title: '旧章',
      parentId: volume.id,
    });

    await applyProposal(
      repo,
      outlineTreeCreate({
        outlineText:
          '# 第一卷 风起（约 30000 字）\n主角被追杀。\n## 第1章 雪夜（约 3000 字）\n追兵临门。',
        parentId: volume.id,
      }),
    );

    const children = (await repo.listOutline(novel.id))
      .filter((node) => node.parentId === volume.id)
      .sort((a, b) => a.order - b.order);
    expect(children.map((node) => node.title)).toEqual(['旧章', '第一卷 风起']);
    expect(children[1]).toMatchObject({ order: existing.order + 1, targetWords: 30000 });
    const grandchild = (await repo.listOutline(novel.id)).find(
      (node) => node.parentId === children[1]!.id,
    );
    expect(grandchild).toMatchObject({ title: '第1章 雪夜', targetWords: 3000, order: 0 });
  });

  it('create：不带 parentId 时追加到顶层末尾', async () => {
    const first = await repo.createOutlineNode(novel.id, { title: '旧卷一' });

    await applyProposal(repo, outlineTreeCreate({ outlineText: '# 新卷一\n## 第一章' }));

    const nodes = await repo.listOutline(novel.id);
    const roots = nodes.filter((node) => node.parentId === null).sort((a, b) => a.order - b.order);
    expect(roots.map((node) => node.title)).toEqual(['旧卷一', '新卷一']);
    expect(roots[0]!.id).toBe(first.id);
    expect(roots[1]!.order).toBe(1);
    expect(nodes.find((node) => node.parentId === roots[1]!.id)?.title).toBe('第一章');
  });

  it('replace：替换锚点下子层，解链章节但正文保留', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    const oldChild = await repo.createOutlineNode(novel.id, {
      title: '旧章',
      parentId: anchor.id,
    });
    const chapter = await repo.createChapter(novel.id, {
      title: '旧章正文',
      content: '正文不能丢',
      outlineNodeId: oldChild.id,
    });

    await applyProposal(
      repo,
      buildReplaceProposal({
        novelId: novel.id,
        origin: 'generate',
        target: 'outlineTree',
        label: '细化 · 第一卷',
        specs: fieldSpecsFor('outlineTree'),
        targetId: anchor.id,
        current: { outlineText: '# 旧章\n旧梗概' },
        payload: { outlineText: '# 新章\n新梗概', parentId: anchor.id },
      }),
    );

    const nodes = await repo.listOutline(novel.id);
    expect(nodes.filter((node) => node.parentId === anchor.id).map((node) => node.title)).toEqual([
      '新章',
    ]);
    expect(nodes.some((node) => node.id === oldChild.id)).toBe(false);
    const kept = await repo.getChapter(chapter.id);
    expect(kept?.content).toBe('正文不能丢');
    expect(kept?.outlineNodeId).toBeNull();
  });

  it('replace：不带 parentId 是整本顶层替换（立项重新生成大纲）', async () => {
    const oldRoot = await repo.createOutlineNode(novel.id, { title: '旧的第一卷' });
    await repo.createOutlineNode(novel.id, { title: '旧的第一章', parentId: oldRoot.id });

    await applyProposal(
      repo,
      buildReplaceProposal({
        novelId: novel.id,
        origin: 'generate',
        target: 'outlineTree',
        label: '全书大纲',
        specs: fieldSpecsFor('outlineTree'),
        targetId: novel.id,
        current: { outlineText: '# 旧的第一卷\n## 旧的第一章' },
        payload: { outlineText: '# 第一卷 风起\n## 第1章 雪夜' },
      }),
    );

    const nodes = await repo.listOutline(novel.id);
    expect(nodes.some((node) => node.id === oldRoot.id)).toBe(false);
    // 旧根已清掉：新树是完整的一棵，不叠加在旧树上
    expect(nodes).toHaveLength(2);
    const root = nodes.find((node) => node.parentId === null);
    expect(root).toMatchObject({ title: '第一卷 风起', order: 0 });
    expect(nodes.find((node) => node.parentId === root!.id)?.title).toBe('第1章 雪夜');
  });

  it('挂载点已不存在时报错，什么都不写', async () => {
    const other = await repo.createOutlineNode(novel.id, { title: '别的卷' });

    await expect(
      applyProposal(repo, outlineTreeCreate({ outlineText: '# 新章', parentId: 'ghost' })),
    ).rejects.toThrow('已不存在');

    expect((await repo.listOutline(novel.id)).map((node) => node.id)).toEqual([other.id]);
  });

  it('大纲内容没有标题行时拒绝落库', async () => {
    await expect(
      applyProposal(repo, outlineTreeCreate({ outlineText: '只有一段没有 # 标题的文字' })),
    ).rejects.toThrow('大纲内容为空');
    expect(await repo.listOutline(novel.id)).toHaveLength(0);
  });

  it('建树中途失败时整批回滚：旧子层与章节关联都保留', async () => {
    const anchor = await repo.createOutlineNode(novel.id, { title: '第一卷' });
    const oldChild = await repo.createOutlineNode(novel.id, {
      title: '旧章',
      parentId: anchor.id,
    });
    const chapter = await repo.createChapter(novel.id, {
      title: '旧章正文',
      outlineNodeId: oldChild.id,
    });

    // 标题超过节点 schema 的 200 字上限：第一棵子树写进去了也必须随事务回滚
    await expect(
      applyProposal(
        repo,
        buildReplaceProposal({
          novelId: novel.id,
          origin: 'generate',
          target: 'outlineTree',
          label: '细化 · 第一卷',
          specs: fieldSpecsFor('outlineTree'),
          targetId: anchor.id,
          current: { outlineText: '# 旧章' },
          payload: {
            outlineText: '# 合法新章\n## 新节\n# ' + '长'.repeat(201),
            parentId: anchor.id,
          },
        }),
      ),
    ).rejects.toThrow();

    const nodes = await repo.listOutline(novel.id);
    expect(nodes.map((node) => node.id).sort()).toEqual([anchor.id, oldChild.id].sort());
    expect((await repo.getChapter(chapter.id))?.outlineNodeId).toBe(oldChild.id);
  });
});

describe('外传进展摘要', () => {
  function sideStoryProposal(story: SideStory) {
    return buildReplaceProposal({
      novelId: novel.id,
      origin: 'refine',
      target: 'sideStory',
      label: '外传进展摘要',
      specs: fieldSpecsFor('sideStory'),
      targetId: story.id,
      current: { rollingSummary: story.rollingSummary },
      payload: { rollingSummary: '师父下山，遇见少年时的掌门。' },
      sourceRef: '外传·青冥旧事 第 1 章',
    });
  }

  it('sideStory:replace 更新外传进展，作品进展不变', async () => {
    await repo.updateNovel(novel.id, { rollingSummary: '主线进展。' });
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });

    await applyProposal(repo, sideStoryProposal(story));

    expect((await repo.getSideStory(story.id))?.rollingSummary).toBe(
      '师父下山，遇见少年时的掌门。',
    );
    expect((await repo.getNovel(novel.id))?.rollingSummary).toBe('主线进展。');
  });

  it('外传已被删除时报错，批量采用里进入 failed，提案保持待确认', async () => {
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    const proposal = sideStoryProposal(story);
    await repo.createProposals([proposal]);
    await repo.deleteSideStory(story.id);

    await expect(applyProposal(repo, proposal)).rejects.toThrow('这部外传已不存在，可能已被删除');

    const result = await acceptProposals(repo, [proposal]);
    expect(result.accepted).toEqual([]);
    expect(result.failed).toEqual([
      {
        proposalId: proposal.id,
        label: '外传进展摘要',
        message: '这部外传已不存在，可能已被删除',
      },
    ]);
    const pending = await repo.listProposals(novel.id, { status: 'pending' });
    expect(pending.map((p) => p.id)).toEqual([proposal.id]);
  });

  it('chapter:create 不接受 sideStoryId，提案建出的章节一律是主线', async () => {
    const story = await repo.createSideStory(novel.id, { title: '青冥旧事' });
    const proposal = buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'chapter',
      label: '新章节',
      specs: fieldSpecsFor('chapter'),
      payload: { title: '一', content: '正文', sideStoryId: story.id },
    });

    await applyProposal(repo, proposal);

    const [chapter] = await repo.listChapters(novel.id);
    expect(chapter?.sideStoryId).toBeNull();
  });
});

describe('批量采用', () => {
  async function seedProposals(): Promise<Proposal[]> {
    const batchId = newBatchId();
    const specs = await characterSpecs();
    const proposals = [
      buildCreateProposal({
        novelId: novel.id,
        batchId,
        origin: 'generate',
        target: 'knowledgeEntry',
        label: '人物 · 林越',
        specs,
        payload: { categoryId: characterCategoryId, title: '林越' },
      }),
      buildCreateProposal({
        novelId: novel.id,
        batchId,
        origin: 'generate',
        target: 'knowledgeEntry',
        label: '人物 · 沈清',
        specs,
        payload: { categoryId: characterCategoryId, title: '沈清' },
      }),
    ];
    await repo.createProposals(proposals);
    return proposals;
  }

  it('全部成功时逐条标记为已采用', async () => {
    const proposals = await seedProposals();

    const result = await acceptProposals(repo, proposals);

    expect(result.accepted).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(await repo.listEntries(novel.id)).toHaveLength(2);
    expect(await repo.listProposals(novel.id, { status: 'pending' })).toHaveLength(0);
    expect(await repo.listProposals(novel.id, { status: 'accepted' })).toHaveLength(2);
  });

  it('单条失败不影响其余，失败项保持待处理', async () => {
    const specs = await characterSpecs();
    const good = buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'knowledgeEntry',
      label: '人物 · 林越',
      specs,
      payload: { categoryId: characterCategoryId, title: '林越' },
    });
    const bad = buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'knowledgeEntry',
      label: '人物 · 无名',
      specs,
      // 缺少 categoryId，落库时会被 schema 拦下
      payload: { title: '无名' },
    });
    await repo.createProposals([good, bad]);

    const result = await acceptProposals(repo, [good, bad]);

    expect(result.accepted).toEqual([good.id]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.label).toBe('人物 · 无名');
    // 好的那条照常入库
    expect(await repo.listEntries(novel.id)).toHaveLength(1);
    // 失败的留在待处理，用户可以改完再试
    const pending = await repo.listProposals(novel.id, { status: 'pending' });
    expect(pending.map((p) => p.id)).toEqual([bad.id]);
  });

  it('忽略提案只改状态，不删除记录', async () => {
    const proposals = await seedProposals();

    await rejectProposals(
      repo,
      proposals.map((p) => p.id),
    );

    expect(await repo.listProposals(novel.id, { status: 'rejected' })).toHaveLength(2);
    expect(await repo.listEntries(novel.id)).toHaveLength(0);
  });
});

describe('提升为世界观（promoteFrom）', () => {
  /** 一个推演、开局之后一步里有本线条目「阿七」 */
  async function seedLine() {
    const scenario = await repo.createScenario(novel.id, {
      title: '雾中渡',
      setup: {
        cast: [{ entryId: '' }],
        start: { time: '', place: '渡口', situation: '在渡口醒来' },
        goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
        milestones: [],
        tone: '',
        expectedSteps: 30,
      },
      newOc: { categoryId: characterCategoryId, title: '沈砚', fields: {} },
    });
    const base = {
      plot: '雾很大。',
      challenge: '船在下沉',
      notices: [],
      progress: { reachedMilestoneIds: [], note: '' },
      ending: null,
    };
    const { node: root } = await repo.appendScenarioNode(scenario.id, {
      ...base,
      parentId: null,
      arrivedBy: { kind: 'start' },
      options: [{ id: 'o1', text: '拔刀', tendency: 'bold', risk: 'high', batch: 0 }],
      delta: emptyDelta(),
    });
    const { node } = await repo.appendScenarioNode(scenario.id, {
      ...base,
      parentId: root.id,
      arrivedBy: { kind: 'option', optionId: 'o1', text: '拔刀' },
      options: [],
      delta: {
        ...emptyDelta(),
        lineEntries: [
          {
            localId: 'y',
            categoryId: characterCategoryId,
            title: '阿七',
            summary: '',
            fields: {},
            promotedEntryId: null,
          },
        ],
      },
    });
    return { scenario, node };
  }

  const lineOf = async (scenarioId: string, nodeId: string) =>
    (await repo.listScenarioNodes(scenarioId)).find((item) => item.id === nodeId)!.delta
      .lineEntries[0]!;

  it('create 带 promoteFrom：建通用条目，并把本线条目标记为已提升', async () => {
    const { scenario, node } = await seedLine();
    const proposal = buildCreateProposal({
      novelId: novel.id,
      origin: 'refine',
      target: 'knowledgeEntry',
      label: '人物 · 阿七',
      specs: await characterSpecs(),
      payload: {
        categoryId: characterCategoryId,
        title: '阿七',
        fields: { identity: '孤儿' },
        promoteFrom: { nodeId: node.id, localId: 'y' },
      },
    });
    await applyProposal(repo, proposal);
    const created = (await repo.listEntries(novel.id)).find((entry) => entry.title === '阿七')!;
    expect(created).toMatchObject({ fields: { identity: '孤儿' }, scope: { kind: 'universal' } });
    expect((await lineOf(scenario.id, node.id)).promotedEntryId).toBe(created.id);
    // 同一条再采用一次：仓储拒绝，不会建出第二个
    await expect(applyProposal(repo, proposal)).rejects.toThrow('这个本线条目已经提升过了');
    expect(
      (await repo.listEntries(novel.id)).filter((entry) => entry.title === '阿七'),
    ).toHaveLength(1);
  });

  it('merge 带 promoteFrom：更新已有条目、不新建，promotedEntryId 指向它', async () => {
    const { scenario, node } = await seedLine();
    const existing = await repo.createEntry(novel.id, {
      categoryId: characterCategoryId,
      title: '七郎',
    });
    const count = (await repo.listEntries(novel.id, { scope: 'all' })).length;
    const proposal = buildMergeProposal({
      novelId: novel.id,
      origin: 'refine',
      target: 'knowledgeEntry',
      label: '人物 · 七郎',
      specs: await characterSpecs(),
      targetId: existing.id,
      current: existing,
      incoming: { aliases: ['阿七'] },
    });
    await applyProposal(repo, {
      ...proposal,
      payload: { ...(proposal.payload as object), promoteFrom: { nodeId: node.id, localId: 'y' } },
    });
    expect((await repo.listEntries(novel.id, { scope: 'all' })).length).toBe(count);
    const merged = (await repo.getEntry(existing.id))!;
    expect(merged.aliases).toEqual(['阿七']);
    expect(merged.version).toBe(existing.version + 1);
    expect((await lineOf(scenario.id, node.id)).promotedEntryId).toBe(existing.id);
  });

  it('promoteFrom 格式不对时拒绝落库，什么都不写', async () => {
    const proposal = buildCreateProposal({
      novelId: novel.id,
      origin: 'refine',
      target: 'knowledgeEntry',
      label: '人物 · 阿七',
      specs: await characterSpecs(),
      payload: { categoryId: characterCategoryId, title: '阿七', promoteFrom: { nodeId: '' } },
    });
    await expect(applyProposal(repo, proposal)).rejects.toThrow();
    expect(await repo.listEntries(novel.id)).toHaveLength(0);
  });
});

describe('推演沉淀（scenarioOutline:create）', () => {
  /** 一个推演：根下两个选项 a / b，a 线走 steps 步（含根），b 线另走两步；主线跟最后推进的那条 */
  async function seedTree(steps = 6) {
    const scenario = await repo.createScenario(novel.id, {
      title: '雾中渡',
      setup: {
        cast: [{ entryId: '' }],
        start: { time: '', place: '渡口', situation: '在渡口醒来' },
        goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
        milestones: [],
        tone: '',
        expectedSteps: 30,
      },
      newOc: { categoryId: characterCategoryId, title: '沈砚', fields: {} },
    });
    const base = {
      challenge: '挑战',
      notices: [],
      progress: { reachedMilestoneIds: [], note: '' },
      ending: null,
      delta: emptyDelta(),
    };
    const option = (id: string) => ({
      id,
      text: `选${id}`,
      tendency: 'bold' as const,
      risk: 'low' as const,
      batch: 0,
    });
    const { node: root } = await repo.appendScenarioNode(scenario.id, {
      ...base,
      parentId: null,
      arrivedBy: { kind: 'start' },
      plot: '第 1 步的情节',
      options: [option('a'), option('b')],
    });
    const lineA = [root];
    for (let i = 1; i < steps; i += 1) {
      const parent = lineA[lineA.length - 1]!;
      const optionId = i === 1 ? 'a' : 'n';
      const { node } = await repo.appendScenarioNode(scenario.id, {
        ...base,
        parentId: parent.id,
        arrivedBy: { kind: 'option', optionId, text: `选${optionId}` },
        plot: `a 线第 ${i + 1} 步的情节`,
        options: [option('n')],
      });
      lineA.push(node);
    }
    return { scenario, root, lineA, base, option };
  }

  function proposalOf(payload: Record<string, unknown>) {
    return buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'scenarioOutline',
      label: '沉淀 · 推演《雾中渡》',
      specs: fieldSpecsFor('scenarioOutline'),
      payload,
    });
  }

  it('主线：采用前大纲不变，采用后卷 / 章追加在顶层末尾，章带溯源（验收 25）', async () => {
    const { scenario, lineA } = await seedTree(6);
    await repo.createOutlineNode(novel.id, { title: '作者手写的卷' });
    const pei = await repo.createEntry(novel.id, {
      categoryId: characterCategoryId,
      title: '裴照',
    });
    const proposal = proposalOf({
      scenarioId: scenario.id,
      mode: 'main',
      range: { from: 1, to: 6 },
      nodeIds: lineA.map((node) => node.id),
      forkNodeId: null,
      appendToSideStoryId: null,
      sideTitle: '',
      sideSynopsis: '',
      outlineText: [
        '# 第二卷 渡口',
        '渡口的事。',
        '## 第1章 雾里的船（约 3000 字）',
        '沈砚找到空船。',
        '出场：沈砚、裴照',
        '对应步骤：1–3',
        '## 第2章 林中',
        '追进林子。',
        '对应步骤：4–6',
      ].join('\n'),
    });
    await repo.createProposals([proposal]);
    const before = await repo.listOutline(novel.id);
    expect(before).toHaveLength(1);

    await applyProposal(repo, proposal);
    const outline = await repo.listOutline(novel.id);
    const volume = outline.find((node) => node.title === '第二卷 渡口')!;
    expect(volume).toMatchObject({ parentId: null, order: 1, scenarioSource: null });
    const chapters = outline
      .filter((node) => node.parentId === volume.id)
      .sort((a, b) => a.order - b.order);
    expect(chapters.map((node) => node.title)).toEqual(['第1章 雾里的船', '第2章 林中']);
    expect(chapters[0]).toMatchObject({
      targetWords: 3000,
      linkedEntryIds: [pei.id],
      scenarioSource: {
        scenarioId: scenario.id,
        nodeIds: lineA.slice(0, 3).map((node) => node.id),
      },
    });
    expect(chapters[0]!.synopsis).toBe('沈砚找到空船。\n出场：沈砚、裴照');
    expect(chapters[1]!.scenarioSource!.nodeIds).toEqual(lineA.slice(3).map((node) => node.id));
  });

  it('外传：采用前外传列表不变，采用后新建外传记住分叉点、章节带细纲（T8）', async () => {
    const { scenario, root, base, option } = await seedTree(3);
    // b 线：在根的另一个选项上推进两步，沉淀成外传（applyProposal 不看主线，只按 payload 落库）
    const { node: b1 } = await repo.appendScenarioNode(scenario.id, {
      ...base,
      parentId: root.id,
      arrivedBy: { kind: 'option', optionId: 'b', text: '选b' },
      plot: 'b 线第 2 步',
      options: [option('n')],
    });
    const { node: b2 } = await repo.appendScenarioNode(scenario.id, {
      ...base,
      parentId: b1.id,
      arrivedBy: { kind: 'option', optionId: 'n', text: '选n' },
      plot: 'b 线第 3 步',
      options: [],
    });
    const proposal = proposalOf({
      scenarioId: scenario.id,
      mode: 'side',
      range: { from: 2, to: 3 },
      nodeIds: [b1.id, b2.id],
      forkNodeId: root.id,
      appendToSideStoryId: null,
      sideTitle: '雾中另一程',
      sideSynopsis: '从渡口分出去的一条线。',
      outlineText: '## 第1章 另一条路\n走了另一条路。\n关键事件：渡江\n对应步骤：2–3',
    });
    expect(await repo.listSideStories(novel.id)).toHaveLength(0);

    await applyProposal(repo, proposal);
    const [story] = await repo.listSideStories(novel.id);
    expect(story).toMatchObject({
      title: '雾中另一程',
      synopsis: '从渡口分出去的一条线。',
      scenarioSource: { scenarioId: scenario.id, forkNodeId: root.id },
    });
    const sideChapters = (await repo.listChapters(novel.id)).filter(
      (chapter) => chapter.sideStoryId === story!.id,
    );
    expect(sideChapters).toHaveLength(1);
    expect(sideChapters[0]).toMatchObject({
      index: 1,
      title: '第1章 另一条路',
      content: '',
      scenarioSource: {
        scenarioId: scenario.id,
        nodeIds: [b1.id, b2.id],
        brief: '走了另一条路。\n关键事件：渡江',
      },
    });
    // 主线大纲不受外传沉淀影响
    expect(await repo.listOutline(novel.id)).toHaveLength(0);
  });

  it('追加到外传：章节接在末尾，外传的名称、简介与分叉点不变', async () => {
    const { scenario, root, base, option } = await seedTree(2);
    const b = [] as Awaited<ReturnType<typeof repo.appendScenarioNode>>['node'][];
    let parent = root;
    for (let i = 0; i < 4; i += 1) {
      const { node } = await repo.appendScenarioNode(scenario.id, {
        ...base,
        parentId: parent.id,
        arrivedBy:
          i === 0
            ? { kind: 'option', optionId: 'b', text: '选b' }
            : { kind: 'option', optionId: 'n', text: '选n' },
        plot: `b 线第 ${i + 2} 步`,
        options: [option('n')],
      });
      b.push(node);
      parent = node;
    }
    await applyProposal(
      repo,
      proposalOf({
        scenarioId: scenario.id,
        mode: 'side',
        range: { from: 2, to: 3 },
        nodeIds: [b[0]!.id, b[1]!.id],
        forkNodeId: root.id,
        appendToSideStoryId: null,
        sideTitle: '雾中另一程',
        sideSynopsis: '原简介',
        outlineText: '## 第1章\n前半。\n对应步骤：2–3',
      }),
    );
    const [story] = await repo.listSideStories(novel.id);
    await applyProposal(
      repo,
      proposalOf({
        scenarioId: scenario.id,
        mode: 'side',
        range: { from: 4, to: 5 },
        nodeIds: [b[2]!.id, b[3]!.id],
        // 主线换了以后重新算出的分叉点可能不同；追加不看它
        forkNodeId: b[0]!.id,
        appendToSideStoryId: story!.id,
        sideTitle: '',
        sideSynopsis: '',
        outlineText: '## 第2章\n后半。\n对应步骤：4–5',
      }),
    );
    const after = (await repo.listSideStories(novel.id))[0]!;
    expect(after).toMatchObject({
      title: '雾中另一程',
      synopsis: '原简介',
      scenarioSource: { forkNodeId: root.id },
    });
    const sideChapters = (await repo.listChapters(novel.id))
      .filter((chapter) => chapter.sideStoryId === story!.id)
      .sort((x, y) => x.index - y.index);
    expect(sideChapters.map((chapter) => chapter.index)).toEqual([1, 2]);
    expect(sideChapters[1]!.scenarioSource!.nodeIds).toEqual([b[2]!.id, b[3]!.id]);
  });

  it('「对应步骤」不合法时采用失败、什么都不写，提案仍待确认', async () => {
    const { scenario, lineA } = await seedTree(4);
    const proposal = proposalOf({
      scenarioId: scenario.id,
      mode: 'main',
      range: { from: 1, to: 4 },
      nodeIds: lineA.map((node) => node.id),
      forkNodeId: null,
      appendToSideStoryId: null,
      sideTitle: '',
      sideSynopsis: '',
      outlineText: '# 卷\n## 第1章\n对应步骤：1–2\n## 第2章\n对应步骤：3–5',
    });
    await repo.createProposals([proposal]);
    const result = await acceptProposals(repo, [proposal]);
    expect(result.failed[0]!.message).toBe('第 2 章的『对应步骤』超出这次沉淀的范围（第 1–4 步）');
    expect(await repo.listOutline(novel.id)).toHaveLength(0);
    expect(
      (await repo.listProposals(novel.id, { status: 'pending' })).map((item) => item.id),
    ).toEqual([proposal.id]);
  });

  it('merge / replace 一律拒绝', async () => {
    const proposal = proposalOf({});
    await expect(
      applyProposal(repo, { ...proposal, action: 'merge', targetId: 'x' }),
    ).rejects.toThrow('沉淀提案只支持新建');
    await expect(
      applyProposal(repo, { ...proposal, action: 'replace', targetId: 'x' }),
    ).rejects.toThrow('沉淀提案只支持新建');
  });
});
