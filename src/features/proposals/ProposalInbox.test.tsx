import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Novel } from '@/domain/schema';
import {
  buildCreateProposal,
  buildMergeProposal,
  buildReplaceProposal,
  newBatchId,
} from '@/proposal/build';
import { entryFieldSpecs, fieldSpecsFor } from '@/proposal/fields';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { ProposalInbox } from './ProposalInbox';

let harness: TestHarness;
let novel: Novel;
let characterCategoryId: string;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '提案之书' });
  const categories = await harness.repository.listCategories(novel.id);
  characterCategoryId = categories[1]!.id;
});

afterEach(async () => {
  await harness.cleanup();
});

async function specs() {
  const categories = await harness.repository.listCategories(novel.id);
  return entryFieldSpecs(categories.find((c) => c.id === characterCategoryId));
}

async function seedEntryProposal(title: string, extra: Record<string, unknown> = {}) {
  const proposal = buildCreateProposal({
    novelId: novel.id,
    origin: 'generate',
    target: 'knowledgeEntry',
    label: `人物 · ${title}`,
    specs: await specs(),
    payload: { categoryId: characterCategoryId, title, ...extra },
  });
  await harness.repository.createProposals([proposal]);
  return proposal;
}

async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText('正在读取待确认内容…')).not.toBeInTheDocument());
}

describe('待确认收件箱', () => {
  it('把待确认提案渲染出来，并按分类给出对应字段', async () => {
    await seedEntryProposal('林越', { summary: '少年剑客', fields: { identity: '流亡贵族' } });

    harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    expect(screen.getByText('人物 · 林越')).toBeInTheDocument();
    // 字段标签来自「人物」分类的字段模板
    expect(screen.getByLabelText('身份')).toHaveValue('流亡贵族');
  });

  it('确认后写入知识库，提案标记为已采用', async () => {
    const user = userEvent.setup();
    const proposal = await seedEntryProposal('林越', { summary: '少年剑客' });

    harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: /全部采用/u }));

    await waitFor(async () => {
      expect(await harness.repository.listEntries(novel.id)).toHaveLength(1);
    });
    const entries = await harness.repository.listEntries(novel.id);
    expect(entries[0]).toMatchObject({ title: '林越', summary: '少年剑客' });

    const accepted = await harness.repository.listProposals(novel.id, { status: 'accepted' });
    expect(accepted.map((p) => p.id)).toEqual([proposal.id]);
  });

  it('落库的是用户编辑后的内容，而不是模型原始输出', async () => {
    const user = userEvent.setup();
    await seedEntryProposal('林越', { summary: '少年剑客' });

    harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    const summaryInput = screen.getByLabelText('一句话摘要');
    await user.clear(summaryInput);
    await user.type(summaryInput, '背负灭门之仇的少年剑客');
    await user.click(screen.getByRole('button', { name: /全部采用/u }));

    await waitFor(async () => {
      const entries = await harness.repository.listEntries(novel.id);
      expect(entries[0]?.summary).toBe('背负灭门之仇的少年剑客');
    });
  });

  it('全部忽略后不写库，提案标记为已拒绝', async () => {
    const user = userEvent.setup();
    await seedEntryProposal('林越');

    harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '全部忽略' }));

    await waitFor(async () => {
      expect(await harness.repository.listProposals(novel.id, { status: 'rejected' })).toHaveLength(
        1,
      );
    });
    expect(await harness.repository.listEntries(novel.id)).toHaveLength(0);
  });

  it('合并类提案能顺着目标条目找到分类字段', async () => {
    const existing = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategoryId,
      title: '林越',
      fields: { identity: '旧身份' },
    });
    const proposal = buildMergeProposal({
      novelId: novel.id,
      origin: 'extract',
      target: 'knowledgeEntry',
      label: '人物 · 林越',
      specs: await specs(),
      targetId: existing.id,
      current: existing,
      // payload 里没有 categoryId，必须靠 targetId 回查分类
      incoming: { fields: { identity: '流亡贵族' } },
      sourceRef: '第 3 章',
    });
    await harness.repository.createProposals([proposal]);

    harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    expect(screen.getByLabelText('身份')).toHaveValue('流亡贵族');
    expect(screen.getByText('来自 第 3 章')).toBeInTheDocument();
  });

  it('只处理指定批次的提案', async () => {
    const batchId = newBatchId();
    const inBatch = buildCreateProposal({
      novelId: novel.id,
      batchId,
      origin: 'generate',
      target: 'knowledgeEntry',
      label: '人物 · 批次内',
      specs: await specs(),
      payload: { categoryId: characterCategoryId, title: '批次内' },
    });
    await harness.repository.createProposals([inBatch]);
    await seedEntryProposal('批次外');

    harness.renderUI(<ProposalInbox novelId={novel.id} batchId={batchId} />);
    await waitForLoaded();

    expect(screen.getByText('人物 · 批次内')).toBeInTheDocument();
    expect(screen.queryByText('人物 · 批次外')).not.toBeInTheDocument();
  });

  it('部分失败时报告原因，失败项留在列表里', async () => {
    const user = userEvent.setup();
    const good = await seedEntryProposal('林越');
    // 目标条目不存在的合并提案，落库时必然失败
    const bad = buildMergeProposal({
      novelId: novel.id,
      origin: 'extract',
      target: 'knowledgeEntry',
      label: '人物 · 幽灵',
      specs: await specs(),
      targetId: 'missing-entry',
      current: { title: '幽灵' },
      incoming: { summary: '新摘要' },
    });
    await harness.repository.createProposals([bad]);

    harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: /全部采用/u }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('人物 · 幽灵');
    expect(alert).toHaveTextContent('已不存在');

    // 成功的那条已入库
    const entries = await harness.repository.listEntries(novel.id);
    expect(entries.map((e) => e.title)).toEqual(['林越']);
    expect(
      (await harness.repository.listProposals(novel.id, { status: 'accepted' })).map((p) => p.id),
    ).toEqual([good.id]);
    // 失败的留在待处理
    expect(
      (await harness.repository.listProposals(novel.id, { status: 'pending' })).map((p) => p.id),
    ).toEqual([bad.id]);
  });

  it('全部成功后触发完成回调', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    await seedEntryProposal('林越');

    harness.renderUI(<ProposalInbox novelId={novel.id} onSettled={onSettled} />);
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: /全部采用/u }));

    await waitFor(() => expect(onSettled).toHaveBeenCalled());
  });

  it('没有待确认项时不渲染内容', async () => {
    const { container } = harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    expect(container.textContent).toBe('');
  });

  it('非知识条目类提案使用其目标类型的字段规格', async () => {
    const proposal = buildCreateProposal({
      novelId: novel.id,
      origin: 'generate',
      target: 'outlineNode',
      label: '第一幕',
      specs: fieldSpecsFor('outlineNode'),
      payload: { title: '第一幕', synopsis: '主角被追杀', targetWords: 9000 },
    });
    await harness.repository.createProposals([proposal]);

    harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    expect(screen.getByLabelText('梗概')).toHaveValue('主角被追杀');
    expect(screen.getByLabelText('目标字数')).toHaveValue('9000');
  });
});

