import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category, Novel } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { NORM_FIXTURE_MARKER, createFixtureNorm } from '@/test/writingNormFixtures';
import { GLOSSARY_DELIMITER } from '../writing/translate';
import { ImportScreen } from './ImportScreen';

/**
 * 导入链路里的写作规范：逐章提取与世界观逐段提取都按「提取设定」作用范围带上规范，
 * 翻译一律不带（忠实优先，规范会诱导模型「修正」原文）。
 */

let harness: TestHarness;
let novel: Novel;
let categories: Category[];

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  categories = await harness.repository.listCategories(novel.id);
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

const MANUSCRIPT = [
  '第一章 离乡',
  '沈砚背起行囊时天还没亮。渔村的雾压得很低，他摸了摸怀里那块玉佩，转身没有回头。',
  '',
  '第二章 渡口',
  '渡口的雨下了三天。裴照倚在船篷下看他，说这条水路走到尽头就是归墟。沈砚没答话，他怕水。',
].join('\n');

const WORLDVIEW = [
  '灵潮：每逢子夜，天地灵气如潮水般涨落，修士借此突破境界。',
  '',
  '裴照：归墟渡口的船夫，知晓通往归墟的水路。',
].join('\n');

const EXTRACTION = {
  entries: [],
  summary: '沈砚离乡。',
  keyEvents: ['离乡'],
  appearingEntries: [],
  newOpenThreads: [],
  resolvedThreads: [],
  rollingSummary: '沈砚离乡北上。',
};

/** 翻译走流式（stream: true），提取走普通 JSON，与真实链路一致 */
function stubFetch(translation = '译文。') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
    return Promise.resolve(
      request.stream
        ? sseResponse(textDeltaEvents([translation]))
        : jsonResponse(completion(JSON.stringify(EXTRACTION))),
    );
  });
}

type Spy = ReturnType<typeof stubFetch>;

function requestsOf(spy: Spy): { stream: boolean; system: string; user: string }[] {
  return spy.mock.calls.map(([, init]) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      stream?: boolean;
      messages?: { role: string; content: string }[];
    };
    const content = (role: string) =>
      body.messages?.find((message) => message.role === role)?.content ?? '';
    return { stream: body.stream === true, system: content('system'), user: content('user') };
  });
}

async function pasteAndSplit(text: string) {
  const user = userEvent.setup();
  harness.renderUI(<ImportScreen novel={novel} categories={categories} onClose={() => {}} />);
  const textarea = await screen.findByLabelText('旧稿正文');
  await user.click(textarea);
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
  await screen.findByText(/切出 \d+ 章/u);
  return user;
}

describe('旧稿逐章提取', () => {
  it('作用范围含提取设定时，每章的提取请求都带上规范与禁止提取的那句', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const spy = stubFetch();
    const user = await pasteAndSplit(MANUSCRIPT);

    await user.click(screen.getByRole('button', { name: '写入主线 2 章' }));
    await screen.findByText(/提取完成/u);

    const extracts = requestsOf(spy).filter((request) => !request.stream);
    expect(extracts).toHaveLength(2);
    for (const request of extracts) {
      expect(request.system).toContain(NORM_FIXTURE_MARKER);
      expect(request.system).toContain('不要从规范里提取条目');
      // 规范只进系统提示，不混进待提取的正文
      expect(request.user).not.toContain(NORM_FIXTURE_MARKER);
    }
  });

  it('作用范围只含写正文时，提取请求不带规范', async () => {
    await createFixtureNorm(harness.repository, novel.id, { scopes: ['writing'] });
    const spy = stubFetch();
    const user = await pasteAndSplit(MANUSCRIPT);

    await user.click(screen.getByRole('button', { name: '写入主线 2 章' }));
    await screen.findByText(/提取完成/u);

    const extracts = requestsOf(spy);
    expect(extracts.length).toBeGreaterThan(0);
    for (const request of extracts) {
      expect(request.system).not.toContain(NORM_FIXTURE_MARKER);
      expect(request.system).not.toContain('不要从规范里提取条目');
    }
  });
});

describe('作为世界观设定导入', () => {
  it('逐段提取同样带上规范与禁止提取的那句', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const spy = stubFetch();
    const user = await pasteAndSplit(WORLDVIEW);

    await user.click(screen.getByRole('radio', { name: /^仅作为世界观设定/u }));
    await user.click(screen.getByRole('button', { name: /^提取为世界观设定$/u }));
    await screen.findByText(/提取完成/u);

    const [request] = requestsOf(spy);
    expect(request?.system).toContain(NORM_FIXTURE_MARKER);
    expect(request?.system).toContain('不要从规范里提取条目');
  });
});

describe('外文稿翻译', () => {
  const FOREIGN = [
    'Chapter 1',
    'Ashford shouldered the pack before dawn. The fog over the fishing village hung low, ' +
      'and he touched the jade at his chest and turned away without looking back.',
    '',
    'Chapter 2',
    'The rain at Greymoor ferry had lasted three days. Ashford waited under the awning, ' +
      'listening to the water and counting what little he had left to trade.',
  ].join('\n');

  it('翻译请求不带规范，即便规范作用范围全开', async () => {
    await createFixtureNorm(harness.repository, novel.id);
    const spy = stubFetch(
      ['阿什福德在黎明前背起了行囊。', GLOSSARY_DELIMITER, 'Ashford => 阿什福德'].join('\n'),
    );
    const user = await pasteAndSplit(FOREIGN);

    await user.click(screen.getByRole('button', { name: '下一步：翻译（2 章）' }));
    await user.click(await screen.findByRole('button', { name: /开始翻译（2 章）/u }));
    await screen.findByText(/已翻译 2 \/ 2 章/u);

    const translations = requestsOf(spy).filter((request) => request.stream);
    expect(translations).toHaveLength(2);
    for (const request of translations) {
      expect(request.system).not.toContain(NORM_FIXTURE_MARKER);
      expect(request.user).not.toContain(NORM_FIXTURE_MARKER);
      expect(request.system).not.toContain('【作者的写作规范】');
    }
  });
});
