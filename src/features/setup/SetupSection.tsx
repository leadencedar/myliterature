import { useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import { formatTokens } from '@/context/tokens';
import type { Category, Novel, Proposal, StyleProfile, WritingNorm } from '@/domain/schema';
import { normsInScope } from '@/domain/writingNorm';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { buildCreateProposal, buildReplaceProposal, newBatchId } from '@/proposal/build';
import { normTokens } from '@/prompt/sections';
import { entryFieldSpecs, fieldSpecsFor } from '@/proposal/fields';
import {
  buildOutlineDrafts,
  countOutlineNodes,
  serializeOutlineTree,
} from '@/proposal/outlineText';
import { Button } from '@/ui/Button';
import { SegmentedControl } from '@/ui/Controls';
import { TextAreaField } from '@/ui/Field';
import { Section } from '@/ui/Page';
import { ProposalInbox } from '../proposals/ProposalInbox';
import {
  SCALES,
  buildSetupSchema,
  buildSetupSystemPrompt,
  buildSetupUserPrompt,
  findScale,
  toOutlineDrafts,
  type SetupEntryDraft,
} from './projectSetup';

type Phase =
  | { kind: 'form' }
  | { kind: 'generating'; note: string }
  | { kind: 'review'; batchId: string; summary: string }
  | { kind: 'error'; message: string; detail?: string };

/**
 * 一句话立项。
 *
 * 产品的第一个关键时刻：用户只给一句话，拿到一整套可开写的地基。
 * 生成结果同样不直接落库，而是作为一批提案进入确认界面 ——
 * 世界观与人物按条呈现，大纲作为一整份文本呈现。
 */
export function SetupSection({ novel }: { novel: Novel }) {
  const { data } = useRepoQuery(
    async (repo) => {
      const [categories, style, entries, outline, writingNorms] = await Promise.all([
        repo.listCategories(novel.id),
        repo.getStyleProfile(novel.id),
        repo.listEntries(novel.id),
        repo.listOutline(novel.id),
        // 只用于表单里那行「将带上 N 份写作规范」的提示；生成时另从仓储读最新值
        repo.listWritingNorms(novel.id),
      ]);
      return { categories, style, entryCount: entries.length, outline, writingNorms };
    },
    [novel.id],
  );

  if (!data?.style) return null;

  const worldCategory = data.categories.find((item) => item.kind === 'worldbuilding');
  const characterCategory = data.categories.find((item) => item.kind === 'character');
  if (!worldCategory || !characterCategory) return null;

  const hasContent = data.entryCount > 0 || data.outline.length > 0;

  return (
    <Section
      title={hasContent ? '重新立项' : '从一句话开始'}
      description={
        hasContent
          ? '再生成一次世界观、人物与大纲。已有条目不会被删除，新内容以待确认项呈现。'
          : '写下你想讲的故事，AI 会据此生成世界观设定、人物小传与全书大纲，全部需要你确认后才会保存。'
      }
    >
      <SetupForm
        novel={novel}
        style={data.style}
        worldCategory={worldCategory}
        characterCategory={characterCategory}
        existingOutline={data.outline}
        writingNorms={data.writingNorms}
        collapsedByDefault={hasContent}
      />
    </Section>
  );
}

function SetupForm({
  novel,
  style,
  worldCategory,
  characterCategory,
  existingOutline,
  writingNorms,
  collapsedByDefault,
}: {
  novel: Novel;
  style: StyleProfile;
  worldCategory: Category;
  characterCategory: Category;
  existingOutline: Parameters<typeof buildOutlineDrafts>[0];
  writingNorms: WritingNorm[];
  collapsedByDefault: boolean;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const llm = useLlm();

  const [expanded, setExpanded] = useState(!collapsedByDefault);
  const [oneLiner, setOneLiner] = useState(novel.oneLiner);
  const [scaleId, setScaleId] = useState('medium');
  const [extra, setExtra] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  // 立项没有逐次注入清单，作用范围就是控制点；这一行让注入量可见。N 为 0 时不渲染，界面与没有规范时一致
  const planningNorms = normsInScope(writingNorms, 'planning');
  const planningTokens = planningNorms.reduce((sum, norm) => sum + normTokens(norm), 0);

  async function generate() {
    if (!oneLiner.trim()) {
      setPhase({ kind: 'error', message: '请先写下你想讲的故事' });
      return;
    }

    setPhase({ kind: 'generating', note: '正在构思世界观与大纲…' });
    try {
      // 一句话是用户自己写的，不属于 AI 产出，直接落库
      if (oneLiner.trim() !== novel.oneLiner) {
        await repository.updateNovel(novel.id, { oneLiner: oneLiner.trim() });
      }

      // 规范在发请求前从仓储读最新值，不用上面查询拿到的那份：那份只负责提示行的可见性。
      // 读取失败走下面现有的 catch → 错误态
      const norms = await repository.listWritingNorms(novel.id);

      const scale = findScale(scaleId);
      const result = await llm.runStructured('project-setup', {
        schema: buildSetupSchema(worldCategory.fieldTemplate, characterCategory.fieldTemplate),
        schemaName: 'ProjectSetup',
        system: buildSetupSystemPrompt(novel, style, worldCategory, characterCategory, norms),
        user: buildSetupUserPrompt({
          oneLiner: oneLiner.trim(),
          scale,
          ...(extra ? { extra } : {}),
        }),
        onAttempt: ({ repairing }) =>
          setPhase({
            kind: 'generating',
            note: repairing ? '输出格式有偏差，正在请模型修正…' : '正在构思世界观与大纲…',
          }),
      });

      // 显式给出阅读顺序：世界观 → 人物 → 大纲
      const batchId = newBatchId();
      let order = 0;
      const proposals: Proposal[] = [
        ...result.data.worldbuilding.map((entry) =>
          entryProposal({
            novelId: novel.id,
            batchId,
            order: order++,
            category: worldCategory,
            prefix: '世界观',
            entry,
          }),
        ),
        ...result.data.characters.map((entry) =>
          entryProposal({
            novelId: novel.id,
            batchId,
            order: order++,
            category: characterCategory,
            prefix: '人物',
            entry,
          }),
        ),
        outlineProposal({
          novelId: novel.id,
          batchId,
          order: order++,
          outline: result.data.outline,
          existingOutline,
        }),
      ];

      await repository.createProposals(proposals);
      invalidate();

      const nodeCount = countOutlineNodes(toOutlineDrafts(result.data.outline));
      setPhase({
        kind: 'review',
        batchId,
        summary: `世界观 ${result.data.worldbuilding.length} 条 · 人物 ${result.data.characters.length} 位 · 大纲 ${nodeCount} 个节点`,
      });
    } catch (cause) {
      const error = cause instanceof LlmError ? cause : undefined;
      setPhase({
        kind: 'error',
        message: error?.message ?? (cause instanceof Error ? cause.message : '生成失败'),
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  }

  if (!expanded) {
    return (
      <Button variant="secondary" size="lg" block onClick={() => setExpanded(true)}>
        重新生成立项内容
      </Button>
    );
  }

  if (phase.kind === 'review') {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-xl bg-accent-soft px-3 py-2.5 text-sm text-accent">
          已生成 {phase.summary}。请逐项确认，可直接修改后采用。
        </p>
        <ProposalInbox
          novelId={novel.id}
          batchId={phase.batchId}
          acceptAllLabel="全部写入知识库"
          onSettled={() => setPhase({ kind: 'form' })}
        />
      </div>
    );
  }

  return (
    <>
      <TextAreaField
        label="我想讲一个什么故事"
        rows={4}
        value={oneLiner}
        placeholder="例如：一个失忆的剑客发现自己就是三年前灭门案的凶手。"
        hint="写得具体一点效果更好：谁、处境、最核心的那个转折。"
        onChange={(event) => setOneLiner(event.target.value)}
      />

      <SegmentedControl
        label="篇幅"
        value={scaleId}
        options={SCALES.map((scale) => ({
          value: scale.id,
          label: scale.label,
          description: `${scale.words}。${scale.outlineRequirement.split('\n')[0]}`,
        }))}
        onChange={setScaleId}
      />

      <TextAreaField
        label="额外要求（可选）"
        rows={2}
        value={extra}
        placeholder="例如：女主视角；不要穿越；结局要留悬念。"
        onChange={(event) => setExtra(event.target.value)}
      />

      {planningNorms.length > 0 ? (
        <p className="text-xs text-ink-500">
          将带上 {planningNorms.length} 份写作规范（{formatTokens(planningTokens)}）
        </p>
      ) : null}

      <Button
        variant="primary"
        size="lg"
        block
        disabled={!llm.configured || phase.kind === 'generating'}
        onClick={generate}
      >
        {phase.kind === 'generating' ? '生成中…' : '生成世界观与大纲'}
      </Button>

      {!llm.configured ? (
        <p className="text-xs text-ink-500">需要先在「设置」里配置模型。</p>
      ) : null}

      {phase.kind === 'generating' ? (
        <p aria-live="polite" className="text-center text-xs text-ink-500">
          {phase.note}
          <br />
          这一步会让模型做较多推理，通常需要一到两分钟。
        </p>
      ) : null}

      {phase.kind === 'error' ? (
        <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5">
          <p className="text-sm text-seal">{phase.message}</p>
          {phase.detail ? (
            <p className="mt-1 break-words text-xs text-ink-500">{phase.detail}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function entryProposal({
  novelId,
  batchId,
  order,
  category,
  prefix,
  entry,
}: {
  novelId: string;
  batchId: string;
  order: number;
  category: Category;
  prefix: string;
  entry: SetupEntryDraft;
}): Proposal {
  return buildCreateProposal({
    novelId,
    batchId,
    order,
    origin: 'generate',
    target: 'knowledgeEntry',
    label: `${prefix} · ${entry.title}`,
    specs: entryFieldSpecs(category),
    payload: {
      categoryId: category.id,
      title: entry.title,
      aliases: entry.aliases,
      summary: entry.summary,
      // 模型标记的核心设定映射为 pinned：每次写作都会注入
      pinned: entry.core,
      fields: entry.fields,
    },
  });
}

function outlineProposal({
  novelId,
  batchId,
  order,
  outline,
  existingOutline,
}: {
  novelId: string;
  batchId: string;
  order: number;
  outline: Parameters<typeof toOutlineDrafts>[0];
  existingOutline: Parameters<typeof buildOutlineDrafts>[0];
}): Proposal {
  const outlineText = serializeOutlineTree(toOutlineDrafts(outline));
  const specs = fieldSpecsFor('outlineTree');
  const common = {
    novelId,
    batchId,
    order,
    origin: 'generate' as const,
    target: 'outlineTree' as const,
    label: '全书大纲',
    specs,
  };

  // 已有大纲时用 replace，并把现有大纲作为原值，用户能看到改了什么
  if (existingOutline.length > 0) {
    return buildReplaceProposal({
      ...common,
      targetId: novelId,
      current: { outlineText: serializeOutlineTree(buildOutlineDrafts(existingOutline)) },
      payload: { outlineText },
    });
  }

  return buildCreateProposal({ ...common, payload: { outlineText } });
}
