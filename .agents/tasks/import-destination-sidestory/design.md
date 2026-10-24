# 导入目的地后置 + 外传：需求与技术设计

> 项目：文墨（MyLiterature），纯前端，React 19 + TypeScript + Vite + Dexie(IndexedDB) + Zustand + Zod + vitest + Tailwind 4。
> 本文覆盖两个需求：①「导入到哪里」改在翻译之后选，世界观设定也能翻译；② 主线之外的「外传」。
> 验证：`npm run build`（tsc --noEmit && vite build）+ `npx vitest --run`（现有 1023 个测试必须全过）。
> 范围外且保持原样：设置页「存储诊断」（`DiagnosticsSection.tsx` / `diagnostics.ts`）、`useActiveNovel.ts` 的存储降级。

---

## 0. 摘要

**导入**：去掉粘贴步骤的「导入类型」。所有导入统一走 粘贴 → 分章 →（有外文时）翻译 → 选目的地 → 提取 → 确认。目的地三选一：**主线章节 / 外传 / 仅作为世界观设定**。选定之前，分章草稿和译文都存在 `ImportJob.drafts` 上，一章 `Chapter` 都不写。选主线或外传时，由仓储在**一个事务**里把草稿写成章节；选世界观时，草稿按章打包成提取段，从头到尾不碰 `Chapter` 表。纯中文稿不多一步：目的地选择直接放在分章确认页。

**外传**：新增 `SideStory` 表（一部外传一行，具名，各自从第 1 章编号），`Chapter.sideStoryId` 为 `null` 时是主线。外传有自己的摘要链：章节摘要照常生成，伏笔只在本外传里累计，进展摘要写进 `SideStory.rollingSummary`，主线的 `rollingSummary`、伏笔、上下文和进度一样都不碰。字数计入书架与写作计划，不计入主线进度。导出默认不带外传，可以单独导出，也可以附在全书后面。

---

## 1. 需求

### 1.1 功能需求

**FR-1 导入目的地后置**

- FR-1.1 粘贴步骤不再有「导入类型」控件。
- FR-1.2 目的地三选一，**整批一个目的地**：
  - 主线章节：保持现有行为（章节 `done` / `imported`、逐章摘要、全书进展、可选文风）。
  - 外传：选一部已有外传，或当场新建（填名称）。章节归入该外传，在外传内部编号。
  - 仅作为世界观设定：只出知识库条目提案。不写 Chapter、不占章节编号，也不出章节摘要、全书进展和文风提案。
- FR-1.3 有外文章节时，目的地在翻译**之后**选；纯中文稿在分章确认页直接选。
- FR-1.4 翻译之前和翻译当中，草稿和译文都存进 IndexedDB 里的 ImportJob。刷新、关面板都不丢，可以断点续跑；已经付钱的译文不丢。
- FR-1.5 世界观模式在任何时刻都不写入 Chapter 表。
- FR-1.6 世界观也能翻译，译名照旧写进作品级译名表（先到先得）。
- FR-1.7 IndexedDB 里还没跑完的旧格式 ImportJob 能续跑，或者给出安全提示，绝不能崩。
- FR-1.8 书架新建作品 → `/knowledge` + `state.openImport` 的入口照常工作。

**FR-2 外传**

- FR-2.1 支持多部具名外传，每部各自从第 1 章编号。
- FR-2.2 写作页可以新建、改名或改简介、删除外传，也可以在外传里新建、查看、编辑章节。外传和主线分开展示，移动端和桌面端都要能用。
- FR-2.3 外传章节在编辑器里的功能和主线一样：整章生成、段落加工、翻译、标记完成并自动摘要。
- FR-2.4 「不计入主线」的含义：不占主线编号；不进主线摘要链、`Novel.rollingSummary` 和主线伏笔；生成主线章节时不注入外传的摘要或结尾；写作页的「全书进度」不含外传；主线导出默认不含外传。
- FR-2.5 外传有自己的摘要链（章节摘要 + 外传进展摘要 + 外传内累计伏笔）。
- FR-2.6 导入时可以选「作为外传导入」。提取出的条目合并进同一个知识库，摘要进外传链。
- FR-2.7 外传字数计入书架总字数和写作计划的每日产出。

### 1.2 非功能需求

- 原则不变：结构化产出一律先成为提案，经确认才落库；合并只补不删；宁可少记，不要记错；翻译必须用户手动点开始；译名表挂在作品上，先到先得。
- 主线 prompt 逐字节不变（命中 prompt 缓存，也让既有测试稳定）。生成外传章节时，稳定前缀和主线**完全一致**，外传特有的内容一律放进易变后缀。
- 单套 DOM + CSS 断点，不按屏幕宽度分叉渲染。
- 旧数据（v4 库、旧备份文件）无损读入，默认全部视为主线。

### 1.3 验收标准

1. 粘贴步骤没有「导入类型」控件。纯中文稿从粘贴到开始提取，点击次数和现在一样（粘贴 → 下一步 → 分章页选目的地 → 写入）。
2. 外文稿分章确认后，翻译期间和翻译完成后 `listChapters` 都是 `[]`。`getImportJob().drafts` 里有译文、原文和 `translateStatus`。
3. 翻译到一半关掉再打开，面板回到翻译步骤，已译章节显示「已译」，不会重新付费。
4. 外文稿译完选「主线」后，章节 `content` 是译文，`sourceContent` 是原文，`sourceLanguage` 是原文语种，`wordCount` 按译文算，从主线最大章号 +1 开始编号。
5. 外文稿译完选「世界观设定」后，提取 prompt 里是**中文译文**，不是原文。全程 `listChapters` 为 `[]`，只出 `knowledgeEntry` 提案，译名进了作品译名表。
6. 世界观模式下，几个短章节会打包进同一次提取调用（总长 ≤ 6000 字）。单章超过 6000 字时按段落切成多段，段标签里带章节标题。
7. 选「外传 → 新建『青冥旧事』」后，`SideStory` 新建出来，章节的 `sideStoryId` 指向它，编号是 1..N。第二批导入同一部外传时从 N+1 接着编号，主线编号不受影响。
8. 外传导入的收尾不生成 `novel` 进展提案，而是生成 target 为 `sideStory` 的「外传进展摘要」提案。采用后 `SideStory.rollingSummary` 更新，`Novel.rollingSummary` 不变。
9. 外传导入时「顺便归纳文风」默认不勾，主线导入默认勾上，世界观模式不显示这个选项。
10. `commitImportChapters` 失败时（外传已删除、名称重复、任务已经写入过），一章都不写，任务保持原样。连续调用两次只会写一次；界面在第二次被拒后重读任务，直接进入提取步骤，不显示错误。`commitImportWorldview` 和 `saveImportDrafts` 遇到已写入的任务同样被拒，任务不变（跨标签页也成立）。
    10a. 翻译中有章节失败时点「跳过剩下的」，刷新后仍落在目的地步骤，失败章按原文写入或提取。
    10b. 任何形状的旧 ImportJob 行（字段缺失、类型不对）都不会让 v5 升级失败；换算不了的行在面板加载时被清掉，作品和章节不受影响。缺 `drafts` 等数组键的旧 main / worldview 行打开导入面板不会白屏，「放弃这次导入」可用。
    10c. 翻译中关掉面板又马上打开、新实例译完别的章之后，旧实例迟到的写回不会把已译章节改回原文，也不会给已提交或已放弃的任务塞回草稿、凭空新建任务行。`done` 的草稿在仓储层不可降级。分章页提交时，库里另一份草稿任务不会被悄悄覆盖。
    10d. 译文被输出上限截断（`finish_reason: 'length'`）时，这一章标为失败、草稿仍是原文，不会被当成已译；超过 6000 字的外文草稿在分章页有截断风险提示。
11. 生成主线章节时，「上一章 / 最近摘要 / 结尾原文」只取主线章节。即使外传章节的编号更大、更新时间更晚也一样。
12. 生成外传章节时，只取同一部外传的前文。默认不注入 `Novel.rollingSummary`，打开「参考主线进展」后才注入，并在注入清单里显示出来。易变后缀里必定有外传说明块。主线和外传章节在选同一组条目时，`stablePrefix` 相同。
13. 外传章节标记完成后，自动摘要产出 `chapterSummary` + `sideStory` 两条提案。伏笔只承接同一部外传的上一份摘要。
14. 写作页「全书进度」的字数和章数不含外传。「外传」区按部列出各自的章数、字数和章节列表。外传章节的编辑器标题显示「外传·青冥旧事 第 2 章」。
15. 书架卡片的总字数含外传。章数只算主线，有外传时另显示「外传 K 章」。外传章节的产出照常记入每日日志。
16. 导出的「全书」默认不含外传，开关「附带外传」打开后按外传顺序追加在正文后面。范围多了「外传」一项，可以单独导出一部。
17. 删除外传需要二次确认，会连带删掉它的章节和摘要。
18. v4 库升级到 v5：既有章节的 `sideStoryId` 为 `null`。旧版世界观任务（`importType: 'worldview'`）能接着提取；旧版章节任务能接着提取，有未完成翻译时给出说明，不自动开始；旧版空任务被清掉，面板回到粘贴步骤。
19. 不带 `sideStories`、章节不带 `sideStoryId` 的旧备份能恢复，恢复后全部是主线。外传章节指向不存在外传的备份会被拒绝，并给出明确提示。新备份的文件版本为 2。
20. 1023 个既有测试（按新流程改写之后）和新增测试全部通过，`npm run build` 通过。

### 1.4 范围外

- 逐章混选目的地（见 6.8）。
- 外传的大纲树（见 6.7）。
- 已有章节在主线和外传之间移动、外传之间重排顺序（backlog：要处理重新编号和摘要链断裂）。
- 「存储诊断」面板与 `useActiveNovel.ts`。
- 按「番外」标题自动预选目的地。

### 1.5 假设

- 外传是同一部作品的番外、前传或后传，共享同一个知识库和风格档案，而不是另一部作品。
- 单次导入的稿件在几十万字量级，整份放进一行 ImportJob（IndexedDB）可以接受（见 3.2）。
- 用户先前说过「旧数据不用捞回来」，所以旧任务的兼容目标是**不崩、能接着跑或安全放弃**，不追求还原旧流程的每一步。

---

## 2. 技术栈与总体做法（定稿，不再变更）

沿用现有栈，不新增依赖：Dexie 升到 **v5**；Zod 4（`z.discriminatedUnion`、`z.preprocess`、`superRefine`）；React 组件沿用 `Sheet` / `ConfirmDialog` / `RadioList` / `SelectField` / `TextField` / `Toggle` / `Section`。

为什么外传仍然住在 `chapters` 表里，而不是另开一张表：编辑器、翻译、段落加工、自动摘要、译名一致性检查、备份都围绕 `Chapter` 实现。另开一张表，这些全得复制一份，两份必然漂移。区分主线和外传只需要一个外键，难点在「谁负责按线过滤」，这一点在第 7 节写明归属。

---

## 3. 数据模型

### 3.1 Schema 变更（`src/domain/schema.ts`）

```ts
// 新增：外传。一部一行，与 Novel.rollingSummary 同理把进展摘要放在自己身上
export const SideStorySchema = z.object({
  id: IdSchema,
  novelId: IdSchema,
  /** 不含「外传·」前缀；展示时统一拼成「外传·{title}」 */
  title: z.string().trim().min(1, '外传名称不能为空').max(40),
  /** 讲什么、发生在主线的什么时候。会进外传章节的 prompt */
  synopsis: z.string().max(2000).default(''),
  /** 外传自己的进展摘要，替代主线的 Novel.rollingSummary */
  rollingSummary: z.string().default(''),
  order: z.number().int().nonnegative().default(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

// Chapter 新增
/** null = 主线；否则为所属外传。外传章节的 index 在外传内部从 1 起 */
sideStoryId: IdSchema.nullable().default(null),
```

- **「track 字段」就是这个 `sideStoryId`**，不再单独存 `track: 'main' | 'side'`：两个字段可能互相矛盾（比如 `track: 'side'` 却没有 id），一个可空外键表达不出非法状态。判断主线统一走 `isMainChapter()`（3.4），需要「线」这个概念的地方用 `sideStoryId ?? null` 作为线的键。
- `ProposalTargetSchema` 加 `'sideStory'`。`fieldSpecsFor('sideStory')` 返回 `[{ path: 'rollingSummary', label: '外传进展摘要', kind: 'longtext' }]`。
- `NovelStats` 加 `sideChapterCount: number`。
- `RepositorySnapshotSchema` 加 `sideStories: z.array(SideStorySchema).default([])`，并加一道 `superRefine`，对每个 `sideStoryId` 非 null 的章节依次检查，命中第一条即报错：
  - `sideStoryId` 不在快照的 `sideStories` 里：路径 `chapters.{i}.sideStoryId`，「找不到所属外传」。
  - 所属外传的 `novelId` 与章节的 `novelId` 不同：同一路径，「所属外传不属于这部作品」。
  - `outlineNodeId` 非 null：路径 `chapters.{i}.outlineNodeId`，「外传章节不能关联大纲节点」。

  这三条和仓储的不变量（第 7 节）一致。备份是唯一能绕过仓储写入的入口，所以在入口处再验一遍。

### 3.2 ImportJob 新字段

```ts
export const ImportTranslateStatusSchema = /* 不变 */;

/** 选目的地之前的分章草稿：正文、翻译状态与原文都在这里，不落 Chapter */
export const ImportDraftSchema = z.object({
  index: z.number().int().positive(),        // 本批序号（分章页的「第 N 章」）
  title: z.string().default(''),
  content: z.string(),                       // 当前正文：译完即为译文
  sourceContent: z.string().default(''),     // 译前原文；空串 = 没译过
  sourceLanguage: z.string().default(''),
  translateStatus: ImportTranslateStatusSchema.default('none'),
  translateError: z.string().default(''),
});

export const ImportDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }),
  z.object({ kind: z.literal('side'), sideStoryId: IdSchema }),
  z.object({ kind: z.literal('worldview') }),
]);

// ImportJobSchema 变更
destination: ImportDestinationSchema.nullable().default(null),  // null = 还没选
drafts: z.array(ImportDraftSchema).default([]),                 // 只在 destination 为 null 时非空
// ImportWorldviewChunkSchema 加：title: z.string().default('')  —— 覆盖的章节标题，用作段标签
// 删除：importType、worldviewText（见 3.3 迁移）
```

阶段和字段的对应关系是一条硬约束：

| `destination`   | `drafts` | `chapters`           | `worldviewChunks` |
| --------------- | -------- | -------------------- | ----------------- |
| `null`          | 非空     | `[]`                 | `[]`              |
| `main` / `side` | `[]`     | 非空（带 chapterId） | `[]`              |
| `worldview`     | `[]`     | `[]`                 | 非空              |

这张表**不靠 schema 强制**（用 `superRefine` 强制的话，`upsertImportJob` 的 `{...current, ...patch}` 每次 patch 都得一次带齐几个字段，反而容易写错）。改由三个**仓储方法**各自在事务里保证：`saveImportDrafts`（进入草稿阶段）、`commitImportChapters`（进入 main / side）、`commitImportWorldview`（进入 worldview），见 4.4。只有这三处会改 `destination` 和这三个数组的长度。草稿阶段的逐章修改（翻译、勾选、重试、跳过）**不走** `persistJob`，一律走第四个仓储方法 `patchImportDrafts`（4.4）：它在 `importJobs` 的 `rw` 事务里按 `index` 把 patch 合并进**库里最新那一行**的 `drafts[i]`，任务已不在草稿阶段（`destination !== null`）或不存在时直接拒绝，所以既不会改数组长度，也不会把过期的整份数组写回去。为什么不能沿用 `persistJob`：它传的是本组件实例 `jobRef` 里的整份 `drafts`，`upsertImportJob` 又是「先读、后写」不在同一事务、没有行时还会新建；面板关掉后还在跑的那一章（旧实例）写回时，会把新实例刚译好的章节改回原文，或者给已提交的任务重新塞回 `drafts`（第 3 轮评审发现 1）。提取循环仍经 `persistJob`，只改 `chapters[i]` / `worldviewChunks[i]` 的状态以及 `entryDrafts`、`rollingSummary`、`openThreads`，不改数组长度。读取侧由 `resumeStepOf`（4.6）兜底：不符合表格的组合，即表里要求为空的数组有任何一个非空、或要求非空的为空，一律清掉。

**草稿为什么存在任务上，而不是另开一张 `importDrafts` 表**：另开一张表能做到逐章单独写，但要多出一张表的迁移、级联删除、备份和放弃时的清理。按实际量级算，整份放在一行里没有问题：几十万字的稿件加上译文是几 MB。翻译是一分钟一章的慢操作，每译完一章整行重写一次，写放大可以忽略。进入提取阶段时 `drafts` 会清空，提取循环的写入量和现在一样。这批文字只在选定目的地之前存在，生命周期和任务一致，放在任务上正合适。这也是开发计划里「留给后来人的规矩」要求的检查：草稿的生命周期确实和任务一致。

### 3.3 Dexie v5 与迁移（`src/data/dexie/db.ts`）

