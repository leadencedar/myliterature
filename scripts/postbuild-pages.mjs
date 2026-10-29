/**
 * GitHub Pages 的 SPA 深链回退。
 *
 * Pages 是纯静态托管，访问 `/myliterature/write/scenario/xxx` 这类前端路由时
 * 服务器找不到对应文件，会返回 404 页。把 index.html 复制一份成 404.html，
 * Pages 就会用它兜底 —— 脚本照常执行，BrowserRouter 按真实地址匹配路由。
 *
 * 只在构建后运行（npm run build），不影响本地开发服务器。
 */
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
const indexHtml = resolve(dist, 'index.html');

if (!existsSync(indexHtml)) {
  console.error('postbuild-pages: 找不到 dist/index.html，构建可能失败了');
  process.exit(1);
}

copyFileSync(indexHtml, resolve(dist, '404.html'));
console.log('postbuild-pages: 已生成 dist/404.html（SPA 深链回退）');
