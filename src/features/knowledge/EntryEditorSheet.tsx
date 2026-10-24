import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import type { Category, EntryScopeTarget, FieldMutability, KnowledgeEntry } from '@/domain/schema';
import { fieldMutability } from '@/domain/worldline';
import { entryFieldSpecs, getFieldValue, setFieldValue } from '@/proposal/fields';
import { Button } from '@/ui/Button';
import { Toggle } from '@/ui/Controls';
import { SelectField, TextAreaField, TextField } from '@/ui/Field';
import { ConfirmDialog, Sheet } from '@/ui/Sheet';

interface EntryEditorSheetProps {
  open: boolean;
  novelId: string;
  categories: Category[];
  /** 传入条目为编辑，不传为新建 */
  entry?: KnowledgeEntry | undefined;
  /** 新建时的默认分类 */
  defaultCategoryId?: string | undefined;
  onClose: () => void;
}

/** 表单内部状态：统一用「路径 → 字符串」承载，与确认管道的编辑模型一致 */
interface EntryDraft {
  categoryId: string;
  pinned: boolean;
  values: Record<string, string>;
  /** 作用范围：通用，或仅限所列推演（每个推演一条 target，保留 fromNodeId） */
  scopeKind: 'universal' | 'limited';
  targets: EntryScopeTarget[];
  /** 逐字段的可变性覆盖；没有的键跟随分类 */
  fieldLocks: Record<string, FieldMutability>;
}

const MAX_REVEAL_HINT = 200;

const MUTABILITY_LABELS: Record<FieldMutability, string> = { locked: '锁定', mutable: '可变' };

function draftFrom(
  entry: KnowledgeEntry | undefined,
  categoryId: string,
  categories: Category[],
): EntryDraft {
  const category = categories.find((item) => item.id === categoryId);
  const specs = entryFieldSpecs(category);
  const values: Record<string, string> = {};
  for (const spec of specs) {
    values[spec.path] = entry ? getFieldValue(entry, spec) : '';
  }
  const scope = entry?.scope ?? { kind: 'universal' as const };
  return {
    categoryId,
    pinned: entry?.pinned ?? false,
    values,
    scopeKind: scope.kind,
    targets: scope.kind === 'limited' ? scope.targets.map((target) => ({ ...target })) : [],
    fieldLocks: { ...(entry?.fieldLocks ?? {}) },
  };
}

/**
 * 条目编辑器。
 *
 * 字段完全由所属分类的字段模板驱动 —— 用户给「势力」分类加一栏，
 * 这里立刻就多一个输入框，不需要改任何代码。
 */
