# 设计 · 大纲细化的上下文、场景卡与字数结构件（M1）

> 对应需求：[requirements.md](./requirements.md)
> 对应决策：[decisions.md](./decisions.md)
> 目标：在不改数据模型、不升 Dexie/备份版本的前提下，让细化大纲真正读取知识库，并把「写得出、写得完」的结构承诺前置。

---

## 1. 总览

M1 由四块组成，按依赖排序：

```
S1  entryMention（匹配与评分，纯函数）
S2  planningContext（条目选择 + 渲染复用，纯函数）
S3  outlineExpand 提示词与 schema 接线
S4  OutlineNodeSheet：落盘修复、注入清单、未收束伏笔
S5  suggestOutlineLinks + 关联确认面板（采用后）
S6  大纲子树事务化（仓储方法 + apply 改造）+ replace 影响告知
S7  T1 结构件与截断防线（chapterLength + maxTokens + finishReason）
```

S1/S2/S7 的纯函数与 UI 解耦，可先落地并测试；S3/S4/S5 是同一交互链；S6 独立。任何一块可单独回滚。

**模块边界**：规划侧不直接复用 `SummaryChainContextBuilder`（它绑定 `ContextRequest` 与写作装箱顺序），而是复用它的两个更小的事实源——`renderEntry` 与名称匹配规则。`mentionedEntries` 保持旧语义不动（导入、规范检查、推演仍用它），新增 `rankEntryMentions` 只服务「需要评分与理由」的新调用点。

---

## 2. S1 名称匹配与评分

### 2.1 新文件 `src/domain/entryMention.ts`

```ts
export type MentionKind = 'title' | 'alias';

export interface EntryMention {
  entry: KnowledgeEntry;
  /** 实际命中的名称（原始写法） */
  matchedName: string;
  kind: MentionKind;
  /** 排序分，越大越可信。只用于排序/截断，不落库 */
  score: number;
}

export interface RankMentionOptions {
  /** 默认 8；显式关联不受此限 */
  limit?: number;
  excludeIds?: ReadonlySet<string>;
  /** 默认 1；<=0 的命中直接丢弃 */
  minScore?: number;
}

export function normalizeMentionText(input: string): string;
export function rankEntryMentions(
  texts: readonly string[],
  entries: readonly KnowledgeEntry[],
  options?: RankMentionOptions,
): EntryMention[];
```

### 2.2 归一化

只做不改变语义的归一：

- `String.prototype.normalize('NFKC')`：全角字母/数字、全角括号等转半角（「Ａｓｈ」→「Ash」）。
- `toLowerCase()`：英文大小写。
- 去掉零宽字符（`\u200b-\u200d`、`\ufeff`）。
- 不删内部空格、不删标点、不做简繁转换（引入转换表体积大且会误伤）。

匹配仍是「归一化后的文本包含归一化后的名称」，与 `mentionedEntries` 同构，但多了评分。

### 2.3 评分规则（确定性）

| 情况         | 分数                                   |
| ------------ | -------------------------------------- |
| title 命中   | `100 + min(名称长度, 10) * 2`          |
| alias 命中   | `80 + min(名称长度, 10) * 2`           |
| 名称长度 = 1 | 直接丢弃（`score = 0`）                |
| 名称长度 = 2 | 在基分上 `-20`（降权，不丢弃）         |
| 泛化别名命中 | 在基分上 `-50`（仍可能进，但排在后面） |

泛化别名黑名单（可作为 aliases 但不应主导关联）：
`他、她、它、我、你、您、师父、老师、大人、公子、小姐、先生、夫人、老板、队长、将军、陛下、殿下、师兄、师姐、师弟、师妹`。

同一条目多次命中取最高分；按 `score desc → 命中名长度 desc → entry.id asc` 全序排序，保证同一输入结果逐字节可复现（测试与缓存都需要）。

### 2.4 与旧函数的关系

