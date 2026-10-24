# 设计审查 · 互动推演（世界线）

> **第 3 轮审查**（第 2 轮审查给出 CHANGES_REQUESTED；`design.md` 修订记录写明「第 3 轮设计，回应第 2 轮的 16 条」）。本循环最多 3 轮，这是最后一轮。
> 审查对象：`design.md`（第 3 轮）；对照 `brief.md`（唯一需求来源，已通读）、`requirements.md`、`docs/产品文档.md` 第 5、9 节，并到 `src/` 核对设计对现有代码的断言。

## 结论

**CHANGES_REQUESTED**：HIGH 0 条，MEDIUM 2 条，LOW 1 条，NIT 2 条。

第 2 轮的 16 条都已落实到对应章节，没有回退。简报 §3 的 9 个决策点及子问题（D1.1–D9.2，外加 D10–D13）都有推荐和理由，没有遗漏。还要改的两处 MEDIUM：

- 第 2 轮 #3 的修法要求「在回收站确认框里用 `role="alert"` 显示错误」，但 `TrashSheet` 用的是共享的 `ConfirmDialog`，它只接受字符串 `message`，放不下 alert。设计在 §8.3 自己写了「不用、也不改共享的 `ConfirmDialog`」，§8.5 却没说回收站怎么办，实现者只能二选一。
- D7.3 改写后写明「主角是通用条目时不在这里重复，它已在 `context.entries` 里」。`context.entries` 是候选列表，不是注入列表。通用主角能不能进 prompt 取决于默认预选，外传章节上没有任何来源能保证它被选中。

两处的改法都很小，见下文。

---

## 第 2 轮意见的落实情况

| 第 2 轮 # | 核对结果                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 HIGH    | 已落实（§4.2 末尾 `pruneScenarioRefs`、§6.1、§11、§13.2 五种本地行用例 + 合并后 `exportSnapshot → parseBackup`）。核对 `importSnapshot`（`DexieNovelRepository.ts:1198-1241`）：merge 是单事务逐表 `bulkPut`，清理放在同一事务里可行，前提是事务表列表加上两张新表（§6.1 已写） |
| 2 MEDIUM  | 已落实（D7.3 改为取本章最后一步，e2e 与 `chapterContext.test.ts` 补了对照组）。通用主角的注入有新缺口，见本轮 #2                                                                                                                                                                |
| 3 MEDIUM  | 部分落实：仓储、文案、列表小字、测试都写了，但「确认框内 alert」与现有组件不兼容，见本轮 #1                                                                                                                                                                                     |
| 4–11 LOW  | 已落实（`DeleteScenarioDialog`、F6.2 同步、`[a, b]` 补洞、卷节点 `scenarioSource = null`、追加外传按子树判定、补摘要触发时机统一、摘要关联的有意行为、`RequireNovel` 与推演不存在）。#8 的「最后一章」有边界问题，见本轮 #3                                                     |
| 12–16 NIT | 已落实                                                                                                                                                                                                                                                                          |

---

## 发现

### MEDIUM

**1. 回收站确认框装不下 `role="alert"`，§8.5 的修法与现有组件冲突**

- 位置：§8.5「回收站（`TrashSheet.tsx`）」第 1 点；§6.2 `hardDeleteEntry` 一行；§14 FEAT 1。
- 问题：`TrashSheet.tsx` 的「彻底删除」确认用的是共享的 `ConfirmDialog`（`ui/Sheet.tsx:171`），它的 props 只有 `open / title / message: string / confirmLabel / destructive / onConfirm / onCancel`，没有 children，也没有错误插槽。设计要求「在确认框里用 `role="alert"` 显示 `message`，确认框保持打开」，这在不改 `ConfirmDialog` 的前提下做不到。而 §8.3 刚写了「**不用、也不改共享的 `ConfirmDialog`**（改共享组件会波及所有调用点）」。实现者只能自己挑：改共享组件（违背 §8.3），或者把错误拼进 `message` 字符串（没有 `role="alert"`，§13.2 的 `TrashSheet.test.tsx` 断言就过不了）。
- 建议：与 `DeleteScenarioDialog` 同一做法，写进 §8.5 和 FEAT 1：
  - `TrashSheet` 里把 `ConfirmDialog` 换成本地拼的 `<Sheet size="dialog" title="彻底删除？" footer={取消 / 永久删除}>`，正文是原来那句「「X」将被永久删除，无法恢复。」，下面在 `purgeError` 非空时渲染 `<p role="alert">{purgeError}</p>`。
  - 按钮文案、`danger` 样式、`onClose = 取消` 与 `ConfirmDialog` 保持一致，现有回收站测试按角色和名称查找，不受影响。
  - `ui/Sheet.tsx` 不改。§14 FEAT 1 的「涉及文件」里 `TrashSheet.tsx` 后注明「本地确认框，不改 `ConfirmDialog`」。

