# 实现计划 · 写作规范

输入：`requirements.md`、`requirements-addendum.md`（含补充 2）、`design.md`、`design-review.json`（第 3 轮，CHANGES_REQUESTED，用户选择继续）。
项目：`/Users/leadencedar/Production/Project/MyLiterature`（不是 git 仓库，直接在原目录改；所有路径都写绝对路径）。
基线快照：`/tmp/myliterature-baseline-writing-norms`（不含 node_modules），对比用 `diff -ru /tmp/myliterature-baseline-writing-norms/src /Users/leadencedar/Production/Project/MyLiterature/src`。
验证命令（项目目录下）：`npm run build`（= `tsc --noEmit && vite build`）、`npx vitest --run`；改动前 53 个测试文件、1268 个测试全绿，每一步结束都必须保持全绿。单文件可用 `npx vitest --run <path>`。
范围外不得修改：`src/features/settings/DiagnosticsSection.tsx`、`src/app/store/diagnostics.ts`、`src/app/store/useActiveNovel.ts`；另外设计已定不改 `src/features/settings/SettingsPage.tsx`、`src/features/writing/translate.ts`、`src/features/writing/TranslateSheet.tsx`、`src/ui/Controls.tsx` 里的 `ChipGroup`。
注释一律中文，写「为什么」。不引入新依赖。

## 0. 设计审查遗留发现（第 3 轮，未写进 design.md，优先级等同 design.md）

| #   | 级别   | 处理（落在哪一步）                                                                                                                                                                                                                                                                                                                   |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | MEDIUM | AI 精简另存成功 → `invalidate()` → 关闭编辑面板，规范区块内 `role="status"`「已另存为《{新标题}》，原规范已停用。」；失败保持面板与预览不变。精简处于 streaming / preview 阶段时禁用标题、正文、上传、模板、作用范围、启用开关与底部「保存」。测试：另存后面板关闭；重开原规范「启用」未勾选；预览阶段正文输入框 disabled。→ 步骤 11 |
| 2   | LOW    | `dirty = title/content/enabled 严格比较                                                                                                                                                                                                                                                                                              |     | normalizeNormScopes(draft.scopes).join() !== normalizeNormScopes(norm.scopes).join()`，dirty 时「AI 精简」禁用并提示「先保存再精简」。→ 步骤 11 |
| 3   | LOW    | 另存前 `validateNormDraft({ title: condensedTitle(norm.title), content })`，有错误时在预览下方显示中文文案、不调仓储，绝不显示 ZodError JSON；预览 trim 后为空时「另存」disabled。→ 步骤 11                                                                                                                                          |
| 4   | LOW    | 检查系统提示的核心设定块 = `['【核心设定（供判断，不是检查对象）】', ...pinned.map((e) => renderEntry(e, categories))].join('\n\n')`，顺序沿用 `context.entries`；测试断言两条核心设定按序且之间恰好一个空行。→ 步骤 13                                                                                                              |
| 5   | LOW    | 检查面板 token 口径 `X = K × estimateTokens(system) + Σ estimateTokens(user_i)`（不含 schema 块）；文案「本章约 N 字，将分 K 段检查（K 次调用），输入约 X tokens」，`N = countWords(content)`，K = 1 时省略「将分 K 段检查（K 次调用），」那部分。→ 步骤 14                                                                          |
| 6   | NIT    | `extractWorldviewChunk` 改为 `const [entries, norms] = await Promise.all([repository.listEntries(novel.id), repository.listWritingNorms(novel.id)])`。→ 步骤 8                                                                                                                                                                       |
| 7   | NIT    | `ChapterEditorScreen` 顶层新增 `const llm = useLlm()`；禁用原因的 3 秒计时器存 `useRef`，再次点击与卸载时 `clearTimeout`。→ 步骤 15                                                                                                                                                                                                  |
| 8   | NIT    | `createWritingNorm`：`scopes` 缺省为 `ALL_NORM_SCOPES`，传入时先 `normalizeNormScopes` 再 parse；仓储测试补 `['check','writing','writing']` → `['writing','check']`。→ 步骤 3                                                                                                                                                        |

以上 8 条都不改变设计已定的产品行为，只补足未定义的细节。

## 1. 「无规范时 prompt 逐字节不变」的实现与验证

实现：

