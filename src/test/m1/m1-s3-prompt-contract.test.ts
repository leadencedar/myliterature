/**
 * S3 独立验收：细化提示词与注入块（design §4）。
 *
 * 独立于开发的 outlineExpand.test.ts：按设计逐条断言块位置、缓存前缀纪律与向后兼容边界。
 * 「无新参数时逐字节不变」由 m1-canary-stable 用 HEAD golden 证明；这里覆盖新参数行为。
 */
import { describe, expect, it } from 'vitest';
import {
  CategorySchema,
  KnowledgeEntrySchema,
  NovelSchema,
  OutlineNodeSchema,
  StyleProfileSchema,
  WritingNormSchema,
  type Category,
  type KnowledgeEntry,
  type OutlineNode,
} from '@/domain/schema';
import type { PlanningEntryBlock } from '@/context/planningContext';
import { renderEntry } from '@/context/renderEntry';
import { estimateTokens } from '@/context/tokens';
import {
  ExpandedChildSchema,
  OutlineExpandSchema,
  buildExpandSystemPrompt,
  buildExpandUserPrompt,
} from '@/features/outline/outlineExpand';

const novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  oneLiner: '失忆剑客查灭门案。',
  createdAt: 0,
  updatedAt: 0,
});

const style = StyleProfileSchema.parse({
  id: 's1',
  novelId: 'n1',
  tradition: 'web',
  subGenre: '仙侠',
  methodology: 'web-rhythm',
  createdAt: 0,
  updatedAt: 0,
});

const category: Category = CategorySchema.parse({
  id: 'c-char',
  novelId: 'n1',
  name: '人物',
  kind: 'character',
  builtin: true,
  fieldTemplate: [
    { key: 'voice', label: '说话方式', type: 'text' },
    { key: 'weakness', label: '软肋与恐惧', type: 'text' },
  ],
  order: 0,
  createdAt: 0,
  updatedAt: 0,
});

const norm = WritingNormSchema.parse({
  id: 'norm-1',
  novelId: 'n1',
  title: '原作基线',
  content: '- 以已导入资料为原作基线。【标记 QA】',
  enabled: true,
  scopes: ['planning'],
  order: 0,
  createdAt: 0,
  updatedAt: 0,
});

let entrySeq = 0;
function entry(title: string, aliases: string[] = [], fields: Record<string, string> = {}) {
  entrySeq += 1;
  return KnowledgeEntrySchema.parse({
    id: `e-${entrySeq}`,
    novelId: 'n1',
    categoryId: 'c-char',
    title,
    aliases,
    summary: `${title}的一句话摘要。`,
    fields,
    pinned: false,
    createdAt: entrySeq,
    updatedAt: entrySeq,
  });
}

function block(
  entryValue: KnowledgeEntry,
  reason: PlanningEntryBlock['reason'],
): PlanningEntryBlock {
  const text = renderEntry(entryValue, [category]);
  return { entry: entryValue, reason, tokens: estimateTokens(text), text };
}

function node(title: string, synopsis: string): OutlineNode {
  return OutlineNodeSchema.parse({
    id: `o-${title}`,
    novelId: 'n1',
    title,
    synopsis,
    createdAt: 0,
    updatedAt: 0,
  });
}

const target = node('第一卷 渡口', '沈砚在渡口与裴照相遇。');
const ancestors = [node('全书', '')];

function userPrompt(overrides: Partial<Parameters<typeof buildExpandUserPrompt>[0]> = {}) {
  return buildExpandUserPrompt({
    node: target,
    ancestors,
    siblings: [],
    existingChildren: [],
    linkedEntries: [],
    count: 3,
    ...overrides,
  });
}

