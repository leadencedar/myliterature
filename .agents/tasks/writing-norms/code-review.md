# 作品级写作规范：原文落库、按作用范围注入稳定前缀、按规范检查本章（第 2 轮代码审查）

这次改动给每部作品加了多份「写作规范」（Dexie v6 新表 `writingNorms`、仓储六个方法、备份 v3）。作者粘贴或上传的原文直接落库，按五个作用范围（写正文 / 规划 / 章节摘要 / 提取设定 / 检查）注入对应任务系统提示的稳定前缀，位置在作品信息与风格档案之后、核心设定之前。整章生成和段落加工可以临时取消某份规范；「AI 精简」走可编辑预览 → 另存为新规范、原文停用；章节编辑器新增「按规范检查」，结构化输出、分段、截断即失败、只提示不改正文。本轮是修订轮，上一轮的 4 条发现（1 条阻塞）都已修复并有测试覆盖。

Watch for: 没有阻塞项。剩下两处不阻塞的小问题：区块标题的「新建」按钮仍是 36px（confirmed，LOW）；从结果视图点「重新检查」进入表单后，要回到上一次结果只能关掉面板再打开（confirmed，NIT）。

**Verdict**: APPROVED

## High-level view

上一轮的阻塞项已经修掉。`NormCheckSheet` 加了 `formRequested`，结果视图的「重新检查」只把它设为 true、回到表单，不发请求。作者在表单里能看到按当前正文重算的分段数和 token，也能临时取消规范，点「开始检查」才发请求，满足 FR19 和设计 1.7.4 / 1.7.6。检查成功、停止、关闭再打开都会把它清回 false。

无规范时零变化，仍然只靠一个过滤入口 `normsInScope`：没有可注入的块时，`composeNormsSection` 返回空串，构建器不 push、不加 item。`noNormsBaseline.test.ts` 只用字面量加 `toBe` / `toEqual`，本轮在改动前和改动后的代码上都复跑通过。夹具双份复制的风险已经由新的「夹具同步」用例兜住。

数据层只新增表，正文原样落库，精简另存是单个事务。备份 v3 向下兼容 v1/v2，旧应用读到 v3 会明确拒绝。

注入覆盖需求要求的六类任务加检查，翻译、文风取样、连通性测试没有动。范围外文件逐字节未改，现有测试的删除行只涉及 `context.json` 允许的版本号断言。需求补充 2 的 8 条遗留发现全部落实。

<details>
<summary>Issues (2)</summary>

1. **区块标题「新建」不足 44px（不阻塞，LOW，confirmed）**：`WritingNormsSection.tsx` 141 行 `size="sm"`（`h-9`，36px），低于 NFR7。改成 `size="md"`，或加 `tap-target`。
2. **表单视图没有「返回结果」（不阻塞，NIT，confirmed）**：从结果点「重新检查」进入表单后，不重跑就只能关掉面板再打开才能看到上一次结果。在 `result !== null && formRequested` 时加一个 ghost 按钮「返回结果」，点击后 `setFormRequested(false)`。

</details>

<details>
<summary>Details</summary>

### 本轮复跑结果

在 `/Users/leadencedar/Production/Project/MyLiterature` 下复跑：

- `npm run build`（`tsc --noEmit && vite build`）退出码 0，只有改动前就有的 chunk > 500 kB 警告。
- `npx vitest --run`：62 个文件、1442 个测试全部通过，退出码 0。
- `CI=1 npx vitest --run`：62 个文件、1442 个测试全部通过，退出码 0。
- `CI=1 npx vitest --run` 只跑 `noNormsBaseline`、`noNormsInputs`、`NormCheckSheet`、`WritingNormsSection` 四个文件：4 个文件、59 个测试通过。
- 交叉核对：拷贝前确认基线里没有 `src/context/noNormsBaseline.test.ts` 和 `node_modules`。把 `noNormsBaseline.test.ts` 拷进基线 `src/context/`，软链 `node_modules`，在旧代码上跑 `CI=1 npx vitest --run src/context/noNormsBaseline.test.ts`：1 个文件、4 个测试通过，退出码 0。跑完已删除拷入的文件和软链，基线 `src/context/` 恢复为原来的 4 个文件。

数量和 `verification.md` 记录的 62 / 1442 一致（上一轮是 1438，多出的 4 个就是修复补的测试）。

### 必查项逐条结论

