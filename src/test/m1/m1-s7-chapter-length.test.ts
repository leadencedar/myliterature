/**
 * S7 独立验收：chapterLength 纯函数边界 + chapterDraft 结构文案（design §8.1/§8.4）。
 *
 * 期望值按设计公式手算（含夹取边界），不复用开发测试的断言。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAPTER_TARGET_WORDS,
  chapterMaxOutputTokens,
  resolveChapterTargetWords,
  sceneRangeHint,
} from '@/features/writing/chapterLength';
import { buildChapterSystemPrompt, buildChapterUserPrompt } from '@/features/writing/chapterDraft';

describe('chapterLength · 目标字数解析（D4）', () => {
  it('默认值是 3000', () => {
    expect(DEFAULT_CHAPTER_TARGET_WORDS).toBe(3000);
  });

  it('有值取整；空/非法回退 3000', () => {
    expect(resolveChapterTargetWords(6000)).toBe(6000);
    expect(resolveChapterTargetWords(2500.4)).toBe(2500);
    expect(resolveChapterTargetWords(2500.5)).toBe(2501);
    expect(resolveChapterTargetWords(1)).toBe(1);

    for (const invalid of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveChapterTargetWords(invalid)).toBe(DEFAULT_CHAPTER_TARGET_WORDS);
    }
  });
});

describe('chapterLength · 场景数参考区间（design §8.1）', () => {
  it('≤3500 → 1–2 场；≤7000 → 3–5 场；否则 3–6 场（边界精确）', () => {
    expect(sceneRangeHint(1)).toBe('1–2 场');
    expect(sceneRangeHint(3000)).toBe('1–2 场');
    expect(sceneRangeHint(3500)).toBe('1–2 场');
    expect(sceneRangeHint(3501)).toBe('3–5 场');
    expect(sceneRangeHint(6000)).toBe('3–5 场');
    expect(sceneRangeHint(7000)).toBe('3–5 场');
    expect(sceneRangeHint(7001)).toBe('3–6 场');
    expect(sceneRangeHint(10000)).toBe('3–6 场');
    expect(sceneRangeHint(100000)).toBe('3–6 场');
  });
});

describe('chapterLength · 输出 token 上限（design §8.1：ceil(1.8×)+800 夹取 [4096,8192]）', () => {
  it.each([
    // [目标字数, 期望]；期望 = clamp(ceil(words*1.8)+800)
    [3000, 6200],
    [6000, 8192], // ceil(10800)+800=11600 → 上夹 8192
    [10000, 8192],
    [5000, 8192],
    [2000, 4400],
    [100, 4096],
    [1, 4096],
    [1831, 4096], // ceil(3295.8)=3296 + 800 = 4096（下夹取边界）
    [1832, 4098], // ceil(3297.6)=3298 + 800 = 4098
    [4106, 8191], // ceil(7390.8)=7391 + 800 = 8191（上夹取前）
    [4107, 8192], // ceil(7392.6)=7393 + 800 → 8192（夹取）
  ] as const)('%i 字 → %i tokens', (words, expected) => {
    expect(chapterMaxOutputTokens(words)).toBe(expected);
  });

  it('null/undefined/非法值按默认 3000 计算（6200）', () => {
    for (const invalid of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(chapterMaxOutputTokens(invalid)).toBe(6200);
    }
  });
});

describe('chapterDraft · 新结构文案（design §8.4）', () => {
  const volatileSuffix = '【本章要写的内容】\n本章标题：夜探\n本章梗概：林越夜入旧址。';

  it('6000 字：场景数 3–5 场，节拍优先/自然收束/钩子结尾/文体冲突以目标为准', () => {
    const prompt = buildChapterUserPrompt({ volatileSuffix, targetWords: 6000 });
    expect(prompt.startsWith(volatileSuffix)).toBe(true);
    expect(prompt).toContain('本章目标约 6000 字，场景数供参考：3–5 场。');
    expect(prompt).toContain('以【本章要写的内容】的梗概节拍为准：每个节拍落到目标—阻碍—转折');
    expect(prompt).toContain('节拍不足时把一场写深');
    expect(prompt).toContain('不要用心理复述、景物堆砌凑字数');
    expect(prompt).toContain('节拍撑不满目标时写到场景自然收束即可');
    expect(prompt).toContain('按时空或视点转移换场，不要按段落切场');
    expect(prompt).toContain('结尾收在梗概承诺的钩子上，不要用总结收尾');
    expect(prompt).toContain(
      '若文体篇幅建议（如网文单章 2000–3000 字）与本节目标冲突，以本节目标为准',
    );
    expect(prompt).toContain('现在开始写正文。');
    expect(prompt).not.toContain('可上下浮动');
  });

  it('targetWords=null 按 3000（1–2 场）；11000 用 3–6 场', () => {
    expect(buildChapterUserPrompt({ volatileSuffix, targetWords: null })).toContain(
      '本章目标约 3000 字，场景数供参考：1–2 场。',
    );
    expect(buildChapterUserPrompt({ volatileSuffix, targetWords: 11000 })).toContain(
      '本章目标约 11000 字，场景数供参考：3–6 场。',
    );
  });

  it('用户额外要求保留，空要求不渲染；两次调用逐字节相同', () => {
    const withExtra = buildChapterUserPrompt({
      volatileSuffix,
      targetWords: 3000,
      instruction: '结尾停在敲门声上',
    });
    expect(withExtra).toContain('用户额外要求：结尾停在敲门声上');

    const blankExtra = buildChapterUserPrompt({
      volatileSuffix,
      targetWords: 3000,
      instruction: '   ',
    });
    expect(blankExtra).not.toContain('用户额外要求');

    expect(buildChapterUserPrompt({ volatileSuffix, targetWords: 3000 })).toBe(
      buildChapterUserPrompt({ volatileSuffix, targetWords: 3000 }),
    );
  });

  it('字数相关只进 user：system 与目标字数无关（同书不同节点共享缓存前缀）', () => {
    const stablePrefix = '【作品信息】\n书名：归墟纪';
    const system = buildChapterSystemPrompt(stablePrefix);
    expect(system).not.toContain('本章目标约');
    expect(system).not.toContain('6000');
    expect(buildChapterSystemPrompt(stablePrefix)).toBe(system);
  });
});