describe('S3 · system prompt（design §4.1）', () => {
  const coreEntry = entry('灵气', [], { voice: '低沉', weakness: '' });
  const coreBlocks = [block(coreEntry, 'core')];

  it('核心设定只在 system：角色/风格/规范之后、任务说明之前', () => {
    const system = buildExpandSystemPrompt(novel, style, [norm], coreBlocks);
    const related = [block(entry('沈砚'), 'linked')];
    const user = userPrompt({ related });

    expect(system).toContain('【必须遵守的核心设定】');
    expect(system).toContain(coreBlocks[0]!.text);
    // core 不进 user
    expect(user).not.toContain(coreBlocks[0]!.text);

    const styleAt = system.indexOf('【文体取向】');
    const normAt = system.indexOf('【作者的写作规范】');
    const coreAt = system.indexOf('【必须遵守的核心设定】');
    const taskAt = system.indexOf('【任务】');
    expect(styleAt).toBeGreaterThanOrEqual(0);
    expect(normAt).toBeGreaterThan(styleAt);
    expect(coreAt).toBeGreaterThan(normAt);
    expect(taskAt).toBeGreaterThan(coreAt);
  });

  it('core 不传/为空时没有核心块（旧调用路径）', () => {
    // 注意：EXPAND_TASK 里也引用「【必须遵守的核心设定】」这句话，所以只检查任务段之前
    const beforeTask = (prompt: string) => prompt.slice(0, prompt.indexOf('【任务】'));
    expect(beforeTask(buildExpandSystemPrompt(novel, style, [norm]))).not.toContain(
      '【必须遵守的核心设定】',
    );
    expect(beforeTask(buildExpandSystemPrompt(novel, style, [norm], []))).not.toContain(
      '【必须遵守的核心设定】',
    );
  });

  it('同一本书不同节点的 system 逐字节相同（prompt 缓存前缀）', () => {
    const otherTarget = node('第二卷 京城', '裴照在京城查案，提到灵气。');
    // system 只依赖 novel/style/norms/core，与节点无关
    const systemA = buildExpandSystemPrompt(novel, style, [norm], coreBlocks);
    const systemB = buildExpandSystemPrompt(novel, style, [norm], coreBlocks);
    expect(systemB).toBe(systemA);
    // 不同节点的 related 只在 user（缓存前缀不被逐节点内容污染）
    const userA = userPrompt({ node: target, related: [block(entry('沈砚'), 'linked')] });
    const userB = userPrompt({ node: otherTarget, related: [block(entry('裴照'), 'mentioned')] });
    expect(userA).not.toBe(userB);
  });

  it('任务段保留旧约束、增补场景卡/设定落地约束（design §4.1）', () => {
    const system = buildExpandSystemPrompt(novel, style, [norm], coreBlocks);
    // 旧约束不删
    expect(system).toContain('只拆这一个节点');
    expect(system).toContain('同一层的颗粒度要一致');
    expect(system).toContain('子节点之间要有因果推进');
    expect(system).toContain('targetWords 给出该子节点的预估字数');
    // 新约束
    expect(system).toContain('场景卡');
    expect(system).toContain('软肋或世界规则的代价上做出一次选择或拒绝');
    expect(system).toContain('必须改变后文走向');
    expect(system).toContain('把设定复述进梗概不算「应用设定」');
    expect(system).toContain('不要为凑关联硬塞无关人物');
    expect(system).toContain('钩子与信息差');
    expect(system).toContain('targetWords 之和应接近父节点的目标字数');
    expect(system).toContain('不凑数拉长');
  });
});