```ts
// 顶部 `import type { … } from '@/domain/schema'` 加上 SideStory；
// AppDatabase 类上紧跟 glossaries 补表声明，和现有各表的写法一致
sideStories!: Table<SideStory, string>;

/**
 * v5：外传。
 * - 新增 sideStories 表：外传是具名的、一部一行，各自的进展摘要（rollingSummary）放在自己身上，
 *   与 Novel.rollingSummary 同理；不做成 Novel 上的数组，是因为删除、改名、备份都按行处理更简单。
 * - chapters 加 sideStoryId 索引：只为删除外传时级联删章节（where('sideStoryId').equals(id)）。
 *   IndexedDB 不给 null 建索引项，主线章节不进这个索引，索引只收录外传章节。
 * - [novelId+index] 本来就不是唯一索引，主线和外传编号重复不冲突，不用改。
 * - 读取路径不做 Zod parse，所以用 upgrade 把旧章节的 sideStoryId 补成 null、把旧导入任务换算成新形状。
 */
this.version(5)
  .stores({
    chapters: 'id, novelId, [novelId+index], sideStoryId',
    sideStories: 'id, novelId',
  })
  .upgrade(async (tx) => {
    await tx.table('chapters').toCollection().modify((c) => { c.sideStoryId ??= null; });
    await tx.table('importJobs').toCollection().modify((job) => {
      try {
        const next = upgradeLegacyImportJob(job);
        if (next === job || typeof next !== 'object' || next === null) return;
        Object.assign(job, next);
        delete job.importType; delete job.worldviewText;
      } catch {
        // 第二道防线：这一行保持原样，面板加载时由 resumeStepOf 清掉（见 9 节）
      }
    });
  });
```

- `[novelId+index]` 本来就不是唯一索引，主线和外传编号重复不冲突，所以不需要改。
- 建 `sideStoryId` 索引只为删除外传时级联删章节。IndexedDB 不给 `null` 建索引项，主线章节不会进这个索引，正好合用。
- 和 v3 同一个理由：读取路径不做 Zod parse，界面上会直接读 `chapter.sideStoryId`，所以用一次迁移把旧行补齐。
- `upgradeLegacyImportJob(raw: unknown): unknown` 是放在 `src/domain/importJob.ts` 的纯函数，**两处共用**：v5 的 upgrade，以及 `ImportJobSchema = z.preprocess(upgradeLegacyImportJob, ImportJobObjectSchema)`。后者让旧备份文件里的进行中任务也走同一套换算。规则：
  - 已有 `destination`（`raw.destination !== undefined`，`null` 也算已有）：不换算 `destination`，但仍走下面「补齐形状」这一步（v5 写出的行本来就齐全，补齐是空操作）。
  - `importType === 'worldview'`：`destination = { kind: 'worldview' }`，每个对象形状的 chunk 补上 `title: ''`。
  - 否则 `chapters` 非空：`destination = { kind: 'main' }`，各章的 `translateStatus` 原样保留（用于 4.6 的提示）。
  - 否则：`destination = null`，这是空的旧任务，面板加载时静默清掉。
  - **每个分支都补齐形状**，输出里五个数组键一定存在：
    ```ts
    const arr = (v: unknown) => (Array.isArray(v) ? v : []);
    const { importType, worldviewText, ...rest } = raw; // 每个分支都删掉这两个旧键
    return {
      ...rest,
      destination, // 上面算出的值，或原有的 raw.destination
      drafts: arr(raw.drafts),
      chapters: arr(raw.chapters),
      worldviewChunks: /* worldview 分支补过 title 的 */ arr(raw.worldviewChunks),
      entryDrafts: arr(raw.entryDrafts),
      openThreads: arr(raw.openThreads),
    };
    ```
    为什么不能只在空任务分支补 `drafts`：读取路径不做 Zod parse，`ImportJob` 的 TS 类型里 `drafts` 是必填数组，`job.drafts.some(...)` 能过 `tsc`，运行时却是 `undefined.some`。`src/` 里没有 ErrorBoundary，一次渲染异常就是整个应用白屏，用户连「放弃这次导入」都点不到。所以形状在迁移里补齐，面板加载时再 parse 一次（4.6），两道都要。
- **这个函数必须是全函数，对任何输入都不抛错。** upgrade 回调里只要抛一次异常，整个 v5 升级就会回滚，数据库打不开，用户的全部作品都读不到，这是本次改动里唯一可能致命的环节。旧行也不一定字段齐全：`importType`、`worldviewChunks` 是 v2 之后才加的字段，当时没有迁移补齐。所以约束如下：
  - 输入不是普通对象（`null`、数组、原始值）时原样返回，交给 Zod 或面板处理。
  - 所有数组一律按 `Array.isArray(raw.x) ? raw.x : []` 读取，数组元素不是对象时原样保留。
  - 返回新对象，不修改入参。v5 upgrade 里 `Object.assign` 的是这个返回值，再 `delete` 两个旧键（`modify` 回调里只能就地改行）。
  - 函数内部只做键名换算和补默认值，不调用 Zod，不做任何可能抛错的解析。

### 3.4 领域辅助（新文件 `src/domain/sideStory.ts`）

```ts
isMainChapter(c): boolean                          // (c.sideStoryId ?? null) === null
chaptersOfTrack(chapters, sideStoryId: string | null): Chapter[]   // 按 index 升序
sideStoryLabel(s): string                          // 「外传·青冥旧事」
chapterLabel(c, sideStories): string               // 「第 3 章」/「外传·青冥旧事 第 3 章」
normalizeSideStoryTitle(raw): string               // trim；去掉开头的「外传」「番外」及其后的 ·・:：空白
sideStoryTitleKey(raw): string                     // normalizeSideStoryTitle(raw).toLocaleLowerCase()，查重唯一的比较键
renderSideStoryBrief(story): string                // 外传说明块正文；简介为空时省略简介行（5.2）
```

重名判断只认 `sideStoryTitleKey`：picker 的即时校验、`createSideStory`、`updateSideStory`（排除自身）、`commitImportChapters` 的 `newSide` 都调它，不各自写 `trim` 或大小写处理。存进库的 `title` 是 `normalizeSideStoryTitle` 的结果，保留用户写的大小写。

不管是主线还是外传、是上下文、摘要、导出还是统计，「哪些章节算同一条线」都只从这里取。同一个判断写在五个地方，必然有一处漏掉。

### 3.5 备份兼容（`src/features/export/backup.ts`）

- `BACKUP_VERSION` 改为 **2**，`parseBackup` 接受 `version ≤ 2`。v1 文件里的章节经 `default(null)` 都成为主线，`sideStories` 默认为 `[]`。
- **为什么要升文件版本**：旧版应用用 `z.object` 解析时会悄悄丢掉未知键，于是新备份里的外传章节会变成主线章节，章号和主线重复，摘要链也串了。这类错误恢复时看起来是成功的。升版本后，旧应用一定会拒绝。但要说准确：旧版 `parseBackup` 是**先**整份 `safeParse`、**后**比版本，新备份里只要有 `target: 'sideStory'` 的提案，旧应用会先报通用的「备份文件的内容不符合预期 · proposals.N.target」；没有这类提案时，才会走到「这份备份来自更新版本的应用」。两种都是拒绝、什么都不写，数据安全，只是提示文案不同。旧版本已发出去，这一点改不了。
- **新版 `parseBackup` 调换顺序**，让以后的升级能给出正确提示：
  1. 先用 `z.object({ app: z.literal(BACKUP_APP_ID, …), version: z.number().int().positive() }).passthrough()` 解析文件头，失败时沿用现有的错误文案。
  2. `version > BACKUP_VERSION` 时抛出现有的「来自更新版本」错误。
  3. 最后才做整份 `BackupFileSchema.safeParse`。

---

## 4. 导入流程

### 4.1 新流程与交互位置

```
粘贴 ─▶ 分章 ──┬─ 无外文：分章页内嵌「导入到」──写入/开始提取──▶ 提取 ─▶ 确认
               └─ 有外文：「下一步：翻译」─▶ 翻译 ─▶ 导入到 ─▶ 提取 ─▶ 确认
```

- **纯中文稿不加步骤**：分章页的切分列表下面直接放 `DestinationPicker`，底部主按钮的文案随选择变化：「写入主线 N 章」/「写入外传 N 章」/「提取为世界观设定」。
- **有外文时**（`drafts.some(needsTranslationToChinese)` 实时计算）：分章页不显示 picker，主按钮是「下一步：翻译（M 章）」。翻译页底部从「下一步：提取设定」改成「下一步：选择导入方式」（还有待译章节时文案是「跳过剩下的，选择导入方式」），进入独立的 `destination` 步骤，页面内容就是同一个 `DestinationPicker`。用户原话就是要在翻译之后再选，因为世界观设定也可能写成故事形式，翻译之前没法判断。
- **超长外文章的提示**：分章页列表里，`needsTranslationToChinese(content)` 为真且 `content.length > TRANSLATE_SOFT_LIMIT`（新常量 `export const TRANSLATE_SOFT_LIMIT = 6000`，放在 `src/features/writing/translate.ts`，和 `parseTranslation` / `translatedTail` 同处，编辑器那边以后要提示也能复用；数值与 `WORLDVIEW_CHUNK_SIZE` 同量级）的草稿，在这一章旁边显示 `role="note"`「这一章较长，单次翻译可能被截断，建议换一种分章方式或用自定义正则切小」。只提示，不禁用主按钮：模型的输出上限因服务商而异，6000 字只是保守估计，真被截断时 4.3 的截断检测会把这一章标成失败、不写回，用户再回来切分也不会丢钱以外的东西。为什么放在分章页：这是用户唯一能改切分的地方，世界观文档常常没有章节标题、整篇成一章，翻译之后再提示就晚了。
- 步骤条：`粘贴 › 分章 › [翻译] › [导入到] › 提取 › 确认`。「翻译」在 `hasForeign` 时出现；「导入到」在 `hasForeign || step === 'destination'` 时出现。后一个条件覆盖纯中文稿在分章页提交失败、刷新后恢复到目的地步骤的情况，保证当前步骤在步骤条上总有 `aria-current`。`hasForeign = drafts.some((d) => d.sourceContent !== '' || needsTranslationToChinese(d.content))`：有任务时取 `job.drafts`，没有任务时取分章页的本地草稿。用正文语种而不是 `translateStatus` 判断，是因为「跳过」会把状态改成 `none`，按状态算的话，跳过之后翻译步骤会从步骤条上消失。
- **主按钮的调用顺序**：
  - 纯中文稿，分章页主按钮：`createDraftJob()` 成功后，在同一个 handler 里紧接着调用 `commitImportChapters()`（主线或外传）或 `commitImportWorldview()`。第二步失败时，草稿任务已经落盘，界面切到 `destination` 步骤显示 alert，用户可以改选后重试，不用重新分章。
  - 外文稿，分章页主按钮：`createDraftJob()` 成功后 `setStep('translate')`。
  - 目的地步骤的主按钮：只调第二步（`commitImportChapters` 或 `commitImportWorldview`）。
- **目的地步骤的返回**：只在 `hasForeign` 时提供次按钮「返回翻译」，只做 `setStep('translate')`，不改数据，已译的章节保持已译，「跳过」改成 `none` 的章节可以重新勾选。纯中文稿恢复到目的地步骤时不提供返回：要改分章，只能放弃后重新粘贴，因为分章页的本地状态在刷新后已经没了，从草稿反推分章参数不可靠。
- 粘贴步骤去掉 `SegmentedControl`、世界观提示和外文提示。「这本书已有 N 章……」的编号提示挪进 picker，因为编号取决于目的地。

### 4.2 `DestinationPicker`（新文件 `src/features/import/DestinationPicker.tsx`）

受控组件，只负责展示和本地校验，不读写仓储。

- `RadioList`「导入到」有三项：
  - 主线章节：「接在主线之后编号，生成章节摘要与全书进展。」
  - 外传：「独立于主线的番外篇章，有自己的编号与摘要链，不计入主线进度。」
  - 仅作为世界观设定：「只提取人物与设定条目，不写成章节、不占编号、不出摘要与文风。」
- 选「外传」时，下面出现 `SelectField`「哪一部外传」，选项是已有外传，最后一项为「＋ 新建外传…」。没有外传时默认选「新建」。选「新建」时出现 `TextField`「外传名称」（必填）。
- 编号提示（`aria-live="polite"`）：
  - 主线：「主线已有 N 章，这一批从第 M 章接着编号，不会覆盖已有内容。」N 为 0 时不显示。
  - 已有外传：「外传·X 已有 k 章，从第 k+1 章接着编号。」
  - 新建外传：「从第 1 章开始编号。」
  - 世界观：「不会写成任何章节，只提取成知识库条目。」
- 主线和外传下面有勾选框「顺便归纳这部作品的文风」，从分章页挪过来（理由见 6.6）。默认值：主线勾上，外传不勾。用户手动改过之后，切换目的地不再覆盖他的选择。
- 校验和禁用：
  - 新建外传时名称为空：主按钮禁用。
  - 名称与已有外传重复（`sideStoryTitleKey` 相同，见 3.4）：字段报错「已有同名外传，直接从上面选它」，主按钮禁用。
  - 名称超过 40 字：字段报错。
  - 世界观模式且 `!llm.configured`：主按钮禁用，并提示「需要先在『设置』里配置模型才能提取」。
- picker 在移动端和桌面端结构一样，都在 `max-w-4xl` 内容列里，主按钮在已有的 `safe-bottom` 底栏里。
- **数据接线**：picker 不自己查库。`ImportScreen` 的加载 effect 在 `listChapters` 之外再调 `listSideStories`，用 `chaptersOfTrack` 按线算出 `lineCounts: { main: { count, next }, perSide: Map<sideStoryId, { count, next }> }`（`next` = 本线最大 index + 1，空线为 1），和 `sideStories` 一起作为 props 传进 picker。`sideStories` state **只给 picker 和计数用**，提取循环和收尾一律不读它（4.4「循环里的外传对象」）。重新加载 `listChapters` + `listSideStories` 的时机只有两个：面板挂载时，以及 `continueImport()` 回到粘贴步骤时。后者保证上一批新建的外传出现在下拉框里。picker 显示的「从第 M 章接着编号」只是预告，真正的编号由 `commitImportChapters` 在事务内重新计算，两者在并发写入时可能不同，以仓储为准。

### 4.3 数据流与各操作

