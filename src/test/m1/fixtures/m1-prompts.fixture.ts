/**
 * M1 QA 独立 canary 的固定输入（HEAD `52e124e` 冻结）。
 *
 * 用途：同一份夹具分别跑在「改动前的 HEAD 代码」与「当前工作区代码」上，
 * 输出应逐字节相同（有意变更的族除外，见 m1-canary-intentional）。
 *
 * 约束：
 * - 只 import HEAD 就存在的模块/API；不 import M1 新增的运行时模块（否则没法在 HEAD 上跑）。
 * - 不依赖时间、随机、环境；所有 id 与时间戳写死。
 * - 本文件不匹配 `*.test.ts`，不会被套件执行；由 tools/capture-head-golden.test.ts 与 canary 测试引用。
 */
import {
  CategorySchema,
  ChapterSchema,
  ChapterSummarySchema,
  KnowledgeEntrySchema,
  NovelSchema,
  OutlineNodeSchema,
  SideStorySchema,
  StyleProfileSchema,
  WritingNormSchema,
  type Category,
  type Chapter,
  type ChapterSummary,
  type KnowledgeEntry,
  type Novel,
  type OutlineNode,
  type SideStory,
  type StyleProfile,
  type WritingNorm,
} from '@/domain/schema';
import { CHARACTER_FIELDS, WORLDBUILDING_FIELDS } from '@/domain/defaults';
import { buildChapterSystemPrompt, buildChapterUserPrompt } from '@/features/writing/chapterDraft';
import { buildExpandSystemPrompt, buildExpandUserPrompt } from '@/features/outline/outlineExpand';
import {
  SummaryChainContextBuilder,
  renderEntry as renderEntryFromModule,
  renderSummary as renderSummaryFromModule,
} from '@/context/SummaryChainContextBuilder';
import type { ContextRequest } from '@/context/ContextBuilder';

const novel: Novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  oneLiner: '失忆剑客发现自己是灭门案凶手。',
  genre: '仙侠',
  pov: 'third-limited',
  targetWords: 300000,
  status: 'writing',
  rollingSummary: '林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。',
  createdAt: 0,
  updatedAt: 0,
});

const style: StyleProfile = StyleProfileSchema.parse({
  id: 's1',
  novelId: 'n1',
  tradition: 'web',
  subGenre: '仙侠',
  methodology: 'web-rhythm',
  voiceRefs: [{ refId: 'gulong', name: '古龙', weight: 70 }],
  customRubric: null,
  extraInstruction: '对白少用感叹号，打斗不写招式名。',
  createdAt: 0,
  updatedAt: 0,
});

const worldCategory: Category = CategorySchema.parse({
  id: 'c-world',
  novelId: 'n1',
  name: '世界观设定',
  kind: 'worldbuilding',
  builtin: true,
  fieldTemplate: WORLDBUILDING_FIELDS,
  order: 0,
  createdAt: 0,
  updatedAt: 0,
});

const charCategory: Category = CategorySchema.parse({
  id: 'c-char',
  novelId: 'n1',
  name: '人物',
  kind: 'character',
  builtin: true,
  fieldTemplate: CHARACTER_FIELDS,
  order: 1,
  createdAt: 0,
  updatedAt: 0,
});

const pinnedEntry: KnowledgeEntry = KnowledgeEntrySchema.parse({
  id: 'e-qi',
  novelId: 'n1',
  categoryId: 'c-world',
  title: '灵气',
  aliases: [],
  summary: '天地能量，修士以经脉容纳。',
  fields: {
    definition: '天地间流转的能量。',
    rules: '经脉越宽，吸纳越快；强行吸纳会伤及脏腑。',
    cost: '每次越阶吸纳，折损寿元一年。',
    impact: '',
  },
  pinned: true,
  createdAt: 0,
  updatedAt: 0,
});

const linEntry: KnowledgeEntry = KnowledgeEntrySchema.parse({
  id: 'e-lin',
  novelId: 'n1',
  categoryId: 'c-char',
  title: '林越',
  aliases: ['阿越', '林小舟'],
  summary: '失忆的流亡剑客。',
  fields: {
    identity: '流亡贵族，六扇门通缉。',
    appearance: '左眉一道旧疤。',
    personality: '沉默，习惯先做后想。',
    goal: '查清灭门案真相。',
    'speech-style': '短句，爱用反问。',
    weakness: '妹妹下落不明。',
  },
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
});

/** 无别名、无摘要、无字段内容的条目：renderEntry 必须跳过空行 */
const bareEntry: KnowledgeEntry = KnowledgeEntrySchema.parse({
  id: 'e-bare',
  novelId: 'n1',
  categoryId: 'c-char',
  title: '无名氏',
  aliases: [],
  summary: '',
  fields: {},
  pinned: false,
  createdAt: 2,
  updatedAt: 2,
});

