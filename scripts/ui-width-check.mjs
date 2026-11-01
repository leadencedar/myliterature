#!/usr/bin/env node
/**
 * UI v2 阶段 1 · 宽度验收脚本（Playwright）
 *
 * 用途：在真实 Chromium 里测量写作工作台空壳的布局，验证：
 *   1. >=1024px：正文每行 40±1 字（17px 黑体，上限 680px）；
 *   2. >=1280px：章节栏常驻 240px；1024–1279px：章节栏浮层且默认收起、可打开；
 *   3. <1024px：同一个主导航变为底部栏，单栏，无横向滚动；
 *   4. 正文字号 17px、行高 1.85；无页面脚本错误、无横向滚动。
 *
 * 本脚本不改产品代码、不写数据库、不调用模型；只打开页面测量 DOM 尺寸。
 *
 * 用法：
 *   node scripts/ui-width-check.mjs                                   # 默认跑脚本自带夹具
 *   node scripts/ui-width-check.mjs --url http://127.0.0.1:5173/__workbench
 *   node scripts/ui-width-check.mjs --viewports 390,768,1024,1280,1440 --json /tmp/ui-width.json
 *   node scripts/ui-width-check.mjs --screenshots /tmp/ui-width-shots --no-fail
 *   node scripts/ui-width-check.mjs --chromium "/path/to/chrome"       # 也可用 PLAYWRIGHT_CHROMIUM_PATH
 *
 * 依赖：playwright-core（当前环境已存在于 node_modules；正式接入 CI 前需将其加入
 * devDependencies 或使用 CI 自带浏览器，见 docs/UI-v2-阶段1-任务拆分与验收.md）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_VIEWPORTS = [390, 768, 1024, 1280, 1440];
const DEFAULT_TOLERANCE = 1;

const SELECTORS = {
  root: '[data-testid="workbench-root"]',
  nav: '[data-testid="global-nav"], nav[aria-label="主导航"]',
  header: '[data-testid="workbench-header"]',
  rail: '[data-testid="chapter-rail"]',
  toggle: '[data-testid="rail-toggle"]',
  editor: '[data-testid="editor-pane"]',
  prose: '[data-testid="editor-prose"]',
};

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const tolerance = numberArg(args.tolerance, DEFAULT_TOLERANCE);
const viewports = listArg(args.viewports ?? args.viewport, DEFAULT_VIEWPORTS);
const target = resolveTarget(args);
const screenshotsDir = args.screenshots ? path.resolve(String(args.screenshots)) : null;
const jsonPath = args.json ? path.resolve(String(args.json)) : null;

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error(
    '缺少 playwright-core。可在本机安装：npm i -D playwright-core；或改用已有 Playwright 的环境。',
  );
  process.exit(2);
}

const chromiumPath = resolveChromium(args.chromium);
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
const results = [];
let failed = false;

try {
  for (const width of viewports) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    await page.goto(target, { waitUntil: 'load', timeout: 30_000 });
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });
    await page.waitForTimeout(250);

    const initial = await measure(page);
    let open = null;
    if (width >= 1024 && width < 1280) {
      const toggle = page.locator(SELECTORS.toggle);
      if ((await toggle.count()) > 0 && (await toggle.isVisible())) {
        await toggle.click();
        await page.waitForTimeout(250);
        open = await measure(page);
      }
    }

    const checks = evaluateViewport(width, initial, open, tolerance, errors);
    const passed = checks.every((check) => check.ok);
    if (!passed) failed = true;
    results.push({ width, initial, open, checks, passed, errors });

    if (screenshotsDir) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      await page.screenshot({ path: path.join(screenshotsDir, `width-${width}.png`) });
    }
    await page.close();
  }
} finally {
  await browser.close();
}

printReport({ target, chromiumPath, results, tolerance });

if (jsonPath) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        target,
        chromium: chromiumPath,
        tolerance,
        viewports: results,
        pass: !failed,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`\nJSON 已写入：${jsonPath}`);
}

process.exit(failed && !args['no-fail'] ? 1 : 0);

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) {
      out[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function resolveTarget(parsed) {
  if (parsed.url) return String(parsed.url);
  if (parsed.file) return pathToFileURL(path.resolve(String(parsed.file))).href;
  return pathToFileURL(path.join(__dirname, 'ui-width-check', 'fixture.html')).href;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function listArg(value, fallback) {
  if (value === undefined) return fallback;
  const list = String(value)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  if (list.length === 0) {
    console.error('--viewports 需要形如 390,768,1024,1280,1440 的正整数列表');
    process.exit(2);
  }
  return list;
}

function resolveChromium(explicit) {
  const candidates = [];
  const push = (value) => {
    if (value) candidates.push(path.resolve(String(value)));
  };
  push(explicit);
  push(process.env.PLAYWRIGHT_CHROMIUM_PATH);
  push(process.env.CHROMIUM_PATH);
  try {
    push(chromium.executablePath());
  } catch {
    // 忽略：版本不匹配时 executablePath 可能指向不存在的目录
  }

  const cacheRoots = [
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
  ];
  const relativePaths = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'chrome-headless-shell-mac-x64/chrome-headless-shell',
    'chrome-headless-shell-linux64/chrome-headless-shell',
  ];
  for (const root of cacheRoots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root);
    const fullBrowsers = entries
      .filter((entry) => /^chromium-\d+/.test(entry))
      .sort()
      .reverse();
    const headlessShells = entries
      .filter((entry) => /^chromium_headless_shell-\d+/.test(entry))
      .sort()
      .reverse();
    for (const entry of [...fullBrowsers, ...headlessShells]) {
      for (const relative of relativePaths) push(path.join(root, entry, relative));
    }
  }

  const found = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    console.error('找不到可用的 Chromium。可用 --chromium 指定，或设置 PLAYWRIGHT_CHROMIUM_PATH。');
    console.error('已尝试：');
    for (const candidate of candidates) console.error(`  - ${candidate}`);
    process.exit(2);
  }
  return found;
}

async function measure(page) {
  return page.evaluate((selectors) => {
    const query = (selector) => document.querySelector(selector);
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      };
    };
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 &&
        box.width > 1 &&
        box.height > 1
      );
    };

    const root = query(selectors.root);
    const nav = query(selectors.nav);
    const rail = query(selectors.rail);
    const toggle = query(selectors.toggle);
    const editor = query(selectors.editor);
    const prose = query(selectors.prose);
    const header = query(selectors.header);

    const navStyle = nav ? getComputedStyle(nav) : null;
    const railStyle = rail ? getComputedStyle(rail) : null;
    const proseStyle = prose ? getComputedStyle(prose) : null;
    const proseBox = prose ? prose.getBoundingClientRect() : null;
    const fontSize = proseStyle ? parseFloat(proseStyle.fontSize) : 0;
    const lineHeight = proseStyle ? parseFloat(proseStyle.lineHeight) : 0;

    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      root: rect(root),
      navCount: document.querySelectorAll(selectors.nav).length,
      headerVisible: visible(header),
      nav: {
        visible: visible(nav),
        ...rect(nav),
        position: navStyle?.position ?? null,
      },
      rail: {
        visible: visible(rail),
        ...rect(rail),
        position: railStyle?.position ?? null,
        visibility: railStyle?.visibility ?? null,
      },
      toggle: {
        visible: visible(toggle),
        ...rect(toggle),
      },
      editor: {
        visible: visible(editor),
        ...rect(editor),
      },
      prose: {
        visible: visible(prose),
        ...rect(prose),
        fontSize,
        lineHeight,
        lineHeightRatio: fontSize > 0 ? lineHeight / fontSize : 0,
        chars: proseBox && fontSize > 0 ? proseBox.width / fontSize : 0,
      },
    };
  }, SELECTORS);
}

function evaluateViewport(width, measured, open, allowedTolerance, errors) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const fits = (value) => Math.abs(value - 40) <= allowedTolerance;

  add('工作台根节点存在', measured.root && measured.root.width > 0);
  add(
    '无横向滚动',
    measured.docScrollWidth <= measured.innerWidth + 1,
    `${measured.docScrollWidth} / ${measured.innerWidth}`,
  );
  add(
    `正文字号 17px`,
    Math.abs(measured.prose.fontSize - 17) <= 0.1,
    `${measured.prose.fontSize}px`,
  );
  add(
    '正文行高比例 1.85',
    Math.abs(measured.prose.lineHeightRatio - 1.85) <= 0.02,
    measured.prose.lineHeightRatio.toFixed(3),
  );
  add(
    '正文可见',
    measured.prose.visible && measured.prose.width > 100,
    `${Math.round(measured.prose.width)}px`,
  );
  add('主导航可见', measured.nav.visible);

  if (width >= 1024) {
    add(
      `正文每行 40±${allowedTolerance} 字`,
      fits(measured.prose.chars),
      `${measured.prose.chars.toFixed(1)} 字`,
    );
    add(
      '主导航在左侧、宽 224',
      Math.abs(measured.nav.width - 224) <= 2 && measured.nav.left <= 1,
      `${Math.round(measured.nav.width)}px @${Math.round(measured.nav.left)}`,
    );
    if (width >= 1280) {
      add(
        '章节栏常驻 240',
        measured.rail.visible && Math.abs(measured.rail.width - 240) <= 2,
        `${Math.round(measured.rail.width ?? 0)}px`,
      );
    } else {
      add('章节栏默认收起', !measured.rail.visible);
      add('章节栏可打开', Boolean(open?.rail.visible));
      add(
        '打开后无横向滚动',
        Boolean(open && open.docScrollWidth <= open.innerWidth + 1),
        open ? `${open.docScrollWidth} / ${open.innerWidth}` : '',
      );
    }
  } else {
    add(
      '主导航变为底部栏（同一 DOM）',
      measured.nav.visible &&
        measured.nav.position === 'fixed' &&
        measured.nav.bottom >= measured.innerHeight - 4,
      `${measured.nav.position} bottom=${Math.round(measured.nav.bottom)}`,
    );
    add('章节栏默认收起', !measured.rail.visible);
    add('无全局导航双份', measured.navCount === 1, `${measured.navCount} 个导航节点`);
  }

  add('无页面脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  return checks;
}

function printReport({
  target,
  chromiumPath,
  results: reportResults,
  tolerance: allowedTolerance,
}) {
  console.log('\nUI v2 阶段 1 · 宽度验收');
  console.log(`目标：${decodeURI(target)}`);
  console.log(`浏览器：${chromiumPath}`);
  console.log(`视口：${reportResults.map((item) => item.width).join(' / ')}px`);
  console.log('');

  const header = ['宽度', '布局', '正文宽', '字号', '字/行', '横向滚动', '结果'];
  const rows = reportResults.map((item) => {
    const initial = item.initial;
    const layout =
      item.width >= 1280 ? '双栏·栏常驻' : item.width >= 1024 ? '双栏·栏浮层' : '单栏·底部栏';
    return [
      `${item.width}px`,
      layout,
      `${Math.round(initial.prose.width)}px`,
      `${initial.prose.fontSize}px`,
      initial.prose.chars.toFixed(1),
      initial.docScrollWidth <= initial.innerWidth + 1 ? '无' : '有',
      item.passed ? 'PASS' : 'FAIL',
    ];
  });
  printTable([header, ...rows]);

  const failures = [];
  for (const item of reportResults) {
    for (const check of item.checks) {
      if (!check.ok) {
        failures.push(
          `${item.width}px · ${check.name}${check.detail ? `（${check.detail}）` : ''}`,
        );
      }
    }
  }

  if (failures.length === 0) {
    console.log(`\n全部通过（正文 40±${allowedTolerance} 字、无横向滚动、无脚本错误）。`);
  } else {
    console.log(`\n发现 ${failures.length} 项失败：`);
    for (const failure of failures) console.log(`  - ${failure}`);
    console.log(
      '\n提示：阶段 1 空壳先按规格 §3 调整；若是真实页面，先确认 data-testid 钩子已加上。',
    );
  }
}

function printTable(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => displayWidth(row[column]))),
  );
  for (const [index, row] of rows.entries()) {
    const line = row
      .map((cell, column) => cell + ' '.repeat(widths[column] - displayWidth(cell)))
      .join('  ');
    console.log(`  ${line}`);
    if (index === 0) console.log(`  ${widths.map((width) => '─'.repeat(width)).join('  ')}`);
  }
}

/** 中文按 2 个终端列宽估算，够用即可 */
function displayWidth(text) {
  let width = 0;
  for (const character of String(text)) {
    width += /[\u2e80-\uffff]/.test(character) ? 2 : 1;
  }
  return width;
}

function printHelp() {
  console.log(`
UI v2 阶段 1 · 宽度验收（Playwright）

用法：
  node scripts/ui-width-check.mjs [选项]

选项：
  --url <url>             测量线上/本地页面（如 http://127.0.0.1:5173/__workbench）
  --file <path>           测量本地 HTML 文件
  --viewports <列表>      默认 390,768,1024,1280,1440
  --tolerance <数字>      "40 字/行" 的允许误差，默认 1
  --chromium <path>       Chromium 路径；也可用 PLAYWRIGHT_CHROMIUM_PATH
  --screenshots <dir>     每个视口保存一张截图
  --json <path>           输出 JSON 结果
  --no-fail               有失败也返回 0（用于只记录）
  --help                  显示帮助
`);
}
