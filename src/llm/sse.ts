/**
 * Server-Sent Events 解析。
 *
 * 单独成模块是因为它是整条流式链路里最容易出错、也最值得单测的一环：
 * 网络分块与事件边界毫无关系，一个 JSON 对象常常被切成两半，
 * 必须自己维护缓冲区按行切分，不能假设「一个 chunk 就是一个事件」。
 */

/** 从字节流中逐条取出 `data:` 载荷，遇到 [DONE] 即结束 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 事件之间以空行分隔，但服务端实现不一，逐行处理更稳
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const line = rawLine.replace(/\r$/u, '').trim();
        if (line === '') continue;
        // 注释行（部分服务端用它做心跳保活）
        if (line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice('data:'.length).trim();
        if (payload === '[DONE]') return;
        yield payload;
      }
    }

    // 流结束时缓冲区里可能还剩最后一行（服务端没有以换行收尾）
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice('data:'.length).trim();
      if (payload !== '[DONE]') yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

/** OpenAI 兼容的流式 chunk 结构（只声明用得到的字段） */
export interface ChatStreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      /** DeepSeek 等把思维链单独放这里 */
      reasoning_content?: string | null;
    };
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
 * 解析单条 chunk。
 * 服务端偶尔会插入非 JSON 的保活内容，解析失败时返回 undefined 而不是抛错 ——
 * 因为一条坏 chunk 不应该让整次生成失败。
 */
export function parseChunk(payload: string): ChatStreamChunk | undefined {
  try {
    return JSON.parse(payload) as ChatStreamChunk;
  } catch {
    return undefined;
  }
}
