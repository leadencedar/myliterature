# 导入链路与章节编辑器自动分段翻译技术设计

## 1. 总览

本设计把导入翻译和章节编辑器单章翻译接入同一套“持久化源快照与稳定计划 → 顺序 claim → 条件 dispatch → 流式 envelope → 本地完整性校验 → 条件落盘 → 有序 glossary outbox → 整章 finalize”引擎。导入计划继续嵌在 `ImportDraft.translationPlan`；章节编辑器任务使用独立的 `ChapterTranslationJob` 表。模型响应只有在 `jobId + sourceHash + segmentId + attemptId + runBatchId + ownerId + leaseToken + executionEpoch` 仍然有效，envelope、单元覆盖、受保护 token、长度和接缝检查全部通过，并且事务写入成功后，才成为正式段结果。`executionEpoch` 是覆盖恢复的持久化 fencing token，恢复前的 runner 不能写进恢复后的同 ID 任务。导入正文只在整章 finalize 时替换；编辑器正文只在作者点击“采用译文”时替换。编辑器每个可写会话还必须持有持久化 `ChapterEditLease`，每次正文写入条件比较 `Chapter.contentRevision`；因此另一标签页尚未经过 800ms 防抖落库的可见编辑也能阻止旧预览采用，旧 flush 也不能覆盖后来采用的译文。

本设计已直接检查以下材料，并以当前实现约束为准：

- 调查与决策：`/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/chunked-translation-investigation/report.md`、`/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/chunked-translation-investigation/decisions.md`。
- 旧设计与评审：`/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/import-destination-sidestory/design.md`、`/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/import-destination-sidestory/design-review.md`。
- 当前需求与本轮评审：`/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/chunked-translation-implementation/requirements.md`、`/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/chunked-translation-implementation/design-verdict.json`、`/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/chunked-translation-implementation/design-review.md`。
- 产品文档：`/Users/leadencedar/Production/Project/MyLiterature/docs/产品文档.md`、`/Users/leadencedar/Production/Project/MyLiterature/docs/使用说明.md`、`/Users/leadencedar/Production/Project/MyLiterature/docs/设计方案.md`、`/Users/leadencedar/Production/Project/MyLiterature/docs/开发计划.md`。
- 领域与存储源码：`/Users/leadencedar/Production/Project/MyLiterature/src/domain/schema.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/domain/importJob.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/domain/glossary.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/domain/language.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/domain/primitives.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/context/tokens.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/data/NovelRepository.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/db.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/DexieNovelRepository.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/data/useRepoQuery.ts`。
- 导入与编辑器源码：`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/importFlow.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/splitChapters.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/worldview.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/translate.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/TranslateSheet.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/ChapterEditorScreen.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/WritingPage.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/normCheck.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/ui/Sheet.tsx`。
- LLM 与备份源码：`/Users/leadencedar/Production/Project/MyLiterature/src/llm/types.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/useLlm.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/OpenAiCompatibleClient.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/sse.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/errors.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/taskProfiles.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/proseTail.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/export/backup.ts`。
- 现有测试：`/Users/leadencedar/Production/Project/MyLiterature/src/domain/importJob.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/domain/glossary.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/splitChapters.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/worldview.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/importFlow.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.test.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.destination.test.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.norms.test.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/translate.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/ChapterEditor.test.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/DexieNovelRepository.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/export/backup.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/OpenAiCompatibleClient.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/sse.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/proseTail.test.ts`。

当前源码确认了几项会约束实现的事实：`ImportScreen` 仍按整章请求并在结果后改写整个 draft；`TranslateSheet` 的进度只在 React state；`ChapterEditorScreen` 使用 800ms 防抖且当前 `flush` 会吞掉错误；`updateChapter` 是字数重算的唯一入口；`useRepoQuery` 的显式失效只覆盖同一 JS 上下文；SSE parser 不上报 `[DONE]` 且忽略坏 JSON 帧；Dexie 当前最高 v7；备份当前 v4；作品级 glossary 已实现模型结果先到先得和作者显式值优先。

### 1.1 技术栈锁定

技术栈保持 `/Users/leadencedar/Production/Project/MyLiterature/package.json` 中的实际版本：React 19.3.0、TypeScript 7.0.2、Vite 8.3.0、Dexie 4.4.6、Zod 4.6.5、Vitest 5.0.1、Tailwind 4.3.3、Zustand 5.0.15。应用继续纯前端运行，数据留在 IndexedDB，模型请求直接发往作者配置的 OpenAI 兼容端点。不新增 npm 依赖、后端、worker、开发服务器依赖或新的服务进程。

新实现只使用现有工具和浏览器标准能力：`TextEncoder`、`crypto.getRandomValues`、Dexie 事务、现有 `fetch`/SSE 客户端。grapheme 边界**不**依赖宿主 `Intl.Segmenter`：项目内置并锁定 Unicode 15.1 的 UAX #29 V1 breaker，见第7.1节。SHA-256 使用项目内同步 TypeScript 实现并用标准向量测试。选择同步实现是因为当前 Zod 快照校验和 `parseBackup` 都是同步入口；仅依赖异步 `crypto.subtle` 会迫使整个备份 API 改成异步，也无法覆盖非安全上下文。

## 2. 编辑器任务持久化方案选择

| 维度               | 独立 `ChapterTranslationJob` 表                     | 嵌入 `Chapter`                                          | 复用 `ImportJob`                                         |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| 同章一个未结束任务 | `&chapterId` 唯一索引直接保证                       | 每章天然只有一个字段，但普通正文 patch 容易覆盖嵌套任务 | 当前 `&novelId` 只能保证一书一行，不能表达同书多章并存   |
| 不同章节任务共存   | 每章一行，可并存                                    | 可以                                                    | 必须推翻现有一书一个导入任务的索引和阶段模型             |
| 与导入隔离         | 完全隔离                                            | 完全隔离                                                | 编辑器任务会与导入 drafts、destination、提取阶段争用一行 |
| 最小事务写         | 逻辑上只合并一个 job/segment；正文行不动            | 每段完成都重写含正文的 Chapter 行，与自动保存争用       | 每段完成重写体积更大的 ImportJob，并与提取进度争用       |
| stale              | `updateChapter` 同时检查独立任务，职责清晰          | 正文更新和任务更新在同一对象里，普通 patch 风险高       | 需要跨任务形态检查 Chapter，语义混杂                     |
| attempt/lease 隔离 | 每章独立 lease，不阻塞别章                          | 可做，但与每次自动保存写同一行                          | 一书热点，不必要地串行化不同章节                         |
| 引用完整性与级联   | 任务有明确 `novelId/chapterId` 外键；删除时显式级联 | 随 Chapter 删除，但无法独立检查或合并冲突               | 删除一章要扫描多种任务形态                               |
| 备份与合并         | v5 显式任务数组，可逐行验证与拒绝冲突               | 老应用可能剥掉嵌套字段；正文覆盖也会带走任务            | 与导入进度共槽，无法可靠区分冲突                         |
| 后续演进           | 独立冲突单元，适合未来同步                          | 正文和任务形成高频同一冲突单元                          | 一书一行持续放大，导入与编辑器生命周期绑死               |

选择独立 `ChapterTranslationJob` 表，并将 Dexie 精确升级到 v8。它用唯一索引落实同章互斥，把作者正文和付费任务进度分开，也为 sticky stale、lease、级联删除、备份冲突与未来同步提供明确边界。嵌入 `Chapter` 的代码量较少，但会把 800ms 自动保存与每个分段结果放在同一行竞争；复用 `ImportJob` 则直接破坏不同章节任务共存和导入隔离。

`applied` 与 `abandoned` 不长期留历史行。采用时在同一事务中改 Chapter 并删任务；放弃时条件删除任务。任务行不存在就是这两个终态的持久化表示，任何旧响应都会因 `jobId` 不存在而被拒绝。

## 3. 模块边界与总数据流

### 3.1 新增共享模块

- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/tokenEstimate.ts`：承载现有 `estimateTokens` 的原样实现。`/Users/leadencedar/Production/Project/MyLiterature/src/context/tokens.ts` 重导出它并保留 `formatTokens`，既有调用结果逐字不变。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/graphemeBreakV1Data.ts`（新增）：以生成但已检入的紧凑 range table 保存 Unicode 15.1 的 `Grapheme_Cluster_Break`、`Extended_Pictographic` 与 `Indic_Conjunct_Break` 属性；它没有运行时下载、`Intl` 或 npm 依赖。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/graphemeBreakV1.ts`（新增）：完全按 UAX #29 Unicode 15.1 的 GB1–GB13/GB9c 规则计算 UTF-16 grapheme boundary、计数和 slice；创建、二分、恢复、备份校验只调用它。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/translationPlan.ts`：同步 SHA-256、基于 `graphemeBreakV1` 的边界、Markdown 扫描、初始切分、source unit、V1 长度比例资格判定、二分、计划不变量、进度、重试决策和覆盖恢复的 `executionEpoch` 正规化纯函数。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/backupSnapshot.ts`（新增）：`BackupError`、备份版本与未经 default 的 raw `data` 输入、legacy/v5 分流、v5 required-key 预检及共享的严格 snapshot parser；UI 与仓储只可通过它取得规范化快照。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/translationProtocol.ts`：控制行、增量 envelope parser、`containsTranslationProtocolSyntax`、受保护 token、reference/比例/接缝校验，以及 raw response 到候选结果的转换。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chapterEditLease.ts`：编辑器会话 owner/token 生成、有限 lease 生命周期、`contentRevision` 条件写入结果的 React 无关类型与 helper；不持有正文或翻译状态。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/importWorldview.ts`：承载现有世界观打包算法；`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/worldview.ts` 原名重导出，保证无翻译路径输出不变。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chunkedTranslation.ts`：稳定 system prompt、易变 user prompt、作品级 glossary 装载和只读流式预览适配。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chunkedTranslationRunner.ts`：不依赖 React 的顺序调度器，注入 repository、LLM、clock、sleep 和事件回调，便于精确单测。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/useChunkedTranslationRunner.ts`：React 包装，拥有每次挂载用 `crypto.getRandomValues` 生成的 tab/runner `ownerId`、`AbortController`、runner generation、heartbeat、轮询和卸载清理。这个 `ownerId` 在该挂载发起的每个 run batch 与 lease 中保持一致；刷新或重新挂载生成新值。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/useChapterEditLease.ts`：章节编辑器挂载时取得、每 30 秒续租、卸载后尽力释放独占编辑 lease；只有它报告 `acquired` 时 textarea 和会改变正文的操作才可写。它不替代翻译 runner 的 lease，二者的 owner/token 分开生成。

### 3.2 一次模型尝试的数据流

1. 作者点击开始、继续或重试。仓储只会在 caller 提供当前 `expectedExecutionEpoch` 时为该 runner 创建新的 run batch，或在它已持有同 epoch 的未过期尝试时返回现有 batch；打开页面、恢复任务、轮询和 lease 到期本身都不产生模型调用。`ownerId` 由当前挂载的 runner 生成，在其 batch 与每个 lease 中相同；新建的 `runBatchId` 也必须由同一安全随机源生成。两个 authorize 方法均先检查当前 plan：同 owner 已持有未过期 running attempt 时幂等返回其现有 batch ID；其他 owner 持有时返回 `busy/expiresAt`，不写任何 batch。导入授权还必须扫描同一 `ImportJob` 的所有 plan，任何其他 owner 的未过期 running attempt 都使整次授权 busy，防御异常旧实例在后续 draft 留下的 lease。没有 running attempt 时，授权会先把没有 current attempt 的旧 active batch 标 `aborted`，再创建新的 batch。编辑器只给该 plan 写一个新 batch。导入授权生成一个 `runBatchId`，并在同一 `ImportJob` 内每个 `decision='translate'`、尚有未解决叶子的 plan 写一份同 ID、同 owner、同 `executionEpoch` 的 `TranslationRunBatch`；各 plan 的 `treeCalls` 与 `extraCallsUsed` 仍各自计数。这样每个导入 plan 的 `TranslationScope(kind='import', draftIndex)` 都能引用同一 batch ID，同时仍以 `draftIndex` 精确定位自身计划，不把不同章节的成本上限混在一起。任一导致该导入 scope 停止的事件（作者暂停、当前 plan 的终态失败或预算耗尽）必须按第9.3节同时结束同 ID 的未启动 sibling batch，不能让刷新后把后续 draft 误显示为仍在运行。`TranslationRunBatch.id` 的唯一性只要求在单个 `TranslationPlan` 内成立；同一导入授权跨 draft 复用这个 ID 是有意的，v5语义校验不得把这种跨 plan 重复当作冲突。
2. runner 先按源序执行候选晋升与 outbox 对账。claim 与 reconcile 都在仓储事务内调用第6.2节唯一的 `earlierSourcesSettled` 谓词；它不仅检查已有 pending outbox，还会把尚未产生 outbox 的更早有效叶和更早 draft 视为未结算。runner 的正常顺序只是体验层优化，绝不是 glossary first-wins 的唯一防线。
3. 仓储从数据库最新行选择最早可处理叶子，原子创建 attempt 与有限 lease。此时 `dispatchedAt=null`，不增加任何调用计数。
4. runner 读取最新 style、作品 glossary 和知识条目别名，构建 references、稳定 system 与易变 user。任何本地读取、prompt、配置或 nonce 校验失败都先 abort 未 dispatch 的 claim，不计模型调用。
5. `/Users/leadencedar/Production/Project/MyLiterature/src/llm/useLlm.ts` 只把 `TextRunOptions.beforeRequest` 转交给 `LlmClient.streamChat`。`/Users/leadencedar/Production/Project/MyLiterature/src/llm/OpenAiCompatibleClient.ts` 在 `post` 内先完成 base URL/API Key/fetch 可用性校验、请求 URL、headers 和 `JSON.stringify(buildBody(...))`，然后 await 该 hook，最后才调用 `fetch`；hook reject 必须在 fetch 的网络错误 catch 之外原样向上抛。runner 传入的回调只会在 `beginTranslationDispatch` 返回 `kind='dispatched'` 后 resolve；`paused`、`budget-exhausted` 或 `not-applied` 会被包装为 runner 私有的 `TranslationDispatchBlocked` 并抛出。因此这个受控 reject 绝不产生 fetch，也绝不能被当作网络失败再调用 `failTranslationAttempt`。runner 捕获它后按其中 union 更新 UI：预算分支使用仓储已完成的零调用清理，paused/not-applied 分支只重读。
6. 流式 parser 只把 unit 正文作为“未验证流式内容”展示。EOF 后以完整 raw content 和 `finishReason` 调用仓储 complete，流式 UI 自己不能宣告成功。
7. 仓储重新读取当前 job，以及由 import `draftIndex` 或 chapterId 精确定位的 plan、segment、attempt、lease 和 Chapter。它在事务中重跑全部校验。接缝前驱已完成时可直接写正式 `done + outbox`；前驱未完成时只写 `awaiting-predecessor` 候选，不写正式译文或 outbox。
8. runner 按源序晋升可检查接缝的候选，再把 outbox 幂等合并到作品 glossary。随后才允许 claim 下一段。
9. 全部有效叶子正式 done、编辑器 outbox 全 applied、导入 translate 决策下 outbox 全 applied，并且没有 running/failed 叶或 `awaiting-predecessor` 的 current candidate 时，仓储重读整棵计划并原子 finalize。`rejectedCandidateHistory` 不属于该阻塞条件。

## 4. 计数口径、数据模型与 Dexie

### 4.1 固定口径与常量

“Unicode 字符”锁定为 grapheme cluster。所有 3000/4000/500 限制、reference 长度与 UI 完成字符数都按 grapheme 计算。持久化范围仍用 JavaScript UTF-16 `[start,end)`，只能落在 **`graphemeRules='uax29-15.1'`** 的 boundary 上。

V1 的 boundary 权威是项目内的 UAX #29 Unicode 15.1 实现，而不是浏览器/操作系统附带的 ICU。`graphemeBreakV1Data.ts` 是从 Unicode 15.1 的 `GraphemeBreakProperty.txt`、`emoji-data.txt` 和 `IndicConjunctBreak.txt` 生成并检入的不可变压缩 range table；`graphemeBreakV1.ts` 以 code point 迭代并实现 GB1–GB13 和 GB9c，返回 UTF-16 offsets。它覆盖 CR/LF/Control、Hangul、Extend/ZWJ、Regional Indicator、Extended Pictographic 和 Indic conjunct，不读取 `Intl.Segmenter`。创建、unit 切分、二分、reference 截取、semantic restore 和 v5 校验都调用同一个 V1 函数。未来 Unicode 规则只能通过新的 `TranslationPlan.version` 和新的 `graphemeRules` 进入；V1 计划永远继续用这套已检入的 15.1 数据与代码重算，不能被宿主升级重切或误拒。

`TranslationPlanV1.policy` 只持久化会影响既有计划切分、验证和成本解释的值：

| 字段                                                     |                 值 |
| -------------------------------------------------------- | -----------------: |
| `targetGraphemes` / `hardGraphemes` / `maxSourceTokens`  | 3000 / 4000 / 1200 |
| `unitTargetGraphemes` / `unitHardGraphemes`              |          600 / 800 |
| `minAutoSplitGraphemes` / `maxAutoSplitDepth`            |            500 / 2 |
| `maxTreeCallsPerBatch` / `maxExtraCallsPerBatch`         |              7 / 6 |
| `ratioSourceTokens` / `minTokenRatio` / `maxTokenRatio`  |  200 / 0.30 / 3.00 |
| `seamDuplicateGraphemes`                                 |                 40 |
| `previousSourceGraphemes` / `previousTargetGraphemes`    |          240 / 240 |
| `nextSourceGraphemes` / `previousChapterTargetGraphemes` |          160 / 240 |
| `maxGlossaryTerms` / `maxGlossaryTermCodeUnits`          |          100 / 160 |

以下值不写进 policy，而是 `plan.version === 1` 的协议常量。未来改变它们不重切、不重解释已保存的 source ranges：lease 120000ms、续租 30000ms、跨标签轮询 2000ms、network/429/5xx 退避分别 750/1500/1000ms，以及下述raw输出公式、控制行语法和边界搜索窗口。`isRatioEligibleV1` 的分类规则和阈值同样由 V1 协议锁定，但它的布尔结论在创建/二分时写进每个 segment；恢复不按后续实现重新分类，语义校验只用同一 V1 函数复算并比对。恢复 V1 计划时必须使用这组固定实现，测试直接锁定。

raw 输出 code-unit 上限为 `min(65536, max(16384, sourceCodeUnits * 4 + 8192))`。超过时立即 abort 流并按验证失败处理。

### 4.2 完整 Zod 形状

下列 schema 放在 `/Users/leadencedar/Production/Project/MyLiterature/src/domain/schema.ts`。所有未标 `.default` 的字段为必填；时间继续使用 epoch 毫秒。代码展示的是锁定后的字段集合，`superRefine` 语义见第 5 节。

```ts
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const TranslationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const SecureHexIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);

const TranslationPolicyV1Schema = z.object({
  targetGraphemes: z.literal(3000),
  hardGraphemes: z.literal(4000),
  maxSourceTokens: z.literal(1200),
  unitTargetGraphemes: z.literal(600),
  unitHardGraphemes: z.literal(800),
  minAutoSplitGraphemes: z.literal(500),
  maxAutoSplitDepth: z.literal(2),
  maxTreeCallsPerBatch: z.literal(7),
  maxExtraCallsPerBatch: z.literal(6),
  ratioSourceTokens: z.literal(200),
  minTokenRatio: z.literal(0.3),
  maxTokenRatio: z.literal(3.0),
  seamDuplicateGraphemes: z.literal(40),
  previousSourceGraphemes: z.literal(240),
  previousTargetGraphemes: z.literal(240),
  nextSourceGraphemes: z.literal(160),
  previousChapterTargetGraphemes: z.literal(240),
  maxGlossaryTerms: z.literal(100),
  maxGlossaryTermCodeUnits: z.literal(160),
});

const TranslationProtectedTokenSchema = z.object({
  kind: z.enum([
    'inline-code',
    'url',
    'template',
    'html-tag',
    'markdown-marker',
    'line-prefix',
    'numeric-literal',
  ]),
  value: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
});

const TranslationUnitSchema = z.object({
  id: TranslationIdSchema,
  kind: z.enum(['translatable', 'verbatim']),
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().nonnegative(),
  // [sourceEnd, separatorEnd) 由程序逐字符恢复，不交给模型生成
  separatorEnd: z.number().int().nonnegative(),
  sourceHash: Sha256Schema,
  protectedTokens: z.array(TranslationProtectedTokenSchema).default([]),
});

const TranslationFailureSchema = z.object({
  kind: z.enum([
    'network',
    'rate-limit',
    'server',
    'auth',
    'insufficient-balance',
    'bad-request',
    'config',
    'truncated',
    'empty-output',
    'output-too-large',
    'envelope',
    'unit-coverage',
    'protected-token',
    'length-ratio',
    'reference-repeat',
    'seam-duplicate',
    'unsplittable-atom',
    'split-limit',
    'budget-exhausted',
    'storage',
    'lease-lost',
    'invariant',
  ]),
  message: z.string().min(1).max(300),
  diagnostic: z.string().max(500).default(''),
  finishReason: z.string().max(64).nullable().default(null),
  at: TimestampSchema,
});

const TranslationLeaseSchema = z.object({
  ownerId: SecureHexIdSchema,
  token: SecureHexIdSchema,
  acquiredAt: TimestampSchema,
  renewedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});

const TranslationReferenceSchema = z.object({
  kind: z.enum(['previous-source', 'previous-target', 'next-source', 'previous-chapter-target']),
  text: z.string().min(1),
});

const TranslationAttemptSchema = z.object({
  id: SecureHexIdSchema,
  runBatchId: SecureHexIdSchema,
  // 当前执行世代；覆盖恢复会递增 plan.executionEpoch，使旧网络回调不能复用同一身份
  executionEpoch: z.number().int().nonnegative(),
  nonce: SecureHexIdSchema,
  identityBinding: Sha256Schema,
  references: z.array(TranslationReferenceSchema).max(4).default([]),
  mode: z.enum(['normal', 'strict']),
  trigger: z.enum(['base', 'validation-retry', 'transport-retry', 'split-child', 'manual-retry']),
  costClass: z.enum(['base', 'extra']),
  status: z.enum(['running', 'candidate', 'done', 'failed', 'aborted', 'superseded']),
  lease: TranslationLeaseSchema, // 历史 attempt 也保留原 lease，不清空
  startedAt: TimestampSchema,
  dispatchedAt: TimestampSchema.nullable().default(null),
  finishedAt: TimestampSchema.nullable().default(null),
  finishReason: z.string().max(64).nullable().default(null),
  failure: TranslationFailureSchema.nullable().default(null),
});

const TranslationUnitResultSchema = z.object({
  unitId: TranslationIdSchema,
  text: z.string(),
});

// 仅约束模型派生值；作者在译名管理中手工维护的 GlossaryEntrySchema 保持原有自由度。
const TranslationModelGlossaryEntrySchema = z.object({
  source: z.string().trim().min(1).max(160),
  target: z.string().trim().min(1).max(160),
});

// current candidate 只表示尚待前驱接缝校验的结果；其存在与 awaiting-predecessor 一一对应。
const TranslationCandidateSchema = z.object({
  attemptId: SecureHexIdSchema,
  runBatchId: SecureHexIdSchema,
  leaseToken: SecureHexIdSchema,
  unitResults: z.array(TranslationUnitResultSchema).min(1),
  translatedText: z.string().min(1),
  // 已按当前 segment 的 translatable source core 锚定；reference 中的名称不能进入这里。
  glossaryTerms: z.array(TranslationModelGlossaryEntrySchema).max(100),
  // 协议合法但不在当前 source core 的词条只计数、不持久化原文/译文，也不导致整段重试。
  unanchoredGlossaryTermCount: z.number().int().min(0).max(100).default(0),
  createdAt: TimestampSchema,
});

// 只供诊断/复制的历史结果，绝不重新进入调度、正式正文、outbox 或 finalize 条件。
const TranslationRejectedCandidateSchema = TranslationCandidateSchema.extend({
  failure: TranslationFailureSchema,
  rejectedAt: TimestampSchema,
});

const TranslationOutboxSchema = z.object({
  id: TranslationIdSchema,
  segmentId: TranslationIdSchema,
  attemptId: SecureHexIdSchema,
  runBatchId: SecureHexIdSchema,
  originLeaseToken: SecureHexIdSchema,
  // 只含当前 translatable source core 已锚定的模型词条；作者手工词表不走此 schema。
  terms: z.array(TranslationModelGlossaryEntrySchema).max(100),
  unanchoredGlossaryTermCount: z.number().int().min(0).max(100).default(0),
  // discarded 只可存在于 import + decision=use-source，容器/decision 矩阵见第6.2和第5节。
  status: z.enum(['pending', 'applied', 'discarded']),
  createdAt: TimestampSchema,
  appliedAt: TimestampSchema.nullable().default(null),
  discardedAt: TimestampSchema.nullable().default(null),
});

const TranslationSegmentSchema = z.object({
  id: TranslationIdSchema,
  rootSegmentId: TranslationIdSchema,
  parentId: TranslationIdSchema.nullable().default(null),
  childIds: z.tuple([TranslationIdSchema, TranslationIdSchema]).nullable().default(null),
  splitDepth: z.number().int().min(0).max(2),
  kind: z.enum(['translatable', 'verbatim']),
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().positive(),
  sourceHash: Sha256Schema,
  sourceGraphemeCount: z.number().int().positive(),
  sourceTokenEstimate: z.number().int().nonnegative(),
  // V1 classifier result; build/split writes it once and restore never reclassifies a valid plan.
  ratioEligible: z.boolean(),
  units: z.array(TranslationUnitSchema).min(1),
  status: z.enum(['pending', 'running', 'awaiting-predecessor', 'done', 'failed', 'split']),
  activeAttemptId: SecureHexIdSchema.nullable().default(null),
  winningAttemptId: SecureHexIdSchema.nullable().default(null),
  attempts: z.array(TranslationAttemptSchema).default([]),
  candidate: TranslationCandidateSchema.nullable().default(null),
  rejectedCandidateHistory: z.array(TranslationRejectedCandidateSchema).default([]),
  unitResults: z.array(TranslationUnitResultSchema).default([]),
  translatedText: z.string().default(''),
  outbox: TranslationOutboxSchema.nullable().default(null),
  lastError: TranslationFailureSchema.nullable().default(null),
  completedAt: TimestampSchema.nullable().default(null),
});

const TranslationRunBatchSchema = z.object({
  id: SecureHexIdSchema,
  ownerId: SecureHexIdSchema,
  // 新 batch 必须等于创建时 plan.executionEpoch；历史 batch 可保留旧世代供审计
  executionEpoch: z.number().int().nonnegative(),
  status: z.enum(['active', 'paused', 'failed', 'completed', 'exhausted', 'aborted']),
  treeCalls: z
    .array(
      z.object({
        rootSegmentId: TranslationIdSchema,
        calls: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  extraCallsUsed: z.number().int().nonnegative().default(0),
  // 某次 dispatch 恰好到达上限时先让该请求 settle，再停全部后续请求
  stopAfterCurrent: z.enum(['tree-calls', 'chapter-extra-calls']).nullable().default(null),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable().default(null),
});

const TranslationPlanV1Schema = z.object({
  version: z.literal(1),
  // V1 saved ranges must be interpreted by the checked-in UAX #29 15.1 breaker, never host ICU.
  graphemeRules: z.literal('uax29-15.1'),
  policy: TranslationPolicyV1Schema,
  jobId: IdSchema,
  sourceText: z.string(),
  sourceHash: Sha256Schema,
  sourceCodeUnitLength: z.number().int().nonnegative(),
  sourceGraphemeCount: z.number().int().nonnegative(),
  sourceLanguage: z.enum(['zh', 'en', 'mixed', 'unknown']),
  targetLanguage: z.literal('zh-CN'),
  decision: z.enum(['translate', 'use-source']),
  status: z.enum(['paused', 'running', 'failed', 'done']),
  revision: z.number().int().nonnegative(),
  // 每次任务语义写都+1，供破坏性确认做乐观并发；不参与in-flight attempt合法性
  mutationVersion: z.number().int().nonnegative().default(0),
  // 覆盖恢复专用 fencing token。replace 每次严格递增，绝不回绕；所有 runner 写入都带 expectedExecutionEpoch。
  executionEpoch: z.number().int().nonnegative().default(0),
  initialSegmentIds: z.array(TranslationIdSchema).min(1),
  initialTranslatableSegmentCount: z.number().int().nonnegative(),
  segments: z.array(TranslationSegmentSchema).min(1),
  runBatches: z.array(TranslationRunBatchSchema).default([]),
  activeRunBatchId: SecureHexIdSchema.nullable().default(null),
  pauseRequested: z.boolean().default(false),
  totalCallCount: z.number().int().nonnegative().default(0),
  totalExtraCallCount: z.number().int().nonnegative().default(0),
  finalText: z.string().nullable().default(null),
  lastError: TranslationFailureSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable().default(null),
});

export const TranslationPlanSchema = TranslationPlanV1Schema;
```

