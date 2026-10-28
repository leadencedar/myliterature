import { useState } from 'react';
import { formatTokens } from '@/context/tokens';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import { chaptersOfTrack } from '@/domain/sideStory';
import type {
  Category,
  Chapter,
  ChapterSummary,
  KnowledgeEntry,
  Novel,
  OutlineNode,
  StyleProfile,
  WritingNorm,
} from '@/domain/schema';
import { useLlm } from '@/llm/useLlm';
import { Button } from '@/ui/Button';
import { SegmentedControl } from '@/ui/Controls';
import { Sheet } from '@/ui/Sheet';
import { ProposalInbox } from '../proposals/ProposalInbox';
import {
  FRONTIER_CHAPTER_MAX,
  FRONTIER_CHAPTER_MIN,
  RECENT_CHAPTER_COUNT,
  buildOutlineTail,
  runOutlineContinue,
  type FrontierChapterDraft,
  type OutlineContinueResult,
} from './outlineContinue';

/** 只做展示的「最近章节」摘要（服务内部会再算一遍，这里只为生成前给作者看依据） */
function recentSummariesOf(
  chapters: readonly Chapter[],
  summaries: readonly ChapterSummary[],
): { label: string; summary: ChapterSummary }[] {
  const byChapter = new Map(summaries.map((summary) => [summary.chapterId, summary] as const));
  return chaptersOfTrack(chapters, null)
    .map((chapter) => ({ chapter, summary: byChapter.get(chapter.id) }))
    .filter(
      (item): item is { chapter: Chapter; summary: ChapterSummary } => item.summary !== undefined,
    )
    .slice(-RECENT_CHAPTER_COUNT)
    .map(({ chapter, summary }) => ({
      label: chapter.title.trim() || `第 ${chapter.index} 章`,
      summary,
    }));
}

const COUNT_OPTIONS = Array.from(
  { length: FRONTIER_CHAPTER_MAX - FRONTIER_CHAPTER_MIN + 1 },
  (_, index) => {
    const count = FRONTIER_CHAPTER_MIN + index;
    return { value: String(count), label: `${count} 章` };
  },
);

type ContinueState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'review'; result: OutlineContinueResult }
  | { kind: 'error'; message: string };

/**
 * 规划后续 3–5 章大纲（M3 S4）。
 *
 * 只做「规划」，一次结构化调用产出一份 outlineTree 提案：不写正文、不自动落库。
 * 生成前把「本次依据」摆出来（大纲尾部/进展/最近摘要/伏笔），作者确认上下文够不够；
 * 生成后再把实际注入的核心/相关设定与 token 展开，最后仍需在提案里点采用才写入大纲。
 */
