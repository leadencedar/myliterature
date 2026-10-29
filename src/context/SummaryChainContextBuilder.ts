import type {
  Category,
  Chapter,
  ChapterSummary,
  KnowledgeEntry,
  OutlineNode,
  SideStory,
} from '@/domain/schema';
import { mentionedEntries } from '@/domain/entrySearch';
import { chaptersOfTrack, renderSideStoryBrief, sideStoryLabel } from '@/domain/sideStory';
import { normsInScope } from '@/domain/writingNorm';
import {
  composeNormsSection,
  composeSections,
  composeStylePrefix,
  normTokens,
  renderNormBlock,
} from '@/prompt/sections';
import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_RECENT_SUMMARY_COUNT,
  MAX_INFERRED_ENTRIES,
  TAIL_EXCERPT_CHARS,
  type BuiltContext,
  type ContextBuilder,
  type ContextItem,
  type ContextRequest,
} from './ContextBuilder';
import { renderEntry, renderSummary } from './renderEntry';
import { selectStyleAnchor } from './styleAnchor';
import { estimateTokens } from './tokens';

/**
 * 摘要链版上下文构建器（阶段一实现）。
 *
 * 装箱顺序即优先级，超预算时从**末尾**开始丢：
 *
 *   稳定前缀  1 作品信息 → 2 风格档案 → 2.5 文风锚点（有则） → 3 写作规范 → 4 核心设定 → 5 勾选的关联条目
 *   易变后缀  6 大纲位置 → 7 全书进展 → 8 最近章节摘要 → 9 上一章结尾
 *
 * 两点值得说明：
 *
 * - **大纲位置放在易变后缀而不是稳定前缀**。它每章都不一样，放进前缀会把
 *   公共前缀截断在很靠前的位置，后面的核心设定与人物就都命中不了缓存了。
 *   前缀里只放「整本书都一样」的东西，缓存收益才最大。
 * - **预算约束的是成本与注意力，不是上下文窗口**。DeepSeek 有 1M 窗口，塞得进去
 *   不代表该塞 —— 无关设定越多，模型越容易被带偏，钱也白花。
 */