`revision` 只在 split、decision 切换和 finalize 时递增；它保护段树解释。`mutationVersion` 在claim、dispatch、renew、attempt settle、候选晋升、outbox、split、decision、stale和finalize等每次任务语义写入时递增，用于放弃/use-source/rebuild/apply确认期间的乐观并发，但in-flight complete不比较它，避免合法renew或另一段落盘使已付费响应失效。`executionEpoch` 与这两个版本号职责不同：它只在覆盖恢复的合法正规化中严格递增，且被写进 attempt、batch、identity binding 和每个 runner-scoped 条件写；所以恢复前持有完全相同 job/segment/lease 的回调仍必然失败。`graphemeRules` 则是 saved UTF-16 ranges 的解释版本：V1 恒为 `'uax29-15.1'`，创建和任何恢复/备份校验都调用同一已检入 breaker，绝不改由宿主 `Intl` 决定。attempt-scoped操作由更细的attempt/lease/outbox identity和execution epoch共同防并发。

`TranslationCandidate` 只表示“响应其余校验已通过，但直接前驱还没正式 done，暂时无法做 seam 检查”的**当前**非正式结果。它不得进入 `translatedText`、outbox、previous tail、进度完成数或 final text。语义校验强制 `segment.candidate !== null` 当且仅当该对象是有效 translatable 叶且 `segment.status === 'awaiting-predecessor'`；其 attempt 必须是同段的 `candidate` 历史 attempt。前驱完成后仓储晋升它。若 seam 失败，事务把可复制的 unit/text/术语和 `seam-duplicate` failure 追加到 `rejectedCandidateHistory`，再清空 current `candidate`，把 candidate attempt 改为 `failed`、segment 改为 `failed`。历史项只供诊断，永不产生 outbox、不能阻止 retry、split 或 finalize；严格重试成功后它仍是历史，二分时只留在父段，不复制给子叶。

`TranslationModelGlossaryEntrySchema` 是模型输出的持久化形状边界：parser 先 trim 后校验每侧 1–160 UTF-16 code units，candidate、rejected history 与 outbox 都只能存该 schema 的结果，最多 100 条。它不替代也不收紧作者手工编辑的 `GlossaryEntrySchema`；reconcile 只把已验证、已规范化的模型 terms 交给既有 `mergeGlossary`。

**形状合格不等于有资格写作品词表。** `translationProtocol.ts` 在 envelope/单位/受保护 token 校验通过后调用 `filterAnchoredModelGlossaryTerms(sourceText, segment.units, parsedTerms)`：对每个 term 使用既有 `normalizeGlossarySource`（trim + lowercase），只有其非空 key 在**同一个**当前 `unit.kind='translatable'` 的 `[sourceStart,sourceEnd)` core 的归一化文本中连续出现时才保留。不会把多个 unit 拼成 haystack，也不读取 separator、verbatim unit、previous/next/previous-chapter reference、prompt glossary 或模型译文。协议合法但无锚定的 term 不使正文失败、不重试；函数从 candidate/outbox terms 删除它，只把数量写入 `unanchoredGlossaryTermCount` 供受控 UI/诊断显示，绝不保存该无关 term 的 source/target。`unanchoredGlossaryTermCount + glossaryTerms.length <= 100` 是语义不变量。仓储 complete、candidate promotion、reconcile、v5 replace/merge 都重新检查每个保留 term 的同一 source-core 锚定；作者在译名管理中手工写入的 `GlossaryEntrySchema` 完全不受此限制。

### 4.3 `ImportDraft.translationPlan` 与兼容 default

`ImportDraftSchema` 增加：

```ts
translationPlan: TranslationPlanSchema.nullable().default(null);
```

数据库实体和 v1-v4 备份使用这个 default；v5 备份另有 required-key schema，不能复用该默认，见第 14 节。兼容规则如下：

- 缺字段的 v7 行 parse 后为 `null`，不做 ImportJob 行迁移。
- 新建纯中文 draft 保持 `null`，不计算 hash、不建 segment、不 claim lease。
- 新建外文 draft 在 `saveImportDrafts` 写入前构建 `decision='translate'` 的计划，但创建计划不产生请求。
- 旧 `done + null` 视为旧版已完成，不重译。
- 旧 `pending/failed + null` 只在作者点击继续或重试后，以原子初始化选择 `translate` 懒创建计划。
- 旧 `none + null` 且正文仍需翻译时是“未决定”。UI 必须先让作者逐章选择 `translate` 或 `use-source`，并以同一原子初始化事务把该选择与完整 source 快照、稳定计划及旧章级镜像一起持久化；不得先创建默认 translate 计划再另行切换。

进行中的新计划始终满足 `draft.content === plan.sourceText` 且 `draft.sourceContent === ''`。只有 finalize 才把 `content` 换成完整译文并写完整原文；use-source 始终把 `content` 解析为完整 `plan.sourceText`，不混用完成段。

### 4.4 `Chapter.contentRevision`、`ChapterEditLease` 与 `ChapterTranslationJob`

`ChapterSchema` 增加持久化正文版本：

```ts
contentRevision: z.number().int().nonnegative().default(0),
```

它只在 `content` 的逐字符值实际改变时由仓储加一；标题、状态、`sourceContent` 单独修正和重复保存同一正文不增加。普通旧行经 v8 migration 补 `0`，v1–v4 备份经 legacy default 补 `0`，但 v5 文件必须显式携带该键。`contentRevision` 不是时间戳，也不由客户端自行加一。

编辑会话使用独立且**不进备份**的运行时表，而不是把临时 owner 放进 Chapter 或翻译任务：

```ts
export const ChapterEditLeaseSchema = z.object({
  // 主键也是 chapterId；同一章在存储层只能有一份未过期编辑会话
  chapterId: IdSchema,
  novelId: IdSchema,
  ownerId: SecureHexIdSchema,
  token: SecureHexIdSchema,
  acquiredAt: TimestampSchema,
  renewedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
```

lease 为 120000ms，挂载的 `ChapterEditorScreen` 每 30000ms 续一次。它是单章独占写能力，而不是协作编辑数据：另一个 owner 在 lease 未过期时只能只读、看到到期时间并可稍后重试；不能输入、创建/继续/重试翻译、采用、生成替换或保存正文。关闭时先尽力 flush，再释放；崩溃、后台杀掉或释放失败后有限到期。`BroadcastChannel` 可以提示其它标签立即重读，但唯一权威是以下仓储事务中的 lease token、expiry 和 `contentRevision` 比较。

任何正文写入都必须走专用条件 API：当前编辑器写入要求“当前 owner/token 的未过期 lease + expectedContentRevision”；非编辑器的章节 proposal 写入要求“expectedContentRevision + 没有未过期编辑 lease”，可以连带写现有可编辑元数据但不得伪造 `sourceContent/sourceLanguage`；翻译采用要求前者再加任务/source/preview 条件。旧的通用 `updateChapter` 从此只接受不含 `content/sourceContent/sourceLanguage/contentRevision` 的元数据 patch，不能成为覆盖正文的旁路。条件不满足时数据库不写，调用者保留本地文本并显示冲突而非重试旧 patch。

```ts
export const ChapterTranslationJobSchema = z
  .object({
    id: IdSchema,
    novelId: IdSchema,
    chapterId: IdSchema,
    chapterTitleSnapshot: z.string().max(200).default(''),
    status: z.enum(['active', 'paused', 'failed', 'completed-preview', 'stale']),
    plan: TranslationPlanSchema,
    // 只保存自动组装的完整生成版；作者在 textarea 的手工编辑不保证跨关闭保存
    previewText: z.string().nullable().default(null),
    previewCreatedAt: TimestampSchema.nullable().default(null),
    staleFrom: z.enum(['active', 'paused', 'failed', 'completed-preview']).nullable().default(null),
    staleReason: z.literal('chapter-content-changed').nullable().default(null),
    staleAt: TimestampSchema.nullable().default(null),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .superRefine((job, ctx) => {
    if (job.plan.decision !== 'translate') {
      ctx.addIssue({
        code: 'custom',
        path: ['plan', 'decision'],
        message: '编辑器翻译任务不支持 use-source',
      });
    }
    job.plan.segments.forEach((segment, segmentIndex) => {
      if (segment.outbox?.status === 'discarded') {
        ctx.addIssue({
          code: 'custom',
          path: ['plan', 'segments', segmentIndex, 'outbox', 'status'],
          message: '编辑器翻译任务不允许 discarded outbox',
        });
      }
    });
  });
```

必须满足 `id === plan.jobId`，且 editor container 的 `plan.decision === 'translate'`，并且每个 editor outbox 都只能是 pending/applied，不能是 discarded。非 stale job 的 `Chapter.content` 必须逐字符等于 `plan.sourceText`，hash 也必须一致。`completed-preview` 要求 plan done、所有 outbox **applied**，且 `previewText === plan.finalText`。stale 可以保留完整 preview 或完成段以供查看/复制，但不能继续、对账、finalize 或采用。`authorizeChapterTranslationRun`、`finalizeChapterTranslationJob`、`applyChapterTranslationJob` 与所有 `scope.kind='chapter'` 条件写在事务中再次断言该 decision；发现非法旧行或绕过 schema 的直接写入时返回明确 `invariant`，不把它归一化成 use-source、不发请求、不改正文或 glossary。

数据库/legacy快照用的 `RepositorySnapshotSchema` 同时增加 `chapterTranslationJobs: z.array(ChapterTranslationJobSchema).default([])`；该default只用于旧数据库行和v1–v4备份，v5文件使用第14.2节的required版本。`Chapter.contentRevision` 属于 Chapter 本身，随快照导出；`chapterEditLeases` 是设备内存/IndexedDB 协调状态，不进入 `RepositorySnapshot` 或 v5 文件，覆盖恢复时明确清空，见第14节。

### 4.5 Dexie v8

在 `/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/db.ts` 增加：

```ts
chapterTranslationJobs!: Table<ChapterTranslationJob, string>;
chapterEditLeases!: Table<ChapterEditLease, string>;

this.version(8)
  .stores({
    chapterTranslationJobs: 'id, novelId, &chapterId',
    // chapterId 是主键，天然限制同章一份活动编辑会话；novelId 供删除时级联
    chapterEditLeases: 'chapterId, novelId',
  })
  .upgrade(async (tx) => {
    // 只补并发元数据，不改 content/sourceContent/sourceLanguage 或任何正文语义
    await tx.table('chapters').toCollection().modify((chapter) => {
      chapter.contentRevision ??= 0;
    });
  });
```

`chapterTranslationJobs.id` 隔离新旧任务；`novelId` 支持整书级联与备份；唯一 `&chapterId` 从存储层保证同章最多一条未结束任务。`chapterEditLeases` 的 `chapterId` 主键从存储层保证同章一位可写 owner；过期记录可以由下一个 acquire 原子覆盖。两表都不按状态建索引，因为读取只按 chapter 或 novel。v8 的唯一行修改只给旧 Chapter 补 `contentRevision:0`，不改任何正文、原文、翻译任务或 ImportJob；升级测试必须逐字段比较既有正文相关字段。

级联必须和现有章节删除保持同一事务边界：`deleteChapter` 的读写事务加入 `chapterTranslationJobs + chapterEditLeases`，先按 `chapterId` 删除二者再删 Chapter/summary；`deleteSideStory` 已先由 `sideStoryId` 索引取得所有 chapter IDs，事务同样加入两表并对这些 IDs `bulkDelete`；`deleteNovel` 的表列表与并行删除列表加入两表并按 `novelId` 清理。`exportSnapshot` 的全表数组只加入 `chapterTranslationJobs`，刻意不导出 edit lease；replace/merge `importSnapshot` 的事务表数组加入两表，replace 必须清空 lease，merge 必须检查它。这样任何删除完成后都不会留下可被迟到响应命中的 editor job 或可被旧 flush 误用的编辑 capability。

## 5. 语义不变量与责任层

| 不变量                                                                                                                                                                                                                                                     | 强制层                                                                                  | 说明                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| source 快照、UTF-16 长度、V1 `graphemeRules`、grapheme 数和 SHA-256 一致；全部 persisted endpoint 必须由项目内 UAX #29 15.1 breaker 认定为 boundary                                                                                                        | 领域校验；仓储写前；v5 快照校验                                                         | 不信外部数据或宿主 ICU；V1 ranges 跨浏览器/Unicode 升级保持同一解释                         |
| 有效叶范围无洞、无重叠，可逐字符重建 source                                                                                                                                                                                                                | 领域校验；split/finalize；备份                                                          | 所有入口共用一份算法                                                                        |
| 每个 segment 的 `ratioEligible` 等于其保存 source/units/table atoms 的 `isRatioEligibleV1` 结论；verbatim 恒为 false                                                                                                                                       | 创建/二分；领域校验；v5快照校验                                                         | 已保存计划不会因后来启发式变化而改变比例检查资格                                            |
| split 父有且仅有两个连续子范围，父不参与拼接                                                                                                                                                                                                               | 领域校验；split 事务                                                                    | 防双计进度和正文                                                                            |
| running segment 恰有一个 active running attempt 和 lease                                                                                                                                                                                                   | claim/abort/失效事务；快照校验                                                          | lease 可因时间流逝过期，但对象必须仍在；过期不等于 done                                     |
| 任一 attempt 的 lease owner 等于其 `runBatchId` 对应 batch owner，且 attempt/batch 的 executionEpoch 相同、不得大于 plan.executionEpoch                                                                                                                    | authorize/claim/renew/complete；快照校验                                                | owner 标识持有 runner；epoch 抵御覆盖恢复前的同身份回调                                     |
| `activeRunBatchId` 仅指向未结束 active、且 `executionEpoch === plan.executionEpoch` 的 batch；terminal batch 必有 endedAt                                                                                                                                  | authorize/pause/fail/finalize/replace；快照校验                                         | 关闭、预算、恢复和完成后不会把历史batch当作可继续授权                                       |
| 同一 ImportJob 跨 plan 重复的 runBatchId 有相同 owner 与 executionEpoch                                                                                                                                                                                    | import authorize；v5快照校验                                                            | 仅共享授权可复用batch ID，不能把不同runner或恢复前历史伪装成同一 scope                      |
| import 的每次 plan-scoped 条件写先以 `draft.index` 精确定位 plan，且 identityBinding/identity 中的 locator 一致                                                                                                                                            | runner、全部 import 仓储事务；v5快照校验                                                | 相同 sourceHash、segmentId 或 attemptId 不得使写入落到另一 draft                            |
| locator 命名空间无歧义：每个 `ImportJob.drafts[].index` 是连续的 `1..N`；plan 内 segment/runBatch/outbox ID 唯一，segment 内 unit/attempt ID 唯一；`initialSegmentIds`、树、attempt/candidate/outbox 与 `treeCalls` 的所有引用恰好命中所属 plan 的唯一对象 | 创建/二分/初始化；完整语义校验；所有仓储语义写；v5/prospective merge                    | 不把随机 ID 的通常行为当作约束；遇到重复或悬空 locator 不得取第一个                         |
| 每个 `outbox.status='applied'` 都在其写 glossary 的同一事务满足 `earlierSourcesSettled`；更早有效叶未 done/outbox 未 applied、或更早 import draft 未整体结算时，后段只能保留 pending outbox，不能 first-wins                                               | claim/reconcile；完整语义校验；v5/prospective merge                                     | 正常 runner 顺序不是安全前提；直接调用 reconcile 同样零 glossary 写入                       |
| 导入提取收尾的最终 entry/progress/style Proposal 与删除 `ImportJob` 同一事务完成                                                                                                                                                                           | `finalizeImportExtraction`；fake-indexeddb 事务测试                                     | 崩溃或并发 finalizer 只留下“任务仍在且无本次最终提案”或“任务已删且恰一套确定 ID 提案”       |
| done segment 对旧尝试不可变                                                                                                                                                                                                                                | complete/promotion 条件写                                                               | 旧响应不能降级、清空或改写                                                                  |
| awaiting 有效叶恰有一个 current candidate，且没有正式正文/outbox；其他状态 current candidate 必为 null                                                                                                                                                     | complete/promotion/retry/split；快照校验                                                | seam 未验证前失败关闭，历史 rejected diagnostic 不参与完成条件                              |
| rejectedCandidateHistory 只引用本段已 `failed` 的 seam candidate attempt，重建 source-unit 映射且不含协议语法，不能形成 outbox、tail、进度或 finalize 阻塞                                                                                                 | promotion/retry/split；快照校验                                                         | 付费失败输出可诊断/复制，但不能污染正式状态                                                 |
| glossary 只来自正式 winning done attempt，模型派生 term trim 后均为 1–160 code units、每容器至多100条，且每个保留 source 必须命中当前 segment 的单个 translatable source core                                                                              | parser、complete/promotion/reconcile；v5快照校验                                        | reference 或模型臆造名称只能计数丢弃，不能 first-wins 污染作品词表                          |
| `unanchoredGlossaryTermCount + glossaryTerms/terms.length <= 100`，且 candidate/history/outbox 的每个 term 都能由其 segment source core 重验                                                                                                               | parser、complete/promotion、reconcile；v5快照校验                                       | 无锚定词不持久化其内容，作者手工 glossary 不受限                                            |
| outbox 状态满足容器/decision 矩阵：editor 与 translate plan 无 `discarded`；use-source import 无 `pending`；timestamp 与 status 一一对应                                                                                                                   | use-source/reconcile/finalize；`ChapterTranslationJobSchema`；v5快照校验                | discarded 只能解除 import use-source 的顺序阻塞，永不跳过 editor 或 translate glossary 同步 |
| 同章最多一个编辑器 job                                                                                                                                                                                                                                     | Dexie `&chapterId`；create/rebuild；备份/merge                                          | UI disabled 不是并发防线                                                                    |
| 编辑器容器计划恒为 `decision='translate'`                                                                                                                                                                                                                  | `ChapterTranslationJobSchema.superRefine`；全部 editor 仓储入口；v5/prospective快照校验 | import 专属 use-source 绝不能进入 editor 状态机                                             |
| Chapter 正文只能由持有未过期 `ChapterEditLease` 且命中 `contentRevision` 的编辑写入，或由无活动编辑 lease 的条件式系统写入                                                                                                                                 | `writeChapterContent`/apply 事务；v8与v5校验                                            | 任何延迟 flush 或旧确认都不能盲写正文                                                       |
| 章节正文首次变化后 job sticky stale                                                                                                                                                                                                                        | 编辑器同步本地 guard；`markChapterTranslationStale`；正文条件写事务；所有 job 写入口    | 覆盖本标签可见未落盘编辑、其他标签已落盘编辑和普通内容写入口                                |
| 覆盖恢复前的 runner 无权写入恢复后计划                                                                                                                                                                                                                     | `executionEpoch` identity；replace正规化；所有 runner-scoped事务                        | 仅保留已验证结果，恢复后必须以新 epoch 明确继续                                             |
| destination 不接收 unresolved 外文章节                                                                                                                                                                                                                     | commit 仓储事务                                                                         | 绕过 UI 也必须原子拒绝                                                                      |
| model-derived正式文本不含协议语法；source-origin fence只能原样出现                                                                                                                                                                                         | parser、complete、finalize、apply                                                       | 统一调用非行锚定检查并用verbatim来源图豁免原文                                              |
| 世界观路径不创建或修改 Chapter                                                                                                                                                                                                                             | `commitImportWorldview` 事务只开所需非 Chapter 表；提取 patch 不开 Chapter              | 从事务范围证明零 Chapter                                                                    |

`TranslationPlanSchema.superRefine` 调用 `/Users/leadencedar/Production/Project/MyLiterature/src/domain/translationPlan.ts` 的同步语义校验。`translationPlan.ts` 只能以 `import type` 引用 schema 导出的类型，不能在运行时反向导入 `TranslationPlanSchema` 或其他 schema value；Zod 的字段形状先在 `schema.ts` 解析，再把结构化值交给纯语义校验，避免 ESM 循环初始化。它用 `graphemeBreakV1` 重算 source、V1 boundary、ranges、units、`ratioEligible`、父子树、attempt/lease、executionEpoch、current candidate/rejected history、锚定后的 model glossary terms、outbox状态矩阵、计数和 final text。

身份命名空间由同一 checker 显式验证，不能靠 `find()` 的数组首项或随机碰撞概率：`segments[].id` 在 plan 内唯一；`initialSegmentIds` 无重复、按 source 顺序，且与全部 `parentId===null` 的 root segment 恰为同一集合；root 的 `rootSegmentId===id`，每个 child 的 parent/root/depth、双向 `childIds` 与范围都一致且无环。每个 segment 内 `units[].id` 和 `attempts[].id` 各自唯一；plan 内 `runBatches[].id` 与全部非空 `outbox.id` 各自唯一。每个 `activeAttemptId`、`winningAttemptId`、candidate/rejected-history `attemptId`、outbox 的 `segmentId/attemptId/runBatchId/originLeaseToken`、`treeCalls.rootSegmentId` 和 `activeRunBatchId` 都必须精确指向所属 plan 中唯一且语义相容的对象；同一 batch 内 `treeCalls.rootSegmentId` 无重复，且只能指向该 plan 的 initial translatable root。`initialTranslatableSegmentCount`、每 batch 的 root call 计数和 dispatched attempt 历史也必须相符。跨 plan 复用只允许同一 ImportJob 的同一 import 授权复用 **batch ID**，并仍要求 owner/epoch 一致；segment、outbox 和其它 ID 不获得跨 plan 定位资格。

`ImportJobObjectSchema.superRefine` 在上述局部校验外，要求 `drafts` 的 index 恰为连续 `1..N`，`chapters` 的 chapterId/index、worldview chunks 的 index 和 entryDraft key 都不重复；每个 nested plan 的 `jobId` 必等于父 job。`RepositorySnapshot`/v5 checker 还要求 ImportJob 的 id 与 novelId、ChapterTranslationJob 的 id 与 chapterId 各自唯一。创建、二分、legacy 初始化和分章保存通过同一 allocator/validator 生成或确认这些集合；任何翻译语义写入先完整 parse 最新容器，定位 helper 必须返回“恰好一个”或 `invariant`，绝不选择第一个匹配项。普通数据库读取可以为性能不逐行 parse，但任何翻译语义写入、导入提取条件写、备份导出和备份导入都必须 parse 最新行。重复/悬空 identity 在仓储入口返回 task-fatal `invariant`、在 v5/merge/replace 返回 `BackupError`，并且零写入。

## 6. 状态机

### 6.1 segment、attempt 与 candidate

| 对象                 | 允许迁移                                             | 条件                                                                                                          |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| translatable segment | `pending/failed → running`                           | claim 创建新 attempt 与 lease；旧 expired attempt 同事务 supersede                                            |
| translatable segment | `running → done`                                     | 已 dispatch，完整校验和 seam 均通过，事务落盘成功                                                             |
| translatable segment | `running → awaiting-predecessor`                     | 除 seam 外全部通过，但直接前驱 translatable 叶未 done；仅存 candidate                                         |
| translatable segment | `awaiting-predecessor → done/failed`                 | 前驱 done 后仓储重做 seam；成功正式晋升；失败原子归档 rejected candidate、清 current candidate 后记 seam 错误 |
| translatable segment | `running → pending`                                  | 普通 abort、覆盖恢复/任务失效，或暂停时回收 `dispatchedAt=null` 的 pre-dispatch claim；正式字段不写           |
| translatable segment | `running → failed`                                   | 校验或 transport 失败且该 attempt 身份仍合法                                                                  |
| translatable segment | `running/failed → split`                             | current candidate 必为 null；原子创建两个 child，父终态                                                       |
| verbatim segment     | `pending → done`                                     | 计划创建时由程序写 exact source，无 attempt、调用和 outbox                                                    |
| attempt              | `running → done/failed/candidate/aborted/superseded` | 历史 lease 永远保留；`dispatchedAt=null` 的 attempt 只能 aborted/superseded                                   |
| candidate attempt    | `candidate → done/failed`                            | 与 segment 晋升结果一致                                                                                       |

