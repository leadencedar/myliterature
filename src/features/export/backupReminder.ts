import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 备份提醒。
 *
 * 数据全在浏览器里，而「清除浏览器数据」是用户自己随手就会做的事。
 * 所以必须在攒下真正值得心疼的字数之后，主动提醒一次 —— 但也只是提醒：
 * 反复弹同一条横幅比不提醒更容易被永久忽略。
 */

/** 攒到这个字数才提醒。太早提醒会被当成噪音 */
export const REMIND_AFTER_WORDS = 3000;

/** 距上次备份（或上次忽略）超过这么久才再提一次 */
export const REMIND_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BackupReminderState {
  lastBackupAt: number | null;
  /** 上次点「以后再说」的时间 */
  dismissedAt: number | null;
  markBackedUp: (at?: number) => void;
  dismiss: (at?: number) => void;
}

export const useBackupReminder = create<BackupReminderState>()(
  persist(
    (set) => ({
      lastBackupAt: null,
      dismissedAt: null,
      markBackedUp: (at = Date.now()) => set({ lastBackupAt: at, dismissedAt: null }),
      dismiss: (at = Date.now()) => set({ dismissedAt: at }),
    }),
    { name: 'myliterature.backup-reminder' },
  ),
);

/** 是否该提醒备份。纯函数，便于测试各种时间组合 */
export function shouldRemindBackup(
  state: Pick<BackupReminderState, 'lastBackupAt' | 'dismissedAt'>,
  totalWords: number,
  now = Date.now(),
): boolean {
  if (totalWords < REMIND_AFTER_WORDS) return false;
  if (state.dismissedAt !== null && now - state.dismissedAt < REMIND_INTERVAL_MS) return false;
  if (state.lastBackupAt === null) return true;
  return now - state.lastBackupAt >= REMIND_INTERVAL_MS;
}
