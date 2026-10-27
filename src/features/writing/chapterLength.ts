/**
 * 章节字数结构件（M1 T1，D4）。
 *
 * 目标字数有两个来源：大纲节点的 `targetWords`，为空时回退默认 3000。
 * 「解析目标 → 场景数参考 → 输出 token 上限」三件纯计算收在一处，
 * 让 prompt、生成面板与请求参数共用同一套口径，不出现三处各算各的。
 */

export const DEFAULT_CHAPTER_TARGET_WORDS = 3000;

/**
 * D4：有值取整，为空/非法回退 3000。
 *
 * 大纲节点的 schema 保证 targetWords 是正整数或 null，但这里仍按不可信输入处理：
 * 面板、提案 payload、备份导入都可能给到 0 / NaN / Infinity。
 */
export function resolveChapterTargetWords(targetWords: number | null | undefined): number {
  if (typeof targetWords !== 'number' || !Number.isFinite(targetWords) || targetWords <= 0) {
    return DEFAULT_CHAPTER_TARGET_WORDS;
  }
  return Math.round(targetWords);
}

/**
 * 场景数参考文案（只作参考，不按字数硬切）。
 *
 * 3000 字一章硬写 5 场会每场不足 600 字，读者只看到赶场；6000 字写 1 场又容易
 * 用心理复述和景物堆砌撑长度。区间给一个「合理量级」，节拍怎么分仍由梗概决定。
 */
export function sceneRangeHint(words: number): string {
  if (words <= 3500) return '1–2 场';
  if (words <= 7000) return '3–5 场';
  return '3–6 场';
}

/** 下夹 4096：太小的上限会让正常篇幅被误截断，且该值多数端点都接受 */
const MIN_CHAPTER_MAX_OUTPUT_TOKENS = 4096;
/**
 * 上夹 8192：DeepSeek 与多数自定义端点的默认输出上限在 4k–8k 量级，
 * 16k 可能被整请求拒绝 —— 「请求直接失败」比「截断后提示」更糟。
 */
const MAX_CHAPTER_MAX_OUTPUT_TOKENS = 8192;
/**
 * 中文输出 token 与字数按 1.8 token/字保守估计。
 * 不能用 1.2×：只留 17% 余量，正常偏长的章节就会被误判成截断。
 */
const TOKENS_PER_WORD = 1.8;
/** 再留 800 缓冲。max_tokens 只防失控，不作为字数控制器 */
const MAX_OUTPUT_TOKEN_BUFFER = 800;

/** 按目标字数推导输出 token 上限：ceil(words × 1.8) + 800，再夹到 [4096, 8192] */
export function chapterMaxOutputTokens(targetWords: number | null | undefined): number {
  const words = resolveChapterTargetWords(targetWords);
  const estimate = Math.ceil(words * TOKENS_PER_WORD) + MAX_OUTPUT_TOKEN_BUFFER;
  return Math.min(Math.max(estimate, MIN_CHAPTER_MAX_OUTPUT_TOKENS), MAX_CHAPTER_MAX_OUTPUT_TOKENS);
}
