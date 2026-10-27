import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Category, Chapter, Novel, SideStory } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { buildCreateProposal } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import { useArchiveSettings } from './archiveSettings';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { ChapterSummarySheet } from './ChapterSummarySheet';
import { WritingPage } from './WritingPage';

let harness: TestHarness;
let novel: Novel;
let charCategory: Category;
let firstChapter: Chapter;

const SUMMARY_RESULT = {
  summary: '主角负伤逃入雪山，被故人所救。',
  keyEvents: ['遭遇追兵', '逃入雪山', '遇到故人'],
  appearingEntries: ['林越', '阿越', '不存在的人'],
  newOpenThreads: ['黑衣人的身份', '玉佩的来历'],
  resolvedThreads: [],
  rollingSummary: '开篇主角被追杀，负伤逃入雪山后被故人所救。',
};

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
  charCategory = (await harness.repository.listCategories(novel.id))[1]!;
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  // 本文件只测手动摘要入口；后台归档在 task-22 的编辑器用例里单独测
  useArchiveSettings.setState({ autoArchive: false, extractEntries: true });
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });

  await harness.repository.createEntry(novel.id, {
    categoryId: charCategory.id,
    title: '林越',
    aliases: ['阿越'],
  });
  const node = await harness.repository.createOutlineNode(novel.id, {
    title: '第1章 雪夜',
    synopsis: '追兵临门。',
  });
  firstChapter = await harness.repository.createChapter(novel.id, {
    title: '第1章 雪夜',
    content: '雪落了整夜，追兵在门外。他终于倒下。',
    outlineNodeId: node.id,
  });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

function stubStructured(result: unknown = SUMMARY_RESULT) {
  const fetchSpy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(completion(JSON.stringify(result)))),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

async function openEditor(chapterIndex = 1) {
  const user = userEvent.setup();
  harness.renderUI(<WritingPage />);
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  await user.click(await screen.findByRole('button', { name: `继续写第 ${chapterIndex} 章` }));
  await screen.findByLabelText('章节正文');
  return user;
}

/**
 * 手动打开摘要抽屉并开始提炼。
 * design §6.6：标记完成不再自动弹摘要面板，所有摘要入口都从这里走。
 */
async function openSummaryAndGenerate(
  user: ReturnType<typeof userEvent.setup>,
  options: { done?: boolean } = {},
) {
  if (options.done) await user.click(screen.getByRole('button', { name: '草稿' }));
  await user.click(screen.getByRole('button', { name: options.done ? '补摘要' : '写摘要' }));
  const dialog = await screen.findByRole('dialog', { name: '本章摘要' });
  await user.click(within(dialog).getByRole('button', { name: '提炼本章摘要' }));
  return dialog;
}

