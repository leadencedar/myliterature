# Implementation Plan：导入类型「作为世界观设定」重做

> 本文件取代旧计划。旧方案（index=-1 临时章节、finalize 删临时章节、加载时清理 index=-1 孤儿章节）已被否决，相关代码必须删除，不得沿用。

项目：/Users/leadencedar/Production/Project/MyLiterature（非 git 仓库，直接在原目录改）。
验证命令：`npm run build`（tsc --noEmit && vite build）与 `npx vitest --run`（现有约 1004 个测试必须全过）。

## 设计决策（已定，实现时不要再改）

1. **世界观模式不写任何 Chapter 记录。** 文本与进度全部存在 ImportJob 上。理由：临时章节会出现在章节列表、书架字数、备份里，中断留孤儿；且 ChapterSchema.index / ImportChapterStateSchema.index 都是 positive，-1 必抛 ZodError。
2. **Schema 扩展**（src/domain/schema.ts，ImportJobSchema 内，importType 保留）：
   - `worldviewText: z.string().default('')` —— 用户粘贴的完整设定文本（留作溯源/展示字数）。
   - `worldviewChunks: z.array(ImportWorldviewChunkSchema).default([])`，新增
     `ImportWorldviewChunkSchema = z.object({ index: z.number().int().positive(), content: z.string(), status: ImportChapterStatusSchema.default('pending'), error: z.string().default('') })`，并导出 `ImportWorldviewChunk` 类型。
   - 世界观 job 的 `chapters` 恒为 `[]`、`withSummaries: false`、`withStyle: false`。
   - 不加 worldviewSourceText（见决策 5，不做翻译）。
   - 旧 job 记录无新字段时走 default，向后兼容，无需 Dexie 版本升级（字段不建索引）。
3. **分段提取：做。** 新文件 `src/features/import/worldview.ts` 导出 `WORLDVIEW_CHUNK_SIZE = 6000` 与 `splitWorldviewText(text, max = WORLDVIEW_CHUNK_SIZE): string[]`：按空行切段落，贪心拼块不超过 max；单个段落超过 max 时按 max 硬切；去掉空白块；空文本返回 `[]`。理由：extract-settings 是 high reasoning 任务，几万字一次塞进去易超时、输出被截断，且一次失败就全部重花钱；分块后每块一次调用，进度（每块 status）存在 job.worldviewChunks 上，可暂停/重试/跨刷新续跑。块的文本在建任务时就固化进 job，续跑不依赖重新切分。
4. **extractSettings.ts 最小改动：**
   - `buildExtractUserPrompt` 的 `chapter` 参数类型放宽为 `Pick<Chapter, 'index' | 'title' | 'content'>`，新增可选 `sourceLabel?: string`。传了 sourceLabel 时正文块标题写成 `【设定文本（${sourceLabel}）】`，否则保持原 `【本章正文（第 N 章 …）】` 字节不变（章节模式 prompt 不变）。世界观调用传内存对象 `{ index: chunk.index, title: '', content: chunk.content }`，sourceLabel 为 `世界观设定 第 i/N 段`（只有 1 段时为 `世界观设定`），不落库。
   - `accumulateEntryDrafts` 的 `chapterId` 参数改为 `string | null`：null 时新建草稿 `sourceChapterIds: []`、合并时不追加。理由：sourceChapterIds 会随提案写进 KnowledgeEntry，伪造 id 会造成悬空引用。
   - EXTRACT_TASK / ExtractResultSchema 不改；世界观模式下模型返回的 summary / keyEvents / threads / rollingSummary 直接丢弃。