| 操作                           | 实现                                                                                                                                                            | 写什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分章确认 `createDraftJob()`    | `repository.saveImportDrafts(novelId, { batchId: newBatchId(), drafts, expectedJobId: jobRef.current?.id ?? null })`（4.4），成功后用返回值写 `jobRef` 和 `job` | `batchId` 新值、`destination: null`、`drafts`（各章 `translateStatus = needsTranslationToChinese ? 'pending' : 'none'`），`chapters` / `worldviewChunks` / `entryDrafts` / `openThreads` 清空。库里没有任务、或任务的 `destination` 为 null **且 `id === expectedJobId`** 时可以重复调用（覆盖草稿），所以在分章页点主按钮失败后可以直接再点（纯中文稿第二步失败后重试，传的就是自己那一行的 id）。库里有一个 parse 成功、`id` 不等于 `expectedJobId` 的草稿任务时抛错「另一处已经有一批稿件在处理中」，不覆盖：那可能是另一个标签页正在翻译、已经付过钱的草稿，或者面板加载时 `getImportJob` 失败而留在粘贴步骤。库里已有 `destination !== null` 的任务时抛错「已有一批稿件在提取中，先完成或放弃它」，绝不覆盖：那个任务认领着已写入的章节和进行中的提取。正常界面到不了这里（有这种任务时面板会恢复到提取步骤），这是防跨标签页和卸载竞态的兜底；「先读再写」必须在同一个事务里才挡得住，所以放进仓储       |
| 翻译一章 `translateOne(draft)` | 改为读写 `job.drafts[i]`；`llm.runStream(..., { signal: translateAbortRef.current.signal })`                                                                    | 流式译完，先查 `result.finishReason`：为 `'length'` 时抛 `new LlmError('parse', '译文超出单次输出上限被截断了', '这一章太长，回到分章页把它切小一些再译')`，由翻译循环按现有逻辑经 `markTranslate` 标成 `failed`，**不写回草稿**（`content` 仍是原文，`sourceContent` 仍为空）。否则**先** `patchImportDrafts(novelId, [{ index, patch: { content: 译文, sourceContent: 原文, sourceLanguage, translateStatus: 'done', translateError: '' } }])` 写回该章，**再** `mergeGlossaryTerms`。顺序和现在相反，因为译文是付了钱的，必须先落盘；译名表合并失败时，`setNote` 提示「译名表没存上，下一章可能换个译法」，这一章不标成失败。为什么截断要当失败：半截译文照样能过 `parseTranslation`，标成 `done` 后，世界观目的地提交时会清空 `drafts`，原文就此消失，提取只看得到前一段，界面却显示成功；章节目的地也会写进一章没有任何提示的半截正文。`finishReason` 为 `null`（服务商不回传）时按未截断处理，和现在一样 |
| 勾选 / 重试                    | `toggleTranslate(index)` / `retryTranslate(index)`                                                                                                              | 按草稿 `index` 定位，经 `patchImportDrafts` 只改 `translateStatus` / `translateError`。`done` 的不允许改：界面上 disabled，仓储层也会忽略这类 patch（4.4）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 标记翻译状态                   | `markTranslate(index, status, error)`                                                                                                                           | 经 `patchImportDrafts` 写一条 `{ translateStatus, translateError }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 写入被拒                       | 上面任一处的 `patchImportDrafts` reject                                                                                                                         | 不显示 alert：翻译循环静默停下（`stopRef.current = true`，不进入 `markTranslate('failed')`），然后 `getImportJob` 重读一次，按 4.6 的加载规则（`safeParse` + `resumeStepOf`）重新定步骤；组件已卸载（`!aliveRef.current`）时什么都不做。会被拒，说明另一处（新实例、另一个标签页）已经提交了目的地或放弃了这批稿件，库里的状态才是对的                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 卸载                           | 挂载 effect 的清理函数                                                                                                                                          | 除了现有的 `stopRef.current = true`，再 `translateAbortRef.current?.abort()`，中止进行中的那一章，少付一章的钱。`translateAbortRef` 在每章开始时新建 `AbortController`。被中止的请求抛出的 abort 错误在循环里按「`!aliveRef.current` 就直接返回」吞掉，不 `markTranslate`，这一章在库里仍是 `pending`，下次打开会重新译。abort 只是锦上添花：即使请求已经返回、来不及中止，旧实例的写回也会经 `patchImportDrafts` 合并到最新行，`done` 的章不会被降级，已提交的任务会直接拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 续跑时的衔接                   | 开始翻译循环前                                                                                                                                                  | `previousTailRef` 为空时，取下一个待译草稿之前、最近一个 `done` 草稿的 `translatedTail(content)`。现在刷新后这个值会丢，续跑的第一章读不到上一章的译文结尾；草稿就在任务上，补上不花额外成本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 跳过剩下的                     | `goToDestination()`                                                                                                                                             | 把 `pending` **和 `failed`** 的草稿一并改成 `none`、清空 `translateError`，用**一次** `patchImportDrafts` 调用传多条 patch 落盘（同一个事务，要么全改要么全不改；被拒时按上面「写入被拒」处理），这样刷新后会落在目的地步骤，不会被 4.6 的规则弹回翻译步骤。失败章按原文写入或提取，效果等同于用户取消勾选；`content` 仍是原文，`sourceContent` 仍为空，所以写成章节后可以到编辑器里逐章「译成中文」。按钮沿用现有规矩：翻译循环运行时（`running`）不渲染，只能先「暂停」等当前章落盘，避免进行中的一章在目的地提交之后才写回 `drafts`，破坏 3.2 的阶段表                                                                                                                                                                                                                                                                                                                                                      |
| 目的地 = 主线 / 外传           | `repository.commitImportChapters()`（4.4）                                                                                                                      | 一个事务里写章节、推进任务                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 目的地 = 世界观                | `repository.commitImportWorldview(novelId, { chunks: packWorldviewChunks(job.drafts) })`（4.4）                                                                 | 只改任务这一行：`destination: { kind: 'worldview' }`、`worldviewChunks`、`drafts: []`、`withSummaries: false`、`withStyle: false`、`rollingSummary: ''`、`openThreads: []`。事务只开 `importJobs` 一张表，「世界观不写 Chapter」在事务层面也成立。被拒后的处理与 `commitImportChapters` 相同（第 9 节）：重读任务，`destination !== null` 就进入提取步骤，不显示错误                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

写入或转换成功后进入 `extract`，并 `startLoop()`。提取循环、`finalize`、`buildEntryProposal` 的分支依据从 `importType` 改为 `destination.kind`，章节分支的逻辑不变（6.4 那几处外传差异除外）。

### 4.4 导入任务的三个阶段写入与草稿逐章修改（仓储新增）

```ts
/**
 * 进入草稿阶段。库里已有 destination !== null 的任务，或已有一个 id !== expectedJobId 的
 * 草稿任务时抛错；否则整行覆盖成新的草稿任务。expectedJobId 是乐观并发检查：调用方声明
 * 「我以为库里是哪一行」，对不上就说明别处有一批付过钱的草稿，不能悄悄冲掉
 */
saveImportDrafts(
  novelId: string,
  input: { batchId: string; drafts: ImportDraft[]; expectedJobId: string | null },
): Promise<ImportJob>;

/** 草稿阶段的逐章修改（翻译、勾选、重试、跳过）。只开 importJobs 的 rw 事务，合并到库里最新那一行 */
patchImportDrafts(
  novelId: string,
  patches: { index: number; patch: Partial<Pick<ImportDraft,
    'content' | 'sourceContent' | 'sourceLanguage' | 'translateStatus' | 'translateError'>> }[],
): Promise<ImportJob>;

/** 进入 main / side 阶段。side / newSide 时返回的 sideStory 必为非 null，main 时为 null */
commitImportChapters(novelId: string, input: {
  target: { kind: 'main' } | { kind: 'side'; sideStoryId: string } | { kind: 'newSide'; title: string };
  withStyle: boolean;
}): Promise<{ job: ImportJob; sideStory: SideStory | null }>;

/** 进入 worldview 阶段。检查与 commitImportChapters 第 1 步相同；事务只开 importJobs */
commitImportWorldview(novelId: string, input: { chunks: ImportWorldviewChunk[] }): Promise<ImportJob>;
```

四者都在 `rw` 事务里「读任务 → 检查 → 写」，写入前都过一遍 `ImportJobSchema.parse`（和 `upsertImportJob` 一样）。`saveImportDrafts`、`patchImportDrafts` 和 `commitImportWorldview` 只锁 `importJobs`；`commitImportChapters` 的事务范围见下。「目的地提交至多一次」因此对三条路径都由仓储保证，跨标签页也成立：标签页 A 已提交主线后，标签页 B 再点「提取为世界观设定」会被拒，A 写入的章节不会失去任务。`commitImportWorldview` 额外拒绝 `chunks` 为空（「没有可提取的内容」），否则会写出一个不合阶段表的行。

`saveImportDrafts` 的检查顺序：读到的行 `ImportJobSchema.safeParse` 失败 → 视同没有任务、直接覆盖（4.6，残留坏行不能挡住下一次导入）；parse 成功且 `destination !== null` → 抛「已有一批稿件在提取中，先完成或放弃它」；parse 成功、`destination === null` 且 `id !== expectedJobId` → 抛「另一处已经有一批稿件在处理中」；其余（没有行，或 `id === expectedJobId`）→ 覆盖。新写入的行用新 `id`（`newId()`），所以「同一个分章页重试」和「另一处的草稿」分得开。界面处理见第 9 节。

`patchImportDrafts` 的规则：

1. 读任务。任务不存在、`ImportJobSchema.safeParse` 失败，或 `destination !== null` 时，抛「这批稿件已经不在翻译阶段了」，什么都不写，**不新建行**。这是和 `upsertImportJob` 最要紧的区别：放弃或提交之后，迟到的旧写入不能凭空造出一个只有 `drafts` 的任务，也不能给已提交的任务塞回草稿。
2. 每条 patch 按 `index` 定位到**库里当前的** `drafts` 里 `index` 相同的那一项（不是数组下标，也不是调用方手里的副本），把 patch 合并进去；找不到这个 index 时抛「找不到第 N 章草稿」，整个事务回滚。
3. 库里那一章已经是 `translateStatus: 'done'` 时，忽略 patch 里把它改成 `pending` / `none` / `failed` 的 `translateStatus`、对 `translateError` 的改写，以及对 `content` 的改写（`sourceContent` / `sourceLanguage` 同样忽略）。也就是说 `done` 的草稿对这个方法是只读的，「已译的不允许改」在存储层成立，不再只靠界面上的 disabled；旧实例迟到的「标记失败」或新实例误点的「重试」都伤不到付过钱的译文。被忽略不算错误，不抛。
4. 合并后整行过 `ImportJobSchema.parse` 再写，返回值由调用方写进 `jobRef` / `job`（`aliveRef.current` 为 false 时只写 ref）。
5. 不改 `destination`、`batchId`，也不改任何数组的长度。

为什么按章合并而不是整行比较版本号：草稿阶段的写入天然是逐章的，两个实例各译各的章，合并后两边的结果都该留下；用版本号拒绝会让其中一方白付一章的钱。真正需要拒绝的只有「已不在草稿阶段」这一种，第 1 步已经挡住。

`commitImportChapters` 的过程：

整个过程在一个 `rw` 事务里完成，涉及 `importJobs, chapters, sideStories, chapterSummaries, novels`：

1. 读取任务。任务不存在时抛错「没有进行中的导入任务」；`destination !== null` 时抛错「这批稿件已经写入过了」；`drafts` 为空时抛错「没有可写入的章节」。
2. 解析目标：
   - `side`：外传不存在或不属于本书时抛错「所选外传已不存在，可能已被删除」。
   - `newSide`：标题先 `normalizeSideStoryTitle`，再按 `sideStoryTitleKey` 和本书已有外传查重，重名时抛错「已有同名外传『X』」。通过后 `SideStorySchema.parse` 并 add，`order` 取当前最大值 +1。
   - `side` 和 `newSide` 都把读到或新建的 `SideStory` 放进返回值，调用方不必再查一次。
3. 编号起点取本线（`sideStoryId` 相同）的最大 index，空线为 0。每章写入：`index = 起点 + draft.index`，`content` / `sourceContent` / `sourceLanguage` 照抄草稿，`wordCount = countWords(content)`，`status: 'done'`，`source: 'imported'`，`sideStoryId`，`outlineNodeId: null`。
4. 链的起始状态：
   - `rollingSummary`：主线取 `novel.rollingSummary`，外传取 `sideStory.rollingSummary`。
   - `openThreads`：取本线 index 最大的、有摘要的那一章的 `openThreads`。现在主线第二批导入的伏笔是从 `[]` 开始的，这其实是个缺口，既然这里要重写，就顺手接上。第一批导入不受影响。
5. 任务写成 `destination`（`newSide` 时为新建外传的 `{ kind: 'side', sideStoryId }`）、`drafts: []`、`withSummaries: true`、`withStyle`、`status: 'paused'`、第 4 步算出的 `rollingSummary` / `openThreads`，以及按草稿顺序一一对应的 `chapters`：
   ```ts
   { index: chapter.index,            // 线内章号，不是草稿的批内序号
     title: draft.title, chapterId: chapter.id,
     status: 'pending', error: '',
     translateStatus: draft.translateStatus === 'done' ? 'done' : 'none',
     translateError: '' }
   ```
   `chapters` 里不会出现 `pending` / `failed` 翻译状态，4.6 正是靠这一点识别旧版任务。

同时改掉 `extractOne` 里的 `rollingSummary: current?.rollingSummary ?? novel.rollingSummary`，改成 `current?.rollingSummary ?? ''`。链的起点已经在第 4 步按线写进任务，留着这个回退的话，外传任务在极端情况下（`current` 为空，只会出现在卸载竞态里）会回落到主线进展，空串更安全。同处的 `setNote('正在提取第 N 章…')` 和失败提示改用 `chapterLabel`，外传显示「正在提取外传·X 第 N 章…」。

**循环里的外传对象从哪来**。`ImportScreen` 现有的规矩是循环只读 ref，不读 state（「靠 state 驱动循环会用到过期的章节列表」）。`newSide` 的流程是 commit 之后在同一个 handler 里立刻 `startLoop()`，这时闭包里的 `sideStories` state 还是 commit 之前的列表，没有新建的那部。所以：

- 新增 `const sideStoryRef = useRef<SideStory | null>(null)`，和一个只用于渲染的 `activeSideStory` state，两者只经 `rememberSideStory(story | null)` 一起写入。写入时机：
  - `commitImportChapters` 成功后，用返回值的 `sideStory`（main 时为 null）。
  - 面板恢复到 `side` 任务时，加载 effect 里 `await repository.getSideStory(destination.sideStoryId)`；读不到时写 null，任务照常恢复，第一章提取时会按下面的规则失败。
  - `extractOne` / `finalize` 每次重读后。
  - 放弃、`continueImport()` 时清成 null。
- **`extractOne` 每章开头重读**：`getChapter` 之后、和 `listEntries` 一起，若 `jobRef.current.destination.kind === 'side'`，`const story = await repository.getSideStory(destination.sideStoryId)`。读到 `undefined` 时 `throw new Error('这部外传已不存在，可能已被删除')`，不发请求，由 `runLoop` 现有的 catch 统一 `markChapter(next.chapterId, 'failed', message)`、`setError` 并停下。不在这里自己 `markChapter` 再 `return`：`runLoop` 只在 `extractOne` 抛错时才停，正常返回会让循环接着处理下一章，每一章都被静默标成失败，界面上只看到一排「重试」，看不到原因（第 3 轮评审发现 3）。读到时用 `story.title` / `story.synopsis` 拼 `buildExtractUserPrompt` 的 `sideStory` 参数、`setNote`、摘要提案标签和 `sourceRef`。每章都读，是因为用户可能在提取途中到写作页改了外传名或简介（一次 IndexedDB 读，相比一次模型调用可以忽略）。
- **`finalize` 同样先重读**（5.7）：读到时，标题用于外传进展提案的 `sourceRef` 和 `FinishedDestination.title`，`rollingSummary` 用于提案的 `current`；读不到时跳过外传进展提案，`FinishedDestination` 为 `{ kind: 'side', sideStoryId, title: '', count }`（`count` 见 4.8）。
- 循环、`finalize`、`buildEntryProposal` 内部一律不读 `sideStories` state，也不读 `activeSideStory`。渲染（提取步骤的标题、章节列表的「外传·X 第 N 章」标签）用 `activeSideStory`；事件 handler（放弃确认框文案）用 `sideStoryRef`。两者拿到的最多是上一章刚重读过的值，只影响展示，不进 prompt 和提案。

**为什么必须由仓储来做、而且必须是一个事务**：现在的 `createChaptersAndJob` 先逐章 `createChapter`，再写任务。中途刷新的话，会留下几章没有任务认领的孤儿章节，下次重开也找不回来。外传还多出「新建外传」这一步。原子性只有存储层给得了，章号在每条线内连续这个不变量也只有它看得到全量数据。

### 4.5 世界观提取策略：按章打包，超长再切

新纯函数放在 `worldview.ts`，原来的 `splitWorldviewText` 保留并复用：

```ts
export function packWorldviewChunks(
  drafts: Pick<ImportDraft, 'title' | 'content'>[],
  max = WORLDVIEW_CHUNK_SIZE,
): ImportWorldviewChunk[];
// 每段：index 从 1 起连续；title（规则见下）；content（发给模型的正文）；status: 'pending'；error: ''
```

规则：

- 按草稿顺序贪心打包：当前段加上下一章不超过 `max` 时就并进来。段内每章前面加一行标题（标题非空时），章与章之间空一行。
- 单章超过 `max` 时，先结束当前段，再对这一章调用 `splitWorldviewText`，拆出的每段 `title` 记为「{章标题}（i/k）」。
- 普通段的 `title` 是「首章标题」，跨了多章时写成「首章标题 — 末章标题」。空草稿（`content.trim()` 为空）跳过。
- **长度按拼接后的最终文本计算**，包括段内补上的标题行和章间空行：`candidate = current + '\n\n' + titleLine + content`，`candidate.length ≤ max` 才并入。这样「总长 ≤ 6000」对发给模型的正文成立，测试也只需要断言 `chunk.content.length ≤ max`。单章判超长时同样计入它自己的标题行（`titleLine.length + content.length > max` 即超长）。
- **超长章切出的各段，正文里不带标题行**：直接对 `draft.content` 调 `splitWorldviewText(content, max)`，每段的 `content` 就是切出来的原文片段；章标题只放在 `chunk.title`（「{章标题}（i/k）」）里，经 `sourceLabel` 进 prompt。为什么不在每段前补「{章标题}」：标题已经在 `【设定文本（世界观设定 · …）】` 标签里，再补一次是重复；而且补了之后每段要给标题行留出长度，`splitWorldviewText` 的上限就得按标题长度逐章调整，规则变复杂却没有收益。
- **章标题为空时不造标题**：普通段里该章不加标题行；超长章切出的各段 `title` 为 `''`，不写成「（1/3）」。跨章段的首、末标题有一个为空时，只用非空的那个；都为空时 `title` 为 `''`。
- prompt 的 `sourceLabel`（`extractWorldviewChunk` 里，`total = worldviewChunks.length`）：
  ```ts
  const sourceLabel = chunk.title
    ? `世界观设定 · ${chunk.title}`
    : total > 1
      ? `世界观设定 第 ${chunk.index}/${total} 段`
      : '世界观设定';
  ```
  `title` 为空时的两个分支就是现有代码（`ImportScreen.tsx` 的 `extractWorldviewChunk`）的原样。「整篇作为一章」产出的章标题是 `''`，旧版迁移来的 chunk 的 `title` 也是 `''`，这两种情况的标签与现在逐字一致，现有断言 `/【设定文本（世界观设定 第 1\/\d+ 段）】/` 不用改。sourceRef 仍然是「世界观设定导入」，`accumulateEntryDrafts(..., null)` 不变。

为什么这样定：

- **按章打包，而不是把每章单独当一段**：设定集常常被切成几十个几百字的小节（「第一章 地理」「第二章 宗门」）。逐章提取等于发几十次高推理强度的调用，每次都要重新读一遍分类和已有条目。打包到 6000 字，调用次数降一个量级，和单章提取的篇幅在同一量级。
- **按章作边界，而不是回到整篇按段落切**：分章结果是作者自己的段落结构，用户在分章页刚核对过。故事形式的世界观素材，章就是叙事单元，从中间切开会让模型读到半截场景。打包时章与章之间不会被切开。
- **超长单章仍然要切**：提取是 high reasoning 任务，几万字一次塞进去容易超时、输出被截断，失败了还要整份重新付费。
- 原来的「整篇粘贴」场景（分章页选「整篇作为一章」）会退化成一章超长、按段落切，和现在的行为一致。
- 段的内容在写进任务时就固定下来，之后再调 `WORLDVIEW_CHUNK_SIZE` 不影响正在进行的任务。

### 4.6 恢复与旧任务兼容

**面板加载先 parse，再判断去向**：

```ts
const raw = await repository.getImportJob(novel.id); // 原始行，不经 parse
if (raw) {
  const parsed = ImportJobSchema.safeParse(raw); // preprocess 会再跑一遍 upgradeLegacyImportJob
  const result: ResumeResult = parsed.success ? resumeStepOf(parsed.data) : { discard: 'notice' };
  if ('discard' in result) {
    await repository.deleteImportJob(novel.id); /* 粘贴步骤；notice 时显示说明 */
  } else {
    jobRef.current = parsed.data;
    setJob(parsed.data);
    setStep(result.step); /* side 时 rememberSideStory，见 4.4 */
  }
}
```

parse 让 Zod 默认值补齐所有字段，迁移时 `try/catch` 原样留下的行也会在这里经 preprocess 换算一次。之后 `jobRef` / `job` 里只会出现 parse 过的对象（`persistJob`、`patchImportDrafts` 和三个阶段写入的返回值本来就是 parse 过的），渲染阶段读 `job.drafts` 不会遇到 `undefined`。`deleteImportJob` 本身失败时（极少见），照常进入粘贴步骤并显示说明。为了让这种残留的坏行不挡住下一次导入，`saveImportDrafts` 在事务里读到的行若 `ImportJobSchema.safeParse` 失败，视同没有任务、直接覆盖，不抛「已有一批稿件在提取中」，也不做 `expectedJobId` 检查；只有 parse 成功且 `destination !== null`，或 parse 成功且 `id !== expectedJobId` 才拒绝（4.4）。

`resumeStepOf` 是放在 `src/features/import/importFlow.ts` 的纯函数：

```ts
type ResumeResult = { step: Step } | { discard: 'silent' | 'notice' };
export function resumeStepOf(job: ImportJob): ResumeResult;
```

它只接 parse 过的 `ImportJob`，但仍按全函数写（数组按 `?? []` 读、不抛错），因为测试会喂它残缺对象。按从上到下的顺序匹配，第一条命中即返回：

| 任务状态                                                                                     | 返回                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------- |
| `destination === null` 且 `drafts`、`chapters`、`worldviewChunks` 都为空（来自旧版的空任务） | `{ discard: 'silent' }`               |
| 不符合 3.2 阶段表，判定见下面的 `bad`                                                        | `{ discard: 'notice' }`               |
| `destination === null`，有草稿处于 `pending` 或 `failed` 翻译状态                            | `{ step: 'translate' }`（不自动开始） |
| `destination === null`，其余                                                                 | `{ step: 'destination' }`             |
| `worldview`                                                                                  | `{ step: 'extract' }`（按 chunks）    |
| `main` / `side`                                                                              | `{ step: 'extract' }`（按 chapters）  |

```ts
const d = job.destination;
const bad =
  (d === null && (drafts.length === 0 || chapters.length > 0 || chunks.length > 0)) ||
  ((d?.kind === 'main' || d?.kind === 'side') &&
    (chapters.length === 0 || chunks.length > 0 || drafts.length > 0)) ||
  (d?.kind === 'worldview' && (chunks.length === 0 || chapters.length > 0 || drafts.length > 0));
