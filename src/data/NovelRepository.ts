/**
 * 数据访问接口 —— 阶段一 → 阶段二（云同步）的替换边界。
 *
 * 业务代码只依赖这个接口，不直接接触 Dexie 或任何存储实现。
 * 阶段二接入 Supabase 时，只需另写一个实现类并在 Provider 处替换，
 * 上层功能代码不改动。
 *
 * 约定：
 * - 所有写入方法内部负责维护 updatedAt，并对入参做 Zod 校验；
 * - 列表方法默认过滤软删除数据，需要时通过 options 显式包含；
 * - patch 类型用 Partial，未提供的字段保持原值。
 */
import type {
  Category,
  Chapter,
  ChapterSummary,
  DailyLog,
  Glossary,
  GlossaryEntryData,
  ImportDraft,
  ImportJob,
  ImportWorldviewChunk,
  KnowledgeEntry,
  Novel,
  NovelDraft,
  NovelStats,
  OutlineNode,
  Proposal,
  RepositorySnapshot,
  Scenario,
  ScenarioNode,
  ScenarioOption,
  ScenarioSetup,
  ShelfItem,
  SideStory,
  StyleProfile,
  WorldlineDelta,
  WritingNorm,
  WritingNormScope,
  WritingPlan,
} from '@/domain/schema';
import type { ScenarioOutlinePlan } from '@/domain/scenario';

export interface EntryQuery {
  categoryId?: string;
  /** 在 title、aliases、summary 与字段值中做子串匹配 */
  search?: string;
  includeDeleted?: boolean;
  pinnedOnly?: boolean;
  /**
   * 'worldview'（默认）：只返回作用范围为通用的条目 —— 现有写作链路看到的就是它，
   * 限定到推演的条目不会泄漏进去；新增的调用点不传参也不会泄漏（失败关闭）。
   * 'all'：含限定条目，给知识库页、回收站、收件箱、推演用
   */
  scope?: 'worldview' | 'all';
}

/** 与 createEntry / updateEntry 现有参数类型相同的别名（只为 promoteLineEntry 的签名可读） */
export type EntryCreateInput = Pick<KnowledgeEntry, 'categoryId' | 'title'> &
  Partial<KnowledgeEntry>;
export type EntryUpdateInput = Partial<KnowledgeEntry>;

/** createScenario 的开局设定：主角只给条目 id，cast 的 id 由仓储生成 */
export type ScenarioSetupInput = Omit<ScenarioSetup, 'cast'> & { cast: { entryId: string }[] };

/**
 * 整棵大纲子树的事务化落库入参。
 *
 * 与 `OutlineNode` 的区别是「还没有身份」：id / novelId / parentId / order / 时间戳
 * 全部由仓储在事务里生成，调用方只描述这棵树长什么样。这样「替换一层」才能
 * 在一个事务里删旧建新 —— 先建后删会撞 order，先删后建失败就只剩半棵树。
 */
export interface OutlineTreeInputNode {
  title: string;
  synopsis: string;
  targetWords: number | null;
  /** 可选：M1 的关联确认走 updateOutlineLinks，不经过这里；预留给 M3 */
  linkedEntryIds?: string[];
  children: OutlineTreeInputNode[];
}

/**
 * 回溯大纲的落库入参：一章一个顶层节点，并把章节的 outlineNodeId 回填。
 *
 * 身份与顺序（id / parentId / order / 时间戳）仍由仓储在事务里生成；
 * 调用方只描述「这一章要变成什么节点」。
 */
export interface OutlineBackfillInputItem {
  chapterId: string;
  title: string;
  synopsis: string;
  targetWords: number | null;
  status: OutlineNode['status'];
}

/** appendScenarioNode 的入参：身份、层级、摘要与时间由仓储掌管 */
export type ScenarioNodeInput = Omit<
  ScenarioNode,
  | 'id'
  | 'novelId'
  | 'scenarioId'
  | 'depth'
  | 'pathSummary'
  | 'deltaEditedAt'
  | 'createdAt'
  | 'updatedAt'
>;