- 所有渲染只经一个过滤入口 `normsInScope`（`src/domain/writingNorm.ts`）。`writingNormsSection` 在没有可注入规范时返回 `''`，`composeSections` 的 `filter(length > 0)` 会跳过它；构建器里 `normBlocks` 为空时不 push，`items` 也不多一项。
- 四个 `build*SystemPrompt` 只加**可选尾参数** `norms?`，现有参数、现有调用、现有测试一行不动。
- `renderEntry` / `renderSummary` 只加 `export`，实现不动；`Toggle` 两个新 prop 不传时输出逐字节相同；`completion()` 夹具新 option 不传时输出相同；`generateStructured` 的 `failOnTruncation` 默认 false。
- 现有提示词快照与断言一条不改。唯一允许改的现有断言：`DexieNovelRepository.test.ts` 1627/1701/1811 行 `verno` 5 → 6（含 1627 用例名）、`backup.test.ts`「来自更新版本」用例的 version 3 → 4 及 `BACKUP_VERSION` 值断言。

验证（步骤 1 建立，步骤 7/8/9 扩充，步骤 17 交叉核对）：

1. **改任何源码之前**，在未改动代码上写一次性脚本（放 `/tmp/norms-baseline-dump.test.ts` 之类，用 `npx vitest --run --dir /tmp ...` 或临时放进 `src/` 跑完即删），用固定夹具调用构建器（主线、外传各一次，取 `{ stablePrefix, volatileSuffix, items, estimatedTokens }`）和六个系统提示 + 六个用户提示构造函数（revise 三种 action），`JSON.stringify` 打印输出。
2. 粘成 `src/context/noNormsBaseline.test.ts` 里的 `BASELINE` 字面量常量，用 `toBe` / `toEqual` 断言。**禁止** `toMatchSnapshot` / `toMatchInlineSnapshot`。
3. 加入规范后，对每个函数追加 4 种输入（不传、`[]`、`[停用规范]`、`[作用范围不含该任务的规范]`），全部断言等于 `BASELINE`。夹具规范写成对象字面量、只 `import type { WritingNorm }`，不 import 任何新增运行时模块，使同一文件能在旧代码上跑。
4. `BASELINE` 永不修改；断言失败修实现。
5. 交叉核对（步骤 17）：
   ```sh
   cd /Users/leadencedar/Production/Project/MyLiterature && CI=1 npx vitest --run src/context/noNormsBaseline.test.ts
   cp src/context/noNormsBaseline.test.ts /tmp/myliterature-baseline-writing-norms/src/context/
   ln -s /Users/leadencedar/Production/Project/MyLiterature/node_modules /tmp/myliterature-baseline-writing-norms/node_modules
   (cd /tmp/myliterature-baseline-writing-norms && CI=1 npx vitest --run src/context/noNormsBaseline.test.ts)
   rm /tmp/myliterature-baseline-writing-norms/src/context/noNormsBaseline.test.ts /tmp/myliterature-baseline-writing-norms/node_modules
   ```
   两边都必须全绿。另外 `diff -ru` 基线 `src` 与当前 `src`，确认现有 `*.test.ts(x)` 文件里只有上面列出的版本号断言变动、没有任何提示词断言或快照被改。

## 2. 步骤

- [ ] 1. 零变化基线测试（改源码之前）。
      按第 1 节第 1–2 点在未改动代码上生成 `BASELINE` 并写成测试；夹具：作品、风格档案（含名家参考与非空 `extraInstruction`）、两类分类、一条核心设定、一条普通条目、大纲节点、三章含摘要、一部外传。此时文件只用现有 API。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/context/noNormsBaseline.test.ts`（新增）
      Verify: `npx vitest --run src/context/noNormsBaseline.test.ts` 通过；`npx vitest --run` 54 个文件全绿；临时脚本已删除；文件内无 `toMatch*Snapshot`。

- [ ] 2. 数据层：schema、领域函数、Dexie v6。
      `schema.ts` 在「外传」之后、「章节摘要」之前加 `WritingNormScopeSchema`、`WritingNormSchema`（字面量 60 / 60000，不 import `writingNorm.ts` 避免循环），`RepositorySnapshotSchema` 加 `writingNorms: z.array(WritingNormSchema).default([])`。新建 `writingNorm.ts`：`NORM_SCOPES`、`ALL_NORM_SCOPES`、`normalizeNormScopes`、`compareNorms`（order → createdAt → id，码元比较）、`normsInScope`、`countLinks`、`condensedTitle`（设计 6.1 公式）、`validateNormDraft`（返回第一条中文错误）、阈值常量 `NORM_TOKEN_WARN=2000 / NORMS_TOTAL_TOKEN_WARN=6000 / NORM_LINK_WARN=5 / NORM_CONTENT_MAX=60000 / NORM_TITLE_MAX=60`、`DIFF_NOTE_TITLE`、`DIFF_NOTE_TEMPLATE`（设计 1.6 全文）。`db.ts` 加 `writingNorms!: Table<WritingNorm, string>` 与 `this.version(6).stores({ writingNorms: 'id, novelId' })`，无 upgrade，附设计第 3 节注释。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/domain/schema.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/domain/writingNorm.ts`（新增）、`/Users/leadencedar/Production/Project/MyLiterature/src/domain/writingNorm.test.ts`（新增）、`/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/db.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/DexieNovelRepository.test.ts`（仅 1627/1701/1811 三处 `toBe(5)`→`toBe(6)` 与 1627 用例名）
      Tests（12.3 领域部分）：`normsInScope` 过滤与乱序排序；`normalizeNormScopes`；`countLinks`；`condensedTitle` 56/57/60 字且通过 schema；`validateNormDraft`；常量与 schema 边界一致（59/60/61、60000/60001）；模板含九个【】字段且不含「喰种」「CCG」「金木」。
      Verify: `npm run build` 通过；`npx vitest --run src/domain src/data` 通过；全量 `npx vitest --run` 全绿。

