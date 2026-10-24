import { describe, expect, it } from 'vitest';
import { renderEntry, renderSummary } from '@/context/SummaryChainContextBuilder';
import { CHARACTER_FIELDS, WORLDBUILDING_FIELDS } from '@/domain/defaults';
import {
  CategorySchema,
  ChapterSchema,
  ChapterSummarySchema,
  KnowledgeEntrySchema,
  NovelSchema,
  WritingNormSchema,
  type Chapter,
  type WritingNorm,
} from '@/domain/schema';
import { normsInScope } from '@/domain/writingNorm';
import {
  NORM_CHECK_SEGMENT_CHARS,
  NORM_CHECK_TASK,
  NormCheckResultSchema,
  buildNormCheckSystemPrompt,
  buildNormCheckUserPrompt,
  displayNormTitle,
  locateQuote,
  previousForCheck,
  resolveCheckIssues,
  splitChapterForCheck,
  type NormCheckIssue,
} from './normCheck';

// ---------------------------------------------------------------- 夹具

const novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  pov: 'third-limited',
  oneLiner: '失忆剑客发现自己是灭门案凶手。',
  createdAt: 0,
  updatedAt: 0,
});

const worldCategory = CategorySchema.parse({
  id: 'c-world',
  novelId: 'n1',
  name: '世界观设定',
  kind: 'worldbuilding',
  builtin: true,
  fieldTemplate: WORLDBUILDING_FIELDS,
  order: 0,
  createdAt: 0,
  updatedAt: 0,
});
const charCategory = CategorySchema.parse({
  id: 'c-char',
  novelId: 'n1',
  name: '人物',
  kind: 'character',
  builtin: true,
  fieldTemplate: CHARACTER_FIELDS,
  order: 1,
  createdAt: 0,
  updatedAt: 0,
});
const categories = [worldCategory, charCategory];

const lingqi = KnowledgeEntrySchema.parse({
  id: 'e-lingqi',
  novelId: 'n1',
  categoryId: worldCategory.id,
  title: '灵气',
  summary: '天地间流转的能量。',
  pinned: true,
  createdAt: 0,
  updatedAt: 0,
});
const guixu = KnowledgeEntrySchema.parse({
  id: 'e-guixu',
  novelId: 'n1',
  categoryId: worldCategory.id,
  title: '归墟',
  summary: '万水归处，入者不返。',
  pinned: true,
  createdAt: 0,
  updatedAt: 0,
});
const peizhao = KnowledgeEntrySchema.parse({
  id: 'e-peizhao',
  novelId: 'n1',
  categoryId: charCategory.id,
  title: '裴照',
  summary: '六扇门捕头。',
  createdAt: 0,
  updatedAt: 0,
});

