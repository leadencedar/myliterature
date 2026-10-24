# 导入目的地后置到翻译之后，新增独立于主线的外传（第 2 轮评审）

> 评审时间：2026-10-09 18:57。项目不是 git 仓库。按修改时间筛，上一轮评审（18:35）之后只改了 `sideStory.ts`、`sideStory.test.ts`、`ImportScreen.tsx`、`ImportScreen.destination.test.tsx`、`docs/开发计划.md`，和 fix-log 第 2 轮一致。

导入统一走 粘贴 → 分章 →（有外文时）翻译 → 导入到 → 提取，目的地三选一：主线章节、外传、仅作为世界观设定。外传用 `chapters.sideStoryId` 区分，各自编号、各自一条摘要链。用户的三点要求都已落地：导入内容可以作为世界观设定或章节；世界观先翻译，译完再选「仅作为世界观设定」；导入时可以「作为外传导入」。上一轮的 2 条 MEDIUM、3 条 NIT 都已修掉，每条都有对应用例。

Watch for：草稿写入失败后，如果重读任务也失败，界面会静默回到粘贴步骤，存储错误的提示在这条路径上依然没有（confirmed，NIT）。跨标签页时，目的地提交不核对任务 id，可能把另一处刚分好的一批稿件按本页的选择写入（likely，NIT）。

**Verdict**: APPROVED

## High-level view

`npm run build`（`tsc --noEmit && vite build`）通过，只有原来就有的 chunk > 500 kB 提示。`npx vitest --run` 连跑 6 次，每次 53 文件 / 1268 测试全绿。原来不稳定的两处（`:360`、`:1316`）已改成 `await findByRole`。

`DraftsRejectedError` 现在带上写入前的任务 id。`resumeAfterRejection` 重读后，库里如果还是同一批草稿，就判定为存储本身的问题，五个入口（译文写回、标记失败、勾选、重试、跳过剩下的）都会弹 alert。别处提交或放弃时仍然静默。剩下的缺口是重读本身失败的情况：这时它被当成「任务不在」，静默落到粘贴步骤。

勾选连点改用 `requestedTranslateRef` 记录最近一次点击要的值，没有用 `event.target.checked`。fix-log 里给了理由：受控复选框在写入返回之前一直停在旧值。两次写入的先后由 `patchImportDrafts` 同步开启的 `rw` 事务保证。commit 被拒后，任务已不在时回到粘贴步骤并给出说明；`TITLE_PREFIX` 要求前缀后面跟分隔符或就此结束。

目的地提交仍然只认「库里那一行」，跟 `saveImportDrafts` 的 `expectedJobId` 检查不对称。这是定稿设计没覆盖到的跨标签页情形，严重程度够不上阻塞。

范围外的 `DiagnosticsSection.tsx`、`diagnostics.ts`、`useActiveNovel.ts` 没有改动。依据是修改时间：三个文件都停在 10-08 16:18–16:19，早于任务目录创建（10-09 08:59）。

<details>
<summary>Issues (2)</summary>

1. **NIT · 草稿写入失败且重读也失败时，静默落到粘贴步骤** — 位置：`src/features/import/ImportScreen.tsx` 的 `resumeAfterRejection`（`getImportJob` 的 catch 分支）。问题：重读抛错时按 `raw = undefined` 处理，`resumeFrom(undefined)` 回到粘贴步骤并返回 false，所有调用方都不弹 alert，而草稿其实还在库里。同样的情形，`handleCommitRejected` 是单独处理的。修法：重读抛错时不调 `resumeFrom`，留在当前步骤并返回 true，让调用方照常显示「…没存上：{msg}。浏览器存储可能已满…」。补一条用例：`patchImportDrafts` 和 `getImportJob` 各 reject 一次，断言出现 alert、仍停在翻译步骤。
2. **NIT · 目的地提交不核对任务 id（跨标签页）** — 位置：`src/data/dexie/DexieNovelRepository.ts` 的 `requireDraftJob` / `commitImportChapters` / `commitImportWorldview`，`ImportScreen.tsx` 的 `commitDestination`。问题：A 页停在目的地步骤时，B 页放弃这批稿件、又分章存了一批新的。A 再点写入，主线和外传分支会把 B 的草稿（含待译章节）按 A 的选择写成章节。世界观分支会用 A 手里过期的草稿打包，写到 B 的任务行上，同时清空 B 的 `drafts`，B 已经译好的章节就丢了。修法：两个 commit 方法和 `saveImportDrafts` 一样接收 `expectedJobId`，事务里遇到 `job.id !== expectedJobId` 就抛错。界面传 `jobRef.current.id`，被拒后走现有的 `handleCommitRejected`。需要两个标签页配合才会触发，可以进 backlog。

