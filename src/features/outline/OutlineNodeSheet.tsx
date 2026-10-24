import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { formatTokens } from '@/context/tokens';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import type { Category, KnowledgeEntry, Novel, OutlineNode, StyleProfile } from '@/domain/schema';
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
import {
  OutlineExpandSchema,
  ancestorsOf,
  buildExpandSystemPrompt,
  buildExpandUserPrompt,
  toChildDrafts,
} from './outlineExpand';
import { MAX_OUTLINE_DEPTH, OUTLINE_STATUS_LABELS } from './outlineTree';

const STATUS_OPTIONS = (Object.keys(OUTLINE_STATUS_LABELS) as OutlineNode['status'][]).map(
  (value) => ({ value, label: OUTLINE_STATUS_LABELS[value] }),
);

type ExpandState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'review'; batchId: string }
  | { phase: 'error'; message: string };

export function OutlineNodeSheet({
  open,
  novel,
  style,
  node,
  nodes,
  entries,
  categories,
  depth,
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
    }
    wasOpen.current = open;
  }, [open]);

  const children = nodes
    .filter((item) => item.parentId === node.id)
    .sort((a, b) => a.order - b.order);
  const canExpand = depth + 1 < MAX_OUTLINE_DEPTH;

  async function save() {
    if (!title.trim()) {
      setError('标题不能为空');
      return;
    }
    setSaving(true);
    try {
      const parsedWords = targetWords.trim() ? Number(targetWords.trim()) : null;
      await repository.updateOutlineNode(node.id, {
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
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await repository.deleteOutlineNode(node.id);
    invalidate();
    setConfirmDelete(false);
    onClose();
  }

  async function runExpand() {
    setExpand({ phase: 'running' });
    try {
      const linkedEntries = entries.filter((entry) => linked.includes(entry.id));
      // 发请求前读最新规范，避免用到面板打开时的旧数据；读取失败走下面现有的 catch
      const norms = await repository.listWritingNorms(novel.id);
      const result = await llm.runStructured('outline-expand', {
        schema: OutlineExpandSchema,
        schemaName: 'OutlineChildren',
        system: buildExpandSystemPrompt(novel, style, norms),
        user: buildExpandUserPrompt({
          node,
          ancestors: ancestorsOf(nodes, node.id),
          siblings: nodes.filter((item) => item.parentId === node.parentId),
          existingChildren: children,
          linkedEntries,
          count: childCount,
          ...(expandExtra ? { extra: expandExtra } : {}),
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
        label: `细化 · ${node.title}`,
        specs,
        sourceRef: node.title,
      };

      // 已有子节点时用 replace（重排这一层），否则 create（追加）
      const proposal =
        children.length > 0
          ? buildReplaceProposal({
              ...common,
              targetId: node.id,
              // 传完整节点列表 + 挂载点，这样孙节点也会被包含进原值
              current: { outlineText: serializeOutlineTree(buildOutlineDrafts(nodes, node.id)) },
              payload: { outlineText, parentId: node.id },
            })
          : buildCreateProposal({ ...common, payload: { outlineText, parentId: node.id } });

      await repository.createProposals([proposal]);
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

  function toggleEntry(entryId: string) {
    setLinked((current) =>
      current.includes(entryId) ? current.filter((id) => id !== entryId) : [...current, entryId],
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
              {planningNorms.length > 0 ? (
                <p className="text-xs text-ink-500">
                  将带上 {planningNorms.length} 份写作规范（{formatTokens(planningTokens)}）
                </p>
              ) : null}
              <Button
                variant="secondary"
                size="md"
                block
                disabled={!llm.configured || expand.phase === 'running'}
                onClick={runExpand}
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
              onSettled={() => setExpand({ phase: 'idle' })}
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
    </>
  );
}
