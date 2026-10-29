# 设计 · M4 文风

## S1 文风锚点

### 选择（纯函数 `src/context/styleAnchor.ts`）
```ts
export const STYLE_ANCHOR_CHARS = 600;
export interface StyleAnchor { chapterId: string; index: number; label: string; text: string; }
export function selectStyleAnchor(chapters, targetChapterId): StyleAnchor | null;
```
- 取同一线章节（调用方传入同一 track），按 index 升序；
- 只考虑 `targetChapterId` 之前的章节；优先 `status === 'done'`，在已完成里取最早一章；没有已完成则取最早有正文的；
- 正文 trim 后 <300 字跳过（不足以代表语感）；
- 摘取开头至 600 字：按段落累加，超过上限时截断到最近段落边界，末尾补「……」；不选结尾（开头更像稳定语感）。
- label：主线「第 N 章开头」，外传「外传第 N 章开头」由调用方传入 track 前缀或函数参数 `chapterWord`。

### 注入
`SummaryChainContextBuilder.build` 在 `meta+style` 之后、规范之前：
```
【文风锚点 · 第 N 章开头（作者本人原文）】
下面这段是作者此前写下的正文。只用来对齐句式、节奏与叙述距离；不要复述或照搬其中的情节与句子。
<text>
```
- 作为独立 `ContextItem { kind: 'styleAnchor', id: chapterId, label, tokens }`；
- 走预算裁剪（不强制）；被裁掉时进 dropped 列表，注入清单可见；
- 无锚点时不产生任何文本/项；第一章行为与改动前逐字节一致。
- `ContextItemKind` 加 `'styleAnchor'`；GenerateChapterSheet 的注入清单直接按 items 渲染，无需特判。

### 基线影响
- 有「目标章 + 更早正文」的上下文构建测试/基线会多出锚点块；逐字节基线（noNorms/noScenario）需要按新输出更新，并在测试名/注释里说明这是 M4 有意变更。

## S2 文风漂移检查

### 任务配置
`TaskKind 'style-check'`：thinking true / reasoning high / temperature 0.3（诊断稳定）/ useStrongModel true / structured true / label「检查文风」；加入 SettingsPage TASK_ORDER。

### Schema
```ts
export const StyleCheckSchema = z.object({
  summary: z.string().min(1),              // 整体判断，1–2 句
  issues: z.array(z.object({
    dimension: z.string().min(1),          // 七个 rubric 维度之一或「叙述距离」等
    severity: z.enum(['low','medium','high']),
    excerpt: z.string().min(1),            // 原文证据，必须逐字摘录
    basis: z.string().min(1),              // 与风格档案/锚点的可观察差异（句长/叙述距离/对话密度/意象密度…），不是情节评价
    suggestion: z.string().min(1),         // 具体怎么改，不代写
  })).max(5),
});
```
- severity 标签中性化：high「差异较大」、medium「局部差异」、low「轻微差异」，不用「明显偏离」这种判决口吻。
- 面板开头一句区分：「文风检查看语感与叙述距离是否漂移；按规范检查看你定的规矩是否被违反。依据：风格档案 + 文风锚点。」

### 服务 `src/features/style/styleCheck.ts`
- `runStyleCheck(deps, { novel, style, chapter, chapters, targetChapterId })`
- system：`composeStylePrefix(novel, style)` + 任务说明（文学编辑；只诊断不改稿；每个问题必须引用原文；没有证据不要编；最多 5 条；不要把情节好坏当文风问题；不评价题材/价值观）。
- user：`【文风锚点】`（`selectStyleAnchor` 结果；没有则省略）+ `【本章正文】` + `【本次要求】只输出结构化诊断`。
- `llm.runStructured('style-check', { schema: StyleCheckSchema, schemaName: 'StyleCheck', failOnTruncation: true })`。
- 返回结果，不写库、不出提案。
- 失败错误透传；UI 可重试。

### UI `src/features/writing/StyleCheckSheet.tsx`
- 入口：ChapterEditor 标题栏/操作区「检查文风」，与「按规范检查」并列；无正文时禁用/提示。
- 面板：生成按钮 → loading；结果：整体判断 + issues（severity 标签、维度、引用原文、建议）；无 issues 显示「未发现明显文风漂移」；错误显示可重试；关闭不写。
- 不提供「应用建议/自动改稿」；文案明确「只给诊断，不改你的稿子」。

### 测试
- 选择函数：顺序/仅更早/已完成优先/字数门槛/截断；第一章无锚点。
- 上下文：锚点块顺序、item、预算 dropped、无锚点逐字节不变。
- 服务：prompt 含 style/anchor/正文；schema；错误。
- UI：入口、一次调用、结果/空结果/错误、关闭不写、无自动改写按钮。
