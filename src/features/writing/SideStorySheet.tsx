import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import type { Chapter, SideStory } from '@/domain/schema';
import { chaptersOfTrack, sideStoryLabel } from '@/domain/sideStory';
import { Button } from '@/ui/Button';
import { TextAreaField, TextField } from '@/ui/Field';
import { ConfirmDialog, Sheet } from '@/ui/Sheet';

interface SideStorySheetProps {
  open: boolean;
  novelId: string;
  /** 传入为编辑，不传为新建 */
  sideStory?: SideStory | undefined;
  /** 作品的全部章节，用于删除确认里的章数与字数 */
  chapters: Chapter[];
  onClose: () => void;
}

/** 仓储抛出的错误：schema 校验取第一条中文 message，其余直接用 message */
function messageOf(cause: unknown): string {
  if (cause instanceof z.ZodError) return cause.issues[0]?.message ?? '保存失败';
  return cause instanceof Error ? cause.message : '保存失败';
}

/**
 * 新建 / 编辑外传。
 *
 * 外传进展摘要只读展示：它由摘要链维护，手改会让下一章的摘要承接不上，
 * 要改走摘要提案。
 */
export function SideStorySheet({
  open,
  novelId,
  sideStory,
  chapters,
  onClose,
}: SideStorySheetProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();

  const [title, setTitle] = useState(sideStory?.title ?? '');
  const [synopsis, setSynopsis] = useState(sideStory?.synopsis ?? '');
  const [saving, setSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 只在「关闭 → 打开」时重置，避免外部数据刷新冲掉正在输入的内容
  const wasOpen = useRef(false);
  const seedRef = useRef(sideStory);
  seedRef.current = sideStory;
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTitle(seedRef.current?.title ?? '');
      setSynopsis(seedRef.current?.synopsis ?? '');
      setTitleError(undefined);
      setError(undefined);
    }
    wasOpen.current = open;
  }, [open]);

  const storyChapters = sideStory ? chaptersOfTrack(chapters, sideStory.id) : [];
  const storyWords = storyChapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

  async function save() {
    if (!title.trim()) {
      setTitleError('外传名称不能为空');
      return;
    }
    setSaving(true);
    setTitleError(undefined);
    setError(undefined);
    try {
      if (sideStory) {
        await repository.updateSideStory(sideStory.id, { title, synopsis });
      } else {
        await repository.createSideStory(novelId, { title, synopsis });
      }
      invalidate();
      onClose();
    } catch (cause) {
      // 重名、名称过长都落在「名称」上；其余（简介过长、外传已被删）显示在表单底部
      const message = messageOf(cause);
      if (message.includes('名称') || message.includes('同名')) setTitleError(message);
      else setError(message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!sideStory) return;
    try {
      await repository.deleteSideStory(sideStory.id);
      invalidate();
      setConfirmDelete(false);
      onClose();
    } catch (cause) {
      setConfirmDelete(false);
      setError(messageOf(cause));
    }
  }

  return (
    <>
      <Sheet
        open={open}
        title={sideStory ? `编辑${sideStoryLabel(sideStory)}` : '新建外传'}
        description="外传独立于主线，各自从第 1 章编号。"
        onClose={onClose}
        footer={
          <Button variant="primary" size="lg" block disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </Button>
        }
      >
        <TextField
          label="名称"
          value={title}
          required
          placeholder="例如：青冥旧事"
          {...(titleError ? { error: titleError } : {})}
          onChange={(event) => setTitle(event.target.value)}
        />

        <TextAreaField
          label="简介"
          rows={4}
          value={synopsis}
          hint="写清这部外传讲什么、发生在主线的什么时候（之前、同期还是之后）。写外传时会交给模型。"
          onChange={(event) => setSynopsis(event.target.value)}
        />

        {sideStory?.rollingSummary.trim() ? (
          <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
            <p className="mb-1 text-xs font-medium text-ink-700">外传进展摘要</p>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-700">
              {sideStory.rollingSummary}
            </p>
            <p className="mt-2 text-xs text-ink-500">由章节摘要维护，标记章节完成后会提议更新。</p>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
            {error}
          </p>
        ) : null}

        {sideStory ? (
          <Button variant="danger" size="md" block onClick={() => setConfirmDelete(true)}>
            删除这部外传
          </Button>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title="删除外传？"
        message={
          sideStory
            ? `${sideStoryLabel(sideStory)} 及其 ${storyChapters.length} 章（共 ${storyWords} 字）会被永久删除，无法恢复。`
            : ''
        }
        confirmLabel="永久删除"
        destructive
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
