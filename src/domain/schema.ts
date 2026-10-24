/**
 * 全部实体的 Zod schema —— 类型与运行时校验的唯一事实源。
 *
 * 为什么用 Zod 而不是裸 TypeScript 接口：
 * 1. LLM 返回的 JSON 不可信（DeepSeek 只保证合法 JSON，不保证贴合 schema），
 *    必须有运行时校验，且能把校验错误回灌给模型做修复重试；
 * 2. 备份导入的文件同样不可信；
 * 3. Zod 4 可通过 z.toJSONSchema 直接导出 JSON Schema 下发给支持严格模式的
 *    provider，避免 schema 定义两份而漂移。
 */
import { z } from 'zod';
// importJob.ts 只是纯函数、不 import 本文件的运行时值，不会形成循环依赖
import { upgradeLegacyImportJob } from './importJob';
// scenario.ts 同理：对本文件只 import type。这里用它的长度 / 文案常量与 normalizeAction（备份规则 10）
import { SCENARIO_LIMITS as LIMITS, SCENARIO_MESSAGES as MSG, arrivalKey } from './scenario';

export const IdSchema = z.string().min(1);
/** epoch 毫秒 */
export const TimestampSchema = z.number().int().nonnegative();
/** 本地日历日 YYYY-MM-DD */
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期须为 YYYY-MM-DD');

// ---------------------------------------------------------------- 小说

export const PovSchema = z.enum(['first', 'third-limited', 'third-omniscient']);
export const NovelStatusSchema = z.enum(['planning', 'writing', 'paused', 'completed']);

export const NovelSchema = z.object({
  id: IdSchema,
  title: z.string().min(1, '书名不能为空').max(120),
  /** 「我想讲一个什么故事」——立项时的一句话，后续生成始终以它为锚 */
  oneLiner: z.string().max(2000).default(''),
  genre: z.string().max(60).default(''),
  pov: PovSchema.default('third-limited'),
  /** 预计总字数，null 表示未设定 */
  targetWords: z.number().int().positive().nullable().default(null),
  status: NovelStatusSchema.default('planning'),
  /**
   * 全书滚动进展摘要。放在 Novel 上而不是单独建表：
   * 它天然是每本书一行，独立成表只会多一次 join。
   */
  rollingSummary: z.string().default(''),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable().default(null),
});
export type Novel = z.infer<typeof NovelSchema>;

/** 新建小说时用户可填的字段 */
export const NovelDraftSchema = NovelSchema.pick({
  title: true,
  oneLiner: true,
  genre: true,
  pov: true,
  targetWords: true,
}).partial({ oneLiner: true, genre: true, pov: true, targetWords: true });
export type NovelDraft = z.infer<typeof NovelDraftSchema>;

// ---------------------------------------------------------------- 分类与知识条目

export const FieldTypeSchema = z.enum(['text', 'longtext', 'list']);

/**
 * 字段在世界线上的可变性。locked = 底层设定，任何世界线都不能改写；mutable = 世界线可以改写。
 * 按字段而不是按条目：同一个人物的「身份」会因背叛而变，「说话方式」不该被一条世界线改掉
 */
export const FieldMutabilitySchema = z.enum(['locked', 'mutable']);
export type FieldMutability = z.infer<typeof FieldMutabilitySchema>;

export const FieldDefSchema = z.object({
  /** 存入 KnowledgeEntry.fields 的键 */
  key: z.string().min(1),
  label: z.string().min(1),
  type: FieldTypeSchema.default('text'),
  placeholder: z.string().default(''),
  /** 供 AI 理解该字段该写什么，会进 prompt */
  hint: z.string().default(''),
  /**
   * 模板给的默认可变性。可选且不给 default：旧分类 parse 后形状不变；
   * 缺省时按 builtinMutability 推断（defaults.ts），所以旧作品不需要迁移分类表
   */
  mutability: FieldMutabilitySchema.optional(),
});
export type FieldDef = z.infer<typeof FieldDefSchema>;

/**
 * 分类的内核类型。
 *
 * 注意：设计里的「内置三大类」中，大纲由 OutlineNode 单独建模而不是分类下的条目
 * —— 大纲是有序且分层的（卷/章），知识条目是无序集合，硬塞进同一个模型会让
 * 排序与层级逻辑到处漏出。因此内置分类只有世界观与人物两类，大纲在 UI 上
 * 作为独立板块呈现。
 */
export const CategoryKindSchema = z.enum(['worldbuilding', 'character', 'custom']);

export const CategorySchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  name: z.string().min(1).max(40),
  kind: CategoryKindSchema.default('custom'),
  /** 内置分类不可删除，仅可改名与增删字段 */
  builtin: z.boolean().default(false),
  fieldTemplate: z.array(FieldDefSchema).default([]),
  order: z.number().int().nonnegative().default(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Category = z.infer<typeof CategorySchema>;

export const EntryScopeTargetSchema = z.object({
  scenarioId: IdSchema,
  /** null = 整个推演；否则只在这个节点及其后代可见（「走入某个分支才出现」） */
  fromNodeId: IdSchema.nullable().default(null),
  /** 登场条件（给导演看）。非空时条目作为「可能登场的预设」注入，直到某步把它标为 revealed */
  revealHint: z.string().trim().max(200).default(''),
});
export type EntryScopeTarget = z.infer<typeof EntryScopeTargetSchema>;

export const EntryScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('universal') }),
  z.object({ kind: z.literal('limited'), targets: z.array(EntryScopeTargetSchema).min(1) }),
]);
export type EntryScope = z.infer<typeof EntryScopeSchema>;