```

即表里要求非空的为空、或要求为空的有任何一个非空，都算不合表格。`destination` 不是 null 也不是三种之一的行到不了这里：parse 会先失败，按 `notice` 处理。

`notice` 的处理：删掉任务行，进入粘贴步骤，显示 `role="note"`「上一次导入的进度无法恢复，已清掉；已写入的章节正文都在写作页里」。`silent` 只删行、不提示，因为它本来就什么都没做。不合表格的组合只会来自迁移失败的行，或者绕过仓储的写入（草稿阶段的写入已经全部经 `patchImportDrafts`，卸载竞态不再能造出这种行）。删掉任务不会删章节，但要说清代价：任务被清掉后，**已写入的章节保留**，这一批还没提取完的条目提案与章节摘要就没有了。应用里没有「对已有章节重新提取」的入口，要补回来只能重新导入同一批稿件（会再写一遍章节，需要用户事后删掉重复的），或者到知识库和章节摘要面板里手动整理。这是一种低概率的兜底，不值得为它新做一个「对已有章节重新提取」的入口。

两种旧版任务：

- **旧版世界观任务**：迁移成 `worldview`，chunk 的 `title` 为空，标签退回「第 i/N 段」，可以直接接着跑。
- **旧版章节任务**：迁移成 `main`。旧流程是直接在 Chapter 上翻译的，新流程只翻译草稿，所以旧任务的翻译进度没法续跑。检测条件是 `destination` 为 main 或 side，且 `chapters` 里还有 `pending` / `failed` 翻译状态（新提交的任务不会出现这种状态）。这时面板落在提取步骤，**不自动开始**，并显示 `role="note"`：「这次导入是旧版本留下的，翻译进度无法接着跑。已写入的 N 章都在，未译的 M 章会按原文提取；想先翻译的话，可以到写作页逐章『译成中文』后再开始提取，或放弃这次导入（章节会保留）。」用户点「开始提取」照常进行。

### 4.7 放弃导入

右上角的垃圾桶在 `translate` / `destination` / `extract` 三个步骤都显示。选定目的地之前，确认框的文案是：「分章结果和已经译好的 K 章译文会被清空，需要重新粘贴；译名表保存在作品上，不受影响。还没有写入任何章节。」K 为 0 时省掉译文那半句。之后的文案保持现状，章节模式写明「已写入的章节正文会保留」，外传同样适用。

### 4.8 连着导下一批

`continueImport()` 按 `finishedDestination` 给提示。它替代原来的 `finishedImportType`，类型是判别联合：

```ts
type FinishedDestination =
  | { kind: 'main'; count: number } // count = 本批写入的章数
  | { kind: 'side'; sideStoryId: string; title: string; count: number } // title 只用于提示文案
  | { kind: 'worldview' };
```

`count` 在 `finalize` 里取 `current.chapters.length`（`current` 是 `finalize` 开头重读的任务），`continueImport` 的 `setLastRound(...)` 改用 `finishedDestination.count`，不再用 `drafts.length`。为什么：`drafts` 是分章页的本地 state，刷新续跑后恢复的任务里它是 `[]`，按现有写法提示会变成「上一批 0 章」。世界观一支不带 `count`，它的提示文案本来就不报章数。

在 `finalize` 时从 `job.destination` 取 id，标题取 `finalize` 开头重读的 `getSideStory` 结果（4.4「循环里的外传对象」），不从 `sideStories` state 取；外传已被删时 `title` 为 `''`。提示文案：

- 主线：保持现在的文案。
- 外传：「上一批 N 章外传·X 已经处理完。接着导下一批吧 —— 译名表和已有设定都会沿用。」`title` 为 `''` 时写成「上一批 N 章外传已经处理完。……」。
- 世界观：保持现在的文案。

下一批的 picker 预选上一批的目的地：主线还是主线；外传按 `sideStoryId` 预选**同一部**（上一批是「新建」的，此时已有 id，预选这部已有外传，避免用户再填一遍名字撞上重名报错）；这个 id 已不在重新加载的 `listSideStories` 里（中途被删）时，回退到「新建」，名称留空；世界观还是世界观。文风勾选框沿用现在「保留上一轮选择」的规矩。理由和保留 `mode` / `customPattern` 一样：分批导入的稿子绝大多数是同一类素材接着导。

### 4.9 翻译截断检测（`src/llm/types.ts` / `OpenAiCompatibleClient.ts`）

选的是第 3 轮评审的方案 A（截断检测 + 分章页提示），不做方案 B（超长草稿切段逐段翻译、`ImportDraft.translatedParts` 按段落盘）。理由：A 只在 LLM 层加一个字段、在 `translateOne` 加一个判断，主线章节和编辑器里的「译成中文」也一并受益；B 要改草稿模型、续跑逻辑和一整组测试，而它解决的问题，用户在分章页用「自定义正则」或换分章方式就能绕开，提示又已经放在分章页上（4.1）。

- `ChatResult` 增加 `finishReason: string | null`（必填字段，不是可选，这样 `OpenAiCompatibleClient` 两个返回点漏写时 `tsc` 会报错；`LlmClient` 只有这一个实现，测试都是 mock `fetch`，不需要改 mock 对象）。注释写明：「服务商回传的结束原因，`'length'` 表示撞上了输出上限；不回传时为 null」。
- 流式（`streamChat`）：循环里每一帧读 `chunk.choices?.[0]?.finish_reason`，**非空时**覆盖 `finishReason`，即取流中最后一个非空值。只看「最后一帧」不够：很多服务商在最后另发一帧只带 `usage`、`choices` 为空的 chunk，那一帧里没有 `finish_reason`，不能把前面读到的 `'length'` 冲成 null。`sse.ts` 的 chunk 类型里已经有 `finish_reason?: string | null`，不用改解析。
- 非流式（`chat`）：取 `body.choices` 的最后一项的 `finish_reason ?? null`。请求不设 `n`，所以实际上就是 `choices[0]`，写成「最后一项」是和流式的语义保持一致。
- `useLlm.runStream` / `generateStructured` 原样透传 `ChatResult`，不需要改。结构化输出暂时不检查 `finishReason`：截断的 JSON 本来就过不了 Zod，会走现有的修复重试，不会被当成成功。
- 只有导入的 `translateOne` 在本次检查 `finishReason === 'length'`（4.3）。编辑器里的整章翻译同样有截断风险，但那里译文要用户点「采用」才替换正文，采用后原文存进 `sourceContent`、还能一键撤销，不会静默丢内容，本次不改（backlog，见第 15 节）。

---

## 5. 外传在各子系统的行为

### 5.1 仓储（`NovelRepository` / `DexieNovelRepository`）

接口新增（`NovelRepository.ts`）：

```ts
// ------------------------------------------------ 外传
listSideStories(novelId: string): Promise<SideStory[]>;
getSideStory(id: string): Promise<SideStory | undefined>;
createSideStory(novelId: string, input: { title: string; synopsis?: string }): Promise<SideStory>;
/** id / novelId / order / createdAt 不可通过 patch 修改；updatedAt 由仓储写 */
updateSideStory(
  id: string,
  patch: Partial<Pick<SideStory, 'title' | 'synopsis' | 'rollingSummary'>>,
): Promise<SideStory>;
deleteSideStory(id: string): Promise<void>;