1. **`noNormsBaseline.test.ts` 没有快照断言**（confirmed）。对它和 `noNormsInputs.test.ts` 跑 `grep -nE "Snapshot|toMatch|\.snap"`，没有任何匹配（grep 退出码 1）。`expect` 一共 18 处：342、346 行是 `toEqual(BASELINE.builderMain / builderSide)`，351–370 行是 16 个 `toBe(BASELINE.x)`。`const BASELINE = {…}` 是 381 行起的字面量，注释写明「为什么是字面量而不是快照」。新旧两份 `src` 下都没有 `.snap` 文件，也没有 `__snapshots__` 目录。文件 mtime 是 18:58（FEAT-001 生成时），本轮修复没有动它。
2. **范围外文件没有改动**（confirmed）。`cmp` 逐字节相同：`src/features/settings/DiagnosticsSection.tsx`（shasum 25f49c3cc675…）、`src/app/store/diagnostics.ts`（1b16ccdec900…）、`src/app/store/useActiveNovel.ts`（3a18bbbe62ed…）。设计定下不改的 `SettingsPage.tsx`、`src/features/writing/translate.ts`、`src/features/writing/TranslateSheet.tsx` 也相同。`Controls.tsx` 的 diff 只有 `Toggle` 一个 hunk，`ChipGroup` 没动。
3. **现有提示词快照与断言没有改动**（confirmed）。对 `diff -rq` 列出的 9 个改动过的现有测试文件，逐个取 `diff -u` 的删除行：
   - `DexieNovelRepository.test.ts`：一行 `import type`（扩成多行）、用例名「当前架构版本为 5」、三处 `verno).toBe(5)`。
   - `backup.test.ts`：`BACKUP_VERSION).toBe(2)` 及用例名、「来自更新版本」用例的 `version: 3` 及用例名、`seedNovel` 的返回语句和一处解构（多带 `norm`）。
   - `sections.test.ts`：一行 import。
   - `SummaryChainContextBuilder`、`extractSettings`、`SetupSection`、`projectSetup`、`chapterSummary`、`structured` 的测试：没有删除行。

   删除的断言只有 `context.json` 明列允许的 verno 5→6 和 BACKUP_VERSION / 「来自更新版本」版本号，项目里本来也没有提示词快照。

4. **零变化、缓存前缀、原文落库、精简确认、升级与备份**（confirmed），见下文各节。
5. **作用范围与注入、「本次注入」、提取注入、UI、文档**（confirmed），见下文各节。剩下的两处不阻塞问题见 UI 一节。

### 上一轮发现的修复核对

上一轮阻塞项是结果视图的「重新检查」直接调用 `start()`。现在 `NormCheckSheet.tsx` 的判定是：

```tsx
const showResult = run.kind === 'idle' && result !== null && !formRequested;
```

结果视图里的按钮改成了 `onClick={() => setFormRequested(true)}`。`formRequested` 在四处被清回 false：打开时的 `wasOpen` effect、`start()` 成功之后、`stop()`，以及默认初值。表单视图的「开始检查」仍是唯一发请求的入口，旁边的说明行 `summaryLine` 由 `plan` 按当前 `content` 重算。新测试「结果里点『重新检查』先回到表单、不发请求；改短正文后说明行按新的 K 显示」（`NormCheckSheet.test.tsx` 561 行）验证了这条路径：长章 K=2，检查后发了 2 次请求；把正文换成短章后点「重新检查」，picker 和「本章约 N 字，输入…」都出现，没有「将分」，请求仍是 2 次；点「开始检查」后变成 3 次。593 行的用例验证回到表单后不开始就关掉，再打开仍显示上一次结果。`使用说明.md` 6.6 也同步写了「会先回到『开始检查』那一步」。

另外三条：

- 检查卡片的「定位 / 按建议改写 / 忽略」，以及编辑面板的「上传文件追加 / 插入差异说明模板」，都从 `size="sm"`（`h-9`）改成了 `size="md"`（`h-11`，44px）。
- `WritingNormEditorSheet.remove()`（246 行）加了 try/catch，失败时先关确认框，再 `setError(messageOf(cause, '删除失败'))`，由面板里的 `role="alert"` 显示。测试是 `WritingNormsSection.test.tsx` 256 行「删除失败：确认框关闭，面板内提示原因，库里不变」。
- `noNormsInputs.test.ts` 431 行新增「夹具同步」：用 `?raw` 读两份源码，截取「夹具」分隔线到 `actual()` 结尾这一段，规整掉本文件多出的规范参数后，必须与基线逐字相同。标记缺失时 `fixtureRegion` 抛错，不会变成空串比空串。这样只改一份夹具会直接失败，基线文件也不用改。`verification.md` 记录了反向验证：改动一个字符后用例失败。

### 零变化与缓存前缀

