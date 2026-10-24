import { z } from 'zod';
import type { Category, FieldDef, Novel, StyleProfile, WritingNorm } from '@/domain/schema';
import { composeSections, composeStylePrefix, writingNormsSection } from '@/prompt/sections';
import type { OutlineDraft } from '@/proposal/outlineText';

/** 篇幅规模，决定大纲的颗粒度与节点数量 */
export interface ScaleDef {
  id: string;
  label: string;
  words: string;
  /** 给模型的大纲结构要求 */
  outlineRequirement: string;
}

export const SCALES: ScaleDef[] = [
  {
    id: 'short',
    label: '短篇',
    words: '1–3 万字',
    outlineRequirement: '不分卷，直接给出 4–6 个章节节点，每节点标注约 3000–6000 字。',
  },
  {
    id: 'medium',
    label: '中篇',
    words: '10–30 万字',
    outlineRequirement: '分 3–5 个卷（或幕），每卷下给出 4–6 个章节节点，章节节点标注约 3000 字。',
  },
  {
    id: 'long',
    label: '长篇',
    words: '50 万字以上',
    outlineRequirement: [
      '分 4–6 个卷。',
      '只为前两卷展开章节节点（每卷 6–10 章，每章约 3000 字）；',
      '后续各卷只给卷级标题与梗概，不展开章节 —— 长篇的后段应当在写作过程中随剧情生长，过早细化只会被推翻。',
    ].join('\n'),
  },
];

export function findScale(id: string): ScaleDef {
  return SCALES.find((scale) => scale.id === id) ?? SCALES[1]!;
}

// ---------------------------------------------------------------- 输出 schema

export interface SetupEntryDraft {
  title: string;
  aliases: string[];
  summary: string;
  /** 是否为必须始终遵守的核心设定，映射到条目的 pinned */
  core: boolean;
  fields: Record<string, string>;
}

/** 模型输出的大纲节点。刻意与内部的 OutlineDraft 分开：模型只输出两层 */
export interface SetupOutlineChild {
  title: string;
  synopsis: string;
  targetWords: number | null;
}

export interface SetupOutlineRoot extends SetupOutlineChild {
  children: SetupOutlineChild[];
}

export interface ProjectSetupResult {
  worldbuilding: SetupEntryDraft[];
  characters: SetupEntryDraft[];
  outline: SetupOutlineRoot[];
}

/**
 * 由分类的字段模板动态生成字段 schema。
 *
 * 不写死字段名是有意的：内置分类的字段可以被用户改过，
 * 立项就应该按**当前**的字段模板来生成，否则生成结果会带着
 * 界面上根本不存在的字段，或缺掉用户新加的字段。
 */
function fieldsSchemaOf(defs: FieldDef[]): z.ZodType<Record<string, string>> {
  const shape: Record<string, z.ZodString> = {};
  for (const def of defs) shape[def.key] = z.string();
  return z.object(shape) as unknown as z.ZodType<Record<string, string>>;
}

function entrySchemaOf(defs: FieldDef[]) {
  return z.object({
    title: z.string().min(1, '名称不能为空'),
    aliases: z.array(z.string()),
    summary: z.string().min(1, '摘要不能为空'),
    core: z.boolean(),
    fields: fieldsSchemaOf(defs),
  });
}

/** 大纲只允许两层（卷 → 章）。两层足够表达全书结构，也让 JSON Schema 保持可读 */
const OutlineChildSchema = z.object({
  title: z.string().min(1),
  synopsis: z.string(),
  targetWords: z.number().int().positive().nullable(),
});

const OutlineRootSchema = z.object({
  title: z.string().min(1),
  synopsis: z.string(),
  targetWords: z.number().int().positive().nullable(),
  children: z.array(OutlineChildSchema),
});

