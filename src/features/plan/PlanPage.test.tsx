import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import { addDays, toLocalDate } from '@/domain/primitives';
import type { Novel, WritingPlan } from '@/domain/schema';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { PlanPage } from './PlanPage';

let harness: TestHarness;
let novel: Novel;

const today = toLocalDate();

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
  useActiveNovel.setState({ activeNovelId: novel.id });
});

afterEach(async () => {
  await harness.cleanup();
});

function renderPage() {
  return harness.renderUI(<PlanPage />);
}

async function seedPlan(patch: Partial<WritingPlan> = {}) {
  return harness.repository.upsertPlan(novel.id, {
    mode: 'chaptersPerDay',
    target: 1,
    startDate: addDays(today, -10),
    ...patch,
  });
}

describe('空状态与设定', () => {
  it('没有计划时引导设定', async () => {
    renderPage();
    expect(await screen.findByText('还没有写作计划')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设定写作计划' })).toBeInTheDocument();
  });

  it('保存后立刻显示看板', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '设定写作计划' }));

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /每日 N 字/u }));
    const targetField = within(dialog).getByLabelText('每天多少字');
    await user.clear(targetField);
    await user.type(targetField, '2000');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await screen.findByText('今日目标')).toBeInTheDocument();
    expect(screen.getByText('每天 2000 字')).toBeInTheDocument();

    const plan = await harness.repository.getPlan(novel.id);
    expect(plan).toMatchObject({ mode: 'wordsPerDay', target: 2000, startDate: today });
  });

  it('换模式时目标值换成该模式的常见默认值，不做跨量纲换算', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '设定写作计划' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('每天几章')).toHaveValue(1);

    await user.click(within(dialog).getByRole('radio', { name: /每日 N 字/u }));
    expect(within(dialog).getByLabelText('每天多少字')).toHaveValue(3000);

    await user.click(within(dialog).getByRole('radio', { name: /每周 N 章/u }));
    expect(within(dialog).getByLabelText('每周几章')).toHaveValue(3);
  });

  it('目标非法时拦下', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '设定写作计划' }));

    const dialog = screen.getByRole('dialog');
    const targetField = within(dialog).getByLabelText('每天几章');
    await user.clear(targetField);
    await user.type(targetField, '0');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('目标必须是大于 0 的整数');
    expect(await harness.repository.getPlan(novel.id)).toBeUndefined();
  });

  it('写作日全部取消时拦下 —— 那样计划永远不会生效', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '设定写作计划' }));

    const dialog = screen.getByRole('dialog');
    for (const label of ['日', '一', '二', '三', '四', '五', '六']) {
      await user.click(within(dialog).getByRole('button', { name: label }));
    }
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('至少要选一个写作日');
  });

  it('每周模式不显示写作日选择', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '设定写作计划' }));

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /每周 N 章/u }));

    expect(within(dialog).queryByText('写作日')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/周内哪天写都算/u)).toBeInTheDocument();
  });
});

