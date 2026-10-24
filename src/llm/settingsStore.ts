import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_PRESET_ID, PROVIDER_PRESETS, type ProviderPresetId } from './presets';
import type { ProviderCapabilities } from './types';

export interface LlmSettings {
  presetId: ProviderPresetId;
  baseUrl: string;
  apiKey: string;
  /** 常规任务模型 */
  model: string;
  /** 重要任务（立项、大纲）使用的更强模型；留空则复用 model */
  strongModel: string;
  capabilities: ProviderCapabilities;
}

interface LlmSettingsState extends LlmSettings {
  /** 切换预置服务商，同时重置接口地址、模型与能力位 */
  applyPreset: (presetId: ProviderPresetId) => void;
  update: (patch: Partial<LlmSettings>) => void;
  setCapability: (key: keyof ProviderCapabilities, value: boolean) => void;
  clearApiKey: () => void;
}

function presetDefaults(presetId: ProviderPresetId): LlmSettings {
  const preset = PROVIDER_PRESETS[presetId];
  return {
    presetId,
    baseUrl: preset.baseUrl,
    apiKey: '',
    model: preset.model,
    strongModel: preset.strongModel,
    capabilities: { ...preset.capabilities },
  };
}

/**
 * 模型配置。
 *
 * **刻意不放进 IndexedDB，而是单独存 localStorage**：
 * 备份导出走的是 IndexedDB 全量导出，密钥从物理上就不会出现在备份文件里，
 * 比「导出时记得过滤掉」这种依赖自觉的做法可靠。
 *
 * 安全边界要说清楚：密钥存在浏览器本地，同源脚本可读。应用因此不引入任何
 * 第三方脚本，并用 CSP 把出站连接限制在已登记的模型服务商域名内。
 */
export const useLlmSettings = create<LlmSettingsState>()(
  persist(
    (set, get) => ({
      ...presetDefaults(DEFAULT_PRESET_ID),

      applyPreset: (presetId) => {
        // 换服务商时保留已填的 Key 没有意义（Key 不通用），一并清空更安全
        set({ ...presetDefaults(presetId) });
      },

      update: (patch) => set({ ...patch }),

      setCapability: (key, value) => set({ capabilities: { ...get().capabilities, [key]: value } }),

      clearApiKey: () => set({ apiKey: '' }),
    }),
    { name: 'myliterature.llm-settings' },
  ),
);

/** 是否已具备发起请求的最低配置 */
export function isLlmConfigured(
  settings: Pick<LlmSettings, 'baseUrl' | 'apiKey' | 'model'>,
): boolean {
  return (
    settings.baseUrl.trim().length > 0 &&
    settings.apiKey.trim().length > 0 &&
    settings.model.trim().length > 0
  );
}
