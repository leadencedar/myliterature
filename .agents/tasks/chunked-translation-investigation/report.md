# 导入长文章分段翻译调查报告

## 摘要结论

当前问题的根因不是输入上下文装不下，而是**导入翻译把每个分章草稿作为一次流式请求，整章译文必须在模型单次输出上限内完成**。项目虽已能识别标准 OpenAI 兼容响应中的 `finish_reason: "length"`，但没有为翻译请求设置或校准输出预算，也没有分段进度、强制结束标记、源段 ID 覆盖或输出长度校验。因此，标准的 `length` 截断会被发现；兼容端点不返回该值、流在没有 `[DONE]` 的情况下干净结束、末帧损坏被忽略，或模型以 `stop` 正常结束却漏译尾部时，仍可能把残缺译文标成 `done`。

推荐采用 **C「自动分段、逐段持久化」+ D 的轻量版「带源单元 ID 的流式 envelope」**：

1. 在 `ImportDraft` 内保存稳定的翻译计划和分段，不新增 IndexedDB 表。
2. 原始整章在部分翻译期间始终留在 `draft.content`；每个已验证成功的段单独写回 `ImportJob`。只有所有有效叶子段成功后，才在一个事务里把译文拼成 `content`、把完整原文放入 `sourceContent`，并把章标成 `done`。
3. 每段输出必须覆盖全部源单元 ID，并以本次请求唯一的结束标记收尾。`finishReason` 只作为一个信号，不再作为唯一完整性依据。
4. `length`、结束标记缺失或明显漏译时，只把失败源段在安全边界二分并重试；已完成段不重译。
5. 分段结果按段更新时必须在事务中读取数据库里的最新任务，再按 `jobId + draftIndex + segmentId + attemptId` 合并。不得把组件内的整份 `drafts` 或整份 `segments` 覆盖回去。
6. 每段成功后先保存译文和该段译名，再幂等地合并作品级译名表；下一段开始前必须完成这次合并。

这项改动**不需要升级 Dexie 数据库版本**：新增内容是 `importJobs` 行内的嵌套字段，不新增表或索引，且当前导入任务在使用前会经过 `ImportJobSchema.safeParse`。但建议把备份格式从 v4 升到 v5，因为全量备份包含进行中的 `importJobs`；旧应用会用 Zod 丢掉不认识的分段字段，却仍可能报告恢复成功，从而静默丢掉已经付费完成的段落进度。

第一期应只解决“导入流程的可靠自动分段翻译”，保持顺序执行，不做并行段翻译、二次语义审校、跨任务自动学习模型上限，也不把完整分段引擎扩到章节编辑器。章节编辑器的 `TranslateSheet` 应同期补上已有的 `finishReason === 'length'` 拒绝逻辑，但完整分段交互可后置。

---

## 一、调查范围与现有约束

项目实际技术栈与命令来自 `package.json`：React 19、TypeScript 7、Vite 8、Dexie 4、Zod 4、Vitest 5；构建命令为 `npm run build`，非交互测试命令为 `npm run test:run`（`package.json:8-14,16-38`）。仓库根目录没有 README、AGENTS.md、CONTRIBUTING.md 或 `.kiro/steering` 文件；本报告据产品文档、既有设计及源码调查。

产品约束如下：

- 外文按章判定，翻译后才选择主线、外传或仅世界观；目的地确定前，草稿与译文都应留在导入任务中，刷新不能丢（`docs/产品文档.md:267-284`）。
- 翻译是导入中唯一的大规模输出成本，必须由用户手动开始（`docs/产品文档.md:307`）。
- 译名是作品级数据，模型产出的译名先到先得，跨章节、跨导入批次复用（`docs/产品文档.md:309-314`）。
- 成本控制比把上下文塞满更重要；稳定前缀要逐字节可复现以命中缓存（`docs/产品文档.md:467-476`）。
- 上一轮设计有意只先做“风险提示 + `finishReason` 检测”，设计评审已明确把自动分段列为更彻底但工作量更大的后续方案（`.agents/tasks/import-destination-sidestory/design-review.md:61-81`）。

本次只做调查并写此报告，没有修改源码、测试或文档，也没有运行构建或测试命令。

---

## 二、当前数据流与截断根因

### 2.1 当前翻译路径

现有外文导入的数据流是：

1. `splitChapters` 识别章节标题；找不到标题或自定义正则无效时，整篇退化成一个草稿。因此，一份没有 `Chapter N` 等标题的 20k+ 字外文材料必然成为一次翻译请求（`src/features/import/splitChapters.ts:78-97`）。
2. `needsTranslationToChinese` 只把 `en` / `mixed` 判为待译；CJK 比例阈值为 0.5，字母少于 12 个时判为 unknown，不自动翻译（`src/domain/language.ts:24-30,53-74`）。
3. 分章确认时，外文草稿写入 `ImportJob.drafts`，状态为 `pending`；此时不写 Chapter（`src/features/import/ImportScreen.tsx:546-621`）。
4. `translateOne` 把**整章 `draft.content`**作为 `sourceText` 发给 `llm.runStream('translate-chapter', ...)`。请求带作品风格、相关译名与上一章译文尾部，但没有拆分（`src/features/import/ImportScreen.tsx:740-778`）。
5. `ChatRequest` 类型和底层客户端已有 `maxTokens` / `max_tokens` 接线（`src/llm/types.ts:19-25`；`src/llm/OpenAiCompatibleClient.ts:178-180`），但 `useLlm.runStream` 不接收也不下发该值，所以导入翻译完全依赖服务商或模型默认输出上限（`src/llm/useLlm.ts:119-137`）。翻译任务已使用“重点任务模型”、关闭思维链、温度 0.7；仅换模型并不能消除协议层问题（`src/llm/taskProfiles.ts:109-125`；`src/llm/useLlm.ts:12-18`）。
6. 返回后只检查 `finishReason === 'length'` 和译文非空。通过后，整章译文、整章原文及 `done` 状态一次写回草稿；随后才合并译名（`src/features/import/ImportScreen.tsx:783-829`）。
7. 主线/外传提交会把 `draft.content` 和 `draft.sourceContent` 原样复制到 Chapter（`src/data/dexie/DexieNovelRepository.ts:1642-1647`）。世界观提交则只用当前 `draft.content` 打包提取段，然后清空 `drafts`（`src/features/import/ImportScreen.tsx:635-645`；`src/data/dexie/DexieNovelRepository.ts:1703-1714`）。

因此，风险与“文章是否被分成自然章节”直接相关，而不只与整份文件大小相关。一份 200k 字、每章 3k 字的稿件比一份没有标题的 20k 字单篇更安全。

### 2.2 目前能检测到的失败

