# 设计评审（第 3 轮）：导入目的地后置 + 外传

评审对象：`.agents/tasks/import-destination-sidestory/design.md`（含第 13、14 节对前两轮的回应）
对照材料：`docs/产品文档.md` 6.5 / 6.7；`src/domain/schema.ts`、`src/data/dexie/{db.ts,DexieNovelRepository.ts}`、`src/data/NovelRepository.ts`、`src/features/import/{ImportScreen.tsx,splitChapters.ts,worldview.ts,extractSettings.ts}`、`src/context/{ContextBuilder.ts,SummaryChainContextBuilder.ts}`、`src/features/writing/{WritingPage,ChapterEditorScreen,ChapterSummarySheet,GenerateChapterSheet}.tsx`、`chapterSummary.ts`、`translate.ts`、`src/features/export/{exportText.ts,backup.ts}`、`src/proposal/{apply.ts,fields.ts}`、`src/llm/{taskProfiles.ts,types.ts,sse.ts,OpenAiCompatibleClient.ts}`。另外跑了 `npx vitest --run`：49 个文件、1023 个测试全部通过。

**判定：CHANGES_REQUESTED**（HIGH 0，MEDIUM 2，NIT 6）

第 2 轮的 8 条都已落实到正文，逐条核对无误。五个重点项的结论：

- (1) 世界观路径不写 Chapter：成立。草稿、翻译、`commitImportWorldview`（事务只开 `importJobs`）、提取、收尾都不碰 `chapters`；`commitImportChapters` 的目标类型里没有 worldview。
- (2) 译文存进 ImportJob、刷新不丢、旧 job 兼容：迁移和加载两道防线写得具体，旧格式三种任务的去向都说清了。但还有两处会让付过钱的译文丢掉或被截断（发现 1、2）。
- (3) 外传数据模型、Dexie v5、`sideStoryId` 索引、旧数据和旧备份默认主线：成立，规则具体，superRefine 和仓储不变量一致。
- (4) 「不计入主线」：仓储编号、摘要链、伏笔、`rollingSummary`、上下文注入、全书进度、导出、书架章数都有着落，分支依据都是章节数据而不是组件属性。
- (5) 开放问题 a–f、多部具名外传（6.1）、大纲关系（6.7）、逐章混选（6.8）：都给了明确推荐和理由，没有静默略过。

阻塞项：

- 翻译循环仍然通过 `persistJob` 把**整个** `drafts` 数组写回去。旧实例（面板关掉后还在跑的那一章）用过期的 `jobRef` 写回时，会覆盖掉更新的译文，或者给已提交的任务重新塞回 `drafts`。
- 很长的单篇外文稿（世界观文档常常没有章节标题，会切成一章）会在一次翻译调用里被截断，而且被当成「已译」。世界观提交后原文就没了。

---

## 发现

### 1. [MEDIUM] 翻译相关写入用过期的整份 `drafts` 覆盖库里的行：付过钱的译文会被冲掉，已提交的任务会违反阶段表

**位置**：3.2「其他写入点……都不碰它们：翻译循环只改 `drafts[i]`」；4.3「翻译一章：先 `persistJob` 写回该草稿」、「勾选 / 重试」、「跳过剩下的 `goToDestination()`」；4.6「不合表格的组合只会来自卸载竞态……最坏情况是用户要对这一批重新提取」。

**问题**：