export const KnowledgeEntrySchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  categoryId: IdSchema,
  title: z.string().min(1).max(120),
  /** 别名/曾用名/绰号。反向提取时按 title ∪ aliases 做匹配，是去重的关键 */
  aliases: z.array(z.string().min(1)).default([]),
  /** 一句话摘要，注入 prompt 时优先用它以省 token */
  summary: z.string().default(''),
  /** 键对应所属分类的 fieldTemplate.key */
  fields: z.record(z.string(), z.string()).default({}),
  /** 是否每次生成都强制注入（世界观核心规则通常需要） */
  pinned: z.boolean().default(false),
  /** 溯源：该条目的信息来自哪些章节 */
  sourceChapterIds: z.array(IdSchema).default([]),
  /** 每次合并递增，用于冲突提示 */
  version: z.number().int().positive().default(1),
  /**
   * 作用范围。universal = 所有世界线可见（默认）；limited = 只在列出的推演里存在。
   * 挂推演而不是「世界线」：作者写条目时路径还不存在，能预先指定的只有推演与已存在的节点
   */
  scope: EntryScopeSchema.default(() => ({ kind: 'universal' as const })),
  /** 逐字段覆盖分类模板的可变性；没有的键用模板默认值 */
  fieldLocks: z.record(z.string(), FieldMutabilitySchema).default(() => ({})),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** 软删除，支持恢复 */
  deletedAt: TimestampSchema.nullable().default(null),
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

// ---------------------------------------------------------------- 大纲

export const OutlineStatusSchema = z.enum(['planned', 'drafting', 'done']);

export const OutlineNodeSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  /** null 表示顶层（卷或幕） */
  parentId: IdSchema.nullable().default(null),
  /** 同层排序值 */
  order: z.number().int().nonnegative().default(0),
  title: z.string().min(1).max(200),
  synopsis: z.string().default(''),
  targetWords: z.number().int().positive().nullable().default(null),
  status: OutlineStatusSchema.default('planned'),
  /** 写这一节点时默认注入的知识条目 */
  linkedEntryIds: z.array(IdSchema).default([]),
  /**
   * 沉淀溯源：这一章对应推演里的哪几步。只有章级节点会有；卷只是分组，存一份步骤列表
   * 只会和章的数据重复。「来自旧主线」由它现算，不另存标记
   */
  scenarioSource: z
    .object({ scenarioId: IdSchema, nodeIds: z.array(IdSchema) })
    .nullable()
    .default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type OutlineNode = z.infer<typeof OutlineNodeSchema>;

// ---------------------------------------------------------------- 章节

export const ChapterStatusSchema = z.enum(['draft', 'done']);
export const ChapterSourceSchema = z.enum(['ai', 'manual', 'imported']);

export const ChapterSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  outlineNodeId: IdSchema.nullable().default(null),
  /** 全书顺序，从 1 开始 */
  index: z.number().int().positive(),
  title: z.string().max(200).default(''),
  content: z.string().default(''),
  /**
   * 翻译前的原文。
   *
   * 翻译是不可逆的破坏性操作，而机器译文一定有需要回头核对原句的地方，
   * 所以原文必须留一份 —— 空串表示这一章没被翻译过。
   * 它不参与字数统计、不进 prompt，只作为可还原的底稿。
   */
  sourceContent: z.string().default(''),
  /** 原文语种，仅在 sourceContent 非空时有意义 */
  sourceLanguage: z.string().default(''),
  wordCount: z.number().int().nonnegative().default(0),
  status: ChapterStatusSchema.default('draft'),
  source: ChapterSourceSchema.default('manual'),
  /** null = 主线；否则为所属外传。外传章节的 index 在外传内部从 1 起 */
  sideStoryId: IdSchema.nullable().default(null),
  /**
   * 沉淀溯源，只允许外传章节非空：主线章节的溯源在大纲节点上，两处都有会不一致。
   * brief 是这一章的细纲 —— 外传不挂大纲树，逐章细纲只能挂在章节上
   */
  scenarioSource: z
    .object({
      scenarioId: IdSchema,
      nodeIds: z.array(IdSchema),
      brief: z.string().max(3000).default(''),
    })
    .nullable()
    .default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Chapter = z.infer<typeof ChapterSchema>;

// ---------------------------------------------------------------- 外传

/** 外传。一部一行，与 Novel.rollingSummary 同理把进展摘要放在自己身上 */
export const SideStorySchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  /** 不含「外传·」前缀；展示时统一拼成「外传·{title}」 */
  title: z.string().trim().min(1, '外传名称不能为空').max(40, '外传名称不能超过 40 字'),
  /** 讲什么、发生在主线的什么时候。会进外传章节的 prompt */
  synopsis: z.string().max(2000, '外传简介不能超过 2000 字').default(''),
  /** 外传自己的进展摘要，替代主线的 Novel.rollingSummary */
  rollingSummary: z.string().default(''),
  order: z.number().int().nonnegative().default(0),
  /** 由推演沉淀而来时记下分叉节点：分叉点及之前是与主线共用的前半段 */
  scenarioSource: z.object({ scenarioId: IdSchema, forkNodeId: IdSchema }).nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type SideStory = z.infer<typeof SideStorySchema>;

// ---------------------------------------------------------------- 写作规范

/**
 * 规范的作用范围。按任务组划分而不是直接存 TaskKind：同组任务对规范的需求一致，
 * 6 个开关在窄屏最多换一行。翻译刻意不在其中 —— 忠实优先，规范会诱导模型「修正」原文。
 * interactive（互动推演）追加在末尾：存储顺序即界面顺序，旧规范的数组前缀不变。
 */
export const WritingNormScopeSchema = z.enum([
  'writing',
  'planning',
  'summary',
  'extract',
  'check',
  'interactive',
]);
export type WritingNormScope = z.infer<typeof WritingNormScopeSchema>;

