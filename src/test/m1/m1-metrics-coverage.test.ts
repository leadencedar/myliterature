/**
 * 指标 1 独立验收（细化设定覆盖率 ≥18/20）：
 * 对 20 个确定性夹具，逐条断言「梗概/标题/额外要求/祖先梗概里提到的条目，
 * 完整字段进入了发给模型的 user prompt」。
 *
 * 判据按指标原文是「prompt 中包含完整字段」，因此可自动化；真实模型是否用上设定
 * 归指标 3 的人工判断，不在本文件硬判。
 */
import { describe, expect, it } from 'vitest';
import {
  CategorySchema,
  KnowledgeEntrySchema,
  NovelSchema,
  OutlineNodeSchema,
  StyleProfileSchema,
  type Category,
  type KnowledgeEntry,
  type OutlineNode,
} from '@/domain/schema';
import { PLANNING_CONTEXT_BUDGET, selectPlanningEntries } from '@/context/planningContext';
import { renderEntry } from '@/context/renderEntry';
import { buildExpandSystemPrompt, buildExpandUserPrompt } from '@/features/outline/outlineExpand';

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
  methodology: 'web-rhythm',
  createdAt: 0,
  updatedAt: 0,
});
const categories: Category[] = [
  CategorySchema.parse({
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
  }),
];

let seq = 0;
function entry(
  title: string,
  options: { aliases?: string[]; pinned?: boolean; voice?: string; weakness?: string } = {},
): KnowledgeEntry {
  seq += 1;
  return KnowledgeEntrySchema.parse({
    id: `e-${String(seq).padStart(3, '0')}`,
    novelId: 'n1',
    categoryId: 'c-char',
    title,
    aliases: options.aliases ?? [],
    summary: `${title}的摘要。`,
    fields: {
      ...(options.voice ? { voice: options.voice } : {}),
      ...(options.weakness ? { weakness: options.weakness } : {}),
    },
    pinned: options.pinned ?? false,
    createdAt: seq,
    updatedAt: seq,
  });
}

function outlineNode(title: string, synopsis = ''): OutlineNode {
  return OutlineNodeSchema.parse({
    id: `o-${title}`,
    novelId: 'n1',
    title,
    synopsis,
    createdAt: 0,
    updatedAt: 0,
  });
}

interface CoverageCase {
  name: string;
  title: string;
  synopsis: string;
  extra?: string;
  ancestorSummaries?: string[];
  entries: { title: string; aliases?: string[]; pinned?: boolean }[];
  linkedEntryIds?: string[];
  /** 期望出现在 user prompt 里的条目 title（按名称被提到，且未超上限/预算） */
  expectedCovered: string[];
  /** 期望不出现完整字段的条目（pinned 走 system；未提到的/超上限的） */
  expectedNotInUser: string[];
}

function buildCaseCaseEntries(caseDef: CoverageCase): KnowledgeEntry[] {
  return caseDef.entries.map((spec) =>
    entry(spec.title, {
      ...(spec.aliases ? { aliases: spec.aliases } : {}),
      ...(spec.pinned === undefined ? {} : { pinned: spec.pinned }),
      voice: `${spec.title}的说话方式`,
      weakness: `${spec.title}的软肋`,
    }),
  );
}

function runCase(caseDef: CoverageCase) {
  const entries = buildCaseCaseEntries(caseDef);
  const node = outlineNode(caseDef.title, caseDef.synopsis);
  const ancestors = (caseDef.ancestorSummaries ?? []).map((summary, index) =>
    outlineNode(`祖先${index}`, summary),
  );
  const texts = [
    node.title,
    node.synopsis,
    caseDef.extra ?? '',
    ...ancestors.slice(-2).map((item) => item.synopsis),
  ];
  const byTitle = new Map(entries.map((item) => [item.title, item]));
  const linkedEntryIds = (caseDef.linkedEntryIds ?? []).map((title) => byTitle.get(title)!.id);
  const selection = selectPlanningEntries({
    texts,
    entries,
    categories,
    linkedEntryIds,
  });
  const system = buildExpandSystemPrompt(novel, style, [], selection.core);
  const user = buildExpandUserPrompt({
    node,
    ancestors,
    siblings: [],
    existingChildren: [],
    linkedEntries: [],
    count: 3,
    ...(caseDef.extra ? { extra: caseDef.extra } : {}),
    related: selection.related,
  });
  return { selection, system, user, entries, byTitle };
}