- [ ] 3. 仓储：六个方法 + 级联/导出/导入加表。
      `NovelRepository.ts` 加接口（设计第 4 节签名与注释）；`DexieNovelRepository.ts` 实现：`listWritingNorms`、`createWritingNorm`（rw 事务算 max(order)+1；`scopes` 缺省 `ALL_NORM_SCOPES`，传入先 `normalizeNormScopes` 再 parse——遗留 #8；content 不 trim）、`updateWritingNorm`（`stripProtected` + 删 `order`/`updatedAt` + 规范化 scopes + parse；不存在抛「这份写作规范已不存在，可能已被删除」）、`deleteWritingNorm`（幂等）、`reorderWritingNorms`（长度相等 + Set 大小相等 + 每个 id 属于本书，否则抛「规范列表已变化，请刷新后再调整顺序」且不写；order 变了才更新 updatedAt）、`saveCondensedWritingNorm`（rw 事务：按 `compareNorms` 排序，在源之后插入，源停用，整本书重写 order 0..n-1，一次 bulkPut）。`deleteNovel`、`exportSnapshot`、`importSnapshot` 的表列表加 `writingNorms`。仓储不打日志。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/data/NovelRepository.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/DexieNovelRepository.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/data/dexie/DexieNovelRepository.test.ts`
      Tests（12.1）：新建逐字符相同（含首尾空白、`## 标题`、空行、`【规范《X》结束】`）、默认启用、五项、order 递增；`['check','writing','writing']`→`['writing','check']`；修改四项、受保护字段改不动、不存在报错；删除、删作品级联；重排正常 + 缺 id / 多别书 id / `[a,a,b]` 三种被拒且 order 与 updatedAt 不变；精简另存（插在源后、沿用 scopes、源停用正文不变、源不存在不写）；重复 order（三份 order=0）精简 A → A、A（精简）、B、C，order 0..3；v5 → v6 迁移（原生 Dexie 声明到 v5 写作品/章节/外传/译名表，`AppDatabase` 打开 `verno === 6`、旧数据逐字段不变、新表空且可写）。
      Verify: `npx vitest --run src/data/dexie/DexieNovelRepository.test.ts` 通过；`npm run build`；全量全绿。

- [ ] 4. 备份 v3。
      `backup.ts`：`BACKUP_VERSION = 3` 并补设计第 5 节注释。`parseBackup` 逻辑不变（`writingNorms` 由 schema 默认 `[]`）。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/features/export/backup.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/export/backup.test.ts`
      Tests（12.2）：`BACKUP_VERSION` 为 3；「来自更新版本」用例改为 version 4；覆盖全部表含 `writingNorms`；往返一致性种子加一份规范且逐字段相同；v2（含外传）与 v1（无 sideStories/writingNorms）各覆盖恢复 + 合并导入一例，规范为空其余照旧；被拒文件 `detail` 以 `data.writingNorms.0.title` / `.content`（`'  \n '`）/ `.scopes` 开头且库里不变。
      Verify: `npx vitest --run src/features/export` 通过；`npm run build`；全量全绿。

- [ ] 5. 渲染：`sections.ts` 规范段。
      新增 `NORM_SCOPE_USAGE`、`renderNormBlock`（`【规范《T》】\n{content.trim()}\n【规范《T》结束】`）、`normTokens`（`estimateTokens(renderNormBlock(norm))`，全站唯一口径）、`composeNormsSection`、`writingNormsSection`，逐字采用设计 6.2 的文案；新增 `import { estimateTokens } from '@/context/tokens'`。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/prompt/sections.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/prompt/sections.test.ts`
      Tests（12.3 渲染部分）：无规范 `''`；五种 scope 用法行各不相同；extract 含「不要从规范里提取条目」；两次调用相同；`renderNormBlock` 去首尾空白、内部空行与 `## ` 原样；两份含 `## 小节` 的规范恰好 2 个开始标记、2 个结束标记且各自包含自己的小节；`normTokens === estimateTokens(renderNormBlock(...))`。
      Verify: `npx vitest --run src/prompt` 通过；全量全绿（现有 sections 断言不改）。

