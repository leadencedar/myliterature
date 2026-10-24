import { z } from 'zod';
import { LlmError } from './errors';
import type { ChatMessage, ChatRequest, LlmClient, TokenUsage } from './types';

export interface StructuredOptions<T> {
  client: LlmClient;
  model: string;
  /** Zod schema，既用于生成 JSON Schema 也用于校验返回值 */
  schema: z.ZodType<T>;
  /** schema 名称，下发严格模式时需要 */
  schemaName: string;
  /**
   * 稳定前缀：系统提示 + 风格档案 + 知识库等在多次请求间不变的内容。
   * 必须放在最前且逐字节稳定，才能命中服务端的 prompt 缓存。
   */
  system: string;
  /** 本次的具体指令，放在最后 */
  user: string;
  temperature?: number;
  thinking?: boolean;
  reasoningEffort?: ChatRequest['reasoningEffort'];
  signal?: AbortSignal;
  /** 校验失败后的修复重试次数，默认 1 */
  maxRepairAttempts?: number;
  /** 观察每次尝试，便于 UI 提示「正在重试」 */
  onAttempt?: (attempt: { index: number; repairing: boolean }) => void;
  /**
   * 响应被输出上限截断时立即失败，而不是进修复重试。默认 false，现有任务行为不变。
   * 用于「结果不完整就等于误导」的任务（按规范检查）：截断的 JSON 就算修复成合法结构，
   * 也只是少了后半截条目的残缺结果，作者会误以为其余部分没问题。
   */
  failOnTruncation?: boolean;
}

export interface StructuredResult<T> {
  data: T;
  /** 总共发出的请求次数，1 表示一次过 */
  attempts: number;
  usage?: TokenUsage;
}

/**
 * 生成并校验结构化数据。
 *
 * 这是整个应用里唯一获取结构化 JSON 的入口，原因是模型输出不可信：
 * DeepSeek 的 json_object 只保证「是合法 JSON」，字段缺失、类型错误、
 * 多套一层壳都很常见。因此这里做三层防护：
 *   1. 把 JSON Schema 内嵌进 prompt（所有 provider 都吃这一套）；
 *   2. 能下发严格模式的 provider 额外下发 response_format；
 *   3. 收到后一律 Zod 校验，失败则把校验错误回灌给模型做修复重试。
 */
export async function generateStructured<T>(
  options: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const {
    client,
    model,
    schema,
    schemaName,
    system,
    user,
    temperature,
    thinking,
    reasoningEffort,
    signal,
    maxRepairAttempts = 1,
    onAttempt,
    failOnTruncation = false,
  } = options;

  const jsonSchema = toJsonSchemaSafely(schema);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(system, jsonSchema) },
    { role: 'user', content: user },
  ];

  let lastError = '';
  let totalUsage: TokenUsage | undefined;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    onAttempt?.({ index: attempt, repairing: attempt > 0 });

    const request: ChatRequest = {
      model,
      messages,
      responseFormat:
        jsonSchema !== undefined
          ? { kind: 'json_schema', name: schemaName, schema: jsonSchema }
          : { kind: 'json_object' },
    };
    if (temperature !== undefined) request.temperature = temperature;
    if (thinking !== undefined) request.thinking = thinking;
    if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort;

    const response = await client.chat(request, signal);
    totalUsage = mergeUsage(totalUsage, response.usage);

    // 在解析之前判断：截断的输出哪怕碰巧是合法 JSON，也是缺了尾部的不完整结果
    if (failOnTruncation && response.finishReason === 'length') {
      throw new LlmError('truncated', '模型输出被截断，检查结果不完整', {
        detail: `finish_reason=length，已收到 ${response.content.length} 个字符`,
      });
    }

    const jsonText = extractJsonText(response.content);
    if (jsonText === undefined) {
      lastError = '返回内容里找不到 JSON 对象。';
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch (cause) {
        lastError = `JSON 语法错误：${cause instanceof Error ? cause.message : String(cause)}`;
        parsed = undefined;
      }

      if (parsed !== undefined) {
        const validated = schema.safeParse(parsed);
        if (validated.success) {
          const result: StructuredResult<T> = { data: validated.data, attempts: attempt + 1 };
          if (totalUsage) result.usage = totalUsage;
          return result;
        }
        lastError = formatZodIssues(validated.error);
      }
    }

    // 把上一轮的原始输出与具体错误一起回灌，比单纯重试的成功率高得多
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content:
        `上面的输出不符合要求：\n${lastError}\n\n` +
        '请仅输出修正后的完整 JSON，不要任何解释、不要 Markdown 代码块标记。',
    });
  }

  throw new LlmError('parse', `模型输出不符合预期格式（已重试 ${maxRepairAttempts} 次）`, {
    detail: lastError,
  });
}

/** 把 Zod schema 转成 JSON Schema；遇到无法表达的类型则放弃下发严格模式 */
function toJsonSchemaSafely(schema: z.ZodType<unknown>): unknown | undefined {
  try {
    // io: 'output' 会把带默认值的字段也列入 required，
    // 这正是我们要的：模型必须把每个字段都写出来，而不是依赖本地补默认值
    return z.toJSONSchema(schema, { io: 'output' });
  } catch {
    return undefined;
  }
}

function buildSystemPrompt(system: string, jsonSchema: unknown): string {
  const schemaBlock =
    jsonSchema === undefined
      ? ''
      : `\n\n【输出格式】\n必须输出**单个 JSON 对象**，严格符合下面的 JSON Schema：\n${JSON.stringify(
          jsonSchema,
          null,
          2,
        )}\n不要输出 Markdown 代码块标记，不要输出任何解释文字。`;
  return `${system}${schemaBlock}`;
}

/**
 * 从模型输出里提取 JSON 文本。
 * 即便要求了「只输出 JSON」，模型仍可能包上代码块或加一句客套话，
 * 这里做一次宽容的抽取，避免因为这种小事触发重试浪费 token。
 */
export function extractJsonText(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  // 去掉 ```json ... ``` 包裹
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();

  if (body.startsWith('{') || body.startsWith('[')) return body;

  // 前后混了说明文字：截取最外层的花括号或方括号
  const firstBrace = body.indexOf('{');
  const firstBracket = body.indexOf('[');
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (start === -1) return undefined;

  const closing = body[start] === '{' ? '}' : ']';
  const end = body.lastIndexOf(closing);
  if (end <= start) return undefined;
  return body.slice(start, end + 1);
}

/** 把 Zod 校验错误整理成模型能理解的清单 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(根对象)';
      return `- 字段 \`${path}\`：${issue.message}`;
    })
    .join('\n');
}

function mergeUsage(
  accumulated: TokenUsage | undefined,
  incoming: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!incoming) return accumulated;
  if (!accumulated) return incoming;
  const merged: TokenUsage = {
    promptTokens: accumulated.promptTokens + incoming.promptTokens,
    completionTokens: accumulated.completionTokens + incoming.completionTokens,
  };
  const cached = (accumulated.cachedPromptTokens ?? 0) + (incoming.cachedPromptTokens ?? 0);
  if (cached > 0) merged.cachedPromptTokens = cached;
  return merged;
}
