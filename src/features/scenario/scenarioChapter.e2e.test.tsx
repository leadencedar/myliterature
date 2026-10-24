import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/app/AppShell';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { ScenarioNodeInput } from '@/data/NovelRepository';
import {
  emptyDelta,
  type Category,
  type KnowledgeEntry,
  type Novel,
  type Scenario,
  type ScenarioNode,
  type WorldlineDelta,
} from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { applyProposal } from '@/proposal/apply';
import { buildCreateProposal } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import { formatSideStory } from '@/features/export/exportText';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { WritingPage } from '../writing/WritingPage';

/**
 * 从一局推演到一章正文（设计 §13.2 scenarioChapter 一节 + design-addendum 第 2 条）：
 * 沉淀后的章节在「写这一章」时带上推演材料，段落加工不带；外传记住分叉点；换主线后旧大纲有标记。
 * 模型调用一律 stub fetch，断言落在真正发出去的请求体上。
 */

let harness: TestHarness;
let novel: Novel;
let characterCategory: Category;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  characterCategory = (await harness.repository.listCategories(novel.id))[1]!;
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

interface RequestBody {
  stream?: boolean;
  messages: { role: string; content: string }[];
}

/** 流式（整章生成、段落加工）回一段正文，结构化（沉淀大纲）回给定 JSON */
function stubFetch(structured: unknown = {}) {
  const bodies: RequestBody[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as RequestBody;
    bodies.push(body);
    return Promise.resolve(
      body.stream
        ? sseResponse(textDeltaEvents(['生成的正文。']))
        : jsonResponse(completion(JSON.stringify(structured))),
    );
  });
  return { spy, bodies };
}

const userOf = (body: RequestBody | undefined) =>
  body?.messages.find((message) => message.role === 'user')?.content ?? '';
const systemOf = (body: RequestBody | undefined) =>
  body?.messages.find((message) => message.role === 'system')?.content ?? '';

const option = (id: string) => ({
  id,
  text: `选${id}`,
  tendency: 'bold' as const,
  risk: 'low' as const,
  batch: 0,
});

function nodeInput(
  parent: ScenarioNode | null,
  plot: string,
  optionId = 'n',
  delta: Partial<WorldlineDelta> = {},
): ScenarioNodeInput {
  return {
    parentId: parent?.id ?? null,
    arrivedBy: parent ? { kind: 'option', optionId, text: `选${optionId}` } : { kind: 'start' },
    plot,
    challenge: `挑战：${plot}`,
    options: [option('a'), option('b'), option('n')],
    delta: { ...emptyDelta(), ...delta },
    notices: [],
    progress: { reachedMilestoneIds: [], note: '' },
    ending: null,
  };
}

async function append(scenario: Scenario, input: ScenarioNodeInput): Promise<ScenarioNode> {
  return (await harness.repository.appendScenarioNode(scenario.id, input)).node;
}

function createScenario(
  castEntryId: string,
  newOc?: { title: string; fields: Record<string, string> },
) {
  return harness.repository.createScenario(novel.id, {
    title: '雾中渡',
    setup: {
      cast: [{ entryId: castEntryId }],
      start: { time: '', place: '渡口', situation: '在渡口醒来' },
      goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
      milestones: [],
      tone: '',
      expectedSteps: 30,
    },
    ...(newOc ? { newOc: { categoryId: characterCategory.id, ...newOc } } : {}),
  });
}

/**
 * 新建 OC「沈砚」开局，主线 6 步沉淀成两章（第 1–4 步、第 5–6 步）。限定到本推演的预设人物「青衣客」
 * 在 revealAt 步（绝对步数）揭示；revealAt = 2 时第 3 步原文提到他
 */
