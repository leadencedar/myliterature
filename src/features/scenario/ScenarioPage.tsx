import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { RequireNovel } from '@/app/RequireNovel';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import {
  MAX_SCENARIO_OPTIONS,
  StyleProfileSchema,
  type Novel,
  type OutlineNode,
  type Scenario,
  type ScenarioNode,
} from '@/domain/schema';
import {
  ACTION_SIMILARITY_THRESHOLD,
  SCENARIO_LIMITS,
  actionSimilarity,
  childrenOf,
  latestLeafOf,
  mainPath,
  normalizeAction,
  pathTo,
  sedimentCoverage,
  validateFreeAction,
  walkedChoices,
  type WalkedChoices,
} from '@/domain/scenario';
import { effectiveKnowledge } from '@/domain/worldline';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { Button, IconButton } from '@/ui/Button';
import { TextAreaField, TextField } from '@/ui/Field';
import { EmptyState, Page } from '@/ui/Page';
import { Sheet } from '@/ui/Sheet';
import { BackIcon, CheckIcon, FolderIcon, MoreIcon, ReorderIcon } from '@/ui/icons';
import { DeleteScenarioDialog } from './DeleteScenarioDialog';
import { DeltaEditor } from './DeltaEditor';
import { ScenarioBreadcrumb } from './ScenarioBreadcrumb';
import { SedimentSheet } from './SedimentSheet';
import { ScenarioSetupSheet } from './ScenarioSetupSheet';
import { WorldlineNavigatorSheet } from './WorldlineNavigatorSheet';
import { WorldlineStateSheet } from './WorldlineStateSheet';
import { WrapUpSheet } from './WrapUpSheet';
import {
  OPTION_RISK_LABELS,
  OPTION_TENDENCY_LABELS,
  buildScenarioStablePrefix,
  buildStepUserPrompt,
  type ScenarioContextItem,
} from './scenarioPrompt';
import { endingLabel, errorText, landingNodeId, stepHeading, stepNumber } from './scenarioView';
import { useScenarioRunner, type AdvanceAction, type CheckpointEvent } from './useScenarioRunner';

/**
 * 推演页（设计 §8.3，路由 /write/scenario/:scenarioId）。单套响应式 DOM，自上而下：
 * 状态徽标 → 面包屑 → 正文 → 挑战与选项 → 自由输入（或结局）→ 本步依据 → 底部操作栏。
 *
 * 「回退不花钱」是这一页的底线：挂载、跳转（面包屑、导航、去这条线）、切换世界线、打开状态面板
 * 都只读内存里的树，跳转只调 setScenarioCursor，不发任何请求（含补摘要）。请求只在作者点选项、
 * 提交自由输入、收尾、再给选项时发生，都经 useScenarioRunner；离开页面时它取消全部在途请求，什么都不存。
 */
export function ScenarioPage() {
  const { scenarioId = '' } = useParams();
  return (
    <RequireNovel title="互动推演">
      {(novel) => <ScenarioContent key={scenarioId} novel={novel} scenarioId={scenarioId} />}
    </RequireNovel>
  );
}

/** 正在进行的生成：推进（含开局与收尾）或再给选项 */
type Pending = { parentId: string | null; action: AdvanceAction };
type Generation =
  | { kind: 'idle' }
  | { kind: 'advancing'; pending: Pending; prose: string; phase: 'summarizing' | 'generating' }
  | { kind: 'options'; nodeId: string };

interface Failure {
  message: string;
  detail?: string;
  /** 失败发生在哪一步（开局为 null）：只在那一步上显示 */
  at: string | null;
  retry: { kind: 'advance'; pending: Pending } | { kind: 'options'; nodeId: string };
}

/**
 * 「本书主线大纲里有 N 章来自旧主线（第 X–Y 章）」（设计 D7.4）。章号是大纲树里叶子节点的先序序号，
 * 与作者在大纲树里数到的位置一致。只提示、不删除：作者可能已经在这些章上写了正文
 */
function oldMainlineNotice(
  scenario: Scenario,
  nodes: readonly ScenarioNode[],
  outline: readonly OutlineNode[],
): string | null {
  const { stale } = sedimentCoverage({ scenario, nodes, outline });
  if (stale.length === 0) return null;
  const leaves: string[] = [];
  const walk = (parentId: string | null) => {
    const children = outline
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.order - b.order);
    for (const child of children) {
      if (outline.some((node) => node.parentId === child.id)) walk(child.id);
      else leaves.push(child.id);
    }
  };
  walk(null);
  const ordinals = stale
    .map((node) => leaves.indexOf(node.id) + 1)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const span =
    ordinals.length === 0
      ? ''
      : ordinals[0] === ordinals[ordinals.length - 1]
        ? `（第 ${ordinals[0]} 章）`
        : `（第 ${ordinals[0]}–${ordinals[ordinals.length - 1]} 章）`;
  return `本书主线大纲里有 ${stale.length} 章来自旧主线${span}`;
}

