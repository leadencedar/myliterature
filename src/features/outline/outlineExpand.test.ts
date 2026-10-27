import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@/context/tokens';
import type { PlanningEntryBlock } from '@/context/planningContext';
import {
  KnowledgeEntrySchema,
  NovelSchema,
  OutlineNodeSchema,
  StyleProfileSchema,
  WritingNormSchema,
  type KnowledgeEntry,
  type OutlineNode,
  type WritingNorm,
} from '@/domain/schema';
import { composeStylePrefix } from '@/prompt/sections';
import { buildExpandSystemPrompt, buildExpandUserPrompt } from './outlineExpand';

const novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  createdAt: 0,
  updatedAt: 0,
});

const style = StyleProfileSchema.parse({
  id: 's1',
  novelId: 'n1',
  tradition: 'web',
  methodology: 'snowflake',
  createdAt: 0,
  updatedAt: 0,
});

function norm(overrides: Partial<WritingNorm> = {}): WritingNorm {
  return WritingNormSchema.parse({
    id: 'norm-1',
    novelId: 'n1',
    title: '使用提示',
    content: '- 分叉之后按新因果续写。【标记 E】',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function outlineNode(overrides: Partial<OutlineNode> = {}): OutlineNode {
  return OutlineNodeSchema.parse({
    id: 'o1',
    novelId: 'n1',
    title: '第一卷 渡口',
    synopsis: '林越醒来，卷入灭门案调查。',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function knowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    id: 'e-pei',
    novelId: 'n1',
    categoryId: 'c-char',
    title: '裴照',
    summary: '六扇门捕头，追查灭门案。',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

/** 规划选择器产出的条目块；prompt 只用 block.text，其余字段给站位值 */
function planningBlock(
  reason: PlanningEntryBlock['reason'],
  text: string,
  title = '块',
): PlanningEntryBlock {
  const entry = knowledgeEntry({ id: `e-${title}`, title });
  return { entry, reason, tokens: estimateTokens(text), text };
}

/** 现有细化调用的形状：不传任何 M1 新参数 */
function legacyUserPrompt(overrides: Partial<Parameters<typeof buildExpandUserPrompt>[0]> = {}) {
  return buildExpandUserPrompt({
    node: outlineNode(),
    ancestors: [],
    siblings: [outlineNode()],
    existingChildren: [
      outlineNode({
        id: 'o2',
        title: '夜探青冥宗',
        synopsis: '林越与裴照夜入青冥宗旧址，发现血书。',
      }),
      outlineNode({ id: 'o3', title: '血书', synopsis: '血书指向林越本人。' }),
    ],
    linkedEntries: [knowledgeEntry()],
    count: 4,
    extra: '每章都要有一次交锋',
    ...overrides,
  });
}

describe('细化大纲的系统提示 · 写作规范', () => {
  it('作用范围含规划时带上，位于稳定前缀之后、任务说明之前', () => {
    const prompt = buildExpandSystemPrompt(novel, style, [norm()]);
    const prefix = composeStylePrefix(novel, style);
    const at = prompt.indexOf('【作者的写作规范】');

    expect(prompt).toContain('【标记 E】');
    expect(prompt).toContain('规范本身不是需要生成的设定');
    expect(prompt.indexOf(prefix)).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThanOrEqual(prompt.indexOf(prefix) + prefix.length);
    expect(at).toBeLessThan(prompt.indexOf('【任务】'));
  });

  it('作用范围不含规划或已停用时不带，与不传完全相同', () => {
    const base = buildExpandSystemPrompt(novel, style);

    expect(buildExpandSystemPrompt(novel, style, [])).toBe(base);
    expect(buildExpandSystemPrompt(novel, style, [norm({ scopes: ['writing', 'check'] })])).toBe(
      base,
    );
    expect(buildExpandSystemPrompt(novel, style, [norm({ enabled: false })])).toBe(base);
  });

  it('两次调用逐字节相同', () => {
    const norms = [norm(), norm({ id: 'norm-2', title: '差异说明', order: 1 })];
    expect(buildExpandSystemPrompt(novel, style, norms)).toBe(
      buildExpandSystemPrompt(novel, style, norms),
    );
  });
});

describe('细化大纲的任务说明 · 场景卡', () => {
  it('保留原有约束', () => {
    const prompt = buildExpandSystemPrompt(novel, style);
    expect(prompt).toContain('- 只拆这一个节点');
    expect(prompt).toContain('- 子节点之间要有因果推进');
    expect(prompt).toContain('- targetWords 给出该子节点的预估字数');
  });

  it('增补场景卡与「设定落地为选择」的要求', () => {
    const prompt = buildExpandSystemPrompt(novel, style);
    expect(prompt).toContain('按「场景卡」写');
    expect(prompt).toContain('谁想要什么、什么在阻碍、转折点在哪里、结尾留下什么局面或认知变化');
    expect(prompt).toContain('在软肋或世界规则的代价上做出一次选择或拒绝');
    expect(prompt).toContain('这次选择必须改变后文走向');
    expect(prompt).toContain('把设定复述进梗概不算「应用设定」');
    expect(prompt).toContain('世界规则不要点名复述，只写它逼出的代价');
    expect(prompt).toContain('不得违背【必须遵守的核心设定】');
    expect(prompt).toContain('章末要能看出钩子与信息差');
    expect(prompt).toContain('不凑数拉长');
    expect(prompt).toContain('父节点没有目标时按每章约 3000 字估');
  });
});

describe('细化大纲的系统提示 · 核心设定', () => {
  const coreBlocks = [
    planningBlock('core', '## 归墟界（世界观）\n修行走火入魔会折寿。', '归墟界'),
    planningBlock('core', '## 沈砚（人物）\n软肋：妹妹。', '沈砚'),
  ];

  it('核心设定进 system，位于文风/规范之后、任务之前', () => {
    const prompt = buildExpandSystemPrompt(novel, style, [norm()], coreBlocks);

    expect(prompt).toContain('【必须遵守的核心设定】');
    expect(prompt).toContain('修行走火入魔会折寿。');
    const coreAt = prompt.indexOf('【必须遵守的核心设定】');
    expect(coreAt).toBeGreaterThan(prompt.indexOf('【标记 E】'));
    expect(coreAt).toBeLessThan(prompt.indexOf('【任务】'));
  });

  it('不传、传空数组与传 undefined 输出完全相同', () => {
    const base = buildExpandSystemPrompt(novel, style);
    expect(buildExpandSystemPrompt(novel, style, [], [])).toBe(base);
    expect(buildExpandSystemPrompt(novel, style, undefined, undefined)).toBe(base);
    expect(buildExpandSystemPrompt(novel, style, [], undefined)).toBe(base);
  });

  it('同一本书、同一份核心设定、不同节点：system 逐字节相同（缓存前提）', () => {
    const first = buildExpandSystemPrompt(novel, style, [], coreBlocks);
    const second = buildExpandSystemPrompt(novel, style, [], coreBlocks);
    expect(first).toBe(second);
    // 逐节点变化的内容（节点、相关设定）只允许出现在 user prompt 里
    const node = outlineNode({ title: '另一个节点', synopsis: '完全不同的梗概。' });
    const user = buildExpandUserPrompt({
      node,
      ancestors: [],
      siblings: [node],
      existingChildren: [],
      linkedEntries: [],
      count: 3,
      related: [planningBlock('mentioned', '## 裴照（人物）\n说话方式：短句。', '裴照')],
    });
    expect(user).not.toContain('【必须遵守的核心设定】');
    expect(user).not.toContain('修行走火入魔会折寿。');
  });
});

describe('细化大纲的用户提示 · 向后兼容', () => {
  it('旧调用（linkedEntries + extra）输出逐字节不变', () => {
    expect(legacyUserPrompt()).toBe(
      `【当前位置】
要拆分的节点：第一卷 渡口
该节点梗概：林越醒来，卷入灭门案调查。

该节点已有的子节点（本次将被替换，可参考也可推翻）：
- 夜探青冥宗：林越与裴照夜入青冥宗旧址，发现血书。
- 血书：血书指向林越本人。

关联设定：
- 裴照：六扇门捕头，追查灭门案。

【本次要求】
拆成 4 个子节点。

【用户额外要求】
每章都要有一次交锋`,
    );
  });

  it('最简旧调用（无关联、无额外要求、无梗概）输出逐字节不变', () => {
    const node = outlineNode({ id: 'o9', title: '第二卷 北境', synopsis: '' });
    const prompt = buildExpandUserPrompt({
      node,
      ancestors: [],
      siblings: [node],
      existingChildren: [],
      linkedEntries: [],
      count: 2,
    });
    expect(prompt).toBe(
      `【当前位置】
要拆分的节点：第二卷 北境

【本次要求】
拆成 2 个子节点。`,
    );
  });
});

describe('细化大纲的用户提示 · 新块与顺序', () => {
  const node = outlineNode();
  const sameLevel = outlineNode({ id: 'o-sibling', title: '第二卷 青冥', synopsis: '北上追查。' });
  const related = [
    planningBlock('linked', '## 裴照（人物）\n别名：裴捕头\n说话方式：短句、爱用反问。', '裴照'),
    planningBlock('mentioned', '## 沈砚（人物）\n软肋与恐惧：妹妹。', '沈砚'),
  ];

  function fullPrompt() {
    return buildExpandUserPrompt({
      node,
      ancestors: [outlineNode({ id: 'o-root', title: '全书' })],
      siblings: [node, sameLevel],
      existingChildren: [outlineNode({ id: 'o2', title: '夜探青冥宗', synopsis: '发现血书。' })],
      linkedEntries: [knowledgeEntry()],
      count: 5,
      extra: '结尾留悬念',
      related,
      openThreads: ['林越的身世', '刀的来历'],
      rollingSummary: '林越在渡口醒来，随裴照北上。',
      depth: 0,
    });
  }

  it('块顺序：当前位置 → 同层 → 已有子节点 → 相关设定 → 伏笔 → 故事至此 → 本次要求 → 额外要求', () => {
    const prompt = fullPrompt();
    const at = (needle: string) => {
      const index = prompt.indexOf(needle);
      expect(index, `缺少块：${needle}`).toBeGreaterThanOrEqual(0);
      return index;
    };

    const positions = [
      at('【当前位置】'),
      at('同层的其他节点'),
      at('该节点已有的子节点'),
      at('【相关设定】'),
      at('【当前未收束的伏笔】'),
      at('【故事至此】'),
      at('【本次要求】'),
      at('【用户额外要求】'),
    ];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('传 related 时用完整字段块，不再回退旧「标题：摘要」', () => {
    const prompt = fullPrompt();
    expect(prompt).toContain('【相关设定】');
    expect(prompt).toContain('## 裴照（人物）');
    expect(prompt).toContain('说话方式：短句、爱用反问。');
    expect(prompt).toContain('## 沈砚（人物）');
    expect(prompt).toContain(
      '子节点要体现它们的约束与关系；不得违背核心设定。不需要复述设定原文。',
    );
    expect(prompt).not.toContain('关联设定：');
    expect(prompt).not.toContain('- 裴照：六扇门捕头，追查灭门案。');
  });

  it('related 传空数组表示「本次没有相关设定」，也不回退 linkedEntries', () => {
    const prompt = buildExpandUserPrompt({
      node,
      ancestors: [],
      siblings: [node],
      existingChildren: [],
      linkedEntries: [knowledgeEntry()],
      count: 3,
      related: [],
    });
    expect(prompt).not.toContain('【相关设定】');
    expect(prompt).not.toContain('关联设定：');
  });

  it('伏笔块用「标题 + 逐条 -」，空串与空白项被过滤', () => {
    const prompt = buildExpandUserPrompt({
      node,
      ancestors: [],
      siblings: [node],
      existingChildren: [],
      linkedEntries: [],
      count: 3,
      openThreads: ['林越的身世', '  ', '刀的来历'],
    });
    expect(prompt).toContain('【当前未收束的伏笔】\n- 林越的身世\n- 刀的来历');
    expect(prompt).not.toContain('-   ');

    const without = buildExpandUserPrompt({
      node,
      ancestors: [],
      siblings: [node],
      existingChildren: [],
      linkedEntries: [],
      count: 3,
      openThreads: [],
    });
    expect(without).not.toContain('【当前未收束的伏笔】');
  });

  it('【故事至此】只在 depth === 0 时出现', () => {
    const withSummary = (depth: number | undefined) =>
      buildExpandUserPrompt({
        node,
        ancestors: [],
        siblings: [node],
        existingChildren: [],
        linkedEntries: [],
        count: 3,
        rollingSummary: '林越在渡口醒来，随裴照北上。',
        ...(depth === undefined ? {} : { depth }),
      });

    expect(withSummary(0)).toContain('【故事至此】\n林越在渡口醒来，随裴照北上。');
    expect(withSummary(1)).not.toContain('【故事至此】');
    expect(withSummary(undefined)).not.toContain('【故事至此】');
    expect(withSummary(2)).not.toContain('【故事至此】');
  });

  it('空白 rollingSummary 不渲染空块', () => {
    const prompt = buildExpandUserPrompt({
      node,
      ancestors: [],
      siblings: [node],
      existingChildren: [],
      linkedEntries: [],
      count: 3,
      rollingSummary: '   \n ',
      depth: 0,
    });
    expect(prompt).not.toContain('【故事至此】');
  });

  it('relatedDropped 刻意不写进 prompt（只供面板提示），输出不变', () => {
    const dropped = [planningBlock('mentioned', '## 北境雪原（世界观）\n终年积雪。', '北境雪原')];
    const base = buildExpandUserPrompt({
      node,
      ancestors: [],
      siblings: [node],
      existingChildren: [],
      linkedEntries: [],
      count: 3,
      related,
    });
    const withDropped = buildExpandUserPrompt({
      node,
      ancestors: [],
      siblings: [node],
      existingChildren: [],
      linkedEntries: [],
      count: 3,
      related,
      relatedDropped: dropped,
    });
    expect(withDropped).toBe(base);
    expect(withDropped).not.toContain('北境雪原');
  });
});
