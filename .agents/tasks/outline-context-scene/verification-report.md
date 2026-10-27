# M1 最终独立验收报告

> 验收人：qa-verifier（独立于开发）
> 验收对象：M1「大纲细化的上下文、场景卡与字数结构件」（S1–S7）
> 代码状态：HEAD `52e124eaee097a47bc7d578ed7596d8599061615` + 未提交的 M1 工作区改动（S6→S2→S1→S3→S4/S5→S7 全部完成并停手）
> 验收时间：2026-10-27 11:12–11:18（CST）；Node v22.18.0；验收方案见 `verification.md`
> 边界：QA 只新增 `src/test/m1/**` 测试，未修改任何 feature 代码、未修改开发测试、未 git commit。

---

## 1. 结论

**自动化验收：通过。** 无 P0/P1 阻塞项；US-1~US-5 的自动化验收点全部成立，6 条指标中 4 条纯自动化项达标，指标 2 的自动化陷阱 0 错配，指标 3 与指标 2 的人工抽检部分**待人工执行**（本环境无浏览器交互与真实 API Key），因此整体结论为：

> **通过（有条件）**：自动化部分与零回归/零迁移/基线审查全部通过；**建议进入 M2**，条件是在合并/发布前由人工按 `verification.md` §5 完成 Demo D3/D4/D5/D6 与指标 2/3 抽检，并补齐 S8 文档更新（见 §9 P2-2）。

失败项：无。基线静默重生：无。零迁移：确认。

---

## 2. 环境、证据与工作区稳定性

| 项 | 值 |
| --- | --- |
| 代码基线 | HEAD `52e124eaee097a47bc7d578ed7596d8599061615`（M1 改动前） |
| 工作区 | 17 个修改文件 + 14 个 M1 新文件（见 §8 范围核对） |
| 冻结 golden | `src/test/m1/fixtures/head-golden.json`（用 `git archive HEAD` 在 /tmp 生成，生成器 `src/test/m1/tools/capture-head-golden.test.ts` 默认 skip） |
| 稳定性证明 | QA2 期间（11:12:39 起）**没有任何 feature/开发测试文件 mtime 变化**（`find src -newermt "2026-10-27 11:12:39" ! -path "src/test/m1/*"` 为空）；变化仅来自 QA 自己的 `src/test/m1/` |
| 全量命令结果 | 见 §7 |

### 2.1 QA 独立测试（`src/test/m1/`，199 passed + 1 skipped）

```sh
npx vitest run src/test/m1
# → Test Files 16 passed | 1 skipped (17)；Tests 199 passed | 1 skipped (200)
```

新增/扩展的独立测试文件与用例数：

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `m1-s6-outline-subtree.contract.test.ts` | 16 | S6 仓储事务：replace/append/回滚/解链/anchor/前序返回/Lead 裁决的 replace+null |
| `m1-s6-apply-outline-tree.test.ts` | 10 | apply 走事务：create/merge/replace、apply 前删 anchor、失败回滚、不再预查 listOutline |
| `m1-s1-entry-mention.contract.test.ts` | 22 | S1 评分/归一化/全序/上限/excludeIds/minScore |
| `m1-s2-planning-context.contract.test.ts` | 14 | S2 选择器：core/linked/mentioned、预算、dropped、tokens、确定性 |
| `m1-s2-render-canary.test.ts` | 3 | `renderEntry`/`renderSummary` 与 HEAD 逐字节 + re-export 同引用 |
| `m1-canary-stable.test.ts` | 6 | 稳定族 prompt 与 HEAD golden 逐字节（正文侧 builder、chapterSystem、expandUser） |
| `m1-canary-intentional.test.ts` | 7 | S3/S7「外科手术式」变更证明（只允许任务段/字数句变化） |
| `m1-zero-migration.test.ts` | 4 | Dexie v7、16 表、BACKUP_VERSION 4、8 个 schema key 集合与 HEAD 一致 |
| `m1-code-hygiene.test.ts` | 21 | M1 实现文件无 any/console/debugger（扫描器自测防漏） |
| `m1-s3-prompt-contract.test.ts` | 11 | S3 块位置/缓存前缀/向后兼容边界/schema 不变 |
| `m1-s4s5-suggest-links.test.ts` | 10 | S5 建议纯函数：继承/提到/上限/抑制/精度排序 |
| `m1-s7-chapter-length.test.ts` | 19 | S7 纯函数边界：默认/取整/场景区间/token 夹取/结构文案 |
| `m1-e2e-outline-refine.test.tsx` | 13 | US-1/2/3 交互链（落盘、注入清单、replace 告知、关联面板、抑制、连点） |
| `m1-e2e-chapter-length.test.tsx` | 12 | US-4/5 + 截断/中断/null/400 回退/目标来源/max_tokens |
| `m1-metrics-coverage.test.ts` | 23 | 指标 1：20 个夹具的完整字段覆盖率 + 缓存前缀 |
| `m1-metrics-association.test.ts` | 8 | 指标 2 自动化陷阱：20 例关联建议「不无中生有」不变量 |
| `fixtures/*`、`tools/capture-head-golden.test.ts` | — | HEAD golden 数据与生成器（生成器默认 skip） |

