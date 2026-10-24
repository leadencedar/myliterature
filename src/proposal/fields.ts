/**
 * 字段规格：把各类实体拍平成「可展示、可编辑、可比较」的字段列表。
 *
 * 确认管道要面对知识条目、大纲节点、章节、摘要等形态各异的实体，
 * 如果每种都写一套预览 UI 和一套编辑逻辑，维护成本会失控。
 * 这里用统一的字段描述把差异收敛掉：上层只认 FieldSpec，不关心实体形状。
 */
import type { Category, ProposalTarget } from '@/domain/schema';
import { TRADITIONS } from '@/prompt/traditions';

export type FieldKind = 'text' | 'longtext' | 'list' | 'number' | 'enum';

export interface FieldSpec {
  /** 取值路径，支持一层嵌套，如 `fields.identity` */
  path: string;
  label: string;
  kind: FieldKind;
  /** 给 AI 的写作指引，来自分类的字段模板 */
  hint?: string;
  /**
   * `enum` 字段的可选值。
   *
   * 存的是机器值（如 `web`），展示的是 label（如「网络文学」）。枚举必须走
   * 下拉而不是文本框：自由输入能填出 `MethodologySchema.parse` 拒绝的值，
   * 用户要到点「采用」时才知道写错了。
   */
  options?: { value: string; label: string }[];
}

/** 把枚举的机器值换成给人看的 label；不是枚举或找不到就原样返回 */
export function displayFieldValue(spec: FieldSpec, value: string): string {
  if (spec.kind !== 'enum' || !spec.options) return value;
  return spec.options.find((option) => option.value === value)?.label ?? value;
}

/** 列表型字段在 UI 与 diff 中以换行分隔展示 */
const LIST_SEPARATOR = '\n';

