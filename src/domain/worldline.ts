/**
 * 世界线：差异解析、锁定、有效知识与渲染。
 *
 * 世界观条目记世界的底层规则，世界线只记「根据选择生成的变化 / 新增」。任意节点的有效知识 =
 * 可见的世界观条目 + 根到该节点沿路叠加的差异，由 effectiveKnowledge 现算、不存储 ——
 * 存了就会和祖先差异的编辑漂移。兄弟分支互相看不到对方的差异，是因为叠加只沿这一条路径走。
 *
 * 对 schema.ts 只用 `import type`（原因见 scenario.ts 文件头）。
 */
import type {
  Category,
  DeltaNotice,
  EntryRef,
  EntryStatus,
  FieldMutability,
  KnowledgeEntry,
  LineEntry,
  OcAspect,
  Scenario,
  ScenarioEnding,
  ScenarioGoalKind,
  ScenarioNode,
  WorldlineDelta,
} from './schema';
import { builtinMutability } from './defaults';
import { mentionedEntries, normalizeEntryName } from './entrySearch';

// ---------------------------------------------------------------- 文案

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  revealed: '已登场',
  dead: '死亡',
  missing: '失踪',
  captured: '被俘',
  destroyed: '被毁',
  sealed: '被封印',
  restored: '恢复如常',
};

export const OC_ASPECT_LABELS: Record<OcAspect, string> = {
  injury: '伤势',
  ability: '能力',
  item: '持有物',
  relation: '关系',
  secret: '已知秘密',
  other: '其他',
};

/** 显示用的固定顺序（Record 的键序不作为契约） */
const OC_ASPECT_ORDER: OcAspect[] = ['injury', 'ability', 'item', 'relation', 'secret', 'other'];

/** 锁定字段在推演提示词里的标注 */
export const LOCKED_MARK = '（底层，不可改变）';

// ---------------------------------------------------------------- 引用

export function refKey(ref: EntryRef): string {
  return ref.kind === 'world' ? `world:${ref.entryId}` : `line:${ref.nodeId}:${ref.localId}`;
}

/** 码元序比较：不用 localeCompare，排序不随运行环境的区域设置变化（顺序变了 prompt 就变了） */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- 可变性

/**
 * 字段可变性的四级解析：条目逐字段覆盖 → 分类模板 → 内置默认（旧分类没存 mutability 时）→ 可变。
 * 本线条目没有 fieldLocks，传 entry = undefined 只看后三级
 */
export function fieldMutability(
  category: Pick<Category, 'kind' | 'name' | 'fieldTemplate'> | undefined,
  entry: Pick<KnowledgeEntry, 'fieldLocks'> | undefined,
  key: string,
): FieldMutability {
  const own = entry?.fieldLocks?.[key];
  if (own) return own;
  if (!category) return 'mutable';
  const template = category.fieldTemplate.find((field) => field.key === key)?.mutability;
  if (template) return template;
  return builtinMutability(category, key) ?? 'mutable';
}

// ---------------------------------------------------------------- 可见条目

export interface VisibleEntry {
  entry: KnowledgeEntry;
  origin: 'world' | 'limited';
  /** 登场条件；非空 = 揭示之前是「可能登场的预设」 */
  revealHint: string;
}

/**
 * 推演 scenarioId 里、路径 pathNodeIds 末端处可见的世界观条目（设计 §3.1）：未删除，且通用，
 * 或限定到本推演且 fromNodeId 为空 / 在路径上。scope 缺失按通用处理（迁移之外的第二道防线）。
 * 同一推演有多个目标时取最宽的：有整推演可见的优先，其次没有登场条件的
 */