// ------------------------------------------------ 旧稿导入任务（4.4）
saveImportDrafts(...): Promise<ImportJob>;   // input 带 expectedJobId
patchImportDrafts(...): Promise<ImportJob>;  // 草稿阶段逐章合并，不在草稿阶段即拒绝、不新建行
commitImportChapters(...): Promise<{ job: ImportJob; sideStory: SideStory | null }>; // side / newSide 时必为非 null
commitImportWorldview(...): Promise<ImportJob>;
```

- `listSideStories`：按 `order`、`createdAt` 排序。
- `getSideStory`：摘要面板、导入循环与收尾、`apply.ts` 都要读**最新**的标题、简介和 `rollingSummary`，不能用组件里拿到的旧对象（用户可能刚在另一个面板采用过一条外传进展提案）。
- `createSideStory`：`title` 经 `normalizeSideStoryTitle` 后存，按 `sideStoryTitleKey` 查重，`order` 取最大值 +1，过 `SideStorySchema.parse`。重名抛「已有同名外传『X』」，不合法（空、超 40 字、简介超 2000 字）抛 schema 的中文 message。
- `updateSideStory`：外传不存在时抛「这部外传已不存在，可能已被删除」。patch 里的受保护键（`id` / `novelId` / `order` / `createdAt`）在仓储层剥掉，理由和 `updateChapter` 剥 `sideStoryId` 一样。改标题时同样归一化，按 `sideStoryTitleKey` 查重并**排除自身**（只改大小写或去掉「外传·」前缀不算重名）。合并后整对象过 `SideStorySchema.parse`。
- `deleteSideStory`：一个事务里删除 `chapters.where('sideStoryId').equals(id)`、这些章节的摘要和外传本身。外传不存在时静默返回（删除是幂等的）。
- `createChapter`：
  - 没传 index 时，按**同一条线**取最大值 +1。
  - 传了 `sideStoryId` 时校验外传存在且属于本书，否则抛错「外传不存在」。
  - 外传章节的 `outlineNodeId` 必须为 null，否则抛错「外传章节不能关联大纲节点」。
- `updateChapter`：
  - patch 里的 `sideStoryId` 在仓储层**静默剥掉**（不抛错）。签名是 `Partial<Chapter>`，调用方顺手传 `{ ...chapter, content }` 这种整对象时，带的就是原值，抛错会让一次正常保存失败；剥掉同样能保证跨线移动不会让编号和摘要链悄悄错乱。跨线移动在范围外。
  - 外传章节的 patch 带非 null 的 `outlineNodeId` 时**抛错**「外传章节不能关联大纲节点」。正常界面到不了这里，能到的只有 `chapter:replace` 提案；抛错走 `acceptProposals` 的逐条失败语义，提案留在待确认里，比悄悄丢掉关联更容易被发现。
- `deleteOutlineNode` 的「解除关联」逻辑不用改：外传章节的 `outlineNodeId` 恒为 null，不会被选中。
- `apply.ts` 的 `chapter:create` 不接受 `sideStoryId`（`ChapterPayload` 不加这个键），提案建出的章节一律是主线。
- `computeStats`：
  - `chapterCount` 和 `doneChapterCount` 只算主线。
  - `sideChapterCount` 是外传章数。
  - `wordCount` 包含全部章节。
- `deleteNovel` / `exportSnapshot` / `importSnapshot` 加上 `sideStories` 表。
- `listChapters` 的语义不变（返回全部章节，按 index 排序）。按线过滤一律用 3.4 的辅助函数。不改成「默认只返回主线」，是因为译名检查、备份、导入的文风取样都需要全量，改默认值等于让这三处悄悄漏掉外传。

### 5.2 上下文构建（`ContextBuilder.ts` / `SummaryChainContextBuilder.ts`）

`ContextRequest` 新增 `sideStories?: SideStory[]` 和 `includeMainProgress?: boolean`（默认 false）。`ContextItemKind` 加 `'sideStory'`。

构建器的第一步先定线：`track = 目标章节?.sideStoryId ?? null`（没有目标章节或找不到目标时都按主线处理），然后 `chapters = chaptersOfTrack(request.chapters, track)`。之后的 `findPreviousChapter`、`pickRecentSummaries`、`computeDefaultEntryIds` 都只拿到这一条线的章节，算法本身不用改。

「是不是外传」只看 `track`（来自章节数据），不看调用方有没有传 `sideStories`。`track !== null` 但 `request.sideStories` 里找不到这部外传（接线漏传，或外传刚被删）时：仍按 `track` 过滤章节；**不拿** `Novel.rollingSummary` 顶替缺失的外传进展（只有 `includeMainProgress` 为 true 时，照常作为「主线进展（仅供参考）」注入，那是用户明确选的）；省略外传说明块和外传进展摘要；默认预选的推断只用上一章摘要。退化成「只有同一外传前文」的上下文，而不是退回主线上下文，这样接线错误最多让外传少些信息，不会把主线进展灌进外传。

| 段                    | 主线章节                    | 外传章节                                                                                                                                                        |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 稳定前缀              | 不变                        | **完全相同**（作品信息 + 风格 + 核心设定 + 勾选条目）                                                                                                           |
| 外传说明块（必收）    | —                           | `【本章属于外传《X》】` + `简介：…`（简介为空时整行省略）+ 「外传独立于主线：不要写成主线的后续，也不要改动主线里已经发生的事；人物与设定以上面的知识库为准。」 |
| 大纲位置              | 有节点时注入                | 无（外传章节不关联大纲）                                                                                                                                        |
| 进展摘要              | `Novel.rollingSummary`      | `SideStory.rollingSummary`，写成 `【外传至此】`；为空时不注入                                                                                                   |
| 主线进展              | —                           | 仅当 `includeMainProgress` 为 true 且 `Novel.rollingSummary` 非空时注入：`【主线进展（仅供参考，外传不必衔接它）】`，参与预算裁剪                               |
| 最近摘要 / 上一章结尾 | 只取主线                    | 只取同一部外传，结尾标题写成「上一章（外传第 N 章）」                                                                                                           |
| 默认预选的推断来源    | 节点标题与梗概 + 上一章摘要 | 外传简介 + 上一章摘要                                                                                                                                           |

外传章节新增和改动的注入项（`ContextItem` 的 `kind` / `id` / `label`），主线各项一律不变：

| 注入项           | `kind`        | `id`                 | `label`                |
| ---------------- | ------------- | -------------------- | ---------------------- |
| 外传说明块       | `'sideStory'` | `sideStory.id`       | `外传·X 说明`          |
| 外传进展摘要     | `'rolling'`   | `'rolling-side'`     | `外传进展摘要`         |
| 主线进展（参考） | `'rolling'`   | `'rolling-main'`     | `主线全书进展（参考）` |
| 外传的最近摘要   | `'summary'`   | `summary.id`（不变） | `外传第 N 章摘要`      |
| 外传的上一章结尾 | `'tail'`      | `chapter.id`（不变） | `外传第 N 章结尾原文`  |

外传的两条进展用不同的 `id`，因为 `GenerateChapterSheet` 的清单以 `${kind}-${id}` 作 key，两条同时出现时沿用 `'rolling'` 会重复。主线章节的进展仍然是 `id: 'rolling'`，既有断言不用改。标签里写「外传第 N 章」而不带外传名，是因为同一次生成只会出现一部外传，名字已经在说明块里。

外传说明块的拼装放在 `src/domain/sideStory.ts` 的 `renderSideStoryBrief(story)`，5.7 的提取说明复用同一条「简介为空就省略」的规则：简介为空时不输出简介行，也不输出「（简介……）」或空括号。当场新建的外传一定没有简介，这种情况会很常见。

**外传说明块放在易变后缀，而不是稳定前缀**：它对每部外传不同，放进前缀会把主线和外传共用的缓存前缀截断在作品信息之后，核心设定和人物就都命中不了缓存了。

`GenerateChapterSheet` 只在外传章节、且 `Novel.rollingSummary` 非空时显示 `Toggle`「参考主线进展」，默认关闭，说明文案是：「外传发生在主线之后、需要知道主线走到哪时再打开。前传打开它，人物容易提前知道后来的事。」它和「带上前几章摘要」一样，是每次打开面板时的本地状态。`ReviseSheet` 不显示这个开关，按默认的 false 处理。

### 5.3 摘要链（`chapterSummary.ts` / `ChapterSummarySheet.tsx`）

- `previousSummaryOf(chapters, summaries, chapterId)` 先过一遍 `chaptersOfTrack`，伏笔因此只在同一条线内承接，主线的伏笔不会混进外传。
- `buildSummaryUserPrompt` 新增可选参数 `sideStory?: { title; synopsis }`：
  - 进展块的标题改为「【此前的外传进展摘要（外传《X》）】」。
  - 正文前面插一段说明：「本章属于外传《X》，独立于主线。rollingSummary 只写这部外传从第一章到本章的进展，不要混入主线剧情。」
  - 系统提示不变，保证缓存命中。不传这个参数时，输出和现在逐字节一致。
- 系统提示里那句「rollingSummary：更新后的全书进展摘要……覆盖从开篇到本章的主线进展」对外传也原样保留，由用户提示里的外传说明收窄范围。不改系统提示是为了和主线共用缓存；用户提示离输出更近、说得更具体，模型会按它来。万一写串了，产出也只是一条提案，`current` 对比里看得见。
- `ChapterSummarySheet` 新增 `sideStory?: SideStory` 属性，**只用于展示**（面板标题里的「外传·X」）。「这是不是外传章节、是哪一部」只看 `data.chapter.sideStoryId`，不看这个属性有没有传；也不从它读 `rollingSummary`。这样 WritingPage 或编辑器的接线漏传时，外传章节也不会产出 `target: 'novel'` 的进展提案去改写主线进展。
- **最新进展在生成函数内部读，不在挂载 effect 里读。** 面板由「标记完成」打开时，现有的 `useEffect` 会同步调用 `generateRef.current()`。如果在挂载 effect 里异步 fetch，生成多半在 fetch 返回之前就开始了，拿到的是空的或旧的进展，产出的外传进展摘要承接不上此前的内容，采用后会把正确的版本覆盖掉。具体做法：
  - 在 `generateRef` 的函数体里，`chapter.content` 判空之后、调用 `runStructured` 之前，执行 `const sideId = data.chapter.sideStoryId ?? null; const story = sideId ? await repository.getSideStory(sideId) : null`。
  - `sideId` 非 null 但读到 `undefined`（外传已被删除）时，`setPhase({ kind: 'error', message: '这部外传已不存在，可能已被删除' })` 并返回，不发请求。
  - `previousRollingSummary` 和第二条提案的 `current` 都用这次读到的 `story.rollingSummary`。
  - 主线章节的路径不变，仍然读 `data.novel.rollingSummary`，不在本次范围内改动。
- 外传章节的第二条提案改为 `target: 'sideStory'`、`targetId: story.id`，标签「外传进展摘要」，`current: { rollingSummary: story.rollingSummary }`。`sourceRef` 用 `chapterLabel`，比如「外传·青冥旧事 第 2 章」。
- `apply.ts` 新增 `sideStory:create|merge|replace` 三个分支：用 `SideStoryPayload = z.object({ rollingSummary: z.string().optional() })` 校验后调用 `updateSideStory`。外传不存在时抛错「这部外传已不存在，可能已被删除」，按现有的逐条失败语义处理，提案留在待确认里。

### 5.4 写作页与编辑器

- `WritingPage` 查询加上 `listSideStories`。
  - 「全书进度」的字数和章数只算 `chaptersOfTrack(chapters, null)`。
  - 「章节正文」列表只列主线，标题里的章数也只算主线。
  - 「导出」按钮的显示条件从 `chapters.length > 0` 改为「主线或外传有任一章」（即全量 `chapters.length > 0`，不按线过滤）。按钮仍挂在「章节正文」区块上，只有外传的作品，这个区块显示空列表的提示和导出按钮，不会找不到入口。
  - 编辑器接线：打开章节时（包括译名跳转经 `openChapterId` 打开外传章节），按 `editingChapter.sideStoryId` 在 `listSideStories` 的结果里查到对应外传，作为 `sideStory` 传给 `ChapterEditorScreen`；查不到时（外传刚被删）关闭编辑器。全量 `sideStories` 同时传给编辑器，供 `chapterLabel` 和 `context.sideStories` 使用。
- 新增 `Section`「外传」，始终渲染（空作品也显示，作为入口）：
  - 说明：「独立于主线的番外篇章：各自从第 1 章编号，不进主线的摘要链与进度。」
  - 区块右上角按钮「新建外传」。
  - 每部外传一张卡片（`rounded-xl border`）。表头写「外传·X」，旁边是「k 章 · 字数」；右侧有图标按钮「编辑外传《X》」，点开 `SideStorySheet`；另有 `Button size="sm"`「写新一章」。卡片下面是这部外传的章节列表，和主线列表共用抽出来的 `ChapterListItem`，按钮的 aria-label 是「继续写外传《X》第 N 章」。
  - 两端都是单列。桌面端由 `Page width="wide"` 限宽，章节列表长短不一，做成两列反而参差。
- 空状态的判断改为「大纲、主线章节、外传都为空」。这时仍然显示 EmptyState，外传区块渲染在它下面。
- 新组件 `SideStorySheet.tsx`，用现有的 `Sheet`（移动端是底部抽屉，桌面端是右侧抽屉），有新建和编辑两种模式：
  - 「名称」：`TextField`，必填。
  - 「简介」：`TextAreaField`，提示「写清这部外传讲什么、发生在主线的什么时候（之前、同期还是之后）。写外传时会交给模型。」
  - 外传进展摘要：非空时只读展示，修改只能走摘要提案。
  - 编辑模式有「删除这部外传」，弹出 `ConfirmDialog`（destructive）：「外传·X 及其 k 章（共 M 字）会被永久删除，无法恢复。」
  - 仓储抛出的错误（重名等）显示在字段的 error 位置。
- 「写新一章」调用 `createChapter(novel.id, { sideStoryId, source: 'manual' })`，然后打开编辑器。
- `ChapterEditorScreen` 新增 `sideStory?: SideStory` 属性：
  - 元信息行和标题占位符用 `chapterLabel`。
  - `aria-label` 是「编辑外传《X》第 N 章」。
  - 删除确认框用 `chapterLabel`。
  - `sideStory` 继续传给 `ChapterSummarySheet`，`context.sideStories` 交给 Generate 和 Revise。
  - 翻译、自动保存、记产出不变。
- `GlossarySheet` 的不一致清单：删掉文件里本地的 `chapterLabel(chapter: GlossaryDriftChapter)`，改用 `domain/sideStory` 导出的 `chapterLabel`。它自己的查询加上 `listSideStories`，按 drift 里的 `id` 回查完整章节，标签写成 `${chapterLabel(chapter, sideStories)}${chapter.title ? ` ${chapter.title}` : ''}`，保留现在「第 N 章 标题」的样子。domain 层的 `findGlossaryDrift` 和 `GlossaryDriftChapter` 不变。不保留同名的本地函数，是为了避免两个 `chapterLabel` 在同一文件里互相遮蔽、外传章节悄悄走到旧的那个。

### 5.5 计划与统计

- 外传章节在编辑器里保存时照常走 `recordProgress`，字数和完成章数计入每日日志。导入的外传和主线一样不计入。
- `PlanPage` 不需要改。
- 书架卡片照旧显示「{chapterCount} 章」（此时只是主线），`sideChapterCount > 0` 时追加「· 外传 K 章」。
- 总字数和备份提醒用的 `wordCount` 包含外传。外传同样是会丢的数据，提醒不能把它漏掉。

### 5.6 导出（`exportText.ts` / `ExportSheet.tsx`）

- `formatNovel(novel, chapters, options)`：先过一遍 `chaptersOfTrack(..., null)`，主线的结果和现在逐字节一致。新增 `options.sideStories?: { story: SideStory; chapters: Chapter[] }[]`，非空时在正文后面依次追加 `# 外传·X`（纯文本格式不带 `#`），其下各章仍是 `##` 级。`doneOnly` 和空章跳过的规则对外传同样生效。
- 新增 `formatSideStory(novel, story, chapters, options)`，单独导出一部外传时用，开头是 `# {书名} · 外传·X`。`exportFileName` 的 scope 增加 `{ kind: 'side'; story }`，文件名为 `书名 - 外传·X.md`。
- `ExportSheet` 新增 `sideStories` 属性：
  - 范围控件为 全书 / 单章 / 外传，「外传」只在有外传时出现。
  - 全书范围增加 `Toggle`「附带外传」，默认关。
  - 外传范围用 `SelectField` 选择要导出的那一部。
  - 单章范围的下拉框先列主线，再按外传分组列出，标签用 `chapterLabel`。
- **外传单章的标题和文件名**：现在的 `chapterHeading` 在标题为空时退回「第 N 章」，外传第 2 章会和主线第 2 章同名，文件也会撞名。改法：
  - `chapterHeading(chapter, sideStory?)`：主线不变；外传章节有标题时用标题，没有时用 `chapterLabel`（「外传·X 第 N 章」）。`formatNovel` 附带外传时，章节已经排在 `# 外传·X` 之下，仍然调不带 `sideStory` 的版本，正文里不重复外传名。
  - `exportFileName` 的 chapter scope 增加可选 `sideStory`：外传单章的文件名后缀固定用 `chapterLabel`，有标题时再接标题，即 `书名 - 外传·X 第 N 章 标题.md`。主线单章的文件名逐字节不变。

只有外传、没有主线章节的作品：面板打开时的默认范围（现在是「有指定章节就单章，否则全书」）改为「有指定章节就单章；否则主线有章就全书；否则外传」，避免一打开就是一份只有书名的全书导出。

### 5.7 反向提取（外传目的地）

- 条目照常提取，合并进同一个知识库，`sourceChapterIds` 记外传章节的 id。
- `buildExtractUserPrompt` 新增可选参数 `sideStory?: { title; synopsis }`：
  - 进展块标题改为「此前的外传进展摘要」。
  - 正文前面插入说明（简介为空时省掉括号整段，写成「本批正文是外传《X》，独立于主线。…」）：「本批正文是外传《X》（简介：……），独立于主线。rollingSummary 只写这部外传自身的进展；条目字段写长期成立的事实，外传里某一时期特有的状态（如当年的身份）要写明时期，不要当成现状。」后一句是为了让条目合并时更不容易记错，前传里的「青冥宗弟子」不该把主线里的「宗主」顶掉；就算模型没照做，合并时也会被标成改动，交给用户裁决。
  - 系统提示不变；不传 `sideStory` 时输出逐字节不变。
- 逐章摘要提案的标签为「外传·X 第 N 章摘要」，`sourceRef` 为「外传·X 第 N 章」。条目的 `formatSourceRef` 接受可选前缀，输出「外传·X 第 1、3 章」。
- 收尾时不出 `novel` 提案。`job.rollingSummary` 非空且与（重新读取的）`sideStory.rollingSummary` 不同时，出一条 `sideStory` 提案；外传已经被删时跳过这条。

---

## 6. 开放问题：最终推荐

**6.1（a）多部具名外传 —— 支持。** 代价只是一张小表、一个外键，外加 picker 和写作页多一层分组。单一序列虽然省掉这些，但「外传·青冥旧事」和「外传·雪夜番外」会挤在同一套编号和同一条摘要链里，伏笔与进展互相污染，等于把「外传不进主线链」这个问题原样搬到了外传内部。真要以后再拆，还得做数据迁移。

**6.2（b）外传完成后生成摘要 —— 生成，归入外传自己的链。** 摘要是后续章节唯一的前情来源，外传写到第五章同样会忘掉第一章。链的边界由 `chaptersOfTrack` 定死：伏笔只在本外传内累计，进展摘要写进 `SideStory.rollingSummary`，主线的 `rollingSummary` 和伏笔一样都不碰。

**6.3（c）写外传时的上下文 —— 知识库 + 风格档案 + 外传简介 + 外传进展 + 同一外传的前文摘要和上一章结尾；主线全书进展默认不注入，可以手动打开。** 外传在时间线上的位置不固定。对前传注入主线进展，模型会让人物「提前知道后来的事」，这是外传里最容易出现的崩坏。人物和世界规则这类稳定事实已经由知识库提供。确实是后传的，打开开关就能拿到主线现状，注入清单里看得见、可以按预算裁剪。

**6.4（d）字数 —— 计入书架总字数和计划的每日产出，不计入主线进度。** 外传是真实的写作产出，计划衡量的是写作习惯，不是主线推进了多少。备份提醒更不能漏掉这部分字数。「全书进度」回答的是「主线写到哪了」，所以不含外传。

**6.5（e）导出 —— 主线导出默认不带外传；可以单独导出一部，也可以勾选附在全书后面。** 投稿或贴到平台时，正文和番外通常分开发布，所以默认不带。「附带外传」满足整理全集或私人存档的需要。

**6.6（f）导入外传时的反向提取 —— 条目照常提取；摘要进外传链；文风归纳默认关，可以手动勾上。** 番外常常刻意换一种语气（更轻、更日常），样本也比正文少，拿它去替换风格档案，判错的概率高。它毕竟还是一条提案，不会直接生效；但默认开着，用户要多付一次调用，收件箱里还会多一条大概率被忽略的提案。把勾选框挪到目的地选择里，是因为默认值取决于目的地；选目的地发生在提取之前，仍然是花钱之前最后一个能改的地方。文风取样沿用现有逻辑，只取本批导入的章节（`buildStyleProposal` 按 `job.chapters` 的 chapterId 过滤），不会混入主线。

**6.7 外传与大纲树 —— 不支持，外传章节不关联大纲节点。** 大纲树是主线结构，由创作方法论决定，`outlineStats` 直接驱动「全书进度」，节点位置块也是按主线卷章写的。让外传挂上大纲节点，进度会混进外传，`OutlineNodeSheet` 的「写这一章」还得先问「主线还是外传」。外传的规模通常也撑不起一棵树，**简介**就是它的轻量大纲，同时参与默认预选的推断。backlog：每部外传一棵独立的小大纲树。

**6.8 逐章混选目的地 —— 不做。** 评估下来成本不低：任务要按章记录目的地；提交时要拆成多条线分别编号，还要把世界观那部分另外打包；提取循环要按章切换链状态（每条线各自的 rollingSummary 和伏笔）；收尾要出多条进展提案；picker 也要从单选题变成逐章表格，手机上尤其难用。整批单选已经覆盖主要场景。正文和番外混在一个文件里时，导两次即可：第一次在分章页删掉番外章节，第二次只留番外。

---

## 7. 不变量与归属层