- `persistJob` 走的是 `upsertImportJob`：先读当前行，再写 `{...current, ...patch}`，读和写不在同一个事务里，库里没有行时还会**新建**一行（`DexieNovelRepository.ts` `upsertImportJob`）。翻译循环传的 patch 是 `drafts: jobRef.current.drafts.map(...)`，也就是整份数组，数组内容来自这个组件实例自己的 `jobRef`。
- 卸载不会中止正在进行的那一章：`translateOne` 不传 `signal`（`ImportScreen.tsx` 里没有任何 `signal`），卸载只设了 `stopRef`。这一章流式译完后照样执行 `persistJob`，中间没有 `aliveRef` 检查。翻译一章要一分钟左右，「翻到一半关掉面板，又马上打开」是很常见的操作。旧实例这次写回会出现三种后果：
  - (a) 新实例在这一分钟里又译完了别的章节，旧实例把它们**改回 `pending` 和原文**。这是 FR-1.4「已经付钱的译文不丢」最直接的反例，问题是这次设计引入的：以前译文写在 Chapter 上，任务只记状态，状态被冲掉不会丢文字。
  - (b) 新实例已经提交了目的地（`drafts: []`，`destination: main`），旧实例把非空的 `drafts` 写了回去。下次加载时 `resumeStepOf` 判成 `notice`，任务被删，提取进度和累计的 `entryDrafts`（都是付过钱的）一起丢掉。
  - (c) 用户在新实例里点了「放弃」，旧实例的写入又凭空新建了一个只有 `drafts` 的任务，下次打开面板会落在目的地步骤。
- 4.6 的兜底说法也不对：「最坏情况是用户要对这一批重新提取」，但应用里没有「对已有章节重新提取」的入口，重新导入只会再写一遍重复的章节。
- 跨标签页同理。3.2 / 7 节说阶段表「只有三个仓储方法会改数组长度」，这个说法依赖一个不成立的前提：调用方传进来的数组和库里的一致。

**修复**：翻译阶段的所有写入都改成**按章、在事务里合并到库里最新那一行**，不再传整份数组。

```ts
/** 草稿阶段的逐章修改。只开 importJobs 的 rw 事务 */
patchImportDrafts(
  novelId: string,
  patches: { index: number; patch: Partial<Pick<ImportDraft,
    'content' | 'sourceContent' | 'sourceLanguage' | 'translateStatus' | 'translateError'>> }[],
): Promise<ImportJob>;
```

规则：

- 任务不存在、`ImportJobSchema.safeParse` 失败，或者 `destination !== null` 时抛错「这批稿件已经不在翻译阶段了」，什么都不写，**不新建行**。
- 按 `index` 定位到**库里当前的** `drafts[i]`，再把 patch 合并进去；找不到这个 index 时抛错。
- 库里那一章已经是 `translateStatus: 'done'` 时，忽略任何把它改成 `pending` / `none` / `failed` 或改写 `content` 的 patch。这样「已译的不允许改」也在存储层成立，不再只靠界面上的 disabled。
- 写入前整行过 `ImportJobSchema.parse`，返回值用来写 `jobRef` / `job`。
- `translateOne`、`markTranslate`、`toggleTranslate`、`retryTranslate`、`goToDestination` 都改用这个方法（`goToDestination` 一次传多条 patch）。翻译循环遇到这个错误时静默停下，然后 `getImportJob` 重读一次并按 4.6 的规则重新定步骤，不显示 alert。
- 卸载时另外 `abort()` 进行中的翻译请求（`runStream` 传一个 `AbortController.signal`），少付一章的钱。这一条是锦上添花，不是必需。
- 4.6 删掉「最坏情况是用户要对这一批重新提取」，改成如实描述：任务被清掉后已写入的章节保留，但这一批的条目与摘要要靠重新导入或手动整理。
- 测试（`DexieNovelRepository.test.ts`、`ImportScreen.test.tsx`）：
  - `destination` 为 main 时调用 `patchImportDrafts` 被拒，任务不变。
  - 没有任务时调用被拒，也不新建行。
  - 对 `done` 草稿传 `translateStatus: 'pending'` 被忽略。
  - 两次调用各改不同的 index，两处结果都保留。
  - 翻译中卸载 → 重开 → 在新实例里译完第 2 章，然后让旧实例的第 1 章再完成：断言第 2 章的译文仍在。

### 2. [MEDIUM] 长篇单章的翻译会被输出上限截断，截断后还被标成「已译」；世界观提交后原文不留，等于静默丢内容

**位置**：FR-1.6；4.3「翻译一章」；4.5「原来的『整篇粘贴』场景……会退化成一章超长、按段落切」（这里只考虑了提取，没考虑翻译）。

**问题**：

