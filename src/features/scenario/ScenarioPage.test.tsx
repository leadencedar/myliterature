import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/app/AppShell';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { ScenarioNodeInput } from '@/data/NovelRepository';
import { newId } from '@/domain/primitives';
import {
  emptyDelta,
  type Category,
  type Novel,
  type Scenario,
  type ScenarioNode,
} from '@/domain/schema';
import { PROSE_TAIL_SENTINEL } from '@/llm/proseTail';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import type { StepTail } from './stepSchema';

/**
 * 推演页的主要流程（设计 §13.2 ScenarioPage 一节）。模型调用一律 stub fetch：
 * 流式步骤用 SSE（分块），结构化的再给选项 / 前情摘要用非流式 JSON。
 * 「回退 / 跳转 / 换线不发请求」一律用 fetch 的调用次数断言。
 */

let harness: TestHarness;
let novel: Novel;
let worldCategory: Category;
let characterCategory: Category;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  [worldCategory, characterCategory] = (await harness.repository.listCategories(novel.id)) as [
    Category,
    Category,
  ];
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- 夹具

function tail(overrides: Partial<StepTail> = {}): StepTail {
  return {
    challenge: '雾越来越浓',
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

function optionsOf(...texts: string[]): StepTail['options'] {
  const tendencies = ['bold', 'cautious', 'explore', 'cooperate'] as const;
  return texts.map((text, index) => ({ text, tendency: tendencies[index % 4]!, risk: 'medium' }));
}

/** 正文分块 + 分隔符 + 尾部 JSON */
function stepEvents(prose: string[], data: StepTail): string[] {
  return textDeltaEvents([...prose, `\n${PROSE_TAIL_SENTINEL}\n${JSON.stringify(data)}`]);
}

function stepResponse(prose: string, data: StepTail): Response {
  return sseResponse(stepEvents([prose], data));
}

/** 先发 head 个分块，等 gate 放行再发剩下的：用来断言「生成中已出现部分情节」 */
function gatedResponse(
  prose: string[],
  data: StepTail,
  head: number,
  gate: Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const events = stepEvents(prose, data);
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of events.slice(0, head)) controller.enqueue(encoder.encode(event));
        await gate;
        for (const event of events.slice(head)) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

/** 发完第一块就挂起，直到请求被 abort（按 fetch 的规矩以 AbortError 结束） */
function hangingResponse(firstChunk: string, signal: AbortSignal | null | undefined): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(textDeltaEvents([firstChunk])[0]!));
        signal?.addEventListener('abort', () =>
          controller.error(new DOMException('The operation was aborted.', 'AbortError')),
        );
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

interface RequestBody {
  stream?: boolean;
  messages: { role: string; content: string }[];
}

type Responder = (init: RequestInit | undefined, body: RequestBody) => Response | Promise<Response>;

/** 按顺序回应；记录每次请求体与 signal */
function stubFetch(responders: Responder[] = []) {
  const bodies: RequestBody[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const queue = [...responders];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as RequestBody;
    bodies.push(body);
    signals.push(init?.signal);
    const next = queue.shift();
    if (!next) throw new Error('测试没有准备这次请求');
    return next(init, body);
  });
  return {
    spy,
    bodies,
    signals,
    push: (...more: Responder[]) => queue.push(...more),
    get count() {
      return spy.mock.calls.length;
    },
  };
}

const userOf = (body: RequestBody) =>
  body.messages.find((message) => message.role === 'user')?.content ?? '';
const systemOf = (body: RequestBody) =>
  body.messages.find((message) => message.role === 'system')?.content ?? '';

async function seedScenario(): Promise<Scenario> {
  return harness.repository.createScenario(novel.id, {
    title: '雾中渡',
    setup: {
      cast: [{ entryId: '' }],
      start: { time: '', place: '渡口', situation: '在渡口醒来' },
      goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
      milestones: [],
      tone: '',
      expectedSteps: 30,
    },
    newOc: {
      categoryId: characterCategory.id,
      title: '沈砚',
      fields: { identity: '船夫', voice: '话少' },
    },
  });
}

function nodeInput(
  parent: ScenarioNode | null,
  plot: string,
  optionIndex = 0,
  overrides: Partial<ScenarioNodeInput> = {},
): ScenarioNodeInput {
  return {
    parentId: parent?.id ?? null,
    arrivedBy: parent
      ? {
          kind: 'option',
          optionId: parent.options[optionIndex]!.id,
          text: parent.options[optionIndex]!.text,
        }
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
    ...overrides,
  };
}

async function append(scenario: Scenario, input: ScenarioNodeInput): Promise<ScenarioNode> {
  return (await harness.repository.appendScenarioNode(scenario.id, input)).node;
}

function renderApp(path: string) {
  return harness.renderUI(<AppShell />, path);
}

function renderScenario(scenario: Scenario) {
  return renderApp(`/write/scenario/${scenario.id}`);
}

/** 正文区的步骤标题（h2，与 Sheet 的标题区分开：按「第 k 步」匹配） */
function stepHeading() {
  return screen.getByRole('heading', { level: 2, name: /^第 \d+ 步 · / });
}

