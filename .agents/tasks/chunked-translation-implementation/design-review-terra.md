# Terra 独立设计审查：导入与章节编辑器自动分段翻译

审查对象包括当前 `requirements.md`、`design.md`、设计回应、历史审查、调查与决策、旧导入目的地/外传设计资料，以及 `docs/产品文档.md`（重点核对产品原则、6.5、9）。我还核对了当前 schema、Dexie、仓储、导入、章节编辑器、LLM/SSE、备份和 glossary 源码。

**裁决：CHANGES_REQUESTED。** 存在 MEDIUM finding；按机械规则不得批准。

## Findings

1. **[MEDIUM] glossary outbox 的“源文顺序”门只描述了已有 outbox，未阻止一个较晚完成段在较早段尚未产生 outbox 时抢占 first-wins 译名。**

   **位置：** `design.md` §6.2、§9.1、§10.6；关联 FR-6.2～FR-6.4、FR-7.5、AC-19、AC-20、AC-42。

   **问题：** §10.6 要求较早 import draft 的 outbox 已 `applied`，但没有定义“较早段/较早 draft 仍是 pending、running、failed 或 awaiting，因而根本还没有 outbox”时的仓储级拒绝条件。正常 runner 会按顺序 claim，不能代替 `reconcileTranslationOutbox` 的事务防线。一个恢复中的旧实例或双实例可以让第 2 段先合法落为 `done + pending outbox`，而第 1 段仍为 pending、尚无 outbox；若 reconcile 只枚举已有 outbox，空集合会通过，第 2 段的 `Ashford → B` 会先写入 glossary。第 1 段随后产生的 `Ashford → A` 因现有 `mergeGlossary` first-wins 规则无法生效。跨 import draft 也有同一漏洞。这样与设计承诺的“后段结果可保存，但不得抢先取得先到先得优先级”相冲突。

   **具体修复：** 在仓储中定义并唯一复用完整的顺序谓词，不能只扫描 outbox。例如：

   ```ts
   function earlierSourcesSettled(scope: TranslationScope, target: Segment): boolean {
     // editor：每个更早有效叶必须是 verbatim done，或 translatable done 且 outbox.applied。
     // import：先满足上述同 draft 规则；每个更早 draft 必须是 translate+done+全部 outbox.applied，
     // 或整个 plan 已明确 use-source（其 pending outbox 已 discarded）。
     // pending/running/failed/awaiting，以及 done 但 pending outbox，全部返回 false。
   }
   ```

   `reconcileTranslationOutbox` 必须在同一事务重读该谓词，不满足时返回明确的 `{ kind: 'blocked', reason: 'earlier-source-unsettled' }`，不写 glossary；claim 和 UI 可以继续使用同一谓词作提示，但不能成为唯一防线。新增 fake-indexeddb 用例：较早 leaf 没有 outbox、较晚 leaf 已 `done + pending outbox` 时 direct reconcile 必须零 glossary 写入；较早 leaf 对账后才允许较晚 leaf 对账。对两个 import drafts 做同样断言。