- `splitChapters` 在找不到章节标题时返回整篇一章（`splitChapters.ts` 93、96 行）。外文世界观文档、人物小传通常没有「Chapter N」这种标题，所以实际上就是一份几万字的草稿。
- 翻译按草稿一章一次调用。`translate-chapter` 这个任务配置不设 `max_tokens`（`taskProfiles.ts`、`OpenAiCompatibleClient.ts` 170 行），输出量受服务商默认上限约束；`ChatResult` 也不带 `finish_reason`（`types.ts` 31 行，`sse.ts` 解析得到但没有往上传）。`parseTranslation` 拿到半截译文，照样标成 `done`。
- 后果：
  - 世界观目的地：`commitImportWorldview` 把 `drafts` 清空，原文就此消失。提取只看得到前一小段译文，后面的设定全丢了，界面上看起来却是成功的。
  - 章节目的地：原文还在 `sourceContent`，可以回头重译，但正文同样被截断了，而且没有任何提示。
- 用户这一轮明确要求「世界观需要翻译」，长文档恰好是世界观素材的典型形态。4.5 为提取做了「超长再切」，翻译这一侧却没有对应的处理。

**修复**：从下面两种里选一种写进设计。推荐 A，它改动最小，主线章节也能受益。

- **A（推荐）：截断检测，加上分章页提示。**
  - `ChatResult` 增加 `finishReason: string | null`，流式和非流式都从最后一个 choice 里取。
  - `translateOne` 里 `finishReason === 'length'` 时抛出 `new LlmError('parse', '译文超出单次输出上限被截断了', '这一章太长，回到分章页把它切小一些再译')`，按现有逻辑标成 `failed`，不写进草稿。
  - 分章页：外文草稿超过 `TRANSLATE_SOFT_LIMIT = 6000` 字时，在这一章旁边显示 `role="note"`「这一章较长，单次翻译可能被截断，建议换一种分章方式或用自定义正则切小」。
  - 测试：mock 的流最后一帧 `finish_reason: 'length'` 时，这一章变成 `failed`，`drafts[i].content` 还是原文。
- B：超过 6000 字的草稿用 `splitWorldviewText` 切段后逐段翻译，`ImportDraft` 增加 `translatedParts: string[]` 按段落盘，全部译完再拼成 `content`。这样更彻底，但要改草稿模型、续跑逻辑和测试，工作量明显更大。

两种方案都要在 4.3 的表格和第 9 节的「翻译一章」那一行写上截断这种失败情形。

### 3. [NIT] 提取途中外传被删时「失败即停」的说法和实际控制流不符

**位置**：4.4「读到 `undefined` 时 `markChapter(...)` 并返回，不发请求」；第 9 节「循环按现有『失败即停』停下」。

**问题**：现有 `runLoop` 只在 `extractOne` **抛错**时才停（`ImportScreen.tsx` 848–866 行）。`markChapter` 加 `return` 是正常返回，循环会接着处理下一章，于是每一章都被静默标成失败。界面不显示 alert，章节列表也只显示「重试」按钮，不显示错误内容，用户看到一整排失败却不知道原因。

**修复**：外传读不到时 `throw new Error('这部外传已不存在，可能已被删除')`，由 `runLoop` 的 catch 统一做 `markChapter('failed')`、`setError` 和停下。第 9 节那一行保持不变。

### 4. [NIT] 提交因「所选外传已不存在」被拒后，picker 里仍然列着那部外传

**位置**：4.2「重新加载 `listChapters` + `listSideStories` 的时机只有两个」；第 9 节 `commitImportChapters` 被拒且 `destination` 仍为 null 时「留在当前步骤显示 alert」。

**修复**：在第 9 节写明：reject 之后重读任务，`destination` 仍为 null 时，再重新加载一次 `listChapters` + `listSideStories` 并重算 `lineCounts`。原先选中的 `sideStoryId` 已经不在列表里时，picker 回退到「新建外传」，名称留空，规则与 4.8 一致。

### 5. [NIT] `packWorldviewChunks` 切超长章时，切出的每段要不要带标题行没写，测试描述也和打包规则对不上

