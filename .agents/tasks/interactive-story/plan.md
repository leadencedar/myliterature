# 实现计划 · 互动推演（世界线）

> 依据：`brief.md`（唯一需求来源）、`requirements.md`、`design.md`（第 3 轮，下称「设计」）、`design-review.md`、`design-addendum.md`（第 3 轮审查遗留的 5 条，优先级等同设计；步骤提示里写的 `design-followups.md` 不存在，实际文件是 `design-addendum.md`）。
> 架构不再改动：本计划只排顺序、定落点，凡设计留了口的地方在「实现决定」里写一次，实现者不用再选。
> 项目根：`/Users/leadencedar/Production/Project/MyLiterature`（下文相对路径都相对它）。不是 git 仓库，直接在原目录改，**不 commit**。不引入任何新依赖。

## 0. 通用约定

- 验收命令（每个阶段结束都要跑，全绿才算完成）：
  - `cd /Users/leadencedar/Production/Project/MyLiterature && npm run build`（= `tsc --noEmit && vite build`）
  - `cd /Users/leadencedar/Production/Project/MyLiterature && npx vitest --run`（改动前 62 个文件、1443 个测试全绿；文件数与用例数只增不减，不许跳过）
  - 单文件调试：`npx vitest --run <路径>`
- 测试夹具：UI 测试用 `src/test/renderWithProviders.tsx` 的 `createTestHarness()`（`harness.renderUI(ui, initialPath)`、`harness.repository`、`harness.cleanup()`），`useActiveNovel.setState({ activeNovelId })` 选中作品；模型调用一律 `vi.spyOn(globalThis, 'fetch')`，响应用 `src/test/llmFixtures.ts` 的 `sseResponse` / `textDeltaEvents` / `jsonResponse` / `completion`。禁止新增或更新 vitest 快照。
- 允许改动的现有断言只有设计 §13.2 末尾列的四类：`DexieNovelRepository.test.ts` 的 4 处 `verno`（1633、1707、1817、2248 行，6 → 7，1632 行用例名「当前架构版本为 6」改 7）；`backup.test.ts` 的 `BACKUP_VERSION` 值与「来自更新版本」用例（改 version 5）；`WritingNormsSection.test.tsx` 默认作用范围 5 → 6 项、列表元信息加「互动推演」；`writingNorm.test.ts` 的 `ALL_NORM_SCOPES` 长度。其他现有测试一条不改，尤其 `noNormsBaseline.test.ts` / `noNormsInputs.test.ts`。
- 注释用中文，写「为什么」。单套响应式 DOM，不做移动 / 桌面两套。
- 不动的文件（设计 §14 末尾）：`GenerateChapterSheet.tsx`、`computeStats`、`SetupSection.tsx`、`ReviseSheet.tsx`、`NormCheckSheet.tsx`、`ChapterSummarySheet.tsx`、`ImportScreen.tsx`、`TranslateSheet.tsx`、`exportText.ts`、设置页、`src/ui/Sheet.tsx`（含 `ConfirmDialog`）。

### 实现决定（设计留口处，一次定死）

1. **循环依赖**：`schema.ts` 的备份 `superRefine` 规则 10 要用 `normalizeAction`。`normalizeAction` 放在 `src/domain/scenario.ts`，该文件与 `src/domain/worldline.ts` 对 `schema.ts` 只用 `import type`（与 `schema.ts` 第 12 行对 `importJob.ts` 的既有做法一致），这样 `schema.ts` 可以运行时 import `scenario.ts` 而不成环。`OPTION_TENDENCIES` / `ENTRY_STATUSES` / `OC_ASPECTS` 定义在 `schema.ts`（设计 §2.1）。
2. **`ScenarioOutlinePlan` 类型**放在 `src/domain/scenario.ts`（纯类型，仓储接口与 `pathOutline.ts` 共用）：`{ scenarioId; mode: 'main'; volumes: { title; synopsis; targetWords: number | null; chapters: { title; synopsis; targetWords: number | null; linkedEntryIds: string[]; nodeIds: string[] }[] }[] } | { scenarioId; mode: 'side'; appendToSideStoryId: string | null; title: string; synopsis: string; forkNodeId: string; chapters: { title; nodeIds: string[]; brief: string }[] }`。仓储的 `commitScenarioOutline` 在阶段 1 就实现并测（纯数据操作），阶段 5 只接上 `applyProposal`。
3. **`promoteLineEntry`** 同理在阶段 1 的仓储里实现并测；阶段 4 做 `promote.ts` 与 `applyProposal` 的 `promoteFrom` 分支。
4. **`applyProposal` 的 `scenarioOutline:*`** 在阶段 1 加占位分支（抛 `Error('尚未支持')`），满足穷尽检查；阶段 5 实现 `scenarioOutline:create`，`merge` / `replace` 一直抛「沉淀提案只支持新建」。
5. **基线目录**：`/tmp/myliterature-baseline-interactive`（不含 `node_modules`），阶段 1 第一步、改任何源码之前复制。生成 `BASELINE` 用的一次性脚本放在 `/tmp`，不进仓库。已有的 `/tmp/myliterature-baseline-writing-norms` 不动。
6. **评审逐条核对的七件事**（每阶段都要守，最后审查逐条看代码与测试，不只看全绿）：世界线差异沿树继承且兄弟隔离；锁定字段不可被覆盖；已走过的选项不可再选；回退 / 跳转 / 切换不发请求；没有推演时现有 prompt 逐字节不变；Dexie v6→v7 升级与 v1–v3 旧备份兼容；「提升为世界观」与沉淀大纲都走提案确认。

---

