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
import { buildChapterPackZip } from './chapterPack';
import { ExportSheet } from './ExportSheet';

/**
 * 打包导出的面板测试。
 *
 * 单独成文件是因为这里要 mock `buildChapterPackZip`（失败提示与「正在打包…」
 * 需要控制 Promise），而现有 `ExportSheet.test.tsx` 不该被 mock 影响。
 */
vi.mock('./chapterPack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chapterPack')>();
  return { ...actual, buildChapterPackZip: vi.fn(actual.buildChapterPackZip) };
});

let harness: TestHarness;
let downloaded: { name: string; href: string } | undefined;

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

async function renderPack(chapters: Chapter[] = CHAPTERS, sideStories?: SideStory[]) {
  const user = userEvent.setup();
  harness.renderUI(
    <ExportSheet
      open
      novel={NOVEL}
      chapters={chapters}
      {...(sideStories ? { sideStories } : {})}
      onClose={() => {}}
    />,
  );
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: '打包' }));
  return { user, dialog };
}

/** 从 data URL 里取出 zip 字节（jsdom 的 createObjectURL 不可用，走 base64 兜底） */
function downloadedBytes(): number[] {
  const href = downloaded?.href ?? '';
  const payload = href.slice(href.indexOf(';base64,') + ';base64,'.length);
  return Array.from(atob(payload), (char) => char.charCodeAt(0));
}

beforeEach(async () => {
  harness = await createTestHarness();
  downloaded = undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded = { name: this.download, href: this.href };
  });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
  vi.mocked(buildChapterPackZip).mockClear();
});

describe('打包范围', () => {
  it('切到打包后默认纯文本、逐个文件列出，按钮换成下载压缩包', async () => {
    const { user, dialog } = await renderPack();

    expect(within(dialog).getByRole('button', { name: '纯文本' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: '下载压缩包' })).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: '复制' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('第001章 离乡.txt')).toBeInTheDocument();
    expect(within(dialog).getByText('第002章 渡口.txt')).toBeInTheDocument();
    expect(within(dialog).getByText('第003章 灵潮.txt')).toBeInTheDocument();
    expect(within(dialog).getByText(/共 3 个文件 · 约 \d+ 字/u)).toBeInTheDocument();

    // 默认格式切到 RTF，文件扩展名整体跟着变
    await user.click(within(dialog).getByRole('button', { name: 'RTF' }));
    expect(within(dialog).getByText('第001章 离乡.rtf')).toBeInTheDocument();
    expect(within(dialog).queryByText('第001章 离乡.txt')).not.toBeInTheDocument();
  });

  it('只导出已完成的章节：跳过草稿并给出跳过数', async () => {
    const { user, dialog } = await renderPack();

    await user.click(within(dialog).getByLabelText('只导出已完成的章节'));

    expect(within(dialog).queryByText('第003章 灵潮.txt')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/另有 1 章未包含/u)).toBeInTheDocument();
  });

  it('空章节一律跳过：哪怕没开「只导出已完成」', async () => {
    const { dialog } = await renderPack([...CHAPTERS, chapter(4, '占位', '   ')]);
    expect(within(dialog).queryByText('第004章 占位.txt')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/另有 1 章未包含/u)).toBeInTheDocument();
  });

  it('逐章改格式只影响那一章，「全部改用默认格式」能一次还原', async () => {
    const { user, dialog } = await renderPack();
    const firstSelect = within(dialog).getByLabelText('第001章 离乡.txt 格式');

    await user.selectOptions(firstSelect, 'pdf');

    expect(within(dialog).getByText('第001章 离乡.pdf')).toBeInTheDocument();
    // 其余章仍是默认的纯文本
    expect(within(dialog).getByText('第002章 渡口.txt')).toBeInTheDocument();
    // PDF 在列表里时给出字体限制提示
    expect(within(dialog).getByText(/超出 GBK 的生僻字与 emoji 会显示为 □/u)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '全部改用默认格式' }));
    expect(within(dialog).getByText('第001章 离乡.txt')).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: '全部改用默认格式' }),
    ).not.toBeInTheDocument();
  });

  it('附带外传：外传章节进子文件夹，关掉开关后只剩主线', async () => {
    const story: SideStory = SideStorySchema.parse({
      id: 'side-a',
      novelId: 'n1',
      title: '青冥旧事',
      createdAt: 0,
      updatedAt: 0,
    });
    const sideChapter: Chapter = {
      ...chapter(1, '拜师', '青冥第一章。'),
      id: 'side-a-1',
      sideStoryId: 'side-a',
    };
    const { user, dialog } = await renderPack([...CHAPTERS, sideChapter], [story]);

    await user.click(within(dialog).getByLabelText('附带外传'));
    expect(within(dialog).getByText('外传·青冥旧事/第001章 拜师.txt')).toBeInTheDocument();
    expect(within(dialog).getByText(/共 4 个文件/u)).toBeInTheDocument();

    await user.click(within(dialog).getByLabelText('附带外传'));
    expect(within(dialog).queryByText(/外传·青冥旧事/u)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/共 3 个文件/u)).toBeInTheDocument();
  });

  it('没有可导出章节时说明并禁用下载', async () => {
    harness.renderUI(<ExportSheet open novel={NOVEL} chapters={[]} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    await userEvent.setup().click(within(dialog).getByRole('button', { name: '打包' }));

    expect(within(dialog).getByText('没有可导出的章节。')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '下载压缩包' })).toBeDisabled();
  });
});

describe('下载压缩包', () => {
  it('点下载后生成 zip 并给出成功提示', async () => {
    const { user, dialog } = await renderPack();

    await user.click(within(dialog).getByRole('button', { name: '下载压缩包' }));

    expect(await screen.findByText('已导出 归墟纪.zip')).toBeInTheDocument();
    expect(downloaded?.name).toBe('归墟纪.zip');
    const bytes = downloadedBytes();
    // PK\x03\x04：本地文件头
    expect(bytes.slice(0, 4)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(vi.mocked(buildChapterPackZip)).toHaveBeenCalledTimes(1);
  });

  it('打包中按钮变成「正在打包…」并禁用', async () => {
    let finish: ((bytes: Uint8Array) => void) | undefined;
    vi.mocked(buildChapterPackZip).mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        }),
    );
    const { user, dialog } = await renderPack();

    await user.click(within(dialog).getByRole('button', { name: '下载压缩包' }));

    const busy = await within(dialog).findByRole('button', { name: '正在打包…' });
    expect(busy).toBeDisabled();
    finish?.(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(await screen.findByText('已导出 归墟纪.zip')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '下载压缩包' })).toBeEnabled();
  });

  it('生成失败时提示重试，不静默吞掉', async () => {
    vi.mocked(buildChapterPackZip).mockRejectedValueOnce(new Error('boom'));
    const { user, dialog } = await renderPack();

    await user.click(within(dialog).getByRole('button', { name: '下载压缩包' }));

    expect(await screen.findByText('打包失败，请重试')).toBeInTheDocument();
    expect(downloaded).toBeUndefined();
    expect(within(dialog).getByRole('button', { name: '下载压缩包' })).toBeEnabled();
  });
});
