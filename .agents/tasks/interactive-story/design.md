# 技术设计 · 互动推演（世界线）

> 需求来源：`brief.md`（唯一）、`requirements.md`（验收口径）。本文是第 3 轮设计（已处理第 1 轮审查的 27 条与第 2 轮审查 `design-review.md` 的 16 条意见，逐条处理见文末「修订记录」）。
> **设计补充（必读，优先级等同本文）**：`/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/interactive-story/design-addendum.md` 列出了第 3 轮审查遗留的 5 条（MEDIUM 2 / LOW 1 / NIT 2）及其改法。用户已决定结束设计循环；plan / code / code-review 须逐条落实并核对。
> 技术栈锁定：React 19 + TypeScript + Vite + Dexie 4 + Zustand + Zod 4 + vitest + Tailwind 4，纯前端、单套响应式 DOM，**不引入任何新依赖**。设计批准后不再更换。

---

## 0. 概览

一本书下可以有多个**推演**（`Scenario`）。每个推演拥有一棵**分支树**（`ScenarioNode` 表，按 `parentId` 连成树），树是唯一真实存储：主线、外传线、「已走过」都是从树上算出来的，不另存。每个节点保存这一步的情节、挑战、AI 原始选项、**世界线差异**（`WorldlineDelta`）、进展与结局标记。任意节点的**有效知识** = 世界观条目（通用的 + 作用范围包含这条线的）+ 根到该节点沿路叠加的差异，由纯函数 `effectiveKnowledge` 现算，不存储。

一步生成是**一次流式调用**：模型先写几百字情节（流式显示），再在一行分隔符之后输出 JSON（挑战、2–4 个选项、差异、进展、结局）。JSON 走 Zod 校验与一次修复重试；`finishReason === 'length'` 直接判截断、不落节点。差异在落库前经 `sanitizeDelta` 按「宁可少记」过滤：引用不到的条目、模板外的字段、**锁定字段**一律丢弃并在节点上可见地提示。

世界观条目新增两个属性：**作用范围**（`scope`：通用 / 限定到某些推演）与**可变性**（按字段：分类字段模板给默认值，条目可逐字段覆盖）。限定条目默认不出现在现有任何写作链路里（仓储 `listEntries` 默认只返回通用条目），保证「没有推演时 prompt 逐字节不变」。

沉淀为小说走一个新提案类型 `scenarioOutline`：主线路径 → 追加到主线大纲树（卷 / 章，细纲写进梗概与关联条目，节点带 `scenarioSource` 溯源）；外传路径 → 新建 `SideStory`（记分叉节点）+ 若干空章节（各带溯源与细纲）。之后照常「写这一章」，构建器在**易变后缀**里多注入「推演专属设定（含主角档案）/ 本章依据的推演原文 / 世界线状态 / 分叉之前的经过」，并出现在「本次注入」清单里。

入口放在**写作页顶部的一张推演卡片**，打开后进入独立路由 `/write/scenario/:scenarioId`（主导航高亮仍是「写作」），不加第六个 Tab（理由见 D10）。

Dexie v6 → v7（两张新表 + 旧行补默认值），备份 v3 → v4（两个新数组 + `superRefine` 树结构完整性检查）。

---

## 1. 九个决策点（简报 §3）

### D1 「主线跟随最新」的定义

**推荐：主线 = 根到 `scenario.mainNodeId` 的路径；`mainNodeId` 在每次「推进」（生成并落库一个新节点）的同一事务里改成新节点。**

- **D1.1 「最新」是什么**：在本设计里「最近创建的叶子」和「最近推进的路径」是同一件事 —— 节点只能由推进产生（开局、选项、自由输入、收尾），「再生成一批选项」不建节点、不算推进。所以两种定义结果相同。仍然存一个显式指针而不是现算 `max(createdAt)`：合并导入另一台设备的备份后两边时钟可能不一致，现算会让主线随导入跳到别处；显式指针也给以后的「手动设为主线」留了口。
- **D1.2 切换到旧线**：只查看（跳到某节点、在导航里浏览）只改 `cursorNodeId`（断点续玩用），**不动主线**；在旧线上推进一步，新节点成为 `mainNodeId`，主线随之切过去。这是简报的推荐，也是「主线跟最新」最直接的解释。放弃「查看即切换」：作者回头翻一眼旧线就把主线换掉，沉淀出来的东西会随手乱跳。
- **D1.3 UI 标识**：推演页标题下常驻一枚状态徽标：当前节点在主线上显示「主线 · 第 k 步」；不在时显示「外传线 · 不在主线上」并给「回到主线最新一步」按钮。面包屑与世界线导航里主线上的节点带「主线」文字标签（不只靠颜色）。可被 `getByText('主线 · 第 3 步')` / `getByRole('button', { name: '回到主线最新一步' })` 查到。
- **D1.4 主线换了之后已沉淀的内容**：见 D7.4 —— 一律保留，计算出「来自旧主线」标记并提示，不删除、不自动重建。

### D2 「选过的不能再选」与自由输入

- **原始选项**：节点上存 AI 当时给的 `options[]`（含 `id`），回退、切换时只读它，永不重新生成（F3.6）。
- **「已走过」不存标记，现算**：某选项已走过 ⇔ 该节点有一个子节点的 `arrivedBy` 是这个 `optionId`。树是唯一事实源，存一个 `walked` 布尔会和树漂移（例如合并导入只带来了子节点）。
- **D2.1 自由输入与已走过选项的等价判定**：**推荐「规范化后精确匹配 → 阻止；本地字符相似度 → 只提醒」两档，不做 AI 判定。**
  - `normalizeAction(text)`：NFKC → 去掉全部空白 → 去掉末尾的 `。．.！!？?…~～` → 结果比较。与本节点**已走过**的选项文本或已走过的自由输入相同时，按钮禁用，提示「这个行动在这一步已经走过了」并给「去那条线看看」。与**未走过**的选项相同时，按选了那个选项处理（`arrivedBy.kind = 'option'`），之后它显示为已走过。
  - 相似度：字符二元组 Dice 系数 ≥ 0.8 时在输入框下方提示「和已走过的『…』很像」，按钮变成「仍然这样做」，作者可以继续。
  - 放弃 AI 判定：每次自由输入多一次请求（钱 + 一两秒延迟，正好打在游戏节奏最敏感的地方），而且误判会**阻止**作者的输入 —— 作者是作者，误阻比误放糟。放弃纯相似度阻止：「我拔刀」和「我拔刀砍他」相似度很高，却是两个行动。
- **D2.3 选项走完后能否再生成**：**允许「再给几个选项」**，由作者点按钮触发（一次 `interactive-options` 请求，schema 与 prompt 见 §5.4），新选项**追加**到该节点的 `options`（标 `batch = 1, 2…`），原始选项不变；每个节点最多 8 个选项，到上限后按钮隐藏。新选项不能与已有选项规范化后相同（代码去重，去重后不足 2 个视为失败、不写入）。与「回退不发请求」「原始选项保存」不冲突：回退本身仍是零请求，追加是作者显式的新动作，追加后的选项同样永久保存。任何时候自由输入都可用，所以「走完」从来不是死路，这个按钮只是让游戏感延续。
- **D2.4 走过的自由输入怎么显示**：选项列表下方「这一步走过的其他行动」，逐条列出自由输入原文，每条一个「去这条线」按钮。它们也参与 D2.1 的阻止判定。
- **D2.2 可变性按条目还是按字段**：见 §3.3，推荐按字段。

### D3 每一步的生成内容与 schema

**D3.1 输出 schema**（`src/features/scenario/stepSchema.ts`，模型产出形状，引用用名称和序号，代码再解析成 id）：

```ts
export const OPTION_TENDENCIES = [
  'cautious',
  'bold',
  'indirect',
  'confront',
  'cooperate',
  'sacrifice',
  'deceive',
  'explore',
] as const;
// 界面文案：谨慎 / 果断 / 迂回 / 对抗 / 合作 / 牺牲 / 欺骗 / 探索
export const ENTRY_STATUSES = [
  'revealed',
  'dead',
  'missing',
  'captured',
  'destroyed',
  'sealed',
  'restored',
] as const;
// 已登场 / 死亡 / 失踪 / 被俘 / 被毁 / 被封印 / 恢复如常（清除之前的状态）
export const OC_ASPECTS = ['injury', 'ability', 'item', 'relation', 'secret', 'other'] as const;
// 伤势 / 能力 / 持有物 / 关系 / 已知秘密 / 其他

const OptionOut = z.object({
  text: z.string().trim().min(2).max(60), // 只写主角要做什么
  tendency: z.enum(OPTION_TENDENCIES),
  risk: z.enum(['low', 'medium', 'high']), // 按主角此刻看得见的危险标
});

export const StepTailSchema = z
  .object({
    challenge: z.string().trim().max(300),
    options: z.array(OptionOut).max(4),
    changes: z.object({
      fieldChanges: z
        .array(
          z.object({
            entry: z.string().trim().min(1).max(120),
            field: z.string().trim().min(1).max(40),
            value: z.string().trim().min(1).max(500),
          }),
        )
        .max(8),
      newEntries: z
        .array(
          z.object({
            category: z.string().trim().min(1),
            title: z.string().trim().min(1).max(120),
            summary: z.string().trim().max(60),
            fields: z
              .array(
                z.object({
                  field: z.string().trim().min(1),
                  value: z.string().trim().min(1).max(1000),
                }),
              )
              .max(12),
          }),
        )
        .max(2),
      statusChanges: z
        .array(
          z.object({
            entry: z.string().trim().min(1).max(120),
            status: z.enum(ENTRY_STATUSES),
            note: z.string().trim().max(80),
          }),
        )
        .max(4),
      ocChanges: z
        .array(
          z.object({
            aspect: z.enum(OC_ASPECTS),
            op: z.enum(['add', 'remove']),
            text: z.string().trim().min(1).max(80),
          }),
        )
        .max(6),
      events: z.array(z.string().trim().min(1).max(80)).max(3),
      flags: z
        .array(
          z.object({
            key: z.string().trim().min(1).max(30),
            value: z.string().trim().min(1).max(60),
          }),
        )
        .max(4),
    }),
    progress: z.object({
      reachedMilestones: z.array(z.number().int().min(1)).max(2), // 提示词里的 M1、M2… 的序号
      note: z.string().trim().max(120),
    }),
    ending: z
      .object({
        kind: z.enum(['good', 'bad', 'neutral']),
        goal: z.number().int().min(1).nullable(), // G1、G2… 的序号；开放结局为 null
        title: z.string().trim().min(1).max(30),
        cause: z.string().trim().min(1).max(120), // 是哪个选择 / 哪种状态导致了它
      })
      .nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.ending === null) {
      if (v.options.length < 2)
        ctx.addIssue({ code: 'custom', path: ['options'], message: '没有结局时必须给 2–4 个选项' });
      if (!v.challenge)
        ctx.addIssue({ code: 'custom', path: ['challenge'], message: '没有结局时必须给出挑战' });
    } else if (v.options.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: '触发结局时不再给选项' });
    }
  });
```

情节正文不在 JSON 里（见 D3.2），代码要求 trim 后 1–6000 字符，提示词要求 300–600 字。

为什么这样定：

- **倾向与风险是固定枚举，不是自由文本**：自由标签很容易写成「（会被识破）」这种剧透，枚举在结构上就剧透不了（F3.1「不能剧透结果」）。
- **引用用名称、目标与里程碑用序号**：模型抄名字和「M2」比抄 id 稳；代码负责解析，解析不了按 5.2 丢弃。
- **各数组设上限**：`newEntries ≤ 2` 同时是防发散手段（D4.4），一步最多引入两个新实体。
- 选项数不在 2–4（没有结局时）→ 校验失败 → 修复重试（验收 19）。
- **结局类型与目标对不上时以 `kind` 为准**：`ending.goal` 指向的目标 `kind` 与 `ending.kind` 不同（例如目标 G1 是好结局，模型却写了坏结局并填 `goal: 1`），代码把 `goalId` 置 null，记 `unknown-goal` 提示「结局类型与目标 G1 不一致，没有记为达成该目标」。理由：`kind` 是情节实际写出来的结果，`goal` 是模型的归类，二者冲突时相信写出来的东西，并让作者看到。

**D3.2 流式与结构化如何同时成立**：**一次流式调用，正文在前、JSON 在后，中间一行分隔符 `@@@STATE@@@`。** 流式回调里只显示第一个**完整**分隔符之前的文字，并隐藏末尾可能是分隔符开头的未完成前缀（如结尾的 `@`、`@@@ST`），避免分块边界处闪一下；完成后按最后一个完整分隔符切开，正文直接用，尾部 JSON 走 Zod。校验失败时发一次**非流式**修复请求：把原输出作为 assistant 消息回灌，要求「只输出修正后的 JSON」，正文保留首轮的。新 helper 见 §5.2。

- 放弃「两次调用（先流式写正文，再结构化提取）」：第二次要把正文再作为输入付一次钱、多一次往返延迟，而且差异是「写完之后再猜」，不如写的时候一并给出可靠。
- 放弃「整个输出是 JSON、流式解析半截 JSON 显示 plot 字段」：半截 JSON 里的转义与换行处理脆弱，DeepSeek 的 `json_object` 模式还要求整体是 JSON，不利于正文质量。

**D3.3 自由输入不合理时**：**采用简报推荐 ——「尝试与后果」，不拒绝。** 自由输入在提示词里一律标成「作者为主角输入的尝试（这是尝试，不是既成事实）」，规则写明：可行则写出成败与代价；违背标注「底层，不可改变」的设定（凭空获得能力、无视代价）时写出主角尝试、失败及其后果，不得让它成真。代码层再兜一道：无论模型怎么写，覆盖锁定字段的差异在 `sanitizeDelta` 里被丢弃（F3.5、验收 9）。放弃「直接拒绝」：拒绝打断游戏节奏，而「试了，失败了，付出代价」本身就是好情节，也正是世界规则的体现。

**D3.4 自由输入的校验**：必填（trim 后非空）、≤ 200 字符（一个行动，不是一段剧情；超出时输入框下方计数变红、按钮禁用）、原文保存（只 trim）。坏结局节点不渲染输入框。

### D4 导演层

**D4.1 开局设定**（`ScenarioSetupSchema`，§2.1）：

| 字段       | 规则                                                                                                       | 失败时                 |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ---------------------- |
| 推演名称   | trim 后 1–40 字                                                                                            | 字段下方错误，不能开始 |
| 主角（OC） | 二选一：从人物分类里选一条已有条目；或新建（名称 1–120 字必填，身份 / 性格 / 目标与动机选填，每项 ≤ 2000） | 同上                   |
| 起点       | 时间 ≤ 100、地点 ≤ 100（选填）；处境 1–500 字必填                                                          | 同上                   |
| 结局目标   | 1–6 个，每个「类型（好 / 坏 / 中性）+ 描述 1–200 字」                                                      | 少于 1 个不能开始      |
| 里程碑     | 0–8 个，有序，每个 1–200 字                                                                                | —                      |
| 基调       | ≤ 200 字选填                                                                                               | —                      |
| 预计步数   | 整数 5–200，默认 30                                                                                        | 超界时钳到边界         |

**新建 OC = 新建一条人物条目，作用范围限定到这个推演**，与推演在同一个事务里创建，**直接保存、不走提案**：这是作者自己填的字，不是 AI 产出（与一句话立项、作者手建条目同理，5.1 不涉及）。限定作用范围让 OC 不会出现在主线写作的 prompt 里；它在知识库里照常可见、可编辑（带「限定 · 推演《X》」徽标），作者想让它成为全书人物时，在条目编辑里把作用范围改成「通用」即可（作者直接编辑世界观，不是从世界线提升，因此不需要提案）。放弃「OC 只存在推演里、不进知识库」：那样人物设定有两套表示，编辑器、分类模板、回收站、提升都要再做一套。限定条目不进现有写作链路的条目列表，所以沉淀成章节后，主角（以及本章涉及的其他限定条目）的档案由 `scenarioContext` 的【本章涉及的推演专属设定】块注入（D7.3），不靠 `context.entries`。

**D4.2 每步注入进度**：易变尾部的【导演提示】块，代码按路径算出：

```text
【导演提示】
这是第 8 步，预计全程约 30 步（展开阶段 / 推进阶段 / 收束阶段）。
已达成：M1 找到失踪的船夫。
下一个里程碑：M2 进入青冥宗。在接下来几步里让它成为可能，但是否达成由主角的选择决定，不要替主角完成。
尚未收束的线索：……（来自前情摘要）
```

阶段按 `已走步数 / 预计步数`：< 40% 展开，40%–80% 推进，> 80% 收束；超过 100% 时追加「已超出预计步数：不再引入新人物与新线索，优先回收已有线索；是否收尾由作者决定，不要为了结束而强行转折」。已达成的里程碑沿路取并集（模型报告的序号必须是存在且未达成的，否则丢弃并记提示）。

**D4.3 「收尾」**：任何未结束的节点上都能点「收尾」（更多菜单 + 超出预计步数时在选项区下方出现「可以收尾了」提示）。面板里可选一个目标结局（可不选）和一句说明（≤ 200 字，选填）。生成走 `interactive-ending`：**系统提示与普通步骤逐字节相同**（共享缓存），只在用户提示里加「作者要求收尾：在这一步写出结局，ending 必填、options 为空；从当前状态自然得出，做不到圆满就写开放或中性结局」，代码用 `StepTailSchema.refine(v => v.ending !== null)` 校验（refine 不进 JSON Schema，所以 system 不变）。生成的节点 `arrivedBy = { kind: 'wrap-up', goalId, note }`，同一节点只能收尾一次（之后按钮变成「查看已写的结局」）。`arrivedBy.goalId` 记录**作者在面板里选的**目标，只作为提示词输入；结局节点的 `ending.goalId` 记录**模型实际写出的**结局归类（按 D3.1 的冲突规则解析）。两者不一致时结局节点上显示「你要的是 G1，这条线写出的是：坏结局『…』」，不报错 —— 这正是「从当前状态自然得出」的结果。

**D4.4 防发散与防强行转折的 prompt 策略**（写进稳定前缀的【推演规则】，§5.4 给原文）：

防「越走越散」：

1. 目标与里程碑在稳定前缀里，每一步都看得见；下一个里程碑每步在【导演提示】里点名。
2. 「挑战必须从上一步行动的后果、下一个里程碑、尚未收束的线索三者中至少一个生长出来，不要凭空引入与目标无关的新危机」。
3. 每步新实体 ≤ 2（schema 上限 + 规则文字）；收束阶段与超步数后「不再引入新人物与新线索」。
4. 每 5 步一次的前情摘要同时产出「尚未收束的线索」，在【导演提示】里回灌，模型被提醒去回收而不是开新坑。

防「为到结局强行转折」：

1. 「结局只有当此前的选择与状态直接导致时才触发；不得靠突发外力（天降援兵、意外暴毙、突然揭晓真相）制造结局」。
2. 结局必须填 `cause`（哪个选择 / 哪种状态导致），界面在结局节点上显示「起因：…」，作者一眼能看出是不是硬转。
3. 预计步数明说「只是节奏参考」，超出时不催结局；何时收尾是作者的决定（「收尾」按钮），而不是模型的。
4. 选项规则：「彼此倾向不同、都在世界规则内可行；选项文字只写做什么，不写结果；风险只按主角此刻看得到的危险标注」—— 防止模型用选项把剧情往预定结局上赶。

**D4.5 开局设定能否修改**：推演开始后可改：名称、结局目标（增、改、删）、里程碑（增、改、删、调序）、基调、预计步数。**不可改**：主角与起点 —— 它们是根节点的前提，改了等于整棵树建立在另一套前提上，应当新建推演。修改不重算、不重新生成任何已有节点，只影响之后的步骤；稳定前缀因此变一次（下一步缓存未命中一次，界面不提示，成本可忽略）。已有节点里引用了被删目标 / 里程碑的进展显示为「（已删除的里程碑）」。

### D5 上下文与成本

**D5.1 组成与顺序**（遵守产品文档第 9 节：稳定内容在前且逐字节可复现，易变内容在尾部）：

系统提示（同一推演内所有步骤、所有分支、收尾**逐字节相同**）：

| #   | 内容                                                                                                                                                                                                                               | 来源                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | 开场白（叙事导演兼执笔者）                                                                                                                                                                                                         | 常量                                                               |
| 2   | 作品信息 + 文体 + 结构方法 + 文风                                                                                                                                                                                                  | `composeStylePrefix(novel, style)`                                 |
| 3   | 写作规范（启用且作用范围含「互动推演」，按 order）                                                                                                                                                                                 | `composeNormsSection('interactive', …)`，排在核心设定之前（F12.3） |
| 4   | 【必须遵守的核心设定】：在本推演内**全程可见**的核心设定（通用的 pinned + 限定到本推演、`fromNodeId` 为空、无登场条件的 pinned），**排除 `cast[].entryId`**（主角在第 5 项单独渲染，不重复），锁定字段带「（底层，不可改变）」标注 | `renderScenarioEntry`                                              |
| 5   | 【主角】OC 条目的世界观原始设定（同样标注锁定字段）                                                                                                                                                                                | 同上                                                               |
| 6   | 【本推演的开局与目标】起点、G1…Gn 结局目标（含类型）、M1…Mn 里程碑、基调、预计步数                                                                                                                                                 | `scenarioSetupSection`                                             |
| 7   | 【推演规则】                                                                                                                                                                                                                       | 常量                                                               |
| 8   | 【输出格式】分隔符说明 + JSON Schema                                                                                                                                                                                               | 常量（由 schema 生成，schema 不变则不变）                          |

用户提示（每步不同）：

| #   | 内容                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 【本线相关设定】非核心的可见条目的**世界观原文**：本线差异碰过的条目（显式，最多 12 条，最近的优先）+ 在最近几步原文、本次行动、前情摘要里被提到的条目（推断，`mentionedEntries`，最多 `MAX_INFERRED_ENTRIES = 8`），推断档里作者在「本步依据」取消勾选的条目不进（D5.4）。`fromNodeId` 非空、`revealHint` 为空的限定条目在子树内与普通可见条目一样进这两档 |
| 2   | 【可能登场的预设】限定到本推演、`revealHint` 非空、路径上尚未出现 `revealed` 的条目（且 `fromNodeId` 为空或是路径上的节点）：名称 + 条件 + 摘要                                                                                                                                                                                                             |
| 3   | 【本线变化（与上文设定冲突时以这里为准，底层字段除外）】根到父节点的累计差异：设定改写、本线新条目（全文）、状态、主角状态、标记、最近 10 条事件                                                                                                                                                                                                            |
| 4   | 【更早的经过】最近的检查点摘要 + 尚未收束的线索（D5.3）                                                                                                                                                                                                                                                                                                     |
| 5   | 【此前几步（简）】检查点与「最近几步」之间的步骤：每步一行行动 + 情节原文                                                                                                                                                                                                                                                                                   |
| 6   | 【最近几步】最近 3 步：行动、情节原文、当时的挑战                                                                                                                                                                                                                                                                                                           |
| 7   | 【导演提示】（D4.2）                                                                                                                                                                                                                                                                                                                                        |
| 8   | 【本次行动】「主角选择：…」/「作者为主角输入的尝试：…（这是尝试，不是既成事实）」/ 开局「这是开局：从起点写起，引出第一个挑战」/ 收尾要求                                                                                                                                                                                                                   |