## 阶段 1 · 数据模型、世界线解析、仓储、迁移与备份（设计 FEAT 0 + FEAT 1）

- [x] 1.1 **零回归基线（必须最先做，改任何源码之前）**。
      `rsync -a --exclude node_modules /Users/leadencedar/Production/Project/MyLiterature/ /tmp/myliterature-baseline-interactive/`；按设计 §12.2 第 2 点的夹具（作品、带名家参考与非空 `extraInstruction` 的风格档案、两类分类、核心设定 + 普通条目、三节点大纲、三章含摘要、一部外传、两份规范：五项全开 / 只含 `writing`）在**未改动的代码**上跑 `/tmp` 里的一次性脚本，把十类任务的输出 `JSON.stringify` 后粘成 `BASELINE` 字面量：构建器主线 / 外传章节的 `{ stablePrefix, volatileSuffix, items, estimatedTokens }`；`buildChapter*`、`buildRevise*`（三种 action）、`buildSummary*`、`buildExtract*`、`buildExpand*`、`buildSetup*`、`buildNormCheck*`、`NORM_CONDENSE_SYSTEM` + `buildCondenseUserPrompt`、`buildTranslate*`（译名表由条目名拼出，同 `TranslateSheet`）、`STYLE_SAMPLE_SYSTEM` + `buildStyleSampleUserPrompt`、`MANUSCRIPT_STYLE_SYSTEM` + `buildManuscriptStyleUserPrompt`。写进新文件，结构照抄 `src/context/noNormsBaseline.test.ts`（常量 + `toBe` / `toEqual`，禁快照，夹具对象字面量 + 只用 `import type`）。
      Files: `src/context/noScenarioBaseline.test.ts`（新）
      Verify: `npx vitest --run src/context/noScenarioBaseline.test.ts` 绿；把该文件拷到 `/tmp/myliterature-baseline-interactive/src/context/`、软链 `node_modules` 后在基线目录同样绿；全量 `npx vitest --run` 63 个文件全绿。

- [x] 1.2 **Schema 与常量**。按设计 §2.1–§2.3 在 `schema.ts` 加：枚举常量、`EntryRefSchema`、`WorldlineDeltaSchema`（+ `EMPTY_DELTA`）、`DeltaNoticeSchema`、`ScenarioSetupSchema`、`ScenarioSchema`、`ArrivedBySchema`、`ScenarioOptionSchema`、`ScenarioEndingSchema`、`ScenarioNodeSchema`（新一节放在「写作规范」之后、「章节摘要」之前）；`FieldDefSchema.mutability`（可选、无 default）；`KnowledgeEntrySchema.scope`（discriminatedUnion，default universal）与 `fieldLocks`；`OutlineNodeSchema` / `ChapterSchema` / `SideStorySchema` 的 `scenarioSource`（default null）；`WritingNormScopeSchema` 末尾加 `'interactive'`，`WritingNormSchema.scopes` 默认改六项；`ProposalTargetSchema` 加 `'scenarioOutline'`。`writingNorm.ts`：`NORM_SCOPES` 追加 `{ id: 'interactive', label: '互动推演', hint: '推演每一步的情节与选项、收尾' }`，新增冻结常量 `ALL_NORM_SCOPES_V6` 与全函数 `addInteractiveScopeIfFull(scopes)`（设计 §4.1）；仓储 `createWritingNorm` 的缺省作用范围随 `ALL_NORM_SCOPES` 变成六项（只改注释「全部五项」）。`sections.ts` 的 `NORM_SCOPE_USAGE.interactive` 用设计 §8.5 的原句。`defaults.ts`：按设计 §3.3 的表给内置与建议分类模板加 `mutability`，导出 `builtinMutability(category, key)`（kind 内置查 BUILTIN；custom 只在名称与 SUGGESTED 同名且键在模板里时取值）。`fields.ts` 的 `fieldSpecsFor('scenarioOutline')` 返回设计 §7.2 末尾的三个 spec；`apply.ts` 加 `scenarioOutline:*` 占位分支（实现决定 4）。
      改 4 类允许的现有断言中与本步相关的：`writingNorm.test.ts`、`WritingNormsSection.test.tsx`。
      Files: `src/domain/schema.ts`、`src/domain/writingNorm.ts`、`src/domain/writingNorm.test.ts`、`src/prompt/sections.ts`、`src/domain/defaults.ts`、`src/proposal/fields.ts`、`src/proposal/apply.ts`、`src/data/NovelRepository.ts`（注释）、`src/features/knowledge/WritingNormsSection.test.tsx`
      Tests: `writingNorm.test.ts` 补 `addInteractiveScopeIfFull`（五项乱序 → 六项规范顺序；四项 / 已含 interactive / 空数组原样）；`fields.test.ts` 补 `scenarioOutline` 三栏。
      Verify: build 绿；全量 vitest 绿；`noScenarioBaseline.test.ts` 与 `noNormsBaseline.test.ts` 仍绿。