async function seedMainSediment(revealAt: 2 | 6) {
  const scenario = await createScenario('', {
    title: '沈砚',
    fields: { identity: '渡口船夫', voice: '话少，爱用反问' },
  });
  const preset = await harness.repository.createEntry(novel.id, {
    categoryId: characterCategory.id,
    title: '青衣客',
    scope: {
      kind: 'limited',
      targets: [{ scenarioId: scenario.id, fromNodeId: null, revealHint: '有人在渡口打听船夫时' }],
    },
    fields: { voice: '说话带江南口音' },
  });
  const reveal: Partial<WorldlineDelta> = {
    statusChanges: [
      { target: { kind: 'world', entryId: preset.id }, status: 'revealed', note: '' },
    ],
  };
  const plots = [
    '沈砚在渡口醒来。',
    '有人在打听船夫。',
    revealAt === 2 ? '青衣客走上船来。' : '船上空无一人。',
    '船离岸，江上起雾。',
    '江心起雾。',
    '雾散了。',
  ];
  const steps: ScenarioNode[] = [];
  let parent: ScenarioNode | null = null;
  for (const [index, plot] of plots.entries()) {
    const delta: Partial<WorldlineDelta> = {
      ...(index + 1 === revealAt ? reveal : {}),
      ...(index === 3 ? { events: ['渡江'] } : {}),
    };
    parent = await append(scenario, nodeInput(parent, plot, 'n', delta));
    steps.push(parent);
  }
  await applyProposal(
    harness.repository,
    buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'scenarioOutline',
      label: '沉淀为主线大纲 · 推演《雾中渡》第 1–6 步',
      specs: fieldSpecsFor('scenarioOutline'),
      payload: {
        scenarioId: scenario.id,
        mode: 'main',
        range: { from: 1, to: 6 },
        nodeIds: steps.map((node) => node.id),
        forkNodeId: null,
        appendToSideStoryId: null,
        sideTitle: '',
        sideSynopsis: '',
        outlineText: [
          '# 第一卷 渡口',
          '渡口的事。',
          '## 第1章 雾里的船',
          '沈砚上了船。',
          '对应步骤：1–4',
          '## 第2章 江心',
          '雾散。',
          '对应步骤：5–6',
        ].join('\n'),
      },
    }),
  );
  const chapterNode = (await harness.repository.listOutline(novel.id)).find(
    (node) => node.title === '第1章 雾里的船',
  )!;
  return { scenario, steps, chapterNode, preset };
}

async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
}

/** 从大纲节点进入编辑器（首次进入会建章节） */
async function enterFromOutline(title: string) {
  const user = userEvent.setup();
  harness.renderUI(<WritingPage />);
  await waitForLoaded();
  await user.click(await screen.findByRole('button', { name: `编辑「${title}」` }));
  await user.click(await screen.findByRole('button', { name: '写这一章' }));
  await screen.findByLabelText('章节正文');
  return user;
}

/** 打开「生成本章」，等推演材料读回来（清单里出现步骤原文那一项） */
async function openGenerate(user: ReturnType<typeof userEvent.setup>, stepsLabel: string) {
  await user.click(screen.getByRole('button', { name: '生成本章' }));
  const dialog = await screen.findByRole('dialog', { name: '生成本章正文' });
  await within(dialog).findByText(stepsLabel);
  return dialog;
}

// ---------------------------------------------------------------- 主线

