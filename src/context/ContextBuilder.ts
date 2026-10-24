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

/**
 * 上下文构建接口 —— 阶段一（摘要链）→ 阶段三（RAG）的替换边界。
 *
 * 写作功能只依赖这个接口。阶段三接入向量检索时，只需另写一个实现来决定
 * 「哪些内容值得注入」，prompt 的组装顺序与预算规则不必重写。
 */

export interface ContextRequest {
  novel: Novel;
  style: StyleProfile;
  categories: Category[];
  entries: KnowledgeEntry[];
  outline: OutlineNode[];
  chapters: Chapter[];
  summaries: ChapterSummary[];
  /** 要写的大纲节点 */
  targetNodeId: string | null;
  /** 正在写的章节；用于确定「上一章」是哪一章 */
  targetChapterId: string | null;
  /**
   * 用户勾选要注入的知识条目。
   * 不传表示采用默认预选（pinned ∪ 节点关联 ∪ 上一章出场）。
   */
  selectedEntryIds?: string[];
  /** 注入最近多少章的摘要 */
  recentSummaryCount?: number;
  /** token 预算 */
  budget?: number;
  /**
   * 作品的全部外传。目标章节是外传章节时，从这里取说明块与外传进展；
   * 「是不是外传」只看目标章节的 sideStoryId，不看这里有没有传。
   */
  sideStories?: SideStory[];
  /** 外传章节是否附带主线进展（仅供参考）。默认 false；主线章节忽略 */
  includeMainProgress?: boolean;
  /** 作品的全部写作规范；构建器只取启用且作用范围含「写正文」的。不传等同于没有规范 */
  writingNorms?: WritingNorm[];
  /** 本次临时不注入的规范 id（生成面板里取消勾选），不影响库里的启用状态 */
  excludedNormIds?: string[];
  /**
   * 由推演沉淀而来的章节的推演材料（设计 D7.3，调用方预先算好）。只有整章生成会传：
   * 段落加工等面板拿到的共享 context 不含它。不传时构建结果与没有这个字段时逐字节相同
   */
  scenarioContext?: ScenarioChapterContext;
}

/**
 * 「写这一章」的推演材料：四段文字 + 两项默认预选的补充（design-addendum 第 2 条）。
 * 四段文字已带各自的【标题】；空串的段不渲染、不进清单
 */
export interface ScenarioChapterContext {
  /** 【本章依据的互动推演】在清单里的标签：「互动推演 · 第 a–b 步原文」 */
  label: string;
  /** 【本章涉及的推演专属设定】；没有限定条目时为空串 */
  limitedText: string;
  /** 「推演专属设定（主角『X』等 n 条）」 */
  limitedLabel: string;
  /** 【分叉之前的经过】；只有外传章节非空 */
  forkText: string;
  /** 【本章依据的互动推演】 */
  stepsText: string;
  /** 【这条世界线在本章开始时的状态】；没有任何变化时为空串 */
  stateText: string;
  /**
   * 主角是通用条目时的 id：并入默认预选的显式档。外传章节没有大纲节点、外传简介也不一定提到主角，
   * 不并进去的话通用主角的档案进不了「写这一章」
   */
  castEntryIds: string[];
  /** 追加进默认预选名称匹配的文字（本章步骤原文 + 外传章节细纲） */
  hintText: string;
}

export type ContextItemKind =
  | 'meta'
  | 'style'
  | 'norm'
  | 'pinned'
  | 'entry'
  | 'outline'
  | 'rolling'
  | 'summary'
  | 'tail'
  | 'sideStory'
  | 'scenario';

/** 注入清单的一项，用于向用户展示「这次依据了什么」 */
export interface ContextItem {
  kind: ContextItemKind;
  /** 知识条目用条目 id，其余用固定标识 */
  id: string;
  label: string;
  tokens: number;
  /** 是否真的进了 prompt */
  included: boolean;
  /** 未被包含的原因 */
  droppedReason?: string;
}

export interface BuiltContext {
  /**
   * 稳定前缀：同一本书在多次生成之间尽量不变，放在 prompt 最前面以命中缓存。
   * 顺序为「最不易变 → 较易变」，让公共前缀尽可能长。
   */
  stablePrefix: string;
  /** 易变部分：随章节推进而变化 */
  volatileSuffix: string;
  items: ContextItem[];
  estimatedTokens: number;
  /** 默认预选的条目 id，供界面初始化勾选状态 */
  defaultEntryIds: string[];
  /** 上一章（用于提示用户衔接对象），没有则为 undefined */
  previousChapter?: Chapter;
}

export interface ContextBuilder {
  build(request: ContextRequest): BuiltContext;
}

/** 默认预算。DeepSeek 上下文有 1M，这里的约束是成本与模型注意力，不是窗口 */
export const DEFAULT_CONTEXT_BUDGET = 24_000;
export const DEFAULT_RECENT_SUMMARY_COUNT = 3;
/** 上一章结尾原文注入的字数，用于保证语气衔接 */
export const TAIL_EXCERPT_CHARS = 700;
/**
 * 默认预选里「推断」来源的数量上限。
 *
 * 作者亲手关联的条目不受此限；这个上限只约束按名称匹配猜出来的那些。
 * 一个用常见词做别名的条目会命中大量文本，不设上限会把几十条无关设定
 * 拉进 prompt —— 那既贵又稀释注意力。8 条大致是一章里真正登场的角色数量级。
 */
export const MAX_INFERRED_ENTRIES = 8;
