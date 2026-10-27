# M2 独立验证报告（章节归档 + 字数收尾）

> 验证人：qa-verifier（独立于开发）
> 对象：M2 S1 归档批次/设置、S2 归档服务、S2b 同批进展去重、S3 编辑器后台归档、S4 生成差额与继续补写、S5 设置页开关
> 代码状态：HEAD `273686c`（M1-UX 提交）+ 未提交的 M2 工作区改动（开发已停手）
> 验证时间：2026-10-27 22:24–22:49 CST；Node v22.18.0；环境：jsdom + fake-indexeddb
> 边界：QA 只写 `src/test/m2/**` 与 `ux/**`；未改 feature/开发测试（仅修了自己 M1 用例的一处并发排序断言）、未 commit。

---

## 1. 结论

**M2 功能验收：通过。** S1–S5 全部按 design/plan 落地，独立测试 **45 个全绿**（S1 15 / S2 10 / S3 10 / S4 7 / S5 3），沙盒真机流程 9 张截图跑通，零迁移确认，无功能失败项。

**是否可进入 M3：建议可以**，但有一个**测试基建条件**：全量 `npm run test:run`（默认并行）当前有 2 个 load-sensitive 的偶发失败（不是 M2 功能失败，见 §5），串行 `--maxWorkers=1` 连续 2 次全绿。建议合并前由开发给这两处加等待/降低并发（或 CI 固定串行），再跑一次默认全量作为发布门禁。

---

## 2. 环境、工件与命令

| 项 | 值 |
| --- | --- |
| HEAD | `273686c`（M1-UX：文学顾问体验后的 P0/P1 修复） |
| M2 改动 | 13 个修改文件 + 14 个新文件（见 §6 范围核对） |
| 独立测试 | `src/test/m2/` 5 个文件、**45 tests passed**（`npx vitest run src/test/m2`） |
| 沙盒 | `node .agents/tasks/outline-context-scene/ux/run-demo.mjs` → M2 截图 9 张（`ux/shots/m2-*.png`），transcript 完整 |
| 文档 | 走查：`ux/walkthrough.md` §9；本报告：`ux/m2-verification.md` |
| 全量测试（串行） | `npx vitest run --maxWorkers=1` → **115 files passed + 1 skipped；2314 tests passed + 1 skipped**（连续 2 次） |
| 全量测试（默认并行） | ✅/❌ 偶发：3 次中 1 次全绿、2 次各 2 个 load-sensitive 失败（详见 §5） |
| typecheck / build | ✅ `npm run typecheck` 无输出；✅ `npm run build` 146ms（主 chunk 542.03 kB < 550） |

---

## 3. 验收矩阵（task-23 要求）

### 3.1 S1 归档批次与设置（15 独立用例，`m2-s1-archive-batch.contract.test.ts`）

| 验证点 | 结果 | 证据（用例） |
| --- | --- | --- |
| 常量：5 章/批、24h、key 按作品拼接 | ✅ | 「一批最多 5 章、24h 轮转、键按作品拼接」 |
| 新批写回、可读回一致 | ✅ | 「没有批次时新建并写回」「批次写回后可读回同一对象」 |
| 同章幂等复用（草稿↔完成来回切） | ✅ | 「同一章重复归档复用原批次、不重复、不写回」 |
| 4/5 章接批、第 6 章轮转 | ✅ | 「未满 5 章时接在同一批；第 6 章开新批」 |
| 24h 边界（=24h 复用 / +1ms 轮转） | ✅ | 「24h 边界：恰好 24h 复用同一批」「超过 24h 1ms：开新批」 |
| 作品隔离 | ✅ | 「按作品隔离」 |
| 坏 JSON/结构容错、读写抛错不崩 | ✅ | 「非 JSON/结构不对当没有处理」「读/写抛错不抛」 |
| 设置默认 true/true、局部更新、persist key | ✅ | 「默认」「update 局部更新并持久化」「重新读取」 |

