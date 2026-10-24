# 设计审查 · 写作规范（第 3 轮）

- 需求：`.agents/tasks/writing-norms/requirements.md` + `requirements-addendum.md`
- 设计：`.agents/tasks/writing-norms/design.md`（含第 1、2 轮修订记录）
- 结论：**CHANGES_REQUESTED**（HIGH 0 · MEDIUM 1 · LOW 4 · NIT 3）

第 2 轮的 10 条都已落到设计正文里，我逐条复核过（链接提示字面量、`reviseSeed` 清空时机、`locateQuote` 算法、`renderSummary` 前情块、`reorderWritingNorms` 校验、元信息作用范围渲染、段落加工临时取消测试、定位按钮显示条件、`llmFixtures.ts`、产品文档 6.3 外传段）。这一轮只剩一条 MEDIUM：AI 精简「另存」成功之后编辑面板怎么办没有写，按现有写法会让原规范被重新启用。

---

## 一、8 个核心问题逐条对照

| #   | 核心问题                                 | 设计位置      | 结论                                                                                                       |
| --- | ---------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | 数据模型                                 | 1.1、2、3、4  | 已回答：作品级 `WritingNorm` 单独成表，5 值作用范围，原文直接落库，不变量各有归属                          |
| 2   | 知识库页入口，不进入「导入旧稿」         | 1.2、7.1      | 已回答：风格档案之后加区块，复用 `readManuscriptFile`；明确不加「导入到 → 写作规范」并给出理由             |
| 3   | 各任务注入点、作用范围默认值、翻译建议   | 1.3、6.3、6.4 | 已回答：逐任务插入点表，默认五项全开，翻译不注入且不提供该作用范围                                         |
| 4   | 「本次注入」显示规范与 token，可临时取消 | 1.4、7.3      | 已回答：`kind: 'norm'` 条目 + `NormInjectionPicker` + `excludedNormIds`，只影响本次                        |
| 5   | 成本控制，AI 精简及其确认流程            | 1.5、4、7.2   | 已纳入：阈值 + 链接提示；精简走可编辑预览 → 另存（单事务、原文停用）。**另存之后的面板状态缺失，见发现 1** |
| 6   | 时间截面 / 差异说明是否结构化，模板按钮  | 1.6           | 已回答：本期自由文本 + 模板（全文给出），结构化列为后续                                                    |
| 7   | 违规检查                                 | 1.7           | 原 brief 默认「后续」，被 `requirements-addendum.md` 覆盖为本期实现；设计给出完整方案                      |
| 8   | 规范与世界观条目职责写进产品文档         | 1.8、10       | 已回答：职责对照表；产品文档 5.1 / 6.2 / 6.3 / 7 / 9 与两份指南的改法都写了                                |

## 二、产品原则核对

- **作者原文直接落库**：成立。产品文档 5.1（65–69 行）约束的是「所有生成结果」。`SetupSection.tsx` 有同类先例：「一句话是用户自己写的，不属于 AI 产出，直接落库」。设计的保存路径不调模型、不 trim、不建提案（2、4、7.2）。
- **AI 精简**：成立。可编辑预览，点「另存为新规范」才写库；仓储单事务新建精简版并停用原规范，原文不变（1.5、4）。第 10 节把 5.1 改成「两类自由文本例外」，文档不会自相矛盾。缺口是另存之后的 UI 状态，见发现 1。
- **注入点在稳定前缀、顺序逐字节可复现**：成立。构建器里 meta+style 之后、核心设定之前插入（6.3，和 `SummaryChainContextBuilder.ts` 91–131 行现有顺序吻合）。四个 `build*SystemPrompt` 的插入点和代码现有顺序一致。渲染只用 title / content 和固定文案，排序是全序（order → createdAt → id，按码元比较）。`composeSections` 会 trim 并过滤空段（`sections.ts`），构建器和 `writingNormsSection` 共用 `composeNormsSection`。
- **无规范时逐字节一致**：成立。`writingNormsSection` 返回 `''` 会被过滤掉；构建器在 `normBlocks` 为空时不 push、不 take，`items` 和 `estimatedTokens` 也不变。12.0 用旧代码产出的字面量 + `toBe`，12.0b 再到旧代码上交叉核对，护栏可靠。
- **产品文档第 9 节缓存策略**：符合。规范排在核心设定前面，作者确认核心设定时规范仍然命中缓存；第 10 节同步改了第 9 节的「稳定内容」清单。