- `mentionedEntries`（`entrySearch.ts`）**不改**：导入提取、`normCheck`、worldline 继续用旧语义，避免牵连既有行为与测试。
- 新函数在 `entryMention.test.ts` 中补齐用例：全名/别名/全半角/大小写/零宽字符/短名降权/泛化别名/同一条目去重/排序稳定/上限截断。
- 已知局限：中文简称（「小舟」↔「林小舟」）仍无法匹配，依赖作者补 aliases；UI 在条目编辑里已有别名入口，不在 M1 扩自动推断。

---

## 3. S2 规划条目选择与渲染

### 3.1 渲染复用：新文件 `src/context/renderEntry.ts`

把 `renderEntry` / `renderSummary` 从 `SummaryChainContextBuilder.ts` **原样搬出**（不改一个字符），并在原文件 `export { renderEntry, renderSummary } from './renderEntry';` 保持所有既有导入（`normCheck.ts`、测试）不变。

> 为什么搬：`normCheck`、`scenarioPrompt` 都在复制「条目 → prompt 片段」的格式；规划侧再复制第四份必然漂移。搬出后规划侧直接复用，正文侧行为不变。

### 3.2 选择器：新文件 `src/context/planningContext.ts`

```ts
export interface PlanningEntryBlock {
  entry: KnowledgeEntry;
  reason: 'core' | 'linked' | 'mentioned';
  /** mentioned 时的命中名与分数 */
  matchedName?: string;
  score?: number;
  tokens: number;
  text: string;
}

export interface PlanningSelection {
  core: PlanningEntryBlock[]; // pinned，始终注入
  related: PlanningEntryBlock[]; // linked + mentioned，可被预算裁剪
  dropped: PlanningEntryBlock[]; // 因预算未注入
  tokens: number;
}

export interface SelectPlanningEntriesInput {
  /** 参与名称匹配的文本：节点标题、梗概、额外要求、最近祖先梗概 */
  texts: readonly string[];
  entries: readonly KnowledgeEntry[]; // 调用方已按「通用、未删除」过滤
  categories: readonly Category[];
  linkedEntryIds: readonly string[];
  budget?: number; // 默认 8000
  maxMentioned?: number; // 默认 8
}

export function selectPlanningEntries(input: SelectPlanningEntriesInput): PlanningSelection;
```

规则：

1. `core` = `entries.filter(e => e.pinned)`，无论预算如何都注入，顺序按 `entries` 原顺序（与正文侧一致）。
2. `linked` = 按 `linkedEntryIds` 顺序取；已删除/不存在的 id 丢弃；`pinned` 不重复。
3. `mentioned` = `rankEntryMentions(texts, entries 去掉 pinned/linked)`，最多 `maxMentioned` 条。
4. 预算：`core` 先计入；`linked` 次之，超出预算时整条丢弃并记入 `dropped`；`mentioned` 最后，按分数从低到高丢。`tokens` 用 `estimateTokens(renderEntry(...))`，与正文侧同口径。
5. 结果不依赖对象键遍历顺序、不引入时间/随机量。

常量：`PLANNING_CONTEXT_BUDGET = 8_000`、`MAX_PLANNING_MENTIONED = 8`。数值依据：细化 prompt 现状约 1.1k tokens；核心设定通常 1–3 条、单条几百 token；8k 足以容纳核心 + 8 条相关 + 位置/兄弟/规范，同时避免把「几十条设定」倒进规划任务稀释注意力。

### 3.3 渲染

- `core` / `related` 都渲染为 `renderEntry(entry, categories)` 的完整块（含分类名、别名、摘要、全部字段），不再降级为「标题：摘要」。
- 块标题由 prompt 组装器统一加：【必须遵守的核心设定】/【相关设定】；选择器只返回条目块，不拼标题（便于 UI 复用同一份 tokens 估算）。

---

## 4. S3 细化提示词与 schema

### 4.1 system prompt

```ts
buildExpandSystemPrompt(
  novel, style, norms?,
  core?: readonly PlanningEntryBlock[],  // 可选；空/不传时与旧调用一致
): string
```

组装顺序：

```
角色（资深小说策划编辑…）
composeStylePrefix(novel, style)
writingNormsSection(norms, 'planning')
【必须遵守的核心设定】+ core 块          ← 仅在 core 非空时出现
EXPAND_TASK
```

