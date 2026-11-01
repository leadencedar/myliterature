# UI 宽度验收脚本

配套脚本：[`../ui-width-check.mjs`](../ui-width-check.mjs)；测量夹具：[`fixture.html`](fixture.html)。
设计依据：[UI-v2-P0-设计规格](../../docs/UI-v2-P0-设计规格.md) §3；阶段计划见
[UI-v2-阶段1-任务拆分与验收](../../docs/UI-v2-阶段1-任务拆分与验收.md)。

脚本用真实 Chromium 检查写作工作台空壳的布局：

- 390 / 768 / 1024 / 1280 / 1440 五档视口；
- 正文字号 17px、行高 1.85；
- ≥1024 每行 40±1 字；1024–1279 章节栏浮层默认收起且可打开；≥1280 章节栏常驻 240；
- <1024 单栏、同一主导航变为底部栏；
- 无横向滚动、无 console/pageerror。

## 安装

```bash
npm ci
```

`playwright-core` 已加入 devDependencies（1.64.1，精确版本）。它**不包含浏览器**，需要单独安装一次：

```bash
npx playwright-core install chromium
```

已有本地浏览器时可以不下载，用环境变量指向可执行文件：

```bash
export PLAYWRIGHT_CHROMIUM_PATH="/path/to/Google Chrome for Testing"
# 或：但脚本也会自动扫描 ~/Library/Caches/ms-playwright 与 ~/.cache/ms-playwright
```

## 运行

```bash
# 1) 夹具干跑：不启动应用，验证脚本本身与测量口径
npm run ui:width

# 2) 真实写作工作台预览（开发环境路由 /__workbench）
npm run dev
npm run ui:width:preview

# 3) 输出 JSON / 截图、或允许失败只记录
node scripts/ui-width-check.mjs --url http://127.0.0.1:5173/__workbench \
  --json /tmp/ui-width.json --screenshots /tmp/ui-width-shots
node scripts/ui-width-check.mjs --no-fail
```

脚本失败时返回退出码 1；浏览器找不到时返回 2 并列出尝试过的路径。

## 可选参数

| 参数                                 | 说明                                             |
| ------------------------------------ | ------------------------------------------------ |
| `--url <url>`                        | 测量页面（真实预览路由）                         |
| `--file <path>`                      | 测量本地 HTML（夹具）                            |
| `--viewports 390,768,1024,1280,1440` | 视口列表                                         |
| `--tolerance 1`                      | 40 字/行的允许误差                               |
| `--chromium <path>`                  | 指定 Chromium；也可用 `PLAYWRIGHT_CHROMIUM_PATH` |
| `--screenshots <dir>`                | 每个视口保存截图                                 |
| `--json <path>`                      | 输出 JSON 结果                                   |
| `--no-fail`                          | 有失败也返回 0，只记录                           |

## CI 方案（可选，尚未接入仓库 CI）

本仓库 CI 目前只跑 format / typecheck / test / build；宽度验收需要浏览器与开发服务器，建议作为独立 job：

```yaml
ui-width:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version-file: .nvmrc
        cache: npm
    - run: npm ci
    - run: npx playwright-core install --with-deps chromium
    - run: npm run ui:width # 夹具干跑
    - name: 真实预览页
      run: |
        npm run dev -- --host 127.0.0.1 --port 5173 > /tmp/vite.log 2>&1 &
        for i in $(seq 1 30); do
          curl -sf http://127.0.0.1:5173/__workbench > /dev/null && break
          sleep 1
        done
        npm run ui:width:preview
```

说明：

- `/__workbench` 只在 `import.meta.env.DEV` 下注册，所以真实预览要在开发服务器上测；生产构建不包含该路由。
- CI 缓存 `~/.cache/ms-playwright` 可减少浏览器重复下载；是否接入 CI 由后续任务决定。
- 本文件与脚本是 QA 工具，不改变产品运行时代码。
