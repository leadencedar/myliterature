import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 归档设置（M2 S1）。
 *
 * 与模型配置一样刻意存 localStorage（不进 IndexedDB/备份）：这是「这台设备上的
 * 使用偏好」，换设备后跟着新设备的习惯走即可，也不需要进备份文件。
 */
export interface ArchiveSettings {
  /** 章节标记完成时自动在后台生成档案（摘要 + 进展 + 可选的条目提案） */
  autoArchive: boolean;
  /** 归档时是否提取知识库条目。关掉则只生成摘要与进展，成本不变（仍是一次调用） */
  extractEntries: boolean;
}

interface ArchiveSettingsState extends ArchiveSettings {
  update: (patch: Partial<ArchiveSettings>) => void;
}

export const DEFAULT_ARCHIVE_SETTINGS: ArchiveSettings = {
  autoArchive: true,
  extractEntries: true,
};

export const ARCHIVE_SETTINGS_STORAGE_KEY = 'myliterature.archive-settings';

export const useArchiveSettings = create<ArchiveSettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_ARCHIVE_SETTINGS,
      update: (patch) => set({ ...patch }),
    }),
    { name: ARCHIVE_SETTINGS_STORAGE_KEY },
  ),
);
