import { z } from 'zod';
import type { Tradition } from '@/domain/schema';
import { RUBRIC_DIMENSIONS } from '@/prompt/voiceLibrary';
import { TRADITIONS, subGenresOf } from '@/prompt/traditions';

/**
 * 从已有稿件反向识别作者自己的文风。
 *
 * 与 `features/style/styleSample.ts`（用户手动粘贴一段喜欢的文字）的区别不只是
 * 取样来源：那边归纳的是「我想写成什么样」，这边归纳的是「我本来就写成什么样」。
 * 对存量作者来说后者才是默认值 —— 他已经写了几十万字，不该再被要求从零挑一遍
 * 名家风格和七个维度的描述。
 *
 * 只认三样东西：rubric 七维、文体取向、子类。**刻意不认**：
 * - **创作方法论**。它是「接下来怎么规划大纲」的选择，不是既有文本的属性。
 *   从正文反推作者当年用的是雪花法还是三幕式是伪精确，而它直接决定后续大纲结构，
 *   猜错的代价不对称。
 * - **名家风格参考**。那是「我想像谁」而不是「我像谁」。让模型判定「接近鲁迅 60%」
 *   既容易错，也不该由机器替作者宣称这种关联。
 */

export const ManuscriptStyleSchema = z.object({
  sentenceRhythm: z.string().min(1, '句式节奏不能为空'),
  imagery: z.string().min(1, '意象偏好不能为空'),
  narrativeDistance: z.string().min(1, '叙述距离不能为空'),
  dialogue: z.string().min(1, '对话风格不能为空'),
  rhetoric: z.string().min(1, '修辞习惯不能为空'),
  lexicon: z.string().min(1, '词汇色彩不能为空'),
  avoid: z.string().min(1, '需要避免的写法不能为空'),
  /** 文体取向。三选一，取值必须是这三个之一 */
  tradition: z.enum(['web', 'literary', 'genre']),
  /**
   * 子类，如「都市」「推理」。模型给的是自由文本，落库前要用
   * `normalizeSubGenre` 收敛到该取向下的合法子类，判断不了就留空。
   */
  subGenre: z.string().default(''),
});

export type ManuscriptStyle = z.infer<typeof ManuscriptStyleSchema>;

/** 系统提示。固定不变，天然是稳定前缀（缓存命中便宜 50 倍） */
export const MANUSCRIPT_STYLE_SYSTEM = [
  '你是一位文学编辑，擅长把一位作者的既有作品归纳成可执行的写作指引。',
  '',
  '任务：阅读同一部作品的若干片段，归纳这位作者**自己的**写作风格，供后续续写时沿用。',
  '',
  '风格描述要求：',
  '- 描述可观察的写作手法（句子长度分布、意象取材、叙述距离、对话密度与语气、修辞倾向、词汇语域），不要评价文学价值高低。',
  '- 每一项用 1–3 句话写清楚，要具体到能指导写作，避免「优美」「生动」这类空话。',
  '- 「需要避免」一项写出与这位作者的习惯相冲突的写法，供后续生成时规避 —— 注意是「不像他」的写法，不是「写得不好」的写法。',
  '- 只归纳风格，不要复述情节、人物或设定。',
  `- 七个维度依次是：${RUBRIC_DIMENSIONS.map((d) => d.label).join('、')}。`,
  '',
  '文体判断要求：',
  ...Object.values(TRADITIONS).map((item) => `- ${item.id}（${item.label}）：${item.tagline}。`),
  '- 按片段呈现的实际写法判断，不要按题材猜。分不清时选 web。',
  '- 子类只在明显可判时给出，给不出就留空字符串。',
].join('\n');

export function buildManuscriptStyleUserPrompt(sample: string): string {
  return ['以下是这部作品的若干片段：', '', '---', sample.trim(), '---'].join('\n');
}

// ---------------------------------------------------------------- 取样

/** 参与取样的章节需要的字段 */
export interface SampleChapter {
  index: number;
  title: string;
  content: string;
}

/** 取样上限。与手动取样共用同一个量级：再多只是烧 token 并稀释注意力 */
export const STYLE_SAMPLE_BUDGET = 4000;
/** 最多取几章。三处足够看出习惯，且能覆盖开头之外的不同场景 */
export const STYLE_SAMPLE_CHAPTERS = 3;
/** 短于此的章不参与取样：多半是目录、卷标题或作者的话 */
export const MIN_SAMPLE_CHAPTER_LENGTH = 400;
/** 取样结果短于此就不值得送去归纳 */
export const MIN_SAMPLE_LENGTH = 200;

