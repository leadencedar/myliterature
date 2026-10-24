import { describe, expect, it } from 'vitest';
import { ChapterSchema, NovelSchema, StyleProfileSchema } from '@/domain/schema';
import {
  GLOSSARY_DELIMITER,
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
  isTranslated,
  parseTranslation,
  translatedTail,
} from './translate';

const NOVEL = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  oneLiner: '一个少年为寻母远赴归墟。',
  createdAt: 0,
  updatedAt: 0,
});

const STYLE = StyleProfileSchema.parse({
  id: 's1',
  novelId: 'n1',
  createdAt: 0,
  updatedAt: 0,
});

describe('切分译文与译名表', () => {
  it('正常输出：译文归译文，对照归对照', () => {
    const raw = [
      '他在黎明前背起了行囊。',
      '',
      '渔村的雾压得很低。',
      GLOSSARY_DELIMITER,
      'Ashford => 阿什福德',
      'Greymoor => 灰沼',
    ].join('\n');

    expect(parseTranslation(raw)).toEqual({
      text: '他在黎明前背起了行囊。\n\n渔村的雾压得很低。',
      glossary: [
        { source: 'Ashford', target: '阿什福德' },
        { source: 'Greymoor', target: '灰沼' },
      ],
    });
  });

  it('没有分隔行时整段都算译文 —— 丢掉整章译文才是真损失', () => {
    const raw = '他在黎明前背起了行囊。\n\n渔村的雾压得很低。';
    expect(parseTranslation(raw)).toEqual({ text: raw, glossary: [] });
  });

  it('分隔行的破折号数量与全角变体都认', () => {
    for (const delimiter of ['--译名表--', '-----译名表-----', '—— 译名表 ——']) {
      const parsed = parseTranslation(`译文。\n${delimiter}\nAshford => 阿什福德`);
      expect(parsed.text).toBe('译文。');
      expect(parsed.glossary).toEqual([{ source: 'Ashford', target: '阿什福德' }]);
    }
  });

  it('箭头与列表符号的各种写法都认', () => {
    const raw = [
      '译文。',
      GLOSSARY_DELIMITER,
      '- Ashford -> 阿什福德',
      '* Greymoor → 灰沼',
      '  Eastwick => 东威克',
    ].join('\n');
    expect(parseTranslation(raw).glossary).toEqual([
      { source: 'Ashford', target: '阿什福德' },
      { source: 'Greymoor', target: '灰沼' },
      { source: 'Eastwick', target: '东威克' },
    ]);
  });

  it('残缺的行跳过，不往表里塞半条', () => {
    const raw = [
      '译文。',
      GLOSSARY_DELIMITER,
      'Ashford => 阿什福德',
      '这一行没有箭头',
      '=> 只有译名',
      'Greymoor =>',
      'Eastwick => 东威克',
    ].join('\n');
    expect(parseTranslation(raw).glossary).toEqual([
      { source: 'Ashford', target: '阿什福德' },
      { source: 'Eastwick', target: '东威克' },
    ]);
  });

  it('同一个原文名重复出现时只留第一条', () => {
    const raw = ['译文。', GLOSSARY_DELIMITER, 'Ashford => 阿什福德', 'ashford => 艾许佛'].join(
      '\n',
    );
    expect(parseTranslation(raw).glossary).toEqual([{ source: 'Ashford', target: '阿什福德' }]);
  });

  it('模型把译文包进代码块时去掉围栏', () => {
    const raw = ['```', '他在黎明前背起了行囊。', '```', GLOSSARY_DELIMITER, 'A => 甲'].join('\n');
    expect(parseTranslation(raw).text).toBe('他在黎明前背起了行囊。');
  });

  it('只有译名表没有译文也不炸', () => {
    expect(parseTranslation(`${GLOSSARY_DELIMITER}\nA => 甲`)).toEqual({
      text: '',
      glossary: [{ source: 'A', target: '甲' }],
    });
  });
});

describe('提示词', () => {
  it('系统提示强调忠实优先，并把风格降为次要', () => {
    const prompt = buildTranslateSystemPrompt(NOVEL, STYLE);
    expect(prompt).toContain('忠实优先');
    expect(prompt).toContain('一律以忠实于原文为准');
    // 译文要和后续的中文续写读起来像同一本书，所以带上作品信息与文体
    expect(prompt).toContain('归墟纪');
    expect(prompt).toContain('【文体取向】');
  });

  it('系统提示要求同一名字全书只有一个译法，并规定输出格式', () => {
    const prompt = buildTranslateSystemPrompt(NOVEL, STYLE);
    expect(prompt).toContain('全书只能有一个译法');
    expect(prompt).toContain(GLOSSARY_DELIMITER);
    expect(prompt).toContain('原文名 => 中文译名');
  });

  it('同样输入逐字节可复现，才能命中 prompt 缓存', () => {
    expect(buildTranslateSystemPrompt(NOVEL, STYLE)).toBe(buildTranslateSystemPrompt(NOVEL, STYLE));
  });

  it('用户提示带上已定译名、上一章结尾与原文', () => {
    const prompt = buildTranslateUserPrompt({
      index: 2,
      title: 'The Ferry',
      sourceText: 'Ashford waited at the ferry.',
      glossary: [{ source: 'Ashford', target: '阿什福德' }],
      previousTranslatedTail: '他没有回头。',
    });

    expect(prompt).toContain('【已定译名（必须沿用，不得另起译法）】');
    expect(prompt).toContain('Ashford => 阿什福德');
    expect(prompt).toContain('【上一章译文的结尾（仅供接住语感，不要续写它）】');
    expect(prompt).toContain('他没有回头。');
    expect(prompt).toContain('【待翻译的原文（第 2 章 The Ferry）】');
    expect(prompt).toContain('Ashford waited at the ferry.');
  });

  it('没有译名表与上一章时不产生空段落', () => {
    const prompt = buildTranslateUserPrompt({
      index: 1,
      title: '',
      sourceText: 'He left.',
      glossary: [],
    });
    expect(prompt).not.toContain('已定译名');
    expect(prompt).not.toContain('上一章译文');
    expect(prompt).toContain('【待翻译的原文（第 1 章）】');
  });
});

describe('辅助判断', () => {
  it('取译文结尾时不超过限长', () => {
    expect(translatedTail('一二三四五', 3)).toBe('三四五');
    expect(translatedTail('一二', 3)).toBe('一二');
  });

  it('有原文备份就说明这一章译过', () => {
    const base = { id: 'c1', novelId: 'n1', index: 1, createdAt: 0, updatedAt: 0 };
    expect(isTranslated(ChapterSchema.parse(base))).toBe(false);
    expect(isTranslated(ChapterSchema.parse({ ...base, sourceContent: 'He left.' }))).toBe(true);
    // 只有空白不算
    expect(isTranslated(ChapterSchema.parse({ ...base, sourceContent: '   ' }))).toBe(false);
  });
});
