/**
 * 章节归档服务（M2 S2）。
 *
 * 作者把章节标成「已完成」时，后台跑一次结构化调用，把这一章变成三样待确认提案：
 * 本章摘要、全书/外传进展、知识库条目变更。全部经 ProposalInbox 确认才落库
 * （D3：AI 产出一律提案确认，不自动写回）。
 *
 * 几个关键取舍：
 *
 * 1. **摘要必须成功，条目可以降级**。摘要链是后续所有章节的上下文来源，断一章
 *    后面会一路「AI 不记得前文」；条目少一条只是知识库晚点补。所以条目提取被
 *    截断时降级为一次摘要专用调用，标记 `entriesDegraded`，而不是整体失败。
 * 2. **幂等靠「先清本章 pending 摘要 + 条目按名称合并」**，不靠批次状态。批次只是
 *    收件箱分组（5 章 / 24h），本地存储丢了也不会重复出提案。
 * 3. **上限按「确认成本」算**：普通条目每章最多 3 条；人物分类新条目单独一档
 *    （每章最多 3 条）。人物新登场若不即时提，下次出场口吻就漂了；但群像章一次
 *    弹十几条同样没人看，所以豁免也有上限。
 */
import type { NovelRepository } from '@/data/NovelRepository';
import { normalizeEntryName } from '@/domain/entrySearch';
import type {
  Category,
  Chapter,
  ChapterSummary,
  ImportEntryDraft,
  KnowledgeEntry,
  Novel,
  Proposal,
  SideStory,
  WritingNorm,
} from '@/domain/schema';
import { chapterLabel } from '@/domain/sideStory';
import {
  ExtractResultSchema,
  accumulateEntryDrafts,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
  draftToEntryPayload,
  findMentionedEntries,
  type ExtractEntry,
} from '@/features/import/extractSettings';
import { buildEntryProposal } from '@/features/import/importProposals';
import { LlmError } from '@/llm/errors';
import type { LlmRunner } from '@/llm/useLlm';
import { buildCreateProposal, buildReplaceProposal } from '@/proposal/build';
import { computeDiff, mergeEntities } from '@/proposal/diff';
import { entryFieldSpecs, fieldSpecsFor } from '@/proposal/fields';
import { getOrCreateArchiveBatch } from './archiveBatch';
import { saveArchiveAudit } from './archiveAudit';
import {
  ChapterSummaryResultSchema,
  buildSummarySystemPrompt,
  buildSummaryUserPrompt,
  mergeOpenThreads,
  previousSummaryOf,
  resolveEntryNames,
} from './chapterSummary';

/** 普通条目（新增/变更）每章最多出几条提案；人物新条目另有同额度的豁免 */
export const MAX_ENTRY_PROPOSALS_PER_CHAPTER = 3;

/**
 * 归档路径专用的条目门槛，追加在提取 prompt 末尾。
 *
 * 不放进 `buildExtractUserPrompt`：导入链路（旧稿反向提取）的目标是「把已有正文里
 * 出现过的角色都建档」，职务龙套也该保留；归档的目标是「给后续写作攒可复用设定」，
 * 每章都记下船夫、茶博士只会把知识库和确认收件箱一起撑爆。两条链路的要求相反，
 * 所以只在归档这边追加，导入链路逐字节不变。
 */
export const ARCHIVE_EXTRACT_EXTRA_REQUIREMENT = [
  '【归档额外要求】',
  '- 只为本章有名字、或有台词且预计会再出场的人物建立人物条目；「船夫」「茶博士」「路人」这类职务/一次性龙套不要建条目，除非本章明确给了名字且后续会再出现。',
  '- 已有条目即使戏份少也按合并规则补全，不要因此新建同名条目。',
].join('\n');

/** 把归档专属的条目门槛接在提取 prompt 之后；导入链路不经过这个函数 */
function withArchiveEntryGuidance(userPrompt: string): string {
  return `${userPrompt}\n\n${ARCHIVE_EXTRACT_EXTRA_REQUIREMENT}`;
}

export interface ArchiveChapterInput {
  novel: Novel;
  chapter: Chapter;
  chapters: Chapter[];
  summaries: ChapterSummary[];
  entries: KnowledgeEntry[];
  categories: Category[];
  /** 外传章节必须传所属外传；主线章节不传 */
  sideStory?: SideStory;
  writingNorms?: readonly WritingNorm[];
  options: {
    /** 关掉时只生成摘要/进展，不提取条目（仍是一次摘要调用，成本更低） */
    extractEntries: boolean;
  };
}

