# M1 独立验证方案 · 大纲细化的上下文、场景卡与字数结构件

> 角色：qa-verifier（测试，独立于开发）
> 依据：`requirements.md` / `decisions.md` / `design.md` / `plan.md`（2026-10-27 版）
> 代码基线：`52e124eaee097a47bc7d578ed7596d8599061615`（M1 改动前的 HEAD，2026-10-26）
> 工作方式：M1 全部改动都是未提交的工作区改动；QA 的独立测试只放 `src/test/m1/`，**不修改开发写的测试、不修改 feature 代码、不 git commit**。
> 阶段：QA0＝本文件（task-9）→ QA1＝S6 + S1/S2 独立验证（task-10）→ QA2＝全量最终验收（task-11，产出 `verification-report.md`）。

---

## 0. 边界、原则与放行条件

### 0.1 角色边界

| 做                                                                     | 不做                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 读实现 diff、写 `src/test/m1/**` 独立测试、跑验证命令、写验证文档      | 改 `src` 下任何 feature 代码（含 `outlineExpand.ts`、基线测试文件） |
| 用独立 golden / 独立夹具复现问题                                       | 改开发写的测试来「凑绿」；删除或弱化开发断言                       |
| 发现阻塞先 message 对应开发（dev-infra / dev-feature）并抄送 Lead      | 在他人半成品上跑全量并当作回归证据；git commit / git stash / rebase |

### 0.2 验证原则

1. **一条验收项一份独立证据**：不允许「全量测试绿了」作为唯一证据；证据＝命令 + 断言位置（file:line）+ 实际输出/截图。
2. **独立于开发基线**：开发可以更新 `noScenarioBaseline` / `noNormsBaseline` 的字面量，因此 QA 另建**从 HEAD 冻结的 golden**（§2.3）作为「静默重生」的真正护栏。
3. **自动化优先，人工补不可替代项**：prompt 组装、事务原子性、截断/回退、匹配与预算必须自动化；场景卡质量、关联可写性、移动端观感只能人工。
4. **先归因再报障**：跑测试前看 `git status --short` + `git diff --stat`；失败先判断是否他人进行中（S3 在改 `outlineExpand.ts` 与基线），不确定先问 Lead，再决定是否计入 M1 回归。
5. **失败可独立复现**：每个 finding 必须给最小复现命令（单文件 vitest）与 `file:line`。

### 0.3 阶段与放行条件

| 阶段          | 前置（Lead 放行）                                                 | 范围                                                                         | 全量测试？               |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------ |
| QA0（task-9） | 无                                                                | 本方案                                                                       | 否                       |
| QA1（task-10）| S6 完成；S1/S2 完成（task-4/task-6 completed）                     | S6 事务/回滚/解链；S1 匹配；S2 选择器/渲染复用/canary；越界与 any/console 扫描 | 否（只跑相关范围）       |
| QA2（task-11）| S3、S4/S5、S7 完成；**Lead 确认开发已停手**                        | 全矩阵 + 反向测试 + 基线审查 + Demo + 全量门禁                               | 是（typecheck/test/build）|

QA1 期间 dev-feature 可能正在 S3（`outlineExpand.ts` + expand 基线）：QA1 的独立测试不得依赖 `outlineExpand` 的当前输出；若范围测试失败，先看 `git diff --stat` 与最近修改时间再归因。

### 0.4 阻塞分级与升级

| 级别 | 定义                                                                                       | 动作                                             |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| P0   | 数据安全（半棵树、静默删/丢 links、事务未生效）；零回归被破坏（非设计允许的 prompt 变化）；`typecheck`/`test`/`build` 红且非允许的基线变更；新增 Dexie/备份版本或 schema 字段；越界改其他模块 | 立即 message 对应开发 + 抄送 Lead，QA1/QA2 结论记「阻塞」，不自行修 |
| P1   | 验收项失败（US 某条不成立）、指标未达标（如错配率 >5%）、反向项失败但无数据风险             | 写入 finding，可继续其余验证；结论「有条件通过/阻塞」由 Lead 定 |
| P2   | 与设计不一致但无安全风险、文案/可用性问题、设计未覆盖的边界                                 | 记录为观察项/遗留风险，不阻塞 M2 建议             |

阻塞消息模板（发给开发，抄送 Lead）：

```
[QA 阻塞] task-id / 阶段 QA1|QA2
结论：阻塞（P0/P1）
现象：<一句话>
证据：<file:line> + 复现命令 `<npx vitest run 路径>`
期望：<设计要求/需求条目>
实际：<输出或断言差异>
未做：我未修改任何 feature 代码，需要你修实现或与我确认是否设计变更。
```

---

## 1. 需求 → 验收矩阵

### 1.1 用户故事矩阵

「方式」含义：**[自动]**＝`src/test/m1/` 独立测试；**[基线 diff]**＝HEAD 冻结 golden 对比；**[人工]**＝Demo/抽检；**[审查]**＝读 diff 结论。

| ID    | 验收点（来自 requirements §4）                                                                 | 方式                  | 独立证据（文件｜断言｜命令）                                                                                                                                                      | 阶段 | 判定            |
| ----- | ---------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------- |
| US-1a | 细化面板「本次参考设定」列出名称命中的沈砚/裴照 + 核心设定（含来源与 token）                    | [自动]+[人工]         | `m1-e2e-outline-refine.test.tsx`：注入清单含「核心设定 N 条 / 相关设定 显式 X + 提到 Y / tokens」；条目带来源标记。Demo D3 目视                                                       | QA2  | 全部出现        |
| US-1b | 模型收到的 user prompt 含命中条目**完整字段**（分类、别名、摘要、字段），不只是「标题：摘要」     | [自动]                | 同上：stub fetch 捕获请求体，断言 user 含 `## 沈砚（人物）`、`说话方式：短句、爱用反问`、`软肋与恐惧：妹妹`；且 system 不含 related 条目                                   | QA2  | 完整字段在场    |
| US-1c | 生成出的子节点梗概由软肋/规则代价驱动选择，而非只出现名字                                       | [人工]                | 指标 3 抽检（§5.3）；automated proxy＝system 含场景卡约束（`m1-s3-prompt-contract.test.ts` 断言设计 §4.1 语义句）                                                               | QA2  | ≥8/10（见指标） |
| US-2a | 采用后出现「关联确认」面板：按子节点分组、默认全选、继承标「继承」、显示命中名、可逐条取消         | [自动]+[人工]         | `m1-e2e-outline-refine.test.tsx` + `m1-s4s5-suggest-links.test.ts`：面板分组数＝新子节点数；`inherited` 标记；别名命中显示 matchedName；取消后 chip 取消态                       | QA2  | 全部成立        |
| US-2b | 确认后写入 `linkedEntryIds`；取消的不写；不点确认一条不写；父节点显式关联不丢                    | [自动]                | 同上：确认前 DB links 全空→确认后＝选中共；取消项不在 union；父节点 links 前后不变；`repository.updateOutlineLinks` 只被调用 1 次（spy）                                        | QA2  | 全部成立        |
| US-2c | 被拒绝/跳过的提案不出现面板、不写任何 links；本次会话取消过的条目不再建议                        | [自动]                | `m1-e2e-outline-refine.test.tsx`：全部拒绝→无面板、links 全空；「全部跳过」→零写入；`suggestOutlineLinks` 单测：`suppressed` 集合过滤                                                 | QA2  | 全部成立        |
| US-3a | 已有 3 个子节点、2 个已挂章节时，细化前确认框列出「替换 K 个 / M 章解除关联（含已有正文数）」    | [自动]+[人工]         | `m1-e2e-outline-refine.test.tsx`：ConfirmDialog 文案断言 K、M、withContent；取消→`fetch` 0 次。Demo D5                                                                          | QA2  | 数字与文案正确  |
| US-3b | 采用失败不留半棵树、不删掉一半旧节点（事务原子性）                                              | [自动]                | `m1-s6-outline-subtree.contract.test.ts` + `m1-s6-apply-outline-tree.test.ts`：注入第 N 个节点非法→整批回滚，旧树/旧章节关联原样；提案仍 pending                               | QA1  | 无半棵树        |
| US-3c | replace 成功：旧子树删除、正文保留、章节 `outlineNodeId` 置 null                                | [自动]                | 同上：章节 content 不变、outlineNodeId===null；`replace + anchor=null` 同样覆盖（Lead 裁决的整本顶层替换）                                                                      | QA1  | 全部成立        |
| US-4a | targetWords=6000：面板显示「目标 6000 字（来自大纲）」                                          | [自动]+[人工]         | `m1-e2e-chapter-length.test.tsx`：文案含 6000 与「大纲」来源。Demo D6                                                                                                            | QA2  | 100% 显示       |
| US-4b | prompt 要求 3–5 场、按梗概节拍展开、自然收束、钩子结尾、文体冲突以本节目标为准                  | [自动]                | `m1-s7-chapter-length.test.ts`（纯函数边界）+ `m1-e2e-chapter-length.test.tsx`：user prompt 含「3–5 场」「节拍」「自然收束」「钩子」「以本节目标为准」                            | QA2  | 全部在场        |
| US-4c | `finish_reason=length`：显示「生成被截断，未完成」，保留内容，建议续写/重试，采用需二次确认      | [自动]                | `m1-e2e-chapter-length.test.tsx`：构造 SSE `finish_reason:'length'`；断言截断文案 + 采用弹 ConfirmDialog，取消不写 | QA2  | 100% 显示       |
| US-4d | 用户中止：标记「未完成/已中断」，保留已流出内容，采用同样二次确认                                 | [自动]                | 同上：SSE 流中断后点「停止生成」，断言中断文案与二次确认                                                                                                                        | QA2  | 100%            |
| US-5a | targetWords 空：显示「目标 3000 字（默认）」，prompt 按 3000 处理                                | [自动]                | `m1-e2e-chapter-length.test.tsx`：文案含 3000 与「默认」；user prompt 1–2 场；请求体 `max_tokens===6200`                                                                        | QA2  | 100%            |
| US-5b | 提示作者可去大纲修改目标                                                                        | [自动]                | 面板含「在写作 → 大纲节点里修改」类提示（精确文案以实现为准，断言关键词）                                                                                                        | QA2  | 提示在场        |

