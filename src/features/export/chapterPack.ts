/**
 * 分章打包导出：每章一个文件、整本一个 zip。
 *
 * 与「全书一个文件」的导出分开放：整本单文件适合通读，分章打包适合投稿、
 * 搬去别的写作软件、或者交给排版。拆成「计划」与「按计划生成」两步，
 * 是因为导出面板要即时显示文件列表与字数，而真正生成 PDF/RTF 与压缩
 * 只在点下载时才做 —— 计划必须是同步的纯计算。
 *
 * 依赖方向：内容格式（txt/md）复用 exportText，rtf/pdf 由 formats 模块渲染，
 * 本模块只负责命名、分组与打包，不再实现一遍排版。
 */
import type { Chapter, Novel, SideStory } from '@/domain/schema';
import { chaptersOfTrack, sideStoryLabel } from '@/domain/sideStory';
import { chapterHeading, formatChapter } from './exportText';
import { renderChapterPdf } from './pdf';
import { renderRtfDocument } from './rtf';
import { createZip, type ZipEntry } from './zip';

export type PackFormat = 'markdown' | 'txt' | 'rtf' | 'pdf';

export const PACK_FORMAT_EXTENSIONS: Record<PackFormat, string> = {
  markdown: 'md',
  txt: 'txt',
  rtf: 'rtf',
  pdf: 'pdf',
};

export interface PackOptions {
  defaultFormat: PackFormat;
  /** chapterId → 该章覆盖默认格式；没有的章用 defaultFormat */
  formats?: Readonly<Record<string, PackFormat>>;
  /** 只导出已完成的章节（默认 false） */
  doneOnly?: boolean;
  /** 附带外传（默认 false）；外传章节各进自己的子文件夹 */
  includeSideStories?: boolean;
}

export interface PackFile {
  /** 稳定键 = chapter.id */
  chapterId: string;
  /** 文件名（不含文件夹），如「第001章 离乡.txt」 */
  name: string;
  /** zip 内完整路径（含书名文件夹），如「归墟纪/第001章 离乡.txt」 */
  path: string;
  format: PackFormat;
  /** 章节正文字符数（content.trim().length） */
  chars: number;
}

/**
 * 内容生成所需的原始对象快照。
 *
 * `PackPlan` 是给面板看的纯数据（章节正文可能几十万字，不该在计划里复制），
 * 而 `buildChapterPackZip` 只拿到 plan，需要按 chapterId 回查章节本体，
 * 所以计划里带一份对象引用。UI 不读它。
 */
export interface PackSource {
  novel: Novel;
  chaptersById: ReadonlyMap<string, Chapter>;
  sideStoriesById: ReadonlyMap<string, SideStory>;
}

export interface PackPlan {
  /** 净化后的书名，用作 zip 根文件夹名；空书名回退「未命名作品」 */
  bookTitle: string;
  /** 下载文件名，如「归墟纪.zip」 */
  zipFileName: string;
  /** 主线条目在前（按 index 升序），外传在后（按外传顺序，各自按 index 升序） */
  files: PackFile[];
  /** files 的正文字符数合计 */
  totalChars: number;
  /** 被跳过的章节数（草稿被 doneOnly 排除 + 空章节） */
  skipped: number;
  /** 内部快照：planChapterPack 填上，buildChapterPackZip 用；UI 不读 */
  readonly source?: PackSource;
}

/** 文件名里 Windows 与多数解压器都不接受的字符，以及会把名字拆断的控制字符 */
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|\p{Cc}]/gu;
/** 章标题（以及作为 zip 根文件夹名的书名）最多 40 个字符：再长只是把文件名变成正文开头 */
const MAX_TITLE_CHARS = 40;
/** 章号至少补到 3 位，目录里「第010章」对齐；超过 999 章自然变 4 位 */
const MIN_INDEX_DIGITS = 3;
const FALLBACK_BOOK_TITLE = '未命名作品';
const FALLBACK_SIDE_STORY_FOLDER = '外传';

/**
 * 净化成跨平台安全的文件名片段：去掉敏感字符与控制字符、trim 首尾空白，
 * 去掉结尾的 `.`（Windows 会静默吞掉，可能和相邻文件撞名），再按**字符**
 * （码位而不是 UTF-16 码元）截断，别把 emoji 切成半个代理对。
 */
function sanitizeFileName(raw: string, maxChars = Number.POSITIVE_INFINITY): string {
  const cleaned = raw.replace(FORBIDDEN_NAME_CHARS, '').trim();
  const chars = Array.from(cleaned);
  const clipped = chars.length > maxChars ? chars.slice(0, maxChars).join('') : cleaned;
  // 截断或去字符之后可能又露出结尾的空白/句点，一起收掉才是最终名字
  return clipped.replace(/[.\s]+$/u, '').trim();
}

function bookTitleOf(novel: Novel): string {
  // 书名同时是 zip 根文件夹名：不截断的话 120 个汉字 ≈ 360 UTF-8 字节，会超过
  // 常见文件系统 255 字节的单级名字上限，解压时可能直接建不出目录。与章标题同规
  return sanitizeFileName(novel.title, MAX_TITLE_CHARS) || FALLBACK_BOOK_TITLE;
}

function sideStoryFolder(story: SideStory): string {
  // 外传名是 schema 必填，但这里仍按「空标题回退」兜底：计划是纯数据，不假设来源
  if (story.title.trim() === '') return FALLBACK_SIDE_STORY_FOLDER;
  return sanitizeFileName(sideStoryLabel(story)) || FALLBACK_SIDE_STORY_FOLDER;
}

