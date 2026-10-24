import type { FieldDiff } from '@/domain/schema';
import { getFieldValue, setFieldValue, type FieldSpec } from './fields';

/**
 * 计算字段级差异。
 *
 * `before` 为 undefined 表示新建，全部字段都算新增。
 * 只产出有值可谈的字段：两边都空的字段不进 diff，避免预览界面被空行淹没。
 */
export function computeDiff(specs: FieldSpec[], after: unknown, before?: unknown): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  for (const spec of specs) {
    const afterValue = getFieldValue(after, spec);
    const beforeValue = before === undefined ? '' : getFieldValue(before, spec);

    if (!afterValue && !beforeValue) continue;

    let kind: FieldDiff['kind'];
    if (!beforeValue) {
      kind = 'added';
    } else if (!afterValue) {
      // 原来有值、现在空了。合并语义下不做删除，视作保持原值
      kind = 'unchanged';
    } else if (afterValue === beforeValue) {
      kind = 'unchanged';
    } else {
      kind = 'changed';
    }

    diffs.push({
      field: spec.path,
      label: spec.label,
      before: before === undefined ? null : beforeValue,
      after: kind === 'unchanged' && !afterValue ? beforeValue : afterValue,
      kind,
    });
  }

  return diffs;
}

/** 预览折叠态要显示的一行摘要，如「3 项新增 · 1 项改动」 */
export function summarizeDiff(diffs: FieldDiff[]): string {
  const added = diffs.filter((d) => d.kind === 'added').length;
  const changed = diffs.filter((d) => d.kind === 'changed').length;
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} 项新增`);
  if (changed > 0) parts.push(`${changed} 项改动`);
  if (parts.length === 0) return '无变化';
  return parts.join(' · ');
}

/** diff 里是否存在实质变化，没有的话不值得让用户确认 */
export function hasSubstantiveChange(diffs: FieldDiff[]): boolean {
  return diffs.some((d) => d.kind === 'added' || d.kind === 'changed');
}

/**
 * 合并两个实体，产出「待确认的合并结果」。
 *
 * 合并契约（与 Task 12 的提取提示词配套）：
 * - 列表字段取并集并去重 —— 别名、关键事件这类信息是累加的，覆盖会丢数据；
 * - 原值为空则采用新值；
 * - 新值为空则保留原值 —— 模型没提到某字段不等于该字段应被清空，
 *   这是反向提取场景最容易造成数据损失的地方；
 * - 两边都有值且不同则采用新值，并在 diff 里标为改动交给用户裁决。
 *   之所以敢直接取新值：提取时会把现有内容一起给模型，要求它输出**整合后的完整字段**，
 *   所以新值本身已经是「旧值 + 新信息」，而不是替代品。
 */
export function mergeEntities(specs: FieldSpec[], current: unknown, incoming: unknown): unknown {
  let merged: unknown = current !== null && typeof current === 'object' ? { ...current } : {};

  for (const spec of specs) {
    const currentValue = getFieldValue(current, spec);
    const incomingValue = getFieldValue(incoming, spec);

    if (spec.kind === 'list') {
      const union = dedupe([...splitLines(currentValue), ...splitLines(incomingValue)]);
      merged = setFieldValue(merged, spec, union.join('\n'));
      continue;
    }

    if (!incomingValue) continue;
    merged = setFieldValue(merged, spec, incomingValue);
  }

  return merged;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** 把用户的行内编辑应用回 payload */
export function applyEdits(
  specs: FieldSpec[],
  payload: unknown,
  edits: Record<string, string>,
): unknown {
  let next = payload;
  for (const [path, value] of Object.entries(edits)) {
    const spec = specs.find((item) => item.path === path);
    if (!spec) continue;
    next = setFieldValue(next, spec, value);
  }
  return next;
}
