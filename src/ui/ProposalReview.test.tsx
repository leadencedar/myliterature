import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { buildCreateProposal, buildMergeProposal } from '@/proposal/build';
import type { FieldSpec } from '@/proposal/fields';
import { ProposalReview, type EditedProposal } from './ProposalReview';

const SPECS: FieldSpec[] = [
  { path: 'title', label: '名称', kind: 'text' },
  { path: 'aliases', label: '别名', kind: 'list' },
  { path: 'summary', label: '摘要', kind: 'longtext' },
];

const COMMON = {
  novelId: 'n1',
  origin: 'generate' as const,
  target: 'knowledgeEntry' as const,
  specs: SPECS,
};

function createProposal(label: string, payload: Record<string, unknown>) {
  return buildCreateProposal({ ...COMMON, label, payload });
}

function renderReview(
  proposals: ReturnType<typeof createProposal>[],
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

describe('提案预览 · 折叠与展开', () => {
  it('列出全部提案并显示差异摘要', () => {
    renderReview([
      createProposal('人物 · 林越', { title: '林越', summary: '少年剑客' }),
      createProposal('人物 · 沈清', { title: '沈清' }),
    ]);

    expect(screen.getByText('人物 · 林越')).toBeInTheDocument();
    expect(screen.getByText('人物 · 沈清')).toBeInTheDocument();
    expect(screen.getByText('2 项新增')).toBeInTheDocument();
  });

  it('默认展开第一条，其余折叠', () => {
    renderReview([
      createProposal('人物 · 林越', { title: '林越' }),
      createProposal('人物 · 沈清', { title: '沈清' }),
    ]);

    const toggles = screen.getAllByRole('button', { expanded: false });
    expect(screen.getByRole('button', { expanded: true })).toHaveTextContent('人物 · 林越');
    expect(toggles.some((button) => button.textContent?.includes('人物 · 沈清'))).toBe(true);
  });

  it('可以逐条展开与收起', async () => {
    const user = userEvent.setup();
    renderReview([createProposal('人物 · 林越', { title: '林越' })]);

    const toggle = screen.getByRole('button', { expanded: true });
    await user.click(toggle);
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
  });

  it('长列表场景可以要求全部折叠', () => {
    renderReview([createProposal('人物 · 林越', { title: '林越' })], {
      defaultExpandFirst: false,
    });

    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();
  });

  it('展示溯源信息', () => {
    renderReview([
      buildMergeProposal({
        ...COMMON,
        label: '人物 · 林越',
        targetId: 'e1',
        current: { title: '林越' },
        incoming: { summary: '新摘要' },
        sourceRef: '第 3 章',
      }),
    ]);

    expect(screen.getByText('来自 第 3 章')).toBeInTheDocument();
  });
});

describe('提案预览 · 行内编辑', () => {
  it('编辑后采用时传出的是编辑后的值', async () => {
    const user = userEvent.setup();
    const { onAcceptAll } = renderReview([
      createProposal('人物 · 林越', { title: '林越', summary: '少年剑客' }),
    ]);

    const titleInput = screen.getByLabelText('名称');
    await user.clear(titleInput);
    await user.type(titleInput, '林越之');
    await user.click(screen.getByRole('button', { name: /全部采用/u }));

    expect(onAcceptAll).toHaveBeenCalledTimes(1);
    const items = onAcceptAll.mock.calls[0]![0];
    expect(items).toHaveLength(1);
    expect(items[0]!.payload).toMatchObject({ title: '林越之', summary: '少年剑客' });
  });

  it('列表字段按行写回数组', async () => {
    const user = userEvent.setup();
    const { onAcceptAll } = renderReview([
      createProposal('人物 · 林越', { title: '林越', aliases: ['阿越'] }),
    ]);

    const aliasInput = screen.getByLabelText('别名');
    await user.clear(aliasInput);
    await user.type(aliasInput, '阿越{Enter}越哥');
    await user.click(screen.getByRole('button', { name: /全部采用/u }));

    expect(onAcceptAll.mock.calls[0]![0][0]!.payload).toMatchObject({
      aliases: ['阿越', '越哥'],
    });
  });

  it('两边都空的字段不渲染，避免预览被空行淹没', () => {
    renderReview([createProposal('人物 · 林越', { title: '林越' })]);

    expect(screen.getByLabelText('名称')).toBeInTheDocument();
    expect(screen.queryByLabelText('摘要')).not.toBeInTheDocument();
  });
});

describe('提案预览 · 合并类差异', () => {
  const mergeProposal = buildMergeProposal({
    ...COMMON,
    label: '人物 · 林越',
    targetId: 'e1',
    current: { title: '林越', summary: '原摘要' },
    incoming: { summary: '整合后的摘要' },
  });

  it('标出新增与改动', () => {
    renderReview([mergeProposal]);

    expect(screen.getByText('合并')).toBeInTheDocument();
    expect(screen.getByText('改动')).toBeInTheDocument();
  });

  it('可以查看原值', async () => {
    const user = userEvent.setup();
    renderReview([mergeProposal]);

    expect(screen.queryByText('原摘要')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '看原值' }));
    expect(screen.getByText('原摘要')).toBeInTheDocument();
  });

  it('可以把改动过的字段还原成原值', async () => {
    const user = userEvent.setup();
    const { onAcceptAll } = renderReview([mergeProposal]);

    expect(screen.getByLabelText('摘要')).toHaveValue('整合后的摘要');
    await user.click(screen.getByRole('button', { name: '还原「摘要」' }));
    expect(screen.getByLabelText('摘要')).toHaveValue('原摘要');

    await user.click(screen.getByRole('button', { name: /全部采用/u }));
    expect(onAcceptAll.mock.calls[0]![0][0]!.payload).toMatchObject({ summary: '原摘要' });
  });
});