/**
 * 从稿件里挑出有代表性的片段，拼成一份送去归纳的取样。
 *
 * 四条规则，都是为了让归纳出的文风真的代表这本书：
 * - **跳过过短的章**。分章结果里常混着目录页、卷标题、作者的话，
 *   拿它们归纳文风只会得到「简洁、多为短句」这种废话。
 * - **有别的选择时跳过第一章**。开篇往往是楔子或设定铺陈，语感与全书正文不同。
 * - **取中段而不是开头**。章首常是场景交代与时间地点，对话与描写都在中段。
 * - **完全确定性，不用随机**。同一份稿件每次取样必须逐字节一致，
 *   否则 prompt 缓存失效，测试也不可重复。
 */
export function sampleManuscript(
  chapters: readonly SampleChapter[],
  budget = STYLE_SAMPLE_BUDGET,
): string {
  const eligible = chapters.filter(
    (chapter) => chapter.content.trim().length >= MIN_SAMPLE_CHAPTER_LENGTH,
  );
  // 一章都不够长时退而用全部章节，总比什么都不取好
  const pool = eligible.length > 0 ? eligible : [...chapters];
  if (pool.length === 0) return '';

  /**
   * 章数**多于所需**时才让出开篇。
   *
   * 让出第一章是个有余量才做的优化，不是硬规则：只剩两章合格时把一半样本扔掉，
   * 比拿楔子去归纳的损失大得多。
   */
  const candidates = pool.length > STYLE_SAMPLE_CHAPTERS ? pool.slice(1) : pool;

  const picked = pickEvenly(candidates, STYLE_SAMPLE_CHAPTERS);
  const perChapter = Math.max(1, Math.floor(budget / picked.length));

  const blocks = picked.map((chapter) => {
    const heading = `【第 ${chapter.index} 章${chapter.title ? ` ${chapter.title}` : ''}】`;
    const excerpt = middleExcerpt(chapter.content.trim(), perChapter - heading.length - 1);
    return `${heading}\n${excerpt}`;
  });

  return blocks.join('\n\n');
}

/** 均匀取 n 个元素，保持原顺序。确定性：下标由等距公式算出 */
function pickEvenly<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(items[Math.floor(i * step)]!);
  }
  return out;
}

/**
 * 从中段截取，并尽量落在句子边界上。
 *
 * 半句开头半句结尾会让模型把截断当成作者的断句习惯 —— 那会污染「句式节奏」这一维。
 */
function middleExcerpt(text: string, length: number): string {
  if (length <= 0) return '';
  if (text.length <= length) return text;

  const start = Math.floor((text.length - length) / 2);
  const slice = text.slice(start, start + length);

  // 前端切到第一个句末标点之后，后端切到最后一个句末标点为止
  const head = slice.search(/[。！？…”』\n]/u);
  const trimmedHead = head >= 0 && head < slice.length - 1 ? slice.slice(head + 1) : slice;
  const tail = trimmedHead.search(/[。！？…”』][^。！？…”』]*$/u);
  const body = tail > 0 ? trimmedHead.slice(0, tail + 1) : trimmedHead;

  return body.trim() || slice.trim();
}

// ---------------------------------------------------------------- 归一化

/**
 * 把模型给的子类收敛到该文体取向下的合法子类。
 *
 * 模型可能回「都市言情」「现代都市」「悬疑推理」这类组合词，也可能回一个
 * 该取向下根本不存在的子类（严肃文学下没有任何子类）。匹配不上就留空 ——
 * 一个不存在的子类进了 prompt 只会让 `findSubGenre` 找不到约定，白占字段。
 */
export function normalizeSubGenre(tradition: Tradition, raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  const options = subGenresOf(tradition);

  const exact = options.find((item) => item.id === value || item.label === value);
  if (exact) return exact.id;

  // 组合词按包含匹配，取最先登记的那个（选项顺序是稳定的）
  const partial = options.find((item) => value.includes(item.id) || value.includes(item.label));
  return partial?.id ?? '';
}

/** 模型输出 → 可直接进提案 payload 的风格字段 */
export function toStylePayload(result: ManuscriptStyle): {
  tradition: Tradition;
  subGenre: string;
  customRubric: {
    sentenceRhythm: string;
    imagery: string;
    narrativeDistance: string;
    dialogue: string;
    rhetoric: string;
    lexicon: string;
    avoid: string;
  };
} {
  const { tradition, subGenre, ...rubric } = result;
  return {
    tradition,
    subGenre: normalizeSubGenre(tradition, subGenre),
    customRubric: rubric,
  };
}
