# 长文分段翻译：用户确认的范围

确认日期：2026-10-24。

依据调查报告 `/Users/leadencedar/Production/Project/MyLiterature/.agents/tasks/chunked-translation-investigation/report.md`：

1. 世界观原文第一期不新增永久素材库。只保证导入翻译与提取期间完整保留；主线/外传仍通过 Chapter.sourceContent 永久留底。
2. **覆盖调查报告原先“章节编辑器完整分段后置”的建议：本期必须同时把章节编辑器的单章翻译改为完整的自动分段翻译。** 应共享导入链路的切分、完整性校验、失败段二分、译名同步和恢复逻辑，不得只增加 `finishReason === 'length'` 拒绝。
3. 章节编辑器分段翻译也应保存已付费完成的分段进度，关闭面板、刷新页面后能够恢复；章节正文只有在用户最终采用完整译文时才修改。