describe('摘要入口（标记完成不再自动弹）', () => {
  it('标记完成不再自动打开摘要抽屉，也不发请求', async () => {
    const fetchSpy = stubStructured();
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: '草稿' }));

    expect(screen.queryByRole('dialog', { name: '本章摘要' })).not.toBeInTheDocument();
    // 本文件把自动归档关掉：状态行只提示可手动补摘要
    expect(await screen.findByText(/自动归档已关闭/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('正文为空时标记完成不触发任何模型调用', async () => {
    const fetchSpy = stubStructured();
    const user = await openEditor();
    await user.clear(screen.getByLabelText('章节正文'));
    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument(), { timeout: 3000 });

    await user.click(screen.getByRole('button', { name: '草稿' }));

    expect(screen.queryByRole('dialog', { name: '本章摘要' })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('手动入口在缺摘要时高亮为「补摘要」', async () => {
    const user = await openEditor();
    expect(screen.getByRole('button', { name: '写摘要' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '草稿' }));

    expect(screen.getByRole('button', { name: '补摘要' })).toBeInTheDocument();
  });
});

describe('摘要落库', () => {
  async function generateAndAccept(user: ReturnType<typeof userEvent.setup>) {
    await openSummaryAndGenerate(user);
    await user.click(await screen.findByRole('button', { name: /保存摘要/u }));
  }

  it('确认后写入章节摘要与全书进展', async () => {
    stubStructured();
    const user = await openEditor();

    await generateAndAccept(user);

    // 两条提案是依次落库的，必须一起等到终态再断言
    await waitFor(async () => {
      const summary = await harness.repository.getSummaryByChapter(firstChapter.id);
      expect(summary).toMatchObject({
        summary: '主角负伤逃入雪山，被故人所救。',
        keyEvents: ['遭遇追兵', '逃入雪山', '遇到故人'],
        openThreads: ['黑衣人的身份', '玉佩的来历'],
      });
      expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe(
        '开篇主角被追杀，负伤逃入雪山后被故人所救。',
      );
    });
  });

  it('出场角色按标题与别名解析成 id，匹配不上的丢弃', async () => {
    stubStructured();
    const user = await openEditor();

    // 生成后先看界面提示
    await openSummaryAndGenerate(user);
    expect(await screen.findByText(/识别到的出场角色与设定：林越/u)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /保存摘要/u }));

    await waitFor(async () => {
      const summary = await harness.repository.getSummaryByChapter(firstChapter.id);
      const entries = await harness.repository.listEntries(novel.id);
      // 「林越」与其别名「阿越」指向同一条目，只记一次；「不存在的人」被丢弃
      expect(summary?.appearingEntryIds).toEqual([entries[0]!.id]);
    });
  });

  it('确认前不落库', async () => {
    stubStructured();
    const user = await openEditor();

    await openSummaryAndGenerate(user);
    await screen.findByRole('button', { name: /保存摘要/u });

    expect(await harness.repository.getSummaryByChapter(firstChapter.id)).toBeUndefined();
    expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe('');
  });

  it('两条提案分别是本章摘要与全书进展', async () => {
    stubStructured();
    const user = await openEditor();

    const dialog = await openSummaryAndGenerate(user);
    await screen.findByRole('button', { name: /保存摘要/u });

    expect(within(dialog).getByRole('button', { name: /第 1 章摘要/u })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /全书进展摘要/u })).toBeInTheDocument();
  });

  it('已有摘要时重新提炼走替换语义', async () => {
    await harness.repository.upsertSummary(novel.id, firstChapter.id, {
      summary: '旧的摘要',
      openThreads: ['旧伏笔'],
    });
    stubStructured();
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: '摘要' }));
    const dialog = await screen.findByRole('dialog', { name: '本章摘要' });
    expect(within(dialog).getByText('旧的摘要')).toBeInTheDocument();
    expect(within(dialog).getByText(/未收束伏笔：旧伏笔/u)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '重新提炼摘要' }));
    await user.click(await screen.findByRole('button', { name: /保存摘要/u }));

    await waitFor(async () => {
      const summary = await harness.repository.getSummaryByChapter(firstChapter.id);
      expect(summary?.summary).toBe('主角负伤逃入雪山，被故人所救。');
    });
    // 仍然只有一条摘要
    expect(await harness.repository.listSummaries(novel.id)).toHaveLength(1);
  });
});

