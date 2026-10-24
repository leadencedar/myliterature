import { useState } from 'react';
import { RequireNovel } from '@/app/RequireNovel';
import { useRepoQuery } from '@/data/useRepoQuery';
import { addDays, toLocalDate, weekdayOf } from '@/domain/primitives';
import type { DailyLog, Novel, WritingPlan } from '@/domain/schema';
import { Button } from '@/ui/Button';
import { EmptyState, Page, Section, SectionGrid } from '@/ui/Page';
import { formatWordCount } from '@/ui/format';
import { PlanEditorSheet } from './PlanEditorSheet';
import {
  countDebt,
  countStreak,
  describeTarget,
  formatDayLabel,
  recentDays,
  todayProgress,
  weekdayLabel,
  type DaySlot,
  type PeriodProgress,
} from './planProgress';

/** 看板只回看这么多天的日志，与欠账的回看窗口一致 */
const LOG_WINDOW_DAYS = 45;

export function PlanPage() {
  return <RequireNovel title="计划">{(novel) => <PlanContent novel={novel} />}</RequireNovel>;
}

function PlanContent({ novel }: { novel: Novel }) {
  const today = toLocalDate();
  const { data, loading } = useRepoQuery(
    async (repo) => {
      const [plan, logs] = await Promise.all([
        repo.getPlan(novel.id),
        repo.listDailyLogs(novel.id, { from: addDays(today, -LOG_WINDOW_DAYS), to: today }),
      ]);
      return { plan, logs };
    },
    [novel.id, today],
  );

  const [editorOpen, setEditorOpen] = useState(false);
  const plan = data?.plan;
  const logs = data?.logs ?? [];

  return (
    <Page
      title="计划"
      subtitle={novel.title}
      width="wide"
      action={
        plan ? (
          <Button size="sm" onClick={() => setEditorOpen(true)}>
            调整
          </Button>
        ) : undefined
      }
    >
      {loading ? (
        <p className="py-10 text-center text-sm text-ink-300">加载中…</p>
      ) : !plan ? (
        <EmptyState
          title="还没有写作计划"
          description="定一个能坚持的节奏，比定一个宏大的目标有用。写完的章节会自动记进进度。"
          action={
            <Button variant="primary" size="lg" onClick={() => setEditorOpen(true)}>
              设定写作计划
            </Button>
          }
        />
      ) : (
        <PlanBoard novel={novel} plan={plan} logs={logs} today={today} />
      )}

      <PlanEditorSheet
        open={editorOpen}
        novelId={novel.id}
        plan={plan}
        onClose={() => setEditorOpen(false)}
      />
    </Page>
  );
}