async function findStepHeading(name: RegExp | string) {
  return screen.findByRole('heading', { level: 2, name });
}

/** 写作页加载完成（RequireNovel 的加载占位也叫「写作」，要等真正的内容出来） */
async function findWritingPage() {
  await screen.findByText('还没有大纲');
  expect(screen.getByRole('heading', { level: 1, name: '写作' })).toBeInTheDocument();
}

const crumbs = () => within(screen.getByRole('navigation', { name: '当前路径' }));

// ---------------------------------------------------------------- 全流程

describe('全流程（验收 11–14、21、22、37）', () => {
  it('写作页开始一局 → 开局分块流 → 推进 → 回退不发请求 → 换线 → 坏结局 → 回到上一个挑战', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = stubFetch([
      () =>
        gatedResponse(
          ['雾从江面漫上来，', '沈砚在渡口醒来。'],
          tail({ options: optionsOf('沿江岸搜寻', '回船舱躲雨', '叫醒船夫') }),
          1,
          gate,
        ),
      () =>
        stepResponse('岸边有一串脚印。', tail({ options: optionsOf('跟着脚印走', '原路返回') })),
      () => stepResponse('脚印通向林子。', tail({ options: optionsOf('钻进林子', '在林边等候') })),
      () => stepResponse('船舱里漏着雨。', tail({ options: optionsOf('补船', '睡一觉') })),
      () =>
        stepResponse(
          '林中雾气翻涌，沈砚一脚踏空。',
          tail({
            challenge: '',
            options: [],
            ending: { kind: 'bad', goal: null, title: '坠崖', cause: '在浓雾里追着脚印进林' },
          }),
        ),
      () =>
        stepResponse(
          '沈砚守在林边，听见了人声。',
          tail({ options: optionsOf('出声招呼', '躲起来') }),
        ),
    ]);
    renderApp('/write');

    await user.click(await screen.findByRole('button', { name: '开始一局' }));
    const setup = screen.getByRole('dialog', { name: '开始一局互动推演' });
    await user.type(within(setup).getByLabelText('推演名称'), '雾中渡');
    await user.type(within(setup).getByLabelText('主角名称'), '沈砚');
    await user.type(within(setup).getByLabelText('处境'), '在渡口醒来，船夫不见了');
    await user.type(within(setup).getByLabelText('目标 1'), '找到船夫');
    await user.click(within(setup).getByRole('button', { name: '开始推演' }));

    // 开局在分块流里：已经能看到第一块，还看不到后面的
    expect(await screen.findByText('雾从江面漫上来，')).toBeInTheDocument();
    expect(screen.queryByText(/沈砚在渡口醒来/)).not.toBeInTheDocument();
    expect(fetcher.count).toBe(1);
    // 放行之后的流式回调发生在用户事件之外，包进 act 让 React 把这些更新算作这一步的结果
    await act(async () => release());
    await findStepHeading('第 1 步 · 开局');
    const scenario = (await harness.repository.listScenarios(novel.id))[0]!;
    const oc = await harness.repository.getEntry(scenario.setup.cast[0]!.entryId);
    expect(oc).toMatchObject({ title: '沈砚', scope: { kind: 'limited' } });

    await user.click(screen.getByRole('button', { name: /^沿江岸搜寻/ }));
    await findStepHeading('第 2 步 · 你选择了：沿江岸搜寻');
    await user.click(screen.getByRole('button', { name: /^跟着脚印走/ }));
    await findStepHeading('第 3 步 · 你选择了：跟着脚印走');
    expect(fetcher.count).toBe(3);
    expect(crumbs().getByRole('button', { name: '第 3 步' })).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(crumbs().getByRole('button', { name: '开局' })).not.toHaveAttribute('aria-current');

    // 面包屑回开局：不发请求，原始选项原样保留，走过的那个不能再选
    await user.click(crumbs().getByRole('button', { name: '开局' }));
    await findStepHeading('第 1 步 · 开局');
    expect(fetcher.count).toBe(3);
    expect(crumbs().getByRole('button', { name: '开局' })).toHaveAttribute('aria-current', 'step');
    const walked = screen.getByRole('button', { name: /^沿江岸搜寻/ });
    expect(walked).toBeDisabled();
    expect(walked).toHaveTextContent('已走过');
    expect(screen.getByRole('button', { name: /^回船舱躲雨/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^叫醒船夫/ })).toBeEnabled();
    expect(
      screen.getAllByRole('button', { name: /^(沿江岸搜寻|回船舱躲雨|叫醒船夫)/ }),
    ).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: /^回船舱躲雨/ }));
    await findStepHeading('第 2 步 · 你选择了：回船舱躲雨');
    expect(screen.getByText('主线 · 第 2 步')).toBeInTheDocument();
    expect(fetcher.count).toBe(4);

    // 导航去 a 线的最新一步：不发请求；这时 a 线已不是主线
    await user.click(screen.getByRole('button', { name: '世界线' }));
    const navigator = screen.getByRole('dialog', { name: '世界线' });
    await user.click(within(navigator).getByRole('button', { name: /去这条线的最新一步/ }));
    await findStepHeading('第 3 步 · 你选择了：跟着脚印走');
    expect(fetcher.count).toBe(4);
    expect(screen.getByText('外传线 · 不在主线上')).toBeInTheDocument();

    // 在 a 线推进：新节点挂在 a 线下，主线随之切过来；模型给了坏结局
    const aLeaf = (await harness.repository.listScenarioNodes(scenario.id)).find(
      (node) => node.plot === '脚印通向林子。',
    )!;
    await user.click(screen.getByRole('button', { name: /^钻进林子/ }));
    await findStepHeading('第 4 步 · 你选择了：钻进林子');
    const ending = (await harness.repository.listScenarioNodes(scenario.id)).find(
      (node) => node.ending !== null,
    )!;
    expect(ending.parentId).toBe(aLeaf.id);
    expect((await harness.repository.getScenario(scenario.id))!.mainNodeId).toBe(ending.id);
    expect(screen.getByText('主线 · 第 4 步')).toBeInTheDocument();
    expect(screen.getByText('坏结局「坠崖」')).toBeInTheDocument();
    expect(screen.getByText('起因：在浓雾里追着脚印进林')).toBeInTheDocument();
    expect(screen.getByText('这条线到此结束，但你可以回到任何一步重新选择')).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: '或者，写下主角要做的事' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '这样做' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '回到上一个挑战' }));
    await findStepHeading('第 3 步 · 你选择了：跟着脚印走');
    expect(screen.getByRole('button', { name: /^钻进林子/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^在林边等候/ }));
    await findStepHeading('第 4 步 · 你选择了：在林边等候');
    expect(fetcher.count).toBe(6);
    expect(await harness.repository.listScenarioNodes(scenario.id)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------- 主线徽标

describe('主线徽标（验收 18）', () => {
  it('在旧线上显示「外传线 · 不在主线上」与「回到主线最新一步」；在旧线推进后变成主线', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const root = await append(scenario, nodeInput(null, '开局'));
    const a = await append(scenario, nodeInput(root, '走a线', 0));
    await append(scenario, nodeInput(root, '走b线', 1));
    await harness.repository.setScenarioCursor(scenario.id, a.id);
    const fetcher = stubFetch([() => stepResponse('a线继续。', tail())]);
    renderScenario(scenario);

    await findStepHeading(/^第 2 步 · 你选择了：开局之后拔刀/);
    expect(screen.getByText('外传线 · 不在主线上')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '回到主线最新一步' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^走a线之后拔刀/ }));
    await findStepHeading(/^第 3 步/);
    // 生成完成后焦点移到新步骤标题，读屏从新情节开始读
    await waitFor(() => expect(stepHeading()).toHaveFocus());
    expect(screen.getByText('主线 · 第 3 步')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '回到主线最新一步' })).not.toBeInTheDocument();
    expect(fetcher.count).toBe(1);
  });
});

