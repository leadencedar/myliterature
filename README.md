# 文墨 · MyLiterature

> AI 小说创作工作台 —— 移动端优先、本地优先。从一句话点子长出知识库，再按章把长篇写下去。

**在线使用：<https://leadencedar.github.io/myliterature/>**

## 这是什么

一个纯前端的 AI 小说创作工具：书架、知识库（条目 / 分类 / 风格档案 / 写作规范 / 译名表 / 回收站）、
写作（大纲树 / 章节编辑 / 整章生成 / 段落加工 / 摘要链 / 外传）、计划、旧稿导入、导出备份、互动推演。

手机和电脑同一套代码：窄屏是底部 Tab，宽屏是侧边栏 + 多列。可「添加到主屏幕」当独立应用使用。

## 使用方式

**在线版**：直接打开 <https://leadencedar.github.io/myliterature/>，在「设置」里填入自己的模型 API Key。
数据只存在当前浏览器的 IndexedDB 里，不上传服务器。

**本地运行**：

```bash
npm install        # 安装依赖（首次较慢）
npm run dev        # 开发服务器 http://localhost:5173
npm run build      # 生产构建，产物在 dist/
npm run test:run   # 单元测试
```

macOS 上也可以直接双击仓库根目录的 `启动文墨服务器.command`。

## 部署（GitHub Pages）

推送到 `main` 后由 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 自动完成：
装依赖 → 类型检查 → 单元测试 → 构建 → 上传发布。

- 项目页在子路径 `/<仓库名>/` 下，工作流构建时通过 `VITE_BASE` 注入前缀；
  本地开发与局域网托管默认仍是根路径 `/`。
- 构建脚本会额外生成 `dist/404.html`（`index.html` 的副本），让 `/write/scenario/xxx`
  这类前端深链在静态托管上也能正常打开。
- 首次部署需要仓库 Pages 的 Source 设为「GitHub Actions」（工作流里的
  `actions/configure-pages` 会自动开启）。

## 数据与隐私

- **无后端**：全部数据存在当前设备的浏览器 IndexedDB 中，按**源**（协议 + 主机 + 端口）隔离。
  换域名 / 端口（如从 `localhost:5173` 换到线上的 `leadencedar.github.io`）数据不共享，
  需要用「导出备份 → 导入备份」迁移。
- **API Key 只存在本地**，出站连接由 CSP `connect-src` 白名单限制在已登记的服务商域名内。
- 未注册 Service Worker：离线状态下应用打不开，数据本身不受影响。
- 仓库公开，**不要把 Key、稿件等敏感内容提交进来**（`.env*` 与本地设计素材已加入 `.gitignore`）。

## 文档

- [使用说明](docs/使用说明.md)
- [产品文档](docs/产品文档.md)
- [设计方案](docs/设计方案.md)
- [开发计划](docs/开发计划.md)
- [世界观写作指南](docs/世界观写作指南.md)
- [项目检查报告](项目检查报告.md)
