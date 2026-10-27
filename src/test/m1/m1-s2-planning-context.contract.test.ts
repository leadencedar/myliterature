/**
 * S2 独立验收：`selectPlanningEntries`（design §3.2 规则 1–5）。
 *
 * 独立于开发测试：预算用例用「大预算先测出各条目真实 token，再用精确预算收紧」的方式构造，
 * 期望按设计规则手算（core 必注入 → linked 整条丢弃 → mentioned 从低分丢），
 * 并单独校验 tokens/text 与 `renderEntry` 同口径。
 */
import { describe, expect, it } from 'vitest';
import {
  CategorySchema,
  KnowledgeEntrySchema,
  type Category,
  type KnowledgeEntry,
} from '@/domain/schema';
import {
  MAX_PLANNING_MENTIONED,
  PLANNING_CONTEXT_BUDGET,
  selectPlanningEntries,
  type PlanningSelection,
} from '@/context/planningContext';
import { renderEntry } from '@/context/renderEntry';
import { estimateTokens } from '@/context/tokens';

const category: Category = CategorySchema.parse({
  id: 'c1',
  novelId: 'n1',
  name: '人物',
  kind: 'character',
  builtin: true,
  fieldTemplate: [
    { key: 'detail', label: '细节', type: 'longtext' },
    { key: 'note', label: '备注', type: 'text' },
  ],
  order: 0,
  createdAt: 0,
  updatedAt: 0,
});

let seq = 0;
function entry(
  title: string,
  options: {
    aliases?: string[];
    summary?: string;
    detail?: string;
    note?: string;
    pinned?: boolean;
    deletedAt?: number | null;
  } = {},
): KnowledgeEntry {
  seq += 1;
  return KnowledgeEntrySchema.parse({
    id: `e-${String(seq).padStart(3, '0')}`,
    novelId: 'n1',
    categoryId: 'c1',
    title,
    aliases: options.aliases ?? [],
    summary: options.summary ?? '',
    fields: {
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.note === undefined ? {} : { note: options.note }),
    },
    pinned: options.pinned ?? false,
    deletedAt: options.deletedAt ?? null,
    createdAt: seq,
    updatedAt: seq,
  });
}

const LONG = '设定'.repeat(60); // 约 96 token，用于把单条撑大

function select(
  overrides: Partial<Parameters<typeof selectPlanningEntries>[0]> = {},
): PlanningSelection {
  return selectPlanningEntries({
    texts: [],
    entries: [],
    categories: [category],
    linkedEntryIds: [],
    ...overrides,
  });
}

function tokensOf(selection: PlanningSelection): number {
  return [...selection.core, ...selection.related].reduce((sum, block) => sum + block.tokens, 0);
}

