import { describe, expect, it } from 'vitest';
import {
  ChapterSchema,
  ChapterSummarySchema,
  KnowledgeEntrySchema,
  NovelSchema,
  WritingNormSchema,
  type Chapter,
  type ChapterSummary,
  type KnowledgeEntry,
  type WritingNorm,
} from '@/domain/schema';
import {
  ChapterSummaryResultSchema,
  buildSummarySystemPrompt,
  buildSummaryUserPrompt,
  mergeOpenThreads,
  previousSummaryOf,
  resolveEntryNames,
} from './chapterSummary';

function chapter(index: number, overrides: Partial<Chapter> = {}): Chapter {
  return ChapterSchema.parse({
    id: `ch${index}`,
    novelId: 'n1',
    index,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function summary(chapterId: string, overrides: Partial<ChapterSummary> = {}): ChapterSummary {
  return ChapterSummarySchema.parse({
    id: `sum-${chapterId}`,
    novelId: 'n1',
    chapterId,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function entry(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    id,
    novelId: 'n1',
    categoryId: 'c1',
    title: id,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

describe('伏笔累计合并', () => {
  it('去掉已收束的，追加新埋下的', () => {
    expect(
      mergeOpenThreads(['黑衣人的身份', '玉佩的来历'], ['玉佩的来历'], ['师父为何失踪']),
    ).toEqual(['黑衣人的身份', '师父为何失踪']);
  });

  it('标点差异也能识别为同一条', () => {
    // 模型抄回时常带上或漏掉标点，不能因此漏收束
    expect(mergeOpenThreads(['玉佩的来历。'], ['玉佩的来历'], [])).toEqual([]);
  });

  it('新增项与现存项重复时不重复记录', () => {
    expect(mergeOpenThreads(['黑衣人的身份'], [], ['黑衣人的身份', '新伏笔'])).toEqual([
      '黑衣人的身份',
      '新伏笔',
    ]);
  });

  it('忽略空白的新增项', () => {
    expect(mergeOpenThreads(['甲'], [], ['  ', '\n'])).toEqual(['甲']);
  });

  it('收束清单里有不存在的条目时不影响其余', () => {
    expect(mergeOpenThreads(['甲', '乙'], ['丙'], [])).toEqual(['甲', '乙']);
  });

  it('全部收束后返回空数组', () => {
    expect(mergeOpenThreads(['甲', '乙'], ['甲', '乙'], [])).toEqual([]);
  });

  it('保持原有顺序，新增项接在后面', () => {
    expect(mergeOpenThreads(['甲', '乙', '丙'], ['乙'], ['丁'])).toEqual(['甲', '丙', '丁']);
  });
});

describe('出场条目名称解析', () => {
  const entries = [
    entry('e-linyue', { title: '林越', aliases: ['阿越', 'Lin Yue'] }),
    entry('e-shenqing', { title: '沈清' }),
  ];

  it('按标题与别名匹配成 id', () => {
    expect(resolveEntryNames(entries, ['林越', '沈清'])).toEqual(['e-linyue', 'e-shenqing']);
    expect(resolveEntryNames(entries, ['阿越'])).toEqual(['e-linyue']);
    expect(resolveEntryNames(entries, ['lin yue'])).toEqual(['e-linyue']);
  });

  it('同一条目被多个名称命中时只记一次', () => {
    expect(resolveEntryNames(entries, ['林越', '阿越'])).toEqual(['e-linyue']);
  });

  it('匹配不上的名称直接丢弃，不往库里塞不存在的 id', () => {
    expect(resolveEntryNames(entries, ['林越', '凭空冒出的人'])).toEqual(['e-linyue']);
  });

  it('空输入返回空数组', () => {
    expect(resolveEntryNames(entries, [])).toEqual([]);
    expect(resolveEntryNames([], ['林越'])).toEqual([]);
  });
});

describe('前一份摘要', () => {
  const chapters = [chapter(1), chapter(2), chapter(3)];

  it('取目标章之前最近的一份', () => {
    const summaries = [
      summary('ch1', { summary: '第一章' }),
      summary('ch2', { summary: '第二章' }),
    ];
    expect(previousSummaryOf(chapters, summaries, 'ch3')?.summary).toBe('第二章');
  });

  it('跳过中间缺失摘要的章节', () => {
    const summaries = [summary('ch1', { summary: '第一章' })];
    expect(previousSummaryOf(chapters, summaries, 'ch3')?.summary).toBe('第一章');
  });

  it('第一章没有前序摘要', () => {
    expect(previousSummaryOf(chapters, [summary('ch1')], 'ch1')).toBeUndefined();
  });

  it('章节不存在时返回 undefined', () => {
    expect(previousSummaryOf(chapters, [], 'ghost')).toBeUndefined();
  });
});

describe('输出 schema', () => {
  function valid() {
    return {
      summary: '主角负伤逃入雪山。',
      keyEvents: ['遭遇追兵', '逃入雪山'],
      appearingEntries: ['林越'],
      newOpenThreads: ['黑衣人的身份'],
      resolvedThreads: [],
      rollingSummary: '故事开篇，主角被追杀。',
    };
  }

  it('完整结果通过校验', () => {
    expect(ChapterSummaryResultSchema.safeParse(valid()).success).toBe(true);
  });

  it('摘要或全书进展为空时不通过', () => {
    expect(ChapterSummaryResultSchema.safeParse({ ...valid(), summary: '' }).success).toBe(false);
    expect(ChapterSummaryResultSchema.safeParse({ ...valid(), rollingSummary: '' }).success).toBe(
      false,
    );
  });

  it('关键事件不能为空数组', () => {
    expect(ChapterSummaryResultSchema.safeParse({ ...valid(), keyEvents: [] }).success).toBe(false);
  });

  it('伏笔与出场可以为空数组', () => {
    expect(
      ChapterSummaryResultSchema.safeParse({
        ...valid(),
        appearingEntries: [],
        newOpenThreads: [],
      }).success,
    ).toBe(true);
  });
});

describe('提示词', () => {
  const novel = NovelSchema.parse({
    id: 'n1',
    title: '归墟纪',
    genre: '仙侠',
    createdAt: 0,
    updatedAt: 0,
  });

  it('系统提示只带作品信息，不带文风（摘要与文风无关）', () => {
    const prompt = buildSummarySystemPrompt(novel);

    expect(prompt).toContain('归墟纪');
    expect(prompt).not.toContain('【文体取向】');
    expect(prompt).not.toContain('【文风】');
  });

  it('系统提示对每个字段给出明确约束', () => {
    const prompt = buildSummarySystemPrompt(novel);

    expect(prompt).toContain('120 字以内');
    expect(prompt).toContain('只能从下面给出的名单中选');
    expect(prompt).toContain('不要为凑数硬编');
    // rollingSummary 是整体替换而非增量，必须说清楚
    expect(prompt).toContain('不要写成增量补充');
  });

  it('两次调用逐字节相同（缓存前提）', () => {
    expect(buildSummarySystemPrompt(novel)).toBe(buildSummarySystemPrompt(novel));
  });

  it('用户提示给出名单、未收束伏笔、旧进展与正文', () => {
    const prompt = buildSummaryUserPrompt({
      chapter: chapter(3, { title: '雪夜', content: '正文内容。' }),
      entryNames: ['林越', '沈清'],
      previousOpenThreads: ['黑衣人的身份'],
      previousRollingSummary: '前面发生的事。',
    });

    expect(prompt).toContain('【可选的人物与设定名单】\n林越、沈清');
    expect(prompt).toContain('【当前未收束的伏笔】');
    expect(prompt).toContain('- 黑衣人的身份');
    expect(prompt).toContain('请在 resolvedThreads 里原样抄回');
    expect(prompt).toContain('【此前的全书进展摘要】\n前面发生的事。');
    expect(prompt).toContain('【本章正文（第 3 章 雪夜）】');
    expect(prompt).toContain('正文内容。');
  });

  it('知识库为空时明确要求给空数组', () => {
    const prompt = buildSummaryUserPrompt({
      chapter: chapter(1, { content: '正文' }),
      entryNames: [],
      previousOpenThreads: [],
      previousRollingSummary: '',
    });

    expect(prompt).toContain('appearingEntries 请给空数组');
  });

  it('没有伏笔或旧进展时不产生空段落', () => {
    const prompt = buildSummaryUserPrompt({
      chapter: chapter(1, { content: '正文' }),
      entryNames: ['林越'],
      previousOpenThreads: [],
      previousRollingSummary: '   ',
    });

    expect(prompt).not.toContain('【当前未收束的伏笔】');
    expect(prompt).not.toContain('【此前的全书进展摘要】');
  });
});

describe('外传：摘要链按线承接', () => {
  const main1 = chapter(1);
  const main2 = chapter(2);
  const main3 = chapter(3);
  const side1 = chapter(1, { id: 'side-ch1', sideStoryId: 'side-a' });
  const side5 = chapter(5, { id: 'side-ch5', sideStoryId: 'side-a' });
  const other1 = chapter(1, { id: 'other-ch1', sideStoryId: 'side-b' });
  const other2 = chapter(2, { id: 'other-ch2', sideStoryId: 'side-b' });
  const chapters = [main1, main2, main3, side1, side5, other1, other2];
  const summaries = [
    summary('ch2', { openThreads: ['主线伏笔'] }),
    summary('side-ch5', { openThreads: ['外传伏笔'] }),
    summary('other-ch1', { openThreads: ['另一部外传的伏笔'] }),
  ];

  it('主线章节不会取到编号更大的外传摘要', () => {
    expect(previousSummaryOf(chapters, summaries, 'ch3')?.chapterId).toBe('ch2');
  });

  it('外传章节只承接同一部外传', () => {
    expect(previousSummaryOf(chapters, summaries, 'other-ch2')?.chapterId).toBe('other-ch1');
    // 外传第 1 章之前没有同一部外传的章节，不会取到主线或别的外传
    expect(previousSummaryOf(chapters, summaries, 'side-ch1')).toBeUndefined();
  });

  it('外传内部照常往前找最近一份摘要', () => {
    expect(
      previousSummaryOf(
        [...chapters, chapter(6, { id: 'side-ch6', sideStoryId: 'side-a' })],
        summaries,
        'side-ch6',
      )?.chapterId,
    ).toBe('side-ch5');
  });
});

describe('外传：用户提示', () => {
  const base = {
    chapter: chapter(2, { title: '旧事', content: '青冥宗的山门。' }),
    entryNames: ['沈砚'],
    previousOpenThreads: [],
    previousRollingSummary: '师父刚拜入青冥宗。',
  };

  it('传 sideStory 时进展块标题与外传说明都在正文之前', () => {
    const prompt = buildSummaryUserPrompt({
      ...base,
      sideStory: { title: '青冥旧事', synopsis: '二十年前的往事' },
    });

    expect(prompt).toContain('【此前的外传进展摘要（外传《青冥旧事》）】\n师父刚拜入青冥宗。');
    expect(prompt).not.toContain('【此前的全书进展摘要】');
    const note =
      '本章属于外传《青冥旧事》，独立于主线。rollingSummary 只写这部外传从第一章到本章的进展，不要混入主线剧情。';
    expect(prompt).toContain(note);
    expect(prompt.indexOf(note)).toBeLessThan(prompt.indexOf('【本章正文'));
  });

  it('不传 sideStory 时输出逐字节不变', () => {
    expect(buildSummaryUserPrompt(base)).toBe(
      [
        '【可选的人物与设定名单】\n沈砚',
        '【此前的全书进展摘要】\n师父刚拜入青冥宗。',
        '【本章正文（第 2 章 旧事）】\n青冥宗的山门。',
      ].join('\n\n'),
    );
  });
});

describe('写作规范', () => {
  const novel = NovelSchema.parse({ id: 'n1', title: '归墟纪', createdAt: 0, updatedAt: 0 });
  function norm(overrides: Partial<WritingNorm> = {}): WritingNorm {
    return WritingNormSchema.parse({
      id: 'norm-1',
      novelId: 'n1',
      title: '使用提示',
      content: '- 缺失信息只能作为建议。【标记 S】',
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    });
  }

  it('作用范围含章节摘要时带上，位于作品信息之后、任务说明之前', () => {
    const prompt = buildSummarySystemPrompt(novel, [norm()]);
    const at = prompt.indexOf('【规范《使用提示》】');

    expect(prompt).toContain('【标记 S】');
    expect(prompt).toContain('不要写进摘要或伏笔');
    expect(at).toBeGreaterThan(prompt.indexOf('【作品信息】'));
    expect(at).toBeLessThan(prompt.indexOf('【任务】'));
  });

  it('作用范围不含章节摘要或已停用时不带，与不传完全相同', () => {
    const base = buildSummarySystemPrompt(novel);
    expect(buildSummarySystemPrompt(novel, [norm({ scopes: ['writing', 'extract'] })])).toBe(base);
    expect(buildSummarySystemPrompt(novel, [norm({ enabled: false })])).toBe(base);
  });
});
