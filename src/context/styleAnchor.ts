/**
 * 文风锚点（M4 S1）。
 *
 * 「写着写着文风漂了」的根因之一是：后续章节的 prompt 里只有风格档案（抽象描述）
 * 和上一章结尾（几百字），模型没有一个稳定的「作者本人语感」对照物。锚点就是
 * 从作者此前写下的正文里取一段原文，放进稳定前缀，让模型对齐句式、节奏与叙述距离。
 *
 * 三条刻意的约束：
 * 1. **只取同一线、目标章之前**：主线不拿外传当锚点，外传也不拿主线；
 * 2. **优先已完成章**：完成章是作者认可的最终文本；草稿可能还会改；
 * 3. **只取开头**：开头进入得最稳、受情节影响最小；结尾常是钩子，句式反而特殊。
 *
 * 纯本地确定性选择，不调模型、不落库、不新增字段。
 */
import type { Chapter } from '@/domain/schema';

/** 锚点最多取多少字：约 600 字足够对齐语感，再多只是占预算 */
export const STYLE_ANCHOR_CHARS = 600;
/** 少于这个字数不足以代表语感（对话、单句场景会严重高估作者风格） */
export const STYLE_ANCHOR_MIN_CHARS = 300;

export interface StyleAnchor {
  chapterId: string;
  index: number;
  /** 「第 N 章开头」；外传传 chapterWord='外传第' 时是「外传第 N 章开头」 */
  label: string;
  /** 从开头截取（超过上限时按段落边界截断并补「……」） */
  text: string;
}

/**
 * 从一段正文开头截取锚点文本。
 *
 * 按空行分段累加，超过上限就停在最近一个段落边界 —— 截在半句上比少一段更伤语感。
 * 整章没有空行（或第一段就超过上限）时退回按字数硬截，保证锚点不会为空。
 */
function excerptFromStart(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= STYLE_ANCHOR_CHARS) return trimmed;

  const paragraphs = trimmed
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const parts: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    // 段与段之间的空行也算两个字，估长度时一并计入
    const added = parts.length === 0 ? paragraph.length : paragraph.length + 2;
    if (length + added > STYLE_ANCHOR_CHARS) break;
    parts.push(paragraph);
    length += added;
  }

  if (parts.length === 0) {
    return `${trimmed.slice(0, STYLE_ANCHOR_CHARS)}……`;
  }
  return `${parts.join('\n\n')}……`;
}

/**
 * 选一段作者原文作为文风锚点。
 *
 * @param chapters 同一线的章节（调用方通常传 `chaptersOfTrack(chapters, track)`；
 *                 这里仍会按目标章的线再过滤一次，防御误传）
 * @param targetChapterId 正在写的章节；为空表示还不知道要写哪一章 → 不注入
 * @param chapterWord 标签前缀：主线用默认「第」，外传传「外传第」
 */
export function selectStyleAnchor(
  chapters: readonly Chapter[],
  targetChapterId: string | null,
  chapterWord = '第',
): StyleAnchor | null {
  if (!targetChapterId) return null;
  const target = chapters.find((chapter) => chapter.id === targetChapterId);
  if (!target) return null;

  const track = target.sideStoryId ?? null;
  const earlier = chapters
    .filter(
      (chapter) =>
        (chapter.sideStoryId ?? null) === track &&
        chapter.index < target.index &&
        chapter.content.trim().length >= STYLE_ANCHOR_MIN_CHARS,
    )
    .sort((a, b) => a.index - b.index);

  // 没有足够长的更早正文：第一章或导入时正文还没补，就不注入，逐字节保持原行为
  const firstCandidate = earlier[0];
  if (!firstCandidate) return null;

  // 已完成章优先；都在改稿阶段时退而取最早有正文的一章
  const chosen = earlier.find((chapter) => chapter.status === 'done') ?? firstCandidate;

  return {
    chapterId: chosen.id,
    index: chosen.index,
    label: `${chapterWord} ${chosen.index} 章开头`,
    text: excerptFromStart(chosen.content),
  };
}
