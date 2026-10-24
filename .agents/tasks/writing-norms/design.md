# 技术设计 · 写作规范

> 对应需求：`.agents/tasks/writing-norms/requirements.md`，以及**需求补充 `/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/writing-norms/requirements-addendum.md`**（用户追加：「按规范检查本章」本期必须实现，覆盖原 brief 第 7 条）。后续 plan / code / review 步骤须同时读取这两份需求。本文引用的文件、函数、类型均已在当前代码里读过并确认存在；标「新增」的是本次要建的。

## 0. 概览

给每部作品加一张 `writingNorms` 表（Dexie v6，只新增表）。一份规范 = 标题 + 原文 + 启用开关 + 作用范围（5 选多）+ 排序。作者在知识库「写作规范」区块里新建、粘贴、上传、编辑、停用、排序，保存路径不碰模型、不进提案管道。

注入只有一个渲染入口 `writingNormsSection(norms, scope)`（`src/prompt/sections.ts` 新增）。它过滤出「启用 + 作用范围含 scope + 正文非空」的规范，按 `order → createdAt → id` 排序拼成一段；没有可注入的规范时返回空串，被 `composeSections` 跳过，所以所有提示词在无规范时逐字节不变。插入点在每个任务的稳定前缀里：作品信息与风格档案之后、核心设定（或任务说明）之前。

整章生成与段落加工走 `SummaryChainContextBuilder`，每份规范成为一条 `kind: 'norm'` 的注入清单项，带 token 估算，面板里可以临时取消。其余四个任务（立项、细化大纲、章节摘要、反向提取）在各自的 `build*SystemPrompt` 里加一个可选参数，调用处在发请求前从仓储读最新规范。翻译不注入。

本期纳入「AI 精简」：结果是可编辑预览，作者点「另存为新规范」才在一个事务里新建精简版并停用原文。本期也纳入「按规范检查本章」（需求补充）：章节编辑器里一个入口，用作用范围含「检查」的规范 + 核心设定 + 本章相关条目 + 同一条线此前最近一份章节摘要审读正文，结构化列出可能违反之处，只提示、不改正文；采用建议走现有段落加工预览。检查结果只存在会话内。结构化时间截面列为后续。

技术栈不变：React 19 + TypeScript + Vite + Dexie + Zustand + Zod 4 + vitest + Testing Library + Tailwind 4，不引入新依赖。

---

## 1. 核心问题逐条回答

### 1.1 数据模型（核心问题 1）

**决定**：作品级 `WritingNorm` 实体，一书多份，单独成表。原文直接落库，不走提案。

- **为什么单独成表，不挂在 `StyleProfile` 或 `Novel` 上**：规范要逐份启用、排序、按任务选作用范围，还可能很长（文档 03 有约 40 个 URL）。做成数组塞进一行，每次改一份都要整行重写，备份合并也只能整本覆盖。与 `SideStory` 同理（`db.ts` v5 注释：「删除、改名、备份都按行处理更简单」）。
- **为什么不复用 `StyleProfile.extraInstruction`**：它 ≤ 2000 字，进的是【文风】段（`voiceSection`），语义是句式语感层面的短约束，而且只对用了 `composeStylePrefix` 的任务生效（摘要、提取都不带文风）。规范要进摘要和提取，长度也远超 2000 字。两者并存，不迁移。
- **为什么不走提案管道，符合产品原则 5.1**：5.1 管的是「AI 产出」。规范是作者自己写、自己粘贴或上传的文字，与「一句话立项」里作者写的那句话同类（`src/features/setup/SetupSection.tsx`：「一句话是用户自己写的，不属于 AI 产出，直接落库」）；也与手动新建条目（`EntryEditorSheet` 直接调 `createEntry`）同类。唯一由 AI 产出的是「AI 精简」的结果，它走可编辑预览 + 显式保存（见 1.5）。
- **上传文件的唯一变换**：`readManuscriptFile` 里的 `normalizeManuscript`（清 BOM、`\r\n`/`\r` → `\n`）。这是解码的一部分，不是改写；与旧稿导入一致。保存路径不对正文做 `trim`。

### 1.2 导入入口（核心问题 2）

**决定**：知识库页「风格档案」之后新增「写作规范」区块（`WritingNormsSection`，新增），编辑在 `WritingNormEditorSheet`（新增）里完成。上传复用 `readManuscriptFile` / `ENCODING_LABELS` / `ACCEPTED_EXTENSIONS`。**不在「导入到」里加「作为写作规范」目的地**：导入链路的每一步（分章、翻译、目的地、逐章提取、提案收件箱）对规范都是多余的；规范要的是原样保存，粘贴框和一个文件按钮就够了。把它塞进导入流程，作者得先过分章页、再在目的地里找到它，还要担心它被切成多段。

放在风格档案旁边而不是「管理」区：规范直接影响每次生成，和风格档案同属「整本书的底色」，作者需要随时看见启用了哪些；「管理」区是分类、导入、译名表、回收站这类低频工具。

### 1.3 注入与作用范围（核心问题 3）

**决定**：作用范围是 5 个值的枚举，而不是直接存 `TaskKind`：

| scope      | 界面文案 | 覆盖任务（`src/llm/taskProfiles.ts` 的 `TaskKind`） | 默认 |
| ---------- | -------- | --------------------------------------------------- | ---- |
| `writing`  | 写正文   | `chapter-draft`、`paragraph-revise`                 | 开   |
| `planning` | 规划     | `project-setup`、`outline-expand`                   | 开   |
| `summary`  | 章节摘要 | `chapter-summary`                                   | 开   |
| `extract`  | 提取设定 | `extract-settings`                                  | 开   |
| `check`    | 检查     | `norm-check`（新增，见 1.7）                        | 开   |

- **为什么按任务组划分而不是 7 个任务各一个开关**：同组任务对规范的需求一致（整章与段落加工都是写正文；立项和细化大纲都是规划），7 个开关在手机上是两行 chip，作者也很难说清「整章要、段落不要」的理由。5 组在窄屏最多换一行。
- **为什么「检查」单独一组、不并进「写正文」**：有些规范只适合事后审读（例如「不推算公历日期」这类边界，写的时候提醒一次即可，检查时要逐条对照），也有作者只想让检查读一份精简版、写正文读全文。单独一组让这两种用法都能配置。
- **为什么默认全开**：用户的诉求是「约束作品的写作」，文档 02 第 4 节同时包含写作规则和提取规则。默认全开时，作者什么都不设置也能得到预期效果；不想进某类任务的，取消对应 chip 即可。
- **翻译：不注入，也不提供这个作用范围**。翻译的第一原则是忠实（`buildTranslateSystemPrompt`：「两者冲突时一律以忠实于原文为准」）。规范约束的是「本作接下来写什么」，放进翻译会诱导模型按规范「修正」原文，比如把原文里出现的后期装备删掉。译名一致性已经由作品级译名表负责。另外翻译是按章大量调用的任务，多带几千 token 的规范没有收益。
- **文风取样、文风归纳、连通性测试**：与规范无关，不注入。
- **章节摘要注入**：文档 02 要求「缺失信息只能作为建议，未经作者采用不成为事实」。摘要是后续上下文的来源，摘要里把建议写成了事实，错误会一路滚下去；带上规范能让模型区分。摘要原本只带作品信息（为了省 token 和缓存），规范同样是整本书稳定的内容，不影响章与章之间的缓存命中。
- **反向提取注入**：文档 02 第 4 节里的「阶段性称号不新增成人物」「组织不因名字相近合并」「保留『原作未明确』的限定」正是提取规则。提取的渲染多一句「规范本身不是待提取的正文，不要从规范里提取条目」，防止模型把规范里的分叉事实当成设定条目提取出来。

**插入点**（逐任务，均已核对现有拼接顺序）：

| 任务       | 文件 / 函数                                                                                               | 现有顺序                                                               | 规范插在                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 整章生成   | `SummaryChainContextBuilder.build` → `buildChapterSystemPrompt`（`src/features/writing/chapterDraft.ts`） | 开场白 → stablePrefix[作品信息与风格档案 → 核心设定 → 相关设定] → 任务 | stablePrefix 内，作品信息与风格档案之后、【必须遵守的核心设定】之前 |
| 段落加工   | 同上 → `buildReviseSystemPrompt`（`src/features/writing/revise.ts`）                                      | 开场白 → stablePrefix → 任务 + 通用约束                                | 同上（共用 stablePrefix）                                           |
| 一句话立项 | `buildSetupSystemPrompt`（`src/features/setup/projectSetup.ts`）                                          | 开场白 → `composeStylePrefix` → SETUP_TASK → 字段说明                  | `composeStylePrefix` 之后、SETUP_TASK 之前                          |
| 细化大纲   | `buildExpandSystemPrompt`（`src/features/outline/outlineExpand.ts`）                                      | 开场白 → `composeStylePrefix` → EXPAND_TASK                            | `composeStylePrefix` 之后、EXPAND_TASK 之前                         |
| 章节摘要   | `buildSummarySystemPrompt`（`src/features/writing/chapterSummary.ts`）                                    | 开场白 → `novelMetaSection` → SUMMARY_TASK                             | `novelMetaSection` 之后、SUMMARY_TASK 之前                          |
| 反向提取   | `buildExtractSystemPrompt`（`src/features/import/extractSettings.ts`）                                    | 开场白 → `novelMetaSection` → EXTRACT_TASK → 分类字段说明              | `novelMetaSection` 之后、EXTRACT_TASK 之前                          |

为什么放在风格档案之后、核心设定之前：前缀里越靠前的内容越该是「最不易变」。规范一旦写好很少改，和风格档案同级；核心设定会随知识库确认而增减，勾选条目每章都变（`SummaryChainContextBuilder` 注释：大纲位置放后缀，就是怕截断公共前缀）。规范放在核心设定之后，作者每确认一条核心设定，规范那几千 token 就跟着失去缓存；放在前面，只有改规范本身才会让后面的内容失去缓存。规范不进用户提示（`volatileSuffix`），因为它不随章节变化。

### 1.4 「本次注入」清单（核心问题 4）

**决定**：`ContextItemKind` 加 `'norm'`。构建器为每份注入的规范 `take` 一项：`{ kind: 'norm', id: norm.id, label: '写作规范 · {标题}', tokens: normTokens(norm) }`（`normTokens` 是全站唯一的规范 token 口径，见 6.2），`mandatory = true`（不参与预算裁剪）。`ContextRequest` 加 `excludedNormIds?: string[]`，被排除的规范既不进 prompt 也不进 `items`。

数据流：`WritingPage` 查询加 `repo.listWritingNorms(novel.id)` → `context.writingNorms` → `ChapterEditorScreen` 透传 → `GenerateChapterSheet` / `ReviseSheet` 本地状态 `excludedNormIds: string[]`（初始 `[]`，面板每次「关 → 开」时重置为 `[]`）→ 每次 `builder.build({...context, excludedNormIds})`。

打开时重置的实现：`ReviseSheet` 已有 `wasOpen` ref effect，`excludedNormIds` 并进那里一起重置。`GenerateChapterSheet` 目前常驻挂载、**没有**打开时重置的逻辑（`selectedIds` 等状态跨次保留），所以新增一个与 `ReviseSheet` 同写法的 `wasOpen` ref effect，**只**执行 `setExcludedNormIds([])`，其他状态的现有行为一律不变。清单本身沿用现有 `preview.items.filter(included)` 渲染，规范条目自动出现；清单下方新增 `NormInjectionPicker`（新增组件）列出「写正文」作用范围内的全部规范，每份一个 `aria-pressed` 切换 chip，文案 `标题（约 1.2k tokens）`。

- **为什么规范不参与预算裁剪**：规范是作者显式定下的约束，被预算悄悄挤掉等于约束失效；和核心设定同理。作者想省就在面板里取消，或者在知识库里收窄作用范围。规范很大时，后面的勾选条目会被挤掉，这会出现在现有的「N 项因超出预算未注入」提示里，作者看得见。
- **为什么排除的规范不放进 `items` 标成 `included: false`**：现有面板把所有 `!included` 的项显示为「因超出预算未注入」，混进去会误导。临时取消的状态由 picker 自己展示。
- **临时取消不写库**：只影响这一次。要长期不带，去知识库停用或改作用范围。

段落加工面板（`ReviseSheet`）原本没有注入清单，这次只加同一个 `NormInjectionPicker`（仅当有「写正文」规范时渲染），不额外做完整清单，保持面板轻量。立项、细化大纲、摘要、提取没有逐次清单，作用范围就是它们的控制点；立项表单和细化大纲区各加一行只读提示「将带上 N 份写作规范（约 X tokens）」，让注入量可见（产品文档 9.1）。

这行提示的数据来源：`SetupSection.tsx` 顶层组件已有一个 `useRepoQuery` 把分类、风格档案、条目、大纲放进 `Promise.all`（42–53 行），在其中追加 `repo.listWritingNorms(novel.id)` 并经 props 传给表单子组件；`OutlineNodeSheet.tsx` 目前只 import 了 `useInvalidate`，新增 `const normsQuery = useRepoQuery((repo) => repo.listWritingNorms(novel.id), [novel.id])`（`src/data/useRepoQuery.ts`）。两处都算 `const planning = normsInScope(norms ?? [], 'planning')`，N = `planning.length`，X = `formatTokens(planning.reduce((s, n) => s + normTokens(n), 0))`。N 为 0（或查询未就绪）时这一行不渲染，所以无规范时界面与现在一致。点「生成」发请求时仍按 6.4 再从仓储读一次，以保证用的是最新内容；显示用的查询只负责可见性。

### 1.5 成本控制（核心问题 5）

**决定**：token 估算 + 阈值提示 + 链接提示，并**纳入本期**的「AI 精简」。

阈值常量（`src/domain/writingNorm.ts`，新增）：

| 常量                     | 值         | 用处                                                                                                                                           |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `NORM_TOKEN_WARN`        | 2000       | 单份规范超过时，编辑面板与列表行提示「较长，每次生成都会带上，可以试试 AI 精简」                                                               |
| `NORMS_TOTAL_TOKEN_WARN` | 6000       | 「写正文」作用范围内启用规范的合计超过时，区块顶部提示                                                                                         |
| `NORM_LINK_WARN`         | 5          | 正文里 `https?://` 出现次数超过时提示「其中有 N 个链接。来源表通常不必进提示词，可以删掉或试试 AI 精简。」（字面量与需求 FR11 / 验收 21 一致） |
| `NORM_CONTENT_MAX`       | 60000 字符 | 单份上限（schema 强制）；约 48k tokens，远超任何合理规范，只拦误传整本书                                                                       |
| `NORM_TITLE_MAX`         | 60 字符    | 标题上限                                                                                                                                       |