---

## 3. 需求 → 验收矩阵结果

| ID | 验收点 | 结果 | 证据（独立测试用例） |
| --- | --- | --- | --- |
| US-1a | 细化面板列出核心/显式/名称命中与 token | ✅ | `m1-e2e-outline-refine.test.tsx`「展示核心/显式/提到与 token」：断言「本次参考设定」「核心设定 1 条（始终注入）」「相关设定：显式 1 条 + 提到 1 条」与 chip 来源 |
| US-1b | user prompt 含命中条目完整字段（不只标题：摘要）；system 只含核心 | ✅ | 同上用例断言 user 含 `## 沈砚（人物）`、`身份：沈砚的身份`、`## 裴照（人物）`；system 含 `## 灵气（人物）` 且不含沈砚；`m1-metrics-coverage.test.ts` 20/20 |
| US-1c | 生成子节点梗概体现软肋/规则代价驱动的选择 | ⚠️ 待人工 | 不可自动化判文学质量；自动化代理：`m1-s3-prompt-contract.test.ts` 断言任务段含「软肋或世界规则的代价…必须改变后文走向」「场景卡」「钩子与信息差」等约束。人工抽检见 §10 |
| US-2a | 采用后关联面板：分组、默认全选、继承标记、命中名、可取消 | ✅ | `m1-e2e-outline-refine.test.tsx`：默认「确认关联（4 条）」、chip 取消后变 3 条、`继承`/`提到 · X` 标签、别名 matchedName（另见 `m1-s4s5-suggest-links.test.ts`） |
| US-2b | 确认写 links；取消不写；不点确认一条不写；父节点显式关联不丢 | ✅ | 同文件：确认前 DB links 全空 → 确认后按选中写入；取消项不写；父节点 links 前后不变；`updateOutlineLinks` 只调用 1 次（一次批量事务） |
| US-2c | 被拒/跳过不弹面板不写；会话内取消过的条目不再建议 | ✅ | 同文件「提案被拒绝」「全部跳过」；«全部跳过»用例用 Live wrapper 模拟真实页面重查，第二次细化（replace 换新 id）后沈砚仍不被建议（条目级抑制双保险） |
| US-3a | replace 前确认框列出 K 子节点/M 章解链/已有正文数；取消不发请求 | ✅ | 同文件「列出替换子节点数与解链章节数」：断言「2 个子节点（含孙节点）」「约 2 个已挂章节（1 个已有正文）」，取消后 fetch 0 次、确认后 1 次 |
| US-3b | 采用失败不留半棵树/不删一半旧节点 | ✅ | `m1-s6-outline-subtree.contract.test.ts` 中途失败回滚（201 字标题注入）、replace+null 回滚；`m1-s6-apply-outline-tree.test.ts` 建树中途失败旧树/章节关联原样 |
| US-3c | replace：旧子树删除、正文保留、章节解链 | ✅ | 同上两文件 + `m1-e2e-outline-refine.test.tsx` 采用后旧子节点被替换、新子节点写入 |
| US-4a | targetWords=6000 显示「6000 字（来自大纲）」 | ✅ | `m1-e2e-chapter-length.test.tsx`「大纲节点有目标」 |
| US-4b | prompt 有 3–5 场/节拍/自然收束/钩子/文体冲突以目标为准 | ✅ | 同文件请求体断言 + `m1-s7-chapter-length.test.ts` 纯函数边界 |
| US-4c | finish_reason=length：显示截断未完成、保留内容、采用二次确认 | ✅ | 同文件「截断」用例：截图级断言「生成被截断，内容不完整」「建议重新生成」；采用先弹「仍要采用不完整内容？」，取消不写、确认才写 |
| US-4d | 用户中止：标记未完成、保留内容、采用二次确认 | ✅ | 同文件「用户中止」用例（自定义 abort 流） |
| US-5a | targetWords 空：显示「3000 字（默认）」、prompt 按 3000 | ✅ | 同文件「大纲节点为空」+ 请求体 `max_tokens=6200`、user prompt「1–2 场」 |
| US-5b | 提示去大纲改目标 | ✅ | 同文件断言「要修改请到「写作 → 大纲节点」里改」 |