export function OutlineContinueSheet({
  open,
  novel,
  style,
  outline,
  chapters,
  summaries,
  entries,
  categories,
  writingNorms,
  onClose,
}: {
  open: boolean;
  novel: Novel;
  style: StyleProfile;
  outline: readonly OutlineNode[];
  chapters: readonly Chapter[];
  summaries: readonly ChapterSummary[];
  entries: readonly KnowledgeEntry[];
  categories: readonly Category[];
  writingNorms?: readonly WritingNorm[];
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const llm = useLlm();

  const [count, setCount] = useState(FRONTIER_CHAPTER_MIN);
  const [state, setState] = useState<ContinueState>({ kind: 'idle' });

  const tail = buildOutlineTail(outline);
  const recent = recentSummariesOf(chapters, summaries);
  const openThreads = recent[recent.length - 1]?.summary.openThreads ?? [];
  const rolling = novel.rollingSummary.trim();

  async function generate() {
    setState({ kind: 'running' });
    try {
      const result = await runOutlineContinue(
        { repository, llm },
        {
          novel,
          style,
          outline,
          chapters,
          summaries,
          entries,
          categories,
          ...(writingNorms ? { writingNorms } : {}),
          count,
        },
      );
      // 提案已落库，刷新页面「待确认」计数与后续列表
      invalidate();
      setState({ kind: 'review', result });
    } catch (cause) {
      setState({
        kind: 'error',
        message: cause instanceof Error ? cause.message : '续写失败',
      });
    }
  }

  function close() {
    // 关闭不写：只有「生成」会产生待确认提案；关闭只是离开面板
    setState({ kind: 'idle' });
    onClose();
  }

  return (
    <Sheet
      open={open}
      title="规划后续 3–5 章大纲"
      description="仅生成大纲提案，不写正文；在既有大纲之后规划 3–5 章，采用后才写入大纲树。"
      onClose={close}
      footer={
        state.kind === 'review' ? (
          <Button variant="primary" size="lg" block onClick={close}>
            完成
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!llm.configured || state.kind === 'running'}
            onClick={() => void generate()}
          >
            {state.kind === 'running' ? '正在规划…' : `规划 ${count} 章大纲`}
          </Button>
        )
      }
    >
      {state.kind === 'review' ? (
        <>
          <p className="rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700">
            已生成提案，确认后写入大纲。
          </p>
          <ContinueDigest chapters={state.result.chapters} />
          <InjectionSummary result={state.result} />
          <ProposalInbox
            novelId={novel.id}
            batchId={state.result.batchId}
            acceptAllLabel="采用这份续写"
            onSettled={close}
          />
        </>
      ) : (
        <>
          <SegmentedControl
            label="续写几章"
            value={String(count)}
            options={COUNT_OPTIONS}
            onChange={(value) => setCount(Number(value))}
          />

          <div className="flex flex-col gap-1.5 rounded-xl bg-paper-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-700">
            <p className="font-medium">本次依据</p>
            <p>
              大纲尾部：
              {tail.length > 0
                ? tail.map((entry) => entry.title).join(' / ')
                : '暂无大纲，将从顶层开始规划'}
            </p>
            <p>故事至此：{rolling ? '已带上全书进展摘要' : '暂无进展摘要'}</p>
            <p>
              最近章节：{recent.length} 章摘要
              {recent.length === 0 ? '（还没有章节摘要）' : ''}
            </p>
            <p>未收束伏笔：{openThreads.length} 条</p>
            <p className="text-ink-500">
              核心设定与名称命中的相关设定会在生成时自动装配（8k 预算），生成后显示实际注入清单。
            </p>
          </div>

          {!llm.configured ? (
            <p className="text-xs text-ink-500">需要先在「设置」里配置模型，才能续写大纲。</p>
          ) : null}

          {state.kind === 'error' ? (
            <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5">
              <p className="text-sm text-seal">{state.message}</p>
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

/**
 * 续写细目：采用前让作者逐章核对四要素（主冲突/章末钩子/收束/新埋伏笔）。
 * 这些字段比合成后的整段梗概更好扫读，避免「先采用再后悔」。
 */
function ContinueDigest({ chapters }: { chapters: readonly FrontierChapterDraft[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-paper-sunken px-3 py-2.5">
      <p className="text-xs font-medium text-ink-700">续写细目</p>
      <ul className="flex flex-col gap-2">
        {chapters.map((chapter, index) => (
          <li key={`${index}-${chapter.title}`} className="text-xs leading-relaxed text-ink-700">
            <p className="text-sm font-medium text-ink-900">{chapter.title}</p>
            <p>主冲突：{chapter.conflict}</p>
            <p>章末钩子：{chapter.hook}</p>
            {chapter.resolvesThreads.length > 0 ? (
              <p>将收束：{chapter.resolvesThreads.join('、')}</p>
            ) : null}
            {chapter.plantsThreads.length > 0 ? (
              <p>将新埋：{chapter.plantsThreads.join('、')}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 生成后的实际注入清单：核心/相关设定、未被预算注入的条目、提示词 token */
function InjectionSummary({ result }: { result: OutlineContinueResult }) {
  const { injection } = result;
  const relatedTokens = injection.related.reduce((sum, block) => sum + block.tokens, 0);
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-paper-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-700">
      <p className="font-medium">本次注入</p>
      <p>
        核心设定 {injection.core.length} 条（始终注入）
        {injection.core.length > 0
          ? `：${injection.core.map((block) => block.entry.title).join('、')}`
          : ''}
      </p>
      <p>
        相关设定 {injection.related.length} 条 · {formatTokens(relatedTokens)}
        {injection.related.length > 0
          ? `：${injection.related.map((block) => block.entry.title).join('、')}`
          : ''}
      </p>
      {injection.dropped.length > 0 ? (
        <p className="text-ink-300">
          未注入：
          {injection.dropped.map((block) => block.entry.title).join('、')}
        </p>
      ) : null}
      <p className="text-ink-500">本次提示词约 {formatTokens(result.promptTokens)}</p>
    </div>
  );
}
