import { useEffect, useMemo, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import type {
  Category,
  KnowledgeEntry,
  Scenario,
  ScenarioNode,
  WorldlineDelta,
} from '@/domain/schema';
import { pathTo } from '@/domain/scenario';
import {
  ENTRY_STATUS_LABELS,
  OC_ASPECT_LABELS,
  effectiveKnowledge,
  fieldMutability,
  refKey,
  type EffectiveEntry,
} from '@/domain/worldline';
import { Button } from '@/ui/Button';
import { SelectField, TextAreaField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
import { crumbLabel, errorText } from './scenarioView';

/** 手动改写的值上限（与 WorldlineDeltaSchema.fieldOverrides.value 一致） */
const MAX_VALUE = 1000;

function cloneDelta(delta: WorldlineDelta): WorldlineDelta {
  return {
    fieldOverrides: delta.fieldOverrides.map((item) => ({ ...item })),
    lineEntries: delta.lineEntries.map((item) => ({ ...item, fields: { ...item.fields } })),
    statusChanges: delta.statusChanges.map((item) => ({ ...item })),
    ocChanges: delta.ocChanges.map((item) => ({ ...item })),
    events: [...delta.events],
    flags: delta.flags.map((item) => ({ ...item })),
  };
}

/**
 * 一步的差异编辑（设计 D6 / §8.3「本线状态」）。差异只在推演沙盒层，作者随时可改可删，不走提案。
 *
 * 新增改写只列**可变**字段：锁定字段不出现在下拉里，正常操作走不到「覆盖底层设定」；
 * 仓储仍会用 sanitizeDelta 再查一遍，有任何不合规整次拒绝并在这里显示原因。
 * 编辑祖先的差异后，后代节点会提示「生成时依据的是旧事实」，不重新生成。
 */
export function DeltaEditor({
  open,
  scenario,
  nodes,
  node,
  entries,
  categories,
  onSaved,
  onClose,
}: {
  open: boolean;
  scenario: Scenario;
  nodes: readonly ScenarioNode[];
  node: ScenarioNode;
  entries: readonly KnowledgeEntry[];
  categories: readonly Category[];
  onSaved: (node: ScenarioNode) => void;
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const [delta, setDelta] = useState<WorldlineDelta>(() => cloneDelta(node.delta));
  const [target, setTarget] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const seedRef = useRef(node);
  seedRef.current = node;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setDelta(cloneDelta(seedRef.current.delta));
      setTarget('');
      setFieldKey('');
      setValue('');
      setError(undefined);
    }
    wasOpen.current = open;
  }, [open]);

  // 父节点处的有效知识：这一步的改写叠在它之上
  const knowledge = useMemo(
    () =>
      effectiveKnowledge({
        scenario,
        path: node.parentId ? pathTo(nodes, node.parentId) : [],
        entries,
        categories,
      }),
    [scenario, nodes, node.parentId, entries, categories],
  );
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  // 可被引用的条目：父节点处可见的 + 这一步自己新建的本线条目
  const candidates = new Map<string, EffectiveEntry>();
  for (const entry of knowledge.entries) candidates.set(refKey(entry.ref), entry);
  for (const line of delta.lineEntries) {
    const ref = { kind: 'line' as const, nodeId: node.id, localId: line.localId };
    candidates.set(refKey(ref), {
      ref,
      origin: 'line',
      title: line.title,
      aliases: [],
      summary: line.summary,
      categoryId: line.categoryId,
      entry: undefined,
      lineNodeId: node.id,
      fields: {},
      status: null,
      revealHint: '',
    });
  }
  const titleOf = (ref: WorldlineDelta['fieldOverrides'][number]['target']): string => {
    const key = refKey(ref);
    return candidates.get(knowledge.lineAliases[key] ?? key)?.title ?? '（已不存在的条目）';
  };
  const labelOf = (categoryId: string | undefined, key: string): string =>
    (categoryId ? categoryById.get(categoryId) : undefined)?.fieldTemplate.find(
      (field) => field.key === key,
    )?.label ?? key;

  const chosen = candidates.get(target);
  const chosenCategory = chosen ? categoryById.get(chosen.categoryId) : undefined;
  const mutableFields = (chosenCategory?.fieldTemplate ?? []).filter(
    (field) => fieldMutability(chosenCategory, chosen?.entry, field.key) === 'mutable',
  );

  function addOverride() {
    if (!chosen || !fieldKey || !value.trim() || value.trim().length > MAX_VALUE) return;
    setDelta((current) => ({
      ...current,
      fieldOverrides: [
        // 同一条目同一栏只留一条：后写的替换先写的
        ...current.fieldOverrides.filter(
          (item) => !(refKey(item.target) === refKey(chosen.ref) && item.fieldKey === fieldKey),
        ),
        { target: chosen.ref, fieldKey, value: value.trim() },
      ],
    }));
    setFieldKey('');
    setValue('');
  }

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const saved = await repository.updateScenarioNodeDelta(node.id, delta);
      invalidate();
      onSaved(saved);
    } catch (cause) {
      setError(errorText(cause, '保存失败').message);
    } finally {
      setSaving(false);
    }
  }

  const invalidOverride = delta.fieldOverrides.some(
    (item) => !item.value.trim() || item.value.length > MAX_VALUE,
  );

  return (
    <Sheet
      open={open}
      title={`编辑${crumbLabel(node)}的变化`}
      description="这些变化只记在这条世界线上，不会改动世界观条目。"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          size="lg"
          block
          disabled={saving || invalidOverride}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
      }
    >
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink-900">设定改写</h3>
        {delta.fieldOverrides.length === 0 ? (
          <p className="text-sm text-ink-500">没有改写。</p>
        ) : null}
        {delta.fieldOverrides.map((item, index) => {
          const ref = candidates.get(
            knowledge.lineAliases[refKey(item.target)] ?? refKey(item.target),
          );
          const label = `${titleOf(item.target)} · ${labelOf(ref?.categoryId, item.fieldKey)}`;
          return (
            <div
              key={`${refKey(item.target)}-${item.fieldKey}`}
              className="flex flex-col gap-1.5 rounded-xl border border-ink-100 p-3"
            >
              <TextAreaField
                label={label}
                rows={2}
                value={item.value}
                onChange={(event) => {
                  const next = event.target.value;
                  setDelta((current) => ({
                    ...current,
                    fieldOverrides: current.fieldOverrides.map((override, at) =>
                      at === index ? { ...override, value: next } : override,
                    ),
                  }));
                }}
              />
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`删除改写：${label}`}
                  onClick={() =>
                    setDelta((current) => ({
                      ...current,
                      fieldOverrides: current.fieldOverrides.filter((_, at) => at !== index),
                    }))
                  }
                >
                  删除
                </Button>
              </div>
            </div>
          );
        })}

        <div className="flex flex-col gap-2 rounded-xl bg-paper-sunken p-3">
          <SelectField
            label="新增改写：条目"
            value={target}
            options={[
              { value: '', label: '请选择' },
              ...[...candidates.entries()].map(([key, entry]) => ({
                value: key,
                label: entry.title,
              })),
            ]}
            onChange={(event) => {
              setTarget((event.target as unknown as HTMLSelectElement).value);
              setFieldKey('');
            }}
          />
          {chosen ? (
            mutableFields.length > 0 ? (
              <>
                <SelectField
                  label="字段（只列这条世界线能改写的）"
                  value={fieldKey}
                  options={[
                    { value: '', label: '请选择' },
                    ...mutableFields.map((field) => ({ value: field.key, label: field.label })),
                  ]}
                  onChange={(event) =>
                    setFieldKey((event.target as unknown as HTMLSelectElement).value)
                  }
                />
                <TextAreaField
                  label="新值"
                  rows={2}
                  value={value}
                  hint={`${value.trim().length} / ${MAX_VALUE}`}
                  onChange={(event) => setValue(event.target.value)}
                />
                <div>
                  <Button
                    size="sm"
                    disabled={!fieldKey || !value.trim() || value.trim().length > MAX_VALUE}
                    onClick={addOverride}
                  >
                    添加改写
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-ink-500">这个条目没有可以被世界线改写的字段。</p>
            )
          ) : null}
        </div>
      </section>

      <RemovableList
        title="本线新出现"
        items={delta.lineEntries.map((line) => line.title)}
        onRemove={(index) =>
          setDelta((current) => ({
            ...current,
            lineEntries: current.lineEntries.filter((_, at) => at !== index),
          }))
        }
      />
      <RemovableList
        title="状态"
        items={delta.statusChanges.map(
          (item) =>
            `${titleOf(item.target)}：${ENTRY_STATUS_LABELS[item.status]}${item.note ? `（${item.note}）` : ''}`,
        )}
        onRemove={(index) =>
          setDelta((current) => ({
            ...current,
            statusChanges: current.statusChanges.filter((_, at) => at !== index),
          }))
        }
      />
      <RemovableList
        title="主角状态"
        items={delta.ocChanges.map(
          (item) =>
            `${OC_ASPECT_LABELS[item.aspect]}${item.op === 'add' ? '新增' : '去掉'}：${item.text}`,
        )}
        onRemove={(index) =>
          setDelta((current) => ({
            ...current,
            ocChanges: current.ocChanges.filter((_, at) => at !== index),
          }))
        }
      />
      <RemovableList
        title="事件"
        items={delta.events}
        onRemove={(index) =>
          setDelta((current) => ({
            ...current,
            events: current.events.filter((_, at) => at !== index),
          }))
        }
      />
      <RemovableList
        title="标记"
        items={delta.flags.map((flag) => `${flag.key}：${flag.value}`)}
        onRemove={(index) =>
          setDelta((current) => ({
            ...current,
            flags: current.flags.filter((_, at) => at !== index),
          }))
        }
      />

      {error ? (
        <p role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}

function RemovableList({
  title,
  items,
  onRemove,
}: {
  title: string;
  items: string[];
  onRemove: (index: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((text, index) => (
          <li key={`${index}-${text}`} className="flex items-center gap-2 text-sm text-ink-700">
            <span className="min-w-0 flex-1">{text}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`删除${title}：${text}`}
              onClick={() => onRemove(index)}
            >
              删除
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
