# M4 独立验证报告 · 文风锚点注入 + 漂移检查

> 验证人：qa-verifier（独立于开发）
> 对象：M4 S1（`styleAnchor.ts` 选择 + ContextBuilder 注入）、S2（`style-check` 任务/服务 `styleCheck.ts`/`StyleCheckSheet` 与编辑器入口）
> 代码状态：M4 改动在工作区（dev 未 commit，dev 停手）；报告不改变 feature
> 验证时间：2026-10-29 11:21–11:32 CST
> 边界：QA 只写 `src/test/m4/` 与 `ux/`；不改 feature/开发测试；不 commit。

---

## 1. 结论

**通过，可提交。** 锚点选择与注入顺序、第一章/预算边界、确定性；文风检查的 prompt/一次调用/schema≤5/UI 入口与结果/空结果/错误重试/关闭不写/无改写按钮/空正文不发请求全部按需求落地；**独立测试 26 条全绿**（S1 12 + S2 14），沙盒新增 `m4-01/m4-02`，双门禁与 typecheck/build 全绿，零迁移。**无功能失败项。**

---

## 2. 验收矩阵

### 2.1 S1 文风锚点（`src/test/m4/m4-s1-style-anchor.contract.test.ts` 12 例）

| 验证点 | 结果 | 证据 |
| --- | --- | --- |
| 选择函数：目标章为空/不存在 → null | ✅ | 纯函数用例 |
| 只取目标章之前、同一线（主线/外传不互取） | ✅ | 「只取目标章之前、同一线」 |
| 已完成优先（即使更晚）；全草稿取最早有正文 | ✅ | 「已完成优先…」 |
| `<300` 字跳过；恰好 300 字接受 | ✅ | 边界用例 |
| >600 字按段落边界截断 + 「……」；不足 600 原样；无空行硬截 | ✅ | 截断 3 用例 |
| 外传标签「外传第 N 章开头」；同输入两次结果一致 | ✅ | 标签/确定性用例 |
| ContextBuilder：锚点块在风格档案后、写作规范前 | ✅ | 「有更早已完成正文：…风格后、规范前」断言 `【文体取向】` < `【文风锚点` < `【作者的写作规范】` |
| 独立 `styleAnchor` item：id/label/tokens/included；清单顺序 meta → styleAnchor → norm | ✅ | 同上 |
| 第一章（无更早正文）：无锚点文本、无 item（行为不变） | ✅ | 「第一章…」 |
| 预算不足：文本不进前缀、item included=false + droppedReason | ✅ | 「预算不足时锚点进 dropped」 |
| 确定性：同一请求连续构建两次逐字节一致 | ✅ | stablePrefix/items 相等用例 |
| 作者编辑早期章节后锚点自动更新 | ✅ | 「编辑早期章节后锚点自动更新」 |

### 2.2 S2 文风检查（`src/test/m4/m4-s2-style-check.test.tsx` 14 例）

| 验证点 | 结果 | 证据 |
| --- | --- | --- |
| 一次 `style-check` 调用；`schemaName=StyleCheck`、`failOnTruncation=true` | ✅ | 服务用例 |
| system 含文学编辑角色/风格档案(`【文体取向】`)/只诊断不改稿/≤5 条/不评情节题材三观 | ✅ | 服务 + system prompt 用例 |
| user 块序：`【文风锚点…】`→`【本章正文】`→`【本次要求】`；正文 trim | ✅ | 服务用例 |
| 第一章：user 无锚点块，其余块序不变 | ✅ | 「第一章（无更早正文）」 |
| 空正文：拒绝且不调模型 | ✅ | 「空正文：拒绝且不调用模型」（calls=0） |
| 失败透传；成功/失败均不写库、不出提案 | ✅ | 2 条「不写库」用例 |
| Schema：issues ≤5（6 条拒绝）；summary/excerpt 空拒绝；severity 三档标签 | ✅ | Schema 单元用例 |
| `buildStyleCheckUserPrompt`：无锚点省略整块；无锚点文本；要求文案结尾 | ✅ | prompt 单元用例 |
| UI：入口与「按规范检查」并列；无正文禁用 | ✅ | 「无正文：入口按钮禁用」 |
| 打开面板**不请求**；点面板内「检查文风」才 1 次调用（严格非流式） | ✅ | UI 主用例（fetchSpy 调用次数） |
| 结果：整体判断 + severity（明显偏离/局部偏离）+ 维度 + 「原文」引用 + 建议 +「对照锚点：第 1 章开头」 | ✅ | UI 主用例 |
| 无「应用/采纳/改写/润色/替换」按钮；底部只有「完成」 | ✅ | `queryByRole` 断言 |
| 无问题：「未发现明显文风漂移。」 | ✅ | 无问题用例 |
| 第一章无锚点提示「第一章或没有更早正文…只对照风格档案。」 | ✅ | 第一章 UI 用例 |
| 错误：role=alert + 重试；重试成功后出结果 | ✅ | schema 失败→重试用例 |
| 关闭面板：不请求、不写库（提案/摘要为空、正文不变） | ✅ | 关闭不写用例 |
| 任务配置：`style-check` 在 TASK_PROFILES（strongModel/structured/thinking、label 检查文风）且在 SettingsPage TASK_ORDER 中 | ✅ | 代码核对 + 全量测试（SettingsPage 行断言由 dev 覆盖） |