`writingNormsSection` 和构建器共用 `composeNormsSection(scope, blocks)`，没有块时返回 `''`。`composeSections` 会跳过空段，构建器只在 `normsText` 非空时 `stableParts.push`。规范块用 `take(..., true)` 作 mandatory 项，插在 meta+style 之后、pinned 之前（`SummaryChainContextBuilder.ts` 新增约 113–133 行）。所以没有规范时 items 和 token 合计都不变。渲染只有 `【规范《标题》】`、`content.trim()` 和结束标记，不含时间戳或 token 数。`normsInScope` 按 `order → createdAt → id` 全序排序，同一输入两次构建结果相同。外传和主线都走同一段 stableParts 代码，不受 track 影响。

`noNormsInputs.test.ts` 用 `it.each` 覆盖了不传、空数组、只有停用的、作用范围不含该任务这四种输入，断言 `toEqual(reference)`。另有一例断言作用范围内的规范会让五类系统提示都出现标记、用户提示不变，证明护栏不是空转。

### Dexie v6、仓储与备份

`db.ts` 只新增 `this.version(6).stores({ writingNorms: 'id, novelId' })`，没有 upgrade 回调。`DexieNovelRepository.test.ts` 的「v5 → v6 迁移」用例用原生 Dexie 建到 v5 再打开，断言 `verno === 6`、旧数据不变、新表为空且可写。`createWritingNorm` 在 rw 事务里算 `max(order)+1`，`content: input.content` 原样交给 schema；`WritingNormSchema.content` 只有 `max(60_000)` 和 trim 后非空的 `refine`，不改写值。`updateWritingNorm` 用 `stripProtected` 保护身份字段，还显式删掉 `order` / `updatedAt`。`reorderWritingNorms` 同时校验长度、Set 大小和归属，`[a,a,b]` 会被拒。`saveCondensedWritingNorm` 先 parse 新行，再按 `compareNorms` 插到源规范之后、整本书重写 order，源规范 `enabled=false`、正文不变，一次 `bulkPut` 完成。删除作品、导出、导入（含 replace 模式的 `clear()`）都加了 `writingNorms` 表。

备份方面，`BACKUP_VERSION = 3`，快照里 `writingNorms` 缺省为 `[]`，所以 v1/v2 文件可以覆盖恢复，也可以合并导入。旧应用的守卫是基线 `backup.ts` 里的 `header.data.version > BACKUP_VERSION`（值为 2），读到 v3 文件会明确报「来自更新版本」，满足 NFR6。

### 原文落库与 AI 精简

`WritingNormEditorSheet.save()` 只调用 `createWritingNorm` / `updateWritingNorm`，`content: draft.content` 就是 textarea 的原值。模型调用只出现在 `startCondense` 里，结果在作者点「另存」之前只存在 `condense` state。`WritingNormsSection.test.tsx` 332 行断言预览出现时库里规范数不变、草稿被锁；另存后新规范排在原规范之后，原规范停用、正文不变，面板关闭并出现提示。放弃和请求失败两种情况下库里都没有变化，也有测试覆盖。

### 注入覆盖与「本次注入」

各调用处都在发请求前读最新规范：`ImportScreen` 的逐章提取并进了已有的 `Promise.all`（998 行），世界观逐段提取改为 `Promise.all([listEntries, listWritingNorms])`（1120 行）；另外还有 `ChapterSummarySheet`、`OutlineNodeSheet`、`SetupSection`，以及 `WritingPage` 查询追加的 `listWritingNorms`。翻译、文风取样、连通性测试的调用处没有带规范，`translate.ts` 和 `TranslateSheet.tsx` 与基线逐字节相同。`GenerateChapterSheet` 新增一个只执行 `setExcludedNormIds([])` 的 `wasOpen` effect，`excludedNormIds` 进了 `preview` 的依赖和 `generate()` 的 build 参数。`ReviseSheet` 把它并进了已有的打开重置，并支持 `initialAction` / `initialInstruction`，只在打开那一刻生效。`writingNorms.e2e.test.tsx` 覆盖了清单条目和 token、取消后请求不带但库里仍启用、关掉再开后恢复。

### 按规范检查的数据流

系统提示依次是作品信息、`writingNormsSection(injected,'check')`、核心设定块、任务说明。核心设定块用 `'【核心设定（供判断，不是检查对象）】'` 加 `renderEntry`，以 `\n\n` 连接（`normCheck.ts` 107 行）。用户提示依次是相关设定（整章算一次）、前情、分段说明、正文，正文放在末尾，符合缓存策略。分段依次调用并带 `failOnTruncation: true`。`structured.ts` 在解析之前遇到 `finishReason === 'length'` 就抛 `LlmError('truncated')`，不进修复重试。任一段失败都显示「第 i/K 段检查失败：…」，`collected` 被丢弃。面板对外只有 `onResult / onIgnore / onLocate / onRevise / onClose` 几个回调，正文仍然只能经 `ReviseSheet.onAccept` 由作者确认写入。

