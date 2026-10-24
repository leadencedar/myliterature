import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StepTailSchema, type StepTail } from '@/features/scenario/stepSchema';
import { DEEPSEEK_CAPS } from '@/test/llmFixtures';
import { LlmError } from './errors';
import {
  PROSE_TAIL_SENTINEL,
  generateProseWithTail,
  splitProseAndTail,
  visibleProse,
} from './proseTail';
import type { ChatRequest, LlmClient } from './types';

const S = PROSE_TAIL_SENTINEL;

const Simple = z.object({ mood: z.string().min(1), count: z.number().int() });

interface Call {
  kind: 'stream' | 'chat';
  request: ChatRequest;
}

/** 首轮流式按 chunks 逐块回调；之后的修复请求按 chats 顺序返回 */
function stubClient(
  stream: { chunks: string[]; finishReason?: string | null },
  chats: { content: string; finishReason?: string | null }[] = [],
) {
  const calls: Call[] = [];
  let next = 0;
  const client: LlmClient = {
    capabilities: DEEPSEEK_CAPS,
    async streamChat(request, handlers) {
      calls.push({ kind: 'stream', request: structuredClone(request) });
      for (const chunk of stream.chunks) handlers.onText?.(chunk);
      return {
        content: stream.chunks.join(''),
        reasoning: '',
        finishReason: stream.finishReason ?? 'stop',
      };
    },
    async chat(request) {
      calls.push({ kind: 'chat', request: structuredClone(request) });
      const reply = chats[next];
      next += 1;
      if (!reply) throw new Error('没有预期的修复请求');
      return { content: reply.content, reasoning: '', finishReason: reply.finishReason ?? 'stop' };
    },
  };
  return { client, calls };
}

function run<T>(client: LlmClient, schema: z.ZodType<T>, onProse?: (text: string) => void) {
  return generateProseWithTail({
    client,
    model: 'm',
    schema,
    schemaName: 'test',
    system: '系统前缀',
    user: '用户指令',
    temperature: 0.85,
    thinking: false,
    ...(onProse ? { onProse } : {}),
  });
}

const GOOD_JSON = '{"mood":"冷","count":2}';

describe('visibleProse', () => {
  it('有完整分隔符时截到第一个之前', () => {
    expect(visibleProse(`雾很大。\n${S}\n{"a":1}`)).toBe('雾很大。\n');
  });

  it('去掉末尾可能是分隔符开头的最长后缀', () => {
    expect(visibleProse('雾很大@')).toBe('雾很大');
    expect(visibleProse('雾很大@@@STA')).toBe('雾很大');
    expect(visibleProse(`雾很大${S.slice(0, -1)}`)).toBe('雾很大');
  });

  it('正文里单个 @ 后面不是分隔符时照常显示', () => {
    expect(visibleProse('写信到 a@b.com')).toBe('写信到 a@b.com');
    expect(visibleProse('写信到 a@b')).toBe('写信到 a@b');
  });
});

describe('splitProseAndTail', () => {
  it('按最后一个分隔符切开并去掉首尾空白', () => {
    expect(splitProseAndTail(`雾很大。\n${S}\n${GOOD_JSON}\n`)).toEqual({
      prose: '雾很大。',
      tail: GOOD_JSON,
    });
    expect(splitProseAndTail(`甲${S}乙\n${S}${GOOD_JSON}`)).toEqual({
      prose: `甲${S}乙`,
      tail: GOOD_JSON,
    });
  });

  it('没有分隔符时整段都是正文、tail 为 undefined', () => {
    expect(splitProseAndTail('雾很大。')).toEqual({ prose: '雾很大。', tail: undefined });
  });
});

