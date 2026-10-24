# 修复日志：导入目的地后置 + 外传

## 第 1 轮（集成验证，无 review.md）

基线：`npm run build` 通过；`npx vitest --run` 53 文件 / 1258 测试全过。

对照 design.md 1.3 验收 1–20 与第 11 节测试清单，检查了 FEAT 之间的接缝：

- 章节标签：ImportScreen（提取进度、摘要提案 label/sourceRef、提取列表）、ChapterSummarySheet、ChapterEditorScreen、GlossarySheet、ExportSheet、exportText 都用 `@/domain/sideStory` 的 `chapterLabel` / `sideStoryLabel`。导入与写作侧产出的外传摘要提案标签一致：「外传·X 第 N 章摘要」，sourceRef「外传·X 第 N 章」。GlossarySheet 没有本地的 `chapterLabel`。
- `sideStory` 提案：ProposalInbox / ProposalReview 没有按 target 区分的映射，字段统一来自 `fieldSpecsFor`，所以 `sideStory` 能正常渲染（「外传进展摘要」长文本字段）。apply 的逐条失败语义对它同样适用。
- 按线过滤：WritingPage 的大纲章数、全书进度，以及上下文、摘要链、导出、统计，都经过 `chaptersOfTrack`。文风取样只取本批导入的章节。没有其他功能页面按章号自己计算"上一章/下一章"。
- 每日日志：编辑器的 `recordProgress` 不区分线，外传章节照常记入（验收 15）；导入不记入。

没有发现坏掉的接缝。第 11 节已有覆盖的项没再动；有两处跨 FEAT 的行为之前没有测试覆盖，这轮补上了：

- `src/features/proposals/ProposalInbox.test.tsx` +2：`sideStory` 提案在收件箱里渲染外传进展字段和来源，采用后只更新 `SideStory.rollingSummary`、`Novel.rollingSummary` 不变；外传已删时 alert 显示「这部外传已不存在，可能已被删除」，提案留在待确认里。
- `src/features/writing/ChapterEditor.test.tsx` +1：外传章节的字数照常记入当日日志（验收 15）。
- `docs/开发计划.md`：增量记录里的测试数改成实际输出 1261（新增 238）。

产品代码没改。范围外文件和 review.json 都没动。

最终：`npm run build` 通过（只有原来就有的 chunk > 500kB 提示）；`npx vitest --run` 53 文件 / 1261 测试全过。

## 第 2 轮（按 review.md 修 5 条发现）

1. **MEDIUM · 全量测试不稳定**：`ImportScreen.destination.test.tsx` 两处勾选后同步 `getByRole('开始翻译（1 章）')` 改成 `await findByRole`。修完连跑 12 次全量，12 次全绿。
2. **MEDIUM · 草稿写入的存储错误被静默吞掉**：`DraftsRejectedError` 带上原始 message 和写入前的任务 id。`resumeAfterRejection(rejected)` 照旧重读、按加载规则定步骤，重读到的如果还是同一批草稿（`destination === null`、id 没变），就返回 true，调用方显示 alert。被别处提交、放弃或换成另一批草稿时，行为和原来一样，仍然静默。文案：
   - 译文写回：「第 N 章的译文没存上：{msg}。浏览器存储可能已满，可以先导出备份。」循环停下，这一章在库里仍是待译。
   - 标记失败也没存上：「第 N 章翻译失败：{原因}；失败状态也没存上：{msg}。…」
   - 勾选 / 重试 / 跳过剩下的：分别是「第 N 章的翻译设置没存上」「第 N 章没能重新排进待译」「跳过剩下的章节没存上」，后面都接同一句存储提示。
   - 新增用例：译文写回 reject 一次普通 `Error`，断言出现 alert、只发了 1 次翻译请求、两章仍是 pending、任务还在草稿阶段；勾选写入 reject，断言出现 alert、勾选框和库里的状态都没变。原有的「另一处写成主线 / 另一处放弃」两条静默用例照常通过。
   - `docs/开发计划.md` 里「界面收到拒绝后静默重读」的说法改成了现在的区分规则。
3. **NIT · 外传名称前缀剥得太宽**：`TITLE_PREFIX` 改成 `/^(?:外传|番外)(?:[·・:：\s]+|$)/u`。`sideStory.test.ts` 加了两条：「番外篇」「外传之谜」原样保留；只填「外传」或「 番外： 」时归一化成空串。
4. **NIT · commit 被拒且任务已不在时卡在目的地步骤**：`handleCommitRejected` 读到 `undefined` 时调 `resumeFrom(undefined)` 回到粘贴步骤，并显示 note「这批稿件已经在别处放弃了，这次没有写入；需要的话重新粘贴导入」。读到坏行（parse 不过）同样交给 `resumeFrom`，清掉坏行并显示原有的 DISCARD_NOTICE。只有读取本身抛错时，才保留原来的做法：留在目的地步骤显示 alert。新增两条用例，分别覆盖「已在别处放弃」和「重读抛错」。
5. **NIT · 勾选翻译没有防重入**：没按评审建议直接用 `event.target.checked`。复选框是受控的，第一次写入返回之前状态没变，第二下点击读到的 `checked` 和第一下一样，照样会丢一下。改成用 `requestedTranslateRef`（index → 最近一次点击想要的值）来取反，写完就清掉。两次写入按发起顺序在 IndexedDB 里串行执行，最后落盘的是最后一次点击的值。新增用例先把 `patchImportDrafts` 挂起，再连点两下，断言两次写入依次是 `none`、`pending`，放行后库里和界面都回到「要译」。

范围外的三个文件和 review.json 都没动。

最终：`npm run build` 通过（只有原来就有的 chunk > 500kB 提示）；`npx vitest --run` 53 文件 / 1268 测试全过，连跑 12 次全绿。比上一轮多 7 条：destination 用例 +5，sideStory +2。`docs/开发计划.md` 里的测试数同步改成了 1268。
