import { describe, expect, it } from 'vitest';
import { CategorySchema, KnowledgeEntrySchema, type KnowledgeEntry } from '@/domain/schema';
import { renderEntry } from './renderEntry';
import {
  MAX_PLANNING_MENTIONED,
  PLANNING_CONTEXT_BUDGET,
  selectPlanningEntries,
} from './planningContext';
import { estimateTokens } from './tokens';

const categories = [
  CategorySchema.parse({
    id: 'c-char',
    novelId: 'n1',
    name: '人物',
    kind: 'character',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  }),
  CategorySchema.parse({
    id: 'c-world',
    novelId: 'n1',
    name: '世界观',
    kind: 'worldbuilding',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  }),
];

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    id: 'e1',
    novelId: 'n1',
    categoryId: 'c-char',
    title: '沈砚',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function tokensOf(target: KnowledgeEntry): number {
  return estimateTokens(renderEntry(target, categories));
}

/** 一个「有核心设定、有显式关联、有名称命中」的完整书况 */
function book() {
  const core = entry({ id: 'e-core', title: '归墟界', pinned: true, categoryId: 'c-world' });
  const linked = entry({ id: 'e-linked', title: '裴照' });
  const mentioned = entry({ id: 'e-mentioned', title: '青冥宗长老' });
  const unmentioned = entry({ id: 'e-unmentioned', title: '北境雪原', categoryId: 'c-world' });
  return { core, linked, mentioned, unmentioned };
}

function select(overrides: Partial<Parameters<typeof selectPlanningEntries>[0]> = {}) {
  const { core, linked, mentioned, unmentioned } = book();
  return selectPlanningEntries({
    texts: ['青冥宗长老在渡口遇见裴照，与沈砚擦肩而过。'],
    entries: [core, linked, mentioned, unmentioned],
    categories,
    linkedEntryIds: [linked.id],
    ...overrides,
  });
}