**为什么纳入 AI 精简**：文档 03 这种以来源表为主的长文，真正有约束力的只有两节；全文注入意味着之后每次整章生成、每章摘要、每章提取都多付这部分输入，还会稀释注意力（产品文档 9.1）。手工删减当然可以，但作者手里往往是别处整理好的资料，让模型压一遍是一次几分钱的调用，换来之后每次调用的节省。实现量不大：一个纯文本流式调用 + 预览 + 一个仓储事务。

**为什么它符合 5.1**：精简结果是一整段自由文本，没有字段结构，对它做字段级 diff 不提供信息，与正文散文同理（可编辑预览 → 采用 / 放弃）。点保存之前不写任何数据；保存不覆盖原文，而是另存新规范、原文停用，作者随时可以切回去。现行 5.1 写的是「唯一的例外是正文散文」，所以这是**第二个例外**，产品文档 5.1 要同步改写，否则文档自相矛盾（改法见第 10 节）。

精简输出里的「## 」小节标题不会和规范边界冲突：注入时每份规范由 `【规范《…》】…【规范《…》结束】` 包住（6.2），`## ` 只是规范正文内部的结构。

流程（`WritingNormEditorSheet` 内，只对**已保存且无未保存修改**的规范可用，否则按钮禁用并提示「先保存再精简」，避免精简的是一份库里不存在的内容）：

1. 点「AI 精简」→ 流式调用，第三个参数 `handlers` 必填（`src/llm/useLlm.ts` 的 `runStream(task, options, handlers)`），写法与 `GenerateChapterSheet` 一致：

   ```ts
   let streamed = '';
   const result = await llm.runStream(
     'norm-condense',
     {
       system: NORM_CONDENSE_SYSTEM,
       user: buildCondenseUserPrompt(norm),
       signal: controller.signal,
     },
     {
       onText: (delta) => {
         streamed += delta;
         setCondense({ phase: 'streaming', text: streamed });
       },
     },
   );
   ```

2. 完成后进入可编辑预览（`TextAreaField`「精简结果（可直接修改）」），显示原文与结果的 token 估算对比。`finishReason === 'length'` 时显示「结果可能被截断，请核对结尾」。
3. 「另存为新规范（原文自动停用）」→ `repository.saveCondensedWritingNorm(norm.id, { title: condensedTitle(norm.title), content })`；「放弃」→ 回到编辑状态，什么都不写。

新增任务 `'norm-condense'`（`TASK_PROFILES`）：`thinking: true, reasoningEffort: 'medium', temperature: 0.2, useStrongModel: false, structured: false, label: '精简写作规范'`。理由：这是归纳任务，要忠实、不发挥，所以低温、开思维链；输出是纯文本，不需要 JSON。不加进设置页的 `TASK_ORDER`（`SettingsPage.tsx`，`style-sample` 也不在里面），避免改设置页。

精简提示词（`src/features/knowledge/normCondense.ts`，新增）：

```text
NORM_CONDENSE_SYSTEM =
你是一位小说编辑，负责把作者整理的写作规范压缩成可以直接放进提示词的约束条目。

【任务】
阅读作者给出的规范原文，只保留会约束创作与资料整理的内容，改写成简洁的条目。

要求：
- 保留：时间截面与冻结信息、与原作的版本差异、本作的改动及其后续影响、明确的边界与禁止事项、命名与合并规则、信息分层（谁知道什么）。
- 删除：来源链接、参考网址、来源表与「能核对的内容」这类核对说明、重复表述、背景概述里不构成约束的叙述。
- 不得新增原文没有的规则或事实，不得把原文的限定词（如「原作未明确」「推测」「留白」）改成确定说法。
- 按原文的小节分组，每组一个以「## 」开头的小标题，组内每条以「- 」开头，一条一句。
- 直接输出条目，不要任何开场白或解释。

buildCondenseUserPrompt(norm) = 【规范标题】\n{title}\n\n【规范原文】\n{content.trim()}
```

### 1.6 时间截面与差异说明（核心问题 6）

**决定**：本期只做自由文本规范，另提供「插入差异说明模板」按钮。结构化字段列为后续。

理由：结构化字段只有在代码会按字段做逻辑时才有价值，比如「当前时期」驱动自动冻结后期条目。本期的检查（1.7）由模型阅读规范文字来判断，自由文本已经够用；结构化只是把同样的文字拆进几个输入框，再拼回提示词，收益接近零，还要多一套 schema、迁移、表单和备份字段。而且这些字段只对同人和改编成立，原创作品没有「原作版本」「分叉点」，做成作品级必填字段会让大多数作者面对一堆空框。模板给出了同样的结构提示，内容仍是作者可自由增删的文字。等检查用上一段时间、看清哪些字段真的需要程序判断时，再决定结构化哪些。

模板（`DIFF_NOTE_TEMPLATE`，`src/domain/writingNorm.ts`；去掉了东京喰种专有内容）全文：

```text
【原作版本】以哪个版本的原作为基线（漫画 / 动画 / 小说，或具体到某条路线）。
【本作开场时期】故事从原作的哪个阶段开始。这一时期之后才出现的人物、组织、装备与信息一律冻结，角色不能提前使用或认识。
【与原作分叉的第一个事件】从哪件事开始和原作不同；没有分叉就写「无，沿原作推进」。
【保留的底层规则】本作不改动的世界规则。
【明确改动的事实】逐条写出与原作不同的事实。每条都写明它影响哪些后续事件、人物和势力。
【主角身份与信息来源】主角是谁、知道什么、从哪里知道。区分作者全知的事实、公开常识、阵营内部的秘密、角色亲历的信息。
【当前不可用的资源】在本作当前时期还不存在或拿不到的能力、装备、组织与人脉。
【后续原作事件是否仍发生】分叉之后原作里的大事件：照常发生 / 改变 / 取消，各自写明原因。
【关系进度】主要人物之间目前处在什么阶段，哪些人尚未见面。

改动必须带出后续因果：改了一件事，就要写清它会让哪些后续线随之改变。
```

插入规则：正文为空时直接填入，标题为空时同时填 `DIFF_NOTE_TITLE = '本作差异说明'`；正文非空时以 `\n\n` 接在末尾。不按光标位置插入：手机上光标位置不可靠，追加到末尾更可预期。

### 1.7 按规范检查本章（核心问题 7，按需求补充本期实现）

**决定**：本期实现。原 brief 默认「不做」已被需求补充覆盖。章节编辑器加入口，调用新任务 `norm-check`（结构化输出），列出可能违反之处；**只提示，不改正文**；结果只存在编辑器会话内，不落库。

**为什么只提示、不自动改**：检查结果是模型对「是否违反」的判断，误报不可避免（规范常有留白，例如「生死留白不等于确定死亡」本身就要求作者判断）。自动改正文等于让 AI 替作者裁决并改写散文，违背 5.1。采用建议时走现有段落加工：选中那段原文 → 改写 → 可编辑预览 → 作者点「替换原文」才写入，并进撤销栈。

#### 1.7.1 注入哪些上下文

| 内容                                                                                                                                                          | 位置             | 取舍                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 开场白 + 作品信息（`novelMetaSection`）                                                                                                                       | 系统提示（稳定） | 让模型知道作品体裁与视角                                                                                                                                                 |
| 作用范围含 `check` 的规范（`writingNormsSection(norms, 'check')`）                                                                                            | 系统提示（稳定） | 检查对象                                                                                                                                                                 |
| 核心设定（`pinned` 条目，用 `renderEntry` 渲染）                                                                                                              | 系统提示（稳定） | 世界底层规则，判断「是否违背设定」需要；整本书稳定，放前缀                                                                                                               |
| 检查任务说明                                                                                                                                                  | 系统提示（稳定） | 固定文案                                                                                                                                                                 |
| 本章提到的非核心条目（`mentionedEntries(content, entries)`，最多 `MAX_INFERRED_ENTRIES` = 8 条）                                                              | 用户提示（易变） | 减少「人物早已见过面」「称号已有来历」这类误报；按本章正文本地匹配，每章不同所以放后缀；上限与默认预选同理（防常见词别名拉进几十条）                                     |
| 同一条线上此前最近一份章节摘要（`previousSummaryOf` 的返回值：中间章节没有摘要时会往前跳，所以不一定是紧挨着的上一章；摘要的 `openThreads` 是累计未收束伏笔） | 用户提示（易变） | 前情的最小充分集；不带全书进展（300 字左右、信息与这份摘要大量重叠），不带更早的章节摘要。块标题写明是第几章的摘要，模型不会把「中间没摘要的几章里交代过的事」误当成缺失 |
| 本章正文（或其中一段）                                                                                                                                        | 用户提示末尾     | 被检查对象                                                                                                                                                               |

**不带**风格档案：检查的是规范而不是文风，带上会诱导模型挑文风毛病。**不带**大纲梗概：检查的是正文与规范的冲突，大纲是计划不是事实。缓存：系统提示在同一本书各章之间一致，同一章分段检查时每段也共用。

`renderEntry(entry, categories)` 与 `renderSummary(chapter, summary)` 目前都是 `SummaryChainContextBuilder.ts` 的模块内函数（约 412、466 行），两者都改为 `export`（实现不动，现有输出不变），检查与构建器共用同一种条目与摘要渲染。`renderSummary` 输出「第 N 章 标题」一行 + 摘要正文 + 「关键事件：…」+「尚未收束的伏笔：…」（各项有内容才输出，`；` 连接）。它的首行固定写「第」，外传章节也是如此；构建器现有行为如此，这里不改它，外传与否由块标题区分。

#### 1.7.2 输出 schema（`src/features/writing/normCheck.ts`，新增）

```ts
export const NormCheckSeveritySchema = z.enum(['violation', 'possible', 'judgement']);
// 界面文案：明确违反 / 可能违反 / 需作者判断

export const NormCheckIssueSchema = z.object({
  /** 被违反的规范标题，原样抄写 */
  normTitle: z.string().min(1),
  /** 规范原文里被违反的那一条，原样摘抄 */
  rule: z.string().min(1),
  /** 正文里能定位问题的原句片段，原样摘抄；问题是「缺了什么」时为空串 */
  quote: z.string(),
  problem: z.string().min(1),
  /** 修改建议；没有就是空串 */
  suggestion: z.string(),
  severity: NormCheckSeveritySchema,
});
export const NormCheckResultSchema = z.object({ issues: z.array(NormCheckIssueSchema) });
```

全部字段必填（空串表示没有），因为 `generateStructured` 用 `io: 'output'` 导出 JSON Schema，严格模式要求每个字段都在 `required` 里（`structured.ts` 注释）。

本地后处理（纯函数，同文件）：

```ts
export interface ResolvedCheckIssue extends NormCheckIssue {
  key: string; // `${segmentIndex}-${i}`，i 为该段 issues 数组下标，用于忽略
  normId: string | null; // 见下方匹配规则；匹配不上为 null，界面标「规范名未对应」
}
/** 在正文里找原句：先精确 indexOf，找不到再忽略空白（[\s\u3000]）比较并用下标映射换算回原文区间；都找不到返回 null；空 quote 返回 null。算法见下文 */
export function locateQuote(content: string, quote: string): { start: number; end: number } | null;
/**
 * 解析 + 排序。norms 传「本次注入的规范」（即 injected，见 1.7.6），不是作品的全部规范：
 * 被临时取消的规范没给模型看，名字对上了也不该算命中。
 */
export function resolveCheckIssues(
  results: { segmentIndex: number; issues: NormCheckIssue[] }[],
  norms: WritingNorm[],
  content: string,
): ResolvedCheckIssue[];
```

- **规范名匹配**：候选名 = `normTitle.trim()`，以及（若它以 `《` 开头且以 `》` 结尾）去掉这一对外层书名号再 `trim()` 的结果；任一候选与 `norms` 的 `title` 全等即命中（两种都试，标题本身就是「《某作》」时也能对上）。同名多份时取 `compareNorms` 排序最前的那份（`norms` 已是 `normsInScope` 的输出，即第一份命中）。
- **排序键**（全序，依次比较）：① 严重程度 `violation < possible < judgement`；② `locateQuote(content, quote)?.start`，定位不到记为 `Infinity`；③ `segmentIndex`；④ 段内下标 `i`。

匹配不上规范名的条目**保留**而不是丢弃：5.2「宁可少记」针对的是落库的数据，检查结果是给作者看的提示，丢掉可能藏住真实问题；标出来让作者自己判断。排序键②用的 `content` 是 `checkedContent`（`resolveCheckIssues` 在检查完成时调用）；按钮是否显示也按 `checkedContent` 判断，点击「定位」时才用当前正文重新算（见 1.7.6），正文改过之后仍能找到没动过的句子，找不到时明确提示。

`locateQuote` 的确定算法（空白定义为 `/[\s\u3000]/u`，即 JS 空白含 `\n`、`\t`、`\r`、半角空格，再加全角空格）：

```ts
const WS = /[\s\u3000]/u;
export function locateQuote(content: string, quote: string) {
  // 1. 去掉首尾空白后为空 → null
  if (quote.trim() === '') return null;
  // 2. 精确命中：取第一次出现
  const exact = content.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  // 3. 忽略空白比较：stripped 是 content 去掉 WS 字符后的串，
  //    map[i] = stripped 第 i 个字符在 content 里的下标（按 UTF-16 码元逐个走，WS 都是单码元）
  let stripped = '';
  const map: number[] = [];
  for (let i = 0; i < content.length; i += 1) {
    if (!WS.test(content[i]!)) {
      stripped += content[i];
      map.push(i);
    }
  }
  const q = Array.from(quote)
    .filter((ch) => !WS.test(ch))
    .join('');
  const k = stripped.indexOf(q);
  if (k < 0) return null;
  // end 指向最后一个非空白字符之后，区间可能跨过原文中的换行与全角空格
  return { start: map[k]!, end: map[k + q.length - 1]! + 1 };
}
```

`q` 在第 1 步之后至少有一个非空白字符，所以 `q.length >= 1`，`map[k + q.length - 1]` 一定存在。

#### 1.7.3 提示词

```text
NORM_CHECK_TASK =
【任务】
审读给出的章节正文，逐条对照上面的写作规范，列出正文里可能违反规范的地方。

要求：
- 只依据上面的写作规范、核心设定和给出的前情判断。不要用你对原作或常识的记忆补出规范没写的规则。
- 没有发现问题就给空数组。不要为了凑数硬找。
- normTitle：原样抄写被违反的规范标题，即「【规范《…》】」书名号里的文字，不要抄规范内部的小节标题。
- rule：原样摘抄那份规范里被违反的那一条，不超过 80 字。
- quote：从正文原样摘抄能定位问题的连续片段，10–60 字，不得改字，不得拼接不相邻的句子。问题是「缺了应有的交代」而不是某句写错时，给空串。
- problem：一两句话说明为什么可能违反。
- suggestion：怎么改，一两句话；没有好的建议就给空串。不要输出改写后的整段正文。
- severity：violation = 明确违反；possible = 可能违反，取决于前文没写明的信息；judgement = 规范本身留有余地，需要作者判断。
- 最多 20 条，严重的在前。
```

