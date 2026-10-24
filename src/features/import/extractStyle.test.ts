import { describe, expect, it } from 'vitest';
import {
  MANUSCRIPT_STYLE_SYSTEM,
  MIN_SAMPLE_CHAPTER_LENGTH,
  ManuscriptStyleSchema,
  buildManuscriptStyleUserPrompt,
  normalizeSubGenre,
  sampleManuscript,
  toStylePayload,
  type SampleChapter,
} from './extractStyle';

/** 造一章指定长度的正文，句读齐全以便检验截断落在句子边界 */
function chapter(index: number, length: number, title = ''): SampleChapter {
  const sentence = `第${index}章的正文内容在这里反复出现，用来把篇幅撑到需要的长度。`;
  let content = '';
  while (content.length < length) content += sentence;
  return { index, title, content: content.slice(0, length) };
}

describe('取样', () => {
  it('跳过过短的章 —— 目录页和卷标题归纳不出文风', () => {
    const sample = sampleManuscript([
      { index: 1, title: '目录', content: '第一卷 风起' },
      chapter(2, 2000),
      chapter(3, 2000),
    ]);
    expect(sample).toContain('第 2 章');
    expect(sample).not.toContain('第 1 章');
  });

  it('章数有余量时让出第一章 —— 楔子的语感不代表全书', () => {
    const sample = sampleManuscript([
      chapter(1, 2000),
      chapter(2, 2000),
      chapter(3, 2000),
      chapter(4, 2000),
    ]);
    expect(sample).not.toContain('第 1 章');
    expect(sample).toContain('第 2 章');
  });

  it('章数刚够或不够时不让出第一章 —— 扔掉一半样本比拿楔子更糟', () => {
    const sample = sampleManuscript([chapter(1, 2000), chapter(2, 2000)]);
    expect(sample).toContain('第 1 章');
    expect(sample).toContain('第 2 章');
  });

  it('只有一章时照样用它', () => {
    const sample = sampleManuscript([chapter(1, 2000)]);
    expect(sample).toContain('第 1 章');
    expect(sample.length).toBeGreaterThan(100);
  });

  it('一章都不够长时退而用全部章节，而不是交白卷', () => {
    const sample = sampleManuscript([
      { index: 1, title: '', content: '很短的一章。' },
      { index: 2, title: '', content: '也很短的一章。' },
    ]);
    expect(sample).toContain('第 2 章');
  });

  it('最多取三章，且均匀分布而不是全挤在开头', () => {
    const many = Array.from({ length: 30 }, (_, i) => chapter(i + 1, 2000));
    const sample = sampleManuscript(many);

    const picked = [...sample.matchAll(/第 (\d+) 章/gu)].map((m) => Number(m[1]));
    expect(picked).toHaveLength(3);
    // 跨度要覆盖全书，不能三章都在前几章里
    expect(Math.max(...picked) - Math.min(...picked)).toBeGreaterThan(10);
  });

  it('总长受预算约束', () => {
    const many = Array.from({ length: 10 }, (_, i) => chapter(i + 1, 5000));
    expect(sampleManuscript(many, 1200).length).toBeLessThanOrEqual(1200);
  });

  it('完全确定性 —— 同一份稿件每次取样逐字节一致', () => {
    // 不一致会让 prompt 缓存失效，测试也不可重复
    const many = Array.from({ length: 12 }, (_, i) => chapter(i + 1, 3000));
    expect(sampleManuscript(many)).toBe(sampleManuscript(many));
  });

  it('带上章号与标题，模型才知道片段之间不连续', () => {
    const sample = sampleManuscript([chapter(1, 2000), chapter(7, 2000, '雪夜')]);
    expect(sample).toContain('【第 7 章 雪夜】');
  });

  it('空输入返回空串', () => {
    expect(sampleManuscript([])).toBe('');
  });

  it('取中段而不是开头 —— 章首多是时间地点交代', () => {
    const body = `${'开头的交代文字。'.repeat(20)}${'中段的对话与描写。'.repeat(40)}${'结尾的收束文字。'.repeat(20)}`;
    const sample = sampleManuscript([{ index: 1, title: '', content: body }], 400);
    expect(sample).toContain('中段的对话与描写');
    expect(sample).not.toContain('开头的交代文字。开头的交代文字。');
  });

  it('截断落在句子边界上，不留半句', () => {
    // 半句开头会被模型当成作者的断句习惯，污染「句式节奏」这一维
    const sample = sampleManuscript([chapter(1, 3000)], 300);
    const body = sample.split('\n').slice(1).join('\n');
    expect(body.endsWith('。')).toBe(true);
  });

  it('短章阈值就是对外承诺的那个常量', () => {
    const justUnder = { index: 1, title: '', content: 'x'.repeat(MIN_SAMPLE_CHAPTER_LENGTH - 1) };
    const justOver = { index: 2, title: '', content: 'y'.repeat(MIN_SAMPLE_CHAPTER_LENGTH) };
    // 只有第 2 章合格，于是「让出第一章」的规则不适用
    expect(sampleManuscript([justUnder, justOver])).toContain('第 2 章');
  });
});

