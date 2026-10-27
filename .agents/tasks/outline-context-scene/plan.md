# 实施计划 · M1 大纲细化的上下文、场景卡与字数结构件

> 设计：[design.md](./design.md) · 需求：[requirements.md](./requirements.md) · 决策：[decisions.md](./decisions.md)
> 原则：每个步骤先写测试再改实现（与项目既有 Task 纪律一致）；每步结束跑 `npm run typecheck` + 相关测试；S3/S7 涉及基线，单独列为复核点。

---

## 0. 验收 Demo（M1 完成时演示）

1. 建两条人物条目：沈砚（说话方式：短句、爱用反问；软肋：妹妹）、裴照（关系网：与沈砚有旧怨）。
2. 新建卷节点，梗概写「沈砚在渡口与裴照相遇，被迫接下去北方的差事」，不手工关联任何条目。
3. 点「细化这一节点」→ 面板显示「核心设定 / 相关设定」清单（含沈砚、裴照全字段与 token 估算）；生成结果子节点梗概是场景卡，且出现由软肋或规则代价驱动的选择。
4. 采用 → 出现「确认自动关联」面板；取消一条、确认其余 → 子节点 `linkedEntryIds` 写入；再打开节点抽屉看到关联。
5. 对已有子节点的节点再次细化 → 先弹「将替换 K 个子节点、M 章解除关联」确认；采用失败不会留半棵树（测试覆盖）。
6. 叶子节点 targetWords=6000 → 生成面板显示「目标 6000 字（来自大纲）」；prompt 含 3–5 场要求；模拟截断 → 界面显示「生成被截断」并需二次确认才能采用。
7. 旧的「无条目」调用：`buildExpandUserPrompt` 输出与改动前逐字节相同（测试）。

---

## 1. 步骤

### S1 · 名称匹配与评分（纯函数）

- [x] 新建 `src/domain/entryMention.ts`：`normalizeMentionText`、`rankEntryMentions`、评分与排序。
- [x] 新建 `src/domain/entryMention.test.ts`：全名/别名/全半角/大小写/零宽字符/短名降权/泛化别名/去重/上限/稳定排序。
- [x] 确认 `mentionedEntries` 未改；跑 `entrySearch` 相关测试与 `import`/`normCheck` 测试。

**验证**：新增测试全绿；现有测试零失败。

### S2 · 渲染复用与规划条目选择（纯函数）

- [x] 新建 `src/context/renderEntry.ts`，把 `renderEntry`/`renderSummary` 原样搬出；`SummaryChainContextBuilder.ts` 改为 re-export。
- [x] 跑 `SummaryChainContextBuilder.test.ts`、`normCheck.test.ts`、`noScenarioBaseline.test.ts`，确认正文侧逐字节不变。
- [x] 新建 `src/context/planningContext.ts`：`selectPlanningEntries`、预算/上限常量。
- [x] 新建 `src/context/planningContext.test.ts`：核心必注入、显式优先、提到的按分排序、预算先丢提到的、超预算清单、确定性（两次调用深相等）。

**验证**：正文侧基线零变化；选择器测试全绿。

### S3 · 细化提示词与 system/user 块

- [x] 修改 `outlineExpand.ts`：`buildExpandSystemPrompt` 增加可选 `core`；`EXPAND_TASK` 增补场景卡/核心设定/目标字数四条；`buildExpandUserPrompt` 增加可选 `related/openThreads/rollingSummary/depth/relatedDropped`，按设计顺序拼块。
- [x] 更新 `outlineExpand.test.ts`：块顺序、空输入向后兼容、场景卡文案、核心设定只在 system。
- [x] 更新基线：`noScenarioBaseline.test.ts` 的 `expandSystem`/`expandUser` 字面量（记录原因：场景卡任务 + 完整字段渲染）；`noNormsBaseline.test.ts` 对应段。
- [x] 跑全量测试，确认失败仅限有意更新的基线。

**验证**：有 core/related 时 prompt 含完整字段；不传新参数时 user prompt 与旧实现一致（用测试固定）；基线 diff 逐条可解释。

### S4 · OutlineNodeSheet：落盘、注入清单、伏笔接线

- [x] 拆 `persistDraft()`；`runExpand()` 先落盘，失败中止；用落盘后的值构建 prompt（修复草稿/已保存混用）。
- [x] `OutlineNodeSheet` 新增可选 props：`chapters`、`openThreads`、`rollingSummary`；`WritingPage` 计算并传入（最新主线摘要的伏笔 + `novel.rollingSummary`）。
- [x] 面板增加注入清单：核心 N 条、相关 X+Y 条与 token、可临时移除的提到的条目、未注入提示。
- [x] 组件测试：未保存梗概 → 细化时保存并被使用；清单显示；移除后 prompt 不含该条；旧 props 不传时不渲染清单。
- [x] 注意：`OutlineNodeSheet.test.tsx` 若不存在则新建；用 `createTestHarness`。

**验证**：交互测试覆盖 US-1 的前半段；无回归。

### S5 · replace 告知 + 采用后关联确认

