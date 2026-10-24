import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Category, Novel } from '@/domain/schema';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { KnowledgePage } from './KnowledgePage';

let harness: TestHarness;
let novel: Novel;
let worldCategory: Category;
let characterCategory: Category;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
  const categories = await harness.repository.listCategories(novel.id);
  worldCategory = categories[0]!;
  characterCategory = categories[1]!;
  useActiveNovel.setState({ activeNovelId: novel.id });
});

afterEach(async () => {
  await harness.cleanup();
});

function renderPage() {
  return harness.renderUI(<KnowledgePage />);
}

async function seedEntries() {
  await harness.repository.createEntry(novel.id, {
    categoryId: worldCategory.id,
    title: '灵气',
    summary: '天地间流动的能量',
    pinned: true,
    fields: { definition: '构成一切术法的基础', rules: '浓度随地势变化' },
  });
  await harness.repository.createEntry(novel.id, {
    categoryId: characterCategory.id,
    title: '林越',
    aliases: ['阿越'],
    summary: '失忆的少年剑客',
    fields: { identity: '流亡贵族' },
  });
  await harness.repository.createEntry(novel.id, {
    categoryId: characterCategory.id,
    title: '沈清',
    summary: '追查真相的女捕',
  });
}

/** 等页面首屏查询落地 */
async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
}

describe('条目列表', () => {
  it('按分类分组展示，并标出核心设定与别名', async () => {
    await seedEntries();
    renderPage();
    await waitForLoaded();

    expect(await screen.findByText('设定条目 3')).toBeInTheDocument();
    expect(screen.getByText('世界观设定 · 1')).toBeInTheDocument();
    expect(screen.getByText('人物 · 2')).toBeInTheDocument();
    expect(screen.getByText('核心')).toBeInTheDocument();
    expect(screen.getByText('别名：阿越')).toBeInTheDocument();
  });

  it('没有摘要时退而展示第一个有内容的字段', async () => {
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '无摘要者',
      fields: { identity: '神秘的旅人' },
    });
    renderPage();
    await waitForLoaded();

    expect(await screen.findByText('神秘的旅人')).toBeInTheDocument();
  });

  it('搜索覆盖标题、别名、摘要与字段值', async () => {
    const user = userEvent.setup();
    await seedEntries();
    renderPage();
    await waitForLoaded();

    const search = await screen.findByLabelText('搜索条目');

    await user.type(search, '阿越');
    expect(screen.getByText('林越')).toBeInTheDocument();
    expect(screen.queryByText('沈清')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '浓度');
    expect(screen.getByText('灵气')).toBeInTheDocument();
    expect(screen.queryByText('林越')).not.toBeInTheDocument();
  });

  it('搜不到时给出明确提示', async () => {
    const user = userEvent.setup();
    await seedEntries();
    renderPage();
    await waitForLoaded();

    await user.type(await screen.findByLabelText('搜索条目'), '不存在的东西');

    expect(screen.getByText(/没有匹配「不存在的东西」的条目/u)).toBeInTheDocument();
  });

  it('按分类筛选', async () => {
    const user = userEvent.setup();
    await seedEntries();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: '人物 2' }));

    expect(screen.getByText('林越')).toBeInTheDocument();
    expect(screen.queryByText('灵气')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '全部 3' }));
    expect(screen.getByText('灵气')).toBeInTheDocument();
  });

  it('分类被删后条目归入「未分类」而不是消失', async () => {
    const custom = await harness.repository.createCategory(novel.id, { name: '临时分类' });
    const entry = await harness.repository.createEntry(novel.id, {
      categoryId: custom.id,
      title: '孤儿条目',
    });
    // 绕过删除保护，模拟数据层面的分类缺失
    await harness.database.categories.delete(custom.id);
    expect(entry.id).toBeTruthy();

    renderPage();
    await waitForLoaded();

    expect(await screen.findByText(/未分类 · 1/u)).toBeInTheDocument();
    expect(screen.getByText('孤儿条目')).toBeInTheDocument();
  });
});