export interface NovelRepository {
  // ------------------------------------------------ 小说
  listNovels(options?: { includeDeleted?: boolean }): Promise<Novel[]>;
  /** 书架用：小说 + 聚合统计 */
  listShelfItems(): Promise<ShelfItem[]>;
  getNovel(id: string): Promise<Novel | undefined>;
  getNovelStats(novelId: string): Promise<NovelStats>;
  /** 创建小说时自动补齐内置分类与默认风格档案 */
  createNovel(draft: NovelDraft): Promise<Novel>;
  updateNovel(id: string, patch: Partial<Novel>): Promise<Novel>;
  /** 硬删除并级联清理该小说的全部从属数据 */
  deleteNovel(id: string): Promise<void>;

  // ------------------------------------------------ 分类
  listCategories(novelId: string): Promise<Category[]>;
  createCategory(
    novelId: string,
    input: Pick<Category, 'name'> & Partial<Category>,
  ): Promise<Category>;
  updateCategory(id: string, patch: Partial<Category>): Promise<Category>;
  /** 内置分类不允许删除；分类下仍有条目时拒绝删除 */
  deleteCategory(id: string): Promise<void>;

  // ------------------------------------------------ 知识条目
  listEntries(novelId: string, query?: EntryQuery): Promise<KnowledgeEntry[]>;
  getEntry(id: string): Promise<KnowledgeEntry | undefined>;
  createEntry(
    novelId: string,
    input: Pick<KnowledgeEntry, 'categoryId' | 'title'> & Partial<KnowledgeEntry>,
  ): Promise<KnowledgeEntry>;
  updateEntry(id: string, patch: Partial<KnowledgeEntry>): Promise<KnowledgeEntry>;
  softDeleteEntry(id: string): Promise<void>;
  restoreEntry(id: string): Promise<void>;
  /** 条目是某个推演的主角时拒绝（「这个条目是推演《X》的主角，先删除推演」） */
  hardDeleteEntry(id: string): Promise<void>;
  /**
   * 按名称查找条目（title 或 aliases 命中，忽略大小写与首尾空白）。
   * 反向提取判断「新增还是合并」时依赖它。只匹配通用条目：反向提取是世界观层的操作
   */
  findEntryByName(novelId: string, name: string): Promise<KnowledgeEntry | undefined>;

  // ------------------------------------------------ 大纲
  listOutline(novelId: string): Promise<OutlineNode[]>;
  createOutlineNode(
    novelId: string,
    input: Pick<OutlineNode, 'title'> & Partial<OutlineNode>,
  ): Promise<OutlineNode>;
  updateOutlineNode(id: string, patch: Partial<OutlineNode>): Promise<OutlineNode>;
  /** 删除节点时级联删除整棵子树 */
  deleteOutlineNode(id: string): Promise<void>;
  /**
   * 在单个事务里「替换/追加」某节点下的一层子树。
   * - replace：删除挂载点下现有子节点（及其子树），并解除受影响章节的大纲关联；
   * - append：接在现有兄弟之后；anchorId 为 null 表示整本顶层追加（立项）。
   * 事务内校验 anchor 存在且属于 novelId、计算 append 起始 order（消 TOCTOU）；
   * nodes 为空时抛错（避免「采用后什么都没发生」）。
   * 任何一步失败整体回滚，不留「删了旧节点、没建成新节点」的半棵树。
   * 返回按前序展开的已创建节点（含子节点 id），便于调用方与 M3 使用。
   *
   * 注意：replace + anchorId=null 是**整本顶层替换**（删除全部根节点后按顶层重建），
   * 走的是立项「重新生成大纲」；它是最容易留半棵树的路径，因此同样收在这个事务里。
   */
  commitOutlineSubtree(
    novelId: string,
    anchorId: string | null,
    nodes: readonly OutlineTreeInputNode[],
    mode: 'append' | 'replace',
  ): Promise<OutlineNode[]>;
  /**
   * 批量写多个节点的 linkedEntryIds（关联确认面板用）。
   * 单事务：避免「写一半刷新」留下半套关联；任何一个 id 不存在时整批失败并回滚。
   * 只碰关联字段，不触碰标题/梗概/状态（与 updateOutlineNode 的分工是「批量原子 vs 单节点通用」）。
   */
  updateOutlineLinks(
    updates: readonly { id: string; linkedEntryIds: readonly string[] }[],
  ): Promise<void>;
  /**
   * 按已有主线章节 1:1 回填顶层大纲节点（M3 导入作品回溯，无 AI）。
   *
   * 单个事务 `[outlineNodes, chapters]`：
   * - 为每项建 `parentId=null` 的节点，order 接在现有顶层节点之后；
   * - 把对应章节的 `outlineNodeId` 回填成新节点；
   * - 事务内重查：章节不存在 / 已挂大纲 / 属于别的作品 → 跳过该章（不覆盖已有关系）；
   * - 全部跳过时抛错（避免「确认后什么都没发生」）；任何一步失败整体回滚。
   *
   * 返回本次创建的节点（按入参顺序）。
   */
  commitOutlineBackfill(
    novelId: string,
    items: readonly OutlineBackfillInputItem[],
  ): Promise<OutlineNode[]>;
  /** 批量写入同层排序，用于拖拽重排 */
  reorderOutline(updates: { id: string; parentId: string | null; order: number }[]): Promise<void>;