直接前驱是 verbatim 时不跨过它做 seam；该方向没有 seam 前驱。进入 awaiting 时，attempt 转 `candidate` 并写 `finishedAt`，segment 清 `activeAttemptId`、保存唯一 current candidate，active batch 视为该调用已 settle；因此 awaiting 不持有活跃 lease。`promoteTranslationCandidate` 的 seam 失败必须在同一事务把候选完整复制到 `rejectedCandidateHistory`（含 `seam-duplicate` failure 与 `rejectedAt`）、清 `candidate`，把该 attempt 改 `failed` 并写同一 failure（既有 `finishedAt` 保留），segment 写 `status='failed'`、`activeAttemptId=null`、`winningAttemptId=null`、`lastError=failure`、`completedAt=null`；正式 unitResults/translatedText/outbox 不写。随后 runner 按第9.2节的验证失败规则决定 strict retry、二分或等待新授权。`failed → running`、`failed → split` 和任何 child 初始状态都没有 current candidate。rejected history 可以留在失败父段或随后成功的叶段中供复制，但永不参与调度、outbox、进度或 finalization。正常 runner 始终顺序 claim，因此通常不会产生 current candidate；它是为了防御备份恢复、旧实例或人工构造的合法并发状态，确保后段先返回时既不冒充 done，也不丢已付费输出。

### 6.2 outbox

- winning segment 正式 done 的同一事务创建 `pending` outbox，包括空 terms；空 outbox 也经 reconcile 标 applied，顺序逻辑只有一套。
- `pending → applied`：仅在 `decision='translate'` 的计划中，按 source 顺序与最新 glossary 在同一 Dexie 事务中合并并标记。
- `pending → discarded`：仅导入 plan 切换 use-source 的同一事务发生，表示该章暂不采用分段译文；后续**其他导入章**的源序检查把 applied/discarded 都视为已结算。
- `discarded → pending`：仅目的地提交前从 import use-source 撤销到 translate 的同一事务发生；它清 `discardedAt`，随后必须先按源序 reconcile，再允许 claim。
- applied 不回退。作者已明确写入作品级 glossary 的条目也不会因放弃任务而回滚。

状态 enum 不是容器授权。共享 semantic checker 强制以下矩阵，并同时校验时间戳：`pending` 必须 `appliedAt/discardedAt === null`；`applied` 必须仅有 `appliedAt`；`discarded` 必须仅有 `discardedAt`。任意 `decision='translate'` plan（包括所有 editor plan）禁止任何 `discarded` outbox；任意 `decision='use-source'` import plan 禁止任何 `pending` outbox，只允许既有 `applied` 或由本次切换产生的 `discarded`。`ChapterTranslationJobSchema.superRefine` 还显式拒绝 `discarded`，不能只依赖其 decision 固定为 translate。编辑器和 import translate 的 finalize 都要求**全部** outbox 为 `applied`；只有 import use-source 的全局顺序门可把 discarded 当“无需再合并”的已结算项，且它不触发 reconcile、preview 或 glossary 写入。`reconcileTranslationOutbox` 对当前 scope 若遇到不符合该矩阵的 status 返回 `invariant`，绝不把它当作无事发生而跳过。

源序的唯一权威是 `translationPlan.ts` 导出的纯函数 `earlierSourcesSettled(container, scope, targetSegmentId)`。调用它之前仓储已经用第5节的唯一性校验把 scope、draft、plan 和 target 定位为唯一对象；函数只判断 **target 之前** 的源内容，target 自身由 reconcile 的 artifact identity 单独验证。对 chapter scope，它要求同 plan 中每个更早有效叶：verbatim 必为 `done`；translatable 必为 `done` 且 outbox 为 `applied`。对 import scope，它先应用同一 draft 内规则，再按 `draft.index`（不是数组位置）检查每个更早 draft：`decision='translate'` 的 plan 必为完整 done、每个有效 leaf 按上述规则结算；`decision='use-source'` 的 plan 必无 active batch/attempt，且所有已有 outbox 都是 `applied` 或 `discarded`；没有 plan 的 draft 只在共享 `importDraftResolution` 判为已解决的旧 done 或原本无需翻译中文时才算结算。任何 pending/running/failed/awaiting leaf，done 但 pending outbox，旧外文 null plan，或无法识别的阶段一律返回 false。split 父和历史 attempt 不参与次序。

`claimNextTranslationAttempt` 和 `reconcileTranslationOutbox` 都必须在各自**同一读写事务**重读这个谓词，前者返回 `{ kind:'blocked', reason:'earlier-source-unsettled' }`，后者返回同名 blocked union，且两者均不得写 glossary、outbox 或 attempt。因而一个旧/双实例可以先把后段响应合法写成 `done + pending outbox`，但在更早 leaf 还没有 outbox、尚未 done、或更早 draft 未结算时，绝不能抢到 `mergeGlossary` 的 first-wins 优先级。v5/prospective semantic validation 也逐个检查每个 `applied` outbox 当下满足该谓词；不可能由合法历史得到的“后段已 applied、前段未结算”快照整份拒绝。

### 6.3 run batch、成本上限和 dispatch

作者每次明确开始、继续或重试创建新 batch；新 batch 和之后 claim 的 attempt 都写当前 `plan.executionEpoch`，且只有 epoch 与 plan 相同的 batch 可成为 `activeRunBatchId`。claim 只取 lease，不记调用。`beginTranslationDispatch` 在模型 fetch 前再次检查身份、executionEpoch和预算，设置 `dispatchedAt` 并增加：attempt 所属 root 的本 batch `treeCalls`、本 batch `extraCallsUsed`、plan 的 `totalCallCount`，且当 `costClass='extra'` 时增加 `totalExtraCallCount`。若该次条件检查已发现预算耗尽（例如旧实例在 claim 后已让同一 batch 停止），仓储必须在同一事务把**尚未 dispatch**的当前 attempt 标为 `aborted`、segment 恢复 `pending`、batch 标 `exhausted` 并写 `endedAt`、plan 清 `activeRunBatchId` 并转 `paused`，然后返回 `budget-exhausted`；不增加任何调用计数。身份已不属于调用方时只返回 `not-applied`，绝不清理可能已归属新 owner 的 attempt。

一个 root 在全部历史中第一次 dispatch 为 base，其余 retry 或 child dispatch 为 extra。手工继续会创建新 batch并重新获得本批自动预算，但 plan 累计次数、attempt 历史和 base/extra 事实不清零。

某次 dispatch 使 `treeCalls === 7` 或 `extraCallsUsed === 6` 时，batch 写 `stopAfterCurrent`。当前 attempt 可以 settle；必要的零请求 split、候选晋升、outbox 对账和 finalize 仍可执行。`completeTranslationAttempt`（包括写 candidate）或 `failTranslationAttempt` 使这个 attempt 到达终态时，必须在**同一事务**把带 `stopAfterCurrent` 的 batch 转 `exhausted`、写`endedAt`，并清plan的`activeRunBatchId`、转`paused`（若零成本finalize随后成功则plan可直接done）；进程在响应落盘与预算停止之间崩溃也不能留下可继续发请求的 batch。任何 root 的下一次请求都禁止，包括另一 root 尚未发出的 base 请求。`splitFailedTranslationSegment` 可以核对并接受刚由同一 attempt 结束的 exhausted batch，但其 child 只能等作者新授权后 dispatch。普通关闭仍按第6.5节把batch标为`aborted`，不伪装成预算耗尽。作者再次明确授权前调用数不增加。

所有 batch 终态都必须写 `endedAt`。没有触发暂停/预算/abort的 active batch 在整章 finalize 的同一事务中转 `completed` 并清plan active ID；自动策略已耗尽或不可重试的失败在 fail 事务中转 `failed`、清active ID并使plan failed；仍有自动 retry资格的失败保持 batch active。若plan在已 paused/exhausted batch 后仅靠candidate/outbox的零成本工作finalize，原batch保留其 paused/exhausted历史，不被改写成 completed。

### 6.4 plan、导入 decision 和编辑器 job

- plan：`paused/failed → running` 仅来自作者授权；可自动重试、二分或候选晋升的单叶失败保持 plan `running`；只有自动策略耗尽、不可重试或 invariant 错误才 `running → failed`。`running → paused` 来自暂停、普通 abort 或预算；全部正式叶与 outbox 满足条件后 `→ done`。
- 导入：`translate → use-source` 可在目的地选择前发生；`use-source → translate` 也只在目的地选择前。use-source 不是局部跳段。
- 编辑器：`ChapterTranslationJob.plan.decision` 固定为 `translate`，没有 `use-source` 迁移；`active/paused/failed → completed-preview`；任一未结束状态可 `→ stale`；completed-preview 经事务采用后删行；任一状态经确认放弃后删行。
- stale 永不回 active 或 applied，即使正文后来恢复成相同字符串也不反向激活。

导入 draft 的 `translateStatus` 只作旧 UI/旧任务兼容镜像，恢复与提交以 plan 为权威：plan paused/running（包括存在 awaiting-predecessor 叶）映射 `pending`，plan failed 映射 `failed`，plan done 映射 `done`，decision use-source 映射 `none`。null plan 保留旧语义并按第 4.3 节判定。`ImportJob.destination===null` 时，只要任一 plan 有 active batch，父 job.status 镜像为 running；其余翻译状态为 paused。目的地 commit 后，父 job.status 重新完全遵守既有提取状态机。`ChapterTranslationJob.status` 与 plan 映射为 active↔running、paused↔paused、failed↔failed、completed-preview↔done；stale 是不可逆外层状态，内部 plan 保持失效后 paused 或原有 done 以供查看。

### 6.5 统一的运行中失效转换

stale 和导入 use-source 都先复用一个“若有活跃调用则失效”的原子转换，避免留下“running segment 没有 current attempt/lease”的非法行：

1. 若存在当前 attempt，将它写 `status='superseded'`、`finishedAt=now`；历史 `lease` 保留原值。
2. 对应 segment 写 `status='pending'`、`activeAttemptId=null`；正式 done/candidate/failed 段不改。
3. active batch 写 `status='aborted'`、`endedAt=now`。
4. plan 清 `activeRunBatchId`、写 `pauseRequested=false`；原状态为running时转paused。没有active run时不伪造attempt或batch迁移。
5. stale 再把 editor job 写成 sticky stale，并保留无active run时的plan状态，所以completed-preview的plan仍为done、failed仍可供诊断。use-source则无论此前plan是否done都切decision、将plan转paused、递增revision，并把pending outbox转discarded。

普通关闭使用 attempt `aborted` 而不是 `superseded`，其余 segment/batch/plan 清理相同。已 dispatch 的 abort 调用仍保留在实际调用累计中，不把花费从计数中扣掉。

### 6.6 覆盖恢复的运行隔离

`importSnapshot(input, 'replace')` 不是把活动网络 capability 原样搬回数据库。第14.2节的 version-aware parser 严格解析 `input` 后、清表写入前，仓储复制它并对每个 `TranslationPlan` 调用 `normalizePlanForReplace(plan, restoredAt)`；原备份对象和下载文件不被就地改写。它先将 `executionEpoch` 加一，若已经达到安全整数上限则整次 restore 以 `BackupError` 零写入拒绝，绝不回绕。随后只对该 plan 的**运行中执行状态**做以下原子正规化：

1. 每个 `status='running'` 的 attempt 写为 `aborted`，`finishedAt=max(restoredAt, startedAt)`，保留原 lease、nonce、references、dispatchedAt、已记实际调用数和历史 identity；对应 active segment 写 `pending` 与 `activeAttemptId=null`，不清 done/candidate/outbox。
2. 每个由 `activeRunBatchId`、running attempt 或同一 ImportJob 共享 batch ID 关联的 active batch 写 `aborted + endedAt=max(restoredAt, startedAt)`；导入的同 ID sibling plan 必须在同一正规化调用中一起关闭，即使某个 sibling 从未 claim。
3. 清每个受影响 plan 的 `activeRunBatchId` 与 `pauseRequested`；原 `running` plan 转 `paused`。`failed`、`done`、所有正式 done 段、current candidate、rejected candidate history、pending/applied/discarded outbox、累计调用和历史 batch 均保留。每个被正规化 plan 的 `updatedAt` 与外层 ImportJob/ChapterTranslationJob 的 `updatedAt` 写 `restoredAt`，但不重写任何成功段、candidate/history、outbox或历史调用时间。恢复后的用户只能明确继续；继续创建带新 epoch 的新 batch、attempt、lease 和 identity binding。

`executionEpoch` 同时使 restore 前的**所有** runner-scoped API 调用失效，而不只是在飞模型响应：claim、dispatch、renew、complete、fail、abort、pause、split、promotion、outbox reconcile 和 finalize 都条件比较 `expectedExecutionEpoch`。旧 runner 即使持有相同 job/source/segment/attempt/lease，complete 也返回 `not-applied: restore-epoch-mismatch`；旧 runner 不能在 restore 后抢先 promotion 或 merge glossary。新挂载的 runner 先重读新 epoch，仍可零成本晋升保留 candidate、对账保留 outbox 和 finalize。页面侧 `AbortController` 与 restore 前的本地 runner registry abort 只是减少无用请求的 best effort，跨标签和回调的权威防线始终是此持久化 epoch 与状态正规化。

### 6.7 恢复解释

打开页面只解释数据库状态，不自动发请求：未过期 running 显示“另一标签页正在处理”；过期 running 显示“可继续”，但直到作者点击继续才在 claim 事务中 supersede 旧 attempt；done 不降级；awaiting 候选可做零模型成本晋升；pending outbox 可做零模型成本对账；stale 不自动恢复。

## 7. Markdown、Unicode 与硬上限安全切分

### 7.1 grapheme 和 hash

`graphemeBreakV1.ts` 是唯一可调用的 boundary authority。它以已检入的 Unicode 15.1 range data 对原始字符串按 code point 扫描，完整实现 UAX #29 的 GB1–GB13 和 Indic GB9c，并返回含 `0` 与 `text.length` 的 UTF-16 offset 数组；`countGraphemesV1`、first/last tail slice、初始切分、二分和所有 boundary assertion 都从该数组得到结果。它不读取 `Intl.Segmenter`，也没有“主机不支持时的降级”分支，因此相同 V1 source 在浏览器、OS、ICU 或 Unicode 版本不同的设备上具有相同 ranges。`Intl.Segmenter` 可以被测试 mock 为任意结果而不影响 V1 计划。

`TranslationPlanV1.graphemeRules` 必为 `'uax29-15.1'`。创建计划时写它；恢复、v5 parse、replace、merge 与任意语义写都断言该 literal，再由 V1 breaker 重新验证所有 segment/unit endpoint、sourceGraphemeCount、token-window切点和 reference slice。一个 endpoint 落在 V1 cluster 内部即为 invariant/BackupError，不能因为某个新宿主把它分成两簇而接受；已保存合法 V1 range 也不会因为宿主 `Intl` 改变而误拒。未来规则升级必须新增 plan version、数据表和明确迁移，V1 validator 不改。

SHA-256 对 `TextEncoder` 的 UTF-8 bytes 计算，输出小写 hex。计划仍保留 exact `sourceText`，所以事务还会比较原字符串；hash 不是唯一证明。

### 7.2 Markdown 原子扫描

扫描器按原始行尾记录 offset，不先 trim、归一化 CRLF 或合并空行：

1. 最多三个前导空格后，三个及以上同类反引号或波浪号开启 fenced code block。闭合符必须同字符、长度不少于开启符，且后面只有空白；未闭合围栏延伸到 EOF。整块单独成为 verbatim segment。
2. ATX 标题整行是原子；Setext 标题正文行与紧随的 `===`/`---` underline 合成原子。原子内部没有切点。
3. 列表、任务列表、引用和表格行记录不可切的行首结构范围。扫描器同时输出带 `[start,end)` 的 `MarkdownAtom`；连续表格行（含分隔行）归为 `kind='table'`，**仅**供第7.4节比例资格分类和第7.3节选择完整行边界，绝不是不可跨的 segment atom。每条 table row 都记录原始 line end、行首结构（缩进/引用/列表前缀）、可选的 leading `|`，以及全部未转义列分隔符。多行表优先只在完整行之间切；单行超过 hard cap 时在**行首结构之后**的 cell body 内按同一安全优先级切：有 leading `|` 时该 marker 随前缀留在第一片，无 leading `|` 时第一 cell 从前缀后即是可切 body。所有列分隔符仍按第8.3节当作精确 protected marker；切点须是 V1 grapheme boundary 且不得落在 token 内。若行首结构本身超过 hard cap，只有这一段结构标记被建为独立、程序原样完成的 verbatim **segment**，后续 cell body 从其末端开始成为普通受 cap 的 translatable segment；绝不把普通 prose 当作 verbatim 逃过上限。任何现有 `|`、对齐行、前缀和换行只由原始 range/受保护 token 原样恢复，程序绝不复制、补造或删去表格标记。
4. inline code、URL/link destination、template placeholder、HTML tag和显式 numeric literal先标成不可切range；候选边界落在range内部时丢弃。超长inline code/裸URL/template/HTML tag/numeric literal本身超过发送hard cap时提升为verbatim segment原样通过；普通自然语言不得借此绕过hard cap。
5. 前导纯空白和 unit 间空行作为 exact separator 或 verbatim unit 保存。
6. translatable source 中若出现协议保留前缀 `<<<MLT1|`，该原子暂停并提示将字面量放入 fenced code 或修改原文；fenced verbatim 中允许并原样复制，后续用来源图单独豁免。

fenced block 即使超过 4000 grapheme 或 1200 estimated tokens 也原样 done，不调用模型。单个标题原子超过任一发送上限时建成 failed `unsplittable-atom`，零请求并提示人工处理。无标点、无空格的自然语言串最终在 grapheme boundary 切。

任何 verbatim 范围都不得进入任何 system/user prompt，包括 current source、上一段、下一段和上一章 reference。直接相邻叶是 verbatim 时省略该方向 reference，不跨代码块寻找更远文本。

### 7.3 初始切分算法

实现预先生成 grapheme offsets、Markdown 原子和候选边界。token 权重使用与现有 `estimateTokens` 等价的整数前缀和，避免对每个候选反复扫描。

从 cursor 开始：

1. 求同时不超过 4000 grapheme 和 1200 estimated tokens 的最远 `hardEnd`。
2. 求同时不超过 3000 grapheme 和 token 限制的 `targetEnd`；剩余全文符合上限时直接取 EOF。
3. 在 `[targetEnd - min(600, floor(targetLength*0.2)), hardEnd]` 内按优先级找候选：Markdown block 结束、**完整 table row 结束**或空行结束；单换行；句界（`。！？.!?…` 及随后闭引号/括号）；分号、冒号、逗号、顿号或邻近空格；grapheme。
4. 同优先级选距离 targetEnd 最近的候选，等距取前者。没有高层候选才降级；grapheme 层保证进展。
5. 不跨 fenced code、标题原子或 protected token 等真正不可切范围。普通 Markdown 原子本身可发送时在原子前或后切；**table group 例外地不是不可切 atom**：其完整 row end 是最高优先级候选，若单 row 仍超过 hard cap，`chooseTableRowBoundary` 只在其行首结构之后的 cell body 查找句界/标点/空格/V1 grapheme fallback（leading `|` 已随前缀保留），绝不在行首结构或 protected token 内切。标题原子超限时按上一节暂停；超长表格绝不以 `unsplittable-atom` 暂停或超限发送。
6. 为范围生成持久化 segment/unit ID、hash、grapheme/token 数，以及第7.4节的 immutable `ratioEligible`。恢复只读已保存范围与资格，绝不按新常量重切或重新分类。

所有初始范围拼接必须逐字符等于 source。普通 translatable segment 同时满足两个 hard cap；fenced verbatim 和仅由病态超长 table 行首结构构成的 verbatim segment 是发送上限例外，因为它们都不发送。连续 20k table、整体超过 cap 的多行表和单个 5k table row 都必须走上述 row/cell 边界，不能退回整表 atom、UTF-16 硬切或手工处理。

### 7.4 source units、separator 与 V1 长度比例资格

每个 translatable segment 用同一边界优先级切成目标 600、普通 hard 800 grapheme 的 units；table row/cell 复用第7.3节的特殊规则，不能因为 unit 较小而切进表格前缀或 protected token。标题原子可作为一个超过 800 的 unit，但整个 segment 仍受 4000/1200 限制。每个 unit 的 core 是 `[sourceStart,sourceEnd)`，紧随空白为 `[sourceEnd,separatorEnd)`；下一个 unit 从 `separatorEnd` 开始。前导纯空白用 verbatim unit 表示。所有core、separator与verbatim unit按序无洞无重叠覆盖整个segment。重试同一 segment 时 unit IDs 永不变化。

模型只翻译 core。程序用 unit result 加 exact separator 重建 segment，避免要求模型猜换行。unit 不是模型调用单位，一个 segment 的全部 translatable units 仍在一次请求中。

`isRatioEligibleV1(segmentSource, units, markdownAtoms)` 是纯函数，创建初始段和二分 child 时各调用一次并把结果写入不可变 `segment.ratioEligible`。它不 trim 或改写 source，只为分类临时计算以下数量：

1. verbatim segment 一律 `false`。对 translatable segment，只统计 translatable unit core 的非空白 grapheme；若为 0 则 `false`。
2. 任一 translatable core 与同一 V1 scanner 标出的 Markdown table atom 相交，结果为 `false`。列表、引用和普通 Markdown 段落本身不排除资格。
3. 对每个非空白 grapheme，只要含一个 Unicode `Letter` 或 `Mark` code point 就计为 prose grapheme。prose 占比低于 40% 时为 `false`。
4. `inline-code`、`url`、`template`、`html-tag`、`numeric-literal` 是 opaque protected token。提取器已保证范围不重叠；它们 value 的 grapheme 总数达到非空白 core grapheme 的 40% 时为 `false`。`markdown-marker` 和 `line-prefix` 不计入该密度。
5. 其余 translatable segment 为 `true`。semantic checker 使用同一 source/units/atoms 重算并要求与持久化值相等；恢复只读取已保存的结论，不按未来的分类规则重写它。

因此长散文仍会进入比例校验；Markdown 表格、URL/模板/代码/数字密集的结构化段则不会因翻译语言长度差异误停。`ratioEligible=false` 只跳过第8.4节的数值比例条件，绝不跳过 envelope、unit 覆盖、token、接缝或其他完整性校验。

### 7.5 失败段二分

二分只接收当前失败 translatable 叶。以 grapheme 中点为目标，在父范围内复用同一优先级，要求两个 child 都至少 500 grapheme。候选窗口为中点两侧父长度的 20%；无语义边界时取合法 grapheme 中点。父深度已为 2、任一 child 小于 500、父是不可拆标题或找不到合法切点时返回 split-limit 并暂停。

split 事务同时完成：核对 job/source/revision/failed attempt/batch；父转 split；创建两个相接 child；写 childIds；revision + 1。两个 child 并集严格等于父。父保留自身的 attempts、lastError 与 `rejectedCandidateHistory` 作为诊断历史；因前置条件 current candidate 已为 null，不能把它带入 split。两个 child 以各自 source/units 重新计算 `ratioEligible`，并从空 attempts/current candidate/rejected history/正式结果/outbox 开始。无关 segment 的 done 结果、candidate、attempt 与 outbox 原样保留。

## 8. Prompt、流式 envelope 与完整性验证

### 8.1 协议和身份绑定

每个 attempt 使用 `crypto.getRandomValues` 生成独立 128-bit `nonce`、`attemptId` 和 `leaseToken`。`ownerId` 不是 attempt nonce：它由 `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/useChunkedTranslationRunner.ts` 在 runner 挂载时生成，并在该 runner 创建或复用的 run batch、每次 claim lease与identity中保持一致；刷新/重新挂载才更换。仓储要求当前 lease.ownerId 等于所属 batch.ownerId，避免同一 batch 的历史与当前 holder混淆。nonce 最多重抽 8 次，直到不出现在当前 source、references 和注入 glossary 中；8 次仍冲突时按 `config` 失败 abort 未 dispatch claim、零调用，不能退回到可预测值或冒险发送。安全随机源不可用时 fail closed，不发请求；不得用 `/Users/leadencedar/Production/Project/MyLiterature/src/domain/primitives.ts` 的 `Math.random` 兜底生成协议身份。

控制行均为 ASCII 且独占一行。user prompt中每个可翻译source core使用只读输入框，separator不放进去：

```text
<<<MLT1|{nonce}|SOURCE|{unitId}|BEGIN>>>
...该 unit 的原文 core...
<<<MLT1|{nonce}|SOURCE|{unitId}|END>>>
```

模型输出协议固定为：

```text
<<<MLT1|{nonce}|UNIT|{unitId}|BEGIN>>>
...该 unit 的译文...
<<<MLT1|{nonce}|UNIT|{unitId}|END>>>
<<<MLT1|{nonce}|GLOSSARY|BEGIN>>>
Source => 译名
<<<MLT1|{nonce}|GLOSSARY|END>>>
<<<MLT1|{nonce}|COMPLETE|{identityBinding}>>>
```

`identityBinding` 对版本、`executionEpoch`、nonce、jobId、container locator（导入为**持久化 `draft.index`，不是数组下标**；编辑器为 chapterId）、sourceHash、segmentId、attemptId、runBatchId 和 leaseToken逐项按“UTF-8 byte length + bytes”编码后做 SHA-256，避免分隔符歧义。导入的 scope 与所有 identity 参数也必须携带同一 `draftIndex`；不得用 sourceHash、segmentId 或随机 ID 跨 plan 搜索目标。每个预期 translatable unit 恰好出现一组 frame且顺序与 source 一致；glossary block 恰好一次，位于最后 unit 后；complete 恰好一次且其后只能有空白。

增量 parser 保留 `lineBuffer`，控制行可跨任意 stream delta。最终成功判定始终重新解析完整 raw output。parser 只剥离协议自身的结构换行，不 trim unit 正文；exact separator 由程序补回。

定义唯一函数：

```ts
export function containsTranslationProtocolSyntax(text: string): boolean {
  return text.includes('<<<MLT1|');
}
```

它是唯一的非行锚定substring检测原语。每个model-derived unit、candidate和translatable segment先直接调用，命中即拒绝。finalize还维护按leaf组成的来源图：对每个model-derived part调用同一函数；verbatim part只有在逐字符等于对应source slice时跳过。apply preview若命中前缀，则重新扫描fenced blocks；每个命中必须位于与plan中某个verbatim leaf逐字符相等、顺序和数量也一致的代码块内，否则拒绝。行首、行中、被其他文字包围或跨stream delta形成的model marker一律失败；不能用“在代码围栏里”豁免模型自己生成的内容。

