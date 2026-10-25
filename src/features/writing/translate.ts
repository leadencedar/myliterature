import { dedupeGlossary, mergeGlossary, type GlossaryEntry } from '@/domain/glossary';
import type { Chapter, Novel, StyleProfile, TranslationSegment } from '@/domain/schema';
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

/**
 * 自动分段翻译的单段预算（原文字符数）。
 *
 * 3000 字符的英文原文译成中文大约 2000 字出头、2500 token 左右，落在多数服务商
 * 默认输出上限（约 4k token）之内，还留了译名表尾巴的余量。分段之后，
 * `TRANSLATE_SOFT_LIMIT` 只是分章页「建议切小」的提示线，不再是截断风险线。
 */
export const SEGMENT_BUDGET = 3000;

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
  /** 章内分段翻译时的段位置；不传就是整章一次译 */
  segment?: { index: number; total: number };
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
    // 分段路径用「上一段」，整章路径保持「上一章」—— 后者是既有 prompt 的字节级基线，
    // 没有分段的任务输出必须与改动前逐字节相同（noScenarioBaseline 守着这条线）
    const tailHeader = params.segment
      ? '【上一段译文的结尾（仅供接住语感，不要复述或续写它）】'
      : '【上一章译文的结尾（仅供接住语感，不要续写它）】';
    blocks.push([tailHeader, params.previousTranslatedTail.trim()].join('\n'));
  }

  const segmentLabel = params.segment
    ? ` · 第 ${params.segment.index}/${params.segment.total} 段`
    : '';
  blocks.push(
    [
      `【待翻译的原文（第 ${params.index} 章${params.title ? ` ${params.title}` : ''}${segmentLabel}）】`,
      params.sourceText.trim(),
    ].join('\n'),
  );

  if (params.segment) {
    blocks.push(
      [
        '【分段说明】',
        `本章共 ${params.segment.total} 段，现在只翻译上面这一段的**全部**内容，`,
        '从第一句译到最后一句：不要提前结束，也不要译到这一段之外的内容。',
      ].join('\n'),
    );
  }

  return composeSections(blocks);
}

/**
 * 章内分段翻译的累计译名：作品级译名表 + 各已完成段定下的译名，先到先得。
 *
 * 这是「分段之后译名表一致」的机制核心：第 k 段的提示词只从这里取译名，
 * 同一专名在段与段之间永远沿用第一个出现的译法；后段想改译法也改不动。
 * 重试某一段前，先把它在 plan 里的 glossary 清掉（回滚贡献），
 * 否则被放弃的那次尝试的译名会占住先到先得的位置。
 */
export function accumulatedGlossary(
  segments: Pick<TranslationSegment, 'status' | 'glossary'>[],
  base: GlossaryEntry[],
): GlossaryEntry[] {
  let merged = mergeGlossary(base, []);
  for (const segment of segments) {
    if (segment.status !== 'done') continue;
    merged = mergeGlossary(merged, segment.glossary);
  }
  return merged;
}

/** 取一章译文的结尾若干字，供下一章接住语感 */
export function translatedTail(text: string, limit = 300): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(-limit);
}

// ---------------------------------------------------------------- 章内自动分段

export interface TranslationSegmentSpec {
  /** 这一段要译的原文（含段内原有的换行结构） */
  text: string;
  /** 拼回整章时，这一段之前要放的分隔（原文里的空行等）；首段为 '' */
  separatorBefore: string;
}

