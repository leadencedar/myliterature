/**
 * 互动推演的树与路径：主线、已走过、行动等价判定、前情检查点、沉淀范围、开局校验。
 *
 * 树（ScenarioNode 按 parentId 连成）是唯一事实源：主线、外传线、「已走过」都从树上现算，不另存 ——
 * 存一个 walked 布尔会和树漂移（例如合并导入只带来了子节点）。
 *
 * 对 schema.ts 只用 `import type`：schema.ts 的备份校验要在运行时用 normalizeAction 与这里的长度 / 文案常量，
 * 反向的运行时引用会形成循环依赖（与 schema.ts 对 importJob.ts 的既有做法一致）。
 */
import type {
  ArrivedBy,
  Chapter,
  OutlineNode,
  Scenario,
  ScenarioGoalKind,
  ScenarioNode,
  SideStory,
} from './schema';

// ---------------------------------------------------------------- 长度与文案（schema.ts 共用）

/**
 * 开局设定与自由输入的上限与文案。schema.ts 用同一份常量建 Zod 规则，
 * UI 预检（validateScenarioSetup / validateFreeAction）与仓储兜底因此永远一致
 */
export const SCENARIO_LIMITS = {
  title: 40,
  ocTitle: 120,
  ocField: 2000,
  time: 100,
  place: 100,
  situation: 500,
  goals: 6,
  goalDescription: 200,
  milestones: 8,
  milestoneDescription: 200,
  tone: 200,
  minSteps: 5,
  maxSteps: 200,
  defaultSteps: 30,
  freeAction: 200,
  wrapUpNote: 200,
} as const;

export const SCENARIO_MESSAGES = {
  titleRequired: '推演名称不能为空',
  titleTooLong: `推演名称不能超过 ${SCENARIO_LIMITS.title} 字`,
  protagonistRequired: '请选择或新建一位主角',
  ocTitleRequired: '主角名称不能为空',
  ocTitleTooLong: `主角名称不能超过 ${SCENARIO_LIMITS.ocTitle} 字`,
  ocFieldTooLong: (label: string) => `主角的「${label}」不能超过 ${SCENARIO_LIMITS.ocField} 字`,
  situationRequired: '请写出主角的处境',
  situationTooLong: `处境不能超过 ${SCENARIO_LIMITS.situation} 字`,
  timeTooLong: `时间不能超过 ${SCENARIO_LIMITS.time} 字`,
  placeTooLong: `地点不能超过 ${SCENARIO_LIMITS.place} 字`,
  goalsRequired: '至少设定一个结局目标',
  goalsTooMany: `结局目标最多 ${SCENARIO_LIMITS.goals} 个`,
  goalDescriptionRequired: '结局目标的描述不能为空',
  goalDescriptionTooLong: `结局目标的描述不能超过 ${SCENARIO_LIMITS.goalDescription} 字`,
  milestonesTooMany: `里程碑最多 ${SCENARIO_LIMITS.milestones} 个`,
  milestoneRequired: '里程碑不能为空',
  milestoneTooLong: `里程碑不能超过 ${SCENARIO_LIMITS.milestoneDescription} 字`,
  toneTooLong: `基调不能超过 ${SCENARIO_LIMITS.tone} 字`,
  freeActionRequired: '请写下主角要做的事',
  freeActionTooLong: `一次只写一个行动，不能超过 ${SCENARIO_LIMITS.freeAction} 字`,
} as const;

// ---------------------------------------------------------------- 树与路径

/** 同一父节点下的子节点，按 createdAt、id 排序（码元序，不用 localeCompare：顺序不随区域设置变化） */
export function childrenOf(nodes: readonly ScenarioNode[], parentId: string): ScenarioNode[] {
  return nodes.filter((node) => node.parentId === parentId).sort(compareByCreation);
}

function compareByCreation(a: ScenarioNode, b: ScenarioNode): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 根节点（parentId 为 null）。每个推演至多一个，由仓储与备份校验保证 */
export function rootOf(nodes: readonly ScenarioNode[]): ScenarioNode | undefined {
  return nodes.find((node) => node.parentId === null);
}

/**
 * 根 → nodeId 的路径（含两端）。节点不存在或链条断了（父节点缺失）时返回 []：
 * 半截路径会让后续的有效知识与提示词悄悄缺前情，宁可让调用方看到「没有路径」
 */
