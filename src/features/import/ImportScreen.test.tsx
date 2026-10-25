import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category, Novel } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { countWords } from '@/domain/primitives';
import { completion, jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { GLOSSARY_DELIMITER } from '../writing/translate';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
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
});

function characterCategory(): Category {
  return categories.find((item) => item.kind === 'character')!;
}

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

/** 每章的提取结果，按调用次序依次返回 */
const EXTRACTIONS: unknown[] = [
  {
    entries: [
      {
        categoryName: '人物',
        title: '沈砚',
        aliases: [],
        summary: '离乡寻母的少年',
        fields: [
          { key: 'identity', value: '十七岁，渔村出身' },
          { key: 'goal', value: '寻找失踪的母亲' },
        ],
      },
    ],
    summary: '沈砚在雾夜离开渔村。',
    keyEvents: ['沈砚离乡', '玉佩被带走'],
    appearingEntries: ['沈砚'],
    newOpenThreads: ['玉佩的来历'],
    resolvedThreads: [],
    rollingSummary: '沈砚离乡北上。',
  },
  {
    entries: [
      {
        categoryName: '人物',
        title: '沈砚',
        aliases: [],
        summary: '离乡寻母的少年',
        fields: [
          { key: 'identity', value: '十七岁，渔村出身' },
          { key: 'goal', value: '寻找失踪的母亲' },
          { key: 'flaw', value: '怕水' },
        ],
      },
      {
        categoryName: '人物',
        title: '裴照',
        aliases: ['船家'],
        summary: '摆渡的旧识',
        fields: [{ key: 'identity', value: '渡口船夫' }],
      },
    ],
    summary: '沈砚在渡口遇见裴照。',
    keyEvents: ['裴照提到归墟'],
    appearingEntries: ['沈砚'],
    newOpenThreads: [],
    resolvedThreads: [],
    rollingSummary: '沈砚在渡口得知归墟所在。',
  },
  {
    entries: [
      {
        categoryName: '世界观设定',
        title: '灵潮',
        aliases: [],
        summary: '子夜翻涌的灵气潮汐',
        fields: [{ key: 'definition', value: '子夜涨落的灵气潮汐' }],
      },
    ],
    summary: '灵潮翻涌，玉佩显出异状。',
    keyEvents: ['灵潮暴涨', '玉佩发烫'],
    appearingEntries: ['沈砚'],
    newOpenThreads: [],
    resolvedThreads: ['玉佩的来历'],
    rollingSummary: '沈砚在灵潮之夜明白玉佩的来历。',
  },
];

/** 按调用次序返回不同响应；用尽后重复最后一个 */
function stubSequence(results: unknown[]) {
  let call = 0;
  // 显式声明参数，后面要从 mock.calls 里读请求体
  const spy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => {
    const body = results[Math.min(call, results.length - 1)];
    call += 1;
    return Promise.resolve(jsonResponse(completion(JSON.stringify(body))));
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** 从第 n 次请求里取出发给模型的消息 */
function messagesOfCall(
  spy: ReturnType<typeof stubSequence>,
  index: number,
): { role: string; content: string }[] {
  const init = spy.mock.calls[index]?.[1];
  const parsed = JSON.parse(String(init?.body ?? '{}')) as {
    messages?: { role: string; content: string }[];
  };
  return parsed.messages ?? [];
}

function renderImport(onClose = () => {}) {
  return harness.renderUI(<ImportScreen novel={novel} categories={categories} onClose={onClose} />);
}

/** 粘贴稿件并走到分章预览 */
async function pasteManuscript(text = MANUSCRIPT) {
  const user = userEvent.setup();
  const view = renderImport();
  const textarea = await screen.findByLabelText('旧稿正文');
  await user.click(textarea);
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
  return { user, view };
}

type Destination = 'main' | 'worldview' | { side: string } | { newSide: string };

/** 在 picker 里选目的地（分章页或目的地步骤），不点主按钮 */
async function chooseDestination(
  user: ReturnType<typeof userEvent.setup>,
  destination: Destination,
) {
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
  await user.type(name, destination.newSide);
}

/** 选目的地并点主按钮：「写入主线 N 章」/「写入外传 N 章」/「提取为世界观设定」 */
async function confirmSplit(
  user: ReturnType<typeof userEvent.setup>,
  destination: Destination = 'main',
) {
  if (destination !== 'main') await chooseDestination(user, destination);
  const name =
    destination === 'main'
      ? /^写入主线 \d+ 章$/u
      : destination === 'worldview'
        ? /^提取为世界观设定$/u
        : /^写入外传 \d+ 章$/u;
  await user.click(screen.getByRole('button', { name }));
}

describe('粘贴与分章', () => {
  it('未粘贴内容时不能进入下一步', async () => {
    renderImport();
    expect(await screen.findByRole('button', { name: '下一步：切分章节' })).toBeDisabled();
  });

  it('自动识别出三章并显示统计', async () => {
    await pasteManuscript();
    expect(await screen.findByText(/切出 3 章/u)).toBeInTheDocument();
    expect(screen.getByLabelText('第 1 章标题')).toHaveValue('第一章 离乡');
    expect(screen.getByLabelText('第 3 章标题')).toHaveValue('第三章 灵潮');
  });

  it('可以并入上一章，序号随之重排', async () => {
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);

    const second = screen.getByLabelText('第 2 章标题').closest('li')!;
    await user.click(within(second).getByRole('button', { name: '并入上一章' }));

    expect(await screen.findByText(/切出 2 章/u)).toBeInTheDocument();
    expect(screen.getByLabelText('第 2 章标题')).toHaveValue('第三章 灵潮');
  });

  it('可以删除杂项章节', async () => {
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);

    const first = screen.getByLabelText('第 1 章标题').closest('li')!;
    await user.click(within(first).getByRole('button', { name: '删除' }));

    expect(await screen.findByText(/切出 2 章/u)).toBeInTheDocument();
    expect(screen.getByLabelText('第 1 章标题')).toHaveValue('第二章 渡口');
  });

  it('第一章不能并入上一章', async () => {
    await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    const first = screen.getByLabelText('第 1 章标题').closest('li')!;
    expect(within(first).getByRole('button', { name: '并入上一章' })).toBeDisabled();
  });

  it('切出大量极短章节时给出提示', async () => {
    await pasteManuscript(['第一章 甲', '一。', '第二章 乙', '二。'].join('\n'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/明显偏短/u);
  });

  it('整篇作为一章', async () => {
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await user.click(screen.getByRole('radio', { name: /整篇作为一章/u }));
    expect(await screen.findByText(/切出 1 章/u)).toBeInTheDocument();
  });

  it('自定义正则非法时给出错误并禁用切分按钮', async () => {
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await user.click(screen.getByRole('radio', { name: /自定义正则/u }));
    await user.type(screen.getByLabelText('标题正则'), '(((');

    expect(await screen.findByText('这个正则无法使用，请检查写法')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /按此规则切分/u })).toBeDisabled();
  });
});

describe('写入章节', () => {
  it('确认后章节落库，标记为已完成的导入稿', async () => {
    stubSequence(EXTRACTIONS);
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters).toHaveLength(3);
      expect(chapters.every((chapter) => chapter.source === 'imported')).toBe(true);
      expect(chapters.every((chapter) => chapter.status === 'done')).toBe(true);
      expect(chapters[0]?.content).toContain('渔村的雾压得很低');
    });
    // 等提取循环收尾，否则用例结束关库时它还在往库里写
    await screen.findByText(/提取完成/u);
  });

  it('接在已有章节之后编号，不覆盖已写的内容', async () => {
    stubSequence(EXTRACTIONS);
    await harness.repository.createChapter(novel.id, { title: '已有的一章', content: '旧内容' });

    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters.map((chapter) => chapter.index)).toEqual([1, 2, 3, 4]);
      expect(chapters[0]?.title).toBe('已有的一章');
      expect(chapters[1]?.title).toBe('第一章 离乡');
    });
    await screen.findByText(/提取完成/u);
  });
});

