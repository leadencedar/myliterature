/**
 * 世界观设定文本的分段。
 *
 * 提取是高推理强度的任务，几万字的设定集一次塞进去容易超时、输出被截断，
 * 而且一次失败就整份重花钱。切成若干段逐段提取，进度按段存在导入任务上，
 * 可以暂停、重试、跨刷新续跑。
 */
import type { ImportDraft, ImportWorldviewChunk } from '@/domain/schema';

/** 单段上限（字符数）。与单章提取的常见篇幅同量级 */
export const WORLDVIEW_CHUNK_SIZE = 6000;

/**
 * 按空行切成段落，贪心拼块，每块不超过 max。
 * 单个段落本身超过 max 时按 max 硬切。空白块丢弃，空文本返回 []。
 */
export function splitWorldviewText(text: string, max = WORLDVIEW_CHUNK_SIZE): string[] {
  const paragraphs = text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      flush();
      for (let start = 0; start < paragraph.length; start += max) {
        const piece = paragraph.slice(start, start + max).trim();
        if (piece) chunks.push(piece);
      }
      continue;
    }
    const joined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (joined.length > max) {
      flush();
      current = paragraph;
    } else {
      current = joined;
    }
  }
  flush();

  return chunks;
}

/** 普通段的标签：首章标题，跨章时「首 — 末」；空标题只取非空的，都空则 '' */
function rangeTitle(titles: string[]): string {
  const first = titles[0] ?? '';
  if (titles.length <= 1) return first;
  const last = titles[titles.length - 1] ?? '';
  if (first && last) return `${first} — ${last}`;
  return first || last;
}

/**
 * 把分章草稿打包成世界观提取的段落：按章贪心打包，单章超长再切。
 *
 * - 按章作边界：分章结果是作者自己的结构，故事形式的设定素材里章就是叙事单元，
 *   打包时章与章之间不切开。
 * - 打包而不是一章一段：设定集常被切成几十个几百字的小节，逐章提取等于发几十次
 *   高推理强度的调用。
 * - 长度按拼接后的最终文本算（含段内标题行与章间空行），所以每段 content ≤ max。
 * - 超长章直接对正文调 splitWorldviewText，切出的各段正文不带标题行，
 *   章标题只记在 title「{章标题}（i/k）」里；章标题为空时 title 为 ''。
 * - 正文为空白的草稿跳过。
 */
export function packWorldviewChunks(
  drafts: readonly Pick<ImportDraft, 'title' | 'content'>[],
  max = WORLDVIEW_CHUNK_SIZE,
): ImportWorldviewChunk[] {
  const chunks: ImportWorldviewChunk[] = [];
  let current = '';
  let titles: string[] = [];

  const push = (title: string, content: string) => {
    chunks.push({ index: chunks.length + 1, title, content, status: 'pending', error: '' });
  };
  const flush = () => {
    if (current) push(rangeTitle(titles), current);
    current = '';
    titles = [];
  };

  for (const draft of drafts) {
    const content = draft.content.trim();
    if (!content) continue;
    const title = draft.title.trim();
    const titleLine = title ? `${title}\n` : '';

    if (titleLine.length + content.length > max) {
      flush();
      const pieces = splitWorldviewText(content, max);
      pieces.forEach((piece, i) => {
        push(title ? `${title}（${i + 1}/${pieces.length}）` : '', piece);
      });
      continue;
    }

    const block = `${titleLine}${content}`;
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= max) {
      current = candidate;
      titles.push(title);
    } else {
      flush();
      current = block;
      titles = [title];
    }
  }
  flush();

  return chunks;
}
