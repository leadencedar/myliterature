# DeepSeek 预置模型名修正

真实模型抽检（`real-device-live-check/live-result.md`）证明：官方 `https://api.deepseek.com` 接受 `deepseek-chat`，而应用预置的 `deepseek-flash` / `deepseek-v4-pro` 不可用。新用户不改模型名会 404。

## 改动

1. `src/llm/presets.ts`：DeepSeek 预置 `model` / `strongModel` 都改为 `deepseek-chat`（官方当前通用模型；重点任务仍可用更强模型，用户可手改）。
2. `SettingsPage.tsx`：两个模型输入框 placeholder 改 `deepseek-chat`；preset 说明可提「默认 deepseek-chat，可手动改」。
3. 全部测试期望更新（SettingsPage、SetupSection、ChapterEditor、WritingPage、M3 outline-continue 等请求体断言）。
4. 文档同步：开发计划、设计方案中的模型名；使用说明/产品文档若提到预置模型名则加「默认 deepseek-chat」。
5. 增加回归断言：应用 DeepSeek 预置后，常规模型与重点任务模型均为 `deepseek-chat`；不出现旧名。

## 验收

- `npm run typecheck` / `npm run test:run` / `npm run build` 全绿。
- 用真实 Key 跑 `npm run test:live` **不覆盖模型名**（不设 REAL_LLM_MODEL/STRONG_MODEL），A/B/C 全部通过，证明默认配置开箱可用。
- 旧名不再出现在用户可见默认配置/文档中。