世界观条目在前缀里只出现**原文**，世界线改写只出现在尾部的【本线变化】里，并明说「冲突时以这里为准」。这样同一推演的前缀与分支无关，兄弟分支、回退后的新分支都命中同一份缓存；把「有效值」直接渲染进前缀会让每条分支的前缀都不同。

**D5.2 最近几步取几步**：`RECENT_STEPS = 3` 步完整原文（每步几百字，约 1500–2000 字），足够接住语气与场景；更早的由摘要承担。不做成可调（第一期避免多一个旋钮）。

**D5.3 长路径压缩**：**检查点摘要，按节点存放、沿路继承**。

- 深度 4、9、14…（即第 5、10、15… 步）的节点是检查点。检查点节点落库后，**后台**发一次 `interactive-summary`：输入 = 上一个检查点的摘要 + 这 5 步的情节原文，输出 `{ summary ≤ 600 字, openThreads ≤ 8 条 }`，写进该节点的 `pathSummary`。后代沿路取最近的检查点祖先，所以兄弟分支共享分叉前的摘要，回退不需要重算。
- 拼上下文时：`recent` = 父节点起往上 3 个节点；`C` = 深度小于 `recent[0]` 的最深的有摘要祖先；`gap` = C 与 recent 之间的节点，用简写原文补上（正常 ≤ 4 步）。
- **补齐算法**（纯函数 `checkpointsToFill(path, parentDepth)`，`src/domain/scenario.ts`）：返回路径上 `depth % 5 === 4`、`pathSummary === null`、`depth ≤ parentDepth` 的节点，按 depth 升序。每次推进或收尾（「再给几个选项」不触发）在组 prompt **之前**对它们**按顺序**逐个补：
  - 每个检查点 K 的输入 = K 之前最近的**已有摘要**的祖先 A 的摘要（没有 A 时写「（从开局写起）」）+ A 之后到 K（含 K）的全部步骤原文。按顺序补保证了正常情况下这一段只有 5 步；连续缺多个时，前一个补成功后后一个的 A 就是它，所以单次输入最多 5 步原文，不会膨胀。
  - 是否阻塞本步：先算 `gap`（见上）。`gap ≤ 7` → 补齐在后台进行，本步照常生成（本步用现有最近的摘要 + gap 简写原文，可以接受）；`gap > 7` → **同步**补齐（面板显示「正在整理前情…」），全部补成功才生成本步；任何一个失败 → 本步不生成，显示「整理前情失败，这一步没有生成」+「重试」（重试会从失败的那个检查点继续）。
  - 新检查点刚落库时同样走后台补（等价于下一次的 `checkpointsToFill` 提前执行）。
  - 去重：runner 持有一个内存 `Set<nodeId>`，在途的检查点不会再发第二个请求；同步补遇到在途的后台请求时 await 它而不是重发。页面卸载时在途请求随 `abort()` 一起取消，之后**下一次推进或收尾前**由 `checkpointsToFill` 重新发现。
  - 触发时机只有两个：推进 / 收尾之前，以及新检查点刚落库时。**挂载推演页、跳转节点、切换世界线、打开状态面板都不发任何请求**（包括补摘要），保证「回退不花钱」（验收 13）。
  - 失败只影响界面：后台失败时状态面板显示「前情整理失败，下次推进时会重试」，不弹错、不写库。
- 不在缺摘要时硬塞 30 步原文：成本失控且长上下文稀释注意力（第 9 节第 1 条）；`gap > 7` 的同步补就是这道上限。
- 摘要是 AI 产出，和差异同属沙盒层（D6），在检查点节点的状态面板里可查看、可编辑。
- 这是额外调用（每 5 步一次、输入 ≈ 5 步原文），但不是预生成：只为当前这条路径做，且结果被所有后代复用。

**D5.4 注入量与清单**：核心设定、OC、开局设定、规范全量（作者显式定的约束不裁剪，与写作链路同理）；相关条目按上面的显式 + 推断两档，有上限。生成区下方有一个默认折叠的「本步依据 · 约 X tokens」，列出每一项与 token 估算，满足第 9 节第 1 条「可见、可调」：

- **可调的是【本线相关设定】里推断来的条目**：每条一个复选框，默认全选；取消的条目不进下一步及之后的用户提示，直到重新勾上。勾选状态只存在推演页的内存里（页面会话内有效，离开推演页即恢复全选），不落库 —— 它是「这几步先别带这个」的临时调节，不是设定。它只影响用户提示，前缀缓存不受影响。
- 其余各项只读并写明原因：核心设定、主角、开局设定、规范是作者显式定的约束（与写作链路「核心设定不裁剪」同理）；显式档（差异碰过的条目）、本线变化、前情摘要、最近几步是这一步的事实依据，去掉会让模型和本线状态矛盾。需要减量时改规范作用范围或条目的作用范围。
- 放弃「全部可勾选」：去掉本线变化或最近几步会直接生成与路径矛盾的情节，还要多一套「勾掉了事实」的提示；放弃「只读」：违反第 9 节第 1 条。

**回退、切换不重新生成；不预生成未选分支**：跳到任何节点只改 `cursorNodeId`（一次 IndexedDB 写），不发任何请求；生成只在作者点选项 / 提交自由输入 / 收尾 / 再给选项时发生；没有任何「顺手把其他选项也生成了」的逻辑（验收 13、F3.7）。

### D6 差异的确认流程

**采用简报推荐**：差异自动记在节点上，只在推演沙盒层；随时可查看、编辑、删除；只有「提升为世界观」与「沉淀为大纲 / 章节」走提案或可编辑预览。

**为什么不违反 5.1**（写进产品文档 5.1，作为第三类例外）：

1. **5.1 防的是「AI 越权改了作品」**：设定、大纲、摘要这些会被后续所有生成读到的数据，被 AI 悄悄改了作者发现不了、错误一路滚下去（第 2 节「AI 越帮越乱」）。沙盒内容只通过两条**已确认**的通道影响作品：①「提升为世界观」提案；②「沉淀」—— 作者先在大纲提案里确认这段路径的分章，之后整章生成才会把对应步骤的原文与状态作为**生成材料**注入，产出的正文仍走可编辑预览。除这两条之外，没有任何链路读取沙盒：段落加工、摘要、提取、检查、翻译的 prompt 都看不到它，没有沉淀的作品连整章生成也看不到它（零回归测试保证）；世界观条目一个字都不会被改（验收 4）。
2. **作者每一步都在做决定**：推进本身就是作者的选择；不满意就回退走另一条，原线保留但不影响新线 —— 回退就是「忽略」。
3. **全部可见、可改、可删**：每个节点的差异、被丢弃的内容、前情摘要都在状态面板里，作者能逐条编辑删除；编辑祖先后后代节点会提示「生成时依据的是旧事实」。
4. **出沙盒的只有两个口，都经确认**：「提升为世界观」→ 条目提案（字段级 diff）；「沉淀」→ 大纲提案；之后的正文 → 可编辑预览。
5. 每一步都弹提案等于每几百字确认一次结构化 diff，游戏节奏直接毁掉 —— 和「三千字正文做字段级 diff 不提供任何信息」是同一个理由。每一步的情节正文同样直接存在节点上，不走预览：它是游戏过程本身，不是作品正文；作品正文仍要经「写这一章」的可编辑预览。

**D6.3 提升时涉及锁定字段**：锁定字段的覆盖不会被存下（AI 产出在 `sanitizeDelta` 丢弃，手动编辑在仓储被拒），所以正常情况下不存在可提升的锁定覆盖。唯一的来源是「覆盖存下之后作者把这个字段改成了锁定」：这时有效知识里该覆盖失效并标出「该字段已改为底层设定，本线改写不再生效」，「提升」按钮不可用，点击说明「底层设定不能从世界线提升；要改请直接编辑条目」，**不生成提案**（验收 10）。理由：锁定的语义是「世界线不能改它」，借提升改它就是绕过锁定；作者真要改，直接编辑世界观条目是正当路径。

### D7 沉淀为小说

**D7.1 路径 → 大纲的映射**：**由模型分组、代码校验、作者在提案里改。** `path-to-outline` 读这段路径全部步骤原文，输出卷 / 章两层：每章覆盖**连续**的若干步（建议 3–6 步，约 3000 字一章），每卷对应一个里程碑段或约 10 章。代码按范围动态构造 schema（`buildPathOutlineSchema(from, to)`，两端是路径上的绝对步数，见 D7.2），`superRefine` 要求各章的 `fromStep–toStep` 从 `from` 起首尾相接、恰好覆盖 `[from, to]`、不重叠，不满足进修复重试。user prompt 里每一步也以「第 k 步」（绝对步数）标注，模型直接抄编号。放弃「一步一章」：一步几百字，一章三千字，一步一章会得到几十个几百字的碎章；放弃「固定 N 步一章」：剧情节奏不均匀，按场景切比按数切合理。

**D7.2 提案形态**：**整段路径一个提案**（新 target `scenarioOutline`，action `create`），与现有 `outlineTree` 同一思路 —— 内容是一段可编辑的缩进标题文本，确认管道不为树结构开特例：

```text
# 第一卷 渡口（约 30000 字）
沈砚在渡口醒来，被卷入失踪案。
## 第1章 雾里的船（约 3000 字）
沈砚在雾中找到空船，船夫失踪。
关键事件：发现空船；捡到青铜钥匙
出场：沈砚、阿七
对应步骤：1–4
```

- **只有章级节点（带「对应步骤：」行的）写 `scenarioSource`，卷节点的 `scenarioSource` 为 `null`**：卷只是分组，溯源到步骤的是章；卷再存一份步骤列表只会和章的数据重复、在作者调整分章后不一致。`sedimentCoverage`、续沉淀的覆盖计算、「来自旧主线」标记都只看 `scenarioSource` 非空的节点。
- 细纲字段落点（不新增 `OutlineNode` 字段）：梗概 → `synopsis`；关键事件 → 「关键事件：…」一行原样留在 `synopsis`；出场人物 → 「出场：…」一行原样留在 `synopsis`，其中能解析成**通用**世界观条目的名称另把 id 写进 `linkedEntryIds`（「写这一节点时默认注入」的既有语义）；解析不到的（本线新人物、限定条目，含主角）的档案由 `scenarioContext` 的【本章涉及的推演专属设定】与「世界线状态」块提供；「对应步骤」→ 节点的 `scenarioSource.nodeIds`。理由：梗概已经进整章 prompt（【本章要写的内容】）、大纲面板已经能编辑，新加 `keyEvents` 字段要改编辑 UI 和整章 prompt，收益很小。
- 外传模式多两个可编辑字段：外传名称、外传简介（≤ 2000，就是外传的轻量大纲）。
- **「对应步骤」用路径上的绝对步数**（= 节点 `depth + 1`），与推演页「第 k 步」、主线徽标、面包屑同一编号，作者在推演页看到的第 7 步就是大纲里写的 7。续沉淀从第 13 步起时，提案里第一章就写「对应步骤：13–16」。
- 「对应步骤」在采用时严格校验（必须首尾相接地恰好覆盖这次沉淀的 `[a, b]`），不合法则采用失败、提案留在待确认，错误写明「第 2 章的『对应步骤』超出这次沉淀的范围（第 13–24 步）」—— 宁可让作者改一下，也不把章节挂到错误的步骤上。
- **解析时只剥「对应步骤：」一行**（转成 `scenarioSource.nodeIds`）；「关键事件：…」「出场：…」两行原样留在 `synopsis` 里（梗概会进整章 prompt，模型能看到），「出场：」行另外解析出的**通用**条目 id 写进 `linkedEntryIds`。

**D7.3 「写这一章」怎么注入**：构建器 `ContextRequest` 新增可选的 `scenarioContext`（调用方预先算好的四段文字）。存在时在**易变后缀**里、大纲位置 / 外传说明之后、【故事至此】之前按下列顺序插入：

- 【本章涉及的推演专属设定】作用范围为「限定」的世界观条目**原文**（`renderScenarioEntry`，锁定字段同样标「（底层，不可改变）」）。取点是**本章最后一步**：

  ```text
  候选 = effectiveKnowledge(本章最后一步).entries 中 origin === 'limited' 的条目
         （本章内才被揭示的预设、fromNodeId 落在本章某一步的条目都已在 entries 里）
  主角必选（主角是通用条目时不在这里重复，它已在 context.entries 里）；
  其余取「本章各步差异碰过的」∪「本章步骤原文里被 mentionedEntries 命中的」，最多 MAX_INFERRED_ENTRIES 条
  ```

  条目按 title 码元序 + id 排序。没有任何限定条目时整块省略。为什么取最后一步而不是第一步的父节点：本章里才登场的隐藏人物（简报 §2.2 的典型例子）在父节点处还属于 `pendingReveals` 或不在可见子树里，取父节点会恰好漏掉它们；取最后一步时本章出现过的都可见，而只取「碰过 / 提到」的那部分又不会把后面才有关系的条目带进来。为什么需要这一块：限定条目不在写作页的 `listEntries` 结果里（零回归的代价），整章生成只能从这里拿到主角和本章新登场人物的身份、性格、说话方式；状态块只渲染差异，不含原文。

- 【分叉之前的经过（与主线共用，外传不要重写这部分）】仅外传章节：分叉节点处的检查点摘要 + 之后到分叉点的简写原文。
- 【本章依据的互动推演】本章对应步骤的行动与情节原文（外传章节在最前面加「本章细纲：…」，因为外传章节没有大纲节点）。
- 【这条世界线在本章开始时的状态】本章第一步的父节点处的有效差异（与 D5.1 第 3 项同一渲染函数，本线新条目在这里是全文），再加「本章内发生的变化」（本章各步自己的差异，含新出现人物的档案）。

四块都标为必选（不参与预算裁剪，和大纲位置同理：它们就是本章要写的材料），在「本次注入」清单里各占一项，`kind: 'scenario'`，`id` 分别为 `scenario-limited` / `scenario-fork` / `scenario-steps` / `scenario-state`（`GenerateChapterSheet` 的列表 key 是 `${kind}-${id}`，必须各不相同），标签分别为「推演专属设定（主角『X』等 n 条）」「分叉之前的经过」「互动推演 · 第 a–b 步原文」「世界线状态」。`scenarioContext` **只传给整章生成**：`ChapterEditorScreen` 只在 `<GenerateChapterSheet context={{ ...context, targetChapterId, scenarioContext }}>` 上加，共享的 `context` 不含它，所以 `ReviseSheet`（第 561 行同样把 `{...context}` 交给构建器）等段落加工不会注入推演材料。放在尾部而不是前缀：每章都不同，进前缀会截断全书共用的缓存前缀。**`scenarioContext` 不传时构建器一行都不多走**，逐字节不变由 §12 的基线测试守。

**D7.4 主线换了之后已沉淀的内容**：**保留 + 计算出「来自旧主线」标记 + 提示，不删除、不自动重建。**

- 判定（纯函数 `sedimentCoverage`，不存标记）：一个带 `scenarioSource` 的大纲节点，若其 `nodeIds` 不全在当前主线路径上，就是「来自旧主线」。
- 推演页顶部提示「本书主线大纲里有 N 章来自旧主线（第 X–Y 章）」，大纲节点面板里显示同样的标记；提示里给「去写作页查看」入口。作者自己决定删掉这些大纲节点、留着，或把旧线改沉淀成外传。
- 删除大纲节点只解除章节关联、不删正文（现有 `deleteOutlineNode` 行为），所以即便作者删大纲，已采用的正文也不会丢（验收 28）。
- 放弃自动重建 / 自动替换：作者可能已经在旧主线的章节上写了几千字、改过梗概；任何自动动作都是在替作者裁决。

**D7.5 一本书多个推演 / 书已有主线**：**一律追加，不替换、不禁止。** 主线沉淀把新卷追加在大纲树顶层最后（`order = 现有顶层数`）；再次沉淀同一推演的主线时只沉淀「当前主线上还没被（非过期的）章级大纲节点覆盖」的一段连续步骤 `[a, b]`（规则见 §7.2 第 2 步，能处理中间有洞的情形），即续沉淀，不重复。沉淀面板显示本书主线已有的大纲规模、以及已有来自其他推演的大纲时的提示（「本书主线里已有来自推演《X》的 12 章」），由作者判断。放弃「替换」：主线大纲可能是作者手写或立项来的，替换就是删作者的东西；放弃「禁止」：多个推演拼成一部长篇是合理用法。

**D7.6 外传路径的大纲落点**：**不让外传挂大纲树**（保留 6.3 的既有设计）。外传沉淀 = 新建 `SideStory`（简介 = 提案里的外传简介）+ N 个空正文章节，每章 `scenarioSource = { scenarioId, nodeIds, brief }`，`brief` 是这一章的细纲文本（梗概 + 关键事件 + 出场）。章节列表里显示为 0 字草稿，标题来自提案。理由：「外传的简介就是它的轻量大纲」仍然成立；逐章细纲挂在章节上，不需要给外传引入一套大纲树（那会把主线进度、大纲统计、`outlineNodeId` 恒为 null 的不变量全部打破）。代价：第一期外传章节的细纲只在提案里可编辑、编辑器里只读显示（「本章细纲」折叠区），可接受。

### D8 外传与分叉

**D8.1 关联字段**：`SideStory.scenarioSource: { scenarioId, forkNodeId } | null`（默认 null）。`forkNodeId` = 这条路径与沉淀时的主线路径**最深的公共节点**（根节点总是公共的，所以非空）。外传覆盖分叉点**之后**到**当前节点**（作者点「沉淀」时所在的节点）的步骤；分叉点及之前是共用前半段。章节级溯源在 `Chapter.scenarioSource`（见 D7.6）。

**D8.2 共用前半段的摘要**：来源是推演树上的检查点摘要（分叉节点或其最近的检查点祖先）+ 之后到分叉点的简写原文，**不**取主线章节摘要 —— 主线可能根本没沉淀，或沉淀后被作者改写过，树上的摘要才是「这条线分叉前发生了什么」的准确描述。位置在易变后缀，外传与主线共用稳定前缀。导出外传只导出外传自己的章节，前半段本来就不是外传的章节，所以天然不重复（验收 27 用测试固定这一点）。

**D8.3** Dexie v7 与备份 v4 见 §4。

### D9 多 OC 与分支流程图

- **D9.1 多 OC 留口**：开局设定里主角是数组 `cast: { id, entryId }[]`，第一期 schema `.min(1).max(1)`（注释写明「第二期放开」）；OC 状态差异带 `castId`；有效知识里 OC 状态是 `Record<castId, …>`。第二期放开上限、提示词按 castId 分块即可，数据不用迁移。
- **D9.2 导航形态**：列表 + 面包屑，见 §8.3。不做图形化树。

### 附加决策

**D10 入口位置：写作页顶部卡片 + 独立路由，不加第六个主导航。**

- 不加第六个 Tab：iOS / Material 对底部 Tab 的建议都是 3–5 个；加一个会让**所有页面、所有用户**的每个 Tab 变窄（375px 下每项从 75px 变 62px），而推演只对一部分作品有用。
- 不放写作页底部：互动本身是目的（用户决策 U1），藏在大纲和几十章章节列表之后找不到。
- 放写作页顶部（「全书进度」之上）一张一行高的卡片：「互动推演 · 2 个 · 继续《雾中渡》第 7 步」+「全部推演」按钮。沉淀的产物（大纲、外传）就在同一页，玩 → 沉淀 → 写这一章的闭环不跨 Tab。
- 推演页是路由 `/write/scenario/:scenarioId`：刷新后还在同一个推演（F13.1）；`NavLink` 对 `/write` 不设 `end`，子路径下「写作」仍高亮，信息架构上它属于写作。

**D11 task profile**：见 §5.1。

**D12 「按规范检查」推演节点：第一期不做。** 现有检查绑定章节编辑器（定位原句、按建议改写都作用于编辑器 textarea），搬到推演节点要么做一套只读变体、要么改造 `NormCheckSheet` 的接口，成本中等；而推演节点不是作品正文 —— 真正要交付的文字是沉淀后「写这一章」的章节，那里已经能检查。推演提示词里已经带「互动推演」作用范围的规范，生成时就受约束。

**D13 已有写作规范是否默认勾上「互动推演」**：**只给「五项全开」的老规范自动加上，收窄过作用范围的不动。** 五项全开是默认值，作者没碰过，含义就是「处处适用」；收窄过的是作者做过的选择，自动加新范围会违背它。v7 迁移与 v1–v3 备份导入共用 `addInteractiveScopeIfFull(scopes)` 一个函数。新建规范默认六项全开（沿用「默认全开」约定）。

---

## 2. 数据模型

命名：推演 = `Scenario`（不叫 Story，避免和 `SideStory` 混淆），表 `scenarios` / `scenarioNodes`，功能目录 `src/features/scenario/`。全部 schema 写在 `src/domain/schema.ts`（类型与运行时校验的唯一事实源），纯领域函数在 `src/domain/scenario.ts`（树、主线、已走过、等价判定、沉淀覆盖）与 `src/domain/worldline.ts`（差异解析、锁定、有效知识、渲染）。

### 2.1 推演与节点

