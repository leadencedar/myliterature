import { z } from 'zod';
import type { Chapter, ChapterSummary, KnowledgeEntry, Novel, WritingNorm } from '@/domain/schema';
import { chaptersOfTrack } from '@/domain/sideStory';
import { composeSections, novelMetaSection, writingNormsSection } from '@/prompt/sections';

/**
 * 章节摘要链。
 *
 * 长篇连贯性的骨架：每章写完后提炼摘要、关键事件、出场角色与未收束伏笔，
 * 后续章节的生成只注入这些摘要而不是原文，才能在成本可控的前提下
 * 让模型知道前面发生过什么。
 *
 * 关于 `openThreads` 的语义需要明确：它存的是**截至本章仍未收束的伏笔（累计）**，
 * 不是「本章新埋的伏笔」。这样上下文装箱时只取最近一章的摘要就能拿到完整的
 * 待收束清单，不必回溯全书做集合运算。
 */

export const ChapterSummaryResultSchema = z.object({
  summary: z.string().min(1, '摘要不能为空'),
  keyEvents: z.array(z.string().min(1)).min(1, '至少给出一个关键事件'),
  /** 本章出场的人物/设定名称，需从给定清单中选取 */
  appearingEntries: z.array(z.string()),
  /** 本章新埋下的伏笔 */
  newOpenThreads: z.array(z.string()),
  /** 本章收束掉的、此前遗留的伏笔 */
  resolvedThreads: z.array(z.string()),
  /** 更新后的全书进展摘要 */
  rollingSummary: z.string().min(1, '全书进展摘要不能为空'),
});

export type ChapterSummaryResult = z.infer<typeof ChapterSummaryResultSchema>;

/**
 * 把模型给出的伏笔增减合并成新的累计清单。
 *
 * 收束判断按去除首尾空白后的原文匹配：模型被要求原样抄回要收束的条目，
 * 但仍可能带上标点差异，所以同时做一次宽松匹配（去掉标点后比较）。
 */
export function mergeOpenThreads(
  previous: string[],
  resolved: string[],
  added: string[],
): string[] {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/[\s，。；、,.;]/gu, '')
      .toLowerCase();
  const resolvedKeys = new Set(resolved.map(normalize).filter(Boolean));

  const kept = previous.filter((thread) => !resolvedKeys.has(normalize(thread)));

  const seen = new Set(kept.map(normalize));
  const merged = [...kept];
  for (const thread of added) {
    const trimmed = thread.trim();
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged;
}

