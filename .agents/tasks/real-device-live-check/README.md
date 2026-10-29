# 真实模型抽检（Live Model Check）

`src/test/live/liveModelCheck.test.ts` 用**生产 prompt 与 schema** 直连真实模型，
回答上线前必须知道的三个问题：结构化输出是否稳定、实际耗时/token 成本、质量指标量级。

覆盖四个链路（固定 **4 次真实调用**）：

| 检查 | 任务               | 内容                                                    |
| ---- | ------------------ | ------------------------------------------------------- |
| A    | `extract-settings` | 归档提取：约 1400 字中文正文 → 摘要 + 知识库条目        |
| B    | `outline-continue` | 前沿大纲：既有大纲 → 后续 3 章（含场景/冲突/钩子/伏笔） |
| C    | `chapter-draft`    | 整章生成：大纲节点 → 流式生成 1200 字正文               |
| D    | `style-check`      | 文风检查：第 3 章正文 + 第 1 章锚点 → 最多 5 条漂移诊断 |

## 如何设置 Key

```bash
# 只在这个终端会话里导出，别写进 shell 配置（见下方「费用与误触发」）
export REAL_LLM_API_KEY=sk-xxx
```

也兼容 `DEEPSEEK_API_KEY`（二者取其一，`REAL_LLM_API_KEY` 优先）。

可选覆盖（默认取应用内 DeepSeek 预置）：

| 变量                    | 默认值                          | 说明                                      |
| ----------------------- | ------------------------------- | ----------------------------------------- |
| `REAL_LLM_BASE_URL`     | 预置 `https://api.deepseek.com` | OpenAI 兼容端点                           |
| `REAL_LLM_MODEL`        | 预置 `deepseek-chat`            | A / C 使用的常规模型                      |
| `REAL_LLM_STRONG_MODEL` | 预置 `deepseek-chat`            | B / D（生产用强模型的任务）               |
| `LIVE_TARGET_WORDS`     | `1200`                          | C 整章生成目标字数（可设 3000/6000 复测） |

> 应用 DeepSeek 预置已改为官方 `deepseek-chat`（常规与重点任务同模型）；如需用其他模型，再显式覆盖 `REAL_LLM_MODEL` / `REAL_LLM_STRONG_MODEL`。

## 如何运行

```bash
npm run test:live
```

- **没有 Key 时全部 skip**（退出码 0）：常规 `npm test` / `npm run test:run` 不依赖 Key，
  也不会产生任何费用。
- 每个检查有独立超时（A/B/D 180s、C 240s）；失败会打印原始错误，报告里也有记录（失败项不写 metrics，但 ok/error 会留下）。

## 如何读报告

结果写入 **`analysis/live-model-report.json`**（每次运行覆盖；该文件不提交）：

```jsonc
{
  "generatedAt": "…",
  "model": "…",
  "strongModel": "…",
  "baseUrl": "…",
  "checks": [
    {
      "name": "archive-extract", // archive-extract / frontier-outline / chapter-draft-1200 / style-check
      "ok": true,
      "durationMs": 12345,
      "usage": { "promptTokens": 0, "completionTokens": 0 }, // provider 回传时才有
      "metrics": { "entryCount": 4, "loongTongViolations": [], "…": "…" },
      "sample": "节选 400 字…",
      "error": "失败原因（ok=false 时）",
    },
  ],
}
```

重点指标：

- **A 归档提取**：`entryTitles`、`summaryChars`、`newThreads/resolvedThreads`、
  `loongTongViolations`（职务龙套被建人物条目的候选，需人工复核）。
- **B 前沿大纲**：每章 `sceneCount`（应为 3–5）、`conflict`、`hook`、
  `resolvesFromOpenThreads`（是否点名收束了现存伏笔）、`chapterCount`（应为 3–5）。
- **C 整章**：`charCount/wordCount`、`ratioToTarget`、`shortfallBelow85`、`finishReason`。
- **D 文风检查**：`issueCount`、每个 issue 的 `dimension/severity/severityLabel`、
  `excerptVerbatim`（原文证据是否逐字出现在本章正文；精确子串）、`excerptNormalized`
  （忽略空白/省略号后是否仍能对上）、`basisNonEmpty`/`suggestionNonEmpty`、
  `severityCounts`、以及 `promptTokens/completionTokens/cachedPromptTokens/cacheHitRatio`。
  若 `allExcerptsMissed=true`（所有证据都不在正文）会带 `severeWarning`，需人工复核模型是否编造原文；
  该指标不直接判失败。

**硬断言只有**：schema 合法、关键内容非空、调用成功。文风、节奏、伏笔质量等不设机器阈值，
看 `metrics` 与 `sample` 人工判断。

## 费用与误触发

- 固定 4 次调用；输入为各任务的生产 prompt + 夹具，单次抽检通常在**几分钱人民币**量级
  （以服务商官方计费为准）。
- ⚠️ 若 shell 里长期导出 `REAL_LLM_API_KEY`/`DEEPSEEK_API_KEY`，跑全量测试时这四个
  检查也会执行（会真实计费）。只想跑常规测试时请先 `unset` 两个变量。
- Key 只从环境变量读取，不落盘、不进代码；抽检使用临时 IndexedDB（fake-indexeddb），
  不触碰浏览器里的真实作品数据。