describe('逐章提取到确认', () => {
  async function runFullImport() {
    const spy = stubSequence(EXTRACTIONS);
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);
    return { user, spy };
  }

  it('三章跑完后进入确认步骤，提案里混有新建与合并', async () => {
    // 库里已有「沈砚」，第一、二章的提取应当合并到它身上而不是新建
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory().id,
      title: '沈砚',
      summary: '主角',
      fields: { identity: '少年' },
    });

    await runFullImport();

    // 三章摘要 + 沈砚（合并）+ 裴照（新建）+ 灵潮（新建）+ 全书进展
    const proposals = await waitFor(async () => {
      const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
      expect(pending).toHaveLength(7);
      return pending;
    });

    const byLabel = new Map(proposals.map((item) => [item.label, item]));
    expect(byLabel.get('人物 · 沈砚')?.action).toBe('merge');
    expect(byLabel.get('人物 · 裴照')?.action).toBe('create');
    expect(byLabel.get('世界观设定 · 灵潮')?.action).toBe('create');
    expect(byLabel.get('第 1 章摘要')?.target).toBe('chapterSummary');
    expect(byLabel.get('全书进展摘要')?.action).toBe('replace');
    // 全部归入同一批次，才能在一个收件箱里一次确认
    expect(new Set(proposals.map((item) => item.batchId)).size).toBe(1);

    expect(await screen.findByText(/提取完成/u)).toBeInTheDocument();
  });

  it('合并提案带字段级 diff 与溯源章节', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory().id,
      title: '沈砚',
      summary: '主角',
      fields: { identity: '少年' },
    });

    await runFullImport();

    const merge = await waitFor(async () => {
      const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
      const found = pending.find((item) => item.label === '人物 · 沈砚');
      expect(found).toBeDefined();
      return found!;
    });

    const diffByField = new Map(merge.diff.map((item) => [item.field, item]));
    // 原有的「少年」被整合后的完整值替换，并标为改动交用户裁决
    expect(diffByField.get('fields.identity')).toMatchObject({
      before: '少年',
      after: '十七岁，渔村出身',
      kind: 'changed',
    });
    // 本章新读到的字段算新增
    expect(diffByField.get('fields.flaw')).toMatchObject({ after: '怕水', kind: 'added' });
    // 出现在第一、二章
    expect(merge.sourceRef).toBe('第 1、2 章');
  });

  it('确认后知识库补全，条目带上溯源章节', async () => {
    const { user } = await runFullImport();

    await screen.findByText(/提取完成/u);
    const acceptAll = await screen.findByRole('button', { name: /全部写入知识库/u });
    await user.click(acceptAll);

    await waitFor(async () => {
      const entries = await harness.repository.listEntries(novel.id);
      expect(entries.map((entry) => entry.title).sort()).toEqual(['沈砚', '灵潮', '裴照'].sort());
      const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
      expect(pending).toHaveLength(0);
    });

    const entries = await harness.repository.listEntries(novel.id);
    const shen = entries.find((entry) => entry.title === '沈砚')!;
    expect(shen.fields.flaw).toBe('怕水');
    expect(shen.sourceChapterIds).toHaveLength(2);

    // 摘要链同时补齐，第四章才能拿到前三章的上下文
    const summaries = await harness.repository.listSummaries(novel.id);
    expect(summaries).toHaveLength(3);
    const chapters = await harness.repository.listChapters(novel.id);
    const third = summaries.find((item) => item.chapterId === chapters[2]!.id)!;
    // 第三章收束了第一章埋下的伏笔，累计清单应当已经清空
    expect(third.openThreads).toEqual([]);
    const first = summaries.find((item) => item.chapterId === chapters[0]!.id)!;
    expect(first.openThreads).toEqual(['玉佩的来历']);

    // 全书进展摘要也落到作品上
    expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe(
      '沈砚在灵潮之夜明白玉佩的来历。',
    );
  });

  it('提取时把已有条目的完整字段交给模型，要求整合回填', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory().id,
      title: '沈砚',
      summary: '主角',
      fields: { identity: '少年' },
    });

    const { spy } = await runFullImport();
    await screen.findByText(/提取完成/u);

    const messages = messagesOfCall(spy, 0);
    const system = messages.find((message) => message.role === 'system')!.content;
    const userMessage = messages.find((message) => message.role === 'user')!.content;

    expect(system).toContain('整合后的完整字段');
    expect(userMessage).toContain('名称：沈砚（分类「人物」）');
    expect(userMessage).toContain('identity：少年');
    expect(userMessage).toContain('沈砚背起行囊时天还没亮');
  });

  it('后续章节带上累计的伏笔与全书进展', async () => {
    const { spy } = await runFullImport();
    await screen.findByText(/提取完成/u);

    const userMessage = messagesOfCall(spy, 2).find((message) => message.role === 'user')!.content;

    expect(userMessage).toContain('【当前未收束的伏笔】');
    expect(userMessage).toContain('玉佩的来历');
    expect(userMessage).toContain('沈砚在渡口得知归墟所在。');
  });
});

describe('中断与恢复', () => {
  it('某章失败时停下来，不把错误重复几十遍', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        if (call === 1) {
          return Promise.resolve(jsonResponse(completion(JSON.stringify(EXTRACTIONS[0]))));
        }
        return Promise.resolve(jsonResponse({ error: { message: '余额不足' } }, 402));
      }),
    );

    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);

    expect(await screen.findByText(/第 2 章提取失败/u)).toBeInTheDocument();
    expect(await screen.findByText(/已提取 1 \/ 3 章/u)).toBeInTheDocument();
    // 第三章不该被连带跑掉
    expect(await screen.findByRole('button', { name: '继续提取' })).toBeInTheDocument();

    const job = await harness.repository.getImportJob(novel.id);
    expect(job?.chapters.map((item) => item.status)).toEqual(['done', 'failed', 'pending']);
    expect(job?.chapters[1]?.error).toContain('余额不足');
  });

  it('重新打开面板时接着未完成的任务跑，而不是从头粘贴', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        if (call === 1) {
          return Promise.resolve(jsonResponse(completion(JSON.stringify(EXTRACTIONS[0]))));
        }
        return Promise.resolve(jsonResponse({ error: { message: '余额不足' } }, 402));
      }),
    );

    const { user, view } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);
    await screen.findByText(/第 2 章提取失败/u);

    // 关掉面板再打开
    view.unmount();
    renderImport();

    // 直接落在提取步骤上，不再要求重新粘贴
    expect(await screen.findByText(/已提取 1 \/ 3 章/u)).toBeInTheDocument();
    expect(screen.queryByLabelText('旧稿正文')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '继续提取' })).toBeInTheDocument();
  });

  it('放弃导入会清掉进度但保留已写入的章节', async () => {
    stubSequence([{ error: { message: 'x' } }]);
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderImport(onClose);

    const textarea = await screen.findByLabelText('旧稿正文');
    await user.click(textarea);
    await user.paste(MANUSCRIPT);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);

    await screen.findByText(/已提取 0 \/ 3 章/u);
    await user.click(screen.getByRole('button', { name: '放弃这次导入' }));
    await user.click(await screen.findByRole('button', { name: '放弃进度' }));

    await waitFor(async () => {
      expect(await harness.repository.getImportJob(novel.id)).toBeUndefined();
    });
    expect(await harness.repository.listChapters(novel.id)).toHaveLength(3);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('未配置模型', () => {
  it('提示先去设置，并禁用开始提取', async () => {
    useLlmSettings.getState().update({ apiKey: '' });
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);

    expect(await screen.findByText(/需要先在「设置」里配置模型/u)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '开始提取' })).toBeDisabled();
  });
});