- [x] 1.3 **领域纯函数**。`src/domain/scenario.ts`：`pathTo`、`childrenOf`、`mainPath`、`isOnMainPath`、`walkedChoices(node, children)`、`latestLeafOf`（depth > createdAt > id 码元序）、`normalizeAction`（NFKC → 去全部空白 → 去末尾 `。．.！!？?…~～`）、`actionSimilarity`（字符二元组 Dice，阈值常量 0.8）、`checkpointsToFill(path, parentDepth)` 与 `contextGap`（设计 D5.3）、`sedimentCoverage`、`sedimentRange`（含有洞 `[a, b]`、外传追加按最后一个 `scenarioSource` 非空章节的 `nodeIds` 末项 `L` 判定 —— design-addendum 第 3 条）、`forkNodeOf`、`validateScenarioSetup` / `validateFreeAction`（返回第一条中文错误）、`ScenarioOutlinePlan` 类型。`src/domain/worldline.ts`：`fieldMutability(category, entry | undefined, key)`（条目 → 模板 → `builtinMutability` → mutable）、`visibleEntries`、`effectiveKnowledge`（设计 §3.2：叠加、揭示 vs 处境、已提升别名、`inactive`）、`resolveStepChanges(raw, ctx)` 与 `sanitizeDelta(delta, ctx)`（设计 §3.4 整张表，含世界规则不死亡、预设揭示、goal 类型冲突、`castId = cast[0].id`）、`renderScenarioEntry`、`renderWorldlineState`（码元序 + id 排序，不用 `localeCompare`）、推断条目复用 `src/domain/entrySearch.ts` 已导出的 `mentionedEntries(text, entries)`（构建器用的就是它，不复制一份；本线新条目先包成同形状的临时对象再传）。两个文件对 `schema.ts` 只 `import type`。
      Files: `src/domain/scenario.ts`、`src/domain/worldline.ts`（新）、`src/domain/scenario.test.ts`、`src/domain/worldline.test.ts`（新）
      Tests（设计 §13.2 对应两节全部用例）：**T1 继承与兄弟隔离**（1→a→2a→a→3a，2a 改 X 身份为叛徒，3a 可见、2b 子树看不到；2a 新本线人物 2b 不可见；限定条目推演 S 可见 / T 不可见 / `fromNodeId` 子树；编辑 2a 后 3a 变 2b 不变）；**T2 锁定**（「运作规则」覆盖被丢弃 + `locked-field`，有效值不变；本线条目后续覆盖「说话方式」被丢弃）；`fieldMutability` 四级、`builtinMutability` 三例（法宝 / 道具 / 改名器物）；提升别名、预设揭示、`inactive` 三例、OC add/remove、flags、`restored`；**T4 主线序列**（a 推 3 步 → 回根走 b → 切回 a 只看 → a 上推进，逐步断言主线）；`normalizeAction` 与相似度阈值两侧；`checkpointsToFill` 四例；`sedimentRange` 有洞 / 换主线后追加 / 两部外传取更深 / 外传末尾一章手写（`scenarioSource = null`）仍能追加（addendum 3）。
      Verify: `npx vitest --run src/domain` 绿；build 绿。

- [x] 1.4 **Dexie v7**。按设计 §4.1 在 `db.ts` 新增 `scenarios` / `scenarioNodes` 表声明与 `version(7)`（新表 + upgrade：条目补 `scope` / `fieldLocks`，三表补 `scenarioSource`，规范 `addInteractiveScopeIfFull(norm.scopes ?? ALL_NORM_SCOPES_V6)`），注释写为什么。改 4 处 `verno` 断言。
      Files: `src/data/dexie/db.ts`、`src/data/dexie/DexieNovelRepository.test.ts`
      Tests: 迁移用例（验收 31）：原生 Dexie 声明到 v6 写入作品 / 条目 / 大纲 / 章节 / 外传 / 三份规范（五项全开、只 writing、缺 scopes），用 `AppDatabase` 打开：`verno === 7`、默认值补齐、五项变六项、只 writing 不变、缺字段变六项、其余字段逐字段不变、能新建推演。
      Verify: `npx vitest --run src/data` 绿。

- [x] 1.5 **仓储**。按设计 §6.1 / §6.2 改 `NovelRepository.ts` 与 `DexieNovelRepository.ts`：`EntryQuery.scope?: 'worldview' | 'all'`（默认 worldview，只返回通用条目）；`findEntryByName` 只匹配通用条目；`EntryCreateInput` / `EntryUpdateInput` 别名；推演全部方法（`listScenarios` … `commitScenarioOutline`），`appendScenarioNode` 在一个 rw 事务里做 §2.4 全部检查 + `sanitizeDelta` + 改 `mainNodeId` / `cursorNodeId` / `lastAdvancedAt`；`setScenarioCursor` 只改 cursor；`updateScenarioNodeDelta` 有提示即抛第一条、写 `deltaEditedAt`；`deleteScenario(id, { trashScopedEntries })` 同事务清 `scenarioSource` 与限定条目；`hardDeleteEntry` 拒删推演主角（文案「这个条目是推演《X》的主角，先删除推演」）；`deleteNovel`、`exportSnapshot`、`importSnapshot` 加两张新表，merge 分支按推演整棵替换节点并调私有 `pruneScenarioRefs(tx, novelId, scenarioId)`（设计 §4.2 末尾伪代码），replace 分支不调。错误文案逐字用 §6.2 表。
      调用点：`KnowledgePage.tsx` 两处、`TrashSheet.tsx`、`ProposalInbox.tsx` 的 `listEntries` 加 `scope: 'all'`；其余调用点（写作页、立项、导入、翻译）不改。
      Files: `src/data/NovelRepository.ts`、`src/data/dexie/DexieNovelRepository.ts`、`src/data/dexie/DexieNovelRepository.test.ts`、`src/features/knowledge/KnowledgePage.tsx`、`src/features/proposals/ProposalInbox.tsx`
      Tests（「互动推演」新 describe，设计 §13.2 仓储一节全部）：createScenario 两种主角；appendScenarioNode 的根唯一 / 结局后拒绝 / 同选项二次拒绝 / 规范化后同自由输入拒绝 / 收尾一次 / 主线与 cursor 改为新节点 / 落库再丢锁定覆盖；**一组推进、回退、编辑差异、结局后 `entries` 表逐行不变（验收 4）**；**锁定字段手动编辑被拒、库里不变（验收 8）**；`setScenarioCursor` 不改 `mainNodeId`；options 去重与上限 8；deleteScenario 三情形；deleteNovel 级联；hardDeleteEntry 拒删主角（含主角已软删）；commitScenarioOutline 主线（顶层末尾、章级 `scenarioSource`、卷 null、`linkedEntryIds` 只通用）/ 外传新建（`forkNodeId`、章节 `brief`）/ 追加（order 接续、名称简介不变）/ 重名与目标外传已删回滚；promoteLineEntry create / mergeInto / 目标已删；重开库后树与 cursor 完整（验收 30）；merge 整棵替换（本地 L 消失、`mainNodeId` 来自备份、本地独有推演 T 保留）；**悬空引用清理五种本地行 ①–⑤，并断言之后 `parseBackup(serializeBackup(buildBackupFile(await repo.exportSnapshot(), 0)))` 不抛**；replace 不清理；**有限定条目（含推演 OC）时 `listEntries(novelId)` 与只有通用条目时逐项相同、`findEntryByName` 匹配不到限定条目（§12.2 第 4 点）**。
      Verify: `npx vitest --run src/data` 绿；build 绿。

