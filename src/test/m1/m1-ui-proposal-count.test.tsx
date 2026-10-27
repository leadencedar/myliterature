/**
 * P1 独立验收 · 提案采用按钮计数（task-14）：
 * 单条提案不再显示含义不明的「（1）」，多条提案仍显示数量。
 *
 * 用 ProposalReview 组件直接验证（不依赖提案来源），避免与开发用例重复。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProposalSchema, type Proposal } from '@/domain/schema';
import { ProposalReview } from '@/ui/ProposalReview';

function proposal(index: number, label = `提案 ${index}`): Proposal {
  return ProposalSchema.parse({
    id: `p-${index}`,
    novelId: 'n1',
    origin: 'generate',
    target: 'novel',
    action: 'create',
    label,
    payload: { oneLiner: `第 ${index} 条` },
    diff: [],
    createdAt: index,
  });
}

function renderReview(proposals: Proposal[], acceptAllLabel = '全部采用') {
  const onAcceptAll = vi.fn();
  render(
    <ProposalReview
      proposals={proposals}
      specsFor={() => []}
      onAcceptAll={onAcceptAll}
      onReject={vi.fn()}
      acceptAllLabel={acceptAllLabel}
    />,
  );
  return { onAcceptAll };
}

describe('P1 · 提案采用按钮计数', () => {
  it('单条提案：按钮不带「（1）」', () => {
    renderReview([proposal(1)]);
    expect(screen.getByRole('button', { name: '全部采用' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '全部采用（1）' })).not.toBeInTheDocument();
  });

  it('多条提案：仍显示数量', () => {
    renderReview([proposal(1), proposal(2)]);
    expect(screen.getByRole('button', { name: '全部采用（2）' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '全部采用' })).not.toBeInTheDocument();
  });

  it('自定义 acceptAllLabel（细化「采用这份细目」）同样规则', () => {
    renderReview([proposal(1)], '采用这份细目');
    expect(screen.getByRole('button', { name: '采用这份细目' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '采用这份细目（1）' })).not.toBeInTheDocument();
  });

  it('忽略一条后计数按剩余选中数更新', async () => {
    renderReview([proposal(1), proposal(2)], '采用这份细目');
    // 两条都默认选中：按钮显示（2）
    expect(screen.getByRole('button', { name: '采用这份细目（2）' })).toBeInTheDocument();
    // 默认只展开第一条，忽略它 → 只剩第二条选中，按钮回到不带数字的文案
    screen.getByRole('button', { name: '忽略这条' }).click();
    expect(await screen.findByRole('button', { name: '采用这份细目' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '采用这份细目（2）' })).not.toBeInTheDocument();
  });
});