### 1.2 成功指标矩阵（requirements §5，6 条）

| #   | 指标                       | 阈值             | 方式                                                     | 具体做法与证据                                                                                                                                                                                                                     | 阶段 |
| --- | -------------------------- | ---------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 细化设定覆盖率             | ≥18/20           | [自动] 20 例矩阵 + [人工] 少量真实模型抽检                | `m1-metrics-coverage.test.ts`：20 个确定性夹具覆盖「梗概/祖先/额外要求提到条目、别名、全半角、核心+相关混排」，对每个病例断言 user prompt 含该条目 `renderEntry` 全文；另做 1 例「组件请求体 vs 纯函数期望」对齐，证明接线一致 | QA2  |
| 2   | 关联质量（错配率）         | <5%（宁漏勿错）  | [自动] 陷阱夹具 + [人工] 20 例抽检                        | `m1-metrics-association.test.ts`：泛化别名（师父/他）、2 字名、同名不同条、父显式继承、pinned 排除等陷阱的排序/排除断言；人工按 §5.3 抽 20 例判对错，错配 >1/20 即不达标                                                              | QA2  |
| 3   | 细纲可写性                 | ≥8/10            | [人工] 不可自动化                                         | Demo 多轮细化累计 ≥10 个子节点；按四要素（目标/阻碍/转折/结尾局面或认知变化）+「至少 1 处选择由软肋或规则代价驱动且改变后文」评分；做反事实检查（换掉软肋场景是否变化）。记录 prompt 版本与输出原文（§5.3）                          | QA2  |
| 4   | 截断可见性                 | 100%             | [自动]                                                    | `m1-e2e-chapter-length.test.tsx`：`length` / `aborted` / `finishReason=null` 三态全覆盖；length 与 aborted 必须显示未完成，null 不得误报                                                                                            | QA2  |
| 5   | 字数目标可见性             | 100%             | [自动]                                                    | 同上：大纲值/默认值两种来源都必须显示数值与来源                                                                                                                                                                                    | QA2  |
| 6   | 零回归                     | 全绿 + 零意外   | [自动]+[基线 diff]+[审查]                                 | ① HEAD golden canary（§2.3）② 开发基线逐条审查（§3）③ `npm run typecheck`、`npm run test:run`、`npm run build` ④ Dexie v7 / 备份 v4 不变（`m1-zero-migration.test.ts`）                                                          | QA1/QA2 |

> 指标 1 的判据按指标原文是「prompt 中包含完整字段」，这是确定性可自动化的；真实模型是否「用上」设定归指标 3 人工判断，两者不混用。

### 1.3 零迁移与范围红线（[审查]）

- **禁止改动**：`src/data/dexie/db.ts`（保持 version 7）、`src/features/export/backup.ts`（`BACKUP_VERSION=4`）、`src/domain/schema.ts` 的实体字段、`src/domain/entrySearch.ts`（`mentionedEntries` 语义不变）。
- **允许改动**：design §10 文件清单内的文件 + 各开发任务描述里列出的测试文件。
- **越界即 P0**：`git diff --name-only` 与 design §10 清单做差集；新增文件只应为该清单中的新文件。
- 口令：`git diff --name-only`、`git status --porcelain | grep '^??'`、`git diff -- src/data/dexie/db.ts src/features/export/backup.ts src/domain/schema.ts src/domain/entrySearch.ts` 应为空。

---

## 2. 独立测试计划

### 2.1 目录与命名

- 全部新测试放 `src/test/m1/`，命名 `m1-<范围>-<主题>.test.ts(x)`；夹具/工具放 `src/test/m1/fixtures/`、`src/test/m1/tools/`。
- 复用项目既有设施：`createTestHarness()`（`src/test/renderWithProviders.tsx`，每例独立 fake-indexeddb 库 + 干净 store）、`src/test/llmFixtures.ts`（`sseResponse` / `textDeltaEvents` / `completion` / `jsonResponse` / `recordingFetch`）、`vi.stubGlobal('fetch', …)`。
- 组件级用例统一 `useActiveNovel.setState` + `useLlmSettings.getState().applyPreset('deepseek')` + `update({apiKey:'sk-test'})`，与 `scenarioChapter.e2e.test.tsx` 同法。
- 不允许 `.snap` 快照：所有期望值用字面量/JSON 夹具，避免非 CI 环境被自动写入。

### 2.2 自动化测试文件清单

