import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAPTER_TARGET_WORDS,
  chapterMaxOutputTokens,
  resolveChapterTargetWords,
  sceneRangeHint,
} from './chapterLength';

describe('目标字数解析（D4）', () => {
  it('有值时取整', () => {
    expect(resolveChapterTargetWords(3000)).toBe(3000);
    expect(resolveChapterTargetWords(6000)).toBe(6000);
    expect(resolveChapterTargetWords(2999.6)).toBe(3000);
  });

  it('为空或非法时回退默认 3000', () => {
    expect(DEFAULT_CHAPTER_TARGET_WORDS).toBe(3000);
    expect(resolveChapterTargetWords(null)).toBe(3000);
    expect(resolveChapterTargetWords(undefined)).toBe(3000);
    expect(resolveChapterTargetWords(Number.NaN)).toBe(3000);
    expect(resolveChapterTargetWords(Number.POSITIVE_INFINITY)).toBe(3000);
    expect(resolveChapterTargetWords(0)).toBe(3000);
    expect(resolveChapterTargetWords(-100)).toBe(3000);
  });
});

describe('场景数参考区间', () => {
  it('3000 字上下给 1–2 场', () => {
    expect(sceneRangeHint(3000)).toBe('1–2 场');
    expect(sceneRangeHint(3500)).toBe('1–2 场');
  });

  it('6000 字上下给 3–5 场', () => {
    expect(sceneRangeHint(6000)).toBe('3–5 场');
    expect(sceneRangeHint(3501)).toBe('3–5 场');
    expect(sceneRangeHint(7000)).toBe('3–5 场');
  });

  it('更长的章给 3–6 场（按节拍，不按字数硬切）', () => {
    expect(sceneRangeHint(7001)).toBe('3–6 场');
    expect(sceneRangeHint(10000)).toBe('3–6 场');
  });
});

describe('输出 token 上限', () => {
  it('3000 字：ceil(3000×1.8)+800 = 6200', () => {
    expect(chapterMaxOutputTokens(3000)).toBe(6200);
  });

  it('6000 / 10000 字撞上 8192 上夹，避免被服务端整请求拒绝', () => {
    expect(chapterMaxOutputTokens(6000)).toBe(8192);
    expect(chapterMaxOutputTokens(10000)).toBe(8192);
  });

  it('极短目标按 4096 下夹，不让正常篇幅被误截断', () => {
    expect(chapterMaxOutputTokens(100)).toBe(4096);
    expect(chapterMaxOutputTokens(1)).toBe(4096);
  });

  it('空/非法目标按默认 3000 推导', () => {
    expect(chapterMaxOutputTokens(null)).toBe(6200);
    expect(chapterMaxOutputTokens(undefined)).toBe(6200);
    expect(chapterMaxOutputTokens(-1)).toBe(6200);
  });

  it('中间档按公式计算', () => {
    expect(chapterMaxOutputTokens(2000)).toBe(4400);
    expect(chapterMaxOutputTokens(3500)).toBe(7100);
    expect(chapterMaxOutputTokens(3001)).toBe(6202);
  });
});
