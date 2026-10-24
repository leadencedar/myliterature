# 验证记录 · 互动推演（世界线）

## 轮次

第 1 轮（`code-verdict.json` 不存在）：跨 FEAT 集成验证。

## 检查项（对照 requirements.md / design.md / design-addendum.md）

改动前先跑了一遍：`npm run build` 通过；`npx vitest --run` 75 个文件 / 1717 个测试全绿。随后逐条核对各阶段之间的接缝（看代码与对应测试）：

| 接缝                                                                                                                                                     | 结论         | 依据                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Dexie v7 升级（v6 → v7，条目补 scope / fieldLocks，三表补 scenarioSource，规范五项全开补 interactive）                                                   | 已落实       | `src/data/dexie/db.ts`；`DexieNovelRepository.test.ts`「当前架构版本为 7」与迁移用例                                                 |
| 备份 v4；v1–v3 恢复 / 合并（推演为空、条目通用、溯源 null、v3 五项规范 → 六项）；v4 往返；规则 1–10 拒绝                                                 | 已落实       | `backup.ts`、`schema.ts` superRefine；`backup.test.ts`「互动推演与备份 v4」一节                                                      |
| 差异沿树继承、兄弟分支隔离；限定条目只在指定推演 / 子树可见                                                                                              | 已落实       | `domain/worldline.ts` effectiveKnowledge / visibleEntries；`worldline.test.ts` T1                                                    |
| 锁定字段不可覆盖（AI 产出、手动编辑、提升三条路）                                                                                                        | 已落实       | sanitizeDelta、仓储 updateScenarioNodeDelta、DeltaEditor 只列可变字段、promote.ts；对应测试 T2 / 验收 7–10                           |
| 已走过选项不能再选；切回旧线可继续推进                                                                                                                   | 已落实       | walkedChoices、appendScenarioNode 拒绝、ScenarioPage 全流程用例                                                                      |
| 主线跟随「最近一次推进」；只查看不改主线                                                                                                                 | 已落实       | appendScenarioNode 改 mainNodeId、setScenarioCursor 只改 cursor；scenario.test.ts 主线序列、ScenarioPage 徽标                        |
| 回退 / 跳转 / 切换 / 打开状态面板不发请求                                                                                                                | 已落实       | ScenarioPage 跳转只调 setScenarioCursor；T5 补强用例（addendum 5）全程 fetch 0 次，推进时先 1 次 summary 完成后才 step               |
| 坏结局后可回退                                                                                                                                           | 已落实       | ScenarioPage 结局区「回到上一个挑战」；全流程用例                                                                                    |
| 「提升为世界观」走提案（replace / create / merge + promoteFrom）                                                                                         | 已落实       | promote.ts、apply.ts；promote.test.ts、apply.test.ts、ScenarioPage 提升用例                                                          |
| 沉淀大纲走提案（scenarioOutline:create）                                                                                                                 | 已落实       | pathOutline.ts、SedimentSheet.tsx、apply.ts；SedimentSheet.test.tsx、apply.test.ts                                                   |
| 外传记录分叉点；整理外传章节时带上分叉前前情；导出不含共用前半段                                                                                         | 已落实       | commitScenarioOutline 外传分支、chapterContext.ts forkText；scenarioChapter.e2e.test.tsx                                             |
| scenarioContext 的 castEntryIds / hintText 仅在存在时生效                                                                                                | 已落实       | `SummaryChainContextBuilder.ts` 两处 `if (scenario)`；有 / 无对照用例；noScenarioBaseline / noNormsBaseline / noNormsInputs 未改且绿 |
| design-addendum 第 1 条（TrashSheet 本地 Sheet + role=alert）                                                                                            | 已落实       | `TrashSheet.tsx`；`TrashSheet.test.tsx`                                                                                              |
| design-addendum 第 2 条（通用主角注入「写这一章」）                                                                                                      | 已落实       | chapterContext castEntryIds；e2e 用例 + 构建器对照                                                                                   |
| design-addendum 第 3 条（追加外传的 L 取最后一个带溯源章节）                                                                                             | 已落实       | `lastSedimentedNodeOf`；pathOutline.test.ts「外传末尾是手写章节」                                                                    |
| design-addendum 第 4 条（BackupSection 两处合并说明）                                                                                                    | 已落实       | `BackupSection.tsx` 第 31、185 行同文                                                                                                |
| design-addendum 第 5 条（T5 summary / step 时序）                                                                                                        | 已落实       | ScenarioPage.test.tsx T5 补强用例断言顺序、挂起期间只有 1 次请求                                                                     |
| 移动端 / 桌面端 UI（单套 DOM；面包屑窄屏 CSS 折叠；tap-target；选项 min-h-12；reading-column；底部栏 sticky + 安全区；⌘/Ctrl+Enter 带 isComposing 守卫） | 代码层已落实 | ScenarioPage.tsx、ScenarioBreadcrumb.tsx、index.css 的 tap-target / reading-column 工具类                                            |

### 发现的缺口

1. **design.md §11「一段路径已沉淀为外传后又成了主线」未实现**：设计要求沉淀面板提示「其中第 a–b 步已沉淀为外传《X》」，仍允许沉淀进主线。FEAT-006 findings 也记了它没实现。属于设计已定义的行为，已补上。

## 修改的文件

- `/Users/leadencedar/Production/Project/MyLiterature/src/domain/scenario.ts`：新增纯函数 `sideSedimentOverlaps({ scenarioId, span, nodes, sideStories, chapters })`，按外传章节的 `scenarioSource` 现算本次主线范围内已沉淀进本推演外传的步骤，返回各外传与重叠的首尾步数。对应缺口 1。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/scenario/SedimentSheet.tsx`：主线模式下用 `sideSedimentOverlaps` 显示「其中第 a–b 步已沉淀为外传《X》」，只提示、不禁用「生成大纲」。对应缺口 1。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/scenario/pathOutline.test.ts`：新增 describe「sideSedimentOverlaps」1 例（本推演外传重叠给出首尾步数；别的推演与已清空的溯源不算；范围不含时为空）。对应缺口 1。
- `/Users/leadencedar/Production/Project/MyLiterature/src/features/scenario/SedimentSheet.test.tsx`：新增 1 例（第 2–3 步先沉淀为外传《雾中》、后成主线 → 面板出现提示，「生成大纲」仍可用，打开面板 fetch 0 次）。对应缺口 1。
- `/Users/leadencedar/Production/Project/MyLiterature/docs/产品文档.md`：§6.8「沉淀」段末补一句该提示，与实现一致（FEAT-006 当时因未实现而没写）。对应缺口 1。

未修改：noScenarioBaseline.test.ts、noNormsBaseline.test.ts、noNormsInputs.test.ts；与本功能无关的现有功能。

## 结果

- `npm run build`：通过（只有既有的 chunk > 500 kB 提示）。
- `npx vitest --run`：75 个测试文件、1719 个测试全部通过（改动前 75 / 1717，新增 2 个用例），无失败、无跳过。

## 未能自动验证

- 375px / 1280px 的视觉形态（验收 40）jsdom 验不了，需手测。