`buildNormCheckSystemPrompt(novel, norms, pinnedEntries, categories)` = `composeSections(['你是一位严谨的小说责任编辑，负责按作者定下的写作规范审读章节。', novelMetaSection(novel), writingNormsSection(norms, 'check'), pinned 块（标题「【核心设定（供判断，不是检查对象）】」，空则省略）, NORM_CHECK_TASK])`。`check` 的用法行：「审读时逐条对照这些规范，找出正文可能违反之处。规范之外的问题不在本次范围内。」

`buildNormCheckUserPrompt({ chapterLabel, segment: { index, total, text }, mentionedEntries, categories, previous })`，其中 `previous?: { chapter: Chapter; summary: ChapterSummary }`（调用方用 `summary.chapterId` 在 `context.chapters` 里查出 `chapter`，查不到则不传）。依次输出：

- `【相关设定】`：有条目才给，每条 `renderEntry(entry, categories)`，条目之间空一行；
- 前情块：有 `previous` 才给，标题 `` `【此前最近一章（${chapterWord} ${previous.chapter.index} 章）的摘要】` ``，`chapterWord = previous.chapter.sideStoryId ? '外传第' : '第'`（与构建器的 `chapterWord` 同一规则），下一行起是 `renderSummary(previous.chapter, previous.summary)` 的输出（已含「尚未收束的伏笔：…」）；
- `【待检查的正文（{chapterLabel}{total > 1 ? ` · 第 i/n 段` : ''}）】` + 本段 `trimEnd()` 后的正文。

块之间用 `composeSections` 拼接（空块被过滤）。分段时额外一句「这是本章的一部分，只检查这一段；本段没写到的内容可能在其他段里，不要据此判为缺失」。

#### 1.7.4 长章节与截断

- 单次检查上限 `NORM_CHECK_SEGMENT_CHARS = 8000` 字符（约 6.4k tokens，与提取段同量级）。正文超过时用 `splitChapterForCheck(content, max)`（新增纯函数）分段：按 `\n` 行边界贪心打包；单行超长时在 max 之前最后一个「。！？」处切（标点留在前一段），没有就在 max 处硬切。不变量：各段是原文的连续切片，`segments.join('') === content`；行尾的 `\n` 留在前一段末尾；每段 `length <= max`；`content.length <= max` 时返回 `[content]`；空串返回 `[]`（入口已拦住空正文，这里只是让函数是全函数）。分段送进 user prompt 时才对单段 `trimEnd()`，切分本身不丢任何字符，定位用的是完整正文。不复用 `splitWorldviewText`：它只认空行分段，而很多章节是单换行分段，会被硬切在句中。
- 表单阶段显示「本章约 N 字，将分 K 段检查（K 次调用）」与输入 token 估算，作者点「开始检查」才发请求（与翻译同理：多次调用必须让作者看清再开始）。
- 分段**依次**调用（不并发，避免撞限流；共用系统提示，后几段命中缓存），每段结果按 `segmentIndex` 收集。
- **截断**：`generateStructured` 新增可选项 `failOnTruncation?: boolean`（默认 false，现有任务行为不变）。为 true 时，任一次响应 `finishReason === 'length'` 立即抛 `LlmError('truncated', '模型输出被截断，检查结果不完整', { detail })`，不进入修复重试（截断的 JSON 修复出来的也是残缺结果）。`LlmErrorKind` 加 `'truncated'`；`useLlm` 的 `StructuredRunOptions` 透传该选项。检查一律传 `failOnTruncation: true`。
- 任一段失败（截断、网络、解析）：**整次检查失败**，丢弃已完成段的结果，显示错误「第 i/K 段检查失败：{message}」与「重新检查」。截断时附加建议「可以减少作用范围含『检查』的规范，或先用 AI 精简压短规范」。不展示部分结果：部分结果看上去就像「其余段落没问题」，正是需求禁止的静默不完整。

#### 1.7.5 结果的保存

**只存在会话内**：结果放在 `ChapterEditorScreen` 的 state 里（`{ checkedContent: string; issues: ResolvedCheckIssue[] } | null` 与 `ignoredKeys: string[]`），关掉检查面板再打开还在，离开编辑器或换章即丢。理由：检查便宜且可重跑；落库要加字段或表、备份版本、过期判定，而正文一改结果就过期，库里留着一份过期判断只会误导。正文与 `checkedContent` 不同时，面板顶部提示「正文在检查后改过，结果可能已过期」+「重新检查」。

#### 1.7.6 UI

- **入口**：`ChapterEditorScreen` 头部第二行（字数 / 保存状态 / 摘要 / 完成那一行）在「摘要」按钮前加 pill 按钮「按规范检查」，`ml-auto` 从摘要按钮移到它身上；该行加 `flex-wrap gap-y-1.5`，窄屏 375px 放不下时自然换行而不是溢出。pill 视觉沿用摘要按钮的类名，但额外加 `tap-target inline-flex items-center justify-center`（`src/index.css` 的 utility，最小 44×44px），保证触控区域达标（摘要按钮原样，不在本次范围）。有未忽略的结果时文案变「检查结果 N」。主线与外传章节都显示（外传用同一套规范，前情摘要取外传内此前最近一份，`previousSummaryOf` 已按线承接）。
- **禁用**：三种情况用 `aria-disabled="true"`（不是原生 `disabled`，这样触屏点下去仍能看到原因），点击时在该行下方显示 `role="status"` 的一行原因，3 秒后或再次点击消失：
  - `normsInScope(writingNorms, 'check')` 为空 →「先在知识库添加写作规范（并勾选『检查』作用范围）」
  - `!llm.configured` →「需要先在『设置』里配置模型」
  - 正文为空 →「本章还没有正文」
- **面板** `NormCheckSheet`（新增，`src/features/writing/NormCheckSheet.tsx`，`Sheet` drawer：窄屏底部抽屉，宽屏右侧抽屉，正文在左侧仍可见）：
  - 表单：复用 `NormInjectionPicker`（不加 `scope` prop，以 7.3 为准），传入调用方已按 `check` 过滤的规范 `normsInScope(context.writingNorms, 'check')`，`legend="参与检查的规范"`，可临时取消；分段与 token 说明；「开始检查」。`injected.length === 0`（全部被临时取消）时「开始检查」为原生 `disabled`，按钮下方显示「至少保留一份规范」。
  - 进行中：「正在检查第 i/K 段…」+「停止」（`AbortController`；停止 = 丢弃，回到表单）。
  - 结果：过期提示（若有）；0 条时「没有发现明显违反规范之处。这是模型的判断，仅供参考。」；否则逐条卡片：严重程度标签、`《规范标题》`、规范原文（引用样式）、正文原句（定位不到时附「正文里没找到这段原文」）、问题说明、修改建议；按钮「定位」、「按建议改写」、「忽略」。底部「重新检查」。
- **按钮显示条件**（以检查时的正文为准，不随打字闪烁）：「定位」在 `locateQuote(result.checkedContent, issue.quote) !== null` 时显示；「按建议改写」在同一条件且 `issue.suggestion.trim() !== ''` 时显示。
- **定位**：点击时用**当前** `content` 重新调 `locateQuote(content, issue.quote)`。返回 null（检查后原句被改掉了）→ 在该卡片内显示 `role="status"` 的「这段原文已被修改，找不到了」，不关闭面板、不改选区、不打开改写。返回区间 → 关闭面板 → `textarea.focus()` → `setSelectionRange(start, end)` → 同步 `selectionRange` state（这样接着点「加工这一段」就是这段）。浏览器在 focus + 设置选区后会把光标滚进视野。
- **按建议改写**：先按上一条定位（找不到时同样只显示提示、到此为止），定位成功后打开 `ReviseSheet`。预填值由 `ChapterEditorScreen` 持有：`const [reviseSeed, setReviseSeed] = useState<{ action: ReviseAction; instruction: string } | null>(null)`（`ReviseAction` 来自 `src/features/writing/revise.ts`）。「按建议改写」先 `setReviseSeed({ action: 'rewrite', instruction: `按写作规范《${issue.normTitle}》修改：${issue.suggestion}` })` 再打开面板；`ReviseSheet` 新增可选 props `initialAction={reviseSeed?.action}`、`initialInstruction={reviseSeed?.instruction}`，在「关 → 开」的重置 effect 里优先用这两个值，`undefined` 时行为与现在完全一致。**清空时机**：底栏「加工这一段」的点击处理先 `setReviseSeed(null)` 再打开；`ReviseSheet` 的 `onClose`（含替换原文后的关闭）也 `setReviseSeed(null)`。这样之后的普通加工不会带上旧建议。之后就是现有的流式 → 可编辑预览 →「替换原文」→ `commitContent`（进撤销栈）。
- **忽略**：把 `key` 加入 `ignoredKeys`，卡片消失；重新检查时清空。

#### 1.7.7 任务参数

`TASK_PROFILES['norm-check'] = { thinking: true, reasoningEffort: 'high', temperature: 0.2, useStrongModel: false, structured: true, label: '按规范检查' }`。开思维链、低温：这是逐条对照的推理任务，要稳定。用常规模型：检查会按章、按需反复跑，而且结果只是提示、由作者判断，误判代价低于立项和大纲那种「决定整本书地基」的任务；作者若配置了更强的常规模型自然受益。不加进设置页 `TASK_ORDER`（理由同 `norm-condense`）。

#### 1.7.8 面板接口、数据流与正文不被修改的保证

```ts
// src/features/writing/NormCheckSheet.tsx
interface NormCheckSheetProps {
  open: boolean;
  /** chapterLabel(chapter, sideStories)，进 user prompt 的【待检查的正文（…）】 */
  label: string;
  /** 编辑器当前正文（不是已落盘版本） */
  content: string;
  context: {
    novel: Novel;
    categories: Category[];
    entries: KnowledgeEntry[];
    chapters: Chapter[];
    summaries: ChapterSummary[];
    writingNorms: WritingNorm[];
  };
  chapterId: string;
  result: { checkedContent: string; issues: ResolvedCheckIssue[] } | null;
  ignoredKeys: string[];
  onResult: (result: { checkedContent: string; issues: ResolvedCheckIssue[] }) => void;
  onIgnore: (key: string) => void;
  onLocate: (issue: ResolvedCheckIssue) => void;
  onRevise: (issue: ResolvedCheckIssue) => void;
  onClose: () => void;
}
```

`context` 的字段都取自 `ChapterEditorScreen` 已有的 `context: Omit<ContextRequest, …>`（加上本次新增的 `writingNorms`），由 `ChapterEditorScreen` 组装成这个对象传入（`novel`、`categories`、`entries`、`chapters`、`summaries` 与 `ContextRequest` 同名直传，`writingNorms: context.writingNorms ?? []`），不额外查询。

面板内部数据流：

- `excludedIds: string[]` 是面板本地状态，用与 `ReviseSheet` 相同的 `wasOpen` ref effect，每次「关 → 开」重置为 `[]`。
- 本次注入集合 `const injected = normsInScope(context.writingNorms, 'check', new Set(excludedIds))`。它同时用于：`NormInjectionPicker` 的计数、`buildNormCheckSystemPrompt(novel, injected, pinned, categories)`、`resolveCheckIssues(results, injected, content)`。`buildNormCheckSystemPrompt` 内部的 `writingNormsSection(injected, 'check')` 会对已过滤的数组再过滤一遍，结果相同（幂等），所以构造函数签名不需要排除参数。
- `injected.length === 0` 时「开始检查」禁用并提示「至少保留一份规范」（见 1.7.6）。
- `pinned = context.entries.filter((e) => e.pinned)`；`related = mentionedEntries(content, context.entries.filter((e) => !e.pinned)).slice(0, MAX_INFERRED_ENTRIES)` **对整章算一次**，所有分段共用。这样每段 user prompt 的前半部分（相关设定、前情摘要）一致，规则简单，也避免某段因为没提到人物而缺了它的设定、反而误报。
- `const summary = previousSummaryOf(context.chapters, context.summaries, chapterId)`（`src/features/writing/chapterSummary.ts`，按线承接，外传取外传内此前最近一份摘要）；`const prevChapter = summary && context.chapters.find((c) => c.id === summary.chapterId)`；两者都有时 `previous = { chapter: prevChapter, summary }`，否则 `undefined`。所有分段共用。
- 开始检查时记下 `checkedContent = content`，分段依次调用，全部成功后 `onResult({ checkedContent, issues: resolveCheckIssues(...) })`。

正文不被修改：`NormCheckSheet` 不接收任何写正文的回调；它对外只有 `onResult`、`onIgnore`、`onLocate(issue)`、`onRevise(issue)`、`onClose`。`onLocate` 只改选区，`onRevise` 只打开 `ReviseSheet`。写入正文的唯一路径仍是 `ReviseSheet.onAccept` → `applyRevised` → `commitContent`，需要作者点击。

### 1.8 与导入资料的关系（核心问题 8）

**决定**：写进产品文档 6.2 与世界观写作指南。职责划分：

|      | 知识库条目                            | 写作规范                                               |
| ---- | ------------------------------------- | ------------------------------------------------------ |
| 回答 | 这个世界能发生什么                    | 这本书选择发生什么、现在进行到哪里、按什么规矩写和整理 |
| 来源 | 反向提取 / 立项 / 手建，AI 产出走提案 | 作者原文，直接保存                                     |
| 粒度 | 一个实体一条，按名称合并              | 一份文档一条，不拆分、不合并                           |
| 注入 | 核心设定始终注入，其余按预选勾选      | 按作用范围整份注入                                     |
| 冲突 | 原作基线                              | 以规范为准（渲染文案里明说）                           |

---

## 2. 数据模型与 Zod schema

`src/domain/schema.ts` 新增（放在「外传」之后、「章节摘要」之前）：

