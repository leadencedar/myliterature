# 实现计划：导入目的地后置 + 外传

依据：`.agents/tasks/import-destination-sidestory/design.md`（定稿，第 15 节之后不再评审）。架构不再重新决定，本计划只负责排顺序。章节号（如「3.3」「4.4」）都指 design.md。

项目：`/Users/leadencedar/Production/Project/MyLiterature`。不是 git 仓库，直接在原目录改，**不要 `git init`，也不要提交**。

验证命令（每一项结束时都要跑，两条都必须全绿）：

- `npm run build`（`tsc --noEmit && vite build`）
- `npx vitest --run`（基线：49 个文件、1023 个测试全部通过）

调试单个文件可以先跑 `npx vitest --run <路径>`，但每项结束前必须跑一次全量。

**范围外，任何一项都不要改：**

- `src/features/settings/DiagnosticsSection.tsx`
- `src/app/store/diagnostics.ts`
- `src/app/store/useActiveNovel.ts`（`src/test/renderWithProviders.tsx` 会 import 它，只读不改）

另外 design 1.4 列出的事项也不做：逐章混选目的地、外传大纲树、跨线移动章节、按「番外」标题预选。

逐 FEAT 的执行细节（步骤、验收、验证命令）在 `.agents/tasks/import-destination-sidestory/task-import-destination-sidestory/` 下：`context.json` + `features/FEAT-001..005.json`，与下面五个阶段一一对应。

阶段划分：A 外传数据层 → B 导入的底层能力（纯增量，还不接 UI）→ C 导入流程重写 → D 外传在写作、上下文、摘要、导出、书架里的行为 → E 文档。B 刻意先把 `destination` / `drafts` **加进** schema，同时暂时保留 `importType` / `worldviewText`，这样旧的 `ImportScreen` 在 B 结束时仍能编译、测试仍然全绿。两个旧字段到 C 再删，和界面重写放在同一项里。

---

## 阶段 A：外传数据层（FEAT-001）

- [ ] 1. Schema 和领域辅助函数。
      `schema.ts` 新增 `SideStorySchema`/`SideStory`（3.1）和 `Chapter.sideStoryId: IdSchema.nullable().default(null)`；`NovelStats` 加 `sideChapterCount`（本项 `computeStats` 先返回 `0` 以保持编译，第 2 项实现真实计数）；`RepositorySnapshotSchema` 加 `sideStories` 和三条 `superRefine` 检查（找不到外传 / 外传属于别的作品 / 外传章节关联了大纲，报错路径见 3.1）。新文件 `src/domain/sideStory.ts` 实现 3.4 的七个函数：`isMainChapter`、`chaptersOfTrack`、`sideStoryLabel`、`chapterLabel`、`normalizeSideStoryTitle`、`sideStoryTitleKey`、`renderSideStoryBrief`。`ProposalTargetSchema` 的 `'sideStory'` **不在本项加**，放到第 4 项和字段规格、落库分支一起加，因为 `fieldSpecsFor` / `apply.ts` 有穷尽检查。
      Files: `src/domain/schema.ts`, `src/domain/sideStory.ts`（新）, `src/domain/sideStory.test.ts`（新）, `src/data/dexie/DexieNovelRepository.ts`（`computeStats` 补字段）
      Verify: `npx vitest --run src/domain` 通过。新测试覆盖第 11 节 `domain/sideStory.test.ts` 的全部断言，以及 schema 相关断言（`sideStoryId` 默认为 null；旧快照能解析；三种非法快照被拒，路径和文案正确）。之后跑 `npm run build` 和全量 `npx vitest --run`。

