import { z } from 'zod';
import type { NovelRepository, OutlineTreeInputNode } from '@/data/NovelRepository';
import { now } from '@/domain/primitives';
import { RubricSchema, type Proposal } from '@/domain/schema';
import {
  ScenarioOutlinePayloadSchema,
  parseScenarioOutline,
  toScenarioOutlinePlan,
} from '@/features/scenario/pathOutline';
import { parseOutlineTree, type OutlineDraft } from './outlineText';

/**
 * Proposal 落库。
 *
 * 这是 AI 产出进入数据库的唯一通道：任何生成结果都必须先成为 Proposal、
 * 经用户确认后走到这里，功能模块没有旁路可以直接写库。
 * 因此「所有自动生成内容都要经用户确认」不是靠各处自觉，而是架构上的单行道。
 */

// payload 来自模型或用户编辑，一律重新校验后再落库
const EntryCreatePayload = z.object({
  categoryId: z.string().min(1, '缺少分类'),
  title: z.string().min(1, '条目名不能为空'),
  aliases: z.array(z.string()).optional(),
  summary: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
  pinned: z.boolean().optional(),
  sourceChapterIds: z.array(z.string()).optional(),
});

const EntryMergePayload = EntryCreatePayload.partial();

/**
 * 「提升为世界观」的提案额外带 promoteFrom：采用时建 / 改条目与标记本线条目必须同一事务，
 * 所以改走 repo.promoteLineEntry。没有这个键的提案行为与原来完全相同
 */
const PromoteFromPayload = z.object({
  promoteFrom: z.object({ nodeId: z.string().min(1), localId: z.string().min(1) }).optional(),
});

const OutlinePayload = z.object({
  title: z.string().min(1, '大纲标题不能为空'),
  synopsis: z.string().optional(),
  targetWords: z.number().int().positive().nullable().optional(),
  parentId: z.string().nullable().optional(),
  order: z.number().int().nonnegative().optional(),
  linkedEntryIds: z.array(z.string()).optional(),
  status: z.enum(['planned', 'drafting', 'done']).optional(),
});

const OutlinePatchPayload = OutlinePayload.partial();

const OutlineTreePayload = z.object({
  outlineText: z.string().min(1, '大纲内容不能为空'),
  /**
   * 挂载位置。为空表示整本书的顶层（立项场景）；
   * 指定节点则表示「把这份子树放到该节点之下」（雪花法逐层扩写场景）。
   */
  parentId: z.string().nullable().optional(),
});

const ChapterPayload = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  outlineNodeId: z.string().nullable().optional(),
  status: z.enum(['draft', 'done']).optional(),
  source: z.enum(['ai', 'manual', 'imported']).optional(),
});

const SummaryPayload = z.object({
  chapterId: z.string().min(1),
  summary: z.string().optional(),
  keyEvents: z.array(z.string()).optional(),
  appearingEntryIds: z.array(z.string()).optional(),
  openThreads: z.array(z.string()).optional(),
});

const StyleProfilePayload = z.object({
  customRubric: RubricSchema.partial().nullable().optional(),
  tradition: z.enum(['web', 'literary', 'genre']).optional(),
  subGenre: z.string().optional(),
  extraInstruction: z.string().optional(),
});

/** 外传进展摘要：只改 rollingSummary，标题与简介由用户在外传面板里维护 */
const SideStoryPayload = z.object({
  rollingSummary: z.string().optional(),
});

const NovelPayload = z.object({
  oneLiner: z.string().optional(),
  rollingSummary: z.string().optional(),
  title: z.string().min(1).optional(),
});

