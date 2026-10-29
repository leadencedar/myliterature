import { describe, expect, it } from 'vitest';
import { CHARACTER_FIELDS, WORLDBUILDING_FIELDS } from '@/domain/defaults';
import {
  CategorySchema,
  ChapterSchema,
  ChapterSummarySchema,
  KnowledgeEntrySchema,
  NovelSchema,
  OutlineNodeSchema,
  SideStorySchema,
  StyleProfileSchema,
  WritingNormSchema,
  type Category,
  type Chapter,
  type ChapterSummary,
  type KnowledgeEntry,
  type OutlineNode,
  type WritingNorm,
} from '@/domain/schema';
import { composeStylePrefix, normTokens } from '@/prompt/sections';
import { SummaryChainContextBuilder } from './SummaryChainContextBuilder';
import { MAX_INFERRED_ENTRIES, type ContextRequest } from './ContextBuilder';

const builder = new SummaryChainContextBuilder();

const novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  oneLiner: '失忆剑客发现自己是灭门案凶手。',
  createdAt: 0,
  updatedAt: 0,
});

const style = StyleProfileSchema.parse({
  id: 's1',
  novelId: 'n1',
  tradition: 'web',
  methodology: 'web-rhythm',
  createdAt: 0,
  updatedAt: 0,
});