// ---------------------------------------------------------------- 自由输入

describe('自由输入（验收 15、38）', () => {
  it('与已走过的相同时禁用；相似时出现「仍然这样做」；提交后请求带「作者为主角输入的尝试」', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const root = await append(
      scenario,
      nodeInput(null, '开局', 0, {
        options: [
          { id: newId(), text: '沿着江岸往下游搜寻', tendency: 'explore', risk: 'low', batch: 0 },
          { id: newId(), text: '回船舱躲雨', tendency: 'cautious', risk: 'low', batch: 0 },
        ],
      }),
    );
    await append(scenario, nodeInput(root, '江岸', 0));
    await harness.repository.setScenarioCursor(scenario.id, root.id);
    const fetcher = stubFetch([() => stepResponse('船夫没有回应。', tail())]);
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    const input = screen.getByRole('textbox', { name: '或者，写下主角要做的事' });
    await user.type(input, '沿着江岸往下游 搜寻。');
    expect(screen.getByText('这个行动在这一步已经走过了')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '这样做' })).toBeDisabled();

    await user.clear(input);
    await user.type(input, '沿着江岸往下游搜寻船');
    expect(screen.getByText('和已走过的「沿着江岸往下游搜寻」很像')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '仍然这样做' })).toBeEnabled();

    await user.clear(input);
    await user.type(input, '大喊船夫的名字');
    expect(screen.getByRole('button', { name: '这样做' })).toBeEnabled();
    // 桌面 ⌘/Ctrl+Enter 提交
    await user.keyboard('{Control>}{Enter}{/Control}');
    await findStepHeading('第 2 步 · 你尝试：大喊船夫的名字');
    expect(fetcher.count).toBe(1);
    expect(userOf(fetcher.bodies[0]!)).toContain('作者为主角输入的尝试：大喊船夫的名字');
    expect(userOf(fetcher.bodies[0]!)).toContain('（这是尝试，不是既成事实。');
  });
});

// ---------------------------------------------------------------- 世界线导航