| 情形                                     | 当前行为                                                                                                                                  | 原文与恢复                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 服务商明确返回 `finish_reason: "length"` | `translateOne` 抛错，该章变为 `failed`，不保存半截译文（`ImportScreen.tsx:783-788,874-914`）                                              | 原文仍在 `draft.content`，`sourceContent` 仍为空；现有测试覆盖此行为（`ImportScreen.destination.test.tsx:445-464`） |
| fetch 或读取响应流抛异常                 | `streamChat` 把异常归一为网络错误，翻译循环把当前章标失败并停止（`src/llm/OpenAiCompatibleClient.ts:105-130`；`src/llm/errors.ts:70-81`） | 部分流式文本只在组件 state 中展示，没有写入草稿；原文保留，可重试                                                   |
| 模型返回空译文                           | 非空检查失败并标为失败（`ImportScreen.tsx:789-793`）                                                                                      | 原文保留                                                                                                            |
| 页面卸载                                 | 请求被 AbortController 取消；循环不把该章标失败，状态仍为 `pending`，重开可续跑（`ImportScreen.tsx:273-284,874-878`）                     | 当前测试覆盖卸载与续跑（`ImportScreen.destination.test.tsx:329-377,517-535`）                                       |
| 用户点“暂停”                             | 只设置停止标志，在当前整章请求结束后停止，不中断正在翻译的章（`ImportScreen.tsx:860-873,1268-1275`）                                      | 当前章若成功会整章落盘；下一章不开始                                                                                |

`OpenAiCompatibleClient` 会保留流中最后一个非空 `finish_reason`，因此末尾只有 usage 的帧不会冲掉先前的 `length`（`src/llm/OpenAiCompatibleClient.ts:103-131`）；相关客户端和导入测试已覆盖（`src/llm/OpenAiCompatibleClient.test.ts:247-276`；`ImportScreen.destination.test.tsx:445-464`）。

### 2.3 仍检测不到或检测不可靠的截断

#### 兼容端点不返回 `finish_reason: "length"`

`finishReason` 的公共类型是任意字符串或 null（`src/llm/types.ts:32-39`），业务层只认精确字符串 `length`。自定义 OpenAI 兼容端点可能不返回该字段、用其他值，或中转层丢掉末帧。此时即使正文截断，业务层也会继续解析。

#### SSE 干净 EOF，不代表完整结束

`parseSseStream` 在 reader 返回 `done` 时直接结束，也会处理没有换行的尾部；它不把“看到了 `[DONE]`”这一事实返回给上层（`src/llm/sse.ts:9-47`）。因此，代理或服务端在半截处干净关闭流时，`streamChat` 可以返回已有正文和 `finishReason: null`，业务层会把它视为成功。

#### 损坏的 SSE 帧会被静默忽略

`parseChunk` 对无法解析的 JSON 直接返回 `undefined`，调用方继续处理后续帧（`src/llm/sse.ts:73-81`）。这对心跳噪声很宽容，但若损坏的是尾部内容或结束原因，同样可能形成“部分正文 + null finishReason”的假成功。

#### 当前分隔符不是完成证明

翻译正文后约定输出 `---译名表---`，但 `parseTranslation` 明确把“没有分隔行”视为合法：整段直接作为译文（`src/features/writing/translate.ts:34-37,48-73`），测试也锁定了这一行为（`src/features/writing/translate.test.ts:48-51`）。因此，分隔符不能证明模型翻到了结尾。

即使分隔符存在，也没有源段 ID、句子覆盖、结尾校验或源/译长度比检查。模型可以正常以 `stop` 结束、输出分隔符，却省略最后几个段落或中间一段；当前只要译文非空就会标为 `done`。

#### “看起来完整”但语义漏译

当前提示词要求不增删、保留分段（`src/features/writing/translate.ts:84-103`），但没有机器可验证的对应关系。模型可能概括长段、合并相似段落、漏掉重复句、跳过附录或在长上下文末尾失焦。这类问题不会触发 `finishReason`。

#### 邻接路径：章节编辑器翻译更弱

章节编辑器的 `TranslateSheet` 也使用同一整章流式翻译，但返回后完全不检查 `result.finishReason`，只检查译文非空，然后让用户预览并采用（`src/features/writing/TranslateSheet.tsx:121-147`）。它不属于“导入前翻译”的主路径，且采用前还有人工预览、采用后保留原文，所以风险低于世界观导入，但同样会把明确的 `length` 半截结果展示为成功。

### 2.4 当前用户实际能怎样恢复

- **重试失败章**：点击“重试”，但会再次翻译整章；若根因是固定输出上限，通常会再次失败并再次付费（`ImportScreen.tsx:860-935,1952-1960`）。
- **刷新或关页后继续**：已完成章留在 IndexedDB；重开后回到翻译页，并从最近完成章恢复上一章译文尾部（`ImportScreen.tsx:324-353,849-858`；`ImportScreen.destination.test.tsx:329-377`）。
- **跳过剩余章**：`pending` 与 `failed` 都被改成 `none`，之后按原文导入或提取（`ImportScreen.tsx:940-968`）。测试确认刷新后仍在目的地页，且跳过的失败章按原文写入（`ImportScreen.destination.test.tsx:379-423`）。
- **放弃后重新切分**：错误详情建议“回到分章页把它切小”，但翻译页没有回到分章页的按钮；目的地页也只有“返回翻译”（`ImportScreen.tsx:784-787,2234-2238`）。用户必须放弃任务、重新粘贴并重做分章。确认框明确说明已经译好的草稿译文也会清空（`ImportScreen.tsx:1570-1582`）。

如果截断未被发现而被标成 `done`：

- 主线/外传最终 Chapter 仍有完整 `sourceContent`，用户日后可以人工对照或重译，但系统不会提醒。
- 世界观目的地没有 Chapter，提交时只保留基于 `draft.content` 生成的提取段并清空 drafts。若 `content` 是未检测出的半截译文，完整原文会从该任务中消失，之后提取也只看到半截。这是当前后果最严重的路径。

### 2.5 当前并发保护的有效部分与剩余缺口

现有 `patchImportDrafts` 已比整行覆盖安全：它在 IndexedDB 事务中读取最新 job，按 draft index 合并；任务不存在或已提交时拒绝；`done` 草稿不可降级（`src/data/dexie/DexieNovelRepository.ts:1540-1578`）。测试覆盖“两个调用分别完成不同章，两处都保留”和“done 不可改”（`DexieNovelRepository.test.ts:1117-1197`）。这是新方案必须沿用的原则。

但自动分段不能直接把 `translationSegments` 加进现有 draft patch 后整数组回写，原因有两点：

