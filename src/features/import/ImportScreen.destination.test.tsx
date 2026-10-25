/**
 * 导入面板：目的地后置、草稿上的翻译、外传、旧任务兼容。
 *
 * 与 ImportScreen.test.tsx 分开放：那边是改写到新流程的既有用例，
 * 这里是 design 第 11 节「新增或改写：导入界面」逐条新增的用例。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category, ImportJob, Novel } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { GLOSSARY_DELIMITER } from '../writing/translate';
import { ImportScreen } from './ImportScreen';

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- 素材

const MANUSCRIPT = [
  '第一章 离乡',
  '沈砚背起行囊时天还没亮。渔村的雾压得很低，他摸了摸怀里那块玉佩，转身没有回头。',
  '',
  '第二章 渡口',
  '渡口的雨下了三天。裴照倚在船篷下看他，说这条水路走到尽头就是归墟。沈砚没答话，他怕水。',
  '',
  '第三章 灵潮',
  '灵潮在子夜翻涌起来，玉佩烫得几乎握不住。沈砚终于明白母亲留下它的用意。',
].join('\n');

const SECOND = ['第四章 归墟', '归墟的水是黑的。沈砚站在崖边，把玉佩举到眼前。'].join('\n');

/** 两章英文 + 一章中文 */
const MIXED = [
  'Chapter 1',
  'Ashford shouldered the pack before dawn. The fog over the fishing village hung low, ' +
    'and he touched the jade at his chest and turned away without looking back.',
  '',
  'Chapter 2',
  'The rain at Greymoor ferry had lasted three days. Ashford waited under the awning, ' +
    'listening to the water and counting what little he had left to trade.',
  '',
  '第三章 灵潮',
  '灵潮在子夜翻涌起来，玉佩烫得几乎握不住。沈砚终于明白母亲留下它的用意。',
].join('\n');

/** 两章英文 */
const ENGLISH = [
  'Chapter 1',
  'Ashford shouldered the pack before dawn and left the fishing village behind him.',
  '',
  'Chapter 2',
  'The rain at Greymoor ferry had lasted three days while Ashford waited under the awning.',
].join('\n');

const T1 = [
  '阿什福德在黎明前背起了行囊，把渔村留在身后。',
  '渔村的雾压得很低，他摸了摸胸前的玉，转身没有回头。',
  GLOSSARY_DELIMITER,
  'Ashford => 阿什福德',
].join('\n');
const T2 = [
  '灰沼渡口的雨下了三天，阿什福德在雨篷下等着。',
  '他听着水声，数着自己还剩下什么可以换钱。',
  GLOSSARY_DELIMITER,
  'Ashford => 阿什福德',
  'Greymoor => 灰沼',
].join('\n');

const EXTRACTION = {
  entries: [
    {
      categoryName: '人物',
      title: '沈砚',
      aliases: [],
      summary: '离乡寻母的少年',
      fields: [{ key: 'identity', value: '十七岁，渔村出身' }],
    },
  ],
  summary: '沈砚离乡。',
  keyEvents: ['离乡'],
  appearingEntries: [],
  newOpenThreads: [],
  resolvedThreads: [],
  rollingSummary: '沈砚在灵潮之夜明白玉佩的来历。',
};

// ---------------------------------------------------------------- 请求替身

interface RequestBody {
  stream?: boolean;
  messages: { role: string; content: string }[];
}

type Reply = Response | Promise<Response>;

/**
 * 按请求类型分别应答：翻译走流式（stream: true），提取走普通 JSON。
 * 回调拿到「这是第几次翻译 / 第几次提取」和原始 init（读 signal 用）。
 */
function stubLlm(handlers: {
  translate?: (call: number, body: RequestBody, init?: RequestInit) => Reply;
  extract?: (call: number, body: RequestBody, init?: RequestInit) => Reply;
}) {
  let translateCalls = 0;
  let extractCalls = 0;
  const spy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as RequestBody;
    if (body.stream) {
      translateCalls += 1;
      return Promise.resolve(
        handlers.translate?.(translateCalls, body, init) ?? sseResponse(textDeltaEvents([T1])),
      );
    }
    extractCalls += 1;
    return Promise.resolve(handlers.extract?.(extractCalls, body, init) ?? extractionReply());
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function extractionReply(result: unknown = EXTRACTION): Response {
  return jsonResponse(completion(JSON.stringify(result)));
}

function translationReply(text: string): Response {
  return sseResponse(textDeltaEvents([text]));
}

/** 一个可以从外面放行的挂起应答 */
function deferred() {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 挂起直到请求被 abort，abort 时按 fetch 的规矩抛 AbortError */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

function bodiesOf(spy: ReturnType<typeof stubLlm>): RequestBody[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[1]?.body ?? '{}')) as RequestBody);
}

function userMessageOf(body: RequestBody | undefined): string {
  return body?.messages.find((message) => message.role === 'user')?.content ?? '';
}

function translateBodies(spy: ReturnType<typeof stubLlm>) {
  return bodiesOf(spy).filter((body) => body.stream);
}

function extractBodies(spy: ReturnType<typeof stubLlm>) {
  return bodiesOf(spy).filter((body) => !body.stream);
}

// ---------------------------------------------------------------- 操作

type User = ReturnType<typeof userEvent.setup>;
type Destination = 'main' | 'worldview' | { side: string } | { newSide: string };

function renderImport(onClose = () => {}) {
  return harness.renderUI(<ImportScreen novel={novel} categories={categories} onClose={onClose} />);
}

async function pasteManuscript(text = MANUSCRIPT) {
  const user = userEvent.setup();
  const view = renderImport();
  await user.click(await screen.findByLabelText('旧稿正文'));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
  await screen.findByText(/切出 \d+ 章/u);
  return { user, view };
}

async function chooseDestination(user: User, destination: Destination) {
  if (destination === 'main') {
    await user.click(screen.getByRole('radio', { name: /^主线章节/u }));
    return;
  }
  if (destination === 'worldview') {
    await user.click(screen.getByRole('radio', { name: /^仅作为世界观设定/u }));
    return;
  }
  const radio = screen.getByRole('radio', { name: /^外传/u });
  if (!(radio as HTMLInputElement).checked) await user.click(radio);
  const select = screen.getByLabelText('哪一部外传');
  if ('side' in destination) {
    await user.selectOptions(select, destination.side);
    return;
  }
  await user.selectOptions(select, '__new__');
  const name = screen.getByLabelText(/外传名称/u);
  await user.clear(name);
  await user.click(name);
  await user.paste(destination.newSide);
}

/** 选目的地并点主按钮 */
async function confirmSplit(user: User, destination: Destination = 'main') {
  if (destination !== 'main') await chooseDestination(user, destination);
  const name =
    destination === 'main'
      ? /^写入主线 \d+ 章$/u
      : destination === 'worldview'
        ? /^提取为世界观设定$/u
        : /^写入外传 \d+ 章$/u;
  await user.click(screen.getByRole('button', { name }));
}