describe('selectPlanningEntries · 档位与顺序', () => {
  it('核心设定始终注入且保持条目原顺序，不进入 related', () => {
    const first = entry({ id: 'e-p1', title: '归墟界', pinned: true });
    const second = entry({ id: 'e-p2', title: '量劫', pinned: true });
    const normal = entry({ id: 'e-n', title: '沈砚' });

    const selection = selectPlanningEntries({
      texts: [],
      entries: [normal, first, second],
      categories,
      linkedEntryIds: [],
    });

    expect(selection.core.map((block) => block.entry.id)).toEqual(['e-p1', 'e-p2']);
    expect(selection.core.every((block) => block.reason === 'core')).toBe(true);
    expect(selection.related).toEqual([]);
  });

  it('显式关联按 linkedEntryIds 顺序，不存在/已删除/核心条目不重复', () => {
    const core = entry({ id: 'e-core', title: '归墟界', pinned: true });
    const a = entry({ id: 'e-a', title: '裴照' });
    const b = entry({ id: 'e-b', title: '青冥宗' });
    const removed = entry({ id: 'e-removed', title: '旧稿人物', deletedAt: 1 });

    const selection = selectPlanningEntries({
      texts: [],
      entries: [core, a, b, removed],
      categories,
      linkedEntryIds: ['e-b', 'missing-id', 'e-core', 'e-removed', 'e-a', 'e-b'],
    });

    expect(selection.related.map((block) => block.entry.id)).toEqual(['e-b', 'e-a']);
    expect(selection.related.every((block) => block.reason === 'linked')).toBe(true);
  });

  it('提到的条目排在显式关联之后，按分数降序', () => {
    const linked = entry({ id: 'e-linked', title: '裴照' });
    const longName = entry({ id: 'e-long', title: '青冥宗长老' });
    const shortName = entry({ id: 'e-short', title: '小舟' });

    const selection = selectPlanningEntries({
      texts: ['青冥宗长老带着小舟见裴照'],
      entries: [longName, shortName, linked],
      categories,
      linkedEntryIds: [linked.id],
    });

    expect(selection.related.map((block) => block.entry.id)).toEqual([
      'e-linked',
      'e-long',
      'e-short',
    ]);
    const mentioned = selection.related.filter((block) => block.reason === 'mentioned');
    expect(mentioned[0]?.score).toBe(100 + 5 * 2);
    expect(mentioned[0]?.matchedName).toBe('青冥宗长老');
    expect(mentioned[1]?.score).toBe(100 + 4 - 20);
  });

  it('提到的条目默认最多 8 条，并排除核心与已关联的条目', () => {
    const core = entry({ id: 'e-core', title: '归墟界', pinned: true });
    const linked = entry({ id: 'e-linked', title: '裴照' });
    const many = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `e-${index}`, title: `角色甲乙${index}` }),
    );
    const text =
      '归墟界里裴照和角色甲乙0角色甲乙1角色甲乙2角色甲乙3角色甲乙4角色甲乙5角色甲乙6角色甲乙7角色甲乙8角色甲乙9';

    const selection = selectPlanningEntries({
      texts: [text],
      entries: [core, linked, ...many],
      categories,
      linkedEntryIds: [linked.id],
    });

    expect(selection.related.filter((block) => block.reason === 'mentioned')).toHaveLength(
      MAX_PLANNING_MENTIONED,
    );
    expect(selection.related[0]?.entry.id).toBe('e-linked');
    expect(selection.core.map((block) => block.entry.id)).toEqual(['e-core']);
  });

  it('maxMentioned 可显式收窄', () => {
    const a = entry({ id: 'e-a', title: '青冥宗长老' });
    const b = entry({ id: 'e-b', title: '北境雪原' });
    const selection = selectPlanningEntries({
      texts: ['青冥宗长老在北境雪原'],
      entries: [a, b],
      categories,
      linkedEntryIds: [],
      maxMentioned: 1,
    });
    expect(selection.related).toHaveLength(1);
  });
});

