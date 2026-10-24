import type { Chapter, Novel, SideStory } from '@/domain/schema';
import { chapterLabel, chaptersOfTrack, sideStoryLabel } from '@/domain/sideStory';

/**
 * 正文导出。
 *
 * 作品必须能带走：这是用户敢把几十万字放进一个浏览器里的前提。
 * 两种格式都是纯文本，不引入任何打包依赖 —— Markdown 给投稿与排版工具，
 * 纯文本给不认 Markdown 的平台编辑器。
 */

export type ExportFormat = 'markdown' | 'txt';

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  markdown: 'md',
  txt: 'txt',
};

export interface ExportOptions {
  format: ExportFormat;
  /** 只导出已完成的章节 */
  doneOnly?: boolean;
  /** 带上书名、体裁、一句话故事的开头 */
  includeFrontMatter?: boolean;
  /**
   * 全书导出时附带的外传，按数组顺序追加在主线之后，各自一个「外传·X」标题。
   * 不传或为空时只导出主线
   */
  sideStories?: { story: SideStory; chapters: Chapter[] }[];
}

/**
 * 章节标题：没填标题时退回「第 N 章」，不要导出一个空标题行。
 *
 * 单独导出外传章节时传 sideStory，无标题时退回「外传·X 第 N 章」，
 * 免得和主线同编号的章节同名。外传章节排在「外传·X」标题之下时不传，正文里不重复外传名
 */
export function chapterHeading(chapter: Chapter, sideStory?: SideStory): string {
  const title = chapter.title.trim();
  if (title) return title;
  return sideStory ? chapterLabel(chapter, [sideStory]) : `第 ${chapter.index} 章`;
}

/** 单章导出 */
export function formatChapter(
  chapter: Chapter,
  format: ExportFormat,
  sideStory?: SideStory,
): string {
  const heading = chapterHeading(chapter, sideStory);
  const body = chapter.content.trim();
  if (format === 'markdown') {
    return body ? `## ${heading}\n\n${body}\n` : `## ${heading}\n`;
  }
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`;
}

/** 某一条线里要导出的章节，按章节序号排序 */
function exportableChapters(
  chapters: Chapter[],
  sideStoryId: string | null,
  options: ExportOptions,
): Chapter[] {
  return (
    chaptersOfTrack(chapters, sideStoryId)
      .filter((chapter) => (options.doneOnly ? chapter.status === 'done' : true))
      // 空章节不导出：目录里凭空多出几个只有标题的条目没有意义
      .filter((chapter) => chapter.content.trim().length > 0)
  );
}

function heading1(text: string, format: ExportFormat): string {
  return format === 'markdown' ? `# ${text}` : text;
}

function frontMatter(novel: Novel): string {
  const meta: string[] = [];
  if (novel.genre.trim()) meta.push(`体裁：${novel.genre.trim()}`);
  if (novel.oneLiner.trim()) meta.push(`故事内核：${novel.oneLiner.trim()}`);
  return meta.join('\n');
}

/** 全书导出，按章节序号排序。只取主线；外传要经 options.sideStories 显式附带 */
export function formatNovel(novel: Novel, chapters: Chapter[], options: ExportOptions): string {
  const selected = exportableChapters(chapters, null, options);

  const blocks: string[] = [];

  blocks.push(heading1(novel.title.trim() || '未命名作品', options.format));

  if (options.includeFrontMatter) {
    const meta = frontMatter(novel);
    if (meta) blocks.push(meta);
  }

  for (const chapter of selected) {
    blocks.push(formatChapter(chapter, options.format).trimEnd());
  }

  for (const side of options.sideStories ?? []) {
    const sideChapters = exportableChapters(side.chapters, side.story.id, options);
    // 没有可导出章节的外传不留一个孤零零的标题
    if (sideChapters.length === 0) continue;
    blocks.push(heading1(sideStoryLabel(side.story), options.format));
    for (const chapter of sideChapters) {
      blocks.push(formatChapter(chapter, options.format).trimEnd());
    }
  }

  return `${blocks.join('\n\n')}\n`;
}

/** 单独导出一部外传，开头是「书名 · 外传·X」 */
export function formatSideStory(
  novel: Novel,
  story: SideStory,
  chapters: Chapter[],
  options: ExportOptions,
): string {
  const book = novel.title.trim() || '未命名作品';
  const blocks: string[] = [heading1(`${book} · ${sideStoryLabel(story)}`, options.format)];

  if (options.includeFrontMatter) {
    const meta = frontMatter(novel);
    if (meta) blocks.push(meta);
  }

  for (const chapter of exportableChapters(chapters, story.id, options)) {
    blocks.push(formatChapter(chapter, options.format).trimEnd());
  }

  return `${blocks.join('\n\n')}\n`;
}

/** 导出文件名。去掉文件系统敏感字符，避免下载失败或落到别的目录 */
export function exportFileName(
  novel: Novel,
  scope:
    | { kind: 'novel' }
    | { kind: 'chapter'; chapter: Chapter; sideStory?: SideStory }
    | { kind: 'side'; story: SideStory },
  format: ExportFormat,
): string {
  const safe = (value: string) => value.replace(/[\\/:*?"<>|\n\r]/gu, '').trim();
  const book = safe(novel.title) || '未命名作品';
  let suffix = '';
  if (scope.kind === 'side') {
    suffix = ` - ${safe(sideStoryLabel(scope.story)) || '外传'}`;
  } else if (scope.kind === 'chapter' && scope.sideStory) {
    // 外传单章固定以「外传·X 第 N 章」开头，有标题再接标题：不会和主线同名章节撞名
    const title = scope.chapter.title.trim();
    const label = `${chapterLabel(scope.chapter, [scope.sideStory])}${title ? ` ${title}` : ''}`;
    suffix = ` - ${safe(label) || '章节'}`;
  } else if (scope.kind === 'chapter') {
    suffix = ` - ${safe(chapterHeading(scope.chapter)) || '章节'}`;
  }
  return `${book}${suffix}.${FORMAT_EXTENSIONS[format]}`;
}

/** 导出内容的体量，用于在按钮上给出预期 */
export function exportStats(text: string): { chars: number; lines: number } {
  const trimmed = text.trim();
  return {
    chars: trimmed.length,
    lines: trimmed ? trimmed.split('\n').length : 0,
  };
}