/** 本章伏笔流水：新埋 / 收束 / 截至本章的现存清单 */
export interface ArchiveChapterThreads {
  opened: string[];
  resolved: string[];
  open: string[];
}

export interface ArchiveChapterResult {
  /** 本批提案共用的 batchId（收件箱按它查） */
  batchId: string;
  /** 摘要/进展提案是否创建成功；成功返回时恒为 true */
  summaryCreated: boolean;
  /** 本轮新建或合并更新的条目提案数（不含无变化跳过的） */
  entryCount: number;
  /** 当前本批 pending 的条目提案数（旧口径；M2.1 起状态行请改用 pendingTotal） */
  pendingCount: number;
  /**
   * 本批全部 pending 提案数（摘要 + 进展 + 条目）。
   * M2.1：状态行与挂载恢复都用这个口径，避免「只报条目数」让作者低估待确认量。
   */
  pendingTotal: number;
  /** 本章伏笔流水，同时写入 localStorage 审计供收件箱展示 */
  threads: ArchiveChapterThreads;
  /** 条目提取被截断、已降级为只出摘要；本轮没有条目提案 */
  entriesDegraded: boolean;
}

/** 摘要/进展/条目共用的模型输出里，摘要部分的结构（两条调用路径的公共形状） */
interface ArchiveSummaryData {
  summary: string;
  keyEvents: string[];
  appearingEntries: string[];
  newOpenThreads: string[];
  resolvedThreads: string[];
  rollingSummary: string;
}

interface ArchiveChapterDeps {
  repository: NovelRepository;
  llm: LlmRunner;
}

/**
 * 清掉本章尚未确认的摘要提案。
 *
 * 归档与手动「生成摘要」都可能在确认前被重复触发；不先清旧 pending，收件箱里就会
 * 出现同一章的两份摘要，作者不知道该看哪份。导出供 ChapterSummarySheet 复用。
 *
 * 需要 novelId 才能列出提案 —— 仓储没有跨作品查询 pending 的入口，所以签名比
 * 评审记录里的两参版本多一个 novelId。
 *
 * @returns 被清掉的 pending 摘要提案数
 */
export async function supersedePendingChapterSummary(
  repository: NovelRepository,
  novelId: string,
  chapterId: string,
): Promise<number> {
  const pending = await repository.listProposals(novelId, { status: 'pending' });
  const stale = pending.filter(
    (proposal) =>
      proposal.target === 'chapterSummary' &&
      asPayloadRecord(proposal.payload)?.chapterId === chapterId,
  );
  for (const proposal of stale) {
    await repository.deleteProposal(proposal.id);
  }
  return stale.length;
}