/**
 * 作品级写作规范：作者给本作定下的创作约束与项目说明。
 * 作者原文直接落库，不走提案管道（不是 AI 产出，见产品文档 5.1）。
 * content 不做 trim：存什么就是什么，渲染进 prompt 时才去首尾空白。
 *
 * 60 / 60000 写成字面量而不引用 writingNorm.ts 的常量：那个模块要从这里引类型，
 * 反向引用会形成循环依赖。两边同值由 writingNorm.test.ts 断言。
 */
export const WritingNormSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  title: z.string().trim().min(1, '规范标题不能为空').max(60, '规范标题不能超过 60 字'),
  content: z
    .string()
    .max(60_000, '单份规范不能超过 60000 字')
    .refine((value) => value.trim().length > 0, '规范正文不能为空'),
  enabled: z.boolean().default(true),
  // 默认六项全开（沿用「默认全开」约定）；与 ALL_NORM_SCOPES 同值由 writingNorm.test.ts 断言
  scopes: z
    .array(WritingNormScopeSchema)
    .default((): WritingNormScope[] => [
      'writing',
      'planning',
      'summary',
      'extract',
      'check',
      'interactive',
    ]),
  order: z.number().int().nonnegative().default(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type WritingNorm = z.infer<typeof WritingNormSchema>;

// ---------------------------------------------------------------- 互动推演

/**
 * 选项倾向。固定枚举而不是自由文本：自由标签很容易写成「（会被识破）」这种剧透，
 * 枚举在结构上就剧透不了。界面文案：谨慎 / 果断 / 迂回 / 对抗 / 合作 / 牺牲 / 欺骗 / 探索
 */
export const OPTION_TENDENCIES = [
  'cautious',
  'bold',
  'indirect',
  'confront',
  'cooperate',
  'sacrifice',
  'deceive',
  'explore',
] as const;
export type OptionTendency = (typeof OPTION_TENDENCIES)[number];

/**
 * 条目在世界线上的状态。revealed 是一次性的「揭示」，其余是「处境」；
 * restored 只清除之前的处境，不撤销揭示。
 * 界面文案：已登场 / 死亡 / 失踪 / 被俘 / 被毁 / 被封印 / 恢复如常
 */
export const ENTRY_STATUSES = [
  'revealed',
  'dead',
  'missing',
  'captured',
  'destroyed',
  'sealed',
  'restored',
] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** 主角状态的方面。界面文案：伤势 / 能力 / 持有物 / 关系 / 已知秘密 / 其他 */
export const OC_ASPECTS = ['injury', 'ability', 'item', 'relation', 'secret', 'other'] as const;
export type OcAspect = (typeof OC_ASPECTS)[number];

export const OptionRiskSchema = z.enum(['low', 'medium', 'high']);
export type OptionRisk = z.infer<typeof OptionRiskSchema>;

/**
 * 差异指向的条目：世界观条目，或某个祖先节点上产生的本线新条目。
 * 存 id 而不是名称：世界观条目会被改名、加别名，用名称存，改个名本线的改写就对不上了
 */
export const EntryRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('world'), entryId: IdSchema }),
  z.object({ kind: z.literal('line'), nodeId: IdSchema, localId: IdSchema }),
]);
export type EntryRef = z.infer<typeof EntryRefSchema>;

export const LineEntrySchema = z.object({
  localId: IdSchema,
  categoryId: IdSchema,
  title: z.string().trim().min(1).max(120),
  summary: z.string().max(200).default(''),
  fields: z.record(z.string(), z.string()).default(() => ({})),
  /** 非空 = 已提升为这条世界观条目；提升后本线条目成为它的别名 */
  promotedEntryId: IdSchema.nullable().default(null),
});
export type LineEntry = z.infer<typeof LineEntrySchema>;

/** 一步给这条世界线带来的变化。只在推演沙盒层，不改世界观条目 */
export const WorldlineDeltaSchema = z.object({
  /** 字段覆盖：只能改分类模板里的字段（fields.*），名称 / 别名 / 摘要不可改 */
  fieldOverrides: z
    .array(
      z.object({
        target: EntryRefSchema,
        fieldKey: z.string().min(1),
        value: z.string().min(1).max(1000),
      }),
    )
    .default(() => []),
  /** 只在本线存在的新条目。localId 由代码生成 */
  lineEntries: z.array(LineEntrySchema).default(() => []),
  statusChanges: z
    .array(
      z.object({
        target: EntryRefSchema,
        status: z.enum(ENTRY_STATUSES),
        note: z.string().max(80).default(''),
      }),
    )
    .default(() => []),
  ocChanges: z
    .array(
      z.object({
        castId: IdSchema,
        aspect: z.enum(OC_ASPECTS),
        op: z.enum(['add', 'remove']),
        text: z.string().trim().min(1).max(80),
      }),
    )
    .default(() => []),
  /** 事件记录：只追加，给模型回顾与将来的「原作事件表」对照用 */
  events: z.array(z.string().trim().min(1).max(80)).default(() => []),
  /** 标记：键值，后写覆盖先写 */
  flags: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(30),
        value: z.string().trim().min(1).max(60),
      }),
    )
    .default(() => []),
});
export type WorldlineDelta = z.infer<typeof WorldlineDeltaSchema>;

/** 空差异。default 用工厂函数而不是共享这个对象：落库前会被追加内容，共享引用会串到别的节点 */
export function emptyDelta(): WorldlineDelta {
  return {
    fieldOverrides: [],
    lineEntries: [],
    statusChanges: [],
    ocChanges: [],
    events: [],
    flags: [],
  };
}
export const EMPTY_DELTA: Readonly<WorldlineDelta> = Object.freeze(emptyDelta());

export const DeltaNoticeKindSchema = z.enum([
  'locked-field',
  'unknown-entry',
  'unknown-field',
  'unknown-category',
  'duplicate-entry',
  'rule-status',
  'unknown-goal',
  'unknown-milestone',
  'duplicate-option',
]);
export type DeltaNoticeKind = z.infer<typeof DeltaNoticeKindSchema>;