- [x] 1.6 **回收站（design-addendum 第 1 条）**。`TrashSheet.tsx`：把 `ConfirmDialog` 换成本地拼的 `<Sheet size="dialog" title="彻底删除？" footer={取消 / 永久删除(danger)}>`，正文仍是「「X」将被永久删除，无法恢复。」，`purgeError` 非空时其下渲染 `<p role="alert">`；`purge()` 加 try/catch，失败时框保持打开，关闭或换目标时清空错误；`listEntries` 传 `{ includeDeleted: true, scope: 'all' }`；额外 `useRepoQuery` 一次 `listScenarios(novelId)` 建 `entryId → 推演名[]`，主角条目旁一行小字「推演《X》的主角」。按钮文案、样式、取消行为与原 `ConfirmDialog` 一致。`src/ui/Sheet.tsx` 不改。
      Files: `src/features/knowledge/TrashSheet.tsx`、`src/features/knowledge/TrashSheet.test.tsx`（新）
      Tests: 主角条目有小字；彻底删除失败时框内出现 `role="alert"` 文案、框仍打开、条目仍在列表与库里；普通条目彻底删除行为不变；`KnowledgePage.test.tsx` 现有回收站用例不改且仍绿。
      Verify: `npx vitest --run src/features/knowledge` 绿。

- [x] 1.7 **备份 v4**。`backup.ts`：`BACKUP_VERSION = 4` + 注释（设计 §4.2 原话）；`parseBackup` 整份解析后 `version <= 3` 时对 `data.writingNorms` 逐份 `addInteractiveScopeIfFull`。`schema.ts` 的 `RepositorySnapshotSchema` 加 `scenarios` / `scenarioNodes`（default `[]`），`superRefine` 追加设计 §4.2 规则 1–10（路径与文案照表）。`BackupSection.tsx` 第 31 行与第 185 行**两处**合并说明都改成「id 相同的记录以备份为准；同一个互动推演整棵分支树以备份为准。」（design-addendum 第 4 条）。
      Files: `src/features/export/backup.ts`、`src/domain/schema.ts`、`src/features/export/backup.test.ts`、`src/features/export/BackupSection.tsx`
      Tests: 版本号 4、「来自更新版本」改 5；带推演 / 多分支 / 差异 / 限定条目 / 锁定覆盖 / 沉淀溯源的往返（replace 与 merge）逐字段相同（验收 33）；v1 / v2 / v3 覆盖恢复与合并各一例（推演空、条目通用、溯源 null、v3 五项规范 → 六项、收窄不变）；v4 五项保持五项（验收 32）；规则 1–10 各一例被拒，`detail` 以对应路径开头（验收 34）；`BackupSection.test.tsx` 现有用例不改且绿。
      Verify: `npx vitest --run src/features/export` 绿。

- [x] 1.8 **基线追加变体**。在 `noScenarioBaseline.test.ts` 为每个函数追加变体输入（设计 §12.2 第 3 点：条目带 `scope` / `fieldLocks`、模板带 `mutability`、三处 `scenarioSource: null`、规范多 `'interactive'` 再加一份只含 `'interactive'` 的启用规范、构建器显式 `scenarioContext: undefined`），全部断言等于 `BASELINE`。夹具仍只用对象字面量 + `import type`。
      Files: `src/context/noScenarioBaseline.test.ts`
      Verify: 全量 `npx vitest --run` 绿 + `npm run build` 绿；按设计 §12.2 第 5 点在 `/tmp/myliterature-baseline-interactive` 再跑一次同文件也绿（旧代码同样通过，证明基线来自改动前）。

阶段 1 验收：build + 全量 vitest 全绿；T1、T2（单元与仓储部分）、T9、T10 用例在位。

---

## 阶段 2 · 推演生成与循环（设计 FEAT 2，依赖阶段 1）

