import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckIcon, ImportIcon, MoreIcon, PlusIcon } from '@/ui/icons';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import { useRepository } from '@/data/RepositoryProvider';
import type { Novel, NovelDraft, ShelfItem } from '@/domain/schema';
import { Button, IconButton } from '@/ui/Button';
import { SegmentedControl } from '@/ui/Controls';
import { SelectField, TextAreaField, TextField } from '@/ui/Field';
import { EmptyState, Page } from '@/ui/Page';
import { ConfirmDialog, Sheet } from '@/ui/Sheet';
import { formatRelativeTime, formatWordCount } from '@/ui/format';
import { shouldRemindBackup, useBackupReminder } from '../export/backupReminder';

const POV_OPTIONS = [
  { value: 'third-limited', label: '第三人称限知（最常用）' },
  { value: 'first', label: '第一人称' },
  { value: 'third-omniscient', label: '第三人称全知' },
];

interface DraftForm {
  title: string;
  oneLiner: string;
  genre: string;
  pov: Novel['pov'];
}

const EMPTY_FORM: DraftForm = {
  title: '',
  oneLiner: '',
  genre: '',
  pov: 'third-limited',
};

export function ShelfPage() {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const { activeNovelId, setActiveNovel } = useActiveNovel();

  const { data: items, loading, error } = useRepoQuery((repo) => repo.listShelfItems(), []);

  /**
   * 备份提醒。
   *
   * 放在书架而不是设置页：需要提醒的恰恰是不会主动翻设置的人。
   * 攒够字数才提，并且可以「以后再说」—— 反复弹同一条横幅比不提醒
   * 更容易被永久忽略。
   */
  const { lastBackupAt, dismissedAt, dismiss: dismissBackupReminder } = useBackupReminder();
  const totalWords = (items ?? []).reduce((sum, item) => sum + item.stats.wordCount, 0);
  const remindBackup = shouldRemindBackup({ lastBackupAt, dismissedAt }, totalWords);

  const [createOpen, setCreateOpen] = useState(false);
  /**
   * 新建作品的两条路：从零立项，还是导入已有稿件。
   *
   * 存量作者手里有几十万字、却还没有「我想讲一个什么故事」那句话 ——
   * 在导入模式下问这个问题是错的，那句话应当由稿件反推出来。
   */
  const [createMode, setCreateMode] = useState<'fresh' | 'import'>('fresh');
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  /** 正在操作的小说（打开操作菜单 / 编辑 / 删除） */
  const [actionTarget, setActionTarget] = useState<Novel | null>(null);
  const [editTarget, setEditTarget] = useState<Novel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Novel | null>(null);

  function openCreate(mode: 'fresh' | 'import' = 'fresh') {
    setForm(EMPTY_FORM);
    setFormError(undefined);
    setCreateMode(mode);
    setCreateOpen(true);
  }

  function openEdit(novel: Novel) {
    setActionTarget(null);
    setEditTarget(novel);
    setForm({
      title: novel.title,
      oneLiner: novel.oneLiner,
      genre: novel.genre,
      pov: novel.pov,
    });
    setFormError(undefined);
  }

  async function submitCreate() {
    if (!form.title.trim()) {
      setFormError('书名不能为空');
      return;
    }
    setSaving(true);
    try {
      const draft: NovelDraft = {
        title: form.title.trim(),
        oneLiner: form.oneLiner.trim(),
        genre: form.genre.trim(),
        pov: form.pov,
      };
      const novel = await repository.createNovel(draft);
      // 新建后直接设为当前作品，省掉一次手动选择
      setActiveNovel(novel.id);
      invalidate();
      setCreateOpen(false);
      if (createMode === 'import') {
        // 导入面板住在知识库页，带着意图跳过去让它自己打开，
        // 用户不必再去「管理」区里翻一遍
        navigate('/knowledge', { state: { openImport: true } });
      }
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit() {
    if (!editTarget) return;
    if (!form.title.trim()) {
      setFormError('书名不能为空');
      return;
    }
    setSaving(true);
    try {
      await repository.updateNovel(editTarget.id, {
        title: form.title.trim(),
        oneLiner: form.oneLiner.trim(),
        genre: form.genre.trim(),
        pov: form.pov,
      });
      invalidate();
      setEditTarget(null);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await repository.deleteNovel(deleteTarget.id);
    // 删掉的正好是当前作品时要清空，否则其他 Tab 会指向不存在的书
    if (activeNovelId === deleteTarget.id) setActiveNovel(null);
    invalidate();
    setDeleteTarget(null);
  }

  function openNovel(novel: Novel) {
    setActiveNovel(novel.id);
    navigate('/knowledge');
  }

  return (
    <Page
      title="书架"
      subtitle="从一句话开始一本新书"
      width="wide"
      action={
        <IconButton label="新建作品" onClick={() => openCreate('fresh')} className="text-ink-900">
          <PlusIcon className="h-6 w-6" />
        </IconButton>
      }
    >
      {error ? (
        <p role="alert" className="rounded-xl bg-seal-soft px-4 py-3 text-sm text-seal">
          读取失败：{error.message}
        </p>
      ) : null}

      {remindBackup ? (
        <div className="mb-4 rounded-2xl border border-accent/30 bg-accent-soft px-4 py-3 lg:flex lg:items-center lg:justify-between lg:gap-6">
          <p className="text-sm leading-relaxed text-accent">
            已经写下 {formatWordCount(totalWords)}，导出一份备份吧。
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            作品存在这台设备的浏览器里，清除浏览器数据或换手机都会带走它们。
          </p>
          <div className="mt-2.5 flex shrink-0 gap-2 lg:mt-0">
            <Button variant="primary" size="sm" onClick={() => navigate('/settings')}>
              去备份
            </Button>
            <Button size="sm" onClick={() => dismissBackupReminder()}>
              以后再说
            </Button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="py-10 text-center text-sm text-ink-300">加载中…</p>
      ) : items && items.length > 0 ? (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <NovelCard
              key={item.novel.id}
              item={item}
              active={item.novel.id === activeNovelId}
              onOpen={() => openNovel(item.novel)}
              onMore={() => setActionTarget(item.novel)}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          title="还没有作品"
          description="还没动笔就写下「我想讲一个什么故事」，世界观、人物与大纲都能由此生成；已经写了很多就直接导入稿件。"
          action={
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="primary" size="lg" onClick={() => openCreate('fresh')}>
                创建第一本作品
              </Button>
              <Button variant="secondary" size="lg" onClick={() => openCreate('import')}>
                <ImportIcon className="h-5 w-5" />
                导入已有稿件
              </Button>
            </div>
          }
        />
      )}

      {/* 新建 */}
      <Sheet
        open={createOpen}
        title="新建作品"
        description="只有书名是必填的，其余都能之后再补。"
        onClose={() => setCreateOpen(false)}
        footer={
          <Button variant="primary" size="lg" block disabled={saving} onClick={submitCreate}>
            {saving ? '创建中…' : createMode === 'import' ? '创建并导入稿件' : '创建'}
          </Button>
        }
      >
        <SegmentedControl<'fresh' | 'import'>
          label="从哪里开始"
          value={createMode}
          options={[
            {
              value: 'fresh',
              label: '从一句话',
              description: '还没动笔。用一句话生成世界观、人物与全书大纲。',
            },
            {
              value: 'import',
              label: '导入已有稿件',
              description: '已经写了一些。上传 .txt / .md 文件，自动分章并反推出知识库。',
            },
          ]}
          onChange={setCreateMode}
        />

        <NovelForm
          form={form}
          onChange={setForm}
          error={formError}
          // 存量作者还没有那句话，它应当由稿件反推出来，而不是在这里逼他先想一个
          hideOneLiner={createMode === 'import'}
        />
      </Sheet>

      {/* 编辑 */}
      <Sheet
        open={editTarget !== null}
        title="编辑作品信息"
        onClose={() => setEditTarget(null)}
        footer={
          <Button variant="primary" size="lg" block disabled={saving} onClick={submitEdit}>
            {saving ? '保存中…' : '保存'}
          </Button>
        }
      >
        <NovelForm form={form} onChange={setForm} error={formError} />
      </Sheet>

      {/* 操作菜单 */}
      <Sheet
        open={actionTarget !== null}
        title={actionTarget?.title ?? ''}
        onClose={() => setActionTarget(null)}
      >
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            size="lg"
            block
            onClick={() => {
              if (actionTarget) {
                setActiveNovel(actionTarget.id);
                setActionTarget(null);
              }
            }}
          >
            设为当前作品
          </Button>
          <Button
            variant="secondary"
            size="lg"
            block
            onClick={() => actionTarget && openEdit(actionTarget)}
          >
            编辑作品信息
          </Button>
          <Button
            variant="danger"
            size="lg"
            block
            onClick={() => {
              setDeleteTarget(actionTarget);
              setActionTarget(null);
            }}
          >
            删除作品
          </Button>
        </div>
      </Sheet>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这本书？"
        message={`《${deleteTarget?.title ?? ''}》的章节正文、知识库条目、大纲与写作记录都会一并删除，且无法恢复。`}
        confirmLabel="永久删除"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </Page>
  );
}

function NovelCard({
  item,
  active,
  onOpen,
  onMore,
}: {
  item: ShelfItem;
  active: boolean;
  onOpen: () => void;
  onMore: () => void;
}) {
  const { novel, stats } = item;

  return (
    <li
      className={[
        'rounded-2xl border bg-paper-raised transition-colors',
        active ? 'border-seal/40 ring-1 ring-seal/20' : 'border-ink-100 hover:border-ink-300',
      ].join(' ')}
    >
      <div className="flex h-full items-start gap-1">
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 rounded-2xl px-4 py-3.5 text-left transition-colors active:bg-paper-sunken hover:bg-paper-sunken"
        >
          <div className="flex items-center gap-2">
            {active ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-seal-soft px-2 py-0.5 text-[0.6875rem] font-medium text-seal">
                <CheckIcon className="h-3 w-3" strokeWidth={2.6} />
                当前
              </span>
            ) : null}
            <h2 className="truncate font-semibold text-ink-900">{novel.title}</h2>
          </div>

          {novel.oneLiner ? (
            <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-ink-500">
              {novel.oneLiner}
            </p>
          ) : (
            <p className="mt-1.5 text-sm text-ink-300">还没写一句话简介</p>
          )}

          <dl className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
            <div className="flex gap-1">
              <dt className="sr-only">章节数</dt>
              <dd>{stats.chapterCount} 章</dd>
            </div>
            {/* 章数只算主线；外传另起一项，总字数照常包含外传 */}
            {stats.sideChapterCount > 0 ? (
              <>
                <span aria-hidden="true" className="text-ink-100">
                  ·
                </span>
                <div className="flex gap-1">
                  <dt className="sr-only">外传章节数</dt>
                  <dd>外传 {stats.sideChapterCount} 章</dd>
                </div>
              </>
            ) : null}
            <span aria-hidden="true" className="text-ink-100">
              ·
            </span>
            <div className="flex gap-1">
              <dt className="sr-only">总字数</dt>
              <dd>{formatWordCount(stats.wordCount)}</dd>
            </div>
            <span aria-hidden="true" className="text-ink-100">
              ·
            </span>
            <div className="flex gap-1">
              <dt className="sr-only">知识库条目数</dt>
              <dd>{stats.entryCount} 条设定</dd>
            </div>
            {stats.pendingProposalCount > 0 ? (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] font-medium text-accent">
                {stats.pendingProposalCount} 条待确认
              </span>
            ) : null}
          </dl>

          <p className="mt-2 text-[0.6875rem] text-ink-300">
            {formatRelativeTime(novel.updatedAt)}更新
          </p>
        </button>

        <div className="pt-2.5 pr-1.5">
          <IconButton label={`${novel.title} 的更多操作`} onClick={onMore}>
            <MoreIcon className="h-5 w-5" />
          </IconButton>
        </div>
      </div>
    </li>
  );
}

function NovelForm({
  form,
  onChange,
  error,
  hideOneLiner = false,
}: {
  form: DraftForm;
  onChange: (next: DraftForm) => void;
  error?: string;
  hideOneLiner?: boolean;
}) {
  return (
    <>
      <TextField
        label="书名"
        value={form.title}
        error={error}
        placeholder="例如：归墟纪"
        onChange={(event) => onChange({ ...form, title: event.target.value })}
      />
      {hideOneLiner ? (
        <p className="text-xs leading-relaxed text-ink-500">
          「我想讲一个什么故事」这一栏先留空 —— 导入稿件后，它会从正文里反推出来交你确认。
        </p>
      ) : (
        <TextAreaField
          label="我想讲一个什么故事"
          rows={4}
          value={form.oneLiner}
          placeholder="一句话说清故事内核，例如：一个失忆的剑客发现自己就是三年前灭门案的凶手。"
          hint="这句话会作为后续生成世界观、人物与大纲的锚点，写得具体一点效果更好。"
          onChange={(event) => onChange({ ...form, oneLiner: event.target.value })}
        />
      )}
      <TextField
        label="体裁"
        value={form.genre}
        placeholder="例如：仙侠 / 悬疑 / 科幻"
        onChange={(event) => onChange({ ...form, genre: event.target.value })}
      />
      <SelectField
        label="叙述视角"
        options={POV_OPTIONS}
        value={form.pov}
        onChange={(event) =>
          onChange({ ...form, pov: (event.target as HTMLSelectElement).value as Novel['pov'] })
        }
      />
    </>
  );
}
