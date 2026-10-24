import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Novel } from '@/domain/schema';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { GlossarySheet } from './GlossarySheet';

let harness: TestHarness;
let novel: Novel;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
});

afterEach(async () => {
  await harness.cleanup();
});

function renderSheet(onOpenChapter: (chapterId: string) => void = () => {}) {
  const user = userEvent.setup();
  harness.renderUI(
    <GlossarySheet open novelId={novel.id} onOpenChapter={onOpenChapter} onClose={() => {}} />,
  );
  return user;
}

async function seedTerms() {
  await harness.repository.mergeGlossaryTerms(novel.id, [
    { source: 'Ashford', target: '阿什福德' },
    { source: 'Greymoor', target: '灰沼' },
  ]);
}

describe('空表', () => {
  it('说明它是干什么的，并且可以先把关键人名定下来', async () => {
    renderSheet();
    expect(await screen.findByText(/还没有译名/u)).toBeInTheDocument();
    expect(screen.getByText(/翻译时会照着译/u)).toBeInTheDocument();
    expect(screen.getByLabelText('原文名')).toBeInTheDocument();
  });
});

describe('查看', () => {
  it('列出原文名与可编辑的译名', async () => {
    await seedTerms();
    renderSheet();

    expect(await screen.findByLabelText('Ashford 的译名')).toHaveValue('阿什福德');
    expect(screen.getByLabelText('Greymoor 的译名')).toHaveValue('灰沼');
  });

  it('说清改译名不会动已经译好的正文', async () => {
    await seedTerms();
    renderSheet();
    expect(await screen.findByText(/已经译好的正文不会自动跟着变/u)).toBeInTheDocument();
  });
});

describe('改译名', () => {
  it('改完保存，覆盖原来的译法', async () => {
    await seedTerms();
    const user = renderSheet();

    const input = await screen.findByLabelText('Ashford 的译名');
    await user.clear(input);
    await user.type(input, '艾许佛');
    await user.click(screen.getByRole('button', { name: /保存 1 处改动/u }));

    await waitFor(async () => {
      const glossary = await harness.repository.getGlossary(novel.id);
      // 作者的决定可以推翻已有译名，这与模型产出走的「先到先得」刻意不同
      expect(glossary?.terms).toEqual([
        { source: 'Ashford', target: '艾许佛' },
        { source: 'Greymoor', target: '灰沼' },
      ]);
    });
  });

  it('改动前没有保存按钮，改回原值后按钮消失', async () => {
    await seedTerms();
    const user = renderSheet();

    const input = await screen.findByLabelText('Ashford 的译名');
    expect(screen.queryByRole('button', { name: /保存/u })).not.toBeInTheDocument();

    await user.type(input, '甲');
    expect(await screen.findByRole('button', { name: /保存 1 处改动/u })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '阿什福德');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /保存/u })).not.toBeInTheDocument();
    });
  });

  it('一次可以改多条', async () => {
    await seedTerms();
    const user = renderSheet();

    const first = await screen.findByLabelText('Ashford 的译名');
    await user.clear(first);
    await user.type(first, '艾许佛');
    const second = screen.getByLabelText('Greymoor 的译名');
    await user.clear(second);
    await user.type(second, '灰泽');

    await user.click(screen.getByRole('button', { name: /保存 2 处改动/u }));

    await waitFor(async () => {
      const glossary = await harness.repository.getGlossary(novel.id);
      expect(glossary?.terms.map((term) => term.target)).toEqual(['艾许佛', '灰泽']);
    });
  });

  it('清空译名时拦下，并指向删除', async () => {
    await seedTerms();
    const user = renderSheet();

    const input = await screen.findByLabelText('Ashford 的译名');
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: /保存 1 处改动/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent('译名不能为空');
    const glossary = await harness.repository.getGlossary(novel.id);
    expect(glossary?.terms[0]?.target).toBe('阿什福德');
  });

  it('放弃改动把输入退回原值', async () => {
    await seedTerms();
    const user = renderSheet();

    const input = await screen.findByLabelText('Ashford 的译名');
    await user.clear(input);
    await user.type(input, '艾许佛');
    await user.click(screen.getByRole('button', { name: '放弃改动' }));

    expect(await screen.findByLabelText('Ashford 的译名')).toHaveValue('阿什福德');
  });
});