/** 外文稿：存下草稿，停在翻译步骤 */
async function reachTranslate(text = MIXED) {
  const pasted = await pasteManuscript(text);
  await pasted.user.click(screen.getByRole('button', { name: /^下一步：翻译（\d+ 章）$/u }));
  await screen.findByText(/已翻译 0 \/ \d+ 章/u);
  return pasted;
}

/** 步骤条 */
function stepBar() {
  const list = screen.getByRole('dialog', { name: '导入旧稿' }).querySelector('header ol');
  return within(list as HTMLElement);
}

async function currentJob(): Promise<ImportJob | undefined> {
  return harness.repository.getImportJob(novel.id);
}

/** 用 put 绕过仓储直接写一条原始行（不经 parse，才能复现旧库里的形状） */
async function putRawJob(row: Record<string, unknown>) {
  await harness.database.importJobs.put({
    id: 'legacy-job',
    novelId: novel.id,
    ...row,
  } as unknown as ImportJob);
}

/** 让挂起的 promise 链跑完一轮（迟到写回之类） */
async function settle(ms = 50) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('纯中文稿：目的地在分章页选', () => {
  it('粘贴步骤没有「导入类型」控件', async () => {
    const user = userEvent.setup();
    renderImport();
    await user.click(await screen.findByLabelText('旧稿正文'));
    await user.paste(MANUSCRIPT);

    expect(screen.queryByText('导入类型')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '作为世界观设定' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '作为章节' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步：切分章节' })).toBeEnabled();
  });

  it('分章页里就有 picker，默认主线，步骤条里没有「翻译」和「导入到」', async () => {
    await pasteManuscript();

    expect(screen.getByRole('radio', { name: /^主线章节/u })).toBeChecked();
    expect(screen.getByRole('button', { name: '写入主线 3 章' })).toBeEnabled();
    // 主线默认勾上文风归纳
    expect(screen.getByRole('checkbox', { name: /顺便归纳这部作品的文风/u })).toBeChecked();
    expect(stepBar().queryByText('翻译')).not.toBeInTheDocument();
    expect(stepBar().queryByText('导入到')).not.toBeInTheDocument();
    expect(stepBar().getByText('分章')).toHaveAttribute('aria-current', 'step');
  });

  it('主按钮文案随目的地变化', async () => {
    const { user } = await pasteManuscript();
    await chooseDestination(user, { newSide: '青冥旧事' });
    expect(screen.getByRole('button', { name: '写入外传 3 章' })).toBeEnabled();
    await chooseDestination(user, 'worldview');
    expect(screen.getByRole('button', { name: '提取为世界观设定' })).toBeEnabled();
  });
});

describe('外文稿：草稿上的翻译', () => {
  it('翻译期间章节表是空的，草稿在任务上', async () => {
    const pending = deferred();
    stubLlm({ translate: (call) => (call === 1 ? pending.promise : translationReply(T2)) });
    const { user } = await reachTranslate();

    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));
    await screen.findByText('正在翻译第 1 章…');

    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
    const during = await currentJob();
    expect(during?.destination).toBeNull();
    expect(during?.drafts.map((item) => item.translateStatus)).toEqual([
      'pending',
      'pending',
      'none',
    ]);

    pending.release(translationReply(T1));
    await screen.findByText(/已翻译 2 \/ 2 章/u);
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
  });

  it('中途卸载再重开回到翻译步骤，已译的章节不再请求', async () => {
    const spy = stubLlm({
      translate: (call, _body, init) =>
        call === 1 ? translationReply(T1) : hangUntilAborted(init),
    });
    const { user, view } = await reachTranslate();
    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));
    await screen.findByText(/已翻译 1 \/ 2 章/u);
    await waitFor(() => expect(translateBodies(spy)).toHaveLength(2));

    view.unmount();
    vi.unstubAllGlobals();
    const respawn = stubLlm({ translate: () => translationReply(T2) });
    renderImport();

    expect(await screen.findByText(/已翻译 1 \/ 2 章/u)).toBeInTheDocument();
    expect(screen.getByText('已译')).toBeInTheDocument();
    await userEvent.setup().click(await screen.findByRole('button', { name: '继续翻译' }));
    await screen.findByText(/已翻译 2 \/ 2 章/u);

    // 第一章付过钱了，只补译第二章
    const requests = translateBodies(respawn);
    expect(requests).toHaveLength(1);
    expect(userMessageOf(requests[0])).toContain('Greymoor ferry');
    expect(userMessageOf(requests[0])).not.toContain('shouldered the pack');
  });

  it('翻译续跑：重开后第二章的 prompt 带上第一章译文的结尾', async () => {
    stubLlm({ translate: () => translationReply(T1) });
    const { user, view } = await reachTranslate();
    await user.click(screen.getByLabelText('翻译第 2 章'));
    // 按钮文案要等勾选写入 IndexedDB 之后才更新
    await user.click(await screen.findByRole('button', { name: '开始翻译（1 章）' }));
    await screen.findByText(/已翻译 1 \/ 1 章/u);

    view.unmount();
    vi.unstubAllGlobals();
    const spy = stubLlm({ translate: () => translationReply(T2) });
    const again = userEvent.setup();
    renderImport();
    // 没有待译章节，恢复时落在目的地步骤；返回翻译后把第二章勾回来
    await again.click(await screen.findByRole('button', { name: '返回翻译' }));
    await again.click(await screen.findByLabelText('翻译第 2 章'));
    await again.click(await screen.findByRole('button', { name: '继续翻译' }));
    await screen.findByText(/已翻译 2 \/ 2 章/u);

    const prompt = userMessageOf(translateBodies(spy)[0]);
    expect(prompt).toContain('【上一章译文的结尾');
    expect(prompt).toContain('阿什福德在黎明前背起了行囊');
  });

  it('跳过剩下的章节后刷新，落在目的地步骤', async () => {
    stubLlm({});
    const { user, view } = await reachTranslate();
    await user.click(await screen.findByRole('button', { name: '跳过剩下的，选择导入方式' }));
    expect(await screen.findByRole('button', { name: '写入主线 3 章' })).toBeInTheDocument();
    expect((await currentJob())?.drafts.map((item) => item.translateStatus)).toEqual([
      'none',
      'none',
      'none',
    ]);

    view.unmount();
    renderImport();
    expect(await screen.findByRole('button', { name: '写入主线 3 章' })).toBeInTheDocument();
    expect(stepBar().getByText('导入到')).toHaveAttribute('aria-current', 'step');
  });

  it('有 1 章翻译失败时跳过剩下的，刷新后仍在目的地步骤；选主线后这一章按原文写入', async () => {
    stubLlm({
      translate: (call) =>
        call === 1 ? translationReply(T1) : jsonResponse({ error: { message: '余额不足' } }, 402),
    });
    const { user, view } = await reachTranslate();
    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));
    await screen.findByText(/第 2 章翻译失败/u);

    // 失败也算「剩下的」
    await user.click(await screen.findByRole('button', { name: '跳过剩下的，选择导入方式' }));
    await screen.findByRole('button', { name: '写入主线 3 章' });
    const skipped = await currentJob();
    expect(skipped?.drafts[1]).toMatchObject({ translateStatus: 'none', translateError: '' });

    view.unmount();
    const again = userEvent.setup();
    renderImport();
    await again.click(await screen.findByRole('button', { name: '写入主线 3 章' }));
    await screen.findByText(/提取完成/u);

    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters[0]?.content).toContain('阿什福德在黎明前背起了行囊');
    expect(chapters[1]?.content).toContain('The rain at Greymoor ferry');
    expect(chapters[1]?.sourceContent).toBe('');
  });

  it('跳过全部待译章节后，步骤条仍有「翻译」，可以返回翻译且数据不变', async () => {
    stubLlm({});
    const { user } = await reachTranslate();
    await user.click(await screen.findByRole('button', { name: '跳过剩下的，选择导入方式' }));
    await screen.findByRole('button', { name: '写入主线 3 章' });
    const before = await currentJob();

    expect(stepBar().getByText('翻译')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回翻译' }));

    expect(await screen.findByText(/已翻译 0 \/ 0 章/u)).toBeInTheDocument();
    expect(screen.getByLabelText('翻译第 1 章')).not.toBeChecked();
    expect((await currentJob())?.drafts).toEqual(before?.drafts);
    // 跳过的章节可以重新勾上
    await user.click(screen.getByLabelText('翻译第 1 章'));
    await waitFor(async () => {
      expect((await currentJob())?.drafts[0]?.translateStatus).toBe('pending');
    });
  });

  it('译文被输出上限截断时这一章算失败，草稿仍是原文，译名不合并', async () => {
    const truncated = [
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
      // 有的服务商最后另发一帧只带 usage，不能把 'length' 冲掉
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    ];
    stubLlm({ translate: () => sseResponse(textDeltaEvents([T1], truncated)) });
    const { user } = await reachTranslate();
    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));

    const alert = await screen.findByText(/第 1 章翻译失败：译文超出单次输出上限被截断了/u);
    expect(alert.closest('[role="alert"]')).toHaveTextContent(
      '这一章太长，回到分章页把它切小一些再译',
    );
    const job = await currentJob();
    expect(job?.drafts[0]?.translateStatus).toBe('failed');
    expect(job?.drafts[0]?.content).toContain('Ashford shouldered the pack');
    expect(job?.drafts[0]?.sourceContent).toBe('');
    expect((await harness.repository.getGlossary(novel.id))?.terms ?? []).toEqual([]);
  });

  it('分章页：超过 6000 字的外文草稿旁有截断风险提示，中文与不超长的外文没有', async () => {
    const longEnglish = 'The fog hung low over the fishing village. '.repeat(160);
    const longChinese = '灵潮在子夜翻涌起来，玉佩烫得几乎握不住。'.repeat(320);
    await pasteManuscript(
      [
        'Chapter 1',
        longEnglish,
        '',
        'Chapter 2',
        'A short English chapter about the rain.',
        '',
        '第三章 灵潮',
        longChinese,
      ].join('\n'),
    );

    const notes = screen.getAllByRole('note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(
      '这一章较长，翻译时会自动分段进行；如果想按剧情节奏切小，也可以在这里调整',
    );
    expect(notes[0]!.closest('li')).toHaveTextContent('第 1 章');
  });

  it('旧实例迟到的写回不会把已译章节改回原文，草稿数量不变', async () => {
    const stale = deferred();
    const OLD = [
      '旧实例翻译的完整译文，把整段原文都译了出来。',
      GLOSSARY_DELIMITER,
      'Fogvale => 雾谷',
    ].join('\n');
    stubLlm({
      translate: (call, body) => {
        // 第一次请求挂起，不理会 abort（模拟请求已经返回、来不及中止）
        if (call === 1) return stale.promise;
        return translationReply(userMessageOf(body).includes('Greymoor') ? T2 : T1);
      },
    });
    const { user, view } = await reachTranslate(ENGLISH);
    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));
    await screen.findByText('正在翻译第 1 章…');

    view.unmount();
    const again = userEvent.setup();
    renderImport();
    await again.click(await screen.findByRole('button', { name: '开始翻译（2 章）' }));
    await screen.findByText(/已翻译 2 \/ 2 章/u);

    // 旧实例的那一章这时才流完
    stale.release(translationReply(OLD));
    await waitFor(async () => {
      const terms = (await harness.repository.getGlossary(novel.id))?.terms ?? [];
      expect(terms.some((term) => term.source === 'Fogvale')).toBe(true);
    });

    const job = await currentJob();
    expect(job?.drafts).toHaveLength(2);
    expect(job?.drafts[0]?.translateStatus).toBe('done');
    expect(job?.drafts[0]?.content).toContain('阿什福德在黎明前背起了行囊');
    expect(job?.drafts[0]?.content).not.toContain('旧实例');
    expect(job?.drafts[1]).toMatchObject({ translateStatus: 'done' });
    expect(job?.drafts[1]?.content).toContain('灰沼渡口');
  });

  it('卸载时中止进行中的翻译请求，这一章在库里仍是待译', async () => {
    const signals: AbortSignal[] = [];
    stubLlm({
      translate: (_call, _body, init) => {
        if (init?.signal) signals.push(init.signal);
        return hangUntilAborted(init);
      },
    });
    const { user, view } = await reachTranslate();
    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));
    await waitFor(() => expect(signals).toHaveLength(1));

    view.unmount();
    expect(signals[0]?.aborted).toBe(true);
    await settle();

    const job = await currentJob();
    expect(job?.drafts[0]).toMatchObject({ translateStatus: 'pending', translateError: '' });
  });

  it('翻译中另一处把这批稿件写成了主线：写回被拒，静默进入提取步骤', async () => {
    const pending = deferred();
    stubLlm({ translate: () => pending.promise });
    const { user } = await reachTranslate(ENGLISH);
    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));
    await screen.findByText('正在翻译第 1 章…');

    // 模拟另一个标签页
    await harness.repository.commitImportChapters(novel.id, {
      target: { kind: 'main' },
      withStyle: false,
    });
    pending.release(translationReply(T1));

    expect(await screen.findByText(/已提取 0 \/ 2 章/u)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const job = await currentJob();
    expect(job?.destination).toEqual({ kind: 'main' });
    expect(job?.drafts).toEqual([]);
    // 写入的是原文，迟到的译文没有塞回去
    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters[0]?.content).toContain('Ashford shouldered the pack');
  });

  it('翻译中另一处放弃了这批稿件：写回被拒，不新建任务行，回到粘贴步骤', async () => {
    const pending = deferred();
    stubLlm({ translate: () => pending.promise });
    const { user } = await reachTranslate(ENGLISH);
    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));
    await screen.findByText('正在翻译第 1 章…');

    await harness.repository.deleteImportJob(novel.id);
    pending.release(translationReply(T1));

    expect(await screen.findByLabelText('旧稿正文')).toBeInTheDocument();
    await settle();
    expect(await currentJob()).toBeUndefined();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('译文写回时存储出错（任务仍是这批草稿）：显示 alert、循环停下，这一章仍待译', async () => {
    const spy = stubLlm({ translate: () => translationReply(T1) });
    const { user } = await reachTranslate(ENGLISH);
    // 分段翻译的第一笔写入是切段计划（在任何请求之前）：存储错误在花钱之前就把循环拦下
    vi.spyOn(harness.repository, 'patchImportDrafts').mockRejectedValueOnce(
      new Error('QuotaExceededError'),
    );

    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '第 1 章的翻译没存上：QuotaExceededError。浏览器存储可能已满，可以先导出备份。',
    );
    // 循环停下，一次模型请求都没发出，没有烧钱
    expect(translateBodies(spy)).toHaveLength(0);
    expect(await screen.findByRole('button', { name: '开始翻译（2 章）' })).toBeEnabled();
    expect(screen.getByText(/已翻译 0 \/ 2 章/u)).toBeInTheDocument();
    const job = await currentJob();
    expect(job?.destination).toBeNull();
    expect(job?.drafts.map((item) => item.translateStatus)).toEqual(['pending', 'pending']);
  });

  it('勾选写入时存储出错：显示 alert，勾选状态不变', async () => {
    stubLlm({});
    const { user } = await reachTranslate(ENGLISH);
    vi.spyOn(harness.repository, 'patchImportDrafts').mockRejectedValueOnce(
      new Error('QuotaExceededError'),
    );

    await user.click(screen.getByLabelText('翻译第 2 章'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '第 2 章的翻译设置没存上：QuotaExceededError。浏览器存储可能已满，可以先导出备份。',
    );
    expect(screen.getByLabelText('翻译第 2 章')).toBeChecked();
    expect((await currentJob())?.drafts[1]?.translateStatus).toBe('pending');
  });

  it('连点两下勾选框：两下都生效，回到原来的勾选状态', async () => {
    stubLlm({});
    const { user } = await reachTranslate(ENGLISH);
    // 让写入挂起，两下点击都发生在第一次写入返回之前
    const original = harness.repository.patchImportDrafts.bind(harness.repository);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const patchSpy = vi
      .spyOn(harness.repository, 'patchImportDrafts')
      .mockImplementation(async (...args) => {
        await gate;
        return original(...args);
      });

    const box = screen.getByLabelText('翻译第 2 章');
    await user.click(box);
    await user.click(box);
    expect(patchSpy).toHaveBeenCalledTimes(2);
    expect(patchSpy.mock.calls.map((call) => call[1][0]?.patch.translateStatus)).toEqual([
      'none',
      'pending',
    ]);

    open();
    await waitFor(async () =>
      expect((await currentJob())?.drafts[1]?.translateStatus).toBe('pending'),
    );
    // 两次写回都落到界面上之后：按钮文案与勾选框都回到「要译」
    await settle();
    expect(screen.getByRole('button', { name: '开始翻译（2 章）' })).toBeInTheDocument();
    expect(screen.getByLabelText('翻译第 2 章')).toBeChecked();
    expect(screen.queryByText('不译')).not.toBeInTheDocument();
  });

  it('另一处已经有一批草稿时，分章页提交不覆盖它，落到那批稿件的步骤并说明', async () => {
    stubLlm({});
    const { user } = await pasteManuscript();
    await harness.repository.saveImportDrafts(novel.id, {
      batchId: 'other',
      drafts: [
        {
          index: 1,
          title: '别处的一章',
          content: '别处的稿子。',
          sourceContent: '',
          sourceLanguage: '',
          translateStatus: 'none',
          translateError: '',
        },
      ],
      expectedJobId: null,
    });

    await confirmSplit(user);

    expect(
      await screen.findByText(
        '另一处已经有一批稿件在处理中，这次的分章结果没有保存；处理完那一批再导入',
      ),
    ).toHaveAttribute('role', 'note');
    expect(screen.getByRole('button', { name: '写入主线 1 章' })).toBeInTheDocument();
    const job = await currentJob();
    expect(job?.batchId).toBe('other');
    expect(job?.drafts.map((item) => item.title)).toEqual(['别处的一章']);
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
  });
});