- [ ] 6. 上下文构建器注入 + 写作页数据流 + 「本次注入」临时取消。
      `ContextBuilder.ts`：`ContextRequest` 加 `writingNorms?`、`excludedNormIds?`，`ContextItemKind` 加 `'norm'`。`SummaryChainContextBuilder.ts`：在 meta+style 之后、pinned 之前按设计 6.3 代码插入（mandatory，`tokens: normTokens(norm)`，label `写作规范 · {标题}`），类注释装箱顺序改为 5 项；`renderEntry`、`renderSummary` 加 `export`（实现不动）。新建 `NormInjectionPicker.tsx`（设计 7.3：`norms`/`excludedIds`/`onToggle`/`legend?`，空数组渲染 null，fieldset + legend「{legend}（本次带上 X / N 份）」+ hint，`aria-pressed` chip `标题（约 N tokens）`，chip 类沿用 GenerateChapterSheet 条目 chip 并加 `tap-target inline-flex items-center`）。`WritingPage.tsx` 查询加 `repo.listWritingNorms(novel.id)` → `context.writingNorms`。`ChapterEditorScreen.tsx`、`GenerateChapterSheet.tsx`、`ReviseSheet.tsx` 的 `context` 类型 `Omit` 加 `'excludedNormIds'`。`GenerateChapterSheet`：`excludedNormIds` 状态 + 只重置它的新 `wasOpen` ref effect（其他状态行为不变）+ 「本次注入」块之后、核心设定提示之前渲染 picker（`normsInScope(writingNorms,'writing')`）+ `preview` useMemo 依赖与 `generate()` 的 build 参数。`ReviseSheet`：`excludedNormIds` 并入现有 `wasOpen` 重置，picker 放「临时换个笔法」之前。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/context/ContextBuilder.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/context/SummaryChainContextBuilder.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/context/SummaryChainContextBuilder.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/NormInjectionPicker.tsx`（新增）、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/WritingPage.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/ChapterEditorScreen.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/GenerateChapterSheet.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/ReviseSheet.tsx`
      Tests（12.4）：规范在 `composeStylePrefix(...)` 输出末尾之后（`startsWith` + `indexOf` 大于其长度；夹具 `extraInstruction` 非空）、【必须遵守的核心设定】之前；停用、只含 extract 的不出现；两份按 order 与传入顺序无关；两次 build 逐字节相同；`items` 含 `kind:'norm'`、label、`tokens === normTokens`；`excludedNormIds` 后 prompt 与 items 都没有；小预算下规范仍 included、勾选条目被挤出带 `droppedReason`；外传与主线 `stablePrefix` 相同（含规范）。
      Verify: `npx vitest --run src/context src/features/writing` 通过；`noNormsBaseline.test.ts` 仍绿；`npm run build`；全量全绿。

- [ ] 7. 其余四个任务的提示词与调用处（摘要、立项、细化大纲）。
      `chapterSummary.ts` `buildSummarySystemPrompt(novel, norms?)`、`outlineExpand.ts` `buildExpandSystemPrompt(novel, style, norms?)`、`projectSetup.ts` `buildSetupSystemPrompt(..., norms?)`，插入点按设计 6.4。调用处在发请求前读 `repository.listWritingNorms(novel.id)`：`ChapterSummarySheet.tsx` 的 `generateRef`、`OutlineNodeSheet.tsx` 的 `runExpand`、`SetupSection.tsx` 的 `generate`，失败走现有 catch。立项与细化大纲加只读提示行「将带上 N 份写作规范（约 X tokens）」：`SetupSection.tsx` 顶层 `Promise.all`（45 行）追加 `repo.listWritingNorms(novel.id)` 经 props 传给表单；`OutlineNodeSheet.tsx` 新增 `useRepoQuery((repo) => repo.listWritingNorms(novel.id), [novel.id])`；`N = normsInScope(norms ?? [], 'planning').length`，N 为 0 不渲染。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chapterSummary.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/ChapterSummarySheet.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/outline/outlineExpand.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/outline/OutlineNodeSheet.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/setup/projectSetup.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/setup/SetupSection.tsx`、测试 `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/chapterSummary.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/outline/outlineExpand.test.ts`（新增）、`/Users/leadencedar/Production/Project/MyLiterature/src/features/setup/projectSetup.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/context/noNormsBaseline.test.ts`（追加 4 种输入，`BASELINE` 不动）
      Tests（12.5）：对应 scope 带上、位置在开场白/作品信息（或 `composeStylePrefix`）之后、任务说明之前；不对应不带；`SetupSection.test.tsx` / 细化大纲 UI 无规范时没有提示行。
      Verify: 上述测试文件通过；`noNormsBaseline` 绿；`npm run build`；全量全绿。

- [ ] 8. 反向提取注入（旧稿逐章 + 世界观逐段）。
      `extractSettings.ts` `buildExtractSystemPrompt(novel, categories, norms?)`，插在 `novelMetaSection` 之后、EXTRACT_TASK 之前。`ImportScreen.tsx`：`extractOne` 把 `listWritingNorms` 并进现有 `Promise.all`（993 行）；`extractWorldviewChunk`（1116 行）改为 `const [entries, norms] = await Promise.all([repository.listEntries(novel.id), repository.listWritingNorms(novel.id)])`（遗留 #6）。翻译路径不动。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/features/import/extractSettings.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/extractSettings.test.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/context/noNormsBaseline.test.ts`（追加 extract 的 4 种输入）
      Tests：作用范围含 extract 时带规范与「不要从规范里提取条目」；不含时不带。
      Verify: `npx vitest --run src/features/import` 通过；全量全绿。