**2. 通用主角在「写这一章」里不保证注入，外传章节上基本拿不到**

- 位置：D7.3 第一块「主角必选（主角是通用条目时不在这里重复，它已在 `context.entries` 里）」；D7.2「出场」行解析；§13.2 `scenarioChapter.e2e.test.tsx`（只测了新建 OC）。
- 问题：`context.entries` 是**候选**列表，进 prompt 的是 pinned 加上选中的条目（`SummaryChainContextBuilder.ts:138-141`）。默认选中由 `computeDefaultEntryIds`（同文件 349-397 行）算出，来源只有四个：目标大纲节点的 `linkedEntryIds`、上一章摘要的 `appearingEntryIds`，以及从**大纲节点标题 / 梗概、外传简介、上一章摘要**里做名称匹配。
  - 主线章节：主角名一般在「出场：」行，会写进 `linkedEntryIds`，大多能选中。但前提是模型在大纲里列了主角，不是硬保证。
  - 外传章节：没有大纲节点，`linkedEntryIds` 为空。细纲在 `chapter.scenarioSource.brief` 里，不在 hints 里。第一章还没有上一章摘要。所以除非外传简介正好写了主角名，通用主角（「引用一条已有人物条目」开局，这是最常见的用法）的档案**不会进**外传章节的请求。外传里的其他通用人物同理。
  - 这正是第 1 轮 #1 要防的情况（整章生成拿不到主角的身份和说话方式），只是换成了通用主角。
- 建议（不动现有调用点，也不影响零回归）：
  - `scenarioContext` 加两个字段：`castEntryIds: string[]` 和 `hintText: string`（本章各步原文 + 外传章节的 `brief`）。
  - 构建器**仅当 `scenarioContext` 存在时**：把 `castEntryIds` 里未删除、非 pinned 的通用条目并入**显式**默认预选（与 `linkedEntryIds` 同档）；把 `hintText` 追加进 `computeDefaultEntryIds` 的 hints。`scenarioContext` 不传时这两步都不走，基线不变。
  - 作者仍可在 `GenerateChapterSheet` 里取消勾选，符合「可见、可调」。
  - D7.3 那句改成「主角是通用条目时由默认预选的显式档保证（`castEntryIds`），不在这一块重复」。
  - `scenarioChapter.e2e.test.tsx` 加一例：用**已有的通用人物**开局，沉淀为**外传**，外传简介不提主角名，「写这一章」的请求 user 里含该人物的「说话方式」原文。`SummaryChainContextBuilder.test.ts` 加一例：传 `scenarioContext.castEntryIds` 时 `defaultEntryIds` 含主角，不传时与现在相同。

### LOW

**3. 「追加到外传」里的「最后一章」没排除无溯源的章节**

- 位置：§7.2 第 2 步（「当前节点在《X》最后一章 `scenarioSource.nodeIds` 最后一步（记为 `L`）的子树里」）。
- 问题：作者可以在外传末尾手动加章节，§4.2 的合并清理也可能把某章的 `scenarioSource` 置成 null。这时「最后一章」没有 `nodeIds`，`L` 未定义。
- 建议：`L` 取《X》里**按 `order` 最后一个 `scenarioSource` 非空的章节**的 `nodeIds` 末项；一章都没有时，《X》不参与「可追加」判定。新章节仍追加在《X》全部章节之后。`pathOutline.test.ts` 加一例：末尾有一章手写章节时仍能追加。

