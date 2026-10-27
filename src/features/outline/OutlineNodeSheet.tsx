import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { selectPlanningEntries, type PlanningEntryBlock } from '@/context/planningContext';
import { formatTokens } from '@/context/tokens';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import type {
  Category,
  Chapter,
  KnowledgeEntry,
  Novel,
  OutlineNode,
  StyleProfile,
} from '@/domain/schema';
import { normsInScope } from '@/domain/writingNorm';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { normTokens } from '@/prompt/sections';
import { buildCreateProposal, buildReplaceProposal, newBatchId } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import { buildOutlineDrafts, serializeOutlineTree } from '@/proposal/outlineText';
import { Button } from '@/ui/Button';
import { SegmentedControl } from '@/ui/Controls';
import { TextAreaField, TextField } from '@/ui/Field';
import { ConfirmDialog, Sheet } from '@/ui/Sheet';
import { ProposalInbox } from '../proposals/ProposalInbox';
import { useFromOldMainline } from '../scenario/useFromOldMainline';
import { OutlineLinkConfirmSheet, type LinkConfirmResult } from './OutlineLinkConfirmSheet';
import {
  OutlineExpandSchema,
  ancestorsOf,
  buildExpandSystemPrompt,
  buildExpandUserPrompt,
  toChildDrafts,
} from './outlineExpand';
import { MAX_OUTLINE_DEPTH, OUTLINE_STATUS_LABELS } from './outlineTree';
import { suggestOutlineLinks, type ChildLinkSuggestion } from './suggestOutlineLinks';

const STATUS_OPTIONS = (Object.keys(OUTLINE_STATUS_LABELS) as OutlineNode['status'][]).map(
  (value) => ({ value, label: OUTLINE_STATUS_LABELS[value] }),
);

type ExpandState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'review'; batchId: string }
  | { phase: 'error'; message: string };

/** 某节点及其全部后代的 id（含自身）；replace 细化会删除这些节点 */
function subtreeIdsOf(nodes: OutlineNode[], rootId: string): Set<string> {
  const byParent = new Map<string | null, OutlineNode[]>();
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  const ids = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of byParent.get(id) ?? []) queue.push(child.id);
  }
  return ids;
}

/** 注入清单里一条目的来源标签 */
function planningSourceLabel(block: PlanningEntryBlock): string {
  if (block.reason === 'core') return '核心';
  if (block.reason === 'linked') return '关联';
  return `提到 · ${block.matchedName ?? block.entry.title}`;
}