describe('generateProseWithTail', () => {
  it('分块流式：onProse 收到累计正文，从不包含分隔符前缀及之后的内容', async () => {
    const seen: string[] = [];
    const { client } = stubClient({
      chunks: ['雾很大', '。船夫不见了。\n@', '@@STATE', `@@@\n${GOOD_JSON}`],
    });
    const result = await run(client, Simple, (text) => seen.push(text));
    expect(seen.length).toBeGreaterThan(0);
    for (const text of seen) expect(text).not.toContain('@');
    expect(seen[0]).toBe('雾很大');
    expect(seen[seen.length - 1]).toBe('雾很大。船夫不见了。\n');
    expect(result.prose).toBe('雾很大。船夫不见了。');
    expect(result.data).toEqual({ mood: '冷', count: 2 });
  });

  it('分隔符被切在两个分块中间时，任何一次回调都不含 @', async () => {
    const seen: string[] = [];
    const { client } = stubClient({ chunks: ['…雾@@', `@STATE@@@${GOOD_JSON}`] });
    const result = await run(client, Simple, (text) => seen.push(text));
    expect(seen).toEqual(['…雾']);
    expect(result.prose).toBe('…雾');
  });

  it('正文含单个 @（如邮箱）且后面不是分隔符时，完成后照常显示', async () => {
    const seen: string[] = [];
    const { client } = stubClient({ chunks: ['写信到 a@', `b.com 吧。\n${S}\n${GOOD_JSON}`] });
    const result = await run(client, Simple, (text) => seen.push(text));
    expect(seen[0]).toBe('写信到 a');
    expect(seen[seen.length - 1]).toBe('写信到 a@b.com 吧。\n');
    expect(result.prose).toBe('写信到 a@b.com 吧。');
  });

  it('正常切分：一次请求、流式、不设 responseFormat，system 末尾追加【输出格式】与 JSON Schema', async () => {
    const { client, calls } = stubClient({ chunks: [`雾很大。\n${S}\n${GOOD_JSON}`] });
    const result = await run(client, Simple);
    expect(result).toMatchObject({
      prose: '雾很大。',
      data: { mood: '冷', count: 2 },
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
    const request = calls[0]!.request;
    expect(calls[0]!.kind).toBe('stream');
    expect(request.responseFormat).toBeUndefined();
    expect(request.temperature).toBe(0.85);
    expect(request.thinking).toBe(false);
    const system = request.messages[0]!.content;
    expect(system.startsWith('系统前缀\n\n【输出格式】')).toBe(true);
    expect(system).toContain(`\n${S}\n`);
    expect(system).toContain(JSON.stringify(z.toJSONSchema(Simple, { io: 'output' }), null, 2));
    expect(request.messages[1]).toEqual({ role: 'user', content: '用户指令' });
  });

  it('缺分隔符 → 非流式 json_object 修复请求 → 成功，正文用首轮的', async () => {
    const { client, calls } = stubClient({ chunks: ['雾很大。船夫不见了。'] }, [
      { content: GOOD_JSON },
    ]);
    const result = await run(client, Simple);
    expect(result.prose).toBe('雾很大。船夫不见了。');
    expect(result.data).toEqual({ mood: '冷', count: 2 });
    expect(result.attempts).toBe(2);
    expect(calls.map((call) => call.kind)).toEqual(['stream', 'chat']);
    const repair = calls[1]!.request;
    expect(repair.responseFormat).toEqual({ kind: 'json_object' });
    expect(repair.messages).toHaveLength(4);
    expect(repair.messages[0]).toEqual(calls[0]!.request.messages[0]);
    expect(repair.messages[2]).toEqual({ role: 'assistant', content: '雾很大。船夫不见了。' });
    expect(repair.messages[3]!.content).toContain('上面分隔符之后的结构化数据不符合要求');
    expect(repair.messages[3]!.content).toContain(
      '请只输出修正后的完整 JSON，不要正文、不要分隔符',
    );
  });

  it('JSON 不合 schema → 修复成功', async () => {
    const { client, calls } = stubClient({ chunks: [`雾很大。\n${S}\n{"mood":"","count":1.5}`] }, [
      { content: '```json\n{"mood":"冷","count":1}\n```' },
    ]);
    const result = await run(client, Simple);
    expect(result).toMatchObject({
      prose: '雾很大。',
      data: { mood: '冷', count: 1 },
      attempts: 2,
    });
    expect(calls[1]!.request.messages[3]!.content).toContain('mood');
  });

  it('修复后仍不合 schema → 抛 parse', async () => {
    const { client, calls } = stubClient({ chunks: [`雾很大。\n${S}\n{"mood":""}`] }, [
      { content: '{"mood":""}' },
    ]);
    const error = await run(client, Simple).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe('parse');
    expect((error as LlmError).message).toBe('模型输出不符合预期格式（已重试 1 次）');
    expect((error as LlmError).detail).toContain('mood');
    expect(calls).toHaveLength(2);
  });

  it('首轮 finishReason=length → 抛 truncated，只发 1 次请求', async () => {
    const { client, calls } = stubClient({ chunks: ['雾很大，船夫'], finishReason: 'length' });
    const error = await run(client, Simple).catch((cause: unknown) => cause);
    expect((error as LlmError).kind).toBe('truncated');
    expect((error as LlmError).message).toBe('这一步写得太长被截断了，没有保存');
    expect(calls).toHaveLength(1);
  });

  it('修复轮被截断同样抛 truncated', async () => {
    const { client, calls } = stubClient({ chunks: [`雾很大。\n${S}\n{"mood":`] }, [
      { content: '{"mood":"冷","co', finishReason: 'length' },
    ]);
    const error = await run(client, Simple).catch((cause: unknown) => cause);
    expect((error as LlmError).kind).toBe('truncated');
    expect(calls).toHaveLength(2);
  });

  it('正文为空 → 抛 parse，不发修复请求', async () => {
    const { client, calls } = stubClient({ chunks: [`  \n${S}\n${GOOD_JSON}`] });
    const error = await run(client, Simple).catch((cause: unknown) => cause);
    expect((error as LlmError).kind).toBe('parse');
    expect((error as LlmError).message).toBe('模型没有写出情节');
    expect(calls).toHaveLength(1);
  });

  it('取消：底层的 aborted 原样上抛', async () => {
    const client: LlmClient = {
      capabilities: DEEPSEEK_CAPS,
      async streamChat() {
        throw new LlmError('aborted', '已取消');
      },
      async chat() {
        throw new Error('不应发出修复请求');
      },
    };
    const error = await run(client, Simple).catch((cause: unknown) => cause);
    expect((error as LlmError).kind).toBe('aborted');
  });

  describe('步骤 schema：没有结局时选项数不在 2–4 → 校验失败 → 修复（验收 19）', () => {
    const base: StepTail = {
      challenge: '船在下沉',
      options: [],
      changes: {
        fieldChanges: [],
        newEntries: [],
        statusChanges: [],
        ocChanges: [],
        events: [],
        flags: [],
      },
      progress: { reachedMilestones: [], note: '' },
      ending: null,
    };
    const option = (text: string) => ({
      text,
      tendency: 'cautious' as const,
      risk: 'low' as const,
    });
    const fixed = { ...base, options: [option('拔刀'), option('跳江')] };

    for (const count of [1, 5]) {
      it(`${count} 个选项`, async () => {
        const bad = {
          ...base,
          options: Array.from({ length: count }, (_, i) => option(`行动${i + 1}`)),
        };
        const { client, calls } = stubClient(
          { chunks: [`雾很大。\n${S}\n${JSON.stringify(bad)}`] },
          [{ content: JSON.stringify(fixed) }],
        );
        const result = await run(client, StepTailSchema);
        expect(calls).toHaveLength(2);
        expect(calls[1]!.request.messages[3]!.content).toContain('options');
        expect(result.data.options).toHaveLength(2);
        expect(result.prose).toBe('雾很大。');
      });
    }
  });
});