| 不变量                                                                          | 归属                                                                                                                                                                                                                                                 | 为什么在这一层                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每条线内编号连续且不冲突；外传章节不关联大纲；`sideStoryId` 不能通过 patch 修改 | 仓储（`createChapter` / `updateChapter` / `commitImportChapters`）                                                                                                                                                                                   | 只有存储层看得到全量数据；调用方有写作页、导入、提案应用好几处                                                                                                                                                                           |
| 导入草稿写成章节和任务推进同成同败                                              | 仓储事务（`commitImportChapters`）                                                                                                                                                                                                                   | 原子性只有存储层给得了                                                                                                                                                                                                                   |
| 世界观目的地不写 Chapter                                                        | 仓储：世界观分支只调 `commitImportWorldview`，它的事务只开 `importJobs`；`commitImportChapters` 的目标类型里没有 worldview                                                                                                                           | 用类型和事务范围把路堵死，测试负责盯住                                                                                                                                                                                                   |
| 主线上下文不含外传，外传上下文只含本外传                                        | `SummaryChainContextBuilder` 入口处的 `chaptersOfTrack`                                                                                                                                                                                              | 生成和段落加工都经过它，调用方传全量也不会出错                                                                                                                                                                                           |
| 伏笔只在同一条线内承接                                                          | `previousSummaryOf`，以及仓储 commit 时的伏笔初始值                                                                                                                                                                                                  | 摘要面板和导入两条路径各自只有一个入口                                                                                                                                                                                                   |
| 主线 `rollingSummary` 只能被主线的摘要或导入改动                                | 提案构建处按**章节数据**（`chapter.sideStoryId`、`job.destination.kind`）选择 target，不按组件属性；落库仍走唯一的 `apply.ts`                                                                                                                        | 确认管道是唯一的写库通道；按数据分支，接线漏传属性也不会改写主线                                                                                                                                                                         |
| 外传名称在本书内唯一，且不带「外传」前缀                                        | 仓储（`normalizeSideStoryTitle` + `sideStoryTitleKey` 查重），UI 预检用同一个键，只为即时反馈                                                                                                                                                        | 名称会出现在 picker、导出文件名和 prompt 里；比较键只有一份，两层不会判得不一样                                                                                                                                                          |
| 备份里不存在指向不存在外传的章节                                                | `RepositorySnapshotSchema.superRefine`                                                                                                                                                                                                               | 备份是外部输入，落库之前必须完整过一遍 Zod                                                                                                                                                                                               |
| 旧任务的换算规则只有一份，且对任何输入都不抛错                                  | `upgradeLegacyImportJob`（domain），由 Dexie 迁移和 Zod preprocess 共用                                                                                                                                                                              | 两处各写一份必然漂移；它跑在 upgrade 里，抛错就是全库打不开                                                                                                                                                                              |
| ImportJob 的阶段与字段对应（3.2 表）                                            | 写入侧：仓储的 `saveImportDrafts` / `commitImportChapters` / `commitImportWorldview`；草稿阶段的逐章修改只经 `patchImportDrafts`（不在草稿阶段即拒绝、不新建行、不改长度）；读取侧：面板加载时 `ImportJobSchema.safeParse` + `resumeStepOf` 兜底清掉 | 用 schema 强制会和 `{...current, ...patch}` 的增量写法冲突；三个方法是仅有的会改 `destination` 和数组长度的地方。这一点成立的前提是没有调用方拿过期的整份数组写回，所以草稿阶段的写入必须在事务里合并到库里最新行，不能交给 `persistJob` |
| 已译（`done`）草稿的译文不被改写或降级                                          | 仓储 `patchImportDrafts` 第 3 条规则；界面 disabled 只是即时反馈                                                                                                                                                                                     | 译文是付过钱的；能改它的除了界面还有旧实例迟到的写入和另一个标签页，只有存储层同时看得到这三者                                                                                                                                           |
| 被截断的译文不算「已译」                                                        | `translateOne` 检查 `ChatResult.finishReason === 'length'`（4.3 / 4.9）                                                                                                                                                                              | 半截译文能过 `parseTranslation`，只有 LLM 层知道是不是撞了输出上限；世界观提交后原文就没了，不能事后再查                                                                                                                                 |
| 分章页不悄悄冲掉别处的草稿                                                      | 仓储 `saveImportDrafts` 的 `expectedJobId` 检查                                                                                                                                                                                                      | 另一处的草稿可能已经付费译了一半；「我以为库里是哪一行」只有调用方知道，「库里实际是哪一行」只有事务里读得准                                                                                                                             |
| 目的地提交至多一次                                                              | 仓储：`commitImportChapters` / `commitImportWorldview` / `saveImportDrafts` 三处都在事务内检查 `destination !== null` 即拒绝；界面 reject 后重读任务                                                                                                 | 判断依据是库里的状态，不是错误文案；「先读再写」只有放进同一个事务才挡得住跨标签页                                                                                                                                                       |
| 界面拿到的 ImportJob 形状完整（数组键都存在）                                   | 迁移 `upgradeLegacyImportJob` 每个分支补齐 + 面板加载时 parse                                                                                                                                                                                        | 读取路径不做 parse，项目没有 ErrorBoundary，一处 `undefined.some` 就是白屏                                                                                                                                                               |

---

## 8. 外部输入校验

| 输入                                | 规则                                                                                                                                  | 失败时                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 外传名称（picker / SideStorySheet） | 必填；`normalizeSideStoryTitle` 后 1–40 字；本书内 `sideStoryTitleKey` 唯一（改名时排除自身）                                         | 字段报错，主按钮禁用；仓储兜底抛 `Error`，界面显示在字段位置                                                                         |
| 外传简介                            | 可选，≤ 2000 字                                                                                                                       | 字段报错，不能保存                                                                                                                   |
| 目的地                              | `ImportDestinationSchema`；`side.sideStoryId` 必须存在且属于本书                                                                      | commit 抛错，事务回滚，目的地步骤显示 `role="alert"`，可以改选后重试                                                                 |
| 分章草稿                            | `ImportDraftSchema`；`index` 为正整数；至少 1 章                                                                                      | 0 章时主按钮禁用（现有逻辑）                                                                                                         |
| 译文                                | `parseTranslation`；译文为空按 `LlmError('parse')` 处理；`finishReason === 'length'`（被输出上限截断）同样按 `LlmError('parse')` 处理 | 这一章标为 `failed`，循环停下，可以单章重试；截断时草稿不改，提示用户回分章页切小                                                    |
| 外文草稿长度                        | `content.length > TRANSLATE_SOFT_LIMIT`（6000）                                                                                       | 不拦截，分章页这一章旁显示 `role="note"` 提示可能被截断                                                                              |
| 备份文件                            | 先查文件头（`app`、`version ≤ 2`），再做整份 `BackupFileSchema`；快照的外传引用完整、外传与章节同属一部作品、外传章节不关联大纲       | `BackupError`：版本过新时显示「来自更新版本」，其余显示首个问题的路径和原因；什么都不写                                              |
| 旧 ImportJob 行                     | 迁移时 `upgradeLegacyImportJob` 补齐形状；面板加载时 `ImportJobSchema.safeParse`（含同一个 preprocess）+ `resumeStepOf`               | 空任务静默清掉；parse 失败或不合阶段表则清掉并显示说明；章节不受影响。「放弃这次导入」只调 `deleteImportJob`，不经过 parse，始终可用 |

---

## 9. 错误处理

本项目没有日志和埋点，错误一律显示在界面上（`role="alert"`，内容是 message 加可选 detail）。下面的操作都**不写控制台日志**，和现有约定一致。

| 操作                                             | 失败情形                                                                                                             | 可恢复？                   | 调用方拿到 / 界面表现                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDraftJob`（`saveImportDrafts`）           | IndexedDB 写失败（配额、隐私模式）                                                                                   | 可恢复                     | 停在分章页，提示「保存分章结果失败：{msg}。浏览器存储可能已满，可以先导出备份。」，再点一次即重试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `createDraftJob`（`saveImportDrafts`）           | 库里已有 `destination !== null` 的任务（另一个标签页刚提交）                                                         | 可恢复                     | 与 commit 被拒相同：重读任务，`setJob` 后进入提取步骤，不显示 alert。和 commit 被拒不同的是，这里用户刚分好的稿子没有存下来，所以显示 `role="note"`「另一处已经有一批稿件在提取中，这次的分章结果没有保存；处理完那一批再导入」，不悄悄丢掉                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `createDraftJob`（`saveImportDrafts`）           | 库里有一个 `id !== expectedJobId` 的草稿任务（另一个标签页正在翻译，或面板加载时 `getImportJob` 失败而停在粘贴步骤） | 可恢复                     | 与上一行相同：重读任务，`safeParse` + `resumeStepOf` 重新定步骤（通常落在翻译或目的地步骤），`setJob`，再显示同一条 `role="note"`（文案把「在提取中」换成「在处理中」）。不覆盖，这次的分章结果不保存                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 翻译一章                                         | 模型或网络错误、译文为空                                                                                             | 可恢复                     | 这一章标为 `failed`，循环停下，提示「第 N 章翻译失败：…」，提供单章「重试」；已译章节不受影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 翻译一章                                         | 译文被输出上限截断（`finishReason === 'length'`）                                                                    | 可恢复                     | 抛 `LlmError('parse', '译文超出单次输出上限被截断了', '这一章太长，回到分章页把它切小一些再译')`，走上一行的同一条路径：标为 `failed`，`role="alert"` 显示「第 N 章翻译失败：译文超出单次输出上限被截断了」和 detail。**不写回草稿**，`content` 仍是原文。草稿阶段已经落盘，回分章页要先「放弃这次导入」再重新粘贴（放弃会连带清掉这一批里已译好的其他章节，确认框会写明 K 章译文被清空，4.7）。正因为事后补救要付出这个代价，主要防线放在分章页的事前提示（4.1）；或者点「跳过剩下的」让这一章按原文进入目的地（主线 / 外传可以之后到编辑器里逐章翻译）                                                                                                                                             |
| 翻译相关写入（`patchImportDrafts`）              | 任务不存在 / parse 失败 / `destination !== null`（另一处已提交或放弃）/ 找不到 index                                 | 自动恢复                   | 静默：翻译循环停下，不 `markTranslate('failed')`、不显示 alert；`getImportJob` 重读，按 4.6 的加载规则重新定步骤（已提交 → 提取步骤；已放弃 → 粘贴步骤；读不到也按粘贴步骤）。组件已卸载时什么都不做。勾选 / 重试 / 跳过被拒时同样处理                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 卸载时进行中的翻译请求                           | `AbortController.abort()` 后请求抛出 abort 错误                                                                      | 预期行为                   | 循环内 `!aliveRef.current` 时直接返回，不标失败；这一章在库里仍是 `pending`，下次打开从它接着译                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 翻译后合并译名表                                 | 写失败                                                                                                               | 可恢复，不阻断             | 译文已经先落盘；`note` 提示「译名表没存上，下一章可能换个译法」；这一章仍算已译                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `commitImportChapters`                           | 外传已被删除、名称重复、无任务、任务已写入过、IndexedDB 错误                                                         | 可恢复，事务回滚           | Promise reject，带中文 message。界面**不按错误类型或文案区分**：一旦 reject，就 `await repository.getImportJob(novelId)` 重读任务。读到 `destination !== null`（另一个标签页或上一次点击已经写入成功），`setJob` 后进入 `extract`，不显示错误；否则留在当前步骤，显示 `role="alert"`（commit 的 message），并重新加载一次 `listChapters` + `listSideStories`、重算 `lineCounts`：原先选中的 `sideStoryId` 已经不在列表里（外传在别处被删）时，picker 回退到「新建外传」、名称留空，规则与 4.8 一致，避免用户对着一个已不存在的选项反复重试。重读本身也失败时，显示原来 commit 的错误。幂等性只依赖库里的状态，文案以后怎么改都不会破坏它，也不用为此导出专门的错误类。提交期间按钮禁用，避免重复提交 |
| 世界观转换 `commitImportWorldview`               | 无任务、任务已写入过、`chunks` 为空、IndexedDB 错误                                                                  | 可恢复，事务回滚           | 处理与 `commitImportChapters` 完全相同：reject 后重读任务，`destination !== null` 就 `setJob` 并进入提取步骤、不显示错误；否则留在当前步骤显示 alert，什么都没写                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 提取一章（外传）                                 | `getSideStory` 读不到（外传在提取途中被删）                                                                          | 可恢复                     | `extractOne` 抛 `Error('这部外传已不存在，可能已被删除')`，不发请求；`runLoop` 的 catch 统一 `markChapter(..., 'failed', message)`、`setError`，循环按现有「失败即停」停下（通常更早一步就因章节被级联删除而报「章节已不存在」）                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 提取一章或一段 / `finalize`                      | 维持现有行为（失败即停、单章重试、跳过失败直接整理）                                                                 | —                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `finalize`（外传）                               | 外传在提取途中被删                                                                                                   | 可恢复                     | 章节已经被级联删除，提取会以「章节已不存在」失败；收尾跳过外传进展提案                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 应用 `sideStory` 提案                            | 外传不存在                                                                                                           | 单条失败                   | `acceptProposals.failed` 里多一条「这部外传已不存在，可能已被删除」，提案保持待确认                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `create` / `update` / `deleteSideStory`          | 名称不合法或重复、写失败                                                                                             | 可恢复                     | `SideStorySheet` 在字段或 alert 位置显示，抽屉不关；删除是一个事务，失败时什么都不删                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `createChapter`：外传不存在 / 外传章节关联了大纲 | 编程错误或数据竞争                                                                                                   | 可恢复                     | 抛 `Error`，写作页 alert；正常界面路径到不了                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Dexie v5 升级                                    | upgrade 回调抛错 → 整个升级回滚，打不开数据库                                                                        | **致命**（全部作品不可读） | 按现有的打开数据库失败处理（不在本次范围内）。这是本次唯一的致命环节，靠设计消除而不是靠捕获：`chapters` 的 `modify` 只做 `??=`；`importJobs` 的换算走全函数 `upgradeLegacyImportJob`（3.3 的约束），任何形状的旧行都不抛错，换不出来的形状原样留下，交给面板加载时的 parse 和 `resumeStepOf` 清掉（4.6）。`importJobs` 的 `modify` 回调里再包一层逐行 `try/catch` 作第二道防线：万一抛错，这一行保持原样（`upgradeLegacyImportJob` 返回新对象、不改入参，所以不会留下半换算的行），不写日志。取舍很明确：一行导入任务的进度不值得让全部作品打不开，用户也说过旧数据不用捞回来。`chapters` 不包这一层，它只有一个 `??=`，不会抛错                                                                    |
| 加载到旧版空任务                                 | `resumeStepOf` 返回 `{ discard: 'silent' }`                                                                          | 自动恢复                   | 静默删除任务行，进入粘贴步骤                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 加载到无法恢复的任务                             | `ImportJobSchema.safeParse` 失败，或 `resumeStepOf` 返回 `{ discard: 'notice' }`（不合阶段表）                       | 自动恢复                   | 删除任务行，进入粘贴步骤，显示 `role="note"`「上一次导入的进度无法恢复，已清掉；已写入的章节正文都在写作页里」；章节不删                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## 10. 文件改动清单

| 文件                                                                                                                                  | 改动                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/schema.ts`                                                                                                                | `SideStorySchema`；`Chapter.sideStoryId`；`ImportDraftSchema` / `ImportDestinationSchema`；ImportJob 增删字段 + preprocess；chunk 的 `title`；`ProposalTarget` 加 `'sideStory'`；`NovelStats.sideChapterCount`；快照的 `sideStories` + superRefine；删除 `ImportTypeSchema` |
| `src/domain/sideStory.ts`（新）                                                                                                       | 3.4 的辅助函数                                                                                                                                                                                                                                                              |
| `src/domain/importJob.ts`（新）                                                                                                       | `upgradeLegacyImportJob`（每个分支补齐五个数组键）                                                                                                                                                                                                                          |
| `src/data/NovelRepository.ts` / `dexie/DexieNovelRepository.ts`                                                                       | 5.1 的外传方法与改动 + 4.4 的 `saveImportDrafts`（带 `expectedJobId`）/ `patchImportDrafts` / `commitImportChapters` / `commitImportWorldview`                                                                                                                              |
| `src/data/dexie/db.ts`                                                                                                                | v5（含 `sideStories` 表声明与注释，3.3）                                                                                                                                                                                                                                    |
| `src/llm/types.ts` / `src/llm/OpenAiCompatibleClient.ts`                                                                              | `ChatResult.finishReason`；流式取最后一个非空值、非流式取最后一个 choice（4.9）                                                                                                                                                                                             |
| `src/features/writing/translate.ts`                                                                                                   | `TRANSLATE_SOFT_LIMIT = 6000`                                                                                                                                                                                                                                               |
| `src/context/ContextBuilder.ts` / `SummaryChainContextBuilder.ts`                                                                     | 5.2                                                                                                                                                                                                                                                                         |
| `src/proposal/fields.ts` / `apply.ts`                                                                                                 | `sideStory` 的字段规格和落库分支                                                                                                                                                                                                                                            |
| `src/features/import/ImportScreen.tsx`                                                                                                | 新的步骤机、草稿上的翻译（全部经 `patchImportDrafts`、被拒时静默重定步骤、卸载时 abort、截断检测）、分章页超长提示、目的地分支、外传提取与收尾、`FinishedDestination.count`、旧任务提示、放弃文案                                                                           |
| `src/features/import/DestinationPicker.tsx`（新）                                                                                     | 4.2                                                                                                                                                                                                                                                                         |
| `src/features/import/importFlow.ts`（新）                                                                                             | `resumeStepOf`、目的地相关文案的纯函数                                                                                                                                                                                                                                      |
| `src/features/import/worldview.ts`                                                                                                    | `packWorldviewChunks`                                                                                                                                                                                                                                                       |
| `src/features/import/extractSettings.ts`                                                                                              | `buildExtractUserPrompt` 的 `sideStory` 参数，`sourceLabel` 文案                                                                                                                                                                                                            |
| `src/features/writing/chapterSummary.ts` / `ChapterSummarySheet.tsx`                                                                  | 5.3                                                                                                                                                                                                                                                                         |
| `src/features/writing/WritingPage.tsx`、`SideStorySheet.tsx`（新）、`ChapterListItem.tsx`（新，从 WritingPage 抽出）                  | 5.4                                                                                                                                                                                                                                                                         |
| `src/features/writing/ChapterEditorScreen.tsx` / `GenerateChapterSheet.tsx` / `GlossarySheet.tsx`                                     | 5.4 / 5.2                                                                                                                                                                                                                                                                   |
| `src/features/export/exportText.ts` / `ExportSheet.tsx` / `backup.ts`                                                                 | 5.6 / 3.5                                                                                                                                                                                                                                                                   |
| `src/features/shelf/ShelfPage.tsx`                                                                                                    | 「外传 K 章」                                                                                                                                                                                                                                                               |
| `docs/产品文档.md` 6.3 / 6.5 / 6.7 / 8.2、`docs/使用说明.md` 第 3 / 6 / 8 节、`docs/设计方案.md` 第 7 节、`docs/开发计划.md` 增量记录 | 同步新流程和外传；删掉「为什么世界观导入暂不翻译」那一段，改写成「为什么目的地要在翻译之后选」                                                                                                                                                                              |