/** 分类已不存在的条目：renderEntry 回退到「设定」 */
const orphanEntry: KnowledgeEntry = KnowledgeEntrySchema.parse({
  id: 'e-orphan',
  novelId: 'n1',
  categoryId: 'c-gone',
  title: '旧设定',
  aliases: ['旧称'],
  summary: '分类被删后留下的条目。',
  fields: { anything: '值' },
  pinned: false,
  createdAt: 3,
  updatedAt: 3,
});

const sideStory: SideStory = SideStorySchema.parse({
  id: 'ss1',
  novelId: 'n1',
  title: '裴照少年行',
  synopsis: '主线二十年前，裴照初入六扇门。',
  rollingSummary: '少年裴照在京城接下第一桩案子。',
  order: 0,
  createdAt: 0,
  updatedAt: 0,
});

const outline: OutlineNode[] = [
  OutlineNodeSchema.parse({
    id: 'o1',
    novelId: 'n1',
    parentId: null,
    order: 0,
    title: '第一卷 渡口',
    synopsis: '林越醒来，卷入灭门案调查。',
    targetWords: 60000,
    createdAt: 0,
    updatedAt: 0,
  }),
  OutlineNodeSchema.parse({
    id: 'o2',
    novelId: 'n1',
    parentId: 'o1',
    order: 0,
    title: '第一章 夜探青冥宗',
    synopsis: '林越与裴照夜入青冥宗旧址，发现血书。',
    targetWords: 3000,
    linkedEntryIds: ['e-lin'],
    createdAt: 1,
    updatedAt: 1,
  }),
  OutlineNodeSchema.parse({
    id: 'o3',
    novelId: 'n1',
    parentId: 'o1',
    order: 1,
    title: '第二章 血书',
    synopsis: '血书指向林越本人。',
    targetWords: null,
    createdAt: 2,
    updatedAt: 2,
  }),
];

const mainChapters: Chapter[] = [
  ChapterSchema.parse({
    id: 'ch1',
    novelId: 'n1',
    index: 1,
    title: '渡口',
    content: '林越在渡口醒来，记忆全失。\n\n裴照找上他，出示一把刀。',
    wordCount: 30,
    createdAt: 0,
    updatedAt: 0,
  }),
  ChapterSchema.parse({
    id: 'ch2',
    novelId: 'n1',
    index: 2,
    title: '裴照',
    content: '裴照把刀横在桌上。\n\n“你认得这把刀吗？”裴捕头问。',
    wordCount: 30,
    createdAt: 1,
    updatedAt: 1,
  }),
  ChapterSchema.parse({
    id: 'ch3',
    novelId: 'n1',
    index: 3,
    title: '北上',
    content: '两人连夜北上。\n\n林越夜里总梦见火光。',
    wordCount: 20,
    createdAt: 2,
    updatedAt: 2,
  }),
];

const sideChapter: Chapter = ChapterSchema.parse({
  id: 'ch-side-1',
  novelId: 'n1',
  index: 1,
  title: '初入京城',
  content: '十六岁的裴照第一次走进六扇门。',
  wordCount: 18,
  sideStoryId: 'ss1',
  createdAt: 3,
  updatedAt: 3,
});

const summaries: ChapterSummary[] = [
  ChapterSummarySchema.parse({
    id: 'sum1',
    novelId: 'n1',
    chapterId: 'ch1',
    summary: '林越在渡口醒来，失去记忆。',
    keyEvents: ['林越醒来'],
    appearingEntryIds: ['e-lin'],
    openThreads: ['林越的身世'],
    createdAt: 0,
    updatedAt: 0,
  }),
  ChapterSummarySchema.parse({
    id: 'sum2',
    novelId: 'n1',
    chapterId: 'ch2',
    summary: '裴照找上林越，出示一把刀。',
    keyEvents: ['裴照出示刀'],
    appearingEntryIds: ['e-lin'],
    openThreads: ['林越的身世', '刀的来历'],
    createdAt: 1,
    updatedAt: 1,
  }),
  ChapterSummarySchema.parse({
    id: 'sum-side-1',
    novelId: 'n1',
    chapterId: 'ch-side-1',
    summary: '裴照进入六扇门。',
    keyEvents: ['裴照入职'],
    appearingEntryIds: [],
    openThreads: ['师父的旧案'],
    createdAt: 2,
    updatedAt: 2,
  }),
];

