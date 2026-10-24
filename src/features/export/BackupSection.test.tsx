import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Novel } from '@/domain/schema';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { BackupSection } from './BackupSection';
import { serializeBackup, buildBackupFile, exportBackup } from './backup';
import { useBackupReminder } from './backupReminder';

let harness: TestHarness;
let novel: Novel;
let downloaded: { name: string; text: string } | undefined;

beforeEach(async () => {
  harness = await createTestHarness();
  localStorage.clear();
  useBackupReminder.setState({ lastBackupAt: null, dismissedAt: null });

  novel = await harness.repository.createNovel({ title: '归墟纪' });
  await harness.repository.createChapter(novel.id, { title: '离乡', content: '天还没亮。' });

  downloaded = undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const comma = this.href.indexOf(',');
    downloaded = { name: this.download, text: decodeURIComponent(this.href.slice(comma + 1)) };
  });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

function renderSection() {
  const user = userEvent.setup();
  harness.renderUI(<BackupSection />);
  return user;
}

/** 把一份备份文本包成可上传的 File */
function backupFile(text: string, name = 'backup.json') {
  return new File([text], name, { type: 'application/json' });
}

describe('导出备份', () => {
  it('导出后下载 JSON 文件，文件名带日期', async () => {
    const user = renderSection();
    await user.click(screen.getByRole('button', { name: '导出备份文件' }));

    await waitFor(() => expect(downloaded).toBeDefined());
    expect(downloaded?.name).toMatch(/^myliterature-备份-\d{8}\.json$/u);
    const parsed = JSON.parse(downloaded!.text) as { data: { novels: unknown[] } };
    expect(parsed.data.novels).toHaveLength(1);
  });

  it('提示里说明不含 API Key', async () => {
    const user = renderSection();
    await user.click(screen.getByRole('button', { name: '导出备份文件' }));

    expect(await screen.findByText(/不含 API Key/u)).toBeInTheDocument();
    expect(screen.getByText(/1 本作品、1 章/u)).toBeInTheDocument();
  });

  it('导出即记为已备份，横幅不再提醒', async () => {
    const user = renderSection();
    expect(screen.getByText('还没有备份过这台设备上的数据。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '导出备份文件' }));

    await waitFor(() => {
      expect(useBackupReminder.getState().lastBackupAt).not.toBeNull();
    });
    expect(await screen.findByText(/上次备份：/u)).toBeInTheDocument();
  });
});

describe('恢复备份', () => {
  /** 另一台设备的备份：一本别的书 */
  async function otherDeviceBackup() {
    const other = await createTestHarness();
    const otherNovel = await other.repository.createNovel({ title: '另一台设备的书' });
    await other.repository.createChapter(otherNovel.id, { content: '别处的正文。' });
    const snapshot = await other.repository.exportSnapshot();
    await other.cleanup();
    return { text: serializeBackup(buildBackupFile(snapshot, Date.now())), id: otherNovel.id };
  }

  it('覆盖恢复前二次确认，确认后本机原有作品被清空', async () => {
    const { text, id } = await otherDeviceBackup();
    const user = renderSection();

    await user.upload(screen.getByLabelText('备份文件'), backupFile(text));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/全部作品会被清空/u)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '清空并恢复' }));

    await waitFor(async () => {
      expect(await harness.repository.getNovel(novel.id)).toBeUndefined();
      expect((await harness.repository.getNovel(id))?.title).toBe('另一台设备的书');
    });
    expect(await screen.findByText(/已覆盖恢复 1 本作品/u)).toBeInTheDocument();
  });

  it('合并导入保留本机作品', async () => {
    const { text, id } = await otherDeviceBackup();
    const user = renderSection();

    await user.click(screen.getByRole('radio', { name: /合并导入/u }));
    await user.upload(screen.getByLabelText('备份文件'), backupFile(text));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/并入现有数据/u)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '合并导入' }));

    await waitFor(async () => {
      expect(await harness.repository.listNovels()).toHaveLength(2);
    });
    expect((await harness.repository.getNovel(novel.id))?.title).toBe('归墟纪');
    expect((await harness.repository.getNovel(id))?.title).toBe('另一台设备的书');
  });

  it('取消确认时什么都不做', async () => {
    const { text } = await otherDeviceBackup();
    const user = renderSection();

    await user.upload(screen.getByLabelText('备份文件'), backupFile(text));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '取消' }),
    );

    expect((await harness.repository.getNovel(novel.id))?.title).toBe('归墟纪');
    expect(await harness.repository.listNovels()).toHaveLength(1);
  });

  it('选错文件时提示，而不是抛一堆技术细节', async () => {
    const user = renderSection();
    await user.upload(
      screen.getByLabelText('备份文件'),
      backupFile('这明显不是备份', 'photo.json'),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/可能选错了文件/u);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('内容损坏时给出出错字段', async () => {
    const user = renderSection();
    const broken = JSON.stringify({
      app: 'myliterature',
      version: 1,
      exportedAt: 0,
      data: { novels: [{ id: 'n1', createdAt: 0, updatedAt: 0 }] },
    });

    await user.upload(screen.getByLabelText('备份文件'), backupFile(broken));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('备份文件的内容不符合预期');
    expect(alert).toHaveTextContent(/novels\.0\.title/u);
  });

  it('自己导出的备份能被自己读回来', async () => {
    const { text } = await exportBackup(harness.repository);
    const user = renderSection();

    await user.upload(screen.getByLabelText('备份文件'), backupFile(text));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '清空并恢复' }),
    );

    await waitFor(async () => {
      expect((await harness.repository.getNovel(novel.id))?.title).toBe('归墟纪');
    });
    expect(await harness.repository.listChapters(novel.id)).toHaveLength(1);
  });
});
