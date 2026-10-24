import { z } from 'zod';
import { RUBRIC_DIMENSIONS } from '@/prompt/voiceLibrary';

/**
 * 文风取样：从用户提供的示例文本提炼出可复用的风格描述。
 *
 * 输出刻意与内置风格库用同一套 rubric 维度 —— 这样自定义风格和名家风格
 * 在 prompt 里的表达形式完全一致，下游不需要区别处理。
 */
export const StyleSampleSchema = z.object({
  sentenceRhythm: z.string().min(1, '句式节奏不能为空'),
  imagery: z.string().min(1, '意象偏好不能为空'),
  narrativeDistance: z.string().min(1, '叙述距离不能为空'),
  dialogue: z.string().min(1, '对话风格不能为空'),
  rhetoric: z.string().min(1, '修辞习惯不能为空'),
  lexicon: z.string().min(1, '词汇色彩不能为空'),
  avoid: z.string().min(1, '需要避免的写法不能为空'),
});

export type StyleSample = z.infer<typeof StyleSampleSchema>;

/** 取样任务的系统提示。固定不变，天然是稳定前缀 */
export const STYLE_SAMPLE_SYSTEM = [
  '你是一位文学编辑，擅长把文本的风格特征归纳成可执行的写作指引。',
  '',
  '任务：阅读用户提供的示例文本，提炼其风格特征，输出结构化的风格描述。',
  '',
  '要求：',
  '- 描述可观察的写作手法（句子长度分布、意象取材、叙述距离、对话密度与语气、修辞倾向、词汇语域），不要评价文学价值。',
  '- 每一项用 1–3 句话写清楚，要具体到能指导写作，避免「优美」「生动」这类空话。',
  '- 「需要避免」一项写出与该风格相冲突的写法，供后续生成时规避。',
  '- 只归纳风格，不要复述或引用示例文本的内容与情节。',
  `- 七个维度依次是：${RUBRIC_DIMENSIONS.map((d) => d.label).join('、')}。`,
].join('\n');

export function buildStyleSampleUserPrompt(sampleText: string): string {
  return ['示例文本如下：', '', '---', sampleText.trim(), '---'].join('\n');
}

/** 取样文本的长度边界：太短归纳不出东西，太长浪费 token 且注意力分散 */
export const SAMPLE_MIN_LENGTH = 100;
export const SAMPLE_MAX_LENGTH = 4000;

export function validateSample(text: string): string | undefined {
  const length = text.trim().length;
  if (length === 0) return '请先粘贴一段示例文本';
  if (length < SAMPLE_MIN_LENGTH) return `示例太短，至少需要 ${SAMPLE_MIN_LENGTH} 字才能归纳出风格`;
  if (length > SAMPLE_MAX_LENGTH)
    return `示例过长，请截取 ${SAMPLE_MAX_LENGTH} 字以内最有代表性的片段`;
  return undefined;
}
