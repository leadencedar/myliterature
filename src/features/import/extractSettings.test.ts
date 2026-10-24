import { describe, expect, it } from 'vitest';
import { CHARACTER_FIELDS, WORLDBUILDING_FIELDS } from '@/domain/defaults';
import {
  CategorySchema,
  ChapterSchema,
  KnowledgeEntrySchema,
  NovelSchema,
  WritingNormSchema,
  type Category,
  type Chapter,
  type ImportEntryDraft,
  type KnowledgeEntry,
  type WritingNorm,
} from '@/domain/schema';
import {
  ExtractResultSchema,
  accumulateEntryDrafts,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
  draftToEntryPayload,
  fieldsFromPairs,
  findMentionedEntries,
  normalizeEntryName,
  type ExtractEntry,
} from './extractSettings';

function category(id: string, name: string, fieldTemplate = CHARACTER_FIELDS): Category {
  return CategorySchema.parse({
    id,
    novelId: 'n1',
    name,
    fieldTemplate,
    createdAt: 0,
    updatedAt: 0,
  });
}

const CHAR = category('cat-char', '人物', CHARACTER_FIELDS);
const WORLD = category('cat-world', '世界观设定', WORLDBUILDING_FIELDS);
const CATEGORIES = [WORLD, CHAR];

