import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * 部署路径前缀。
 *
 * 本地开发 / 局域网托管都是根路径 `/`；GitHub Pages 项目页则挂在
 * `https://<user>.github.io/<repo>/` 下，构建时必须把资源前缀改成 `/repo/`，
 * 否则线上的 JS / CSS / manifest 全部 404。
 *
 * 由环境变量传入（CI 里见 .github/workflows/deploy.yml），默认保持 `/`，
 * 这样本机原有的 IndexedDB 数据源（localhost:5173）不受影响。
 */
const BASE = process.env.VITE_BASE ?? '/';

/**
 * 允许直连的 LLM 接口白名单。
 *
 * 阶段一用户自带 API Key，密钥存在浏览器本地，因此用 CSP 把出站连接限制在
 * 已知的模型服务商域名内 —— 即便页面被注入脚本，也无法把密钥外传到任意地址。
 * 用户若要接入此处未列出的自建端点，需要同时在这里登记域名。
 */
const LLM_ENDPOINT_ALLOWLIST = [
  'https://api.deepseek.com',
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://api.moonshot.cn',
  'https://open.bigmodel.cn',
  'https://dashscope.aliyuncs.com',
  'https://ark.cn-beijing.volces.com',
  'https://api.siliconflow.cn',
];

function contentSecurityPolicy(isDev: boolean): string {
  const connect = ["'self'", ...LLM_ENDPOINT_ALLOWLIST];
  if (isDev) {
    // Vite HMR 走 WebSocket
    connect.push('ws:', 'wss:');
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Tailwind 在开发模式下以 <style> 注入，生产为独立 css 文件
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
  ].join('; ');
}

export default defineConfig(({ command }) => ({
  base: BASE,
  plugins: [
    react(),
    tailwindcss(),
    {
      // 把 CSP 以 meta 标签注入 index.html：开发模式额外放开 WebSocket
      name: 'inject-csp',
      transformIndexHtml(html: string) {
        return html.replace(
          '<!--CSP-->',
          `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(
            command === 'serve',
          )}" />`,
        );
      },
    },
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 便于手机在同一局域网内访问调试
    host: true,
    /**
     * 端口写死，且占用时直接报错而不是自动换一个。
     *
     * 数据全在 IndexedDB 里，而 IndexedDB 是按**源**（协议 + 主机 + 端口）隔离的。
     * Vite 默认在 5173 被占用时静静地换到 5174 —— 于是手机上打开的是一个全新的空库，
     * 之前导入的稿子看起来「丢了」，其实只是躺在另一个源里。宁可启动失败也不要悄悄换源。
     *
     * 同理，局域网 IP 也会随 DHCP 变动。真要长期在平板上用，建议走
     * `http://<主机名>.local:5173`（Bonjour 名字不随 IP 变），或者构建后固定端口托管 `dist`。
     */
    port: 5173,
    strictPort: true,
    /**
     * 放行 Bonjour 的 `*.local` 主机名。
     *
     * Vite 会按 Host 头拦掉不认识的主机（返回 403），而 `http://xxx.local:5173`
     * 正是这里唯一稳定的入口 —— IP 会变，主机名不会。
     */
    allowedHosts: ['.local'],
  },
  build: {
    /**
     * 主 chunk 540 kB（gzip 167 kB），略超默认 500 kB 提示线。
     *
     * 六个页面已按路由懒加载（见 AppShell.tsx），主 chunk 剩下的是框架与
     * 全部页面共用的核心（React / Dexie / domain / context / proposal / prompt），
     * 没有进一步拆分的意义。阈值提到 550，保留对真正意外膨胀的告警。
     */
    chunkSizeWarningLimit: 550,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
}));
