#!/usr/bin/env node
/**
 * 阶段 6 验收：设置里的正文字体/字号 → 正文 max-width = 40 × 字号。
 *
 * 在 /__workbench 预览页上写入 localStorage 后重载，量 .wb-prose-probe：
 * - 字体大小 / 行高比例；
 * - 实际正文宽度（1440 视口下应等于 40×字号，且不超过 40×字号）；
 * - 无横向滚动、无页面错误。
 *
 * 用法：
 *   node scripts/appearance-check.mjs
 *   node scripts/appearance-check.mjs --url http://127.0.0.1:5173/__workbench --chromium "/path/to/chrome"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const STORAGE_KEY = 'myliterature.appearance-settings';
const CASES = [
  { font: 'sans', size: 17, width: 680, line: 1.85, label: '黑体默认 17' },
  { font: 'serif', size: 18, width: 720, line: 2.05, label: '宋体 18' },
  { font: 'sans', size: 22, width: 880, line: 1.85, label: '黑体上限 22' },
  { font: 'serif', size: 16, width: 640, line: 2.05, label: '宋体下限 16' },
];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function resolveChromium(explicit) {
  const candidates = [];
  const push = (value) => value && candidates.push(path.resolve(String(value)));
  push(explicit);
  push(process.env.PLAYWRIGHT_CHROMIUM_PATH);
  push(process.env.CHROMIUM_PATH);
  try {
    push(chromium.executablePath());
  } catch {
    // 版本不匹配时忽略
  }
  const roots = [
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
  ];
  const relatives = [
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
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root);
    const ordered = [
      ...entries
        .filter((entry) => /^chromium-\d+/.test(entry))
        .sort()
        .reverse(),
      ...entries
        .filter((entry) => /^chromium_headless_shell-\d+/.test(entry))
        .sort()
        .reverse(),
    ];
    for (const entry of ordered) {
      for (const relative of relatives) push(path.join(root, entry, relative));
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
    process.exit(2);
  }
  return found;
}

const url = arg('--url', 'http://127.0.0.1:5173/__workbench');
const chromiumPath = resolveChromium(arg('--chromium', process.env.PLAYWRIGHT_CHROMIUM_PATH));
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
const failures = [];

try {
  for (const testCase of CASES) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
      [
        STORAGE_KEY,
        {
          state: { font: testCase.font, size: testCase.size },
          version: 0,
        },
      ],
    );
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="editor-prose"]', { timeout: 15_000 });
    await page.waitForTimeout(150);

    const measured = await page.evaluate(() => {
      const element = document.querySelector('[data-testid="editor-prose"]');
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        fontSize: Number.parseFloat(style.fontSize),
        lineHeight: Number.parseFloat(style.lineHeight),
        width: rect.width,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });

    if (!measured) {
      failures.push(`${testCase.label}: 找不到正文探针`);
      await page.close();
      continue;
    }
    const lineRatio = measured.lineHeight / measured.fontSize;
    const chars = measured.width / measured.fontSize;
    const checks = [
      ['字号', Math.abs(measured.fontSize - testCase.size) <= 0.1, `${measured.fontSize}px`],
      ['行高', Math.abs(lineRatio - testCase.line) <= 0.02, lineRatio.toFixed(2)],
      ['正文宽', Math.abs(measured.width - testCase.width) <= 2, `${measured.width.toFixed(0)}px`],
      ['40 字/行', Math.abs(chars - 40) <= 1, chars.toFixed(1)],
      ['无横向滚动', measured.scrollWidth <= measured.innerWidth, `${measured.scrollWidth}px`],
      ['无脚本错误', errors.length === 0, errors[0] ?? 'ok'],
    ];
    console.log(
      `${testCase.label.padEnd(12)} ` +
        checks.map(([name, ok, value]) => `${name}:${ok ? 'PASS' : 'FAIL'}(${value})`).join(' '),
    );
    for (const [name, ok, value] of checks) {
      if (!ok) failures.push(`${testCase.label} ${name} → ${value}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error('\n失败：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('\n全部通过：字体/字号切换后正文宽 = 40 × 字号，行高与字号联动。');