### 8.2 稳定前缀与邻接上下文

`buildChunkedTranslateSystemPrompt` 复用现有文学翻译规则和 `composeStylePrefix`，并追加只含`{NONCE}/{UNIT_ID}/{IDENTITY}`占位符的固定 envelope 规则。给定同一 novel/style 时 system 逐字节稳定。实际nonce、identity、segment/unit IDs、章节位置、glossary、references 和 current source 全放 user 的易变后缀。旧 `buildTranslateSystemPrompt/buildTranslateUserPrompt` 保留输出测试，避免无关调用改变，但两个翻译入口改用新 builder。

user block 固定顺序：

1. 最新作品 glossary。先取正式 glossary，再用已确认知识条目的拉丁别名作缺项补充；作品 glossary 优先。只注入 current source 命中的条目，保持 glossary 当前顺序。
2. `【仅供衔接，不得输出】` references。
3. 当前章节标题、章序和有效叶位置。
4. 只有当前 translatable units 带可输出 ID 的 source。
5. 本次精确 output 模板与 identity；strict retry 只在 user 尾部加固定严格提醒，system 不变。

章内 reference 使用直接相邻有效叶：上一 translatable done 叶的原文尾 240 grapheme和译文尾 240 grapheme，下一 translatable 叶原文头 160 grapheme。内容不足时全取。相邻叶是 verbatim时该方向整体省略；候选slice含协议保留前缀时也省略该方向，不能把外部文本伪装成控制行送入prompt。

当前章第一个 translatable 叶没有章内前驱时，编辑器只从相同 `sideStoryId ?? null` 的较小最大 index 章节取尾部 240 grapheme，并要求该章当前 `content.trim()` 非空且 `!needsTranslationToChinese(content)`；`sourceContent` 只作历史留底，不能单独取得资格。选出的尾部若与该章重新扫描出的任一fenced verbatim范围相交，则整个上一章reference省略，不向前越过围栏或改取更早正文。导入只从同批前一 draft 的新计划 done、旧版 done 或原本中文正文取尾；外文 use-source 不算译文，候选尾部同样必须排除fence。导入第一章因目的地未定，不猜主线或外传，省略既有章节尾。

reference 没有 unit ID。规范化后不足 40 grapheme 的 reference 仍可供上下文，但不做 substring 否决；达到 40 才检查任一连续 40-grapheme 窗口是否出现在 model-derived unit 中。模型自造 reference frame 会被未知 unit ID 拒绝。

### 8.3 受保护 token

`extractProtectedTokens` 按 source offset 做最长优先且范围不重叠的提取，顺序为 inline code、URL/link destination、模板、HTML tag、行首结构、其他 Markdown marker、数字：

- 成对 inline backtick code，含 delimiter 与正文；
- `http://`、`https://`、Markdown link/image destination、autolink URL；
- `{{...}}`、`${...}`、`<%...%>`、`%%...%%`；
- HTML tag；
- 标题、引用、列表、任务列表、表格、强调、删除线与 link 结构标记；对 scanner 认定的 table row，行首结构与每个未转义列分隔符 `|` 都以 `markdown-marker` token 按源序纳入，alignment row 的 `:---`/`---:` 也逐字符受保护。
- 独立数字及带 `.-/:` 的编号、日期、版本和小数。

每个 unit 按 `{kind,value,ordinal}` 精确比较值、数量和必要顺序，不做 Unicode 或大小写归一化。严格比较可能保守失败，但不能自动保存损坏结构。

### 8.4 成功条件与候选

`validateAttemptOutput` 按以下顺序返回首个结构化错误：

1. raw 未超过动态 code-unit 上限。
2. `finishReason !== 'length'`；`stop/null/未知值` 只记诊断。
3. envelope 完整，identity 精确，complete 唯一且之后只有空白。
4. unit IDs 无缺失、重复、错序和未知；每个非空 translatable unit 的译文 trim 后非空。
5. model-derived unit 不含任意位置的协议语法。
6. verbatim unit exact；separator exact 来自 source。
7. protected tokens 值、数和顺序相同。
8. glossary block 每个非空行必须是 `source => target`，两边先 trim 再以 `TranslationModelGlossaryEntrySchema` 校验为 1–160 UTF-16 code units；最多 100 条；格式坏、空白、超限或未知尾部文本使整个 attempt 失败，不静默跳行。对语法合格的 terms，随后按第4.2节的 `filterAnchoredModelGlossaryTerms` 仅保留命中当前 segment 单个 translatable source core 的 entries；只出现在 previous/next/previous-chapter reference 或根本无关的 term 从 candidate/outbox 删除并累加 `unanchoredGlossaryTermCount`，不导致重试。
9. 仅当 `segment.ratioEligible === true` **且** `sourceTokenEstimate >= policy.ratioSourceTokens` 时，才对 translatable core 合计计算 target/source 比例（不计程序恢复的 separator/verbatim），要求在 `[policy.minTokenRatio, policy.maxTokenRatio]`。资格为 false 时跳过此数值检查，但其余条件不变；本期不提供人工绕过。
10. 每个规范化后至少 40 grapheme 的 reference，其任一 40-grapheme 窗口不得在输出中出现。短 reference 不做否决。
11. 若直接前驱 translatable 叶正式 done，规范化空白后用 KMP 求“前段后缀与本段前缀”的最长重叠，必须小于 40 grapheme。
12. unitResults + exact separators 重建非空 segment text，且其中不含协议语法。

第 1–10、12 通过而第 11 暂时无法执行时，complete 原子写 current candidate 并转 awaiting-predecessor；不是 done。前驱完成后 `promoteTranslationCandidate` 重做第 11、12 步，通过才把 candidate 搬入正式字段并创建 pending outbox；失败时在同一事务将候选归档进 `rejectedCandidateHistory`、清 current candidate、attempt/segment 均转 failed。该 failure 随即适用第9.2节的 strict retry/二分规则；diagnostic history 不会阻塞之后的成功 finalize。

`[DONE]` 不参与成功条件。没有 `[DONE]` 的干净 EOF、坏 JSON 尾帧被忽略、`finishReason=stop/null` 都不能代替业务 complete；缺 complete 必然失败。反之，完整业务 envelope 可在兼容端点未发 `[DONE]` 时成功，业务正确性不绑定服务商终止习惯。

## 9. 调度、重试、暂停和多标签

### 9.1 唯一顺序调度器

导入按 `draft.index → leaf.sourceStart` 选择，但每次实际 plan-scoped 调用都构造精确 `TranslationScope { kind:'import', novelId, jobId, draftIndex }`；共享 `runBatchId` 只标识授权批次，绝不替代 draft locator。编辑器 scope 固定到 chapter。正常流程不允许 scope 内同时有两个未过期 running attempt，不主动并行。不同 editor chapter job 可以各自运行；同章由唯一 job 和 lease 互斥。

每轮循环顺序固定：重读状态 → promote ready candidate → 对最早可对账 outbox 调 `reconcileTranslationOutbox` → 若全 done 则 finalize → 检查 pause/budget/stale/use-source → claim → 准备 prompt → dispatch → stream → complete/fail。runner 只能把 `earlierSourcesSettled` 当作提示和顺序选择；claim/reconcile 事务各自重算它，direct repository caller 不能绕过。第 2 段失败不会把第 1 段放回 current source，只能取有限 reference。

### 9.2 错误分类与动作

| 类别                                                                                     | 自动动作                                                                                                                             | 用量与终态                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `finishReason='length'`                                                                  | 不做同尺寸重试，立即只二分当前失败叶                                                                                                 | 本次计实际调用；不能二分则 failed/paused                    |
| envelope、unit、空输出、marker、protected token、比例、reference、seam、output-too-large | 同一叶生命周期内先 strict 同尺寸重试一次，第二次失败只二分该叶                                                                       | 不能二分则 failed/paused                                    |
| network、HTTP 408                                                                        | 同尺寸自动重试一次，750ms                                                                                                            | 第二次 failed/paused                                        |
| HTTP 429                                                                                 | 同尺寸自动重试一次，1500ms                                                                                                           | 第二次 failed/paused                                        |
| HTTP 5xx                                                                                 | 同尺寸自动重试一次，1000ms                                                                                                           | 第二次 failed/paused                                        |
| 401/403                                                                                  | 不重试                                                                                                                               | auth/paused，提示检查 Key/权限                              |
| 402                                                                                      | 不重试                                                                                                                               | insufficient-balance/paused                                 |
| config、400/404/405/409/415/422 及其他 4xx                                               | 不重试                                                                                                                               | bad-request/config/paused                                   |
| 用户普通关闭/卸载                                                                        | 立即 abort；attempt aborted、segment pending、batch aborted                                                                          | 已 dispatch 次数保留；正式结果为空                          |
| storage                                                                                  | 停止后续调用，内存保留 raw/可见结果；lease 有效时可“再次保存”并继续续租；lease已过期或被接管时只能查看/复制，不能绕过新attempt写done | DB 不得标 done；提示空间与备份                              |
| identity/lease/job/source 失效                                                           | 丢弃正式写资格并重读                                                                                                                 | not-applied，不写 glossary                                  |
| invariant 损坏                                                                           | 不自动修复或删除                                                                                                                     | task-fatal；导入可 use-source/放弃，editor 可查看/放弃/重建 |

验证同尺寸自动重试额度按 leaf 生命周期计算，不因新 batch 伪装成第一次；transport 自动重试额度按当前 batch 计算。作者手工“重试”可发一个 `manual-retry`，但不会重置历史计数或已用过的自动 validation retry。

### 9.3 暂停与预算

暂停是 **run batch owner capability**，不是任意看到任务的标签页都能发出的全局命令。它有“已 dispatch”和“已 claim 但尚未 dispatch”两条路径。`requestTranslationPause(scope, { expectedRunBatchId, expectedExecutionEpoch, ownerId })` 在同一事务先精确定位 scope/plan/batch，并验证 batch 为当前 active batch、epoch 一致且 `batch.ownerId === ownerId`。随后它验证每个将被改动的 current attempt 都属于同一 batch/epoch，且其 lease owner 也等于该 owner；batch 丢失/epoch 不同返回 `not-applied:run-batch-lost`，owner 或 affected attempt 不匹配返回 `not-applied:lease-lost`，两种情况均零写入。通过后才扫描该 scope：

1. 对每个 `running && dispatchedAt === null` 的 current attempt，保留历史 lease，但写 `attempt.status='aborted'`、`finishedAt=now`，对应 segment 写 `pending`、`activeAttemptId=null`。它从未走到 fetch，调用计数、treeCalls、extraCalls一律不变。
2. 对每个已 dispatch 的 current attempt，只写其 plan `pauseRequested=true`；它可以继续完整校验、落盘、candidate 晋升前置的必要状态和对账，但不做新的 retry、split 或 claim。退避 timer 立刻取消。
3. 某 plan 在步骤1后没有已 dispatch attempt 时，其 batch 在同一事务转 `paused + endedAt`、plan 清 `activeRunBatchId/pauseRequested` 并转 `paused`。有已 dispatch attempt 的 batch 维持 active 到该 attempt settle；complete/fail 的同一事务再以 paused/failed/exhausted 三者之一终结它。

对 import scope，事务先以调用方传入的 `draftIndex` 精确验证当前 plan/batch/epoch/**owner**，再按该已验证的共享 `runBatchId + executionEpoch + ownerId` 扫描同一 ImportJob 的所有 sibling plan。任何 sibling 的 pre-dispatch claim 都按步骤1释放；没有 dispatch 的 sibling 立刻 paused。若任一同 ID sibling batch 或将被触及 attempt 的 owner/epoch 不一致，视为 invariant 并整次零写入，不猜测哪个实例有权停止它。当前已 dispatch attempt settle 时，终结事务再关闭所有仍 active 的同 ID sibling batch，不能让刷新后源序之后 draft 显示为 running。对 chapter scope 上述规则只作用一个 job/plan。

`beginTranslationDispatch` 在 fetch 前重新读取 attempt、batch、plan、epoch和`pauseRequested`。若本次 claim 已因暂停被回收，或 batch/plan 已成为 paused，它返回显式 `{ kind: 'paused' }`，不调用 fetch、不加计数、不再调用 abort/fail；runner 停止本轮并重读 UI。普通关闭、换章和卸载仍走立即 abort，语义与暂停不同：当前已 dispatch请求的 abort尽力取消，batch为 `aborted`，已产生的实际调用计数不回退。

split depth 2、child 最小 500、每 root 每 batch 7 calls、每章每 batch 6 extra calls 同时检查。任一先到即在当前 attempt settle 后将 batch exhausted并停止所有后续 fetch。必要的 split、candidate promotion、outbox和finalize不花模型费用，预算耗尽后仍允许执行；split出的child在新batch授权前不得dispatch。

### 9.4 lease 与跨标签

claim lease 120 秒；同 owner 每 30 秒续到 `now+120s`。claim、renew、dispatch、complete、fail、abort、split、promotion、reconcile与finalize都要求完整 identity、`expectedExecutionEpoch`、导入时精确 `draftIndex`、未过期 lease（若该操作本来需要活跃lease）以及 owner 与对应 batch 匹配。**唯一的特化例外是 pause：**它一次可合法影响同一 batch 的多个 attempt，因而不接受某一个 leaseToken；它按第9.3节以 `expectedRunBatchId + expectedExecutionEpoch + ownerId` 作为 batch-owner capability，并逐一验证所有受影响 attempt 的 lease owner。非 owner 标签即使读到了 batch ID/epoch 也只得到 `not-applied`，不改变任何 segment、attempt 或 sibling batch。另一个标签看到未过期 lease时得到 busy和 `expiresAt`，显示“另一标签页正在处理”；本页的暂停控件禁用并说明“仅持有者可暂停”，可等待到期或让持有者停止，不静默等待或重复请求。

面板打开时每 2 秒重读，并在 `focus/visibilitychange` 立即重读。lease 释放或过期只使“继续”可用，不自动调用。新 claim 原子 supersede expired attempt并换 attempt/lease；旧 holder 随后返回时因 attempt/token/runBatch不匹配而 not-applied。

组件关闭先同步 `AbortController.abort()` 并递增本地 generation，再 best-effort 仓储 abort。即使 abort 写入失败，旧 callback 因 generation 失效不会主动 complete；即使仍调用 complete，也会在 lease 过期、新 claim或execution epoch改变后被仓储拒绝。

### 9.5 编辑 lease 与跨标签正文冲突

翻译 lease 只保护模型调用；`ChapterEditLease` 保护作者尚未落盘的正文。编辑器 mount 先 acquire，未取得 owner/token 前 textarea 为只读。其他标签持有未过期 edit lease 时，`acquire` 返回 `busy/expiresAt`，该实例不允许产生 pending content patch，也不能启动/继续/重试/采用翻译。每个成功正文 write 将数据库 `contentRevision` 加一并回传新值；所有后续 flush 必须带它。

lease 正常释放后另一标签可立刻 acquire。若旧标签在崩溃或后台后 lease 到期，新的 owner 可以写或采用；旧标签恢复时的下一次 flush 同时因旧 token和旧 revision失败，返回 `edit-lease-lost` 或 `content-conflict`，绝不覆盖新正文。UI 保留旧标签内存文本供复制、显式比较或重新加载，不能静默用数据库内容替换它。翻译 apply 也在同一个 `chapters + chapterTranslationJobs + chapterEditLeases` 事务检查 owner/token/revision，因此没有“另一个标签仍在 800ms 防抖窗口”这一盲区。

## 10. 仓储 API 与事务条件写

### 10.1 可编译结果类型

下列类型和接口声明放在 `/Users/leadencedar/Production/Project/MyLiterature/src/data/NovelRepository.ts`。预期并发冲突用 union；IndexedDB quota、事务中止和 schema invariant 等操作失败才 reject Promise。

```ts
type ImportTranslationScope = {
  kind: 'import';
  novelId: string;
  jobId: string;
  // ImportDraft.index，绝非 drafts 数组 offset；每个 plan-scoped 调用都必须带它。
  draftIndex: number;
};

type ChapterTranslationScope = {
  kind: 'chapter';
  novelId: string;
  chapterId: string;
  jobId: string;
};

type TranslationScope = ImportTranslationScope | ChapterTranslationScope;

type TranslationNotAppliedReason =
  | 'job-missing'
  | 'job-replaced'
  | 'source-changed'
  | 'draft-missing'
  | 'plan-already-exists'
  | 'not-translatable'
  | 'segment-missing'
  | 'segment-split'
  | 'attempt-lost'
  | 'lease-lost'
  | 'run-batch-lost'
  | 'outbox-lost'
  | 'stale'
  | 'use-source'
  | 'restore-epoch-mismatch'
  | 'destination-committed'
  | 'import-job-exists'
  | 'import-job-invalid'
  | 'draft-state-changed'
  | 'finalization-state-changed';

type ConditionalNotApplied = {
  kind: 'not-applied';
  reason: TranslationNotAppliedReason;
};

type MutationResult<T> =
  { kind: 'applied'; value: T } | ConditionalNotApplied | TranslationInvariantResult;

// 从 '@/domain/backupSnapshot' import type；在此重复形状只为锁定 NovelRepository 边界。
// `data` is the unnormalised wire object. Repository import must not accept only `snapshot`.
type BackupImportInput = {
  version: 1 | 2 | 3 | 4 | 5;
  data: unknown;
};

interface TranslationIdentityBase {
  expectedJobId: string;
  // 所有 runner-scoped 条件写都必须比较；覆盖恢复后旧 runner 因此失败关闭
  expectedExecutionEpoch: number;
  sourceHash: string;
  segmentId: string;
  attemptId: string;
  expectedRunBatchId: string;
  ownerId: string;
  leaseToken: string;
}

type ImportTranslationIdentity = TranslationIdentityBase & {
  // 必须等于 ImportTranslationScope.draftIndex 与 identityBinding 内的 locator。
  draftIndex: number;
};
type ChapterTranslationIdentity = TranslationIdentityBase;
type TranslationIdentityFor<S extends TranslationScope> = S extends ImportTranslationScope
  ? ImportTranslationIdentity
  : ChapterTranslationIdentity;

interface TranslationArtifactIdentityBase {
  expectedJobId: string;
  expectedExecutionEpoch: number;
  sourceHash: string;
  segmentId: string;
  expectedAttemptId: string;
  expectedRunBatchId: string;
  expectedOriginLeaseToken: string;
}

type ImportTranslationArtifactIdentity = TranslationArtifactIdentityBase & { draftIndex: number };
type ChapterTranslationArtifactIdentity = TranslationArtifactIdentityBase;
type TranslationArtifactIdentityFor<S extends TranslationScope> = S extends ImportTranslationScope
  ? ImportTranslationArtifactIdentity
  : ChapterTranslationArtifactIdentity;

// 只用于 chapter stale/rebuild/abandon 的历史 attempt 比较，故不含 draftIndex。
type ActiveAttemptExpectation = Pick<
  ChapterTranslationIdentity,
  | 'expectedExecutionEpoch'
  | 'sourceHash'
  | 'segmentId'
  | 'attemptId'
  | 'expectedRunBatchId'
  | 'ownerId'
  | 'leaseToken'
> | null;

type ImportDraftInput = Pick<ImportDraft, 'index' | 'title' | 'content'>;
/** SHA-256 over the canonical, complete parsed draft-phase ImportJob; used only for confirmed destructive discard. */
type ImportDraftStateFingerprint = string;
/** SHA-256 over the structured-clone raw row before ImportJob preprocess/defaults; only invalid-row recovery may use it. */
type RawImportJobFingerprint = string;
/** SHA-256 over the complete parsed destination-stage ImportJob at all-items-done time. */
type ImportFinalizationFingerprint = string;
type ImportFinalizationProposalInput = {
  // `entry:<sha256(draft.key)>` / `progress` / `style`; ASCII, unique within this call.
  key: string;
  proposal: Proposal;
};
type SaveImportDraftsResult =
  | { kind: 'created'; job: ImportJob }
  | {
      kind: 'invalid-input';
      reason: 'empty' | 'duplicate-draft-index' | 'draft-index-not-contiguous';
    }
  | { kind: 'not-applied'; reason: 'import-job-exists' | 'import-job-invalid' };
type DiscardImportDraftJobResult =
  | { kind: 'discarded' }
  | {
      kind: 'not-applied';
      reason:
        | 'job-missing'
        | 'job-replaced'
        | 'draft-state-changed'
        | 'destination-committed'
        | 'import-job-invalid';
    };
type DiscardInvalidImportJobResult =
  | { kind: 'discarded' }
  | { kind: 'not-applied'; reason: 'job-missing' | 'raw-job-changed' | 'job-now-valid' };
type FinalizeImportExtractionResult =
  | { kind: 'finalized'; proposalIds: string[] }
  | { kind: 'not-ready'; reason: 'extraction-unsettled' }
  | {
      kind: 'invalid-input';
      reason:
        | 'duplicate-proposal-key'
        | 'invalid-proposal-key'
        | 'proposal-id-mismatch'
        | 'proposal-invalid';
    }
  | ConditionalNotApplied;
type ImportPlanInitialization = {
  draftIndex: number;
  decision: 'translate' | 'use-source';
};

interface ChapterEditLeaseIdentity {
  ownerId: string;
  token: string;
}

type AcquireChapterEditLeaseResult =
  | { kind: 'acquired'; lease: ChapterEditLease; chapter: Chapter }
  | { kind: 'busy'; expiresAt: number }
  | { kind: 'chapter-missing' };

type ChapterContentWriteResult =
  | { kind: 'saved'; chapter: Chapter; staleJob: ChapterTranslationJob | null }
  | { kind: 'edit-lease-lost'; chapter: Chapter | null }
  | { kind: 'content-conflict'; chapter: Chapter }
  | { kind: 'editing-busy'; expiresAt: number }
  | ConditionalNotApplied;

type PauseResult =
  | { kind: 'paused'; preDispatchAborted: number; settlingAttemptId: string | null }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type TranslationInvariantResult = {
  kind: 'invariant';
  message: '编辑器翻译任务不支持 use-source' | '翻译任务状态损坏' | '翻译任务标识或引用不唯一';
};

type ClaimedAttempt<S extends TranslationScope = TranslationScope> = TranslationIdentityFor<S> & {
  nonce: string;
  identityBinding: string;
  mode: 'normal' | 'strict';
  sourceText: string;
  units: TranslationUnit[];
  references: TranslationReference[];
  chapterIndex: number;
  chapterTitle: string;
  leafIndex: number;
  leafCount: number;
  costClass: 'base' | 'extra';
};

type ClaimedTranslationFor<S extends TranslationScope> = S extends ImportTranslationScope
  ? { scope: ImportTranslationScope; attempt: ClaimedAttempt<ImportTranslationScope> }
  : { scope: ChapterTranslationScope; attempt: ClaimedAttempt<ChapterTranslationScope> };

type CreateJobResult =
  | { kind: 'created'; job: ChapterTranslationJob }
  | { kind: 'existing'; job: ChapterTranslationJob }
  | { kind: 'source-changed'; chapter: Chapter };

type InitializeImportPlansResult =
  | {
      kind: 'initialized';
      job: ImportJob;
      initialized: Array<{ draftIndex: number; decision: 'translate' | 'use-source' }>;
    }
  | {
      kind: 'invalid-input';
      reason: 'empty' | 'invalid-draft-index' | 'duplicate-draft-index' | 'invalid-decision';
    }
  | ConditionalNotApplied;

type AuthorizeResult =
  | { kind: 'authorized'; runBatchId: string }
  | { kind: 'busy'; expiresAt: number }
  | { kind: 'nothing-to-run'; reason: 'complete' | 'use-source' | 'stale' }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type ClaimResultFor<S extends TranslationScope> =
  | ({ kind: 'claimed' } & ClaimedTranslationFor<S>)
  | { kind: 'busy'; expiresAt: number }
  | { kind: 'complete' }
  | {
      kind: 'blocked';
      reason: 'earlier-source-unsettled' | 'candidate-pending' | 'failed-needs-author' | 'paused';
    }
  | { kind: 'budget-exhausted'; limit: 'tree-calls' | 'chapter-extra-calls' }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type DispatchResult =
  | { kind: 'dispatched'; callNumber: number; extraCallNumber: number }
  | { kind: 'paused' }
  | { kind: 'budget-exhausted'; limit: 'tree-calls' | 'chapter-extra-calls' }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type CompleteResult =
  | { kind: 'done'; segmentId: string; outboxId: string }
  | { kind: 'awaiting-predecessor'; segmentId: string; candidateAttemptId: string }
  | { kind: 'validation-failed'; segmentId: string; failure: TranslationFailure }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type PromoteResult =
  | { kind: 'promoted'; segmentId: string; outboxId: string }
  | { kind: 'seam-failed'; segmentId: string; failure: TranslationFailure }
  | { kind: 'not-ready' }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type ReconcileResult =
  | { kind: 'reconciled'; outboxId: string; addedTerms: number }
  | { kind: 'none' }
  | { kind: 'blocked'; reason: 'earlier-source-unsettled' }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type SplitResult =
  | { kind: 'split'; parentId: string; childIds: [string, string]; revision: number }
  | { kind: 'cannot-split'; reason: 'max-depth' | 'minimum-size' | 'unsplittable-atom' }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type FinalizeResult =
  | { kind: 'finalized'; finalText: string }
  | { kind: 'not-ready'; reason: 'leaf-unresolved' | 'outbox-unsettled' }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type ApplyTranslationResult =
  | { kind: 'applied'; chapter: Chapter }
  | { kind: 'stale'; job: ChapterTranslationJob }
  | { kind: 'editing-busy'; expiresAt: number }
  | { kind: 'content-conflict'; chapter: Chapter }
  | { kind: 'edit-lease-lost'; chapter: Chapter | null }
  | { kind: 'invalid-preview'; reason: 'empty' | 'protocol-syntax' }
  | TranslationInvariantResult
  | ConditionalNotApplied;

type ImportCommitResult =
  | { kind: 'committed'; job: ImportJob; sideStory: SideStory | null }
  | { kind: 'unresolved'; draftIndexes: number[] }
  | {
      kind: 'invalid-destination';
      reason: 'side-story-missing' | 'duplicate-side-story' | 'empty-worldview';
    }
  | ConditionalNotApplied;
```

runner 对每个 union 使用穷尽 `switch` 和 `never` 检查，不能把 `busy/not-applied/budget` 都折成通用异常。

### 10.2 接口签名

```ts
// 旧 updateChapter 只允许 title/status/outline 等元数据；传正文键必须拒绝，避免盲写。
updateChapter(
  chapterId: string,
  patch: Partial<Omit<Chapter, 'content' | 'sourceContent' | 'sourceLanguage' | 'contentRevision' | 'wordCount'>>,
): Promise<Chapter>;

