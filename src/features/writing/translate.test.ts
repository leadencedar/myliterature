import { describe, expect, it } from 'vitest';
import { ChapterSchema, NovelSchema, StyleProfileSchema } from '@/domain/schema';
import {
  GLOSSARY_DELIMITER,
  accumulatedGlossary,
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
  isTranslated,
  parseTranslation,
  splitForTranslation,
  translatedTail,
  translationLengthSane,
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

describe('章内自动分段', () => {
  it('短章节一段搞定，原文原样保留', () => {
    const source = 'Ashford shouldered the pack before dawn.';
    expect(splitForTranslation(source)).toEqual([{ text: source, separatorBefore: '' }]);
  });

  it('段落之间在空行边界切，段内结构保留', () => {
    const para = (n: number) => `Paragraph ${n}. ${'word '.repeat(400)}`; // 每段约 2400 字符，两段放不进一段
    const source = `${para(1)}\n\n${para(2)}`;
    const segments = splitForTranslation(source);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.text).toBe(para(1));
    expect(segments[1]!.separatorBefore).toBe('\n\n');
    expect(segments[1]!.text).toBe(para(2));
  });

  it('拼接时把分隔放回原位，逐字还原原文布局', () => {
    const source = ['AAA', '', 'BBB', '', '', 'CCC'].join('\n');
    const segments = splitForTranslation(source);
    const rebuilt = segments
      .reduce((out, item) => out + item.separatorBefore + item.text, '')
      .trim();
    expect(rebuilt).toBe(source.trim());
  });

  it('超长段落按句末标点切，句界不会切在 grapheme 中间', () => {
    const sentence = '他站在渡口，看着雨落进灰沼。';
    const source = sentence.repeat(300); // 每句 15 字符，300 句远超预算
    const segments = splitForTranslation(source, 400);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.text.length).toBeLessThanOrEqual(400);
      // 每段要么以句末标点收尾，要么是原文的尾段
      expect(segment.text.trimEnd().endsWith('。')).toBe(true);
    }
    // 拼接逐字还原
    const rebuilt = segments
      .reduce((out, item) => out + item.separatorBefore + item.text, '')
      .trim();
    expect(rebuilt).toBe(source.trim());
  });

  it('围栏代码块是原子：超预算也不拆，且不丢失', () => {
    const fence = ['```js', 'const x = 1;', '```'].join('\n');
    const source = `前面一段。\n\n${fence}\n\n后面一段。`;
    const segments = splitForTranslation(source, 25);
    const fenceSegment = segments.find((item) => item.text.includes('```'));
    expect(fenceSegment?.text).toBe(fence);
    expect(fenceSegment?.separatorBefore).toBe('\n\n');
    const rebuilt = segments
      .reduce((out, item) => out + item.separatorBefore + item.text, '')
      .trim();
    expect(rebuilt).toBe(source.trim());
  });

  it('表格是原子：连续竖线行整块拿走', () => {
    const table = ['| 名称 | 说明 |', '| --- | --- |', '| 灰沼 | 渡口 |'].join('\n');
    const source = `上文。\n\n${table}\n\n下文。`;
    const segments = splitForTranslation(source, 30);
    const tableSegment = segments.find((item) => item.text.includes('|'));
    expect(tableSegment?.text).toBe(table);
  });

  it('emoji 序列的硬切落在 grapheme 边界，不产生乱码', () => {
    const source = '👍🏽'.repeat(300); // 每个序列是 2 个码点、1 个 grapheme
    const segments = splitForTranslation(source, 100);
    for (const segment of segments) {
      expect(segment.text.length).toBeLessThanOrEqual(100);
    }
    const rebuilt = segments
      .reduce((out, item) => out + item.separatorBefore + item.text, '')
      .trim();
    expect(rebuilt).toBe(source.trim());
  });
});

describe('长度校验', () => {
  it('正常比例通过', () => {
    expect(
      translationLengthSane(
        '阿什福德在黎明前背起了行囊，把渔村留在了身后。',
        'Ashford shouldered the pack before dawn and left the village.',
      ),
    ).toBe(true);
  });

  it('明显漏译（比例过低）拦下', () => {
    expect(
      translationLengthSane(
        '阿什福德。',
        'Ashford shouldered the pack before dawn and left the village behind.',
      ),
    ).toBe(false);
  });

  it('复述指令或明显异常（比例过高）拦下', () => {
    expect(translationLengthSane(`${'好。'.repeat(400)}`, 'Ashford left.')).toBe(false);
  });

  it('空译文不算通过', () => {
    expect(translationLengthSane('', 'Ashford left.')).toBe(false);
  });
});

describe('分段累计译名', () => {
  const done = (glossary: { source: string; target: string }[]) => ({
    status: 'done' as const,
    glossary,
  });

  it('先到先得：前段定下的译名，后段改不动', () => {
    const accumulated = accumulatedGlossary(
      [
        done([{ source: 'Ashford', target: '阿什福德' }]),
        done([{ source: 'Ashford', target: '艾许佛' }]),
      ],
      [],
    );
    expect(accumulated).toEqual([{ source: 'Ashford', target: '阿什福德' }]);
  });

  it('作品级译名表排在最前，段产出只能补充新名字', () => {
    const accumulated = accumulatedGlossary(
      [done([{ source: 'Ashford', target: '艾许佛' }])],
      [{ source: 'Ashford', target: '阿什福德' }],
    );
    expect(accumulated).toEqual([{ source: 'Ashford', target: '阿什福德' }]);
  });

  it('未完成（pending）段的译名不参与累计 —— 失败段的贡献天然回滚', () => {
    const accumulated = accumulatedGlossary(
      [
        done([{ source: 'Ashford', target: '阿什福德' }]),
        { status: 'pending' as const, glossary: [{ source: 'Greymoor', target: '灰沼' }] },
      ],
      [],
    );
    expect(accumulated).toEqual([{ source: 'Ashford', target: '阿什福德' }]);
  });
});
