import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/app/AppShell';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { ScenarioNodeInput } from '@/data/NovelRepository';
import {
  emptyDelta,
  type Category,
  type Novel,
  type Scenario,
  type ScenarioNode,
} from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';

/**
 * 「沉淀这条线」面板（设计 §7.2、T7）：打开只做本地计算，点「生成大纲」才发请求；
 * 结果是一个 scenarioOutline 提案，采用前大纲与外传都不变，采用后才写入。
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

const option = (id: string) => ({
  id,
  text: `选${id}`,
  tendency: 'bold' as const,
  risk: 'low' as const,
  batch: 0,
});

function nodeInput(parent: ScenarioNode | null, plot: string, optionId = 'n'): ScenarioNodeInput {
  return {
    parentId: parent?.id ?? null,
    arrivedBy: parent ? { kind: 'option', optionId, text: `选${optionId}` } : { kind: 'start' },
    plot,
    challenge: `挑战：${plot}`,
    options: [option('a'), option('b'), option('n')],
    delta: emptyDelta(),
    notices: [],
    progress: { reachedMilestoneIds: [], note: '' },
    ending: null,
  };
}

/** 主线三步：开局 → a → n；光标停在第 3 步（在主线上，沉淀为主线大纲） */
async function seedMainLine(): Promise<{ scenario: Scenario; steps: ScenarioNode[] }> {
  const scenario = await harness.repository.createScenario(novel.id, {
    title: '雾中渡',
    setup: {
      cast: [{ entryId: '' }],
      start: { time: '', place: '渡口', situation: '在渡口醒来' },
      goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
      milestones: [],
      tone: '',
      expectedSteps: 30,
    },
    newOc: { categoryId: characterCategory.id, title: '沈砚', fields: { voice: '话少' } },
  });
  const steps: ScenarioNode[] = [];
  let parent: ScenarioNode | null = null;
  for (const [index, plot] of [
    '沈砚在渡口醒来。',
    '岸边有一串脚印。',
    '脚印通向一条空船。',
  ].entries()) {
    const { node } = await harness.repository.appendScenarioNode(
      scenario.id,
      nodeInput(parent, plot, index === 1 ? 'a' : 'n'),
    );
    steps.push(node);
    parent = node;
  }
  return { scenario, steps };
}

const OUTLINE_RESULT = {
  sideTitle: '',
  sideSynopsis: '',
  volumes: [
    {
      title: '第一卷 渡口',
      synopsis: '渡口的事。',
      targetWords: null,
      chapters: [
        {
          title: '第1章 雾里的船',
          synopsis: '沈砚循着脚印找到空船。',
          keyEvents: ['找到空船'],
          appearing: [],
          fromStep: 1,
          toStep: 3,
          targetWords: 3000,
        },
      ],
    },
  ],
};

async function openSediment(scenario: Scenario) {
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
  await within(sheet).findByText('沉淀为本书主线大纲');
  return { user, sheet };
}

describe('沉淀这条线（主线）', () => {
  it('打开面板只显示范围与预估，点「生成大纲」前不发请求', async () => {
    const { scenario } = await seedMainLine();
    const spy = vi.spyOn(globalThis, 'fetch');
    const { sheet } = await openSediment(scenario);
    expect(within(sheet).getByText('沉淀第 1–3 步，共 3 步')).toBeInTheDocument();
    expect(within(sheet).getByText(/^预估输入 /)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: '生成大纲' })).toBeEnabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('生成后成为待确认提案：采用前大纲不变，采用后卷 / 章写入、章带溯源', async () => {
    const { scenario, steps } = await seedMainLine();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(completion(JSON.stringify(OUTLINE_RESULT)))),
      );
    const { user, sheet } = await openSediment(scenario);
    await user.click(within(sheet).getByRole('button', { name: '生成大纲' }));

    const accept = await within(sheet).findByRole('button', { name: /^采用这份大纲/ });
    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(spy.mock.calls[0]?.[1]?.body ?? '{}')) as {
      messages: { role: string; content: string }[];
    };
    const user0 = body.messages.find((message) => message.role === 'user')?.content ?? '';
    // 步骤按绝对步数标注，原文都在
    expect(user0).toContain('第 1 步');
    expect(user0).toContain('脚印通向一条空船。');
    expect(await harness.repository.listOutline(novel.id)).toHaveLength(0);
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(1);

    await user.click(accept);
    await waitFor(async () =>
      expect(await harness.repository.listOutline(novel.id)).toHaveLength(2),
    );
    const outline = await harness.repository.listOutline(novel.id);
    const volume = outline.find((node) => node.parentId === null)!;
    const chapter = outline.find((node) => node.parentId === volume.id)!;
    expect(volume).toMatchObject({ title: '第一卷 渡口', scenarioSource: null });
    expect(chapter).toMatchObject({
      title: '第1章 雾里的船',
      targetWords: 3000,
      scenarioSource: { scenarioId: scenario.id, nodeIds: steps.map((node) => node.id) },
    });
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(0);
    expect(await harness.repository.listSideStories(novel.id)).toHaveLength(0);
  });

  it('其中一段已沉淀为外传后又成了主线：提示是哪几步、哪部外传，仍可沉淀进主线（设计 §11）', async () => {
    const { scenario, steps } = await seedMainLine();
    // 第 2–3 步当初不在主线上时沉淀成了外传《雾中》，之后这条线成了主线
    await harness.repository.commitScenarioOutline(novel.id, {
      scenarioId: scenario.id,
      mode: 'side',
      appendToSideStoryId: null,
      title: '雾中',
      synopsis: '另一条线',
      forkNodeId: steps[0]!.id,
      chapters: [{ title: '第1章', nodeIds: [steps[1]!.id, steps[2]!.id], brief: '' }],
    });
    const spy = vi.spyOn(globalThis, 'fetch');
    const { sheet } = await openSediment(scenario);
    expect(within(sheet).getByText('沉淀第 1–3 步，共 3 步')).toBeInTheDocument();
    expect(within(sheet).getByText('其中第 2–3 步已沉淀为外传《雾中》')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: '生成大纲' })).toBeEnabled();
    expect(spy).not.toHaveBeenCalled();
  });
});