| 文件                                                   | 阶段 | 覆盖                             | 关键断言（摘要）                                                                                                                                                                         |
| ------------------------------------------------------ | ---- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/test/m1/m1-s6-outline-subtree.contract.test.ts`   | QA1  | S6 仓储契约                      | replace：删子树+解链+新建+返回前序扁平列表；`replace+anchor=null` 整本顶层替换；append 接排与 `order`；anchor 不存在/跨作品/空 nodes 抛错且零写入；`updateOutlineLinks` 批量原子 |
| `src/test/m1/m1-s6-apply-outline-tree.test.ts`         | QA1  | apply 走事务、失败语义           | `outlineTree:create/merge/replace` 端到端：anchor 在 apply 前被删→失败且提案仍 pending；中途节点非法→旧树原样；成功路径节点/顺序/解链正确；不再调用公共 `deleteOutlineNode`              |
| `src/test/m1/m1-s1-entry-mention.contract.test.ts`     | QA1  | S1 匹配评分                      | 精确分数（title 100+2×len、alias 80+2×len、1 字丢弃、2 字 −20、泛化别名 −50）；NFKC/大小写/零宽；不删内部空格/标点；同条目取最高分；全序排序稳定；limit/minScore/excludeIds          |
| `src/test/m1/m1-s2-planning-context.contract.test.ts`  | QA1  | S2 选择器                        | core 必注入且按 entries 原序、不受预算；linked 按 id 序、未知 id 丢弃、pinned 不重复；mentioned 排除 pinned/linked、最多 8；预算先丢 mentioned 低分再丢 linked、整条丢弃进 dropped；tokens 口径；两次调用深相等 |
| `src/test/m1/m1-s2-render-canary.test.ts`              | QA1  | S2 渲染搬家 canary               | `renderEntry`/`renderSummary` 对 HEAD 冻结 golden 逐字节相等（别名/字段顺序/空字段/未知分类/自定义字段）；`SummaryChainContextBuilder` 的 re-export 与新模块**同一函数引用** |
| `src/test/m1/m1-canary-stable.test.ts`                 | QA1+ | HEAD golden 零回归（稳定族）     | 与 §2.3 的 golden 对比：builderMain/Side、chapterSystem、expandUser、summary/extract/revise/setup/translate/normCheck/styleSample/manuscriptStyle 逐字节相等（QA1 追加：expandSystem 也相等） |
| `src/test/m1/m1-renderEntry.canary.fixture.json` 等    | QA1  | golden 数据                      | 由 HEAD archive 生成（§2.3），不手改                                                                                                                                                    |
| `src/test/m1/m1-s3-prompt-contract.test.ts`            | QA2  | S3 prompt 结构与缓存前缀         | core 块只在 system、位置在 norms 后 EXPAND_TASK 前；空 core 不出现；同书不同节点 system `toBe` 相同；related/openThreads/rollingSummary（仅 depth=0）/depth 的块顺序与非空才渲染；旧 `linkedEntries` 路径仍按「标题：摘要」 |
| `src/test/m1/m1-s4s5-suggest-links.test.ts`            | QA2  | S5 纯函数                        | 继承父显式关联排最前；提到项排除 pinned/已继承/suppressed；每子节点 limit 8；命中名保留原写法；全空返回空；旧节点不在输入就不建议                                                         |
| `src/test/m1/m1-e2e-outline-refine.test.tsx`           | QA2  | US-1/US-2/US-3 交互链（S4/S5）   | 注入清单显示/临时移除影响请求；先落盘再细化（改梗概未保存→用新值；标题空→不发请求）；replace 前确认框数字与取消；采用后关联面板；取消项不写；父链接不变；拒绝/跳过零写入；单次 `updateOutlineLinks`；重复细化不重复建议旧节点 |
| `src/test/m1/m1-s7-chapter-length.test.ts`             | QA2  | S7 纯函数边界                    | 3000 默认/非法回退/取整；sceneRangeHint 边界 3500/3501/7000/7001；maxTokens=ceil(w×1.8)+800 且夹取 [4096,8192]（3000→6200、6000→8192（上夹）、10000→8192）                                    |
| `src/test/m1/m1-e2e-chapter-length.test.tsx`           | QA2  | US-4/US-5 + 截断防线（S7）       | 目标来源文案；请求体 max_tokens 三档；length/aborted/null 三态；两种不完整采用二次确认；400 `max_tokens` 自动无参重试一次且不重复流式文本；非 max_tokens 400 不重试                       |
| `src/test/m1/m1-canary-intentional.test.ts`            | QA2  | S3/S7 有理由变更的「外科手术式」证明 | 当前 expandSystem＝HEAD 前缀＋新任务段（除任务段外逐字节同 HEAD）；当前 chapterUser＝HEAD 将唯一旧句替换为新结构块（其余逐字节同 HEAD）；chapterSystem≡HEAD                            |
| `src/test/m1/m1-metrics-coverage.test.ts`              | QA2  | 指标 1（20 例）                  | 见 §1.2 #1；含「纯函数期望 prompt === 组件实际请求 prompt」的接缝用例                                                                                                                    |
| `src/test/m1/m1-metrics-association.test.ts`           | QA2  | 指标 2 陷阱夹具                  | 见 §1.2 #2                                                                                                                                                                               |
| `src/test/m1/m1-zero-migration.test.ts`                | QA1/QA2 | 零迁移                           | `AppDatabase.verno===7`；`BACKUP_VERSION===4`；实体 schema parse 后 key 集合与 HEAD 一致（无新字段）；backup v1–v4 还原 smoke 不回归                                                                 |
| `src/test/m1/m1-code-hygiene.test.ts`                  | QA1/QA2 | 代码卫生                         | M1 新增文件（design §10 新增清单）无 `: any` / `as any` / `<any>` / `console.*` / `debugger`；修改文件用 diff 命令人工核对（§6.3）                                                     |
| `src/test/m1/tools/capture-head-golden.test.ts`        | QA1  | golden 生成器（默认 skip）       | `M1_CAPTURE=1` 时在 /tmp 的 HEAD archive 上跑，生成 `fixtures/head-golden.json`；正常套件中 `describe.skipIf` 跳过                                                                       |

> 开发已有的 `DexieNovelRepository.test.ts`、`apply.test.ts`、`entryMention.test.ts`、`planningContext.test.ts`、`outlineExpand.test.ts`、`outlineNodeSheet`/`GenerateChapterSheet`/`ChapterEditor` 测试仍要跑，但**只作为开发自测证据**；QA 结论以本表独立测试 + golden 为准。

### 2.3 独立基线与 canary 方法（防「静默重生」的关键）

开发会更新 `noScenarioBaseline` / `noNormsBaseline` 的字面量，那些文件不再是独立证据。QA 的独立护栏：

1. **冻结 HEAD golden**：`BASE=52e124ea…`（记录在文首，永远不变）。
   ```sh
   rm -rf /tmp/m1-head && mkdir -p /tmp/m1-head
   git archive "$BASE" | tar -x -C /tmp/m1-head
   ln -s "$PWD/node_modules" /tmp/m1-head/node_modules
   cp -R src/test/m1/fixtures src/test/m1/tools /tmp/m1-head/src/test/m1/   # 夹具与生成器（有则建目录）
   (cd /tmp/m1-head && M1_CAPTURE=1 npx vitest run src/test/m1/tools/capture-head-golden.test.ts)
   cp /tmp/m1-head/src/test/m1/fixtures/head-golden.json src/test/m1/fixtures/
   rm -rf /tmp/m1-head                       # 用完即删，仓库内不留副本
   ```
2. **同一份夹具**（`src/test/m1/fixtures/m1-prompts.fixture.ts`）同时供生成器与 canary 用：固定 novel/style/categories/entries（含 pinned、别名、全字段、空字段）、outline/chapters/summaries/norms；所有输入 `Object.freeze`，不依赖时间与随机。
3. **稳定族**逐字节相等：`builderMain/Side` 的 stablePrefix/volatileSuffix、chapterSystem、expandUser、summary/extract/revise/setup/translate/normCheck/styleSample/manuscriptStyle。
4. **有意变更族**用「外科手术式证明」：只允许固定片段被替换，其余逐字节相同——
   - expandSystem：`current === HEAD.slice(0, taskStart) + CURRENT_TASK_SECTION`，且 task 段含设计 §4.1 全部语义句；
   - chapterUser：`current === HEAD.replace(OLD_REQUIREMENT_LINE, CURRENT_REQUIREMENT_BLOCK)`，且新块含设计 §8.4 语义句；
   - chapterSystem 必须 `=== HEAD`。
5. renderEntry/renderSummary 直接用 HEAD golden（含边界夹具），并断言 `SummaryChainContextBuilder` 的导出与新文件是**同一个函数引用**。

### 2.4 只能人工验证的项

| 项                                       | 为什么不能自动化                                         | 人工方法（§5）                                   |
| ---------------------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| 细纲是否「可直接开写」（四要素/软肋驱动） | 模型生成文本的文学判断；反事实判断需人读                 | Demo D3 + 指标 3 抽检 10 例 + 反事实检查          |
| 关联是否「可写/不错配」的语义判断         | 匹配函数正确≠作者认可；同义简称需常识                     | Demo D4 + 指标 2 抽检 20 例                       |
| 注入清单/关联面板的移动端观感与心流       | jsdom 无布局；折叠/抽屉/一屏完成是视觉与交互判断          | Demo D3/D4（375px 与 1280px 各一遍）+ 截图        |
| 真实服务商的 `max_tokens` 兼容与截断行为  | 只能对单一/无真实 key 的端点验证；各 provider 差异大      | Demo D6b（真实 20000 字目标试截断）+ 记录服务商   |
| 目标字数与真实生成长度的落差              | 模型行为；M1 只要求可见性与结构承诺，不要求字数达标       | Demo D6 目视记录「目标/实际/是否截断」            |

### 2.5 测试技术要点（避免踩坑）

- **结构化任务 stub**（细化）：`jsonResponse(completion(JSON.stringify({children:[…]})))`；note `generateStructured` 对 `finish_reason=length` 默认不失败，但截断 JSON 会走修复重试。
- **流式截断**：手写 SSE 事件 `data: {"choices":[{"delta":{"content":"…"}}]}\n\n` + `data: {"choices":[{"finish_reason":"length"}]}\n\n` + `data: [DONE]\n\n`，用 `sseResponse([...])`。
- **`finishReason=null`**：SSE 只给 delta 与 `[DONE]`，不给 finish_reason 帧。
- **用户中止**：stub fetch 返回自定义 `ReadableStream`，收到 `init.signal` 的 `abort` 事件时 `controller.error(new DOMException('Aborted','AbortError'))`；先流出 1 个 delta，再让用户点「停止生成」。
- **400 回退**：第一次返回 `new Response(JSON.stringify({error:{message:'Invalid max_tokens'}}), {status:400})`，第二次返回正常 SSE；断言 `fetch` 调用 2 次、`bodies[0].max_tokens` 有值、`bodies[1].max_tokens` 为 undefined、流式文本不重复。
- **事务回滚注入（黑盒）**：`commitOutlineSubtree` 传入 `[合法, 合法, 标题 201 字]` 使其在事务中途 Zod 抛错（父先落库、后续节点失败），断言旧树/旧关联完全不变；同理 `updateOutlineLinks([{合法}, {id:'ghost'}])` 整批回滚。**不 monkeypatch Dexie 或 feature 实现**。
- **事务边界证据**：`vi.spyOn(database, 'transaction')` 统计调用与表清单（design §7.2 要求单事务），并用「公共 `deleteOutlineNode` 在 commit 期间未被调用」的 spy 证明未嵌套事务。
- **父节点归属校验**：anchor 属于别的 novel → 抛错且不写入；apply 层在 apply 前删除 anchor → 抛错、提案仍 pending、无树写入。
- **确定性**：同一输入调用两次，`toEqual` 深比较；排序断言用完整数组（`.map(x=>x.id)`) 而非 `toContain`。

---

## 3. 基线审查清单（S3 / S7）

### 3.1 审查对象与锚点（行号以 HEAD `52e124e` 为准，落地后以内容锚点重定位）

重定位命令：`grep -n "expandSystem:\|expandUser:\|chapterSystem:\|chapterUser:\|本章篇幅约 3000 字" src/context/noScenarioBaseline.test.ts src/context/noNormsBaseline.test.ts src/features/writing/ChapterEditor.test.tsx`

| 文件                                          | 锚点（HEAD 行）                                     | 由谁改 | 期望变更                                                                                                       | 禁止                                                         |
| --------------------------------------------- | --------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/context/noScenarioBaseline.test.ts`      | `expandSystem:` 字面量 1709–1764                    | S3     | **仅任务段**：`【任务】…` 增补设计 §4.1 的场景卡/设定落地/章末钩子/字数条目；任务段之前（角色+风格+规范）逐字节不变 | 前缀、规范段、格式变化；新增空行/标点漂移                     |
| 同上                                          | `expandUser:` 字面量 1765–1792                      | S3     | **应完全不变**（旧参数调用，`related` 未传，设计 §4.2/requirements 指标 6 要求逐字节不变）                       | 任何变化；若变必须按 P1 spec 冲突上报 Lead，不得默默接受        |
| 同上                                          | `chapterSystem:` 1012 起                            | S7     | 不变（`CHAPTER_TASK` 不动）                                                                                     | 任何变化                                                     |
| 同上                                          | `chapterUser:` 1088 起（旧句 1126）、`sideChapterUser:` 1205 起（旧句 1228） | S7     | 仅「本章篇幅约 3000 字，可上下浮动 15%。」一行替换为设计 §8.4 的新结构块（两处：显式 3000 与 null→3000，文案相同） | 其余任何差异；新块缺语义句；两侧不一致                        |
| `src/context/noNormsBaseline.test.ts`         | `expandSystem:` 993 起 / `expandUser:` 1327 起      | S3     | 同 noScenario 规则                                                                                              | 同左                                                         |
| 同上                                          | `chapterUser:` 1107 起（旧句 1145）                 | S7     | 同 noScenario 的 chapterUser 规则                                                                               | 同左                                                         |
| `src/features/writing/ChapterEditor.test.tsx` | 请求体断言 333–352（`约 3000 字` 在 348）           | S7     | 允许把旧句断言换成新结构断言，并**新增** `max_tokens` 断言                                                      | 弱化既有断言（删 `system`/`user`/`thinking`/`model`/`stream` 检查）、只留 `toContain('正文')` 之类空转 |
| `src/context/noNormsInputs.test.ts`           | 全文                                                | （不应改） | 其「夹具同步」用例依赖两份基线夹具区逐字一致；若夹具区被改，两份必须同步且需说明                                 | 为让测试变绿而改夹具同步逻辑                                 |