- [ ] 9. 端到端注入夹具与测试（写作页、导入页、摘要）。
      新建 `writingNormFixtures.ts`：`NORM_FIXTURE`（标题「使用提示」，正文为设计 12.7 列出的通用规则若干条 + 唯一标记 `【夹具标记 N-7F3】`，不含任何原作事实）与创建辅助函数。在现有写作页 / 导入页测试风格下（`createTestHarness` + `harness.renderUI` + `vi.spyOn(globalThis,'fetch')` + `src/test/llmFixtures.ts`）新增用例。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/test/writingNormFixtures.ts`（新增）、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/writingNorms.e2e.test.tsx`（新增，写作页 + 段落加工 + 摘要）、`/Users/leadencedar/Production/Project/MyLiterature/src/features/import/ImportScreen.norms.test.tsx`（新增）
      Tests（12.7）：生成面板「本次注入」有「写作规范 · 使用提示」与 token 数 → 请求 system 含标记且在作品信息/文风之后、【必须遵守的核心设定】之前 → 再开面板取消 chip → 请求不含标记、库里仍启用；段落加工含标记；段落加工 picker 取消 → 不含 → 库里仍启用 → 关开后 chip `aria-pressed="true"` 且再次请求含标记；导入两章写入主线 → 提取请求含标记与禁止提取句；世界观目的地同样；只含 writing 时提取不含；外文稿翻译请求不含标记；标记完成触发摘要请求含标记。
      Verify: 两个新测试文件通过；全量全绿。

