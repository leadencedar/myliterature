import { dedupeGlossary, type GlossaryEntry } from '@/domain/glossary';
import type { Chapter, Novel, StyleProfile } from '@/domain/schema';
import { composeSections, composeStylePrefix } from '@/prompt/sections';

export type { GlossaryEntry };

/**
 * 章节翻译。
 *
 * 面向「手里有几章外文稿，想译成中文后接着用中文写」这个场景。
 * 因此目标语言固定是中文 —— 这不是一个通用翻译器，而是把外文来稿
 * 并入一部中文作品的入口。
 *
 * **译文走流式纯文本，不走 Proposal 管道、也不包在 JSON 里。**
 * 一章译文动辄三千字，包进 JSON 字符串有两个坏处：转义出错会让整章白译
 * （输出 token 是最贵的部分，重试一次就是再付一遍钱），而且没法边译边看。
 * 译名表则附在译文之后，用分隔行隔开，在本地解析 ——
 * 关键是**译名表解析失败不影响译文**：拿不到译名表只是下一章少一点约束，
 * 拿不到译文才是真的损失。
 */

/**
 * 单次翻译的保守篇幅上限（字符数），超过时提示「可能被截断」，不拦截。
 *
 * 与 WORLDVIEW_CHUNK_SIZE 同量级。模型的输出上限因服务商而异，这只是保守估计；
 * 供导入分章页提示用户把超长章切小，编辑器那边以后要提示也能复用。
 */
export const TRANSLATE_SOFT_LIMIT = 6000;

/** 译文与译名表的分隔行。要求模型原样输出 */
export const GLOSSARY_DELIMITER = '---译名表---';

/** 容忍破折号数量、全角字符与前后空白的变体 */
const DELIMITER_PATTERN = /^[ \t]*[-—–]{2,}[ \t]*译名表[ \t]*[-—–]{2,}[ \t]*$/mu;

/** `Ashford => 阿什福德`，也认 ->、→，以及行首的列表符号 */
const GLOSSARY_LINE = /^[\s>*-]*(.+?)\s*(?:=>|->|→)\s*(.+?)\s*$/u;

export interface ParsedTranslation {
  text: string;
  glossary: GlossaryEntry[];
}

/**
 * 从模型输出里切出译文与译名表。
 *
 * 没有分隔行时整段都算译文 —— 模型忘了附译名表是小事，
 * 把整章译文当成解析失败丢掉才是大事。
 */
export function parseTranslation(raw: string): ParsedTranslation {
  const match = DELIMITER_PATTERN.exec(raw);
  if (!match) return { text: stripFences(raw).trim(), glossary: [] };

  const text = stripFences(raw.slice(0, match.index)).trim();
  const tail = raw.slice(match.index + match[0].length);

  const glossary: GlossaryEntry[] = [];
  for (const line of tail.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = GLOSSARY_LINE.exec(trimmed);
    if (!parts) continue;
    const source = parts[1]!.trim();
    const target = parts[2]!.trim();
    // 缺一边的行直接跳过，不往表里塞半条
    if (!source || !target) continue;
    glossary.push({ source, target });
  }

  return { text, glossary: dedupeGlossary(glossary) };
}

/** 模型偶尔会把译文包进代码块，去掉围栏但不动正文内部的内容 */
function stripFences(value: string): string {
  const fenced = /^\s*```(?:\w+)?\s*\n([\s\S]*?)\n?```\s*$/u.exec(value);
  return fenced?.[1] ?? value;
}

// ---------------------------------------------------------------- 提示词

const TRANSLATE_TASK = [
  '【任务】',
  '把用户给出的外文章节译成简体中文，供作者接着用中文续写这部作品。',
  '',
  '这是文学翻译，不是逐词对译。要求：',
  '- **忠实优先**。不增删情节、不合并段落、不替作者补写没写的东西；原文含糊的地方保持含糊。',
  '- 保留原文的分段与空行结构。原文一段就是一段，不要为了通顺而合并或拆分。',
  '- 对话用中文引号「」，保留每句话各自成段的排版习惯。',
  '- 人名、地名、组织名、专有物品名按中文出版惯例音译或意译，同一个名字**全书只能有一个译法**。',
  '- 计量单位、货币、俗语按中文读者能直接理解的方式处理，但不要改成中国特有的事物。',
  '- 原文里的英文缩写、拉丁学名、代号如果中文没有通行译法，保留原文。',
  '',
  '【输出格式】',
  '先输出译文正文，不要加标题、不要加任何说明文字、不要用代码块包裹。',
  '译文之后另起一行，原样输出这一行分隔符：',
  GLOSSARY_DELIMITER,
  '再逐行列出本章用到的专名对照，每行一条，格式为：',
  '原文名 => 中文译名',
  '只列专有名词（人名 / 地名 / 组织 / 特有物品），不要列普通词汇。本章没有专名就留空。',
].join('\n');

/**
 * 翻译任务的系统提示。
 *
 * 带上文体与文风：译文要和后续的中文续写读起来像同一本书，
 * 否则读者会在第四章的位置感到换了个作者。但**风格只影响措辞与语感，
 * 不得改动内容** —— 这一条写在任务里，优先级高于风格。
 */
export function buildTranslateSystemPrompt(novel: Novel, style: StyleProfile): string {
  return composeSections([
    '你是一位文学译者，正在把一部作品的外文稿译成简体中文。',
    composeStylePrefix(novel, style),
    TRANSLATE_TASK,
    '【风格与忠实的优先级】\n上面的文风要求只用来决定措辞与语感，不得据此增删或改写情节。两者冲突时一律以忠实于原文为准。',
  ]);
}

export function buildTranslateUserPrompt(params: {
  /** 章节序号与标题，仅用于让模型知道上下文位置 */
  index: number;
  title: string;
  sourceText: string;
  /** 已定下的译名，必须沿用 */
  glossary: GlossaryEntry[];
  /** 上一章译文的结尾，用来接住语感 */
  previousTranslatedTail?: string;
}): string {
  const blocks: string[] = [];

  if (params.glossary.length > 0) {
    blocks.push(
      [
        '【已定译名（必须沿用，不得另起译法）】',
        ...params.glossary.map((entry) => `${entry.source} => ${entry.target}`),
      ].join('\n'),
    );
  }

  if (params.previousTranslatedTail?.trim()) {
    blocks.push(
      [
        '【上一章译文的结尾（仅供接住语感，不要续写它）】',
        params.previousTranslatedTail.trim(),
      ].join('\n'),
    );
  }

  blocks.push(
    [
      `【待翻译的原文（第 ${params.index} 章${params.title ? ` ${params.title}` : ''}）】`,
      params.sourceText.trim(),
    ].join('\n'),
  );

  return composeSections(blocks);
}

/** 取一章译文的结尾若干字，供下一章接住语感 */
export function translatedTail(text: string, limit = 300): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(-limit);
}

/**
 * 章节是否已经翻译过。
 * 有原文备份就说明译过 —— 重复翻译一章是纯粹的浪费。
 */
export function isTranslated(chapter: Pick<Chapter, 'sourceContent'>): boolean {
  return chapter.sourceContent.trim().length > 0;
}