  // ------------------------------------------------ 章节
  listChapters(novelId: string): Promise<Chapter[]>;
  getChapter(id: string): Promise<Chapter | undefined>;
  createChapter(novelId: string, input: Partial<Chapter> & { index?: number }): Promise<Chapter>;
  /** 传入 content 时自动重算 wordCount */
  updateChapter(id: string, patch: Partial<Chapter>): Promise<Chapter>;
  deleteChapter(id: string): Promise<void>;

  // ------------------------------------------------ 外传
  /** 按 order、createdAt 排序 */
  listSideStories(novelId: string): Promise<SideStory[]>;
  /** 摘要面板、导入循环、提案落库都要读最新值，不能用组件里拿到的旧对象 */
  getSideStory(id: string): Promise<SideStory | undefined>;
  /** 标题归一化后存；本书内重名（sideStoryTitleKey 相同）时拒绝 */
  createSideStory(novelId: string, input: { title: string; synopsis?: string }): Promise<SideStory>;
  /** id / novelId / order / createdAt 不可通过 patch 修改；updatedAt 由仓储写 */
  updateSideStory(
    id: string,
    patch: Partial<Pick<SideStory, 'title' | 'synopsis' | 'rollingSummary'>>,
  ): Promise<SideStory>;
  /** 级联删除这部外传的章节与章节摘要；不存在时静默返回 */
  deleteSideStory(id: string): Promise<void>;

  // ------------------------------------------------ 写作规范
  /** 按 order、createdAt、id 排序 */
  listWritingNorms(novelId: string): Promise<WritingNorm[]>;
  /**
   * 排在已有规范之后（max(order) + 1）。content 原样保存，不 trim；
   * scopes 缺省为全部六项，传入时先去重并按固定顺序排列
   */
  createWritingNorm(
    novelId: string,
    input: { title: string; content: string; enabled?: boolean; scopes?: WritingNormScope[] },
  ): Promise<WritingNorm>;
  /** 只改这四项；身份、排序、创建时间由仓储掌管。不存在时抛错 */
  updateWritingNorm(
    id: string,
    patch: Partial<Pick<WritingNorm, 'title' | 'content' | 'enabled' | 'scopes'>>,
  ): Promise<WritingNorm>;
  /** 不存在时静默返回 */
  deleteWritingNorm(id: string): Promise<void>;
  /** orderedIds 必须恰好是本书全部规范的 id；按数组下标重写 order */
  reorderWritingNorms(novelId: string, orderedIds: string[]): Promise<void>;
  /**
   * AI 精简的落库入口：在原规范之后插入一份新规范（沿用作用范围、启用），
   * 并停用原规范。一个事务，同成同败；原规范正文不变
   */
  saveCondensedWritingNorm(
    sourceId: string,
    input: { title: string; content: string },
  ): Promise<WritingNorm>;