describe('世界线导航（验收 39）', () => {
  it('列出当前路径每一步、各步的分支（深度与结局）与已到达的结局，点任一项跳过去且不发请求', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const root = await append(scenario, nodeInput(null, '开局'));
    const a = await append(scenario, nodeInput(root, '走a线', 0));
    const a2 = await append(scenario, nodeInput(a, '走a线第二步', 0));
    await append(
      scenario,
      nodeInput(root, '走b线', 1, {
        options: [],
        challenge: '',
        ending: { kind: 'bad', goalId: null, title: '坠崖', cause: '走错了路' },
      }),
    );
    await harness.repository.setScenarioCursor(scenario.id, a2.id);
    const fetcher = stubFetch();
    renderScenario(scenario);
    await findStepHeading(/^第 3 步/);

    await user.click(screen.getByRole('button', { name: '世界线' }));
    const navigator = screen.getByRole('dialog', { name: '世界线' });
    const steps = within(navigator)
      .getAllByRole('listitem')
      .filter((item) => item.parentElement?.tagName === 'OL');
    expect(steps.map((item) => item.querySelector('p')?.textContent)).toEqual([
      // 根节点同时在主线（开局 → b 线结局）上
      '开局 · 开局主线',
      '第 2 步 · 选「开局之后拔刀」',
      '第 3 步 · 选「走a线之后拔刀」当前',
    ]);
    expect(
      within(navigator).getByText('另一条线：选「开局之后跳江」 · 已走 1 步 · 坏结局「坠崖」'),
    ).toBeInTheDocument();
    expect(
      within(navigator).getByRole('button', { name: '第 2 步 · 坏结局「坠崖」' }),
    ).toBeInTheDocument();

    await user.click(within(navigator).getByRole('button', { name: '跳到这一步（开局）' }));
    await findStepHeading('第 1 步 · 开局');
    expect(screen.queryByRole('dialog', { name: '世界线' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '世界线' }));
    await user.click(screen.getByRole('button', { name: '第 2 步 · 坏结局「坠崖」' }));
    await findStepHeading('第 2 步 · 你选择了：开局之后跳江');
    expect(fetcher.count).toBe(0);
    expect((await harness.repository.getScenario(scenario.id))!.cursorNodeId).not.toBe(a2.id);
  });
});

// ---------------------------------------------------------------- 再给几个选项

describe('再给几个选项（验收 16）', () => {
  it('全部选项走过后出现按钮，点击只发 1 次请求，新选项追加、原选项不变', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const root = await append(scenario, nodeInput(null, '开局'));
    await append(scenario, nodeInput(root, 'a', 0));
    await append(scenario, nodeInput(root, 'b', 1));
    await harness.repository.setScenarioCursor(scenario.id, root.id);
    const fetcher = stubFetch([
      () =>
        jsonResponse(
          completion(
            JSON.stringify({
              options: [
                { text: '点燃信号火', tendency: 'bold', risk: 'medium' },
                { text: '沿岸呼救', tendency: 'cooperate', risk: 'low' },
              ],
            }),
          ),
        ),
    ]);
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    await user.click(screen.getByRole('button', { name: '再给几个选项' }));
    expect(await screen.findByRole('button', { name: /^点燃信号火/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^沿岸呼救/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^开局之后拔刀/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^开局之后跳江/ })).toBeDisabled();
    expect(fetcher.count).toBe(1);
    expect(fetcher.bodies[0]!.stream).toBe(false);

    const stored = (await harness.repository.listScenarioNodes(scenario.id)).find(
      (node) => node.id === root.id,
    )!;
    expect(stored.options.slice(0, 2)).toEqual(root.options);
    expect(stored.options.slice(2).map((option) => [option.text, option.batch])).toEqual([
      ['点燃信号火', 1],
      ['沿岸呼救', 1],
    ]);
  });
});

// ---------------------------------------------------------------- 截断 / 收尾 / 被丢弃的变化

