import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRepoQuery } from '@/data/useRepoQuery';
import type { Novel } from '@/domain/schema';
import { Button } from '@/ui/Button';
import { EmptyState, Page } from '@/ui/Page';
import { useActiveNovel } from './store/useActiveNovel';

/**
 * 知识库 / 写作 / 计划三个 Tab 都以「当前作品」为上下文。
 * 把「没有选中作品」这个状态的处理收在一处，避免三个页面各写一遍。
 */
export function RequireNovel({
  title,
  children,
}: {
  title: string;
  children: (novel: Novel) => ReactNode;
}) {
  const navigate = useNavigate();
  const { activeNovelId, setActiveNovel } = useActiveNovel();

  const { data: novel, loading } = useRepoQuery(
    async (repo) => (activeNovelId ? ((await repo.getNovel(activeNovelId)) ?? null) : null),
    [activeNovelId],
  );

  if (loading) {
    return (
      <Page title={title}>
        <p className="py-10 text-center text-sm text-ink-300">加载中…</p>
      </Page>
    );
  }

  if (!novel) {
    // activeNovelId 指向的作品可能已被删除，顺手清理掉这个悬空引用
    if (activeNovelId) setActiveNovel(null);
    return (
      <Page title={title}>
        <EmptyState
          title="还没有选定作品"
          description="先到书架创建或选择一本书，这里才知道该展示哪本书的内容。"
          action={
            <Button variant="primary" size="lg" onClick={() => navigate('/')}>
              去书架
            </Button>
          }
        />
      </Page>
    );
  }

  return <>{children(novel)}</>;
}