export class SummaryChainContextBuilder implements ContextBuilder {
  build(request: ContextRequest): BuiltContext {
    const budget = request.budget ?? DEFAULT_CONTEXT_BUDGET;
    const recentCount = request.recentSummaryCount ?? DEFAULT_RECENT_SUMMARY_COUNT;

    // 第一步先定线：主线与各部外传各自成链，之后的「上一章」「最近摘要」「预选」
    // 都只看这一条线。没有目标章节或找不到目标时按主线处理
    const targetChapter = request.targetChapterId
      ? request.chapters.find((chapter) => chapter.id === request.targetChapterId)
      : undefined;
    const track = targetChapter?.sideStoryId ?? null;
    const chapters = chaptersOfTrack(request.chapters, track);
    // track 非 null 但找不到外传（接线漏传或刚被删）时，退化成「只有同一外传前文」，
    // 不拿主线进展顶替
    const sideStory =
      track === null ? undefined : request.sideStories?.find((story) => story.id === track);

    // 外传章节不关联大纲
    const targetNode =
      track === null ? request.outline.find((node) => node.id === request.targetNodeId) : undefined;
    const previousChapter = findPreviousChapter(chapters, request.targetChapterId);
    const defaultEntryIds = computeDefaultEntryIds(request, targetNode, previousChapter, sideStory);
    const selectedIds = request.selectedEntryIds ?? defaultEntryIds;

    const items: ContextItem[] = [];
    let used = 0;

    /** 按预算决定是否收录某段内容 */
    const take = (item: Omit<ContextItem, 'included'>, text: string, mandatory = false): string => {
      if (!text.trim()) return '';
      if (!mandatory && used + item.tokens > budget) {
        items.push({ ...item, included: false, droppedReason: '超出 token 预算' });
        return '';
      }
      used += item.tokens;
      items.push({ ...item, included: true });
      return text;
    };

    // ---------------- 稳定前缀 ----------------

    // 作品信息与风格档案一起组装：它们同属「整本书的底色」，且本身就是一体的
    const styleText = composeStylePrefix(request.novel, request.style);
    const stableParts: string[] = [];
    stableParts.push(
      take(
        {
          kind: 'meta',
          id: 'meta+style',
          label: '作品信息与风格档案',
          tokens: estimateTokens(styleText),
        },
        styleText,
        // 没有它模型完全不知道在写什么，不参与预算裁剪
        true,
      ),
    );

    // 文风锚点（M4 S1）：作者此前正文的开头节选，用于对齐句式、节奏与叙述距离。
    // 放在风格档案之后、写作规范之前；每章选出的锚点可能随目标章推进而变，所以比规范更靠前。
    // 没有锚点（第一章/更早正文不足 300 字）时完全不产生文本与清单项，输出与改动前逐字节一致。
    const anchor = request.targetChapterId
      ? selectStyleAnchor(chapters, request.targetChapterId, track === null ? '第' : '外传第')
      : null;
    if (anchor) {
      const anchorText = [
        `【文风锚点 · ${anchor.label}（作者本人原文）】`,
        '下面这段是作者此前写下的正文。只用来对齐句式、节奏与叙述距离；不要复述或照搬其中的情节与句子。',
        anchor.text,
      ].join('\n');
      // 非强制：锚点是对齐语感的辅助材料，预算紧张时先让位给设定与大纲
      const taken = take(
        {
          kind: 'styleAnchor',
          id: anchor.chapterId,
          label: `文风锚点 · ${anchor.label}`,
          tokens: estimateTokens(anchorText),
        },
        anchorText,
      );
      if (taken) stableParts.push(taken);
    }

    // 写作规范：作者定下的约束，与风格档案同属整本书的底色，放在核心设定之前，
    // 这样确认新的核心设定不会让规范失去缓存。不参与预算裁剪，和核心设定同理 ——
    // 被预算悄悄挤掉等于约束失效。规范在稳定前缀里，主线与外传共用，不受 track 影响
    const norms = normsInScope(
      request.writingNorms ?? [],
      'writing',
      new Set(request.excludedNormIds ?? []),
    );
    const normBlocks: string[] = [];
    for (const norm of norms) {
      const text = renderNormBlock(norm);
      // tokens 用 normTokens，与知识库、picker 同口径（等于 estimateTokens(text)）
      const taken = take(
        { kind: 'norm', id: norm.id, label: `写作规范 · ${norm.title}`, tokens: normTokens(norm) },
        text,
        true,
      );
      if (taken) normBlocks.push(taken);
    }
    const normsText = composeNormsSection('writing', normBlocks);
    if (normsText) stableParts.push(normsText);

    // 核心设定始终注入且不可裁剪；勾选集合只管其余条目，两者不重叠。
    // 若让 pinned 也走勾选逻辑，它就会变成可被预算挤掉的普通条目，
    // 「核心设定」这个标记也就失去意义了。
    const pinned = request.entries.filter((entry) => entry.pinned);
    const selected = request.entries.filter(
      (entry) => !entry.pinned && selectedIds.includes(entry.id),
    );

    // 核心设定始终注入，且排在勾选条目之前（它更稳定）
    const pinnedBlocks: string[] = [];
    for (const entry of pinned) {
      const text = renderEntry(entry, request.categories);
      const taken = take(
        {
          kind: 'pinned',
          id: entry.id,
          label: `核心设定 · ${entry.title}`,
          tokens: estimateTokens(text),
        },
        text,
        true,
      );
      if (taken) pinnedBlocks.push(taken);
    }
    if (pinnedBlocks.length > 0) {
      stableParts.push(['【必须遵守的核心设定】', ...pinnedBlocks].join('\n\n'));
    }

    const entryBlocks: string[] = [];
    for (const entry of selected) {
      const text = renderEntry(entry, request.categories);
      const taken = take(
        {
          kind: 'entry',
          id: entry.id,
          label: `${categoryNameOf(entry, request.categories)} · ${entry.title}`,
          tokens: estimateTokens(text),
        },
        text,
      );
      if (taken) entryBlocks.push(taken);
    }
    if (entryBlocks.length > 0) {
      stableParts.push(['【相关设定】', ...entryBlocks].join('\n\n'));
    }

    // ---------------- 易变后缀 ----------------

    const volatileParts: string[] = [];

    if (targetNode) {
      const outlineText = renderOutlineContext(request.outline, targetNode);
      volatileParts.push(
        take(
          {
            kind: 'outline',
            id: targetNode.id,
            label: `大纲位置 · ${targetNode.title}`,
            tokens: estimateTokens(outlineText),
          },
          outlineText,
          true,
        ),
      );
    }

    if (sideStory) {
      // 外传说明块放在易变后缀：它每部外传都不同，放进前缀会截断主线与外传共用的缓存前缀
      const briefText = renderSideStoryBrief(sideStory);
      volatileParts.push(
        take(
          {
            kind: 'sideStory',
            id: sideStory.id,
            label: `${sideStoryLabel(sideStory)} 说明`,
            tokens: estimateTokens(briefText),
          },
          briefText,
          true,
        ),
      );
    }

    // 由推演沉淀的章节：四块推演材料（D7.3），在大纲位置 / 外传说明之后、【故事至此】之前。
    // 都是必选 —— 它们就是本章要写的材料，和大纲位置同理不参与预算裁剪；空串的块 take 会跳过、不进清单。
    // 放在易变后缀：每章都不同，进前缀会截断全书共用的缓存前缀。没有 scenarioContext 时这里一行都不走
    const scenario = request.scenarioContext;
    if (scenario) {
      const blocks: { id: string; label: string; text: string }[] = [
        { id: 'scenario-limited', label: scenario.limitedLabel, text: scenario.limitedText },
        { id: 'scenario-fork', label: '分叉之前的经过', text: scenario.forkText },
        { id: 'scenario-steps', label: scenario.label, text: scenario.stepsText },
        { id: 'scenario-state', label: '世界线状态', text: scenario.stateText },
      ];
      for (const block of blocks) {
        volatileParts.push(
          take(
            {
              kind: 'scenario',
              id: block.id,
              label: block.label,
              tokens: estimateTokens(block.text),
            },
            block.text,
            true,
          ),
        );
      }
    }

    const rolling = request.novel.rollingSummary.trim();
    if (track === null) {
      if (rolling) {
        volatileParts.push(
          take(
            {
              kind: 'rolling',
              id: 'rolling',
              label: '全书进展摘要',
              tokens: estimateTokens(rolling),
            },
            `【故事至此】\n${rolling}`,
          ),
        );
      }
    } else {
      const sideRolling = sideStory?.rollingSummary.trim() ?? '';
      if (sideRolling) {
        volatileParts.push(
          take(
            {
              kind: 'rolling',
              id: 'rolling-side',
              label: '外传进展摘要',
              tokens: estimateTokens(sideRolling),
            },
            `【外传至此】\n${sideRolling}`,
          ),
        );
      }
      // 主线进展只在用户明确打开时注入；前传带上它，人物容易提前知道后来的事
      if (request.includeMainProgress && rolling) {
        volatileParts.push(
          take(
            {
              kind: 'rolling',
              id: 'rolling-main',
              label: '主线全书进展（参考）',
              tokens: estimateTokens(rolling),
            },
            `【主线进展（仅供参考，外传不必衔接它）】\n${rolling}`,
          ),
        );
      }
    }

    // 标签里写「外传第 N 章」不带外传名：同一次生成只会出现一部外传，名字已在说明块里
    const chapterWord = track === null ? '第' : '外传第';
    const recentSummaries = pickRecentSummaries(
      chapters,
      request.summaries,
      request.targetChapterId,
      recentCount,
    );
    const summaryBlocks: string[] = [];
    for (const { chapter, summary } of recentSummaries) {
      const text = renderSummary(chapter, summary);
      const taken = take(
        {
          kind: 'summary',
          id: summary.id,
          label: `${chapterWord} ${chapter.index} 章摘要`,
          tokens: estimateTokens(text),
        },
        text,
      );
      if (taken) summaryBlocks.push(taken);
    }
    if (summaryBlocks.length > 0) {
      volatileParts.push(['【前几章要点】', ...summaryBlocks].join('\n\n'));
    }

    if (previousChapter?.content.trim()) {
      const excerpt = previousChapter.content.trim().slice(-TAIL_EXCERPT_CHARS);
      const text = [
        `【上一章（${chapterWord} ${previousChapter.index} 章）的结尾原文】`,
        '接着这段往下写，语气与节奏要能接住。',
        '',
        excerpt,
      ].join('\n');
      volatileParts.push(
        take(
          {
            kind: 'tail',
            id: previousChapter.id,
            label: `${chapterWord} ${previousChapter.index} 章结尾原文`,
            tokens: estimateTokens(text),
          },
          text,
        ),
      );
    }

    const result: BuiltContext = {
      stablePrefix: composeSections(stableParts),
      volatileSuffix: composeSections(volatileParts),
      items,
      estimatedTokens: used,
      defaultEntryIds,
    };
    if (previousChapter) result.previousChapter = previousChapter;
    return result;
  }
}