function PlanBoard({
  novel,
  plan,
  logs,
  today,
}: {
  novel: Novel;
  plan: WritingPlan;
  logs: DailyLog[];
  today: string;
}) {
  const progress = todayProgress(plan, logs, today);
  const streak = countStreak(plan, logs, today);
  const debt = countDebt(plan, logs, today);
  const slots = recentDays(plan, logs, today, 7);

  return (
    <>
      {!plan.enabled ? (
        <div className="mb-5 rounded-2xl bg-paper-sunken px-4 py-3 text-sm text-ink-500">
          计划已停用，进度不再统计。历史记录都还在，随时可以在「调整」里重新启用。
        </div>
      ) : null}

      <Section
        title={plan.mode === 'chaptersPerWeek' ? '本周目标' : '今日目标'}
        description={describeTarget(plan)}
      >
        {progress ? (
          <TargetMeter progress={progress} />
        ) : (
          <p className="text-sm text-ink-500">
            {!plan.enabled
              ? '计划停用中。'
              : today < plan.startDate
                ? `计划从 ${formatDayLabel(plan.startDate, today)} 开始。`
                : '今天不是写作日，好好休息。'}
          </p>
        )}
      </Section>

      {/* 这两块都不高、互不依赖，桌面端并排能把首屏信息一次看全 */}
      <SectionGrid>
        <Section title="坚持情况">
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <dt className="text-xs text-ink-500">
                {plan.mode === 'chaptersPerWeek' ? '连续达成' : '连续打卡'}
              </dt>
              <dd className="mt-0.5 text-lg font-semibold text-ink-900 lg:text-2xl">
                {streak} {plan.mode === 'chaptersPerWeek' ? '周' : '天'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">累计欠账</dt>
              <dd className="mt-0.5 text-lg font-semibold text-ink-900 lg:text-2xl">
                {debt.amount === 0
                  ? '没有'
                  : debt.metric === 'words'
                    ? formatWordCount(debt.amount)
                    : `${debt.amount} 章`}
              </dd>
            </div>
          </dl>
          {debt.periods > 0 ? (
            <p className="text-xs leading-relaxed text-ink-500">
              有 {debt.periods} {plan.mode === 'chaptersPerWeek' ? '周' : '天'}没达成。
              欠账只回看最近一段时间 —— 更早的追不回来，盯着它涨也没用。
            </p>
          ) : null}
        </Section>

        <Section title="最近 7 天" description="写完章节时自动记录，不需要手动汇报。">
          <RecentBars slots={slots} today={today} />
        </Section>
      </SectionGrid>

      <Section title="这本书" description={`从 ${plan.startDate} 开始按计划推进`}>
        <p className="text-sm text-ink-700">
          {novel.title}
          {novel.targetWords ? ` · 预计 ${formatWordCount(novel.targetWords)}` : ''}
        </p>
      </Section>
    </>
  );
}

function TargetMeter({ progress }: { progress: PeriodProgress }) {
  const { done, period, remaining, met, ratio } = progress;
  const unit = period.metric === 'words' ? '字' : '章';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-2xl font-semibold tracking-tight text-ink-900">
          {done}
          <span className="ml-1 text-sm font-normal text-ink-500">
            / {period.target} {unit}
          </span>
        </p>
        {met ? (
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
            已达成
          </span>
        ) : (
          <span className="text-xs text-ink-500">
            还差 {remaining} {unit}
          </span>
        )}
      </div>

      <div
        role="progressbar"
        aria-label="当期完成进度"
        aria-valuemin={0}
        aria-valuemax={period.target}
        aria-valuenow={Math.min(done, period.target)}
        aria-valuetext={`${done} / ${period.target} ${unit}`}
        className="h-2.5 overflow-hidden rounded-full bg-paper-sunken"
      >
        <div
          className={met ? 'h-full rounded-full bg-emerald-500' : 'h-full rounded-full bg-ink-900'}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>

      {period.kind === 'week' ? (
        <p className="text-xs text-ink-500">
          本周 {period.from} 至 {period.to}
        </p>
      ) : null}
    </div>
  );
}

function RecentBars({ slots, today }: { slots: DaySlot[]; today: string }) {
  const peak = Math.max(1, ...slots.map((slot) => slot.words));

  return (
    <ul className="flex items-end justify-between gap-1.5">
      {slots.map((slot) => {
        const height = slot.words > 0 ? Math.max(8, Math.round((slot.words / peak) * 72)) : 3;
        return (
          <li key={slot.date} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            {/* 柱子本身不承载语义，数值写在下面的文字里供读屏读取 */}
            <div
              aria-hidden="true"
              style={{ height: `${height}px` }}
              className={[
                'w-full rounded-t',
                slot.words > 0 ? 'bg-ink-900' : 'bg-paper-sunken',
                slot.active ? '' : 'opacity-40',
              ].join(' ')}
            />
            <span className="text-[0.625rem] text-ink-500">
              {weekdayLabel(weekdayOf(slot.date))}
            </span>
            <span className="sr-only">
              {formatDayLabel(slot.date, today)}：{slot.words} 字
              {slot.chapters > 0 ? `，完成 ${slot.chapters} 章` : ''}
              {slot.active ? '' : '（非写作日）'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
