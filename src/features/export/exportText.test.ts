import { describe, expect, it } from 'vitest';
import {
  ChapterSchema,
  NovelSchema,
  SideStorySchema,
  type Chapter,
  type Novel,
} from '@/domain/schema';
import {
  chapterHeading,
  exportFileName,
  exportStats,
  formatChapter,
  formatNovel,
  formatSideStory,
} from './exportText';

function chapter(index: number, overrides: Partial<Chapter> = {}): Chapter {
  return ChapterSchema.parse({
    id: `ch${index}`,
    novelId: 'n1',
    index,
    content: `第 ${index} 章的正文。`,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function novel(overrides: Partial<Novel> = {}): Novel {
  return NovelSchema.parse({
    id: 'n1',
    title: '归墟纪',
    genre: '仙侠',
    oneLiner: '一个少年为寻母远赴归墟。',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

describe('章节标题', () => {
  it('没填标题时退回「第 N 章」，不导出空标题行', () => {
    expect(chapterHeading(chapter(3, { title: '' }))).toBe('第 3 章');
    expect(chapterHeading(chapter(3, { title: '  灵潮  ' }))).toBe('灵潮');
  });
});

describe('单章导出', () => {
  it('Markdown 用二级标题', () => {
    expect(formatChapter(chapter(1, { title: '离乡', content: '天还没亮。' }), 'markdown')).toBe(
      '## 离乡\n\n天还没亮。\n',
    );
  });

  it('纯文本不带标记符号', () => {
    expect(formatChapter(chapter(1, { title: '离乡', content: '天还没亮。' }), 'txt')).toBe(
      '离乡\n\n天还没亮。\n',
    );
  });

  it('空正文只导出标题行', () => {
    expect(formatChapter(chapter(2, { title: '待写', content: '' }), 'markdown')).toBe('## 待写\n');
  });
});

describe('全书导出', () => {
  const chapters = [
    chapter(2, { title: '渡口', content: '雨下了三天。', status: 'done' }),
    chapter(1, { title: '离乡', content: '天还没亮。', status: 'done' }),
    chapter(3, { title: '灵潮', content: '子夜翻涌。', status: 'draft' }),
  ];

  it('按章节序号排序，带书名与元信息', () => {
    const text = formatNovel(novel(), chapters, { format: 'markdown', includeFrontMatter: true });
    expect(text).toBe(
      [
        '# 归墟纪',
        '',
        '体裁：仙侠',
        '故事内核：一个少年为寻母远赴归墟。',
        '',
        '## 离乡',
        '',
        '天还没亮。',
        '',
        '## 渡口',
        '',
        '雨下了三天。',
        '',
        '## 灵潮',
        '',
        '子夜翻涌。',
        '',
      ].join('\n'),
    );
  });

  it('不带元信息时只有书名', () => {
    const text = formatNovel(novel(), [chapters[1]!], { format: 'markdown' });
    expect(text).toBe('# 归墟纪\n\n## 离乡\n\n天还没亮。\n');
  });

  it('只导出已完成时跳过草稿', () => {
    const text = formatNovel(novel(), chapters, { format: 'txt', doneOnly: true });
    expect(text).toContain('离乡');
    expect(text).toContain('渡口');
    expect(text).not.toContain('灵潮');
  });

  it('跳过空章节：目录里凭空多出只有标题的条目没有意义', () => {
    const text = formatNovel(
      novel(),
      [chapters[1]!, chapter(4, { title: '占位', content: '  ' })],
      {
        format: 'markdown',
      },
    );
    expect(text).not.toContain('占位');
  });

  it('书名为空时给出占位名', () => {
    expect(formatNovel(novel({ title: '未命名' }), [], { format: 'txt' })).toBe('未命名\n');
  });

  it('元信息为空的作品不产生空段落', () => {
    const bare = novel({ genre: '', oneLiner: '' });
    expect(formatNovel(bare, [chapters[1]!], { format: 'txt', includeFrontMatter: true })).toBe(
      '归墟纪\n\n离乡\n\n天还没亮。\n',
    );
  });
});

describe('文件名', () => {
  it('全书用书名，单章带章节标题', () => {
    expect(exportFileName(novel(), { kind: 'novel' }, 'markdown')).toBe('归墟纪.md');
    expect(
      exportFileName(novel(), { kind: 'chapter', chapter: chapter(1, { title: '离乡' }) }, 'txt'),
    ).toBe('归墟纪 - 离乡.txt');
  });

  it('剔除文件系统敏感字符', () => {
    expect(exportFileName(novel({ title: 'a/b:c*?"<>|' }), { kind: 'novel' }, 'txt')).toBe(
      'abc.txt',
    );
  });

  it('书名被清空后仍有可用文件名', () => {
    expect(exportFileName(novel({ title: '///' }), { kind: 'novel' }, 'txt')).toBe(
      '未命名作品.txt',
    );
  });
});

describe('体量统计', () => {
  it('统计字符数与行数', () => {
    expect(exportStats('一二\n三四\n')).toEqual({ chars: 5, lines: 2 });
  });

  it('空内容为 0', () => {
    expect(exportStats('   \n ')).toEqual({ chars: 0, lines: 0 });
  });
});

describe('外传', () => {
  const story = SideStorySchema.parse({
    id: 'side-a',
    novelId: 'n1',
    title: '青冥旧事',
    createdAt: 0,
    updatedAt: 0,
  });
  const other = SideStorySchema.parse({
    id: 'side-b',
    novelId: 'n1',
    title: '渡口',
    createdAt: 0,
    updatedAt: 0,
  });
  const main = [
    chapter(2, { title: '渡口', content: '雨下了三天。' }),
    chapter(1, { title: '离乡', content: '天还没亮。' }),
  ];
  const sideChapters = [
    chapter(2, { id: 'a2', sideStoryId: 'side-a', title: '', content: '青冥第二章。' }),
    chapter(1, { id: 'a1', sideStoryId: 'side-a', title: '拜师', content: '青冥第一章。' }),
    chapter(3, {
      id: 'a3',
      sideStoryId: 'side-a',
      title: '草稿',
      content: '未完成。',
      status: 'draft',
    }),
  ];
  const otherChapters = [
    chapter(1, { id: 'b1', sideStoryId: 'side-b', title: '夜渡', content: '渡口夜色。' }),
  ];

  it('formatNovel 默认不含外传，主线输出逐字节不变', () => {
    const withSides = formatNovel(novel(), [...main, ...sideChapters, ...otherChapters], {
      format: 'markdown',
    });
    expect(withSides).toBe(formatNovel(novel(), main, { format: 'markdown' }));
    expect(withSides).toBe('# 归墟纪\n\n## 离乡\n\n天还没亮。\n\n## 渡口\n\n雨下了三天。\n');
  });

  it('sideStories 按顺序追加在主线之后，各章仍是二级标题', () => {
    const text = formatNovel(novel(), main, {
      format: 'markdown',
      sideStories: [
        { story, chapters: sideChapters },
        { story: other, chapters: otherChapters },
      ],
    });
    expect(text).toBe(
      [
        '# 归墟纪',
        '',
        '## 离乡',
        '',
        '天还没亮。',
        '',
        '## 渡口',
        '',
        '雨下了三天。',
        '',
        '# 外传·青冥旧事',
        '',
        '## 拜师',
        '',
        '青冥第一章。',
        '',
        '## 第 2 章',
        '',
        '青冥第二章。',
        '',
        '## 草稿',
        '',
        '未完成。',
        '',
        '# 外传·渡口',
        '',
        '## 夜渡',
        '',
        '渡口夜色。',
        '',
      ].join('\n'),
    );
  });

  it('纯文本的外传标题不带 #，doneOnly 对外传同样生效，没有可导出章节的外传不留标题', () => {
    const text = formatNovel(
      novel(),
      main.map((item) => ({ ...item, status: 'done' as const })),
      {
        format: 'txt',
        doneOnly: true,
        sideStories: [
          {
            story,
            chapters: sideChapters
              .map((item) => ({ ...item, status: 'done' as const }))
              .slice(0, 1),
          },
          { story: other, chapters: otherChapters },
        ],
      },
    );
    expect(text).toContain('\n\n外传·青冥旧事\n\n第 2 章\n\n青冥第二章。\n');
    expect(text).not.toContain('#');
    expect(text).not.toContain('外传·渡口');
  });

  it('formatSideStory 单独导出一部外传，开头是「书名 · 外传·X」', () => {
    // 传入全量章节也只取这部外传；第 3 章是草稿，doneOnly 时跳过
    const done = sideChapters.map((item) =>
      item.status === 'draft' && item.id !== 'a3' ? { ...item, status: 'done' as const } : item,
    );
    const text = formatSideStory(novel(), story, [...main, ...done, ...otherChapters], {
      format: 'markdown',
      doneOnly: true,
    });
    expect(text).toBe(
      '# 归墟纪 · 外传·青冥旧事\n\n## 拜师\n\n青冥第一章。\n\n## 第 2 章\n\n青冥第二章。\n',
    );
    expect(formatSideStory(novel(), story, [], { format: 'txt' })).toBe('归墟纪 · 外传·青冥旧事\n');
  });

  it('无标题的外传第 2 章单章导出：标题和文件名是「外传·X 第 2 章」，与主线第 2 章不同', () => {
    const side2 = sideChapters[0]!;
    const main2 = chapter(2, { title: '' });
    expect(chapterHeading(side2, story)).toBe('外传·青冥旧事 第 2 章');
    expect(chapterHeading(side2)).toBe('第 2 章');
    expect(formatChapter(side2, 'markdown', story)).toBe(
      '## 外传·青冥旧事 第 2 章\n\n青冥第二章。\n',
    );

    const sideName = exportFileName(
      novel(),
      { kind: 'chapter', chapter: side2, sideStory: story },
      'markdown',
    );
    const mainName = exportFileName(novel(), { kind: 'chapter', chapter: main2 }, 'markdown');
    expect(sideName).toBe('归墟纪 - 外传·青冥旧事 第 2 章.md');
    expect(mainName).toBe('归墟纪 - 第 2 章.md');
    expect(sideName).not.toBe(mainName);
  });

  it('外传单章有标题时文件名是「外传·X 第 N 章 标题」，标题行用标题', () => {
    const side1 = sideChapters[1]!;
    expect(chapterHeading(side1, story)).toBe('拜师');
    expect(
      exportFileName(novel(), { kind: 'chapter', chapter: side1, sideStory: story }, 'txt'),
    ).toBe('归墟纪 - 外传·青冥旧事 第 1 章 拜师.txt');
  });

  it('外传 scope 的文件名是「书名 - 外传·X」', () => {
    expect(exportFileName(novel(), { kind: 'side', story }, 'markdown')).toBe(
      '归墟纪 - 外传·青冥旧事.md',
    );
  });
});
