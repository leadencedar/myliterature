import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Novel, OutlineNode } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { WritingPage } from './WritingPage';

let harness: TestHarness;
let novel: Novel;
let chapterNode: OutlineNode;

const INITIAL = '第一段的内容。\n\n第二段的内容。\n\n第三段的内容。';

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });

  chapterNode = await harness.repository.createOutlineNode(novel.id, {
    title: '第1章 雪夜',
    synopsis: '追兵临门。',
  });
  await harness.repository.createChapter(novel.id, {
    title: '第1章 雪夜',
    content: INITIAL,
    outlineNodeId: chapterNode.id,
  });
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

function stubStream(deltas: string[]) {
  const fetchSpy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(sseResponse(textDeltaEvents(deltas))),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

async function openEditor() {
  const user = userEvent.setup();
  harness.renderUI(<WritingPage />);
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  await user.click(await screen.findByRole('button', { name: '继续写第 1 章' }));
  await screen.findByLabelText('章节正文');
  return user;
}

/** 在正文里选中一段并打开加工抽屉 */
async function selectAndOpen(user: ReturnType<typeof userEvent.setup>, phrase: string) {
  const textarea = screen.getByLabelText('章节正文') as HTMLTextAreaElement;
  const start = INITIAL.indexOf(phrase);
  textarea.setSelectionRange(start, start + phrase.length);
  await user.click(screen.getByRole('button', { name: '加工这一段' }));
  await screen.findByRole('dialog', { name: '加工这一段' });
}

async function chapterContent(): Promise<string> {
  const chapters = await harness.repository.listChapters(novel.id);
  return chapters[0]?.content ?? '';
}

describe('打开加工抽屉', () => {
  it('显示选中的字数与内容', async () => {
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    const dialog = screen.getByRole('dialog', { name: '加工这一段' });
    expect(within(dialog).getByText('已选中 7 字')).toBeInTheDocument();
    expect(within(dialog).getByText('第二段的内容。')).toBeInTheDocument();
  });

  it('没有选中内容时提示可以续写，并默认选中续写', async () => {
    const user = await openEditor();
    await user.click(screen.getByRole('button', { name: '加工这一段' }));

    const dialog = await screen.findByRole('dialog', { name: '加工这一段' });
    expect(within(dialog).getByText(/没有选中内容，可以从正文末尾续写/u)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '续写' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('未选中时改写与扩写被拦下并说明原因', async () => {
    const user = await openEditor();
    await user.click(screen.getByRole('button', { name: '加工这一段' }));
    const dialog = await screen.findByRole('dialog', { name: '加工这一段' });

    await user.click(within(dialog).getByRole('button', { name: '改写' }));

    expect(within(dialog).getByText(/「改写」需要先在正文里选中一段文字/u)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '开始改写' })).toBeDisabled();
  });
});

describe('改写', () => {
  it('替换选中片段，前后段落结构不变', async () => {
    stubStream(['改写后的第二段。']);
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    const dialog = screen.getByRole('dialog', { name: '加工这一段' });
    await user.click(within(dialog).getByRole('button', { name: '开始改写' }));
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '替换原文' }));

    await waitFor(async () => {
      expect(await chapterContent()).toBe('第一段的内容。\n\n改写后的第二段。\n\n第三段的内容。');
    });
  });

  it('替换首段不破坏后面的结构', async () => {
    stubStream(['新的开头。']);
    const user = await openEditor();
    await selectAndOpen(user, '第一段的内容。');

    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '替换原文' }));

    await waitFor(async () => {
      expect(await chapterContent()).toBe('新的开头。\n\n第二段的内容。\n\n第三段的内容。');
    });
  });

  it('替换末段', async () => {
    stubStream(['新的结尾。']);
    const user = await openEditor();
    await selectAndOpen(user, '第三段的内容。');

    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '替换原文' }));

    await waitFor(async () => {
      expect(await chapterContent()).toBe('第一段的内容。\n\n第二段的内容。\n\n新的结尾。');
    });
  });

  it('结果可以先改再采用', async () => {
    stubStream(['模型给的版本。']);
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );
    const result = await screen.findByLabelText('结果（可直接修改）');
    await user.clear(result);
    await user.type(result, '我自己改的版本。');
    await user.click(screen.getByRole('button', { name: '替换原文' }));

    await waitFor(async () => {
      expect(await chapterContent()).toContain('我自己改的版本。');
    });
  });

  it('可以对照原文查看', async () => {
    stubStream(['改写结果。']);
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );
    await screen.findByLabelText('结果（可直接修改）');

    await user.click(screen.getByText(/对照原文（7 字）/u));
    expect(screen.getByText('第二段的内容。')).toBeInTheDocument();
  });
});

