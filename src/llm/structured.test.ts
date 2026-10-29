import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEEPSEEK_CAPS,
  STRICT_CAPS,
  completion,
  jsonResponse,
  recordingFetch,
} from '@/test/llmFixtures';
import type { LlmError } from './errors';
import { OpenAiCompatibleClient } from './OpenAiCompatibleClient';
import { extractJsonText, formatZodIssues, generateStructured } from './structured';
import type { ProviderCapabilities } from './types';

const CharacterSchema = z.object({
  name: z.string().min(1),
  age: z.number().int(),
  traits: z.array(z.string()),
});

function clientWith(
  contents: string[],
  capabilities: ProviderCapabilities = DEEPSEEK_CAPS,
  usages: unknown[] = [],
) {
  const recorder = recordingFetch(
    contents.map((content, index) =>
      jsonResponse(completion(content, usages[index] ? { usage: usages[index] } : undefined)),
    ),
  );
  const client = new OpenAiCompatibleClient({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    capabilities,
    fetchImpl: recorder.fetchImpl,
  });
  return { client, recorder };
}

function run(client: OpenAiCompatibleClient, extra?: Record<string, unknown>) {
  return generateStructured({
    client,
    model: 'deepseek-chat',
    schema: CharacterSchema,
    schemaName: 'Character',
    system: '你是小说设定助手。',
    user: '生成一个人物。',
    ...extra,
  });
}

describe('结构化生成', () => {
  it('一次通过时不重试', async () => {
    const { client, recorder } = clientWith([
      JSON.stringify({ name: '林越', age: 19, traits: ['沉默'] }),
    ]);

    const result = await run(client);

    expect(result.data).toEqual({ name: '林越', age: 19, traits: ['沉默'] });
    expect(result.attempts).toBe(1);
    expect(recorder.callCount).toBe(1);
  });

  it('把 JSON Schema 内嵌进系统提示', async () => {
    const { client, recorder } = clientWith([
      JSON.stringify({ name: '林越', age: 19, traits: [] }),
    ]);

    await run(client);

    const messages = recorder.bodies[0]?.messages as { role: string; content: string }[];
    expect(messages[0]?.role).toBe('system');
    // 对只支持 json_object 的服务商，prompt 里的 schema 是唯一的结构约束来源
    expect(messages[0]?.content).toContain('"traits"');
    expect(messages[0]?.content).toContain('你是小说设定助手。');
  });

  it('字段类型错误时回灌校验错误并重试成功', async () => {
    const { client, recorder } = clientWith([
      // 第一次：age 写成了字符串
      JSON.stringify({ name: '林越', age: '十九', traits: [] }),
      JSON.stringify({ name: '林越', age: 19, traits: [] }),
    ]);

    const result = await run(client);

    expect(result.attempts).toBe(2);
    expect(result.data.age).toBe(19);

    // 第二次请求必须带上上一轮的原始输出和具体错误，否则模型无从改正
    const messages = recorder.bodies[1]?.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(4);
    expect(messages[2]?.role).toBe('assistant');
    expect(messages[3]?.content).toContain('age');
  });

  it('缺字段时同样触发修复', async () => {
    const { client } = clientWith([
      JSON.stringify({ name: '林越' }),
      JSON.stringify({ name: '林越', age: 19, traits: [] }),
    ]);

    expect((await run(client)).attempts).toBe(2);
  });

  it('JSON 语法错误时触发修复', async () => {
    const { client, recorder } = clientWith([
      '{ "name": "林越", age: 19 }',
      JSON.stringify({ name: '林越', age: 19, traits: [] }),
    ]);

    await run(client);

    const messages = recorder.bodies[1]?.messages as { role: string; content: string }[];
    expect(messages[3]?.content).toContain('JSON 语法错误');
  });

  it('重试次数耗尽后抛出 parse 错误并保留细节', async () => {
    const { client, recorder } = clientWith([
      JSON.stringify({ name: '' }),
      JSON.stringify({ name: '' }),
    ]);

    let error: LlmError | undefined;
    try {
      await run(client);
    } catch (cause) {
      error = cause as LlmError;
    }

    expect(error?.kind).toBe('parse');
    expect(error?.detail).toContain('age');
    // 默认重试 1 次，总共 2 次请求
    expect(recorder.callCount).toBe(2);
  });

  it('可以调高修复重试次数', async () => {
    const { client, recorder } = clientWith([
      '不是 JSON',
      '还不是 JSON',
      JSON.stringify({ name: '林越', age: 19, traits: [] }),
    ]);

    const result = await run(client, { maxRepairAttempts: 2 });

    expect(result.attempts).toBe(3);
    expect(recorder.callCount).toBe(3);
  });

  it('回调汇报每次尝试，便于 UI 提示重试中', async () => {
    const { client } = clientWith([
      JSON.stringify({ name: '林越' }),
      JSON.stringify({ name: '林越', age: 19, traits: [] }),
    ]);
    const attempts: { index: number; repairing: boolean }[] = [];

    await run(client, {
      onAttempt: (info: { index: number; repairing: boolean }) => attempts.push(info),
    });

    expect(attempts).toEqual([
      { index: 0, repairing: false },
      { index: 1, repairing: true },
    ]);
  });

  it('累加多次尝试的用量', async () => {
    const { client } = clientWith(
      [JSON.stringify({ name: '林越' }), JSON.stringify({ name: '林越', age: 19, traits: [] })],
      DEEPSEEK_CAPS,
      [
        { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 80 },
        { prompt_tokens: 150, completion_tokens: 12, prompt_cache_hit_tokens: 120 },
      ],
    );

    const result = await run(client);

    expect(result.usage).toEqual({
      promptTokens: 250,
      completionTokens: 22,
      cachedPromptTokens: 200,
    });
  });

  it('支持严格模式的服务商同时收到 json_schema', async () => {
    const { client, recorder } = clientWith(
      [JSON.stringify({ name: '林越', age: 19, traits: [] })],
      STRICT_CAPS,
    );

    await run(client);

    expect(recorder.bodies[0]?.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'Character', strict: true },
    });
  });

  it('带默认值的字段也要求模型输出（io: output）', async () => {
    const WithDefault = z.object({ title: z.string(), tags: z.array(z.string()).default([]) });
    const { client, recorder } = clientWith([JSON.stringify({ title: 'x', tags: [] })]);

    await generateStructured({
      client,
      model: 'deepseek-chat',
      schema: WithDefault,
      schemaName: 'WithDefault',
      system: 'sys',
      user: 'usr',
    });

    const messages = recorder.bodies[0]?.messages as { content: string }[];
    const schemaText = messages[0]!.content;
    // required 必须包含 tags，否则模型会省略字段、让本地默认值掩盖生成缺陷
    expect(schemaText).toMatch(/"required":\s*\[\s*"title",\s*"tags"\s*\]/u);
  });
});

