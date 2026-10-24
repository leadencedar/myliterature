# 设计审查：导入链路与章节编辑器自动分段翻译

评审对象：

- `/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/chunked-translation-implementation/requirements.md`
- `/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/chunked-translation-implementation/design.md`

抽查依据包括调查报告与用户决策、旧导入设计及其评审、四份产品/使用/设计/开发文档，以及当前导入、编辑器、schema、Dexie、备份、LLM/SSE、译名、分章与对应测试源码。另实际执行了当前基线：`npm run build` 退出 0，仅有既有大 chunk 警告；`npx vitest --run` 为 75 个测试文件、1719 个测试全部通过。

**裁决：CHANGES_REQUESTED**（HIGH 3，MEDIUM 10，NIT 2）。按机械规则，只要存在 HIGH 或 MEDIUM 就不能批准。

## Findings

1. **[HIGH] 备份 merge 对“相同 jobId”直接以备份覆盖，会静默丢失同一任务在本机已经付费完成的进度，还可能把已提交的导入任务倒退回草稿阶段。**

   **位置**：设计 §14.3“相同 jobId……允许备份版本覆盖”；关联 FR-11.6、AC-48、AC-50。

   **问题**：相同 ID 只说明两端源自同一任务，不说明状态相同。用户可先把任务备份到另一设备，然后两端分别继续：本机可能已有额外 `done` segment，备份可能仍是旧的 `pending`；两端也可能对同一 segment 产生不同 winning attempt。直接覆盖会删除其中一份付费结果。对 `ImportJob` 更危险：本机可能已 `destination=main/side` 并创建章节，而旧备份仍是 `destination=null + drafts`；覆盖任务行但不删除本机章节后，任务会倒退并可再次 commit，产生重复章节。当前 `importSnapshot` 的 merge 确实是逐表 `bulkPut`，不会替设计自动解决这一冲突。

   **具体修复**：本期不要尝试复杂的双向段树合并。规定 merge 时，同一 `ChapterTranslationJob.id` 或 `ImportJob.id` 只在整行规范化后深相等时允许；只要不同就于任何写入前整份拒绝，提示“同一翻译任务在两端都有不同进度，请先分别备份并在一端完成/放弃任务”。同时先构造并校验 prospective merged snapshot，覆盖 retained local job 与 incoming Chapter 的跨作品、悬空和 source 不匹配。新增 fake-indexeddb 测试：same-id 本机多一个 done segment、same-id 不同 winning attempt、same-id 导入阶段倒退三种情况均零写入拒绝。

2. **[HIGH] 编辑器只为“正在运行”定义即时 stale，暂停、失败或完整预览阶段仍有 800ms 防抖窗口，旧译文可以越过数据库 source-hash 检查覆盖作者刚输入但尚未落盘的正文。**

   **位置**：设计 §10.5、§12.1–12.3；当前 `ChapterEditorScreen.tsx` 的 `scheduleSave`、`flush` 与 `applyTranslation`；关联 FR-9.1、FR-9.8、AC-35、AC-36。

   **问题**：设计 §12.2 只说“运行中”第一次正文变化立即 abort 并写库。任务关闭面板后仍可能处于 `paused`、`failed` 或 `completed-preview`。此时作者修改正文并在 800ms 内重新打开、继续或点击采用，`checkChapterTranslationJob` 与 apply 事务看到的仍是旧数据库正文，因此 hash 仍匹配。当前 `flush` 还会吞掉错误且不等待已经在途的另一次 flush。结果可能是作者可见的新输入被旧译文覆盖、已完成译文随后又被旧 pending patch 覆盖，或为已经 stale 的源文继续付费。

   **具体修复**：

   - 只要该章存在任一未结束 job（`active/paused/failed/completed-preview/stale`），`onChange` 首次发现 `visibleContent !== plan.sourceText` 就同步设置本地 sticky-stale 标志、禁用 continue/retry/apply，并 abort runner；不能等 IndexedDB 写完才禁用。
   - 把现有 flush 改成串行 barrier，例如 `flushChapter(): Promise<Chapter>`：等待已有保存 promise，保存当前 `pendingRef`，失败时 reject，不再吞错。
   - 所有 create/continue/retry/apply 入口先 `await flushChapter()`，随后重读 job；apply 还必须比较传入的 `expectedVisibleSourceHash` 与 plan，不能只比较事务开始时的 Chapter 行。
   - 增加 fake timer + fake-indexeddb 用例：`completed-preview` 后关面板、输入一字、在 800ms 内采用必须变 stale 且正文保留；paused 后同样操作 continue 必须零 fetch；已有 flush 在途时启动任务必须等待它。

