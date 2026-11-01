# UI v2 阶段 1：令牌 + 空壳布局 · 任务拆分与宽度验收

> 日期：2026-11-01
> 状态：**实施计划 + 验收工具，未改产品代码**。本交付只新增 QA 脚本/夹具与文档，等阶段 1 开工时使用。
> 依据：[UI-v2-P0-设计规格.md](UI-v2-P0-设计规格.md) §3、§11 阶段 1；[UI方案评审与工程差异清单.md](UI方案评审与工程差异清单.md) v1.1。
> 配套：[scripts/ui-width-check.mjs](../scripts/ui-width-check.mjs)、[scripts/ui-width-check/fixture.html](../scripts/ui-width-check/fixture.html)。
> 工程基线：Git HEAD `78ed583`；本文所有行号/文件均以此为参照。

---

## 0. 阶段完成定义（DoD）

阶段 1 只做「令牌 + 空壳布局 + 宽度验收」，交付后应满足：

1. 有一个**仅开发环境可见**的工作台空壳（不接数据、不改现有写作页默认行为），能在真实 AppShell 内打开；
2. 黑体 17px / 1.85、正文上限 680px、全局导航 224px、章节栏 240px 落到 CSS 令牌/空壳上；
3. 真实 Chromium 在 390 / 768 / 1024 / 1280 / 1440 五档量到：≥1024 时正文 40±1 字/行、无横向滚动；1024–1279 章节栏浮层且默认收起；≥1280 章节栏常驻；<1024 单栏 + 底部主导航；
4. 现有页面、测试、构建不受影响；生产构建**不暴露**预览路由；
5. 验收脚本可重复运行并输出记录；有明确回滚方式。

**本阶段不做**：编辑器内嵌/中栏化、右栏「本章」真实数据、`Chapter.note` 迁移、AI 面板、移动端底部操作栏、设计令牌全站替换。这些属于阶段 2 及以后。

---

## 1. 范围与非目标

| 类别 | 阶段 1 范围                                                             | 明确不做                                      |
| ---- | ----------------------------------------------------------------------- | --------------------------------------------- |
| 样式 | 新增工作台作用域令牌：正文字体/字号/行高/上限、栏宽、内边距、`h-dvh` 壳 | 不改全站现有字号/颜色；不做暗色；不迁移品牌色 |
| 路由 | 新增 dev-only 预览路由（`import.meta.env.DEV` 守卫，不进生产）          | 不改 `/write` 的默认行为；不加入主导航        |
| 布局 | 空壳三区（页头 / 章节栏 / 编辑器占位）+ 响应式切换                      | 不做真实右栏、不做移动操作栏                  |
| 数据 | 无；静态示例文本                                                        | 不 import repository / LLM；不写 IndexedDB    |
| 测试 | Playwright 宽度验收（本交付已提供脚本与夹具）                           | 不重写现有 2478 个用例；不改 CI 配置          |
| 依赖 | 沿用当前本地 `playwright-core`                                          | 不修改 `package.json`（正式接入见 T8）        |

---

## 2. 关键方案

### 2.1 预览路由（开发环境专用）

在真实 AppShell 内增加一个空壳预览路由，例如 `/__workbench`：

- 只在 `import.meta.env.DEV` 为真时注册；生产构建不得注册该路由、不暴露入口链接；
- 复用一个真正的 `WorkbenchShell` 组件（阶段 2 会继续使用），避免「验收时一套、开发时另一套」；
- 预览页**只渲染静态示例**（章节列表、正文段落、页头），不调用 `useRepoQuery`、不读 IndexedDB；
- 建议实现方式：动态 import + `import.meta.env.DEV` 条件注册；验收时在 `dist` 中搜索 `__workbench` 与预览唯一字符串（如 `workbench-preview`），确认被摇掉；
- 若发现生产包仍包含，可退化为 `/write?workbench-preview=1` 的 dev 分支并同样验证；不允许把预览入口留在生产。

### 2.2 壳与滚动

- 写作工作台不套 `Page`：使用 `h-dvh` + 栏内独立滚动，保留 `main#main` 与 skip-link（预览页同样要有，便于键盘验收）；
- 三区结构：页头（作品/章节标题/章节栏开关）→ 章节栏 → 编辑器占位；
- 章节栏：≥1280 常驻 240px；1024–1279 绝对定位浮层、默认 `visibility:hidden`、由页头按钮打开；<1024 单栏 + 现有 AppNav 底部栏；
- 正文占位：`max-width: calc(40 * var(--wb-prose-size))`，默认 680px；水平居中；不实现输入逻辑。

### 2.3 令牌（最小、可回滚）