1. 当前 patch API 只有 `novelId + draft.index`，没有 `expectedJobId`；旧请求若在用户放弃旧任务并创建新任务后才返回，可能命中同一 novel、同一章号的新草稿（`src/data/NovelRepository.ts:289-304`；`DexieNovelRepository.ts:1540-1567`）。
2. 当前 `done` 草稿即使拒绝旧译文覆盖，`translateOne` 仍继续用旧返回更新 `previousTailRef` 并合并旧返回里的译名（`ImportScreen.tsx:795-821`）。现有迟到写回测试甚至确认了旧尝试的 `Fogvale` 译名会进入词表（`ImportScreen.destination.test.tsx:481-515`）。分段重试后，这会让被丢弃的尝试污染后续译名。

推荐的新持久化操作必须同时校验 job、翻译计划、分段和尝试身份，并只在“这次成功结果实际被采用”时进入译名合并流程。

---

## 三、方案比较

| 方案                                  | 正确性                                                                                         | 成本                                                          | 连续性                                                                   | 可恢复性                                         | 实现复杂度                             | 结论                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------- | ----------------------------------------- |
| A. 提高 `max_tokens` / 换大输出模型   | 低到中。能推迟上限，但不能证明完整；端点可能忽略、限制或拒绝参数，模型也可能正常 `stop` 却漏译 | 理想时一次调用最省重复前缀；失败时整章重付。更大模型单价更高  | 最好，整章一次生成                                                       | 仍只有章级；失败重译整章                         | 低。底层已有参数，runner 尚未透传      | 只能作为补充，不能作为可靠修复            |
| B. 用户在分章页手动切小               | 中。切得足够小可规避上限，但用户无法知道模型输出上限                                           | 调用次数增加；失败仍按人工分章重跑                            | 人为拆章会改变章节语义、编号、摘要和后续写作结构；只有上一章译文尾部衔接 | 章级。当前失败后还不能直接回分章页               | 当前改动最少，用户负担最高             | 保留为手动兜底，不应作为主方案            |
| C. 应用自动按章内结构分段、逐段持久化 | 高，前提是加独立完整性协议；单纯切段仍会漏检 null finishReason                                 | 多次请求会重复少量上下文，但只重试失败段，长文总成本更可控    | 通过风格、译名、前后文尾首衔接，可接近整章体验                           | 最好。段级落盘、刷新续跑、失败只重试或再切失败段 | 中到高，涉及模型、事务、UI、兼容与测试 | 推荐主方案                                |
| D. 段落/句子 ID + 结构化 envelope     | 最高的本地可验证性，可发现漏段、错序与缺尾；仍不能数学证明每句语义都完整                       | ID 和 envelope 增加少量输出 token；完整 JSON 修复重试可能较贵 | 粒度过细或强制 JSON 可能损害文气                                         | 与 C 结合时优秀                                  | 轻量流式 frame 为中等；完整 JSON 为高  | 第一期开“轻量 frame + ID”，完整 JSON 延后 |

最终推荐不是裸 C，而是 **C + D-lite**：自动分段负责控制输出规模与恢复粒度，唯一结束标记和源单元 ID 负责把“完整”变成可验证条件。

`max_tokens` 的正确定位是辅助护栏：以后可让 `TextRunOptions` 透传一个按已知模型上限计算的值，但不能硬编码“足够大”的统一数字。当前服务商能力模型只记录 JSON schema、thinking、reasoning effort 和流式 usage，不记录模型输出上限（`src/llm/types.ts:56-76`；`src/llm/settingsStore.ts:7-15`）。

---

## 四、推荐数据模型

### 4.1 `ImportDraft` 的新增嵌套对象

保留现有 `content`、`sourceContent`、`translateStatus` 和 `translateError` 语义，在每个 draft 上新增可空的 `translationPlan`；旧行缺失时默认 null。

| 字段                                            | 含义                                                           |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `version`                                       | 分段计划格式版本，第一期为 1                                   |
| `decision`                                      | `translate` 或 `use-source`。后者表示用户明确选择整章保留原文  |
| `sourceHash`                                    | 创建计划时对完整原文做 SHA-256；防止旧计划或旧请求写到不同正文 |
| `sourceCodeUnitLength` / `sourceCharacterCount` | 前者用于 JS `[start,end)` 切片校验，后者用于 UI                |
| `targetLanguage`                                | 固定 `zh-CN`，避免将来扩展后含义不清                           |
| `adaptiveTargetChars`                           | 当前 job 针对未知模型观察到的安全目标大小；失败二分后只会降低  |
| `initialSegmentCount`                           | 成本预估与进度说明使用                                         |
| `autoExtraCallsUsed`                            | 自动重试/二分的成本保护计数                                    |
| `revision`                                      | 分段树改变时递增；事务 patch 用于拒绝过期计划                  |
| `segments`                                      | 稳定分段数组，包含完成结果、失败和二分历史                     |

`draft.content` 在部分翻译期间始终还是完整原文。只有全部有效叶子段成功并通过完整性校验后，仓储才在一个事务中执行：

- `sourceContent = 原始 draft.content`
- `content = 按 sourceStart 排序拼好的完整译文`
- `translateStatus = done`
- `translateError = ''`

如果用户选择 `use-source`，则保留 `content` 原文、`sourceContent` 为空、`translateStatus = none`。这保持了当前“未翻译章节没有 sourceContent”的语义，也避免把部分中文和部分外文拼成一章。

### 4.2 每个翻译分段

| 字段                                 | 含义与不变量                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `id`                                 | 持久化后永不改变，是事务和重试的主键                                       |
| `index`                              | 当前 UI 顺序；二分后可重排，身份以 id 为准                                 |
| `parentId` / `splitDepth`            | 失败段被二分时保留父子关系；父段状态变为 `split`，不参与最终拼接           |
| `sourceStart` / `sourceEnd`          | 完整原文中的 UTF-16 `[start,end)`；边界只能落在 grapheme 边界              |
| `sourceText` / `sourceHash`          | 该范围的原文快照及 SHA-256；写回前必须同时匹配范围与 hash                  |
| `separatorAfter`                     | 段后应恢复的 Markdown/空行结构；不依赖模型自行补回                         |
| `kind`                               | `translatable` 或 `verbatim`。围栏代码块等 verbatim 段原样通过，不调用模型 |
| `units`                              | 本段内稳定的段落/句子单元，含 `id`、类型、源范围和 hash，用于输出覆盖校验  |
| `status`                             | `pending`、`running`、`done`、`failed`、`split`、`skipped`                 |
| `translatedText`                     | 仅在通过全部校验后写入；失败响应不写入这里                                 |
| `glossaryTerms`                      | 本段成功输出的译名，随译文一起保存                                         |
| `glossaryApplied`                    | 译名是否已合并到作品词表；崩溃后可无模型调用地补做                         |
| `error`                              | 结构化保存 kind、用户文案和诊断详情，不只留一条无法分类的字符串            |
| `attemptCount`                       | 实际发出的模型请求数                                                       |
| `activeAttemptId` / `leaseExpiresAt` | 防止旧请求、旧标签页或同段重复请求完成后覆盖新结果                         |
| `lastFinishReason`                   | 调试与 UI 使用；null 不代表完整                                            |
| `completedAt`                        | 成功时间，便于恢复与诊断                                                   |

