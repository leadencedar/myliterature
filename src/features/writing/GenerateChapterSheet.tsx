import { useEffect, useMemo, useRef, useState } from 'react';
import { SummaryChainContextBuilder } from '@/context/SummaryChainContextBuilder';
import {
  DEFAULT_RECENT_SUMMARY_COUNT,
  type BuiltContext,
  type ContextRequest,
} from '@/context/ContextBuilder';
import { formatTokens } from '@/context/tokens';
import { countWords } from '@/domain/primitives';
import { normsInScope } from '@/domain/writingNorm';
import { LlmError } from '@/llm/errors';
import type { ChatResult } from '@/llm/types';
import { useLlm } from '@/llm/useLlm';
import { Button } from '@/ui/Button';
import { SegmentedControl, Toggle } from '@/ui/Controls';
import { TextAreaField } from '@/ui/Field';
import { ConfirmDialog, Sheet } from '@/ui/Sheet';
import { chapterMaxOutputTokens, resolveChapterTargetWords, sceneRangeHint } from './chapterLength';
import { buildChapterSystemPrompt, buildChapterUserPrompt } from './chapterDraft';
import { NormInjectionPicker } from './NormInjectionPicker';

const builder = new SummaryChainContextBuilder();

const SUMMARY_COUNT_OPTIONS = ['0', '2', '3', '5'].map((value) => ({
  value,
  label: value === '0' ? '不带' : `${value} 章`,
}));

type Phase =
  | { kind: 'form' }
  | { kind: 'streaming'; text: string }
  /** incomplete：生成没有完整结束（撞上限被截断 / 用户中止），采用前要二次确认 */
  | { kind: 'done'; text: string; incomplete?: 'truncated' | 'aborted' }
  | { kind: 'error'; message: string; detail?: string };

/** 服务端明确拒绝 max_tokens 参数时才允许去掉它重试，别把别的 400 也吞成静默重试 */
function isMaxTokensRejected(cause: unknown): boolean {
  return (
    cause instanceof LlmError &&
    cause.kind === 'bad-request' &&
    (cause.detail ?? '').includes('max_tokens')
  );
}

/** 低于目标 85% 视为「没写够」：与 D4 的差额口径一致，但只提示、不制造写满的压力 */
const SHORTFALL_RATIO = 0.85;
/**
 * 高于目标 115% 视为「明显超出」：只让作者看见，不自动压缩、不硬卡字数（M3.2）。
 * 100%–115% 属于正常篇幅波动，不提示。
 */
const OVERSHOOT_RATIO = 1.15;

/**
 * 续写指令。
 * 只补尚未落地的场景、不重复、不总结 —— 补写是补场景，不是把字数凑满（D4）。
 */
function continueInstruction(remaining: number): string {
  return `接着上面的内容继续写，只补本章尚未落地的场景；还差约 ${remaining} 字。不要重复已经写过的内容，不要总结。`;
}

/** 续写结果追加到当前文本：空行分隔，避免两段正文粘成一句 */
function appendGenerated(base: string, addition: string): string {
  const head = base.trimEnd();
  const tail = addition.trim();
  if (!tail) return head;
  return head ? `${head}\n\n${tail}` : tail;
}

interface GenerateChapterSheetProps {
  open: boolean;
  /** 构建上下文所需的全部数据 */
  context: Omit<ContextRequest, 'selectedEntryIds' | 'recentSummaryCount' | 'excludedNormIds'>;
  /** 章节已有正文，用于决定「替换」还是「追加」 */
  existingContent: string;
  onClose: () => void;
  /**
   * 用户确认采用时回调，由调用方写入章节。
   * 第三个参数只在「不完整稿」采用时出现：调用方据此在编辑器里留痕，
   * 避免截断/中断的半章被当成定稿（文学顾问评审 P0）。完整采用时保持两参调用，
   * 既有调用方不用关心。
   */
  onAccept: (
    text: string,
    mode: 'replace' | 'append',
    meta?: { incomplete?: 'truncated' | 'aborted' },
  ) => void | Promise<void>;
}

