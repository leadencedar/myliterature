import { z } from 'zod';
import { LlmError } from './errors';
import { extractJsonText, formatZodIssues } from './structured';
import type { ChatMessage, ChatRequest, LlmClient, ReasoningEffort, TokenUsage } from './types';

/**
 * 流式正文 + 结构化尾部：一次流式调用，正文在前、JSON 在后，中间单独一行分隔符。
 *
 * 为什么不是两次调用（先流式写正文，再结构化提取）：第二次要把正文再作为输入付一次钱、
 * 多一次往返，而且变化是「写完之后再猜」，不如写的时候一并给出可靠。
 * 为什么不是整体 JSON 再流式解析 plot 字段：半截 JSON 的转义与换行处理脆弱，
 * DeepSeek 的 json_object 模式还要求整体是 JSON，不利于正文质量。
 */
export const PROSE_TAIL_SENTINEL = '@@@STATE@@@';

export interface ProseTailOptions<T> {
  client: LlmClient;
  model: string;
  /** 尾部 JSON 的 Zod schema，既用于生成 JSON Schema 也用于校验 */
  schema: z.ZodType<T>;
  schemaName: string;
  /** 稳定前缀，必须逐字节可复现；【输出格式】块由这里追加在末尾 */
  system: string;
  user: string;
  temperature?: number;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /** 只回调分隔符之前的正文（累计值，不是增量），流式显示用 */
  onProse?: (proseSoFar: string) => void;
  /** 尾部校验失败后的修复重试次数，默认 1 */
  maxRepairAttempts?: number;
}

export interface ProseTailResult<T> {
  prose: string;
  data: T;
  /** 总共发出的请求次数，1 表示一次过 */
  attempts: number;
  usage?: TokenUsage;
}

/**
 * 流式显示用的正文：有完整分隔符时截到第一个之前；没有时去掉末尾「可能是分隔符开头」的最长后缀
 * （如结尾的 `@`、`@@@STA`），避免分块边界处把分隔符的前半截闪出来。
 * 与 splitProseAndTail 一样只认完整分隔符，口径一致
 */
export function visibleProse(text: string): string {
  const at = text.indexOf(PROSE_TAIL_SENTINEL);
  if (at >= 0) return text.slice(0, at);
  const longest = Math.min(PROSE_TAIL_SENTINEL.length - 1, text.length);
  for (let length = longest; length > 0; length -= 1) {
    if (text.endsWith(PROSE_TAIL_SENTINEL.slice(0, length)))
      return text.slice(0, text.length - length);
  }
  return text;
}

/**
 * 按**最后一个**完整分隔符切开：正文里万一出现分隔符原文，也不会把正文的后半截当成 JSON。
 * 找不到分隔符时 tail 为 undefined、整段都算正文（交给修复重试补出 JSON）
 */
export function splitProseAndTail(content: string): { prose: string; tail: string | undefined } {
  const at = content.lastIndexOf(PROSE_TAIL_SENTINEL);
  if (at < 0) return { prose: content.trim(), tail: undefined };
  return {
    prose: content.slice(0, at).trim(),
    tail: content.slice(at + PROSE_TAIL_SENTINEL.length).trim(),
  };
}

const TRUNCATED_MESSAGE = '这一步写得太长被截断了，没有保存';

function buildSystemPrompt(system: string, jsonSchema: unknown): string {
  const block = [
    '【输出格式】',
    '先写正文：纯文本，不要标题，不要 Markdown 代码块。正文写完后另起一行，单独输出分隔符：',
    PROSE_TAIL_SENTINEL,
    '分隔符之后输出**单个 JSON 对象**，严格符合下面的 JSON Schema：',
    JSON.stringify(jsonSchema, null, 2),
    'JSON 不要用 Markdown 代码块包裹，JSON 之后不要再输出任何文字。',
  ].join('\n');
  return `${system}\n\n${block}`;
}

