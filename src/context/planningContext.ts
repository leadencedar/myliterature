import type { Category, KnowledgeEntry } from '@/domain/schema';
import { rankEntryMentions, type EntryMention } from '@/domain/entryMention';
import { renderEntry } from './renderEntry';
import { estimateTokens } from './tokens';

/**
 * 规划侧（细化大纲）的条目选择。
 *
 * 与正文侧 `SummaryChainContextBuilder` 的关系是「复用事实源、不复用整个构建器」：
 * 构建器绑定 `ContextRequest` 与写作装箱顺序，规划任务只需要「这次该带哪些设定」。
 * 所以这里复用它的 `renderEntry`（完整字段渲染）与新的评分匹配，但预算与顺序
 * 按规划任务的注意力经济重排：
 *
 *   核心设定（pinned，必注入） → 显式关联（作者亲手选的） → 名称命中的推断档
 *
 * 推断档最后装箱，预算不够时先丢分数最低的 —— 精度优先，宁可漏掉一条设定，
 * 也不要把「同姓」「泛化别名」这类低可信命中塞进 prompt 稀释注意力。
 */

export interface PlanningEntryBlock {
  entry: KnowledgeEntry;
  reason: 'core' | 'linked' | 'mentioned';
  /** mentioned 时的命中名与分数（UI 用来解释「为什么带上了它」） */
  matchedName?: string;
  score?: number;
  tokens: number;
  text: string;
}

export interface PlanningSelection {
  /** pinned，始终注入，不参与预算裁剪 */
  core: PlanningEntryBlock[];
  /** linked + mentioned，按装箱顺序返回；可被预算裁剪 */
  related: PlanningEntryBlock[];
  /** 因预算未注入的条目，UI 用来提示「还有 N 条没带上」 */
  dropped: PlanningEntryBlock[];
  /** 实际注入的 token 估算（core + related） */
  tokens: number;
}

export interface SelectPlanningEntriesInput {
  /** 参与名称匹配的文本：节点标题、梗概、额外要求、最近祖先梗概 */
  texts: readonly string[];
  /** 调用方已按「通用、未删除」过滤；这里仍防御性跳过软删除条目 */
  entries: readonly KnowledgeEntry[];
  categories: readonly Category[];
  linkedEntryIds: readonly string[];
  /** 默认 8000 */
  budget?: number;
  /** 默认 8 */
  maxMentioned?: number;
}

/** 8k 的依据：细化 prompt 现状约 1.1k tokens，核心通常 1–3 条，余量够 8 条相关 + 位置/规范 */
export const PLANNING_CONTEXT_BUDGET = 8_000;
export const MAX_PLANNING_MENTIONED = 8;

function notDeleted(entry: KnowledgeEntry): boolean {
  return (entry.deletedAt ?? null) === null;
}

function blockOf(
  entry: KnowledgeEntry,
  categories: Category[],
  reason: PlanningEntryBlock['reason'],
  mention?: EntryMention,
): PlanningEntryBlock {
  const text = renderEntry(entry, categories);
  const block: PlanningEntryBlock = { entry, reason, tokens: estimateTokens(text), text };
  if (mention) {
    block.matchedName = mention.matchedName;
    block.score = mention.score;
  }
  return block;
}

export function selectPlanningEntries(input: SelectPlanningEntriesInput): PlanningSelection {
  const budget = input.budget ?? PLANNING_CONTEXT_BUDGET;
  const maxMentioned = input.maxMentioned ?? MAX_PLANNING_MENTIONED;
  // renderEntry 的签名沿用正文侧的可变数组；这里只拷贝一次，避免每条目复制
  const categories = [...input.categories];

  const core: PlanningEntryBlock[] = [];
  for (const entry of input.entries) {
    if (entry.pinned && notDeleted(entry)) core.push(blockOf(entry, categories, 'core'));
  }
  let used = core.reduce((sum, block) => sum + block.tokens, 0);
  const coreIds = new Set(core.map((block) => block.entry.id));

  // 显式关联：作者亲手选的，按 linkedEntryIds 顺序原样保留；不存在的 id（已删除、跨作品、
  // 刚被删）静默丢掉。显式档不受 maxMentioned 限制，但在预算面前与其它条目一视同仁
  const byId = new Map(input.entries.filter(notDeleted).map((entry) => [entry.id, entry]));
  const related: PlanningEntryBlock[] = [];
  const dropped: PlanningEntryBlock[] = [];
  const linkedIds = new Set<string>();
  for (const id of input.linkedEntryIds) {
    if (linkedIds.has(id)) continue;
    linkedIds.add(id);
    const entry = byId.get(id);
    // pinned 已在核心档，不重复；核心档也要从显式档排除，否则同一条目出现两次
    if (!entry || entry.pinned || coreIds.has(id)) continue;
    const block = blockOf(entry, categories, 'linked');
    if (used + block.tokens > budget) {
      dropped.push(block);
      continue;
    }
    used += block.tokens;
    related.push(block);
  }

  // 推断档：核心与显式关联都不再参与匹配，避免同一条目从两个档位重复进入
  const candidates = rankEntryMentions(
    input.texts,
    input.entries.filter(
      (entry) => !entry.pinned && !coreIds.has(entry.id) && !linkedIds.has(entry.id),
    ),
    { limit: maxMentioned },
  );

  // 按分数从低到高丢：分数已降序，从第一个放不下的开始，后面的整段丢弃。
  // 不跳过「高分但太长」的条目去塞更低分的短条目 —— 那等于用可信度换数量。
  let mentionedOverBudget = false;
  for (const mention of candidates) {
    const block = blockOf(mention.entry, categories, 'mentioned', mention);
    if (!mentionedOverBudget && used + block.tokens <= budget) {
      used += block.tokens;
      related.push(block);
      continue;
    }
    mentionedOverBudget = true;
    dropped.push(block);
  }

  return { core, related, dropped, tokens: used };
}