acquireChapterEditLease(
  chapterId: string,
  input: ChapterEditLeaseIdentity,
): Promise<AcquireChapterEditLeaseResult>;
renewChapterEditLease(
  chapterId: string,
  input: ChapterEditLeaseIdentity,
): Promise<MutationResult<{ expiresAt: number }>>;
releaseChapterEditLease(
  chapterId: string,
  input: ChapterEditLeaseIdentity,
): Promise<MutationResult<void>>;

writeChapterContent(
  chapterId: string,
  input: {
    // editor 或 chapter proposal 可把同轮元数据一起条件落库；system 仅禁止原文留底字段，后者只由 editor guard 或专用 apply 写入
    patch: Partial<Pick<Chapter, 'content' | 'title' | 'status' | 'outlineNodeId' | 'source' | 'sourceContent' | 'sourceLanguage'>>;
    expectedContentRevision: number;
    // editor 模式要求精确 lease；system 模式仅允许没有未过期 lease（章节 proposal 使用）
    guard: { kind: 'editor'; lease: ChapterEditLeaseIdentity } | { kind: 'system' };
  },
): Promise<ChapterContentWriteResult>;

getChapterTranslationJob(chapterId: string): Promise<ChapterTranslationJob | undefined>;
listChapterTranslationJobs(novelId: string): Promise<ChapterTranslationJob[]>;
checkChapterTranslationJob(
  chapterId: string,
  input: { expectedJobId: string },
): Promise<MutationResult<ChapterTranslationJob>>;

createChapterTranslationJob(
  chapterId: string,
  input: {
    sourceText: string;
    expectedVisibleSourceHash: string;
    expectedContentRevision: number;
    editLease: ChapterEditLeaseIdentity;
    chapterTitle: string;
  },
): Promise<CreateJobResult>;

rebuildStaleChapterTranslationJob(
  chapterId: string,
  input: {
    expectedJobId: string;
    expectedMutationVersion: number;
    expectedExecutionEpoch: number;
    expectedActiveAttempt: ActiveAttemptExpectation;
    sourceText: string;
    expectedVisibleSourceHash: string;
    expectedContentRevision: number;
    editLease: ChapterEditLeaseIdentity;
    chapterTitle: string;
  },
): Promise<CreateJobResult | ConditionalNotApplied>;

initializeImportTranslationPlans(
  novelId: string,
  input: {
    expectedJobId: string;
    // 只接受尚无 plan 的 legacy draft；同一事务把选择和 plan 建立起来。
    drafts: ImportPlanInitialization[];
  },
): Promise<InitializeImportPlansResult>;

authorizeImportTranslationRun(
  novelId: string,
  input: { expectedJobId: string; expectedExecutionEpoch: number; ownerId: string },
): Promise<AuthorizeResult>;
authorizeChapterTranslationRun(
  chapterId: string,
  input: {
    expectedJobId: string;
    expectedExecutionEpoch: number;
    ownerId: string;
    expectedVisibleSourceHash: string;
    expectedContentRevision: number;
    editLease: ChapterEditLeaseIdentity;
  },
): Promise<AuthorizeResult>;

requestTranslationPause(
  scope: TranslationScope,
  input: { expectedRunBatchId: string; expectedExecutionEpoch: number; ownerId: string },
): Promise<PauseResult>;

claimNextTranslationAttempt<S extends TranslationScope>(
  scope: S,
  input: {
    expectedRunBatchId: string;
    expectedExecutionEpoch: number;
    ownerId: string;
    preferredSegmentId?: string;
  },
): Promise<ClaimResultFor<S>>;

beginTranslationDispatch<S extends TranslationScope>(
  scope: S,
  identity: TranslationIdentityFor<S>,
): Promise<DispatchResult>;

renewTranslationLease<S extends TranslationScope>(
  scope: S,
  identity: TranslationIdentityFor<S>,
): Promise<MutationResult<{ expiresAt: number }>>;

completeTranslationAttempt<S extends TranslationScope>(
  scope: S,
  input: TranslationIdentityFor<S> & { rawOutput: string; finishReason: string | null },
): Promise<CompleteResult>;

failTranslationAttempt<S extends TranslationScope>(
  scope: S,
  input: TranslationIdentityFor<S> & { failure: TranslationFailure },
): Promise<MutationResult<void>>;

abortTranslationAttempt<S extends TranslationScope>(
  scope: S,
  identity: TranslationIdentityFor<S>,
): Promise<MutationResult<void>>;

splitFailedTranslationSegment<S extends TranslationScope>(
  scope: S,
  input: TranslationIdentityFor<S> & { expectedRevision: number },
): Promise<SplitResult>;

promoteTranslationCandidate<S extends TranslationScope>(
  scope: S,
  input: TranslationArtifactIdentityFor<S>,
): Promise<PromoteResult>;

reconcileTranslationOutbox<S extends TranslationScope>(
  scope: S,
  input: TranslationArtifactIdentityFor<S> & { outboxId: string },
): Promise<ReconcileResult>;

finalizeImportDraftTranslation(
  scope: ImportTranslationScope,
  input: {
    expectedJobId: string;
    expectedExecutionEpoch: number;
    sourceHash: string;
    expectedRevision: number;
  },
): Promise<FinalizeResult>;

finalizeChapterTranslationJob(
  chapterId: string,
  input: {
    expectedJobId: string;
    expectedExecutionEpoch: number;
    sourceHash: string;
    expectedRevision: number;
  },
): Promise<FinalizeResult>;

setImportDraftTranslationDecisions(
  novelId: string,
  input: {
    expectedJobId: string;
    changes: Array<{
      draftIndex: number;
      sourceHash: string;
      expectedRevision: number;
      expectedMutationVersion: number;
      expectedExecutionEpoch: number;
      expectedActiveAttempt: ActiveAttemptExpectation;
      decision: 'translate' | 'use-source';
    }>;
  },
): Promise<MutationResult<ImportJob>>;

markChapterTranslationStale(
  chapterId: string,
  input: {
    expectedJobId: string;
    expectedExecutionEpoch: number;
    expectedVisibleSourceHash: string;
    expectedContentRevision: number;
    editLease: ChapterEditLeaseIdentity;
  },
): Promise<MutationResult<ChapterTranslationJob>>;

applyChapterTranslationJob(
  chapterId: string,
  input: {
    expectedJobId: string;
    expectedMutationVersion: number;
    expectedExecutionEpoch: number;
    sourceHash: string;
    expectedVisibleSourceHash: string;
    expectedContentRevision: number;
    editLease: ChapterEditLeaseIdentity;
    previewText: string;
  },
): Promise<ApplyTranslationResult>;

abandonChapterTranslationJob(
  chapterId: string,
  input: {
    expectedJobId: string;
    expectedMutationVersion: number;
    expectedExecutionEpoch: number;
    sourceHash: string;
    expectedActiveAttempt: ActiveAttemptExpectation;
  },
): Promise<MutationResult<void>>;

// 仅恢复 UI 读取未经 parse/default 的行；其他功能只使用已 parse 的 ImportJob。
getRawImportJob(novelId: string): Promise<unknown | undefined>;

// 创建与替换故意分离：这个入口只在数据库没有任何 ImportJob 行时 add 新任务，绝不 delete + put 已有行。
saveImportDrafts(
  novelId: string,
  input: { batchId: string; drafts: ImportDraftInput[] },
): Promise<SaveImportDraftsResult>;

// 作者在“丢弃此导入并重新分章”二次确认后才可调用；不能由旧分章页隐式重置任务。
discardImportDraftJob(
  novelId: string,
  input: { expectedJobId: string; expectedDraftStateFingerprint: ImportDraftStateFingerprint },
): Promise<DiscardImportDraftJobResult>;

// 仅恢复 UI 的二次确认出口：当前 raw 行仍无法 ImportJobSchema.safeParse 且未经默认化的 fingerprint 一致时才删。
discardInvalidImportJob(
  novelId: string,
  input: { expectedRawFingerprint: RawImportJobFingerprint },
): Promise<DiscardInvalidImportJobResult>;

// destination-stage 完成后唯一的 materialize 入口；同一事务 bulkAdd 确定 ID 的最终提案并 delete 任务。
finalizeImportExtraction(
  novelId: string,
  input: {
    expectedJobId: string;
    expectedFinalizationFingerprint: ImportFinalizationFingerprint;
    proposals: ImportFinalizationProposalInput[];
  },
): Promise<FinalizeImportExtractionResult>;

// 只用于作者明确放弃 destination 已确定的提取任务；仓储拒绝 destination===null，不能作为重新分章或 finalization 旁路。
deleteImportJob(
  novelId: string,
  input: { expectedJobId: string },
): Promise<MutationResult<void>>;

// 备份仓储边界必须收到 version + 未经 default 的 wire data，不能只收到 UI 已规范化的 snapshot。
exportSnapshot(): Promise<RepositorySnapshot>;
importSnapshot(
  input: BackupImportInput,
  mode: 'replace' | 'merge',
): Promise<void>;

commitImportChapters(
  novelId: string,
  input: {
    expectedJobId: string;
    target:
      | { kind: 'main' }
      | { kind: 'side'; sideStoryId: string }
      | { kind: 'newSide'; title: string };
    withStyle: boolean;
  },
): Promise<ImportCommitResult>;

commitImportWorldview(
  novelId: string,
  input: { expectedJobId: string },
): Promise<ImportCommitResult>;
```

`expectedMutationVersion` 是每个受影响plan的单调乐观版本，避免毫秒级`updatedAt`碰撞。`changes`必须非空且draftIndex不重复，单章操作传一个元素，批量use-source在一个ImportJob事务内全成全败。`initializeImportTranslationPlans` 同样要求 `drafts` 非空、每个 `draftIndex` 为正整数且不重复、`decision` 仅为 `translate/use-source`；违反这些输入规则返回 `{kind:'invalid-input'}` 且零写入。每项只能命中当前 `destination===null`、`translationPlan===null`、正文仍需翻译的 legacy draft；任一找不到/已初始化/不再外文则返回 typed `not-applied` 且一个也不写。事务先为所有合格项在内存构建 plan。对 `use-source`，同一事务建完整 source/segments 的 paused plan、写 decision 和 `translateStatus='none'`，保持 `draft.content===plan.sourceText`、`sourceContent=''`，**绝不**创建 batch、lease 或授权请求；对 `translate` 才写待翻译镜像。确认框打开后若另一标签又保存了segment、candidate或outbox，放弃/use-source/rebuild/apply返回not-applied并要求重读，旧确认不能删除新付费进度。若快照中存在running attempt，`expectedActiveAttempt`必须逐字段匹配当前attempt、历史lease和execution epoch；不存在时必须传null。`markChapterTranslationStale` 是正文变化的安全动作，但仍要求当前编辑会话的 owner/token、revision和epoch，以免恢复前的旧页面把恢复后的任务误标 stale；正文条件写会在同一事务重复该 stale 判断。

`saveImportDrafts` 先对 caller 的 `drafts` 做输入校验：数组非空，所有 index 正整数、无重复，并在按 index 排序后精确为 `1..N`；否则返回 `invalid-input`、不生成 ID、不写行。`buildTranslationPlan`、二分和 legacy initializer 统一通过 `allocateUniqueTranslationId(plan, namespace)` 生成 ID：安全随机值若与当前 namespace 冲突最多重抽8次，仍冲突或语义 checker 不通过则当作 invariant/storage failure，绝不把重复值写入。任何仓储 API 在 parse 后以 `requireExactlyOne` 定位 draft/segment/unit/attempt/batch/outbox；0个与多个匹配都不能退化为数组 `find()`。

无法 parse 的 raw ImportJob 不再被加载逻辑自动删除，也不能被 `saveImportDrafts`、`discardImportDraftJob` 或 `deleteImportJob` 覆盖/删除。`fingerprintRawImportJob(raw)` 以独立的 type-tagged canonical encoder 对 **未经** `upgradeLegacyImportJob`、Zod default 或 normalisation 的 structured-clone 值递归编码：null、boolean、string、有限 number、undefined、array 顺序与普通对象的排序 own-key 都区分；循环、symbol/function、非有限数或无法安全编码的值返回失败而非猜测。它再用本设计的同步 SHA-256 生成 `RawImportJobFingerprint`。`discardInvalidImportJob` 在一个 `importJobs` 读写事务内重读 raw 行，先确认 `ImportJobSchema.safeParse(raw)` **仍失败**，再比对该 raw fingerprint；匹配才删除。行消失返回 `job-missing`，行已成为合法任务返回 `job-now-valid`，任一 raw 值改变返回 `raw-job-changed`，三种均零写入。它从不删除可解析任务，也不触碰 Chapter、Proposal、glossary 或其它表。

对 import，`ImportTranslationScope.draftIndex` 与每个 `ImportTranslationIdentity`/artifact identity 的 `draftIndex` 必须相等，并且必须命中数据库中**恰好一个** `draft.index`；`ImportJobSchema` 的连续唯一 invariant 先于该查询成立。仓储再以该 locator 验证 job/source/segment/attempt/batch/lease/epoch；不得按 sourceHash、segmentId、attemptId 或共享 batch ID 遍历并选中“第一个” plan。chapter scope 不携带 draftIndex，但其 plan 内 locator 也遵循第5节 `requireExactlyOne`。`ClaimResult.kind='claimed'` 返回带类型关联的 `scope + attempt`，runner 必须将该 scope 原样用于后续 dispatch、complete、fail、abort、renew、split、promotion、reconcile 与 finalize。

`saveImportDrafts` 的输入只代表“预期库中**没有**导入任务”，没有 `expectedJobId` 这种可复用覆盖许可。它在 `importJobs` 读写事务内先读取原始行：存在可解析行时不论 `destination`、草稿状态、plan、attempt、outbox 或完成度如何，直接返回 `{kind:'not-applied', reason:'import-job-exists'}`，不删、不 put；原始行不能解析时返回 `import-job-invalid`，也不静默覆盖。只有完全无行时才生成新的 jobId、为外文 draft 建计划、`add` 新行并返回 created。并发的两个“首次创建”由同一事务与 `&novelId` 约束使其中一个 created；若第二个事务在 read 后 `add` 遇到唯一约束，仓储仅重读该键并在发现行时转换为 `import-job-exists`，绝不把该约束异常变成 delete/put 覆盖，其他存储错误才 reject。

产品若需要重新分章，UI 必须显示“将删除此导入的已付费分段进度，无法恢复”的二次确认，确认前重读当前 job 并以稳定递归 key 排序的 canonical UTF-8 serialization 对**完整 parsed ImportJob**（包括 drafts、plans、segments、attempt/history、outbox、destination、提取状态和时间）计算 `ImportDraftStateFingerprint`。`discardImportDraftJob` 在同一事务重读、要求 `destination===null`、jobId 和该 fingerprint 都相等后才 delete；任一差异返回 typed not-applied、零写入。成功后 UI 必须重新读取确认“无任务”，才可调用 `saveImportDrafts` 创建全新 job，绝不把旧 ID 传给创建入口。该明确丢弃会让旧 callback 因 job 不存在而失败关闭；已应用 glossary 仍遵守既有“不回滚”规则。

### 10.3 claim 与 dispatch 的事务差别

claim 对 import scope 先以 `scope.draftIndex` 精确取得当前 draft/plan（并要求 input identity 的同一 index），对 chapter scope 先取得指定 chapter job；之后才检查 exact job/source、`expectedExecutionEpoch`、decision、stale、active batch及其epoch、`input.ownerId === batch.ownerId`、第6.2节 `earlierSourcesSettled(container, scope, targetSegmentId)`、候选和 lease。该谓词为 false 时返回 `{kind:'blocked', reason:'earlier-source-unsettled'}`，不创建 attempt；它不能只扫描现存 outbox。它只创建 attempt/lease、把 segment 设 running，不改调用计数。无 `preferredSegmentId` 时只取最早 `pending` 叶；`failed` 叶只能由 runner 明确传入该 ID，且仓储重算其 trigger 对应的自动额度或确认手动重试资格。任何更早需要作者处理的 failed leaf 继续阻塞后段。runner 完成 glossary/style/previous chapter/prompt/config 的本地准备后，把 dispatch closure 作为 `TextRunOptions.beforeRequest` 交给 `useLlm`；`useLlm` 原样转交 `LlmClient.streamChat`，而 `OpenAiCompatibleClient` 仅在本地校验和请求体构造完成、紧贴 fetch 前调用它。该 hook 的闭包必须穷尽处理 `DispatchResult`：仅 `dispatched` 正常 return；`paused`、`budget-exhausted`、`invariant` 与 `not-applied` 各自构造 `TranslationDispatchBlocked(result)` 并 reject。`useLlm.runStream` 与客户端都不捕获或改写该 sentinel；因此 `beforeRequest` 的非 dispatched 结果在类型、控制流和网络行为上都不能退化成“仍然发一次请求”。

`beginTranslationDispatch` 的 `budget-exhausted` 分支按第6.3节已在事务内回收未 dispatch claim，runner 捕获 sentinel 后只显示该 limit、停止本轮，不再调用 abort 或 fail。`paused` 分支已由第9.3节在同一事务回收 pre-dispatch claim，runner只重读暂停状态，零fetch、零调用；`not-applied` 分支同样只重读，不能对未知的新 owner 做任何清理；`invariant` 分支停止整个 scope、显示任务损坏并且不尝试修复/重发。runner 在调用 `runStream` 前保存 `beforeRequestEntered=false` 与 `dispatchSucceeded=false`；dispatch closure 的第一行将前者置 true，只有 `dispatched` callback resolve 后置后者 true。catch 时，sentinel 按上段处理；`!beforeRequestEntered` 表示客户端本地配置/请求体预检失败，按准备失败 abort、零调用；`beforeRequestEntered && !dispatchSucceeded` 表示 dispatch 存储事务失败（Dexie 事务原子回滚，所以不可能已有已记账的 fetch），零 fetch、按 storage UI 处理，并对仍属自己的未 dispatch claim best-effort abort；abort 也失败时不伪造 failed，保留 lease 等待有限过期；仅 `dispatchSucceeded` 后的异常才按第9.2节归类为模型请求失败。若 dispatch 成功后进程立刻崩溃，保守保留一次实际调用计数，因为无法证明请求未出站；恢复不会隐藏潜在花费。

### 10.4 complete、候选、split 和 finalize

所有嵌套更新都在事务中读取最新 ImportJob 或 ChapterTranslationJob。对 import scope，**先**按 `scope.draftIndex` 定位唯一 `draft.index`，并逐字段比较 scope、identity 与 identityBinding 的 locator；只有随后才克隆该 draft/plan/segment/attempt。对 chapter scope 则先锁定 chapterId/jobId。Dexie 最终仍 put 一整行，但调用方不能传整份 drafts/segments，也不能用组件快照覆盖数据库。

complete 要求 plan/attempt/batch 的 `executionEpoch` 都等于 input、segment running、activeAttemptId匹配、attempt running且已 dispatch、runBatch匹配、owner/token匹配、lease 未过期；import 还要求 scope/identity 的 `draftIndex` 精确命中已定位 draft。editor complete 同时读取 Chapter；正文不匹配时先执行合法 stale 失效转换，再返回 not-applied。验证失败只写 failure；验证通过且前驱 unresolved 时写唯一 current candidate；可完成时才写正式 result/outbox。done 后任何旧 attempt 都只返回 not-applied。若 complete 的 Dexie 事务因 quota/abort 拒绝，事务回滚使该 attempt 仍为running且`dispatchedAt`保留；runner 仅在内存缓存raw output，并在同一identity/未过期lease下由“再次保存”重新调用 **同一个** complete API，绝不重发模型请求或增加调用数。

candidate promotion、outbox reconcile 都携带其来源 attempt/runBatch/originLeaseToken identity、当前 `expectedExecutionEpoch`，以及 import 时的同一 `draftIndex`。它们不要求历史 lease 仍未过期，因为模型响应已经在 lease 有效时落成候选或正式段；但必须逐字段验证保存的历史lease token及candidate/outbox仍属于当前segment winner，并比较当前epoch以拒绝覆盖恢复前的 runner。promotion seam 失败时必须把 current candidate 移入 history、清 current candidate、attempt/segment 转 failed，再返回 `seam-failed`；它不能留下一个可被之后 retry 或 split 误读的 current candidate。

split 检查失败 attempt、batch、source、revision 并原子写父子。finalize 重读全部 segment并重算完整 invariant，不信任 UI 的完成数或缓存；只有**有效叶上的 current candidate（即 awaiting-predecessor）**、pending/running/failed 叶或未按当前容器矩阵结算的 outbox 才返回 not-ready。editor 与 `decision='translate'` 的 import plan 要求每一个 outbox 都是 `applied`；`discarded` 绝不在这些 finalize 路径被当作结算。仅当某个 import plan 已 `use-source` 时，其他 draft 的源序门才把它的 discarded box 视为结算。任何违反矩阵的 outbox 返回 `invariant`，不是“空 outbox”或可继续的状态。`rejectedCandidateHistory`、split 父和历史 attempt 都不阻止由成功子叶或 strict retry 成功结果完成 finalize。

### 10.5 Chapter 正文条件写与编辑 lease 事务

`writeChapterContent`、`markChapterTranslationStale`、`create/rebuild/authorizeChapterTranslationRun` 与 `applyChapterTranslationJob` 都在至少 `chapters + chapterEditLeases + chapterTranslationJobs` 的同一 Dexie 读写事务中重读当前行。编辑器正文写入的顺序固定为：验证 chapter 存在 → 验证 owner/token/expiry → 比较 `expectedContentRevision` → 合并当前 patch → 若 `content` 实际变化则 `contentRevision + 1` 并执行 sticky stale → put Chapter。任一条件失败时绝不部分写 Chapter、任务或 lease。

`writeChapterContent` 的 editor guard 只接受当前唯一 lease，且可安全保存 editor undo 所需的 `sourceContent/sourceLanguage`；system guard（现有 `proposal/apply.ts` 的 `chapter:replace`）先在同一次作者确认 handler 读取 target Chapter 的 revision，再带它调用条件写；事务内拒绝任一未过期 edit lease和传入的 source 留底字段。若期间正文变动，返回 conflict、提案保持待确认而不盲写。`ChapterEditorScreen` 的生成、加工、undo和 textarea flush 均只用 editor guard；`updateChapter` 只处理元数据。因此所有已知正文入口都受同一比较，不能通过已存在的通用 API 逃逸。内容变化且存在任一 active/paused/failed/completed-preview job 时，同一事务执行第6.5节的合法失效转换，再写 outer stale；即使另一个标签没有打开翻译面板，这条路径也成立。

`applyChapterTranslationJob` 额外验证 completed-preview、editor plan decision、全部 plan invariant、source hash、`expectedVisibleSourceHash`、preview和protocol来源图。它比较相同 owner/token/revision后，原子写完整预览、sourceContent/sourceLanguage、wordCount和`contentRevision + 1`，删除 job；如果另一个 owner 仍有未过期 edit lease，返回 `editing-busy`，保留 job 和正文。正常产品路径中 `ChapterEditorScreen` 自己持有该 lease；此分支专门防御另一个标签已输入但还未 flush 的情况。

任何 `content-conflict` 或 `edit-lease-lost` 都是可恢复但不可自动重试：调用方冻结 flush chain、保留 `visibleContentRef`/pending patch、停止 runner并显示“本地文本未保存，复制或重新加载后再处理”。不能把旧 patch 重新提交，也不能把远端正文静默塞回 textarea。

### 10.6 glossary outbox 事务

reconcile 在一个事务中打开任务容器和 `glossaries`：先按 import `draftIndex` 或 chapter scope 精确定位、重读 artifact identity，并先跑 container/decision outbox matrix。当前 scope 是 chapter 或 import `decision='translate'` 时，它自己的 outbox 必须是 `pending` 或 `applied`，遇到 `discarded` 立即返回 `invariant`；`decision='use-source'` 根本不进入 reconcile。目标是 `pending` 时，仓储在**调用 `mergeGlossary` 之前**对完整的最新 container 执行 `earlierSourcesSettled(container, scope, target.segmentId)`；结果为 false 就返回 `{kind:'blocked', reason:'earlier-source-unsettled'}`，不写 glossary、outbox、attempt 或计划。该检查覆盖同一章/plan 中还没有 outbox 的 earlier pending/running/failed/awaiting leaf、earlier done但pending outbox的叶，以及 import 中任一更早 draft 的 translate/use-source/legacy状态；不得改写成“枚举较早 outbox 后空集合即通过”。目标已 `applied` 时只返回 `none`，但完整语义 checker 仍验证其历史上满足同一谓词。

通过源序门后，当前 `outbox.terms` 必须重过 `TranslationModelGlossaryEntrySchema`、数量不变量及该 segment 当前 translatable source-core anchor，才调用现有 `mergeGlossary`；随后在同一事务写 glossary 并把当前 outbox 标 applied。作者已修改的值在 current glossary 中，因此模型值不会覆盖。事务要么两边都写，要么都不写。无锚定 terms 在 complete 时已被丢弃，reconcile 只显示/保留计数，绝不补写它们。恢复测试仍人工构造“glossary 已含词条但 outbox pending”；重放同一 terms 由 `mergeGlossary` 幂等收敛。

下一段 claim 也在相同谓词为 false 时拒绝；翻译调度与采用路径不得绕过这一事务：现有 `ImportScreen.translateOne` 和 `TranslateSheet.accept` 中对 `mergeGlossaryTerms` 的直接调用都删除，只有 `reconcileTranslationOutbox` 可以把模型输出写入作品级 glossary；作者在译名管理界面的显式修改不受影响。

### 10.7 提取阶段也改为最小条件 patch

当前 `/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.tsx` 的 `persistJob` 会把旧 `chapters/worldviewChunks/entryDrafts` 整数组写回。为避免翻译改造后世界观 drafts 被提取旧实例清空，删除后台循环对 `upsertImportJob` 的使用，新增：

```ts
type ImportExtractionPatch =
  | {
      kind: 'chapter-result';
      chapterId: string;
      entryDeltas: ImportEntryDraft[];
      openThreads: string[];
      rollingSummary: string;
      summaryProposal: Proposal | null;
    }
  | {
      kind: 'worldview-result';
      chunkIndex: number;
      entryDeltas: ImportEntryDraft[];
    }
  | {
      kind: 'item-status';
      item: { kind: 'chapter'; chapterId: string } | { kind: 'worldview'; chunkIndex: number };
      status: 'pending' | 'failed';
      error: string;
    }
  | { kind: 'run-status'; status: 'running' | 'paused' };