/** 围栏代码块开头：``` 或 ~~~（允许缩进） */
const FENCE_OPEN = /^ {0,3}(```+|~~~+)/u;

/** 表格行：以竖线开头。表格是原子结构，拆开会变成一滩竖线 */
const TABLE_LINE = /^\s*\|/u;

/**
 * 把一章原文切成适合单次翻译的段。
 *
 * 三条安全边界，按此顺序处理：
 * 1. **围栏代码块与表格是原子**：整块一段，超预算也不拆（拆了模型必然翻坏）；
 * 2. 段落（空行分隔）之间不拆：段落边界是语义边界，段内换行结构原样保留；
 * 3. 超预算的段落按**句末标点**切，仍超的才做 grapheme 安全的硬切。
 *
 * 拼接时靠 `separatorBefore` 还原原文的空行结构：译文按顺序拼回，
 * 每段前面放上它自己的分隔，逐字可还原原文布局。
 */
export function splitForTranslation(
  source: string,
  max = SEGMENT_BUDGET,
): TranslationSegmentSpec[] {
  const normalized = source.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');

  const units: { text: string; sepBefore: string }[] = [];
  let pendingSep = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 空行属于「分隔」，攒着留给下一个单元
    if (line.trim() === '') {
      pendingSep += `${line}\n`;
      i += 1;
      continue;
    }

    // 围栏代码块：原子单元
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1]!;
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trimStart().startsWith(marker)) j += 1;
      const end = Math.min(j + 1, lines.length);
      units.push({ text: lines.slice(i, end).join('\n'), sepBefore: pendingSep });
      pendingSep = '\n'; // 块结束行自带一个换行，是它与下一块之间的分隔
      i = end;
      continue;
    }

    // 表格：连续竖线行整块拿走
    if (TABLE_LINE.test(line)) {
      let j = i;
      while (j < lines.length && TABLE_LINE.test(lines[j]!)) j += 1;
      units.push({ text: lines.slice(i, j).join('\n'), sepBefore: pendingSep });
      pendingSep = '\n';
      i = j;
      continue;
    }

    // 普通段落：到空行或下一个特殊块为止
    let j = i;
    while (
      j < lines.length &&
      lines[j]!.trim() !== '' &&
      !FENCE_OPEN.test(lines[j]!) &&
      !TABLE_LINE.test(lines[j]!)
    ) {
      j += 1;
    }
    for (const piece of splitLongText(lines.slice(i, j).join('\n'), max)) {
      units.push({ text: piece, sepBefore: pendingSep });
      pendingSep = '';
    }
    pendingSep = '\n';
    i = j;
  }

  // 贪心装箱：尽量把单元塞满一段，塞不下就开新段
  const segments: TranslationSegmentSpec[] = [];
  let current = '';
  let separatorBefore = '';
  for (const unit of units) {
    const joined = current === '' ? unit.text : current + unit.sepBefore + unit.text;
    if (current !== '' && joined.length > max) {
      segments.push({ text: current, separatorBefore });
      current = unit.text;
      separatorBefore = unit.sepBefore;
    } else {
      current = joined;
    }
  }
  if (current !== '') segments.push({ text: current, separatorBefore });
  return segments;
}

/** 句末标点（中英）之后的切点 */
const SENTENCE_BOUNDARY = /[。！？!?；;…]/gu;

/** 把一段超长文字按句子边界切成 ≤ max 的片，句界不够再硬切 */
function splitLongText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const windowText = remaining.slice(0, max);
    let cut = -1;
    let match: RegExpExecArray | null;
    SENTENCE_BOUNDARY.lastIndex = 0;
    while ((match = SENTENCE_BOUNDARY.exec(windowText)) !== null) {
      cut = match.index + match[0].length;
    }
    if (cut <= 0) cut = graphemeBoundary(remaining, max);
    // 防死循环：任何情况下都至少切走 1 个字符
    pieces.push(remaining.slice(0, Math.max(1, cut)));
    remaining = remaining.slice(Math.max(1, cut));
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

/**
 * 找 ≤ max 的 grapheme 边界。
 *
 * 硬切必须落在字素边界 —— 组合字符（e + 变音符）与 emoji 序列被拦腰切开会
 * 变成乱码。优先 Intl.Segmenter，退化到码点级（至少不切散代理对）。
 */
function graphemeBoundary(text: string, max: number): number {
  const Segmenter = (Intl as unknown as { Segmenter?: new () => Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    let pos = 0;
    for (const { segment, index } of new Segmenter().segment(text)) {
      if (index + segment.length > max) return pos;
      pos = index + segment.length;
    }
    return pos;
  }
  let end = 0;
  for (const char of text) {
    if (end + char.length > max) break;
    end += char.length;
  }
  return end;
}

/** 把各段译文按 `separatorBefore` 拼回整章，还原原文的空行结构 */
export function stitchSegments(
  segments: { translation: string; separatorBefore: string }[],
): string {
  return segments
    .reduce((out, segment) => out + segment.separatorBefore + segment.translation, '')
    .trim();
}

/**
 * 一段译文的长度是否可信。
 *
 * 这是**落地前的完整性校验**，不是质量判断：删减了半段、只译了一小部分、
 * 或者模型复述了指令（超长）都会掉出这个区间，宁可标失败重试也不把
 * 残缺译文当成功 —— 半截译文过了 parseTranslation 就是「看起来成功了」。
 */
export function translationLengthSane(translation: string, source: string): boolean {
  if (!source.trim() || !translation.trim()) return false;
  const ratio = translation.trim().length / source.trim().length;
  return ratio >= 0.2 && ratio <= 3;
}

/** 轻量指纹：只用于判断「切段后正文有没有变过」，不追求密码学强度 */
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * 章节是否已经翻译过。
 * 有原文备份就说明译过 —— 重复翻译一章是纯粹的浪费。
 */
export function isTranslated(chapter: Pick<Chapter, 'sourceContent'>): boolean {
  return chapter.sourceContent.trim().length > 0;
}