/** 生成或编辑时被丢弃的内容，给作者看（产品文档 5.2 的「可见地提示」） */
export const DeltaNoticeSchema = z.object({
  kind: DeltaNoticeKindSchema,
  message: z.string(),
});
export type DeltaNotice = z.infer<typeof DeltaNoticeSchema>;

export const ScenarioGoalKindSchema = z.enum(['good', 'bad', 'neutral']);
export type ScenarioGoalKind = z.infer<typeof ScenarioGoalKindSchema>;

export const ScenarioGoalSchema = z.object({
  id: IdSchema,
  kind: ScenarioGoalKindSchema,
  description: z
    .string()
    .trim()
    .min(1, MSG.goalDescriptionRequired)
    .max(LIMITS.goalDescription, MSG.goalDescriptionTooLong),
});
export type ScenarioGoal = z.infer<typeof ScenarioGoalSchema>;

export const ScenarioMilestoneSchema = z.object({
  id: IdSchema,
  description: z
    .string()
    .trim()
    .min(1, MSG.milestoneRequired)
    .max(LIMITS.milestoneDescription, MSG.milestoneTooLong),
});
export type ScenarioMilestone = z.infer<typeof ScenarioMilestoneSchema>;

export const ScenarioSetupSchema = z.object({
  /** 第一期只能 1 人；数组是为第二期多 OC 留口，放开 max 即可，数据不用迁移 */
  cast: z
    .array(z.object({ id: IdSchema, entryId: IdSchema }))
    .min(1)
    .max(1),
  start: z.object({
    time: z.string().trim().max(LIMITS.time, MSG.timeTooLong).default(''),
    place: z.string().trim().max(LIMITS.place, MSG.placeTooLong).default(''),
    situation: z
      .string()
      .trim()
      .min(1, MSG.situationRequired)
      .max(LIMITS.situation, MSG.situationTooLong),
  }),
  goals: z.array(ScenarioGoalSchema).min(1, MSG.goalsRequired).max(LIMITS.goals, MSG.goalsTooMany),
  milestones: z
    .array(ScenarioMilestoneSchema)
    .max(LIMITS.milestones, MSG.milestonesTooMany)
    .default(() => []),
  tone: z.string().trim().max(LIMITS.tone, MSG.toneTooLong).default(''),
  expectedSteps: z
    .number()
    .int()
    .min(LIMITS.minSteps)
    .max(LIMITS.maxSteps)
    .default(LIMITS.defaultSteps),
});
export type ScenarioSetup = z.infer<typeof ScenarioSetupSchema>;

export const ScenarioSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  title: z.string().trim().min(1, MSG.titleRequired).max(LIMITS.title, MSG.titleTooLong),
  setup: ScenarioSetupSchema,
  /** 主线 = 根到它的路径。每次推进在同一事务里改成新节点；只查看不改 */
  mainNodeId: IdSchema.nullable().default(null),
  /** 断点续玩：上次停在哪个节点。跳转只改它 */
  cursorNodeId: IdSchema.nullable().default(null),
  lastAdvancedAt: TimestampSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** 怎么走到这一步。text 存一份原文：选项文字永不改，但节点详情要能独立显示 */
export const ArrivedBySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }),
  z.object({ kind: z.literal('option'), optionId: IdSchema, text: z.string() }),
  z.object({
    kind: z.literal('free'),
    text: z
      .string()
      .trim()
      .min(1, MSG.freeActionRequired)
      .max(LIMITS.freeAction, MSG.freeActionTooLong),
  }),
  z.object({
    kind: z.literal('wrap-up'),
    goalId: IdSchema.nullable(),
    note: z.string().max(LIMITS.wrapUpNote),
  }),
]);
export type ArrivedBy = z.infer<typeof ArrivedBySchema>;

export const ScenarioOptionSchema = z.object({
  id: IdSchema,
  text: z.string().trim().min(2).max(60),
  tendency: z.enum(OPTION_TENDENCIES),
  risk: OptionRiskSchema,
  /** 0 = 首次生成；1、2… = 「再给几个选项」追加的批次 */
  batch: z.number().int().nonnegative().default(0),
});
export type ScenarioOption = z.infer<typeof ScenarioOptionSchema>;

export const ScenarioEndingSchema = z.object({
  kind: ScenarioGoalKindSchema,
  goalId: IdSchema.nullable(),
  title: z.string().trim().min(1).max(30),
  cause: z.string().trim().min(1).max(120),
});
export type ScenarioEnding = z.infer<typeof ScenarioEndingSchema>;

export const ScenarioPathSummarySchema = z.object({
  text: z.string().max(2000),
  openThreads: z.array(z.string().max(120)).max(8),
});
export type ScenarioPathSummary = z.infer<typeof ScenarioPathSummarySchema>;

/** 每个节点最多的选项数（首次 + 「再给几个选项」追加） */
export const MAX_SCENARIO_OPTIONS = 8;

export const ScenarioNodeSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  scenarioId: IdSchema,
  /** null = 根（开局）。每个推演恰好一个根 */
  parentId: IdSchema.nullable(),
  /** 根为 0；= 父节点 depth + 1。界面上的「第 k 步」= depth + 1 */
  depth: z.number().int().nonnegative(),
  arrivedBy: ArrivedBySchema,
  plot: z
    .string()
    .refine((v) => v.trim().length > 0, '情节不能为空')
    .refine((v) => v.length <= 6000, '情节过长'),
  challenge: z.string().max(300).default(''),
  options: z
    .array(ScenarioOptionSchema)
    .max(MAX_SCENARIO_OPTIONS)
    .default(() => []),
  delta: WorldlineDeltaSchema.default(emptyDelta),
  /** 生成或编辑时被丢弃的内容，给作者看 */
  notices: z.array(DeltaNoticeSchema).default(() => []),
  progress: z
    .object({
      reachedMilestoneIds: z.array(IdSchema).default(() => []),
      note: z.string().max(120).default(''),
    })
    .default(() => ({ reachedMilestoneIds: [], note: '' })),
  ending: ScenarioEndingSchema.nullable().default(null),
  /** 检查点摘要：根到本节点的前情。只有检查点节点（depth % 5 === 4）会有 */
  pathSummary: ScenarioPathSummarySchema.nullable().default(null),
  /** 差异最后一次被作者编辑的时间；后代 createdAt 早于它时提示「生成时依据的是旧事实」 */
  deltaEditedAt: TimestampSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ScenarioNode = z.infer<typeof ScenarioNodeSchema>;

