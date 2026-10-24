import { MAX_INFERRED_ENTRIES, type ScenarioChapterContext } from '@/context/ContextBuilder';
import { pathTo } from '@/domain/scenario';
import type { Category, KnowledgeEntry, Scenario, ScenarioNode } from '@/domain/schema';
import {
  effectiveKnowledge,
  fieldMutability,
  mentionedEffectiveEntries,
  refKey,
  renderScenarioEntry,
  renderWorldlineState,
  type EffectiveEntry,
  type EffectiveKnowledge,
} from '@/domain/worldline';
import { forkPreludeText } from './pathOutline';
import { promptStepHeading } from './scenarioPrompt';

/**
 * 由推演沉淀的章节在「写这一章」时注入的推演材料（设计 D7.3 / §7.3）。纯函数：调用方读好推演、节点、
 * 全部条目（scope: 'all'，含已删除的 —— 才能说清「主角在回收站」）与分类后交给这里。
 *
 * 四块：
 * 1【本章涉及的推演专属设定】限定条目原文，取**本章最后一步**处的有效知识：本章里才登场的隐藏人物
 *   在第一步的父节点处还是「可能登场的预设」或不在可见子树里，取父节点会恰好漏掉他们；
 *   只取「本章差异碰过 ∪ 本章原文提到」的那些，又不会把后面才有关系的条目带进来。
 * 2【分叉之前的经过】只外传：分叉点处的检查点摘要 + 之后到分叉点的简写原文。
 * 3【本章依据的互动推演】本章对应步骤的行动与情节原文（外传章节前面加「本章细纲」，外传没有大纲节点）。
 * 4【这条世界线在本章开始时的状态】第一步父节点处的有效差异 + 本章内发生的变化。
 */

export interface ScenarioChapterInput {
  scenario: Scenario | undefined;
  nodes: readonly ScenarioNode[];
  entries: readonly KnowledgeEntry[];
  categories: readonly Category[];
  /** 章节的溯源：主线取大纲节点的 scenarioSource，外传取章节的（带 brief） */
  source: { nodeIds: readonly string[]; brief?: string };
  /** 外传章节：所属外传的分叉点；主线章节为 null */
  forkNodeId: string | null;
}

