import { useEffect, useMemo, useRef, useState } from 'react';
import { estimateTokens, formatTokens } from '@/context/tokens';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import {
  lastSedimentedNodeOf,
  pathTo,
  sedimentRange,
  sideSedimentOverlaps,
  type SedimentSpan,
} from '@/domain/scenario';
import {
  StyleProfileSchema,
  type KnowledgeEntry,
  type Novel,
  type OutlineNode,
  type Scenario,
  type ScenarioNode,
} from '@/domain/schema';
import { useLlm } from '@/llm/useLlm';
import { buildCreateProposal, newBatchId } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import { Button } from '@/ui/Button';
import { RadioList } from '@/ui/Controls';
import { Sheet } from '@/ui/Sheet';
import { ProposalInbox } from '../proposals/ProposalInbox';
import {
  buildPathOutlinePrompt,
  buildPathOutlineSchema,
  forkPreludeText,
  serializeScenarioOutline,
  type ScenarioOutlinePayload,
} from './pathOutline';
import { errorText } from './scenarioView';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'review'; batchId: string }
  | { kind: 'error'; message: string; detail?: string };

/** 「第 13–24 步」；首尾相同时「第 13 步」 */
function spanLabel(span: SedimentSpan): string {
  return span.from === span.to ? `第 ${span.from} 步` : `第 ${span.from}–${span.to} 步`;
}

/** 顶层卷按 order 排；返回某个大纲节点所在卷的序号（从 1 起），找不到时 null */
function volumeOrdinalOf(outline: readonly OutlineNode[], nodeId: string): number | null {
  const node = outline.find((item) => item.id === nodeId);
  if (!node) return null;
  const volumeId = node.parentId ?? node.id;
  const volumes = outline
    .filter((item) => item.parentId === null)
    .sort((a, b) => a.order - b.order);
  const index = volumes.findIndex((item) => item.id === volumeId);
  return index < 0 ? null : index + 1;
}

/**
 * 「沉淀这条线」（设计 §7.2 第 1–5 步）。模式由位置决定：当前节点在主线上 → 主线大纲，否则 → 外传。
 * 打开面板只做本地计算（范围、规模、预估 tokens），作者点「生成大纲」才发请求；结果成为一个
 * scenarioOutline 提案，在面板里确认后才写进大纲 / 外传 —— 推演产出进入全书的唯一通道仍是提案。
 */