/**
 * 默认预选，**不含核心设定**（它们始终注入，不需要也不应该由用户勾选）。
 *
 * 四个来源，分成两档：
 *
 * | 档 | 来源 | 为什么 |
 * |---|---|---|
 * | 显式 | 大纲节点的 `linkedEntryIds` | 作者亲手关联的，最可信 |
 * | 显式 | 上一章摘要的 `appearingEntryIds` | 不带上，连续两章里同一个人物的说话方式会突然变样 —— 长篇里最容易被读者察觉的崩坏 |
 * | 推断 | 大纲节点的标题与梗概里提到的名字 | 梗概写着「沈砚在渡口遇见裴照」，这两个人显然该进上下文 |
 * | 推断 | 上一章摘要正文与关键事件里提到的名字 | 摘要的 `appearingEntryIds` 常常是空的，但摘要文字里写着谁 |
 *
 * **两个推断来源是补上一个真实缺口，不是锦上添花。** 原先只有两个显式来源，
 * 而它们在最常见的路径上都是空的：
 * - 立项生成的大纲走 `outlineTree` 提案，payload 只有一段缩进标题文本，
 *   落库时不写 `linkedEntryIds` —— 除非作者事后在大纲抽屉里手动逐个关联，它永远是 `[]`；
 * - 第一章没有上一章；
 * - 导入的旧稿没有大纲，而且早期章节摘要的 `appearingEntryIds` 也基本是空的
 *   （提取那一刻新条目还没落库，解析不出 id）。
 *
 * 结果就是「关联设定全靠用户自己勾」。本地名称匹配不花钱、不调模型，
 * 足以把绝大多数情况下的预选从零变成可用。
 *
 * 推断来源**有数量上限**：一个用了常见词做别名的条目（比如别名「师父」）会命中大量文本，
 * 不设上限会把几十条无关设定拉进 prompt —— 那既贵又稀释注意力，正是装箱要避免的事。
 * 显式来源不受此限：作者亲手关联了十五条，就该给他十五条。
 */
