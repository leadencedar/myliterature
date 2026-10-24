import { z } from 'zod';
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
 */
export function buildExpandSystemPrompt(
  novel: Novel,
  style: StyleProfile,
  norms?: readonly WritingNorm[],
): string {
  return composeSections([
    '你是一位资深的小说策划编辑，擅长把粗线条的大纲逐层细化成可直接开写的场景。',
    composeStylePrefix(novel, style),
    writingNormsSection(norms, 'planning'),
    EXPAND_TASK,
  ]);
}

export function buildExpandUserPrompt(params: {
  node: OutlineNode;
  ancestors: OutlineNode[];
  siblings: OutlineNode[];
  existingChildren: OutlineNode[];
  linkedEntries: KnowledgeEntry[];
  count: number;
  extra?: string;
}): string {
  const lines = [contextSection(params), `【本次要求】\n拆成 ${params.count} 个子节点。`];
  if (params.extra?.trim()) {
    lines.push(`【用户额外要求】\n${params.extra.trim()}`);
  }
  return lines.join('\n\n');
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
