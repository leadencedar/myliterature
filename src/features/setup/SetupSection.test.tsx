import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARACTER_FIELDS, WORLDBUILDING_FIELDS } from '@/domain/defaults';
import type { Novel } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { NORM_FIXTURE_MARKER, createFixtureNorm } from '@/test/writingNormFixtures';
import { SetupSection } from './SetupSection';

let harness: TestHarness;
let novel: Novel;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

function fields(defs: typeof WORLDBUILDING_FIELDS, value = '具体内容') {
  return Object.fromEntries(defs.map((def) => [def.key, value]));
}

const SETUP_RESULT = {
  worldbuilding: [
    {
      title: '归墟',
      aliases: ['深渊'],
      summary: '吞噬记忆的深渊',
      core: true,
      fields: fields(WORLDBUILDING_FIELDS),
    },
    {
      title: '剑冢',
      aliases: [],
      summary: '埋剑之地',
      core: false,
      fields: fields(WORLDBUILDING_FIELDS),
    },
  ],
  characters: [
    {
      title: '林越',
      aliases: ['阿越'],
      summary: '失忆的剑客',
      core: false,
      fields: fields(CHARACTER_FIELDS),
    },
    {
      title: '沈清',
      aliases: [],
      summary: '追查真相的女捕',
      core: false,
      fields: fields(CHARACTER_FIELDS),
    },
  ],
  outline: [
    {
      title: '第一卷 风起',
      synopsis: '主角被追杀。',
      targetWords: 30_000,
      children: [
        { title: '第1章 雪夜', synopsis: '追兵临门。', targetWords: 3000 },
        { title: '第2章 旧识', synopsis: '雪山遇故人。', targetWords: 3000 },
      ],
    },
    { title: '第二卷 潮落', synopsis: '真相浮现。', targetWords: 30_000, children: [] },
    { title: '第三卷 归墟', synopsis: '直面自己。', targetWords: 30_000, children: [] },
  ],
};

function stubGeneration(result: unknown = SETUP_RESULT) {
  const fetchSpy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(completion(JSON.stringify(result)))),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function renderSetup() {
  return harness.renderUI(<SetupSection novel={novel} />);
}

async function waitForForm() {
  return screen.findByLabelText('我想讲一个什么故事');
}