export function SedimentSheet({
  open,
  novel,
  scenario,
  nodes,
  currentNodeId,
  entries,
  onClose,
}: {
  open: boolean;
  novel: Novel;
  scenario: Scenario;
  nodes: readonly ScenarioNode[];
  currentNodeId: string;
  /** 本书全部条目（含限定的）：只用来取主角名 */
  entries: readonly KnowledgeEntry[];
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const llm = useLlm();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  /** 有可追加的外传时默认追加；作者可改选「另建一部外传」 */
  const [target, setTarget] = useState<'append' | 'new'>('append');
  const controllerRef = useRef<AbortController | null>(null);

  const { data } = useRepoQuery(
    async (repo) => {
      const [outline, sideStories, chapters, style, norms, scenarios] = await Promise.all([
        repo.listOutline(novel.id),
        repo.listSideStories(novel.id),
        repo.listChapters(novel.id),
        repo.getStyleProfile(novel.id),
        repo.listWritingNorms(novel.id),
        repo.listScenarios(novel.id),
      ]);
      return { outline, sideStories, chapters, style: style ?? null, norms, scenarios };
    },
    [novel.id],
  );

  // 每次打开从头来：上一次没处理完的提案仍在写作页的待确认里
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPhase({ kind: 'idle' });
      setTarget('append');
    }
    if (!open) controllerRef.current?.abort();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const path = useMemo(() => pathTo(nodes, currentNodeId), [nodes, currentNodeId]);
  const range = useMemo(
    () =>
      data
        ? sedimentRange({
            scenario,
            nodes,
            currentNodeId,
            outline: data.outline,
            sideStories: data.sideStories,
            chapters: data.chapters,
          })
        : null,
    [data, scenario, nodes, currentNodeId],
  );

  const appendStory =
    range?.mode === 'side' && range.append
      ? (data?.sideStories.find((story) => story.id === range.append!.sideStoryId) ?? null)
      : null;
  const appending = appendStory !== null && target === 'append';
  const span: SedimentSpan | null =
    range === null ? null : range.mode === 'side' && appending ? range.append!.span : range.span;

  const castName =
    entries.find((entry) => entry.id === scenario.setup.cast[0]?.entryId)?.title ?? '';

  const prompt = useMemo(() => {
    if (!data || !range || !span) return null;
    const steps = span.nodeIds
      .map((id) => path.find((node) => node.id === id))
      .filter((node): node is ScenarioNode => node !== undefined);
    // 外传的前情：新建 = 到分叉点；追加 = 到那部外传已沉淀的最后一步
    const startAt = path.findIndex((node) => node.id === span.nodeIds[0]);
    const prelude =
      range.mode === 'side' && startAt > 0 ? forkPreludeText(path, path[startAt - 1]!.id) : '';
    const style =
      data.style ??
      StyleProfileSchema.parse({
        id: `style-${novel.id}`,
        novelId: novel.id,
        createdAt: 0,
        updatedAt: 0,
      });
    return buildPathOutlinePrompt({
      novel,
      style,
      norms: data.norms,
      scenario,
      castName,
      mode: range.mode,
      appendTo: appending && appendStory ? { title: appendStory.title } : null,
      steps,
      existingVolumeTitles: data.outline
        .filter((node) => node.parentId === null)
        .sort((a, b) => a.order - b.order)
        .map((node) => node.title),
      prelude,
    });
  }, [data, range, span, path, novel, scenario, castName, appending, appendStory]);

  async function generate() {
    if (!range || !span || !prompt) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase({ kind: 'running' });
    try {
      const result = await llm.runStructured('path-to-outline', {
        schema: buildPathOutlineSchema(span.from, span.to),
        schemaName: 'PathOutline',
        system: prompt.system,
        user: prompt.user,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const newSide = range.mode === 'side' && !appending;
      const payload: ScenarioOutlinePayload = {
        scenarioId: scenario.id,
        mode: range.mode,
        range: { from: span.from, to: span.to },
        nodeIds: span.nodeIds,
        forkNodeId: range.mode === 'side' ? range.forkNodeId : null,
        appendToSideStoryId: appending && appendStory ? appendStory.id : null,
        // 只有新建外传才有名称与简介；模型没给名称时先用推演名，作者在提案里改
        sideTitle: newSide ? result.data.sideTitle.trim() || scenario.title.slice(0, 40) : '',
        sideSynopsis: newSide ? result.data.sideSynopsis.trim() : '',
        outlineText: serializeScenarioOutline(result.data, range.mode),
      };
      const batchId = newBatchId();
      const where =
        range.mode === 'main' ? '主线大纲' : appending ? `外传《${appendStory!.title}》` : '外传';
      const proposal = buildCreateProposal({
        novelId: novel.id,
        batchId,
        origin: 'generate',
        target: 'scenarioOutline',
        label: `沉淀为${where} · 推演《${scenario.title}》${spanLabel(span)}`,
        specs: fieldSpecsFor('scenarioOutline'),
        sourceRef: `推演《${scenario.title}》`,
        payload,
      });
      await repository.createProposals([proposal]);
      invalidate();
      setPhase({ kind: 'review', batchId });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setPhase({ kind: 'error', ...errorText(cause, '没有生成大纲') });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  // 主线已有大纲的规模、以及来自其他推演的章数（由作者判断要不要接着追加）
  const outline = data?.outline ?? [];
  const otherScenarioChapters = new Map<string, number>();
  for (const node of outline) {
    const source = node.scenarioSource;
    if (!source || source.scenarioId === scenario.id) continue;
    otherScenarioChapters.set(
      source.scenarioId,
      (otherScenarioChapters.get(source.scenarioId) ?? 0) + 1,
    );
  }
  const otherHints = [...otherScenarioChapters].map(([id, count]) => {
    const title = data?.scenarios.find((item) => item.id === id)?.title ?? '已删除的推演';
    return `本书主线里已有来自推演《${title}》的 ${count} 章`;
  });

  // 补洞：洞前一步所在的卷，提示作者补出的卷可以移到它之后
  let holeHint = '';
  if (range?.mode === 'main' && range.fillsHole && span) {
    const before = path.find((node) => node.depth === span.from - 2);
    const covering = before
      ? outline.find(
          (node) =>
            node.scenarioSource?.scenarioId === scenario.id &&
            node.scenarioSource.nodeIds.includes(before.id),
        )
      : undefined;
    const ordinal = covering ? volumeOrdinalOf(outline, covering.id) : null;
    holeHint = ordinal
      ? `补出的卷会放在大纲末尾，可在大纲树里用「调整位置」移到第 ${ordinal} 卷之后`
      : '补出的卷会放在大纲末尾，可在大纲树里用「调整位置」移到合适的位置';
  }

  // 已沉淀为外传：当前这一步正好是某部外传最后一章的最后一步
  const sedimentedInto =
    range?.mode === 'side'
      ? (data?.sideStories ?? []).filter(
          (story) =>
            lastSedimentedNodeOf(story.id, scenario.id, data?.chapters ?? []) === currentNodeId,
        )
      : [];

  // 一段已沉淀为外传的路径后来成了主线（设计 §11）：只提示，仍允许沉淀进主线，外传留不留由作者决定
  const sideOverlaps =
    range?.mode === 'main' && span && data
      ? sideSedimentOverlaps({
          scenarioId: scenario.id,
          span,
          nodes,
          sideStories: data.sideStories,
          chapters: data.chapters,
        })
      : [];

  const busy = phase.kind === 'running';
  const estimated = prompt ? estimateTokens(`${prompt.system}\n${prompt.user}`) : 0;

  return (
    <Sheet
      open={open}
      title="沉淀这条线"
      description="把这段推演整理成大纲，确认后才写入。"
      onClose={onClose}
    >
      {!data || !range ? (
        <p className="py-6 text-center text-sm text-ink-300">加载中…</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5 rounded-xl bg-paper-sunken p-3 text-sm text-ink-700">
            <p className="font-medium text-ink-900">
              {range.mode === 'main' ? '沉淀为本书主线大纲' : '这一步不在主线上，沉淀为外传'}
            </p>
            {span ? (
              <p>
                {range.mode === 'main' && range.fillsHole ? '补沉淀' : '沉淀'}
                {spanLabel(span)}，共 {span.nodeIds.length} 步
              </p>
            ) : (
              <p>这条线已经全部沉淀</p>
            )}
            {holeHint ? <p className="text-xs text-ink-500">{holeHint}</p> : null}
            {range.mode === 'main' ? (
              <p className="text-xs text-ink-500">
                本书主线已有 {outline.length} 个大纲节点，新的卷会追加在最后。
              </p>
            ) : null}
            {range.mode === 'main'
              ? otherHints.map((hint) => (
                  <p key={hint} className="text-xs text-ink-500">
                    {hint}
                  </p>
                ))
              : null}
            {sideOverlaps.map(({ sideStory, from, to }) => (
              <p key={`overlap-${sideStory.id}`} className="text-xs text-ink-500">
                其中{spanLabel({ from, to, nodeIds: [] })}已沉淀为外传《{sideStory.title}》
              </p>
            ))}
            {sedimentedInto.map((story) => (
              <p key={story.id} className="text-xs text-ink-500">
                到这一步为止已沉淀进外传《{story.title}》，继续推进后可以接着追加
              </p>
            ))}
            {span ? (
              <p className="text-xs text-ink-500">预估输入 {formatTokens(estimated)}</p>
            ) : null}
          </div>

          {range.mode === 'side' && appendStory && range.append ? (
            <RadioList
              label="沉淀到哪里"
              value={target}
              options={[
                {
                  value: 'append',
                  label: `追加到外传《${appendStory.title}》`,
                  description: `接着它的最后一章，${spanLabel(range.append.span)}`,
                },
                {
                  value: 'new',
                  label: '另建一部外传',
                  description: range.span
                    ? `从分叉点之后，${spanLabel(range.span)}`
                    : '从分叉点之后',
                },
              ]}
              onChange={(value) => {
                setTarget(value);
                setPhase({ kind: 'idle' });
              }}
            />
          ) : null}

          {phase.kind === 'review' ? (
            <ProposalInbox
              novelId={novel.id}
              batchId={phase.batchId}
              acceptAllLabel="采用这份大纲"
              onSettled={() => setPhase({ kind: 'idle' })}
            />
          ) : (
            <>
              <Button
                variant="primary"
                size="lg"
                block
                disabled={!llm.configured || !span || busy}
                onClick={() => void generate()}
              >
                {busy ? '正在生成大纲…' : '生成大纲'}
              </Button>
              {!llm.configured ? (
                <p className="text-xs text-ink-500">需要先在「设置」里配置模型。</p>
              ) : null}
            </>
          )}

          {phase.kind === 'error' ? (
            <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5 text-sm text-seal">
              <p>{phase.message}</p>
              {phase.detail ? (
                <p className="mt-1 text-xs break-all opacity-80">{phase.detail}</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