export function buildSetupSchema(
  worldFields: FieldDef[],
  characterFields: FieldDef[],
): z.ZodType<ProjectSetupResult> {
  return z.object({
    worldbuilding: z.array(entrySchemaOf(worldFields)).min(2, '世界观设定至少 2 条'),
    characters: z.array(entrySchemaOf(characterFields)).min(2, '人物至少 2 位'),
    outline: z.array(OutlineRootSchema).min(3, '大纲至少 3 个节点'),
  }) as unknown as z.ZodType<ProjectSetupResult>;
}

/** 模型输出的大纲节点转成内部的树结构 */
export function toOutlineDrafts(outline: ProjectSetupResult['outline']): OutlineDraft[] {
  return outline.map((node) => ({
    title: node.title,
    synopsis: node.synopsis,
    targetWords: node.targetWords,
    children: (node.children ?? []).map((child) => ({
      title: child.title,
      synopsis: child.synopsis,
      targetWords: child.targetWords,
      children: [],
    })),
  }));
}

// ---------------------------------------------------------------- 提示词

function fieldGuide(title: string, defs: FieldDef[]): string {
  const lines = defs.map((def) => `- ${def.key}（${def.label}）：${def.hint || def.label}`);
  return [`${title}的 fields 各栏要求：`, ...lines].join('\n');
}

const SETUP_TASK = [
  '【任务】',
  '根据用户给出的一句话故事内核，为这本书搭出可以直接开写的地基：世界观设定、主要人物、全书大纲。',
  '',
  '总体要求：',
  '- 所有内容都要从这句话生长出来，不要另起一个故事。',
  '- 设定与人物必须彼此咬合：世界观的规则要能生出人物的困境，人物的目标要能撞上世界观的限制。',
  '- 宁少而准，不多而空。每一条都要具体到能指导写作，避免「神秘的力量」「复杂的身世」这类空话。',
  '- 人物之间要有明确的关系与张力，关系描述里写清对方姓名以便交叉引用。',
  '- 大纲的结构必须遵守上文【结构方法】给出的组织方式。',
  '- summary 是一句话摘要，用于在列表里快速辨认，控制在 30 字内。',
  '- core 标记该设定是否属于「每次写作都必须遵守的核心规则」；只有真正的底层规则才标 true，通常 1–2 条。',
  '- aliases 填别名、绰号、曾用名；没有就给空数组。',
].join('\n');

/**
 * 立项任务的系统提示。
 *
 * 结构上先放稳定前缀（作品信息 + 文体 + 结构方法 + 文风），再放任务说明与字段要求 ——
 * 与其他任务保持同一套顺序，便于命中 prompt 缓存。
 *
 * norms 是可选尾参数：不传或没有作用范围含「规划」的规范时，输出与改动前逐字节相同。
 * 规范紧跟稳定前缀：立项生成的设定与大纲是整本书的地基，地基一开始就要守作者定下的约束
 */
export function buildSetupSystemPrompt(
  novel: Novel,
  style: StyleProfile,
  worldCategory: Category,
  characterCategory: Category,
  norms?: readonly WritingNorm[],
): string {
  return composeSections([
    '你是一位资深的小说策划编辑，擅长把一个模糊的点子落成可执行的创作蓝本。',
    composeStylePrefix(novel, style),
    writingNormsSection(norms, 'planning'),
    SETUP_TASK,
    fieldGuide(`世界观设定（分类「${worldCategory.name}」）`, worldCategory.fieldTemplate),
    fieldGuide(`人物（分类「${characterCategory.name}」）`, characterCategory.fieldTemplate),
  ]);
}

export function buildSetupUserPrompt(params: {
  oneLiner: string;
  scale: ScaleDef;
  extra?: string;
}): string {
  const lines = [
    `【故事内核】\n${params.oneLiner.trim()}`,
    `【篇幅】\n${params.scale.label}（${params.scale.words}）`,
    `【大纲要求】\n${params.scale.outlineRequirement}`,
  ];
  if (params.extra?.trim()) {
    lines.push(`【用户额外要求】\n${params.extra.trim()}`);
  }
  lines.push('请给出世界观设定 3–6 条、主要人物 3–6 位，以及符合上述要求的全书大纲。');
  return lines.join('\n\n');
}