3. **[HIGH] v5 仍复用带默认值的通用 schema，缺失 `chapterTranslationJobs` 或缺失 draft 的 `translationPlan` 会被当作合法 v5 并补成空/null，损坏备份会“恢复成功”但付费进度消失。**

   **位置**：设计 §4.3 的 `translationPlan: ...default(null)`、§14.1 的 `chapterTranslationJobs: ...default([])`、§14.2；关联 FR-11.3～FR-11.5、AC-48～AC-50。

   **问题**：这些默认值对 v7 数据库旧行和 v1–v4 备份是正确的，但 v5 文件必须显式携带新增槽位。设计没有版本感知的正文 schema。按所写方案，一个手工损坏、截断或由错误导出器产生的 v5 文件只要漏掉上述 key，就会被解析为“没有任务/没有计划”，随后 replace 可清空本机真实进度。这正是备份升版本要避免的静默丢失。

   **具体修复**：保留数据库实体 schema 的默认值，但给备份增加版本专用入口：v1–v4 走 legacy schema 并补默认；`version === 5` 走 required-key schema，要求 `data.chapterTranslationJobs` 属性存在（可为空数组），并要求每个 v5 `ImportDraft` 显式存在 `translationPlan` 属性（值可为 null）。可以用 discriminated union，也可以在应用默认值前对 raw object 做 `hasOwn` 预检。测试必须证明 v4 缺字段可恢复，而 v5 分别删掉两个 key 时在任何写入前整份拒绝。

4. **[MEDIUM] 设计没有把全量备份导出改为同一只读事务，新增的跨表不变量会让导出文件成为不同时间点的拼接，可能无效或漏掉刚采用的译文。**

   **位置**：设计 §14、§16.1–16.2；当前 `DexieNovelRepository.exportSnapshot`。

   **问题**：当前源码用事务外的 `Promise.all(table.toArray())` 逐表读取。编辑器 apply 会在同一写事务里改 Chapter 并删 job；outbox reconcile 会同时改 job 与 glossary。导出若在这些事务中间分别读表，可能得到“新 Chapter + 旧 job”“旧 Chapter + job 已删”或 glossary/outbox 两边不一致。前者会在恢复时被 v5 校验拒绝，后者可能形成可解析但少了刚采用译文或待对账状态的文件。设计只写了导入原子性，没有锁定导出快照的一致性。

   **具体修复**：`exportSnapshot` 必须在一个 Dexie `transaction('r', allSnapshotTables, ...)` 中读取全部表，并在序列化前用 v5 严格 schema 再 parse 一次；校验失败不得下载文件。新增两个数据库实例的集成测试，让 export 与 editor apply、outbox reconcile 交错，断言导出结果只能是完整操作前或完整操作后状态，且可立即 `parseBackup` 与 replace restore。

5. **[MEDIUM] stale/use-source 的失效动作没有给出自洽的 segment、attempt、lease 和 run-batch 终态，按当前 schema 会留下 `running` segment 却没有当前 attempt/lease。**

   **位置**：设计 §6.2、§10.5、§11.2；关联 FR-7A、AC-36、AC-43、AC-44。

   **问题**：`TranslationAttemptSchema.lease` 是必填，FR-7A 又要求 `running` segment 必须有当前 running attempt 和 lease。§10.5 却只写“running attempts 标 superseded、清 active lease、plan paused”，没有把对应 segment 从 `running` 迁出，也没有结束 active run batch；“清 lease”本身还与必填 schema 冲突。use-source 只写“失效当前 attempt”，同样未定义剩余字段。这样的行无法通过设计自己承诺的 plan/备份 invariant，恢复逻辑也无法判断它是 pending 还是损坏。

   **具体修复**：把失效定义成一个原子转换并复用：历史 attempt 保留 lease 值，写 `status='superseded'`、`finishedAt=now`；segment 写 `status='pending'`、`activeAttemptId=null`；active batch 写 `status='aborted'`、`endedAt=now`，plan 清 `activeRunBatchId/pauseRequested` 并转 paused。stale 再把 job 转 sticky stale；use-source 再切 decision。对该转换做 schema、仓储及备份往返测试。

