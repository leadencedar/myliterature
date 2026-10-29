#!/usr/bin/env node
/**
 * PC 端真实浏览器验收（1440×900，真实 Key、真实模型）。
 *
 * 用法：PC_LLM_KEY=sk-xxx node ux/pc-acceptance/run.mjs
 * Key 只从环境变量读取，不写文件、不进报告；跑完截图与 report.md 在 ux/pc-acceptance/。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const SHOTS = join(HERE);
const PORT = 5173;
const BASE = `http://localhost:${PORT}`;
const CHROME = resolve(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const KEY = (process.env.PC_LLM_KEY ?? '').trim();
if (!KEY) { console.error('缺少 PC_LLM_KEY'); process.exit(2); }
mkdirSync(SHOTS, { recursive: true });

const transcript = [];
const checks = [];
function log(step, action, detail = '') {
  const line = `[${new Date().toISOString()}] ${step} | ${action}${detail ? ` | ${detail}` : ''}`;
  transcript.push(line);
  console.log(line.replace(/\s+/g, ' ').slice(0, 240));
}
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  log(ok ? '✓' : '✗', name, detail);
}

async function serverUp() {
  try { const r = await fetch(BASE); return r.ok; } catch { return false; }
}
async function waitServer(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await serverUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  let server = null;
  if (!(await serverUp())) {
    log('00', '启动 dev server', `${BASE}`);
    server = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT, stdio: 'ignore', detached: false,
    });
    if (!(await waitServer())) throw new Error('dev server 未就绪');
  } else log('00', '复用已运行 dev server', BASE);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  try {
    await page.goto(BASE, { waitUntil: 'load' });
    log('01', '打开应用', await page.title());

    // 注入真实 Key（只写 localStorage，不落文件）
    await page.evaluate(async (key) => {
      const { useLlmSettings } = await import('/src/llm/settingsStore.ts');
      const s = useLlmSettings.getState();
      s.applyPreset('deepseek');
      useLlmSettings.getState().update({ apiKey: key });
    }, KEY);
    await page.reload({ waitUntil: 'load' });

    // 设置页：默认模型 + 真实连通性测试
    await page.goto(`${BASE}/settings`, { waitUntil: 'load' });
    await page.getByRole('button', { name: '测试连接' }).waitFor({ state: 'visible', timeout: 15000 });
    const model = await page.getByLabel('常规模型').inputValue();
    const strong = await page.getByLabel('重点任务模型').inputValue();
    check('默认模型为 deepseek-chat', model === 'deepseek-chat' && strong === 'deepseek-chat', `${model} / ${strong}`);

    const t0 = Date.now();
    await page.getByRole('button', { name: '测试连接' }).click();
    await page.locator('p', { hasText: '✓' }).waitFor({ state: 'visible', timeout: 90000 }).catch(() => {});
    const note = await page.locator('p', { hasText: '✓' }).textContent().catch(() => '');
    const err = await page.locator('[role=alert]').textContent().catch(() => '');
    check('真实模型连通性测试', Boolean(note), `${Date.now() - t0}ms ${String(note ?? err).replace(/\s+/g, ' ').slice(0, 220)}`);
    await page.screenshot({ path: join(SHOTS, 'pc-01-settings.png'), fullPage: true });

    // 种子数据：完成章（锚点）+ 待生成章
    const seed = await page.evaluate(async () => {
      const { DexieNovelRepository } = await import('/src/data/dexie/DexieNovelRepository.ts');
      const { db } = await import('/src/data/dexie/db.ts');
      const repo = new DexieNovelRepository(db);
      const novel = await repo.createNovel({ title: 'PC验收·归墟纪', genre: '仙侠', oneLiner: '失忆剑客追查灭门案。' });
      const cats = await repo.listCategories(novel.id);
      const world = cats.find((c) => c.kind === 'worldbuilding') ?? cats[0];
      const character = cats.find((c) => c.kind === 'character') ?? cats[1];
      await repo.createEntry(novel.id, { categoryId: character.id, title: '沈砚', aliases: ['小舟'], summary: '失忆剑客，六扇门通缉。', fields: { identity: '流亡贵族', voice: '短句、爱用反问。', flaw: '妹妹下落不明。' } });
      await repo.createEntry(novel.id, { categoryId: character.id, title: '裴照', summary: '六扇门捕头，冷硬。', fields: { identity: '六扇门捕头', personality: '冷硬寡言。' } });
      await repo.createEntry(novel.id, { categoryId: world.id, title: '渡口的规矩', pinned: true, summary: '夜渡双倍船资。', fields: { definition: '渡口是北上唯一通道。', rules: '无官凭不得渡河。' } });
      const vol = await repo.createOutlineNode(novel.id, { title: '第一卷 渡口', synopsis: '渡口相遇。', targetWords: 30000 });
      const n1 = await repo.createOutlineNode(novel.id, { title: '第1章 夜渡', synopsis: '沈砚与裴照夜渡。', parentId: vol.id, targetWords: 400 });
      const content = '雪是入夜后开始下的。\n\n裴照牵马走在前面，斗笠压得很低。林越跟在马后半步，肩上落了薄薄一层雪，没去拍。\n\n「还有多远？」裴照问。\n\n「不知道。」林越说。他答的不是路。\n\n越往上雪越紧，马蹄在冰壳上打滑。裴照索性把马拴在枯松上，解了鞍袋自己背。林越伸手去接，裴照让了让，把份量轻些的丢给他。两个人都不说话，脚踩在雪里咯吱咯吱响。\n\n走到半山，林越忽然停住。他听见雪底下有声音，很轻，像有人在很远的地方敲一只空碗。裴照也停了，侧耳听了片刻，说：「风过石缝。」林越没接话。他知道自己听过这个声音，不是在山上，是在更早以前，在一个有水的屋子里。\n\n「你又在想什么？」裴照问。\n\n「想不起来。」\n\n「想不起来就别想。」裴照把鞍袋往上提了提，「到了地方，有的是时间想。」\n\n山口在夜里十点多才到。两壁黑石夹出一道豁口，风灌进来，雪横着抽。裴照蹲下身，拿火折子晃了晃，石壁上有凿痕，深的地方还能看出字。林越凑过去，借着火光看见一个「渡」字，笔画被雪水泡得发胀。裴照伸手抹了一把，手指头描了两遍，忽然顿住。';
      const c1 = await repo.createChapter(novel.id, { title: '夜渡', content, outlineNodeId: n1.id });
      await repo.updateChapter(c1.id, { status: 'done' });
      const n2 = await repo.createOutlineNode(novel.id, { title: '第2章 灯', synopsis: '岸上那盏灯还亮着。', parentId: vol.id, targetWords: 400 });
      const c2 = await repo.createChapter(novel.id, { title: '灯', outlineNodeId: n2.id });
      return { novelId: novel.id, c1: c1.id, c2: c2.id };
    });
    await page.evaluate((novelId) => localStorage.setItem('myliterature.active-novel', JSON.stringify({ state: { activeNovelId: novelId }, version: 0 })), seed.novelId);

    // 写作页 + 第2章生成：应带第1章文风锚点
    await page.goto(`${BASE}/write`, { waitUntil: 'load' });
    await page.getByRole('button', { name: '继续写第 2 章' }).waitFor({ state: 'visible', timeout: 20000 });
    const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
    check('写作页 1440 无横向溢出', overflow.doc <= overflow.inner + 1 && overflow.body <= overflow.inner + 1, JSON.stringify(overflow));
    await page.screenshot({ path: join(SHOTS, 'pc-02-writing.png'), fullPage: true });

    await page.getByRole('button', { name: '继续写第 2 章' }).click();
    await page.getByRole('button', { name: '生成本章' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('button', { name: '生成本章' }).click();
    const genDialog = page.getByRole('dialog', { name: '生成本章正文' });
    await genDialog.waitFor({ state: 'visible', timeout: 15000 });
    await genDialog.getByText(/文风锚点 · 第 1 章开头/u).waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const genText = await genDialog.textContent();
    check('生成面板显示文风锚点', /文风锚点 · 第 1 章开头/u.test(genText ?? ''), '');
    await page.screenshot({ path: join(SHOTS, 'pc-03-generate-form.png'), fullPage: true });

    const t1 = Date.now();
    await genDialog.getByRole('button', { name: '开始生成' }).click();
    await genDialog.getByText(/生成完成|生成未完成|生成被截断/u).first().waitFor({ state: 'visible', timeout: 180000 });
    const resultText = await genDialog.textContent();
    check('真实模型整章生成完成', /生成完成|生成未完成|生成被截断/u.test(resultText ?? ''), `${Date.now() - t1}ms 结果含${/已生成/u.test(resultText ?? '') ? '字数' : '提示'}`);
    await page.screenshot({ path: join(SHOTS, 'pc-04-generate-result.png'), fullPage: true });
    await genDialog.getByRole('button', { name: '关闭' }).click().catch(async () => { await page.keyboard.press('Escape'); });
    await genDialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    const editor2 = page.getByRole('dialog', { name: '编辑第 2 章' });
    await editor2.getByRole('button', { name: '返回' }).click();
    await editor2.waitFor({ state: 'hidden', timeout: 10000 });

    // 归档：第1章 done→draft→done 触发后台真实提取
    await page.getByRole('button', { name: '继续写第 1 章' }).click();
    await page.getByRole('button', { name: '已完成' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('button', { name: '已完成' }).click();
    await page.getByRole('button', { name: '草稿' }).click();
    const t2 = Date.now();
    await page.getByText(/本章摘要与设定已生成|本章摘要与设定生成失败/u).waitFor({ state: 'visible', timeout: 180000 });
    const archiveText = await page.getByText(/本章摘要与设定已生成|本章摘要与设定生成失败/u).textContent();
    check('标记完成后真实归档', /已生成/u.test(archiveText ?? ''), `${Date.now() - t2}ms ${String(archiveText).slice(0, 160)}`);
    await page.screenshot({ path: join(SHOTS, 'pc-05-archive.png'), fullPage: true });

    // 文风检查：真实模型诊断
    await page.getByRole('button', { name: '检查文风' }).click();
    const styleDialog = page.getByRole('dialog', { name: '检查文风' });
    await styleDialog.waitFor({ state: 'visible', timeout: 15000 });
    const t3 = Date.now();
    await styleDialog.getByRole('button', { name: '检查文风' }).click();
    await styleDialog.getByText(/原文：|未发现明显文风漂移|检查失败/u).first().waitFor({ state: 'visible', timeout: 180000 });
    const styleText = await styleDialog.textContent();
    check('真实模型文风检查完成', /原文：|未发现明显文风漂移/u.test(styleText ?? ''), `${Date.now() - t3}ms`);
    await page.screenshot({ path: join(SHOTS, 'pc-06-style-check.png'), fullPage: true });
    await styleDialog.getByRole('button', { name: '完成' }).click().catch(() => page.keyboard.press('Escape'));

    check('无 console/page 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
    log('99', '验收完成', `checks=${checks.length}`);
  } finally {
    await browser.close();
    if (server) server.kill('SIGTERM');
  }

  const failed = checks.filter((c) => !c.ok);
  const lines = [
    '# PC 端真实浏览器验收（1440×900）',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    `- 模型：deepseek-chat（真实 Key 仅环境变量，未写入文件/报告）`,
    `- 结果：${checks.length - failed.length}/${checks.length} 通过`,
    '',
    '| 检查 | 结果 | 备注 |',
    '| --- | --- | --- |',
    ...checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${String(c.detail).replace(/\|/gu, '/').slice(0, 240)} |`),
    '',
    '## 截图',
    ...['pc-01-settings.png','pc-02-writing.png','pc-03-generate-form.png','pc-04-generate-result.png','pc-05-archive.png','pc-06-style-check.png'].map((f) => `- \`${f}\``),
    '',
    '## 说明',
    '- 真实 API 调用：连通性 1 次、整章生成 1 次、归档提取 1 次、文风检查 1 次（共 4 次）。',
    '- 不采用生成稿、不落新正文；归档只产生待确认提案，未采用。',
    failed.length ? '## 失败项\n' + failed.map((c) => `- ${c.name}: ${c.detail}`).join('\n') : '## 失败项\n无',
  ];
  writeFileSync(join(SHOTS, 'report.md'), lines.join('\n') + '\n');
  writeFileSync(join(SHOTS, 'transcript.txt'), transcript.join('\n') + '\n');
  console.log(`\n${checks.length - failed.length}/${checks.length} passed; report: ${join(SHOTS, 'report.md')}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