describe('新建 OC 开局 → 主线沉淀 → 写这一章（验收 26）', () => {
  it('注入清单有三项推演材料；请求含步骤原文与 OC 的身份、说话方式；采用前正文不变', async () => {
    await seedMainSediment(6);
    const user = await enterFromOutline('第1章 雾里的船');
    const dialog = await openGenerate(user, '互动推演 · 第 1–4 步原文');
    expect(within(dialog).getByText('推演专属设定（主角『沈砚』等 1 条）')).toBeInTheDocument();
    expect(within(dialog).getByText('世界线状态')).toBeInTheDocument();
    // 主线章节没有分叉前情
    expect(within(dialog).queryByText('分叉之前的经过')).not.toBeInTheDocument();

    const { bodies } = stubFetch();
    await user.click(within(dialog).getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    const userText = userOf(bodies[0]);
    expect(userText).toContain('【本章依据的互动推演】');
    expect(userText).toContain('船离岸，江上起雾。');
    // 下一章的步骤不进本章
    expect(userText).not.toContain('雾散了。');
    expect(userText).toContain('渡口船夫');
    expect(userText).toContain('话少，爱用反问');
    expect(userText).toContain('渡江');
    // 推演材料只在易变后缀，前缀与没有推演时同一写法
    expect(systemOf(bodies[0])).not.toContain('【本章依据的互动推演】');

    const [chapter] = await harness.repository.listChapters(novel.id);
    expect(chapter!.content).toBe('');
  });

  it('本章第 2 步揭示、第 3 步提到的预设人物：请求含他的字段原文，计数包含他', async () => {
    await seedMainSediment(2);
    const user = await enterFromOutline('第1章 雾里的船');
    const dialog = await openGenerate(user, '互动推演 · 第 1–4 步原文');
    expect(within(dialog).getByText('推演专属设定（主角『沈砚』等 2 条）')).toBeInTheDocument();

    const { bodies } = stubFetch();
    await user.click(within(dialog).getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    expect(userOf(bodies[0])).toContain('说话带江南口音');
  });

  it('对照：预设人物到第 6 步（下一章）才揭示时，本章请求不含他', async () => {
    await seedMainSediment(6);
    const user = await enterFromOutline('第1章 雾里的船');
    const dialog = await openGenerate(user, '互动推演 · 第 1–4 步原文');
    const { bodies } = stubFetch();
    await user.click(within(dialog).getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    expect(JSON.stringify(bodies[0])).not.toContain('说话带江南口音');
  });

  it('同一章的段落加工：请求不含推演材料', async () => {
    const { chapterNode } = await seedMainSediment(2);
    await harness.repository.createChapter(novel.id, {
      title: '第1章 雾里的船',
      content: '第一段的内容。\n\n第二段的内容。',
      outlineNodeId: chapterNode.id,
    });
    const user = userEvent.setup();
    harness.renderUI(<WritingPage />);
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: '继续写第 1 章' }));
    await screen.findByLabelText('章节正文');
    // 先确认推演材料已经读回来、整章生成会带上它，再看段落加工
    const generate = await openGenerate(user, '互动推演 · 第 1–4 步原文');
    await user.click(within(generate).getByRole('button', { name: '关闭' }));

    const { bodies } = stubFetch();
    const textarea = screen.getByLabelText('章节正文') as HTMLTextAreaElement;
    const start = textarea.value.indexOf('第二段的内容。');
    textarea.setSelectionRange(start, start + '第二段的内容。'.length);
    await user.click(screen.getByRole('button', { name: '加工这一段' }));
    const revise = await screen.findByRole('dialog', { name: '加工这一段' });
    await user.click(within(revise).getByRole('button', { name: '开始改写' }));
    await screen.findByLabelText('结果（可直接修改）');
    const all = JSON.stringify(bodies[0]);
    expect(all).not.toContain('【本章依据的互动推演】');
    expect(all).not.toContain('【本章涉及的推演专属设定】');
    expect(all).not.toContain('说话带江南口音');
  });

  it('主线换到另一条线后，旧主线沉淀的大纲显示「来自旧主线」，章节正文仍在（验收 28）', async () => {
    const { scenario, steps, chapterNode } = await seedMainSediment(6);
    await harness.repository.createChapter(novel.id, {
      title: '第1章 雾里的船',
      content: '已经写好的正文。',
      outlineNodeId: chapterNode.id,
    });
    // 在开局的另一个选项上推进一步：主线跟随最新推进的一条
    await append(scenario, nodeInput(steps[0]!, '他回船舱躲雨。', 'b'));

    const user = userEvent.setup();
    harness.renderUI(<WritingPage />);
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: '编辑「第1章 雾里的船」' }));
    expect(await screen.findByText(/^来自旧主线/)).toBeInTheDocument();
    const [chapter] = await harness.repository.listChapters(novel.id);
    expect(chapter!.content).toBe('已经写好的正文。');
  });
});

// ---------------------------------------------------------------- 外传