patchImportExtractionJob(
  novelId: string,
  input: { expectedJobId: string; patch: ImportExtractionPatch },
): Promise<MutationResult<ImportJob>>;

deleteImportJob(
  novelId: string,
  input: { expectedJobId: string },
): Promise<MutationResult<void>>;
```

`chapter-result/worldview-result` 在最新行上只标一个 item done，并按 key 合并 entry delta；不接受整份 arrays。chapter summary proposal与 job item完成在同一事务中写，避免旧 job response 在任务删除后再落提案。所有 patch、finalize/放弃都带 expectedJobId。`deleteImportJob` 额外只接受 `destination !== null` 的**作者明确放弃**路径；草稿阶段的放弃/重分章必须走第10.2节 fingerprint-guarded `discardImportDraftJob`，所以通用清理 API 不能被旧分章页滥用为覆盖旁路。

全部 extraction item 为 done 后，组件不再按“`createProposals()` 成功后再 `deleteImportJob()`”编排。它重读并 parse 当前 job，使用 `fingerprintImportFinalizationState(job)` 对完整 canonical destination-stage job（destination、冻结 drafts/plan、chapters 或 chunks 状态、entryDrafts、rolling/openThreads、batch、flags、时间）计算 `expectedFinalizationFingerprint`，再构造最终 entry、main/side progress 与可选 style Proposal。新 helper `importFinalizationProposalId(jobId, fingerprint, key)` 对 length-prefixed UTF-8 的三者做 SHA-256，返回确定的 `import-finalization-<hex>` ID；entry key 为 `entry:<sha256(draft.key)>`，进展为 `progress`，样式为 `style`。`proposal/build.ts` 的三类 builder 增加可选显式 `id`，未传时保持现有 `newId()` 行为；导入收尾只能传该 helper 的 ID。`batchId` 使用 job 的非空 batchId，legacy 空值时使用从 jobId 派生的稳定 fallback。相同未变 job 的重试因此产生同一 key、ID、排序和批次，不会在收件箱复制一套不同 ID 的提案。

`finalizeImportExtraction` 先在事务内重读/parse job，比较 jobId 与 fingerprint，要求 destination 已确定、所有 `chapters` 或 `worldviewChunks` 都是 done、没有 failed/pending/running item，并复验阶段形状。main/side 分支在 `importJobs + proposals + chapters`（side 再加 `sideStories`）事务中确认 job 认领的章节仍存在、同书且同线；worldview 分支只开 `importJobs + proposals`，验证 `chapters=[]`、冻结 drafts 与 chunks，**不读取、更不写 Chapter 表**。它验证 caller proposal keys 的 ASCII format/去重、每条 `ProposalSchema`、`novelId`、pending status、stable batch与其确定 ID；无效输入返回 typed `invalid-input`，job/final text/提案都不变。合法时同一 Dexie 事务 `bulkAdd` 全部最终 proposals，再按 expectedJobId 删除 job。任何 `bulkAdd` 冲突、校验失败、并发 finalizer 或事务异常都会回滚到“job仍在、没有本次最终proposal”；若另一 finalizer已完成，本调用重读不到 job而返回 not-applied，绝不再写第二套。组件只在 `{kind:'finalized'}` 后进入 inbox；not-ready/not-applied 重新读取并恢复，style LLM失败仍按既有可选语义省略 style proposal而不阻塞其余原子收尾。世界观完整原文与 plans 一直保留到此事务删除 job 后才释放。

## 11. 导入链路接线

### 11.1 新任务与旧任务

`saveImportDrafts` 只创建**不存在** ImportJob 行的新任务：事务确认该 novelId 没有原始行后才生成新 ImportJob ID，并为每个新外文 draft 建 V1 plan；纯中文 draft 保持 null。全新 ImportJob 的 plan `executionEpoch=0`；创建计划失败或存储失败停在分章页，零请求。它绝不以相同 `expectedJobId`、destination 或“看起来还是草稿阶段”为理由 delete + put 一条已有任务，因此旧分章界面不能抹掉另一标签已付费的 segments、attempt history、outbox 或已完成计划。

加载时若 `getRawImportJob` 返回的行无法 `ImportJobSchema.safeParse`，`ImportScreen` 不再沿用当前“自动清理坏行”的行为。它显示“此导入任务无法恢复；确认删除后才可开始新导入，已有章节、提案和译名不会被删除”的二次确认，并禁用创建/分章提交。取消确认零写入且继续保留该行；确认时把刚读取的 `RawImportJobFingerprint` 传给 `discardInvalidImportJob`。只有 `{kind:'discarded'}` 后再重读确认空槽，才解除禁用并允许 `saveImportDrafts`。`raw-job-changed` 或 `job-now-valid` 时 UI 不删任何内容，改为重读：前者要求重新确认，后者按正常恢复路径打开合法任务。无法为异常 raw structured-clone 值生成 fingerprint 时显示不可恢复存储错误并保持禁止创建，不能绕过为盲删。该专用恢复出口保留旧任务兼容的“不会被坏残留永久卡住”，同时不把合法/已付费任务当垃圾自动删除。

作者要重新分章时不复用创建入口：UI 先显示不可恢复的付费进度删除确认，确认前重读并取第10.2节 fingerprint，调用 `discardImportDraftJob`；只有它返回 discarded 且再次读取为无任务后，才用新的 batchId/drafts 调 `saveImportDrafts`。若 job/plan 在确认期间推进，fingerprint 不同、整个 discard 零写入并要求重新确认。旧任务的任何网络回调因 jobId 不存在而 not-applied；已经 applied 的 glossary 仍不回滚。

对已有 ImportJob 的旧待译 draft，懒初始化仍只能走 `initializeImportTranslationPlans`，绝不能重建/替换整个 job；新 plan 继承该 job 所有非null plan 的最大 executionEpoch（无其他 plan 时为 0），从而同一次导入授权共享的 batch ID 始终也共享 epoch。

`resumeStepOf` 改为逐 draft 调用 `importDraftResolution`：

- resolved：plan done、plan use-source、旧 done无 plan、无需翻译的中文 null plan。
- translate：plan 有 pending/running expired/awaiting/failed，或旧 pending/failed null plan。
- undecided：外文 `none + null`。
- 全部 resolved 且 destination null：destination。
- 新 worldview 允许冻结 drafts 非空；旧 worldview drafts 为空仍合法。

恢复只展示，不懒初始化、不 claim。作者点击继续旧 `pending/failed + null` 时，UI 调用 `initializeImportTranslationPlans(..., { drafts:[{ draftIndex, decision:'translate'}] })`；对旧 `none + null`，UI 先要求作者选择，再将 `{ draftIndex, decision:'translate'|'use-source' }` 直接传入该**同一**初始化事务。该事务成功后才可 authorize；use-source 分支已持久化但永远不 authorize。刷新、事务失败或另一标签先初始化时不会留下“默认 translate、等待第二次切换”的中间计划。

### 11.2 use-source

UI 将旧“跳过剩下”替换为逐章明确“整章使用原文”和批量确认。对**已有 plan**的章，确认前先重读job；命令携带expectedMutationVersion及当前active attempt/lease快照，任一字段变化就not-applied并重新显示确认。对旧外文 `none + null`，不走这条已有-plan切换 API，而是调用第10.2/11.1节的原子 initializer，并把 `decision:'use-source'` 与新 plan 同时落盘。切换已有 plan 到 use-source 的事务执行第 6.5 节失效转换、pending outbox→discarded、decision/revision 更新，清`finalText/completedAt`，并确保 `draft.content=plan.sourceText`、`sourceContent=''`。done 段和 current candidate 保留，但不参与最终 destination 内容。

目的地选择前可点“恢复翻译”。事务把该 plan 的 discarded outbox 恢复 pending，decision 改 translate，保持累计次数。runner 先 promote/reconcile；完成前不 claim。如果所有叶子已 done，零模型调用 finalize。已 applied glossary 不回滚。

### 11.3 import finalize 与三种 destination commit

import plan 的全部正式叶 done且 outbox applied 后，finalize 在一个 ImportJob 事务中写：`plan.finalText`、plan done、`draft.sourceContent=plan.sourceText`、`draft.content=finalText`、`sourceLanguage=plan.sourceLanguage`、`translateStatus=done`、错误清空。事务失败时章级字段仍是完整原文，segment 进度保留。

`commitImportChapters` 与 `commitImportWorldview` 均增加 expectedJobId并在事务里重读每章：

- 新 plan 只接受 translate+done 或 use-source。
- 旧 done无 plan沿用旧完整结果。
- 中文 null plan沿用当前正文。
- 外文 none/pending/failed null plan或任一 unresolved plan拒绝整笔提交。

主线/外传翻译章从 plan 的 finalText/sourceText 建 Chapter；use-source 章 content 为完整 sourceText，`sourceContent/sourceLanguage` 为空。字数继续由 `countWords(content)` 计算，外传 `sideStoryId` 与线内最大 index 规则不变。任何失败回滚新外传、全部 Chapter 和任务阶段。

### 11.4 世界观零 Chapter 与原文保留

`commitImportWorldview` 不再接受 UI 传入任意 chunks。仓储从已验证 resolved drafts取完整译文或完整原文，调用 `/Users/leadencedar/Production/Project/MyLiterature/src/domain/importWorldview.ts` 的原样打包函数。新 worldview 阶段保存 `destination=worldview`、冻结且非空的 drafts、非空 worldviewChunks、空 chapters。事务不打开 `chapters` 表。

提取继续只读 chunks；translation plans和完整 sourceText 一直留到全部 chunks done，并由第10.7节的 `finalizeImportExtraction` 在 `importJobs + proposals` 单一事务中 materialize 最终 entry proposals、删除 job 后才释放。刷新、失败、finalizer并发或事务回滚时仍能恢复，且世界观全程不创建/修改任何 Chapter。旧 worldview job没有 drafts时沿用旧安全说明，不伪造 source或删除既有 Chapter。

### 11.5 纯中文零回归

纯中文导入不调用 plan builder/hash/random，不创建 plan/attempt/lease，不出现翻译授权，不发翻译请求。`packWorldviewChunks` 只是从原位置下沉并原名重导出；相同 drafts 的 chunks、提取 system/user、调用次数、步骤和 destination行为必须逐字节/行为等同当前基线。保留专门快照测试。

## 12. 章节编辑器接线

### 12.1 持久化编辑 lease 与串行可失败 flush barrier

`ChapterEditorScreen` 每次 mount 用 `crypto.getRandomValues` 生成独立 `editOwnerId/editLeaseToken`，先调用 `acquireChapterEditLease`。只有 `{ kind:'acquired' }` 才渲染可编辑 textarea、启用生成/加工/翻译操作并把返回的 `chapter.contentRevision` 存为 `contentRevisionRef`；`busy` 时正文只读，显示“另一标签页正在编辑，至 {expiresAt} 后可重试”，不产生 pending patch。每 30 秒 renew；renew 失败、收到其它标签提示或页面发现 lease 不再归属自己时，立即停 runner、禁用写操作并保留本地可见文本，**不得在同一旧编辑实例自动重新 acquire**；用户必须显式重新加载/重新打开后才可基于最新正文取得新 lease。卸载清理为 `void flushChapter().then(releaseChapterEditLease).catch(keepLeaseUntilExpiry)`：只有最后一次 flush 成功才主动释放；失败时不把未保存可见文本让给另一 writer，留到用户仍在页内处理或 120 秒自然过期。用户通过正常返回关闭时 `closeWithFlush` 必须 `await flushChapter()` 成功、再 `await releaseChapterEditLease()` 后才 `onClose()`；失败则留在编辑器。页面被杀掉时不能保证回调完成，120 秒自然过期是后备。

当前 `flush` 会清空 pending后吞掉错误，且两个 flush可重叠。改为 `flushChapter(): Promise<Chapter>`，它只通过第10.5节的 `writeChapterContent(..., { expectedContentRevision: contentRevisionRef.current, guard: editor lease })` 写正文：

- `visibleContentRef` 与 `editGenerationRef` 在每次 onChange同步更新；没有 acquired lease 时 `observeVisibleContentChange` 不接受输入。
- `saveChainRef` 串行所有写入；新 flush先等待已有 promise，再循环 drain `pendingRef`，直到没有待写 patch。
- 每次 drain先原子取走 patch；成功时把返回 Chapter 的 `contentRevision` 写回 ref。失败时把它与期间新来的 pending重新合并，后来的字段值优先，然后 reject并保留“保存失败”。不得吞错。
- `content-conflict` 或 `edit-lease-lost` 不是普通保存失败：停止 chain、abort runner、冻结所有内容操作，保留 `visibleContentRef` 和待写文本供复制/比较；不得把旧 patch再提交。`editing-busy` 同样不写并显示 owner 到期信息。
- 自动保存调用 `void flushChapter().catch(showSaveError)`；返回、Cmd/Ctrl+S、创建/继续/重试/apply都直接 await同一 barrier。返回flush失败或冲突时编辑器保持打开，不能在未保存可见正文时离场假装成功。
- barrier完成后调用方重读 `visibleContentRef`、`contentRevisionRef`并计算 `expectedVisibleSourceHash`；仓储还要重读 Chapter 和 lease。任一失败零 fetch、零 apply。

这保证已有 flush在途时启动任务会等待；更重要的是，另一标签页的尚未落盘正文已经由 lease 阻塞 apply，lease 过期后的旧 flush又由 revision/token 拒绝，paused、failed、completed-preview 都没有 800ms 绕过窗口。

### 12.2 任一未结束 job 的即时 sticky stale

ChapterEditor挂载即读取本章 job，并在编辑器存在期间轮询。`observeVisibleContentChange(nextContent)` 是唯一的本地正文变更入口：textarea `onChange`、`commitContent`（生成/加工采用）、undo及任何其他会调用 `setContent` 的路径都必须先同步调用它；翻译专用 apply 只在仓储已原子删job后更新本地正文，不能走此guard。只要存在 active、paused、failed、completed-preview或stale job，首次观察到 `nextContent` 与 `plan.sourceText` 不同，就同步：

1. 设置本地 sticky-stale flag，立即禁用 start/continue/retry/apply，不能等 IndexedDB。
2. abort runner和本地 generation。
3. 异步调用带当前 `expectedExecutionEpoch + contentRevision + editLease` 的 `markChapterTranslationStale`；该事务执行第6.5节转换。即使作者在800ms内把文字改回原样，已触发的 stale不会撤销。
4. 正文仍通过 flush barrier保存；`writeChapterContent` 在 `chapters + chapterTranslationJobs + chapterEditLeases` 事务中做同一 stale检查，覆盖其它内容写入口。

create/continue/retry/apply 都先 await `flushChapter()`，再传当前可见 hash、`contentRevisionRef`、当前 edit lease和execution epoch并重读 job。apply必须同时比较 `expectedVisibleSourceHash`、plan hash、事务中的 Chapter hash、revision与owner/token。任何一个不同就持久化/返回 stale、busy或content-conflict，不能覆盖刚输入但曾未落盘的正文。

标题、状态等非 content patch不使任务 stale。stale 成立后即使数据库正文后来恰好恢复，也只能查看/复制、放弃或确认后重建。

### 12.3 启动、恢复和多标签创建

首次点击“翻译本章”：先确认本实例拥有未过期 edit lease、再 flush；以当时可见完整正文和当前 contentRevision 构建候选 job；`createChapterTranslationJob` 事务重读 Chapter、lease和revision并核对 visible hash；再通过 `&chapterId` add。两个标签并发时，后打开的编辑器通常已在 acquire 返回 busy 时只读；即使绕过 UI 直接调用 create，lease/条件检查和唯一索引也只会返回 existing/busy，不覆盖。

打开 TranslateSheet只读取任务和执行无费用 maintenance，不自动 authorize；没有 edit lease 时所有会改任务或正文的控件禁用，只显示其它 owner 的到期时间。paused/failed显示继续；completed-preview直接恢复生成版完整 preview且零请求；stale显示只读结果。换章时 `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/WritingPage.tsx` 现有 `key={chapter.id}` 会卸载 runner，触发 abort但不删任务。

### 12.4 预览、采用与“追加”边界

全部正式叶和 outbox完成前不渲染可采用 textarea。运行中仅显示标明“未验证”的当前段。finalize后完整生成版写入 job.previewText，进入现有“译文（可直接修改）”textarea。手工预览编辑只在当前组件 state；关闭后至少恢复生成版，这是需求允许的边界。

“采用译文”先走 flush barrier并重读任务，再调用专用 apply事务。命令携带expectedMutationVersion、execution epoch、当前 edit lease与expectedContentRevision，避免确认后另一标签更新任务或正文仍被旧UI覆盖。仓储验证 completed-preview、editor plan decision、全部 invariant、可见/数据库 source hash、revision、owner/token、preview非空，以及协议前缀只可能位于来源匹配的exact verbatim fence；一次写 `content=previewText`、`sourceContent=plan.sourceText`、`sourceLanguage=plan.sourceLanguage`、wordCount、`contentRevision + 1`和updatedAt，再删job。若其它标签仍有未过期编辑 lease，返回`editing-busy`；若本实例旧lease/旧revision已失效，返回`edit-lease-lost/content-conflict`；三者都不删job、不写正文。组件只有拿到 `{kind:'applied'}` 后才更新本地正文、sourceBackup、revision ref和撤销栈，调用现有`recordProgress`记录正向字数增量并invalidate；该日志仍遵守当前保存语义，不属于正文原子事务。现有“撤销AI改动”仍可退回本次source，并按当前规则清空对应source backup。失败时正文和任务保持原状或转stale。

**采用不是译名写入入口。** 现有 `TranslateSheet.accept()` 在调用编辑器 `onAccept` 前直接 `mergeGlossaryTerms` 的路径必须删除。导入与编辑器两个翻译入口都只能由 `reconcileTranslationOutbox` 合并模型产生的译名：正式 winning segment 在同一事务持久化译文和 outbox，按源序对账成功后才成为 completed-preview 的前提。预览编辑、普通关闭、stale、放弃、apply 的 hash 检查失败或任何旧 attempt 都不得再触发直接 glossary 写入；手工译名管理仍继续使用现有显式仓储 API。这样编辑器的旧预览即使在 800ms 保存窗口或跨标签竞争中失效，也不会在正文未采用时污染词表。`TranslateSheet` 可以展示已持久化段的词条和“已同步”状态，但不能另存一份可在采用时写入的 `phase.glossary`。AC-19、AC-20、AC-33、AC-36、AC-41 必须分别覆盖该边界。

本期不新增翻译“追加到正文末尾”按钮，也不把翻译接到 `GenerateChapterSheet` 的 append handler。仓储只提供 replace apply。若以后共享组件意外暴露 append，必须新增专用原子 API并使用同一 visible/DB source hash、edit lease与contentRevision检查；元数据用的 `updateChapter` 和无 guard 的正文 write 不得作为旁路。

### 12.5 stale、查看复制、重建与放弃

stale界面按 source顺序展示正式 done叶；未完成范围用不可复制占位，不能冒充完整译文。completed-preview后 stale可查看/复制完整生成版。awaiting current candidate 显示为“结果已保存，等待前段完成后校验接缝”；failed segment 的 `rejectedCandidateHistory` 单列为“未通过接缝校验的诊断结果”，可查看/复制但不得混入完整复制按钮、outbox或进度。

“丢弃后按当前正文重建”二次确认会删除旧付费进度。先flush并在确认前重读任务，再构建新job候选；仓储事务核对expected old job、expectedMutationVersion、expectedExecutionEpoch、active attempt/lease快照、当前 edit lease/revision和当前Chapter，原子删除旧行并add新行。新jobId/sourceHash使旧响应全部失效。创建新job不自动authorize。

普通关闭只abort并保留任务；“放弃任务”单独二次确认，文案明确分段译文和进度不可恢复。确认前同样重读并携带expectedMutationVersion、expectedExecutionEpoch与active attempt/lease；确认后条件删job，Chapter不变；取消不写任何数据。确认期间任务若变化则not-applied并要求作者重新确认。

## 13. UI 与可访问性

两条链路共用 `/Users/leadencedar/Production/Project/MyLiterature/src/ui/Sheet.tsx`、Button、ConfirmDialog和同一套响应式DOM，不按宽度渲染两棵功能树。

每章显示：章状态；有效叶done/总数；当前叶；done源grapheme/整章grapheme；预计基础调用；因split增加的叶调用；累计实际和累计extra。预计基础调用固定为`initialTranslatableSegmentCount`；split新增按每个初始可调用root计算`max(0, 当前可调用有效叶数 - 1)`后求和；retry只进累计actual/extra，不伪装成新增叶。split后总数和估算立即按有效叶重算，父不计数。完成源字符只求正式done/verbatim有效叶范围并集，awaiting/父段不计。

段详情显示 pending、running、awaiting-predecessor、done、failed和split history，实际attempt数、是否已dispatch、错误种类与动作。awaiting文案为“结果已保存，等待前段完成后校验接缝”；outbox失败为“译文已保存，译名待同步”；storage候选明确“只在当前页面内存中，尚未保存”。

操作：两边都有暂停、继续、重试失败段；导入有整章use-source及目的地前撤销；编辑器有普通关闭、放弃任务、stale重建。翻译 busy显示另一标签与过期时间含义；编辑lease busy时编辑器整体只读并显示“另一标签页正在编辑”，不会把它伪装成翻译问题。错误区分 auth、余额、配置、网络、429/服务端、验证、预算、storage、stale、翻译lease、编辑lease、content conflict；诊断只显示章/段、受控kind和finish reason，不显示API Key、prompt、正文或服务端原始body。

进度使用 `role="progressbar"` 和 `aria-valuetext`；错误 `role="alert"`；恢复、storage和成本说明 `role="note"`；状态变化 `aria-live="polite"`。导入页删除“长章单次翻译、手工重新分章”的正常说明，改为自动分段、成功即保存、只处理失败源段和自动调用有上限。

## 14. 迁移、备份 v5 和 merge

### 14.1 v7到v8

`/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/db.ts` 在 v8 新增 `chapterTranslationJobs` 与 `chapterEditLeases`，并只对旧 Chapter 补并发元数据 `contentRevision:0`。不迁移 ImportDraft 嵌套字段，不改 `content`、`sourceContent`、`sourceLanguage`、字数、任务或任何正文。升级测试从原生v7库打开到v8，断言全部既有字段逐字段不变、每个旧 Chapter 的 revision 为0、两张新表为空可写、`verno===8`、`chapterTranslationJobs`唯一chapterId与`chapterEditLeases`主键chapterId均生效。

### 14.2 version-aware备份 schema

数据库实体仍使用 defaults；备份按文件版本分流，不能让v5缺字段被补空：

```ts
const ImportDraftV5Schema = ImportDraftSchema.extend({
  // 显式 required；值可以 null。非null时先过requireV5TranslationKeys
  translationPlan: TranslationPlanSchema.nullable(),
});

const ImportJobV5Schema = ImportJobObjectSchema.extend({
  drafts: z.array(ImportDraftV5Schema),
});

// 实体默认只服务旧行；v5不允许缺失并发版本后悄悄变成0
const ChapterV5Schema = ChapterSchema.extend({
  contentRevision: z.number().int().nonnegative(),
});

const RepositorySnapshotV5Schema = z
  .object({
    // 现有全部表均显式列出；旧字段本身仍可使用实体默认
    novels: z.array(NovelSchema),
    categories: z.array(CategorySchema),
    entries: z.array(KnowledgeEntrySchema),
    outlineNodes: z.array(OutlineNodeSchema),
    chapters: z.array(ChapterV5Schema),
    chapterSummaries: z.array(ChapterSummarySchema),
    styleProfiles: z.array(StyleProfileSchema),
    proposals: z.array(ProposalSchema),
    plans: z.array(WritingPlanSchema),
    dailyLogs: z.array(DailyLogSchema),
    importJobs: z.array(ImportJobV5Schema),
    glossaries: z.array(GlossarySchema),
    sideStories: z.array(SideStorySchema),
    writingNorms: z.array(WritingNormSchema),
    scenarios: z.array(ScenarioSchema),
    scenarioNodes: z.array(ScenarioNodeSchema),
    chapterTranslationJobs: z.array(ChapterTranslationJobSchema), // required，可为空
  })
  .superRefine(checkRepositorySnapshotV5);
```

`/Users/leadencedar/Production/Project/MyLiterature/src/domain/backupSnapshot.ts` 是版本分流的唯一实现，不把 “文件原来有没有 key” 丢在 UI 层。`BackupError` 也移到这个 domain 模块并由 `features/export/backup.ts` 原名 re-export，避免仓储反向依赖 feature；header、UI 和仓储因此向调用方提供同一种可操作错误。它导出：

```ts
type BackupImportInput = { version: 1 | 2 | 3 | 4 | 5; data: unknown };
type ParsedBackup = {
  app: 'myliterature';
  version: 1 | 2 | 3 | 4 | 5;
  exportedAt: number;
  // JSON.parse 后未经 schema/default 规范化的 data；仅供 restore 原样转交仓储。
  rawData: unknown;
  // 同一 parser 得到的 canonical 视图，仅供摘要、预览和 export UI。
  snapshot: RepositorySnapshot;
};