- [ ] 10. `Toggle` 可选 props + 知识库「写作规范」区块（列表、新建、上传、编辑、删除、启停、排序）。
      `Controls.tsx` 的 `Toggle` 加 `ariaLabel?`、`tapTarget?`（设计 7.4，不传时输出逐字节不变；不碰 `ChipGroup`）。新建 `WritingNormsSection.tsx`（设计 7.1：`useRepoQuery` 列表、空状态、元信息 `formatTokens(normTokens)` · 作用范围按 `NORM_SCOPES` 顺序用「、」连接 / 已停用 / 未选作用范围 / 较长、`Toggle ariaLabel="启用《标题》" tapTarget`、上移/下移 `IconButton`、隐藏 `<input type="file" aria-label="规范文件" accept={ACCEPTED_EXTENSIONS.join(',')}>` 经 `readManuscriptFile`、超 60000 字与 `ManuscriptReadError` 报区块 alert、合计超阈值提示）。新建 `WritingNormEditorSheet.tsx`（设计 7.2 第 1–6、8 点：文件读入提示、标题、正文 hint token + 两条提示（链接文案逐字为「其中有 N 个链接。来源表通常不必进提示词，可以删掉或试试 AI 精简。」）、上传追加 `\n\n`、插入模板规则、本地作用范围 fieldset（`aria-pressed` + `tap-target`）、启用 Toggle、删除 + `ConfirmDialog`；保存前 `validateNormDraft`，content 原样）。AI 精简区留到步骤 11。`KnowledgePage.tsx` 在 `<StyleSection novel={novel} />`（163 行）之后插入 `<WritingNormsSection novel={novel} />`。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/ui/Controls.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/knowledge/WritingNormsSection.tsx`（新增）、`/Users/leadencedar/Production/Project/MyLiterature/src/features/knowledge/WritingNormEditorSheet.tsx`（新增）、`/Users/leadencedar/Production/Project/MyLiterature/src/features/knowledge/KnowledgePage.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/knowledge/WritingNormsSection.test.tsx`（新增）
      Tests（12.6 除精简）：新建（`user.paste`）库里逐字相同；从 `.md` 新建（`\r\n` → `\n`、预填标题「规范」、显示编码）；`.docx` 被拒；`'一'.repeat(60001)` 被拒且面板不开、库空；两份时 `启用《A》`/`启用《B》` 及上移/下移无障碍名唯一；作用范围默认 5 个 pressed；编辑、启停、上下移、删除（取消不删/确认删）；元信息作用范围顺序；模板插入（标题「本作差异说明」、含【本作开场时期】）；6 个链接出现提示且含「其中有 6 个链接」、5 个不出现；超阈值提示；每个控件只渲染一份。现有 `KnowledgePage.test.tsx` 与所有用到 `Toggle` 的测试不改且通过。
      Verify: `npx vitest --run src/features/knowledge src/ui` 通过；`npm run build`；全量全绿。

- [ ] 11. AI 精简（编辑面板内）。
      `taskProfiles.ts` 加 `'norm-condense'`（`thinking: true, reasoningEffort: 'medium', temperature: 0.2, useStrongModel: false, structured: false, label: '精简写作规范'`），不加进 `SettingsPage` 的 `TASK_ORDER`。新建 `normCondense.ts`（`NORM_CONDENSE_SYSTEM`、`buildCondenseUserPrompt`，文案逐字取设计 1.5）。`WritingNormEditorSheet` 加精简区（设计 7.2 第 7 点 + 1.5 流程 + 第 9 节错误表）：`llm.runStream('norm-condense', {...,signal}, { onText })`；`!llm.configured` 禁用并显示「需要先在『设置』里配置模型」；dirty 判定按遗留 #2，dirty 时禁用「先保存再精简」；streaming/preview 阶段禁用标题、正文、上传、模板、作用范围、启用开关与底部保存（遗留 #1）；预览为可编辑 `TextAreaField`「精简结果（可直接修改）」+ 原文/结果 token 对比 + `finishReason==='length'` 截断提示 + 空输出提示；「另存为新规范（原文自动停用）」前 `validateNormDraft({ title: condensedTitle(norm.title), content })` 预检、trim 空时 disabled（遗留 #3）→ `saveCondensedWritingNorm` → 成功 `invalidate()` + 关闭面板 + 区块 `role="status"`「已另存为《{新标题}》，原规范已停用。」（`WritingNormsSection` 通过回调接收消息），失败保留面板与预览；「放弃」回编辑态不写；关闭面板 abort。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/llm/taskProfiles.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/knowledge/normCondense.ts`（新增）、`/Users/leadencedar/Production/Project/MyLiterature/src/features/knowledge/WritingNormEditorSheet.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/knowledge/WritingNormsSection.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/knowledge/WritingNormsSection.test.tsx`
      Tests（12.6 精简部分，`vi.spyOn(globalThis,'fetch')` + `sseResponse(textDeltaEvents(...))`，参照 `ReviseSheet.test.tsx`）：预览出现时库里仍 1 份且正文输入框 disabled；另存后 2 份、新的排第二且启用、原文停用正文不变、面板关闭、status 文案出现、重开原规范「启用」未勾选；放弃无变化；fetch 500 显示错误库里无变化；有未保存修改时按钮禁用；未配置模型时禁用。
      Verify: `npx vitest --run src/features/knowledge src/llm` 通过；`npm run build`；全量全绿。

