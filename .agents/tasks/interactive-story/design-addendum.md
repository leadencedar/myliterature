# 设计补充：第 3 轮设计审查的遗留发现（必须在实现中落实）

用户决定结束设计审查循环、直接进入规划。下列 5 条来自 `.agents/tasks/interactive-story/design-verdict.json`（第 3 轮，CHANGES_REQUESTED）以及 `design-review.md`，design.md 尚未吸收，**优先级等同 design.md**。plan 必须把它们排进对应的 FEAT，code 必须实现，code-review 必须逐条核对。

1. **[MEDIUM] 回收站「彻底删除」的错误提示**：TrashSheet 的彻底删除目前用共享的 ConfirmDialog。它只接受字符串 message，没有 children，也没有错误插槽，框内放不下 `role="alert"`。这与 §8.5 冲突，也与 §8.3「不改 ConfirmDialog」冲突。
   - 改法：TrashSheet 改用本地拼的 `<Sheet size="dialog">` 加 footer（取消 / 永久删除，danger 样式）。`purgeError` 非空时渲染 `<p role="alert">`。`ui/Sheet.tsx` 与 ConfirmDialog 都不改。
   - 归属：写进 FEAT 1。
   - 测试：删除失败时框内出现 alert，框保持打开。

2. **[MEDIUM] 用通用人物当 OC 时，「写这一章」不保证注入主角**：D7.3 说通用主角「已在 context.entries 里」，但 context.entries 只是候选。computeDefaultEntryIds 只看三样：linkedEntryIds、上一章的 appearingEntryIds、大纲 / 外传简介 / 上一章摘要里的名称匹配。外传章节没有大纲节点，brief 也不在 hints 里，所以通用主角不会被默认预选。
   - 改法：scenarioContext 增加 `castEntryIds` 与 `hintText`。构建器**仅在 scenarioContext 存在时**才做两件事：把 castEntryIds 并入显式的默认预选；把 hintText 追加进 hints。没有 scenarioContext 时，构建结果与改动前**逐字节一致**，零回归基线测试必须继续通过。
   - 测试：
     - 端到端：通用人物开局 → 沉淀为外传 → 「写这一章」的请求中包含该人物的「说话方式」字段内容。
     - 构建器单测：有与无 scenarioContext 两种情况的对照。

3. **[LOW] 「追加到外传」时的「最后一章」**：外传末尾如果是手写章节，或经合并清理后 scenarioSource 为 null，L 就没有定义。
   - 改法：L 取按 order 排列后、最后一个 scenarioSource 非空的章节，再取其 nodeIds 的末项。外传一章带溯源的都没有时，不参与可追加判定。
   - 测试：在 pathOutline.test.ts 加一例。

4. **[NIT] BackupSection 两处合并说明文案**：第 31 行的选项说明与第 185 行的确认文案，都写了「id 相同的记录以备份为准」。§4.2 只说改一处；两处都要按 §4.2 同步修改。

5. **[NIT] T5 补强用例里 summary 请求的时序**：路径 12 步、第 5 步缺摘要时，按 D5.3 计算 gap = 9 > 7，属于同步补摘要。用例的预期要按 D5.3 写成确定的时序：先发 1 次 summary 请求，它完成后才发 step 请求。断言请求顺序，不允许二者并发。如果 D5.3 的阈值或计算方式有变，同步更新这个预期。
