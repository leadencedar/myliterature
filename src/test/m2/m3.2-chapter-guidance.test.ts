/**
 * M3.2-S1 独立验收：章节生成 prompt 的「软引导」。
 *
 * 真机真实模型会写到目标的 1.5–2 倍：M3.2 在用户要求里加入一段软引导，让模型在明显超出时
 * 优先收紧重复描写、不新增场景；但不得出现「不得超过 / 硬上限 / 最多 N 字」这类硬约束。
 * 独立于开发的 chapterDraft 测试：直接断言 prompt 文本的包含/排除关系与位置。
 */
import { describe, expect, it } from 'vitest';
import { buildChapterSystemPrompt, buildChapterUserPrompt } from '@/features/writing/chapterDraft';

function userPrompt(targetWords: number | null, instruction?: string) {
  return buildChapterUserPrompt({
    volatileSuffix: '【本章要写的内容】\n节拍一。',
    targetWords,
    ...(instruction === undefined ? {} : { instruction }),
  });
}

describe('M3.2 · 章节 prompt 软引导', () => {
  it('用户要求含软引导四要素（参考目标/收紧重复/不新增场景），各目标字数都生效', () => {
    for (const targetWords of [null, 1200, 3000, 6000] as const) {
      const prompt = userPrompt(targetWords);
      expect(prompt).toContain('目标字数是篇幅参考，不是必须写满的硬指标');
      expect(prompt).toContain('优先收紧重复的环境与心理描写、删掉重复信息，不新增无关场景。');
      // 原有结构优先/自然收束保留
      expect(prompt).toContain('节拍撑不满目标时写到场景自然收束即可。');
      expect(prompt).toContain('以【本章要写的内容】的梗概节拍为准');
    }
  });

  it('无「不得超过 / 硬上限 / 最多 N 字」类硬约束（user 与 system 都查）', () => {
    const forbidden = /不得超过|硬上限|最多\s*\d+\s*字|不能超过|严禁超出|上限\s*\d/u;
    for (const targetWords of [null, 3000, 6000] as const) {
      expect(userPrompt(targetWords)).not.toMatch(forbidden);
    }
    expect(buildChapterSystemPrompt('【稳定前缀】')).not.toMatch(forbidden);
  });

  it('用户额外要求仍生效，且排在软引导之后（靠近「现在开始写正文」）', () => {
    const prompt = userPrompt(3000, '更紧凑，少写环境。');
    expect(prompt).toContain('用户额外要求：更紧凑，少写环境。');
    const guidanceIndex = prompt.indexOf('目标字数是篇幅参考');
    const instructionIndex = prompt.indexOf('用户额外要求：');
    expect(guidanceIndex).toBeGreaterThan(-1);
    expect(instructionIndex).toBeGreaterThan(guidanceIndex);
    expect(prompt.trimEnd().endsWith('现在开始写正文。')).toBe(true);
  });
});
