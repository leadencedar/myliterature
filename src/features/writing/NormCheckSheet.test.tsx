import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import { estimateTokens, formatTokens } from '@/context/tokens';
import { countWords } from '@/domain/primitives';
import type { Category, Novel } from '@/domain/schema';
import { normsInScope } from '@/domain/writingNorm';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import {
  buildNormCheckSystemPrompt,
  buildNormCheckUserPrompt,
  splitChapterForCheck,
  type NormCheckIssue,
} from './normCheck';
import { WritingPage } from './WritingPage';

/**
 * 「按规范检查本章」的界面与数据流：入口、面板、定位、按建议改写。
 * 写法沿用 ChapterEditor.test.tsx（从写作页进编辑器）；模型调用一律 spyOn fetch。
 * 这里守的核心是「只提示，不改正文」：整个流程前后库里与编辑器里的正文逐字相同。
 */

let harness: TestHarness;
let novel: Novel;
let charCategory: Category;

const QUOTE = '他推开门，走进雨里。';
const CONTENT = `雪落了整夜。${QUOTE}\n\n裴照站在檐下，没有说话。`;
const CHECK_MARKER = '【检查规范标记 K-31】';

const ISSUE_A: NormCheckIssue = {
  normTitle: '检查规范',
  rule: '人物出门前必须交代去向。',
  quote: QUOTE,
  problem: '问题A：没有交代去向。',
  suggestion: '先写他回头看了一眼。',
  severity: 'violation',
};
const ISSUE_B: NormCheckIssue = {
  normTitle: '写作规则',
  rule: '每章要有一处伏笔。',
  quote: '',
  problem: '问题B：本章没有伏笔。',
  suggestion: '',
  severity: 'judgement',
};

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  charCategory = (await harness.repository.listCategories(novel.id))[1]!;
  useActiveNovel.setState({ activeNovelId: novel.id });
  localStorage.clear();
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

async function createCheckNorm(title = '检查规范', marker = CHECK_MARKER) {
  return harness.repository.createWritingNorm(novel.id, {
    title,
    content: `- 人物出门前必须交代去向。\n${marker}`,
  });
}

async function createMainChapter(content = CONTENT) {
  return harness.repository.createChapter(novel.id, { title: '雪夜', content });
}

interface RequestBody {
  stream?: boolean;
  messages: { role: string; content: string }[];
}

function bodyOf(spy: ReturnType<typeof vi.spyOn>, index: number): RequestBody {
  const call = spy.mock.calls[index] as [unknown, RequestInit | undefined];
  return JSON.parse(String(call[1]?.body ?? '{}')) as RequestBody;
}
function systemOf(spy: ReturnType<typeof vi.spyOn>, index: number) {
  return bodyOf(spy, index).messages.find((message) => message.role === 'system')!.content;
}
function userOf(spy: ReturnType<typeof vi.spyOn>, index: number) {
  return bodyOf(spy, index).messages.find((message) => message.role === 'user')!.content;
}

/**
 * 结构化请求（检查）回 issues；流式请求（段落加工）回一段改写文字。
 * respond 可以按请求内容定制，比如让第二段失败
 */
function stubFetch(
  respond: (body: RequestBody) => Response = () =>
    jsonResponse(completion(JSON.stringify({ issues: [ISSUE_A, ISSUE_B] }))),
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as RequestBody;
    return Promise.resolve(
      body.stream ? sseResponse(textDeltaEvents(['改写后的句子。'])) : respond(body),
    );
  });
}

async function openEditor(name = '继续写第 1 章') {
  const user = userEvent.setup();
  harness.renderUI(<WritingPage />);
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  await user.click(await screen.findByRole('button', { name }));
  await screen.findByLabelText('章节正文');
  return user;
}

async function openCheck(
  user: ReturnType<typeof userEvent.setup>,
  name: string | RegExp = '按规范检查',
) {
  await user.click(screen.getByRole('button', { name }));
  return screen.findByRole('dialog', { name: '按规范检查' });
}

/** 打开面板 → 开始检查 → 等结果出来 */
async function runCheck(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await openCheck(user);
  await user.click(within(dialog).getByRole('button', { name: '开始检查' }));
  await within(dialog).findByText('问题A：没有交代去向。');
  return dialog;
}