describe('提交失败与幂等', () => {
  /** 外文稿跳过翻译，停在目的地步骤 */
  async function reachDestination() {
    const pasted = await reachTranslate(ENGLISH);
    await pasted.user.click(
      await screen.findByRole('button', { name: '跳过剩下的，选择导入方式' }),
    );
    await screen.findByRole('button', { name: '写入主线 2 章' });
    return pasted;
  }

  /** 选一部已有外传，然后在别处把它删掉，再点主按钮 */
  async function commitToDeletedSide() {
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    stubLlm({});
    const { user } = await pasteManuscript();
    await chooseDestination(user, { side: story.id });
    await harness.repository.deleteSideStory(story.id);
    await user.click(screen.getByRole('button', { name: '写入外传 3 章' }));
    await screen.findByText('所选外传已不存在，可能已被删除');
    return { user, story };
  }

  it('commit 被拒时留在目的地步骤显示错误，一章都不写', async () => {
    await commitToDeletedSide();

    expect(screen.getByRole('alert')).toHaveTextContent('所选外传已不存在，可能已被删除');
    expect(stepBar().getByText('导入到')).toHaveAttribute('aria-current', 'step');
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
    const job = await currentJob();
    expect(job?.destination).toBeNull();
    expect(job?.drafts).toHaveLength(3);
  });

  it('commit 被拒、重读发现这批稿件已在别处放弃：回到粘贴步骤并说明，不报错', async () => {
    stubLlm({});
    const { user } = await reachDestination();
    await harness.repository.deleteImportJob(novel.id);

    await user.click(screen.getByRole('button', { name: '写入主线 2 章' }));

    expect(await screen.findByLabelText('旧稿正文')).toBeInTheDocument();
    expect(
      screen.getByText('这批稿件已经在别处放弃了，这次没有写入；需要的话重新粘贴导入'),
    ).toHaveAttribute('role', 'note');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await currentJob()).toBeUndefined();
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
  });

  it('commit 被拒且重读任务失败：仍留在目的地步骤显示错误', async () => {
    stubLlm({});
    const { user } = await reachDestination();
    vi.spyOn(harness.repository, 'commitImportChapters').mockRejectedValueOnce(
      new Error('事务中止'),
    );
    vi.spyOn(harness.repository, 'getImportJob').mockRejectedValueOnce(new Error('读不出来'));

    await user.click(screen.getByRole('button', { name: '写入主线 2 章' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('事务中止');
    expect(stepBar().getByText('导入到')).toHaveAttribute('aria-current', 'step');
  });

  it('所选外传在别处被删后，picker 回退到「新建外传」、名称留空', async () => {
    const { story } = await commitToDeletedSide();

    const select = await screen.findByLabelText('哪一部外传');
    await waitFor(() => expect(select).toHaveValue('__new__'));
    expect(within(select).queryByRole('option', { name: story.title })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/外传名称/u)).toHaveValue('');
    expect(screen.getByRole('button', { name: '写入外传 3 章' })).toBeDisabled();
  });

  it('另一处已经写入过：界面上再点一次，直接进入提取步骤、不报错，章节只有一份', async () => {
    stubLlm({});
    const { user } = await reachDestination();
    await harness.repository.commitImportChapters(novel.id, {
      target: { kind: 'main' },
      withStyle: false,
    });

    await user.click(screen.getByRole('button', { name: '写入主线 2 章' }));

    expect(await screen.findByText(/已提取 0 \/ 2 章/u)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await harness.repository.listChapters(novel.id)).toHaveLength(2);
  });

  it('跨标签页：别处已写成主线后，这里点「提取为世界观设定」进入提取步骤，任务仍是主线', async () => {
    stubLlm({});
    const { user } = await reachDestination();
    await harness.repository.commitImportChapters(novel.id, {
      target: { kind: 'main' },
      withStyle: false,
    });

    await chooseDestination(user, 'worldview');
    await user.click(screen.getByRole('button', { name: '提取为世界观设定' }));

    expect(await screen.findByText(/已提取 0 \/ 2 章/u)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const job = await currentJob();
    expect(job?.destination).toEqual({ kind: 'main' });
    expect(job?.worldviewChunks).toEqual([]);
    expect(await harness.repository.listChapters(novel.id)).toHaveLength(2);
  });

  it('纯中文稿在分章页提交失败：落到目的地步骤，改选后重试成功', async () => {
    stubLlm({});
    const { user } = await pasteManuscript();
    // picker 读到的外传列表是旧的：同名外传是在面板打开之后才建的
    await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    await confirmSplit(user, { newSide: '青冥旧事' });

    expect(await screen.findByText('已有同名外传『青冥旧事』')).toBeInTheDocument();
    expect(stepBar().getByText('导入到')).toHaveAttribute('aria-current', 'step');
    // 重新加载之后，picker 也能当场看出重名
    expect(await screen.findByText('已有同名外传，直接从上面选它')).toBeInTheDocument();
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);

    await chooseDestination(user, { newSide: '雪夜番外' });
    await user.click(screen.getByRole('button', { name: '写入外传 3 章' }));

    await screen.findByText(/提取完成/u);
    const stories = await harness.repository.listSideStories(novel.id);
    const snow = stories.find((story) => story.title === '雪夜番外')!;
    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters.map((chapter) => [chapter.sideStoryId, chapter.index])).toEqual([
      [snow.id, 1],
      [snow.id, 2],
      [snow.id, 3],
    ]);
  });
});