### 4.3 必须由 schema/仓储维护的不变量

1. 同一计划的有效叶子段按 `sourceStart` 排序后无重叠、无空洞，能逐字重建完整原文。
2. `split` 父段不参与拼接；其子段范围合起来必须与父段完全相同。
3. `done` 段不可被过期尝试降级或改写；同段并发时第一个合法完成结果获胜。
4. draft 只有在全部有效 translatable 段为 done、verbatim 段已原样就绪、没有 skipped/failed/running 时，才能标记 done。
5. destination commit 必须在仓储层再次检查：每个外文 draft 要么 done，要么显式 `use-source`。不能只靠按钮禁用。
6. 失败输出、缺结束标记输出和疑似漏译输出不得进入 `translatedText`，更不得参与整章拼接。
7. 完成章的 `sourceContent` 必须等于计划 sourceHash 对应的完整原文，而不是各段重新拼出的近似文本。

### 4.4 旧任务、Dexie 与备份兼容

当前 `ImportDraftSchema` 和 `ImportJobSchema` 位于 `src/domain/schema.ts:784-930`；`ImportJobSchema` 已通过 preprocess 兼容旧形状。面板恢复时也明确先 `safeParse` 再决定步骤（`ImportScreen.tsx:321-353`），仓储事务同样通过 schema 读取（`DexieNovelRepository.ts:1475-1496`）。因此建议：

- `translationPlan` 使用 `.nullable().default(null)`；旧 draft 不需要数据库迁移。
- 旧 `done` draft 没有 plan 时视为旧版已完成，不自动重译。
- 旧 `pending` / `failed` draft 没有 plan 时，在用户继续翻译前按当前 `content` 懒生成计划并落盘。
- 旧 `none` draft 保持原样；若用户重新勾选，再生成计划。
- `resumeStepOf` 除章级状态外，还要把 plan 中 unresolved/running/failed 叶子视为翻译未完成；过期 running lease 恢复成 pending。
- 已经在旧版本中被误标 done 的半截译文无法可靠自动识别和修复；main/side 尚可借 `sourceContent` 人工重译，已经提交并完成的 worldview job 没有可恢复原文。该修复是向前生效。

**不升级 Dexie**：当前数据库版本已到 v7（`src/data/dexie/db.ts:172-190`）。既有 v3/v5/v7 升级都是为了新表/索引，或因为实体会被不经 Zod 的读取路径直接访问（`db.ts:88-103,117-146,166-190`）。本方案只给临时 `importJobs` 的嵌套 draft 加默认字段，所有新访问点都应先 parse；新增 `version(8)` 只会增加升级风险，没有收益。

**备份升到 v5**：备份当前为 v4，并明确把“旧应用会静默丢掉未知字段但报告成功”作为升级版本的理由（`src/features/export/backup.ts:21-36`）。`exportSnapshot` 包含 `importJobs`（`DexieNovelRepository.ts:1773-1824`）。若仍标 v4，旧应用恢复一份翻到一半的新备份时会丢掉已完成 segments，退化为整章重译。建议 v5 让旧应用在解析正文前按文件头明确拒绝；新应用继续通过默认值读取 v1–v4。

### 4.5 事务与多标签页

不要扩展现有 `patchImportDrafts` 后传入整份 `translationPlan.segments`。建议增加按语义操作的仓储入口，规则如下：

- 所有操作必须携带 `expectedJobId`、draft index、plan revision/sourceHash；段操作还带 segment id 和 attempt id。
- 事务中重新读取当前 `importJobs` 行，定位当前 draft 与 segment，再合并单段变化。
- job 已提交/删除、jobId 不同、sourceHash 不同、attemptId 不是当前持有者时，拒绝或返回“未采用”，绝不新建任务。
- 两个标签页完成不同段时，两次事务都基于最新行，最终同时保留；完成同一段时只采用一个结果。
- 自动二分是一个原子操作：父段改 `split`、两个子段插入、revision 递增，同成同败。
- 整章 finalize 是一个原子操作：重读所有有效叶子、校验范围和状态、拼接、保留整章原文、标 done。

正常 UI 仍按章内顺序翻译，不主动并行。仓储具备并发合并能力是为了抵御旧实例和多标签页，不是为了鼓励并行；后段提前翻译会拿不到前段刚确定的译名和语气。

---

## 五、可靠切分算法

### 5.1 总体目标

切分函数必须返回原文的连续范围，满足：

- 原文切片按顺序拼回后逐字等于输入；
- 不拆 Unicode grapheme；
- 不拆 Markdown 围栏代码块或标题行；
- 优先在语义和版式边界切；
- 每个分段在输出上限未知时仍能通过失败二分自适应。

现有 `splitWorldviewText` 只认空行，超长单段按 JS `slice(max)` 硬切（`src/features/import/worldview.ts:11-47`）；现有 `splitChapterForCheck` 已改进为优先行、再句号、最后硬切，并保证拼回原文（`src/features/writing/normCheck.ts:189-234`）。翻译切分应吸收后者的不变量，但不能直接复用，因为翻译还要处理 Markdown、grapheme、稳定范围与二分树。

### 5.2 建议算法顺序

1. **扫描原文并保留所有偏移与换行**。不先 trim，不先把多个空行归一化。分段计划针对原始字符串生成。
2. **识别 Markdown 原子块**：
   - 三个及以上反引号或波浪号开启的 fenced code block，一直吃到匹配的闭合围栏；未闭合时把余下全文视为同一代码块。
   - ATX 标题行和 Setext 标题两行保持原子，不在标题内部切。
   - 围栏代码块第一期标为 `verbatim`，原样复制，不让模型翻译代码或拆围栏。若用户将长篇自然语言故意放进代码块，本期也以保格式优先。
   - 列表项、引用行、表格行至少保持行首 Markdown 标记完整。
3. **按空行/Markdown 块边界贪心装箱**。先组合完整段落，直到加入下一块会超过目标预算。
4. **超长普通段落递归切分**：
   - 先在单换行边界切；
   - 再在句界切，包含 `。！？.!?…` 以及其后的引号/括号；
   - 仍过长时在分号、冒号、逗号或邻近空格的安全位置切；
   - 最后才在目标位置附近的 grapheme boundary 切。
