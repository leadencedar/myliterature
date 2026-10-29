import { describe, expect, it } from 'vitest';
import { ChapterSchema, type Chapter } from '@/domain/schema';
import { STYLE_ANCHOR_CHARS, STYLE_ANCHOR_MIN_CHARS, selectStyleAnchor } from './styleAnchor';

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

const text = (length: number, unit = '字'): string => unit.repeat(length);

describe('文风锚点选择（纯函数）', () => {
  it('不传目标章、找不到目标章时返回 null', () => {
    expect(selectStyleAnchor([chapter(1, { content: text(400) })], null)).toBeNull();
    expect(selectStyleAnchor([chapter(1, { content: text(400) })], 'ghost')).toBeNull();
  });

  it('第一章没有更早正文时不注入', () => {
    expect(
      selectStyleAnchor([chapter(1, { content: text(400), status: 'done' })], 'ch1'),
    ).toBeNull();
  });

  it('只取目标章之前的章节，更晚的正文不参与', () => {
    const anchor = selectStyleAnchor(
      [
        chapter(1, { content: text(400), status: 'done' }),
        chapter(2),
        chapter(3, { content: text(400), status: 'done' }),
      ],
      'ch2',
    );

    expect(anchor).toMatchObject({ chapterId: 'ch1', index: 1, label: '第 1 章开头' });
  });

  it('已完成章优先：在已完成里取最早一章', () => {
    const anchor = selectStyleAnchor(
      [
        chapter(1, { content: text(400), status: 'draft' }),
        chapter(2, { content: text(400), status: 'done' }),
        chapter(3, { content: text(400), status: 'done' }),
        chapter(4),
      ],
      'ch4',
    );

    expect(anchor?.chapterId).toBe('ch2');
  });

  it('没有已完成章时取最早有正文的一章', () => {
    const anchor = selectStyleAnchor(
      [
        chapter(1, { content: text(400), status: 'draft' }),
        chapter(2, { content: text(400), status: 'draft' }),
        chapter(3),
      ],
      'ch3',
    );

    expect(anchor?.chapterId).toBe('ch1');
  });

  it('正文不足 300 字跳过，刚好 300 字可用', () => {
    expect(
      selectStyleAnchor(
        [chapter(1, { content: text(STYLE_ANCHOR_MIN_CHARS - 1) }), chapter(2)],
        'ch2',
      ),
    ).toBeNull();

    const anchor = selectStyleAnchor(
      [chapter(1, { content: text(STYLE_ANCHOR_MIN_CHARS) }), chapter(2)],
      'ch2',
    );
    expect(anchor?.chapterId).toBe('ch1');
  });

  it('超过 600 字按段落边界截断，末尾补省略号', () => {
    const paragraph1 = `${text(250, '甲')}。`;
    const paragraph2 = `${text(250, '乙')}。`;
    const paragraph3 = `${text(250, '丙')}。`;
    const anchor = selectStyleAnchor(
      [
        chapter(1, {
          content: [paragraph1, paragraph2, paragraph3].join('\n\n'),
        }),
        chapter(2),
      ],
      'ch2',
    );

    // 两段 252*2=504 字能放下，第三段放不下 → 停在段落边界
    expect(anchor?.text).toBe(`${paragraph1}\n\n${paragraph2}……`);
  });

  it('没有空行分段且超长时从开头硬截 600 字', () => {
    const anchor = selectStyleAnchor(
      [chapter(1, { content: text(2000, '前') }), chapter(2)],
      'ch2',
    );

    expect(anchor?.text).toBe(`${text(STYLE_ANCHOR_CHARS, '前')}……`);
  });

  it('不超过 600 字时原样返回，不补省略号', () => {
    const content = text(400, '原');
    const anchor = selectStyleAnchor([chapter(1, { content }), chapter(2)], 'ch2');

    expect(anchor?.text).toBe(content);
  });

  it('外传传 chapterWord 后标签为「外传第 N 章开头」', () => {
    const anchor = selectStyleAnchor(
      [chapter(1, { content: text(400) }), chapter(2)],
      'ch2',
      '外传第',
    );

    expect(anchor?.label).toBe('外传第 1 章开头');
  });

  it('同一线保护：主线目标不会拿外传正文当锚点', () => {
    const anchor = selectStyleAnchor(
      [chapter(1, { content: text(400), sideStoryId: 'side-a', status: 'done' }), chapter(2)],
      'ch2',
    );

    expect(anchor).toBeNull();
  });

  it('确定性：同样输入两次选择结果一致', () => {
    const chapters = [chapter(1, { content: text(400), status: 'done' }), chapter(2)];

    expect(selectStyleAnchor(chapters, 'ch2')).toEqual(selectStyleAnchor(chapters, 'ch2'));
  });
});