### 3.2 S2 归档服务（10 独立用例，`m2-s2-archive-chapter.contract.test.ts`）

| 验证点 | 结果 | 证据（用例） |
| --- | --- | --- |
| 一次 extract-settings 调用出摘要 + 进展 + 条目；failOnTruncation；同 batch | ✅ | 「extract-settings 一次…摘要/进展/条目同 batch」 |
| 摘要 payload（openThreads 合并、appearingEntries 解析为 id） | ✅ | 同上 |
| 同章重跑幂等（摘要 1 条、进展就地更新、条目不重复） | ✅ | 「同章重跑…」 |
| 同批跨章同名条目合并（字段/别名/溯源并集，只 1 条） | ✅ | 「同批同名条目合并…」 |
| 同批进展只 1 条（S2b） | ✅ | 同上断言 `novel` target 只有 1 条 |
| 普通条目 ≤3/章、人物新条目另 3 条豁免 | ✅ | 「上限与人物豁免」 |
| extractEntries=false 走 chapter-summary，只出摘要/进展 | ✅ | 「extractEntries=false…」 |
| 条目截断 → 摘要专用降级 + `entriesDegraded` | ✅ | 「条目提取被截断：降级…」 |
| 失败不写库、不建批；空正文拒绝且不调模型 | ✅ | 「模型失败…一条提案都不写」「正文为空」 |
| supersedePendingChapterSummary 只清本章 | ✅ | 「只清本章 pending 摘要」 |
| 5 章共用 batchId、第 6 章换批 | ✅ | 「同批最多 5 章共用 batchId」 |

### 3.3 S3 编辑器后台归档 UI（10 独立用例，`m2-s3-editor-archive.test.tsx`）

| 验证点 | 结果 | 证据（用例） |
| --- | --- | --- |
| done 触发一次后台归档、不弹 Sheet、不阻塞编辑、状态行完成 | ✅ | 「状态行从运行到完成…编辑不阻塞」 |
| StrictMode 只归档一次 | ✅ | 「StrictMode 下标记完成只归档一次」 |
| [查看] 打开「本章档案待确认」；关闭不写库、状态行保留 | ✅ | 「关闭…不写任何东西」 |
| 采用本批档案后摘要/进展/条目落库、状态行清空 | ✅ | 「采用本批档案后…」 |
| autoArchive=false 不调用、提示手动补摘要；补摘要可手动打开 | ✅ | 「autoArchive=false…」 |
| 未配置模型不调用、提示去设置 | ✅ | 「未配置模型…」 |
| 失败显示原因、重试成功恢复 | ✅ | 「归档失败…重试」 |
| 挂载恢复 pending（待确认 + 查看、不重跑） | ✅ | 「打开已有 pending 档案…不发新请求」 |
| 大纲节点完成提示点击才写（父卷不动） | ✅ | 「同节点章节全部完成…点击后才写」 |

### 3.4 S4 生成差额与继续补写（7 独立用例，`m2-s4-continue-writing.test.tsx`）

| 验证点 | 结果 | 证据（用例） |
| --- | --- | --- |
| 短稿显示「比目标少约 X 字」+ 继续补写 + 不凑字数说明；不自动发请求 | ✅ | 「短稿显示…不会自动发第二次请求」 |
| 完整且 ≥85% 不提示 | ✅ | 「完整且达到目标 85%」 |
| 85% 边界（=2550 不提示 / 2549 提示 451 字） | ✅ | 「85% 边界」 |
| 续写请求体：history=原 user+当前正文、剩余字数指令、max_tokens=4400 | ✅ | 「第二次请求带 history…」 |
| 结果空行追加、可再次补写、不自动循环 | ✅ | 「补到 85% 以上后提示消失」 |
| 续写截断：仍「生成未完成」、可再补、第三次 max_tokens 下限 4096 | ✅ | 「续写被截断」 |
| 补写中停止：保留已补部分、标未完成、采用二次确认 | ✅ | 「补写中「停止生成」」 |