6. **[MEDIUM] use-source 对 pending outbox 的规则与全局有序对账互相矛盾，会造成后续章节永久无法 claim，撤销 use-source 后也拿不到已完成段的译名。**

   **位置**：设计 §9.1、§10.4、§11.2；关联 FR-6.2～FR-6.4、FR-8.6、AC-20、AC-25。

   **问题**：§10.4 要求导入按 draft/index/sourceStart 扫描，所有更早 outbox applied 后才处理后段；§9.1 又只维护 `decision !== 'use-source'` 的任务；§11.2 明说 use-source 后 pending outbox 不再对账。若段完成落盘后恰在 reconcile 前崩溃，再把该章设为 use-source，这个 pending outbox 既不会 applied，也没有其他终态。后续 draft 的 claim 会被它挡住；如果作者撤销 use-source，后段 prompt 也缺少该成功段的译名。

   **具体修复**：给 outbox 增加明确终态 `discarded`。`translate → use-source` 的同一事务把该 plan 的 pending outbox 转 discarded；全局顺序把 applied/discarded 都视为已结算。`use-source → translate` 时把这些 discarded outbox 原子恢复为 pending，并要求先按源序 reconcile，完成前不 claim。已 applied 的条目仍不回滚。增加“complete 后、reconcile 前切 use-source”“后续 draft 继续”“撤销后先恢复词表且不重调模型”三组测试。

7. **[MEDIUM] 设计承诺“后段先完成也能保存”，但成功校验依赖前一段接缝，数据模型没有表示“已付费返回、只等前段才能验 seam”的状态。**

   **位置**：设计 §8.4、§10.3–10.4、§17 的 AC-42 映射；关联 FR-4.5、FR-4.10、FR-6.3、FR-7.4、AC-42。

   **问题**：正常 scheduler 虽然顺序 claim，但需求明确要求仓储能保留两个标签完成不同 segment 的结果，并允许后段先完成后暂存。后段返回时，如果它的直接前驱尚未 done，仓储无法执行 40-grapheme seam 校验。当前 schema 只有正式 `unitResults/translatedText/outbox` 和 `done/failed/running`：立即写 done 等于漏做成功条件；拒绝或丢弃则损失已付费输出；等 finalize 再发现 seam 问题又无法降级不可变的 done 段。

   **具体修复**：增加非正式候选状态，例如 `awaiting-predecessor`，以及独立的 `candidateUnitResults/candidateGlossary/winningAttemptId`；此状态不得写正式 `translatedText` 或 outbox。前驱 done 后由仓储按源序执行 `promoteReadyCandidates`，通过 seam 才原子转 done + pending outbox，失败则转 failed 并保留候选供查看。反向完成顺序的 fake-indexeddb 测试必须断言两份付费响应都不丢、后段不提前成为 done、词表顺序正确。

8. **[MEDIUM] fenced code 虽被建成 verbatim segment，却仍会被“上一/下一有效叶”选进 reference，和“任何模型请求都不含代码块源文”的验收条件冲突。**

   **位置**：设计 §7.2、§8.2；关联 FR-2.5、AC-03。

   **问题**：§8.2 从上一有效叶取 source/target tail、从下一有效叶取 source head，没有排除 `kind='verbatim'`。fenced code 本身就是有效叶，因此位于自然语言段旁边时会作为 reference 被送给模型。§17 虽声称 AC-03 会断言请求体不含 fence，但算法按现文实现会让该测试失败。

   **具体修复**：reference 选择器明确规定任何范围只要与 verbatim segment 相交就不得进入 system/user prompt。若直接相邻叶是 verbatim，则该方向 reference 整块省略，不跨代码块寻找更远文本。增加代码块位于章首、章中、章尾以及未闭合到 EOF 的请求体测试，检查围栏和内部唯一字符串均不存在于所有模型请求。

9. **[MEDIUM] 对不足 40 grapheme 的 reference 做“完整非空子串”匹配会把常见短词、代词或人名当作重复上下文，使合法段永远失败。**

   **位置**：设计 §8.2 第 466 行附近；关联 FR-3.2、FR-3.6、AC-12。

   **问题**：上一章或相邻段很短时，reference 可能只是“他”“阿什福德”或一句十来字的短句。设计规定只要 unit 输出命中这个完整短 reference 就报 `reference-repeat`。当前段正常再次出现同一代词/人名是高频情况，严格重试和二分都不会改变它，最终只能错误暂停。需求要求使用短邻接内容的全部文本，不等于禁止译文出现其中任意短子串。

   **具体修复**：reference-repeat 只对规范化后至少 40 grapheme 的 reference 启用，并只匹配连续 40-grapheme 窗口；短于 40 的 reference 仍可提供上下文，但不做纯子串否决，重复 frame 由未知 ID/envelope 校验处理。补 39/40 边界及短人名在当前正文合法复现的测试。

