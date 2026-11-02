# UI v2 阶段 2：编辑器内联 · 最小验证执行记录

> 日期：2026-11-01
> 状态：**阶段 2 已完成（dev-only）**。默认 `/write` 仍是原页面 + 全屏编辑器；阶段 2 只验证「同一编辑器放进工作台中栏」的承载、切章与退出行为。
> **后续（阶段 3）**：该内联形态已转正为 `/write` 打开章节后的默认工作台，不再需要 `?inline-editor=1`；本记录保留阶段 2 当时的 dev-only 验收状态，见 [UI-v2-阶段3-写作工作台-执行记录.md](UI-v2-阶段3-写作工作台-执行记录.md)。
> 依据：[UI-v2-P0-设计规格.md](UI-v2-P0-设计规格.md) §11 阶段 2；[UI-v2-阶段1-任务拆分与验收.md](UI-v2-阶段1-任务拆分与验收.md)。
> 基线：`feat/ui-v2-stage1` 末端（含工作台壳、预览路由、宽度验收与 CI job）。

---

## 1. 做了什么

| 改动           | 文件                                                        | 说明                                                                                                                                |
| -------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 编辑器呈现方式 | `src/features/writing/ChapterEditorScreen.tsx`              | 新增 `presentation: 'modal' ｜'inline'`：inline 用 `role="region"`、`h-full min-h-0`，不声明 `aria-modal`；默认仍是原来的全屏 modal |
| 切章保存契约   | 同上                                                        | 新增 `editorRef` + `ChapterEditorHandle.flush()`：父级切章前先 `await flush()`，返回 false 就不切                                   |
| 内联工作台预览 | `src/features/writing/workbench/InlineWorkbenchPreview.tsx` | 工作台壳 + 内联编辑器；章节栏点击先 flush 再切章；按章 `key` 重挂以重置草稿态                                                       |
| 章节选择回调   | `src/features/writing/workbench/WorkbenchShell.tsx`         | 新增 `onSelectChapter`，由父级决定切章顺序                                                                                          |
| 开发入口       | `src/features/writing/WritingPage.tsx`                      | `/write?inline-editor=1`（仅 DEV / 测试环境）；懒加载内联组件，生产构建摇掉；默认路径不变                                           |
| 测试           | `src/features/writing/ChapterEditor.test.tsx`               | 新增 4 个用例：内联 region + 切章 flush；保存失败退出拦截；未保存时点站内链接先保存再导航；外传章节按分组显示                       |
| 排版适配       | `ChapterEditorScreen.tsx`、`workbench.css`                  | inline 下正文用工作台令牌：黑体 17 / 1.85、上限 680、标题 24px；modal 仍沿用原排版                                                  |
| 路由离开守卫   | `InlineWorkbenchPreview.tsx`                                | 站内链接点击先 `flush()`，失败留在页面并提示；`beforeunload` 兜底关闭/刷新；浏览器后退未拦截                                        |
| 章节栏数据     | `WritingPage.tsx`、`WorkbenchShell.tsx`                     | 章节栏标题可配置；列出全部章节（含外传前缀），不再只列主线                                                                          |

设计取舍：

- **不改现有编辑器状态机**：保存队列、防抖、退出拦截、AI 采用、摘要/归档全部复用；只改变外层承载与对外暴露一个 `flush()`。
- **保留 `key={chapter.id}` 重挂**：复核意见允许；切章先 flush，再重挂，跨章串稿风险最低。
- **懒加载 + DEV 守卫**：`InlineWorkbenchPreview` 只在 DEV/测试环境动态 import；生产构建不包含工作台预览代码（已验证）。

## 2. 怎么试用

```bash
git switch feat/ui-v2-stage2
npm run dev
# 浏览器打开 http://127.0.0.1:5173/write?inline-editor=1
```

进入后点一个章节（或大纲节点「写这一章」），编辑器会以内联方式出现在工作台中栏。URL 上的 `inline-editor=1` 要保留；去掉参数即回到原来的全屏编辑器。