### 3.5 S5 设置页（3 独立用例，`m2-s5-settings.test.tsx`）

| 验证点 | 结果 | 证据 |
| --- | --- | --- |
| 「写作辅助」Section、两个默认勾选开关、成本说明 | ✅ | 「展示写作辅助…」 |
| 关闭自动归档：store + localStorage 持久化 | ✅ | 「关闭自动归档…」 |
| 关闭条目提取：独立生效、两次都持久化 | ✅ | 「关闭条目提取…」 |

### 3.6 沙盒（真浏览器，假模型）

更新后的 `run-demo.mjs` 增加 M2 段：非流式 mock 通过 user prompt 内容区分 outline-expand / **extract-settings**；流式按 messages 条数区分整章生成 / **继续补写**。一次运行：**after 截图 11 张 + M2 截图 9 张**，mock 请求 7 次（3 结构化含 2 次归档；4 流式含 1 次继续补写），页面异常 0。走查步骤、可见文案与截图索引见 `ux/walkthrough.md` §9。

| 截图 | 内容 |
| --- | --- |
| `m2-01-archive-status-mobile.png` | 标完成 → 后台状态行「摘要 + 2 条知识库更新待确认」+ 查看；大纲节点可完成提示 |
| `m2-02-archive-inbox-mobile.png` | 本章档案待确认：摘要（新增）/全书进展（替换）/船夫/茶博士（新增），采用本批档案（4） |
| `m2-03-archive-accepted-mobile.png` | 采用后状态行清空 |
| `m2-04/05-*-desktop.png` | 1280×800 归档状态行与 inbox（桌面形态） |
| `m2-06-settings-helper-mobile.png` | 写作辅助两个开关 + 成本说明 |
| `m2-07-autoarchive-off-mobile.png` | 关闭后标完成只提示可手动补摘要（不发请求） |
| `m2-08-continue-prompt-mobile.png` | 「比目标少约 2342 字…」+ 继续补写 + 不凑字数说明 |
| `m2-09-continue-result-mobile.png` | 继续补写后 2758 / 目标 3000，「生成完成」且差额提示消失（不自动继续） |

> 假数据提醒：归档摘要/条目与补写正文都是脚本写死的演示数据；`m2-08/09` 的差额与字数仅为演示。

---

## 4. 零迁移与范围核对

| 项 | 结果 |
| --- | --- |
| `src/data/dexie/db.ts`、`src/domain/schema.ts`、`src/features/export/backup.ts`、`src/domain/entrySearch.ts` 的 diff | ✅ 全部为空（批次/设置只存 localStorage，符合 D7） |
| M2 新增文件 | `archiveBatch.ts/test`、`archiveSettings.ts/test`、`archiveChapter.ts/test`、`ArchiveInboxSheet.tsx`（全部在 plan 范围） |
| M2 修改文件 | `ChapterEditorScreen`、`ChapterEditor.test`、`GenerateChapterSheet`、`GenerateChapterSheet.test`、`ChapterSummarySheet(.test)`、`SettingsPage(.test)`、`writingNorms.e2e.test`（dev 范围）；QA 另有 `src/test/m2/**`、`ux/**`、并修了自己 `src/test/m1/m1-s6-outline-subtree.contract.test.ts` 的一处并发排序断言 |
| 越界 | 未发现（无 `src/data`/`src/llm`/`src/context`/`chapterDraft` 改动；import 链路未被改） |
| DB/备份版本 | 未变；`m1-zero-migration.test.ts` 在全量中仍通过 |

---

## 5. 失败项 / 门禁问题（file:line + 复现）

**M2 功能失败项：无。** 但全量默认并行跑存在 2 个 **load-sensitive 的测试稳定性问题**（串行全绿、单文件全绿），需开发决定如何修：

