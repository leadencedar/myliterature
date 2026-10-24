import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppShell } from '@/app/AppShell';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';

/**
 * 「我已经写了几十万字」这条入口的端到端验证。
 *
 * 走的是真实路由：书架建作品 → navigate 到知识库 → 知识库读出跳转意图
 * 自动打开导入面板。这三段分别在三个文件里，只有整条串起来才说明它真的通。
 */

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestHarness();
  useActiveNovel.setState({ activeNovelId: null });
});

afterEach(async () => {
  await harness.cleanup();
});

function renderApp() {
  const user = userEvent.setup();
  harness.renderUI(<AppShell />, '/');
  return user;
}

/** 从空书架走到「导入已有稿件」的表单 */
async function openImportCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /导入已有稿件/u }));
  return screen.getByRole('dialog');
}

describe('新建作品的两条路', () => {
  it('空书架同时给出「从零开始」与「导入已有稿件」', async () => {
    renderApp();

    // 页面按路由懒加载，直接用 findBy 等书架内容就位
    expect(await screen.findByRole('button', { name: '创建第一本作品' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导入已有稿件/u })).toBeInTheDocument();
  });

  it('默认是「从一句话」，会问故事内核', async () => {
    const user = renderApp();
    await user.click(await screen.findByRole('button', { name: '创建第一本作品' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '从一句话' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByLabelText('我想讲一个什么故事')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '创建' })).toBeInTheDocument();
  });

  it('导入模式下不问「我想讲一个什么故事」', async () => {
    const user = renderApp();
    const dialog = await openImportCreate(user);

    // 存量作者手里有稿子却还没有那句话，在这里逼他先想一个是错的问题
    expect(within(dialog).queryByLabelText('我想讲一个什么故事')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/会从正文里反推出来/u)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '创建并导入稿件' })).toBeInTheDocument();
  });

  it('两种模式可以来回切换', async () => {
    const user = renderApp();
    const dialog = await openImportCreate(user);

    await user.click(within(dialog).getByRole('button', { name: '从一句话' }));
    expect(within(dialog).getByLabelText('我想讲一个什么故事')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '导入已有稿件' }));
    expect(within(dialog).queryByLabelText('我想讲一个什么故事')).not.toBeInTheDocument();
  });

  it('书名仍然必填', async () => {
    const user = renderApp();
    const dialog = await openImportCreate(user);

    await user.click(within(dialog).getByRole('button', { name: '创建并导入稿件' }));

    expect(within(dialog).getByText('书名不能为空')).toBeInTheDocument();
    expect(await harness.repository.listNovels()).toHaveLength(0);
  });
});

describe('建完作品直接落在导入面板上', () => {
  async function createByImport(user: ReturnType<typeof userEvent.setup>, title = '归墟纪') {
    const dialog = await openImportCreate(user);
    await user.type(within(dialog).getByLabelText('书名'), title);
    await user.click(within(dialog).getByRole('button', { name: '创建并导入稿件' }));
  }

  it('作品落库、设为当前，并自动打开导入面板', async () => {
    const user = renderApp();
    await createByImport(user);

    const panel = await screen.findByRole('dialog', { name: '导入旧稿' });
    // 面板挂载后要先读一次「有没有未完成的导入任务」，粘贴步骤是异步出现的
    expect(await within(panel).findByLabelText('稿件文件')).toBeInTheDocument();
    expect(within(panel).getByLabelText('旧稿正文')).toBeInTheDocument();

    const novels = await harness.repository.listNovels();
    expect(novels).toHaveLength(1);
    expect(novels[0]?.title).toBe('归墟纪');
    // 不设为当前作品的话，知识库页会拦在「先去书架选一本」
    expect(useActiveNovel.getState().activeNovelId).toBe(novels[0]?.id);
    // 那句话留空，等导入后从正文反推
    expect(novels[0]?.oneLiner).toBe('');
  });

  it('上传文件后可以一路走到分章', async () => {
    const user = renderApp();
    await createByImport(user);

    const panel = await screen.findByRole('dialog', { name: '导入旧稿' });
    const manuscript = [
      '第一章 离乡',
      '沈砚背起行囊时天还没亮。',
      '',
      '第二章 渡口',
      '渡口的雨下了三天。',
    ].join('\n');

    await user.upload(
      await within(panel).findByLabelText('稿件文件'),
      new File([new TextEncoder().encode(manuscript)], '归墟纪.txt', { type: 'text/plain' }),
    );
    await user.click(within(panel).getByRole('button', { name: '下一步：切分章节' }));

    expect(await screen.findByText(/切出 2 章/u)).toBeInTheDocument();
    expect(screen.getByLabelText('第 1 章标题')).toHaveValue('第一章 离乡');
  });

  it('关掉面板后离开再回来不会又自动弹开', async () => {
    const user = renderApp();
    await createByImport(user);

    const panel = await screen.findByRole('dialog', { name: '导入旧稿' });
    await within(panel).findByLabelText('稿件文件');
    await user.click(within(panel).getByRole('button', { name: '返回' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '导入旧稿' })).not.toBeInTheDocument();
    });

    // 跳转意图挂在这条历史记录上，不清掉的话页内来回一次就会再弹一遍
    await user.click(screen.getByRole('link', { name: '书架' }));
    await user.click(screen.getByRole('link', { name: '知识库' }));

    expect(await screen.findByRole('heading', { level: 1, name: '知识库' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '导入旧稿' })).not.toBeInTheDocument();
  });

  it('从零开始那条路不会打开导入面板', async () => {
    const user = renderApp();
    await user.click(await screen.findByRole('button', { name: '创建第一本作品' }));

    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('书名'), '新书');
    await user.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(async () => {
      expect(await harness.repository.listNovels()).toHaveLength(1);
    });
    // 仍留在书架，由用户自己决定下一步
    expect(screen.getByRole('heading', { level: 1, name: '书架' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '导入旧稿' })).not.toBeInTheDocument();
  });
});
