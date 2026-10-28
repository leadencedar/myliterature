import { useMemo, useState } from 'react';
import type { FieldDiff, Proposal } from '@/domain/schema';
import { applyEdits, summarizeDiff } from '@/proposal/diff';
import { displayFieldValue, getFieldValue, type FieldSpec } from '@/proposal/fields';
import { Button, IconButton } from './Button';
import { ChevronIcon, RefreshIcon, UndoIcon } from './icons';

export interface EditedProposal {
  proposal: Proposal;
  /** 应用了用户行内编辑后的最终数据 */
  payload: unknown;
}

interface ProposalReviewProps {
  proposals: Proposal[];
  /** 知识条目的字段规格依赖所属分类，因此由调用方提供 */
  specsFor: (proposal: Proposal) => FieldSpec[];
  onAcceptAll: (items: EditedProposal[]) => void | Promise<void>;
  onAcceptOne?: (item: EditedProposal) => void | Promise<void>;
  onReject: (proposalIds: string[]) => void | Promise<void>;
  /** 提供时每条提案会出现「重新生成」 */
  onRegenerate?: (proposal: Proposal) => void | Promise<void>;
  busy?: boolean;
  /** 主操作按钮文案 */
  acceptAllLabel?: string;
  /** 默认展开第一条，长列表（如收件箱）宜全部折叠 */
  defaultExpandFirst?: boolean;
  /**
   * 初始就标记为忽略的提案 id（归档批次里 merge/replace 默认不选，M2.1）。
   * 与现有「忽略这条」完全同一套语义：仍显示「已标记为忽略 / 恢复」，
   * 底部采用按钮会排除它们；不传时行为与之前逐字节一致。
   */
  initiallyIgnoredIds?: string[];
}

const ACTION_LABELS: Record<Proposal['action'], string> = {
  create: '新增',
  merge: '合并',
  replace: '替换',
};

const DIFF_STYLES: Record<FieldDiff['kind'], string> = {
  added: 'border-l-2 border-l-emerald-400 bg-emerald-50/40',
  changed: 'border-l-2 border-l-accent bg-accent-soft/40',
  removed: 'border-l-2 border-l-seal bg-seal-soft/40',
  unchanged: 'border-l-2 border-l-ink-100',
};

const DIFF_BADGES: Partial<Record<FieldDiff['kind'], string>> = {
  added: '新增',
  changed: '改动',
};

/**
 * AI 产出的统一确认界面。
 *
 * 交互取向：**可折叠分区 + 分区级重新生成 + 底部一次「全部采用」**。
 * 大批量生成（一次给出世界观、多个人物、整份大纲）如果要求逐条点确认，
 * 在手机上是十几次滚动加点击，用户会直接放弃阅读；折叠分区让「快速通过」
 * 和「逐条细看」两种用法共存，同时仍然满足「不经确认不落库」的底线。
 */
