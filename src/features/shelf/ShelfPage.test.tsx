import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { REMIND_AFTER_WORDS, useBackupReminder } from '../export/backupReminder';
import { ShelfPage } from './ShelfPage';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

function renderShelf() {
  return harness.renderUI(<ShelfPage />);
}

/** 等首屏加载结束 */
async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
}

describe('书架页', () => {
  it('没有作品时显示空状态', async () => {
    renderShelf();
    await waitForLoaded();

    expect(screen.getByText('还没有作品')).toBeInTheDocument();
  });

  it('创建作品后出现在列表里并成为当前作品', async () => {
    const user = userEvent.setup();
    renderShelf();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '新建作品' }));

    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('书名'), '归墟纪');
    await user.type(
      within(dialog).getByLabelText('我想讲一个什么故事'),
      '一个失忆的剑客发现自己就是灭门案的凶手。',
    );
    await user.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(await screen.findByRole('heading', { level: 2, name: '归墟纪' })).toBeInTheDocument();
    expect(screen.getByText('一个失忆的剑客发现自己就是灭门案的凶手。')).toBeInTheDocument();

    // 新建即设为当前作品
    const novels = await harness.repository.listNovels();
    expect(useActiveNovel.getState().activeNovelId).toBe(novels[0]?.id);
    expect(screen.getByText('当前')).toBeInTheDocument();
  });

  it('书名为空时拦截提交并提示', async () => {
    const user = userEvent.setup();
    renderShelf();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '新建作品' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '创建' }));

    expect(screen.getByRole('alert')).toHaveTextContent('书名不能为空');
    // 对话框保持打开，输入不丢
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await harness.repository.listNovels()).toHaveLength(0);
  });

  it('显示章节数、字数与设定条数', async () => {
    const novel = await harness.repository.createNovel({ title: '统计之书' });
    const categoryId = (await harness.repository.listCategories(novel.id))[0]!.id;
    await harness.repository.createChapter(novel.id, { content: '一二三四五' });
    await harness.repository.createEntry(novel.id, { categoryId, title: '灵气' });

    renderShelf();
    await waitForLoaded();

    const card = screen.getByRole('heading', { level: 2, name: '统计之书' }).closest('li');
    expect(card).not.toBeNull();
    expect(within(card!).getByText('1 章')).toBeInTheDocument();
    expect(within(card!).getByText('5 字')).toBeInTheDocument();
    expect(within(card!).getByText('1 条设定')).toBeInTheDocument();
    // 没有外传时不显示外传章数
    expect(within(card!).queryByText(/外传/u)).not.toBeInTheDocument();
  });

  it('有外传时显示「外传 K 章」，章数只算主线，总字数含外传', async () => {
    const novel = await harness.repository.createNovel({ title: '外传之书' });
    await harness.repository.createChapter(novel.id, { content: '一二三四五' });
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, content: '甲乙丙' });
    await harness.repository.createChapter(novel.id, { sideStoryId: story.id, content: '丁戊' });

    renderShelf();
    await waitForLoaded();

    const card = screen.getByRole('heading', { level: 2, name: '外传之书' }).closest('li');
    expect(within(card!).getByText('1 章')).toBeInTheDocument();
    expect(within(card!).getByText('外传 2 章')).toBeInTheDocument();
    expect(within(card!).getByText('10 字')).toBeInTheDocument();
  });

  it('可以重命名作品', async () => {
    const user = userEvent.setup();
    const novel = await harness.repository.createNovel({ title: '旧名' });

    renderShelf();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '旧名 的更多操作' }));
    await user.click(screen.getByRole('button', { name: '编辑作品信息' }));

    const dialog = screen.getByRole('dialog');
    const titleInput = within(dialog).getByLabelText('书名');
    await user.clear(titleInput);
    await user.type(titleInput, '新名');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      expect((await harness.repository.getNovel(novel.id))?.title).toBe('新名');
    });
    expect(await screen.findByRole('heading', { level: 2, name: '新名' })).toBeInTheDocument();
  });

  it('删除作品需二次确认，确认后连带清空当前作品选择', async () => {
    const user = userEvent.setup();
    const novel = await harness.repository.createNovel({ title: '待删之书' });
    useActiveNovel.setState({ activeNovelId: novel.id });

    renderShelf();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '待删之书 的更多操作' }));
    await user.click(screen.getByRole('button', { name: '删除作品' }));

    // 确认文案要讲清后果
    expect(screen.getByText(/无法恢复/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '永久删除' }));

    await waitFor(() => expect(screen.getByText('还没有作品')).toBeInTheDocument());
    expect(await harness.repository.getNovel(novel.id)).toBeUndefined();
    expect(useActiveNovel.getState().activeNovelId).toBeNull();
  });

  it('取消删除时不会动数据', async () => {
    const user = userEvent.setup();
    const novel = await harness.repository.createNovel({ title: '留下之书' });

    renderShelf();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '留下之书 的更多操作' }));
    await user.click(screen.getByRole('button', { name: '删除作品' }));
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(await harness.repository.getNovel(novel.id)).toBeDefined();
  });

  it('通过操作菜单切换当前作品', async () => {
    const user = userEvent.setup();
    await harness.repository.createNovel({ title: '甲书' });
    const second = await harness.repository.createNovel({ title: '乙书' });

    renderShelf();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '乙书 的更多操作' }));
    await user.click(screen.getByRole('button', { name: '设为当前作品' }));

    expect(useActiveNovel.getState().activeNovelId).toBe(second.id);
  });
});

describe('备份提醒', () => {
  beforeEach(() => {
    localStorage.clear();
    useBackupReminder.setState({ lastBackupAt: null, dismissedAt: null });
  });

  /** 攒出超过提醒门槛的字数 */
  async function seedWords(words = REMIND_AFTER_WORDS) {
    const novel = await harness.repository.createNovel({ title: '归墟纪' });
    await harness.repository.createChapter(novel.id, { content: '字'.repeat(words) });
    return novel;
  }

  it('字数不够时不提醒', async () => {
    await seedWords(REMIND_AFTER_WORDS - 1);
    renderShelf();
    await waitForLoaded();
    expect(screen.queryByRole('button', { name: '去备份' })).not.toBeInTheDocument();
  });

  it('攒够字数且没备份过时给出横幅', async () => {
    await seedWords();
    renderShelf();
    await waitForLoaded();

    expect(await screen.findByRole('button', { name: '去备份' })).toBeInTheDocument();
    expect(screen.getByText(/清除浏览器数据或换手机都会带走它们/u)).toBeInTheDocument();
  });

  it('点「以后再说」后安静下来', async () => {
    const user = userEvent.setup();
    await seedWords();
    renderShelf();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: '以后再说' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '去备份' })).not.toBeInTheDocument();
    });
    expect(useBackupReminder.getState().dismissedAt).not.toBeNull();
  });

  it('刚备份过就不提醒', async () => {
    await seedWords();
    useBackupReminder.setState({ lastBackupAt: Date.now(), dismissedAt: null });
    renderShelf();
    await waitForLoaded();
    expect(screen.queryByRole('button', { name: '去备份' })).not.toBeInTheDocument();
  });
});