- 核心设定放 system：同一本书内稳定，多个节点细化可共享前缀；逐节点变化的「相关设定」放 user，不破坏前缀。
- `EXPAND_TASK` 在原有条目上增补（不删旧约束）：

```
- 每个子节点的梗概按「场景卡」写：谁想要什么、什么在阻碍、转折点在哪里、
  结尾留下什么局面或认知变化；不要只写「发生了某事」。
- 至少有一处，要让人物在软肋或世界规则的代价上做出一次选择或拒绝，
  且这次选择必须改变后文走向；「他想起妹妹」这种内心一笔不算。
  把设定复述进梗概不算「应用设定」。
- 梗概里可以点名涉及的人物、地点、道具（用知识库中的名字或别名）；
  世界规则不要点名复述，只写它逼出的代价。不要为凑关联硬塞无关人物。
- 不得违背【必须遵守的核心设定】；与梗概冲突时以设定为准，并把约束的代价写进情节。
- 章末要能看出钩子与信息差：谁知道什么、读者被瞒了什么。
- 子节点 targetWords 之和应接近父节点的目标字数，但不凑数拉长；
  情节量不足时宁短。父节点没有目标时按每章约 3000 字估。
```

> 这会改动 `noScenarioBaseline` 里 `expandSystem` 的字面量基线；属于**有意变更**，在 S3 中逐条更新并在实施记录写明原因。

### 4.2 user prompt

```ts
buildExpandUserPrompt(params: {
  node; ancestors; siblings; existingChildren;
  /** 旧参数：related 不传时按旧「标题：摘要」渲染，保证既有调用逐字节不变 */
  linkedEntries: KnowledgeEntry[];
  count; extra?;
  related?: readonly PlanningEntryBlock[];   // 新增：linked + mentioned（完整字段）
  openThreads?: readonly string[];            // 新增：当前未收束伏笔
  rollingSummary?: string;                    // 新增：仅顶层节点注入
  depth?: number;                             // 新增：决定是否带故事至此
  relatedDropped?: readonly PlanningEntryBlock[]; // 新增：预算未注入，供 UI/提示
}): string
```

渲染优先级：传了 `related` 就用它（完整字段块）；没传则回退到旧 `linkedEntries` 的「标题：摘要」块。生产调用只传 `related`，旧测试/旧调用保持原输出。

块顺序（只追加非空块，旧调用输出不变）：

```
【当前位置】 …（标题、祖先、目标字数）
同层的其他节点 …
该节点已有的子节点 …
【相关设定】            ← related 完整字段；空则不渲染
【当前未收束的伏笔】    ← openThreads；空则不渲染
【故事至此】            ← 仅 depth===0 且有 rollingSummary
【本次要求】拆成 N 个子节点。
【用户额外要求】…
```

【相关设定】文案强调「子节点要体现这些设定的约束与关系；不得违背核心设定」，不要求模型复述。

### 4.3 schema

保持不变：`children[{ title, synopsis, targetWords }]`。

- 不加 `sceneCount`/`entryIds` 字段：按 D7 零迁移，场景数由梗概承载、关联在采用后由本地匹配生成。
- `targetWords` 为 `null` 允许；生成侧按 D4 回退 3000（M1 起显式显示）。

### 4.4 接线（S4）

`OutlineNodeSheet` 新增可选 props（由 `WritingPage` 传入）：

```ts
chapters?: readonly Chapter[];      // replace 影响章节数
openThreads?: readonly string[];    // 主线最近一份摘要的累计伏笔
rollingSummary?: string;             // novel.rollingSummary
```

`WritingPage` 计算最新主线摘要：`summaries` 中对应主线 `chapters` 最大 index 的一份；无摘要则空。

`OutlineNodeSheet` 内部：

1. `texts = [title, synopsis, expandExtra, ...最近 2 个祖先的 synopsis]`。
2. `selection = selectPlanningEntries({...})`，在面板展示注入清单：
   - 「核心设定 N 条（始终注入）」
   - 「相关设定：显式 X 条 + 提到 Y 条，共约 Z tokens」
   - 每条带标题与来源（关联/提到）；`mentioned` 可临时移除（本次生成生效，不写库）。
   - 预算未注入的条目列出标题与「未注入」原因。