describe('selectPlanningEntries · 常量与档位顺序（design §3.2 规则 1–3）', () => {
  it('默认预算 8000、提到条目上限 8', () => {
    expect(PLANNING_CONTEXT_BUDGET).toBe(8000);
    expect(MAX_PLANNING_MENTIONED).toBe(8);
  });

  it('core = pinned，按 entries 原顺序，且不出现在 related', () => {
    const first = entry('核心甲', { pinned: true });
    const normal = entry('路人');
    const second = entry('核心乙', { pinned: true });
    const selection = select({
      entries: [first, normal, second],
      texts: ['核心甲与核心乙还有路人'],
    });

    expect(selection.core.map((block) => block.entry.id)).toEqual([first.id, second.id]);
    expect(selection.core.every((block) => block.reason === 'core')).toBe(true);
    expect(selection.related.map((block) => block.entry.id)).not.toContain(first.id);
    expect(selection.related.map((block) => block.entry.id)).not.toContain(second.id);
    // 名称命中的普通条目落在 mentioned
    expect(selection.related.map((block) => block.entry.id)).toEqual([normal.id]);
    expect(selection.related[0]!.reason).toBe('mentioned');
  });

  it('linked 按 linkedEntryIds 顺序（不是 entries 顺序），去重且不重复 pinned', () => {
    const a = entry('甲');
    const b = entry('乙');
    const pinned = entry('核心', { pinned: true });
    const selection = select({
      entries: [a, b, pinned],
      linkedEntryIds: [b.id, a.id, b.id, pinned.id, 'ghost-id'],
    });

    expect(selection.related.map((block) => block.entry.id)).toEqual([b.id, a.id]);
    expect(selection.related.map((block) => block.reason)).toEqual(['linked', 'linked']);
    expect(selection.core.map((block) => block.entry.id)).toEqual([pinned.id]);
  });

  it('mentioned：排除 pinned 与 explicit linked，按分数降序，默认最多 8 条', () => {
    const pinned = entry('核心', { pinned: true });
    const linkedEntry = entry('显式关联');
    const mentionedA = entry('裴照之'); // title 3 字 = 106
    const mentionedB = entry('林越'); // title 2 字 = 84
    const texts = ['核心 显式关联 裴照之 林越'];
    const selection = select({
      entries: [pinned, linkedEntry, mentionedA, mentionedB],
      linkedEntryIds: [linkedEntry.id],
      texts,
    });

    expect(selection.related.map((block) => block.entry.id)).toEqual([
      linkedEntry.id,
      mentionedA.id,
      mentionedB.id,
    ]);
    expect(selection.related.map((block) => block.reason)).toEqual([
      'linked',
      'mentioned',
      'mentioned',
    ]);
    // 命中名与分数透传给 UI
    expect(selection.related[1]).toMatchObject({ matchedName: '裴照之', score: 106 });
    expect(selection.related[2]).toMatchObject({ matchedName: '林越', score: 84 });
  });

  it('maxMentioned 可收窄；为 0 时不带推断条目', () => {
    const entries = Array.from({ length: 5 }, (_, index) => entry(`角色${index}`));
    const texts = [entries.map((item) => item.title).join(' ')];
    expect(select({ entries, texts, maxMentioned: 2 }).related).toHaveLength(2);
    expect(select({ entries, texts, maxMentioned: 0 }).related).toHaveLength(0);
  });

  it('空文本/空条目：不产生 related，core 仍注入', () => {
    const pinned = entry('核心', { pinned: true });
    expect(select({ entries: [pinned], texts: [] })).toMatchObject({ related: [], dropped: [] });
    expect(select({ entries: [], texts: ['任何文本'] })).toEqual({
      core: [],
      related: [],
      dropped: [],
      tokens: 0,
    });
  });
});

describe('selectPlanningEntries · 渲染与 tokens（design §3.2 规则 4）', () => {
  it('block.text 与正文侧 renderEntry 逐字节一致，tokens 同口径，合计等于 tokens', () => {
    const pinned = entry('核心', { pinned: true, detail: LONG });
    const linkedEntry = entry('显式', { summary: '一句话' });
    const mentioned = entry('提到的人');
    const selection = select({
      entries: [pinned, linkedEntry, mentioned],
      linkedEntryIds: [linkedEntry.id],
      texts: ['提到的人来了'],
    });

    for (const block of [...selection.core, ...selection.related]) {
      expect(block.text).toBe(renderEntry(block.entry, [category]));
      expect(block.tokens).toBe(estimateTokens(block.text));
    }
    expect(selection.tokens).toBe(tokensOf(selection));
  });

  it('默认预算下正常书况不丢条目', () => {
    const entries = [entry('核心', { pinned: true }), entry('甲甲'), entry('乙乙')];
    const selection = select({
      entries,
      linkedEntryIds: [entries[1]!.id],
      texts: [entries[2]!.title],
    });
    expect(selection.dropped).toEqual([]);
    expect(selection.related).toHaveLength(2);
  });
});

