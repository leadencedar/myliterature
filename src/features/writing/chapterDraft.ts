import { composeSections } from '@/prompt/sections';
import { resolveChapterTargetWords, sceneRangeHint } from './chapterLength';

/**
 * 整章正文生成的提示词。
 *
 * 与结构化任务不同，这里最重要的是**把设定转化为场景**而不是复述设定。
 * 模型拿到一堆人物档案后最常见的失败是写成资料介绍：「林越，流亡贵族，
 * 性格沉默」—— 读起来像人物卡而不是小说。所以任务说明里对此专门约束。
 */
const CHAPTER_TASK = [
  '【任务】',
  '按下面给出的大纲写出这一章的正文。',
  '',
  '硬性要求：',
  '- 直接输出正文，不要章节标题、不要小标题、不要任何解释或说明。',
  '- 不要使用 Markdown 标记。段落之间用空行分隔。',
  '- 把设定**化用**进场景、动作与对话，不要复述设定本身。读者应当通过人物做了什么感受到世界规则，而不是被告知规则。',
  '- 人物的说话方式要与其档案一致；同一个人物在不同章节的口吻不能变样。',
  '- 严格遵守上文列出的核心设定，不要发明与之冲突的新规则。',
  '- 只写本章范围内的内容，不要把后续章节的情节提前写掉。',
  '- 如果上文给出了上一章的结尾原文，要顺着它的语气与场景往下接，不要重新交代已经交代过的信息。',
].join('\n');

/** 系统提示 = 稳定前缀 + 任务说明。稳定前缀由 ContextBuilder 产出 */
export function buildChapterSystemPrompt(stablePrefix: string): string {
  return composeSections([
    '你是一位职业小说作者，按编辑给定的大纲与设定写出可直接发表的正文。',
    stablePrefix,
    CHAPTER_TASK,
  ]);
}

/** 用户提示 = 易变后缀 + 本次的字数与额外要求 */
export function buildChapterUserPrompt(params: {
  volatileSuffix: string;
  targetWords: number | null;
  instruction?: string;
}): string {
  const lines = [params.volatileSuffix];

  /**
   * 目标字数只做结构承诺，不做字数遥控（D4：优先结构，再谈差额）。
   * 旧文案「约 N 字，可上下浮动 15%」把模型推向两种失败：场次不够靠心理复述凑字数，
   * 或者为了卡篇幅提前收尾。这里改成「先按梗概节拍分场，节拍撑不满就自然收束」。
   */
  const targetWords = resolveChapterTargetWords(params.targetWords);
  const requirements: string[] = [
    `本章目标约 ${targetWords} 字，场景数供参考：${sceneRangeHint(targetWords)}。`,
    '以【本章要写的内容】的梗概节拍为准：每个节拍落到目标—阻碍—转折；',
    '节拍不足时把一场写深，不要用心理复述、景物堆砌凑字数；',
    '节拍撑不满目标时写到场景自然收束即可。',
    '按时空或视点转移换场，不要按段落切场。',
    '结尾收在梗概承诺的钩子上，不要用总结收尾。',
    '若文体篇幅建议（如网文单章 2000–3000 字）与本节目标冲突，以本节目标为准。',
  ];
  if (params.instruction?.trim()) {
    requirements.push(`用户额外要求：${params.instruction.trim()}`);
  }
  requirements.push('现在开始写正文。');

  lines.push(['【本次要求】', ...requirements].join('\n'));
  return composeSections(lines);
}