export function EntryEditorSheet({
  open,
  novelId,
  categories,
  entry,
  defaultCategoryId,
  onClose,
}: EntryEditorSheetProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  // 「仅限推演」要列出本书的推演；查询失败或还没回来时按没有推演处理，不挡住编辑
  const { data: scenarios = [] } = useRepoQuery((repo) => repo.listScenarios(novelId), [novelId]);

  const initialCategoryId = entry?.categoryId ?? defaultCategoryId ?? categories[0]?.id ?? '';
  const [draft, setDraft] = useState<EntryDraft>(() =>
    draftFrom(entry, initialCategoryId, categories),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [scopeError, setScopeError] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 只在「关闭 → 打开」时重置，避免外部数据刷新冲掉正在输入的内容
  const wasOpen = useRef(false);
  const seedRef = useRef({ entry, initialCategoryId, categories });
  seedRef.current = { entry, initialCategoryId, categories };

  useEffect(() => {
    if (open && !wasOpen.current) {
      const seed = seedRef.current;
      setDraft(draftFrom(seed.entry, seed.initialCategoryId, seed.categories));
      setError(undefined);
      setScopeError(undefined);
    }
    wasOpen.current = open;
  }, [open]);

  const category = categories.find((item) => item.id === draft.categoryId);
  const specs = entryFieldSpecs(category);

  /** 切换分类时保留同名字段的已填内容，其余按新模板补空 */
  function changeCategory(categoryId: string) {
    const nextSpecs = entryFieldSpecs(categories.find((item) => item.id === categoryId));
    const values: Record<string, string> = {};
    for (const spec of nextSpecs) {
      values[spec.path] = draft.values[spec.path] ?? '';
    }
    setDraft({ ...draft, categoryId, values });
  }

  function toggleTarget(scenarioId: string, checked: boolean) {
    setDraft({
      ...draft,
      targets: checked
        ? [...draft.targets, { scenarioId, fromNodeId: null, revealHint: '' }]
        : draft.targets.filter((target) => target.scenarioId !== scenarioId),
    });
  }

  function setRevealHint(scenarioId: string, revealHint: string) {
    setDraft({
      ...draft,
      targets: draft.targets.map((target) =>
        target.scenarioId === scenarioId ? { ...target, revealHint } : target,
      ),
    });
  }

  function setFieldLock(key: string, value: string) {
    const fieldLocks = { ...draft.fieldLocks };
    if (value === 'locked' || value === 'mutable') fieldLocks[key] = value;
    else delete fieldLocks[key];
    setDraft({ ...draft, fieldLocks });
  }

  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  // 所限定的推演被删掉后 target 还留着（仓储只在合并导入时清理）：提示作者，保存时原样保留
  const staleTargets = draft.targets.filter((target) => !scenarioIds.has(target.scenarioId));

  async function save() {
    const title = (draft.values.title ?? '').trim();
    if (!title) {
      setError('条目名不能为空');
      return;
    }
    if (!draft.categoryId) {
      setError('请选择分类');
      return;
    }
    if (draft.scopeKind === 'limited' && draft.targets.length === 0) {
      setScopeError('「仅限推演」至少要选一个推演，或改为通用');
      return;
    }
    if (draft.targets.some((target) => target.revealHint.trim().length > MAX_REVEAL_HINT)) {
      setScopeError(`登场条件不能超过 ${MAX_REVEAL_HINT} 字`);
      return;
    }
    setScopeError(undefined);

    setSaving(true);
    try {
      // 用与确认管道相同的写回逻辑，保证手工编辑与 AI 产出落库结果一致
      let payload: unknown = {
        categoryId: draft.categoryId,
        pinned: draft.pinned,
        // 作者直接编辑世界观：作用范围与可变性走 updateEntry，不经提案
        scope:
          draft.scopeKind === 'limited'
            ? {
                kind: 'limited',
                targets: draft.targets.map((target) => ({
                  ...target,
                  revealHint: target.revealHint.trim(),
                })),
              }
            : { kind: 'universal' },
        fieldLocks: draft.fieldLocks,
      };
      for (const spec of specs) {
        payload = setFieldValue(payload, spec, draft.values[spec.path] ?? '');
      }

      if (entry) {
        await repository.updateEntry(entry.id, payload as Partial<KnowledgeEntry>);
      } else {
        await repository.createEntry(
          novelId,
          payload as Pick<KnowledgeEntry, 'categoryId' | 'title'> & Partial<KnowledgeEntry>,
        );
      }
      invalidate();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function softDelete() {
    if (!entry) return;
    await repository.softDeleteEntry(entry.id);
    invalidate();
    setConfirmDelete(false);
    onClose();
  }

  return (
    <>
      <Sheet
        open={open}
        title={entry ? '编辑条目' : '新建条目'}
        description={category ? `分类：${category.name}` : undefined}
        onClose={onClose}
        footer={
          <Button variant="primary" size="lg" block disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </Button>
        }
      >
        <SelectField
          label="分类"
          options={categories.map((item) => ({ value: item.id, label: item.name }))}
          value={draft.categoryId}
          onChange={(event) => changeCategory((event.target as HTMLSelectElement).value)}
        />

        {specs.map((spec) => {
          const value = draft.values[spec.path] ?? '';
          const onChange = (next: string) =>
            setDraft({ ...draft, values: { ...draft.values, [spec.path]: next } });

          if (spec.kind === 'text') {
            return (
              <TextField
                key={spec.path}
                label={spec.label}
                value={value}
                {...(spec.hint ? { hint: spec.hint } : {})}
                {...(spec.path === 'title' && error ? { error } : {})}
                onChange={(event) => onChange(event.target.value)}
              />
            );
          }

          return (
            <TextAreaField
              key={spec.path}
              label={spec.label}
              rows={spec.kind === 'list' ? 2 : 3}
              value={value}
              hint={spec.kind === 'list' ? `每行一项。${spec.hint ?? ''}`.trim() : spec.hint}
              onChange={(event) => onChange(event.target.value)}
            />
          );
        })}

        <Toggle
          label="核心设定"
          description="勾选后，这一条会在每次生成时强制注入提示词。建议只给真正的底层规则勾选。"
          checked={draft.pinned}
          onChange={(pinned) => setDraft({ ...draft, pinned })}
        />

        {/* 大多数作者用不到，默认折叠，不打扰普通的条目编辑 */}
        <details className="rounded-xl border border-ink-100 bg-paper-raised px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium text-ink-700">
            互动推演设置
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <SelectField
              label="作用范围"
              hint="通用：所有世界线与正文写作都能看到。仅限推演：只在所选推演里出现，不进正文写作的提示词。"
              options={[
                { value: 'universal', label: '通用' },
                { value: 'limited', label: '仅限推演' },
              ]}
              value={draft.scopeKind}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  scopeKind:
                    (event.target as HTMLSelectElement).value === 'limited'
                      ? 'limited'
                      : 'universal',
                })
              }
            />

            {draft.scopeKind === 'limited' ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-ink-700">限定到哪些推演</legend>
                {scenarios.length === 0 ? (
                  <p className="text-xs text-ink-500">这部作品还没有推演。</p>
                ) : null}
                {scenarios.map((scenario) => {
                  const target = draft.targets.find((item) => item.scenarioId === scenario.id);
                  return (
                    <div key={scenario.id} className="flex flex-col gap-2">
                      <label className="tap-target inline-flex items-center gap-2 text-sm text-ink-900">
                        <input
                          type="checkbox"
                          checked={target !== undefined}
                          onChange={(event) => toggleTarget(scenario.id, event.target.checked)}
                          className="h-5 w-5 accent-ink-900"
                        />
                        推演《{scenario.title}》
                      </label>
                      {target ? (
                        <TextField
                          label={`《${scenario.title}》的登场条件`}
                          value={target.revealHint}
                          placeholder="留空 = 一开始就在；写了就作为可能登场的预设"
                          hint={
                            <span
                              className={
                                target.revealHint.trim().length > MAX_REVEAL_HINT
                                  ? 'text-seal'
                                  : undefined
                              }
                            >
                              {target.revealHint.trim().length} / {MAX_REVEAL_HINT}
                            </span>
                          }
                          onChange={(event) => setRevealHint(scenario.id, event.target.value)}
                        />
                      ) : null}
                    </div>
                  );
                })}
                {staleTargets.length > 0 ? (
                  <p className="text-xs leading-relaxed text-seal">
                    所限定的推演里有 {staleTargets.length} 个已不存在。
                    {staleTargets.length === draft.targets.length
                      ? '这个条目现在在任何地方都不会出现，可以改为通用，或另选推演。'
                      : ''}
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            {scopeError ? (
              <p role="alert" className="rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
                {scopeError}
              </p>
            ) : null}

            {category && category.fieldTemplate.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-ink-700">各字段在世界线上能否改写</p>
                <p className="text-xs leading-relaxed text-ink-500">
                  锁定的字段是底层设定，推演里的任何世界线都不能改写它。
                </p>
                {category.fieldTemplate.map((field) => {
                  const inherited = fieldMutability(category, undefined, field.key);
                  return (
                    <SelectField
                      key={field.key}
                      label={`「${field.label}」在世界线上`}
                      options={[
                        { value: '', label: `跟随分类（默认：${MUTABILITY_LABELS[inherited]}）` },
                        { value: 'locked', label: '锁定' },
                        { value: 'mutable', label: '可变' },
                      ]}
                      value={draft.fieldLocks[field.key] ?? ''}
                      onChange={(event) =>
                        setFieldLock(field.key, (event.target as HTMLSelectElement).value)
                      }
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        </details>

        {entry ? (
          <Button variant="danger" size="md" block onClick={() => setConfirmDelete(true)}>
            删除这个条目
          </Button>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title="删除条目？"
        message={`「${entry?.title ?? ''}」会移入回收站，可以随时恢复。`}
        confirmLabel="移入回收站"
        destructive
        onConfirm={softDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