describe('上传稿件文件', () => {
  function textFile(name: string, content: string) {
    return new File([new TextEncoder().encode(content)], name, { type: 'text/plain' });
  }

  /** 手写 GB18030 字节，模拟 Windows 记事本「ANSI」存下来的中文 txt */
  function gbkFile(name: string, values: number[]) {
    return new File([new Uint8Array(values)], name, { type: 'text/plain' });
  }

  // 第=B5DA 一=D2BB 章=D5C2 你=C4E3 好=BAC3
  const GBK_FIRST_CHAPTER = [0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, 0xc4, 0xe3, 0xba, 0xc3];

  async function openPaste() {
    const user = userEvent.setup();
    renderImport();
    await screen.findByLabelText('旧稿正文');
    return user;
  }

  it('选文件后正文自动填入，并列出已读入的文件', async () => {
    const user = await openPaste();

    await user.upload(screen.getByLabelText('稿件文件'), textFile('归墟纪.txt', MANUSCRIPT));

    expect(await screen.findByLabelText('旧稿正文')).toHaveValue(MANUSCRIPT);
    expect(screen.getByText('已读入 1 个文件')).toBeInTheDocument();
    expect(screen.getByText('1. 归墟纪.txt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步：切分章节' })).toBeEnabled();
  });

  it('识别 GB18030 的中文稿件，并说明识别到的编码', async () => {
    const user = await openPaste();

    await user.upload(screen.getByLabelText('稿件文件'), gbkFile('老稿子.txt', GBK_FIRST_CHAPTER));

    // 按 UTF-8 硬读这段字节会整篇乱码，而且是「看起来成功了」的那种失败
    expect(await screen.findByLabelText('旧稿正文')).toHaveValue('第一章\n你好');
    expect(screen.getByText(/识别为 GB18030/u)).toBeInTheDocument();
  });

  it('UTF-8 稿件也会说明编码', async () => {
    const user = await openPaste();
    await user.upload(screen.getByLabelText('稿件文件'), textFile('a.txt', '第一章 离乡\n正文。'));
    expect(await screen.findByText(/识别为 UTF-8/u)).toBeInTheDocument();
  });

  it('.rtf 上传后自动提取纯文本，并说明来源', async () => {
    const user = await openPaste();
    const markup =
      '{\\rtf1\\ansi\\deff0 \\u31532?\\u19968?\\u31456?\\par \\u20320?\\u22909?\\par \\u31532?\\u20108?\\u31456?\\par \\u25105?\\u26469?\\u20102?}';

    await user.upload(screen.getByLabelText('稿件文件'), textFile('归墟纪.rtf', markup));

    expect(await screen.findByLabelText('旧稿正文')).toHaveValue('第一章\n你好\n第二章\n我来了');
    expect(screen.getByText(/已从 RTF 提取纯文本/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步：切分章节' })).toBeEnabled();
  });

  it('多个文件按选择顺序依次追加，而不是互相覆盖', async () => {
    const user = await openPaste();
    const input = screen.getByLabelText('稿件文件');

    await user.upload(input, textFile('第一章.txt', '第一章 离乡\n天还没亮。'));
    await user.upload(input, textFile('第二章.txt', '第二章 渡口\n雨下了三天。'));

    const textarea = await screen.findByLabelText('旧稿正文');
    // 按文件名排序在中文里不可靠（「第十章」字典序在「第二章」前），所以顺序由用户掌握
    expect(textarea).toHaveValue('第一章 离乡\n天还没亮。\n\n第二章 渡口\n雨下了三天。');
    expect(screen.getByText('已读入 2 个文件')).toBeInTheDocument();
    expect(screen.getByText('1. 第一章.txt')).toBeInTheDocument();
    expect(screen.getByText('2. 第二章.txt')).toBeInTheDocument();
  });

  it('Word 文档给出「另存为纯文本」的指引，且不动已有内容', async () => {
    const user = await openPaste();
    await user.upload(screen.getByLabelText('稿件文件'), textFile('归墟纪.txt', MANUSCRIPT));
    await screen.findByText('已读入 1 个文件');

    /**
     * applyAccept: false 模拟用户在系统对话框里选了「所有文件」。
     * accept 属性只是个过滤器，挡不住真心要选的人，更挡不住拖拽，
     * 所以扩展名校验必须在代码里也做一遍。
     * （这是 user-event 的 setup 级选项，不能按次传。）
     */
    const loose = userEvent.setup({ applyAccept: false });
    await loose.upload(
      screen.getByLabelText('稿件文件'),
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], '稿件.docx'),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/另存为/u);
    expect(screen.getByLabelText('旧稿正文')).toHaveValue(MANUSCRIPT);
    expect(screen.getByText('已读入 1 个文件')).toBeInTheDocument();
  });

  it('拖拽文件也能读入（桌面端的主要方式）', async () => {
    await openPaste();
    const dropZone = screen.getByRole('button', { name: /选择稿件文件/u }).parentElement!;

    fireEvent.drop(dropZone, {
      dataTransfer: { files: [textFile('拖进来的.txt', MANUSCRIPT)] },
    });

    expect(await screen.findByLabelText('旧稿正文')).toHaveValue(MANUSCRIPT);
    expect(screen.getByText('1. 拖进来的.txt')).toBeInTheDocument();
  });

  it('拖进来格式不对的文件同样被拦下 —— 拖拽绕过了 accept', async () => {
    await openPaste();
    const dropZone = screen.getByRole('button', { name: /选择稿件文件/u }).parentElement!;

    fireEvent.drop(dropZone, {
      dataTransfer: { files: [new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], '稿件.pdf')] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/另存为/u);
    expect(screen.getByLabelText('旧稿正文')).toHaveValue('');
  });

  it('空文件被拦下', async () => {
    const user = await openPaste();
    await user.upload(screen.getByLabelText('稿件文件'), new File([], 'empty.txt'));
    expect(await screen.findByRole('alert')).toHaveTextContent('这个文件是空的');
  });

  it('清空重来会一并清掉文件列表', async () => {
    const user = await openPaste();
    await user.upload(screen.getByLabelText('稿件文件'), textFile('a.txt', MANUSCRIPT));
    await screen.findByText('已读入 1 个文件');

    await user.click(screen.getByRole('button', { name: '清空重来' }));

    expect(screen.getByLabelText('旧稿正文')).toHaveValue('');
    expect(screen.queryByText('已读入 1 个文件')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步：切分章节' })).toBeDisabled();
  });

  it('上传的稿件能直接走到分章预览', async () => {
    const user = await openPaste();
    await user.upload(screen.getByLabelText('稿件文件'), textFile('归墟纪.txt', MANUSCRIPT));
    await screen.findByText('已读入 1 个文件');

    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));

    expect(await screen.findByText(/切出 3 章/u)).toBeInTheDocument();
    expect(screen.getByLabelText('第 1 章标题')).toHaveValue('第一章 离乡');
  });
});

