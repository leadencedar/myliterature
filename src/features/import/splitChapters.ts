import { countWords } from '@/domain/primitives';

/**
 * 旧稿分章。
 *
 * 用户粘贴进来的是一整坨文本，要先切成章节才能逐章提取设定。
 * 中文小说的章节标题格式相当固定（「第X章」「第X回」「楔子」等），
 * 因此默认走内置规则；但总有格式特殊的稿子，所以同时提供
 * 「整篇作为一章」与「自定义正则」两条退路，并且切分结果始终可以人工调整。
 */

export type SplitMode = 'auto' | 'single' | 'custom';

export interface ChapterDraft {
  /** 从 1 开始的序号，切分后重新编号 */
  index: number;
  title: string;
  content: string;
  wordCount: number;
}

/**
 * 内置的章节标题规则。
 *
 * 只认「章 / 回 / 节 / 话」，刻意不认「卷」—— 卷是章的上层，
 * 把卷标题也当成章会切出一堆只有标题没有正文的空章。
 */
const HEADING_PATTERN =
  /^\s*(?:第\s*[0-9０-９一二三四五六七八九十百千零〇两]{1,8}\s*[章回节话](?:\s|$|[^\n]{0,40})|Chapter\s*\d{1,4}(?:[\s:：][^\n]{0,40})?|楔子|序章|序言|引子|尾声|终章|后记|番外[^\n]{0,20})\s*$/u;

/** 标题行不应该太长：正文里出现「第三章」这种句子不该被误判成标题 */
const MAX_HEADING_LENGTH = 50;

/** 开头没有标题的部分，短于这个长度就认为是书名、简介之类的杂项而丢弃 */
const PREAMBLE_KEEP_THRESHOLD = 200;

export interface HeadingHit {
  /** 在行数组中的下标 */
  lineIndex: number;
  title: string;
}

/** 找出所有章节标题行 */
export function detectChapterHeadings(
  text: string,
  pattern: RegExp = HEADING_PATTERN,
): HeadingHit[] {
  const lines = text.split(/\r?\n/u);
  const hits: HeadingHit[] = [];

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return;
    if (!pattern.test(trimmed)) return;
    hits.push({ lineIndex, title: trimmed });
  });

  return hits;
}

/** 编译用户提供的正则；非法或过于宽松时返回 undefined */
export function compileCustomPattern(source: string): RegExp | undefined {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  try {
    const pattern = new RegExp(trimmed, 'u');
    // 能匹配空串的正则会把每一行都当成标题，等于没切
    if (pattern.test('')) return undefined;
    return pattern;
  } catch {
    return undefined;
  }
}

export interface SplitOptions {
  mode: SplitMode;
  /** mode 为 custom 时使用 */
  customPattern?: string;
}

export function splitChapters(
  text: string,
  options: SplitOptions = { mode: 'auto' },
): ChapterDraft[] {
  const normalized = text.replace(/\r\n?/gu, '\n');
  if (!normalized.trim()) return [];

  if (options.mode === 'single') {
    return [makeDraft(1, '', normalized)];
  }

  const pattern =
    options.mode === 'custom' ? compileCustomPattern(options.customPattern ?? '') : HEADING_PATTERN;

  // 自定义正则不可用时退化为整篇一章，而不是静默返回空结果
  if (!pattern) return [makeDraft(1, '', normalized)];

  const lines = normalized.split('\n');
  const headings = detectChapterHeadings(normalized, pattern);
  if (headings.length === 0) return [makeDraft(1, '', normalized)];

  const drafts: ChapterDraft[] = [];

  // 第一个标题之前的内容：足够长才保留，否则视作书名/简介之类的杂项
  const preamble = lines.slice(0, headings[0]!.lineIndex).join('\n');
  if (countWords(preamble) >= PREAMBLE_KEEP_THRESHOLD) {
    drafts.push(makeDraft(drafts.length + 1, '（开头部分）', preamble));
  }

  headings.forEach((heading, position) => {
    const nextHeading = headings[position + 1];
    const from = heading.lineIndex + 1;
    const to = nextHeading ? nextHeading.lineIndex : lines.length;
    const body = lines.slice(from, to).join('\n');
    drafts.push(makeDraft(drafts.length + 1, heading.title, body));
  });

  // 丢掉只有标题没有正文的条目：通常是卷标题或目录残留
  return drafts
    .filter((draft) => draft.wordCount > 0)
    .map((draft, position) => ({
      ...draft,
      index: position + 1,
    }));
}

function makeDraft(index: number, title: string, content: string): ChapterDraft {
  const trimmed = content.trim();
  return { index, title, content: trimmed, wordCount: countWords(trimmed) };
}

/** 合并相邻两章，用于人工修正「切多了」的情况 */
export function mergeWithPrevious(drafts: ChapterDraft[], index: number): ChapterDraft[] {
  const position = drafts.findIndex((draft) => draft.index === index);
  if (position <= 0) return drafts;

  const previous = drafts[position - 1]!;
  const current = drafts[position]!;
  const merged = makeDraft(
    previous.index,
    previous.title,
    // 被并入的章节标题作为一行保留，否则正文里会凭空缺一段
    [previous.content, current.title, current.content].filter(Boolean).join('\n\n'),
  );

  return [...drafts.slice(0, position - 1), merged, ...drafts.slice(position + 1)].map(
    (draft, order) => ({ ...draft, index: order + 1 }),
  );
}

/** 删除某一章，用于剔除目录、版权页之类的杂项 */
export function removeChapter(drafts: ChapterDraft[], index: number): ChapterDraft[] {
  return drafts
    .filter((draft) => draft.index !== index)
    .map((draft, order) => ({ ...draft, index: order + 1 }));
}

/** 改章节标题 */
export function renameChapter(
  drafts: ChapterDraft[],
  index: number,
  title: string,
): ChapterDraft[] {
  return drafts.map((draft) => (draft.index === index ? { ...draft, title } : draft));
}

export interface SplitSummary {
  chapterCount: number;
  totalWords: number;
  /** 明显偏短的章节数量，提示用户可能切错了 */
  suspiciousCount: number;
}

/**
 * 切分结果的体检。
 * 大量极短章节几乎总意味着规则不对（比如把目录每一行都切成了一章），
 * 所以要主动提示，而不是等用户跑完二十次提取才发现。
 */
export function summarizeSplit(drafts: ChapterDraft[]): SplitSummary {
  const totalWords = drafts.reduce((sum, draft) => sum + draft.wordCount, 0);
  const average = drafts.length > 0 ? totalWords / drafts.length : 0;
  return {
    chapterCount: drafts.length,
    totalWords,
    suspiciousCount: drafts.filter(
      (draft) => draft.wordCount < 200 || (average > 0 && draft.wordCount < average * 0.15),
    ).length,
  };
}
