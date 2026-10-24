import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import { newId } from '@/domain/primitives';
import type { Novel, Scenario, ScenarioGoalKind } from '@/domain/schema';
import {
  SCENARIO_LIMITS,
  clampExpectedSteps,
  validateScenarioSetup,
  type ScenarioSetupDraft,
} from '@/domain/scenario';
import { Button } from '@/ui/Button';
import { SegmentedControl } from '@/ui/Controls';
import { SelectField, TextAreaField, TextField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
import { GOAL_KIND_LABELS } from './scenarioPrompt';
import { errorText } from './scenarioView';

interface ScenarioSetupSheetProps {
  open: boolean;
  novel: Novel;
  /** 传入为编辑开局设定，不传为新建 */
  scenario?: Scenario | undefined;
  onClose: () => void;
  /** 保存成功；created = 这是新建的推演 */
  onSaved: (scenario: Scenario, created: boolean) => void;
}

interface GoalRow {
  id: string;
  kind: ScenarioGoalKind;
  description: string;
}

interface MilestoneRow {
  id: string;
  description: string;
}

/** 新建主角时填的三栏（D4.1：身份 / 性格 / 目标与动机选填）；按人物模板里的键取，模板改过名就用模板的中文名 */
const OC_FIELD_KEYS = ['identity', 'personality', 'goal'] as const;
const OC_FIELD_FALLBACK: Record<(typeof OC_FIELD_KEYS)[number], string> = {
  identity: '身份',
  personality: '性格',
  goal: '目标与动机',
};

const GOAL_KIND_OPTIONS = (['good', 'bad', 'neutral'] as const).map((kind) => ({
  value: kind,
  label: GOAL_KIND_LABELS[kind],
}));

function move<T>(list: T[], index: number, offset: -1 | 1): T[] {
  const target = index + offset;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/**
 * 开局设定（设计 D4.1 / §8.2）。
 *
 * 新建时主角二选一：已有人物，或新建一位 —— 新建的人物与推演同一事务落库、作用范围限定到这个推演、不走提案
 * （作者自己填的字）。编辑时主角与起点只读：它们是根节点的前提，改了等于整棵树建立在另一套前提上。
 * 目标与里程碑用按钮调序，不拖拽（移动端拖拽与滚动手势冲突，读屏也用不了）。
 */
export function ScenarioSetupSheet({
  open,
  novel,
  scenario,
  onClose,
  onSaved,
}: ScenarioSetupSheetProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const editing = scenario !== undefined;

  const { data } = useRepoQuery(
    async (repo) => {
      const [categories, entries] = await Promise.all([
        repo.listCategories(novel.id),
        // 编辑时要显示主角名：主角可能是限定条目，所以取全部
        repo.listEntries(novel.id, { scope: 'all', includeDeleted: true }),
      ]);
      return { categories, entries };
    },
    [novel.id],
  );
  const characterCategory = data?.categories.find((category) => category.kind === 'character');
  // 可选的已有人物：人物分类里、未删除的通用条目（限定到别的推演的人物不在这个推演里存在）
  const characters = (data?.entries ?? []).filter(
    (entry) =>
      entry.categoryId === characterCategory?.id &&
      entry.deletedAt === null &&
      (entry.scope ?? { kind: 'universal' }).kind === 'universal',
  );
  const ocFields = OC_FIELD_KEYS.map((key) => ({
    key,
    label:
      characterCategory?.fieldTemplate.find((field) => field.key === key)?.label ??
      OC_FIELD_FALLBACK[key],
  }));

  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [entryId, setEntryId] = useState('');
  const [ocTitle, setOcTitle] = useState('');
  const [ocValues, setOcValues] = useState<Record<string, string>>({});
  const [time, setTime] = useState('');
  const [place, setPlace] = useState('');
  const [situation, setSituation] = useState('');
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  const [tone, setTone] = useState('');
  const [steps, setSteps] = useState(String(SCENARIO_LIMITS.defaultSteps));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  // 只在「关闭 → 打开」时重置，外部数据刷新不冲掉正在填的内容
  const wasOpen = useRef(false);
  const seedRef = useRef(scenario);
  seedRef.current = scenario;
  useEffect(() => {
    if (open && !wasOpen.current) {
      const seed = seedRef.current;
      setTitle(seed?.title ?? '');
      setMode('new');
      setEntryId('');
      setOcTitle('');
      setOcValues({});
      setTime(seed?.setup.start.time ?? '');
      setPlace(seed?.setup.start.place ?? '');
      setSituation(seed?.setup.start.situation ?? '');
      setGoals(
        seed
          ? seed.setup.goals.map((goal) => ({ ...goal }))
          : [{ id: newId(), kind: 'good', description: '' }],
      );
      setMilestones(seed ? seed.setup.milestones.map((milestone) => ({ ...milestone })) : []);
      setTone(seed?.setup.tone ?? '');
      setSteps(String(seed?.setup.expectedSteps ?? SCENARIO_LIMITS.defaultSteps));
      setError(undefined);
    }
    wasOpen.current = open;
  }, [open]);

  const castEntry = scenario
    ? data?.entries.find((entry) => entry.id === scenario.setup.cast[0]?.entryId)
    : undefined;

  function draft(): ScenarioSetupDraft {
    return {
      title,
      protagonist: scenario
        ? { kind: 'existing', entryId: scenario.setup.cast[0]?.entryId ?? '' }
        : mode === 'existing'
          ? { kind: 'existing', entryId }
          : {
              kind: 'new',
              title: ocTitle,
              fields: ocFields.map((field) => ({
                label: field.label,
                value: ocValues[field.key] ?? '',
              })),
            },
      start: { time, place, situation },
      goals,
      milestones,
      tone,
    };
  }

  async function save() {
    const invalid = validateScenarioSetup(draft());
    if (invalid) {
      setError(invalid);
      return;
    }
    const expectedSteps = clampExpectedSteps(Number(steps));
    const goalList = goals.map((goal) => ({
      id: goal.id,
      kind: goal.kind,
      description: goal.description.trim(),
    }));
    const milestoneList = milestones.map((milestone) => ({
      id: milestone.id,
      description: milestone.description.trim(),
    }));
    setSaving(true);
    setError(undefined);
    try {
      if (scenario) {
        const saved = await repository.updateScenario(scenario.id, {
          title: title.trim(),
          setup: { goals: goalList, milestones: milestoneList, tone: tone.trim(), expectedSteps },
        });
        invalidate();
        onSaved(saved, false);
        return;
      }
      if (mode === 'new' && !characterCategory) {
        setError('这部作品没有「人物」分类，没法新建主角');
        return;
      }
      const fields: Record<string, string> = {};
      for (const field of ocFields) {
        const value = (ocValues[field.key] ?? '').trim();
        if (value) fields[field.key] = value;
      }
      const created = await repository.createScenario(novel.id, {
        title: title.trim(),
        setup: {
          // 新建主角时 cast 由仓储按新条目生成，这里的占位不会被用到
          cast: [{ entryId: mode === 'existing' ? entryId : '' }],
          start: { time: time.trim(), place: place.trim(), situation: situation.trim() },
          goals: goalList,
          milestones: milestoneList,
          tone: tone.trim(),
          expectedSteps,
        },
        ...(mode === 'new'
          ? { newOc: { categoryId: characterCategory!.id, title: ocTitle.trim(), fields } }
          : {}),
      });
      invalidate();
      onSaved(created, true);
    } catch (cause) {
      setError(errorText(cause, '保存失败').message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      title={editing ? '开局设定' : '开始一局互动推演'}
      description={
        editing
          ? '改目标、里程碑、基调与预计步数只影响之后的步骤，已走过的不会重新生成。'
          : '把主角放进这个世界，一步步选择走向结局，再沉淀成大纲。'
      }
      onClose={onClose}
      footer={
        <Button variant="primary" size="lg" block disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : editing ? '保存' : '开始推演'}
        </Button>
      }
    >
      <TextField
        label="推演名称"
        value={title}
        placeholder="例如：雾中渡"
        onChange={(event) => setTitle(event.target.value)}
      />

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-ink-700">主角</legend>
        {scenario ? (
          <div className="rounded-xl bg-paper-sunken px-3 py-2.5 text-sm text-ink-700">
            <p className="font-medium text-ink-900">{castEntry?.title ?? '（主角条目已不存在）'}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              开局之后不能改主角和起点；想换就新建一个推演。
            </p>
          </div>
        ) : (
          <>
            <SegmentedControl
              label="主角从哪来"
              value={mode}
              options={[
                {
                  value: 'new',
                  label: '新建主角',
                  description: '只属于这个推演的人物，在知识库里可见、可编辑。',
                },
                { value: 'existing', label: '选已有人物', description: '从知识库的人物里选一位。' },
              ]}
              onChange={setMode}
            />
            {mode === 'existing' ? (
              characters.length > 0 ? (
                <SelectField
                  label="选择人物"
                  value={entryId}
                  options={[
                    { value: '', label: '请选择' },
                    ...characters.map((entry) => ({ value: entry.id, label: entry.title })),
                  ]}
                  onChange={(event) =>
                    setEntryId((event.target as unknown as HTMLSelectElement).value)
                  }
                />
              ) : (
                <p className="text-sm text-ink-500">知识库里还没有人物，可以新建一位主角。</p>
              )
            ) : (
              <>
                <TextField
                  label="主角名称"
                  value={ocTitle}
                  onChange={(event) => setOcTitle(event.target.value)}
                />
                {ocFields.map((field) => (
                  <TextAreaField
                    key={field.key}
                    label={field.label}
                    rows={2}
                    value={ocValues[field.key] ?? ''}
                    onChange={(event) =>
                      setOcValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                ))}
              </>
            )}
          </>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-ink-700">起点</legend>
        {scenario ? (
          <div className="rounded-xl bg-paper-sunken px-3 py-2.5 text-sm leading-relaxed text-ink-700">
            {[scenario.setup.start.time, scenario.setup.start.place]
              .filter((text) => text.trim())
              .join(' · ')}
            <p className="whitespace-pre-wrap">{scenario.setup.start.situation}</p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="时间"
                value={time}
                placeholder="选填"
                onChange={(event) => setTime(event.target.value)}
              />
              <TextField
                label="地点"
                value={place}
                placeholder="选填"
                onChange={(event) => setPlace(event.target.value)}
              />
            </div>
            <TextAreaField
              label="处境"
              rows={3}
              value={situation}
              hint={`${situation.trim().length} / ${SCENARIO_LIMITS.situation}`}
              placeholder="主角此刻在哪、面对什么"
              onChange={(event) => setSituation(event.target.value)}
            />
          </>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-ink-700">结局目标</legend>
        <p className="text-xs leading-relaxed text-ink-500">
          至少一个。可以设坏结局：走到坏结局之后仍能回到任何一步重新选择。
        </p>
        {goals.map((goal, index) => (
          <div key={goal.id} className="flex flex-col gap-2 rounded-xl border border-ink-100 p-3">
            <SelectField
              label={`目标 ${index + 1} 的类型`}
              value={goal.kind}
              options={GOAL_KIND_OPTIONS}
              onChange={(event) => {
                const kind = (event.target as unknown as HTMLSelectElement)
                  .value as ScenarioGoalKind;
                setGoals((list) =>
                  list.map((item) => (item.id === goal.id ? { ...item, kind } : item)),
                );
              }}
            />
            <TextField
              label={`目标 ${index + 1}`}
              value={goal.description}
              onChange={(event) => {
                const description = event.target.value;
                setGoals((list) =>
                  list.map((item) => (item.id === goal.id ? { ...item, description } : item)),
                );
              }}
            />
            <RowActions
              noun={`目标 ${index + 1}`}
              first={index === 0}
              last={index === goals.length - 1}
              onUp={() => setGoals((list) => move(list, index, -1))}
              onDown={() => setGoals((list) => move(list, index, 1))}
              onRemove={() => setGoals((list) => list.filter((item) => item.id !== goal.id))}
            />
          </div>
        ))}
        {goals.length < SCENARIO_LIMITS.goals ? (
          <Button
            size="sm"
            onClick={() =>
              setGoals((list) => [...list, { id: newId(), kind: 'good', description: '' }])
            }
          >
            添加结局目标
          </Button>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-ink-700">里程碑</legend>
        <p className="text-xs leading-relaxed text-ink-500">
          选填，按顺序。导演会在接下来几步里让下一个里程碑成为可能，但不替主角完成。
        </p>
        {milestones.map((milestone, index) => (
          <div
            key={milestone.id}
            className="flex flex-col gap-2 rounded-xl border border-ink-100 p-3"
          >
            <TextField
              label={`里程碑 ${index + 1}`}
              value={milestone.description}
              onChange={(event) => {
                const description = event.target.value;
                setMilestones((list) =>
                  list.map((item) => (item.id === milestone.id ? { ...item, description } : item)),
                );
              }}
            />
            <RowActions
              noun={`里程碑 ${index + 1}`}
              first={index === 0}
              last={index === milestones.length - 1}
              onUp={() => setMilestones((list) => move(list, index, -1))}
              onDown={() => setMilestones((list) => move(list, index, 1))}
              onRemove={() =>
                setMilestones((list) => list.filter((item) => item.id !== milestone.id))
              }
            />
          </div>
        ))}
        {milestones.length < SCENARIO_LIMITS.milestones ? (
          <Button
            size="sm"
            onClick={() => setMilestones((list) => [...list, { id: newId(), description: '' }])}
          >
            添加里程碑
          </Button>
        ) : null}
      </fieldset>

      <TextField
        label="基调"
        value={tone}
        placeholder="选填，例如：冷峻、悬疑"
        onChange={(event) => setTone(event.target.value)}
      />
      <TextField
        label="预计步数"
        type="number"
        inputMode="numeric"
        min={SCENARIO_LIMITS.minSteps}
        max={SCENARIO_LIMITS.maxSteps}
        value={steps}
        hint={`只是节奏参考（${SCENARIO_LIMITS.minSteps}–${SCENARIO_LIMITS.maxSteps}），超界时取边界值。`}
        onChange={(event) => setSteps(event.target.value)}
      />

      {error ? (
        <p role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}

function RowActions({
  noun,
  first,
  last,
  onUp,
  onDown,
  onRemove,
}: {
  noun: string;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" disabled={first} aria-label={`上移${noun}`} onClick={onUp}>
        上移
      </Button>
      <Button size="sm" variant="ghost" disabled={last} aria-label={`下移${noun}`} onClick={onDown}>
        下移
      </Button>
      <Button size="sm" variant="ghost" aria-label={`删除${noun}`} onClick={onRemove}>
        删除
      </Button>
    </div>
  );
}
