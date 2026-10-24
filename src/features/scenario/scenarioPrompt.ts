import type {
  Category,
  KnowledgeEntry,
  Novel,
  OptionRisk,
  OptionTendency,
  Scenario,
  ScenarioGoalKind,
  ScenarioNode,
  StyleProfile,
  WritingNorm,
} from '@/domain/schema';
import { MAX_INFERRED_ENTRIES } from '@/context/ContextBuilder';
import { estimateTokens } from '@/context/tokens';
import { contextGap, walkedChoices } from '@/domain/scenario';
import {
  fieldMutability,
  mentionedEffectiveEntries,
  refKey,
  renderScenarioEntry,
  renderWorldlineState,
  visibleEntries,
  type EffectiveEntry,
  type EffectiveKnowledge,
} from '@/domain/worldline';
import { normsInScope } from '@/domain/writingNorm';
import {
  composeNormsSection,
  composeSections,
  composeStylePrefix,
  normTokens,
  renderNormBlock,
} from '@/prompt/sections';

/**
 * 互动推演的提示词（设计 §5.4 / D5.1）。
 *
 * 全部纯函数、逐字节可复现：按显式数组顺序拼接，条目按 title 码元序 + id 兜底排序（不用 localeCompare，
 * 顺序不随区域设置变化），不含时间戳与 token 数。
 *
 * 系统提示只放同一推演里所有步骤、分支、收尾都相同的内容；世界观条目在这里只出现**原文**，
 * 世界线上的改写只出现在用户提示的【本线变化】里并明说「冲突时以这里为准」。把有效值直接渲染进前缀
 * 会让每条分支的前缀都不同，兄弟分支、回退后的新分支就都命中不了同一份缓存。
 */

export const OPENER =
  '你是一部互动小说的叙事导演兼执笔者。作者操控主角在下面的世界里做选择；你负责写出每一步的情节、提出下一个挑战，并如实记录这一步给世界带来的变化。';

export const SCENARIO_RULES = `【推演规则】
1. 情节写 300–600 字，用作品的叙述视角，只写这一步。结尾停在挑战出现的时刻，不替主角做决定。
2. 作者给出的行动是主角的「尝试」。按世界规则判定结果：可行就写出成败与代价；违背标有「底层，不可改变」的设定（凭空获得能力、无视代价）时，写主角尝试、失败及其后果，不能让它成真。
3. 挑战必须从上一步行动的后果、下一个里程碑、尚未收束的线索三者中至少一个生长出来，不要凭空引入与目标无关的新危机。
4. 每一步最多引入两个新的人物、地点或物件。导演提示进入收束阶段或超出预计步数后，不再引入新人物与新线索，优先回收已有线索。
5. 选项 2–4 个，倾向彼此不同，都在世界规则内可行。选项文字只写主角要做什么，不写结果；风险只按主角此刻看得见的危险标注。
6. 结局只有当此前的选择与状态直接导致时才触发，cause 写清是哪个选择或哪种状态导致的。不得靠突发外力（天降援兵、意外暴毙、突然揭晓真相）制造结局，也不要为了赶上预计步数而强行转折。允许坏结局，包括主角死亡与目标彻底失败。触发结局时不再给选项。
7. changes 只记录这一步真正发生、会影响后续的变化。条目名用上文出现过的正式名称；不得改写标有「底层，不可改变」的字段；人物死亡、失踪等写进 statusChanges；世界规则类设定不会死亡或被毁。
8. 下文「本线变化」与上文设定冲突时，以「本线变化」为准（底层字段除外）。
9. 目标用 G1、G2…，里程碑用 M1、M2… 的序号引用。`;

export const OPTION_TENDENCY_LABELS: Record<OptionTendency, string> = {
  cautious: '谨慎',
  bold: '果断',
  indirect: '迂回',
  confront: '对抗',
  cooperate: '合作',
  sacrifice: '牺牲',
  deceive: '欺骗',
  explore: '探索',
};

export const OPTION_RISK_LABELS: Record<OptionRisk, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

export const GOAL_KIND_LABELS: Record<ScenarioGoalKind, string> = {
  good: '好结局',
  bad: '坏结局',
  neutral: '中性结局',
};

/** 【本线相关设定】显式档（本线差异碰过的条目）的上限，最近的优先 */
export const MAX_EXPLICIT_ENTRIES = 12;

