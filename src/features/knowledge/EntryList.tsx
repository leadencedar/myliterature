import { useMemo, useState } from 'react';
import { matchesKeyword } from '@/domain/entrySearch';
import type { Category, KnowledgeEntry } from '@/domain/schema';
import { entryFieldSpecs, getFieldValue } from '@/proposal/fields';
import { PinIcon, SearchIcon } from '@/ui/icons';

/**
 * 条目列表：搜索 + 分类筛选 + 按分类分组。
 *
 * 过滤在内存里做而不是每次敲键盘都查库：单本小说的条目量在数百级别，
 * 内存过滤是即时的，而搜索框最需要的恰恰是无延迟的反馈。
 */
export function EntryList({
  entries,
  categories,
  scenarioTitles,
  onEdit,
}: {
  entries: KnowledgeEntry[];
  categories: Category[];
  /** 推演 id → 推演名，给限定条目的徽标用；不传时徽标只写「限定」 */
  scenarioTitles?: ReadonlyMap<string, string>;
  onEdit: (entry: KnowledgeEntry) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (categoryId === null || entry.categoryId === categoryId) &&
          matchesKeyword(entry, keyword),
      ),
    [entries, categoryId, keyword],
  );

  /** 按分类分组，空分类不显示；分类顺序沿用分类自身的排序 */
  const groups = useMemo(() => {
    return categories
      .map((category) => ({
        category,
        items: filtered.filter((entry) => entry.categoryId === category.id),
      }))
      .filter((group) => group.items.length > 0);
  }, [categories, filtered]);

  /** 分类已被删但条目还在的情况：兜底显示，避免条目凭空消失 */
  const orphans = useMemo(
    () => filtered.filter((entry) => !categories.some((c) => c.id === entry.categoryId)),
    [categories, filtered],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="relative lg:max-w-md">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-300" />
        <input
          type="search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索名称、别名、摘要与正文字段"
          aria-label="搜索条目"
          className="w-full rounded-xl border border-ink-100 bg-paper-raised py-2.5 pr-3 pl-9 text-ink-900 placeholder:text-ink-300 focus:border-ink-500 focus:outline-none"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={categoryId === null} onClick={() => setCategoryId(null)}>
          全部 {entries.length}
        </FilterChip>
        {categories.map((category) => {
          const count = entries.filter((entry) => entry.categoryId === category.id).length;
          if (count === 0) return null;
          return (
            <FilterChip
              key={category.id}
              active={categoryId === category.id}
              onClick={() => setCategoryId(category.id)}
            >
              {category.name} {count}
            </FilterChip>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-300">
          {keyword ? `没有匹配「${keyword}」的条目` : '这个分类下还没有条目'}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.category.id} className="flex flex-col gap-2">
              <h3 className="px-1 text-xs font-medium text-ink-500">
                {group.category.name} · {group.items.length}
              </h3>
              <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {group.items.map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    category={group.category}
                    scenarioTitles={scenarioTitles}
                    onClick={() => onEdit(entry)}
                  />
                ))}
              </ul>
            </section>
          ))}

          {orphans.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="px-1 text-xs font-medium text-ink-500">未分类 · {orphans.length}</h3>
              <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {orphans.map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    category={undefined}
                    scenarioTitles={scenarioTitles}
                    onClick={() => onEdit(entry)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'rounded-full border px-3 py-1.5 text-xs transition-colors',
        active
          ? 'border-ink-900 bg-ink-900 text-paper'
          : 'border-ink-100 bg-paper-raised text-ink-700',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/**
 * 限定条目的徽标文字：「限定 · 推演《X》」。所限定的推演都已不存在时照实说，
 * 否则作者会奇怪这个条目为什么在哪儿都不出现
 */
function limitedBadgeText(
  entry: KnowledgeEntry,
  scenarioTitles: ReadonlyMap<string, string> | undefined,
): string | null {
  if (entry.scope?.kind !== 'limited') return null;
  if (!scenarioTitles) return '限定';
  const titles = entry.scope.targets
    .map((target) => scenarioTitles.get(target.scenarioId))
    .filter((title): title is string => title !== undefined);
  if (titles.length === 0) return '限定 · 推演已不存在';
  return `限定 · 推演${[...new Set(titles)].map((title) => `《${title}》`).join('、')}`;
}

function EntryCard({
  entry,
  category,
  scenarioTitles,
  onClick,
}: {
  entry: KnowledgeEntry;
  category: Category | undefined;
  scenarioTitles: ReadonlyMap<string, string> | undefined;
  onClick: () => void;
}) {
  const badge = limitedBadgeText(entry, scenarioTitles);
  // 没有摘要时退而展示第一个有内容的字段，让卡片不至于只有一个名字
  const fallback = useMemo(() => {
    if (entry.summary) return entry.summary;
    for (const spec of entryFieldSpecs(category)) {
      if (spec.path === 'title' || spec.path === 'summary' || spec.path === 'aliases') continue;
      const value = getFieldValue(entry, spec).trim();
      if (value) return value;
    }
    return '';
  }, [entry, category]);

  return (
    <li className="flex">
      <button
        type="button"
        onClick={onClick}
        className="w-full rounded-xl border border-ink-100 bg-paper-raised px-3 py-2.5 text-left transition-colors active:bg-paper-sunken hover:border-ink-300 hover:bg-paper-sunken"
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-ink-900">{entry.title}</span>
          {entry.pinned ? (
            <span
              title="核心设定"
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[0.625rem] font-medium text-accent"
            >
              <PinIcon className="h-3 w-3" strokeWidth={2.2} />
              核心
            </span>
          ) : null}
          {badge ? (
            <span className="inline-flex shrink-0 items-center rounded-full bg-paper-sunken px-1.5 py-0.5 text-[0.625rem] font-medium text-ink-500">
              {badge}
            </span>
          ) : null}
        </div>

        {entry.aliases.length > 0 ? (
          <p className="mt-0.5 truncate text-xs text-ink-300">别名：{entry.aliases.join('、')}</p>
        ) : null}

        {fallback ? (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">{fallback}</p>
        ) : null}
      </button>
    </li>
  );
}