1. **P1（测试本身有竞态，建议修）**：`src/features/writing/ChapterSummarySheet.test.tsx:544-546`
   - 现象：`expected [] to have a length of 1`（点击「提炼本章摘要」后立即读仓储，未等提案写入；全量并行变慢时必现，跑该文件单独 5 次全绿、串行全绿）。
   - 复现：`npm run test:run`（3 次中 2 次失败）；`npx vitest run src/features/writing/ChapterSummarySheet.test.tsx`（绿）。
   - 建议：在读取前 `await screen.findByRole('button', { name: /保存摘要/ })` 或 `await waitFor(...)` 等到提案出现（一行等待即可；功能代码无问题——归档/摘要落库路径在串行与单测下均正确）。
2. **P1'（既有用例，在更高并发/负载下偶发）**：`src/features/import/ImportScreen.test.tsx:1757`
   - 现象：字段断言偶发 `expected '船夫' to be '渡口船夫'`（M2 未修改该文件/该链路；串行与单文件通过）。
   - 复现：`npm run test:run`（偶发）；`npx vitest run --maxWorkers=1`（绿 ×2）。
   - 建议：核对该用例对异步导入流程的等待是否充分；若 CI 固定串行可先接受。
3. **已修（QA 自己的 M1 用例）**：`src/test/m1/m1-s6-outline-subtree.contract.test.ts`「replace 空 nodes」原先断言同层节点行序，并发下 `createdAt` 同毫秒时行序可能翻转——已改为排序后断言（m1 套件连续 3 次 215 passed）。

门禁结论：**功能与数据正确性通过**；全量发布门禁建议「修上述 2 处等待 → `npm run test:run` 绿」或「CI 固定 `--maxWorkers=1`」。

---

## 6. 未覆盖风险 / 限制

1. 沙盒与单测都用假模型：归档摘要/条目的文学质量、真实模型对「新人物/每章 ≤3 条」的贴合度需真机 + 真实 API Key 人工抽检（与 M1 报告 §10 同类）。
2. 归档批次状态是 localStorage 提示而非事实源：换设备/清缓存后「本批」会重开；同章幂等与 pending 合并已由测试覆盖，不会重复落库。
3. 归档期间继续编辑：归档使用点完成那一刻的正文快照（design §6.5），后续编辑不会二次归档；重开编辑器若有 pending 会恢复待确认态。
4. 后台 trigger 只在「本次会话 draft→done」；打开已 done 章节不会重跑（已测）。
5. 真机 IndexedDB/localStorage 与 jsdom 差异、移动端视觉（状态行/inbox 在 390px 的观感）需 task-24 的顾问复核与真机走查。
6. 继续补写不自动、不循环；真实模型是否「只补未落地场景」需人工抽检（文案已声明，不构成技术保证）。

---

## 7. 给文学顾问（task-24）的复核入口

1. **收工流程**：`m2-01`（后台状态行、无弹窗）→ `m2-02`（查看本批）→ `m2-03`（采用后清空）。
2. **批次/确认量**：`m2-02` 一屏 4 条（1 摘要 + 1 进展 + 2 条新人物）；`m2-05` 桌面同批第二章只剩 2 条。
3. **设置与成本**：`m2-06` 两个开关 + 「每章 1 次结构化调用」说明；`m2-07` 关闭后的状态行。
4. **继续补写是否诱导注水**：`m2-08` 的「只补未落地场景，不是凑字数；不会自动继续」+ `m2-09` 追加效果。
5. 大纲节点完成提示（`m2-01`/`m2-07` 状态行下方）是否恰当。

假数据说明同 §3.6；只评信息与流程，不评假文笔。

---

## 8. 最终复验 · task-29（P1/P2 文案打磨 + 干净工作区门禁）

> 前置：task-26（两处并行偶发修复）、task-27（归档龙套门槛）、task-28（文案打磨）全部完成，dev 停手。
> 验证时间：2026-10-27 22:52–23:01 CST；工作区在门禁前后 `git diff src | md5` 一致（无在途改动）。