describe('伏笔累计', () => {
  it('第二章收束第一章的伏笔后，累计清单相应减少', async () => {
    // 第一章摘要留下两条伏笔
    await harness.repository.upsertSummary(novel.id, firstChapter.id, {
      summary: '第一章摘要',
      keyEvents: ['事件'],
      openThreads: ['黑衣人的身份', '玉佩的来历'],
    });
    const secondNode = await harness.repository.createOutlineNode(novel.id, {
      title: '第2章 旧识',
    });
    const second = await harness.repository.createChapter(novel.id, {
      title: '第2章 旧识',
      content: '故人道出了玉佩的来历。',
      outlineNodeId: secondNode.id,
    });

    const fetchSpy = stubStructured({
      summary: '故人解释了玉佩。',
      keyEvents: ['玉佩来历被揭示'],
      appearingEntries: [],
      newOpenThreads: ['故人为何知道'],
      resolvedThreads: ['玉佩的来历'],
      rollingSummary: '主角得知玉佩来历。',
    });

    const user = await openEditor(2);
    await openSummaryAndGenerate(user);
    await user.click(await screen.findByRole('button', { name: /保存摘要/u }));

    await waitFor(async () => {
      const summary = await harness.repository.getSummaryByChapter(second.id);
      // 收束的移除，未收束的保留，新埋的追加
      expect(summary?.openThreads).toEqual(['黑衣人的身份', '故人为何知道']);
    });

    // 提示词里必须把上一章遗留的伏笔交给模型判断
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
      thinking?: { type: string };
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;
    expect(userMessage).toContain('【当前未收束的伏笔】');
    expect(userMessage).toContain('黑衣人的身份');
    expect(userMessage).toContain('玉佩的来历');
    // 摘要是结构化推理任务，开思维链
    expect(body.thinking).toEqual({ type: 'enabled' });
  });
});

describe('摘要接入后续章节的上下文', () => {
  it('第二章生成时注入第一章的摘要、伏笔与结尾原文', async () => {
    // 第二章的大纲节点要在渲染前建好，否则页面的首屏查询拿不到它
    const secondNode = await harness.repository.createOutlineNode(novel.id, {
      title: '第2章 旧识',
      synopsis: '雪山木屋遇到故人。',
    });
    expect(secondNode.id).toBeTruthy();

    // 先通过界面为第一章生成并确认摘要
    stubStructured();
    const user = await openEditor();
    await openSummaryAndGenerate(user);
    await user.click(await screen.findByRole('button', { name: /保存摘要/u }));
    await waitFor(async () =>
      expect(await harness.repository.getSummaryByChapter(firstChapter.id)).toBeDefined(),
    );
    await user.click(screen.getByRole('button', { name: '返回' }));

    const fetchSpy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(sseResponse(textDeltaEvents(['第二章的正文。']))),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await user.click(await screen.findByRole('button', { name: '编辑「第2章 旧识」' }));
    await user.click(await screen.findByRole('button', { name: '写这一章' }));
    await screen.findByLabelText('章节正文');
    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');

    // 注入清单里能看到第一章摘要
    expect(screen.getByText('第 1 章摘要')).toBeInTheDocument();
    expect(screen.getByText('全书进展摘要')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;

    expect(userMessage).toContain('主角负伤逃入雪山，被故人所救。');
    expect(userMessage).toContain('关键事件：遭遇追兵；逃入雪山；遇到故人');
    expect(userMessage).toContain('尚未收束的伏笔：黑衣人的身份；玉佩的来历');
    expect(userMessage).toContain('开篇主角被追杀，负伤逃入雪山后被故人所救。');
    // 上一章结尾原文也要带上，保证语气衔接
    expect(userMessage).toContain('他终于倒下。');
  });
});

describe('错误处理', () => {
  it('接口报错时给出可操作提示，可重试', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: { message: 'no balance' } }, 402))),
    );
    const user = await openEditor();

    await openSummaryAndGenerate(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('余额不足');
    expect(screen.getByRole('button', { name: '提炼本章摘要' })).toBeInTheDocument();
  });

  it('模型输出不合格且修复失败时提示格式问题', async () => {
    stubStructured({ summary: '', keyEvents: [], appearingEntries: [] });
    const user = await openEditor();

    await openSummaryAndGenerate(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('模型输出不符合预期格式');
  });

  it('未配置模型时禁用提炼', async () => {
    useLlmSettings.getState().clearApiKey();
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: '写摘要' }));

    const dialog = await screen.findByRole('dialog', { name: '本章摘要' });
    expect(within(dialog).getByRole('button', { name: '提炼本章摘要' })).toBeDisabled();
  });
});

