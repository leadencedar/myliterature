import { describe, expect, it } from 'vitest';
import {
  emptyDelta,
  type Category,
  type KnowledgeEntry,
  type Scenario,
  type ScenarioNode,
  type WorldlineDelta,
} from './schema';
import { CHARACTER_FIELDS, WORLDBUILDING_FIELDS, builtinMutability } from './defaults';
import {
  effectiveKnowledge,
  fieldMutability,
  mentionedEffectiveEntries,
  renderScenarioEntry,
  renderWorldlineState,
  resolveStepChanges,
  resolveStepEnding,
  resolveStepProgress,
  sanitizeDelta,
  visibleEntries,
  type EffectiveKnowledge,
  type RawStepChanges,
} from './worldline';

// ---------------------------------------------------------------- 夹具

const worldCat: Category = {
  id: 'c-world',
  novelId: 'n1',
  name: '世界观设定',
  kind: 'worldbuilding',
  builtin: true,
  fieldTemplate: WORLDBUILDING_FIELDS,
  order: 0,
  createdAt: 0,
  updatedAt: 0,
};

const charCat: Category = {
  id: 'c-char',
  novelId: 'n1',
  name: '人物',
  kind: 'character',
  builtin: true,
  fieldTemplate: CHARACTER_FIELDS,
  order: 1,
  createdAt: 0,
  updatedAt: 0,
};

const categories = [worldCat, charCat];

function entry(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id,
    novelId: 'n1',
    categoryId: charCat.id,
    title: id,
    aliases: [],
    summary: '',
    fields: {},
    pinned: false,
    sourceChapterIds: [],
    version: 1,
    scope: { kind: 'universal' },
    fieldLocks: {},
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  };
}

const X = entry('x', {
  title: '裴照',
  aliases: ['裴捕头'],
  fields: { identity: '捕快', voice: '话少' },
});
const RULE = entry('rule', {
  categoryId: worldCat.id,
  title: '灵气',
  fields: { rules: '吐纳入体', cost: '损寿元', impact: '宗门争夺灵脉' },
});
const OC = entry('oc', {
  title: '沈砚',
  fields: { identity: '渡口船夫' },
  scope: { kind: 'limited', targets: [{ scenarioId: 'S', fromNodeId: null, revealHint: '' }] },
});