/** 推进 / 再给选项之后，库里的新数据回来之前先用返回值顶上，避免界面闪回旧节点 */
function mergeNodes(base: readonly ScenarioNode[], local: readonly ScenarioNode[]): ScenarioNode[] {
  const byId = new Map(base.map((node) => [node.id, node]));
  for (const node of local) {
    const current = byId.get(node.id);
    if (!current || node.updatedAt > current.updatedAt) byId.set(node.id, node);
  }
  return [...byId.values()];
}

function ScenarioContent({ novel, scenarioId }: { novel: Novel; scenarioId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const repository = useRepository();
  const invalidate = useInvalidate();
  const llm = useLlm();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [failedCheckpoints, setFailedCheckpoints] = useState<ReadonlySet<string>>(new Set());
  const runner = useScenarioRunner({
    onCheckpoint: (event: CheckpointEvent) => {
      // 卸载后的回调（被取消的后台摘要）不再更新状态
      if (!mounted.current) return;
      setFailedCheckpoints((current) => {
        const next = new Set(current);
        if (event.status === 'failed') next.add(event.nodeId);
        else next.delete(event.nodeId);
        return next;
      });
    },
  });

  const { data, loading } = useRepoQuery(
    async (repo) => {
      const scenario = (await repo.getScenario(scenarioId)) ?? null;
      if (!scenario || scenario.novelId !== novel.id) {
        return {
          scenario,
          nodes: [],
          entries: [],
          categories: [],
          style: null,
          norms: [],
          outline: [],
        };
      }
      const [nodes, entries, categories, style, norms, outline] = await Promise.all([
        repo.listScenarioNodes(scenarioId),
        // 限定条目（含推演主角）也要；含已删除的，才能说清「主角在回收站」
        repo.listEntries(novel.id, { scope: 'all', includeDeleted: true }),
        repo.listCategories(novel.id),
        repo.getStyleProfile(novel.id),
        repo.listWritingNorms(novel.id),
        // 只用来算「本书主线大纲里有 N 章来自旧主线」
        repo.listOutline(novel.id),
      ]);
      return { scenario, nodes, entries, categories, style: style ?? null, norms, outline };
    },
    [scenarioId, novel.id],
  );

  const [localNodes, setLocalNodes] = useState<ScenarioNode[]>([]);
  const [localScenario, setLocalScenario] = useState<Scenario | null>(null);
  const nodes = useMemo(() => mergeNodes(data?.nodes ?? [], localNodes), [data?.nodes, localNodes]);
  const baseScenario = data?.scenario ?? null;
  const scenario =
    baseScenario && localScenario && localScenario.updatedAt > baseScenario.updatedAt
      ? localScenario
      : baseScenario;
  const entries = useMemo(() => data?.entries ?? [], [data?.entries]);
  const categories = useMemo(() => data?.categories ?? [], [data?.categories]);

  /** 作者跳到的节点。null = 按落点规则（cursor → 主线末端 → 根），只在内存里决定，不写库 */
  const [viewId, setViewId] = useState<string | null>(null);
  const currentId =
    scenario === null
      ? null
      : viewId && nodes.some((node) => node.id === viewId)
        ? viewId
        : landingNodeId(scenario, nodes);
  const current = currentId ? nodes.find((node) => node.id === currentId) : undefined;
  const path = useMemo(() => pathTo(nodes, currentId), [nodes, currentId]);
  const mainNodes = useMemo(() => (scenario ? mainPath(scenario, nodes) : []), [scenario, nodes]);
  const mainIds = useMemo(() => new Set(mainNodes.map((node) => node.id)), [mainNodes]);
  const children = current ? childrenOf(nodes, current.id) : [];
  const walked = current ? walkedChoices(current, children) : null;

  const [generation, setGeneration] = useState<Generation>({ kind: 'idle' });
  const [failure, setFailure] = useState<Failure | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const busy = generation.kind !== 'idle';

  /** 「本步依据」里取消勾选的推断条目：只在这一页的会话里有效，不进 store、不落库 */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [freeText, setFreeText] = useState('');

  const [navOpen, setNavOpen] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [wrapOpen, setWrapOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sedimentOpen, setSedimentOpen] = useState(false);
  const [deltaNodeId, setDeltaNodeId] = useState<string | null>(null);

  // 生成完成后焦点移到新步骤标题：读屏从新情节开始读
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusToken, setFocusToken] = useState(0);
  useEffect(() => {
    if (focusToken > 0) headingRef.current?.focus();
  }, [focusToken]);

  const castEntryId = scenario?.setup.cast[0]?.entryId;
  const castEntry = entries.find((entry) => entry.id === castEntryId);
  const blocked = !llm.configured
    ? '需要先在「设置」里配置模型'
    : !castEntry
      ? '主角条目已不存在，这个推演只能浏览、不能推进'
      : castEntry.deletedAt !== null
        ? `主角「${castEntry.title}」已被删除，到知识库回收站恢复后才能继续`
        : null;
  const canGenerate = !busy && blocked === null;

  async function runAdvance(pending: Pending) {
    setFailure(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    setGeneration({ kind: 'advancing', pending, prose: '', phase: 'generating' });
    try {
      const result = await runner.advance(
        {
          scenarioId,
          parentId: pending.parentId,
          action: pending.action,
          ...(excluded.size > 0 ? { excludedEntryIds: excluded } : {}),
        },
        {
          signal: controller.signal,
          onProse: (prose) => {
            if (!mounted.current) return;
            setGeneration((now) => (now.kind === 'advancing' ? { ...now, prose } : now));
          },
          onPhase: (phase) => {
            if (!mounted.current) return;
            setGeneration((now) => (now.kind === 'advancing' ? { ...now, phase } : now));
          },
        },
      );
      if (!mounted.current) return;
      setLocalNodes((list) => [...list, result.node]);
      setLocalScenario(result.scenario);
      setViewId(result.node.id);
      setFreeText('');
      setGeneration({ kind: 'idle' });
      setFocusToken((token) => token + 1);
      invalidate();
    } catch (cause) {
      if (!mounted.current) return;
      setGeneration({ kind: 'idle' });
      // 停止 = 回到选择前，不提示错误
      if (cause instanceof LlmError && cause.kind === 'aborted') return;
      setFailure({
        ...errorText(cause, '这一步没有生成'),
        at: pending.parentId,
        retry: { kind: 'advance', pending },
      });
      // 仓储拒绝（已走过、推演已删）或同步补摘要部分成功：刷新树，界面跟上库里的事实
      if (!(cause instanceof LlmError)) invalidate();
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  async function regenerateOptions(nodeId: string) {
    setFailure(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    setGeneration({ kind: 'options', nodeId });
    try {
      const node = await runner.regenerateOptions(
        { scenarioId, nodeId, ...(excluded.size > 0 ? { excludedEntryIds: excluded } : {}) },
        { signal: controller.signal },
      );
      if (!mounted.current) return;
      setLocalNodes((list) => [...list, node]);
      setGeneration({ kind: 'idle' });
      invalidate();
    } catch (cause) {
      if (!mounted.current) return;
      setGeneration({ kind: 'idle' });
      if (cause instanceof LlmError && cause.kind === 'aborted') return;
      setFailure({
        ...errorText(cause, '没有拿到新的选项'),
        at: nodeId,
        retry: { kind: 'options', nodeId },
      });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function stop() {
    controllerRef.current?.abort();
  }

  /** 从「更多」打开另一个面板：先关菜单，两个弹层不叠在一起 */
  function switchSheet(open: (value: boolean) => void) {
    setMoreOpen(false);
    open(true);
  }

  function retry() {
    if (!failure) return;
    if (failure.retry.kind === 'advance') void runAdvance(failure.retry.pending);
    else void regenerateOptions(failure.retry.nodeId);
  }

  /** 跳转（面包屑、导航、去这条线）：只换内存里显示的节点 + 记下 cursor，不发请求、不动主线 */
  function jumpTo(nodeId: string) {
    if (busy) return;
    setViewId(nodeId);
    setFailure(null);
    setFreeText('');
    setNavOpen(false);
    setMoreOpen(false);
    void repository.setScenarioCursor(scenarioId, nodeId).catch(() => {
      // 断点续玩的记录写失败不影响浏览：下一次跳转或推进会再写
    });
  }

  // 新建推演后带 autoStart 进来：直接发开局请求，作者不用再点一次「开始」。意图只消费一次
  const autoStart = (location.state as { autoStart?: boolean } | null)?.autoStart === true;
  const consumedAutoStart = useRef(false);
  const ready = data !== undefined && scenario !== null && scenario.novelId === novel.id;
  useEffect(() => {
    if (!autoStart || consumedAutoStart.current || !ready) return;
    consumedAutoStart.current = true;
    navigate(location.pathname, { replace: true, state: null });
    if (nodes.length === 0 && canGenerate)
      void runAdvance({ parentId: null, action: { kind: 'start' } });
    // runAdvance / canGenerate 每次渲染都是新值，不列进依赖：这里只在数据就绪的那一刻消费一次意图
  }, [autoStart, ready]);

  // 「本步依据」：按当前节点算下一步会注入什么（纯计算，不发请求）
  const preview = useMemo<ScenarioContextItem[] | null>(() => {
    if (!scenario || !current || current.ending !== null || !data) return null;
    const style =
      data.style ??
      StyleProfileSchema.parse({
        id: `style-${novel.id}`,
        novelId: novel.id,
        createdAt: 0,
        updatedAt: 0,
      });
    const prefix = buildScenarioStablePrefix({
      novel,
      style,
      norms: data.norms,
      categories,
      entries,
      scenario,
    });
    const knowledge = effectiveKnowledge({ scenario, path, entries, categories });
    const user = buildStepUserPrompt({
      knowledge,
      path,
      scenario,
      entries,
      categories,
      action: { kind: 'option', text: '' },
      excludedEntryIds: excluded,
    });
    // 行动还没选，不列「本次行动」
    return [...prefix.items, ...user.items.filter((item) => item.kind !== 'action')];
  }, [scenario, current, data, novel, categories, entries, path, excluded]);

  if (loading || !data) {
    return (
      <Page title="互动推演">
        <p className="py-10 text-center text-sm text-ink-300">加载中…</p>
      </Page>
    );
  }
  if (!scenario) {
    return (
      <Page title="互动推演">
        <EmptyState
          title="这个推演已不存在"
          description="可能已被删除。可以回写作页看看其他推演，或者开始新的一局。"
          action={
            <Button variant="primary" size="lg" onClick={() => navigate('/write')}>
              回写作页
            </Button>
          }
        />
      </Page>
    );
  }
  if (scenario.novelId !== novel.id) {
    return (
      <Page title="互动推演">
        <EmptyState
          title="这个推演属于另一部作品"
          description="到书架切换到那部作品，再从写作页进入。"
          action={
            <Button variant="primary" size="lg" onClick={() => navigate('/')}>
              去书架
            </Button>
          }
        />
      </Page>
    );
  }

  const started = nodes.length > 0 && current !== undefined;
  const staleNotice = oldMainlineNotice(scenario, nodes, data.outline);
  const onMain = current ? mainIds.has(current.id) : false;
  const mainLeafId =
    scenario.mainNodeId && nodes.some((node) => node.id === scenario.mainNodeId)
      ? scenario.mainNodeId
      : null;
  const failureHere = failure && failure.at === (started ? current!.id : null) ? failure : null;
  const advancing = generation.kind === 'advancing' ? generation : null;

  const failureBlock = failureHere ? (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal"
    >
      <p>{failureHere.message}</p>
      {failureHere.detail ? (
        <p className="text-xs break-all opacity-80">{failureHere.detail}</p>
      ) : null}
      <div>
        <Button size="sm" disabled={!canGenerate} onClick={retry}>
          重试
        </Button>
      </div>
    </div>
  ) : null;

  const generatingBlock = advancing ? (
    <section
      aria-label="正在生成"
      className="flex flex-col gap-3 rounded-2xl border border-ink-100 bg-paper-raised p-4"
    >
      <p className="text-xs text-ink-500">
        {advancing.phase === 'summarizing' ? '正在整理前情…' : '正在写这一步…'}
      </p>
      <div
        aria-live="polite"
        className="text-[0.9375rem] leading-loose whitespace-pre-wrap text-ink-900"
      >
        {advancing.prose}
      </div>
      <div>
        <Button onClick={stop}>停止</Button>
      </div>
    </section>
  ) : null;

  return (
    <Page
      title={scenario.title}
      subtitle="互动推演"
      action={
        <>
          <IconButton label="返回写作页" onClick={() => navigate('/write')}>
            <BackIcon className="h-5 w-5" />
          </IconButton>
          <IconButton label="更多" onClick={() => setMoreOpen(true)}>
            <MoreIcon className="h-5 w-5" />
          </IconButton>
        </>
      }
    >
      <div className="reading-column flex flex-col gap-4">
        {blocked ? (
          <p className="rounded-xl bg-paper-sunken px-3 py-2.5 text-sm text-ink-700">{blocked}</p>
        ) : null}

        {staleNotice ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-accent-soft px-3 py-2.5 text-sm text-ink-700">
            <p className="min-w-0 flex-1">{staleNotice}</p>
            <Button size="sm" onClick={() => navigate('/write')}>
              去写作页查看
            </Button>
          </div>
        ) : null}

        {started ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {onMain ? (
                <span className="rounded-full bg-ink-900 px-2.5 py-1 text-xs font-medium text-paper">
                  主线 · 第 {stepNumber(current!)} 步
                </span>
              ) : (
                <>
                  <span className="rounded-full bg-paper-sunken px-2.5 py-1 text-xs font-medium text-ink-700">
                    外传线 · 不在主线上
                  </span>
                  <Button
                    size="sm"
                    disabled={busy || !mainLeafId}
                    onClick={() => mainLeafId && jumpTo(mainLeafId)}
                  >
                    回到主线最新一步
                  </Button>
                </>
              )}
            </div>

            <ScenarioBreadcrumb
              path={path}
              mainIds={mainIds}
              currentId={current!.id}
              disabled={busy}
              onJump={jumpTo}
              onShowAll={() => setNavOpen(true)}
            />

            <StepBody node={current!} path={path} headingRef={headingRef} />

            {current!.ending ? (
              <EndingBlock
                node={current!}
                scenario={scenario}
                busy={busy}
                onBack={() => current!.parentId && jumpTo(current!.parentId)}
                onOpenNavigator={() => setNavOpen(true)}
              />
            ) : (
              <>
                {generatingBlock}
                {failureBlock}
                {advancing ? null : (
                  <ChoicesBlock
                    node={current!}
                    childNodes={children}
                    nodes={nodes}
                    canGenerate={canGenerate}
                    busy={busy}
                    regenerating={generation.kind === 'options'}
                    pastExpected={path.length >= scenario.setup.expectedSteps}
                    onChoose={(optionId) =>
                      void runAdvance({
                        parentId: current!.id,
                        action: { kind: 'option', optionId },
                      })
                    }
                    onRegenerate={() => void regenerateOptions(current!.id)}
                    onStop={stop}
                    onJump={jumpTo}
                  />
                )}
                {advancing ? null : (
                  <FreeActionBlock
                    node={current!}
                    walked={walked!}
                    text={freeText}
                    onText={setFreeText}
                    canGenerate={canGenerate}
                    onSubmit={(text) =>
                      void runAdvance({ parentId: current!.id, action: { kind: 'free', text } })
                    }
                    onJump={jumpTo}
                    nodes={nodes}
                  />
                )}
                {preview && !advancing ? (
                  <ContextPreview
                    items={preview}
                    onToggle={(entryId, include) =>
                      setExcluded((now) => {
                        const next = new Set(now);
                        if (include) next.delete(entryId);
                        else next.add(entryId);
                        return next;
                      })
                    }
                  />
                ) : null}
              </>
            )}
          </>
        ) : (
          <>
            <section className="flex flex-col gap-3 rounded-2xl border border-ink-100 bg-paper-raised p-4">
              <h2 className="text-base font-semibold text-ink-900">还没有开局</h2>
              <p className="text-sm text-ink-700">主角：{castEntry?.title ?? '（已不存在）'}</p>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-700">
                起点：
                {[scenario.setup.start.time, scenario.setup.start.place]
                  .filter((text) => text.trim())
                  .join(' · ')}
                {scenario.setup.start.time.trim() || scenario.setup.start.place.trim() ? '\n' : ''}
                {scenario.setup.start.situation}
              </p>
              {advancing ? null : (
                <div>
                  <Button
                    variant="primary"
                    size="lg"
                    disabled={!canGenerate}
                    onClick={() => void runAdvance({ parentId: null, action: { kind: 'start' } })}
                  >
                    开始
                  </Button>
                </div>
              )}
            </section>
            {generatingBlock}
            {failureBlock}
          </>
        )}
      </div>

      <BottomBar
        started={started}
        busy={busy}
        wrapUpNode={walked?.wrapUp ?? null}
        canWrapUp={started && current!.ending === null && canGenerate}
        onNavigator={() => setNavOpen(true)}
        onState={() => setStateOpen(true)}
        onWrapUp={() => setWrapOpen(true)}
        onJump={jumpTo}
      />

      <Sheet open={moreOpen} title="更多" onClose={() => setMoreOpen(false)}>
        <div className="flex flex-col gap-2">
          <Button block onClick={() => switchSheet(setSetupOpen)}>
            开局设定
          </Button>
          <Button block onClick={() => switchSheet(setRenameOpen)}>
            重命名
          </Button>
          {started ? (
            <>
              {/* 沉淀走大纲提案：面板里点「生成大纲」才发请求，确认后才写入 */}
              <Button block disabled={busy} onClick={() => switchSheet(setSedimentOpen)}>
                沉淀这条线
              </Button>
              <Button
                block
                disabled={!(current!.ending === null && canGenerate && !walked?.wrapUp)}
                onClick={() => switchSheet(setWrapOpen)}
              >
                收尾
              </Button>
            </>
          ) : null}
          <Button block variant="danger" onClick={() => switchSheet(setDeleteOpen)}>
            删除推演
          </Button>
        </div>
      </Sheet>

      {started ? (
        <>
          <WorldlineNavigatorSheet
            open={navOpen}
            scenario={scenario}
            nodes={nodes}
            currentId={current!.id}
            onJump={jumpTo}
            onClose={() => setNavOpen(false)}
          />
          <WorldlineStateSheet
            open={stateOpen}
            scenario={scenario}
            nodes={nodes}
            node={current!}
            entries={entries}
            categories={categories}
            failedCheckpointIds={failedCheckpoints}
            onEditDelta={(nodeId) => {
              setStateOpen(false);
              setDeltaNodeId(nodeId);
            }}
            onNodeSaved={(node) => setLocalNodes((list) => [...list, node])}
            onClose={() => setStateOpen(false)}
          />
          <WrapUpSheet
            open={wrapOpen}
            scenario={scenario}
            onSubmit={(goalId, note) => {
              setWrapOpen(false);
              void runAdvance({ parentId: current!.id, action: { kind: 'wrap-up', goalId, note } });
            }}
            onClose={() => setWrapOpen(false)}
          />
          <SedimentSheet
            open={sedimentOpen}
            novel={novel}
            scenario={scenario}
            nodes={nodes}
            currentNodeId={current!.id}
            entries={entries}
            onClose={() => setSedimentOpen(false)}
          />
        </>
      ) : null}

      {deltaNodeId && nodes.some((node) => node.id === deltaNodeId) ? (
        <DeltaEditor
          open
          scenario={scenario}
          nodes={nodes}
          node={nodes.find((node) => node.id === deltaNodeId)!}
          entries={entries}
          categories={categories}
          onSaved={(node) => {
            setLocalNodes((list) => [...list, node]);
            setDeltaNodeId(null);
          }}
          onClose={() => setDeltaNodeId(null)}
        />
      ) : null}

      <ScenarioSetupSheet
        open={setupOpen}
        novel={novel}
        scenario={scenario}
        onClose={() => setSetupOpen(false)}
        onSaved={(saved) => {
          setLocalScenario(saved);
          setSetupOpen(false);
        }}
      />
      <RenameSheet
        open={renameOpen}
        scenario={scenario}
        onSaved={(saved) => {
          setLocalScenario(saved);
          setRenameOpen(false);
        }}
        onClose={() => setRenameOpen(false)}
      />
      <DeleteScenarioDialog
        open={deleteOpen}
        scenario={scenario}
        nodeCount={nodes.length}
        entries={entries}
        onDeleted={() => navigate('/write')}
        onClose={() => setDeleteOpen(false)}
      />
    </Page>
  );
}

// ---------------------------------------------------------------- 正文区

function StepBody({
  node,
  path,
  headingRef,
}: {
  node: ScenarioNode;
  path: readonly ScenarioNode[];
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  // 祖先的差异在这一步生成之后被改过：这一步依据的是当时的事实，不重新生成，只提示
  const stale = path.some(
    (item) =>
      item.id !== node.id && item.deltaEditedAt !== null && item.deltaEditedAt > node.createdAt,
  );
  return (
    <article className="flex flex-col gap-3">
      <h2
        // 生成完成后焦点移到这里；tabIndex -1 让它可被程序聚焦，又不进 Tab 序列
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold text-ink-900 focus:outline-none lg:text-lg"
      >
        {stepHeading(node)}
      </h2>
      <div className="text-[0.9375rem] leading-loose whitespace-pre-wrap text-ink-900">
        {node.plot}
      </div>
      {node.notices.length > 0 ? (
        <details className="rounded-xl bg-paper-sunken px-3 py-2.5 text-sm text-ink-700">
          <summary className="cursor-pointer">
            这一步有 {node.notices.length} 处变化没有记下
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs leading-relaxed">
            {node.notices.map((notice, index) => (
              <li key={`${index}-${notice.message}`}>{notice.message}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {stale ? (
        <p className="rounded-xl bg-paper-sunken px-3 py-2.5 text-xs text-ink-500">
          生成时依据的是旧事实：之前某一步的变化在这一步生成之后被改过。
        </p>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------- 挑战与选项

function ChoicesBlock({
  node,
  childNodes,
  nodes,
  canGenerate,
  busy,
  regenerating,
  pastExpected,
  onChoose,
  onRegenerate,
  onStop,
  onJump,
}: {
  node: ScenarioNode;
  /** 当前节点的子节点：算「已走过」 */
  childNodes: readonly ScenarioNode[];
  nodes: readonly ScenarioNode[];
  canGenerate: boolean;
  busy: boolean;
  regenerating: boolean;
  pastExpected: boolean;
  onChoose: (optionId: string) => void;
  onRegenerate: () => void;
  onStop: () => void;
  onJump: (nodeId: string) => void;
}) {
  const walked = walkedChoices(node, childNodes);
  const allWalked =
    node.options.length > 0 && node.options.every((option) => walked.options.has(option.id));
  return (
    <section aria-label="挑战与选项" className="flex flex-col gap-3">
      {node.challenge.trim() ? (
        <p className="rounded-xl border-l-4 border-ink-900 bg-paper-raised px-3 py-2.5 text-[0.9375rem] leading-relaxed text-ink-900">
          {node.challenge}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {node.options.map((option) => {
          const child = walked.options.get(option.id);
          return (
            <li key={option.id} className="flex items-stretch gap-2">
              <button
                type="button"
                disabled={child !== undefined || !canGenerate}
                onClick={() => onChoose(option.id)}
                className={[
                  'flex min-h-12 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed',
                  child
                    ? 'border-ink-100 bg-paper-sunken text-ink-500'
                    : 'border-ink-300 bg-paper-raised text-ink-900 enabled:hover:bg-paper-sunken',
                ].join(' ')}
              >
                <span className="min-w-0 flex-1 text-[0.9375rem]">{option.text}</span>
                <span className="rounded-full bg-paper-sunken px-2 py-0.5 text-xs text-ink-700">
                  {OPTION_TENDENCY_LABELS[option.tendency]}
                </span>
                <span
                  className={[
                    'rounded-full px-2 py-0.5 text-xs',
                    option.risk === 'high'
                      ? 'bg-seal-soft text-seal'
                      : 'bg-paper-sunken text-ink-700',
                  ].join(' ')}
                >
                  {OPTION_RISK_LABELS[option.risk]}
                </span>
                {child ? <span className="text-xs font-medium text-ink-500">已走过</span> : null}
              </button>
              {child ? (
                <Button
                  disabled={busy}
                  className="shrink-0 self-center"
                  onClick={() => onJump((latestLeafOf(nodes, child.id) ?? child).id)}
                >
                  去这条线<span className="sr-only">：{option.text}</span>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {walked.free.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-ink-700">这一步走过的其他行动</p>
          <ul className="flex flex-col gap-1.5">
            {walked.free.map((item) => (
              <li key={item.child.id} className="flex items-center gap-2 text-sm text-ink-700">
                <span className="min-w-0 flex-1">{item.text}</span>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => onJump((latestLeafOf(nodes, item.child.id) ?? item.child).id)}
                >
                  去这条线<span className="sr-only">：{item.text}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {allWalked && node.options.length < MAX_SCENARIO_OPTIONS ? (
        regenerating ? (
          <div className="flex items-center gap-2 text-sm text-ink-500">
            <span aria-live="polite">正在想新的选项…</span>
            <Button size="sm" onClick={onStop}>
              停止
            </Button>
          </div>
        ) : (
          <div>
            <Button disabled={!canGenerate} onClick={onRegenerate}>
              再给几个选项
            </Button>
          </div>
        )
      ) : null}

      {pastExpected ? (
        <p className="text-xs text-ink-500">
          已超出预计步数，可以收尾了：底部「收尾」会在这一步写出结局。
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- 自由输入

function FreeActionBlock({
  node,
  walked,
  nodes,
  text,
  onText,
  canGenerate,
  onSubmit,
  onJump,
}: {
  node: ScenarioNode;
  walked: WalkedChoices;
  nodes: readonly ScenarioNode[];
  text: string;
  onText: (text: string) => void;
  canGenerate: boolean;
  onSubmit: (text: string) => void;
  onJump: (nodeId: string) => void;
}) {
  const trimmed = text.trim();
  const tooLong = trimmed.length > SCENARIO_LIMITS.freeAction;
  const key = normalizeAction(trimmed);
  // 已走过的行动：选项（按原文）与自由输入
  const walkedActions = [
    ...node.options
      .filter((option) => walked.options.has(option.id))
      .map((option) => ({ text: option.text, child: walked.options.get(option.id)! })),
    ...walked.free.map((item) => ({ text: item.text, child: item.child })),
  ];
  // 规范化后相同 → 阻止；字符相似 → 只提醒（作者是作者，误阻比误放糟）
  const same = key ? walkedActions.find((item) => normalizeAction(item.text) === key) : undefined;
  const similar =
    key && !same
      ? walkedActions.find(
          (item) => actionSimilarity(item.text, trimmed) >= ACTION_SIMILARITY_THRESHOLD,
        )
      : undefined;
  const disabled = !canGenerate || validateFreeAction(text) !== undefined || same !== undefined;

  function submit() {
    if (disabled) return;
    onSubmit(trimmed);
  }

  return (
    <section aria-label="自由输入" className="flex flex-col gap-2">
      <TextAreaField
        label="或者，写下主角要做的事"
        rows={2}
        value={text}
        hint={
          <span className={tooLong ? 'text-seal' : undefined}>
            {trimmed.length} / {SCENARIO_LIMITS.freeAction}
            {' · '}这是主角的尝试，结果按世界规则判定
          </span>
        }
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          // 桌面 ⌘/Ctrl+Enter 提交；输入法组字时的回车是选词，不能当提交
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {same ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-seal">
          <span>这个行动在这一步已经走过了</span>
          <Button
            size="sm"
            onClick={() => onJump((latestLeafOf(nodes, same.child.id) ?? same.child).id)}
          >
            去那条线看看
          </Button>
        </div>
      ) : similar ? (
        <p className="text-xs text-ink-500">和已走过的「{similar.text}」很像</p>
      ) : null}
      <div>
        <Button variant="primary" disabled={disabled} onClick={submit}>
          {similar ? '仍然这样做' : '这样做'}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 结局

function EndingBlock({
  node,
  scenario,
  busy,
  onBack,
  onOpenNavigator,
}: {
  node: ScenarioNode;
  scenario: Scenario;
  busy: boolean;
  onBack: () => void;
  onOpenNavigator: () => void;
}) {
  const ending = node.ending!;
  const wanted = node.arrivedBy.kind === 'wrap-up' ? node.arrivedBy.goalId : null;
  const wantedIndex = wanted ? scenario.setup.goals.findIndex((goal) => goal.id === wanted) : -1;
  return (
    <section
      aria-label="结局"
      className="flex flex-col gap-3 rounded-2xl border border-ink-100 bg-paper-raised p-4"
    >
      <p className="text-base font-semibold text-ink-900">{endingLabel(ending)}</p>
      <p className="text-sm leading-relaxed text-ink-700">起因：{ending.cause}</p>
      {ending.kind === 'bad' ? (
        <p className="text-sm text-ink-700">这条线到此结束，但你可以回到任何一步重新选择</p>
      ) : null}
      {wantedIndex >= 0 && ending.goalId !== wanted ? (
        <p className="text-xs text-ink-500">
          你要的是 G{wantedIndex + 1}，这条线写出的是：{endingLabel(ending)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {node.parentId ? (
          <Button variant="primary" disabled={busy} onClick={onBack}>
            回到上一个挑战
          </Button>
        ) : null}
        <Button disabled={busy} onClick={onOpenNavigator}>
          从路径里选一步回去
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 本步依据

const PREVIEW_GROUPS: { kinds: ScenarioContextItem['kind'][]; title: string; note: string }[] = [
  {
    kinds: ['meta', 'norm', 'pinned', 'cast', 'setup', 'rules'],
    title: '固定前提',
    note: '作者定下的约束，全量注入',
  },
  { kinds: ['related', 'inferred', 'preset'], title: '本线相关设定', note: '推断来的条目可以取消' },
  {
    kinds: ['worldline', 'earlier', 'gap', 'recent', 'director'],
    title: '这条线的事实',
    note: '去掉会让情节与本线矛盾',
  },
];

function ContextPreview({
  items,
  onToggle,
}: {
  items: ScenarioContextItem[];
  onToggle: (entryId: string, include: boolean) => void;
}) {
  const baseId = useId();
  const total = items.filter((item) => item.included).reduce((sum, item) => sum + item.tokens, 0);
  const excludedCount = items.filter((item) => item.kind === 'inferred' && !item.included).length;
  return (
    <details className="rounded-xl border border-ink-100 bg-paper-raised px-3 py-2.5 text-sm text-ink-700">
      <summary className="cursor-pointer">本步依据 · 约 {total} tokens</summary>
      <p className="mt-2 text-xs text-ink-500">下一步会带上这些内容。</p>
      {excludedCount > 0 ? (
        <p className="mt-1 text-xs text-ink-700">已取消 {excludedCount} 条，下一步不会带上</p>
      ) : null}
      {PREVIEW_GROUPS.map((group) => {
        const list = items.filter((item) => group.kinds.includes(item.kind));
        if (list.length === 0) return null;
        return (
          <div key={group.title} className="mt-3">
            <p className="text-xs font-medium text-ink-900">
              {group.title}
              <span className="ml-2 font-normal text-ink-500">{group.note}</span>
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {list.map((item) => {
                const id = `${baseId}-${item.kind}-${item.id}`;
                return (
                  <li key={`${item.kind}-${item.id}`} className="flex items-center gap-2 text-xs">
                    {item.kind === 'inferred' ? (
                      <>
                        <input
                          id={id}
                          type="checkbox"
                          checked={item.included}
                          onChange={(event) => onToggle(item.id, event.target.checked)}
                          className="h-4 w-4 shrink-0 accent-ink-900"
                        />
                        <label htmlFor={id} className="min-w-0 flex-1">
                          {item.label}（推断）
                        </label>
                      </>
                    ) : (
                      <span className="min-w-0 flex-1">{item.label}</span>
                    )}
                    <span className="shrink-0 text-ink-500">约 {item.tokens}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </details>
  );
}

// ---------------------------------------------------------------- 底部操作栏

function BottomBar({
  started,
  busy,
  wrapUpNode,
  canWrapUp,
  onNavigator,
  onState,
  onWrapUp,
  onJump,
}: {
  started: boolean;
  busy: boolean;
  wrapUpNode: ScenarioNode | null;
  canWrapUp: boolean;
  onNavigator: () => void;
  onState: () => void;
  onWrapUp: () => void;
  onJump: (nodeId: string) => void;
}) {
  const hintId = useId();
  const unavailable = started ? undefined : hintId;
  const itemClass =
    'tap-target flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl text-xs font-medium text-ink-700 transition-colors enabled:hover:bg-paper-sunken disabled:cursor-not-allowed disabled:text-ink-300';
  return (
    <div
      className={[
        'sticky z-20 mt-6 rounded-2xl border border-ink-100 bg-paper-raised/95 p-1.5 backdrop-blur',
        // 窄屏贴在底部 Tab 栏之上（含安全区）；桌面端没有底部栏
        'bottom-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom,0px)+0.5rem)] lg:bottom-4',
      ].join(' ')}
    >
      {started ? null : (
        <p id={hintId} className="sr-only">
          开局之后可用
        </p>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          className={itemClass}
          disabled={!started}
          aria-disabled={!started || undefined}
          aria-describedby={unavailable}
          onClick={onNavigator}
        >
          <ReorderIcon className="h-5 w-5" />
          世界线
        </button>
        <button
          type="button"
          className={itemClass}
          disabled={!started}
          aria-disabled={!started || undefined}
          aria-describedby={unavailable}
          onClick={onState}
        >
          <FolderIcon className="h-5 w-5" />
          本线状态
        </button>
        {wrapUpNode ? (
          <button
            type="button"
            className={itemClass}
            disabled={busy}
            onClick={() => onJump(wrapUpNode.id)}
          >
            <CheckIcon className="h-5 w-5" />
            查看已写的结局
          </button>
        ) : (
          <button
            type="button"
            className={itemClass}
            disabled={!canWrapUp}
            aria-disabled={!canWrapUp || undefined}
            aria-describedby={unavailable}
            onClick={onWrapUp}
          >
            <CheckIcon className="h-5 w-5" />
            收尾
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 重命名

function RenameSheet({
  open,
  scenario,
  onSaved,
  onClose,
}: {
  open: boolean;
  scenario: Scenario;
  onSaved: (scenario: Scenario) => void;
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const [title, setTitle] = useState(scenario.title);
  const [error, setError] = useState<string | undefined>();
  const seedRef = useRef(scenario.title);
  seedRef.current = scenario.title;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTitle(seedRef.current);
      setError(undefined);
    }
    wasOpen.current = open;
  }, [open]);

  async function save() {
    const trimmed = title.trim();
    if (!trimmed) return setError('推演名称不能为空');
    if (trimmed.length > SCENARIO_LIMITS.title)
      return setError(`推演名称不能超过 ${SCENARIO_LIMITS.title} 字`);
    try {
      const saved = await repository.updateScenario(scenario.id, { title: trimmed });
      invalidate();
      onSaved(saved);
    } catch (cause) {
      setError(errorText(cause, '保存失败').message);
    }
  }

  return (
    <Sheet
      open={open}
      title="重命名推演"
      size="dialog"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="lg" block onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" block onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <TextField
        label="推演名称"
        value={title}
        {...(error ? { error } : {})}
        onChange={(event) => setTitle(event.target.value)}
      />
    </Sheet>
  );
}