describe('续写与扩写', () => {
  it('续写在选中段之后另起一段插入', async () => {
    stubStream(['插入的新段落。']);
    const user = await openEditor();
    await selectAndOpen(user, '第一段的内容。');

    const dialog = screen.getByRole('dialog', { name: '加工这一段' });
    await user.click(within(dialog).getByRole('button', { name: '续写' }));
    await user.click(within(dialog).getByRole('button', { name: '开始续写' }));
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '插入正文' }));

    await waitFor(async () => {
      expect(await chapterContent()).toBe(
        '第一段的内容。\n\n插入的新段落。\n\n第二段的内容。\n\n第三段的内容。',
      );
    });
  });

  it('未选中时续写接到正文末尾', async () => {
    stubStream(['接在最后的内容。']);
    const user = await openEditor();
    await user.click(screen.getByRole('button', { name: '加工这一段' }));
    const dialog = await screen.findByRole('dialog', { name: '加工这一段' });

    await user.click(within(dialog).getByRole('button', { name: '开始续写' }));
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '插入正文' }));

    await waitFor(async () => {
      expect(await chapterContent()).toBe(`${INITIAL}\n\n接在最后的内容。`);
    });
  });

  it('扩写替换原片段', async () => {
    stubStream(['扩写后的内容，多了很多细节。']);
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    const dialog = screen.getByRole('dialog', { name: '加工这一段' });
    await user.click(within(dialog).getByRole('button', { name: '扩写' }));
    await user.click(within(dialog).getByRole('button', { name: '开始扩写' }));
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '替换原文' }));

    await waitFor(async () => {
      expect(await chapterContent()).toContain('扩写后的内容，多了很多细节。');
    });
  });
});

