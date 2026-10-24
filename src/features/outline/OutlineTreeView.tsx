import { useMemo, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import type { OutlineNode } from '@/domain/schema';
import { IconButton } from '@/ui/Button';
import { formatWordCount } from '@/ui/format';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronIcon,
  IndentIcon,
  OutdentIcon,
  ReorderIcon,
} from '@/ui/icons';
import {
  OUTLINE_STATUS_LABELS,
  buildTree,
  canIndent,
  canMoveDown,
  canMoveUp,
  canOutdent,
  flattenVisible,
  indent,
  moveDown,
  moveUp,
  outdent,
  type ReorderUpdate,
} from './outlineTree';

const STATUS_STYLES: Record<OutlineNode['status'], string> = {
  planned: 'bg-paper-sunken text-ink-500',
  drafting: 'bg-accent-soft text-accent',
  done: 'bg-emerald-50 text-emerald-700',
};

/**
 * 大纲树视图。
 *
 * 排序用明确的「上移 / 下移 / 升级 / 降级」按钮，而不是拖拽。
 * 移动端在嵌套树上做拖拽既难瞄准（手指遮挡目标位置），也无法被读屏用户使用；
 * 按钮方式每一步的结果都是确定的，还能直接复用纯函数做单测。
 * 为了不让每一行都挂四个按钮，按钮收在行内的排序把手后面，一次只展开一行。
 */
export function OutlineTreeView({
  nodes,
  chapterCountByNode,
  onSelect,
}: {
  nodes: OutlineNode[];
  /** 每个节点已写了多少章，用于提示进度 */
  chapterCountByNode: Map<string, number>;
  onSelect: (node: OutlineNode, depth: number) => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [reorderingId, setReorderingId] = useState<string | null>(null);

  const rows = useMemo(() => flattenVisible(buildTree(nodes), collapsed), [nodes, collapsed]);

  function toggleCollapse(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function applyUpdates(updates: ReorderUpdate[]) {
    if (updates.length === 0) return;
    await repository.reorderOutline(updates);
    invalidate();
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((row) => {
        const isReordering = reorderingId === row.node.id;
        const chapterCount = chapterCountByNode.get(row.node.id) ?? 0;

        return (
          <li key={row.node.id} style={{ paddingLeft: `${row.depth * 1.25}rem` }}>
            <div
              className={[
                'rounded-xl border bg-paper-raised',
                isReordering ? 'border-ink-500' : 'border-ink-100',
              ].join(' ')}
            >
              <div className="flex items-start">
                {row.hasChildren ? (
                  <IconButton
                    label={`${row.collapsed ? '展开' : '折叠'}「${row.node.title}」`}
                    onClick={() => toggleCollapse(row.node.id)}
                    className="mt-1 ml-0.5 h-9 w-9 min-h-9 min-w-9 shrink-0"
                  >
                    <ChevronIcon
                      className={`h-4 w-4 transition-transform ${row.collapsed ? '-rotate-90' : ''}`}
                    />
                  </IconButton>
                ) : (
                  <span className="w-2.5 shrink-0" aria-hidden="true" />
                )}

                <button
                  type="button"
                  // 显式命名：否则可访问名会是「标题+状态+梗概+统计」拼成的一长串
                  aria-label={`编辑「${row.node.title}」`}
                  onClick={() => onSelect(row.node, row.depth)}
                  className="min-w-0 flex-1 rounded-xl px-2 py-2.5 text-left active:bg-paper-sunken"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-medium text-ink-900">
                      {row.node.title}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] ${
                        STATUS_STYLES[row.node.status]
                      }`}
                    >
                      {OUTLINE_STATUS_LABELS[row.node.status]}
                    </span>
                  </div>

                  {row.node.synopsis ? (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-500">
                      {row.node.synopsis}
                    </p>
                  ) : null}

                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[0.6875rem] text-ink-300">
                    {row.node.targetWords ? (
                      <span>目标 {formatWordCount(row.node.targetWords)}</span>
                    ) : null}
                    {row.collapsed && row.descendantCount > 0 ? (
                      <span>内含 {row.descendantCount} 项</span>
                    ) : null}
                    {chapterCount > 0 ? <span>已写 {chapterCount} 章</span> : null}
                    {row.node.linkedEntryIds.length > 0 ? (
                      <span>关联 {row.node.linkedEntryIds.length} 条设定</span>
                    ) : null}
                  </p>
                </button>

                <IconButton
                  label={`调整「${row.node.title}」的位置`}
                  aria-expanded={isReordering}
                  onClick={() => setReorderingId(isReordering ? null : row.node.id)}
                  className="mt-1 mr-0.5 h-9 w-9 min-h-9 min-w-9 shrink-0"
                >
                  <ReorderIcon className="h-4 w-4" />
                </IconButton>
              </div>

              {isReordering ? (
                <div className="flex items-center gap-1 border-t border-ink-100 px-2 py-1.5">
                  <IconButton
                    label={`上移「${row.node.title}」`}
                    disabled={!canMoveUp(nodes, row.node.id)}
                    onClick={() => applyUpdates(moveUp(nodes, row.node.id))}
                  >
                    <ArrowUpIcon className="h-5 w-5" />
                  </IconButton>
                  <IconButton
                    label={`下移「${row.node.title}」`}
                    disabled={!canMoveDown(nodes, row.node.id)}
                    onClick={() => applyUpdates(moveDown(nodes, row.node.id))}
                  >
                    <ArrowDownIcon className="h-5 w-5" />
                  </IconButton>
                  <IconButton
                    label={`降级「${row.node.title}」`}
                    disabled={!canIndent(nodes, row.node.id)}
                    onClick={() => applyUpdates(indent(nodes, row.node.id))}
                  >
                    <IndentIcon className="h-5 w-5" />
                  </IconButton>
                  <IconButton
                    label={`升级「${row.node.title}」`}
                    disabled={!canOutdent(nodes, row.node.id)}
                    onClick={() => applyUpdates(outdent(nodes, row.node.id))}
                  >
                    <OutdentIcon className="h-5 w-5" />
                  </IconButton>
                  <span className="ml-auto pr-1 text-[0.625rem] text-ink-300">
                    第 {row.depth + 1} 层
                  </span>
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