5. **翻译：世界观模式暂不支持。** 理由：现有翻译链路以 chapterId 为键（getChapter / updateChapter 写 sourceContent、逐章 translateStatus），改造成写回 job 文本等于再造一套翻译流程。替代：粘贴步骤选中世界观且 `needsTranslationToChinese(text)` 为真时，显示提示（role="note" 普通段落，非 alert）：「世界观设定导入暂不支持翻译，外文设定会直接按原文提取，条目名称可能是外文。需要中文条目的话，可以先作为章节导入完成翻译，或先自行译好再导入。」不阻止继续。世界观 prompt 不注入译名表（保持最小改动）。
6. **sourceRef：** `buildEntryProposal` 新增可选参数 `fallbackSourceRef?: string`；`formatSourceRef` 结果为空时用它。世界观 finalize 传 `'世界观设定导入'`，chapterIndexById 传空 Map，绝不会出现「第 -1 章」。
7. **只生成条目提案。** 世界观 finalize 不生成章节摘要、全书进展摘要、文风提案。
8. **断点续跑：** 加载 effect 中 `existing.importType === 'worldview'` → `setStep('extract')`（不看 translateStatus）。提取页根据 importType 显示「已提取 X / N 段」与「第 i 段」列表。
9. **inbox 文案用独立 state：** `const [finishedImportType, setFinishedImportType] = useState<ImportType>('chapter')`，finalize 在 `setJob(null)` 前 `setFinishedImportType(current.importType)`；inbox 文案与 continueImport 的「上一批」提示都读它。
10. **章节模式行为完全不变**：createChaptersAndJob、translate*、extractOne 的章节分支、buildStyleProposal 的章节逻辑都不动（只删掉其中旧的 worldview 分支）。

## 要删除的旧代码（ImportScreen.tsx）

- `createWorldviewImportJob()` 整个旧实现（调用 `repository.createChapter(novel.id, { index: -1 … })` 的那段）—— 由新实现替换。
- 加载 effect 中 `// 清理孤儿临时章节` 的 try 块（listChapters 过滤 `index === -1` 再 deleteChapter）。
- `finalize()` 开头 `// 世界观模式：清理临时章节` 的循环（`state.index === -1` → deleteChapter）。
- `extractOne` 里所有 `current?.importType === 'worldview'` / `latest?.importType !== 'worldview'` 三元与条件（恢复成纯章节文案；世界观不再走 extractOne）。
- `buildStyleProposal` 首行 `if (current.importType === 'worldview') return null;`（finalize 的世界观分支不调用它）。
- `finalize` 中 rollingSummary 条件里的 `current.importType !== 'worldview' &&`（世界观走独立分支）。
- inbox 中 `job?.importType === 'worldview'` 判断（改读 finishedImportType）。

## 步骤

- [x] 1. Schema 扩展 + 分段工具 + extractSettings 最小改动（纯函数层）。
      按决策 2 修改 ImportJobSchema 并新增 ImportWorldviewChunkSchema；新建 worldview.ts（决策 3）；按决策 4 修改 buildExtractUserPrompt 与 accumulateEntryDrafts。
      新增测试：`src/features/import/worldview.test.ts`（空文本→[]；短文本→1 块；多段落贪心合并不超过 max；超长单段硬切；块拼接后去空白等于原文去空白）；在 `extractSettings.test.ts` 增加：sourceLabel 时出现 `【设定文本（世界观设定）】` 且不含「本章正文」；不传时原有断言不变；`accumulateEntryDrafts(..., null)` 新建与合并都不产生 sourceChapterIds 条目。
      Files: src/domain/schema.ts, src/features/import/worldview.ts, src/features/import/worldview.test.ts, src/features/import/extractSettings.ts, src/features/import/extractSettings.test.ts
      Verify: `npx vitest --run src/features/import src/data` 全过；`npx tsc --noEmit` 通过。