describe('子类归一化', () => {
  it('精确匹配 id', () => {
    expect(normalizeSubGenre('web', '都市')).toBe('都市');
  });

  it('组合词按包含匹配', () => {
    // 模型常回「都市言情」这类组合词
    expect(normalizeSubGenre('web', '现代都市')).toBe('都市');
  });

  it('该取向下不存在的子类一律留空', () => {
    // 严肃文学没有任何子类；留一个找不到约定的值只会白占字段
    expect(normalizeSubGenre('literary', '都市')).toBe('');
    expect(normalizeSubGenre('web', '轻小说')).toBe('');
  });

  it('空值与空白安全', () => {
    expect(normalizeSubGenre('web', '')).toBe('');
    expect(normalizeSubGenre('web', '   ')).toBe('');
  });

  it('同名子类按当前取向解释', () => {
    // 「科幻」在 web 与 genre 下都有，各自返回自己的
    expect(normalizeSubGenre('web', '科幻')).toBe('科幻');
    expect(normalizeSubGenre('genre', '科幻')).toBe('科幻');
    // 「推理」只在 genre 下有
    expect(normalizeSubGenre('web', '推理')).toBe('');
    expect(normalizeSubGenre('genre', '推理')).toBe('推理');
  });
});

describe('输出 schema', () => {
  const full = {
    sentenceRhythm: '短句为主',
    imagery: '取材市井',
    narrativeDistance: '贴近人物',
    dialogue: '密度高',
    rhetoric: '少用比喻',
    lexicon: '口语化',
    avoid: '避免华丽辞藻',
    tradition: 'web' as const,
    subGenre: '都市',
  };

  it('七维缺一不可 —— 半份 rubric 不如没有', () => {
    const { avoid: _avoid, ...missing } = full;
    expect(ManuscriptStyleSchema.safeParse(missing).success).toBe(false);
  });

  it('文体取向只接受三个合法值', () => {
    expect(ManuscriptStyleSchema.safeParse({ ...full, tradition: 'xianxia' }).success).toBe(false);
  });

  it('子类可以缺，默认空串', () => {
    const { subGenre: _subGenre, ...withoutSubGenre } = full;
    const parsed = ManuscriptStyleSchema.parse(withoutSubGenre);
    expect(parsed.subGenre).toBe('');
  });
});

describe('转成提案 payload', () => {
  const result = ManuscriptStyleSchema.parse({
    sentenceRhythm: '短句为主',
    imagery: '取材市井',
    narrativeDistance: '贴近人物',
    dialogue: '密度高',
    rhetoric: '少用比喻',
    lexicon: '口语化',
    avoid: '避免华丽辞藻',
    tradition: 'web',
    subGenre: '现代都市',
  });

  it('七维装进 customRubric，取向与子类平铺', () => {
    const payload = toStylePayload(result);
    expect(payload.tradition).toBe('web');
    expect(payload.customRubric.sentenceRhythm).toBe('短句为主');
    // 与 RubricSchema 同构，不多不少七个键
    expect(Object.keys(payload.customRubric)).toHaveLength(7);
  });

  it('子类顺手归一化', () => {
    expect(toStylePayload(result).subGenre).toBe('都市');
  });
});

describe('提示词', () => {
  it('明确要求只归纳风格，不复述情节', () => {
    expect(MANUSCRIPT_STYLE_SYSTEM).toContain('不要复述情节');
  });

  it('把三个文体取向的判据都写进去，并给出分不清时的默认值', () => {
    expect(MANUSCRIPT_STYLE_SYSTEM).toContain('网络文学');
    expect(MANUSCRIPT_STYLE_SYSTEM).toContain('严肃文学');
    expect(MANUSCRIPT_STYLE_SYSTEM).toContain('类型文学');
    expect(MANUSCRIPT_STYLE_SYSTEM).toContain('分不清时选 web');
  });

  it('归纳的是作者自己的习惯，不是「写得好不好」', () => {
    expect(MANUSCRIPT_STYLE_SYSTEM).toContain('自己的');
    expect(MANUSCRIPT_STYLE_SYSTEM).toContain('不是「写得不好」的写法');
  });

  it('系统提示固定不变，是稳定前缀', () => {
    expect(MANUSCRIPT_STYLE_SYSTEM).toBe(MANUSCRIPT_STYLE_SYSTEM);
    expect(MANUSCRIPT_STYLE_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  });

  it('用户提示带上取样片段', () => {
    expect(buildManuscriptStyleUserPrompt('  片段  ')).toContain('片段');
    expect(buildManuscriptStyleUserPrompt('片段')).toContain('这部作品的若干片段');
  });
});
