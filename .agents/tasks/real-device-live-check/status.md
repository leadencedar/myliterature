# 真机 + 真实模型抽检 · 当前状态（2026-10-28）

## 已完成

- **真实模型抽检已跑（2026-10-29）**：3 次调用全部 ok；A 归档提取通过（3 条目、龙套 0）；B 前沿 3 章 12 场通过；C 整章 1200 字实际 2364 字（197%）→ 长度校准为下一步优先项。详见 `live-result.md`。

### 1. 真机形态（Chromium 设备模拟，非物理真机）

`node .agents/tasks/outline-context-scene/ux/device-check.mjs` 可重复运行（自启自停 :5201）。

- iPhone 13（390×844 / touch / DPR3）与 Desktop（1280×900）各 4 页：写作页大纲区、回溯预览、续写面板、归档收件箱 + M2.1 安全提示。
- 结果：**0 横向溢出、关键按钮均可见可用、0 console/page/unhandledrejection、刷新后 IndexedDB 与 localStorage 仍存在**。
- 报告：`ux/device-check/report.md`；截图 `ux/device-check/device-*.png`。
- 结论：布局/交互形态在两种视口下通过；**物理真机仍需人工**（清单见报告 §7）。

### 2. 真实模型抽检套件（Ready，待 Key）

- 文件：`src/test/live/liveModelCheck.test.ts`；脚本：`npm run test:live`；说明：`.agents/tasks/real-device-live-check/README.md`。
- 3 次真实调用：A 归档提取（schema/条目/龙套候选/伏笔）、B 前沿 3 章大纲（场景/冲突/钩子/收束）、C 整章 1200 字（字数/截断/耗时）。
- 无 Key 时：1 条可见提示 + 3 条 skip，exit 0，不写报告；常规测试不受影响（2454 passed / 4 skipped）。
- 报告：`analysis/live-model-report.json`（不含 Key）。

## 本地 App 启动状态

- 启动器等价命令已运行：dev server 在 **http://localhost:5173**（strictPort），已用默认浏览器打开。
- 缓存 Key 在同一浏览器源的 localStorage 中；**本项目沙盒无法读取浏览器 localStorage，也无法驱动 Safari 读取它**。
- 因此真实模型抽检需要下列任一方式把 Key 提供给 `npm run test:live`：
  1. 在 App「设置」点「显示」并复制 Key 到剪贴板，让 Lead 用 `pbpaste` 注入环境变量（不打印 Key）；
  2. 在终端执行（Key 不出本机）：
     ```bash
     REAL_LLM_API_KEY=sk-... REAL_LLM_MODEL=deepseek-chat REAL_LLM_STRONG_MODEL=deepseek-chat npm run test:live
     ```
  3. 启用 Safari「开发 → 允许 Apple 事件中的 JavaScript」后由 Lead 驱动 Safari（需用户手动改设置）。

## 物理真机人工清单（摘 report §7）

1. 同一 Wi-Fi 下手机访问 `http://<主机名>.local:5173`，加主屏/全屏 safe-area；
2. 真实触摸滚动、软键盘遮挡、输入框聚焦；
3. iOS 私有模式存储驱逐、Android/微信浏览器差异；
4. 真实模型耗时/流式/错误提示（与 live 报告对照）；
5. 字体渲染/DPR、VoiceOver/TalkBack、深色模式。