```ts
// ---------------------------------------------------------------- 互动推演

export const ScenarioGoalKindSchema = z.enum(['good', 'bad', 'neutral']);

export const ScenarioSetupSchema = z.object({
  /** 第一期只能 1 人；数组是为第二期多 OC 留口，放开 max 即可，数据不用迁移 */
  cast: z
    .array(z.object({ id: IdSchema, entryId: IdSchema }))
    .min(1)
    .max(1),
  start: z.object({
    time: z.string().trim().max(100).default(''),
    place: z.string().trim().max(100).default(''),
    situation: z.string().trim().min(1, '请写出主角的处境').max(500),
  }),
  goals: z
    .array(
      z.object({
        id: IdSchema,
        kind: ScenarioGoalKindSchema,
        description: z.string().trim().min(1).max(200),
      }),
    )
    .min(1, '至少设定一个结局目标')
    .max(6),
  milestones: z
    .array(z.object({ id: IdSchema, description: z.string().trim().min(1).max(200) }))
    .max(8)
    .default([]),
  tone: z.string().trim().max(200).default(''),
  expectedSteps: z.number().int().min(5).max(200).default(30),
});

export const ScenarioSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  title: z.string().trim().min(1, '推演名称不能为空').max(40),
  setup: ScenarioSetupSchema,
  /** 主线 = 根到它的路径。每次推进在同一事务里改成新节点；只查看不改 */
  mainNodeId: IdSchema.nullable().default(null),
  /** 断点续玩：上次停在哪个节点。跳转只改它 */
  cursorNodeId: IdSchema.nullable().default(null),
  lastAdvancedAt: TimestampSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** 怎么走到这一步。text 存一份原文：选项文字永不改，但节点详情要能独立显示 */
export const ArrivedBySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }),
  z.object({ kind: z.literal('option'), optionId: IdSchema, text: z.string() }),
  z.object({ kind: z.literal('free'), text: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal('wrap-up'), goalId: IdSchema.nullable(), note: z.string().max(200) }),
]);

export const ScenarioOptionSchema = z.object({
  id: IdSchema,
  text: z.string().trim().min(2).max(60),
  tendency: z.enum(OPTION_TENDENCIES),
  risk: z.enum(['low', 'medium', 'high']),
  /** 0 = 首次生成；1、2… = 「再给几个选项」追加的批次 */
  batch: z.number().int().nonnegative().default(0),
});

export const ScenarioEndingSchema = z.object({
  kind: ScenarioGoalKindSchema,
  goalId: IdSchema.nullable(),
  title: z.string().trim().min(1).max(30),
  cause: z.string().trim().min(1).max(120),
});

export const ScenarioNodeSchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  scenarioId: IdSchema,
  /** null = 根（开局）。每个推演恰好一个根 */
  parentId: IdSchema.nullable(),
  /** 根为 0；= 父节点 depth + 1。界面上的「第 k 步」= depth + 1 */
  depth: z.number().int().nonnegative(),
  arrivedBy: ArrivedBySchema,
  plot: z
    .string()
    .refine((v) => v.trim().length > 0, '情节不能为空')
    .refine((v) => v.length <= 6000, '情节过长'),
  challenge: z.string().max(300).default(''),
  options: z.array(ScenarioOptionSchema).max(8).default([]),
  delta: WorldlineDeltaSchema.default(EMPTY_DELTA),
  /** 生成或编辑时被丢弃的内容，给作者看（5.2 的「可见地提示」） */
  notices: z.array(DeltaNoticeSchema).default([]),
  progress: z
    .object({
      reachedMilestoneIds: z.array(IdSchema).default([]),
      note: z.string().max(120).default(''),
    })
    .default({ reachedMilestoneIds: [], note: '' }),
  ending: ScenarioEndingSchema.nullable().default(null),
  /** 检查点摘要：根到本节点的前情。只有检查点节点（depth % 5 === 4）会有 */
  pathSummary: z
    .object({ text: z.string().max(2000), openThreads: z.array(z.string().max(120)).max(8) })
    .nullable()
    .default(null),
  /** 差异最后一次被作者编辑的时间；后代 createdAt 早于它时提示「生成时依据的是旧事实」 */
  deltaEditedAt: TimestampSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
```

`OPTION_TENDENCIES` 等枚举常量放在 `schema.ts`（`stepSchema.ts` 从这里引），避免循环引用。文件内定义顺序：枚举常量 → `EntryRefSchema` / `WorldlineDeltaSchema` / `DeltaNoticeSchema`（§2.2）→ 推演与节点 → 快照。新的「互动推演」一节放在「写作规范」之后、「章节摘要」之前。

### 2.2 世界线差异

```ts
/** 差异指向的条目：世界观条目，或某个祖先节点上产生的本线新条目 */
export const EntryRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('world'), entryId: IdSchema }),
  z.object({ kind: z.literal('line'), nodeId: IdSchema, localId: IdSchema }),
]);

export const WorldlineDeltaSchema = z.object({
  /** 字段覆盖：只能改分类模板里的字段（fields.*），名称 / 别名 / 摘要不可改 */
  fieldOverrides: z
    .array(
      z.object({
        target: EntryRefSchema,
        fieldKey: z.string().min(1),
        value: z.string().min(1).max(1000),
      }),
    )
    .default([]),
  /** 只在本线存在的新条目。localId 由代码生成；promotedEntryId 非空 = 已提升为世界观条目 */
  lineEntries: z
    .array(
      z.object({
        localId: IdSchema,
        categoryId: IdSchema,
        title: z.string().trim().min(1).max(120),
        summary: z.string().max(200).default(''),
        fields: z.record(z.string(), z.string()).default({}),
        promotedEntryId: IdSchema.nullable().default(null),
      }),
    )
    .default([]),
  statusChanges: z
    .array(
      z.object({
        target: EntryRefSchema,
        status: z.enum(ENTRY_STATUSES),
        note: z.string().max(80).default(''),
      }),
    )
    .default([]),
  ocChanges: z
    .array(
      z.object({
        castId: IdSchema,
        aspect: z.enum(OC_ASPECTS),
        op: z.enum(['add', 'remove']),
        text: z.string().trim().min(1).max(80),
      }),
    )
    .default([]),
  /** 事件记录：只追加，给模型回顾与将来的「原作事件表」对照用 */
  events: z.array(z.string().trim().min(1).max(80)).default([]),
  /** 标记：键值，后写覆盖先写。将来原作事件表可以按标记判定「某原作事件是否仍发生」 */
  flags: z
    .array(
      z.object({ key: z.string().trim().min(1).max(30), value: z.string().trim().min(1).max(60) }),
    )
    .default([]),
});

export const DeltaNoticeSchema = z.object({
  kind: z.enum([
    'locked-field',
    'unknown-entry',
    'unknown-field',
    'unknown-category',
    'duplicate-entry',
    'rule-status',
    'unknown-goal',
    'unknown-milestone',
    'duplicate-option',
  ]),
  message: z.string(),
});
```

为什么差异存 id 引用而不是名称：世界观条目会被改名、加别名；用名称存，改个名本线的改写就对不上了。模型产出用名称，解析成 id 发生在落库之前、只发生一次。

### 2.3 世界观条目与分类的新属性

```ts
// FieldDefSchema 新增（可选，不给 default：旧分类 parse 后形状不变）
mutability: z.enum(['locked', 'mutable']).optional(),

// KnowledgeEntrySchema 新增
/** 作用范围。universal = 所有世界线可见（默认）；limited = 只在列出的推演里存在 */
scope: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('universal') }),
  z.object({
    kind: z.literal('limited'),
    targets: z.array(z.object({
      scenarioId: IdSchema,
      /** null = 整个推演；否则只在这个节点及其后代可见（「走入某个分支才出现」） */
      fromNodeId: IdSchema.nullable().default(null),
      /** 登场条件（给导演看）。非空时条目作为「可能登场的预设」而不是既成事实注入，直到某步把它标为 revealed */
      revealHint: z.string().trim().max(200).default(''),
    })).min(1),
  }),
]).default({ kind: 'universal' }),
/** 逐字段覆盖分类模板的可变性；没有的键用模板默认值 */
fieldLocks: z.record(z.string(), z.enum(['locked', 'mutable'])).default({}),

// OutlineNodeSchema 新增
scenarioSource: z.object({ scenarioId: IdSchema, nodeIds: z.array(IdSchema) }).nullable().default(null),
// ChapterSchema 新增（只允许外传章节非空；主线章节的溯源在大纲节点上）
scenarioSource: z.object({ scenarioId: IdSchema, nodeIds: z.array(IdSchema), brief: z.string().max(3000).default('') }).nullable().default(null),
// SideStorySchema 新增
scenarioSource: z.object({ scenarioId: IdSchema, forkNodeId: IdSchema }).nullable().default(null),

// WritingNormScopeSchema 末尾追加 'interactive'；WritingNormSchema.scopes 默认值改为六项
// ProposalTargetSchema 追加 'scenarioOutline'
```

**为什么作用范围挂推演而不是「世界线」**：作者写条目时，世界线（路径）还不存在。能预先指定的只有「哪个推演」和「从哪个已存在的节点起」；后者在推演页的状态面板里设（「只从这一步起出现」），前者在条目编辑里设。

**为什么限定条目仍是 `KnowledgeEntry`**：人物原始设定属于世界观层（A4），限定条目和通用条目共用编辑器、分类模板、回收站、提升流程；另开一套「推演内条目」会让同一个人物有两种存法。

**不阻碍以后加「原作事件表」**（F5.5）：事件表将是作品级的新表（事件、时间截面、默认是否发生）；推演节点已有 `events` 与 `flags`，以后可以加一种差异 `canonOverrides: { eventId, happens }`，或用 flag 键约定 `canon:<eventId>`。本期的数据结构不需要为此预留任何字段。

### 2.4 不变量与归属

| 不变量                                                                                                                        | 归属层                                                                                                                        | 理由                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字段长度、枚举、选项 ≤ 8、cast 恰 1 人                                                                                        | Zod schema（仓储写入 + 备份导入都 parse）                                                                                     | 备份是绕过 UI 的入口，只能在 schema 守                                                                                                                     |
| 每个推演恰好一个根；子节点 depth = 父 + 1；结局节点没有子节点；同一节点每个选项 / 每个规范化后的自由输入 / 收尾最多一个子节点 | 仓储 `appendScenarioNode`（事务内检查）+ 备份 `superRefine`（§4.2 规则 2、3、5、10）+ 合并导入按推演整棵替换节点（§4.2 末尾） | 两个标签页同时点同一选项时只有事务能挡住重复；备份绕过仓储，只能靠快照校验；合并导入若逐行取并集，两份各自合法的树拼起来就不合法，所以合并粒度必须是整棵树 |
| 差异不覆盖锁定字段、引用必须存在、字段必须在模板里                                                                            | 领域 `sanitizeDelta`（纯函数）；生成管道落库前调用，仓储写入时再调用                                                          | 规则只有一份实现；AI 路径丢弃并提示，手动编辑路径由仓储把第一条提示作为错误抛出                                                                            |
| 世界规则类条目（`kind = 'worldbuilding'` 分类）不会死亡 / 被毁                                                                | `sanitizeDelta`                                                                                                               | 规则被「摧毁」是在绕过锁定                                                                                                                                 |
| `mainNodeId` 只在推进时改；`cursorNodeId` 只经 `setScenarioCursor` / 推进改                                                   | 仓储                                                                                                                          | 主线规则只有一个执行点                                                                                                                                     |
| 有效知识不存储                                                                                                                | 领域 `effectiveKnowledge`                                                                                                     | 存了就会和祖先差异的编辑漂移                                                                                                                               |
| 「已走过」不存储                                                                                                              | 领域 `walkedChoices(node, children)`                                                                                          | 同上                                                                                                                                                       |
| 限定条目不进现有写作链路                                                                                                      | 仓储 `listEntries` 默认 `scope: 'worldview'`                                                                                  | 失败关闭：新增的调用点不传参也不会泄漏                                                                                                                     |
| 作为某推演主角的条目不能硬删除                                                                                                | 仓储 `hardDeleteEntry`                                                                                                        | 硬删后推演无主角，备份也会被 `superRefine` 拒绝                                                                                                            |
| 删推演时清掉所有指向它的 `scenarioSource`                                                                                     | 仓储 `deleteScenario`（同一事务）                                                                                             | 否则悬空引用让备份校验失败                                                                                                                                 |
| `Chapter.scenarioSource` 只能在外传章节上                                                                                     | 仓储 `commitScenarioOutline` + 备份 `superRefine`                                                                             | 主线章节的溯源在大纲节点上，两处都有会不一致                                                                                                               |

---

## 3. 有效知识与锁定

### 3.1 可见条目

条目 E 在推演 S 的节点 N 处可见 ⇔ 未软删除，且 `scope.kind === 'universal'`，或 `scope.targets` 里有 `scenarioId === S` 且（`fromNodeId === null` 或 `fromNodeId` 是 N 本身或其祖先）。带 `revealHint` 的限定条目在路径上出现 `revealed` 状态之前属于「可能登场的预设」，之后与普通可见条目相同。

### 3.2 `effectiveKnowledge`（`src/domain/worldline.ts`，纯函数）

```ts
export function effectiveKnowledge(input: {
  scenario: Scenario;
  path: ScenarioNode[]; // 根 → N，含 N
  entries: KnowledgeEntry[]; // 本书全部未删除条目（含限定的）
  categories: Category[];
}): EffectiveKnowledge;

export interface EffectiveKnowledge {
  entries: EffectiveEntry[]; // 可见的世界观条目 + 本线新条目（已提升的本线条目被对应世界观条目取代）
  pendingReveals: EffectiveEntry[];
  oc: Record<string, Record<OcAspect, { text: string; nodeId: string }[]>>;
  flags: Record<string, { value: string; nodeId: string }>;
  events: { text: string; nodeId: string; depth: number }[];
  reachedMilestoneIds: string[];
  /** 存着但不再生效的差异：字段后来被锁定、条目被删除、字段从模板里删掉 */
  inactive: { nodeId: string; message: string }[];
}

export interface EffectiveEntry {
  ref: EntryRef;
  origin: 'world' | 'limited' | 'line';
  title: string;
  categoryId: string;
  /** 每个字段的当前值与来源：'world' 或产生它的节点 id */
  fields: Record<string, { value: string; source: 'world' | string }>;
  status: { value: EntryStatus; nodeId: string; note: string } | null;
}
```

叠加规则：沿 `path` 从根往下逐节点应用差异，后写覆盖先写；OC 状态 `add` 追加（同文本去重），`remove` 删除同文本的项（没有则忽略）；标记后写覆盖。

状态分两类：**揭示**（`revealed`）是一次性的，记在 `EffectiveKnowledge` 内部的 `revealedRefs: Set` 上，把条目从 `pendingReveals` 移到 `entries`，之后任何状态都不撤销它；**处境**（dead / missing / captured / destroyed / sealed）写进 `EffectiveEntry.status`，`restored` 只清除处境，不清除揭示。

**本线条目的可变性**：本线条目没有 `fieldLocks`，`fieldMutability(category, undefined, key)` 只看分类模板与内置默认（§3.3）。锁定字段只能在新建时（`lineEntries[].fields`）给值，之后任何节点对它的覆盖都按 `locked-field` 丢弃。理由：本线新人物的「说话方式」同样是辨识这个人的东西，不能因为它是本线新增的就允许每步改。

**已提升的本线条目是别名**：`promotedEntryId` 非空且该世界观条目存在、未删除时，本线条目 `{line, nodeId, localId}` 视为指向 `{world, promotedEntryId}` 的别名：

- 本线条目自身的 `fields` 不再叠加（世界观条目已含这些值，是作者在提案里确认过的版本）；它不在 `entries` 里单独出现，取而代之的是那条世界观条目（`origin: 'world'`）。
- 路径上任何 target 指向这个 line ref 的字段覆盖与状态，改为作用到那条世界观条目，**只在这条路径上**生效 —— 和其他世界线差异一样。
- 兄弟分支本来就能看到新的通用世界观条目，看到的是它的世界观原文，不带原线的后续变化。
- 提升出的世界观条目后来被删除时，别名失效、本线条目恢复按自身 `fields` 叠加（不丢原线的数据）。

这样原线上不会出现同一人物的两份，提升前后原线的后续变化也不丢。计算是 O(路径长度 × 每步差异数)，几百步内毫秒级，界面用 `useMemo` 按 `(nodes, entries, categories, cursorNodeId)` 缓存。

### 3.3 可变性：按字段，模板给默认值，条目可覆盖

**推荐按字段**（采纳简报推荐）。按条目太粗：一个人物的「身份」会因为背叛而变，「说话方式」不该被一条世界线改掉 —— 同一个条目里两种需求并存。

解析顺序（`fieldMutability(category, entry | undefined, key)`）：`entry?.fieldLocks[key]` → 模板 `FieldDef.mutability` → 内置默认 `builtinMutability(category, key)` → `'mutable'`。

`builtinMutability(category, key)`（`src/domain/defaults.ts` 导出）：

- `category.kind` 是 `worldbuilding` / `character` → 查 `BUILTIN_CATEGORIES` 里同 `kind` 的模板，键在模板里就取它的 `mutability`；
- `category.kind === 'custom'` → **只有**当分类 `name` 与 `SUGGESTED_CATEGORIES` 某项的 `name` 完全相同、**且**键在该模板里时，取那个模板的值；否则返回 `undefined`（落到 `'mutable'`）。
- 理由：建议分类（势力、地点、道具、伏笔、时间线）落库后都是 `kind: 'custom'`，只按 `kind + 键` 查会找不到它们，或者把作者自建分类里恰好叫 `rules` / `definition` 的键误判为锁定。名称 + 键双重匹配只在「这就是一键添加的那个分类」时生效；作者把「道具」改了名，就回到「不知道语义 → 可变」，与表里「自定义字段默认可变」一致。

旧作品的分类没有存 `mutability`，靠第三步得到与新作品一样的默认值，因此**不需要迁移分类表**。

默认值（写进 `src/domain/defaults.ts` 的模板，新作品与「一键添加」的分类直接带上）：

| 分类       | 锁定（底层）               | 可变                                     | 理由                                                                                                                 |
| ---------- | -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 世界观设定 | 定义、运作规则、限制与代价 | 对剧情的影响                             | 规则与代价是世界的物理；影响会随局势变                                                                               |
| 人物       | 性格、软肋与恐惧、说话方式 | 身份、外貌、目标与动机、关系网、成长弧线 | 简报：状态与关系可变。口吻与性格是「同一个人」的辨识，产品文档要求同一人物口吻不能变样；性格的变化应体现在成长弧线里 |
| 势力       | 简介                       | 诉求、实力与手段、弱点                   | 势力会兴衰、换目标                                                                                                   |
| 地点       | 简介                       | 氛围、叙事作用                           | 地点会被毁、被占，用状态 + 氛围表达                                                                                  |
| 道具       | 简介、能力与规则、代价     | —                                        | 道具规则同世界规则                                                                                                   |
| 伏笔       | 埋设内容                   | 预期收束、状态                           | 埋了什么是事实，怎么收是变数                                                                                         |
| 时间线     | 时间、事件                 | 后果                                     | 已发生的事不能被世界线改写，后果可以                                                                                 |
| 自定义字段 | —                          | 默认可变                                 | 不知道语义时不替作者加限制；作者可在分类管理里改                                                                     |

名称、别名、一句话摘要不在可覆盖范围（不是模板字段）：改名用一条「设定改写」写在身份里即可，改名本身会让引用对不上。

### 3.4 `sanitizeDelta` 与模型产出的解析

`resolveStepChanges(raw: StepTail['changes'], ctx)` → `{ delta, notices }`，`ctx` 含父节点处的 `effectiveKnowledge`、分类、cast：

| 情况                                                                                                                                            | 处理                                                                                                | 提示文案（进 `notices`）                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `entry` 名称在候选集（`entries ∪ pendingReveals`，含本线新条目、OC；已提升的本线条目以世界观条目的身份出现）里按 title ∪ aliases 规范化匹配不到 | 丢弃这一项                                                                                          | 「找不到条目『X』，这条变化没有记下」                              |
| 字段覆盖或状态引用了 `pendingReveals` 里的预设条目                                                                                              | 照常处理，并隐含追加一条 `{ target, status: 'revealed' }`（同一步已有则不重复）                     | 不提示（揭示是正常剧情）                                           |
| `newEntries` 与预设条目重名                                                                                                                     | 不新建；改记一条 `revealed`，并把它的字段逐个转成对该条目的覆盖（锁定字段照常丢弃，值相同静默丢弃） | 「『Y』是预设人物，已记为登场，没有重复新建」（`duplicate-entry`） |
| `field` 既不是模板键也不是模板中文名                                                                                                            | 丢弃                                                                                                | 「『X』没有『Y』这一栏，没有记下」                                 |
| 字段解析为锁定                                                                                                                                  | 丢弃                                                                                                | 「『X』的『Y』是底层设定，本线不能改写，已丢弃」                   |
| 值与当前有效值相同                                                                                                                              | 静默丢弃                                                                                            | —                                                                  |
| `newEntries` 分类名对不上                                                                                                                       | 丢弃整条                                                                                            | 「分类『X』不存在，没有新建『Y』」                                 |
| 新条目与可见条目重名                                                                                                                            | 丢弃                                                                                                | 「已有同名条目『Y』，没有重复新建」                                |
| 新条目字段不在模板里                                                                                                                            | 丢弃该字段                                                                                          | 不提示（与反向提取一致）                                           |
| 状态变化指向世界规则类分类的条目                                                                                                                | 丢弃                                                                                                | 「『X』是世界规则，不会死亡或被毁」                                |
| 里程碑 / 目标序号不存在或已达成                                                                                                                 | 丢弃                                                                                                | 「没有第 N 个里程碑」                                              |
| 结局 `goal` 指向的目标类型与 `ending.kind` 不同                                                                                                 | `goalId = null`                                                                                     | 「结局类型与目标 Gk 不一致，没有记为达成该目标」（`unknown-goal`） |
| `ocChanges`                                                                                                                                     | 模型不给 `castId`，代码一律填 `cast[0].id`（第一期只有一人）                                        | —                                                                  |

字段覆盖的可变性：目标是世界观条目时 `fieldMutability(category, entry, key)`；目标是本线条目时 `fieldMutability(category, undefined, key)`（§3.2）。

`sanitizeDelta(delta, ctx)` 对**已解析**的差异做同一套检查（引用、字段、锁定、规则状态），给仓储写入与手动编辑用。手动编辑时有任何提示 → 仓储抛 `Error(第一条提示)`，什么都不写（验收 8）；编辑界面本身也只在下拉里列出可变字段，正常操作走不到这一步。

---

## 4. Dexie v7 与备份 v4

### 4.1 `src/data/dexie/db.ts`

```ts
scenarios!: Table<Scenario, string>;
scenarioNodes!: Table<ScenarioNode, string>;

/**
 * v7：互动推演。
 * - 新表 scenarios / scenarioNodes。节点按 scenarioId 取整棵树（一次查询，树在内存里拼），
 *   parentId 索引只为删推演时级联 —— 不需要按父节点查询，但留着便宜。
 * - 读取路径不做 Zod parse，所以用 upgrade 给旧行补新字段的默认值，与 v3 / v5 同理：
 *   比在每个读取点写 `?? 默认值` 可靠。
 * - 写作规范：只有「五项全开」的老规范补上 interactive（设计 D13）。
 */
this.version(7)
  .stores({
    scenarios: 'id, novelId',
    scenarioNodes: 'id, novelId, scenarioId, parentId',
  })
  .upgrade(async (tx) => {
    await tx.table('entries').toCollection().modify((e) => {
      e.scope ??= { kind: 'universal' };
      e.fieldLocks ??= {};
    });
    for (const name of ['outlineNodes', 'chapters', 'sideStories']) {
      await tx.table(name).toCollection().modify((row) => { row.scenarioSource ??= null; });
    }
    await tx.table('writingNorms').toCollection().modify((norm) => {
      // 缺字段的行按 v6 的默认（五项全开）处理，而不是清空作用范围
      norm.scopes = addInteractiveScopeIfFull(norm.scopes ?? ALL_NORM_SCOPES_V6);
    });
  });
```

