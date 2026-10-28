/**
 * 前沿续写 3–5 章（M3 S3）。
 *
 * 大纲写到头的连载作者最难的是「下一步写什么」：不是没有想象，而是要同时守住
 * 未收束伏笔、人物状态、已有设定的约束。所以这里把任务收窄成**只规划不写正文**：
 * 一次结构化调用产出 3–5 章的场景级细纲，作为一条 outlineTree 提案交给作者确认。
 *
 * 三条产品红线（对着需求写死在 prompt 里）：
 * 1. 不替作者决定人物生死、感情归宿、最终凶手；
 * 2. 不提前泄露伏笔答案，也不一次把所有伏笔收光；
 * 3. 只规划，不写正文，不落库 —— 采用与否由作者在提案里定。
 */
import { z } from 'zod';
import type { PlanningEntryBlock } from '@/context/planningContext';
import { selectPlanningEntries } from '@/context/planningContext';
import { estimateTokens } from '@/context/tokens';
import type {
  Category,
  Chapter,
  ChapterSummary,
  KnowledgeEntry,
  Novel,
  OutlineNode,
  Proposal,
  StyleProfile,
  WritingNorm,
} from '@/domain/schema';
import { chapterLabel, chaptersOfTrack } from '@/domain/sideStory';
import type { LlmRunner } from '@/llm/useLlm';
import { newBatchId, buildCreateProposal } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import { serializeOutlineTree } from '@/proposal/outlineText';
import { composeSections, composeStylePrefix, writingNormsSection } from '@/prompt/sections';

/** 「最近章节要点」带几章：3 章足够接住语气与伏笔，再多只是重复 */
export const RECENT_CHAPTER_COUNT = 3;
/** 续写章数范围：与需求/提案的「3–5 章」一致 */
export const FRONTIER_CHAPTER_MIN = 3;
export const FRONTIER_CHAPTER_MAX = 5;
/** 没有分卷结构时，大纲尾部最多列最近几个顶层节点 */
const MAX_FLAT_TAIL_NODES = 5;

// ---------------------------------------------------------------- schema

export const FrontierChapterSchema = z.object({
  title: z.string().min(1, '章节标题不能为空'),
  /** 本章主线梗概：谁要什么、阻碍、转折、结尾局面 */
  synopsis: z.string().min(1, '章节梗概不能为空'),
  targetWords: z.number().int().positive().nullable(),
  /** 3–5 个场景，按顺序；每个场景要能落到「目标—阻碍—转折」 */
  scenes: z.array(z.string().min(1)).min(3, '每章至少 3 个场景').max(5, '每章最多 5 个场景'),
  /** 本章主冲突 */
  conflict: z.string().min(1, '主冲突不能为空'),
  /** 章末钩子：具体的一条悬念/反转，不要「欲知后事」 */
  hook: z.string().min(1, '章末钩子不能为空'),
  /** 本章引用到的知识库条目名称（知识库里的名字或别名） */
  usesEntries: z.array(z.string()),
  /** 本章准备回收的伏笔（从【未收束伏笔】里原样抄） */
  resolvesThreads: z.array(z.string()),
  /** 本章准备新埋的伏笔 */
  plantsThreads: z.array(z.string()),
});

export const FrontierOutlineSchema = z.object({
  chapters: z
    .array(FrontierChapterSchema)
    .min(FRONTIER_CHAPTER_MIN, '至少要续写 3 章')
    .max(FRONTIER_CHAPTER_MAX, '最多续写 5 章'),
});

export type FrontierOutlineResult = z.infer<typeof FrontierOutlineSchema>;
export type FrontierChapter = z.infer<typeof FrontierChapterSchema>;

/** 合成后的章节草稿：synopsis 是「可读梗概」（原梗概 + 场清单/冲突/钩子/伏笔） */
export type FrontierChapterDraft = Omit<FrontierChapter, 'synopsis'> & { synopsis: string };

// ---------------------------------------------------------------- 大纲尾部