- [x] 2.1 **流式正文 + 结构化尾部**。新建 `src/llm/proseTail.ts`（设计 §5.2 全部 7 步：`PROSE_TAIL_SENTINEL`、`visibleProse`、`splitProseAndTail`、`generateProseWithTail`；复用 `structured.ts` 已导出的 `extractJsonText` / `formatZodIssues`；JSON Schema 用 `z.toJSONSchema(schema, { io: 'output' })`）。`useLlm.ts` 的 `LlmRunner` 加 `runProseWithTail(task, options)`，写法与 `runStructured` 一致，现有两个方法不动。`taskProfiles.ts` 加五个 TaskKind 与 profile（设计 §5.1 表与 label，注释写取舍），不加进设置页 `TASK_ORDER`。
      Files: `src/llm/proseTail.ts`、`src/llm/proseTail.test.ts`（新）、`src/llm/useLlm.ts`、`src/llm/taskProfiles.ts`
      Tests（stub `LlmClient`）：分块流式 `onProse` 从不含分隔符前缀（含分隔符被切在两块中间、正文含单个 `@`）；正常切分；缺分隔符 → 修复成功且正文用首轮；JSON 不合 schema → 修复成功；修复后仍失败抛 `parse`；首轮 `length` 抛 `truncated` 且只发 1 次请求；修复轮截断抛 `truncated`；正文为空抛 `parse`；无结局时选项 1 个 / 5 个 → 修复（验收 19）。
      Verify: `npx vitest --run src/llm` 绿；build 绿。

- [x] 2.2 **步骤 schema 与提示词**。`src/features/scenario/stepSchema.ts`：`StepTailSchema`（设计 D3.1 原样，含 `superRefine`）、`WrapUpTailSchema = StepTailSchema.refine(v => v.ending !== null)`、`OptionsBatchSchema`、`SummaryOutSchema`。`src/features/scenario/scenarioPrompt.ts`：设计 §5.4 全部导出函数与 `OPENER` / `SCENARIO_RULES` 常量原文；系统提示按 D5.1 八项顺序，规范用 `composeNormsSection('interactive', …)` 排在核心设定之前；用户提示按 D5.1 八块顺序，`excludedEntryIds` 只影响推断档；action 渲染照表；注入清单 `ScenarioContextItem[]` 带 token 估算（`src/context/tokens.ts` 的 `estimateTokens`）。
      Files: `src/features/scenario/stepSchema.ts`、`src/features/scenario/scenarioPrompt.ts`、`src/features/scenario/scenarioPrompt.test.ts`（新）
      Tests（设计 §13.2 `scenarioPrompt.test.ts` 全部）：同推演不同节点 / 分支 / 收尾 system 逐字节相同；「互动推演」规范位置正确、无该范围的不出现（验收 29）；锁定字段标「（底层，不可改变）」；通用 pinned 主角只出现一次；块顺序、最近 3 步、检查点 + gap、自由输入带「这是尝试，不是既成事实」（验收 9）、导演提示三阶段与超步数、收尾要求；`excludedEntryIds` 条目不进 user 且 system 不变；四种请求 system 在【推演规则】结束前逐字节相同；options / summary user 内容；两个 schema 的拒绝例。
      Verify: `npx vitest --run src/features/scenario` 绿。

- [x] 2.3 **推演编排 `useScenarioRunner`**。设计 §5.3：`advance`（前置检查不发请求 → 从仓储读最新数据 → `checkpointsToFill` + gap 规则：`gap > 7` 同步按顺序补、失败本步不生成，否则后台补 → 组 prompt → `runProseWithTail('interactive-step' | 'interactive-ending')` → `resolveStepChanges` + 选项分 id + 序号解析 → `appendScenarioNode` → 新检查点后台补）、`regenerateOptions`、`summarizeCheckpoint`；在途 `Set<nodeId>` 去重，同步补遇在途则 await；卸载 cleanup `abort()` 全部在途请求，`aborted` 在卸载后不更新状态。把可测的编排逻辑写成不依赖 React 的 `createScenarioRunner({ repo, llm })`，hook 只包一层，便于用 stub 单测。
      Files: `src/features/scenario/useScenarioRunner.ts`、`src/features/scenario/scenarioRunner.test.ts`（新）
      Tests（stub repo 用 fake-indexeddb 的真仓储 + stub `LlmRunner`）：截断与修复失败都不落节点；锁定覆盖被丢弃并进 `notices`；连续缺两个检查点且 `gap > 7` 时按顺序发两次 summary、第二次 user 含第一次摘要、全部完成后才发 step；第一次失败则第二次不发、本步不生成；同一检查点并发只发一次；abort 后不落库。
      Verify: `npx vitest --run src/features/scenario src/llm` 绿；build 绿。

阶段 2 验收：build + 全量 vitest 全绿；`noScenarioBaseline` 仍绿。

---

## 阶段 3 · 推演 UI 与导航（设计 FEAT 3，依赖阶段 2）

- [x] 3.1 **路由与写作页入口**。`AppShell.tsx` 加 `<Route path="/write/scenario/:scenarioId" element={<ScenarioPage />} />`（`AppNav` 对 `/write` 不设 `end`，无需改）。`WritingPage.tsx` 在「全书进度」Section 与空作品 `EmptyState` 之前渲染 `<ScenarioEntryCard novel={novel} />`（设计 §8.1），这是写作页唯一改动。新建 `ScenarioEntryCard.tsx`、`ScenarioListSheet.tsx`、`ScenarioSetupSheet.tsx`（D4.1 校验用 `validateScenarioSetup`，目标与里程碑「添加 / 上移 / 下移 / 删除」，编辑模式主角与起点只读）。
      Files: `src/app/AppShell.tsx`、`src/features/writing/WritingPage.tsx`、`src/features/scenario/{ScenarioEntryCard,ScenarioListSheet,ScenarioSetupSheet}.tsx`（新）
      Verify: build 绿；`WritingPage.test.tsx`、`AppShell.test.tsx` 现有用例不改且绿。

