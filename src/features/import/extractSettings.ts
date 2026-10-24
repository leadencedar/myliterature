import { z } from 'zod';
import type {
  Category,
  Chapter,
  FieldDef,
  ImportEntryDraft,
  KnowledgeEntry,
  Novel,
  WritingNorm,
} from '@/domain/schema';
import { mentionedEntries, normalizeEntryName } from '@/domain/entrySearch';
import { composeSections, novelMetaSection, writingNormsSection } from '@/prompt/sections';

/**
 * 旧稿反向提取。
 *
 * 用户已经写了几十万字才来用这个工具，知识库却是空的 —— 不解决这件事，
 * 存量作者根本用不上后续的按章续写。这里做的是反方向：读正文，倒推出
 * 世界观条目、人物条目、章节摘要与伏笔，全部作为提案交用户确认。
 *
 * 两个关键设计：
 *
 * 1. **一次调用同时产出设定与摘要**。两者都要求通读整章，拆成两次调用等于
 *    把最贵的那部分（输入 token）付两遍。
 *
 * 2. **要求模型输出「整合后的完整字段」而不是增量补充**。这是 `mergeEntities`
 *    合并契约成立的前提：合并时标量字段直接取新值，只有当新值本身已经是
 *    「旧值 + 本章新信息」时这么做才不会丢数据。所以 prompt 里必须把该条目
 *    现有的完整字段一起给出，并明确要求整合回填。
 */

// ---------------------------------------------------------------- 输出 schema

/**
 * 字段用键值对数组而不是 `z.record`。
 *
 * 提取会同时涉及多个分类，各自的字段模板不同，没法写成固定的对象形状；
 * 而 `z.record` 转出的 JSON Schema 带 `additionalProperties`，
 * 在 OpenAI 的 strict 模式下会被整体拒绝。键值对数组两边都吃得下。
 */
export const ExtractFieldSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const ExtractEntrySchema = z.object({
  /** 必须取自 prompt 中给出的分类名称 */
  categoryName: z.string(),
  title: z.string(),
  aliases: z.array(z.string()),
  summary: z.string(),
  fields: z.array(ExtractFieldSchema),
});
export type ExtractEntry = z.infer<typeof ExtractEntrySchema>;

