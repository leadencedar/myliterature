import type { KnowledgeEntry } from './schema';

/**
 * 条目搜索的匹配范围定义。
 *
 * 仓储查询与界面即时过滤共用这一份实现：否则「搜索框里搜得到、
 * 换个入口搜不到」这种不一致会很快出现，而且极难察觉。
 */
export function entryHaystack(entry: KnowledgeEntry): string {
  return [entry.title, entry.summary, ...entry.aliases, ...Object.values(entry.fields)]
    .join('\n')
    .toLowerCase();
}

export function matchesKeyword(entry: KnowledgeEntry, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  return entryHaystack(entry).includes(needle);
}

/** 名称归一化，与仓储的 `findEntryByName` 保持同一口径 */
export function normalizeEntryName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 找出一段文字里提到过的条目，按名称与别名做子串匹配。
 *
 * 放在 domain 层是因为有三个调用方：反向提取的本地预筛、上下文默认预选、
 * 以及将来任何「这段话跟哪些设定有关」的场景。各写一份的话，同一段文字在
 * 不同入口匹配出不同结果，而这种不一致极难察觉。
 *
 * **刻意不管 `pinned`**：核心设定要不要无条件包含，是调用方的策略而不是匹配规则。
 * 提取时要（读不到会让模型自行发明设定），默认预选时不要（它们本来就始终注入）。
 *
 * 只认名称与别名，不搜摘要与字段 —— 那是 `matchesKeyword` 的活。这里要回答的是
 * 「这段话提到了谁」，把摘要也算进去会让一个描述了半个世界观的条目命中所有文本。
 */
export function mentionedEntries(text: string, entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return [];
  return entries.filter((entry) => {
    const names = [entry.title, ...entry.aliases].map(normalizeEntryName).filter(Boolean);
    return names.some((name) => haystack.includes(name));
  });
}