describe('恢复与旧任务兼容', () => {
  const legacyState = (chapterId: string, translateStatus = 'none') => ({
    index: 1,
    title: '一',
    chapterId,
    status: 'pending',
    error: '',
    translateStatus,
    translateError: '',
  });

  const legacyCommon = {
    batchId: 'b-legacy',
    entryDrafts: [],
    openThreads: [],
    rollingSummary: '',
    withSummaries: true,
    withStyle: false,
    status: 'paused',
    createdAt: 0,
    updatedAt: 0,
  };

  it('不合阶段表的任务（destination 为 null 而 chapters 非空）被清掉，章节保留', async () => {
    const chapter = await harness.repository.createChapter(novel.id, {
      title: '一',
      content: '正文。',
    });
    await putRawJob({
      ...legacyCommon,
      destination: null,
      drafts: [],
      worldviewChunks: [],
      chapters: [legacyState(chapter.id)],
    });
    renderImport();

    expect(await screen.findByLabelText('旧稿正文')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      '上一次导入的进度无法恢复，已清掉；已写入的章节正文都在写作页里',
    );
    expect(await currentJob()).toBeUndefined();
    expect(await harness.repository.listChapters(novel.id)).toHaveLength(1);
  });

  it.each([
    ['章节', { importType: 'chapter', chapters: [] as unknown[] }, /已提取 0 \/ 1 章/u],
    [
      '世界观',
      {
        importType: 'worldview',
        worldviewText: '归墟在极北。',
        worldviewChunks: [{ index: 1, content: '归墟在极北。', status: 'pending', error: '' }],
      },
      /已提取 0 \/ 1 段/u,
    ],
  ])('没有 drafts 键的原始旧%s行不白屏，「放弃这次导入」可用', async (_name, row, progress) => {
    const chapter = await harness.repository.createChapter(novel.id, {
      title: '一',
      content: '正文。',
    });
    const shaped =
      row.importType === 'chapter' ? { ...row, chapters: [legacyState(chapter.id)] } : row;
    await putRawJob({ ...legacyCommon, ...shaped });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderImport(onClose);

    expect(await screen.findByText(progress)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '放弃这次导入' }));
    await user.click(await screen.findByRole('button', { name: '放弃进度' }));

    await waitFor(async () => expect(await currentJob()).toBeUndefined());
    expect(onClose).toHaveBeenCalled();
    expect(await harness.repository.listChapters(novel.id)).toHaveLength(1);
  });

  it('parse 不过的行（destination 不认识）回到粘贴步骤并说明', async () => {
    await putRawJob({ destination: { kind: 'bogus' }, drafts: 'oops' });
    renderImport();

    expect(await screen.findByLabelText('旧稿正文')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('上一次导入的进度无法恢复');
    expect(await currentJob()).toBeUndefined();
  });

  it('旧版世界观任务能接着提取，段标签与原来一致', async () => {
    const spy = stubLlm({});
    await putRawJob({
      ...legacyCommon,
      importType: 'worldview',
      worldviewText: '归墟在极北。',
      worldviewChunks: [{ index: 1, content: '归墟在极北。', status: 'pending', error: '' }],
      chapters: [],
    });
    const user = userEvent.setup();
    renderImport();

    await user.click(await screen.findByRole('button', { name: '开始提取' }));
    await screen.findByText(/提取完成/u);
    expect(userMessageOf(extractBodies(spy)[0])).toContain('【设定文本（世界观设定）】');
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
  });

  it('旧版章节任务还有没译完的章节：落在提取步骤并说明，不自动开始', async () => {
    const spy = stubLlm({});
    const chapter = await harness.repository.createChapter(novel.id, {
      title: '一',
      content: 'He left before dawn.',
    });
    await putRawJob({
      ...legacyCommon,
      importType: 'chapter',
      worldviewText: '',
      chapters: [legacyState(chapter.id, 'pending')],
    });
    renderImport();

    expect(
      await screen.findByText(
        '这次导入是旧版本留下的，翻译进度无法接着跑。已写入的 1 章都在，未译的 1 章会按原文提取；想先翻译的话，可以到写作页逐章『译成中文』后再开始提取，或放弃这次导入（章节会保留）。',
      ),
    ).toHaveAttribute('role', 'note');
    expect(screen.getByRole('button', { name: '开始提取' })).toBeEnabled();
    await settle();
    expect(spy).not.toHaveBeenCalled();
  });

  it('旧版空任务被静默清掉，进入粘贴步骤', async () => {
    await putRawJob({ ...legacyCommon, importType: 'chapter', chapters: [] });
    renderImport();

    expect(await screen.findByLabelText('旧稿正文')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await waitFor(async () => expect(await currentJob()).toBeUndefined());
  });
});

