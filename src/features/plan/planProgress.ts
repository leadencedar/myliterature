import { addDays, diffDays, parseLocalDate, toLocalDate, weekdayOf } from '@/domain/primitives';
import type { DailyLog, WritingPlan } from '@/domain/schema';

/**
 * 写作计划的进度计算。
 *
 * 全部是纯函数，输入本地日期字符串（`YYYY-MM-DD`）而不是时间戳 ——
 * 「每日一章」关心的是用户所在时区的自然日，用 UTC 时间戳做日界判断，
 * 跨时区或夏令时会把连续天数算错，而连续天数恰恰是唯一有激励作用的数字。
 *
 * 三种模式被统一成「周期」这一个概念：每日模式的周期是一天，
 * 每周模式的周期是一周。看板、连续天数、欠账三处逻辑因此只写一遍。
 */

/** 周一为一周之始：中文语境下「本周」默认从周一算起 */
export function weekStartOf(date: string): string {
  const weekday = weekdayOf(date);
  return addDays(date, -((weekday + 6) % 7));
}

export type PlanMetric = 'chapters' | 'words';

export function planMetric(mode: WritingPlan['mode']): PlanMetric {
  return mode === 'wordsPerDay' ? 'words' : 'chapters';
}

export interface PlanPeriod {
  kind: 'day' | 'week';
  /** 周期起始日（含），已按计划开始日裁剪 */
  from: string;
  /** 周期结束日（含） */
  to: string;
  target: number;
  metric: PlanMetric;
}

/**
 * 某一天是否算在计划内。
 *
 * 每周模式忽略 `activeWeekdays` —— 「每周三章」不在乎哪天写，
 * 再叠一层生效日限制只会让规则变得没人能解释清楚。
 */
export function isActiveDay(plan: WritingPlan, date: string): boolean {
  if (!plan.enabled) return false;
  if (date < plan.startDate) return false;
  if (plan.mode === 'chaptersPerWeek') return true;
  return plan.activeWeekdays.includes(weekdayOf(date));
}

/** 包含该日期的周期；该日期不在计划内则返回 undefined */
export function periodOf(plan: WritingPlan, date: string): PlanPeriod | undefined {
  if (!isActiveDay(plan, date)) return undefined;

  if (plan.mode === 'chaptersPerWeek') {
    const rawFrom = weekStartOf(date);
    return {
      kind: 'week',
      // 计划开始那一周只算开始日之后的产出，否则开局就凭空多出几天欠账
      from: rawFrom < plan.startDate ? plan.startDate : rawFrom,
      to: addDays(rawFrom, 6),
      target: plan.target,
      metric: 'chapters',
    };
  }

  return {
    kind: 'day',
    from: date,
    to: date,
    target: plan.target,
    metric: planMetric(plan.mode),
  };
}

/** 往前找上一个周期；已经退到计划开始日之前则返回 undefined */
export function previousPeriod(plan: WritingPlan, period: PlanPeriod): PlanPeriod | undefined {
  if (period.kind === 'week') {
    const previousStart = addDays(weekStartOf(period.to), -7);
    if (addDays(previousStart, 6) < plan.startDate) return undefined;
    return periodOf(plan, previousStart < plan.startDate ? plan.startDate : previousStart);
  }
  return latestPeriodBefore(plan, period.from);
}

/**
 * 结束日早于给定日期的最近一个周期。
 *
 * 每日模式要跳过非生效日，所以只能逐天回退。上限一年：生效日集合为空
 * （用户把七天全取消了）时不能变成死循环，而找不到就是找不到。
 */
export function latestPeriodBefore(plan: WritingPlan, date: string): PlanPeriod | undefined {
  let cursor = addDays(date, -1);
  for (let step = 0; step < 366; step += 1) {
    if (cursor < plan.startDate) return undefined;
    const period = periodOf(plan, cursor);
    if (period) return period;
    cursor = addDays(cursor, -1);
  }
  return undefined;
}

/** 区间内（含端点）的产出合计 */
export function sumIn(logs: DailyLog[], from: string, to: string, metric: PlanMetric): number {
  return logs
    .filter((log) => log.date >= from && log.date <= to)
    .reduce((sum, log) => sum + (metric === 'words' ? log.words : log.chaptersCompleted), 0);
}

export interface PeriodProgress {
  period: PlanPeriod;
  done: number;
  /** 还差多少，已达成则为 0 */
  remaining: number;
  met: boolean;
  /** 0–1，用于进度条 */
  ratio: number;
}

