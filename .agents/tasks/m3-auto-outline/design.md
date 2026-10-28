# 设计 · M3 自动大纲

## 1. 回溯大纲（确定性，无 AI）

### 纯函数 `src/features/outline/backfillOutline.ts`
```ts
export interface BackfillOutlinePlanItem {
  chapterId: string; index: number; title: string; synopsis: string;
  targetWords: number | null; status: OutlineNode['status'];
}
export function planOutlineBackfill(chapters, summaries): BackfillOutlinePlanItem[];
```
- `chapters` 只传主线（`chaptersOfTrack(..., null)`），按 index 排序；跳过已有 `outlineNodeId` 的章节；跳过无正文且无标题的章节（避免空章节变空节点）。
- title = chapter.title.trim() || `第 ${index} 章`；synopsis = 对应 summary?.summary ?? ''；targetWords = chapter.wordCount > 0 ? chapter.wordCount : null；status = chapter.status === 'done' ? 'done' : chapter.status==='draft' ? 'drafting' : 'planned'（可按 done/planned 简化：done → done，其余 planned）。
- 确定性：不依赖时间/随机；相同输入逐字节可复现。

### 仓储 `NovelRepository.commitOutlineBackfill(novelId, items)`
- 单事务 `[outlineNodes, chapters]`：为每项创建顶层 OutlineNode（parentId=null，order=批内序号），并把对应 chapter.outlineNodeId 回填；任何失败整体回滚。
- 若某 chapter 已被其他节点关联（事务内重查），跳过该章而不是覆盖；若全部跳过则抛错。
- 返回创建的节点。

### UI `OutlineBackfillSheet.tsx`
- 标题「按已有章节生成大纲」；预览列表（第 N 章 标题 / 摘要 60 字）；「生成 N 个章节节点」；关闭不写。
- 入口在 WritingPage 大纲区块空态；生成成功后 invalidate 并提示「已生成 N 个节点，可手动分卷」。

## 2. 前沿续写

### TaskKind `outline-continue`
`TASK_PROFILES`: thinking true / reasoningEffort high / temperature 0.6 / useStrongModel true / structured true / label「续写后续大纲」。加入 SettingsPage TASK_ORDER（模型分工可见）。

### Service `src/features/outline/outlineContinue.ts`
```ts
export const FrontierOutlineSchema = z.object({
  chapters: z.array(z.object({
    title: z.string().min(1),
    synopsis: z.string().min(1),
    targetWords: z.number().int().positive().nullable(),
    scenes: z.array(z.string().min(1)).min(3).max(5),
    conflict: z.string().min(1),
    hook: z.string().min(1),
    usesEntries: z.array(z.string()),
    resolvesThreads: z.array(z.string()),
    plantsThreads: z.array(z.string()),
  })).min(3).max(5),
});
```
- `buildOutlineContinueSystemPrompt(novel, style, norms, coreBlocks?)`：角色 + style prefix + planning norms + 核心设定（放 system，同书稳定）+ TASK（只规划不写正文；每章 3–5 场；必须承接未收束伏笔；不替作者定人物生死/感情/凶手；不引入超过 2 个新实体；不提前泄底；章末钩子要具体）。
- `buildOutlineContinueUserPrompt({ outlineTail, rollingSummary, recentSummaries, openThreads, relatedBlocks, count })`：块顺序【当前大纲尾部】【故事至此】【最近章节要点】【未收束伏笔】【相关设定】【本次要求：续写 N 章】。
- 把结构化字段合成提案文本：`synopsis + '\n\n场清单：\n- …\n主冲突：…\n章末钩子：…\n引用设定：…\n回收伏笔：…\n新埋伏笔：…'`，保证采用后节点梗概可读、可直接开写；空字段不渲染。
- 调用 `llm.runStructured('outline-continue', {schema, schemaName:'FrontierOutline'})`；返回章节草稿 + 注入清单（供面板显示）。
- 提案：`buildCreateProposal({target:'outlineTree', payload:{outlineText, parentId}})`；`parentId = 最后一个顶层节点（若有且其下已有章节节点） ?? null`；append 模式；作者在 `ProposalInbox` 可改文本后采用。
- 失败/截断：`failOnTruncation: true`；错误提示可重试。

### UI `OutlineContinueSheet.tsx`
- 入口：WritingPage 大纲区块 header 右侧或 description 下的「续写 3–5 章」按钮（有章节或大纲时）。
- 面板：章数选择 3/4/5；展示「本次依据」（大纲尾部/进展/最近摘要/伏笔/相关设定与 token，复用 planningContext manifest 风格）；「生成」→ loading → ProposalInbox 预览确认；关闭不写。
- 生成成功后提示「已生成提案，确认后写入大纲」。

## 3. 数据与测试

- 零迁移：不新增表/字段；回填用现有 OutlineNode/Chapter 字段，续写走现有 outlineTree 提案管道。
- 测试：backfill 纯函数/事务/重复执行；prompt 结构/字段合成；UI 入口/预览/关闭不写/提案采用；Settings TASK_ORDER。
- QA：独立用例 + 沙盒（回溯 10 章、续写 3 章、Proposal 采用、重复执行不重复）。