export function visibleEntries(
  entries: readonly KnowledgeEntry[],
  scenarioId: string,
  pathNodeIds: ReadonlySet<string>,
): VisibleEntry[] {
  const out: VisibleEntry[] = [];
  for (const entry of entries) {
    if (entry.deletedAt !== null && entry.deletedAt !== undefined) continue;
    const scope = entry.scope ?? { kind: 'universal' as const };
    if (scope.kind === 'universal') {
      out.push({ entry, origin: 'world', revealHint: '' });
      continue;
    }
    const targets = scope.targets.filter(
      (target) =>
        target.scenarioId === scenarioId &&
        ((target.fromNodeId ?? null) === null || pathNodeIds.has(target.fromNodeId!)),
    );
    if (targets.length === 0) continue;
    const plain = targets.find((target) => !(target.revealHint ?? '').trim());
    out.push({
      entry,
      origin: 'limited',
      revealHint: plain ? '' : (targets[0]!.revealHint ?? '').trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 有效知识

export interface EffectiveEntry {
  ref: EntryRef;
  origin: 'world' | 'limited' | 'line';
  title: string;
  aliases: string[];
  summary: string;
  categoryId: string;
  /** 世界观条目本身（本线条目为 undefined）：可变性要看它的 fieldLocks */
  entry: KnowledgeEntry | undefined;
  /** 本线条目产生于哪个节点（世界观条目为 undefined） */
  lineNodeId: string | undefined;
  /** 每个字段的当前值与来源：'world' 或产生它的节点 id */
  fields: Record<string, { value: string; source: 'world' | string }>;
  status: { value: EntryStatus; nodeId: string; note: string } | null;
  /** 预设条目的登场条件（只在 pendingReveals 里有意义） */
  revealHint: string;
}

export interface EffectiveKnowledge {
  /** 可见的世界观条目 + 本线新条目（已提升的本线条目被对应世界观条目取代），按 title、键排序 */
  entries: EffectiveEntry[];
  /** 「可能登场的预设」：限定到本推演、有登场条件、路径上还没被揭示 */
  pendingReveals: EffectiveEntry[];
  oc: Record<string, Record<OcAspect, { text: string; nodeId: string }[]>>;
  flags: Record<string, { value: string; nodeId: string }>;
  events: { text: string; nodeId: string; depth: number }[];
  reachedMilestoneIds: string[];
  /** 存着但不再生效的差异：字段后来被锁定、条目被删除、字段从模板里删掉 */
  inactive: { nodeId: string; message: string }[];
  /** 路径上各节点的 depth，渲染「第 k 步」用 */
  depthOf: Record<string, number>;
  /** 已提升的本线条目：line 引用键 → 世界观条目的引用键 */
  lineAliases: Record<string, string>;
}

function emptyOcState(): Record<OcAspect, { text: string; nodeId: string }[]> {
  return { injury: [], ability: [], item: [], relation: [], secret: [], other: [] };
}

function worldFields(entry: KnowledgeEntry): EffectiveEntry['fields'] {
  const fields: EffectiveEntry['fields'] = {};
  for (const [key, value] of Object.entries(entry.fields ?? {})) {
    fields[key] = { value, source: 'world' };
  }
  return fields;
}

function fieldLabel(category: Category | undefined, key: string): string {
  return category?.fieldTemplate.find((field) => field.key === key)?.label ?? key;
}

function sortEntries(list: EffectiveEntry[]): EffectiveEntry[] {
  return list.sort(
    (a, b) => compareText(a.title, b.title) || compareText(refKey(a.ref), refKey(b.ref)),
  );
}

/**
 * 节点 N 处的有效知识（设计 §3.2）。path = 根 → N（含 N）；entries = 本书全部条目（含限定的，
 * 软删除的会被跳过）。沿路径从根往下逐节点应用差异，后写覆盖先写。
 *
 * - 揭示（revealed）一次性：把预设从 pendingReveals 移进 entries，之后任何状态都不撤销它；
 *   处境（dead / missing / …）写进 status，restored 只清处境。
 * - 已提升的本线条目是别名：promotedEntryId 指向的世界观条目存在且未删除时，本线条目不单独出现，
 *   指向它的覆盖与状态改为作用到那条世界观条目（只在这条路径上）；世界观条目被删后别名失效、
 *   本线条目恢复按自身 fields 叠加，原线的数据不丢。
 * - 字段后来锁定、条目被删、字段从模板删掉的覆盖不生效，进 inactive 给作者看。
 */
export function effectiveKnowledge(input: {
  scenario: Pick<Scenario, 'id'>;
  path: readonly ScenarioNode[];
  entries: readonly KnowledgeEntry[];
  categories: readonly Category[];
}): EffectiveKnowledge {
  const { scenario, path, categories } = input;
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const pathIds = new Set(path.map((node) => node.id));
  const alive = input.entries.filter(
    (entry) => entry.deletedAt === null || entry.deletedAt === undefined,
  );
  const aliveById = new Map(alive.map((entry) => [entry.id, entry]));

  // 全部条目（含预设）按引用键索引；pending 记录还没揭示的预设
  const byKey = new Map<string, EffectiveEntry>();
  const pending = new Set<string>();
  for (const visible of visibleEntries(alive, scenario.id, pathIds)) {
    const key = `world:${visible.entry.id}`;
    byKey.set(key, {
      ref: { kind: 'world', entryId: visible.entry.id },
      origin: visible.origin,
      title: visible.entry.title,
      aliases: [...(visible.entry.aliases ?? [])],
      summary: visible.entry.summary ?? '',
      categoryId: visible.entry.categoryId,
      entry: visible.entry,
      lineNodeId: undefined,
      fields: worldFields(visible.entry),
      status: null,
      revealHint: visible.revealHint,
    });
    if (visible.revealHint) pending.add(key);
  }

  // 别名：line 键 → world 键。先扫一遍整条路径，祖先上的本线条目被提升后，后代的引用都改道
  const alias = new Map<string, string>();
  for (const node of path) {
    for (const line of node.delta?.lineEntries ?? []) {
      const promoted = line.promotedEntryId ?? null;
      if (promoted && aliveById.has(promoted) && byKey.has(`world:${promoted}`)) {
        alias.set(`line:${node.id}:${line.localId}`, `world:${promoted}`);
      }
    }
  }
  const resolve = (ref: EntryRef): string => {
    const key = refKey(ref);
    return alias.get(key) ?? key;
  };

  const oc: EffectiveKnowledge['oc'] = {};
  const flags: EffectiveKnowledge['flags'] = {};
  const events: EffectiveKnowledge['events'] = [];
  const reached: string[] = [];
  const inactive: EffectiveKnowledge['inactive'] = [];
  const depthOf: Record<string, number> = {};

  for (const node of path) {
    depthOf[node.id] = node.depth;
    const delta = node.delta;
    if (!delta) continue;
    const step = node.depth + 1;

    for (const line of delta.lineEntries ?? []) {
      const key = `line:${node.id}:${line.localId}`;
      if (alias.has(key)) continue;
      const fields: EffectiveEntry['fields'] = {};
      for (const [field, value] of Object.entries(line.fields ?? {})) {
        fields[field] = { value, source: node.id };
      }
      byKey.set(key, {
        ref: { kind: 'line', nodeId: node.id, localId: line.localId },
        origin: 'line',
        title: line.title,
        aliases: [],
        summary: line.summary ?? '',
        categoryId: line.categoryId,
        entry: undefined,
        lineNodeId: node.id,
        fields,
        status: null,
        revealHint: '',
      });
    }

    for (const override of delta.fieldOverrides ?? []) {
      const target = byKey.get(resolve(override.target));
      if (!target) {
        inactive.push({
          nodeId: node.id,
          message: `第 ${step} 步改写的条目已不存在，这条改写不再生效`,
        });
        continue;
      }
      const category = categoryById.get(target.categoryId);
      if (!category?.fieldTemplate.some((field) => field.key === override.fieldKey)) {
        inactive.push({
          nodeId: node.id,
          message: `「${target.title}」已没有「${override.fieldKey}」这一栏，第 ${step} 步的改写不再生效`,
        });
        continue;
      }
      if (fieldMutability(category, target.entry, override.fieldKey) === 'locked') {
        inactive.push({
          nodeId: node.id,
          message: `「${target.title}」的「${fieldLabel(category, override.fieldKey)}」已改为底层设定，本线改写不再生效`,
        });
        continue;
      }
      target.fields[override.fieldKey] = { value: override.value, source: node.id };
    }

    for (const change of delta.statusChanges ?? []) {
      const key = resolve(change.target);
      const target = byKey.get(key);
      if (!target) {
        inactive.push({
          nodeId: node.id,
          message: `第 ${step} 步的状态变化指向的条目已不存在，不再生效`,
        });
        continue;
      }
      if (change.status === 'revealed') {
        pending.delete(key);
      } else if (change.status === 'restored') {
        target.status = null;
      } else {
        // 处境同时意味着登场：被俘的预设人物显然已经出现在故事里
        pending.delete(key);
        target.status = { value: change.status, nodeId: node.id, note: change.note ?? '' };
      }
    }

    for (const change of delta.ocChanges ?? []) {
      const state = (oc[change.castId] ??= emptyOcState());
      const list = state[change.aspect];
      if (change.op === 'add') {
        if (!list.some((item) => item.text === change.text))
          list.push({ text: change.text, nodeId: node.id });
      } else {
        state[change.aspect] = list.filter((item) => item.text !== change.text);
      }
    }

    for (const text of delta.events ?? [])
      events.push({ text, nodeId: node.id, depth: node.depth });
    for (const flag of delta.flags ?? []) flags[flag.key] = { value: flag.value, nodeId: node.id };
    for (const id of node.progress?.reachedMilestoneIds ?? []) {
      if (!reached.includes(id)) reached.push(id);
    }
  }

  const entries: EffectiveEntry[] = [];
  const pendingReveals: EffectiveEntry[] = [];
  for (const [key, entry] of byKey) {
    (pending.has(key) ? pendingReveals : entries).push(entry);
  }
  return {
    entries: sortEntries(entries),
    pendingReveals: sortEntries(pendingReveals),
    oc,
    flags,
    events,
    reachedMilestoneIds: reached,
    inactive,
    depthOf,
    lineAliases: Object.fromEntries(alias),
  };
}

// ---------------------------------------------------------------- 模型产出的解析与过滤（设计 §3.4）

/** 模型尾部 JSON 里 changes 的形状（stepSchema.ts 的 StepTailSchema.changes） */
export interface RawStepChanges {
  fieldChanges: { entry: string; field: string; value: string }[];
  newEntries: {
    category: string;
    title: string;
    summary: string;
    fields: { field: string; value: string }[];
  }[];
  statusChanges: { entry: string; status: EntryStatus; note: string }[];
  ocChanges: { aspect: OcAspect; op: 'add' | 'remove'; text: string }[];
  events: string[];
  flags: { key: string; value: string }[];
}

export interface DeltaContext {
  /** 父节点处的有效知识（新节点自己的差异还没算进去） */
  knowledge: EffectiveKnowledge;
  categories: readonly Category[];
  scenario: Pick<Scenario, 'setup'>;
  /** 本线新条目的 localId 由代码生成 */
  createId: () => string;
}

function isRuleCategory(category: Category | undefined): boolean {
  return category?.kind === 'worldbuilding';
}

/** 模型给的字段名：模板键或中文名都认 */
function resolveFieldKey(category: Category | undefined, field: string): string | undefined {
  const wanted = field.trim();
  const template = category?.fieldTemplate ?? [];
  return (
    template.find((item) => item.key === wanted)?.key ??
    template.find((item) => item.label.trim() === wanted)?.key
  );
}

/** 按 title ∪ aliases 规范化匹配；先找已登场的，再找预设 */
function findByName(knowledge: EffectiveKnowledge, name: string): EffectiveEntry | undefined {
  const wanted = normalizeEntryName(name);
  if (!wanted) return undefined;
  const hit = (entry: EffectiveEntry) =>
    [entry.title, ...entry.aliases].some((item) => normalizeEntryName(item) === wanted);
  return knowledge.entries.find(hit) ?? knowledge.pendingReveals.find(hit);
}

function isPending(knowledge: EffectiveKnowledge, entry: EffectiveEntry): boolean {
  return knowledge.pendingReveals.includes(entry);
}

function notice(kind: DeltaNotice['kind'], message: string): DeltaNotice {
  return { kind, message };
}

/**
 * 把模型产出的 changes 解析成差异（引用用名称 → 代码解析成 id），按「宁可少记」丢弃并提示：
 * 找不到的条目、模板外的字段、锁定字段、世界规则的死亡 / 被毁、重名新条目、对不上的分类。
 * 值与当前有效值相同的覆盖静默丢弃。引用了预设条目时照常处理并隐含一条「已登场」。
 * ocChanges 的 castId 一律填 cast[0].id（第一期只有一位主角）
 */
export function resolveStepChanges(
  raw: RawStepChanges,
  ctx: DeltaContext,
): { delta: WorldlineDelta; notices: DeltaNotice[] } {
  const { knowledge } = ctx;
  const categoryById = new Map(ctx.categories.map((category) => [category.id, category]));
  const delta: WorldlineDelta = {
    fieldOverrides: [],
    lineEntries: [],
    statusChanges: [],
    ocChanges: [],
    events: [],
    flags: [],
  };
  const notices: DeltaNotice[] = [];
  const revealed = new Set<string>();
  const reveal = (entry: EffectiveEntry) => {
    const key = refKey(entry.ref);
    if (!isPending(knowledge, entry) || revealed.has(key)) return;
    revealed.add(key);
    delta.statusChanges.push({ target: entry.ref, status: 'revealed', note: '' });
  };
  /** 一条字段覆盖：锁定丢弃并提示，同值静默丢弃 */
  const override = (target: EffectiveEntry, key: string, value: string): void => {
    const category = categoryById.get(target.categoryId);
    if (fieldMutability(category, target.entry, key) === 'locked') {
      notices.push(
        notice(
          'locked-field',
          `「${target.title}」的「${fieldLabel(category, key)}」是底层设定，本线不能改写，已丢弃`,
        ),
      );
      return;
    }
    if ((target.fields[key]?.value ?? '') === value) return;
    const existing = delta.fieldOverrides.find(
      (item) => refKey(item.target) === refKey(target.ref) && item.fieldKey === key,
    );
    if (existing) existing.value = value;
    else delta.fieldOverrides.push({ target: target.ref, fieldKey: key, value });
  };

  // 新条目先处理：同一步里对新条目的字段改写合进它自己的字段
  const created: { line: LineEntry; category: Category }[] = [];
  for (const item of raw.newEntries) {
    const title = item.title.trim();
    const category = ctx.categories.find((cat) => cat.name.trim() === item.category.trim());
    if (!category) {
      notices.push(
        notice('unknown-category', `分类「${item.category}」不存在，没有新建「${title}」`),
      );
      continue;
    }
    const existing = findByName(knowledge, title);
    if (existing && isPending(knowledge, existing)) {
      // 模型以为是新人物，其实是作者预设的登场人物：记登场，字段转成对它的覆盖
      reveal(existing);
      for (const field of item.fields) {
        const key = resolveFieldKey(categoryById.get(existing.categoryId), field.field);
        if (key) override(existing, key, field.value.trim());
      }
      notices.push(notice('duplicate-entry', `「${title}」是预设人物，已记为登场，没有重复新建`));
      continue;
    }
    if (
      existing ||
      created.some((other) => normalizeEntryName(other.line.title) === normalizeEntryName(title))
    ) {
      notices.push(notice('duplicate-entry', `已有同名条目「${title}」，没有重复新建`));
      continue;
    }
    const fields: Record<string, string> = {};
    for (const field of item.fields) {
      // 模板外的字段静默丢弃（与反向提取一致）
      const key = resolveFieldKey(category, field.field);
      if (key && field.value.trim()) fields[key] = field.value.trim();
    }
    const line: LineEntry = {
      localId: ctx.createId(),
      categoryId: category.id,
      title,
      summary: item.summary.trim().slice(0, 200),
      fields,
      promotedEntryId: null,
    };
    created.push({ line, category });
    delta.lineEntries.push(line);
  }

  for (const change of raw.fieldChanges) {
    const name = change.entry.trim();
    const value = change.value.trim();
    const fresh = created.find(
      (item) => normalizeEntryName(item.line.title) === normalizeEntryName(name),
    );
    if (fresh) {
      const key = resolveFieldKey(fresh.category, change.field);
      if (!key) {
        notices.push(
          notice('unknown-field', `「${fresh.line.title}」没有「${change.field}」这一栏，没有记下`),
        );
      } else if (value) {
        fresh.line.fields[key] = value;
      }
      continue;
    }
    const target = findByName(knowledge, name);
    if (!target) {
      notices.push(notice('unknown-entry', `找不到条目「${name}」，这条变化没有记下`));
      continue;
    }
    const key = resolveFieldKey(categoryById.get(target.categoryId), change.field);
    if (!key) {
      notices.push(
        notice('unknown-field', `「${target.title}」没有「${change.field}」这一栏，没有记下`),
      );
      continue;
    }
    reveal(target);
    override(target, key, value);
  }

  for (const change of raw.statusChanges) {
    const name = change.entry.trim();
    const target = findByName(knowledge, name);
    if (!target) {
      notices.push(notice('unknown-entry', `找不到条目「${name}」，这条变化没有记下`));
      continue;
    }
    if (change.status !== 'revealed' && isRuleCategory(categoryById.get(target.categoryId))) {
      notices.push(notice('rule-status', `「${target.title}」是世界规则，不会死亡或被毁`));
      continue;
    }
    if (change.status === 'revealed') {
      reveal(target);
      continue;
    }
    reveal(target);
    delta.statusChanges.push({
      target: target.ref,
      status: change.status,
      note: change.note.trim(),
    });
  }

  const castId = ctx.scenario.setup.cast[0]?.id;
  if (castId) {
    for (const change of raw.ocChanges) {
      const text = change.text.trim();
      if (text) delta.ocChanges.push({ castId, aspect: change.aspect, op: change.op, text });
    }
  }
  for (const event of raw.events) {
    if (event.trim()) delta.events.push(event.trim());
  }
  for (const flag of raw.flags) {
    if (flag.key.trim() && flag.value.trim())
      delta.flags.push({ key: flag.key.trim(), value: flag.value.trim() });
  }
  return { delta, notices };
}

/** 进展：模型报告的里程碑序号（M1、M2…）解析成 id；不存在或已达成的丢弃并提示 */
export function resolveStepProgress(
  raw: { reachedMilestones: number[]; note: string },
  ctx: Pick<DeltaContext, 'knowledge' | 'scenario'>,
): { progress: { reachedMilestoneIds: string[]; note: string }; notices: DeltaNotice[] } {
  const notices: DeltaNotice[] = [];
  const ids: string[] = [];
  for (const index of raw.reachedMilestones) {
    const milestone = ctx.scenario.setup.milestones[index - 1];
    if (!milestone) {
      notices.push(notice('unknown-milestone', `没有第 ${index} 个里程碑`));
      continue;
    }
    if (ctx.knowledge.reachedMilestoneIds.includes(milestone.id) || ids.includes(milestone.id)) {
      notices.push(notice('unknown-milestone', `里程碑 M${index} 已经达成过，没有重复记下`));
      continue;
    }
    ids.push(milestone.id);
  }
  return { progress: { reachedMilestoneIds: ids, note: raw.note.trim() }, notices };
}

/**
 * 结局：目标序号（G1、G2…）解析成 id。目标不存在，或目标类型与结局类型对不上时 goalId = null ——
 * kind 是情节实际写出来的结果，goal 是模型的归类，二者冲突时相信写出来的东西，并让作者看到
 */
export function resolveStepEnding(
  raw: { kind: ScenarioGoalKind; goal: number | null; title: string; cause: string } | null,
  ctx: Pick<DeltaContext, 'scenario'>,
): { ending: ScenarioEnding | null; notices: DeltaNotice[] } {
  if (!raw) return { ending: null, notices: [] };
  const notices: DeltaNotice[] = [];
  let goalId: string | null = null;
  if (raw.goal !== null) {
    const goal = ctx.scenario.setup.goals[raw.goal - 1];
    if (!goal) {
      notices.push(notice('unknown-goal', `没有第 ${raw.goal} 个结局目标`));
    } else if (goal.kind !== raw.kind) {
      notices.push(
        notice('unknown-goal', `结局类型与目标 G${raw.goal} 不一致，没有记为达成该目标`),
      );
    } else {
      goalId = goal.id;
    }
  }
  return {
    ending: { kind: raw.kind, goalId, title: raw.title.trim(), cause: raw.cause.trim() },
    notices,
  };
}

/**
 * 对已解析的差异做同一套检查（引用、字段、锁定、规则状态），给仓储写入与手动编辑用。
 * knowledge 是这一步父节点处的有效知识；nodeId 是这一步自己的 id —— 差异里允许引用本步新建的本线条目。
 * 返回过滤后的差异与提示；手动编辑时有任何提示，仓储就把第一条作为错误抛出、什么都不写
 */
export function sanitizeDelta(
  delta: WorldlineDelta,
  ctx: { knowledge: EffectiveKnowledge; categories: readonly Category[]; nodeId?: string },
): { delta: WorldlineDelta; notices: DeltaNotice[] } {
  const { knowledge } = ctx;
  const categoryById = new Map(ctx.categories.map((category) => [category.id, category]));
  const notices: DeltaNotice[] = [];
  const known = new Map<string, EffectiveEntry>();
  for (const entry of [...knowledge.entries, ...knowledge.pendingReveals])
    known.set(refKey(entry.ref), entry);

  const lineEntries: LineEntry[] = [];
  for (const line of delta.lineEntries ?? []) {
    const category = categoryById.get(line.categoryId);
    if (!category) {
      notices.push(notice('unknown-category', `分类不存在，没有新建「${line.title}」`));
      continue;
    }
    const clash = [...known.values()].some((entry) =>
      [entry.title, ...entry.aliases].some(
        (name) => normalizeEntryName(name) === normalizeEntryName(line.title),
      ),
    );
    if (
      clash ||
      lineEntries.some(
        (other) => normalizeEntryName(other.title) === normalizeEntryName(line.title),
      )
    ) {
      notices.push(notice('duplicate-entry', `已有同名条目「${line.title}」，没有重复新建`));
      continue;
    }
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(line.fields ?? {})) {
      if (category.fieldTemplate.some((field) => field.key === key)) fields[key] = value;
    }
    lineEntries.push({ ...line, fields });
  }

  // 本步新建的本线条目也能被本步引用（手动编辑时）
  const own = new Map<string, EffectiveEntry>();
  if (ctx.nodeId) {
    for (const line of lineEntries) {
      const ref: EntryRef = { kind: 'line', nodeId: ctx.nodeId, localId: line.localId };
      own.set(refKey(ref), {
        ref,
        origin: 'line',
        title: line.title,
        aliases: [],
        summary: line.summary,
        categoryId: line.categoryId,
        entry: undefined,
        lineNodeId: ctx.nodeId,
        fields: Object.fromEntries(
          Object.entries(line.fields).map(([k, v]) => [k, { value: v, source: ctx.nodeId! }]),
        ),
        status: null,
        revealHint: '',
      });
    }
  }
  /** 引用解析：别名（已提升的本线条目）落到世界观条目上 */
  const lookup = (ref: EntryRef): EffectiveEntry | undefined => {
    const key = refKey(ref);
    const resolved = knowledge.lineAliases[key] ?? key;
    return known.get(resolved) ?? own.get(resolved);
  };

  const fieldOverrides: WorldlineDelta['fieldOverrides'] = [];
  for (const item of delta.fieldOverrides ?? []) {
    const target = lookup(item.target);
    if (!target) {
      notices.push(notice('unknown-entry', '找不到要改写的条目，这条变化没有记下'));
      continue;
    }
    const category = categoryById.get(target.categoryId);
    if (!category?.fieldTemplate.some((field) => field.key === item.fieldKey)) {
      notices.push(
        notice('unknown-field', `「${target.title}」没有「${item.fieldKey}」这一栏，没有记下`),
      );
      continue;
    }
    if (fieldMutability(category, target.entry, item.fieldKey) === 'locked') {
      notices.push(
        notice(
          'locked-field',
          `「${target.title}」的「${fieldLabel(category, item.fieldKey)}」是底层设定，本线不能改写，已丢弃`,
        ),
      );
      continue;
    }
    fieldOverrides.push(item);
  }

  const statusChanges: WorldlineDelta['statusChanges'] = [];
  for (const item of delta.statusChanges ?? []) {
    const target = lookup(item.target);
    if (!target) {
      notices.push(notice('unknown-entry', '找不到状态变化指向的条目，这条变化没有记下'));
      continue;
    }
    if (item.status !== 'revealed' && isRuleCategory(categoryById.get(target.categoryId))) {
      notices.push(notice('rule-status', `「${target.title}」是世界规则，不会死亡或被毁`));
      continue;
    }
    statusChanges.push(item);
  }

  return {
    delta: {
      fieldOverrides,
      lineEntries,
      statusChanges,
      ocChanges: [...(delta.ocChanges ?? [])],
      events: [...(delta.events ?? [])],
      flags: [...(delta.flags ?? [])],
    },
    notices,
  };
}

// ---------------------------------------------------------------- 渲染

/**
 * 推演提示词里的一条设定：与构建器 renderEntry 同格式，锁定字段的标签后加「（底层，不可改变）」。
 * 只渲染世界观原文 —— 世界线改写只出现在【本线变化】里，同一推演的前缀因此与分支无关、能共享缓存
 */
export function renderScenarioEntry(
  entry: Pick<KnowledgeEntry, 'title' | 'aliases' | 'summary' | 'fields'>,
  category: Category | undefined,
  lockOf: (key: string) => FieldMutability,
): string {
  const lines = [`## ${entry.title}（${category?.name ?? '设定'}）`];
  if (entry.aliases.length > 0) lines.push(`别名：${entry.aliases.join('、')}`);
  if (entry.summary.trim()) lines.push(entry.summary.trim());
  for (const field of category?.fieldTemplate ?? []) {
    const value = (entry.fields[field.key] ?? '').trim();
    if (!value) continue;
    lines.push(`${field.label}${lockOf(field.key) === 'locked' ? LOCKED_MARK : ''}：${value}`);
  }
  return lines.join('\n');
}

/** 本线变化里最多带的事件条数（最近的优先） */
export const WORLDLINE_RECENT_EVENTS = 10;

function stepLabel(knowledge: EffectiveKnowledge, nodeId: string): string {
  const depth = knowledge.depthOf[nodeId];
  return depth === undefined ? '' : `（第 ${depth + 1} 步）`;
}

/**
 * 【本线变化】块：设定改写、本线新条目（全文）、状态、主角状态、标记、最近的事件。
 * 推演每一步的用户提示与沉淀后「写这一章」共用。逐字节可复现：条目按 title 码元序 + 引用键排序、
 * 字段按模板顺序、标记按键排序，与输入顺序无关。没有任何变化时返回空串（composeSections 会跳过）
 */
export function renderWorldlineState(
  knowledge: EffectiveKnowledge,
  categories: readonly Category[],
  castNames: Record<string, string> = {},
): string {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const blocks: string[] = [];

  const rewrites: string[] = [];
  for (const entry of knowledge.entries) {
    if (entry.origin === 'line') continue;
    const category = categoryById.get(entry.categoryId);
    const keys = Object.keys(entry.fields)
      .filter((key) => entry.fields[key]!.source !== 'world')
      .sort((a, b) => templateIndex(category, a) - templateIndex(category, b) || compareText(a, b));
    for (const key of keys) {
      const field = entry.fields[key]!;
      rewrites.push(
        `- ${entry.title} · ${fieldLabel(category, key)}：${field.value}${stepLabel(knowledge, field.source)}`,
      );
    }
  }
  if (rewrites.length > 0) blocks.push(['设定改写：', ...rewrites].join('\n'));

  const lines = knowledge.entries.filter((entry) => entry.origin === 'line');
  if (lines.length > 0) {
    blocks.push(
      [
        '本线新出现：',
        lines
          .map((entry) => {
            const category = categoryById.get(entry.categoryId);
            const values: Record<string, string> = {};
            for (const [key, field] of Object.entries(entry.fields)) values[key] = field.value;
            const text = renderScenarioEntry(
              { title: entry.title, aliases: [], summary: entry.summary, fields: values },
              category,
              (key) => fieldMutability(category, undefined, key),
            );
            return `${text}\n（第 ${(knowledge.depthOf[entry.lineNodeId ?? ''] ?? 0) + 1} 步出现）`;
          })
          .join('\n\n'),
      ].join('\n'),
    );
  }

  const statuses = knowledge.entries
    .filter((entry) => entry.status !== null)
    .map((entry) => {
      const status = entry.status!;
      const note = status.note.trim() ? `：${status.note.trim()}` : '';
      return `- ${entry.title}：${ENTRY_STATUS_LABELS[status.value]}${note}${stepLabel(knowledge, status.nodeId)}`;
    });
  if (statuses.length > 0) blocks.push(['状态：', ...statuses].join('\n'));

  const ocLines: string[] = [];
  for (const castId of Object.keys(knowledge.oc).sort(compareText)) {
    const state = knowledge.oc[castId]!;
    const name = castNames[castId];
    for (const aspect of OC_ASPECT_ORDER) {
      const items = state[aspect];
      if (items.length === 0) continue;
      ocLines.push(
        `- ${name ? `${name} · ` : ''}${OC_ASPECT_LABELS[aspect]}：${items.map((item) => item.text).join('；')}`,
      );
    }
  }
  if (ocLines.length > 0) blocks.push(['主角状态：', ...ocLines].join('\n'));

  const flagKeys = Object.keys(knowledge.flags).sort(compareText);
  if (flagKeys.length > 0) {
    blocks.push(
      ['标记：', ...flagKeys.map((key) => `- ${key}：${knowledge.flags[key]!.value}`)].join('\n'),
    );
  }

  const recent = knowledge.events.slice(-WORLDLINE_RECENT_EVENTS);
  if (recent.length > 0) {
    blocks.push(
      ['最近的事件：', ...recent.map((event) => `- 第 ${event.depth + 1} 步 · ${event.text}`)].join(
        '\n',
      ),
    );
  }

  if (blocks.length === 0) return '';
  return ['【本线变化（与上文设定冲突时以这里为准，底层字段除外）】', ...blocks].join('\n\n');
}

function templateIndex(category: Category | undefined, key: string): number {
  const index = category?.fieldTemplate.findIndex((field) => field.key === key) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

// ---------------------------------------------------------------- 推断条目

/**
 * 一段文字里提到的有效条目。复用构建器同一个 mentionedEntries（不复制一份匹配规则）：
 * 本线新条目先包成同形状的临时对象再传，命中后映射回有效条目
 */
export function mentionedEffectiveEntries(
  text: string,
  candidates: readonly EffectiveEntry[],
): EffectiveEntry[] {
  const shaped = candidates.map(
    (entry, index) =>
      ({
        id: String(index),
        title: entry.title,
        aliases: entry.aliases,
      }) as unknown as KnowledgeEntry,
  );
  return mentionedEntries(text, shaped).map((hit) => candidates[Number(hit.id)]!);
}