- 新增**作用域**变量（如 `.wb-scope` 或 `:root` 上新增变量），不覆盖现有 `--font-reading`/`reading-column`：
  - `--wb-font-sans`：黑体栈；
  - `--wb-prose-size: 17px`；`--wb-prose-line: 1.85`；`--wb-prose-max: calc(40 * var(--wb-prose-size))`；
  - `--wb-nav-width: 224px`；`--wb-rail-width: 240px`；`--wb-editor-pad: 24px`；
  - 宋体组合 `--wb-font-serif` + 18px/2.05（阶段 6 接到设置，阶段 1 只用黑体验收）。
- 可以放到 `src/index.css` 的 `@theme` 或独立 `workbench.css`；阶段 1 建议独立文件、`@import` 到现有入口，便于整段回滚。
- 不在本阶段修 `ink-300`/`seal` 对比度（避免全站视觉回归）；该修复放阶段 4 的单 PR。

### 2.4 测试钩子（data-testid）

| 选择器                             | 挂载位置       | 说明                                       |
| ---------------------------------- | -------------- | ------------------------------------------ |
| `[data-testid="workbench-root"]`   | 空壳根节点     | 用于确认壳存在                             |
| `[data-testid="workbench-header"]` | 工作台页头     | 章节栏按钮、标题所在                       |
| `[data-testid="chapter-rail"]`     | 章节栏         | 常驻/浮层测量                              |
| `[data-testid="rail-toggle"]`      | 页头按钮       | 1024–1279 打开浮层                         |
| `[data-testid="editor-pane"]`      | 编辑器占位容器 | 可用宽度测量                               |
| `[data-testid="editor-prose"]`     | 正文占位段落   | 字号/行高/字行宽测量                       |
| `nav[aria-label="主导航"]`         | 现有 AppNav    | 脚本用 aria-label 兼容，不改 AppNav 也能量 |

> 预览组件里的 `data-testid` 仅开发环境存在；AppNav 用现有 aria-label，不需要产品代码改动。

---

## 3. 任务清单

估时仅用于排序（S≈0.5 天、M≈1–2 天、L≈3 天），不是工期承诺。

| ID                     | 任务                                                                                                                 | 关键文件                                                                                         | 依赖  | 估时 | 验收                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----- | ---- | --------------------------------------------------------- |
| T0                     | 基线与分支：从 `78ed583` 开 `feat/ui-v2-stage1`；确认工作区干净；记录现有测试/构建基线                               | —                                                                                                | —     | S    | 分支创建；`npm run test:run` 基线记录                     |
| T1                     | 令牌：新增 `--wb-*` 变量与作用域样式（黑体 17/1.85、上限 `calc(40 * size)`、224/240/24）                             | `src/index.css` 或新 `workbench.css`                                                             | T0    | S    | 变量可在预览页读到；现有页面视觉不变（截图抽查）          |
| T2                     | 预览路由：dev-only `/__workbench`，动态 import + `import.meta.env.DEV` 守卫；不加入导航                              | `src/app/AppShell.tsx`（或 dev 路由文件）、`src/features/writing/workbench/WorkbenchPreview.tsx` | T0    | S    | 开发环境可打开；生产构建无该路由（T6 验证）               |
| T3                     | 工作台空壳：页头 + 章节栏（静态章节）+ 编辑器占位（静态正文、底部占位动作）+ skip-link/`main#main`                   | `src/features/writing/workbench/*`                                                               | T1/T2 | M    | 三区可见；无数据请求（Network 面板无 IndexedDB/LLM 调用） |
| T4                     | 响应式与滚动：≥1280 栏常驻；1024–1279 浮层 + 按钮开关 + 焦点归还；<1024 单栏；`h-dvh`、栏内独立滚动                  | 同上 + 媒体查询                                                                                  | T3    | M    | 五档布局符合预期；打开浮层无横向滚动；Esc 关闭浮层        |
| T5                     | 验收接入：给预览挂 `data-testid`；运行 `node scripts/ui-width-check.mjs --url http://127.0.0.1:5173/__workbench`     | `scripts/ui-width-check.mjs`（已提供）、预览组件                                                 | T3/T4 | S    | 脚本全 PASS；JSON/截图归档到 PR                           |
| T6                     | 回归与生产隔离：`format:check`、`typecheck`、`test:run`、`build`；`dist` 搜索 `__workbench` 应为 0；记录 bundle 变化 | —                                                                                                | T2–T5 | S    | 四关全绿；生产无预览入口；bundle 增量有记录               |
| T7                     | 评审与记录：把 T5 数字写入 PR/本文 §6；确认回滚步骤                                                                  | 本文                                                                                             | T6    | S    | 评审通过；记录完整                                        |
| T8（可选，不进本阶段） | 把 `playwright-core` 加入 devDependencies，或提供 CI 浏览器安装方案                                                  | `package.json`/CI                                                                                | T5    | S    | 干净 `npm ci` 后脚本仍可跑                                |