- [x] `OutlineNodeSheet` 计算子树与受影响章节（区分「已挂」与「已有正文」）；`children.length > 0` 时细化前弹 `ConfirmDialog`（含替换数/解链数/旧细目会删除），确认才发请求。
- [x] 新建 `suggestOutlineLinks.ts` + 测试：继承父显式关联、提到条目、排除 pinned、上限、抑制集、全空返回空。
- [x] 新建 `OutlineLinkConfirmSheet.tsx`：按子节点分组、默认全选、继承标记、命中名可见、可取消；底部「全部保留 / 全部跳过 / 确认关联」；非阻塞呈现（先回大纲树并高亮新节点）。
- [x] 发起细化前快照子节点 id；`onSettled` 后先查本批 `accepted` 提案，再拉 `parentId` 下的**新**子节点（快照差集）计算建议；会话内抑制集。
- [x] `NovelRepository` 增加 `updateOutlineLinks(updates[])` 单事务；面板确认时一次写入，避免逐条写一半。
- [x] 测试：采用后出现建议；取消一条后不写入；跳过一条不写；再次细化不重复建议被取消项；父链接不丢失；旧节点不重复建议。

**验证**：US-2/US-3 通过；`WritingPage.test.tsx` 与 `ProposalInbox` 相关测试通过；写库只有一次批量调用。

### S6 · 大纲子树事务化

- [x] `NovelRepository` 增加 `commitOutlineSubtree`、`OutlineTreeInputNode`、`updateOutlineLinks`。
- [x] `DexieNovelRepository` 实现：事务内 replace 删除子树 + 解锁章节 + 递归创建；append 接排；事务内校验 anchor 存在/归属/空 nodes；抽取共享删除/解链内部函数（不嵌套事务、不全表扫描），`deleteOutlineNode` 复用。
- [x] `apply.ts` 的 outlineTree 三态改走新方法，删除非事务 `createOutlineTree`；父节点存在性校验移入事务。
- [x] 测试：`DexieNovelRepository.test.ts` 覆盖替换/追加/章节解链/顺序/前序返回值/anchor 非法/空 nodes/失败回滚；`apply.test.ts` 原有断言保持。
- [x] 全量跑 apply / repository / scenario 测试。

**验证**：US-3 通过；无半棵树路径；现有提案行为不变。

### S7 · T1 结构件与截断防线

- [x] 新建 `chapterLength.ts` + 测试：默认 3000、非法值回退、场景参考区间（>7000 为 3–6 场）、token 上限 `1.8×+800` 夹取 [4096, 8192]。
- [x] `types.ts`/`useLlm.ts` 透传 `maxTokens`；client 测试确认 body 含 `max_tokens`。
- [x] `chapterDraft.ts` 改为解析目标 + 新结构文案（参考场景数、节拍优先、自然收束、钩子结尾、文体冲突以目标为准）。
- [x] `GenerateChapterSheet.tsx`：目标来源显示；传 maxTokens；`done` 增加 `incomplete`（截断/中断；`finishReason=null` 视为未知）；两种不完整都二次确认；400 invalid `max_tokens` 自动无参重试一次。
- [x] 更新基线：三处「约 3000 字 ±15%」字面量、`ChapterEditor.test.tsx` 请求体断言；补 `GenerateChapterSheet.test.tsx`（截断、中断、目标显示、maxTokens、400 重试）。
- [x] 跑 `ChapterEditor`、`WritingPage`、`SummaryChain` 全量测试。

**验证**：US-4/US-5 通过；截断/中断场景测试 100% 显示未完成；正常生成行为不变。

### S8 · 收尾

- [x] 全量 `npm run typecheck`、`npm run test:run`、`npm run build`。
- [x] 人工走一遍验收 Demo；记录截图/结果。
- [x] 在 `docs/开发计划.md` 增加 M1 实施记录（完成后再写，含基线变更原因、测试数、遗留）。
- [x] 更新 `docs/使用说明.md` 中「细化大纲」与「整章生成」两节（注入清单、关联确认、目标来源、截断提示）。
- [x] 输出遗留/下一里程碑清单（M2）。

---

## 2. 依赖与顺序

建议串行顺序（采纳架构评审：S3 与 S7 都改同一批基线，不能并行）：

```
S6 → S2 → S1 → S3 → S4 → S5 → S7 → S8
```

- **S6 先做**：不碰 prompt，先消除「半棵树 / 删一半旧节点」风险，也最容易被独立验证。
- **S2 做 canary**：纯搬家，必须做到 `SummaryChainContextBuilder` 与正文侧基线全绿；若 S2 后出现任何正文 prompt diff，先停下排查。
- **S1** 在 S2 之后：选择器依赖匹配，但两者都无 UI 接线，失败面小。
- **S3 单独 commit**：只改 expand 两处基线字面量，commit message 写明「任务文案 + 完整字段渲染」；不与 S7 混。
- **S4/S5** 同一交互链，一起验。
- **S7 最后**：只改 chapter 文案与请求体断言，与 S3 的基线文件分开 commit。

护栏：