5. **绝不直接按 UTF-16 下标硬切**。优先使用 `Intl.Segmenter(..., { granularity: 'grapheme' })` 取得边界；回退实现至少按 code point 迭代，避免拆开代理对，并把组合附加符与前一个字符一起保留。
6. **存储范围与 hash 后再翻译**。运行时不重新按“当前常量”切已有任务；否则刷新前后段 ID 会变化，已完成结果无法复用。
7. **失败二分复用同一边界选择器**：在失败源段中点附近向两侧找最高优先级边界。完成的其他段与父段历史都不动。

病态情况的处理：

- 单个 fenced code block 超过 hard limit：原样通过，不调用模型。
- 单个标题行超过 hard limit：不拆标题，标记为需人工处理，而不是静默硬切。
- 单个没有任何标点或空格的超长字符串：按 grapheme 边界切，并用 unit ID 保证每片都出现。

### 5.3 字符数、token 估算与默认大小

现有 `estimateTokens` 明确只是量级估算：CJK 乘 0.8、其他字符乘 0.25，真实 tokenizer 在服务端（`src/context/tokens.ts:2-24`）。它适合展示成本和做第二道预算，不适合作为唯一切分标准，尤其外文输入与中文输出的长度比例并不等于输入 token 比例。

第一期建议默认：

- 目标源段：**约 3,000 个 Unicode 字符**；
- 硬上限：**4,000 个 Unicode 字符**；
- 同时要求 `estimateTokens(sourceText) <= 1,200`，任一条件先到就切；
- 前后参考上下文不计入源段范围，但总提示仍要显示估算 token；
- 当前 6,000 字常量继续只作为旧提示兼容，自动分段启用后可把提示改为“将自动分为约 N 段”，不再要求用户猜。

这个默认让常见 20k 字单篇约产生 7 次翻译请求，单段中文输出通常远离常见 2k–4k token 上限，同时不会碎到每句一次调用。它不是对任何模型上限的假设，最终可靠性来自结束标记和自适应二分。

### 5.4 未知输出上限的自适应

- `finishReason === length`：不做同尺寸重试，立即二分失败源段。
- 结束标记缺失但 `finishReason === stop/null`：先同尺寸重试一次，提示更严格；仍失败再二分。
- 一次二分后的子段成功时，把该 job 的 `adaptiveTargetChars` 降到成功子段量级，并在发送其余尚未开始的大段前预切，避免每段都先撞一次上限。
- 模型/端点在任务中途变化时不假定旧阈值仍安全；任何新失败仍按相同规则继续缩小。
- `max_tokens` 若将来透传，只按明确的 provider/model 配置计算并作为上限请求；自定义端点默认不硬编码大值。即便设置了，也必须保留全部完整性校验。

---

## 六、跨段连续性与 prompt 组织

### 6.1 每段应携带的上下文

| 上下文           | 来源                                          | 用途                       |
| ---------------- | --------------------------------------------- | -------------------------- |
| 作品信息与文风   | 现有 `buildTranslateSystemPrompt` 的风格部分  | 全章语气一致               |
| 作品级已定译名   | 当前段原文命中的 glossary；每段开始前取最新值 | 人名、地名、组织名一致     |
| 当前章标题及段号 | draft title、有效叶子排序                     | 明确位置，不把段当独立短文 |
| 上一段原文尾部   | 建议 200–300 字符                             | 理解代词、断句和跨段语义   |
| 上一段译文尾部   | 建议 200–300 字符                             | 接住中文称谓、时态与文气   |
| 下一段原文开头   | 可选 120–200 字符                             | 当前段尾句有歧义时提供前瞻 |
| 上一章译文尾部   | 仅当前章第一个段使用                          | 完整沿用现有跨章节行为     |

现有实现只带作品风格、当前章相关译名和上一章译文尾部（`src/features/writing/translate.ts:112-165`）。分段后应在此基础上增加章内前后文，但不要把整章重复塞入每次请求。

### 6.2 防止参考上下文被重复翻译

- 前一段原/译尾和下一段原文头必须放在独立的“仅供衔接，不得输出”块。
- 只有当前段的 source unit 带可输出 ID；参考块没有输出 ID。
- parser 只接受当前请求声明的 ID。模型若把参考段重复输出，会产生未知 ID、重复文本或异常长度，判失败；不得自动把看似重复的句子剪掉，因为原文可能有刻意复沓。
- 系统提示中的翻译规则和 envelope 规则保持每段逐字节相同；具体 nonce、ID、上下文和正文放在 user prompt 尾部，以延续产品的 prompt 缓存原则。

### 6.3 防漏、错序和称谓漂移

- source ranges 保证没有输入空洞；unit ID 覆盖保证没有整段/整句输出空洞；最终按 sourceStart 排序，不按请求完成时间排序。
- 相邻译段做接缝检查：规范化空白后，若当前段开头与上一段结尾出现 40 个以上连续重复字符，标为可疑失败或人工确认，不自动删字。
- 新译名只有在当前段完整性通过后才进入作品级词表；下一段开始前必须看见它。
- 跨章节仍使用 `previousTranslatedTail`。刷新后的恢复逻辑已经会从最近一个 done draft 重建该尾部（`ImportScreen.tsx:849-858`），新实现只需把“当前章第一段”接到这条现有行为上。

---

## 七、完整性验证与失败恢复

### 7.1 轻量流式 envelope

每次请求生成一个不可预测 nonce，并给本段内每个 Markdown 段落或递归切出的句子单元一个稳定 ID。要求模型按如下逻辑顺序输出：

1. 单元开始控制行，包含 nonce 与 unit ID；
2. 该单元译文；
3. 单元结束控制行；
4. 下一个单元；
5. 译名区；
6. 唯一的整段完成控制行。

控制行使用只含 ASCII 的高熵 nonce，必须独占一行。parser 只把完全匹配本次 nonce 的行当控制信息，并在保存前全部剥离。提示词明确说明控制行不是正文、不得翻译、不得解释、不得放进译文。若模型翻译或改写标记，精确标记缺失，结果失败；不会把标记当正文保存。

不推荐第一期把整段译文包进一个 JSON 字符串。当前翻译采用纯文本流正是为了避免几千字 JSON 转义失败和无法自然流式预览（`src/features/writing/translate.ts:13-23`）。轻量 frame 能保留流式体验，同时得到 ID 与终止证明。完整 JSON schema envelope 可在第二期评估。

### 7.2 每段成功的必要条件

所有条件都满足才允许写 `translatedText`：