describe('S3 · user prompt（design §4.2）', () => {
  it('related 传了就用完整字段块，排在【本次要求】之前', () => {
    const shen = entry('沈砚', ['砚哥'], { voice: '短句、爱用反问', weakness: '妹妹' });
    const related = [block(shen, 'mentioned')];
    const user = userPrompt({ related });

    expect(user).toContain('【相关设定】');
    expect(user).toContain(related[0]!.text); // 完整字段（renderEntry 输出）
    expect(user).toContain('说话方式：短句、爱用反问');
    expect(user).toContain('软肋与恐惧：妹妹');
    expect(user.indexOf('【相关设定】')).toBeLessThan(user.indexOf('【本次要求】'));
    // 新的完整字段渲染不出现旧的「标题：摘要」关联块
    expect(user).not.toContain('关联设定：');
  });

  it('related 不传时回退旧「标题：摘要」渲染（既有调用逐字节不变的实现前提）', () => {
    const shen = entry('沈砚', [], { voice: '短句' });
    const user = userPrompt({ linkedEntries: [shen] });
    expect(user).toContain('关联设定：');
    expect(user).toContain('- 沈砚：沈砚的一句话摘要。');
    expect(user).not.toContain('【相关设定】');
  });

  it('related=[] 表示本次没有相关设定：不回退 linkedEntries（权威集合语义）', () => {
    const shen = entry('沈砚', [], { voice: '短句' });
    const user = userPrompt({ related: [], linkedEntries: [shen] });
    expect(user).not.toContain('【相关设定】');
    expect(user).not.toContain('关联设定：');
    expect(user).not.toContain('沈砚的一句话摘要。');
  });

  it('openThreads 块：trim 去空、位于 related 之后、本次要求之前', () => {
    const user = userPrompt({ openThreads: ['林越的身世', '  ', '刀的来历  '] });
    expect(user).toContain('【当前未收束的伏笔】');
    expect(user).toContain('- 林越的身世');
    expect(user).toContain('- 刀的来历');
    expect(user).not.toContain('-   '); // 空项被过滤
    expect(user.indexOf('【当前未收束的伏笔】')).toBeLessThan(user.indexOf('【本次要求】'));

    const noThreads = userPrompt({ openThreads: [] });
    expect(noThreads).not.toContain('【当前未收束的伏笔】');
  });

  it('rollingSummary 只在顶层（depth===0）注入', () => {
    const summary = '林越在渡口醒来，随裴照北上。';
    const top = userPrompt({ rollingSummary: summary, depth: 0 });
    expect(top).toContain('【故事至此】');
    expect(top).toContain(summary);

    const deep = userPrompt({ rollingSummary: summary, depth: 1 });
    expect(deep).not.toContain('【故事至此】');
    expect(deep).not.toContain(summary);

    const noDepth = userPrompt({ rollingSummary: summary });
    expect(noDepth).not.toContain('【故事至此】');

    const empty = userPrompt({ rollingSummary: '   ', depth: 0 });
    expect(empty).not.toContain('【故事至此】');
  });

  it('块顺序符合设计：相关设定 → 伏笔 → 故事至此 → 本次要求 → 用户额外要求', () => {
    const user = userPrompt({
      related: [block(entry('沈砚'), 'linked')],
      openThreads: ['林越的身世'],
      rollingSummary: '故事至此的摘要。',
      depth: 0,
      extra: '每章都要有一次交锋',
      count: 4,
    });
    const order = [
      '【相关设定】',
      '【当前未收束的伏笔】',
      '【故事至此】',
      '【本次要求】',
      '【用户额外要求】',
    ];
    const positions = order.map((marker) => user.indexOf(marker));
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
    expect(user).toContain('拆成 4 个子节点。');
  });
});

describe('S3 · schema 不变（design §4.3，零迁移）', () => {
  it('子节点字段仍是 title/synopsis/targetWords 三个，没有 sceneCount/entryIds', () => {
    const parsed = OutlineExpandSchema.parse({
      children: [
        { title: '第一节', synopsis: '梗概。', targetWords: 1500 },
        { title: '第二节', synopsis: '梗概。', targetWords: null },
      ],
    });
    expect(Object.keys(parsed.children[0]!).sort()).toEqual(['synopsis', 'targetWords', 'title']);
    expect(Object.keys(ExpandedChildSchema.shape).sort()).toEqual([
      'synopsis',
      'targetWords',
      'title',
    ]);
  });
});