### 3.2 期望变更 / 禁止变更（S3 与 S7 必须可分离）

- **S3 允许**（且仅）：`expandSystem` 任务段文本；`outlineExpand.ts` 的新可选参数与块渲染（不影响旧调用输出）；`buildExpandSystemPrompt` 的 core 块**只在传 core 时**出现；`outlineExpand.test.ts` 新增用例。
- **S7 允许**（且仅）：`chapterUser` 中的字数结构块；`chapterDraft.ts` 的目标解析；`chapterLength.ts`；`GenerateChapterSheet` 的显示/maxTokens/incomplete；`types.ts`/`useLlm.ts` 的 `maxTokens` 透传；`ChapterEditor.test.tsx` 请求体断言同步 + 新增 `GenerateChapterSheet.test.tsx`。
- **两族交叉即问题**：S3 不应改动 chapter 行；S7 不应改动 expand 行。工作区无 commit 时按 diff 的 hunk 内容归属，不按文件归属。
- **整段「重新生成」识别**：diff 中出现大段删除+大段新增（>30 行连续）而不是定点替换 → 重点核对是否静默重生。

### 3.3 审查步骤（QA2 执行，证据写入 report）

```sh
# 0) 快照：记录 HEAD 与工作区状态
git rev-parse HEAD && git status --short && git diff --stat

# 1) 只看三处基线/请求断言的 diff，逐 hunk 分类
git diff -U3 -- src/context/noScenarioBaseline.test.ts src/context/noNormsBaseline.test.ts src/features/writing/ChapterEditor.test.tsx

# 2) 删除行清单（允许清单核对）
git diff -U0 -- <同上文件> | grep '^-' | grep -v '^---'

# 3) 禁止文件（应为空）
git diff --name-only -- src/context/noNormsInputs.test.ts src/data/dexie/db.ts src/features/export/backup.ts src/domain/schema.ts src/domain/entrySearch.ts

# 4) 独立 canary（不依赖开发基线）
npx vitest run src/test/m1/m1-canary-stable.test.ts src/test/m1/m1-canary-intentional.test.ts src/test/m1/m1-s2-render-canary.test.ts
```

判定：

1. 每个 hunk 必须能归入 S3 或 S7 的允许清单；归不进去 = P0（静默回归）。
2. `expandUser` 与 `chapterSystem` 字面量不得变；变了先按 P1 上报，由 Lead 裁决是否设计变更。
3. 稳定族 golden 全部相等；有意变更族通过外科手术式证明。
4. 没有 `.snap` / `__snapshots__` 新增；没有测试被删除或 `it.skip`。
5. 基线变更逐条记入 report 的「有理由变更」表（§3.5）。

### 3.4 「静默重生」识别特征（出现任一即重点排查）

- 基线字面量的变化超出上述允许句子：空白、换行、全半角标点、块顺序、`【】` 标题变化。
- 新块出现在**旧调用路径**（不传新参数 / core 为空）的 prompt 里。
- 同一 hunk 同时混有 S3 与 S7 的变更；或基线文件大段重排。
- `expectBaseline` 被改宽：删除 `Object.keys(now).sort()` 对照、把 `toBe` 改 `toContain`、只挑几个 key 断言。
- 新增 `.snap` 文件或 `__snapshots__/` 目录（项目明令不用快照）。

### 3.5 「有理由变更」记录模板（写入 verification-report）

| #   | 文件:行（内容锚点） | 变更前 | 变更后 | 原因（对应设计/需求） | 归属 | 结论 |
| --- | ------------------- | ------ | ------ | --------------------- | ---- | ---- |
| 1   | noScenarioBaseline `expandSystem` 任务段 | 旧 7 条要求 | 新场景卡任务段 | design §4.1、US-1 | S3 | 接受 |
| 2   | noScenarioBaseline `chapterUser` 旧句 | 本章篇幅约 3000 字… | 新结构块 | design §8.4、US-4/5 | S7 | 接受 |
| …   |                     |        |        |                       |      |      |

