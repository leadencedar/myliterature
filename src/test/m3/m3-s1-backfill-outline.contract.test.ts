/**
 * M3-S1 独立验收：导入作品 1:1 回溯大纲（数据层）。
 *
 * 覆盖 task-49 要求：纯函数顺序/跳过已挂/空章节/确定性；仓储事务 1:1 映射、
 * 部分跳过、重复执行不重复、全跳过抛错、跨作品保护、失败整体回滚。
 *
 * 独立于开发的 backfillOutline.test.ts / DexieNovelRepository.test.ts：
 * 用真实 Dexie 仓储（createTestHarness）+ 自建章节/摘要夹具。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chapter, Novel } from '@/domain/schema';
import {
  planOutlineBackfill,
  type BackfillOutlinePlanItem,
} from '@/features/outline/backfillOutline';
import type { OutlineBackfillInputItem } from '@/data/NovelRepository';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';

let harness: TestHarness;
let novel: Novel;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '回溯之书', genre: '仙侠' });
});

afterEach(async () => {
  await harness.cleanup();
});

// ---------------------------------------------------------------- fixtures

async function makeChapter(
  title: string,
  content = '这一章有正文。',
  index?: number,
): Promise<Chapter> {
  return harness.repository.createChapter(novel.id, {
    title,
    content,
    ...(index === undefined ? {} : { index }),
  });
}

async function addSummary(chapter: Chapter, summary: string): Promise<void> {
  await harness.repository.upsertSummary(novel.id, chapter.id, {
    summary,
    keyEvents: [],
    appearingEntryIds: [],
    openThreads: [],
  });
}

/** 把计划项转成仓储入参（计划里多一个 index，仓储不接收） */
function toInput(item: BackfillOutlinePlanItem): OutlineBackfillInputItem {
  return {
    chapterId: item.chapterId,
    title: item.title,
    synopsis: item.synopsis,
    targetWords: item.targetWords,
    status: item.status,
  };
}

async function outline() {
  return harness.repository.listOutline(novel.id);
}

// ---------------------------------------------------------------- 纯函数

