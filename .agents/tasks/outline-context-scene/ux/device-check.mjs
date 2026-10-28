#!/usr/bin/env node
/**
 * 真机形态自动检查（task-61）：Chromium 设备模拟，不是物理真机。
 *
 * 目的：把「可自动化的真机形态」先跑掉 —— iPhone 13（390×844, touch, DPR3）与桌面
 * 1280×900 各走一遍主流程，检查横向溢出、关键按钮可见可点、控制台/页面/未处理 Promise
 * 是否干净，以及刷新后 IndexedDB 与 localStorage 是否还在。
 *
 * 运行：node .agents/tasks/outline-context-scene/ux/device-check.mjs
 * 产物：ux/device-check/report.md + 4 张截图（不覆盖现有 after/m2/m2.1/m3 截图）。
 *
 * 技术要点：
 * - 自己 spawn `npm run dev -- --port 5201 --strictPort`，就绪后跑，结束 kill（不占 GUI 端口）。
 * - playwright-core + 本机 chrome-headless-shell（--no-save 安装，未改 package.json）。
 * - 两个独立 BrowserContext：iPhone 13（isMobile+hasTouch+DPR3）与桌面 1280×900；
 *   IndexedDB 按 context 隔离，所以两边各自种子数据。
 * - page.route 拦截 https://api.deepseek.com/**：OPTIONS 给 CORS；非流式返回归档 extract JSON
 *   （含与已有「沈砚」同名的合并，触发 M2.1 安全提示）。本检查不生成正文/大纲，不需要流式 mock。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const UX_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(UX_DIR, '../../../..');
const OUT_DIR = join(UX_DIR, 'device-check');
const PORT = 5201;
const BASE = `http://localhost:${PORT}`;
const CHROME = resolve(
  process.env.HOME ?? '',
  'Library/Caches/ms-playwright/chromium_headless_shell-1234',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
);

mkdirSync(OUT_DIR, { recursive: true });

const transcript = [];
function log(step, action, detail = '') {
  const line = `[${new Date().toISOString()}] ${step} | ${action}${detail ? ` | ${detail}` : ''}`;
  transcript.push(line);
  console.log(line.replace(/\s+/g, ' ').slice(0, 260));
}
function oneLine(value, max = 300) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------- 假模型（归档 extract）

const ARCHIVE_RESULT = {
  entries: [
    {
      categoryName: '人物',
      title: '沈砚', // 与种子数据同名 → 归档批次里出现 merge（M2.1 安全提示的来源）
      aliases: ['小舟'],
      summary: '失忆剑客；夜渡后开始怀疑失忆与青冥宗有关。',
      fields: [
        { key: 'identity', value: '流亡贵族，六扇门通缉；开始怀疑失忆与青冥宗有关。' },
        { key: 'relations', value: '与裴照有旧怨。' },
      ],
    },
    {
      categoryName: '人物',
      title: '茶博士',
      aliases: [],
      summary: '岸上茶棚的伙计，知道不少渡口旧事。',
      fields: [{ key: 'identity', value: '岸上茶棚的伙计' }],
    },
  ],
  summary: '沈砚与裴照夜渡北上，船夫认出旧簪；裴照提到青冥宗。',
  keyEvents: ['沈砚以差事抵船资', '船夫认出旧簪'],
  appearingEntries: ['沈砚', '裴照'],
  newOpenThreads: ['旧簪的来历', '青冥宗是否还有人活着'],
  resolvedThreads: ['河灯旧案'],
  rollingSummary: '沈砚登船北上；旧簪与青冥宗两条线索浮出水面。',
};

function corsHeaders() {
  return {
    'access-control-allow-origin': BASE,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    'content-type': 'application/json; charset=utf-8',
  };
}

async function installModelMock(page, mockLog) {
  await page.route('https://api.deepseek.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders() });
    let body = {};
    try {
      body = JSON.parse(request.postData() ?? '{}');
    } catch {
      body = {};
    }
    mockLog.push({ stream: body.stream === true, model: body.model ?? '', at: new Date().toISOString() });
    if (body.stream === true) {
      // 本检查流程不生成正文/大纲；若意外触发流式，返回 500 让问题暴露
      return route.fulfill({ status: 500, headers: corsHeaders(), body: JSON.stringify({ error: { message: 'device-check 未预期流式请求' } }) });
    }
    return route.fulfill({
      status: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        id: 'mock-completion',
        object: 'chat.completion',
        created: 0,
        model: body.model ?? 'deepseek-flash',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(ARCHIVE_RESULT) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    });
  });
}

// ---------------------------------------------------------------- dev server

async function waitForServer(url, timeoutMs = 90_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`dev server 在 ${timeoutMs}ms 内没有就绪：${url}`);
}

function startDevServer(serverLog) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  child.stderr.on('data', (chunk) => serverLog.push(String(chunk)));
  return child;
}

async function stopDevServer(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // 已退出
  }
}

// ---------------------------------------------------------------- 页面辅助

async function waitText(page, text, timeout = 20_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

async function visibleText(locator, max = 500) {
  try {
    return oneLine(await locator.innerText({ timeout: 3_000 }), max);
  } catch {
    return '';
  }
}

/** 横向溢出：documentElement 与 body 的 scrollWidth 都不超过 innerWidth+1 */
async function readOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const inner = window.innerWidth;
    return {
      innerWidth: inner,
      docScrollWidth: doc.scrollWidth,
      bodyScrollWidth: body ? body.scrollWidth : 0,
      overflow: doc.scrollWidth > inner + 1 || (body ? body.scrollWidth > inner + 1 : false),
    };
  });
}