const worldCategory: Category = CategorySchema.parse({
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

const charCategory: Category = CategorySchema.parse({
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

function entry(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    id,
    novelId: 'n1',
    categoryId: charCategory.id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function node(id: string, overrides: Partial<OutlineNode> = {}): OutlineNode {
  return OutlineNodeSchema.parse({
    id,
    novelId: 'n1',
    title: id,
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

function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    novel,
    style,
    categories: [worldCategory, charCategory],
    entries: [],
    outline: [],
    chapters: [],
    summaries: [],
    targetNodeId: null,
    targetChapterId: null,
    ...overrides,
  };
}

describe('稳定前缀', () => {
  it('包含作品信息与风格档案，且始终注入', () => {
    const built = builder.build(request());

    expect(built.stablePrefix).toContain('归墟纪');
    expect(built.stablePrefix).toContain('【文体取向】');
    expect(built.items.find((item) => item.kind === 'meta')?.included).toBe(true);
  });

  it('核心设定单独成段并排在勾选条目之前', () => {
    const built = builder.build(
      request({
        entries: [
          entry('灵气', { categoryId: worldCategory.id, pinned: true, summary: '天地能量' }),
          entry('林越', { summary: '失忆剑客' }),
        ],
        selectedEntryIds: ['林越'],
      }),
    );

    const pinnedAt = built.stablePrefix.indexOf('【必须遵守的核心设定】');
    const relatedAt = built.stablePrefix.indexOf('【相关设定】');
    expect(pinnedAt).toBeGreaterThan(-1);
    expect(relatedAt).toBeGreaterThan(pinnedAt);
    expect(built.stablePrefix).toContain('灵气');
    expect(built.stablePrefix).toContain('林越');
  });

  it('条目渲染带上别名与有内容的字段，跳过空字段', () => {
    const built = builder.build(
      request({
        entries: [
          entry('林越', {
            aliases: ['阿越'],
            summary: '失忆剑客',
            fields: { identity: '流亡贵族', appearance: '' },
          }),
        ],
        selectedEntryIds: ['林越'],
      }),
    );

    expect(built.stablePrefix).toContain('别名：阿越');
    expect(built.stablePrefix).toContain('身份：流亡贵族');
    expect(built.stablePrefix).not.toContain('外貌：');
  });

  it('同样输入两次构建结果逐字节相同（prompt 缓存前提）', () => {
    const input = request({
      entries: [entry('林越', { pinned: true, summary: '失忆剑客' })],
    });
    expect(builder.build(input).stablePrefix).toBe(builder.build(input).stablePrefix);
  });

  it('大纲位置不进稳定前缀，避免截断公共前缀', () => {
    // 大纲每章都不同，放进前缀会让后面的核心设定与人物都命中不了缓存
    const built = builder.build(
      request({
        outline: [node('第1章 雪夜', { synopsis: '追兵临门' })],
        targetNodeId: '第1章 雪夜',
      }),
    );

    expect(built.stablePrefix).not.toContain('本章要写的内容');
    expect(built.volatileSuffix).toContain('本章要写的内容');
  });
});

describe('易变后缀', () => {
  it('按顺序给出大纲位置、全书进展、前几章摘要与上一章结尾', () => {
    const built = builder.build(
      request({
        novel: { ...novel, rollingSummary: '主角已离开雪山。' },
        outline: [node('第2章 旧识', { synopsis: '雪山遇故人' })],
        targetNodeId: '第2章 旧识',
        chapters: [chapter(1, { content: '雪落了整夜。最后一句。' })],
        summaries: [summary('ch1', { summary: '主角遭遇追兵' })],
      }),
    );

    const order = [
      '【本章要写的内容】',
      '【故事至此】',
      '【前几章要点】',
      '【上一章（第 1 章）的结尾原文】',
    ].map((marker) => built.volatileSuffix.indexOf(marker));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('大纲位置带上祖先链、下一章预告与不要越界的提醒', () => {
    const built = builder.build(
      request({
        outline: [
          node('第一卷', { synopsis: '风起云涌' }),
          node('第1章', { parentId: '第一卷', order: 0, synopsis: '追兵临门', targetWords: 3000 }),
          node('第2章', { parentId: '第一卷', order: 1, synopsis: '雪山遇故人' }),
        ],
        targetNodeId: '第1章',
      }),
    );

    expect(built.volatileSuffix).toContain('所在位置：第一卷');
    expect(built.volatileSuffix).toContain('所在卷的梗概：风起云涌');
    expect(built.volatileSuffix).toContain('本章梗概：追兵临门');
    expect(built.volatileSuffix).toContain('目标字数：约 3000 字');
    expect(built.volatileSuffix).toContain('下一章是「第2章」');
    expect(built.volatileSuffix).toContain('不要提前写掉下一章的内容');
  });

  it('末章没有下一章时不输出预告', () => {
    const built = builder.build(
      request({
        outline: [node('唯一一章', { synopsis: '完结' })],
        targetNodeId: '唯一一章',
      }),
    );
    expect(built.volatileSuffix).not.toContain('下一章是');
  });

  it('只注入目标章节之前最近 N 章的摘要', () => {
    const built = builder.build(
      request({
        chapters: [chapter(1), chapter(2), chapter(3), chapter(4)],
        summaries: [
          summary('ch1', { summary: '第一章要点' }),
          summary('ch2', { summary: '第二章要点' }),
          summary('ch3', { summary: '第三章要点' }),
        ],
        targetChapterId: 'ch4',
        recentSummaryCount: 2,
      }),
    );

    expect(built.volatileSuffix).not.toContain('第一章要点');
    expect(built.volatileSuffix).toContain('第二章要点');
    expect(built.volatileSuffix).toContain('第三章要点');
  });

  it('摘要带上关键事件与未收束伏笔', () => {
    const built = builder.build(
      request({
        chapters: [chapter(1), chapter(2)],
        summaries: [
          summary('ch1', {
            summary: '主角抵达雪山',
            keyEvents: ['遭遇追兵'],
            openThreads: ['黑衣人的身份'],
          }),
        ],
        targetChapterId: 'ch2',
      }),
    );

    expect(built.volatileSuffix).toContain('关键事件：遭遇追兵');
    // 伏笔追踪是长篇防漂移的关键
    expect(built.volatileSuffix).toContain('尚未收束的伏笔：黑衣人的身份');
  });

  it('上一章结尾只取末尾一段原文', () => {
    const long = `${'前'.repeat(2000)}结尾在这里。`;
    const built = builder.build(
      request({
        chapters: [chapter(1, { content: long }), chapter(2)],
        targetChapterId: 'ch2',
      }),
    );

    expect(built.volatileSuffix).toContain('结尾在这里。');
    // 不该把整章都塞进去
    expect(built.volatileSuffix.length).toBeLessThan(long.length);
    expect(built.previousChapter?.index).toBe(1);
  });

  it('没有前序章节时不产出摘要与结尾段', () => {
    const built = builder.build(request({ chapters: [chapter(1)], targetChapterId: 'ch1' }));

    expect(built.volatileSuffix).not.toContain('【前几章要点】');
    expect(built.volatileSuffix).not.toContain('结尾原文');
    expect(built.previousChapter).toBeUndefined();
  });

  it('没有指定目标章节时以全书最后一章为上一章', () => {
    const built = builder.build(
      request({ chapters: [chapter(1), chapter(2, { content: '第二章结尾' })] }),
    );
    expect(built.previousChapter?.index).toBe(2);
  });
});

describe('默认预选条目', () => {
  it('节点关联 ∪ 上一章出场，不含核心设定', () => {
    const built = builder.build(
      request({
        entries: [entry('核心', { pinned: true }), entry('关联'), entry('出场'), entry('无关')],
        outline: [node('第2章', { linkedEntryIds: ['关联', '核心'] })],
        targetNodeId: '第2章',
        chapters: [chapter(1), chapter(2)],
        summaries: [summary('ch1', { appearingEntryIds: ['出场'] })],
        targetChapterId: 'ch2',
      }),
    );

    // 核心设定始终注入，不进可勾选集合，否则用户会误以为能取消它
    expect([...built.defaultEntryIds].sort()).toEqual(['关联', '出场']);
  });

  it('核心设定即使不在勾选里也一定注入', () => {
    const built = builder.build(
      request({
        entries: [entry('核心', { pinned: true, summary: '必须遵守的规则' })],
        selectedEntryIds: [],
      }),
    );

    expect(built.stablePrefix).toContain('必须遵守的规则');
    expect(built.items.find((item) => item.kind === 'pinned')?.included).toBe(true);
  });

  it('剔除已不存在的条目 id', () => {
    const built = builder.build(
      request({
        entries: [entry('还在')],
        outline: [node('第1章', { linkedEntryIds: ['还在', '已删除'] })],
        targetNodeId: '第1章',
      }),
    );

    expect(built.defaultEntryIds).toEqual(['还在']);
  });

  it('显式传入勾选时不再使用默认预选', () => {
    const built = builder.build(
      request({
        entries: [
          entry('核心', { pinned: true, summary: '核心内容' }),
          entry('只要这个', { summary: '被选中' }),
        ],
        selectedEntryIds: ['只要这个'],
      }),
    );

    // 核心设定仍会注入（它是强制的），但不会因为默认预选而多带别的
    expect(built.stablePrefix).toContain('被选中');
    expect(built.items.filter((item) => item.kind === 'entry').map((item) => item.id)).toEqual([
      '只要这个',
    ]);
  });
});

describe('注入清单与预算', () => {
  it('列出每一项及其估算 token，合计与 estimatedTokens 一致', () => {
    const built = builder.build(
      request({
        entries: [entry('林越', { summary: '失忆剑客' })],
        selectedEntryIds: ['林越'],
      }),
    );

    const includedSum = built.items
      .filter((item) => item.included)
      .reduce((sum, item) => sum + item.tokens, 0);
    expect(built.estimatedTokens).toBe(includedSum);
    expect(built.items.every((item) => item.tokens > 0)).toBe(true);
  });

  it('超预算时丢弃低优先级内容并说明原因', () => {
    const bulky = Array.from({ length: 30 }, (_, index) =>
      entry(`条目${index}`, { summary: '很长的设定内容'.repeat(40) }),
    );

    const built = builder.build(
      request({
        entries: bulky,
        selectedEntryIds: bulky.map((item) => item.id),
        budget: 1500,
      }),
    );

    const dropped = built.items.filter((item) => !item.included);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]?.droppedReason).toBe('超出 token 预算');
    expect(built.estimatedTokens).toBeLessThanOrEqual(1500 + 200);
  });

  it('作品信息、核心设定与大纲位置不受预算裁剪', () => {
    // 这三样缺了模型就不知道在写什么，宁可超预算也要给
    const built = builder.build(
      request({
        entries: [entry('核心', { pinned: true, summary: '很长的核心设定'.repeat(50) })],
        outline: [node('第1章', { synopsis: '梗概'.repeat(50) })],
        targetNodeId: '第1章',
        budget: 10,
      }),
    );

    expect(built.items.find((item) => item.kind === 'meta')?.included).toBe(true);
    expect(built.items.find((item) => item.kind === 'pinned')?.included).toBe(true);
    expect(built.items.find((item) => item.kind === 'outline')?.included).toBe(true);
  });

  it('条目标签带上分类名，便于用户判断', () => {
    const built = builder.build(
      request({
        entries: [entry('灵气', { categoryId: worldCategory.id, summary: '天地能量' })],
        selectedEntryIds: ['灵气'],
      }),
    );

    expect(built.items.find((item) => item.id === '灵气')?.label).toBe('世界观设定 · 灵气');
  });
});

describe('默认预选：从大纲与摘要文字里推断', () => {
  /**
   * 这一组补的是一个真实缺口。
   *
   * 原先只有两个显式来源（节点的 linkedEntryIds、上一章摘要的 appearingEntryIds），
   * 而它们在最常见的路径上都是空的：立项生成的大纲走 outlineTree 提案，
   * payload 只有一段缩进文本，落库时不写 linkedEntryIds；第一章没有上一章；
   * 导入的旧稿根本没有大纲。结果就是「关联设定全靠用户自己勾」。
   */

  it('大纲梗概里提到的人物自动勾上 —— 这是第一章唯一能用的线索', () => {
    const built = builder.build(
      request({
        entries: [entry('沈砚'), entry('裴照'), entry('灵潮')],
        outline: [node('第1章', { synopsis: '沈砚在渡口遇见裴照。' })],
        targetNodeId: '第1章',
      }),
    );
    expect([...built.defaultEntryIds].sort()).toEqual(['沈砚', '裴照']);
  });

  it('大纲标题里的名字也算', () => {
    const built = builder.build(
      request({
        entries: [entry('沈砚'), entry('裴照')],
        outline: [node('n1', { title: '沈砚归乡' })],
        targetNodeId: 'n1',
      }),
    );
    expect(built.defaultEntryIds).toEqual(['沈砚']);
  });

  it('上一章摘要正文里提到的也算 —— 摘要的 appearingEntryIds 常常是空的', () => {
    // 导入的旧稿尤其如此：提取那一刻新条目还没落库，解析不出 id
    const built = builder.build(
      request({
        entries: [entry('沈砚'), entry('裴照')],
        chapters: [chapter(1), chapter(2)],
        summaries: [summary('ch1', { summary: '沈砚在雾夜离开渔村。', appearingEntryIds: [] })],
        targetChapterId: 'ch2',
      }),
    );
    expect(built.defaultEntryIds).toEqual(['沈砚']);
  });

  it('摘要的关键事件里提到的也算', () => {
    const built = builder.build(
      request({
        entries: [entry('玉佩')],
        chapters: [chapter(1), chapter(2)],
        summaries: [summary('ch1', { keyEvents: ['玉佩被带走'] })],
        targetChapterId: 'ch2',
      }),
    );
    expect(built.defaultEntryIds).toEqual(['玉佩']);
  });

  it('别名命中也算', () => {
    const built = builder.build(
      request({
        entries: [entry('裴照', { aliases: ['船家'] })],
        outline: [node('n1', { synopsis: '船家把他渡过去。' })],
        targetNodeId: 'n1',
      }),
    );
    expect(built.defaultEntryIds).toEqual(['裴照']);
  });

  it('核心设定不进预选，即使梗概里提到了', () => {
    // 它们始终注入，出现在可勾选集合里会让用户误以为能取消
    const built = builder.build(
      request({
        entries: [entry('灵潮', { pinned: true }), entry('沈砚')],
        outline: [node('n1', { synopsis: '灵潮翻涌，沈砚醒来。' })],
        targetNodeId: 'n1',
      }),
    );
    expect(built.defaultEntryIds).toEqual(['沈砚']);
  });

  it('显式关联排在推断出来的之前 —— 预算紧张时先丢推断的', () => {
    const built = builder.build(
      request({
        entries: [entry('沈砚'), entry('裴照')],
        outline: [node('n1', { synopsis: '沈砚独行。', linkedEntryIds: ['裴照'] })],
        targetNodeId: 'n1',
      }),
    );
    // 装箱顺序即优先级
    expect(built.defaultEntryIds).toEqual(['裴照', '沈砚']);
  });

  it('显式来源已有的不会因为文字也命中而重复', () => {
    const built = builder.build(
      request({
        entries: [entry('沈砚')],
        outline: [node('n1', { synopsis: '沈砚独行。', linkedEntryIds: ['沈砚'] })],
        targetNodeId: 'n1',
      }),
    );
    expect(built.defaultEntryIds).toEqual(['沈砚']);
  });

  it('推断来源有数量上限，显式来源不受限', () => {
    // 一个用常见词做别名的条目会命中大量文本，不设上限会把几十条无关设定拉进 prompt
    const many = Array.from({ length: 20 }, (_, i) => entry(`人物${i}`, { aliases: ['他'] }));
    const built = builder.build(
      request({
        entries: many,
        outline: [node('n1', { synopsis: '他走了。', linkedEntryIds: ['人物0', '人物1'] })],
        targetNodeId: 'n1',
      }),
    );
    // 2 条显式 + 上限 8 条推断
    expect(built.defaultEntryIds).toHaveLength(MAX_INFERRED_ENTRIES + 2);
    expect(built.defaultEntryIds.slice(0, 2)).toEqual(['人物0', '人物1']);
  });

  it('没有大纲也没有摘要时仍然是空的，不瞎猜', () => {
    // 猜不出来就老实空着，塞一堆无关设定比让用户自己勾更糟
    const built = builder.build(request({ entries: [entry('沈砚')] }));
    expect(built.defaultEntryIds).toEqual([]);
  });

  it('已删除的条目不会因为梗概提到就被勾上', () => {
    const built = builder.build(
      request({
        entries: [entry('沈砚')],
        // 「裴照」已经不在 entries 里了
        outline: [node('n1', { synopsis: '沈砚遇见裴照。', linkedEntryIds: ['裴照'] })],
        targetNodeId: 'n1',
      }),
    );
    expect(built.defaultEntryIds).toEqual(['沈砚']);
  });

  it('预选的条目真的进了稳定前缀', () => {
    const built = builder.build(
      request({
        entries: [entry('沈砚', { summary: '离乡寻母的少年' })],
        outline: [node('n1', { synopsis: '沈砚在渡口等船。' })],
        targetNodeId: 'n1',
      }),
    );
    expect(built.stablePrefix).toContain('离乡寻母的少年');
  });
});

describe('外传：按线过滤与外传说明', () => {
  const side = SideStorySchema.parse({
    id: 'side-a',
    novelId: 'n1',
    title: '青冥旧事',
    synopsis: '主线二十年前，沈砚的师父在青冥宗的往事。',
    rollingSummary: '师父刚拜入青冥宗。',
    createdAt: 0,
    updatedAt: 0,
  });
  const otherSide = SideStorySchema.parse({
    id: 'side-b',
    novelId: 'n1',
    title: '渡口',
    createdAt: 0,
    updatedAt: 0,
  });
  function sideChapter(storyId: string, index: number, overrides: Partial<Chapter> = {}): Chapter {
    return chapter(index, { id: `${storyId}-ch${index}`, sideStoryId: storyId, ...overrides });
  }
  const mainNovel = { ...novel, rollingSummary: '主线：沈砚已离开雪山。' };

  it('主线目标忽略外传章节：上一章、最近摘要、结尾只取主线，即便外传编号更大', () => {
    const built = builder.build(
      request({
        novel: mainNovel,
        sideStories: [side],
        chapters: [
          chapter(1, { content: '主线第一章结尾。' }),
          chapter(2, { content: '主线第二章结尾。' }),
          sideChapter('side-a', 1, { content: '外传第一章结尾。' }),
          sideChapter('side-a', 2, { content: '外传第二章结尾。' }),
          sideChapter('side-a', 5, { content: '外传第五章结尾。' }),
          chapter(3),
        ],
        summaries: [
          summary('ch1', { summary: '主线摘要一' }),
          summary('side-a-ch1', { summary: '外传摘要一' }),
          summary('side-a-ch2', { summary: '外传摘要二' }),
        ],
        targetChapterId: 'ch3',
      }),
    );

    expect(built.previousChapter?.id).toBe('ch2');
    expect(built.volatileSuffix).toContain('主线摘要一');
    expect(built.volatileSuffix).not.toContain('外传摘要');
    expect(built.volatileSuffix).toContain('主线第二章结尾。');
    expect(built.volatileSuffix).not.toContain('外传第');
    expect(built.volatileSuffix).toContain('【故事至此】');
    expect(built.items.find((item) => item.kind === 'rolling')?.id).toBe('rolling');
    expect(built.items.some((item) => item.kind === 'sideStory')).toBe(false);
  });

  it('没有目标章节时取主线最后一章，不取编号更大的外传章节', () => {
    const built = builder.build(
      request({
        sideStories: [side],
        chapters: [chapter(1), chapter(2), sideChapter('side-a', 9)],
      }),
    );
    expect(built.previousChapter?.id).toBe('ch2');
  });

  it('外传目标只取同一部外传的前文', () => {
    const built = builder.build(
      request({
        novel: mainNovel,
        sideStories: [side, otherSide],
        chapters: [
          chapter(1, { content: '主线第一章结尾。' }),
          chapter(2, { content: '主线第二章结尾。' }),
          sideChapter('side-b', 1, { content: '渡口第一章结尾。' }),
          sideChapter('side-a', 1, { content: '青冥第一章结尾。' }),
          sideChapter('side-a', 2),
        ],
        summaries: [
          summary('ch1', { summary: '主线摘要一' }),
          summary('side-b-ch1', { summary: '渡口摘要一' }),
          summary('side-a-ch1', { summary: '青冥摘要一' }),
        ],
        targetChapterId: 'side-a-ch2',
      }),
    );

    expect(built.previousChapter?.id).toBe('side-a-ch1');
    expect(built.volatileSuffix).toContain('青冥摘要一');
    expect(built.volatileSuffix).toContain('青冥第一章结尾。');
    expect(built.volatileSuffix).not.toContain('主线摘要一');
    expect(built.volatileSuffix).not.toContain('主线第二章结尾。');
    expect(built.volatileSuffix).not.toContain('渡口');
    expect(built.volatileSuffix).toContain('【上一章（外传第 1 章）的结尾原文】');
  });

  it('外传默认不注入主线进展，用外传进展写成【外传至此】', () => {
    const built = builder.build(
      request({
        novel: mainNovel,
        sideStories: [side],
        chapters: [sideChapter('side-a', 1)],
        targetChapterId: 'side-a-ch1',
      }),
    );

    expect(built.volatileSuffix).toContain('【外传至此】\n师父刚拜入青冥宗。');
    expect(built.volatileSuffix).not.toContain('主线：沈砚已离开雪山。');
    expect(built.volatileSuffix).not.toContain('【故事至此】');
    const rolling = built.items.filter((item) => item.kind === 'rolling');
    expect(rolling).toEqual([
      expect.objectContaining({ id: 'rolling-side', label: '外传进展摘要', included: true }),
    ]);
  });

  it('includeMainProgress 为 true 时注入主线进展并带标签，两条进展 id 不重复', () => {
    const built = builder.build(
      request({
        novel: mainNovel,
        sideStories: [side],
        chapters: [sideChapter('side-a', 1)],
        targetChapterId: 'side-a-ch1',
        includeMainProgress: true,
      }),
    );

    expect(built.volatileSuffix).toContain(
      '【主线进展（仅供参考，外传不必衔接它）】\n主线：沈砚已离开雪山。',
    );
    const rolling = built.items.filter((item) => item.kind === 'rolling');
    expect(rolling.map((item) => item.id)).toEqual(['rolling-side', 'rolling-main']);
    expect(rolling[1]?.label).toBe('主线全书进展（参考）');
    const keys = built.items.map((item) => `${item.kind}-${item.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('主线进展（参考）参与预算裁剪', () => {
    const built = builder.build(
      request({
        novel: { ...novel, rollingSummary: '主线很长。'.repeat(400) },
        sideStories: [side],
        chapters: [sideChapter('side-a', 1)],
        targetChapterId: 'side-a-ch1',
        includeMainProgress: true,
        budget: 200,
      }),
    );
    const mainProgress = built.items.find((item) => item.id === 'rolling-main');
    expect(mainProgress?.included).toBe(false);
    expect(mainProgress?.droppedReason).toBe('超出 token 预算');
    expect(built.volatileSuffix).not.toContain('主线很长。');
  });

  it('外传说明块是必收的，位于易变后缀', () => {
    const built = builder.build(
      request({
        sideStories: [side],
        chapters: [sideChapter('side-a', 1)],
        targetChapterId: 'side-a-ch1',
        budget: 1,
      }),
    );

    const brief = built.items.find((item) => item.kind === 'sideStory');
    expect(brief).toMatchObject({ id: 'side-a', label: '外传·青冥旧事 说明', included: true });
    expect(built.volatileSuffix).toContain('【本章属于外传《青冥旧事》】');
    expect(built.volatileSuffix).toContain('简介：主线二十年前，沈砚的师父在青冥宗的往事。');
    expect(built.volatileSuffix).toContain('外传独立于主线');
    expect(built.stablePrefix).not.toContain('青冥旧事');
  });

  it('外传简介为空时说明块里没有简介行', () => {
    const built = builder.build(
      request({
        sideStories: [otherSide],
        chapters: [sideChapter('side-b', 1)],
        targetChapterId: 'side-b-ch1',
      }),
    );
    expect(built.volatileSuffix).toContain('【本章属于外传《渡口》】');
    expect(built.volatileSuffix).not.toContain('简介');
    expect(built.volatileSuffix).not.toContain('（）');
  });

  it('外传章节没有大纲位置', () => {
    const built = builder.build(
      request({
        sideStories: [side],
        outline: [node('n1', { synopsis: '主线梗概' })],
        targetNodeId: 'n1',
        chapters: [sideChapter('side-a', 1)],
        targetChapterId: 'side-a-ch1',
      }),
    );
    expect(built.volatileSuffix).not.toContain('本章要写的内容');
    expect(built.items.some((item) => item.kind === 'outline')).toBe(false);
  });

  it('主线和外传选同一组条目时 stablePrefix 相同', () => {
    const shared = {
      novel: mainNovel,
      sideStories: [side],
      entries: [
        entry('灵气', { categoryId: worldCategory.id, pinned: true, summary: '天地能量' }),
        entry('沈砚', { summary: '离乡寻母的少年' }),
      ],
      selectedEntryIds: ['沈砚'],
      chapters: [chapter(1), chapter(2), sideChapter('side-a', 1), sideChapter('side-a', 2)],
    };
    const main = builder.build(request({ ...shared, targetChapterId: 'ch2' }));
    const sideBuilt = builder.build(
      request({ ...shared, targetChapterId: 'side-a-ch2', includeMainProgress: true }),
    );
    expect(sideBuilt.stablePrefix).toBe(main.stablePrefix);
    expect(sideBuilt.volatileSuffix).not.toBe(main.volatileSuffix);
  });

  it('外传简介参与默认预选的推断', () => {
    const built = builder.build(
      request({
        entries: [entry('沈砚'), entry('裴照')],
        sideStories: [side],
        chapters: [sideChapter('side-a', 1)],
        targetChapterId: 'side-a-ch1',
      }),
    );
    expect(built.defaultEntryIds).toEqual(['沈砚']);
  });

  it('外传摘要和结尾的标签是「外传第 N 章摘要」「外传第 N 章结尾原文」', () => {
    const built = builder.build(
      request({
        sideStories: [side],
        chapters: [
          sideChapter('side-a', 1, { content: '外传第一章结尾。' }),
          sideChapter('side-a', 2),
        ],
        summaries: [summary('side-a-ch1', { summary: '青冥摘要一' })],
        targetChapterId: 'side-a-ch2',
      }),
    );
    expect(built.items.find((item) => item.kind === 'summary')?.label).toBe('外传第 1 章摘要');
    expect(built.items.find((item) => item.kind === 'tail')).toMatchObject({
      id: 'side-a-ch1',
      label: '外传第 1 章结尾原文',
    });
  });

  it('外传目标但 sideStories 里没有这部外传：只取同一外传前文，不注入主线进展，没有说明块', () => {
    const input = {
      novel: mainNovel,
      entries: [entry('沈砚'), entry('裴照')],
      chapters: [
        chapter(1, { content: '主线第一章结尾。' }),
        sideChapter('side-a', 1, { content: '外传第一章结尾。' }),
        sideChapter('side-a', 2),
      ],
      summaries: [
        summary('ch1', { summary: '主线摘要：裴照登场' }),
        summary('side-a-ch1', { summary: '外传摘要一' }),
      ],
      targetChapterId: 'side-a-ch2',
    };
    const built = builder.build(request(input));

    expect(built.previousChapter?.id).toBe('side-a-ch1');
    expect(built.volatileSuffix).toContain('外传摘要一');
    expect(built.volatileSuffix).toContain('外传第一章结尾。');
    expect(built.volatileSuffix).not.toContain('主线');
    expect(built.items.some((item) => item.kind === 'rolling')).toBe(false);
    expect(built.items.some((item) => item.kind === 'sideStory')).toBe(false);
    expect(built.defaultEntryIds).toEqual([]);

    // 用户明确打开时，主线进展照常作为参考注入
    const withMain = builder.build(request({ ...input, includeMainProgress: true }));
    expect(withMain.items.filter((item) => item.kind === 'rolling').map((item) => item.id)).toEqual(
      ['rolling-main'],
    );
  });
});

describe('写作规范注入', () => {
  // 风格档案带非空 extraInstruction，保证【文风】段存在，再断言规范排在它之后
  const styled = StyleProfileSchema.parse({
    ...style,
    voiceRefs: [{ refId: 'gulong', name: '古龙', weight: 70 }],
    extraInstruction: '每章结尾留钩子。',
  });

  function norm(id: string, overrides: Partial<WritingNorm> = {}): WritingNorm {
    return WritingNormSchema.parse({
      id,
      novelId: 'n1',
      title: id,
      content: `- ${id} 的规则【标记 ${id}】`,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    });
  }

  const pinnedEntry = entry('灵气', {
    categoryId: worldCategory.id,
    pinned: true,
    summary: '天地能量',
  });

  it('位于作品信息与风格档案之后、核心设定之前', () => {
    const built = builder.build(
      request({ style: styled, entries: [pinnedEntry], writingNorms: [norm('使用提示')] }),
    );
    const prefix = composeStylePrefix(novel, styled);
    const normAt = built.stablePrefix.indexOf('【作者的写作规范】');

    expect(prefix).toContain('【文风】');
    expect(built.stablePrefix.startsWith(prefix)).toBe(true);
    expect(normAt).toBeGreaterThanOrEqual(prefix.length);
    expect(built.stablePrefix.indexOf('【规范《使用提示》】')).toBeGreaterThan(normAt);
    expect(built.stablePrefix.indexOf('【必须遵守的核心设定】')).toBeGreaterThan(
      built.stablePrefix.indexOf('【规范《使用提示》结束】'),
    );
    // 规范属于整本书的底色，不随章节变化，不进易变后缀
    expect(built.volatileSuffix).not.toContain('标记 使用提示');
  });

  it('停用的、作用范围不含「写正文」的规范不注入', () => {
    const built = builder.build(
      request({
        writingNorms: [
          norm('停用', { enabled: false }),
          norm('只提取', { scopes: ['extract'] }),
          norm('启用'),
        ],
      }),
    );

    expect(built.stablePrefix).toContain('【标记 启用】');
    expect(built.stablePrefix).not.toContain('【标记 停用】');
    expect(built.stablePrefix).not.toContain('【标记 只提取】');
    expect(built.items.filter((item) => item.kind === 'norm').map((item) => item.id)).toEqual([
      '启用',
    ]);
  });

  it('两份规范按 order 注入，与传入顺序无关；两次构建逐字节相同', () => {
    const first = norm('甲', { order: 0 });
    const second = norm('乙', { order: 1 });
    const built = builder.build(request({ writingNorms: [second, first] }));
    const again = builder.build(request({ writingNorms: [first, second] }));

    expect(built.stablePrefix.indexOf('【规范《甲》】')).toBeLessThan(
      built.stablePrefix.indexOf('【规范《乙》】'),
    );
    expect(again.stablePrefix).toBe(built.stablePrefix);
    expect(again.volatileSuffix).toBe(built.volatileSuffix);
    const twice = builder.build(request({ writingNorms: [second, first] }));
    expect(twice.stablePrefix).toBe(built.stablePrefix);
    expect(twice.volatileSuffix).toBe(built.volatileSuffix);
  });

  it('注入清单里每份规范一项，tokens 与 normTokens 同口径', () => {
    const target = norm('使用提示', { content: '- 一条规则\n- another rule' });
    const built = builder.build(request({ writingNorms: [target] }));
    const item = built.items.find((candidate) => candidate.kind === 'norm');

    expect(item).toEqual({
      kind: 'norm',
      id: '使用提示',
      label: '写作规范 · 使用提示',
      tokens: normTokens(target),
      included: true,
    });
  });

  it('本次临时排除的规范既不进 prompt 也不进清单', () => {
    const built = builder.build(
      request({ writingNorms: [norm('甲'), norm('乙')], excludedNormIds: ['甲'] }),
    );

    expect(built.stablePrefix).not.toContain('【标记 甲】');
    expect(built.stablePrefix).toContain('【标记 乙】');
    expect(built.items.some((item) => item.id === '甲')).toBe(false);

    const allExcluded = builder.build(
      request({ writingNorms: [norm('甲')], excludedNormIds: ['甲'] }),
    );
    expect(allExcluded.stablePrefix).not.toContain('【作者的写作规范】');
    expect(allExcluded.items.some((item) => item.kind === 'norm')).toBe(false);
  });

  it('规范不参与预算裁剪，勾选条目照常被挤出', () => {
    const big = norm('长规范', { content: '很长的规范内容'.repeat(200) });
    const selectedEntry = entry('裴照', { summary: '剑客'.repeat(40) });
    const built = builder.build(
      request({
        writingNorms: [big],
        entries: [selectedEntry],
        selectedEntryIds: ['裴照'],
        budget: 50,
      }),
    );

    expect(built.items.find((item) => item.kind === 'norm')?.included).toBe(true);
    const dropped = built.items.find((item) => item.id === '裴照');
    expect(dropped?.included).toBe(false);
    expect(dropped?.droppedReason).toBe('超出 token 预算');
  });

  it('外传章节与主线章节的稳定前缀相同（含规范）', () => {
    const side = SideStorySchema.parse({
      id: 'side-a',
      novelId: 'n1',
      title: '青冥旧事',
      createdAt: 0,
      updatedAt: 0,
    });
    const shared = {
      style: styled,
      entries: [pinnedEntry],
      sideStories: [side],
      writingNorms: [norm('使用提示')],
      chapters: [chapter(1), chapter(1, { id: 'side-ch1', sideStoryId: 'side-a' })],
    };
    const main = builder.build(request({ ...shared, targetChapterId: 'ch1' }));
    const sideBuilt = builder.build(request({ ...shared, targetChapterId: 'side-ch1' }));

    expect(main.stablePrefix).toContain('【标记 使用提示】');
    expect(sideBuilt.stablePrefix).toBe(main.stablePrefix);
  });
});

describe('推演章节（scenarioContext，设计 D7.3 + design-addendum 第 2 条）', () => {
  const scenarioContext = {
    label: '互动推演 · 第 1–4 步原文',
    limitedText: '【本章涉及的推演专属设定】\n## 阿七（人物）\n说话方式：结巴',
    limitedLabel: '推演专属设定（主角『阿七』等 1 条）',
    forkText: '【分叉之前的经过（与主线共用，外传不要重写这部分）】\n雾起。',
    stepsText: '【本章依据的互动推演】\n\n第 1 步 · 开局\n沈砚醒来。',
    stateText:
      '【这条世界线在本章开始时的状态（与上文设定冲突时以这里为准，底层字段除外）】\n\n状态：\n- 裴照：被俘',
    castEntryIds: [] as string[],
    hintText: '',
  };
  const volume = node('vol', { title: '第一卷' });
  const target = node('ch-node', {
    title: '第1章 雾里的船',
    synopsis: '找到空船。',
    parentId: 'vol',
  });
  const shen = entry('沈砚', { fields: { voice: '话少，句尾不带语气词' } });
  const pei = entry('裴照');
  const base = () =>
    request({
      entries: [shen, pei],
      outline: [volume, target],
      chapters: [chapter(1, { outlineNodeId: 'ch-node' })],
      targetNodeId: 'ch-node',
      targetChapterId: 'ch1',
      novel: { ...novel, rollingSummary: '故事走到渡口。' },
    });

  it('不传时与没有这个字段完全相同', () => {
    const plain = builder.build(base());
    expect(builder.build({ ...base(), scenarioContext: undefined })).toEqual(plain);
    expect(plain.items.some((item) => item.kind === 'scenario')).toBe(false);
  });

  it('四块在大纲位置之后、【故事至此】之前按顺序出现；stablePrefix 不变；四项必选且 id 互异', () => {
    const plain = builder.build(base());
    const built = builder.build({ ...base(), scenarioContext });
    expect(built.stablePrefix).toBe(plain.stablePrefix);
    const suffix = built.volatileSuffix;
    const positions = [
      '【本章要写的内容】',
      '【本章涉及的推演专属设定】',
      '【分叉之前的经过',
      '【本章依据的互动推演】',
      '【这条世界线在本章开始时的状态',
      '【故事至此】',
    ].map((marker) => suffix.indexOf(marker));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    const items = built.items.filter((item) => item.kind === 'scenario');
    expect(items.map((item) => item.id)).toEqual([
      'scenario-limited',
      'scenario-fork',
      'scenario-steps',
      'scenario-state',
    ]);
    expect(items.map((item) => item.label)).toEqual([
      '推演专属设定（主角『阿七』等 1 条）',
      '分叉之前的经过',
      '互动推演 · 第 1–4 步原文',
      '世界线状态',
    ]);
    expect(items.every((item) => item.included)).toBe(true);
  });

  it('小预算下四块仍然注入', () => {
    const built = builder.build({ ...base(), budget: 10, scenarioContext });
    expect(
      built.items.filter((item) => item.kind === 'scenario').every((item) => item.included),
    ).toBe(true);
    expect(built.volatileSuffix).toContain('沈砚醒来。');
  });

  it('空串的块不渲染、不进清单', () => {
    const built = builder.build({
      ...base(),
      scenarioContext: { ...scenarioContext, limitedText: '', forkText: '' },
    });
    expect(built.volatileSuffix).not.toContain('【本章涉及的推演专属设定】');
    expect(built.volatileSuffix).not.toContain('【分叉之前的经过');
    expect(built.items.filter((item) => item.kind === 'scenario').map((item) => item.id)).toEqual([
      'scenario-steps',
      'scenario-state',
    ]);
  });

  it('有 / 无对照：有时通用主角进默认预选（显式档），无时与现在相同', () => {
    const without = builder.build(base());
    expect(without.defaultEntryIds).toEqual([]);
    const withCast = builder.build({
      ...base(),
      scenarioContext: { ...scenarioContext, castEntryIds: [shen.id] },
    });
    expect(withCast.defaultEntryIds).toEqual([shen.id]);
    // 默认预选进了前缀的【相关设定】：主角的「说话方式」随整章生成一起发出
    expect(withCast.stablePrefix).toContain('话少，句尾不带语气词');
  });

  it('castEntryIds 里已删除、pinned、不在条目列表里的都不进预选', () => {
    const gone = entry('旧人', { deletedAt: 1 });
    const core = entry('核心', { pinned: true });
    const built = builder.build({
      ...base(),
      entries: [shen, pei, gone, core],
      scenarioContext: { ...scenarioContext, castEntryIds: [gone.id, core.id, 'missing'] },
    });
    expect(built.defaultEntryIds).toEqual([]);
  });

  it('hintText 参与名称匹配：本章步骤原文里提到的人物进推断档', () => {
    const without = builder.build(base());
    expect(without.defaultEntryIds).not.toContain(pei.id);
    const built = builder.build({
      ...base(),
      scenarioContext: { ...scenarioContext, hintText: '裴照在船头等他。' },
    });
    expect(built.defaultEntryIds).toEqual([pei.id]);
  });
});

describe('文风锚点（M4 S1）', () => {
  const writingNorm = WritingNormSchema.parse({
    id: 'norm-anchor',
    novelId: 'n1',
    title: '使用提示',
    content: '- 不要写招式名。【标记 ANCHOR】',
    createdAt: 0,
    updatedAt: 0,
  });

  /** 400 字、已完成的一章：足够成为锚点 */
  const anchorChapter = () =>
    chapter(1, {
      id: 'ch1',
      content: `第一个早晨。\n\n${'江雾'.repeat(200)}`,
      status: 'done',
    });

  it('有更早已完成正文时注入锚点：风格之后、规范之前，独立 item 可见', () => {
    const built = builder.build(
      request({
        writingNorms: [writingNorm],
        chapters: [anchorChapter(), chapter(2)],
        targetChapterId: 'ch2',
      }),
    );

    expect(built.stablePrefix).toContain('【文风锚点 · 第 1 章开头（作者本人原文）】');
    expect(built.stablePrefix).toContain('只用来对齐句式、节奏与叙述距离');
    const anchorAt = built.stablePrefix.indexOf('【文风锚点');
    const styleAt = built.stablePrefix.indexOf('【文体取向】');
    const normAt = built.stablePrefix.indexOf('【作者的写作规范】');
    expect(anchorAt).toBeGreaterThan(styleAt);
    expect(anchorAt).toBeLessThan(normAt);

    const anchorItem = built.items.find((item) => item.kind === 'styleAnchor');
    expect(anchorItem).toMatchObject({
      id: 'ch1',
      label: '文风锚点 · 第 1 章开头',
      included: true,
    });
    expect(anchorItem!.tokens).toBeGreaterThan(0);
    // 清单顺序与 prompt 一致：meta → styleAnchor → norm
    const kinds = built.items.map((item) => item.kind);
    expect(kinds.indexOf('styleAnchor')).toBeGreaterThan(kinds.indexOf('meta'));
    expect(kinds.indexOf('styleAnchor')).toBeLessThan(kinds.indexOf('norm'));
  });

  it('预算不足时锚点进 dropped：文本不进前缀、清单可见原因', () => {
    const built = builder.build(
      request({
        writingNorms: [writingNorm],
        chapters: [anchorChapter(), chapter(2)],
        targetChapterId: 'ch2',
        budget: 1,
      }),
    );

    expect(built.stablePrefix).not.toContain('【文风锚点');
    expect(built.items.find((item) => item.kind === 'styleAnchor')).toMatchObject({
      included: false,
      droppedReason: '超出 token 预算',
    });
  });

  it('第一章 / 只有更晚正文时不产生锚点项，稳定前缀逐字节不变', () => {
    const only = builder.build(
      request({
        chapters: [chapter(1, { content: '首章正文。'.repeat(80) })],
        targetChapterId: 'ch1',
      }),
    );
    const withLater = builder.build(
      request({
        chapters: [
          chapter(1, { content: '首章正文。'.repeat(80) }),
          chapter(2, { content: '后续正文。'.repeat(80) }),
        ],
        targetChapterId: 'ch1',
      }),
    );

    expect(only.items.some((item) => item.kind === 'styleAnchor')).toBe(false);
    expect(only.stablePrefix).not.toContain('【文风锚点');
    expect(withLater.stablePrefix).toBe(only.stablePrefix);
  });

  it('外传章节的锚点标签带「外传第」，且只取同一线', () => {
    const side = SideStorySchema.parse({
      id: 'side-a',
      novelId: 'n1',
      title: '青冥旧事',
      createdAt: 0,
      updatedAt: 0,
    });
    const built = builder.build(
      request({
        sideStories: [side],
        chapters: [
          chapter(1, { content: '主线正文。'.repeat(100), status: 'done' }),
          chapter(1, {
            id: 'side-ch1',
            sideStoryId: 'side-a',
            content: '外传正文。'.repeat(100),
            status: 'done',
          }),
          chapter(2, { id: 'side-ch2', sideStoryId: 'side-a' }),
        ],
        targetChapterId: 'side-ch2',
      }),
    );

    expect(built.stablePrefix).toContain('【文风锚点 · 外传第 1 章开头（作者本人原文）】');
  });
});
