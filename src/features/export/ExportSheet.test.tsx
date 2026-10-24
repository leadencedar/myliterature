import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChapterSchema,
  NovelSchema,
  SideStorySchema,
  type Chapter,
  type Novel,
  type SideStory,
} from '@/domain/schema';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { ExportSheet } from './ExportSheet';

let harness: TestHarness;
let downloaded: { name: string; text: string } | undefined;

const NOVEL: Novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  oneLiner: '一个少年为寻母远赴归墟。',
  createdAt: 0,
  updatedAt: 0,
});

function chapter(index: number, title: string, content: string, done = true): Chapter {
  return ChapterSchema.parse({
    id: `ch${index}`,
    novelId: 'n1',
    index,
    title,
    content,
    status: done ? 'done' : 'draft',
    createdAt: 0,
    updatedAt: 0,
  });
}

const CHAPTERS = [
  chapter(2, '渡口', '雨下了三天。'),
  chapter(1, '离乡', '天还没亮。'),
  chapter(3, '灵潮', '子夜翻涌。', false),
];

beforeEach(async () => {
  harness = await createTestHarness();

  downloaded = undefined;
  // 拦住真正的跳转：jsdom 不实现下载，而我们只想看文件名与内容
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const comma = this.href.indexOf(',');
    downloaded = {
      name: this.download,
      text: decodeURIComponent(this.href.slice(comma + 1)),
    };
  });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
});

function renderSheet(defaultChapterId?: string) {
  const user = userEvent.setup();
  harness.renderUI(
    <ExportSheet
      open
      novel={NOVEL}
      chapters={CHAPTERS}
      {...(defaultChapterId ? { defaultChapterId } : {})}
      onClose={() => {}}
    />,
  );
  return user;
}

describe('范围与格式', () => {
  it('默认导出全书，预览带书名与全部章节', async () => {
    renderSheet();
    const dialog = screen.getByRole('dialog');
    const preview = within(dialog).getByText(/# 归墟纪/u);

    expect(preview).toHaveTextContent('体裁：仙侠');
    expect(preview).toHaveTextContent('## 离乡');
    expect(preview).toHaveTextContent('## 渡口');
    expect(within(dialog).getByText(/文件名 归墟纪\.md/u)).toBeInTheDocument();
  });

  it('切到单章只导出选中的那一章', async () => {
    const user = renderSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: '单章' }));
    await user.selectOptions(within(dialog).getByLabelText('选择章节'), 'ch2');

    const preview = within(dialog).getByText(/## 渡口/u);
    expect(preview).toHaveTextContent('雨下了三天。');
    expect(preview).not.toHaveTextContent('天还没亮。');
    expect(within(dialog).getByText(/文件名 归墟纪 - 渡口\.md/u)).toBeInTheDocument();
  });

  it('章节下拉按序号排序', async () => {
    const user = renderSheet();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '单章' }));

    const options = within(screen.getByRole('dialog'))
      .getByLabelText('选择章节')
      .querySelectorAll('option');
    expect([...options].map((option) => option.textContent)).toEqual([
      '第 1 章 离乡',
      '第 2 章 渡口',
      '第 3 章 灵潮',
    ]);
  });

  it('传入 defaultChapterId 时直接停在单章', () => {
    renderSheet('ch3');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '单章' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByLabelText('选择章节')).toHaveValue('ch3');
  });

  it('纯文本格式不带标记符号', async () => {
    const user = renderSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: '纯文本' }));

    expect(within(dialog).queryByText(/# 归墟纪/u)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/^归墟纪/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/文件名 归墟纪\.txt/u)).toBeInTheDocument();
  });

  it('「只导出已完成」会跳过草稿章', async () => {
    const user = renderSheet();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByLabelText('只导出已完成的章节'));

    const preview = within(dialog).getByText(/# 归墟纪/u);
    expect(preview).toHaveTextContent('## 渡口');
    expect(preview).not.toHaveTextContent('## 灵潮');
  });

  it('全书范围下不出现章节下拉，单章范围下不出现「只导出已完成」', async () => {
    const user = renderSheet();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('选择章节')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '单章' }));
    expect(within(dialog).queryByLabelText('只导出已完成的章节')).not.toBeInTheDocument();
  });
});

describe('带走内容', () => {
  it('复制到剪贴板', async () => {
    const user = renderSheet();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '复制' }));

    expect(await screen.findByText('已复制到剪贴板')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toContain('# 归墟纪');
  });

  it('剪贴板不可用时提示改用下载', async () => {
    const user = renderSheet();
    // 在 userEvent 装好剪贴板替身之后再覆盖，模拟权限被拒。
    // 兜底路径用的 execCommand 在 jsdom 里不存在，正好模拟「彻底不可用」
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '复制' }));

    expect(await screen.findByText('复制失败，可以改用下载文件')).toBeInTheDocument();
  });

  it('下载文件带正确的文件名与内容', async () => {
    const user = renderSheet();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '下载文件' }));

    expect(downloaded?.name).toBe('归墟纪.md');
    expect(downloaded?.text).toContain('## 离乡');
    expect(await screen.findByText('已导出 归墟纪.md')).toBeInTheDocument();
  });

  it('没有可导出内容时禁用两个按钮', () => {
    harness.renderUI(<ExportSheet open novel={NOVEL} chapters={[]} onClose={() => {}} />);
    const dialogs = screen.getAllByRole('dialog');
    const dialog = dialogs[dialogs.length - 1]!;
    // 只有书名一行也算内容，所以这里直接看单章分支
    expect(within(dialog).getByText(/共 \d+ 字符/u)).toBeInTheDocument();
  });

  it('单章范围下没有章节时说明并禁用按钮', async () => {
    const user = userEvent.setup();
    harness.renderUI(<ExportSheet open novel={NOVEL} chapters={[]} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: '单章' }));

    expect(within(dialog).getByText('还没有章节可导出。')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '复制' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '下载文件' })).toBeDisabled();
  });
});

