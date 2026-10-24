import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Category, KnowledgeEntry, Novel } from '@/domain/schema';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { TrashSheet } from './TrashSheet';

let harness: TestHarness;
let novel: Novel;
let characterCategory: Category;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
  characterCategory = (await harness.repository.listCategories(novel.id))[1]!;
});

afterEach(async () => {
  await harness.cleanup();
});

/** 推演《雾中渡》，主角是新建的限定人物「沈砚」，并把主角移进回收站 */
async function seedTrashedProtagonist(): Promise<KnowledgeEntry> {
  const scenario = await harness.repository.createScenario(novel.id, {
    title: '雾中渡',
    setup: {
      cast: [{ entryId: '' }],
      start: { time: '', place: '', situation: '在渡口醒来' },
      goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
      milestones: [],
      tone: '',
      expectedSteps: 30,
    },
    newOc: { categoryId: characterCategory.id, title: '沈砚', fields: {} },
  });
  const ocId = scenario.setup.cast[0]!.entryId;
  await harness.repository.softDeleteEntry(ocId);
  return (await harness.repository.getEntry(ocId))!;
}

function renderTrash() {
  return harness.renderUI(<TrashSheet open novelId={novel.id} onClose={() => {}} />);
}

describe('回收站 · 推演主角', () => {
  it('主角条目旁有「推演《X》的主角」小字', async () => {
    await seedTrashedProtagonist();
    renderTrash();
    const trash = await screen.findByRole('dialog', { name: '回收站' });
    expect(await within(trash).findByText('沈砚')).toBeInTheDocument();
    expect(within(trash).getByText('推演《雾中渡》的主角')).toBeInTheDocument();
  });

  it('彻底删除失败时框内出现 alert、框保持打开；取消后条目仍在列表与库里', async () => {
    const user = userEvent.setup();
    const oc = await seedTrashedProtagonist();
    renderTrash();
    const trash = await screen.findByRole('dialog', { name: '回收站' });
    await within(trash).findByText('沈砚');
    await user.click(within(trash).getByRole('button', { name: '彻底删除' }));

    const confirm = screen.getByRole('dialog', { name: '彻底删除？' });
    expect(within(confirm).getByText('「沈砚」将被永久删除，无法恢复。')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: '永久删除' }));

    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      '这个条目是推演《雾中渡》的主角，先删除推演',
    );
    expect(screen.getByRole('dialog', { name: '彻底删除？' })).toBeInTheDocument();
    expect(await harness.repository.getEntry(oc.id)).toEqual(oc);

    await user.click(within(confirm).getByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '彻底删除？' })).not.toBeInTheDocument();
    });
    expect(within(trash).getByText('沈砚')).toBeInTheDocument();
    expect(await harness.repository.getEntry(oc.id)).toEqual(oc);

    // 重新打开确认框时不带上一次的错误
    await user.click(within(trash).getByRole('button', { name: '彻底删除' }));
    const reopened = screen.getByRole('dialog', { name: '彻底删除？' });
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('普通条目彻底删除行为不变：确认后从库里消失、框关闭', async () => {
    const user = userEvent.setup();
    const entry = await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '待清理',
    });
    await harness.repository.softDeleteEntry(entry.id);
    renderTrash();
    const trash = await screen.findByRole('dialog', { name: '回收站' });
    await within(trash).findByText('待清理');
    expect(within(trash).queryByText(/的主角$/u)).not.toBeInTheDocument();
    await user.click(within(trash).getByRole('button', { name: '彻底删除' }));
    await user.click(screen.getByRole('button', { name: '永久删除' }));
    await waitFor(async () => {
      expect(await harness.repository.getEntry(entry.id)).toBeUndefined();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '彻底删除？' })).not.toBeInTheDocument();
    });
  });
});