describe('添加译名', () => {
  it('可以在翻译之前先把关键人名定下来', async () => {
    const user = renderSheet();
    await screen.findByLabelText('原文名');

    await user.type(screen.getByLabelText('原文名'), 'Eastwick');
    await user.type(screen.getByLabelText('中文译名'), '东威克');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(async () => {
      const glossary = await harness.repository.getGlossary(novel.id);
      expect(glossary?.terms).toEqual([{ source: 'Eastwick', target: '东威克' }]);
    });
    // 加完清空输入，方便连着加下一条
    expect(screen.getByLabelText('原文名')).toHaveValue('');
  });

  it('两栏都要填', async () => {
    const user = renderSheet();
    await user.type(await screen.findByLabelText('原文名'), 'Eastwick');
    await user.click(screen.getByRole('button', { name: '添加' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('原文名与译名都要填');
  });

  it('已经在表里的原文名不重复添加，提示去改它', async () => {
    await seedTerms();
    const user = renderSheet();
    await screen.findByLabelText('Ashford 的译名');

    // 大小写不同也算同一个名字
    await user.type(screen.getByLabelText('原文名'), 'ashford');
    await user.type(screen.getByLabelText('中文译名'), '艾许佛');
    await user.click(screen.getByRole('button', { name: '添加' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已经在表里了');
    const glossary = await harness.repository.getGlossary(novel.id);
    expect(glossary?.terms).toHaveLength(2);
  });
});

describe('删除译名', () => {
  it('删掉一条', async () => {
    await seedTerms();
    const user = renderSheet();

    await user.click(await screen.findByRole('button', { name: '删除 Ashford 的译名' }));

    await waitFor(async () => {
      const glossary = await harness.repository.getGlossary(novel.id);
      expect(glossary?.terms).toEqual([{ source: 'Greymoor', target: '灰沼' }]);
    });
  });

  it('删掉正在改的那条时，它的待保存改动一起丢掉', async () => {
    await seedTerms();
    const user = renderSheet();

    const input = await screen.findByLabelText('Ashford 的译名');
    await user.clear(input);
    await user.type(input, '艾许佛');
    await user.click(screen.getByRole('button', { name: '删除 Ashford 的译名' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /保存/u })).not.toBeInTheDocument();
    });
  });
});

describe('两本书互不干扰', () => {
  it('只显示当前作品的译名', async () => {
    await seedTerms();
    const other = await harness.repository.createNovel({ title: '另一本' });
    await harness.repository.mergeGlossaryTerms(other.id, [{ source: 'Nobody', target: '无名' }]);

    renderSheet();
    /**
     * 先等真正异步出现的那个元素。
     *
     * 抽屉本身在加载态就已经渲染，所以 `findByRole('dialog')` 会立刻返回；
     * 紧接着对列表项用 `getBy*` 就是在跟查询抢时间 —— 这条用例曾因此偶发失败。
     */
    const row = await screen.findByLabelText('Ashford 的译名');
    const dialog = row.closest<HTMLElement>('[role="dialog"]')!;
    expect(within(dialog).queryByLabelText('Nobody 的译名')).not.toBeInTheDocument();
  });
});

describe('已有译文的一致性', () => {
  /** 造一章翻译过的正文：content 是译文，sourceContent 是留底的原文 */
  async function translatedChapter(index: number, content: string, sourceContent: string) {
    return harness.repository.createChapter(novel.id, {
      index,
      title: '',
      content,
      sourceContent,
      sourceLanguage: 'en',
      source: 'imported',
    });
  }

  it('列出译文里没有采用当前译名的章节，并说明原因', async () => {
    await seedTerms();
    // 第一章译成了旧译法；把译名改掉之后它就对不上了
    await translatedChapter(1, '阿什福德走进灰沼。', 'Ashford walked into Greymoor.');
    await harness.repository.setGlossaryTerm(novel.id, 'Ashford', '艾许佛');

    renderSheet();

    expect(
      await screen.findByRole('heading', { name: '1 条译名与已有译文不一致' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Ashford → 艾许佛')).toBeInTheDocument();
    expect(screen.getByText('1 章未采用')).toBeInTheDocument();
    // 译名已经对得上的那条不该被牵连
    expect(screen.queryByText(/Greymoor →/u)).not.toBeInTheDocument();
  });

  it('对不上的那一行也标出来，长列表里才扫得到', async () => {
    await seedTerms();
    await translatedChapter(1, '阿什福德走进灰沼。', 'Ashford walked into Greymoor.');
    await harness.repository.setGlossaryTerm(novel.id, 'Ashford', '艾许佛');

    renderSheet();

    const row = (await screen.findByLabelText('Ashford 的译名')).closest('li')!;
    expect(within(row).getByText('译文不一致')).toBeInTheDocument();

    const clean = screen.getByLabelText('Greymoor 的译名').closest('li')!;
    expect(within(clean).queryByText('译文不一致')).not.toBeInTheDocument();
  });

  it('点章节名把它交回调用方去打开', async () => {
    const opened: string[] = [];
    await seedTerms();
    const chapter = await translatedChapter(7, '阿什福德走了。', 'Ashford left.');
    await harness.repository.setGlossaryTerm(novel.id, 'Ashford', '艾许佛');

    const user = renderSheet((id) => opened.push(id));

    await user.click(await screen.findByRole('button', { name: '第 7 章' }));
    expect(opened).toEqual([chapter.id]);
  });

  it('章节有标题时连标题一起显示，方便认', async () => {
    await harness.repository.mergeGlossaryTerms(novel.id, [
      { source: 'Ashford', target: '艾许佛' },
    ]);
    await harness.repository.updateChapter(
      (await translatedChapter(3, '阿什福德走了。', 'Ashford left.')).id,
      { title: '归乡' },
    );

    renderSheet();
    expect(await screen.findByRole('button', { name: '第 3 章 归乡' })).toBeInTheDocument();
  });

  it('译文跟得上就什么都不提示', async () => {
    await seedTerms();
    await translatedChapter(1, '阿什福德走进灰沼。', 'Ashford walked into Greymoor.');

    renderSheet();
    await screen.findByLabelText('Ashford 的译名');
    expect(screen.queryByText(/与已有译文不一致/u)).not.toBeInTheDocument();
    expect(screen.queryByText('译文不一致')).not.toBeInTheDocument();
  });

  it('中文原创章节不参与 —— 没有原文可以对齐', async () => {
    await harness.repository.mergeGlossaryTerms(novel.id, [
      { source: 'Ashford', target: '艾许佛' },
    ]);
    // 正文里写着另一种译法，但这一章不是翻译来的，无从判定是不是同一个人
    await harness.repository.createChapter(novel.id, {
      index: 1,
      content: '阿什福德走了。',
      source: 'manual',
    });

    renderSheet();
    await screen.findByLabelText('Ashford 的译名');
    expect(screen.queryByText(/与已有译文不一致/u)).not.toBeInTheDocument();
  });

  it('正在输入框里改译名时不跟着闪 —— 比对用的是已保存的那一版', async () => {
    await seedTerms();
    await translatedChapter(1, '阿什福德走进灰沼。', 'Ashford walked into Greymoor.');

    const user = renderSheet();
    const input = await screen.findByLabelText('Ashford 的译名');
    await user.clear(input);
    await user.type(input, '艾许佛');

    // 还没保存，正文当然还是旧译法，但这不该被当成不一致
    expect(screen.queryByText(/与已有译文不一致/u)).not.toBeInTheDocument();
  });

  it('保存改动之后立刻显示出对不上的章节', async () => {
    await seedTerms();
    await translatedChapter(1, '阿什福德走进灰沼。', 'Ashford walked into Greymoor.');

    const user = renderSheet();
    const input = await screen.findByLabelText('Ashford 的译名');
    await user.clear(input);
    await user.type(input, '艾许佛');
    await user.click(screen.getByRole('button', { name: /保存 1 处改动/u }));

    expect(
      await screen.findByRole('heading', { name: '1 条译名与已有译文不一致' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '第 1 章' })).toBeInTheDocument();
  });
});

describe('外传章节的不一致清单', () => {
  it('外传章节显示「外传·X 第 N 章」，与主线同编号章节区分开', async () => {
    const opened: string[] = [];
    await harness.repository.mergeGlossaryTerms(novel.id, [
      { source: 'Ashford', target: '阿什福德' },
    ]);
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    const main = await harness.repository.createChapter(novel.id, {
      content: '阿什福德走了。',
      sourceContent: 'Ashford left.',
      sourceLanguage: 'en',
      source: 'imported',
    });
    const side = await harness.repository.createChapter(novel.id, {
      sideStoryId: story.id,
      title: '旧事',
      content: '阿什福德来了。',
      sourceContent: 'Ashford came.',
      sourceLanguage: 'en',
      source: 'imported',
    });
    await harness.repository.setGlossaryTerm(novel.id, 'Ashford', '艾许佛');

    const user = renderSheet((id) => opened.push(id));

    expect(await screen.findByRole('button', { name: '第 1 章' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '外传·青冥旧事 第 1 章 旧事' }));
    expect(opened).toEqual([side.id]);
    expect(opened).not.toContain(main.id);
  });
});
