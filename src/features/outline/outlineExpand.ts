import { z } from 'zod';
import type { PlanningEntryBlock } from '@/context/planningContext';
import type {
  KnowledgeEntry,
  Novel,
  OutlineNode,
  StyleProfile,
  WritingNorm,
} from '@/domain/schema';
import { composeSections, composeStylePrefix, writingNormsSection } from '@/prompt/sections';
import type { OutlineDraft } from '@/proposal/outlineText';

/**
 * 把一个大纲节点扩写成更细的子节点。
 *
 * 这正是雪花法的做法：不一次性写出全书细目，而是逐层细化，
 * 每一层都以上一层已确认的内容为约束。
 */

export const ExpandedChildSchema = z.object({
  title: z.string().min(1, '子节点标题不能为空'),
  synopsis: z.string().min(1, '梗概不能为空'),
  targetWords: z.number().int().positive().nullable(),
});

export const OutlineExpandSchema = z.object({
  children: z.array(ExpandedChildSchema).min(2, '至少要拆成 2 个子节点'),
});

export type OutlineExpandResult = z.infer<typeof OutlineExpandSchema>;

export function toChildDrafts(result: OutlineExpandResult): OutlineDraft[] {
  return result.children.map((child) => ({
    title: child.title,
    synopsis: child.synopsis,
    targetWords: child.targetWords,
    children: [],
  }));
}

/**
 * 细化任务的约束。
 *
 * 前半段是原有约束（不删：它们保证「只拆这一层、颗粒度一致、因果推进」）；
 * 后半段是 M1 增补的场景卡要求 —— 细纲要能直接开写，而不是事件概述或设定复述。
 * 规则本身不点名要求写哪些设定，只要求把「软肋/规则代价」写成一次改变后文的选择：
 * 点名会让模型为凑关联硬塞人物，写代价才逼它真的用上设定。
 */
const EXPAND_TASK = [
  '【任务】',
  '把用户指定的那个大纲节点，拆成下一层的若干子节点。',
  '',
  '要求：',
  '- 只拆这一个节点，不要改动它本身，也不要涉及它的兄弟节点。',
  '- 子节点要覆盖该节点梗概里承诺的全部内容，既不遗漏也不越界。',
  '- 同一层的颗粒度要一致：不要有的子节点是一个场景、有的是半卷剧情。',
  '- 每个子节点的梗概都要能说清「谁想做什么、遇到什么阻碍、结果如何」，避免只写氛围。',
  '- 子节点之间要有因果推进，前一个的结果构成后一个的前提。',
  '- targetWords 给出该子节点的预估字数；无法判断时填 null。',
  '- 每个子节点的梗概按「场景卡」写：谁想要什么、什么在阻碍、转折点在哪里、结尾留下什么局面或认知变化；不要只写「发生了某事」。',
  '- 至少有一处，要让人物在软肋或世界规则的代价上做出一次选择或拒绝，且这次选择必须改变后文走向；「他想起妹妹」这种内心一笔不算。把设定复述进梗概不算「应用设定」。',
  '- 梗概里可以点名涉及的人物、地点、道具（用知识库中的名字或别名）；世界规则不要点名复述，只写它逼出的代价。不要为凑关联硬塞无关人物。',
  '- 不得违背【必须遵守的核心设定】；与梗概冲突时以设定为准，并把约束的代价写进情节。',
  '- 章末要能看出钩子与信息差：谁知道什么、读者被瞒了什么。',
  '- 子节点 targetWords 之和应接近父节点的目标字数，但不凑数拉长；情节量不足时宁短。父节点没有目标时按每章约 3000 字估。',
].join('\n');

