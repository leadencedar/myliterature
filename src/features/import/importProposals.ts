import type { Category, ImportEntryDraft, KnowledgeEntry, Proposal } from '@/domain/schema';
import { buildCreateProposal, buildMergeProposal } from '@/proposal/build';
import { entryFieldSpecs } from '@/proposal/fields';
import { draftToEntryPayload } from './extractSettings';

/**
 * 一条累计草稿转成提案：库里已有同名条目就做合并，否则新建。
 *
 * 合并时刻意用**已有条目所属分类**的字段规格，而不是草稿里的分类 ——
 * 条目最终仍住在原分类下，按草稿分类的模板算 diff 会得出一堆界面上不存在的字段。
 */
export async function buildEntryProposal(params: {
  draft: ImportEntryDraft;
  novelId: string;
  batch: string;
  order: number;
  categories: Category[];
  chapterIndexById: Map<string, number>;
  /** 溯源章节的前缀，外传导入时为「外传·X」 */
  sourcePrefix?: string;
  /** 溯源章节为空时用的来源说明，例如世界观设定导入 */
  fallbackSourceRef?: string;
  findExisting: (name: string) => Promise<KnowledgeEntry | undefined>;
}): Promise<Proposal | null> {
  const { draft, categories, chapterIndexById } = params;
  const draftCategory = categories.find((item) => item.id === draft.categoryId);
  if (!draftCategory) return null;

  const sourceRef =
    formatSourceRef(draft.sourceChapterIds, chapterIndexById, params.sourcePrefix) ||
    params.fallbackSourceRef ||
    '';
  const existing = await params.findExisting(draft.title);

  const common = {
    novelId: params.novelId,
    batchId: params.batch,
    order: params.order,
    origin: 'extract' as const,
    target: 'knowledgeEntry' as const,
    sourceRef,
  };

  if (!existing) {
    return buildCreateProposal({
      ...common,
      label: `${draftCategory.name} · ${draft.title}`,
      specs: entryFieldSpecs(draftCategory),
      payload: draftToEntryPayload(draft),
    });
  }

  const targetCategory =
    categories.find((item) => item.id === existing.categoryId) ?? draftCategory;
  const proposal = buildMergeProposal({
    ...common,
    label: `${targetCategory.name} · ${existing.title}`,
    specs: entryFieldSpecs(targetCategory),
    targetId: existing.id,
    current: existing,
    incoming: draftToEntryPayload(draft),
  });

  /**
   * 溯源章节不在字段规格里（它不该出现在确认界面上），所以合并结果不会带上
   * 本次的章节；这里显式补成并集，否则「这条设定是从哪几章读出来的」会丢。
   */
  const payload = proposal.payload as Record<string, unknown>;
  return {
    ...proposal,
    payload: {
      ...payload,
      sourceChapterIds: Array.from(
        new Set([...existing.sourceChapterIds, ...draft.sourceChapterIds]),
      ),
    },
  };
}

/**
 * 把溯源章节 id 折成「第 1、3、7 章」。
 * 给了前缀（外传导入）时输出「外传·X 第 1、3 章」。
 */
export function formatSourceRef(
  chapterIds: string[],
  chapterIndexById: Map<string, number>,
  prefix?: string,
): string {
  const indices = chapterIds
    .map((id) => chapterIndexById.get(id))
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b);
  if (indices.length === 0) return '';
  const body =
    indices.length <= 4
      ? `第 ${indices.join('、')} 章`
      : // 出场十几章的主角列全了反而看不清，只给首尾与总数
        `第 ${indices[0]} 章起共 ${indices.length} 章`;
  return prefix ? `${prefix} ${body}` : body;
}
