import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 外观与阅读偏好（UI v2 阶段 6）。
 *
 * 与模型/归档设置一样只存本机 localStorage，不进 IndexedDB/备份：
 * 换设备后跟着新设备的阅读习惯走即可。
 */
export type ProseFont = 'sans' | 'serif';

export interface AppearanceSettings {
  font: ProseFont;
  /** 正文字号 16–22；正文 max-width = 40 × 字号 */
  size: number;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  font: 'sans',
  size: 17,
};

export const APPEARANCE_STORAGE_KEY = 'myliterature.appearance-settings';

export const MIN_PROSE_SIZE = 16;
export const MAX_PROSE_SIZE = 22;
export const DEFAULT_SERIF_SIZE = 18;

export const PROSE_FONT_STACKS: Record<ProseFont, string> = {
  sans: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  serif: "'Songti SC', 'Source Han Serif SC', 'Noto Serif SC', STSong, Georgia, serif",
};

export function lineHeightFor(font: ProseFont): number {
  return font === 'serif' ? 2.05 : 1.85;
}

export function clampProseSize(size: number): number {
  return Math.min(MAX_PROSE_SIZE, Math.max(MIN_PROSE_SIZE, Math.round(size)));
}

export function proseMaxWidth(size: number): string {
  return `calc(40 * ${clampProseSize(size)}px)`;
}

interface AppearanceState extends AppearanceSettings {
  setFont: (font: ProseFont) => void;
  setSize: (size: number) => void;
  reset: () => void;
}

export const useAppearanceSettings = create<AppearanceState>()(
  persist(
    (set) => ({
      ...DEFAULT_APPEARANCE_SETTINGS,
      setFont: (font) =>
        set((state) => ({
          font,
          // 宋体推荐组合 18/2.05：只有仍停留在黑体默认 17 时才自动升到 18
          ...(font === 'serif' && state.size === 17 ? { size: DEFAULT_SERIF_SIZE } : {}),
        })),
      setSize: (size) => set({ size: clampProseSize(size) }),
      reset: () => set({ ...DEFAULT_APPEARANCE_SETTINGS }),
    }),
    { name: APPEARANCE_STORAGE_KEY },
  ),
);
