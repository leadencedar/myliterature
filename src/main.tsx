import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppShell } from './app/AppShell';
import { RepositoryProvider } from './data/RepositoryProvider';
import { DexieNovelRepository } from './data/dexie/DexieNovelRepository';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到挂载节点 #root');
}

// 阶段一：本地 IndexedDB 实现。阶段二换成 Supabase 实现时只改这一行。
const repository = new DexieNovelRepository();

/**
 * 路由前缀必须和构建的 base 一致：GitHub Pages 项目页部署在 `/myliterature/` 下，
 * 浏览器地址栏带着这个前缀，而路由表里的路径（`/knowledge`、`/write`…）不带。
 * 本地 / 局域网部署 base 为 `/`，basename 去掉尾斜杠后为空，等价于根路径。
 */
const basename = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

createRoot(container).render(
  <StrictMode>
    <RepositoryProvider repository={repository}>
      <BrowserRouter basename={basename}>
        <AppShell />
      </BrowserRouter>
    </RepositoryProvider>
  </StrictMode>,
);