describe('提案预览 · 取舍与批量操作', () => {
  it('忽略某条后不计入采用数量', async () => {
    const user = userEvent.setup();
    const { onAcceptAll } = renderReview([
      createProposal('人物 · 林越', { title: '林越' }),
      createProposal('人物 · 沈清', { title: '沈清' }),
    ]);

    expect(screen.getByRole('button', { name: '全部采用（2）' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '忽略这条' }));

    // 只剩一条时不再显示含义不明的「（1）」
    const acceptButton = screen.getByRole('button', { name: '全部采用' });
    await user.click(acceptButton);

    const items = onAcceptAll.mock.calls[0]![0];
    expect(items.map((item) => item.proposal.label)).toEqual(['人物 · 沈清']);
  });

  it('忽略后可以纳入本批', async () => {
    const user = userEvent.setup();
    renderReview([createProposal('人物 · 林越', { title: '林越' })]);

    await user.click(screen.getByRole('button', { name: '忽略这条' }));
    expect(screen.getByText('已标记为忽略')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '纳入本批' }));
    expect(screen.queryByText('已标记为忽略')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全部采用' })).toBeInTheDocument();
  });

  it('全部忽略时把所有 id 交给回调', async () => {
    const user = userEvent.setup();
    const first = createProposal('甲', { title: '甲' });
    const second = createProposal('乙', { title: '乙' });
    const { onReject } = renderReview([first, second]);

    await user.click(screen.getByRole('button', { name: '全部忽略' }));

    expect(onReject).toHaveBeenCalledWith([first.id, second.id]);
  });

  it('提供重新生成回调时才显示该按钮', async () => {
    const user = userEvent.setup();
    const proposal = createProposal('人物 · 林越', { title: '林越' });
    const onRegenerate = vi.fn();

    renderReview([proposal], { onRegenerate });
    await user.click(screen.getByRole('button', { name: /重新生成/u }));

    expect(onRegenerate).toHaveBeenCalledWith(proposal);
  });

  it('未提供单条采用回调时不显示「采用这条」', () => {
    renderReview([createProposal('人物 · 林越', { title: '林越' })]);
    expect(screen.queryByRole('button', { name: '采用这条' })).not.toBeInTheDocument();
  });

  it('处理中时禁用批量操作', () => {
    renderReview([createProposal('人物 · 林越', { title: '林越' })], { busy: true });

    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '全部忽略' })).toBeDisabled();
  });

  it('没有提案时不渲染任何内容', () => {
    const { container } = render(
      <ProposalReview
        proposals={[]}
        specsFor={() => SPECS}
        onAcceptAll={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('提案预览 · 单条采用', () => {
  it('只把这一条交给回调', async () => {
    const user = userEvent.setup();
    const onAcceptOne = vi.fn<(item: EditedProposal) => void>();
    const first = createProposal('甲', { title: '甲' });
    renderReview([first, createProposal('乙', { title: '乙' })], { onAcceptOne });

    const panel = screen.getByRole('button', { expanded: true }).closest('li');
    await user.click(within(panel!).getByRole('button', { name: '采用这条' }));

    expect(onAcceptOne).toHaveBeenCalledTimes(1);
    expect(onAcceptOne.mock.calls[0]![0].proposal.label).toBe('甲');
  });
});

describe('提案预览 · 初始忽略（归档安全默认 M2.1）', () => {
  it('initiallyIgnoredIds 初始标记为忽略，采用时排除它们', async () => {
    const user = userEvent.setup();
    const merged = buildMergeProposal({
      ...COMMON,
      label: '人物 · 裴照',
      targetId: 'e1',
      current: { title: '裴照' },
      incoming: { summary: '整合后的摘要' },
    });
    const created = createProposal('世界观设定 · 灵潮', { title: '灵潮' });
    const { onAcceptAll } = renderReview([merged, created], {
      initiallyIgnoredIds: [merged.id],
    });

    expect(screen.getByText('已标记为忽略')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '全部采用' }));

    const items = onAcceptAll.mock.calls[0]![0];
    expect(items.map((item) => item.proposal.label)).toEqual(['世界观设定 · 灵潮']);
  });

  it('点「纳入本批」后重新纳入', async () => {
    const user = userEvent.setup();
    const merged = buildMergeProposal({
      ...COMMON,
      label: '人物 · 裴照',
      targetId: 'e1',
      current: { title: '裴照' },
      incoming: { summary: '整合后的摘要' },
    });
    const created = createProposal('世界观设定 · 灵潮', { title: '灵潮' });
    const { onAcceptAll } = renderReview([merged, created], {
      initiallyIgnoredIds: [merged.id],
    });

    await user.click(screen.getByRole('button', { name: '纳入本批' }));
    expect(screen.queryByText('已标记为忽略')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '全部采用（2）' }));

    const labels = onAcceptAll.mock.calls[0]![0].map((item) => item.proposal.label);
    expect(labels).toEqual(['人物 · 裴照', '世界观设定 · 灵潮']);
  });

  it('不传 initiallyIgnoredIds 时默认全选（既有行为不变）', () => {
    const merged = buildMergeProposal({
      ...COMMON,
      label: '人物 · 裴照',
      targetId: 'e1',
      current: { title: '裴照' },
      incoming: { summary: '整合后的摘要' },
    });
    renderReview([merged, createProposal('世界观设定 · 灵潮', { title: '灵潮' })]);

    expect(screen.queryByText('已标记为忽略')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全部采用（2）' })).toBeInTheDocument();
  });
});

describe('提案预览 · 单提案与忽略数回调（M3.1）', () => {
  it('只有一条提案时不再渲染逐条「采用这条」', () => {
    const onAcceptOne = vi.fn<(item: EditedProposal) => void>();
    renderReview([createProposal('人物 · 林越', { title: '林越' })], { onAcceptOne });

    expect(screen.queryByRole('button', { name: '采用这条' })).not.toBeInTheDocument();
    // 底部采用按钮仍在
    expect(screen.getByRole('button', { name: '全部采用' })).toBeInTheDocument();
  });

  it('多条提案时仍保留逐条「采用这条」', async () => {
    const user = userEvent.setup();
    const onAcceptOne = vi.fn<(item: EditedProposal) => void>();
    renderReview(
      [
        createProposal('人物 · 林越', { title: '林越' }),
        createProposal('人物 · 沈清', { title: '沈清' }),
      ],
      { onAcceptOne },
    );

    // 逐条按钮在展开区里：默认只展开第一条，先展开其余
    for (const toggle of screen.getAllByRole('button', { expanded: false })) {
      await user.click(toggle);
    }
    expect(screen.getAllByRole('button', { name: '采用这条' })).toHaveLength(2);
  });

  it('onIgnoredChange 在初始与纳入本批后回传当前忽略数', async () => {
    const user = userEvent.setup();
    const merged = buildMergeProposal({
      ...COMMON,
      label: '人物 · 裴照',
      targetId: 'e1',
      current: { title: '裴照' },
      incoming: { summary: '整合后的摘要' },
    });
    const onIgnoredChange = vi.fn<(count: number) => void>();
    renderReview([merged, createProposal('世界观设定 · 灵潮', { title: '灵潮' })], {
      initiallyIgnoredIds: [merged.id],
      onIgnoredChange,
    });

    // 初始也触发：1 条默认不选
    await waitFor(() => expect(onIgnoredChange).toHaveBeenLastCalledWith(1));
    await user.click(screen.getByRole('button', { name: '纳入本批' }));
    await waitFor(() => expect(onIgnoredChange).toHaveBeenLastCalledWith(0));
  });
});