describe('条目编辑', () => {
  it('新建条目：字段由所选分类的模板决定', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '新建条目' }));
    const dialog = screen.getByRole('dialog');

    // 默认第一个分类是世界观设定
    expect(within(dialog).getByLabelText('运作规则')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('说话方式')).not.toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText('分类'), characterCategory.id);
    expect(within(dialog).getByLabelText('说话方式')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('运作规则')).not.toBeInTheDocument();
  });

  it('新建条目保存后入库', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '新建条目' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), '归墟');
    await user.type(within(dialog).getByLabelText('一句话摘要'), '吞噬记忆的深渊');
    await user.type(within(dialog).getByLabelText('别名'), '深渊{Enter}忘川');
    await user.type(within(dialog).getByLabelText('运作规则'), '越靠近记忆流失越快');
    await user.click(within(dialog).getByLabelText('核心设定'));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      expect(await harness.repository.listEntries(novel.id)).toHaveLength(1);
    });
    const [saved] = await harness.repository.listEntries(novel.id);
    expect(saved).toMatchObject({
      title: '归墟',
      summary: '吞噬记忆的深渊',
      aliases: ['深渊', '忘川'],
      pinned: true,
    });
    expect(saved?.fields.rules).toBe('越靠近记忆流失越快');
  });

  it('条目名为空时拦下并提示', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '新建条目' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));

    expect(screen.getByRole('alert')).toHaveTextContent('条目名不能为空');
    expect(await harness.repository.listEntries(novel.id)).toHaveLength(0);
  });

  it('点条目卡片进入编辑，预填现有内容', async () => {
    const user = userEvent.setup();
    await seedEntries();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: /林越/u }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('名称')).toHaveValue('林越');
    expect(within(dialog).getByLabelText('别名')).toHaveValue('阿越');
    expect(within(dialog).getByLabelText('身份')).toHaveValue('流亡贵族');
  });

  it('编辑后保存写回数据库', async () => {
    const user = userEvent.setup();
    await seedEntries();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: /林越/u }));
    const dialog = screen.getByRole('dialog');
    const summary = within(dialog).getByLabelText('一句话摘要');
    await user.clear(summary);
    await user.type(summary, '背负灭门之仇的剑客');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const entries = await harness.repository.listEntries(novel.id);
      expect(entries.find((item) => item.title === '林越')?.summary).toBe('背负灭门之仇的剑客');
    });
  });

  it('切换分类时保留同名字段已填的内容', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: '新建条目' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), '共享名称');
    await user.selectOptions(within(dialog).getByLabelText('分类'), characterCategory.id);

    // title/summary/aliases 是所有分类共有的字段，不该被清空
    expect(within(dialog).getByLabelText('名称')).toHaveValue('共享名称');
  });
});

describe('删除与回收站', () => {
  it('删除条目移入回收站，可恢复', async () => {
    const user = userEvent.setup();
    await seedEntries();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: /沈清/u }));
    await user.click(screen.getByRole('button', { name: '删除这个条目' }));
    await user.click(screen.getByRole('button', { name: '移入回收站' }));

    await waitFor(() => expect(screen.queryByText('沈清')).not.toBeInTheDocument());
    expect(await harness.repository.listEntries(novel.id)).toHaveLength(2);

    // 回收站里能找到并恢复
    await user.click(await screen.findByRole('button', { name: /回收站（1）/u }));
    const trash = screen.getByRole('dialog');
    expect(within(trash).getByText('沈清')).toBeInTheDocument();
    await user.click(within(trash).getByRole('button', { name: '恢复' }));

    await waitFor(async () => {
      expect(await harness.repository.listEntries(novel.id)).toHaveLength(3);
    });
  });

  it('彻底删除需二次确认', async () => {
    const user = userEvent.setup();
    const entry = await harness.repository.createEntry(novel.id, {
      categoryId: worldCategory.id,
      title: '待清理',
    });
    await harness.repository.softDeleteEntry(entry.id);

    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: /回收站（1）/u }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '彻底删除' }));
    expect(screen.getByText(/无法恢复/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '永久删除' }));

    await waitFor(async () => {
      const all = await harness.repository.listEntries(novel.id, { includeDeleted: true });
      expect(all).toHaveLength(0);
    });
  });

  it('回收站为空时说明清楚', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(await screen.findByRole('button', { name: /回收站/u }));

    expect(within(screen.getByRole('dialog')).getByText('回收站是空的')).toBeInTheDocument();
  });
});