/** 尾部文本 → 校验结果；失败时返回给模型看的错误说明 */
function validateTail<T>(
  schema: z.ZodType<T>,
  text: string | undefined,
): { ok: true; data: T } | { ok: false; error: string } {
  if (text === undefined) {
    return { ok: false, error: `找不到分隔符 ${PROSE_TAIL_SENTINEL}，正文之后没有结构化数据。` };
  }
  const jsonText = extractJsonText(text);
  if (jsonText === undefined) return { ok: false, error: '分隔符之后找不到 JSON 对象。' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (cause) {
    return {
      ok: false,
      error: `JSON 语法错误：${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const validated = schema.safeParse(parsed);
  if (validated.success) return { ok: true, data: validated.data };
  return { ok: false, error: formatZodIssues(validated.error) };
}

function mergeUsage(
  total: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!next) return total;
  if (!total) return next;
  const merged: TokenUsage = {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
  };
  const cached = (total.cachedPromptTokens ?? 0) + (next.cachedPromptTokens ?? 0);
  if (cached > 0) merged.cachedPromptTokens = cached;
  return merged;
}

/**
 * 一次流式生成，正文边写边显示，结束后尾部 JSON 走 Zod。
 *
 * - 首轮 finishReason === 'length' 直接抛 truncated、不修复：残缺的正文修不回来。
 * - 正文为空抛 parse：没有情节的一步没有意义。
 * - 尾部不合格时发**非流式**修复请求（json_object），把首轮全文作为 assistant 回灌、
 *   只要修正后的 JSON；正文保留首轮的。修复轮被截断同样抛 truncated。
 * - signal 取消时底层抛 aborted，原样上抛
 */
export async function generateProseWithTail<T>(
  options: ProseTailOptions<T>,
): Promise<ProseTailResult<T>> {
  const {
    client,
    model,
    schema,
    system,
    user,
    temperature,
    thinking,
    reasoningEffort,
    signal,
    onProse,
    maxRepairAttempts = 1,
  } = options;

  // 与 structured.ts 同一转换：io: 'output' 让带默认值的字段也进 required，模型必须全部写出
  const jsonSchema = z.toJSONSchema(schema, { io: 'output' });
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(system, jsonSchema) },
    { role: 'user', content: user },
  ];
  const withParams = (request: ChatRequest): ChatRequest => {
    if (temperature !== undefined) request.temperature = temperature;
    if (thinking !== undefined) request.thinking = thinking;
    if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort;
    return request;
  };

  let streamed = '';
  let shown: string | undefined;
  const first = await client.streamChat(
    withParams({ model, messages }),
    {
      onText: (delta) => {
        streamed += delta;
        const visible = visibleProse(streamed);
        // 只在可见正文变化时回调：分隔符之后的 JSON 还在流，界面不必跟着重绘
        if (visible !== shown) {
          shown = visible;
          onProse?.(visible);
        }
      },
    },
    signal,
  );
  let usage = mergeUsage(undefined, first.usage);

  if (first.finishReason === 'length') {
    throw new LlmError('truncated', TRUNCATED_MESSAGE, {
      detail: `finish_reason=length，已收到 ${first.content.length} 个字符`,
    });
  }

  const { prose, tail } = splitProseAndTail(first.content);
  if (!prose) throw new LlmError('parse', '模型没有写出情节');

  let attempts = 1;
  const finish = (data: T): ProseTailResult<T> => {
    const out: ProseTailResult<T> = { prose, data, attempts };
    if (usage) out.usage = usage;
    return out;
  };

  let result = validateTail(schema, tail);
  if (result.ok) return finish(result.data);

  let lastContent = first.content;
  let lastError = result.error;
  for (let repair = 0; repair < maxRepairAttempts; repair += 1) {
    // 把上一轮的原始输出与具体错误一起回灌，比单纯重试的成功率高得多
    messages.push({ role: 'assistant', content: lastContent });
    messages.push({
      role: 'user',
      content: `上面分隔符之后的结构化数据不符合要求：\n${lastError}\n请只输出修正后的完整 JSON，不要正文、不要分隔符`,
    });
    const response = await client.chat(
      withParams({ model, messages, responseFormat: { kind: 'json_object' } }),
      signal,
    );
    attempts += 1;
    usage = mergeUsage(usage, response.usage);
    if (response.finishReason === 'length') {
      throw new LlmError('truncated', TRUNCATED_MESSAGE, {
        detail: `修复请求 finish_reason=length，已收到 ${response.content.length} 个字符`,
      });
    }
    // 修复轮只要求 JSON：整段都是尾部
    result = validateTail(schema, response.content);
    if (result.ok) return finish(result.data);
    lastContent = response.content;
    lastError = result.error;
  }

  throw new LlmError('parse', `模型输出不符合预期格式（已重试 ${maxRepairAttempts} 次）`, {
    detail: lastError,
  });
}
