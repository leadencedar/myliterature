import { describe, expect, it } from 'vitest';
import { extractRtfText, isRtfMarkup } from './rtf';

/** 包一层最小 RTF 外壳，测试正文转换本身 */
function rtf(body: string): string {
  return `{\\rtf1\\ansi\\deff0 ${body}}`;
}

describe('isRtfMarkup', () => {
  it('以 {\\rtf 开头才算 RTF，容忍前导空白', () => {
    expect(isRtfMarkup('{\\rtf1\\ansi 第一章')).toBe(true);
    expect(isRtfMarkup('  \n{\\rtf1\\ansi')).toBe(true);
    expect(isRtfMarkup('第一章 离乡')).toBe(false);
    expect(isRtfMarkup('')).toBe(false);
  });
});

describe('段落与结构', () => {
  it('\\par 与 \\line 都是换行', () => {
    expect(extractRtfText(rtf('第一章\\par 离乡。\\line 他回头。')).text).toBe(
      '第一章\n离乡。\n他回头。',
    );
  });

  it('\\tab 与 \\cell 是制表符', () => {
    expect(extractRtfText(rtf('甲\\tab 乙\\cell 丙')).text).toBe('甲\t乙\t丙');
  });

  it('转义的花括号与反斜杠还原成字面量', () => {
    expect(extractRtfText(rtf('A\\{B\\} C\\\\D')).text).toBe('A{B} C\\D');
  });

  it('嵌套组不丢内容：加粗组里的文字照常取出', () => {
    expect(extractRtfText(rtf('{\\b 他没有回头。}只是站着。')).text).toBe('他没有回头。只是站着。');
  });

  it('文件里真实的换行是排版空白，不变成正文换行', () => {
    const markup = '{\\rtf1\\ansi\n\\deff0 第一章\n\\par 正文\n}';
    expect(extractRtfText(markup).text).toBe('第一章\n正文');
  });

  it('未知控制词与参数直接忽略，参数后的分隔空格也不进正文', () => {
    expect(extractRtfText(rtf('\\f0\\fs24\\lang2052 \\i0 正文')).text).toBe('正文');
  });
});

describe('Unicode 转义 \\uN', () => {
  it('新式 RTF 的 \\uN? 转义：取码位、跳过 fallback 字符', () => {
    // \u20320=你 \u22909=好，后面的 ? 是给老阅读器的 fallback
    expect(extractRtfText(rtf('\\u20320?\\u22909?'))).toEqual({ text: '你好', lossy: false });
  });

  it('负数参数按 65536+N 折算，两个 \\u 拼出代理对', () => {
    // 0xD83D = 55357，0xDE00 = 56832，合起来是 U+1F600 😀
    expect(extractRtfText(rtf('\\u55357?\\u56832?'))).toEqual({ text: '😀', lossy: false });
  });

  it('\\uc0 表示没有 fallback，后面的字符是正文', () => {
    expect(extractRtfText(rtf('\\uc0\\u20320你好')).text).toBe('你你好');
  });

  it('\\uc2 跳过两个 fallback 字符', () => {
    expect(extractRtfText(rtf('\\uc2\\u20320ab好')).text).toBe('你好');
  });
});

