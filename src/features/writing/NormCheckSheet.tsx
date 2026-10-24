import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_INFERRED_ENTRIES } from '@/context/ContextBuilder';
import { estimateTokens, formatTokens } from '@/context/tokens';
import { mentionedEntries } from '@/domain/entrySearch';
import { countWords } from '@/domain/primitives';
import type {
  Category,
  Chapter,
  ChapterSummary,
  KnowledgeEntry,
  Novel,
  WritingNorm,
} from '@/domain/schema';
import { normsInScope } from '@/domain/writingNorm';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { NormInjectionPicker } from './NormInjectionPicker';
import {
  NORM_CHECK_SEVERITY_LABELS,
  NormCheckResultSchema,
  buildNormCheckSystemPrompt,
  buildNormCheckUserPrompt,
  displayNormTitle,
  locateQuote,
  previousForCheck,
  resolveCheckIssues,
  splitChapterForCheck,
  type NormCheckIssue,
  type ResolvedCheckIssue,
} from './normCheck';

export interface NormCheckSession {
  /** 检查时的正文：按钮显示与排序都以它为准，不随之后的打字闪烁 */
  checkedContent: string;
  issues: ResolvedCheckIssue[];
}

interface NormCheckSheetProps {
  open: boolean;
  /** chapterLabel(chapter, sideStories)，进 user prompt 的【待检查的正文（…）】 */
  label: string;
  /** 编辑器当前正文（不是已落盘版本） */
  content: string;
  context: {
    novel: Novel;
    categories: Category[];
    entries: KnowledgeEntry[];
    chapters: Chapter[];
    summaries: ChapterSummary[];
    writingNorms: WritingNorm[];
  };
  chapterId: string;
  result: NormCheckSession | null;
  ignoredKeys: string[];
  onResult: (result: NormCheckSession) => void;
  onIgnore: (key: string) => void;
  onLocate: (issue: ResolvedCheckIssue) => void;
  onRevise: (issue: ResolvedCheckIssue) => void;
  onClose: () => void;
}

type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; index: number; total: number }
  | { kind: 'error'; message: string; truncated: boolean };

const SEVERITY_STYLES: Record<NormCheckIssue['severity'], string> = {
  violation: 'bg-seal-soft text-seal',
  possible: 'bg-accent-soft text-accent',
  judgement: 'bg-paper-sunken text-ink-700',
};

/**
 * 按写作规范检查本章。
 *
 * 只提示、不改正文：这个面板不接收任何写正文的回调，对外只有 onResult / onIgnore /
 * onLocate / onRevise / onClose。「定位」只改选区，「按建议改写」只打开段落加工面板，
 * 写入正文仍要作者在段落加工里点「替换原文」。
 *
 * 长章分段依次检查，任一段失败整次失败、不展示部分结果：部分结果看上去就像
 * 「其余段落没问题」，正是需求禁止的静默不完整。
 */