describe('selectPlanningEntries · 渲染与预算', () => {
  it('block.text 与正文侧 renderEntry 逐字节一致，tokens 同口径', () => {
    const selection = select();
    const block = selection.related[0];
    expect(block?.text).toBe(renderEntry(block!.entry, categories));
    expect(block?.tokens).toBe(estimateTokens(block!.text));
    expect(selection.tokens).toBe(
      [...selection.core, ...selection.related].reduce((sum, item) => sum + item.tokens, 0),
    );
  });

  it('默认预算 8000，正常书况一条都不丢', () => {
    const selection = select();
    expect(PLANNING_CONTEXT_BUDGET).toBe(8_000);
    expect(selection.dropped).toEqual([]);
    expect(selection.tokens).toBeLessThanOrEqual(PLANNING_CONTEXT_BUDGET);
  });

  it('核心设定超预算也注入，只是把预算吃满', () => {
    const core = entry({ id: 'e-core', title: '归墟界', pinned: true });
    const linked = entry({ id: 'e-linked', title: '裴照' });
    const selection = selectPlanningEntries({
      texts: [],
      entries: [core, linked],
      categories,
      linkedEntryIds: [linked.id],
      budget: 1,
    });

    expect(selection.core.map((block) => block.entry.id)).toEqual(['e-core']);
    expect(selection.related).toEqual([]);
    expect(selection.dropped.map((block) => block.entry.id)).toEqual(['e-linked']);
    expect(selection.tokens).toBe(tokensOf(core));
  });

  it('预算先丢提到的：低分条目记入 dropped，高分保留', () => {
    const { core, linked } = book();
    const high = entry({ id: 'e-high', title: '青冥宗长老' });
    const low = entry({ id: 'e-low', title: '渡口' });

    const selection = selectPlanningEntries({
      texts: ['青冥宗长老在渡口'],
      entries: [core, linked, high, low],
      categories,
      linkedEntryIds: [linked.id],
      budget: tokensOf(core) + tokensOf(linked) + tokensOf(high),
    });

    expect(selection.related.map((block) => block.entry.id)).toEqual(['e-linked', 'e-high']);
    expect(selection.dropped.map((block) => block.entry.id)).toEqual(['e-low']);
    expect(selection.tokens).toBe(tokensOf(core) + tokensOf(linked) + tokensOf(high));
  });

  it('显式关联超出预算时整条丢弃并进入 dropped（不截断条目内容）', () => {
    const core = entry({ id: 'e-core', title: '归墟界', pinned: true });
    const big = entry({ id: 'e-big', title: '很长的设定名', summary: 'x'.repeat(200) });
    const selection = selectPlanningEntries({
      texts: [],
      entries: [core, big],
      categories,
      linkedEntryIds: [big.id],
      budget: tokensOf(core) + tokensOf(big) - 1,
    });

    expect(selection.related).toEqual([]);
    expect(selection.dropped).toHaveLength(1);
    expect(selection.dropped[0]?.entry.id).toBe('e-big');
    expect(selection.dropped[0]?.text).toBe(renderEntry(big, categories));
  });

  it('高分条目放不下时不会跳过它去塞更低分的条目', () => {
    const { core } = book();
    const high = entry({ id: 'e-high', title: '青冥宗长老', summary: 'x'.repeat(200) });
    const low = entry({ id: 'e-low', title: '渡口' });
    const selection = selectPlanningEntries({
      texts: ['青冥宗长老在渡口'],
      entries: [core, high, low],
      categories,
      linkedEntryIds: [],
      budget: tokensOf(core) + 10,
    });

    expect(selection.related).toEqual([]);
    expect(selection.dropped.map((block) => block.entry.id)).toEqual(['e-high', 'e-low']);
  });

  it('dropped 顺序确定：先显式关联后提到的，各自保持原有顺序', () => {
    const { core, linked } = book();
    const high = entry({ id: 'e-high', title: '青冥宗长老' });
    const low = entry({ id: 'e-low', title: '渡口' });
    const selection = selectPlanningEntries({
      texts: ['青冥宗长老在渡口'],
      entries: [core, linked, high, low],
      categories,
      linkedEntryIds: [linked.id],
      budget: tokensOf(core),
    });

    expect(selection.dropped.map((block) => block.entry.id)).toEqual([
      'e-linked',
      'e-high',
      'e-low',
    ]);
  });
});

describe('selectPlanningEntries · 确定性与边界', () => {
  it('同一输入两次调用完全深相等', () => {
    const first = select();
    const second = select();
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('没有文本、没有关联时只有核心设定', () => {
    const core = entry({ id: 'e-core', title: '归墟界', pinned: true });
    const selection = selectPlanningEntries({
      texts: [],
      entries: [core],
      categories,
      linkedEntryIds: [],
    });
    expect(selection.core).toHaveLength(1);
    expect(selection.related).toEqual([]);
    expect(selection.dropped).toEqual([]);
  });

  it('没有条目时返回全空选择', () => {
    const selection = selectPlanningEntries({
      texts: ['沈砚'],
      entries: [],
      categories,
      linkedEntryIds: [],
    });
    expect(selection).toEqual({ core: [], related: [], dropped: [], tokens: 0 });
  });

  it('预算为 0 时核心照样注入，其余全部 dropped', () => {
    const selection = selectPlanningEntries({
      texts: ['沈砚在渡口遇见裴照'],
      entries: [entry({ id: 'e-core', title: '归墟界', pinned: true }), entry({ id: 'e-p' })],
      categories,
      linkedEntryIds: [],
      budget: 0,
    });
    expect(selection.core).toHaveLength(1);
    expect(selection.related).toEqual([]);
    expect(selection.dropped.length).toBeGreaterThan(0);
  });
});