const CASES: CoverageCase[] = [
  {
    name: '标题里提到人物',
    title: '沈砚的渡口',
    synopsis: '两人相遇。',
    entries: [{ title: '沈砚' }],
    expectedCovered: ['沈砚'],
    expectedNotInUser: [],
  },
  {
    name: '梗概里提到人物',
    title: '第一卷',
    synopsis: '沈砚在渡口与裴照相遇。',
    entries: [{ title: '沈砚' }, { title: '裴照' }],
    expectedCovered: ['沈砚', '裴照'],
    expectedNotInUser: [],
  },
  {
    name: '额外要求里提到人物',
    title: '第一卷',
    synopsis: '渡口相遇。',
    extra: '这一章要写裴照的旧怨。',
    entries: [{ title: '裴照' }],
    expectedCovered: ['裴照'],
    expectedNotInUser: [],
  },
  {
    name: '最近祖先梗概里提到人物',
    title: '第一章',
    synopsis: '本章梗概。',
    ancestorSummaries: ['卷梗概：沈砚北上。'],
    entries: [{ title: '沈砚' }],
    expectedCovered: ['沈砚'],
    expectedNotInUser: [],
  },
  {
    name: '别名命中',
    title: '第一卷',
    synopsis: '阿越在渡口醒来。',
    entries: [{ title: '林越', aliases: ['阿越'] }],
    expectedCovered: ['林越'],
    expectedNotInUser: [],
  },
  {
    name: '全角名字命中',
    title: '第一卷',
    synopsis: 'ＡＳＨ走进酒馆。',
    entries: [{ title: 'Ash' }],
    expectedCovered: ['Ash'],
    expectedNotInUser: [],
  },
  {
    name: '零宽字符不破坏命中',
    title: '第一卷',
    synopsis: '沈\u200b砚拔刀。',
    entries: [{ title: '沈砚' }],
    expectedCovered: ['沈砚'],
    expectedNotInUser: [],
  },
  {
    name: '2 字短名仍覆盖（降权只影响排序）',
    title: '第一卷',
    synopsis: '裴照拔刀。',
    entries: [{ title: '裴照' }],
    expectedCovered: ['裴照'],
    expectedNotInUser: [],
  },
  {
    name: '长名与短名同时命中',
    title: '第一卷',
    synopsis: '裴照之与裴照。',
    entries: [{ title: '裴照' }, { title: '裴照之' }],
    expectedCovered: ['裴照', '裴照之'],
    expectedNotInUser: [],
  },
  {
    name: '显式关联 + 名称命中并存',
    title: '第一卷',
    synopsis: '沈砚在渡口。',
    entries: [{ title: '沈砚' }, { title: '裴照' }],
    linkedEntryIds: ['裴照'],
    expectedCovered: ['沈砚', '裴照'],
    expectedNotInUser: [],
  },
  {
    name: '核心设定只进 system，不进 user 相关块',
    title: '第一卷',
    synopsis: '灵气在经脉里乱窜，沈砚皱眉。',
    entries: [{ title: '灵气', pinned: true }, { title: '沈砚' }],
    expectedCovered: ['沈砚'],
    expectedNotInUser: ['灵气'],
  },
  {
    name: '同段文字命中多人',
    title: '第一卷',
    synopsis: '沈砚、裴照与林越在渡口对峙。',
    entries: [{ title: '沈砚' }, { title: '裴照' }, { title: '林越' }],
    expectedCovered: ['沈砚', '裴照', '林越'],
    expectedNotInUser: [],
  },
  {
    name: '同一人物在标题与梗概各出现一次',
    title: '沈砚北上',
    synopsis: '沈砚离开渡口。',
    entries: [{ title: '沈砚' }],
    expectedCovered: ['沈砚'],
    expectedNotInUser: [],
  },
  {
    name: '没有命中时不渲染相关块（向后兼容）',
    title: '风雪',
    synopsis: '风很大。',
    entries: [{ title: '沈砚' }],
    expectedCovered: [],
    expectedNotInUser: ['沈砚'],
  },
  {
    name: '多条目按分数排序进入（无截断）',
    title: '第一卷',
    synopsis: '沈砚与裴照之同行，林越在远处。',
    entries: [{ title: '沈砚' }, { title: '裴照之' }, { title: '林越' }],
    expectedCovered: ['沈砚', '裴照之', '林越'],
    expectedNotInUser: [],
  },
  {
    name: '提到 8 条：默认上限内全部覆盖',
    title: '第一卷',
    synopsis: '甲一、甲二、甲三、甲四、甲五、甲六、甲七、甲八都到了。',
    entries: Array.from({ length: 8 }, (_, index) => ({
      title: `甲${'一二三四五六七八'[index]}`,
    })),
    expectedCovered: Array.from({ length: 8 }, (_, index) => `甲${'一二三四五六七八'[index]}`),
    expectedNotInUser: [],
  },
  {
    name: '提到超过 8 条：只覆盖上限内条目（宁少勿杂）',
    title: '第一卷',
    synopsis: '乙一、乙二、乙三、乙四、乙五、乙六、乙七、乙八、乙九都到了。',
    entries: Array.from({ length: 9 }, (_, index) => ({
      title: `乙${'一二三四五六七八九'[index]}`,
    })),
    expectedCovered: Array.from({ length: 8 }, (_, index) => `乙${'一二三四五六七八'[index]}`),
    expectedNotInUser: ['乙九'],
  },
  {
    name: '条目字段为空：仍覆盖条目块（跳过空字段）',
    title: '第一卷',
    synopsis: '沈砚来了。',
    entries: [{ title: '沈砚' }],
    expectedCovered: ['沈砚'],
    expectedNotInUser: [],
  },
  {
    name: '别名与标题同时渲染',
    title: '第一卷',
    synopsis: '林越（阿越）来了。',
    entries: [{ title: '林越', aliases: ['阿越'] }],
    expectedCovered: ['林越'],
    expectedNotInUser: [],
  },
  {
    name: '标题 + 梗概组合覆盖（多个文本源）',
    title: '裴照北上',
    synopsis: '沈砚随行。',
    entries: [{ title: '裴照' }, { title: '沈砚' }],
    expectedCovered: ['裴照', '沈砚'],
    expectedNotInUser: [],
  },
];