---

## 11. 测试清单

**新增：纯逻辑**

- `domain/sideStory.test.ts`：`isMainChapter`、`chaptersOfTrack`（按线过滤、按序排列、两部外传互不混入）、`chapterLabel`、`normalizeSideStoryTitle`（去掉「外传·」「番外：」前缀，trim）、`sideStoryTitleKey`（「青冥旧事」与「外传·青冥旧事」同键，「Arc」与「arc」同键）。
- `domain/importJob.test.ts`：
  - 旧 worldview 任务转成 `worldview` 并补上 chunk 的 `title`；旧章节任务转成 `main` 并保留翻译状态；空的旧任务转成 `null`；`destination` 为 `null` 或对象时都原样返回；`worldviewText` / `importType` 被移除；不修改入参。
  - 全函数（每一种都断言不抛错）：缺少 `worldviewChunks` 的 worldview 行；既没有 `importType` 也没有 `chapters` 的行；`chapters` 不是数组；`worldviewChunks` 里有非对象元素；`null`、`undefined`、字符串、数组。
  - 补齐形状：旧 main 行、旧 worldview 行、空的旧行、已有 `destination` 但缺 `drafts` 的行，输出都有 `drafts` / `chapters` / `worldviewChunks` / `entryDrafts` / `openThreads` 五个数组键。
- `domain/sideStory.test.ts` 追加：`renderSideStoryBrief` 简介为空时没有简介行、没有空括号。
- `domain/schema` 相关：
  - `ChapterSchema` 的 `sideStoryId` 默认为 null。
  - 旧快照（没有 `sideStories`、章节没有 `sideStoryId`）能解析。
  - 引用不存在外传的快照被拒绝，报错路径正确。
  - 外传属于别的作品、外传章节带 `outlineNodeId` 的快照被拒绝，路径和文案正确。
  - 旧备份里的进行中任务经 preprocess 后能解析。
- `import/worldview.test.ts`：`packWorldviewChunks` 覆盖以下情况：
  - 短章打包后不超过上限。
  - 不在章内切开。
  - 超长章按段落切，标题带「（i/k）」。
  - 跨章的段标题是「首 — 末」。
  - 空章跳过。
  - 把所有段的 `content` 拼起来，去掉普通段里补入的标题行和空白之后，与各草稿 `content` 依次拼接、去掉空白的结果一致（不丢字、不重复）。
  - 超长章切出的各段 `content` 里不含「{章标题}」标题行；判超长时计入标题行（`titleLine + content` 恰好超过 `max`、`content` 本身不超时，仍按超长切）。
- `import/importFlow.test.ts`：`resumeStepOf` 的六种返回（`silent`、`notice`、`translate`、`destination`、worldview 的 `extract`、main/side 的 `extract`），断言区分 `silent` 与 `notice`。
- `import/extractSettings.test.ts`：传 `sideStory` 时有外传说明和「外传进展摘要」标题；不传时输出逐字节不变（原有断言）；`sourceLabel` 带章节标题。
- `writing/chapterSummary.test.ts`：`previousSummaryOf` 只在同一条线内承接（外传编号更大时不会被主线取到，反之亦然）；`buildSummaryUserPrompt` 传 `sideStory` 时有说明，不传时不变。
- `context/SummaryChainContextBuilder.test.ts`：
  - 主线目标忽略外传章节，涵盖上一章、最近摘要、结尾；外传编号更大时也一样。
  - 没有目标章节时取主线最后一章。
  - 外传目标只取同一部外传。
  - 外传默认不注入 `Novel.rollingSummary`，`includeMainProgress` 为 true 时注入并带标签。
  - 外传说明块是必收的，位于易变后缀。
  - 主线和外传在选同一组条目时 `stablePrefix` 相同。
  - 外传简介参与默认预选的推断。
  - 外传章节打开 `includeMainProgress` 时，两条进展的 `id` 分别是 `rolling-side` / `rolling-main`，不重复；外传摘要和结尾的标签是「外传第 N 章摘要」「外传第 N 章结尾原文」。
  - 外传简介为空时，说明块里没有简介行。
  - 外传目标但 `request.sideStories` 里没有这部外传：只取同一外传的前文，不注入 `Novel.rollingSummary`（`includeMainProgress` 为 false 时），没有说明块。
- `export/exportText.test.ts`：`formatNovel` 默认不含外传，主线输出逐字节不变；`sideStories` 按顺序追加；`formatSideStory` 单独导出的标题；`exportFileName` 的外传 scope；无标题的外传第 2 章，单章导出的标题和文件名是「外传·X 第 2 章」，与主线第 2 章不同；主线单章文件名不变。
- `proposal/apply.test.ts` / `fields.test.ts`：`sideStory:replace` 更新进展摘要；外传不存在时报错；`fieldSpecsFor('sideStory')`。
- `export/backup.test.ts`：`BACKUP_VERSION === 2`；v1 文件能恢复且都是主线；外传往返完整；v3 文件被拒绝，且**即使 `data` 里带当前版本不认识的字段或枚举值**，报的也是「来自更新版本」而不是解析错误（验证先查版本）。
- `import/worldview.test.ts` 追加：每段 `content.length ≤ max`（含标题行与空行）；`index` 从 1 起连续，`status` 为 `pending`、`error` 为 `''`；无标题的超长章切出的段 `title` 为 `''`。
- `ImportScreen.test.tsx` 的世界观标签：有标题的段是「世界观设定 · {title}」；无标题且多段是「世界观设定 第 i/N 段」；无标题且只有一段是「世界观设定」。
- `import/importFlow.test.ts` 追加：下列组合都返回 `{ discard: 'notice' }`：`null` + `chapters` 非空、`null` + chunks 非空、main/side + `chapters` 为空、main/side + chunks 非空、main/side + `drafts` 非空、worldview + chunks 为空、**worldview + `chapters` 非空**、worldview + `drafts` 非空；数组字段缺失时不抛错。

**新增：仓储（`DexieNovelRepository.test.ts`）**

- 架构版本为 5（改写现有的「为 4」断言）。
- **v4 → v5 迁移**：用一个只声明到 v4 的原生 Dexie 写入旧章节和三种旧任务，关闭后用 `AppDatabase` 打开，验证 `sideStoryId === null` 且三种任务已换算。再加一条字段缺失的旧行（没有 `importType`、没有 `worldviewChunks`、`chapters` 不是数组），断言数据库能正常打开、作品和章节都读得到。
- 外传增删改：标题归一化；重名拒绝（含只差大小写、只差「外传·」前缀）；`updateSideStory` 只改自身大小写不算重名；patch 里的 `order` / `novelId` 被剥掉；删除时级联删除章节和摘要，主线不受影响。
- `saveImportDrafts`：无任务时新建（`expectedJobId: null`）；`destination` 为 null 且 `expectedJobId` 等于库里的 id 时覆盖；`destination` 为 null 但 `expectedJobId` 为 null 或别的 id 时被拒绝「另一处已经有一批稿件在处理中」、库里的草稿和译文不变；`destination` 为 main 时被拒绝、任务不变；库里的行 parse 失败时不论 `expectedJobId` 都直接覆盖。
- `patchImportDrafts`：
  - `destination` 为 main 时调用被拒，任务不变。
  - 没有任务时调用被拒，也不新建行（`getImportJob` 仍为 `undefined`）。
  - 库里的行 parse 失败时被拒，行不变。
  - 对 `done` 草稿传 `translateStatus: 'pending'`、`'failed'`、改写 `content` 都被忽略，不抛错，返回的任务里这一章不变。
  - 两次调用各改不同的 index，两处结果都保留（第二次调用传的不是第一次的返回值）。
  - 找不到的 index 被拒，同一次调用里的其他 patch 也没有写入（事务回滚）。
  - 一次调用传多条 patch 时全部生效；`drafts` 长度、`destination`、`batchId` 不变。
- `llm/OpenAiCompatibleClient.test.ts`：流式最后一个带 choice 的帧 `finish_reason: 'length'`、其后再来一帧只带 `usage` 时，`finishReason` 为 `'length'`；`'stop'` 时为 `'stop'`；整条流都不带时为 `null`；非流式取 `choices` 最后一项的 `finish_reason`，缺失时为 `null`。
- `commitImportWorldview`：成功后 `listChapters` 仍为 `[]`、阶段字段符合 3.2 表；`destination` 已为 main 时被拒绝、任务不变；第二次调用被拒绝；`chunks` 为空被拒绝。
- `createChapter`：
  - 按线编号（主线 1..3、外传 1..2 互不影响）。
  - 外传不存在时拒绝。
  - 外传章节关联大纲时拒绝。
  - `updateChapter` 改不了 `sideStoryId`（静默剥掉，其余字段照常保存）；给外传章节设 `outlineNodeId` 被拒绝。
  - `getSideStory` 返回最新值，不存在时为 `undefined`。
- `commitImportChapters`：
  - 主线从主线最大章号接续，忽略外传。
  - 已有外传从外传内部接续。
  - `newSide` 会新建外传；`side` 和 `newSide` 返回的 `sideStory` 非 null，`main` 返回 null。
  - 原文、语种、按译文算的字数都写对。
  - 任务的 `drafts` 被清空，`destination` 和链初值（rollingSummary、伏笔）正确。
  - 外传 id 无效时什么都不写、任务不变（原子性）。
  - 第二次调用被拒绝。
  - 重名的 `newSide` 被拒绝。
  - `job.chapters` 的 `index` 是线内章号、`status` 为 `pending`、`translateStatus` 只有 `done` / `none`。
- `computeStats`：主线章数、`sideChapterCount`、字数含外传。
- `deleteNovel` 带走外传；快照导出和导入（replace / merge）包含外传。

**新增或改写：导入界面（`ImportScreen.test.tsx`）**

- 粘贴步骤没有「导入类型」控件。
- 改写全部既有用例，适配新流程：
  - 新增辅助函数 `confirmSplit(destination)`，原来点「确认并写入 N 章」的地方改为点「写入主线 N 章」。
  - 世界观的 10 个用例改为在分章页选「仅作为世界观设定」，再点「提取为世界观设定」。
  - 「粘贴步骤不显示编号提示」改为断言编号提示出现在 picker 里。
  - 「外文暂不支持翻译」的用例删掉，换成下面的新用例。
- 纯中文稿：分章页里就有 picker，默认是主线，步骤条里没有「翻译」和「导入到」。
- 外文稿：
  - 翻译期间和翻译之后 `listChapters` 都为 `[]`，`job.drafts` 里有译文和原文。
  - 中途卸载再重开，回到翻译步骤，已译章节不再请求。
  - 跳过剩下的章节后刷新，落在目的地步骤。
  - **有 1 章 `failed` 时**点「跳过剩下的」，刷新后仍落在目的地步骤；选主线后这一章按原文写入，`sourceContent` 为空。
  - 跳过全部待译章节后，步骤条仍显示「翻译」，目的地步骤有「返回翻译」，点了回到翻译页，数据不变。
  - 选主线后章节内容是译文，原文留底。
  - **截断**：mock 的翻译流最后一帧 `finish_reason: 'length'` 时，这一章变成 `failed`，`drafts[i].content` 还是原文、`sourceContent` 为空，alert 里有「译文超出单次输出上限被截断了」；译名表不合并这次的译名。
  - 分章页：超过 6000 字的外文草稿旁有 `role="note"`「这一章较长，单次翻译可能被截断…」；中文草稿和不超长的外文草稿没有。
  - **旧实例迟到写回**：翻译第 1 章时卸载（让 mock 的流挂起）→ 重开 → 在新实例里译完第 2 章 → 再让旧实例的第 1 章流完成：断言第 2 章的译文仍在、`translateStatus` 仍为 `done`，第 1 章按 `patchImportDrafts` 合并（或因请求已被 abort 而保持 `pending`），`drafts` 长度不变。
  - 卸载时进行中的翻译请求被 abort（断言 `fetch` 收到的 `signal.aborted` 为 true），这一章在库里仍是 `pending`、没有标成失败。
  - 翻译中在库里直接把任务提交成 main（模拟另一个标签页），本实例下一次写回被拒：界面不显示 alert，进入提取步骤，任务仍是 main、`drafts` 为空。
  - 翻译中在库里直接删掉任务（模拟另一处放弃），本实例下一次写回被拒：不新建任务行，界面回到粘贴步骤。
  - 另一处已有草稿任务时（直接 `saveImportDrafts` 写一份），本实例在分章页点主按钮：不覆盖，界面落到那份任务对应的步骤并显示「另一处已经有一批稿件在处理中」的 note。
- 提交失败与幂等：
  - commit 被拒（例如所选外传在别处被删）时留在目的地步骤显示 alert，`listChapters` 为 `[]`。
  - 模拟「另一处已写入」：先直接调一次 `commitImportChapters`，再在界面上点主按钮，界面进入提取步骤，不显示错误，章节只有一份。
  - 纯中文稿在分章页提交时 commit 失败：落到目的地步骤，步骤条出现「导入到」且带 `aria-current`；改选后重试成功。
- 不合阶段表的任务行（`destination: null` 而 `chapters` 非空）：面板清掉任务，回到粘贴步骤并显示说明，章节保留。
- **原始旧行不白屏**：用 `db.importJobs.put()` 直接写入**没有 `drafts` 键**的原始 main 行和 worldview 行（不经 `upsertImportJob`，否则 parse 会掩盖问题），渲染面板，断言落到提取步骤、「放弃这次导入」可用、点了能删掉任务。再写一条 parse 不过的行（如 `destination: { kind: 'bogus' }`），断言回到粘贴步骤并显示说明。
- 跨标签页：先直接调 `commitImportChapters`（main），再在界面上点「提取为世界观设定」，界面进入提取步骤、不显示错误，任务仍是 main，`listChapters` 不变。
- 外文稿选世界观：
  - 提取 prompt 里是中文译文，不是原文。
  - 全程 `listChapters` 为 `[]`。
  - 译名进了作品译名表。
  - 只有条目提案。
- 世界观打包：三个短章只发一次提取请求；一个超长章发多次请求，段标签里带章节标题。
- 外传：
  - 新建「青冥旧事」后，章节的 `sideStoryId` 正确、编号从 1 开始。
  - **新建外传后直接开始提取**：第 1 章的提取 prompt 里已有「本批正文是外传《青冥旧事》」，`note` 是「正在提取外传·青冥旧事 第 1 章…」（验证循环不读过期的 `sideStories` state）。
  - 提取途中在库里改外传简介，下一章的 prompt 用新简介；提取途中删掉外传，下一章标为失败「这部外传已不存在」或「章节已不存在」，不发请求，**循环停下**（之后的章节仍是 `pending`、没有被逐个标成失败），alert 里显示原因。
  - 提取途中外传被删但章节还在（用 mock 让 `getSideStory` 返回 `undefined`，章节不删）：只有当前这一章标为失败「这部外传已不存在，可能已被删除」，循环停下，alert 显示这句话。
  - commit 因「所选外传已不存在」被拒后：picker 的下拉框里不再有那部外传，选择回退到「新建外传」、名称为空。
  - 恢复到 `side` 任务（卸载重开）后接着提取，prompt 里仍有外传说明。
  - 摘要提案的标签带「外传·」。
  - 收尾时没有 `novel` 提案，只有 `sideStory` 提案；采用后外传进展更新，作品进展不变。
  - 文风勾选框默认不勾。
- 外传第二批：选已有外传后从 k+1 接续，提示文案正确；「连着导下一批」后 picker 预选上一批新建的那部外传；那部外传在此期间被删时，预选回退到「新建」。
- 外传提取：进度提示是「正在提取外传·X 第 N 章…」；外传简介为空时，提取 prompt 里没有空括号。
- 翻译续跑：译完第 1 章后卸载重开，第 2 章的翻译 prompt 里带第 1 章译文的结尾。
- picker 校验：名称为空、名称重复都会禁用主按钮；未配置模型时世界观按钮禁用。
- 放弃：在翻译步骤放弃，确认文案提到译文会被清空、没写章节；任务被删除。
- 旧任务：
  - 旧 worldview 行能接着提取。
  - 旧章节行有未完成翻译时，落在提取步骤并显示说明，不自动请求。
  - 空的旧行被清掉，进入粘贴步骤。
