import { describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_CAPS,
  MINIMAL_CAPS,
  STRICT_CAPS,
  completion,
  jsonResponse,
  recordingFetch,
  sseResponse,
  textDeltaEvents,
} from '@/test/llmFixtures';
import { LlmError } from './errors';
import { OpenAiCompatibleClient } from './OpenAiCompatibleClient';
import type { ChatRequest, ProviderCapabilities } from './types';

function makeClient(
  responses: (Response | (() => Response | Promise<Response>))[],
  capabilities: ProviderCapabilities = DEEPSEEK_CAPS,
  overrides?: { baseUrl?: string; apiKey?: string },
) {
  const recorder = recordingFetch(responses);
  const client = new OpenAiCompatibleClient({
    baseUrl: overrides?.baseUrl ?? 'https://api.deepseek.com',
    apiKey: overrides?.apiKey ?? 'sk-test',
    capabilities,
    fetchImpl: recorder.fetchImpl,
  });
  return { client, recorder };
}

const BASIC: ChatRequest = {
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: '你好' }],
};

/** 捕获预期中的异常，并把类型收窄到 LlmError */
async function captureError(action: () => Promise<unknown>): Promise<LlmError> {
  try {
    await action();
  } catch (cause) {
    return cause as LlmError;
  }
  throw new Error('预期抛出异常，但调用成功了');
}