function entry(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    id,
    novelId: 'n1',
    categoryId: CHAR.id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function chapter(overrides: Partial<Chapter> = {}): Chapter {
  return ChapterSchema.parse({
    id: 'ch1',
    novelId: 'n1',
    index: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

const NOVEL = NovelSchema.parse({
  id: 'n1',
  title: '归墟',
  genre: '仙侠',
  oneLiner: '一个少年为寻母远赴归墟。',
  createdAt: 0,
  updatedAt: 0,
});

function extracted(overrides: Partial<ExtractEntry> = {}): ExtractEntry {
  return {
    categoryName: '人物',
    title: '沈砚',
    aliases: [],
    summary: '',
    fields: [],
    ...overrides,
  };
}

describe('输出 schema', () => {
  const valid = {
    entries: [
      {
        categoryName: '人物',
        title: '沈砚',
        aliases: ['砚哥'],
        summary: '寻母的少年',
        fields: [{ key: 'identity', value: '十七岁，渔村出身' }],
      },
    ],
    summary: '沈砚离乡。',
    keyEvents: ['沈砚发现玉佩'],
    appearingEntries: ['沈砚'],
    newOpenThreads: ['玉佩的来历'],
    resolvedThreads: [],
    rollingSummary: '沈砚离乡北上。',
  };

  it('接受完整输出', () => {
    const parsed = ExtractResultSchema.parse(valid);
    expect(parsed.entries[0]?.fields[0]).toEqual({ key: 'identity', value: '十七岁，渔村出身' });
  });

  it('entries 允许为空：有些章节确实不提供任何新设定', () => {
    expect(ExtractResultSchema.parse({ ...valid, entries: [] }).entries).toEqual([]);
  });

  it('摘要与全书进展不能为空', () => {
    expect(ExtractResultSchema.safeParse({ ...valid, summary: '' }).success).toBe(false);
    expect(ExtractResultSchema.safeParse({ ...valid, rollingSummary: '' }).success).toBe(false);
  });

  it('fields 是键值对数组而不是对象：strict 模式下 record 会被拒', () => {
    const asRecord = { ...valid, entries: [{ ...valid.entries[0]!, fields: { identity: 'x' } }] };
    expect(ExtractResultSchema.safeParse(asRecord).success).toBe(false);
  });
});

describe('本地预筛涉及条目', () => {
  const content = '沈砚握紧玉佩，想起阿姐说过的话。';

  it('按名称子串命中', () => {
    const entries = [entry('e1', { title: '沈砚' }), entry('e2', { title: '裴照' })];
    expect(findMentionedEntries(content, entries).map((e) => e.title)).toEqual(['沈砚']);
  });

  it('按别名命中', () => {
    const entries = [entry('e1', { title: '沈昭', aliases: ['阿姐'] })];
    expect(findMentionedEntries(content, entries)).toHaveLength(1);
  });

  it('pinned 条目无条件包含，避免模型自己发明世界观规则', () => {
    const entries = [
      entry('e1', { title: '灵潮', categoryId: WORLD.id, pinned: true }),
      entry('e2', { title: '裴照' }),
    ];
    expect(findMentionedEntries(content, entries).map((e) => e.title)).toEqual(['灵潮']);
  });

  it('大小写无关', () => {
    const entries = [entry('e1', { title: 'Shen Yan' })];
    expect(findMentionedEntries('shen yan walked away.', entries)).toHaveLength(1);
  });
});

describe('提示词', () => {
  it('系统提示列出每个分类的字段键与 hint', () => {
    const prompt = buildExtractSystemPrompt(NOVEL, CATEGORIES);
    expect(prompt).toContain('归墟');
    expect(prompt).toContain('分类「人物」的 fields 可用键');
    expect(prompt).toContain('分类「世界观设定」的 fields 可用键');
    expect(prompt).toContain('identity（身份）');
    expect(prompt).toContain(CHARACTER_FIELDS[0]!.hint);
  });

  it('系统提示明确要求输出整合后的完整字段（合并契约的前提）', () => {
    expect(buildExtractSystemPrompt(NOVEL, CATEGORIES)).toContain('整合后的完整字段');
  });

  it('系统提示不带文风段落：提取是理解任务', () => {
    const prompt = buildExtractSystemPrompt(NOVEL, CATEGORIES);
    expect(prompt).not.toContain('【文风】');
    expect(prompt).not.toContain('【结构方法】');
  });

  it('同样输入逐字节可复现，才能命中 prompt 缓存', () => {
    expect(buildExtractSystemPrompt(NOVEL, CATEGORIES)).toBe(
      buildExtractSystemPrompt(NOVEL, CATEGORIES),
    );
  });

  it('没有分类时也能组装出提示', () => {
    const prompt = buildExtractSystemPrompt(NOVEL, []);
    expect(prompt).toContain('【任务】');
  });

  it('分类没有自定义字段时给出明确指示', () => {
    expect(buildExtractSystemPrompt(NOVEL, [category('c9', '杂项', [])])).toContain(
      'fields 给空数组',
    );
  });

  it('用户提示展开涉及条目的完整现有内容', () => {
    const prompt = buildExtractUserPrompt({
      chapter: chapter({ title: '离乡', content: '沈砚上了船。' }),
      mentionedEntries: [
        entry('e1', {
          title: '沈砚',
          aliases: ['砚哥'],
          summary: '寻母的少年',
          fields: { identity: '十七岁', personality: '嘴硬心软' },
        }),
      ],
      categories: CATEGORIES,
      otherEntryNames: ['裴照'],
      openThreads: ['玉佩的来历'],
      rollingSummary: '故事开篇。',
    });

    expect(prompt).toContain('名称：沈砚（分类「人物」）');
    expect(prompt).toContain('别名：砚哥');
    expect(prompt).toContain('identity：十七岁');
    expect(prompt).toContain('personality：嘴硬心软');
    expect(prompt).toContain('【已有条目名称】\n裴照');
    expect(prompt).toContain('【当前未收束的伏笔】');
    expect(prompt).toContain('【此前的全书进展摘要】\n故事开篇。');
    expect(prompt).toContain('【本章正文（第 1 章 离乡）】\n沈砚上了船。');
  });

  it('条目字段按模板顺序输出，与对象键顺序无关', () => {
    const base = {
      chapter: chapter({ content: '正文' }),
      categories: CATEGORIES,
      otherEntryNames: [],
      openThreads: [],
      rollingSummary: '',
    };
    const a = buildExtractUserPrompt({
      ...base,
      mentionedEntries: [entry('e1', { fields: { identity: 'A', personality: 'B' } })],
    });
    const b = buildExtractUserPrompt({
      ...base,
      mentionedEntries: [entry('e1', { fields: { personality: 'B', identity: 'A' } })],
    });
    expect(a).toBe(b);
  });

  it('知识库为空时提示模型给空数组，而不是让它自由发挥', () => {
    const prompt = buildExtractUserPrompt({
      chapter: chapter({ content: '正文' }),
      mentionedEntries: [],
      categories: CATEGORIES,
      otherEntryNames: [],
      openThreads: [],
      rollingSummary: '',
    });
    expect(prompt).toContain('appearingEntries 请给空数组');
    expect(prompt).not.toContain('【本章涉及的已有条目');
    expect(prompt).not.toContain('【当前未收束的伏笔】');
  });

  it('给了来源标签时正文块标成设定文本，不冒充章节', () => {
    const prompt = buildExtractUserPrompt({
      chapter: { index: 1, title: '', content: '灵潮每逢子夜涨落。' },
      sourceLabel: '世界观设定',
      mentionedEntries: [],
      categories: CATEGORIES,
      otherEntryNames: [],
      openThreads: [],
      rollingSummary: '',
    });
    expect(prompt).toContain('【设定文本（世界观设定）】\n灵潮每逢子夜涨落。');
    expect(prompt).not.toContain('本章正文');
  });

  it('不给来源标签时仍是原来的章节正文块', () => {
    const prompt = buildExtractUserPrompt({
      chapter: chapter({ index: 3, title: '灵潮', content: '正文' }),
      mentionedEntries: [],
      categories: CATEGORIES,
      otherEntryNames: [],
      openThreads: [],
      rollingSummary: '',
    });
    expect(prompt).toContain('【本章正文（第 3 章 灵潮）】\n正文');
    expect(prompt).not.toContain('【设定文本');
  });

  describe('外传导入', () => {
    const base = {
      chapter: chapter({ index: 2, title: '雪夜', content: '少年沈砚初入青冥宗。' }),
      mentionedEntries: [],
      categories: CATEGORIES,
      otherEntryNames: [],
      openThreads: [],
      rollingSummary: '沈砚拜入山门。',
    };

    it('有外传说明与「外传进展摘要」标题，说明在正文之前', () => {
      const prompt = buildExtractUserPrompt({
        ...base,
        sideStory: { title: '青冥旧事', synopsis: '主线二十年前，沈砚的少年时代。' },
      });
      expect(prompt).toContain('【此前的外传进展摘要】\n沈砚拜入山门。');
      expect(prompt).not.toContain('【此前的全书进展摘要】');
      expect(prompt).toContain(
        '本批正文是外传《青冥旧事》（简介：主线二十年前，沈砚的少年时代。），独立于主线。rollingSummary 只写这部外传自身的进展；条目字段写长期成立的事实，外传里某一时期特有的状态（如当年的身份）要写明时期，不要当成现状。',
      );
      expect(prompt.indexOf('本批正文是外传')).toBeLessThan(prompt.indexOf('【本章正文'));
      expect(prompt).toContain('【本章正文（第 2 章 雪夜）】\n少年沈砚初入青冥宗。');
    });

    it('简介为空时省掉括号整段，没有空括号', () => {
      const prompt = buildExtractUserPrompt({
        ...base,
        sideStory: { title: '青冥旧事', synopsis: '   ' },
      });
      expect(prompt).toContain('本批正文是外传《青冥旧事》，独立于主线。');
      expect(prompt).not.toContain('（简介');
      expect(prompt).not.toContain('（）');
    });

    it('不传 sideStory 时输出不带任何外传字样', () => {
      const prompt = buildExtractUserPrompt(base);
      expect(prompt).toContain('【此前的全书进展摘要】\n沈砚拜入山门。');
      expect(prompt).not.toContain('外传');
    });
  });
});

describe('字段键值对收敛', () => {
  it('丢弃模板外的键：条目编辑器里没有对应表单', () => {
    const fields = fieldsFromPairs(
      [
        { key: 'identity', value: '十七岁' },
        { key: '战斗力', value: '五' },
      ],
      CHARACTER_FIELDS,
    );
    expect(fields).toEqual({ identity: '十七岁' });
  });

  it('丢弃空值并去掉首尾空白', () => {
    expect(
      fieldsFromPairs(
        [
          { key: ' identity ', value: ' 十七岁 ' },
          { key: 'goal', value: '   ' },
        ],
        CHARACTER_FIELDS,
      ),
    ).toEqual({ identity: '十七岁' });
  });
});

describe('跨章条目草稿累计', () => {
  it('来源不是章节时（世界观导入）新建与合并都不记溯源章节', () => {
    const first = accumulateEntryDrafts([], [extracted({ summary: '少年' })], CATEGORIES, null);
    expect(first[0]?.sourceChapterIds).toEqual([]);

    const merged = accumulateEntryDrafts(
      first,
      [extracted({ fields: [{ key: 'goal', value: '寻母' }] })],
      CATEGORIES,
      null,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sourceChapterIds).toEqual([]);
    expect(merged[0]?.fields).toEqual({ goal: '寻母' });

    // 与章节来源混用时只保留真实章节 id
    const mixed = accumulateEntryDrafts(merged, [extracted()], CATEGORIES, 'ch2');
    expect(mixed[0]?.sourceChapterIds).toEqual(['ch2']);
  });

  it('新名称追加为新草稿', () => {
    const drafts = accumulateEntryDrafts(
      [],
      [extracted({ aliases: ['砚哥'], summary: '少年', fields: [{ key: 'goal', value: '寻母' }] })],
      CATEGORIES,
      'ch1',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      key: '沈砚',
      categoryId: CHAR.id,
      title: '沈砚',
      aliases: ['砚哥'],
      summary: '少年',
      fields: { goal: '寻母' },
      sourceChapterIds: ['ch1'],
    });
  });

  it('同名条目在后续章节合并而不是新增', () => {
    const first = accumulateEntryDrafts(
      [],
      [extracted({ aliases: ['砚哥'], fields: [{ key: 'goal', value: '寻母' }] })],
      CATEGORIES,
      'ch1',
    );
    const second = accumulateEntryDrafts(
      first,
      [extracted({ aliases: ['小砚'], fields: [{ key: 'flaw', value: '怕水' }] })],
      CATEGORIES,
      'ch2',
    );

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      aliases: ['砚哥', '小砚'],
      fields: { goal: '寻母', flaw: '怕水' },
      sourceChapterIds: ['ch1', 'ch2'],
    });
  });

  it('新值非空则覆盖，新值为空则保留原值', () => {
    const first = accumulateEntryDrafts(
      [],
      [extracted({ summary: '少年', fields: [{ key: 'goal', value: '寻母' }] })],
      CATEGORIES,
      'ch1',
    );
    const second = accumulateEntryDrafts(
      first,
      [extracted({ summary: '', fields: [{ key: 'goal', value: '寻母并复仇' }] })],
      CATEGORIES,
      'ch2',
    );
    expect(second[0]?.summary).toBe('少年');
    expect(second[0]?.fields.goal).toBe('寻母并复仇');
  });

  it('同一章重复出现同名条目也只累计成一条', () => {
    const drafts = accumulateEntryDrafts(
      [],
      [
        extracted({ fields: [{ key: 'goal', value: '寻母' }] }),
        extracted({ fields: [{ key: 'flaw', value: '怕水' }] }),
      ],
      CATEGORIES,
      'ch1',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.sourceChapterIds).toEqual(['ch1']);
    expect(drafts[0]?.fields).toEqual({ goal: '寻母', flaw: '怕水' });
  });

  it('名称只差大小写与空白时视为同一条', () => {
    const first = accumulateEntryDrafts([], [extracted({ title: 'Shen Yan' })], CATEGORIES, 'ch1');
    const second = accumulateEntryDrafts(
      first,
      [extracted({ title: '  shen yan ' })],
      CATEGORIES,
      'ch2',
    );
    expect(second).toHaveLength(1);
    // 标题沿用首次出现的写法，不被后续大小写差异改写
    expect(second[0]?.title).toBe('Shen Yan');
  });

  it('分类名对不上的条目整条丢弃，避免字段模板错位', () => {
    const drafts = accumulateEntryDrafts(
      [],
      [extracted({ categoryName: '妖兽图鉴' }), extracted({ title: '裴照' })],
      CATEGORIES,
      'ch1',
    );
    expect(drafts.map((d) => d.title)).toEqual(['裴照']);
  });

  it('标题为空的条目丢弃', () => {
    expect(accumulateEntryDrafts([], [extracted({ title: '  ' })], CATEGORIES, 'ch1')).toEqual([]);
  });

  it('不修改传入的既有草稿数组', () => {
    const existing: ImportEntryDraft[] = [
      {
        key: '沈砚',
        categoryId: CHAR.id,
        title: '沈砚',
        aliases: [],
        summary: '少年',
        fields: {},
        sourceChapterIds: ['ch1'],
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(existing));
    accumulateEntryDrafts(existing, [extracted({ summary: '青年' })], CATEGORIES, 'ch2');
    expect(existing).toEqual(snapshot);
  });
});

describe('草稿转提案 payload', () => {
  it('只带条目字段，不带累计用的 key', () => {
    const payload = draftToEntryPayload({
      key: '沈砚',
      categoryId: CHAR.id,
      title: '沈砚',
      aliases: ['砚哥'],
      summary: '少年',
      fields: { goal: '寻母' },
      sourceChapterIds: ['ch1', 'ch2'],
    });
    expect(payload).toEqual({
      categoryId: CHAR.id,
      title: '沈砚',
      aliases: ['砚哥'],
      summary: '少年',
      fields: { goal: '寻母' },
      sourceChapterIds: ['ch1', 'ch2'],
    });
    expect('key' in payload).toBe(false);
  });
});

describe('名称归一化', () => {
  it('与仓储 findEntryByName 同一口径', () => {
    expect(normalizeEntryName('  Shen Yan ')).toBe('shen yan');
  });
});

describe('译文稿件的专名溯源', () => {
  it('要求把外文原名也放进 aliases', () => {
    const prompt = buildExtractSystemPrompt(NOVEL, CATEGORIES);
    // 条目里留着原文名，后续导入的外文素材才认得出这是同一个对象；
    // 单章翻译也能从别名反推出已确认的译名
    expect(prompt).toContain('外文原名也放进 aliases');
    expect(prompt).toContain('Ashford');
  });

  it('外文原名作为别名能被本地预筛匹配到', () => {
    const entries = [
      entry('e1', { title: '阿什福德', aliases: ['Ashford'] }),
      entry('e2', { title: '裴照' }),
    ];
    // 第二批外文素材里出现 Ashford 时，不该被当成一个全新的人物
    expect(
      findMentionedEntries('Ashford waited at the ferry.', entries).map((e) => e.title),
    ).toEqual(['阿什福德']);
  });
});

describe('写作规范', () => {
  function norm(overrides: Partial<WritingNorm> = {}): WritingNorm {
    return WritingNormSchema.parse({
      id: 'norm-1',
      novelId: 'n1',
      title: '使用提示',
      content: '- 阶段性称号不新增为人物条目。【标记 X】',
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    });
  }

  it('作用范围含提取设定时带上规范与禁止提取的那句，位于作品信息之后、任务说明之前', () => {
    const prompt = buildExtractSystemPrompt(NOVEL, CATEGORIES, [norm()]);
    const at = prompt.indexOf('【作者的写作规范】');

    expect(prompt).toContain('【标记 X】');
    expect(prompt).toContain('不要从规范里提取条目');
    expect(at).toBeGreaterThan(prompt.indexOf('【作品信息】'));
    expect(at).toBeLessThan(prompt.indexOf('【任务】'));
  });

  it('作用范围不含提取设定或已停用时不带，与不传完全相同', () => {
    const base = buildExtractSystemPrompt(NOVEL, CATEGORIES);

    expect(buildExtractSystemPrompt(NOVEL, CATEGORIES, [norm({ scopes: ['writing'] })])).toBe(base);
    expect(buildExtractSystemPrompt(NOVEL, CATEGORIES, [norm({ enabled: false })])).toBe(base);
    expect(base).not.toContain('不要从规范里提取条目');
  });
});
