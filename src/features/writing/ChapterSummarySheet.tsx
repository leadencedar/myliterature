import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import type {
  Chapter,
  ChapterSummary,
  KnowledgeEntry,
  Novel,
  Proposal,
  SideStory,
} from '@/domain/schema';
import { chapterLabel, sideStoryLabel } from '@/domain/sideStory';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { buildCreateProposal, buildReplaceProposal, newBatchId } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { ProposalInbox } from '../proposals/ProposalInbox';
import {
  ChapterSummaryResultSchema,
  buildSummarySystemPrompt,
  buildSummaryUserPrompt,
  mergeOpenThreads,
  previousSummaryOf,
  resolveEntryNames,
} from './chapterSummary';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; note: string }
  | { kind: 'review'; batchId: string; appearing: string[] }
  | { kind: 'error'; message: string; detail?: string };

interface ChapterSummarySheetProps {
  open: boolean;
  novel: Novel;
  chapter: Chapter;
  chapters: Chapter[];
  summaries: ChapterSummary[];
  entries: KnowledgeEntry[];
  /**
   * 所属外传，**只用于展示**（面板标题）。「是不是外传、是哪一部」只看
   * chapter.sideStoryId，外传进展在生成时从仓储读最新值
   */
  sideStory?: SideStory;
  /** 打开时立即开始生成，用于「标记完成」后的自动触发 */
  autoStart: boolean;
  onClose: () => void;
}

/**
 * 章节摘要生成。
 *
 * 由「把章节标记为已完成」自动触发 —— 摘要是后续所有章节的上下文来源，
 * 如果指望用户记得手动补，摘要链很快就会断，而断了之后的表现是
 * 「AI 越写越不记得前面的事」，用户往往归因为模型不行，其实是缺摘要。
 *
 * 生成结果拆成两条提案：本章摘要（chapterSummary）与全书进展（novel），
 * 都要经确认才落库。外传章节的第二条是外传进展（sideStory），不碰主线进展。
 */