  // ------------------------------------------------ 互动推演
  /** 按 lastAdvancedAt ?? updatedAt 倒序 */
  listScenarios(novelId: string): Promise<Scenario[]>;
  getScenario(id: string): Promise<Scenario | undefined>;
  /**
   * 新建推演。newOc 非空时在同一事务里建一条限定到本推演的人物条目并把它作为主角 ——
   * 作者自己填的字，直接保存、不走提案；限定作用范围让它不会出现在主线写作的 prompt 里
   */
  createScenario(
    novelId: string,
    input: {
      title: string;
      setup: ScenarioSetupInput;
      newOc?: { categoryId: string; title: string; fields: Record<string, string> };
    },
  ): Promise<Scenario>;
  /** 只改名称与开局设定里可改的部分（目标、里程碑、基调、预计步数）；主角与起点改不动 */
  updateScenario(
    id: string,
    patch: {
      title?: string;
      setup?: Partial<Pick<ScenarioSetup, 'goals' | 'milestones' | 'tone' | 'expectedSteps'>>;
    },
  ): Promise<Scenario>;
  /**
   * 一个事务：删推演与全部节点；清掉指向它的 scenarioSource（大纲、章节与正文保留）；
   * trashScopedEntries 为真时把「targets 只含这一个推演」的限定条目移进回收站，
   * 限定到多个推演的只从 targets 里去掉这一项
   */
  deleteScenario(id: string, options: { trashScopedEntries: boolean }): Promise<void>;
  /** 按 depth、createdAt、id 排序 */
  listScenarioNodes(scenarioId: string): Promise<ScenarioNode[]>;
  /**
   * 推进。一个事务里做全部树检查（根唯一、父节点存在且未结局、同一选择至多一个子节点）、
   * 再过一遍 sanitizeDelta，写节点，并把 mainNodeId 与 cursorNodeId 改成新节点 ——
   * 主线规则只有这一个执行点
   */
  appendScenarioNode(
    scenarioId: string,
    input: ScenarioNodeInput,
  ): Promise<{ node: ScenarioNode; scenario: Scenario }>;
  /** 跳转（回退、切换世界线）：只改 cursorNodeId，不动主线 */
  setScenarioCursor(scenarioId: string, nodeId: string): Promise<void>;
  /** 作者编辑差异：sanitizeDelta 有任何提示即抛第一条、什么都不写；成功时写 deltaEditedAt */
  updateScenarioNodeDelta(nodeId: string, delta: WorldlineDelta): Promise<ScenarioNode>;
  /** 「再给几个选项」：去重后追加，总数 ≤ 8，batch = 现有最大 batch + 1 */
  appendScenarioOptions(
    nodeId: string,
    options: Omit<ScenarioOption, 'id' | 'batch'>[],
  ): Promise<ScenarioNode>;
  setScenarioNodeSummary(
    nodeId: string,
    summary: { text: string; openThreads: string[] },
  ): Promise<ScenarioNode>;
  /**
   * 提升本线新条目，一个事务：create = 建世界观条目（作用范围通用）；mergeInto = 更新已有同名通用条目。
   * 两种都把本线条目标为 promotedEntryId
   */
  promoteLineEntry(
    input: { nodeId: string; localId: string } & (
      { create: EntryCreateInput } | { mergeInto: string; patch: EntryUpdateInput }
    ),
  ): Promise<KnowledgeEntry>;
  /** 沉淀提案的落库入口（applyProposal 调用）。主线：追加大纲；外传：建外传与章节或追加章节。一个事务 */
  commitScenarioOutline(novelId: string, plan: ScenarioOutlinePlan): Promise<void>;

  // ------------------------------------------------ 章节摘要
  listSummaries(novelId: string): Promise<ChapterSummary[]>;
  getSummaryByChapter(chapterId: string): Promise<ChapterSummary | undefined>;
  upsertSummary(
    novelId: string,
    chapterId: string,
    input: Partial<ChapterSummary>,
  ): Promise<ChapterSummary>;

  // ------------------------------------------------ 风格档案
  getStyleProfile(novelId: string): Promise<StyleProfile | undefined>;
  upsertStyleProfile(novelId: string, patch: Partial<StyleProfile>): Promise<StyleProfile>;

  // ------------------------------------------------ Proposal
  listProposals(
    novelId: string,
    query?: { status?: Proposal['status']; batchId?: string },
  ): Promise<Proposal[]>;
  createProposals(items: Proposal[]): Promise<void>;
  updateProposal(id: string, patch: Partial<Proposal>): Promise<Proposal>;
  deleteProposal(id: string): Promise<void>;