/** 「本步依据」清单的分组 */
export type ScenarioContextKind =
  | 'meta'
  | 'norm'
  | 'pinned'
  | 'cast'
  | 'setup'
  | 'rules'
  | 'related'
  | 'inferred'
  | 'preset'
  | 'worldline'
  | 'earlier'
  | 'gap'
  | 'recent'
  | 'director'
  | 'action';

/** 注入清单的一项。tokens 对这一项进 prompt 的文本估算；只有推断条目可能 included = false */
export interface ScenarioContextItem {
  kind: ScenarioContextKind;
  /** 条目用条目 id，其余用固定标识 */
  id: string;
  label: string;
  tokens: number;
  included: boolean;
}

/** 本次行动。option 带上选项原文：提示词只认文字，不认 id */
export type ScenarioPromptAction =
  | { kind: 'start' }
  | { kind: 'option'; text: string }
  | { kind: 'free'; text: string }
  | { kind: 'wrap-up'; goalId: string | null; note: string };

// ---------------------------------------------------------------- 工具

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byTitle(a: KnowledgeEntry, b: KnowledgeEntry): number {
  return compareText(a.title, b.title) || compareText(a.id, b.id);
}

function item(
  kind: ScenarioContextKind,
  id: string,
  label: string,
  text: string,
  included = true,
): ScenarioContextItem {
  return { kind, id, label, tokens: estimateTokens(text), included };
}

function renderWorldEntry(entry: KnowledgeEntry, categories: readonly Category[]): string {
  const category = categories.find((cat) => cat.id === entry.categoryId);
  return renderScenarioEntry(entry, category, (key) => fieldMutability(category, entry, key));
}

function categoryName(categories: readonly Category[], categoryId: string): string {
  return categories.find((cat) => cat.id === categoryId)?.name ?? '设定';
}

/**
 * 在本推演内全程可见的核心设定：通用的 pinned + 限定到本推演、fromNodeId 为空、无登场条件的 pinned，
 * 排除主角（主角在【主角】块单独渲染，不重复）
 */
function coreEntries(
  entries: readonly KnowledgeEntry[],
  scenario: Pick<Scenario, 'id' | 'setup'>,
): KnowledgeEntry[] {
  const castIds = new Set(scenario.setup.cast.map((member) => member.entryId));
  return visibleEntries(entries, scenario.id, new Set())
    .filter(
      (visible) => visible.entry.pinned && !visible.revealHint && !castIds.has(visible.entry.id),
    )
    .map((visible) => visible.entry)
    .sort(byTitle);
}

function castEntryOf(
  entries: readonly KnowledgeEntry[],
  scenario: Pick<Scenario, 'setup'>,
): KnowledgeEntry | undefined {
  const entryId = scenario.setup.cast[0]?.entryId;
  return entries.find((entry) => entry.id === entryId && (entry.deletedAt ?? null) === null);
}

/** 一步的行动在回顾里怎么写 */
function actionLabel(node: ScenarioNode): string {
  const by = node.arrivedBy;
  switch (by.kind) {
    case 'start':
      return '开局';
    case 'option':
      return `主角选择：${by.text}`;
    case 'free':
      return `作者为主角输入的尝试：${by.text}`;
    case 'wrap-up':
      return '作者要求收尾';
  }
}

function stepHeading(node: ScenarioNode): string {
  return `第 ${node.depth + 1} 步 · ${actionLabel(node)}`;
}

/**
 * 提示词里一步的标题行（「第 k 步 · 主角选择：…」）。沉淀大纲与「写这一章」复用同一写法，
 * 模型在推演时看到的步骤标注与沉淀时一致，抄「对应步骤」编号不会错位
 */
export const promptStepHeading = stepHeading;

// ---------------------------------------------------------------- 系统提示

