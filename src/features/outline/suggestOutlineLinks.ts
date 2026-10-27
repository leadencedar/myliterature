import { rankEntryMentions } from '@/domain/entryMention';
import type { KnowledgeEntry, OutlineNode } from '@/domain/schema';

/**
 * 采用细化结果后，「每个新子节点该关联哪些条目」的本地建议。
 *
 * 只建议、不写库：作者在关联确认面板里确认后才写 linkedEntryIds（D1）。
 * 做成纯函数是为了 M3 自动大纲也能复用：输入节点与条目，不绑定本次细化流程。
 *
 * 两类来源：
 * - inherited：父节点的手工关联。父节点是作者显式选过的，新子节点默认继承，
 *   否则每次细化都会丢掉父层的设定约束；排在建议最前面。
 * - mentioned：子节点标题/梗概里出现的名字（复用 S1 的评分匹配）。
 *   宁漏勿错：短名/泛化别名已经降权，泛化命中最多排在后面。
 */

export interface SuggestedLink {
  entry: KnowledgeEntry;
  reason: 'inherited' | 'mentioned';
  /** mentioned 时的实际命中名（可能是别名），作者据此判断「关联的是名字还是别名」 */
  matchedName?: string;
}

export interface ChildLinkSuggestion {
  child: OutlineNode;
  suggestions: SuggestedLink[];
}

export interface SuggestOutlineLinksInput {
  parent: OutlineNode;
  /** 只传本次新产生的子节点（细化前快照的差集），旧节点不重复建议 */
  children: readonly OutlineNode[];
  /** 调用方已按「通用、未删除」过滤；这里仍防御性跳过软删除与 pinned */
  entries: readonly KnowledgeEntry[];
  limitPerChild?: number;
  /** "childId:entryId" 的会话内移除记忆 */
  suppressed?: ReadonlySet<string>;
}

/** 每个子节点的建议上限（D1）：继承的显式关联不设限，提到项只补足剩余名额 */
export const DEFAULT_LINKS_PER_CHILD = 8;

function usable(entry: KnowledgeEntry): boolean {
  return (entry.deletedAt ?? null) === null && !entry.pinned;
}

export function suggestOutlineLinks(input: SuggestOutlineLinksInput): ChildLinkSuggestion[] {
  const limit = input.limitPerChild ?? DEFAULT_LINKS_PER_CHILD;
  const suppressed = input.suppressed;
  const byId = new Map(input.entries.filter(usable).map((entry) => [entry.id, entry]));

  // 父节点的显式关联：按 linkedEntryIds 顺序原样继承，已删除/不存在的 id 丢掉。
  // 显式关联是作者亲手选的，不占「提到」的 8 条名额，也不被上限截断
  const inherited: SuggestedLink[] = [];
  const inheritedIds = new Set<string>();
  for (const id of input.parent.linkedEntryIds) {
    if (inheritedIds.has(id)) continue;
    inheritedIds.add(id);
    const entry = byId.get(id);
    if (!entry) continue;
    inherited.push({ entry, reason: 'inherited' });
  }

  const mentionedRoom = Math.max(0, limit - inherited.length);
  const result: ChildLinkSuggestion[] = [];
  for (const child of input.children) {
    const suggestions: SuggestedLink[] = inherited.map((link) => ({ ...link }));
    if (mentionedRoom > 0) {
      // 子节点自己已有的关联不再建议（append 场景），否则会重复写入同一批 id
      const ownIds = new Set(child.linkedEntryIds);
      const candidates = rankEntryMentions(
        [child.title, child.synopsis],
        input.entries.filter(
          (entry) => usable(entry) && !inheritedIds.has(entry.id) && !ownIds.has(entry.id),
        ),
        { limit: mentionedRoom },
      );
      for (const mention of candidates) {
        if (suggestions.length >= limit) break;
        if (suppressed?.has(`${child.id}:${mention.entry.id}`)) continue;
        suggestions.push({
          entry: mention.entry,
          reason: 'mentioned',
          matchedName: mention.matchedName,
        });
      }
    }
    // 无建议的子节点不出现：面板只呈现真正需要作者决定的内容
    if (suggestions.length > 0) result.push({ child, suggestions });
  }
  return result;
}