---

## 三、发现

### 1. [MEDIUM] AI 精简「另存为新规范」成功后，编辑面板的状态没有定义，原规范可能被悄悄重新启用

- **位置**：1.5 流程第 3 步；7.2 第 7 点；第 9 节「另存精简版」一行；12.6 AI 精简用例。
- **证据**：设计只写了另存调用 `saveCondensedWritingNorm(norm.id, …)`。成功之后是否 `invalidate()`、面板关不关、草稿怎么处理，都没写。7.2 规定草稿只在「关 → 开」时重置（与 `StyleSheet` 同写法）。所以另存成功、面板仍开着的时候，草稿里 `enabled` 还是 `true`，库里的原规范已经是 `false`。作者这时点底部「保存」，`updateWritingNorm(id, { title, content, enabled: true, scopes })` 就会把原规范重新启用，两份同时注入。FR12 / 验收 22 要的「原规范停用」被一次普通保存静默撤销。另外，精简进行中和预览阶段，上面的标题 / 正文输入框能不能改也没有规定；改了之后另存会关掉面板，改动就丢了。
- **建议**：在 1.5 第 3 步和 7.2 第 7 点写明：
  ```text
  另存成功 → invalidate() → 关闭编辑面板；区块内显示 role="status"：
  「已另存为《{新标题}》，原规范已停用。」（3 秒后或下一次操作时消失）
  另存失败 → alert，面板与预览保持，什么都不写（与第 9 节一致）。
  condense.phase 为 'streaming' 或 'preview' 时：标题、正文、上传、模板、作用范围、启用开关与底部「保存」一律 disabled，
  只有预览框、「另存为新规范」「放弃」「停止」可操作；「放弃」后恢复可编辑。
  ```
  12.6 补断言：点「另存」后编辑面板关闭（`queryByRole('dialog', { name: '编辑写作规范' })` 为 null），状态提示出现；再打开原规范，「启用」开关为未勾选。预览阶段 `getByLabelText('正文')` 为 disabled。

### 2. [LOW] 「有未保存修改」的判定规则没有写

- **位置**：1.5「只对已保存且无未保存修改的规范可用」；7.2 第 7 点。
- **证据**：AI 精简按钮是否禁用取决于 dirty 判断，但比较哪几个字段、作用范围数组怎么比，没有说。直接比较数组引用，打开就会判为 dirty；按勾选顺序比较，勾掉再勾回同一项也会判为 dirty。
- **建议**：写成 `dirty = draft.title !== norm.title || draft.content !== norm.content || draft.enabled !== norm.enabled || normalizeNormScopes(draft.scopes).join() !== normalizeNormScopes(norm.scopes).join()`。`title` 不 trim 比较：库里存的是 trim 过的标题，草稿多一个空格时让作者先保存一次，更可预期。

### 3. [LOW] 另存精简版前没有 `validateNormDraft` 预检

- **位置**：1.5 第 3 步；第 4 节「UI 在调仓储前用 `validateNormDraft` 预检」只覆盖了新建 / 编辑；第 9 节「另存精简版 | 校验失败」。
- **证据**：作者把预览框清空，或者模型输出超过 60000 字时，`saveCondensedWritingNorm` 会抛 `ZodError`。按第 4 节的说法，`ZodError` 的 message 是 JSON，会原样显示在 alert 里。
- **建议**：另存前先调 `validateNormDraft({ title: condensedTitle(norm.title), content })`，有错误就把中文文案显示在预览下方、不调仓储；预览框 `trim()` 为空时「另存为新规范」直接 disabled。