```ts
// ---------------------------------------------------------------- 写作规范

/**
 * 规范的作用范围。按任务组划分而不是直接存 TaskKind：同组任务对规范的需求一致，
 * 5 个开关在窄屏最多换一行。翻译刻意不在其中 —— 忠实优先，规范会诱导模型「修正」原文。
 */
export const WritingNormScopeSchema = z.enum([
  'writing',
  'planning',
  'summary',
  'extract',
  'check',
]);
export type WritingNormScope = z.infer<typeof WritingNormScopeSchema>;

/**
 * 作品级写作规范：作者给本作定下的创作约束与项目说明。
 * 作者原文直接落库，不走提案管道（不是 AI 产出，见产品文档 5.1）。
 * content 不做 trim：存什么就是什么，渲染进 prompt 时才去首尾空白。
 */
export const WritingNormSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  title: z.string().trim().min(1, '规范标题不能为空').max(60, '规范标题不能超过 60 字'),
  content: z
    .string()
    .max(60_000, '单份规范不能超过 60000 字')
    .refine((value) => value.trim().length > 0, '规范正文不能为空'),
  enabled: z.boolean().default(true),
  scopes: z
    .array(WritingNormScopeSchema)
    .default(['writing', 'planning', 'summary', 'extract', 'check']),
  order: z.number().int().nonnegative().default(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type WritingNorm = z.infer<typeof WritingNormSchema>;
```

数字常量在 schema 里以字面量写，理由是避免循环引用：`src/domain/writingNorm.ts` 要从 `schema.ts` 引入 `WritingNorm` / `WritingNormScope`，`schema.ts` 若反过来引入它的常量就形成 `writingNorm.ts ↔ schema.ts` 循环（`schema.ts` 现在确实会引入运行时模块 `./importJob`，但那个模块不引用 `schema.ts` 的运行时值，见其 13 行注释）。现有 `SideStorySchema` 也是字面量。`writingNorm.ts` 导出同值常量供 UI 预检，单测断言两边一致。

`RepositorySnapshotSchema` 加 `writingNorms: z.array(WritingNormSchema).default([])`。不在 `superRefine` 里校验 `novelId` 指向快照内的作品：现有的条目、分类等表都不做这项检查，导出总是成套的，孤儿规范只是看不见、不会被注入（查询都按 `novelId`），不值得为它在恢复时整份拒绝。

不变量归属：

| 不变量                                                         | 归属                                      | 理由                                         |
| -------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| 标题 1–60 字、正文非空且 ≤ 60000 字、作用范围取值合法          | Zod schema（仓储写入 + 备份导入都 parse） | 备份是绕过 UI 的入口，只能在 schema 守       |
| 作用范围去重、按固定顺序存                                     | 仓储（`normalizeNormScopes`）             | 让同样的选择存成同样的数组，备份 diff 稳定   |
| `id` / `novelId` / `createdAt` / `order` 不可经 update 修改    | 仓储（`stripProtected` + 显式删 `order`） | 与 `updateSideStory` 相同                    |
| 顺序只经 `reorderWritingNorms` / `saveCondensedWritingNorm` 改 | 仓储                                      | 排序要整批写，散在 update 里会出现重复 order |
| 精简另存与停用原文同成同败                                     | 仓储事务                                  | 半成功会出现两份同时注入或一份都不注入       |
| 注入时的过滤与排序                                             | `normsInScope`（domain）                  | 所有任务共用一个入口，字节稳定只靠这一处     |
| 正文原样保存                                                   | 仓储不 trim；UI 直接传 textarea 的值      | 原则「原文直接落库」                         |

---

## 3. Dexie v6 升级

`src/data/dexie/db.ts`：

```ts
writingNorms!: Table<WritingNorm, string>;
...
/**
 * v6：作品级写作规范。
 * 只新增表、不碰已有表，所以没有 upgrade 回调 —— 已有数据库打开时 Dexie 自动补建。
 * 不加 [novelId+order] 复合索引：一本书的规范是个位数到几十份，取出来在内存里排序即可，
 * 与 sideStories 的做法一致。
 */
this.version(6).stores({
  writingNorms: 'id, novelId',
});
```

**为什么只新增表是安全的**：Dexie 对未在新版本 `stores` 里出现的表保持原定义；不写 `upgrade` 就不会遍历任何旧行。旧表的数据、索引都不动，失败面只有「建一张空表」。读取路径不 parse，但新表没有旧行，不存在 v3/v5 那种「旧行缺字段」的问题。

---

## 4. 仓储接口

`src/data/NovelRepository.ts` 新增一节：

```ts
// ------------------------------------------------ 写作规范
/** 按 order、createdAt、id 排序 */
listWritingNorms(novelId: string): Promise<WritingNorm[]>;
/** 排在已有规范之后（max(order) + 1）。content 原样保存，不 trim */
createWritingNorm(
  novelId: string,
  input: { title: string; content: string; enabled?: boolean; scopes?: WritingNormScope[] },
): Promise<WritingNorm>;
/** 只改这四项；身份、排序、创建时间由仓储掌管。不存在时抛错 */
updateWritingNorm(
  id: string,
  patch: Partial<Pick<WritingNorm, 'title' | 'content' | 'enabled' | 'scopes'>>,
): Promise<WritingNorm>;
/** 不存在时静默返回 */
deleteWritingNorm(id: string): Promise<void>;
/** orderedIds 必须恰好是本书全部规范的 id；按数组下标重写 order */
reorderWritingNorms(novelId: string, orderedIds: string[]): Promise<void>;
/**
 * AI 精简的落库入口：在原规范之后插入一份新规范（沿用作用范围、启用），
 * 并停用原规范。一个事务，同成同败；原规范正文不变
 */
saveCondensedWritingNorm(
  sourceId: string,
  input: { title: string; content: string },
): Promise<WritingNorm>;
```

`DexieNovelRepository` 实现要点：

| 方法                       | 实现                                                                                                                                                                                                                                                                                                                                                                                      | 失败条件 → 调用方收到                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `listWritingNorms`         | `where('novelId')` + `compareNorms` 排序                                                                                                                                                                                                                                                                                                                                                  | 无                                                                                               |
| `createWritingNorm`        | `rw` 事务内读同书规范算 order，`WritingNormSchema.parse` 后 `add`                                                                                                                                                                                                                                                                                                                         | 输入不合法 → `ZodError`（UI 先用同值常量预检，这只是兜底）                                       |
| `updateWritingNorm`        | `rw` 事务：读 → `stripProtected` → 删 `order`/`updatedAt` → 规范化 scopes → parse → put                                                                                                                                                                                                                                                                                                   | 不存在 → `Error('这份写作规范已不存在，可能已被删除')`；不合法 → `ZodError`                      |
| `deleteWritingNorm`        | `delete(id)`                                                                                                                                                                                                                                                                                                                                                                              | 无（幂等）                                                                                       |
| `reorderWritingNorms`      | `rw` 事务：读同书全部 `rows`，`rowIds = new Set(rows.map((r) => r.id))`；校验 `orderedIds.length === rows.length && new Set(orderedIds).size === rows.length && orderedIds.every((id) => rowIds.has(id))`，不满足 → 抛错不写（不先去重：`[a, a, b]` 去重后会误判为合法，a 被写两次、order 不再是 0..n-1）；满足则按数组下标 `bulkPut` 新 `order = 0..n-1`，order 变了的才更新 `updatedAt` | 校验不通过（重复 id、缺 id、多出不属于本书的 id）→ `Error('规范列表已变化，请刷新后再调整顺序')` |
| `saveCondensedWritingNorm` | `rw` 事务：读源规范与同书全部规范；按 `compareNorms` 排序；在数组中源规范的下标之后插入新规范（`scopes = source.scopes`、`enabled = true`）；源规范 `enabled = false`；对整本书的规范按数组下标重写 `order = 0..n-1`（变了的才更新 `updatedAt`），一次 `bulkPut`。不用「`order > source.order` 的 +1」：合并导入备份后同书可能有重复 `order`，那种写法保证不了新规范紧跟源规范            | 源不存在 → `Error('这份写作规范已不存在，可能已被删除')`；不合法 → `ZodError`                    |

另外三处：`deleteNovel` 的表列表和 `Promise.all` 加 `writingNorms`；`exportSnapshot` 加 `writingNorms` 读出；`importSnapshot` 的表列表与 `bulkPut` 加 `writingNorms`（覆盖模式会一并 clear）。

日志：仓储不打日志（现有仓储都不打），错误以异常抛给 UI，UI 用 `role="alert"` 显示 `cause instanceof Error ? cause.message : '保存失败'`。ZodError 的 message 是 JSON，所以 UI 在调仓储前用 `validateNormDraft`（domain，新增，返回第一条中文错误或 undefined）预检，正常操作走不到 ZodError。

---

## 5. 备份

`src/features/export/backup.ts`：`BACKUP_VERSION = 3`，注释补一行：

> v3：加入写作规范（`writingNorms`）。必须升版本，理由与 v2 相同：旧版应用的 `z.object` 会悄悄丢掉未知的 `writingNorms`，恢复「成功」但规范全没了。v1 / v2 文件照常能读，`writingNorms` 默认为空。

兼容链条：`parseBackup` 先看文件头，`version > 3` 报「来自更新版本」；`version ∈ {1,2,3}` 都走 `BackupFileSchema`，`writingNorms` 缺省为 `[]`。旧应用（BACKUP_VERSION = 2）读到 v3 文件时报「来自更新版本」，不会静默丢数据。`summarizeBackup` 不变（规范不计入书架统计）。

---

## 6. 领域函数与渲染

### 6.1 `src/domain/writingNorm.ts`（新增）

```ts
export const NORM_SCOPES: { id: WritingNormScope; label: string; hint: string }[] = [
  { id: 'writing', label: '写正文', hint: '整章生成、段落续写 / 改写 / 扩写' },
  { id: 'planning', label: '规划', hint: '一句话立项、细化大纲' },
  { id: 'summary', label: '章节摘要', hint: '标记完成后的摘要与伏笔' },
  { id: 'extract', label: '提取设定', hint: '导入旧稿与世界观设定时的反向提取' },
  { id: 'check', label: '检查', hint: '章节编辑器里的「按规范检查」' },
];
export const ALL_NORM_SCOPES: WritingNormScope[]; // NORM_SCOPES 的 id 顺序
export function normalizeNormScopes(scopes: readonly WritingNormScope[]): WritingNormScope[]; // 去重 + 按 ALL_NORM_SCOPES 顺序
/** 排序键：order → createdAt → id（按码元比较，不用 localeCompare，避免依赖运行环境的区域设置） */
export function compareNorms(a: WritingNorm, b: WritingNorm): number;
/** 注入过滤的唯一入口：enabled && scopes 含 scope && 正文非空 && 不在 excludedIds；返回排好序的新数组 */
export function normsInScope(
  norms: readonly WritingNorm[],
  scope: WritingNormScope,
  excludedIds?: ReadonlySet<string>,
): WritingNorm[];
export function countLinks(content: string): number; // /https?:\/\/\S+/gu 的匹配数
/**
 * 精简版标题。按 UTF-16 码元计长度，与 schema 的 z.string().max(60) 口径一致：
 *   const suffix = '（精简）';
 *   return title.length + suffix.length <= NORM_TITLE_MAX
 *     ? title + suffix
 *     : title.slice(0, NORM_TITLE_MAX - suffix.length) + suffix;
 */
export function condensedTitle(title: string): string;
export function validateNormDraft(draft: { title: string; content: string }): string | undefined;
export const NORM_TOKEN_WARN,
  NORMS_TOTAL_TOKEN_WARN,
  NORM_LINK_WARN,
  NORM_CONTENT_MAX,
  NORM_TITLE_MAX;
export const DIFF_NOTE_TITLE, DIFF_NOTE_TEMPLATE;
```

### 6.2 `src/prompt/sections.ts` 新增

```ts
const NORM_SCOPE_USAGE: Record<WritingNormScope, string> = {
  writing: '写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。',
  planning: '规划世界观、人物与大纲时同样遵守这些约束；规范本身不是需要生成的设定。',
  summary:
    '提炼摘要时据此区分正文里已经确认的事实与仅属建议的内容；规范本身不是正文，不要写进摘要或伏笔。',
  extract:
    '提取时遵守其中关于命名、合并与信息限定的规则。规范本身不是待提取的正文，不要从规范里提取条目、摘要或伏笔。',
  check: '审读时逐条对照这些规范，找出正文可能违反之处。规范之外的问题不在本次范围内。',
};

/**
 * 一份规范的 prompt 片段。标题已在 schema 里 trim；正文只去首尾空白，内部原样。
 * 用成对的【规范《…》】/【规范《…》结束】而不是「## 标题」包住：作者的规范和 AI 精简结果
 * 本身就带 Markdown「## 」小节，用 ## 分隔时模型分不清「两份规范」和「一份规范的两个小节」，
 * 按规范检查回填的规范名也会抄成小节标题。【…】在现有提示词里只用作段落标题，
 * 带「规范《」前缀与「结束」后缀的组合不会和作者正文、差异说明模板的【字段】撞上。
 */
export function renderNormBlock(norm: Pick<WritingNorm, 'title' | 'content'>): string {
  return `【规范《${norm.title}》】\n${norm.content.trim()}\n【规范《${norm.title}》结束】`;
}

/**
 * token 估算的唯一口径：对渲染后的块估算（含首尾分隔行）。知识库列表、编辑面板（用草稿）、
 * 注入 chip、合计提示、构建器 item.tokens、NORM_TOKEN_WARN 比较一律用它，
 * 保证同一份规范在任何地方显示的数一致
 */
export function normTokens(norm: Pick<WritingNorm, 'title' | 'content'>): number {
  return estimateTokens(renderNormBlock(norm));
}

/** 规范段落的组装，构建器与 writingNormsSection 共用，保证两条路径逐字节一致 */
export function composeNormsSection(scope: WritingNormScope, blocks: string[]): string {
  if (blocks.length === 0) return '';
  return [
    '【作者的写作规范】',
    '以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。',
    NORM_SCOPE_USAGE[scope],
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/** 非构建器任务用：过滤 + 排序 + 渲染。没有可注入的规范时返回空串（composeSections 会跳过） */
export function writingNormsSection(
  norms: readonly WritingNorm[] | undefined,
  scope: WritingNormScope,
): string {
  return composeNormsSection(scope, normsInScope(norms ?? [], scope).map(renderNormBlock));
}
```

渲染示例（两份规范，作用于写正文）：

```text
【作者的写作规范】
以下是作者为本作定下的创作约束与项目说明，必须遵守。设定资料描述「这个世界能发生什么」，这里规定「本作选择发生什么」；两者冲突时以这里为准。
写作时把这些约束落实到情节与人物行为里，不要在正文中复述或提及规范本身。

【规范《给写作网站的使用提示》】
## 写作规则
- 以已导入资料为原作基线，以本作当前时期为准。
…
【规范《给写作网站的使用提示》结束】

【规范《本作差异说明》】
【原作版本】…
【规范《本作差异说明》结束】
```