---

## 4. 6 条成功指标结果

| # | 指标 | 阈值 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 细化设定覆盖率 | ≥18/20 | ✅ **20/20** | `m1-metrics-coverage.test.ts`：20 个夹具（标题/梗概/额外要求/祖先梗概/别名/全半角/零宽/短名/多条目/8 条上限/超 8 条）逐条断言 `renderEntry` 全文进入 user prompt；另有「20/20 达判据」汇总用例 |
| 2 | 关联质量（错配率） | <5%，宁漏勿错 | ⚠️ 自动化：**0/20 错配**；人工抽检未执行 | `m1-metrics-association.test.ts`：20 个子节点夹具 + 陷阱条目（泛化别名/短名/同名/pinned/已删除/抑制/继承），断言每条 mentioned 建议的名字确实出现在子节点文本里（0 条无中生有）、pinned/已删除永不建议、泛化排在真名之后、≤8 条。人工 20 例抽检待做（§10） |
| 3 | 细纲可写性 | ≥8/10 | ⚠️ 待人工 | 需真实模型生成 10 例子节点按四要素+软肋驱动评分（rubric 见 `verification.md` §5.3）。自动化代理：场景卡约束确实进了 system prompt（`m1-s3-prompt-contract.test.ts`） |
| 4 | 截断可见性 | 100% | ✅ **100%** | `m1-e2e-chapter-length.test.tsx` 三态：length→截断提示、aborted→中断提示、finishReason=null→不误报；两种不完整均二次确认 |
| 5 | 字数目标可见性 | 100% | ✅ **100%** | 同上：大纲值/默认值两种来源均显示数值+来源 |
| 6 | 零回归 | 全绿+零意外 | ✅ | ① HEAD golden canary 全等（§5.3）② 基线逐 hunk 审查无静默重生（§5）③ `typecheck`/`test:run`/`build` 全绿（§7）④ 零迁移（§6） |

---

## 5. 基线审查结论（S3 / S7，逐 hunk）

审查对象：`noScenarioBaseline.test.ts`、`noNormsBaseline.test.ts`、`ChapterEditor.test.tsx`、`WritingPage.test.tsx`。
方法：`git diff -U3` 逐 hunk 分类 + HEAD golden 独立 canary（不依赖开发可更新的基线字面量）。

### 5.1 「有理由变更」清单（全部接受，无静默重生）