10. **[MEDIUM] 协议标记清理被描述成“控制行/行首”检查，没有明确拒绝出现在 unit 正文中间的 marker，无法证明协议内容绝不进入译文和最终 Chapter。**

    **位置**：设计 §8.1、§8.4 第 10 步、§14.1、§15.1；关联 FR-4.4、AC-04、AC-06、AC-33。

    **问题**：parser 只在完整独占行上识别控制行，preview 校验又写成“不得含任何以 `<<<MLT1|` 开头的协议行”。模型若在一行正文中间输出 `……<<<MLT1|nonce|...>>>……`，它不是独占控制行，外层 envelope 仍可能完整，现文没有确定的 substring 失败规则。各节分别写“控制行”“协议行”“没有任何 `<<<MLT1|`”，实现者可作出不同解释。

    **具体修复**：定义并唯一复用 `containsTranslationProtocolSyntax(text)`，对每个 model-derived unit result、segment text、finalText 与 apply preview 做非行锚定扫描；任何 `<<<MLT1|` 协议语法出现在正文位置都返回 `envelope` 失败。测试覆盖行首、行中、被额外文字包围和跨 stream chunk 四种 marker 泄漏。若要允许源代码本身含该字面量，必须按 source-origin verbatim range 单独豁免，不能靠全局行首规则。

11. **[MEDIUM] “实际调用次数”在 claim 时就增加，而模型请求在读取 glossary、构建 prompt 之后才发生；同时达到 extra/tree 上限后的全局停止时点没有锁定。**

    **位置**：设计 §3.2、§9.3；关联 FR-5.7～FR-5.8、FR-10.1～FR-10.2、AC-16。

    **问题**：claim 后，`getGlossary`、上下文读取、prompt 构建或配置检查都可能失败，此时没有调用模型，却已经产生 attempt 并增加 `totalCallCount/treeCalls/extraCallsUsed`，UI 的“累计实际调用”不真实，甚至可在零费用情况下耗尽预算。另一个歧义是：第 6 次 extra 已发完后，下一次若是另一 root 的 base，现有“仅本次为 extra 才检查 extraCallsUsed < 6”仍会放行；这与“达到任一上限即停止自动请求”不一致。

    **具体修复**：把 claim（取得 lease）与 dispatch 分开。attempt 增加 `dispatchedAt: null | timestamp`；在所有本地准备完成后调用条件式 `beginTranslationDispatch(identity)`，同一事务再次验 lease/预算、设置 dispatchedAt 并增加实际计数，随后立即调用 LLM。未 dispatch 的 claim 在本地失败时可 abort 且不计实际调用。任一调用落地后使 `treeCalls===7` 或 `extraCallsUsed===6`，当前段 settle 后必须把 batch 标 exhausted 并禁止任何下一次模型请求；零成本 reconcile/finalize 仍可做。测试覆盖 claim 后 glossary 读取失败不计数、第 6 个 extra 后即使下一 root 未开始也零 fetch、人工新 batch 累计总数不清零。

12. **[MEDIUM] §10.2 只列方法名和口头返回值，没有定义 runner 实现安全性所依赖的仓储签名与结果 union，多个关键身份字段也未出现在 API 中。**

    **位置**：设计 §10.1–10.2。

    **问题**：`createChapterTranslationJob` 的 created/existing/source-changed、authorize/claim 的 busy/exhausted/complete、complete 的 validation-failed、initialize 的逐章结果、apply 的返回 Chapter 都没有结构定义。§9.4 说旧 runner 的 `batchId` 条件写会失败，但 `claimNextTranslationAttempt`、`completeTranslationAttempt` 列出的参数没有 `expectedRunBatchId`。`patchImportExtractionJob` 也没有说明它是按 chapter/chunk 合并，还是仍允许传整份数组。实现者必须自行决定哪些冲突 throw、哪些返回 not-applied，以及 UI 如何拿到最新状态，这些选择直接影响迟到覆盖和重试成本。

    **具体修复**：在设计正文给出可编译的完整接口。至少定义 `CreateJobResult`、`AuthorizeResult`、`ClaimResult`、`CompleteResult`、`FinalizeResult`、`ReconcileResult`，每个分支的 payload；所有 run-scoped 写入带 `expectedRunBatchId`，segment 写再带完整 identity；`patchImportExtractionJob` 只接受单个 chapterId/chunkIndex 的语义 patch并在最新行合并。示例最低形状：

    ```ts
    type ClaimResult =
      | { kind: 'claimed'; runBatchId: string; attempt: ClaimedAttempt }
      | { kind: 'busy'; expiresAt: number }
      | { kind: 'complete' }
      | { kind: 'budget-exhausted'; limit: 'tree-calls' | 'chapter-extra-calls' }
      | ConditionalNotApplied;
    ```

    这些 union 必须被 runner 的穷尽 `switch` 和仓储测试锁定。