### NIT

4. `BackupSection.tsx` 有两处「id 相同的记录以备份为准」：第 31 行是选项说明，第 185 行是确认框文案。§4.2 只写了改一处。建议两处都补「同一个互动推演整棵分支树以备份为准」，或者在 §4.2 写明只改第 31 行。
5. §13.2 T5 补强用例里「之后点一个选项推进，才出现 summary 请求（在 step 请求之前或并行，按 D5.3 的 gap 规则）」没有给出确定的预期。按 D5.3，路径 12 步、第 5 步缺摘要时 `C` 不存在，`gap` = 9 > 7，是同步补。建议写死：「先发 1 次 summary 请求，完成后才发 step 请求」。

---

## 已核实的断言

- `importSnapshot`（`DexieNovelRepository.ts:1198-1241`）先整份 `RepositorySnapshotSchema.parse`，再在一个 `rw` 事务里逐表 `bulkPut`；replace 先 `clear`。在 merge 分支里整棵替换节点并调用 `pruneScenarioRefs` 可行，前提是事务的表列表里加上 `scenarios` / `scenarioNodes`（§6.1 已写）。
- `TrashSheet.purge()` 没有 try/catch。「彻底删除」确认用的是 `ConfirmDialog`（本轮 #1 的依据）。`TrashSheet` 的唯一挂载点是 `KnowledgePage.tsx:209`，它能拿到 `novelId`，所以 `listScenarios(novelId)` 可以直接调用。
- `Sheet` 支持 `size="dialog"`、`footer`、`children`，`DeleteScenarioDialog` 可以只靠它拼出来。`ConfirmDialog` 只接受字符串 `message`。
- `RequireNovel({ title, children: (novel) => ReactNode })` 存在，写作、知识库、计划页都用它；没有作品时显示「去书架」。
- `ProposalOriginSchema` 是 `generate / extract / refine`；提升用 `'refine'`、沉淀用 `'generate'`，不需要新增枚举值。
- `ChapterSummarySheet` 用传进来的 `entries` 列名（第 113 行），用 `resolveEntryNames` 解析出场（第 125 行），所以 §12.1 写的「摘要关联不到限定主角」属实。
- `GenerateChapterSheet` 的 `context` 类型是 `Omit<ContextRequest, 'selectedEntryIds' | 'recentSummaryCount' | 'excludedNormIds'>`；它先用默认预选构建一次，拿到 `defaultEntryIds`（第 83-101 行）。所以本轮 #2 的修法（在构建器内部扩展默认预选）不需要改这个组件。
- `computeDefaultEntryIds` 的四个来源与 `MAX_INFERRED_ENTRIES` 上限，以及 pinned 与选中条目的分流，均与本轮 #2 的描述一致。
- `requirements.md` F6.2 已同步为 replace，并写了理由。
- 第 2 轮「已核实的断言」里的其余各项（Dexie v6、`BACKUP_VERSION = 3`、`exportBackup` 不校验、构建器结构、`structured.ts` 的 system 拼接、`applyProposal` 的穷尽检查、`listEntries` 调用点、十类任务 builder、`JSON.stringify` 位置、路由与 `AppNav`、`TaskProfile` 字段）本轮没有被设计改动，结论不变。

## 没有核实或断言有误

- **有误**：§8.5「在确认框里用 `role="alert"` 显示」。回收站用的 `ConfirmDialog` 不支持，而设计又禁止改它（见 #1）。
- **有误**：D7.3「主角是通用条目时……它已在 `context.entries` 里」。进入候选不等于被注入，外传章节上通用主角不会被默认预选（见 #2）。
- **没有实际运行**：Zod 4 的 `toJSONSchema` 忽略 `.refine`，所以收尾 system 与步骤 system 逐字节相同。这与 Zod 4 的行为相符，由 `scenarioPrompt.test.ts` 兜底。
- **没有核实**：thinking 开 / 关两种请求之间是否共享服务端前缀缓存。设计已改为不依赖它。
- **没有实际运行**：「当前 62 个文件、1443 个测试全部通过」。本轮审查只读代码，没有运行测试。
