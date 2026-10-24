import type { Novel, Rubric, StyleProfile, WritingNorm, WritingNormScope } from '@/domain/schema';
import { normsInScope } from '@/domain/writingNorm';
// tokens.ts 是无依赖的纯函数模块，从这里引入不会形成循环
import { estimateTokens } from '@/context/tokens';
import { METHODOLOGIES, TRADITIONS, findSubGenre } from './traditions';
import { RUBRIC_DIMENSIONS, findVoice } from './voiceLibrary';

/**
 * prompt 片段组装。
 *
 * 全部函数都是纯函数且**输出逐字节可复现**：相同输入必须得到完全相同的字符串。
 * 这不是洁癖 —— DeepSeek 的输入 token 在命中缓存时便宜 50 倍，而缓存命中的前提
 * 是前缀完全一致。任何时间戳、随机序、对象键遍历顺序的不确定性都会让缓存失效，
 * 所以这里一律按显式数组顺序拼装，并且不引入任何与时间相关的内容。
 */

const POV_LABELS: Record<Novel['pov'], string> = {
  first: '第一人称',
  'third-limited': '第三人称限知视角',
  'third-omniscient': '第三人称全知视角',
};

/** 小说元信息：体裁、视角、一句话内核 */
export function novelMetaSection(novel: Novel): string {
  const lines = ['【作品信息】', `书名：${novel.title}`];
  if (novel.genre.trim()) lines.push(`体裁：${novel.genre.trim()}`);
  lines.push(`叙述视角：${POV_LABELS[novel.pov]}`);
  if (novel.oneLiner.trim()) lines.push(`故事内核：${novel.oneLiner.trim()}`);
  if (novel.targetWords) lines.push(`预计总字数：${novel.targetWords}`);
  return lines.join('\n');
}

/** 文体取向 + 子类约定 */
export function traditionSection(style: StyleProfile): string {
  const tradition = TRADITIONS[style.tradition];
  const lines = ['【文体取向】', `${tradition.label}（${tradition.tagline}）`, tradition.guidance];

  const subGenre = style.subGenre.trim()
    ? findSubGenre(style.tradition, style.subGenre.trim())
    : undefined;
  if (subGenre) {
    lines.push(`子类「${subGenre.label}」的额外约定：${subGenre.convention}`);
  } else if (style.subGenre.trim()) {
    // 用户自填了不在预置列表里的子类，原样带上
    lines.push(`子类：${style.subGenre.trim()}`);
  }

  return lines.join('\n');
}

/** 创作方法论：决定大纲结构 */
export function methodologySection(style: StyleProfile): string {
  const methodology = METHODOLOGIES[style.methodology];
  return [
    '【结构方法】',
    `${methodology.label}（${methodology.tagline}）`,
    methodology.outlineStructure,
  ].join('\n');
}

/** 强度档位。比直接给数字更好使：模型对「主要／略带」的理解比对「70」稳定 */
function weightLabel(weight: number): string {
  if (weight >= 80) return '强烈贴近';
  if (weight >= 55) return '明显偏向';
  if (weight >= 30) return '适度借鉴';
  return '略带一点';
}

function rubricLines(rubric: Rubric): string[] {
  const lines: string[] = [];
  for (const dimension of RUBRIC_DIMENSIONS) {
    const value = rubric[dimension.key]?.trim();
    if (value) lines.push(`- ${dimension.label}：${value}`);
  }
  return lines;
}

/**
 * 文风段落：名家风格参考 + 自定义 rubric + 用户补充要求。
 * 这是对正文质量影响最大的一段。
 */
export function voiceSection(style: StyleProfile): string {
  const blocks: string[] = [];

  for (const ref of style.voiceRefs) {
    const preset = findVoice(ref.refId);
    // 找不到预置（比如库里改过 id）时退化成只用名字，不要整段消失
    const heading = `参考风格：${preset?.name ?? ref.name}（${weightLabel(ref.weight)}）`;
    if (!preset) {
      blocks.push(heading);
      continue;
    }
    blocks.push([heading, ...rubricLines(preset.rubric)].join('\n'));
  }

  if (style.customRubric) {
    const lines = rubricLines(style.customRubric);
    if (lines.length > 0) {
      blocks.push(['自定义文风要求：', ...lines].join('\n'));
    }
  }

  if (style.extraInstruction.trim()) {
    blocks.push(`额外写作要求：${style.extraInstruction.trim()}`);
  }

  if (blocks.length === 0) return '';

  return [
    '【文风】',
    '以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。',
    ...blocks,
  ].join('\n');
}