- [ ] 2. Dexie v5（只涉及外传部分）和仓储里的外传方法。
      `db.ts`：import `SideStory`，在类上声明 `sideStories!: Table<SideStory, string>`，写 `version(5).stores({ chapters: 'id, novelId, [novelId+index], sideStoryId', sideStories: 'id, novelId' })`，`.upgrade` 里只对 chapters 执行 `c.sideStoryId ??= null`，注释按 3.3 写。importJobs 的换算留到第 9 项，加在**同一个** v5 upgrade 回调里。
      `NovelRepository` 和 `DexieNovelRepository` 按 5.1 新增 `listSideStories` / `getSideStory` / `createSideStory` / `updateSideStory` / `deleteSideStory`，并改动以下方法：- `createChapter`：按线取最大章号 +1；外传必须存在且属于本书；外传章节的 `outlineNodeId` 必须为 null。- `updateChapter`：静默剥掉 patch 里的 `sideStoryId`；外传章节设非 null 的 `outlineNodeId` 时抛错。- `computeStats`：章数只算主线，新增 `sideChapterCount`，字数含全部章节。- `deleteNovel` / `exportSnapshot` / `importSnapshot`：加上 `sideStories` 表。
      重名一律用 `sideStoryTitleKey` 判断。`createSideStory` 和 `updateSideStory` 都要剥掉受保护键 `id` / `novelId` / `order` / `createdAt`。
      Files: `src/data/dexie/db.ts`, `src/data/NovelRepository.ts`, `src/data/dexie/DexieNovelRepository.ts`, `src/data/dexie/DexieNovelRepository.test.ts`
      Verify: `npx vitest --run src/data` 通过。现有的「当前架构版本为 4」改为 5。新增测试覆盖：- v4 → v5 章节迁移：用只声明到 v4 的原生 `Dexie` 写入旧章节，关库后用 `AppDatabase` 重新打开，断言 `sideStoryId === null`。- 外传增删改：标题归一化；重名被拒（含只差大小写、只差「外传·」前缀）；只改大小写不算重名；`order` / `novelId` 被剥掉；删除时级联删除章节和摘要，主线不受影响；删除是幂等的。- `createChapter`：按线编号；外传不存在时拒绝；外传章节关联大纲时拒绝。- `updateChapter`：剥掉 `sideStoryId`；外传章节设 `outlineNodeId` 被拒。- `getSideStory`：返回最新值，不存在时为 `undefined`。- `computeStats`。- `deleteNovel`、快照（replace / merge）都包含外传。
      之后跑 build 和全量测试。

- [ ] 3. 备份 v2（3.5）。
      `BACKUP_VERSION = 2`。`parseBackup` 先用 `z.object({ app, version }).passthrough()` 检查文件头，再比较版本（`version > 2` 时抛「来自更新版本」），最后才做整份 `BackupFileSchema.safeParse`。`summarizeBackup` 不改（设计没要求）。
      Files: `src/features/export/backup.ts`, `src/features/export/backup.test.ts`
      Verify: `npx vitest --run src/features/export` 通过。新增断言：`BACKUP_VERSION === 2`；v1 文件能恢复且全部是主线；外传往返完整；`version: 3` 的文件**即使 data 里有未知的枚举值**，报的也是「来自更新版本」。之后跑 build 和全量测试。

- [ ] 4. 外传进展提案的落库（5.3 末尾）。
      `schema.ts` 的 `ProposalTargetSchema` 加 `'sideStory'`。`fields.ts` 的 `fieldSpecsFor('sideStory')` 返回 `[{ path: 'rollingSummary', label: '外传进展摘要', kind: 'longtext' }]`。`apply.ts` 新增 `sideStory:create|merge|replace` 三个分支：用 `SideStoryPayload = z.object({ rollingSummary: z.string().optional() })` 校验，再调用 `updateSideStory`；外传不存在时抛「这部外传已不存在，可能已被删除」。`chapter:create` 的 `ChapterPayload` **不加** `sideStoryId`。
      Files: `src/domain/schema.ts`, `src/proposal/fields.ts`, `src/proposal/apply.ts`, `src/proposal/apply.test.ts`, `src/proposal/fields.test.ts`
      Verify: `npx vitest --run src/proposal` 通过。新增断言：`sideStory:replace` 更新外传进展；外传不存在时进入 `acceptProposals` 的 `failed`，提案保持待确认；`fieldSpecsFor('sideStory')` 返回上面的规格。之后跑 build 和全量测试。

## 阶段 B：导入的底层能力，纯增量，不接 UI（FEAT-002）