**顺序**：T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7。T1/T2 可并行，T3 必须在两者之后。

**禁止改动**：`src/data/**`、`src/proposal/**`、`src/llm/**`、现有 `ChapterEditorScreen.tsx` 的保存/AI 逻辑、`docs/产品文档.md` 的能力清单。预览组件只能新增文件（AppShell 仅加 dev 守卫的一小段）。

---

## 4. 验收标准（阶段 1）

### 4.1 宽度与排版

| 视口 | 布局              | 章节栏           | 正文文本宽 | 字号/行高   | 每行字数               | 横向滚动 |
| ---- | ----------------- | ---------------- | ---------- | ----------- | ---------------------- | -------- |
| 390  | 单栏 + 底部主导航 | 收起             | 约 342px   | 17px / 1.85 | 约 20（移动不要求 40） | 无       |
| 768  | 单栏 + 底部主导航 | 收起             | 680px      | 17px / 1.85 | 40.0                   | 无       |
| 1024 | 双栏（栏浮层）    | 默认收起、可打开 | 680px      | 17px / 1.85 | 40.0                   | 无       |
| 1280 | 双栏（栏常驻）    | 240px 常驻       | 680px      | 17px / 1.85 | 40.0                   | 无       |
| 1440 | 双栏（栏常驻）    | 240px 常驻       | 680px      | 17px / 1.85 | 40.0                   | 无       |

### 4.2 其他验收

- [ ] 主导航在 ≥1024 左侧 224px；<1024 同一个 DOM 变为底部栏（不是第二套导航）；
- [ ] 1024–1279 点「章节」打开浮层；Esc 关闭并归还焦点；浮层打开时无横向滚动；
- [ ] `h-dvh` 壳内章节栏/编辑器各自滚动，页面本身不出现双滚动条；
- [ ] 无 console error / pageerror（脚本已检查）；
- [ ] 生产 `dist` 中搜索不到 `__workbench` 或预览唯一标记；
- [ ] `format:check` / `typecheck` / `test:run` / `build` 全绿；
- [ ] 现有写作页 `/write` 的入口、编辑器、保存行为不变。

---

## 5. 验收脚本使用

脚本位置：[scripts/ui-width-check.mjs](../scripts/ui-width-check.mjs)；夹具：[scripts/ui-width-check/fixture.html](../scripts/ui-width-check/fixture.html)。

```bash
# 1) 干跑（不启动应用，用自带夹具验证脚本本身）
node scripts/ui-width-check.mjs

# 2) 阶段 1 接入后，测真实预览路由
npm run dev
node scripts/ui-width-check.mjs --url http://127.0.0.1:5173/__workbench

# 3) 需要记录时
node scripts/ui-width-check.mjs --url http://127.0.0.1:5173/__workbench \
  --json /tmp/ui-width.json --screenshots /tmp/ui-width-shots
```

脚本会检查：正文 17px/1.85、≥1024 时 40±1 字/行、1024–1279 栏目默认收起且可打开、≥1280 栏常驻、<1024 单栏底部栏、无横向滚动、无脚本错误。失败返回 1；`--no-fail` 只记录不失败。

**依赖说明**：当前 `node_modules/playwright-core` 是环境里已有的（未写入 `package.json`），所以本阶段脚本可在本机运行；正式接入 CI 前要么加入 devDependency（T8），要么使用 CI 自带浏览器并传 `PLAYWRIGHT_CHROMIUM_PATH`。浏览器路径找不到时脚本会提示。

### 5.1 夹具干跑结果（2026-11-01，本机）

```
UI v2 阶段 1 · 宽度验收
目标：scripts/ui-width-check/fixture.html
视口：390 / 768 / 1024 / 1280 / 1440px

  宽度    布局         正文宽  字号  字/行  横向滚动  结果
  390px   单栏·底部栏  342px   17px  20.1   无        PASS
  768px   单栏·底部栏  680px   17px  40.0   无        PASS
  1024px  双栏·栏浮层  680px   17px  40.0   无        PASS
  1280px  双栏·栏常驻  680px   17px  40.0   无        PASS
  1440px  双栏·栏常驻  680px   17px  40.0   无        PASS

全部通过（正文 40±1 字、无横向滚动、无脚本错误）。
```

> 夹具只验证测量口径与断言；真实预览接入后必须用 `--url` 重跑，不能拿夹具结果代替产品验收。

---

## 6. 接入后的验收记录模板

| 日期 | 提交 | 视口 | 布局 | 正文宽 | 字号/行高 | 字/行 | 横向滚动 | 结果 |
| ---- | ---- | ---- | ---- | ------ | --------- | ----- | -------- | ---- |
|      |      | 390  |      |        |           |       |          |      |
|      |      | 768  |      |        |           |       |          |      |
|      |      | 1024 |      |        |           |       |          |      |
|      |      | 1280 |      |        |           |       |          |      |
|      |      | 1440 |      |        |           |       |          |      |