function computeDefaultEntryIds(
  request: ContextRequest,
  targetNode: OutlineNode | undefined,
  previousChapter: Chapter | undefined,
  sideStory: SideStory | undefined,
): string[] {
  // 过滤基准：已删除或不存在的 id 要丢掉，核心设定不参与勾选
  const selectable = new Map(
    request.entries.filter((entry) => !entry.pinned).map((entry) => [entry.id, entry]),
  );
  const usable = (id: string): boolean => selectable.has(id);

  const explicit = new Set<string>();
  for (const id of targetNode?.linkedEntryIds ?? []) {
    if (usable(id)) explicit.add(id);
  }

  const previousSummary = previousChapter
    ? request.summaries.find((item) => item.chapterId === previousChapter.id)
    : undefined;
  for (const id of previousSummary?.appearingEntryIds ?? []) {
    if (usable(id)) explicit.add(id);
  }

  // 推演沉淀的章节（design-addendum 第 2 条）：通用主角并入显式档。外传章节没有大纲节点、
  // 简介也不一定提到主角，只靠上面两个来源的话他的档案会漏掉。限定条目本来就不在 entries 里
  const scenario = request.scenarioContext;
  if (scenario) {
    for (const id of scenario.castEntryIds) {
      const entry = selectable.get(id);
      if (!entry || (entry.deletedAt ?? null) !== null) continue;
      if ((entry.scope?.kind ?? 'universal') !== 'universal') continue;
      explicit.add(id);
    }
  }

  // 推断：把大纲位置（外传章节没有大纲，用外传简介）与上一章摘要的文字拿来做名称匹配
  const hintParts = [
    targetNode?.title ?? '',
    targetNode?.synopsis ?? '',
    sideStory?.synopsis ?? '',
    previousSummary?.summary ?? '',
    ...(previousSummary?.keyEvents ?? []),
  ];
  // 推演章节再加本章步骤原文与外传细纲：本章真正出场的人物写在那里
  if (scenario?.hintText) hintParts.push(scenario.hintText);
  const hints = hintParts.filter(Boolean).join('\n');

  const inferred: string[] = [];
  for (const entry of mentionedEntries(hints, [...selectable.values()])) {
    if (explicit.has(entry.id)) continue;
    inferred.push(entry.id);
    if (inferred.length >= MAX_INFERRED_ENTRIES) break;
  }

  // 显式在前：装箱顺序即优先级，预算紧张时先丢掉的应该是推断出来的那些
  return [...explicit, ...inferred];
}