- 连着导下一批：外传跑完后显示外传版本的提示。
- 连着导下一批的章数：提取途中卸载重开（分章页本地 `drafts` 已丢）后跑完 3 章，提示里是「上一批 3 章」而不是 0；主线同理。
- `importEntry.test.tsx`：从书架新建作品进入导入的流程保持通过（只改按钮文案）。

**新增或改写：写作、导出、书架**

- `WritingPage.test.tsx`：
  - 新建外传后写一章：章节出现在外传卡片里，不在主线列表里。
  - 「全书进度」不含外传字数。
  - 卡片显示章数和字数。
  - 删除外传要二次确认，确认后级联删除。
  - 空作品也有外传区块。
- `ChapterEditor.test.tsx`：外传章节的标题行和 aria-label 带「外传·X 第 N 章」；生成面板的注入清单里有外传说明块，没有主线进展；打开开关后出现主线进展。
- `ChapterSummarySheet.test.tsx`：
  - 外传章节产出 `chapterSummary` + `sideStory` 两条提案；prompt 用的是外传进展；伏笔只承接本外传。
  - **autoStart 读最新值**：props 上的 `sideStory.rollingSummary` 是旧值、库里已更新，以 `autoStart` 打开后，发出的 prompt 和提案的 `current` 都是库里的新值。
  - 外传已被删除时，以 `autoStart` 打开进入错误态，显示「这部外传已不存在」，不发请求。
  - **不传 `sideStory` 属性**的外传章节，产出的仍是 `chapterSummary` + `sideStory` 两条提案，没有 `novel` 提案。
- `ExportSheet.test.tsx`：全书默认不含外传；打开「附带外传」后包含；可以单独导出一部外传；单章下拉框里有外传章节；只有外传的作品打开面板时默认范围是「外传」。
- `WritingPage.test.tsx` 追加：只有外传章节的作品也显示「导出」按钮；从外传卡片打开的编辑器拿到了对应的 `sideStory`。
- `ShelfPage.test.tsx`：有外传时显示「外传 K 章」，总字数含外传。
- `GlossarySheet.test.tsx`：外传章节在不一致清单里显示「外传·X 第 N 章」，点击后能打开对应编辑器（`glossaryJump.test.tsx` 增加一条用例）。

**回归**：1023 个既有测试按上面的说明改写后全部通过。`npm run build` 通过。

---

## 12. 对这份设计的说明

- 用户原话「世界观设定也可能是以故事的形式」决定了两件事：目的地放在翻译之后选；世界观提取以分章结果为单位（4.5），而不是退回整篇按段落切。
- 有两项改动超出了字面需求，都是重写时顺带补上的缺口，可以单独撤掉、不影响其他设计：
  - 主线第二批导入时，伏笔改为从主线最后一份摘要接续（4.4 第 4 步），第一批导入的行为不变。
  - 翻译续跑时从上一个已译草稿恢复译文结尾（4.3「续跑时的衔接」）。
- 首轮复核补充（设计评审之前，对照代码复核后的修订）：修正了 1.4 / 1.5 / 4.2 里指错的章节编号，6.5 / 6.6 按 (e)(f) 顺序排列；写明「track 字段」由 `sideStoryId` 承担；补上 `getSideStory`（读最新外传进展），以及 `updateChapter` 对 `sideStoryId`（剥掉）和 `outlineNodeId`（抛错）的不同处理和理由；说明摘要系统提示保持不变时外传怎么收窄范围；补上「连着导下一批」时预选目的地。已核实的现状：Dexie 当前是 v4，`[novelId+index]` 不是唯一索引；`ImportJob` 现有 `importType` / `worldviewText` 两个字段；文风取样只取本批章节；既有测试 1023 个，全部通过。

---

## 13. 对设计评审的回应（第 1 轮，CHANGES_REQUESTED：MEDIUM 4、NIT 12）

全部 16 条都已采纳，没有 backlog 或驳回的。已接受的内容一处没删，只是补充或收窄。

| #   | 级别   | 处理                                                                                                                                                                                                                                                                                                              | 落在哪里           |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | MEDIUM | 采纳。`goToDestination` 把 `pending` 和 `failed` 一并改成 `none`，清空 `translateError`；失败章按原文处理。补充说明这个按钮在翻译运行时本来就不渲染（现有代码就是这样），避免进行中的一章在提交后才写回草稿                                                                                                       | 4.3、11            |
| 2   | MEDIUM | 采纳推荐方案 A：reject 后重读任务，`destination !== null` 就进入提取、不报错，不导出专门的错误类                                                                                                                                                                                                                  | 9、7、11           |
| 3   | MEDIUM | 采纳，并多加一层：`upgradeLegacyImportJob` 是全函数（非对象原样返回、`Array.isArray` 兜底、`!== undefined` 判断、返回新对象、不调 Zod）；upgrade 回调另包一层逐行 `try/catch`，失败的行保持原样，由 `resumeStepOf` 当作不合阶段表清掉。评审没要求第二层，但它的代价只是丢一行导入进度，换来的是全库不会因此打不开 | 3.3、4.6、9、7、11 |
| 4   | MEDIUM | 采纳：在 `generateRef` 内部、`runStructured` 之前 `await getSideStory`；读不到时进入错误态；`sideStory` 属性不再提供 `rollingSummary`                                                                                                                                                                             | 5.3、11            |
| 5   | NIT    | 采纳：「导入到」在 `hasForeign \|\| step === 'destination'` 时出现。顺带把 `hasForeign` 定义成按正文语种算，否则「跳过」之后翻译步骤会从步骤条上消失                                                                                                                                                              | 4.1                |
| 6   | NIT    | 采纳：`FinishedDestination` 判别联合；id 失效时回退「新建」                                                                                                                                                                                                                                                       | 4.8、11            |
| 7   | NIT    | 采纳：`rolling-side` / `rolling-main` / `sideStory:{id}`，并补上外传摘要和结尾的标签                                                                                                                                                                                                                              | 5.2、11            |
| 8   | NIT    | 采纳：按拼接后的最终文本计长；空标题不造「（i/k）」，跨章时只取非空标题                                                                                                                                                                                                                                           | 4.5、11            |
| 9   | NIT    | 采纳：改正 3.5 的描述（旧应用会拒绝，但文案可能是通用解析错误）；新版 `parseBackup` 先查文件头再整份解析                                                                                                                                                                                                          | 3.5、8、11         |
| 10  | NIT    | 采纳：superRefine 加「外传属于同一作品」和「外传章节不关联大纲」两条检查                                                                                                                                                                                                                                          | 3.1、8、11         |
| 11  | NIT    | 采纳：写全 `job.chapters` 的映射；`extractOne` 的回退改成 `?? ''`，没有改成提前返回，这样不改变现有控制流，改动最小                                                                                                                                                                                               | 4.4、11            |
| 12  | NIT    | 采纳：`renderSideStoryBrief` 统一处理，简介为空就省略简介行和括号                                                                                                                                                                                                                                                 | 5.2、5.7、11       |
| 13  | NIT    | 采纳：WritingPage → 编辑器的 `sideStory` 接线（含译名跳转）；ImportScreen 加载 `listSideStories` 并按线计数传给 picker；删掉 GlossarySheet 本地的 `chapterLabel`，保留「第 N 章 标题」的显示样子                                                                                                                  | 4.2、5.4           |
| 14  | NIT    | 采纳：写明分章页主按钮的两步调用、第二步失败时落到目的地步骤；`createDraftJob` 遇到已提交的任务时抛错；外文稿的目的地步骤提供「返回翻译」，纯中文稿不提供（理由见 4.1）                                                                                                                                           | 4.1、4.3、11       |
| 15  | NIT    | 采纳：导出按钮按全量章节显示；外传单章的标题和文件名用 `chapterLabel`；另外把只有外传的作品打开导出面板时的默认范围定为「外传」                                                                                                                                                                                   | 5.4、5.6、11       |
| 16  | NIT    | 采纳：阶段表由三个写入点保证，不靠 schema；`resumeStepOf` 对不合表格的组合返回 `'discard'`，并给出说明（旧版空任务除外，静默清掉）                                                                                                                                                                                | 3.2、4.6、7、11    |

评审列出的「未核实的假设」：

- 单行几 MB 的 `put` 加 Zod parse 的耗时：仍未实测，不阻塞，本次不加性能测试（fake-indexeddb 的耗时说明不了真实浏览器）。如果真实使用中翻译每章落盘明显卡顿，退路是 3.2 里比较过的独立 `importDrafts` 表，数据模型的其他部分不用动。
- 外传摘要只在用户提示里收窄范围：仍是对模型行为的推断，兜底不变（产出只是提案，`current` 对比可见）。
- 开放问题 a–f 的编号：沿用本文 6.1–6.6 的标注，对应关系是 a 多部外传、b 摘要、c 上下文、d 字数、e 导出、f 反向提取。

---

## 14. 对设计评审的回应（第 2 轮，CHANGES_REQUESTED：HIGH 1、MEDIUM 2、NIT 5）

8 条全部采纳，没有 backlog 或驳回的。已接受的内容没删，只补充或收窄；被替换的只有与发现直接冲突的几句（世界观转换走 `persistJob`、「v5 迁移不给 main / worldview 行补 drafts」、「世界观素材」标签、`chunk.text`、`'discard'` 单值返回）。

| #   | 级别   | 处理                                                                                                                                                                                                                                                                                                                                            | 落在哪里                              |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | HIGH   | 采纳 (a)(b)(c)。`upgradeLegacyImportJob` 每个分支都补齐五个数组键；面板加载先 `ImportJobSchema.safeParse`，失败按 `notice` 清掉；`jobRef` / `job` 里只放 parse 过的对象。另加一点：`saveImportDrafts` 读到 parse 不过的残留行时视同无任务、直接覆盖，避免 `deleteImportJob` 失败后坏行挡住下一次导入                                            | 3.3、4.6、7、8、9、11、验收 10b       |
| 2   | MEDIUM | 采纳。`sideStoryRef` + 只用于渲染的 `activeSideStory`，经 `rememberSideStory` 一起写；`commitImportChapters` 在 side / newSide 时返回非 null；`extractOne` 每章、`finalize` 开头都 `getSideStory` 重读，读不到就标失败或跳过进展提案；循环内不读 `sideStories` state。补了「新建后直接提取」「提取中改简介 / 删外传」「恢复 side 任务」三条测试 | 4.2、4.4、4.8、9、11                  |
| 3   | MEDIUM | 采纳。新增 `saveImportDrafts` / `commitImportWorldview`，都只锁 `importJobs`，与 `commitImportChapters` 同样在事务里检查 `destination !== null`；被拒后同样重读任务。`resumeStepOf` 的 `bad` 判定覆盖表里所有「该空不空、该有没有」的组合。`saveImportDrafts` 被拒时多显示一条 note，因为那次的分章结果没存下来，不能悄悄丢                     | 3.2、4.3、4.4、4.6、7、9、11、验收 10 |
| 4   | NIT    | 采纳。`ResumeResult = { step } \| { discard: 'silent' \| 'notice' }`，只有 null + 三个数组都空是 `silent`；第 9 节拆成两行                                                                                                                                                                                                                      | 4.6、9、11                            |
| 5   | NIT    | 采纳。写定 `packWorldviewChunks` 签名与返回形状；`sourceLabel` 改回「世界观设定」前缀，无标题时与现有代码逐字一致；测试改为 `chunk.content.length ≤ max`                                                                                                                                                                                        | 4.5、11                               |
| 6   | NIT    | 采纳。`sideStoryTitleKey` 是唯一比较键，picker、`createSideStory`、`updateSideStory`（排除自身）、`newSide` 共用                                                                                                                                                                                                                                | 3.4、4.2、4.4、5.1、7、8、11          |
| 7   | NIT    | 采纳。摘要面板按 `data.chapter.sideStoryId` 分支，属性只用于展示；构建器在找不到外传时仍按 track 过滤、不拿主线进展顶替（用户打开「参考主线进展」时仍照常注入，那是明确选择）                                                                                                                                                                   | 5.2、5.3、7、11                       |
| 8   | NIT    | 采纳。5.1 写全外传五个方法和三个导入阶段写入的签名，写明受保护字段（`id` / `novelId` / `order` / `createdAt` 在仓储剥掉）和 `deleteSideStory` 幂等                                                                                                                                                                                              | 4.4、5.1                              |

评审列出的未核实假设，处理同第 1 轮（第 13 节末尾），没有新变化。

---

## 15. 对设计评审的回应（第 3 轮，CHANGES_REQUESTED：MEDIUM 2、NIT 6）—— 定稿

8 条全部采纳，没有驳回。已接受的内容没删，只补充或按评审修正；被替换的只有与发现直接冲突的几句：3.2「其他写入点经 `persistJob`……翻译循环只改 `drafts[i]`」、4.4「`markChapter` 并返回」、4.6「最坏情况是用户要对这一批重新提取」、第 9 节外传被删那一行的控制流描述、11 节「拼接后去掉空白，内容与原文一致」。本轮之后设计定稿，不再进评审循环。

| #   | 级别   | 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 落在哪里                                        |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | MEDIUM | 采纳。新增 `patchImportDrafts(novelId, patches)`，只开 `importJobs` 的 `rw` 事务、按 `index` 合并到库里最新那一行：任务不存在、parse 失败或 `destination !== null` 时抛「这批稿件已经不在翻译阶段了」且不新建行；index 找不到就抛错、整批回滚；`done` 草稿忽略降级和 `content` 改写；写入前过 `ImportJobSchema.parse`。`translateOne` / `markTranslate` / `toggleTranslate` / `retryTranslate` / `goToDestination`（一次传多条）全部改用它；被拒时静默停下，`getImportJob` 重读后按 4.6 重新定步骤。卸载时 `abort()` 进行中的翻译请求（每章新建 `AbortController`，abort 错误不标失败）。4.6 的「最坏情况」改成如实描述：章节保留，这一批的条目与摘要要靠重新导入或手动整理。新增两条不变量：`done` 草稿不可降级、阶段表成立的前提是草稿写入不交给 `persistJob` | 3.2、4.3、4.4、4.6、5.1、7、9、10、11、验收 10c |
| 2   | MEDIUM | 采纳方案 A。`ChatResult.finishReason: string \| null`（必填，漏写时 `tsc` 报错）：流式取流中最后一个**非空**值（避免末尾只带 `usage` 的帧把 `'length'` 冲掉，这是对「取最后一帧」的落地写法），非流式取 `choices` 最后一项。`translateOne` 遇到 `'length'` 抛 `LlmError('parse', '译文超出单次输出上限被截断了', '这一章太长，回到分章页把它切小一些再译')`，标为 `failed`、不写回草稿、不合并译名。分章页对超过 `TRANSLATE_SOFT_LIMIT = 6000` 字的外文草稿显示 `role="note"`。不选 B（切段逐段翻译）：要改草稿模型和续跑逻辑，而用户在分章页就能绕开                                                                                                                                                                                                           | 4.1、4.3、4.9（新）、7、8、9、10、11、验收 10d  |
| 3   | NIT    | 采纳。外传读不到时 `extractOne` 抛 `Error('这部外传已不存在，可能已被删除')`，由 `runLoop` 的 catch 统一标失败、`setError`、停下                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 4.4、9、11                                      |
| 4   | NIT    | 采纳。commit 被拒且重读后 `destination` 仍为 null 时，重新加载 `listChapters` + `listSideStories`、重算 `lineCounts`；所选外传已不在列表里就回退到「新建外传」、名称留空                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 9、11                                           |
| 5   | NIT    | 采纳。超长章切出的各段正文不带标题行，标题只在 `chunk.title` 里、经 `sourceLabel` 进 prompt；判超长时仍计入标题行。测试描述按评审改写                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 4.5、11                                         |
| 6   | NIT    | 采纳。`saveImportDrafts` 加 `expectedJobId`：库里 parse 成功、`destination === null` 且 `id !== expectedJobId` 时抛「另一处已经有一批稿件在处理中」；分章页传 `jobRef.current?.id ?? null`；parse 失败的残留行仍直接覆盖；界面处理与「已有 `destination !== null`」那一行相同                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 4.3、4.4、7、9、11                              |
| 7   | NIT    | 采纳。`FinishedDestination` 的 main / side 两支带 `count`，`finalize` 里取 `current.chapters.length`，`continueImport` 用它代替 `drafts.length`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 4.4、4.8、11                                    |
| 8   | NIT    | 采纳。3.3 补上 `sideStories!: Table<SideStory, string>` 和 `SideStory` 的类型导入，v5 注释写明加表和建 `sideStoryId` 索引的理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 3.3、10                                         |

本轮新增的 backlog（不在本次范围内，理由已写在正文）：

- 编辑器里的整章「译成中文」也检查 `finishReason === 'length'`（4.9）。那里译文要用户采用才替换、原文留底、可撤销，不会静默丢内容，所以不急。
- 结构化输出检查 `finishReason`（4.9）。截断的 JSON 过不了 Zod，会走现有的修复重试。

评审列出的未核实假设：单行几 MB 的 `put` 耗时、外传摘要靠用户提示收窄范围，处理同第 1 轮。「各服务商默认输出上限」不影响方案：截断检测只依赖 `finish_reason`，不依赖具体数值；服务商不回传时 `finishReason` 为 null，按未截断处理，和现在的行为一样，分章页的事前提示仍然有效。