2. **[MEDIUM] 导入提取收尾没有规定“materialize 最终提案 + 删除 ImportJob”的原子或幂等边界，崩溃会重复创建提案。**

   **位置：** `design.md` §10.7、§11.4、§15.2、§16；关联世界观原文保留、事务边界和 AC-28、AC-51。

   **问题：** 设计把每个 extraction result 的最小 patch 写清了，也要求 `deleteImportJob` 带 `expectedJobId`，但没有定义最终把 `entryDrafts` 转为 Proposal、可选 style/progress Proposal、再删除任务的单一仓储操作。当前实现正是两个独立动作：`ImportScreen.finalize/finalizeWorldview` 先 `createProposals(proposals)`，随后 `deleteImportJob()`；`createProposals` 是 `bulkAdd`，而 `buildEntryProposal`/`buildReplaceProposal` 每次都会用 `newId()`。若前一步成功后页面崩溃、删除失败或另一个实例抢先改变任务，恢复时同一 `entryDrafts` 会再次生成一组不同 ID 的 Proposal。用户会在收件箱看到重复的 create/merge/replace 提案，可能重复采用；对于世界观路径，这也破坏“提案 materialize 完成后才删除可恢复原文”的事务叙述。

   **具体修复：** 增加一个专用、条件式的仓储 finalizer，而不是让组件编排两次写入。其事务至少覆盖 `importJobs` 与 `proposals`，并按目的地加入需要校验的表：

   ```ts
   finalizeImportExtraction(
     novelId: string,
     input: {
       expectedJobId: string;
       expectedFinalizationFingerprint: string;
       proposals: Proposal[]; // 使用已持久化/确定性的 proposal IDs
     },
   ): Promise<{ kind: 'finalized' } | ConditionalNotApplied>;
   ```

   事务内重读任务，确认所有 extraction item 已完成且 fingerprint 仍匹配，然后 `bulkAdd` Proposal 并删除任务，同成同败。另一种可接受方案是先把确定的 proposal IDs 和一个 finalization state 原子写进 ImportJob，使重试只重放同一组 ID；不能在每次恢复时重新 `newId()`。为主线、外传和世界观分别测试：在 proposal 写入与任务删除之间注入事务失败或并发 finalizer，恢复后要么两者都未发生、要么只存在一套提案且任务已删除；世界观全程仍为零 Chapter。

3. **[MEDIUM] 对无法 parse 的旧/损坏 ImportJob 没有安全的用户恢复路径，严格“不覆盖 raw 行”会把该作品永久卡在不能再次导入的状态。**

   **位置：** `design.md` §10.1～§10.2 的 `SaveImportDraftsResult`/`DiscardImportDraftJobResult`、§10.7、§11.1、§15.2；对照当前 `src/features/import/ImportScreen.tsx` 和 `src/features/import/importFlow.ts` 的 parse-failure 清理路径。

   **问题：** 新设计正确地规定 `saveImportDrafts` 遇到任意 raw ImportJob 都返回 `import-job-invalid`，不得覆盖。可是 `discardImportDraftJob` 又要求完整 **parsed** ImportJob 的 canonical fingerprint，解析失败时同样返回 `import-job-invalid`；`deleteImportJob` 则明确拒绝 `destination === null` 的草稿阶段。于是一个 v7 残留坏行、迁移后无法 parse 的行或被浏览器留下的部分损坏草稿行既不能继续、不能被确认放弃，也不能创建新导入。当前实现和旧导入设计至少能把不可恢复行清掉并保留既有 Chapter；新设计取消该路径，却没有替代操作。失败关闭不能变成没有出口的永久阻塞。

   **具体修复：** 保持 `saveImportDrafts` 的“绝不覆盖已有 raw 行”规则，另提供只用于显式恢复 UI 的条件删除 API。例如：

   ```ts
   discardInvalidImportJob(
     novelId: string,
     input: { expectedRawFingerprint: string },
   ): Promise<{ kind: 'discarded' } | ConditionalNotApplied>;
   ```

   API 在同一事务中按 `novelId` 读取 raw row，确认 `ImportJobSchema.safeParse(raw)` 仍失败、对未经 default 的 raw 值计算的 canonical fingerprint 仍匹配，才删除。若它已变成可解析任务或任一字段变化，必须零写入并要求重新读取/确认。UI 对坏行显示“此导入任务无法恢复”的二次确认；不自动删除，也不允许该 API 删除合法且可能有已付费进度的任务。增加测试：直接写入无法 parse 的 draft-phase row 后，普通创建返回 `import-job-invalid`；取消确认不写；确认且 fingerprint 匹配后可创建新任务；确认期间 raw 行变动或变为合法行时不删。