3. `buildExpandSystemPrompt(..., selection.core)`；
   `buildExpandUserPrompt({..., related: selection.related, openThreads, rollingSummary, depth})`。
4. 面板显示「本次将带上 N 份写作规范」保持现状。

---

## 5. S4 细化前落盘与 replace 告知（T0）

### 5.1 细化前先保存

把现有 `save()` 拆成：

```ts
async function persistDraft(): Promise<OutlineNode | undefined>; // 校验标题、写库、返回保存值；失败设 error 并返回 undefined
async function save() {
  const saved = await persistDraft();
  if (saved) {
    invalidate();
    onClose();
  }
}
```

`runExpand()` 第一步 `const saved = await persistDraft(); if (!saved) return;`，随后用 `{...saved}`（刚写入的值）构建 prompt，不再依赖父组件刷新时机。这样：

- 改了梗概/关联/目标字数未保存就细化 → 用的是最新值；
- 「额外要求」仍是本地临时输入（按 D2 不落库），只参与本次匹配/注入;
- 保存失败（标题为空、仓储错误）时不发请求。

### 5.2 replace 影响告知

`OutlineNodeSheet` 传入 `chapters` 后：

```ts
const subtreeIds = collectDescendantIds(nodes, node.id); // 含自身
const affected = chapters.filter((c) => c.outlineNodeId && subtreeIds.has(c.outlineNodeId));
const withContent = affected.filter((c) => c.content.trim()).length;
```

当 `children.length > 0` 时，点「细化这一节点」先弹 `ConfirmDialog`：

```
将替换「{node.title}」下现有的 {K} 个子节点（含孙节点）。
其中 {M} 个已挂章节（{withContent} 个已有正文）会解除大纲关联；
正文保留，不会删除，之后可以重新关联。
旧细目会从大纲树删除；采用前可以在提案里对照原细目。
```

确认后才发请求。取消 → 不发请求、不扣费。

> 说明：影响在「发起细化」时告知；到「采用提案」时旧子节点才会真正删除（`outlineTree:replace`）。若作者在两步之间改了章节，采用时以实际为准——提示文案写「约」，并在采用面板保留原有 diff 预览。

---

## 6. S5 采用后关联确认

### 6.1 纯函数 `src/features/outline/suggestOutlineLinks.ts`

```ts
export interface SuggestedLink {
  entry: KnowledgeEntry;
  reason: 'inherited' | 'mentioned';
  matchedName?: string;
}

export interface ChildLinkSuggestion {
  child: OutlineNode;
  suggestions: SuggestedLink[];
}

export function suggestOutlineLinks(input: {
  parent: OutlineNode;
  children: readonly OutlineNode[];
  entries: readonly KnowledgeEntry[]; // 已过滤通用、未删除
  limitPerChild?: number; // 默认 8
  suppressed?: ReadonlySet<string>; // "childId:entryId" 会话内移除记忆
}): ChildLinkSuggestion[];
```

规则：

- 继承：父节点 `linkedEntryIds` 中仍存在的条目，`reason='inherited'`，排最前。
- 提到：对每个子节点的 `title + synopsis` 跑 `rankEntryMentions`，排除 `pinned`、已被继承的、已被 `suppressed` 的，`limitPerChild` 截断。
- 无建议的子节点不出现在结果里；全空则整个面板不出现。
- 命中名展示用 `matchedName`，作者可判断「关联的是名字还是别名」。

### 6.2 面板 `src/features/outline/OutlineLinkConfirmSheet.tsx`