export interface ScenarioChapterResult {
  /** null = 不注入（来源推演或步骤已不存在） */
  context: ScenarioChapterContext | null;
  /** 推演主角在回收站时为他的名称：本章不会带上他的档案 */
  castInTrash: string | null;
  /** 来源推演已不存在（或对应的步骤缺失）：本章只按大纲生成 */
  sourceGone: boolean;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** renderWorldlineState 的结果去掉它自己的标题行：这里换成本块的两段标题 */
function stateBody(text: string): string {
  if (!text) return '';
  const at = text.indexOf('\n\n');
  return at < 0 ? '' : text.slice(at + 2);
}

/**
 * 只保留本章各步产生的变化，交给同一个 renderWorldlineState 渲染（与推演每一步的【本线变化】同一写法）：
 * 字段改写只留来源在本章的；本线新条目只留本章出现的（全文）；更早出现的本线条目在本章被改写或换了状态时
 * 当作普通条目列出改写；状态、主角状态、标记、事件按产生它的节点筛
 */
function changesWithin(
  knowledge: EffectiveKnowledge,
  chapterIds: ReadonlySet<string>,
): EffectiveKnowledge {
  const entries: EffectiveEntry[] = [];
  for (const entry of knowledge.entries) {
    const fields: EffectiveEntry['fields'] = {};
    let changed = false;
    for (const [key, field] of Object.entries(entry.fields)) {
      const own = field.source !== 'world' && chapterIds.has(field.source);
      fields[key] = own ? field : { value: field.value, source: 'world' };
      if (own) changed = true;
    }
    const status = entry.status && chapterIds.has(entry.status.nodeId) ? entry.status : null;
    if (
      entry.origin === 'line' &&
      entry.lineNodeId !== undefined &&
      chapterIds.has(entry.lineNodeId)
    ) {
      entries.push(entry);
    } else if (entry.origin === 'line') {
      if (changed || status) entries.push({ ...entry, origin: 'world', fields, status });
    } else {
      entries.push({ ...entry, fields, status });
    }
  }
  const oc: EffectiveKnowledge['oc'] = {};
  for (const [castId, state] of Object.entries(knowledge.oc)) {
    oc[castId] = {
      injury: state.injury.filter((item) => chapterIds.has(item.nodeId)),
      ability: state.ability.filter((item) => chapterIds.has(item.nodeId)),
      item: state.item.filter((item) => chapterIds.has(item.nodeId)),
      relation: state.relation.filter((item) => chapterIds.has(item.nodeId)),
      secret: state.secret.filter((item) => chapterIds.has(item.nodeId)),
      other: state.other.filter((item) => chapterIds.has(item.nodeId)),
    };
  }
  return {
    ...knowledge,
    entries,
    oc,
    flags: Object.fromEntries(
      Object.entries(knowledge.flags).filter(([, flag]) => chapterIds.has(flag.nodeId)),
    ),
    events: knowledge.events.filter((event) => chapterIds.has(event.nodeId)),
  };
}

const GONE: ScenarioChapterResult = { context: null, castInTrash: null, sourceGone: true };

export function buildScenarioChapterContext(input: ScenarioChapterInput): ScenarioChapterResult {
  const { scenario, nodes, entries, categories, source } = input;
  if (!scenario || source.nodeIds.length === 0) return GONE;

  // 本章各步必须仍在树上、且是一条路径上连续的一段；否则不注入（宁可只按大纲写，也不拿错的材料）
  const last = source.nodeIds[source.nodeIds.length - 1]!;
  const path = pathTo(nodes, last);
  const start = path.findIndex((node) => node.id === source.nodeIds[0]);
  if (start < 0 || path.length - start !== source.nodeIds.length) return GONE;
  const steps = path.slice(start);
  if (steps.some((node, i) => node.id !== source.nodeIds[i])) return GONE;
  const before = path.slice(0, start);
  const chapterIds = new Set(steps.map((node) => node.id));

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const castMember = scenario.setup.cast[0];
  const castEntry = entries.find((entry) => entry.id === castMember?.entryId);
  const castAlive = castEntry !== undefined && (castEntry.deletedAt ?? null) === null;
  const castInTrash = castEntry && !castAlive ? castEntry.title : null;
  const castNames: Record<string, string> =
    castMember && castAlive ? { [castMember.id]: castEntry.title } : {};

  const atLast = effectiveKnowledge({ scenario, path, entries, categories });
  const atStart = effectiveKnowledge({ scenario, path: before, entries, categories });

  // 1 推演专属设定：最后一步处可见的限定条目里，主角必选，其余取本章碰过 ∪ 提到的
  const limited = atLast.entries.filter(
    (entry) => entry.origin === 'limited' && entry.entry !== undefined,
  );
  const touched = new Set<string>();
  for (const node of steps) {
    const targets = [
      ...(node.delta?.fieldOverrides ?? []).map((change) => change.target),
      ...(node.delta?.statusChanges ?? []).map((change) => change.target),
    ];
    for (const target of targets) touched.add(atLast.lineAliases[refKey(target)] ?? refKey(target));
  }
  const plots = steps.map((node) => node.plot).join('\n');
  const mentioned = new Set(
    mentionedEffectiveEntries(plots, limited).map((entry) => refKey(entry.ref)),
  );
  const castKey = castMember ? `world:${castMember.entryId}` : '';
  const cast = castAlive ? limited.find((entry) => refKey(entry.ref) === castKey) : undefined;
  const others = limited
    .filter((entry) => refKey(entry.ref) !== castKey)
    .filter((entry) => touched.has(refKey(entry.ref)) || mentioned.has(refKey(entry.ref)))
    .slice(0, MAX_INFERRED_ENTRIES);
  const picked = [...(cast ? [cast] : []), ...others].sort(
    (a, b) => compareText(a.title, b.title) || compareText(refKey(a.ref), refKey(b.ref)),
  );
  const limitedText =
    picked.length > 0
      ? [
          '【本章涉及的推演专属设定】',
          ...picked.map((entry) => {
            const category = categoryById.get(entry.categoryId);
            return renderScenarioEntry(entry.entry!, category, (key) =>
              fieldMutability(category, entry.entry, key),
            );
          }),
        ].join('\n\n')
      : '';
  const limitedLabel = cast
    ? `推演专属设定（主角『${cast.title}』等 ${picked.length} 条）`
    : `推演专属设定（${picked.length} 条）`;

  // 2 分叉之前的经过：只外传，分叉点得在本章路径上
  const forkNodeId = input.forkNodeId;
  const forkPrelude =
    forkNodeId && path.some((node) => node.id === forkNodeId)
      ? forkPreludeText(path, forkNodeId)
      : '';
  const forkText = forkPrelude
    ? ['【分叉之前的经过（与主线共用，外传不要重写这部分）】', forkPrelude].join('\n')
    : '';

  // 3 本章依据的互动推演
  const brief = source.brief?.trim() ?? '';
  const from = steps[0]!.depth + 1;
  const to = steps[steps.length - 1]!.depth + 1;
  const stepsText = [
    '【本章依据的互动推演】',
    ...(brief ? [`本章细纲：${brief}`] : []),
    ...steps.map((node) => `${promptStepHeading(node)}\n${node.plot.trim()}`),
  ].join('\n\n');
  const label = `互动推演 · ${from === to ? `第 ${from} 步` : `第 ${from}–${to} 步`}原文`;

  // 4 世界线状态：开始时（第一步的父节点处）+ 本章内发生的变化
  const startState = stateBody(renderWorldlineState(atStart, categories, castNames));
  const changes = stateBody(
    renderWorldlineState(changesWithin(atLast, chapterIds), categories, castNames),
  );
  const stateText =
    startState || changes
      ? [
          '【这条世界线在本章开始时的状态（与上文设定冲突时以这里为准，底层字段除外）】',
          startState || '（与世界观设定一致，还没有变化）',
          '本章内发生的变化：',
          changes || '（无）',
        ].join('\n\n')
      : '';

  // 通用主角并入默认预选（限定条目不在写作链路的条目列表里，档案已在第 1 块）
  const castEntryIds =
    castEntry && castAlive && (castEntry.scope?.kind ?? 'universal') === 'universal'
      ? [castEntry.id]
      : [];
  const hintText = [brief, ...steps.map((node) => node.plot.trim())].filter(Boolean).join('\n');

  return {
    context: {
      label,
      limitedText,
      limitedLabel,
      forkText,
      stepsText,
      stateText,
      castEntryIds,
      hintText,
    },
    castInTrash,
    sourceGone: false,
  };
}