/**
 * 章节摘要 —— 摘要链的载体，长篇连贯性全靠它。
 * openThreads 记录未收束的伏笔，是防止后期「忘了埋过的坑」的核心字段。
 */
export const ChapterSummarySchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  chapterId: IdSchema,
  summary: z.string().default(''),
  keyEvents: z.array(z.string()).default([]),
  appearingEntryIds: z.array(IdSchema).default([]),
  openThreads: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>;

// ---------------------------------------------------------------- 风格档案

export const TraditionSchema = z.enum(['web', 'literary', 'genre']);
export type Tradition = z.infer<typeof TraditionSchema>;

export const MethodologySchema = z.enum([
  'web-rhythm', // 网文节奏：黄金三章 + 单元副本 + 阶段爆点
  'three-act', // 三幕式
  'snowflake', // 雪花法
  'hero-journey', // 英雄之旅
  'qichengzhuanhe', // 起承转合 / 章回体
]);
export type Methodology = z.infer<typeof MethodologySchema>;

/**
 * 风格特征描述。刻意做成一组可读、可编辑的文字维度，而不是「模仿某部作品」：
 * 既让用户看得懂能改，也避免把原文塞进 prompt。
 */
export const RubricSchema = z.object({
  sentenceRhythm: z.string().default(''),
  imagery: z.string().default(''),
  narrativeDistance: z.string().default(''),
  dialogue: z.string().default(''),
  rhetoric: z.string().default(''),
  lexicon: z.string().default(''),
  /** 明确要避免的写法 */
  avoid: z.string().default(''),
});
export type Rubric = z.infer<typeof RubricSchema>;

export const VoiceReferenceSchema = z.object({
  /** 内置风格库的 key，或自定义档案的 id */
  refId: z.string().min(1),
  name: z.string().min(1),
  /** 模仿强度 0-100 */
  weight: z.number().int().min(0).max(100).default(60),
});
export type VoiceReference = z.infer<typeof VoiceReferenceSchema>;

export const StyleProfileSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  tradition: TraditionSchema.default('web'),
  /** 子类：都市/玄幻/仙侠/推理…… 自由文本以便扩展 */
  subGenre: z.string().max(40).default(''),
  methodology: MethodologySchema.default('three-act'),
  /** 最多两位，超过会让文风互相打架 */
  voiceRefs: z.array(VoiceReferenceSchema).max(2).default([]),
  /** 用户自定义 rubric（文风取样的产物），与 voiceRefs 叠加 */
  customRubric: RubricSchema.nullable().default(null),
  /** 用户补充的硬性写作要求，原样进 prompt */
  extraInstruction: z.string().max(2000).default(''),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

// ---------------------------------------------------------------- Proposal 确认管道

export const ProposalOriginSchema = z.enum([
  'generate', // 立项 / 大纲扩写 / 章节生成
  'extract', // 从旧稿反向提取
  'refine', // 改写 / 摘要 / 风格提炼
]);
export const ProposalTargetSchema = z.enum([
  'novel',
  'knowledgeEntry',
  'outlineNode',
  /**
   * 整棵大纲树。树的父子关系无法在逐节点确认时表达（子节点的 parentId
   * 依赖父节点先落库），且大纲本身需要整体通读，因此作为一个提案处理，
   * 内容以缩进标题文本承载。
   */
  'outlineTree',
  'chapter',
  'chapterSummary',
  'styleProfile',
  /** 外传自己的进展摘要（SideStory.rollingSummary） */
  'sideStory',
  /**
   * 互动推演的一段路径沉淀成的大纲（主线：卷 / 章；外传：外传 + 章节）。
   * 与 outlineTree 同理整段一个提案，内容是可编辑的缩进标题文本
   */
  'scenarioOutline',
]);
export const ProposalActionSchema = z.enum(['create', 'merge', 'replace']);
export const ProposalStatusSchema = z.enum(['pending', 'accepted', 'rejected']);
export const DiffKindSchema = z.enum(['added', 'changed', 'removed', 'unchanged']);

export type ProposalOrigin = z.infer<typeof ProposalOriginSchema>;
export type ProposalTarget = z.infer<typeof ProposalTargetSchema>;
export type ProposalAction = z.infer<typeof ProposalActionSchema>;
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;
export type DiffKind = z.infer<typeof DiffKindSchema>;

export const FieldDiffSchema = z.object({
  field: z.string(),
  label: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  kind: DiffKindSchema,
});
export type FieldDiff = z.infer<typeof FieldDiffSchema>;

export const ProposalSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  /** 同一次生成产生的多条 Proposal 共享 batchId，便于「全部采用」 */
  batchId: IdSchema.nullable().default(null),
  /**
   * 批次内的展示顺序。
   * 同一批提案往往在同一毫秒创建，仅靠 createdAt 排序结果不确定，
   * 会导致用户每次看到的顺序都不一样（大纲可能排在世界观前面）。
   */
  order: z.number().int().nonnegative().default(0),
  origin: ProposalOriginSchema,
  target: ProposalTargetSchema,
  action: ProposalActionSchema,
  /** merge / replace 时指向被改动的实体 */
  targetId: IdSchema.nullable().default(null),
  /** 给用户看的标签，如「人物 · 林越」 */
  label: z.string().default(''),
  /** 待落库的实体数据（结构由 target 决定） */
  payload: z.unknown(),
  diff: z.array(FieldDiffSchema).default([]),
  /** 溯源，如「第 3 章」 */
  sourceRef: z.string().default(''),
  status: ProposalStatusSchema.default('pending'),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable().default(null),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// ---------------------------------------------------------------- 写作计划