## 3. 验证结果

- **单元测试**：`ChapterEditor.test.tsx` 85 个用例全过（含新增 4 个内联用例）；全仓 `2603 passed / 5 skipped`。
- **类型/格式**：`tsc --noEmit` 0；`format:check` 0。
- **生产隔离**：`npm run build` 0；`dist` 中搜索 `workbench-root` / `InlineWorkbenchPreview` / `inline-editor` 均无命中 → 预览代码未进生产包。
- **真实页面冒烟**（Chromium 1280×900，临时 IndexedDB）：新建作品 → 新增大纲节点 → 「写这一章」→ 内联编辑器出现；`[data-testid="chapter-editor-inline"]` 1 个、`role="dialog"` 0 个、无 console/page error。
- **排版实测**（同一次冒烟）：内联编辑器 textarea 宽 **680px**、字号 **17px**、行高 **31.45px（1.85）**、约 **40.0 字/行**；标题 24px；工作台壳宽度验收脚本仍全 PASS。
- **移动**（390×844，强制 `inline-editor=1`）：内联壳单栏、无横向滚动、底部导航可见；默认移动端仍走全屏编辑器。
- **切章/退出/离开**（测试覆盖）：切章前 flush 后正文落库；保存失败退出被拦截、重试成功后才离开；有未保存内容时点站内链接先弹确认，「保存并离开」后再导航。

## 4. 当前边界（未做）

- 仍是 **dev-only 预览**：默认 `/write`、`Page` 信息架构、全局导航都未改；阶段 3 才把工作台壳接进真实写作页。
- 路由离开守卫只拦截**站内链接点击**（主导航、页面内链）与关闭/刷新；浏览器后退、代码内 `navigate()` 还没有统一拦截，阶段 3 需要补 React Router 数据路由或等价守卫。
- 没有拆出 `ChapterEditorBody` 独立组件：现阶段用 prop 切换承载即可，等阶段 3 需要右侧面板共享状态时再评估拆分。
- 章节栏已按「主线 / 外传·X」分组；分组内还没有「新建外传」入口，阶段 3 接管写作页 IA 时补。
- 移动端内联模式只做了 390px 冒烟，未在真机验证键盘/安全区；默认移动端仍是全屏编辑器。
- 编辑器与右栏还没有联动（右栏是阶段 3）。

## 6. PR 前边缘项处理

- **外传分组**：已完成。`WorkbenchShell` 支持分组表头，写作页按「主线 / 外传·X」渲染；新增测试断言分组标题与外传章节按钮。
- **移动端**：已完成 390×844 单栏冒烟（无横向滚动、底部导航可见）；真机键盘/安全区在当前环境无法验证，已明确留给阶段 3 真机验收，未冒充通过。
- **浏览器后退 / 代码内导航**：仍未拦截。拦截 SPA 后退需要数据路由或全局 history 守卫，风险高于本阶段收益；作为阶段 3 的已知项，PR 描述里会写明。
- **工作台壳宽度**：`node scripts/ui-width-check.mjs --url http://127.0.0.1:5173/__workbench` 重跑五档全 PASS（分组表头没有改变宽度预算）。
- **生产隔离**：`npm run build` 后 `dist` 搜索无 `workbench-root` / `InlineWorkbenchPreview` / `inline-editor`。

## 5. 下一步（阶段 3）

1. 把 `WorkbenchShell` 接进 `/write` 的真实写作页（去掉 dev 查询参数），保留现有大纲/外传/推演/提案/导出入口；
2. 加右栏「本章」（目标/资料/备忘），复用现有编辑器保存队列；
3. 补路由离开的 flush 拦截（React Router blocker 或 workbench 内部守卫）；
4. 按 v2 规格切换编辑器排版（黑体 17/1.85、680 上限），并扩展宽度验收脚本覆盖编辑器正文。
