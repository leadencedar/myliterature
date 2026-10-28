/**
 * M2.1-S2 独立验收：归档收件箱安全默认（design §2）。
 *
 * 行为契约（task-44 收窄后）：
 * - 归档批次里**只有** target=knowledgeEntry 且 action≠create 的提案默认「已标记为忽略」；
 *   摘要 create/replace、进展 replace 默认选中（每章归档都有进展 replace）。
 * - 「采用本批」只提交选中项；点「恢复」后重新纳入。
 * - safetyNotice 只数上述条目合并/替换，0 条不显示提示。
 * - 不传这些 prop 的 ProposalInbox 行为不变（全部默认选中）。
 *
 * 独立于开发测试：这里直接渲染 ProposalReview（纯 UI）与 ProposalInbox（真仓储 + Provider）。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category, Novel, Proposal } from '@/domain/schema';
import { buildCreateProposal, buildMergeProposal, buildReplaceProposal } from '@/proposal/build';
import { entryFieldSpecs, fieldSpecsFor } from '@/proposal/fields';
import { ProposalInbox } from '@/features/proposals/ProposalInbox';
import { ProposalReview, type EditedProposal } from '@/ui/ProposalReview';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';

// ---------------------------------------------------------------- 纯 UI：ProposalReview

const SPECS = entryFieldSpecs(undefined);

function createEntryProposal(label: string, title: string): Proposal {
  return buildCreateProposal({
    novelId: 'n1',
    batchId: 'b1',
    origin: 'generate',
    target: 'knowledgeEntry',
    label,
    specs: SPECS,
    payload: { title, aliases: [], summary: '', fields: {} },
  });
}

function mergeEntryProposal(label: string, targetId: string): Proposal {
  return buildMergeProposal({
    novelId: 'n1',
    batchId: 'b1',
    origin: 'extract',
    target: 'knowledgeEntry',
    label,
    specs: SPECS,
    targetId,
    current: { title: '旧名', aliases: [], summary: '旧摘要', fields: {} },
    incoming: { title: '旧名', aliases: [], summary: '新摘要', fields: {} },
  });
}

function renderReview(
  proposals: Proposal[],
  overrides: Partial<Parameters<typeof ProposalReview>[0]> = {},
) {
  const onAcceptAll = vi.fn<(items: EditedProposal[]) => void>();
  const onReject = vi.fn<(ids: string[]) => void>();
  render(
    <ProposalReview
      proposals={proposals}
      specsFor={() => SPECS}
      onAcceptAll={onAcceptAll}
      onReject={onReject}
      {...overrides}
    />,
  );
  return { onAcceptAll, onReject };
}

describe('M2.1-S2 · ProposalReview 初始忽略（归档安全默认单元）', () => {
  it('initiallyIgnoredIds：显示「已标记为忽略」，采用时排除；恢复后重新纳入', async () => {
    const user = userEvent.setup();
    const merged = mergeEntryProposal('人物 · 沈砚', 'e1');
    const created = createEntryProposal('人物 · 裴照', '裴照');
    const { onAcceptAll } = renderReview([merged, created], {
      initiallyIgnoredIds: [merged.id],
    });

    expect(screen.getByText('已标记为忽略')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '全部采用' }));
    expect(onAcceptAll.mock.calls[0]![0].map((item) => item.proposal.label)).toEqual([
      '人物 · 裴照',
    ]);

    await user.click(screen.getByRole('button', { name: '纳入本批' }));
    expect(screen.queryByText('已标记为忽略')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '全部采用（2）' }));
    expect(onAcceptAll.mock.calls[1]![0].map((item) => item.proposal.label)).toEqual([
      '人物 · 沈砚',
      '人物 · 裴照',
    ]);
  });

  it('不传 initiallyIgnoredIds：全部默认选中（既有行为不变）', () => {
    const merged = mergeEntryProposal('人物 · 沈砚', 'e1');
    renderReview([merged, createEntryProposal('人物 · 裴照', '裴照')]);

    expect(screen.queryByText('已标记为忽略')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全部采用（2）' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- 真仓储：ProposalInbox / 安全提示

let harness: TestHarness;
let novel: Novel;
let categories: Category[];
let characterCategory: Category;
let existingEntryId: string;
let chapterId: string;
let batchId: string;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '安全默认之书', genre: '仙侠' });
  categories = await harness.repository.listCategories(novel.id);
  characterCategory = categories.find((category) => category.kind === 'character')!;
  batchId = `batch-${crypto.randomUUID()}`;

  const existing = await harness.repository.createEntry(novel.id, {
    categoryId: characterCategory.id,
    title: '沈砚',
    summary: '旧摘要',
    fields: { identity: '旧身份' },
  });
  existingEntryId = existing.id;
  const chapter = await harness.repository.createChapter(novel.id, {
    title: '第 1 章 雪夜',
    content: '雪夜正文。',
  });
  chapterId = chapter.id;

  // 归档批次典型组合：条目 merge（默认应忽略）+ 摘要 create（默认选中）+ 进展 replace（默认选中）
  await harness.repository.createProposals([
    buildMergeProposal({
      novelId: novel.id,
      batchId,
      origin: 'extract',
      target: 'knowledgeEntry',
      label: '人物 · 沈砚',
      specs: entryFieldSpecs(characterCategory),
      targetId: existing.id,
      current: { title: '沈砚', aliases: [], summary: '旧摘要', fields: { identity: '旧身份' } },
      incoming: {
        title: '沈砚',
        aliases: [],
        summary: '整合后的摘要',
        fields: { identity: '新身份' },
      },
      order: 1,
      sourceRef: '第 1 章',
    }),
    buildCreateProposal({
      novelId: novel.id,
      batchId,
      origin: 'extract',
      target: 'chapterSummary',
      label: '第 1 章摘要',
      specs: fieldSpecsFor('chapterSummary'),
      payload: {
        chapterId,
        summary: '本章摘要。',
        keyEvents: [],
        appearingEntryIds: [],
        openThreads: [],
      },
      order: 2,
    }),
    buildReplaceProposal({
      novelId: novel.id,
      batchId,
      origin: 'extract',
      target: 'novel',
      label: '全书进展摘要',
      specs: fieldSpecsFor('novel'),
      targetId: novel.id,
      current: { rollingSummary: novel.rollingSummary },
      payload: { rollingSummary: '截至本章的进展。' },
      order: 3,
    }),
  ]);
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

describe('M2.1-S2 · 归档 ProposalInbox 安全默认', () => {
  it('安全提示只数条目合并；默认忽略该条，摘要/进展默认选中', async () => {
    const user = userEvent.setup();
    harness.renderUI(
      <ProposalInbox
        novelId={novel.id}
        batchId={batchId}
        acceptAllLabel="采用本批"
        defaultExpandFirst={false}
        defaultIgnoreEntryOverwrites
        safetyNotice
      />,
    );

    // M3.1 动态提示：共 3 项，其中 1 条合并默认不选，当前 1 条跳过 → 将写入 2
    expect(
      await screen.findByText(
        '本批共 3 项，其中 1 条对已有条目的合并/替换默认不选；当前还有 1 条跳过（底部「采用本批」只计入将写入的 2 项）。',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText('已标记为忽略')).toHaveLength(1);
    // 3 条提案中默认选中 2 条（摘要 + 进展）
    const adopt = screen.getByRole('button', { name: /采用本批（2）/u });
    await user.click(adopt);

    await waitFor(async () => {
      expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(
        1,
      );
    });
    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(pending[0]).toMatchObject({ target: 'knowledgeEntry', action: 'merge' });
    const entry = (await harness.repository.listEntries(novel.id)).find(
      (item) => item.id === existingEntryId,
    )!;
    expect(entry.fields.identity).toBe('旧身份'); // 旧设定未被覆盖
    // 摘要与进展（默认选中）已写入
    expect(await harness.repository.getSummaryByChapter(chapterId)).toBeTruthy();
    expect((await harness.repository.getNovel(novel.id))!.rollingSummary).toBe('截至本章的进展。');
  });

  it('点「恢复」后条目合并随本批写入，旧设定更新', async () => {
    const user = userEvent.setup();
    harness.renderUI(
      <ProposalInbox
        novelId={novel.id}
        batchId={batchId}
        acceptAllLabel="采用本批"
        defaultExpandFirst={false}
        defaultIgnoreEntryOverwrites
        safetyNotice
      />,
    );

    const restore = await screen.findByRole('button', { name: '纳入本批' });
    await user.click(restore);
    await user.click(screen.getByRole('button', { name: /采用本批（3）/u }));

    await waitFor(async () => {
      expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(
        0,
      );
    });
    const entry = (await harness.repository.listEntries(novel.id)).find(
      (item) => item.id === existingEntryId,
    )!;
    expect(entry.fields.identity).toBe('新身份');
  });

  it('动态提示三态：初始跳过 → 纳入一条后更新 → 全部纳入（将写入 3 项）', async () => {
    const user = userEvent.setup();
    harness.renderUI(
      <ProposalInbox
        novelId={novel.id}
        batchId={batchId}
        acceptAllLabel="采用本批"
        defaultExpandFirst={false}
        defaultIgnoreEntryOverwrites
        safetyNotice
      />,
    );

    expect(
      await screen.findByText(
        '本批共 3 项，其中 1 条对已有条目的合并/替换默认不选；当前还有 1 条跳过（底部「采用本批」只计入将写入的 2 项）。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /采用本批（2）/u })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '纳入本批' }));
    expect(
      screen.getByText('本批共 3 项，其中 1 条对已有条目的合并/替换已全部纳入（将写入 3 项）。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /采用本批（3）/u })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /采用本批（3）/u }));
    await waitFor(async () => {
      expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(
        0,
      );
    });
  });

  it('单提案只有底部采用按钮；多提案仍可逐条采用', async () => {
    const singleBatch = `batch-single-${crypto.randomUUID()}`;
    await harness.repository.createProposals([
      buildCreateProposal({
        novelId: novel.id,
        batchId: singleBatch,
        origin: 'extract',
        target: 'chapterSummary',
        label: '第 2 章摘要',
        specs: fieldSpecsFor('chapterSummary'),
        payload: {
          chapterId,
          summary: '单提案摘要。',
          keyEvents: [],
          appearingEntryIds: [],
          openThreads: [],
        },
      }),
    ]);

    harness.renderUI(
      <ProposalInbox novelId={novel.id} batchId={singleBatch} acceptAllLabel="采用本批" />,
    );
    expect(await screen.findByRole('button', { name: '采用本批' })).toBeInTheDocument();
    // 单提案不再渲染逐条「采用这条」：与底部按钮同义
    expect(screen.queryByRole('button', { name: '采用这条' })).not.toBeInTheDocument();
  });

  it('多提案展开后仍有逐条「采用这条」', async () => {
    harness.renderUI(
      <ProposalInbox novelId={novel.id} batchId={batchId} acceptAllLabel="采用本批" />,
    );

    // 默认展开第一条（多提案），逐条采用入口保留
    expect(await screen.findByRole('button', { name: '采用这条' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /采用本批/u })).toBeInTheDocument();
  });

  it('不传安全默认 props：全部默认选中、无提示（其他收件箱行为不变）', async () => {
    harness.renderUI(
      <ProposalInbox novelId={novel.id} batchId={batchId} acceptAllLabel="采用本批" />,
    );

    expect(await screen.findByRole('button', { name: /采用本批（3）/u })).toBeInTheDocument();
    expect(screen.queryByText(/已默认不选/u)).not.toBeInTheDocument();
    expect(screen.queryByText('已标记为忽略')).not.toBeInTheDocument();
  });

  it('没有条目合并/替换时安全提示不出现（0 条不显示）', async () => {
    await harness.repository.deleteProposal(
      (await harness.repository.listProposals(novel.id, { status: 'pending' })).find(
        (item) => item.target === 'knowledgeEntry',
      )!.id,
    );
    harness.renderUI(
      <ProposalInbox
        novelId={novel.id}
        batchId={batchId}
        acceptAllLabel="采用本批"
        defaultIgnoreEntryOverwrites
        safetyNotice
      />,
    );

    expect(await screen.findByRole('button', { name: /采用本批（2）/u })).toBeInTheDocument();
    expect(screen.queryByText(/合并\/替换，已默认不选/u)).not.toBeInTheDocument();
    expect(screen.queryByText('已标记为忽略')).not.toBeInTheDocument();
  });
});
