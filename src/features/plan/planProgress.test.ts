import { describe, expect, it } from 'vitest';
import {
  DailyLogSchema,
  WritingPlanSchema,
  type DailyLog,
  type WritingPlan,
} from '@/domain/schema';
import {
  countDebt,
  countStreak,
  describeTarget,
  formatDayLabel,
  isActiveDay,
  latestPeriodBefore,
  periodOf,
  previousPeriod,
  progressOf,
  recentDays,
  sumIn,
  todayProgress,
  weekStartOf,
  weekdayLabel,
} from './planProgress';

function plan(overrides: Partial<WritingPlan> = {}): WritingPlan {
  return WritingPlanSchema.parse({
    id: 'plan1',
    novelId: 'n1',
    startDate: '2026-03-01',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function log(date: string, words = 0, chaptersCompleted = 0): DailyLog {
  return DailyLogSchema.parse({
    id: `log-${date}`,
    novelId: 'n1',
    date,
    words,
    chaptersCompleted,
    updatedAt: 0,
  });
}

describe('周起始日', () => {
  it('周一为一周之始', () => {
    // 2026-03-02 是周一
    expect(weekStartOf('2026-03-02')).toBe('2026-03-02');
    expect(weekStartOf('2026-03-08')).toBe('2026-03-02');
    // 周日归到上一个周一，而不是开启新的一周
    expect(weekStartOf('2026-03-01')).toBe('2026-02-23');
  });
});

describe('生效日判断', () => {
  it('计划开始前不算', () => {
    expect(isActiveDay(plan(), '2026-02-28')).toBe(false);
    expect(isActiveDay(plan(), '2026-03-01')).toBe(true);
  });

  it('停用的计划一律不算', () => {
    expect(isActiveDay(plan({ enabled: false }), '2026-03-02')).toBe(false);
  });

  it('每日模式按生效星期过滤', () => {
    // 只在周一到周五
    const weekdaysOnly = plan({ activeWeekdays: [1, 2, 3, 4, 5] });
    expect(isActiveDay(weekdaysOnly, '2026-03-02')).toBe(true);
    expect(isActiveDay(weekdaysOnly, '2026-03-07')).toBe(false);
  });

  it('每周模式忽略生效星期', () => {
    const weekly = plan({ mode: 'chaptersPerWeek', target: 3, activeWeekdays: [1] });
    expect(isActiveDay(weekly, '2026-03-07')).toBe(true);
  });
});

describe('周期切分', () => {
  it('每日模式一天一个周期', () => {
    expect(periodOf(plan({ mode: 'wordsPerDay', target: 3000 }), '2026-03-05')).toEqual({
      kind: 'day',
      from: '2026-03-05',
      to: '2026-03-05',
      target: 3000,
      metric: 'words',
    });
  });

  it('每周模式一周一个周期', () => {
    expect(periodOf(plan({ mode: 'chaptersPerWeek', target: 3 }), '2026-03-05')).toEqual({
      kind: 'week',
      from: '2026-03-02',
      to: '2026-03-08',
      target: 3,
      metric: 'chapters',
    });
  });

  it('开始那一周只从开始日算起，避免开局就凭空欠账', () => {
    const weekly = plan({ mode: 'chaptersPerWeek', target: 3, startDate: '2026-03-04' });
    expect(periodOf(weekly, '2026-03-05')).toMatchObject({
      from: '2026-03-04',
      to: '2026-03-08',
    });
  });

  it('非生效日没有周期', () => {
    expect(periodOf(plan({ activeWeekdays: [1] }), '2026-03-07')).toBeUndefined();
  });

  it('上一个每日周期会跳过非生效日', () => {
    const weekdaysOnly = plan({ activeWeekdays: [1, 2, 3, 4, 5] });
    const monday = periodOf(weekdaysOnly, '2026-03-09')!;
    // 周一往前是上周五，而不是周日
    expect(previousPeriod(weekdaysOnly, monday)?.from).toBe('2026-03-06');
  });

  it('上一个每周周期是前一周', () => {
    const weekly = plan({ mode: 'chaptersPerWeek', target: 3, startDate: '2026-01-01' });
    const thisWeek = periodOf(weekly, '2026-03-05')!;
    expect(previousPeriod(weekly, thisWeek)).toMatchObject({
      from: '2026-02-23',
      to: '2026-03-01',
    });
  });

  it('退到开始日之前就没有上一个周期了', () => {
    const p = plan({ startDate: '2026-03-01' });
    const first = periodOf(p, '2026-03-01')!;
    expect(previousPeriod(p, first)).toBeUndefined();
  });

  it('生效星期为空时不死循环，直接找不到', () => {
    expect(latestPeriodBefore(plan({ activeWeekdays: [] }), '2026-06-01')).toBeUndefined();
  });
});

describe('区间合计', () => {
  const logs = [log('2026-03-01', 1000), log('2026-03-02', 2000, 1), log('2026-03-03', 500)];

  it('按字数合计', () => {
    expect(sumIn(logs, '2026-03-01', '2026-03-02', 'words')).toBe(3000);
  });

  it('按章数合计', () => {
    expect(sumIn(logs, '2026-03-01', '2026-03-03', 'chapters')).toBe(1);
  });

  it('区间外的不算', () => {
    expect(sumIn(logs, '2026-03-03', '2026-03-09', 'words')).toBe(500);
  });
});

describe('当期进度', () => {
  it('未达成时给出还差多少', () => {
    const p = plan({ mode: 'wordsPerDay', target: 3000 });
    const progress = todayProgress(p, [log('2026-03-05', 1200)], '2026-03-05')!;
    expect(progress).toMatchObject({ done: 1200, remaining: 1800, met: false });
    expect(progress.ratio).toBeCloseTo(0.4);
  });

  it('超额完成时 remaining 归零、ratio 不超过 1', () => {
    const p = plan({ mode: 'wordsPerDay', target: 3000 });
    const progress = todayProgress(p, [log('2026-03-05', 5000)], '2026-03-05')!;
    expect(progress).toMatchObject({ done: 5000, remaining: 0, met: true, ratio: 1 });
  });

  it('每周模式统计整周产出', () => {
    const weekly = plan({ mode: 'chaptersPerWeek', target: 3, startDate: '2026-01-01' });
    const logs = [log('2026-03-02', 0, 1), log('2026-03-06', 0, 1), log('2026-03-09', 0, 1)];
    // 03-09 已是下一周，不该算进 03-02 那一周
    expect(todayProgress(weekly, logs, '2026-03-08')?.done).toBe(2);
  });

  it('非生效日没有当期进度', () => {
    expect(todayProgress(plan({ activeWeekdays: [1] }), [], '2026-03-07')).toBeUndefined();
  });
});

describe('连续达成', () => {
  it('连续三天达成算三天', () => {
    const p = plan({ mode: 'chaptersPerDay', target: 1 });
    const logs = [log('2026-03-03', 0, 1), log('2026-03-04', 0, 1), log('2026-03-05', 0, 1)];
    expect(countStreak(p, logs, '2026-03-05')).toBe(3);
  });

  it('今天还没写不算断档：周期还没过完', () => {
    const p = plan({ mode: 'chaptersPerDay', target: 1 });
    const logs = [log('2026-03-03', 0, 1), log('2026-03-04', 0, 1)];
    expect(countStreak(p, logs, '2026-03-05')).toBe(2);
  });

  it('中间断掉就只数到断点', () => {
    const p = plan({ mode: 'chaptersPerDay', target: 1 });
    const logs = [log('2026-03-02', 0, 1), log('2026-03-04', 0, 1), log('2026-03-05', 0, 1)];
    expect(countStreak(p, logs, '2026-03-05')).toBe(2);
  });

  it('非生效日不打断连续', () => {
    const weekdaysOnly = plan({
      mode: 'chaptersPerDay',
      target: 1,
      activeWeekdays: [1, 2, 3, 4, 5],
    });
    // 周五、周一各写一章，中间的周末不是生效日
    const logs = [log('2026-03-06', 0, 1), log('2026-03-09', 0, 1)];
    expect(countStreak(weekdaysOnly, logs, '2026-03-09')).toBe(2);
  });

  it('今天不是生效日时从最近的生效周期接着数', () => {
    const weekdaysOnly = plan({
      mode: 'chaptersPerDay',
      target: 1,
      activeWeekdays: [1, 2, 3, 4, 5],
    });
    const logs = [log('2026-03-05', 0, 1), log('2026-03-06', 0, 1)];
    // 03-07 是周六，往前数周五、周四…
    expect(countStreak(weekdaysOnly, logs, '2026-03-07')).toBe(2);
  });

  it('什么都没写就是 0', () => {
    expect(countStreak(plan(), [], '2026-03-05')).toBe(0);
  });

  it('每周模式按周数', () => {
    const weekly = plan({ mode: 'chaptersPerWeek', target: 2, startDate: '2026-02-01' });
    const logs = [log('2026-02-24', 0, 2), log('2026-03-03', 0, 2), log('2026-03-09', 0, 2)];
    expect(countStreak(weekly, logs, '2026-03-09')).toBe(3);
  });
});

describe('欠账', () => {
  it('只算已经过完的周期，不含今天', () => {
    const p = plan({ mode: 'chaptersPerDay', target: 1, startDate: '2026-03-03' });
    // 03-03 缺 1、03-04 缺 1，今天 03-05 还没写但不计入
    expect(countDebt(p, [], '2026-03-05')).toEqual({ amount: 2, periods: 2, metric: 'chapters' });
  });

  it('达成的周期不产生欠账', () => {
    const p = plan({ mode: 'wordsPerDay', target: 3000, startDate: '2026-03-03' });
    const logs = [log('2026-03-03', 3000), log('2026-03-04', 1000)];
    expect(countDebt(p, logs, '2026-03-05')).toEqual({
      amount: 2000,
      periods: 1,
      metric: 'words',
    });
  });

  it('非生效日不产生欠账', () => {
    const weekdaysOnly = plan({
      mode: 'chaptersPerDay',
      target: 1,
      activeWeekdays: [1, 2, 3, 4, 5],
      startDate: '2026-03-06',
    });
    // 03-07、03-08 是周末，只有 03-06 欠一章
    expect(countDebt(weekdaysOnly, [], '2026-03-09')).toMatchObject({ amount: 1, periods: 1 });
  });

  it('只回看有限个周期，不让数字无限膨胀', () => {
    const p = plan({ mode: 'chaptersPerDay', target: 1, startDate: '2020-01-01' });
    expect(countDebt(p, [], '2026-03-05').periods).toBe(30);
  });

  it('计划刚开始、今天就是第一天时没有欠账', () => {
    const p = plan({ mode: 'chaptersPerDay', target: 1, startDate: '2026-03-05' });
    expect(countDebt(p, [], '2026-03-05')).toMatchObject({ amount: 0, periods: 0 });
  });
});

describe('最近产出', () => {
  it('按日期升序补齐空缺的日子', () => {
    const slots = recentDays(plan(), [log('2026-03-05', 1200, 1)], '2026-03-05', 3);
    expect(slots.map((slot) => slot.date)).toEqual(['2026-03-03', '2026-03-04', '2026-03-05']);
    expect(slots[2]).toMatchObject({ words: 1200, chapters: 1, active: true });
    expect(slots[0]).toMatchObject({ words: 0, chapters: 0 });
  });

  it('标出非生效日', () => {
    const slots = recentDays(plan({ activeWeekdays: [1, 2, 3, 4, 5] }), [], '2026-03-08', 2);
    // 03-07 周六、03-08 周日都不是生效日
    expect(slots.every((slot) => !slot.active)).toBe(true);
  });
});

describe('展示文案', () => {
  it('目标描述随模式变化', () => {
    expect(describeTarget(plan({ mode: 'chaptersPerDay', target: 1 }))).toBe('每天 1 章');
    expect(describeTarget(plan({ mode: 'wordsPerDay', target: 3000 }))).toBe('每天 3000 字');
    expect(describeTarget(plan({ mode: 'chaptersPerWeek', target: 3 }))).toBe('每周 3 章');
  });

  it('日期标签优先用今天、昨天', () => {
    expect(formatDayLabel('2026-03-05', '2026-03-05')).toBe('今天');
    expect(formatDayLabel('2026-03-04', '2026-03-05')).toBe('昨天');
    expect(formatDayLabel('2026-03-01', '2026-03-05')).toBe('3 月 1 日');
  });

  it('星期标签', () => {
    expect(weekdayLabel(0)).toBe('日');
    expect(weekdayLabel(6)).toBe('六');
  });
});

describe('周期进度直接调用', () => {
  it('目标为 0 时视为已达成，不做除零', () => {
    const period = {
      kind: 'day' as const,
      from: '2026-03-05',
      to: '2026-03-05',
      target: 0,
      metric: 'words' as const,
    };
    expect(progressOf([], period)).toMatchObject({ met: true, ratio: 1 });
  });
});