const scenario: Scenario = {
  id: 'S',
  novelId: 'n1',
  title: '雾中渡',
  setup: {
    cast: [{ id: 'cast1', entryId: 'oc' }],
    start: { time: '', place: '渡口', situation: '醒来' },
    goals: [
      { id: 'g1', kind: 'good', description: '找到船夫' },
      { id: 'g2', kind: 'bad', description: '沉江' },
    ],
    milestones: [
      { id: 'm1', description: '找到空船' },
      { id: 'm2', description: '进入青冥宗' },
    ],
    tone: '',
    expectedSteps: 30,
  },
  mainNodeId: null,
  cursorNodeId: null,
  lastAdvancedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

function delta(partial: Partial<WorldlineDelta> = {}): WorldlineDelta {
  return { ...emptyDelta(), ...partial };
}

function node(
  id: string,
  parentId: string | null,
  depth: number,
  overrides: Partial<ScenarioNode> = {},
): ScenarioNode {
  return {
    id,
    novelId: 'n1',
    scenarioId: 'S',
    parentId,
    depth,
    arrivedBy:
      parentId === null ? { kind: 'start' } : { kind: 'option', optionId: `o-${id}`, text: id },
    plot: `${id} 的情节`,
    challenge: '',
    options: [],
    delta: emptyDelta(),
    notices: [],
    progress: { reachedMilestoneIds: [], note: '' },
    ending: null,
    pathSummary: null,
    deltaEditedAt: null,
    createdAt: depth,
    updatedAt: depth,
    ...overrides,
  };
}

const world = (entryId: string) => ({ kind: 'world' as const, entryId });

function know(path: ScenarioNode[], entries: KnowledgeEntry[] = [X, RULE, OC]): EffectiveKnowledge {
  return effectiveKnowledge({ scenario, path, entries, categories });
}

function field(knowledge: EffectiveKnowledge, title: string, key: string) {
  return knowledge.entries.find((item) => item.title === title)?.fields[key];
}

function raw(partial: Partial<RawStepChanges> = {}): RawStepChanges {
  return {
    fieldChanges: [],
    newEntries: [],
    statusChanges: [],
    ocChanges: [],
    events: [],
    flags: [],
    ...partial,
  };
}

let seq = 0;
const ctxOf = (knowledge: EffectiveKnowledge) => ({
  knowledge,
  categories,
  scenario,
  createId: () => `local-${++seq}`,
});

// 树：1 →(a) 2a →(a) 3a；1 →(b) 2b → 3b
const n1 = node('n1', null, 0);
const n2a = node('n2a', 'n1', 1, {
  delta: delta({
    fieldOverrides: [{ target: world('x'), fieldKey: 'identity', value: '叛徒' }],
    lineEntries: [
      {
        localId: 'y',
        categoryId: charCat.id,
        title: '阿七',
        summary: '渡口的孩子',
        fields: { identity: '孤儿', voice: '结巴' },
        promotedEntryId: null,
      },
    ],
  }),
});
const n3a = node('n3a', 'n2a', 2);
const n2b = node('n2b', 'n1', 1);
const n3b = node('n3b', 'n2b', 2);

// ---------------------------------------------------------------- T1 继承与兄弟隔离

describe('有效知识：沿树继承、兄弟隔离（T1）', () => {
  it('2a 的改写在 3a 可见、来源 2a；2b 子树看到世界观原值', () => {
    expect(field(know([n1, n2a, n3a]), '裴照', 'identity')).toEqual({
      value: '叛徒',
      source: 'n2a',
    });
    expect(field(know([n1, n2b, n3b]), '裴照', 'identity')).toEqual({
      value: '捕快',
      source: 'world',
    });
  });

  it('2a 新增的本线人物只在 2a 子树可见', () => {
    const a = know([n1, n2a, n3a]);
    const line = a.entries.find((item) => item.title === '阿七');
    expect(line?.origin).toBe('line');
    expect(line?.ref).toEqual({ kind: 'line', nodeId: 'n2a', localId: 'y' });
    expect(know([n1, n2b, n3b]).entries.some((item) => item.title === '阿七')).toBe(false);
  });

  it('限定条目：推演 S 可见、推演 T 不可见；fromNodeId 只在该节点子树可见；有登场条件的是预设', () => {
    const limited = entry('lim', {
      title: '青衣客',
      scope: { kind: 'limited', targets: [{ scenarioId: 'S', fromNodeId: null, revealHint: '' }] },
    });
    const branch = entry('branch', {
      title: '老艄公',
      scope: { kind: 'limited', targets: [{ scenarioId: 'S', fromNodeId: 'n2a', revealHint: '' }] },
    });
    const hidden = entry('hidden', {
      title: '黑衣人',
      scope: {
        kind: 'limited',
        targets: [{ scenarioId: 'S', fromNodeId: null, revealHint: '主角进入青冥宗后' }],
      },
    });
    const all = [X, limited, branch, hidden];
    const inS = visibleEntries(all, 'S', new Set(['n1', 'n2a', 'n3a'])).map(
      (item) => item.entry.id,
    );
    expect(inS).toEqual(['x', 'lim', 'branch', 'hidden']);
    expect(visibleEntries(all, 'T', new Set(['n1'])).map((item) => item.entry.id)).toEqual(['x']);

    const a = know([n1, n2a, n3a], all);
    expect(a.entries.map((item) => item.title)).toContain('老艄公');
    const b = know([n1, n2b, n3b], all);
    expect(b.entries.map((item) => item.title)).not.toContain('老艄公');
    expect(a.pendingReveals.map((item) => item.title)).toEqual(['黑衣人']);
    expect(a.entries.map((item) => item.title)).not.toContain('黑衣人');
    expect(a.entries.find((item) => item.title === '青衣客')?.origin).toBe('limited');
  });

  it('编辑 2a 的差异后：3a 跟着变，2b 不变', () => {
    const edited = {
      ...n2a,
      delta: delta({
        fieldOverrides: [{ target: world('x'), fieldKey: 'identity', value: '卧底' }],
      }),
    };
    expect(field(know([n1, edited, n3a]), '裴照', 'identity')?.value).toBe('卧底');
    expect(field(know([n1, n2b, n3b]), '裴照', 'identity')?.value).toBe('捕快');
  });
});

// ---------------------------------------------------------------- T2 锁定

describe('可变性与锁定（T2）', () => {
  it('「运作规则」的覆盖被丢弃并有 locked-field 提示，有效值不变', () => {
    const k = know([n1]);
    const { delta: out, notices } = resolveStepChanges(
      raw({ fieldChanges: [{ entry: '灵气', field: 'rules', value: '吐纳无需代价' }] }),
      ctxOf(k),
    );
    expect(out.fieldOverrides).toEqual([]);
    expect(notices).toEqual([
      { kind: 'locked-field', message: '「灵气」的「运作规则」是底层设定，本线不能改写，已丢弃' },
    ]);
    const next = know([n1, node('n2', 'n1', 1, { delta: out })]);
    expect(field(next, '灵气', 'rules')).toEqual({ value: '吐纳入体', source: 'world' });
  });

  it('fieldMutability 四级：条目覆盖 > 模板 > 内置默认 > 可变', () => {
    // 旧分类没有 mutability：靠内置默认，人物「说话方式」锁定、「身份」可变
    const legacy: Category = {
      ...charCat,
      fieldTemplate: CHARACTER_FIELDS.map(({ mutability: _drop, ...rest }) => rest),
    };
    expect(fieldMutability(legacy, X, 'voice')).toBe('locked');
    expect(fieldMutability(legacy, X, 'identity')).toBe('mutable');
    // 模板优先于内置默认
    const unlocked: Category = {
      ...legacy,
      fieldTemplate: legacy.fieldTemplate.map((f) =>
        f.key === 'voice' ? { ...f, mutability: 'mutable' as const } : f,
      ),
    };
    expect(fieldMutability(unlocked, X, 'voice')).toBe('mutable');
    // 条目覆盖优先于模板
    expect(fieldMutability(unlocked, { fieldLocks: { voice: 'locked' } }, 'voice')).toBe('locked');
    expect(fieldMutability(charCat, { fieldLocks: { identity: 'locked' } }, 'identity')).toBe(
      'locked',
    );
    // 都没有：可变
    const custom: Category = { ...charCat, kind: 'custom', name: '法宝', fieldTemplate: [] };
    expect(fieldMutability(custom, undefined, 'anything')).toBe('mutable');
    expect(fieldMutability(undefined, undefined, 'voice')).toBe('mutable');
  });

  it('builtinMutability：自建「法宝」可变，旧「道具」锁定，「道具」改名为「器物」后可变', () => {
    expect(builtinMutability({ kind: 'custom', name: '法宝' }, 'rules')).toBeUndefined();
    expect(builtinMutability({ kind: 'custom', name: '道具' }, 'rules')).toBe('locked');
    expect(builtinMutability({ kind: 'custom', name: '器物' }, 'rules')).toBeUndefined();
    const legacyItem: Category = {
      ...charCat,
      kind: 'custom',
      name: '道具',
      fieldTemplate: [
        { key: 'rules', label: '能力与规则', type: 'longtext', placeholder: '', hint: '' },
      ],
    };
    expect(fieldMutability(legacyItem, undefined, 'rules')).toBe('locked');
    expect(fieldMutability({ ...legacyItem, name: '器物' }, undefined, 'rules')).toBe('mutable');
    expect(fieldMutability({ ...legacyItem, name: '法宝' }, undefined, 'rules')).toBe('mutable');
  });

  it('本线条目：新建时可带「说话方式」；之后覆盖它被丢弃，覆盖「身份」生效', () => {
    const k = know([n1, n2a]);
    expect(field(k, '阿七', 'voice')).toEqual({ value: '结巴', source: 'n2a' });
    const { delta: out, notices } = resolveStepChanges(
      raw({
        fieldChanges: [
          { entry: '阿七', field: '说话方式', value: '口齿伶俐' },
          { entry: '阿七', field: '身份', value: '青冥宗弟子' },
        ],
      }),
      ctxOf(k),
    );
    expect(notices.map((item) => item.kind)).toEqual(['locked-field']);
    const after = know([n1, n2a, node('n3', 'n2a', 2, { delta: out })]);
    expect(field(after, '阿七', 'voice')?.value).toBe('结巴');
    expect(field(after, '阿七', 'identity')).toEqual({ value: '青冥宗弟子', source: 'n3' });
  });
});

// ---------------------------------------------------------------- 解析与过滤

describe('resolveStepChanges', () => {
  const k = know([n1, n2a]);

  it('未知条目 / 未知字段 / 未知分类 / 重名新条目 / 世界规则死亡各丢一条并提示', () => {
    const { delta: out, notices } = resolveStepChanges(
      raw({
        fieldChanges: [
          { entry: '无名氏', field: '身份', value: '刺客' },
          { entry: '裴照', field: '武功', value: '刀法' },
        ],
        newEntries: [
          { category: '法宝', title: '青铜钥匙', summary: '', fields: [] },
          { category: '人物', title: '裴捕头', summary: '', fields: [] },
        ],
        statusChanges: [{ entry: '灵气', status: 'destroyed', note: '' }],
      }),
      ctxOf(k),
    );
    expect(notices).toEqual([
      { kind: 'unknown-category', message: '分类「法宝」不存在，没有新建「青铜钥匙」' },
      { kind: 'duplicate-entry', message: '已有同名条目「裴捕头」，没有重复新建' },
      { kind: 'unknown-entry', message: '找不到条目「无名氏」，这条变化没有记下' },
      { kind: 'unknown-field', message: '「裴照」没有「武功」这一栏，没有记下' },
      { kind: 'rule-status', message: '「灵气」是世界规则，不会死亡或被毁' },
    ]);
    expect(out).toEqual(emptyDelta());
  });

  it('字段用中文名也能解析；别名能匹配条目；值与现值相同静默丢弃', () => {
    const { delta: out, notices } = resolveStepChanges(
      raw({
        fieldChanges: [
          { entry: '裴捕头', field: '关系网', value: '与沈砚结盟' },
          { entry: '裴照', field: 'identity', value: '叛徒' },
        ],
      }),
      ctxOf(k),
    );
    expect(notices).toEqual([]);
    expect(out.fieldOverrides).toEqual([
      { target: world('x'), fieldKey: 'relations', value: '与沈砚结盟' },
    ]);
  });

  it('新条目：模板外字段静默丢弃，localId 由代码生成；同一步对它的改写合进它的字段', () => {
    const { delta: out, notices } = resolveStepChanges(
      raw({
        newEntries: [
          {
            category: '人物',
            title: '老周',
            summary: '船行掌柜',
            fields: [
              { field: '身份', value: '掌柜' },
              { field: '武功', value: '无' },
            ],
          },
        ],
        fieldChanges: [{ entry: '老周', field: '目标与动机', value: '还债' }],
      }),
      { ...ctxOf(k), createId: () => 'L1' },
    );
    expect(notices).toEqual([]);
    expect(out.lineEntries).toEqual([
      {
        localId: 'L1',
        categoryId: charCat.id,
        title: '老周',
        summary: '船行掌柜',
        fields: { identity: '掌柜', goal: '还债' },
        promotedEntryId: null,
      },
    ]);
  });

  it('里程碑序号解析成 id；不存在或已达成的丢弃并提示', () => {
    const reached = know([
      n1,
      node('m', 'n1', 1, { progress: { reachedMilestoneIds: ['m1'], note: '' } }),
    ]);
    const result = resolveStepProgress(
      { reachedMilestones: [1, 2, 9], note: ' 进了山门 ' },
      ctxOf(reached),
    );
    expect(result.progress).toEqual({ reachedMilestoneIds: ['m2'], note: '进了山门' });
    expect(result.notices.map((item) => item.kind)).toEqual([
      'unknown-milestone',
      'unknown-milestone',
    ]);
    expect(result.notices[1]!.message).toBe('没有第 9 个里程碑');
  });

  it('结局 goal 指向好结局目标而 kind 为坏结局 → goalId = null + unknown-goal', () => {
    const mismatch = resolveStepEnding(
      { kind: 'bad', goal: 1, title: '坠江', cause: '贸然渡江' },
      ctxOf(k),
    );
    expect(mismatch.ending).toEqual({
      kind: 'bad',
      goalId: null,
      title: '坠江',
      cause: '贸然渡江',
    });
    expect(mismatch.notices).toEqual([
      { kind: 'unknown-goal', message: '结局类型与目标 G1 不一致，没有记为达成该目标' },
    ]);
    const matched = resolveStepEnding(
      { kind: 'bad', goal: 2, title: '坠江', cause: '贸然渡江' },
      ctxOf(k),
    );
    expect(matched.ending?.goalId).toBe('g2');
    expect(resolveStepEnding(null, ctxOf(k))).toEqual({ ending: null, notices: [] });
  });

  it('ocChanges 的 castId 一律是 cast[0].id', () => {
    const { delta: out } = resolveStepChanges(
      raw({
        ocChanges: [
          { aspect: 'injury', op: 'add', text: '左臂中箭' },
          { aspect: 'item', op: 'add', text: '青铜钥匙' },
        ],
      }),
      ctxOf(k),
    );
    expect(out.ocChanges.map((item) => item.castId)).toEqual(['cast1', 'cast1']);
  });
});

// ---------------------------------------------------------------- 提升别名

describe('已提升的本线条目是别名', () => {
  const lineY = {
    localId: 'y',
    categoryId: charCat.id,
    title: '阿七',
    summary: '',
    fields: { identity: '孤儿' },
    promotedEntryId: null as string | null,
  };
  const yRef = { kind: 'line' as const, nodeId: 'p2', localId: 'y' };
  const W = entry('w', { title: '阿七', fields: { identity: '孤儿（全书）' } });

  function tree(promoted: boolean) {
    const p1 = node('p1', null, 0);
    const p2 = node('p2', 'p1', 1, {
      delta: delta({ lineEntries: [{ ...lineY, promotedEntryId: promoted ? 'w' : null }] }),
    });
    const p3 = node('p3', 'p2', 2, {
      delta: delta({ fieldOverrides: [{ target: yRef, fieldKey: 'identity', value: '学徒' }] }),
    });
    const p4 = node('p4', 'p3', 3, {
      delta: delta({
        fieldOverrides: [{ target: yRef, fieldKey: 'identity', value: '青冥宗弟子' }],
        statusChanges: [{ target: yRef, status: 'dead', note: '' }],
      }),
    });
    const q2 = node('q2', 'p1', 1);
    return { p1, p2, p3, p4, q2 };
  }

  it('提升后原线上只有一个阿七（世界观条目 W），后续改写与状态作用在 W 上；兄弟分支看到 W 的原文', () => {
    const { p1, p2, p3, p4, q2 } = tree(true);
    const at4 = know([p1, p2, p3, p4], [X, W]);
    const ys = at4.entries.filter((item) => item.title === '阿七');
    expect(ys).toHaveLength(1);
    expect(ys[0]!.ref).toEqual(world('w'));
    expect(ys[0]!.fields.identity).toEqual({ value: '青冥宗弟子', source: 'p4' });
    expect(ys[0]!.status?.value).toBe('dead');

    const sibling = know([p1, q2], [X, W]);
    const y = sibling.entries.find((item) => item.title === '阿七');
    expect(y?.fields.identity).toEqual({ value: '孤儿（全书）', source: 'world' });
    expect(y?.status).toBeNull();
  });

  it('W 被软删除后，原线上的阿七恢复为本线条目，3a / 4a 的变化都还在', () => {
    const { p1, p2, p3, p4 } = tree(true);
    const at4 = know([p1, p2, p3, p4], [X, { ...W, deletedAt: 5 }]);
    const y = at4.entries.find((item) => item.title === '阿七');
    expect(y?.origin).toBe('line');
    expect(y?.fields.identity).toEqual({ value: '青冥宗弟子', source: 'p4' });
    expect(y?.status?.value).toBe('dead');
  });

  it('sanitizeDelta 按别名解析引用', () => {
    const { p1, p2, p3 } = tree(true);
    const k = know([p1, p2, p3], [X, W]);
    const result = sanitizeDelta(
      delta({ fieldOverrides: [{ target: yRef, fieldKey: 'identity', value: '新身份' }] }),
      { knowledge: k, categories },
    );
    expect(result.notices).toEqual([]);
    expect(result.delta.fieldOverrides).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 预设揭示

describe('预设条目的揭示', () => {
  const P = entry('p', {
    title: '黑衣人',
    fields: { identity: '刺客' },
    scope: {
      kind: 'limited',
      targets: [{ scenarioId: 'S', fromNodeId: null, revealHint: '主角进入青冥宗后' }],
    },
  });

  it('被俘 → 进 entries、状态 captured 且隐含 revealed；之后 restored 清处境、仍在 entries', () => {
    const k0 = know([n1], [X, P]);
    expect(k0.pendingReveals.map((item) => item.title)).toEqual(['黑衣人']);
    const { delta: out } = resolveStepChanges(
      raw({ statusChanges: [{ entry: '黑衣人', status: 'captured', note: '被沈砚擒住' }] }),
      ctxOf(k0),
    );
    expect(out.statusChanges).toEqual([
      { target: world('p'), status: 'revealed', note: '' },
      { target: world('p'), status: 'captured', note: '被沈砚擒住' },
    ]);
    const s2 = node('s2', 'n1', 1, { delta: out });
    const k1 = know([n1, s2], [X, P]);
    expect(k1.pendingReveals).toEqual([]);
    expect(k1.entries.find((item) => item.title === '黑衣人')?.status).toEqual({
      value: 'captured',
      nodeId: 's2',
      note: '被沈砚擒住',
    });
    const s3 = node('s3', 's2', 2, {
      delta: delta({ statusChanges: [{ target: world('p'), status: 'restored', note: '' }] }),
    });
    const k2 = know([n1, s2, s3], [X, P]);
    expect(k2.entries.find((item) => item.title === '黑衣人')?.status).toBeNull();
    expect(k2.pendingReveals).toEqual([]);
  });

  it('newEntries 新建同名的预设 → 不新建，记 revealed、字段转覆盖，并提示 duplicate-entry', () => {
    const k0 = know([n1], [X, P]);
    const { delta: out, notices } = resolveStepChanges(
      raw({
        newEntries: [
          {
            category: '人物',
            title: '黑衣人',
            summary: '',
            fields: [
              { field: '身份', value: '青冥宗叛徒' },
              { field: '说话方式', value: '沙哑' },
            ],
          },
        ],
      }),
      ctxOf(k0),
    );
    expect(out.lineEntries).toEqual([]);
    expect(out.statusChanges).toEqual([{ target: world('p'), status: 'revealed', note: '' }]);
    expect(out.fieldOverrides).toEqual([
      { target: world('p'), fieldKey: 'identity', value: '青冥宗叛徒' },
    ]);
    expect(notices.map((item) => item.kind)).toEqual(['locked-field', 'duplicate-entry']);
    expect(notices[1]!.message).toBe('「黑衣人」是预设人物，已记为登场，没有重复新建');
  });

  it('字段覆盖引用预设条目时照常处理并隐含 revealed', () => {
    const k0 = know([n1], [X, P]);
    const { delta: out } = resolveStepChanges(
      raw({ fieldChanges: [{ entry: '黑衣人', field: '身份', value: '内应' }] }),
      ctxOf(k0),
    );
    expect(out.statusChanges).toEqual([{ target: world('p'), status: 'revealed', note: '' }]);
    expect(out.fieldOverrides).toEqual([
      { target: world('p'), fieldKey: 'identity', value: '内应' },
    ]);
  });

  it('fromNodeId 非空、没有登场条件的条目在子树内直接在 entries', () => {
    const branchOnly = entry('bo', {
      title: '老艄公',
      scope: { kind: 'limited', targets: [{ scenarioId: 'S', fromNodeId: 'n2a', revealHint: '' }] },
    });
    const k = know([n1, n2a, n3a], [branchOnly]);
    expect(k.entries.map((item) => item.title)).toContain('老艄公');
    expect(k.pendingReveals).toEqual([]);
  });
});

// ---------------------------------------------------------------- inactive 与其他叠加规则

describe('不再生效的差异与叠加规则', () => {
  const override = node('i2', 'n1', 1, {
    delta: delta({ fieldOverrides: [{ target: world('x'), fieldKey: 'identity', value: '叛徒' }] }),
  });

  it('字段后来锁定：覆盖不生效，进 inactive', () => {
    const locked = { ...X, fieldLocks: { identity: 'locked' as const } };
    const k = know([n1, override], [locked]);
    expect(field(k, '裴照', 'identity')?.value).toBe('捕快');
    expect(k.inactive).toEqual([
      { nodeId: 'i2', message: '「裴照」的「身份」已改为底层设定，本线改写不再生效' },
    ]);
  });

  it('条目软删除：它从有效知识里消失，覆盖进 inactive', () => {
    const k = know([n1, override], [{ ...X, deletedAt: 9 }]);
    expect(k.entries).toEqual([]);
    expect(k.inactive).toHaveLength(1);
  });

  it('字段从模板里删掉：覆盖进 inactive', () => {
    const trimmed: Category = {
      ...charCat,
      fieldTemplate: CHARACTER_FIELDS.filter((f) => f.key !== 'identity'),
    };
    const k = effectiveKnowledge({
      scenario,
      path: [n1, override],
      entries: [X],
      categories: [worldCat, trimmed],
    });
    expect(k.inactive[0]!.message).toBe('「裴照」已没有「identity」这一栏，第 2 步的改写不再生效');
  });

  it('OC 状态 add 去重、remove 删除；标记后写覆盖；restored 清状态', () => {
    const a = node('a', 'n1', 1, {
      delta: delta({
        ocChanges: [
          { castId: 'cast1', aspect: 'injury', op: 'add', text: '左臂中箭' },
          { castId: 'cast1', aspect: 'injury', op: 'add', text: '左臂中箭' },
          { castId: 'cast1', aspect: 'item', op: 'add', text: '钥匙' },
        ],
        flags: [{ key: '渡口', value: '封锁' }],
        statusChanges: [{ target: world('x'), status: 'missing', note: '' }],
      }),
    });
    const b = node('b', 'a', 2, {
      delta: delta({
        ocChanges: [
          { castId: 'cast1', aspect: 'injury', op: 'remove', text: '左臂中箭' },
          { castId: 'cast1', aspect: 'injury', op: 'remove', text: '不存在' },
        ],
        flags: [{ key: '渡口', value: '解封' }],
        statusChanges: [{ target: world('x'), status: 'restored', note: '' }],
        events: ['渡口解封'],
      }),
    });
    const atA = know([n1, a]);
    expect(atA.oc.cast1!.injury).toEqual([{ text: '左臂中箭', nodeId: 'a' }]);
    expect(atA.entries.find((item) => item.title === '裴照')?.status?.value).toBe('missing');
    const atB = know([n1, a, b]);
    expect(atB.oc.cast1!.injury).toEqual([]);
    expect(atB.oc.cast1!.item).toEqual([{ text: '钥匙', nodeId: 'a' }]);
    expect(atB.flags).toEqual({ 渡口: { value: '解封', nodeId: 'b' } });
    expect(atB.entries.find((item) => item.title === '裴照')?.status).toBeNull();
    expect(atB.events).toEqual([{ text: '渡口解封', nodeId: 'b', depth: 2 }]);
  });
});

// ---------------------------------------------------------------- sanitizeDelta

describe('sanitizeDelta', () => {
  it('锁定字段、不存在的条目、模板外字段、世界规则死亡都被拦下并提示', () => {
    const k = know([n1]);
    const result = sanitizeDelta(
      delta({
        fieldOverrides: [
          { target: world('x'), fieldKey: 'voice', value: '多话' },
          { target: world('ghost'), fieldKey: 'identity', value: '?' },
          { target: world('x'), fieldKey: 'kungfu', value: '刀' },
          { target: world('x'), fieldKey: 'identity', value: '叛徒' },
        ],
        statusChanges: [{ target: world('rule'), status: 'dead', note: '' }],
      }),
      { knowledge: k, categories },
    );
    expect(result.notices.map((item) => item.kind)).toEqual([
      'locked-field',
      'unknown-entry',
      'unknown-field',
      'rule-status',
    ]);
    expect(result.delta.fieldOverrides).toEqual([
      { target: world('x'), fieldKey: 'identity', value: '叛徒' },
    ]);
    expect(result.delta.statusChanges).toEqual([]);
  });

  it('本步新建的本线条目可以被本步引用', () => {
    const k = know([n1]);
    const result = sanitizeDelta(
      delta({
        lineEntries: [
          {
            localId: 'z',
            categoryId: charCat.id,
            title: '老周',
            summary: '',
            fields: {},
            promotedEntryId: null,
          },
        ],
        statusChanges: [
          { target: { kind: 'line', nodeId: 'me', localId: 'z' }, status: 'dead', note: '' },
        ],
      }),
      { knowledge: k, categories, nodeId: 'me' },
    );
    expect(result.notices).toEqual([]);
    expect(result.delta.statusChanges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 渲染

describe('渲染', () => {
  it('renderScenarioEntry：锁定字段标「（底层，不可改变）」', () => {
    const text = renderScenarioEntry(X, charCat, (key) => fieldMutability(charCat, X, key));
    expect(text).toBe(
      '## 裴照（人物）\n别名：裴捕头\n身份：捕快\n说话方式（底层，不可改变）：话少',
    );
  });

  it('renderWorldlineState 两次调用逐字节相同，条目顺序与输入顺序无关', () => {
    const z = entry('z', { title: '阿大', fields: { identity: '樵夫' } });
    const step = node('r2', 'n1', 1, {
      delta: delta({
        fieldOverrides: [
          { target: world('z'), fieldKey: 'identity', value: '猎户' },
          { target: world('x'), fieldKey: 'identity', value: '叛徒' },
        ],
        flags: [
          { key: 'b', value: '2' },
          { key: 'a', value: '1' },
        ],
        events: ['渡口起火'],
      }),
    });
    const forward = renderWorldlineState(know([n1, step], [X, z]), categories);
    const backward = renderWorldlineState(know([n1, step], [z, X]), [charCat, worldCat]);
    expect(forward).toBe(backward);
    expect(forward).toBe(renderWorldlineState(know([n1, step], [X, z]), categories));
    expect(forward).toBe(
      [
        '【本线变化（与上文设定冲突时以这里为准，底层字段除外）】',
        '设定改写：\n- 裴照 · 身份：叛徒（第 2 步）\n- 阿大 · 身份：猎户（第 2 步）',
        '标记：\n- a：1\n- b：2',
        '最近的事件：\n- 第 2 步 · 渡口起火',
      ].join('\n\n'),
    );
    expect(renderWorldlineState(know([n1]), categories)).toBe('');
  });

  it('本线新条目全文渲染，锁定字段同样标注', () => {
    const text = renderWorldlineState(know([n1, n2a]), categories);
    expect(text).toContain(
      '本线新出现：\n## 阿七（人物）\n渡口的孩子\n身份：孤儿\n说话方式（底层，不可改变）：结巴\n（第 2 步出现）',
    );
  });

  it('mentionedEffectiveEntries 复用名称匹配，本线条目也能被命中', () => {
    const k = know([n1, n2a]);
    const hits = mentionedEffectiveEntries('阿七拉住裴捕头的袖子', k.entries);
    expect(hits.map((item) => item.title).sort()).toEqual(['裴照', '阿七'].sort());
  });
});
