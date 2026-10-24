import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Novel } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { composeStylePrefix } from '@/prompt/sections';
import { completion, jsonResponse } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { StyleSection } from './StyleSection';

let harness: TestHarness;
let novel: Novel;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

function renderStyle() {
  return harness.renderUI(<StyleSection novel={novel} />);
}

async function openSheet() {
  const user = userEvent.setup();
  renderStyle();
  // 等档案加载完成
  await screen.findByText('三幕式');
  await user.click(screen.getByRole('button', { name: '调整' }));
  return user;
}

describe('风格档案摘要', () => {
  it('展示默认的文体与结构', async () => {
    renderStyle();

    expect(await screen.findByText('网络文学')).toBeInTheDocument();
    expect(screen.getByText('三幕式')).toBeInTheDocument();
    expect(screen.getByText('未设定')).toBeInTheDocument();
  });

  it('已选名家风格时显示名字与强度', async () => {
    await harness.repository.upsertStyleProfile(novel.id, {
      voiceRefs: [{ refId: 'gulong', name: '古龙', weight: 70 }],
    });

    renderStyle();

    expect(await screen.findByText('古龙 70%')).toBeInTheDocument();
  });
});

describe('三个维度的设定', () => {
  it('切换文体取向会清空子类，避免无效组合', async () => {
    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    // 先在网络文学下选一个子类
    await user.click(within(dialog).getByRole('button', { name: '仙侠' }));
    expect(within(dialog).getByRole('button', { name: '仙侠' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(dialog).getByRole('button', { name: '类型文学' }));

    // 类型文学的子类列表里没有「仙侠」，原选择必须被清掉
    expect(within(dialog).queryByRole('button', { name: '仙侠' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '推理' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('严肃文学没有子类可选', async () => {
    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: '严肃文学' }));

    expect(within(dialog).queryByText('子类')).not.toBeInTheDocument();
  });

  it('最多只能选两位名家风格', async () => {
    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: '古龙' }));
    await user.click(within(dialog).getByRole('button', { name: '金庸' }));
    expect(within(dialog).getByText(/已选 2 位/u)).toBeInTheDocument();

    // 第三位点不动
    await user.click(within(dialog).getByRole('button', { name: '鲁迅' }));
    expect(within(dialog).getByText(/已选 2 位/u)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '鲁迅' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('选中名家后出现强度滑杆与风格定位', async () => {
    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: '古龙' }));

    expect(within(dialog).getByText('极短句，孤绝气与格言感')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('古龙 的强度')).toHaveValue('60');
  });

  it('取消选择后移除该风格', async () => {
    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: '古龙' }));
    await user.click(within(dialog).getByRole('button', { name: '古龙' }));

    expect(within(dialog).queryByLabelText('古龙 的强度')).not.toBeInTheDocument();
  });

  it('保存后写入数据库并关闭', async () => {
    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: '仙侠' }));
    // 创作方法论是单选列表，控件角色是 radio
    await user.click(within(dialog).getByRole('radio', { name: /网文节奏结构/u }));
    await user.click(within(dialog).getByRole('button', { name: '古龙' }));
    await user.type(within(dialog).getByLabelText('额外写作要求'), '每章结尾留钩子。');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const saved = await harness.repository.getStyleProfile(novel.id);
    expect(saved).toMatchObject({
      tradition: 'web',
      subGenre: '仙侠',
      methodology: 'web-rhythm',
      extraInstruction: '每章结尾留钩子。',
    });
    expect(saved?.voiceRefs).toEqual([{ refId: 'gulong', name: '古龙', weight: 60 }]);
  });

  it('关闭后重开以库里的值为准，不残留未保存的编辑', async () => {
    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: '古龙' }));
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    await user.click(screen.getByRole('button', { name: '调整' }));

    expect(
      within(screen.getByRole('dialog')).queryByLabelText('古龙 的强度'),
    ).not.toBeInTheDocument();
  });

  it('保存的设定会体现在稳定前缀里', async () => {
    await harness.repository.upsertStyleProfile(novel.id, {
      tradition: 'web',
      subGenre: '仙侠',
      methodology: 'web-rhythm',
      voiceRefs: [{ refId: 'gulong', name: '古龙', weight: 70 }],
      extraInstruction: '每章结尾留钩子。',
    });

    const style = await harness.repository.getStyleProfile(novel.id);
    const prefix = composeStylePrefix(novel, style!);

    expect(prefix).toContain('归墟纪');
    expect(prefix).toContain('子类「仙侠」');
    expect(prefix).toContain('网文节奏结构');
    expect(prefix).toContain('参考风格：古龙（明显偏向）');
    expect(prefix).toContain('每章结尾留钩子。');
  });
});