**位置**：4.5「单章判超长时同样计入它自己的标题行」；11 节「拼接后去掉空白，内容与原文一致」。

**问题**：普通段会往正文里补标题行，所以「拼接后与原文一致」这条断言对普通段不成立。超长章切出的各段正文里要不要补「{章标题}」，文中也没说。

**修复**：

- 写明超长章切出的各段**正文里不带标题行**。标题只放在 `chunk.title` 里，经由 `sourceLabel` 进 prompt；判断是否超长时仍然把标题行算进去。
- 测试改成：「把所有段的 `content` 拼起来，去掉补入的标题行和空白之后，与各草稿 `content` 依次拼接、去掉空白的结果一致」。

### 6. [NIT] `saveImportDrafts` 在 `destination === null` 时无条件覆盖，可能悄悄冲掉另一处已译好的草稿

**位置**：4.3「库里没有任务、或任务的 `destination` 为 null 时可以重复调用（覆盖草稿）」。

**问题**：两种情况会冲掉已译草稿：标签页 A 正在翻译（`destination` 为 null），标签页 B 从分章页提交了新草稿；或者面板加载时 `getImportJob` 失败，界面留在粘贴步骤。这两种情况都会整行覆盖掉 A 已经付费译好的草稿，而且没有任何提示。

**修复**：签名加上乐观并发检查：

```ts
saveImportDrafts(novelId, input: { batchId: string; drafts: ImportDraft[]; expectedJobId: string | null })
```

- 库里的行 parse 成功、而且 `id !== expectedJobId` 时，抛错「另一处已经有一批稿件在处理中」。
- 分章页传 `jobRef.current?.id ?? null`。纯中文稿提交失败后重试时，传的就是自己那一行的 id，可以照常覆盖。
- parse 失败的残留行仍然按现在的规则直接覆盖。
- 界面处理和第 9 节「已有 `destination !== null` 的任务」那一行相同：重读任务，按 4.6 重新定步骤，再显示那条 note。

### 7. [NIT] 「上一批 N 章」的 N 从哪里来没写；按现有代码，刷新续跑后 N 为 0

**位置**：4.8 外传提示文案「上一批 N 章外传·X」；现有 `continueImport()` 用的是 `setLastRound(drafts.length)`，`drafts` 是分章页的本地 state，刷新后恢复的任务里它是 `[]`。

**修复**：`FinishedDestination` 的 main / side 两支加一个 `count: number`，在 `finalize` 里取 `current.chapters.length`。`continueImport` 用 `finishedDestination.count` 代替 `drafts.length`。

### 8. [NIT] `AppDatabase` 的表声明没列出来

**位置**：3.3 只给了 `version(5).stores(...)`。

**修复**：在 `db.ts` 的类上补 `sideStories!: Table<SideStory, string>;`，并在 v5 的注释里写清两件事：为什么加这张表，以及为什么 `sideStoryId` 要建索引（3.3 已有的理由直接搬过来即可）。

---

## 已核实的假设

- Dexie 当前是 v4，`chapters` 的 `[novelId+index]` 不是唯一索引，代码里也没有任何地方按这个复合索引查询，主线和外传编号重复不冲突。
- 读取路径不做 parse：`getImportJob`、`getChapter` 直接返回原始行。`upsertImportJob` 是 `ImportJobSchema.parse({...current, ...patch})`，读写不在同一个事务里，没有行时会新建（这是发现 1 的依据）。
- `splitChapters` 找不到标题时返回整篇一章，`removeChapter` / `mergeWithPrevious` 之后会重新编号，所以 `draft.index` 一定是 1..N 连续的，`起点 + draft.index` 的编号成立。
- `ImportScreen` 现状和设计描述一致：
  - `translateOne` 是先 `mergeGlossaryTerms`、后 `persistJob`，`previousTailRef` 刷新后会丢。
  - 「跳过剩下的」在 `running` 时不渲染，垃圾桶只在 `extract` 步骤显示。
  - `extractOne` 里有 `current?.rollingSummary ?? novel.rollingSummary`。
  - `createChaptersAndJob` 逐章写入、最后才写任务，伏笔从 `[]` 起步。
  - `buildStyleProposal` 按 `job.chapters` 的 chapterId 取样。
  - 世界观标签是 `total > 1 ? '世界观设定 第 i/N 段' : '世界观设定'`。
  - 翻译请求不带 abort signal，卸载后仍会写回。
