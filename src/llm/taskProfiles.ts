import type { ReasoningEffort } from './types';

/** 应用里所有需要调用模型的场合 */
export type TaskKind =
  /** 一句话立项：世界观 + 人物 + 大纲 */
  | 'project-setup'
  /** 把大纲节点扩写成更细的子节点 */
  | 'outline-expand'
  /** 在既有大纲之后续写 3–5 章的前沿大纲 */
  | 'outline-continue'
  /** 生成整章正文 */
  | 'chapter-draft'
  /** 段落续写 / 改写 / 扩写 */
  | 'paragraph-revise'
  /** 章节完成后生成摘要与伏笔 */
  | 'chapter-summary'
  /** 从旧稿反向提取设定 */
  | 'extract-settings'
  /** 把外文章节译成中文 */
  | 'translate-chapter'
  /** 从示例文本提炼风格 rubric */
  | 'style-sample'
  /** 把长篇写作规范压成可直接进提示词的约束条目 */
  | 'norm-condense'
  /** 按写作规范审读一章，列出可能违反之处（只提示，不改正文） */
  | 'norm-check'
  /** 互动推演的一步：流式情节 + 结构化尾部（挑战、选项、世界线变化） */
  | 'interactive-step'
  /** 互动推演的收尾：作者要求在这一步写出结局 */
  | 'interactive-ending'
  /** 互动推演「再给几个选项」 */
  | 'interactive-options'
  /** 互动推演每 5 步一次的前情摘要 */
  | 'interactive-summary'
  /** 把推演的一段路径沉淀为卷 / 章大纲 */
  | 'path-to-outline'
  /** 设置页的连通性测试 */
  | 'connectivity-test';

export interface TaskProfile {
  /** 开启思维链。结构化推理任务开，正文创作关 */
  thinking: boolean;
  reasoningEffort?: ReasoningEffort;
  temperature: number;
  /** 用更强的模型 */
  useStrongModel: boolean;
  /** 期望结构化 JSON 输出 */
  structured: boolean;
  /** 展示给用户的任务名 */
  label: string;
}

/**
 * 按任务分配模型参数。
 *
 * 两条原则：
 * 1. **结构化推理开 thinking，正文创作关 thinking**。推理模式擅长规划与抽取，
 *    但会让散文变得解释性过强、文气断裂；正文要的是一气呵成。
 * 2. **温度随任务分化**。抽取与摘要要稳定可复现，温度压到接近 0；
 *    正文要有变化，温度给到 0.9 以上。
 */