export const ExtractResultSchema = z.object({
  /** 本章能提炼出的人物与设定；已存在的条目也要给出，用于合并补全 */
  entries: z.array(ExtractEntrySchema),
  summary: z.string().min(1, '章节摘要不能为空'),
  keyEvents: z.array(z.string()),
  /** 本章出场的已有条目名称 */
  appearingEntries: z.array(z.string()),
  newOpenThreads: z.array(z.string()),
  resolvedThreads: z.array(z.string()),
  rollingSummary: z.string().min(1, '全书进展摘要不能为空'),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

// ---------------------------------------------------------------- 本地预筛

/**
 * 名称归一化，与仓储的 findEntryByName 保持同一口径。
 * 实现已下沉到 domain 层，这里转出去是为了不改动既有调用方。
 */
export { normalizeEntryName };

/**
 * 本地预筛出本章可能涉及的已有条目。
 *
 * 不能把整个知识库都塞进 prompt：长篇跑到后期条目数会到几百条，
 * 带完整字段注入既贵又会稀释注意力。这里用 title/aliases 做子串匹配，
 * 只把真正出现过的条目展开成完整字段，其余只给名称用于对齐命名。
 *
 * pinned 条目无条件包含 —— 它们是世界观底层规则，提取时读不到会让模型
 * 自行发明设定。这一条是**提取场景的策略**，所以留在这里而不是下沉到
 * `mentionedEntries`：默认预选就不需要它（核心设定本来就始终注入）。
 */
export function findMentionedEntries(
  chapterContent: string,
  entries: KnowledgeEntry[],
): KnowledgeEntry[] {
  const mentioned = new Set(mentionedEntries(chapterContent, entries).map((entry) => entry.id));
  return entries.filter((entry) => entry.pinned || mentioned.has(entry.id));
}

// ---------------------------------------------------------------- 提示词

function categoryGuide(category: Category): string {
  const lines = [`分类「${category.name}」的 fields 可用键：`];
  if (category.fieldTemplate.length === 0) {
    lines.push('- （该分类没有自定义字段，fields 给空数组）');
  } else {
    for (const field of category.fieldTemplate) {
      lines.push(`- ${field.key}（${field.label}）：${field.hint || field.label}`);
    }
  }
  return lines.join('\n');
}

const EXTRACT_TASK = [
  '【任务】',
  '阅读给定的章节正文，倒推出这一章透露的设定信息，并同时提炼本章摘要。',
  '',
  'entries（人物与设定）要求：',
  '- 只写正文里真有依据的内容。允许归纳，不允许发挥想象补全作者没写的东西。',
  '- categoryName 只能从上文列出的分类名称中选，原样抄写。',
  '- fields 的 key 只能用该分类列出的键，原样抄写；没有依据的字段不要列进来。',
  '- 对于「本章涉及的已有条目」，必须输出**整合后的完整字段**：把它现有的内容与本章新读到的信息合到一起再写出来，而不是只写增量部分。字段里原有的内容若本章没有推翻它，就要原样保留。',
  '- 对于新出现的人物或设定，title 用正文里最常用的称呼；aliases 填其他称呼、绰号、尊称。',
  '- 如果正文是译文、某个专名有对应的外文原名（例如「阿什福德」来自 Ashford），把**外文原名也放进 aliases**。它是溯源，也让后续导入的外文素材能认出这是同一个对象。',
  '- summary 是一句话摘要（30 字内），用于在列表里快速辨认。',
  '- 同一个对象只给一条，不要因为称呼不同拆成多条。',
  '- 本章没有提供任何设定信息时，entries 给空数组。',
  '',
  '摘要部分要求：',
  '- summary：120 字以内，说清本章发生了什么、人物状态有何变化。只写发生过的事。',
  '- keyEvents：3–6 条，每条一句话，按时间顺序。只记会影响后续情节的事。',
  '- appearingEntries：本章出场或被实质提及的**已有条目**名称，只能从「已有条目名称」清单里原样抄选。清单里没有的不要写进来（新提取的条目不必在此重复）。',
  '- newOpenThreads：本章新埋下、尚未解释的悬念或伏笔。没有就给空数组。',
  '- resolvedThreads：本章收束掉的**此前遗留**伏笔，必须从「当前未收束的伏笔」清单里原样抄回。没有就给空数组。',
  '- rollingSummary：更新后的全书进展摘要，300 字以内，覆盖从开篇到本章的主线进展与人物当前处境。它会替换旧版本，所以要写成完整独立的一段。',
].join('\n');

/**
 * 提取任务的系统提示。
 *
 * 刻意不带文风段落：提取是理解任务，不是写作任务，带上文风只会增加
 * token 并诱导模型用作者的腔调改写设定。这段前缀在全书各章之间完全一致，
 * 缓存命中率最高。
 *
 * norms 是可选尾参数：不传或没有作用范围含「提取设定」的规范时，输出与改动前逐字节相同。
 * 规范里的命名、合并与信息限定规则正是提取要守的；它的用法行同时禁止从规范本身提取条目，
 * 防止模型把规范里的分叉事实当成设定。规范整本书稳定，放在任务说明之前不影响逐章缓存
 */
export function buildExtractSystemPrompt(
  novel: Novel,
  categories: Category[],
  norms?: readonly WritingNorm[],
): string {
  return composeSections([
    '你是一位小说资料编辑，擅长从已完成的稿件里整理出创作档案。',
    novelMetaSection(novel),
    writingNormsSection(norms, 'extract'),
    EXTRACT_TASK,
    ...categories.map(categoryGuide),
  ]);
}

function entryDetailBlock(entry: KnowledgeEntry, categories: Category[]): string {
  const category = categories.find((item) => item.id === entry.categoryId);
  const lines = [`- 名称：${entry.title}（分类「${category?.name ?? '未知'}」）`];
  if (entry.aliases.length > 0) lines.push(`  别名：${entry.aliases.join('、')}`);
  if (entry.summary.trim()) lines.push(`  摘要：${entry.summary.trim()}`);
  // 按分类字段模板的顺序输出，保证同一条目在不同章节的请求里字节级一致
  for (const field of category?.fieldTemplate ?? []) {
    const value = entry.fields[field.key]?.trim();
    if (value) lines.push(`  ${field.key}：${value}`);
  }
  return lines.join('\n');
}

export function buildExtractUserPrompt(params: {
  /** 世界观导入传的是仅在内存里的对象，不对应任何已落库章节 */
  chapter: Pick<Chapter, 'index' | 'title' | 'content'>;
  /** 给了就把正文块标成「设定文本」而不是「本章正文」，用于世界观导入 */
  sourceLabel?: string;
  /** 本章涉及的已有条目，带完整字段，供整合回填 */
  mentionedEntries: KnowledgeEntry[];
  categories: Category[];
  /** 其余已有条目，只给名称用于对齐命名与避免重复 */
  otherEntryNames: string[];
  openThreads: string[];
  /** 主线是全书进展；外传导入时是这部外传自己的进展 */
  rollingSummary: string;
  /**
   * 外传导入时传入：进展块改称「外传进展」，正文前加一段说明。
   * 不传时输出与主线逐字节一致（系统提示也不变，保住缓存前缀）。
   */
  sideStory?: { title: string; synopsis: string };
}): string {
  const blocks: string[] = [];
  const sideStory = params.sideStory;

  if (params.mentionedEntries.length > 0) {
    blocks.push(
      [
        '【本章涉及的已有条目（含现有完整内容）】',
        ...params.mentionedEntries.map((entry) => entryDetailBlock(entry, params.categories)),
        '若本章补充了它们的信息，请在 entries 里给出整合后的完整版本（名称沿用上面的名称）；本章没有新信息的条目不必列出。',
      ].join('\n'),
    );
  }

  blocks.push(
    params.otherEntryNames.length > 0
      ? `【已有条目名称】\n${params.otherEntryNames.join('、')}`
      : '【已有条目名称】\n（暂无，appearingEntries 请给空数组）',
  );

  if (params.openThreads.length > 0) {
    blocks.push(
      [
        '【当前未收束的伏笔】',
        ...params.openThreads.map((thread) => `- ${thread}`),
        '若本章收束了其中某条，请在 resolvedThreads 里原样抄回。',
      ].join('\n'),
    );
  }

  if (params.rollingSummary.trim()) {
    blocks.push(
      `${sideStory ? '【此前的外传进展摘要】' : '【此前的全书进展摘要】'}\n${params.rollingSummary.trim()}`,
    );
  }

  if (sideStory) {
    // 后一句让条目合并时不容易记错：前传里的「青冥宗弟子」不该把主线里的「宗主」顶掉
    const synopsis = sideStory.synopsis.trim();
    blocks.push(
      `本批正文是外传《${sideStory.title}》${
        synopsis ? `（简介：${synopsis}）` : ''
      }，独立于主线。rollingSummary 只写这部外传自身的进展；条目字段写长期成立的事实，外传里某一时期特有的状态（如当年的身份）要写明时期，不要当成现状。`,
    );
  }

  blocks.push(
    [
      params.sourceLabel
        ? `【设定文本（${params.sourceLabel}）】`
        : `【本章正文（第 ${params.chapter.index} 章${
            params.chapter.title ? ` ${params.chapter.title}` : ''
          }）】`,
      params.chapter.content.trim(),
    ].join('\n'),
  );

  return composeSections(blocks);
}

// ---------------------------------------------------------------- 草稿累计

/** 把模型给的键值对收敛成条目的 fields：模板里没有的键一律丢弃 */
export function fieldsFromPairs(
  pairs: { key: string; value: string }[],
  template: FieldDef[],
): Record<string, string> {
  const allowed = new Set(template.map((field) => field.key));
  const fields: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    // 模板外的键在条目编辑器里没有对应表单，落库等于数据不可见
    if (!allowed.has(key)) continue;
    const value = pair.value.trim();
    if (!value) continue;
    fields[key] = value;
  }
  return fields;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * 把一章的提取结果累计进任务的条目草稿。
 *
 * 为什么要累计而不是每章直接出提案：同一个主角会在几十章里反复出现，
 * 逐章出提案的话用户要处理上百条内容高度重复的待确认项，实际上没人会看完。
 * 因此提取过程中先按名称合并，全部章节跑完后才一次性 materialize 成提案。
 *
 * 合并规则与 `mergeEntities` 保持一致（列表取并集、新值非空则覆盖、
 * 新值为空则保留原值），这样「章内累计」与「入库合并」的语义是同一套，
 * 不会出现两段代码对同一份数据给出不同结果。
 *
 * `chapterId` 为 null 表示来源不是章节（世界观设定导入）：不记溯源章节，
 * 伪造一个 id 会随提案写进条目，变成悬空引用。
 */
export function accumulateEntryDrafts(
  existing: ImportEntryDraft[],
  incoming: ExtractEntry[],
  categories: Category[],
  chapterId: string | null,
): ImportEntryDraft[] {
  const sourceIds = chapterId ? [chapterId] : [];
  const merged = existing.map((draft) => ({ ...draft }));
  const indexByKey = new Map(merged.map((draft, index) => [draft.key, index] as const));

  for (const entry of incoming) {
    const title = entry.title.trim();
    if (!title) continue;

    const category = categories.find((item) => item.name.trim() === entry.categoryName.trim());
    // 分类对不上就整条丢弃：把人物塞进世界观分类会让字段模板完全错位，
    // 比少一条更难收拾
    if (!category) continue;

    const fields = fieldsFromPairs(entry.fields, category.fieldTemplate);
    const key = normalizeEntryName(title);
    const at = indexByKey.get(key);

    if (at === undefined) {
      indexByKey.set(key, merged.length);
      merged.push({
        key,
        categoryId: category.id,
        title,
        aliases: dedupe(entry.aliases),
        summary: entry.summary.trim(),
        fields,
        sourceChapterIds: sourceIds,
      });
      continue;
    }

    const previous = merged[at]!;
    merged[at] = {
      ...previous,
      aliases: dedupe([...previous.aliases, ...entry.aliases]),
      summary: entry.summary.trim() || previous.summary,
      fields: { ...previous.fields, ...fields },
      sourceChapterIds: dedupe([...previous.sourceChapterIds, ...sourceIds]),
    };
  }

  return merged;
}

/** 草稿转成知识条目的提案 payload */
export function draftToEntryPayload(draft: ImportEntryDraft): {
  categoryId: string;
  title: string;
  aliases: string[];
  summary: string;
  fields: Record<string, string>;
  sourceChapterIds: string[];
} {
  return {
    categoryId: draft.categoryId,
    title: draft.title,
    aliases: draft.aliases,
    summary: draft.summary,
    fields: draft.fields,
    sourceChapterIds: draft.sourceChapterIds,
  };
}
