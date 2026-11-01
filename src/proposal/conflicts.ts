/**
 * 提案采用的冲突检测（三方合并）。
 *
 * 背景：合并/替换提案的 payload 是**生成时**的实体快照。作者在等待确认期间
 * 手动改过的字段，如果直接按 payload 回写就会被旧值覆盖；反过来，如果只写
 * "提案确实改过"的字段，未触及的字段自然保留当前值。
 *
 * 所以采用时比较三方：
 * - base：提案生成时的基准值（新提案由构建器存进 `base`，旧提案从 diff.before 重建）；
 * - current：数据库里的当前值；
 * - payload：提案目标值（可能包含作者在确认界面的行内修改）。
 *
 * 判定规则：
 * - payload == base：提案没改这个字段 → 不写；
 * - current == base 或 current == payload：安全，写入 payload；
 * - 其余：双方都改过 → 冲突，整条提案拒绝落库并提示重新生成。
 */
import type { FieldDiff } from '@/domain/schema';
import { getFieldValue, hasFieldValue, setFieldValue, type FieldSpec } from './fields';

export interface FieldConflict {
  /** 字段路径（如 `summary`、`fields.identity`） */
  field: string;
  /** 给作者看的字段名 */
  label: string;
  /** 三元值，仅用于提示与调试 */
  base: string;
  current: string;
  proposed: string;
}

/**
 * 提案与当前数据冲突。携带冲突字段清单，UI 可以把字段名拼进失败提示；
 * 抛出时整条提案的事务回滚，状态保持 pending，作者可以重新生成后再采用。
 */
export class ProposalConflictError extends Error {
  readonly fields: FieldConflict[];

  constructor(fields: FieldConflict[]) {
    const names = fields.map((item) => `「${item.label}」`).join('、');
    super(`提案与当前内容冲突：${names}在提案生成后被手动修改过。请重新生成该提案后再采用。`);
    this.name = 'ProposalConflictError';
    this.fields = fields;
  }
}

/** 值比较：提案里只出现 JSON 数据，数组/对象按内容比较（列表视为原子） */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * 从提案自带的 diff 还原「生成时的基准值」。
 *
 * 本次改造前生成、已经在待确认列表里的老提案没有 `base` 快照，但 diff 记录了
 * 每个字段生成时的 before 值。用它重建基准，至少能保证"提案没改、作者后来改了"
 * 的字段不被旧 payload 回写；规格之外的字段则没有可验证基准。
 */
export function baseFromDiff(specs: FieldSpec[], diff: FieldDiff[]): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  for (const item of diff) {
    const spec = specs.find((candidate) => candidate.path === item.field);
    if (!spec) continue;
    base = setFieldValue(base, spec, item.before ?? '') as Record<string, unknown>;
  }
  return base;
}

export interface ThreeWayResult {
  /** 只包含「提案确实改了、且当前值仍等于基准」的字段 */
  patch: Record<string, unknown>;
  conflicts: FieldConflict[];
}

/**
 * 三方合并。返回的 patch 只含可安全写入的字段；有冲突时调用方必须拒绝落库。
 *
 * @param specs 字段规格（来自 proposal/fields）：列表、数字等类型借此规范化比较与写回
 * @param extraKeys 规格之外的 payload 顶层键（如章节的 status、小说的 title），整值比较
 */
export function threeWayMerge(params: {
  specs: FieldSpec[];
  base: unknown;
  current: unknown;
  payload: unknown;
  extraKeys?: string[];
  labels?: Record<string, string>;
}): ThreeWayResult {
  const { specs, base, current, payload, extraKeys = [], labels = {} } = params;
  let patch: Record<string, unknown> = {};
  const conflicts: FieldConflict[] = [];

  for (const spec of specs) {
    // 提案没提这个字段（键不存在）：保持现状，既不算改动也不写空
    if (!hasFieldValue(payload, spec)) continue;
    const baseValue = getFieldValue(base, spec);
    const currentValue = getFieldValue(current, spec);
    const payloadValue = getFieldValue(payload, spec);
    // 提案没改这个字段：不写，保留当前值（这正是旧 payload 回写覆盖作者修改的根因）
    if (payloadValue === baseValue) continue;
    if (currentValue === baseValue || currentValue === payloadValue) {
      // 知识条目的 fields.* 在库里是字符串（列表也以换行分隔存储），
      // 不能按 list 类型写成数组，否则 Zod 会拒绝
      const writeSpec = spec.path.startsWith('fields.') ? { ...spec, kind: 'text' as const } : spec;
      patch = setFieldValue(patch, writeSpec, payloadValue) as Record<string, unknown>;
      continue;
    }
    conflicts.push({
      field: spec.path,
      label: spec.label,
      base: baseValue,
      current: currentValue,
      proposed: payloadValue,
    });
  }

  const baseRecord = base as Record<string, unknown> | undefined;
  const currentRecord = current as Record<string, unknown> | undefined;
  const payloadRecord = payload as Record<string, unknown> | undefined;

  for (const key of extraKeys) {
    // 同上：payload 里没有这个键表示提案不涉及它
    if (!payloadRecord || !(key in payloadRecord)) continue;
    const baseValue = baseRecord?.[key];
    const currentValue = currentRecord?.[key];
    const payloadValue = payloadRecord?.[key];
    if (sameValue(payloadValue, baseValue)) continue;
    if (sameValue(currentValue, baseValue) || sameValue(currentValue, payloadValue)) {
      patch[key] = payloadValue;
      continue;
    }
    conflicts.push({
      field: key,
      label: labels[key] ?? key,
      base: describeValue(baseValue),
      current: describeValue(currentValue),
      proposed: describeValue(payloadValue),
    });
  }

  return { patch, conflicts };
}

/** 冲突提示里的值摘要：太长会撑爆 toast，截断即可 */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
