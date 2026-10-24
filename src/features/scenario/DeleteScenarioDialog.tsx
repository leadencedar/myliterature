import { useEffect, useId, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import type { KnowledgeEntry, Scenario } from '@/domain/schema';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { errorText } from './scenarioView';

/**
 * 删除推演的确认框（设计 §8.3「删除推演」）。
 *
 * 用本地拼的 Sheet size="dialog"，不用、也不改共享的 ConfirmDialog：它只接受字符串 message，
 * 放不下复选框和框内的错误提示；改共享组件会波及所有调用点。
 * 「同时把只属于这个推演的条目移进回收站」默认勾选：新建的 OC 大多只为这一局存在，默认清走更符合预期；
 * 进回收站可逆，所以默认勾选不危险。
 */
export function DeleteScenarioDialog({
  open,
  scenario,
  nodeCount,
  entries,
  onDeleted,
  onClose,
}: {
  open: boolean;
  scenario: Scenario;
  nodeCount: number;
  /** 本书条目（含限定的）：算「只属于这个推演」的条目 */
  entries: readonly KnowledgeEntry[];
  onDeleted: () => void;
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const checkboxId = useId();
  const [trash, setTrash] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTrash(true);
      setError(undefined);
    }
    wasOpen.current = open;
  }, [open]);

  // 与仓储 deleteScenario 同一口径：targets 只含这一个推演的限定条目
  const scoped = entries.filter((entry) => {
    if (entry.deletedAt !== null) return false;
    const scope = entry.scope ?? { kind: 'universal' as const };
    return (
      scope.kind === 'limited' && scope.targets.every((target) => target.scenarioId === scenario.id)
    );
  });
  const cast = scoped.find((entry) => entry.id === scenario.setup.cast[0]?.entryId);

  async function remove() {
    setDeleting(true);
    setError(undefined);
    try {
      await repository.deleteScenario(scenario.id, {
        trashScopedEntries: scoped.length > 0 && trash,
      });
      invalidate();
      onDeleted();
    } catch (cause) {
      // 失败时框保持打开，作者能看到原因再决定
      setError(errorText(cause, '删除失败').message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Sheet
      open={open}
      title={`删除推演《${scenario.title}》？`}
      size="dialog"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="lg" block onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            size="lg"
            block
            disabled={deleting}
            onClick={() => void remove()}
          >
            删除
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-700">
        全部 {nodeCount} 步和分支会被永久删除；已沉淀的大纲、外传与章节保留，只是不再关联这个推演。
      </p>
      {scoped.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start gap-2.5">
            <input
              id={checkboxId}
              type="checkbox"
              checked={trash}
              onChange={(event) => setTrash(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-ink-900"
            />
            <label htmlFor={checkboxId} className="text-sm text-ink-900">
              同时把只属于这个推演的条目{cast ? `（含主角「${cast.title}」）` : ''}移进回收站
            </label>
          </div>
          <p className="pl-6 text-xs leading-relaxed text-ink-500">
            移进回收站的条目可以恢复；不勾选时它们留在知识库里，作用范围仍是这个推演，但不会出现在任何地方，可以改成通用。
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
