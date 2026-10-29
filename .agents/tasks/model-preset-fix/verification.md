# DeepSeek 预置模型名修正 · 独立验证报告（task-66）

> 验证人：qa-verifier（独立于开发）
> 对象：task-65 —— DeepSeek `PROVIDER_PRESETS` 的 `model` / `strongModel` 改为 `deepseek-chat`；SettingsPage placeholder、测试期望、docs 同步
> 代码状态：改动在工作区（dev 未 commit），dev 停手
> 验证时间：2026-10-29 11:00–11:05 CST
> 边界：QA 只写本任务目录；不改 feature/开发测试；未 commit。

---

## 1. 结论

**通过，可提交。** 静态配置、Settings 展示、请求体行为、手动改模型名路径全部验证正确；旧模型名在 `src/`、`docs/`、`package.json` 中 grep 为 0（唯一例外是 `SettingsPage.test.tsx:54` 的**负向断言**，用于证明不出现旧名，属预期）；默认/串行全量、typecheck/build 全绿。**真实 Key live 交叉印证**（Lead 执行）：A/B/C 全通过、`model/strongModel=deepseek-chat`、C 3306/3000（110%，未触发 115% 超出提示）、缓存命中 90%+。

---

## 2. 变更核对

| 项 | 结果 |
| --- | --- |
| `src/llm/presets.ts`：`PROVIDER_PRESETS.deepseek.model = 'deepseek-chat'` | ✅ |
| 同 `strongModel = 'deepseek-chat'`；note 注明「默认 deepseek-chat（可手动改成更强的模型）」 | ✅ |
| `SettingsPage.tsx` 两个模型 placeholder → `deepseek-chat` | ✅（运行时读取 DOM 确认值/placeholder 均为 `deepseek-chat`） |
| docs 同步：`docs/开发计划.md`、`docs/设计方案.md` 旧模型名替换为 `deepseek-chat`（官方当前通用模型，可手动改） | ✅（diff 核对） |
| 开发测试同步：SettingsPage/SetupSection/ChapterEditor/WritingPage/structured/OpenAiCompatibleClient | ✅（全量测试绿） |
| dev 对 QA `src/test/m3/m3-s4-continue-ui.test.tsx` 的改动 | ✅ 仅 `outline-continue` 请求体断言 `deepseek-v4-pro` → `deepseek-chat`，未放宽其它断言（diff 逐行核对） |
| 新增回归断言 `applyPreset('deepseek')` 后 store 与 `PROVIDER_PRESETS.deepseek` 的 model/strongModel 均 `deepseek-chat` | ✅（SettingsPage.test 通过） |

---

## 3. 静态 grep（旧模型名）

`grep -rn "deepseek-flash|deepseek-v4-pro" src docs package.json`：

- 唯一结果：`src/features/settings/SettingsPage.test.tsx:54` —— 负向断言 `/deepseek-flash|deepseek-v4-pro/u`（`not.toMatch`），**预期保留**，不计问题。
- `src/`、`docs/`、`package.json` 其余位置 **0**。

---

## 4. 运行时独立验证（真浏览器 + dev server，不依赖开发测试）

脚本：`.agents/tasks/model-preset-fix/preset-check.mjs`；结果：`.agents/tasks/model-preset-fix/behavior-check.json`。
**16 项全部通过**：

### 4.1 预设 / applyPreset / 模型解析（页内 dynamic import 生产模块）
- `PROVIDER_PRESETS.deepseek.model === 'deepseek-chat'` ✅
- `PROVIDER_PRESETS.deepseek.strongModel === 'deepseek-chat'` ✅
- `applyPreset('deepseek')` 后 store.model / store.strongModel 均 `deepseek-chat` ✅
- `resolveModel(settings, 'chapter-draft') === 'deepseek-chat'` ✅
- `resolveModel(settings, 'outline-continue')（重点任务）=== 'deepseek-chat'` ✅

### 4.2 SettingsPage 展示
- 常规模型：value=`deepseek-chat`、placeholder=`deepseek-chat` ✅
- 重点任务模型：value=`deepseek-chat`、placeholder=`deepseek-chat` ✅

