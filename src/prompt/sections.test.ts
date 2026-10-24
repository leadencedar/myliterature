import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@/context/tokens';
import {
  NovelSchema,
  StyleProfileSchema,
  WritingNormSchema,
  type Novel,
  type StyleProfile,
  type WritingNorm,
} from '@/domain/schema';
import {
  composeSections,
  composeStylePrefix,
  methodologySection,
  novelMetaSection,
  normTokens,
  renderNormBlock,
  traditionSection,
  voiceSection,
  writingNormsSection,
} from './sections';

function makeNovel(overrides: Partial<Novel> = {}): Novel {
  return NovelSchema.parse({
    id: 'n1',
    title: '归墟纪',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function makeStyle(overrides: Partial<StyleProfile> = {}): StyleProfile {
  return StyleProfileSchema.parse({
    id: 's1',
    novelId: 'n1',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

describe('作品信息段', () => {
  it('只输出已填字段，空字段不留空行', () => {
    const text = novelMetaSection(makeNovel());

    expect(text).toContain('书名：归墟纪');
    expect(text).toContain('叙述视角：第三人称限知视角');
    expect(text).not.toContain('体裁：');
    expect(text).not.toContain('故事内核：');
  });

  it('带上体裁、内核与目标字数', () => {
    const text = novelMetaSection(
      makeNovel({
        genre: '仙侠',
        oneLiner: '失忆剑客发现自己是灭门案凶手。',
        targetWords: 500_000,
        pov: 'first',
      }),
    );

    expect(text).toContain('体裁：仙侠');
    expect(text).toContain('故事内核：失忆剑客发现自己是灭门案凶手。');
    expect(text).toContain('预计总字数：500000');
    expect(text).toContain('叙述视角：第一人称');
  });
});

describe('文体取向段', () => {
  it('带上取向说明与写作约定', () => {
    const text = traditionSection(makeStyle({ tradition: 'web' }));

    expect(text).toContain('网络文学');
    expect(text).toContain('黄金三章');
    expect(text).toContain('2000–3000 字');
  });

  it('选了预置子类时追加该子类的约定', () => {
    const text = traditionSection(makeStyle({ tradition: 'genre', subGenre: '推理' }));

    expect(text).toContain('子类「推理」');
    // 推理类型的核心公约必须进 prompt
    expect(text).toContain('线索公平');
  });

  it('自填的子类原样带上，不被丢弃', () => {
    const text = traditionSection(makeStyle({ tradition: 'literary', subGenre: '家族史' }));
    expect(text).toContain('子类：家族史');
  });

  it('严肃文学没有子类列表时不报错', () => {
    expect(() => traditionSection(makeStyle({ tradition: 'literary' }))).not.toThrow();
  });
});

describe('结构方法段', () => {
  it.each([
    ['web-rhythm', '黄金三章'],
    ['three-act', '不可回头点'],
    ['snowflake', '颗粒度一致'],
    ['hero-journey', '至暗时刻'],
    ['qichengzhuanhe', '且听下回分解'],
  ] as const)('%s 输出对应的大纲结构要求', (methodology, marker) => {
    const text = methodologySection(makeStyle({ methodology }));
    expect(text).toContain(marker);
  });
});

describe('文风段', () => {
  it('没有任何风格设定时返回空串', () => {
    expect(voiceSection(makeStyle())).toBe('');
  });

  it('展开名家风格的全部 rubric 维度', () => {
    const text = voiceSection(
      makeStyle({ voiceRefs: [{ refId: 'gulong', name: '古龙', weight: 70 }] }),
    );

    expect(text).toContain('参考风格：古龙');
    expect(text).toContain('句式节奏');
    expect(text).toContain('需要避免');
    // 明确声明是学特征而非模仿原文
    expect(text).toContain('不是模仿任何具体作品的文句');
  });

  it('强度转成档位词而不是裸数字', () => {
    // 模型对「明显偏向」的理解比对「60」稳定
    expect(
      voiceSection(makeStyle({ voiceRefs: [{ refId: 'luxun', name: '鲁迅', weight: 90 }] })),
    ).toContain('强烈贴近');
    expect(
      voiceSection(makeStyle({ voiceRefs: [{ refId: 'luxun', name: '鲁迅', weight: 60 }] })),
    ).toContain('明显偏向');
    expect(
      voiceSection(makeStyle({ voiceRefs: [{ refId: 'luxun', name: '鲁迅', weight: 40 }] })),
    ).toContain('适度借鉴');
    expect(
      voiceSection(makeStyle({ voiceRefs: [{ refId: 'luxun', name: '鲁迅', weight: 10 }] })),
    ).toContain('略带一点');
  });

  it('两位名家风格都输出', () => {
    const text = voiceSection(
      makeStyle({
        voiceRefs: [
          { refId: 'jinyong', name: '金庸', weight: 60 },
          { refId: 'gulong', name: '古龙', weight: 40 },
        ],
      }),
    );

    expect(text).toContain('金庸');
    expect(text).toContain('古龙');
  });

  it('风格库里找不到 id 时退化为只用名字，不整段丢失', () => {
    const text = voiceSection(
      makeStyle({ voiceRefs: [{ refId: 'unknown-id', name: '某位作家', weight: 50 }] }),
    );
    expect(text).toContain('某位作家');
  });

  it('自定义 rubric 与名家风格叠加', () => {
    const text = voiceSection(
      makeStyle({
        voiceRefs: [{ refId: 'luxun', name: '鲁迅', weight: 60 }],
        customRubric: {
          sentenceRhythm: '一律用短句',
          imagery: '',
          narrativeDistance: '',
          dialogue: '',
          rhetoric: '',
          lexicon: '',
          avoid: '',
        },
      }),
    );

    expect(text).toContain('鲁迅');
    expect(text).toContain('自定义文风要求');
    expect(text).toContain('一律用短句');
  });

  it('自定义 rubric 全空时不产生空标题', () => {
    const text = voiceSection(
      makeStyle({
        customRubric: {
          sentenceRhythm: '',
          imagery: '',
          narrativeDistance: '',
          dialogue: '',
          rhetoric: '',
          lexicon: '',
          avoid: '',
        },
      }),
    );
    expect(text).toBe('');
  });

  it('额外写作要求原样带上', () => {
    const text = voiceSection(makeStyle({ extraInstruction: '不要写心理独白。' }));
    expect(text).toContain('不要写心理独白。');
  });
});

describe('稳定前缀的可复现性', () => {
  const novel = makeNovel({ genre: '仙侠', oneLiner: '失忆剑客的复仇。' });
  const style = makeStyle({
    tradition: 'web',
    subGenre: '仙侠',
    methodology: 'web-rhythm',
    voiceRefs: [
      { refId: 'gulong', name: '古龙', weight: 70 },
      { refId: 'jinyong', name: '金庸', weight: 40 },
    ],
    customRubric: {
      sentenceRhythm: '短句',
      imagery: '刀与雨',
      narrativeDistance: '',
      dialogue: '',
      rhetoric: '',
      lexicon: '',
      avoid: '',
    },
    extraInstruction: '每章结尾留钩子。',
  });

  it('同样的输入两次组装结果逐字节相同', () => {
    // 这是 prompt 缓存能否命中的前提，输入价差可达 50 倍
    expect(composeStylePrefix(novel, style)).toBe(composeStylePrefix(novel, style));
  });

  it('对象属性书写顺序不同也不影响输出', () => {
    const reordered = StyleProfileSchema.parse({
      extraInstruction: style.extraInstruction,
      customRubric: style.customRubric,
      voiceRefs: style.voiceRefs,
      methodology: style.methodology,
      subGenre: style.subGenre,
      tradition: style.tradition,
      novelId: 'n1',
      id: 's1',
      createdAt: 0,
      updatedAt: 0,
    });

    expect(composeStylePrefix(novel, reordered)).toBe(composeStylePrefix(novel, style));
  });

  it('与时间戳无关：updatedAt 变化不影响前缀', () => {
    const touched = { ...style, updatedAt: 999_999 };
    expect(composeStylePrefix(novel, touched)).toBe(composeStylePrefix(novel, style));
  });

  it('改动风格设定时前缀随之变化', () => {
    const changed = { ...style, methodology: 'three-act' as const };
    expect(composeStylePrefix(novel, changed)).not.toBe(composeStylePrefix(novel, style));
  });

  it('四个段落按固定顺序出现', () => {
    const text = composeStylePrefix(novel, style);
    const order = ['【作品信息】', '【文体取向】', '【结构方法】', '【文风】'].map((marker) =>
      text.indexOf(marker),
    );

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('前后无多余空白，段落之间恰好一个空行', () => {
    const text = composeStylePrefix(novel, style);
    expect(text).toBe(text.trim());
    expect(text).not.toMatch(/\n{3,}/u);
  });
});

function makeNorm(overrides: Partial<WritingNorm> = {}): WritingNorm {
  return WritingNormSchema.parse({
    id: 'norm-1',
    novelId: 'n1',
    title: '使用提示',
    content: '- 以已导入资料为原作基线。',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

describe('写作规范段', () => {
  it('没有可注入的规范时返回空串', () => {
    expect(writingNormsSection(undefined, 'writing')).toBe('');
    expect(writingNormsSection([], 'writing')).toBe('');
    expect(writingNormsSection([makeNorm({ enabled: false })], 'writing')).toBe('');
    expect(writingNormsSection([makeNorm({ scopes: ['extract'] })], 'writing')).toBe('');
  });

  it('五种作用范围的用法行各不相同', () => {
    const scopes = ['writing', 'planning', 'summary', 'extract', 'check'] as const;
    const norm = makeNorm();
    // 去掉公共部分后只剩用法行；用法行彼此不同，模型才知道这次该怎么用规范
    const usageLines = scopes.map((scope) => writingNormsSection([norm], scope).split('\n')[2]);

    expect(new Set(usageLines).size).toBe(5);
    for (const line of usageLines) expect(line?.trim()).toBeTruthy();
  });

  it('提取作用范围明确禁止从规范里提取条目', () => {
    expect(writingNormsSection([makeNorm()], 'extract')).toContain('不要从规范里提取条目');
    expect(writingNormsSection([makeNorm()], 'writing')).not.toContain('不要从规范里提取条目');
  });

  it('两次调用结果逐字节相同', () => {
    const norms = [makeNorm(), makeNorm({ id: 'norm-2', title: '差异说明', order: 1 })];
    expect(writingNormsSection(norms, 'writing')).toBe(writingNormsSection(norms, 'writing'));
  });

  it('按 order 排序，与传入顺序无关', () => {
    const first = makeNorm({ id: 'a', title: '甲', order: 0 });
    const second = makeNorm({ id: 'b', title: '乙', order: 1 });
    const text = writingNormsSection([second, first], 'writing');

    expect(text).toBe(writingNormsSection([first, second], 'writing'));
    expect(text.indexOf('【规范《甲》】')).toBeLessThan(text.indexOf('【规范《乙》】'));
  });

  it('renderNormBlock 只去首尾空白，内部空行与 ## 小节原样保留', () => {
    const block = renderNormBlock({
      title: '使用提示',
      content: '\n  ## 写作规则\n- 一条\n\n## 提取规则\n- 另一条  \n\n',
    });

    expect(block).toBe(
      '【规范《使用提示》】\n## 写作规则\n- 一条\n\n## 提取规则\n- 另一条\n【规范《使用提示》结束】',
    );
  });

  it('两份都含 ## 小节的规范仍能切出恰好两份', () => {
    const text = writingNormsSection(
      [
        makeNorm({ id: 'a', title: '甲', order: 0, content: '## 小节一\n- a1\n\n## 小节二\n- a2' }),
        makeNorm({ id: 'b', title: '乙', order: 1, content: '## 小节一\n- b1\n\n## 小节二\n- b2' }),
      ],
      'writing',
    );

    expect(text.match(/【规范《[^》]*》】\n/gu)).toHaveLength(2);
    expect(text.match(/【规范《[^》]*》结束】/gu)).toHaveLength(2);

    const parts = text.split(/【规范《[^》]*》】\n/u).slice(1);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('- a1');
    expect(parts[0]).toContain('- a2');
    expect(parts[0]).not.toContain('- b1');
    expect(parts[1]).toContain('- b1');
    expect(parts[1]).toContain('- b2');
  });

  it('normTokens 与渲染后的块同一口径', () => {
    const norm = makeNorm({ content: '  - 一条规则\n\n- second rule  ' });
    expect(normTokens(norm)).toBe(estimateTokens(renderNormBlock(norm)));
  });
});

describe('段落拼接', () => {
  it('跳过空段与空白段', () => {
    expect(composeSections(['甲', '', undefined, null, '  ', '乙'])).toBe('甲\n\n乙');
  });

  it('全为空时返回空串', () => {
    expect(composeSections([undefined, ''])).toBe('');
  });
});