`ALL_NORM_SCOPES_V6`（`src/domain/writingNorm.ts`，冻结常量 `['writing', 'planning', 'summary', 'extract', 'check']`，只给迁移与旧备份用，不随 `NORM_SCOPES` 变化）。`addInteractiveScopeIfFull`（同文件）：输入恰好包含 `writing / planning / summary / extract / check` 五项（不论顺序）且不含 `interactive` 时返回六项（规范化顺序），否则原样返回。全函数，不抛错。

领域函数仍对 `scope` / `fieldLocks` / `scenarioSource` 缺失做容错（`?? 默认值`），作为迁移之外的第二道防线（合并导入的旧数据都会经 parse 补齐，这一道只防万一）。

现有测试里全部 4 处 `verno` 断言 `toBe(6)` → `toBe(7)`（`DexieNovelRepository.test.ts` 1633、1707、1817、2248 行，用例名「当前架构版本为 6」同步改为 7）。它们是版本号断言，不是提示词断言。

### 4.2 备份 v4（`src/features/export/backup.ts`）

`BACKUP_VERSION = 4`，注释补：

> v4：加入互动推演（`scenarios`、`scenarioNodes`）、条目的作用范围与可变性（`scope`、`fieldLocks`）、大纲 / 章节 / 外传的推演溯源（`scenarioSource`）、写作规范的 `interactive` 作用范围。必须升版本：旧版应用的 `z.object` 会悄悄丢掉推演数据，而 `interactive` 作用范围会让旧应用整份拒绝、却报成「内容不符合预期」。升版本后旧应用明确报「来自更新版本」。

兼容：

- `RepositorySnapshotSchema` 加 `scenarios`、`scenarioNodes`（`default([])`）；其余新字段都有 `default`，v1–v3 文件解析后取默认值（通用、无锁定覆盖、无溯源）。
- `parseBackup` 在整份解析成功后：`version <= 3` 时对 `data.writingNorms` 逐份执行 `addInteractiveScopeIfFull`，与 v7 迁移同一条规则（v4 文件不做：v4 里五项的规范是作者主动去掉了 `interactive`）。
- `summarizeBackup` 不变。

`superRefine` 新增检查（备份是唯一能绕过仓储写入的入口）：

| #   | 规则                                                                                                                              | 路径 / 文案                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | 节点的 `scenarioId` 指向快照内的推演，且 `novelId` 相同                                                                           | `scenarioNodes.i.scenarioId`：「找不到所属推演」/「所属推演不属于这部作品」        |
| 2   | 每个推演至多一个 `parentId === null` 的节点；`arrivedBy.kind === 'start'` ⇔ `parentId === null`                                   | `scenarioNodes.i.parentId`：「一个推演只能有一个开局」                             |
| 3   | 非根节点的父节点存在、属于同一推演，`depth === parent.depth + 1`；根 `depth === 0`（深度递增保证无环）                            | `scenarioNodes.i.parentId`：「找不到父节点」/「父节点不在同一推演」/「层级不连续」 |
| 4   | `arrivedBy.kind === 'option'` 时 `optionId` 在父节点的 `options` 里                                                               | `scenarioNodes.i.arrivedBy`：「父节点上没有这个选项」                              |
| 5   | 有结局的节点没有子节点                                                                                                            | `scenarioNodes.i.parentId`：「结局之后不能再有节点」                               |
| 6   | 推演的 `mainNodeId` / `cursorNodeId` 为 null 或属于本推演的节点；推演有节点时 `mainNodeId` 非空                                   | `scenarios.i.mainNodeId`                                                           |
| 7   | 推演主角 `cast[].entryId` 指向同一作品的条目（含软删除的）                                                                        | `scenarios.i.setup.cast.j.entryId`：「找不到主角条目」                             |
| 8   | `sideStories.i.scenarioSource`：推演存在且同作品，`forkNodeId` 属于该推演                                                         | 「外传指向的分叉节点不存在」                                                       |
| 9   | `outlineNodes.i.scenarioSource` / `chapters.i.scenarioSource`：推演存在且同作品，每个 `nodeId` 属于该推演；章节的只能在外传章节上 | 「来源步骤不属于这个推演」/「主线章节不能直接关联推演」                            |
| 10  | 同一父节点下，`arrivedBy` 为 option 的每个 `optionId`、为 free 的每个 `normalizeAction(text)`、为 wrap-up 的，各自最多一个子节点  | `scenarioNodes.i.arrivedBy`：「同一个选择出现了两次」                              |

**合并导入按推演整棵替换**（`DexieNovelRepository.importSnapshot` 的 merge 分支）：对快照里出现的每个 `scenario.id`，在同一事务里先 `scenarioNodes.where('scenarioId').equals(id).delete()`，再 `bulkPut` 快照里属于它的节点；推演行本身照旧按 id 覆盖。快照里没有的推演（只在本地有的）不动。理由：现有 merge 是逐表 `bulkPut` 取并集，两台设备在同一选项下各推进了一步，并集后同一选项有两个子节点（违反规则 10），本地新分支还会和备份带来的 `mainNodeId` 不一致；`superRefine` 只校验快照内部，挡不住这种拼接。整棵替换的粒度与「推演行按 id 覆盖」一致，主线指针与树总是来自同一份快照。代价是本地在那个推演上的新分支被备份版本取代 —— 与条目、章节在合并导入中「备份覆盖本地同 id 行」的既有语义一致，`BackupSection.tsx` 合并导入选项的说明文字从「id 相同的记录以备份为准。」改为「id 相同的记录以备份为准；同一个互动推演整棵分支树以备份为准。」（UI 文案，不是 prompt；`BackupSection.test.tsx` 用正则匹配，不受影响）。

**整棵替换后清理本地的悬空引用**（同一个 merge 事务内、写完全部表之后执行）。整棵替换会删掉本地独有的节点 L，而本地的大纲节点、外传章节、外传、限定条目可能还引用着 L。`exportBackup` 不做校验、`parseBackup` 用规则 8 / 9 整份校验，不清理的话合并之后导出的每一份备份都恢复不了（连带其他作品），作者只在真要恢复时才发现。所以合并时就地修复，不留到导出时：

```text
对快照里出现的每个 scenarioId = S（替换完 S 的节点之后）：
  live = S 现在的全部节点 id
  outlineNodes / chapters（本作品，scenarioSource.scenarioId === S）：
      nodeIds 去掉不在 live 里的；一个不剩时 scenarioSource = null（节点与正文都保留）
  sideStories（scenarioSource.scenarioId === S）：
      forkNodeId 不在 live 里 → scenarioSource = null（外传与章节保留，只是不再关联推演）
  entries（scope.kind === 'limited'，targets 里有 scenarioId === S 且 fromNodeId 非空、不在 live 里的项）：
      去掉这一项 target；targets 因此为空时软删除条目（进回收站，可恢复）
```

- 去掉 target 而不是把 `fromNodeId` 改成 null：改成 null 会让「只在某分支出现的人物」变成整个推演可见，悄悄扩大可见范围；去掉后它在这个推演里不可见，作者可以在条目编辑里重新指定。targets 为空的限定条目在任何地方都不可见，留在知识库里只会让人困惑，所以进回收站。
- 被清理的行在快照里出现过时（同 id 的行来自备份），它们引用的节点必然在快照里，已由 `superRefine` 保证，清理不会命中它们 —— 清理只作用于本地独有的行。
- `nodeIds` 被裁掉一部分的大纲节点，`sedimentCoverage` 照常判定（剩下的步骤不全在主线上就标「来自旧主线」）。
- 实现位置：`DexieNovelRepository` 的私有函数 `pruneScenarioRefs(tx, novelId, scenarioId)`，只在 merge 分支调用；覆盖恢复（replace）分支整份来自快照，`superRefine` 已保证一致，不需要。

不检查：限定条目的 `targets[].scenarioId` 是否存在 —— 推演删除后它进回收站或留作孤儿是合法状态（见 §6.2），它只是在任何推演里都不可见。

---

## 5. 生成

### 5.1 task profile（`src/llm/taskProfiles.ts`）

| TaskKind              | thinking | effort | 温度 | 重点模型 | structured | 理由                                                                                                                                                                                                                                      |
| --------------------- | -------- | ------ | ---- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interactive-step`    | 关       | —      | 0.85 | 否       | 是         | 输出以散文为主，按第 9 节第 3 条「正文创作关思维链」；关思维链还让首字更快出来，流式才有游戏感。温度比整章（0.95）低一档：尾部 JSON 要记账准确、选项要守规则；没有思维链对规则的遵守由代码层 `sanitizeDelta` 兜底。每步都调用，用常规模型 |
| `interactive-ending`  | 关       | —      | 0.85 | 否       | 是         | 与步骤同参：系统提示逐字节相同以共享缓存，语气也要和前面的步骤一致。单列一个 profile 是为了任务名与以后单独调参                                                                                                                           |
| `interactive-options` | 关       | —      | 0.9  | 否       | 是         | 只要几条不同的选项，要多样性                                                                                                                                                                                                              |
| `interactive-summary` | 开       | medium | 0.2  | 否       | 是         | 与 `chapter-summary` 同理：摘要忠实、不发挥                                                                                                                                                                                               |
| `path-to-outline`     | 开       | high   | 0.4  | **是**   | 是         | 大纲规划（第 9 节：立项与大纲用重点任务模型、开思维链）。温度比 `outline-expand`（0.8）低：这是把已有内容分章，不是发明情节                                                                                                               |

`TaskProfile.label`（必填）分别为「互动推演 · 一步」「互动推演 · 收尾」「互动推演 · 再给选项」「互动推演 · 前情摘要」「推演沉淀为大纲」。

与 `norm-condense` / `norm-check` 一致，不加进设置页的 `TASK_ORDER`，避免改设置页。

### 5.2 流式正文 + 结构化尾部（`src/llm/proseTail.ts`，新增）

```ts
export const PROSE_TAIL_SENTINEL = '@@@STATE@@@';

export interface ProseTailOptions<T> {
  client: LlmClient;
  model: string;
  schema: z.ZodType<T>;
  schemaName: string;
  system: string;
  user: string;
  temperature?: number;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /** 只回调分隔符之前的正文（累计值，不是增量），流式显示用 */
  onProse?: (proseSoFar: string) => void;
  maxRepairAttempts?: number; // 默认 1
}
export interface ProseTailResult<T> {
  prose: string;
  data: T;
  attempts: number;
  usage?: TokenUsage;
}
export async function generateProseWithTail<T>(
  options: ProseTailOptions<T>,
): Promise<ProseTailResult<T>>;
export function splitProseAndTail(content: string): { prose: string; tail: string | undefined };
```

流程：

1. `system` 末尾追加固定的【输出格式】块（正文 → 单独一行分隔符 → JSON，JSON Schema 用 `z.toJSONSchema(schema, { io: 'output' })`，与 `structured.ts` 同一转换）。不设 `responseFormat`（整体不是 JSON）。
2. `client.streamChat`；`onText` 累加，`onProse(visibleProse(累计文本))`。`visibleProse`（导出，纯函数）：有完整 `PROSE_TAIL_SENTINEL` 时截到第一个之前；没有时去掉末尾「是 `PROSE_TAIL_SENTINEL` 某个前缀」的最长后缀（例如结尾的 `@`、`@@@STA`）。流式显示与 `splitProseAndTail` 都只认完整分隔符，口径一致。
3. `finishReason === 'length'` → 抛 `LlmError('truncated', '这一步写得太长被截断了，没有保存')`，不修复（残缺正文修不回来）。
4. `splitProseAndTail`：按**最后一个**分隔符切；找不到分隔符时 `tail = undefined`，`prose = content`。`prose.trim()` 为空 → 抛 `LlmError('parse', '模型没有写出情节')`。
5. `extractJsonText(tail)` + `JSON.parse` + `schema.safeParse`（复用 `structured.ts` 导出的 `extractJsonText` / `formatZodIssues`）。成功即返回。
6. 失败 → 非流式 `client.chat`，`responseFormat: json_object`，消息为 `[system, user, assistant(首轮全文), user('上面分隔符之后的结构化数据不符合要求：…\n请只输出修正后的完整 JSON，不要正文、不要分隔符')]`；修复响应 `finishReason === 'length'` 同样抛 truncated；校验通过则 `prose` 用首轮的。次数用完抛 `LlmError('parse', '模型输出不符合预期格式（已重试 1 次）', { detail })`。
7. `signal` 取消 → 底层抛 `aborted`，原样上抛。

`useLlm` 的 `LlmRunner` 加 `runProseWithTail(task, options)`，参数按 profile 填，与 `runStructured` 写法一致；现有两个方法不动。

### 5.3 一步的编排（`src/features/scenario/useScenarioRunner.ts`）

`advance(input: { scenarioId, parentId: string | null, action: { kind: 'option', optionId } | { kind: 'free', text } | { kind: 'start' } | { kind: 'wrap-up', goalId, note } })`：

1. **前置检查**（不发请求）：模型已配置；父节点不是结局；选项未走过 / 自由输入通过 D2.1（规范化后与未走过选项相同则改成选该选项）；主角条目存在且未删除。
2. **读最新数据**：`getScenario`、`listScenarioNodes`、`listEntries(novelId, { scope: 'all' })`、`listCategories`、`getStyleProfile`、`listWritingNorms` —— 与摘要面板、导入循环一样在发请求前从仓储读，不用组件里的旧对象。
3. **前情检查**：`checkpointsToFill(path, parent.depth)` 非空时按 D5.3 处理：`gap > 7` 同步按顺序补齐（失败则本步不生成），否则交给后台补、本步继续。
4. **组 prompt**：`buildScenarioSystemPrompt(...)`、`buildStepUserPrompt(...)`（§5.4），同时产出注入清单。
5. **生成**：`runProseWithTail('interactive-step' | 'interactive-ending', …)`，`onProse` 驱动界面流式显示。
6. **解析**：`resolveStepChanges` → `delta + notices`（`ocChanges` 的 `castId` 由代码填 `cast[0].id`；预设条目的隐含揭示见 §3.4）；选项分配 id；目标 / 里程碑序号解析成 id；结局 `goal` 解析失败或类型不一致则 `goalId = null` 并记提示。
7. **落库**：`appendScenarioNode`（事务内二次检查 + 二次 `sanitizeDelta` + 改主线与 cursor）。
8. **检查点**：新节点 `depth % 5 === 4` 时后台 `summarizeCheckpoint(node)`，不 await（经 D5.3 的在途 `Set` 去重）。

生成中刷新或关页面：只有第 7 步才写库，所以不会有半截节点；已有节点不受影响（F13.2）。**在应用内离开推演页**（返回写作页、切 Tab、跳到别的路由）同理：`useScenarioRunner` 在卸载的 effect cleanup 里 `abort()` 全部在途请求（本步、再给选项、后台摘要），什么都不存，与「停止」一致；`aborted` 错误在已卸载时不更新状态。放弃「离开后在后台继续生成并落库」：作者回来看到一个没看着它生成的新节点、主线还被它改了，违反「主线跟着作者的推进走」。

`regenerateOptions(nodeId)`：读最新数据 → `buildOptionsUserPrompt`（§5.4）→ `runStructured('interactive-options', { schema: OptionsBatchSchema })` → 代码按 `normalizeAction` 与已有选项去重 → `appendScenarioOptions`。`summarizeCheckpoint(node)`：按 D5.3 取输入 → `runStructured('interactive-summary', { schema: SummaryOutSchema })` → `setScenarioNodeSummary`。

### 5.4 提示词（`src/features/scenario/scenarioPrompt.ts`，新增）

全部纯函数、逐字节可复现：按显式数组顺序拼接，条目按 `title` 的码元序 + id 兜底排序（不用 `localeCompare`），不含时间戳与 token 数。

```ts
export function buildScenarioStablePrefix(input: {
  novel;
  style;
  norms;
  categories;
  entries;
  scenario;
}): { text: string; items: ScenarioContextItem[] };
export function buildScenarioSystemPrompt(stablePrefix: string): string; // = composeSections([OPENER, stablePrefix, SCENARIO_RULES])
export function buildStepUserPrompt(input: {
  knowledge: EffectiveKnowledge;
  path: ScenarioNode[];
  scenario;
  entries;
  categories;
  action;
}): { text: string; items: ScenarioContextItem[] };
export function buildOptionsUserPrompt(input: {
  knowledge: EffectiveKnowledge;
  path: ScenarioNode[];
  scenario;
  entries;
  categories;
  excludedEntryIds: ReadonlySet<string>;
}): string; // path 以当前节点结尾
export function buildSummaryUserPrompt(input: {
  previous: { text: string; openThreads: string[] } | null;
  steps: ScenarioNode[];
}): string;
export function renderWorldlineState(knowledge: EffectiveKnowledge, categories): string; // 【本线变化】，沉淀注入复用
export function renderScenarioEntry(entry, category, lockOf): string; // 与 renderEntry 同格式，锁定字段后加「（底层，不可改变）」
```

`OPENER`：「你是一部互动小说的叙事导演兼执笔者。作者操控主角在下面的世界里做选择；你负责写出每一步的情节、提出下一个挑战，并如实记录这一步给世界带来的变化。」

`SCENARIO_RULES`（常量全文）：

```text
【推演规则】
1. 情节写 300–600 字，用作品的叙述视角，只写这一步。结尾停在挑战出现的时刻，不替主角做决定。
2. 作者给出的行动是主角的「尝试」。按世界规则判定结果：可行就写出成败与代价；违背标有「底层，不可改变」的设定（凭空获得能力、无视代价）时，写主角尝试、失败及其后果，不能让它成真。
3. 挑战必须从上一步行动的后果、下一个里程碑、尚未收束的线索三者中至少一个生长出来，不要凭空引入与目标无关的新危机。
4. 每一步最多引入两个新的人物、地点或物件。导演提示进入收束阶段或超出预计步数后，不再引入新人物与新线索，优先回收已有线索。
5. 选项 2–4 个，倾向彼此不同，都在世界规则内可行。选项文字只写主角要做什么，不写结果；风险只按主角此刻看得见的危险标注。
6. 结局只有当此前的选择与状态直接导致时才触发，cause 写清是哪个选择或哪种状态导致的。不得靠突发外力（天降援兵、意外暴毙、突然揭晓真相）制造结局，也不要为了赶上预计步数而强行转折。允许坏结局，包括主角死亡与目标彻底失败。触发结局时不再给选项。
7. changes 只记录这一步真正发生、会影响后续的变化。条目名用上文出现过的正式名称；不得改写标有「底层，不可改变」的字段；人物死亡、失踪等写进 statusChanges；世界规则类设定不会死亡或被毁。
8. 下文「本线变化」与上文设定冲突时，以「本线变化」为准（底层字段除外）。
9. 目标用 G1、G2…，里程碑用 M1、M2… 的序号引用。
```

用户提示的块顺序见 D5.1；`action` 渲染：

| action  | 渲染                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start   | 「【本次行动】这是开局：从上面的起点写起，引出第一个挑战。」                                                                                             |
| option  | 「【本次行动】主角选择：{option.text}」                                                                                                                  |
| free    | 「【本次行动】作者为主角输入的尝试：{text}\n（这是尝试，不是既成事实。按推演规则第 2 条判定结果。）」                                                    |
| wrap-up | 「【本次要求】作者要求收尾：在这一步写出结局（ending 必填，options 为空）。{目标：Gk …}{作者说明：…}从当前状态自然得出；做不到圆满就写开放或中性结局。」 |

**「再给几个选项」与「检查点摘要」**（两个结构化任务，都走现有 `runStructured`）：

```ts
// src/features/scenario/stepSchema.ts
export const OptionsBatchSchema = z.object({ options: z.array(OptionOut).min(2).max(4) });
export const SummaryOutSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  openThreads: z.array(z.string().trim().min(1).max(120)).max(8),
});
```

- **system 都用 `buildScenarioSystemPrompt(stablePrefix)`**，与步骤共用到【推演规则】结束为止的全部内容；之后由 `generateStructured` 在末尾追加它自己的 JSON Schema 块（步骤则由 `generateProseWithTail` 追加分隔符说明 + 步骤 schema）。所以几类请求在【推演规则】之前逐字节相同，具备命中同一份前缀缓存的条件。是否真的命中由服务端决定：步骤 / 收尾 / 再给选项都关思维链，参数一致，命中条件最好；前情摘要开思维链，服务端在 thinking 开 / 关两种模式之间是否共享前缀缓存没有核实，设计不依赖它（摘要每 5 步才一次，未命中的代价可以接受）。放弃「摘要用一个独立的短 system」：短 system 每次都是冷前缀，复用推演前缀至少不比它差、命中时更省；且摘要需要知道作品文风与人物，才能写出可回灌的前情。
- **options 的 user**：沿用 `buildStepUserPrompt` 的第 1–7 块（以**当前节点**为最后一步：【最近几步】包含当前节点本身的情节与挑战，【本线变化】累计到当前节点），第 8 块换成：

```text
【本次要求】这一步的挑战是：{challenge}
这一步已有的选项：
1. {text}（{倾向}）
……
这一步走过的其他行动：{自由输入原文，逐条}
再给 2–4 个主角面对这个挑战时可以做的事：倾向与上面的都不同、文字不同，都在世界规则内可行；只写做什么，不写结果；风险只按主角此刻看得见的危险标注。只输出 options。
```

- **summary 的 user**：

```text
【上一段前情】{previous.text，或「（从开局写起）」}
尚未收束的线索：{previous.openThreads 逐条，或「（无）」}
【这几步的经过】
第 k 步 · {行动}
{情节原文}
……
【本次要求】把上一段前情与这几步合成一段新的前情摘要（≤ 600 字，只写已发生的事，不评论、不预测），并列出到这里为止仍未收束的线索（≤ 8 条，已收束的去掉）。
```

`steps` 是 D5.3 补齐算法给出的那一段（祖先 A 之后到检查点 K）。

- `scenarioPrompt.test.ts` 断言：步骤、收尾、options、summary 四种请求的 system 在【推演规则】块结束处之前逐字节相同。

---

## 6. 仓储

### 6.1 `NovelRepository` 新增 / 改动

```ts
// ------------------------------------------------ 知识条目（改动）
export interface EntryQuery {
  // ...现有字段
  /**
   * 'worldview'（默认）：只返回作用范围为通用的条目 —— 现有写作链路看到的就是它，
   * 限定到推演的条目不会泄漏进去。'all'：含限定条目，给知识库页、回收站、收件箱、推演用
   */
  scope?: 'worldview' | 'all';
}
// findEntryByName：只匹配通用条目（反向提取是世界观层的操作）