describe('文风取样', () => {
  const SAMPLE = '雨'.repeat(200);
  const RUBRIC = {
    sentenceRhythm: '短句为主，一句一段',
    imagery: '雨、刀、长街',
    narrativeDistance: '贴近人物的孤独',
    dialogue: '短促带锋刃',
    rhetoric: '格言式断语',
    lexicon: '用字精简',
    avoid: '忌繁复长句',
  };

  function stubExtraction() {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(completion(JSON.stringify(RUBRIC))))),
    );
  }

  it('未配置模型时禁用提炼按钮', async () => {
    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByRole('button', { name: '提炼文风' })).toBeDisabled();
    expect(within(dialog).getByText(/需要先在「设置」里配置模型/u)).toBeInTheDocument();
    expect(user).toBeDefined();
  });

  it('示例文本太短时本地拦截，不发请求', async () => {
    useLlmSettings.getState().update({ apiKey: 'sk-test' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.type(within(dialog).getByLabelText('示例文本'), '太短了。');
    await user.click(within(dialog).getByRole('button', { name: '提炼文风' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('至少需要 100 字');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('提炼结果进入确认管道，确认后写入自定义文风', async () => {
    useLlmSettings.getState().update({ apiKey: 'sk-test' });
    stubExtraction();

    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByLabelText('示例文本'));
    await user.paste(SAMPLE);
    await user.click(within(dialog).getByRole('button', { name: '提炼文风' }));

    // 生成结果先成为待确认提案，而不是直接落库
    const acceptButton = await screen.findByRole('button', { name: /采用这份文风/u });
    expect(await harness.repository.getStyleProfile(novel.id)).toMatchObject({
      customRubric: null,
    });

    await user.click(acceptButton);

    // 落库与标记提案已处理是两步，必须一起等 —— 只等前一步的话用例会在
    // 后一步落库前结束，afterEach 关库后那次写入变成无人接管的 rejection
    await waitFor(async () => {
      const style = await harness.repository.getStyleProfile(novel.id);
      expect(style?.customRubric?.sentenceRhythm).toBe('短句为主，一句一段');
      expect(await harness.repository.listProposals(novel.id, { status: 'pending' })).toHaveLength(
        0,
      );
    });
  });

  it('确认后的自定义文风可以直接在界面上继续修改', async () => {
    useLlmSettings.getState().update({ apiKey: 'sk-test' });
    stubExtraction();

    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByLabelText('示例文本'));
    await user.paste(SAMPLE);
    await user.click(within(dialog).getByRole('button', { name: '提炼文风' }));
    await user.click(await screen.findByRole('button', { name: /采用这份文风/u }));

    const details = await screen.findByText('当前自定义文风（可直接修改）');
    await user.click(details);

    const rhythmField = screen.getByLabelText('句式节奏');
    expect(rhythmField).toHaveValue('短句为主，一句一段');

    await user.clear(rhythmField);
    await user.type(rhythmField, '长短句交错');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const style = await harness.repository.getStyleProfile(novel.id);
      expect(style?.customRubric?.sentenceRhythm).toBe('长短句交错');
    });
  });

  it('模型报错时展示可读提示', async () => {
    useLlmSettings.getState().update({ apiKey: 'sk-test' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: { message: 'bad key' } }, 401))),
    );

    const user = await openSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByLabelText('示例文本'));
    await user.paste(SAMPLE);
    await user.click(within(dialog).getByRole('button', { name: '提炼文风' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('API Key 无效');
  });
});

describe('版权边界提示', () => {
  it('界面上说明只用风格特征且不宜宣称关联', async () => {
    await openSheet();
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByText(/不含作品原文/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/不宜宣称与某位作家的关联/u)).toBeInTheDocument();
  });
});