| # | 文件:行（内容锚点） | 变更前 → 变更后 | 原因 | 归属 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | `noScenarioBaseline.test.ts:1777`（expandSystem 任务段） | 旧 7 条任务约束 → 追加 6 条场景卡/设定落地/钩子/字数约束（旧条目不删） | design §4.1、US-1 | S3 | 接受 |
| 2 | `noNormsBaseline.test.ts:1041`（expandSystem 任务段） | 同 #1 | design §4.1 | S3 | 接受 |
| 3 | `noScenarioBaseline.test.ts:1126`（chapterUser「本次要求」） | `本章篇幅约 3000 字，可上下浮动 15%。` → 7 行结构块（场景数/节拍/自然收束/钩子/文体冲突） | design §8.4、US-4 | S7 | 接受 |
| 4 | `noScenarioBaseline.test.ts:1234`（sideChapterUser，null→3000 同文案） | 同 #3 | design §8.4、US-5 | S7 | 接受 |
| 5 | `noNormsBaseline.test.ts:1151`（chapterUser） | 同 #3 | design §8.4 | S7 | 接受 |
| 6 | `ChapterEditor.test.tsx:333–352` 请求体断言 | 旧「约 3000 字」断言 → 新结构句；**新增** `max_tokens=6200` 断言；原有 system/thinking/model/stream 断言全部保留 | S7 验收需要 | S7 | 接受（断言被加强，未弱化） |
| 7 | `WritingPage.test.tsx:393/408/429` | ① 相关设定断言改为完整字段 `## 林越（人物）`；② 两处 replace 细化补「继续细化」确认步骤 | S3/S4 行为变化，Lead 已确认有意 | S3/S4 | 接受（未删断言、未放宽容差） |

### 5.2 逐字节「桌面检查」：未变部分

- `expandUser` 字面量：`noScenarioBaseline.test.ts:1783`、`noNormsBaseline.test.ts:1339` **未变**（旧参数路径逐字节不变，符合 requirements 指标 6 / design §4.2）。设计文档中“更新 expandUser 基线”的措辞与实际需求冲突时，以需求为准，dev 未改是正确实现。
- `chapterSystem`、`builderMain`/`builderSide`、summary/extract/revise/setup/translate/normCheck/styleSample/manuscriptStyle 字面量：diff 中**无任何变化**。
- `noNormsInputs.test.ts`（夹具同步护栏）、`db.ts`、`backup.ts`、`schema.ts`、`entrySearch.ts`：`git diff --name-only` 为空。
- 无 `.snap` / `__snapshots__`；无测试被删除或 skip。

### 5.3 独立 canary（HEAD 冻结，不依赖开发基线）

| 检查 | 结果 |
| --- | --- |
| builderMain / builderSide（stablePrefix/volatileSuffix/items/defaultEntryIds） | ✅ 与 HEAD **逐字节相同**（`m1-canary-stable.test.ts`） |
| chapterSystem | ✅ 与 HEAD 逐字节相同（`m1-canary-intentional.test.ts`） |
| expandUser（旧参数路径） | ✅ 与 HEAD 逐字节相同（`m1-canary-stable.test.ts`） |
| expandSystem | ✅ `【任务】` 之前与 HEAD 逐字节相同；任务段保留 HEAD 全部旧约束 + 设计 §4.1 新约束；旧调用无 core 块（`m1-canary-intentional.test.ts`） |
| chapterUser / chapterUserDefault | ✅ 旧句之前/之后与 HEAD 逐字节相同；只有该句区间被替换，新块含设计 §8.4 全部语义（`m1-canary-intentional.test.ts`） |
| renderEntry / renderSummary | ✅ 与 HEAD 逐字节相同；`SummaryChainContextBuilder` re-export 与新模块同一函数引用（`m1-s2-render-canary.test.ts`） |

**结论：S3 只改了 expand 任务段、S7 只改了 chapter 字数段 + 相关测试断言；没有静默重生、没有削弱护栏。**

---

## 6. 反向测试结果（R1–R40，逐条）