- 新增「空可选输入下，10 类任务的 prompt 逐字节不变」回归用例（扩展现有 baseline 测试的对照面）。
- S3 增加「同一本书、不同节点，system prompt `toBe` 相同」的缓存前提测试。
- S5 增加「采用被拒绝时不开关联面板」「旧节点不重复建议」两组用例。
- 每个基线变更都能在 commit 里单独 revert。

## 3. 工作量粗估

| 步骤          | 估时                       |
| ------------- | -------------------------- |
| S1 + S2       | 1–1.5 天                   |
| S3 + S4       | 1.5–2 天                   |
| S5            | 1.5–2 天（含批量写库）     |
| S6            | 1–1.5 天                   |
| S7            | 1–1.5 天                   |
| S8 收尾与文档 | 0.5 天                     |
| **合计**      | **7–9 天**（单人，含测试） |

## 4. 复核点（需要 Lead 单独 review）

1. S2 的 diff 只应有「文件搬家 + re-export」，不得有字符变化；正文侧基线全绿。
2. S3/S7 的基线 diff：逐条确认「有意变更 / 意外回归」，且两次变更分开 commit。
3. S5 的写库路径：确认只有作者点「确认关联」才写 `linkedEntryIds`；批量写单事务；拒绝/跳过不写。
4. S6 的事务边界：replace 删除 + 解链 + 创建同事务；anchor 归属/存在性事务内校验；异常不被吞。
5. S7 的 `max_tokens`：对 3000/6000/10000 三档验证；`finishReason=null` 不误判；400 回退不重复流式内容。

## 5. 评审意见采纳记录

来自架构产品（product-data）与文学顾问（literary-advisor）的 M1 定向评审，已落入设计/计划：

| 意见                                                                                                              | 落点                       |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------- |
| replace+anchor=null 支持为整本顶层替换（立项重新生成）；anchor 归属/存在性/append order 事务内校验；空 nodes 拒绝 | design 7.1/7.2             |
| 返回前序扁平节点；抽纯函数复用删除/解链；不在事务里调公共 delete                                                  | design 7.1/7.2             |
| 逐条写 links 非原子 → 新增 `updateOutlineLinks` 单事务                                                            | design 7.1/6.2、plan S5/S6 |
| 关联面板只对本批新节点建议（细化前快照差集）                                                                      | design 6.2、plan S5        |
| maxTokens 1.2× 偏紧 → 1.8×+800；上夹 8192；400 无参重试；finishReason=null 视为未知；aborted 也二次确认           | design 8.1/8.2、plan S7    |
| 基线回归排序：S6→S2→S1→S3→S4/S5→S7，S3/S7 不同并行                                                                | plan §2                    |
| 加「空可选输入下 10 类任务 prompt 逐字节不变」「同书不同节点 system 相同」护栏                                    | plan §2 护栏               |
| EXPAND_TASK：规则不点名、只写代价；选择必须改变后文；不凑数拉长；加章末钩子与信息差                               | design 4.1                 |
| 章节字数：场景数改「参考」、按节拍不按字数、>7000 可 3–6 场、自然收束、钩子结尾                                   | design 8.1/8.4             |
| replace 文案区分「已挂章节/已有正文章节」；关联面板非阻塞、先回大纲树高亮新节点                                   | design 5.2/6.2             |

## 6. 回滚策略

- S1/S2 为纯新增模块，未接线即无行为变化。
- S3/S4/S5 同一交互链：若上线后问题集中在关联面板，可先隐藏面板（保留注入清单），其余不受影响。
- S6 可回退 `apply.ts` 到旧递归实现（但建议保留事务方法）。
- S7 可回退 `maxTokens` 与 `incomplete` 状态；prompt 变更与基线需成对回退。

---

## 7. 实施结果（2026-10-27）

- **S1–S8 全部完成**；开发与测试分离：dev-infra（S6/S7）、dev-feature（S1–S5）、qa-verifier（QA0/QA1/QA2 独立验证）。
- **门禁**：`npm run typecheck` 通过；`npm run test:run` = 105 文件 / 2195 通过 + 1 skip；`npm run build` 通过（主 chunk 542 kB < 550 阈值）。
- **QA 独立套件**：`src/test/m1/**` 17 文件 / 199 通过 + 1 skip（HEAD `52e124e` 冻结 golden、事务/回滚、匹配评分、选择器预算、基线逐 hunk、零迁移、反向 R1–R40）。
- **基线**：7 处有意变更全部通过逐 hunk 审查；`chapterSystem` / `expandUser` / 正文侧 baseline 与 HEAD golden 逐字节一致。
- **零迁移**：Dexie 仍 v7、备份仍 v4，未新增实体字段。
- **已知偏差**：关联面板嵌套在节点抽屉内（P2，可 M2 打磨）；`maxTokens` 上夹 8192；会话抑制跨会话不记忆。
- **待人工**（本环境无浏览器 / 真实 Key）：真实模型 Demo D1–D7、场景卡文学质量与关联可写性抽检、375px / 1280px 视觉检查。
- **下一步**：M2 章节归档（摘要 + 条目提案、批量确认、幂等）；M3 自动大纲；M4 文风。