13. **[MEDIUM] AC-52 与 AC-54 被留成“人工检查/发布前清单”，违反 requirements 对 AC-01～AC-54“每项断言必须自动化”的明确要求。**

    **位置**：设计 §17.2 的 AC-52、AC-54；关联 requirements Acceptance Criteria 前言。

    **问题**：AC-52 写成“文档测试/人工检查”，AC-54 只写“发布前按数据证据清单检查”，没有测试文件、断言或机器产物。文档中目前确有多处过时表述，例如 `docs/设计方案.md` 仍写“最大输出 384K，整章无需分段”，`docs/使用说明.md` 与 `docs/产品文档.md` 仍描述 6000 字提示和手工重切，说明仅靠人工很容易漏改。

    **具体修复**：新增自动化文档契约测试，逐一读取四份指定文档，断言导入/编辑器自动分段、envelope、段级恢复、成本上限、原文、stale/放弃、备份 v5 均出现，并对已知过时句子做负断言。AC-54 不另设人工门：建立 `AC-54 → AC-04/14/21/32/42/44/48/50/51` 的机器可追踪映射，并增加一个测试校验每个证据 ID 都对应实际测试名；最终开发计划中的文件数/测试数仍由最后一次命令结果填写。

14. **[NIT] §4.1 声称“以下常量都持久化进 policy”，但展示的 `TranslationPolicyV1Schema` 没有 lease、续租、poll 和退避常量。**

    **位置**：设计 §4.1–4.2。

    **问题**：文字会让实现者不确定恢复旧计划时应读取持久化值还是当前运行时常量，且 §15.1 又把 `expiresAt === renewedAt + 120000` 写成 schema 不变量。

    **具体修复**：锁定一种规则。建议改成“只有 `TranslationPolicyV1Schema` 列出的切分/验证/成本值持久化；lease、poll、退避是 `TRANSLATION_PLAN_VERSION=1` 的运行时协议常量”，并为 V1 恢复测试断言固定值。若希望未来任务继续沿用原 lease 参数，则把这些值真的加入 policy，不能只写在表格里。

15. **[NIT] 上一章目标语言尾部的筛选用 `sourceContent 非空 OR content 为中文`，可能把后来被作者改回外文的正文当作“上一章译文尾”。**

    **位置**：设计 §8.2 第 3 点。

    **问题**：`sourceContent` 只证明这章历史上翻译过，不证明当前 `content` 仍是目标语言。当前 Chapter 允许作者任意编辑正文，因此 OR 条件可能注入外文或混排内容，与 FR-3.3 的“上一章译文尾”不一致。

    **具体修复**：按当前正文判断：`content.trim() !== '' && !needsTranslationToChinese(content)`；`sourceContent` 只用于显示“译过”与原文留底，不单独取得注入资格。补一条“有 sourceContent、当前 content 已改回英文时省略”的测试。

## Verified Assumptions