| # | 场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| R1–R8 | S6 replace/append/anchor 非法/空 nodes/中途回滚/updateOutlineLinks 原子/边界 | ✅ | `m1-s6-outline-subtree.contract.test.ts`（16 例） |
| R2 | **replace+anchor=null = 整本顶层替换（Lead 裁决允许）** | ✅ | 同文件「replace + anchor=null」两例；未写「必须抛错」断言 |
| R9–R12 | apply 走事务/TOCTOU/失败语义/不嵌套事务/前序返回 | ✅ | `m1-s6-apply-outline-tree.test.ts`（10 例） |
| R13 | 空输入向后兼容 | ✅ | `m1-canary-stable.test.ts` expandUser/正文侧；`m1-s3-prompt-contract.test.ts` 旧路径回退 |
| R14 | 无条目旧调用 | ✅ | `m1-e2e-outline-refine.test.tsx`「没有建议时不弹面板」+「无新输入时保持旧输出」 |
| R15 | 被拒提案不写 links、不弹面板 | ✅ | 同文件「提案被拒绝」 |
| R16 | 不点确认/全部跳过不写 | ✅ | 同文件「全部跳过」 |
| R17 | 连点细化只发一次请求 | ✅ | 同文件「连点」用例（fetch 1 次） |
| R18 | 重复细化/旧节点不重复建议 | ✅ | 同文件「只对本次新子节点建议」 |
| R19 | 会话内抑制（含 replace 换 id） | ✅ | `m1-s4s5-suggest-links.test.ts` + e2e Live wrapper 用例 |
| R20 | 父节点显式关联继承 | ✅ | 纯函数 + e2e「父节点显式关联默认继承」 |
| R21 | 泛化别名/短名/同名陷阱 | ✅ | `m1-s1-entry-mention.contract.test.ts`、`m1-metrics-association.test.ts` |
| R22 | 归一化边界（全半角/零宽/内部空格/简繁） | ✅ | `m1-s1-entry-mention.contract.test.ts` |
| R23 | 缓存前缀（同书不同节点 system 相同） | ✅ | `m1-s3-prompt-contract.test.ts`、`m1-metrics-coverage.test.ts`；e2e 断言 system 只含 core |
| R24 | 先落盘再细化/标题空不发请求 | ✅ | `m1-e2e-outline-refine.test.tsx` 前两例 |
| R25 | replace 告知与取消不发请求 | ✅ | 同文件「replace 影响告知」 |
| R26 | 注入清单临时移除 | ✅ | 同文件「移除提到的设定」 |
| R27–R29 | 截断/中断/finishReason=null | ✅ | `m1-e2e-chapter-length.test.tsx` |
| R30–R32 | 400 max_tokens 回退（成功/无关 400/重试仍失败） | ✅ | 同文件 3 例：重试不带 max_tokens、只重试一次、内容不重复 |
| R33 | maxTokens 边界 3000/6000/10000/非法 | ✅ | `m1-s7-chapter-length.test.ts`：3000→6200、6000→8192（上夹）、10000→8192、非法→6200；下夹 4096 边界精确 |
| R34 | 目标来源显示 | ✅ | e2e 两态 |
| R35 | 正常完成路径不受影响 | ✅ | e2e「正常生成路径」2 例 |
| R36 | 稳定族 HEAD golden | ✅ | `m1-canary-stable.test.ts` |
| R37 | 有意变更族外科手术式证明 | ✅ | `m1-canary-intentional.test.ts` |
| R38 | 零迁移 | ✅ | `m1-zero-migration.test.ts` |
| R39 | 越界改动 | ✅ | §8 |
| R40 | 代码卫生（any/console/debugger） | ✅ | `m1-code-hygiene.test.ts`（扫描器自测 + 32 个文件；0 命中） |

---