4. **[MEDIUM] 暂停操作的 lease 契约自相矛盾：状态机要求 pause 校验完整 identity/owner/lease，公开 API 却没有任何 owner 或 lease 参数。**

   **位置：** `design.md` §9.3、§9.4、§10.2 的 `requestTranslationPause`；关联 FR-7.6～FR-7.8、FR-10.4、AC-17、AC-39、AC-44。

   **问题：** §9.4 明确把 pause 列入“必须校验完整 identity、未过期 lease 与 batch owner”的操作。但 API 只有：

   ```ts
   requestTranslationPause(scope, {
     expectedRunBatchId,
     expectedExecutionEpoch,
   });
   ```

   它不能验证 caller 是否是 `TranslationRunBatch.ownerId`，更不可能验证当前 lease token。持有已读到 batch ID 和 epoch 的旧页面/另一标签页可以将另一 runner 的 pre-dispatch attempt 设为 aborted，或给其 in-flight attempt 写 `pauseRequested`。实现者只能违背 §9.4，或自行发明“暂停是任何标签页都能中止”的产品语义；两种行为的并发保证和 UI 都不同。

   **具体修复：** 锁定一种模型。推荐把 pause 作为 batch-owner capability，补齐 API 并在事务内比对 active batch 与所有受影响 attempt 的 owner：

   ```ts
   requestTranslationPause(
     scope: TranslationScope,
     input: {
       expectedRunBatchId: string;
       expectedExecutionEpoch: number;
       ownerId: string;
     },
   ): Promise<PauseResult>;
   ```

   不匹配应返回 `not-applied: lease-lost` 或 `run-batch-lost`，不得修改 attempt、segment 或 sibling batch。若产品决定让任意标签页暂停同一用户的任务，则必须显式把它定义为不受 lease 所有者限制的全局命令，并修改 §9.4、UI 文案和测试；不能同时声称两种语义。新增双实例测试：非 owner 在拥有正确 batch ID/epoch 时 pause 仍零写入，owner 对 pre-dispatch 与 dispatched attempt 的 pause 按 §9.3 正常生效。

5. **[MEDIUM] 计划与导入 locator 的唯一性没有被 schema/语义不变量明确强制，`draftIndex` 和各 ID 被当作唯一键使用却只受格式校验。**

   **位置：** `design.md` §4.2～§4.3、§5、§10.1～§10.4、§14.2；当前 `ImportDraftSchema.index` 也只校验“正整数”。

   **问题：** 设计反复要求 import scope 先按“唯一的 `draft.index`”定位，并用 `segmentId`、`attemptId`、`runBatchId`、`unitId`、`outboxId` 进行条件写，但展示的 schema 只校验字符串格式和数组形状。没有明确要求 ImportJob 内 `draft.index` 唯一（最好保持 1..N 连续），也没有列出 segment ID、initialSegmentIds、每段 unit ID、attempt ID、runBatch ID（设计仅文字称其在单 plan 内唯一）、outbox ID 与 `treeCalls.rootSegmentId` 的唯一/引用完整性规则。一个手工 v5 备份或损坏 IndexedDB 行可包含两个 `draft.index === 1` 的 plan；“按 locator 取得唯一 draft”就没有定义，错误实现很容易用 `find()` 选中第一项。重复 unit/segment/attempt ID 同样会使 envelope coverage、完成写入或 budget 计数指向不确定对象，破坏本设计最核心的迟到响应 fencing。

   **具体修复：** 在共享语义校验中把 identity namespace 作为显式不变量，而不是依赖随机 ID 的通常行为。至少要求：

   ```ts
   assertUnique(importJob.drafts.map((draft) => draft.index));
   assertSameSet(
     plan.initialSegmentIds,
     initialSegments.map((segment) => segment.id),
   );
   assertUnique(plan.segments.map((segment) => segment.id));
   for (const segment of plan.segments) {
     assertUnique(segment.units.map((unit) => unit.id));
     assertUnique(segment.attempts.map((attempt) => attempt.id));
   }
   assertUnique(plan.runBatches.map((batch) => batch.id));
   assertUnique(plan.segments.flatMap((segment) => (segment.outbox ? [segment.outbox.id] : [])));
   ```

   同时验证所有 parent/child/root、winning/candidate/outbox attempt、tree-call root 引用恰好命中其所属 plan 的唯一对象。创建/二分/初始化必须生成满足这些条件的值；任何语义写、v5 replace/merge 和 direct repository API 遇到重复 locator 都返回 invariant/BackupError，不能选择“第一个”。增加 AC-42/AC-50 用例：重复 draft index、segment/unit/attempt/batch/outbox ID 或悬空引用均零写入拒绝。

