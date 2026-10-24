import { describe, expect, it } from 'vitest';
import { RUBRIC_DIMENSIONS } from '@/prompt/voiceLibrary';
import {
  SAMPLE_MAX_LENGTH,
  SAMPLE_MIN_LENGTH,
  STYLE_SAMPLE_SYSTEM,
  StyleSampleSchema,
  buildStyleSampleUserPrompt,
  validateSample,
} from './styleSample';

describe('取样文本校验', () => {
  it('空文本给出提示', () => {
    expect(validateSample('')).toBe('请先粘贴一段示例文本');
    expect(validateSample('   \n  ')).toBe('请先粘贴一段示例文本');
  });

  it('太短的文本归纳不出风格', () => {
    expect(validateSample('短短一句。')).toContain(`至少需要 ${SAMPLE_MIN_LENGTH} 字`);
  });

  it('过长的文本要求截取', () => {
    expect(validateSample('字'.repeat(SAMPLE_MAX_LENGTH + 1))).toContain('请截取');
  });

  it.each([SAMPLE_MIN_LENGTH, SAMPLE_MAX_LENGTH])('边界长度 %i 视为合法', (length) => {
    expect(validateSample('字'.repeat(length))).toBeUndefined();
  });
});

describe('取样提示词', () => {
  it('系统提示覆盖全部 rubric 维度', () => {
    for (const dimension of RUBRIC_DIMENSIONS) {
      expect(STYLE_SAMPLE_SYSTEM).toContain(dimension.label);
    }
  });

  it('明确要求不要复述示例内容', () => {
    // 否则模型会把示例情节当成设定带进后续生成
    expect(STYLE_SAMPLE_SYSTEM).toContain('不要复述或引用示例文本的内容与情节');
  });

  it('用户提示把示例文本包在分隔符里', () => {
    const prompt = buildStyleSampleUserPrompt('  雨落在瓦上。  ');
    expect(prompt).toContain('---');
    expect(prompt).toContain('雨落在瓦上。');
  });
});

describe('取样输出 schema', () => {
  it('七个维度齐全才通过', () => {
    const complete = {
      sentenceRhythm: '短句',
      imagery: '刀与雨',
      narrativeDistance: '贴近',
      dialogue: '简短',
      rhetoric: '少修辞',
      lexicon: '朴素',
      avoid: '忌长句',
    };
    expect(StyleSampleSchema.safeParse(complete).success).toBe(true);
  });

  it('缺维度或留空都不通过，会触发修复重试', () => {
    expect(StyleSampleSchema.safeParse({ sentenceRhythm: '短句' }).success).toBe(false);
    expect(
      StyleSampleSchema.safeParse({
        sentenceRhythm: '',
        imagery: 'x',
        narrativeDistance: 'x',
        dialogue: 'x',
        rhetoric: 'x',
        lexicon: 'x',
        avoid: 'x',
      }).success,
    ).toBe(false);
  });
});