/** 与 createEntry / updateEntry 现有参数类型相同的别名（新增导出，只为 promoteLineEntry 的签名可读） */
export type EntryCreateInput = Pick<KnowledgeEntry, 'categoryId' | 'title'> & Partial<KnowledgeEntry>;
export type EntryUpdateInput = Partial<KnowledgeEntry>;

// ------------------------------------------------ 互动推演
listScenarios(novelId: string): Promise<Scenario[]>;            // 按 lastAdvancedAt ?? updatedAt 倒序
getScenario(id: string): Promise<Scenario | undefined>;
/** 新建；newOc 非空时在同一事务里建一条限定到本推演的人物条目，并把它作为 cast[0] */
createScenario(novelId: string, input: {
  title: string;
  setup: Omit<ScenarioSetup, 'cast'> & { cast: { entryId: string }[] };
  newOc?: { categoryId: string; title: string; fields: Record<string, string> };
}): Promise<Scenario>;
/** 只改名称与开局设定里可改的部分（目标、里程碑、基调、预计步数）；主角与起点改不动 */
updateScenario(id: string, patch: { title?: string; setup?: Partial<Pick<ScenarioSetup, 'goals' | 'milestones' | 'tone' | 'expectedSteps'>> }): Promise<Scenario>;
/**
 * 事务：删推演与全部节点；清掉指向它的 scenarioSource；trashScopedEntries 为真时把「targets 只含这一个推演」的
 * 限定条目软删除（限定到多个推演的条目只从 targets 里去掉这一项）。UI 见 §8.3「删除推演」
 */
deleteScenario(id: string, options: { trashScopedEntries: boolean }): Promise<void>;
listScenarioNodes(scenarioId: string): Promise<ScenarioNode[]>;
/** 推进。事务内检查（见 §2.4）、sanitizeDelta、写节点、mainNodeId = cursorNodeId = 新节点 */
appendScenarioNode(scenarioId: string, input: Omit<ScenarioNode, 'id' | 'novelId' | 'scenarioId' | 'depth' | 'pathSummary' | 'deltaEditedAt' | 'createdAt' | 'updatedAt'>): Promise<{ node: ScenarioNode; scenario: Scenario }>;
setScenarioCursor(scenarioId: string, nodeId: string): Promise<void>;
/** 作者编辑差异：sanitizeDelta 有任何提示即抛错不写；成功时写 deltaEditedAt */
updateScenarioNodeDelta(nodeId: string, delta: WorldlineDelta): Promise<ScenarioNode>;
/** 「再给几个选项」：去重后追加，总数 ≤ 8，batch = 现有最大 batch + 1 */
appendScenarioOptions(nodeId: string, options: Omit<ScenarioOption, 'id' | 'batch'>[]): Promise<ScenarioNode>;
setScenarioNodeSummary(nodeId: string, summary: { text: string; openThreads: string[] }): Promise<ScenarioNode>;
/**
 * 提升本线新条目，一个事务：create = 建世界观条目（通用）；mergeInto = 更新已有同名通用条目。
 * 两种都把本线条目标为 promotedEntryId
 */
promoteLineEntry(input: { nodeId: string; localId: string } & ({ create: EntryCreateInput } | { mergeInto: string; patch: EntryUpdateInput })): Promise<KnowledgeEntry>;
/** 沉淀提案的落库入口（applyProposal 调用）。主线：追加大纲；外传：建外传与章节。一个事务 */
commitScenarioOutline(novelId: string, plan: ScenarioOutlinePlan): Promise<void>;
```

另外：`deleteNovel` 的表列表加两张新表；`exportSnapshot` / `importSnapshot` 加两张新表（merge 模式下 `scenarioNodes` 按推演整棵替换，替换后在同一事务里用 `pruneScenarioRefs` 清理本地行里指向已删节点的 `scenarioSource` 与 `fromNodeId`，见 §4.2 末尾，不是逐行 `bulkPut`）；`hardDeleteEntry` 在条目是某推演主角时抛「这个条目是推演《X》的主角，先删除推演」；`updateEntry` 不变（scope / fieldLocks 走普通 patch，schema 校验）。

### 6.2 失败条件与调用方收到什么

| 方法                      | 失败条件                                                                                                               | 调用方收到                                                                                                                                     | 可恢复                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `createScenario`          | 名称 / 设定不合法                                                                                                      | `ZodError`（UI 先用 `validateScenarioSetup` 预检，返回第一条中文错误，正常走不到）                                                             | 是，改表单                     |
|                           | 选择的主角条目不存在或已删除                                                                                           | `Error('选中的人物已不存在')`                                                                                                                  | 是                             |
| `updateScenario`          | 推演不存在                                                                                                             | `Error('这个推演已不存在，可能已被删除')`                                                                                                      | 否，返回写作页                 |
| `appendScenarioNode`      | 推演不存在                                                                                                             | 同上                                                                                                                                           | 否                             |
|                           | 根已存在却传 `parentId: null`                                                                                          | `Error('这个推演已经开过局了')`                                                                                                                | 否（UI 不会发出）              |
|                           | 父节点不存在 / 不在本推演                                                                                              | `Error('要接着走的那一步已不存在')`                                                                                                            | 否                             |
|                           | 父节点是结局                                                                                                           | `Error('这条线已经结束，不能继续推进')`                                                                                                        | 否                             |
|                           | 同一选项 / 自由输入 / 收尾已有子节点                                                                                   | `Error('这个选择刚刚已经走过了')`                                                                                                              | 是：UI 刷新并给「去那条线」    |
|                           | 节点不合法                                                                                                             | `ZodError`                                                                                                                                     | 否（生成管道已校验，只是兜底） |
| `updateScenarioNodeDelta` | 节点不存在                                                                                                             | `Error('这一步已不存在')`                                                                                                                      | 否                             |
|                           | 覆盖锁定字段 / 引用不存在 / 字段不在模板                                                                               | `Error(提示文案)`                                                                                                                              | 是，改输入                     |
| `appendScenarioOptions`   | 去重后不足 2 个或已满 8 个                                                                                             | `Error('没有新的选项')` / `Error('这一步的选项已经够多了')`                                                                                    | 是                             |
| `promoteLineEntry`        | 本线条目不存在或已提升                                                                                                 | `Error('这个本线条目已经提升过了')`                                                                                                            | 否                             |
| `commitScenarioOutline`   | 推演或节点不存在；外传名重名（沿用 `createSideStory` 的检查）；追加目标外传已不存在（`Error('要追加的外传已不存在')`） | `Error(…)`，事务回滚，提案保持待确认                                                                                                           | 是，改提案                     |
| `promoteLineEntry`        | `mergeInto` 的条目已删除                                                                                               | `Error('要合并进的条目已不存在')`                                                                                                              | 是，重新提升                   |
| `hardDeleteEntry`         | 条目是推演主角                                                                                                         | `Error('这个条目是推演《X》的主角，先删除推演')`；唯一调用方 `TrashSheet.purge()` 捕获后在确认框内 `role="alert"` 显示，条目留在回收站（§8.5） | 是：先删推演或保留条目         |
| `deleteScenario`          | 推演不存在                                                                                                             | `Error('这个推演已不存在，可能已被删除')`，确认框内显示                                                                                        | 否，返回写作页                 |

日志：与现有仓储一致，**不打日志**，错误以异常交给 UI，UI 以 `role="alert"` 显示 `message`。生成管道里的 `LlmError` 同样只在界面显示（含 `detail` 的一行小字），不写控制台。

---

## 7. 提升为世界观、沉淀为小说

### 7.1 提升（`src/features/scenario/promote.ts`）

| 差异类型                                                     | 可否提升                                                                 | 提案                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字段覆盖（世界观条目、字段当前可变）                         | 可以                                                                     | `knowledgeEntry:replace`，`buildReplaceProposal({ specs: entryFieldSpecs(category), targetId, current, payload })`，`payload` = 当前条目的完整数据、只把 `fields[key]` 换成覆盖值；界面显示字段级 diff（只有这一栏有变化）。**不用 merge**：`mergeEntities` 对 list 字段取并集，而世界线覆盖的语义是替换（「关系网」被本线改写后提升，应该是新值，不是新旧拼在一起） |
| 字段覆盖（字段现为锁定）                                     | 不可以                                                                   | 不生成提案，说明见 D6.3                                                                                                                                                                                                                                                                                                                                              |
| 字段覆盖（目标是本线条目，或已提升的本线条目的别名）         | 本线条目未提升时随它一起提升；已提升时按上一行（目标就是那条世界观条目） | —                                                                                                                                                                                                                                                                                                                                                                    |
| 本线新条目，无同名通用条目                                   | 可以                                                                     | `knowledgeEntry:create`，payload = 本线条目在当前节点处的有效值（含后代节点之前的覆盖）+ `promoteFrom: { nodeId, localId }`；新条目作用范围为通用                                                                                                                                                                                                                    |
| 本线新条目，已有同名（title ∪ aliases 规范化匹配）的通用条目 | 可以，改成合并                                                           | 提示「知识库里已有『X』，将合并进这个条目而不是新建」；`knowledgeEntry:merge`（`buildMergeProposal`，与反向提取的同名合并一致），payload 带 `promoteFrom`，采用时调 `promoteLineEntry` 的「标记到已有条目」分支（只写 `promotedEntryId`，不新建）                                                                                                                    |
| 状态、主角状态、事件、标记                                   | 不可以                                                                   | 界面说明：「世界观条目没有『状态』这一栏；某人在这条线上死了，是这条线的剧情，不是全书设定。要写进全书，请沉淀成章节」                                                                                                                                                                                                                                               |

`applyProposal` 的 `knowledgeEntry:create` / `knowledgeEntry:merge` 分支：payload 加可选 `promoteFrom`；有它时调 `repo.promoteLineEntry`（一个事务：create 建条目 + 标记，merge 更新已有条目 + 标记），没有时行为与现在完全相同（`apply.test.ts` 现有用例不改）。`promoteLineEntry` 的签名相应为 `{ nodeId, localId } & ({ create: EntryCreateInput } | { mergeInto: string; patch: EntryUpdateInput })`（两个别名定义在 §6.1，与 `createEntry` / `updateEntry` 现有的参数类型相同）。三种提升提案的 `origin` 都是 `'refine'`：提案内容不是这次调用模型生成的，而是把已有的推演产出整理成世界观条目（`ProposalOrigin` 只有 `generate / extract / refine`，不新增）。提升后该本线条目在有效知识里成为指向世界观条目的别名（§3.2），原线后续的变化继续作用在它身上，兄弟分支看到的是它的世界观原文 —— 这就是「成为全书事实」的含义。

提案出现在知识库页顶部的待确认区（条目归知识库，第 7 节约定）；状态面板里点「提升」后显示「已生成待确认项，到知识库确认」与跳转按钮。确认前世界观层不变（验收 24）。

### 7.2 沉淀（`src/features/scenario/pathOutline.ts` + `SedimentSheet.tsx`）

1. 作者在某个节点点「沉淀这条线」。模式由位置决定：当前节点在主线上 → 主线；否则 → 外传（F11.3）。
2. 计算范围（`sedimentRange`，纯函数，步数都是绝对步数）：
   - 主线 = `[a, b]`：「已覆盖」指被某个非过期、`scenarioSource` 非空的章级大纲节点的 `nodeIds` 包含（只看本推演的）。`a` = 根到当前节点路径上第一个未覆盖的步骤；`b` = `a` 之后第一个已覆盖步骤的前一步，没有这样的步骤时 `b` = 当前节点。面板写「补沉淀第 a–b 步」（`b` 不是当前节点时）或「沉淀第 a–b 步」。理由：作者删掉中间某章的大纲节点后，从第一个洞一直取到当前节点会把洞之后已覆盖的步骤再沉淀一遍；一次只补一个连续的洞，补完后再点一次就到下一个洞或末尾，每次的提案都是一段连续步骤，`buildPathOutlineSchema(a, b)` 的首尾相接校验不需要改。补洞产生的卷与普通续沉淀一样追加在顶层末尾（面板提示「补出的卷会放在大纲末尾，可在大纲树里用『调整位置』移到第 X 卷之后」）：不自动插进中间，因为洞两侧的卷可能已被作者改名、拆分，按位置猜插入点不可靠，而大纲树已有上移 / 下移。
   - 外传且**没有可追加的外传** = 分叉节点之后到当前节点，新建外传（`forkNodeId` 按 D8.1 现算）。
   - 外传且**有可追加的外传**《X》= 默认「追加到外传《X》」。「可追加」的判定**不比较 `forkNodeId`**：《X》满足 `scenarioSource.scenarioId === 本推演`，且当前节点在《X》最后一章 `scenarioSource.nodeIds` 最后一步（记为 `L`）的子树里（`L` 本身不算，那样范围为空）；有多部满足时取 `L` 的 `depth` 最大的一部，同深按 `createdAt`、`id` 兜底。范围从 `L` 的下一步到当前节点；采用时新章节追加在《X》末尾（`order` 接着排），不改《X》的名称、简介与 `forkNodeId`（提案的外传名称 / 简介两栏留空不渲染）。不比较分叉点的理由：分叉点是相对「沉淀时的主线」算的，主线一换，同一条线重新算出的分叉点就变了，用它判定会让「追加」无故消失。当前节点不在任何外传最后一步的子树里时（作者从《X》中途另开了分支）不提供追加，只能另建。面板里同时给单选「另建一部外传」，选它就回到上一条规则。理由：玩家继续玩同一条外传线是最常见的情形，每次都新建一部外传会把一条线切成好几部；但从外传中途分出去的是另一条线，不能硬接。
   - 范围为空时按钮禁用并说明「这条线已经全部沉淀」。
3. 面板显示：范围（第 a–b 步，共 n 步）、模式、主线已有大纲规模 / 其他推演的大纲提示、预估输入 tokens；作者点「生成大纲」才发请求（重点任务模型）。
4. `runStructured('path-to-outline', { schema: buildPathOutlineSchema(a, b), system, user })`。system = 开场白 + `composeStylePrefix` + 规范（作用范围「规划」，与细化大纲一致：产出的是本书大纲）+ 任务说明；user = 范围内各步的行动与情节原文 + 本书已有顶层卷名（便于续接卷名编号）+ 外传模式的分叉前情。
5. 结果 → `serializeScenarioOutline`（D7.2 的文本格式）→ `buildCreateProposal({ target: 'scenarioOutline', origin: 'generate', payload: { scenarioId, mode, range: { from: a, to: b }, nodeIds, forkNodeId, appendToSideStoryId, sideTitle, sideSynopsis, outlineText } })`（`appendToSideStoryId` 只在「追加到外传」时非空），同批号；面板内嵌 `ProposalInbox batchId`。
6. 采用 → `applyProposal` 新分支 `scenarioOutline:create` → `parseScenarioOutline(outlineText, { from: a, to: b, pathNodeIds })`（在 `parseOutlineTree` 结果上只把「对应步骤：」行剥出来换成 `nodeIds`；「关键事件：」「出场：」留在 `synopsis`，「出场：」另解析出通用条目 id 写 `linkedEntryIds`；步骤范围不合法抛错）→ `repo.commitScenarioOutline`（payload 带 `appendToSideStoryId` 时走追加分支）。
7. 确认前大纲树、外传列表都不变（验收 25）。

`fieldSpecsFor('scenarioOutline')` = `[sideTitle（外传名称）, sideSynopsis（外传简介）, outlineText（大纲内容）]`；主线模式两个外传字段为空，按现有规则两边都空的字段不渲染。

### 7.3 「写这一章」（`src/features/scenario/chapterContext.ts` + `ChapterEditorScreen.tsx`）

- `ChapterEditorScreen` 判定来源：主线章节取 `outline.find(n => n.id === chapter.outlineNodeId)?.scenarioSource`，外传章节取 `chapter.scenarioSource`。非空时 `useRepoQuery` 读该推演、它的节点、全部条目（`scope: 'all'`）与分类，用 `buildScenarioChapterContext(...)` 算出 `{ label, limitedText, limitedLabel, forkText, stepsText, stateText }`（D7.3 的四块，`limitedText` / `forkText` 可为空串，空串的块不渲染、不进清单），**只**合进传给 `GenerateChapterSheet` 的 `context`（`{ ...context, targetChapterId, scenarioContext }`），不改共享的 `context`，`ReviseSheet` 及其他面板拿不到它。为空时与现在完全相同，不多一次查询。
- 主角条目被软删除时，【本章涉及的推演专属设定】里不再有它（只取未删除条目），面板一行提示「推演主角『X』在回收站里，本章不会带上他的档案」。
- 推演已删除（`scenarioSource` 已被清空）或节点缺失时不注入，面板里显示一行「来源推演已不存在，本章只按大纲生成」。
- 段落加工、摘要、检查不注入推演材料（第一期范围：正文由整章生成产出，加工针对已有正文）。

---

## 8. 界面

### 8.1 写作页卡片（`ScenarioEntryCard.tsx`）

在「全书进度」之前（空作品的 EmptyState 之前也渲染）。一行：标题「互动推演」、数量、最近推进的推演「继续《X》第 k 步」主按钮、「全部推演」次按钮（打开 `ScenarioListSheet`：列表 + 新建）。没有推演时只显示「互动推演：把主角放进这个世界，一步步选择走向结局，再沉淀成大纲」+「开始一局」。列表每项：名称、主角名、节点数、主线步数、是否已有结局（「已到达 2 个结局」）、最后推进时间；点开进推演页。

### 8.2 开局设定（`ScenarioSetupSheet.tsx`）

`Sheet`（移动端底部全屏抽屉，桌面右侧抽屉）。字段与校验见 D4.1。结局目标与里程碑用「添加」按钮 + 每行「上移 / 下移 / 删除」按钮（不拖拽，5.4）。编辑模式下主角与起点只读并说明「开局之后不能改主角和起点；想换就新建一个推演」。

### 8.3 推演页（`ScenarioPage.tsx`，路由 `/write/scenario/:scenarioId`）

单套 DOM，自上而下：

0. **外层与加载**：`ScenarioPage` 外层用 `RequireNovel title="互动推演"`（与知识库、写作、计划页一致：没有当前作品时显示它的「先选一部作品」状态，F1.2）。推演按 `:scenarioId` 读取：读取中显示现有的加载占位；推演不存在显示「这个推演已不存在」+「回写作页」按钮；推演属于其他作品显示「这个推演属于另一部作品」+「去书架」。**落点节点**：`cursorNodeId` 指向本推演的节点时用它；为 null 或指向不存在的节点（例如手改过的备份）时回落到 `mainNodeId`，再不行回落到根节点；树为空走下面的「还没开局」。回落只在内存里决定显示哪个节点，不写库、不发请求（作者下一次跳转或推进才会写 `cursorNodeId`）。
1. **页头**：返回写作页、推演名、状态徽标（D1.3）、「更多」菜单（开局设定、重命名、删除、沉淀这条线、收尾）。
2. **面包屑**（`<nav aria-label="当前路径">` + `<ol>`）：「开局 › 第 2 步 › … › 第 7 步」，每项是按钮（触控目标 ≥ 44px），当前项 `aria-current="step"`，主线上的项带「主线」小字。全部项都在 DOM 里；窄屏用 CSS 只显示首项、末两项与一个「…」按钮（点开世界线导航），`md` 起完整换行显示。
3. **正文区**（`reading-column`，桌面限宽 46rem）：本步标题「第 k 步 · 你选择了：…」、情节（流式时 `aria-live="polite"`）、被丢弃内容的提示条（有 `notices` 时：「这一步有 2 处变化没有记下」，点开看明细）、「生成时依据的是旧事实」提示（祖先差异被编辑过时）。
4. **挑战与选项**：挑战文字；选项是大按钮（整行、≥ 48px 高），带倾向与风险标签（文字 + 颜色，不只靠颜色）；已走过的选项 `disabled` + 「已走过」+ 旁边「去这条线」按钮；「这一步走过的其他行动」列表；「再给几个选项」（全部走过且 < 8 时）。
5. **自由输入**：`TextAreaField`（label「或者，写下主角要做的事」），字数计数，提交按钮「这样做」；桌面 `⌘/Ctrl+Enter` 提交，`isComposing` 时不响应。
6. **结局**：结局节点替换 4、5：结局徽标（好 / 坏 / 中性 + 标题）、「起因：…」、「回到上一个挑战」主按钮、「从路径里选一步回去」（打开导航）。坏结局额外一行「这条线到此结束，但你可以回到任何一步重新选择」。
7. **底部操作栏**（`sticky bottom`，移动端在安全区之上）：「世界线」「本线状态」「收尾」，图标 + 文字。

生成中：选项区换成流式情节与「停止」按钮；停止 = `abort`，什么都不存，回到选择前。失败：`role="alert"` 显示原因 +「重试」（用同一个行动重试，不需要重选）。生成中点页头「返回」或离开路由：组件卸载时 `abort()`，什么都不存（§5.3），回来时停在原来的节点。

**还没开局（0 个节点）**：`createScenario` 成功后开局生成失败、作者点了停止、或开局生成中离开页面，推演存在但树是空的。此时 2–6 区换成一块「还没有开局」说明（起点处境、主角名）+ 主按钮「开始」（以 `{ kind: 'start' }` 再发一次），生成失败时同样显示 alert +「重试」；面包屑不渲染；底部操作栏的「世界线」「本线状态」「收尾」`disabled` 并带 `aria-disabled` 说明「开局之后可用」；「更多」里只有开局设定、重命名、删除。写作页卡片上它显示「《X》· 还没有开局」。

**「本步依据」**（正文区下方，`<details>`，默认折叠，摘要行「本步依据 · 约 X tokens」）：分组列出 D5.4 的各项与 token 估算；【本线相关设定】的推断条目每条一个 `checkbox`（label 为条目名 +「（推断）」），取消后摘要行的 token 数立即更新，并显示「已取消 n 条，下一步不会带上」。勾选状态放在推演页的 `useState`（`Set<entryId>`），不进 store、不落库。

**删除推演**（「更多」→「删除」）：推演页自己用 `Sheet size="dialog"` 拼一个确认框（`DeleteScenarioDialog.tsx`），**不用、也不改共享的 `ConfirmDialog`**（它只接受字符串 `message`，放不下复选框；改共享组件会波及所有调用点）。内容：标题「删除推演《X》？」，正文「全部 N 步和分支会被永久删除；已沉淀的大纲、外传与章节保留，只是不再关联这个推演。」，下方一个复选框「同时把只属于这个推演的条目（含主角『Y』）移进回收站」，**默认勾选**，旁注「移进回收站的条目可以恢复；不勾选时它们留在知识库里，作用范围仍是这个推演，但不会出现在任何地方，可以改成通用」。没有限定条目时不显示复选框。复选框用原生 `<input type="checkbox">` + `<label>`（与「本步依据」一致），底部「取消」「删除」两个按钮，「删除」用破坏性样式；`deleteScenario` 失败时在框内 `role="alert"` 显示 `message`、框保持打开。理由：新建的 OC 大多只为这一局存在，默认清走更符合预期；进回收站可逆，所以默认勾选不危险。

跳转（面包屑、导航、去这条线）只调 `setScenarioCursor`，界面从内存里的树换节点，不发请求。

**世界线导航**（`WorldlineNavigatorSheet.tsx`，`Sheet`）：

- 顶部：「回到主线最新一步」。
- 「当前路径」有序列表：每步一行（第 k 步 · 行动摘要 · 「主线」标签 · 当前标记），行内按钮「跳到这一步」。每步下面缩进列出**不在当前路径上的分支**：「另一条线：选『b』· 已走 4 步 · 坏结局『坠崖』」，两个按钮「看分叉处」「去这条线的最新一步」（`latestLeafOf(subtree)`：该分支子树里 `depth` 最大的节点，`createdAt` 次之，`id` 码元序兜底 —— 不只按 `createdAt`，原因同 D1.1，合并导入后两台设备的时钟可能不一致）。
- 「已到达的结局」：本推演所有结局节点，按时间倒序，可跳转。
- 只渲染当前路径及其直接分支，不渲染整棵树：几百个节点的推演在手机上也能用，读屏不会读到整棵树。

**本线状态**（`WorldlineStateSheet.tsx`，`Sheet`，分四个区块，标题是 `h3`）：

- 「本线变化」：按产生它的步骤分组列出差异，每条带来源「第 k 步」；当前节点的差异可编辑 / 删除；祖先节点的差异点「编辑」进入那一步的差异编辑（`DeltaEditor`，同一组件）。新增覆盖：选条目 → 只列**可变**字段 → 填值；锁定字段不出现在下拉里。
- 「有效设定」：条目列表，每条标来源（世界观 / 限定 / 本线新增），被改写的字段显示「本线（第 k 步）：新值」与世界观原值；失效的差异单列「不再生效」。条目旁「提升为世界观」（按 §7.1 规则可用或说明原因）。限定到本推演的条目可以「只从这一步起出现」/「改为整个推演」。
- 「主角状态」「事件与标记」。
- 检查点节点上有「前情摘要」（可编辑），后台整理失败时显示「前情整理失败，下次推进时会重试」（重试规则见 D5.3：下次推进或收尾前由 `checkpointsToFill` 重新发现并补）。

### 8.4 两端适配要点

- 移动端：所有导航用按钮，不用手势与拖拽；选项和操作栏按钮 ≥ 44px（`tap-target`）；抽屉用现有 `Sheet`（底部全屏），键盘弹出时自由输入不被遮挡（沿用编辑器的 `scroll-margin` 做法）。
- 桌面端：正文 `reading-column`；`Sheet` 自动变右侧抽屉，导航与正文可并看；焦点环、`enabled:hover:`；生成完成后焦点移到新步骤标题（`tabIndex={-1}` 的 `h2`），读屏从新情节开始读。
- `Esc` 关抽屉由 `Sheet` 负责（已带 `isComposing` 守卫）；推演页本身不绑 `Esc`（自由输入框里输入法要用）。

### 8.5 知识库与规范的界面改动

- 条目列表：限定条目带「限定 · 推演《X》」徽标；知识库页、回收站、收件箱的 `listEntries` 传 `{ scope: 'all' }`。
- **回收站（`TrashSheet.tsx`）**：
  - `purge()` 加 `try/catch`：`hardDeleteEntry` 抛错（目前唯一的新失败是「这个条目是推演《X》的主角，先删除推演」）时，在确认框里用 `role="alert"` 显示 `message`，确认框保持打开，作者可以取消；成功时行为不变（`invalidate` + 关闭）。错误状态在确认框关闭或换目标时清空。
  - 列表里，是某推演主角的条目旁加一行小字「推演《X》的主角」：`TrashSheet` 额外 `useRepoQuery` 一次 `listScenarios(novelId)`，在内存里建 `entryId → 推演名[]`，让作者点「彻底删除」之前就知道。「恢复」不受影响。
  - 为什么在仓储拦而不是只在 UI 拦：仓储是唯一的写入口，备份导入之外的任何调用都绕不过它；UI 的小字只是提前告知。
- 条目编辑：默认折叠的「互动推演设置」：作用范围（通用 / 仅限推演：多选推演 + 每个推演的登场条件）；逐字段的可变性（显示继承的默认值「默认：锁定」，可改为锁定 / 可变 / 跟随分类）。
- 分类管理：字段行加「世界线可改写」开关（写 `FieldDef.mutability`）。
- 写作规范：`NORM_SCOPES` 追加 `{ id: 'interactive', label: '互动推演', hint: '推演每一步的情节与选项、收尾' }`，编辑面板与列表元信息自动出现第六项；`NORM_SCOPE_USAGE.interactive = '推演时把这些约束落实到情节、挑战与选项里，不要在情节中复述或提及规范本身。'`

---

## 9. 生成相关的错误处理

| 操作           | 失败条件                                         | 可恢复？                                              | 界面                                                              | 写库                           |
| -------------- | ------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| 推进 / 收尾    | 未配置模型                                       | 是                                                    | 按钮禁用 +「需要先在『设置』里配置模型」                          | 无                             |
|                | 主角条目已删除                                   | 是                                                    | 「主角『X』已被删除，到知识库回收站恢复后才能继续」               | 无                             |
|                | 网络 / 鉴权 / 余额 / 限流 / 服务端错误           | 是                                                    | `LlmError.message` + detail +「重试」（保留本次行动）             | 无                             |
|                | `finishReason === 'length'`（首轮或修复轮）      | 是                                                    | 「这一步写得太长被截断了，没有保存。可以重试」                    | 无                             |
|                | 没写出情节 / 修复重试后仍不合 schema             | 是                                                    | 「模型输出格式不对（已重试 1 次），没有保存」+ detail             | 无                             |
|                | 作者点「停止」                                   | 是                                                    | 回到选择前，不提示错误                                            | 无                             |
|                | 仓储拒绝（选择已走过、推演被删等）               | 视情况                                                | 仓储的 `message`；「已走过」时刷新并给「去那条线」                | 无                             |
|                | 前情同步补摘要失败（gap > 7 时，任何一个检查点） | 是                                                    | 「整理前情失败，这一步没有生成」+「重试」（从失败的检查点继续补） | 已补成功的检查点保留，本步不写 |
|                | 离开推演页                                       | 是                                                    | 无（已卸载）                                                      | 无                             |
| 后台检查点摘要 | 任何失败（含被卸载取消）                         | 是（下次推进或收尾前由 `checkpointsToFill` 重新发现） | 状态面板一行提示，不弹错                                          | 无                             |
| 再给几个选项   | 同上的模型错误；去重后不足 2 个                  | 是                                                    | 面板内 alert                                                      | 无                             |
| 沉淀生成       | 模型错误；步骤分组不合法且修复失败               | 是                                                    | 面板内 alert                                                      | 无                             |
| 沉淀采用       | 「对应步骤」不合法、推演已删、外传重名           | 是                                                    | 收件箱现有的逐条失败提示                                          | 事务回滚，提案保持待确认       |
| 提升           | 字段已锁定 / 差异类型不可提升                    | —                                                     | 按钮旁说明，不生成提案                                            | 无                             |

所有模型错误不写控制台、不落库；修复重试次数固定 1 次（与现有结构化任务一致）。

## 10. 外部输入校验汇总

| 输入                   | 必填     | 类型与上限                       | 失败时                  |
| ---------------------- | -------- | -------------------------------- | ----------------------- |
| 推演名称               | 是       | trim 后 1–40                     | 表单错误，不能保存      |
| 新 OC 名称 / 字段      | 名称必填 | 名称 1–120；字段各 ≤ 2000        | 同上                    |
| 起点处境 / 时间 / 地点 | 处境必填 | 500 / 100 / 100                  | 同上                    |
| 结局目标               | ≥ 1      | ≤ 6 个，描述 1–200               | 同上                    |
| 里程碑                 | 否       | ≤ 8 个，1–200                    | 同上                    |
| 基调 / 预计步数        | 否       | ≤ 200 / 整数 5–200               | 钳到边界                |
| 自由输入               | 是       | trim 后 1–200                    | 按钮禁用 + 计数变红     |
| 收尾说明               | 否       | ≤ 200                            | 同上                    |
| 手动差异编辑的值       | 是       | 1–1000；字段必须可变             | 保存被拒并说明原因      |
| 前情摘要编辑           | 否       | ≤ 2000                           | 计数变红                |
| 模型产出               | —        | §1 D3.1 schema + `sanitizeDelta` | 修复重试 / 丢弃并提示   |
| 备份文件               | —        | §4.2                             | `BackupError`，库里不变 |

UI 预检用 `validateScenarioSetup` / `validateFreeAction`（domain，复用 schema 的规则与文案，返回第一条中文错误），与写作规范的 `validateNormDraft` 同一做法，不把 ZodError 的 JSON 显示给作者。

## 11. 边界情况

- **世界观条目被软删除**：有效知识里它消失，指向它的覆盖进「不再生效」；恢复后重新生效。主角条目被软删除时推演只能浏览、不能推进。
- **分类字段被删 / 改名键**：覆盖按键存，键不存在时进「不再生效」。
- **字段改成锁定**：已存的覆盖失效并说明（D6.3），提升不可用。
- **限定条目改成通用**：立即在所有推演和现有写作链路里可见（作者的显式操作）。
- **同名**：限定条目与通用条目同名时，现有写作链路只看到通用的；推演里两者都可见，相关设定里按 id 区分并在标签上标出「限定」。反向提取只匹配通用条目，所以同名的提取结果合并进通用条目。
- **编辑祖先差异**：后代的有效知识立即变化（现算）；后代节点上显示「生成时依据的是旧事实」，不重新生成。
- **一个节点的选项全部走完且已 8 个**：只剩自由输入与收尾。
- **自由输入与某个未走过的选项相同**：按选那个选项处理。
- **两个标签页同时推进同一选项**：仓储事务只让一个成功，另一个显示「这个选择刚刚已经走过了」。
- **生成中删除推演 / 切换作品**：落库时仓储抛「推演已不存在」，界面回到写作页。路由里的推演属于其他作品时，页面显示「这个推演属于另一部作品」与「去书架」。
- **主线被切到旧线之后再沉淀**：续沉淀从当前主线第一个未被非过期大纲覆盖的步骤开始；旧主线沉淀的大纲标「来自旧主线」。
- **主线大纲中间有洞**（作者删了中间某章的大纲节点）：只补这个洞 `[a, b]`，不把洞之后已覆盖的步骤再沉淀一遍；补出的卷在大纲末尾，作者自己调位置（§7.2 第 2 步）。
- **主线变了之后接着玩外传线**：「追加到外传」按「当前节点在外传最后一步的子树里」判定，与重新算出的分叉点无关，外传的 `forkNodeId` 不变（§7.2 第 2 步）。
- **推演主角在回收站、推演还在时点「彻底删除」**：仓储拒绝，回收站确认框内显示「这个条目是推演《X》的主角，先删除推演」，条目留在回收站（§8.5）。
- **没有当前作品 / 推演不存在 / `cursorNodeId` 失效**：见 §8.3 第 0 项。
- **一段路径已沉淀为外传后又成了主线**：沉淀面板提示「其中第 a–b 步已沉淀为外传《X》」，仍允许沉淀进主线（作者决定是否保留外传）。
- **合并导入备份**：推演行按 id 覆盖；该推演的节点**整棵替换**为备份里的那棵（§4.2 末尾），主线指针与树来自同一份快照；本地独有的推演不动。两台设备在同一推演上各自推进过时，以备份为准，本地那几步不保留（合并导入说明文字已写明）。本地沉淀过、但在备份里不存在的步骤，其溯源被解除（大纲节点、外传章节的 `scenarioSource` 裁掉这些步骤或置空，外传的分叉点不在了就解除关联），大纲与正文保留；只在这些步骤出现的限定条目进回收站（§4.2 末尾）。合并之后导出的备份照常可恢复。
- **备份里有限定到不存在推演的条目**：允许（孤儿），在任何推演里都不可见，条目编辑里显示「所限定的推演已不存在」，作者可改为通用。
- **推演很长（几百步）**：导航只渲染当前路径 + 直接分支；有效知识现算仍是毫秒级；前情靠检查点，prompt 长度与路径长度无关。

---

## 12. 零回归保障：没有推演时 prompt 逐字节不变

### 12.1 改动面

可能影响现有 prompt 的改动只有这些，各自的保障：

| 改动                                                                         | 为什么不影响                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContextRequest.scenarioContext?`                                            | 不传时构建器不进入新分支；基线测试覆盖                                                                                                                                                                                                                                                                                                                                                                                |
| `ContextItemKind` 加 `'scenario'`                                            | 只是类型                                                                                                                                                                                                                                                                                                                                                                                                              |
| `WritingNormScope` 加 `'interactive'`、`NORM_SCOPE_USAGE` 加一句             | `normsInScope` 按 scope 过滤，其他任务取不到只含 `interactive` 的规范；其余 scope 的用法句不变                                                                                                                                                                                                                                                                                                                        |
| 规范默认作用范围变六项、v7 给全开规范补 `interactive`                        | 其他 scope 的过滤结果不变                                                                                                                                                                                                                                                                                                                                                                                             |
| `KnowledgeEntry.scope / fieldLocks`、`FieldDef.mutability`、`scenarioSource` | 所有渲染函数（`renderEntry`、提取的条目渲染、`fieldGuide`、`categoryGuide`、`renderOutlineContext`）按具体字段取值，没有任何地方整对象序列化进 prompt（已核实：`src/features                                                                                                                                                                                                                                          | context | prompt | proposal`下`JSON.stringify` 只出现在备份序列化） |
| `listEntries` 默认只返回通用条目                                             | 没有限定条目时结果与现在相同；有限定条目时正是需求要的「不泄漏」。默认调用点逐一列出：写作页（整章 / 加工 / 摘要 / 检查的 `context.entries`）、立项 `SetupSection`、导入两处（逐章提取、分段提取）、**翻译 `TranslateSheet.tsx:111`（用条目名拼译名表）** —— 这些代码都不改，靠默认值拿到与现在相同的条目集合；翻译因此不会把只属于推演的人物名带进译名表，这是有意的（翻译的是作品正文，推演人物进正文之前要先沉淀） |
| `defaults.ts` 模板加 `mutability`                                            | `buildSetupSchema` 与 `fieldGuide` 只用 key / label / hint                                                                                                                                                                                                                                                                                                                                                            |
| `ContextRequest.scenarioContext?` 只在 `GenerateChapterSheet` 的 prop 上带   | 共享 `context` 不变，`ReviseSheet` 等拿不到；`ChapterEditor.test.tsx` 断言加工请求不含【本章依据的互动推演】                                                                                                                                                                                                                                                                                                          |