function norm(id: string, overrides: Partial<WritingNorm> = {}): WritingNorm {
  return WritingNormSchema.parse({
    id,
    novelId: 'n1',
    title: `规范${id}`,
    content: `规范${id}的正文。`,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function chapter(index: number, overrides: Partial<Chapter> = {}): Chapter {
  return ChapterSchema.parse({
    id: `ch${index}`,
    novelId: 'n1',
    index,
    title: `第${index}章`,
    content: `第 ${index} 章正文。`,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function summary(chapterId: string, text: string, openThreads: string[] = []) {
  return ChapterSummarySchema.parse({
    id: `s-${chapterId}`,
    novelId: 'n1',
    chapterId,
    summary: text,
    keyEvents: ['遭遇追兵'],
    openThreads,
    createdAt: 0,
    updatedAt: 0,
  });
}

function issue(overrides: Partial<NormCheckIssue> = {}): NormCheckIssue {
  return {
    normTitle: '使用提示',
    rule: '不得提前使用后期装备。',
    quote: '',
    problem: '问题说明。',
    suggestion: '',
    severity: 'possible',
    ...overrides,
  };
}

// ---------------------------------------------------------------- 系统提示

describe('buildNormCheckSystemPrompt', () => {
  const checkNorm = norm('a', { title: '使用提示', content: '检查规范的正文【标记 A】' });
  const disabled = norm('b', { content: '停用的规范【标记 B】', enabled: false });
  const writingOnly = norm('c', { content: '只写正文的规范【标记 C】', scopes: ['writing'] });

  it('含作用范围含 check 的规范与核心设定，不含停用的与作用范围外的', () => {
    const system = buildNormCheckSystemPrompt(
      novel,
      [checkNorm, disabled, writingOnly],
      [lingqi],
      categories,
    );
    expect(system).toContain('【标记 A】');
    expect(system).toContain('审读时逐条对照这些规范');
    expect(system).toContain('【核心设定（供判断，不是检查对象）】');
    expect(system).toContain(renderEntry(lingqi, categories));
    expect(system).not.toContain('【标记 B】');
    expect(system).not.toContain('【标记 C】');
    expect(system.startsWith('你是一位严谨的小说责任编辑')).toBe(true);
    expect(system.endsWith(NORM_CHECK_TASK)).toBe(true);
  });

  it('块的顺序：作品信息 → 规范 → 核心设定 → 任务', () => {
    const system = buildNormCheckSystemPrompt(novel, [checkNorm], [lingqi], categories);
    const meta = system.indexOf('【作品信息】');
    const norms = system.indexOf('【作者的写作规范】');
    const pinned = system.indexOf('【核心设定（供判断，不是检查对象）】');
    const task = system.indexOf('【任务】');
    expect(meta).toBeGreaterThan(0);
    expect(norms).toBeGreaterThan(meta);
    expect(pinned).toBeGreaterThan(norms);
    expect(task).toBeGreaterThan(pinned);
  });

  it('两条核心设定按传入顺序，之间恰好一个空行', () => {
    const system = buildNormCheckSystemPrompt(novel, [checkNorm], [guixu, lingqi], categories);
    expect(system).toContain(
      [
        '【核心设定（供判断，不是检查对象）】',
        renderEntry(guixu, categories),
        renderEntry(lingqi, categories),
      ].join('\n\n'),
    );
    expect(system.indexOf('## 归墟')).toBeLessThan(system.indexOf('## 灵气'));
  });

  it('没有核心设定时省略该块', () => {
    const system = buildNormCheckSystemPrompt(novel, [checkNorm], [], categories);
    expect(system).not.toContain('【核心设定');
  });

  it('不含风格档案，两次调用逐字节相同', () => {
    const a = buildNormCheckSystemPrompt(novel, [checkNorm], [lingqi], categories);
    const b = buildNormCheckSystemPrompt(novel, [checkNorm], [lingqi], categories);
    expect(a).toBe(b);
    expect(a).not.toContain('【文风】');
    expect(a).not.toContain('【文体取向】');
  });
});

// ---------------------------------------------------------------- 用户提示

describe('buildNormCheckUserPrompt', () => {
  const ch3 = chapter(3);
  const ch3Summary = summary('ch3', '主角负伤逃入雪山。', ['黑衣人的身份']);

  it('正文在末尾；有相关条目时带【相关设定】；前情块紧跟 renderSummary 输出', () => {
    const prompt = buildNormCheckUserPrompt({
      chapterLabel: '第 4 章',
      segment: { index: 0, total: 1, text: '裴照推门进来。\n\n' },
      mentionedEntries: [peizhao],
      categories,
      previous: { chapter: ch3, summary: ch3Summary },
    });

    expect(prompt.startsWith(`【相关设定】\n${renderEntry(peizhao, categories)}`)).toBe(true);
    expect(prompt).toContain(
      `【此前最近一章（第 3 章）的摘要】\n${renderSummary(ch3, ch3Summary)}`,
    );
    expect(prompt).toContain('尚未收束的伏笔：黑衣人的身份');
    // 单段送进提示时 trimEnd，且是最后一块
    expect(prompt.endsWith('【待检查的正文（第 4 章）】\n裴照推门进来。')).toBe(true);
    expect(prompt).not.toContain('只检查这一段');
  });

  it('多个相关条目之间空一行', () => {
    const prompt = buildNormCheckUserPrompt({
      chapterLabel: '第 4 章',
      segment: { index: 0, total: 1, text: '正文' },
      mentionedEntries: [peizhao, lingqi],
      categories,
    });
    expect(prompt).toContain(
      `【相关设定】\n${renderEntry(peizhao, categories)}\n\n${renderEntry(lingqi, categories)}`,
    );
  });

  it('没有条目与前情时只有正文块', () => {
    const prompt = buildNormCheckUserPrompt({
      chapterLabel: '第 1 章',
      segment: { index: 0, total: 1, text: '正文' },
      mentionedEntries: [],
      categories,
    });
    expect(prompt).toBe('【待检查的正文（第 1 章）】\n正文');
  });

  it('外传章节的前情标题为「外传第 N 章」', () => {
    const side = chapter(2, { id: 'side-2', sideStoryId: 'side-a' });
    const prompt = buildNormCheckUserPrompt({
      chapterLabel: '外传·青冥旧事 第 3 章',
      segment: { index: 0, total: 1, text: '正文' },
      mentionedEntries: [],
      categories,
      previous: { chapter: side, summary: summary('side-2', '师父拜入青冥宗。') },
    });
    expect(prompt).toContain('【此前最近一章（外传第 2 章）的摘要】');
    expect(prompt).toContain('【待检查的正文（外传·青冥旧事 第 3 章）】');
  });

  it('分段时标签为「第 i/n 段」并带分段说明', () => {
    const prompt = buildNormCheckUserPrompt({
      chapterLabel: '第 4 章',
      segment: { index: 1, total: 3, text: '第二段正文' },
      mentionedEntries: [],
      categories,
    });
    expect(prompt).toContain('只检查这一段');
    expect(prompt.endsWith('【待检查的正文（第 4 章 · 第 2/3 段）】\n第二段正文')).toBe(true);
  });

  it('前情选取：第 2 章无摘要时承接第 1 章，块标题是「第 1 章」', () => {
    const chapters = [chapter(1), chapter(2), chapter(3)];
    const summaries = [summary('ch1', '第一章的事。')];
    const previous = previousForCheck(chapters, summaries, 'ch3');
    expect(previous?.chapter.id).toBe('ch1');

    const prompt = buildNormCheckUserPrompt({
      chapterLabel: '第 3 章',
      segment: { index: 0, total: 1, text: '正文' },
      mentionedEntries: [],
      categories,
      ...(previous ? { previous } : {}),
    });
    expect(prompt).toContain('【此前最近一章（第 1 章）的摘要】\n第 1 章 第1章\n第一章的事。');
  });

  it('previousForCheck：第一章没有前情；外传只承接同一部外传', () => {
    const chapters = [
      chapter(1),
      chapter(2),
      chapter(1, { id: 'side-1', sideStoryId: 'side-a' }),
      chapter(2, { id: 'side-2', sideStoryId: 'side-a' }),
    ];
    const summaries = [summary('ch1', '主线'), summary('side-1', '外传')];
    expect(previousForCheck(chapters, summaries, 'ch1')).toBeUndefined();
    expect(previousForCheck(chapters, summaries, 'side-2')?.chapter.id).toBe('side-1');
  });
});

// ---------------------------------------------------------------- 原句定位

describe('locateQuote', () => {
  it('精确命中，多次出现取第一次', () => {
    const content = '他推开门。雨很大。他推开门。';
    expect(locateQuote(content, '他推开门。')).toEqual({ start: 0, end: 5 });
    expect(locateQuote(content, '雨很大')).toEqual({ start: 5, end: 8 });
  });

  it('跨行原句：覆盖整句，含中间的换行与全角空格，首尾不多带空白', () => {
    const content = '甲。他推开门，\n　　走进雨里。乙';
    const range = locateQuote(content, '他推开门，走进雨里。');
    expect(range).not.toBeNull();
    expect(content.slice(range!.start, range!.end)).toBe('他推开门，\n　　走进雨里。');
  });

  it('quote 自带空白而正文没有也命中', () => {
    const content = '他推开门';
    const range = locateQuote(content, '他推开 门');
    expect(range).toEqual({ start: 0, end: 4 });
  });

  it('找不到返回 null', () => {
    expect(locateQuote('他推开门', '她关上窗')).toBeNull();
  });

  it('空串与只有空白的 quote 返回 null', () => {
    expect(locateQuote('他推开门', '')).toBeNull();
    expect(locateQuote('他推开门 \u3000\n', ' \u3000\n')).toBeNull();
  });
});

// ---------------------------------------------------------------- 结果整理

describe('resolveCheckIssues', () => {
  const tip = norm('tip', { title: '使用提示' });
  const quoted = norm('quoted', { title: '《某作》', order: 1 });

  it('规范名原样或去一层书名号都能匹配', () => {
    const resolved = resolveCheckIssues(
      [
        {
          segmentIndex: 0,
          issues: [
            issue({ normTitle: '使用提示' }),
            issue({ normTitle: ' 《使用提示》 ' }),
            issue({ normTitle: '《某作》' }),
          ],
        },
      ],
      [tip, quoted],
      '',
    );
    expect(resolved.map((item) => item.normId)).toEqual(['tip', 'tip', 'quoted']);
    expect(resolved.map((item) => item.key)).toEqual(['0-0', '0-1', '0-2']);
  });

  it('小节标题匹配不上为 null，但条目保留', () => {
    const resolved = resolveCheckIssues(
      [{ segmentIndex: 0, issues: [issue({ normTitle: '写作规则' })] }],
      [tip],
      '',
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.normId).toBeNull();
  });

  it('同名两份时取排序最前的那份', () => {
    const later = norm('later', { title: '使用提示', order: 5 });
    const earlier = norm('earlier', { title: '使用提示', order: 1 });
    const injected = normsInScope([later, earlier], 'check');
    const resolved = resolveCheckIssues(
      [{ segmentIndex: 0, issues: [issue({ normTitle: '使用提示' })] }],
      injected,
      '',
    );
    expect(resolved[0]?.normId).toBe('earlier');
  });

  it('传入的 norms 不含的规范（被临时取消）不匹配', () => {
    const resolved = resolveCheckIssues(
      [{ segmentIndex: 0, issues: [issue({ normTitle: '使用提示' })] }],
      [quoted],
      '',
    );
    expect(resolved[0]?.normId).toBeNull();
  });

  it('排序：严重程度 → 原句位置（定位不到为 Infinity）→ 段号 → 段内下标', () => {
    const content = '甲句在前。乙句在后。';
    const resolved = resolveCheckIssues(
      [
        {
          segmentIndex: 1,
          issues: [
            // 同为 possible、都定位不到、段号 1：按段内下标
            issue({ severity: 'possible', problem: 'p-seg1-i0' }),
            issue({ severity: 'possible', problem: 'p-seg1-i1' }),
            issue({ severity: 'judgement', problem: 'judgement' }),
          ],
        },
        {
          segmentIndex: 0,
          issues: [
            issue({ severity: 'possible', quote: '乙句在后', problem: 'p-乙' }),
            issue({ severity: 'possible', quote: '甲句在前', problem: 'p-甲' }),
            // 定位不到、段号 0：排在段号 1 的同级条目之前
            issue({ severity: 'possible', problem: 'p-seg0' }),
            issue({ severity: 'violation', quote: '乙句在后', problem: 'violation' }),
          ],
        },
      ],
      [tip],
      content,
    );
    expect(resolved.map((item) => item.problem)).toEqual([
      'violation',
      'p-甲',
      'p-乙',
      'p-seg0',
      'p-seg1-i0',
      'p-seg1-i1',
      'judgement',
    ]);
  });

  it('displayNormTitle 去掉模型自带的外层书名号', () => {
    expect(displayNormTitle(' 《使用提示》 ')).toBe('使用提示');
    expect(displayNormTitle('使用提示')).toBe('使用提示');
  });
});

// ---------------------------------------------------------------- 分段

describe('splitChapterForCheck', () => {
  function check(content: string, max: number) {
    const segments = splitChapterForCheck(content, max);
    expect(segments.join('')).toBe(content);
    for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(max);
    return segments;
  }

  it('空串返回 []', () => {
    expect(splitChapterForCheck('')).toEqual([]);
  });

  it('不超过上限返回 [content]', () => {
    expect(check('短章。\n第二行。', 20)).toEqual(['短章。\n第二行。']);
    expect(splitChapterForCheck('一'.repeat(NORM_CHECK_SEGMENT_CHARS))).toHaveLength(1);
  });

  it('长章按行切，行尾 \\n 留在前一段末尾', () => {
    const content = '一二三四。\n五六七八。\n九十。\n';
    const segments = check(content, 12);
    expect(segments).toEqual(['一二三四。\n五六七八。\n', '九十。\n']);
  });

  it('单行超长在句号处切，句号留在前一段', () => {
    const content = '甲乙丙。丁戊己庚辛。壬癸';
    const segments = check(content, 8);
    expect(segments[0]).toBe('甲乙丙。');
    expect(segments[0]!.endsWith('。')).toBe(true);
  });

  it('感叹号与问号也是切分点', () => {
    const segments = check('甲乙！丙丁？戊己庚辛', 7);
    expect(segments[0]).toBe('甲乙！丙丁？');
  });

  it('没有标点时在 max 处硬切', () => {
    const content = '一'.repeat(25);
    const segments = check(content, 10);
    expect(segments.map((segment) => segment.length)).toEqual([10, 10, 5]);
  });

  it('超长行的余下部分与后续行继续打包', () => {
    const content = `${'一'.repeat(12)}\n短行。\n`;
    const segments = check(content, 10);
    expect(segments).toEqual(['一'.repeat(10), `${'一'.repeat(2)}\n短行。\n`]);
  });
});

describe('NormCheckResultSchema', () => {
  it('所有字段必填；空 issues 合法', () => {
    expect(NormCheckResultSchema.safeParse({ issues: [] }).success).toBe(true);
    expect(
      NormCheckResultSchema.safeParse({ issues: [{ normTitle: 'x', rule: 'y', problem: 'z' }] })
        .success,
    ).toBe(false);
  });
});