---

## 4. 反向测试清单

> 每项给出构造与期望；「证据」列指向 `src/test/m1/` 文件（QA1/QA2 按阶段补齐）。R 编号在 report 中逐条引用。

### 4.1 S6 / 事务与解链（QA1）

| #   | 场景                          | 构造                                                                                         | 期望                                                                                                       | 证据 |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---- |
| R1  | replace 常规                   | anchor 有 2 子节点（含孙）；2 章挂其中 2 节点且有正文                                          | 旧子树全删；新树无重复；章节 content 不变、outlineNodeId=null；返回前序扁平列表 id 与 parentId 正确          | `m1-s6-outline-subtree.contract.test.ts` |
| R2  | **replace + anchor=null**（Lead 裁决） | 顶层已有 2 根（带子树与挂章），传 null + 新 2 棵根树                                          | 等同「整本顶层替换」：旧根/子树删除、受影响章节解链、新根无重复且 order 0..n-1；**不得**按「必须抛错」断言 | 同上 |
| R3  | replace + anchor 非法         | anchor 不存在 / 属于另一部 novel                                                              | 抛错；旧树、旧链接、章节关联全部原样（零写入）                                                              | 同上 |
| R4  | replace 空 nodes              | `nodes=[]`                                                                                    | 抛错；旧树不变（不能出现「删了旧的没建新的」）                                                              | 同上 |
| R5  | append 顺序                   | anchor 下已有 2 个兄弟；append 2 棵树                                                          | 新节点 order 从现有兄弟数起（2,3），原有 0,1 不变；`anchor=null` 时从顶层根数起                                | 同上 |
| R6  | 事务中途失败回滚              | nodes 第 3 个节点标题 201 字（Zod 上限 200）→ 事务内抛错                                       | 旧树/旧关联/章节不变；无任何新节点残留                                                                     | 同上 |
| R7  | `updateOutlineLinks` 原子     | `[{id:合法, links:[a]}, {id:'ghost', links:[b]}]`                                              | 整批抛错；合法那条也**没有**写入                                                                             | 同上 |
| R8  | `updateOutlineLinks` 边界     | `[]`；同一 id 重复；只改 links                                                  | 空数组 no-op；只动 linkedEntryIds（标题/梗概/状态/updatedAt 之外字段不变）；不存在的 linkedEntryId 是否允许写入按设计（设计未要求校验条目存在，记录实现事实） | 同上 |
| R9  | apply 走事务（TOCTOU）        | 先建 `outlineTree` 提案，apply 前删掉 anchor                                                  | apply 拒绝；提案仍 pending；outline 无新节点；错误信息可读                                                    | `m1-s6-apply-outline-tree.test.ts` |
| R10 | apply 失败不留半棵树          | `outlineTree` payload 中间节点非法（如标题超长）                                                | 失败；旧树完整；提案仍 pending（调用方未标记 accepted）                                                      | 同上 |
| R11 | 不嵌套事务                    | spy `repo.deleteOutlineNode`；执行 `commitOutlineSubtree` replace                              | 公共 `deleteOutlineNode` 调用 0 次；`db.transaction` 参与表含 outlineNodes+chapters                          | `m1-s6-outline-subtree.contract.test.ts` |
| R12 | 前序返回值                    | 2 层树 `[A(A1,A2), B]`                                                                        | 返回 `[A, A1, A2, B]`（前序）；每个 id 能在库中查到；子 parentId 指向父 id                                    | 同上 |

### 4.2 S3/S4/S5 / 匹配、选择与关联（QA2）

| #   | 场景                         | 构造                                                                 | 期望                                                                                                   | 证据 |
| --- | ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---- |
| R13 | 空输入向后兼容               | `buildExpandUserPrompt` 不传新参数（含 entries 为空、梗概为空）        | 与 HEAD golden 逐字节相同；`buildExpandSystemPrompt` 无 core 时 = HEAD 前缀 + 新任务段（仅此一处变化）  | `m1-canary-stable.test.ts` / `m1-canary-intentional.test.ts` |
| R14 | 无条目旧调用                 | 知识库 0 条目，梗概不点名                                             | 不渲染【核心设定】【相关设定】空块；prompt 无空标题；请求正常发出                                      | `m1-e2e-outline-refine.test.tsx` |
| R15 | 被拒提案不写 links           | 细化 → 提案全部拒绝 → onSettled                                        | 不出现关联确认面板；所有子节点 links=[]；无 `updateOutlineLinks` 调用                                   | 同上 |
| R16 | 不点确认 / 全部跳过          | 采用提案成功但关联面板不确认；或点「全部跳过」                        | links 一条不写；父节点 links 不变                                                                       | 同上 |
| R17 | 连点细化                     | 快速点两次「细化这一节点」                                            | running 期间按钮禁用；只发 1 次请求；只有 1 批提案                                                      | 同上 |
| R18 | 重复细化 / 旧节点不重复建议  | 采用第一批 → 对同一节点再次细化 → 再采用                              | 第二批只对新子节点建议；旧子节点（若存在）不出现；建议不跨批重复                                        | 同上 |
| R19 | 会话内抑制                   | 面板取消条目 E；`suggestOutlineLinks({suppressed:{"child:E"}})`       | E 不再出现在建议里（纯函数级）；组件级：跳过后面板不重复给同项（以实际新子节点 id 为准，记录限制）       | `m1-s4s5-suggest-links.test.ts` |
| R20 | 父节点显式关联继承           | 父 linkedEntryIds=[E1]；子节点梗概不含 E1                             | 每个新子节点建议含 E1（reason=inherited，排最前）；父节点 links 不变                                    | 同上 |
| R21 | 泛化别名/短名/同名（指标 2） | 文本含「师父」「他」、2 字名「裴照」与长名「裴照之」、同名不同条        | 排序长名>短名；泛化别名降权排后；不同条目都保留但顺序稳定；建议面板不默认把泛化别名当高可信（记录策略） | `m1-metrics-association.test.ts` |
| R22 | 匹配归一化边界               | 全角「Ａｓｈ」、零宽字符、大小写、内部空格、简繁「沈硯/沈砚」          | NFKC/大小写/零宽命中；不删内部空格→「A sh」不命中；简繁不转换→不命中（锁定设计范围）                     | `m1-s1-entry-mention.contract.test.ts` |
| R23 | 缓存前缀                     | 同一本书、两个不同节点的 related 不同                                   | 两次请求 system 逐字节相同（核心设定稳定前缀）；related 只在 user；第二章正文 system 与第一章相同        | `m1-s3-prompt-contract.test.ts` |
| R24 | 先落盘再细化                 | 改梗概/关联/目标字数不点保存，直接「细化这一节点」                     | 先 `updateOutlineNode` 再请求；请求使用的梗概/关联/字数＝面板最新值；标题空 → 提示且不发请求            | `m1-e2e-outline-refine.test.tsx` |
| R25 | replace 影响告知             | 3 子节点（含孙）、2 章挂接（1 有正文）                                 | 确认框含替换数/解链数/已有正文数；取消 → fetch 0；确认 → 正常发请求                                     | 同上 |
| R26 | 注入清单临时移除             | 面板移除一条 mentioned                                                 | 本次请求 user prompt 不含该条目；不写库；下次打开恢复为建议（不落库是设计 D2）                           | 同上 |

### 4.3 S7 / 生成与截断（QA2）