**不是 prompt 但可见的行为变化**：书架统计 `computeStats` 的 `entryCount` **继续统计全部未删除条目（含限定条目）**，代码不改。理由：书架上的「N 条设定」对应知识库页的条目数，而限定条目在知识库页里照常列出（带徽标）；只算通用条目会让作者在知识库看到 11 条、书架上写 10 条。新建 OC 让设定数加一是真实发生的事。立项 `SetupSection` 的 `entryCount`（只用于「已有内容」判断）走 `listEntries` 默认值，只算通用条目，同样不改代码：只有一个推演 OC 的作品仍算「还没有世界观」，立项照常可用。

**章节摘要关联不到限定的主角（有意如此，不改代码）**：`ChapterSummarySheet` 用写作页的 `context.entries`（通用条目）给模型列名、并用 `resolveEntryNames` 把 `appearingEntries` 解析成 id。沉淀章节的主角若是限定条目，摘要里提到他时解析不到，按 5.2 丢弃，所以这一章摘要的 `appearingEntryIds` 不含 OC，下一章「上一章出场」的默认预选也带不出他。影响有限：主角档案由 D7.3 的【本章涉及的推演专属设定】必选注入，不依赖出场预选。不改的理由：让摘要看到限定条目就得给摘要链路也开 `scope: 'all'`，等于把推演人物带进全书的摘要与出场记录，与「限定条目不泄漏进现有写作链路」相抵；作者把主角改成通用（或提升为世界观）后自然恢复。`docs/使用说明.md` 的互动推演常见问题里写一条。

### 12.2 基线测试 `src/context/noScenarioBaseline.test.ts`（实现的第一步，改任何源码之前）

做法沿用 `noNormsBaseline.test.ts`，**禁止**任何快照断言，只用常量 + `toBe` / `toEqual`：

1. 改代码前先把整个项目复制到 `/tmp/myliterature-baseline-interactive`（不含 `node_modules`）。
2. 在未改动的代码上，用固定夹具（作品、风格档案含名家参考与非空 `extraInstruction`、两类分类、核心设定 + 普通条目、大纲三节点、三章含摘要、一部外传、**两份写作规范**：一份五项全开、一份只含 `writing`）跑一次性脚本（放 `/tmp`，不进仓库），把下列输出 `JSON.stringify` 打印后粘成 `BASELINE` 字面量：
   - `SummaryChainContextBuilder.build`（主线章节、外传章节），取 `{ stablePrefix, volatileSuffix, items, estimatedTokens }`；
   - 系统 / 用户提示：`buildChapterSystemPrompt` / `buildChapterUserPrompt`、`buildReviseSystemPrompt` / `buildReviseUserPrompt`（三种 action）、`buildSummarySystemPrompt` / `buildSummaryUserPrompt`、`buildExtractSystemPrompt` / `buildExtractUserPrompt`、`buildExpandSystemPrompt` / `buildExpandUserPrompt`、`buildSetupSystemPrompt` / `buildSetupUserPrompt`、`buildNormCheckSystemPrompt` / `buildNormCheckUserPrompt`、规范精简的 `NORM_CONDENSE_SYSTEM` 与 `buildCondenseUserPrompt`（`normCondense.ts`）、翻译的 `buildTranslateSystemPrompt` / `buildTranslateUserPrompt`（`features/writing/translate.ts`，译名表夹具由条目名拼出，与 `TranslateSheet` 同一做法）、文风取样的 `STYLE_SAMPLE_SYSTEM` / `buildStyleSampleUserPrompt`（`features/style/styleSample.ts`）、导入时的文风提炼 `MANUSCRIPT_STYLE_SYSTEM` / `buildManuscriptStyleUserPrompt`（`features/import/extractStyle.ts`）。这样覆盖 N4 列出的全部十类任务。
3. 改代码后同一文件为每个函数追加变体输入，一律断言等于 `BASELINE`：
   - 条目对象字面量多带 `scope: { kind: 'universal' }`、`fieldLocks: { rules: 'mutable' }`；分类模板的字段多带 `mutability`；大纲节点、章节、外传多带 `scenarioSource: null`；
   - 规范 `scopes` 多一项 `'interactive'`，再加一份**只含** `'interactive'` 的启用规范（不得出现在任何现有任务的 prompt 里）；
   - 构建器显式传 `scenarioContext: undefined`。
     夹具全部写成对象字面量、只用 `import type`，不 import 任何新增的运行时模块 —— 类型擦除后同一文件在旧代码上也能跑，这是交叉核对的前提。
4. 仓储层补一条（`DexieNovelRepository.test.ts`）：存在限定条目（含一个新建的推演 OC）时，`listEntries(novelId)` 的结果与只有通用条目时逐项相同 —— 写作页、立项、导入、`TranslateSheet` 的译名来源条目都取自这个调用，所以这一条同时守住它们；`findEntryByName` 匹配不到限定条目。
5. 交叉核对（审查必做）：

```sh
CI=1 npx vitest --run src/context/noScenarioBaseline.test.ts
cp src/context/noScenarioBaseline.test.ts /tmp/myliterature-baseline-interactive/src/context/
ln -s "$PWD/node_modules" /tmp/myliterature-baseline-interactive/node_modules
(cd /tmp/myliterature-baseline-interactive && CI=1 npx vitest --run src/context/noScenarioBaseline.test.ts)
```

两边都全绿：新代码通过说明零变化，旧代码通过说明 `BASELINE` 确实来自改动前。之后 `BASELINE` 永不修改，断言失败修实现。核对完删除 `/tmp` 里的拷贝与软链。

现有 `noNormsBaseline.test.ts` / `noNormsInputs.test.ts` 不改，继续全绿。

---

## 13. 测试计划

### 13.1 必测项对照（requirements §6）

| #   | 必测项                         | 文件                                                                                                                                         | 层级             | 覆盖验收      |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------- |
| T1  | 差异沿树继承、兄弟隔离         | `src/domain/worldline.test.ts`                                                                                                               | 单元             | 1、2、3、5、6 |
| T1  | 世界观层不被修改               | `src/data/dexie/DexieNovelRepository.test.ts`（推演一节）                                                                                    | 仓储集成         | 4             |
| T2  | 锁定字段                       | `worldline.test.ts`（解析与 sanitize）、仓储（手动编辑被拒）、`scenarioPrompt.test.ts`（自由输入带「尝试」规则）、`promote.test.ts`          | 单元 + 仓储      | 7、8、9、10   |
| T3  | 已走过禁用、旧线继续推进       | `src/domain/scenario.test.ts`（`walkedChoices`）、`ScenarioPage.test.tsx`                                                                    | 单元 + UI        | 11、12、14    |
| T4  | 主线跟随规则                   | `scenario.test.ts`（纯函数序列）、仓储（`appendScenarioNode` 改主线、`setScenarioCursor` 不改）、`ScenarioPage.test.tsx`（徽标）             | 单元 + 仓储 + UI | 17、18        |
| T5  | 回退不发请求                   | `ScenarioPage.test.tsx`（`vi.spyOn(globalThis, 'fetch')` 计数）                                                                              | UI               | 13、14        |
| T6  | 坏结局后回退                   | `ScenarioPage.test.tsx`                                                                                                                      | UI               | 22            |
| T7  | 沉淀大纲走提案                 | `src/features/scenario/pathOutline.test.ts`、`src/proposal/apply.test.ts`（`scenarioOutline:create`）、`SedimentSheet.test.tsx`              | 单元 + UI        | 25、28        |
| T8  | 外传记录分叉点                 | `pathOutline.test.ts`（分叉点计算）、仓储（`commitScenarioOutline` 外传模式）、`scenarioChapter.e2e.test.tsx`（prompt 含共用前情、导出不含） | 单元 + 仓储 + UI | 27            |
| T9  | Dexie v6 → v7、旧备份、v4 往返 | 仓储迁移用例、`src/features/export/backup.test.ts`                                                                                           | 仓储 + 单元      | 30–34         |
| T10 | 没有推演时 prompt 不变         | `src/context/noScenarioBaseline.test.ts` + 仓储 `listEntries` 用例                                                                           | 单元             | 35            |
| T11 | 推演 UI 主要流程               | `src/features/scenario/ScenarioPage.test.tsx`（`createTestHarness` + stub fetch）                                                            | UI               | 37、38、39    |