export function ProposalReview({
  proposals,
  specsFor,
  onAcceptAll,
  onAcceptOne,
  onReject,
  onRegenerate,
  busy = false,
  acceptAllLabel = '全部采用',
  defaultExpandFirst = true,
  initiallyIgnoredIds,
}: ProposalReviewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const first = proposals[0];
    return defaultExpandFirst && first ? new Set([first.id]) : new Set();
  });
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  // 初始忽略只决定挂载时的集合；之后仍走现有的忽略/恢复交互
  const [ignored, setIgnored] = useState<Set<string>>(() => new Set(initiallyIgnoredIds ?? []));

  const specsById = useMemo(() => {
    const map = new Map<string, FieldSpec[]>();
    for (const proposal of proposals) map.set(proposal.id, specsFor(proposal));
    return map;
  }, [proposals, specsFor]);

  const selected = proposals.filter((proposal) => !ignored.has(proposal.id));

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function editField(proposalId: string, path: string, value: string) {
    setEdits((current) => ({
      ...current,
      [proposalId]: { ...current[proposalId], [path]: value },
    }));
  }

  function revertField(proposalId: string, diff: FieldDiff) {
    // 还原到合并前的原值
    editField(proposalId, diff.field, diff.before ?? '');
  }

  function valueOf(proposal: Proposal, spec: FieldSpec, diff: FieldDiff | undefined): string {
    const edited = edits[proposal.id]?.[spec.path];
    if (edited !== undefined) return edited;
    if (diff) return diff.after ?? '';
    return getFieldValue(proposal.payload, spec);
  }

  function materialize(proposal: Proposal): EditedProposal {
    const specs = specsById.get(proposal.id) ?? [];
    const proposalEdits = edits[proposal.id];
    return {
      proposal,
      payload: proposalEdits
        ? applyEdits(specs, proposal.payload, proposalEdits)
        : proposal.payload,
    };
  }

  if (proposals.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2.5">
        {proposals.map((proposal) => {
          const isIgnored = ignored.has(proposal.id);
          const isOpen = expanded.has(proposal.id) && !isIgnored;
          const specs = specsById.get(proposal.id) ?? [];
          const diffByPath = new Map(proposal.diff.map((item) => [item.field, item]));
          const panelId = `proposal-panel-${proposal.id}`;

          return (
            <li
              key={proposal.id}
              className={[
                'overflow-hidden rounded-2xl border bg-paper-raised transition-opacity',
                isIgnored ? 'border-ink-100 opacity-50' : 'border-ink-100',
              ].join(' ')}
            >
              <div className="flex items-center">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  disabled={isIgnored}
                  onClick={() => toggle(proposal.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-4 py-3.5 text-left active:bg-paper-sunken disabled:active:bg-transparent"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-ink-900">
                        {proposal.label}
                      </span>
                      <span className="shrink-0 rounded-full bg-paper-sunken px-2 py-0.5 text-[0.6875rem] text-ink-500">
                        {ACTION_LABELS[proposal.action]}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-500">
                      <span>{summarizeDiff(proposal.diff)}</span>
                      {proposal.sourceRef ? (
                        <span className="truncate text-ink-300">来自 {proposal.sourceRef}</span>
                      ) : null}
                    </span>
                  </span>
                  <ChevronIcon
                    className={`h-5 w-5 shrink-0 text-ink-300 transition-transform ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
              </div>

              {isOpen ? (
                <div id={panelId} className="border-t border-ink-100 px-4 py-3">
                  <div className="flex flex-col gap-3.5">
                    {specs.map((spec) => {
                      const diff = diffByPath.get(spec.path);
                      const value = valueOf(proposal, spec, diff);
                      // 两边都空的字段不展示，避免预览被空行淹没
                      if (!value && !diff) return null;

                      return (
                        <FieldRow
                          key={spec.path}
                          spec={spec}
                          diff={diff}
                          value={value}
                          onChange={(next) => editField(proposal.id, spec.path, next)}
                          onRevert={
                            diff && diff.kind === 'changed'
                              ? () => revertField(proposal.id, diff)
                              : undefined
                          }
                        />
                      );
                    })}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {onAcceptOne ? (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy}
                        onClick={() => onAcceptOne(materialize(proposal))}
                      >
                        采用这条
                      </Button>
                    ) : null}
                    {onRegenerate ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => onRegenerate(proposal)}
                      >
                        <RefreshIcon className="h-4 w-4" />
                        重新生成
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setIgnored((current) => new Set(current).add(proposal.id));
                      }}
                    >
                      忽略这条
                    </Button>
                  </div>
                </div>
              ) : null}

              {isIgnored ? (
                <div className="flex items-center justify-between gap-2 border-t border-ink-100 px-4 py-2">
                  <span className="text-xs text-ink-500">已标记为忽略</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setIgnored((current) => {
                        const next = new Set(current);
                        next.delete(proposal.id);
                        return next;
                      })
                    }
                  >
                    恢复
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* 窄屏要停在底部 Tab 栏之上；桌面端没有底部栏，贴着视口底缘即可 */}
      <div className="sticky bottom-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom,0px))] flex gap-2 rounded-2xl border border-ink-100 bg-paper-raised/95 p-2 backdrop-blur lg:bottom-4">
        <Button
          variant="secondary"
          size="lg"
          block
          disabled={busy}
          onClick={() => onReject(proposals.map((proposal) => proposal.id))}
        >
          全部忽略
        </Button>
        <Button
          variant="primary"
          size="lg"
          block
          disabled={busy || selected.length === 0}
          onClick={() => onAcceptAll(selected.map(materialize))}
        >
          {/* 只有一条时「（1）」没有信息量，还会让作者以为漏选了什么 */}
          {busy
            ? '处理中…'
            : selected.length > 1
              ? `${acceptAllLabel}（${selected.length}）`
              : acceptAllLabel}
        </Button>
      </div>
    </div>
  );
}

function FieldRow({
  spec,
  diff,
  value,
  onChange,
  onRevert,
}: {
  spec: FieldSpec;
  diff: FieldDiff | undefined;
  value: string;
  onChange: (value: string) => void;
  onRevert?: () => void;
}) {
  const [showBefore, setShowBefore] = useState(false);
  const kind = diff?.kind ?? 'unchanged';
  const badge = DIFF_BADGES[kind];
  const inputId = `field-${spec.path.replace(/\./gu, '-')}-${diff?.label ?? ''}`;

  return (
    <div className={`rounded-r-lg pl-3 ${DIFF_STYLES[kind]}`}>
      <div className="mb-1 flex items-center gap-2">
        <label htmlFor={inputId} className="text-xs font-medium text-ink-700">
          {spec.label}
        </label>
        {badge ? (
          <span
            className={[
              'rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
              kind === 'added' ? 'bg-emerald-100 text-emerald-700' : 'bg-accent-soft text-accent',
            ].join(' ')}
          >
            {badge}
          </span>
        ) : null}
        {diff?.kind === 'changed' ? (
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setShowBefore((current) => !current)}>
              {showBefore ? '收起原值' : '看原值'}
            </Button>
            {onRevert ? (
              <IconButton label={`还原「${spec.label}」`} onClick={onRevert}>
                <UndoIcon className="h-4 w-4" />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>

      {showBefore && diff?.before ? (
        <p className="mb-1.5 rounded bg-paper-sunken px-2 py-1.5 text-xs leading-relaxed whitespace-pre-wrap text-ink-500">
          {/* 枚举的原值要显示 label，否则用户看到的是 `web` 这种机器值 */}
          {displayFieldValue(spec, diff.before)}
        </p>
      ) : null}

      {spec.kind === 'enum' ? (
        <select
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-lg border border-ink-100 bg-paper-raised px-2 py-1.5 text-sm focus:border-ink-500 focus:outline-none"
        >
          {/* 模型给了不在选项里的值时也要能显示出来，否则下拉会静静地跳到第一项 */}
          {(spec.options ?? []).some((option) => option.value === value) ? null : (
            <option value={value}>{value || '未设定'}</option>
          )}
          {(spec.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : spec.kind === 'text' || spec.kind === 'number' ? (
        <input
          id={inputId}
          value={value}
          inputMode={spec.kind === 'number' ? 'numeric' : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-lg border border-ink-100 bg-paper-raised px-2 py-1.5 text-sm focus:border-ink-500 focus:outline-none"
        />
      ) : (
        <textarea
          id={inputId}
          value={value}
          rows={Math.min(10, Math.max(2, Math.ceil(value.length / 28)))}
          onChange={(event) => onChange(event.target.value)}
          className="w-full resize-none rounded-lg border border-ink-100 bg-paper-raised px-2 py-1.5 font-reading text-sm leading-relaxed focus:border-ink-500 focus:outline-none"
        />
      )}

      {spec.kind === 'list' ? <p className="mt-1 text-[0.625rem] text-ink-300">每行一项</p> : null}
    </div>
  );
}
