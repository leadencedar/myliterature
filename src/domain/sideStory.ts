/**
 * 外传的领域辅助。
 *
 * 不管是主线还是外传、是上下文、摘要、导出还是统计，「哪些章节算同一条线」
 * 都只从这里取。同一个判断写在五个地方，必然有一处漏掉。
 *
 * 线的键是 `sideStoryId ?? null`：null 是主线，否则是那部外传。
 */
import type { Chapter, SideStory } from './schema';

type TrackOf = Pick<Chapter, 'sideStoryId'>;

/** 是否主线章节。旧行可能没有 sideStoryId（迁移前），按主线处理 */
export function isMainChapter(chapter: TrackOf): boolean {
  return (chapter.sideStoryId ?? null) === null;
}

/** 取某一条线的章节，按 index 升序。sideStoryId 为 null 时取主线 */
export function chaptersOfTrack<T extends Pick<Chapter, 'sideStoryId' | 'index'>>(
  chapters: readonly T[],
  sideStoryId: string | null,
): T[] {
  return chapters
    .filter((chapter) => (chapter.sideStoryId ?? null) === sideStoryId)
    .sort((a, b) => a.index - b.index);
}

/** 「外传·青冥旧事」 */
export function sideStoryLabel(story: Pick<SideStory, 'title'>): string {
  return `外传·${story.title}`;
}

/** 「第 3 章」/「外传·青冥旧事 第 3 章」；找不到所属外传时退回「外传 第 3 章」 */
export function chapterLabel(
  chapter: Pick<Chapter, 'sideStoryId' | 'index'>,
  sideStories: readonly Pick<SideStory, 'id' | 'title'>[],
): string {
  const base = `第 ${chapter.index} 章`;
  const sideId = chapter.sideStoryId ?? null;
  if (sideId === null) return base;
  const story = sideStories.find((item) => item.id === sideId);
  return story ? `${sideStoryLabel(story)} ${base}` : `外传 ${base}`;
}

/**
 * 开头的「外传」「番外」及其后的分隔符（·・:：与空白）。
 * 后面必须跟分隔符或就此结束：「番外篇」「外传之谜」是标题本身，不是前缀
 */
const TITLE_PREFIX = /^(?:外传|番外)(?:[·・:：\s]+|$)/u;

/** trim；去掉开头的「外传」「番外」及其后的 ·・:：空白 */
export function normalizeSideStoryTitle(raw: string): string {
  return raw.trim().replace(TITLE_PREFIX, '').trim();
}

/** 外传重名判断唯一的比较键 */
export function sideStoryTitleKey(raw: string): string {
  return normalizeSideStoryTitle(raw).toLocaleLowerCase();
}

/**
 * 外传说明块正文（进外传章节 prompt 的易变后缀）。
 * 简介为空时整行省略，不输出空括号或占位。
 */
export function renderSideStoryBrief(story: Pick<SideStory, 'title' | 'synopsis'>): string {
  const lines = [`【本章属于外传《${story.title}》】`];
  const synopsis = story.synopsis.trim();
  if (synopsis) lines.push(`简介：${synopsis}`);
  lines.push(
    '外传独立于主线：不要写成主线的后续，也不要改动主线里已经发生的事；人物与设定以上面的知识库为准。',
  );
  return lines.join('\n');
}