块与块之间仍以一个空行（`\n\n`）相连。正文内部的 `## ` 小节原样保留，不再承担分隔职责。`sections.ts` 需新增 `import { estimateTokens } from '@/context/tokens'`（`tokens.ts` 是无依赖的纯函数模块，不会形成循环）。

**逐字节稳定的保证**：输入只有规范的 `title`、`content`、`order`、`createdAt`、`id` 和固定文案；不含时间戳、token 数、对象键遍历；排序是全序（id 兜底）；过滤与排序只在 `normsInScope` 一处。无规范时 `writingNormsSection` 返回 `''`，`composeSections` 的 `filter(length > 0)` 把它跳过，拼出来的字符串与改动前相同；构建器里 `normBlocks` 为空时不 push，`items` 也不多一项。

### 6.3 构建器改动（`src/context/ContextBuilder.ts`、`SummaryChainContextBuilder.ts`）

`ContextRequest` 加：

```ts
/** 作品的全部写作规范；构建器只取启用且作用范围含「写正文」的。不传等同于没有规范 */
writingNorms?: WritingNorm[];
/** 本次临时不注入的规范 id（生成面板里取消勾选），不影响库里的启用状态 */
excludedNormIds?: string[];
```

`ContextItemKind` 加 `'norm'`。`build` 中在 `meta+style` 之后、`pinned` 之前插入：

```ts
// 写作规范：作者定下的约束，与风格档案同属整本书的底色，放在核心设定之前，
// 这样确认新的核心设定不会让规范失去缓存。不参与预算裁剪，和核心设定同理
const norms = normsInScope(
  request.writingNorms ?? [],
  'writing',
  new Set(request.excludedNormIds ?? []),
);
const normBlocks: string[] = [];
for (const norm of norms) {
  const text = renderNormBlock(norm);
  // tokens 用 normTokens，与知识库、picker 同口径（等于 estimateTokens(text)）
  const taken = take(
    { kind: 'norm', id: norm.id, label: `写作规范 · ${norm.title}`, tokens: normTokens(norm) },
    text,
    true,
  );
  if (taken) normBlocks.push(taken);
}
const normsText = composeNormsSection('writing', normBlocks);
if (normsText) stableParts.push(normsText);
```

类注释里的装箱顺序改为「1 作品信息 → 2 风格档案 → 3 写作规范 → 4 核心设定 → 5 勾选的关联条目」。规范在稳定前缀里，主线与外传章节共用，不受 `track` 影响。

### 6.4 其他四个提示词构造函数

签名都加一个**可选的尾参数**，不改已有参数，现有调用与测试不用动：

- `buildSummarySystemPrompt(novel: Novel, norms?: readonly WritingNorm[])` → `[开场白, novelMetaSection(novel), writingNormsSection(norms, 'summary'), SUMMARY_TASK]`
- `buildExtractSystemPrompt(novel, categories, norms?)` → `[开场白, novelMetaSection, writingNormsSection(norms, 'extract'), EXTRACT_TASK, ...categoryGuides]`
- `buildExpandSystemPrompt(novel, style, norms?)` → `[开场白, composeStylePrefix, writingNormsSection(norms, 'planning'), EXPAND_TASK]`
- `buildSetupSystemPrompt(novel, style, worldCategory, characterCategory, norms?)` → `[开场白, composeStylePrefix, writingNormsSection(norms, 'planning'), SETUP_TASK, 字段说明 ×2]`

调用处在发请求前从仓储读最新值（与这些地方已经在调用时读 `getSideStory` / `listEntries` 的做法一致，避免用组件里拿到的旧数据）：

| 调用处                                        | 改动                                                                                              | 读取失败                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `ChapterSummarySheet.tsx` 的 `generateRef`    | `const norms = await repository.listWritingNorms(data.novel.id)`，传给 `buildSummarySystemPrompt` | 走现有 `catch`，面板显示错误（与模型失败同一条路径），不生成提案 |
| `ImportScreen.tsx` 的 `extractOne`            | 与 `listEntries` 放进同一个 `Promise.all`                                                         | 抛错 → 现有 `runLoop` 把这一章标失败、可单章重试                 |
| `ImportScreen.tsx` 的 `extractWorldviewChunk` | 同上                                                                                              | 同上，这一段标失败                                               |
| `OutlineNodeSheet.tsx` 的 `runExpand`         | 调用前读                                                                                          | 走现有 `catch` → `expand` 错误态                                 |
| `SetupSection.tsx` 的 `generate`              | 调用前读                                                                                          | 走现有 `catch` → 错误态                                          |

提取每章重读规范：作者可能在提取途中改了规范，下一章应按新规范；没改时前缀不变，缓存照常命中。

---

## 7. 知识库页 UI

### 7.1 `WritingNormsSection`（新增，`src/features/knowledge/WritingNormsSection.tsx`）

`KnowledgePage.tsx` 在 `<StyleSection novel={novel} />` 之后插入 `<WritingNormsSection novel={novel} />`。区块自己 `useRepoQuery((repo) => repo.listWritingNorms(novel.id), [novel.id])`，与 `StyleSection` 同构。

- `Section` 标题「写作规范」，描述「作者给本作定下的创作约束与项目说明：时间截面、与原作的差异、提取规则等。原文保存，按作用范围进入 AI 提示词。」，`action` 是「新建」按钮。
- 空状态（`EmptyState`）：标题「还没有写作规范」，描述说明它和设定条目的区别（一句话），两个按钮「新建规范」「从文件新建」。
- 列表 `<ul>`，每份一行 `<li>`：
  - 左侧：标题按钮（点开编辑），下面一行元信息：`` `${formatTokens(normTokens(norm))} · ${scopeText}` ``，其中 `scopeText = normalizeNormScopes(norm.scopes).map((s) => NORM_SCOPES.find((x) => x.id === s)!.label).join('、')`，按 `NORM_SCOPES` 的固定顺序渲染、不写死。默认五项全开时示例为「约 1.2k tokens · 写正文、规划、章节摘要、提取设定、检查」；停用时元信息前缀「已停用 · 」并整行降为 `text-ink-300`；作用范围为空时显示「未选作用范围，不会进入提示词」；超过 `NORM_TOKEN_WARN` 时追加「较长」标记（`text-seal`）。
  - 右侧：`<Toggle label="启用" ariaLabel={`启用《${norm.title}》`} tapTarget … />`（`Toggle` 的两个新可选 prop 见 7.4）、`IconButton` 上移 / 下移（`ArrowUpIcon` / `ArrowDownIcon`，label `上移《标题》` / `下移《标题》`，首行无上移、末行无下移时 `disabled`）。
  - 窄屏：一行 `flex-wrap`，标题区占满一行，控件换到第二行右对齐；`md` 起同一行。控件都是 44px 触控目标：`IconButton` 已带 `tap-target`；`Toggle` 用新 `tapTarget` 选项；标题按钮加 `tap-target` 与 `text-left`。单套 DOM，无断点分叉渲染。
- 列表下方：「从文件新建」按钮 + 隐藏的 `<input type="file" accept={ACCEPTED_EXTENSIONS.join(',')} aria-label="规范文件">`。
- 合计提示：合计 = `normsInScope(norms, 'writing').reduce((s, n) => s + normTokens(n), 0)`，超过 `NORMS_TOTAL_TOKEN_WARN` 时，列表上方一行 `text-seal` 提示「启用中的写正文规范合计约 X tokens，每次生成都会带上。可以停用不常用的，或试试 AI 精简。」
- 启用切换、上下移直接调 `updateWritingNorm` / `reorderWritingNorms` 后 `invalidate()`；失败时在区块内 `role="alert"` 显示错误。

「从文件新建」：`readManuscriptFile(file)` → 成功则打开编辑面板（新建态），预填标题 = 文件名去扩展名（截到 60 字），正文 = `result.text`，面板顶部显示 `已读入《文件名》，识别为 {ENCODING_LABELS[encoding]}`，`lossy` 时加「其中少量字符无法识别，已用 � 占位」。**此时不写库**，作者点保存才落库。失败：`ManuscriptReadError` 的 message（扩展名、空文件、超 20MB、无可读文字）显示在区块 alert；解码后长度 > `NORM_CONTENT_MAX` 时显示「这个文件有 N 字，超过单份规范 60000 字的上限，可以拆成几份」。都可恢复，不写库。

### 7.2 `WritingNormEditorSheet`（新增，`src/features/knowledge/WritingNormEditorSheet.tsx`）

`Sheet`（默认 `drawer`：窄屏底部抽屉、宽屏右侧抽屉），标题「新建写作规范」/「编辑写作规范」，`footer` 是「保存」主按钮。打开时（关 → 开那一刻）用 ref 重置草稿，与 `StyleSheet` 同样的防冲刷写法。

内容自上而下：

1. （可选）文件读入提示行。
2. `TextField` 标题。
3. `TextAreaField` 正文，`rows={12}`，`hint` 实时显示 `formatTokens(normTokens({ title: draft.title, content: draft.content }))`（与列表、注入清单同一口径，保存后数字不跳），以及两条可能的提示（`normTokens(draft) > NORM_TOKEN_WARN`；`countLinks > NORM_LINK_WARN` 时，文案逐字为 `其中有 ${n} 个链接。来源表通常不必进提示词，可以删掉或试试 AI 精简。`，与需求 FR11 / 验收 21 的字面量一致）。
4. 一行次要按钮：「上传文件追加」（读入后以 `\n\n` 追加到正文末尾，与导入页的多文件追加相同）、「插入差异说明模板」（规则见 1.6）。
5. 作用范围（`NORM_SCOPES`，多选）。**不用、也不改**共享的 `ChipGroup`（`src/ui/Controls.tsx`，按钮 `px-3 py-1.5 text-sm` 约 32px 高，改它会影响分类、子类等所有现有用处），而是在 `WritingNormEditorSheet` 内照 `ChipGroup` 的结构写一个本地 `fieldset`：legend「作用范围」，hint 写每项覆盖的任务（取 `NORM_SCOPES[].hint`，拼成一行「写正文：整章生成、段落… · 规划：…」），5 个 `<button type="button" aria-pressed>`，类名同 `ChipGroup` 的按钮再加 `tap-target inline-flex items-center`。
6. `Toggle` 启用。
7. AI 精简区（仅编辑已有规范时显示）：说明一句「把长文压成约束条目，去掉来源链接等不需要进提示词的内容。结果确认后另存为新规范，原文保留并停用。」；按钮「AI 精简」（`!llm.configured` 或有未保存修改时禁用，并显示原因）；进行中显示流式文本与「停止」；完成后可编辑预览 +「另存为新规范（原文自动停用）」+「放弃」。
8. 编辑态底部 ghost 按钮「删除这份规范」→ `ConfirmDialog`（`destructive`，文案「删除后无法恢复。只删除这份规范，不影响已经写好的章节。」）。

保存：`validateNormDraft` 预检 → 新建调 `createWritingNorm(novel.id, { title, content, enabled, scopes })`，编辑调 `updateWritingNorm(id, {...})`；`content` 就是 textarea 的原值。成功后 `invalidate()` 并关闭；失败显示 alert、保持打开、草稿不丢。

### 7.3 `NormInjectionPicker`（新增，`src/features/writing/NormInjectionPicker.tsx`）

```ts
props: {
  norms: WritingNorm[] /* 调用方已按 scope 过滤（写正文面板传 'writing'，检查面板传 'check'） */;
  excludedIds: string[];
  onToggle: (id: string) => void;
  /** 默认「写作规范」；检查面板传「参与检查的规范」 */
  legend?: string;
}
```

`norms.length === 0` 时渲染 `null`。否则一个 `fieldset`，legend「{legend}（本次带上 X / N 份）」，hint「取消只影响这一次，不改知识库里的启用状态。」，每份一个 `aria-pressed` chip，文案 `标题（${formatTokens(normTokens(norm))}）`。视觉沿用 `GenerateChapterSheet` 里条目 chip 的类名，额外加 `tap-target inline-flex items-center`（原 chip 约 28px 高，达不到 44px）。不加 `scope` prop：调用方先过滤（写正文面板传 `normsInScope(norms, 'writing')`，检查面板传 `normsInScope(norms, 'check')`）。

### 7.4 `Toggle` 的两个可选 prop（`src/ui/Controls.tsx`）

```ts
/** 无障碍名。不传时沿用 <label htmlFor>（可见文字），与现在一致 */
ariaLabel?: string;
/** 为 true 时 label 与开关所在区域至少 44×44px；默认 false，现有用处的视觉不变 */
tapTarget?: boolean;
```

- `ariaLabel` 传给 `<input type="checkbox">` 的 `aria-label`。按无障碍名计算规则 `aria-label` 优先于关联的 `<label>`，所以列表里每行可见文字都是「启用」，读屏与 `getByRole('checkbox', { name: '启用《使用提示》' })` 却能区分。
- `tapTarget` 为 true 时：外层 `div` 由 `items-start` 改为 `items-center`；文字 `<label>` 加 `tap-target inline-flex items-center`；`<input>` 外包一层 `<label htmlFor={id} className="tap-target inline-flex items-center justify-center">`。用 `label` 而不是 `span` 包，是因为点 span 里 input 之外的空白不会切换，而一个 input 关联多个 label 是合法 HTML，整块 44×44 区域都可点。`ariaLabel` 存在时它决定无障碍名，多个 label 不会让名字变成「启用 启用」。
- 两个都不传时渲染结果与现在逐字节相同；现有用到 `Toggle` 的测试不改。

`GenerateChapterSheet`：在「本次注入」块之后、核心设定提示之前渲染；`excludedNormIds` 进 `preview` 的 `useMemo` 依赖与 `generate()` 的 `build` 参数。`ReviseSheet`：在「临时换个笔法」之前渲染；打开时随其他状态一起重置。两个 sheet 与 `ChapterEditorScreen` 的 `context` 类型的 `Omit` 里加上 `'excludedNormIds'`。

---

## 8. 边界情况