- [ ] 5. LLM 回传结束原因（4.9）。
      `ChatResult` 增加必填字段 `finishReason: string | null`，注释按 4.9 写。`OpenAiCompatibleClient`：- 流式：每一帧读 `chunk.choices?.[0]?.finish_reason`，**非空才覆盖**。- 非流式：取 `body.choices` 最后一项的 `finish_reason ?? null`。
      Files: `src/llm/types.ts`, `src/llm/OpenAiCompatibleClient.ts`, `src/llm/OpenAiCompatibleClient.test.ts`
      Verify: `npx vitest --run src/llm` 通过。新增断言：- 流式：带 choice 的最后一帧是 `'length'`、其后再来一帧只带 `usage` 时，结果为 `'length'`；`'stop'` 时为 `'stop'`；整条流都不带时为 `null`。- 非流式：取最后一个 choice 的值，缺失时为 `null`。
      之后跑 build 和全量测试。

- [ ] 6. 导入用到的纯函数。- `translate.ts`：`export const TRANSLATE_SOFT_LIMIT = 6000`。- `worldview.ts`：`packWorldviewChunks(drafts, max)`，规则按 4.5：长度按拼接后的最终文本计算；超长章的正文不带标题行，标题记为「{章标题}（i/k）」；章标题为空时不造标题；空章跳过；`index` 从 1 起连续，`status: 'pending'`，`error: ''`。返回类型是 `ImportWorldviewChunk[]`，所以本项先在 `schema.ts` 的 `ImportWorldviewChunkSchema` 里加 `title: z.string().default('')`。这是纯增量，旧界面不受影响。- `extractSettings.ts`：`buildExtractUserPrompt` 新增可选参数 `sideStory?: { title; synopsis }`，按 5.7 插入说明，简介的处理复用 `renderSideStoryBrief` 的规则，进展块标题改为「此前的外传进展摘要」。不传 `sideStory` 时输出逐字节不变。
      Files: `src/domain/schema.ts`, `src/features/writing/translate.ts`, `src/features/import/worldview.ts`, `src/features/import/worldview.test.ts`, `src/features/import/extractSettings.ts`, `src/features/import/extractSettings.test.ts`
      Verify: `npx vitest --run src/features/import/worldview.test.ts src/features/import/extractSettings.test.ts` 通过。新增断言覆盖第 11 节 `import/worldview.test.ts` 的两组，以及 extractSettings 的外传说明（简介为空时没有空括号）；原有断言不改。之后跑 build 和全量测试。

- [ ] 7. ImportJob 的新字段和两个纯函数。
      `schema.ts` 新增 `ImportDraftSchema`、`ImportDestinationSchema`（3.2）。`ImportJobSchema` **增加** `destination: ImportDestinationSchema.nullable().default(null)` 和 `drafts: z.array(ImportDraftSchema).default([])`（chunk 的 `title` 已在第 6 项加好）。本项**保留** `importType` / `worldviewText` / `ImportTypeSchema`，preprocess 也先不接，两者都放到第 9 项。
      新文件 `src/domain/importJob.ts` 实现 `upgradeLegacyImportJob(raw: unknown): unknown`，按 3.3 写成全函数：不抛错；不修改入参；每个分支都补齐五个数组键；删除 `importType` / `worldviewText`；不调用 Zod。
      新文件 `src/features/import/importFlow.ts` 实现 `resumeStepOf(job): ResumeResult`，按 4.6 的表格和 `bad` 判定。`Step` 类型从 `ImportScreen.tsx` 挪到这里并导出，加上 `'destination'`；ImportScreen 改为 import 这个类型。
      Files: `src/domain/schema.ts`, `src/domain/importJob.ts`（新）, `src/domain/importJob.test.ts`（新）, `src/features/import/importFlow.ts`（新）, `src/features/import/importFlow.test.ts`（新）, `src/features/import/ImportScreen.tsx`（只改 `Step` 的 import）
      Verify: `npx vitest --run src/domain/importJob.test.ts src/features/import/importFlow.test.ts` 通过，覆盖第 11 节 `domain/importJob.test.ts` 的三组，以及 `importFlow.test.ts` 的六种返回和八种 `notice` 组合。现有的 ImportScreen 测试仍然全过。之后跑 build 和全量测试。

