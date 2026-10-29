# PC 端真实浏览器验收

```bash
PC_LLM_KEY=sk-xxx node .agents/tasks/outline-context-scene/ux/pc-acceptance/run.mjs
```

- Key 只从环境变量读取，不写入脚本/报告/截图；脚本自带 dev server 启停（:5173）。
- 桌面 1440×900，真实模型 `deepseek-chat`，共 4 次真实调用：连通性、整章生成、归档提取、文风检查。
- 产物：`report.md`、`transcript.txt`、`pc-01…pc-06.png`。
- 不采用生成稿、不落新正文；归档只产生待确认提案，未采用。
- 生成章节为第 2 章，锚点来自种子第 1 章；文风检查在第 1 章（第一章无锚点，属正确提示）。
