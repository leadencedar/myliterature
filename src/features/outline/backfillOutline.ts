/**
 * 回溯大纲的计划（M3 S1）。
 *
 * 存量作者导入作品后常常有几十章正文、却没有大纲树：没有大纲就用不了「写这一章」
 * 的上下文链，也看不到全书结构。这里做纯确定性的 1:1 映射 —— 一章一个顶层节点，
 * 标题与摘要取自已有数据，不调模型、不发明内容；作者确认后才写库。
 *
 * 不自动分卷：分卷是结构判断，1:1 回溯只承诺「把已有章节列进大纲」，
 * 分卷留给作者手动做。
 *
 * 不写 targetWords：旧稿的「章节现有字数」是历史事实，不是写作目标。
 * 把它写成节点目标，大纲树会显示「目标 260 字」并被误读成「这一章应该写 260 字」；
 * 现有字数留给 UI 预览当参考展示，节点目标留空（null）。
 */
import type { Chapter, ChapterSummary, OutlineNode } from '@/domain/schema';
import { chaptersOfTrack } from '@/domain/sideStory';

export interface BackfillOutlinePlanItem {
  chapterId: string;
  /** 章节序号（主线内从 1 起），用于「第 N 章」展示 */
  index: number;
  title: string;
  synopsis: string;
  /**
   * 恒为 null：回溯只建结构，不设写作目标。
   * 字段保留是为了与 `OutlineBackfillInputItem` 的形状一致（仓储仍接受显式目标）。
   */
  targetWords: null;
  status: OutlineNode['status'];
}

/**
 * 生成回溯计划。只处理主线（外传章节在外传自己的章节列表里，不混进主线大纲）。
 * 相同输入必须给出逐字节相同的计划（无时间、无随机、排序显式）。
 */
export function planOutlineBackfill(
  chapters: readonly Chapter[],
  summaries: readonly ChapterSummary[],
): BackfillOutlinePlanItem[] {
  const summaryByChapter = new Map(
    summaries.map((summary) => [summary.chapterId, summary] as const),
  );

  return (
    chaptersOfTrack(chapters, null)
      // 已挂大纲的章节不再建第二个节点：重复执行必须是 no-op，而不是长出第二套大纲
      .filter((chapter) => chapter.outlineNodeId === null)
      // 标题与正文都为空的章节没有可回填的内容，硬建节点只会在大纲里留一个空壳
      .filter((chapter) => chapter.title.trim().length > 0 || chapter.content.trim().length > 0)
      .map((chapter) => ({
        chapterId: chapter.id,
        index: chapter.index,
        // 空标题回退「第 N 章」：节点在大纲树里总要有个可辨认的名字
        title: chapter.title.trim() || `第 ${chapter.index} 章`,
        synopsis: summaryByChapter.get(chapter.id)?.summary.trim() ?? '',
        // 现有字数不进节点目标（见文件头注释），UI 预览另行展示
        targetWords: null,
        // 章节只有 draft/done 两种；已完成回填 done，其余按 planned（作者可再手动改）
        status: chapter.status === 'done' ? ('done' as const) : ('planned' as const),
      }))
  );
}