function parseBackupSnapshot(input: BackupImportInput): RepositorySnapshot;
```

`parseBackup` 仍先只解析 header：version>5 立即报“来自更新版本”，不碰正文。随后它把 `{version, data: raw.data}` 交给 `parseBackupSnapshot`，返回同时含 `rawData` 与 `snapshot` 的 `ParsedBackup`；UI 的 `summarizeBackup` 只读 `snapshot`。序列化使用单独的 `BackupWireFile { app, version: 5, exportedAt, data: snapshot }`，不会把 `rawData/snapshot` 辅助字段写进文件。`restoreBackup` **不得**把 `snapshot` 传给仓储，而是必须调用：

```ts
repository.importSnapshot({ version: file.version, data: file.rawData }, mode);
```

`NovelRepository.importSnapshot` 和 `DexieNovelRepository.importSnapshot` 都改为上述 `BackupImportInput` 签名。仓储入口的第一步再次调用 `parseBackupSnapshot(input)`，只使用其新生成的 canonical snapshot 开写事务；它不信任 UI 已经 parse 过，也不接收一个失去 raw-key-presence 信息的 `RepositorySnapshot`。直接调用仓储 API 的测试因而与 UI restore 获得相同的安全边界。

`parseBackupSnapshot` 对 version 1–4 使用 legacy schema/兼容转换，补 `translationPlan:null`、`chapterTranslationJobs:[]` 和 `Chapter.contentRevision:0`（并保留既有 v1–v3 writing-norm 兼容）；对 version 5 **先**在 raw `data` 上运行 `requireV5TranslationKeys`，再运行上述 `RepositorySnapshotV5Schema`。预检以 `Object.hasOwn` 递归要求每个 Chapter 显式有 `contentRevision`，每个 ImportDraft 显式有 `translationPlan`，每个非null plan 显式有 `graphemeRules`、executionEpoch 和全部计划键；每个 segment（含 `ratioEligible`）、attempt、current candidate、`rejectedCandidateHistory` 项、outbox、runBatch、editor job 都显式携带 schema 列出的字段，包括 `unanchoredGlossaryTermCount` 和 outbox timestamps/status。不能让实体或 translation schema 的 `.default` 修复一份损坏的 v5 文件。`RepositorySnapshotV5Schema` 随后以 `TranslationModelGlossaryEntrySchema` 及 source-core/matrix semantic checker 解析 candidate/history/outbox；空白、trim 后超160 code units、第101条 term、无锚定 term、错误 outbox status matrix 或缺任一付费进度键都在任何写入前拒绝。v5缺整个 job 数组、任一draft缺translationPlan或 Chapter revision同样零写入拒绝。`chapterEditLeases` 故意不在 backup schema 中：它们是不能跨设备/恢复移植的活跃浏览器 capability，而不是作者数据；replace 会清空它们。快照仍不包含LLM settings或API Key，成品文本继续保留密钥负断言。

v5语义校验包括：editor job指向存在且同书Chapter；一章最多一个job；editor job的 `plan.decision` 必为 `translate` 且不可有 discarded outbox；非stale source与Chapter一致；每个 plan 的 `graphemeRules==='uax29-15.1'`，所有source/hash/range/tree/`ratioEligible`/attempt/lease/current candidate/rejected history/outbox状态合法，所有 endpoint 都由已检入的 V1 UAX #29 breaker 复验；`ratioEligible` 必须由 V1 classifier 从已保存 source/units/table atoms 重算相等，rejected history 只能引用同段 failed seam attempt，且与 current candidate 一样必须重建正确 unit/source 映射并无 model-derived 协议语法。candidate/outbox/history 的 model terms 必须通过专用 trim/长度/数量**和当前单个 translatable source core 锚定**校验；outbox timestamp/status 与 decision/container 矩阵必须一致。attempt/batch epoch匹配且attempt lease owner与所属batch owner一致，所有 draft/segment/unit/attempt/runBatch/outbox/tree-call namespace、root/parent/child、winner/candidate/outbox attempt 与 batch/root 引用都按第5节恰好唯一且无悬空；`activeRunBatchId` 只指向当前 plan epoch，同一ImportJob跨plan复用runBatchId时owner和epoch一致；每个 `applied` outbox 都必须在完整 snapshot 上满足 `earlierSourcesSettled`，后段 applied 而更早 leaf/draft 未结算立即拒绝；每个 ImportDraft plan 的 attempt `identityBinding` 必须以**其封闭 `draft.index`**重算相等，运行时 API 的同名 `draftIndex` 也必须精确命中该 draft；Import plan.jobId等于父ImportJob.id；draft章级字段与decision/status一致；世界观新/旧阶段形状合法；model-derived正式文本无协议语法，source-origin exact verbatim例外按来源图验证。`chapterEditLeases` 不属于 v5 semantic snapshot，也不参与跨设备恢复。

### 14.3 一致的全量导出

`/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/DexieNovelRepository.ts` 的 `exportSnapshot` 改为一个 Dexie `transaction('r', allSnapshotTables, ...)`，在同一事务内依次/并行读取包括 `chapterTranslationJobs` 的全部**可备份**表；`chapterEditLeases` 不读取、不序列化。回调内组装后立即用 `RepositorySnapshotV5Schema.parse` 校验，再返回规范化快照。`exportBackup` 在序列化前再parse一次；任一失败不生成下载文本。

因此export与editor apply或outbox reconcile交错时，只可能读到完整操作前或完整操作后，不会得到“新Chapter+旧job”或“旧glossary+已applied outbox”。

### 14.4 replace与merge

replace与merge都在包含 `chapterEditLeases` 的单一写事务中执行；前者是用户明确确认的破坏性恢复，后者是不丢本地进度的失败关闭合并。两者都从 `BackupImportInput {version, data: unknown}` 重新调用第14.2节的 version-aware parser，取得本次调用独立生成的 canonical snapshot 后才开写事务；绝不以 UI 已 parse 的 `snapshot`、也不以已 default 化而丢失 key-presence 的对象为唯一信任边界。

**replace 的不可移植运行状态。** 在清表前，仓储对 incoming 深克隆执行第6.6节 `normalizePlanForReplace`，随后用 `RepositorySnapshotV5Schema.parse` 重验正规化结果。事务清空全部可备份表及 `chapterEditLeases`，再 bulkPut 正规化快照；没有 session、旧 runner或旧页面能保留写 capability。完成段、current/rejected candidate history、outbox、source、calls、历史 attempt/batch 与时间均按输入保留；唯一有意变化是 `executionEpoch + 1`，以及所有 running attempt/batch/plan 被安全地转为 aborted/pending/paused。因而“v5恢复逐字段”只对已验证付费结果和历史字段成立，不能把尚在飞行的浏览器请求当成可恢复数据。`BackupSection` 在同一 JS 上下文先 best-effort abort 已登记的 runner，再调用 restore、invalidate 和提示重读；即使该步骤或其它标签失败，持久化正规化仍是权威。

**merge 的任务与编辑会话冲突。** merge 不尝试合并两棵translation segment tree，本期采用失败关闭：

1. 在同一个写事务中先读取完整本地可备份快照和全部 `chapterEditLeases`，尚不写任何数据。
2. 相同 `ChapterTranslationJob.id` 或相同 `ImportJob.id`：两行先经当前schema规范化并做递归深相等；只有完全相等才允许。任一segment、winner、attempt、outbox、阶段或时间不同都整份拒绝。
3. 同一chapterId出现不同editor jobId，或同一novelId出现不同ImportJob id，也整份拒绝。
4. incoming含ImportJob、local已有同novelId的Novel却没有ImportJob时也拒绝。任务完成或放弃后行会删除，当前schema没有永久import lineage可证明incoming不是旧备份中的已结束任务；接受它可能再次commit重复章节。只有整个novelId在local不存在，或local有同ID且深相等任务时，才接收incoming ImportJob。
5. incoming含非stale editor job、local已有同chapterId的Chapter却没有job时，先比较local当前content hash与incoming job sourceHash；不等就拒绝，不能靠incoming旧Chapter先覆盖local新正文再让旧任务复活。相等时可接收，因为apply仍受source hash保护。incoming stale job没有apply资格，仍交prospective引用校验。
6. 相同ImportJob ID但本地已destination commit、incoming仍draft，因不深相等直接拒绝，不能倒退后重复建章。
7. 若 incoming 将覆盖某个 local Chapter，且该 Chapter 有属于其它/本地 owner 的未过期 `ChapterEditLease`、incoming 的规范化 Chapter 与本地不深相等，则整份 merge 拒绝，不删除 lease、不改正文；提示“该章节正在另一编辑会话中，请先保存或关闭后再合并”。这样 merge 不会把尚未 flush 的本地文本变成无保护的旧 patch。
8. 其余普通实体保持现有“incoming同ID覆盖”语义，scenario仍按整棵替换。构造 prospective merged snapshot；本地独有editor job若因incoming Chapter正文覆盖而不再匹配，先对prospective job执行合法sticky stale失效转换，保留其付费结果。
9. 对prospective snapshot运行v5完整schema，覆盖retained local job与incoming Chapter、跨作品、悬空、unique、source、epoch和scenario清理后的全部引用。任何问题整份拒绝。
10. 只有上述步骤全过才执行bulk writes和scenario pruning。merge 保留未受 incoming 覆盖的有效 edit lease；事务失败时原库逐字段不变。

规范化深相等保留数组顺序，递归按排序后的object key比较；不忽略timestamp或诊断字段。冲突提示要求作者分别备份，并在一端完成或放弃该任务后重试，不能静默选“较新”或丢一份付费结果。

## 15. 外部输入校验与错误处理

### 15.1 输入规则

| 输入                           | 规则                                                                                                                                                                                     | 失败行为                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| sourceText                     | string，至少一个非空白grapheme；不trim、不归一换行；不新增总长度上限；现有文件20MiB限制不变                                                                                              | 不建计划、不请求；显示空正文或storage错误                                                                                                        |
| IDs/hash/locator namespace     | ID 1–128安全字符；secure IDs 32 hex；hash 64 lowercase hex；`draftIndex` 必为正整数且在 job 内连续唯一；segment/runBatch/outbox、unit/attempt及全部树/赢家/候选/计数引用遵守第5节唯一性  | duplicate/悬空值在仓储返回 `invariant`、在v5/merge/replace报BackupError；任何路径零写入，绝不选第一个                                            |
| invalid raw ImportJob recovery | 仅 `ImportJobSchema.safeParse(raw)` 失败的行可显示二次确认；传入未经default/preprocess的 raw fingerprint，必须由 type-tagged canonical encoder生成                                       | 取消/指纹变化/行变合法均零写；只有仍非法且指纹匹配才删该单行，不改Chapter/Proposal/glossary                                                      |
| import extraction finalization | expected jobId + 完整destination-stage fingerprint；全部item done；proposal key ASCII且唯一、ProposalSchema有效、ID/batch由稳定 helper推导                                               | not-ready/not-applied/invalid-input不写；合法时最终Proposal与删job同一事务，不能用createProposals+delete两步替代                                 |
| legacy plan initialization     | `drafts` 非空，`draftIndex` 为正整数且不重复；每项 `decision` 仅为 `translate/use-source`，且当前目标必须是 `translationPlan:null` 的外文草稿                                            | 空/非法/重复输入返回 `{kind:'invalid-input'}`，目标已变则 typed not-applied；两者都整个初始化零写入，use-source 不创建 batch/lease/request       |
| previewText                    | string，trim后非空；`<<<MLT1                                                                                                                                                             | `只允许出现在与plan source逐字符相等且来源匹配的fenced verbatim块，其他任意位置拒绝；不新增Chapter没有的长度上限                                 | apply返回invalid-preview，正文/任务不变 |
| raw envelope                   | 动态code-unit上限；exact frame；最多100条模型术语；每侧 trim 后 1–160 UTF-16 code units，并在持久化前过 `TranslationModelGlossaryEntrySchema` 与当前单个 translatable source-core anchor | frame/格式/长度失败使当前attempt失败，不写 candidate、正式结果或 outbox；仅“协议合法但无 source anchor”的 term 被计数丢弃，不重试、不写 glossary |
| destination                    | target枚举；side必须存在且同书；withStyle boolean                                                                                                                                        | commit domain拒绝并整体回滚                                                                                                                      |
| backup                         | header先验；仓储入口接收 `version + raw data` 并独立执行v1–v4 legacy或v5 required-key parser；Zod形状+全部引用/状态不变量；replace前executionEpoch正规化                                 | BackupError或安全暂停；UI与仓储任一边发现格式问题都在任何写入前整份拒绝，合法replace只转换不可移植running capability                             |
| lease时间                      | 翻译与编辑 lease 的 owner/token 均为32 hex；时间非负整数；`acquiredAt<=renewedAt`；V1新/续租时`expiresAt=renewedAt+120000`                                                               | 非法写入拒绝；自然过期只影响对应的claim/complete或正文写资格                                                                                     |
| contentRevision                | 非负安全整数；仅仓储在 `content` 逐字符实际变化时加一；v5显式必填                                                                                                                        | 旧 revision、缺 lease或另一 owner 均返回 typed conflict/busy，正文/job不半写                                                                     |

### 15.2 操作失败语义

| 操作                         | 失败条件                                                                                                                                   | 可恢复性与调用方结果                                                                                                                                               | 日志                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| plan创建                     | 空正文、secure random不可用、已检入的 V1 grapheme/切分invariant、quota                                                                     | 空正文修正后重试；secure random/存储问题可恢复；V1 invariant对任务fatal；零请求                                                                                    | 不记录正文；预期错误不写console             |
| 创建/重新分章导入任务        | `saveImportDrafts` 发现任意已有 raw ImportJob、draft index为空/重复/不连续；或 parsed discard 时 job/fingerprint/destination 已变化、quota | 创建返回 `import-job-exists/import-job-invalid/invalid-input` 且零写入；重新分章只能在明确二次确认的条件删成功后再次创建，旧 UI 不可覆盖进度；quota reject         | 不写console                                 |
| 损坏导入任务恢复删除         | raw 行仍无法parse、raw fingerprint 不同、已变合法、用户取消、canonical encoder拒绝不安全raw值                                              | 仅匹配的仍非法行删除；取消/变化/合法化均保留行并提示重读，Chapter/Proposal/glossary零改动                                                                          | 不写console                                 |
| claim                        | busy、job/draft locator/source/stale/use-source、顺序阻塞、quota                                                                           | typed union；错误 draftIndex 只返回not-applied，绝不扫描同文本其他draft；quota reject                                                                              | 不写console                                 |
| prompt准备                   | glossary/style读取、nonce唯一性、配置失败                                                                                                  | abort未dispatch claim；不计调用；显示对应错误                                                                                                                      | 不写原始内容                                |
| dispatch                     | identity/epoch/暂停/预算失效、事务失败                                                                                                     | typed union或reject；paused、非dispatched和事务reject均零fetch。预算/暂停分支原子回收未dispatch claim；事务reject按Dexie回滚后best-effort abort，失败则等lease过期 | 不写console                                 |
| renew                        | identity失效或storage                                                                                                                      | 旧holder abort/reload；storage可重试，最终等过期                                                                                                                   | 不写console                                 |
| 模型请求                     | 第9.2节类别                                                                                                                                | 按类别有限重试或暂停                                                                                                                                               | 服务端detail只截断存受控diagnostic，不含key |
| complete                     | 校验、lease、stale、quota                                                                                                                  | validation按策略；identity重读；quota保留内存候选并停                                                                                                              | 不写raw/prompt                              |
| promotion                    | 前驱未完成、seam失败、identity变化                                                                                                         | not-ready稍后；seam failed 原子归档 rejected candidate、清 current candidate 后按验证失败策略重试/二分；不重复模型调用                                             | 不写console                                 |
| reconcile                    | glossary/task put、artifact identity、outbox matrix或model-term schema/source-anchor失败                                                   | “译文已保存，译名待同步”并暂停；可无模型重放；非法状态/term不写 glossary，只有未锚定的已过滤 term 以受控计数显示                                                   | 不写console                                 |
| finalize                     | 未完成叶、unsettled outbox、invariant、事务失败                                                                                            | not-ready或task-fatal；章级正文不半更新                                                                                                                            | 不写console                                 |
| destination commit           | unresolved、任务替换、外传无效、事务失败                                                                                                   | 整体回滚，作者修正后重试                                                                                                                                           | 不写console                                 |
| editor lease / flush / apply | other owner未过期、owner/token失效、revision不同、save失败、visible/DB hash不同、preview非法                                               | busy显示到期；lease-lost/content-conflict保留本地文本、停止runner、零自动重写；hash不同sticky stale；正文/任务不半应用                                             | 不写console                                 |
| abandon/rebuild              | expected job变化、storage                                                                                                                  | not-applied后重读；不误删新job                                                                                                                                     | 不写console                                 |
| v7→v8打开                    | IndexedDB无法加表/索引                                                                                                                     | 应用启动fatal，沿用现有数据库错误界面                                                                                                                              | 不新增远程日志                              |
| backup export/import         | 一致性、版本、v5键、restore epoch上限、merge冲突、事务失败                                                                                 | 不下载或零写入，给可操作BackupError；合法replace会暂停在飞调用并要求明确继续                                                                                       | 不写备份正文                                |

项目没有远程日志或埋点，本任务不引入。`sanitizeTranslationDiagnostic`在持久化/UI前移除当前配置API Key的精确值、`Bearer\s+\S+`和常见`sk-...`片段，再截到500 code units；为空时只保留error kind/status。所有预期错误通过typed result、持久化受控failure和UI呈现；不得把API Key、原文、译文、prompt或服务端原始body写入console。

## 16. 具体文件改动

### 16.1 领域、LLM与存储

- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/schema.ts`：完整translation schemas、模型派生 glossary 专用 schema及 source-core anchor/matrix semantic hooks、current/rejected candidate 分离、`ratioEligible`、`graphemeRules`、`executionEpoch`、ImportDraft default、`Chapter.contentRevision`、`ChapterEditLease`、decision固定为translate的ChapterTranslationJob、v5快照共享校验。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/graphemeBreakV1Data.ts`（新增）与 `/Users/leadencedar/Production/Project/MyLiterature/src/domain/graphemeBreakV1.ts`（新增）：已检入 Unicode 15.1 property table 与完整 UAX #29 V1 breaker；任何计划创建/恢复/备份均不依赖 `Intl.Segmenter`。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/backupSnapshot.ts`（新增）：`BackupError`、`BackupImportInput`、legacy/v5 parser、required-key preflight，供 UI 与仓储独立复用。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/tokenEstimate.ts`（新增）与 `/Users/leadencedar/Production/Project/MyLiterature/src/context/tokens.ts`：移动并原样重导出estimateTokens。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/translationPlan.ts`（新增）：hash、基于已检入 UAX #29 V1 breaker 的 Markdown scanner、切分/二分、V1 `ratioEligible` 分类与重算、plan invariant、执行epoch与恢复正规化、进度。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/translationProtocol.ts`（新增）：envelope/parser、marker contains、protected token、reference/ratio/seam验证，以及模型 glossary 的 source-core anchor filter/受控丢弃计数。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/importJob.ts`：旧任务全函数兼容；不伪造plan；允许新worldview冻结drafts；导出唯一的稳定递归 key 排序 canonical serializer 与 `fingerprintImportDraftState`，让 UI 与仓储比较同一 draft-phase job 表示。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/importWorldview.ts`（新增）与 `/Users/leadencedar/Production/Project/MyLiterature/src/features/import/worldview.ts`：下沉并重导出现有打包算法。
- `/Users/leadencedar/Production/Project/MyLiterature/src/data/NovelRepository.ts`：第10节全部union、含 import `draftIndex` 的类型关联 scope/identity、只创建空槽位的 `saveImportDrafts` 与确认条件删除、原子 legacy decision 初始化、执行epoch、编辑lease/正文条件写、version+raw-data 备份导入边界和提取semantic patch。
- `/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/db.ts`：精确v8、两张新表声明与旧Chapter的`contentRevision:0`安全迁移。
- `/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/DexieNovelRepository.ts`：任务CRUD、只创建空 import slot/条件 discard、按 import draft locator 的条件claim/dispatch/complete/candidate/outbox/finalize、原子 legacy decision 初始化、stale、编辑lease/revision正文事务、destination guard、提取最小patch、级联、一致快照、以 version+raw-data 重验的 replace运行正规化与merge预检。
- `/Users/leadencedar/Production/Project/MyLiterature/src/proposal/apply.ts`：章节正文 replace 改走带revision、无活动编辑lease的 `writeChapterContent`，冲突保留提案，不走旧 `updateChapter` 正文旁路。
- `/Users/leadencedar/Production/Project/MyLiterature/src/llm/types.ts`：给 `LlmClient.streamChat` 增加可选 `beforeRequest?: () => Promise<void>` 参数，现有调用不传时行为不变。
- `/Users/leadencedar/Production/Project/MyLiterature/src/llm/useLlm.ts`：`TextRunOptions.beforeRequest?: () => Promise<void>` 原样透传给 `streamChat`；分段runner在非`dispatched`结果上抛`TranslationDispatchBlocked`，不吞该sentinel。
- `/Users/leadencedar/Production/Project/MyLiterature/src/llm/OpenAiCompatibleClient.ts`：在 `post` 内先校验配置、构造 URL/headers/JSON body，再 await optional hook，之后才进入只包围 fetch 的网络错误 catch；hook reject绝不发fetch、也不被转成网络错误。`/Users/leadencedar/Production/Project/MyLiterature/src/llm/sse.ts` 不把`[DONE]`升级为业务成功条件，保留现有finishReason与坏帧行为供协议测试。
- `/Users/leadencedar/Production/Project/MyLiterature/src/llm/errors.ts`：只补翻译错误分类helper需要的403/其他4xx准确映射；不改变既有中文主文案。

### 16.2 功能、备份与文档

- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chunkedTranslation.ts`（新增）：共享prompt、glossary和流式预览。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chunkedTranslationRunner.ts`（新增）：可注入依赖的调度状态机，所有 runner write 带execution epoch并穷尽paused dispatch分支。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/useChunkedTranslationRunner.ts`（新增）：React生命周期、abort、heartbeat、poll和本地恢复前runner registry注销。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chapterEditLease.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/useChapterEditLease.ts`（新增）：owner/token、acquire/renew/release、busy/read-only与冲突状态。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/translate.ts`：保留旧builder回归，导出固定文学翻译规则供新builder复用；删除业务对6000单次提示的依赖。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/import/importFlow.ts`：plan/use-source/candidate/outbox/expired lease aware恢复，并把 legacy `none + null` 暴露为必须原子选择的未决定状态。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.tsx`：共享runner、段级UI、明确use-source、只创建无任务 import slot、重新分章二次确认后条件 discard、expectedJobId提取patch、世界观原文保留。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/TranslateSheet.tsx`：持久任务读取、段进度、完整预览、stale/放弃/重建。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/ChapterEditorScreen.tsx`：获取编辑lease、read-only busy状态、串行flush barrier、revision/lease条件正文写、即时local stale、专用apply、任务轮询、冲突保留本地文本和现有撤销接线。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/WritingPage.tsx`：向editor传任务刷新所需边界；保留`key={chapter.id}`和单套DOM。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/export/backup.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/export/BackupSection.tsx`：v5 wire/parsed object 分离、header后 version-aware parser、restore 将原始data与version传给仓储、严格required keys、replace运行正规化前的本地abort和冲突提示。
- `/Users/leadencedar/Production/Project/MyLiterature/docs/产品文档.md`、`/Users/leadencedar/Production/Project/MyLiterature/docs/使用说明.md`、`/Users/leadencedar/Production/Project/MyLiterature/docs/设计方案.md`、`/Users/leadencedar/Production/Project/MyLiterature/docs/开发计划.md`：同步两条链路自动分段、envelope、恢复/成本、原文、stale/放弃和备份v5；删除“384K所以无需分段”“6000字单次提示”“只能放弃重切”等过时说法。开发计划只写最终实跑数字。

## 17. 测试设计与自动化验收

### 17.1 测试文件

- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/graphemeBreakV1.test.ts`（新增）：已检入 Unicode 15.1 conformance vectors、CR/LF、Hangul、ZWJ、Regional Indicator、组合符和 Indic conjunct；mock/替换宿主 `Intl.Segmenter` 后结果不变，cluster 内 endpoint 仍拒绝。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/translationPlan.test.ts`（新增）：hash、Unicode/Markdown（含20k多行表与5k单行表）切分、二分、V1 ratio eligibility（散文/表格/URL模板密度）、跨宿主恢复、进度和预算纯函数。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/translationProtocol.test.ts`（新增）：envelope、模型术语 trim/空白/160/101 边界、current-source anchor（无关/reference-only 丢弃计数）、marker、unit、protected token、ratio、reference和seam。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chunkedTranslation.test.ts`（新增）：prompt字节稳定、references和verbatim排除。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chunkedTranslationRunner.test.ts`（新增）：dispatch记账、`beforeRequest`拒绝时零fetch且不遗留running lease、重试、预算、claim后暂停/abort、execution epoch与延迟响应。
- `/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/chunkedTranslationRepository.test.ts`（新增）：真实fake-indexeddb条件事务、current/rejected candidate 生命周期、outbox状态矩阵与 source anchor、同文本同segment ID的跨draft locator隔离、legacy原子决策初始化、stale、编辑lease/revision、并发、级联、只创建空 import slot/确认 discard、replace隔离和v8。
- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/importJob.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/importFlow.test.ts`：default null、旧任务、新worldview阶段、旧 `none + null` 的显式原子 decision 与恢复，以及 canonical draft fingerprint 对对象 key 顺序稳定、任一 paid-progress 字段变化即不同。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.test.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.destination.test.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.norms.test.tsx`：长章、多段、use-source、目的地、世界观和中文基线。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/translate.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/ChapterEditor.test.tsx`：旧prompt回归、编辑lease、flush/stale/预览/采用/放弃与双实例冲突保留。
- `/Users/leadencedar/Production/Project/MyLiterature/src/llm/OpenAiCompatibleClient.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/sse.test.ts`：finishReason、clean EOF、坏frame基线；前者另断言 JSON 序列化失败时 hook 未调用、successful hook 在 injected fetch 前执行、hook reject零fetch且原样传播。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/export/backup.test.ts`：v1–v5、required keys、一致导出、replace/merge冲突、candidate/outbox model term损坏或无 source anchor 零写入拒绝、**直接调用仓储 `BackupImportInput` 边界**的 v5 缺键零写入/v4缺键可恢复、恢复前deferred response隔离和付费进度往返。
- `/Users/leadencedar/Production/Project/MyLiterature/src/test/chunkedTranslationDocs.test.ts`（新增）：四份文档正向契约和过时语句负断言。
- `/Users/leadencedar/Production/Project/MyLiterature/src/test/chunkedTranslationAcceptance.ts`（新增）：机器可读 AC 证据映射，只含目标测试文件与精确 `it/test` 标题，不进生产入口。
- `/Users/leadencedar/Production/Project/MyLiterature/src/test/chunkedTranslationAcceptance.test.ts`（新增）：读取上述映射和每个目标测试源码，断言映射文件存在且含相应精确测试定义；因此 AC-54 的映射校验本身被 Vitest 执行，不能只作为未运行的 `.ts` 清单。

所有事务、unique index、双实例、导出交错和restore使用现有fake-indexeddb与真实`DexieNovelRepository`。时间用`vi.setSystemTime`/fake timers，网络用deferred fetch，不依赖开发服务器。当前基线是75个测试文件、1719个测试全过；实现后不得少于该既有覆盖，新增用例数和最终总数只从最后一次命令输出填写。

### 17.2 AC-01至AC-54映射

