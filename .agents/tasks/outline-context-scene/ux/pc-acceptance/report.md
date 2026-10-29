# PC 端真实浏览器验收（1440×900）

- 运行时间：2026-10-29T06:52:11.803Z
- 模型：deepseek-chat（真实 Key 仅环境变量，未写入文件/报告）
- 结果：8/8 通过

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| 默认模型为 deepseek-chat | ✅ | deepseek-chat / deepseek-chat |
| 真实模型连通性测试 | ✅ | 31345ms ✓ 输入 33 token · 输出 13 token |
| 写作页 1440 无横向溢出 | ✅ | {"doc":1440,"body":1440,"inner":1440} |
| 生成面板显示文风锚点 | ✅ |  |
| 真实模型整章生成完成 | ✅ | 8335ms 结果含提示 |
| 标记完成后真实归档 | ✅ | 34038ms 本章摘要与设定已生成：5 项待确认（含摘要、进展、条目） |
| 真实模型文风检查完成 | ✅ | 27501ms |
| 无 console/page 错误 | ✅ |  |

## 截图
- `pc-01-settings.png`
- `pc-02-writing.png`
- `pc-03-generate-form.png`
- `pc-04-generate-result.png`
- `pc-05-archive.png`
- `pc-06-style-check.png`

## 说明
- 真实 API 调用：连通性 1 次、整章生成 1 次、归档提取 1 次、文风检查 1 次（共 4 次）。
- 不采用生成稿、不落新正文；归档只产生待确认提案，未采用。
## 失败项
无