- [x] 2. 重写 ImportScreen 世界观分支（依赖 1）。
      Files: src/features/import/ImportScreen.tsx
      a. 删除「要删除的旧代码」列出的全部内容。
      b. 新 `createWorldviewImportJob()`：`const chunks = splitWorldviewText(text)`；为空则 setError 返回；`persistJob({ batchId: newBatchId(), importType: 'worldview', worldviewText: text, worldviewChunks: chunks.map((content, i) => ({ index: i + 1, content, status: 'pending', error: '' })), chapters: [], entryDrafts: [], openThreads: [], rollingSummary: '', withSummaries: false, withStyle: false, status: 'paused' })`；`setStep('extract'); startLoop();`。不调用任何 createChapter。
      c. 新 `extractWorldviewChunk(chunk)`：listEntries → `findMentionedEntries(chunk.content, entries)` → `llm.runStructured('extract-settings', { schema: ExtractResultSchema, schemaName: 'ChapterExtraction', system: buildExtractSystemPrompt(novel, categories), user: buildExtractUserPrompt({ chapter: { index: chunk.index, title: '', content: chunk.content }, sourceLabel, mentionedEntries, categories, otherEntryNames, openThreads: [], rollingSummary: '' }), onAttempt })`；note 文案「正在从设定文本中提取第 i / N 段…」/「第 i 段的输出格式有偏差，正在请模型修正…」；然后 persistJob 更新该块 status=done 与 `entryDrafts: accumulateEntryDrafts(prev, result.data.entries, categories, null)`。不建摘要提案、不更新 openThreads/rollingSummary。新增 `markChunk(index, status, message)`。
      d. `runLoop`：按 `jobRef.current?.importType` 分支 —— worldview 时找 `worldviewChunks` 里第一个 pending 调 extractWorldviewChunk，失败 markChunk 并 setError(`第 ${i} 段提取失败：…`) 后 break；收尾判定「全部 done 且长度 > 0」用 worldviewChunks。章节分支逻辑原样保留。`retry` 增加 `retryChunk(index)`。
      e. `finalize()`：worldview 分支 —— 对 entryDrafts 调 buildEntryProposal（chapterIndexById 空 Map，order 从 0 起，`fallbackSourceRef: '世界观设定导入'`），createProposals，deleteImportJob，`setFinishedImportType('worldview')` 后 setJob(null) / setBatchId / setStep('inbox')；不生成 novel / styleProfile 提案。章节分支保持原逻辑并 `setFinishedImportType('chapter')`。给 buildEntryProposal 加 `fallbackSourceRef` 参数（决策 6）。
      f. 加载 effect：`existing.importType === 'worldview'` → `setStep('extract')`；否则原逻辑。
      g. 渲染：- 头部步骤条：`job?.importType === 'worldview' || (step === 'paste' && importType === 'worldview')` 时只显示 粘贴 › 提取 › 确认（不显示分章/翻译）。- 粘贴步骤：`existing.count > 0` 提示改为仅 `importType === 'chapter'` 时显示；世界观时显示「设定文本不会写成章节，只会提取成知识库条目，作为这本书的世界观参考。」；外文时显示决策 5 的提示；`lastRound` 提示按 finishedImportType 改写（世界观：「上一份设定已经处理完。接着导下一批吧 —— 已有设定会沿用，同名条目会走合并。」）。continueImport 中 `setLastRound(finishedImportType === 'worldview' ? 1 : drafts.length)` 保证提示出现。- 提取步骤：worldview 时用 worldviewChunks 计数，文案「已提取 X / N 段」「还有 N 段未提取」「跳过失败段落，直接整理提案」，列表项「第 i 段」+ 前 40 字预览，失败项「重试」按钮调 retryChunk。章节模式渲染不变。- inbox：`finishedImportType === 'worldview'` 时显示「提取完成。下面是从设定文本中读出的世界观与人物条目，确认后才会写入知识库，不会创建任何章节。已有同名条目的会显示字段级改动。」，否则原文案不变。- 放弃确认框 message：worldview 时改为「已经提取的进度会被清空，下次要重新粘贴设定文本。」
      Verify: `npx tsc --noEmit` 通过；`npx vitest --run src/features/import` 中原有章节模式测试全部通过。