describe('外文稿件的翻译步骤', () => {
  /** 两章英文 + 一章中文，用来验证「部分章节是外文」被按章识别 */
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

  /**
   * 按请求类型分别应答：翻译走流式（stream: true），提取走普通 JSON。
   * 真实链路就是这样，用一个替身同时覆盖两种才不会漏掉串起来的问题。
   */
  function stubTranslateAndExtract(translations: string[]) {
    let call = 0;
    const spy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (request.stream) {
        const text = translations[Math.min(call, translations.length - 1)]!;
        call += 1;
        return Promise.resolve(sseResponse(textDeltaEvents([text])));
      }
      return Promise.resolve(
        jsonResponse(
          completion(
            JSON.stringify({
              entries: [],
              summary: '阿什福德离乡。',
              keyEvents: ['离乡'],
              appearingEntries: [],
              newOpenThreads: [],
              resolvedThreads: [],
              rollingSummary: '阿什福德离乡北上。',
            }),
          ),
        ),
      );
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  const TRANSLATION_1 = [
    '阿什福德在黎明前背起了行囊。',
    '渔村的雾压得很低，他摸了摸胸前的玉，转身没有回头。',
    GLOSSARY_DELIMITER,
    'Ashford => 阿什福德',
  ].join('\n');

  const TRANSLATION_2 = [
    '灰沼渡口的雨下了三天。',
    '阿什福德在雨篷下等着，听着水声，数着自己还剩下什么可以换钱。',
    GLOSSARY_DELIMITER,
    'Ashford => 阿什福德',
    'Greymoor => 灰沼',
  ].join('\n');

  /** 粘贴混合稿并存下草稿，停在翻译步骤 */
  async function reachTranslateStep(translations = [TRANSLATION_1, TRANSLATION_2]) {
    const spy = stubTranslateAndExtract(translations);
    const { user, view } = await pasteManuscript(MIXED);
    await screen.findByText(/切出 3 章/u);
    await user.click(screen.getByRole('button', { name: '下一步：翻译（2 章）' }));
    await screen.findByText(/已翻译 0 \/ 2 章/u);
    return { user, spy, view };
  }

  async function drafts() {
    return (await harness.repository.getImportJob(novel.id))?.drafts ?? [];
  }

  it('检测到外文章节时插入翻译步骤，且不自动开始', async () => {
    const { spy } = await reachTranslateStep();

    // 翻译是最贵的一步，必须让用户先看清要译哪几章再自己按
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /开始翻译（2 章）/u })).toBeInTheDocument();

    const steps = screen.getByRole('dialog', { name: '导入旧稿' });
    expect(within(steps).getByText('翻译')).toBeInTheDocument();
  });

  it('按章判定：中文那一章默认不译', async () => {
    await reachTranslateStep();

    expect(screen.getByLabelText('翻译第 1 章')).toBeChecked();
    expect(screen.getByLabelText('翻译第 2 章')).toBeChecked();
    expect(screen.getByLabelText('翻译第 3 章')).not.toBeChecked();
    expect(screen.getByText('不译')).toBeInTheDocument();
  });

  it('可以取消勾选不想译的章节', async () => {
    const { user } = await reachTranslateStep();

    await user.click(screen.getByLabelText('翻译第 2 章'));

    expect(await screen.findByText(/已翻译 0 \/ 1 章/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /开始翻译（1 章）/u })).toBeInTheDocument();
  });

  it('翻译后草稿正文变中文，原文留一份，一章都没写进作品', async () => {
    const { user } = await reachTranslateStep();
    // 翻译之前：草稿在任务上，章节表是空的
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);

    await user.click(screen.getByRole('button', { name: /开始翻译（2 章）/u }));
    await screen.findByText(/已翻译 2 \/ 2 章/u);

    const rows = await drafts();
    expect(rows[0]?.content).toContain('阿什福德在黎明前背起了行囊');
    expect(rows[1]?.content).toContain('灰沼渡口的雨下了三天');
    // 翻译不可逆，原句必须留得住
    expect(rows[0]?.sourceContent).toContain('Ashford shouldered the pack');
    expect(rows[0]?.sourceLanguage).toBe('en');
    expect(rows.map((item) => item.translateStatus)).toEqual(['done', 'done', 'none']);
    // 中文那一章没被动过
    expect(rows[2]?.content).toContain('灵潮在子夜翻涌起来');
    expect(rows[2]?.sourceContent).toBe('');
    // 目的地还没选，翻译之后也不写章节
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
  });

  it('选主线后章节正文是译文、原文留底，字数按译文算，从主线最大章号接着编号', async () => {
    await harness.repository.createChapter(novel.id, { title: '已有的一章', content: '旧内容' });
    const { user } = await reachTranslateStep();

    await user.click(screen.getByRole('button', { name: /开始翻译（2 章）/u }));
    await screen.findByText(/已翻译 2 \/ 2 章/u);
    await user.click(await screen.findByRole('button', { name: '下一步：选择导入方式' }));
    await user.click(await screen.findByRole('button', { name: '写入主线 3 章' }));

    await screen.findByText(/已提取/u);
    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters.map((item) => item.index)).toEqual([1, 2, 3, 4]);
    const first = chapters[1]!;
    expect(first.content).toContain('阿什福德在黎明前背起了行囊');
    expect(first.sourceContent).toContain('Ashford shouldered the pack');
    expect(first.sourceLanguage).toBe('en');
    expect(first.wordCount).toBe(countWords(first.content));
    expect(chapters[3]?.sourceContent).toBe('');
    await screen.findByText(/提取完成/u);
  });

  it('译名跨章沿用：第二章的 prompt 带上第一章定下的译名', async () => {
    const { user, spy } = await reachTranslateStep();

    await user.click(screen.getByRole('button', { name: /开始翻译（2 章）/u }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    const second = JSON.parse(String(spy.mock.calls[1]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const userMessage = second.messages.find((message) => message.role === 'user')!.content;

    // 同一个人在第五章换个名字，读者会以为是两个人
    expect(userMessage).toContain('【已定译名（必须沿用，不得另起译法）】');
    expect(userMessage).toContain('Ashford => 阿什福德');
    // 上一章译文的结尾用来接住语感
    expect(userMessage).toContain('【上一章译文的结尾');
  });

  it('译名表累计后展示出来', async () => {
    const { user } = await reachTranslateStep();
    await user.click(screen.getByRole('button', { name: /开始翻译（2 章）/u }));

    expect(await screen.findByText(/已定译名 2 条/u)).toBeInTheDocument();
    expect(screen.getByText('Greymoor → 灰沼')).toBeInTheDocument();
  });

  it('译完后才走到提取', async () => {
    const { user } = await reachTranslateStep();

    await user.click(screen.getByRole('button', { name: /开始翻译（2 章）/u }));
    await screen.findByText(/已翻译 2 \/ 2 章/u);

    await user.click(await screen.findByRole('button', { name: '下一步：选择导入方式' }));
    await user.click(await screen.findByRole('button', { name: '写入主线 3 章' }));

    expect(await screen.findByText(/已提取/u)).toBeInTheDocument();
  });

  it('翻译失败时停下来，可单章重试', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        if (call === 1) return Promise.resolve(sseResponse(textDeltaEvents([TRANSLATION_1])));
        return Promise.resolve(jsonResponse({ error: { message: '余额不足' } }, 402));
      }),
    );

    const { user } = await pasteManuscript(MIXED);
    await screen.findByText(/切出 3 章/u);
    await user.click(screen.getByRole('button', { name: '下一步：翻译（2 章）' }));
    await screen.findByText(/已翻译 0 \/ 2 章/u);
    await user.click(screen.getByRole('button', { name: /开始翻译（2 章）/u }));

    expect(await screen.findByText(/第 2 章翻译失败/u)).toBeInTheDocument();
    expect(await screen.findByText(/已翻译 1 \/ 2 章/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    // 第一章的译文不该被这次失败连带丢掉
    const rows = await drafts();
    expect(rows[0]?.sourceContent).toContain('Ashford shouldered the pack');
    expect(rows[1]?.translateStatus).toBe('failed');
    expect(rows[1]?.translateError).toContain('余额不足');
  });

  it('可以跳过翻译直接选导入方式', async () => {
    const { user, spy } = await reachTranslateStep();

    await user.click(await screen.findByRole('button', { name: '跳过剩下的，选择导入方式' }));
    await user.click(await screen.findByRole('button', { name: '写入主线 3 章' }));

    expect(await screen.findByText(/已提取/u)).toBeInTheDocument();
    // 一章都没翻，不该产生任何翻译请求
    const translateCalls = spy.mock.calls.filter((call) =>
      String(call[1]?.body).includes('文学译者'),
    );
    expect(translateCalls).toHaveLength(0);
  });

  it('重开面板时回到翻译步骤，不会跳过去提取', async () => {
    const { user, view } = await pasteManuscript(MIXED);
    await screen.findByText(/切出 3 章/u);
    await user.click(screen.getByRole('button', { name: '下一步：翻译（2 章）' }));
    await screen.findByText(/已翻译 0 \/ 2 章/u);

    view.unmount();
    renderImport();

    // 跳过去提取会让知识库基于外文原文建起来
    expect(await screen.findByText(/已翻译 0 \/ 2 章/u)).toBeInTheDocument();
  });

  it('纯中文稿完全看不到翻译步骤', async () => {
    stubSequence(EXTRACTIONS);
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);

    // 流程一步不多，直接进提取
    expect(await screen.findByText(/已提取/u)).toBeInTheDocument();
    const panel = screen.getByRole('dialog', { name: '导入旧稿' });
    expect(within(panel).queryByText('翻译')).not.toBeInTheDocument();
    expect(within(panel).queryByText('导入到')).not.toBeInTheDocument();
    await screen.findByText(/提取完成/u);
  });
});