describe('立项表单', () => {
  it('知识库为空时直接展开表单', async () => {
    renderSetup();

    expect(await screen.findByText('从一句话开始')).toBeInTheDocument();
    expect(await waitForForm()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成世界观与大纲' })).toBeInTheDocument();
  });

  it('预填小说已有的一句话', async () => {
    novel = await harness.repository.updateNovel(novel.id, { oneLiner: '既有的一句话。' });
    renderSetup();

    expect(await waitForForm()).toHaveValue('既有的一句话。');
  });

  it('已有内容时默认折叠，标题改为重新立项', async () => {
    const categoryId = (await harness.repository.listCategories(novel.id))[0]!.id;
    await harness.repository.createEntry(novel.id, { categoryId, title: '已有条目' });

    renderSetup();

    expect(await screen.findByText('重新立项')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新生成立项内容' })).toBeInTheDocument();
    expect(screen.queryByLabelText('我想讲一个什么故事')).not.toBeInTheDocument();
  });

  it('未填一句话时本地拦截，不发请求', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubGeneration();
    renderSetup();
    await waitForForm();

    await user.click(screen.getByRole('button', { name: '生成世界观与大纲' }));

    expect(screen.getByRole('alert')).toHaveTextContent('请先写下你想讲的故事');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('未配置模型时禁用生成', async () => {
    useLlmSettings.getState().clearApiKey();
    renderSetup();
    await waitForForm();

    expect(screen.getByRole('button', { name: '生成世界观与大纲' })).toBeDisabled();
    expect(screen.getByText(/需要先在「设置」里配置模型/u)).toBeInTheDocument();
  });
});

describe('生成与确认', () => {
  async function generate() {
    const user = userEvent.setup();
    renderSetup();
    const input = await waitForForm();
    await user.click(input);
    await user.paste('失忆剑客发现自己就是灭门案的凶手。');
    await user.click(screen.getByRole('button', { name: '生成世界观与大纲' }));
    return user;
  }

  it('生成结果不直接落库，先成为待确认提案', async () => {
    stubGeneration();
    await generate();

    await screen.findByText(/已生成 世界观 2 条 · 人物 2 位 · 大纲 5 个节点/u);

    // 知识库此刻仍是空的
    expect(await harness.repository.listEntries(novel.id)).toHaveLength(0);
    expect(await harness.repository.listOutline(novel.id)).toHaveLength(0);
    // 世界观 2 条 + 人物 2 位 + 大纲 1 份
    expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(5);
  });

  it('把用户写的一句话存回小说', async () => {
    stubGeneration();
    await generate();
    await screen.findByText(/已生成/u);

    expect((await harness.repository.getNovel(novel.id))?.oneLiner).toBe(
      '失忆剑客发现自己就是灭门案的凶手。',
    );
  });

  it('确认后写入知识库条目，core 设定映射为核心标记', async () => {
    stubGeneration();
    const user = await generate();
    await screen.findByText(/已生成/u);

    await user.click(await screen.findByRole('button', { name: /全部写入知识库/u }));

    await waitFor(async () => {
      expect(await harness.repository.listEntries(novel.id)).toHaveLength(4);
    });

    const entries = await harness.repository.listEntries(novel.id);
    const guixu = entries.find((entry) => entry.title === '归墟');
    expect(guixu).toMatchObject({
      summary: '吞噬记忆的深渊',
      aliases: ['深渊'],
      // 模型标记的核心设定 → pinned，每次写作都会注入
      pinned: true,
    });
    expect(guixu?.fields.definition).toBe('具体内容');

    const linyue = entries.find((entry) => entry.title === '林越');
    expect(linyue?.pinned).toBe(false);
    expect(linyue?.fields.goal).toBe('具体内容');
  });

  it('确认后按层级建立大纲树', async () => {
    stubGeneration();
    const user = await generate();
    await screen.findByText(/已生成/u);

    await user.click(await screen.findByRole('button', { name: /全部写入知识库/u }));

    await waitFor(async () => {
      expect(await harness.repository.listOutline(novel.id)).toHaveLength(5);
    });

    const nodes = await harness.repository.listOutline(novel.id);
    const roots = nodes.filter((node) => node.parentId === null);
    expect(roots.map((node) => node.title)).toEqual(['第一卷 风起', '第二卷 潮落', '第三卷 归墟']);

    const firstVolume = roots[0]!;
    const chapters = nodes.filter((node) => node.parentId === firstVolume.id);
    expect(chapters.map((node) => node.title)).toEqual(['第1章 雪夜', '第2章 旧识']);
    expect(chapters[0]?.targetWords).toBe(3000);
    // 同层顺序要保留
    expect(chapters.map((node) => node.order)).toEqual([0, 1]);
  });

  it('大纲以可编辑的整份文本呈现，改动后按新结构落库', async () => {
    stubGeneration();
    const user = await generate();
    await screen.findByText(/已生成/u);

    // 提案列表是异步加载的，先等它出现再展开「全书大纲」这一条
    await user.click(await screen.findByRole('button', { name: /全书大纲/u }));
    const outlineField = screen.getByLabelText('大纲内容') as HTMLTextAreaElement;
    expect(outlineField.value).toContain('# 第一卷 风起（约 30000 字）');
    expect(outlineField.value).toContain('## 第1章 雪夜（约 3000 字）');

    await user.clear(outlineField);
    await user.paste('# 唯一一卷\n改写后的梗概\n## 第1章\n开场');
    await user.click(await screen.findByRole('button', { name: /全部写入知识库/u }));

    await waitFor(async () => {
      expect(await harness.repository.listOutline(novel.id)).toHaveLength(2);
    });
    const nodes = await harness.repository.listOutline(novel.id);
    expect(nodes.find((node) => node.parentId === null)).toMatchObject({
      title: '唯一一卷',
      synopsis: '改写后的梗概',
    });
  });

  it('已有大纲时生成的是替换提案，能看到原大纲', async () => {
    const existing = await harness.repository.createOutlineNode(novel.id, {
      title: '旧的第一卷',
      synopsis: '旧梗概',
    });
    expect(existing.id).toBeTruthy();

    stubGeneration();
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByRole('button', { name: '重新生成立项内容' }));
    const input = await waitForForm();
    await user.click(input);
    await user.paste('一句话。');
    await user.click(screen.getByRole('button', { name: '生成世界观与大纲' }));
    await screen.findByText(/已生成/u);

    await user.click(await screen.findByRole('button', { name: /全书大纲/u }));
    expect(screen.getByText('替换')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '看原值' }));
    expect(screen.getByText(/旧的第一卷/u)).toBeInTheDocument();
  });

  it('替换大纲时清掉旧节点，不留下重复', async () => {
    await harness.repository.createOutlineNode(novel.id, { title: '旧的第一卷' });

    stubGeneration();
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByRole('button', { name: '重新生成立项内容' }));
    const input = await waitForForm();
    await user.click(input);
    await user.paste('一句话。');
    await user.click(screen.getByRole('button', { name: '生成世界观与大纲' }));
    await screen.findByText(/已生成/u);
    await user.click(await screen.findByRole('button', { name: /全部写入知识库/u }));

    // 替换是「先删旧、再逐个建新」，中间存在节点数不足的瞬时状态，
    // 因此两个断言必须一起等到终态，不能分开写
    await waitFor(async () => {
      const nodes = await harness.repository.listOutline(novel.id);
      expect(nodes).toHaveLength(5);
      expect(nodes.some((node) => node.title === '旧的第一卷')).toBe(false);
    });
  });

  it('按篇幅把不同的大纲要求发给模型', async () => {
    const fetchSpy = stubGeneration();
    const user = userEvent.setup();
    renderSetup();
    const input = await waitForForm();
    await user.click(input);
    await user.paste('一句话。');
    await user.click(screen.getByRole('button', { name: '短篇' }));
    await user.click(screen.getByRole('button', { name: '生成世界观与大纲' }));
    await screen.findByText(/已生成/u);

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
      thinking?: { type: string };
      model: string;
    };
    const userMessage = body.messages.find((message) => message.role === 'user');
    expect(userMessage?.content).toContain('短篇');
    expect(userMessage?.content).toContain('不分卷');
    // 立项是结构化推理任务：开思维链 + 用重点任务模型
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.model).toBe('deepseek-chat');
  });

  it('额外要求会带进请求', async () => {
    const fetchSpy = stubGeneration();
    const user = userEvent.setup();
    renderSetup();
    const input = await waitForForm();
    await user.click(input);
    await user.paste('一句话。');
    await user.type(screen.getByLabelText('额外要求（可选）'), '女主视角');
    await user.click(screen.getByRole('button', { name: '生成世界观与大纲' }));
    await screen.findByText(/已生成/u);

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages.find((m) => m.role === 'user')?.content).toContain('女主视角');
  });

  it('模型输出不合格时先自动修复重试', async () => {
    const bad = { worldbuilding: [], characters: [], outline: [] };
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        return Promise.resolve(
          jsonResponse(completion(JSON.stringify(call === 1 ? bad : SETUP_RESULT))),
        );
      }),
    );

    await generate();

    expect(await screen.findByText(/已生成/u)).toBeInTheDocument();
    expect(call).toBe(2);
  });

  it('修复后仍不合格时给出可读错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            completion(JSON.stringify({ worldbuilding: [], characters: [], outline: [] })),
          ),
        ),
      ),
    );

    await generate();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('模型输出不符合预期格式');
  });

  it('接口报错时给出可操作提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: { message: 'no balance' } }, 402))),
    );

    await generate();

    expect(await screen.findByRole('alert')).toHaveTextContent('余额不足');
  });

  it('可以只采用部分条目', async () => {
    stubGeneration();
    const user = await generate();
    await screen.findByText(/已生成/u);

    // 忽略「全书大纲」那一条
    const outlineToggle = await screen.findByRole('button', { name: /全书大纲/u });
    await user.click(outlineToggle);
    const outlineItem = outlineToggle.closest('li');
    await user.click(within(outlineItem!).getByRole('button', { name: '忽略这条' }));
    await user.click(await screen.findByRole('button', { name: /全部写入知识库/u }));

    await waitFor(async () => {
      expect(await harness.repository.listEntries(novel.id)).toHaveLength(4);
    });
    // 大纲被忽略，没有落库
    expect(await harness.repository.listOutline(novel.id)).toHaveLength(0);
  });
});