export function pathTo(nodes: readonly ScenarioNode[], nodeId: string | null): ScenarioNode[] {
  if (nodeId === null) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: ScenarioNode[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(nodeId);
  while (cursor) {
    if (seen.has(cursor.id)) return [];
    seen.add(cursor.id);
    path.unshift(cursor);
    if (cursor.parentId === null) return path;
    cursor = byId.get(cursor.parentId);
  }
  return [];
}

/** 主线 = 根到 mainNodeId 的路径 */
export function mainPath(
  scenario: Pick<Scenario, 'mainNodeId'>,
  nodes: readonly ScenarioNode[],
): ScenarioNode[] {
  return pathTo(nodes, scenario.mainNodeId);
}

export function isOnMainPath(
  scenario: Pick<Scenario, 'mainNodeId'>,
  nodes: readonly ScenarioNode[],
  nodeId: string,
): boolean {
  return mainPath(scenario, nodes).some((node) => node.id === nodeId);
}

/** 某节点及其全部后代 */
export function subtreeOf(nodes: readonly ScenarioNode[], rootId: string): ScenarioNode[] {
  const byParent = new Map<string, ScenarioNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const root = nodes.find((node) => node.id === rootId);
  if (!root) return [];
  const out: ScenarioNode[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
    stack.push(...(byParent.get(node.id) ?? []));
  }
  return out;
}

/**
 * 子树里「最新的一步」：depth 最大，其次 createdAt 最大，再按 id 码元序取最大。
 * 不只按 createdAt：合并导入另一台设备的备份后两边时钟可能不一致（同设计 D1.1）
 */
export function latestLeafOf(
  nodes: readonly ScenarioNode[],
  rootId: string,
): ScenarioNode | undefined {
  let best: ScenarioNode | undefined;
  for (const node of subtreeOf(nodes, rootId)) {
    if (!best) {
      best = node;
      continue;
    }
    if (node.depth !== best.depth) {
      if (node.depth > best.depth) best = node;
      continue;
    }
    if (node.createdAt !== best.createdAt) {
      if (node.createdAt > best.createdAt) best = node;
      continue;
    }
    if (node.id > best.id) best = node;
  }
  return best;
}

/**
 * 外传的分叉点：这条路径与主线路径最深的公共节点。根节点总是公共的；
 * 任一路径为空时返回 null
 */
export function forkNodeOf(
  path: readonly ScenarioNode[],
  main: readonly ScenarioNode[],
): string | null {
  let fork: string | null = null;
  for (let i = 0; i < Math.min(path.length, main.length); i += 1) {
    if (path[i]!.id !== main[i]!.id) break;
    fork = path[i]!.id;
  }
  return fork;
}

// ---------------------------------------------------------------- 行动的等价判定

const TRAILING_PUNCTUATION = /[。．.！!？?…~～]+$/u;

/**
 * 自由输入与选项的比较口径：NFKC → 去掉全部空白 → 去掉末尾的句末标点。
 * 只做这一档「确定相同」的判定；更模糊的相似只提醒、不阻止（作者是作者，误阻比误放糟）
 */
export function normalizeAction(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '').replace(TRAILING_PUNCTUATION, '');
}

/** 相似度 ≥ 它时提示「和已走过的『…』很像」，按钮变成「仍然这样做」 */
export const ACTION_SIMILARITY_THRESHOLD = 0.8;