export const PlanModeSchema = z.enum(['chaptersPerDay', 'wordsPerDay', 'chaptersPerWeek']);

export const WritingPlanSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  mode: PlanModeSchema.default('chaptersPerDay'),
  /** 目标值：章数或字数，随 mode 变化 */
  target: z.number().int().positive().default(1),
  /** 生效的星期，0 = 周日；chaptersPerWeek 模式下忽略 */
  activeWeekdays: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
  startDate: LocalDateSchema,
  enabled: z.boolean().default(true),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type WritingPlan = z.infer<typeof WritingPlanSchema>;

export const DailyLogSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  date: LocalDateSchema,
  words: z.number().int().nonnegative().default(0),
  chaptersCompleted: z.number().int().nonnegative().default(0),
  updatedAt: TimestampSchema,
});
export type DailyLog = z.infer<typeof DailyLogSchema>;

// ---------------------------------------------------------------- 旧稿导入任务

export const ImportChapterStatusSchema = z.enum(['pending', 'done', 'failed']);

/**
 * 这一章的翻译状态。
 * `none` 同时表示「本来就是中文」与「用户取消了勾选」—— 两者对流程的影响一样。
 */
export const ImportTranslateStatusSchema = z.enum(['none', 'pending', 'done', 'failed']);

export const ImportChapterStateSchema = z.object({
  /** 在本次导入中的序号 */
  index: z.number().int().positive(),
  title: z.string().default(''),
  /** 已落库的章节 id */
  chapterId: IdSchema,
  status: ImportChapterStatusSchema.default('pending'),
  error: z.string().default(''),
  translateStatus: ImportTranslateStatusSchema.default('none'),
  translateError: z.string().default(''),
});
export type ImportChapterState = z.infer<typeof ImportChapterStateSchema>;

/** 选目的地之前的分章草稿：正文、翻译状态与原文都在这里，不落 Chapter */
export const ImportDraftSchema = z.object({
  /** 本批序号（分章页的「第 N 章」） */
  index: z.number().int().positive(),
  title: z.string().default(''),
  /** 当前正文：译完即为译文 */
  content: z.string(),
  /** 译前原文；空串 = 没译过 */
  sourceContent: z.string().default(''),
  sourceLanguage: z.string().default(''),
  translateStatus: ImportTranslateStatusSchema.default('none'),
  translateError: z.string().default(''),
});
export type ImportDraft = z.infer<typeof ImportDraftSchema>;

/** 这一批稿件导入到哪里。null（见 ImportJob.destination）= 还没选 */
export const ImportDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }),
  z.object({ kind: z.literal('side'), sideStoryId: IdSchema }),
  z.object({ kind: z.literal('worldview') }),
]);
export type ImportDestination = z.infer<typeof ImportDestinationSchema>;

/**
 * 世界观导入的一段设定文本。
 *
 * 设定文本不落成章节（否则会出现在章节列表、字数统计与备份里），
 * 所以切好的段落连同提取进度直接存在任务上，断点续跑不依赖重新切分。
 */
export const ImportWorldviewChunkSchema = z.object({
  /** 在本次导入中的段序号 */
  index: z.number().int().positive(),
  /** 覆盖的章节标题，用作段标签；空串 = 没有标题（旧任务或「整篇作为一章」） */
  title: z.string().default(''),
  content: z.string(),
  status: ImportChapterStatusSchema.default('pending'),
  error: z.string().default(''),
});
export type ImportWorldviewChunk = z.infer<typeof ImportWorldviewChunkSchema>;

/**
 * 跨章节累计的条目草稿。
 *
 * 同一个人物会在十几章里反复出现，若每章都生成一条提案，用户要处理上百条重复项。
 * 因此提取过程中先在任务里按名称累计合并，全部跑完后才一次性materialize 成提案。
 */
export const ImportEntryDraftSchema = z.object({
  /** 归一化后的名称，作为累计合并的键 */
  key: z.string().min(1),
  categoryId: IdSchema,
  title: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  summary: z.string().default(''),
  fields: z.record(z.string(), z.string()).default({}),
  /** 在哪些章节出现过，用于溯源 */
  sourceChapterIds: z.array(IdSchema).default([]),
});
export type ImportEntryDraft = z.infer<typeof ImportEntryDraftSchema>;

/** 译名对照。文学翻译里人名跑风最刺眼，所以要跨章累计并强制沿用 */
export const GlossaryEntrySchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
});
export type GlossaryEntryData = z.infer<typeof GlossaryEntrySchema>;

/**
 * 作品级译名表，一书一份。
 *
 * **刻意不挂在导入任务上。** 任务是临时的（只为断点续跑而存在，跑完就删），
 * 而「Ashford 译作阿什福德」是这部作品的永久事实 —— 第二批英文素材进来时
 * 必须沿用同一个译法，否则同一个人在不同批次里会有两个名字。
 */