describe('selectPlanningEntries · 预算裁剪（design §3.2 规则 4）', () => {
  it('预算为 0：core 照样注入，其余全部 dropped（含 dropped 内容/token）', () => {
    const pinned = entry('核心', { pinned: true, detail: LONG });
    const linkedEntry = entry('显式');
    const mentioned = entry('提到的人');
    const selection = select({
      entries: [pinned, linkedEntry, mentioned],
      linkedEntryIds: [linkedEntry.id],
      texts: ['提到的人'],
      budget: 0,
    });

    expect(selection.core.map((block) => block.entry.id)).toEqual([pinned.id]);
    expect(selection.related).toEqual([]);
    expect(selection.dropped.map((block) => block.entry.id)).toEqual([
      linkedEntry.id,
      mentioned.id,
    ]);
    expect(selection.dropped.map((block) => block.reason)).toEqual(['linked', 'mentioned']);
    for (const block of selection.dropped) {
      expect(block.text).toBe(renderEntry(block.entry, [category]));
      expect(block.tokens).toBe(estimateTokens(block.text));
    }
    expect(selection.tokens).toBe(selection.core.reduce((sum, block) => sum + block.tokens, 0));
  });

  it('预算先丢提到的最低分：高/中分保留，低分整条 dropped', () => {
    const pinned = entry('核心', { pinned: true });
    const high = entry('甲甲甲'); // 106，id 最先 → 排最前
    const middle = entry('乙乙乙'); // 106，id 居中
    const low = entry('丙丙'); // 84，排最后
    const texts = ['甲甲甲 乙乙乙 丙丙'];

    // 先测真实 token，构造精确预算
    const loose = select({ entries: [pinned, high, middle, low], texts });
    const coreTokens = loose.core.reduce((sum, block) => sum + block.tokens, 0);
    const highBlock = loose.related.find((block) => block.entry.id === high.id)!;
    const middleBlock = loose.related.find((block) => block.entry.id === middle.id)!;
    const lowBlock = loose.related.find((block) => block.entry.id === low.id)!;
    expect([highBlock, middleBlock, lowBlock].every(Boolean)).toBe(true);

    const budget = coreTokens + highBlock.tokens + middleBlock.tokens + 1; // core + 高分 + 中分
    const tight = select({ entries: [pinned, high, middle, low], texts, budget });
    expect(tight.related.map((block) => block.entry.id)).toEqual([high.id, middle.id]);
    expect(tight.dropped.map((block) => block.entry.id)).toEqual([low.id]);
    expect(tight.dropped[0]!.reason).toBe('mentioned');
    expect(tight.tokens).toBe(coreTokens + highBlock.tokens + middleBlock.tokens);
  });

  it('显式关联超出预算时整条丢弃并记入 dropped（不截断内容）', () => {
    const huge = entry('超大显式关联', { detail: LONG });
    const budgetPinned = entry('核心', { pinned: true });

    const loose = select({ entries: [budgetPinned, huge], linkedEntryIds: [huge.id] });
    const hugeTokens = loose.related[0]!.tokens;

    const tight = select({
      entries: [budgetPinned, huge],
      linkedEntryIds: [huge.id],
      budget: hugeTokens - 1,
    });
    // core 也占预算：用「仅 core + hugeTokens - 1」会更紧，这里只断言 huge 不在 related
    expect(tight.related).toEqual([]);
    expect(tight.dropped.map((block) => block.entry.id)).toEqual([huge.id]);
    expect(tight.dropped[0]!.tokens).toBe(hugeTokens);
    expect(tight.tokens).toBe(tight.core.reduce((sum, block) => sum + block.tokens, 0));
  });

  it('dropped 顺序确定：先 linked 后 mentioned，各档按既定顺序', () => {
    const linkedEntry = entry('显式关联');
    const first = entry('甲甲');
    const second = entry('乙乙');
    const selection = select({
      entries: [linkedEntry, first, second],
      linkedEntryIds: [linkedEntry.id],
      texts: ['甲甲 乙乙'],
      budget: 0,
    });
    expect(selection.dropped.map((block) => block.reason)).toEqual([
      'linked',
      'mentioned',
      'mentioned',
    ]);
    // mentioned 内部按分数降序；三条都是 2 字 title = 84，按 id 升序（创建顺序）
    expect(selection.dropped.map((block) => block.entry.id)).toEqual([
      linkedEntry.id,
      first.id,
      second.id,
    ]);
  });
});

describe('selectPlanningEntries · 确定性（design §3.2 规则 5）', () => {
  it('同一输入两次调用完全深相等、JSON 逐字节相同', () => {
    const entries = [
      entry('核心', { pinned: true }),
      entry('林越', { aliases: ['阿越'] }),
      entry('裴照之'),
      entry('路人'),
    ];
    const input = {
      texts: ['核心 林越 裴照之'],
      entries,
      categories: [category],
      linkedEntryIds: [entries[3]!.id],
    };
    const first = selectPlanningEntries(input);
    const second = selectPlanningEntries(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('entries 顺序变化不影响 mentioned 排序（core 顺序按 entries 原序是设计约定）', () => {
    const a = entry('甲甲甲');
    const b = entry('乙乙');
    const texts = ['甲甲甲 乙乙'];
    const first = select({ entries: [a, b], texts });
    const second = select({ entries: [b, a], texts });
    expect(second.related.map((block) => block.entry.id)).toEqual(
      first.related.map((block) => block.entry.id),
    );
  });
});
