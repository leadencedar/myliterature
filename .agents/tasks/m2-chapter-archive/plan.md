# 实施计划 · M2

## 步骤

- [x] S1 `archiveBatch.ts` + `archiveSettings.ts` + 测试（纯函数/存储/默认值）。
- [x] S2 `archiveChapter.ts` + 测试（一次调用、摘要/进展/条目、pending 合并、幂等、上限、人物豁免、失败）。
- [x] S3 编辑器接线：后台归档状态行、查看本批 inbox、大纲节点完成提示、设置开关；组件测试。
- [x] S4 GenerateChapterSheet 差额 + 继续补写；组件测试（请求体 history/剩余字数、追加、不自动）。
- [x] S5 SettingsPage「写作辅助」开关与成本说明；组件测试。
- [x] S6 QA 独立验证 + 沙盒扩展（mock extract-settings 响应），全量门禁；文学顾问复核文案。
- [x] S7 文档：使用说明/产品文档/开发计划 Task 21，提交。

## 验证命令

`npx vitest run <本范围>`、`npm run typecheck`、`npm run test:run`、`npm run build`；沙盒 `node .agents/tasks/outline-context-scene/ux/run-demo.mjs`（扩展归档场景）。

## 依赖

S1 → S2 → S3/S5；S4 独立。S6 在开发停手后。

---

## 实施结果（2026-10-27）

- S1–S5 全部完成；QA 独立验证通过（默认并行 ×3：115 文件 / 2319 tests；串行同绿；typecheck/build 通过）。
- QA 独立套件 `src/test/m2/**` 48 用例；真浏览器沙盒 m2 截图 9 张；文学顾问复核确认可进 M3。
- P1 龙套门槛（归档 prompt）与文案（「还有场景没落地？」/「本章摘要与设定」）已落地；剩余 P2 文案与真机项见开发计划 Task 21。
- 零迁移：Dexie v7 / 备份 v4 未变。