describe('跨多次导入的译名一致性', () => {
  /** 第一批：两章英文 */
  const BATCH_ONE = [
    'Chapter 1',
    'Ashford shouldered the pack before dawn and left the fishing village behind him.',
    '',
    'Chapter 2',
    'The rain at Greymoor ferry had lasted three days while Ashford waited under the awning.',
  ].join('\n');

  /** 第二批：过一段时间才导入的另一份英文素材，同样提到 Ashford */
  const BATCH_TWO = [
    'Chapter 3',
    'Ashford climbed the ridge above Greymoor and counted the lights in the valley below.',
  ].join('\n');

  const T1 = ['阿什福德在黎明前背起行囊。', '---译名表---', 'Ashford => 阿什福德'].join('\n');
  const T2 = [
    '灰沼渡口的雨下了三天。',
    '---译名表---',
    'Ashford => 阿什福德',
    'Greymoor => 灰沼',
  ].join('\n');
  const T3 = ['阿什福德爬上灰沼上方的山脊。', '---译名表---', 'Ashford => 阿什福德'].join('\n');

  const EXTRACTION = JSON.stringify({
    entries: [],
    summary: '阿什福德离乡。',
    keyEvents: ['离乡'],
    appearingEntries: [],
    newOpenThreads: [],
    resolvedThreads: [],
    rollingSummary: '阿什福德离乡北上。',
  });

  /** 翻译走流式、提取走普通 JSON，同一个替身覆盖两种 */
  function stubBoth(translations: string[]) {
    let call = 0;
    const spy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (request.stream) {
        const text = translations[Math.min(call, translations.length - 1)]!;
        call += 1;
        return Promise.resolve(sseResponse(textDeltaEvents([text])));
      }
      return Promise.resolve(jsonResponse(completion(EXTRACTION)));
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  /** 走完一整批：粘贴 → 分章 → 写入 → 翻译 → 提取 */
  async function runWholeBatch(
    user: ReturnType<typeof userEvent.setup>,
    manuscript: string,
    chapterCount: number,
  ) {
    await user.click(await screen.findByLabelText('旧稿正文'));
    await user.paste(manuscript);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
    await screen.findByText(new RegExp(`切出 ${chapterCount} 章`, 'u'));
    await user.click(screen.getByRole('button', { name: `下一步：翻译（${chapterCount} 章）` }));
    await screen.findByText(new RegExp(`已翻译 0 / ${chapterCount} 章`, 'u'));
    await user.click(screen.getByRole('button', { name: /开始翻译/u }));
    await screen.findByText(new RegExp(`已翻译 ${chapterCount} / ${chapterCount} 章`, 'u'));
    await user.click(await screen.findByRole('button', { name: '下一步：选择导入方式' }));
    await user.click(await screen.findByRole('button', { name: `写入主线 ${chapterCount} 章` }));
    await screen.findByText(/提取完成/u);
  }

  it('第一批的译名落在作品上，导入任务删掉之后依然在', async () => {
    stubBoth([T1, T2]);
    const user = userEvent.setup();
    renderImport();

    await runWholeBatch(user, BATCH_ONE, 2);

    // 任务的使命（断点续跑）结束就会被删掉
    expect(await harness.repository.getImportJob(novel.id)).toBeUndefined();
    // 译名却必须活下来 —— 它是这部作品的永久事实，不是任务的中间态
    const glossary = await harness.repository.getGlossary(novel.id);
    expect(glossary?.terms).toEqual([
      { source: 'Ashford', target: '阿什福德' },
      { source: 'Greymoor', target: '灰沼' },
    ]);
  });

  it('第二批导入沿用第一批定下的译名', async () => {
    const spy = stubBoth([T1, T2, T3]);
    const user = userEvent.setup();
    const view = renderImport();

    await runWholeBatch(user, BATCH_ONE, 2);
    const callsAfterFirst = spy.mock.calls.length;

    // 关掉面板，过一阵再来导第二批
    view.unmount();
    renderImport();
    await runWholeBatch(user, BATCH_TWO, 1);

    const secondBatchTranslate = spy.mock.calls
      .slice(callsAfterFirst)
      .map(
        (call) =>
          JSON.parse(String(call[1]?.body)) as {
            stream?: boolean;
            messages: { role: string; content: string }[];
          },
      )
      .find((body) => body.stream);

    const userMessage = secondBatchTranslate!.messages.find(
      (message) => message.role === 'user',
    )!.content;

    // 这是整件事的要害：同一个人不能因为分两批导入就有两个名字
    expect(userMessage).toContain('【已定译名（必须沿用，不得另起译法）】');
    expect(userMessage).toContain('Ashford => 阿什福德');
    expect(userMessage).toContain('Greymoor => 灰沼');
  });

  it('用户改过的译名会盖住模型后来的产出', async () => {
    // 第一批之后作者觉得「艾许佛」更好，去译名表改了
    await harness.repository.mergeGlossaryTerms(novel.id, [
      { source: 'Ashford', target: '阿什福德' },
    ]);
    await harness.repository.setGlossaryTerm(novel.id, 'Ashford', '艾许佛');

    const spy = stubBoth([T3]);
    const user = userEvent.setup();
    renderImport();

    await user.click(await screen.findByLabelText('旧稿正文'));
    await user.paste(BATCH_TWO);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
    await screen.findByText(/切出 1 章/u);
    await user.click(screen.getByRole('button', { name: '下一步：翻译（1 章）' }));
    await screen.findByText(/已翻译 0 \/ 1 章/u);
    await user.click(screen.getByRole('button', { name: /开始翻译/u }));
    await screen.findByText(/已翻译 1 \/ 1 章/u);

    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;
    expect(userMessage).toContain('Ashford => 艾许佛');

    // 模型这一章又报了「阿什福德」，但作者的决定不该被推翻
    const glossary = await harness.repository.getGlossary(novel.id);
    expect(glossary?.terms).toEqual([{ source: 'Ashford', target: '艾许佛' }]);
  });

  it('翻译前先在译名表里定好的名字，第一章就会照着译', async () => {
    await harness.repository.setGlossaryTerm(novel.id, 'Ashford', '阿什福德');

    const spy = stubBoth([T3]);
    const user = userEvent.setup();
    renderImport();

    await user.click(await screen.findByLabelText('旧稿正文'));
    await user.paste(BATCH_TWO);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
    await screen.findByText(/切出 1 章/u);
    await user.click(screen.getByRole('button', { name: '下一步：翻译（1 章）' }));
    await screen.findByText(/已翻译 0 \/ 1 章/u);
    await user.click(screen.getByRole('button', { name: /开始翻译/u }));
    await screen.findByText(/已翻译 1 \/ 1 章/u);

    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;
    // 第一章就有约束，不必等模型自己定一个再沿用
    expect(userMessage).toContain('Ashford => 阿什福德');
  });
});

describe('从旧稿归纳文风', () => {
  /**
   * 篇幅够长的稿件。
   *
   * 上面的 MANUSCRIPT 每章只有几十字，取样会因为「稿件篇幅太短」被跳过 ——
   * 那正是它该有的行为，所以这一组用例需要自己造一份够长的稿子。
   */
  const LONG_MANUSCRIPT = [1, 2, 3]
    .map((index) =>
      [
        `第${'一二三'[index - 1]}章 第${index}节`,
        '沈砚沿着渠岸走，水声压在脚下。'.repeat(12),
        '「你怕水。」裴照说。沈砚没答话，只把玉佩收得更紧。'.repeat(8),
      ].join('\n'),
    )
    .join('\n\n');

  const STYLE_RESULT = {
    sentenceRhythm: '以短句为主，偶尔用一个长句收束段落。',
    imagery: '取材水、雾、渠岸这类湿冷的物象。',
    narrativeDistance: '紧贴主角，不进入他人内心。',
    dialogue: '对话短促，常以沉默回应。',
    rhetoric: '少用比喻，靠动作与物件承担情绪。',
    lexicon: '书面语为底，夹少量方言词。',
    avoid: '避免大段心理独白与华丽辞藻。',
    tradition: 'web',
    subGenre: '现代都市',
  };

  async function runImport(results: unknown[]) {
    const spy = stubSequence(results);
    const user = userEvent.setup();
    renderImport();
    const textarea = await screen.findByLabelText('旧稿正文');
    await user.click(textarea);
    await user.paste(LONG_MANUSCRIPT);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
    await screen.findByText(/切出 3 章/u);
    return { user, spy };
  }

  async function runFull(results: unknown[] = [...EXTRACTIONS, STYLE_RESULT]) {
    const { user, spy } = await runImport(results);
    await confirmSplit(user);
    return { user, spy };
  }

  async function pendingByLabel() {
    return waitFor(async () => {
      const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
      const found = pending.find((item) => item.label === '文风与文体');
      expect(found).toBeDefined();
      return { found: found!, pending };
    });
  }

  it('提取跑完后多出一条风格提案，与条目提案同批', async () => {
    await runFull();
    const { found, pending } = await pendingByLabel();

    expect(found.target).toBe('styleProfile');
    expect(found.action).toBe('replace');
    expect(found.origin).toBe('extract');
    expect(found.sourceRef).toBe('导入 3 章');
    // 同一个批次，用户在一个收件箱里连着确认
    expect(new Set(pending.map((item) => item.batchId)).size).toBe(1);
  });

  it('七个维度加文体取向一起进 payload，子类顺手归一化', async () => {
    await runFull();
    const { found } = await pendingByLabel();

    const payload = found.payload as {
      tradition: string;
      subGenre: string;
      customRubric: Record<string, string>;
    };
    expect(payload.tradition).toBe('web');
    // 模型给的是「现代都市」，收敛到合法子类
    expect(payload.subGenre).toBe('都市');
    expect(Object.keys(payload.customRubric)).toHaveLength(7);
    expect(payload.customRubric.sentenceRhythm).toContain('短句');
  });

  it('刻意不碰创作方法论与名家风格参考', async () => {
    await runFull();
    const { found } = await pendingByLabel();

    // 方法论是「接下来怎么规划大纲」的选择，名家参考是「我想像谁」，都不该由模型替作者决定
    expect(found.payload).not.toHaveProperty('methodology');
    expect(found.payload).not.toHaveProperty('voiceRefs');
    expect(found.diff.map((item) => item.field)).not.toContain('methodology');
  });

  it('送去归纳的是从稿件里取的片段，不是提取用的那套提示词', async () => {
    const { spy } = await runFull();
    await pendingByLabel();

    // 三章提取之后才是文风归纳
    const messages = messagesOfCall(spy, 3);
    const system = messages.find((message) => message.role === 'system')!.content;
    const userMessage = messages.find((message) => message.role === 'user')!.content;

    expect(system).toContain('归纳这位作者');
    expect(system).not.toContain('小说资料编辑');
    // 片段带章号，模型才知道它们之间不连续
    expect(userMessage).toMatch(/【第 \d+ 章/u);
    expect(userMessage).toContain('沈砚沿着渠岸走');
  });

  it('确认后文体取向、子类与自定义文风一起落库', async () => {
    const { user } = await runFull();
    await pendingByLabel();
    await screen.findByText(/提取完成/u);

    await user.click(await screen.findByRole('button', { name: /全部写入知识库/u }));

    await waitFor(async () => {
      const style = await harness.repository.getStyleProfile(novel.id);
      expect(style?.subGenre).toBe('都市');
      expect(style?.customRubric?.avoid).toContain('心理独白');
    });
    const style = await harness.repository.getStyleProfile(novel.id);
    expect(style?.tradition).toBe('web');
    // 没碰的维度保持默认
    expect(style?.voiceRefs).toEqual([]);
    expect(style?.methodology).toBe('three-act');
  });

  it('文体取向在收件箱里是下拉，显示中文而不是 web 这种机器值', async () => {
    const { user } = await runFull([
      ...EXTRACTIONS,
      { ...STYLE_RESULT, tradition: 'literary', subGenre: '' },
    ]);
    await pendingByLabel();
    await screen.findByText(/提取完成/u);

    await user.click(await screen.findByRole('button', { name: /文风与文体/u }));

    const select = await screen.findByLabelText('文体取向');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('literary');
    expect(
      within(select as HTMLSelectElement).getByRole('option', { name: '网络文学' }),
    ).toBeInTheDocument();
    // 默认是网络文学，模型判成严肃文学，所以是一处改动
    expect(screen.getByText('改动')).toBeInTheDocument();
  });

  it('可以在收件箱里把模型判错的文体改回去', async () => {
    const { user } = await runFull([
      ...EXTRACTIONS,
      { ...STYLE_RESULT, tradition: 'literary', subGenre: '' },
    ]);
    await pendingByLabel();
    await screen.findByText(/提取完成/u);
    await user.click(await screen.findByRole('button', { name: /文风与文体/u }));

    await user.selectOptions(await screen.findByLabelText('文体取向'), 'genre');
    await user.click(screen.getByRole('button', { name: /全部写入知识库/u }));

    await waitFor(async () => {
      expect((await harness.repository.getStyleProfile(novel.id))?.tradition).toBe('genre');
    });
  });

  it('取消勾选就不归纳，一次调用也不多花', async () => {
    const { user, spy } = await runImport(EXTRACTIONS);
    await user.click(screen.getByRole('checkbox', { name: /顺便归纳这部作品的文风/u }));
    await confirmSplit(user);

    await screen.findByText(/提取完成/u);
    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(pending.some((item) => item.label === '文风与文体')).toBe(false);
    // 三章提取，没有第四次调用
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('归纳失败不影响条目提案，并说明原因', async () => {
    // 第四次调用返回一份缺维度的结果，校验与修复重试都过不了
    await runFull([...EXTRACTIONS, { sentenceRhythm: '短句', tradition: 'web' }]);

    await screen.findByText(/提取完成/u);
    // 十几分钟提取的成果不能因为一次附带调用出错就丢掉
    const pending = await waitFor(async () => {
      const list = await harness.repository.listProposals(novel.id, { status: 'pending' });
      expect(list.some((item) => item.label === '人物 · 沈砚')).toBe(true);
      return list;
    });
    expect(pending.some((item) => item.label === '文风与文体')).toBe(false);
    expect(await screen.findByText(/文风归纳失败/u)).toBeInTheDocument();
  });

  it('稿件太短时跳过并说清楚，而不是拿几十个字硬归纳', async () => {
    const spy = stubSequence(EXTRACTIONS);
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);

    await screen.findByText(/提取完成/u);
    expect(await screen.findByText(/篇幅太短/u)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe('连着导入下一批素材', () => {
  const SECOND = [
    '第四章 归墟',
    '归墟的水是黑的。沈砚站在崖边，把玉佩举到眼前，光从裂缝里透出来。',
  ].join('\n');

  /** 跑完第一轮，停在确认步骤 */
  async function firstRound() {
    const spy = stubSequence(EXTRACTIONS);
    const { user } = await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    await confirmSplit(user);
    await screen.findByText(/提取完成/u);
    return { user, spy };
  }

  it('确认步骤给出继续导入的入口，并说明待确认项不会丢', async () => {
    await firstRound();

    expect(await screen.findByRole('button', { name: /继续导入下一批素材/u })).toBeInTheDocument();
    expect(screen.getByText(/待确认项不会丢/u)).toBeInTheDocument();
  });

  it('点了就回到第一步，输入框是空的', async () => {
    const { user } = await firstRound();

    await user.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));

    expect(await screen.findByLabelText('旧稿正文')).toHaveValue('');
    // 回到第一步，主操作又是「下一步：切分章节」
    expect(screen.getByRole('button', { name: '下一步：切分章节' })).toBeDisabled();
    expect(screen.getByText(/上一批 3 章已经处理完/u)).toBeInTheDocument();
  });

  it('告诉用户新素材会从第几章接着编号（提示在分章页的 picker 里）', async () => {
    const { user } = await firstRound();
    await user.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));

    await user.click(await screen.findByLabelText('旧稿正文'));
    await user.paste(SECOND);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));

    // 第一轮写了 3 章，第二批从第 4 章开始
    expect(
      await screen.findByText('主线已有 3 章，这一批从第 4 章接着编号，不会覆盖已有内容。'),
    ).toBeInTheDocument();
  });

  it('第二批的章节追加在后面，不覆盖第一批', async () => {
    const { user } = await firstRound();
    await user.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));

    const textarea = await screen.findByLabelText('旧稿正文');
    await user.click(textarea);
    await user.paste(SECOND);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
    await screen.findByText(/切出 1 章/u);
    await confirmSplit(user);

    await waitFor(async () => {
      const chapters = await harness.repository.listChapters(novel.id);
      expect(chapters.map((item) => item.index)).toEqual([1, 2, 3, 4]);
    });
    const chapters = await harness.repository.listChapters(novel.id);
    expect(chapters[3]?.title).toBe('第四章 归墟');
    expect(chapters[0]?.content).toContain('沈砚背起行囊');
  });

  it('上一批没确认的提案留在库里，不会被下一轮清掉', async () => {
    const { user } = await firstRound();
    const before = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(before.length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));
    await screen.findByLabelText('旧稿正文');

    const after = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(after.map((item) => item.id).sort()).toEqual(before.map((item) => item.id).sort());
  });

  it('第二批用的是新批次号，与第一批的收件箱分开', async () => {
    const { user } = await firstRound();
    const firstBatch = (await harness.repository.listProposals(novel.id, { status: 'pending' }))[0]!
      .batchId;

    await user.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));
    const textarea = await screen.findByLabelText('旧稿正文');
    await user.click(textarea);
    await user.paste(SECOND);
    await user.click(screen.getByRole('button', { name: '下一步：切分章节' }));
    await screen.findByText(/切出 1 章/u);
    await confirmSplit(user);

    await waitFor(async () => {
      const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
      const batches = new Set(pending.map((item) => item.batchId));
      expect(batches.size).toBe(2);
      expect(batches.has(firstBatch)).toBe(true);
    });
  });

  it('作品级译名表跨轮沿用', async () => {
    // 译名是作品的永久事实，换一批素材不该从空表重来
    await harness.repository.mergeGlossaryTerms(novel.id, [
      { source: 'Ashford', target: '阿什福德' },
    ]);
    const { user } = await firstRound();
    await user.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));
    await screen.findByLabelText('旧稿正文');

    const glossary = await harness.repository.getGlossary(novel.id);
    expect(glossary?.terms).toEqual([{ source: 'Ashford', target: '阿什福德' }]);
  });

  it('第一次进来没有已有章节时不显示编号提示', async () => {
    await pasteManuscript();
    await screen.findByText(/切出 3 章/u);
    expect(screen.getByRole('radio', { name: /^主线章节/u })).toBeChecked();
    expect(screen.queryByText(/主线已有/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/已经处理完/u)).not.toBeInTheDocument();
  });

  it('章号有缺口时按最大章号接续，而不是按章数', async () => {
    // 删过章的作品章数与最大章号不相等，编号接续用的是后者
    await harness.repository.createChapter(novel.id, {
      index: 7,
      title: '旧章',
      content: '正文。',
    });
    await pasteManuscript();
    expect(
      await screen.findByText('主线已有 1 章，这一批从第 8 章接着编号，不会覆盖已有内容。'),
    ).toBeInTheDocument();
  });
});