/** 大纲尾部的一行：depth 0=卷/顶层节点，1=章节点 */
export interface OutlineTailEntry {
  title: string;
  synopsis: string;
  targetWords: number | null;
  depth: number;
}

function sortNodes(nodes: readonly OutlineNode[]): OutlineNode[] {
  return [...nodes].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/**
 * 取当前大纲的尾部：末卷 + 它下面的章节点。
 *
 * 没有分卷结构（顶层节点直接是章）时取最近几个顶层节点 —— 续写要知道「上一章停在哪」，
 * 只给最后一章往往不够判断节奏。
 */
export function buildOutlineTail(nodes: readonly OutlineNode[]): OutlineTailEntry[] {
  const roots = sortNodes(nodes.filter((node) => node.parentId === null));
  if (roots.length === 0) return [];

  const lastRoot = roots[roots.length - 1]!;
  const children = sortNodes(nodes.filter((node) => node.parentId === lastRoot.id));
  const toEntry = (node: OutlineNode, depth: number): OutlineTailEntry => ({
    title: node.title,
    synopsis: node.synopsis.trim(),
    targetWords: node.targetWords,
    depth,
  });

  if (children.length > 0) {
    return [toEntry(lastRoot, 0), ...children.map((child) => toEntry(child, 1))];
  }
  return roots.slice(-MAX_FLAT_TAIL_NODES).map((node) => toEntry(node, 0));
}

function renderOutlineTail(entries: readonly OutlineTailEntry[]): string {
  return [
    '【当前大纲尾部】',
    ...entries.map((entry) => {
      const indent = '  '.repeat(entry.depth);
      const words = entry.targetWords ? `（目标 ${entry.targetWords} 字）` : '';
      const synopsis = entry.synopsis ? `：${entry.synopsis}` : '';
      return `${indent}- ${entry.title}${words}${synopsis}`;
    }),
  ].join('\n');
}

/** 最近章节要点：摘要 + 关键事件；没有摘要的章节不进（不占预算） */
export interface RecentChapterPoint {
  label: string;
  summary: string;
  keyEvents: string[];
}

function renderRecentChapterPoints(points: readonly RecentChapterPoint[]): string {
  return [
    '【最近章节要点】',
    ...points.map((point) => {
      const lines = [`${point.label}`, point.summary];
      if (point.keyEvents.length > 0) lines.push(`关键事件：${point.keyEvents.join('；')}`);
      return lines.join('\n');
    }),
  ].join('\n\n');
}

// ---------------------------------------------------------------- 提示词

const CONTINUE_TASK = [
  '【任务】',
  '在既有大纲之后续写 3–5 个章节节点。只做规划，不要写正文。',
  '',
  '要求：',
  '- 每章给出 3–5 个场景清单；每个场景都要能落到「谁想要什么、什么在阻碍、转折点在哪」。',
  '- 每章必须有主冲突与一个具体的章末钩子（一条能直接写成正文结尾的悬念或反转，不要「欲知后事如何」）。',
  '- 承接【未收束的伏笔】：明确哪些在 resolveThreads 里回收、哪些在 plantsThreads 里新埋；不要一次把所有伏笔收光。',
  '- resolvesThreads 只能从【未收束的伏笔】清单里原样抄；清单没有的不要编。',
  '- usesEntries 用知识库里的名字或别名（见【相关设定】与【必须遵守的核心设定】）；复述设定不算引用，要让它影响选择或代价。',
  '- 不引入超过 2 个新实体（新人物/新势力/新地点）；需要新角色时优先用已有条目。',
  '- 不替作者决定人物的生死、感情归宿与最终凶手；不提前泄露伏笔答案、不写大结局。',
  '- 第一章要能直接接上【当前大纲尾部】的最后一个节点，不要重复已经写过的内容。',
  '- targetWords 给出该章预估字数；无法判断时填 null。',
].join('\n');

function coreSection(core: readonly PlanningEntryBlock[]): string | undefined {
  if (core.length === 0) return undefined;
  return ['【必须遵守的核心设定】', ...core.map((block) => block.text)].join('\n\n');
}

function relatedSection(related: readonly PlanningEntryBlock[]): string {
  return [
    '【相关设定】',
    '以下设定与本次续写相关，新章节要体现它们的约束与关系，不得违背核心设定。不需要复述设定原文。',
    ...related.map((block) => block.text),
  ].join('\n\n');
}

/**
 * 系统提示：角色 + 文风/结构前缀 + 规划规范 + 核心设定 + 任务约束。
 * 全部是「同一本书内稳定」的内容，续写多次可共享缓存前缀；逐次变化的大纲尾部/摘要放 user。
 */
export function buildOutlineContinueSystemPrompt(
  novel: Novel,
  style: StyleProfile,
  norms?: readonly WritingNorm[],
  coreBlocks?: readonly PlanningEntryBlock[],
): string {
  return composeSections([
    '你是一位资深的小说策划编辑，擅长在既有连载的走向上规划后续章节，而不是替作者发明新故事。',
    composeStylePrefix(novel, style),
    writingNormsSection(norms, 'planning'),
    coreSection(coreBlocks ?? []),
    CONTINUE_TASK,
  ]);
}

/**
 * 用户提示。块顺序固定（设计 §2）：
 * 【当前大纲尾部】→【故事至此】→【最近章节要点】→【未收束伏笔】→【相关设定】→【本次要求】。
 * 空块直接省略，避免模型把「没有」当成需要补全的内容。
 */
export function buildOutlineContinueUserPrompt(params: {
  outlineTail: readonly OutlineTailEntry[];
  rollingSummary: string;
  recentSummaries: readonly RecentChapterPoint[];
  openThreads: readonly string[];
  relatedBlocks: readonly PlanningEntryBlock[];
  count: number;
}): string {
  const blocks: string[] = [];

  if (params.outlineTail.length > 0) {
    blocks.push(renderOutlineTail(params.outlineTail));
  }

  const rolling = params.rollingSummary.trim();
  if (rolling) blocks.push(`【故事至此】\n${rolling}`);

  if (params.recentSummaries.length > 0) {
    blocks.push(renderRecentChapterPoints(params.recentSummaries));
  }

  const threads = params.openThreads.map((thread) => thread.trim()).filter(Boolean);
  if (threads.length > 0) {
    blocks.push(['【未收束伏笔】', ...threads.map((thread) => `- ${thread}`)].join('\n'));
  }

  if (params.relatedBlocks.length > 0) {
    blocks.push(relatedSection(params.relatedBlocks));
  }

  blocks.push(`【本次要求】\n续写 ${params.count} 章。`);
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------- 合成可读梗概

/**
 * 把结构化章节合成可读梗概，写进 outlineTree 提案。
 *
 * 采用后它就是大纲节点的梗概 —— 作者要能一眼看出「这一章写什么」，
 * 所以场清单/冲突/钩子/引用设定/伏笔都保留；空列表整段不渲染，避免空标题。
 */
export function composeFrontierSynopsis(chapter: FrontierChapter): string {
  const lines: string[] = [chapter.synopsis.trim()];

  if (chapter.scenes.length > 0) {
    lines.push('', '场清单：', ...chapter.scenes.map((scene) => `- ${scene.trim()}`));
  }
  if (chapter.conflict.trim()) lines.push('', `主冲突：${chapter.conflict.trim()}`);
  if (chapter.hook.trim()) lines.push('', `章末钩子：${chapter.hook.trim()}`);
  if (chapter.usesEntries.length > 0) {
    lines.push('', `引用设定：${chapter.usesEntries.map((name) => name.trim()).join('、')}`);
  }
  if (chapter.resolvesThreads.length > 0) {
    lines.push(
      '',
      `回收伏笔：${chapter.resolvesThreads.map((thread) => thread.trim()).join('、')}`,
    );
  }
  if (chapter.plantsThreads.length > 0) {
    lines.push('', `新埋伏笔：${chapter.plantsThreads.map((thread) => thread.trim()).join('、')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 服务

export interface OutlineContinueInput {
  novel: Novel;
  style: StyleProfile;
  /** 本书全部大纲节点（服务自己取尾部并决定追加位置） */
  outline: readonly OutlineNode[];
  /** 本书全部章节（服务取主线最近 3 章摘要）；外传章节会被排除 */
  chapters: readonly Chapter[];
  summaries: readonly ChapterSummary[];
  /** 已按通用/未删除过滤的条目；服务用 planningContext 选 core/related */
  entries: readonly KnowledgeEntry[];
  categories: readonly Category[];
  writingNorms?: readonly WritingNorm[];
  /** 续写章数 3–5 */
  count: number;
}

export interface OutlineContinueInjection {
  /** 渲染后的大纲尾部文本（空表示没有大纲） */
  outlineTail: string;
  rollingSummary: string;
  recentSummaries: RecentChapterPoint[];
  openThreads: string[];
  /** 核心设定块（pinned，进 system） */
  core: PlanningEntryBlock[];
  /** 相关设定块（名称命中，进 user） */
  related: PlanningEntryBlock[];
  /** 因预算未注入的条目（面板提示用，不进 prompt） */
  dropped: PlanningEntryBlock[];
}

export interface OutlineContinueResult {
  /** 本次提案的 batchId（ProposalInbox 按它查） */
  batchId: string;
  /** 已落库为 pending 的 outlineTree 提案 */
  proposal: Proposal;
  /** 追加位置：最后一个顶层节点（若它下面已有章节）；null=顶层 */
  parentId: string | null;
  parentTitle: string | null;
  /** 合成后的章节草稿（synopsis 已替换为可读梗概） */
  chapters: FrontierChapterDraft[];
  /** 可直接追加的 outlineTree 文本 */
  outlineText: string;
  /** 面板「本次依据」用 */
  injection: OutlineContinueInjection;
  /** system+user 的 token 估算，面板展示「本次依据」用 */
  promptTokens: number;
}

interface OutlineContinueDeps {
  repository: {
    createProposals(items: readonly Proposal[]): Promise<void>;
  };
  llm: LlmRunner;
}

/** 决定续写追加到哪里：最后一个顶层节点，且它下面已经有章节点；否则顶层追加 */
export function resolveContinueParent(nodes: readonly OutlineNode[]): {
  parentId: string | null;
  parentTitle: string | null;
} {
  const roots = sortNodes(nodes.filter((node) => node.parentId === null));
  const lastRoot = roots[roots.length - 1];
  if (!lastRoot) return { parentId: null, parentTitle: null };
  const hasChildren = nodes.some((node) => node.parentId === lastRoot.id);
  return hasChildren
    ? { parentId: lastRoot.id, parentTitle: lastRoot.title }
    : { parentId: null, parentTitle: null };
}

/** 主线最近 3 章（有摘要的）与累计伏笔 */
function recentContext(
  chapters: readonly Chapter[],
  summaries: readonly ChapterSummary[],
): { points: RecentChapterPoint[]; openThreads: string[] } {
  const summaryByChapter = new Map(
    summaries.map((summary) => [summary.chapterId, summary] as const),
  );
  const mainChapters = chaptersOfTrack(chapters, null);
  const withSummaries = mainChapters
    .map((chapter) => ({ chapter, summary: summaryByChapter.get(chapter.id) }))
    .filter(
      (item): item is { chapter: Chapter; summary: ChapterSummary } => item.summary !== undefined,
    );

  const points = withSummaries.slice(-RECENT_CHAPTER_COUNT).map(({ chapter, summary }) => ({
    // 章节有标题就用标题（作者给的名字比「第 N 章」更能定位），没有才回退序号
    label: chapter.title.trim() || chapterLabel(chapter, []),
    summary: summary.summary,
    keyEvents: summary.keyEvents,
  }));
  // 累计伏笔以主线最后一章摘要为准：摘要里存的就是「截至该章仍未收束」的累计清单
  const openThreads =
    withSummaries.length > 0 ? withSummaries[withSummaries.length - 1]!.summary.openThreads : [];
  return { points, openThreads };
}

/**
 * 生成前沿续写提案。
 *
 * 一次结构化调用；失败/截断直接抛给调用方（面板可重试），不写任何提案。
 * 成功时把 3–5 章合成一段 outlineTree 文本作为一条提案落库，作者可编辑后采用。
 */
export async function runOutlineContinue(
  deps: OutlineContinueDeps,
  input: OutlineContinueInput,
): Promise<OutlineContinueResult> {
  const { repository, llm } = deps;
  const { novel, style, outline, chapters, summaries, entries, categories, count } = input;

  if (!Number.isInteger(count) || count < FRONTIER_CHAPTER_MIN || count > FRONTIER_CHAPTER_MAX) {
    throw new Error(`续写章数需在 ${FRONTIER_CHAPTER_MIN}–${FRONTIER_CHAPTER_MAX} 之间`);
  }
  if (chaptersOfTrack(chapters, null).length === 0 && outline.length === 0) {
    throw new Error('还没有已写章节或大纲，无法续写');
  }

  const outlineTail = buildOutlineTail(outline);
  const { points: recentSummaries, openThreads } = recentContext(chapters, summaries);
  const rollingSummary = novel.rollingSummary.trim();

  // 用大纲尾部 + 进展 + 最近摘要 + 伏笔作为名称匹配文本；linkedEntryIds 为空：
  // 续写没有「当前节点」可以挂显式关联，相关设定全部来自名称命中
  const selection = selectPlanningEntries({
    texts: [
      renderOutlineTail(outlineTail),
      rollingSummary,
      ...recentSummaries.map(
        (point) => `${point.label}\n${point.summary}\n${point.keyEvents.join('；')}`,
      ),
      ...openThreads,
    ],
    entries,
    categories,
    linkedEntryIds: [],
  });

  const system = buildOutlineContinueSystemPrompt(novel, style, input.writingNorms, selection.core);
  const user = buildOutlineContinueUserPrompt({
    outlineTail,
    rollingSummary,
    recentSummaries,
    openThreads,
    relatedBlocks: selection.related,
    count,
  });

  const result = await llm.runStructured('outline-continue', {
    schema: FrontierOutlineSchema,
    schemaName: 'FrontierOutline',
    system,
    user,
    failOnTruncation: true,
  });

  const drafts: FrontierChapterDraft[] = result.data.chapters.map((chapter) => ({
    ...chapter,
    synopsis: composeFrontierSynopsis(chapter),
  }));

  const outlineText = serializeOutlineTree(
    drafts.map((chapter) => ({
      title: chapter.title,
      synopsis: chapter.synopsis,
      targetWords: chapter.targetWords,
      children: [],
    })),
  );

  const { parentId, parentTitle } = resolveContinueParent(outline);
  const batchId = newBatchId();
  const proposal = buildCreateProposal({
    novelId: novel.id,
    batchId,
    order: 0,
    origin: 'generate',
    target: 'outlineTree',
    label: `续写 ${count} 章`,
    specs: fieldSpecsFor('outlineTree'),
    sourceRef: parentTitle ?? '全书大纲',
    payload: {
      outlineText,
      ...(parentId ? { parentId } : {}),
    },
  });
  await repository.createProposals([proposal]);

  return {
    batchId,
    proposal,
    parentId,
    parentTitle,
    chapters: drafts,
    outlineText,
    injection: {
      outlineTail: outlineTail.length > 0 ? renderOutlineTail(outlineTail) : '',
      rollingSummary,
      recentSummaries,
      openThreads,
      core: selection.core,
      related: selection.related,
      dropped: selection.dropped,
    },
    promptTokens: estimateTokens(system) + estimateTokens(user),
  };
}