## Verified Assumptions

- 当前项目确为纯前端 React 19.3、TypeScript 7、Vite 8、Dexie 4.4、Zod 4、Vitest 5 架构。`package.json` 没有可复用的 Markdown parser 或 tokenizer。当前 Dexie 最高为 v7，备份为 v4；独立 `ChapterTranslationJob` 表并升至 v8 是满足“同章一个活跃任务、不同章节可并存、与 ImportJob 隔离”的可行基线。
- 当前 `ImportScreen.translateOne` 和 `TranslateSheet` 都仍是整章调用。前者只以 `finishReason === 'length'` 和非空文本拦截，后者不检查 length；后者的进度/预览在 React state，采用前直接合并 glossary。设计用共享持久化分段、envelope、outbox 和编辑器预览替换这两条路径，方向符合需求。
- 当前 `OpenAiCompatibleClient` 会保留流中最后一个非空 `finishReason`；`parseSseStream` 在干净 EOF 结束，`parseChunk` 忽略坏 JSON。设计以唯一 complete frame、unit coverage、token/接缝/受保护 token 校验作为成功条件，而不是以 `finish_reason`、`[DONE]`、提高 `max_tokens` 或用户手动分章证明完整，方向正确。
- 当前 glossary 的 `mergeGlossary` 按原文 trim/小写 first-wins，作者显式 `setGlossaryEntry` 可以覆盖。因此有序 outbox 必须在仓储层完整定义，不能只依赖 runner 的正常调度。
- 当前 `ImportScreen.finalize/finalizeWorldview` 先 `createProposals`、再单独删除 ImportJob，且 proposal factory 每次调用 `newId()`；这验证 finding 2 所述的恢复重复风险不是抽象担忧。
- 当前 `resumeStepOf`/ImportScreen 对无法 parse 的旧 ImportJob 有清理出口。当前设计改为拒绝覆盖 raw 行后，必须提供同等安全的显式恢复出口，才能保留旧导入兼容目标。
- 本轮实际执行：`npm run build` 退出码为 0（仅有既有大 chunk 警告）；`npx vitest --run` 为 75 个测试文件、1719 个测试全部通过。该结果只验证改动前基线，不证明设计中新模块或验收矩阵已经实现。

## Unverified/Wrong Assumptions

- **不完整：** “更早 outbox 都已 applied”足以实现严格 source order。较早 source 尚未产生 outbox 时，后段仍可能抢占 glossary，见 finding 1。
- **未定义：** 最终提案 materialization 与任务删除会天然具有原子性或重试幂等性。当前代码是两次独立写入，设计未提供替代事务，见 finding 2。
- **错误：** 无法 parse 的 raw ImportJob 既可拒绝覆盖又仍能由现有 discard/delete API 安全清除。当前设计的三个 API 条件组合没有这样的路径，见 finding 3。
- **矛盾：** pause 同时必须验证 owner/lease，又可以只凭 runBatchId 与 epoch 调用，见 finding 4。
- **未验证：** 随机生成的 ID 足以替代持久化 schema/备份/仓储中的唯一性约束。所有 locator 都要在不可信 v5 数据和损坏行上失败关闭，见 finding 5。
- `translationPlan`、UAX #29 breaker、protocol parser、runner、ChapterTranslationJob、edit lease、v5 parser 和相应测试目前均尚不存在于源码；本审查只能验证设计与现有系统的衔接，不能把 1719 项既有测试当成新行为的证据。