| #   | 场景                    | 构造                                                                   | 期望                                                                                                        | 证据 |
| --- | ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---- |
| R27 | 截断（length）          | SSE 带 `finish_reason:'length'`                                         | 界面「生成被截断，内容不完整…」；保留已生成文本；建议续写/重试；点采用弹二次确认，取消不写                       | `m1-e2e-chapter-length.test.tsx` |
| R28 | 用户中止（aborted）     | 流出 1 段后点「停止生成」（abort 触发流错误）                            | 界面「生成已中断，内容不完整」；有内容则保留并进入 done；采用同样二次确认                                       | 同上 |
| R29 | `finishReason=null`     | SSE 无 finish_reason 帧                                                | 视为未知：正常「生成完成」，**不**显示截断/中断，采用**不**弹二次确认                                          | 同上 |
| R30 | 400 max_tokens 回退     | 第 1 次 400（detail 含 `max_tokens`），第 2 次成功 SSE                  | 自动重试 1 次且不带 `maxTokens`；请求体 `max_tokens` 首次有、重试无；流式文本不重复；最终完成                   | 同上 |
| R31 | 400 非 max_tokens       | 400（detail 不含 max_tokens）                                          | 不重试（fetch 1 次）；显示错误                                                                               | 同上 |
| R32 | 400 重试仍失败          | 两次 400                                                               | 共 2 次请求后显示错误；不循环重试                                                                             | 同上 |
| R33 | maxTokens 边界          | targetWords 3000 / 6000 / 10000 / null / 非法（0、-1、NaN、小数）        | 6200 / 8192（上夹）/ 8192 / 6200 / 回退 3000→6200；场景提示 1–2 / 3–5 / 3–6；取整规则                             | `m1-s7-chapter-length.test.ts` |
| R34 | 目标来源显示            | 大纲 targetWords=6000 / 空                                             | 「6000 字（来自大纲）」/「3000 字（默认）」+ 去大纲修改提示；两态 100% 显示                                     | `m1-e2e-chapter-length.test.tsx` |
| R35 | 正常完成不受影响        | 普通 SSE（无 finish_reason）                                            | 与 HEAD 相同的完成路径；采用不弹二次确认；正文写入行为不变                                                     | 同上 |

### 4.4 零回归 / 零迁移（QA1/QA2）

| #   | 场景             | 构造                                                                 | 期望                                                                                       | 证据 |
| --- | ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---- |
| R36 | 稳定族 prompt    | HEAD golden 的固定夹具                                                | 逐字节相等（不依赖开发基线）                                                                 | `m1-canary-stable.test.ts` |
| R37 | 有意变更族       | expandSystem / chapterUser                                            | 外科手术式证明：只有允许片段变，其余逐字节同 HEAD                                           | `m1-canary-intentional.test.ts`（QA2） |
| R38 | 零迁移           | 检查 `AppDatabase.verno`、`BACKUP_VERSION`、实体 schema key 集合      | verno=7、BACKUP_VERSION=4、无新增字段；backup v1–v4 还原 smoke 不变                          | `m1-zero-migration.test.ts` |
| R39 | 越界改动         | `git diff --name-only` + 未跟踪文件                                    | 与 design §10 + 任务写范围一致；禁止文件为空                                                 | report 审查表 |
| R40 | 代码卫生         | M1 新增文件扫 `: any` / `as any` / `console.*` / `debugger`            | 新增文件 0 命中；修改文件的 diff 新增行 0 命中（既有历史命中不算）                           | `m1-code-hygiene.test.ts` + §6.3 命令 |

---

## 5. 验收 Demo 步骤与记录模板

### 5.1 环境准备

1. `node -v`（记录；仓库 `engines` 要求 ≥22.22.2，M1 与版本无关，但记录实际环境）；`npm ci` 状态、`git rev-parse HEAD`、`git status --short` 摘要。
2. 独立浏览器 profile/隐身窗口打开 `http://localhost:5173`（避免旧 IndexedDB 数据串味）；视口先 375px（移动）再 1280px（桌面）各走一遍关键面板。
3. 设置：DeepSeek 预设 + 真实 API Key；记录模型名与预估费用；确认「思维链」等开关为默认。
4. 新建作品《归墟纪（M1 Demo）》；记录创建时间与 novelId（可从导出/备份读出，或截图）。

### 5.2 步骤（D1–D7，每步记录「预期 / 实际 / 证据」）

| 步骤 | 操作                                                                                       | 预期观察点                                                                                                                       | 关联验收 |
| ---- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D1   | 建两条人物条目：沈砚（说话方式：短句、爱用反问；软肋与恐惧：妹妹）、裴照（关系网：与沈砚有旧怨）；再建一条 pinned 世界观（如「渡口以北是禁地」） | 条目保存成功；pinned 标记可见                                                                                                     | US-1     |
| D2   | 新建卷节点，梗概「沈砚在渡口与裴照相遇，被迫接下去北方的差事」，**不手工关联任何条目**       | 节点无手工 links                                                                                                                  | US-1     |
| D3   | 点「细化这一节点」                                                                         | ① 面板出现注入清单：核心设定 N 条、相关设定「显式 0 + 提到 2」、约 X tokens；沈砚/裴照在清单中且来源为「提到」；② 生成结果子节点梗概为场景卡，至少 1 处选择由「妹妹」软肋或「禁地规则」代价驱动；③ 采用后回到大纲树并高亮新节点 | US-1、指标 1/3 |
| D4   | 采用 → 关联确认面板                                                                        | ① 按子节点分组、默认全选、继承项标「继承」；② 取消一条 → 确认；③ 重开节点抽屉，links＝所选条目；④ 父节点 links 未变；⑤ 关闭面板/全部跳过时一条不写 | US-2、指标 2 |
| D5   | 对已有 3 个子节点（其中 2 章已有正文）的节点再次细化                                        | ① 先弹「将替换 K 个子节点、M 章解除关联（N 个已有正文）」；② 取消→不扣费不发请求；③ 确认并采用后旧细目删除、章节正文保留、大纲关联解除（去章节列表核对） | US-3     |
| D6   | 叶子节点 targetWords 置空 → 生成本章                                                       | ① 面板「目标 3000 字（默认）」；② 生成结果结构符合场景数提示；记录目标/实际/是否截断                                              | US-4/5、指标 5 |
| D6b  | 叶子节点 targetWords=20000 → 生成本章（可选，真实截断）                                     | 若真实发生 `finish_reason=length`：显示「生成被截断」且采用需二次确认；若模型自然收束/未截断则记录「未复现」，以自动化 R27 为准       | 指标 4   |
| D6c  | 叶子节点 targetWords=6000 → 生成本章                                                       | 面板「目标 6000 字（来自大纲）」；prompt 结构承诺 3–5 场（人工从结果判断）                                                        | US-4     |
| D7   | 旧调用零回归                                                                               | 无需人工：以 `m1-canary-stable.test.ts` + 基线审查为准，Demo 记录「自动化证据见报告 §…」                                          | 指标 6   |

> D6b 说明：真实截断依赖服务商行为，可能不出现；截断/中断/`finishReason=null` 的**强证据**来自 `m1-e2e-chapter-length.test.tsx`（stub SSE 确定性构造）。

### 5.3 人工抽检方法（指标 1/2/3）

**指标 3（细纲可写性，10 例，主判据）**

- 样本：Demo D3/D5 多轮细化累计 ≥10 个新子节点（不足时再细化 1–2 个节点补足）；每个样本保留：节点梗概、生成 prompt 摘要（注入条目清单）、输出原文（截图或复制到记录表）。
- 评分（每例只判 0/1）：四要素「谁想要什么 / 阻碍 / 转折 / 结尾局面或认知变化」是否齐全 且 至少 1 处选择由软肋/规则代价驱动并改变后文。
- 反事实检查：对每例自问「把软肋/规则换掉，这个场景是否还成立」；仍成立＝设定只是装饰，记 0。
- 达标：≥8/10。QA 独立评分，不让开发解释后再改分；记录原文以便复核。

**指标 2（关联质量，20 例）**

- 样本：Demo 中实际采用后的子节点（约 4–6 个）+ 用 `suggestOutlineLinks` 对 20 组固定子节点夹具跑出的建议（夹具含泛化别名、2 字名、同名、父继承等陷阱）。
- 判定：每条建议链接对＝1、错＝1；错配率＝错配数/建议总数；达标 <5%（宁漏勿错）。人工 20 例建议中错配 ≤1 条。
- 记录：child 标题+梗概摘要、建议条目与命中名、对/错、理由。

**指标 1（细化设定覆盖率，20 例）**

- 主证据：`m1-metrics-coverage.test.ts` 的 20 例确定性夹具（prompt 含完整字段 20/20）；Demo D3 的注入清单与输出作为 1 例真实样本复核。
- 若对真实模型做 20 次调用（可选、计费）：记录实际请求 prompt 是否含命中条目完整字段；本 M1 不作为必需项（指标文本判据为 prompt 包含字段，自动化已覆盖）。