describe("十六进制转义 \\'hh（老式中文 RTF）", () => {
  it('ansicpg936（GBK）的字节解出中文', () => {
    // 第=B5DA 一=D2BB 章=D5C2
    expect(extractRtfText(rtf("\\ansicpg936 \\'b5\\'da\\'d2\\'bb\\'d5\\'c2"))).toEqual({
      text: '第一章',
      lossy: false,
    });
  });

  it('ansicpg65001 的 UTF-8 字节', () => {
    // 中 = E4 B8 AD
    expect(extractRtfText(rtf("\\ansicpg65001 \\'e4\\'b8\\'ad"))).toEqual({
      text: '中',
      lossy: false,
    });
  });

  it('没有声明代码页时按规范缺省 windows-1252', () => {
    // 0xE9 = é
    expect(extractRtfText(rtf("\\'e9"))).toEqual({ text: 'é', lossy: false });
  });

  it('字节与字面文字交错时顺序不乱，字面 ASCII 与所有代码页都兼容', () => {
    const markup = rtf("\\ansicpg936 第\\'b6\\'fe章 Chapter \\'c8\\'fd");
    expect(extractRtfText(markup).text).toBe('第二章 Chapter 三');
  });

  it('非法字节解码出 U+FFFD 时标记 lossy', () => {
    // 0xFF 在 GBK 里不是合法首字节
    const result = extractRtfText(rtf("\\ansicpg936 \\'b5\\'da\\'ff\\'d5\\'c2"));
    expect(result.lossy).toBe(true);
    expect(result.text).toContain('第');
    expect(result.text).toContain('章');
  });
});

describe('整组跳过的目的地', () => {
  it('字体表、颜色表、样式表整个跳过，包括其中的嵌套组', () => {
    const markup = rtf(
      '{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}{\\f1 楷体;}}' +
        '{\\colortbl;\\red0\\green0\\blue0;}' +
        '{\\stylesheet{\\s1 正文样式;}}第一章',
    );
    expect(extractRtfText(markup).text).toBe('第一章');
  });

  it('\\* 可忽略目的地（generator 等）跳过', () => {
    expect(extractRtfText(rtf('{\\*\\generator Microsoft Word 16.0;}正文')).text).toBe('正文');
  });

  it('pict 图片的二进制十六进制不会漏进正文', () => {
    const markup = rtf('{\\pict\\wmetafile8\\picw100\\pich100 0102030405060708}正文');
    expect(extractRtfText(markup).text).toBe('正文');
  });

  it('页眉页脚与 info 元数据跳过', () => {
    const markup =
      '{\\header 第一章 归墟纪}' +
      '{\\footer 第 1 页}' +
      '{\\info{\\author 作者}{\\title 书名}}正文';
    expect(extractRtfText(markup).text).toBe('正文');
  });

  it('field 域跳过（不把 HYPERLINK 指令当正文）', () => {
    const markup = rtf('{\\field{\\*\\fldinst HYPERLINK "http://x" }{\\fldrslt 链接文字}}正文');
    expect(extractRtfText(markup).text).toBe('正文');
  });
});

describe('标点与空白', () => {
  it('常见特殊字符映射成中文标点（控制词后的分隔空格被吃掉）', () => {
    expect(
      extractRtfText(
        rtf('\\emdash \\endash \\lquote 引\\rquote \\ldblquote 双\\rdblquote \\bullet'),
      ),
    ).toEqual({ text: '—–‘引’“双”·', lossy: false });
  });

  it('\\~ 是空格，\\- 与 \\_ 不输出', () => {
    expect(extractRtfText(rtf('甲\\~乙 \\-丙 \\_丁')).text).toBe('甲 乙 丙 丁');
  });

  it('\\page 与 \\sect 按换行处理', () => {
    expect(extractRtfText(rtf('上\\page 下\\sect 再下')).text).toBe('上\n下\n再下');
  });

  it('双向文本标记与零宽字符不输出', () => {
    expect(extractRtfText(rtf('甲\\ltrmark 乙\\zwj 丙')).text).toBe('甲乙丙');
  });
});

describe('边界', () => {
  it('只有外壳没有正文时输出空串', () => {
    expect(extractRtfText('{\\rtf1\\ansi\\deff0}')).toEqual({ text: '', lossy: false });
  });

  it('空输入不炸', () => {
    expect(extractRtfText('')).toEqual({ text: '', lossy: false });
  });

  it("畸形的 \\\\'hh 转义不吞字：引号按普通文字保留", () => {
    expect(extractRtfText(rtf("甲\\'zz乙")).text).toBe("甲'zz乙");
  });

  it('结尾悬空的 \\u 参数照常处理', () => {
    expect(extractRtfText(rtf('\\u20320'))).toEqual({ text: '你', lossy: false });
  });
});
