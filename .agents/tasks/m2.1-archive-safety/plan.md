# 实施计划 · M2.1

- [x] S1（dev-infra）`archiveChapter` 返回 pendingTotal/threads + `archiveAudit.ts` + 测试。
- [x] S2（dev-feature）ProposalReview/ProposalInbox 初始忽略 + 安全提示；ArchiveInboxSheet 流水展示；ChapterEditor 计数；测试。
- [x] S3（QA）独立验证 + 沙盒加「含 merge 的归档批次」截图 + 全量门禁。
- [x] S4（Lead）文档同步 + 提交；文学顾问快速确认安全文案。

## 实施结果（2026-10-28）

- S1/S2/S2b 完成；安全默认收窄为「只跳过已有知识条目的合并/替换」，摘要与进展 replace 默认选中。
- QA 默认并行 118 文件 / 2366 tests 通过 + 1 skip，串行同绿；typecheck/build 通过；m2 套件 74 例；沙盒 m2.1-01/02/03。
- 文学顾问复核：敢点采用、悬疑 P0 解决、无 P1；P2 文案（恢复后提示动态化、无历史伏笔明细重复、计数差 1）留 M3。
- 零迁移：Dexie v7 / 备份 v4 未变。
