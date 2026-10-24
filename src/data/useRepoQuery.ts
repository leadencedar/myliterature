import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { NovelRepository } from './NovelRepository';
import { useRepository } from './RepositoryProvider';

/**
 * 全局数据版本号。任何写操作后调用 invalidate()，所有 useRepoQuery 重新拉取。
 *
 * 为什么不用 dexie-react-hooks 的 useLiveQuery：它依赖 Dexie 的可观察性，
 * 会把组件层与具体存储实现绑死，阶段二换 Supabase 时全部要重写。
 * 单本小说的数据量在数百行级别，全量重查的开销可以忽略，
 * 用一个显式的失效信号换取存储无关性是划算的。
 */
interface DataVersionState {
  version: number;
  invalidate: () => void;
}

export const useDataVersion = create<DataVersionState>((set) => ({
  version: 0,
  invalidate: () => set((state) => ({ version: state.version + 1 })),
}));

/** 在事件处理里拿到失效函数，不订阅 version 本身以免多余重渲染 */
export function useInvalidate(): () => void {
  return useDataVersion.getState().invalidate;
}

export interface RepoQueryResult<T> {
  data: T | undefined;
  /** 首次加载（尚无数据可显示） */
  loading: boolean;
  /** 已有数据、正在后台刷新 */
  refreshing: boolean;
  error: Error | undefined;
  reload: () => void;
}

interface QueryState<T> {
  data: T | undefined;
  loading: boolean;
  refreshing: boolean;
  error: Error | undefined;
}

/**
 * 执行一次仓储查询，并在数据版本或 deps 变化时重新执行。
 *
 * **刷新时保留已有数据，不回到 loading 态**（stale-while-revalidate）。
 * 这一点至关重要：页面通常写成「loading 时渲染占位符」，如果每次写操作后的
 * 刷新都让 loading 变真，整棵子树会被卸载重建 —— 正在填写的抽屉、
 * 正在确认的提案面板会当场消失，用户输入直接丢掉。
 *
 * deps 变化（比如切换到另一本书）是另一回事：此时旧数据不再相关，
 * 必须清空并回到 loading，否则会短暂显示上一本书的内容。
 *
 * @param query 接收仓储实例的查询函数
 * @param deps  查询依赖的外部变量（如 novelId），必须是可序列化的简单值
 */
export function useRepoQuery<T>(
  query: (repo: NovelRepository) => Promise<T>,
  deps: readonly unknown[],
): RepoQueryResult<T> {
  const repository = useRepository();
  const version = useDataVersion((state) => state.version);
  const [manualTick, setManualTick] = useState(0);
  const [state, setState] = useState<QueryState<T>>({
    data: undefined,
    loading: true,
    refreshing: false,
    error: undefined,
  });

  // query 每次渲染都是新函数，放进 ref 避免把它列入依赖导致死循环
  const queryRef = useRef(query);
  queryRef.current = query;

  const depsKey = JSON.stringify(deps);
  const previousDepsKey = useRef(depsKey);

  useEffect(() => {
    let cancelled = false;
    const isNewQuery = previousDepsKey.current !== depsKey;
    previousDepsKey.current = depsKey;

    setState((prev) =>
      isNewQuery || prev.data === undefined
        ? { data: undefined, loading: true, refreshing: false, error: undefined }
        : { ...prev, refreshing: true },
    );

    queryRef
      .current(repository)
      .then((result) => {
        if (cancelled) return;
        setState({ data: result, loading: false, refreshing: false, error: undefined });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          refreshing: false,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [repository, version, manualTick, depsKey]);

  const reload = useCallback(() => setManualTick((tick) => tick + 1), []);

  return { ...state, reload };
}
