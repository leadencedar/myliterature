import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ActiveNovelState {
  /** 当前正在创作的小说 id；知识库 / 写作 / 计划三个 Tab 都以它为上下文 */
  activeNovelId: string | null;
  setActiveNovel: (id: string | null) => void;
}

/**
 * 「当前作品」全局状态，持久化到 localStorage。
 * 重开应用时能回到上次写的那本书，省掉一次选择。
 */
export const useActiveNovel = create<ActiveNovelState>()(
  persist(
    (set) => ({
      activeNovelId: null,
      setActiveNovel: (id) => set({ activeNovelId: id }),
    }),
    { name: 'myliterature.active-novel' },
  ),
);