/** 【本推演的开局与目标】。开局设定改了（目标、里程碑、基调、预计步数）前缀才变 */
export function scenarioSetupSection(scenario: Pick<Scenario, 'setup'>): string {
  const { start, goals, milestones, tone, expectedSteps } = scenario.setup;
  const lines = ['【本推演的开局与目标】'];
  if (start.time.trim()) lines.push(`起点时间：${start.time.trim()}`);
  if (start.place.trim()) lines.push(`起点地点：${start.place.trim()}`);
  lines.push(`起点处境：${start.situation.trim()}`);
  lines.push('结局目标（作者设想的走向；能否抵达由主角的选择决定）：');
  goals.forEach((goal, index) => {
    lines.push(`G${index + 1}（${GOAL_KIND_LABELS[goal.kind]}）${goal.description.trim()}`);
  });
  if (milestones.length > 0) {
    lines.push('里程碑（按顺序）：');
    milestones.forEach((milestone, index) =>
      lines.push(`M${index + 1} ${milestone.description.trim()}`),
    );
  }
  if (tone.trim()) lines.push(`基调：${tone.trim()}`);
  lines.push(`预计步数：约 ${expectedSteps} 步（只是节奏参考，不要为了赶上它而强行转折）`);
  return lines.join('\n');
}

/**
 * 稳定前缀（D5.1 系统提示第 2–6 项）：作品与文风 → 写作规范（作用范围含「互动推演」）→ 核心设定 →
 * 主角 → 开局与目标。规范排在核心设定之前：确认新的核心设定不会让规范失去缓存（与写作链路同理）
 */
export function buildScenarioStablePrefix(input: {
  novel: Novel;
  style: StyleProfile;
  norms: readonly WritingNorm[];
  categories: readonly Category[];
  entries: readonly KnowledgeEntry[];
  scenario: Pick<Scenario, 'id' | 'setup'>;
}): { text: string; items: ScenarioContextItem[] } {
  const { novel, style, norms, categories, entries, scenario } = input;
  const items: ScenarioContextItem[] = [];

  const styleText = composeStylePrefix(novel, style);
  items.push(item('meta', 'meta+style', '作品信息与风格档案', styleText));

  const inScope = normsInScope(norms, 'interactive');
  for (const norm of inScope) {
    // 与知识库、写作链路同一口径（normTokens = estimateTokens(renderNormBlock)）
    items.push({
      kind: 'norm',
      id: norm.id,
      label: `写作规范 · ${norm.title}`,
      tokens: normTokens(norm),
      included: true,
    });
  }
  const normsText = composeNormsSection('interactive', inScope.map(renderNormBlock));

  const coreBlocks: string[] = [];
  for (const entry of coreEntries(entries, scenario)) {
    const text = renderWorldEntry(entry, categories);
    coreBlocks.push(text);
    items.push(item('pinned', entry.id, `核心设定 · ${entry.title}`, text));
  }
  const coreText =
    coreBlocks.length > 0 ? ['【必须遵守的核心设定】', ...coreBlocks].join('\n\n') : '';

  const cast = castEntryOf(entries, scenario);
  let castText = '';
  if (cast) {
    const text = renderWorldEntry(cast, categories);
    castText = ['【主角】', text].join('\n\n');
    items.push(item('cast', cast.id, `主角 · ${cast.title}`, text));
  }

  const setupText = scenarioSetupSection(scenario);
  items.push(item('setup', 'setup', '开局与目标', setupText));
  items.push(item('rules', 'rules', '推演规则', SCENARIO_RULES));

  return { text: composeSections([styleText, normsText, coreText, castText, setupText]), items };
}

/** 系统提示 = 开场白 + 稳定前缀 + 推演规则。【输出格式】由 generateProseWithTail / generateStructured 各自追加 */
export function buildScenarioSystemPrompt(stablePrefix: string): string {
  return composeSections([OPENER, stablePrefix, SCENARIO_RULES]);
}

// ---------------------------------------------------------------- 用户提示：第 1–7 块

interface ContextInput {
  knowledge: EffectiveKnowledge;
  /** 以「最后一步已发生的节点」结尾：推进时是父节点，再给选项时是当前节点；开局为空 */
  path: readonly ScenarioNode[];
  scenario: Pick<Scenario, 'id' | 'setup'>;
  entries: readonly KnowledgeEntry[];
  categories: readonly Category[];
  excludedEntryIds?: ReadonlySet<string>;
}

/**
 * D5.1 用户提示第 1–7 块。extraMentionText = 本次行动 / 当前挑战，参与推断条目的匹配
 */