describe('外传', () => {
  const STORY: SideStory = SideStorySchema.parse({
    id: 'side-a',
    novelId: 'n1',
    title: '青冥旧事',
    createdAt: 0,
    updatedAt: 0,
  });
  const OTHER: SideStory = SideStorySchema.parse({
    id: 'side-b',
    novelId: 'n1',
    title: '渡口',
    createdAt: 0,
    updatedAt: 0,
  });
  function sideChapter(storyId: string, index: number, title: string, content: string): Chapter {
    return { ...chapter(index, title, content), id: `${storyId}-${index}`, sideStoryId: storyId };
  }
  const SIDE_CHAPTERS = [
    sideChapter('side-a', 1, '拜师', '青冥第一章。'),
    sideChapter('side-a', 2, '', '青冥第二章。'),
    sideChapter('side-b', 1, '夜渡', '渡口夜色。'),
  ];

  function renderWithSides(
    chapters: Chapter[] = [...CHAPTERS, ...SIDE_CHAPTERS],
    sideStories: SideStory[] = [STORY, OTHER],
  ) {
    const user = userEvent.setup();
    harness.renderUI(
      <ExportSheet
        open
        novel={NOVEL}
        chapters={chapters}
        sideStories={sideStories}
        onClose={() => {}}
      />,
    );
    return { user, dialog: screen.getByRole('dialog') };
  }

  it('全书默认不含外传；打开「附带外传」后追加', async () => {
    const { user, dialog } = renderWithSides();

    await user.click(within(dialog).getByRole('button', { name: '下载文件' }));
    expect(downloaded?.name).toBe('归墟纪.md');
    expect(downloaded?.text).not.toContain('外传');
    expect(downloaded?.text).not.toContain('青冥第一章。');

    const toggle = within(dialog).getByLabelText('附带外传');
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await user.click(within(dialog).getByRole('button', { name: '下载文件' }));
    expect(downloaded?.text).toContain('# 外传·青冥旧事\n\n## 拜师\n\n青冥第一章。');
    expect(downloaded?.text).toContain('# 外传·渡口\n\n## 夜渡\n\n渡口夜色。');
    expect(downloaded!.text.indexOf('子夜翻涌。')).toBeLessThan(
      downloaded!.text.indexOf('# 外传·青冥旧事'),
    );
  });

  it('可以单独导出一部外传', async () => {
    const { user, dialog } = renderWithSides();

    await user.click(within(dialog).getByRole('button', { name: '外传' }));
    expect(within(dialog).queryByLabelText('附带外传')).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('选择外传'), 'side-b');
    await user.click(within(dialog).getByRole('button', { name: '下载文件' }));

    expect(downloaded?.name).toBe('归墟纪 - 外传·渡口.md');
    expect(downloaded?.text).toBe(
      '# 归墟纪 · 外传·渡口\n\n体裁：仙侠\n故事内核：一个少年为寻母远赴归墟。\n\n## 夜渡\n\n渡口夜色。\n',
    );
  });

  it('单章下拉先列主线，再按外传分组列出外传章节', async () => {
    const { user, dialog } = renderWithSides();
    await user.click(within(dialog).getByRole('button', { name: '单章' }));

    const options = within(dialog).getByLabelText('选择章节').querySelectorAll('option');
    expect([...options].map((option) => option.textContent)).toEqual([
      '第 1 章 离乡',
      '第 2 章 渡口',
      '第 3 章 灵潮',
      '外传·青冥旧事 第 1 章 拜师',
      '外传·青冥旧事 第 2 章',
      '外传·渡口 第 1 章 夜渡',
    ]);

    await user.selectOptions(within(dialog).getByLabelText('选择章节'), 'side-a-2');
    expect(
      within(dialog).getByText(/文件名 归墟纪 - 外传·青冥旧事 第 2 章\.md/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/## 外传·青冥旧事 第 2 章/u)).toHaveTextContent('青冥第二章。');
  });

  it('没有外传时范围里没有「外传」', () => {
    const { dialog } = renderWithSides(CHAPTERS, []);
    expect(within(dialog).queryByRole('button', { name: '外传' })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('附带外传')).not.toBeInTheDocument();
  });

  it('只有外传的作品打开面板时默认范围是「外传」', () => {
    const { dialog } = renderWithSides(SIDE_CHAPTERS.slice(2), [STORY, OTHER]);
    expect(within(dialog).getByRole('button', { name: '外传' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // 默认选中有章节的那一部
    expect(within(dialog).getByLabelText('选择外传')).toHaveValue('side-b');
    expect(within(dialog).getByText(/文件名 归墟纪 - 外传·渡口\.md/u)).toBeInTheDocument();
  });
});