/**
 * 稳定前缀：把作品信息、文体、结构方法、文风拼成一段。
 *
 * 这一段在同一本书的多次生成之间不应变化，因此必须放在 prompt 最前面；
 * 易变内容（最近章节摘要、上一章结尾、本次指令）由调用方拼到后面。
 */
export function composeStylePrefix(novel: Novel, style: StyleProfile): string {
  return composeSections([
    novelMetaSection(novel),
    traditionSection(style),
    methodologySection(style),
    voiceSection(style),
  ]);
}

// ---------------------------------------------------------------- 写作规范

/**
 * 每种作用范围一句用法说明。各任务对规范的用法不同：写正文要落实而不复述，
 * 摘要与提取要防止把规范本身当成正文 —— 所以按 scope 给不同的一句，而不是一句通用话
 */
const NORM_SCOPE_USAGE: Record<WritingNormScope, string> = {
  writing: '写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。',
  planning: '规划世界观、人物与大纲时同样遵守这些约束；规范本身不是需要生成的设定。',
  summary:
    '提炼摘要时据此区分正文里已经确认的事实与仅属建议的内容；规范本身不是正文，不要写进摘要或伏笔。',
  extract:
    '提取时遵守其中关于命名、合并与信息限定的规则。规范本身不是待提取的正文，不要从规范里提取条目、摘要或伏笔。',
  check: '审读时逐条对照这些规范，找出正文可能违反之处。规范之外的问题不在本次范围内。',
  interactive: '推演时把这些约束落实到情节、挑战与选项里，不要在情节中复述或提及规范本身。',
};

/**
 * 一份规范的 prompt 片段。标题已在 schema 里 trim；正文只去首尾空白，内部原样。
 * 用成对的【规范《…》】/【规范《…》结束】而不是「## 标题」包住：作者的规范和 AI 精简结果
 * 本身就带 Markdown「## 」小节，用 ## 分隔时模型分不清「两份规范」和「一份规范的两个小节」，
 * 按规范检查回填的规范名也会抄成小节标题。【…】在现有提示词里只用作段落标题，
 * 带「规范《」前缀与「结束」后缀的组合不会和作者正文、差异说明模板的【字段】撞上。
 */
export function renderNormBlock(norm: Pick<WritingNorm, 'title' | 'content'>): string {
  return `【规范《${norm.title}》】\n${norm.content.trim()}\n【规范《${norm.title}》结束】`;
}

/**
 * token 估算的唯一口径：对渲染后的块估算（含首尾分隔行）。知识库列表、编辑面板（用草稿）、
 * 注入 chip、合计提示、构建器 item.tokens、NORM_TOKEN_WARN 比较一律用它，
 * 保证同一份规范在任何地方显示的数一致
 */
export function normTokens(norm: Pick<WritingNorm, 'title' | 'content'>): number {
  return estimateTokens(renderNormBlock(norm));
}

/**
 * 规范段落的组装，构建器与 writingNormsSection 共用，保证两条路径逐字节一致。
 * 没有块时返回空串：composeSections 会跳过它，无规范时 prompt 与改动前逐字节相同
 */
export function composeNormsSection(scope: WritingNormScope, blocks: string[]): string {
  if (blocks.length === 0) return '';
  return [
    '【作者的写作规范】',
    '以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。',
    NORM_SCOPE_USAGE[scope],
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/**
 * 非构建器任务用：过滤 + 排序 + 渲染。过滤只经 normsInScope 一处，
 * 没有可注入的规范时返回空串（composeSections 会跳过）
 */
export function writingNormsSection(
  norms: readonly WritingNorm[] | undefined,
  scope: WritingNormScope,
): string {
  return composeNormsSection(scope, normsInScope(norms ?? [], scope).map(renderNormBlock));
}

/** 用空行连接若干段落，自动跳过空段 */
export function composeSections(sections: (string | undefined | null)[]): string {
  return sections
    .map((section) => section?.trim() ?? '')
    .filter((section) => section.length > 0)
    .join('\n\n');
}