export const GlossarySchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  terms: z.array(GlossaryEntrySchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Glossary = z.infer<typeof GlossarySchema>;

export const ImportJobStatusSchema = z.enum(['running', 'paused', 'done']);

export const ImportJobObjectSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  /**
   * 本次导入产出的所有提案共用的批次号。
   *
   * 章节摘要提案是逐章即时创建的，条目提案要等全部跑完才能合并出来，
   * 两者相隔十几分钟。共用一个批次号，用户才能在一个收件箱里「全部采用」，
   * 而不是摘要在页面上、条目在面板里分成两摊。
   */
  batchId: z.string().default(''),
  /**
   * 导入目的地；null = 还没选（草稿阶段）。
   * 阶段与 drafts / chapters / worldviewChunks 的对应关系不靠 schema 强制，
   * 由仓储的 saveImportDrafts / commitImportChapters / commitImportWorldview 保证。
   */
  destination: ImportDestinationSchema.nullable().default(null),
  /** 选目的地之前的分章草稿；只在 destination 为 null 时非空 */
  drafts: z.array(ImportDraftSchema).default([]),
  /** 世界观模式下切好的设定段落与逐段进度；章节模式恒为空 */
  worldviewChunks: z.array(ImportWorldviewChunkSchema).default([]),
  chapters: z.array(ImportChapterStateSchema).default([]),
  entryDrafts: z.array(ImportEntryDraftSchema).default([]),
  /** 跨章节累计的未收束伏笔，随提取推进更新 */
  openThreads: z.array(z.string()).default([]),
  /** 随提取推进的全书进展摘要 */
  rollingSummary: z.string().default(''),
  /** 是否同时为每章生成摘要 */
  withSummaries: z.boolean().default(true),
  /**
   * 是否在收尾时顺带从稿件归纳文风。
   *
   * 默认开：存量作者已经写了几十万字，他的文风就在稿子里，
   * 再要求他从零挑一遍名家风格和七个维度的描述是没有道理的。
   * 做成可关的是因为它要多花一次调用 —— 只是一次，但钱是用户的。
   */
  withStyle: z.boolean().default(true),
  status: ImportJobStatusSchema.default('paused'),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/**
 * 导入任务。parse 前先经 upgradeLegacyImportJob 换算旧形状（importType / worldviewText 时代的行），
 * 与 Dexie v5 的 upgrade 共用同一套规则 —— 旧备份文件里的进行中任务也走这一套。
 */
export const ImportJobSchema = z.preprocess(upgradeLegacyImportJob, ImportJobObjectSchema);
export type ImportJob = z.infer<typeof ImportJobSchema>;

// ---------------------------------------------------------------- 备份快照

/**
 * 全量数据快照。
 *
 * 刻意逐表列出而不是写成 `Record<string, unknown[]>`：备份文件是**外部输入**，
 * 用户会手动编辑、跨版本导入、甚至拿错文件，落库前必须逐条过 Zod。
 * 一个宽松的 schema 等于把损坏的数据直接灌进库里。
 *
 * **不包含 `LLMSettings`** —— 它带 API Key，备份文件会被丢进网盘、
 * 发给自己、传到聊天软件里，密钥绝不能跟着走。
 */
export const RepositorySnapshotSchema = z
  .object({
    novels: z.array(NovelSchema).default([]),
    categories: z.array(CategorySchema).default([]),
    entries: z.array(KnowledgeEntrySchema).default([]),
    outlineNodes: z.array(OutlineNodeSchema).default([]),
    chapters: z.array(ChapterSchema).default([]),
    chapterSummaries: z.array(ChapterSummarySchema).default([]),
    styleProfiles: z.array(StyleProfileSchema).default([]),
    proposals: z.array(ProposalSchema).default([]),
    plans: z.array(WritingPlanSchema).default([]),
    dailyLogs: z.array(DailyLogSchema).default([]),
    importJobs: z.array(ImportJobSchema).default([]),
    glossaries: z.array(GlossarySchema).default([]),
    sideStories: z.array(SideStorySchema).default([]),
    /**
     * 缺省为空：v1 / v2 备份没有这一项。不校验 novelId 指向快照内的作品 ——
     * 其他表也不做这项检查，孤儿规范查不到、也不会被注入
     */
    writingNorms: z.array(WritingNormSchema).default([]),
    /** 缺省为空：v1–v3 备份没有互动推演 */
    scenarios: z.array(ScenarioSchema).default([]),
    scenarioNodes: z.array(ScenarioNodeSchema).default([]),
  })
  /**
   * 外传章节的不变量与仓储一致（见 createChapter / updateChapter）。
   * 备份是唯一能绕过仓储写入的入口，所以在入口处再验一遍。
   */
  .superRefine((snapshot, ctx) => {
    const sideStories = new Map(snapshot.sideStories.map((story) => [story.id, story]));
    snapshot.chapters.forEach((chapter, i) => {
      if (chapter.sideStoryId === null) return;
      const story = sideStories.get(chapter.sideStoryId);
      if (!story) {
        ctx.addIssue({
          code: 'custom',
          path: ['chapters', i, 'sideStoryId'],
          message: '找不到所属外传',
        });
        return;
      }
      if (story.novelId !== chapter.novelId) {
        ctx.addIssue({
          code: 'custom',
          path: ['chapters', i, 'sideStoryId'],
          message: '所属外传不属于这部作品',
        });
        return;
      }
      if (chapter.outlineNodeId !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['chapters', i, 'outlineNodeId'],
          message: '外传章节不能关联大纲节点',
        });
      }
    });
    checkScenarioTrees(snapshot, ctx);
  });
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;

/**
 * 推演树的完整性（设计 §4.2 规则 1–10）。树的不变量平时由仓储 appendScenarioNode 在事务里守，
 * 备份绕过仓储，只能在这里整份校验 —— 一棵坏树进了库，推演页、主线、沉淀都会算错。
 * 深度逐层递增（规则 3）保证了无环。不检查限定条目的 targets 是否指向存在的推演：
 * 推演删除后限定条目留作孤儿是合法状态，它只是在任何推演里都不可见
 */