---

## 7. 风险与回滚

| 风险                                | 影响                  | 缓解                                                                     |
| ----------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| 预览路由泄漏到生产                  | 用户看到空壳/测试入口 | `import.meta.env.DEV` 守卫 + `dist` 搜索验收；必要时改 dev-only 查询参数 |
| 全局令牌改动影响现有页面            | 视觉回归              | `--wb-*` 作用域变量 + 独立 `workbench.css`；现有页面截图抽查             |
| 40 字目标依赖字体渲染               | 实际 39 或 41 字      | 脚本允许 ±1；如超差，先调 `max-width` 或字号，不改目标口径               |
| `fixed` 浮层造成横向滚动            | 移动/窄屏横向拉动     | 浮层用 `visibility` + 定位；脚本检查 `scrollWidth`                       |
| `playwright-core` 被 `npm ci` 清理  | 脚本跑不了            | T8 加入 devDependency，或由环境提供浏览器；README 记录                   |
| 预览组件误依赖数据/仓库             | 把临时实现带进阶段 2  | 预览只允许静态数据；代码评审检查 import                                  |
| `h-dvh` 与现有 `Page`/AppShell 冲突 | 双滚动/高度错位       | 预览路由不复用 `Page`；先在预览验证，再进 `/write`                       |
| 依赖版本与缓存浏览器不匹配          | 启动失败              | 脚本支持 `--chromium` / `PLAYWRIGHT_CHROMIUM_PATH`；失败信息给出路径     |

**回滚**：阶段 1 全部改动集中在「新增 workbench 目录 + 独立样式 + AppShell 的 dev 条件路由 + 脚本/夹具」，回滚即删新增文件并移除 dev 路由；不影响 `/write` 与数据层。若先合了部分改动，先移除预览路由再回滚样式。

---

## 8. 与 v2 规格的对应

- §3.1/§3.2 的宽度与断点 → 本文 §4.1；
- §11 阶段 1 的「令牌 + 空壳布局验证」→ 本文 T1–T5；
- §12 验收清单的「布局」→ 本文 §4.1/§4.2；
- §12「字体与阅读」的字体切换 → 阶段 6（本阶段只做黑体默认）；
- §13 接口表中的「工作台壳」→ T2/T3。

---

## 9. 附注

- 阶段 1 不处理 `Chapter.note`；该字段与 DB v8、备份快照一起在阶段 3 完成（见 v2 规格 §8/§11）。
- 阶段 1 不改现有测试；Playwright 验收是新增的浏览器检查，不进入 `npm run test:run`（CI 是否接入由 T8 决定）。
- 本文和脚本均可独立评审；脚本/夹具是 QA 工具，不是产品代码。

---

## 10. 执行记录（2026-11-01，T0–T2）

- **分支**：`feat/ui-v2-stage1`，基于 `78ed583`；计划/规格/验收工具已先行提交（`docs(ui-v2): 阶段1 计划、v2 规格与宽度验收工具`）。
- **T0 基线**：`npm run test:run` → 132 个测试文件（131 passed / 1 skipped）、2599 passed / 5 skipped，exit 0。此前文档里「2478 用例」是静态 `it(` 计数，低于实际运行数，以本次运行为准。
- **T1 令牌**：新增 `src/features/writing/workbench/workbench.css`；Chromium 读到的作用域变量：`--wb-prose-size: 17px`、`--wb-prose-line: 1.85`、`--wb-prose-max: calc(40 * 17px)`、`--wb-rail-width: 240px`、`--wb-nav-width: 224px`。
- **T2 预览路由**：新增 `src/features/writing/workbench/WorkbenchPreview.tsx`；`AppShell.tsx` 仅在 `import.meta.env.DEV` 下注册 `/__workbench`（动态 import + 三元守卫，不加入主导航）。
- **T2 实测**（Chromium 1280×900）：正文探针 680px 宽、17px 字号、31.45px 行高（1.85）、40.0 字/行；无 console/page error；`/write` 仍返回 200；预览页有 `#main` 与 skip-link。
- **回归**：`format:check` exit 0；`tsc --noEmit`（typecheck）exit 0；`npm run test:run` 仍为 2599 passed / 5 skipped；`npm run build` exit 0；`grep -R "__workbench\|阶段 1 预览\|dev preview" dist` 无命中 → 生产构建未暴露预览路由。
- **未做**：T3 空壳与 T4 响应式尚未接入，因此 `scripts/ui-width-check.mjs` 暂时不能对 `/__workbench` 全量 PASS（缺章节栏/编辑器壳）；等 T3/T4 完成后再跑脚本验收。
- **下一批**：T3（页头/章节栏/编辑器占位）→ T4（五档响应式）→ T5（脚本接入）。