describe('截断处理（failOnTruncation）', () => {
  /** 第一次响应撞上输出上限，第二次是完整的合法结果 */
  function truncatedThenValid() {
    const recorder = recordingFetch([
      jsonResponse(completion('{ "name": "林越", "age": 1', { finishReason: 'length' })),
      jsonResponse(completion(JSON.stringify({ name: '林越', age: 19, traits: [] }))),
    ]);
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      capabilities: DEEPSEEK_CAPS,
      fetchImpl: recorder.fetchImpl,
    });
    return { client, recorder };
  }

  it('开启时截断立即抛 truncated，不进修复重试', async () => {
    const { client, recorder } = truncatedThenValid();

    let error: LlmError | undefined;
    try {
      await run(client, { failOnTruncation: true });
    } catch (cause) {
      error = cause as LlmError;
    }

    expect(error?.kind).toBe('truncated');
    expect(error?.message).toBe('模型输出被截断，检查结果不完整');
    // 修复出来的也只是残缺结果，所以只发一次
    expect(recorder.callCount).toBe(1);
  });

  it('截断的输出即便是合法 JSON 也照样失败', async () => {
    const recorder = recordingFetch([
      jsonResponse(
        completion(JSON.stringify({ name: '林越', age: 19, traits: [] }), {
          finishReason: 'length',
        }),
      ),
    ]);
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      capabilities: DEEPSEEK_CAPS,
      fetchImpl: recorder.fetchImpl,
    });

    await expect(run(client, { failOnTruncation: true })).rejects.toMatchObject({
      kind: 'truncated',
    });
  });

  it('不传时行为不变：截断的 JSON 照旧进修复重试', async () => {
    const { client, recorder } = truncatedThenValid();

    const result = await run(client);

    expect(result.attempts).toBe(2);
    expect(result.data.age).toBe(19);
    expect(recorder.callCount).toBe(2);
  });

  it('开启但正常结束时不受影响', async () => {
    const recorder = recordingFetch([
      jsonResponse(
        completion(JSON.stringify({ name: '林越', age: 19, traits: [] }), { finishReason: 'stop' }),
      ),
    ]);
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      capabilities: DEEPSEEK_CAPS,
      fetchImpl: recorder.fetchImpl,
    });

    expect((await run(client, { failOnTruncation: true })).attempts).toBe(1);
  });
});

describe('JSON 文本抽取', () => {
  it('直接的 JSON 对象', () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });

  it('去掉 Markdown 代码块包裹', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('剥掉前后的客套话', () => {
    expect(extractJsonText('好的，这是结果：\n{"a":1}\n希望有帮助！')).toBe('{"a":1}');
  });

  it('支持顶层数组', () => {
    expect(extractJsonText('[{"a":1}]')).toBe('[{"a":1}]');
  });

  it('没有 JSON 时返回 undefined', () => {
    expect(extractJsonText('抱歉，我无法完成。')).toBeUndefined();
    expect(extractJsonText('   ')).toBeUndefined();
  });
});

describe('校验错误格式化', () => {
  it('列出字段路径与原因', () => {
    const result = z
      .object({ person: z.object({ age: z.number() }) })
      .safeParse({ person: { age: 'x' } });
    expect(result.success).toBe(false);
    if (result.success) return;

    const text = formatZodIssues(result.error);
    expect(text).toContain('person.age');
  });
});
