import { describe, expect, it } from 'vitest';
import {
  compileCustomPattern,
  detectChapterHeadings,
  mergeWithPrevious,
  removeChapter,
  renameChapter,
  splitChapters,
  summarizeSplit,
} from './splitChapters';

/** 造一段够长的正文，避免被「开头太短就丢弃」的规则影响 */
function body(marker: string, length = 300): string {
  return `${marker}${'正'.repeat(length)}`;
}

describe('标题识别', () => {
  it.each([
    '第一章',
    '第一章 雪夜',
    '第1章 雪夜',
    '第001章',
    '第十二回 旧识',
    '第三节',
    '第二话',
    'Chapter 1',
    'Chapter 12: Snow',
    '楔子',
    '序章',
    '引子',
    '尾声',
    '终章',
    '后记',
    '番外 一段往事',
  ])('识别「%s」为章节标题', (heading) => {
    const hits = detectChapterHeadings(`${heading}\n${body('内容')}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe(heading);
  });

  it('不把「卷」当成章节标题', () => {
    // 卷是章的上层，切了会产生一堆没有正文的空章
    expect(detectChapterHeadings('第一卷 风起\n第一章 雪夜')).toHaveLength(1);
  });

  it('不把正文里提到章节的句子当成标题', () => {
    const text = '他翻到第三章的时候，忽然停住了，因为那一页写着他自己的名字，墨迹还没干透。';
    expect(detectChapterHeadings(text)).toHaveLength(0);
  });

  it('过长的行不算标题', () => {
    const longLine = `第一章 ${'很长的副标题'.repeat(10)}`;
    expect(detectChapterHeadings(longLine)).toHaveLength(0);
  });

  it('忽略空行与纯空白行', () => {
    expect(detectChapterHeadings('\n\n   \n第一章\n')).toHaveLength(1);
  });
});

describe('自动分章', () => {
  const text = [
    '第一章 雪夜',
    body('追兵临门。'),
    '',
    '第二章 旧识',
    body('雪山遇故人。'),
    '',
    '第三章 归墟',
    body('直面自己。'),
  ].join('\n');

  it('按标题切分并重新编号', () => {
    const chapters = splitChapters(text);

    expect(chapters.map((chapter) => chapter.index)).toEqual([1, 2, 3]);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      '第一章 雪夜',
      '第二章 旧识',
      '第三章 归墟',
    ]);
  });

  it('正文不含标题行本身', () => {
    const chapters = splitChapters(text);
    expect(chapters[0]?.content.startsWith('追兵临门。')).toBe(true);
    expect(chapters[0]?.content).not.toContain('第一章');
  });

  it('统计每章字数', () => {
    const chapters = splitChapters(text);
    expect(chapters[0]?.wordCount).toBeGreaterThan(300);
  });

  it('兼容 CRLF 换行', () => {
    const crlf = '第一章 雪夜\r\n' + body('内容') + '\r\n第二章 旧识\r\n' + body('内容');
    expect(splitChapters(crlf)).toHaveLength(2);
  });

  it('开头有足量正文时保留为一章', () => {
    const withPreamble = `${body('没有标题的开头', 400)}\n第一章 雪夜\n${body('正文')}`;
    const chapters = splitChapters(withPreamble);

    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.title).toBe('（开头部分）');
  });

  it('开头只有书名简介之类的短文本时丢弃', () => {
    const withTitlePage = `归墟纪\n作者：某某\n\n第一章 雪夜\n${body('正文')}`;
    const chapters = splitChapters(withTitlePage);

    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.title).toBe('第一章 雪夜');
  });

  it('丢弃只有标题没有正文的条目', () => {
    const withEmpty = `第一章 雪夜\n\n第二章 旧识\n${body('正文')}`;
    const chapters = splitChapters(withEmpty);

    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.title).toBe('第二章 旧识');
    expect(chapters[0]?.index).toBe(1);
  });

  it('找不到任何标题时整篇作为一章', () => {
    const chapters = splitChapters(body('完全没有标题的一整篇'));
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.title).toBe('');
  });

  it('空文本返回空数组', () => {
    expect(splitChapters('')).toEqual([]);
    expect(splitChapters('   \n\n  ')).toEqual([]);
  });
});

describe('整篇作为一章', () => {
  it('忽略标题直接合成一章', () => {
    const text = `第一章\n${body('甲')}\n第二章\n${body('乙')}`;
    const chapters = splitChapters(text, { mode: 'single' });

    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.content).toContain('第一章');
    expect(chapters[0]?.content).toContain('第二章');
  });
});

describe('自定义正则', () => {
  it('按用户给的规则切分', () => {
    const text = `=== 一 ===\n${body('甲')}\n=== 二 ===\n${body('乙')}`;
    const chapters = splitChapters(text, { mode: 'custom', customPattern: '^===.+===$' });

    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.title).toBe('=== 一 ===');
  });

  it('非法正则退化为整篇一章，而不是报错或返回空', () => {
    expect(compileCustomPattern('[unclosed')).toBeUndefined();
    const chapters = splitChapters(`第一章\n${body('甲')}`, {
      mode: 'custom',
      customPattern: '[unclosed',
    });
    expect(chapters).toHaveLength(1);
  });

  it('能匹配空串的正则视为无效', () => {
    // 这类正则会把每一行都当成标题，等于没切
    expect(compileCustomPattern('.*')).toBeUndefined();
    expect(compileCustomPattern('^')).toBeUndefined();
  });

  it('空模式视为无效', () => {
    expect(compileCustomPattern('   ')).toBeUndefined();
  });
});

describe('人工调整', () => {
  const chapters = splitChapters(
    [
      '第一章 甲',
      body('甲的内容'),
      '第二章 乙',
      body('乙的内容'),
      '第三章 丙',
      body('丙的内容'),
    ].join('\n'),
  );

  it('与上一章合并：标题保留为一行，序号重排', () => {
    const merged = mergeWithPrevious(chapters, 2);

    expect(merged).toHaveLength(2);
    expect(merged[0]?.title).toBe('第一章 甲');
    // 被并入的标题不能凭空消失
    expect(merged[0]?.content).toContain('第二章 乙');
    expect(merged[0]?.content).toContain('乙的内容');
    expect(merged.map((chapter) => chapter.index)).toEqual([1, 2]);
  });

  it('第一章无法向上合并', () => {
    expect(mergeWithPrevious(chapters, 1)).toEqual(chapters);
  });

  it('删除某一章后序号重排', () => {
    const removed = removeChapter(chapters, 2);

    expect(removed.map((chapter) => chapter.title)).toEqual(['第一章 甲', '第三章 丙']);
    expect(removed.map((chapter) => chapter.index)).toEqual([1, 2]);
  });

  it('改标题不影响正文', () => {
    const renamed = renameChapter(chapters, 1, '序章');
    expect(renamed[0]?.title).toBe('序章');
    expect(renamed[0]?.content).toBe(chapters[0]?.content);
  });

  it('对不存在的序号操作时保持原样', () => {
    expect(removeChapter(chapters, 99)).toHaveLength(3);
    expect(mergeWithPrevious(chapters, 99)).toEqual(chapters);
  });
});

describe('切分结果体检', () => {
  it('统计章数与总字数', () => {
    const chapters = splitChapters(`第一章\n${body('甲')}\n第二章\n${body('乙')}`);
    const summary = summarizeSplit(chapters);

    expect(summary.chapterCount).toBe(2);
    expect(summary.totalWords).toBeGreaterThan(600);
    expect(summary.suspiciousCount).toBe(0);
  });

  it('大量极短章节会被标记为可疑', () => {
    // 典型场景：把目录的每一行都切成了一章
    const chapters = splitChapters(
      ['第一章 甲', '短', '第二章 乙', '短', '第三章 丙', body('正常长度的一章')].join('\n'),
    );
    const summary = summarizeSplit(chapters);

    expect(summary.suspiciousCount).toBeGreaterThan(0);
  });

  it('空结果不报错', () => {
    expect(summarizeSplit([])).toEqual({
      chapterCount: 0,
      totalWords: 0,
      suspiciousCount: 0,
    });
  });
});
