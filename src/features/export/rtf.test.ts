import { describe, expect, it } from 'vitest';
import { extractRtfText } from '@/features/import/rtf';
import { escapeRtf, renderRtfDocument } from './rtf';

const CJK_PATTERN = /[^\u0000-\u007f]/u;

describe('RTF 转义', () => {
  it('反斜杠与花括号按 RTF 语法转义', () => {
    expect(escapeRtf('a\\b{c}d')).toBe('a\\\\b\\{c\\}d');
  });

  it('制表符用 \\tab 控制词，换行与其它控制字符丢弃', () => {
    expect(escapeRtf('a\tb')).toBe('a\\tab b');
    expect(escapeRtf('a\nb\r\nc')).toBe('abc');
    expect(escapeRtf('a\u0001b\u0007c')).toBe('abc');
  });

  it('ASCII 原样输出', () => {
    expect(escapeRtf('ABC xyz 123 ~`!@#$%^&*()_+-=[]|;:\'",.<>/?')).toBe(
      'ABC xyz 123 ~`!@#$%^&*()_+-=[]|;:\'",.<>/?',
    );
  });

  it('\\uN 用有符号 16 位十进制，超过 32767 时减 65536', () => {
    expect(escapeRtf('一')).toBe('\\u19968?');
    expect(escapeRtf('\uFFFD')).toBe('\\u-3?');
    expect(escapeRtf('。')).toBe('\\u12290?');
  });

  it('非 BMP 字符输出相邻两个 \\uN? 代理码元', () => {
    // 😀 U+1F600 → D83D DE00 → -10179 / -8704
    expect(escapeRtf('😀')).toBe('\\u-10179?\\u-8704?');
  });
});

describe('RTF 文档排版', () => {
  it('输出纯 ASCII，以 {\\rtf1 开头、以 } 结尾', () => {
    const rtf = renderRtfDocument({
      title: '第 3 章 灵潮',
      subtitle: '归墟纪',
      paragraphs: ['子夜翻涌。', 'English 123。'],
    });
    expect(rtf.startsWith('{\\rtf1')).toBe(true);
    expect(rtf.endsWith('}')).toBe(true);
    expect(CJK_PATTERN.test(rtf)).toBe(false);
  });

  it('文件头声明代码页 936、字体表与语言', () => {
    const rtf = renderRtfDocument({ title: '标题', paragraphs: [] });
    expect(rtf).toContain('\\ansi');
    expect(rtf).toContain('\\ansicpg936');
    expect(rtf).toContain('\\deff0');
    expect(rtf).toContain('\\deflang2052');
    expect(rtf).toContain('\\uc1');
    expect(rtf).toContain('{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}}');
  });

  it('标题 18pt 加粗居中，副标题 10pt 居中，正文 12pt 两端对齐 1.5 倍行距', () => {
    const rtf = renderRtfDocument({ title: '标题', subtitle: '书名', paragraphs: ['正文'] });
    expect(rtf).toContain('\\pard\\qc\\b\\fs36\\sa240');
    expect(rtf).toContain('\\pard\\qc\\b0\\fs20\\sa240');
    expect(rtf).toContain('\\pard\\qj\\b0\\fs24\\sl360\\slmult1');
  });

  it('没有副标题（或只有空白）时不输出副标题段落', () => {
    const without = renderRtfDocument({ title: '标题', paragraphs: ['正文'] });
    const blank = renderRtfDocument({ title: '标题', subtitle: '   ', paragraphs: ['正文'] });
    expect(without).not.toContain('\\fs20');
    expect(blank).not.toContain('\\fs20');
    expect(blank).toBe(without);
  });

  it('空行照常输出空段落', () => {
    const rtf = renderRtfDocument({ title: '标题', paragraphs: ['', ''] });
    expect(rtf.match(/\\par\b/gu)).toHaveLength(3);
  });

  it('正文段落不额外折行，一段只对应一个 \\par', () => {
    const long = '一'.repeat(300);
    const rtf = renderRtfDocument({ title: '标题', paragraphs: [long] });
    const extracted = extractRtfText(rtf).text;
    expect(extracted.split('\n')[1]).toBe(long);
    expect(extracted.split('\n')).toHaveLength(3);
  });
});

describe('RTF 导出 → 提取器往返', () => {
  it('标题、副标题、多段、空行、中英数字混排、特殊字符、emoji 全部还原', () => {
    const rtf = renderRtfDocument({
      title: '第 3 章 灵潮',
      subtitle: '归墟纪',
      paragraphs: [
        '第一段：天还没亮。',
        '',
        '第二段 mixed English 123，标点：「引号」。',
        '第三段 A\\B {C} D',
        '第四段有 emoji 😀 与扩展区汉字 㵘。',
      ],
    });
    const result = extractRtfText(rtf);
    const expected = [
      '第 3 章 灵潮',
      '归墟纪',
      '第一段：天还没亮。',
      '',
      '第二段 mixed English 123，标点：「引号」。',
      '第三段 A\\B {C} D',
      '第四段有 emoji 😀 与扩展区汉字 㵘。',
    ].join('\n');
    expect(result.text).toBe(`${expected}\n`);
    expect(result.lossy).toBe(false);
  });

  it('没有副标题时标题之后直接是正文', () => {
    const rtf = renderRtfDocument({ title: '第 1 章 离乡', paragraphs: ['天还没亮。'] });
    expect(extractRtfText(rtf).text).toBe('第 1 章 离乡\n天还没亮。\n');
  });

  it('空正文只剩下标题行', () => {
    const rtf = renderRtfDocument({ title: '独章', paragraphs: [] });
    expect(extractRtfText(rtf).text).toBe('独章\n');
  });

  it('连续空段落往返成连续空行', () => {
    const rtf = renderRtfDocument({ title: '标题', paragraphs: ['', '', ''] });
    expect(extractRtfText(rtf).text).toBe('标题\n\n\n\n');
  });

  it('标题里的非 BMP 字符经代理对转义后仍能还原', () => {
    const rtf = renderRtfDocument({ title: '第 𠮷 章', paragraphs: [] });
    expect(extractRtfText(rtf).text).toBe('第 𠮷 章\n');
  });
});
