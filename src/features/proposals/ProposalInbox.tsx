import { useCallback, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import type { Category, KnowledgeEntry, Proposal } from '@/domain/schema';
import { acceptProposals, rejectProposals, type AcceptResult } from '@/proposal/apply';
import { entryFieldSpecs, fieldSpecsFor, type FieldSpec } from '@/proposal/fields';
import { ProposalReview, type EditedProposal } from '@/ui/ProposalReview';

interface ProposalInboxProps {
  novelId: string;
  /** 只处理某一批次（一次生成的产物）；不传则处理全部待确认项 */
  batchId?: string;
  /** 处理完成后的回调，用于关闭弹层或跳转 */
  onSettled?: () => void;
  acceptAllLabel?: string;
  defaultExpandFirst?: boolean;
  /**
   * 归档批次专用（M2.1）：**对已有知识条目的合并/替换**默认标记为忽略，
   * 避免一次「采用本批」就覆盖作者旧设定。摘要/进展的 replace 不在此列 ——
   * 每章归档都会产生进展 replace，默认忽略会让摘要链反而漏更新。
   * 作者展开后点「恢复」才把被忽略的条目变更纳入本批。
   */
  defaultIgnoreEntryOverwrites?: boolean;
  /** 归档批次专用：显示「含 N 条对已有条目的合并/替换，已默认不选」的安全提示 */
  safetyNotice?: boolean;
}

/**
 * 待确认提案的收件箱。
 *
 * 立项生成、大纲扩写、反向提取共用这一个界面 —— 它们的差别只在于
 * 提案从哪来，确认与落库的逻辑完全一致，没有理由各写一份。
 */
export function ProposalInbox({
  novelId,
  batchId,
  onSettled,
  acceptAllLabel,
  defaultExpandFirst = true,
  defaultIgnoreEntryOverwrites = false,
  safetyNotice = false,
}: ProposalInboxProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AcceptResult | null>(null);

  const { data, loading } = useRepoQuery(
    async (repo) => {
      const [proposals, categories, entries] = await Promise.all([
        repo.listProposals(novelId, { status: 'pending', ...(batchId ? { batchId } : {}) }),
        repo.listCategories(novelId),
        repo.listEntries(novelId, { includeDeleted: true, scope: 'all' }),
      ]);
      return { proposals, categories, entries };
    },
    [novelId, batchId],
  );

  const specsFor = useCallback(
    (proposal: Proposal): FieldSpec[] => {
      if (proposal.target !== 'knowledgeEntry') return fieldSpecsFor(proposal.target);
      return entryFieldSpecs(
        resolveCategory(proposal, data?.categories ?? [], data?.entries ?? []),
      );
    },
    [data?.categories, data?.entries],
  );

  async function handleAcceptAll(items: EditedProposal[]) {
    setBusy(true);
    try {
      // 把行内编辑后的 payload 带上，落库用的是用户确认过的版本
      const outcome = await acceptProposals(
        repository,
        items.map(({ proposal, payload }) => ({ ...proposal, payload })),
      );
      setResult(outcome);
      invalidate();
      if (outcome.failed.length === 0) onSettled?.();
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptOne(item: EditedProposal) {
    await handleAcceptAll([item]);
  }

  async function handleReject(ids: string[]) {
    setBusy(true);
    try {
      await rejectProposals(repository, ids);
      invalidate();
      onSettled?.();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="py-6 text-center text-sm text-ink-300">正在读取待确认内容…</p>;
  }

  const proposals = data?.proposals ?? [];

  if (proposals.length === 0) {
    return result && result.failed.length === 0 ? (
      <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        已采用 {result.accepted.length} 项，全部写入知识库。
      </p>
    ) : null;
  }

  // 归档批次的安全默认：只把「对已有知识条目的合并/替换」作为初始忽略。
  // 摘要/进展的 replace 默认仍选中 —— 每章归档都有进展 replace，若也忽略，
  // 作者得逐章手动恢复，摘要链反而容易漏。计数指初始状态，恢复一条后即变为选中。
  const defaultIgnoredIds = defaultIgnoreEntryOverwrites
    ? proposals
        .filter((proposal) => proposal.target === 'knowledgeEntry' && proposal.action !== 'create')
        .map((proposal) => proposal.id)
    : [];

  return (
    <div className="flex flex-col gap-3">
      {safetyNotice && defaultIgnoredIds.length > 0 ? (
        <p className="rounded-xl bg-accent-soft px-3 py-2.5 text-xs leading-relaxed text-accent">
          本批含 {defaultIgnoredIds.length}{' '}
          条对已有条目的合并/替换，已默认不选；展开核对后点「恢复」才会写入。
        </p>
      ) : null}
      {result && result.failed.length > 0 ? (
        <div role="alert" className="rounded-xl bg-seal-soft px-4 py-3 text-sm text-seal">
          <p>{result.failed.length} 项未能写入，已保留在待确认列表中：</p>
          <ul className="mt-1 list-inside list-disc text-xs">
            {result.failed.map((item) => (
              <li key={item.proposalId}>
                {item.label}：{item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ProposalReview
        proposals={proposals}
        specsFor={specsFor}
        busy={busy}
        onAcceptAll={handleAcceptAll}
        onAcceptOne={handleAcceptOne}
        onReject={handleReject}
        {...(acceptAllLabel ? { acceptAllLabel } : {})}
        defaultExpandFirst={defaultExpandFirst}
        {...(defaultIgnoredIds.length > 0 ? { initiallyIgnoredIds: defaultIgnoredIds } : {})}
      />
    </div>
  );
}

/**
 * 找出知识条目提案对应的分类，以决定有哪些字段。
 * 新建类提案的分类在 payload 里；合并类提案要顺着目标条目回查。
 */
function resolveCategory(
  proposal: Proposal,
  categories: Category[],
  entries: KnowledgeEntry[],
): Category | undefined {
  const payload = proposal.payload;
  const fromPayload =
    payload !== null && typeof payload === 'object'
      ? (payload as { categoryId?: unknown }).categoryId
      : undefined;
  if (typeof fromPayload === 'string') {
    const match = categories.find((category) => category.id === fromPayload);
    if (match) return match;
  }

  if (proposal.targetId) {
    const entry = entries.find((item) => item.id === proposal.targetId);
    if (entry) return categories.find((category) => category.id === entry.categoryId);
  }

  return undefined;
}