  // ------------------------------------------------ 写作计划
  getPlan(novelId: string): Promise<WritingPlan | undefined>;
  upsertPlan(novelId: string, patch: Partial<WritingPlan>): Promise<WritingPlan>;
  listDailyLogs(novelId: string, range?: { from?: string; to?: string }): Promise<DailyLog[]>;
  /** 按 (novelId, date) 累加当日产出 */
  addDailyProgress(
    novelId: string,
    date: string,
    delta: { words?: number; chaptersCompleted?: number },
  ): Promise<DailyLog>;

  // ------------------------------------------------ 旧稿导入任务
  /** 一本书同时只有一个导入任务 */
  getImportJob(novelId: string): Promise<ImportJob | undefined>;
  upsertImportJob(novelId: string, patch: Partial<ImportJob>): Promise<ImportJob>;
  deleteImportJob(novelId: string): Promise<void>;
  /**
   * 进入草稿阶段。库里已有 destination !== null 的任务，或已有一个 id !== expectedJobId 的
   * 草稿任务时抛错；否则整行覆盖成新的草稿任务。expectedJobId 是乐观并发检查：调用方声明
   * 「我以为库里是哪一行」，对不上就说明别处有一批付过钱的草稿，不能悄悄冲掉
   */
  saveImportDrafts(
    novelId: string,
    input: { batchId: string; drafts: ImportDraft[]; expectedJobId: string | null },
  ): Promise<ImportJob>;
  /** 草稿阶段的逐章修改（翻译、勾选、重试、跳过）。只开 importJobs 的 rw 事务，合并到库里最新那一行 */
  patchImportDrafts(
    novelId: string,
    patches: {
      index: number;
      patch: Partial<
        Pick<
          ImportDraft,
          | 'content'
          | 'sourceContent'
          | 'sourceLanguage'
          | 'translateStatus'
          | 'translateError'
          | 'translationPlan'
        >
      >;
    }[],
  ): Promise<ImportJob>;
  /** 进入 main / side 阶段。side / newSide 时返回的 sideStory 必为非 null，main 时为 null */
  commitImportChapters(
    novelId: string,
    input: {
      target:
        | { kind: 'main' }
        | { kind: 'side'; sideStoryId: string }
        | { kind: 'newSide'; title: string };
      withStyle: boolean;
    },
  ): Promise<{ job: ImportJob; sideStory: SideStory | null }>;
  /** 进入 worldview 阶段。检查与 commitImportChapters 第 1 步相同；事务只开 importJobs */
  commitImportWorldview(
    novelId: string,
    input: { chunks: ImportWorldviewChunk[] },
  ): Promise<ImportJob>;

  // ------------------------------------------------ 译名表
  /**
   * 作品级译名表，一书一份。
   *
   * 挂在作品上而不是导入任务上：任务跑完就删，而「Ashford 译作阿什福德」
   * 是这部作品的永久事实，第二批外文素材必须沿用同一个译法。
   */
  getGlossary(novelId: string): Promise<Glossary | undefined>;
  /**
   * 合并模型新产出的译名，**先到先得** —— 已定下的不被推翻。
   * 合并规则收在仓储里，保证这个不变量只有一个执行入口。
   */
  mergeGlossaryTerms(novelId: string, incoming: GlossaryEntryData[]): Promise<Glossary>;
  /** 用户显式设定某个原文名的译法，**覆盖**已有的 */
  setGlossaryTerm(novelId: string, source: string, target: string): Promise<Glossary>;
  removeGlossaryTerm(novelId: string, source: string): Promise<Glossary>;

  // ------------------------------------------------ 备份
  /**
   * 导出全部数据。不含任何设置与密钥 —— 备份文件会被丢进网盘或发给自己，
   * API Key 绝不能跟着走。
   */
  exportSnapshot(): Promise<RepositorySnapshot>;
  /**
   * 导入快照。
   * - `replace`：清空现有数据后写入，用于「换设备 / 清过浏览器数据后恢复」
   * - `merge`：按 id 覆盖式合并，用于把另一台设备的作品并过来。互动推演的节点按推演整棵替换
   *   （两份各自合法的树逐行取并集就不合法了），替换后清理本地行里指向已不存在步骤的引用
   */
  importSnapshot(snapshot: RepositorySnapshot, mode: 'replace' | 'merge'): Promise<void>;
}