- 采用成功（`ProposalInbox.onSettled`）后触发。注意 `onSettled` 在「全部拒绝」时也会被调用，所以先查 `repository.listProposals(novel.id, { status: 'accepted', batchId: expand.batchId })`：本批没有任何 accepted 提案（被拒绝/失败）则不开面板；有 accepted 才重新 `repository.listOutline(novel.id)`。
- **只对本批新节点建议**：发起细化前先快照当前子节点 id 集合；采用后取 `parentId === node.id` 且不在快照里的节点。否则 append/M3 场景会把旧节点也算进去、反复建议。
- 面板结构：标题「确认自动关联」；说明「只写入你勾选的条目；不勾=不关联；父节点原有手工关联只对新子节点继承，不改父节点」。
- 每个子节点一组 chips：默认全选；`inherited` 标「继承」；提到项显示命中名（如别名「小舟」），点击取消。底部「全部保留」「全部跳过」「确认关联（N 条）」。
- **不阻塞心流**：采用后先回到大纲树并高亮新节点；关联面板用底部抽屉/提示条出现，而不是立刻全屏弹窗（移动端）或右侧抽屉（桌面）。
- 确认写库：把所有变更合并成一次 `repository.updateOutlineLinks(updates)` 单事务调用（新增仓储方法，见 7.1），每项 `linkedEntryIds = union(现有 links, 选中条目 id)`。避免逐条写一半时刷新留下半套 links；若仓储方法暂不实现，则必须明确接受「部分写」并在设计评审记录。
- 取消/跳过的条目写入组件内的 `suppressedRef`（`Set<"childId:entryId">`）；同一面板存续期间再次细化不会重复建议。跨会话不记忆（零迁移的代价，写在限制里；links 仍可手改，不会写错）。
- 不静默：面板出现前不写任何 links；面板关闭（X/跳过）也不写。
- `replace` 细化：新子节点 links 为空，继承来自父节点；旧子节点的手工 links 随节点删除，文案已提示。

### 6.3 与未来 T5 的关系

`suggestOutlineLinks` 同样可服务 M3 自动大纲的「新节点 → 关联」；接口做成纯函数，输入节点数组与条目，不绑定本次细化流程。

---

## 7. S6 大纲子树事务化（T0）

### 7.1 仓储接口新增（`src/data/NovelRepository.ts`）

```ts
export interface OutlineTreeInputNode {
  title: string;
  synopsis: string;
  targetWords: number | null;
  /** 可选：M1 的关联确认走 updateOutlineLinks，不经过这里；预留给 M3 */
  linkedEntryIds?: string[];
  children: OutlineTreeInputNode[];
}

/**
 * 在单个事务里「替换/追加」某节点下的一层子树。
 * - replace：删除挂载点下现有子节点（及其子树），并解除受影响章节的大纲关联；
 *   anchorId 为 null 表示「整本顶层替换」（立项「重新生成立项内容」的既有语义），
 *   事务内删除全部根节点后按顶层重建 —— 这条路径同样需要原子性，不能拒绝；
 * - append：接在现有兄弟之后；anchorId 为 null 表示整本顶层追加（立项）。
 * - nodes 为空时抛错（避免「采用后什么都没发生」）。
 * 事务内校验 anchor 存在且属于 novelId、计算 append 起始 order（消 TOCTOU）。
 * 返回按前序展开的已创建节点（含子节点 id），便于调用方与 M3 使用；
 * 当前 apply 丢弃返回值、S5 用「细化前快照 + 重新查询」定位新节点。
 */
commitOutlineSubtree(
  novelId: string,
  anchorId: string | null,
  nodes: readonly OutlineTreeInputNode[],
  mode: 'append' | 'replace',
): Promise<OutlineNode[]>;

/**
 * 批量写多个节点的 linkedEntryIds（关联确认面板用）。
 * 单事务，避免「写一半刷新」留下半套关联；id 不存在时整批失败并回滚。
 */
updateOutlineLinks(
  updates: readonly { id: string; linkedEntryIds: readonly string[] }[],
): Promise<void>;
```

> `updateOutlineLinks` 只写关联字段，不触碰标题/梗概/状态；与 `updateOutlineNode` 的分工是「批量原子 vs 单节点通用」。仍是零迁移。

### 7.2 Dexie 实现要点