describe('世界观目的地', () => {
  it('外文稿译完选世界观：提取 prompt 是中文译文，全程不写章节，只出条目提案，译名进表', async () => {
    const spy = stubLlm({
      translate: (_call, body) =>
        translationReply(userMessageOf(body).includes('Greymoor') ? T2 : T1),
    });
    const { user } = await reachTranslate(ENGLISH);
    await user.click(screen.getByRole('button', { name: '开始翻译（2 章）' }));
    await screen.findByText(/已翻译 2 \/ 2 章/u);
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);

    await user.click(await screen.findByRole('button', { name: '下一步：选择导入方式' }));
    await screen.findByRole('radio', { name: /^仅作为世界观设定/u });
    await confirmSplit(user, 'worldview');
    await screen.findByText(/提取完成/u);

    const prompts = extractBodies(spy).map(userMessageOf);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('阿什福德在黎明前背起了行囊');
    expect(prompts[0]).toContain('灰沼渡口的雨下了三天');
    expect(prompts[0]).not.toContain('Ashford shouldered');
    expect(prompts[0]).toContain('【设定文本（世界观设定 · Chapter 1 — Chapter 2）】');

    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
    const proposals = await harness.repository.listProposals(novel.id);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((item) => item.target === 'knowledgeEntry')).toBe(true);
    expect((await harness.repository.getGlossary(novel.id))?.terms).toEqual([
      { source: 'Ashford', target: '阿什福德' },
      { source: 'Greymoor', target: '灰沼' },
    ]);
  });

  it('三个短章打包成一次提取请求，段标签带首末章标题', async () => {
    const spy = stubLlm({});
    const { user } = await pasteManuscript();
    await confirmSplit(user, 'worldview');
    await screen.findByText(/提取完成/u);

    const prompts = extractBodies(spy).map(userMessageOf);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('【设定文本（世界观设定 · 第一章 离乡 — 第三章 灵潮）】');
    expect(prompts[0]).toContain('渡口的雨下了三天');
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
  });

  it('超长的一章按段落切成多次请求，段标签带章节标题与（i/k）', async () => {
    const spy = stubLlm({});
    const body = Array.from(
      { length: 40 },
      (_, i) => `宗门第${i}条：${'山门规矩森严，弟子不得私下山。'.repeat(12)}`,
    ).join('\n\n');
    const { user } = await pasteManuscript(`第一章 宗门\n${body}`);
    await confirmSplit(user, 'worldview');
    await screen.findByText(/提取完成/u);

    const prompts = extractBodies(spy).map(userMessageOf);
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[0]).toMatch(/【设定文本（世界观设定 · 第一章 宗门（1\/\d+））】/u);
    expect(prompts[1]).toMatch(/【设定文本（世界观设定 · 第一章 宗门（2\/\d+））】/u);
  });

  it('段标签三种情况：有标题、无标题多段、无标题单段', async () => {
    const spy = stubLlm({});
    // 无标题单段
    let pasted = await pasteManuscript('灵潮：每逢子夜，天地灵气如潮水般涨落。');
    await confirmSplit(pasted.user, 'worldview');
    await screen.findByText(/提取完成/u);
    expect(userMessageOf(extractBodies(spy)[0])).toContain('【设定文本（世界观设定）】');

    // 无标题多段
    pasted.view.unmount();
    const long = Array.from({ length: 80 }, (_, i) => `设定${i}：${'灵潮涨落'.repeat(20)}`).join(
      '\n\n',
    );
    pasted = await pasteManuscript(long);
    await confirmSplit(pasted.user, 'worldview');
    await screen.findByText(/提取完成/u);
    expect(userMessageOf(extractBodies(spy)[1])).toMatch(
      /【设定文本（世界观设定 第 1\/\d+ 段）】/u,
    );

    // 有标题
    pasted.view.unmount();
    const before = extractBodies(spy).length;
    pasted = await pasteManuscript('第一章 地理\n归墟在极北。');
    await confirmSplit(pasted.user, 'worldview');
    await screen.findByText(/提取完成/u);
    expect(userMessageOf(extractBodies(spy)[before])).toContain(
      '【设定文本（世界观设定 · 第一章 地理）】',
    );
  });
});

