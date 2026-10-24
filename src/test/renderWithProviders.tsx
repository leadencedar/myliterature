import 'fake-indexeddb/auto';
import { cleanup as unmountAll, render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppDatabase } from '@/data/dexie/db';
import { DexieNovelRepository } from '@/data/dexie/DexieNovelRepository';
import { RepositoryProvider } from '@/data/RepositoryProvider';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import { useDataVersion } from '@/data/useRepoQuery';

export interface TestHarness {
  database: AppDatabase;
  repository: DexieNovelRepository;
  /** 挂载组件，自动包上仓储与路由 */
  renderUI: (ui: ReactNode, initialPath?: string) => RenderResult;
  cleanup: () => Promise<void>;
}

/**
 * 为单个用例搭建隔离环境：独立的 IndexedDB 库 + 干净的全局 store。
 *
 * zustand store 是模块级单例，用例之间会串味（比如上一个用例选中的作品
 * 会影响下一个用例的渲染），所以这里显式重置。
 */
export async function createTestHarness(): Promise<TestHarness> {
  const database = new AppDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  const repository = new DexieNovelRepository(database);

  useActiveNovel.setState({ activeNovelId: null });
  useDataVersion.setState({ version: 0 });

  return {
    database,
    repository,
    renderUI(ui, initialPath = '/') {
      return render(
        <RepositoryProvider repository={repository}>
          <MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>
        </RepositoryProvider>,
      );
    },
    async cleanup() {
      /**
       * 先卸载组件树，再关库。
       *
       * 用例文件里的 afterEach 比全局 setup 里的 RTL 自动卸载**先**执行
       * （vitest 按注册顺序倒序跑 afterEach），所以不显式卸载的话，
       * 组件里正在飞的查询会撞上已关闭的数据库，抛出无人接管的
       * DatabaseClosedError —— 表现为间歇性的 unhandled error。
       */
      unmountAll();
      database.close();
      await database.delete();
      localStorage.clear();
    },
  };
}
