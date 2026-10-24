import { z } from 'zod';
import { renderEntry, renderSummary } from '@/context/SummaryChainContextBuilder';
import type {
  Category,
  Chapter,
  ChapterSummary,
  KnowledgeEntry,
  Novel,
  WritingNorm,
} from '@/domain/schema';
import { composeSections, novelMetaSection, writingNormsSection } from '@/prompt/sections';
import { previousSummaryOf } from './chapterSummary';

/**
 * 「按规范检查本章」的纯函数部分：输出 schema、提示词、分段、原句定位与结果整理。
 *
 * 检查只提示、不改正文：这里没有任何写正文的函数，结果交给编辑器在会话内展示，
 * 采用建议仍走段落加工（作者确认后才写入并进撤销栈）。
 */

// ---------------------------------------------------------------- 输出 schema

/** 界面文案：明确违反 / 可能违反 / 需作者判断 */
export const NormCheckSeveritySchema = z.enum(['violation', 'possible', 'judgement']);
export type NormCheckSeverity = z.infer<typeof NormCheckSeveritySchema>;

/**
 * 全部字段必填（空串表示没有）：generateStructured 用 io: 'output' 导出 JSON Schema，
 * 严格模式要求每个字段都在 required 里，可选字段会让支持严格模式的服务商直接拒绝请求
 */
export const NormCheckIssueSchema = z.object({
  /** 被违反的规范标题，原样抄写 */
  normTitle: z.string().min(1),
  /** 规范原文里被违反的那一条，原样摘抄 */
  rule: z.string().min(1),
  /** 正文里能定位问题的原句片段，原样摘抄；问题是「缺了什么」时为空串 */
  quote: z.string(),
  problem: z.string().min(1),
  /** 修改建议；没有就是空串 */
  suggestion: z.string(),
  severity: NormCheckSeveritySchema,
});
export type NormCheckIssue = z.infer<typeof NormCheckIssueSchema>;

export const NormCheckResultSchema = z.object({ issues: z.array(NormCheckIssueSchema) });
export type NormCheckResult = z.infer<typeof NormCheckResultSchema>;

export const NORM_CHECK_SEVERITY_LABELS: Record<NormCheckSeverity, string> = {
  violation: '明确违反',
  possible: '可能违反',
  judgement: '需作者判断',
};

/** 排序用：严重的在前 */
const SEVERITY_RANK: Record<NormCheckSeverity, number> = {
  violation: 0,
  possible: 1,
  judgement: 2,
};

// ---------------------------------------------------------------- 提示词

/**
 * 单次检查的正文上限（字符）。约 6.4k tokens，与提取段同量级：
 * 再长的话模型逐条对照的注意力会被稀释，输出也更容易撞上上限被截断
 */
export const NORM_CHECK_SEGMENT_CHARS = 8000;

export const NORM_CHECK_TASK = [
  '【任务】',
  '审读给出的章节正文，逐条对照上面的写作规范，列出正文里可能违反规范的地方。',
  '',
  '要求：',
  '- 只依据上面的写作规范、核心设定和给出的前情判断。不要用你对原作或常识的记忆补出规范没写的规则。',
  '- 没有发现问题就给空数组。不要为了凑数硬找。',
  '- normTitle：原样抄写被违反的规范标题，即「【规范《…》】」书名号里的文字，不要抄规范内部的小节标题。',
  '- rule：原样摘抄那份规范里被违反的那一条，不超过 80 字。',
  '- quote：从正文原样摘抄能定位问题的连续片段，10–60 字，不得改字，不得拼接不相邻的句子。问题是「缺了应有的交代」而不是某句写错时，给空串。',
  '- problem：一两句话说明为什么可能违反。',
  '- suggestion：怎么改，一两句话；没有好的建议就给空串。不要输出改写后的整段正文。',
  '- severity：violation = 明确违反；possible = 可能违反，取决于前文没写明的信息；judgement = 规范本身留有余地，需要作者判断。',
  '- 最多 20 条，严重的在前。',
].join('\n');

const NORM_CHECK_OPENING = '你是一位严谨的小说责任编辑，负责按作者定下的写作规范审读章节。';

const SEGMENT_NOTE =
  '这是本章的一部分，只检查这一段；本段没写到的内容可能在其他段里，不要据此判为缺失';

/**
 * 检查的系统提示（稳定前缀）：开场白 → 作品信息 → 检查规范 → 核心设定 → 任务说明。
 *
 * 不带风格档案：检查的是规范而不是文风，带上会诱导模型挑文风毛病。
 * 核心设定整本书稳定，放在前缀里；同一本书各章、同一章各段都共用这一份，能命中缓存。
 * norms 传「本次注入」的集合；writingNormsSection 内部会再按 check 过滤一遍，结果幂等。
 */
