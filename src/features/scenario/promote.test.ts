import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '@/data/dexie/db';
import { DexieNovelRepository } from '@/data/dexie/DexieNovelRepository';
import type { ScenarioNodeInput } from '@/data/NovelRepository';
import { newId } from '@/domain/primitives';
import { pathTo } from '@/domain/scenario';
import {
  emptyDelta,
  type Category,
  type Novel,
  type Scenario,
  type ScenarioNode,
  type WorldlineDelta,
} from '@/domain/schema';
import { effectiveKnowledge } from '@/domain/worldline';
import { applyProposal } from '@/proposal/apply';
import { PROMOTE_MESSAGES, buildPromotion } from './promote';

/**
 * 提升为世界观（设计 §7.1、验收 10 / 24）：只生成提案，确认前世界观层不变；
 * 采用走 applyProposal（与知识库待确认区同一条路）。
 */

let database: AppDatabase;
let repo: DexieNovelRepository;
let novel: Novel;
let char: Category;

beforeEach(async () => {
  database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  repo = new DexieNovelRepository(database);
  novel = await repo.createNovel({ title: '归墟纪' });
  char = (await repo.listCategories(novel.id))[1]!;
});

afterEach(async () => {
  database.close();
  await database.delete();
});

async function seedScenario(): Promise<Scenario> {
  return repo.createScenario(novel.id, {
    title: '雾中渡',
    setup: {
      cast: [{ entryId: '' }],
      start: { time: '', place: '渡口', situation: '在渡口醒来' },
      goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
      milestones: [],
      tone: '',
      expectedSteps: 30,
    },
    newOc: { categoryId: char.id, title: '沈砚', fields: { identity: '船夫', voice: '话少' } },
  });
}

function nodeInput(
  parent: ScenarioNode | null,
  delta: Partial<WorldlineDelta> = {},
): ScenarioNodeInput {
  return {
    parentId: parent?.id ?? null,
    arrivedBy: parent
      ? { kind: 'option', optionId: parent.options[0]!.id, text: parent.options[0]!.text }
      : { kind: 'start' },
    plot: '雾很大。',
    challenge: '船在下沉',
    options: [{ id: newId(), text: '拔刀', tendency: 'bold', risk: 'high', batch: 0 }],
    delta: { ...emptyDelta(), ...delta },
    notices: [],
    progress: { reachedMilestoneIds: [], note: '' },
    ending: null,
  };
}

async function append(
  scenario: Scenario,
  parent: ScenarioNode | null,
  delta: Partial<WorldlineDelta> = {},
) {
  return (await repo.appendScenarioNode(scenario.id, nodeInput(parent, delta))).node;
}

async function knowledgeAt(scenario: Scenario, node: ScenarioNode) {
  const nodes = await repo.listScenarioNodes(scenario.id);
  const entries = await repo.listEntries(novel.id, { scope: 'all', includeDeleted: true });
  const categories = await repo.listCategories(novel.id);
  return {
    knowledge: effectiveKnowledge({ scenario, path: pathTo(nodes, node.id), entries, categories }),
    entries,
    categories,
  };
}

async function context() {
  return {
    novelId: novel.id,
    entries: await repo.listEntries(novel.id, { scope: 'all', includeDeleted: true }),
    categories: await repo.listCategories(novel.id),
    sourceRef: '推演《雾中渡》第 2 步',
  };
}