describe('生成结果', () => {
  it('截断（finish_reason: length）：显示截断提示，树里没有新节点（验收 20）', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    await append(scenario, nodeInput(null, '开局'));
    stubFetch([
      () =>
        sseResponse(
          textDeltaEvents(
            ['写了很长很长'],
            [`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`],
          ),
        ),
    ]);
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    await user.click(screen.getByRole('button', { name: /^开局之后拔刀/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('这一步写得太长被截断了，没有保存');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(await harness.repository.listScenarioNodes(scenario.id)).toHaveLength(1);
    expect(stepHeading()).toHaveTextContent('第 1 步 · 开局');
  });

  it('收尾：生成结局节点并显示类型（验收 23）', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const root = await append(scenario, nodeInput(null, '开局'));
    const fetcher = stubFetch([
      () =>
        stepResponse(
          '船夫从雾里撑船回来。',
          tail({
            challenge: '',
            options: [],
            ending: { kind: 'good', goal: 1, title: '重逢', cause: '一直守在渡口' },
          }),
        ),
    ]);
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    await user.click(screen.getByRole('button', { name: '收尾' }));
    const sheet = screen.getByRole('dialog', { name: '收尾' });
    await user.click(within(sheet).getByRole('radio', { name: /G1 · 好结局/ }));
    await user.click(within(sheet).getByRole('button', { name: '写出结局' }));
    await findStepHeading('第 2 步 · 收尾');
    expect(screen.getByText('好结局「重逢」')).toBeInTheDocument();
    expect(userOf(fetcher.bodies[0]!)).toContain('作者要求收尾');

    const ending = (await harness.repository.listScenarioNodes(scenario.id)).find(
      (node) => node.parentId === root.id,
    )!;
    expect(ending.arrivedBy).toEqual({ kind: 'wrap-up', goalId: 'g1', note: '' });
    expect(ending.ending).toMatchObject({ kind: 'good', goalId: 'g1' });

    // 回到开局：同一步只能收尾一次，按钮换成「查看已写的结局」
    await user.click(crumbs().getByRole('button', { name: '开局' }));
    await user.click(screen.getByRole('button', { name: '查看已写的结局' }));
    await findStepHeading('第 2 步 · 收尾');
    expect(fetcher.count).toBe(1);
  });

  it('锁定字段的覆盖被丢弃：页面提示「有 1 处变化没有记下」，状态面板里看得到原因（验收 7）', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    await append(scenario, nodeInput(null, '开局'));
    stubFetch([
      () =>
        stepResponse(
          '沈砚的口气忽然油滑起来。',
          tail({
            changes: {
              fieldChanges: [{ entry: '沈砚', field: '说话方式', value: '油嘴滑舌' }],
              newEntries: [],
              statusChanges: [],
              ocChanges: [],
              events: [],
              flags: [],
            },
          }),
        ),
    ]);
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    await user.click(screen.getByRole('button', { name: /^开局之后拔刀/ }));
    await findStepHeading(/^第 2 步/);
    expect(screen.getByText(/有 1 处变化没有记下/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '本线状态' }));
    const sheet = screen.getByRole('dialog', { name: '本线状态' });
    expect(
      within(sheet).getByText(/「沈砚」的「说话方式」是底层设定，本线不能改写，已丢弃/),
    ).toBeInTheDocument();
    // 世界观条目一个字都没变
    const oc = await harness.repository.getEntry(scenario.setup.cast[0]!.entryId);
    expect(oc!.fields.voice).toBe('话少');
  });
});

// ---------------------------------------------------------------- 本线状态与差异编辑

describe('本线状态与差异编辑（D6）', () => {
  it('差异编辑只列可变字段；保存后写进节点、世界观条目不变；后代提示「生成时依据的是旧事实」', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const root = await append(scenario, nodeInput(null, '开局'));
    const a = await append(scenario, nodeInput(root, '走a线', 0));
    await append(scenario, nodeInput(a, '走a线第二步', 0));
    await harness.repository.setScenarioCursor(scenario.id, a.id);
    const fetcher = stubFetch();
    renderScenario(scenario);
    await findStepHeading(/^第 2 步/);

    await user.click(screen.getByRole('button', { name: '本线状态' }));
    await user.click(
      within(screen.getByRole('dialog', { name: '本线状态' })).getByRole('button', {
        name: '编辑这一步的变化',
      }),
    );
    const editor = screen.getByRole('dialog', { name: '编辑第 2 步的变化' });
    await user.selectOptions(within(editor).getByLabelText('新增改写：条目'), '沈砚');
    const fieldSelect = within(editor).getByLabelText('字段（只列这条世界线能改写的）');
    const fieldOptions = within(fieldSelect)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(fieldOptions).toContain('身份');
    expect(fieldOptions).not.toContain('说话方式');
    expect(fieldOptions).not.toContain('性格');
    await user.selectOptions(fieldSelect, '身份');
    await user.type(within(editor).getByLabelText('新值'), '叛徒');
    await user.click(within(editor).getByRole('button', { name: '添加改写' }));
    await user.click(within(editor).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '编辑第 2 步的变化' })).not.toBeInTheDocument(),
    );

    const stored = (await harness.repository.listScenarioNodes(scenario.id)).find(
      (node) => node.id === a.id,
    )!;
    expect(stored.delta.fieldOverrides).toEqual([
      {
        target: { kind: 'world', entryId: scenario.setup.cast[0]!.entryId },
        fieldKey: 'identity',
        value: '叛徒',
      },
    ]);
    expect(stored.deltaEditedAt).not.toBeNull();
    expect(
      (await harness.repository.getEntry(scenario.setup.cast[0]!.entryId))!.fields.identity,
    ).toBe('船夫');

    await user.click(screen.getByRole('button', { name: '本线状态' }));
    expect(
      within(screen.getByRole('dialog', { name: '本线状态' })).getByText('沈砚 · 身份：叛徒'),
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('dialog', { name: '本线状态' })).getByRole('button', {
        name: '关闭',
      }),
    );

    await user.click(screen.getByRole('button', { name: /^去这条线/ }));
    await findStepHeading(/^第 3 步/);
    expect(screen.getByText(/生成时依据的是旧事实/)).toBeInTheDocument();
    expect(fetcher.count).toBe(0);
  });
});

