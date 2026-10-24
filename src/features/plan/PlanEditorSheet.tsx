import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import { toLocalDate } from '@/domain/primitives';
import type { WritingPlan } from '@/domain/schema';
import { Button } from '@/ui/Button';
import { ChipGroup, RadioList, Toggle } from '@/ui/Controls';
import { TextField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
import { weekdayLabel } from './planProgress';

const MODE_OPTIONS: { value: WritingPlan['mode']; label: string; description: string }[] = [
  {
    value: 'chaptersPerDay',
    label: '每日 N 章',
    description: '最常见的连载节奏。章数比字数更能体现「今天推进了剧情」。',
  },
  {
    value: 'wordsPerDay',
    label: '每日 N 字',
    description: '适合长章节或不按章推进的写法，按字数更好衡量。',
  },
  {
    value: 'chaptersPerWeek',
    label: '每周 N 章',
    description: '按周结算，某天没写可以在周内补回来，压力更小。',
  },
];

const TARGET_LABELS: Record<WritingPlan['mode'], string> = {
  chaptersPerDay: '每天几章',
  wordsPerDay: '每天多少字',
  chaptersPerWeek: '每周几章',
};

const DEFAULT_TARGETS: Record<WritingPlan['mode'], number> = {
  chaptersPerDay: 1,
  wordsPerDay: 3000,
  chaptersPerWeek: 3,
};

interface PlanEditorSheetProps {
  open: boolean;
  novelId: string;
  plan: WritingPlan | undefined;
  onClose: () => void;
}

/**
 * 计划设定。
 *
 * 一本书一份计划（仓储层用 `&novelId` 唯一索引保证），所以这里不做列表，
 * 只有「设定 / 调整」一种形态。
 */
export function PlanEditorSheet({ open, novelId, plan, onClose }: PlanEditorSheetProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();

  const [mode, setMode] = useState<WritingPlan['mode']>('chaptersPerDay');
  const [target, setTarget] = useState('1');
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [startDate, setStartDate] = useState(toLocalDate());
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // 用 ref 读取最新的 plan：它会随每次数据刷新换成新对象，
  // 若列入 effect 依赖，一次后台刷新就会把用户正在改的值冲回旧值
  const planRef = useRef(plan);
  planRef.current = plan;

  // 只在「关闭 → 打开」时灌入初值
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const current = planRef.current;
      setMode(current?.mode ?? 'chaptersPerDay');
      setTarget(String(current?.target ?? DEFAULT_TARGETS.chaptersPerDay));
      setWeekdays(current?.activeWeekdays ?? [0, 1, 2, 3, 4, 5, 6]);
      setStartDate(current?.startDate ?? toLocalDate());
      setEnabled(current?.enabled ?? true);
      setError('');
    }
    wasOpen.current = open;
  }, [open]);

  const weekly = mode === 'chaptersPerWeek';

  function changeMode(next: WritingPlan['mode']) {
    setMode(next);
    // 换算不同量纲的目标值没有意义（1 章 ≠ 1 字），直接给该模式的常见默认值
    setTarget(String(DEFAULT_TARGETS[next]));
  }

  async function save() {
    const parsed = Number(target.trim());
    if (!Number.isFinite(parsed) || parsed < 1) {
      setError('目标必须是大于 0 的整数');
      return;
    }
    if (!weekly && weekdays.length === 0) {
      setError('至少要选一个写作日，否则计划永远不会生效');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(startDate)) {
      setError('请选择开始日期');
      return;
    }

    setSaving(true);
    try {
      await repository.upsertPlan(novelId, {
        mode,
        target: Math.round(parsed),
        activeWeekdays: weekly ? [0, 1, 2, 3, 4, 5, 6] : [...weekdays].sort((a, b) => a - b),
        startDate,
        enabled,
      });
      invalidate();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      title={plan ? '调整计划' : '设定写作计划'}
      description="计划只用于本地提醒与进度统计，不会推送通知。"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="lg" block onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" block disabled={saving} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <RadioList label="计划模式" value={mode} options={MODE_OPTIONS} onChange={changeMode} />

      <TextField
        label={TARGET_LABELS[mode]}
        type="number"
        inputMode="numeric"
        min={1}
        value={target}
        onChange={(event) => setTarget(event.target.value)}
      />

      {!weekly ? (
        <ChipGroup
          label="写作日"
          hint="没被选中的日子不计入进度，也不会产生欠账。"
          options={[0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            value: String(weekday),
            label: weekdayLabel(weekday),
          }))}
          selected={weekdays.map(String)}
          onToggle={(value) => {
            const weekday = Number(value);
            setWeekdays((prev) =>
              prev.includes(weekday) ? prev.filter((item) => item !== weekday) : [...prev, weekday],
            );
          }}
        />
      ) : (
        <p className="text-xs leading-relaxed text-ink-500">
          每周模式按整周结算，不区分写作日 —— 周内哪天写都算。
        </p>
      )}

      <TextField
        label="开始日期"
        type="date"
        value={startDate}
        hint="开始日之前不统计，也不会倒算欠账。"
        onChange={(event) => setStartDate(event.target.value)}
      />

      <Toggle
        label="启用计划"
        description="暂时不想被计划催的时候关掉它，历史记录会保留。"
        checked={enabled}
        onChange={setEnabled}
      />

      {error ? (
        <p role="alert" className="text-xs text-seal">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