- `ImportScreen.test.tsx` 的「作为世界观设定导入」里正好 10 个用例。
- `SummaryChainContextBuilder` 是 Generate 和 Revise 的共同入口；`findPreviousChapter`、`pickRecentSummaries`、`computeDefaultEntryIds` 都只依赖传进来的 `chapters`，所以在入口处按线过滤一次就够。清单的 key 是 `${kind}-${id}`。
- `ChapterEditorScreen` 传给摘要面板的是 `{ ...chapter, content, title, status }`，带着 `sideStoryId`，所以「按 `data.chapter.sideStoryId` 分支」可行。面板在打开的 effect 里同步调用 `generateRef.current()`。
- `buildSummarySystemPrompt`、`buildExtractSystemPrompt`、`buildChapterSystemPrompt` 都不依赖章节或进展，外传特有的内容放进用户提示或易变后缀后，主线可以做到逐字节不变。
- `apply.ts` 的 switch 有 `never` 穷尽检查，`fieldSpecsFor` 也是 switch，加 `sideStory` target 时编译器会提醒。`ChapterPayload` 不含 `sideStoryId`。`NovelRepository` 只有 `DexieNovelRepository` 一个实现。
- `parseBackup` 现在是先整份 `safeParse`、后比版本，3.5 的描述准确。
- `chapterHeading` 在没有标题时退回「第 N 章」，`exportFileName` 只有 novel / chapter 两种 scope。
- WritingPage 的导出按钮条件是 `chapters.length > 0`，「已写」字数和章节列表都按全量算。`computeStats` 也按全量算。`PlanPage` 只读 dailyLogs。
- `GlossarySheet` 里有本地的 `chapterLabel(chapter: GlossaryDriftChapter)`。
- `src/` 里没有 ErrorBoundary，`componentDidCatch` 也没有。
- IndexedDB 的 null 不是合法键，不会为它建索引项，所以 `sideStoryId` 索引只收录外传章节。
- `translate-chapter` 任务不设 `max_tokens`，`ChatResult` 不带 `finish_reason`（这是发现 2 的依据）。
- `npx vitest --run`：49 个文件、1023 个测试全部通过。

## 未核实或有误的假设

- **有误**：3.2 / 7 节的前提是「翻译循环只改 `drafts[i]`，不改数组长度」。实际上传的是整份数组，内容来自本实例的 `jobRef`，旧实例写回时会改变长度、覆盖内容（发现 1）。
- **有误**：4.6 说「最坏情况是用户要对这一批重新提取」。应用里没有对已有章节重新提取的入口（发现 1）。
- **有误**：第 9 节说外传在提取途中被删时「循环按失败即停停下」。按 4.4 的写法（`markChapter` 后正常返回），循环不会停（发现 3）。
- **未考虑**：4.5 说整篇粘贴「和现在的行为一致」，这只对提取成立。新增的世界观翻译会把整篇放进一次调用，有截断风险（发现 2）。
- **未核实**：几 MB 的单行 `put` 加 Zod parse 在真实浏览器里的耗时。设计已经写明退路（独立的 `importDrafts` 表），不阻塞。
- **未核实**：外传摘要和提取只在用户提示里收窄范围，模型是否照做。这是对模型行为的推断，兜底是产出只是提案、`current` 对比可见。
- **未核实**：各服务商的默认输出上限具体是多少。截断风险的存在不依赖具体数值，只依赖「不设 `max_tokens`、也不检查 `finish_reason`」。
- **未核实**：开放问题 (a)–(f) 的原始清单。工作区里找不到最初列出 a–f 的文档，只能按设计自己的标注核对（a 多部外传、b 摘要、c 上下文、d 字数、e 导出、f 反向提取），每一项都有明确推荐和理由。
