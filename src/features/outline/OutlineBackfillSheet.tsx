import { useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import type { Chapter } from '@/domain/schema';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import type { BackfillOutlinePlanItem } from './backfillOutline';

/** 预览里摘要只露前 60 字：够判断是哪一章，又不把面板撑成阅读器 */
const SYNOPSIS_PREVIEW_CHARS = 60;

/**
 * 「按已有章节生成大纲」预览面板（M3 S2）。
 *
 * 存量作者导入的旧稿常常几十章正文却没有大纲：这里做的是纯 1:1 映射，
 * 不调模型、不发明内容 —— 只在作者点「生成」时把既有章节列进大纲树，
 * 关闭面板什么都不写（不经确认不落库的原则与其它提案一致）。
 */
export function OutlineBackfillSheet({
  open,
  novelId,
  plan,
  chapters,
  onClose,
}: {
  open: boolean;
  novelId: string;
  /** 回溯计划（planOutlineBackfill 的结果）；空计划时入口本不该出现 */
  plan: readonly BackfillOutlinePlanItem[];
  /** 章节列表：预览用现有字数（仅参考），plan 里不再带 targetWords */
  chapters: readonly Chapter[];
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /** 成功后已创建的节点数；null 表示还在预览阶段 */
  const [createdCount, setCreatedCount] = useState<number | null>(null);
  const wordCountByChapterId = new Map(
    chapters.map((chapter) => [chapter.id, chapter.wordCount] as const),
  );

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      const created = await repository.commitOutlineBackfill(novelId, plan);
      invalidate();
      setCreatedCount(created.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '生成失败');
    } finally {
      setBusy(false);
    }
  }

  /** 关闭即不写：只有点「生成」才会调用仓储；关掉后下次打开重新从预览开始 */
  function close() {
    setBusy(false);
    setError(undefined);
    setCreatedCount(null);
    onClose();
  }

  return (
    <Sheet
      open={open}
      title="按已有章节生成大纲"
      description="只建结构：每章生成一个顶层大纲节点，不改正文、编号与标题；生成后可手动分卷。"
      onClose={close}
      footer={
        createdCount !== null ? (
          <Button variant="primary" size="lg" block onClick={close}>
            完成
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            block
            disabled={busy || plan.length === 0}
            onClick={() => void confirm()}
          >
            {busy ? '正在生成…' : `生成 ${plan.length} 个章节节点`}
          </Button>
        )
      }
    >
      {createdCount !== null ? (
        <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          已生成 {createdCount} 个节点，可手动分卷。
        </p>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-ink-500">
            将按章节顺序生成 {plan.length} 个顶层节点：
          </p>
          {plan.length === 0 ? (
            <p className="text-sm text-ink-300">没有可回填的章节（空章节或都已关联大纲）。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {plan.map((item) => {
                const synopsis =
                  item.synopsis.length > SYNOPSIS_PREVIEW_CHARS
                    ? `${item.synopsis.slice(0, SYNOPSIS_PREVIEW_CHARS)}…`
                    : item.synopsis;
                // 回溯节点不设写作目标：现有字数只用来判断「这一章写了多少」，仅参考
                const wordCount = wordCountByChapterId.get(item.chapterId) ?? 0;
                return (
                  <li key={item.chapterId} className="rounded-xl border border-ink-100 px-3 py-2">
                    <p className="text-sm font-medium text-ink-900">
                      第 {item.index} 章 {item.title}
                    </p>
                    {wordCount > 0 ? (
                      <p className="mt-0.5 text-xs text-ink-300">
                        本章现有 {wordCount} 字（仅参考，不设为目标）
                      </p>
                    ) : null}
                    {synopsis ? (
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{synopsis}</p>
                    ) : (
                      <p className="mt-0.5 text-xs text-ink-300">梗概暂空，可生成后手动补</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {error ? (
            <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5">
              <p className="text-sm text-seal">{error}</p>
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