describe('作为世界观设定导入', () => {
  const WORLDVIEW = [
    '灵潮：每逢子夜，天地灵气如潮水般涨落，修士借此突破境界。',
    '',
    '裴照：归墟渡口的船夫，知晓通往归墟的水路。',
  ].join('\n');

  const WORLDVIEW_EXTRACTION = {
    entries: [
      {
        categoryName: '世界观设定',
        title: '灵潮',
        aliases: [],
        summary: '子夜涨落的灵气潮汐',
        fields: [{ key: 'definition', value: '子夜涨落的灵气潮汐' }],
      },
      {
        categoryName: '人物',
        title: '裴照',
        aliases: ['船家'],
        summary: '归墟渡口的船夫',
        fields: [{ key: 'identity', value: '渡口船夫' }],
      },
    ],
    // schema 要求这些字段非空；世界观模式下必须被丢弃
    summary: '这是一段设定。',
    keyEvents: ['不该出现的事件'],
    appearingEntries: [],
    newOpenThreads: ['不该出现的伏笔'],
    resolvedThreads: [],
    rollingSummary: '不该写进全书进展的内容。',
  };

  /** 粘贴设定文本，在分章页选「仅作为世界观设定」，开始提取 */
  async function pasteWorldview(text = WORLDVIEW) {
    const { user, view } = await pasteManuscript(text);
    await screen.findByText(/切出 \d+ 章/u);
    await confirmSplit(user, 'worldview');
    return { user, view };
  }

  it('提取完成后只生成条目提案，进入收件箱', async () => {
    stubSequence([WORLDVIEW_EXTRACTION]);
    await pasteWorldview();

    expect(await screen.findByText(/提取完成/u)).toBeInTheDocument();
    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(pending.map((item) => item.label).sort()).toEqual(
      ['世界观设定 · 灵潮', '人物 · 裴照'].sort(),
    );
    expect(pending.every((item) => item.target === 'knowledgeEntry')).toBe(true);
    expect(pending.every((item) => item.action === 'create')).toBe(true);
    expect(pending.every((item) => item.sourceRef === '世界观设定导入')).toBe(true);
    expect(new Set(pending.map((item) => item.batchId)).size).toBe(1);
  });

  it('全程不写任何章节，跑完任务也被清掉', async () => {
    let release: (() => void) | undefined;
    const spy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse(completion(JSON.stringify(WORLDVIEW_EXTRACTION))));
        }),
    );
    vi.stubGlobal('fetch', spy);

    await pasteWorldview();

    // 请求挂起期间：任务在、章节为空
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const running = await harness.repository.getImportJob(novel.id);
    expect(running?.destination).toEqual({ kind: 'worldview' });
    expect(running?.chapters).toEqual([]);
    expect(running?.drafts).toEqual([]);
    expect(running?.worldviewChunks).toHaveLength(1);
    expect(running?.worldviewChunks[0]?.content).toBe(WORLDVIEW);
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);

    release!();
    await screen.findByText(/提取完成/u);
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
    expect(await harness.repository.getImportJob(novel.id)).toBeUndefined();
  });

  it('不生成章节摘要、全书进展与文风提案，作品进展摘要不变', async () => {
    const spy = stubSequence([WORLDVIEW_EXTRACTION]);
    // 篇幅足够归纳文风，确保「没出文风提案」不是因为样本太短
    const long = Array.from(
      { length: 30 },
      (_, i) => `第${i}条设定：${'灵气潮汐涨落'.repeat(10)}`,
    ).join('\n\n');
    await pasteWorldview(long);
    await screen.findByText(/提取完成/u);

    const all = await harness.repository.listProposals(novel.id);
    const targets = new Set(all.map((item) => item.target));
    expect(targets.has('chapterSummary')).toBe(false);
    expect(targets.has('novel')).toBe(false);
    expect(targets.has('styleProfile')).toBe(false);
    // 只发了提取请求，没有额外的文风调用
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe(
      novel.rollingSummary,
    );
  });

  it('收件箱显示世界观专属文案', async () => {
    stubSequence([WORLDVIEW_EXTRACTION]);
    await pasteWorldview();

    expect(await screen.findByText(/从设定文本中读出/u)).toBeInTheDocument();
    expect(screen.getByText(/不会创建任何章节/u)).toBeInTheDocument();
    expect(screen.queryByText(/章节摘要、人物与设定/u)).not.toBeInTheDocument();
  });

  it('提取 prompt 标成设定文本，不冒充章节，也不带伏笔与进展', async () => {
    const spy = stubSequence([WORLDVIEW_EXTRACTION]);
    await pasteWorldview();
    await screen.findByText(/提取完成/u);

    const userMessage = messagesOfCall(spy, 0).find((message) => message.role === 'user')!.content;
    expect(userMessage).toContain('【设定文本（世界观设定）】');
    expect(userMessage).toContain('灵潮：每逢子夜');
    expect(userMessage).not.toContain('本章正文');
    expect(userMessage).not.toContain('第 -1 章');
    expect(userMessage).not.toContain('【此前的全书进展摘要】');
  });

  it('已有同名条目走合并，写入后不带伪造的溯源章节', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory().id,
      title: '裴照',
      summary: '旧识',
      fields: { identity: '船夫' },
    });
    stubSequence([WORLDVIEW_EXTRACTION]);
    const { user } = await pasteWorldview();
    await screen.findByText(/提取完成/u);

    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    expect(pending.find((item) => item.label === '人物 · 裴照')?.action).toBe('merge');

    await user.click(await screen.findByRole('button', { name: /全部写入知识库/u }));
    await waitFor(async () => {
      const entries = await harness.repository.listEntries(novel.id);
      expect(entries.map((entry) => entry.title).sort()).toEqual(['灵潮', '裴照'].sort());
    });
    const entries = await harness.repository.listEntries(novel.id);
    expect(entries.every((entry) => entry.sourceChapterIds.length === 0)).toBe(true);
    expect(entries.find((entry) => entry.title === '裴照')?.fields.identity).toBe('渡口船夫');
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
  });

  it('长文本分段提取，各段读到的同名条目合并成一条提案', async () => {
    const half = (seed: string) =>
      Array.from({ length: 40 }, (_, i) => `${seed}${i}：${'灵潮涨落'.repeat(20)}`).join('\n\n');
    const long = `${half('上篇')}\n\n${half('下篇')}`;
    const spy = stubSequence([
      WORLDVIEW_EXTRACTION,
      {
        ...WORLDVIEW_EXTRACTION,
        entries: [
          {
            categoryName: '世界观设定',
            title: '灵潮',
            aliases: ['潮汐'],
            summary: '子夜涨落的灵气潮汐',
            fields: [{ key: 'definition', value: '子夜涨落、可助突破的灵气潮汐' }],
          },
        ],
      },
    ]);
    await pasteWorldview(long);
    await screen.findByText(/提取完成/u);

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstUser = messagesOfCall(spy, 0).find((message) => message.role === 'user')!.content;
    expect(firstUser).toMatch(/【设定文本（世界观设定 第 1\/\d+ 段）】/u);

    const pending = await harness.repository.listProposals(novel.id, { status: 'pending' });
    const lingchao = pending.filter((item) => item.label === '世界观设定 · 灵潮');
    expect(lingchao).toHaveLength(1);
    expect(pending).toHaveLength(2);
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
  });

  it('某段失败时停下来；重开面板回到提取步骤接着跑', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: { message: '余额不足' } }, 402))),
    );
    const { view } = await pasteWorldview();

    expect(await screen.findByText(/第 1 段提取失败/u)).toBeInTheDocument();
    expect(await screen.findByText(/已提取 0 \/ 1 段/u)).toBeInTheDocument();
    const job = await harness.repository.getImportJob(novel.id);
    expect(job?.destination).toEqual({ kind: 'worldview' });
    expect(job?.chapters).toEqual([]);
    expect(job?.worldviewChunks.map((item) => item.status)).toEqual(['failed']);
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);

    view.unmount();
    stubSequence([WORLDVIEW_EXTRACTION]);
    const user = userEvent.setup();
    renderImport();

    expect(await screen.findByText(/已提取 0 \/ 1 段/u)).toBeInTheDocument();
    expect(screen.queryByLabelText('旧稿正文')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续提取' })).toBeInTheDocument();

    // 失败段可以单独重试，跑完照常进收件箱
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText(/从设定文本中读出/u)).toBeInTheDocument();
    expect(await harness.repository.listChapters(novel.id)).toEqual([]);
  });

  it('分章页的 picker：编号提示随目的地变化，选世界观时不报章号', async () => {
    await harness.repository.createChapter(novel.id, { title: '已有的一章', content: '旧内容' });
    const { user } = await pasteManuscript(WORLDVIEW);
    expect(
      await screen.findByText('主线已有 1 章，这一批从第 2 章接着编号，不会覆盖已有内容。'),
    ).toBeInTheDocument();
    // 粘贴步骤不再有「导入类型」
    expect(screen.queryByRole('button', { name: '作为世界观设定' })).not.toBeInTheDocument();

    await chooseDestination(user, 'worldview');

    expect(screen.queryByText(/接着编号/u)).not.toBeInTheDocument();
    expect(screen.getByText('不会写成任何章节，只提取成知识库条目。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提取为世界观设定' })).toBeEnabled();
    // 世界观不显示文风选项
    expect(
      screen.queryByRole('checkbox', { name: /顺便归纳这部作品的文风/u }),
    ).not.toBeInTheDocument();
  });

  it('处理完一份设定后继续导入，提示针对设定而不是章数', async () => {
    stubSequence([WORLDVIEW_EXTRACTION]);
    const { user } = await pasteWorldview();
    await screen.findByText(/提取完成/u);

    await user.click(screen.getByRole('button', { name: /继续导入下一批素材/u }));
    expect(await screen.findByLabelText('旧稿正文')).toHaveValue('');
    expect(screen.getByText(/上一份设定已经处理完/u)).toBeInTheDocument();
    expect(screen.queryByText(/上一批 \d+ 章/u)).not.toBeInTheDocument();
  });
});
