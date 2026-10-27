# M1-UX 修复独立验证报告（task-15）

> 验证人：qa-verifier（独立于开发）
> 对象：task-14「UX P0+P1 小修」+ task-17「已完成章节采用截断稿退回草稿」的 P0 边界
> 代码状态：HEAD `3e42d25`（M1 提交）+ 未提交的 UX 修复工作区改动（开发已停手）
> 验证时间：2026-10-27 14:49–14:55 CST；Node v22.18.0
> 边界：QA 只改 `src/test/m1/**` 与 `ux/**`；未改 feature/开发测试、未 commit。

---

## 1. 结论

**通过。** P0/P1 修复全部按评审要求落地，且新增的 task-17 P0 边界（已完成章节采用截断/中断稿 → 退回草稿）验证通过。无 P0/P1 阻塞项、无新增回归；全量门禁全绿。

**是否可进入 M2：可以。** 前提不变：仍需人工真机走查/真实模型抽检（上一轮报告 `../verification-report.md` §10 的未执行项），本轮修复已把文学顾问上一轮提出的 P0/P1 全部闭环，体验侧无新增阻塞。

---

## 2. 独立验证清单（P0/P1 逐项）

> 全部用例在 QA 独立测试目录 `src/test/m1/`；命令：`npx vitest run src/test/m1` → **215 passed + 1 skipped（18 文件）**。

### 2.1 P0 · 截断/中断稿采用后留痕

| 验证点 | 结果 | 独立用例 / 证据 |
| --- | --- | --- |
| 截断稿采用后编辑器出现「本章由未完成生成稿采用，可能缺少结尾；补写后再标「已完成」」 | ✅ | `m1-ui-incomplete-drafts.test.tsx`「截断稿采用：出现提示 + 正文已写入 + 仍是草稿」；实现 `ChapterEditorScreen.tsx:539` |
| 点「知道了」消失 | ✅ | 同上（`ChapterEditorScreen.tsx:543`） |
| 切「已完成」清除 | ✅ | 同文件「切到「已完成」清除提示」 |
| 完整采用不出现提示、并清掉之前留下的提示 | ✅ | 同文件「完整采用不出现提示，并清掉之前留下的提示」/「完整采用（首次）不出现提示」；实现 `ChapterEditorScreen.tsx:279-280` |
| 自动保存不清除（只有知道了/标完成/完整采用才清） | ✅ | 同文件「自动保存不清除提示」 |
| 刷新后不残留（内存 store，不落库） | ✅ | 同文件「提示来自内存 store：重置（模拟刷新）后不残留，也不从库里恢复」+ store 单测（无 persist 中间件、无 localStorage 键）；实现 `incompleteDrafts.ts:23` |
| 中断稿（aborted）同样留痕 | ✅ | 同文件「中断稿（aborted）同样留痕」 |

### 2.2 P0 边界（task-17）· 已完成章节退回草稿

| 验证点 | 结果 | 独立用例 / 证据 |
| --- | --- | --- |
| done 章采用截断稿 → 状态按钮变「草稿」、DB `status='draft'`（正文与状态同一次写库）、提示条在 | ✅ | `m1-ui-incomplete-drafts.test.tsx`「done 章采用截断稿：状态退回草稿并落盘、提示出现、不自动弹摘要」；实现 `ChapterEditorScreen.tsx:274-276` |
| 不自动弹摘要 | ✅ | 同上（断言无「本章摘要」dialog） |
| draft 章采用截断稿：状态保持 draft，正文写入、提示留痕 | ✅ | 同文件「draft 章采用截断稿：状态保持草稿」 |

### 2.3 P1 · 关联面板与注入清单

| 验证点 | 结果 | 独立用例 / 证据 |
| --- | --- | --- |
| 面板只剩「确认关联（N 条）/ 全部跳过」，没有「全部保留」 | ✅ | `m1-e2e-outline-refine.test.tsx`「默认全选…」断言 `queryByRole('button',{name:'全部保留'})` 不存在；实现 `OutlineLinkConfirmSheet.tsx:84-126` |
| 关闭面板（X）不写入任何关联（与跳过等价） | ✅ | 同文件「关闭面板（X）：一条关联都不写，与「全部跳过」等价」（spy `updateOutlineLinks` 未被调用、子节点 links 全空） |
| chip 文案「名字提到 / 继承」且命中名=标题时不重复 | ✅ | 同文件「别名命中：chip 显示「名字提到 · 小舟」，标题不重复一遍」+ 注入清单用例断言 `名字提到`；实现 `OutlineLinkConfirmSheet.tsx:125-126`、`OutlineNodeSheet.tsx:68-76` |
| 说明含「关闭面板不会写入任何关联；取消的条目在本次打开节点抽屉期间不再建议」 | ✅ | 同文件断言该文案（`OutlineLinkConfirmSheet.tsx:84`） |
| 注入清单术语「本次注入 / 手工关联 X 条 + 名字提到 Y 条」；移除按钮 aria-label `移除名字提到的设定：X` | ✅ | 同文件注入清单用例；实现 `OutlineNodeSheet.tsx:586,596,612` |
| 细化 review 区显示「共 N 章细目，采用后可继续编辑。」 | ✅ | 同文件默认全选用例（3 个子节点 → 「共 2 章细目」为夹具实际数量）；实现 `OutlineNodeSheet.tsx:677` |

### 2.4 P1 · 字数结构与提案计数