- [x] 3. ImportScreen 世界观测试（依赖 2）。
      在 src/features/import/ImportScreen.test.tsx 新增 `describe('作为世界观设定导入', …)`，沿用 stubSequence / renderImport / harness。新增 helper `pasteWorldview(text)`：renderImport → 粘贴到「旧稿正文」→ 点 `screen.getByRole('button', { name: '作为世界观设定' })` → 点「开始提取设定」。用例：1. 提取完成生成条目提案：stub 返回含「世界观设定 · 灵潮」与「人物 · 裴照」的 ExtractResult；等待 `/提取完成/`；pending 提案只有 knowledgeEntry，label 含两条，action 为 create，batchId 一致，sourceRef 为「世界观设定导入」。2. 全程不写章节：在提取进行中（首个 fetch 用可控 Promise 挂起时）与完成后 `listChapters(novel.id)` 都为 `[]`；完成后 `getImportJob` 为 undefined。3. 无 chapterSummary / novel / styleProfile 提案（即使 stub 返回非空 summary 与 rollingSummary、文本足够长）；`novel.rollingSummary` 未变。4. inbox 显示世界观专属文案（`/从设定文本中读出/`）且不含「章节摘要」文案。5. 已有同名条目走 merge，接受后条目 `sourceChapterIds` 为空数组（不含伪造 id）。6. 长文本分段：构造 > WORLDVIEW_CHUNK_SIZE 的多段落文本，断言 fetch 调用 2 次及以上，且两次条目被合并为一条提案；user prompt 含「【设定文本」。7. 失败与续跑：第一次请求 402 → 显示「第 1 段提取失败」与「已提取 0 / N 段」；job.importType 为 worldview、chapters 为空；unmount 后 renderImport 直接落在提取步骤（不显示「旧稿正文」），显示「继续提取」按钮。8. 粘贴步骤：先建一章，选世界观后不显示「将从第 N 章接着编号」提示；英文文本选世界观时显示「暂不支持翻译」提示。9. 已有 inbox 测试之后点「继续导入下一批素材」回到粘贴步骤并显示世界观的「上一份设定」提示。
      Files: src/features/import/ImportScreen.test.tsx
      Verify: `npx vitest --run src/features/import/ImportScreen.test.tsx` 全过。

- [x] 4. 文档补充（独立，可与 3 并行理解）。
      在 docs/产品文档.md 6.5 节步骤列表后补一段「为什么设定文本可以不当章节导入」（1-2 段，沿用「为什么」写法）：设定集、人物小传不是故事正文，写成章节会污染章节列表、字数与摘要链；所以只提取为知识库条目、全部走待确认；长文本分段提取并可续跑；暂不支持翻译的原因与替代做法。
      Files: docs/产品文档.md
      Verify: 人工通读。

- [x] 5. 全量验证。
      Verify: `npm run build` 成功；`npx vitest --run` 全部通过（≥ 原 1004 个 + 新增用例，零失败）。另确认 ImportScreen.tsx 中不再出现 `index: -1`、`index === -1`、`临时` 字样的临时章节逻辑（仅作为自检，不替代测试）。

## 实现记录

> 注：review.json（APPROVED、findings 为空）属于旧「临时章节」方案的评审，与本方案无关，本轮按首次迭代从头实现。

### 改动文件

