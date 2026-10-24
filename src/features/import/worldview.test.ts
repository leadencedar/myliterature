import { describe, expect, it } from 'vitest';
import { WORLDVIEW_CHUNK_SIZE, packWorldviewChunks, splitWorldviewText } from './worldview';

const strip = (value: string) => value.replace(/\s+/gu, '');

describe('世界观设定分段', () => {
  it('空文本或纯空白返回空数组', () => {
    expect(splitWorldviewText('')).toEqual([]);
    expect(splitWorldviewText('  \n\n  \n')).toEqual([]);
  });

  it('短文本整段成一块', () => {
    expect(splitWorldviewText('灵潮每逢子夜涨落。\n\n归墟在极北。')).toEqual([
      '灵潮每逢子夜涨落。\n\n归墟在极北。',
    ]);
  });

  it('多段落贪心合并，每块不超过上限', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(30));
    const chunks = splitWorldviewText(paragraphs.join('\n\n'), 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    // 30 + 2 + 30 + 2 + 30 = 94，一块能放三段
    expect(chunks[0]).toBe(paragraphs.slice(0, 3).join('\n\n'));
  });

  it('单个段落超过上限时硬切', () => {
    const long = '设'.repeat(250);
    const chunks = splitWorldviewText(`前言。\n\n${long}\n\n后记。`, 100);
    expect(chunks).toEqual([
      '前言。',
      '设'.repeat(100),
      '设'.repeat(100),
      '设'.repeat(50),
      '后记。',
    ]);
  });

  it('拼回去去掉空白后与原文一致，不丢字', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第${i}条设定：${'灵'.repeat(i * 37)}`).join(
      '\n\n\n',
    );
    const chunks = splitWorldviewText(text, 500);
    expect(strip(chunks.join(''))).toBe(strip(text));
  });

  it('默认上限是 WORLDVIEW_CHUNK_SIZE', () => {
    const text = `${'甲'.repeat(WORLDVIEW_CHUNK_SIZE - 10)}\n\n${'乙'.repeat(100)}`;
    expect(splitWorldviewText(text)).toHaveLength(2);
  });
});

describe('按章打包世界观段落', () => {
  it('三个短章打成一段，章前带标题行、章间空一行，标签是「首 — 末」', () => {
    const chunks = packWorldviewChunks([
      { title: '地理', content: '归墟在极北。' },
      { title: '宗门', content: '青冥宗居东。' },
      { title: '灵潮', content: '灵潮每逢子夜涨落。' },
    ]);
    expect(chunks).toEqual([
      {
        index: 1,
        title: '地理 — 灵潮',
        content: '地理\n归墟在极北。\n\n宗门\n青冥宗居东。\n\n灵潮\n灵潮每逢子夜涨落。',
        status: 'pending',
        error: '',
      },
    ]);
  });

  it('只有一章的段，标签就是这一章的标题', () => {
    expect(packWorldviewChunks([{ title: '地理', content: '归墟在极北。' }])[0]?.title).toBe(
      '地理',
    );
  });

  it('放不下就另起一段，不在章内切开', () => {
    // 每章 = 标题行 3 + 正文 40 = 43；两章 43 + 2 + 43 = 88 ≤ 100，三章就超了
    const drafts = ['甲', '乙', '丙', '丁'].map((name) => ({
      title: `${name}章`,
      content: name.repeat(40),
    }));
    const chunks = packWorldviewChunks(drafts, 100);
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      `甲章\n${'甲'.repeat(40)}\n\n乙章\n${'乙'.repeat(40)}`,
      `丙章\n${'丙'.repeat(40)}\n\n丁章\n${'丁'.repeat(40)}`,
    ]);
    expect(chunks.map((chunk) => chunk.title)).toEqual(['甲章 — 乙章', '丙章 — 丁章']);
  });

  it('超长章先结束当前段，再按段落切，标题带（i/k），正文不带标题行', () => {
    const long = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(40)).join('\n\n');
    const chunks = packWorldviewChunks(
      [
        { title: '序', content: '短短一句。' },
        { title: '宗门志', content: long },
        { title: '跋', content: '尾声。' },
      ],
      100,
    );
    expect(chunks[0]).toMatchObject({ title: '序', content: '序\n短短一句。' });
    const middle = chunks.slice(1, -1);
    expect(middle.length).toBeGreaterThan(1);
    middle.forEach((chunk, i) => {
      expect(chunk.title).toBe(`宗门志（${i + 1}/${middle.length}）`);
      expect(chunk.content).not.toContain('宗门志');
    });
    expect(chunks.at(-1)).toMatchObject({ title: '跋', content: '跋\n尾声。' });
  });

  it('判超长时计入标题行：正文本身不超、加上标题行恰好超时仍按超长切', () => {
    const chunks = packWorldviewChunks([{ title: '宗门', content: '宗'.repeat(98) }], 100);
    // 标题行「宗门\n」3 字 + 98 = 101 > 100
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ title: '宗门（1/1）', content: '宗'.repeat(98) });
  });

  it('无标题的超长章切出的段 title 为空', () => {
    const chunks = packWorldviewChunks([{ title: '', content: '设'.repeat(250) }], 100);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.title).toBe('');
  });

  it('跨章段首末标题有一个为空时只取非空的，都空则为空', () => {
    expect(
      packWorldviewChunks([
        { title: '', content: '甲。' },
        { title: '宗门', content: '乙。' },
      ])[0]?.title,
    ).toBe('宗门');
    expect(
      packWorldviewChunks([
        { title: '地理', content: '甲。' },
        { title: '', content: '乙。' },
      ])[0]?.title,
    ).toBe('地理');
    const untitled = packWorldviewChunks([
      { title: '', content: '甲。' },
      { title: '', content: '乙。' },
    ]);
    expect(untitled[0]).toMatchObject({ title: '', content: '甲。\n\n乙。' });
  });

  it('空草稿跳过，全空时返回空数组', () => {
    expect(packWorldviewChunks([{ title: '空', content: '  \n ' }])).toEqual([]);
    const chunks = packWorldviewChunks([
      { title: '空', content: '' },
      { title: '地理', content: '归墟在极北。' },
    ]);
    expect(chunks).toEqual([
      expect.objectContaining({ title: '地理', content: '地理\n归墟在极北。' }),
    ]);
  });

  it('每段 content.length ≤ max，index 从 1 连续，status pending、error 为空', () => {
    const drafts = Array.from({ length: 30 }, (_, i) => ({
      title: i % 3 === 0 ? '' : `第${i}节`,
      content: Array.from({ length: (i % 5) + 1 }, (_, j) => `${i}-${j}`.repeat(i * 3 + 7)).join(
        '\n\n',
      ),
    }));
    const chunks = packWorldviewChunks(drafts, 300);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => {
      expect(chunk.content.length).toBeLessThanOrEqual(300);
      expect(chunk.index).toBe(i + 1);
      expect(chunk.status).toBe('pending');
      expect(chunk.error).toBe('');
    });
  });

  it('去掉普通段补入的标题行与空白后，拼起来与各草稿正文依次拼接一致', () => {
    const drafts = Array.from({ length: 20 }, (_, i) => ({
      title: `卷${i}`,
      content: Array.from({ length: (i % 4) + 1 }, (_, j) => `设${i}定${j}`.repeat(i * 4 + 5)).join(
        '\n\n',
      ),
    }));
    const chunks = packWorldviewChunks(drafts, 400);
    const titleLines = new Set(drafts.map((draft) => draft.title));
    const body = chunks
      .map((chunk) =>
        chunk.content
          .split('\n')
          .filter((line) => !titleLines.has(line))
          .join('\n'),
      )
      .join('');
    expect(strip(body)).toBe(strip(drafts.map((draft) => draft.content).join('')));
  });
});