describe('提升为世界观（设计 §7.1，验收 24）', () => {
  it('点「提升」只生成待确认项：知识库待确认区出现提案，世界观条目未变；不发请求', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const ocId = scenario.setup.cast[0]!.entryId;
    const root = await append(scenario, nodeInput(null, '开局'));
    await append(
      scenario,
      nodeInput(root, '走a线', 0, {
        delta: {
          ...emptyDelta(),
          fieldOverrides: [
            { target: { kind: 'world', entryId: ocId }, fieldKey: 'identity', value: '叛徒' },
          ],
        },
      }),
    );
    const fetcher = stubFetch();
    renderScenario(scenario);
    await findStepHeading(/^第 2 步/);

    await user.click(screen.getByRole('button', { name: '本线状态' }));
    const sheet = screen.getByRole('dialog', { name: '本线状态' });
    await user.click(
      within(sheet).getByRole('button', { name: '把「沈砚」的「身份」提升为世界观' }),
    );
    expect(await within(sheet).findByText('已生成待确认项，到知识库确认')).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: '把「沈砚」的「身份」提升为世界观' }),
    ).toBeDisabled();

    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      target: 'knowledgeEntry',
      action: 'replace',
      targetId: ocId,
      origin: 'refine',
    });
    expect((await harness.repository.getEntry(ocId))!.fields.identity).toBe('船夫');

    await user.click(within(sheet).getByRole('button', { name: '去知识库确认' }));
    expect(await screen.findByText('待确认 1 项')).toBeInTheDocument();
    expect((await harness.repository.getEntry(ocId))!.fields.identity).toBe('船夫');
    expect(fetcher.count).toBe(0);
  });

  it('字段后来改成锁定：点「提升」只说明原因，不生成提案（验收 10）', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const ocId = scenario.setup.cast[0]!.entryId;
    const root = await append(scenario, nodeInput(null, '开局'));
    await append(
      scenario,
      nodeInput(root, '走a线', 0, {
        delta: {
          ...emptyDelta(),
          fieldOverrides: [
            { target: { kind: 'world', entryId: ocId }, fieldKey: 'identity', value: '叛徒' },
          ],
        },
      }),
    );
    await harness.repository.updateEntry(ocId, { fieldLocks: { identity: 'locked' } });
    stubFetch();
    renderScenario(scenario);
    await findStepHeading(/^第 2 步/);

    await user.click(screen.getByRole('button', { name: '本线状态' }));
    const sheet = screen.getByRole('dialog', { name: '本线状态' });
    await user.click(
      within(sheet).getByRole('button', { name: '把「沈砚」的「身份」提升为世界观' }),
    );
    expect(
      await within(sheet).findByText('底层设定不能从世界线提升；要改请直接编辑条目'),
    ).toBeInTheDocument();
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 单套 DOM

describe('单套 DOM', () => {
  it('每个主要控件只渲染一份', async () => {
    const scenario = await seedScenario();
    await append(scenario, nodeInput(null, '开局'));
    stubFetch();
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    expect(screen.getAllByRole('navigation', { name: '当前路径' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2, name: /^第 \d+ 步 · / })).toHaveLength(1);
    expect(screen.getAllByRole('textbox', { name: '或者，写下主角要做的事' })).toHaveLength(1);
    for (const name of ['这样做', '世界线', '本线状态', '收尾', '返回写作页', '更多']) {
      expect(screen.getAllByRole('button', { name })).toHaveLength(1);
    }
    expect(screen.getAllByRole('button', { name: /^开局之后拔刀/ })).toHaveLength(1);
    expect(screen.getAllByText(/^本步依据 · 约 \d+ tokens$/)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 未开局

describe('还没有开局', () => {
  it('开局请求失败（500）：显示「还没有开局」与 alert，操作栏 disabled；点「开始」成功后出现第 1 步', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const fetcher = stubFetch([
      () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }),
      () => stepResponse('雾很大。', tail()),
    ]);
    renderScenario(scenario);

    expect(await screen.findByRole('heading', { name: '还没有开局' })).toBeInTheDocument();
    expect(screen.getByText('主角：沈砚')).toBeInTheDocument();
    for (const name of ['世界线', '本线状态', '收尾']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAccessibleDescription('开局之后可用');
    }
    expect(screen.queryByRole('navigation', { name: '当前路径' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '开始' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '还没有开局' })).toBeInTheDocument();
    expect(await harness.repository.listScenarioNodes(scenario.id)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '开始' }));
    await findStepHeading('第 1 步 · 开局');
    expect(fetcher.count).toBe(2);
    expect(screen.getByRole('button', { name: '世界线' })).toBeEnabled();
  });
});

// ---------------------------------------------------------------- 生成中离开

describe('生成中离开（F13.2）', () => {
  it('分块流进行到一半时点「返回写作页」：请求被取消，什么都不存', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const root = await append(scenario, nodeInput(null, '开局'));
    const fetcher = stubFetch([(init) => hangingResponse('雾里传来', init?.signal)]);
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    await user.click(screen.getByRole('button', { name: /^开局之后拔刀/ }));
    expect(await screen.findByText('雾里传来')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '返回写作页' }));
    await findWritingPage();
    await waitFor(() => expect(fetcher.signals[0]?.aborted).toBe(true));
    expect(await harness.repository.listScenarioNodes(scenario.id)).toHaveLength(1);
    expect((await harness.repository.getScenario(scenario.id))!.mainNodeId).toBe(root.id);
  });

  it('「停止」：回到选择前，不提示错误，什么都不存', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    await append(scenario, nodeInput(null, '开局'));
    stubFetch([(init) => hangingResponse('雾里传来', init?.signal)]);
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    await user.click(screen.getByRole('button', { name: /^开局之后拔刀/ }));
    await user.click(await screen.findByRole('button', { name: '停止' }));
    expect(await screen.findByRole('button', { name: /^开局之后拔刀/ })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await harness.repository.listScenarioNodes(scenario.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 本步依据

describe('本步依据（D5.4）', () => {
  it('取消一个推断条目后推进：user 不含该条目原文，system 与上一步逐字节相同', async () => {
    const user = userEvent.setup();
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '阿七',
      fields: { identity: '渡口的小乞丐' },
    });
    await harness.repository.createEntry(novel.id, {
      categoryId: worldCategory.id,
      title: '灵气',
      fields: { rules: '吐纳入体' },
      pinned: true,
    });
    const scenario = await seedScenario();
    await append(scenario, nodeInput(null, '阿七蹲在渡口'));
    const fetcher = stubFetch([
      () => stepResponse('阿七跟了上来。', tail({ options: optionsOf('带上阿七', '赶走阿七') })),
      () => stepResponse('两人走进雾里。', tail()),
    ]);
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    await user.click(screen.getByRole('button', { name: /^阿七蹲在渡口之后拔刀/ }));
    await findStepHeading(/^第 2 步/);
    expect(userOf(fetcher.bodies[0]!)).toContain('## 阿七（人物）');

    const summary = screen.getByText(/^本步依据 · 约 \d+ tokens$/);
    const before = Number(/约 (\d+) tokens/.exec(summary.textContent ?? '')![1]);
    await user.click(summary);
    const checkbox = screen.getByRole('checkbox', { name: '人物 · 阿七（推断）' });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText('已取消 1 条，下一步不会带上')).toBeInTheDocument();
    const after = Number(
      /约 (\d+) tokens/.exec(screen.getByText(/^本步依据 · 约 \d+ tokens$/).textContent ?? '')![1],
    );
    expect(after).toBeLessThan(before);

    await user.click(screen.getByRole('button', { name: /^带上阿七/ }));
    await findStepHeading(/^第 3 步/);
    expect(userOf(fetcher.bodies[1]!)).not.toContain('## 阿七（人物）');
    expect(userOf(fetcher.bodies[1]!)).not.toContain('渡口的小乞丐');
    expect(systemOf(fetcher.bodies[1]!)).toBe(systemOf(fetcher.bodies[0]!));
  });
});

