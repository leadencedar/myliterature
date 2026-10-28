# 设计 · M2.1 归档安全修

## 1. 服务与审计

`archiveChapter` 返回增加：

```ts
pendingTotal: number; // 本批全部 pending 提案数（摘要+进展+条目）
threads: { opened: string[]; resolved: string[]; open: string[] };
```

- `opened = summaryData.newOpenThreads`、`resolved = summaryData.resolvedThreads`、`open = mergeOpenThreads(...)`。
- 成功后写 `archiveAudit.ts`（localStorage，key `myliterature.archive-audit:<batchId>`）：
  `{ chapters: [{ chapterId, index, title, opened, resolved, open, savedAt }] }`
  容量小、只存文本；读取失败/JSON 坏时返回空；超过 7 天读取时 prune。
- `archiveAudit` 只用于「给作者看流水」，不参与幂等/落库；丢失不影响任何数据。

## 2. 收件箱安全

### 2.1 ProposalReview

新增可选 `initiallyIgnoredIds?: string[]`：`ignored` 初始集合 = 它。被忽略项 UI 仍显示「已标记为忽略 / 恢复」，与现有忽略语义一致；底部「采用本批」排除 ignored。

### 2.2 ProposalInbox

新增可选：

- `defaultIgnoreEntryOverwrites?: boolean`（归档专用）：数据加载后把 **`target === 'knowledgeEntry' && action !== 'create'`** 的提案 id 传给 ProposalReview 作为初始忽略。摘要/进展的 replace 默认仍选中 —— 每章归档都有进展 replace，若也忽略，作者得逐章手动恢复，摘要链反而会漏。
- `safetyNotice?: boolean`：显示一行提示与数量（本批含 N 条**对已有条目的**合并/替换，已默认不选；展开后点「恢复」才会写入）。数量基于当前 pending 中的知识条目 merge/replace。
- 其他调用方不传，行为逐字节不变。

### 2.3 ArchiveInboxSheet

- 传 `defaultIgnoreEntryOverwrites` 与 `safetyNotice`。
- 打开/批次变化时读 `readArchiveAudit(batchId)`，在「采用本批」上方渲染每章：
  `第 N 章：新埋 a / 收束 b / 现存 c` + 各列表；提示「若误收束，在摘要的『未收束伏笔』里加回」。
- 审计不存在（旧批/清缓存）时只显示一行「本批没有伏笔流水记录」，不阻塞。

## 3. 计数

- `ChapterEditorScreen` 状态行 done：「本章摘要与设定已生成：N 项待确认（含摘要、进展、条目）」；N=`pendingTotal`；N=0 时「待确认」。
- `findPendingArchive` 挂载恢复：数本批全部 pending，而不是只数条目。
- `entriesDegraded` 提示保留。

## 4. 测试

- archiveChapter：pendingTotal 包含摘要/进展；threads 与审计写入正确；坏 localStorage 容错。
- ProposalReview/Inbox：初始忽略 merge/replace；采用本批只提交 create；恢复后可提交；无该 prop 行为不变。
- ArchiveInboxSheet：提示/流水/缺审计 fallback。
- ChapterEditor：状态计数含全部；挂载恢复计数。
- 全量门禁 + 沙盒截图（含 merge 批次示例）。