export function buildNormCheckSystemPrompt(
  novel: Novel,
  norms: readonly WritingNorm[],
  pinnedEntries: KnowledgeEntry[],
  categories: Category[],
): string {
  // 顺序沿用调用方传入的 context.entries，条目之间恰好一个空行（遗留 #4）
  const pinnedBlock =
    pinnedEntries.length > 0
      ? [
          '【核心设定（供判断，不是检查对象）】',
          ...pinnedEntries.map((entry) => renderEntry(entry, categories)),
        ].join('\n\n')
      : '';
  return composeSections([
    NORM_CHECK_OPENING,
    novelMetaSection(novel),
    writingNormsSection(norms, 'check'),
    pinnedBlock,
    NORM_CHECK_TASK,
  ]);
}

export interface NormCheckPrevious {
  chapter: Chapter;
  summary: ChapterSummary;
}

/**
 * 同一条线上此前最近一份摘要及其章节。中间章节没有摘要时会往前跳，
 * 所以要带上 chapter：块标题写明是第几章，模型才不会把跳过的几章当成「缺失」
 */
export function previousForCheck(
  chapters: Chapter[],
  summaries: ChapterSummary[],
  chapterId: string,
): NormCheckPrevious | undefined {
  const summary = previousSummaryOf(chapters, summaries, chapterId);
  if (!summary) return undefined;
  const chapter = chapters.find((item) => item.id === summary.chapterId);
  return chapter ? { chapter, summary } : undefined;
}

export interface NormCheckUserPromptParams {
  /** chapterLabel(chapter, sideStories)，如「第 3 章」「外传·青冥旧事 第 2 章」 */
  chapterLabel: string;
  /** index 从 0 起，与 resolveCheckIssues 的 segmentIndex 一致；显示时 +1 */
  segment: { index: number; total: number; text: string };
  /** 本章提到的非核心条目（整章算一次，各段共用） */
  mentionedEntries: KnowledgeEntry[];
  categories: Category[];
  previous?: NormCheckPrevious;
}

/**
 * 检查的用户提示（易变部分）：相关设定 → 前情摘要 →（分段说明）→ 待检查正文。
 * 正文放最后：前面的块在同一章的各段之间完全相同，只有末尾随段变化
 */
export function buildNormCheckUserPrompt(params: NormCheckUserPromptParams): string {
  const { chapterLabel, segment, mentionedEntries, categories, previous } = params;

  const relatedBlock =
    mentionedEntries.length > 0
      ? [
          '【相关设定】',
          mentionedEntries.map((entry) => renderEntry(entry, categories)).join('\n\n'),
        ].join('\n')
      : '';

  // 与构建器的 chapterWord 同一规则：外传章节写「外传第」
  const previousBlock = previous
    ? [
        `【此前最近一章（${previous.chapter.sideStoryId ? '外传第' : '第'} ${previous.chapter.index} 章）的摘要】`,
        renderSummary(previous.chapter, previous.summary),
      ].join('\n')
    : '';

  const segmented = segment.total > 1;
  const header = `【待检查的正文（${chapterLabel}${
    segmented ? ` · 第 ${segment.index + 1}/${segment.total} 段` : ''
  }）】`;

  return composeSections([
    relatedBlock,
    previousBlock,
    segmented ? SEGMENT_NOTE : '',
    // 只在送进提示时对单段 trimEnd：切分本身不丢字符，定位用的是完整正文
    `${header}\n${segment.text.trimEnd()}`,
  ]);
}

// ---------------------------------------------------------------- 分段

const SENTENCE_END = /[。！？]/u;

/**
 * 把超长正文切成若干段。不变量：
 * - 各段是原文的连续切片，`segments.join('') === content`；
 * - 每段 `length <= max`；行尾的 `\n` 留在前一段末尾；
 * - 单行超长时在 max 之前最后一个「。！？」之后切（标点留在前一段），没有就在 max 处硬切；
 * - `content.length <= max` 时返回 `[content]`；空串返回 `[]`。
 *
 * 不复用 splitWorldviewText：它只认空行分段，很多章节是单换行分段，会被硬切在句中。
 */