- [x] 3.2 **推演页与面板**。`ScenarioPage.tsx`（设计 §8.3 第 0–7 项：`RequireNovel title="互动推演"`、推演不存在 / 属于其他作品、落点回落只在内存、页头徽标「主线 · 第 k 步」/「外传线 · 不在主线上」+「回到主线最新一步」、面包屑 `nav[aria-label="当前路径"]` + `aria-current="step"`、流式正文 `aria-live="polite"`、notices 提示条、「生成时依据的是旧事实」、选项大按钮（倾向 / 风险文字标签）、已走过 `disabled` + 「已走过」+「去这条线」、走过的自由输入列表、再给几个选项、自由输入（≤ 200、计数、相似提示「仍然这样做」、`⌘/Ctrl+Enter` 且 `isComposing` 不响应）、结局区（坏结局说明、「回到上一个挑战」）、底部操作栏、生成中「停止」、失败 alert +「重试」、未开局状态、「本步依据」`<details>` 与推断条目复选框、生成完成焦点移到 `tabIndex={-1}` 的 h2）。跳转一律只调 `setScenarioCursor`。另建 `ScenarioBreadcrumb.tsx`、`WorldlineNavigatorSheet.tsx`（当前路径 + 直接分支 + 已到达结局，`latestLeafOf`）、`WorldlineStateSheet.tsx`（四区块，前情摘要可编辑，提升按钮先渲染为禁用占位、阶段 4 接上）、`DeltaEditor.tsx`（只列可变字段）、`WrapUpSheet.tsx`、`DeleteScenarioDialog.tsx`（本地 `Sheet size="dialog"`，复选框默认勾选，失败框内 alert）。
      Files: `src/features/scenario/{ScenarioPage,ScenarioBreadcrumb,WorldlineNavigatorSheet,WorldlineStateSheet,DeltaEditor,WrapUpSheet,DeleteScenarioDialog}.tsx`（新）
      Verify: build 绿。

- [x] 3.3 **推演 UI 测试**（T3–T6、T11）。`createTestHarness` + `vi.spyOn(globalThis, 'fetch')`，分块流用 `sseResponse(textDeltaEvents([...]))`。
      Files: `src/features/scenario/ScenarioPage.test.tsx`（新）
      Tests（设计 §13.2 `ScenarioPage.test.tsx` 全部条目）：全流程（卡片「开始一局」→ 新建 OC → 开局分块流中出现部分情节 → 选 a → 推进 → 面包屑回「开局」fetch 计数不变 → a「已走过」且 disabled、b/c 可点、文字同首次 → 选 b → 导航「去这条线的最新一步」回 a（计数不变）→ 在 a 推进新节点挂 a 线下 → 坏结局无选项无输入框 →「回到上一个挑战」后正常推进）；主线徽标切换；自由输入（user 含「作者为主角输入的尝试」、与已走过同则禁用、相似出现「仍然这样做」）；导航列出分支与结局并可跳；再给几个选项发 1 次请求、原选项不变；截断不落节点；收尾显示结局类型；锁定覆盖提示「有 1 处变化没有记下」；主要控件各一份；未开局 500 → 「还没有开局」与 disabled 操作栏 → 「开始」成功；生成中返回 → 节点数与 `mainNodeId` 不变且 signal 已触发；本步依据取消勾选后 user 不含该条目、system 不变；删除推演复选框默认勾选与不勾选两例；**T5 补强：12 步路径、第 5 步检查点缺摘要，挂载 / 面包屑跳第 3 步 / 导航去另一条线 / 打开本线状态全程 fetch 0 次；之后点选项推进，先发且只发 1 次 summary 请求，它完成后才发 step 请求（断言请求顺序，不许并发；gap = 9 > 7 按 D5.3 同步补 —— design-addendum 第 5 条）**；落点回落两例且 `cursorNodeId` 仍为 null；推演不存在；无当前作品。
      Verify: `npx vitest --run src/features/scenario` 绿；全量 vitest + build 绿。

阶段 3 验收：build + 全量 vitest 全绿。375px / 1280px 的视觉形态 jsdom 验不了，记为需手测（验收 40）。

---

## 阶段 4 · 世界观属性与「提升为世界观」（设计 FEAT 4，依赖阶段 1、3）

- [x] 4.1 **知识库界面**。`EntryEditorSheet.tsx` 加默认折叠的「互动推演设置」（作用范围：通用 / 仅限推演多选 + 每推演登场条件；逐字段可变性：显示继承默认「默认：锁定」，可选 锁定 / 可变 / 跟随分类；所限定推演已不存在时提示）；`EntryList.tsx` 限定条目徽标「限定 · 推演《X》」；`CategoryManagerSheet.tsx` 字段行加「世界线可改写」开关写 `FieldDef.mutability`。都走现有 `updateEntry` / `updateCategory`，不走提案（作者直接编辑世界观）。
      Files: `src/features/knowledge/{EntryEditorSheet,EntryList,CategoryManagerSheet}.tsx`、`src/features/knowledge/KnowledgePage.test.tsx`（追加用例，不改现有）
      Tests: 徽标出现；字段锁定开关写入库；作用范围改成通用后条目出现在 `listEntries` 默认结果里。
      Verify: `npx vitest --run src/features/knowledge` 绿。

