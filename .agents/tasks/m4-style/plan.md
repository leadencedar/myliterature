# 实施计划 · M4

- [x] S1（dev-infra）`styleAnchor.ts` 选择函数 + ContextBuilder 注入 + 基线/测试。
- [x] S2（dev-feature）`style-check` 任务配置 + `styleCheck.ts` 服务 + `StyleCheckSheet` UI + 测试。
- [x] S3（QA）独立验证 + 沙盒 M4 截图（锚点注入清单、文风检查结果）+ 全量门禁。
- [x] S4（literary）作者视角复核（锚点是否够、诊断是否越界）。
- [x] S5（Lead）文档同步（Task 23/产品/使用说明）+ 提交。

## 实施结果（2026-10-29）

- S1/S2 完成；P1（basis + 中性 severity + 面板分工句）已按顾问建议提交前修复。
- QA：默认/串行 130 文件 / 2528 tests 通过 + 5 skipped；typecheck/build；m4 26 例；沙盒 m4-01/02。
- 真实模型 live D：5 条 issue、5/5 excerpt 逐字命中、basis/suggestion 非空、无严重警告。
- 文学顾问：M4 信息与流程成立；P1 已修，剩余 P2（换锚点/含对话/成本）与真机项。