### UI：窄屏与宽屏，以及剩下的两处小问题

编辑面板和检查面板都用默认 `Sheet`，窄屏是底部抽屉、宽屏是右侧抽屉，只有一套 DOM。排序用 `IconButton`，没有拖拽。启用开关是 `Toggle ariaLabel="启用《标题》" tapTarget`。编辑器头部那一行加了 `flex-wrap gap-y-1.5`，「按规范检查」按钮带 `tap-target`。禁用时用 `aria-disabled` 而不是原生 disabled，点击会显示原因，计时器存在 ref 里，再次点击和卸载时都会清掉。

区块标题的「新建」仍是 `size="sm"`（`WritingNormsSection.tsx` 141 行，`h-9` 即 36px），低于 NFR7 要求的 44px（confirmed，LOW，不阻塞）。上一轮在正文里提过它，修复轮以「与 `StyleSection` 36 行的 Section action 写法一致」为由没改。空状态和列表下方都有 `md` 尺寸的替代入口，所以影响有限。但这是本次新增的控件，NFR7 没有给 Section 标题例外，建议改成 `md` 或加 `tap-target`。

从结果视图点「重新检查」进入表单后，表单里没有「返回结果」之类的入口（confirmed，NIT）。`formRequested` 只在打开、检查成功、停止时清回 false，作者如果只是想看看调用次数、又决定不重跑，就得关掉面板再打开（593 行的测试正好走的是这条路）。修复建议：`result !== null && formRequested` 时，在「开始检查」旁加一个 ghost 按钮「返回结果」，点击后 `setFormRequested(false)`。

### 文档

`产品文档.md` 改了 5.1（改写为两类例外），在 6.2 新增写作规范（作用范围表、阈值、「为什么不是世界观条目 / 不是文风 / 原文保存 / 翻译不带 / 精简另存」），在 6.3 补了注入清单、临时取消、外传前缀，以及「按规范检查本章」和「为什么只提示、不自动改」，第 7 节信息架构和第 9 节注入顺序也同步了。`使用说明.md` 新增 5.5 和 6.6，6.6 本轮按新流程更新了「重新检查」的说明；6.3、8.2、第 9、10 节同步。`世界观写作指南.md` 在第 3 节末尾新增「哪些内容写成写作规范，而不是世界观条目」，第 8 节提示词加了第 10 条。`设计方案.md` 同步了 ER 图、装箱表和快照版本。

### 需求补充 2 的 8 条遗留发现

1. **[MEDIUM] 精简另存后的面板状态**：已落实（confirmed）。`saveCondensed()` 依次调用 `invalidate()`、`onCondensed(saved.title)`、`onClose()`。区块里的 status 文案是 `已另存为《${title}》，原规范已停用。`（`WritingNormsSection.tsx` 266 行）。失败时 `setCondenseError`，面板和预览保持不变。`locked = streaming || preview` 时，标题、正文、上传按钮和 input、模板按钮、作用范围按钮（364–433 行的 `disabled={locked}`）、启用开关（452 行的 `<fieldset disabled={locked}>`）和底部「保存」（`disabled={saving || locked}`）全部禁用。测试 `WritingNormsSection.test.tsx` 332 行。
2. **[LOW] dirty 判定**：已落实（confirmed）。代码是 `draft.title !== norm.title || draft.content !== norm.content || draft.enabled !== norm.enabled || normalizeNormScopes(draft.scopes).join() !== normalizeNormScopes(norm.scopes).join()`，dirty 时提示「先保存再精简。」。测试在 452、460 行，后者验证只改勾选先后不算 dirty。
3. **[LOW] 另存前预检**：已落实（confirmed）。另存前先调用 `validateNormDraft({ title: condensedTitle(norm.title), content: condense.text })`，有错时 `setCondenseError(problem)` 后直接返回，不调用仓储。`validateNormDraft` 只取 schema 第一条 issue 的中文 message。测试 433 行「预览只剩空白时另存禁用；超长时预检报中文错误且不写库」。
4. **[LOW] 检查提示里的核心设定块**：已落实（confirmed）。`normCheck.ts` 107 行起，块按 `pinned.map(renderEntry)` 用 `\n\n` 连接；面板里 `pinned = entries.filter(e => e.pinned)`，顺序沿用 `context.entries`。测试 `normCheck.test.ts` 181 行「两条核心设定按传入顺序，之间恰好一个空行」。
5. **[LOW] token 估算口径**：已落实（confirmed）。代码是 `tokens = segments.length * estimateTokens(system) + Σ estimateTokens(user)`，不含 schema 块。K > 1 时文案是「本章约 N 字，将分 K 段检查（K 次调用），输入约 X tokens」，K = 1 时省略分段部分，N 用 `countWords(content)`。测试 `NormCheckSheet.test.tsx` 194、543 行。
6. **[NIT] extractWorldviewChunk 取数**：已落实（confirmed）。`ImportScreen.tsx` 1118–1121 行是 `const [entries, norms] = await Promise.all([repository.listEntries(novel.id), repository.listWritingNorms(novel.id)])`。
7. **[NIT] ChapterEditorScreen 的 llm 与计时器**：已落实（confirmed）。74 行在顶层新增 `const llm = useLlm()`。计时器存在 `checkReasonTimerRef`（108 行），`openNormCheck` 开头（328 行）和卸载时的 cleanup effect（175 行）都会 `clearTimeout`。
8. **[NIT] createWritingNorm 的 scopes**：已落实（confirmed）。scopes 缺省时用 `[...ALL_NORM_SCOPES]`，传入时先 `normalizeNormScopes` 再 parse。测试 `DexieNovelRepository.test.ts` 1962 行传入 `['check', 'writing', 'writing']`，断言得到 `['writing','check']`。`normalizeNormScopes` 遇到未知值不丢弃，而是排在末尾交给 schema 拒绝（FEAT-001 记录的偏差），比静默丢弃更安全。