describe('外传进展提案', () => {
  async function seedSideStoryProposal() {
    await harness.repository.updateNovel(novel.id, { rollingSummary: '主线进展。' });
    const story = await harness.repository.createSideStory(novel.id, { title: '青冥旧事' });
    const proposal = buildReplaceProposal({
      novelId: novel.id,
      origin: 'extract',
      target: 'sideStory',
      label: '外传进展摘要',
      specs: fieldSpecsFor('sideStory'),
      sourceRef: '外传·青冥旧事 导入 3 章',
      targetId: story.id,
      current: { rollingSummary: story.rollingSummary },
      payload: { rollingSummary: '沈砚明白了玉佩的来历。' },
    });
    await harness.repository.createProposals([proposal]);
    return { story, proposal };
  }

  it('渲染外传进展字段；采用后只更新外传，作品进展不变', async () => {
    const user = userEvent.setup();
    const { story } = await seedSideStoryProposal();

    harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    expect(screen.getAllByText('外传进展摘要').length).toBeGreaterThan(0);
    expect(screen.getByText('来自 外传·青冥旧事 导入 3 章')).toBeInTheDocument();
    expect(screen.getByLabelText('外传进展摘要')).toHaveValue('沈砚明白了玉佩的来历。');

    await user.click(screen.getByRole('button', { name: /全部采用/u }));

    await waitFor(async () => {
      expect((await harness.repository.getSideStory(story.id))?.rollingSummary).toBe(
        '沈砚明白了玉佩的来历。',
      );
    });
    expect((await harness.repository.getNovel(novel.id))?.rollingSummary).toBe('主线进展。');
  });

  it('外传已被删除时报告原因，提案留在待确认里', async () => {
    const user = userEvent.setup();
    const { story, proposal } = await seedSideStoryProposal();
    await harness.repository.deleteSideStory(story.id);

    harness.renderUI(<ProposalInbox novelId={novel.id} />);
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: /全部采用/u }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('外传进展摘要');
    expect(alert).toHaveTextContent('这部外传已不存在，可能已被删除');
    expect(
      (await harness.repository.listProposals(novel.id, { status: 'pending' })).map((p) => p.id),
    ).toEqual([proposal.id]);
  });
});