## 7. 全量门禁（开发已停手后执行）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（`tsc --noEmit`） | ✅ 通过，无输出 |
| `npm run test:run`（vitest run） | ✅ **105 files passed + 1 skipped（106）**；**2195 tests passed + 1 skipped（2196）**；14.36s；无失败、无意外跳过（唯一 skip 是 QA golden 生成器） |
| `npm run build`（tsc --noEmit && vite build） | ✅ 通过，172ms；主 chunk 542.02 kB（gzip 168.03 kB），低于 vite.config 配置的 550 kB 阈值，无新增警告 |
| `npx prettier --check "src/test/m1/**/*.{ts,tsx}"` | ✅ 全部符合 Prettier |

---

## 8. 范围核对与零迁移

### 8.1 实际改动 vs design §10

- **修改文件（17）**：design §10 + 任务声明范围内；逐文件核对无越界（`SummaryChainContextBuilder`、`NovelRepository`、`DexieNovelRepository`、`apply`、`outlineExpand`、三处基线/请求体测试、`OutlineNodeSheet`、`OutlineLinkConfirmSheet` 接线、`WritingPage`、`chapterDraft`、`GenerateChapterSheet`、`useLlm`、`WritingPage.test`、`OutlineNodeSheet.test`、`GenerateChapterSheet.test`、`apply.test`、`DexieNovelRepository.test`）。
- **新增文件（14）**：design §10 的 6 个实现文件 + 6 个开发测试 + QA 的 `src/test/m1/**`。`src/llm/types.ts` 未改（`TextRunOptions` 定义在 `useLlm.ts`，`ChatRequest.maxTokens` 早已存在），符合最小改动。
- **禁止文件**：`db.ts`、`backup.ts`、`domain/schema.ts`、`domain/entrySearch.ts`、`context/noNormsInputs.test.ts` 的 `git diff` 全部为空。
- `analysis/`、`.agents/**` 为任务前既有未跟踪目录，与 M1 无关。

### 8.2 零迁移确认

`m1-zero-migration.test.ts` 4 例全过：Dexie `verno=7`、16 张表清单、`BACKUP_VERSION=4`、8 个核心 schema `parse` 后 key 集合与 HEAD 一致；配合 §5.2 的文件级检查与全量备份/迁移测试绿 → **M1 未引入任何迁移**。

---

## 9. 已知偏差与问题清单

### P0 / P1：无

### P2（不阻塞 M1，需要记录/后续处理）

1. **关联确认面板的呈现形态与 design §6.2 有偏差**：实现为嵌套在节点 Sheet 内的 `OutlineLinkConfirmSheet`（`OutlineNodeSheet.tsx:709`），采用后仍停留在节点抽屉，未实现「先回大纲树并高亮新节点」。Lead 已说明受 S4/S5 写范围限制、M1 可接受。**判定：可接受**（非阻塞数据安全/交互正确性问题），建议 M2 或 UI 打磨时补「回到树+高亮」。
2. **计划 S8 的文档更新未执行**：`docs/使用说明.md`（细化大纲/整章生成两节）与 `docs/开发计划.md`（M1 实施记录）未改（`git status docs/` 为空）。不影响功能验收，但属于 plan S8 交付；**建议合并前补齐**。
3. **泛化别名唯一命中时仍可能默认被建议**：如子节点只写「师父」而知识库有别名「师父」的条目，`suggestOutlineLinks` 会给出该建议（评分已降权、排在后面；设计 D1 允许 title/alias 精确命中）。属「宁漏勿错」的已知边界，**人工抽检时观察**；若抽检错配超标再考虑加阈值（不阻塞）。

### P3（观察 / 已知限制）

4. `DexieNovelRepository.ts:499` append 起始 order = 现有兄弟数；删除中间兄弟或历史 order 有 gap 时可能与既有 order 撞号。`listOutline` 以 createdAt 兜底、树渲染确定；与旧 `createOutlineNode`/旧 apply 同语义，**非 M1 回归**。
5. `NovelRepository.ts:168` `updateOutlineLinks` 无 `novelId` 入参（按设计签名）；调用方（S4/S5）只传当前作品节点，已验证。
6. `DexieNovelRepository.ts:476` 空 nodes 检查在事务外，但发生在任何删除之前，原子性无影响（测试覆盖）。