describe('外传章节', () => {
  async function setupSide() {
    const story = await harness.repository.createSideStory(novel.id, {
      title: '青冥旧事',
      synopsis: '二十年前的往事。',
    });
    await harness.repository.updateNovel(novel.id, {
      rollingSummary: '主线进展：林越已离开雪山。',
    });
    const side1 = await harness.repository.createChapter(novel.id, {
      sideStoryId: story.id,
      content: '外传第一章。',
    });
    await harness.repository.upsertSummary(novel.id, side1.id, {
      summary: '外传第一章摘要',
      keyEvents: ['拜师'],
      openThreads: ['外传伏笔'],
    });
    // 主线第一章也留一条伏笔，外传不应承接它
    await harness.repository.upsertSummary(novel.id, firstChapter.id, {
      summary: '主线第一章摘要',
      keyEvents: ['雪夜'],
      openThreads: ['主线伏笔'],
    });
    const side2 = await harness.repository.createChapter(novel.id, {
      sideStoryId: story.id,
      content: '外传第二章的正文。',
    });
    return { story, side2 };
  }

  async function renderSheet(
    chapter: Chapter,
    props: { sideStory?: SideStory; autoStart?: boolean } = {},
  ) {
    const [chapters, summaries, entries, freshNovel] = await Promise.all([
      harness.repository.listChapters(novel.id),
      harness.repository.listSummaries(novel.id),
      harness.repository.listEntries(novel.id),
      harness.repository.getNovel(novel.id),
    ]);
    harness.renderUI(
      <ChapterSummarySheet
        open
        novel={freshNovel!}
        chapter={chapter}
        chapters={chapters}
        summaries={summaries}
        entries={entries}
        {...(props.sideStory ? { sideStory: props.sideStory } : {})}
        autoStart={props.autoStart ?? true}
        onClose={() => {}}
      />,
    );
  }

  function userPromptOf(fetchSpy: ReturnType<typeof stubStructured>): string {
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    return body.messages.find((message) => message.role === 'user')!.content;
  }

  it('产出 chapterSummary + sideStory 两条提案，prompt 用外传进展，伏笔只承接本外传', async () => {
    const { story, side2 } = await setupSide();
    await harness.repository.updateSideStory(story.id, { rollingSummary: '师父拜入青冥宗。' });
    const fetchSpy = stubStructured();
    await renderSheet(side2, { sideStory: (await harness.repository.getSideStory(story.id))! });

    expect(screen.getByRole('dialog', { name: '本章摘要 · 外传·青冥旧事' })).toBeInTheDocument();
    await screen.findByRole('button', { name: /保存摘要/u });

    const proposals = await harness.repository.listProposals(novel.id);
    expect(proposals.map((item) => item.target).sort()).toEqual(['chapterSummary', 'sideStory']);
    const sideProposal = proposals.find((item) => item.target === 'sideStory')!;
    expect(sideProposal).toMatchObject({
      targetId: story.id,
      label: '外传进展摘要',
      sourceRef: '外传·青冥旧事 第 2 章',
    });
    expect(proposals.find((item) => item.target === 'chapterSummary')?.label).toBe(
      '外传·青冥旧事 第 2 章摘要',
    );

    const prompt = userPromptOf(fetchSpy);
    expect(prompt).toContain('【此前的外传进展摘要（外传《青冥旧事》）】\n师父拜入青冥宗。');
    expect(prompt).not.toContain('主线进展：林越已离开雪山。');
    expect(prompt).toContain('本章属于外传《青冥旧事》，独立于主线。');
    expect(prompt).toContain('外传伏笔');
    expect(prompt).not.toContain('主线伏笔');

    // 采用后外传进展更新，主线进展不变
    await userEvent.setup().click(screen.getByRole('button', { name: /保存摘要/u }));
    await waitFor(async () => {
      expect((await harness.repository.getSideStory(story.id))?.rollingSummary).toBe(
        SUMMARY_RESULT.rollingSummary,
      );
      expect((await harness.repository.getSummaryByChapter(side2.id))?.openThreads).toEqual([
        '外传伏笔',
        '黑衣人的身份',
        '玉佩的来历',
      ]);
    });
    expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe(
      '主线进展：林越已离开雪山。',
    );
  });

  it('autoStart 读库里的最新外传进展，不用属性上的旧值', async () => {
    const { story, side2 } = await setupSide();
    const stale = (await harness.repository.getSideStory(story.id))!;
    await harness.repository.updateSideStory(story.id, { rollingSummary: '库里的新进展。' });
    const fetchSpy = stubStructured();
    await renderSheet(side2, { sideStory: { ...stale, rollingSummary: '属性上的旧进展。' } });

    await screen.findByRole('button', { name: /保存摘要/u });
    const prompt = userPromptOf(fetchSpy);
    expect(prompt).toContain('库里的新进展。');
    expect(prompt).not.toContain('属性上的旧进展。');

    const sideProposal = (await harness.repository.listProposals(novel.id)).find(
      (item) => item.target === 'sideStory',
    )!;
    expect(sideProposal.diff.find((item) => item.field === 'rollingSummary')?.before).toBe(
      '库里的新进展。',
    );
  });

  it('外传已被删除时 autoStart 进入错误态，不发请求', async () => {
    const { story, side2 } = await setupSide();
    const snapshot = (await harness.repository.getSideStory(story.id))!;
    await harness.repository.deleteSideStory(story.id);
    const fetchSpy = stubStructured();
    await renderSheet(side2, { sideStory: snapshot });

    expect(await screen.findByRole('alert')).toHaveTextContent('这部外传已不存在');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await harness.repository.listProposals(novel.id)).toEqual([]);
  });

  it('不传 sideStory 属性的外传章节，仍是 chapterSummary + sideStory 两条提案，没有 novel 提案', async () => {
    const { side2 } = await setupSide();
    stubStructured();
    await renderSheet(side2);

    expect(screen.getByRole('dialog', { name: '本章摘要' })).toBeInTheDocument();
    await screen.findByRole('button', { name: /保存摘要/u });
    const targets = (await harness.repository.listProposals(novel.id)).map((item) => item.target);
    expect(targets.sort()).toEqual(['chapterSummary', 'sideStory']);
    expect(targets).not.toContain('novel');
  });
});