describe('分类管理', () => {
  async function openManager() {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: /分类管理/u }));
    return user;
  }

  it('列出分类、字段数与条目数，内置分类有标记', async () => {
    await seedEntries();
    await openManager();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByText('内置')).toHaveLength(2);
    expect(within(dialog).getByText(/4 个字段 · 1 个条目/u)).toBeInTheDocument();
  });

  it('一键添加常用分类', async () => {
    const user = await openManager();

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '+ 势力' }));

    await waitFor(async () => {
      const categories = await harness.repository.listCategories(novel.id);
      expect(categories.map((item) => item.name)).toContain('势力');
    });
    // 已添加的不再出现在建议里
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '+ 势力' })).not.toBeInTheDocument(),
    );
  });

  it('新建空白分类后直接进入编辑', async () => {
    const user = await openManager();

    await user.click(screen.getByRole('button', { name: '新建空白分类' }));

    expect(await screen.findByText('编辑分类 · 新分类')).toBeInTheDocument();
  });

  it('给分类加字段，条目编辑器立刻多出该输入框', async () => {
    const user = await openManager();

    await user.click(
      within(screen.getByRole('dialog')).getAllByRole('button', { name: '编辑' })[1]!,
    );
    const editor = await screen.findByText('编辑分类 · 人物');
    expect(editor).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /加字段/u }));
    const labelInputs = screen.getAllByLabelText('标签');
    const newLabel = labelInputs[labelInputs.length - 1]!;
    await user.clear(newLabel);
    await user.type(newLabel, '座右铭');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const categories = await harness.repository.listCategories(novel.id);
      const character = categories.find((item) => item.kind === 'character');
      expect(character?.fieldTemplate.some((field) => field.label === '座右铭')).toBe(true);
    });
  });

  it('内置分类不提供删除入口', async () => {
    const user = await openManager();

    await user.click(
      within(screen.getByRole('dialog')).getAllByRole('button', { name: '编辑' })[0]!,
    );
    await screen.findByText('编辑分类 · 世界观设定');

    expect(screen.queryByRole('button', { name: '删除这个分类' })).not.toBeInTheDocument();
    expect(screen.getByText(/内置分类不可删除/u)).toBeInTheDocument();
  });

  it('删除空的自定义分类', async () => {
    const custom = await harness.repository.createCategory(novel.id, { name: '地点' });
    const user = await openManager();

    const rows = within(screen.getByRole('dialog')).getAllByRole('button', { name: '编辑' });
    await user.click(rows[rows.length - 1]!);
    await screen.findByText('编辑分类 · 地点');
    await user.click(screen.getByRole('button', { name: '删除这个分类' }));
    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(async () => {
      const categories = await harness.repository.listCategories(novel.id);
      expect(categories.some((item) => item.id === custom.id)).toBe(false);
    });
  });

  it('分类下有条目时拒绝删除并说明原因', async () => {
    const custom = await harness.repository.createCategory(novel.id, { name: '道具' });
    await harness.repository.createEntry(novel.id, {
      categoryId: custom.id,
      title: '青铜镜',
    });
    const user = await openManager();

    const rows = within(screen.getByRole('dialog')).getAllByRole('button', { name: '编辑' });
    await user.click(rows[rows.length - 1]!);
    await screen.findByText('编辑分类 · 道具');
    await user.click(screen.getByRole('button', { name: '删除这个分类' }));

    expect(screen.getByText(/还有 1 个条目，需要先移走或删除/u)).toBeInTheDocument();
  });

  it('分类名为空时拦下', async () => {
    const user = await openManager();

    await user.click(
      within(screen.getByRole('dialog')).getAllByRole('button', { name: '编辑' })[0]!,
    );
    await screen.findByText('编辑分类 · 世界观设定');
    await user.clear(screen.getByLabelText('分类名'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.getByRole('alert')).toHaveTextContent('分类名不能为空');
  });
});

describe('导入旧稿入口', () => {
  it('从「管理」打开导入面板', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /导入旧稿/u }));

    const panel = await screen.findByRole('dialog', { name: '导入旧稿' });
    expect(within(panel).getByLabelText('旧稿正文')).toBeInTheDocument();
  });

  it('导入面板打开时不再渲染页面级的待确认区，避免两个确认入口', async () => {
    await harness.repository.createProposals([
      {
        id: 'p1',
        novelId: novel.id,
        batchId: null,
        order: 0,
        origin: 'extract',
        target: 'knowledgeEntry',
        action: 'create',
        targetId: null,
        label: '人物 · 待确认的人',
        payload: { categoryId: characterCategory.id, title: '待确认的人' },
        diff: [],
        sourceRef: '',
        status: 'pending',
        createdAt: Date.now(),
        decidedAt: null,
      },
    ]);

    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('待确认 1 项')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /导入旧稿/u }));
    await screen.findByRole('dialog', { name: '导入旧稿' });

    await waitFor(() => {
      expect(screen.queryByText('待确认 1 项')).not.toBeInTheDocument();
    });
  });
});

