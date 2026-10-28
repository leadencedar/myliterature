# 真机形态自动检查报告（Chromium 设备模拟，非物理真机）

> 生成时间：2026-10-28T14:48:23.739Z　脚本：`ux/device-check.mjs`（task-61）
> 说明：这是 Chromium 设备模拟，不是物理真机；物理真机人工项见文末清单。

## 1. 设备与环境

| 设备 | 视口 | 触摸 | DPR | Browser |
| --- | --- | --- | --- | --- |
| iPhone 13（模拟） | 390×844 | 是（hasTouch） | 3 | chrome-headless-shell（Playwright 设备模拟） |
| Desktop（模拟） | 1280×900 | 否 | 1 | chrome-headless-shell |

dev server：`http://localhost:5201`（脚本自启自停，端口 5201）；mock：`https://api.deepseek.com/**` 归档 extract JSON，共 2 次非流式请求。

## 2. 每页检查结果

检查项：横向溢出 `documentElement.scrollWidth <= innerWidth+1` 且 body 同样满足；关键按钮存在/可见/可用/水平在视口内；console.error、pageerror、未处理 Promise 计数。

| 设备 | 页面 | overflow | 关键按钮 | 未处理 Promise |
| --- | --- | --- | --- | --- |
| iPhone 13 | 写作页（大纲区） | ✅ 无（doc 390 / inner 390） | 规划后续 3–5 章大纲: ok | 0 |
| iPhone 13 | 回溯预览 | ✅ 无（doc 390 / inner 390） | 生成 10 个章节节点: ok | 0 |
| iPhone 13 | 续写面板 | ✅ 无（doc 390 / inner 390） | 规划 3 章大纲: ok；3 章: ok | 0 |
| iPhone 13 | 归档收件箱 + M2.1 安全提示 | ✅ 无（doc 390 / inner 390） | 纳入本批: ok；采用本批: ok | 0 |
| Desktop 1280×900 | 写作页（大纲区） | ✅ 无（doc 1280 / inner 1280） | 规划后续 3–5 章大纲: ok | 0 |
| Desktop 1280×900 | 回溯预览 | ✅ 无（doc 1280 / inner 1280） | 生成 10 个章节节点: ok | 0 |
| Desktop 1280×900 | 续写面板 | ✅ 无（doc 1280 / inner 1280） | 规划 3 章大纲: ok；3 章: ok | 0 |
| Desktop 1280×900 | 归档收件箱 + M2.1 安全提示 | ✅ 无（doc 1280 / inner 1280） | 纳入本批: ok；采用本批: ok | 0 |

## 3. 报错

✅ console.error / pageerror / unhandledrejection 合计 **0**。

## 4. 刷新持久化（IndexedDB + localStorage）

| 设备 | IndexedDB novels / chapters / outlines | archive-batch keys | archive-settings | llm-settings | active-novel |
| --- | --- | --- | --- | --- | --- |
| iPhone 13 | 2 / 11 / 2 | 1 | ✅ | ✅ | ✅ |
| Desktop 1280×900 | 2 / 11 / 2 | 1 | ✅ | ✅ | ✅ |

## 5. 截图

- `ux/device-check/device-mobile-writing.png`
- `ux/device-check/device-mobile-backfill.png`
- `ux/device-check/device-mobile-archive.png`
- `ux/device-check/device-desktop-writing.png`

## 6. 结论

✅ **通过**：两设备主流程 0 横向溢出、关键按钮均可见可用、0 console/page 错误、0 未处理 Promise；刷新后 IndexedDB 与 localStorage 设置均在。

## 7. 物理真机仍需人工（本检查不能替代）

- 手机扫码访问 dev server（同 Wi-Fi / HTTPS / 防火墙），确认实际局域网加载与 API Key 不受浏览器安全策略影响；
- 安装到主屏（PWA / iOS Safari「添加到主屏幕」），检查图标、启动图、全屏 safe-area（刘海/底部 Home indicator）；
- 真实触摸滚动、惯性滚动、双指缩放、长按选择、输入框聚焦时的软键盘遮挡与 `visualViewport` 变化；
- iOS Safari 私有模式/存储配额下的 localStorage 行为与 IndexedDB 驱逐；Android Chrome 与微信内置浏览器的差异；
- 真实网络延迟与真实模型（真实 API Key）下的流式正文、归档 extract、续写 outline-continue 的耗时/错误；
- 真实设备字体渲染与 DPR 截图（本报告为 Chromium 模拟，DPR3 仅为截图密度）；
- 无障碍/读屏（VoiceOver/TalkBack）与深色模式（本检查未覆盖）。

## 8. 附：mock 请求记录

- 2026-10-28T14:48:18.224Z stream=false model=deepseek-flash
- 2026-10-28T14:48:22.624Z stream=false model=deepseek-flash

（dev server 输出已省略；非空表示启动日志。）