async function readUnhandled(page) {
  return page.evaluate(() => {
    const list = window.__deviceCheckUnhandled ?? [];
    const copy = [...list];
    list.length = 0;
    return copy;
  });
}

/** 关键按钮：可见、可用、且水平方向在视口内（y 不作严格限制，长页按钮可能需滚动） */
async function checkButton(page, name) {
  const locator = page.getByRole('button', { name }).first();
  const exists = (await locator.count()) > 0;
  if (!exists) return { name, exists: false, visible: false, enabled: false, inViewport: false };
  const visible = await locator.isVisible().catch(() => false);
  const enabled = await locator.isEnabled().catch(() => false);
  const box = await locator.boundingBox().catch(() => null);
  const viewport = page.viewportSize();
  const inViewport = Boolean(
    box && viewport && box.x >= -1 && box.x + box.width <= viewport.width + 1,
  );
  return { name, exists, visible, enabled, inViewport, box: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null };
}

/**
 * 单页检查：溢出 + 未处理 Promise + 关键按钮。
 * 返回一条结构化记录，供 report.md 汇总。
 */
async function checkPage({ page, device, pageName, url, checks, buttonNames = [] }) {
  await page.waitForTimeout(150);
  const overflow = await readOverflow(page);
  const unhandled = await readUnhandled(page);
  const buttons = [];
  for (const name of buttonNames) buttons.push(await checkButton(page, name));
  const record = { device, pageName, url, overflow, unhandled, buttons };
  checks.push(record);
  log(
    'check',
    `${device} / ${pageName}`,
    `overflow=${overflow.overflow} (doc ${overflow.docScrollWidth} / body ${overflow.bodyScrollWidth} / inner ${overflow.innerWidth})` +
      ` buttons=${buttons.map((b) => `${b.name}:${b.exists && b.visible && b.enabled ? 'ok' : 'FAIL'}`).join(',')}` +
      (unhandled.length ? ` unhandled=${unhandled.length}` : ''),
  );
  return record;
}

async function shot(page, name, note) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT_DIR, name) });
  log('shot', `截图 ${name}`, note ?? '');
}

// ---------------------------------------------------------------- 种子数据