- `db.transaction('rw', [outlineNodes, chapters], async () => { ... })`。
- 复用现有 `deleteOutlineNode` 的「收集后代 + 解除章节关联」逻辑：抽**不另开事务、不做全表扫描**的内部函数 `collectDescendantIds(rows, rootId)` 与 `deleteRowsAndUnlinkChapters(doomed)`；`deleteOutlineNode` 与 `commitOutlineSubtree` 共用，避免两套删除规则漂移。禁止在事务里调用公共 `deleteOutlineNode`（会嵌套开事务）。
- `replace` + `anchorId=null`：整本顶层替换（现有立项重新生成路径），事务内删除全部根节点（级联子树 + 解链）后按顶层重建；不允许「null 却只删一部分」。
- 事务内校验：anchor 非 null 时必须存在且 `novelId` 归属正确；空 nodes 抛错；append 起始 order = 现有兄弟数，在事务内计算（消 TOCTOU）。
- 创建递归：父先落库拿 id，再建子；`createOutlineNode` 支持传 `linkedEntryIds`（未来用）。
- 失败即整体回滚；异常原样抛给 `applyProposal`，提案留在待确认列表。

### 7.3 apply 改造（`src/proposal/apply.ts`）

- `outlineTree:create|merge|replace` 分支：解析出 `OutlineDraft[]` → 映射为 `OutlineTreeInputNode[]` → 调 `repo.commitOutlineSubtree(novelId, parentId ?? null, nodes, action === 'replace' ? 'replace' : 'append')`。
- 删除 `createOutlineTree` 这个非事务递归函数。
- `parentId` 存在性校验从 apply 前移到仓储事务内（消 TOCTOU）；apply 不再预先 `listOutline`。
- 现有 apply 测试中「replace 删除子节点、章节保留但解链」的断言保持不变，只验证实现路径替换。
- `scenarioOutline`（推演沉淀）已有自己的事务方法，不动。

---

## 8. S7 T1 结构件与截断防线

### 8.1 新文件 `src/features/writing/chapterLength.ts`

```ts
export const DEFAULT_CHAPTER_TARGET_WORDS = 3000;

/** D4：有值取整，为空/非法回退 3000 */
export function resolveChapterTargetWords(targetWords: number | null | undefined): number;

/** 目标字数的场景数参考文案：≤3500 → 1–2 场；≤7000 → 3–5 场；否则 3–6 场（按节拍，不按字数硬切） */
export function sceneRangeHint(words: number): string;

/** 输出 token 上限：ceil(words*1.8)+800，夹在 [4096, 8192] */
export function chapterMaxOutputTokens(targetWords: number | null | undefined): number;
```

系数说明（采纳架构评审）：中文输出 token 与字数按偏保守的 1.8 token/字估（原文 1.2× 只留 17% 余量，会把正常偏长误判成截断），再留 800 缓冲；`max_tokens` 只防失控，不作为字数控制器。上夹 8192：DeepSeek 与多数自定义端点的默认输出上限在 4k–8k 量级，16k 可能被整请求拒绝——「请求失败」比「截断提示」更糟。若服务端仍以 400 拒绝 `max_tokens`，由调用方自动重试一次且不带该参数（见 8.2）。

### 8.2 生成面板（`GenerateChapterSheet.tsx`）

- `const targetWords = resolveChapterTargetWords(targetNode?.targetWords ?? null);`
- 表单区显示：`目标字数：{targetWords} 字（来源：大纲节点 / 默认 3000）`；附一句「在写作 → 大纲节点里修改」。
- `llm.runStream('chapter-draft', { system, user, maxTokens: chapterMaxOutputTokens(targetWords) }, ...)`。
- `Phase` 的 `done` 增加 `incomplete?: 'truncated' | 'aborted'`：
  - `result.finishReason === 'length'` → `{kind:'done', text, incomplete:'truncated'}`；
  - `finishReason` 为 `null`（部分流式响应不给）→ 视为**未知**，不判截断、不报错；
  - 捕获 `LlmError.kind === 'aborted'` 且有流式内容 → `{kind:'done', text, incomplete:'aborted'}`；无内容仍回表单。
