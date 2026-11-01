/** LLM 适配层的公共类型 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** 结构化输出的下发方式 */
export type ResponseFormat =
  | { kind: 'text' }
  /** 只保证合法 JSON，不保证贴合 schema（DeepSeek 的能力上限） */
  | { kind: 'json_object' }
  /** 严格模式：服务端保证贴合 schema（OpenAI 等支持） */
  | { kind: 'json_schema'; name: string; schema: unknown };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  /** 是否开启思维链。仅在 provider 支持开关时下发 */
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
}

export interface ChatResult {
  content: string;
  /** 思维链内容（若 provider 回传），仅用于调试展示，不参与后续处理 */
  reasoning: string;
  /** 用量统计，provider 未回传时为 undefined */
  usage?: TokenUsage;
  /** 服务商回传的结束原因，'length' 表示撞上了输出上限；不回传时为 null */
  finishReason: string | null;
  /**
   * 流是否收到了明确的结束信号（`[DONE]` 或 finish_reason）。
   *
   * 'unknown' 表示服务商两者都没给：不能据此判定失败（不少兼容服务商不回传），
   * 但也不能当成完整结束 —— 上层可以自行决定是否提示「无法确认是否写完」。
   * 非流式（chat）也有该字段，便于消费方统一判断。
   */
  endReason?: 'done' | 'unknown';
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 命中 prompt 缓存的输入 token 数。DeepSeek 会回传，用于验证缓存策略是否生效 */
  cachedPromptTokens?: number;
}

export interface StreamHandlers {
  /** 正文增量 */
  onText?: (delta: string) => void;
  /** 思维链增量 */
  onReasoning?: (delta: string) => void;
}

/** provider 能力声明。不同服务商差异很大，用显式能力位而不是靠 baseUrl 猜 */
export interface ProviderCapabilities {
  /** 支持 response_format: json_schema 严格模式 */
  jsonSchema: boolean;
  /** 支持 thinking 开关 */
  thinkingToggle: boolean;
  /** 支持 reasoning_effort */
  reasoningEffort: boolean;
  /** 支持 stream_options.include_usage（流式结束时回传用量） */
  streamUsage: boolean;
}

export interface LlmClient {
  /** 一次性返回。结构化输出走这条，不需要流式 */
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  /** 流式返回，正文边生成边回调；返回完整结果 */
  streamChat(
    request: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
  readonly capabilities: ProviderCapabilities;
}