### 4. [LOW] 检查系统提示里核心设定块的拼接格式没写

- **位置**：1.7.3 `buildNormCheckSystemPrompt`：「pinned 块（标题「【核心设定（供判断，不是检查对象）】」，空则省略）」。
- **证据**：块标题给了，标题和条目之间、条目和条目之间用什么分隔，条目按什么顺序，都没写。user prompt 的【相关设定】写了「条目之间空一行」，这里没有。这是稳定前缀，格式要唯一确定。
- **建议**：写成和构建器同样的格式：
  ```ts
  const pinnedBlock = pinnedEntries.length
    ? [
        '【核心设定（供判断，不是检查对象）】',
        ...pinnedEntries.map((e) => renderEntry(e, categories)),
      ].join('\n\n')
    : '';
  ```
  顺序沿用 `context.entries` 的顺序（`listEntries` 的返回顺序，和构建器一致），不另行排序。12.7b 加一条断言：两条核心设定按传入顺序出现，之间恰好一个空行。

### 5. [LOW] 检查面板「输入 token 估算」的口径没定义

- **位置**：1.7.4「表单阶段显示『本章约 N 字，将分 K 段检查（K 次调用）』与输入 token 估算」。
- **证据**：系统提示每段都要发一次，要不要乘以 K？JSON Schema 块（`generateStructured` 追加在 system 后面）算不算？都没说。不同实现给出的数字可能差好几倍。
- **建议**：定为 `K × estimateTokens(system) + Σ estimateTokens(user_i)`。`system` 指 `buildNormCheckSystemPrompt` 的输出，不含 schema 块（结构化输出的 schema 块在别的任务里也不计入展示）。文案：`本章约 N 字，将分 K 段检查（K 次调用），输入约 X tokens`，X 用 `formatTokens` 格式化；K = 1 时省略「分 K 段」。N 用 `countWords(content)`，和编辑器头部的字数一致。

### 6. [NIT] `extractWorldviewChunk` 写的是「同上」，但它现在不是 `Promise.all`

- **位置**：6.4 调用处表格。
- **证据**：`ImportScreen.tsx` 约 1116 行是单独一句 `await repository.listEntries(novel.id)`，不像 `extractOne`（991 行）那样用 `Promise.all`。
- **建议**：明确写成 `const [entries, norms] = await Promise.all([repository.listEntries(novel.id), repository.listWritingNorms(novel.id)])`。

### 7. [NIT] `ChapterEditorScreen` 需要新增 `useLlm()`，禁用原因的计时器要清理

- **位置**：1.7.6「禁用」。
- **证据**：`ChapterEditorScreen.tsx` 目前没有调用 `useLlm`（只有子面板调），而入口要读 `llm.configured`。「3 秒后消失」用的计时器没写在卸载或换章时清理。
- **建议**：注明在 `ChapterEditorScreen` 顶层加 `const llm = useLlm()`；原因提示用 `useRef<number>` 记计时器，再次点击和卸载时 `clearTimeout`。

### 8. [NIT] `createWritingNorm` 的实现行漏了 `normalizeNormScopes`

- **位置**：第 4 节实现表 `createWritingNorm` 一行。
- **证据**：不变量表说作用范围去重并按固定顺序存，归仓储（`normalizeNormScopes`）。但实现表里只有 `updateWritingNorm` 写了「规范化 scopes」，`createWritingNorm` 没写。
- **建议**：`createWritingNorm` 一行补「`scopes` 缺省为 `ALL_NORM_SCOPES`，传入时先 `normalizeNormScopes`，再 parse」；12.1 补一条用例：新建时传 `['check', 'writing', 'writing']`，存为 `['writing', 'check']`。

---

## 四、已核实的假设