- [ ] 12. LLM 层：截断错误与检查任务配置。
      `errors.ts` 的 `LlmErrorKind` 加 `'truncated'`；`structured.ts` 的 `StructuredOptions` 加 `failOnTruncation?: boolean`（默认 false），为 true 且任一响应 `finishReason === 'length'` 时立即抛 `new LlmError('truncated', '模型输出被截断，检查结果不完整', { detail })`，不进修复重试；`useLlm.ts` 的 `StructuredRunOptions` 透传。`taskProfiles.ts` 加 `'norm-check'`（`thinking: true, reasoningEffort: 'high', temperature: 0.2, useStrongModel: false, structured: true, label: '按规范检查'`）。`llmFixtures.ts` 的 `completion(content, options?)` 加可选 `finishReason?: string`（传入时写 `choices[0].finish_reason`，不传输出不变）。若有对 `LlmErrorKind` 的穷举 switch（如错误文案映射），补 `'truncated'` 分支。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/llm/errors.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/structured.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/useLlm.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/taskProfiles.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/test/llmFixtures.ts`、`/Users/leadencedar/Production/Project/MyLiterature/src/llm/structured.test.ts`
      Tests：`failOnTruncation: true` + `finish_reason: 'length'` 抛 `kind === 'truncated'` 且只发一次请求；不传时截断 JSON 照旧进修复重试（现有行为）。
      Verify: `npx vitest --run src/llm` 通过；`npm run build`；全量全绿。

- [ ] 13. 检查的纯函数模块 `normCheck.ts`。
      依设计 1.7.2–1.7.4 实现：`NormCheckSeveritySchema`、`NormCheckIssueSchema`、`NormCheckResultSchema`、`NORM_CHECK_SEGMENT_CHARS = 8000`、`NORM_CHECK_TASK`（逐字）、`buildNormCheckSystemPrompt(novel, norms, pinnedEntries, categories)`（核心设定块按遗留 #4 拼接，空则省略）、`buildNormCheckUserPrompt({ chapterLabel, segment, mentionedEntries, categories, previous })`（【相关设定】、`【此前最近一章（第 N 章 / 外传第 N 章）的摘要】` + `renderSummary`、待检查正文块、分段说明句）、`locateQuote`（设计给出的算法）、`resolveCheckIssues`（规范名双候选匹配、同名取首、只在 injected 内匹配、四级排序）、`splitChapterForCheck`（不变量见设计 1.7.4）、严重程度中文标签映射。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/normCheck.ts`（新增）、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/normCheck.test.ts`（新增）
      Tests（12.7b 纯函数部分）：系统提示含 check 规范与核心设定（两条按序、之间恰好一个空行）、不含停用/非 check 规范、不含【文风】、两次相同；用户提示各块、跳章标题为「第 1 章」、外传标题「外传第 N 章」、分段标签与说明句；`locateQuote` 精确/多次取首/跨行全角空格/quote 自带空白/找不到/空与纯空白；`resolveCheckIssues` 匹配与排序四级；`splitChapterForCheck` 全部不变量。
      Verify: `npx vitest --run src/features/writing/normCheck.test.ts` 通过；`npm run build`；全量全绿。

- [ ] 14. 检查面板 `NormCheckSheet.tsx`。
      按设计 1.7.6 / 1.7.8 的 props 与数据流实现：`Sheet` drawer；`excludedIds` 本地状态 + `wasOpen` 重置；`injected = normsInScope(context.writingNorms,'check',new Set(excludedIds))`；复用 `NormInjectionPicker`（`legend="参与检查的规范"`）；`injected.length === 0` 时「开始检查」原生 disabled +「至少保留一份规范」；分段与 token 说明按遗留 #5；`pinned`、`related`（整章算一次，`slice(0, MAX_INFERRED_ENTRIES)`）、`previous`（`previousSummaryOf` + 查 chapter）所有分段共用；分段依次 `llm.runStructured('norm-check', { schema: NormCheckResultSchema, ..., failOnTruncation: true, signal })`；进度「正在检查第 i/K 段…」+「停止」；任一段失败整次失败「第 i/K 段检查失败：{message}」，truncated 时附加精简建议 +「重新检查」；结果卡片（严重程度标签、《规范标题》/「规范名未对应」、规范原文、正文原句或「正文里没找到这段原文」、问题、建议、按 `checkedContent` 决定「定位」「按建议改写」是否显示、「忽略」）；0 条文案；过期提示。面板不接收任何写正文回调。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/NormCheckSheet.tsx`（新增）
      Verify: `npm run build` 通过（UI 测试在步骤 15 与入口一起写）；全量全绿。