- 结果区顶部：
  - truncated：「生成被截断，内容不完整。建议重新生成；采用只会保存已生成的部分。」
  - aborted：「生成已中断，内容不完整。」
  - 两种不完整状态在「采用」时都加二次确认「仍要采用不完整内容？」（`ConfirmDialog`），不只截断。
- 400 回退：`runStream` 抛 `kind === 'bad-request'` 且 `detail` 含 `max_tokens` 时，自动重试一次且不传 `maxTokens`；重试前保留已设置的 UI 状态，不重复累计流式文本。
- 流式与正常完成路径不变。

### 8.3 `runStream` 透传

- `src/llm/types.ts`：`TextRunOptions` 增加 `maxTokens?: number`（`ChatRequest` 已有）。
- `src/llm/useLlm.ts`：`runStream` 把 `options.maxTokens` 传给 `client.streamChat`。
- 其余任务（段落加工、翻译等）不传，行为不变。

### 8.4 prompt（`chapterDraft.ts`）

- `buildChapterUserPrompt` 内部用 `resolveChapterTargetWords` 解析目标；输出：

```
本章目标约 N 字，场景数供参考：{1–2 场 / 3–5 场 / 3–6 场}。
以【本章要写的内容】的梗概节拍为准：每个节拍落到目标—阻碍—转折；
节拍不足时把一场写深，不要用心理复述、景物堆砌凑字数；
节拍撑不满目标时写到场景自然收束即可。
按时空或视点转移换场，不要按段落切场。
结尾收在梗概承诺的钩子上，不要用总结收尾。
若文体篇幅建议（如网文单章 2000–3000 字）与本节目标冲突，以本节目标为准。
```

- 保留原「用户额外要求」「现在开始写正文」。
- 旧文案「本章篇幅约 N 字，可上下浮动 15%」被替换：M1 的验收以结构+截断为主，差额提示在 M2 补；避免一次改动太多。

### 8.5 测试与基线

- `chapterLength.test.ts`：默认值/取整/非法值/场景区间/token 上限夹取。
- `GenerateChapterSheet` 组件测试：目标来源显示；截断与中断提示；截断采用需二次确认；`maxTokens` 进入请求（mock fetch 捕获 body）。
- `useLlm`/client 测试：`maxTokens` 透传。
- 基线：`noScenarioBaseline.test.ts:1126,1228`、`noNormsBaseline.test.ts:1145` 的「可上下浮动 15%」句、`ChapterEditor.test.tsx:321-352` 的请求体断言需按新 prompt 更新；逐条在实施记录写明。

---

## 9. 缓存与零回归纪律

1. **no-new-input 不变**：`buildExpandUserPrompt` 的新参数全部可选，不传时输出与改动前逐字节相同（除 `EXPAND_TASK` 文本本身，S3 有意变更）。
2. **规划侧前缀**：核心设定进 system（本书稳定）；相关设定、伏笔、位置、额外要求进 user（逐节点变化）。避免「随节点变化的条目进稳定前缀」导致的缓存回归。
3. **正文侧零改动**：`renderEntry` 搬家不改字符；`SummaryChainContextBuilder` 的 stablePrefix/volatileSuffix 输出不变，`noScenarioBaseline` 的正文部分不动。
4. **确定性**：所有排序用显式全序（score、长度、id），不依赖 Map/对象遍历、不引入时间与随机。
5. **不落库的推断**：匹配、建议 links、注入清单都只存在内存；唯一写入是作者在关联确认面板点确认后的 `linkedEntryIds`（显式数据，可再编辑）。

---

## 10. 文件改动清单

