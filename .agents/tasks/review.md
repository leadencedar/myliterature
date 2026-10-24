# 导入类型「作为世界观设定」：不落章节的分段提取

导入面板新增「作为世界观设定」导入类型，粘贴的设定文本只提取成知识库条目提案，不写 Chapter 表。上一轮被否决的「index=-1 临时章节」方案已经整体删除：设定文本切段后连同逐段进度存在 ImportJob 新增的 `worldviewText` / `worldviewChunks` 字段上，提取循环、收尾和断点续跑都在 job 上完成，收尾只生成条目提案。章节模式的代码路径没有动，只删掉了旧方案塞进去的 worldview 分支。

Watch for：没有阻断性问题。剩下三处体验小瑕疵（likely/confirmed）：粘贴步骤的通用说明在世界观模式下仍写着「下一步会切成章节」，暂停提示写的是「本章」，未配置模型时「开始提取设定」按钮仍可点。

**Verdict**: APPROVED

## High-level view

世界观分支完全不碰 Chapter 表。`createWorldviewImportJob` 只调 `persistJob`，`chapters: []`、`withSummaries: false`、`withStyle: false`；整个 `src/` 里已经搜不到 `index: -1` / `index === -1` / `deleteChapter` / 临时章节的逻辑（唯一命中是 backup.test.ts 里一条既有的非法数据用例）。新 schema 字段都带 default，旧 job 记录不用迁移就能读。

提取复用同一个 `extract-settings` 任务和 `ExtractResultSchema`。`buildExtractUserPrompt` 的 `sourceLabel` 把正文块标成「【设定文本（…）】」，不传时章节 prompt 原样不变。伏笔和全书进展传空，模型返回的 summary/rollingSummary 直接丢掉。`accumulateEntryDrafts(..., null)` 不记溯源章节 id，`buildEntryProposal` 的 `fallbackSourceRef` 把 sourceRef 定为「世界观设定导入」，所以不会出现「第 -1 章」或悬空的 chapterId。

`finalizeWorldview` 只把条目草稿转成提案，不出章节摘要、全书进展和文风提案。inbox 文案和「继续导入」提示读独立的 `finishedImportType` state，所以 `setJob(null)` 之后文案不会退回章节版本。

测试覆盖是真的。ImportScreen.test.tsx 里 `describe('作为世界观设定导入')` 的 10 个用例都通过 `pasteWorldview` 走真实 UI 路径（点「作为世界观设定」再点「开始提取设定」），断言了 fetch 挂起期间和完成后 `listChapters` 都为 `[]`、没有 chapterSummary/novel/styleProfile 提案且只发了 1 次请求、inbox 显示「从设定文本中读出」、merge 后 `sourceChapterIds` 为空、长文本分段合并、402 失败后重开面板直接落在提取步骤并能重试。实现记录里还写了反向验证：换回旧实现后这 10 例全部失败。

<details>
<summary>Issues (3)</summary>

1. **粘贴步骤说明与世界观模式矛盾**（confirmed，非阻断）：世界观模式下粘贴页顶部仍无条件显示「下一步会切成章节供你核对，确认后才会写入作品」，紧挨着下面「设定文本不会写成章节」的提示。改成按 `importType` 切换文案。
2. **暂停提示写「本章」**（confirmed，非阻断）：`pause()` 固定 `setNote('正在停在本章结束处…')`，世界观模式应改为「本段」。
3. **未配置模型时可直接开始提取设定**（likely，非阻断）：粘贴页的「开始提取设定」只按 `text.trim()` 禁用，没配模型时会先建 job，再让第 1 段以失败告终。可以复用章节模式的 `llm.configured` 判定，禁用按钮或先给出提示。

</details>

<details>
<summary>Details</summary>

### 旧临时章节方案的删除情况

计划里列出的旧代码在 ImportScreen.tsx 里都找不到了：`createChapter({ index: -1 })`、加载时清理 `index === -1` 孤儿章节、finalize 里删临时章节的循环、`extractOne` 里的 worldview 三元、`buildStyleProposal` 首行的 worldview 判断、rollingSummary 条件里的 `importType !== 'worldview'`。`createChapter` 只剩 `createChaptersAndJob` 一处调用，它只能从分章步骤的「确认并写入 N 章」进入，而这个步骤世界观流程到不了。分支选择看的是 `jobRef.current.importType`（runLoop、finalize、加载 effect），不看 UI 上的 `importType` state，所以续跑时不会走错分支。

### 数据流

```
粘贴 ──「开始提取设定」──▶ splitWorldviewText (≤6000 字/段)
                              │
                              ▼
               ImportJob { importType: 'worldview',
                           worldviewChunks[], chapters: [] }
                              │ runLoop：逐个 pending 段
                              ▼
          extract-settings (sourceLabel, 无伏笔/进展)
                              │ 只保留 entries
                              ▼
          accumulateEntryDrafts(..., null) ─▶ entryDrafts
                              │ 全部 done
                              ▼
   finalizeWorldview ─▶ 只有 knowledgeEntry 提案 ─▶ deleteImportJob ─▶ inbox
```

段在建 job 时就固化，所以之后调整 `WORLDVIEW_CHUNK_SIZE` 不会影响进行中的任务。失败策略是 fail-stop，和章节模式一样：一段失败就标 failed 并停下，不往下跑。

### 粘贴步骤的文案和守卫

粘贴页顶部的通用说明「下一步会切成章节供你核对，确认后才会写入作品」没有按类型区分，用户会同时看到两句意思相反的话。`pause()` 的「正在停在本章结束处…」也是同样的问题。另外，章节模式的流程在分章之后由 `llm.configured` 拦住，世界观流程跳过了分章，粘贴页按钮只看文本是否为空，所以没配模型时会建出一个第 1 段立即失败的 job。这个状态可以恢复（配好后点重试，或者放弃），但体验比章节模式差一截。

### 章节模式回归

章节路径只删除了 worldview 条件，另外加了一行 `setFinishedImportType('chapter')`。证据来自实现记录（1023 passed / 0 failed，其中原有约 1004 个），本次审查没有重跑。

</details>

<details>
<summary>File map</summary>

- `src/domain/schema.ts`：新增 `ImportWorldviewChunkSchema`；`ImportJobSchema` 新增 `worldviewText`、`worldviewChunks`（带 default）。
- `src/features/import/worldview.ts`（新）：`WORLDVIEW_CHUNK_SIZE`、`splitWorldviewText`。
- `src/features/import/worldview.test.ts`（新）：分段工具 6 个用例。
- `src/features/import/extractSettings.ts`：`sourceLabel` 参数；`accumulateEntryDrafts` 接受 `chapterId: null`。
- `src/features/import/extractSettings.test.ts`：sourceLabel 与 null 来源 3 个用例。
- `src/features/import/ImportScreen.tsx`：删除临时章节方案；新增世界观 job 创建、逐段提取、finalizeWorldview、续跑、提取页 UI、`finishedImportType`、`fallbackSourceRef`。
- `src/features/import/ImportScreen.test.tsx`：`作为世界观设定导入` 10 个用例。
- `docs/产品文档.md`：6.5 节补充导入类型说明和两段「为什么」。

项目不是 git 仓库，没有可用的 diff。本次审查直接读取当前文件，并对照计划文件里的改动清单。

</details>