### 4.3 用户手动改模型名（不覆盖 store）
- 在设置页把「常规模型」改成 `my-custom-model` 并失焦 → store.model=`my-custom-model` ✅
- zustand persist（`myliterature.llm-settings`）中 `state.model='my-custom-model'` ✅
- `resolveModel(..., 'chapter-draft')` 跟随为 `my-custom-model`（请求将使用自定义名）✅
- 验证后已 `applyPreset('deepseek')` 恢复默认，避免污染后续断言。

### 4.4 真实请求体 model（page.route 拦截 `api.deepseek.com/**`，记录 POST body）
- 连通性测试（stream）请求体：`model='deepseek-chat'` ✅
- `outline-continue`（重点任务，结构化非流式）请求体：`model='deepseek-chat'` ✅
- 全程 0 pageerror ✅

---

## 5. 门禁（干净工作区，dev 停手；门禁前后 `git diff src` md5 一致 `c696b6a…`）

| 命令 | 结果 |
| --- | --- |
| 默认并行 `npx vitest run` | ✅ **126 files passed + 1 skipped（127）；2470 tests passed + 4 skipped（2474）**，0 失败 |
| `npx vitest run --maxWorkers=1` | ✅ 同 2470 / 2474 |
| `npm run typecheck` | ✅ 无输出 |
| `npm run build` | ✅ 150ms |
| QA 套件 | m2 88、m3 37、m1 215+1 skipped 全绿 |

---

## 6. 发现与建议（复核后更新，2026-10-29 11:08）

初版报告曾记 2 条 P2/P3 陈旧项；复核当前工作区后确认**均已在工作区修复**（不是本报告作者改的，也未再动任何文件）：

1. **P2 已修复**：`.agents/tasks/real-device-live-check/README.md` 的 env 表现在 `REAL_LLM_MODEL` / `REAL_LLM_STRONG_MODEL` 默认值均写「预置 `deepseek-chat`」，并补充「应用 DeepSeek 预置已改为官方 deepseek-chat（常规与重点任务同模型）；如需用其他模型再显式覆盖…」。
2. **P3 已修复**：`ux/run-demo.mjs`、`ux/device-check.mjs` 的假 LLM settings 均为 `model: 'deepseek-chat'` / `strongModel: 'deepseek-chat'`，两个脚本内旧名 grep = 0（仅 mock 夹具，本无产品影响）。
3. 全仓旧名剩余项均属**预期/历史**：
   - `src/features/settings/SettingsPage.test.tsx:54` —— 负向断言（证明不出现旧名）；
   - `docs/开发计划.md:1686` —— 变更说明句「应用原先的 deepseek-flash / deepseek-v4-pro 会 404」，解释修复必要性的历史描述；
   - `.agents/` 下历史报告/任务文档/transcript（历史证据，不宜改写）。
   即「代码/文档（排除历史说明与负向断言）」当前已严格零命中。

---

## 7. 风险 / 未覆盖

1. 真实端点行为已由 Lead 用真实 Key 跑 live（不覆盖模型名）验证：A/B/C 全通过、`deepseek-chat` 生效、缓存命中 90%+；本报告不重复真实调用、无费用。
2. 手动改模型名只验证了「保存 + 请求解析 + 请求体使用自定义名」；自定义名对真实端点的可用性依赖服务商（原有路径未改，非本次回归）。
3. `strongModel` 与 `model` 现在同为 `deepseek-chat`：重点任务不再自动用更强模型，是产品预期选择（note 已提示可手动改）；能力参数（thinking 等）未变。
4. live README 旧默认值见 §6（文档问题，不影响功能）。

---

## 8. 可提交性

- 失败项：**无**；§6 的 P2/P3 复核后确认已修复，不构成遗留。
- **提交后状态（2026-10-29 11:10 复核）**：Lead 已提交为 `369fc49`（「修 DeepSeek 预置模型名」），包含本报告/`preset-check.mjs`/`behavior-check.json`、`presets.ts`、`SettingsPage`、docs、live README、ux 夹具与相关测试同步；提交后 `src/` 工作区 clean，提交内容与 QA 验证时一致，门禁结果仍然有效。
- 静态 + 运行时 + 真实 Key 交叉印证均通过；默认/串行全量与 typecheck/build 全绿。
- **建议提交。** QA 未 commit；`preset-check.mjs` / `behavior-check.json` 为本任务验证产物（在任务目录内），随报告保留即可。