/** 把一条提案变成待确认的摘要/进展/条目提案集合 */
export async function archiveChapter(
  deps: ArchiveChapterDeps,
  input: ArchiveChapterInput,
): Promise<ArchiveChapterResult> {
  const { repository, llm } = deps;
  const {
    novel,
    chapter,
    chapters,
    summaries,
    entries,
    categories,
    sideStory,
    writingNorms,
    options,
  } = input;

  if (!chapter.content.trim()) {
    throw new Error('本章还没有正文，无法生成档案');
  }
  // 外传章节误当主线归档会把全书进展写成外传进展（跨线污染），宁可显式报错
  if (chapter.sideStoryId !== null && !sideStory) {
    throw new Error('外传章节归档需要传入所属外传');
  }

  const previous = previousSummaryOf(chapters, summaries, chapter.id);
  const mentioned = findMentionedEntries(chapter.content, entries);
  const mentionedIds = new Set(mentioned.map((entry) => entry.id));
  const otherEntryNames = entries
    .filter((entry) => !mentionedIds.has(entry.id))
    .map((entry) => entry.title);
  const previousOpenThreads = previous?.openThreads ?? [];
  const currentRollingSummary = sideStory ? sideStory.rollingSummary : novel.rollingSummary;
  const sideStoryBlock = sideStory
    ? { sideStory: { title: sideStory.title, synopsis: sideStory.synopsis } }
    : {};

  let summaryData: ArchiveSummaryData;
  let extractedEntries: ExtractEntry[] = [];
  let entriesDegraded = false;

  if (options.extractEntries) {
    try {
      const result = await llm.runStructured('extract-settings', {
        schema: ExtractResultSchema,
        schemaName: 'ChapterArchive',
        system: buildExtractSystemPrompt(novel, categories, writingNorms),
        user: withArchiveEntryGuidance(
          buildExtractUserPrompt({
            chapter,
            mentionedEntries: mentioned,
            categories,
            otherEntryNames,
            openThreads: previousOpenThreads,
            rollingSummary: currentRollingSummary,
            ...sideStoryBlock,
          }),
        ),
        failOnTruncation: true,
      });
      summaryData = result.data;
      extractedEntries = result.data.entries;
    } catch (cause) {
      // 条目输出被截断时不会重试修复（残缺 JSON 救不回来）。摘要不能跟着丢：
      // 降级成一次更短的摘要专用调用，条目本轮跳过。
      if (!(cause instanceof LlmError) || cause.kind !== 'truncated') throw cause;
      summaryData = await runSummaryOnly();
      entriesDegraded = true;
    }
  } else {
    summaryData = await runSummaryOnly();
  }

  async function runSummaryOnly(): Promise<ArchiveSummaryData> {
    const result = await llm.runStructured('chapter-summary', {
      schema: ChapterSummaryResultSchema,
      schemaName: 'ChapterSummary',
      system: buildSummarySystemPrompt(novel, writingNorms),
      user: buildSummaryUserPrompt({
        chapter,
        entryNames: entries.map((entry) => entry.title),
        previousOpenThreads,
        previousRollingSummary: currentRollingSummary,
        ...sideStoryBlock,
      }),
      failOnTruncation: true,
    });
    return result.data;
  }

  // —— 从这里开始才写库：模型失败时上面的 throw 保证什么都没动 ——

  // 先清本章旧 pending 摘要：重跑/手动摘要与自动归档可能撞在一起
  await supersedePendingChapterSummary(repository, novel.id, chapter.id);

  const batch = getOrCreateArchiveBatch(novel.id, chapter.id);
  const batchId = batch.id;
  const pendingInBatch = await repository.listProposals(novel.id, {
    status: 'pending',
    batchId,
  });
  const pendingEntries = pendingInBatch.filter((proposal) => proposal.target === 'knowledgeEntry');
  let nextOrder = pendingInBatch.reduce((max, proposal) => Math.max(max, proposal.order), -1) + 1;

  const appearingEntryIds = resolveEntryNames(entries, summaryData.appearingEntries);
  const openThreads = mergeOpenThreads(
    previousOpenThreads,
    summaryData.resolvedThreads,
    summaryData.newOpenThreads,
  );
  const sourceRef = sideStory ? chapterLabel(chapter, [sideStory]) : `第 ${chapter.index} 章`;
  const summaryPayload = {
    chapterId: chapter.id,
    summary: summaryData.summary,
    keyEvents: summaryData.keyEvents,
    appearingEntryIds,
    openThreads,
  };

  const existingSummary = summaries.find((summary) => summary.chapterId === chapter.id);
  const summaryProposal = existingSummary
    ? buildReplaceProposal({
        novelId: novel.id,
        batchId,
        order: nextOrder++,
        origin: 'refine',
        target: 'chapterSummary',
        label: `${sourceRef}摘要`,
        specs: fieldSpecsFor('chapterSummary'),
        sourceRef,
        targetId: existingSummary.id,
        current: existingSummary,
        payload: summaryPayload,
      })
    : buildCreateProposal({
        novelId: novel.id,
        batchId,
        order: nextOrder++,
        origin: 'refine',
        target: 'chapterSummary',
        label: `${sourceRef}摘要`,
        specs: fieldSpecsFor('chapterSummary'),
        sourceRef,
        payload: summaryPayload,
      });

  const progressTarget = sideStory
    ? {
        target: 'sideStory' as const,
        label: '外传进展摘要',
        specs: fieldSpecsFor('sideStory'),
        targetId: sideStory.id,
        current: { rollingSummary: sideStory.rollingSummary },
      }
    : {
        target: 'novel' as const,
        label: '全书进展摘要',
        specs: fieldSpecsFor('novel'),
        targetId: novel.id,
        current: { rollingSummary: novel.rollingSummary },
      };
  const progressPayload = { rollingSummary: summaryData.rollingSummary };
  /**
   * 同一批里只保留一条进展提案。
   *
   * 每章都给一条 replace 提案的话，收件箱里会出现几条互相覆盖的滚动摘要，
   * 作者不知道该采用哪条；而滚动摘要本身就是「截至最新一章」的累计值，
   * 后一章的版本已经包含前一章。所以有 pending 就就地更新，没有才新建。
   *
   * 按 targetId 匹配而不是只看 target：同一批里可能归档了多部外传，
   * 不能把 A 的外传进展更新成 B 的。
   */
  const pendingProgress = pendingInBatch.find(
    (proposal) =>
      proposal.target === progressTarget.target && proposal.targetId === progressTarget.targetId,
  );
  let progressProposal: Proposal | null = null;
  if (pendingProgress) {
    const previousProgressPayload = asPayloadRecord(pendingProgress.payload);
    const unchanged =
      previousProgressPayload !== null &&
      samePayload(previousProgressPayload, progressPayload) &&
      pendingProgress.sourceRef === sourceRef;
    // 同章重跑且内容没变时不做无意义写入；有变化才就地更新
    if (!unchanged) {
      await repository.updateProposal(pendingProgress.id, {
        payload: progressPayload,
        // diff 永远相对「已采用值」算；相对旧 pending 值算会让确认界面显示错误的前后对比
        diff: computeDiff(progressTarget.specs, progressPayload, progressTarget.current),
        sourceRef,
        // 挪到本批末尾，让最新的累计进展排在最近一章摘要之后，阅读顺序才是因果顺序
        order: nextOrder++,
      });
    }
  } else {
    progressProposal = buildReplaceProposal({
      novelId: novel.id,
      batchId,
      order: nextOrder++,
      origin: 'refine',
      target: progressTarget.target,
      label: progressTarget.label,
      specs: progressTarget.specs,
      sourceRef,
      targetId: progressTarget.targetId,
      current: progressTarget.current,
      payload: progressPayload,
    });
  }

  // ---- 条目提案 ----
  const createdEntryProposals: Proposal[] = [];
  let mergedEntryCount = 0;
  const drafts = options.extractEntries
    ? accumulateEntryDrafts([], extractedEntries, categories, chapter.id)
    : [];

  if (drafts.length > 0) {
    const existingByName = new Map<string, KnowledgeEntry | undefined>();
    const findExisting = async (name: string): Promise<KnowledgeEntry | undefined> => {
      const key = normalizeEntryName(name);
      if (!existingByName.has(key)) {
        existingByName.set(key, await repository.findEntryByName(novel.id, name));
      }
      return existingByName.get(key);
    };
    const chapterIndexById = new Map(chapters.map((item) => [item.id, item.index] as const));
    const sourcePrefix = sideStory ? `外传·${sideStory.title}` : undefined;

    // 普通条目与「人物新条目」各有一份额度，互不挤占
    let normalBudget = MAX_ENTRY_PROPOSALS_PER_CHAPTER;
    let characterNewBudget = MAX_ENTRY_PROPOSALS_PER_CHAPTER;

    for (const draft of drafts) {
      const draftCategory = categories.find((category) => category.id === draft.categoryId);
      if (!draftCategory) continue;

      const existing = await findExisting(draft.title);
      // 已存条目：字段/摘要/别名都没变就是没新信息，不值得让作者再确认一次
      if (existing && !entryDraftHasChange(existing, draft)) continue;

      // 人物分类的**新**条目不受普通上限限制（新登场要即时提案）；
      // 自定义分类里的角色（kind=custom）按评审结论不豁免
      const exemptCharacter = draftCategory.kind === 'character' && existing === undefined;
      if (exemptCharacter) {
        if (characterNewBudget <= 0) continue;
        characterNewBudget -= 1;
      } else {
        if (normalBudget <= 0) continue;
        normalBudget -= 1;
      }

      // 同一批里已有同名 pending 条目提案：合并进它，不新建（D3 每 3–5 章一组）
      const pendingSame = findPendingEntryProposal(pendingEntries, draft);
      if (pendingSame) {
        const currentPayload = asPayloadRecord(pendingSame.payload);
        if (!currentPayload) continue;
        const mergedPayload = mergeEntryDraftIntoPayload(
          currentPayload,
          draft,
          draftCategory,
          categories,
        );
        if (samePayload(currentPayload, mergedPayload)) continue;
        const mergedCategory =
          categories.find((category) => category.id === mergedPayload.categoryId) ?? draftCategory;
        const mergedSpecs = entryFieldSpecs(mergedCategory);
        const diff =
          pendingSame.action === 'merge'
            ? computeDiff(mergedSpecs, mergedPayload, existing)
            : computeDiff(mergedSpecs, mergedPayload);
        await repository.updateProposal(pendingSame.id, { payload: mergedPayload, diff });
        mergedEntryCount += 1;
        continue;
      }

      const proposal = await buildEntryProposal({
        draft,
        novelId: novel.id,
        batch: batchId,
        order: nextOrder++,
        categories,
        chapterIndexById,
        ...(sourcePrefix ? { sourcePrefix } : {}),
        findExisting,
      });
      if (proposal) createdEntryProposals.push(proposal);
    }
  }

  await repository.createProposals([
    summaryProposal,
    ...(progressProposal ? [progressProposal] : []),
    ...createdEntryProposals,
  ]);

  // 状态行与挂载恢复都要「本批全部待确认」，不能只报条目数 —— 作者会低估确认量。
  // 写完再查一次：pending 集合以仓储为准，不做本地推算（更新/合并后的数量不好手算）
  const pendingAfterCreate = await repository.listProposals(novel.id, {
    status: 'pending',
    batchId,
  });

  const threads: ArchiveChapterThreads = {
    opened: summaryData.newOpenThreads,
    resolved: summaryData.resolvedThreads,
    open: openThreads,
  };
  // 伏笔流水只是展示用：写失败由 saveArchiveAudit 内部吞掉，绝不能影响归档结果
  saveArchiveAudit(batchId, {
    chapterId: chapter.id,
    index: chapter.index,
    title: chapter.title,
    ...threads,
  });

  return {
    batchId,
    summaryCreated: true,
    entryCount: createdEntryProposals.length + mergedEntryCount,
    // 旧口径（仅条目）保留给已有调用方；M2.1 起新 UI 用 pendingTotal
    pendingCount: pendingEntries.length + createdEntryProposals.length,
    pendingTotal: pendingAfterCreate.length,
    threads,
    entriesDegraded,
  };
}