describe('写作规范', () => {
  it('没有规范时不显示「将带上」提示行', async () => {
    renderSetup();
    await waitForForm();

    expect(screen.queryByText(/将带上 \d+ 份写作规范/u)).not.toBeInTheDocument();
  });

  it('作用范围不含规划的规范不计入提示行', async () => {
    await createFixtureNorm(harness.repository, novel.id, { scopes: ['writing'] });
    renderSetup();
    await waitForForm();

    expect(screen.queryByText(/将带上 \d+ 份写作规范/u)).not.toBeInTheDocument();
  });

  it('有规划规范时显示提示行，生成请求的系统提示带上规范', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const fetchSpy = stubGeneration();
    const user = userEvent.setup();
    renderSetup();
    const input = await waitForForm();

    expect(await screen.findByText(/将带上 1 份写作规范（约 \d+ tokens）/u)).toBeInTheDocument();

    await user.click(input);
    await user.paste('一句话。');
    await user.click(screen.getByRole('button', { name: '生成世界观与大纲' }));
    await screen.findByText(/已生成/u);

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const system = body.messages.find((message) => message.role === 'system')!.content;
    expect(system).toContain(NORM_FIXTURE_MARKER);
    expect(system.indexOf(NORM_FIXTURE_MARKER)).toBeLessThan(system.indexOf('【任务】'));
  });
});