export function OutlineNodeSheet({
  open,
  novel,
  style,
  node,
  nodes,
  entries,
  categories,
  depth,
  chapters,
  openThreads,
  rollingSummary,
  onWrite,
  onClose,
}: {
  open: boolean;
  novel: Novel;
  style: StyleProfile;
  node: OutlineNode;
  nodes: OutlineNode[];
  entries: KnowledgeEntry[];
  categories: Category[];
  /** 该节点当前深度，0 为顶层。决定还能否再往下拆 */
  depth: number;
  /** replace 细化会解除这些已写章节的大纲关联（正文保留）。不传时影响数按 0 处理 */
  chapters?: readonly Chapter[];
  /** 主线最近一份摘要的累计伏笔；细化前注入 */
  openThreads?: readonly string[];
  /** 作品滚动进展；仅顶层细化时注入 */
  rollingSummary?: string;
  /** 提供时显示「写这一章」入口；只对没有子节点的叶子节点有意义 */
  onWrite?: (node: OutlineNode) => void | Promise<void>;
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const llm = useLlm();

  const [title, setTitle] = useState(node.title);
  const [synopsis, setSynopsis] = useState(node.synopsis);
  const [targetWords, setTargetWords] = useState(
    node.targetWords === null ? '' : String(node.targetWords),
  );
  const [status, setStatus] = useState<OutlineNode['status']>(node.status);
  const [linked, setLinked] = useState<string[]>(node.linkedEntryIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [childCount, setChildCount] = useState(5);
  const [expandExtra, setExpandExtra] = useState('');
  const [expand, setExpand] = useState<ExpandState>({ phase: 'idle' });
  /** 「额外要求」不落库（D2），但本次会话内临时移除的命中项要连续生效 */
  const [removedMentionIds, setRemovedMentionIds] = useState<string[]>([]);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [linkPanel, setLinkPanel] = useState<ChildLinkSuggestion[] | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  // 会话内关联抑制：「取消/跳过过的条目本次会话不再建议」。replace 细化会换掉子节点 id，
  // 只按 childId 记忆会让取消过的条目在再次细化时重新冒出来（需求指标 2），所以同时记条目
  const suppressedPairsRef = useRef<Set<string>>(new Set());
  const suppressedEntryIdsRef = useRef<Set<string>>(new Set());
  /** 细化前快照子节点 id：采用后只对差集（本批新节点）建议关联，旧节点不重复建议 */
  const childrenSnapshotRef = useRef<Set<string>>(new Set());
  const pendingExpandRef = useRef<{ batchId: string; parentId: string } | null>(null);

  // 只用于「将带上 N 份写作规范」这行提示；细化时另从仓储读最新值。
  // 查询未就绪或 N 为 0 时不渲染，界面与没有规范时一致
  const normsQuery = useRepoQuery((repo) => repo.listWritingNorms(novel.id), [novel.id]);
  const planningNorms = normsInScope(normsQuery.data ?? [], 'planning');
  const planningTokens = planningNorms.reduce((sum, norm) => sum + normTokens(norm), 0);
  const fromOldMainline = useFromOldMainline(node.scenarioSource);

  // 只在「关闭 → 打开」时灌入初值，避免后台刷新冲掉正在输入的内容
  const wasOpen = useRef(false);
  const nodeRef = useRef(node);
  nodeRef.current = node;

  useEffect(() => {
    if (open && !wasOpen.current) {
      const current = nodeRef.current;
      setTitle(current.title);
      setSynopsis(current.synopsis);
      setTargetWords(current.targetWords === null ? '' : String(current.targetWords));
      setStatus(current.status);
      setLinked(current.linkedEntryIds);
      setError(undefined);
      setExpand({ phase: 'idle' });
      setExpandExtra('');
      setRemovedMentionIds([]);
      setConfirmReplace(false);
      setLinkPanel(null);
      suppressedPairsRef.current = new Set();
      suppressedEntryIdsRef.current = new Set();
      pendingExpandRef.current = null;
    }
    wasOpen.current = open;
  }, [open]);

  const children = nodes
    .filter((item) => item.parentId === node.id)
    .sort((a, b) => a.order - b.order);
  const canExpand = depth + 1 < MAX_OUTLINE_DEPTH;

  // 注入清单用的选择结果：用当前表单值（含未保存的梗概/额外要求）实时算，
  // 细化时则用落盘后的值重算一次（见 runExpand），两者口径一致
  const ancestors = ancestorsOf(nodes, node.id);
  const mentionTexts = [
    title,
    synopsis,
    expandExtra,
    ...ancestors.slice(-2).map((item) => item.synopsis),
  ];
  const selection = selectPlanningEntries({
    texts: mentionTexts,
    entries: entries.filter((entry) => !removedMentionIds.includes(entry.id)),
    categories,
    linkedEntryIds: linked,
  });
  const linkedCount = selection.related.filter((block) => block.reason === 'linked').length;
  const mentionedCount = selection.related.filter((block) => block.reason === 'mentioned').length;
  const relatedTokens = selection.related.reduce((sum, block) => sum + block.tokens, 0);
  const hasInjectionInfo =
    selection.core.length > 0 || selection.related.length > 0 || selection.dropped.length > 0;

  // replace 影响告知：替换的是「这个节点以下」的整棵子树（含孙节点）
  const subtreeIds = subtreeIdsOf(nodes, node.id);
  const affectedChapters = (chapters ?? []).filter(
    (chapter) => chapter.outlineNodeId !== null && subtreeIds.has(chapter.outlineNodeId),
  );
  const affectedWithContent = affectedChapters.filter((chapter) => chapter.content.trim()).length;

  /**
   * 把当前表单写库并返回落库后的节点；失败返回 undefined（错误已进 state）。
   * save 与 runExpand 共用：细化前必须先落盘，否则「改了梗概没保存就细化」
   * 会拿旧梗概生成（M1 要修的 bug 之一）。
   */
  async function persistDraft(): Promise<OutlineNode | undefined> {
    if (!title.trim()) {
      setError('标题不能为空');
      return undefined;
    }
    setSaving(true);
    setError(undefined);
    try {
      const parsedWords = targetWords.trim() ? Number(targetWords.trim()) : null;
      const saved = await repository.updateOutlineNode(node.id, {
        title: title.trim(),
        synopsis: synopsis.trim(),
        targetWords:
          parsedWords !== null && Number.isFinite(parsedWords) && parsedWords > 0
            ? Math.round(parsedWords)
            : null,
        status,
        linkedEntryIds: linked,
      });
      invalidate();
      return saved;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
      return undefined;
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const saved = await persistDraft();
    if (saved) onClose();
  }

  async function remove() {
    await repository.deleteOutlineNode(node.id);
    invalidate();
    setConfirmDelete(false);
    onClose();
  }

  function replaceImpactMessage(): string {
    const replaced = Math.max(0, subtreeIds.size - 1);
    return [
      `将替换「${node.title}」下现有的 ${replaced} 个子节点（含孙节点）。`,
      `其中约 ${affectedChapters.length} 个已挂章节（${affectedWithContent} 个已有正文）会解除大纲关联；`,
      '正文保留，不会删除，之后可以重新关联。',
      '旧细目会从大纲树删除；采用前可以在提案里对照原细目。',
    ].join('');
  }

  async function runExpand() {
    const saved = await persistDraft();
    if (!saved) return;
    setExpand({ phase: 'running' });
    // 快照必须在请求前取：采用后要按差集只对本批新节点建议关联
    childrenSnapshotRef.current = new Set(children.map((child) => child.id));
    try {
      const linkedEntries = entries.filter((entry) => saved.linkedEntryIds.includes(entry.id));
      // 发请求前读最新规范，避免用到面板打开时的旧数据；读取失败走下面现有的 catch
      const norms = await repository.listWritingNorms(novel.id);
      // 用落盘后的值重算选择：面板上看到的是表单值，这里必须与真正写库的值一致
      const savedAncestors = ancestorsOf(nodes, saved.id);
      const runSelection = selectPlanningEntries({
        texts: [
          saved.title,
          saved.synopsis,
          expandExtra,
          ...savedAncestors.slice(-2).map((item) => item.synopsis),
        ],
        entries: entries.filter((entry) => !removedMentionIds.includes(entry.id)),
        categories,
        linkedEntryIds: saved.linkedEntryIds,
      });
      const threads = (openThreads ?? []).map((thread) => thread.trim()).filter(Boolean);
      const result = await llm.runStructured('outline-expand', {
        schema: OutlineExpandSchema,
        schemaName: 'OutlineChildren',
        system: buildExpandSystemPrompt(novel, style, norms, runSelection.core),
        user: buildExpandUserPrompt({
          node: saved,
          ancestors: savedAncestors,
          siblings: nodes.filter((item) => item.parentId === saved.parentId),
          existingChildren: children,
          // 生产调用只传 related（完整字段）；linkedEntries 是旧调用的回退路径
          linkedEntries,
          count: childCount,
          ...(expandExtra ? { extra: expandExtra } : {}),
          related: runSelection.related,
          ...(threads.length > 0 ? { openThreads: threads } : {}),
          ...(rollingSummary?.trim() ? { rollingSummary } : {}),
          depth,
        }),
      });

      const outlineText = serializeOutlineTree(toChildDrafts(result.data));
      const batchId = newBatchId();
      const specs = fieldSpecsFor('outlineTree');
      const common = {
        novelId: novel.id,
        batchId,
        origin: 'generate' as const,
        target: 'outlineTree' as const,
        label: `细化 · ${saved.title}`,
        specs,
        sourceRef: saved.title,
      };

      // 已有子节点时用 replace（重排这一层），否则 create（追加）
      const proposal =
        children.length > 0
          ? buildReplaceProposal({
              ...common,
              targetId: saved.id,
              // 传完整节点列表 + 挂载点，这样孙节点也会被包含进原值
              current: { outlineText: serializeOutlineTree(buildOutlineDrafts(nodes, saved.id)) },
              payload: { outlineText, parentId: saved.id },
            })
          : buildCreateProposal({ ...common, payload: { outlineText, parentId: saved.id } });

      await repository.createProposals([proposal]);
      pendingExpandRef.current = { batchId, parentId: saved.id };
      invalidate();
      setExpand({ phase: 'review', batchId });
    } catch (cause) {
      setExpand({
        phase: 'error',
        message:
          cause instanceof LlmError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : '细化失败',
      });
    }
  }

  /** 提案有采用结果后：只对本批新子节点建议关联；被拒绝/失败则什么都不做 */
  async function handleExpandSettled() {
    const pending = pendingExpandRef.current;
    pendingExpandRef.current = null;
    setExpand({ phase: 'idle' });
    if (!pending) return;
    try {
      // onSettled 在「全部拒绝」时也会被调用：先确认这一批确实有 accepted
      const accepted = await repository.listProposals(novel.id, {
        status: 'accepted',
        batchId: pending.batchId,
      });
      if (accepted.length === 0) return;

      const [freshNodes, freshEntries] = await Promise.all([
        repository.listOutline(novel.id),
        repository.listEntries(novel.id),
      ]);
      const parent = freshNodes.find((item) => item.id === pending.parentId);
      if (!parent) return;
      const snapshot = childrenSnapshotRef.current;
      const newChildren = freshNodes
        .filter((item) => item.parentId === parent.id && !snapshot.has(item.id))
        .sort((a, b) => a.order - b.order);
      if (newChildren.length === 0) return;

      const suppressed = new Set(suppressedPairsRef.current);
      for (const child of newChildren) {
        for (const entryId of suppressedEntryIdsRef.current) {
          suppressed.add(`${child.id}:${entryId}`);
        }
      }
      const suggestions = suggestOutlineLinks({
        parent,
        children: newChildren,
        entries: freshEntries,
        ...(suppressed.size > 0 ? { suppressed } : {}),
      });
      if (suggestions.length > 0) setLinkPanel(suggestions);
    } catch {
      // 关联建议只是锦上添花：读取失败不打扰作者，links 仍可在抽屉里手改
    }
  }

  async function confirmLinks(result: LinkConfirmResult) {
    const childrenById = new Map((linkPanel ?? []).map(({ child }) => [child.id, child] as const));
    for (const pair of result.suppressed) {
      suppressedPairsRef.current.add(`${pair.childId}:${pair.entryId}`);
      suppressedEntryIdsRef.current.add(pair.entryId);
    }
    // 写库一次批量提交：逐条写一半再刷新会留下「部分节点已关联」的半套状态
    const updates = result.selectedByChild
      .map(({ childId, entryIds }) => {
        const child = childrenById.get(childId);
        if (!child || entryIds.length === 0) return null;
        return {
          id: childId,
          linkedEntryIds: [...new Set([...child.linkedEntryIds, ...entryIds])],
        };
      })
      .filter((update): update is { id: string; linkedEntryIds: string[] } => update !== null);
    setLinkBusy(true);
    try {
      if (updates.length > 0) await repository.updateOutlineLinks(updates);
      invalidate();
      setLinkPanel(null);
    } catch (cause) {
      setExpand({
        phase: 'error',
        message: cause instanceof Error ? cause.message : '关联写入失败',
      });
      setLinkPanel(null);
    } finally {
      setLinkBusy(false);
    }
  }

  /** 全部跳过：不写库，但本次会话内不再建议这些条目 */
  function skipLinks(result: LinkConfirmResult) {
    for (const pair of result.suppressed) {
      suppressedPairsRef.current.add(`${pair.childId}:${pair.entryId}`);
      suppressedEntryIdsRef.current.add(pair.entryId);
    }
    setLinkPanel(null);
  }

  function toggleEntry(entryId: string) {
    // 作者手动勾选优先：之前临时移除过的命中项直接恢复，不再受「已移除」影响
    setRemovedMentionIds((current) => current.filter((id) => id !== entryId));
    setLinked((current) =>
      current.includes(entryId) ? current.filter((id) => id !== entryId) : [...current, entryId],
    );
  }

  function removeMention(entryId: string) {
    setRemovedMentionIds((current) =>
      current.includes(entryId) ? current : [...current, entryId],
    );
  }

  return (
    <>
      <Sheet
        open={open}
        title="大纲节点"
        description={`第 ${depth + 1} 层${children.length > 0 ? ` · 含 ${children.length} 个子节点` : ''}`}
        onClose={onClose}
        footer={
          <Button variant="primary" size="lg" block disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </Button>
        }
      >
        {fromOldMainline ? (
          <p className="text-xs text-accent">来自旧主线：对应的推演步骤已不在当前主线上</p>
        ) : null}

        <TextField
          label="标题"
          value={title}
          error={error}
          onChange={(event) => setTitle(event.target.value)}
        />

        <TextAreaField
          label="梗概"
          rows={4}
          value={synopsis}
          placeholder="这一段要发生什么：谁想做什么、遇到什么阻碍、结果如何"
          onChange={(event) => setSynopsis(event.target.value)}
        />

        {/* 只有叶子节点才是可写的单位；有子节点说明还该继续往下拆 */}
        {onWrite && children.length === 0 ? (
          <Button variant="primary" size="lg" block onClick={() => onWrite(node)}>
            写这一章
          </Button>
        ) : null}

        <TextField
          label="目标字数"
          value={targetWords}
          inputMode="numeric"
          placeholder="留空表示不设定"
          onChange={(event) => setTargetWords(event.target.value)}
        />

        <SegmentedControl
          label="状态"
          value={status}
          options={STATUS_OPTIONS}
          onChange={setStatus}
        />

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-ink-700">关联设定</p>
          <p className="text-xs leading-relaxed text-ink-500">
            写这一节时会默认注入这些条目。已选 {linked.length} 项。
          </p>
          {entries.length === 0 ? (
            <p className="text-xs text-ink-300">知识库里还没有条目</p>
          ) : (
            <div className="flex flex-col gap-2">
              {categories.map((category) => {
                const items = entries.filter((entry) => entry.categoryId === category.id);
                if (items.length === 0) return null;
                return (
                  <div key={category.id} className="flex flex-col gap-1.5">
                    <p className="text-xs text-ink-500">{category.name}</p>
                    <div className="flex flex-wrap gap-2">
                      {items.map((entry) => {
                        const active = linked.includes(entry.id);
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
                );
              })}
            </div>
          )}
        </div>

        {/* AI 细化 */}
        <div className="flex flex-col gap-3 rounded-xl border border-ink-100 p-3">
          <div>
            <h3 className="text-sm font-medium text-ink-700">AI 细化为子节点</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              {canExpand
                ? '按雪花法逐层展开：只拆这一个节点，结果需要确认后才写入。'
                : `已到第 ${MAX_OUTLINE_DEPTH} 层，不能再往下拆分。`}
            </p>
          </div>

          {canExpand ? (
            <>
              <TextField
                label="拆成几个子节点"
                value={String(childCount)}
                inputMode="numeric"
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  setChildCount(Number.isFinite(parsed) ? Math.min(20, Math.max(2, parsed)) : 5);
                }}
              />
              <TextAreaField
                label="额外要求（可选）"
                rows={2}
                value={expandExtra}
                placeholder="例如：第一节要交代背景；最后一节留悬念。"
                onChange={(event) => setExpandExtra(event.target.value)}
              />
              {/* D2：额外要求是一次性输入，不写库；要长期生效必须写进梗概 */}
              <p className="-mt-2 text-xs leading-relaxed text-ink-500">
                额外要求只影响本次细化，不会保存。要让它影响后续章节，请写进梗概。
              </p>
              {/* 注入清单：细化前让作者看到「这次会带上哪些设定」，mentioned 可临时移除（不写库） */}
              {hasInjectionInfo ? (
                <div className="flex flex-col gap-1.5 rounded-lg bg-paper-sunken px-3 py-2">
                  <p className="text-xs font-medium text-ink-700">本次参考设定</p>
                  {selection.core.length > 0 ? (
                    <p className="text-xs leading-relaxed text-ink-500">
                      核心设定 {selection.core.length} 条（始终注入）：
                      {selection.core.map((block) => block.entry.title).join('、')}
                    </p>
                  ) : null}
                  {selection.related.length > 0 ? (
                    <>
                      <p className="text-xs leading-relaxed text-ink-500">
                        {`相关设定：显式 ${linkedCount} 条 + 提到 ${mentionedCount} 条，共${formatTokens(
                          relatedTokens,
                        )}`}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {selection.related.map((block) => (
                          <span
                            key={block.entry.id}
                            className="inline-flex items-center gap-1 rounded-full border border-ink-100 bg-paper-raised px-2 py-1 text-xs text-ink-700"
                          >
                            {block.entry.title}
                            <span className="text-ink-300">{planningSourceLabel(block)}</span>
                            {block.reason === 'mentioned' ? (
                              <button
                                type="button"
                                aria-label={`移除提到的设定：${block.entry.title}`}
                                onClick={() => removeMention(block.entry.id)}
                                className="text-ink-300"
                              >
                                ×
                              </button>
                            ) : null}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {selection.dropped.length > 0 ? (
                    <p className="text-xs leading-relaxed text-ink-300">
                      未注入：
                      {selection.dropped
                        .map(
                          (block) =>
                            `${block.entry.title}（${
                              block.reason === 'linked' ? '显式关联超出篇幅' : '超出篇幅'
                            }）`,
                        )
                        .join('、')}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {planningNorms.length > 0 ? (
                <p className="text-xs text-ink-500">
                  将带上 {planningNorms.length} 份写作规范（{formatTokens(planningTokens)}）
                </p>
              ) : null}
              <Button
                variant="secondary"
                size="md"
                block
                disabled={!llm.configured || expand.phase === 'running' || saving}
                onClick={() => {
                  // 有子节点时 replace 会删掉旧细目并解链章节：先明确告知影响，确认才发请求
                  if (children.length > 0) setConfirmReplace(true);
                  else void runExpand();
                }}
              >
                {expand.phase === 'running' ? '正在细化…' : '细化这一节点'}
              </Button>
              {!llm.configured ? (
                <p className="text-xs text-ink-500">需要先在「设置」里配置模型。</p>
              ) : null}
              {children.length > 0 ? (
                <p className="text-xs text-accent">
                  该节点已有 {children.length} 个子节点，细化结果会替换它们（确认时可看到原内容）。
                </p>
              ) : null}
            </>
          ) : null}

          {expand.phase === 'error' ? (
            <p role="alert" className="rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
              {expand.message}
            </p>
          ) : null}

          {expand.phase === 'review' ? (
            <ProposalInbox
              novelId={novel.id}
              batchId={expand.batchId}
              acceptAllLabel="采用这份细目"
              onSettled={() => void handleExpandSettled()}
            />
          ) : null}
        </div>

        <Button variant="danger" size="md" block onClick={() => setConfirmDelete(true)}>
          删除这个节点
        </Button>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title="删除大纲节点？"
        message={
          children.length > 0
            ? `「${node.title}」及其 ${children.length} 个子节点都会被删除。已写好的章节正文会保留，只是不再关联到大纲。`
            : `「${node.title}」将被删除。已写好的章节正文会保留，只是不再关联到大纲。`
        }
        confirmLabel="删除"
        destructive
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={confirmReplace}
        title="替换现有的子节点？"
        message={replaceImpactMessage()}
        confirmLabel="继续细化"
        onConfirm={() => {
          setConfirmReplace(false);
          void runExpand();
        }}
        onCancel={() => setConfirmReplace(false)}
      />

      <OutlineLinkConfirmSheet
        open={linkPanel !== null}
        suggestions={linkPanel ?? []}
        busy={linkBusy}
        onConfirm={(result) => void confirmLinks(result)}
        onSkip={skipLinks}
        onClose={() => setLinkPanel(null)}
      />
    </>
  );
}
