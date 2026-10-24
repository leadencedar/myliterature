import { useEffect, useMemo, useRef, useState } from 'react';
import { SummaryChainContextBuilder } from '@/context/SummaryChainContextBuilder';
import type { ContextRequest } from '@/context/ContextBuilder';
import { countWords } from '@/domain/primitives';
import { normsInScope } from '@/domain/writingNorm';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { VOICE_LIBRARY } from '@/prompt/voiceLibrary';
import { Button } from '@/ui/Button';
import { SegmentedControl } from '@/ui/Controls';
import { TextAreaField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
import { NormInjectionPicker } from './NormInjectionPicker';
import {
  REVISE_ACTIONS,
  buildReviseSystemPrompt,
  buildReviseUserPrompt,
  findReviseAction,
  selectionAtEnd,
  surroundingContext,
  type ReviseAction,
  type ReviseSelection,
} from './revise';

const builder = new SummaryChainContextBuilder();

type Phase =
  | { kind: 'form' }
  | { kind: 'streaming'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; message: string };

interface ReviseSheetProps {
  open: boolean;
  content: string;
  /** 归一化后的选区；空选区表示未选中 */
  selection: ReviseSelection;
  context: Omit<ContextRequest, 'selectedEntryIds' | 'recentSummaryCount' | 'excludedNormIds'>;
  onClose: () => void;
  /** 用户采用结果时回调，由编辑器负责写回并记入撤销栈 */
  onAccept: (replacement: string, action: ReviseAction) => void | Promise<void>;
  /**
   * 打开时预填的操作与额外要求（「按规范检查」的「按建议改写」用）。
   * 只在「关 → 开」那一刻生效；不传时行为与以前完全一致
   */
  initialAction?: ReviseAction;
  initialInstruction?: string;
}

/**
 * 段落级加工。
 *
 * 三种操作共用一套流程：选中 → 选操作 →（可选临时文风）→ 流式生成 →
 * 对照原文确认 → 替换。结果区可直接编辑，所以「确认」同时也是「修改」的入口。
 *
 * 临时文风是这里独有的能力：想给某一段换个笔法试试，不必去改作品的风格档案，
 * 试完不满意直接放弃即可。
 */
export function ReviseSheet({
  open,
  content,
  selection,
  context,
  onClose,
  onAccept,
  initialAction,
  initialInstruction,
}: ReviseSheetProps) {
  const llm = useLlm();

  const [action, setAction] = useState<ReviseAction>('rewrite');
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  /** 本次临时不注入的写作规范；和临时笔法一样只影响这一次，不写库 */
  const [excludedNormIds, setExcludedNormIds] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const hasSelection = selection.text.trim().length > 0;

  // 只在打开的瞬间重置，避免后台数据刷新冲掉正在进行的操作
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPhase({ kind: 'form' });
      setInstruction(initialInstruction ?? '');
      setVoiceId(null);
      setExcludedNormIds([]);
      // 没选中内容时只能续写，默认就切过去；调用方预填了操作时以它为准
      setAction(initialAction ?? (selection.text.trim() ? 'rewrite' : 'continue'));
    }
    wasOpen.current = open;
  }, [open, selection.text, initialAction, initialInstruction]);

  const actionDef = findReviseAction(action);
  const effectiveSelection = actionDef.requiresSelection
    ? selection
    : hasSelection
      ? selection
      : selectionAtEnd(content);
  const blocked = actionDef.requiresSelection && !hasSelection;

  /** picker 列出「写正文」作用范围内的全部规范（含本次取消的） */
  const writingNorms = useMemo(
    () => normsInScope(context.writingNorms ?? [], 'writing'),
    [context.writingNorms],
  );

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

    const built = builder.build({ ...context, excludedNormIds });
    const { before, after } = surroundingContext(content, effectiveSelection);

    let streamed = '';
    try {
      const result = await llm.runStream(
        'paragraph-revise',
        {
          system: buildReviseSystemPrompt(built.stablePrefix, action),
          user: buildReviseUserPrompt({
            volatileSuffix: built.volatileSuffix,
            selection: effectiveSelection,
            before,
            after,
            temporaryVoiceId: voiceId,
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
        setPhase(streamed ? { kind: 'done', text: streamed } : { kind: 'form' });
        return;
      }
      setPhase({
        kind: 'error',
        message:
          cause instanceof LlmError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : '生成失败',
      });
    }
  }

  async function accept() {
    if (phase.kind !== 'done') return;
    await onAccept(phase.text, action);
    setPhase({ kind: 'form' });
    onClose();
  }

  const generated = phase.kind === 'streaming' || phase.kind === 'done' ? phase.text : '';

  return (
    <Sheet
      open={open}
      title="加工这一段"
      description={
        hasSelection
          ? `已选中 ${countWords(selection.text)} 字`
          : '没有选中内容，可以从正文末尾续写'
      }
      onClose={onClose}
    >
      {phase.kind === 'form' || phase.kind === 'error' ? (
        <>
          <SegmentedControl
            label="操作"
            value={action}
            options={REVISE_ACTIONS.map((item) => ({
              value: item.id,
              label: item.label,
              description: item.hint,
            }))}
            onChange={setAction}
          />

          {blocked ? (
            <p className="rounded-xl bg-accent-soft px-3 py-2.5 text-sm text-accent">
              「{actionDef.label}」需要先在正文里选中一段文字。
            </p>
          ) : null}

          {hasSelection ? (
            <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
              <p className="mb-1 text-xs font-medium text-ink-700">选中的内容</p>
              <p className="max-h-32 overflow-y-auto font-reading text-sm leading-relaxed whitespace-pre-wrap text-ink-700">
                {selection.text}
              </p>
            </div>
          ) : null}

          <NormInjectionPicker
            norms={writingNorms}
            excludedIds={excludedNormIds}
            onToggle={toggleNorm}
          />

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-ink-700">临时换个笔法（可选）</p>
            <p className="text-xs leading-relaxed text-ink-500">
              只影响这一次，不改动作品的风格档案。
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={voiceId === null}
                onClick={() => setVoiceId(null)}
                className={[
                  'rounded-full border px-3 py-1.5 text-xs transition-colors',
                  voiceId === null
                    ? 'border-ink-900 bg-ink-900 text-paper'
                    : 'border-ink-100 bg-paper-raised text-ink-700',
                ].join(' ')}
              >
                沿用当前文风
              </button>
              {VOICE_LIBRARY.map((voice) => {
                const active = voiceId === voice.id;
                return (
                  <button
                    key={voice.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setVoiceId(voice.id)}
                    className={[
                      'rounded-full border px-3 py-1.5 text-xs transition-colors',
                      active
                        ? 'border-ink-900 bg-ink-900 text-paper'
                        : 'border-ink-100 bg-paper-raised text-ink-700',
                    ].join(' ')}
                  >
                    {voice.name}
                  </button>
                );
              })}
            </div>
          </div>

          <TextAreaField
            label="额外要求（可选）"
            rows={2}
            value={instruction}
            placeholder="例如：多用短句；去掉心理描写。"
            onChange={(event) => setInstruction(event.target.value)}
          />

          {/* 文案带「开始」前缀，避免与上方分段控件里的同名选项混淆 */}
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!llm.configured || blocked}
            onClick={generate}
          >
            开始{actionDef.label}
          </Button>

          {!llm.configured ? (
            <p className="text-xs text-ink-500">需要先在「设置」里配置模型。</p>
          ) : null}

          {phase.kind === 'error' ? (
            <p role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
              {phase.message}
            </p>
          ) : null}
        </>
      ) : null}

      {phase.kind === 'streaming' || phase.kind === 'done' ? (
        <>
          {hasSelection ? (
            <details className="rounded-xl bg-paper-sunken px-3 py-2.5">
              <summary className="cursor-pointer text-xs font-medium text-ink-700">
                对照原文（{countWords(selection.text)} 字）
              </summary>
              <p className="mt-2 font-reading text-sm leading-relaxed whitespace-pre-wrap text-ink-500">
                {selection.text}
              </p>
            </details>
          ) : null}

          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium text-ink-700">
              {phase.kind === 'streaming' ? '正在写…' : `${actionDef.label}结果`}
            </p>
            <p className="text-xs text-ink-500">{countWords(generated)} 字</p>
          </div>

          {phase.kind === 'streaming' ? (
            <p
              aria-live="polite"
              className="max-h-[36dvh] overflow-y-auto rounded-xl bg-paper-sunken px-3 py-2.5 font-reading text-sm leading-relaxed whitespace-pre-wrap text-ink-900"
            >
              {generated || '…'}
            </p>
          ) : (
            <TextAreaField
              label="结果（可直接修改）"
              rows={10}
              value={generated}
              onChange={(event) => setPhase({ kind: 'done', text: event.target.value })}
            />
          )}

          {phase.kind === 'streaming' ? (
            <Button variant="secondary" size="lg" block onClick={() => abortRef.current?.abort()}>
              停止生成
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <Button variant="primary" size="lg" block onClick={accept}>
                {actionDef.placement === 'replace' ? '替换原文' : '插入正文'}
              </Button>
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