export function ChapterSummarySheet({
  open,
  novel,
  chapter,
  chapters,
  summaries,
  entries,
  sideStory,
  autoStart,
  onClose,
}: ChapterSummarySheetProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const llm = useLlm();

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const existing = summaries.find((item) => item.chapterId === chapter.id);
  const previous = previousSummaryOf(chapters, summaries, chapter.id);

  // 用 ref 读取最新数据，避免把每次刷新都变成一次重置
  const dataRef = useRef({ novel, chapter, chapters, summaries, entries, existing, previous });
  dataRef.current = { novel, chapter, chapters, summaries, entries, existing, previous };

  const generateRef = useRef(async () => {
    const data = dataRef.current;
    if (!data.chapter.content.trim()) {
      setPhase({ kind: 'error', message: '本章还没有正文，无法提炼摘要' });
      return;
    }

    setPhase({ kind: 'running', note: '正在通读本章…' });
    try {
      // 外传进展在这里读最新值，不在挂载 effect 里读：autoStart 时生成会先于异步读取开始，
      // 拿到旧进展的话，采用后会把正确的版本覆盖掉
      const sideId = data.chapter.sideStoryId ?? null;
      const story = sideId ? await repository.getSideStory(sideId) : null;
      if (sideId !== null && !story) {
        setPhase({ kind: 'error', message: '这部外传已不存在，可能已被删除' });
        return;
      }
      // 规范同样在发请求前读最新值：作者刚在知识库改过规范，这一章的摘要就该按新的来。
      // 读取失败走下面现有的 catch，与模型失败同一条路径，不生成提案
      const norms = await repository.listWritingNorms(data.novel.id);

      const result = await llm.runStructured('chapter-summary', {
        schema: ChapterSummaryResultSchema,
        schemaName: 'ChapterSummary',
        system: buildSummarySystemPrompt(data.novel, norms),
        user: buildSummaryUserPrompt({
          chapter: data.chapter,
          entryNames: data.entries.map((entry) => entry.title),
          previousOpenThreads: data.previous?.openThreads ?? [],
          previousRollingSummary: story ? story.rollingSummary : data.novel.rollingSummary,
          ...(story ? { sideStory: { title: story.title, synopsis: story.synopsis } } : {}),
        }),
        onAttempt: ({ repairing }) =>
          setPhase({
            kind: 'running',
            note: repairing ? '输出格式有偏差，正在请模型修正…' : '正在通读本章…',
          }),
      });

      const appearingEntryIds = resolveEntryNames(data.entries, result.data.appearingEntries);
      const openThreads = mergeOpenThreads(
        data.previous?.openThreads ?? [],
        result.data.resolvedThreads,
        result.data.newOpenThreads,
      );

      const batchId = newBatchId();
      const sourceRef = story ? chapterLabel(data.chapter, [story]) : `第 ${data.chapter.index} 章`;
      const summarySpecs = fieldSpecsFor('chapterSummary');
      const summaryPayload = {
        chapterId: data.chapter.id,
        summary: result.data.summary,
        keyEvents: result.data.keyEvents,
        appearingEntryIds,
        openThreads,
      };

      const proposals: Proposal[] = [
        data.existing
          ? buildReplaceProposal({
              novelId: data.novel.id,
              batchId,
              order: 0,
              origin: 'refine',
              target: 'chapterSummary',
              label: `${sourceRef}摘要`,
              specs: summarySpecs,
              sourceRef,
              targetId: data.existing.id,
              current: data.existing,
              payload: summaryPayload,
            })
          : buildCreateProposal({
              novelId: data.novel.id,
              batchId,
              order: 0,
              origin: 'refine',
              target: 'chapterSummary',
              label: `${sourceRef}摘要`,
              specs: summarySpecs,
              sourceRef,
              payload: summaryPayload,
            }),
        story
          ? buildReplaceProposal({
              novelId: data.novel.id,
              batchId,
              order: 1,
              origin: 'refine',
              target: 'sideStory',
              label: '外传进展摘要',
              specs: fieldSpecsFor('sideStory'),
              sourceRef,
              targetId: story.id,
              current: { rollingSummary: story.rollingSummary },
              payload: { rollingSummary: result.data.rollingSummary },
            })
          : buildReplaceProposal({
              novelId: data.novel.id,
              batchId,
              order: 1,
              origin: 'refine',
              target: 'novel',
              label: '全书进展摘要',
              specs: fieldSpecsFor('novel'),
              sourceRef,
              targetId: data.novel.id,
              current: { rollingSummary: data.novel.rollingSummary },
              payload: { rollingSummary: result.data.rollingSummary },
            }),
      ];

      await repository.createProposals(proposals);
      invalidate();

      const appearingNames = appearingEntryIds
        .map((id) => data.entries.find((entry) => entry.id === id)?.title)
        .filter((name): name is string => Boolean(name));
      setPhase({ kind: 'review', batchId, appearing: appearingNames });
    } catch (cause) {
      const error = cause instanceof LlmError ? cause : undefined;
      setPhase({
        kind: 'error',
        message: error?.message ?? (cause instanceof Error ? cause.message : '生成失败'),
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  // 只在「关闭 → 打开」时重置；autoStart 时顺势发起生成
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPhase({ kind: 'idle' });
      if (autoStart) void generateRef.current();
    }
    wasOpen.current = open;
  }, [open, autoStart]);

  return (
    <Sheet
      open={open}
      title={sideStory ? `本章摘要 · ${sideStoryLabel(sideStory)}` : '本章摘要'}
      description="摘要是后续章节的上下文来源，写完一章就该留下一份。"
      onClose={onClose}
    >
      {phase.kind === 'idle' || phase.kind === 'error' ? (
        <>
          {existing ? (
            <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
              <p className="mb-1 text-xs font-medium text-ink-700">已有摘要</p>
              <p className="text-sm leading-relaxed text-ink-700">{existing.summary}</p>
              {existing.openThreads.length > 0 ? (
                <p className="mt-2 text-xs text-ink-500">
                  未收束伏笔：{existing.openThreads.join('；')}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-ink-500">这一章还没有摘要。</p>
          )}

          {previous && previous.openThreads.length > 0 ? (
            <p className="text-xs leading-relaxed text-ink-500">
              截至上一章仍有 {previous.openThreads.length}{' '}
              条伏笔未收束，会一并交给模型判断本章是否收束了它们。
            </p>
          ) : null}

          <Button
            variant="primary"
            size="lg"
            block
            disabled={!llm.configured}
            onClick={() => void generateRef.current()}
          >
            {existing ? '重新提炼摘要' : '提炼本章摘要'}
          </Button>

          {!llm.configured ? (
            <p className="text-xs text-ink-500">需要先在「设置」里配置模型。</p>
          ) : null}

          {phase.kind === 'error' ? (
            <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5">
              <p className="text-sm text-seal">{phase.message}</p>
              {phase.detail ? (
                <p className="mt-1 break-words text-xs text-ink-500">{phase.detail}</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {phase.kind === 'running' ? (
        <p aria-live="polite" className="py-6 text-center text-sm text-ink-500">
          {phase.note}
        </p>
      ) : null}

      {phase.kind === 'review' ? (
        <div className="flex flex-col gap-3">
          {phase.appearing.length > 0 ? (
            <p className="text-xs text-ink-500">
              识别到的出场角色与设定：{phase.appearing.join('、')}
              （会记入摘要，用于下一章的默认注入）
            </p>
          ) : null}
          <ProposalInbox
            novelId={novel.id}
            batchId={phase.batchId}
            acceptAllLabel="保存摘要"
            onSettled={onClose}
          />
        </div>
      ) : null}
    </Sheet>
  );
}