describe('与归档的幂等（design §6.7）', () => {
  /** 造一条本章 pending 摘要提案，模拟后台归档刚生成的档案 */
  async function seedPendingArchiveSummary() {
    await harness.repository.createProposals([
      buildCreateProposal({
        novelId: novel.id,
        batchId: 'batch-archive',
        origin: 'extract',
        target: 'chapterSummary',
        label: '第 1 章摘要',
        specs: fieldSpecsFor('chapterSummary'),
        payload: {
          chapterId: firstChapter.id,
          summary: '归档生成的旧摘要',
          keyEvents: ['旧事件'],
          appearingEntryIds: [],
          openThreads: [],
        },
      }),
    ]);
  }

  it('手动摘要入口提示「本章档案待确认」', async () => {
    await seedPendingArchiveSummary();
    const user = await openEditor();
    await user.click(screen.getByRole('button', { name: '写摘要' }));

    const dialog = await screen.findByRole('dialog', { name: '本章摘要' });
    expect(await within(dialog).findByText(/本章档案待确认/u)).toBeInTheDocument();
  });

  it('重新提炼前清掉本章 pending 摘要，收件箱不会出现两份', async () => {
    await seedPendingArchiveSummary();
    stubStructured();
    const user = await openEditor();
    await openSummaryAndGenerate(user);
    // 点完「提炼本章摘要」只代表请求发出；默认并行全量时紧接着读仓储会读到空，
    // 等提案确认区出现再读（「保存摘要」按钮出现 = createProposals 已完成）
    await screen.findByRole('button', { name: /保存摘要/u });

    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    const summaries = pending.filter((proposal) => proposal.target === 'chapterSummary');
    expect(summaries).toHaveLength(1);
    expect(JSON.stringify(summaries[0]?.payload)).toContain(SUMMARY_RESULT.summary);
    expect(JSON.stringify(pending)).not.toContain('归档生成的旧摘要');
  });
});