/**
 * 「上一章」= 目标章节之前 index 最大的一章；没有目标章节时取最后一章。
 * 传进来的已经是同一条线的章节（主线或某一部外传）
 */
function findPreviousChapter(
  chapters: Chapter[],
  targetChapterId: string | null,
): Chapter | undefined {
  const sorted = [...chapters].sort((a, b) => a.index - b.index);
  if (!targetChapterId) return sorted[sorted.length - 1];
  const target = sorted.find((chapter) => chapter.id === targetChapterId);
  if (!target) return sorted[sorted.length - 1];
  const earlier = sorted.filter((chapter) => chapter.index < target.index);
  return earlier[earlier.length - 1];
}

/** 取目标章节之前最近 N 章的摘要，按章节顺序返回 */
function pickRecentSummaries(
  chapters: Chapter[],
  summaries: ChapterSummary[],
  targetChapterId: string | null,
  count: number,
): { chapter: Chapter; summary: ChapterSummary }[] {
  if (count <= 0) return [];
  const sorted = [...chapters].sort((a, b) => a.index - b.index);
  const target = targetChapterId
    ? sorted.find((chapter) => chapter.id === targetChapterId)
    : undefined;
  const candidates = target ? sorted.filter((chapter) => chapter.index < target.index) : sorted;

  const withSummary = candidates
    .map((chapter) => ({
      chapter,
      summary: summaries.find((item) => item.chapterId === chapter.id),
    }))
    .filter((pair): pair is { chapter: Chapter; summary: ChapterSummary } => Boolean(pair.summary));

  return withSummary.slice(-count);
}

function categoryNameOf(entry: KnowledgeEntry, categories: Category[]): string {
  return categories.find((category) => category.id === entry.categoryId)?.name ?? '设定';
}

/** 目标节点在全书中的位置：祖先链 + 自身梗概 + 前后兄弟 */
function renderOutlineContext(nodes: OutlineNode[], target: OutlineNode): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors: OutlineNode[] = [];
  const seen = new Set<string>();
  let cursor = target.parentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    ancestors.unshift(parent);
    cursor = parent.parentId;
  }

  const lines = ['【本章要写的内容】'];
  if (ancestors.length > 0) {
    lines.push(`所在位置：${ancestors.map((node) => node.title).join(' → ')}`);
    const volume = ancestors[ancestors.length - 1];
    if (volume?.synopsis.trim()) lines.push(`所在卷的梗概：${volume.synopsis.trim()}`);
  }
  lines.push(`本章标题：${target.title}`);
  if (target.synopsis.trim()) lines.push(`本章梗概：${target.synopsis.trim()}`);
  if (target.targetWords) lines.push(`目标字数：约 ${target.targetWords} 字`);

  const siblings = nodes
    .filter((node) => node.parentId === target.parentId)
    .sort((a, b) => a.order - b.order);
  const index = siblings.findIndex((node) => node.id === target.id);
  const next = index >= 0 ? siblings[index + 1] : undefined;
  if (next) {
    lines.push('');
    lines.push(
      `下一章是「${next.title}」${next.synopsis.trim() ? `：${next.synopsis.trim()}` : ''}`,
    );
    lines.push('本章不要提前写掉下一章的内容，但要为它铺好路。');
  }

  return lines.join('\n');
}

// renderEntry / renderSummary 搬到 ./renderEntry：规划侧要复用同一份渲染，
// 原文件保留 re-export，让 normCheck 与既有测试的导入一句都不用改。
export { renderEntry, renderSummary } from './renderEntry';
