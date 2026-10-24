import type { ProviderCapabilities } from '@/llm/types';

/** 把若干原始字符串片段包成 ReadableStream，用于模拟网络分块 */
export function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** 构造一个流式 HTTP 响应 */
export function sseResponse(chunks: string[]): Response {
  return new Response(streamFromChunks(chunks), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** 把一串 delta 文本转成标准的 SSE 事件行 */
export function textDeltaEvents(deltas: string[], extra: string[] = []): string[] {
  const events = deltas.map(
    (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
  );
  return [...events, ...extra, 'data: [DONE]\n\n'];
}

/** 非流式 JSON 响应 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 构造一次 chat completion 的响应体 */
export function completion(
  content: string,
  // finishReason 不传时不写 finish_reason 字段，现有用例的响应体逐字不变
  options?: { reasoning?: string; usage?: unknown; finishReason?: string },
) {
  return {
    choices: [
      {
        message: {
          content,
          ...(options?.reasoning ? { reasoning_content: options.reasoning } : {}),
        },
        ...(options?.finishReason ? { finish_reason: options.finishReason } : {}),
      },
    ],
    ...(options?.usage ? { usage: options.usage } : {}),
  };
}

export const DEEPSEEK_CAPS: ProviderCapabilities = {
  jsonSchema: false,
  thinkingToggle: true,
  reasoningEffort: true,
  streamUsage: true,
};

export const STRICT_CAPS: ProviderCapabilities = {
  jsonSchema: true,
  thinkingToggle: false,
  reasoningEffort: false,
  streamUsage: true,
};

export const MINIMAL_CAPS: ProviderCapabilities = {
  jsonSchema: false,
  thinkingToggle: false,
  reasoningEffort: false,
  streamUsage: false,
};

/** 记录请求体的 fetch 替身 */
export function recordingFetch(responses: (Response | (() => Response | Promise<Response>))[]) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  let call = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return typeof next === 'function' ? next() : next!;
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    bodies,
    urls,
    get callCount() {
      return call;
    },
  };
}