---

## 10. 人工验收项（未执行，待人工）

本验收环境的限制：**无浏览器交互能力（无 Playwright 等自动化浏览器）与真实模型 API Key**，无法完成 `verification.md` §5 的真机 Demo 与真实模型质量判断。以下项**未执行**，不参与自动化结论：

| 项 | 状态 | 自动化等价覆盖 |
| --- | --- | --- |
| Demo D1/D2（真实数据准备） | 未执行 | 数据等价于 e2e 夹具 |
| Demo D3（真实模型细化 + 场景卡质量 + 注入清单观感） | 未执行 | 注入清单/请求体/块结构已自动化；**场景卡文学质量不可自动化** |
| Demo D4（真实采用 → 关联面板 → links 落库 → 重开抽屉） | 未执行 | 关联面板行为/落库/父链接不变已自动化（jsdom） |
| Demo D5（真实 replace 告知与解链） | 未执行 | 确认框数字/取消不发请求/事务回滚已自动化 |
| Demo D6/D6c（真实生成目标来源与结构） | 未执行 | 目标来源/请求体/文案已自动化 |
| Demo D6b（真实服务商截断） | 未执行 | 截断三态用 stub SSE 确定性覆盖 |
| 指标 2 人工抽检 20 例 | 未执行 | 自动化陷阱 0/20 错配 + 不变量校验 |
| 指标 3 细纲可写性 10 例 | 未执行 | 仅能证明约束进入 prompt，不能证明模型遵守 |
| 375px/1280px 视觉与移动端触控 | 未执行 | jsdom 无布局 |

**给人工执行的最小清单**（按 `verification.md` §5）：① 真实 API 走 D3/D4/D5/D6；② 指标 2 抽 20 例判错配；③ 指标 3 抽 10 例子节点按四要素+反事实评分；④ 375px/1280px 各看一遍注入清单/关联面板；⑤ 记录填 `verification.md` §5.4 模板。**建议 Lead 在合并前安排；若指标 2/3 不达标，再评估是否阻塞 M2。**

---

## 11. 未覆盖风险（残余）

1. 真实模型输出质量与随机性：指标 1 只保证 prompt 覆盖；指标 2/3 的人工部分未做（§10）。
2. 真实服务商 `max_tokens` 兼容：自动化只模拟 400 回退，未对多 provider 真机验证；Demo D6b 可选验证真实截断。
3. fake-indexeddb 与真实浏览器 IndexedDB 的差异：事务回滚、并发（多标签页）未真机验证；TOCTOU 用「apply 前删 anchor」行为测试 + 事务内校验代码审查替代。
4. 移动端视觉/触控尺寸只能人工（§10）。
5. 文档与使用说明未同步（P2-2）。
6. 无 Git commit：验收证据基于工作区快照（mtime 已证明冻结）；若后续合并时改动文件，本报告结论需要重跑。

---

## 12. 是否建议进入 M2

**建议：进入 M2（有条件）。**

依据：
- 自动化验收 100% 通过（US-1~US-5 自动化点、指标 1/4/5/6、反向 R1–R40、零迁移、基线审查）；
- 无 P0/P1，无静默重生，无越界改动；
- 条件：① 合并/发布前完成 §10 的人工 Demo 与指标 2/3 抽检；② 补齐 S8 文档（P2-2）；③ 关联面板呈现形态（P2-1）计入 M2 打磨/后续任务。

M2 起步建议：T1 收尾（目标差额提示/「补未落地场景」）可直接复用 `chapterLength` 与生成面板的 `incomplete` 状态；「回到大纲树+高亮新节点」与关联面板的一屏心流可一并优化；`suggestOutlineLinks`/`planningContext` 已为 M3 自动大纲保留纯函数接口。