// ---------------------------------------------------------------- 删除推演

describe('删除推演', () => {
  async function openDelete() {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(
      within(screen.getByRole('dialog', { name: '更多' })).getByRole('button', {
        name: '删除推演',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: '删除推演《雾中渡》？' });
    return { user, dialog };
  }

  it('复选框默认勾选：确认后推演没了、主角进回收站', async () => {
    const scenario = await seedScenario();
    await append(scenario, nodeInput(null, '开局'));
    stubFetch();
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    const { user, dialog } = await openDelete();
    expect(within(dialog).getByText(/全部 1 步和分支会被永久删除/)).toBeInTheDocument();
    const checkbox = within(dialog).getByRole('checkbox', {
      name: '同时把只属于这个推演的条目（含主角「沈砚」）移进回收站',
    });
    expect(checkbox).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: '删除' }));

    await findWritingPage();
    expect(await harness.repository.getScenario(scenario.id)).toBeUndefined();
    const oc = await harness.repository.getEntry(scenario.setup.cast[0]!.entryId);
    expect(oc!.deletedAt).not.toBeNull();
  });

  it('取消勾选再删除：主角条目仍在知识库', async () => {
    const scenario = await seedScenario();
    await append(scenario, nodeInput(null, '开局'));
    stubFetch();
    renderScenario(scenario);
    await findStepHeading('第 1 步 · 开局');

    const { user, dialog } = await openDelete();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: '删除' }));

    await findWritingPage();
    expect(await harness.repository.getScenario(scenario.id)).toBeUndefined();
    const oc = await harness.repository.getEntry(scenario.setup.cast[0]!.entryId);
    expect(oc!.deletedAt).toBeNull();
  });
});

// ---------------------------------------------------------------- 回退不发请求（T5 补强）

