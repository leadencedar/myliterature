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

createRoot(container).render(
  <StrictMode>
    <RepositoryProvider repository={repository}>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </RepositoryProvider>
  </StrictMode>,
);
