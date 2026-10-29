import type { ProviderCapabilities } from './types';

export type ProviderPresetId = 'deepseek' | 'openai' | 'custom';

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  baseUrl: string;
  /** 常规任务用的模型 */
  model: string;
  /** 重要任务（立项、大纲）可切换的更强模型 */
  strongModel: string;
  capabilities: ProviderCapabilities;
  /** 申请 Key 的入口，展示给用户 */
  consoleUrl?: string;
  note?: string;
}

/**
 * 服务商预置。
 *
 * capabilities 是手工声明而非探测得来：一次探测要额外花钱和时间，
 * 而这些能力在服务商层面是稳定事实。自定义端点默认取最保守的能力集，
 * 宁可退化成 prompt 内嵌 schema，也不要因为下发了不被支持的参数而整体失败。
 */
export const PROVIDER_PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    strongModel: 'deepseek-chat',
    capabilities: {
      // DeepSeek 只提供 json_object：保证合法 JSON，不保证贴合 schema
      jsonSchema: false,
      thinkingToggle: true,
      reasoningEffort: true,
      streamUsage: true,
    },
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    note: '默认模型 deepseek-chat（可手动改成更强的模型）。中文写作性价比高，低峰时段（北京时间 00:30–08:30）价格减半。',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    strongModel: 'gpt-4o',
    capabilities: {
      jsonSchema: true,
      thinkingToggle: false,
      reasoningEffort: false,
      streamUsage: true,
    },
    consoleUrl: 'https://platform.openai.com/api-keys',
  },
  custom: {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    strongModel: '',
    capabilities: {
      // 未知端点取最保守能力集：宁可退化成 prompt 内嵌 schema，
      // 也不要因为下发了不被支持的参数而整次请求失败
      jsonSchema: false,
      thinkingToggle: false,
      reasoningEffort: false,
      streamUsage: false,
    },
    note: '自建或第三方中转端点需要同时登记到应用的连接白名单（vite.config.ts）才能访问。',
  },
};

export const DEFAULT_PRESET_ID: ProviderPresetId = 'deepseek';
