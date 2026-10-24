import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppShell } from '@/app/AppShell';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Novel } from '@/domain/schema';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';

/**
 * 「译名表发现译文对不上 → 跳到那一章」的端到端验证。
 *
 * 走的是真实路由：知识库的译名表算出不一致 → navigate 到写作页并带上章节 id
 * → 写作页读出意图，直接把那一章的编辑器打开。三段分别在三个文件里，
 * 只有整条串起来才说明它真的通。
 */

let harness: TestHarness;
let novel: Novel;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
  useActiveNovel.setState({ activeNovelId: novel.id });

  // 第一章按旧译法译好了
  await harness.repository.createChapter(novel.id, {
    index: 1,
    title: '雪夜',
    content: '阿什福德走进门。',
    sourceContent: 'Ashford walked in.',
    sourceLanguage: 'en',
    source: 'imported',
  });
  await harness.repository.mergeGlossaryTerms(novel.id, [
    { source: 'Ashford', target: '阿什福德' },
  ]);
  // 作者改了译名 —— 从这一刻起第一章的译文就落后了
  await harness.repository.setGlossaryTerm(novel.id, 'Ashford', '艾许佛');
});

afterEach(async () => {
  await harness.cleanup();
});

function renderApp() {
  const user = userEvent.setup();
  harness.renderUI(<AppShell />, '/knowledge');
  return user;
}

async function openGlossary(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /译名表/u }));
  return screen.getByRole('dialog', { name: '译名表' });
}

describe('从译名表跳到对不上的那一章', () => {
  it('点章节名直接打开那一章的编辑器', async () => {
    const user = renderApp();
    await openGlossary(user);

    await user.click(await screen.findByRole('button', { name: '第 1 章 雪夜' }));

    // 落在写作页，编辑器已经打开，正文是那份还没跟上译名的译文
    expect(await screen.findByLabelText('章节正文')).toHaveValue('阿什福德走进门。');
    // 译名表抽屉先关掉了，不会悬在另一个页面上
    expect(screen.queryByRole('dialog', { name: '译名表' })).not.toBeInTheDocument();
  });

  it('意图只消费一次：关掉编辑器再回写作页，不会又自动弹开', async () => {
    const user = renderApp();
    await openGlossary(user);
    await user.click(await screen.findByRole('button', { name: '第 1 章 雪夜' }));
    await screen.findByLabelText('章节正文');

    await user.click(screen.getByRole('button', { name: '返回' }));
    await waitFor(() => expect(screen.queryByLabelText('章节正文')).not.toBeInTheDocument());

    // 离开写作页再回来
    await user.click(screen.getByRole('link', { name: '知识库' }));
    await screen.findByRole('button', { name: /译名表/u });
    await user.click(screen.getByRole('link', { name: '写作' }));

    await screen.findByRole('button', { name: '继续写第 1 章' });
    expect(screen.queryByLabelText('章节正文')).not.toBeInTheDocument();
  });

  it('译名表里能看到是哪一条对不上', async () => {
    const user = renderApp();
    const sheet = await openGlossary(user);

    expect(
      await screen.findByRole('heading', { name: '1 条译名与已有译文不一致' }),
    ).toBeInTheDocument();
    expect(sheet).toHaveTextContent('Ashford → 艾许佛');
    expect(sheet).toHaveTextContent('1 章未采用');
  });

  it('外传章节点过去打开那一章的外传编辑器', async () => {
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    await harness.repository.createChapter(novel.id, {
      sideStoryId: story.id,
      content: '阿什福德来了。',
      sourceContent: 'Ashford came.',
      sourceLanguage: 'en',
      source: 'imported',
    });

    const user = renderApp();
    await openGlossary(user);
    await user.click(await screen.findByRole('button', { name: '外传·青冥旧事 第 1 章' }));

    const editor = await screen.findByRole('dialog', { name: '编辑外传《青冥旧事》第 1 章' });
    expect(editor).toHaveTextContent('外传·青冥旧事 第 1 章');
    expect(screen.getByLabelText('章节正文')).toHaveValue('阿什福德来了。');
  });
});
