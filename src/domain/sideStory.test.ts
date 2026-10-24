import { describe, expect, it } from 'vitest';
import { ChapterSchema, RepositorySnapshotSchema, type Chapter, type SideStory } from './schema';
import {
  chapterLabel,
  chaptersOfTrack,
  isMainChapter,
  normalizeSideStoryTitle,
  renderSideStoryBrief,
  sideStoryLabel,
  sideStoryTitleKey,
} from './sideStory';

function chapter(id: string, index: number, sideStoryId: string | null = null): Chapter {
  return ChapterSchema.parse({
    id,
    novelId: 'n1',
    index,
    sideStoryId,
    createdAt: 0,
    updatedAt: 0,
  });
}

function story(id: string, title: string, extra: Partial<SideStory> = {}): SideStory {
  return {
    id,
    novelId: 'n1',
    title,
    synopsis: '',
    rollingSummary: '',
    order: 0,
    scenarioSource: null,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

describe('isMainChapter', () => {
  it('sideStoryId 为 null 是主线，否则是外传', () => {
    expect(isMainChapter(chapter('a', 1))).toBe(true);
    expect(isMainChapter(chapter('b', 1, 's1'))).toBe(false);
  });

  it('迁移前没有 sideStoryId 的旧行按主线处理', () => {
    expect(isMainChapter({} as Pick<Chapter, 'sideStoryId'>)).toBe(true);
  });
});

describe('chaptersOfTrack', () => {
  const all = [
    chapter('m2', 2),
    chapter('s1-2', 2, 's1'),
    chapter('m1', 1),
    chapter('s2-1', 1, 's2'),
    chapter('s1-1', 1, 's1'),
    chapter('m3', 3),
  ];

  it('null 只取主线，按 index 升序', () => {
    expect(chaptersOfTrack(all, null).map((c) => c.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('外传只取同一部，两部外传互不混入', () => {
    expect(chaptersOfTrack(all, 's1').map((c) => c.id)).toEqual(['s1-1', 's1-2']);
    expect(chaptersOfTrack(all, 's2').map((c) => c.id)).toEqual(['s2-1']);
  });

  it('不修改入参的顺序', () => {
    const before = all.map((c) => c.id);
    chaptersOfTrack(all, null);
    expect(all.map((c) => c.id)).toEqual(before);
  });
});

describe('标签', () => {
  const stories = [story('s1', '青冥旧事')];

  it('sideStoryLabel 拼成「外传·X」', () => {
    expect(sideStoryLabel(stories[0]!)).toBe('外传·青冥旧事');
  });

  it('chapterLabel：主线「第 N 章」，外传「外传·X 第 N 章」', () => {
    expect(chapterLabel(chapter('m', 3), stories)).toBe('第 3 章');
    expect(chapterLabel(chapter('s', 3, 's1'), stories)).toBe('外传·青冥旧事 第 3 章');
  });
});

describe('normalizeSideStoryTitle / sideStoryTitleKey', () => {
  it('trim 并去掉开头的「外传·」「番外：」等前缀', () => {
    expect(normalizeSideStoryTitle('  青冥旧事  ')).toBe('青冥旧事');
    expect(normalizeSideStoryTitle('外传·青冥旧事')).toBe('青冥旧事');
    expect(normalizeSideStoryTitle('外传・青冥旧事')).toBe('青冥旧事');
    expect(normalizeSideStoryTitle('番外：青冥旧事')).toBe('青冥旧事');
    expect(normalizeSideStoryTitle('番外: 青冥旧事')).toBe('青冥旧事');
    expect(normalizeSideStoryTitle('外传 青冥旧事')).toBe('青冥旧事');
  });

  it('不在开头的「外传」不动', () => {
    expect(normalizeSideStoryTitle('青冥外传')).toBe('青冥外传');
  });

  it('开头的「外传」「番外」后面没有分隔符时是标题本身，原样保留', () => {
    expect(normalizeSideStoryTitle('番外篇')).toBe('番外篇');
    expect(normalizeSideStoryTitle('外传之谜')).toBe('外传之谜');
  });

  it('只填「外传」「番外」（含末尾分隔符）归一化成空串', () => {
    expect(normalizeSideStoryTitle('外传')).toBe('');
    expect(normalizeSideStoryTitle(' 番外： ')).toBe('');
  });

  it('「青冥旧事」与「外传·青冥旧事」同键，「Arc」与「arc」同键', () => {
    expect(sideStoryTitleKey('青冥旧事')).toBe(sideStoryTitleKey('外传·青冥旧事'));
    expect(sideStoryTitleKey('Arc')).toBe(sideStoryTitleKey('arc'));
    expect(sideStoryTitleKey('Arc')).not.toBe(sideStoryTitleKey('Arcs'));
  });

  it('只保留归一化，不改用户写的大小写', () => {
    expect(normalizeSideStoryTitle('外传·Arc')).toBe('Arc');
  });
});

describe('renderSideStoryBrief', () => {
  it('有简介时带简介行和独立说明', () => {
    expect(
      renderSideStoryBrief(story('s1', '青冥旧事', { synopsis: '主线二十年前，师父的往事。' })),
    ).toBe(
      [
        '【本章属于外传《青冥旧事》】',
        '简介：主线二十年前，师父的往事。',
        '外传独立于主线：不要写成主线的后续，也不要改动主线里已经发生的事；人物与设定以上面的知识库为准。',
      ].join('\n'),
    );
  });

  it('简介为空时没有简介行、没有空括号', () => {
    const text = renderSideStoryBrief(story('s1', '青冥旧事', { synopsis: '   ' }));
    expect(text).not.toContain('简介');
    expect(text).not.toMatch(/（\s*）|\(\s*\)/u);
    expect(text.split('\n')).toEqual([
      '【本章属于外传《青冥旧事》】',
      '外传独立于主线：不要写成主线的后续，也不要改动主线里已经发生的事；人物与设定以上面的知识库为准。',
    ]);
  });
});

describe('schema：外传相关', () => {
  const novel = { id: 'n1', title: '书', createdAt: 0, updatedAt: 0 };

  it('ChapterSchema 的 sideStoryId 默认为 null', () => {
    expect(
      ChapterSchema.parse({ id: 'c', novelId: 'n1', index: 1, createdAt: 0, updatedAt: 0 })
        .sideStoryId,
    ).toBeNull();
  });

  it('旧快照（没有 sideStories、章节没有 sideStoryId）能解析', () => {
    const parsed = RepositorySnapshotSchema.parse({
      novels: [novel],
      chapters: [{ id: 'c', novelId: 'n1', index: 1, createdAt: 0, updatedAt: 0 }],
    });
    expect(parsed.sideStories).toEqual([]);
    expect(parsed.chapters[0]?.sideStoryId).toBeNull();
  });

  it('引用不存在外传的快照被拒绝，路径指向那一章', () => {
    const result = RepositorySnapshotSchema.safeParse({
      novels: [novel],
      chapters: [
        { id: 'c1', novelId: 'n1', index: 1, createdAt: 0, updatedAt: 0 },
        { id: 'c2', novelId: 'n1', index: 1, sideStoryId: 'ghost', createdAt: 0, updatedAt: 0 },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['chapters', 1, 'sideStoryId'],
      message: '找不到所属外传',
    });
  });

  it('外传属于别的作品时被拒绝', () => {
    const result = RepositorySnapshotSchema.safeParse({
      novels: [novel],
      sideStories: [story('s1', '青冥旧事', { novelId: 'n2' })],
      chapters: [
        { id: 'c1', novelId: 'n1', index: 1, sideStoryId: 's1', createdAt: 0, updatedAt: 0 },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['chapters', 0, 'sideStoryId'],
      message: '所属外传不属于这部作品',
    });
  });

  it('外传章节带 outlineNodeId 时被拒绝', () => {
    const result = RepositorySnapshotSchema.safeParse({
      novels: [novel],
      sideStories: [story('s1', '青冥旧事')],
      chapters: [
        {
          id: 'c1',
          novelId: 'n1',
          index: 1,
          sideStoryId: 's1',
          outlineNodeId: 'o1',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['chapters', 0, 'outlineNodeId'],
      message: '外传章节不能关联大纲节点',
    });
  });

  it('合法的外传章节能解析', () => {
    const parsed = RepositorySnapshotSchema.parse({
      novels: [novel],
      sideStories: [story('s1', '青冥旧事')],
      chapters: [
        { id: 'c1', novelId: 'n1', index: 1, sideStoryId: 's1', createdAt: 0, updatedAt: 0 },
      ],
    });
    expect(parsed.chapters[0]?.sideStoryId).toBe('s1');
    expect(parsed.sideStories).toHaveLength(1);
  });
});
