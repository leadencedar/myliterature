/**
 * 零变化护栏（互动推演）：没有推演时，十类现有任务的提示词与注入清单必须与加入推演之前逐字节一致。
 *
 * 逐字节一致不是洁癖：DeepSeek 的输入缓存要求前缀完全相同，多一个空行就全部失效；
 * 而且作者没用互动推演时，模型看到的内容理应与以前完全一样。
 *
 * 写法约束（交叉核对的前提）：
 * - 夹具全部是对象字面量、类型只用 `import type`，不 import 任何新增的运行时模块，也不经 Schema.parse
 *   —— parse 会随新 schema 补出新字段，夹具就不再是「改动前的形状」。类型擦除后同一份文件在
 *   改动前的代码上也能跑，用来核对 BASELINE 确实来自改动前（设计 §12.2 第 5 点）。
 * - 只用常量 + toBe / toEqual，禁止快照：快照在非 CI 环境下会被自动写入，护栏会悄悄失效。
 */
import { describe, expect, it } from 'vitest';
import type {
  Category,
  Chapter,
  ChapterSummary,
  KnowledgeEntry,
  Novel,
  OutlineNode,
  SideStory,
  StyleProfile,
  WritingNorm,
} from '@/domain/schema';
import { detectLanguage } from '@/domain/language';
import { mergeGlossary, relevantGlossary, type GlossaryEntry } from '@/domain/glossary';
import { mentionedEntries } from '@/domain/entrySearch';
import { chapterLabel } from '@/domain/sideStory';
import { buildChapterSystemPrompt, buildChapterUserPrompt } from '@/features/writing/chapterDraft';
import {
  buildReviseSystemPrompt,
  buildReviseUserPrompt,
  normalizeSelection,
  selectionAtEnd,
  surroundingContext,
  type ReviseAction,
} from '@/features/writing/revise';
import {
  buildSummarySystemPrompt,
  buildSummaryUserPrompt,
} from '@/features/writing/chapterSummary';
import {
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
} from '@/features/import/extractSettings';
import { buildExpandSystemPrompt, buildExpandUserPrompt } from '@/features/outline/outlineExpand';
import {
  buildSetupSystemPrompt,
  buildSetupUserPrompt,
  findScale,
} from '@/features/setup/projectSetup';
import {
  buildNormCheckSystemPrompt,
  buildNormCheckUserPrompt,
  previousForCheck,
} from '@/features/writing/normCheck';
import { NORM_CONDENSE_SYSTEM, buildCondenseUserPrompt } from '@/features/knowledge/normCondense';
import { buildTranslateSystemPrompt, buildTranslateUserPrompt } from '@/features/writing/translate';
import { STYLE_SAMPLE_SYSTEM, buildStyleSampleUserPrompt } from '@/features/style/styleSample';
import {
  MANUSCRIPT_STYLE_SYSTEM,
  buildManuscriptStyleUserPrompt,
} from '@/features/import/extractStyle';
import { MAX_INFERRED_ENTRIES, type BuiltContext, type ContextRequest } from './ContextBuilder';
import { SummaryChainContextBuilder } from './SummaryChainContextBuilder';

// ---------------------------------------------------------------- 夹具

/**
 * 改动前的形状。加入推演后条目多了 scope / fieldLocks、大纲 / 章节 / 外传多了 scenarioSource，
 * 夹具类型去掉这几个键（在旧代码上 Omit 一个不存在的键是空操作），传参时再断言回完整类型。
 */
type Before<T> = Omit<T, 'scope' | 'fieldLocks' | 'scenarioSource'>;

interface Fixtures {
  novel: Novel;
  style: StyleProfile;
  worldCategory: Category;
  charCategory: Category;
  pinnedEntry: Before<KnowledgeEntry>;
  normalEntry: Before<KnowledgeEntry>;
  outline: Before<OutlineNode>[];
  chapters: Before<Chapter>[];
  sideStory: Before<SideStory>;
  summaries: ChapterSummary[];
  norms: WritingNorm[];
}