const norms: WritingNorm[] = [
  WritingNormSchema.parse({
    id: 'norm-1',
    novelId: 'n1',
    title: '原作基线',
    content: '- 以已导入资料为原作基线。【标记 QA-ALL】',
    enabled: true,
    scopes: ['writing', 'planning', 'summary', 'extract', 'check'],
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  }),
  WritingNormSchema.parse({
    id: 'norm-2',
    novelId: 'n1',
    title: '只作用于规划',
    content: '- 细化时每章至少一次交锋。【标记 QA-PLANNING】',
    enabled: true,
    scopes: ['planning'],
    order: 1,
    createdAt: 1,
    updatedAt: 1,
  }),
];

const entries = [pinnedEntry, linEntry, bareEntry, orphanEntry];
export const m1Categories: Category[] = [worldCategory, charCategory];

function mainRequest(): ContextRequest {
  return {
    novel,
    style,
    categories: m1Categories,
    entries,
    outline,
    chapters: mainChapters,
    summaries,
    targetNodeId: 'o2',
    targetChapterId: null,
    recentSummaryCount: 3,
    writingNorms: norms,
  };
}

function sideRequest(): ContextRequest {
  return {
    novel,
    style,
    categories: m1Categories,
    entries,
    outline,
    chapters: [...mainChapters, sideChapter],
    summaries,
    targetNodeId: null,
    targetChapterId: 'ch-side-1',
    recentSummaryCount: 3,
    sideStories: [sideStory],
    writingNorms: norms,
  };
}

const builder = new SummaryChainContextBuilder();

function contextOf(request: ContextRequest) {
  const built = builder.build(request);
  return {
    stablePrefix: built.stablePrefix,
    volatileSuffix: built.volatileSuffix,
    estimatedTokens: built.estimatedTokens,
    defaultEntryIds: built.defaultEntryIds,
    items: built.items,
  };
}

/** renderEntry 的边界夹具：别名/全字段/空字段/未知分类 */
export const m1RenderEntryCases: Record<string, KnowledgeEntry> = {
  pinned: pinnedEntry,
  aliased: linEntry,
  bare: bareEntry,
  orphan: orphanEntry,
};

export const m1RenderSummaryCases: Record<string, { chapter: Chapter; summary: ChapterSummary }> = {
  full: { chapter: mainChapters[1]!, summary: summaries[1]! },
  minimal: {
    chapter: ChapterSchema.parse({
      id: 'ch-min',
      novelId: 'n1',
      index: 9,
      content: '',
      createdAt: 9,
      updatedAt: 9,
    }),
    summary: ChapterSummarySchema.parse({
      id: 'sum-min',
      novelId: 'n1',
      chapterId: 'ch-min',
      summary: '',
      keyEvents: [],
      appearingEntryIds: [],
      openThreads: [],
      createdAt: 9,
      updatedAt: 9,
    }),
  },
};

export interface M1PromptSnapshot {
  builderMain: ReturnType<typeof contextOf>;
  builderSide: ReturnType<typeof contextOf>;
  chapterSystem: string;
  chapterUser: string;
  chapterUserDefault: string;
  expandSystem: string;
  expandUser: string;
  renderEntry: Record<string, string>;
  renderSummary: Record<string, string>;
}

/**
 * 计算快照。注意：`renderEntry` / `renderSummary` 从 SummaryChainContextBuilder 导入
 * —— 在 HEAD 上它们定义在该文件里，在 S2 之后是同名 re-export，两处都能跑。
 */
export function buildM1Snapshot(): M1PromptSnapshot {
  const main = builder.build(mainRequest());
  const side = builder.build(sideRequest());

  const expandNode = outline[1]!;
  const expandUser = buildExpandUserPrompt({
    node: expandNode,
    ancestors: [outline[0]!],
    siblings: [expandNode],
    existingChildren: [],
    linkedEntries: [linEntry],
    count: 4,
    extra: '每章都要有一次交锋',
  });

  return {
    builderMain: contextOf(mainRequest()),
    builderSide: contextOf(sideRequest()),
    chapterSystem: buildChapterSystemPrompt(main.stablePrefix),
    chapterUser: buildChapterUserPrompt({
      volatileSuffix: main.volatileSuffix,
      targetWords: 3000,
      instruction: '结尾留一个钩子',
    }),
    chapterUserDefault: buildChapterUserPrompt({
      volatileSuffix: side.volatileSuffix,
      targetWords: null,
    }),
    expandSystem: buildExpandSystemPrompt(novel, style, norms),
    expandUser,
    renderEntry: Object.fromEntries(
      Object.entries(m1RenderEntryCases).map(([name, entry]) => [
        name,
        renderEntryFromModule(entry, m1Categories),
      ]),
    ),
    renderSummary: Object.fromEntries(
      Object.entries(m1RenderSummaryCases).map(([name, { chapter, summary }]) => [
        name,
        renderSummaryFromModule(chapter, summary),
      ]),
    ),
  };
}
