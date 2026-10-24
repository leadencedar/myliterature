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
import { useLlm } from '@/llm/useLlm';
import { Button } from '@/ui/Button';
import { SegmentedControl, Toggle } from '@/ui/Controls';
import { TextAreaField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
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
  | { kind: 'done'; text: string }
  | { kind: 'error'; message: string; detail?: string };

interface GenerateChapterSheetProps {
  open: boolean;
  /** 构建上下文所需的全部数据 */
  context: Omit<ContextRequest, 'selectedEntryIds' | 'recentSummaryCount' | 'excludedNormIds'>;
  /** 章节已有正文，用于决定「替换」还是「追加」 */
  existingContent: string;
  onClose: () => void;
  /** 用户确认采用时回调，由调用方写入章节 */
  onAccept: (text: string, mode: 'replace' | 'append') => void | Promise<void>;
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
  const abortRef = useRef<AbortController | null>(null);

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
    setPhase({ kind: 'streaming', text: '' });

    const built = builder.build({
      ...context,
      recentSummaryCount: Number(summaryCount),
      selectedEntryIds: effectiveSelection,
      includeMainProgress,
      excludedNormIds,
    });
    const targetNode = context.outline.find((node) => node.id === context.targetNodeId);

    let streamed = '';
    try {
      const result = await llm.runStream(
        'chapter-draft',
        {
          system: buildChapterSystemPrompt(built.stablePrefix),
          user: buildChapterUserPrompt({
            volatileSuffix: built.volatileSuffix,
            targetWords: targetNode?.targetWords ?? null,
            ...(instruction ? { instruction } : {}),
          }),
          signal: controller.signal,
        },
        {
          onText: (delta) => {
            streamed += delta;
            setPhase({ kind: 'streaming', text: streamed });
          },
        },
      );
      setPhase({ kind: 'done', text: result.content || streamed });
    } catch (cause) {
      if (cause instanceof LlmError && cause.kind === 'aborted') {
        // 已经流出来的内容留着，用户可能仍想用
        setPhase(streamed ? { kind: 'done', text: streamed } : { kind: 'form' });
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

  async function accept(mode: 'replace' | 'append') {
    if (phase.kind !== 'done') return;
    await onAccept(phase.text, mode);
    setPhase({ kind: 'form' });
    onClose();
  }

  const generatedText = phase.kind === 'streaming' || phase.kind === 'done' ? phase.text : '';

  return (
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
            {droppedItems.length > 0 ? (
              <p className="text-xs text-seal">
                {droppedItems.length} 项因超出预算未注入：
                {droppedItems.map((item) => item.label).join('、')}
              </p>
            ) : null}
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
              {phase.kind === 'streaming' ? '正在写…' : '生成完成'}
            </p>
            <p className="text-xs text-ink-500">{countWords(generatedText)} 字</p>
          </div>

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
              onChange={(event) => setPhase({ kind: 'done', text: event.target.value })}
            />
          )}

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
  );
}