describe('指标 1 · 20 个夹具的设定完整字段覆盖率', () => {
  it.each(CASES.map((caseDef, index) => [index + 1, caseDef.name, caseDef] as const))(
    '用例 %i：%s',
    (_index, _name, caseDef) => {
      const { user, byTitle } = runCase(caseDef);
      // 被提到的条目：完整字段（renderEntry 输出，含别名与全部有值字段）出现在 user prompt
      for (const title of caseDef.expectedCovered) {
        const target = byTitle.get(title)!;
        expect(user).toContain(renderEntry(target, categories));
        expect(user).toContain(title);
      }
      // 未提到的/核心设定：不把完整字段塞进 user 相关块
      for (const title of caseDef.expectedNotInUser) {
        expect(user).not.toContain(renderEntry(byTitle.get(title)!, categories));
      }
    },
  );

  it('20/20 用例达到「完整字段进入 user prompt」的判据（阈值 ≥18/20）', () => {
    const covered = CASES.filter((caseDef) => {
      const { user, byTitle } = runCase(caseDef);
      return caseDef.expectedCovered.every((title) =>
        user.includes(renderEntry(byTitle.get(title)!, categories)),
      );
    }).length;
    expect(covered).toBeGreaterThanOrEqual(18);
    expect(covered).toBe(CASES.length);
  });

  it('核心设定进 system；同一核心集合下不同节点的 system 相同（同书缓存前缀）', () => {
    // 除「有核心设定」的用例 11 外，其它用例的 pinned 集合都为空 → system 必须逐字节相同
    const noCoreCases = CASES.filter((_, index) => index !== 10);
    const systems = noCoreCases.map((caseDef) => runCase(caseDef).system);
    for (const system of systems) expect(system).toBe(systems[0]);
    // 有核心设定的用例：核心进 system、不进 user 的【相关设定】块
    const pinnedCase = runCase(CASES[10]!);
    expect(pinnedCase.system).toContain('【必须遵守的核心设定】');
    expect(pinnedCase.system).toContain('## 灵气（人物）');
    expect(pinnedCase.user).not.toContain('## 灵气（人物）');
  });

  it('预算参数用默认 8k，且默认预算下这些夹具没有条目因超预算被丢', () => {
    expect(PLANNING_CONTEXT_BUDGET).toBe(8000);
    for (const caseDef of CASES) {
      const { selection } = runCase(caseDef);
      expect(selection.dropped).toEqual([]);
    }
  });
});