| AC    | 自动化断言                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | 20k+无标题英文外层仍一章；plan多段、上限、序列化ID稳定和exact reconstruction；V1 `graphemeRules='uax29-15.1'` 不受 mocked/差异 `Intl.Segmenter` 影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AC-02 | 空行/行/句/标点/grapheme逐级场景；代理对、ZWJ、组合符、RI与Indic conjunct不拆；篡改到 V1 cluster 内的 endpoint 在恢复/replace 被拒                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AC-03 | 闭合/未闭合fence、ATX/Setext、列表/引用/表格；所有请求含current/reference均无fence唯一串；超长标题零fetch；20k多行表按完整row切、单个5k table row在行首结构后的cell body切（有 leading `                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `时保留在首片），所有请求仍不超cap且表格` | `/前缀/对齐标记无丢失或复制 |
| AC-04 | envelope在每个字符边界分块，unit顺序正确，所有控制语法不进结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AC-05 | 缺失、重复、错序、未知unit表驱动拒绝，正式字段/outbox为空                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AC-06 | complete缺失/重复/改写/正文中/尾随；clean EOF、坏尾帧、stop/null均不能绕过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AC-07 | 第2段length直接split且无同尺寸retry，第1段逐字段不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AC-08 | 非length验证失败严格重试恰一次，第二次只split该叶                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AC-09 | 空unit及Markdown、inline code、URL、模板、编号损坏拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AC-10 | 199/200 token和29/30/300/301%边界；200-token散文 `ratioEligible=true` 必检查；表格、URL/模板/opaque token密集及verbatim按 V1 classifier 为false且不触发数值比例失败；保存/恢复重算资格不漂移；本期无人工绕过                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AC-11 | seam 39/40边界；返回时序乱序仍按sourceStart组装                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AC-12 | 240/240/160 reference；短内容全取；同主线/同外传；有sourceContent但当前content外文时省略上一章                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AC-13 | 多层split范围、父不计进度/拼接、revision原子增加                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AC-14 | pending/running/awaiting/failed/unsettled outbox时finalize拒绝；`rejectedCandidateHistory` 或 split父诊断不阻塞；candidate→seam-failed→strict retry done与candidate→seam-failed→split→子叶done均可finalize；全部正式done后成功                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AC-15 | network/408/429/5xx各一次精确退避；401/402/403/config/其他4xx零自动retry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AC-16 | depth、500、root7、extra6边界；第6个extra settle后即使下一root是base也零fetch；dispatch前发现预算已耗尽时回收未dispatch claim、hook拒绝且零fetch；dispatch事务reject同样零fetch并仅best-effort释放lease；两draft导入的一次授权共享runBatchId但各plan计数独立，pause/终态失败/预算会关闭未dispatch sibling batch；新batch累计不清零                                                                                                                                                                                                                                                                                                                                      |
| AC-17 | pause命中已dispatch段时当前段可settle后停；claim后卡在beforeRequest、pause后必须把未dispatch attempt→aborted、segment→pending、batch→paused，返回paused且零fetch/零计数；Import共享sibling与editor各测一次；Sheet/编辑器/换章/刷新abort；迟到结果not-applied                                                                                                                                                                                                                                                                                                                                                                                                            |
| AC-18 | complete事务注入quota；内存结果可见、DB非done、无下一请求、提示备份；lease有效时“再次保存”复用同一raw/identity落盘且调用数不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AC-19 | 第1段reconcile后第2段prompt有词；失败/candidate未晋升/替代/缺marker无词；合法 envelope 中无关 term 或只在 reference 出现的 term 只计数丢弃、不建outbox/不污染glossary，当前source core中的 Ashford 仍按first-wins同步                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AC-20 | outbox两个中断点幂等；use-source pending→discarded不堵后章，撤销discarded→pending先对账且零重译；editor 或 translate plan 含discarded、use-source含pending、错误status/timestamp组合均由schema、直接reconcile/finalize和v5 restore零写入拒绝                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AC-21 | ImportScreen 20k+一章多请求；部分完成时draft.content exact source、sourceContent空                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AC-22 | import finalize单事务字段；注入失败章级字段全旧、segments保留                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AC-23 | unmount/remount保留done/calls/outbox，只请求最早未完成叶；同一 jobId 的旧分章调用在任一 segment done、outbox存在或plan done后调用 `saveImportDrafts` 均返回not-applied且逐字段零写入；二次确认的 discard 若fingerprint变化也零写入                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AC-24 | import第2段length/marker缺失只影响第2段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AC-25 | use-source提交完整源文；done段保留；撤销先恢复outbox再续，绝无混排；旧外文 `none + null` 选择use-source时与plan创建同事务持久化，立即重载仍为use-source且零模型调用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AC-26 | 直接调用main/side/worldview commit含unresolved时零写入拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AC-27 | main/side translated与use-source的content/source/language/wordCount/sideStoryId/index                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AC-28 | worldview从翻译到提取失败/刷新/收尾前始终零Chapter；source可从冻结draft/plan恢复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AC-29 | v7旧done/pending/failed/foreign-none四路；旧 `none + null` 的translate/use-source均经带decision的原子初始化，空/重复/非法选择返回invalid-input且零写入，竞争中返回not-applied而不遗留默认translate plan；旧main/worldview不伪造plan、不删Chapter                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AC-30 | 中文fixture的plan/lease/request为零，步骤、提取次数和prompt逐字节基线                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AC-31 | UI初始/split后章段字符/基础/新增/累计计数，父不重复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AC-32 | editor 20k+多请求；preview前和未采用时直查Chapter不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AC-33 | apply自改完整preview、完整source/language、无marker/reference；持有edit lease且revision匹配才一次写正文/任务，事务失败零半写                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AC-34 | 关闭Sheet、离开章、刷新三路保留done并不重复请求                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AC-35 | completed-preview重挂载零fetch、恢复生成版textarea、Chapter不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AC-36 | fake timer覆盖active/paused/failed/completed-preview首次 textarea 输入及 `commitContent`/undo 的同步local stale；800ms内apply/continue零覆盖/零fetch；在途flush barrier等待且失败传播；双实例中A持久edit lease并输入未flush时B apply为editing-busy、不删job不写正文；A lease过期后B apply成功，A旧flush因token/revision冲突保留本地文本且不覆盖                                                                                                                                                                                                                                                                                                                         |
| AC-37 | stale rebuild新job/hash；旧deferred attempt不能写job/glossary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AC-38 | editor第2段length/marker只重试/split它，第1段与正文不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AC-39 | 两repository并发create/authorize/claim：唯一job、一个fetch、另一个busy文案；同一runner的batch/lease owner与epoch稳定匹配，重复authorize不替换其未过期running attempt；第二个ChapterEditor未取得edit lease时只读且不能启动/采用                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AC-40 | 普通关闭保留；放弃确认取消/确认；确认后Chapter不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AC-41 | editor outbox供下一段；stale/abandon后的迟到attempt无glossary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AC-42 | 两个repository实例用schema合法fixture预置不同segment的running attempt模拟旧/恢复并发，反向完成：后段先落awaiting candidate、前段done后晋升，两份保留；同段旧/new只有current token获胜；同一ImportJob内两draft可有相同source文本/segment ID，错误draftIndex、旧response或重复attempt均not-applied且不改另一draft                                                                                                                                                                                                                                                                                                                                                         |
| AC-43 | import/editor删旧建同文本新job，旧完整identity对所有写API均not-applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AC-44 | 未过期不可抢、过期新claim、旧response拒绝；release成功立即继续、失败120秒后继续                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AC-45 | deleteChapter/deleteSideStory/deleteNovel各自在含chapterTranslationJobs与chapterEditLeases的同一事务删除相应job/session；snapshot悬空拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AC-46 | DB/legacy schema缺plan补null、缺Chapter.contentRevision补0；v7旧数据正文相关字段逐字段保持且不白屏                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AC-47 | v7→v8 `verno===8`、chapterTranslationJobs唯一索引、chapterEditLeases单章主键、旧Chapter正文逐字段不变且revision=0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AC-48 | v5 export与replace/merge保留source、`graphemeRules`、`ratioEligible`、正式done/current candidate/rejected history/outbox、calls、历史attempt/batch/time；export与apply/reconcile交错只得前或后快照；deferred stream导出后same-session replace，ImportJob与ChapterTranslationJob的running attempt均安全转paused、新epoch下旧complete为not-applied、segment/outbox/glossary不变，作者继续才建新attempt；mocked host segmenter 不影响restore结论                                                                                                                                                                                                                           |
| AC-49 | v1–v4 replace/merge defaults；直接调用 `repository.importSnapshot({version:4,data:缺新增键}, mode)` 可恢复，而 `{version:5,data:同形缺键}` 在UI parser与仓储边界均零写入拒绝；v5分别删除顶层job数组、draft plan键、Chapter.contentRevision和嵌套plan `graphemeRules`/segment `ratioEligible`/attempt/current-candidate/rejected-history/outbox/epoch字段均零写入拒绝；version6未知正文先报更新版本                                                                                                                                                                                                                                                                      |
| AC-50 | 悬空/跨书/双job/坏hash/洞重叠/错误`graphemeRules`或V1内部endpoint/错误`ratioEligible`/非法current-or-rejected candidate/attempt与batch owner或epoch不一致；candidate/rejected history/outbox内空白、161-code-unit、第101条、无current-source anchor模型term或非法outbox matrix在replace/merge均零写入拒绝，作者手工glossary不受限；editor plan use-source 的 replace/merge零写入拒绝，直接authorize/finalize/apply同样只返回invariant且零preview/正文/glossary；same-id不同done segment、different winner、ImportJob阶段倒退、incoming旧ImportJob复活、incoming非stale editor job覆盖不同local正文、未过期edit lease上的incoming Chapter覆盖均prospective预检零写入拒绝 |
| AC-51 | 全量既有导入、外传、摘要、提取、导出、计划、glossary和互动推演测试行为不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AC-52 | 文档契约测试逐文件断言自动分段、envelope、段级恢复、成本上限、原文、stale/放弃、v5，并负断言三类过时语句                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AC-53 | 自动命令`npm run build`退出0；`npx vitest --run`零失败；最终数字由命令输出写入开发计划                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AC-54 | `chunkedTranslationAcceptance.ts`映射到AC-04/14/17/21/32/36/42/44/48/50/51；`chunkedTranslationAcceptance.test.ts`用Node fs逐项读取目标测试源码，验证每个证据ID的文件存在且精确`it/test`标题真实定义，映射不能只是未执行的清单                                                                                                                                                                                                                                                                                                                                                                                                                                          |

文档契约负断言至少包括：“输出上限384K所以整章无需分段”、“超过6000字仅提示单次截断并要求手工重切”、“编辑器只检查finishReason/采用时才合并译名”。AC-54不保留人工发布清单作为唯一证据。

## 18. 实施顺序与验证关口

1. 先完成token移动、已检入 UAX #29 15.1 grapheme breaker/data、hash、translation schemas（含graphemeRules/execution epoch）、切分和protocol纯函数及测试。
2. 加Dexie v8、编辑lease/contentRevision、仓储identity/claim-dispatch/pause/candidate/outbox/finalize/stale和真实事务测试。
3. 改备份v5、version+raw-data仓储边界、一致导出、replace运行正规化、merge prospective预检，并先通过全部旧备份、直接仓储导入、restore deferred response与新并发测试。
4. 接导入：安全的空槽创建/确认discard、旧plan懒初始化、use-source、destination guard、世界观冻结drafts和提取最小patch。
5. 接编辑器：edit lease、flush barrier、即时stale、持久任务、完整preview、条件apply/abandon/rebuild。
6. 更新四份文档和文档契约；最后运行`npm run build`与`npx vitest --run`，只记录实际数字。

任何阶段若source/tree invariant、迟到响应、destination原子性、outbox顺序、备份预检或中文基线失败，必须修复责任层，不通过放宽UI断言绕过。

## 19. 明确不做

不设计或预留原作脉络、原作事件、Facet子设定、复杂能力条件子设定、OC母版或互动推演新行为。不新增翻译append按钮、段级手工采用、用户拖动边界、多段并行、第二模型审校、回译、provider输出上限学习、世界观永久素材库、后端或依赖。不依靠提高`max_tokens`证明完整，不重构无关数据表和prompt。

## 20. 本轮设计评审逐条响应

| Finding | 处理                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | 已处理。第14.4节规定同ID任务只有规范化深相等才可merge，任何进度/阶段差异整份零写入拒绝，并在写前校验prospective snapshot。                                                                                                      |
| 2       | 已处理。第12.1–12.2节覆盖所有未结束状态的同步local stale、可失败串行flush barrier，以及create/continue/retry/apply的visible+DB双hash检查；第12.4节进一步删除采用前的直接译名写入，避免 stale 预览在 apply 被拒后污染 glossary。 |
| 3       | 已处理。第14.2节分离legacy与v5 schema；v5强制显式`chapterTranslationJobs`和每个draft的`translationPlan`。                                                                                                                       |
| 4       | 已处理。第14.3节要求全部快照表在同一只读事务读取并在序列化前用v5严格schema校验。                                                                                                                                                |
| 5       | 已处理。第6.5节锁定attempt superseded、segment pending、active ID清空、batch aborted、plan清active batch的原子转换，历史lease保留。                                                                                             |
| 6       | 已处理。第6.2和11.2节增加outbox discarded终态、use-source结算和撤销恢复/先对账语义；第10.6和12.4节锁定模型译名只能经outbox写入，不在导入或预览采用时旁路合并。                                                                  |
| 7       | 已处理。第4.2、6.1、8.4、10.4节增加awaiting-predecessor与非正式candidate，前驱完成后才做seam并正式晋升。                                                                                                                        |
| 8       | 已处理。第7.2与8.2节禁止任何verbatim范围进入current或reference，且不跨fence取更远上下文。                                                                                                                                       |
| 9       | 已处理。第8.2、8.4节只对规范化后至少40 grapheme的reference启用40-grapheme窗口否决。                                                                                                                                             |
| 10      | 已处理。第8.1节定义唯一非行锚定`containsTranslationProtocolSyntax`，用于unit、candidate、segment、final assembly和apply preview；source-origin exact fence通过来源图单独豁免。                                                  |
| 11      | 已处理。第3.2、6.3、10.3节分离claim与dispatch；本地准备失败不计数；达到任一上限后当前attempt settle即全局exhausted。                                                                                                            |
| 12      | 已处理。第10.1–10.2节给出完整输入和结果union，所有run写带expectedRunBatchId；第10.6节锁定单chapter/chunk extraction semantic patch。                                                                                            |
| 13      | 已处理。第17节新增四文档自动契约测试、过时语句负断言和可机器追踪的AC-54证据映射。                                                                                                                                               |
| 14      | 已处理。第4.1节明确policy只持久化schema列出的解释性值；lease、poll和退避由plan version 1固定并测试。                                                                                                                            |
| 15      | 已处理。第8.2节只按当前content非空且无需翻译选上一章；sourceContent不再单独取得资格。                                                                                                                                           |

## 21. Terra 第 1 轮审查逐条响应

| Finding                                                                                                                             | 严重度 | 设计章节 / 行范围                                                               | 实际机制                                                                                                                                                                                                                                                                                                                                                     | 尚存限制                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 覆盖恢复会写回相同的在飞 attempt identity，旧响应可改变刚恢复的任务、outbox或 glossary。                                            | HIGH   | §4.2 `executionEpoch`、§6.6、§10.1–§10.4、§14.4、§17.2 AC-48                    | 每个 plan/attempt/batch 持久化 epoch，identity binding 与所有 runner-scoped 条件写都带它。replace 前严格解析、epoch 加一并把所有 running attempt/batch/plan 原子正规化为 aborted/pending/paused；导入共享 batch sibling 一起结束。恢复前回调返回 `restore-epoch-mismatch`，新 runner 重读 epoch 后才能对保存的 candidate/outbox 做零成本维护或新建 attempt。 | 已发出的 HTTP 请求不能撤回，也可能已计费；本地 abort 只是节省流量。恢复有意不保留“运行中”状态，作者需明确继续。           |
| 另一标签页在 800ms 防抖窗口内编辑时，旧 preview 仍可能采用，随后旧 flush 覆盖译文。                                                 | HIGH   | §4.4–§4.5、§9.5、§10.1–§10.5、§12.1–§12.4、§14.1–§14.4、§17.2 AC-33/36/39/45/47 | v8 增加不进备份的单章 `ChapterEditLease` 和持久 `Chapter.contentRevision`。编辑器未取得 lease 只读；flush、创建/继续和 apply 均在同一事务比较 owner/token、expiry、revision、hash及job。正文变更递增 revision并同事务sticky stale；lease 过期后旧 flush 因 token/revision 拒绝且保留本地文本。merge 不会覆盖持有有效 edit lease 的 Chapter。                 | 多标签不是协作编辑：同章只允许一个可写会话。崩溃后最长等待 120 秒；旧文本只能复制、比较或用户确认重载，系统不会自动合并。 |
| pause 在 claim 与 dispatch 之间未定义 attempt/segment/batch 的退出，可能仍 fetch 或留下 terminal batch 下 running segment。         | MEDIUM | §6.1、§9.3、§10.1–§10.3、§17.2 AC-17                                            | `requestTranslationPause` 原子 abort 所有 `dispatchedAt=null` attempt、把 segment 退 pending、清 active ID并结束无在飞 batch。`beginTranslationDispatch` 重读状态并返回 `{kind:'paused'}`，runner 零 fetch/零计数；已 dispatch 段才获准 settle 后暂停。导入共享 batch 的未启动 sibling 同步关闭。                                                            | pause 与已出站请求并发时不能撤销已计成本；该请求只可 settle 或普通关闭尽力 abort，之后绝不启动下一请求。                  |
| 通用 TranslationPlan 允许 editor job 使用 import 专属 `decision='use-source'`，外部 v5 数据或仓储入口可留下无法解释的 editor 状态。 | MEDIUM | §4.4、§5、§6.4、§10.1–§10.4、§14.2、§17.2 AC-50                                 | `ChapterTranslationJobSchema.superRefine` 强制 decision translate；v5/prospective snapshot 同样拒绝。所有 chapter scope authorize/finalize/apply 再作事务断言并返回 `invariant`，不发送请求、不归一化、不写预览、正文或 glossary。                                                                                                                           | 旧 v1–v4 没有 editor job，不需要迁移此状态；直接绕过仓储手写 IndexedDB 仍会在下一次语义写或导出/导入时被拒绝。            |

## 22. Terra 第 2 轮审查逐条响应

| Finding                                                                                   | 严重度 | 设计章节 / 行范围                                              | 实际机制                                                                                                                                                                                                                                                                                                                                    | 尚存限制                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 接缝失败的 `seam-rejected` candidate 会在重试或二分后永久阻塞 finalize。                  | MEDIUM | §4.2、§5、§6.1、§7.5、§8.4、§10.4、§12.5、§17.2 AC-14/42/48–50 | current `candidate` 只允许有效 awaiting leaf 持有。promotion seam 失败同一事务将可复制输出写进 `rejectedCandidateHistory`、清 current candidate、attempt/segment 转 failed；retry/split 只能从无 current candidate 的 failed leaf 开始，child 不继承历史。finalize 只检查有效叶 current candidate，history 不参与调度、outbox、进度或完成。 | 接缝失败输出只供诊断/复制，不自动拼接或合并术语；作者仍需让严格重试、二分或新授权得到正式结果。                        |
| import scope/identity 没有 draft locator，重复 source 或 segment ID 可能写错 draft。      | MEDIUM | §3.2、§5、§8.1、§9.1/9.3/9.4、§10.1–§10.4、§14.2、§17.2 AC-42  | `ImportTranslationScope`、运行 identity 与 artifact identity 都包含持久 `draft.index`。所有 plan-scoped import API 泛型绑定 scope/identity，事务先按 draftIndex 定位，再验 job/source/segment/attempt/batch/lease/epoch；identityBinding 也用封闭 draft.index 重算。共享 runBatchId 只用于批次协同，不能作为定位键。                        | 直接绕开仓储篡改 IndexedDB 不会被浏览器实时拦截，但下一次语义写、导出或严格 v5 恢复会因重算/不变量失败关闭。           |
| 旧外文 `none + translationPlan:null` 不能原子持久化作者的 use-source 选择。               | MEDIUM | §4.3、§10.1–§10.2、§11.1–§11.2、§15.1、§17.2 AC-25/29          | `initializeImportTranslationPlans` 改为逐 draft 接收 `{ draftIndex, decision }`。一个事务先构建全部计划，use-source 同时写完整快照、segments、decision 和章级镜像，不先落默认 translate，且不创建 batch/lease/request；任一竞争或非法目标全体零写入。已有 plan 的切换继续走带版本条件的 decision API。                                      | use-source 不会翻译或自动恢复；作者想继续翻译必须在目的地前显式改回 translate。                                        |
| candidate/outbox 复用宽松的手工 glossary schema，损坏 v5 可写入空白、超长或超量模型词条。 | MEDIUM | §4.2、§5、§8.4、§10.6、§14.2、§15.1–§15.2、§17.1–§17.2 AC-50   | 新增只用于模型输出的 `TranslationModelGlossaryEntrySchema`，trim 后每侧 1–160 UTF-16 code units；candidate、rejected history 与 outbox 全部使用它并限制 100 条。parser、语义写、v5 required/strict parse 和 reconcile 均复用该边界；作者手工 `GlossaryEntrySchema` 不变。                                                                   | 该校验保证结构、长度和持久化来源，不替代作者对译名语义质量的判断。                                                     |
| “自然语言”比例校验资格未定义或持久化，表格/URL/模板段的失败行为会漂移。                   | MEDIUM | §4.1–§4.2、§5、§7.3–§7.5、§8.4、§14.2、§17.1–§17.2 AC-10/48/50 | 锁定纯 `isRatioEligibleV1`：verbatim、table atom、低 prose 密度和 opaque protected-token 密度达到阈值的 segment 为 false；创建与二分将结论写入 immutable `ratioEligible`，语义/备份重算同一 V1 函数，恢复不按未来启发式改写。比例仅在 true 且至少200 tokens 时执行。                                                                        | 分类器有意保守，结构化段可能跳过数值比例检查；envelope、unit、受保护 token、接缝和其他验证仍强制，且本期没有人工绕过。 |

## 23. Terra 第 3 轮审查逐条响应

本轮读取 `design-review-terra.md` 与 `design-verdict-terra.json` 后，6 项 finding（HIGH 1、MEDIUM 5）均已落实到正文和自动化验收。没有自行修改 Terra verdict，也没有 backlog 或忽略任何 finding。

| Finding                                                                                             | 严重度 | 设计章节 / 行范围                                                                                       | 实际机制                                                                                                                                                                                                                                                                                | 尚存限制                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 相同 jobId 的旧分章调用仍可整行替换已开始翻译的 ImportJob，删除 paid segments/history/outbox。      | HIGH   | §10.1–§10.2 `SaveImportDraftsResult` / `discardImportDraftJob`；§10.7；§11.1；§15.2；§16；§17.2 AC-23。 | `saveImportDrafts` 只在完全无 raw ImportJob 时 `add`；任何可解析或损坏的现存行都 typed not-applied，永不 delete+put。重新分章只能经二次确认、完整 canonical job fingerprint 条件删除、重新确认空槽后新建；`deleteImportJob` 拒绝 draft-phase 旁路。唯一索引竞态转换为 not-applied。     | 作者明确 discard 后，未 applied 的付费进度按确认删除，不能恢复；已 applied glossary 仍有意保留。 |
| 备份版本和 raw key presence 在现有 importSnapshot 边界丢失，仓储无法独立区分损坏 v5 与合法 legacy。 | MEDIUM | §10.1–§10.2 `BackupImportInput`；§14.2–§14.4；§15.1；§16；§17.1/AC-49。                                 | 新增 domain `backupSnapshot` parser；`parseBackup` 保留 `rawData`，`restoreBackup` 将 `{version, rawData}` 传入仓储。仓储每次独立按版本解析，v1–v4 补 default、v5 先 `hasOwn` required-key 预检；直接仓储调用与 UI restore 均零写入失败关闭。                                           | 两次 parser 是刻意冗余的防线，增加少量本地 CPU；备份内容仍受浏览器可用内存限制。                 |
| `Intl.Segmenter` 不是跨设备固定 V1 规则，恢复会把已付费 range 误拒或接受内部 endpoint。             | MEDIUM | §1.1；§3.1；§4.1–§4.2；§5；§7.1；§14.2；§16；§17.1–§17.2 AC-01/02/48/50。                               | 项目内置、已检入 Unicode 15.1 property tables 与完整 UAX #29 GB1–GB13/GB9c breaker；plan 明写 `graphemeRules='uax29-15.1'`，创建、切分、二分、restore、replace/merge 只调用它。测试 mock 宿主 segmenter 仍得到同一结果，并拒绝 V1 cluster 内 offset。                                   | Unicode 15.1 之后的新 grapheme 规则不会回写 V1；升级必须新增 plan version 和 data table。        |
| 超 hard-cap 表格没有无损、不超限的合法切分路径。                                                    | MEDIUM | §7.2–§7.4；§8.3；§17.1–§17.2 AC-03。                                                                    | table group 改为 ratio 分类/row-boundary 元数据，不是不可切 atom。多行表在完整 row 间切；超长单行在行首结构后的 cell body 按同一安全边界切，leading `                                                                                                                                   | ` 留在首片，所有 table prefix、pipe、alignment 和换行由 range/protected token 原样恢复。         | 极端单元格会有更多调用，但仍受既有最小段、二分深度和调用预算限制。 |
| generic outbox enum 未在 editor / translate / use-source 容器上下文强制 discarded 状态矩阵。        | MEDIUM | §4.2、§4.4；§5；§6.2；§10.4、§10.6；§14.2；§17.2 AC-20/50。                                             | 共享 semantic checker 强制 translate/editor 禁止 discarded、use-source import 禁止 pending，以及 timestamp/status 一一对应；editor schema 额外扫描拒绝 discarded。finalize/reconcile/v5/merge 重新验证，只有其他 draft 的 import source-order gate 可将 use-source discarded 视为结算。 | `discarded` 仍不回滚已同步 glossary，符合 first-wins 与作者显式修改优先规则。                    |
| 模型 glossary 只验形状，合法 envelope 可把当前段没有的名称写进全书 glossary。                       | MEDIUM | §4.2；§5；§8.4；§10.6；§14.2；§15.1–§15.2；§17.1–§17.2 AC-19/50。                                       | parser/complete 仅保留 `normalizeGlossarySource` 命中同一当前 translatable source core 的 term；reference、separator、verbatim 和跨 unit 拼接不具资格。无锚定 term 不失败/重试，只以 `unanchoredGlossaryTermCount` 受控计数；promotion/reconcile/v5 再验，手工 glossary 不受限。        | source membership 只能防止无关词污染，不能自动判断一个已出现名称的译法是否贴切，作者仍可覆写。   |