/** 把模型给出的名称解析成条目 id，按 title 与 aliases 匹配 */
export function resolveEntryNames(entries: KnowledgeEntry[], names: string[]): string[] {
  const normalize = (value: string) => value.trim().toLowerCase();
  const index = new Map<string, string>();
  for (const entry of entries) {
    index.set(normalize(entry.title), entry.id);
    for (const alias of entry.aliases) index.set(normalize(alias), entry.id);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const id = index.get(normalize(name));
    // 匹配不上的名称直接丢弃：宁可少记一个出场，也不要往库里塞不存在的 id
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * 取某章之前最近一份摘要，用于承接累计伏笔。
 * 只在同一条线内承接：主线的伏笔不会混进外传，反之亦然
 */
export function previousSummaryOf(
  chapters: Chapter[],
  summaries: ChapterSummary[],
  chapterId: string,
): ChapterSummary | undefined {
  const found = chapters.find((chapter) => chapter.id === chapterId);
  if (!found) return undefined;
  const sorted = chaptersOfTrack(chapters, found.sideStoryId ?? null);
  const target = sorted.find((chapter) => chapter.id === chapterId);
  if (!target) return undefined;

  for (let i = sorted.indexOf(target) - 1; i >= 0; i -= 1) {
    const candidate = sorted[i];
    if (!candidate) continue;
    const summary = summaries.find((item) => item.chapterId === candidate.id);
    if (summary) return summary;
  }
  return undefined;
}

// ---------------------------------------------------------------- 提示词

const SUMMARY_TASK = [
  '【任务】',
  '阅读给定的章节正文，提炼出供后续写作使用的摘要信息。',
  '',
  '要求：',
  '- summary：120 字以内，说清本章发生了什么、人物状态有何变化。只写发生过的事，不要评价，不要推测后续。',
  '- keyEvents：3–6 条，每条一句话，按时间顺序。只记会影响后续情节的事。',
  '- appearingEntries：本章真正出场或被实质提及的人物与设定，**只能从下面给出的名单中选**，名称原样抄写。名单里没有的不要编。',
  '- newOpenThreads：本章新埋下、尚未解释的悬念或伏笔。没有就给空数组，不要为凑数硬编。',
  '- resolvedThreads：本章解释或收束掉的**此前遗留**伏笔，必须从「当前未收束的伏笔」清单里原样抄回。没有就给空数组。',
  '- rollingSummary：更新后的全书进展摘要，300 字以内，覆盖从开篇到本章的主线进展与人物当前处境。它会替换旧版本，所以要写成完整独立的一段，不要写成增量补充。',
].join('\n');

/**
 * norms 是可选尾参数：不传或没有作用范围含「章节摘要」的规范时，输出与改动前逐字节相同。
 * 摘要是后续上下文的来源，带上规范能让模型区分「正文已确认的事实」与「仅属建议」，
 * 免得把建议写成事实一路滚下去；规范整本书稳定，不影响章与章之间的缓存命中
 */
export function buildSummarySystemPrompt(novel: Novel, norms?: readonly WritingNorm[]): string {
  return composeSections([
    '你是一位小说编辑助理，负责为连载中的作品维护剧情档案。',
    // 摘要任务与文风无关，只带作品信息：更省 token，而且这段前缀在全书各章之间完全一致，缓存命中率最高
    novelMetaSection(novel),
    writingNormsSection(norms, 'summary'),
    SUMMARY_TASK,
  ]);
}

export function buildSummaryUserPrompt(params: {
  chapter: Chapter;
  entryNames: string[];
  previousOpenThreads: string[];
  previousRollingSummary: string;
  /**
   * 外传章节传入所属外传。系统提示不变（与主线共用缓存），
   * 由这里的说明把 rollingSummary 的范围收窄到这部外传
   */
  sideStory?: { title: string; synopsis: string };
}): string {
  const blocks: string[] = [];
  const sideStory = params.sideStory;

  blocks.push(
    params.entryNames.length > 0
      ? `【可选的人物与设定名单】\n${params.entryNames.join('、')}`
      : '【可选的人物与设定名单】\n（知识库为空，appearingEntries 请给空数组）',
  );

  if (params.previousOpenThreads.length > 0) {
    blocks.push(
      [
        '【当前未收束的伏笔】',
        ...params.previousOpenThreads.map((thread) => `- ${thread}`),
        '若本章收束了其中某条，请在 resolvedThreads 里原样抄回。',
      ].join('\n'),
    );
  }

  if (params.previousRollingSummary.trim()) {
    const heading = sideStory
      ? `【此前的外传进展摘要（外传《${sideStory.title}》）】`
      : '【此前的全书进展摘要】';
    blocks.push(`${heading}\n${params.previousRollingSummary.trim()}`);
  }

  if (sideStory) {
    blocks.push(
      `本章属于外传《${sideStory.title}》，独立于主线。rollingSummary 只写这部外传从第一章到本章的进展，不要混入主线剧情。`,
    );
  }

  blocks.push(
    [
      `【本章正文（第 ${params.chapter.index} 章${
        params.chapter.title ? ` ${params.chapter.title}` : ''
      }）】`,
      params.chapter.content.trim(),
    ].join('\n'),
  );

  return composeSections(blocks);
}