- [x] 4.2 **提升走提案**。`src/features/scenario/promote.ts`（设计 §7.1 整张表：可变字段覆盖 → `knowledgeEntry:replace`（`buildReplaceProposal`，payload 只换一栏，不用 merge）；本线条目 → `create` + `promoteFrom`（作用范围通用）；同名通用条目 → `merge` + `promoteFrom`；锁定字段 / 状态 / 主角状态 / 事件 / 标记 → 不生成提案、返回原因文案；`origin: 'refine'`）。`apply.ts` 的 `knowledgeEntry:create` / `merge` 分支：payload 有 `promoteFrom` 时调 `repo.promoteLineEntry`，没有时行为与现在完全相同。`WorldlineStateSheet.tsx` 接上「提升为世界观」按钮：生成提案后显示「已生成待确认项，到知识库确认」与跳转。
      Files: `src/features/scenario/promote.ts`、`src/features/scenario/promote.test.ts`（新）、`src/proposal/apply.ts`、`src/proposal/apply.test.ts`（追加）、`src/features/scenario/WorldlineStateSheet.tsx`
      Tests: 可变覆盖 → replace 提案、diff 只有那一栏、**确认前条目不变、确认后为新值（验收 24）**；list 字段采用后等于覆盖值不是并集；本线条目 create / 同名 merge（采用后不新建、`promotedEntryId` 指向已有条目）；**字段后来锁定 → 不生成提案（验收 10）**；状态等不可提升；`apply.test.ts` 带 `promoteFrom` 的 create 与现有用例不变；`ScenarioPage.test.tsx` 追加一例：点「提升」后知识库待确认区出现提案，世界观条目未变。
      Verify: `npx vitest --run src/features/scenario src/proposal` 绿；build 绿。

阶段 4 验收：build + 全量 vitest 全绿。

---

## 阶段 5 · 沉淀为大纲 / 外传与「写这一章」（设计 FEAT 5，依赖阶段 1–4）

- [x] 5.1 **路径 → 大纲**。`src/features/scenario/pathOutline.ts`：`buildPathOutlineSchema(from, to)`（`superRefine` 首尾相接恰好覆盖、绝对步数）、`buildPathOutlinePrompt`（system = 开场白 + `composeStylePrefix` + 规划作用范围规范 + 任务说明；user = 各步「第 k 步」行动与原文 + 已有顶层卷名 + 外传分叉前情）、`serializeScenarioOutline`、`parseScenarioOutline(outlineText, { from, to, pathNodeIds, entries })`（在 `parseOutlineTree` 结果上只剥「对应步骤：」行，越界抛含「第 a–b 步」的错；「出场：」行另解析出**通用**条目 id 进 `linkedEntryIds`）、`toScenarioOutlinePlan`。`applyProposal` 实现 `scenarioOutline:create` → `parseScenarioOutline` → `repo.commitScenarioOutline`（失败事务回滚，提案留待确认）。`SedimentSheet.tsx`（设计 §7.2 第 1–5 步：模式由位置决定、`sedimentRange`、补洞与追加提示、已沉淀为外传提示、预估 tokens、点「生成大纲」才发 `path-to-outline` 请求、`buildCreateProposal({ target: 'scenarioOutline', origin: 'generate', … })`、内嵌 `ProposalInbox batchId`）。推演页「更多 → 沉淀这条线」接上；推演页顶部「本书主线大纲里有 N 章来自旧主线」提示；`OutlineNodeSheet.tsx` 只加一行「来自旧主线」标记。
      Files: `src/features/scenario/pathOutline.ts`、`src/features/scenario/pathOutline.test.ts`（新）、`src/features/scenario/SedimentSheet.tsx`、`src/features/scenario/SedimentSheet.test.tsx`（新）、`src/proposal/apply.ts`、`src/proposal/apply.test.ts`、`src/features/scenario/ScenarioPage.tsx`、`src/features/outline/OutlineNodeSheet.tsx`
      Tests: schema 合法 / 非法 / `from = 13` 拒从 1 起；序列化往返（含续沉淀 13–24）；越界文案；`synopsis` 留关键事件与出场、去掉对应步骤；出场只得通用 id；**`scenarioOutline:create` 主线 / 外传各一例：采用前大纲树与外传列表不变、采用后写入（验收 25）**；**外传 `scenarioSource.forkNodeId` 正确（T8）**；SedimentSheet：点「生成大纲」前 fetch 0 次、之后提案出现在面板内、确认后才写库。
      Verify: `npx vitest --run src/features/scenario src/proposal` 绿。

- [x] 5.2 **构建器 `scenarioContext`（含 design-addendum 第 2 条）**。`ContextBuilder.ts`：`ContextItemKind` 加 `'scenario'`；`ContextRequest.scenarioContext?: { label; limitedText; limitedLabel; forkText; stepsText; stateText; castEntryIds: string[]; hintText: string }`。`SummaryChainContextBuilder.ts`：**仅当 `scenarioContext` 存在时**——在易变后缀大纲位置 / 外传说明之后、【故事至此】之前按 D7.3 顺序插入四块（必选，清单 id `scenario-limited` / `scenario-fork` / `scenario-steps` / `scenario-state`，空串块不渲染不进清单）；把 `castEntryIds` 中未删除、非 pinned 的通用条目并入 `computeDefaultEntryIds` 的显式档（与 `linkedEntryIds` 同档）；把 `hintText` 追加进 hints。`scenarioContext` 不传时一行新代码都不走。
      Files: `src/context/ContextBuilder.ts`、`src/context/SummaryChainContextBuilder.ts`、`src/context/SummaryChainContextBuilder.test.ts`（追加）
      Tests: 四块位置与顺序、`stablePrefix` 不变、四项 `kind: 'scenario'` id 互异且 included、小预算仍 included、空串块不出现；**有 / 无 `scenarioContext` 对照：有时 `defaultEntryIds` 含 cast 通用主角、无时与现在相同**；`noScenarioBaseline` 与 `noNormsBaseline` 仍绿。
      Verify: `npx vitest --run src/context` 绿。

