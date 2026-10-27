import { beforeEach, describe, expect, it } from 'vitest';
import {
  ARCHIVE_SETTINGS_STORAGE_KEY,
  DEFAULT_ARCHIVE_SETTINGS,
  useArchiveSettings,
} from './archiveSettings';

beforeEach(() => {
  localStorage.clear();
  useArchiveSettings.setState({ ...DEFAULT_ARCHIVE_SETTINGS });
});

describe('归档设置', () => {
  it('默认开启自动归档与条目提取', () => {
    expect(DEFAULT_ARCHIVE_SETTINGS).toEqual({ autoArchive: true, extractEntries: true });
    expect(useArchiveSettings.getState().autoArchive).toBe(true);
    expect(useArchiveSettings.getState().extractEntries).toBe(true);
  });

  it('update 修改状态并持久化到 localStorage', () => {
    useArchiveSettings.getState().update({ autoArchive: false, extractEntries: false });

    expect(useArchiveSettings.getState().autoArchive).toBe(false);
    expect(useArchiveSettings.getState().extractEntries).toBe(false);

    const raw = localStorage.getItem(ARCHIVE_SETTINGS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as {
      state: { autoArchive: boolean; extractEntries: boolean };
    };
    expect(persisted.state.autoArchive).toBe(false);
    expect(persisted.state.extractEntries).toBe(false);
  });

  it('可以单独关闭条目提取，不影响自动归档', () => {
    useArchiveSettings.getState().update({ extractEntries: false });

    expect(useArchiveSettings.getState().autoArchive).toBe(true);
    expect(useArchiveSettings.getState().extractEntries).toBe(false);
  });

  it('从持久化数据恢复设置', async () => {
    useArchiveSettings.setState({ autoArchive: true, extractEntries: true });
    localStorage.setItem(
      ARCHIVE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ state: { autoArchive: false, extractEntries: false }, version: 0 }),
    );

    await useArchiveSettings.persist.rehydrate();

    expect(useArchiveSettings.getState().autoArchive).toBe(false);
    expect(useArchiveSettings.getState().extractEntries).toBe(false);
  });
});