async function seedData(page) {
  return page.evaluate(async () => {
    const { DexieNovelRepository } = await import('/src/data/dexie/DexieNovelRepository.ts');
    const { db } = await import('/src/data/dexie/db.ts');
    const repo = new DexieNovelRepository(db);

    // 连载作品《归墟纪》：有卷/章节点/章节/条目，用于写作页 + 续写面板 + 归档收件箱
    const novel = await repo.createNovel({
      title: '归墟纪',
      genre: '仙侠',
      oneLiner: '失忆剑客追查灭门案，在渡口被迫与旧敌同船。',
    });
    const categories = await repo.listCategories(novel.id);
    const worldCategory = categories.find((category) => category.kind === 'worldbuilding') ?? categories[0];
    const characterCategory = categories.find((category) => category.kind === 'character') ?? categories[1];
    await repo.createEntry(novel.id, {
      categoryId: characterCategory.id,
      title: '沈砚',
      aliases: ['小舟'],
      summary: '失忆的流亡剑客，六扇门通缉。',
      fields: { identity: '旧身份', relations: '与裴照有旧怨。' },
    });
    await repo.createEntry(novel.id, {
      categoryId: worldCategory.id,
      title: '渡口的规矩',
      pinned: true,
      summary: '北方渡口只认官凭；夜渡双倍船资。',
      fields: { rules: '无官凭者不得渡河。' },
    });
    const volume = await repo.createOutlineNode(novel.id, {
      title: '第一卷 渡口',
      synopsis: '沈砚在渡口与裴照相遇，被迫接下去北方的差事。',
      targetWords: 30000,
    });
    const chapterNode = await repo.createOutlineNode(novel.id, {
      title: '第1章 夜渡',
      synopsis: '二人同船北上，各怀心思。',
      parentId: volume.id,
      targetWords: 3000,
    });
    const chapter = await repo.createChapter(novel.id, {
      title: '夜渡',
      content: '渡口的风比记忆里更冷。沈砚把衣领竖起来，站在石阶最上面。',
      outlineNodeId: chapterNode.id,
    });

    // 导入旧稿《旧稿十章》：10 章、无大纲，用于回溯预览
    const backfillNovel = await repo.createNovel({
      title: '旧稿十章',
      genre: '武侠',
      oneLiner: '一个旧渡口的故事，从十年前写起。',
    });
    const titles = ['旧渡口', '夜航', '灯下', '追兵', '渡资', '雪夜', '远山', '旧簪', '回声', '北上'];
    for (let index = 0; index < titles.length; index += 1) {
      const backfillChapter = await repo.createChapter(backfillNovel.id, {
        title: titles[index],
        content: `第${index + 1}章的正文：旧稿里的一段故事，足够用来做回溯预览。`,
      });
      await repo.upsertSummary(backfillNovel.id, backfillChapter.id, {
        summary: `第${index + 1}章摘要：沈砚沿着旧渡口向北，线索一点点浮出来。`,
        keyEvents: [`事件${index + 1}`],
        appearingEntryIds: [],
        openThreads: [],
      });
    }

    return { novelId: novel.id, backfillNovelId: backfillNovel.id, chapterId: chapter.id };
  });
}

async function setActiveNovel(page, novelId) {
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        'myliterature.active-novel',
        JSON.stringify({ state: { activeNovelId: id }, version: 0 }),
      ),
    novelId,
  );
  await page.goto(`${BASE}/write`, { waitUntil: 'load' });
  await page.waitForTimeout(350);
}

// ---------------------------------------------------------------- 主流程

/**
 * @param {object} options
 * @param {string} options.device  设备名（iPhone 13 / Desktop 1280×900）
 * @param {import('playwright-core').BrowserContext} options.context
 * @param {object} options.screenshots  该设备要截的图（null 表示不截）
 */
