import { create } from 'zustand';

/**
 * 「本章采用了未完成生成稿」的会话内留痕。
 *
 * 文学顾问评审 P0：截断/中断稿采用后如果没有任何痕迹，回到编辑器就是一段
 * 普通草稿，作者关掉页面就会忘了这章只写了一半 —— 半章被当成定稿是写作工具
 * 最容易犯、也最难事后发现的错。
 *
 * 刻意**只放内存、不落库**（D7 零迁移）：
 * - 它描述的是「本次会话里的这次采用」，属于流程状态而不是作品数据；
 * - 落库要加 Chapter 字段 + Dexie/备份版本升级，为一个临时提示不值得；
 * - 刷新后痕迹消失的代价可以接受：正文本身在，作者也能自己判断有没有结尾。
 * 但标记必须是**显式清除**的（切「已完成」或完整采用），不能因为自动保存就消失。
 */
interface IncompleteDraftsState {
  /** 已标记的章节 id。用 Record 而不是 Set：zustand 里每次 set 新对象更直观 */
  chapterIds: Record<string, true>;
  markIncomplete: (chapterId: string) => void;
  clearIncomplete: (chapterId: string) => void;
}

export const useIncompleteDrafts = create<IncompleteDraftsState>((set) => ({
  chapterIds: {},
  markIncomplete: (chapterId) =>
    set((state) =>
      state.chapterIds[chapterId]
        ? state
        : { chapterIds: { ...state.chapterIds, [chapterId]: true } },
    ),
  clearIncomplete: (chapterId) =>
    set((state) => {
      if (!state.chapterIds[chapterId]) return state;
      const next = { ...state.chapterIds };
      delete next[chapterId];
      return { chapterIds: next };
    }),
}));

/** 组件用：本章是否有「未完成生成稿」留痕 */
export function useIncompleteDraft(chapterId: string): boolean {
  return useIncompleteDrafts((state) => state.chapterIds[chapterId] === true);
}