interface SelectedChapters {
  chapters: Chapter[];
  skipped: number;
}

/** 一条线里真正要导出的章节；跳过规则与现有导出保持一致 */
function selectChapters(
  chapters: readonly Chapter[],
  sideStoryId: string | null,
  doneOnly: boolean,
): SelectedChapters {
  const selected: Chapter[] = [];
  let skipped = 0;
  for (const chapter of chaptersOfTrack(chapters, sideStoryId)) {
    if (doneOnly && chapter.status !== 'done') {
      skipped += 1;
      continue;
    }
    // 空章节不导出：zip 里不该出现只有标题的空文件
    if (chapter.content.trim().length === 0) {
      skipped += 1;
      continue;
    }
    selected.push(chapter);
  }
  return { chapters: selected, skipped };
}

/**
 * 每条线按**实际导出的最大 index** 决定补零位数：一条线只有 12 章时是 3 位，
 * 1200 章时整条线一起变 4 位 —— 同一线内字典序才始终等于章序。
 */
function indexDigits(selected: readonly Chapter[]): number {
  const last = selected[selected.length - 1];
  const maxIndex = last ? last.index : 0;
  return Math.max(MIN_INDEX_DIGITS, String(maxIndex).length);
}

function chapterFileName(chapter: Chapter, digits: number, format: PackFormat): string {
  const title = sanitizeFileName(chapter.title, MAX_TITLE_CHARS);
  const stem = `第${String(chapter.index).padStart(digits, '0')}章${title ? ` ${title}` : ''}`;
  return `${stem}.${PACK_FORMAT_EXTENSIONS[format]}`;
}

function appendTrackFiles(
  files: PackFile[],
  bookTitle: string,
  folder: string,
  selected: readonly Chapter[],
  options: PackOptions,
): void {
  const digits = indexDigits(selected);
  for (const chapter of selected) {
    const format = options.formats?.[chapter.id] ?? options.defaultFormat;
    const name = chapterFileName(chapter, digits, format);
    files.push({
      chapterId: chapter.id,
      name,
      path: `${bookTitle}/${folder ? `${folder}/` : ''}${name}`,
      format,
      chars: chapter.content.trim().length,
    });
  }
}

/** 只做计划：不生成文件内容，供导出面板即时渲染（同步、快） */
export function planChapterPack(
  novel: Novel,
  chapters: Chapter[],
  sideStories: SideStory[],
  options: PackOptions,
): PackPlan {
  const bookTitle = bookTitleOf(novel);
  const doneOnly = options.doneOnly === true;
  const files: PackFile[] = [];
  let skipped = 0;

  const main = selectChapters(chapters, null, doneOnly);
  skipped += main.skipped;
  appendTrackFiles(files, bookTitle, '', main.chapters, options);

  if (options.includeSideStories === true) {
    // 外传按自己的 order 排；同 order 保持传入顺序（Array.sort 稳定）
    for (const story of [...sideStories].sort((a, b) => a.order - b.order)) {
      const side = selectChapters(chapters, story.id, doneOnly);
      skipped += side.skipped;
      appendTrackFiles(files, bookTitle, sideStoryFolder(story), side.chapters, options);
    }
  }

  const totalChars = files.reduce((sum, file) => sum + file.chars, 0);

  return {
    bookTitle,
    zipFileName: `${bookTitle}.zip`,
    files,
    totalChars,
    skipped,
    source: {
      novel,
      chaptersById: new Map(chapters.map((chapter) => [chapter.id, chapter])),
      sideStoriesById: new Map(sideStories.map((story) => [story.id, story])),
    },
  };
}

function chapterParagraphs(content: string): string[] {
  const trimmed = content.trim();
  return trimmed === '' ? [] : trimmed.split(/\r?\n/u);
}

/** 按该章格式生成一份文件内容；txt/md 与现有单章导出逐字节一致 */
function renderPackContent(
  file: PackFile,
  chapter: Chapter,
  sideStory: SideStory | undefined,
  novel: Novel,
): string | Uint8Array {
  if (file.format === 'txt' || file.format === 'markdown') {
    return formatChapter(chapter, file.format, sideStory);
  }
  const document = {
    title: chapterHeading(chapter, sideStory),
    subtitle: novel.title.trim(),
    paragraphs: chapterParagraphs(chapter.content),
  };
  return file.format === 'rtf' ? renderRtfDocument(document) : renderChapterPdf(document);
}

/** 按计划生成各章内容并打包 zip（异步：zip 压缩是异步的） */
export async function buildChapterPackZip(plan: PackPlan, now?: Date): Promise<Uint8Array> {
  // 生成失败要让 Promise reject 到 UI 的「打包失败，请重试」，不能静默吞掉
  const source = plan.source;
  if (!source) throw new Error('打包计划缺少章节来源，无法生成内容');

  const entries: ZipEntry[] = plan.files.map((file) => {
    const chapter = source.chaptersById.get(file.chapterId);
    if (!chapter) throw new Error(`打包计划里的章节已不存在：${file.chapterId}`);
    const sideStory =
      chapter.sideStoryId === null ? undefined : source.sideStoriesById.get(chapter.sideStoryId);
    return {
      path: file.path,
      data: renderPackContent(file, chapter, sideStory, source.novel),
    };
  });

  return createZip(entries, { now });
}