function cardOf(dialog: HTMLElement, problem: string): HTMLElement {
  return within(dialog).getByText(problem).closest('li')!;
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText('章节正文') as HTMLTextAreaElement;
}

async function storedContent(): Promise<string | undefined> {
  return (await harness.repository.listChapters(novel.id))[0]?.content;
}

describe('请求内容', () => {
  it('system 含作用范围含「检查」的规范，user 含本章正文；停用的与只写正文的不出现', async () => {
    await createCheckNorm();
    await harness.repository.createWritingNorm(novel.id, {
      title: '停用规范',
      content: '停用规范【标记 OFF】',
      enabled: false,
    });
    await harness.repository.createWritingNorm(novel.id, {
      title: '只写正文',
      content: '只写正文【标记 W】',
      scopes: ['writing'],
    });
    await createMainChapter();
    const spy = stubFetch();
    const user = await openEditor();

    await runCheck(user);

    expect(spy).toHaveBeenCalledTimes(1);
    const system = systemOf(spy, 0);
    expect(system).toContain(CHECK_MARKER);
    expect(system).toContain('【规范《检查规范》】');
    expect(system).not.toContain('【标记 OFF】');
    expect(system).not.toContain('【标记 W】');
    expect(userOf(spy, 0)).toContain(CONTENT);
    expect(userOf(spy, 0)).toContain('【待检查的正文（第 1 章）】');
    // 检查是结构化推理任务：开思维链
    expect((bodyOf(spy, 0) as unknown as { thinking?: unknown }).thinking).toEqual({
      type: 'enabled',
    });
  });

  it('表单显示字数与 token 估算（K = 1 时不提分段；口径为 system + user，不含 schema 块）', async () => {
    await createCheckNorm();
    await createMainChapter();
    const user = await openEditor();

    const dialog = await openCheck(user);

    const norms = normsInScope(await harness.repository.listWritingNorms(novel.id), 'check');
    const categories = await harness.repository.listCategories(novel.id);
    const system = buildNormCheckSystemPrompt(novel, norms, [], categories);
    const userPrompt = buildNormCheckUserPrompt({
      chapterLabel: '第 1 章',
      segment: { index: 0, total: 1, text: CONTENT },
      mentionedEntries: [],
      categories,
    });
    const tokens = estimateTokens(system) + estimateTokens(userPrompt);
    expect(
      within(dialog).getByText(`本章约 ${countWords(CONTENT)} 字，输入${formatTokens(tokens)}`),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/将分/u)).not.toBeInTheDocument();
  });
});