/** 把一条提案写入数据库。调用方负责标记状态 */
export async function applyProposal(repo: NovelRepository, proposal: Proposal): Promise<void> {
  const key = `${proposal.target}:${proposal.action}` as const;

  switch (key) {
    case 'knowledgeEntry:create': {
      const payload = EntryCreatePayload.parse(proposal.payload);
      const { promoteFrom } = PromoteFromPayload.parse(proposal.payload);
      if (promoteFrom) {
        await repo.promoteLineEntry({ ...promoteFrom, create: payload });
        return;
      }
      await repo.createEntry(proposal.novelId, payload);
      return;
    }
    case 'knowledgeEntry:merge':
    case 'knowledgeEntry:replace': {
      const targetId = requireTargetId(proposal);
      const current = await repo.getEntry(targetId);
      if (!current) throw new Error('要合并的条目已不存在，可能已被删除');
      const payload = EntryMergePayload.parse(proposal.payload);
      // 版本号递增，供后续的冲突提示使用
      const patch = { ...payload, version: current.version + 1 };
      // 只有合并提案可能来自提升（同名通用条目）；替换提案的提升是字段覆盖，不涉及本线条目
      const { promoteFrom } =
        proposal.action === 'merge'
          ? PromoteFromPayload.parse(proposal.payload)
          : { promoteFrom: undefined };
      if (promoteFrom) {
        await repo.promoteLineEntry({ ...promoteFrom, mergeInto: targetId, patch });
        return;
      }
      await repo.updateEntry(targetId, patch);
      return;
    }

    case 'outlineNode:create': {
      const payload = OutlinePayload.parse(proposal.payload);
      await repo.createOutlineNode(proposal.novelId, payload);
      return;
    }
    case 'outlineNode:merge':
    case 'outlineNode:replace': {
      const targetId = requireTargetId(proposal);
      await repo.updateOutlineNode(targetId, OutlinePatchPayload.parse(proposal.payload));
      return;
    }

    case 'outlineTree:create':
    case 'outlineTree:merge':
    case 'outlineTree:replace': {
      const { outlineText, parentId } = OutlineTreePayload.parse(proposal.payload);
      const tree = parseOutlineTree(outlineText);
      if (tree.length === 0) {
        throw new Error('大纲内容为空，或没有以 # 开头的标题行');
      }

      // 挂载点的存在性/归属、append 的起始 order、replace 的删旧建新全部收在仓储事务里。
      // apply 预先 listOutline 再删再建会留 TOCTOU 窗口，中途失败还会只删掉一半旧节点
      await repo.commitOutlineSubtree(
        proposal.novelId,
        parentId ?? null,
        toTreeInputNodes(tree),
        proposal.action === 'replace' ? 'replace' : 'append',
      );
      return;
    }

    case 'chapter:create': {
      await repo.createChapter(proposal.novelId, {
        ...ChapterPayload.parse(proposal.payload),
        source: 'ai',
      });
      return;
    }
    case 'chapter:merge':
    case 'chapter:replace': {
      const targetId = requireTargetId(proposal);
      await repo.updateChapter(targetId, ChapterPayload.parse(proposal.payload));
      return;
    }

    case 'chapterSummary:create':
    case 'chapterSummary:merge':
    case 'chapterSummary:replace': {
      const payload = SummaryPayload.parse(proposal.payload);
      const { chapterId, ...rest } = payload;
      await repo.upsertSummary(proposal.novelId, chapterId, rest);
      return;
    }

    case 'styleProfile:create':
    case 'styleProfile:merge':
    case 'styleProfile:replace': {
      const { customRubric, ...rest } = StyleProfilePayload.parse(proposal.payload);
      await repo.upsertStyleProfile(proposal.novelId, {
        ...rest,
        // rubric 只给了部分维度时补齐其余为空串，避免存进半个对象
        ...(customRubric ? { customRubric: RubricSchema.parse(customRubric) } : {}),
      });
      return;
    }

    case 'novel:create':
    case 'novel:merge':
    case 'novel:replace': {
      await repo.updateNovel(proposal.novelId, NovelPayload.parse(proposal.payload));
      return;
    }

    case 'sideStory:create':
    case 'sideStory:merge':
    case 'sideStory:replace': {
      // 外传已被删除时由仓储抛「这部外传已不存在，可能已被删除」，提案留在待确认里
      const payload = SideStoryPayload.parse(proposal.payload);
      await repo.updateSideStory(requireTargetId(proposal), payload);
      return;
    }

    // 推演沉淀：整段路径一个提案。解析（含「对应步骤」的范围校验）失败或仓储事务失败都抛错，
    // 提案留在待确认里让作者改；沉淀提案只支持新建，merge / replace 一直拒绝
    case 'scenarioOutline:create': {
      const payload = ScenarioOutlinePayloadSchema.parse(proposal.payload);
      // 「出场」只关联通用条目（listEntries 默认只返回通用、未删除的）
      const entries = await repo.listEntries(proposal.novelId);
      const parsed = parseScenarioOutline(payload.outlineText, {
        from: payload.range.from,
        to: payload.range.to,
        pathNodeIds: payload.nodeIds,
        entries,
      });
      await repo.commitScenarioOutline(proposal.novelId, toScenarioOutlinePlan(payload, parsed));
      return;
    }
    case 'scenarioOutline:merge':
    case 'scenarioOutline:replace':
      throw new Error('沉淀提案只支持新建');

    default: {
      // 穷尽检查：新增 target/action 组合时这里会编译报错，提醒补实现
      const exhaustive: never = key;
      throw new Error(`尚未支持的提案类型：${String(exhaustive)}`);
    }
  }
}

/**
 * 文本树 → 仓储事务入参。
 *
 * 只搬运内容字段：id / parentId / order / 时间戳由仓储在事务内生成，
 * 否则「先建后删」或「先删后建」都会在树里留下重复或空缺。
 */
function toTreeInputNodes(nodes: readonly OutlineDraft[]): OutlineTreeInputNode[] {
  return nodes.map((node) => ({
    title: node.title,
    synopsis: node.synopsis,
    targetWords: node.targetWords,
    children: toTreeInputNodes(node.children),
  }));
}

function requireTargetId(proposal: Proposal): string {
  if (!proposal.targetId) {
    throw new Error(
      `提案「${proposal.label}」缺少目标 id，无法${proposal.action === 'merge' ? '合并' : '替换'}`,
    );
  }
  return proposal.targetId;
}

export interface AcceptResult {
  accepted: string[];
  failed: { proposalId: string; label: string; message: string }[];
}

/**
 * 批量采用提案。
 *
 * 逐条处理而非整体事务：一条失败（比如目标条目已被手动删除）不应该
 * 让其余十几条一起回滚。失败的提案保持 pending，用户可以单独处理或忽略。
 */
export async function acceptProposals(
  repo: NovelRepository,
  proposals: Proposal[],
): Promise<AcceptResult> {
  const result: AcceptResult = { accepted: [], failed: [] };

  for (const proposal of proposals) {
    try {
      await applyProposal(repo, proposal);
      await repo.updateProposal(proposal.id, { status: 'accepted', decidedAt: now() });
      result.accepted.push(proposal.id);
    } catch (cause) {
      result.failed.push({
        proposalId: proposal.id,
        label: proposal.label,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return result;
}

/** 忽略提案：保留记录而不删除，便于回溯「当时拒绝了什么」 */
export async function rejectProposals(repo: NovelRepository, proposalIds: string[]): Promise<void> {
  for (const id of proposalIds) {
    await repo.updateProposal(id, { status: 'rejected', decidedAt: now() });
  }
}
