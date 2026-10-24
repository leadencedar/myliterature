import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { AppShell } from './AppShell';
import { TABS } from './navigation';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

function renderApp(initialPath = '/') {
  return harness.renderUI(<AppShell />, initialPath);
}

describe('AppShell', () => {
  it('默认进入书架页', async () => {
    renderApp();
    // 页面组件按路由懒加载，用 findBy 等块加载完成
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('书架');
    // 等首屏查询落地，避免测试结束后仍有未处理的状态更新
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  });

  it('渲染全部五个底部 Tab', async () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    for (const tab of TABS) {
      expect(nav).toHaveTextContent(tab.label);
    }
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  });

  it.each(TABS.filter((tab) => tab.path !== '/'))('点击「$label」切换到对应页面', async (tab) => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('link', { name: tab.label }));

    // 路由跳转是 transition：旧页面会保留到懒加载块就绪，按名称等到新页标题
    expect(await screen.findByRole('heading', { level: 1, name: tab.label })).toBeInTheDocument();
  });

  it('未知路径重定向回书架', async () => {
    renderApp('/not-exist');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('书架');
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  });

  it('当前 Tab 标记为选中状态', async () => {
    renderApp('/settings');
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('自适应外壳', () => {
  it('导航只有一份：窄屏底栏与桌面侧边栏是同一组链接', async () => {
    renderApp();

    // 按宽度渲染两套导航的话，读屏会读到两遍，自动化也会同时看到两份
    expect(screen.getAllByRole('navigation', { name: '主导航' })).toHaveLength(1);
    for (const tab of TABS) {
      expect(screen.getAllByRole('link', { name: tab.label })).toHaveLength(1);
    }

    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  });

  it('提供「跳到主内容」，且指向真实存在的主内容区', async () => {
    renderApp();

    const skip = screen.getByRole('link', { name: '跳到主内容' });
    expect(skip).toHaveAttribute('href', '#main');
    // 目标必须真的在页面上，否则这条链接只是装饰
    expect(document.querySelector('main#main')).not.toBeNull();

    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  });

  it('跳转链接排在导航之前，键盘第一下 Tab 就能拿到它', async () => {
    renderApp();

    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAccessibleName('跳到主内容');

    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  });
});
