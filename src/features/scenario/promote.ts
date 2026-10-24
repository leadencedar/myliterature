import { normalizeEntryName } from '@/domain/entrySearch';
import type { Category, KnowledgeEntry, Proposal } from '@/domain/schema';
import { fieldMutability, type EffectiveEntry } from '@/domain/worldline';
import { buildCreateProposal, buildMergeProposal, buildReplaceProposal } from '@/proposal/build';
import { entryFieldSpecs } from '@/proposal/fields';

/**
 * 「提升为世界观」（设计 §7.1）：把世界线上的一处变化整理成一条待确认的条目提案。
 *
 * 这里只生成提案、不写库 —— 提升是沙盒内容进入世界观层的两个出口之一，必须经作者在知识库里确认
 * （确认前世界观层一个字都不变）。三种提案的 origin 都是 'refine'：内容不是这次调用模型生成的，
 * 而是把已有的推演产出整理成世界观条目。
 */

export const PROMOTE_MESSAGES = {
  /** D6.3：锁定的语义是「世界线不能改它」，借提升改它就是绕过锁定 */
  locked: '底层设定不能从世界线提升；要改请直接编辑条目',
  /** 状态 / 主角状态 / 事件 / 标记：是这条线的剧情，不是全书设定 */
  sandboxOnly:
    '世界观条目没有「状态」这一栏；某人在这条线上死了，是这条线的剧情，不是全书设定。要写进全书，请沉淀成章节',
  unchanged: '本线的值与世界观原文相同，不需要提升',
  missingField: '这个分类已没有这一栏，不能提升',
  entryGone: '要提升的条目已不存在',
  categoryGone: '这个条目的分类已不存在，不能提升',
  notLine: '只有本线新出现的条目可以这样提升',
} as const;

/** 要提升的是哪一处变化 */
export type PromoteSubject =
  /** 世界观条目（或已提升的本线条目所指向的条目）上的一处字段覆盖 */
  | { kind: 'field'; entry: KnowledgeEntry; fieldKey: string; value: string }
  /** 本线新条目（未提升的），取当前节点处的有效值 */
  | { kind: 'line'; entry: EffectiveEntry }
  /** 不可提升的差异类型 */
  | { kind: 'status' | 'oc' | 'event' | 'flag' };

export type PromoteResult =
  | { ok: true; proposal: Proposal; /** 给作者的额外说明（如改成合并） */ notice: string | null }
  | { ok: false; reason: string };

export function buildPromotion(input: {
  novelId: string;
  subject: PromoteSubject;
  /** 本书条目（可含已删除的，会被跳过）：判断同名通用条目 */
  entries: readonly KnowledgeEntry[];
  categories: readonly Category[];
  /** 溯源，如「推演《雾中渡》第 3 步」 */
  sourceRef: string;
}): PromoteResult {
  const { novelId, subject, entries, categories, sourceRef } = input;
  const common = {
    novelId,
    origin: 'refine' as const,
    target: 'knowledgeEntry' as const,
    sourceRef,
  };

  if (subject.kind === 'field') {
    const { entry, fieldKey, value } = subject;
    if (entry.deletedAt !== null && entry.deletedAt !== undefined)
      return { ok: false, reason: PROMOTE_MESSAGES.entryGone };
    const category = categories.find((item) => item.id === entry.categoryId);
    if (!category) return { ok: false, reason: PROMOTE_MESSAGES.categoryGone };
    if (!category.fieldTemplate.some((field) => field.key === fieldKey)) {
      return { ok: false, reason: PROMOTE_MESSAGES.missingField };
    }
    // 按「现在」的可变性判：覆盖存下之后字段被改成锁定，是唯一能走到这里的锁定覆盖（验收 10）
    if (fieldMutability(category, entry, fieldKey) === 'locked') {
      return { ok: false, reason: PROMOTE_MESSAGES.locked };
    }
    if (value.trim() === (entry.fields[fieldKey] ?? '').trim()) {
      return { ok: false, reason: PROMOTE_MESSAGES.unchanged };
    }
    // replace 而不是 merge：mergeEntities 对 list 字段取并集，而世界线覆盖的语义是替换
    return {
      ok: true,
      notice: null,
      proposal: buildReplaceProposal({
        ...common,
        label: `${category.name} · ${entry.title}`,
        specs: entryFieldSpecs(category),
        targetId: entry.id,
        current: entry,
        payload: { ...entry, fields: { ...entry.fields, [fieldKey]: value } },
      }),
    };
  }

  if (subject.kind === 'line') {
    const { entry } = subject;
    if (entry.origin !== 'line' || entry.ref.kind !== 'line')
      return { ok: false, reason: PROMOTE_MESSAGES.notLine };
    const category = categories.find((item) => item.id === entry.categoryId);
    if (!category) return { ok: false, reason: PROMOTE_MESSAGES.categoryGone };
    const promoteFrom = { nodeId: entry.ref.nodeId, localId: entry.ref.localId };
    // 当前节点处的有效值：本线条目自身的字段 + 之后各步对它的覆盖
    const fields = Object.fromEntries(
      Object.entries(entry.fields).map(([key, field]) => [key, field.value]),
    );

    const name = normalizeEntryName(entry.title);
    const existing = entries.find(
      (item) =>
        (item.deletedAt === null || item.deletedAt === undefined) &&
        (item.scope?.kind ?? 'universal') === 'universal' &&
        (normalizeEntryName(item.title) === name ||
          item.aliases.some((alias) => normalizeEntryName(alias) === name)),
    );

    if (!existing) {
      return {
        ok: true,
        notice: null,
        proposal: buildCreateProposal({
          ...common,
          label: `${category.name} · ${entry.title}`,
          specs: entryFieldSpecs(category),
          // 作用范围不放进 payload：仓储的 promoteLineEntry 一律建成通用条目
          payload: {
            categoryId: entry.categoryId,
            title: entry.title,
            summary: entry.summary,
            fields,
            promoteFrom,
          },
        }),
      };
    }

    // 同名通用条目：与反向提取的同名合并一致，按已有条目所属分类的模板算 diff
    const targetCategory = categories.find((item) => item.id === existing.categoryId) ?? category;
    const proposal = buildMergeProposal({
      ...common,
      label: `${targetCategory.name} · ${existing.title}`,
      specs: entryFieldSpecs(targetCategory),
      targetId: existing.id,
      current: existing,
      incoming: { summary: entry.summary, fields },
    });
    return {
      ok: true,
      notice: `知识库里已有「${existing.title}」，将合并进这个条目而不是新建`,
      proposal: { ...proposal, payload: { ...flattenListFields(proposal.payload), promoteFrom } },
    };
  }

  return { ok: false, reason: PROMOTE_MESSAGES.sandboxOnly };
}

/**
 * mergeEntities 把 list 字段写回成数组，但条目的 fields 只存字符串（每行一项）；
 * 不拍平的话采用时 schema 校验会拒绝这条提案
 */
function flattenListFields(payload: unknown): Record<string, unknown> {
  const base = (payload !== null && typeof payload === 'object' ? payload : {}) as Record<
    string,
    unknown
  >;
  const fields = base.fields;
  if (fields === null || typeof fields !== 'object') return { ...base };
  return {
    ...base,
    fields: Object.fromEntries(
      Object.entries(fields as Record<string, unknown>).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map(String).join('\n') : value,
      ]),
    ),
  };
}
