/**
 * 零变化护栏的第二半：四种「没有可注入规范」的输入（不传、空数组、只有停用的、只有作用范围外的）
 * 必须与不传规范时逐字节相同。
 *
 * 夹具与 noNormsBaseline.test.ts 完全相同（逐字复制，不要单独改动）：那份文件断言「不传规范 === BASELINE」，
 * 这里断言「四种输入 === 不传规范」，两者合起来就是「四种输入 === 改动前的 BASELINE」。
 * 不把这四种输入直接加进 noNormsBaseline.test.ts，是为了让那份护栏文件保持改动前写成时的样子，
 * 随时可以原样拷回旧代码上交叉核对。
 *
 * 传递关系只在两份夹具一致时成立，只改其中一份会让护栏静默失效。所以文末「夹具同步」用例按源码文本
 * 比对两份文件的夹具区（本文件只多出规范参数，规整掉后必须逐字相同），不一致就直接失败。
 * 不抽共享夹具模块，是因为那样就得改 noNormsBaseline.test.ts，它必须保持能原样拷回旧代码。
 */
import { describe, expect, it } from 'vitest';
import baselineSource from './noNormsBaseline.test.ts?raw';
import selfSource from './noNormsInputs.test.ts?raw';
import { CHARACTER_FIELDS, WORLDBUILDING_FIELDS } from '@/domain/defaults';
import {
  CategorySchema,
  ChapterSchema,
  ChapterSummarySchema,
  KnowledgeEntrySchema,
  NovelSchema,
  OutlineNodeSchema,
  SideStorySchema,
  StyleProfileSchema,
  type WritingNorm,
  type WritingNormScope,
} from '@/domain/schema';
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
import { SummaryChainContextBuilder } from './SummaryChainContextBuilder';
import type { BuiltContext, ContextRequest } from './ContextBuilder';

// ---------------------------------------------------------------- 夹具

const novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  pov: 'third-limited',
  oneLiner: '失忆剑客发现自己是灭门案凶手。',
  targetWords: 300000,
  rollingSummary: '林越在渡口醒来，记忆全失，随裴照北上追查青冥宗灭门案。',
  createdAt: 0,
  updatedAt: 0,
});

const style = StyleProfileSchema.parse({
  id: 's1',
  novelId: 'n1',
  tradition: 'web',
  subGenre: '仙侠',
  methodology: 'web-rhythm',
  voiceRefs: [{ refId: 'gulong', name: '古龙', weight: 70 }],
  extraInstruction: '对白少用感叹号，打斗不写招式名。',
  createdAt: 0,
  updatedAt: 0,
});