### 2.3 零迁移

M4 只新增纯函数/上下文块/任务配置/只读诊断面板：无 schema/DB/备份版本改动（本轮 `db.ts`/`schema.ts`/`backup.ts` diff 为空）。

---

## 3. 沙盒（真浏览器，假模型；`ux/run-demo.mjs`）

后端 mock 新增 `style-check` 结构化响应（按 user 中「只输出结构化诊断」区分）。一次运行：after 11 + M2 9 + M2.1 3 + M3 5 + M3.2 1 + **M4 2** 张，mock 10 次（stream 5），**页面异常 0**。

| 截图 | 内容 |
| --- | --- |
| `m4-01-anchor-injection-mobile.png` | 第 3 章「本次注入」：`作品信息与风格档案 351` → **`文风锚点 · 第 1 章开头 534`** → `核心设定·渡口的规矩 89` → …（顺序在风格后、规范/核心设定前，作者可见） |
| `m4-02-style-check-mobile.png` | 「检查文风」结果：整体判断 +「对照锚点：第 1 章开头」+「明显偏离/叙述距离」+「原文」+「建议」+「局部偏离/句式」；底部只有「完成」，无改写按钮 |

---

## 4. 门禁（干净工作区，dev 停手；门禁前后 `git diff src` md5 一致 `2bd880d…`）

| 命令 | 结果 |
| --- | --- |
| 默认并行 `npx vitest run` | ✅ **130 files passed + 1 skipped（131）；2527 tests passed + 4 skipped（2531）**，0 失败 |
| `npx vitest run --maxWorkers=1` | ✅ 同 2527 / 2531 |
| `npm run typecheck` | ✅ 无输出 |
| `npm run build` | ✅ 147ms |
| QA 独立套件 | **m4 26 passed**（S1 12 + S2 14）；m1/m2/m3 全绿 |

修复记录：首轮 typecheck 发现 QA 新文件 2 处未使用变量/import（`ch1`、`chaptersOfTrack`）及 userEvent 参数误用，已自查修复；门禁复跑全绿。

---

## 5. 失败项与可提交性

- **失败项：无**（功能/UI/边界均通过）。
- 观测：注入清单里锚点 token 约 534；风格档案 351；预算 24k 下不会 dropped（预算极小才 dropped，已用注入 `budget:1` 用例覆盖）。
- **建议提交。** QA 未 commit；改动仅 `src/test/m4/` 与 `ux/`。

---

## 6. 未覆盖风险 / 交文学顾问 task-70

1. **锚点够不够**：规则是「最早已完成章 ≥300 字、取开头 600 字」；长篇写到中后期，最早一章可能不代表当前文风（作者可能已进化）。是否需要作者选/换锚点（当前不做）——建议顾问判断。
2. **诊断质量**：只验证了 prompt 约束/一次调用/schema/UI 呈现；真实模型是否「必须引用原文、≤5 条、不把情节题材当文风」需真实 Key 抽检（可复用 `npm run test:live`/手动；live 套件当前只覆盖 A/B/C，不含 style-check）。
3. **边界**：文风检查只读、不出提案、不改稿；与「风格档案 / 人物声音卡 / 按规范检查」的边界文案是否清楚，交顾问。
4. 真机项：按 `ux/device-check/report.md` §7 清单（本次未重跑 device-check；M4 面板在 390px 的观感以沙盒截图为准）。

---

## 7. 给文学顾问 task-70 的复核入口

- 截图：`ux/shots/m4-01-anchor-injection-mobile.png`、`ux/shots/m4-02-style-check-mobile.png`；报告本页。
- 请判断：①「最早已完成章开头 600 字」作为锚点对长篇漂移是否够、是否需要作者选/换；②注入清单显示锚点是否够透明；③「检查文风」只诊断不改稿/最多 5 条/必须引用原文，作为作者会不会用、会不会嫌说教或误判；④与风格档案/人物声音卡/规范检查的边界；⑤剩余 P1/P2 与真机项。

