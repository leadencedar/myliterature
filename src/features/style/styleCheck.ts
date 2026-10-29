import { z } from 'zod';
import { selectStyleAnchor, type StyleAnchor } from '@/context/styleAnchor';
import { chaptersOfTrack } from '@/domain/sideStory';
import type { Chapter, Novel, StyleProfile } from '@/domain/schema';
import type { LlmRunner } from '@/llm/useLlm';
import { composeSections, composeStylePrefix } from '@/prompt/sections';

/**
 * 文风漂移检查（M4 S2）。
 *
 * 「写着写着文风漂了」写完之后才最容易察觉，但这时作者往往已经累了，最需要的不是
 * 自动改写，而是一份**有原文证据的短诊断**：哪一句开始不像自己、偏在哪个维度。
 * 所以这里刻意只做只读诊断 —— 不写正文、不出提案、不落库；改不改、怎么改由作者定。
 */

// ---------------------------------------------------------------- schema

export const StyleCheckSeveritySchema = z.enum(['low', 'medium', 'high']);
export type StyleCheckSeverity = z.infer<typeof StyleCheckSeveritySchema>;

export const StyleCheckIssueSchema = z.object({
  /** 七维 rubric 的维度名（句式/意象/叙述距离…），或「对话」这类具体层面 */
  dimension: z.string().min(1, '维度不能为空'),
  severity: StyleCheckSeveritySchema,
  /** 原文证据：必须逐字摘录本章正文里的连续片段，否则作者无法核对 */
  excerpt: z.string().min(1, '必须引用原文证据'),
  /**
   * 与风格档案/文风锚点的可观察差异（句长、叙述距离、对话密度、意象密度…）。
   * 只给建议不给依据会像判决：作者需要知道「差在哪」才能自己判断要不要改。
   */
  basis: z.string().min(1, '必须说明与风格档案/锚点的差异'),
  /** 具体怎么改，但不代写整段 */
  suggestion: z.string().min(1, '建议不能为空'),
});
export type StyleCheckIssue = z.infer<typeof StyleCheckIssueSchema>;

export const StyleCheckSchema = z.object({
  /** 整体判断，1–2 句 */
  summary: z.string().min(1, '整体判断不能为空'),
  /** 最多 5 条：诊断的价值在准，不在多 */
  issues: z.array(StyleCheckIssueSchema).max(5),
});
export type StyleCheckResult = z.infer<typeof StyleCheckSchema>;

export const STYLE_CHECK_SEVERITY_LABELS: Record<StyleCheckSeverity, string> = {
  // 统一成「程度」一个轴，去掉「局部/轻微」这类范围词，避免作者把范围和程度混着读
  high: '差异较大',
  medium: '有所差异',
  low: '略有差异',
};

// ---------------------------------------------------------------- 提示词

const STYLE_CHECK_OPENING = '你是一位文学编辑，负责诊断一段章节正文是否偏离了作者此前定下的文风。';

export const STYLE_CHECK_TASK = [
  '【任务】',
  '对照上面的风格档案与文风锚点，诊断下面这段章节正文的文风漂移问题。',
  '',
  '要求：',
  '- 只诊断，不改稿：不要输出改写后的正文，也不要给可以整段替换的成文。',
  '- 每个问题必须逐字引用正文里的连续原文作为证据；找不到证据就不要报。',
  '- 最多 5 条，按严重程度从高到低；没有明显问题就给空数组，不要为凑数硬找。',
  '- 维度优先用风格档案里的七维 rubric 名称；不适用时用「对话」「节奏」这类具体层面，不要自造术语。',
  '- 不要把情节好坏、题材选择、人物三观当成文风问题。',
  '- summary 用一两句说整体像不像作者本人的文字，不要复述问题清单。',
  '- basis：说明这句与本作品风格档案/文风锚点的可观察差异，例如句长、叙述距离、对话密度、意象密度、用词习惯；只谈写法，不评情节好坏。',
  '- severity：high = 差异较大；medium = 有所差异；low = 略有差异。',
].join('\n');

/** 系统提示：开场白 + 风格档案（含作品信息），整本书稳定，可命中缓存 */
export function buildStyleCheckSystemPrompt(novel: Novel, style: StyleProfile): string {
  return composeSections([STYLE_CHECK_OPENING, composeStylePrefix(novel, style), STYLE_CHECK_TASK]);
}

/** 锚点块：注明这是作者原文、只对齐语感，避免模型照搬情节与句子 */
export const STYLE_ANCHOR_BLOCK_TITLE =
  '【文风锚点（作者本人此前正文，只对齐语感，不要照搬情节）】';

export function buildStyleCheckUserPrompt(params: {
  anchor: StyleAnchor | null;
  /** 当前编辑中的本章正文（可能尚未落盘） */
  content: string;
}): string {
  const blocks: string[] = [];
  if (params.anchor) {
    blocks.push(`${STYLE_ANCHOR_BLOCK_TITLE}\n${params.anchor.text}`);
  }
  blocks.push(`【本章正文】\n${params.content.trim()}`);
  blocks.push(
    ['【本次要求】', '只输出结构化诊断：整体判断 + 最多 5 条问题；不要改写正文。'].join('\n'),
  );
  return composeSections(blocks);
}

// ---------------------------------------------------------------- 服务

export interface StyleCheckDeps {
  llm: LlmRunner;
}

export interface StyleCheckInput {
  novel: Novel;
  style: StyleProfile;
  /** 当前编辑中的章节快照：content 用编辑器里的最新正文 */
  chapter: Chapter;
  /** 全部章节：用于挑同一线的文风锚点 */
  chapters: readonly Chapter[];
  targetChapterId: string;
}

export interface StyleCheckRunResult {
  result: StyleCheckResult;
  /** 本次对照的锚点；第一章/没有更早正文时为 null（user prompt 里也没有锚点块） */
  anchor: StyleAnchor | null;
}

/**
 * 一次结构化调用做文风诊断。不写库、不出提案、不持有结果：
 * 结果只在面板会话里展示，正文一改就过期，重查一次即可。
 */
export async function runStyleCheck(
  deps: StyleCheckDeps,
  input: StyleCheckInput,
): Promise<StyleCheckRunResult> {
  const content = input.chapter.content.trim();
  if (!content) throw new Error('本章还没有正文，无法检查文风');

  const sameTrack = chaptersOfTrack(input.chapters, input.chapter.sideStoryId ?? null);
  const anchor = selectStyleAnchor(
    sameTrack,
    input.targetChapterId,
    input.chapter.sideStoryId ? '外传第' : '第',
  );

  const system = buildStyleCheckSystemPrompt(input.novel, input.style);
  const user = buildStyleCheckUserPrompt({ anchor, content });

  const { data } = await deps.llm.runStructured('style-check', {
    schema: StyleCheckSchema,
    schemaName: 'StyleCheck',
    system,
    user,
    failOnTruncation: true,
  });

  return { result: data, anchor };
}
