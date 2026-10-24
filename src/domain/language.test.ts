import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  languageLabel,
  needsTranslationToChinese,
  profileLanguage,
} from './language';

const ZH_CHAPTER = '沈砚背起行囊时天还没亮。渔村的雾压得很低，他摸了摸怀里那块玉佩，转身没有回头。';

const EN_CHAPTER =
  'He shouldered the pack before dawn. The fog over the fishing village hung low. ' +
  'He touched the jade at his chest and turned away without looking back.';

describe('按章判定语种', () => {
  it('中文正文判为 zh', () => {
    expect(detectLanguage(ZH_CHAPTER)).toBe('zh');
  });

  it('英文正文判为 en', () => {
    expect(detectLanguage(EN_CHAPTER)).toBe('en');
  });

  it('中文里夹几个英文人名仍然是 zh，不该被拖去翻译', () => {
    const text = `${ZH_CHAPTER}他记得那人自称 Ashford，说话带着口音。`;
    expect(detectLanguage(text)).toBe('zh');
    expect(needsTranslationToChinese(text)).toBe(false);
  });

  it('中英各半判为 mixed', () => {
    expect(detectLanguage(`${ZH_CHAPTER}\n\n${EN_CHAPTER}`)).toBe('mixed');
  });

  it('英文里带个别汉字注释仍算 en', () => {
    expect(detectLanguage(`${EN_CHAPTER}（注：玉）`)).toBe('en');
  });
});

describe('字母太少时不下判断', () => {
  it('只有章节标题', () => {
    // 判成 en 就会被默认勾上翻译，让用户为一行标题付钱
    expect(detectLanguage('Chapter 1')).toBe('unknown');
    expect(needsTranslationToChinese('Chapter 1')).toBe(false);
  });

  it('空内容与纯符号', () => {
    expect(detectLanguage('')).toBe('unknown');
    expect(detectLanguage('---\n***\n123 456')).toBe('unknown');
  });

  it('短中文也算 unknown，但本来就不需要翻译', () => {
    expect(needsTranslationToChinese('他没有回头。')).toBe(false);
  });
});

describe('占比明细', () => {
  it('给出 CJK 与拉丁字母数，便于界面上解释判断依据', () => {
    const profile = profileLanguage('他说 hello');
    expect(profile.cjkLetters).toBe(2);
    expect(profile.latinLetters).toBe(5);
    expect(profile.cjkRatio).toBeCloseTo(2 / 7);
  });

  it('标点不参与占比计算', () => {
    // 「。，！」若算进中文占比，一段中文标点夹着的英文会被误判成中文
    const withPunctuation = profileLanguage('。，！？「」');
    expect(withPunctuation.cjkLetters).toBe(0);
    expect(withPunctuation.latinLetters).toBe(0);
    expect(withPunctuation.language).toBe('unknown');
  });

  it('全部没有字母时占比是 0 而不是 NaN', () => {
    expect(profileLanguage('123 456').cjkRatio).toBe(0);
  });
});

describe('需要翻译的判断', () => {
  it('en 与 mixed 需要，zh 与 unknown 不需要', () => {
    expect(needsTranslationToChinese(EN_CHAPTER)).toBe(true);
    expect(needsTranslationToChinese(`${ZH_CHAPTER}\n\n${EN_CHAPTER}`)).toBe(true);
    expect(needsTranslationToChinese(ZH_CHAPTER)).toBe(false);
    expect(needsTranslationToChinese('')).toBe(false);
  });
});

describe('展示文案', () => {
  it('四种语种都有标签', () => {
    expect(languageLabel('zh')).toBe('中文');
    expect(languageLabel('en')).toBe('外文');
    expect(languageLabel('mixed')).toBe('中外混排');
    expect(languageLabel('unknown')).toBe('无法判断');
  });
});