/**
 * 整章生成。
 *
 * 流程刻意分成「先看依据 → 再生成 → 再确认」三步：
 * 生成前把注入清单和预估 token 摆出来，用户能判断这一次的依据够不够、
 * 花销值不值；生成后正文进入可编辑的预览区，必须显式采用才会写入章节。
 *
 * 正文不走 Proposal 管道而用轻量确认，原因是散文没有字段结构 ——
 * 对三千字的整章做字段级 diff 不提供任何额外信息，预览本身就是最好的确认。
 * 结构化数据（设定、大纲、摘要）仍然一律走确认管道。
 */
export function GenerateChapterSheet({
  open,
  context,
  existingContent,
  onClose,
  onAccept,
}: GenerateChapterSheetProps) {
  const llm = useLlm();

  const [summaryCount, setSummaryCount] = useState(String(DEFAULT_RECENT_SUMMARY_COUNT));
  const [instruction, setInstruction] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  /** 外传章节是否附带主线进展；和摘要章数一样是面板的本地状态 */
  const [includeMainProgress, setIncludeMainProgress] = useState(false);
  /** 本次临时不注入的写作规范；只影响这一次生成，不写库 */
  const [excludedNormIds, setExcludedNormIds] = useState<string[]>([]);
  /** 待确认采用的不完整结果：选中要采用的模式，确认后才真正写入章节 */
  const [pendingAccept, setPendingAccept] = useState<'replace' | 'append' | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * 本次生成的 system/user。续写要把「原 user 提示词 + 当前正文」作为 history 发回去，
   * 模型才知道这一章原本要写什么；只存 ref，不需要触发重渲染。
   */
  const lastRunRef = useRef<{ system: string; user: string } | null>(null);

  /** 继续补写时的基准正文：流式回调要按「已有正文 + 新片段」拼出完整预览 */
  const continueBaseRef = useRef('');

  // 面板常驻挂载，其他状态（勾选、摘要章数）跨次保留是现有行为，不动它们；
  // 只有临时取消的规范在每次「关 → 开」时恢复为全部带上 —— 取消的语义就是「只这一次」，
  // 留到下一次会让作者以为规范失效了。只在打开的瞬间重置，避免后台刷新冲掉当前选择
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setExcludedNormIds([]);
    wasOpen.current = open;
  }, [open]);

  /** 先用默认预选构建一次，拿到 defaultEntryIds 与可选条目清单 */
  const preview: BuiltContext = useMemo(
    () =>
      builder.build({
        ...context,
        recentSummaryCount: Number(summaryCount),
        ...(selectedIds ? { selectedEntryIds: selectedIds } : {}),
        includeMainProgress,
        excludedNormIds,
      }),
    [context, summaryCount, selectedIds, includeMainProgress, excludedNormIds],
  );

  /** 只有外传章节、且主线确实有进展可参考时才给这个开关 */
  const targetChapter = context.chapters.find((chapter) => chapter.id === context.targetChapterId);
  const showMainProgressToggle =
    (targetChapter?.sideStoryId ?? null) !== null && context.novel.rollingSummary.trim() !== '';

  /**
   * 目标字数（D4）：大纲节点有值就以它为准，为空/非法回退 3000。
   * 来源要显式告诉作者 —— 否则「为什么这次只写了 3000 字」会变成一个要猜的谜。
   */
  const targetNode = useMemo(
    () => context.outline.find((node) => node.id === context.targetNodeId),
    [context.outline, context.targetNodeId],
  );
  const targetWords = resolveChapterTargetWords(targetNode?.targetWords ?? null);
  const targetWordsSource = targetNode?.targetWords != null ? '大纲节点' : '默认 3000';

  const effectiveSelection = selectedIds ?? preview.defaultEntryIds;

  /** 可勾选的条目：排除核心设定（它们始终注入） */
  const selectableEntries = useMemo(
    () => context.entries.filter((entry) => !entry.pinned),
    [context.entries],
  );

  /** picker 列出「写正文」作用范围内的全部规范（含本次取消的），取消状态由它自己展示 */
  const writingNorms = useMemo(
    () => normsInScope(context.writingNorms ?? [], 'writing'),
    [context.writingNorms],
  );

  const pinnedItems = preview.items.filter((item) => item.kind === 'pinned');
  const droppedItems = preview.items.filter((item) => !item.included);

  function toggleEntry(entryId: string) {
    const next = effectiveSelection.includes(entryId)
      ? effectiveSelection.filter((id) => id !== entryId)
      : [...effectiveSelection, entryId];
    setSelectedIds(next);
  }

  function toggleNorm(normId: string) {
    setExcludedNormIds((current) =>
      current.includes(normId) ? current.filter((id) => id !== normId) : [...current, normId],
    );
  }

  async function generate() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const built = builder.build({
      ...context,
      recentSummaryCount: Number(summaryCount),
      selectedEntryIds: effectiveSelection,
      includeMainProgress,
      excludedNormIds,
    });
    const system = buildChapterSystemPrompt(built.stablePrefix);
    const user = buildChapterUserPrompt({
      volatileSuffix: built.volatileSuffix,
      targetWords: targetNode?.targetWords ?? null,
      ...(instruction ? { instruction } : {}),
    });
    lastRunRef.current = { system, user };

    let streamed = '';
    /** 每次尝试都从零累计流式文本：400 重试时不能把上一轮的片段算两遍 */
    const startStream = (withMaxTokens: boolean) => {
      streamed = '';
      setPhase({ kind: 'streaming', text: '' });
      return llm.runStream(
        'chapter-draft',
        {
          system,
          user,
          ...(withMaxTokens ? { maxTokens: chapterMaxOutputTokens(targetWords) } : {}),
          signal: controller.signal,
        },
        {
          onText: (delta) => {
            streamed += delta;
            setPhase({ kind: 'streaming', text: streamed });
          },
        },
      );
    };

    try {
      let result: ChatResult;
      try {
        result = await startStream(true);
      } catch (cause) {
        // 部分服务商/自建端点不接受 max_tokens（400 且报错里点名它）：去掉该参数重试一次。
        // 其余错误照常展示，不静默重试 —— 会被重试掩盖的失败更难排查
        if (!isMaxTokensRejected(cause)) throw cause;
        result = await startStream(false);
      }
      // finishReason 为 null 表示服务商没回传：视为未知，不判截断、不报错
      const incomplete = result.finishReason === 'length' ? 'truncated' : undefined;
      setPhase({
        kind: 'done',
        text: result.content || streamed,
        ...(incomplete ? { incomplete } : {}),
      });
    } catch (cause) {
      if (cause instanceof LlmError && cause.kind === 'aborted') {
        // 已经流出来的内容留着，用户可能仍想用；但必须标记「未完成」而不是当作生成成功
        setPhase(
          streamed ? { kind: 'done', text: streamed, incomplete: 'aborted' } : { kind: 'form' },
        );
        return;
      }
      const error = cause instanceof LlmError ? cause : undefined;
      setPhase({
        kind: 'error',
        message: error?.message ?? (cause instanceof Error ? cause.message : '生成失败'),
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  }

  /**
   * 手动「继续补写」：只补未落地场景，不自动触发、不循环到目标。
   *
   * 请求带 history = [原始 user 提示词, 当前正文]，再给一条续写指令与按剩余字数
   * 推导的 maxTokens；流式结果**追加**到当前正文后重新评估差额。
   * 截断/中止的续写同样标记 incomplete，保持「未完成」语义不丢。
   */
  async function continueWriting() {
    if (phase.kind !== 'done') return;
    const run = lastRunRef.current;
    if (!run) return;
    const base = phase.text;
    const remaining = Math.max(0, targetWords - countWords(base));
    const previousIncomplete = phase.incomplete;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    continueBaseRef.current = base;

    let streamed = '';
    setPhase({ kind: 'streaming', text: base });

    try {
      const result = await llm.runStream(
        'chapter-draft',
        {
          system: run.system,
          history: [
            { role: 'user', content: run.user },
            { role: 'assistant', content: base },
          ],
          user: continueInstruction(remaining),
          // 剩余字数不多时也要留出正常单次输出的余量；夹取规则与首次生成一致
          maxTokens: chapterMaxOutputTokens(remaining > 0 ? remaining : targetWords),
          signal: controller.signal,
        },
        {
          onText: (delta) => {
            streamed += delta;
            setPhase({
              kind: 'streaming',
              text: appendGenerated(continueBaseRef.current, streamed),
            });
          },
        },
      );
      const next = appendGenerated(base, result.content || streamed);
      // 续写被截断仍算未完成：作者要能继续补，而不是被当成完整的一章
      const incomplete = result.finishReason === 'length' ? 'truncated' : undefined;
      setPhase({ kind: 'done', text: next, ...(incomplete ? { incomplete } : {}) });
    } catch (cause) {
      if (cause instanceof LlmError && cause.kind === 'aborted') {
        // 中止时保留已经补出来的部分；一个字都没补出来就退回原来的结果，别让作者丢正文
        setPhase(
          streamed
            ? { kind: 'done', text: appendGenerated(base, streamed), incomplete: 'aborted' }
            : {
                kind: 'done',
                text: base,
                ...(previousIncomplete ? { incomplete: previousIncomplete } : {}),
              },
        );
        return;
      }
      const error = cause instanceof LlmError ? cause : undefined;
      setPhase({
        kind: 'error',
        message: error?.message ?? (cause instanceof Error ? cause.message : '补写失败'),
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  }

  /** 真正写入章节；直接采用与「仍要采用不完整内容」两条路径复用 */
  async function commitAccept(mode: 'replace' | 'append') {
    if (phase.kind !== 'done') return;
    // 不完整的事实要跟着这次采用一起交给调用方，否则半章落地后没有任何痕迹
    if (phase.incomplete) await onAccept(phase.text, mode, { incomplete: phase.incomplete });
    else await onAccept(phase.text, mode);
    setPendingAccept(null);
    setPhase({ kind: 'form' });
    onClose();
  }

  async function accept(mode: 'replace' | 'append') {
    if (phase.kind !== 'done') return;
    // 截断与中断都意味着内容不完整：直接采用会把半章当定稿，破坏「完成」的语义
    if (phase.incomplete) {
      setPendingAccept(mode);
      return;
    }
    await commitAccept(mode);
  }

  /** 本次注入里是否带了文风锚点：有的话清单下要说明「只对齐语感」 */
  const hasStyleAnchor = preview.items.some((item) => item.included && item.kind === 'styleAnchor');
  const generatedText = phase.kind === 'streaming' || phase.kind === 'done' ? phase.text : '';
  const generatedWords = countWords(generatedText);
  /** 写完才算「够」：低于目标 85% 或截断/中断都要提示可以补写 */
  const showShortfall =
    phase.kind === 'done' &&
    (phase.incomplete !== undefined || generatedWords < targetWords * SHORTFALL_RATIO);
  const remainingWords = Math.max(0, targetWords - generatedWords);
  // 红框里已经写了「继续补写/重新生成」两条路，这里只留差额事实，避免同屏重复
  const shortfallMessage =
    remainingWords > 0 ? `比目标少约 ${remainingWords} 字。` : '生成未完成。';
  /** 完整结果明显超出目标：只做可见提示，不触发任何自动处理 */
  const showOvershoot =
    phase.kind === 'done' &&
    phase.incomplete === undefined &&
    generatedWords > targetWords * OVERSHOOT_RATIO;
  const overshootWords = Math.max(0, generatedWords - targetWords);

  return (
    <>
      <Sheet
        open={open}
        title="生成本章正文"
        description="先看清这次依据了哪些内容，再决定是否生成。"
        onClose={onClose}
      >
        {phase.kind === 'form' || phase.kind === 'error' ? (
          <>
            <div className="flex flex-col gap-2 rounded-xl bg-paper-sunken p-3">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-medium text-ink-700">本次注入</p>
                <p className="text-xs text-ink-500">
                  {preview.items.filter((item) => item.included).length} 项 ·{' '}
                  {formatTokens(preview.estimatedTokens)}
                </p>
              </div>
              <ul className="flex flex-col gap-1">
                {preview.items
                  .filter((item) => item.included)
                  .map((item) => (
                    <li
                      key={`${item.kind}-${item.id}`}
                      className="flex items-baseline justify-between gap-2 text-xs"
                    >
                      <span className="min-w-0 truncate text-ink-700">{item.label}</span>
                      <span className="shrink-0 text-ink-300">{item.tokens}</span>
                    </li>
                  ))}
              </ul>
              {hasStyleAnchor ? (
                <p className="text-xs leading-relaxed text-ink-300">
                  文风锚点只用于对齐语感，不会复述其中情节。
                </p>
              ) : null}
              {droppedItems.length > 0 ? (
                <p className="text-xs text-seal">
                  {droppedItems.length} 项因超出预算未注入：
                  {droppedItems.map((item) => item.label).join('、')}
                </p>
              ) : null}
            </div>

            {/* D4：目标字数与来源必须可见，否则「这一章为什么是这个长度」只能靠猜 */}
            <div className="flex flex-col gap-1 rounded-xl bg-paper-sunken p-3">
              <p className="text-sm font-medium text-ink-700">
                目标字数：{targetWords} 字（来源：{targetWordsSource}）
              </p>
              <p className="text-xs leading-relaxed text-ink-500">
                场景数参考：约 {sceneRangeHint(targetWords)}；要修改请到「写作 → 大纲节点」里改。
              </p>
            </div>

            <NormInjectionPicker
              norms={writingNorms}
              excludedIds={excludedNormIds}
              onToggle={toggleNorm}
            />

            {pinnedItems.length > 0 ? (
              <p className="text-xs leading-relaxed text-ink-500">
                核心设定（{pinnedItems.length}{' '}
                条）始终注入，不能取消。要调整请到知识库改「核心设定」标记。
              </p>
            ) : null}

            {selectableEntries.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-ink-700">
                  参与写作的设定（已选 {effectiveSelection.length} 项）
                </p>
                <p className="text-xs leading-relaxed text-ink-500">
                  {selectedIds === null
                    ? '已按大纲梗概与上一章摘要自动勾上相关条目，点标签可以增减。'
                    : '已手动调整过。'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {selectableEntries.map((entry) => {
                    const active = effectiveSelection.includes(entry.id);
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleEntry(entry.id)}
                        className={[
                          'rounded-full border px-3 py-1.5 text-xs transition-colors',
                          active
                            ? 'border-ink-900 bg-ink-900 text-paper'
                            : 'border-ink-100 bg-paper-raised text-ink-700',
                        ].join(' ')}
                      >
                        {entry.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <SegmentedControl
              label="带上前几章摘要"
              value={summaryCount}
              options={SUMMARY_COUNT_OPTIONS}
              onChange={setSummaryCount}
            />

            {showMainProgressToggle ? (
              <Toggle
                label="参考主线进展"
                description="外传发生在主线之后、需要知道主线走到哪时再打开。前传打开它，人物容易提前知道后来的事。"
                checked={includeMainProgress}
                onChange={setIncludeMainProgress}
              />
            ) : null}

            <TextAreaField
              label="本章额外要求（可选）"
              rows={2}
              value={instruction}
              placeholder="例如：多写对话；结尾停在敲门声上。"
              onChange={(event) => setInstruction(event.target.value)}
            />

            <Button variant="primary" size="lg" block disabled={!llm.configured} onClick={generate}>
              开始生成
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

        {phase.kind === 'streaming' || phase.kind === 'done' ? (
          <>
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium text-ink-700">
                {phase.kind === 'streaming'
                  ? '正在写…'
                  : phase.incomplete
                    ? '生成未完成'
                    : showOvershoot
                      ? '生成完成（超出目标）'
                      : remainingWords > 0
                        ? '生成完成（接近目标）'
                        : '生成完成'}
              </p>
              {/* 结果旁边直接给出「已生成 / 目标」对照：截断时作者才知道差了多少 */}
              <p className="text-xs text-ink-500">
                {countWords(generatedText)} 字 / 目标 {targetWords} 字
              </p>
            </div>

            {/* 截断/中断必须在结果区顶部就说清楚：内容看得见，但它不是完整的一章 */}
            {phase.kind === 'done' && phase.incomplete ? (
              <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5">
                <p className="text-sm text-seal">
                  {phase.incomplete === 'truncated'
                    ? '生成被截断，内容不完整。可以继续补写未落地场景，或重新生成；采用只会保存已生成的部分。'
                    : '生成已中断，内容不完整。可以继续补写未落地场景，或重新生成。'}
                </p>
              </div>
            ) : null}

            {phase.kind === 'streaming' ? (
              <p
                aria-live="polite"
                className="max-h-[40dvh] overflow-y-auto rounded-xl bg-paper-sunken px-3 py-2.5 font-reading text-sm leading-relaxed whitespace-pre-wrap text-ink-900"
              >
                {generatedText || '…'}
              </p>
            ) : (
              <TextAreaField
                label="生成结果（可直接修改）"
                rows={14}
                value={generatedText}
                onChange={(event) =>
                  // 改字不改变「不完整」的事实：截断的草稿改两笔仍缺后半章，采用前照旧要确认
                  setPhase((current) =>
                    current.kind === 'done' ? { ...current, text: event.target.value } : current,
                  )
                }
              />
            )}

            {/* 差额/截断提示：只提示与手动补写，不自动续写、不循环到目标 */}
            {phase.kind === 'done' && showShortfall ? (
              <div className="flex flex-col gap-2 rounded-xl bg-paper-sunken px-3 py-2.5">
                <p className="text-sm font-medium text-ink-700">还有场景没落地？</p>
                <p className="text-xs leading-relaxed text-ink-500">{shortfallMessage}</p>
                <Button
                  variant="secondary"
                  size="lg"
                  block
                  disabled={!llm.configured}
                  onClick={() => void continueWriting()}
                >
                  继续补写
                </Button>
                <p className="text-xs leading-relaxed text-ink-500">
                  节拍已齐可直接标完成。补写只补本章还没落地的场景，不是凑字数；不会自动继续。
                </p>
              </div>
            ) : null}

            {/* 超出目标：只提醒可见，不自动压缩、也不硬卡字数（M3.2） */}
            {phase.kind === 'done' && showOvershoot ? (
              <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
                <p className="text-sm font-medium text-ink-700">本章明显超出目标</p>
                <p className="text-xs leading-relaxed text-ink-500">
                  比目标多约 {overshootWords}{' '}
                  字；采用后可手动删减，或把更紧凑的要求写进「本章额外要求」再生成。不自动压缩，也不硬卡字数。
                </p>
              </div>
            ) : null}

            {phase.kind === 'streaming' ? (
              <Button variant="secondary" size="lg" block onClick={() => abortRef.current?.abort()}>
                停止生成
              </Button>
            ) : (
              <div className="flex flex-col gap-2">
                <Button variant="primary" size="lg" block onClick={() => accept('replace')}>
                  {existingContent.trim() ? '替换正文' : '采用为正文'}
                </Button>
                {existingContent.trim() ? (
                  <Button variant="secondary" size="lg" block onClick={() => accept('append')}>
                    追加到正文末尾
                  </Button>
                ) : null}
                <Button variant="ghost" size="md" block onClick={() => setPhase({ kind: 'form' })}>
                  放弃，重新设置
                </Button>
              </div>
            )}
          </>
        ) : null}
      </Sheet>

      {/* 两种「不完整」都要二次确认：截断与主动中断都意味着这还不是定稿 */}
      <ConfirmDialog
        open={pendingAccept !== null}
        title="仍要采用不完整内容？"
        message="采用后本章仍是草稿，可能缺少结尾。建议在编辑器里从末尾继续补写，补完再标「已完成」。"
        confirmLabel="仍要采用"
        onConfirm={() => {
          if (pendingAccept) void commitAccept(pendingAccept);
        }}
        onCancel={() => setPendingAccept(null)}
      />
    </>
  );
}