function checkScenarioTrees(
  snapshot: {
    scenarios: Scenario[];
    scenarioNodes: ScenarioNode[];
    entries: KnowledgeEntry[];
    outlineNodes: OutlineNode[];
    chapters: Chapter[];
    sideStories: SideStory[];
  },
  ctx: z.RefinementCtx,
): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const scenarios = new Map(snapshot.scenarios.map((scenario) => [scenario.id, scenario]));
  const nodes = new Map(snapshot.scenarioNodes.map((node) => [node.id, node]));
  const roots = new Set<string>();
  const childKeys = new Set<string>();

  snapshot.scenarioNodes.forEach((node, i) => {
    // 规则 1
    const scenario = scenarios.get(node.scenarioId);
    if (!scenario) return issue(['scenarioNodes', i, 'scenarioId'], '找不到所属推演');
    if (scenario.novelId !== node.novelId) {
      return issue(['scenarioNodes', i, 'scenarioId'], '所属推演不属于这部作品');
    }
    if (node.parentId === null) {
      // 规则 2、3（根）
      if (roots.has(node.scenarioId))
        issue(['scenarioNodes', i, 'parentId'], '一个推演只能有一个开局');
      roots.add(node.scenarioId);
      if (node.arrivedBy.kind !== 'start')
        issue(['scenarioNodes', i, 'arrivedBy'], '开局节点的来由必须是开局');
      if (node.depth !== 0) issue(['scenarioNodes', i, 'depth'], '层级不连续');
      return;
    }
    if (node.arrivedBy.kind === 'start') {
      issue(['scenarioNodes', i, 'parentId'], '一个推演只能有一个开局');
      return;
    }
    // 规则 3
    const parent = nodes.get(node.parentId);
    if (!parent) return issue(['scenarioNodes', i, 'parentId'], '找不到父节点');
    if (parent.scenarioId !== node.scenarioId) {
      return issue(['scenarioNodes', i, 'parentId'], '父节点不在同一推演');
    }
    if (node.depth !== parent.depth + 1)
      return issue(['scenarioNodes', i, 'parentId'], '层级不连续');
    // 规则 4
    const by = node.arrivedBy;
    if (by.kind === 'option' && !parent.options.some((option) => option.id === by.optionId)) {
      issue(['scenarioNodes', i, 'arrivedBy'], '父节点上没有这个选项');
    }
    // 规则 5
    if (parent.ending !== null) issue(['scenarioNodes', i, 'parentId'], '结局之后不能再有节点');
    // 规则 10：同一父节点下，同一选项 / 规范化后同一自由输入 / 收尾各至多一个子节点
    const key = `${parent.id}\u0000${arrivalKey(by)}`;
    if (childKeys.has(key)) issue(['scenarioNodes', i, 'arrivedBy'], '同一个选择出现了两次');
    childKeys.add(key);
  });

  const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  snapshot.scenarios.forEach((scenario, i) => {
    // 规则 6
    const own = (id: string | null) => id === null || nodes.get(id)?.scenarioId === scenario.id;
    if (!own(scenario.mainNodeId))
      issue(['scenarios', i, 'mainNodeId'], '主线指向的步骤不属于这个推演');
    if (!own(scenario.cursorNodeId)) {
      issue(['scenarios', i, 'cursorNodeId'], '落点指向的步骤不属于这个推演');
    }
    if (scenario.mainNodeId === null && roots.has(scenario.id)) {
      issue(['scenarios', i, 'mainNodeId'], '有步骤的推演必须有主线');
    }
    // 规则 7：主角条目必须在（含软删除的）
    scenario.setup.cast.forEach((member, j) => {
      const entry = entries.get(member.entryId);
      if (!entry || entry.novelId !== scenario.novelId) {
        issue(['scenarios', i, 'setup', 'cast', j, 'entryId'], '找不到主角条目');
      }
    });
  });

  const ownScenario = (scenarioId: string, novelId: string) => {
    const scenario = scenarios.get(scenarioId);
    return scenario !== undefined && scenario.novelId === novelId;
  };
  const inScenario = (nodeId: string, scenarioId: string) =>
    nodes.get(nodeId)?.scenarioId === scenarioId;
  // 规则 8
  snapshot.sideStories.forEach((story, i) => {
    const source = story.scenarioSource;
    if (!source) return;
    if (
      !ownScenario(source.scenarioId, story.novelId) ||
      !inScenario(source.forkNodeId, source.scenarioId)
    ) {
      issue(['sideStories', i, 'scenarioSource'], '外传指向的分叉节点不存在');
    }
  });
  // 规则 9
  snapshot.outlineNodes.forEach((node, i) => {
    const source = node.scenarioSource;
    if (!source) return;
    if (
      !ownScenario(source.scenarioId, node.novelId) ||
      !source.nodeIds.every((id) => inScenario(id, source.scenarioId))
    ) {
      issue(['outlineNodes', i, 'scenarioSource'], '来源步骤不属于这个推演');
    }
  });
  snapshot.chapters.forEach((chapter, i) => {
    const source = chapter.scenarioSource;
    if (!source) return;
    if (chapter.sideStoryId === null) {
      issue(['chapters', i, 'scenarioSource'], '主线章节不能直接关联推演');
      return;
    }
    if (
      !ownScenario(source.scenarioId, chapter.novelId) ||
      !source.nodeIds.every((id) => inScenario(id, source.scenarioId))
    ) {
      issue(['chapters', i, 'scenarioSource'], '来源步骤不属于这个推演');
    }
  });
}

// ---------------------------------------------------------------- 聚合视图

/** 书架卡片所需的统计信息，由仓储聚合计算而非冗余存储 */
export interface NovelStats {
  /** 只算主线 */
  chapterCount: number;
  /** 只算主线 */
  doneChapterCount: number;
  /** 外传章数（所有外传合计） */
  sideChapterCount: number;
  /** 全部章节，含外传 */
  wordCount: number;
  entryCount: number;
  pendingProposalCount: number;
}

export interface ShelfItem {
  novel: Novel;
  stats: NovelStats;
}