describe('临时文风', () => {
  it('默认沿用当前文风', async () => {
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    expect(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '沿用当前文风',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('选中某位作家后提示词带上其特征，并声明只影响本次', async () => {
    const fetchSpy = stubStream(['改写结果。']);
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    const dialog = screen.getByRole('dialog', { name: '加工这一段' });
    await user.click(within(dialog).getByRole('button', { name: '古龙' }));
    await user.click(within(dialog).getByRole('button', { name: '开始改写' }));
    await screen.findByLabelText('结果（可直接修改）');

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
      thinking?: { type: string };
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;

    expect(userMessage).toContain('【本次临时文风】');
    expect(userMessage).toContain('古龙');
    expect(userMessage).toContain('不改变作品既有的文风设定');
    // 临时文风不落库
    const style = await harness.repository.getStyleProfile(novel.id);
    expect(style?.voiceRefs).toEqual([]);
    // 正文加工关闭思维链
    expect(body.thinking).toEqual({ type: 'disabled' });
  });
});

describe('提示词内容', () => {
  it('带上前文、待处理片段与后文，并注明后文不要写进去', async () => {
    const fetchSpy = stubStream(['结果。']);
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );
    await screen.findByLabelText('结果（可直接修改）');

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;

    expect(userMessage).toContain('【前文】');
    expect(userMessage).toContain('第一段的内容。');
    expect(userMessage).toContain('【待处理片段】\n第二段的内容。');
    expect(userMessage).toContain('第三段的内容。');
    expect(userMessage).toContain('不要写进去，但要能接上');
  });

  it('额外要求会带进请求', async () => {
    const fetchSpy = stubStream(['结果。']);
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    const dialog = screen.getByRole('dialog', { name: '加工这一段' });
    await user.type(within(dialog).getByLabelText('额外要求（可选）'), '多用短句');
    await user.click(within(dialog).getByRole('button', { name: '开始改写' }));
    await screen.findByLabelText('结果（可直接修改）');

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages.find((m) => m.role === 'user')?.content).toContain('多用短句');
  });
});

describe('撤销', () => {
  it('采用后出现撤销入口，点击还原正文', async () => {
    stubStream(['改写后的第二段。']);
    const user = await openEditor();

    expect(screen.queryByRole('button', { name: /撤销 AI 改动/u })).not.toBeInTheDocument();

    await selectAndOpen(user, '第二段的内容。');
    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '替换原文' }));

    await waitFor(async () => expect(await chapterContent()).toContain('改写后的第二段。'));

    await user.click(screen.getByRole('button', { name: /撤销 AI 改动/u }));

    await waitFor(async () => {
      expect(await chapterContent()).toBe(INITIAL);
    });
    // 撤销到底后入口消失
    expect(screen.queryByRole('button', { name: /撤销 AI 改动/u })).not.toBeInTheDocument();
  });

  it('多次改动可以逐步撤销', async () => {
    stubStream(['第一次改动。']);
    const user = await openEditor();

    await selectAndOpen(user, '第二段的内容。');
    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '替换原文' }));
    await waitFor(async () => expect(await chapterContent()).toContain('第一次改动。'));

    stubStream(['第二次改动。']);
    await selectAndOpen(user, '第三段的内容。');
    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '替换原文' }));
    await waitFor(async () => expect(await chapterContent()).toContain('第二次改动。'));

    // 撤销一步：第二次改动消失，第一次仍在
    await user.click(screen.getByRole('button', { name: /撤销 AI 改动/u }));
    await waitFor(async () => {
      const content = await chapterContent();
      expect(content).toContain('第一次改动。');
      expect(content).not.toContain('第二次改动。');
    });

    // 再撤销一步回到最初
    await user.click(screen.getByRole('button', { name: /撤销 AI 改动/u }));
    await waitFor(async () => expect(await chapterContent()).toBe(INITIAL));
  });

  it('整章生成也可以撤销', async () => {
    stubStream(['全新的一整章。']);
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: '生成本章' }));
    await screen.findByText('本次注入');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByLabelText('生成结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '替换正文' }));

    await waitFor(async () => expect(await chapterContent()).toBe('全新的一整章。'));

    await user.click(screen.getByRole('button', { name: /撤销 AI 改动/u }));
    await waitFor(async () => expect(await chapterContent()).toBe(INITIAL));
  });
});

describe('错误与中断', () => {
  it('接口报错时给出提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
        ),
      ),
    );
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('API Key 无效');
  });

  it('未配置模型时禁用操作', async () => {
    useLlmSettings.getState().clearApiKey();
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    const dialog = screen.getByRole('dialog', { name: '加工这一段' });
    expect(within(dialog).getByRole('button', { name: '开始改写' })).toBeDisabled();
    expect(within(dialog).getByText(/需要先在「设置」里配置模型/u)).toBeInTheDocument();
  });

  it('放弃结果后回到设置，正文不变', async () => {
    stubStream(['不要的内容。']);
    const user = await openEditor();
    await selectAndOpen(user, '第二段的内容。');

    await user.click(
      within(screen.getByRole('dialog', { name: '加工这一段' })).getByRole('button', {
        name: '开始改写',
      }),
    );
    await screen.findByLabelText('结果（可直接修改）');
    await user.click(screen.getByRole('button', { name: '放弃，重新设置' }));

    expect(screen.getByText('操作')).toBeInTheDocument();
    expect(await chapterContent()).toBe(INITIAL);
  });
});