function contextBlocks(
  input: ContextInput,
  extraMentionText: string,
): { parts: string[]; items: ScenarioContextItem[] } {
  const { knowledge, path, scenario, entries, categories } = input;
  const excluded = input.excludedEntryIds ?? new Set<string>();
  const parts: string[] = [];
  const items: ScenarioContextItem[] = [];
  const { recent, checkpoint, gap } = contextGap(path);
  const summary = checkpoint?.pathSummary ?? null;

  // 1 本线相关设定：只放世界观条目的原文（本线新条目全文在【本线变化】里），前缀里已有的不重复
  const inPrefix = new Set([
    ...coreEntries(entries, scenario).map((entry) => entry.id),
    ...scenario.setup.cast.map((member) => member.entryId),
  ]);
  const candidates = new Map<string, EffectiveEntry>();
  for (const entry of knowledge.entries) {
    if (entry.ref.kind !== 'world' || !entry.entry || inPrefix.has(entry.ref.entryId)) continue;
    candidates.set(refKey(entry.ref), entry);
  }
  // 显式档：本线差异碰过的条目，从最近一步往回取
  const explicit: EffectiveEntry[] = [];
  const taken = new Set<string>();
  for (let i = path.length - 1; i >= 0 && explicit.length < MAX_EXPLICIT_ENTRIES; i -= 1) {
    const delta = path[i]!.delta;
    const targets = [
      ...(delta?.fieldOverrides ?? []).map((change) => change.target),
      ...(delta?.statusChanges ?? []).map((change) => change.target),
    ];
    for (const target of targets) {
      const key = knowledge.lineAliases[refKey(target)] ?? refKey(target);
      const hit = candidates.get(key);
      if (!hit || taken.has(key)) continue;
      taken.add(key);
      explicit.push(hit);
      if (explicit.length >= MAX_EXPLICIT_ENTRIES) break;
    }
  }
  // 推断档：最近几步原文、本次行动、前情摘要里提到的。被取消勾选的仍占名额，清单因此不会跳动
  const mentionText = [
    ...recent.map((node) => node.plot),
    extraMentionText,
    summary?.text ?? '',
    ...(summary?.openThreads ?? []),
  ].join('\n');
  const inferred = mentionedEffectiveEntries(
    mentionText,
    [...candidates.values()].filter((entry) => !taken.has(refKey(entry.ref))),
  ).slice(0, MAX_INFERRED_ENTRIES);

  const relatedBlocks: string[] = [];
  for (const entry of explicit) {
    const text = renderWorldEntry(entry.entry!, categories);
    relatedBlocks.push(text);
    items.push(
      item(
        'related',
        entry.entry!.id,
        `${categoryName(categories, entry.categoryId)} · ${entry.title}`,
        text,
      ),
    );
  }
  for (const entry of inferred) {
    const text = renderWorldEntry(entry.entry!, categories);
    const included = !excluded.has(entry.entry!.id);
    if (included) relatedBlocks.push(text);
    items.push(
      item(
        'inferred',
        entry.entry!.id,
        `${categoryName(categories, entry.categoryId)} · ${entry.title}`,
        text,
        included,
      ),
    );
  }
  if (relatedBlocks.length > 0) {
    parts.push(
      [
        '【本线相关设定】',
        '以下是与这一步相关的设定原文；它们在这条线上的变化见下文「本线变化」。',
        ...relatedBlocks,
      ].join('\n\n'),
    );
  }

  // 2 可能登场的预设
  if (knowledge.pendingReveals.length > 0) {
    const lines = knowledge.pendingReveals.map((entry) => {
      const summaryText = entry.summary.trim() ? `：${entry.summary.trim()}` : '';
      return `- ${entry.title}（登场条件：${entry.revealHint}）${summaryText}`;
    });
    const text = [
      '【可能登场的预设】',
      '以下由作者预设，满足登场条件时才让它出现；出现时用这里的正式名称。',
      ...lines,
    ].join('\n');
    parts.push(text);
    items.push(item('preset', 'preset', '可能登场的预设', text));
  }

  // 3 本线变化
  const castNames: Record<string, string> = {};
  const cast = castEntryOf(entries, scenario);
  const castId = scenario.setup.cast[0]?.id;
  if (cast && castId) castNames[castId] = cast.title;
  const worldline = renderWorldlineState(knowledge, categories, castNames);
  if (worldline) {
    parts.push(worldline);
    items.push(item('worldline', 'worldline', '本线变化', worldline));
  }

  // 4 更早的经过
  if (summary) {
    const threads =
      summary.openThreads.length > 0
        ? summary.openThreads.map((thread) => `- ${thread}`)
        : ['（无）'];
    const text = ['【更早的经过】', summary.text.trim(), '尚未收束的线索：', ...threads].join('\n');
    parts.push(text);
    items.push(item('earlier', 'earlier', `前情摘要（到第 ${checkpoint!.depth + 1} 步）`, text));
  }

  // 5 此前几步（简）
  if (gap.length > 0) {
    const text = [
      '【此前几步（简）】',
      ...gap.map((node) => `${stepHeading(node)}\n${node.plot.trim()}`),
    ].join('\n\n');
    parts.push(text);
    items.push(item('gap', 'gap', `此前 ${gap.length} 步`, text));
  }

  // 6 最近几步
  if (recent.length > 0) {
    const text = [
      '【最近几步】',
      ...recent.map((node) => {
        const lines = [stepHeading(node), node.plot.trim()];
        if (node.challenge.trim()) lines.push(`挑战：${node.challenge.trim()}`);
        return lines.join('\n');
      }),
    ].join('\n\n');
    parts.push(text);
    items.push(item('recent', 'recent', `最近 ${recent.length} 步`, text));
  }

  // 7 导演提示
  const director = directorSection({
    path,
    knowledge,
    scenario,
    openThreads: summary?.openThreads ?? [],
  });
  parts.push(director);
  items.push(item('director', 'director', '导演提示', director));

  return { parts, items };
}

