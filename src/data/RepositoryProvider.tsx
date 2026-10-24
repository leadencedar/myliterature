import { createContext, useContext, type ReactNode } from 'react';
import type { NovelRepository } from './NovelRepository';

const RepositoryContext = createContext<NovelRepository | null>(null);

/**
 * 通过 Context 注入仓储实现。
 *
 * 好处有两层：阶段二换成 Supabase 实现时只改这里的入参；
 * 测试里可以注入内存实现或临时库，不依赖全局单例。
 */
export function RepositoryProvider({
  repository,
  children,
}: {
  repository: NovelRepository;
  children: ReactNode;
}) {
  return <RepositoryContext.Provider value={repository}>{children}</RepositoryContext.Provider>;
}

export function useRepository(): NovelRepository {
  const repository = useContext(RepositoryContext);
  if (!repository) {
    throw new Error('useRepository 必须在 RepositoryProvider 内使用');
  }
  return repository;
}
