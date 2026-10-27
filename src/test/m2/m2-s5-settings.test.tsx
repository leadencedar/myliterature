/**
 * M2-S5 独立验收：设置页「写作辅助」开关与成本说明（design §3/§6.5）。
 *
 * 独立于开发的 SettingsPage.test.tsx：验证默认值、开关持久化 key、成本说明文案。
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useArchiveSettings } from '@/features/writing/archiveSettings';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestHarness();
  localStorage.clear();
  useArchiveSettings.setState({ autoArchive: true, extractEntries: true });
});

afterEach(async () => {
  await harness.cleanup();
  localStorage.clear();
});

describe('M2-S5 · 写作辅助设置', () => {
  it('展示「写作辅助」Section、两个默认勾选的开关与成本说明', async () => {
    harness.renderUI(<SettingsPage />);
    expect(await screen.findByText('写作辅助')).toBeInTheDocument();

    const autoArchive = screen.getByLabelText('完成后自动生成本章档案') as HTMLInputElement;
    const extractEntries = screen.getByLabelText('归档时提取知识库条目') as HTMLInputElement;
    expect(autoArchive.checked).toBe(true);
    expect(extractEntries.checked).toBe(true);

    expect(screen.getByText(/每章归档 1 次结构化调用/u)).toBeInTheDocument();
    expect(screen.getByText(/摘要与进展是摘要链的来源，必须生成/u)).toBeInTheDocument();
    // 说明「不弹窗、不阻塞」的交互预期；task-28 补了「摘要与知识库更新，可关条目」
    expect(screen.getByText(/不弹窗、不阻塞写作/u)).toBeInTheDocument();
    expect(screen.getByText(/摘要与知识库更新，可关条目/u)).toBeInTheDocument();
  });

  it('关闭自动归档：store 更新并持久化到 localStorage', async () => {
    harness.renderUI(<SettingsPage />);
    const user = userEvent.setup();
    const toggle = await screen.findByLabelText('完成后自动生成本章档案');

    await user.click(toggle);

    expect(useArchiveSettings.getState().autoArchive).toBe(false);
    expect(useArchiveSettings.getState().extractEntries).toBe(true);
    const raw = localStorage.getItem('myliterature.archive-settings');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { state: { autoArchive: boolean; extractEntries: boolean } };
    expect(parsed.state.autoArchive).toBe(false);
    expect(parsed.state.extractEntries).toBe(true);
  });

  it('关闭条目提取：只影响条目，不影响自动归档；两次开关都持久化', async () => {
    harness.renderUI(<SettingsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('归档时提取知识库条目'));

    expect(useArchiveSettings.getState()).toMatchObject({
      autoArchive: true,
      extractEntries: false,
    });
    const raw = localStorage.getItem('myliterature.archive-settings');
    const parsed = JSON.parse(raw!) as { state: { autoArchive: boolean; extractEntries: boolean } };
    expect(parsed.state).toMatchObject({ autoArchive: true, extractEntries: false });

    await user.click(screen.getByLabelText('完成后自动生成本章档案'));
    const after = JSON.parse(localStorage.getItem('myliterature.archive-settings')!) as {
      state: { autoArchive: boolean; extractEntries: boolean };
    };
    expect(after.state).toMatchObject({ autoArchive: false, extractEntries: false });
  });
});
