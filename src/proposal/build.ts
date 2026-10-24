import { newId, now } from '@/domain/primitives';
import {
  ProposalSchema,
  type Proposal,
  type ProposalOrigin,
  type ProposalTarget,
} from '@/domain/schema';
import { computeDiff, mergeEntities } from './diff';
import type { FieldSpec } from './fields';

interface CommonParams {
  novelId: string;
  /** 同一次生成的多条 Proposal 共享，供「全部采用」使用 */
  batchId?: string | null;
  origin: ProposalOrigin;
  target: ProposalTarget;
  /** 给用户看的标签，如「人物 · 林越」 */
  label: string;
  /** 字段规格，决定 diff 与可编辑项 */
  specs: FieldSpec[];
  /** 溯源信息，如「第 3 章」 */
  sourceRef?: string;
  /** 批次内的展示顺序，同批提案应按阅读顺序显式指定 */
  order?: number;
}

/** 新建类提案：全部字段都是新增 */
export function buildCreateProposal(params: CommonParams & { payload: unknown }): Proposal {
  return finalize({
    ...params,
    action: 'create',
    targetId: null,
    payload: params.payload,
    diff: computeDiff(params.specs, params.payload),
  });
}

/**
 * 合并类提案：把新信息并入已有实体。
 * payload 存的是**合并后的完整实体数据**，diff 记录相对原值的变化，
 * 这样用户既能整体采用，也能逐字段还原。
 */
export function buildMergeProposal(
  params: CommonParams & { targetId: string; current: unknown; incoming: unknown },
): Proposal {
  const merged = mergeEntities(params.specs, params.current, params.incoming);
  return finalize({
    ...params,
    action: 'merge',
    targetId: params.targetId,
    payload: merged,
    diff: computeDiff(params.specs, merged, params.current),
  });
}

/** 整体替换类提案：章节重写、段落改写、风格档案覆盖等 */
export function buildReplaceProposal(
  params: CommonParams & { targetId: string; current: unknown; payload: unknown },
): Proposal {
  return finalize({
    ...params,
    action: 'replace',
    targetId: params.targetId,
    payload: params.payload,
    diff: computeDiff(params.specs, params.payload, params.current),
  });
}

function finalize(
  params: Omit<CommonParams, 'specs'> & {
    action: Proposal['action'];
    targetId: string | null;
    payload: unknown;
    diff: Proposal['diff'];
  },
): Proposal {
  return ProposalSchema.parse({
    id: newId(),
    novelId: params.novelId,
    batchId: params.batchId ?? null,
    order: params.order ?? 0,
    origin: params.origin,
    target: params.target,
    action: params.action,
    targetId: params.targetId,
    label: params.label,
    payload: params.payload,
    diff: params.diff,
    sourceRef: params.sourceRef ?? '',
    status: 'pending',
    createdAt: now(),
    decidedAt: null,
  });
}

/** 生成一个批次号，同一次生成的所有提案共用 */
export function newBatchId(): string {
  return newId();
}