- [x] 5.3 **章节上下文与编辑器接线**。`src/features/scenario/chapterContext.ts` 的 `buildScenarioChapterContext(...)`：四块按 D7.3（限定设定取**本章最后一步**的 `effectiveKnowledge` 中 `origin === 'limited'`，主角必选，其余「碰过 ∪ 提到」最多 `MAX_INFERRED_ENTRIES`；分叉前经过只外传；推演原文外传前加「本章细纲：…」；世界线状态 = 第一步父节点处 + 本章内变化），并产出 `castEntryIds`（cast 中通用条目）与 `hintText`（本章步骤原文 + 外传章节 `brief`）。`ChapterEditorScreen.tsx`：判定来源（主线看大纲节点 `scenarioSource`、外传看章节 `scenarioSource`），非空才 `useRepoQuery` 读推演 / 节点 / `scope: 'all'` 条目 / 分类，**只**合进 `<GenerateChapterSheet context={{ ...context, targetChapterId: chapter.id, scenarioContext }}>`；共享 `context` 与 `ReviseSheet` 不变；主角在回收站与来源推演已不存在两条提示。
      Files: `src/features/scenario/chapterContext.ts`、`src/features/scenario/chapterContext.test.ts`（新）、`src/features/writing/ChapterEditorScreen.tsx`、`src/features/writing/ChapterEditor.test.tsx`（追加）、`src/features/scenario/scenarioChapter.e2e.test.tsx`（新）
      Tests: `chapterContext.test.ts`：本章第 2 步揭示的预设 P 进第一块 / P 只在下一章揭示时不进；`castEntryIds` 与 `hintText` 内容。e2e：新建 OC → 主线沉淀 →「写这一章」清单有三项、user 含步骤原文与 OC「身份」「说话方式」、采用前正文不变（验收 26）；**通用人物开局 → 沉淀为外传（简介不提主角名）→「写这一章」请求 user 含该人物「说话方式」原文（addendum 2）**；预设 P 对照组；段落加工请求不含【本章依据的互动推演】与【本章涉及的推演专属设定】；**外传第 1 章请求含【分叉之前的经过】，导出该外传文本不含分叉前任何一步的情节（验收 27）**；**换主线后旧主线大纲显示「来自旧主线」且章节正文仍在（验收 28）**。
      Verify: 全量 `npx vitest --run` + `npm run build` 绿；基线交叉核对（设计 §12.2 第 5 点）再跑一次两边都绿。

阶段 5 验收：build + 全量 vitest 全绿；T7、T8 与 addendum 2 / 3 的用例在位。

---

## 阶段 6 · 文档（依赖阶段 1–5，按实际实现写）

- [x] 6.1 **`docs/产品文档.md`**：按设计 §15 逐条改，保持「为什么」的写法、简洁：价值主张加「互动能沉淀」；5.1 例外改三类并照录 D6 第 1 点（**不得**写成「沙盒不被任何链路读取」）；5.2 推演差异丢弃规则；6.2 条目作用范围 / 可变性（为什么按字段、默认值表、提升规则）与规范作用范围表加「互动推演」（老规范只在五项全开时补）；新增 **6.8 互动推演**（开局、一步构成、已走过、自由输入是「尝试」、回退不花钱、主线跟随规则、结局与收尾、本线状态、沉淀、主线换了怎么办）；6.3 写作补来自推演章节的四块注入、段落加工不带推演材料、外传记住分叉点；6.7 备份含推演、旧备份兼容；**第 7 节信息架构**写作行加互动推演并写为什么不加第六个主导航（D10）；8.4「从一局推演到一章正文」；**第 9 节**推演缓存策略与「本步依据」的可见可调；**第 11 节非目标**加图形化分支流程图、多主角（数据已留口）、推演内容自动写回世界观、预生成未选分支、跨推演合并世界线；12 演进路线列延后项与「按规范检查推演节点」。
- [x] 6.2 **`docs/使用说明.md`**：新增「互动推演」一章与常见问题（设计 §15 列的 6 条）。
- [x] 6.3 **`docs/世界观写作指南.md`**：新增「为互动推演准备设定」一节——世界观是底层、世界线记变化，分层写；条目的**作用范围**（通用 / 仅限推演、登场条件）、**可变性**（默认锁定 / 可变字段表、锁定字段写成可验证的规则、「限制与代价」越具体失败越有说服力）；第 8 节给其他 AI 的提示词补「规则类设定写清能做什么、不能做什么、代价是什么」。
- [x] 6.4 **`docs/设计方案.md`**（设计 §15 的建议项）：第 7 节数据模型加推演 / 节点 / 差异 / 条目新属性，第 9 节加推演装箱顺序，备份版本 4。
      Files: `docs/产品文档.md`、`docs/使用说明.md`、`docs/世界观写作指南.md`、`docs/设计方案.md`
      Verify: 文档与代码一致（文案、默认值表、错误提示逐字对照实现）；`npm run build` 与全量 `npx vitest --run` 仍绿（文档不影响，但确认最终状态）。

---

## 最终验收

1. `npm run build`、`npx vitest --run`、`CI=1 npx vitest --run` 全绿，文件数与用例数 ≥ 62 / 1443 且无跳过。
2. 基线交叉核对（设计 §12.2 第 5 点）两边都绿，核对完删除 `/tmp/myliterature-baseline-interactive` 与软链及一次性脚本。
3. 审查逐条核对实现决定 6 的七件事与 design-addendum 的 5 条，看代码与对应测试，不只看全绿。
4. 未能自动验证的：375px / 1280px 视觉形态（验收 40）需手测。