/**
 * 【导演提示】（D4.2）：第几步、所处阶段、已达成与下一个里程碑、尚未收束的线索。
 * 阶段按「这一步 / 预计步数」：< 40% 展开，40%–80% 推进，> 80% 收束；超过 100% 追加不催结局的提醒
 */
export function directorSection(input: {
  path: readonly ScenarioNode[];
  knowledge: Pick<EffectiveKnowledge, 'reachedMilestoneIds'>;
  scenario: Pick<Scenario, 'setup'>;
  openThreads: readonly string[];
}): string {
  const { setup } = input.scenario;
  const step = input.path.length + 1;
  const ratio = step / setup.expectedSteps;
  const stage = ratio < 0.4 ? '展开阶段' : ratio <= 0.8 ? '推进阶段' : '收束阶段';
  const lines = [
    '【导演提示】',
    `这是第 ${step} 步，预计全程约 ${setup.expectedSteps} 步（${stage}）。`,
  ];

  const reached = new Set(input.knowledge.reachedMilestoneIds);
  const milestones = setup.milestones.map((milestone, index) => ({
    milestone,
    label: `M${index + 1}`,
  }));
  const done = milestones.filter(({ milestone }) => reached.has(milestone.id));
  if (milestones.length > 0) {
    lines.push(
      done.length > 0
        ? `已达成：${done.map(({ milestone, label }) => `${label} ${milestone.description.trim()}`).join('；')}。`
        : '已达成：（暂无）',
    );
    const next = milestones.find(({ milestone }) => !reached.has(milestone.id));
    lines.push(
      next
        ? `下一个里程碑：${next.label} ${next.milestone.description.trim()}。在接下来几步里让它成为可能，但是否达成由主角的选择决定，不要替主角完成。`
        : '里程碑已全部达成。',
    );
  }
  if (input.openThreads.length > 0) lines.push(`尚未收束的线索：${input.openThreads.join('；')}`);
  if (step > setup.expectedSteps) {
    lines.push(
      '已超出预计步数：不再引入新人物与新线索，优先回收已有线索；是否收尾由作者决定，不要为了结束而强行转折。',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 用户提示：第 8 块

/** 【本次行动】/【本次要求】（设计 §5.4 的 action 渲染表） */
export function actionSection(
  action: ScenarioPromptAction,
  scenario: Pick<Scenario, 'setup'>,
): string {
  switch (action.kind) {
    case 'start':
      return '【本次行动】这是开局：从上面的起点写起，引出第一个挑战。';
    case 'option':
      return `【本次行动】主角选择：${action.text}`;
    case 'free':
      // 自由输入一律是「尝试」：违背底层设定时写尝试、失败与后果，不能让它成真（D3.3）
      return `【本次行动】作者为主角输入的尝试：${action.text}\n（这是尝试，不是既成事实。按推演规则第 2 条判定结果。）`;
    case 'wrap-up': {
      const lines = ['【本次要求】作者要求收尾：在这一步写出结局（ending 必填，options 为空）。'];
      const index =
        action.goalId === null
          ? -1
          : scenario.setup.goals.findIndex((goal) => goal.id === action.goalId);
      const goal = index >= 0 ? scenario.setup.goals[index]! : null;
      if (goal)
        lines.push(
          `目标：G${index + 1}（${GOAL_KIND_LABELS[goal.kind]}）${goal.description.trim()}`,
        );
      if (action.note.trim()) lines.push(`作者说明：${action.note.trim()}`);
      lines.push('从当前状态自然得出；做不到圆满就写开放或中性结局。');
      return lines.join('\n');
    }
  }
}

function actionMentionText(action: ScenarioPromptAction): string {
  switch (action.kind) {
    case 'option':
    case 'free':
      return action.text;
    case 'wrap-up':
      return action.note;
    case 'start':
      return '';
  }
}

/**
 * 一步（含开局与收尾）的用户提示。knowledge = 父节点处的有效知识，path = 根 → 父节点（开局为空）
 */
export function buildStepUserPrompt(input: ContextInput & { action: ScenarioPromptAction }): {
  text: string;
  items: ScenarioContextItem[];
} {
  const { parts, items } = contextBlocks(input, actionMentionText(input.action));
  const action = actionSection(input.action, input.scenario);
  items.push(
    item('action', 'action', input.action.kind === 'wrap-up' ? '收尾要求' : '本次行动', action),
  );
  return { text: composeSections([...parts, action]), items };
}

/**
 * 「再给几个选项」的用户提示：第 1–7 块与推进相同，但以**当前节点**为最后一步（【最近几步】含当前节点的
 * 情节与挑战，【本线变化】累计到当前节点）；第 8 块列出已有选项与走过的自由输入。
 * children = 当前节点的子节点（算走过的自由输入）
 */
export function buildOptionsUserPrompt(
  input: ContextInput & {
    excludedEntryIds: ReadonlySet<string>;
    children: readonly ScenarioNode[];
  },
): string {
  const node = input.path[input.path.length - 1];
  if (!node) throw new Error('要再给选项的那一步已不存在');
  const { parts } = contextBlocks(input, node.challenge);
  const free = walkedChoices(node, input.children).free.map((walked) => `- ${walked.text}`);
  const request = [
    `【本次要求】这一步的挑战是：${node.challenge.trim()}`,
    '这一步已有的选项：',
    ...node.options.map(
      (option, index) =>
        `${index + 1}. ${option.text}（${OPTION_TENDENCY_LABELS[option.tendency]}）`,
    ),
    `这一步走过的其他行动：${free.length > 0 ? '' : '（无）'}`,
    ...free,
    '再给 2–4 个主角面对这个挑战时可以做的事：倾向与上面的都不同、文字不同，都在世界规则内可行；只写做什么，不写结果；风险只按主角此刻看得见的危险标注。只输出 options。',
  ].join('\n');
  return composeSections([...parts, request]);
}

/**
 * 检查点前情摘要的用户提示。steps = 上一个有摘要的祖先之后到检查点（含）的步骤（checkpointSegment）
 */
export function buildSummaryUserPrompt(input: {
  previous: { text: string; openThreads: string[] } | null;
  steps: readonly ScenarioNode[];
}): string {
  const { previous, steps } = input;
  const threads =
    previous && previous.openThreads.length > 0
      ? previous.openThreads.map((thread) => `- ${thread}`)
      : ['（无）'];
  return [
    `【上一段前情】${previous ? previous.text.trim() : '（从开局写起）'}`,
    '尚未收束的线索：',
    ...threads,
    '',
    '【这几步的经过】',
    steps.map((node) => `${stepHeading(node)}\n${node.plot.trim()}`).join('\n\n'),
    '',
    '【本次要求】把上一段前情与这几步合成一段新的前情摘要（≤ 600 字，只写已发生的事，不评论、不预测），并列出到这里为止仍未收束的线索（≤ 8 条，已收束的去掉）。',
  ].join('\n');
}

export { renderScenarioEntry, renderWorldlineState };
