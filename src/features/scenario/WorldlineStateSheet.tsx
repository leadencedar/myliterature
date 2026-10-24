import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import type { Category, EntryRef, KnowledgeEntry, Scenario, ScenarioNode } from '@/domain/schema';
import { isCheckpoint, pathTo } from '@/domain/scenario';
import {
  ENTRY_STATUS_LABELS,
  OC_ASPECT_LABELS,
  effectiveKnowledge,
  fieldMutability,
  refKey,
  type EffectiveEntry,
} from '@/domain/worldline';
import { Button } from '@/ui/Button';
import { TextAreaField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
import { PROMOTE_MESSAGES, buildPromotion, type PromoteSubject } from './promote';
import { crumbLabel, errorText } from './scenarioView';

/** 前情摘要的上限（与 ScenarioNodeSchema.pathSummary.text 一致） */
const MAX_SUMMARY = 2000;

const OC_ASPECTS_IN_ORDER = ['injury', 'ability', 'item', 'relation', 'secret', 'other'] as const;

const ORIGIN_LABELS: Record<EffectiveEntry['origin'], string> = {
  world: '世界观',
  limited: '限定',
  line: '本线新增',
};

/**
 * 本线状态（设计 §8.3）：本线变化 / 有效设定 / 主角状态 / 事件与标记，外加检查点的前情摘要。
 *
 * 全部从树上现算（effectiveKnowledge），打开面板不发任何请求。差异与摘要都是沙盒层，作者可直接编辑；
 * 「提升为世界观」只生成提案（设计 §7.1），到知识库确认之后才改世界观条目。
 */
export function WorldlineStateSheet({
  open,
  scenario,
  nodes,
  node,
  entries,
  categories,
  failedCheckpointIds,
  onEditDelta,
  onNodeSaved,
  onClose,
}: {
  open: boolean;
  scenario: Scenario;
  nodes: readonly ScenarioNode[];
  /** 当前节点 */
  node: ScenarioNode;
  entries: readonly KnowledgeEntry[];
  categories: readonly Category[];
  /** 后台整理前情失败的检查点 */
  failedCheckpointIds: ReadonlySet<string>;
  onEditDelta: (nodeId: string) => void;
  onNodeSaved: (node: ScenarioNode) => void;
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const path = useMemo(() => pathTo(nodes, node.id), [nodes, node.id]);
  const knowledge = useMemo(
    () => effectiveKnowledge({ scenario, path, entries, categories }),
    [scenario, path, entries, categories],
  );
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const castId = scenario.setup.cast[0]?.id ?? '';
  const castEntryId = scenario.setup.cast[0]?.entryId ?? '';

  const known = new Map<string, EffectiveEntry>();
  for (const entry of [...knowledge.entries, ...knowledge.pendingReveals])
    known.set(refKey(entry.ref), entry);
  const entryOf = (ref: EntryRef) => {
    const key = refKey(ref);
    return known.get(knowledge.lineAliases[key] ?? key);
  };
  const fieldLabel = (categoryId: string | undefined, key: string) =>
    (categoryId ? categoryById.get(categoryId) : undefined)?.fieldTemplate.find(
      (field) => field.key === key,
    )?.label ?? key;
  const step = (nodeId: string) => `第 ${(knowledge.depthOf[nodeId] ?? 0) + 1} 步`;

  // 前情摘要：路径上（含当前节点）最近的检查点
  const checkpoint = [...path].reverse().find((item) => isCheckpoint(item));
  const failed = path.some((item) => failedCheckpointIds.has(item.id));
  const [summary, setSummary] = useState('');
  const [summaryError, setSummaryError] = useState<string | undefined>();
  const [scopeError, setScopeError] = useState<string | undefined>();
  const seedRef = useRef(checkpoint);
  seedRef.current = checkpoint;
  const navigate = useNavigate();
  /** 提升的结果：生成了提案（附说明）/ 不能提升的原因 / 写库失败 */
  const [promotion, setPromotion] = useState<
    | { kind: 'done'; notice: string | null }
    | { kind: 'reason'; text: string }
    | { kind: 'error'; text: string }
    | null
  >(null);
  /** 本次打开面板里已经生成过提案的项：避免连点生成两条相同的待确认项 */
  const [promotedKeys, setPromotedKeys] = useState<ReadonlySet<string>>(new Set());
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setSummary(seedRef.current?.pathSummary?.text ?? '');
      setSummaryError(undefined);
      setScopeError(undefined);
      setPromotion(null);
      setPromotedKeys(new Set());
    }
    wasOpen.current = open;
  }, [open]);

  async function promote(key: string, subject: PromoteSubject, sourceNodeId: string) {
    const result = buildPromotion({
      novelId: scenario.novelId,
      subject,
      entries,
      categories,
      sourceRef: `推演《${scenario.title}》${step(sourceNodeId)}`,
    });
    if (!result.ok) {
      setPromotion({ kind: 'reason', text: result.reason });
      return;
    }
    try {
      await repository.createProposals([result.proposal]);
      invalidate();
      setPromotedKeys((previous) => new Set(previous).add(key));
      setPromotion({ kind: 'done', notice: result.notice });
    } catch (cause) {
      setPromotion({ kind: 'error', text: errorText(cause, '生成待确认项失败').message });
    }
  }

  /**
   * 存着但因字段后来改成锁定而失效的覆盖（D6.3）：按条目归组、同一栏只留最后一次。
   * 单独列出来是为了让作者点「提升」时得到原因，而不是找不到按钮
   */
  const lockedOverrides = new Map<string, Map<string, { value: string; nodeId: string }>>();
  for (const item of path) {
    for (const override of item.delta.fieldOverrides) {
      const target = entryOf(override.target);
      if (!target?.entry) continue;
      const category = categoryById.get(target.categoryId);
      if (!category?.fieldTemplate.some((field) => field.key === override.fieldKey)) continue;
      if (fieldMutability(category, target.entry, override.fieldKey) !== 'locked') continue;
      const key = refKey(target.ref);
      const byField =
        lockedOverrides.get(key) ?? new Map<string, { value: string; nodeId: string }>();
      byField.set(override.fieldKey, { value: override.value, nodeId: item.id });
      lockedOverrides.set(key, byField);
    }
  }

  async function saveSummary() {
    if (!checkpoint?.pathSummary) return;
    setSummaryError(undefined);
    try {
      const saved = await repository.setScenarioNodeSummary(checkpoint.id, {
        text: summary.trim(),
        openThreads: checkpoint.pathSummary.openThreads,
      });
      invalidate();
      onNodeSaved(saved);
    } catch (cause) {
      setSummaryError(errorText(cause, '保存失败').message);
    }
  }

  /** 限定到本推演的条目：「只从这一步起出现」/「改为整个推演」 */
  async function setFromNode(entry: KnowledgeEntry, fromNodeId: string | null) {
    const scope = entry.scope;
    if (scope?.kind !== 'limited') return;
    setScopeError(undefined);
    try {
      await repository.updateEntry(entry.id, {
        scope: {
          kind: 'limited',
          targets: scope.targets.map((target) =>
            target.scenarioId === scenario.id ? { ...target, fromNodeId } : target,
          ),
        },
      });
      invalidate();
    } catch (cause) {
      setScopeError(errorText(cause, '保存失败').message);
    }
  }

  const changeGroups = path
    .map((item) => {
      const lines: string[] = [];
      for (const override of item.delta.fieldOverrides) {
        const target = entryOf(override.target);
        lines.push(
          `${target?.title ?? '（已不存在的条目）'} · ${fieldLabel(target?.categoryId, override.fieldKey)}：${override.value}`,
        );
      }
      for (const line of item.delta.lineEntries) lines.push(`新出现：${line.title}`);
      for (const change of item.delta.statusChanges) {
        const note = change.note ? `（${change.note}）` : '';
        lines.push(
          `${entryOf(change.target)?.title ?? '（已不存在的条目）'}：${ENTRY_STATUS_LABELS[change.status]}${note}`,
        );
      }
      for (const change of item.delta.ocChanges) {
        lines.push(
          `主角${OC_ASPECT_LABELS[change.aspect]}${change.op === 'add' ? '新增' : '去掉'}：${change.text}`,
        );
      }
      for (const event of item.delta.events) lines.push(`事件：${event}`);
      for (const flag of item.delta.flags) lines.push(`标记 ${flag.key}：${flag.value}`);
      return { node: item, lines };
    })
    .filter((group) => group.lines.length > 0 || group.node.notices.length > 0);

  const ocState = knowledge.oc[castId];
  const flagKeys = Object.keys(knowledge.flags).sort();

  return (
    <Sheet
      open={open}
      title="本线状态"
      description={`${crumbLabel(node)}处这条世界线的状态`}
      onClose={onClose}
    >
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink-900">本线变化</h3>
          <Button size="sm" onClick={() => onEditDelta(node.id)}>
            编辑这一步的变化
          </Button>
        </div>
        {changeGroups.length === 0 ? (
          <p className="text-sm text-ink-500">这条线还没有记下任何变化。</p>
        ) : null}
        {changeGroups.map(({ node: item, lines }) => (
          <div key={item.id} className="rounded-xl border border-ink-100 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-ink-700">{crumbLabel(item)}</p>
              {item.id === node.id ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`编辑${crumbLabel(item)}的变化`}
                  onClick={() => onEditDelta(item.id)}
                >
                  编辑
                </Button>
              )}
            </div>
            {lines.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-1 text-sm text-ink-900">
                {lines.map((text, index) => (
                  <li key={`${index}-${text}`}>{text}</li>
                ))}
              </ul>
            ) : null}
            {item.notices.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1 text-xs text-seal">
                {item.notices.map((notice, index) => (
                  <li key={`${index}-${notice.message}`}>没有记下：{notice.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink-900">有效设定</h3>
        <p className="text-xs leading-relaxed text-ink-500">
          「提升为世界观」会生成待确认项，到知识库确认后才改世界观条目。状态、主角状态、事件与标记不能提升：
          {PROMOTE_MESSAGES.sandboxOnly}。
        </p>
        <ul className="flex flex-col gap-2">
          {knowledge.entries.map((entry) => {
            const overridden = Object.entries(entry.fields).filter(
              ([, field]) => entry.origin !== 'line' && field.source !== 'world',
            );
            const limitedTarget =
              entry.origin === 'limited' && entry.entry?.scope?.kind === 'limited'
                ? entry.entry.scope.targets.find((target) => target.scenarioId === scenario.id)
                : undefined;
            const isCast = entry.ref.kind === 'world' && entry.ref.entryId === castEntryId;
            return (
              <li key={refKey(entry.ref)} className="rounded-xl border border-ink-100 p-3">
                <p className="text-sm font-medium text-ink-900">
                  {entry.title}
                  <span className="ml-2 text-xs font-normal text-ink-500">
                    {ORIGIN_LABELS[entry.origin]}
                    {entry.origin === 'line' && entry.lineNodeId
                      ? `（${step(entry.lineNodeId)}）`
                      : ''}
                  </span>
                </p>
                {overridden.map(([key, field]) => {
                  const promoteKey = `${refKey(entry.ref)}:${key}:${field.value}`;
                  const label = fieldLabel(entry.categoryId, key);
                  return (
                    <div key={key} className="mt-1 text-xs leading-relaxed text-ink-700">
                      <p>
                        {label} · 本线（{step(field.source)}）：{field.value}
                      </p>
                      <p className="text-ink-500">
                        世界观原值：{entry.entry?.fields[key]?.trim() || '（空）'}
                      </p>
                      {entry.entry ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`把「${entry.title}」的「${label}」提升为世界观`}
                          disabled={promotedKeys.has(promoteKey)}
                          onClick={() =>
                            void promote(
                              promoteKey,
                              {
                                kind: 'field',
                                entry: entry.entry!,
                                fieldKey: key,
                                value: field.value,
                              },
                              field.source,
                            )
                          }
                        >
                          {promotedKeys.has(promoteKey) ? '已生成待确认项' : '提升为世界观'}
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
                {[
                  ...(lockedOverrides.get(refKey(entry.ref)) ??
                    new Map<string, { value: string; nodeId: string }>()),
                ].map(([key, item]) => {
                  const label = fieldLabel(entry.categoryId, key);
                  return (
                    <div
                      key={`locked-${key}`}
                      className="mt-1 text-xs leading-relaxed text-ink-500"
                    >
                      <p>
                        {label} · 本线（{step(item.nodeId)}）：{item.value}
                        （已改为底层设定，不再生效）
                      </p>
                      {/* 不用 disabled：作者点了要能看到为什么不行 */}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-disabled="true"
                        aria-label={`把「${entry.title}」的「${label}」提升为世界观`}
                        onClick={() =>
                          void promote(
                            `${refKey(entry.ref)}:${key}:locked`,
                            {
                              kind: 'field',
                              entry: entry.entry!,
                              fieldKey: key,
                              value: item.value,
                            },
                            item.nodeId,
                          )
                        }
                      >
                        提升为世界观
                      </Button>
                    </div>
                  );
                })}
                {entry.status ? (
                  <p className="mt-1 text-xs text-ink-700">
                    状态：{ENTRY_STATUS_LABELS[entry.status.value]}
                    {entry.status.note ? `（${entry.status.note}）` : ''} ·{' '}
                    {step(entry.status.nodeId)}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {entry.origin === 'line' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`把「${entry.title}」提升为世界观`}
                      disabled={promotedKeys.has(refKey(entry.ref))}
                      onClick={() =>
                        void promote(
                          refKey(entry.ref),
                          { kind: 'line', entry },
                          entry.lineNodeId ?? node.id,
                        )
                      }
                    >
                      {promotedKeys.has(refKey(entry.ref)) ? '已生成待确认项' : '提升为世界观'}
                    </Button>
                  ) : null}
                  {limitedTarget && !isCast && entry.entry ? (
                    (limitedTarget.fromNodeId ?? null) === null ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void setFromNode(entry.entry!, node.id)}
                      >
                        只从这一步起出现
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void setFromNode(entry.entry!, null)}
                      >
                        改为整个推演
                      </Button>
                    )
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {scopeError ? (
          <p role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
            {scopeError}
          </p>
        ) : null}
        {promotion?.kind === 'done' ? (
          <div role="status" className="flex flex-col gap-2 rounded-xl bg-paper-sunken p-3">
            <p className="text-sm text-ink-900">已生成待确认项，到知识库确认</p>
            {promotion.notice ? <p className="text-xs text-ink-500">{promotion.notice}</p> : null}
            <div>
              <Button
                size="sm"
                onClick={() => {
                  onClose();
                  navigate('/knowledge');
                }}
              >
                去知识库确认
              </Button>
            </div>
          </div>
        ) : null}
        {promotion?.kind === 'reason' ? (
          <p role="status" className="rounded-xl bg-paper-sunken px-3 py-2.5 text-sm text-ink-700">
            {promotion.text}
          </p>
        ) : null}
        {promotion?.kind === 'error' ? (
          <p role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
            {promotion.text}
          </p>
        ) : null}
        {knowledge.inactive.length > 0 ? (
          <div className="rounded-xl bg-paper-sunken p-3">
            <p className="text-xs font-medium text-ink-700">不再生效</p>
            <ul className="mt-1 flex flex-col gap-1 text-xs text-ink-500">
              {knowledge.inactive.map((item, index) => (
                <li key={`${item.nodeId}-${index}`}>{item.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink-900">主角状态</h3>
        {ocState && OC_ASPECTS_IN_ORDER.some((aspect) => ocState[aspect].length > 0) ? (
          <ul className="flex flex-col gap-1 text-sm text-ink-900">
            {OC_ASPECTS_IN_ORDER.filter((aspect) => ocState[aspect].length > 0).map((aspect) => (
              <li key={aspect}>
                {OC_ASPECT_LABELS[aspect]}：{ocState[aspect].map((item) => item.text).join('；')}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-500">没有变化。</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink-900">事件与标记</h3>
        {knowledge.events.length === 0 && flagKeys.length === 0 ? (
          <p className="text-sm text-ink-500">还没有记下事件或标记。</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-ink-900">
            {knowledge.events.map((event, index) => (
              <li key={`event-${index}`}>
                第 {event.depth + 1} 步 · {event.text}
              </li>
            ))}
            {flagKeys.map((key) => (
              <li key={`flag-${key}`}>
                标记 {key}：{knowledge.flags[key]!.value}
              </li>
            ))}
          </ul>
        )}
      </section>

      {checkpoint ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink-900">
            前情摘要（到{crumbLabel(checkpoint)}）
          </h3>
          {failed ? <p className="text-xs text-seal">前情整理失败，下次推进时会重试</p> : null}
          {checkpoint.pathSummary ? (
            <>
              <TextAreaField
                label="前情摘要"
                rows={5}
                value={summary}
                hint={
                  <span className={summary.trim().length > MAX_SUMMARY ? 'text-seal' : undefined}>
                    {summary.trim().length} / {MAX_SUMMARY}
                  </span>
                }
                onChange={(event) => setSummary(event.target.value)}
              />
              <div>
                <Button
                  size="sm"
                  disabled={
                    summary.trim().length > MAX_SUMMARY ||
                    summary.trim() === checkpoint.pathSummary.text
                  }
                  onClick={() => void saveSummary()}
                >
                  保存摘要
                </Button>
              </div>
              {summaryError ? (
                <p role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
                  {summaryError}
                </p>
              ) : null}
            </>
          ) : failed ? null : (
            <p className="text-sm text-ink-500">还没有整理，下次推进时会补上。</p>
          )}
        </section>
      ) : null}
    </Sheet>
  );
}