### 8.1 结论：通过

M2 功能 + P1/P2 文案/轻交互全部验证通过；**默认并行全量连续 3 次全绿**（上轮两个 flaky 已修）；串行 1 次全绿；typecheck/build 通过；沙盒新文案截图 9 张重跑，页面异常 0。**建议进入 M3。**

### 8.2 P1/P2 独立验证

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 归档 extract prompt 末尾含【归档额外要求】（龙套门槛），导出常量可直接断言 | ✅ | `m2-s2-archive-chapter.contract.test.ts`：断言常量含「船夫/茶博士/龙套/已有条目…」、extract user 以「空行 + `ARCHIVE_EXTRACT_EXTRA_REQUIREMENT`」结尾；任务调用 12/12 绿 |
| 导入链路 prompt 不含该段（两链路要求相反，导入零改动） | ✅ | 同上：`buildExtractUserPrompt(...)` 不含「【归档额外要求】/龙套」且原「【本章正文】」块保留；`git diff --name-only -- src/features/import/extractSettings.ts src/features/import/importProposals.ts` 为空 |
| summary 专用路径 / 截断降级路径不带条目门槛 | ✅ | 同文件「extractEntries=false」「条目提取被截断」两用例断言 summary user 不含该段 |
| S4 差额主文案「还有场景没落地？」+ 小字差额 +「节拍已齐可直接标完成」+ 不注水说明 | ✅ | `m2-s4-continue-writing.test.tsx`「短稿显示…」新增断言（小字仍含「比目标少约 5998 字」）；7/7 绿 |
| 不完整红框两路并列（截断/中止都写「可以继续补写未落地场景，或重新生成」） | ✅ | 同文件「续写被截断」「补写中停止」两用例新增红框文案断言 |
| 编辑器状态行 / Inbox 标题改「本章摘要与设定」 | ✅ | `m2-s3-editor-archive.test.tsx` 全面同步（`DONE_ROW`、dialog name、失败/未配置文案）；11/11 绿（含新增 dismiss 用例） |
| 大纲完成提示可「知道了」隐藏、且不写节点状态 | ✅ | 新增用例「点「知道了」隐藏提示，节点状态保持未完成（不写库）」；另一用例仍覆盖「标记完成」点击才写 |
| 设置页说明补「（摘要与知识库更新，可关条目）」 | ✅ | `m2-s5-settings.test.tsx` 新增断言；3/3 绿 |
| 旧断言同步（m1-e2e-chapter-length 截断文案） | ✅ | `src/test/m1/m1-e2e-chapter-length.test.tsx` 同步「可以继续补写未落地场景，或重新生成」；m1 套件 215 passed +1 skipped，连续多次绿 |

### 8.3 干净工作区门禁（默认并行 ×3 + 串行 ×1）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run`（默认并行）第 1/2/3 次 | ✅ 均 **115 files passed + 1 skipped（116）；2319 tests passed + 1 skipped（2320）** |
| `npx vitest run --maxWorkers=1` | ✅ **115 files passed + 1 skipped；2319 tests passed + 1 skipped** |
| `npm run typecheck` | ✅ 无输出 |
| `npm run build` | ✅ 147ms（主 chunk 542.03 kB < 550） |
| 工作区稳定性 | ✅ 门禁前后 `git diff src` md5 均为 `6572b26…`（无在途改动） |

**上轮两个 flaky 已闭环**：`ChapterSummarySheet.test.tsx:544`（先等「保存摘要」）与 `ImportScreen.test.tsx:1757`（断言并入 waitFor）在默认并行下连续多次全绿；本轮默认全量 ×3 无任何失败。之前 QA 自己的 m1 并发排序断言也已改稳。

### 8.4 沙盒（新文案）