export function splitChapterForCheck(content: string, max = NORM_CHECK_SEGMENT_CHARS): string[] {
  if (content === '') return [];
  if (content.length <= max) return [content];

  // 每行带上自己的行尾 \n，拼回去就是原文
  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [content];
  const segments: string[] = [];
  let current = '';

  for (const line of lines) {
    if (current.length + line.length <= max) {
      current += line;
      continue;
    }
    if (current) segments.push(current);
    current = '';

    let rest = line;
    while (rest.length > max) {
      const head = rest.slice(0, max);
      let cut = -1;
      for (let i = head.length - 1; i >= 0; i -= 1) {
        if (SENTENCE_END.test(head[i]!)) {
          cut = i + 1;
          break;
        }
      }
      if (cut <= 0) cut = max;
      segments.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) segments.push(current);
  return segments;
}

// ---------------------------------------------------------------- 原句定位

/** 空白：JS 空白（含 \n、\t、\r、半角空格）再加全角空格 */
const WS = /[\s\u3000]/u;

/**
 * 在正文里找模型摘抄的原句。先精确 indexOf（多次出现取第一次）；
 * 找不到再忽略空白比较，并用下标映射换算回原文区间 —— 模型常把跨行的句子抄成一行，
 * 或丢掉段首的全角缩进。都找不到、或 quote 只有空白时返回 null。
 */
export function locateQuote(content: string, quote: string): { start: number; end: number } | null {
  if (quote.trim() === '') return null;
  const exact = content.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };

  // stripped 是去掉空白后的正文，map[i] 是 stripped 第 i 个字符在原文里的下标（WS 都是单码元）
  let stripped = '';
  const map: number[] = [];
  for (let i = 0; i < content.length; i += 1) {
    if (!WS.test(content[i]!)) {
      stripped += content[i];
      map.push(i);
    }
  }
  const q = Array.from(quote)
    .filter((ch) => !WS.test(ch))
    .join('');
  // 第一步已保证 quote 至少有一个非空白字符，所以 q 非空，下面的 map 下标一定存在
  const k = stripped.indexOf(q);
  if (k < 0) return null;
  // end 指向最后一个非空白字符之后：区间可能跨过换行与全角空格，但首尾不多带空白
  return { start: map[k]!, end: map[k + q.length - 1]! + 1 };
}

// ---------------------------------------------------------------- 结果整理

export interface ResolvedCheckIssue extends NormCheckIssue {
  /** `${segmentIndex}-${i}`，i 为该段 issues 数组下标，用于忽略 */
  key: string;
  /** 对应的规范 id；规范名对不上为 null，界面标「规范名未对应」 */
  normId: string | null;
}

/** 候选名：原样 trim，以及（若被一对《》包住）去掉外层书名号再 trim */
function titleCandidates(normTitle: string): string[] {
  const trimmed = normTitle.trim();
  const candidates = [trimmed];
  if (trimmed.startsWith('《') && trimmed.endsWith('》') && trimmed.length >= 2) {
    candidates.push(trimmed.slice(1, -1).trim());
  }
  return candidates;
}

/**
 * 解析 + 排序。
 *
 * norms 传「本次注入的规范」（已按 normsInScope 排好序），不是作品的全部规范：
 * 被临时取消的规范没给模型看，名字对上了也不该算命中。同名多份时取排序最前的那份。
 *
 * 匹配不上规范名的条目保留而不是丢弃：检查结果是给作者看的提示，丢掉可能藏住真实问题。
 *
 * 排序键（全序）：严重程度 → 原句在 content 里的位置（定位不到为 Infinity）→ 段号 → 段内下标。
 * content 传检查时的正文（checkedContent），保证结果顺序不随之后的打字变化。
 */
export function resolveCheckIssues(
  results: { segmentIndex: number; issues: NormCheckIssue[] }[],
  norms: readonly WritingNorm[],
  content: string,
): ResolvedCheckIssue[] {
  const decorated: {
    issue: ResolvedCheckIssue;
    rank: number;
    start: number;
    segmentIndex: number;
    i: number;
  }[] = [];

  for (const { segmentIndex, issues } of results) {
    issues.forEach((issue, i) => {
      const candidates = titleCandidates(issue.normTitle);
      const norm = norms.find((item) => candidates.includes(item.title));
      decorated.push({
        issue: { ...issue, key: `${segmentIndex}-${i}`, normId: norm?.id ?? null },
        rank: SEVERITY_RANK[issue.severity],
        start: locateQuote(content, issue.quote)?.start ?? Number.POSITIVE_INFINITY,
        segmentIndex,
        i,
      });
    });
  }

  decorated.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
    return a.i - b.i;
  });
  return decorated.map((item) => item.issue);
}

/**
 * 规范名的显示：去掉模型可能自带的外层书名号，界面统一包一层《》。
 * 只影响显示，匹配仍按 resolveCheckIssues 的规则
 */
export function displayNormTitle(normTitle: string): string {
  const candidates = titleCandidates(normTitle);
  return candidates[candidates.length - 1] ?? normTitle.trim();
}