- [ ] 8. 仓储里四个导入阶段的写入方法（4.4）。
      在 `NovelRepository` 和 `DexieNovelRepository` 里实现 `saveImportDrafts`（带 `expectedJobId`）、`patchImportDrafts`、`commitImportChapters`、`commitImportWorldview`。四个方法都在 rw 事务里「读 → 检查 → 写」，写入前过 `ImportJobSchema.parse`，检查顺序和中文错误文案逐字照 4.4。各自的要点：- 事务范围：`commitImportChapters` 锁 `importJobs, chapters, sideStories, chapterSummaries, novels`；其余三个只锁 `importJobs`。- `patchImportDrafts`：任务不存在或不在草稿阶段时**不新建行**；`done` 的草稿对它只读（忽略 patch，不抛错）；找不到 index 时整批回滚。- `commitImportChapters`：编号、链初值（rollingSummary 和本线最后一份摘要的伏笔）、`job.chapters` 的映射，都按 4.4 第 3–5 步。
      本项的新任务里 `importType` 保持默认值，不影响旧界面。
      Files: `src/data/NovelRepository.ts`, `src/data/dexie/DexieNovelRepository.ts`, `src/data/dexie/DexieNovelRepository.test.ts`
      Verify: `npx vitest --run src/data` 通过，覆盖第 11 节仓储清单里的 `saveImportDrafts`、`patchImportDrafts`、`commitImportWorldview`、`commitImportChapters` 全部用例（含原子性、二次调用被拒、parse 失败的行直接覆盖）。之后跑 build 和全量测试。

## 阶段 C：导入流程重写（FEAT-003）

- [ ] 9. 删除旧字段，接上换算，重写导入面板。三件事必须放在同一项里，否则编译不过。- **schema**：删除 `ImportTypeSchema`、`importType`、`worldviewText`。`ImportJobObjectSchema` 是原来的 object，`ImportJobSchema = z.preprocess(upgradeLegacyImportJob, ImportJobObjectSchema)`，`ImportJob = z.infer<typeof ImportJobSchema>`。- **db.ts**：在第 2 项的 v5 upgrade 里加 importJobs 的 `modify`，逐行 `try/catch`，内容按 3.3 的代码块。- **DestinationPicker**：新文件 `src/features/import/DestinationPicker.tsx`，受控组件，按 4.2 实现。- **ImportScreen 重写**，内容如下：- 步骤机加上 `destination`；粘贴步骤去掉 `SegmentedControl`、世界观提示和外文提示；文风勾选框挪进 picker。- 草稿流程：`createDraftJob` 调 `saveImportDrafts`；分章页的主按钮按 4.1 的两步调用。- 翻译：只读写 `job.drafts`，全部写入走 `patchImportDrafts`。被拒时静默停下，再重读任务、重定步骤。每章新建一个 `AbortController`，卸载时 abort。检查 `finishReason === 'length'`。先落盘、后合并译名。续跑时恢复 `previousTailRef`。- `goToDestination`：一次调用传多条 patch，把 `pending` / `failed` 改成 `none`。- 分章页对外文草稿 `content.length > TRANSLATE_SOFT_LIMIT` 的章节显示 `role="note"`。- 提交：`commitImportChapters` / `commitImportWorldview` 被拒后重读任务；仍在草稿阶段时重新加载 `listChapters` + `listSideStories`、重算 `lineCounts`，必要时 picker 回退到「新建外传」（第 9 节）。- 加载：`safeParse` + `resumeStepOf`；`silent` / `notice` 的处理和旧任务说明按 4.6。- 分支依据从 `importType` 改为 `destination.kind`。- 世界观：`sourceLabel` 改用 `chunk.title`（4.5）。- 外传：`sideStoryRef` / `activeSideStory` / `rememberSideStory`；`extractOne` 每章开头 `getSideStory`，读不到就 **throw**。`rollingSummary` 回退改为 `?? ''`。摘要标签、`setNote` 和 `formatSourceRef` 都用 `chapterLabel`（`formatSourceRef` 接受可选前缀）。- `finalize`：外传出 `sideStory` 提案，不出 `novel` 提案；产出 `FinishedDestination`（带 `count`）。- `continueImport`：用 `count`，并按 4.8 预选上一批的目的地。- 垃圾桶在 translate / destination / extract 三个步骤都显示，确认框文案按 4.7。- **测试**：同时把 `ImportScreen.test.tsx` 的既有用例改写到新流程。新增辅助函数 `confirmSplit(destination)`；「确认并写入 N 章」改成「写入主线 N 章」；10 个世界观用例改成在分章页选「仅作为世界观设定」；编号提示的断言挪到 picker；删掉「外文暂不支持翻译」。`importEntry.test.tsx` 只改按钮文案。
      Files: `src/domain/schema.ts`, `src/data/dexie/db.ts`, `src/data/dexie/DexieNovelRepository.test.ts`（迁移用例）, `src/features/import/DestinationPicker.tsx`（新）, `src/features/import/ImportScreen.tsx`, `src/features/import/ImportScreen.test.tsx`, `src/features/import/importEntry.test.tsx`
      Verify: `npm run build` 通过；`npx vitest --run src/features/import src/data` 通过。仓储测试新增一条 v4 → v5 迁移用例：写入三种旧任务行，外加一条字段缺失的行（没有 `importType`、没有 `worldviewChunks`、`chapters` 不是数组），断言库能打开、换算正确、作品和章节都读得到。之后跑全量测试。