| 设计里的说法                                                                                                                                                                   | 核实结果                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 当前 Dexie 架构版本为 v5，只新增表不写 upgrade 是现有惯例                                                                                                                      | `db.ts` 52/75/87/104/117 行依次是 v1–v5，没有更高版本；v2、v4 只用 `stores` ✓                                            |
| `BACKUP_VERSION = 2`；先校验文件头，`version > 当前` 报「来自更新版本」；然后整份 parse                                                                                        | `backup.ts` 25、101–112 行 ✓                                                                                             |
| 备份错误 detail 是 `路径：消息`                                                                                                                                                | `invalidContent` 用 `path.join('.')` ✓（作用范围非法值的实际路径是 `…scopes.0`，设计写的是「以对应路径开头」，可以匹配） |
| `RepositorySnapshotSchema` 各表 `.default([])`，带 superRefine；`schema.ts` 只引入 `./importJob`                                                                               | 539–589 行、13 行 ✓；`IdSchema` / `TimestampSchema` 在 15、17 行 ✓                                                       |
| `deleteNovel` / `importSnapshot` 用显式表列表 + 单事务；replace 模式逐表 clear                                                                                                 | `DexieNovelRepository.ts` 160–185、1060–1100 行 ✓                                                                        |
| 三处 `verno` 断言 `toBe(5)` 在 1627 / 1701 / 1811 行                                                                                                                           | ✓                                                                                                                        |
| 构建器稳定前缀顺序：meta+style（mandatory）→ 核心设定（mandatory，`【必须遵守的核心设定】` + `\n\n`）→ 勾选条目；`take` 遇空文本返回 `''`                                      | `SummaryChainContextBuilder.ts` 76–150 行 ✓                                                                              |
| `renderEntry`（412 行）、`renderSummary`（466 行）是模块内函数；`chapterWord` 为「第 / 外传第」                                                                                | ✓                                                                                                                        |
| `ContextItemKind` 现有 9 个值，没有穷举 Record                                                                                                                                 | `ContextBuilder.ts` 49–58 行 ✓；`MAX_INFERRED_ENTRIES = 8` 在 105 行 ✓                                                   |
| 摘要 / 提取 = 开场白 → `novelMetaSection` → TASK（提取后接分类说明）；大纲 / 立项 = 开场白 → `composeStylePrefix` → TASK（立项后接两段字段说明）                               | 四个 `build*SystemPrompt` ✓                                                                                              |
| 6 个注入任务的调用处正好是 `SetupSection`、`OutlineNodeSheet`、`ImportScreen`（1013、1125 行两处）、`ChapterSummarySheet`、`GenerateChapterSheet`、`ReviseSheet`               | 全仓 grep ✓，无遗漏                                                                                                      |
| `buildChapterSystemPrompt(stablePrefix)` / `buildReviseSystemPrompt(stablePrefix, action)` 只消费 stablePrefix                                                                 | ✓                                                                                                                        |
| `composeSections` 对每段 trim 后过滤空段，用 `\n\n` 连接                                                                                                                       | `sections.ts` ✓                                                                                                          |
| `estimateTokens` / `formatTokens` 是无依赖纯函数                                                                                                                               | `tokens.ts` 无 import ✓                                                                                                  |
| `TaskKind` / `TASK_PROFILES`（`TaskProfile` 字段 thinking / reasoningEffort / temperature / useStrongModel / structured / label）；只有 `useLlm.ts` 和 `SettingsPage.tsx` 引用 | ✓                                                                                                                        |
| `LlmErrorKind` 没有其他文件做穷举                                                                                                                                              | grep ✓                                                                                                                   |
| `generateStructured` 用 `client.chat`，`ChatResult.finishReason` 存在；现在不检查截断                                                                                          | `structured.ts`、`types.ts` 31–39 行 ✓                                                                                   |
| `runStructured(task, options)` 透传 `signal`、`onAttempt`；`runStream(task, options, handlers)` 第三个参数必填                                                                 | `useLlm.ts` ✓                                                                                                            |
| `completion(content, options?)` 在 `src/test/llmFixtures.ts`，options 目前只有 `reasoning`、`usage`                                                                            | 41 行 ✓                                                                                                                  |
| `readManuscriptFile` / `normalizeManuscript` / `ENCODING_LABELS` / `ACCEPTED_EXTENSIONS`（.txt .text .md .markdown）/ 20 MB / `.docx` 被拒 / `ManuscriptReadError`             | `readManuscript.ts` ✓                                                                                                    |
| `previousSummaryOf` 按线取最近一份更早的摘要（会跳过没有摘要的章）                                                                                                             | `chapterSummary.ts` 87–103 行 ✓                                                                                          |
| `mentionedEntries(text, entries)` 在 `src/domain/entrySearch.ts`，按传入顺序 filter，不管 pinned                                                                               | ✓                                                                                                                        |
| `chapterLabel` 返回「第 N 章」/「外传·X 第 N 章」                                                                                                                              | `sideStory.ts` 34 行 ✓                                                                                                   |
| `ReviseAction` 在 `revise.ts` 13 行导出；`ReviseSheet` 重置 effect 依赖 `[open, selection.text]`；`normalizeSelection` 只去首尾空白                                            | ✓                                                                                                                        |
| `ChapterEditorScreen` 有 `selectionRange` / `textareaRef`；摘要按钮带 `ml-auto`；底栏「加工这一段」先 `captureSelection()` 再打开                                              | ✓                                                                                                                        |
| `GenerateChapterSheet` 常驻挂载、没有打开时重置；「本次注入」块之后是核心设定提示；条目 chip 为 `px-3 py-1.5 text-xs`                                                          | ✓                                                                                                                        |
| `Sheet` 关闭时不做焦点还原，定位时 `textarea.focus()` 不会被抢回                                                                                                               | `Sheet.tsx` 只在打开时把焦点移入面板 ✓                                                                                   |
| `Toggle` 当前结构（div > span > label + input），没有 `aria-label` / 触控尺寸选项                                                                                              | `Controls.tsx` 182–213 行 ✓，设计 7.4 的改法可行                                                                         |
| `useRepoQuery` 靠全局版本号失效，`invalidate()` 后所有查询重拉                                                                                                                 | `useRepoQuery.ts` ✓                                                                                                      |
| 导入总是导入到已有作品（`novel.id`），「先建规范再导入」成立                                                                                                                   | `ImportScreen.tsx` ✓                                                                                                     |
| 产品文档 5.1 写的是「唯一的例外是正文散文」；第 9 节稳定内容清单；第 7 节知识库 / 写作两行；6.3 外传段的前缀组成                                                               | `产品文档.md` 65–69、248–260、141–163、326–332 行 ✓                                                                      |
| 范围外的 3 个文件没有引用任何会被改动的类型，设计的文件清单也不含它们                                                                                                          | ✓                                                                                                                        |
| 当前 `src` 和 `/tmp/myliterature-baseline-writing-norms/src` 完全一致，12.0 的基线能在未改动的代码上产出                                                                       | `diff -rq` 无输出 ✓                                                                                                      |

## 五、未核实或有误的假设

- **AI 精简另存之后的界面状态**：设计默认它无需说明，实际上会和「只在打开时重置草稿」的规则冲突，见发现 1。
- **`extractWorldviewChunk` 已经用了 `Promise.all`**：6.4 用「同上」默认了这一点，实际是单独 `await`，见发现 6。
- **`ChapterEditorScreen` 已经能拿到 `llm.configured`**：实际没有调用 `useLlm`，见发现 7。
- **需求补充的来源**：`requirements-addendum.md` 引用的用户原话不在本工作流收到的原始消息里，我无法核实。它不和原始消息冲突，审查按有效处理。
- **运行时行为**：fake-indexeddb 下 v5 → v6 升级、`failOnTruncation` 的单次请求断言、Zod 4 `toJSONSchema(io: 'output')` 对 `NormCheckResultSchema` 的输出，要等实现阶段的测试跑过才算确认。我只核实了声明方式和现有惯例一致，没有实际运行。