describe('结果卡片', () => {
  beforeEach(async () => {
    await createCheckNorm();
    await createMainChapter();
  });

  it('两条都渲染，严重程度文案正确；匹配不上的规范名标「规范名未对应」', async () => {
    stubFetch();
    const user = await openEditor();
    const dialog = await runCheck(user);

    const a = cardOf(dialog, ISSUE_A.problem);
    const b = cardOf(dialog, ISSUE_B.problem);
    expect(within(a).getByText('明确违反')).toBeInTheDocument();
    expect(within(a).getByText('《检查规范》')).toBeInTheDocument();
    expect(within(a).getByText(ISSUE_A.rule)).toBeInTheDocument();
    expect(within(a).getByText(QUOTE)).toBeInTheDocument();
    expect(within(a).getByText(`建议：${ISSUE_A.suggestion}`)).toBeInTheDocument();
    expect(within(b).getByText('需作者判断')).toBeInTheDocument();
    expect(within(b).getByText('规范名未对应')).toBeInTheDocument();
    // quote 为空：没有可定位的原句
    expect(within(b).queryByRole('button', { name: '定位' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检查结果 2' })).toBeInTheDocument();
  });

  it('定位：面板关闭，选区落在原句上', async () => {
    stubFetch();
    const user = await openEditor();
    const dialog = await runCheck(user);

    await user.click(within(cardOf(dialog, ISSUE_A.problem)).getByRole('button', { name: '定位' }));

    expect(screen.queryByRole('dialog', { name: '按规范检查' })).not.toBeInTheDocument();
    const start = CONTENT.indexOf(QUOTE);
    expect(textarea().selectionStart).toBe(start);
    expect(textarea().selectionEnd).toBe(start + QUOTE.length);
  });

  it('忽略后卡片消失，入口计数减一；关掉再开结果还在', async () => {
    stubFetch();
    const user = await openEditor();
    const dialog = await runCheck(user);

    await user.click(within(cardOf(dialog, ISSUE_B.problem)).getByRole('button', { name: '忽略' }));

    expect(within(dialog).queryByText(ISSUE_B.problem)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检查结果 1' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    const reopened = await openCheck(user, '检查结果 1');
    expect(within(reopened).getByText(ISSUE_A.problem)).toBeInTheDocument();
    expect(within(reopened).queryByText(ISSUE_B.problem)).not.toBeInTheDocument();
  });

  it('按建议改写：打开段落加工，操作为改写且预填建议；放弃后正文不变', async () => {
    const spy = stubFetch();
    const user = await openEditor();
    const dialog = await runCheck(user);

    await user.click(
      within(cardOf(dialog, ISSUE_A.problem)).getByRole('button', { name: '按建议改写' }),
    );

    const revise = await screen.findByRole('dialog', { name: '加工这一段' });
    expect(within(revise).getByRole('button', { name: '改写' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(revise).getByLabelText('额外要求（可选）')).toHaveValue(
      `按写作规范《检查规范》修改：${ISSUE_A.suggestion}`,
    );
    expect(within(revise).getByText(QUOTE)).toBeInTheDocument();
    expect(textarea()).toHaveValue(CONTENT);

    await user.click(within(revise).getByRole('button', { name: '开始改写' }));
    await within(revise).findByLabelText('结果（可直接修改）');
    // 预填的要求随请求发出
    expect(userOf(spy, 1)).toContain(ISSUE_A.suggestion);
    await user.click(within(revise).getByRole('button', { name: '放弃，重新设置' }));

    expect(textarea()).toHaveValue(CONTENT);
    expect(await storedContent()).toBe(CONTENT);
  });

  it('预填会被清掉：关掉段落加工后再点「加工这一段」，额外要求为空、操作为默认', async () => {
    stubFetch();
    const user = await openEditor();
    const dialog = await runCheck(user);
    await user.click(
      within(cardOf(dialog, ISSUE_A.problem)).getByRole('button', { name: '按建议改写' }),
    );
    const revise = await screen.findByRole('dialog', { name: '加工这一段' });
    await user.click(within(revise).getByRole('button', { name: '关闭' }));

    await user.click(screen.getByRole('button', { name: '加工这一段' }));

    const again = await screen.findByRole('dialog', { name: '加工这一段' });
    expect(within(again).getByLabelText('额外要求（可选）')).toHaveValue('');
    // 选区仍在原句上，所以默认操作与没检查过时一样是「改写」
    expect(within(again).getByRole('button', { name: '改写' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('检查后原句被删：按钮仍在，点击只提示找不到，面板不关、选区不变、不打开改写', async () => {
    stubFetch();
    const user = await openEditor();
    let dialog = await runCheck(user);
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));

    const edited = '雪落了整夜。\n\n裴照站在檐下，没有说话。';
    await user.clear(textarea());
    await user.click(textarea());
    await user.paste(edited);
    const before = { start: textarea().selectionStart, end: textarea().selectionEnd };

    dialog = await openCheck(user, '检查结果 2');
    expect(within(dialog).getByText('正文在检查后改过，结果可能已过期')).toBeInTheDocument();
    const card = cardOf(dialog, ISSUE_A.problem);
    await user.click(within(card).getByRole('button', { name: '定位' }));

    expect(within(card).getByRole('status')).toHaveTextContent('这段原文已被修改，找不到了');
    expect(screen.getByRole('dialog', { name: '按规范检查' })).toBeInTheDocument();
    expect(textarea().selectionStart).toBe(before.start);
    expect(textarea().selectionEnd).toBe(before.end);

    await user.click(within(card).getByRole('button', { name: '按建议改写' }));
    expect(screen.queryByRole('dialog', { name: '加工这一段' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '按规范检查' })).toBeInTheDocument();
    expect(textarea()).toHaveValue(edited);
  });

  it('原句在检查时的正文里就找不到：不显示定位与按建议改写，标「正文里没找到这段原文」', async () => {
    stubFetch(() =>
      jsonResponse(
        completion(
          JSON.stringify({
            issues: [{ ...ISSUE_A, quote: '这句话正文里根本没有。' }],
          }),
        ),
      ),
    );
    const user = await openEditor();
    const dialog = await runCheck(user);

    const card = cardOf(dialog, ISSUE_A.problem);
    expect(within(card).getByText('正文里没找到这段原文')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: '定位' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: '按建议改写' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '忽略' })).toBeInTheDocument();
  });

  it('没有发现问题时给出参考性提示', async () => {
    stubFetch(() => jsonResponse(completion(JSON.stringify({ issues: [] }))));
    const user = await openEditor();
    const dialog = await openCheck(user);
    await user.click(within(dialog).getByRole('button', { name: '开始检查' }));

    expect(
      await within(dialog).findByText('没有发现明显违反规范之处。这是模型的判断，仅供参考。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '按规范检查' })).toBeInTheDocument();
  });

  it('整个检查流程前后，库里与编辑器里的正文逐字相同', async () => {
    stubFetch();
    const user = await openEditor();
    expect(await storedContent()).toBe(CONTENT);

    const dialog = await runCheck(user);
    await user.click(within(cardOf(dialog, ISSUE_B.problem)).getByRole('button', { name: '忽略' }));
    await user.click(within(cardOf(dialog, ISSUE_A.problem)).getByRole('button', { name: '定位' }));

    expect(textarea()).toHaveValue(CONTENT);
    expect(await storedContent()).toBe(CONTENT);
  });
});

describe('入口不可用', () => {
  it('没有规范时 aria-disabled，点击显示原因且不发请求；再次点击原因消失', async () => {
    await createMainChapter();
    const spy = stubFetch();
    const user = await openEditor();

    const entry = screen.getByRole('button', { name: '按规范检查' });
    expect(entry).toHaveAttribute('aria-disabled', 'true');
    await user.click(entry);

    expect(screen.getByRole('status')).toHaveTextContent('先在知识库添加写作规范');
    expect(screen.queryByRole('dialog', { name: '按规范检查' })).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();

    await user.click(entry);
    expect(screen.queryByText(/先在知识库添加写作规范/u)).not.toBeInTheDocument();
  });

  it('作用范围不含「检查」的规范不算', async () => {
    await harness.repository.createWritingNorm(novel.id, {
      title: '只写正文',
      content: '只写正文',
      scopes: ['writing'],
    });
    await createMainChapter();
    await openEditor();

    expect(screen.getByRole('button', { name: '按规范检查' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('未配置模型时显示配置提示且不发请求', async () => {
    await createCheckNorm();
    await createMainChapter();
    useLlmSettings.getState().clearApiKey();
    const spy = stubFetch();
    const user = await openEditor();

    const entry = screen.getByRole('button', { name: '按规范检查' });
    expect(entry).toHaveAttribute('aria-disabled', 'true');
    await user.click(entry);

    expect(screen.getByRole('status')).toHaveTextContent('需要先在「设置」里配置模型');
    expect(screen.queryByRole('dialog', { name: '按规范检查' })).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('正文为空时提示「本章还没有正文」', async () => {
    await createCheckNorm();
    await createMainChapter('');
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: '按规范检查' }));

    expect(screen.getByRole('status')).toHaveTextContent('本章还没有正文');
  });

  it('原因 3 秒后自动消失', async () => {
    await createMainChapter();
    await openEditor();
    vi.useFakeTimers();
    try {
      act(() => screen.getByRole('button', { name: '按规范检查' }).click());
      expect(screen.getByText(/先在知识库添加写作规范/u)).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(2999));
      expect(screen.getByText(/先在知识库添加写作规范/u)).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(screen.queryByText(/先在知识库添加写作规范/u)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('本次参与检查的规范', () => {
  it('取消一份只带另一份；全部取消则禁用并提示；关掉再开全部恢复', async () => {
    await createCheckNorm('检查规范', '【标记 一】');
    await createCheckNorm('第二份', '【标记 二】');
    await createMainChapter();
    const spy = stubFetch();
    const user = await openEditor();

    let dialog = await openCheck(user);
    expect(within(dialog).getByText('参与检查的规范（本次带上 2 / 2 份）')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^第二份（/u }));
    await user.click(within(dialog).getByRole('button', { name: '开始检查' }));
    await within(dialog).findByText(ISSUE_A.problem);

    expect(systemOf(spy, 0)).toContain('【标记 一】');
    expect(systemOf(spy, 0)).not.toContain('【标记 二】');
    // 库里仍启用
    expect((await harness.repository.listWritingNorms(novel.id)).every((n) => n.enabled)).toBe(
      true,
    );

    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    // 有结果时打开先看到结果；先清掉结果需要重新检查，这里改用新的编辑器会话验证表单状态
    await user.click(screen.getByRole('button', { name: '返回' }));
    await user.click(await screen.findByRole('button', { name: '继续写第 1 章' }));
    await screen.findByLabelText('章节正文');

    dialog = await openCheck(user);
    await user.click(within(dialog).getByRole('button', { name: /^检查规范（/u }));
    await user.click(within(dialog).getByRole('button', { name: /^第二份（/u }));
    expect(within(dialog).getByRole('button', { name: '开始检查' })).toBeDisabled();
    expect(within(dialog).getByText('至少保留一份规范')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    dialog = await openCheck(user);
    expect(within(dialog).getByRole('button', { name: /^检查规范（/u })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: /^第二份（/u })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: '开始检查' })).toBeEnabled();
  });
});

describe('长章与失败', () => {
  /** 每行都提到裴照，确保两段都会匹配到同一条相关设定 */
  const LONG = `${QUOTE}\n${'裴照在雪里站了很久，一句话也没有说。\n'.repeat(500)}`;

  beforeEach(async () => {
    await createCheckNorm();
    await harness.repository.createEntry(novel.id, {
      categoryId: charCategory.id,
      title: '裴照',
      summary: '六扇门捕头。',
    });
  });

  it('分段说明与 token 估算；发出 K 次请求，各段【相关设定】相同', async () => {
    await createMainChapter(LONG);
    const spy = stubFetch();
    const user = await openEditor();
    const dialog = await openCheck(user);

    const segments = splitChapterForCheck(LONG);
    expect(segments.length).toBe(2);
    const norms = normsInScope(await harness.repository.listWritingNorms(novel.id), 'check');
    const categories = await harness.repository.listCategories(novel.id);
    const entries = await harness.repository.listEntries(novel.id);
    const system = buildNormCheckSystemPrompt(novel, norms, [], categories);
    const tokens =
      2 * estimateTokens(system) +
      segments.reduce(
        (sum, text, index) =>
          sum +
          estimateTokens(
            buildNormCheckUserPrompt({
              chapterLabel: '第 1 章',
              segment: { index, total: 2, text },
              mentionedEntries: entries,
              categories,
            }),
          ),
        0,
      );
    expect(
      within(dialog).getByText(
        `本章约 ${countWords(LONG)} 字，将分 2 段检查（2 次调用），输入${formatTokens(tokens)}`,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '开始检查' }));
    // 两段各回一条，合并后两张卡片
    expect(await within(dialog).findAllByText(ISSUE_A.problem)).toHaveLength(2);

    expect(spy).toHaveBeenCalledTimes(2);
    const prefixes = [userOf(spy, 0), userOf(spy, 1)].map(
      (text) => text.split('【待检查的正文')[0],
    );
    expect(prefixes[0]).toContain('【相关设定】\n## 裴照');
    expect(prefixes[0]).toBe(prefixes[1]);
    expect(userOf(spy, 0)).toContain('第 1/2 段');
    expect(userOf(spy, 1)).toContain('第 2/2 段');
    // 系统提示各段共用
    expect(systemOf(spy, 0)).toBe(systemOf(spy, 1));
  });

  it('结果里点「重新检查」先回到表单、不发请求；改短正文后说明行按新的 K 显示', async () => {
    await createMainChapter(LONG);
    const spy = stubFetch();
    const user = await openEditor();
    let dialog = await openCheck(user);
    await user.click(within(dialog).getByRole('button', { name: '开始检查' }));
    expect(await within(dialog).findAllByText(ISSUE_A.problem)).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));

    await user.clear(textarea());
    await user.click(textarea());
    await user.paste(CONTENT);

    dialog = await openCheck(user, /^检查结果/u);
    await user.click(within(dialog).getByRole('button', { name: '重新检查' }));

    // 表单回来了：可以临时取消规范，也能看到调用次数；此时一个请求都没发
    expect(within(dialog).getByText('参与检查的规范（本次带上 1 / 1 份）')).toBeInTheDocument();
    expect(
      within(dialog).getByText(new RegExp(`^本章约 ${countWords(CONTENT)} 字，输入`, 'u')),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/将分/u)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(ISSUE_A.problem)).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);

    // 在表单里点「开始检查」才发请求：短章只发 1 次
    await user.click(within(dialog).getByRole('button', { name: '开始检查' }));
    expect(await within(dialog).findAllByText(ISSUE_A.problem)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('回到表单后不开始就关掉，再打开仍先看到上一次结果', async () => {
    await createMainChapter();
    const spy = stubFetch();
    const user = await openEditor();
    let dialog = await runCheck(user);
    await user.click(within(dialog).getByRole('button', { name: '重新检查' }));
    expect(within(dialog).getByRole('button', { name: '开始检查' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));

    dialog = await openCheck(user, '检查结果 2');
    expect(within(dialog).getByText(ISSUE_A.problem)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('回到表单后点「返回结果」：不关面板就回到上一次结果，不发请求', async () => {
    await createMainChapter();
    const spy = stubFetch();
    const user = await openEditor();
    const dialog = await runCheck(user);
    await user.click(within(dialog).getByRole('button', { name: '重新检查' }));
    expect(within(dialog).getByRole('button', { name: '开始检查' })).toBeInTheDocument();
    expect(within(dialog).queryByText(ISSUE_A.problem)).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '返回结果' }));
    expect(within(dialog).getByText(ISSUE_A.problem)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '开始检查' })).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('第二段失败时整次失败，不显示第一段的结果', async () => {
    await createMainChapter(LONG);
    const spy = stubFetch((body) =>
      body.messages.some((message) => message.content.includes('第 2/2 段'))
        ? new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })
        : jsonResponse(completion(JSON.stringify({ issues: [ISSUE_A] }))),
    );
    const user = await openEditor();
    const dialog = await openCheck(user);
    await user.click(within(dialog).getByRole('button', { name: '开始检查' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('第 2/2 段检查失败：');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(within(dialog).queryByText(ISSUE_A.problem)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '重新检查' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '按规范检查' })).toBeInTheDocument();
  });

  it('输出被截断时显示截断错误与精简建议，没有任何结果卡片', async () => {
    await createMainChapter();
    const spy = stubFetch(() =>
      jsonResponse(completion(JSON.stringify({ issues: [ISSUE_A] }), { finishReason: 'length' })),
    );
    const user = await openEditor();
    const dialog = await openCheck(user);
    await user.click(within(dialog).getByRole('button', { name: '开始检查' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('第 1/1 段检查失败：模型输出被截断，检查结果不完整');
    expect(alert).toHaveTextContent('先用 AI 精简压短规范');
    // 不进修复重试
    expect(spy).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByText(ISSUE_A.problem)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('listitem')).not.toBeInTheDocument();
  });
});

describe('外传章节', () => {
  it('同样可以检查，前情取外传内此前最近一份摘要，标题为「外传第 N 章」', async () => {
    await createCheckNorm();
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    // 主线也有一份摘要：外传不该承接它
    const main = await harness.repository.createChapter(novel.id, { content: '主线正文。' });
    await harness.repository.upsertSummary(novel.id, main.id, { summary: '主线的摘要。' });
    const first = await harness.repository.createChapter(novel.id, {
      sideStoryId: story.id,
      content: '外传第一章。',
    });
    await harness.repository.upsertSummary(novel.id, first.id, {
      summary: '师父拜入青冥宗。',
      openThreads: ['那柄断剑'],
    });
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, content: CONTENT });
    const spy = stubFetch();

    const user = await openEditor('继续写外传《青冥旧事》第 2 章');
    await runCheck(user);

    const prompt = userOf(spy, 0);
    expect(prompt).toContain('【此前最近一章（外传第 1 章）的摘要】');
    expect(prompt).toContain('师父拜入青冥宗。');
    expect(prompt).toContain('尚未收束的伏笔：那柄断剑');
    expect(prompt).not.toContain('主线的摘要。');
    expect(prompt).toContain('【待检查的正文（外传·青冥旧事 第 2 章）】');
  });
});
