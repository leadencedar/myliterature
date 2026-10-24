# 验证记录 · 写作规范（第 2 轮：修复代码审查发现）

轮次判断：`.agents/tasks/writing-norms/code-review.json` 存在，verdict 为 `CHANGES_REQUESTED`，所以这是修订轮。4 条发现都已修复，修复后全部验证重跑一遍，全绿。

## 1. 发现的处理

| #   | 级别           | 发现                             | 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | MEDIUM（阻塞） | 结果视图的「重新检查」跳过了表单 | 已修。`NormCheckSheet.tsx` 加了 `formRequested` 状态，`showResult` 现在还要求 `!formRequested`。结果视图的「重新检查」只把它设成 true、回到表单，不发请求；作者在表单里能看到按当前正文算出的分段数和 token，能临时取消规范，点「开始检查」才发请求（FR19、设计 1.7.4 / 1.7.6）。检查成功、停止、关掉再开都会把它清回 false，所以这些路径和以前一样：停止或关闭后看到的仍是上一次结果。补了两个测试，见下文。`使用说明.md` 6.6 末尾的说明也同步改了                                        |
| 2   | LOW            | 次要按钮不足 44px                | 已修。检查卡片上的「定位 / 按建议改写 / 忽略」（`NormCheckSheet.tsx`），以及编辑面板的「上传文件追加 / 插入差异说明模板」（`WritingNormEditorSheet.tsx`），从 `size="sm"`（h-9，36px）改成 `size="md"`（h-11，44px）。审查文档顺带提到了区块标题的「新建」，它不在 json 的发现里，写法也和现有 `StyleSection` 一致，所以没改                                                                                                                                                               |
| 3   | NIT            | 删除规范没有错误处理             | 已修。`WritingNormEditorSheet.remove()` 加了 try/catch：失败时先关确认框，否则提示会被它挡住；然后 `setError(messageOf(cause, '删除失败'))`，面板保持打开。补了测试 `WritingNormsSection.test.tsx`「删除失败：确认框关闭，面板内提示原因，库里不变」                                                                                                                                                                                                                                       |
| 4   | NIT            | 零变化护栏依赖两份复制的夹具     | 已修，没有改 `noNormsBaseline.test.ts`。`noNormsInputs.test.ts` 新增「夹具同步」用例：用 `?raw` 读两份源码，截取「夹具」分隔线到 `actual()` 结尾这一段；本文件多出的规范参数规整掉以后，必须与基线逐字相同，任何一份单独改动都会让这个用例直接失败。截取标记缺失时会抛错，不会变成空串比空串。文件头注释写明了原因，也说明了为什么不抽共享模块：抽出来就得改基线文件，而基线文件必须能原样拷回旧代码。验证过它不是空转：临时把本文件夹具里的 `oneLiner` 改掉一个字符，这个用例 ×；改回后 ✓ |

finding 1 的新测试（`NormCheckSheet.test.tsx`，「长章与失败」组）：

- 「结果里点『重新检查』先回到表单、不发请求；改短正文后说明行按新的 K 显示」：长章（K = 2）检查完共发 2 次请求，把正文换成短章后点「重新检查」。断言 picker（「参与检查的规范（本次带上 1 / 1 份）」）和 `本章约 N 字，输入…` 都出现、没有「将分」、没有旧卡片，请求仍是 2 次。点「开始检查」后请求变成 3 次（短章只发 1 次）。
- 「回到表单后不开始就关掉，再打开仍先看到上一次结果」：请求只有 1 次，重开后仍显示旧结果。

改动文件：`src/features/writing/NormCheckSheet.tsx`、`src/features/writing/NormCheckSheet.test.tsx`、`src/features/knowledge/WritingNormEditorSheet.tsx`、`src/features/knowledge/WritingNormsSection.test.tsx`、`src/context/noNormsInputs.test.ts`、`docs/使用说明.md`。都是本功能新建的文件或已改过的文档，没有动现有 prompt 断言，也没有动 `noNormsBaseline.test.ts`。

## 2. 构建与测试（项目目录 `/Users/leadencedar/Production/Project/MyLiterature`）

| 命令                                            | 结果                                       |
| ----------------------------------------------- | ------------------------------------------ |
| `npm run build`（`tsc --noEmit && vite build`） | 通过；只有改动前就有的 chunk > 500 kB 警告 |
| `npx vitest --run`                              | 62 个测试文件、1442 个测试全部通过，全绿   |
| `CI=1 npx vitest --run`                         | 62 个测试文件、1442 个测试全部通过，全绿   |

相比上一轮（62 / 1438）多了 4 个测试：检查面板 2 个、删除失败 1 个、夹具同步 1 个。没有新增测试文件。

## 3. noNormsBaseline 交叉校验（plan.md 第 1 节第 5 点）

```sh
cp src/context/noNormsBaseline.test.ts /tmp/myliterature-baseline-writing-norms/src/context/
ln -s /Users/leadencedar/Production/Project/MyLiterature/node_modules /tmp/myliterature-baseline-writing-norms/node_modules
(cd /tmp/myliterature-baseline-writing-norms && CI=1 npx vitest --run src/context/noNormsBaseline.test.ts)
rm -f /tmp/myliterature-baseline-writing-norms/src/context/noNormsBaseline.test.ts /tmp/myliterature-baseline-writing-norms/node_modules
```

- 基线代码副本上：1 个文件、4 个测试通过。当前代码上也通过（包含在全量里）。
- 拷贝前确认基线里没有这两个路径。跑完后已删除，`/tmp/myliterature-baseline-writing-norms/src/context/` 只剩原有的 4 个文件，也没有 `node_modules`。`/tmp` 下除基线目录外没有其他相关副本。
- `src` 下没有 `.snap` 文件，也没有 `__snapshots__` 目录。

## 4. diff 检查（plan.md 第 17 步）

命令：`diff -rq /tmp/myliterature-baseline-writing-norms/src src`、`diff -rq …/docs docs`、对范围外文件 `cmp`，再对每个改过的现有测试文件看 `diff -u` 的删除行。

- 范围外三文件 `DiagnosticsSection.tsx`、`diagnostics.ts`、`useActiveNovel.ts` 与基线逐字节相同。设计定下不改的 `SettingsPage.tsx`、`translate.ts`、`TranslateSheet.tsx` 也相同。
- diff 列表和上一轮相同，本轮没有新的文件进入 diff。
- 现有测试的删除行与上一轮完全一致，都在 `context.json` 允许的范围内：
  - `DexieNovelRepository.test.ts`：`verno` 5→6 三处，用例名「当前架构版本为 5」，一行 `import type`。
  - `backup.test.ts`：`BACKUP_VERSION` 2→3 及用例名；「来自更新版本」用例的 version 3→4 及用例名；`seedNovel` 返回值和解构多了 `norm`。
  - `sections.test.ts`：一行 import。
  - 其余六个现有测试文件没有删除行。
- 结论：没有改动任何提示词断言或快照，范围外文件与基线一致。