// ---------------------------------------------------------------- 内部工具

function asPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

/** 已存条目与本章提取结果相比是否有实质变化（空值不视为变化：合并语义下不删旧值） */
function entryDraftHasChange(existing: KnowledgeEntry, draft: ImportEntryDraft): boolean {
  if (draft.summary.trim() && draft.summary.trim() !== existing.summary.trim()) return true;
  const existingAliases = new Set(existing.aliases.map(normalizeEntryName));
  if (draft.aliases.some((alias) => !existingAliases.has(normalizeEntryName(alias)))) return true;
  return Object.entries(draft.fields).some(([key, value]) => {
    const next = value.trim();
    return next.length > 0 && next !== (existing.fields[key] ?? '').trim();
  });
}

/**
 * 在本批 pending 里找同名条目提案。
 *
 * 同时看 title 与 aliases 两个方向：同一对象在不同章可能被模型用不同称呼当标题，
 * 只要任一侧能对上就合并，避免收件箱里出现「林越」「阿越」两条。
 */
function findPendingEntryProposal(
  pendingEntries: readonly Proposal[],
  draft: ImportEntryDraft,
): Proposal | undefined {
  const draftName = normalizeEntryName(draft.title);
  const draftAliases = new Set(draft.aliases.map(normalizeEntryName));
  return pendingEntries.find((proposal) => {
    const payload = asPayloadRecord(proposal.payload);
    if (!payload) return false;
    const title = typeof payload.title === 'string' ? normalizeEntryName(payload.title) : '';
    if (title.length > 0 && title === draftName) return true;
    const aliases = Array.isArray(payload.aliases)
      ? payload.aliases
          .filter((alias): alias is string => typeof alias === 'string')
          .map(normalizeEntryName)
      : [];
    if (aliases.includes(draftName)) return true;
    return title.length > 0 && draftAliases.has(title);
  });
}

/**
 * 把本章的条目草稿合并进已有 pending payload。
 *
 * 合并规则与入库时的 `mergeEntities` 完全一致（列表并集、新值非空覆盖、空值保留旧值），
 * 这样「批内累计」的结果与「作者逐条采用」后的结果不会出现两种写法。
 */
function mergeEntryDraftIntoPayload(
  payload: Record<string, unknown>,
  draft: ImportEntryDraft,
  draftCategory: Category,
  categories: Category[],
): Record<string, unknown> {
  const categoryId = typeof payload.categoryId === 'string' ? payload.categoryId : draftCategory.id;
  const category = categories.find((item) => item.id === categoryId) ?? draftCategory;
  const merged = mergeEntities(
    entryFieldSpecs(category),
    payload,
    draftToEntryPayload(draft),
  ) as Record<string, unknown>;
  const previousSources = Array.isArray(payload.sourceChapterIds)
    ? payload.sourceChapterIds.filter((id): id is string => typeof id === 'string')
    : [];
  merged.sourceChapterIds = Array.from(new Set([...previousSources, ...draft.sourceChapterIds]));
  return merged;
}

/** 结构化比较 payload 是否真的变了；没变就不写库、也不计入 entryCount */
function samePayload(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