### 13.2 各文件用例要点

**`src/domain/worldline.test.ts`**

- 树 1 →（a）2a →（a）3a；2a 覆盖 X 的「身份」为「叛徒」→ 3a 处有效值「叛徒」、来源 2a；1 →（b）2b、2b 的子节点处为世界观原值，看不到 2a 的任何差异（验收 1、2）。
- 2a 新增本线人物 Y：2a 的后代可见，2b 分支不可见（验收 3 的推演内部分）。
- 限定条目：限定到推演 S 的条目在 S 可见、在推演 T 不可见；`fromNodeId = 2a` 时只在 2a 子树可见；带 `revealHint` 的在 `revealed` 之前进 `pendingReveals`（验收 5）。
- 编辑 2a 差异后重算：3a 变、2b 不变（验收 6）。
- `resolveStepChanges`：锁定字段（「运作规则」）被丢弃且 `notices` 有 `locked-field`，有效值仍是原值（验收 7）；未知条目、未知字段、未知分类、重名新条目、世界规则的死亡、未知里程碑各一例；字段用中文名也能解析；值与现值相同被静默丢弃。
- `fieldMutability` 四级解析：条目覆盖 > 模板 > 内置默认（旧分类没有 `mutability` 时人物「说话方式」锁定、「身份」可变）> 可变。
- `builtinMutability`：作者自建的 custom 分类「法宝」带 `rules` 键 → 可变；旧作品「道具」分类（`kind: 'custom'`、无 `mutability`）的 `rules` 键 → 锁定；「道具」改名为「器物」后同一键 → 可变。
- 本线条目：新建时带「说话方式」值可以；后续节点覆盖它的「说话方式」→ 丢弃且 `locked-field`；覆盖「身份」生效。
- 提升别名：2a 新增本线人物 Y，3a 改 Y 的「身份」；在 3a 处把 Y 提升（`promotedEntryId = W`）→ 4a（3a 的子）改 Y 的「身份」与状态 dead：4a 处有效知识里只有一个 Y（`ref = world W`），「身份」为 4a 的值、状态 dead；2b 分支看到 W 的世界观原文、无状态；W 被软删除后 4a 处 Y 恢复为本线条目、带 3a/4a 的变化。
- 预设揭示：带 `revealHint` 的限定条目 P 在 `pendingReveals`；某步 `statusChanges` 写 P 被俘 → P 进 `entries`、状态 captured，且隐含 revealed；之后 `restored` → 处境清除、P 仍在 `entries`；某步 `newEntries` 新建同名 P → 不新建、记 revealed + 字段转覆盖 + `duplicate-entry`；`fromNodeId` 非空、`revealHint` 为空的条目在子树内直接在 `entries`。
- 结局 `goal` 指向好结局目标、`kind` 为 bad → `goalId = null` + `unknown-goal`；`ocChanges` 的 `castId` 都是 `cast[0].id`。
- `inactive`：字段后来锁定、条目软删除、字段从模板删掉三例。
- OC 状态 add / remove / 去重；标记后写覆盖；`restored` 清状态。
- `renderWorldlineState` 两次调用逐字节相同；条目顺序与输入顺序无关。

**`src/domain/scenario.test.ts`**

- `mainPath`、`pathTo`、`walkedChoices`（选项与自由输入）、`latestLeafOf`。
- 主线序列（验收 17）：走 a 推进 3 步 → 主线是 a 线第 4 步；回退到根走 b 推进 1 步 → 主线是 b 线；切回 a 线只查看 → 主线仍是 b；在 a 线叶子推进 1 步 → 主线是 a 线第 5 步。每一步断言 `mainNodeId` 与 `isOnMainPath(cursor)`。
- `normalizeAction`：全角 / 半角、空白、末尾标点；`actionSimilarity` 阈值两侧各一例（验收 15）。
- `sedimentRange`、`sedimentCoverage`（过期判定）、`forkNodeOf`。
- `latestLeafOf`：深度优先于 `createdAt`（较深但较早创建的节点胜出）、同深同时间按 id。
- `checkpointsToFill`：路径 12 步、第 5 步有摘要 → `[]`；第 5、10 步都缺 → 依次 `[depth 4, depth 9]`；第 5 步有、第 10 步缺 → `[depth 9]`，其输入段为第 6–10 步；`depth > parentDepth` 的检查点不返回。runner 层（stub client）：连续缺两个且 `gap > 7` 时按顺序发两次 summary 请求、第二次的 user 含第一次的摘要；第一次失败时第二次不发、本步不生成；同一检查点并发触发只发一次。

**`src/llm/proseTail.test.ts`**（stub `LlmClient`）

- 分块流式：`onProse` 依次收到累计正文，从不包含 `@` 开头的分隔符前缀及之后的内容（验收 21 的单元部分）；分隔符被切在两个分块中间（`…雾@@` + `@STATE@@@{…}`）时，任何一次回调都不含 `@`；正文本身含单个 `@`（如邮箱）且后面不是分隔符时，完成后照常显示。
- 正常切分；缺分隔符 → 修复请求 → 成功（正文用首轮）；JSON 不合 schema → 修复成功；修复后仍失败抛 `parse`；首轮 `finishReason: 'length'` 抛 `truncated` 且只发 1 次请求；修复轮截断同样抛 `truncated`；正文为空抛 `parse`。
- 选项 1 个、5 个（无结局）→ 校验失败 → 修复（验收 19）。

**`src/features/scenario/scenarioPrompt.test.ts`**

- 系统提示：同一推演、不同节点、不同分支、收尾时逐字节相同；作用范围含「互动推演」的规范在 `composeStylePrefix` 输出之后、【必须遵守的核心设定】之前，不含该范围的不出现（验收 29）；锁定字段带「（底层，不可改变）」；限定到本推演且全程可见的 pinned 条目进前缀，`fromNodeId` 非空的不进。
- 用户提示：块顺序；最近 3 步原文；检查点摘要 + gap；自由输入带「这是尝试，不是既成事实」（验收 9 的 prompt 部分）；导演提示的三个阶段与超步数文案；收尾要求。
- 注入清单的 token 与文本一致；`excludedEntryIds` 里的推断条目不出现在用户提示中，系统提示不变。
- 主角是通用 pinned 条目时，前缀里它只出现一次（在【主角】块）。
- 步骤、收尾、options、summary 四种请求的 system 在【推演规则】结束处之前逐字节相同；`buildOptionsUserPrompt` 含当前节点的挑战、已有选项与走过的自由输入；`buildSummaryUserPrompt` 在 `previous = null` 时含「（从开局写起）」。
- `OptionsBatchSchema` 1 个 / 5 个选项被拒；`SummaryOutSchema` 超 600 字被拒。

**`src/data/dexie/DexieNovelRepository.test.ts`（追加「互动推演」一节）**

- `createScenario`：引用已有人物；新建 OC 时同一事务建出限定到本推演的人物条目；`listEntries` 默认看不到它，`{ scope: 'all' }` 看得到。
- `appendScenarioNode`：根唯一；父为结局时拒绝；同一选项第二次拒绝；规范化后相同的自由输入拒绝；收尾只能一次；`mainNodeId`、`cursorNodeId` 改为新节点；落库时再次丢弃锁定覆盖。
- 一组推进、回退（`setScenarioCursor`）、编辑差异、结局之后，`entries` 表逐行与操作前相同（验收 4）。
- `updateScenarioNodeDelta`：锁定字段覆盖被拒、库里不变（验收 8）；合法编辑写 `deltaEditedAt`。
- `appendScenarioOptions` 去重、上限 8。
- `deleteScenario`：节点删光，`scenarioSource` 清空，`trashScopedEntries` 时限定条目进回收站；`deleteNovel` 级联两张新表。
- `hardDeleteEntry` 拒绝删主角条目（含主角已软删除的情形），错误文案含推演名；条目仍在库里、`deletedAt` 不变。
- `commitScenarioOutline`：主线模式追加在顶层末尾、章级节点带 `scenarioSource`、卷节点为 `null`、`linkedEntryIds` 只含通用条目；外传模式建外传（`scenarioSource.forkNodeId`）与空章节（`scenarioSource.brief`）；重名外传整体回滚。
- 重开数据库后树、差异、已走过状态、`cursorNodeId` 完整（验收 30）。
- 迁移 v6 → v7（验收 31）：原生 Dexie 声明到 v6 写入作品 / 条目 / 大纲 / 章节 / 外传 / 规范（一份五项全开、一份只有 `writing`、一份缺 `scopes` 字段），用 `AppDatabase` 打开：`verno === 7`；条目 `scope` 为通用、`fieldLocks` 为 `{}`；三处 `scenarioSource` 为 null；五项全开的规范变六项、只有 `writing` 的不变、缺字段的变六项；其余字段逐字段不变；推演表为空且能新建。现有全部 4 处 `verno` 断言改 7。
- `promoteLineEntry`：create 分支建条目 + 标记；`mergeInto` 分支更新已有条目 + 标记、不新建；`mergeInto` 目标已删除时抛错、库里不变。
- `deleteScenario`：只限定到本推演的条目进回收站；同时限定到另一推演的条目不进回收站、`targets` 去掉本推演；`trashScopedEntries: false` 时条目原样保留。
- `commitScenarioOutline` 追加到外传：新章节 `order` 接在末尾、外传名称简介不变；目标外传已删时整体回滚。
- 合并导入（`importSnapshot` merge）：本地推演 S 在选项 a 下有子节点 L，备份里 S 在 a 下有子节点 R → 合并后 S 的节点集合与备份完全相同（没有 L）、`mainNodeId` 是备份的；本地独有的推演 T 原样保留。
- 合并导入的悬空引用清理：本地另有①大纲节点 `nodeIds = [R的祖先, L]`、②大纲节点 `nodeIds = [L]`、③外传 `forkNodeId = L` 及其章节 `nodeIds = [L]`、④限定条目 `targets = [{ S, fromNodeId: L }]`、⑤限定条目 `targets = [{ S, fromNodeId: L }, { T, fromNodeId: null }]`。合并后：①只剩祖先；②`scenarioSource = null`、节点与标题保留；③外传与章节的 `scenarioSource` 为 null、正文保留；④进回收站；⑤只剩 T 那一项、未删除。随后 `parseBackup(serializeBackup(buildBackupFile(await repo.exportSnapshot(), 0)))` 不抛错。覆盖恢复（replace）不调用清理（用 spy 或结果断言）。
- `listEntries` / `findEntryByName` 不返回限定条目（§12.2 第 4 条）。

**`src/features/export/backup.test.ts`**

- `BACKUP_VERSION` 为 4；「来自更新版本」用例改为 version 5。
- 往返：带推演、多分支节点、差异、限定条目、锁定覆盖、沉淀溯源的种子数据，导出 → 覆盖恢复 → 再导出，`scenarios` / `scenarioNodes` 逐字段相同；合并导入同样（验收 33）。
- v1、v2、v3 文件覆盖恢复与合并导入各一例：推演为空、条目通用、`scenarioSource` 为 null；v3 文件里五项全开的规范恢复后是六项、收窄的不变；v4 文件里五项的规范保持五项（验收 32）。
- 被拒（`BackupError`，库里不变，`detail` 以对应路径开头）：节点指向不存在的父节点；同一推演两个根；层级不连续；选项 id 不在父节点里；结局后还有子节点；外传指向不存在的分叉节点；大纲溯源指向别的推演的节点；主线章节带 `scenarioSource`；主角条目不存在；同一父节点下同一选项有两个子节点（规则 10，`detail` 以 `scenarioNodes.` 开头、含「同一个选择出现了两次」）（验收 34）。

**`src/context/SummaryChainContextBuilder.test.ts`（追加）**

- 传 `scenarioContext` 时四块按 D7.3 的顺序出现在 `volatileSuffix`，位于大纲位置 / 外传说明之后、【故事至此】之前；`stablePrefix` 与不传时相同；`items` 有四项 `kind: 'scenario'`、`id` 两两不同且 `included`；小预算下仍然 `included`；`limitedText` / `forkText` 为空串时对应块与清单项都不出现。

**`src/features/scenario/pathOutline.test.ts`**

- `buildPathOutlineSchema(from, to)`：首尾相接、覆盖、不重叠的合法与非法例；`from = 13` 时从 1 起的分组被拒；`serializeScenarioOutline` ↔ `parseScenarioOutline` 往返（含续沉淀第 13–24 步一例，`nodeIds` 是路径上 depth 12–23 的节点）；「对应步骤」越界抛错且文案含「第 13–24 步」；解析后 `synopsis` 仍含「关键事件：」「出场：」两行、不含「对应步骤：」；出场名解析只得通用条目 id。
- `sedimentRange`：主线续沉淀；外传从分叉点之后；已有外传且当前节点在其最后一步子树里 → 追加，范围从最后一步之后起；当前节点不在其子树里 → 只能另建；当前节点就是外传最后一步 → 不追加（范围为空）。
- 有洞：主线 20 步，第 1–4、9–12 步被章级节点覆盖、5–8 与 13–20 未覆盖 → 范围 `[5, 8]`；补上 5–8 后 → `[13, 20]`；卷节点（`scenarioSource = null`）不影响覆盖计算；过期节点不算覆盖。
- 主线变了之后追加：外传《X》沉淀时分叉点是 F；之后在别处推进让主线换线，使重新算出的分叉点不再是 F；当前节点仍在《X》最后一步的子树里 → 仍然给「追加到外传《X》」，提案里 `appendToSideStoryId` 为《X》，《X》的 `forkNodeId` 采用后仍是 F。两部外传都满足时取最后一步更深的一部。

**`src/proposal/apply.test.ts`（追加）**

- `scenarioOutline:create` 主线 / 外传各一例；采用前大纲与外传不变，采用后写入（验收 25）。
- `knowledgeEntry:create` 带 `promoteFrom`：建条目且本线条目标记已提升；不带时行为与现有用例相同。

**`src/features/scenario/promote.test.ts`**

- 可变覆盖 → replace 提案、diff 只有那一栏；确认前条目不变、确认后该字段为新值（验收 24）。
- list 字段（「关系网」设为 list 类型的夹具）覆盖后提升 → 采用后字段**等于**覆盖值，不是新旧并集。
- 本线条目 → create 提案（作用范围通用）；已有同名通用条目时 → merge 提案带 `promoteFrom`、采用后没有新建条目、本线条目的 `promotedEntryId` 指向已有条目。
- 字段后来被锁定的覆盖 → 不生成提案、返回原因（验收 10）；状态 / 主角状态 / 事件 → 不可提升。

**`src/features/scenario/ScenarioPage.test.tsx`**（`createTestHarness` + `harness.renderUI`，`vi.spyOn(globalThis, 'fetch')` 用 `sseResponse(textDeltaEvents([...]))` 构造分块流）

- 全流程（验收 37）：写作页卡片「开始一局」→ 填开局（新建 OC）→ 开局生成（分块流，断言生成中出现部分情节文字，验收 21）→ 选 a → 再推进 → 面包屑点「开局」回退 →（fetch 计数不变，验收 13）a 显示「已走过」且 `disabled`，b、c 可点，选项文字与首次相同（验收 11、12）→ 选 b → 打开世界线导航点「去这条线的最新一步」回到 a 线（计数不变）→ 在 a 线推进（新节点挂在 a 线下，验收 14）→ mock 返回坏结局 → 无选项、无自由输入框、显示「回到上一个挑战」→ 点它回到父节点后正常推进（验收 22）。
- 主线徽标（验收 18）：在 b 线上时「外传线 · 不在主线上」与「回到主线最新一步」可查到；推进后变「主线 · 第 k 步」。
- 自由输入一步（验收 38）：请求 user prompt 含「作者为主角输入的尝试」；与已走过选项规范化后相同时按钮禁用并提示；相似时出现「仍然这样做」。
- 世界线导航（验收 39）：列出当前路径每一步与各步的分支（含深度与结局状态），点任一项跳过去。
- 再给几个选项（验收 16）：所有选项走过后按钮出现，点击发 1 次请求，新选项追加、原选项不变。
- 截断：`finish_reason: 'length'` → 显示截断提示，树里没有新节点（验收 20）。
- 收尾：生成结局节点并显示类型（验收 23）。
- 被丢弃内容提示：mock 返回锁定字段覆盖 → 页面出现「有 1 处变化没有记下」，状态面板里能看到原因（验收 7 的 UI 部分）。
- 每个主要控件只渲染一份（`getAllByRole(...).toHaveLength(1)`）。
- 未开局：开局请求返回 500 → 页面显示「还没有开局」与「开始」、「世界线」等按钮 disabled；点「开始」成功后出现第 1 步。
- 生成中离开：分块流进行到一半时点「返回」→ 回到写作页；`listScenarioNodes` 数量不变、`mainNodeId` 不变；`AbortSignal` 已触发。
- 本步依据：取消一个推断条目的勾选后推进，请求 user 不含该条目原文、system 与上一步逐字节相同。
- 删除推演：确认框（`role="dialog"`）里复选框默认勾选；确认后主角条目在回收站里；取消勾选再删除时主角条目仍在知识库。
- 回退不发请求（T5 补强）：夹具里路径 12 步、第 5 步检查点**缺摘要**；挂载推演页、点面包屑跳到第 3 步、打开世界线导航去另一条线、打开本线状态，全程 `fetch` 计数为 0；之后点一个选项推进，才出现 summary 请求（在 step 请求之前或并行，按 D5.3 的 gap 规则）。
- 落点回落：推演 `cursorNodeId = null`、`mainNodeId` 指向第 4 步 → 页面显示第 4 步；两者都无效（手改夹具）→ 显示根节点；都不写库（读回 `cursorNodeId` 仍为 null）。
- 推演不存在：路由 id 不存在 → 「这个推演已不存在」与「回写作页」；没有当前作品 → `RequireNovel` 的空状态。

**`src/features/knowledge/TrashSheet.test.tsx`（新增或追加）**

- OC 是推演 S 的主角、已软删除、S 还在：列表里该条目旁有「推演《S》的主角」；点「彻底删除」并确认 → 确认框内出现 `role="alert"`「这个条目是推演《S》的主角，先删除推演」，确认框仍打开；取消后条目还在回收站列表里、库里仍有该条目。
- 普通条目彻底删除行为不变。

**`src/features/scenario/scenarioChapter.e2e.test.tsx`**

- 用**新建 OC** 开局并推进几步、主线沉淀后在写作页打开该章「写这一章」：「本次注入」有「推演专属设定（主角『X』…）」「互动推演 · 第 a–b 步原文」「世界线状态」三项；请求 user 含步骤原文，且含 OC 的「身份」「说话方式」字段值；采用前章节正文不变（验收 26）。
- 本章内揭示的预设人物：限定到本推演、带 `revealHint` 的预设人物 P，在本章第 2 步（本章覆盖第 1–4 步）的差异里 `revealed`，且第 3 步原文提到 P → 「写这一章」请求的 user 含 P 的字段原文，「推演专属设定」清单项的计数包含 P；对照组：P 只在第 6 步（下一章）才揭示时，本章请求不含 P。`chapterContext.test.ts` 用纯函数夹具再测一遍同样两例。
- 同一章节打开段落加工（`ReviseSheet`）并发出请求：user 不含【本章依据的互动推演】与【本章涉及的推演专属设定】（也可放在 `ChapterEditor.test.tsx`）。
- 外传沉淀后 `SideStory.scenarioSource.forkNodeId` 正确；生成外传第 1 章的请求含【分叉之前的经过】；导出这部外传的文本不含分叉前任何一步的情节（验收 27）。
- 主线切到另一条线后，旧主线沉淀的大纲节点显示「来自旧主线」，章节正文仍在（验收 28）。

**现有测试的必要改动**（不是提示词断言）：`WritingNormsSection.test.tsx` 默认作用范围按钮 5 → 6、列表元信息加「互动推演」；`DexieNovelRepository.test.ts` 全部 4 处 `verno`；`backup.test.ts` 版本号相关用例；`writingNorm.test.ts` 的 `ALL_NORM_SCOPES` 长度。

### 13.3 单测 / 集成的划分

纯函数（`worldline.ts`、`scenario.ts`、`scenarioPrompt.ts`、`pathOutline.ts`、`promote.ts`、`proseTail.ts`）全部单测，不需要 DOM 与数据库；仓储、迁移、备份在 fake-indexeddb 上集成测；页面与数据流用 Testing Library，模型调用一律 stub `fetch`。宽窄屏视觉形态在 jsdom 里验证不了，只验证单套 DOM 与无障碍名称，视觉由验收 40 手测。

### 13.4 验收命令

`npm run build`、`npx vitest --run`、`CI=1 npx vitest --run` 全绿（文件数与用例数只增不减，无失败、无跳过），并完成 §12.2 的交叉核对。

---

## 14. FEAT 拆分

每个 FEAT 结束时 `npm run build` 与全量测试必须绿。