export const TASK_PROFILES: Record<TaskKind, TaskProfile> = {
  'project-setup': {
    thinking: true,
    reasoningEffort: 'high',
    temperature: 0.8,
    // 立项决定整本书的地基，值得用更强的模型
    useStrongModel: true,
    structured: true,
    label: '生成世界观与大纲',
  },
  'outline-expand': {
    thinking: true,
    reasoningEffort: 'high',
    temperature: 0.8,
    useStrongModel: true,
    structured: true,
    label: '细化大纲',
  },
  /**
   * 前沿续写：只规划不写正文，要承接伏笔、守住作者边界。
   * 温度比细化大纲（0.8）低一档：这是顺着既有走向往前推，不是发明新分支；
   * 仍然值得用强模型 + 高思维链，规划错了后面几章正文都白写。
   */
  'outline-continue': {
    thinking: true,
    reasoningEffort: 'high',
    temperature: 0.6,
    useStrongModel: true,
    structured: true,
    label: '续写后续大纲',
  },
  'chapter-draft': {
    thinking: false,
    temperature: 0.95,
    useStrongModel: false,
    structured: false,
    label: '生成章节正文',
  },
  'paragraph-revise': {
    thinking: false,
    temperature: 0.95,
    useStrongModel: false,
    structured: false,
    label: '改写段落',
  },
  'chapter-summary': {
    thinking: true,
    reasoningEffort: 'medium',
    // 摘要必须忠实于原文，不需要发挥
    temperature: 0.2,
    useStrongModel: false,
    structured: true,
    label: '提炼章节摘要',
  },
  'extract-settings': {
    thinking: true,
    reasoningEffort: 'high',
    temperature: 0.2,
    useStrongModel: false,
    structured: true,
    label: '提取设定',
  },
  'translate-chapter': {
    /**
     * 关思维链：文学翻译要的是一气呵成的中文，推理模式会让译文
     * 带上解释性的赘语、句子之间的气也断掉 —— 与正文创作同理。
     */
    thinking: false,
    /**
     * 温度压得比正文低（正文 0.95）：翻译的创造性只体现在措辞选择上，
     * 不该在情节与语义上发挥。但也不能像提取那样压到 0.2，
     * 否则译文会变成逐词对译的生硬中文。
     */
    temperature: 0.7,
    /** 译文质量直接决定这几章能不能和后面的中文续写读成一本书，值得用更强的模型 */
    useStrongModel: true,
    structured: false,
    label: '翻译章节',
  },
  'style-sample': {
    thinking: true,
    reasoningEffort: 'medium',
    temperature: 0.3,
    useStrongModel: false,
    structured: true,
    label: '提炼文风',
  },
  /**
   * 归纳任务：要忠实、不发挥，所以低温、开思维链；输出是纯文本条目，不需要 JSON。
   * 刻意不加进设置页的 TASK_ORDER（与 style-sample 同理），避免改设置页。
   */
  'norm-condense': {
    thinking: true,
    reasoningEffort: 'medium',
    temperature: 0.2,
    useStrongModel: false,
    structured: false,
    label: '精简写作规范',
  },
  /**
   * 逐条对照的推理任务：开思维链、低温以求稳定。
   * 用常规模型：检查按章、按需反复跑，结果只是提示、由作者判断，误判代价低于立项与大纲。
   * 同样不加进设置页的 TASK_ORDER。
   */
  'norm-check': {
    thinking: true,
    reasoningEffort: 'high',
    temperature: 0.2,
    useStrongModel: false,
    structured: true,
    label: '按规范检查',
  },
  /**
   * 互动推演的五个任务同样不加进设置页的 TASK_ORDER，避免改设置页。
   *
   * 一步的输出以散文为主：按「正文创作关思维链」关掉，首字也更快出来，流式才有游戏感。
   * 温度比整章（0.95）低一档：尾部 JSON 要记账准确、选项要守规则；
   * 没有思维链时对规则的遵守由代码层 sanitizeDelta 兜底。每步都调用，用常规模型
   */
  'interactive-step': {
    thinking: false,
    temperature: 0.85,
    useStrongModel: false,
    structured: true,
    label: '互动推演 · 一步',
  },
  /**
   * 与一步同参：系统提示逐字节相同才能共享前缀缓存，语气也要和前面的步骤一致。
   * 单列是为了任务名清楚、以后能单独调参
   */
  'interactive-ending': {
    thinking: false,
    temperature: 0.85,
    useStrongModel: false,
    structured: true,
    label: '互动推演 · 收尾',
  },
  /** 只要几条倾向不同的选项，温度略高以求多样 */
  'interactive-options': {
    thinking: false,
    temperature: 0.9,
    useStrongModel: false,
    structured: true,
    label: '互动推演 · 再给选项',
  },
  /** 与 chapter-summary 同理：摘要要忠实、不发挥 */
  'interactive-summary': {
    thinking: true,
    reasoningEffort: 'medium',
    temperature: 0.2,
    useStrongModel: false,
    structured: true,
    label: '互动推演 · 前情摘要',
  },
  /**
   * 大纲规划用重点任务模型、开思维链（与立项、细化大纲同理）。
   * 温度比 outline-expand（0.8）低：这是把已有内容分章，不是发明情节
   */
  'path-to-outline': {
    thinking: true,
    reasoningEffort: 'high',
    temperature: 0.4,
    useStrongModel: true,
    structured: true,
    label: '推演沉淀为大纲',
  },
  'connectivity-test': {
    thinking: false,
    temperature: 0.7,
    useStrongModel: false,
    structured: false,
    label: '连通性测试',
  },
};