- **规范在生成面板打开时被删或停用**：`WritingPage` 的查询在 `invalidate` 后刷新，`context.writingNorms` 变化，`preview` 重算；`excludedNormIds` 里指向已不存在规范的 id 被 `normsInScope` 自然忽略。
- **作用范围为空**：合法，等同于不注入任何任务；列表明确提示。
- **规范超大（数万 tokens）**：不被预算裁剪，后面的勾选条目会被挤出并显示在「因超出预算未注入」里；同时有单份与合计提示。
- **两个标签页同时改顺序**：`reorderWritingNorms` 的集合校验挡住「另一处刚新建或删除」的情况；同一集合的并发重排以后写为准，与大纲重排一致。
- **备份合并导入同 id 规范**：以备份为准（`bulkPut`），与其他表一致。
- **粘贴来的 `\r\n`**：浏览器的 textarea 值已统一为 `\n`；文件经 `normalizeManuscript`。两条路径进库的都是 `\n`。
- **规范里写了类似【任务】的段落标题**：作者自己的文字，本来就是要影响模型；不做转义。
- **规范正文里恰好出现「【规范《X》结束】」或标题含书名号**：不转义、不拒绝。作者主动写出这种文字的概率很低，后果只是模型对边界的理解变模糊，不影响数据；标题含 `》`（如「《某作》改编说明」）时，`resolveCheckIssues` 同时用原样和剥一层书名号两种候选去匹配，模型照抄标题仍能全等匹配。
- **提取时规范被模型当成正文**：提取作用范围的固定文案明确禁止；单测断言该句存在。
- **外传**：规范在稳定前缀，外传与主线一致；外传不需要另一套规范（外传简介已能写时期差异）。
- **只有标题没有正文**：schema 拒绝，UI 预检提示「规范正文不能为空」。
- **AI 精简过程中关闭面板**：`AbortController` 取消，什么都不写；与 `GenerateChapterSheet` 一致。
- **AI 精简后原规范又被启用**：作者的选择，两份同时注入；列表能看到两份都启用。
- **检查时正文还在防抖保存中**：检查用编辑器里的当前 `content`（与摘要面板同理），不依赖已落盘的版本。
- **检查返回的 quote 在正文里出现多次**：`locateQuote` 取第一次出现；卡片照常显示原句，作者能自己判断。
- **检查返回的 normTitle 对不上**：保留并标「规范名未对应」（见 1.7.2）。
- **检查中途关闭面板**：`AbortController` 取消，丢弃本次结果，之前那次结果（若有）保留。
- **检查过程中作者继续打字**：结果的 `checkedContent` 是发请求时的正文，完成后立即显示过期提示。

---

## 9. 错误处理汇总

| 操作              | 失败条件                                                                                 | 可恢复                             | 调用方收到 / 界面                                                                                                                        | 日志   |
| ----------------- | ---------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 新建 / 保存规范   | 校验失败                                                                                 | 是                                 | 预检文案（标题空、正文空、超长）；兜底显示异常 message                                                                                   | 无     |
| 保存已删除的规范  | 不存在                                                                                   | 是                                 | 「这份写作规范已不存在，可能已被删除」                                                                                                   | 无     |
| 读文件            | 扩展名、空、超 20MB、无文字、超 60000 字                                                 | 是                                 | 区块或面板内 alert，不写库                                                                                                               | 无     |
| 启用切换 / 排序   | 不存在 / 集合不一致                                                                      | 是                                 | 区块内 alert，列表随刷新回到库里状态                                                                                                     | 无     |
| 删除              | —                                                                                        | —                                  | 幂等                                                                                                                                     | 无     |
| AI 精简           | 未配置模型                                                                               | 是                                 | 按钮禁用 +「需要先在『设置』里配置模型」                                                                                                 | 无     |
| AI 精简           | `LlmError`（网络、鉴权、限流）                                                           | 是                                 | 面板 alert 显示 `LlmError.message`，回到编辑态，不写库                                                                                   | 无     |
| AI 精简           | 用户停止                                                                                 | 是                                 | 已流出的内容进入预览（与整章生成一致），为空则回到编辑态                                                                                 | 无     |
| AI 精简           | 空输出                                                                                   | 是                                 | 「模型没有返回内容，可以再试一次」                                                                                                       | 无     |
| AI 精简           | `finishReason === 'length'`                                                              | 是                                 | 预览上方提示可能被截断，仍可编辑后保存                                                                                                   | 无     |
| 另存精简版        | 源规范不存在 / 校验失败                                                                  | 是                                 | alert，预览内容保留                                                                                                                      | 无     |
| 按规范检查        | 无「检查」规范 / 未配置模型 / 正文为空                                                   | 是                                 | 入口 `aria-disabled`，点击显示原因                                                                                                       | 无     |
| 按规范检查        | 某段 `finishReason === 'length'`                                                         | 是                                 | `LlmError('truncated')` → 整次失败，「第 i/K 段检查失败：模型输出被截断，检查结果不完整」+ 精简规范的建议 + 「重新检查」；不显示部分结果 | 无     |
| 按规范检查        | `LlmError`（网络、鉴权、限流、解析失败重试后仍不合 schema）                              | 是                                 | 同上，整次失败，显示 message                                                                                                             | 无     |
| 按规范检查        | 用户停止 / 关闭面板                                                                      | 是                                 | 丢弃本次，保留上一次结果                                                                                                                 | 无     |
| 定位 / 按建议改写 | 按钮按 `checkedContent` 显示，点击时用当前 `content` 重新定位返回 null（检查后原句被改） | 是                                 | 卡片内 `role="status"` 提示「这段原文已被修改，找不到了」，不关面板、不改选区、不打开改写                                                | 无     |
| 各任务读取规范    | IndexedDB 读失败                                                                         | 是                                 | 走各任务现有的失败路径（见 6.4 表）                                                                                                      | 无     |
| 备份恢复          | 规范行非法                                                                               | 是                                 | `BackupError`「备份文件的内容不符合预期」+ 路径                                                                                          | 无     |
| Dexie 打开 v6     | 建表失败                                                                                 | 致命（与现有任何版本升级失败相同） | 应用现有的数据库打开错误处理                                                                                                             | 不新增 |

应用当前没有通用日志通道（诊断相关文件在范围外，不改），所以上表都是「无」，与现有功能一致。

---

## 10. 需要更新的文档

- `docs/产品文档.md`
  - 6.2 在「风格档案」之后加「**写作规范**」：是什么（作品级约束与项目说明，多份、启用、作用范围、排序）；**为什么不是世界观条目**（文档 02 那句：条目告诉模型这个世界能发生什么，规范告诉它这本书选择发生什么；不拆分、不合并、不提取）；**为什么不是文风**（文风管句式语感，额外写作要求是短句约束）；**为什么原文直接保存**（作者的文字不是 AI 产出，5.1）；**为什么翻译不带**；**为什么 AI 精简另存而不替换**；差异说明模板与「为什么本期不结构化」。
  - 7 信息架构：知识库一行改为「一句话立项 · 设定条目 · 风格档案 · 写作规范 · 分类管理 · 导入旧稿 · 译名表 · 回收站」。
  - 9 第 2 条：「稳定内容（系统提示 + 风格档案 + 写作规范 + 核心设定 + 关联人物）」，补一句为什么规范排在核心设定之前。
  - 6.3 整章生成的注入清单描述补「哪几份写作规范」；外传段「为什么外传说明放在 prompt 尾部」里的前缀组成从「作品信息 + 风格 + 核心设定 + 勾选条目」改为「作品信息 + 风格 + 写作规范 + 核心设定 + 勾选条目」；新增「**按规范检查本章**」：入口、带哪些上下文、长章分段、截断即报错、结果只在会话内；**为什么只提示不自动改**（判断有误报、规范常有留白要作者裁决、自动改散文违背 5.1，采用建议走段落加工预览并进撤销栈）；为什么不保存结果（正文一改即过期）。
  - 5.1：把「唯一的例外是正文散文」改写为：「例外只有两类自由文本：**正文散文**，以及 **AI 精简后的写作规范**。后者没有字段结构，走『可编辑预览 → 另存为新规范 / 放弃』；另存不覆盖原文，原规范自动停用、正文不变。作者自己写、粘贴、上传的写作规范与一句话立项同理，不是 AI 产出，直接保存。『按规范检查』只在会话里展示提示、不写任何数据，所以不涉及确认管道；采用其中的建议走段落加工的可编辑预览。」
  - 7 信息架构「写作」一行：「章节编辑器（生成 / 加工 / 摘要）」改为「章节编辑器（生成 / 加工 / 摘要 / 按规范检查）」。
- `docs/使用说明.md`：5 知识库新增「5.5 写作规范」（新建、粘贴、上传、模板、作用范围、启用、排序、AI 精简、token 提示；想让提取遵守规范，先建规范再导入）；6.3 生成与加工补「写作规范可临时取消」；新增 **6.6「按规范检查」**（排在 6.5 外传之后；入口、三种严重程度、定位、按建议改写、忽略、过期提示、长章分段）；10 省钱与提速补「长规范用 AI 精简、收窄作用范围」；目录同步。
- `docs/世界观写作指南.md`：新增一小节「哪些内容写成写作规范，而不是世界观条目」（时间截面与冻结信息、与原作的差异及因果、信息分层、命名与合并规则、生成边界、创作方向说明；来源表不必进任何一方）；第 8 节提示词末尾加第 10 条：「约束性内容（时间截面、与原作的差异、提取与写作规则、边界说明）不要写进设定正文，另起一份『写作规范』文档单独输出，供作者在知识库『写作规范』里粘贴。」
- `docs/设计方案.md`（**建议项**，不在任务要求的文档清单里；实现计划里单列为最后一项，必做文档全部完成后再做，不挤占必做项）：7 实体要点加 `WritingNorm`；9 装箱表第 2、3 项之间插入「写作规范」；`RepositorySnapshot` 版本说明改为 3。

---

## 11. 文件级改动清单