describe('外传目的地', () => {
  async function sideStoryNamed(title: string) {
    const stories = await harness.repository.listSideStories(novel.id);
    return stories.find((story) => story.title === title)!;
  }

  it('新建外传后直接开始提取：章节归入外传、从第 1 章编号，第一章的 prompt 已有外传说明', async () => {
    const first = deferred();
    const spy = stubLlm({ extract: (call) => (call === 1 ? first.promise : extractionReply()) });
    const { user } = await pasteManuscript();
    await confirmSplit(user, { newSide: '青冥旧事' });

    // 循环不读过期的 sideStories state：刚建出来的外传在第一章就用上了
    expect(await screen.findByText('正在提取外传·青冥旧事 第 1 章…')).toBeInTheDocument();
    await waitFor(() => expect(extractBodies(spy)).toHaveLength(1));
    const prompt = userMessageOf(extractBodies(spy)[0]);
    // 简介为空：没有空括号
    expect(prompt).toContain('本批正文是外传《青冥旧事》，独立于主线。');
    expect(prompt).not.toContain('（简介');

    const story = await sideStoryNamed('青冥旧事');
    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters.map((chapter) => [chapter.sideStoryId, chapter.index])).toEqual([
      [story.id, 1],
      [story.id, 2],
      [story.id, 3],
    ]);
    expect(screen.getAllByText(/^外传·青冥旧事 第 \d 章$/u)).toHaveLength(3);

    first.release(extractionReply());
    await screen.findByText(/提取完成/u);
  });

  it('提取途中改了外传简介，下一章的 prompt 用新简介', async () => {
    const story = await harness.repository.createSideStory(novel.id, {
      title: '青冥旧事',
      synopsis: '旧简介',
    });
    const first = deferred();
    const spy = stubLlm({ extract: (call) => (call === 1 ? first.promise : extractionReply()) });
    const { user } = await pasteManuscript();
    await confirmSplit(user, { side: story.id });
    await waitFor(() => expect(extractBodies(spy)).toHaveLength(1));

    await harness.repository.updateSideStory(story.id, { synopsis: '新简介' });
    first.release(extractionReply());
    await screen.findByText(/提取完成/u);

    const prompts = extractBodies(spy).map(userMessageOf);
    expect(prompts[0]).toContain('本批正文是外传《青冥旧事》（简介：旧简介）');
    expect(prompts[1]).toContain('本批正文是外传《青冥旧事》（简介：新简介）');
  });

  it('提取途中删掉外传：下一章标为失败、不发请求，循环停下并说明原因', async () => {
    const first = deferred();
    const spy = stubLlm({ extract: (call) => (call === 1 ? first.promise : extractionReply()) });
    const { user } = await pasteManuscript();
    await confirmSplit(user, { newSide: '青冥旧事' });
    await waitFor(() => expect(extractBodies(spy)).toHaveLength(1));

    await harness.repository.deleteSideStory((await sideStoryNamed('青冥旧事')).id);
    first.release(extractionReply());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /第 2 章提取失败：(章节已不存在|这部外传已不存在)/u,
    );
    const job = await currentJob();
    // 后面的章节没有被逐个标成失败
    expect(job?.chapters.map((item) => item.status)).toEqual(['done', 'failed', 'pending']);
    expect(extractBodies(spy)).toHaveLength(1);
  });

  it('外传读不到但章节还在：只有当前这一章失败，循环停下', async () => {
    const spy = stubLlm({});
    const { user } = await pasteManuscript();
    vi.spyOn(harness.repository, 'getSideStory').mockResolvedValue(undefined);
    await confirmSplit(user, { newSide: '青冥旧事' });

    expect(
      await screen.findByText('外传·青冥旧事 第 1 章提取失败：这部外传已不存在，可能已被删除'),
    ).toBeInTheDocument();
    const job = await currentJob();
    expect(job?.chapters.map((item) => item.status)).toEqual(['failed', 'pending', 'pending']);
    expect(job?.chapters[0]?.error).toBe('这部外传已不存在，可能已被删除');
    expect(spy).not.toHaveBeenCalled();
  });

  it('恢复到外传任务后接着提取，prompt 里仍有外传说明', async () => {
    stubLlm({ extract: () => jsonResponse({ error: { message: '余额不足' } }, 402) });
    const { user, view } = await pasteManuscript();
    await confirmSplit(user, { newSide: '青冥旧事' });
    await screen.findByText(/外传·青冥旧事 第 1 章提取失败/u);

    view.unmount();
    vi.unstubAllGlobals();
    const spy = stubLlm({});
    const again = userEvent.setup();
    renderImport();

    expect(await screen.findByText('外传·青冥旧事 第 1 章')).toBeInTheDocument();
    await again.click(screen.getByRole('button', { name: '开始提取' }));
    await screen.findByRole('button', { name: '跳过失败章节，直接整理提案' });

    expect(userMessageOf(extractBodies(spy)[0])).toContain('本批正文是外传《青冥旧事》');
  });

  it('收尾只出外传进展提案，不出全书进展；摘要与条目的来源带「外传·」；采用后作品进展不变', async () => {
    stubLlm({});
    const { user } = await pasteManuscript();
    await confirmSplit(user, { newSide: '青冥旧事' });
    await screen.findByText(/提取完成/u);

    const proposals = await harness.repository.listProposals(novel.id, { status: 'pending' });
    const byLabel = new Map(proposals.map((item) => [item.label, item]));
    expect(proposals.some((item) => item.target === 'novel')).toBe(false);
    expect(byLabel.get('外传·青冥旧事 第 1 章摘要')).toMatchObject({
      target: 'chapterSummary',
      sourceRef: '外传·青冥旧事 第 1 章',
    });
    expect(byLabel.get('人物 · 沈砚')?.sourceRef).toBe('外传·青冥旧事 第 1、2、3 章');
    const progress = proposals.filter((item) => item.target === 'sideStory');
    expect(progress).toHaveLength(1);
    expect(progress[0]?.label).toBe('外传进展摘要');
    // 外传默认不归纳文风
    expect(proposals.some((item) => item.target === 'styleProfile')).toBe(false);

    await user.click(await screen.findByRole('button', { name: /全部写入知识库/u }));
    const story = await sideStoryNamed('青冥旧事');
    await waitFor(async () => {
      expect((await harness.repository.getSideStory(story.id))?.rollingSummary).toBe(
        '沈砚在灵潮之夜明白玉佩的来历。',
      );
    });
    expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe(
      novel.rollingSummary,
    );
  });

  it('文风勾选框：外传默认不勾，主线默认勾上；手动改过之后切换目的地不再覆盖', async () => {
    const { user } = await pasteManuscript();
    const styleBox = () => screen.getByRole('checkbox', { name: /顺便归纳这部作品的文风/u });

    expect(styleBox()).toBeChecked();
    await chooseDestination(user, { newSide: '青冥旧事' });
    expect(styleBox()).not.toBeChecked();
    await chooseDestination(user, 'main');
    expect(styleBox()).toBeChecked();

    await user.click(styleBox());
    expect(styleBox()).not.toBeChecked();
    await chooseDestination(user, { newSide: '青冥旧事' });
    await user.click(styleBox());
    await chooseDestination(user, 'main');
    // 用户最后一次手动勾上了，切回主线也保持勾上
    expect(styleBox()).toBeChecked();
    await chooseDestination(user, { newSide: '青冥旧事' });
    expect(styleBox()).toBeChecked();
  });

  it('已有外传的第二批从 k+1 接着编号，主线编号不受影响', async () => {
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    await harness.repository.createChapter(novel.id, { title: '主线一', content: '正文。' });
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, title: '外一' });
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, title: '外二' });
    stubLlm({});
    const { user } = await pasteManuscript();
    await chooseDestination(user, { side: story.id });

    expect(screen.getByText('外传·青冥旧事 已有 2 章，从第 3 章接着编号。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '写入外传 3 章' }));
    await screen.findByText(/提取完成/u);

    const chapters = await harness.repository.listChapters(novel.id);
    const side = chapters.filter((chapter) => chapter.sideStoryId === story.id);
    expect(side.map((chapter) => chapter.index).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(chapters.filter((chapter) => chapter.sideStoryId === null).map((c) => c.index)).toEqual([
      1,
    ]);
  });

  it('新建外传时的编号提示', async () => {
    const { user } = await pasteManuscript();
    await chooseDestination(user, { newSide: '青冥旧事' });
    expect(screen.getByText('从第 1 章开始编号。')).toBeInTheDocument();
  });

  it('连着导下一批：外传版本的提示，picker 预选上一批新建的那部外传', async () => {
    stubLlm({});
    const { user } = await pasteManuscript();
    await confirmSplit(user, { newSide: '青冥旧事' });
    await screen.findByText(/提取完成/u);
    const story = await sideStoryNamed('青冥旧事');

    await user.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));
    expect(
      await screen.findByText(
        '上一批 3 章外传·青冥旧事 已经处理完。接着导下一批吧 —— 译名表和已有设定都会沿用。',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText('旧稿正文'));
    await user.paste(SECOND);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));

    expect(await screen.findByRole('radio', { name: /^外传/u })).toBeChecked();
    expect(screen.getByLabelText('哪一部外传')).toHaveValue(story.id);
    expect(
      await screen.findByText('外传·青冥旧事 已有 3 章，从第 4 章接着编号。'),
    ).toBeInTheDocument();
  });

  it('连着导下一批：那部外传在此期间被删了，预选回退到「新建」', async () => {
    stubLlm({});
    const { user } = await pasteManuscript();
    await confirmSplit(user, { newSide: '青冥旧事' });
    await screen.findByText(/提取完成/u);
    await harness.repository.deleteSideStory((await sideStoryNamed('青冥旧事')).id);

    await user.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));
    await user.click(await screen.findByLabelText('旧稿正文'));
    await user.paste(SECOND);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));

    await waitFor(() => expect(screen.getByLabelText('哪一部外传')).toHaveValue('__new__'));
    expect(screen.getByLabelText(/外传名称/u)).toHaveValue('');
  });
});

