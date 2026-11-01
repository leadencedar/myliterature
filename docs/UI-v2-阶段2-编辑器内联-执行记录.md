# UI v2 阶段 2：编辑器内联 · 最小验证执行记录

> 日期：2026-11-01
> 状态：**最小验证已完成，dev-only**。默认 `/write` 仍是原页面 + 全屏编辑器；阶段 2 只验证「同一编辑器放进工作台中栏」的承载、切章与退出行为。
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
| 测试           | `src/features/writing/ChapterEditor.test.tsx`               | 新增 2 个用例：内联 region + 章节栏切章（含 flush 后正文落库）；内联模式保存失败退出被拦截、重试成功后才离开                        |

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

- **单元测试**：`ChapterEditor.test.tsx` 83 个用例全过（含新增 2 个内联用例）；全仓 `2601 passed / 5 skipped`。
- **类型/格式**：`tsc --noEmit` 0；`format:check` 0。
- **生产隔离**：`npm run build` 0；`dist` 中搜索 `workbench-root` / `InlineWorkbenchPreview` / `inline-editor` 无命中 → 预览代码未进生产包。
- **真实页面冒烟**（Chromium 1280×900，临时 IndexedDB）：新建作品 → 新增大纲节点 → 「写这一章」→ 内联编辑器出现；`[data-testid="chapter-editor-inline"]` 1 个、`role="dialog"` 0 个、无 console/page error；章节栏显示当前章，右栏暂无（阶段 3）。
- **切章与退出**（测试覆盖）：内联编辑器内输入后点章节栏另一章，先 flush 再切，前一章正文落库；保存失败时点「返回」出现退出拦截，重试成功后才离开。

## 4. 当前边界（未做）

- 仍是 **dev-only 预览**：默认 `/write`、`Page` 信息架构、全局导航都未改；阶段 3 才把工作台壳接进真实写作页。
- 编辑器排版仍沿用现有实现（宋体 17/1.9，桌面 19/2.1）；v2 的黑体 17/1.85 与 680 上限尚未落到编辑器（阶段 6 与字体设置一起做）。
- 没有拆出 `ChapterEditorBody` 独立组件：现阶段用 prop 切换承载即可，等阶段 3 需要右侧面板共享状态时再评估拆分。
- 路由离开（切 Tab、后退）没有阻塞式 flush 提示；当前依赖编辑器卸载冲刷，未达到「离开前 await」的最终要求。
- 工作台章节栏只列主线章节；外传章节打开时不在栏内高亮，阶段 3 补分组。
- 移动端内联模式未在真机验证；移动端默认仍是全屏编辑器。

## 5. 下一步（阶段 3）

1. 把 `WorkbenchShell` 接进 `/write` 的真实写作页（去掉 dev 查询参数），保留现有大纲/外传/推演/提案/导出入口；
2. 加右栏「本章」（目标/资料/备忘），复用现有编辑器保存队列；
3. 补路由离开的 flush 拦截（React Router blocker 或 workbench 内部守卫）；
4. 按 v2 规格切换编辑器排版（黑体 17/1.85、680 上限），并扩展宽度验收脚本覆盖编辑器正文。