1. 响应正文非空。
2. `finishReason !== 'length'`。其他 provider 的截断值可记录，但不靠枚举穷举来保证完整。
3. 唯一完成标记存在且只出现一次；标记后只有空白。
4. 所有预期 unit ID 恰好出现一次，顺序与源文一致；不得缺失、重复或出现未知 ID。
5. 每个非空 translatable unit 都有非空译文；verbatim unit 与原文逐字一致。
6. Markdown 围栏、inline code、URL、模板占位符、显式数字编号等受保护 token 没有丢失或损坏。
7. 长度异常检查通过。建议仅对 `estimateTokens(source) >= 200` 的自然语言段启用宽阈值：译文估算 token 少于源文的 30%，判“疑似漏译”；高于 300%，判“疑似重复或扩写”。阈值只做保守报警，不做质量评分。
8. 与上一完成段没有异常长的重复接缝。

ID 覆盖和长度比仍不能证明模型对每个 unit 的每个含义都忠实。若要进一步提高语义保证，需要第二次对齐/回译检查，但成本接近再读一遍全文，第一期不建议默认开启。第一期的原则应是：出现不确定信号就失败并提示，不静默保存。

### 7.3 自动重试和二分策略

| 失败类型                                                      | 自动动作                                                     | 是否保存本次译文   |
| ------------------------------------------------------------- | ------------------------------------------------------------ | ------------------ |
| `finishReason=length`、完成标记缺失且输出明显短、源 unit 缺失 | 立即把**失败源段**按安全中点二分，创建两个子段；不动已完成段 | 否                 |
| 完成标记/ID 仅格式不符，输出长度正常                          | 同尺寸严格提醒重试 1 次；再失败则二分                        | 否                 |
| 网络、429、5xx                                                | 同一段自动重试 1 次，短退避；仍失败则暂停等待用户            | 否                 |
| auth、余额不足、bad request、配置错误                         | 不自动重试，立即暂停并给可操作提示                           | 否                 |
| 用户暂停/卸载导致 abort                                       | 恢复为 pending；下次继续同一段                               | 否                 |
| 存储失败                                                      | 保留内存中的可见结果但不标 done；暂停，提示导出备份/释放空间 | 否，直到持久化成功 |

成本保护建议：

- 每个初始段最多自动二分 2 层；3,000 字最小可降到约 750 字。
- 单个初始段的整棵重试树最多 7 次调用。
- 每章“超出初始预计次数”的自动调用最多 6 次；耗尽后暂停，由用户决定继续、改用原文或换模型。
- 最小自动分段为 500 个 grapheme；再失败不继续无限切碎。
- UI 在动态二分后更新总段数和“已额外调用 N 次”，让成本可见。

关键点是二分**失败源段**，而不是把整个章重新规划。第 1 段已经完成，第 2 段截断时，只把第 2 段变成 2a/2b；第 1 段的译文、译名和完成状态都保持不变。

---

## 八、译名合并时机与幂等性

当前领域规则本身正确：原文名按大小写和首尾空白归一，同一原文名只留第一条；模型后来的冲突译名不能覆盖已经确定的译名，作者手工修改则可以覆盖（`src/domain/glossary.ts:15-53,60-81`）。仓储在 glossaries 事务中执行该规则（`DexieNovelRepository.ts:1725-1770`）。

分段翻译需要调整的是时机和恢复协议：

1. 只有 envelope、ID、长度和受保护 token 全部通过后，才接受该段 `glossaryTerms`。失败或被截断尝试里的译名全部丢弃。
2. **先把译文和 glossaryTerms 写进对应 segment**，确认这次 `attemptId` 实际获胜；这是已付费输出的第一安全落点。
3. 再按源文顺序把所有 `done && !glossaryApplied` 段的词条合并进作品级 glossary。合并成功后将 `glossaryApplied` 标记为 true。
4. 下一段发请求前，必须先完成前面段的 glossary reconcile；失败时暂停并显示“译文已保存，译名表待同步”，不得带着旧词表继续翻。
5. 如果应用在“词表已合并、segment 标记未更新”之间关闭，重开后再合并一次。现有 `mergeGlossary` 的先到先得和去重使这个重放幂等。
6. 同段重复完成或迟到请求若 `attemptId` 不匹配，返回“未采用”；既不改译文，也不合并它的词条。
7. 多标签页完成不同段时，segment patch 先各自合并到最新 job；glossary reconcile 按 sourceStart 顺序串行执行，确保前段先到先得。

这种“译文先落盘、译名作为可重放 outbox”比把两张表强行放进一个首次写事务更安全：词表写失败不会连带丢掉已经付费生成的译文，又能保证下一段开始前词表已同步。

---

## 九、UI 与用户恢复语义

### 9.1 翻译页信息层级

顶部从章级进度扩展为：

- 全批：`已完成 3 / 8 章，1 章失败`；
- 当前章：`第 4 章 · 已完成 5 / 7 段`；
- 当前段：`正在翻译第 6 段`；
- 内容量：`已完成 12,480 / 20,315 个源字符`，英文材料可同时显示现有 `countWords` 的词数；
- 成本：`预计 7 次调用，因自动拆分已增加 2 次`。

每章行显示 `done/total` 和进度条；展开后列出各有效叶子段的状态、范围摘要、attempt 次数及错误。`split` 父段放在诊断详情中，不计入当前总数。

### 9.2 暂停、继续、重试与卸载

- “暂停”建议保持低浪费语义：完成当前小段后停止，并显示“正在停在本段结束处”。因为段只有约 3,000 字，等待明显短于当前整章。
- 关闭面板或组件卸载立即 abort 当前请求；该段不记 done，下次恢复为 pending。
- “继续翻译”从最早的 unresolved 有效叶子段开始；完成段不请求。
- failed 段提供“重试失败段”；若自动预算已耗尽，再提供“再拆小后重试”。
- 存储层 lease 未过期且由另一标签页持有时显示“另一标签页正在处理”，本页跳过该段并重读，不重复烧 token。

### 9.3 跳过语义

不得把已完成的中文段与失败的外文段静默拼成一章。推荐规则：

- 用户在某段点“跳过”时，确认文案说明：**为避免中外文混排，本章将整体按原文导入；已完成段会暂存到提交前，返回翻译仍可继续。**
- 确认后把该 draft 的 decision 设为 `use-source`，所有未完成有效叶子显示 skipped；`content` 仍是完整原文。
- 用户在选择目的地前可以撤销“使用原文”并继续翻译。
- 主线/外传提交：完成章写完整译文并保留完整 `sourceContent`；use-source 章只写完整原文。
- 世界观提交：完成章用完整译文，use-source 章用完整原文；两者都不写 Chapter。

### 9.4 何时允许选择和提交目的地

翻译页可以始终显示下一步，但必须满足以下之一：

