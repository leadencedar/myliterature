import { LlmError, errorFromStatus, errorFromThrown } from './errors';
import { parseChunk, parseSseStream } from './sse';
import type {
  ChatRequest,
  ChatResult,
  LlmClient,
  ProviderCapabilities,
  StreamHandlers,
  TokenUsage,
} from './types';

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
  capabilities: ProviderCapabilities;
  /** 注入 fetch 以便测试；不传则在每次请求时取全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 非流式响应结构（只声明用得到的字段） */
interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/**
 * OpenAI 兼容接口的客户端。
 *
 * 之所以只做一个「兼容」实现而不是为每家写适配器：国内外主流服务商
 * （DeepSeek、Moonshot、智谱、硅基流动、OpenAI 本身）都对齐了这套协议，
 * 差异集中在少数可选参数上，用 capabilities 开关处理足够，
 * 比维护多份近乎重复的适配器更省心。
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly injectedFetch: typeof fetch | undefined;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '');
    this.apiKey = config.apiKey.trim();
    this.capabilities = config.capabilities;
    this.injectedFetch = config.fetchImpl;
  }

  /**
   * 每次请求时解析 fetch，而不是在构造时绑定。
   *
   * 客户端实例会被 useMemo 缓存较长时间，构造时绑定会让它对运行环境的后续变化
   * 完全免疫 —— 这在测试里表现为「替换了全局 fetch 却不生效」，在生产里则意味着
   * 任何对 fetch 的后续包装（埋点、重试代理）都会被绕过。
   */
  private get fetchImpl(): typeof fetch {
    return this.injectedFetch ?? ((...args) => globalThis.fetch(...args));
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const response = await this.post(request, false, signal);
    let body: ChatCompletionResponse;
    try {
      body = (await response.json()) as ChatCompletionResponse;
    } catch (cause) {
      throw new LlmError('parse', '模型返回的内容不是合法 JSON', {
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }

    const message = body.choices?.[0]?.message;
    // 请求不设 n，实际就是 choices[0]；取最后一项是为了和流式「最后一个非空值」语义一致
    const lastChoice = body.choices?.[body.choices.length - 1];
    const result: ChatResult = {
      content: message?.content ?? '',
      reasoning: message?.reasoning_content ?? '',
      finishReason: lastChoice?.finish_reason ?? null,
    };
    const usage = normalizeUsage(body.usage);
    if (usage) result.usage = usage;
    return result;
  }

  async streamChat(
    request: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const response = await this.post(request, true, signal);
    if (!response.body) {
      throw new LlmError('network', '服务端没有返回流式响应体');
    }

    let content = '';
    let reasoning = '';
    let usage: TokenUsage | undefined;
    let finishReason: string | null = null;

    try {
      for await (const payload of parseSseStream(response.body)) {
        const chunk = parseChunk(payload);
        if (!chunk) continue;

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          handlers.onText?.(delta.content);
        }
        if (delta?.reasoning_content) {
          reasoning += delta.reasoning_content;
          handlers.onReasoning?.(delta.reasoning_content);
        }
        // 取流中最后一个非空值：很多服务商最后另发一帧只带 usage、choices 为空，
        // 那一帧不能把前面读到的 'length' 冲成 null
        const chunkFinish = chunk.choices?.[0]?.finish_reason;
        if (chunkFinish) finishReason = chunkFinish;
        // 用量通常只在最后一条 chunk 出现
        const chunkUsage = normalizeUsage(chunk.usage);
        if (chunkUsage) usage = chunkUsage;
      }
    } catch (cause) {
      throw errorFromThrown(cause);
    }

    const result: ChatResult = { content, reasoning, finishReason };
    if (usage) result.usage = usage;
    return result;
  }

  /** 组装并发出请求，统一处理错误响应 */
  private async post(
    request: ChatRequest,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!this.baseUrl) {
      throw new LlmError('config', '还没有配置模型接口地址，请到设置页填写');
    }
    if (!this.apiKey) {
      throw new LlmError('config', '还没有配置 API Key，请到设置页填写');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildBody(request, stream)),
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      throw errorFromThrown(cause);
    }

    if (!response.ok) {
      throw errorFromStatus(response.status, await readErrorDetail(response));
    }
    return response;
  }

  /** 把内部请求模型翻译成 OpenAI 兼容的请求体 */
  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream,
    };

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;

    if (stream && this.capabilities.streamUsage) {
      body.stream_options = { include_usage: true };
    }

    switch (request.responseFormat?.kind) {
      case 'json_object':
        body.response_format = { type: 'json_object' };
        break;
      case 'json_schema':
        if (this.capabilities.jsonSchema) {
          body.response_format = {
            type: 'json_schema',
            json_schema: {
              name: request.responseFormat.name,
              schema: request.responseFormat.schema,
              strict: true,
            },
          };
        } else {
          // 不支持严格模式时降级：仍然要求合法 JSON，
          // schema 约束由调用方内嵌进 prompt，并在客户端用 Zod 兜底校验
          body.response_format = { type: 'json_object' };
        }
        break;
      default:
        break;
    }

    if (this.capabilities.thinkingToggle && request.thinking !== undefined) {
      body.thinking = { type: request.thinking ? 'enabled' : 'disabled' };
      if (this.capabilities.reasoningEffort && request.thinking && request.reasoningEffort) {
        body.reasoning_effort = request.reasoningEffort;
      }
    }

    return body;
  }
}

function normalizeUsage(
  usage: ChatCompletionResponse['usage'] | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const result: TokenUsage = {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
  };
  if (cached !== undefined) result.cachedPromptTokens = cached;
  return result;
}

/** 尽力从错误响应里取出可读信息，失败也不能掩盖原始状态码 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      return parsed.error?.message ?? parsed.message ?? text.slice(0, 500);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return '';
  }
}
