import { useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import type { KnowledgeEntry } from '@/domain/schema';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { formatRelativeTime } from '@/ui/format';

/**
 * 回收站。
 *
 * 条目删除走软删除而不是直接抹掉：设定条目常常是写了几万字之后才发现
 * 「当初那条其实有用」，给一条后悔的路比省一张表更重要。
 */
export function TrashSheet({
  open,
  novelId,
  onClose,
}: {
  open: boolean;
  novelId: string;
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const [purgeTarget, setPurgeTarget] = useState<KnowledgeEntry | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const { data } = useRepoQuery(
    async (repo) => {
      // 含限定到推演的条目：推演主角进了回收站也要在这里看得到
      const [all, scenarios] = await Promise.all([
        repo.listEntries(novelId, { includeDeleted: true, scope: 'all' }),
        repo.listScenarios(novelId),
      ]);
      // 主角条目 → 推演名：让作者在点「彻底删除」之前就知道它删不掉
      const castOf = new Map<string, string[]>();
      for (const scenario of scenarios) {
        for (const member of scenario.setup.cast) {
          castOf.set(member.entryId, [...(castOf.get(member.entryId) ?? []), scenario.title]);
        }
      }
      const deleted = all
        .filter((entry) => entry.deletedAt !== null)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
      return { deleted, castOf };
    },
    [novelId],
  );

  async function restore(entry: KnowledgeEntry) {
    await repository.restoreEntry(entry.id);
    invalidate();
  }

  function choosePurge(entry: KnowledgeEntry | null) {
    // 关闭或换目标时清空上一次的错误，不让旧提示挂在另一个条目上
    setPurgeError(null);
    setPurgeTarget(entry);
  }

  async function purge() {
    if (!purgeTarget) return;
    try {
      await repository.hardDeleteEntry(purgeTarget.id);
    } catch (error) {
      // 目前唯一的失败是「这个条目是推演《X》的主角，先删除推演」：框保持打开，作者可以取消
      setPurgeError(error instanceof Error ? error.message : String(error));
      return;
    }
    invalidate();
    choosePurge(null);
  }

  const items = data?.deleted ?? [];

  return (
    <>
      <Sheet
        open={open}
        title="回收站"
        description="被删除的条目会留在这里，可以恢复或彻底删除。"
        onClose={onClose}
      >
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-300">回收站是空的</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((entry) => {
              const owners = data?.castOf.get(entry.id) ?? [];
              return (
                <li
                  key={entry.id}
                  className="flex items-center gap-2 rounded-xl border border-ink-100 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{entry.title}</p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {entry.deletedAt ? `${formatRelativeTime(entry.deletedAt)}删除` : ''}
                    </p>
                    {owners.length > 0 ? (
                      <p className="mt-0.5 text-xs text-ink-500">
                        {owners.map((title) => `推演《${title}》的主角`).join('、')}
                      </p>
                    ) : null}
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => restore(entry)}>
                    恢复
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => choosePurge(entry)}>
                    彻底删除
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Sheet>

      {/*
        本地拼的确认框而不是共享的 ConfirmDialog：它只接受字符串 message，放不下错误提示；
        改共享组件会波及所有调用点。按钮、样式与取消行为与 ConfirmDialog 一致
      */}
      <Sheet
        open={purgeTarget !== null}
        title="彻底删除？"
        onClose={() => choosePurge(null)}
        size="dialog"
        footer={
          <>
            <Button variant="secondary" size="lg" block onClick={() => choosePurge(null)}>
              取消
            </Button>
            <Button variant="danger" size="lg" block onClick={purge}>
              永久删除
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-ink-700">
          {`「${purgeTarget?.title ?? ''}」将被永久删除，无法恢复。`}
        </p>
        {purgeError ? (
          <p role="alert" className="mt-3 rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
            {purgeError}
          </p>
        ) : null}
      </Sheet>
    </>
  );
}
