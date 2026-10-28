import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { planOutlineBackfill } from './backfillOutline';

let harness: TestHarness;
let novelId: string;

beforeEach(async () => {
  harness = await createTestHarness();
  const novel = await harness.repository.createNovel({ title: '归墟纪', genre: '仙侠' });
  novelId = novel.id;
});

afterEach(async () => {
  await harness.cleanup();
});

async function plan() {
  return planOutlineBackfill(
    await harness.repository.listChapters(novelId),
    await harness.repository.listSummaries(novelId),
  );
}

describe('回溯大纲计划（纯函数，无 AI）', () => {
  it('按主线章节顺序 1:1 生成，标题/摘要/状态取自现有数据，不设目标字数', async () => {
    const chapter1 = await harness.repository.createChapter(novelId, {
      title: '第1章 渡口',
      content: '林越在渡口醒来。',
    });
    await harness.repository.updateChapter(chapter1.id, { status: 'done' });
    const chapter2 = await harness.repository.createChapter(novelId, {
      title: '',
      content: '裴照把刀递给他。',
    });
    await harness.repository.upsertSummary(novelId, chapter1.id, {
      summary: '林越在渡口醒来。',
      keyEvents: ['林越醒来'],
    });

    // 外传章节走外传自己的列表，不该混进主线大纲
    const story = await harness.repository.createSideStory(novelId, { title: '青冥旧事' });
    await harness.repository.createChapter(novelId, {
      title: '外传第1章',
      content: '少年裴照走进六扇门。',
      sideStoryId: story.id,
    });

    const items = await plan();

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      chapterId: chapter1.id,
      index: 1,
      title: '第1章 渡口',
      synopsis: '林越在渡口醒来。',
      // 回溯只建结构：现有字数不写成节点目标（文学顾问 P1）
      targetWords: null,
      status: 'done',
    });
    expect(items[1]).toMatchObject({
      chapterId: chapter2.id,
      index: 2,
      // 空标题回退「第 N 章」
      title: '第 2 章',
      // 没有摘要不阻塞，梗概留空
      synopsis: '',
      targetWords: null,
      status: 'planned',
    });
  });

  it('跳过已挂大纲的章节与标题正文都为空的章节', async () => {
    const linked = await harness.repository.createChapter(novelId, {
      title: '第1章 已挂',
      content: '已经有大纲节点。',
    });
    const node = await harness.repository.createOutlineNode(novelId, { title: '已有的卷' });
    await harness.repository.updateChapter(linked.id, { outlineNodeId: node.id });
    await harness.repository.createChapter(novelId, { title: '', content: '' });
    const pending = await harness.repository.createChapter(novelId, {
      title: '第3章 待回填',
      content: '这一章还没有大纲。',
    });

    const items = await plan();

    expect(items.map((item) => item.chapterId)).toEqual([pending.id]);
    // 空章节被跳过，序号仍是原章节序号
    expect(items[0]!.index).toBe(3);
  });

  it('所有条目 targetWords 一律 null：旧稿现有字数不是写作目标', async () => {
    await harness.repository.createChapter(novelId, {
      title: '第1章 只有标题',
    });
    await harness.repository.createChapter(novelId, {
      title: '第2章 有正文',
      content: '这一章已经写了两千字，但回溯不该把它变成目标。',
    });

    const items = await plan();

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.targetWords)).toEqual([null, null]);
  });

  it('全部章节都已挂大纲时返回空计划（由仓储在提交时拒绝）', async () => {
    const chapter = await harness.repository.createChapter(novelId, {
      title: '第1章',
      content: '正文',
    });
    const node = await harness.repository.createOutlineNode(novelId, { title: '卷一' });
    await harness.repository.updateChapter(chapter.id, { outlineNodeId: node.id });

    expect(await plan()).toEqual([]);
  });

  it('确定性：相同输入两次生成的计划逐字段一致', async () => {
    await harness.repository.createChapter(novelId, { title: '第1章', content: '正文一' });
    await harness.repository.createChapter(novelId, { title: '', content: '正文二' });

    expect(await plan()).toEqual(await plan());
  });
});
