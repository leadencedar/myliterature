import { useEffect, useMemo, useRef } from 'react';
import type { NovelRepository } from '@/data/NovelRepository';
import { useRepository } from '@/data/RepositoryProvider';
import { newId } from '@/domain/primitives';
import {
  MAX_SCENARIO_OPTIONS,
  StyleProfileSchema,
  type Category,
  type KnowledgeEntry,
  type Novel,
  type Scenario,
  type ScenarioNode,
  type ScenarioOption,
  type StyleProfile,
  type WritingNorm,
} from '@/domain/schema';
import {
  MAX_CONTEXT_GAP,
  SCENARIO_LIMITS,
  checkpointSegment,
  checkpointsToFill,
  childrenOf,
  contextGap,
  isCheckpoint,
  normalizeAction,
  pathTo,
  rootOf,
  validateFreeAction,
  walkedChoices,
} from '@/domain/scenario';
import {
  effectiveKnowledge,
  resolveStepChanges,
  resolveStepEnding,
  resolveStepProgress,
} from '@/domain/worldline';
import { LlmError } from '@/llm/errors';
import { useLlm, type LlmRunner } from '@/llm/useLlm';
import {
  buildOptionsUserPrompt,
  buildScenarioStablePrefix,
  buildScenarioSystemPrompt,
  buildStepUserPrompt,
  buildSummaryUserPrompt,
  type ScenarioContextItem,
  type ScenarioPromptAction,
} from './scenarioPrompt';
import {
  OptionsBatchSchema,
  StepTailSchema,
  SummaryOutSchema,
  WrapUpTailSchema,
} from './stepSchema';

/**
 * 推演编排（设计 §5.3）：推进 / 收尾 / 再给选项 / 检查点前情摘要。
 *
 * 编排逻辑写成不依赖 React 的 createScenarioRunner，hook 只包一层并在卸载时取消全部在途请求 ——
 * 这样编排能用真仓储 + stub 模型直接单测。
 *
 * 不变量：
 * - 只有最后一步 appendScenarioNode 写节点：生成中刷新、关页、离开推演页、点「停止」都不会留下半截节点。
 * - 每次都在发请求前从仓储读最新数据，不用组件里的旧对象（与摘要面板、导入循环一致）。
 * - 挂载、跳转、切换世界线、打开面板都不经过这里，所以回退不花钱；补摘要只在推进 / 收尾之前
 *   与新检查点刚落库时触发（D5.3）。
 */

export type AdvanceAction =
  | { kind: 'start' }
  | { kind: 'option'; optionId: string }
  | { kind: 'free'; text: string }
  | { kind: 'wrap-up'; goalId: string | null; note: string };

export interface AdvanceInput {
  scenarioId: string;
  /** null = 开局 */
  parentId: string | null;
  action: AdvanceAction;
  /** 「本步依据」里取消勾选的推断条目：只影响用户提示 */
  excludedEntryIds?: ReadonlySet<string>;
}

export interface AdvanceHandlers {
  /** 「停止」：取消本步（含同步补摘要），什么都不存 */
  signal?: AbortSignal;
  /** 分隔符之前的累计正文 */
  onProse?: (prose: string) => void;
  /** summarizing = 正在同步整理前情（gap 过大时）；generating = 开始生成这一步 */
  onPhase?: (phase: 'summarizing' | 'generating') => void;
}

export interface AdvanceResult {
  node: ScenarioNode;
  scenario: Scenario;
  /** 这一步实际注入了什么（「本步依据」） */
  items: ScenarioContextItem[];
}

/** 检查点摘要的进展，给状态面板显示「前情整理失败，下次推进时会重试」 */
export interface CheckpointEvent {
  scenarioId: string;
  nodeId: string;
  status: 'running' | 'done' | 'failed';
}

export interface ScenarioRunnerDeps {
  repo: NovelRepository;
  llm: Pick<LlmRunner, 'configured' | 'runProseWithTail' | 'runStructured'>;
  onCheckpoint?: (event: CheckpointEvent) => void;
}

export interface ScenarioRunner {
  advance(input: AdvanceInput, handlers?: AdvanceHandlers): Promise<AdvanceResult>;
  /** 「再给几个选项」：去重后追加到节点上 */
  regenerateOptions(
    input: { scenarioId: string; nodeId: string; excludedEntryIds?: ReadonlySet<string> },
    handlers?: { signal?: AbortSignal },
  ): Promise<ScenarioNode>;
  /** 给一个检查点补前情摘要。同一检查点在途时返回同一个 Promise，不发第二个请求 */
  summarizeCheckpoint(
    input: { scenarioId: string; nodeId: string },
    signal?: AbortSignal,
  ): Promise<ScenarioNode>;
  /** 取消全部在途请求（本步、再给选项、后台摘要）。页面卸载时调用 */
  abortAll(): void;
}