function fixtures(): Fixtures {
  const novel: Novel = {
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
    deletedAt: null,
  };
  const style: StyleProfile = {
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
  };
  const worldCategory: Category = {
    id: 'c-world',
    novelId: 'n1',
    name: '世界观设定',
    kind: 'worldbuilding',
    builtin: true,
    fieldTemplate: [
      {
        key: 'definition',
        label: '定义',
        type: 'longtext',
        placeholder: '这条设定是什么',
        hint: '用两三句话说清这条设定是什么，避免空泛的形容词。',
      },
      {
        key: 'rules',
        label: '运作规则',
        type: 'longtext',
        placeholder: '它如何运作，有哪些明确规则',
        hint: '给出可验证的具体规则，让后续情节有依据、不自相矛盾。',
      },
      {
        key: 'cost',
        label: '限制与代价',
        type: 'longtext',
        placeholder: '使用它要付出什么',
        hint: '限制比能力更重要：没有代价的设定会让冲突失重。',
      },
    ],
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const charCategory: Category = {
    id: 'c-char',
    novelId: 'n1',
    name: '人物',
    kind: 'character',
    builtin: true,
    fieldTemplate: [
      {
        key: 'identity',
        label: '身份',
        type: 'text',
        placeholder: '年龄、出身、社会位置',
        hint: '一行写清年龄、出身与当前处境。',
      },
      {
        key: 'voice',
        label: '说话方式',
        type: 'longtext',
        placeholder: '口头习惯、语气、用词偏好',
        hint: '写清口吻特征，让对话可辨认出是谁在说话。',
      },
    ],
    order: 1,
    createdAt: 0,
    updatedAt: 0,
  };
  const pinnedEntry: Before<KnowledgeEntry> = {
    id: 'e-lingqi',
    novelId: 'n1',
    categoryId: 'c-world',
    title: '灵气',
    aliases: [],
    summary: '天地间流转的能量，修行之本。',
    fields: { rules: '吐纳入体，经脉为渠。', cost: '强行催动会损寿元。' },
    pinned: true,
    sourceChapterIds: [],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  const normalEntry: Before<KnowledgeEntry> = {
    id: 'e-peizhao',
    novelId: 'n1',
    categoryId: 'c-char',
    title: '裴照',
    aliases: ['裴捕头', 'Pei Zhao'],
    summary: '六扇门捕头，追查灭门案。',
    fields: { identity: '六扇门捕头', voice: '话少，句句带刺。' },
    pinned: false,
    sourceChapterIds: [],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  const outline: Before<OutlineNode>[] = [
    {
      id: 'o-vol1',
      novelId: 'n1',
      parentId: null,
      order: 0,
      title: '第一卷 渡口',
      synopsis: '林越醒来，卷入灭门案调查。',
      targetWords: null,
      status: 'drafting',
      linkedEntryIds: [],
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'o-ch4',
      novelId: 'n1',
      parentId: 'o-vol1',
      order: 3,
      title: '夜探青冥宗',
      synopsis: '林越与裴照夜入青冥宗旧址，发现血书。',
      targetWords: 3000,
      status: 'planned',
      linkedEntryIds: ['e-peizhao'],
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'o-ch5',
      novelId: 'n1',
      parentId: 'o-vol1',
      order: 4,
      title: '血书',
      synopsis: '血书指向林越本人。',
      targetWords: null,
      status: 'planned',
      linkedEntryIds: [],
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  const sideStory: Before<SideStory> = {
    id: 'side-1',
    novelId: 'n1',
    title: '裴照少年行',
    synopsis: '主线二十年前，裴照初入六扇门。',
    rollingSummary: '少年裴照在京城接下第一桩案子。',
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const chapter = (
    id: string,
    index: number,
    title: string,
    content: string,
    extra: { outlineNodeId?: string; sideStoryId?: string } = {},
  ): Before<Chapter> => ({
    id,
    novelId: 'n1',
    outlineNodeId: extra.outlineNodeId ?? null,
    index,
    title,
    content,
    sourceContent: '',
    sourceLanguage: '',
    wordCount: content.length,
    status: content ? 'done' : 'draft',
    source: 'manual',
    sideStoryId: extra.sideStoryId ?? null,
    createdAt: 0,
    updatedAt: 0,
  });
  const chapters: Before<Chapter>[] = [
    chapter('ch1', 1, '渡口', '江雾未散，林越在渡口醒来。\n\n他不记得自己是谁。'),
    chapter('ch2', 2, '裴照', '裴照把刀横在桌上。\n\n“你认得这把刀吗？”裴捕头问。'),
    chapter('ch3', 3, '北上', '两人连夜北上。\n\n林越夜里总梦见火光，灵气在经脉里乱窜。'),
    chapter('ch4', 4, '夜探青冥宗', '', { outlineNodeId: 'o-ch4' }),
    chapter('sc1', 1, '初入京城', '十六岁的裴照第一次走进六扇门。', { sideStoryId: 'side-1' }),
    chapter('sc2', 2, '第一桩案子', '', { sideStoryId: 'side-1' }),
  ];
  const summary = (
    chapterId: string,
    text: string,
    keyEvents: string[],
    openThreads: string[],
  ): ChapterSummary => ({
    id: `sum-${chapterId}`,
    novelId: 'n1',
    chapterId,
    summary: text,
    keyEvents,
    appearingEntryIds: chapterId === 'ch1' ? [] : ['e-peizhao'],
    openThreads,
    createdAt: 0,
    updatedAt: 0,
  });
  const summaries: ChapterSummary[] = [
    summary('ch1', '林越在渡口醒来，失去记忆。', ['林越醒来'], ['林越的身世']),
    summary('ch2', '裴照找上林越，出示一把刀。', ['裴照出示刀'], ['林越的身世', '刀的来历']),
    summary(
      'ch3',
      '两人北上，林越梦见火光。',
      ['两人北上', '林越梦见火光'],
      ['林越的身世', '刀的来历'],
    ),
    summary('sc1', '裴照进入六扇门。', ['裴照入职'], ['师父的旧案']),
  ];
  const norms: WritingNorm[] = [
    {
      id: 'norm-all',
      novelId: 'n1',
      title: '原作基线',
      content: '- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】\n',
      enabled: true,
      scopes: ['writing', 'planning', 'summary', 'extract', 'check'],
      order: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'norm-writing',
      novelId: 'n1',
      title: '对白约束',
      content: '- 裴照的对白不超过十五个字。【标记 WRITING】',
      enabled: true,
      scopes: ['writing'],
      order: 1,
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  return {
    novel,
    style,
    worldCategory,
    charCategory,
    pinnedEntry,
    normalEntry,
    outline,
    chapters,
    sideStory,
    summaries,
    norms,
  };
}

// ---------------------------------------------------------------- 各任务的输入（照抄调用点的拼法）

/** 夹具 → 现有 API 要的完整类型。断言只为跨版本编译，不改变运行时对象 */
function views(fx: Fixtures) {
  const categories = [fx.worldCategory, fx.charCategory];
  const entries = [fx.pinnedEntry, fx.normalEntry] as KnowledgeEntry[];
  const outline = fx.outline as OutlineNode[];
  const chapters = fx.chapters as Chapter[];
  const sideStories = [fx.sideStory] as SideStory[];
  return { categories, entries, outline, chapters, sideStories };
}

function mainRequest(fx: Fixtures): ContextRequest {
  const v = views(fx);
  return {
    novel: fx.novel,
    style: fx.style,
    categories: v.categories,
    entries: v.entries,
    outline: v.outline,
    chapters: v.chapters,
    summaries: fx.summaries,
    targetNodeId: 'o-ch4',
    targetChapterId: 'ch4',
    sideStories: v.sideStories,
    writingNorms: fx.norms,
  };
}

function sideRequest(fx: Fixtures): ContextRequest {
  const v = views(fx);
  return {
    novel: fx.novel,
    style: fx.style,
    categories: v.categories,
    entries: v.entries,
    outline: v.outline,
    chapters: v.chapters,
    summaries: fx.summaries,
    targetNodeId: null,
    targetChapterId: 'sc2',
    sideStories: v.sideStories,
    includeMainProgress: true,
    writingNorms: fx.norms,
  };
}

const builder = new SummaryChainContextBuilder();

/** 只取会进 prompt 或展示给作者的部分 */
function pickBuilt(built: BuiltContext) {
  return {
    stablePrefix: built.stablePrefix,
    volatileSuffix: built.volatileSuffix,
    items: built.items,
    estimatedTokens: built.estimatedTokens,
  };
}

function reviseUser(action: ReviseAction, built: BuiltContext, content: string): string {
  const selection =
    action === 'continue'
      ? selectionAtEnd(content)
      : normalizeSelection(content, 0, content.indexOf('\n'));
  const { before, after } = surroundingContext(content, selection);
  return buildReviseUserPrompt({
    volatileSuffix: built.volatileSuffix,
    selection,
    before,
    after,
    temporaryVoiceId: action === 'expand' ? 'luxun' : null,
    instruction: action === 'rewrite' ? '节奏再快一点' : undefined,
  });
}

const TRANSLATE_SOURCE =
  'The fog had not lifted when Pei Zhao laid his blade on the table.\n\n"Do you know this blade?" he asked.';

const SAMPLE_TEXT =
  '江雾未散，林越在渡口醒来。他不记得自己是谁，只记得火光。裴照把刀横在桌上，一句话也不说。';

/**
 * 十类任务的全部输出。构建器（主线 / 外传）在 main / side 两次 build 里各取一次，
 * 其余任务照各自调用点的拼法给输入。
 */
function actual(fx: Fixtures, request: (base: ContextRequest) => ContextRequest = (r) => r) {
  const v = views(fx);
  const main = builder.build(request(mainRequest(fx)));
  const side = builder.build(request(sideRequest(fx)));
  const reviseContent = v.chapters[2]!.content;

  // 规范检查：与 NormCheckSheet 同一拼法
  const checkChapter = v.chapters[2]!;
  const pinned = v.entries.filter((entry) => entry.pinned);
  const related = mentionedEntries(
    checkChapter.content,
    v.entries.filter((entry) => !entry.pinned),
  ).slice(0, MAX_INFERRED_ENTRIES);
  const previous = previousForCheck(v.chapters, fx.summaries, checkChapter.id);

  // 翻译：与 TranslateSheet 同一拼法，译名表由条目的拉丁别名拼出
  const fromEntries: GlossaryEntry[] = v.entries.flatMap((entry) =>
    entry.aliases
      .filter((alias) => detectLanguage(alias) !== 'zh' && /[A-Za-z]/u.test(alias))
      .map((alias) => ({ source: alias, target: entry.title })),
  );
  const glossary = mergeGlossary([], fromEntries);

  return {
    builderMain: pickBuilt(main),
    builderSide: pickBuilt(side),
    chapterSystem: buildChapterSystemPrompt(main.stablePrefix),
    chapterUser: buildChapterUserPrompt({
      volatileSuffix: main.volatileSuffix,
      targetWords: 3000,
      instruction: '结尾留一个钩子',
    }),
    sideChapterSystem: buildChapterSystemPrompt(side.stablePrefix),
    sideChapterUser: buildChapterUserPrompt({
      volatileSuffix: side.volatileSuffix,
      targetWords: null,
      instruction: undefined,
    }),
    reviseSystem_continue: buildReviseSystemPrompt(main.stablePrefix, 'continue'),
    reviseSystem_rewrite: buildReviseSystemPrompt(main.stablePrefix, 'rewrite'),
    reviseSystem_expand: buildReviseSystemPrompt(main.stablePrefix, 'expand'),
    reviseUser_continue: reviseUser('continue', main, reviseContent),
    reviseUser_rewrite: reviseUser('rewrite', main, reviseContent),
    reviseUser_expand: reviseUser('expand', main, reviseContent),
    summarySystem: buildSummarySystemPrompt(fx.novel, fx.norms),
    summaryUser: buildSummaryUserPrompt({
      chapter: v.chapters[2]!,
      entryNames: v.entries.map((entry) => entry.title),
      previousOpenThreads: ['林越的身世', '刀的来历'],
      previousRollingSummary: fx.novel.rollingSummary,
    }),
    extractSystem: buildExtractSystemPrompt(fx.novel, v.categories, fx.norms),
    extractUser: buildExtractUserPrompt({
      chapter: v.chapters[1]!,
      mentionedEntries: mentionedEntries(v.chapters[1]!.content, v.entries),
      categories: v.categories,
      otherEntryNames: ['灵气'],
      openThreads: ['林越的身世'],
      rollingSummary: fx.novel.rollingSummary,
    }),
    expandSystem: buildExpandSystemPrompt(fx.novel, fx.style, fx.norms),
    expandUser: buildExpandUserPrompt({
      node: v.outline[0]!,
      ancestors: [],
      siblings: [v.outline[0]!],
      existingChildren: [v.outline[1]!, v.outline[2]!],
      linkedEntries: [v.entries[1]!],
      count: 4,
      extra: '每章都要有一次交锋',
    }),
    setupSystem: buildSetupSystemPrompt(
      fx.novel,
      fx.style,
      fx.worldCategory,
      fx.charCategory,
      fx.norms,
    ),
    setupUser: buildSetupUserPrompt({
      oneLiner: fx.novel.oneLiner,
      scale: findScale('long'),
      extra: '主角不能开金手指',
    }),
    normCheckSystem: buildNormCheckSystemPrompt(fx.novel, fx.norms, pinned, v.categories),
    normCheckUser: buildNormCheckUserPrompt({
      chapterLabel: chapterLabel(checkChapter, v.sideStories),
      segment: { index: 0, total: 1, text: checkChapter.content },
      mentionedEntries: related,
      categories: v.categories,
      ...(previous ? { previous } : {}),
    }),
    normCondenseSystem: NORM_CONDENSE_SYSTEM,
    normCondenseUser_all: buildCondenseUserPrompt(fx.norms[0]!),
    normCondenseUser_writing: buildCondenseUserPrompt(fx.norms[1]!),
    translateSystem: buildTranslateSystemPrompt(fx.novel, fx.style),
    translateUser: buildTranslateUserPrompt({
      index: 5,
      title: 'The Ferry',
      sourceText: TRANSLATE_SOURCE,
      glossary: relevantGlossary(glossary, TRANSLATE_SOURCE),
      previousTranslatedTail: '两人连夜北上。',
    }),
    styleSampleSystem: STYLE_SAMPLE_SYSTEM,
    styleSampleUser: buildStyleSampleUserPrompt(SAMPLE_TEXT),
    manuscriptStyleSystem: MANUSCRIPT_STYLE_SYSTEM,
    manuscriptStyleUser: buildManuscriptStyleUserPrompt(SAMPLE_TEXT),
  };
}

// ---------------------------------------------------------------- 断言

/** 逐项断言：失败时能直接看出是哪一类任务变了 */
function expectBaseline(now: ReturnType<typeof actual>) {
  expect(now.builderMain).toEqual(BASELINE.builderMain);
  expect(now.builderSide).toEqual(BASELINE.builderSide);
  const keys = Object.keys(BASELINE).filter(
    (key) => key !== 'builderMain' && key !== 'builderSide',
  ) as (keyof typeof BASELINE)[];
  for (const key of keys) {
    expect([key, now[key]]).toEqual([key, BASELINE[key]]);
  }
  expect(Object.keys(now).sort()).toEqual(Object.keys(BASELINE).sort());
}

describe('没有推演时十类任务的 prompt 与改动前逐字节一致', () => {
  it('基线夹具', () => {
    expectBaseline(actual(fixtures()));
  });

  it('夹具里的规范确实进了 prompt（护栏不是空转）', () => {
    const now = actual(fixtures());
    expect(now.builderMain.stablePrefix).toContain('【标记 ALL】');
    expect(now.builderMain.stablePrefix).toContain('【标记 WRITING】');
    expect(now.summarySystem).toContain('【标记 ALL】');
    expect(now.summarySystem).not.toContain('【标记 WRITING】');
    expect(now.normCheckSystem).toContain('【标记 ALL】');
    expect(now.translateUser).toContain('Pei Zhao => 裴照');
  });
});

// ---------------------------------------------------------------- 变体输入（加入推演后才有的字段）

/**
 * 加入推演后，库里的行会多出这些字段（v7 迁移补默认值、新建时由 schema 填）。它们一律不该进任何现有 prompt。
 * 仍只用对象字面量：在改动前的代码上这些键只是没人读的多余属性，同一份文件照样能跑
 */
function withEntryScopes(fx: Fixtures): Fixtures {
  const pinnedEntry: KnowledgeEntry = {
    ...fx.pinnedEntry,
    scope: { kind: 'universal' },
    fieldLocks: { rules: 'mutable' },
  };
  const normalEntry: KnowledgeEntry = {
    ...fx.normalEntry,
    scope: { kind: 'universal' },
    fieldLocks: { identity: 'locked' },
  };
  return { ...fx, pinnedEntry, normalEntry };
}

function withMutability(fx: Fixtures): Fixtures {
  const mark = (category: Category): Category => ({
    ...category,
    fieldTemplate: category.fieldTemplate.map((field, i) => ({
      ...field,
      mutability: i % 2 === 0 ? 'locked' : 'mutable',
    })),
  });
  return { ...fx, worldCategory: mark(fx.worldCategory), charCategory: mark(fx.charCategory) };
}

function withScenarioSourceNull(fx: Fixtures): Fixtures {
  const outline: OutlineNode[] = fx.outline.map((node) => ({ ...node, scenarioSource: null }));
  const chapters: Chapter[] = fx.chapters.map((chapter) => ({ ...chapter, scenarioSource: null }));
  const sideStory: SideStory = { ...fx.sideStory, scenarioSource: null };
  return { ...fx, outline, chapters, sideStory };
}

/** 规范多一项「互动推演」，再加一份只含「互动推演」的启用规范：后者不得出现在任何现有任务的 prompt 里 */
function withInteractiveNorms(fx: Fixtures): Fixtures {
  const norms: WritingNorm[] = [
    ...fx.norms.map((norm) => ({ ...norm, scopes: [...norm.scopes, 'interactive' as const] })),
    {
      id: 'norm-interactive',
      novelId: 'n1',
      title: '推演约束',
      content: '- 每一步都要给出代价。【标记 INTERACTIVE】',
      enabled: true,
      scopes: ['interactive'],
      order: 0,
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  return { ...fx, norms };
}

/** 构建器显式传 scenarioContext: undefined：不传和传 undefined 必须一样 */
const explicitNoScenario = (request: ContextRequest): ContextRequest =>
  ({ ...request, scenarioContext: undefined }) as ContextRequest;

describe('变体输入仍与改动前逐字节一致', () => {
  it('条目带 scope / fieldLocks', () => {
    expectBaseline(actual(withEntryScopes(fixtures())));
  });

  it('分类模板的字段带 mutability', () => {
    expectBaseline(actual(withMutability(fixtures())));
  });

  it('大纲节点、章节、外传带 scenarioSource: null', () => {
    expectBaseline(actual(withScenarioSourceNull(fixtures())));
  });

  it('规范多一项「互动推演」，另有一份只含「互动推演」的启用规范', () => {
    const now = actual(withInteractiveNorms(fixtures()));
    expectBaseline(now);
    expect(JSON.stringify(now)).not.toContain('【标记 INTERACTIVE】');
  });

  it('构建器显式传 scenarioContext: undefined', () => {
    expectBaseline(actual(fixtures(), explicitNoScenario));
  });

  it('以上全部叠加', () => {
    const fx = withInteractiveNorms(
      withScenarioSourceNull(withMutability(withEntryScopes(fixtures()))),
    );
    expectBaseline(actual(fx, explicitNoScenario));
  });
});

// ---------------------------------------------------------------- 改动前的输出

/**
 * 在加入互动推演之前的代码上，用上面的夹具跑出来的原样输出（一次性脚本生成，脚本不进仓库）。
 * 这份常量永不修改 —— 断言失败时修实现。
 */
const BASELINE = {
  builderMain: {
    stablePrefix: `【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【规范《对白约束》】
- 裴照的对白不超过十五个字。【标记 WRITING】
【规范《对白约束》结束】

【必须遵守的核心设定】

## 灵气（世界观设定）
天地间流转的能量，修行之本。
运作规则：吐纳入体，经脉为渠。
限制与代价：强行催动会损寿元。

【相关设定】

## 裴照（人物）
别名：裴捕头、Pei Zhao
六扇门捕头，追查灭门案。
身份：六扇门捕头
说话方式：话少，句句带刺。`,
    volatileSuffix: `【本章要写的内容】
所在位置：第一卷 渡口
所在卷的梗概：林越醒来，卷入灭门案调查。
本章标题：夜探青冥宗
本章梗概：林越与裴照夜入青冥宗旧址，发现血书。
目标字数：约 3000 字

下一章是「血书」：血书指向林越本人。
本章不要提前写掉下一章的内容，但要为它铺好路。

【故事至此】
林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。

【前几章要点】

第 1 章 渡口
林越在渡口醒来，失去记忆。
关键事件：林越醒来
尚未收束的伏笔：林越的身世

第 2 章 裴照
裴照找上林越，出示一把刀。
关键事件：裴照出示刀
尚未收束的伏笔：林越的身世；刀的来历

第 3 章 北上
两人北上，林越梦见火光。
关键事件：两人北上；林越梦见火光
尚未收束的伏笔：林越的身世；刀的来历

【上一章（第 3 章）的结尾原文】
接着这段往下写，语气与节奏要能接住。

两人连夜北上。

林越夜里总梦见火光，灵气在经脉里乱窜。`,
    items: [
      {
        kind: 'meta',
        id: 'meta+style',
        label: '作品信息与风格档案',
        tokens: 681,
        included: true,
      },
      {
        kind: 'norm',
        id: 'norm-all',
        label: '写作规范 · 原作基线',
        tokens: 41,
        included: true,
      },
      {
        kind: 'norm',
        id: 'norm-writing',
        label: '写作规范 · 对白约束',
        tokens: 35,
        included: true,
      },
      {
        kind: 'pinned',
        id: 'e-lingqi',
        label: '核心设定 · 灵气',
        tokens: 44,
        included: true,
      },
      {
        kind: 'entry',
        id: 'e-peizhao',
        label: '人物 · 裴照',
        tokens: 41,
        included: true,
      },
      {
        kind: 'outline',
        id: 'o-ch4',
        label: '大纲位置 · 夜探青冥宗',
        tokens: 100,
        included: true,
      },
      {
        kind: 'rolling',
        id: 'rolling',
        label: '全书进展摘要',
        tokens: 22,
        included: true,
      },
      {
        kind: 'summary',
        id: 'sum-ch1',
        label: '第 1 章摘要',
        tokens: 33,
        included: true,
      },
      {
        kind: 'summary',
        id: 'sum-ch2',
        label: '第 2 章摘要',
        tokens: 38,
        included: true,
      },
      {
        kind: 'summary',
        id: 'sum-ch3',
        label: '第 3 章摘要',
        tokens: 42,
        included: true,
      },
      {
        kind: 'tail',
        id: 'ch3',
        label: '第 3 章结尾原文',
        tokens: 49,
        included: true,
      },
    ],
    estimatedTokens: 1126,
  },
  builderSide: {
    stablePrefix: `【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【规范《对白约束》】
- 裴照的对白不超过十五个字。【标记 WRITING】
【规范《对白约束》结束】

【必须遵守的核心设定】

## 灵气（世界观设定）
天地间流转的能量，修行之本。
运作规则：吐纳入体，经脉为渠。
限制与代价：强行催动会损寿元。

【相关设定】

## 裴照（人物）
别名：裴捕头、Pei Zhao
六扇门捕头，追查灭门案。
身份：六扇门捕头
说话方式：话少，句句带刺。`,
    volatileSuffix: `【本章属于外传《裴照少年行》】
简介：主线二十年前，裴照初入六扇门。
外传独立于主线：不要写成主线的后续，也不要改动主线里已经发生的事；人物与设定以上面的知识库为准。

【外传至此】
少年裴照在京城接下第一桩案子。

【主线进展（仅供参考，外传不必衔接它）】
林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。

【前几章要点】

第 1 章 初入京城
裴照进入六扇门。
关键事件：裴照入职
尚未收束的伏笔：师父的旧案

【上一章（外传第 1 章）的结尾原文】
接着这段往下写，语气与节奏要能接住。

十六岁的裴照第一次走进六扇门。`,
    items: [
      {
        kind: 'meta',
        id: 'meta+style',
        label: '作品信息与风格档案',
        tokens: 681,
        included: true,
      },
      {
        kind: 'norm',
        id: 'norm-all',
        label: '写作规范 · 原作基线',
        tokens: 41,
        included: true,
      },
      {
        kind: 'norm',
        id: 'norm-writing',
        label: '写作规范 · 对白约束',
        tokens: 35,
        included: true,
      },
      {
        kind: 'pinned',
        id: 'e-lingqi',
        label: '核心设定 · 灵气',
        tokens: 44,
        included: true,
      },
      {
        kind: 'entry',
        id: 'e-peizhao',
        label: '人物 · 裴照',
        tokens: 41,
        included: true,
      },
      {
        kind: 'sideStory',
        id: 'side-1',
        label: '外传·裴照少年行 说明',
        tokens: 66,
        included: true,
      },
      {
        kind: 'rolling',
        id: 'rolling-side',
        label: '外传进展摘要',
        tokens: 12,
        included: true,
      },
      {
        kind: 'rolling',
        id: 'rolling-main',
        label: '主线全书进展（参考）',
        tokens: 22,
        included: true,
      },
      {
        kind: 'summary',
        id: 'sum-sc1',
        label: '外传第 1 章摘要',
        tokens: 31,
        included: true,
      },
      {
        kind: 'tail',
        id: 'sc1',
        label: '外传第 1 章结尾原文',
        tokens: 41,
        included: true,
      },
    ],
    estimatedTokens: 1014,
  },
  chapterSystem: `你是一位职业小说作者，按编辑给定的大纲与设定写出可直接发表的正文。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【规范《对白约束》】
- 裴照的对白不超过十五个字。【标记 WRITING】
【规范《对白约束》结束】

【必须遵守的核心设定】

## 灵气（世界观设定）
天地间流转的能量，修行之本。
运作规则：吐纳入体，经脉为渠。
限制与代价：强行催动会损寿元。

【相关设定】

## 裴照（人物）
别名：裴捕头、Pei Zhao
六扇门捕头，追查灭门案。
身份：六扇门捕头
说话方式：话少，句句带刺。

【任务】
按下面给出的大纲写出这一章的正文。

硬性要求：
- 直接输出正文，不要章节标题、不要小标题、不要任何解释或说明。
- 不要使用 Markdown 标记。段落之间用空行分隔。
- 把设定**化用**进场景、动作与对话，不要复述设定本身。读者应当通过人物做了什么感受到世界规则，而不是被告知规则。
- 人物的说话方式要与其档案一致；同一个人物在不同章节的口吻不能变样。
- 严格遵守上文列出的核心设定，不要发明与之冲突的新规则。
- 只写本章范围内的内容，不要把后续章节的情节提前写掉。
- 如果上文给出了上一章的结尾原文，要顺着它的语气与场景往下接，不要重新交代已经交代过的信息。`,
  chapterUser: `【本章要写的内容】
所在位置：第一卷 渡口
所在卷的梗概：林越醒来，卷入灭门案调查。
本章标题：夜探青冥宗
本章梗概：林越与裴照夜入青冥宗旧址，发现血书。
目标字数：约 3000 字

下一章是「血书」：血书指向林越本人。
本章不要提前写掉下一章的内容，但要为它铺好路。

【故事至此】
林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。

【前几章要点】

第 1 章 渡口
林越在渡口醒来，失去记忆。
关键事件：林越醒来
尚未收束的伏笔：林越的身世

第 2 章 裴照
裴照找上林越，出示一把刀。
关键事件：裴照出示刀
尚未收束的伏笔：林越的身世；刀的来历

第 3 章 北上
两人北上，林越梦见火光。
关键事件：两人北上；林越梦见火光
尚未收束的伏笔：林越的身世；刀的来历

【上一章（第 3 章）的结尾原文】
接着这段往下写，语气与节奏要能接住。

两人连夜北上。

林越夜里总梦见火光，灵气在经脉里乱窜。

【本次要求】
本章目标约 3000 字，场景数供参考：1–2 场。
以【本章要写的内容】的梗概节拍为准：每个节拍落到目标—阻碍—转折；
节拍不足时把一场写深，不要用心理复述、景物堆砌凑字数；
节拍撑不满目标时写到场景自然收束即可。
按时空或视点转移换场，不要按段落切场。
结尾收在梗概承诺的钩子上，不要用总结收尾。
若文体篇幅建议（如网文单章 2000–3000 字）与本节目标冲突，以本节目标为准。
用户额外要求：结尾留一个钩子
现在开始写正文。`,
  sideChapterSystem: `你是一位职业小说作者，按编辑给定的大纲与设定写出可直接发表的正文。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【规范《对白约束》】
- 裴照的对白不超过十五个字。【标记 WRITING】
【规范《对白约束》结束】

【必须遵守的核心设定】

## 灵气（世界观设定）
天地间流转的能量，修行之本。
运作规则：吐纳入体，经脉为渠。
限制与代价：强行催动会损寿元。

【相关设定】

## 裴照（人物）
别名：裴捕头、Pei Zhao
六扇门捕头，追查灭门案。
身份：六扇门捕头
说话方式：话少，句句带刺。

【任务】
按下面给出的大纲写出这一章的正文。

硬性要求：
- 直接输出正文，不要章节标题、不要小标题、不要任何解释或说明。
- 不要使用 Markdown 标记。段落之间用空行分隔。
- 把设定**化用**进场景、动作与对话，不要复述设定本身。读者应当通过人物做了什么感受到世界规则，而不是被告知规则。
- 人物的说话方式要与其档案一致；同一个人物在不同章节的口吻不能变样。
- 严格遵守上文列出的核心设定，不要发明与之冲突的新规则。
- 只写本章范围内的内容，不要把后续章节的情节提前写掉。
- 如果上文给出了上一章的结尾原文，要顺着它的语气与场景往下接，不要重新交代已经交代过的信息。`,
  sideChapterUser: `【本章属于外传《裴照少年行》】
简介：主线二十年前，裴照初入六扇门。
外传独立于主线：不要写成主线的后续，也不要改动主线里已经发生的事；人物与设定以上面的知识库为准。

【外传至此】
少年裴照在京城接下第一桩案子。

【主线进展（仅供参考，外传不必衔接它）】
林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。

【前几章要点】

第 1 章 初入京城
裴照进入六扇门。
关键事件：裴照入职
尚未收束的伏笔：师父的旧案

【上一章（外传第 1 章）的结尾原文】
接着这段往下写，语气与节奏要能接住。

十六岁的裴照第一次走进六扇门。

【本次要求】
本章目标约 3000 字，场景数供参考：1–2 场。
以【本章要写的内容】的梗概节拍为准：每个节拍落到目标—阻碍—转折；
节拍不足时把一场写深，不要用心理复述、景物堆砌凑字数；
节拍撑不满目标时写到场景自然收束即可。
按时空或视点转移换场，不要按段落切场。
结尾收在梗概承诺的钩子上，不要用总结收尾。
若文体篇幅建议（如网文单章 2000–3000 字）与本节目标冲突，以本节目标为准。
现在开始写正文。`,
  reviseSystem_continue: `你是一位职业小说作者，正在对一段已有正文做局部加工。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【规范《对白约束》】
- 裴照的对白不超过十五个字。【标记 WRITING】
【规范《对白约束》结束】

【必须遵守的核心设定】

## 灵气（世界观设定）
天地间流转的能量，修行之本。
运作规则：吐纳入体，经脉为渠。
限制与代价：强行催动会损寿元。

【相关设定】

## 裴照（人物）
别名：裴捕头、Pei Zhao
六扇门捕头，追查灭门案。
身份：六扇门捕头
说话方式：话少，句句带刺。

【任务】
接着「待处理片段」往下写新的内容。

要求：
- 只输出新写的内容，不要重复已有的文字。
- 从已有内容的语气、节奏与场景自然接续，不要重新交代已交代过的信息。
- 篇幅控制在 200–500 字，写完一个完整的小节奏就停，不要草草收尾也不要拖长。
通用约束：
- 直接输出正文，不要 Markdown 标记、不要引号包裹、不要加标题。
- 严格遵守上文的核心设定与人物档案，人物口吻不得变样。`,
  reviseSystem_rewrite: `你是一位职业小说作者，正在对一段已有正文做局部加工。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【规范《对白约束》】
- 裴照的对白不超过十五个字。【标记 WRITING】
【规范《对白约束》结束】

【必须遵守的核心设定】

## 灵气（世界观设定）
天地间流转的能量，修行之本。
运作规则：吐纳入体，经脉为渠。
限制与代价：强行催动会损寿元。

【相关设定】

## 裴照（人物）
别名：裴捕头、Pei Zhao
六扇门捕头，追查灭门案。
身份：六扇门捕头
说话方式：话少，句句带刺。

【任务】
改写「待处理片段」：情节、信息与人物行为保持不变，换一种写法。

要求：
- 只输出改写后的片段，不要输出前后文，不要任何解释。
- 不要增加或删减情节事实，也不要改变人物的决定。
- 篇幅与原片段大致相当，上下浮动不超过 30%。
通用约束：
- 直接输出正文，不要 Markdown 标记、不要引号包裹、不要加标题。
- 严格遵守上文的核心设定与人物档案，人物口吻不得变样。`,
  reviseSystem_expand: `你是一位职业小说作者，正在对一段已有正文做局部加工。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【规范《对白约束》】
- 裴照的对白不超过十五个字。【标记 WRITING】
【规范《对白约束》结束】

【必须遵守的核心设定】

## 灵气（世界观设定）
天地间流转的能量，修行之本。
运作规则：吐纳入体，经脉为渠。
限制与代价：强行催动会损寿元。

【相关设定】

## 裴照（人物）
别名：裴捕头、Pei Zhao
六扇门捕头，追查灭门案。
身份：六扇门捕头
说话方式：话少，句句带刺。

【任务】
扩写「待处理片段」：在原有内容基础上增加细节与层次。

要求：
- 只输出扩写后的片段，不要输出前后文，不要任何解释。
- 保留原片段的全部情节与信息，在其间补充感官细节、动作、心理与对话。
- 不要引入新的情节转折或新人物。
- 篇幅大致为原片段的两倍。
通用约束：
- 直接输出正文，不要 Markdown 标记、不要引号包裹、不要加标题。
- 严格遵守上文的核心设定与人物档案，人物口吻不得变样。`,
  reviseUser_continue: `【本章要写的内容】
所在位置：第一卷 渡口
所在卷的梗概：林越醒来，卷入灭门案调查。
本章标题：夜探青冥宗
本章梗概：林越与裴照夜入青冥宗旧址，发现血书。
目标字数：约 3000 字

下一章是「血书」：血书指向林越本人。
本章不要提前写掉下一章的内容，但要为它铺好路。

【故事至此】
林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。

【前几章要点】

第 1 章 渡口
林越在渡口醒来，失去记忆。
关键事件：林越醒来
尚未收束的伏笔：林越的身世

第 2 章 裴照
裴照找上林越，出示一把刀。
关键事件：裴照出示刀
尚未收束的伏笔：林越的身世；刀的来历

第 3 章 北上
两人北上，林越梦见火光。
关键事件：两人北上；林越梦见火光
尚未收束的伏笔：林越的身世；刀的来历

【上一章（第 3 章）的结尾原文】
接着这段往下写，语气与节奏要能接住。

两人连夜北上。

林越夜里总梦见火光，灵气在经脉里乱窜。

【前文】
两人连夜北上。

林越夜里总梦见火光，灵气在经脉里乱窜。

【待处理片段】
（无，请从前文结尾处继续）`,
  reviseUser_rewrite: `【本章要写的内容】
所在位置：第一卷 渡口
所在卷的梗概：林越醒来，卷入灭门案调查。
本章标题：夜探青冥宗
本章梗概：林越与裴照夜入青冥宗旧址，发现血书。
目标字数：约 3000 字

下一章是「血书」：血书指向林越本人。
本章不要提前写掉下一章的内容，但要为它铺好路。

【故事至此】
林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。

【前几章要点】

第 1 章 渡口
林越在渡口醒来，失去记忆。
关键事件：林越醒来
尚未收束的伏笔：林越的身世

第 2 章 裴照
裴照找上林越，出示一把刀。
关键事件：裴照出示刀
尚未收束的伏笔：林越的身世；刀的来历

第 3 章 北上
两人北上，林越梦见火光。
关键事件：两人北上；林越梦见火光
尚未收束的伏笔：林越的身世；刀的来历

【上一章（第 3 章）的结尾原文】
接着这段往下写，语气与节奏要能接住。

两人连夜北上。

林越夜里总梦见火光，灵气在经脉里乱窜。

【待处理片段】
两人连夜北上。

【后文（不要写进去，但要能接上）】
林越夜里总梦见火光，灵气在经脉里乱窜。

【本次额外要求】
节奏再快一点`,
  reviseUser_expand: `【本章要写的内容】
所在位置：第一卷 渡口
所在卷的梗概：林越醒来，卷入灭门案调查。
本章标题：夜探青冥宗
本章梗概：林越与裴照夜入青冥宗旧址，发现血书。
目标字数：约 3000 字

下一章是「血书」：血书指向林越本人。
本章不要提前写掉下一章的内容，但要为它铺好路。

【故事至此】
林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。

【前几章要点】

第 1 章 渡口
林越在渡口醒来，失去记忆。
关键事件：林越醒来
尚未收束的伏笔：林越的身世

第 2 章 裴照
裴照找上林越，出示一把刀。
关键事件：裴照出示刀
尚未收束的伏笔：林越的身世；刀的来历

第 3 章 北上
两人北上，林越梦见火光。
关键事件：两人北上；林越梦见火光
尚未收束的伏笔：林越的身世；刀的来历

【上一章（第 3 章）的结尾原文】
接着这段往下写，语气与节奏要能接住。

两人连夜北上。

林越夜里总梦见火光，灵气在经脉里乱窜。

【本次临时文风】
这一次请按「鲁迅」的笔法来写（冷峻、克制、讽刺锋利），其特征如下：
- 句式节奏：短句为主，句读密集，常以转折词切断语流。段落简短，不作铺排，节奏像一记记落下的凿子。
- 意象偏好：偏冷的具体物象：铁屋、灰墙、寒夜、荒冢。意象不作装饰，往往直接承担象征功能。
- 叙述距离：叙述者冷眼旁观，与人物保持距离，偶尔以第一人称插入省思但不动声色。不替人物辩解，也不煽情。
- 对话风格：对话短促，多用方言与口语的粗糙质感，人物常答非所问，言外之意大于字面。
- 修辞习惯：反讽是主干：越是残酷的场面越用平静的语调陈述。善用重复与对照，不用感叹。
- 词汇色彩：文白夹杂，保留少量文言虚词与旧式称谓，整体用词朴素、硬、不甜。
- 需要避免：忌抒情长句、忌堆砌形容词、忌为人物的苦难作解释或安慰。
这只是本次的临时要求，不改变作品既有的文风设定。

【待处理片段】
两人连夜北上。

【后文（不要写进去，但要能接上）】
林越夜里总梦见火光，灵气在经脉里乱窜。`,
  summarySystem: `你是一位小说编辑助理，负责为连载中的作品维护剧情档案。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
提炼摘要时据此区分正文里已经确认的事实与仅属建议的内容；规范本身不是正文，不要写进摘要或伏笔。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【任务】
阅读给定的章节正文，提炼出供后续写作使用的摘要信息。

要求：
- summary：120 字以内，说清本章发生了什么、人物状态有何变化。只写发生过的事，不要评价，不要推测后续。
- keyEvents：3–6 条，每条一句话，按时间顺序。只记会影响后续情节的事。
- appearingEntries：本章真正出场或被实质提及的人物与设定，**只能从下面给出的名单中选**，名称原样抄写。名单里没有的不要编。
- newOpenThreads：本章新埋下、尚未解释的悬念或伏笔。没有就给空数组，不要为凑数硬编。
- resolvedThreads：本章解释或收束掉的**此前遗留**伏笔，必须从「当前未收束的伏笔」清单里原样抄回。没有就给空数组。
- rollingSummary：更新后的全书进展摘要，300 字以内，覆盖从开篇到本章的主线进展与人物当前处境。它会替换旧版本，所以要写成完整独立的一段，不要写成增量补充。`,
  summaryUser: `【可选的人物与设定名单】
灵气、裴照

【当前未收束的伏笔】
- 林越的身世
- 刀的来历
若本章收束了其中某条，请在 resolvedThreads 里原样抄回。

【此前的全书进展摘要】
林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。

【本章正文（第 3 章 北上）】
两人连夜北上。

林越夜里总梦见火光，灵气在经脉里乱窜。`,
  extractSystem: `你是一位小说资料编辑，擅长从已完成的稿件里整理出创作档案。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
提取时遵守其中关于命名、合并与信息限定的规则。规范本身不是待提取的正文，不要从规范里提取条目、摘要或伏笔。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【任务】
阅读给定的章节正文，倒推出这一章透露的设定信息，并同时提炼本章摘要。

entries（人物与设定）要求：
- 只写正文里真有依据的内容。允许归纳，不允许发挥想象补全作者没写的东西。
- categoryName 只能从上文列出的分类名称中选，原样抄写。
- fields 的 key 只能用该分类列出的键，原样抄写；没有依据的字段不要列进来。
- 对于「本章涉及的已有条目」，必须输出**整合后的完整字段**：把它现有的内容与本章新读到的信息合到一起再写出来，而不是只写增量部分。字段里原有的内容若本章没有推翻它，就要原样保留。
- 对于新出现的人物或设定，title 用正文里最常用的称呼；aliases 填其他称呼、绰号、尊称。
- 如果正文是译文、某个专名有对应的外文原名（例如「阿什福德」来自 Ashford），把**外文原名也放进 aliases**。它是溯源，也让后续导入的外文素材能认出这是同一个对象。
- summary 是一句话摘要（30 字内），用于在列表里快速辨认。
- 同一个对象只给一条，不要因为称呼不同拆成多条。
- 本章没有提供任何设定信息时，entries 给空数组。

摘要部分要求：
- summary：120 字以内，说清本章发生了什么、人物状态有何变化。只写发生过的事。
- keyEvents：3–6 条，每条一句话，按时间顺序。只记会影响后续情节的事。
- appearingEntries：本章出场或被实质提及的**已有条目**名称，只能从「已有条目名称」清单里原样抄选。清单里没有的不要写进来（新提取的条目不必在此重复）。
- newOpenThreads：本章新埋下、尚未解释的悬念或伏笔。没有就给空数组。
- resolvedThreads：本章收束掉的**此前遗留**伏笔，必须从「当前未收束的伏笔」清单里原样抄回。没有就给空数组。
- rollingSummary：更新后的全书进展摘要，300 字以内，覆盖从开篇到本章的主线进展与人物当前处境。它会替换旧版本，所以要写成完整独立的一段。

分类「世界观设定」的 fields 可用键：
- definition（定义）：用两三句话说清这条设定是什么，避免空泛的形容词。
- rules（运作规则）：给出可验证的具体规则，让后续情节有依据、不自相矛盾。
- cost（限制与代价）：限制比能力更重要：没有代价的设定会让冲突失重。

分类「人物」的 fields 可用键：
- identity（身份）：一行写清年龄、出身与当前处境。
- voice（说话方式）：写清口吻特征，让对话可辨认出是谁在说话。`,
  extractUser: `【本章涉及的已有条目（含现有完整内容）】
- 名称：裴照（分类「人物」）
  别名：裴捕头、Pei Zhao
  摘要：六扇门捕头，追查灭门案。
  identity：六扇门捕头
  voice：话少，句句带刺。
若本章补充了它们的信息，请在 entries 里给出整合后的完整版本（名称沿用上面的名称）；本章没有新信息的条目不必列出。

【已有条目名称】
灵气

【当前未收束的伏笔】
- 林越的身世
若本章收束了其中某条，请在 resolvedThreads 里原样抄回。

【此前的全书进展摘要】
林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。

【本章正文（第 2 章 裴照）】
裴照把刀横在桌上。

“你认得这把刀吗？”裴捕头问。`,
  expandSystem: `你是一位资深的小说策划编辑，擅长把粗线条的大纲逐层细化成可直接开写的场景。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
规划世界观、人物与大纲时同样遵守这些约束；规范本身不是需要生成的设定。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【任务】
把用户指定的那个大纲节点，拆成下一层的若干子节点。

要求：
- 只拆这一个节点，不要改动它本身，也不要涉及它的兄弟节点。
- 子节点要覆盖该节点梗概里承诺的全部内容，既不遗漏也不越界。
- 同一层的颗粒度要一致：不要有的子节点是一个场景、有的是半卷剧情。
- 每个子节点的梗概都要能说清「谁想做什么、遇到什么阻碍、结果如何」，避免只写氛围。
- 子节点之间要有因果推进，前一个的结果构成后一个的前提。
- targetWords 给出该子节点的预估字数；无法判断时填 null。
- 每个子节点的梗概按「场景卡」写：谁想要什么、什么在阻碍、转折点在哪里、结尾留下什么局面或认知变化；不要只写「发生了某事」。
- 至少有一处，要让人物在软肋或世界规则的代价上做出一次选择或拒绝，且这次选择必须改变后文走向；「他想起妹妹」这种内心一笔不算。把设定复述进梗概不算「应用设定」。
- 梗概里可以点名涉及的人物、地点、道具（用知识库中的名字或别名）；世界规则不要点名复述，只写它逼出的代价。不要为凑关联硬塞无关人物。
- 不得违背【必须遵守的核心设定】；与梗概冲突时以设定为准，并把约束的代价写进情节。
- 章末要能看出钩子与信息差：谁知道什么、读者被瞒了什么。
- 子节点 targetWords 之和应接近父节点的目标字数，但不凑数拉长；情节量不足时宁短。父节点没有目标时按每章约 3000 字估。`,
  expandUser: `【当前位置】
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
  setupSystem: `你是一位资深的小说策划编辑，擅长把一个模糊的点子落成可执行的创作蓝本。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
规划世界观、人物与大纲时同样遵守这些约束；规范本身不是需要生成的设定。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【任务】
根据用户给出的一句话故事内核，为这本书搭出可以直接开写的地基：世界观设定、主要人物、全书大纲。

总体要求：
- 所有内容都要从这句话生长出来，不要另起一个故事。
- 设定与人物必须彼此咬合：世界观的规则要能生出人物的困境，人物的目标要能撞上世界观的限制。
- 宁少而准，不多而空。每一条都要具体到能指导写作，避免「神秘的力量」「复杂的身世」这类空话。
- 人物之间要有明确的关系与张力，关系描述里写清对方姓名以便交叉引用。
- 大纲的结构必须遵守上文【结构方法】给出的组织方式。
- summary 是一句话摘要，用于在列表里快速辨认，控制在 30 字内。
- core 标记该设定是否属于「每次写作都必须遵守的核心规则」；只有真正的底层规则才标 true，通常 1–2 条。
- aliases 填别名、绰号、曾用名；没有就给空数组。

世界观设定（分类「世界观设定」）的 fields 各栏要求：
- definition（定义）：用两三句话说清这条设定是什么，避免空泛的形容词。
- rules（运作规则）：给出可验证的具体规则，让后续情节有依据、不自相矛盾。
- cost（限制与代价）：限制比能力更重要：没有代价的设定会让冲突失重。

人物（分类「人物」）的 fields 各栏要求：
- identity（身份）：一行写清年龄、出身与当前处境。
- voice（说话方式）：写清口吻特征，让对话可辨认出是谁在说话。`,
  setupUser: `【故事内核】
失忆剑客发现自己是灭门案凶手。

【篇幅】
长篇（50 万字以上）

【大纲要求】
分 4–6 个卷。
只为前两卷展开章节节点（每卷 6–10 章，每章约 3000 字）；
后续各卷只给卷级标题与梗概，不展开章节 —— 长篇的后段应当在写作过程中随剧情生长，过早细化只会被推翻。

【用户额外要求】
主角不能开金手指

请给出世界观设定 3–6 条、主要人物 3–6 位，以及符合上述要求的全书大纲。`,
  normCheckSystem: `你是一位严谨的小说责任编辑，负责按作者定下的写作规范审读章节。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
审读时逐条对照这些规范，找出正文可能违反之处。规范之外的问题不在本次范围内。

【规范《原作基线》】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】
【规范《原作基线》结束】

【核心设定（供判断，不是检查对象）】

## 灵气（世界观设定）
天地间流转的能量，修行之本。
运作规则：吐纳入体，经脉为渠。
限制与代价：强行催动会损寿元。

【任务】
审读给出的章节正文，逐条对照上面的写作规范，列出正文里可能违反规范的地方。

要求：
- 只依据上面的写作规范、核心设定和给出的前情判断。不要用你对原作或常识的记忆补出规范没写的规则。
- 没有发现问题就给空数组。不要为了凑数硬找。
- normTitle：原样抄写被违反的规范标题，即「【规范《…》】」书名号里的文字，不要抄规范内部的小节标题。
- rule：原样摘抄那份规范里被违反的那一条，不超过 80 字。
- quote：从正文原样摘抄能定位问题的连续片段，10–60 字，不得改字，不得拼接不相邻的句子。问题是「缺了应有的交代」而不是某句写错时，给空串。
- problem：一两句话说明为什么可能违反。
- suggestion：怎么改，一两句话；没有好的建议就给空串。不要输出改写后的整段正文。
- severity：violation = 明确违反；possible = 可能违反，取决于前文没写明的信息；judgement = 规范本身留有余地，需要作者判断。
- 最多 20 条，严重的在前。`,
  normCheckUser: `【此前最近一章（第 2 章）的摘要】
第 2 章 裴照
裴照找上林越，出示一把刀。
关键事件：裴照出示刀
尚未收束的伏笔：林越的身世；刀的来历

【待检查的正文（第 3 章）】
两人连夜北上。

林越夜里总梦见火光，灵气在经脉里乱窜。`,
  normCondenseSystem: `你是一位小说编辑，负责把作者整理的写作规范压缩成可以直接放进提示词的约束条目。

【任务】
阅读作者给出的规范原文，只保留会约束创作与资料整理的内容，改写成简洁的条目。

要求：
- 保留：时间截面与冻结信息、与原作的版本差异、本作的改动及其后续影响、明确的边界与禁止事项、命名与合并规则、信息分层（谁知道什么）。
- 删除：来源链接、参考网址、来源表与「能核对的内容」这类核对说明、重复表述、背景概述里不构成约束的叙述。
- 不得新增原文没有的规则或事实，不得把原文的限定词（如「原作未明确」「推测」「留白」）改成确定说法。
- 按原文的小节分组，每组一个以「## 」开头的小标题，组内每条以「- 」开头，一条一句。
- 直接输出条目，不要任何开场白或解释。`,
  normCondenseUser_all: `【规范标题】
原作基线

【规范原文】
- 以已导入资料为原作基线，不改动既有人物关系。【标记 ALL】`,
  normCondenseUser_writing: `【规范标题】
对白约束

【规范原文】
- 裴照的对白不超过十五个字。【标记 WRITING】`,
  translateSystem: `你是一位文学译者，正在把一部作品的外文稿译成简体中文。

【作品信息】
书名：归墟纪
体裁：仙侠
叙述视角：第三人称限知视角
故事内核：失忆剑客发现自己是灭门案凶手。
预计总字数：300000

【文体取向】
网络文学（强代入、快节奏、每章有钩子）
面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。
遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。
每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。
爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。
单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。
对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。
子类「仙侠」的额外约定：修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。

【结构方法】
网文节奏结构（黄金三章 + 单元副本 + 阶段爆点）
按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。
第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。
每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。
每卷要留至少一条通向下一卷的悬念线。

【文风】
以下是对目标文风的特征描述。请据此把握语感，而不是模仿任何具体作品的文句。
参考风格：古龙（明显偏向）
- 句式节奏：极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。
- 意象偏好：酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。
- 叙述距离：贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。
- 对话风格：对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。
- 修辞习惯：格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。
- 词汇色彩：现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。
- 需要避免：忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。
额外写作要求：对白少用感叹号，打斗不写招式名。

【任务】
把用户给出的外文章节译成简体中文，供作者接着用中文续写这部作品。

这是文学翻译，不是逐词对译。要求：
- **忠实优先**。不增删情节、不合并段落、不替作者补写没写的东西；原文含糊的地方保持含糊。
- 保留原文的分段与空行结构。原文一段就是一段，不要为了通顺而合并或拆分。
- 对话用中文引号「」，保留每句话各自成段的排版习惯。
- 人名、地名、组织名、专有物品名按中文出版惯例音译或意译，同一个名字**全书只能有一个译法**。
- 计量单位、货币、俗语按中文读者能直接理解的方式处理，但不要改成中国特有的事物。
- 原文里的英文缩写、拉丁学名、代号如果中文没有通行译法，保留原文。

【输出格式】
先输出译文正文，不要加标题、不要加任何说明文字、不要用代码块包裹。
译文之后另起一行，原样输出这一行分隔符：
---译名表---
再逐行列出本章用到的专名对照，每行一条，格式为：
原文名 => 中文译名
只列专有名词（人名 / 地名 / 组织 / 特有物品），不要列普通词汇。本章没有专名就留空。

【风格与忠实的优先级】
上面的文风要求只用来决定措辞与语感，不得据此增删或改写情节。两者冲突时一律以忠实于原文为准。`,
  translateUser: `【已定译名（必须沿用，不得另起译法）】
Pei Zhao => 裴照

【上一章译文的结尾（仅供接住语感，不要续写它）】
两人连夜北上。

【待翻译的原文（第 5 章 The Ferry）】
The fog had not lifted when Pei Zhao laid his blade on the table.

"Do you know this blade?" he asked.`,
  styleSampleSystem: `你是一位文学编辑，擅长把文本的风格特征归纳成可执行的写作指引。

任务：阅读用户提供的示例文本，提炼其风格特征，输出结构化的风格描述。

要求：
- 描述可观察的写作手法（句子长度分布、意象取材、叙述距离、对话密度与语气、修辞倾向、词汇语域），不要评价文学价值。
- 每一项用 1–3 句话写清楚，要具体到能指导写作，避免「优美」「生动」这类空话。
- 「需要避免」一项写出与该风格相冲突的写法，供后续生成时规避。
- 只归纳风格，不要复述或引用示例文本的内容与情节。
- 七个维度依次是：句式节奏、意象偏好、叙述距离、对话风格、修辞习惯、词汇色彩、需要避免。`,
  styleSampleUser: `示例文本如下：

---
江雾未散，林越在渡口醒来。他不记得自己是谁，只记得火光。裴照把刀横在桌上，一句话也不说。
---`,
  manuscriptStyleSystem: `你是一位文学编辑，擅长把一位作者的既有作品归纳成可执行的写作指引。

任务：阅读同一部作品的若干片段，归纳这位作者**自己的**写作风格，供后续续写时沿用。

风格描述要求：
- 描述可观察的写作手法（句子长度分布、意象取材、叙述距离、对话密度与语气、修辞倾向、词汇语域），不要评价文学价值高低。
- 每一项用 1–3 句话写清楚，要具体到能指导写作，避免「优美」「生动」这类空话。
- 「需要避免」一项写出与这位作者的习惯相冲突的写法，供后续生成时规避 —— 注意是「不像他」的写法，不是「写得不好」的写法。
- 只归纳风格，不要复述情节、人物或设定。
- 七个维度依次是：句式节奏、意象偏好、叙述距离、对话风格、修辞习惯、词汇色彩、需要避免。

文体判断要求：
- web（网络文学）：强代入、快节奏、每章有钩子。
- literary（严肃文学）：主题先行，留白与内心。
- genre（类型文学）：遵守类型公约，在规则内出彩。
- 按片段呈现的实际写法判断，不要按题材猜。分不清时选 web。
- 子类只在明显可判时给出，给不出就留空字符串。`,
  manuscriptStyleUser: `以下是这部作品的若干片段：

---
江雾未散，林越在渡口醒来。他不记得自己是谁，只记得火光。裴照把刀横在桌上，一句话也不说。
---`,
};