| 文件                                                                 | 改动                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/schema.ts`                                               | `WritingNormScopeSchema`、`WritingNormSchema`、快照加 `writingNorms`                                                                                                                           |
| `src/domain/writingNorm.ts`（新增）                                  | 作用范围元数据、`normalizeNormScopes`、`compareNorms`、`normsInScope`、`countLinks`、`condensedTitle`、`validateNormDraft`、阈值常量、差异说明模板                                             |
| `src/data/NovelRepository.ts`                                        | 六个方法                                                                                                                                                                                       |
| `src/data/dexie/db.ts`                                               | `writingNorms` 表、v6                                                                                                                                                                          |
| `src/data/dexie/DexieNovelRepository.ts`                             | 六个方法；`deleteNovel` / `exportSnapshot` / `importSnapshot` 加表                                                                                                                             |
| `src/features/export/backup.ts`                                      | `BACKUP_VERSION = 3` 与注释                                                                                                                                                                    |
| `src/prompt/sections.ts`                                             | `renderNormBlock`（成对【规范《…》】分隔）、`normTokens`、`composeNormsSection`、`writingNormsSection`                                                                                         |
| `src/context/ContextBuilder.ts`                                      | `writingNorms`、`excludedNormIds`、`'norm'`                                                                                                                                                    |
| `src/context/SummaryChainContextBuilder.ts`                          | 规范注入与注释                                                                                                                                                                                 |
| `src/features/writing/WritingPage.tsx`                               | 查询加 `listWritingNorms`，传入 context                                                                                                                                                        |
| `src/features/writing/ChapterEditorScreen.tsx`                       | `context` 类型 `Omit` 加 `'excludedNormIds'`                                                                                                                                                   |
| `src/features/writing/GenerateChapterSheet.tsx`                      | `excludedNormIds` 状态 + picker + 只重置它的 `wasOpen` effect                                                                                                                                  |
| `src/features/writing/ReviseSheet.tsx`                               | 同上                                                                                                                                                                                           |
| `src/features/writing/NormInjectionPicker.tsx`（新增）               | 临时取消组件                                                                                                                                                                                   |
| `src/features/writing/chapterSummary.ts` / `ChapterSummarySheet.tsx` | 可选 `norms` 参数 / 调用时读取                                                                                                                                                                 |
| `src/features/import/extractSettings.ts` / `ImportScreen.tsx`        | 可选 `norms` 参数 / 两处调用时读取                                                                                                                                                             |
| `src/features/outline/outlineExpand.ts` / `OutlineNodeSheet.tsx`     | 可选 `norms` 参数 / 调用时读取 + 一行提示                                                                                                                                                      |
| `src/features/setup/projectSetup.ts` / `SetupSection.tsx`            | 可选 `norms` 参数 / 调用时读取 + 一行提示                                                                                                                                                      |
| `src/llm/taskProfiles.ts`                                            | `'norm-condense'`、`'norm-check'`                                                                                                                                                              |
| `src/llm/errors.ts`                                                  | `LlmErrorKind` 加 `'truncated'`                                                                                                                                                                |
| `src/llm/structured.ts`                                              | `StructuredOptions.failOnTruncation?`；为 true 时 `finishReason === 'length'` 抛 `truncated`                                                                                                   |
| `src/llm/useLlm.ts`                                                  | `StructuredRunOptions.failOnTruncation?` 透传                                                                                                                                                  |
| `src/context/SummaryChainContextBuilder.ts`                          | 另外把 `renderEntry` 改为 `export`（实现不变）                                                                                                                                                 |
| `src/features/writing/normCheck.ts`（新增）                          | schema、`locateQuote`、`resolveCheckIssues`、`splitChapterForCheck`、提示词构造                                                                                                                |
| `src/features/writing/NormCheckSheet.tsx`（新增）                    | 检查面板                                                                                                                                                                                       |
| `src/features/writing/ChapterEditorScreen.tsx`                       | 入口 pill、禁用原因、结果与忽略 state、定位（点击时按当前正文重新定位，失败给卡片内提示）、按建议改写；`reviseSeed` state，「按建议改写」设置、底栏「加工这一段」与 `ReviseSheet.onClose` 清空 |
| `src/features/writing/ReviseSheet.tsx`                               | 另加可选 `initialAction` / `initialInstruction`                                                                                                                                                |
| `src/features/knowledge/normCondense.ts`（新增）                     | 精简提示词                                                                                                                                                                                     |
| `src/features/knowledge/WritingNormsSection.tsx`（新增）             | 区块                                                                                                                                                                                           |
| `src/features/knowledge/WritingNormEditorSheet.tsx`（新增）          | 编辑面板 + AI 精简                                                                                                                                                                             |
| `src/features/knowledge/KnowledgePage.tsx`                           | 插入区块                                                                                                                                                                                       |
| `src/ui/Controls.tsx`                                                | `Toggle` 加可选 `ariaLabel`、`tapTarget`（不传时输出不变，见 7.4）；`ChipGroup` 不改                                                                                                           |
| `src/context/noNormsBaseline.test.ts`（新增）                        | 零变化基线，常量 + `toBe`，见 12.0                                                                                                                                                             |
| `src/test/writingNormFixtures.ts`（新增）                            | 端到端夹具                                                                                                                                                                                     |
| `src/test/llmFixtures.ts`                                            | `completion(content, options?)` 的 `options` 加可选 `finishReason?: string`，传入时输出 `choices[0].finish_reason`；不传时输出与现在完全相同（现有用例不受影响）                               |
| `src/context/SummaryChainContextBuilder.ts`                          | 另外把 `renderSummary` 改为 `export`（实现不变），供检查的前情块复用                                                                                                                           |
| 文档                                                                 | 见第 10 节                                                                                                                                                                                     |

不改：`src/features/settings/DiagnosticsSection.tsx`、`src/app/store/diagnostics.ts`、`src/app/store/useActiveNovel.ts`、`src/features/settings/SettingsPage.tsx`、`translate.ts` / `TranslateSheet.tsx`。

---

## 12. 测试计划

### 12.0 零变化基线（**实现的第一步，改任何源码之前**）

新建 `src/context/noNormsBaseline.test.ts`。**这个文件里禁止出现 `toMatchInlineSnapshot` / `toMatchSnapshot`**：快照在非 CI 环境下会被自动写入，后加的用例可能被改动后的输出填上，护栏就失效且不报错。只用常量 + `toBe` / `toEqual`。

步骤：

1. **在未改动的代码上**，用固定夹具（作品、风格档案含名家参考与非空 `extraInstruction`、两类分类、一条核心设定、一条普通条目、大纲节点、三章含摘要、一部外传）写一个一次性脚本（放在 `/tmp`，不进仓库）调用下列函数，把输出用 `JSON.stringify` 打印出来：
   - 构建器：`SummaryChainContextBuilder.build`（主线章节、外传章节各一次），取 `{ stablePrefix, volatileSuffix, items, estimatedTokens }`；
   - 系统提示：`buildChapterSystemPrompt`、`buildReviseSystemPrompt`（三种 action）、`buildSummarySystemPrompt`、`buildExtractSystemPrompt`、`buildExpandSystemPrompt`、`buildSetupSystemPrompt`；
   - 用户提示（NFR1 也要求用户提示不变）：`buildChapterUserPrompt`（`chapterDraft.ts`）、`buildReviseUserPrompt`（`revise.ts`，三种 action）、`buildSummaryUserPrompt`（`chapterSummary.ts`）、`buildExtractUserPrompt`（`extractSettings.ts`）、`buildExpandUserPrompt`（`outlineExpand.ts`）、`buildSetupUserPrompt`（`projectSetup.ts`）。
2. 把打印结果粘成字面量：`const BASELINE = { builderMain: {…}, builderSide: {…}, chapterSystem: \`…\`, reviseSystem_rewrite: \`…\`, …, setupUser: \`…\` } as const;`，并写一组用例 `expect(actual).toBe(BASELINE.x)`（构建器用 `toEqual`）。此时整份文件只依赖现有 API，在未改动代码上跑通。
3. 改代码后，同一文件为每个函数追加 4 种输入：不传规范、`[]`、`[停用的规范]`、`[作用范围不含该任务的规范]`，一律断言 `toBe(BASELINE.x)` / `toEqual(BASELINE.x)`。夹具里的规范写成**对象字面量**、只用 `import type { WritingNorm }`，不 import 任何新增的运行时模块；类型擦除后，这个文件在旧代码上也能跑（旧函数忽略多出来的参数，旧构建器忽略 `writingNorms` 字段），这正是交叉核对能成立的前提。
4. 之后 `BASELINE` 永不修改。若某条断言失败，修的是实现，不是字面量。

### 12.0b 交叉核对（审查必做）

```sh
CI=1 npx vitest --run src/context/noNormsBaseline.test.ts
cp src/context/noNormsBaseline.test.ts /tmp/myliterature-baseline-writing-norms/src/context/
ln -s "$PWD/node_modules" /tmp/myliterature-baseline-writing-norms/node_modules
(cd /tmp/myliterature-baseline-writing-norms && CI=1 npx vitest --run src/context/noNormsBaseline.test.ts)
```

两边都必须全绿：新代码上通过说明「无规范时零变化」，旧代码上通过说明 `BASELINE` 确实来自改动前。`CI=1` 禁止写入任何快照。核对完删除 `/tmp` 里拷入的测试文件与 `node_modules` 软链。

### 12.1 仓储（`src/data/dexie/DexieNovelRepository.test.ts` 追加）

- 新建：内容逐字符相同（含首尾空白、`## 标题`、空行）；默认启用、五项作用范围、order 递增。
- 修改四项；`id`/`novelId`/`createdAt`/`order` 改不动；不存在时报错；作用范围去重并按固定顺序存。
- 删除；删除作品级联。
- `reorderWritingNorms` 正常重排（order 为 0..n-1）；集合不一致时抛错且库里不变，分别覆盖：缺一个 id、多一个别书的 id、传入重复 id（三份规范 a、b、c，传 `[a, a, b]`）——三种都抛「规范列表已变化」，之后 `listWritingNorms` 的顺序与各行 `order`、`updatedAt` 与调用前完全相同。
- `saveCondensedWritingNorm`：新规范排在源之后、后面的顺延、沿用作用范围、启用；源停用且正文不变；源不存在时什么都不写。
- 迁移：仿照现有 v4 → v5 用例，原生 Dexie 声明到 v5 写入作品 / 章节 / 外传 / 译名表，用 `AppDatabase` 打开：`verno === 6`，旧数据逐字段不变，`listWritingNorms` 为空且能新建。
- 现有 `verno` 断言共三处，全部 `toBe(5)` → `toBe(6)`：1627 行（用例名「当前架构版本为 5」同步改为「为 6」）、1701 行与 1811 行（两个 v4 → v5 迁移用例里打开后的版本）。这些是版本号断言，不属于提示词断言，NFR8 不受影响。
- `saveCondensedWritingNorm` 在重复 order 下：手动写入三份 `order` 都为 0 的规范（A、B、C，按 createdAt 区分），精简 A → 结果顺序为 A、A（精简）、B、C，order 为 0..3。
- 新建时正文含 `【规范《X》结束】` 字样也原样保存（作者文字不做转义）。

### 12.2 备份（`src/features/export/backup.test.ts` 追加 / 更新）

- `BACKUP_VERSION` 为 3；「来自更新版本」的用例从 version 3 改为 version 4（不改会因为 3 已是当前版本而失败）。
- 「覆盖全部表」加 `writingNorms` 断言；往返一致性用例的种子数据加一份规范。
- v2 文件（含外传）覆盖恢复与合并导入：外传照旧，规范为空。
- v1 文件（无 `sideStories`、无 `writingNorms`）覆盖恢复与合并导入各一例：`listWritingNorms` 为空，其余数据照旧。
- 被拒的文件（`BackupError`，库里不变），`detail` 以对应路径开头：
  - 规范标题为空 → `data.writingNorms.0.title`；
  - 正文只有空白（`content = '  \n '`）→ `data.writingNorms.0.content`；
  - 作用范围含非法值 → `data.writingNorms.0.scopes`。

### 12.3 领域与渲染（`src/domain/writingNorm.test.ts`、`src/prompt/sections.test.ts`）

- `normsInScope`：停用、作用范围外、在排除集合里的被滤掉；乱序输入按 order → createdAt → id 输出。
- `normalizeNormScopes`、`countLinks`、`condensedTitle`（超长截断）、`validateNormDraft`；常量与 schema 字面量一致（用 schema 校验边界值）。
- 模板包含九个【】字段；不含任何特定作品专名（断言不含夹具外的几个已知专名，如「喰种」「CCG」「金木」）。
- `writingNormsSection`：无可注入规范时 `''`；五种 scope 的用法行各不相同；extract 含「不要从规范里提取条目」；两次调用相同。
- `renderNormBlock`：输出为 `【规范《T》】\n{正文 trim}\n【规范《T》结束】`；正文首尾空白被去掉、内部空行与 `## ` 原样。
- 分隔不冲突：两份正文都含 `## 小节一` / `## 小节二` 的规范经 `writingNormsSection` 渲染后，`match(/【规范《[^》]*》】\n/g)` 恰好 2 个、`match(/【规范《[^》]*》结束】/g)` 恰好 2 个，且按开始标记切出的两段各自包含自己的两个小节。
- `normTokens(norm) === estimateTokens(renderNormBlock(norm))`。
- `condensedTitle`：56 字标题 → 原标题 + 「（精简）」（60 字）；57 字 → 截成 56 字 + 后缀（60 字）；60 字 → 截成 56 字 + 后缀；结果都能通过 `WritingNormSchema` 的标题校验。

### 12.4 上下文构建（`src/context/SummaryChainContextBuilder.test.ts` 追加）

- 启用且含 `writing` 的规范在 `stablePrefix` 中，位于 `composeStylePrefix(novel, style)` 输出的末尾之后（断言 `stablePrefix.startsWith(composeStylePrefix(...))` 且规范块的 `indexOf` 大于其长度）、【必须遵守的核心设定】之前。用这个锚点而不是「【文风】」：`voiceSection` 为空时没有【文风】段。夹具同时让风格档案的 `extraInstruction` 非空，确保【文风】段存在、再断言规范在它之后。停用的、只含 `extract` 的不出现。
- 两份规范按 order 注入，与传入顺序无关；两次 `build` 的 `stablePrefix` / `volatileSuffix` 相同。
- `items` 含 `kind: 'norm'`、label、`tokens === normTokens(norm)`；`excludedNormIds` 后 prompt 与 items 都没有它。
- 小预算下规范仍然 `included`，勾选条目被挤出并有 `droppedReason`。
- 外传章节与主线章节 `stablePrefix` 相同（含规范）。

### 12.5 各任务提示词

- `extractSettings.test.ts`：作用范围含 extract 时带规范与禁止提取的那句；不含时不带。
- `chapterSummary.test.ts`、`outlineExpand`（新增测试文件或在现有 `outlineTree.test.ts` 旁新建 `outlineExpand.test.ts`）、`projectSetup.test.ts`：对应 scope 带上、不对应不带上。
- 翻译：`buildTranslateSystemPrompt` 签名不变，`ImportScreen` 翻译请求断言不含夹具文本（见 12.7）。

### 12.6 UI（`src/features/knowledge/WritingNormsSection.test.tsx` 新增，`createTestHarness` + `harness.renderUI(<KnowledgePage />)`，`useActiveNovel.setState`）

- 新建：填标题、`user.paste` 正文、保存 → 列表出现、库里正文逐字相同。
- 从文件新建：`user.upload(screen.getByLabelText('规范文件'), new File(['# 规范\r\n- 一条'], '规范.md'))` → 面板预填标题「规范」、显示编码；保存后库里是 `\n`。`.docx` 被拒。上传解码后超过 60000 字符的 `.md`（`'一'.repeat(60001)`）：区块内 `role="alert"` 出现「超过单份规范 60000 字的上限」，编辑面板不打开，`listWritingNorms` 仍为空。
- 无障碍名：两份规范时 `getByRole('checkbox', { name: '启用《A》' })` 与 `{ name: '启用《B》' }` 各取到一个；上移 / 下移按钮同理。编辑面板的作用范围按钮 `getAllByRole('button', { pressed: true })` 默认 5 个。
- 编辑、启用开关、上移 / 下移、删除（取消不删、确认后删）。
- 列表元信息的作用范围：默认新建的规范行内含「写正文、规划、章节摘要、提取设定、检查」；编辑后只留「提取设定」与「写正文」时显示「写正文、提取设定」（按 `NORM_SCOPES` 顺序，与勾选顺序无关）。
- 插入模板：空规范时标题变「本作差异说明」，正文含【本作开场时期】。
- 超阈值提示、链接提示出现：正文夹具含 6 个 `https://example.com/n` 链接，断言 `expect(screen.getByText(/来源表通常不必进提示词/u)).toBeInTheDocument()` 且文案含「其中有 6 个链接」；5 个链接时不出现。
- AI 精简（`vi.spyOn(globalThis, 'fetch')` + `sseResponse(textDeltaEvents(...))`，沿用 `ReviseSheet.test.tsx` 的写法）：预览出现时库里仍只有 1 份；点另存后 2 份、新的排第二且启用、原文停用且正文不变；点放弃无变化；fetch 返回 500 时显示错误、库里无变化。
- 每个控件只渲染一份（`getAllByRole(...).toHaveLength(1)`）。

### 12.7 端到端（`src/test/writingNormFixtures.ts` + 写作页、导入页用例）

夹具 `NORM_FIXTURE`：标题「使用提示」，正文按文档 02 第 4 节的九条要点自拟、全部是通用规则、不含任何原作事实，例如「- 以已导入资料为原作基线，以本作当前时期为准。」「- 同一人物在不同时期的身份不能混用。」「- 阶段性称号不新增为人物条目。」「- 组织、地点与技术不因名字相近而自动合并。」「- 保留『原作未明确』『角色推测』这类限定。」「- 缺失信息只能作为建议，未经作者采用不成为事实。」「- 新增能力须写明来源、条件、消耗、失效条件与社会后果。」「- 分叉之后按新因果续写，并更新受影响的后续事件。」再加一行唯一标记 `【夹具标记 N-7F3】` 便于断言。

- 写作页（`ChapterEditor.test.tsx` 风格）：仓储建规范 → 打开章节 → 生成面板「本次注入」里有「写作规范 · 使用提示」与 token 数 → 生成 → 请求 system 含标记，且位于【文风】或【作品信息】之后、【必须遵守的核心设定】之前；再开一次面板取消 chip → 请求不含标记，库里规范仍启用。
- 段落加工：请求 system 含标记。
- 段落加工的临时取消：打开段落加工面板，「写作规范」picker 里「使用提示」chip 为 `aria-pressed="true"` → 点它变为 `false` → 发起改写 → 请求 system **不含**标记 → `listWritingNorms` 里该规范仍 `enabled: true` → 关闭面板再打开 → chip 恢复为 `aria-pressed="true"`，再发起一次请求 system 含标记。
- 导入页（`ImportScreen.test.tsx` 风格）：规范作用范围含 extract → 粘贴两章 → 写入主线 → 提取请求 system 含标记与「不要从规范里提取条目」；世界观目的地同样；规范只含 writing 时提取请求不含标记；外文稿翻译请求不含标记。
- 章节摘要：标记完成触发摘要，请求 system 含标记。

### 12.7b 按规范检查（需求补充的测试清单）

- `src/features/writing/normCheck.test.ts`（纯函数）：
  - `buildNormCheckSystemPrompt`：含作用范围含 `check` 的规范与核心设定；停用的、作用范围不含 `check` 的不含；两次调用逐字节相同；不含【文风】。
  - `buildNormCheckUserPrompt`：本章正文在末尾；有相关条目时带【相关设定】；传 `previous`（第 3 章及其摘要，含 openThreads）时含 `【此前最近一章（第 3 章）的摘要】` 且其后紧跟 `renderSummary(chapter, summary)` 的输出（含「尚未收束的伏笔：」）；外传章节的 `previous` 标题为「外传第 N 章」；不传时没有该块；分段时标签为「第 i/n 段」并带「只检查这一段」。
  - 前情选取：第 2 章无摘要、第 1 章有摘要时检查第 3 章，块标题是「第 1 章」而不是「上一章」（验证 `previousSummaryOf` 跳章时标题与内容一致）。
  - `locateQuote`：精确命中（多次出现取第一次）；跨行原句——正文 `'甲。他推开门，\n　　走进雨里。乙'`、quote `'他推开门，走进雨里。'` → 返回区间的 `content.slice(start, end)` 等于 `'他推开门，\n　　走进雨里。'`（覆盖整句，含中间的换行与全角空格，首尾不多带空白）；quote 自带空白而正文没有（`'他推开 门'` 对 `'他推开门'`）也命中；找不到返回 null；空串与只有空白（`' \u3000\n'`）的 quote 返回 null。
  - `resolveCheckIssues`：`'使用提示'`、`' 《使用提示》 '` 都匹配到 id；小节标题（如 `'写作规则'`）匹配不上为 null 并保留；同名两份时取排序最前的那份；传入 `norms` 不含的规范（被临时取消）不匹配；排序按严重程度 → start（定位不到为 Infinity）→ segmentIndex → 段内下标，用一组并列用例覆盖每一级。
  - `splitChapterForCheck`：空串 `[]`；短章 `[content]`；长章按行切，每段 ≤ max，行尾 `\n` 在前一段末尾；单行超长在句号处切、句号在前一段；无标点时硬切；所有用例断言 `segments.join('') === content`。
- `src/llm/structured.test.ts` 追加：`failOnTruncation: true` 且响应 `finish_reason: 'length'` 时抛 `kind === 'truncated'`、只发了一次请求；不传该选项时行为与现在一致（截断的 JSON 照旧进修复重试）。截断响应用 `src/test/llmFixtures.ts` 里的 `completion(content, { finishReason: 'length' })` 构造（夹具改动见第 11 节；`structured.test.ts` 只是从那里 import）。
- `src/features/writing/NormCheckSheet.test.tsx`（`createTestHarness` + 打开写作页章节编辑器，沿用 `ChapterEditor.test.tsx` 的写法）：
  - 有启用、含 `check` 的规范时，检查请求的 system 含该规范（夹具标记），user 含本章正文；另一份停用的、一份只含 `writing` 的不出现。
  - mock 返回两条 issue（一条 quote 在正文里，一条 quote 为空）：两张卡片都渲染，严重程度文案正确；点「定位」后面板关闭、`textarea.selectionStart/End` 等于 quote 的位置。
  - 点「忽略」后该卡片不再显示，入口文案的计数减一。
  - 「按建议改写」打开段落加工面板，操作为「改写」、额外要求预填建议；此时正文未变；在改写预览里放弃后正文仍未变。
  - 预填值会被清掉：「按建议改写」→ 关闭段落加工面板 → 点底栏「加工这一段」→ 面板的额外要求输入框为空、操作为默认值（与没有检查过时一致）。
  - 原句被改后定位：检查完成后，在 textarea 里删掉某条 issue 的原句 → 该卡片的「定位」按钮仍显示（按 `checkedContent` 判断）→ 点击后卡片内出现「这段原文已被修改，找不到了」，面板不关闭，`textarea.selectionStart/End` 不变；同一卡片点「按建议改写」同样只出现该提示、不打开段落加工面板。
  - quote 在 `checkedContent` 里定位不到的卡片不显示「定位」与「按建议改写」，显示「正文里没找到这段原文」。
  - 没有规范时入口 `aria-disabled="true"`，点击显示「先在知识库添加写作规范」；未配置模型时显示配置提示；两种情况都没有发出请求。
  - 两份「检查」规范，面板里取消其中一份 → 请求 system 只含另一份；两份都取消 →「开始检查」禁用并显示「至少保留一份规范」，无请求；关掉面板再打开，两份都恢复为带上。
  - 长章分段时，各段请求的 user prompt 中【相关设定】部分完全相同（`mentionedEntries` 对整章算一次）。
  - 响应 `finish_reason: 'length'` 时显示「被截断」错误，不显示任何结果卡片。
  - 长章（> 8000 字）表单显示分段数，检查发出 K 次请求；第二段失败时整次失败、不显示第一段结果。
  - 整个检查流程前后，库里章节正文与 textarea 的值逐字相同。
  - 外传章节同样可以检查，前情块取外传内此前最近一份摘要，标题为「外传第 N 章」。
- 零变化基线（12.0）不受影响：检查是新任务，不改其他任务的提示词。

### 12.8 可单测 / 需集成测的划分

纯函数（`writingNorm.ts`、`sections.ts`、各 `build*SystemPrompt`、构建器）全部单测，不需要 DOM 与数据库；仓储与迁移、备份跑在 fake-indexeddb 上；面板与数据流用 Testing Library 集成测试，模型调用一律 mock `fetch`。宽窄屏布局在 jsdom 里无法验证，只验证「单套 DOM」与无障碍名称，视觉形态沿用 `Sheet` 与现有类名。

### 12.9 验收命令

`npm run build`、`npx vitest --run` 与 `CI=1 npx vitest --run`（禁止写入新快照）全绿，并完成 12.0b 的交叉核对。审查需逐项人工确认：`noNormsBaseline.test.ts` 里没有任何快照断言、`BASELINE` 在旧代码上同样通过；保存路径没有模型调用与 trim；精简在点击保存前没有写入；v6 只有 `stores` 无 `upgrade`、备份版本与兼容用例齐全。

---

## 修订记录（第 1 轮设计审查，`design-review.md`）

15 条全部处理，无搁置、无驳回。

| #   | 级别   | 处理                                                                                                                                                                                                                                                                                                                                                                                               | 落点                            |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | HIGH   | 采纳。`renderNormBlock` 改为 `【规范《T》】\n正文\n【规范《T》结束】`；`NORM_CHECK_TASK` 的 normTitle 指令改为抄书名号里的文字、不抄小节标题；`resolveCheckIssues` 的匹配规则写明（trim，原样与剥一层《》两种候选全等匹配，同名取排序最前，只在本次注入集合内匹配）。精简提示词保留「## 」小节输出，因为分隔已不依赖它。补渲染格式与「正文含 ## 小节仍切出正确份数」的测试，以及标题含书名号的边界 | 1.5、1.7.2、1.7.3、6.2、8、12.3 |
| 2   | MEDIUM | 采纳。基线文件禁用快照断言，改为在旧代码上用一次性脚本产出 `BASELINE` 常量 + `toBe`/`toEqual`；覆盖六个 user prompt 构造函数；夹具规范用对象字面量 + `import type`，使同一文件能在 `/tmp` 旧代码上跑，新增 12.0b 交叉核对命令；验收加 `CI=1`                                                                                                                                                       | 12.0、12.0b、12.9               |
| 3   | MEDIUM | 采纳。10 节 5.1 改写为「例外只有两类自由文本：正文散文、AI 精简后的写作规范」，并说明作者原文直接保存、按规范检查不写数据；1.5 注明这是第二个例外                                                                                                                                                                                                                                                  | 1.5、10                         |
| 4   | MEDIUM | 采纳。补 v1 备份 replace/merge；补正文只有空白被拒（路径 `data.writingNorms.0.content`）；补超 60000 字文件被拒；写明 1627/1701/1811 三处 `verno` 改为 6                                                                                                                                                                                                                                           | 12.1、12.2、12.6                |
| 5   | MEDIUM | 采纳。给出 `NormCheckSheetProps`；`injected = normsInScope(writingNorms, 'check', excluded)` 同时用于提示词与 `resolveCheckIssues`；全部取消时禁用并提示「至少保留一份规范」；`mentionedEntries` 对整章算一次（上限 8）各段共用；`excludedIds` 每次打开重置。补对应 UI 测试                                                                                                                        | 1.7.6、1.7.8、12.7b             |
| 6   | MEDIUM | 采纳。picker chip、检查 pill、作用范围按钮加 `tap-target`；作用范围在编辑面板内自建 `aria-pressed` 按钮，不改共享 `ChipGroup`；`Toggle` 加可选 `ariaLabel`，并额外加可选 `tapTarget`（审查只要求前者，但开关本体 20px、文字 label 也不到 44px，不加做不到 NFR7）。两个都不传时输出不变                                                                                                             | 1.7.6、7.1、7.2、7.3、7.4、12.6 |
| 7   | MEDIUM | 采纳。`sections.ts` 导出 `normTokens`，所有显示、阈值比较与 `item.tokens` 统一用它；`SetupSection` 在现有 `Promise.all` 查询里追加、`OutlineNodeSheet` 新增 `useRepoQuery`，按 `planning` 算 N/X，N 为 0 不渲染                                                                                                                                                                                    | 1.4、6.2、6.3、7.1、7.2、7.3    |
| 8   | LOW    | 采纳。`runStream` 示例补第三个参数 `{ onText }`                                                                                                                                                                                                                                                                                                                                                    | 1.5                             |
| 9   | LOW    | 采纳。以 7.3 为准，不加 `scope` prop；1.7.6 同步                                                                                                                                                                                                                                                                                                                                                   | 1.7.6、7.3                      |
| 10  | LOW    | 采纳。`GenerateChapterSheet` 新增只重置 `excludedNormIds` 的 `wasOpen` effect，其他状态行为不变                                                                                                                                                                                                                                                                                                    | 1.4、11                         |
| 11  | LOW    | 采纳。`splitChapterForCheck` 不变量：`join('') === content`、行尾 `\n` 归前一段、句末标点归前一段、每段 ≤ max；排序键四级全序                                                                                                                                                                                                                                                                      | 1.7.2、1.7.4、12.7b             |
| 12  | LOW    | 采纳。`condensedTitle` 写出公式，单测覆盖 56/57/60 字                                                                                                                                                                                                                                                                                                                                              | 6.1、12.3                       |
| 13  | LOW    | 采纳。事务内按 `compareNorms` 排序、插在源规范之后、整本书重写 `order = 0..n-1`；补重复 order 用例                                                                                                                                                                                                                                                                                                 | 4、12.1                         |
| 14  | LOW    | 采纳。产品文档第 7 节写作行加「按规范检查」；使用说明新增节定为 6.6；`设计方案.md` 标为建议项、实现计划单列最后                                                                                                                                                                                                                                                                                    | 10                              |
| 15  | LOW    | 采纳。12.4 锚点改为 `composeStylePrefix` 输出末尾，夹具 `extraInstruction` 非空；schema 字面量的理由改为避免 `writingNorm.ts ↔ schema.ts` 循环引用                                                                                                                                                                                                                                                 | 2、12.4                         |

需求文档（`requirements.md`）无需改动：以上都是设计层面的修正，验收标准与非功能需求不变。

## 修订记录（第 2 轮设计审查，`design-review.md`）

10 条全部采纳，无搁置、无驳回。新引用的代码已核实：`renderSummary` 在 `SummaryChainContextBuilder.ts` 466 行，是模块内函数，首行固定写「第 N 章」；`ReviseAction` 在 `revise.ts` 13 行导出；`completion()` 在 `src/test/llmFixtures.ts`，当前 options 只有 `reasoning`、`usage`；`Chapter.sideStoryId` 在 `schema.ts` 169 行；`ChapterEditorScreen` 底栏「加工这一段」在 409–413 行，`ReviseSheet` 的 `onClose` 在 434 行；`产品文档.md` 6.3 外传段在 161 行。

| #   | 级别   | 处理                                                                                                                                                                                                                                                                                      | 落点                                     |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | MEDIUM | 采纳。两处文案统一为需求原文「其中有 N 个链接。来源表通常不必进提示词，可以删掉或试试 AI 精简。」；12.6 写明夹具 6 个链接、`getByText(/来源表通常不必进提示词/u)` 断言，5 个时不出现                                                                                                      | 1.5 阈值表、7.2 第 3 点、12.6            |
| 2   | LOW    | 采纳。`ChapterEditorScreen` 持有 `reviseSeed`；「按建议改写」设置，底栏「加工这一段」与 `ReviseSheet.onClose` 清空；12.7b 补「按建议改写 → 关闭 → 加工这一段 → 额外要求为空」                                                                                                             | 1.7.6、11、12.7b                         |
| 3   | LOW    | 采纳。空白定义为 `/[\s\u3000]/u`；写出完整算法（精确命中 → 去空白串 + 下标映射表换算 start/end）；12.7b 补跨行原句、quote 自带空白、只有空白的 quote 三例                                                                                                                                 | 1.7.2、12.7b                             |
| 4   | LOW    | 采纳。`renderSummary` 改为 `export`；块标题改为「【此前最近一章（第 N 章 / 外传第 N 章）的摘要】」，内容用 `renderSummary` 输出；`buildNormCheckUserPrompt` 参数改为 `previous?: { chapter, summary }`，`chapter` 由 `summary.chapterId` 查出；表格与概览措辞同步；补跳章与外传标题的用例 | 0、1.7.1、1.7.3、1.7.6、1.7.8、11、12.7b |
| 5   | LOW    | 采纳。校验改为长度相等 + Set 大小相等 + 每个 id 都在库里，不先去重；12.1 补缺 id、多 id、重复 id 三种被拒且库里不变                                                                                                                                                                       | 4、12.1                                  |
| 6   | LOW    | 采纳。元信息按 `normalizeNormScopes` 映射 `NORM_SCOPES` 的 label 用「、」连接；示例补「检查」；12.6 补渲染顺序断言                                                                                                                                                                        | 7.1、12.6                                |
| 7   | LOW    | 采纳。12.7 补段落加工面板取消 chip → 请求不含标记 → 库里仍启用 → 重开后 chip 恢复且请求含标记                                                                                                                                                                                             | 12.7                                     |
| 8   | LOW    | 采纳。按钮显示按 `checkedContent` 判断；点击时用当前 `content` 重新定位，null 时卡片内显示「这段原文已被修改，找不到了」，不关面板、不改选区、不打开改写；第 9 节同步；12.7b 补删原句后定位 / 按建议改写的用例                                                                            | 1.7.2、1.7.6、9、12.7b                   |
| 9   | LOW    | 采纳。第 11 节加 `src/test/llmFixtures.ts`：`completion()` 的 options 加可选 `finishReason`，不传时输出不变；12.7b 改为从该文件构造截断响应                                                                                                                                               | 11、12.7b                                |
| 10  | LOW    | 采纳。第 10 节 6.3 条目补外传段前缀组成改为「作品信息 + 风格 + 写作规范 + 核心设定 + 勾选条目」                                                                                                                                                                                           | 10                                       |

需求文档仍无需改动：本轮都是设计细化，发现 1 是让设计对齐需求现有的字面量。