describe('picker 校验', () => {
  it('新建外传：名称为空、重名、超过 40 字都会禁用主按钮', async () => {
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    const { user } = await pasteManuscript();
    await chooseDestination(user, { side: story.id });
    const commit = () => screen.getByRole('button', { name: '写入外传 3 章' });
    expect(commit()).toBeEnabled();
    expect(screen.getByText('外传·青冥旧事 已有 0 章，从第 1 章接着编号。')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('哪一部外传'), '__new__');
    expect(screen.getByLabelText(/外传名称/u)).toHaveValue('');
    expect(commit()).toBeDisabled();

    // 只差「外传·」前缀也算重名
    await chooseDestination(user, { newSide: '外传·青冥旧事' });
    expect(screen.getByText('已有同名外传，直接从上面选它')).toBeInTheDocument();
    expect(commit()).toBeDisabled();

    await chooseDestination(user, { newSide: '长'.repeat(41) });
    expect(screen.getByText('外传名称不能超过 40 字')).toBeInTheDocument();
    expect(commit()).toBeDisabled();

    await chooseDestination(user, { newSide: '雪夜番外' });
    expect(screen.queryByRole('alert', { name: /同名|40 字/u })).not.toBeInTheDocument();
    expect(commit()).toBeEnabled();
  });

  it('没有配置模型时，世界观的主按钮禁用并说明', async () => {
    useLlmSettings.getState().update({ apiKey: '' });
    const { user } = await pasteManuscript();
    await chooseDestination(user, 'worldview');

    expect(screen.getByRole('button', { name: '提取为世界观设定' })).toBeDisabled();
    expect(screen.getByText('需要先在『设置』里配置模型才能提取')).toBeInTheDocument();
    // 主线照常可以写入，提取步骤再提示配置模型
    await chooseDestination(user, 'main');
    expect(screen.getByRole('button', { name: '写入主线 3 章' })).toBeEnabled();
  });
});

