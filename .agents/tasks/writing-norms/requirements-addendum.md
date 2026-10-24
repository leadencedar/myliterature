# 需求补充（用户在工作流启动后追加，优先级高于原 brief 中的对应默认）

用户原话：「按规范检查本章可以这次就做」。

原 brief 第 7 条「违规检查（可选）：默认本期不做」**作废**，改为**本期必须实现**：

## 按规范检查本章

- 入口：章节编辑器（主线与外传章节都可用），移动端与桌面端都要合理。
- 行为：用当前作品**启用**的写作规范（建议仅限作用范围包含「检查」的规范；新增一个作用范围项，默认开启）+ 本章正文，调用模型列出**可能违反规范之处**。
- 输出必须结构化（Zod schema，沿用 `llm.runStructured` 与修复重试机制），每条至少包含：
  - 违反的是哪份规范、哪一条（引用规范原文片段）
  - 正文中的位置（引用原句片段，便于定位；能定位时提供跳转/高亮）
  - 问题说明
  - 可选的修改建议
  - 置信度或严重程度（例如「明确违反 / 可能违反 / 需作者判断」）
- **只提示，不自动修改正文**。作者可以逐条忽略；采用修改建议时走现有的段落加工 / 可编辑预览路径，正文改动仍由作者确认（符合产品原则 5.1：散文走预览，不进提案管道）。
- 没有任何启用规范时，入口禁用并提示「先在知识库添加写作规范」。
- 未配置模型时禁用并提示。
- 可以带上相关上下文以减少误报：本章关联的知识条目、核心设定、上一章摘要（遵守 prompt 缓存策略：规范与知识等稳定内容在前缀，本章正文在尾部）。设计决定注入哪些，说明取舍。
- 长章节：说明超长正文的处理（分段检查或给出提示），与翻译截断检测一样，若模型输出被截断（finishReason === 'length'）要明确报错，不能静默返回不完整结果。
- 检查结果是否持久化（例如按章保存最近一次结果、正文修改后标记过期）由设计决定；默认可以仅保存在会话内，若持久化需说明 Dexie 字段与备份影响。
- 新增 task profile（如 `norm-check`）：结构化推理任务，开思维链、低温度，用常规模型还是重点任务模型由设计决定。

## 测试补充

- 有启用规范时，检查请求的 prompt 包含规范与本章正文；停用或作用范围不含检查的规范不进入。
- 模型返回的违规条目正确渲染，能定位到原文片段；忽略某条后不再显示。
- 没有规范、或未配置模型时入口禁用。
- finishReason 为 'length' 时显示截断错误。
- 检查过程不修改章节正文（断言正文前后一致）。

## 文档补充

在 docs/产品文档.md 6.3 写作中加入「按规范检查本章」，说明为什么只提示不自动改。

---

# 补充 2：第 3 轮设计审查的遗留发现（必须在实现中落实）

用户决定结束设计审查循环、直接进入规划。下列 8 条来自 `.agents/tasks/writing-norms/design-review.json`（第 3 轮，CHANGES_REQUESTED），design.md 尚未吸收，**优先级等同 design.md**：plan 必须把它们排进实现项，code 必须实现，code-review 必须逐条核对。

1. **[MEDIUM] AI 精简「另存为新规范」后的面板状态**：另存成功 → `invalidate()` → 关闭编辑面板，规范区块内显示 `role="status"`「已另存为《{新标题}》，原规范已停用。」；失败时保持面板与预览不变。精简处于 streaming / preview 阶段时，禁用标题、正文、上传、模板、作用范围、启用开关与底部「保存」。测试（12.6）：断言另存后面板关闭；重开原规范时「启用」未勾选；预览阶段正文输入框为 disabled。
2. **[LOW] 未保存修改的判定**：`dirty = title/content/enabled 严格比较 || normalizeNormScopes(draft.scopes).join() !== normalizeNormScopes(norm.scopes).join()`。
3. **[LOW] 另存精简版前预检**：另存前先 `validateNormDraft({ title: condensedTitle(norm.title), content })`。有错误时在预览下方显示中文文案，不调用仓储，绝不把 ZodError 的 JSON message 显示给用户。预览 trim 后为空时「另存」按钮 disabled。
4. **[LOW] 检查系统提示里的核心设定块**：`['【核心设定（供判断，不是检查对象）】', ...pinned.map((e) => renderEntry(e, categories))].join('\n\n')`，顺序沿用 `context.entries`。测试（12.7b）：断言两条核心设定按顺序出现，且之间恰好一个空行。
5. **[LOW] 检查面板的 token 估算口径**：`X = K × estimateTokens(system) + Σ estimateTokens(user_i)`，不含 schema 块。文案为「本章约 N 字，将分 K 段检查（K 次调用），输入约 X tokens」，其中 `N = countWords(content)`；K = 1 时省略分段那部分。
6. **[NIT] extractWorldviewChunk 的取数**：用 `const [entries, norms] = await Promise.all([repository.listEntries(novel.id), repository.listWritingNorms(novel.id)])`。
7. **[NIT] ChapterEditorScreen**：顶层新增 `const llm = useLlm()`。禁用原因提示的 3 秒计时器存进 `useRef`，再次点击和卸载时都要 `clearTimeout`。
8. **[NIT] createWritingNorm**：`scopes` 缺省时为 `ALL_NORM_SCOPES`；传入时先 `normalizeNormScopes` 再 parse。测试（12.1）补一个用例：`['check','writing','writing']` → `['writing','check']`。
