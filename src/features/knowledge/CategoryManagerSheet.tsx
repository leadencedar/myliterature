import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import { SUGGESTED_CATEGORIES } from '@/domain/defaults';
import type { Category, FieldDef, KnowledgeEntry } from '@/domain/schema';
import { fieldMutability } from '@/domain/worldline';
import { Button, IconButton } from '@/ui/Button';
import { Toggle } from '@/ui/Controls';
import { SelectField, TextField } from '@/ui/Field';
import { ConfirmDialog, Sheet } from '@/ui/Sheet';
import { PlusIcon, TrashIcon } from '@/ui/icons';

const FIELD_TYPE_OPTIONS = [
  { value: 'text', label: '单行文本' },
  { value: 'longtext', label: '多行文本' },
  { value: 'list', label: '列表（每行一项）' },
];

/**
 * 为新字段生成 key。
 *
 * key 一旦创建就不再允许修改：条目的数据是按 key 存的，改 key 等于让已有内容
 * 凭空消失。所以界面上只让改标签、类型和指引，不暴露 key。
 */
function nextFieldKey(existing: FieldDef[]): string {
  let max = 0;
  for (const field of existing) {
    const match = /^f(\d+)$/u.exec(field.key);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `f${max + 1}`;
}

export function CategoryManagerSheet({
  open,
  novelId,
  categories,
  entries,
  onClose,
}: {
  open: boolean;
  novelId: string;
  categories: Category[];
  entries: KnowledgeEntry[];
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState<Category | null>(null);
  const [error, setError] = useState<string | undefined>();

  const countOf = (categoryId: string) =>
    entries.filter((entry) => entry.categoryId === categoryId).length;

  async function addSuggested(name: string, fieldTemplate: FieldDef[]) {
    setError(undefined);
    try {
      await repository.createCategory(novelId, { name, fieldTemplate });
      invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败');
    }
  }

  async function addBlank() {
    setError(undefined);
    const created = await repository.createCategory(novelId, {
      name: '新分类',
      fieldTemplate: [
        { key: 'f1', label: '简介', type: 'longtext', placeholder: '', hint: '这是什么。' },
      ],
    });
    invalidate();
    setEditing(created);
  }

  const existingNames = new Set(categories.map((item) => item.name));
  const available = SUGGESTED_CATEGORIES.filter((item) => !existingNames.has(item.name));

  return (
    <>
      <Sheet open={open} title="分类管理" description="分类决定条目有哪些字段。" onClose={onClose}>
        <ul className="flex flex-col gap-2">
          {categories.map((category) => (
            <li
              key={category.id}
              className="flex items-center gap-2 rounded-xl border border-ink-100 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-ink-900">{category.name}</p>
                  {category.builtin ? (
                    <span className="shrink-0 rounded-full bg-paper-sunken px-2 py-0.5 text-[0.6875rem] text-ink-500">
                      内置
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-ink-500">
                  {category.fieldTemplate.length} 个字段 · {countOf(category.id)} 个条目
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setEditing(category)}>
                编辑
              </Button>
            </li>
          ))}
        </ul>

        {error ? (
          <p role="alert" className="rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
            {error}
          </p>
        ) : null}

        {available.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-ink-700">添加常用分类</p>
            <div className="flex flex-wrap gap-2">
              {available.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => addSuggested(item.name, item.fieldTemplate)}
                  className="rounded-full border border-ink-100 bg-paper-raised px-3 py-1.5 text-sm text-ink-700 active:bg-paper-sunken"
                >
                  + {item.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <Button variant="secondary" size="md" block onClick={addBlank}>
          新建空白分类
        </Button>
      </Sheet>

      {editing ? (
        <CategoryEditorSheet
          category={editing}
          entryCount={countOf(editing.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function CategoryEditorSheet({
  category,
  entryCount,
  onClose,
}: {
  category: Category;
  entryCount: number;
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();

  const [name, setName] = useState(category.name);
  const [fields, setFields] = useState<FieldDef[]>(category.fieldTemplate);
  const [error, setError] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  // 分类对象来自列表查询，刷新后是新引用；只在首次挂载时取初值
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setName(category.name);
    setFields(category.fieldTemplate);
  }, [category]);

  function patchField(index: number, patch: Partial<FieldDef>) {
    setFields(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  }

  function addField() {
    setFields([
      ...fields,
      { key: nextFieldKey(fields), label: '新字段', type: 'longtext', placeholder: '', hint: '' },
    ]);
  }

  async function save() {
    if (!name.trim()) {
      setError('分类名不能为空');
      return;
    }
    if (fields.some((field) => !field.label.trim())) {
      setError('字段标签不能为空');
      return;
    }
    setSaving(true);
    try {
      await repository.updateCategory(category.id, { name: name.trim(), fieldTemplate: fields });
      invalidate();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setError(undefined);
    try {
      await repository.deleteCategory(category.id);
      invalidate();
      setConfirmDelete(false);
      onClose();
    } catch (cause) {
      setConfirmDelete(false);
      setError(cause instanceof Error ? cause.message : '删除失败');
    }
  }

  return (
    <>
      <Sheet
        open
        title={`编辑分类 · ${category.name}`}
        description="字段的标签与指引可以随时改；指引会作为写作要求进入提示词。"
        onClose={onClose}
        footer={
          <Button variant="primary" size="lg" block disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </Button>
        }
      >
        <TextField label="分类名" value={name} onChange={(event) => setName(event.target.value)} />

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-ink-700">字段（{fields.length}）</p>
            <Button size="sm" variant="secondary" onClick={addField}>
              <PlusIcon className="h-4 w-4" />
              加字段
            </Button>
          </div>

          {fields.map((field, index) => (
            <div key={field.key} className="flex flex-col gap-2 rounded-xl bg-paper-sunken p-3">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <TextField
                    label="标签"
                    value={field.label}
                    onChange={(event) => patchField(index, { label: event.target.value })}
                  />
                </div>
                <IconButton
                  label={`删除字段「${field.label}」`}
                  onClick={() => setFields(fields.filter((_, i) => i !== index))}
                >
                  <TrashIcon className="h-4 w-4" />
                </IconButton>
              </div>
              <SelectField
                label="类型"
                options={FIELD_TYPE_OPTIONS}
                value={field.type}
                onChange={(event) =>
                  patchField(index, {
                    type: (event.target as HTMLSelectElement).value as FieldDef['type'],
                  })
                }
              />
              <TextField
                label="写作指引"
                value={field.hint}
                placeholder="告诉 AI 这一栏该写什么"
                onChange={(event) => patchField(index, { hint: event.target.value })}
              />
              {/* 没存 mutability 的旧字段按内置默认显示（与推演里的解析同一口径）；拨动后才写进模板 */}
              <Toggle
                label="世界线可改写"
                ariaLabel={`「${field.label}」世界线可改写`}
                description="关掉后这一栏是底层设定，互动推演里的世界线不能改写它；单个条目可以另设。"
                checked={
                  fieldMutability({ ...category, fieldTemplate: fields }, undefined, field.key) ===
                  'mutable'
                }
                onChange={(checked) =>
                  patchField(index, { mutability: checked ? 'mutable' : 'locked' })
                }
              />
            </div>
          ))}

          <p className="text-xs leading-relaxed text-ink-300">
            删除字段不会删掉条目里已填的内容，只是不再显示；把字段加回来内容就会重新出现。
          </p>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
            {error}
          </p>
        ) : null}

        {category.builtin ? (
          <p className="text-xs text-ink-500">内置分类不可删除，但可以改名与调整字段。</p>
        ) : (
          <Button variant="danger" size="md" block onClick={() => setConfirmDelete(true)}>
            删除这个分类
          </Button>
        )}
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title="删除分类？"
        message={
          entryCount > 0
            ? `「${category.name}」下还有 ${entryCount} 个条目，需要先移走或删除这些条目。`
            : `「${category.name}」将被删除，此操作不可恢复。`
        }
        confirmLabel="删除"
        destructive
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
