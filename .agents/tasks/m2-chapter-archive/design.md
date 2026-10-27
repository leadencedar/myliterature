# 设计 · M2 章节归档与字数收尾

## 1. 模块

| 文件                                            | 内容                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/features/writing/archiveBatch.ts`（新）    | localStorage 归档批次：`{ id, chapterIds[], updatedAt }`/novel；≤5 章且 24h 内复用，否则新批；纯函数 + 存储读写 |
| `src/features/writing/archiveSettings.ts`（新） | zustand persist：`autoArchive`（默认 true）、`extractEntries`（默认 true）                                      |
| `src/features/writing/archiveChapter.ts`（新）  | 归档服务：一次 `extract-settings` 调用 → 摘要/进展/条目提案；幂等与合并                                         |
| `ChapterEditorScreen.tsx`                       | 标记完成触发后台归档（非阻塞状态行）；「查看」打开本批收件箱；大纲节点完成提示                                  |
| `GenerateChapterSheet.tsx`                      | 差额提示 + 手动「继续补写」（history 续写；不自动）                                                             |
| `SettingsPage.tsx`                              | 新增「写作辅助」：自动归档 / 提取知识库条目开关与成本说明                                                       |
| `ArchiveInboxSheet.tsx`（新，可并入编辑器）     | 包裹 `ProposalInbox`，按 batch 查；关掉不写                                                                     |

## 2. 归档服务

```ts
archiveChapter(deps: { repository: NovelRepository; llm: LlmRunner }, input: {
  novel; chapter; chapters; summaries; entries; categories; sideStory?; writingNorms?;
  options: { extractEntries: boolean };
}): Promise<{ batchId: string; summaryCreated: boolean; entryCount: number; pendingCount: number }>
```

流程：

1. `extractEntries` 为 false 也要一次调用（摘要+进展必需）；`buildExtractSystemPrompt(novel,categories,norms)` + `buildExtractUserPrompt({chapter, mentionedEntries: findMentionedEntries(content, entries), otherEntryNames, openThreads: previousSummaryOf(...).openThreads, rollingSummary, sideStory})`；`runStructured('extract-settings', ExtractResultSchema, failOnTruncation: true)`。
2. 摘要：解析 `appearingEntries`；`mergeOpenThreads(prev.openThreads, resolved, new)`；先删本章**pending** `chapterSummary` 提案（payload.chapterId 匹配），再按是否有已采用摘要建 create/replace；进展（novel/sideStory）同理替换已采用值。
3. 条目：`accumulateEntryDrafts([], result.entries, categories, chapter.id)`；逐条：
   - `findEntryByName` 查已存；无变化（字段/摘要/别名都没变且非新条目）跳过；
   - 本批已有 pending 同名条目提案 → 合并 payload（`mergeEntities` 字段规格 + 来源章节并集）并 `updateProposal`；不新建；
   - 否则 `buildEntryProposal`（复用 `importProposals.ts`）新建。
   - 上限：非人物新增/变更最多 3 条/章；**人物分类新条目不受限、逐条即出**（近似 D3「新登场且开口说话」；真实开口由提取结果体现为人物条目）。
4. 全部提案同一 `batchId`。`autoArchive`/`extractEntries` 只影响 UI 触发与是否出条目，不影响摘要。
5. 幂等：summary pending 以 chapterId 清理；条目按名称合并 pending/已存；重跑不重复（同值不更新）。

## 3. UI

- 编辑器 `status` 切到 done 且正文非空、`autoArchive` → `void runArchive()`；`archiveState = idle/running/done/error`。
  - running：状态行「正在生成本章档案…」+「后台运行，可继续编辑」；
  - done：「本章档案已生成：摘要 + N 条知识库更新待确认」[查看]；
  - error：「本章档案生成失败：[原因]」[重试]。
  - 不打开任何 Sheet；不阻塞保存。已有 `needsSummary` 逻辑保留作为兜底。
- [查看] 打开 `ProposalInbox batchId`（标题「本章档案待确认」），关掉不写；`onSettled` 后清状态。
- 大纲节点：done 后若 `outlineNodeId` 对应节点 status !== done 且该节点下所有章节 status=done → 状态行下方提示「大纲节点『X』可以标为完成」[标记完成]；点击 `updateOutlineNode`。
- 自动归档关闭时，不自动调用；「摘要 / 补摘要」手入口不变。
- 首次自动运行前成本说明放设置页；不在编辑器弹窗。

## 4. T1 收尾

- `GenerateChapterSheet` 保留本次 user prompt；完成后若 `countWords < target*0.85` 或 `incomplete`：
  - 显示「比目标少约 X 字；可以继续补写未落地场景，或重新生成」；
  - [继续补写] 手动点击：`runStream('chapter-draft', {history: [user, assistant 当前文本], user: '接着上面继续写…还差约 X 字，不要重复已写内容，不要总结。', maxTokens: chapterMaxOutputTokens(剩余字数)})`，把结果追加到当前文本；可再次补写。
- 不自动调用、不循环到目标、不改 maxTokens 语义。
- 文档写明「补写是补场景，不是凑字数」。

## 5. 测试与风险

- 单测：批次轮转/24h、幂等（同章重跑）、pending 合并、上限与人物豁免、无变化跳过、摘要 pending 清理、失败不写库。
- 组件：done 触发后台状态（mock llm）、成功后查看 inbox、关掉不写、关闭设置后不调用、大纲完成提示、继续补写请求体（history/剩余字数）与追加。
- 风险：extract 调用输出被截断（failOnTruncation）、已知条目字段很长导致 prompt 长（沿用导入的 mentioned 预筛）、批次 localStorage 跨设备不共享（单机可接受）、手动摘要与归档可能重复 pending（归档清理本章 pending；手动摘要保持原行为）。

## 6. 架构评审修正（2026-10-27，product-data）

1. **两条调用路径**：`extractEntries=true` 用一次 `extract-settings`（摘要+条目+进展）；`extractEntries=false` **不要**继续用 extract 提示词，改走 `buildSummarySystemPrompt`/`buildSummaryUserPrompt` + `ChapterSummaryResultSchema`（`chapter-summary` 任务），只出摘要/进展，省掉条目输出。
2. **截断兜底**：`runStructured` 没有 maxTokens，输出可能撞默认上限；`failOnTruncation` 失败时做一次**摘要专用降级调用**（chapter-summary），保证摘要链不断；条目本轮跳过并在返回值里标记 `entriesDegraded: true`。
3. **人物豁免按 `category.kind === 'character'`**，不是分类名；自定义分类里的角色不豁免（写进限制）；豁免条目也**每章最多 3 条**，避免群像章一次弹十几条。
4. **批次状态只是提示，不是事实源**：加章前重读 localStorage、写后回读校验；查看入口用「当前 batchId + 本章 pending」双条件；同名 pending 合并**只在当前批**，旧批 pending 不跨批修改。
5. **后台触发防重**：只在本次编辑器会话的 draft→done 转换触发，不在打开已 done 章节时触发；module 级 `Map<chapterId, Promise>` 做 in-flight 去重（StrictMode/重复渲染）；挂载时查本章 pending 归档提案恢复「待确认」态，不重跑；归档传入编辑器里的最新正文（不必等防抖保存）。
6. **移除 done 自动弹摘要面板**：`ChapterEditorScreen` 标记完成不再 `setSummaryAutoStart(true)`；`autoArchive=true` 走后台归档，`autoArchive=false` 只显示「可手动补摘要」状态行。违反 D3「不弹全屏付费面板」的旧行为一并去掉。
7. **手动摘要防重复**：抽共享 `supersedePendingChapterSummary(repository, chapterId)`，`archiveChapter` 与 `ChapterSummarySheet` 在创建前都先清本章 pending summary；已有 pending 时入口可提示「本章档案待确认」。
