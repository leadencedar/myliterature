import { useMemo } from 'react';
import type { z } from 'zod';
import { LlmError } from './errors';
import { OpenAiCompatibleClient } from './OpenAiCompatibleClient';
import { isLlmConfigured, useLlmSettings, type LlmSettings } from './settingsStore';
import { generateProseWithTail, type ProseTailResult } from './proseTail';
import { generateStructured, type StructuredResult } from './structured';
import { TASK_PROFILES, type TaskKind } from './taskProfiles';
import type { ChatMessage, ChatResult, LlmClient, StreamHandlers } from './types';

/** 按任务解析出该用哪个模型 */
export function resolveModel(settings: LlmSettings, task: TaskKind): string {
  const profile = TASK_PROFILES[task];
  if (profile.useStrongModel && settings.strongModel.trim()) {
    return settings.strongModel.trim();
  }
  return settings.model.trim();
}

export interface StructuredRunOptions<T> {
  schema: z.ZodType<T>;
  schemaName: string;
  /** 稳定前缀，必须逐字节可复现以命中 prompt 缓存 */
  system: string;
  /** 本次指令 */
  user: string;
  signal?: AbortSignal;
  onAttempt?: (attempt: { index: number; repairing: boolean }) => void;
  /** 透传给 generateStructured：被截断时直接抛 truncated，不做修复重试 */
  failOnTruncation?: boolean;
}

export interface ProseTailRunOptions<T> {
  /** 尾部 JSON 的 schema */
  schema: z.ZodType<T>;
  schemaName: string;
  /** 稳定前缀，必须逐字节可复现以命中 prompt 缓存 */
  system: string;
  user: string;
  signal?: AbortSignal;
  /** 分隔符之前的累计正文，流式显示用 */
  onProse?: (proseSoFar: string) => void;
}

export interface TextRunOptions {
  system: string;
  user: string;
  /** 追加的历史消息，用于多轮续写 */
  history?: ChatMessage[];
  signal?: AbortSignal;
}

export interface LlmRunner {
  configured: boolean;
  client: LlmClient;
  /** 结构化生成：Zod 校验 + 失败修复重试 */
  runStructured: <T>(
    task: TaskKind,
    options: StructuredRunOptions<T>,
  ) => Promise<StructuredResult<T>>;
  /** 流式文本生成 */
  runStream: (
    task: TaskKind,
    options: TextRunOptions,
    handlers: StreamHandlers,
  ) => Promise<ChatResult>;
  /** 流式正文 + 结构化尾部（互动推演的一步）：正文边写边显示，尾部 Zod 校验 + 失败修复重试 */
  runProseWithTail: <T>(
    task: TaskKind,
    options: ProseTailRunOptions<T>,
  ) => Promise<ProseTailResult<T>>;
}

/**
 * 业务层调用模型的唯一入口。
 *
 * 把「任务类型 → 模型 / 温度 / thinking 开关」的映射收在这里，
 * 各功能模块只需要说明自己在做哪种任务，不必重复决定这些参数。
 */
export function useLlm(): LlmRunner {
  const settings = useLlmSettings();

  const client = useMemo(
    () =>
      new OpenAiCompatibleClient({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        capabilities: settings.capabilities,
      }),
    [settings.baseUrl, settings.apiKey, settings.capabilities],
  );

  return useMemo<LlmRunner>(() => {
    const configured = isLlmConfigured(settings);

    function assertConfigured() {
      if (!configured) {
        throw new LlmError('config', '还没有配置模型，请先到「设置」填写 API Key');
      }
    }

    return {
      configured,
      client,

      async runStructured(task, options) {
        assertConfigured();
        const profile = TASK_PROFILES[task];
        return generateStructured({
          client,
          model: resolveModel(settings, task),
          schema: options.schema,
          schemaName: options.schemaName,
          system: options.system,
          user: options.user,
          temperature: profile.temperature,
          thinking: profile.thinking,
          ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onAttempt ? { onAttempt: options.onAttempt } : {}),
          ...(options.failOnTruncation ? { failOnTruncation: true } : {}),
        });
      },

      async runStream(task, options, handlers) {
        assertConfigured();
        const profile = TASK_PROFILES[task];
        const messages: ChatMessage[] = [
          { role: 'system', content: options.system },
          ...(options.history ?? []),
          { role: 'user', content: options.user },
        ];
        return client.streamChat(
          {
            model: resolveModel(settings, task),
            messages,
            temperature: profile.temperature,
            thinking: profile.thinking,
            ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
          },
          handlers,
          options.signal,
        );
      },

      async runProseWithTail(task, options) {
        assertConfigured();
        const profile = TASK_PROFILES[task];
        return generateProseWithTail({
          client,
          model: resolveModel(settings, task),
          schema: options.schema,
          schemaName: options.schemaName,
          system: options.system,
          user: options.user,
          temperature: profile.temperature,
          thinking: profile.thinking,
          ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProse ? { onProse: options.onProse } : {}),
        });
      },
    };
  }, [client, settings]);
}