describe('请求组装', () => {
  it('拼出正确的端点并带上鉴权头', async () => {
    const recorder = recordingFetch([jsonResponse(completion('嗯'))]);
    const fetchSpy = vi.fn(recorder.fetchImpl);
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.deepseek.com/',
      apiKey: '  sk-test  ',
      capabilities: DEEPSEEK_CAPS,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    await client.chat(BASIC);

    const [url, init] = fetchSpy.mock.calls[0]!;
    // baseUrl 末尾多余的斜杠要吃掉，否则会请求到 //chat/completions
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    });
  });

  it('支持 thinking 的服务商会下发 thinking 与 reasoning_effort', async () => {
    const { client, recorder } = makeClient([jsonResponse(completion('{}'))]);

    await client.chat({ ...BASIC, thinking: true, reasoningEffort: 'high' });

    expect(recorder.bodies[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('关闭 thinking 时显式下发 disabled', async () => {
    const { client, recorder } = makeClient([jsonResponse(completion('x'))]);

    await client.chat({ ...BASIC, thinking: false, reasoningEffort: 'high' });

    expect(recorder.bodies[0]).toMatchObject({ thinking: { type: 'disabled' } });
    // 关闭思维链时不该再带 effort
    expect(recorder.bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('不支持 thinking 的服务商完全不下发该参数', async () => {
    const { client, recorder } = makeClient([jsonResponse(completion('x'))], STRICT_CAPS);

    await client.chat({ ...BASIC, thinking: true, reasoningEffort: 'high' });

    expect(recorder.bodies[0]).not.toHaveProperty('thinking');
    expect(recorder.bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('支持严格模式时下发 json_schema', async () => {
    const { client, recorder } = makeClient([jsonResponse(completion('{}'))], STRICT_CAPS);

    await client.chat({
      ...BASIC,
      responseFormat: { kind: 'json_schema', name: 'Demo', schema: { type: 'object' } },
    });

    expect(recorder.bodies[0]).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'Demo', strict: true, schema: { type: 'object' } },
      },
    });
  });

  it('不支持严格模式时降级为 json_object', async () => {
    const { client, recorder } = makeClient([jsonResponse(completion('{}'))], DEEPSEEK_CAPS);

    await client.chat({
      ...BASIC,
      responseFormat: { kind: 'json_schema', name: 'Demo', schema: { type: 'object' } },
    });

    // DeepSeek 只认 json_object，下发 json_schema 会被拒
    expect(recorder.bodies[0]?.response_format).toEqual({ type: 'json_object' });
  });

  it('流式请求按能力决定是否索要用量', async () => {
    const withUsage = makeClient([sseResponse(textDeltaEvents(['a']))], DEEPSEEK_CAPS);
    await withUsage.client.streamChat({ ...BASIC }, {});
    expect(withUsage.recorder.bodies[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });

    const without = makeClient([sseResponse(textDeltaEvents(['a']))], MINIMAL_CAPS);
    await without.client.streamChat({ ...BASIC }, {});
    expect(without.recorder.bodies[0]).not.toHaveProperty('stream_options');
  });
});

describe('非流式响应', () => {
  it('取出正文、思维链与用量（含缓存命中数）', async () => {
    const { client } = makeClient([
      jsonResponse(
        completion('正文内容', {
          reasoning: '我先想一下',
          usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100 },
        }),
      ),
    ]);

    const result = await client.chat(BASIC);

    expect(result.content).toBe('正文内容');
    expect(result.reasoning).toBe('我先想一下');
    // 缓存命中数是验证 prompt 稳定前缀策略是否奏效的关键指标
    expect(result.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      cachedPromptTokens: 100,
    });
  });

  it('兼容 OpenAI 风格的 cached_tokens 字段', async () => {
    const { client } = makeClient([
      jsonResponse(
        completion('x', {
          usage: {
            prompt_tokens: 50,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
      ),
    ]);

    expect((await client.chat(BASIC)).usage?.cachedPromptTokens).toBe(40);
  });

  it('缺字段时给出空值而不是崩溃', async () => {
    const { client } = makeClient([jsonResponse({})]);
    const result = await client.chat(BASIC);
    expect(result).toEqual({ content: '', reasoning: '', finishReason: null });
  });

  it('取 choices 最后一项的 finish_reason，缺失时为 null', async () => {
    const { client } = makeClient([
      jsonResponse({
        choices: [
          { message: { content: '前' }, finish_reason: 'stop' },
          { message: { content: '后' }, finish_reason: 'length' },
        ],
      }),
      jsonResponse(completion('x')),
    ]);

    expect((await client.chat(BASIC)).finishReason).toBe('length');
    expect((await client.chat(BASIC)).finishReason).toBeNull();
  });

  it('响应不是 JSON 时报 parse 错误', async () => {
    const { client } = makeClient([new Response('<html>502</html>', { status: 200 })]);
    await expect(client.chat(BASIC)).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('流式响应', () => {
  it('逐段回调并累积完整正文', async () => {
    const { client } = makeClient([sseResponse(textDeltaEvents(['春风', '不度', '玉门关']))]);
    const seen: string[] = [];

    const result = await client.streamChat(BASIC, { onText: (delta) => seen.push(delta) });

    expect(seen).toEqual(['春风', '不度', '玉门关']);
    expect(result.content).toBe('春风不度玉门关');
  });

  it('思维链单独回调，不混进正文', async () => {
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '再写' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { client } = makeClient([sseResponse(events)]);
    const reasoning: string[] = [];

    const result = await client.streamChat(BASIC, {
      onReasoning: (delta) => reasoning.push(delta),
    });

    expect(reasoning).toEqual(['先想']);
    expect(result.content).toBe('再写');
    expect(result.reasoning).toBe('先想');
  });

  it('从最后一条 chunk 取用量', async () => {
    const usageEvent = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })}\n\n`;
    const { client } = makeClient([sseResponse(textDeltaEvents(['x'], [usageEvent]))]);

    const result = await client.streamChat(BASIC, {});

    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it('带 choice 的最后一帧是 length、其后只带 usage 的帧不会把它冲掉', async () => {
    const lengthEvent = `data: ${JSON.stringify({
      choices: [{ delta: { content: '尾' }, finish_reason: 'length' }],
    })}\n\n`;
    const usageEvent = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })}\n\n`;
    const { client } = makeClient([
      sseResponse(textDeltaEvents(['半截'], [lengthEvent, usageEvent])),
    ]);

    const result = await client.streamChat(BASIC, {});

    expect(result.content).toBe('半截尾');
    expect(result.finishReason).toBe('length');
  });

  it('正常结束时 finishReason 为 stop', async () => {
    const stopEvent = `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    })}\n\n`;
    const { client } = makeClient([sseResponse(textDeltaEvents(['x'], [stopEvent]))]);

    expect((await client.streamChat(BASIC, {})).finishReason).toBe('stop');
  });

  it('整条流都不带 finish_reason 时为 null', async () => {
    const { client } = makeClient([sseResponse(textDeltaEvents(['x']))]);

    expect((await client.streamChat(BASIC, {})).finishReason).toBeNull();
  });

  it('没有响应体时报错', async () => {
    const { client } = makeClient([new Response(null, { status: 200 })]);
    await expect(client.streamChat(BASIC, {})).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('错误映射', () => {
  it.each([
    [400, 'bad-request'],
    [401, 'auth'],
    [402, 'insufficient-balance'],
    [422, 'bad-request'],
    [429, 'rate-limit'],
    [500, 'server'],
    [503, 'server'],
  ])('HTTP %i 映射为 %s', async (status, kind) => {
    const { client } = makeClient([jsonResponse({ error: { message: '服务端说明' } }, status)]);

    await expect(client.chat(BASIC)).rejects.toMatchObject({ kind, status });
  });

  it('保留服务端的错误说明供排查', async () => {
    const { client } = makeClient([jsonResponse({ error: { message: '模型不存在' } }, 400)]);

    await expect(client.chat(BASIC)).rejects.toMatchObject({ detail: '模型不存在' });
  });

  it('网络异常归类为 network 并提示白名单', async () => {
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      capabilities: DEEPSEEK_CAPS,
      fetchImpl: (() =>
        Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
    });

    const error = await captureError(() => client.chat(BASIC));
    expect(error).toBeInstanceOf(LlmError);
    expect(error.kind).toBe('network');
    expect(error.message).toContain('白名单');
  });

  it('用户取消时归类为 aborted', async () => {
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      capabilities: DEEPSEEK_CAPS,
      fetchImpl: (() =>
        Promise.reject(new DOMException('Aborted', 'AbortError'))) as unknown as typeof fetch,
    });

    await expect(client.chat(BASIC)).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('把 AbortSignal 透传给 fetch', async () => {
    const recorder = recordingFetch([jsonResponse(completion('x'))]);
    const fetchSpy = vi.fn(recorder.fetchImpl);
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      capabilities: DEEPSEEK_CAPS,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const controller = new AbortController();

    await client.chat(BASIC, controller.signal);

    expect((fetchSpy.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
  });

  it.each([
    ['缺少接口地址', { baseUrl: '' }],
    ['缺少 API Key', { apiKey: '   ' }],
  ])('%s 时直接报配置错误，不发请求', async (_name, overrides) => {
    const recorder = recordingFetch([jsonResponse(completion('x'))]);
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      capabilities: DEEPSEEK_CAPS,
      fetchImpl: recorder.fetchImpl,
      ...overrides,
    });

    await expect(client.chat(BASIC)).rejects.toMatchObject({ kind: 'config' });
    expect(recorder.callCount).toBe(0);
  });
});
