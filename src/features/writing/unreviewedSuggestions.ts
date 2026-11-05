import { create } from 'zustand';

/**
 * 未采用的 AI 建议（阶段 4）：按章保留在**会话内**。
 *
 * 生成/加工面板关掉不等于作者放弃了建议；切走再回来必须还能继续审阅。
 * 只放内存、不落库（与 incompleteDrafts 同理）：P1 才考虑跨刷新恢复。
 */
export type UnreviewedKind = 'generate' | 'revise';

export interface UnreviewedSuggestion {
  kind: UnreviewedKind;
  text: string;
  at: number;
  /**
   * 生成/加工时的正文与选区快照。采用前用它做基准检查；
   * 同一条建议重复标记时保留最早基准，不被后台刷新改写。
   */
  baseline?: {
    content: string;
    selection?: { start: number; end: number; text: string };
  };
}

interface UnreviewedState {
  items: Record<string, UnreviewedSuggestion>;
  mark: (
    chapterId: string,
    kind: UnreviewedKind,
    text: string,
    baseline?: UnreviewedSuggestion['baseline'],
  ) => void;
  clear: (chapterId: string) => void;
}

export const useUnreviewedSuggestions = create<UnreviewedState>((set) => ({
  items: {},
  mark: (chapterId, kind, text, baseline) =>
    set((state) => {
      if (!chapterId || !text.trim()) return state;
      const previous = state.items[chapterId];
      const keepBaseline = previous?.kind === kind ? (previous.baseline ?? baseline) : baseline;
      return {
        items: {
          ...state.items,
          [chapterId]: {
            kind,
            text,
            at: Date.now(),
            ...(keepBaseline ? { baseline: keepBaseline } : {}),
          },
        },
      };
    }),
  clear: (chapterId) =>
    set((state) => {
      if (!state.items[chapterId]) return state;
      const next = { ...state.items };
      delete next[chapterId];
      return { items: next };
    }),
}));

/** 组件用：本章未审阅的 AI 建议 */
export function useUnreviewedSuggestion(chapterId: string): UnreviewedSuggestion | undefined {
  return useUnreviewedSuggestions((state) => state.items[chapterId]);
}