export function NormCheckSheet({
  open,
  label,
  content,
  context,
  chapterId,
  result,
  ignoredKeys,
  onResult,
  onIgnore,
  onLocate,
  onRevise,
  onClose,
}: NormCheckSheetProps) {
  const llm = useLlm();
  const { novel, categories, entries, chapters, summaries, writingNorms } = context;

  /** 本次临时不参与检查的规范；只影响这一次，不写库 */
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  /**
   * 结果视图点了「重新检查」：回到表单而不是直接发请求。
   * 改过正文后分段数 K 可能变了，多次调用必须先让作者看到「分 K 段 / 输入约 X tokens」，
   * 也只有表单里能临时取消某份规范（FR19、设计 1.7.4 / 1.7.6）
   */
  const [formRequested, setFormRequested] = useState(false);
  /** 点「定位」时在当前正文里已找不到原句的卡片 */
  const [lostKeys, setLostKeys] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // 只在打开的瞬间重置（与 ReviseSheet 同样的写法），避免后台数据刷新冲掉进行中的状态
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setExcludedIds([]);
      setRun({ kind: 'idle' });
      setLostKeys([]);
      // 回到表单后没开始就关掉：再打开仍先看到上一次结果，与之前一致
      setFormRequested(false);
    }
    if (!open && wasOpen.current) {
      // 关闭即丢弃进行中的检查，保留上一次结果
      abortRef.current?.abort();
      abortRef.current = null;
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  /** picker 列出作用范围含「检查」的全部规范（含本次取消的） */
  const checkNorms = useMemo(() => normsInScope(writingNorms, 'check'), [writingNorms]);
  /** 本次注入：同时用于提示词与规范名匹配 —— 没给模型看的规范，名字对上也不算命中 */
  const injected = useMemo(
    () => normsInScope(writingNorms, 'check', new Set(excludedIds)),
    [writingNorms, excludedIds],
  );

  // 面板常驻挂载在编辑器里：关着时不算，免得每敲一个字都重新分段、拼提示词
  const plan = useMemo(() => {
    if (!open) return { system: '', users: [] as string[], tokens: 0 };
    const pinned = entries.filter((entry) => entry.pinned);
    // 对整章算一次、各段共用：每段 user prompt 的前半部分一致，也避免某段没提到人物反而缺了设定
    const related = mentionedEntries(
      content,
      entries.filter((entry) => !entry.pinned),
    ).slice(0, MAX_INFERRED_ENTRIES);
    const previous = previousForCheck(chapters, summaries, chapterId);
    const segments = splitChapterForCheck(content);
    const system = buildNormCheckSystemPrompt(novel, injected, pinned, categories);
    const users = segments.map((text, index) =>
      buildNormCheckUserPrompt({
        chapterLabel: label,
        segment: { index, total: segments.length, text },
        mentionedEntries: related,
        categories,
        ...(previous ? { previous } : {}),
      }),
    );
    // 口径（遗留 #5）：每段都带一份系统提示；不含 generateStructured 追加的 schema 块
    const tokens =
      segments.length * estimateTokens(system) +
      users.reduce((sum, user) => sum + estimateTokens(user), 0);
    return { system, users, tokens };
  }, [open, content, entries, chapters, summaries, chapterId, novel, injected, categories, label]);

  function toggleNorm(normId: string) {
    setExcludedIds((current) =>
      current.includes(normId) ? current.filter((id) => id !== normId) : [...current, normId],
    );
  }

  async function start() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // 记下这一刻的正文与提示词：检查进行中作者仍可能在背后的编辑器里打字
    const checkedContent = content;
    const { system, users } = plan;
    const norms = injected;
    const total = users.length;
    const collected: { segmentIndex: number; issues: NormCheckIssue[] }[] = [];

    // 依次调用而不是并发：避免撞限流，后几段还能命中同一份系统提示的缓存
    for (let index = 0; index < total; index += 1) {
      setRun({ kind: 'running', index: index + 1, total });
      try {
        const { data } = await llm.runStructured('norm-check', {
          schema: NormCheckResultSchema,
          schemaName: 'NormCheckResult',
          system,
          user: users[index]!,
          signal: controller.signal,
          failOnTruncation: true,
        });
        collected.push({ segmentIndex: index, issues: data.issues });
      } catch (cause) {
        // 已被停止、关闭或重新开始：这次的结果不再属于任何人
        if (abortRef.current !== controller) return;
        abortRef.current = null;
        if (cause instanceof LlmError && cause.kind === 'aborted') {
          setRun({ kind: 'idle' });
          return;
        }
        const message =
          cause instanceof LlmError || cause instanceof Error ? cause.message : '检查失败';
        setRun({
          kind: 'error',
          message: `第 ${index + 1}/${total} 段检查失败：${message}`,
          truncated: cause instanceof LlmError && cause.kind === 'truncated',
        });
        return;
      }
      if (abortRef.current !== controller) return;
    }

    abortRef.current = null;
    setRun({ kind: 'idle' });
    setLostKeys([]);
    setFormRequested(false);
    onResult({ checkedContent, issues: resolveCheckIssues(collected, norms, checkedContent) });
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    // 停止 = 丢弃本次，回到表单（有上一次结果则仍显示它）
    setRun({ kind: 'idle' });
    setFormRequested(false);
  }

  /**
   * 用当前正文重新定位：按钮按检查时的正文显示，但作者之后可能改掉了那句。
   * 找不到时只在卡片里提示，不关面板、不改选区、不打开改写
   */
  function relocate(issue: ResolvedCheckIssue, then: (issue: ResolvedCheckIssue) => void) {
    if (locateQuote(content, issue.quote) === null) {
      setLostKeys((current) => (current.includes(issue.key) ? current : [...current, issue.key]));
      return;
    }
    setLostKeys((current) => current.filter((key) => key !== issue.key));
    then(issue);
  }

  const segmentCount = plan.users.length;
  const summaryLine =
    segmentCount > 1
      ? `本章约 ${countWords(content)} 字，将分 ${segmentCount} 段检查（${segmentCount} 次调用），输入${formatTokens(plan.tokens)}`
      : `本章约 ${countWords(content)} 字，输入${formatTokens(plan.tokens)}`;

  const showResult = run.kind === 'idle' && result !== null && !formRequested;
  const visible = result ? result.issues.filter((item) => !ignoredKeys.includes(item.key)) : [];
  const stale = result !== null && result.checkedContent !== content;

  return (
    <Sheet
      open={open}
      title="按规范检查"
      description="只列出可能违反规范之处，不会改动正文"
      onClose={onClose}
    >
      {run.kind === 'running' ? (
        <>
          <p aria-live="polite" className="text-sm text-ink-700">
            正在检查第 {run.index}/{run.total} 段…
          </p>
          <Button variant="secondary" size="lg" block onClick={stop}>
            停止
          </Button>
        </>
      ) : showResult ? (
        <>
          {stale ? (
            <p className="rounded-xl bg-accent-soft px-3 py-2.5 text-sm text-accent">
              正文在检查后改过，结果可能已过期
            </p>
          ) : null}

          {result.issues.length === 0 ? (
            <p className="rounded-xl bg-paper-sunken px-3 py-2.5 text-sm text-ink-700">
              没有发现明显违反规范之处。这是模型的判断，仅供参考。
            </p>
          ) : visible.length === 0 ? (
            <p className="rounded-xl bg-paper-sunken px-3 py-2.5 text-sm text-ink-700">
              这次的条目都已忽略。
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {visible.map((item) => (
                <IssueCard
                  key={item.key}
                  issue={item}
                  // 按检查时的正文判断，不随打字闪烁
                  locatable={locateQuote(result.checkedContent, item.quote) !== null}
                  lost={lostKeys.includes(item.key)}
                  onLocate={() => relocate(item, onLocate)}
                  onRevise={() => relocate(item, onRevise)}
                  onIgnore={() => onIgnore(item.key)}
                />
              ))}
            </ul>
          )}

          {/* 只切回表单，不发请求：由作者在表单里看过调用次数后点「开始检查」 */}
          <Button
            variant="secondary"
            size="lg"
            block
            onClick={() => setFormRequested(true)}
            disabled={!llm.configured}
          >
            重新检查
          </Button>
        </>
      ) : (
        <>
          <NormInjectionPicker
            norms={checkNorms}
            excludedIds={excludedIds}
            onToggle={toggleNorm}
            legend="参与检查的规范"
          />

          <p className="text-xs leading-relaxed text-ink-500">{summaryLine}</p>

          <Button
            variant="primary"
            size="lg"
            block
            disabled={injected.length === 0 || !llm.configured}
            onClick={start}
          >
            {run.kind === 'error' ? '重新检查' : '开始检查'}
          </Button>

          {injected.length === 0 ? <p className="text-xs text-ink-500">至少保留一份规范</p> : null}

          {/* 从结果页进来却不想重跑：回到上一次结果，不发请求、不清结果 */}
          {result !== null && formRequested ? (
            <Button variant="ghost" size="md" block onClick={() => setFormRequested(false)}>
              返回结果
            </Button>
          ) : null}

          {run.kind === 'error' ? (
            <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
              <p>{run.message}</p>
              {run.truncated ? (
                <p className="mt-1 text-xs">
                  可以减少作用范围含「检查」的规范，或先用 AI 精简压短规范。
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

function IssueCard({
  issue,
  locatable,
  lost,
  onLocate,
  onRevise,
  onIgnore,
}: {
  issue: ResolvedCheckIssue;
  locatable: boolean;
  lost: boolean;
  onLocate: () => void;
  onRevise: () => void;
  onIgnore: () => void;
}) {
  const hasQuote = issue.quote.trim() !== '';
  const canRevise = locatable && issue.suggestion.trim() !== '';

  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-ink-100 bg-paper px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={['rounded-full px-2 py-0.5 font-medium', SEVERITY_STYLES[issue.severity]].join(
            ' ',
          )}
        >
          {NORM_CHECK_SEVERITY_LABELS[issue.severity]}
        </span>
        <span className="font-medium text-ink-900">《{displayNormTitle(issue.normTitle)}》</span>
        {/* 名字对不上也保留条目：丢掉可能藏住真实问题，标出来让作者自己判断 */}
        {issue.normId === null ? <span className="text-ink-500">规范名未对应</span> : null}
      </div>

      <blockquote className="border-l-2 border-ink-100 pl-2 text-xs leading-relaxed text-ink-500">
        {issue.rule}
      </blockquote>

      {hasQuote ? (
        <div className="rounded-xl bg-paper-sunken px-3 py-2 font-reading text-sm leading-relaxed text-ink-700">
          <p className="whitespace-pre-wrap">{issue.quote}</p>
          {!locatable ? (
            <p className="mt-1 font-sans text-xs text-ink-500">正文里没找到这段原文</p>
          ) : null}
        </div>
      ) : null}

      <p className="text-sm leading-relaxed text-ink-900">{issue.problem}</p>
      {issue.suggestion.trim() ? (
        <p className="text-sm leading-relaxed text-ink-700">建议：{issue.suggestion}</p>
      ) : null}

      {lost ? (
        <p role="status" className="text-xs text-seal">
          这段原文已被修改，找不到了
        </p>
      ) : null}

      {/* md（44px）而不是 sm（36px）：窄屏上「定位」「按建议改写」是卡片的主要动作，触控目标须满足 NFR7 */}
      <div className="flex flex-wrap gap-2">
        {locatable ? (
          <Button variant="secondary" size="md" onClick={onLocate}>
            定位
          </Button>
        ) : null}
        {canRevise ? (
          <Button variant="secondary" size="md" onClick={onRevise}>
            按建议改写
          </Button>
        ) : null}
        <Button variant="ghost" size="md" onClick={onIgnore}>
          忽略
        </Button>
      </div>
    </li>
  );
}