/** gap 过大、同步补前情时任何一个检查点失败：本步不生成。已补成功的检查点保留，重试从失败的那个继续 */
export class CheckpointFillError extends Error {
  readonly nodeId: string;
  readonly reason: unknown;

  constructor(nodeId: string, reason: unknown) {
    super('整理前情失败，这一步没有生成');
    this.name = 'CheckpointFillError';
    this.nodeId = nodeId;
    this.reason = reason;
  }
}

/** 与仓储同一文案 */
const SCENARIO_GONE = '这个推演已不存在，可能已被删除';
const NODE_GONE = '这一步已不存在';
export const ALREADY_WALKED = '这个行动在这一步已经走过了';

/** 情节上限：与 ScenarioNodeSchema.plot 一致 */
const MAX_PLOT_LENGTH = 6000;

function abortedError(): LlmError {
  return new LlmError('aborted', '已取消');
}

function isAborted(error: unknown): boolean {
  return error instanceof LlmError && error.kind === 'aborted';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError();
}

/** 等一个不归自己取消的 Promise（别人发起的在途摘要），但自己被取消时立刻返回 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

interface LoadedContext {
  scenario: Scenario;
  novel: Novel;
  nodes: ScenarioNode[];
  entries: KnowledgeEntry[];
  categories: Category[];
  norms: WritingNorm[];
  style: StyleProfile;
}

export function createScenarioRunner(deps: ScenarioRunnerDeps): ScenarioRunner {
  const { repo, llm } = deps;
  const controllers = new Set<AbortController>();
  /** 在途的检查点摘要：同一检查点只发一个请求，同步补遇到在途的后台请求时 await 它 */
  const inflight = new Map<string, Promise<ScenarioNode>>();

  /** 每个操作一个 AbortController；external（「停止」）取消时连带取消 */
  function track(external?: AbortSignal): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    controllers.add(controller);
    const onAbort = () => controller.abort();
    if (external?.aborted) controller.abort();
    else external?.addEventListener('abort', onAbort, { once: true });
    return {
      signal: controller.signal,
      release: () => {
        controllers.delete(controller);
        external?.removeEventListener('abort', onAbort);
      },
    };
  }

  function assertConfigured(): void {
    if (!llm.configured) throw new LlmError('config', '需要先在「设置」里配置模型');
  }

  async function load(scenarioId: string): Promise<LoadedContext> {
    const scenario = await repo.getScenario(scenarioId);
    if (!scenario) throw new Error(SCENARIO_GONE);
    const novelId = scenario.novelId;
    const [novel, nodes, entries, categories, norms, style] = await Promise.all([
      repo.getNovel(novelId),
      repo.listScenarioNodes(scenarioId),
      // 限定条目（含推演 OC）也要：可见性由 effectiveKnowledge 按推演与路径判定。
      // 含已删除的：只为区分「主角被删了（可到回收站恢复）」与「主角不存在」，删除的条目在有效知识里被跳过
      repo.listEntries(novelId, { scope: 'all', includeDeleted: true }),
      repo.listCategories(novelId),
      repo.listWritingNorms(novelId),
      repo.getStyleProfile(novelId),
    ]);
    if (!novel) throw new Error('这部作品已不存在');
    return {
      scenario,
      novel,
      nodes,
      entries,
      categories,
      norms,
      // 风格档案随作品创建；万一缺失用默认值拼前缀，不在生成路径上写库
      style:
        style ??
        StyleProfileSchema.parse({ id: `style-${novelId}`, novelId, createdAt: 0, updatedAt: 0 }),
    };
  }

  function systemOf(ctx: LoadedContext): { system: string; items: ScenarioContextItem[] } {
    const prefix = buildScenarioStablePrefix({
      novel: ctx.novel,
      style: ctx.style,
      norms: ctx.norms,
      categories: ctx.categories,
      entries: ctx.entries,
      scenario: ctx.scenario,
    });
    return { system: buildScenarioSystemPrompt(prefix.text), items: prefix.items };
  }

  function assertCastAlive(ctx: LoadedContext): void {
    const entryId = ctx.scenario.setup.cast[0]?.entryId;
    const entry = ctx.entries.find((item) => item.id === entryId);
    if (!entry) throw new Error('主角条目已不存在，这个推演只能浏览、不能推进');
    if (entry.deletedAt !== null) {
      throw new Error(`主角「${entry.title}」已被删除，到知识库回收站恢复后才能继续`);
    }
  }

  async function doSummarize(
    scenarioId: string,
    nodeId: string,
    signal: AbortSignal,
  ): Promise<ScenarioNode> {
    deps.onCheckpoint?.({ scenarioId, nodeId, status: 'running' });
    try {
      assertConfigured();
      const ctx = await load(scenarioId);
      const path = pathTo(ctx.nodes, nodeId);
      if (path.length === 0) throw new Error(NODE_GONE);
      const { previous, steps } = checkpointSegment(path, nodeId);
      const { system } = systemOf(ctx);
      const result = await llm.runStructured('interactive-summary', {
        schema: SummaryOutSchema,
        schemaName: 'scenario_path_summary',
        system,
        user: buildSummaryUserPrompt({ previous, steps }),
        signal,
      });
      throwIfAborted(signal);
      const saved = await repo.setScenarioNodeSummary(nodeId, {
        text: result.data.summary,
        openThreads: result.data.openThreads,
      });
      deps.onCheckpoint?.({ scenarioId, nodeId, status: 'done' });
      return saved;
    } catch (error) {
      // 被取消不算失败：下一次推进或收尾前由 checkpointsToFill 重新发现
      if (!isAborted(error) && !signal.aborted)
        deps.onCheckpoint?.({ scenarioId, nodeId, status: 'failed' });
      throw error;
    }
  }

  function summarizeCheckpoint(
    input: { scenarioId: string; nodeId: string },
    signal?: AbortSignal,
  ): Promise<ScenarioNode> {
    const existing = inflight.get(input.nodeId);
    if (existing) return existing;
    const tracked = track(signal);
    // finally 回调总是异步执行，所以 set 一定先于 delete
    const run: Promise<ScenarioNode> = doSummarize(
      input.scenarioId,
      input.nodeId,
      tracked.signal,
    ).finally(() => {
      if (inflight.get(input.nodeId) === run) inflight.delete(input.nodeId);
      tracked.release();
    });
    inflight.set(input.nodeId, run);
    return run;
  }

  /** 后台按顺序补：前一个补好后才是后一个的「上一段前情」；任何一个失败就停，下次推进再补 */
  function fillInBackground(scenarioId: string, checkpoints: readonly ScenarioNode[]): void {
    void (async () => {
      for (const node of checkpoints) {
        try {
          await summarizeCheckpoint({ scenarioId, nodeId: node.id });
        } catch {
          return;
        }
      }
    })();
  }

  /** gap 过大时同步按顺序补齐；任何一个失败本步不生成 */
  async function fillNow(
    scenarioId: string,
    checkpoints: readonly ScenarioNode[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const node of checkpoints) {
      try {
        await raceAbort(summarizeCheckpoint({ scenarioId, nodeId: node.id }, signal), signal);
      } catch (error) {
        if (isAborted(error) || signal.aborted) throw abortedError();
        throw new CheckpointFillError(node.id, error);
      }
    }
  }

  /** 前置检查（不发请求）：返回给提示词用的行动与要落库的 arrivedBy */
  function resolveAction(
    ctx: LoadedContext,
    parent: ScenarioNode | null,
    action: AdvanceAction,
  ): { prompt: ScenarioPromptAction; arrivedBy: ScenarioNode['arrivedBy'] } {
    if (parent === null) {
      if (action.kind !== 'start') throw new Error('要接着走的那一步已不存在');
      if (rootOf(ctx.nodes)) throw new Error('这个推演已经开过局了');
      return { prompt: { kind: 'start' }, arrivedBy: { kind: 'start' } };
    }
    if (parent.ending !== null) throw new Error('这条线已经结束，不能继续推进');
    const walked = walkedChoices(parent, childrenOf(ctx.nodes, parent.id));
    switch (action.kind) {
      case 'start':
        throw new Error('这个推演已经开过局了');
      case 'option': {
        const option = parent.options.find((item) => item.id === action.optionId);
        if (!option) throw new Error('这个选项已不存在');
        if (walked.options.has(option.id)) throw new Error(ALREADY_WALKED);
        return {
          prompt: { kind: 'option', text: option.text },
          arrivedBy: { kind: 'option', optionId: option.id, text: option.text },
        };
      }
      case 'free': {
        const invalid = validateFreeAction(action.text);
        if (invalid) throw new Error(invalid);
        const text = action.text.trim();
        const key = normalizeAction(text);
        const walkedOptionKeys = parent.options
          .filter((option) => walked.options.has(option.id))
          .map((option) => normalizeAction(option.text));
        if (walked.free.some((item) => item.key === key) || walkedOptionKeys.includes(key)) {
          throw new Error(ALREADY_WALKED);
        }
        // 与未走过的选项规范化后相同：按选了那个选项处理，之后它显示为已走过（D2.1）
        const same = parent.options.find(
          (option) => !walked.options.has(option.id) && normalizeAction(option.text) === key,
        );
        if (same) {
          return {
            prompt: { kind: 'option', text: same.text },
            arrivedBy: { kind: 'option', optionId: same.id, text: same.text },
          };
        }
        return { prompt: { kind: 'free', text }, arrivedBy: { kind: 'free', text } };
      }
      case 'wrap-up': {
        if (walked.wrapUp) throw new Error('这一步已经收尾过了');
        const note = action.note.trim();
        if (note.length > SCENARIO_LIMITS.wrapUpNote) {
          throw new Error(`收尾说明不能超过 ${SCENARIO_LIMITS.wrapUpNote} 字`);
        }
        const goalId =
          action.goalId !== null &&
          ctx.scenario.setup.goals.some((goal) => goal.id === action.goalId)
            ? action.goalId
            : null;
        return {
          prompt: { kind: 'wrap-up', goalId, note },
          arrivedBy: { kind: 'wrap-up', goalId, note },
        };
      }
    }
  }

  async function advance(
    input: AdvanceInput,
    handlers: AdvanceHandlers = {},
  ): Promise<AdvanceResult> {
    assertConfigured();
    const tracked = track(handlers.signal);
    const { signal } = tracked;
    try {
      let ctx = await load(input.scenarioId);
      const parent =
        input.parentId === null
          ? null
          : (ctx.nodes.find((node) => node.id === input.parentId) ?? null);
      if (input.parentId !== null && !parent) throw new Error('要接着走的那一步已不存在');
      const action = resolveAction(ctx, parent, input.action);
      assertCastAlive(ctx);

      // 前情检查（D5.3）：gap 过大同步按顺序补齐，否则后台补、本步照常生成
      let path = parent ? pathTo(ctx.nodes, parent.id) : [];
      if (parent && path.length === 0) throw new Error('要接着走的那一步已不存在');
      const missing = parent ? checkpointsToFill(path, parent.depth) : [];
      if (missing.length > 0) {
        if (contextGap(path).gap.length > MAX_CONTEXT_GAP) {
          handlers.onPhase?.('summarizing');
          await fillNow(input.scenarioId, missing, signal);
          ctx = await load(input.scenarioId);
          path = pathTo(ctx.nodes, parent!.id);
        } else {
          fillInBackground(input.scenarioId, missing);
        }
      }
      throwIfAborted(signal);

      handlers.onPhase?.('generating');
      const knowledge = effectiveKnowledge({
        scenario: ctx.scenario,
        path,
        entries: ctx.entries,
        categories: ctx.categories,
      });
      const { system, items: prefixItems } = systemOf(ctx);
      const user = buildStepUserPrompt({
        knowledge,
        path,
        scenario: ctx.scenario,
        entries: ctx.entries,
        categories: ctx.categories,
        action: action.prompt,
        ...(input.excludedEntryIds ? { excludedEntryIds: input.excludedEntryIds } : {}),
      });
      const wrapUp = input.action.kind === 'wrap-up';
      const result = await llm.runProseWithTail(
        wrapUp ? 'interactive-ending' : 'interactive-step',
        {
          // 收尾的 refine 不进 JSON Schema：两种请求的系统提示逐字节相同
          schema: wrapUp ? WrapUpTailSchema : StepTailSchema,
          schemaName: 'scenario_step',
          system,
          user: user.text,
          signal,
          ...(handlers.onProse ? { onProse: handlers.onProse } : {}),
        },
      );
      if (result.prose.length > MAX_PLOT_LENGTH) {
        throw new LlmError('parse', `这一步的情节超过 ${MAX_PLOT_LENGTH} 字，没有保存`);
      }

      // 解析：名称 → id、序号 → id，按「宁可少记」丢弃并提示
      const tail = result.data;
      const deltaCtx = {
        knowledge,
        categories: ctx.categories,
        scenario: ctx.scenario,
        createId: newId,
      };
      const changes = resolveStepChanges(tail.changes, deltaCtx);
      const progress = resolveStepProgress(tail.progress, deltaCtx);
      const ending = resolveStepEnding(tail.ending, deltaCtx);
      const seen = new Set<string>();
      const options: ScenarioOption[] = [];
      for (const option of tail.options) {
        const key = normalizeAction(option.text);
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({
          id: newId(),
          text: option.text,
          tendency: option.tendency,
          risk: option.risk,
          batch: 0,
        });
      }

      // 写库前最后确认没有被取消：已卸载或点了「停止」时什么都不存
      throwIfAborted(signal);
      const appended = await repo.appendScenarioNode(input.scenarioId, {
        parentId: parent?.id ?? null,
        arrivedBy: action.arrivedBy,
        plot: result.prose,
        challenge: tail.challenge,
        options,
        delta: changes.delta,
        notices: [...changes.notices, ...progress.notices, ...ending.notices],
        progress: progress.progress,
        ending: ending.ending,
      });

      // 新检查点：后台补（连同路径上更早缺的，按顺序），不 await
      if (isCheckpoint(appended.node)) {
        const newPath = [...path, appended.node];
        fillInBackground(input.scenarioId, checkpointsToFill(newPath, appended.node.depth));
      }
      return {
        node: appended.node,
        scenario: appended.scenario,
        items: [...prefixItems, ...user.items],
      };
    } catch (error) {
      // 底层可能以 DOMException 或其他形式报告取消：统一成 aborted，界面据此「回到选择前、不提示错误」
      if (signal.aborted && !isAborted(error)) throw abortedError();
      throw error;
    } finally {
      tracked.release();
    }
  }

  async function regenerateOptions(
    input: { scenarioId: string; nodeId: string; excludedEntryIds?: ReadonlySet<string> },
    handlers: { signal?: AbortSignal } = {},
  ): Promise<ScenarioNode> {
    assertConfigured();
    const tracked = track(handlers.signal);
    const { signal } = tracked;
    try {
      const ctx = await load(input.scenarioId);
      const node = ctx.nodes.find((item) => item.id === input.nodeId);
      if (!node) throw new Error(NODE_GONE);
      if (node.ending !== null) throw new Error('这条线已经结束，不能再给选项');
      if (node.options.length >= MAX_SCENARIO_OPTIONS) throw new Error('这一步的选项已经够多了');
      const path = pathTo(ctx.nodes, node.id);
      if (path.length === 0) throw new Error(NODE_GONE);
      const knowledge = effectiveKnowledge({
        scenario: ctx.scenario,
        path,
        entries: ctx.entries,
        categories: ctx.categories,
      });
      const { system } = systemOf(ctx);
      const user = buildOptionsUserPrompt({
        knowledge,
        path,
        scenario: ctx.scenario,
        entries: ctx.entries,
        categories: ctx.categories,
        excludedEntryIds: input.excludedEntryIds ?? new Set(),
        children: childrenOf(ctx.nodes, node.id),
      });
      const result = await llm.runStructured('interactive-options', {
        schema: OptionsBatchSchema,
        schemaName: 'scenario_options',
        system,
        user,
        signal,
      });
      // 与已有选项、彼此之间规范化后相同的去掉；不足 2 个视为失败、不写入
      const seen = new Set(node.options.map((option) => normalizeAction(option.text)));
      const fresh = result.data.options.filter((option) => {
        const key = normalizeAction(option.text);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fresh.length < 2) throw new Error('没有新的选项');
      throwIfAborted(signal);
      return await repo.appendScenarioOptions(node.id, fresh);
    } catch (error) {
      if (signal.aborted && !isAborted(error)) throw abortedError();
      throw error;
    } finally {
      tracked.release();
    }
  }

  return {
    advance,
    regenerateOptions,
    summarizeCheckpoint,
    abortAll() {
      for (const controller of controllers) controller.abort();
    },
  };
}

/**
 * 推演页用的 hook：只包一层 createScenarioRunner，并在卸载的 effect cleanup 里 abort() 全部在途请求
 * （本步、再给选项、后台摘要），什么都不存 —— 与「停止」一致。不在离开后继续生成并落库：
 * 作者回来看到一个没看着它生成的新节点、主线还被它改了，违反「主线跟着作者的推进走」。
 * 卸载后各方法以 aborted 失败，调用方据此不再更新状态
 */
export function useScenarioRunner(
  options: { onCheckpoint?: (event: CheckpointEvent) => void } = {},
): ScenarioRunner {
  const repo = useRepository();
  const llm = useLlm();
  const onCheckpointRef = useRef(options.onCheckpoint);
  useEffect(() => {
    onCheckpointRef.current = options.onCheckpoint;
  });
  const runner = useMemo(
    () =>
      createScenarioRunner({
        repo,
        llm,
        onCheckpoint: (event) => onCheckpointRef.current?.(event),
      }),
    [repo, llm],
  );
  useEffect(() => () => runner.abortAll(), [runner]);
  return runner;
}
