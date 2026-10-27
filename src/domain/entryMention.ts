import type { KnowledgeEntry } from './schema';

/**
 * 名称匹配与评分：给「这个节点提到了哪些设定」一个可解释的排序。
 *
 * 与 `entrySearch.mentionedEntries` 的分工：
 * - `mentionedEntries` 是旧语义（只看命中、按条目顺序取前 N），导入提取、规范检查、
 *   世界线推演都在用，**不动**；改它等于改这些功能的行为。
 * - 这里只服务新调用点（大纲细化的规划上下文、采用后的关联建议），需要「为什么命中、
 *   哪个更可信」来决定谁进 prompt、谁被预算丢掉。
 */

export type MentionKind = 'title' | 'alias';

export interface EntryMention {
  entry: KnowledgeEntry;
  /** 实际命中的名称（原始写法，方便 UI 告诉作者「命中的是别名」） */
  matchedName: string;
  kind: MentionKind;
  /** 排序分，越大越可信。只用于排序/截断，不落库 */
  score: number;
}

export interface RankMentionOptions {
  /** 默认 8；显式关联不受此限（由调用方先算完显式档） */
  limit?: number;
  excludeIds?: ReadonlySet<string>;
  /** 默认 1；低于该分数的命中直接丢弃 */
  minScore?: number;
}

const TITLE_BASE_SCORE = 100;
const ALIAS_BASE_SCORE = 80;
const LENGTH_BONUS_CAP = 10;
/** 2 字名容易撞上常用词（「林越」「裴照」也可能是地名/年号），降权但不丢弃 */
const SHORT_NAME_PENALTY = 20;
/** 泛化别名即使命中也几乎不提供信息，压到真正的角色名之后 */
const GENERIC_ALIAS_PENALTY = 50;
const DEFAULT_LIMIT = 8;
const DEFAULT_MIN_SCORE = 1;

/** 零宽字符：作者从网页/聊天记录粘贴时常带进来，肉眼看不见但会让子串匹配失败 */
const ZERO_WIDTH_PATTERN = /[\u200b-\u200d\ufeff]/g;

/**
 * 泛化别名黑名单：可以作为 aliases 存在，但不该主导「提到了谁」。
 * 单字项（他/她/它/我/你/您）照例会被长度规则丢弃，列出来是为了让规则自解释。
 */
const GENERIC_ALIASES: ReadonlySet<string> = new Set(
  [
    '他',
    '她',
    '它',
    '我',
    '你',
    '您',
    '师父',
    '老师',
    '大人',
    '公子',
    '小姐',
    '先生',
    '夫人',
    '老板',
    '队长',
    '将军',
    '陛下',
    '殿下',
    '师兄',
    '师姐',
    '师弟',
    '师妹',
  ].map((alias) => normalizeMentionText(alias)),
);

/**
 * 归一化：只做不改变语义的处理。
 *
 * 刻意不删内部空格、不删标点、不做简繁转换 —— 后两者会引入转换表并误伤
 * （「干」与「乾」在不同上下文里不是同一个字），宁可漏也不要错配。
 * 首尾空白要裁：与 `mentionedEntries` 的 normalizeEntryName 同口径，
 * 条目名尾随一个空格时，不裁就永远匹配不上正文。
 */
export function normalizeMentionText(input: string): string {
  return input.normalize('NFKC').replace(ZERO_WIDTH_PATTERN, '').toLowerCase().trim();
}

interface CandidateHit {
  mention: EntryMention;
  /** 归一化后的命中名，用于长度排序；不随 mention 外泄 */
  normalizedName: string;
}

/** 评分表见设计 §2.3；length 用归一化后的长度，全半角折叠后按实际字数算 */
function scoreOf(kind: MentionKind, normalizedName: string): number {
  const base = kind === 'title' ? TITLE_BASE_SCORE : ALIAS_BASE_SCORE;
  let score = base + Math.min(normalizedName.length, LENGTH_BONUS_CAP) * 2;
  if (normalizedName.length === 2) score -= SHORT_NAME_PENALTY;
  if (kind === 'alias' && GENERIC_ALIASES.has(normalizedName)) score -= GENERIC_ALIAS_PENALTY;
  return score;
}

/** 同一条目内的择优：先分数、再命中名长度、标题优先。必须全序，否则结果依赖遍历顺序 */
function compareHits(a: CandidateHit, b: CandidateHit): number {
  if (a.mention.score !== b.mention.score) return b.mention.score - a.mention.score;
  if (a.normalizedName.length !== b.normalizedName.length) {
    return b.normalizedName.length - a.normalizedName.length;
  }
  if (a.mention.kind !== b.mention.kind) return a.mention.kind === 'title' ? -1 : 1;
  return 0;
}

/**
 * 条目级全序：分数降序 → 命中名长度降序 → id 升序。
 * 最后一档用码元比较而不是 localeCompare：排序结果不能随运行环境的 ICU 变。
 */
function compareMentions(a: CandidateHit, b: CandidateHit): number {
  if (a.mention.score !== b.mention.score) return b.mention.score - a.mention.score;
  if (a.normalizedName.length !== b.normalizedName.length) {
    return b.normalizedName.length - a.normalizedName.length;
  }
  return a.mention.entry.id < b.mention.entry.id
    ? -1
    : a.mention.entry.id > b.mention.entry.id
      ? 1
      : 0;
}

/** 一个条目在多处文本里的最好一次命中；没有命中返回 undefined */
function bestHitOf(entry: KnowledgeEntry, haystack: string): CandidateHit | undefined {
  const candidates: { name: string; kind: MentionKind }[] = [
    { name: entry.title, kind: 'title' },
    ...entry.aliases.map((alias) => ({ name: alias, kind: 'alias' as const })),
  ];

  let best: CandidateHit | undefined;
  for (const candidate of candidates) {
    const normalizedName = normalizeMentionText(candidate.name);
    // 单字名几乎必然误命中（「我」「他」也可能是人物名的一部分），设计 §2.3 直接丢弃
    if (normalizedName.length < 2) continue;
    if (!haystack.includes(normalizedName)) continue;
    const hit: CandidateHit = {
      normalizedName,
      mention: {
        entry,
        matchedName: candidate.name,
        kind: candidate.kind,
        score: scoreOf(candidate.kind, normalizedName),
      },
    };
    if (!best || compareHits(hit, best) < 0) best = hit;
  }
  return best;
}

/**
 * 从多段文本里找出提到的条目，按可信度排序并截断。
 *
 * 多段文本用换行拼接后再匹配：既避免「上一段结尾 + 下一段开头」拼出一个假名字，
 * 又不需要为每段各匹配一遍。
 */
export function rankEntryMentions(
  texts: readonly string[],
  entries: readonly KnowledgeEntry[],
  options: RankMentionOptions = {},
): EntryMention[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const haystack = texts
    .map((text) => normalizeMentionText(text))
    .filter((text) => text.length > 0)
    .join('\n');
  if (!haystack) return [];

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const hits: CandidateHit[] = [];
  for (const entry of entries) {
    if (options.excludeIds?.has(entry.id)) continue;
    const hit = bestHitOf(entry, haystack);
    if (hit && hit.mention.score >= minScore) hits.push(hit);
  }

  hits.sort(compareMentions);
  return hits.slice(0, limit).map((hit) => hit.mention);
}