describe('M3-S1 · planOutlineBackfill 纯函数', () => {
  it('按 index 顺序 1:1 映射：标题回退、摘要来源、不设写作目标（targetWords=null）、状态映射', async () => {
    const ch1 = await makeChapter('雪夜');
    await addSummary(ch1, '  沈砚雪夜突围。  ');
    const ch2 = await makeChapter('草稿章');
    await harness.repository.updateChapter(ch2.id, { title: '', content: '只有正文没有标题。' });
    const ch3 = await makeChapter('灯', '');
    await harness.repository.updateChapter(ch3.id, { status: 'done' });

    const chapters = await harness.repository.listChapters(novel.id);
    const summaries = await harness.repository.listSummaries(novel.id);
    const plan = planOutlineBackfill(chapters, summaries);

    expect(plan).toHaveLength(3);
    expect(plan.map((item) => item.index)).toEqual([1, 2, 3]);
    expect(plan.map((item) => item.chapterId)).toEqual([ch1.id, ch2.id, ch3.id]);
    expect(plan[0]).toMatchObject({
      title: '雪夜',
      synopsis: '沈砚雪夜突围。',
      status: 'planned',
    });
    // task-51：旧稿现有字数不是写作目标，回溯节点一律不设 targetWords
    expect(plan.every((item) => item.targetWords === null)).toBe(true);
    // 空标题回退「第 N 章」；无摘要给空串（不阻塞）
    expect(plan[1]).toMatchObject({ title: '第 2 章', synopsis: '' });
    // 0 字章同样 null；done → done
    expect(plan[2]).toMatchObject({ title: '灯', targetWords: null, status: 'done' });
  });

  it('跳过已挂大纲的章节与空章节（标题正文都空）', async () => {
    const ch1 = await makeChapter('已挂章');
    const ch2 = await makeChapter('空壳章');
    const ch3 = await makeChapter('待回填章');
    await harness.repository.updateChapter(ch2.id, { title: '', content: '' });
    const node = await harness.repository.createOutlineNode(novel.id, { title: '手工节点' });
    await harness.repository.updateChapter(ch1.id, { outlineNodeId: node.id });

    const chapters = await harness.repository.listChapters(novel.id);
    const plan = planOutlineBackfill(chapters, []);

    expect(plan.map((item) => item.chapterId)).toEqual([ch3.id]);
  });

  it('确定性：相同输入两次输出逐字节一致，且不修改入参', async () => {
    await makeChapter('甲');
    await makeChapter('乙');
    const chapters = await harness.repository.listChapters(novel.id);
    const before = JSON.stringify(chapters);

    const first = planOutlineBackfill(chapters, []);
    const second = planOutlineBackfill(chapters, []);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(chapters)).toBe(before);
  });

  it('无章节 → 空计划', () => {
    expect(planOutlineBackfill([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------- 仓储事务

describe('M3-S1 · commitOutlineBackfill 事务', () => {
  it('1:1 创建顶层节点并回填章节关联；正文/编号/标题不变', async () => {
    const ch1 = await makeChapter('第一章');
    const ch2 = await makeChapter('第二章');
    await harness.repository.updateChapter(ch2.id, { status: 'done' });
    const chaptersBefore = await harness.repository.listChapters(novel.id);
    const plan = planOutlineBackfill(chaptersBefore, []);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.chapterId).toBe(ch1.id);

    const created = await harness.repository.commitOutlineBackfill(novel.id, plan.map(toInput));

    expect(created).toHaveLength(2);
    expect(created.map((node) => node.parentId)).toEqual([null, null]);
    expect(created.map((node) => node.order)).toEqual([0, 1]);
    expect(created.map((node) => node.title)).toEqual(['第一章', '第二章']);
    expect(created[1]!.status).toBe('done');

    const chaptersAfter = await harness.repository.listChapters(novel.id);
    expect(chaptersAfter.map((chapter) => chapter.outlineNodeId)).toEqual(
      created.map((node) => node.id),
    );
    // 只写 outlineNodeId/updatedAt：正文、编号、标题、状态不变
    expect(
      chaptersAfter.map((chapter) => ({
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        content: chapter.content,
        status: chapter.status,
        wordCount: chapter.wordCount,
      })),
    ).toEqual(
      chaptersBefore.map((chapter) => ({
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        content: chapter.content,
        status: chapter.status,
        wordCount: chapter.wordCount,
      })),
    );
    expect(await outline()).toHaveLength(2);
    // 章节与节点一一对应：节点 title/synopsis/targetWords 来自计划
    expect(created[0]).toMatchObject({
      title: plan[0]!.title,
      synopsis: plan[0]!.synopsis,
      targetWords: plan[0]!.targetWords,
    });
  });

  it('部分跳过：计划后已被别的入口关联的章节不覆盖，其余照建', async () => {
    await makeChapter('第一章');
    const ch2 = await makeChapter('第二章');
    await makeChapter('第三章');
    const nodesBefore = await outline();
    expect(nodesBefore).toEqual([]);

    const plan = planOutlineBackfill(await harness.repository.listChapters(novel.id), []);
    expect(plan).toHaveLength(3);
    // 模拟计划到确认之间，第二章被手动挂到另一个节点
    const manual = await harness.repository.createOutlineNode(novel.id, { title: '手动' });
    await harness.repository.updateChapter(ch2.id, { outlineNodeId: manual.id });

    const created = await harness.repository.commitOutlineBackfill(novel.id, plan.map(toInput));

    expect(created).toHaveLength(2);
    expect(created.map((node) => node.title)).toEqual(['第一章', '第三章']);
    // 接在已有顶层节点之后排序
    expect(created.map((node) => node.order)).toEqual([1, 2]);
    const chaptersAfter = await harness.repository.listChapters(novel.id);
    const ch2After = chaptersAfter.find((chapter) => chapter.id === ch2.id)!;
    expect(ch2After.outlineNodeId).toBe(manual.id); // 不覆盖手动关联
  });

  it('重复执行不重复建节点：全部已挂后计划为空，空批次直接拒绝', async () => {
    await makeChapter('第一章');
    await makeChapter('第二章');
    const plan = planOutlineBackfill(await harness.repository.listChapters(novel.id), []);
    await harness.repository.commitOutlineBackfill(novel.id, plan.map(toInput));
    const countAfterFirst = (await outline()).length;

    const replan = planOutlineBackfill(await harness.repository.listChapters(novel.id), []);
    expect(replan).toEqual([]);
    await expect(harness.repository.commitOutlineBackfill(novel.id, [])).rejects.toThrow(
      /没有可回填的章节/u,
    );
    expect(await outline()).toHaveLength(countAfterFirst);
  });

  it('计划过期（全部在确认前被关联）：抛错且不写任何节点', async () => {
    const ch1 = await makeChapter('第一章');
    const plan = planOutlineBackfill(await harness.repository.listChapters(novel.id), []);
    const manual = await harness.repository.createOutlineNode(novel.id, { title: '并发节点' });
    await harness.repository.updateChapter(ch1.id, { outlineNodeId: manual.id });

    await expect(
      harness.repository.commitOutlineBackfill(novel.id, plan.map(toInput)),
    ).rejects.toThrow(/没有可回填的章节/u);
    expect(await outline()).toHaveLength(1);
    expect(await harness.repository.listOutline(novel.id)).toHaveLength(1);
  });

  it('跨作品保护：别的作品的章节静默跳过；混入合法项时只建合法项', async () => {
    const other = await harness.repository.createNovel({ title: '别的书' });
    const foreign = await harness.repository.createChapter(other.id, {
      title: '外书章节',
      content: '外书正文。',
    });
    const mine = await makeChapter('本书章节');

    const created = await harness.repository.commitOutlineBackfill(novel.id, [
      {
        chapterId: foreign.id,
        title: '外书章节',
        synopsis: '',
        targetWords: null,
        status: 'planned',
      },
      {
        chapterId: mine.id,
        title: '本书章节',
        synopsis: '',
        targetWords: null,
        status: 'planned',
      },
    ]);

    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe('本书章节');
    // 外书章节不受影响
    const foreignAfter = await harness.repository.listChapters(other.id);
    expect(foreignAfter[0]!.outlineNodeId).toBeNull();
  });

  it('事务失败整体回滚：坏节点数据导致中途抛错时，节点与关联都不落库', async () => {
    const ch1 = await makeChapter('第一章');
    const ch2 = await makeChapter('第二章');
    const before = await harness.repository.listChapters(novel.id);

    // 第二项 targetWords 非正数会让 OutlineNodeSchema.parse 抛错（首项已写入后触发回滚）
    const badItems = [
      { chapterId: ch1.id, title: '第一章', synopsis: '', targetWords: null, status: 'planned' },
      {
        chapterId: ch2.id,
        title: '第二章',
        synopsis: '',
        targetWords: Number.NaN,
        status: 'planned',
      },
    ] as unknown as OutlineBackfillInputItem[];

    await expect(harness.repository.commitOutlineBackfill(novel.id, badItems)).rejects.toThrow();

    expect(await outline()).toEqual([]);
    const after = await harness.repository.listChapters(novel.id);
    expect(after.map((chapter) => chapter.outlineNodeId)).toEqual(before.map(() => null));
  });
});