describe('互动推演设置（设计 §8.5）', () => {
  async function seedScenarioWithOc(title = '雾中渡') {
    return harness.repository.createScenario(novel.id, {
      title,
      setup: {
        cast: [{ entryId: '' }],
        start: { time: '', place: '渡口', situation: '在渡口醒来' },
        goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
        milestones: [],
        tone: '',
        expectedSteps: 30,
      },
      newOc: { categoryId: characterCategory.id, title: '沈砚', fields: { identity: '船夫' } },
    });
  }

  it('限定条目在列表里带「限定 · 推演《X》」徽标，通用条目没有', async () => {
    await seedEntries();
    await seedScenarioWithOc();
    renderPage();
    await waitForLoaded();
    const card = await screen.findByRole('button', { name: /沈砚/u });
    expect(within(card).getByText('限定 · 推演《雾中渡》')).toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: /林越/u })).queryByText(/限定/u),
    ).not.toBeInTheDocument();
  });

  it('作用范围改成通用后，条目出现在 listEntries 的默认结果里', async () => {
    const user = userEvent.setup();
    const scenario = await seedScenarioWithOc();
    expect(
      (await harness.repository.listEntries(novel.id)).map((entry) => entry.title),
    ).not.toContain('沈砚');
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: /沈砚/u }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByText('互动推演设置'));
    const scope = within(dialog).getByLabelText('作用范围');
    expect(scope).toHaveValue('limited');
    expect(within(dialog).getByLabelText('推演《雾中渡》')).toBeChecked();
    await user.selectOptions(scope, 'universal');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      expect(
        (await harness.repository.listEntries(novel.id)).map((entry) => entry.title),
      ).toContain('沈砚');
    });
    const oc = (await harness.repository.getEntry(scenario.setup.cast[0]!.entryId))!;
    expect(oc.scope).toEqual({ kind: 'universal' });
  });

  it('改为仅限推演：勾选推演并写登场条件；一个都不选时拦下', async () => {
    const user = userEvent.setup();
    await seedEntries();
    const scenario = await seedScenarioWithOc();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: /林越/u }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByText('互动推演设置'));
    await user.selectOptions(within(dialog).getByLabelText('作用范围'), 'limited');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('至少要选一个推演');

    await user.click(within(dialog).getByLabelText('推演《雾中渡》'));
    await user.type(within(dialog).getByLabelText('《雾中渡》的登场条件'), '主角上船之后');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      const linyue = (await harness.repository.listEntries(novel.id, { scope: 'all' })).find(
        (entry) => entry.title === '林越',
      );
      expect(linyue?.scope).toEqual({
        kind: 'limited',
        targets: [{ scenarioId: scenario.id, fromNodeId: null, revealHint: '主角上船之后' }],
      });
    });
  });

  it('逐字段可变性：显示继承的默认值，改成锁定后写入 fieldLocks，改回跟随分类则去掉', async () => {
    const user = userEvent.setup();
    await seedEntries();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: /林越/u }));
    let dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByText('互动推演设置'));
    const identity = within(dialog).getByLabelText('「身份」在世界线上');
    expect(identity).toHaveValue('');
    expect(
      within(identity).getByRole('option', { name: '跟随分类（默认：可变）' }),
    ).toBeInTheDocument();
    expect(
      within(within(dialog).getByLabelText('「说话方式」在世界线上')).getByRole('option', {
        name: '跟随分类（默认：锁定）',
      }),
    ).toBeInTheDocument();
    await user.selectOptions(identity, 'locked');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const find = async () =>
      (await harness.repository.listEntries(novel.id)).find((entry) => entry.title === '林越')!;
    await waitFor(async () => expect((await find()).fieldLocks).toEqual({ identity: 'locked' }));

    await user.click(await screen.findByRole('button', { name: /林越/u }));
    dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByText('互动推演设置'));
    await user.selectOptions(within(dialog).getByLabelText('「身份」在世界线上'), '');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(async () => expect((await find()).fieldLocks).toEqual({}));
  });

  it('所限定的推演已不存在时提示', async () => {
    const user = userEvent.setup();
    await harness.repository.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '孤魂',
      scope: {
        kind: 'limited',
        targets: [{ scenarioId: 'gone-scenario', fromNodeId: null, revealHint: '' }],
      },
    });
    renderPage();
    await waitForLoaded();
    const card = await screen.findByRole('button', { name: /孤魂/u });
    expect(within(card).getByText('限定 · 推演已不存在')).toBeInTheDocument();
    await user.click(card);
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByText('互动推演设置'));
    expect(within(dialog).getByText(/所限定的推演里有 1 个已不存在/u)).toBeInTheDocument();
  });

  it('分类管理：字段的「世界线可改写」开关写进 FieldDef.mutability', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(await screen.findByRole('button', { name: /分类管理/u }));
    await user.click(
      within(screen.getByRole('dialog')).getAllByRole('button', { name: '编辑' })[1]!,
    );
    await screen.findByText('编辑分类 · 人物');
    const identity = screen.getByLabelText('「身份」世界线可改写');
    expect(identity).toBeChecked();
    expect(screen.getByLabelText('「说话方式」世界线可改写')).not.toBeChecked();
    await user.click(identity);
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      const character = (await harness.repository.listCategories(novel.id)).find(
        (item) => item.kind === 'character',
      );
      expect(character?.fieldTemplate.find((field) => field.key === 'identity')?.mutability).toBe(
        'locked',
      );
    });
  });
});