- 所有需翻译 draft 已完整 done；或
- 用户通过明确确认，把所有未完成 draft 整章设为 `use-source`。

存在 running、pending、failed 且未明确 use-source 时，不允许直接提交。即使 UI 有缺陷，`commitImportChapters` 与 `commitImportWorldview` 也必须在事务中拒绝 unresolved 任务。

这保留了当前“用户可以跳过”的能力，同时消除了“半章中外文拼接且无提示”。

---

## 十、最小安全改造文件清单

### 必须修改或新增

| 文件                                                                           | 改动职责                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/domain/schema.ts`                                                         | 新增 translation plan、segment、unit、error schema；`ImportDraft` 增加默认 null 的嵌套字段                   |
| `src/domain/importJob.ts`                                                      | 保持旧 job 全函数换算；补充旧 draft 的兼容/懒初始化规则，不做 Dexie 迁移                                     |
| `src/features/writing/chunkedTranslation.ts`（新增）                           | Unicode/Markdown 安全切分、二分、segment prompt、流式 frame 解析、ID/结束标记/长度/保护 token 校验、最终拼接 |
| `src/features/writing/translate.ts`                                            | 抽出可复用的翻译规则并新增分段系统提示构建；现有非分段 prompt 必须逐字节不变                                 |
| `src/data/NovelRepository.ts`                                                  | 声明按 job/draft/segment/attempt 合并的仓储操作及整章 finalize                                               |
| `src/data/dexie/DexieNovelRepository.ts`                                       | 实现最新行事务合并、lease、二分、完成不可覆盖、译名 outbox reconcile、destination 前置校验                   |
| `src/features/import/importFlow.ts`                                            | resume 时识别 plan 内未完成段、过期 running lease 和 use-source                                              |
| `src/features/import/ImportScreen.tsx`                                         | 逐段调度、恢复、进度 UI、暂停/重试/跳过、目的地 gating、每段前刷新词表与上下文                               |
| `src/features/export/backup.ts`                                                | `BACKUP_VERSION` 升为 5；v1–v4 继续由默认值读取                                                              |
| `src/features/writing/TranslateSheet.tsx`                                      | 至少补 `finishReason === 'length'` 拒绝，完整分段 UI 后置                                                    |
| `docs/产品文档.md`、`docs/使用说明.md`、`docs/设计方案.md`、`docs/开发计划.md` | 实现完成后同步行为、成本、恢复和实际测试数                                                                   |

### 必须新增或扩展的测试

- `src/features/writing/chunkedTranslation.test.ts`（新增）
- `src/domain/importJob.test.ts`
- `src/features/import/importFlow.test.ts`
- `src/data/dexie/DexieNovelRepository.test.ts`
- `src/features/import/ImportScreen.test.tsx`
- `src/features/import/ImportScreen.destination.test.tsx`
- `src/features/writing/translate.test.ts`
- `src/features/writing/ChapterEditor.test.tsx`
- `src/features/export/backup.test.ts`

### 第一阶段不应修改

- `src/data/dexie/db.ts`：不新增 version(8)，因为没有新表/索引且新字段通过 schema 默认读取。
- `src/features/import/DestinationPicker.tsx`：目的地种类与编号逻辑不变。
- `src/llm/OpenAiCompatibleClient.ts`、`src/llm/sse.ts`：现有 finishReason 继续提供诊断；应用层唯一结束标记足以覆盖 clean EOF。若未来要全局暴露 `sawDone`，另行设计。
- `src/context/tokens.ts`：直接复用现有估算，明确它不是 tokenizer。

---

## 十一、分阶段实现计划

### 阶段 1：纯函数、数据模型与兼容护栏

- 在 `schema.ts` 增加默认可空的计划/分段模型；旧 job 测试证明缺字段可解析。
- 新增 `chunkedTranslation.ts`，实现原文无损切分、Markdown/Unicode 边界、frame 协议、完整性校验、失败二分和拼接。
- 保持原有 `buildTranslateSystemPrompt` 与 `buildTranslateUserPrompt` 输出逐字节不变，新增分段专用 builder。
- 备份格式升 v5，并覆盖 v1–v4 读取与 v5 对旧应用的版本拒绝语义。

验证：`npm run test:run -- src/features/writing/chunkedTranslation.test.ts src/features/writing/translate.test.ts src/domain/importJob.test.ts src/features/export/backup.test.ts`，随后 `npm run build`。预期所有目标测试和类型检查通过。

### 阶段 2：事务化分段持久化

- 在仓储接口和 Dexie 实现中加入计划初始化、claim、单段完成/失败、原子二分、glossary reconcile、整章 finalize 和 use-source 操作。
- 每个操作都以数据库最新行为基准，校验 jobId/plan revision/sourceHash/attemptId。
- destination commit 加 unresolved 拒绝。

验证：`npm run test:run -- src/data/dexie/DexieNovelRepository.test.ts src/features/import/importFlow.test.ts`，随后 `npm run build`。预期不同段并发合并、迟到尝试拒绝、done 不可覆盖、旧 job 懒初始化全部通过。

### 阶段 3：导入 UI 与调度接线

- `ImportScreen` 从“逐章一次调用”改为“章内顺序逐段”；每段成功立即落盘并同步 glossary。
- 加章/段/字符进度、动态总段数、成本增量、暂停、继续、失败段重试和整章 use-source。
- 恢复时跳过已完成段；卸载不完成在途段；目的地只接收 resolved drafts。
- 世界观、主线、外传沿用现有 commit 分支。

验证：`npm run test:run -- src/features/import`，随后 `npm run build`。预期所有导入流程测试通过。

### 阶段 4：邻接路径、防回归与文档

- `TranslateSheet` 增加明确 length 截断拒绝；不在本期做完整段级持久化。
- 增加无翻译需求的字节级基线测试。
- 更新产品、使用、设计和开发文档。
- 运行全量：`npm run build` 与 `npm run test:run`，两者均应通过。

---

## 十二、测试矩阵

| 场景                               | 层级                       | 必须断言                                                                                             |
| ---------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| 20k+ 字、没有章节标题              | 纯函数 + ImportScreen 集成 | `splitChapters` 仍是一章；自动生成多个稳定段；全部成功后内容按序完整拼接；source hash 和原文逐字一致 |
| 第 2 段返回 `finish_reason=length` | 集成 + 仓储                | 第 1 段保持 done；只二分/重试第 2 段；请求中不再出现第 1 段源文                                      |
| 第 2 段没有唯一结束标记            | parser + 集成              | 即使 finishReason 为 stop/null 也不保存；按规则同尺寸重试一次后只拆第 2 段                           |
| SSE 没有 `[DONE]` 干净 EOF         | LLM/集成                   | 无完成标记时失败，不能因流正常 close 而 done                                                         |
| unit ID 缺失、重复、错序、未知     | 纯函数                     | 全部拒绝；控制标记不进入译文                                                                         |
| 模型把结束标记翻译或写进正文       | 纯函数                     | 精确标记缺失/重复，失败而不是保存带标记正文                                                          |
| 输出为空或长度异常                 | 纯函数                     | 空输出、低于 30% 或高于 300% 的长自然语言段进入失败/人工确认                                         |
| 超长单段递归切分                   | 纯函数                     | 段落→行→句界→grapheme 回退；拼回原文逐字相等                                                         |
| Markdown 与 Unicode                | 纯函数                     | fenced code、ATX/Setext 标题不拆；emoji、代理对、组合字符不拆；代码块原样通过                        |
| 翻到一半刷新                       | ImportScreen               | 已完成段和译名不丢；恢复从首个未完成段开始；不重复调用完成段                                         |
| 暂停与卸载                         | ImportScreen               | 暂停后不开始下一段；卸载 abort 的段仍 pending，不误记 done/failed                                    |
| 两标签页完成不同段                 | 仓储                       | 两段结果都保留，不因过期整数组覆盖；最终顺序按 sourceStart                                           |
| 同段两个迟到尝试                   | 仓储                       | 只有持有 activeAttemptId 的结果获胜；被丢弃尝试的译名不进入 glossary                                 |
| 旧任务删除后新任务同章号           | 仓储                       | 旧 jobId 的完成写回被拒，不能污染新 job                                                              |
| glossary 跨段一致                  | 集成                       | 第 1 段产生的译名在第 2 段 prompt 中；重试不重复制造冲突；用户手工译名优先                           |
| glossary 写入中断                  | 仓储 + 集成                | 译文段已保存；重开只重放 glossary 合并，不重新调用模型；下一段在同步前不启动                         |
| 自动重试成本上限                   | 纯函数 + 集成              | split depth、最小段长、章级额外调用预算到达后暂停，不无限重试                                        |
| 跳过一个失败段                     | UI + 仓储                  | 明确转为整章 use-source；最终没有中外文混拼；提交前可撤销继续                                        |
| 目的地前置校验                     | 仓储                       | unresolved/running/failed draft 直接 commit 被拒；done/use-source 才可提交                           |
| 世界观目的地                       | 集成 + 仓储                | 翻译全程和提取全程 `listChapters` 都为空；提取只读完整译文或完整原文                                 |
| 主线/外传提交                      | 集成 + 仓储                | `Chapter.content` 是完整拼接译文，`sourceContent` 是完整原章，外传的 sideStoryId 正确                |
| 老格式 job                         | schema + ImportScreen      | done 旧 draft 不重译；pending/failed 旧 draft 懒生成计划后续跑；无嵌套字段不白屏                     |
| 老备份                             | backup                     | v1–v4 可恢复并补默认 null；v5 往返保留分段进度；更新版本先报版本过新                                 |
| 没有翻译需求                       | 字节级回归                 | 纯中文导入步骤、调用次数、提取 prompt 与改动前逐字节一致；不会创建 translationPlan 或发翻译请求      |
| 章节编辑器明确 length              | ChapterEditor              | 不进入可采用的 done 预览，正文与 sourceContent 不变                                                  |

重点回归还应保留现有用例：风险提示（`ImportScreen.destination.test.tsx:466-480`）、刷新续跑（`:329-377`）、世界观不写 Chapter（`:951-978`）、作品级 glossary 跨批次，以及 `patchImportDrafts` 的事务合并行为。

---

## 十三、推荐第一期范围

### 第一期包含

- 仅导入流程的自动章内分段。
- 稳定 source range/hash、逐段 IndexedDB 持久化、刷新续跑。
- Markdown/Unicode 安全切分。
- 唯一结束标记 + source unit ID 覆盖 + 非空/长度/保护 token 校验。
- 失败段二分和有限自动重试。
- 顺序翻译与章内上下文。
- glossary 成功段 outbox、幂等合并和下一段前同步。
- 章/段/字符/调用次数进度，暂停、继续、失败段重试、整章使用原文。
- destination 仓储级完整性检查。
- 旧 ImportJob 兼容、备份 v5、无 Dexie 版本升级。
- `TranslateSheet` 的明确 `length` 拒绝。

### 延后

- 多段并行翻译。它会破坏“前段译名供后段使用”和文气连续性，收益主要是速度，不是正确性。
- 完整 JSON schema 翻译 envelope及自动 JSON 修复。
- 第二模型逐句对齐、回译或语义覆盖审校。
- 按 provider/model 长期学习输出上限并跨 job 复用。
- 让用户拖动分段边界或逐段编辑译文。
- 章节编辑器 `TranslateSheet` 的完整分段持久化与恢复。
- 世界观素材在提取任务结束后的永久原文档案；当前产品仍只保留提案，不保存一章 Chapter。

### 建议直接采用的默认，不需要用户决定

- 默认 3,000 Unicode 字符、hard cap 4,000、估算输入 1,200 tokens。
- 顺序翻译，不并行。
- 任一段跳过时整章使用原文，绝不静默中外文混拼。
- 自动二分最多 2 层，章级额外自动调用最多 6 次。
- 不升级 Dexie；备份升 v5。

### 需要产品确认的问题

1. **世界观原文是否要在提取完成、ImportJob 删除后仍能永久查看？** 推荐第一期“不新增永久素材库”，只保证翻译和提取进行期间完整保留；主线/外传继续用 `Chapter.sourceContent` 永久留底。如果要求永久保留世界观原文，需要另建“导入素材”实体及管理/删除 UI，范围明显扩大。
2. **章节编辑器是否也要在第一期获得完整自动分段？** 推荐否；第一期只补明确截断拒绝，把持久化分段聚焦在导入链路。等导入引擎稳定后再复用到编辑器预览。

---

## 最终建议

按“自动分段 + 严格完成协议 + 逐段持久化 + 失败段二分”的组合实施。不要把提高 `max_tokens`、换大模型或要求用户手动切章当成主修复。前两者只能推迟失败，后者把模型限制和恢复成本转嫁给用户，而且当前失败页甚至不能直接返回分章页。

该方案与现有架构兼容：继续把临时翻译状态放在 `ImportJob.drafts`，继续使用作品级 glossary，继续沿用 `patchImportDrafts` 的“事务内读取最新行、按最小单元合并”原则，继续保证世界观目的地不写 Chapter。真正新增的是章内恢复粒度和可验证的完成条件。这样才能同时解决标准 `length` 截断、无 finish reason、干净断流和模型漏尾，而不是只把单次上限从一个不确定数字换成另一个不确定数字。