### 5.4 记录模板（复制到 report 或单独记录文件）

```md
## M1 人工验收记录

- 日期/执行人：
- git HEAD：`52e124ea…`（或 QA2 实际 HEAD）；工作区：`git status --short` 摘要
- 浏览器/版本/视口：Chrome xx / 375×812 与 1280×800
- 模型：DeepSeek 预设 / 模型名 / 真实计费（估算费用）
- 数据：新建作品，novelId（导出确认）

### Demo 步骤

| 步骤 | 预期 | 实际 | 结论 | 证据（截图名/记录） |
| ---- | ---- | ---- | ---- | ------------------- |
| D1   |      |      | ✅/❌ |                     |
| …    |      |      |      |                     |

### 指标 2 抽检（20 例）

| # | 子节点（标题+梗概摘要） | 建议条目（命中名/来源） | 判定 | 理由 |
| - | ----------------------- | ----------------------- | ---- | ---- |

### 指标 3 抽检（10 例）

| # | 子节点输出摘要 | 目标/阻碍/转折/结尾 | 软肋或规则驱动的选择 | 反事实是否改变 | 判定 |
| - | -------------- | ------------------- | -------------------- | -------------- | ---- |

### 阻塞/观察项

| # | 级别 | 描述 | file:line / 截图 | 复现步骤 |
| - | ---- | ---- | ---------------- | -------- |

### 结论与遗留

- 通过项 / 失败项 / 有条件通过项：
- 未覆盖风险：
```

### 5.5 证据命名与归档

- 截图：`qa/m1/demo-<步骤>-<视口>-<序号>.png`（不入 git，放在工作区外或 `.tmp`，report 只引用文件名）。
- 命令输出：`qa/m1/<命令简称>.log`；report 粘贴关键行（含测试文件、用例名、通过数）。
- 所有 finding 必须能由「file:line + 单文件 vitest 命令」独立复现。

---

## 6. QA1 / QA2 执行清单

### 6.1 QA1（task-10：S6 + S1/S2，不放行 S3/S4/S5/S7 结论）

1. **前置快照**：`git rev-parse HEAD`、`git status --short`、`git diff --stat`；记录 dev-feature 是否正在改 `outlineExpand.ts`/基线（当前事实：S3 进行中）。
2. **读 diff**（[审查]）：S6（`NovelRepository.ts`/`DexieNovelRepository.ts`/`apply.ts`）与 S1/S2（`entryMention.ts`/`renderEntry.ts`/`planningContext.ts`）逐文件核对 design §2/§3/§7；重点：
   - S6：单事务边界（outlineNodes+chapters 同事务）、`replace+anchor=null` 整本顶层替换、anchor 存在/归属事务内校验、append order 事务内计算、空 nodes 抛错、删除/解链内部函数复用且不嵌套事务、异常上抛、返回前序扁平列表。
   - S2：`renderEntry`/`renderSummary` 逐字符搬移、原文件 re-export；`selectPlanningEntries` 规则与预算。
   - S1：评分/排序/归一化/上限与设计一致。
3. **生成 HEAD golden**（§2.3），写 `m1-s2-render-canary.test.ts`、`m1-canary-stable.test.ts`（QA1 阶段 expandSystem 也纳入相等断言，QA2 改为外科手术式）。
4. **写/跑独立测试**：`m1-s6-*.test.ts`、`m1-s1-*.test.ts`、`m1-s2-*.test.ts`、`m1-zero-migration.test.ts`、`m1-code-hygiene.test.ts`。
5. **范围测试**（不跑全量）：
   ```sh
   npx vitest run src/test/m1 src/data/dexie/DexieNovelRepository.test.ts src/proposal/apply.test.ts \
     src/domain/entryMention.test.ts src/context src/features/outline/outlineExpand.test.ts \
     src/features/outline/outlineTree.test.ts
   npm run typecheck
   ```
6. **越界/卫生扫描**（§6.3 命令）。
7. **报告 Lead**：结论（通过/阻塞）+ 发现清单（每条 file:line + 复现命令）+ 新增测试文件 + 未覆盖风险；若阻塞先 message dev-infra（S6）/dev-feature（S1/S2）并抄送 Lead。

### 6.2 QA2（task-11：最终验收）

1. **前置**：Lead 确认开发已停手；`git status --short` 快照；`git diff --name-only` 与 design §10 差集；记录 S3/S7 基线 diff 供 §3 审查。
2. **自动化矩阵**：写/跑 `m1-e2e-outline-refine.test.tsx`、`m1-e2e-chapter-length.test.tsx`、`m1-s3-prompt-contract.test.ts`、`m1-s4s5-suggest-links.test.ts`、`m1-s7-chapter-length.test.ts`、`m1-canary-intentional.test.ts`、`m1-metrics-*.test.ts`；重跑 QA1 全部独立测试。
3. **基线审查**（§3）：逐 hunk 分类、gap 分析、记录「有理由变更」表。
4. **反向测试**：R1–R40 逐条勾选（QA1 已覆盖的引用其证据）。
5. **人工 Demo**（§5）：D1–D7 + 指标 2/3 抽检；记录。
6. **全量门禁**（开发停手后）：
   ```sh
   npm run typecheck
   npm run test:run
   npm run build
   npx prettier --check "src/test/m1/**/*.{ts,tsx}"   # 只查 QA 新增文件
   ```
7. **写 report**：`.agents/tasks/outline-context-scene/verification-report.md`，结构见 §6.4。
8. **报告 Lead**：结论 + 报告路径 + 失败项 file:line + 复现步骤 + 是否建议进入 M2。

### 6.3 越界 / 卫生扫描命令（QA1、QA2 各一次）

```sh
# 改动文件清单（对照 design §10）
git diff --name-only
git status --porcelain | grep '^??'

# 禁止文件（应为空）
git diff --name-only -- src/data/dexie/db.ts src/features/export/backup.ts \
  src/domain/schema.ts src/domain/entrySearch.ts src/context/noNormsInputs.test.ts

# any / console / debugger：只看新增行
git diff -U0 -- src | grep -E '^\+' | grep -E '(:[[:space:]]*any\b|as any\b|<any>|console\.|debugger)' || true
# 新增未跟踪文件单独扫（git diff 看不到）
grep -RnE '(:[[:space:]]*any\b|as any\b|<any>|console\.|debugger)' \
  src/domain/entryMention.ts src/context/renderEntry.ts src/context/planningContext.ts \
  src/features/outline/suggestOutlineLinks.ts src/features/outline/OutlineLinkConfirmSheet.tsx \
  src/features/writing/chapterLength.ts 2>/dev/null || true

# i18n/文案拼写抽查（可选）：新增面向用户的中文文案里出现 TODO/FIXME
git diff -U0 -- src | grep -E '^\+.*(TODO|FIXME|XXX)' || true
```

### 6.4 verification-report.md 结构（QA2 产出）

1. **结论**：通过 / 阻塞（附一句话理由）；是否建议进入 M2（条件）。
2. **环境与证据**：HEAD、工作区快照、Node/浏览器、命令清单与结果表。
3. **需求→验收矩阵结果**：逐行 ✅/❌ + 证据位置（本文件 §1 的行号可引用）。
4. **6 条指标结果**：数值（如 20/20、错配 1/20、可写 9/10）与证据。
5. **反向测试结果**：R1–R40 表。
6. **基线审查**：有理由变更表（§3.5）+ 任何静默重生/意外回归。
7. **Demo 记录**：§5.4 模板填好的内容。
8. **失败/阻塞清单**：file:line、复现命令、期望 vs 实际、归因（dev-infra/dev-feature/设计问题）、状态（已通知/P0）。
9. **遗留风险与未覆盖项**：§7。
10. **变更范围核对**：`git diff --name-only` 与 design §10 对照表；禁止文件为空；零迁移证据。

---

## 7. 未覆盖风险与已知限制