</details>

<details>
<summary>File map</summary>

- `src/domain/schema.ts`：`WritingNormScopeSchema`、`WritingNormSchema`，快照加 `writingNorms`（默认空）
- `src/domain/writingNorm.ts`（新增）：作用范围元数据、`normalizeNormScopes`、`compareNorms`、`normsInScope`、阈值、`condensedTitle`、`validateNormDraft`、差异说明模板
- `src/data/NovelRepository.ts`、`src/data/dexie/DexieNovelRepository.ts`：六个规范方法，删除作品、导出、导入三处加表
- `src/data/dexie/db.ts`：v6 只新增 `writingNorms` 表
- `src/features/export/backup.ts`：`BACKUP_VERSION = 3`
- `src/prompt/sections.ts`：`renderNormBlock`、`normTokens`、`composeNormsSection`、`writingNormsSection`
- `src/context/ContextBuilder.ts`、`SummaryChainContextBuilder.ts`：`writingNorms` / `excludedNormIds`、`'norm'` 项，导出 `renderEntry` / `renderSummary`
- `src/features/writing/chapterSummary.ts`、`ChapterSummarySheet.tsx`、`src/features/import/extractSettings.ts`、`ImportScreen.tsx`、`src/features/outline/outlineExpand.ts`、`OutlineNodeSheet.tsx`、`src/features/setup/projectSetup.ts`、`SetupSection.tsx`：可选尾参数 `norms`，调用前读最新规范
- `src/features/writing/WritingPage.tsx`、`GenerateChapterSheet.tsx`、`ReviseSheet.tsx`、`NormInjectionPicker.tsx`（新增）：规范进写作页 context，临时取消
- `src/features/writing/normCheck.ts`、`NormCheckSheet.tsx`（新增）、`ChapterEditorScreen.tsx`：按规范检查的纯函数、面板与入口；本轮新增 `formRequested`，按钮改为 md
- `src/features/knowledge/WritingNormsSection.tsx`、`WritingNormEditorSheet.tsx`、`normCondense.ts`（新增）、`KnowledgePage.tsx`：知识库区块、编辑面板、AI 精简；本轮 `remove()` 加错误处理，按钮改为 md
- `src/llm/errors.ts`、`structured.ts`、`useLlm.ts`、`taskProfiles.ts`：`truncated`、`failOnTruncation`、`norm-condense` / `norm-check`
- `src/ui/Controls.tsx`：`Toggle` 加可选 `ariaLabel` / `tapTarget`
- `src/test/llmFixtures.ts`、`writingNormFixtures.ts`（新增）：`finishReason` 选项与端到端夹具
- 测试：新增 9 个文件（本轮在 `noNormsInputs` 里加了「夹具同步」用例），另在 9 个现有测试文件里追加用例
- `docs/产品文档.md`、`使用说明.md`、`世界观写作指南.md`、`设计方案.md`：见「文档」一节

完整 diff：`diff -ru /tmp/myliterature-baseline-writing-norms/src src` 与 `diff -ru /tmp/myliterature-baseline-writing-norms/docs docs`。

</details>
