import type { Chapter } from '@/domain/schema';
import { formatWordCount } from '@/ui/format';

/**
 * 章节列表项。主线列表与外传卡片共用：两边长得一样，用户才认得出「这是一章」。
 *
 * 标题统一写「第 N 章」，外传章节的外传名已经在卡片表头里，不重复。
 */
export function ChapterListItem({
  chapter,
  ariaLabel,
  onOpen,
}: {
  chapter: Chapter;
  /** 默认「继续写第 N 章」；外传卡片里传「继续写外传《X》第 N 章」 */
  ariaLabel?: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-label={ariaLabel ?? `继续写第 ${chapter.index} 章`}
        onClick={onOpen}
        className="w-full rounded-xl border border-ink-100 bg-paper-raised px-3 py-2.5 text-left active:bg-paper-sunken"
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-ink-900">
            第 {chapter.index} 章{chapter.title ? ` ${chapter.title}` : ''}
          </span>
          {chapter.status === 'done' ? (
            <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[0.625rem] text-emerald-700">
              已完成
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-ink-500">
          {formatWordCount(chapter.wordCount)}
          {chapter.source === 'ai' ? ' · AI 起稿' : ''}
          {chapter.source === 'imported' ? ' · 导入' : ''}
        </p>
      </button>
    </li>
  );
}
