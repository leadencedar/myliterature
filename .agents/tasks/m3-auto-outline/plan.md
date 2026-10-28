# 实施计划 · M3

- [x] S1（dev-infra）`backfillOutline.ts` + `commitOutlineBackfill` 仓储事务 + 测试。
- [x] S2（dev-feature）`OutlineBackfillSheet` + WritingPage 空大纲入口 + 测试。
- [x] S3（dev-infra）`outline-continue` 任务配置 + `outlineContinue.ts` prompt/schema/合成 + 测试。
- [x] S4（dev-feature）`OutlineContinueSheet` + WritingPage 入口 + ProposalInbox 接线 + 测试。
- [x] S5（QA）独立验证 + 沙盒 m3 截图（回溯/续写/采用/重复执行）+ 全量门禁。
- [x] S6（literary）作者视角复核自动大纲的边界与文案。
- [x] S7（Lead）文档同步（Task 22/产品/使用说明）+ 提交。

## 实施结果（2026-10-28）

- S1–S4 完成；回溯 targetWords 改为 null、预览加「现有字数仅参考」；续写入口/文案改「规划后续 3–5 章大纲」+「仅生成大纲提案，不写正文」，提案上方加「续写细目」四要素。
- QA：默认并行/串行 124 文件 / 2445 tests 通过 + 1 skip；typecheck/build 通过；m3 独立 37 例；沙盒 m3-01..05；页面异常 0。
- 文学顾问：P1 两处闭环，无新问题；P2（采用按钮去重、三入口说明）留 M3.1；真机抽检红线遵守度。
- 零迁移：Dexie v7 / 备份 v4 未变。