/** 供模型参考的上下文：父节点在全书中的位置，以及相关的设定条目 */
function contextSection(params: {
  node: OutlineNode;
  ancestors: OutlineNode[];
  siblings: OutlineNode[];
  existingChildren: OutlineNode[];
  linkedEntries: KnowledgeEntry[];
}): string {
  const lines: string[] = ['【当前位置】'];

  if (params.ancestors.length > 0) {
    lines.push(`所属层级：${params.ancestors.map((item) => item.title).join(' → ')}`);
  }
  lines.push(`要拆分的节点：${params.node.title}`);
  if (params.node.synopsis.trim()) lines.push(`该节点梗概：${params.node.synopsis.trim()}`);
  if (params.node.targetWords) lines.push(`该节点目标字数：${params.node.targetWords}`);

  const siblings = params.siblings.filter((item) => item.id !== params.node.id);
  if (siblings.length > 0) {
    lines.push('');
    lines.push('同层的其他节点（用于把握边界，不要写进它们的内容）：');
    for (const sibling of siblings) {
      lines.push(`- ${sibling.title}${sibling.synopsis ? `：${sibling.synopsis}` : ''}`);
    }
  }

  if (params.existingChildren.length > 0) {
    lines.push('');
    lines.push('该节点已有的子节点（本次将被替换，可参考也可推翻）：');
    for (const child of params.existingChildren) {
      lines.push(`- ${child.title}${child.synopsis ? `：${child.synopsis}` : ''}`);
    }
  }

  if (params.linkedEntries.length > 0) {
    lines.push('');
    lines.push('关联设定：');
    for (const entry of params.linkedEntries) {
      lines.push(`- ${entry.title}${entry.summary ? `：${entry.summary}` : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * norms 是可选尾参数：不传或没有作用范围含「规划」的规范时，输出与改动前逐字节相同。
 * 规范排在稳定前缀之后、任务说明之前：它和风格档案一样很少变，放前面才能和前缀一起命中缓存
 *
 * core 是 M1 新增的核心设定（pinned）：放 system 而不是 user，因为同一本书内它稳定，
 * 不同节点细化可以共享同一段前缀；逐节点变化的相关设定才放 user（见 buildExpandUserPrompt）。
 * 不传或为空时与改动前逐字节相同。
 */
export function buildExpandSystemPrompt(
  novel: Novel,
  style: StyleProfile,
  norms?: readonly WritingNorm[],
  core?: readonly PlanningEntryBlock[],
): string {
  const sections = [
    '你是一位资深的小说策划编辑，擅长把粗线条的大纲逐层细化成可直接开写的场景。',
    composeStylePrefix(novel, style),
    writingNormsSection(norms, 'planning'),
  ];
  if (core && core.length > 0) {
    // 格式与正文侧 SummaryChainContextBuilder 的核心设定块一致（标题 + 每条渲染块）
    sections.push(['【必须遵守的核心设定】', ...core.map((block) => block.text)].join('\n\n'));
  }
  sections.push(EXPAND_TASK);
  return composeSections(sections);
}

/** 【相关设定】块：完整字段渲染（复用正文侧 renderEntry），不降级为「标题：摘要」 */
function relatedSection(related: readonly PlanningEntryBlock[]): string {
  return [
    '【相关设定】',
    '以下设定与本次细化相关，子节点要体现它们的约束与关系；不得违背核心设定。不需要复述设定原文。',
    ...related.map((block) => block.text),
  ].join('\n\n');
}

/**
 * 细化用户提示。
 *
 * 新增参数全部可选，且**只在有值时追加块**：不传新参数时输出与改动前逐字节相同
 * （旧测试/旧调用据此固定）。related 与旧的 linkedEntries 是二选一：
 * 传了 related 就以它为准（完整字段、可含名称命中的条目），没传才回退旧的「标题：摘要」。
 */
export function buildExpandUserPrompt(params: {
  node: OutlineNode;
  ancestors: OutlineNode[];
  siblings: OutlineNode[];
  existingChildren: OutlineNode[];
  /** 旧参数：related 不传时按旧「标题：摘要」渲染，保证既有调用逐字节不变 */
  linkedEntries: KnowledgeEntry[];
  count: number;
  extra?: string;
  /** 新增：显式关联 + 名称命中（完整字段）；传了就优先于 linkedEntries */
  related?: readonly PlanningEntryBlock[];
  /** 新增：当前未收束的伏笔（累计），空则不渲染 */
  openThreads?: readonly string[];
  /** 新增：仅顶层节点（depth === 0）注入，避免下层细化提前知道全书进展 */
  rollingSummary?: string;
  /** 新增：当前节点深度，0 为顶层 */
  depth?: number;
  /**
   * 新增：因预算未注入的条目。刻意不写进 prompt —— 设计 §4.2 的块顺序里没有它，
   * 而把没渲染的设定只列个标题，模型会凭标题编造内容；保留在签名里供调用方与面板
   * 共用同一份选择结果（未注入提示由 UI 展示）。
   */
  relatedDropped?: readonly PlanningEntryBlock[];
}): string {
  const blocks: string[] = [
    contextSection({
      node: params.node,
      ancestors: params.ancestors,
      siblings: params.siblings,
      existingChildren: params.existingChildren,
      // related 是权威集合：给了它就不再回退渲染 linkedEntries，避免同一批条目出现两遍。
      // 传空数组也一样（表示「本次没有相关设定」），这是与旧调用的分界
      linkedEntries: params.related === undefined ? params.linkedEntries : [],
    }),
  ];

  if (params.related && params.related.length > 0) {
    blocks.push(relatedSection(params.related));
  }

  const threads = (params.openThreads ?? [])
    .map((thread) => thread.trim())
    .filter((thread) => thread.length > 0);
  if (threads.length > 0) {
    // 与导入提取的伏笔块同一种写法（标题 + 逐条 -），作者在两种任务里看到一致的结构
    blocks.push(['【当前未收束的伏笔】', ...threads.map((thread) => `- ${thread}`)].join('\n'));
  }

  const rolling = params.depth === 0 ? (params.rollingSummary?.trim() ?? '') : '';
  if (rolling) {
    blocks.push(`【故事至此】\n${rolling}`);
  }

  blocks.push(`【本次要求】\n拆成 ${params.count} 个子节点。`);
  if (params.extra?.trim()) {
    blocks.push(`【用户额外要求】\n${params.extra.trim()}`);
  }
  return blocks.join('\n\n');
}

/** 取某节点的祖先链，由外到内 */
export function ancestorsOf(nodes: OutlineNode[], nodeId: string): OutlineNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chain: OutlineNode[] = [];
  let cursor = byId.get(nodeId)?.parentId ?? null;
  // 顺着 parentId 往上走，顺便防御数据里可能出现的环
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    chain.unshift(parent);
    cursor = parent.parentId;
  }
  return chain;
}