describe('字段覆盖 → replace 提案', () => {
  it('diff 只有那一栏；确认前条目不变，确认后为覆盖值（验收 24）', async () => {
    const peizhao = await repo.createEntry(novel.id, {
      categoryId: char.id,
      title: '裴照',
      summary: '捕快',
      fields: { identity: '捕快', voice: '话少' },
    });
    const result = buildPromotion({
      ...(await context()),
      subject: { kind: 'field', entry: peizhao, fieldKey: 'identity', value: '叛徒' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { proposal } = result;
    expect(proposal).toMatchObject({
      target: 'knowledgeEntry',
      action: 'replace',
      targetId: peizhao.id,
      origin: 'refine',
    });
    const changed = proposal.diff.filter((diff) => diff.kind !== 'unchanged');
    expect(changed).toEqual([
      { field: 'fields.identity', label: '身份', before: '捕快', after: '叛徒', kind: 'changed' },
    ]);

    // 生成提案本身不写库：落进待确认区之后，条目仍是原文
    await repo.createProposals([proposal]);
    expect((await repo.getEntry(peizhao.id))!.fields.identity).toBe('捕快');

    await applyProposal(repo, proposal);
    const after = (await repo.getEntry(peizhao.id))!;
    expect(after.fields).toEqual({ identity: '叛徒', voice: '话少' });
    expect(after.summary).toBe('捕快');
    expect(after.version).toBe(peizhao.version + 1);
  });

  it('list 字段：采用后等于覆盖值，不是新旧并集', async () => {
    await repo.updateCategory(char.id, {
      fieldTemplate: char.fieldTemplate.map((field) =>
        field.key === 'relations' ? { ...field, type: 'list' as const } : field,
      ),
    });
    const peizhao = await repo.createEntry(novel.id, {
      categoryId: char.id,
      title: '裴照',
      fields: { relations: '师父：老周\n同僚：沈清' },
    });
    const result = buildPromotion({
      ...(await context()),
      subject: { kind: 'field', entry: peizhao, fieldKey: 'relations', value: '仇人：老周' },
    });
    if (!result.ok) throw new Error(result.reason);
    await applyProposal(repo, result.proposal);
    expect((await repo.getEntry(peizhao.id))!.fields.relations).toBe('仇人：老周');
  });

  it('字段后来被锁定：不生成提案，返回原因（验收 10）', async () => {
    const scenario = await seedScenario();
    const ocId = scenario.setup.cast[0]!.entryId;
    const root = await append(scenario, null);
    const a = await append(scenario, root, {
      fieldOverrides: [
        { target: { kind: 'world', entryId: ocId }, fieldKey: 'identity', value: '叛徒' },
      ],
    });
    // 覆盖存下之后，作者在条目里把「身份」改成锁定
    const oc = await repo.updateEntry(ocId, { fieldLocks: { identity: 'locked' } });
    const { knowledge } = await knowledgeAt(scenario, a);
    // 有效知识里覆盖已失效
    expect(knowledge.entries.find((entry) => entry.title === '沈砚')!.fields.identity!.value).toBe(
      '船夫',
    );

    const result = buildPromotion({
      ...(await context()),
      subject: { kind: 'field', entry: oc, fieldKey: 'identity', value: '叛徒' },
    });
    expect(result).toEqual({ ok: false, reason: PROMOTE_MESSAGES.locked });
    expect(await repo.listProposals(novel.id, { status: 'pending' })).toHaveLength(0);
  });

  it('与世界观原文相同时不生成提案', async () => {
    const peizhao = await repo.createEntry(novel.id, {
      categoryId: char.id,
      title: '裴照',
      fields: { identity: '捕快' },
    });
    const result = buildPromotion({
      ...(await context()),
      subject: { kind: 'field', entry: peizhao, fieldKey: 'identity', value: '捕快' },
    });
    expect(result).toEqual({ ok: false, reason: PROMOTE_MESSAGES.unchanged });
  });
});

describe('本线新条目', () => {
  async function seedLine(title: string) {
    const scenario = await seedScenario();
    const root = await append(scenario, null);
    const a = await append(scenario, root, {
      lineEntries: [
        {
          localId: 'y',
          categoryId: char.id,
          title,
          summary: '渡口的孤儿',
          fields: { identity: '孤儿' },
          promotedEntryId: null,
        },
      ],
    });
    // 后代节点改了它的「身份」：提升取当前节点处的有效值
    const b = await append(scenario, a, {
      fieldOverrides: [
        {
          target: { kind: 'line', nodeId: a.id, localId: 'y' },
          fieldKey: 'identity',
          value: '船帮学徒',
        },
      ],
    });
    const { knowledge } = await knowledgeAt(scenario, b);
    const line = knowledge.entries.find((entry) => entry.origin === 'line')!;
    return { scenario, a, b, line };
  }

  it('无同名通用条目 → create 提案（作用范围通用），采用后本线条目标记已提升', async () => {
    const { scenario, a, line } = await seedLine('阿七');
    const before = (await repo.listEntries(novel.id, { scope: 'all' })).length;
    const result = buildPromotion({ ...(await context()), subject: { kind: 'line', entry: line } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.notice).toBeNull();
    expect(result.proposal).toMatchObject({
      action: 'create',
      origin: 'refine',
      payload: {
        categoryId: char.id,
        title: '阿七',
        summary: '渡口的孤儿',
        fields: { identity: '船帮学徒' },
        promoteFrom: { nodeId: a.id, localId: 'y' },
      },
    });

    await repo.createProposals([result.proposal]);
    expect((await repo.listEntries(novel.id, { scope: 'all' })).length).toBe(before);

    await applyProposal(repo, result.proposal);
    const created = (await repo.listEntries(novel.id)).find((entry) => entry.title === '阿七')!;
    expect(created.scope).toEqual({ kind: 'universal' });
    expect(created.fields.identity).toBe('船帮学徒');
    const stored = (await repo.listScenarioNodes(scenario.id)).find((node) => node.id === a.id)!;
    expect(stored.delta.lineEntries[0]!.promotedEntryId).toBe(created.id);
  });

  it('已有同名（别名匹配）通用条目 → merge 提案带 promoteFrom；采用后不新建、promotedEntryId 指向已有条目', async () => {
    const { scenario, a, line } = await seedLine('阿七');
    // 本线条目记下之后，作者才在知识库里建了同一个人（建本线条目时已有同名的会被拒绝新建）
    const existing = await repo.createEntry(novel.id, {
      categoryId: char.id,
      title: '七郎',
      aliases: ['阿七'],
      fields: { voice: '爱笑' },
    });
    const before = (await repo.listEntries(novel.id, { scope: 'all' })).length;
    const result = buildPromotion({ ...(await context()), subject: { kind: 'line', entry: line } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.notice).toBe('知识库里已有「七郎」，将合并进这个条目而不是新建');
    expect(result.proposal).toMatchObject({
      action: 'merge',
      targetId: existing.id,
      origin: 'refine',
      payload: { promoteFrom: { nodeId: a.id, localId: 'y' } },
    });

    await applyProposal(repo, result.proposal);
    expect((await repo.listEntries(novel.id, { scope: 'all' })).length).toBe(before);
    const merged = (await repo.getEntry(existing.id))!;
    expect(merged.title).toBe('七郎');
    expect(merged.fields).toEqual({ voice: '爱笑', identity: '船帮学徒' });
    const stored = (await repo.listScenarioNodes(scenario.id)).find((node) => node.id === a.id)!;
    expect(stored.delta.lineEntries[0]!.promotedEntryId).toBe(existing.id);
  });

  it('限定条目同名不算：仍然新建', async () => {
    const { scenario, line } = await seedLine('阿七');
    await repo.createEntry(novel.id, {
      categoryId: char.id,
      title: '阿七',
      scope: {
        kind: 'limited',
        targets: [{ scenarioId: scenario.id, fromNodeId: null, revealHint: '' }],
      },
    });
    const result = buildPromotion({ ...(await context()), subject: { kind: 'line', entry: line } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal.action).toBe('create');
  });
});

describe('不可提升的差异', () => {
  it('状态 / 主角状态 / 事件 / 标记：不生成提案，说明原因', async () => {
    const ctx = await context();
    for (const kind of ['status', 'oc', 'event', 'flag'] as const) {
      expect(buildPromotion({ ...ctx, subject: { kind } })).toEqual({
        ok: false,
        reason: PROMOTE_MESSAGES.sandboxOnly,
      });
    }
    expect(PROMOTE_MESSAGES.sandboxOnly).toContain('要写进全书，请沉淀成章节');
  });
});