</details>

<details>
<summary>Details</summary>

### 重读失败时，存储错误提示又没了

```ts
// ImportScreen.tsx · resumeAfterRejection
try {
  raw = await repository.getImportJob(novel.id);
} catch {
  raw = undefined;          // 读不出来，和「任务已被放弃」走同一条路
}
...
const restored = await resumeFrom(raw);   // raw 为空 → adoptJob(null)、setStep('paste')、返回 null
return aliveRef.current && restored !== null && ...;   // → false，调用方不弹 alert
```

上一轮那条 MEDIUM 已经覆盖了配额满的情况。但 IndexedDB 整体出问题时（事务中止、连接被浏览器关掉），写和读往往一起失败，这条路径仍然没有任何提示（confirmed，从代码读出）。用户看到的是翻译页突然跳回粘贴页。那批付过钱的草稿其实还在库里，等下次重新粘贴、分章时，会被「另一处已经有一批稿件在处理中」挡住，而这句提示把原因说错了。设计第 9 节「读不到也按粘贴步骤」，前提是被拒的原因只有并发。现在既然要区分存储错误，重读失败就该归到「不知道库里是什么状态」，和 `handleCommitRejected` 一样处理：留在当前步骤，显示原始错误。

### 目的地提交认的是「库里那一行」，不是「我看到的那一批」

`requireDraftJob` 只检查三件事：任务存在、`destination === null`、`drafts` 非空。它不看 id（confirmed）。

```
标签页 A：分章 J1 → 翻译 → 停在「导入到」
标签页 B：打开同一部作品 → 放弃 J1 → 粘贴新稿 → saveImportDrafts(expectedJobId: null) 成功，生成 J2
标签页 A：点写入
          主线 / 外传：commitImportChapters 读到 J2，把 J2 的 drafts 按 A 的目的地写成章节
          世界观：     commitImportWorldview 用 A 手里 J1 的 drafts 打包 chunks，写到 J2 的行上，J2 的 drafts 清空
标签页 B：下一次 patchImportDrafts 被拒（destination !== null），静默重读，进入提取步骤
```

后果是 B 这一批写到哪里由 A 决定，B 里还没译的章节按原文写入。走世界观分支的话，B 已经付费译好的草稿直接被清掉，提取的却是 J1 的内容。B 那边没有任何提示（likely，按代码推演，没有写用例复现）。`saveImportDrafts` 已经用 `expectedJobId` 守住了「分章页不悄悄冲掉别处的草稿」，目的地提交是另一个会悄悄动到别处草稿的入口，用同一个机制就能补上。这需要多个标签页交错操作才会出现，所以评为 NIT。

</details>

<details>
<summary>文件清单</summary>

本轮（18:35 之后）改动的文件：

- `src/features/import/ImportScreen.tsx`：`DraftsRejectedError` 带 `jobId`；`resumeAfterRejection` 返回「是否仍是同一批草稿」，五个入口按它显示 alert；`handleCommitRejected` 区分「任务不在 / 坏行 / 读取抛错」三种情况；`requestedTranslateRef` 处理勾选连点
- `src/features/import/ImportScreen.destination.test.tsx`：两处改为 `findByRole`；新增五条用例：译文写回失败、勾选写入失败、连点两下、commit 被拒后任务已放弃、commit 被拒且重读失败
- `src/domain/sideStory.ts`：`TITLE_PREFIX` 要求前缀后跟分隔符或就此结束
- `src/domain/sideStory.test.ts`：「番外篇」「外传之谜」原样保留；只填前缀时归一化为空
- `docs/开发计划.md`：更新被拒时的处理说明，测试数改为 1268

整个任务的改动范围以 design.md 第 10 节为准，上一轮的文件清单仍然适用。项目没有 git，拿不到完整 diff。

</details>