function readPath(payload: unknown, path: string): unknown {
  if (payload === null || typeof payload !== 'object') return undefined;
  const segments = path.split('.');
  let cursor: unknown = payload;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** 把任意字段值规范成用于展示与比较的字符串 */
export function getFieldValue(payload: unknown, spec: FieldSpec): string {
  const raw = readPath(payload, spec.path);
  if (raw === undefined || raw === null) return '';
  if (Array.isArray(raw)) {
    return raw
      .map((item) => String(item).trim())
      .filter(Boolean)
      .join(LIST_SEPARATOR);
  }
  return String(raw);
}

/** 把编辑后的字符串写回 payload，返回新对象（不修改原值） */
export function setFieldValue(payload: unknown, spec: FieldSpec, value: string): unknown {
  const base: Record<string, unknown> =
    payload !== null && typeof payload === 'object'
      ? { ...(payload as Record<string, unknown>) }
      : {};

  const coerced = coerce(spec.kind, value);
  const segments = spec.path.split('.');

  if (segments.length === 1) {
    base[segments[0]!] = coerced;
    return base;
  }

  // 只需支持一层嵌套（`fields.xxx`），更深的层级在本应用里不存在
  const [head, ...rest] = segments;
  const parent = base[head!];
  const nested: Record<string, unknown> =
    parent !== null && typeof parent === 'object' ? { ...(parent as Record<string, unknown>) } : {};
  nested[rest.join('.')] = coerced;
  base[head!] = nested;
  return base;
}

function coerce(kind: FieldKind, value: string): unknown {
  switch (kind) {
    case 'list':
      return value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    case 'number': {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? Math.round(parsed) : null;
    }
    default:
      return value;
  }
}

// ---------------------------------------------------------------- 各实体的字段规格

/** 知识条目固定字段（与分类无关的部分） */
const ENTRY_BASE_FIELDS: FieldSpec[] = [
  { path: 'title', label: '名称', kind: 'text' },
  {
    path: 'aliases',
    label: '别名',
    kind: 'list',
    hint: '每行一个。别名会用于识别同一对象，写全有助于避免重复条目。',
  },
  { path: 'summary', label: '一句话摘要', kind: 'longtext' },
];

/**
 * 知识条目的字段规格 = 固定字段 + 所属分类的自定义字段模板。
 * 分类可能被用户改过字段，所以必须以当前分类为准动态生成。
 */
export function entryFieldSpecs(category: Category | undefined): FieldSpec[] {
  const dynamic: FieldSpec[] = (category?.fieldTemplate ?? []).map((field) => ({
    path: `fields.${field.key}`,
    label: field.label,
    kind: field.type === 'list' ? 'list' : field.type === 'text' ? 'text' : 'longtext',
    ...(field.hint ? { hint: field.hint } : {}),
  }));
  return [...ENTRY_BASE_FIELDS, ...dynamic];
}

export const OUTLINE_FIELD_SPECS: FieldSpec[] = [
  { path: 'title', label: '标题', kind: 'text' },
  { path: 'synopsis', label: '梗概', kind: 'longtext' },
  { path: 'targetWords', label: '目标字数', kind: 'number' },
];

export const CHAPTER_FIELD_SPECS: FieldSpec[] = [
  { path: 'title', label: '章节标题', kind: 'text' },
  { path: 'content', label: '正文', kind: 'longtext' },
];

export const CHAPTER_SUMMARY_FIELD_SPECS: FieldSpec[] = [
  { path: 'summary', label: '本章摘要', kind: 'longtext' },
  { path: 'keyEvents', label: '关键事件', kind: 'list' },
  { path: 'openThreads', label: '未收束伏笔', kind: 'list' },
];

/**
 * 风格档案。
 *
 * 只覆盖「能从既有文本观察出来」的维度：rubric 七维 + 文体取向 + 子类。
 * **创作方法论与名家风格参考刻意不在此列** —— 前者是「接下来怎么规划大纲」的
 * 选择而非文本属性，后者是「我想像谁」而非「我像谁」，都不该由模型替作者决定。
 *
 * 手动改风格档案走 `StyleSection` 的 `upsertStyleProfile`，不经这条管道；
 * 这里只负责 AI 产出的那部分。文风取样的提案 payload 里没有 tradition/subGenre，
 * 两边都空的字段不会进 diff、也不会渲染，所以扩展这份规格对它无影响。
 */
export const STYLE_PROFILE_FIELD_SPECS: FieldSpec[] = [
  {
    path: 'tradition',
    label: '文体取向',
    kind: 'enum',
    // 从 TRADITIONS 派生而不是抄一份 label：抄的那份一定会跟原始定义漂移
    options: Object.values(TRADITIONS).map((item) => ({ value: item.id, label: item.label })),
  },
  { path: 'subGenre', label: '子类', kind: 'text' },
  { path: 'customRubric.sentenceRhythm', label: '句式节奏', kind: 'longtext' },
  { path: 'customRubric.imagery', label: '意象偏好', kind: 'longtext' },
  { path: 'customRubric.narrativeDistance', label: '叙述距离', kind: 'longtext' },
  { path: 'customRubric.dialogue', label: '对话风格', kind: 'longtext' },
  { path: 'customRubric.rhetoric', label: '修辞习惯', kind: 'longtext' },
  { path: 'customRubric.lexicon', label: '词汇色彩', kind: 'longtext' },
  { path: 'customRubric.avoid', label: '需要避免', kind: 'longtext' },
];

/**
 * 整棵大纲树只有一个字段：缩进标题文本。
 * 这样确认管道不必为树结构开特例，用户改大纲就像改 Markdown 列表。
 */
export const OUTLINE_TREE_FIELD_SPECS: FieldSpec[] = [
  {
    path: 'outlineText',
    // 与提案标签「全书大纲」区分开，否则界面上两个同名控件难以分辨
    label: '大纲内容',
    kind: 'longtext',
    hint: '用 # 表示卷/幕，## 表示章，标题下一行写梗概。可直接调整层级与顺序。',
  },
];

/**
 * 推演沉淀的大纲。外传模式多两栏（名称、简介 —— 简介就是外传的轻量大纲）；
 * 主线模式与「追加到外传」两栏为空，按现有规则两边都空的字段不渲染
 */
export const SCENARIO_OUTLINE_FIELD_SPECS: FieldSpec[] = [
  { path: 'sideTitle', label: '外传名称', kind: 'text' },
  { path: 'sideSynopsis', label: '外传简介', kind: 'longtext' },
  {
    path: 'outlineText',
    label: '大纲内容',
    kind: 'longtext',
    hint: '用 # 表示卷，## 表示章，标题下一行写梗概；「对应步骤：」一行写这一章对应推演的第几步到第几步，各章要首尾相接。',
  },
];
export const NOVEL_FIELD_SPECS: FieldSpec[] = [
  { path: 'oneLiner', label: '一句话故事', kind: 'longtext' },
  { path: 'rollingSummary', label: '全书进展摘要', kind: 'longtext' },
];

export const SIDE_STORY_FIELD_SPECS: FieldSpec[] = [
  { path: 'rollingSummary', label: '外传进展摘要', kind: 'longtext' },
];

/** 按 Proposal 的目标类型取字段规格；知识条目需要额外传分类 */
export function fieldSpecsFor(target: ProposalTarget, category?: Category): FieldSpec[] {
  switch (target) {
    case 'knowledgeEntry':
      return entryFieldSpecs(category);
    case 'outlineNode':
      return OUTLINE_FIELD_SPECS;
    case 'outlineTree':
      return OUTLINE_TREE_FIELD_SPECS;
    case 'chapter':
      return CHAPTER_FIELD_SPECS;
    case 'chapterSummary':
      return CHAPTER_SUMMARY_FIELD_SPECS;
    case 'styleProfile':
      return STYLE_PROFILE_FIELD_SPECS;
    case 'novel':
      return NOVEL_FIELD_SPECS;
    case 'sideStory':
      return SIDE_STORY_FIELD_SPECS;
    case 'scenarioOutline':
      return SCENARIO_OUTLINE_FIELD_SPECS;
    default:
      return [];
  }
}