| 验证点 | 结果 | 独立用例 / 证据 |
| --- | --- | --- |
| 生成表单显示具体场景区间（6000→约 3–5 场；默认→约 1–2 场） | ✅ | `m1-e2e-chapter-length.test.tsx` 目标来源两例；实现 `GenerateChapterSheet.tsx:308` |
| 结果标题显示「X 字 / 目标 N 字」（截断与完整都显示） | ✅ | 同文件截断/中断/完整三处断言；实现 `GenerateChapterSheet.tsx:414` |
| 二次确认文案改为「采用后本章仍是草稿…补完再标「已完成」」 | ✅ | 截断用例断言完整文案（`GenerateChapterSheet.tsx:477`） |
| 不完整采用时 `onAccept` 第三参 `{incomplete:'truncated'|'aborted'}`；完整采用仍两参 | ✅ | 同文件截断/中断/完整三例断言 |
| 单提案采用按钮无「（1）」；多提案仍有计数 | ✅ | `m1-ui-proposal-count.test.tsx` 4 例（单/多/自定义 label/忽略后计数）；实现 `ProposalReview.tsx:280` |

---

## 3. before / after 截图

- before（UX 修复前，task-12 保留）：`ux/shots/01-writing-page-mobile.png` … `09-node-sheet-desktop.png`（9 张）
- after（本轮重跑，修复后）：`ux/shots/after-*.png`（11 张）

| 关注点 | before | after |
| --- | --- | --- |
| 注入清单术语 | `02-node-injection-list-mobile.png`（本次参考设定 / 提到 · 名字） | `after-01-node-injection-mobile.png`（本次注入 / 手工关联 + 名字提到） |
| 细化提案与计数 | `03-refine-proposal-mobile.png`（采用这份细目（1）） | `after-02-refine-proposal-mobile.png`（无（1）+ 共 3 章细目） |
| 关联面板 | `04-link-confirm-mobile.png`（全部保留/全部跳过/确认关联） | `after-03-link-confirm-mobile.png`（只剩两按钮 + 关闭不写入说明 + 名字提到） |
| 生成表单 | `05-generate-sheet-mobile.png`（场景数参考按目标推算） | `after-04-generate-form-mobile.png`（约 3–5 场） |
| 截断结果 | `06-generation-truncated-mobile.png`（658 字） | `after-05-generation-truncated-mobile.png`（658 字 / 目标 6000 字） |
| 采用二次确认 | `07-accept-incomplete-confirm-mobile.png`（旧文案） | `after-06-accept-confirm-mobile.png`（采用后仍是草稿…） |
| **P0 编辑器留痕** | 无 | `after-07-editor-incomplete-notice-mobile.png` |
| **P0 边界 done→draft** | 无 | `after-08-done-chapter-before-mobile.png`（已完成）→ `after-09-done-chapter-demoted-mobile.png`（草稿+提示） |
| 桌面 | `08/09-*-desktop.png` | `after-10-writing-page-desktop.png`、`after-11-node-sheet-desktop.png` |

沙盒运行：**一次完整跑通，after 截图 11 张，mock 请求 3 次（1 结构化 + 2 流式），页面异常 0、console error 0**；`ux/run-demo.mjs` 可重复运行；`ux/walkthrough.md` §8 为 after 走查记录（含逐步可见文案）。

---

## 4. 全量门禁（开发已停手、文件稳定）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（`tsc --noEmit`） | ✅ 通过，无输出 |
| `npm run test:run` | ✅ **107 files passed + 1 skipped（108）**；**2219 tests passed + 1 skipped（2220）**；15.59s |
| `npm run build` | ✅ 通过，142ms；主 chunk 542.02 kB（gzip 168.02 kB）< 550 阈值 |
| `npx prettier --check "src/test/m1/**/*.{ts,tsx}"` | ✅ 通过 |

稳定性：门禁期间（14:53:50 起）`src` 下除 QA 自己的 `src/test/m1/**` 外**无任何文件变更**（`find src -newermt ... ! -path "src/test/m1/*"` 为空）。

---

## 5. 失败项与遗留

- **失败项：无。** 上一轮 QA 的 4 条预期（onAccept 第三参 ×2、注入清单术语 ×2）已按有意变更同步，不存在「改测试凑绿」：每条都对应 task-14/17 的设计意图，且新增了独立用例覆盖新行为。
- **未覆盖/说明**：
  1. 「刷新后不残留」在 jsdom 无法真正重载模块：以「store 无 persist、无 localStorage 键 + 重置后提示消失、正文仍在库」三证据等价验证（`m1-ui-incomplete-drafts.test.tsx`）；真实浏览器刷新可由沙盒/真机复核（本沙盒未做刷新步骤）。
  2. 沙盒的 done 章场景是脚本预置的「已完成」章节（非用户手写历史），用于演示 task-17 边界；真实历史章节行为由上述独立测试覆盖。
  3. 指标 2/3 的人工抽检与真实模型质量仍待人工（与上一轮报告一致，不因本轮修复改变）。
  4. 关联面板默认全选 + 只有确认/跳过：文学顾问的复核（task-16）仍需以 after 截图确认是否消除了犹豫。
- **观察（P2/P3，供复核参考）**：390px 下关联面板底部按钮从 3 个减为 2 个，拥挤感明显缓解；编辑器提示条位于标题栏下方，滚动后不吸顶（长文写作时向上滚会看不到，属刻意不打扰，后续可评估是否吸顶）。

---

## 6. 给文学顾问（task-16）的复核入口

1. **P0 是否安心**：`after-07-editor-incomplete-notice-mobile.png`、`after-09-done-chapter-demoted-mobile.png`（含 before 对照 `after-08`）。
2. **关联面板是否消除犹豫**：`after-03-link-confirm-mobile.png`（对比 before `04-link-confirm-mobile.png`）。
3. **结构承诺是否兑现**：`after-04-generate-form-mobile.png`（约 3–5 场）、`after-05-generation-truncated-mobile.png`（658 / 目标 6000）。
4. 其余步骤见 `walkthrough.md` §8 表格；假模型说明不变，只评信息与流程。