1. **真实模型输出质量**：指标 1/3 的文学判断依赖真实调用；模型随机性、预设差异会让样本波动。缓解：固定预设、保留原文证据、按 rubric 独立评分；判据只对「至少 8/10」负责，不评价文采。
2. **真实服务商 `max_tokens` 兼容**：自动化只 stub `400 + max_tokens`，不能代表所有 provider；真实多 provider 需手工配置（Demo 只覆盖 DeepSeek 或可用端点）。
3. **真实截断复现不稳定**：`finish_reason=length` 的真实触发依赖模型与目标长度；自动化用 stub SSE 保证确定性，Demo D6b 为可选补充。
4. **TOCTOU 真实并发**：fake-indexeddb 单线程，无法真实制造「apply 前 anchor 被删」的竞态；以「事务内校验的代码审查 + apply 前删除的行为测试」双证据替代。
5. **移动端视觉**：jsdom 无布局，折叠/抽屉/一屏完成/44px 触控目标只能人工 Demo；本方案不承诺像素级验证。
6. **跨会话抑制记忆**：设计 D7 明确「跨会话不记忆」，M1 只验会话内；不视为缺陷。
7. **指标 2 的泛化别名策略**：设计只降权不丢弃，极端情况下（只命中「师父」）仍可能建议；按 D1「宁漏勿错」在人工抽检中观察，必要时提 P2 改进建议，不擅自改判据。
8. **非 M1 范围**：M2 章节归档、M3 自动大纲、M4 文风、目标差额提示/补场景按钮均不在本方案验证范围。

---

## 8. 变更记录

| 日期       | 变更                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| 2026-10-27 | 初版（task-9）：矩阵、独立测试计划、基线审查、反向测试、Demo 模板。                                    |
| 2026-10-27 | 采纳 Lead 裁决：`commitOutlineSubtree` 的 `replace + anchor=null` = 整本顶层替换（立项重新生成），R2 按允许语义验证，不写「必须抛错」断言；§1.3/§3.2/§4.1 同步。 |

---

## 9. 执行记录 · QA1（2026-10-27，task-10）

> 代码状态：HEAD `52e124e`；工作区含 S3、S4/S5、S7 进行中的改动（其他任务），S6/S1/S2 文件在验证窗口内未再变动（mtime 10:59–11:01，验证 11:08–11:09）。
> 范围：只验 S6 + S1/S2；不跑全量、不评审 S3/S4S5/S7。

### 9.1 结论：通过（无 P0/P1；3 条 P3 观察）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| S6 事务化（replace/append/回滚/解链/anchor/返回前序/Lead 裁决的 replace+null） | 通过 | `m1-s6-outline-subtree.contract.test.ts` 16 例、`m1-s6-apply-outline-tree.test.ts` 10 例 |
| S1 匹配评分 | 通过 | `m1-s1-entry-mention.contract.test.ts` 22 例 |
| S2 选择器/预算/确定性 | 通过 | `m1-s2-planning-context.contract.test.ts` 14 例 |
| S2 renderEntry 搬家 canary | 通过 | `m1-s2-render-canary.test.ts` 3 例（HEAD golden 逐字节 + re-export 同引用） |
| 正文侧零回归 | 通过 | `m1-canary-stable.test.ts` 6 例：builderMain/Side 逐字节同 HEAD；expandUser 旧路径不变；expandSystem 前缀不变 |
| 零迁移 | 通过 | `m1-zero-migration.test.ts` 4 例：verno=7、16 表、BACKUP_VERSION=4、8 个 schema key 集合不变 |
| 代码卫生 | 通过 | `m1-code-hygiene.test.ts` 21 例：新增/修改文件无 any/console/debugger |
| 越界 | 通过 | 禁止文件 diff 为空；S6/S1/S2 只改任务声明范围；基线 diff 仅含 S3/S7 内容 |

### 9.2 命令与计数

```sh
# 独立测试（96 passed + 1 skipped，capture 生成器默认 skip）
npx vitest run src/test/m1
# → 8 passed | 1 skipped (9 files)，96 passed | 1 skipped

# 范围回归（QA 独立 + 开发 S6/S1/S2 测试 + 正文侧相关）
npx vitest run src/test/m1 src/data/dexie/DexieNovelRepository.test.ts src/proposal/apply.test.ts \
  src/domain/entryMention.test.ts src/context/planningContext.test.ts \
  src/context/SummaryChainContextBuilder.test.ts src/features/writing/normCheck.test.ts \
  src/domain/entrySearch.test.ts
# → 15 passed | 1 skipped (16 files)，411 passed | 1 skipped

# 类型检查（当时工作区还含 S3/S4S5/S7 未完成改动，仍通过）
npm run typecheck   # 干净
# Prettier（QA 新增文件）
npx prettier --check "src/test/m1/**/*.{ts,tsx}"   # All matched files use Prettier code style
```

### 9.3 设计符合性审查（读 diff）

- S6：单事务（`outlineNodes`+`chapters`）；replace 删除子树 + 章节解链 + 重建；anchor 存在/归属事务内校验；append order 事务内计算；空 nodes 拒绝；删除/解链抽内部函数且事务内不调用公共 `deleteOutlineNode`；返回前序扁平节点；apply 预查 `listOutline` 已移除；`create|merge`→append、`replace`→replace；异常上抛、提案保持 pending。**Lead 裁决的 `replace+anchor=null`（整本顶层替换）已验证为允许路径**（旧根/子树删除、章节解链、新树无重复、失败回滚）。
- S1：评分公式、短名降权、泛化别名叠加惩罚、NFKC/零宽/大小写、全序排序、上限、excludeIds/minScore 均符合设计 §2；`mentionedEntries` 文件未改、`entrySearch.test.ts` 绿。
- S2：`renderEntry`/`renderSummary` 逐字节搬家（canary）、re-export 同引用；选择器 core/linked/mentioned 顺序、预算整条丢弃、dropped、tokens 口径、确定性符合设计 §3。

### 9.4 P3 观察（不阻塞）

1. `DexieNovelRepository.ts:499` append 起始 order = 现有兄弟数；删除中间兄弟/历史 order 有 gap 时可能与既有 order 撞号。`listOutline` 用 createdAt 兜底、树渲染确定，且与旧 `createOutlineNode`/旧 apply 同语义 → 非 M1 回归，记为已知限制。
2. `NovelRepository.ts:168` `updateOutlineLinks` 无 `novelId` 入参（按设计签名）；调用方（S5）必须只传当前作品节点，QA2 验证 S5 传参路径。
3. `DexieNovelRepository.ts:476` 空 nodes 检查在事务外，但发生在任何删除之前，原子性无影响（测试覆盖）。

### 9.5 未覆盖风险（QA1）

- TOCTOU 并发在 fake-indexeddb（单线程）无法真复现：以「apply 前删除 anchor」行为测试 + 事务内校验的代码审查替代；多标签页并发未测。
- 回滚语义只在 fake-indexeddb 验证；真实浏览器 IndexedDB 的 rollback 由 Demo D5 覆盖成功路径，失败回滚仍需真机抽验（可留到 QA2）。
- S3/S4S5/S7 的 prompt/基线/交互未在 QA1 结论内。

---

## 10. 执行记录 · QA2 最终验收（2026-10-27，task-11）

**最终报告见 [`verification-report.md`](./verification-report.md)**（含需求矩阵、6 条指标、基线逐 hunk 审查、R1–R40、零迁移、P 级问题、人工项待办与 M2 建议）。

摘要：

- 结论：**通过（有条件）**。自动化验收全绿；无 P0/P1；无静默重生；零迁移确认；建议进入 M2（条件＝合并前人工 Demo 与指标 2/3 抽检 + 补 S8 文档）。
- 全量门禁：`typecheck` ✅；`test:run` = 105 files passed + 1 skipped，2195 tests passed + 1 skipped ✅；`build` ✅（主 chunk 542 kB < 550 阈值）。
- QA 独立测试：`src/test/m1/` 199 passed + 1 skipped（17 个文件）。
- 基线审查：7 处有理由变更（S3 expand 任务段 ×2、S7 chapter 字数段 ×3、ChapterEditor 请求体断言加强、WritingPage.test 三处有意更新）；`chapterSystem` / `expandUser` / 正文侧 baseline 与 HEAD golden 逐字节一致。
- 已知偏差判定：关联面板嵌套在节点 Sheet 内（未实现回树+高亮）→ P2 可接受，建议 M2 打磨；会话抑制 childId+条目级双保险 → 验证通过；WritingPage.test 3 处断言 → 审查通过（补强）。
- 人工项：Demo D1–D6b、指标 2/3 人工抽检、375px/1280px 视觉**未执行**（环境无浏览器交互/真实 API Key），待人工；不影响自动化结论，但作为 M2 准入条件。