describe('放弃与连着导下一批的计数', () => {
  it('在翻译步骤放弃：确认框说明译文会被清空、还没写入章节，任务被删除', async () => {
    stubLlm({ translate: () => translationReply(T1) });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderImport(onClose);
    await user.click(await screen.findByLabelText('旧稿正文'));
    await user.paste(MIXED);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
    await user.click(await screen.findByRole('button', { name: '下一步：翻译（2 章）' }));
    await user.click(await screen.findByLabelText('翻译第 2 章'));
    // 按钮文案要等勾选写入 IndexedDB 之后才更新
    await user.click(await screen.findByRole('button', { name: '开始翻译（1 章）' }));
    await screen.findByText(/已翻译 1 \/ 1 章/u);

    await user.click(screen.getByRole('button', { name: '放弃这次导入' }));
    expect(
      await screen.findByText(
        '分章结果和已经译好的 1 章译文会被清空，需要重新粘贴；译名表保存在作品上，不受影响。还没有写入任何章节。',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '放弃进度' }));

    await waitFor(async () => expect(await currentJob()).toBeUndefined());
    expect(onClose).toHaveBeenCalled();
    // 译名表挂在作品上，不受影响
    expect((await harness.repository.getGlossary(novel.id))?.terms).toEqual([
      { source: 'Ashford', target: '阿什福德' },
    ]);
  });

  it('还没译任何一章时放弃，确认框省掉译文那半句', async () => {
    stubLlm({});
    const { user } = await reachTranslate();
    await user.click(screen.getByRole('button', { name: '放弃这次导入' }));
    expect(
      await screen.findByText(
        '分章结果会被清空，需要重新粘贴；译名表保存在作品上，不受影响。还没有写入任何章节。',
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ['主线', 'main' as const, '上一批 3 章已经处理完'],
    ['外传', { newSide: '青冥旧事' }, '上一批 3 章外传·青冥旧事 已经处理完'],
  ])(
    '%s：提取途中卸载重开（本地分章结果已丢）后跑完，提示里仍是「上一批 3 章」',
    async (_name, destination, expected) => {
      stubLlm({ extract: () => jsonResponse({ error: { message: '余额不足' } }, 402) });
      const { user, view } = await pasteManuscript();
      await confirmSplit(user, destination);
      await screen.findByText(/第 1 章提取失败/u);

      view.unmount();
      vi.unstubAllGlobals();
      stubLlm({});
      const again = userEvent.setup();
      renderImport();
      await again.click(await screen.findByRole('button', { name: '重试' }));
      await screen.findByText(/提取完成/u);

      await again.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));
      expect(await screen.findByText(new RegExp(expected, 'u'))).toBeInTheDocument();
    },
  );
});