describe('通用人物开局 → 沉淀为外传 → 写这一章（design-addendum 第 2 条、验收 27）', () => {
  it('外传记住分叉点；第 1 章请求含主角「说话方式」与【分叉之前的经过】；导出外传不含分叉前情节', async () => {
    // 通用人物当主角：外传章节没有大纲节点，简介与步骤原文也都不提他的名字 ——
    // 只有 castEntryIds 能把他的档案带进「写这一章」
    const pei: KnowledgeEntry = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '裴照',
      fields: { identity: '江湖客', voice: '冷淡，句尾常带一声冷笑' },
    });
    const scenario = await createScenario(pei.id);
    const root = await append(scenario, nodeInput(null, '他在渡口醒来，雾很浓。'));
    const b1 = await append(scenario, nodeInput(root, '他沿着江岸往下游走。', 'b'));
    const b2 = await append(scenario, nodeInput(b1, '下游有一座废弃的码头。'));
    // 后推进的 a 线成为主线，b 线成了旁支
    await append(scenario, nodeInput(root, '他回船舱躲雨。', 'a'));
    await harness.repository.setScenarioCursor(scenario.id, b2.id);

    const sideOutline = {
      sideTitle: '雾中另一程',
      sideSynopsis: '从渡口分出去的一条线。',
      volumes: [
        {
          title: '外传',
          synopsis: '',
          targetWords: null,
          chapters: [
            {
              title: '第1章 废码头',
              synopsis: '沿江而下，找到废弃的码头。',
              keyEvents: [],
              appearing: [],
              fromStep: 2,
              toStep: 3,
              targetWords: null,
            },
          ],
        },
      ],
    };
    const { spy, bodies } = stubFetch(sideOutline);

    const user = userEvent.setup();
    harness.renderUI(<AppShell />, `/write/scenario/${scenario.id}`);
    await screen.findByRole('heading', { level: 2, name: /^第 3 步 · / });
    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(
      within(screen.getByRole('dialog', { name: '更多' })).getByRole('button', {
        name: '沉淀这条线',
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: '沉淀这条线' });
    expect(await within(sheet).findByText('这一步不在主线上，沉淀为外传')).toBeInTheDocument();
    expect(within(sheet).getByText('沉淀第 2–3 步，共 2 步')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();

    await user.click(within(sheet).getByRole('button', { name: '生成大纲' }));
    await user.click(await within(sheet).findByRole('button', { name: /^采用这份大纲/ }));
    await waitFor(async () =>
      expect(await harness.repository.listSideStories(novel.id)).toHaveLength(1),
    );
    const [story] = await harness.repository.listSideStories(novel.id);
    expect(story).toMatchObject({
      title: '雾中另一程',
      scenarioSource: { scenarioId: scenario.id, forkNodeId: root.id },
    });

    // 回写作页，打开外传第 1 章「写这一章」
    await user.click(within(sheet).getByRole('button', { name: '关闭' }));
    await user.click(screen.getByRole('button', { name: '返回写作页' }));
    const card = await screen.findByRole('region', { name: '外传·雾中另一程' });
    await user.click(
      await within(card).findByRole('button', { name: '继续写外传《雾中另一程》第 1 章' }),
    );
    await screen.findByRole('dialog', { name: '编辑外传《雾中另一程》第 1 章' });
    const dialog = await openGenerate(user, '互动推演 · 第 2–3 步原文');
    expect(within(dialog).getByText('分叉之前的经过')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    const body = bodies[bodies.length - 1]!;
    expect(body.stream).toBe(true);
    // 通用主角进了默认预选：他的「说话方式」原文随请求发出
    expect(systemOf(body)).toContain('## 裴照（人物）');
    expect(JSON.stringify(body)).toContain('冷淡，句尾常带一声冷笑');
    const userText = userOf(body);
    expect(userText).toContain('【分叉之前的经过');
    expect(userText).toContain('他在渡口醒来，雾很浓。');
    expect(userText).toContain('本章细纲：沿江而下，找到废弃的码头。');
    expect(userText).toContain('下游有一座废弃的码头。');
    // 主线（a 线）的步骤不进外传
    expect(userText).not.toContain('他回船舱躲雨。');

    await user.click(screen.getByRole('button', { name: '采用为正文' }));
    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters.find((chapter) => chapter.sideStoryId === story!.id)?.content).toBe(
        '生成的正文。',
      );
    });
    const chapters = (await harness.repository.listChapters(novel.id)).filter(
      (chapter) => chapter.sideStoryId === story!.id,
    );
    const exported = formatSideStory(novel, story!, chapters, { format: 'txt' });
    expect(exported).toContain('生成的正文。');
    expect(exported).not.toContain('他在渡口醒来');
    expect(exported).not.toContain('分叉之前的经过');
  });
});
