#!/usr/bin/env node
/**
 * task-66 独立行为验证：DeepSeek 预置模型名 = deepseek-chat。
 *
 * 不写 src/、不改 feature/测试；用真浏览器 + dev server 做运行时验证：
 *  1) 动态 import 运行时读取 PROVIDER_PRESETS / applyPreset / resolveModel；
 *  2) SettingsPage 输入框值与 placeholder；
 *  3) 手动改模型名的保存路径（localStorage persist）；
 *  4) 真实请求体 model：连通性测试（常规）与 outline-continue（重点任务）。
 * 输出：终端结果 + behavior-check.json（同目录）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIR, '../../..'); // .agents/tasks/model-preset-fix → repo root
const PORT = 5202;
const BASE = `http://localhost:${PORT}`;
const CHROME = resolve(
  process.env.HOME ?? '',
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` | ${detail}` : ''}`);
}

function cors() {
  return {
    'access-control-allow-origin': BASE,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'content-type': 'application/json; charset=utf-8',
  };
}

const frontier = {
  chapters: Array.from({ length: 3 }, (_, index) => ({
    title: `续章${index + 1}`,
    synopsis: `第 ${index + 1} 章梗概。`,
    targetWords: 3000,
    scenes: ['场景一', '场景二', '场景三'],
    conflict: '冲突',
    hook: '钩子',
    usesEntries: [],
    resolvesThreads: [],
    plantsThreads: [],
  })),
};

async function waitForServer(url, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dev server 未就绪：${url}`);
}

async function main() {
  const server = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  const bodies = [];
  try {
    await waitForServer(BASE);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.route('https://api.deepseek.com/**', async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors() });
      let body = {};
      try {
        body = JSON.parse(request.postData() ?? '{}');
      } catch {
        body = {};
      }
      bodies.push({ stream: body.stream === true, model: body.model ?? null, maxTokens: body.max_tokens ?? null });
      if (body.stream) {
        return route.fulfill({
          status: 200,
          headers: { ...cors(), 'content-type': 'text/event-stream; charset=utf-8' },
          body:
            `data: ${JSON.stringify({ choices: [{ delta: { content: '雨夜旧书店。' } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
            'data: [DONE]\n\n',
        });
      }
      return route.fulfill({
        status: 200,
        headers: cors(),
        body: JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          created: 0,
          model: body.model ?? 'deepseek-chat',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(frontier) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      });
    });

    // 1) 运行时预设 / applyPreset / resolveModel
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const runtime = await page.evaluate(async () => {
      const { PROVIDER_PRESETS } = await import('/src/llm/presets.ts');
      const { useLlmSettings } = await import('/src/llm/settingsStore.ts');
      const { resolveModel } = await import('/src/llm/useLlm.ts');
      const preset = PROVIDER_PRESETS.deepseek;
      useLlmSettings.getState().applyPreset('deepseek');
      const settings = useLlmSettings.getState();
      return {
        presetModel: preset.model,
        presetStrongModel: preset.strongModel,
        storeModel: settings.model,
        storeStrongModel: settings.strongModel,
        chapterDraft: resolveModel(settings, 'chapter-draft'),
        outlineContinue: resolveModel(settings, 'outline-continue'),
        connectivity: resolveModel(settings, 'connectivity-test'),
        strongTasks: Object.keys(settings).length, // 占位不用
      };
    });
    check('PRESET.model === deepseek-chat', runtime.presetModel === 'deepseek-chat', runtime.presetModel);
    check('PRESET.strongModel === deepseek-chat', runtime.presetStrongModel === 'deepseek-chat', runtime.presetStrongModel);
    check('applyPreset 后 store.model === deepseek-chat', runtime.storeModel === 'deepseek-chat', runtime.storeModel);
    check('applyPreset 后 store.strongModel === deepseek-chat', runtime.storeStrongModel === 'deepseek-chat', runtime.storeStrongModel);
    check('chapter-draft 解析模型 = deepseek-chat', runtime.chapterDraft === 'deepseek-chat', runtime.chapterDraft);
    check('outline-continue（重点任务）解析模型 = deepseek-chat', runtime.outlineContinue === 'deepseek-chat', runtime.outlineContinue);

    // 连通性测试需要「已配置」：填一个假 Key（端点被 route 拦截，不产生真实请求）
    await page.evaluate(async () => {
      const { useLlmSettings } = await import('/src/llm/settingsStore.ts');
      useLlmSettings.getState().update({ apiKey: 'sk-test-fake-key' });
    });

    // 2) SettingsPage 输入框值与 placeholder
    await page.goto(`${BASE}/settings`, { waitUntil: 'load' });
    await page.getByLabel('常规模型').waitFor({ state: 'visible', timeout: 15_000 });
    const normalValue = await page.getByLabel('常规模型').inputValue();
    const normalPlaceholder = await page.getByLabel('常规模型').getAttribute('placeholder');
    const strongValue = await page.getByLabel('重点任务模型').inputValue();
    const strongPlaceholder = await page.getByLabel('重点任务模型').getAttribute('placeholder');
    check('SettingsPage 常规模型值 = deepseek-chat', normalValue === 'deepseek-chat', normalValue);
    check('SettingsPage 常规模型 placeholder = deepseek-chat', normalPlaceholder === 'deepseek-chat', normalPlaceholder ?? '');
    check('SettingsPage 重点任务模型值 = deepseek-chat', strongValue === 'deepseek-chat', strongValue);
    check('SettingsPage 重点任务模型 placeholder = deepseek-chat', strongPlaceholder === 'deepseek-chat', strongPlaceholder ?? '');

    // 3) 用户手动改模型名：保存到 persist 并参与解析
    await page.getByLabel('常规模型').fill('my-custom-model');
    await page.getByLabel('常规模型').press('Tab');
    await page.waitForTimeout(200);
    const manual = await page.evaluate(async () => {
      const { useLlmSettings } = await import('/src/llm/settingsStore.ts');
      const { resolveModel } = await import('/src/llm/useLlm.ts');
      const raw = localStorage.getItem('myliterature.llm-settings');
      return {
        storeModel: useLlmSettings.getState().model,
        persistedModel: raw ? JSON.parse(raw).state.model : null,
        resolveChapter: resolveModel(useLlmSettings.getState(), 'chapter-draft'),
      };
    });
    check('手动改模型名保存到 store', manual.storeModel === 'my-custom-model', manual.storeModel);
    check('手动改模型名持久化到 localStorage', manual.persistedModel === 'my-custom-model', String(manual.persistedModel));
    check('手动改模型名参与请求解析', manual.resolveChapter === 'my-custom-model', manual.resolveChapter);
    // 恢复 preset，避免影响后续请求
    await page.evaluate(async () => {
      const { useLlmSettings } = await import('/src/llm/settingsStore.ts');
      useLlmSettings.getState().applyPreset('deepseek');
      useLlmSettings.getState().update({ apiKey: 'sk-test-fake-key' });
    });

    // 4) 真实请求体 model：连通性测试（stream）
    await page.getByRole('button', { name: '测试连接' }).click();
    await page.waitForTimeout(800);
    const connectivityBody = bodies.find((item) => item.stream === true);
    check('连通性测试请求体 model = deepseek-chat', connectivityBody?.model === 'deepseek-chat', String(connectivityBody?.model));

    // 5) 真实请求体 model：outline-continue（重点任务，非流式）
    const seed = await page.evaluate(async () => {
      const { DexieNovelRepository } = await import('/src/data/dexie/DexieNovelRepository.ts');
      const { db } = await import('/src/data/dexie/db.ts');
      const repo = new DexieNovelRepository(db);
      const novel = await repo.createNovel({ title: '模型名验证书', genre: '仙侠' });
      // 有大纲才会出现「规划后续 3–5 章大纲」入口（有章节无大纲时显示的是回溯入口，两者互斥）
      await repo.createOutlineNode(novel.id, { title: '第一卷', synopsis: '主角出发。' });
      await repo.createChapter(novel.id, { title: '第一章', content: '正文。' });
      return { novelId: novel.id };
    });
    await page.evaluate(
      (id) =>
        localStorage.setItem(
          'myliterature.active-novel',
          JSON.stringify({ state: { activeNovelId: id }, version: 0 }),
        ),
      seed.novelId,
    );
    await page.goto(`${BASE}/write`, { waitUntil: 'load' });
    await page.getByRole('button', { name: '规划后续 3–5 章大纲' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('button', { name: '规划后续 3–5 章大纲' }).click();
    const dialog = page.getByRole('dialog', { name: '规划后续 3–5 章大纲' });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: '规划 3 章大纲' }).click();
    await page.waitForTimeout(1200);
    const continueBody = bodies.filter((item) => item.stream !== true).at(-1);
    check('outline-continue 请求体 model = deepseek-chat', continueBody?.model === 'deepseek-chat', String(continueBody?.model));
    check('本轮无 pageerror', pageErrors.length === 0, pageErrors.join(';').slice(0, 200));

    writeFileSync(join(DIR, 'behavior-check.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), results, bodies, pageErrors }, null, 2)}\n`);
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      // ignore
    }
    const failed = results.filter((item) => !item.ok);
    console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`}（${results.length} 项）`);
    if (failed.length > 0) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('检查失败：', error);
  process.exitCode = 1;
});
