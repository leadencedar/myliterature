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

## 6. 发现与建议（均不阻塞，P2/P3）

1. **P2 文档陈旧**：`.agents/tasks/real-device-live-check/README.md`（task-60 交付）的 env 变量表仍写默认 `deepseek-flash` / `deepseek-v4-pro`（第 28–29 行）。live 套件实际导入 `PROVIDER_PRESETS.deepseek`，功能上已默认 `deepseek-chat`；建议把该表默认值与「需覆盖模型名」提示一起更新（避免误导维护者）。
2. **P3 沙盒假夹具**：`ux/run-demo.mjs`、`ux/device-check.mjs` 的假 LLM localStorage 仍写 `deepseek-flash` / `deepseek-v4-pro`；只用于被拦截的 mock 端点，不影响产品默认值，可选一致性清理。
3. 负向 grep 断言（`SettingsPage.test.tsx:54`）保留合理，建议后续若再加旧名历史，统一在文档区说明。

---

## 7. 风险 / 未覆盖

1. 真实端点行为已由 Lead 用真实 Key 跑 live（不覆盖模型名）验证：A/B/C 全通过、`deepseek-chat` 生效、缓存命中 90%+；本报告不重复真实调用、无费用。
2. 手动改模型名只验证了「保存 + 请求解析 + 请求体使用自定义名」；自定义名对真实端点的可用性依赖服务商（原有路径未改，非本次回归）。
3. `strongModel` 与 `model` 现在同为 `deepseek-chat`：重点任务不再自动用更强模型，是产品预期选择（note 已提示可手动改）；能力参数（thinking 等）未变。
4. live README 旧默认值见 §6（文档问题，不影响功能）。

---

## 8. 可提交性

- 失败项：**无**。
- 静态 + 运行时 + 真实 Key 交叉印证均通过；默认/串行全量与 typecheck/build 全绿。
- **建议提交。** QA 未 commit；`preset-check.mjs` / `behavior-check.json` 为本任务验证产物（在任务目录内），随报告保留即可。