const worldCategory = CategorySchema.parse({
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

const charCategory = CategorySchema.parse({
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

const categories = [worldCategory, charCategory];

const pinnedEntry = KnowledgeEntrySchema.parse({
  id: 'e-lingqi',
  novelId: 'n1',
  categoryId: worldCategory.id,
  title: '灵气',
  summary: '天地间流转的能量，修行之本。',
  fields: { rules: '吐纳入体，经脉为渠。', cost: '强行催动会损寿元。' },
  pinned: true,
  createdAt: 0,
  updatedAt: 0,
});

const normalEntry = KnowledgeEntrySchema.parse({
  id: 'e-peizhao',
  novelId: 'n1',
  categoryId: charCategory.id,
  title: '裴照',
  aliases: ['裴捕头'],
  summary: '六扇门捕头，追查灭门案。',
  fields: { identity: '六扇门捕头', voice: '话少，句句带刺。' },
  createdAt: 0,
  updatedAt: 0,
});

const entries = [pinnedEntry, normalEntry];

const volumeNode = OutlineNodeSchema.parse({
  id: 'o-vol1',
  novelId: 'n1',
  parentId: null,
  order: 0,
  title: '第一卷 渡口',
  synopsis: '林越醒来，卷入灭门案调查。',
  createdAt: 0,
  updatedAt: 0,
});

const chapterNode = OutlineNodeSchema.parse({
  id: 'o-ch4',
  novelId: 'n1',
  parentId: 'o-vol1',
  order: 3,
  title: '夜探青冥宗',
  synopsis: '林越与裴照夜入青冥宗旧址，发现血书。',
  targetWords: 3000,
  createdAt: 0,
  updatedAt: 0,
});

const nextNode = OutlineNodeSchema.parse({
  id: 'o-ch5',
  novelId: 'n1',
  parentId: 'o-vol1',
  order: 4,
  title: '血书',
  synopsis: '血书指向林越本人。',
  createdAt: 0,
  updatedAt: 0,
});

const outline = [volumeNode, chapterNode, nextNode];

const sideStory = SideStorySchema.parse({
  id: 'side-1',
  novelId: 'n1',
  title: '裴照少年行',
  synopsis: '主线二十年前，裴照初入六扇门。',
  rollingSummary: '少年裴照在京城接下第一桩案子。',
  order: 0,
  createdAt: 0,
  updatedAt: 0,
});

function mainChapter(index: number, title: string, content: string) {
  return ChapterSchema.parse({
    id: `ch${index}`,
    novelId: 'n1',
    index,
    title,
    content,
    status: content ? 'done' : 'draft',
    createdAt: 0,
    updatedAt: 0,
  });
}

const chapters = [
  mainChapter(1, '渡口', '江雾未散，林越在渡口醒来。\n\n他不记得自己是谁。'),
  mainChapter(2, '裴照', '裴照把刀横在桌上。\n\n“你认得这把刀吗？”'),
  mainChapter(3, '北上', '两人连夜北上。\n\n林越夜里总梦见火光。'),
  mainChapter(4, '夜探青冥宗', ''),
  ChapterSchema.parse({
    id: 'sc1',
    novelId: 'n1',
    index: 1,
    title: '初入京城',
    content: '十六岁的裴照第一次走进六扇门。',
    status: 'done',
    sideStoryId: sideStory.id,
    createdAt: 0,
    updatedAt: 0,
  }),
  ChapterSchema.parse({
    id: 'sc2',
    novelId: 'n1',
    index: 2,
    title: '第一桩案子',
    content: '',
    sideStoryId: sideStory.id,
    createdAt: 0,
    updatedAt: 0,
  }),
];

function summaryOf(chapterId: string, summary: string, keyEvents: string[], openThreads: string[]) {
  return ChapterSummarySchema.parse({
    id: `sum-${chapterId}`,
    novelId: 'n1',
    chapterId,
    summary,
    keyEvents,
    appearingEntryIds: chapterId === 'ch1' ? [] : ['e-peizhao'],
    openThreads,
    createdAt: 0,
    updatedAt: 0,
  });
}

const summaries = [
  summaryOf('ch1', '林越在渡口醒来，失去记忆。', ['林越醒来'], ['林越的身世']),
  summaryOf('ch2', '裴照找上林越，出示一把刀。', ['裴照出示刀'], ['林越的身世', '刀的来历']),
  summaryOf(
    'ch3',
    '两人北上，林越梦见火光。',
    ['两人北上', '林越梦见火光'],
    ['林越的身世', '刀的来历'],
  ),
  summaryOf('sc1', '裴照进入六扇门。', ['裴照入职'], ['师父的旧案']),
];

function mainRequest(writingNorms?: WritingNorm[]): ContextRequest {
  return {
    ...(writingNorms ? { writingNorms } : {}),
    novel,
    style,
    categories,
    entries,
    outline,
    chapters,
    summaries,
    targetNodeId: chapterNode.id,
    targetChapterId: 'ch4',
    sideStories: [sideStory],
  };
}

function sideRequest(writingNorms?: WritingNorm[]): ContextRequest {
  return {
    ...(writingNorms ? { writingNorms } : {}),
    novel,
    style,
    categories,
    entries,
    outline,
    chapters,
    summaries,
    targetNodeId: null,
    targetChapterId: 'sc2',
    sideStories: [sideStory],
  };
}

const builder = new SummaryChainContextBuilder();

/** 只取会进 prompt 或展示给作者的部分；defaultEntryIds / previousChapter 不在零变化范围内 */
function pickBuilt(built: BuiltContext) {
  return {
    stablePrefix: built.stablePrefix,
    volatileSuffix: built.volatileSuffix,
    items: built.items,
    estimatedTokens: built.estimatedTokens,
  };
}

const REVISE_CONTENT = chapters[2]!.content;

function reviseUser(action: ReviseAction, built: BuiltContext): string {
  const selection =
    action === 'continue'
      ? selectionAtEnd(REVISE_CONTENT)
      : normalizeSelection(REVISE_CONTENT, 0, REVISE_CONTENT.indexOf('\n'));
  const { before, after } = surroundingContext(REVISE_CONTENT, selection);
  return buildReviseUserPrompt({
    volatileSuffix: built.volatileSuffix,
    selection,
    before,
    after,
    temporaryVoiceId: action === 'expand' ? 'luxun' : null,
    instruction: action === 'rewrite' ? '节奏再快一点' : undefined,
  });
}

/** 各任务对应的作用范围：「作用范围外」的输入按任务分别构造 */
type Task = 'builder' | 'summary' | 'extract' | 'expand' | 'setup';
const TASK_SCOPE: Record<Task, WritingNormScope> = {
  builder: 'writing',
  summary: 'summary',
  extract: 'extract',
  expand: 'planning',
  setup: 'planning',
};

function actual(nf: (task: Task) => WritingNorm[] | undefined) {
  const main = builder.build(mainRequest(nf('builder')));
  const side = builder.build(sideRequest(nf('builder')));
  return {
    builderMain: pickBuilt(main),
    builderSide: pickBuilt(side),
    chapterSystem: buildChapterSystemPrompt(main.stablePrefix),
    reviseSystem_continue: buildReviseSystemPrompt(main.stablePrefix, 'continue'),
    reviseSystem_rewrite: buildReviseSystemPrompt(main.stablePrefix, 'rewrite'),
    reviseSystem_expand: buildReviseSystemPrompt(main.stablePrefix, 'expand'),
    summarySystem: buildSummarySystemPrompt(novel, nf('summary')),
    extractSystem: buildExtractSystemPrompt(novel, categories, nf('extract')),
    expandSystem: buildExpandSystemPrompt(novel, style, nf('expand')),
    setupSystem: buildSetupSystemPrompt(novel, style, worldCategory, charCategory, nf('setup')),
    chapterUser: buildChapterUserPrompt({
      volatileSuffix: main.volatileSuffix,
      targetWords: 3000,
      instruction: '结尾留一个钩子',
    }),
    reviseUser_continue: reviseUser('continue', main),
    reviseUser_rewrite: reviseUser('rewrite', main),
    reviseUser_expand: reviseUser('expand', main),
    summaryUser: buildSummaryUserPrompt({
      chapter: chapters[2]!,
      entryNames: ['灵气', '裴照'],
      previousOpenThreads: ['林越的身世', '刀的来历'],
      previousRollingSummary: novel.rollingSummary,
    }),
    extractUser: buildExtractUserPrompt({
      chapter: chapters[1]!,
      mentionedEntries: [normalEntry],
      categories,
      otherEntryNames: ['灵气'],
      openThreads: ['林越的身世'],
      rollingSummary: novel.rollingSummary,
    }),
    expandUser: buildExpandUserPrompt({
      node: volumeNode,
      ancestors: [],
      siblings: [volumeNode],
      existingChildren: [chapterNode, nextNode],
      linkedEntries: [normalEntry],
      count: 4,
      extra: '每章都要有一次交锋',
    }),
    setupUser: buildSetupUserPrompt({
      oneLiner: novel.oneLiner,
      scale: findScale('long'),
      extra: '主角不能开金手指',
    }),
  };
}

// ---------------------------------------------------------------- 规范夹具

/** 对象字面量 + import type：不依赖任何新增的运行时模块 */
function norm(overrides: Partial<WritingNorm> = {}): WritingNorm {
  return {
    id: 'norm-1',
    novelId: 'n1',
    title: '使用提示',
    content: '- 以已导入资料为原作基线。【标记 BASE】',
    enabled: true,
    scopes: ['writing', 'planning', 'summary', 'extract', 'check'],
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const ALL_SCOPES: WritingNormScope[] = ['writing', 'planning', 'summary', 'extract', 'check'];

// ---------------------------------------------------------------- 断言

describe('四种没有可注入规范的输入与不传规范逐字节一致', () => {
  const reference = actual(() => undefined);

  it.each([
    ['不传', () => undefined],
    ['空数组', () => []],
    ['只有停用的规范', () => [norm({ enabled: false })]],
    [
      '只有作用范围不含该任务的规范',
      (task: Task) => [norm({ scopes: ALL_SCOPES.filter((scope) => scope !== TASK_SCOPE[task]) })],
    ],
  ] as const)('%s', (_label, normsFor) => {
    expect(actual(normsFor)).toEqual(reference);
  });

  it('作用范围内的规范确实会改变提示词（护栏不是空转）', () => {
    const changed = actual(() => [norm()]);
    expect(changed.builderMain.stablePrefix).toContain('【标记 BASE】');
    expect(changed.summarySystem).toContain('【标记 BASE】');
    expect(changed.extractSystem).toContain('【标记 BASE】');
    expect(changed.expandSystem).toContain('【标记 BASE】');
    expect(changed.setupSystem).toContain('【标记 BASE】');
    // 规范不进易变后缀，用户提示不受影响
    expect(changed.chapterUser).toBe(reference.chapterUser);
  });
});

// ---------------------------------------------------------------- 夹具同步

/** 从「夹具」分隔线到 actual() 结尾：两份文件里决定提示词输入的全部代码 */
function fixtureRegion(source: string): string {
  const start = source.indexOf(
    '// ---------------------------------------------------------------- 夹具',
  );
  const actualAt = source.indexOf('function actual(');
  const endMarker = '\n  };\n}\n';
  const end = actualAt < 0 ? -1 : source.indexOf(endMarker, actualAt);
  // 找不到标记也算失败：标记被改名时比对不能悄悄变成空串对空串
  if (start < 0 || actualAt < 0 || end < 0) throw new Error('夹具区标记缺失');
  return source.slice(start, end + endMarker.length).replace(/\r\n/gu, '\n');
}

/** 去掉本文件比基线多出的规范参数，其余必须与基线逐字相同 */
function withoutNormParams(region: string): string {
  return region
    .replace(/\/\*\* 各任务对应的作用范围[\s\S]*?(?=function actual\()/u, '')
    .replace(/\(writingNorms\?: WritingNorm\[\]\)/gu, '()')
    .replace(/\n {4}\.\.\.\(writingNorms \? \{ writingNorms \} : \{\}\),/gu, '')
    .replace('(nf: (task: Task) => WritingNorm[] | undefined)', '()')
    .replace(/\(nf\('builder'\)\)/gu, '()')
    .replace(/, nf\('\w+'\)/gu, '');
}

describe('夹具同步', () => {
  it('本文件的夹具与 noNormsBaseline.test.ts 逐字一致（规整规范参数后）', () => {
    expect(withoutNormParams(fixtureRegion(selfSource))).toBe(fixtureRegion(baselineSource));
  });
});
