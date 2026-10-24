import type { GlossaryEntryData } from './schema';

/**
 * 译名表的领域规则。
 *
 * 放在 domain 而不是 features/writing：仓储层要用到合并规则（译名表是作品级的
 * 持久数据，合并的不变量必须在唯一入口处执行），而数据层依赖 feature 是反向依赖。
 * 至于「怎么从模型输出里切出译名表」「提示词怎么写」，那是 LLM 协议细节，
 * 留在 features/writing/translate.ts。
 */

export type GlossaryEntry = GlossaryEntryData;

/** 原文名的归一化：忽略大小写与首尾空白。英文专名的大小写写法常常不统一 */
export function normalizeGlossarySource(source: string): string {
  return source.trim().toLowerCase();
}

/** 同一个原文名只留第一条 */
export function dedupeGlossary(entries: GlossaryEntry[]): GlossaryEntry[] {
  const seen = new Set<string>();
  const out: GlossaryEntry[] = [];
  for (const entry of entries) {
    const key = normalizeGlossarySource(entry.source);
    if (!key || !entry.target.trim()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: entry.source.trim(), target: entry.target.trim() });
  }
  return out;
}

/**
 * 合并模型新产出的译名，**先到先得**。
 *
 * 人名跑风是文学翻译最刺眼的毛病：Ashford 在第一章是「阿什福德」，
 * 到第五章变成「艾许佛」，读者会以为是两个人。所以已经定下的译名不允许
 * 被后来的输出推翻 —— 一致比「这次译得更好」重要。
 *
 * 用户显式改译名走 `setGlossaryEntry`，那是另一回事：他的决定当然可以覆盖。
 */
export function mergeGlossary(
  previous: GlossaryEntry[],
  incoming: GlossaryEntry[],
): GlossaryEntry[] {
  const merged = dedupeGlossary(previous);
  const seen = new Set(merged.map((entry) => normalizeGlossarySource(entry.source)));
  for (const entry of dedupeGlossary(incoming)) {
    const key = normalizeGlossarySource(entry.source);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/**
 * 用户显式设定某个原文名的译法，**覆盖已有的**。
 *
 * 与 `mergeGlossary` 的先到先得刻意相反：作者说这个名字该怎么译，就该怎么译。
 * 不存在就追加在末尾。
 */
export function setGlossaryEntry(
  entries: GlossaryEntry[],
  source: string,
  target: string,
): GlossaryEntry[] {
  const key = normalizeGlossarySource(source);
  const trimmedTarget = target.trim();
  if (!key || !trimmedTarget) return dedupeGlossary(entries);

  const next = dedupeGlossary(entries);
  const at = next.findIndex((entry) => normalizeGlossarySource(entry.source) === key);
  if (at === -1) {
    next.push({ source: source.trim(), target: trimmedTarget });
    return next;
  }
  // 保留原来的原文写法，只换译名 —— 原文名是从稿件里来的，不该被输入框里的写法改掉
  next[at] = { source: next[at]!.source, target: trimmedTarget };
  return next;
}

export function removeGlossaryEntry(entries: GlossaryEntry[], source: string): GlossaryEntry[] {
  const key = normalizeGlossarySource(source);
  return dedupeGlossary(entries).filter((entry) => normalizeGlossarySource(entry.source) !== key);
}

/**
 * 只挑出这段原文里真的出现过的译名。
 *
 * 跑到后期译名表会有几百条，全量注入既贵又会稀释模型的注意力。
 */
export function relevantGlossary(entries: GlossaryEntry[], sourceText: string): GlossaryEntry[] {
  const haystack = sourceText.toLowerCase();
  return entries.filter((entry) => haystack.includes(normalizeGlossarySource(entry.source)));
}

/** 做一致性检查需要的章节字段 —— 刻意不收 Chapter 整体，domain 层不该依赖存储形状 */
export interface GlossaryCheckChapter {
  id: string;
  index: number;
  title: string;
  /** 译文（当前正文） */
  content: string;
  /** 翻译前的原文，空串表示这一章没被翻译过 */
  sourceContent: string;
}

export interface GlossaryDriftChapter {
  id: string;
  index: number;
  title: string;
}

/** 某条译名与已有译文不一致的情况 */
export interface GlossaryDrift {
  source: string;
  /** 当前登记的译名 */
  target: string;
  /** 原文出现过这个专名、但译文里找不到当前译名的章节 */
  chapters: GlossaryDriftChapter[];
}

/**
 * 找出「已经译好的正文没有跟上译名表」的章节。
 *
 * 判据是**原文与译文对齐**：某一章的原文里出现过 `Ashford`，而它的译文里
 * 找不到「艾许福」，那这一章用的就不是当前登记的译法。之所以能这么判，
 * 是因为翻译时原文整份留在了 `sourceContent` 里。
 *
 * 这样就不必额外记录「旧译名的历史」—— 用户把 Ashford 从「阿什福德」改成
 * 「艾许福」之后，凡是原文含 Ashford 的已译章节都会自然被标出来，
 * 顺带还能抓到模型当初压根没照译名表译的情况。
 *
 * 三条刻意的边界：
 * - 只看被翻译过的章节。中文原创章节没有原文可对齐，即便里面写着旧译名也无从判定。
 * - 只提示，不改字。正文里同一个词可能出现在对话、称谓、复合地名里，机械替换会出事。
 * - 命中即算通过：译文里出现过一次当前译名就不再追究其余位置，
 *   否则长章节里的代词、简称会让几乎每一章都变成「不一致」。
 */
export function findGlossaryDrift(
  entries: GlossaryEntry[],
  chapters: readonly GlossaryCheckChapter[],
): GlossaryDrift[] {
  const translated = chapters.filter((chapter) => chapter.sourceContent.trim() !== '');
  if (translated.length === 0) return [];

  // 原文只小写化一遍。跑到后期是几百条译名 × 几十万字，逐条重算会明显卡手
  const prepared = translated.map((chapter) => ({
    chapter,
    haystack: chapter.sourceContent.toLowerCase(),
  }));

  const drifts: GlossaryDrift[] = [];
  for (const entry of dedupeGlossary(entries)) {
    const needle = normalizeGlossarySource(entry.source);
    const hits = prepared
      .filter(
        ({ chapter, haystack }) =>
          haystack.includes(needle) && !chapter.content.includes(entry.target),
      )
      .map(({ chapter }) => ({ id: chapter.id, index: chapter.index, title: chapter.title }));
    if (hits.length > 0)
      drifts.push({ source: entry.source, target: entry.target, chapters: hits });
  }
  return drifts;
}