- [ ] 10. 补齐导入界面的新测试。
      按第 11 节「新增或改写：导入界面」逐条补齐 `ImportScreen.test.tsx`，每条都要有：- 纯中文稿和外文稿的流程，包括截断用例和超长提示。- 旧实例迟到写回、卸载时 abort。- 跨标签页提交和放弃、另一处已有草稿。- 提交失败与幂等、纯中文稿第二步失败后落到目的地步骤。- 不合阶段表的行；**用 `harness.database.importJobs.put()` 直接写入**的原始旧行不白屏。- 外文稿选世界观；世界观打包后的请求次数。- 外传：新建后直接提取、提取途中改简介或删除外传时循环停下、恢复 `side` 任务、只出 `sideStory` 提案、文风默认不勾、第二批从 k+1 接续、预选回退。- 翻译续跑带上一章译文结尾；picker 校验；放弃时的文案。- 三种旧任务；上一批 N 章的计数。- 世界观标签的三种情况。
      本项发现实现有问题时，回到第 9 项的文件里修。
      Files: `src/features/import/ImportScreen.test.tsx`（必要时 `src/features/import/ImportScreen.tsx` / `DestinationPicker.tsx`）
      Verify: `npx vitest --run src/features/import` 通过；之后跑 build 和全量测试。

## 阶段 D：外传在写作、上下文、摘要、导出、书架里的行为（FEAT-004）

- [ ] 11. 上下文构建（5.2）。
      `ContextRequest` 加 `sideStories?` 和 `includeMainProgress?`，`ContextItemKind` 加 `'sideStory'`。`SummaryChainContextBuilder.build` 的第一步按 `track` 用 `chaptersOfTrack` 过滤章节，之后：- 外传说明块（`renderSideStoryBrief`）是必收项，放在易变后缀。- 外传进展 `rolling-side`；`includeMainProgress` 打开时注入主线进展 `rolling-main`。- 外传的摘要和结尾用 5.2 表里的标签。- 默认预选的推断来源用外传简介。- 找不到这部外传时，仍按 track 退化（不拿主线进展顶替）。
      主线输出逐字节不变。
      Files: `src/context/ContextBuilder.ts`, `src/context/SummaryChainContextBuilder.ts`, `src/context/SummaryChainContextBuilder.test.ts`
      Verify: `npx vitest --run src/context` 通过，覆盖第 11 节该文件的全部断言（包括主线和外传的 `stablePrefix` 相同）。之后跑 build 和全量测试。

- [ ] 12. 摘要链（5.3）。- `previousSummaryOf` 先过一遍 `chaptersOfTrack`。- `buildSummaryUserPrompt` 新增可选参数 `sideStory`；系统提示不变。- `ChapterSummarySheet` 新增只用于展示的 `sideStory?` 属性。分支依据是 `data.chapter.sideStoryId`。`generateRef` 内部在 `runStructured` 之前 `await getSideStory`；读不到时进入错误态，不发请求。第二条提案改为 `target: 'sideStory'`。
      Files: `src/features/writing/chapterSummary.ts`, `src/features/writing/chapterSummary.test.ts`, `src/features/writing/ChapterSummarySheet.tsx`, `src/features/writing/ChapterSummarySheet.test.tsx`
      Verify: `npx vitest --run src/features/writing/chapterSummary.test.ts src/features/writing/ChapterSummarySheet.test.tsx` 通过，覆盖第 11 节这两个文件的断言（包括 autoStart 读到库里的新值、不传 `sideStory` 属性时也没有 `novel` 提案）。之后跑 build 和全量测试。

