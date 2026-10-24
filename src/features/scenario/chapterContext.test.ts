import { describe, expect, it } from 'vitest';
import { CHARACTER_FIELDS } from '@/domain/defaults';
import {
  CategorySchema,
  KnowledgeEntrySchema,
  emptyDelta,
  type Category,
  type KnowledgeEntry,
  type Scenario,
  type ScenarioNode,
  type WorldlineDelta,
} from '@/domain/schema';
import { buildScenarioChapterContext, type ScenarioChapterInput } from './chapterContext';

const characters: Category = CategorySchema.parse({
  id: 'c-char',
  novelId: 'n1',
  name: '人物',
  kind: 'character',
  builtin: true,
  fieldTemplate: CHARACTER_FIELDS,
  order: 1,
  createdAt: 0,
  updatedAt: 0,
});

function entry(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    id,
    novelId: 'n1',
    categoryId: characters.id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

const limitedTo = (revealHint = '', fromNodeId: string | null = null) => ({
  kind: 'limited' as const,
  targets: [{ scenarioId: 'S', fromNodeId, revealHint }],
});

const oc = entry('沈砚', {
  scope: limitedTo(),
  fields: { identity: '渡口船夫', voice: '话少，爱用反问' },
});
/** 预设人物：有登场条件，揭示前不在有效知识的 entries 里 */
const preset = entry('青衣客', {
  scope: limitedTo('有人在渡口打听船夫时'),
  fields: { voice: '说话带江南口音' },
});
/** 限定到本推演、但本章没碰过也没提到：不该进 */
const bystander = entry('卖茶婆', { scope: limitedTo(), fields: { voice: '絮叨' } });
const pei = entry('裴照', { fields: { voice: '冷淡' } });

function scenarioWith(castEntryId: string): Scenario {
  return {
    id: 'S',
    novelId: 'n1',
    title: '雾中渡',
    setup: {
      cast: [{ id: 'cast-1', entryId: castEntryId }],
      start: { time: '', place: '渡口', situation: '醒来' },
      goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
      milestones: [],
      tone: '',
      expectedSteps: 30,
    },
    mainNodeId: null,
    cursorNodeId: null,
    lastAdvancedAt: null,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Scenario;
}

function step(depth: number, plot: string, delta: Partial<WorldlineDelta> = {}): ScenarioNode {
  return {
    id: `s${depth}`,
    novelId: 'n1',
    scenarioId: 'S',
    parentId: depth === 0 ? null : `s${depth - 1}`,
    depth,
    arrivedBy:
      depth === 0
        ? { kind: 'start' }
        : { kind: 'option', optionId: `o${depth}`, text: `第${depth}个选择` },
    plot,
    challenge: '',
    options: [],
    delta: { ...emptyDelta(), ...delta },
    notices: [],
    progress: { reachedMilestoneIds: [], note: '' },
    ending: null,
    pathSummary: null,
    deltaEditedAt: null,
    createdAt: depth,
    updatedAt: depth,
  };
}

const revealPreset = {
  statusChanges: [
    {
      target: { kind: 'world' as const, entryId: preset.id },
      status: 'revealed' as const,
      note: '',
    },
  ],
};

/** 8 步：第 2 步揭示青衣客（本章 = 第 1–4 步），第 3 步提到他 */
function nodesRevealedInChapter(): ScenarioNode[] {
  return [
    step(0, '沈砚在渡口醒来。'),
    step(1, '有人在打听船夫。', revealPreset),
    step(2, '青衣客走上船来。', { events: ['青衣客登船'] }),
    step(3, '船离岸。'),
    step(4, '江心起雾。'),
    step(5, '雾散。'),
  ];
}

function input(overrides: Partial<ScenarioChapterInput> = {}): ScenarioChapterInput {
  return {
    scenario: scenarioWith(oc.id),
    nodes: nodesRevealedInChapter(),
    entries: [oc, preset, bystander, pei],
    categories: [characters],
    source: { nodeIds: ['s0', 's1', 's2', 's3'] },
    forkNodeId: null,
    ...overrides,
  };
}

describe('【本章涉及的推演专属设定】', () => {
  it('本章第 2 步揭示的预设进第一块，计数包含它；主角必选；没碰过也没提到的限定条目不进', () => {
    const { context } = buildScenarioChapterContext(input());
    expect(context!.limitedText).toContain('## 青衣客（人物）');
    expect(context!.limitedText).toContain('说话带江南口音');
    expect(context!.limitedText).toContain('## 沈砚（人物）');
    expect(context!.limitedText).toContain('话少，爱用反问');
    expect(context!.limitedText).not.toContain('卖茶婆');
    // 通用条目不在这一块（它们在写作链路自己的条目列表里）
    expect(context!.limitedText).not.toContain('裴照');
    expect(context!.limitedLabel).toBe('推演专属设定（主角『沈砚』等 2 条）');
    // 锁定字段同样标「（底层，不可改变）」
    expect(context!.limitedText).toContain('说话方式（底层，不可改变）：话少，爱用反问');
  });

  it('对照：预设只在下一章（第 6 步）才揭示时，本章不含它', () => {
    const nodes = [
      step(0, '沈砚在渡口醒来。'),
      step(1, '有人在打听船夫。'),
      step(2, '船上空无一人。'),
      step(3, '船离岸。'),
      step(4, '江心起雾。'),
      step(5, '青衣客从雾里走出来。', revealPreset),
    ];
    const { context } = buildScenarioChapterContext(input({ nodes }));
    expect(context!.limitedText).not.toContain('青衣客');
    expect(context!.limitedLabel).toBe('推演专属设定（主角『沈砚』等 1 条）');
  });

  it('主角在回收站：不进第一块，并给出提示', () => {
    const result = buildScenarioChapterContext(
      input({ entries: [{ ...oc, deletedAt: 9 }, preset, bystander, pei] }),
    );
    expect(result.castInTrash).toBe('沈砚');
    expect(result.context!.limitedText).not.toContain('沈砚（人物）');
    expect(result.context!.limitedLabel).toBe('推演专属设定（1 条）');
  });
});

describe('castEntryIds 与 hintText', () => {
  it('主角是通用条目时进 castEntryIds、不在第一块重复；限定主角不进 castEntryIds', () => {
    const universal = buildScenarioChapterContext(input({ scenario: scenarioWith(pei.id) }));
    expect(universal.context!.castEntryIds).toEqual([pei.id]);
    expect(universal.context!.limitedText).not.toContain('裴照');
    expect(buildScenarioChapterContext(input()).context!.castEntryIds).toEqual([]);
  });

  it('hintText = 外传细纲 + 本章步骤原文；外传第三块以「本章细纲」开头', () => {
    const { context } = buildScenarioChapterContext(
      input({ source: { nodeIds: ['s0', 's1', 's2', 's3'], brief: '沈砚登船，青衣客现身。' } }),
    );
    expect(context!.hintText).toBe(
      [
        '沈砚登船，青衣客现身。',
        '沈砚在渡口醒来。',
        '有人在打听船夫。',
        '青衣客走上船来。',
        '船离岸。',
      ].join('\n'),
    );
    expect(
      context!.stepsText.startsWith('【本章依据的互动推演】\n\n本章细纲：沈砚登船，青衣客现身。'),
    ).toBe(true);
    expect(context!.stepsText).toContain('第 2 步 · 主角选择：第1个选择\n有人在打听船夫。');
    expect(context!.label).toBe('互动推演 · 第 1–4 步原文');
  });
});

describe('分叉与世界线状态', () => {
  it('外传章节带【分叉之前的经过】：检查点摘要 + 之后到分叉点的原文；主线章节没有', () => {
    const nodes = [
      {
        ...step(0, '开局的事。'),
        pathSummary: { text: '沈砚醒来，船夫不见了。', openThreads: [] },
      },
      step(1, '分叉前一步。'),
      step(2, '外传第一步。'),
      step(3, '外传第二步。'),
    ];
    const side = buildScenarioChapterContext(
      input({ nodes, source: { nodeIds: ['s2', 's3'] }, forkNodeId: 's1' }),
    );
    expect(side.context!.forkText).toContain(
      '【分叉之前的经过（与主线共用，外传不要重写这部分）】',
    );
    expect(side.context!.forkText).toContain('沈砚醒来，船夫不见了。');
    expect(side.context!.forkText).toContain('分叉前一步。');
    expect(side.context!.forkText).not.toContain('外传第一步。');
    expect(
      buildScenarioChapterContext(input({ nodes, source: { nodeIds: ['s2', 's3'] } })).context!
        .forkText,
    ).toBe('');
  });

  it('开始时的状态 = 第一步父节点处的差异；本章内的变化单列', () => {
    const nodes = [
      step(0, '开局。'),
      step(1, '裴照被俘。', {
        statusChanges: [
          { target: { kind: 'world', entryId: pei.id }, status: 'captured', note: '' },
        ],
      }),
      step(2, '沈砚受了伤。', {
        ocChanges: [{ castId: 'cast-1', aspect: 'injury', op: 'add', text: '左臂刀伤' }],
        events: ['夜袭'],
      }),
    ];
    const { context } = buildScenarioChapterContext(input({ nodes, source: { nodeIds: ['s2'] } }));
    const [start, changes] = context!.stateText.split('本章内发生的变化：');
    expect(start).toContain('裴照：被俘（第 2 步）');
    expect(start).not.toContain('左臂刀伤');
    expect(changes).toContain('沈砚 · 伤势：左臂刀伤');
    expect(changes).toContain('第 3 步 · 夜袭');
    expect(changes).not.toContain('被俘');
    expect(context!.label).toBe('互动推演 · 第 3 步原文');
  });

  it('没有任何变化时状态块为空串', () => {
    const nodes = [step(0, '开局。'), step(1, '平静的一步。')];
    expect(
      buildScenarioChapterContext(input({ nodes, source: { nodeIds: ['s0', 's1'] } })).context!
        .stateText,
    ).toBe('');
  });
});

describe('来源不存在', () => {
  it('推演不存在、步骤缺失或不连续时不注入，并标记 sourceGone', () => {
    expect(buildScenarioChapterContext(input({ scenario: undefined }))).toMatchObject({
      context: null,
      sourceGone: true,
    });
    expect(
      buildScenarioChapterContext(input({ source: { nodeIds: ['s0', 'gone'] } })),
    ).toMatchObject({
      context: null,
      sourceGone: true,
    });
    expect(buildScenarioChapterContext(input({ source: { nodeIds: ['s0', 's2'] } }))).toMatchObject(
      {
        context: null,
        sourceGone: true,
      },
    );
  });
});