export function progressOf(logs: DailyLog[], period: PlanPeriod): PeriodProgress {
  const done = sumIn(logs, period.from, period.to, period.metric);
  const met = done >= period.target;
  return {
    period,
    done,
    remaining: met ? 0 : period.target - done,
    met,
    ratio: period.target > 0 ? Math.min(1, done / period.target) : 1,
  };
}

/** 今天（或指定日期）的进度；今天不在计划内则返回 undefined */
export function todayProgress(
  plan: WritingPlan,
  logs: DailyLog[],
  today = toLocalDate(),
): PeriodProgress | undefined {
  const period = periodOf(plan, today);
  return period ? progressOf(logs, period) : undefined;
}

/**
 * 连续达成的周期数。
 *
 * **当前周期未达成不算断档** —— 它还没过完，把「今天还没写」显示成
 * 连续天数归零，只会让人在下午就放弃今天。达成了才计入。
 */
export function countStreak(plan: WritingPlan, logs: DailyLog[], today = toLocalDate()): number {
  let streak = 0;
  let cursor: PlanPeriod | undefined;

  const current = periodOf(plan, today);
  if (current) {
    if (progressOf(logs, current).met) streak += 1;
    cursor = previousPeriod(plan, current);
  } else {
    // 今天不是生效日：从最近一个生效周期接着往前数
    cursor = latestPeriodBefore(plan, today);
  }

  for (let step = 0; step < DEBT_LOOKBACK_PERIODS * 2 && cursor; step += 1) {
    if (!progressOf(logs, cursor).met) break;
    streak += 1;
    cursor = previousPeriod(plan, cursor);
  }
  return streak;
}

/**
 * 欠账只回看最近 30 个周期。
 *
 * 更早的欠账既追不回来，数字还会一直涨 —— 一个永远在变大的负债提示
 * 只会让人关掉这个页面，而不是多写一章。
 */
export const DEBT_LOOKBACK_PERIODS = 30;

export interface PlanDebt {
  /** 欠下的章数或字数合计 */
  amount: number;
  /** 未达成的周期数 */
  periods: number;
  metric: PlanMetric;
}

/** 已经过完的周期里累计的缺口，不含当前周期 */
export function countDebt(plan: WritingPlan, logs: DailyLog[], today = toLocalDate()): PlanDebt {
  const metric = planMetric(plan.mode);
  let amount = 0;
  let periods = 0;

  let cursor = periodOf(plan, today)
    ? previousPeriod(plan, periodOf(plan, today)!)
    : latestPeriodBefore(plan, today);

  for (let step = 0; step < DEBT_LOOKBACK_PERIODS && cursor; step += 1) {
    const progress = progressOf(logs, cursor);
    if (!progress.met) {
      amount += progress.remaining;
      periods += 1;
    }
    cursor = previousPeriod(plan, cursor);
  }

  return { amount, periods, metric };
}

export interface DaySlot {
  date: string;
  words: number;
  chapters: number;
  /** 是否为计划的生效日 */
  active: boolean;
}

/** 最近若干天的产出，用于看板上的迷你柱状图 */
export function recentDays(
  plan: WritingPlan,
  logs: DailyLog[],
  today = toLocalDate(),
  count = 7,
): DaySlot[] {
  const byDate = new Map(logs.map((log) => [log.date, log] as const));
  const slots: DaySlot[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const log = byDate.get(date);
    slots.push({
      date,
      words: log?.words ?? 0,
      chapters: log?.chaptersCompleted ?? 0,
      active: isActiveDay(plan, date),
    });
  }
  return slots;
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 星期的单字标签，0 = 周日 */
export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday] ?? '';
}

/** 「今天」「昨天」或「3 月 5 日」 */
export function formatDayLabel(date: string, today = toLocalDate()): string {
  const delta = diffDays(date, today);
  if (delta === 0) return '今天';
  if (delta === 1) return '昨天';
  const parsed = parseLocalDate(date);
  return `${parsed.getMonth() + 1} 月 ${parsed.getDate()} 日`;
}

/** 看板顶部那句话：说清这个周期要做什么 */
export function describeTarget(plan: WritingPlan): string {
  switch (plan.mode) {
    case 'wordsPerDay':
      return `每天 ${plan.target} 字`;
    case 'chaptersPerWeek':
      return `每周 ${plan.target} 章`;
    default:
      return `每天 ${plan.target} 章`;
  }
}