async function runMainFlow({ device, context, checks, errors, mockLog, screenshots }) {
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    errors.push({ device, kind: 'pageerror', message: String(error) });
    log('!!', `${device} 页面异常`, String(error).slice(0, 240));
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push({ device, kind: 'console.error', message: oneLine(message.text(), 400) });
      log('!!', `${device} console.error`, oneLine(message.text(), 240));
    }
  });
  await installModelMock(page, mockLog);

  // 1) 首页 → 种子数据 → 写作页
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  const seed = await seedData(page);
  log('seed', `${device} 种子数据完成`, `连载作品 + 导入旧稿十章（10 章无大纲）`);
  await setActiveNovel(page, seed.novelId);
  await page.getByRole('button', { name: '规划后续 3–5 章大纲' }).waitFor({ state: 'visible', timeout: 25_000 });
  await checkPage({
    page,
    device,
    pageName: '写作页（大纲区）',
    url: '/write',
    checks,
    buttonNames: ['规划后续 3–5 章大纲'],
  });
  if (screenshots?.writing) await shot(page, screenshots.writing, `${device}：写作页大纲区`);

  // 2) 回溯预览（旧稿十章）
  await setActiveNovel(page, seed.backfillNovelId);
  const backfillEntry = page.getByRole('button', { name: '按已有章节生成大纲' });
  await backfillEntry.waitFor({ state: 'visible', timeout: 20_000 });
  await backfillEntry.click();
  const backfillDialog = page.getByRole('dialog', { name: '按已有章节生成大纲' });
  await backfillDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await checkPage({
    page,
    device,
    pageName: '回溯预览',
    url: '/write（旧稿十章）',
    checks,
    buttonNames: ['生成 10 个章节节点'],
  });
  if (screenshots?.backfill) {
    await shot(page, screenshots.backfill, `${device}：回溯预览（10 章）`);
  }
  await backfillDialog.getByRole('button', { name: '关闭' }).click();
  await backfillDialog.waitFor({ state: 'hidden', timeout: 10_000 });

  // 3) 续写面板
  await setActiveNovel(page, seed.novelId);
  await page.getByRole('button', { name: '规划后续 3–5 章大纲' }).click();
  const continueDialog = page.getByRole('dialog', { name: '规划后续 3–5 章大纲' });
  await continueDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await waitText(page, '本次依据');
  await checkPage({
    page,
    device,
    pageName: '续写面板',
    url: '/write（规划后续 3–5 章大纲）',
    checks,
    buttonNames: ['规划 3 章大纲', '3 章'],
  });
  await continueDialog.getByRole('button', { name: '关闭' }).click();
  await continueDialog.waitFor({ state: 'hidden', timeout: 10_000 });

  // 4) 章节归档 → 归档收件箱 → M2.1 安全提示
  await page.getByRole('button', { name: '继续写第 1 章' }).click();
  await page.getByLabel('章节正文').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('button', { name: '草稿' }).click();
  await waitText(page, '本章摘要与设定已生成', 25_000);
  await page.getByRole('button', { name: '查看' }).click();
  const archiveDialog = page.getByRole('dialog', { name: '本章摘要与设定待确认' });
  await archiveDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await waitText(page, '条对已有条目的合并/替换', 15_000);
  const safetyText = await visibleText(archiveDialog, 700);
  log('check', `${device} / 归档收件箱`, oneLine(safetyText, 220));
  await checkPage({
    page,
    device,
    pageName: '归档收件箱 + M2.1 安全提示',
    url: '章节编辑器（本章摘要与设定待确认）',
    checks,
    buttonNames: ['纳入本批', '采用本批'],
  });
  if (screenshots?.archive) {
    await shot(page, screenshots.archive, `${device}：归档收件箱 + 安全提示`);
  }
  await archiveDialog.getByRole('button', { name: '关闭' }).click();
  await archiveDialog.waitFor({ state: 'hidden', timeout: 10_000 });

  // 5) 刷新后持久化：IndexedDB 种子仍在 + localStorage 设置仍在
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  const persistence = await page.evaluate(async () => {
    const { db } = await import('/src/data/dexie/db.ts');
    const pending = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      pending.push(localStorage.key(index));
    }
    return {
      novelCount: await db.novels.count(),
      chapterCount: await db.chapters.count(),
      outlineCount: await db.outlineNodes.count(),
      localStorageKeys: pending.sort(),
      archiveBatchKeys: pending.filter((key) => key.startsWith('myliterature.archive-batch:')),
      hasArchiveSettings: pending.includes('myliterature.archive-settings'),
      hasLlmSettings: pending.includes('myliterature.llm-settings'),
      hasActiveNovel: pending.includes('myliterature.active-novel'),
    };
  });
  log(
    'check',
    `${device} 刷新持久化`,
    `IDB novels=${persistence.novelCount} chapters=${persistence.chapterCount} outlines=${persistence.outlineCount}；` +
      `localStorage keys=${persistence.localStorageKeys.length}（archive-batch ${persistence.archiveBatchKeys.length}）`,
  );
  if (screenshots?.desktopWriting) {
    // 桌面写作页截图在流程开头已拍；这里仅用于报告占位
  }
  await page.close();
  return persistence;
}

