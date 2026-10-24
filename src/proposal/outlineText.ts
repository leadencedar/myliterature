/**
 * 大纲树的文本表示。
 *
 * 为什么不给每个大纲节点单独建提案：节点之间有父子关系，而子节点的
 * `parentId` 在父节点落库之前并不存在，逐条确认会让落库顺序变成隐式依赖。
 * 更关键的是体验 —— 一份二十个节点的大纲拆成二十个折叠块，在手机上
 * 根本没法通读，而大纲恰恰是需要整体把握的东西。
 *
 * 所以整棵树作为**一个**提案，内容用缩进标题的文本承载：
 * - 用户拿到的是一段可直接编辑的大纲文本，改结构就像改 Markdown 列表；
 * - 提案的 payload 只是一个字符串字段，diff、行内编辑、还原全都复用现成机制，
 *   确认管道不需要为树结构开任何特例。
 *
 * 格式：
 *   # 第一卷 风起（约 30000 字）
 *   主角被追杀，逃入雪山。
 *   ## 第1章 雪夜（约 3000 字）
 *   追兵临门。
 */

export interface OutlineDraft {
  title: string;
  synopsis: string;
  targetWords: number | null;
  children: OutlineDraft[];
}

/** 标题行里的字数标注，中英文括号都认 */
const WORD_COUNT_PATTERN = /[（(]\s*约?\s*([\d,]+)\s*字\s*[)）]\s*$/u;

function formatTitleLine(depth: number, node: OutlineDraft): string {
  const hashes = '#'.repeat(depth);
  const suffix = node.targetWords ? `（约 ${node.targetWords} 字）` : '';
  return `${hashes} ${node.title}${suffix}`;
}

/** 树 → 文本 */
export function serializeOutlineTree(nodes: OutlineDraft[]): string {
  const lines: string[] = [];

  const walk = (list: OutlineDraft[], depth: number) => {
    for (const node of list) {
      if (lines.length > 0) lines.push('');
      lines.push(formatTitleLine(depth, node));
      const synopsis = node.synopsis.trim();
      if (synopsis) lines.push(synopsis);
      if (node.children.length > 0) walk(node.children, depth + 1);
    }
  };

  walk(nodes, 1);
  return lines.join('\n');
}

/**
 * 文本 → 树。
 *
 * 容错优先：用户会手改这段文本，出现层级跳跃（# 后直接 ###）、
 * 开头就是深层标题、标题前有杂散文字等情况都不应该报错，
 * 而应尽量还原出一棵合理的树。
 */
export function parseOutlineTree(text: string): OutlineDraft[] {
  const roots: OutlineDraft[] = [];
  /** 各层级当前的「最后一个节点」，用于挂载子节点 */
  const stack: { depth: number; node: OutlineDraft }[] = [];
  let current: OutlineDraft | undefined;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = /^(#{1,6})\s*(.*)$/u.exec(line);
    if (!heading) {
      // 非标题行归入最近的节点作为梗概；标题之前的杂散文字直接丢弃
      if (current) {
        current.synopsis = current.synopsis ? `${current.synopsis}\n${line}` : line;
      }
      continue;
    }

    const depth = heading[1]!.length;
    let title = heading[2]!.trim();
    if (!title) continue;

    let targetWords: number | null = null;
    const wordCount = WORD_COUNT_PATTERN.exec(title);
    if (wordCount) {
      const parsed = Number(wordCount[1]!.replace(/,/gu, ''));
      if (Number.isFinite(parsed) && parsed > 0) targetWords = Math.round(parsed);
      title = title.replace(WORD_COUNT_PATTERN, '').trim();
    }
    if (!title) continue;

    const node: OutlineDraft = { title, synopsis: '', targetWords, children: [] };

    // 回退到比当前层级浅的最近祖先
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();

    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);

    stack.push({ depth, node });
    current = node;
  }

  return roots;
}

interface FlatOutlineNode {
  id: string;
  parentId: string | null;
  order: number;
  title: string;
  synopsis: string;
  targetWords: number | null;
}

/**
 * 库里的扁平节点 → 树。用于把现有大纲序列化成文本，作为 diff 的原值。
 *
 * `rootParentId` 决定从哪一层开始取：传 null 是整本书的大纲，
 * 传某个节点 id 则只取它的子树。**必须传入完整的节点列表**，
 * 而不是预先筛好的子节点 —— 否则孙节点会丢失。
 */
export function buildOutlineDrafts(
  nodes: FlatOutlineNode[],
  rootParentId: string | null = null,
): OutlineDraft[] {
  const childrenOf = (parentId: string | null): OutlineDraft[] =>
    nodes
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.order - b.order)
      .map((node) => ({
        title: node.title,
        synopsis: node.synopsis,
        targetWords: node.targetWords,
        children: childrenOf(node.id),
      }));

  return childrenOf(rootParentId);
}

/** 统计树的节点总数，用于给用户一个「这份大纲有多大」的直观感受 */
export function countOutlineNodes(nodes: OutlineDraft[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countOutlineNodes(node.children), 0);
}

/** 统计目标字数合计（忽略未标注的节点） */
export function sumOutlineTargetWords(nodes: OutlineDraft[]): number {
  return nodes.reduce((sum, node) => {
    // 有子节点时以子节点合计为准，避免父子重复计数
    const own =
      node.children.length > 0 ? sumOutlineTargetWords(node.children) : (node.targetWords ?? 0);
    return sum + own;
  }, 0);
}
