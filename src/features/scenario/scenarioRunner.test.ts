import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '@/data/dexie/db';
import { DexieNovelRepository } from '@/data/dexie/DexieNovelRepository';
import type { ScenarioNodeInput } from '@/data/NovelRepository';
import { newId } from '@/domain/primitives';
import { emptyDelta, type Scenario, type ScenarioNode } from '@/domain/schema';
import { LlmError } from '@/llm/errors';
import type { TaskKind } from '@/llm/taskProfiles';
import type { LlmRunner } from '@/llm/useLlm';
import { OPENER } from './scenarioPrompt';
import type { StepTail } from './stepSchema';
import { ALREADY_WALKED, CheckpointFillError, createScenarioRunner } from './useScenarioRunner';

let database: AppDatabase;
let repo: DexieNovelRepository;

beforeEach(async () => {
  database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  repo = new DexieNovelRepository(database);
});

afterEach(async () => {
  database.close();
  await database.delete();
});

// ---------------------------------------------------------------- 夹具

async function seed() {
  const novel = await repo.createNovel({ title: '归墟纪' });
  const [world, char] = await repo.listCategories(novel.id);
  const peizhao = await repo.createEntry(novel.id, {
    categoryId: char!.id,
    title: '裴照',
    fields: { identity: '捕快', voice: '话少' },
  });
  const lingqi = await repo.createEntry(novel.id, {
    categoryId: world!.id,
    title: '灵气',
    fields: { rules: '吐纳入体', cost: '损寿元' },
    pinned: true,
  });
  const scenario = await repo.createScenario(novel.id, {
    title: '雾中渡',
    setup: {
      cast: [{ entryId: '' }],
      start: { time: '', place: '渡口', situation: '在渡口醒来' },
      goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
      milestones: [{ id: 'm1', description: '找到空船' }],
      tone: '',
      expectedSteps: 30,
    },
    newOc: { categoryId: char!.id, title: '沈砚', fields: { identity: '船夫' } },
  });
  return { novel, scenario, peizhao, lingqi };
}

function nodeInput(parent: ScenarioNode | null, plot: string): ScenarioNodeInput {
  return {
    parentId: parent?.id ?? null,
    arrivedBy: parent
      ? { kind: 'option', optionId: parent.options[0]!.id, text: parent.options[0]!.text }
      : { kind: 'start' },
    plot,
    challenge: `挑战：${plot}`,
    options: [
      { id: newId(), text: `${plot}之后拔刀`, tendency: 'bold', risk: 'high', batch: 0 },
      { id: newId(), text: `${plot}之后跳江`, tendency: 'cautious', risk: 'medium', batch: 0 },
    ],
    delta: emptyDelta(),
    notices: [],
    progress: { reachedMilestoneIds: [], note: '' },
    ending: null,
  };
}

/** 直接经仓储建一条 depth 0..length-1 的线性路径（不经模型） */
async function seedPath(scenarioId: string, length: number): Promise<ScenarioNode[]> {
  const path: ScenarioNode[] = [];
  for (let depth = 0; depth < length; depth += 1) {
    const { node } = await repo.appendScenarioNode(
      scenarioId,
      nodeInput(path[depth - 1] ?? null, `第${depth + 1}步情节`),
    );
    path.push(node);
  }
  return path;
}

function tail(overrides: Partial<StepTail> = {}): StepTail {
  return {
    challenge: '船在下沉',
    options: [
      { text: '拔刀', tendency: 'bold', risk: 'high' },
      { text: '跳江', tendency: 'cautious', risk: 'medium' },
    ],
    changes: {
      fieldChanges: [],
      newEntries: [],
      statusChanges: [],
      ocChanges: [],
      events: [],
      flags: [],
    },
    progress: { reachedMilestones: [], note: '' },
    ending: null,
    ...overrides,
  };
}

interface Call {
  task: TaskKind;
  system: string;
  user: string;
}