describe('看板', () => {
  it('展示今日目标、完成量与还差多少', async () => {
    await seedPlan({ mode: 'wordsPerDay', target: 3000 });
    await harness.repository.addDailyProgress(novel.id, today, { words: 1200 });

    renderPage();

    expect(await screen.findByText('今日目标')).toBeInTheDocument();
    const meter = await screen.findByRole('progressbar', { name: '当期完成进度' });
    expect(meter).toHaveAttribute('aria-valuenow', '1200');
    expect(meter).toHaveAttribute('aria-valuemax', '3000');
    expect(screen.getByText('还差 1800 字')).toBeInTheDocument();
  });

  it('达成后显示已达成', async () => {
    await seedPlan({ mode: 'chaptersPerDay', target: 1 });
    await harness.repository.addDailyProgress(novel.id, today, { chaptersCompleted: 1 });

    renderPage();
    expect(await screen.findByText('已达成')).toBeInTheDocument();
  });

  it('连续打卡天数不因今天还没写而归零', async () => {
    await seedPlan({ mode: 'chaptersPerDay', target: 1 });
    await harness.repository.addDailyProgress(novel.id, addDays(today, -1), {
      chaptersCompleted: 1,
    });
    await harness.repository.addDailyProgress(novel.id, addDays(today, -2), {
      chaptersCompleted: 1,
    });

    renderPage();
    expect(await screen.findByText('连续打卡')).toBeInTheDocument();
    expect(screen.getByText('2 天')).toBeInTheDocument();
  });

  it('累计欠账与未达成天数', async () => {
    await seedPlan({ mode: 'chaptersPerDay', target: 1, startDate: addDays(today, -3) });

    renderPage();
    expect(await screen.findByText('累计欠账')).toBeInTheDocument();
    // 前三天都没写，今天不计入
    expect(screen.getByText('3 章')).toBeInTheDocument();
    expect(screen.getByText(/有 3 天没达成/u)).toBeInTheDocument();
  });

  it('没有欠账时明确显示「没有」', async () => {
    await seedPlan({ mode: 'chaptersPerDay', target: 1, startDate: today });
    renderPage();
    expect(await screen.findByText('没有')).toBeInTheDocument();
  });

  it('每周模式显示本周目标与周区间', async () => {
    await seedPlan({ mode: 'chaptersPerWeek', target: 3, startDate: addDays(today, -30) });
    await harness.repository.addDailyProgress(novel.id, today, { chaptersCompleted: 1 });

    renderPage();
    expect(await screen.findByText('本周目标')).toBeInTheDocument();
    expect(screen.getByText('每周 3 章')).toBeInTheDocument();
    expect(screen.getByText('连续达成')).toBeInTheDocument();
    expect(screen.getByText(/^本周 \d{4}-\d{2}-\d{2} 至 \d{4}-\d{2}-\d{2}$/u)).toBeInTheDocument();
  });

  it('非写作日给出休息提示而不是零进度', async () => {
    // 把今天排除在写作日之外
    const todayWeekday = new Date(`${today}T00:00:00`).getDay();
    await seedPlan({
      activeWeekdays: [0, 1, 2, 3, 4, 5, 6].filter((weekday) => weekday !== todayWeekday),
    });

    renderPage();
    expect(await screen.findByText('今天不是写作日，好好休息。')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('计划未开始时说明从哪天开始', async () => {
    await seedPlan({ startDate: addDays(today, 3) });
    renderPage();
    expect(await screen.findByText(new RegExp(`计划从 .+ 开始`, 'u'))).toBeInTheDocument();
  });

  it('停用的计划给出提示且不统计', async () => {
    await seedPlan({ enabled: false });
    renderPage();
    expect(await screen.findByText(/计划已停用，进度不再统计/u)).toBeInTheDocument();
    expect(screen.getByText('计划停用中。')).toBeInTheDocument();
  });

  it('最近 7 天的产出可被读屏读到', async () => {
    await seedPlan({ mode: 'wordsPerDay', target: 3000 });
    await harness.repository.addDailyProgress(novel.id, addDays(today, -1), { words: 2500 });

    renderPage();
    await screen.findByText('最近 7 天');
    expect(screen.getByText(/昨天：2500 字/u)).toBeInTheDocument();
    expect(screen.getByText(/今天：0 字/u)).toBeInTheDocument();
  });
});

describe('调整计划', () => {
  it('预填现有配置并可改写', async () => {
    await seedPlan({ mode: 'wordsPerDay', target: 3000 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '调整' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('每天多少字')).toHaveValue(3000);

    const targetField = within(dialog).getByLabelText('每天多少字');
    await user.clear(targetField);
    await user.type(targetField, '4000');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      expect((await harness.repository.getPlan(novel.id))?.target).toBe(4000);
    });
    expect(await screen.findByText('每天 4000 字')).toBeInTheDocument();
  });

  it('停用后再启用，历史记录不丢', async () => {
    await seedPlan({ mode: 'chaptersPerDay', target: 1 });
    await harness.repository.addDailyProgress(novel.id, addDays(today, -1), {
      chaptersCompleted: 1,
    });

    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '调整' }));
    await user.click(within(screen.getByRole('dialog')).getByLabelText('启用计划'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/计划已停用/u)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '调整' }));
    await user.click(within(screen.getByRole('dialog')).getByLabelText('启用计划'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.queryByText(/计划已停用/u)).not.toBeInTheDocument();
    });
    expect(await screen.findByText('1 天')).toBeInTheDocument();
  });
});
