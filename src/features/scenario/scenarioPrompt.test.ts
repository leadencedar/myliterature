import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@/context/tokens';
import { CHARACTER_FIELDS, WORLDBUILDING_FIELDS } from '@/domain/defaults';
import {
  CategorySchema,
  KnowledgeEntrySchema,
  NovelSchema,
  ScenarioNodeSchema,
  ScenarioSchema,
  StyleProfileSchema,
  WritingNormSchema,
  emptyDelta,
  type KnowledgeEntry,
  type Scenario,
  type ScenarioNode,
  type WorldlineDelta,
} from '@/domain/schema';
import { pathTo } from '@/domain/scenario';
import { effectiveKnowledge, renderWorldlineState } from '@/domain/worldline';
import { generateProseWithTail } from '@/llm/proseTail';
import { generateStructured } from '@/llm/structured';
import type { ChatRequest, LlmClient } from '@/llm/types';
import { composeStylePrefix } from '@/prompt/sections';
import { DEEPSEEK_CAPS } from '@/test/llmFixtures';
import {
  OPENER,
  SCENARIO_RULES,
  buildOptionsUserPrompt,
  buildScenarioStablePrefix,
  buildScenarioSystemPrompt,
  buildStepUserPrompt,
  buildSummaryUserPrompt,
  directorSection,
  type ScenarioPromptAction,
} from './scenarioPrompt';
import {
  OptionsBatchSchema,
  StepTailSchema,
  SummaryOutSchema,
  WrapUpTailSchema,
  type StepTail,
} from './stepSchema';

// ---------------------------------------------------------------- 夹具

const novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  createdAt: 0,
  updatedAt: 0,
});
const style = StyleProfileSchema.parse({
  id: 's1',
  novelId: 'n1',
  extraInstruction: '对白少用感叹号。',
  createdAt: 0,
  updatedAt: 0,
});
const worldCat = CategorySchema.parse({
  id: 'c-world',
  novelId: 'n1',
  name: '世界观设定',
  kind: 'worldbuilding',
  builtin: true,
  fieldTemplate: WORLDBUILDING_FIELDS,
  createdAt: 0,
  updatedAt: 0,
});
const charCat = CategorySchema.parse({
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
const categories = [worldCat, charCat];

function entry(
  input: Partial<KnowledgeEntry> & Pick<KnowledgeEntry, 'id' | 'categoryId' | 'title'>,
): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({ novelId: 'n1', createdAt: 0, updatedAt: 0, ...input });
}

const limited = (scenarioId: string, fromNodeId: string | null = null, revealHint = '') => ({
  kind: 'limited' as const,
  targets: [{ scenarioId, fromNodeId, revealHint }],
});

const lingqi = entry({
  id: 'e-lingqi',
  categoryId: 'c-world',
  title: '灵气',
  pinned: true,
  fields: { rules: '吐纳入体，经脉为渠。', cost: '强行催动会损寿元。' },
});
const peizhao = entry({
  id: 'e-peizhao',
  categoryId: 'c-char',
  title: '裴照',
  aliases: ['裴捕头'],
  summary: '六扇门捕头。',
  fields: { identity: '六扇门捕头', voice: '话少，句句带刺。' },
});
const shenyan = entry({
  id: 'e-shen',
  categoryId: 'c-char',
  title: '沈砚',
  fields: { identity: '船夫', voice: '低声' },
  scope: limited('sc1'),
});
const jinghong = entry({
  id: 'e-jinghong',
  categoryId: 'c-world',
  title: '惊鸿渡',
  pinned: true,
  fields: { definition: '渡口的古名。' },
  scope: limited('sc1'),
});
const branchOnly = entry({
  id: 'e-branch',
  categoryId: 'c-world',
  title: '暗河',
  pinned: true,
  fields: { definition: '只在某条线上出现的河。' },
  scope: limited('sc1', 'node-1'),
});
const preset = entry({
  id: 'e-gu',
  categoryId: 'c-char',
  title: '顾长明',
  summary: '青冥宗长老。',
  pinned: true,
  scope: limited('sc1', null, '主角进入青冥宗时'),
});
const otherScenario = entry({
  id: 'e-other',
  categoryId: 'c-world',
  title: '别处的规矩',
  pinned: true,
  fields: { definition: '另一个推演的东西。' },
  scope: limited('sc2'),
});
const entries = [lingqi, peizhao, shenyan, jinghong, branchOnly, preset, otherScenario];

const norms = [
  WritingNormSchema.parse({
    id: 'norm-a',
    novelId: 'n1',
    title: '推演规范',
    content: '不写穿越。',
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  }),
  WritingNormSchema.parse({
    id: 'norm-b',
    novelId: 'n1',
    title: '只管正文',
    content: '每章三千字。',
    scopes: ['writing'],
    order: 1,
    createdAt: 0,
    updatedAt: 0,
  }),
];

function scenarioOf(overrides: { castEntryId?: string; expectedSteps?: number } = {}): Scenario {
  return ScenarioSchema.parse({
    id: 'sc1',
    novelId: 'n1',
    title: '雾中渡',
    setup: {
      cast: [{ id: 'cast-1', entryId: overrides.castEntryId ?? 'e-shen' }],
      start: { time: '', place: '渡口', situation: '在渡口醒来，船夫不见了' },
      goals: [
        { id: 'g1', kind: 'good', description: '找到船夫' },
        { id: 'g2', kind: 'bad', description: '沉江' },
      ],
      milestones: [
        { id: 'm1', description: '找到空船' },
        { id: 'm2', description: '进入青冥宗' },
      ],
      tone: '阴冷',
      expectedSteps: overrides.expectedSteps ?? 10,
    },
    createdAt: 0,
    updatedAt: 0,
  });
}

let created = 0;
function node(
  id: string,
  parent: ScenarioNode | null,
  plot: string,
  extra: {
    arrivedBy?: ScenarioNode['arrivedBy'];
    delta?: Partial<WorldlineDelta>;
    pathSummary?: ScenarioNode['pathSummary'];
    challenge?: string;
    reached?: string[];
  } = {},
): ScenarioNode {
  created += 1;
  return ScenarioNodeSchema.parse({
    id,
    novelId: 'n1',
    scenarioId: 'sc1',
    parentId: parent?.id ?? null,
    depth: parent ? parent.depth + 1 : 0,
    arrivedBy:
      extra.arrivedBy ??
      (parent
        ? { kind: 'option', optionId: `${parent.id}-o1`, text: `走向${id}` }
        : { kind: 'start' }),
    plot,
    challenge: extra.challenge ?? `挑战${id}`,
    options: [
      { id: `${id}-o1`, text: `走向${id}之后甲`, tendency: 'cautious', risk: 'low' },
      { id: `${id}-o2`, text: `走向${id}之后乙`, tendency: 'bold', risk: 'high' },
    ],
    delta: { ...emptyDelta(), ...extra.delta },
    progress: { reachedMilestoneIds: extra.reached ?? [], note: '' },
    pathSummary: extra.pathSummary ?? null,
    createdAt: created,
    updatedAt: created,
  });
}

/** 线性路径：depth 0..length-1 */
function chain(
  length: number,
  decorate: (depth: number) => Parameters<typeof node>[3] = () => ({}),
): ScenarioNode[] {
  const out: ScenarioNode[] = [];
  for (let depth = 0; depth < length; depth += 1) {
    out.push(
      node(`d${depth}`, out[depth - 1] ?? null, `第${depth + 1}步的情节原文。`, decorate(depth)),
    );
  }
  return out;
}

function knowledgeAt(scenario: Scenario, path: ScenarioNode[]) {
  return effectiveKnowledge({ scenario, path, entries, categories });
}

function systemOf(scenario: Scenario, list: KnowledgeEntry[] = entries) {
  const prefix = buildScenarioStablePrefix({
    novel,
    style,
    norms,
    categories,
    entries: list,
    scenario,
  });
  return buildScenarioSystemPrompt(prefix.text);
}

function stepUser(
  scenario: Scenario,
  path: ScenarioNode[],
  action: ScenarioPromptAction,
  excluded?: Set<string>,
) {
  return buildStepUserPrompt({
    knowledge: knowledgeAt(scenario, path),
    path,
    scenario,
    entries,
    categories,
    action,
    ...(excluded ? { excludedEntryIds: excluded } : {}),
  });
}

// ---------------------------------------------------------------- 系统提示

describe('系统提示', () => {
  it('由开场白、稳定前缀、推演规则组成，各块顺序固定', () => {
    const scenario = scenarioOf();
    const system = systemOf(scenario);
    const order = [
      OPENER,
      composeStylePrefix(novel, style),
      '【作者的写作规范】',
      '【必须遵守的核心设定】',
      '【主角】',
      '【本推演的开局与目标】',
      '【推演规则】',
    ].map((marker) => system.indexOf(marker));
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(system.startsWith(OPENER)).toBe(true);
    expect(system.endsWith(SCENARIO_RULES)).toBe(true);
  });

  it('同一推演不同节点、不同分支、收尾时逐字节相同：前缀不含任何路径上的内容', () => {
    const scenario = scenarioOf();
    const root = node('r', null, '开局情节');
    const a = node('a', root, '甲线情节', {
      delta: {
        fieldOverrides: [
          { target: { kind: 'world', entryId: 'e-peizhao' }, fieldKey: 'identity', value: '叛徒' },
        ],
      },
    });
    const b = node('b', root, '乙线情节', { arrivedBy: { kind: 'free', text: '跳江' } });
    const system = systemOf(scenario);
    // 系统提示的输入不含节点：改写、分支、收尾都只进用户提示
    for (const text of ['叛徒', '甲线情节', '乙线情节', '跳江']) expect(system).not.toContain(text);
    expect(stepUser(scenario, [root, a], { kind: 'option', text: '拔刀' }).text).toContain('叛徒');
    expect(
      stepUser(scenario, [root, b], { kind: 'wrap-up', goalId: 'g1', note: '' }).text,
    ).not.toContain('叛徒');
    expect(systemOf(scenario)).toBe(system);
  });

  it('作用范围含「互动推演」的规范在作品与文风之后、核心设定之前；不含该范围的不出现（验收 29）', () => {
    const system = systemOf(scenarioOf());
    const styleEnd =
      system.indexOf(composeStylePrefix(novel, style)) + composeStylePrefix(novel, style).length;
    const normAt = system.indexOf('【规范《推演规范》】');
    expect(normAt).toBeGreaterThan(styleEnd);
    expect(normAt).toBeLessThan(system.indexOf('【必须遵守的核心设定】'));
    expect(system).toContain('推演时把这些约束落实到情节、挑战与选项里');
    expect(system).not.toContain('只管正文');
    expect(system).not.toContain('每章三千字');
  });

  it('没有可注入的规范时不出现规范段落', () => {
    const prefix = buildScenarioStablePrefix({
      novel,
      style,
      norms: [norms[1]!],
      categories,
      entries,
      scenario: scenarioOf(),
    });
    expect(prefix.text).not.toContain('【作者的写作规范】');
    expect(prefix.items.some((item) => item.kind === 'norm')).toBe(false);
  });

  it('锁定字段带「（底层，不可改变）」，可变字段不带', () => {
    const system = systemOf(scenarioOf());
    expect(system).toContain('运作规则（底层，不可改变）：吐纳入体，经脉为渠。');
    expect(system).toContain('限制与代价（底层，不可改变）：强行催动会损寿元。');
    expect(system).toContain('身份：船夫');
    expect(system).toContain('说话方式（底层，不可改变）：低声');
  });

  it('核心设定：通用 pinned 与限定到本推演、全程可见、无登场条件的 pinned 进前缀；fromNodeId 非空、有登场条件、别的推演的不进', () => {
    const system = systemOf(scenarioOf());
    const core = system.slice(system.indexOf('【必须遵守的核心设定】'), system.indexOf('【主角】'));
    expect(core).toContain('## 灵气（世界观设定）');
    expect(core).toContain('## 惊鸿渡（世界观设定）');
    expect(core.indexOf('## 惊鸿渡')).toBeLessThan(core.indexOf('## 灵气'));
    expect(system).not.toContain('暗河');
    expect(system).not.toContain('顾长明');
    expect(system).not.toContain('别处的规矩');
    // 非 pinned 的通用条目不进前缀
    expect(system).not.toContain('## 裴照');
  });

  it('主角是通用 pinned 条目时，前缀里只出现一次（在【主角】块）', () => {
    const pinnedPei = { ...peizhao, pinned: true };
    const list = entries.map((item) => (item.id === peizhao.id ? pinnedPei : item));
    const system = systemOf(scenarioOf({ castEntryId: peizhao.id }), list);
    expect(system.split('## 裴照（人物）').length - 1).toBe(1);
    expect(system.indexOf('## 裴照')).toBeGreaterThan(system.indexOf('【主角】'));
  });

  it('开局与目标：起点、G / M 序号、基调与预计步数', () => {
    const system = systemOf(scenarioOf());
    expect(system).toContain('起点地点：渡口');
    expect(system).toContain('起点处境：在渡口醒来，船夫不见了');
    expect(system).not.toContain('起点时间');
    expect(system).toContain('G1（好结局）找到船夫');
    expect(system).toContain('G2（坏结局）沉江');
    expect(system).toContain('M1 找到空船\nM2 进入青冥宗');
    expect(system).toContain('基调：阴冷');
    expect(system).toContain('预计步数：约 10 步');
  });

  it('清单的 token 与对应文本一致', () => {
    const scenario = scenarioOf();
    const prefix = buildScenarioStablePrefix({
      novel,
      style,
      norms,
      categories,
      entries,
      scenario,
    });
    const meta = prefix.items.find((item) => item.kind === 'meta')!;
    expect(meta.tokens).toBe(estimateTokens(composeStylePrefix(novel, style)));
    expect(prefix.items.find((item) => item.kind === 'rules')!.tokens).toBe(
      estimateTokens(SCENARIO_RULES),
    );
    expect(prefix.items.filter((item) => item.kind === 'pinned').map((item) => item.id)).toEqual([
      'e-jinghong',
      'e-lingqi',
    ]);
    expect(prefix.items.find((item) => item.kind === 'cast')!.id).toBe('e-shen');
  });
});

// ---------------------------------------------------------------- 用户提示

describe('用户提示', () => {
  /** depth 0..9：depth 1 改写裴照身份，depth 4 是带摘要的检查点 */
  function longPath() {
    return chain(10, (depth) => {
      if (depth === 1) {
        return {
          delta: {
            fieldOverrides: [
              {
                target: { kind: 'world', entryId: 'e-peizhao' },
                fieldKey: 'identity',
                value: '叛徒',
              },
            ],
          },
        };
      }
      if (depth === 4)
        return { pathSummary: { text: '沈砚找到了空船。', openThreads: ['船夫去向'] } };
      return {};
    });
  }

  it('块顺序：相关设定 → 预设 → 本线变化 → 更早的经过 → 此前几步 → 最近几步 → 导演提示 → 本次行动', () => {
    const scenario = scenarioOf({ expectedSteps: 30 });
    const { text } = stepUser(scenario, longPath(), { kind: 'option', text: '拔刀' });
    const order = [
      '【本线相关设定】',
      '【可能登场的预设】',
      '【本线变化（与上文设定冲突时以这里为准，底层字段除外）】',
      '【更早的经过】',
      '【此前几步（简）】',
      '【最近几步】',
      '【导演提示】',
      '【本次行动】主角选择：拔刀',
    ].map((marker) => text.indexOf(marker));
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('最近 3 步给原文与挑战；检查点摘要 + gap 简写；检查点及之前的步骤不再出现原文', () => {
    const scenario = scenarioOf({ expectedSteps: 30 });
    const { text } = stepUser(scenario, longPath(), { kind: 'option', text: '拔刀' });
    const recent = text.slice(text.indexOf('【最近几步】'), text.indexOf('【导演提示】'));
    expect(recent).toContain('第 8 步 · 主角选择：走向d7\n第8步的情节原文。\n挑战：挑战d7');
    expect(recent).toContain('第 10 步');
    expect(recent).not.toContain('第 7 步');
    const gap = text.slice(text.indexOf('【此前几步（简）】'), text.indexOf('【最近几步】'));
    expect(gap).toContain('第 6 步 · 主角选择：走向d5\n第6步的情节原文。');
    expect(gap).toContain('第 7 步');
    expect(text).toContain('【更早的经过】\n沈砚找到了空船。\n尚未收束的线索：\n- 船夫去向');
    for (let step = 1; step <= 5; step += 1) expect(text).not.toContain(`第${step}步的情节原文。`);
  });

  it('本线差异碰过的条目以世界观原文进【本线相关设定】，改写只在【本线变化】里', () => {
    const scenario = scenarioOf({ expectedSteps: 30 });
    const path = longPath();
    const { text, items } = stepUser(scenario, path, { kind: 'option', text: '拔刀' });
    const related = text.slice(
      text.indexOf('【本线相关设定】'),
      text.indexOf('【可能登场的预设】'),
    );
    expect(related).toContain('身份：六扇门捕头');
    expect(related).not.toContain('叛徒');
    expect(text).toContain('- 裴照 · 身份：叛徒（第 2 步）');
    expect(items.find((item) => item.id === 'e-peizhao')!.kind).toBe('related');
    // 清单 token 与文本一致
    const worldline = renderWorldlineState(knowledgeAt(scenario, path), categories, {
      'cast-1': '沈砚',
    });
    expect(text).toContain(worldline);
    expect(items.find((item) => item.kind === 'worldline')!.tokens).toBe(estimateTokens(worldline));
  });

  it('预设：名称 + 登场条件 + 摘要', () => {
    const { text } = stepUser(scenarioOf(), chain(2), { kind: 'option', text: '拔刀' });
    expect(text).toContain('- 顾长明（登场条件：主角进入青冥宗时）：青冥宗长老。');
  });

  it('自由输入带「这是尝试，不是既成事实」（验收 9）', () => {
    const { text } = stepUser(scenarioOf(), chain(2), { kind: 'free', text: '徒手劈开江水' });
    expect(text).toContain(
      '【本次行动】作者为主角输入的尝试：徒手劈开江水\n（这是尝试，不是既成事实。按推演规则第 2 条判定结果。）',
    );
  });

  it('开局：没有回顾块，只有导演提示与开局行动', () => {
    const { text } = stepUser(scenarioOf(), [], { kind: 'start' });
    expect(text).not.toContain('【最近几步】');
    expect(text).toContain('这是第 1 步');
    expect(text.endsWith('【本次行动】这是开局：从上面的起点写起，引出第一个挑战。')).toBe(true);
  });

  it('收尾要求：ending 必填、目标与作者说明', () => {
    const { text } = stepUser(scenarioOf(), chain(3), {
      kind: 'wrap-up',
      goalId: 'g1',
      note: '让他上岸',
    });
    expect(text).toContain(
      '【本次要求】作者要求收尾：在这一步写出结局（ending 必填，options 为空）。',
    );
    expect(text).toContain('目标：G1（好结局）找到船夫');
    expect(text).toContain('作者说明：让他上岸');
    expect(text).toContain('从当前状态自然得出；做不到圆满就写开放或中性结局。');
    const open = stepUser(scenarioOf(), chain(3), { kind: 'wrap-up', goalId: null, note: '' }).text;
    expect(open).not.toContain('目标：');
    expect(open).not.toContain('作者说明');
  });

  it('推断条目：最近几步里提到的进相关设定；excludedEntryIds 里的不进用户提示，系统提示不变', () => {
    const scenario = scenarioOf();
    const path = chain(2);
    path.push(node('mention', path[1]!, '裴捕头从雾里走出来。'));
    const included = stepUser(scenario, path, { kind: 'option', text: '拔刀' });
    expect(included.text).toContain('## 裴照（人物）');
    expect(included.items.find((item) => item.id === 'e-peizhao')).toMatchObject({
      kind: 'inferred',
      included: true,
    });

    const before = systemOf(scenario);
    const excluded = stepUser(
      scenario,
      path,
      { kind: 'option', text: '拔刀' },
      new Set(['e-peizhao']),
    );
    expect(excluded.text).not.toContain('## 裴照');
    expect(excluded.items.find((item) => item.id === 'e-peizhao')).toMatchObject({
      kind: 'inferred',
      included: false,
    });
    expect(systemOf(scenario)).toBe(before);
  });

  it('本次行动里提到的条目也算推断', () => {
    const { text } = stepUser(scenarioOf(), chain(2), { kind: 'free', text: '去找裴照' });
    expect(text).toContain('## 裴照（人物）');
  });
});

describe('导演提示', () => {
  const at = (pathLength: number, reached: string[] = []) =>
    directorSection({
      path: chain(pathLength),
      knowledge: { reachedMilestoneIds: reached },
      scenario: scenarioOf({ expectedSteps: 10 }),
      openThreads: pathLength > 5 ? ['船夫去向'] : [],
    });

  it('三个阶段：< 40% 展开，40%–80% 推进，> 80% 收束', () => {
    expect(at(2)).toContain('这是第 3 步，预计全程约 10 步（展开阶段）。');
    expect(at(5)).toContain('这是第 6 步，预计全程约 10 步（推进阶段）。');
    expect(at(8)).toContain('这是第 9 步，预计全程约 10 步（收束阶段）。');
    expect(at(8)).not.toContain('已超出预计步数');
  });

  it('超过预计步数追加不催结局的提醒', () => {
    expect(at(10)).toContain(
      '已超出预计步数：不再引入新人物与新线索，优先回收已有线索；是否收尾由作者决定，不要为了结束而强行转折。',
    );
  });

  it('已达成与下一个里程碑、尚未收束的线索', () => {
    expect(at(2)).toContain('已达成：（暂无）');
    expect(at(2)).toContain('下一个里程碑：M1 找到空船。');
    const later = at(6, ['m1']);
    expect(later).toContain('已达成：M1 找到空船。');
    expect(later).toContain('下一个里程碑：M2 进入青冥宗。');
    expect(later).toContain('尚未收束的线索：船夫去向');
    expect(at(6, ['m1', 'm2'])).toContain('里程碑已全部达成。');
  });
});

// ---------------------------------------------------------------- 再给选项与前情摘要

describe('再给选项与前情摘要', () => {
  it('options 的 user：以当前节点为最后一步，含挑战、已有选项与走过的自由输入', () => {
    const scenario = scenarioOf();
    const path = chain(3);
    const current = path[2]!;
    const walkedFree = node('free-child', current, '他跳了江。', {
      arrivedBy: { kind: 'free', text: '跳江试试' },
    });
    const user = buildOptionsUserPrompt({
      knowledge: knowledgeAt(scenario, path),
      path,
      scenario,
      entries,
      categories,
      excludedEntryIds: new Set(),
      children: [walkedFree],
    });
    expect(user).toContain('第 3 步 · 主角选择：走向d2\n第3步的情节原文。\n挑战：挑战d2');
    expect(user).toContain('【本次要求】这一步的挑战是：挑战d2');
    expect(user).toContain('1. 走向d2之后甲（谨慎）\n2. 走向d2之后乙（果断）');
    expect(user).toContain('这一步走过的其他行动：\n- 跳江试试');
    expect(user).toContain('只输出 options。');
    expect(user).toContain('这是第 4 步');
  });

  it('summary 的 user：previous 为 null 时写「（从开局写起）」', () => {
    const steps = chain(5);
    const user = buildSummaryUserPrompt({ previous: null, steps });
    expect(user).toContain('【上一段前情】（从开局写起）\n尚未收束的线索：\n（无）');
    expect(user).toContain('第 1 步 · 开局\n第1步的情节原文。');
    expect(user).toContain('第 5 步 · 主角选择：走向d4\n第5步的情节原文。');
    expect(user).toContain('【本次要求】把上一段前情与这几步合成一段新的前情摘要');
    const next = buildSummaryUserPrompt({
      previous: { text: '前情甲。', openThreads: ['线索一'] },
      steps: steps.slice(1),
    });
    expect(next).toContain('【上一段前情】前情甲。\n尚未收束的线索：\n- 线索一');
  });

  it('步骤、收尾、options、summary 四种请求的 system 在【推演规则】结束处之前逐字节相同', async () => {
    const scenario = scenarioOf();
    const system = systemOf(scenario);
    const seen: ChatRequest[] = [];
    const tail: StepTail = {
      challenge: '船在下沉',
      options: [
        { text: '拔刀', tendency: 'bold', risk: 'high' },
        { text: '跳江', tendency: 'cautious', risk: 'medium' },
      ],
      changes: {
        fieldChanges: [],
        newEntries: [],
        statusChanges: [],
        ocChanges: [],
        events: [],
        flags: [],
      },
      progress: { reachedMilestones: [], note: '' },
      ending: null,
    };
    const ending: StepTail = {
      ...tail,
      options: [],
      ending: { kind: 'good', goal: 1, title: '上岸', cause: '他拔了刀' },
    };
    const client = (reply: string): LlmClient => ({
      capabilities: DEEPSEEK_CAPS,
      async streamChat(request) {
        seen.push(structuredClone(request));
        return { content: reply, reasoning: '', finishReason: 'stop' };
      },
      async chat(request) {
        seen.push(structuredClone(request));
        return { content: reply, reasoning: '', finishReason: 'stop' };
      },
    });
    const common = { model: 'm', system, user: 'u' };
    await generateProseWithTail({
      ...common,
      client: client(`情节\n@@@STATE@@@\n${JSON.stringify(tail)}`),
      schema: StepTailSchema,
      schemaName: 'scenario_step',
    });
    await generateProseWithTail({
      ...common,
      client: client(`情节\n@@@STATE@@@\n${JSON.stringify(ending)}`),
      schema: WrapUpTailSchema,
      schemaName: 'scenario_step',
    });
    await generateStructured({
      ...common,
      client: client(JSON.stringify({ options: tail.options })),
      schema: OptionsBatchSchema,
      schemaName: 'scenario_options',
    });
    await generateStructured({
      ...common,
      client: client(JSON.stringify({ summary: '前情', openThreads: [] })),
      schema: SummaryOutSchema,
      schemaName: 'scenario_path_summary',
    });

    const systems = seen.map((request) => request.messages[0]!.content);
    expect(systems).toHaveLength(4);
    const cut = system.indexOf(SCENARIO_RULES) + SCENARIO_RULES.length;
    expect(cut).toBe(system.length);
    for (const text of systems) expect(text.slice(0, cut)).toBe(system);
    // 收尾的 refine 不进 JSON Schema：步骤与收尾的系统提示整体相同
    expect(systems[1]).toBe(systems[0]);
  });
});

// ---------------------------------------------------------------- schema

describe('步骤 schema', () => {
  const option = (text: string) => ({ text, tendency: 'cautious' as const, risk: 'low' as const });
  const base: StepTail = {
    challenge: '船在下沉',
    options: [option('拔刀'), option('跳江')],
    changes: {
      fieldChanges: [],
      newEntries: [],
      statusChanges: [],
      ocChanges: [],
      events: [],
      flags: [],
    },
    progress: { reachedMilestones: [], note: '' },
    ending: null,
  };
  const ending = { kind: 'bad' as const, goal: 2, title: '沉江', cause: '他跳了江' };

  it('没有结局时要 2–4 个选项和挑战；有结局时不能给选项', () => {
    expect(StepTailSchema.safeParse(base).success).toBe(true);
    expect(StepTailSchema.safeParse({ ...base, options: [option('拔刀')] }).success).toBe(false);
    expect(StepTailSchema.safeParse({ ...base, challenge: '' }).success).toBe(false);
    expect(StepTailSchema.safeParse({ ...base, options: [], ending }).success).toBe(true);
    expect(StepTailSchema.safeParse({ ...base, ending }).success).toBe(false);
  });

  it('收尾必须有结局', () => {
    expect(WrapUpTailSchema.safeParse(base).success).toBe(false);
    expect(WrapUpTailSchema.safeParse({ ...base, options: [], ending }).success).toBe(true);
  });

  it('OptionsBatchSchema：1 个、5 个选项被拒', () => {
    expect(OptionsBatchSchema.safeParse({ options: [option('拔刀')] }).success).toBe(false);
    expect(
      OptionsBatchSchema.safeParse({
        options: ['一一', '二二', '三三', '四四', '五五'].map(option),
      }).success,
    ).toBe(false);
    expect(
      OptionsBatchSchema.safeParse({ options: [option('拔刀'), option('跳江')] }).success,
    ).toBe(true);
  });

  it('SummaryOutSchema：超 600 字被拒', () => {
    expect(SummaryOutSchema.safeParse({ summary: '字'.repeat(600), openThreads: [] }).success).toBe(
      true,
    );
    expect(SummaryOutSchema.safeParse({ summary: '字'.repeat(601), openThreads: [] }).success).toBe(
      false,
    );
  });
});

// pathTo 只用于确保夹具路径完整（链断时返回空数组会让用例悄悄失去意义）
describe('夹具自检', () => {
  it('chain 生成的是完整路径', () => {
    const path = chain(4);
    expect(pathTo(path, 'd3').map((item) => item.id)).toEqual(['d0', 'd1', 'd2', 'd3']);
  });
});
