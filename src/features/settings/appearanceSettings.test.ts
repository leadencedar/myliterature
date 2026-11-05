import { beforeEach, describe, expect, it } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE_SETTINGS,
  clampProseSize,
  lineHeightFor,
  proseMaxWidth,
  useAppearanceSettings,
} from './appearanceSettings';

beforeEach(() => {
  localStorage.clear();
  useAppearanceSettings.setState({ ...DEFAULT_APPEARANCE_SETTINGS });
});

describe('外观与阅读设置', () => {
  it('默认黑体 17 / 1.85，正文宽 680', () => {
    expect(useAppearanceSettings.getState().font).toBe('sans');
    expect(useAppearanceSettings.getState().size).toBe(17);
    expect(lineHeightFor('sans')).toBe(1.85);
    expect(proseMaxWidth(17)).toBe('calc(40 * 17px)');
  });

  it('切宋体自动进入推荐组合 18 / 2.05，并持久化到 localStorage', () => {
    useAppearanceSettings.getState().setFont('serif');

    expect(useAppearanceSettings.getState().font).toBe('serif');
    expect(useAppearanceSettings.getState().size).toBe(18);
    expect(lineHeightFor('serif')).toBe(2.05);
    expect(proseMaxWidth(18)).toBe('calc(40 * 18px)');

    const stored = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}');
    expect(stored.state).toMatchObject({ font: 'serif', size: 18 });
  });

  it('字号限制在 16–22；恢复默认', () => {
    useAppearanceSettings.getState().setSize(30);
    expect(useAppearanceSettings.getState().size).toBe(22);
    useAppearanceSettings.getState().setSize(10);
    expect(useAppearanceSettings.getState().size).toBe(16);
    useAppearanceSettings.getState().setFont('serif');
    useAppearanceSettings.getState().reset();
    expect(useAppearanceSettings.getState()).toMatchObject({ font: 'sans', size: 17 });
    expect(clampProseSize(17)).toBe(17);
  });
});