function bigrams(text: string): Map<string, number> {
  const chars = [...text];
  const counts = new Map<string, number>();
  for (let i = 0; i < chars.length - 1; i += 1) {
    const gram = chars[i]! + chars[i + 1]!;
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * 字符二元组的 Dice 系数（0–1），在规范化之后比较。本地计算、不发请求：
 * 每次自由输入都多一次 AI 判定，钱与延迟正好打在游戏节奏最敏感的地方
 */
export function actionSimilarity(a: string, b: string): number {
  const left = normalizeAction(a);
  const right = normalizeAction(b);
  if (left === right) return left.length > 0 ? 1 : 0;
  const x = bigrams(left);
  const y = bigrams(right);
  let total = 0;
  for (const count of x.values()) total += count;
  for (const count of y.values()) total += count;
  if (total === 0) return 0;
  let shared = 0;
  for (const [gram, count] of x) shared += Math.min(count, y.get(gram) ?? 0);
  return (2 * shared) / total;
}

/**
 * 一次到达方式的去重键：同一节点下每个选项、每个规范化后的自由输入、收尾各自最多一个子节点。
 * 仓储的事务检查与备份 superRefine 规则 10 共用它
 */
export function arrivalKey(arrivedBy: ArrivedBy): string {
  switch (arrivedBy.kind) {
    case 'start':
      return 'start';
    case 'option':
      return `option:${arrivedBy.optionId}`;
    case 'free':
      return `free:${normalizeAction(arrivedBy.text)}`;
    case 'wrap-up':
      return 'wrap-up';
  }
}

export interface WalkedChoices {
  /** optionId → 走这个选项产生的子节点 */
  options: Map<string, ScenarioNode>;
  /** 走过的自由输入（原文 + 规范化键 + 子节点），按子节点创建顺序 */
  free: { text: string; key: string; child: ScenarioNode }[];
  /** 已收尾时的结局节点 */
  wrapUp: ScenarioNode | null;
}

/** 节点上「已走过」的选择，从子节点现算（不存标记，见文件头） */
export function walkedChoices(
  node: ScenarioNode,
  children: readonly ScenarioNode[],
): WalkedChoices {
  const walked: WalkedChoices = { options: new Map(), free: [], wrapUp: null };
  for (const child of [...children].sort(compareByCreation)) {
    if (child.parentId !== node.id) continue;
    const by = child.arrivedBy;
    if (by.kind === 'option') {
      if (!walked.options.has(by.optionId)) walked.options.set(by.optionId, child);
    } else if (by.kind === 'free') {
      walked.free.push({ text: by.text, key: normalizeAction(by.text), child });
    } else if (by.kind === 'wrap-up') {
      walked.wrapUp ??= child;
    }
  }
  return walked;
}

// ---------------------------------------------------------------- 前情检查点（设计 D5.3）

/** 每 5 步一个检查点：depth 4、9、14…（第 5、10、15… 步） */
export const CHECKPOINT_INTERVAL = 5;
/** 完整原文注入的最近步数 */
export const RECENT_STEPS = 3;
/** gap 超过它时同步补摘要；否则后台补、本步照常生成 */
export const MAX_CONTEXT_GAP = 7;

export function isCheckpoint(node: Pick<ScenarioNode, 'depth'>): boolean {
  return node.depth % CHECKPOINT_INTERVAL === CHECKPOINT_INTERVAL - 1;
}

/**
 * 需要补摘要的检查点：路径上 depth ≤ parentDepth、是检查点、还没有摘要的节点，按 depth 升序。
 * 必须按顺序补：前一个补好后才是后一个的「上一段前情」，单次输入因此最多 5 步原文
 */
export function checkpointsToFill(
  path: readonly ScenarioNode[],
  parentDepth: number,
): ScenarioNode[] {
  return path
    .filter((node) => node.depth <= parentDepth && isCheckpoint(node) && node.pathSummary === null)
    .sort((a, b) => a.depth - b.depth);
}

/**
 * 检查点 K 的摘要输入：K 之前最近的、已有摘要的祖先 A 的摘要（没有 A 时为 null，提示词写「从开局写起」），
 * 加 A 之后到 K（含 K）的全部步骤
 */
export function checkpointSegment(
  path: readonly ScenarioNode[],
  checkpointId: string,
): { previous: { text: string; openThreads: string[] } | null; steps: ScenarioNode[] } {
  const at = path.findIndex((node) => node.id === checkpointId);
  if (at < 0) return { previous: null, steps: [] };
  let from = 0;
  let previous: { text: string; openThreads: string[] } | null = null;
  for (let i = at - 1; i >= 0; i -= 1) {
    const summary = path[i]!.pathSummary;
    if (summary) {
      previous = { text: summary.text, openThreads: [...summary.openThreads] };
      from = i + 1;
      break;
    }
  }
  return { previous, steps: path.slice(from, at + 1) };
}

/**
 * 组上下文时的三段：recent = 最后 RECENT_STEPS 个节点；checkpoint = 深度小于 recent[0] 的
 * 最深的有摘要祖先；gap = checkpoint 与 recent 之间的节点（用简写原文补上，正常 ≤ 4 步）。
 * path 以「这一步的父节点」结尾
 */
export function contextGap(path: readonly ScenarioNode[]): {
  recent: ScenarioNode[];
  checkpoint: ScenarioNode | null;
  gap: ScenarioNode[];
} {
  const recentStart = Math.max(0, path.length - RECENT_STEPS);
  const recent = path.slice(recentStart);
  let checkpointAt = -1;
  for (let i = recentStart - 1; i >= 0; i -= 1) {
    if (path[i]!.pathSummary) {
      checkpointAt = i;
      break;
    }
  }
  return {
    recent,
    checkpoint: checkpointAt >= 0 ? path[checkpointAt]! : null,
    gap: path.slice(checkpointAt + 1, recentStart),
  };
}

// ---------------------------------------------------------------- 沉淀（设计 D7.4 / §7.2）

/** 一段要沉淀的连续步骤。from / to 是绝对步数（= depth + 1），与推演页「第 k 步」同一编号 */
export interface SedimentSpan {
  from: number;
  to: number;
  nodeIds: string[];
}

function spanOf(nodes: readonly ScenarioNode[]): SedimentSpan | null {
  if (nodes.length === 0) return null;
  return {
    from: nodes[0]!.depth + 1,
    to: nodes[nodes.length - 1]!.depth + 1,
    nodeIds: nodes.map((node) => node.id),
  };
}

/**
 * 本推演的主线沉淀覆盖情况。只看 scenarioSource 非空的大纲节点（章级；卷为 null）：
 * nodeIds 不全在当前主线上的是「来自旧主线」（stale），其余的步骤算已覆盖。
 * 判定现算、不存标记：主线换了，标记自然跟着变
 */
export function sedimentCoverage(input: {
  scenario: Pick<Scenario, 'id' | 'mainNodeId'>;
  nodes: readonly ScenarioNode[];
  outline: readonly OutlineNode[];
}): { covered: Set<string>; stale: OutlineNode[] } {
  const onMain = new Set(mainPath(input.scenario, input.nodes).map((node) => node.id));
  const covered = new Set<string>();
  const stale: OutlineNode[] = [];
  for (const node of input.outline) {
    const source = node.scenarioSource ?? null;
    if (!source || source.scenarioId !== input.scenario.id) continue;
    if (source.nodeIds.every((id) => onMain.has(id))) {
      for (const id of source.nodeIds) covered.add(id);
    } else {
      stale.push(node);
    }
  }
  return { covered, stale };
}

/**
 * 外传「最后一章」的最后一步 L（design-addendum 第 3 条）：按 index 排列后，最后一个 scenarioSource
 * 非空且属于本推演的章节，取其 nodeIds 末项。末尾是手写章节、或合并清理后溯源被清空时跳过它们；
 * 一章带溯源的都没有时返回 null —— 这部外传不参与「追加」判定
 */
export function lastSedimentedNodeOf(
  sideStoryId: string,
  scenarioId: string,
  chapters: readonly Chapter[],
): string | null {
  const own = chapters
    .filter((chapter) => chapter.sideStoryId === sideStoryId)
    .sort((a, b) => a.index - b.index);
  for (let i = own.length - 1; i >= 0; i -= 1) {
    const source = own[i]!.scenarioSource ?? null;
    if (source && source.scenarioId === scenarioId && source.nodeIds.length > 0) {
      return source.nodeIds[source.nodeIds.length - 1]!;
    }
  }
  return null;
}

export type SedimentRange =
  | {
      mode: 'main';
      /** null = 这条线已经全部沉淀 */
      span: SedimentSpan | null;
      /** span 没有延伸到当前节点 = 补主线大纲中间的洞 */
      fillsHole: boolean;
    }
  | {
      mode: 'side';
      forkNodeId: string;
      /** 另建一部外传：分叉点之后到当前节点 */
      span: SedimentSpan | null;
      /** 可以追加到的外传（默认选项）；没有时为 null */
      append: { sideStoryId: string; span: SedimentSpan } | null;
    };

/**
 * 沉淀范围（设计 §7.2 第 2 步）。模式由位置决定：当前节点在主线上 → 主线，否则 → 外传。
 *
 * 主线：a = 路径上第一个未被（非过期的）章级大纲节点覆盖的步骤，b = a 之后第一个已覆盖步骤的前一步，
 * 没有这样的步骤时 b = 当前节点。一次只补一个连续的洞，每次的提案都是一段连续步骤。
 *
 * 外传：可追加的外传《X》满足 scenarioSource 指向本推演、且当前节点在 L 的子树里（L 本身不算）。
 * 不比较 forkNodeId：分叉点相对「沉淀时的主线」算，主线一换就变，用它判定会让「追加」无故消失。
 * 多部满足时取 L 最深的，同深按外传 createdAt、id 兜底（都取最大）
 */
export function sedimentRange(input: {
  scenario: Pick<Scenario, 'id' | 'mainNodeId'>;
  nodes: readonly ScenarioNode[];
  currentNodeId: string;
  outline: readonly OutlineNode[];
  sideStories: readonly SideStory[];
  chapters: readonly Chapter[];
}): SedimentRange | null {
  const path = pathTo(input.nodes, input.currentNodeId);
  if (path.length === 0) return null;
  const main = mainPath(input.scenario, input.nodes);
  const onMain = main.some((node) => node.id === input.currentNodeId);

  if (onMain) {
    const { covered } = sedimentCoverage(input);
    const a = path.findIndex((node) => !covered.has(node.id));
    if (a < 0) return { mode: 'main', span: null, fillsHole: false };
    let b = path.length - 1;
    for (let i = a + 1; i < path.length; i += 1) {
      if (covered.has(path[i]!.id)) {
        b = i - 1;
        break;
      }
    }
    return { mode: 'main', span: spanOf(path.slice(a, b + 1)), fillsHole: b < path.length - 1 };
  }

  const forkNodeId = forkNodeOf(path, main) ?? path[0]!.id;
  const forkAt = path.findIndex((node) => node.id === forkNodeId);
  const pathIndex = new Map(path.map((node, i) => [node.id, i]));
  let append: { story: SideStory; at: number } | null = null;
  for (const story of input.sideStories) {
    if (story.scenarioSource?.scenarioId !== input.scenario.id) continue;
    const last = lastSedimentedNodeOf(story.id, input.scenario.id, input.chapters);
    if (last === null) continue;
    const at = pathIndex.get(last);
    // 当前节点必须在 L 的子树里，且不是 L 本身
    if (at === undefined || at >= path.length - 1) continue;
    if (
      !append ||
      at > append.at ||
      (at === append.at &&
        (story.createdAt > append.story.createdAt ||
          (story.createdAt === append.story.createdAt && story.id > append.story.id)))
    ) {
      append = { story, at };
    }
  }
  return {
    mode: 'side',
    forkNodeId,
    span: spanOf(path.slice(forkAt + 1)),
    append: append
      ? { sideStoryId: append.story.id, span: spanOf(path.slice(append.at + 1))! }
      : null,
  };
}

/**
 * 这次要沉淀进主线的步骤里，哪些已经沉淀进了本推演的外传（设计 §11「一段路径已沉淀为外传后又成了主线」）。
 * 只用来提示作者「其中第 a–b 步已沉淀为外传《X》」，不拦沉淀：要不要保留那部外传由作者决定。
 * 按外传的章节溯源现算（只看本推演的、未被清空的），返回各外传与重叠步骤的首尾步数；顺序同 sideStories
 */
export function sideSedimentOverlaps(input: {
  scenarioId: string;
  span: SedimentSpan;
  nodes: readonly ScenarioNode[];
  sideStories: readonly SideStory[];
  chapters: readonly Chapter[];
}): { sideStory: SideStory; from: number; to: number }[] {
  const inSpan = new Set(input.span.nodeIds);
  const depthOf = new Map(input.nodes.map((node) => [node.id, node.depth]));
  const out: { sideStory: SideStory; from: number; to: number }[] = [];
  for (const story of input.sideStories) {
    const depths: number[] = [];
    for (const chapter of input.chapters) {
      if (chapter.sideStoryId !== story.id) continue;
      const source = chapter.scenarioSource ?? null;
      if (!source || source.scenarioId !== input.scenarioId) continue;
      for (const id of source.nodeIds) {
        const depth = depthOf.get(id);
        if (inSpan.has(id) && depth !== undefined) depths.push(depth);
      }
    }
    if (depths.length === 0) continue;
    out.push({ sideStory: story, from: Math.min(...depths) + 1, to: Math.max(...depths) + 1 });
  }
  return out;
}

/**
 * 沉淀提案采用时交给仓储的落库计划（纯数据，仓储接口与 pathOutline.ts 共用）。
 * 主线：卷 / 章追加在大纲树顶层末尾，章级节点带溯源；外传：新建外传或追加到已有外传，逐章带细纲
 */
export type ScenarioOutlinePlan =
  | {
      scenarioId: string;
      mode: 'main';
      volumes: {
        title: string;
        synopsis: string;
        targetWords: number | null;
        chapters: {
          title: string;
          synopsis: string;
          targetWords: number | null;
          linkedEntryIds: string[];
          nodeIds: string[];
        }[];
      }[];
    }
  | {
      scenarioId: string;
      mode: 'side';
      /** 非空 = 追加到这部外传：不改它的名称、简介与 forkNodeId */
      appendToSideStoryId: string | null;
      title: string;
      synopsis: string;
      forkNodeId: string;
      chapters: { title: string; nodeIds: string[]; brief: string }[];
    };

// ---------------------------------------------------------------- 开局与自由输入的预检

/** 开局面板的草稿。主角二选一：已有人物条目，或新建（名称必填，其余选填） */
export interface ScenarioSetupDraft {
  title: string;
  protagonist:
    | { kind: 'existing'; entryId: string }
    | { kind: 'new'; title: string; fields: { label: string; value: string }[] }
    | null;
  start: { time: string; place: string; situation: string };
  goals: { kind: ScenarioGoalKind; description: string }[];
  milestones: { description: string }[];
  tone: string;
}

/** 预计步数超界时钳到边界，非整数取整；不是数字时用默认值 */
export function clampExpectedSteps(value: number): number {
  if (!Number.isFinite(value)) return SCENARIO_LIMITS.defaultSteps;
  return Math.min(SCENARIO_LIMITS.maxSteps, Math.max(SCENARIO_LIMITS.minSteps, Math.round(value)));
}

/**
 * 开局设定的预检，返回第一条中文错误；合法时返回 undefined。
 * 规则与文案和 schema 共用 SCENARIO_LIMITS / SCENARIO_MESSAGES，不把 ZodError 的 JSON 显示给作者
 */
export function validateScenarioSetup(draft: ScenarioSetupDraft): string | undefined {
  const title = draft.title.trim();
  if (!title) return SCENARIO_MESSAGES.titleRequired;
  if (title.length > SCENARIO_LIMITS.title) return SCENARIO_MESSAGES.titleTooLong;

  const protagonist = draft.protagonist;
  if (!protagonist) return SCENARIO_MESSAGES.protagonistRequired;
  if (protagonist.kind === 'existing') {
    if (!protagonist.entryId) return SCENARIO_MESSAGES.protagonistRequired;
  } else {
    const ocTitle = protagonist.title.trim();
    if (!ocTitle) return SCENARIO_MESSAGES.ocTitleRequired;
    if (ocTitle.length > SCENARIO_LIMITS.ocTitle) return SCENARIO_MESSAGES.ocTitleTooLong;
    for (const field of protagonist.fields) {
      if (field.value.trim().length > SCENARIO_LIMITS.ocField) {
        return SCENARIO_MESSAGES.ocFieldTooLong(field.label);
      }
    }
  }

  const situation = draft.start.situation.trim();
  if (!situation) return SCENARIO_MESSAGES.situationRequired;
  if (situation.length > SCENARIO_LIMITS.situation) return SCENARIO_MESSAGES.situationTooLong;
  if (draft.start.time.trim().length > SCENARIO_LIMITS.time) return SCENARIO_MESSAGES.timeTooLong;
  if (draft.start.place.trim().length > SCENARIO_LIMITS.place)
    return SCENARIO_MESSAGES.placeTooLong;

  if (draft.goals.length < 1) return SCENARIO_MESSAGES.goalsRequired;
  if (draft.goals.length > SCENARIO_LIMITS.goals) return SCENARIO_MESSAGES.goalsTooMany;
  for (const goal of draft.goals) {
    const text = goal.description.trim();
    if (!text) return SCENARIO_MESSAGES.goalDescriptionRequired;
    if (text.length > SCENARIO_LIMITS.goalDescription)
      return SCENARIO_MESSAGES.goalDescriptionTooLong;
  }

  if (draft.milestones.length > SCENARIO_LIMITS.milestones)
    return SCENARIO_MESSAGES.milestonesTooMany;
  for (const milestone of draft.milestones) {
    const text = milestone.description.trim();
    if (!text) return SCENARIO_MESSAGES.milestoneRequired;
    if (text.length > SCENARIO_LIMITS.milestoneDescription)
      return SCENARIO_MESSAGES.milestoneTooLong;
  }

  if (draft.tone.trim().length > SCENARIO_LIMITS.tone) return SCENARIO_MESSAGES.toneTooLong;
  return undefined;
}

/** 自由输入的预检：必填、≤ 200 字（一个行动，不是一段剧情） */
export function validateFreeAction(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return SCENARIO_MESSAGES.freeActionRequired;
  if (trimmed.length > SCENARIO_LIMITS.freeAction) return SCENARIO_MESSAGES.freeActionTooLong;
  return undefined;
}