/** stub LlmRunner：按任务分派给测试给的实现；结果过一遍调用方给的 schema，夹具写错会立刻暴露 */
function stubLlm(impl: {
  step?: (
    call: Call,
  ) => Promise<{ prose: string; data: unknown }> | { prose: string; data: unknown };
  structured?: (call: Call) => Promise<unknown> | unknown;
}) {
  const calls: Call[] = [];
  const llm: Pick<LlmRunner, 'configured' | 'runProseWithTail' | 'runStructured'> = {
    configured: true,
    async runProseWithTail(task, options) {
      const call = { task, system: options.system, user: options.user };
      calls.push(call);
      if (!impl.step) throw new Error('不应发出步骤请求');
      const out = await impl.step(call);
      options.onProse?.(out.prose);
      return { prose: out.prose, data: options.schema.parse(out.data), attempts: 1 };
    },
    async runStructured(task, options) {
      const call = { task, system: options.system, user: options.user };
      calls.push(call);
      if (!impl.structured) throw new Error('不应发出结构化请求');
      return { data: options.schema.parse(await impl.structured(call)), attempts: 1 };
    },
  };
  return { llm, calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function snapshot(
  scenarioId: string,
): Promise<{ nodes: ScenarioNode[]; scenario: Scenario }> {
  return {
    nodes: await repo.listScenarioNodes(scenarioId),
    scenario: (await repo.getScenario(scenarioId))!,
  };
}

/** 模型返回的摘要 */
const summaryOf = (text: string) => ({ summary: text, openThreads: [`${text}的线索`] });
/** 落库后的形状 */
const storedSummary = (text: string) => ({ text, openThreads: [`${text}的线索`] });

// ---------------------------------------------------------------- 推进

describe('推进', () => {
  it('开局：组 prompt、落库、主线与 cursor 指向新节点，选项分配 id', async () => {
    const { scenario } = await seed();
    const { llm, calls } = stubLlm({ step: () => ({ prose: '雾很大。', data: tail() }) });
    const runner = createScenarioRunner({ repo, llm });
    const result = await runner.advance({
      scenarioId: scenario.id,
      parentId: null,
      action: { kind: 'start' },
    });

    expect(calls.map((call) => call.task)).toEqual(['interactive-step']);
    expect(calls[0]!.system.startsWith(OPENER)).toBe(true);
    expect(calls[0]!.system).toContain('## 沈砚（人物）');
    expect(calls[0]!.user).toContain('【本次行动】这是开局');
    expect(result.node).toMatchObject({
      depth: 0,
      plot: '雾很大。',
      arrivedBy: { kind: 'start' },
      challenge: '船在下沉',
    });
    expect(result.node.options.map((option) => option.text)).toEqual(['拔刀', '跳江']);
    for (const option of result.node.options) expect(option.id).toBeTruthy();
    const after = await snapshot(scenario.id);
    expect(after.scenario.mainNodeId).toBe(result.node.id);
    expect(after.scenario.cursorNodeId).toBe(result.node.id);
    expect(result.items.some((item) => item.kind === 'action')).toBe(true);
  });

  it('同一推演不同节点、收尾的系统提示逐字节相同', async () => {
    const { scenario } = await seed();
    const [root, second] = await seedPath(scenario.id, 2);
    const { llm, calls } = stubLlm({
      step: (call) =>
        call.task === 'interactive-ending'
          ? {
              prose: '他上了岸。',
              data: tail({
                options: [],
                ending: { kind: 'good', goal: 1, title: '上岸', cause: '拔刀' },
              }),
            }
          : { prose: '雾很大。', data: tail() },
    });
    const runner = createScenarioRunner({ repo, llm });
    await runner.advance({
      scenarioId: scenario.id,
      parentId: root!.id,
      action: { kind: 'option', optionId: root!.options[1]!.id },
    });
    await runner.advance({
      scenarioId: scenario.id,
      parentId: second!.id,
      action: { kind: 'free', text: '徒手劈江' },
    });
    const ended = await runner.advance({
      scenarioId: scenario.id,
      parentId: second!.id,
      action: { kind: 'wrap-up', goalId: 'g1', note: '' },
    });
    expect(calls.map((call) => call.task)).toEqual([
      'interactive-step',
      'interactive-step',
      'interactive-ending',
    ]);
    expect(new Set(calls.map((call) => call.system)).size).toBe(1);
    expect(calls[1]!.user).toContain('这是尝试，不是既成事实');
    expect(ended.node.arrivedBy).toEqual({ kind: 'wrap-up', goalId: 'g1', note: '' });
    expect(ended.node.ending).toMatchObject({ kind: 'good', goalId: 'g1', title: '上岸' });
  });

  for (const kind of ['truncated', 'parse'] as const) {
    it(`模型 ${kind} 失败：不落节点、主线不变`, async () => {
      const { scenario } = await seed();
      const [root] = await seedPath(scenario.id, 1);
      const before = await snapshot(scenario.id);
      const { llm } = stubLlm({
        step: () => {
          throw new LlmError(
            kind,
            kind === 'truncated'
              ? '这一步写得太长被截断了，没有保存'
              : '模型输出不符合预期格式（已重试 1 次）',
          );
        },
      });
      const runner = createScenarioRunner({ repo, llm });
      const error = await runner
        .advance({
          scenarioId: scenario.id,
          parentId: root!.id,
          action: { kind: 'option', optionId: root!.options[0]!.id },
        })
        .catch((cause: unknown) => cause);
      expect((error as LlmError).kind).toBe(kind);
      expect(await snapshot(scenario.id)).toEqual(before);
    });
  }

  it('锁定字段的覆盖被丢弃并进 notices，可变字段照常记下', async () => {
    const { scenario, peizhao } = await seed();
    const [root] = await seedPath(scenario.id, 1);
    const { llm } = stubLlm({
      step: () => ({
        prose: '他强行催动灵气。',
        data: tail({
          changes: {
            fieldChanges: [
              { entry: '灵气', field: '运作规则', value: '无需代价' },
              { entry: '裴照', field: '身份', value: '叛徒' },
            ],
            newEntries: [],
            statusChanges: [],
            ocChanges: [{ aspect: 'injury', op: 'add', text: '经脉受损' }],
            events: ['催动灵气'],
            flags: [],
          },
        }),
      }),
    });
    const runner = createScenarioRunner({ repo, llm });
    const { node } = await runner.advance({
      scenarioId: scenario.id,
      parentId: root!.id,
      action: { kind: 'free', text: '强行催动灵气' },
    });
    expect(node.delta.fieldOverrides).toEqual([
      { target: { kind: 'world', entryId: peizhao.id }, fieldKey: 'identity', value: '叛徒' },
    ]);
    expect(node.notices).toContainEqual({
      kind: 'locked-field',
      message: '「灵气」的「运作规则」是底层设定，本线不能改写，已丢弃',
    });
    expect(node.delta.ocChanges).toEqual([
      { castId: scenario.setup.cast[0]!.id, aspect: 'injury', op: 'add', text: '经脉受损' },
    ]);
    expect(node.arrivedBy).toEqual({ kind: 'free', text: '强行催动灵气' });
  });

  it('前置检查不发请求：已走过的选项、规范化后与已走过选项相同的自由输入、结局之后', async () => {
    const { scenario } = await seed();
    const [root, child] = await seedPath(scenario.id, 2);
    const { llm, calls } = stubLlm({});
    const runner = createScenarioRunner({ repo, llm });
    const walked = root!.options[0]!;
    await expect(
      runner.advance({
        scenarioId: scenario.id,
        parentId: root!.id,
        action: { kind: 'option', optionId: walked.id },
      }),
    ).rejects.toThrow(ALREADY_WALKED);
    await expect(
      runner.advance({
        scenarioId: scenario.id,
        parentId: root!.id,
        action: { kind: 'free', text: ` ${walked.text}！` },
      }),
    ).rejects.toThrow(ALREADY_WALKED);
    const ending = await repo.appendScenarioNode(scenario.id, {
      ...nodeInput(child!, '结局'),
      options: [],
      ending: { kind: 'bad', goalId: null, title: '沉江', cause: '跳江' },
    });
    await expect(
      runner.advance({
        scenarioId: scenario.id,
        parentId: ending.node.id,
        action: { kind: 'free', text: '再试一次' },
      }),
    ).rejects.toThrow('这条线已经结束，不能继续推进');
    expect(calls).toHaveLength(0);
  });

  it('自由输入与未走过的选项规范化后相同：按选了那个选项处理', async () => {
    const { scenario } = await seed();
    const [root] = await seedPath(scenario.id, 2);
    const { llm, calls } = stubLlm({ step: () => ({ prose: '雾很大。', data: tail() }) });
    const runner = createScenarioRunner({ repo, llm });
    const unwalked = root!.options[1]!;
    const { node } = await runner.advance({
      scenarioId: scenario.id,
      parentId: root!.id,
      action: { kind: 'free', text: `${unwalked.text}。` },
    });
    expect(node.arrivedBy).toEqual({ kind: 'option', optionId: unwalked.id, text: unwalked.text });
    expect(calls[0]!.user).toContain(`【本次行动】主角选择：${unwalked.text}`);
  });

  it('主角条目被删除：不发请求，提示到回收站恢复', async () => {
    const { scenario } = await seed();
    const [root] = await seedPath(scenario.id, 1);
    await repo.softDeleteEntry(scenario.setup.cast[0]!.entryId);
    const { llm, calls } = stubLlm({});
    const runner = createScenarioRunner({ repo, llm });
    await expect(
      runner.advance({
        scenarioId: scenario.id,
        parentId: root!.id,
        action: { kind: 'option', optionId: root!.options[0]!.id },
      }),
    ).rejects.toThrow('主角「沈砚」已被删除，到知识库回收站恢复后才能继续');
    expect(calls).toHaveLength(0);
  });

  it('没配置模型：直接拒绝', async () => {
    const { scenario } = await seed();
    const { llm } = stubLlm({});
    const runner = createScenarioRunner({ repo, llm: { ...llm, configured: false } });
    const error = await runner
      .advance({ scenarioId: scenario.id, parentId: null, action: { kind: 'start' } })
      .catch((cause: unknown) => cause);
    expect((error as LlmError).kind).toBe('config');
  });
});

// ---------------------------------------------------------------- 取消

describe('取消', () => {
  it('「停止」：生成中途取消，之后模型返回也不落库', async () => {
    const { scenario } = await seed();
    const [root] = await seedPath(scenario.id, 1);
    const before = await snapshot(scenario.id);
    const gate = deferred<{ prose: string; data: unknown }>();
    const started = deferred<void>();
    const { llm } = stubLlm({
      step: () => {
        started.resolve();
        return gate.promise;
      },
    });
    const runner = createScenarioRunner({ repo, llm });
    const controller = new AbortController();
    const pending = runner
      .advance(
        {
          scenarioId: scenario.id,
          parentId: root!.id,
          action: { kind: 'option', optionId: root!.options[0]!.id },
        },
        { signal: controller.signal },
      )
      .catch((cause: unknown) => cause);
    await started.promise;
    controller.abort();
    gate.resolve({ prose: '雾很大。', data: tail() });
    expect(((await pending) as LlmError).kind).toBe('aborted');
    expect(await snapshot(scenario.id)).toEqual(before);
  });

  it('卸载（abortAll）：在途的本步与后台摘要都取消，什么都不写', async () => {
    const { scenario } = await seed();
    const path = await seedPath(scenario.id, 6);
    const before = await snapshot(scenario.id);
    const stepGate = deferred<{ prose: string; data: unknown }>();
    const summaryGate = deferred<unknown>();
    const stepStarted = deferred<void>();
    const { llm, calls } = stubLlm({
      step: () => {
        stepStarted.resolve();
        return stepGate.promise;
      },
      structured: () => summaryGate.promise,
    });
    const runner = createScenarioRunner({ repo, llm });
    const parent = path[5]!;
    const pending = runner
      .advance({
        scenarioId: scenario.id,
        parentId: parent.id,
        action: { kind: 'option', optionId: parent.options[0]!.id },
      })
      .catch((cause: unknown) => cause);
    await stepStarted.promise;
    // gap ≤ 7：depth 4 的检查点在后台补，与本步同时在途
    await expect.poll(() => calls.length).toBe(2);
    expect(calls.map((call) => call.task).sort()).toEqual([
      'interactive-step',
      'interactive-summary',
    ]);
    runner.abortAll();
    stepGate.resolve({ prose: '雾很大。', data: tail() });
    summaryGate.resolve(summaryOf('前情'));
    expect(((await pending) as LlmError).kind).toBe('aborted');
    // 等后台那条也走完
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await snapshot(scenario.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------- 检查点

describe('检查点前情摘要（D5.3）', () => {
  it('连续缺两个且 gap > 7：按顺序发两次 summary，第二次的 user 含第一次的摘要，补完才发 step', async () => {
    const { scenario } = await seed();
    const path = await seedPath(scenario.id, 12);
    let summaries = 0;
    const { llm, calls } = stubLlm({
      structured: async () => {
        summaries += 1;
        // 让出几轮事件循环：若 step 与 summary 并发，step 会在这期间插进来
        await new Promise((resolve) => setTimeout(resolve, 5));
        return summaryOf(`摘要${summaries}`);
      },
      step: () => ({ prose: '雾很大。', data: tail() }),
    });
    const phases: string[] = [];
    const runner = createScenarioRunner({ repo, llm });
    const parent = path[11]!;
    const { node } = await runner.advance(
      {
        scenarioId: scenario.id,
        parentId: parent.id,
        action: { kind: 'option', optionId: parent.options[0]!.id },
      },
      { onPhase: (phase) => phases.push(phase) },
    );

    expect(calls.map((call) => call.task)).toEqual([
      'interactive-summary',
      'interactive-summary',
      'interactive-step',
    ]);
    expect(calls[0]!.user).toContain('【上一段前情】（从开局写起）');
    expect(calls[0]!.user).toContain('第1步情节');
    expect(calls[0]!.user).toContain('第5步情节');
    expect(calls[1]!.user).toContain('【上一段前情】摘要1');
    // 第二段只有第 6–10 步：前一段已在摘要 1 里
    expect(calls[1]!.user).not.toContain('第 5 步 ·');
    expect(calls[1]!.user).toContain('第 6 步 ·');
    expect(calls[1]!.user).toContain('第 10 步 ·');
    // 最近 3 步是第 10–12 步；更早的经过取深度小于它们的最深摘要（第 5 步），第 6–9 步走 gap 简写
    expect(calls[2]!.user).toContain('【更早的经过】\n摘要1');
    expect(calls[2]!.user).toContain('【此前几步（简）】');
    expect(phases).toEqual(['summarizing', 'generating']);
    // 摘要请求复用推演前缀
    expect(calls[0]!.system).toBe(calls[2]!.system);

    const nodes = await repo.listScenarioNodes(scenario.id);
    expect(nodes.find((item) => item.id === path[4]!.id)!.pathSummary).toEqual(
      storedSummary('摘要1'),
    );
    expect(nodes.find((item) => item.id === path[9]!.id)!.pathSummary).toEqual(
      storedSummary('摘要2'),
    );
    expect(node.depth).toBe(12);
  });

  it('第一次失败：第二次不发、本步不生成；已有数据不变', async () => {
    const { scenario } = await seed();
    const path = await seedPath(scenario.id, 12);
    const before = await snapshot(scenario.id);
    const { llm, calls } = stubLlm({
      structured: () => {
        throw new LlmError('server', '模型服务暂时不可用，请稍后重试');
      },
      step: () => ({ prose: '雾很大。', data: tail() }),
    });
    const events: string[] = [];
    const runner = createScenarioRunner({
      repo,
      llm,
      onCheckpoint: (event) => events.push(event.status),
    });
    const parent = path[11]!;
    const error = await runner
      .advance({
        scenarioId: scenario.id,
        parentId: parent.id,
        action: { kind: 'option', optionId: parent.options[0]!.id },
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CheckpointFillError);
    expect((error as CheckpointFillError).message).toBe('整理前情失败，这一步没有生成');
    expect((error as CheckpointFillError).nodeId).toBe(path[4]!.id);
    expect(calls.map((call) => call.task)).toEqual(['interactive-summary']);
    expect(events).toEqual(['running', 'failed']);
    expect(await snapshot(scenario.id)).toEqual(before);
  });

  it('只缺第 5 步、路径 12 步（gap = 9 > 7）：先发 1 次 summary，它完成后才发 step（addendum 5）', async () => {
    const { scenario } = await seed();
    const path = await seedPath(scenario.id, 12);
    await repo.setScenarioNodeSummary(path[9]!.id, { text: '第十步前情', openThreads: [] });
    const order: string[] = [];
    const { llm } = stubLlm({
      structured: async () => {
        order.push('summary:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('summary:end');
        return summaryOf('补上的摘要');
      },
      step: () => {
        order.push('step');
        return { prose: '雾很大。', data: tail() };
      },
    });
    const runner = createScenarioRunner({ repo, llm });
    const parent = path[11]!;
    await runner.advance({
      scenarioId: scenario.id,
      parentId: parent.id,
      action: { kind: 'option', optionId: parent.options[0]!.id },
    });
    expect(order).toEqual(['summary:start', 'summary:end', 'step']);
  });

  it('gap ≤ 7：后台补、本步照常生成；补好的摘要落库', async () => {
    const { scenario } = await seed();
    const path = await seedPath(scenario.id, 6);
    const { llm, calls } = stubLlm({
      structured: () => summaryOf('后台摘要'),
      step: () => ({ prose: '雾很大。', data: tail() }),
    });
    const runner = createScenarioRunner({ repo, llm });
    const parent = path[5]!;
    const { node } = await runner.advance({
      scenarioId: scenario.id,
      parentId: parent.id,
      action: { kind: 'option', optionId: parent.options[0]!.id },
    });
    expect(node.depth).toBe(6);
    // 本步的 prompt 用的是当时的上下文（没有摘要，靠 gap 原文）
    expect(calls.find((call) => call.task === 'interactive-step')!.user).not.toContain(
      '【更早的经过】',
    );
    await expect
      .poll(
        async () =>
          (await repo.listScenarioNodes(scenario.id)).find((item) => item.id === path[4]!.id)!
            .pathSummary,
      )
      .toEqual(storedSummary('后台摘要'));
    expect(calls.filter((call) => call.task === 'interactive-summary')).toHaveLength(1);
  });

  it('同一检查点并发触发只发一次请求', async () => {
    const { scenario } = await seed();
    const path = await seedPath(scenario.id, 5);
    const gate = deferred<unknown>();
    const { llm, calls } = stubLlm({ structured: () => gate.promise });
    const runner = createScenarioRunner({ repo, llm });
    const input = { scenarioId: scenario.id, nodeId: path[4]!.id };
    const first = runner.summarizeCheckpoint(input);
    const second = runner.summarizeCheckpoint(input);
    expect(second).toBe(first);
    // 等第一次真正发出请求后再触发一次，仍然复用在途请求
    await expect.poll(() => calls.length).toBe(1);
    const third = runner.summarizeCheckpoint(input);
    gate.resolve(summaryOf('只发一次'));
    const results = await Promise.all([first, second, third]);
    expect(calls).toHaveLength(1);
    for (const result of results) expect(result.pathSummary).toEqual(storedSummary('只发一次'));
  });

  it('同步补遇到在途的后台请求时 await 它而不是重发', async () => {
    const { scenario } = await seed();
    const path = await seedPath(scenario.id, 12);
    const gate = deferred<unknown>();
    let summaryCalls = 0;
    const { llm, calls } = stubLlm({
      structured: () => {
        summaryCalls += 1;
        return summaryCalls === 1 ? gate.promise : summaryOf('第二个');
      },
      step: () => ({ prose: '雾很大。', data: tail() }),
    });
    const runner = createScenarioRunner({ repo, llm });
    // 后台先发起 depth 4 的摘要
    const background = runner.summarizeCheckpoint({ scenarioId: scenario.id, nodeId: path[4]!.id });
    await expect.poll(() => calls.length).toBe(1);
    const parent = path[11]!;
    const advancing = runner.advance({
      scenarioId: scenario.id,
      parentId: parent.id,
      action: { kind: 'option', optionId: parent.options[0]!.id },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(1);
    gate.resolve(summaryOf('第一个'));
    await background;
    await advancing;
    expect(calls.map((call) => call.task)).toEqual([
      'interactive-summary',
      'interactive-summary',
      'interactive-step',
    ]);
    expect(calls[1]!.user).toContain('【上一段前情】第一个');
  });

  it('新检查点刚落库：后台补它的摘要', async () => {
    const { scenario } = await seed();
    const path = await seedPath(scenario.id, 4);
    await repo.setScenarioNodeSummary(path[0]!.id, { text: '无关', openThreads: [] });
    const { llm, calls } = stubLlm({
      structured: () => summaryOf('新检查点'),
      step: () => ({ prose: '第五步。', data: tail() }),
    });
    const runner = createScenarioRunner({ repo, llm });
    const parent = path[3]!;
    const { node } = await runner.advance({
      scenarioId: scenario.id,
      parentId: parent.id,
      action: { kind: 'option', optionId: parent.options[0]!.id },
    });
    expect(node.depth).toBe(4);
    await expect
      .poll(
        async () =>
          (await repo.listScenarioNodes(scenario.id)).find((item) => item.id === node.id)!
            .pathSummary,
      )
      .toEqual(storedSummary('新检查点'));
    expect(calls.map((call) => call.task)).toEqual(['interactive-step', 'interactive-summary']);
    expect(calls[1]!.user).toContain('第五步。');
  });
});

// ---------------------------------------------------------------- 再给选项

describe('再给几个选项', () => {
  it('去重后追加；不触发补摘要', async () => {
    const { scenario } = await seed();
    const path = await seedPath(scenario.id, 6);
    const current = path[5]!;
    const { llm, calls } = stubLlm({
      structured: (call) => {
        expect(call.task).toBe('interactive-options');
        return {
          options: [
            { text: `${current.options[0]!.text}！`, tendency: 'bold', risk: 'high' },
            { text: '绕到船尾', tendency: 'indirect', risk: 'low' },
            { text: '大声呼救', tendency: 'cooperate', risk: 'medium' },
          ],
        };
      },
    });
    const runner = createScenarioRunner({ repo, llm });
    const next = await runner.regenerateOptions({ scenarioId: scenario.id, nodeId: current.id });
    expect(next.options.map((option) => option.text)).toEqual([
      current.options[0]!.text,
      current.options[1]!.text,
      '绕到船尾',
      '大声呼救',
    ]);
    expect(next.options.slice(2).every((option) => option.batch === 1)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain(`【本次要求】这一步的挑战是：${current.challenge}`);
  });

  it('去重后不足 2 个：失败、不写入', async () => {
    const { scenario } = await seed();
    const [root] = await seedPath(scenario.id, 1);
    const { llm } = stubLlm({
      structured: () => ({
        options: [
          { text: root!.options[0]!.text, tendency: 'bold', risk: 'high' },
          { text: '绕到船尾', tendency: 'indirect', risk: 'low' },
        ],
      }),
    });
    const runner = createScenarioRunner({ repo, llm });
    const before = await snapshot(scenario.id);
    await expect(
      runner.regenerateOptions({ scenarioId: scenario.id, nodeId: root!.id }),
    ).rejects.toThrow('没有新的选项');
    expect(await snapshot(scenario.id)).toEqual(before);
  });
});