// ---------------------------------------------------------------- report

function renderReport({ checks, errors, persistenceByDevice, screenshots, mockLog, serverLog }) {
  const lines = [];
  lines.push('# 真机形态自动检查报告（Chromium 设备模拟，非物理真机）');
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString()}　脚本：\`ux/device-check.mjs\`（task-61）`);
  lines.push('> 说明：这是 Chromium 设备模拟，不是物理真机；物理真机人工项见文末清单。');
  lines.push('');
  lines.push('## 1. 设备与环境');
  lines.push('');
  lines.push('| 设备 | 视口 | 触摸 | DPR | Browser |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push('| iPhone 13（模拟） | 390×844 | 是（hasTouch） | 3 | chrome-headless-shell（Playwright 设备模拟） |');
  lines.push('| Desktop（模拟） | 1280×900 | 否 | 1 | chrome-headless-shell |');
  lines.push('');
  lines.push(`dev server：\`${BASE}\`（脚本自启自停，端口 5201）；mock：\`https://api.deepseek.com/**\` 归档 extract JSON，共 ${mockLog.length} 次非流式请求。`);
  lines.push('');
  lines.push('## 2. 每页检查结果');
  lines.push('');
  lines.push('检查项：横向溢出 `documentElement.scrollWidth <= innerWidth+1` 且 body 同样满足；关键按钮存在/可见/可用/水平在视口内；console.error、pageerror、未处理 Promise 计数。');
  lines.push('');
  lines.push('| 设备 | 页面 | overflow | 关键按钮 | 未处理 Promise |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const record of checks) {
    const buttons = record.buttons
      .map((item) => `${item.name}: ${item.exists && item.visible && item.enabled ? 'ok' : 'FAIL'}`)
      .join('；');
    lines.push(
      `| ${record.device} | ${record.pageName} | ${record.overflow.overflow ? '❌ 溢出' : '✅ 无'}（doc ${record.overflow.docScrollWidth} / inner ${record.overflow.innerWidth}） | ${buttons || '—'} | ${record.unhandled.length} |`,
    );
  }
  lines.push('');
  lines.push('## 3. 报错');
  lines.push('');
  if (errors.length === 0) {
    lines.push('✅ console.error / pageerror / unhandledrejection 合计 **0**。');
  } else {
    lines.push(`❌ 共 ${errors.length} 条：`);
    lines.push('');
    for (const error of errors) lines.push(`- [${error.device}] ${error.kind}：${error.message}`);
  }
  const unhandled = checks.flatMap((record) => record.unhandled.map((item) => ({ device: record.device, item })));
  if (unhandled.length > 0) {
    lines.push('');
    lines.push('未处理 Promise：');
    for (const entry of unhandled) lines.push(`- [${entry.device}] ${entry.item}`);
  }
  lines.push('');
  lines.push('## 4. 刷新持久化（IndexedDB + localStorage）');
  lines.push('');
  lines.push('| 设备 | IndexedDB novels / chapters / outlines | archive-batch keys | archive-settings | llm-settings | active-novel |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const [device, persistence] of Object.entries(persistenceByDevice)) {
    lines.push(
      `| ${device} | ${persistence.novelCount} / ${persistence.chapterCount} / ${persistence.outlineCount} | ${persistence.archiveBatchKeys.length} | ${persistence.hasArchiveSettings ? '✅' : '❌'} | ${persistence.hasLlmSettings ? '✅' : '❌'} | ${persistence.hasActiveNovel ? '✅' : '❌'} |`,
    );
  }
  lines.push('');
  lines.push('## 5. 截图');
  lines.push('');
  for (const file of Object.values(screenshots).filter(Boolean)) {
    lines.push(`- \`ux/device-check/${file}\``);
  }
  lines.push('');
  lines.push('## 6. 结论');
  lines.push('');
  const overflowFailures = checks.filter((record) => record.overflow.overflow);
  const buttonFailures = checks.flatMap((record) =>
    record.buttons.filter((button) => !(button.exists && button.visible && button.enabled)),
  );
  const persistenceFailures = Object.values(persistenceByDevice).filter(
    (persistence) =>
      persistence.novelCount < 2 ||
      !persistence.hasArchiveSettings ||
      !persistence.hasLlmSettings ||
      persistence.archiveBatchKeys.length === 0,
  );
  if (
    overflowFailures.length === 0 &&
    buttonFailures.length === 0 &&
    errors.length === 0 &&
    unhandled.length === 0 &&
    persistenceFailures.length === 0
  ) {
    lines.push('✅ **通过**：两设备主流程 0 横向溢出、关键按钮均可见可用、0 console/page 错误、0 未处理 Promise；刷新后 IndexedDB 与 localStorage 设置均在。');
  } else {
    lines.push('❌ **存在失败项**：');
    if (overflowFailures.length) lines.push(`- 横向溢出：${overflowFailures.map((record) => `${record.device}/${record.pageName}`).join('、')}`);
    if (buttonFailures.length) lines.push(`- 关键按钮异常：${buttonFailures.map((button) => button.name).join('、')}`);
    if (errors.length) lines.push(`- 报错 ${errors.length} 条（见 §3）`);
    if (unhandled.length) lines.push(`- 未处理 Promise ${unhandled.length} 条（见 §3）`);
    if (persistenceFailures.length) lines.push('- 刷新持久化缺失（见 §4）');
  }
  lines.push('');
  lines.push('## 7. 物理真机仍需人工（本检查不能替代）');
  lines.push('');
  lines.push('- 手机扫码访问 dev server（同 Wi-Fi / HTTPS / 防火墙），确认实际局域网加载与 API Key 不受浏览器安全策略影响；');
  lines.push('- 安装到主屏（PWA / iOS Safari「添加到主屏幕」），检查图标、启动图、全屏 safe-area（刘海/底部 Home indicator）；');
  lines.push('- 真实触摸滚动、惯性滚动、双指缩放、长按选择、输入框聚焦时的软键盘遮挡与 `visualViewport` 变化；');
  lines.push('- iOS Safari 私有模式/存储配额下的 localStorage 行为与 IndexedDB 驱逐；Android Chrome 与微信内置浏览器的差异；');
  lines.push('- 真实网络延迟与真实模型（真实 API Key）下的流式正文、归档 extract、续写 outline-continue 的耗时/错误；');
  lines.push('- 真实设备字体渲染与 DPR 截图（本报告为 Chromium 模拟，DPR3 仅为截图密度）；');
  lines.push('- 无障碍/读屏（VoiceOver/TalkBack）与深色模式（本检查未覆盖）。');
  lines.push('');
  lines.push('## 8. 附：mock 请求记录');
  lines.push('');
  for (const item of mockLog) lines.push(`- ${item.at} stream=${item.stream} model=${item.model}`);
  if (serverLog.length > 0) {
    lines.push('');
    lines.push('（dev server 输出已省略；非空表示启动日志。）');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  const checks = [];
  const errors = [];
  const mockLog = [];
  const serverLog = [];
  const persistenceByDevice = {};
  const screenshots = {
    writing: 'device-mobile-writing.png',
    backfill: 'device-mobile-backfill.png',
    archive: 'device-mobile-archive.png',
    desktopWriting: 'device-desktop-writing.png',
  };
  let server;
  let browser;
  try {
    server = startDevServer(serverLog);
    await waitForServer(BASE);
    log('00', 'dev server 就绪', BASE);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    log('00', '启动 chrome-headless-shell', CHROME);

    // ---- iPhone 13 设备模拟 ----
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    await mobileContext.addInitScript(() => {
      localStorage.setItem(
        'myliterature.llm-settings',
        JSON.stringify({
          state: {
            presetId: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-device-check-fake-key',
            model: 'deepseek-flash',
            strongModel: 'deepseek-v4-pro',
            capabilities: { jsonSchema: false, thinkingToggle: true, reasoningEffort: true, streamUsage: true },
          },
          version: 0,
        }),
      );
      localStorage.setItem(
        'myliterature.archive-settings',
        JSON.stringify({ state: { autoArchive: true, extractEntries: true }, version: 0 }),
      );
      window.__deviceCheckUnhandled = [];
      window.addEventListener('unhandledrejection', (event) => {
        window.__deviceCheckUnhandled.push(String(event.reason));
      });
    });
    if (mobileContext.touchscreen) {
      log('00', 'iPhone 13 触屏上下文', 'hasTouch=true / viewport 390×844 / DPR3');
    }
    persistenceByDevice['iPhone 13'] = await runMainFlow({
      device: 'iPhone 13',
      context: mobileContext,
      checks,
      errors,
      mockLog,
      screenshots: { writing: screenshots.writing, backfill: screenshots.backfill, archive: screenshots.archive },
    });
    await mobileContext.close();

    // ---- 桌面 1280×900 ----
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    await desktopContext.addInitScript(() => {
      localStorage.setItem(
        'myliterature.llm-settings',
        JSON.stringify({
          state: {
            presetId: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-device-check-fake-key',
            model: 'deepseek-flash',
            strongModel: 'deepseek-v4-pro',
            capabilities: { jsonSchema: false, thinkingToggle: true, reasoningEffort: true, streamUsage: true },
          },
          version: 0,
        }),
      );
      localStorage.setItem(
        'myliterature.archive-settings',
        JSON.stringify({ state: { autoArchive: true, extractEntries: true }, version: 0 }),
      );
      window.__deviceCheckUnhandled = [];
      window.addEventListener('unhandledrejection', (event) => {
        window.__deviceCheckUnhandled.push(String(event.reason));
      });
    });
    persistenceByDevice['Desktop 1280×900'] = await runMainFlow({
      device: 'Desktop 1280×900',
      context: desktopContext,
      checks,
      errors,
      mockLog,
      screenshots: { writing: screenshots.desktopWriting },
    });
    await desktopContext.close();

    const report = renderReport({ checks, errors, persistenceByDevice, screenshots, mockLog, serverLog });
    writeFileSync(join(OUT_DIR, 'report.md'), report);
    writeFileSync(join(OUT_DIR, 'transcript.txt'), `${transcript.join('\n')}\n`);
    log('done', '检查完成', `checks=${checks.length} errors=${errors.length} 报告=ux/device-check/report.md`);

    const failed =
      checks.some((record) => record.overflow.overflow || record.unhandled.length > 0) ||
      checks.some((record) => record.buttons.some((button) => !(button.exists && button.visible && button.enabled))) ||
      errors.length > 0;
    if (failed) process.exitCode = 1;
  } catch (error) {
    log('!!', '检查中断', String(error?.stack ?? error).slice(0, 1200));
    try {
      writeFileSync(
        join(OUT_DIR, 'report.md'),
        `# 真机形态自动检查报告（失败）\n\n脚本中断：\n\n\`\`\`\n${String(error?.stack ?? error)}\n\`\`\`\n`,
      );
      writeFileSync(join(OUT_DIR, 'transcript.txt'), `${transcript.join('\n')}\n`);
    } catch {
      // ignore
    }
    process.exitCode = 1;
    throw error;
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    await stopDevServer(server);
    try {
      writeFileSync(join(OUT_DIR, 'transcript.txt'), `${transcript.join('\n')}\n`);
    } catch {
      // ignore
    }
    log('99', 'server 已停止', 'report/transcript 已写入 ux/device-check/');
  }
}

main().then(
  () => {
    console.log('\n✅ 真机形态检查完成：ux/device-check/report.md');
  },
  (error) => {
    console.error('\n❌ 真机形态检查失败：', error);
    process.exitCode = 1;
  },
);