- [ ] 13. 写作页、编辑器和译名表（5.4、5.5）。- 新组件 `ChapterListItem.tsx`，从 WritingPage 抽出章节列表项。- 新组件 `SideStorySheet.tsx`：新建和编辑两种模式，删除走 `ConfirmDialog`。- `WritingPage`：查询加 `listSideStories`；「全书进度」和主线列表只算主线；新增「外传」区块，始终渲染；导出按钮按全量章节显示；按 `sideStoryId` 把 `sideStory` 和 `sideStories` 传给编辑器，查不到时关闭编辑器。- `ChapterEditorScreen` 加 `sideStory?` 属性，标签、aria-label、删除文案都用 `chapterLabel`，并把 `sideStory` 传给摘要面板。- `GenerateChapterSheet` 加「参考主线进展」Toggle，只在外传章节、且 `Novel.rollingSummary` 非空时显示，默认关。`ReviseSheet` 不显示这个开关。- `GlossarySheet` 删掉本地的 `chapterLabel`，改用 domain 里的，并加上 `listSideStories`。
      Files: `src/features/writing/WritingPage.tsx`, `src/features/writing/ChapterListItem.tsx`（新）, `src/features/writing/SideStorySheet.tsx`（新）, `src/features/writing/ChapterEditorScreen.tsx`, `src/features/writing/GenerateChapterSheet.tsx`, `src/features/writing/GlossarySheet.tsx`，以及测试 `WritingPage.test.tsx`、`ChapterEditor.test.tsx`、`GlossarySheet.test.tsx`、`glossaryJump.test.tsx`
      Verify: `npx vitest --run src/features/writing` 通过，覆盖第 11 节 WritingPage / ChapterEditor / GlossarySheet / glossaryJump 的新增用例。之后跑 build 和全量测试。

- [ ] 14. 导出和书架（5.5、5.6）。- `exportText`：`formatNovel` 先过一遍 `chaptersOfTrack(..., null)`，加 `options.sideStories`；新增 `formatSideStory`；`chapterHeading(chapter, sideStory?)`；`exportFileName` 加外传 scope，chapter scope 加可选 `sideStory`。- `ExportSheet`：加 `sideStories` 属性；范围多一个「外传」；全书范围加「附带外传」开关；单章下拉框按线分组；只有外传的作品，打开时默认范围是「外传」。- `WritingPage`：把 `sideStories` 传给 ExportSheet。- `ShelfPage`：有外传时追加「· 外传 K 章」。
      Files: `src/features/export/exportText.ts`, `src/features/export/exportText.test.ts`, `src/features/export/ExportSheet.tsx`, `src/features/export/ExportSheet.test.tsx`, `src/features/writing/WritingPage.tsx`, `src/features/shelf/ShelfPage.tsx`, `src/features/shelf/ShelfPage.test.tsx`
      Verify: `npx vitest --run src/features/export src/features/shelf` 通过，主线导出逐字节不变（原有断言不改）。之后跑 build 和全量测试。

## 阶段 E：文档（FEAT-005）

- [ ] 15. 同步文档（第 10 节最后一行）。- `docs/产品文档.md` 6.3 / 6.5 / 6.7 / 8.2。- `docs/使用说明.md` 第 3 / 6 / 8 节。- `docs/设计方案.md` 第 7 节：删掉「为什么世界观导入暂不翻译」，改写成「为什么目的地要在翻译之后选」。- `docs/开发计划.md` 末尾、「阶段二 / 三」之前追加一条「增量：导入目的地后置与外传」，格式仿照「增量：从旧稿自动归纳文风」（改动表 + 关键决定 + 验证数字），测试总数写实际跑出的数字。
      Files: 上述四个文档
      Verify: `npm run build` 和 `npx vitest --run` 仍然全绿（文档不影响构建，跑一遍是为了确认最终状态，并取得要写进文档的测试数字）。

---

## 假设与说明

- 第 9 项是全计划最大的一项。它拆不开：删掉 `importType` 的同时，旧界面就编译不过了。为了把单项控制住，界面的大部分新测试都放在第 10 项。
- 验收标准第 20 条要求 1023 个既有测试「改写之后」全部通过。被删掉的用例只有「外文暂不支持翻译」一条，有新用例替代，所以最终的测试数会比 1023 多。
