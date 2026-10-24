/**
 * 正文语种判定。
 *
 * 用途是「这一章需不需要翻译」。判定必须**按章独立**做 —— 导入进来的稿子
 * 常常是部分章节英文、部分中文，整本书取一个语种会让该翻的漏掉、
 * 不该翻的被重译。
 */

export type TextLanguage = 'zh' | 'en' | 'mixed' | 'unknown';

/**
 * 只认「字母」，不认标点。
 *
 * 与 `isCjkCodePoint`（字数统计用）刻意不同：那个把全角标点也算作一个字，
 * 因为国内平台的字数是这么数的；而判定语种时把「。，！」算进中文占比，
 * 会让一段中文标点夹着的英文被误判成中文。
 */
const CJK_LETTER =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]|[\u{20000}-\u{2fa1f}]/u;

const LATIN_LETTER = /\p{Script=Latin}/u;

/** CJK 占比高于此值就算中文作品，容得下夹杂的外文人名与术语 */
export const ZH_THRESHOLD = 0.5;

/** CJK 占比低于此值才算纯外文，容得下译名对照、注释里的个别汉字 */
export const EN_THRESHOLD = 0.05;

/** 字母太少不足以判断，避免把「Chapter 1」这种标题行判成英文 */
const MIN_LETTERS = 12;

export interface LanguageProfile {
  language: TextLanguage;
  /** CJK 字母占全部字母的比例，0–1 */
  cjkRatio: number;
  cjkLetters: number;
  latinLetters: number;
}

export function profileLanguage(text: string): LanguageProfile {
  let cjkLetters = 0;
  let latinLetters = 0;

  for (const char of text) {
    if (CJK_LETTER.test(char)) cjkLetters += 1;
    else if (LATIN_LETTER.test(char)) latinLetters += 1;
  }

  const total = cjkLetters + latinLetters;
  const cjkRatio = total === 0 ? 0 : cjkLetters / total;

  let language: TextLanguage;
  if (total < MIN_LETTERS) language = 'unknown';
  else if (cjkRatio >= ZH_THRESHOLD) language = 'zh';
  else if (cjkRatio <= EN_THRESHOLD) language = 'en';
  else language = 'mixed';

  return { language, cjkRatio, cjkLetters, latinLetters };
}

export function detectLanguage(text: string): TextLanguage {
  return profileLanguage(text).language;
}

/**
 * 这段正文是否该译成中文。
 *
 * `unknown` 一律返回 false：字母太少的内容（只有标题、只有符号）
 * 翻译不出东西，默认勾上只会让用户为空转付钱。
 */
export function needsTranslationToChinese(text: string): boolean {
  const language = detectLanguage(text);
  return language === 'en' || language === 'mixed';
}

const LANGUAGE_LABELS: Record<TextLanguage, string> = {
  zh: '中文',
  en: '外文',
  mixed: '中外混排',
  unknown: '无法判断',
};

export function languageLabel(language: TextLanguage): string {
  return LANGUAGE_LABELS[language];
}