| FEAT                       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 涉及文件                                                                                                                                                                                                                                                                                                                                                                                                                                 | 验收方式                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 基线**                 | 复制 `/tmp` 基线；在旧代码上产出 `BASELINE`；新建 `noScenarioBaseline.test.ts`（此时只有基线用例）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `src/context/noScenarioBaseline.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                 | 新旧两边跑通                                                                                                                                                                                                                                             |
| **1 数据模型与世界线解析** | schema（推演、节点、差异、条目 `scope` / `fieldLocks`、`FieldDef.mutability`、三处 `scenarioSource`、`interactive` 作用范围、`scenarioOutline` target 占位）；`defaults.ts` 默认可变性；`writingNorm.ts`（`NORM_SCOPES`、`addInteractiveScopeIfFull`）；`sections.ts`（用法句）；`worldline.ts`、`scenario.ts`；Dexie v7；仓储全部新方法与 `listEntries` / `findEntryByName` / `hardDeleteEntry` 改动；知识库页、回收站、收件箱传 `scope: 'all'`；回收站 `purge()` 的 try/catch + `role="alert"` 与「推演《X》的主角」小字（§8.5）；备份 v4（含规则 10）与合并导入按推演整棵替换 + `pruneScenarioRefs` 清理悬空引用（§4.2 末尾）；基线追加变体 | `schema.ts`、`defaults.ts`（含 `builtinMutability`）、`BackupSection.tsx`（合并导入说明一句）、`writingNorm.ts`、`sections.ts`、`worldline.ts`、`scenario.ts`、`db.ts`、`NovelRepository.ts`、`DexieNovelRepository.ts`、`backup.ts`、`KnowledgePage.tsx`、`TrashSheet.tsx`、`ProposalInbox.tsx`、`fields.ts`（`fieldSpecsFor` 占位分支）、`apply.ts`（穷尽检查要求先加 `scenarioOutline:*` 分支，FEAT 1 里抛「尚未支持」，FEAT 5 实现） | T1、T2（单元与仓储部分）、T9、T10；合并导入清理后「export → parseBackup」成功；`TrashSheet.test.tsx` 的主角拒删用例；现有规范 UI 测试改为 6 项                                                                                                           |
| **2 推演生成与循环**       | `proseTail.ts` 与 `useLlm.runProseWithTail`；task profiles；`stepSchema.ts`；`scenarioPrompt.ts`；`useScenarioRunner.ts`（推进、收尾、再给选项、检查点补齐与去重、卸载时 abort）                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `src/llm/proseTail.ts`、`useLlm.ts`、`taskProfiles.ts`、`src/features/scenario/{stepSchema,scenarioPrompt,useScenarioRunner}.ts`                                                                                                                                                                                                                                                                                                         | `proseTail.test.ts`、`scenarioPrompt.test.ts`、runner 的 stub-client 单测（截断与修复不落节点）                                                                                                                                                          |
| **3 推演 UI 与导航**       | 路由；写作页卡片与列表；开局设定；推演页；世界线导航；本线状态（查看、编辑差异、前情摘要）；收尾面板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `AppShell.tsx`、`WritingPage.tsx`、`src/features/scenario/{ScenarioEntryCard,ScenarioListSheet,ScenarioSetupSheet,ScenarioPage,ScenarioBreadcrumb,WorldlineNavigatorSheet,WorldlineStateSheet,DeltaEditor,WrapUpSheet,DeleteScenarioDialog}.tsx`（`ScenarioPage` 外层 `RequireNovel`）                                                                                                                                                   | T3、T4、T5、T6、T11；手测 375px / 1280px（验收 40）                                                                                                                                                                                                      |
| **4 世界观属性与提升**     | 条目编辑的「互动推演设置」、列表徽标、分类管理的可变性开关；`promote.ts`；`applyProposal` 的 `promoteFrom`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `EntryEditorSheet.tsx`、`EntryList.tsx`、`CategoryManagerSheet.tsx`、`src/features/scenario/promote.ts`、`apply.ts`、`WorldlineStateSheet.tsx`                                                                                                                                                                                                                                                                                           | `promote.test.ts`、`apply.test.ts` 追加、知识库 UI 用例（徽标、锁定开关写入）                                                                                                                                                                            |
| **5 沉淀为大纲 / 外传**    | `path-to-outline`；`pathOutline.ts`；`SedimentSheet.tsx`；`scenarioOutline:create` 落库；构建器 `scenarioContext`；`chapterContext.ts`；`ChapterEditorScreen` 接线；过期标记（推演页提示 + 大纲节点面板）                                                                                                                                                                                                                                                                                                                                                                                                                                      | `pathOutline.ts`、`SedimentSheet.tsx`、`apply.ts`、`fields.ts`、`ContextBuilder.ts`、`SummaryChainContextBuilder.ts`、`chapterContext.ts`、`ChapterEditorScreen.tsx`、`OutlineNodeSheet.tsx`（只加一行标记）                                                                                                                                                                                                                             | T7、T8、构建器用例、`chapterContext.test.ts`（本章内揭示的预设进第一块）、`pathOutline.test.ts` 的有洞与换主线后追加用例、`scenarioChapter.e2e.test.tsx`（含新建 OC 与本章揭示预设的档案断言）、`ChapterEditor.test.tsx`（加工请求不含推演块）、基线仍绿 |
| **6 文档**                 | §15 清单                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `docs/*`                                                                                                                                                                                                                                                                                                                                                                                                                                 | 审查逐条核对                                                                                                                                                                                                                                             |

不改：`GenerateChapterSheet.tsx`（`scenarioContext` 随它自己的 `context` prop 透传，类型已包含）、`computeStats`（理由见 §12.1）、`SetupSection.tsx`、`ReviseSheet.tsx`、`NormCheckSheet.tsx`、`ChapterSummarySheet.tsx`、`ImportScreen.tsx`、`TranslateSheet.tsx`、`exportText.ts`、设置页。

---

## 15. 文档更新清单

**`docs/产品文档.md`**

- 1 节或 4 节：价值主张加一条「互动能沉淀」：一条世界线可以变成大纲与章节。
- 5.1：例外从两类改为三类，加「互动推演的沙盒内容（每一步的情节、世界线差异、前情摘要）」，附 D6 的五点理由。第 1 点按 D6 现在的写法照录：沙盒内容只通过两条已确认的通道影响作品 ——①「提升为世界观」提案；②「沉淀」：作者先在大纲提案里确认分章，之后整章生成才把对应步骤的原文与状态作为生成材料注入，产出的正文仍走可编辑预览；除此之外没有任何链路读取沙盒。**不得**写成「沙盒不被任何链路读取」。
- 5.2：加推演差异的丢弃规则（锁定、未知条目 / 字段、世界规则不会死亡）。
- 6.2 知识库：条目的作用范围与可变性（为什么按字段、默认值表、提升规则）；写作规范作用范围表加「互动推演」一行，并说明老规范只在五项全开时自动补上。
- 新增 **6.8 互动推演**：开局设定、一步的构成、选项与已走过、自由输入的「尝试与后果」、回退与切换不花钱、主线跟随规则、结局与收尾、本线状态、沉淀为大纲 / 外传、主线换了之后的处理；各条「为什么」引用本设计 D1–D9。
- 6.3 写作：「写这一章」对来自推演的章节多注入的四块（推演专属设定、分叉之前的经过、推演原文、世界线状态）；外传可以来自推演并记住分叉点。
- 6.7 导出与备份：备份含推演；旧备份兼容。
- 7 信息架构：写作行改为「写作 ── 互动推演（入口卡片 → 推演页：路径 · 世界线导航 · 本线状态 · 收尾 · 沉淀）· 全书进度 · 大纲树 · …」，并写一句为什么不加第六个主导航（D10）。
- 8 关键流程：新增 8.4「从一局推演到一章正文」。
- 9 成本：加一段推演的缓存策略（同一推演的系统提示与分支无关，步骤 / 收尾 / 再给选项 / 前情摘要共用到【推演规则】为止的前缀；回退不花钱；不预生成；每 5 步一次检查点摘要；沉淀用重点任务模型）；第 1 条「注入量可见、可调」在推演里的落实方式：「本步依据」清单可见，推断来的相关设定可逐条取消（只在本次打开推演页期间有效），其余项只读并说明原因（D5.4）。
- 6.3 写作补一句：来自推演的章节在「写这一章」时会带上推演专属设定（主角档案等）；段落加工不带推演材料。
- 11 非目标：加「图形化分支流程图（第一期）」「多主角（第一期，数据已留口）」「推演内容自动写回世界观」「预生成未选分支」「跨推演合并世界线」。
- 12 演进路线：第二期条目里列出上述延后项与「按规范检查推演节点」。

**`docs/使用说明.md`**：新增「互动推演」一章：开始一局、怎么选、自由输入会被当成尝试、回退与世界线导航、主线是什么、坏结局、收尾、本线状态与编辑、提升为世界观、沉淀成大纲 / 外传、接着写这一章；常见问题（为什么某个变化没记下、为什么不能改某个字段、为什么选项不能再选、为什么推演主角不能在回收站里彻底删除、为什么沉淀章节的摘要里没有记下仅限推演的主角出场、合并导入后某些大纲为什么不再关联推演）。

**`docs/世界观写作指南.md`**：新增一节「为互动推演准备设定」：

- 世界观条目是**底层**，推演里的变化是**世界线**，两者分层写；不要把「某人后来叛变」写进人物设定，那是世界线上的事。
- 哪些字段默认锁定、哪些可变（§3.3 的表），锁定字段要写成可验证的规则（推演会拿它判定主角的尝试能不能成功）；「限制与代价」写得越具体，推演里的失败越有说服力。
- 隐藏人物 / 分支专属事物：导入后在条目里设「仅限推演」和登场条件，而不是写进正文。
- 第 8 节给其他 AI 的提示词补一条：「规则类设定写清『能做什么、不能做什么、代价是什么』三件事」。

**`docs/设计方案.md`**（建议项，实现计划单列最后）：第 7 节数据模型加 `Scenario` / `ScenarioNode` / 世界线差异 / 条目新属性；第 9 节加推演的装箱顺序；备份版本 4。

---

## 修订记录

### 第 1 轮

第 1 轮设计，尚无审查意见。需求文档 `requirements.md` 的一处同步修订：F6.1 补充可提升的范围（字段覆盖与本线新条目可以提升；状态、主角状态、事件与标记不可提升，理由见本文 §7.1）。

### 第 2 轮（回应 `design-review.md` 第 1 轮，CHANGES_REQUESTED：HIGH 1 / MEDIUM 11 / LOW 9 / NIT 6）

全部 27 条都已处理，没有转入待办，也没有不处理的。

| #   | 级别   | 处理                                                                                                                                                                                                                                                                                                                                                               | 位置                              |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 1   | HIGH   | 已解决。`scenarioContext` 加第四块【本章涉及的推演专属设定】：主角必选，再加本章碰过或提到的可见限定条目原文，最多 `MAX_INFERRED_ENTRIES` 条。这一块必选，放在易变后缀，清单 id 是 `scenario-limited`；主角是通用条目时不重复渲染。D4.1 的理由改成「档案由 scenarioContext 注入」。e2e 断言新建 OC 的「身份 / 说话方式」会进请求。需求文档 F11.2、验收 26 同步修订 | §0、D4.1、D7.2、D7.3、§7.3、§13.2 |
| 2   | MEDIUM | 已解决。D6 第 1 点改写为「只通过两条已确认通道」，§15 的 5.1 照录，并注明不得写成「不被任何链路读取」                                                                                                                                                                                                                                                              | D6、§15                           |
| 3   | MEDIUM | 已解决，用审查给的方案 A：推断来的相关设定可以逐条取消勾选，只在页面会话内有效，不落库，只影响用户提示。其余项只读并说明原因。§15 第 9 节写明怎么落实                                                                                                                                                                                                              | D5.1、D5.4、§8.3、§13.2、§15      |
| 4   | MEDIUM | 已解决。给出 `OptionsBatchSchema` / `SummaryOutSchema`、两个 builder 的完整签名和 user 文本。system 复用 `buildScenarioSystemPrompt`，四种请求在【推演规则】之前逐字节相同，并补了测试。已核对 `structured.ts` 的 `buildSystemPrompt` 确实把 schema 追加在 system 末尾                                                                                             | §5.4、§5.3、§13.2                 |
| 5   | MEDIUM | 已解决。新增纯函数 `checkpointsToFill`，按深度依次补，输入取「最近有摘要的祖先 A 的摘要 + A 之后的原文」。`gap ≤ 7` 在后台补，`gap > 7` 同步补，失败时本步不生成；用内存 `Set` 去重在途请求，卸载时取消。消除了「下次重试」与「gap > 7 才补」的矛盾                                                                                                                | D5.3、§5.3、§8.3、§9、§13.2       |
| 6   | MEDIUM | 已解决。`builtinMutability`：内置 kind 查 BUILTIN 模板；custom 分类只有在名称与 SUGGESTED 同名且键在模板里时才取默认，否则可变。补了三例测试（含改名后变为可变）                                                                                                                                                                                                   | §3.3、§13.2                       |
| 7   | MEDIUM | 已解决。(a) 本线条目用 `fieldMutability(category, undefined, key)`，锁定字段只能在新建时给值。(b) 已提升的本线条目作为世界观条目的别名，路径上的覆盖和状态改作用到它，只在本路径生效；世界观条目被删后别名失效，回退到本线条目。补了测试                                                                                                                           | §3.2、§3.4、§7.1、§13.2           |
| 8   | MEDIUM | 已解决，采用 §3.1 的规则：只有 `revealHint` 非空的才进预设块，`fromNodeId` 条目在子树内是普通可见条目                                                                                                                                                                                                                                                              | D5.1                              |
| 9   | MEDIUM | 已解决。候选集改为 `entries ∪ pendingReveals`；引用预设条目时隐含 revealed；与预设重名的 newEntries 改记为 revealed，字段转成覆盖。揭示和处境分开记，`restored` 只清处境。补了单测                                                                                                                                                                                 | §3.2、§3.4、§13.2                 |
| 10  | MEDIUM | 已解决。只剥「对应步骤」一行，「关键事件 / 出场」留在 synopsis，出场另外写进 `linkedEntryIds`。步数统一用绝对步数（depth + 1），schema 改为 `buildPathOutlineSchema(from, to)`，报错文案用本次范围。补了续沉淀往返测试                                                                                                                                             | D7.1、D7.2、§7.2、§13.2           |
| 11  | MEDIUM | 已解决。(a) §4.2 加规则 10，§2.4 引用它。(b) 合并导入改为按推演整棵替换节点，§6.1、§11 同步，合并导入的说明文字加一句。补了仓储合并用例和备份拒绝用例。合并用例放在 `DexieNovelRepository.test.ts`，因为 `importSnapshot` 在仓储里                                                                                                                                 | §2.4、§4.2、§6.1、§11、§13.2      |
| 12  | MEDIUM | 已解决。翻译、文风取样、导入文风提炼三组函数加进 `BASELINE`，覆盖 N4 的十类任务。§12.1 列出 TranslateSheet 等全部默认调用点，并说明翻译不带推演人物是有意为之。§12.2 第 4 条的仓储断言同时守住这些调用点                                                                                                                                                           | §12.1、§12.2                      |
| 13  | LOW    | 已改为全部 4 处（含 2248 行）                                                                                                                                                                                                                                                                                                                                      | §4.1、§13.2                       |
| 14  | LOW    | 已解决。只在 GenerateChapterSheet 的 prop 上加，共享的 context 不带；补了加工请求不含推演块的断言                                                                                                                                                                                                                                                                  | D7.3、§7.3、§12.1、§13.2          |
| 15  | LOW    | 已解决。删除确认框加复选框，默认勾选，并写明文案与理由。仓储说明了限定到多个推演的条目怎么处理                                                                                                                                                                                                                                                                     | §6.1、§8.3、§13.2                 |
| 16  | LOW    | 已解决。同一分叉点已有外传、且当前节点在它最后一步的子树里时，默认追加；另提供「另建一部外传」。payload 加 `appendToSideStoryId`，仓储加对应的失败条件                                                                                                                                                                                                             | §7.2、§6.2、§13.2                 |
| 17  | LOW    | 已写明未开局状态：显示「还没有开局」和「开始」，导航与操作栏禁用                                                                                                                                                                                                                                                                                                   | §8.3、§13.2                       |
| 18  | LOW    | 已解决。卸载时 abort 全部在途请求，什么都不存，并写了放弃「后台继续」的理由。补了 UI 测试                                                                                                                                                                                                                                                                          | §5.3、§8.3、§9、§13.2             |
| 19  | LOW    | 已决定：`entryCount` 继续统计全部条目（与知识库页一致），代码不改。立项的 entryCount 只算通用条目。写进 §12.1 的「可见行为变化」                                                                                                                                                                                                                                   | §12.1、§14                        |
| 20  | LOW    | 已解决。以 `kind` 为准，冲突时 `goalId` 置 null 并给出提示；`arrivedBy.goalId` 记作者的选择，不一致时在结局节点上显示                                                                                                                                                                                                                                              | D3.1、D4.3、§3.4                  |
| 21  | LOW    | 已解决。字段覆盖的提升改用 `buildReplaceProposal`，payload 是只换一栏的完整实体（`knowledgeEntry:replace` 分支已存在）。本线条目与已有通用条目重名时改成 merge 提案，带 `promoteFrom`，`promoteLineEntry` 加 `mergeInto` 分支。补了 list 字段测试                                                                                                                  | §6.1、§7.1、§13.2                 |
| 22  | NIT    | 已统一。新增 `visibleProse`，只认完整分隔符，并隐藏末尾未完成的前缀。补了分块边界测试                                                                                                                                                                                                                                                                              | D3.2、§5.2、§13.2                 |
| 23  | NIT    | 前缀第 4 项排除 `cast[].entryId`                                                                                                                                                                                                                                                                                                                                   | D5.1、§13.2                       |
| 24  | NIT    | `latestLeafOf` 改为 depth > createdAt > id                                                                                                                                                                                                                                                                                                                         | §8.3、§13.2                       |
| 25  | NIT    | 四项 id 分别为 `scenario-limited` / `scenario-fork` / `scenario-steps` / `scenario-state`                                                                                                                                                                                                                                                                          | D7.3、§13.2                       |
| 26  | NIT    | 统一为「到当前节点」                                                                                                                                                                                                                                                                                                                                               | D8.1                              |
| 27  | NIT    | `castId` 由代码填 `cast[0].id`；迁移的缺省值改为冻结常量 `ALL_NORM_SCOPES_V6`                                                                                                                                                                                                                                                                                      | §3.4、§5.3、§4.1、§13.2           |

需求文档同步修订：F11.2 与验收 26 补上「推演专属设定（含主角档案）」这一注入项，并写明段落加工不注入推演材料。原文只说「推演原文与世界线状态」，照它实现就会出现 #1 的问题。

### 第 3 轮（回应 `design-review.md` 第 2 轮，CHANGES_REQUESTED：HIGH 1 / MEDIUM 2 / LOW 8 / NIT 5）

16 条全部处理，没有转入待办，也没有不处理的。

| #   | 级别   | 处理                                                                                                                                                                                                                                                                                                                                                                                                                               | 位置                                    |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | HIGH   | 已解决，采用审查给的方案。merge 分支在同一事务里，替换完节点后调用私有函数 `pruneScenarioRefs`：大纲节点 / 外传章节的 `nodeIds` 去掉已不存在的步骤，一个不剩时置 null；外传的分叉节点不在了就解除关联；限定条目里 `fromNodeId` 失效的 target 去掉（不改成 null，否则会扩大可见范围），targets 因此为空时软删除。覆盖恢复不调用。补了五种本地行的合并用例，并断言合并后 `exportSnapshot → parseBackup` 成功。§11 补了作者可见的后果 | §4.2 末尾、§6.1、§11、§13.2、§14 FEAT 1 |
| 2   | MEDIUM | 已解决。【本章涉及的推演专属设定】改为取**本章最后一步**的 `effectiveKnowledge.entries` 里 `origin === 'limited'` 的条目，再按「差异碰过 ∪ 原文提到」筛选，写明为什么不取第一步的父节点。e2e 和 `chapterContext.test.ts` 都补了「第 2 步揭示的预设 P 进请求」与「下一章才揭示则不进」的对照                                                                                                                                        | D7.3、§13.2、§14 FEAT 5                 |
| 3   | MEDIUM | 已解决，用方案 A。`TrashSheet.purge()` 加 try/catch，失败时在确认框内用 `role="alert"` 显示，框不关；列表里给推演主角加「推演《X》的主角」小字（预先查 `listScenarios`）。补了 `TrashSheet.test.tsx` 用例；§6.2 写明唯一调用方怎么接住这个错误                                                                                                                                                                                     | §8.5、§6.2、§11、§13.2、§14 FEAT 1      |
| 4   | LOW    | 删除推演的确认框改用 `Sheet size="dialog"` 自己拼（`DeleteScenarioDialog.tsx`），不改共享的 `ConfirmDialog`。框内的失败显示也写上了                                                                                                                                                                                                                                                                                                | §8.3、§14 FEAT 3                        |
| 5   | LOW    | `requirements.md` F6.2 改为「字段覆盖走 replace 提案」，同名时 create 改成 merge，并写明理由                                                                                                                                                                                                                                                                                                                                       | requirements F6.2                       |
| 6   | LOW    | 续沉淀主线范围改为 `[a, b]`：`a` 是第一个未覆盖的步骤，`b` 是其后第一个已覆盖步骤的前一步，没有就到当前节点。补洞产生的卷追加在末尾，提示作者用大纲树已有的「调整位置」移动（不自动插入，理由已写）。补了有洞的测试                                                                                                                                                                                                                | §7.2 第 2 步、D7.5、§11、§13.2          |
| 7   | LOW    | 只有章级节点写 `scenarioSource`，卷节点为 null；覆盖与过期计算只看非空的节点。仓储用例同步                                                                                                                                                                                                                                                                                                                                         | D7.2、§13.2                             |
| 8   | LOW    | 「追加到外传」改为判定当前节点是否在外传最后一步 `L` 的子树里（不含 `L` 本身），不再比较 `forkNodeId`；有多部满足时取 `L` 最深的一部；《X》的 `forkNodeId` 不变。补了换主线后仍能追加的测试                                                                                                                                                                                                                                        | §7.2 第 2 步、§11、§13.2                |
| 9   | LOW    | 统一为：补摘要只在推进 / 收尾前和新检查点落库时触发，挂载、跳转、切换世界线、打开面板都不发请求。T5 夹具加了缺摘要的检查点，断言这些操作期间 fetch 计数为 0                                                                                                                                                                                                                                                                        | D5.3、§13.2                             |
| 10  | LOW    | §12.1 写明这是有意的行为变化（不改代码）：摘要链路不开 `scope: 'all'`，避免推演人物进全书的出场记录；主角档案由 D7.3 必选注入；改成通用后自然恢复。使用说明的常见问题里加一条                                                                                                                                                                                                                                                      | §12.1                                   |
| 11  | LOW    | §8.3 新增第 0 项：外层 `RequireNovel`；推演不存在时显示「这个推演已不存在」+「回写作页」；属于其他作品时显示「去书架」。补了 UI 用例                                                                                                                                                                                                                                                                                               | §8.3、§11、§13.2、§14 FEAT 3            |
| 12  | NIT    | 五个 profile 的 label 已补                                                                                                                                                                                                                                                                                                                                                                                                         | §5.1                                    |
| 13  | NIT    | 沉淀提案 `origin: 'generate'`，三种提升提案 `origin: 'refine'`，并写明理由                                                                                                                                                                                                                                                                                                                                                         | §7.1、§7.2 第 5 步                      |
| 14  | NIT    | 在 §6.1 定义了 `EntryCreateInput` / `EntryUpdateInput` 两个别名，与 `createEntry` / `updateEntry` 现有的参数类型相同                                                                                                                                                                                                                                                                                                               | §6.1、§7.1                              |
| 15  | NIT    | 改为「前缀逐字节相同，具备命中条件」，并写明 thinking 开 / 关之间是否共享缓存没有核实、设计不依赖它                                                                                                                                                                                                                                                                                                                                | §5.4                                    |
| 16  | NIT    | `cursorNodeId` 为 null 或失效时回落到 `mainNodeId`，再不行就跳根节点；只在内存里回落，不写库。补了测试                                                                                                                                                                                                                                                                                                                             | §8.3 第 0 项、§13.2                     |

需求文档同步修订：F6.2（见 #5）。
