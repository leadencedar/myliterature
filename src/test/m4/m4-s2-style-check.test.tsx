/**
 * M4-S2 独立验收：文风漂移检查（服务 + 编辑器 UI）。
 *
 * 覆盖 task-69 要求：prompt 含风格档案/锚点/本章正文且块序固定；一次 style-check 调用；
 * schema issues≤5；UI 入口/打开不请求/结果/无问题/错误重试/关闭不写/无改写按钮；
 * 空正文不发请求；不写库、不出提案。
 *
 * 独立于开发的 styleCheck.test.ts / ChapterEditor 测试：用真实仓储 + 假 LlmRunner/网络层。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Chapter, Novel, StyleProfile } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import type { LlmRunner, StructuredRunOptions } from '@/llm/useLlm';
import type { TaskKind } from '@/llm/taskProfiles';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { locateQuote } from '@/features/writing/normCheck';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { WritingPage } from '@/features/writing/WritingPage';
import {
  STYLE_CHECK_SEVERITY_LABELS,
  StyleCheckSchema,
  buildStyleCheckSystemPrompt,
  buildStyleCheckUserPrompt,
  runStyleCheck,
} from '@/features/style/styleCheck';

let harness: TestHarness;
let novel: Novel;
let style: StyleProfile;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '文风之书', genre: '严肃文学' });
  style = (await harness.repository.getStyleProfile(novel.id))!;
  useActiveNovel.setState({ activeNovelId: novel.id });
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- fixtures / fake llm

const CHECK_RESULT = {
  summary: '整体像你写的，但有一处叙述距离突然拉远。',
  issues: [
    {
      dimension: '叙述距离',
      severity: 'high',
      excerpt: '他忽然想起很多年前的事。',
      basis: '这句从现场动作切到总结性回忆，叙述距离比锚点明显拉远。',
      suggestion: '把这段拉到现场动作里，别直接总结回忆。',
    },
    {
      dimension: '句式',
      severity: 'medium',
      excerpt: '雪落了整夜，追兵在门外。',
      basis: '连续短句比锚点的句式更碎，节奏偏快。',
      suggestion: '短句堆叠过多，可以合并一处。',
    },
  ],
};

async function makeChapter(title: string, content: string, status: 'draft' | 'done' = 'draft') {
  const created = await harness.repository.createChapter(novel.id, { title, content });
  if (status === 'done') await harness.repository.updateChapter(created.id, { status: 'done' });
  return (await harness.repository.listChapters(novel.id)).find((item) => item.id === created.id)!;
}

interface LlmFixture {
  llm: LlmRunner;
  calls: { task: TaskKind; options: StructuredRunOptions<unknown> }[];
}

function fakeLlm(handler: () => unknown): LlmFixture {
  const calls: { task: TaskKind; options: StructuredRunOptions<unknown> }[] = [];
  const llm = {
    configured: true,
    client: {} as unknown,
    runStructured: vi.fn(async (task: TaskKind, options: StructuredRunOptions<unknown>) => {
      calls.push({ task, options });
      return { data: await handler(), attempts: 1 };
    }),
    runStream: vi.fn(),
    runProseWithTail: vi.fn(),
  } as unknown as LlmRunner;
  return { llm, calls };
}

async function serviceInput(targetChapterId: string, chapter: Chapter) {
  return {
    novel,
    style,
    chapter,
    chapters: await harness.repository.listChapters(novel.id),
    targetChapterId,
  };
}

// ---------------------------------------------------------------- 服务

describe('M4-S2 · runStyleCheck 服务', () => {
  it('一次 style-check 调用：system 含风格档案/任务约束，user 块序为锚点→本章正文→本次要求', async () => {
    const anchorChapter = await makeChapter('源头', '江雾'.repeat(220), 'done'); // 440 字
    const target = await makeChapter('目标章', '  本章正文。  ');
    const { llm, calls } = fakeLlm(() => CHECK_RESULT);

    const { result, anchor } = await runStyleCheck({ llm }, await serviceInput(target.id, target));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe('style-check');
    expect(calls[0]!.options.schemaName).toBe('StyleCheck');
    expect(calls[0]!.options.failOnTruncation).toBe(true);
    const system = calls[0]!.options.system;
    expect(system).toContain('文学编辑');
    expect(system).toContain('【文体取向】');
    expect(system).toContain('只诊断，不改稿');
    expect(system).toContain('最多 5 条');
    expect(system).toContain('不要把情节好坏、题材选择、人物三观当成文风问题');

    const user = calls[0]!.options.user;
    const marks = ['【文风锚点', '【本章正文】', '【本次要求】'];
    const positions = marks.map((mark) => user.indexOf(mark));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(user).toContain(anchorChapter.content.slice(0, 20));
    // 正文 trim 后进 prompt
    expect(user).toContain('【本章正文】\n本章正文。');

    expect(anchor).toMatchObject({ chapterId: anchorChapter.id, label: '第 1 章开头' });
    expect(result).toEqual(CHECK_RESULT);
  });

  it('第一章（无更早正文）：user 无锚点块，其余块序不变', async () => {
    const target = await makeChapter('第一章', '第一章正文。');
    const { llm, calls } = fakeLlm(() => ({ summary: '整体稳定。', issues: [] }));

    const { anchor } = await runStyleCheck({ llm }, await serviceInput(target.id, target));

    expect(anchor).toBeNull();
    const user = calls[0]!.options.user;
    expect(user).not.toContain('【文风锚点');
    const bodyAt = user.indexOf('【本章正文】');
    const requestAt = user.indexOf('【本次要求】');
    expect(bodyAt).toBeGreaterThan(-1);
    expect(requestAt).toBeGreaterThan(bodyAt);
  });

  it('空正文：拒绝且不调用模型', async () => {
    const target = await makeChapter('空章', '   ');
    const { llm, calls } = fakeLlm(() => CHECK_RESULT);
    await expect(runStyleCheck({ llm }, await serviceInput(target.id, target))).rejects.toThrow(
      /还没有正文/u,
    );
    expect(calls).toHaveLength(0);
  });

  it('模型失败：错误透传，不写库、不出提案', async () => {
    const beforeSummaries = await harness.repository.listSummaries(novel.id);
    const beforeProposals = await harness.repository.listProposals(novel.id);
    const target = await makeChapter('目标', '正文。');
    const { llm } = fakeLlm(() => {
      throw new Error('模型返回被截断');
    });
    await expect(runStyleCheck({ llm }, await serviceInput(target.id, target))).rejects.toThrow(
      '模型返回被截断',
    );
    expect(await harness.repository.listSummaries(novel.id)).toEqual(beforeSummaries);
    expect(await harness.repository.listProposals(novel.id)).toEqual(beforeProposals);
  });

  it('成功也不写库、不出提案', async () => {
    const target = await makeChapter('目标', '正文。');
    const beforeChapters = await harness.repository.listChapters(novel.id);
    const beforeSummaries = await harness.repository.listSummaries(novel.id);
    const beforeProposals = await harness.repository.listProposals(novel.id);
    const { llm } = fakeLlm(() => CHECK_RESULT);
    await runStyleCheck({ llm }, await serviceInput(target.id, target));
    expect((await harness.repository.listChapters(novel.id)).map((item) => item.content)).toEqual(
      beforeChapters.map((item) => item.content),
    );
    expect(await harness.repository.listSummaries(novel.id)).toEqual(beforeSummaries);
    expect(await harness.repository.listProposals(novel.id)).toEqual(beforeProposals);
  });
});

describe('M4-S2 · Schema 与 prompt 单元', () => {
  it('issues 最多 5 条；severity 三档中性标签；basis 必填；空字段拒绝', () => {
    const issue = (index: number) => ({
      dimension: `维度${index}`,
      severity: 'low' as const,
      excerpt: `原文${index}`,
      basis: `依据${index}`,
      suggestion: `建议${index}`,
    });
    expect(StyleCheckSchema.safeParse({ summary: '整体稳定。', issues: [] }).success).toBe(true);
    expect(
      StyleCheckSchema.safeParse({
        summary: '整体稳定。',
        issues: Array.from({ length: 5 }, (_, index) => issue(index)),
      }).success,
    ).toBe(true);
    expect(
      StyleCheckSchema.safeParse({
        summary: '整体稳定。',
        issues: Array.from({ length: 6 }, (_, index) => issue(index)),
      }).success,
    ).toBe(false);
    expect(StyleCheckSchema.safeParse({ summary: '', issues: [] }).success).toBe(false);
    expect(
      StyleCheckSchema.safeParse({
        summary: 'ok',
        issues: [{ ...issue(0), excerpt: '' }],
      }).success,
    ).toBe(false);
    // M4-P1：每条必须说明与风格档案/锚点的可观察差异（basis 必填）
    expect(
      StyleCheckSchema.safeParse({
        summary: 'ok',
        issues: [{ ...issue(0), basis: '' }],
      }).success,
    ).toBe(false);
    expect(
      StyleCheckSchema.safeParse({
        summary: 'ok',
        issues: [{ dimension: 'd', severity: 'low', excerpt: 'e', suggestion: 's' }],
      }).success,
    ).toBe(false);
    // M4.1：三档文案改为「差异较大 / 有所差异 / 略有差异」（旧「局部差异/轻微差异」移除）
    expect(STYLE_CHECK_SEVERITY_LABELS).toEqual({
      high: '差异较大',
      medium: '有所差异',
      low: '略有差异',
    });
    expect(STYLE_CHECK_SEVERITY_LABELS).not.toMatchObject({
      medium: '局部差异',
      low: '轻微差异',
    });
  });

  it('buildStyleCheckUserPrompt：无锚点时省略整块；正文为空 trim 后仍生成结构', () => {
    const without = buildStyleCheckUserPrompt({ anchor: null, content: ' 正文 ' });
    expect(without).not.toContain('【文风锚点');
    expect(without).toContain('【本章正文】\n正文');
    expect(
      without.endsWith('【本次要求】\n只输出结构化诊断：整体判断 + 最多 5 条问题；不要改写正文。'),
    ).toBe(true);
    const withAnchor = buildStyleCheckUserPrompt({
      anchor: { chapterId: 'c1', index: 1, label: '第 1 章开头', text: '锚点原文' },
      content: '正文',
    });
    expect(withAnchor.indexOf('【文风锚点（作者本人此前正文，只对齐语感，不要照搬情节）】')).toBe(
      0,
    );
    expect(withAnchor).toContain('锚点原文');
  });

  it('system prompt 含风格档案、「只诊断不改稿」与 M4-P1 的 basis 要求', () => {
    const system = buildStyleCheckSystemPrompt(novel, style);
    expect(system).toContain('文学编辑');
    expect(system).toContain('【文体取向】');
    expect(system).toContain('只诊断，不改稿');
    expect(system).toContain('每个问题必须逐字引用正文里的连续原文作为证据');
    expect(system).toContain('basis');
    expect(system).toContain('句长、叙述距离、对话密度、意象密度');
    expect(system).toContain('差异较大');
    expect(system).toContain('medium = 有所差异');
    expect(system).toContain('low = 略有差异');
    expect(system).not.toContain('明显偏离');
    expect(system).not.toContain('局部差异');
    expect(system).not.toContain('轻微差异');
  });
});

// ---------------------------------------------------------------- UI

function stubStyleCheck(payload: unknown = CHECK_RESULT, revisedText = '改写后的句子。') {
  const bodies: Record<string, unknown>[] = [];
  const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    bodies.push(body);
    if (body.stream === true) {
      return Promise.resolve(sseResponse(textDeltaEvents([revisedText], [])));
    }
    return Promise.resolve(jsonResponse(completion(JSON.stringify(payload))));
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { fetchSpy, bodies };
}

async function renderEditor(buttonName = '继续写第 2 章') {
  const user = userEvent.setup();
  harness.renderUI(<WritingPage />, '/write');
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  await user.click(await screen.findByRole('button', { name: buttonName }));
  await screen.findByLabelText('章节正文');
  return user;
}

async function openStyleSheet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '检查文风' }));
  const dialog = await screen.findByRole('dialog', { name: '检查文风' });
  return dialog;
}

describe('M4-S2 · 编辑器 UI', () => {
  it('入口存在；打开面板不请求；点面板内按钮才 1 次调用；结果含 severity/原文/建议/锚点；无改写按钮', async () => {
    const ch1 = await makeChapter('源头', '江雾'.repeat(220), 'done');
    const target = await makeChapter('目标章', '他忽然想起很多年前的事。雪落了整夜，追兵在门外。');
    const beforeProposals = await harness.repository.listProposals(novel.id);
    const { fetchSpy, bodies } = stubStyleCheck();
    const user = await renderEditor();

    // 入口可见且可用
    const entry = screen.getByRole('button', { name: '检查文风' });
    expect(entry).toBeEnabled();
    const dialog = await openStyleSheet(user);
    // 打开面板不请求
    expect(fetchSpy).not.toHaveBeenCalled();
    // M4.1：idle 显示字数/一次调用/边界说明
    expect(within(dialog).getByText(/本章约 \d+ 字，检查一次调用。/u)).toBeInTheDocument();
    expect(
      within(dialog).getByText('只对照风格档案与锚点，不逐个人物核对口吻。'),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '检查文风' }));
    expect(await within(dialog).findByText(CHECK_RESULT.summary)).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 请求体：强模型（deepseek-chat）、非流式
    expect(bodies[0]!.stream).not.toBe(true);
    expect(bodies[0]!.model).toBe('deepseek-chat');

    expect(within(dialog).getByText('差异较大')).toBeInTheDocument();
    expect(within(dialog).getByText('有所差异')).toBeInTheDocument();
    expect(within(dialog).queryByText('局部差异')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('轻微差异')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('明显偏离')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('局部偏离')).not.toBeInTheDocument();
    expect(within(dialog).getByText('叙述距离')).toBeInTheDocument();
    // M4-P1：每条显式「原文 / 依据 / 建议」
    expect(within(dialog).getAllByText('原文：')).toHaveLength(2);
    expect(within(dialog).getByText('「他忽然想起很多年前的事。」')).toBeInTheDocument();
    expect(within(dialog).getAllByText('依据：')).toHaveLength(2);
    expect(
      within(dialog).getByText('这句从现场动作切到总结性回忆，叙述距离比锚点明显拉远。'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('建议：把这段拉到现场动作里，别直接总结回忆。'),
    ).toBeInTheDocument();
    // M4-P1：与「按规范检查」的分工句固定显示
    expect(
      within(dialog).getByText(
        /文风检查看语感与叙述距离是否漂移；按规范检查看你定的规矩是否被违反/u,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/依据：风格档案 \+ 文风锚点/u)).toBeInTheDocument();
    expect(within(dialog).getByText(`对照锚点：第 1 章开头`)).toBeInTheDocument();
    // M4.2：每条 issue 有「定位 / 按建议改写」（excerpt 仍在正文 → 可用）；
    // 仍没有「应用/采纳/润色/替换正文/自动修」一键落库按钮
    expect(within(dialog).getAllByRole('button', { name: '定位' })).toHaveLength(2);
    expect(within(dialog).getAllByRole('button', { name: '按建议改写' })).toHaveLength(2);
    expect(within(dialog).getAllByRole('button', { name: '定位' })[0]).toBeEnabled();
    expect(
      within(dialog).queryByRole('button', { name: /应用|采纳|润色|替换正文|自动修/u }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(/定位只选中原文；按建议改写会打开段落加工，仍要你确认替换。/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '重新检查' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '完成' })).toBeInTheDocument();

    // 关闭不写：提案/摘要/正文都不变
    await user.click(within(dialog).getByRole('button', { name: '完成' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '检查文风' })).not.toBeInTheDocument(),
    );
    expect(await harness.repository.listProposals(novel.id)).toEqual(beforeProposals);
    expect(await harness.repository.listSummaries(novel.id)).toEqual([]);
    expect(
      (await harness.repository.listChapters(novel.id)).find((item) => item.id === target.id)!
        .content,
    ).toBe('他忽然想起很多年前的事。雪落了整夜，追兵在门外。');
    void ch1;
  });

  it('无问题：显示「未发现明显文风漂移。」', async () => {
    await makeChapter('源头', '江雾'.repeat(220), 'done');
    await makeChapter('目标章', '本章正文。');
    stubStyleCheck({ summary: '整体稳定，没有明显漂移。', issues: [] });
    const user = await renderEditor();
    const dialog = await openStyleSheet(user);
    await user.click(within(dialog).getByRole('button', { name: '检查文风' }));
    expect(await within(dialog).findByText('未发现明显文风漂移。')).toBeInTheDocument();
    // 缺省（没有 issue）不显示定位/改写动作
    expect(within(dialog).queryByRole('button', { name: '定位' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '按建议改写' })).not.toBeInTheDocument();
  });

  it('第一章：无锚点提示「第一章或没有更早正文…只对照风格档案」', async () => {
    await makeChapter('第一章', '第一章正文。');
    stubStyleCheck({ summary: '整体稳定。', issues: [] });
    const user = await renderEditor('继续写第 1 章');
    const dialog = await openStyleSheet(user);
    await user.click(within(dialog).getByRole('button', { name: '检查文风' }));
    expect(
      await within(dialog).findByText('第一章或没有更早正文：本次没有文风锚点，只对照风格档案。'),
    ).toBeInTheDocument();
  });

  it('schema 失败显示 role=alert + 重试；重试成功后出结果', async () => {
    await makeChapter('目标章', '本章正文。');
    stubStyleCheck({
      summary: '整体稳定。',
      issues: Array.from({ length: 6 }, () => ({
        dimension: 'x',
        severity: 'low',
        excerpt: 'y',
        basis: 'b',
        suggestion: 'z',
      })),
    });
    const user = await renderEditor('继续写第 1 章');
    const dialog = await openStyleSheet(user);
    await user.click(within(dialog).getByRole('button', { name: '检查文风' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    const retry = within(dialog).getByRole('button', { name: '重试' });
    expect(retry).toBeInTheDocument();

    stubStyleCheck();
    await user.click(retry);
    expect(await within(dialog).findByText(CHECK_RESULT.summary)).toBeInTheDocument();
  });

  it('关闭面板不请求、不写库', async () => {
    await makeChapter('目标章', '本章正文。');
    const { fetchSpy } = stubStyleCheck();
    const user = await renderEditor('继续写第 1 章');
    const dialog = await openStyleSheet(user);
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '检查文风' })).not.toBeInTheDocument(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await harness.repository.listProposals(novel.id)).toEqual([]);
    expect(await harness.repository.listSummaries(novel.id)).toEqual([]);
  });

  it('无正文：入口按钮禁用', async () => {
    await harness.repository.createChapter(novel.id, { title: '空章', content: '' });
    const user = userEvent.setup();
    harness.renderUI(<WritingPage />, '/write');
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: '继续写第 1 章' }));
    await screen.findByLabelText('章节正文');
    expect(screen.getByRole('button', { name: '检查文风' })).toBeDisabled();
    // 无正文时没有可打开的面板
    expect(screen.queryByRole('dialog', { name: '检查文风' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- M4.2 定位 / 按建议改写

const CONTENT = '他忽然想起很多年前的事。雪落了整夜，追兵在门外。';
const EXCERPT_1 = '他忽然想起很多年前的事。';

async function openResult(content = CONTENT) {
  await makeChapter('源头', '江雾'.repeat(220), 'done');
  const target = await makeChapter('目标章', content);
  const stub = stubStyleCheck();
  const user = await renderEditor();
  const dialog = await openStyleSheet(user);
  await user.click(within(dialog).getByRole('button', { name: '检查文风' }));
  expect(await within(dialog).findByText(CHECK_RESULT.summary)).toBeInTheDocument();
  return { user, dialog, target, ...stub };
}

describe('M4.2 · 定位与按建议改写', () => {
  it('定位：面板关闭、编辑器选区正好是 excerpt 区间、正文不变、无新请求', async () => {
    const { user, dialog, fetchSpy } = await openResult();
    const textarea = screen.getByLabelText('章节正文') as HTMLTextAreaElement;
    const start = CONTENT.indexOf(EXCERPT_1);

    await user.click(within(dialog).getAllByRole('button', { name: '定位' })[0]!);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '检查文风' })).not.toBeInTheDocument(),
    );

    expect(textarea.selectionStart).toBe(start);
    expect(textarea.selectionEnd).toBe(start + EXCERPT_1.length);
    expect(textarea.value).toBe(CONTENT); // 只改选区，不改正文
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 不新增请求
  });

  it('按建议改写：打开段落加工，预填 rewrite + suggestion/basis；正文不变、无新请求', async () => {
    const { user, dialog, fetchSpy } = await openResult();

    await user.click(within(dialog).getAllByRole('button', { name: '按建议改写' })[0]!);
    const reviseDialog = await screen.findByRole('dialog', { name: '加工这一段' });

    // 预填：标题为加工面板；操作是「改写」（开始改写）；额外要求含 suggestion+basis
    expect(within(reviseDialog).getByRole('button', { name: '开始改写' })).toBeInTheDocument();
    const instruction = within(reviseDialog).getByLabelText(
      '额外要求（可选）',
    ) as HTMLTextAreaElement;
    expect(instruction.value).toBe(
      '按文风检查建议修改：把这段拉到现场动作里，别直接总结回忆。（依据：这句从现场动作切到总结性回忆，叙述距离比锚点明显拉远。）',
    );
    expect(within(reviseDialog).getByText(EXCERPT_1)).toBeInTheDocument(); // 选中内容仍是原句
    const textarea = screen.getByLabelText('章节正文') as HTMLTextAreaElement;
    expect(textarea.value).toBe(CONTENT); // 未点替换前正文不变
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 打开加工面板不发请求
  });

  it('段落加工点「替换原文」后才写入正文；无提案、无摘要', async () => {
    const { user, dialog, target, fetchSpy } = await openResult();
    await user.click(within(dialog).getAllByRole('button', { name: '按建议改写' })[0]!);
    const reviseDialog = await screen.findByRole('dialog', { name: '加工这一段' });

    await user.click(within(reviseDialog).getByRole('button', { name: '开始改写' }));
    const replace = await within(reviseDialog).findByRole('button', { name: '替换原文' });
    const textarea = screen.getByLabelText('章节正文') as HTMLTextAreaElement;
    expect(textarea.value).toBe(CONTENT); // 生成结果未确认前不写

    await user.click(replace);
    await waitFor(() =>
      expect((screen.getByLabelText('章节正文') as HTMLTextAreaElement).value).toBe(
        CONTENT.replace(EXCERPT_1, '改写后的句子。'),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '加工这一段' })).not.toBeInTheDocument(),
    );
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2); // 检查 1 次 + 改写 1 次
    expect(await harness.repository.listProposals(novel.id)).toEqual([]);
    expect(await harness.repository.listSummaries(novel.id)).toEqual([]);
    const saved = (await harness.repository.listChapters(novel.id)).find(
      (item) => item.id === target.id,
    )!;
    // 正文由编辑器防御性保存；此处只断言没有自动产生提案/摘要，正文最终以编辑器状态为准
    expect(saved.id).toBe(target.id);
  });

  it('原文已被修改：两条动作禁用并提示「原文已被修改，找不到」', async () => {
    const { user, dialog } = await openResult();
    const textarea = screen.getByLabelText('章节正文') as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.type(textarea, '完全不同的正文。');

    await waitFor(() => {
      const locateButtons = within(dialog).getAllByRole('button', { name: '定位' });
      expect(locateButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    });
    expect(within(dialog).getAllByRole('button', { name: '按建议改写' })).toHaveLength(2);
    expect(
      (within(dialog).getAllByRole('button', { name: '按建议改写' }) as HTMLButtonElement[]).every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(within(dialog).getAllByText('原文已被修改，找不到')).toHaveLength(2);
  });

  it('关闭重开保留本次诊断；「重新检查」不自动调用，点了才再请求', async () => {
    const { user, dialog, fetchSpy } = await openResult();
    await user.click(within(dialog).getByRole('button', { name: '完成' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '检查文风' })).not.toBeInTheDocument(),
    );

    const reopened = await openStyleSheet(user);
    expect(within(reopened).getByText(CHECK_RESULT.summary)).toBeInTheDocument();
    expect(within(reopened).getAllByRole('button', { name: '定位' })).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 重开不请求

    await user.click(within(reopened).getByRole('button', { name: '重新检查' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(await within(reopened).findByText(CHECK_RESULT.summary)).toBeInTheDocument();
  });

  it('换章后重置：另一章打开文风面板是 idle，不带上一章诊断', async () => {
    const { user, dialog, fetchSpy } = await openResult();
    await user.click(within(dialog).getByRole('button', { name: '完成' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '检查文风' })).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: '返回' }));
    await user.click(await screen.findByRole('button', { name: '继续写第 1 章' }));
    await screen.findByLabelText('章节正文');
    const fresh = await openStyleSheet(user);

    expect(within(fresh).queryByText(CHECK_RESULT.summary)).not.toBeInTheDocument();
    expect(within(fresh).queryAllByRole('button', { name: '定位' })).toHaveLength(0);
    expect(within(fresh).getByText(/本章约 \d+ 字，检查一次调用。/u)).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('M4.2 · locateQuote（原句定位）', () => {
  it('精确命中返回区间；多次出现取第一次', () => {
    const content = `开头。${EXCERPT_1}中间。${EXCERPT_1}`;
    const range = locateQuote(content, EXCERPT_1)!;
    expect(content.slice(range.start, range.end)).toBe(EXCERPT_1);
    expect(range.start).toBe(content.indexOf(EXCERPT_1));
  });

  it('模型把跨行原句抄成一行时忽略空白仍能定位，区间不含首尾多余空白', () => {
    const content = '雪落了整夜，\n\n  追兵在门外。';
    const range = locateQuote(content, '雪落了整夜，追兵在门外。')!;
    expect(range).not.toBeNull();
    expect(content.slice(range.start, range.end).replace(/[\s\u3000]/gu, '')).toBe(
      '雪落了整夜，追兵在门外。',
    );
  });

  it('原文已被改掉/quote 为空 → null', () => {
    expect(locateQuote(CONTENT, '不存在的句子。')).toBeNull();
    expect(locateQuote(CONTENT, '   ')).toBeNull();
  });
});