- `package.json` 的实际栈为 React 19.3.0、TypeScript 7.0.2、Vite 8.3.0、Dexie 4.4.6、Zod 4.6.5、Vitest 5.0.1、Tailwind 4.3.3、Zustand 5.0.15；没有 Markdown parser 或 tokenizer 依赖。
- `src/data/dexie/db.ts` 当前最高版本确为 v7；`importJobs` 使用 `&novelId`；新增独立 `chapterTranslationJobs: 'id, novelId, &chapterId'` 并升到 v8，与当前迁移惯例相容。独立表在同章互斥、不同章并存、与 ImportJob 隔离、stale、lease、级联删除和备份上优于嵌入 Chapter 或复用 ImportJob，方案选择本身成立。
- `src/features/export/backup.ts` 当前备份版本确为 v4，并且先检查 header/version 再解析正文；v5 是本任务需要的准确下一版本。
- `ImportDraftSchema` 当前没有 translation plan；`RepositorySnapshot` 已包含 `importJobs`；`Chapter` 有 `content/sourceContent/sourceLanguage/wordCount`，没有持久化编辑器翻译任务。
- 当前 `ImportScreen.translateOne` 确实按整章请求，只拒绝 `finishReason === 'length'` 与空译文；译文通过 `patchImportDrafts` 落盘后才合并作品 glossary。世界观 commit 当前会清空 drafts。
- 当前 `TranslateSheet` 的状态与预览只在 React state；它不检查 `finishReason`，译名只在最终采用时合并。当前 `ChapterEditorScreen` 使用 800ms 防抖，`flush` 捕获并吞掉保存异常，采用译文走普通 `updateChapter`。
- `useLlm.runStream` 当前不接受 `maxTokens`，而 `ChatRequest` 与 `OpenAiCompatibleClient` 已支持 `max_tokens`；设计不依靠调大输出上限是正确的。
- `parseSseStream` 不报告是否看见 `[DONE]`，正常 EOF 会结束；`parseChunk` 对坏 JSON 返回 undefined。业务 envelope 而非 SSE 终止信号作为成功依据是正确方向。
- 当前 `mergeGlossary` 按原文名忽略大小写和首尾空白、已有值优先；`setGlossaryEntry` 能让作者显式修改覆盖现值。
- 调查报告原本建议编辑器分段后置，但 `decisions.md` 明确覆盖该建议；本设计同时覆盖导入和编辑器，范围判断正确。
- 旧导入设计的三目的地、主线/外传编号、世界观零 Chapter、按章 patch、防迟到写回与旧任务兼容模式均已在现有源码和测试中存在，可作为本设计的基础。
- 本设计没有为原作脉络、Facet、OC 母版或互动推演新增表、字段、索引、prompt 或行为，未发现这四类范围扩张。
- 本次复跑基线结果：`npm run build` 退出 0；`npx vitest --run` 为 75/75 文件、1719/1719 测试通过。

## Unverified/Wrong Assumptions

- **错误**：相同 jobId 的本地与备份行可安全由备份覆盖。相同 ID 的任务可以在两端独立前进，见 finding 1。
- **错误**：v5 与 v1–v4 共用 `.default(null/[])` 不会丢付费进度。版本 5 缺 key 会被静默补默认，见 finding 3。
- **未落实**：设计依赖一致的跨表备份快照，但当前 `exportSnapshot` 没有事务，设计也未要求修改，见 finding 4。
- **错误/不完整**：只处理“运行中”的首次编辑即可覆盖 sticky stale；暂停、失败、完整预览和在途 flush 仍有窗口，见 finding 2。
- **错误**：把 running attempt supersede 后“清 lease + plan paused”已经构成合法恢复状态；segment 与 batch 仍缺终态，见 finding 5。
- **错误**：use-source 的 pending outbox 可以不再处理且不影响后续顺序，见 finding 6。
- **未证明**：后段先完成时既能保住付费输出又能在成为 done 前完成 seam 校验；当前模型没有对应状态，见 finding 7。
- **错误**：verbatim fence 不作为当前待翻译单元就等于不会进模型；邻接 reference 仍会带入，见 finding 8。
- **错误**：任意长度的短 reference 做完整子串否决是安全的；常见短人名/代词会误报，见 finding 9。
- **未锁定**：协议 marker 的拒绝究竟按独占行、行首还是任意位置；现文无法支撑“正文中绝无协议标记”，见 finding 10。
- **错误/不完整**：claim 次数等同实际模型调用次数，且当前 `< 7`/“本次为 extra 才检查”的规则足以定义所有成本边界，见 finding 11。
- **未定义**：新增仓储方法的完整输入/返回 union、expected run batch 身份和 extraction 最小 patch 形状，见 finding 12。
- **错误**：AC-52/54 可留给人工检查；requirements 明确要求 AC-01～AC-54 每项自动化，见 finding 13。
- 新增 SHA-256、Markdown/grapheme scanner、translation plan/protocol、runner 与 ChapterTranslationJob 源码目前都尚不存在，因此其性能和实现正确性不能从现有源码验证；设计给出的标准向量、Unicode、fake-indexeddb 与延迟响应测试是必要条件，但须先解决上述接口与状态机缺口后才可执行。