describe('回退不发请求（T5 补强，design-addendum 第 5 条）', () => {
  it('12 步路径、第 5 步缺摘要：挂载 / 面包屑 / 换线 / 本线状态全程 0 次请求；推进时先且只发 1 次 summary，完成后才发 step', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenario();
    const main: ScenarioNode[] = [];
    main.push(await append(scenario, nodeInput(null, '第1步')));
    main.push(await append(scenario, nodeInput(main[0]!, '第2步', 0)));
    // 第 2 步的另一条分支，先建：之后主线一路推进到第 12 步
    await append(scenario, nodeInput(main[1]!, '岔路', 1));
    for (let depth = 2; depth < 12; depth += 1) {
      main.push(await append(scenario, nodeInput(main[depth - 1]!, `第${depth + 1}步`, 0)));
    }
    // 第 10 步（depth 9）有摘要，第 5 步（depth 4）缺：gap = depth 0–8 共 9 步 > 7，按 D5.3 同步补
    await harness.repository.setScenarioNodeSummary(main[9]!.id, {
      text: '前情到第十步',
      openThreads: [],
    });
    expect((await harness.repository.getScenario(scenario.id))!.mainNodeId).toBe(main[11]!.id);

    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const fetcher = stubFetch();
    renderScenario(scenario);
    await findStepHeading(/^第 12 步/);

    await user.click(crumbs().getByRole('button', { name: '第 3 步' }));
    await findStepHeading('第 3 步 · 你选择了：第2步之后拔刀');
    await user.click(screen.getByRole('button', { name: '世界线' }));
    await user.click(
      within(screen.getByRole('dialog', { name: '世界线' })).getByRole('button', {
        name: '去这条线的最新一步（选「第2步之后跳江」）',
      }),
    );
    await findStepHeading('第 3 步 · 你选择了：第2步之后跳江');
    await user.click(screen.getByRole('button', { name: '本线状态' }));
    const state = screen.getByRole('dialog', { name: '本线状态' });
    await user.click(within(state).getByRole('button', { name: '关闭' }));
    await user.click(screen.getByRole('button', { name: '回到主线最新一步' }));
    await findStepHeading(/^第 12 步/);
    expect(fetcher.count).toBe(0);

    fetcher.push(
      async () => {
        await summaryGate;
        return jsonResponse(
          completion(
            JSON.stringify({ summary: '沈砚一路追到了江心。', openThreads: ['船夫去向'] }),
          ),
        );
      },
      () => stepResponse('第十三步的情节。', tail()),
    );
    await user.click(screen.getByRole('button', { name: /^第12步之后拔刀/ }));
    await waitFor(() => expect(fetcher.count).toBe(1));
    expect(fetcher.bodies[0]!.stream).toBe(false);
    expect(userOf(fetcher.bodies[0]!)).toContain('【上一段前情】（从开局写起）');
    expect(await screen.findByText('正在整理前情…')).toBeInTheDocument();
    // summary 还没回来：step 请求不能先发，也不能并发
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetcher.count).toBe(1);

    await act(async () => releaseSummary());
    await findStepHeading(/^第 13 步/);
    expect(fetcher.count).toBe(2);
    expect(fetcher.bodies[1]!.stream).toBe(true);
    const nodes = await harness.repository.listScenarioNodes(scenario.id);
    expect(nodes.find((node) => node.id === main[4]!.id)!.pathSummary).toEqual({
      text: '沈砚一路追到了江心。',
      openThreads: ['船夫去向'],
    });
  });
});

// ---------------------------------------------------------------- 落点与空状态

describe('落点回落与空状态（§8.3 第 0 项）', () => {
  it('cursorNodeId 为 null 时落在主线末端，不写库', async () => {
    const scenario = await seedScenario();
    let parent: ScenarioNode | null = null;
    for (let depth = 0; depth < 4; depth += 1)
      parent = await append(scenario, nodeInput(parent, `第${depth + 1}步`));
    await harness.database.scenarios.update(scenario.id, { cursorNodeId: null });
    const fetcher = stubFetch();
    renderScenario(scenario);

    await findStepHeading('第 4 步 · 你选择了：第3步之后拔刀');
    expect((await harness.repository.getScenario(scenario.id))!.cursorNodeId).toBeNull();
    expect(fetcher.count).toBe(0);
  });

  it('cursorNodeId 与 mainNodeId 都无效时落在根节点，不写库', async () => {
    const scenario = await seedScenario();
    const root = await append(scenario, nodeInput(null, '开局'));
    await append(scenario, nodeInput(root, '第二步'));
    await harness.database.scenarios.update(scenario.id, {
      cursorNodeId: 'missing-cursor',
      mainNodeId: 'missing-main',
    });
    stubFetch();
    renderScenario(scenario);

    await findStepHeading('第 1 步 · 开局');
    const stored = (await harness.repository.getScenario(scenario.id))!;
    expect(stored.cursorNodeId).toBe('missing-cursor');
    expect(stored.mainNodeId).toBe('missing-main');
  });

  it('推演不存在：显示「这个推演已不存在」，「回写作页」可用', async () => {
    const user = userEvent.setup();
    renderApp('/write/scenario/not-exist');
    expect(await screen.findByText('这个推演已不存在')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '回写作页' }));
    await findWritingPage();
  });

  it('推演属于另一部作品：提示并给「去书架」', async () => {
    const scenario = await seedScenario();
    const other = await harness.repository.createNovel({ title: '别的书' });
    useActiveNovel.setState({ activeNovelId: other.id });
    renderScenario(scenario);
    expect(await screen.findByText('这个推演属于另一部作品')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去书架' })).toBeInTheDocument();
  });

  it('没有当前作品：RequireNovel 的空状态', async () => {
    const scenario = await seedScenario();
    useActiveNovel.setState({ activeNovelId: null });
    renderScenario(scenario);
    expect(await screen.findByText('还没有选定作品')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: '互动推演' })).toBeInTheDocument();
  });
});
