import type { Category, Chapter, ChapterSummary, KnowledgeEntry } from '@/domain/schema';
import { entryFieldSpecs, getFieldValue } from '@/proposal/fields';

/**
 * 把条目渲染成 prompt 片段：只输出有内容的字段。
 * 导出给「按规范检查」复用，保证检查与生成看到的条目文字一致
 */
export function renderEntry(entry: KnowledgeEntry, categories: Category[]): string {
  const category = categories.find((item) => item.id === entry.categoryId);
  const lines = [`## ${entry.title}（${category?.name ?? '设定'}）`];
  if (entry.aliases.length > 0) lines.push(`别名：${entry.aliases.join('、')}`);
  if (entry.summary.trim()) lines.push(entry.summary.trim());

  for (const spec of entryFieldSpecs(category)) {
    if (spec.path === 'title' || spec.path === 'aliases' || spec.path === 'summary') continue;
    const value = getFieldValue(entry, spec).trim();
    if (value) lines.push(`${spec.label}：${value}`);
  }
  return lines.join('\n');
}

/** 一章摘要的 prompt 片段。导出给「按规范检查」的前情块复用，实现与生成共用一份 */
export function renderSummary(chapter: Chapter, summary: ChapterSummary): string {
  const lines = [`第 ${chapter.index} 章${chapter.title ? ` ${chapter.title}` : ''}`];
  if (summary.summary.trim()) lines.push(summary.summary.trim());
  if (summary.keyEvents.length > 0) lines.push(`关键事件：${summary.keyEvents.join('；')}`);
  if (summary.openThreads.length > 0) {
    lines.push(`尚未收束的伏笔：${summary.openThreads.join('；')}`);
  }
  return lines.join('\n');
}