---

## 8. M4-P1 最终复验（task-71 → task-73，2026-10-29 11:33–11:40）

> 前置：task-71（每条 issue 必填 `basis`；severity 中性化；面板分工句；每条渲染 原文/依据/建议；prompt 要求 basis）与 task-72（live D 套件）完成，dev 停手。
> 门禁前后 `git diff src` md5 一致（`e6c503a…`）。

### 8.1 结论：通过，可提交

P1 字段/文案修订按预期落地；旧标签无残留；沙盒 `m4-02` 已按新标签/依据/分工句重跑覆盖；M4 原功能（锚点、一次调用、无改写按钮、关闭不写）回归全绿；双门禁与 typecheck/build 全绿。**无失败项。**

### 8.2 P1 验证点（`src/test/m4/m4-s2-style-check.test.tsx` 已同步 + 新增断言）

| 验证点 | 结果 | 证据 |
| --- | --- | --- |
| Schema 每条 issue 必填 `basis`；缺失/空串拒绝 | ✅ | 「issues 最多 5 条；…basis 必填；空字段拒绝」 |
| severity 标签中性：差异较大/局部差异/轻微差异 | ✅ | `STYLE_CHECK_SEVERITY_LABELS` 精确断言 |
| 旧标签「明显偏离/局部偏离/轻微」无残留 | ✅ | prompt 单元断言 `not.toContain('明显偏离')` + UI `queryByText` 断言不存在 |
| prompt 新增 basis 要求（句长、叙述距离、对话密度、意象密度） | ✅ | system prompt 用例断言 `basis` + 四类可观察差异 |
| 面板固定分工句「文风检查看语感…按规范检查看…依据：风格档案 + 文风锚点。」 | ✅ | UI 主用例正则断言 |
| 每条显式渲染「原文：」+「…」、「依据：…」、「建议：…」 | ✅ | UI 主用例：`原文：`/`依据：` 各 2 条、basis 文本精确匹配 |
| 仍无改写/应用建议按钮 | ✅ | 原 `queryByRole(/应用|采纳|改写|润色|替换/)` 断言保留并通过 |
| 回归 M4：锚点注入/顺序/第一章无锚点/预算 dropped/确定性 | ✅ | S1 12 例全绿（未改） |
| 回归 M4：一次 style-check 调用、空正文不发请求、错误重试、关闭不写、不落库/不出提案 | ✅ | S2 服务/UI 用例（已补 basis 夹具）全绿 |
| live D（真实模型，Lead 执行） | ✅ 交叉印证 | 5 条 issue、5/5 excerpt 逐字命中正文、basis/suggestion 全非空、维度齐全、severity 1 high / 3 medium / 1 low、无严重警告 |

### 8.3 沙盒（m4-02 重拍）

`node ux/run-demo.mjs` 一次跑通：after 11 + M2 9 + M2.1 3 + M3 5 + M3.2 1 + M4 2，mock 10 次（stream 5），**页面异常 0**。
`m4-02-style-check-mobile.png` 现显示：
- 面板顶部分工句「文风检查看语感与叙述距离是否漂移；按规范检查看你定的规矩是否被违反。依据：风格档案 + 文风锚点。」；
- 「差异较大 / 叙述距离」+「原文：「他听见自己的心跳，比河声还响。」」+「依据：这句从现场动作切到总结性心理，叙述距离比第 1 章开头拉远了。」+「建议：…」；
- 「局部差异 / 句式」同理；底部只有「完成」，无改写/应用按钮。

### 8.4 门禁（干净工作区，dev 停手）

| 命令 | 结果 |
| --- | --- |
| 默认并行 `npx vitest run` | ✅ **130 files passed + 1 skipped（131）；2528 tests passed + 5 skipped（2533）**，0 失败 |
| `npx vitest run --maxWorkers=1` | ✅ 同 2528 / 2533 |
| `npm run typecheck` | ✅ 无输出 |
| `npm run build` | ✅ 140ms |
| QA 独立套件 | **m4 26 passed**（已适配 P1 并新增断言）；m1/m2/m3 全绿 |

### 8.5 可提交性

- 失败项：**无**；P1 已闭环；真实模型 live D 交叉印证 basis/引用/severity 均正常。
- **建议提交。** 已请 literary-advisor 做 task-74 ≤200 字确认（新 m4-02）；QA 未 commit，改动仅 `src/test/m4/`、`ux/`。