- `src/domain/schema.ts`：新增 `ImportWorldviewChunkSchema` / `ImportWorldviewChunk`；`ImportJobSchema` 新增 `worldviewText`、`worldviewChunks`（均有 default，向后兼容，无 Dexie 升级）。
- `src/features/import/worldview.ts`（新）：`WORLDVIEW_CHUNK_SIZE = 6000`、`splitWorldviewText`。
- `src/features/import/extractSettings.ts`：`buildExtractUserPrompt` 的 `chapter` 放宽为 `Pick<Chapter,'index'|'title'|'content'>`，新增 `sourceLabel`（章节模式 prompt 字节不变）；`accumulateEntryDrafts` 的 `chapterId` 接受 `null`（不记溯源章节）。
- `src/features/import/ImportScreen.tsx`：
  - 删除：旧 `createWorldviewImportJob`（`createChapter({ index: -1 })`）、加载时清理 `index === -1` 孤儿章节、finalize 删临时章节循环、`extractOne` 里的 worldview 三元/条件、`buildStyleProposal` 首行 worldview 判断、rollingSummary 条件里的 `importType !== 'worldview'`、inbox 里 `job?.importType` 判断。自检 `grep "index: -1|index === -1|临时章节|deleteChapter"` 无匹配。
  - 新增：`createWorldviewImportJob`（切段存 job，`chapters: []`，不调 createChapter）、`extractWorldviewChunk` / `markChunk` / `retryChunk`、`runLoop` 世界观分支（失败停在「第 i 段提取失败」）、`finalizeWorldview`（只出条目提案，`fallbackSourceRef: '世界观设定导入'`，不出摘要/进展/文风）、`finishedImportType` state（inbox 文案与「上一份设定」提示读它）、加载时 worldview job → 提取步骤、世界观提取页（「已提取 X / N 段」「第 i 段」+ 预览 + 重试）、步骤条隐藏分章/翻译、粘贴步骤隐藏编号提示并显示「不会写成章节」与外文「暂不支持翻译」提示（role="note"）、放弃确认文案。
  - `buildEntryProposal` 新增 `fallbackSourceRef`。章节模式逻辑未改。
- `docs/产品文档.md` 6.5：补导入类型说明 + 两段「为什么」（不当章节导入、暂不翻译）。

### 新增测试

- `src/features/import/worldview.test.ts`（describe「世界观设定分段」6 例）：空文本或纯空白返回空数组；短文本整段成一块；多段落贪心合并，每块不超过上限；单个段落超过上限时硬切；拼回去去掉空白后与原文一致，不丢字；默认上限是 WORLDVIEW_CHUNK_SIZE。
- `src/features/import/extractSettings.test.ts`（3 例）：给了来源标签时正文块标成设定文本，不冒充章节；不给来源标签时仍是原来的章节正文块；来源不是章节时（世界观导入）新建与合并都不记溯源章节。
- `src/features/import/ImportScreen.test.tsx` describe「作为世界观设定导入」（10 例，helper `pasteWorldview` 点「作为世界观设定」→「开始提取设定」真实走 UI 路径）：
  1. 提取完成后只生成条目提案，进入收件箱（label、create、sourceRef=世界观设定导入、同批次）
  2. 全程不写任何章节，跑完任务也被清掉（fetch 挂起期间与完成后 `listChapters` 均为 `[]`，job.chapters 为 `[]`）
  3. 不生成章节摘要、全书进展与文风提案，作品进展摘要不变（只发 1 次请求）
  4. 收件箱显示世界观专属文案
  5. 提取 prompt 标成设定文本，不冒充章节，也不带伏笔与进展（无「第 -1 章」）
  6. 已有同名条目走合并，写入后不带伪造的溯源章节
  7. 长文本分段提取，各段读到的同名条目合并成一条提案
  8. 某段失败时停下来；重开面板回到提取步骤接着跑（重试后进收件箱）
  9. 粘贴步骤：选世界观时不显示章节编号提示，外文时说明暂不支持翻译
  10. 处理完一份设定后继续导入，提示针对设定而不是章数
- 反向验证：把 ImportScreen.tsx 临时换回旧实现运行 `-t 世界观`，10 例全部失败（`Tests 10 failed`）；恢复新实现后全过。

### 验证命令与结果

- `npx tsc --noEmit`：通过，无输出。
- `npx vitest --run src/features/import src/data`：9 files，273 passed。
- `npm run build`：通过（`✓ built`；仅有既有的 chunk >500kB 提示）。
- `npx vitest --run`：**1023 passed / 0 failed**（原 1004 + 新增 19）。
