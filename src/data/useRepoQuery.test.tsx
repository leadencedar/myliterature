import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NovelRepository } from './NovelRepository';
import { RepositoryProvider } from './RepositoryProvider';
import { useDataVersion, useRepoQuery } from './useRepoQuery';

/** 只需要一个占位仓储，查询函数本身不真的用它 */
const fakeRepository = {} as NovelRepository;

function wrapper({ children }: { children: ReactNode }) {
  return <RepositoryProvider repository={fakeRepository}>{children}</RepositoryProvider>;
}

beforeEach(() => {
  useDataVersion.setState({ version: 0 });
});

describe('首次加载', () => {
  it('先 loading，拿到数据后结束', async () => {
    const { result } = renderHook(() => useRepoQuery(async () => '结果', []), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe('结果');
    expect(result.current.refreshing).toBe(false);
  });

  it('查询抛错时记录错误并结束加载', async () => {
    const { result } = renderHook(
      () => useRepoQuery(async () => Promise.reject(new Error('查询失败')), []),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('查询失败');
  });
});

describe('失效后刷新', () => {
  it('保留已有数据，只把 refreshing 置真', async () => {
    // 这是关键不变量：若刷新时 loading 变真，页面上「loading 渲染占位符」的写法
    // 会卸载整棵子树，正在填写的抽屉与未保存的输入会当场丢失
    let resolveSecond: ((value: string) => void) | undefined;
    let call = 0;
    const query = vi.fn(async () => {
      call += 1;
      if (call === 1) return '第一次';
      return new Promise<string>((resolve) => {
        resolveSecond = resolve;
      });
    });

    const { result } = renderHook(() => useRepoQuery(query, []), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('第一次'));

    act(() => useDataVersion.getState().invalidate());

    await waitFor(() => expect(result.current.refreshing).toBe(true));
    expect(result.current.loading).toBe(false);
    // 刷新过程中旧数据仍然可用
    expect(result.current.data).toBe('第一次');

    await act(async () => {
      resolveSecond?.('第二次');
    });
    await waitFor(() => expect(result.current.data).toBe('第二次'));
    expect(result.current.refreshing).toBe(false);
  });

  it('手动 reload 同样保留数据', async () => {
    const query = vi.fn(async () => '值');
    const { result } = renderHook(() => useRepoQuery(query, []), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('值'));

    act(() => result.current.reload());

    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  });
});

describe('依赖变化', () => {
  it('切换 deps 时清空旧数据并回到 loading', async () => {
    // 换一本书时旧数据不再相关，短暂显示上一本的内容比空白更糟
    const query = vi.fn(async (_repo: NovelRepository) => 'ignored');
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useRepoQuery(async () => `数据-${id}`, [id]),
      { wrapper, initialProps: { id: 'a' } },
    );

    await waitFor(() => expect(result.current.data).toBe('数据-a'));

    rerender({ id: 'b' });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();

    await waitFor(() => expect(result.current.data).toBe('数据-b'));
    expect(query).not.toHaveBeenCalled();
  });

  it('deps 内容不变时不重复查询', async () => {
    const query = vi.fn(async () => '值');
    const { result, rerender } = renderHook(() => useRepoQuery(query, ['same']), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('值'));

    rerender();
    rerender();

    expect(query).toHaveBeenCalledTimes(1);
  });
});