- [ ] 15. 章节编辑器入口、定位、按建议改写。
      `ChapterEditorScreen.tsx`：顶层 `const llm = useLlm()`；头部第二行加 `flex-wrap gap-y-1.5`，「摘要」前加 pill「按规范检查」（`ml-auto` 从摘要按钮移到它，加 `tap-target inline-flex items-center justify-center`；有未忽略结果时「检查结果 N」）；三种禁用用 `aria-disabled="true"`，点击显示 `role="status"` 原因，3 秒计时器存 `useRef`、再次点击与卸载时 `clearTimeout`（遗留 #7）；会话 state `normCheck` / `ignoredKeys`；`onLocate` 用当前 content 重新 `locateQuote`，null 时把「这段原文已被修改，找不到了」交给面板显示在卡片内（面板不关），否则关面板 → focus → `setSelectionRange` → 同步 `selectionRange`；`reviseSeed` state，「按建议改写」先定位成功再 `setReviseSeed({ action:'rewrite', instruction:`按写作规范《${normTitle}》修改：${suggestion}` })` 并打开 `ReviseSheet`；底栏「加工这一段」与 `ReviseSheet.onClose` 都 `setReviseSeed(null)`。`ReviseSheet.tsx` 加可选 `initialAction` / `initialInstruction`，在关→开重置 effect 里优先使用，undefined 时行为不变。
      Files: `/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/ChapterEditorScreen.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/ReviseSheet.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/NormCheckSheet.tsx`、`/Users/leadencedar/Production/Project/MyLiterature/src/features/writing/NormCheckSheet.test.tsx`（新增，沿用 `ChapterEditor.test.tsx` 写法）
      Tests（12.7b UI 部分全部）：请求 system 含 check 规范标记、user 含正文、停用/只含 writing 的不出现；两条 issue 渲染与严重程度文案、定位后 `selectionStart/End`；忽略后消失且入口计数减一；按建议改写打开改写面板（操作「改写」、额外要求预填），放弃后正文不变；预填清除（关闭后点「加工这一段」额外要求为空、操作默认）；删原句后定位/按建议改写只出提示、面板不关、选区不变；`checkedContent` 里定位不到时不显示两按钮并显示「正文里没找到这段原文」；无规范 / 未配置模型 `aria-disabled` + 原因 + 无请求；两份 check 规范取消一份只含另一份、全取消禁用 + 文案 + 无请求、关开恢复；长章各段【相关设定】相同；`finish_reason:'length'` 显示「被截断」且无卡片；长章 K 次请求、第二段失败整次失败不显示第一段；全流程库里与 textarea 正文逐字相同；外传章节可检查且前情标题「外传第 N 章」；token 文案按遗留 #5。现有 `ChapterEditor.test.tsx`、`ReviseSheet.test.tsx` 不改且通过。
      Verify: `npx vitest --run src/features/writing` 通过；`npm run build`；全量全绿。

- [ ] 16. 文档。
      按设计第 10 节逐条改，保持「为什么」写法：`/Users/leadencedar/Production/Project/MyLiterature/docs/产品文档.md`（5.1 改写为两类例外；6.2 新增「写作规范」含世界观条目 vs 项目说明、为何不是文风、为何原文保存、为何翻译不带、为何精简另存、模板与为何不结构化；6.3 注入清单补规范、外传段前缀组成、新增「按规范检查本章」及为什么只提示不自动改、为什么不保存结果；7 信息架构知识库行与写作行；9 第 2 条与规范排在核心设定之前的理由）；`/Users/leadencedar/Production/Project/MyLiterature/docs/使用说明.md`（新增 5.5 写作规范、6.3 补临时取消、新增 6.6 按规范检查、10 省钱补充、目录同步）；`/Users/leadencedar/Production/Project/MyLiterature/docs/世界观写作指南.md`（新增小节「哪些内容写成写作规范，而不是世界观条目」；第 8 节提示词末尾加第 10 条，文案取设计第 10 节）。最后（建议项，必做完成后）`/Users/leadencedar/Production/Project/MyLiterature/docs/设计方案.md`：实体加 `WritingNorm`、装箱表插入写作规范、快照版本 3。
      Verify: 人工核对各章节号与目录一致；`npm run build` 与 `npx vitest --run` 仍全绿（文档不影响构建，确认未误改源码）。

- [ ] 17. 全量验证与交叉核对。
      跑 `npm run build`、`npx vitest --run`、`CI=1 npx vitest --run` 全绿（测试文件数 = 53 + 新增文件数，测试数 > 1268）；执行第 1 节第 5 点交叉核对并清理 `/tmp` 拷入物；`diff -ru /tmp/myliterature-baseline-writing-norms/src src` 确认：范围外三文件无 diff、`SettingsPage.tsx`/`translate.ts`/`TranslateSheet.tsx` 无 diff、现有测试文件只有允许的版本号断言改动、`noNormsBaseline.test.ts` 无快照断言；确认保存路径无模型调用与 trim、精简点保存前不写库、v6 只有 stores 无 upgrade。
      Verify: 上述命令全部通过并把结果（文件数/测试数/diff 摘要）写进最终报告。

## 3. 需求覆盖对照

- FR1–3、NFR3、NFR5、验收 1–5 → 步骤 2、3
- FR13、NFR6、验收 6–8 → 步骤 4
- FR7–10、NFR1、NFR2、验收 9–16 → 步骤 1、5–9
- FR4–6、FR11、NFR7、验收 17–21、23 → 步骤 10
- FR12、NFR4、验收 22 → 步骤 11
- FR15–20、验收 24–30 → 步骤 12–15
- 验收 31（端到端夹具）→ 步骤 9
- FR14 → 步骤 16；NFR8 → 每步 + 步骤 17