`node ux/run-demo.mjs` 一次运行：M1 after 11 张 + M2 9 张截图覆盖更新，mock 7 次（3 结构化含 2 次归档；4 流式含 1 次补写），**页面异常 0**。新文案证据：
- `m2-01`：状态行「本章摘要与设定已生成：摘要 + 2 条知识库更新待确认」+ 大纲提示「标记完成 / **知道了**」；
- `m2-02`：Inbox 标题「**本章摘要与设定待确认**」+ 4 条提案 + 采用本批档案（4）；
- `m2-08`：红框「生成被截断，内容不完整。**可以继续补写未落地场景，或重新生成**；采用只会保存已生成的部分。」+ 差额区主文案「**还有场景没落地？**」+ 小字「比目标少约 2342 字…」+「节拍已齐可直接标完成…」；
- `m2-06`：设置说明含「（摘要与知识库更新，可关条目）」；
- 走查记录 `walkthrough.md` §10（M2-after 对照表）。

### 8.5 失败项

- **无**。默认并行/串行、独立套件（m1 215 + m2 48）、typecheck、build、沙盒均通过。
- 无新增 P0/P1；无迁移（§4 检查保持有效：DB/schema/backup/entrySearch diff 为空）。

### 8.6 未覆盖风险（不变）

假模型输出质量（归档摘要/条目、补写正文）与真实模型对龙套门槛/场景补写的遵守度需真实 API Key 人工抽检；localStorage 批次跨设备不共享（设计接受）；移动端视觉/真机差异建议由文学顾问最终确认（task-30 如需）。M2 技术验证范围内**可进入 M3**。

---

## 9. 作者视角最终确认（literary-advisor，无 task-30，仅口头复核）

> 来源：literary-advisor 复核 `m2-08`、`m2-01/02` 等 after 截图后给出的结论（2026-10-27 23:0x）；未写文件、未重跑脚本。

### 9.1 结论

**改动到位，疑虑消除，无新歧义；可进 M3。** 具体认可：

1. **补写**：红框改为「可以继续补写未落地场景，或重新生成」两路并列；差额区主文案「还有场景没落地？」+ 小字字数 + 「节拍已齐可直接标完成」，话题从「差 N 字」换回「场景有没有写完」，「会把它当补戏，不会被推着凑字」。
2. **归档**：「摘要与设定」比「档案」好懂，Inbox 标题改得对。
3. **大纲提示**：「知道了」减少打扰且不写节点状态，符合预期。
4. **龙套门槛**：方向正确（有名字/有台词且再出场才建条目）；沙盒里仍有「船夫/茶博士」是假数据所致，真机需抽检模型遵守度，不算新问题。

### 9.2 顾问提出的 P2（均不阻塞，已记录给 Lead/后续文案清理）

| # | 位置 | 意见 | QA 判断 |
| --- | --- | --- | --- |
| P2-1 | S4 结果区 | 红框与差额小字**重复**同一句「可以继续补写未落地场景，或重新生成」，建议删一处 | 纯文案去重，无机制/数据影响；若修，需同步 `m1-e2e-chapter-length`/`m2-s4` 各一处断言 |
| P2-2 | 归档状态行/按钮/设置 | 状态行「本章摘要与设定已生成：摘要 + …」重复「摘要」；「采用本批档案（4）」按钮与设置标题仍用「档案」，与「摘要与设定」两套词，终稿宜统一 | 文案一致性，无功能影响；若改按钮/标题需同步 `m2-s3` 若干 dialog/button 断言 |
| P2-3 | S4 结果标题 | 2758/3000 仍标「生成完成」，建议「接近目标」 | 语义优化，无功能影响；涉及 `m1/m2` 完成态文案断言 |
| P2-4 | 龙套门槛 | 真机需抽检模型遵守度（假模型无法证明） | 同 §8.6 未覆盖风险，非新问题 |

**M2 技术验证结论不受影响：仍为通过、可进 M3。** 上述 P2 若在提交前处理，QA 可同步断言 + 重跑默认全量 ×1 + 重拍 m2 截图；若不处理，建议记入 M3 初的文案清理项。