| 文件                                                 | 类型      | 内容                                           | 预估       |
| ---------------------------------------------------- | --------- | ---------------------------------------------- | ---------- |
| `src/domain/entryMention.ts`                         | 新增      | 归一化、评分、排序、上限                       | ~130 行    |
| `src/domain/entryMention.test.ts`                    | 新增      | 匹配用例                                       | ~120 行    |
| `src/context/renderEntry.ts`                         | 新增      | 从 SummaryChainContextBuilder 原样搬出         | ~45 行     |
| `src/context/planningContext.ts`                     | 新增      | 选择器、预算、清单                             | ~150 行    |
| `src/context/planningContext.test.ts`                | 新增      | 显式/推断/核心/预算/顺序                       | ~160 行    |
| `src/features/outline/outlineExpand.ts`              | 修改      | 新参数、system/user 块、任务文案               | +120 行    |
| `src/features/outline/outlineExpand.test.ts`         | 修改/新增 | 块顺序、向后兼容、场景卡文案                   | +80 行     |
| `src/features/outline/suggestOutlineLinks.ts`        | 新增      | 继承 + 提到 + 抑制集                           | ~90 行     |
| `src/features/outline/suggestOutlineLinks.test.ts`   | 新增      | 纯函数用例                                     | ~110 行    |
| `src/features/outline/OutlineLinkConfirmSheet.tsx`   | 新增      | 关联确认面板                                   | ~150 行    |
| `src/features/outline/OutlineNodeSheet.tsx`          | 修改      | 落盘、清单、replace 告知、接线、关联面板       | +200 行    |
| `src/features/outline/OutlineNodeSheet.test.tsx`     | 修改/新增 | 交互链路                                       | +150 行    |
| `src/features/writing/WritingPage.tsx`               | 修改      | 传 chapters/openThreads/rollingSummary         | +15 行     |
| `src/features/writing/chapterLength.ts`              | 新增      | 目标解析/场景提示/token 上限                   | ~45 行     |
| `src/features/writing/chapterLength.test.ts`         | 新增      | 纯函数用例                                     | ~70 行     |
| `src/features/writing/chapterDraft.ts`               | 修改      | 字数结构文案                                   | +15 行     |
| `src/features/writing/GenerateChapterSheet.tsx`      | 修改      | 目标显示、maxTokens、截断/中断                 | +60 行     |
| `src/features/writing/GenerateChapterSheet.test.tsx` | 修改      | 截断/中断/请求体                               | +80 行     |
| `src/llm/types.ts` / `useLlm.ts`                     | 修改      | TextRunOptions.maxTokens 透传                  | +8 行      |
| `src/data/NovelRepository.ts`                        | 修改      | commitOutlineSubtree / updateOutlineLinks 接口 | +35 行     |
| `src/data/dexie/DexieNovelRepository.ts`             | 修改      | 事务实现、删除逻辑抽取、批量写关联             | +170 行    |
| `src/proposal/apply.ts`                              | 修改      | outlineTree 走事务方法；删旧递归               | -30/+10 行 |
| 三处基线 + apply/Dexie 测试                          | 修改      | 有意更新/新增（含批量 links 事务）             | ~240 行    |

---

## 11. 风险与缓解

| 风险                           | 缓解                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| 匹配误伤（短名、同名）         | 评分降权、上限 8、确认面板、会话内移除；宁漏勿错；不静默写回                  |
| 基线大面积变更导致回归护栏失效 | 只改必要基线；每处记录原因；保留「无新输入」对照测试；正文侧基线不动          |
| 事务重构影响 apply 其他分支    | 新方法只服务 outlineTree；全量跑 apply/Dexie 测试；异常原样上抛，提案留待确认 |
| maxTokens 被服务商拒绝         | 夹取保守范围；错误照常展示；后续在 presets 声明能力（不在 M1）                |
| 确认疲劳                       | 关联面板只在有建议时出现；一屏完成；可跳过；不新增负债式提示                  |
| 规划侧上下文过长               | 8k 预算 + 核心必注入 + 相关最多 8 条 + 清单可见；超预算条目明确列出           |
| 细化结果仍然「不像场景卡」     | 任务文案 + US-1/US-3 人工抽检；M3 再评估是否值得结构化 sceneCount             |

---

## 12. 后续接口预留

- **M2 归档**：`completeChapter` 服务会复用 `extractSettings` 的 schema/提示词与 `ProposalInbox`；本文不实现。
- **M3 自动大纲**：`suggestOutlineLinks` / `planningContext` 直接复用；自动大纲的节点创建也走 `commitOutlineSubtree`（append）。
- **M4 文风**：锚点作为新的 `ContextItem` 放 volatile；四项指标为纯函数，与本文无耦合。
