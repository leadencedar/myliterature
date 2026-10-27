#!/usr/bin/env node
/**
 * M1 体验沙盒：假模型 + 真浏览器（Playwright / chrome-headless-shell）。
 *
 * 目的：让文学顾问能在真实 DOM/真实 IndexedDB 里「作为用户」走一遍 M1 新交互：
 *   写作页 → 节点抽屉（「本次注入」清单）→ 细化 → 采用 → 关联确认（「确认关联（N 条）」）
 *   → 章节编辑器 → 生成本章（目标来源 + 具体场景区间）→ 开始生成 → 截断提示（X 字 / 目标 N 字）
 *   → 采用二次确认 → 编辑器「未完成生成稿」提示条 →（可选）已完成章节退回草稿。
 *
 * 只读仓库代码：本脚本不改 feature/测试/package，只在 ux/ 下产出截图与记录。
 * 模型输出全部是**演示用假数据**，不代表真实文风质量；走查只评信息与流程。
 *
 * 运行：node .agents/tasks/outline-context-scene/ux/run-demo.mjs
 * 产物：ux/shots/after-*.png、ux/shots/transcript.txt、ux/shots/walkthrough-data.json
 * （shots/01…09-*.png 是 UX 修复前 task-12 的 before 记录，保留不动。）
 *
 * 技术要点：
 * - 自己 spawn `npm run dev -- --port 5199 --strictPort`，就绪后跑，结束 kill（不占用 GUI 端口）。
 * - playwright-core + 本机 chrome-headless-shell（Lead 已装好，package.json 未改）。
 * - `page.route` 拦截 https://api.deepseek.com/**：OPTIONS 预检给 CORS 头；
 *   stream=false 返回 outline-expand JSON；stream=true 返回 SSE（正文 + finish_reason:"length"）。
 * - 页面内 dynamic import 同一份 Vite 模块实例（db 单例）种子数据；localStorage 预置假 Key。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const UX_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(UX_DIR, '../../../..');
const SHOTS_DIR = join(UX_DIR, 'shots');
const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const CHROME = resolve(
  process.env.HOME ?? '',
  'Library/Caches/ms-playwright/chromium_headless_shell-1234',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
);

// ---------------------------------------------------------------- 记录

const transcript = [];
function log(step, action, detail = '') {
  const line = `[${new Date().toISOString()}] ${step} | ${action}${detail ? ` | ${detail}` : ''}`;
  transcript.push(line);
  console.log(line.replace(/\s+/g, ' ').slice(0, 300));
}
function oneLine(value, max = 500) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------- 假模型数据

/** outline-expand（非流式）的假输出：3 张场景卡，点名沈砚/裴照 */
const EXPAND_RESULT = {
  children: [
    {
      title: '第1节 渡口相遇',
      synopsis:
        '沈砚在渡口被裴照拦下，官凭不在身上。裴照冷着脸要押他见官；沈砚怕妹妹的消息断在这里，先低头认了差事，用一句反问试裴照的底。结果：二人同船，沈砚的软肋第一次被裴照捏住。',
      targetWords: 2000,
    },
    {
      title: '第2节 船资',
      synopsis:
        '船夫索要双倍船资。沈砚拿不出钱，裴照袖手旁观。沈砚想起妹妹当年也是被这样拦在渡口，宁可挨打也不肯求裴照，最后拿亡母的旧簪抵账——选择改变了后文：裴照开始怀疑他的身份。',
      targetWords: 2000,
    },
    {
      title: '第3节 夜渡',
      synopsis:
        '夜渡时船底漏水，裴照逼沈砚下水堵漏，自己握刀守在船头。沈砚在冰冷河水里听见裴照与船夫低声提到「青冥宗」，疑心压过了恐惧。结尾：两人各怀心思上岸，谁也没亮底牌。',
      targetWords: 2000,
    },
  ],
};

/** chapter-draft（流式）的假正文：约 700 字，末尾故意 finish_reason:"length" 演示截断 */
const CHAPTER_TEXT = [
  '渡口的风比记忆里更冷。',
  '沈砚把衣领竖起来，还是觉得有针从颈后往里扎。他站在石阶最上面，看着浑黄的河水把碎冰推到岸边，一层一层，像谁在反复翻一桩旧案。',
  '「官凭。」',
  '裴照的声音从背后落下来，不高，却把周围几步都压出一圈静。沈砚没有回头。他知道那只手现在正按在刀柄上，指节发白——上一次见他，这只手也是这么按着刀，只是那时刀的对面是匪，不是自己。',
  '「丢了。」沈砚说。',
  '「丢了。」裴照重复了一遍，像在掂量这两个字的分量。他绕到沈砚面前，眼睛在他脸上停了停，又落到他腰间那只空了半截的荷包上。船夫在下面咳嗽了一声，把手里的缆绳换了换。',
  '「没有官凭，渡不了。」船夫说，「要么折回去，要么双倍船资。」',
  '沈砚把手探进荷包。里面只有几枚铜钱，和一枚旧得不辨纹样的簪子。他听见自己的心跳，比河声还响。妹妹走的那年也是这样的天。他攥着簪子站了一会儿，忽然觉得自己这些年其实一直没离开过这个渡口。',
  '「我押差事。」他说，声音低下去，却不抖，「到了北边，双倍还你。」',
  '裴照没有立刻答。他看了沈砚很久，久到船夫又咳了一声。然后他把刀往鞘里推了推，转身往船上走。',
  '「上船。」他说，「走夜路，别说话。」',
  '船离岸时，沈砚回头看了一眼。岸上的人已经散了，只剩一盏灯还亮着。他忽然不知道那盏灯是给谁的。',
  '河心风大。船底开始渗水，先是脚边一凉，后来水漫过脚背。船夫骂了一句，裴照把斗笠摘下来舀水，动作很稳。沈砚蹲下去，把袖子挽到肩上，手刚伸进水里，就听见裴照在头顶说——',
  '「青冥宗那边，还有人活着。」',
  '水很冷。沈砚的手指在水底僵了一瞬。他没有抬头，也没有问。',
  '船头灯影一晃，裴照已经转过身去。',
].join('');

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 把假正文拆成若干 delta 事件 + length 结束帧，模拟真实流式 */
function buildChapterSse() {
  const pieces = [];
  for (let index = 0; index < CHAPTER_TEXT.length; index += 64) {
    pieces.push(CHAPTER_TEXT.slice(index, index + 64));
  }
  const frames = pieces.map((piece) => sseFrame({ choices: [{ delta: { content: piece } }] }));
  frames.push(sseFrame({ choices: [{ delta: {}, finish_reason: 'length' }] }));
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

// ---------------------------------------------------------------- 假 LLM 拦截

function corsHeaders() {
  return {
    'access-control-allow-origin': BASE,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
  };
}

async function installModelMock(page, mockLog) {
  await page.route('https://api.deepseek.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: corsHeaders() });
    }
    let body = {};
    try {
      body = JSON.parse(request.postData() ?? '{}');
    } catch {
      body = {};
    }
    const stream = body.stream === true;
    mockLog.push({
      at: new Date().toISOString(),
      stream,
      model: body.model ?? '',
      response_format: body.response_format?.type ?? null,
      max_tokens: body.max_tokens ?? null,
      messages: Array.isArray(body.messages)
        ? body.messages.map((message) => ({ role: message.role, chars: String(message.content ?? '').length }))
        : [],
    });
    log(
      'mock',
      stream ? '流式请求（chapter-draft）' : '结构化请求（outline-expand）',
      `model=${body.model ?? '?'} max_tokens=${body.max_tokens ?? '无'} response_format=${body.response_format?.type ?? '无'} messages=${JSON.stringify(
        (body.messages ?? []).map((message) => `${message.role}:${String(message.content ?? '').length}字`),
      )}`,
    );
    if (stream) {
      return route.fulfill({
        status: 200,
        headers: { ...corsHeaders(), 'content-type': 'text/event-stream; charset=utf-8' },
        body: buildChapterSse(),
      });
    }
    return route.fulfill({
      status: 200,
      headers: { ...corsHeaders(), 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        id: 'mock-completion',
        object: 'chat.completion',
        created: 0,
        model: body.model ?? 'deepseek-flash',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(EXPAND_RESULT) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    });
  });
}

// ---------------------------------------------------------------- 服务与浏览器

async function waitForServer(url, timeoutMs = 90_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // 服务还没起来
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
  child.stdout.on('data', (chunk) => {
    serverLog.push(String(chunk));
  });
  child.stderr.on('data', (chunk) => {
    serverLog.push(String(chunk));
  });
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
    // 已经退出
  }
}

// ---------------------------------------------------------------- 走查辅助

/** 等抽屉/弹层里某段文案出现 */
async function waitText(page, text, timeout = 15_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

async function shot(page, step, name, note = '') {
  await page.waitForTimeout(350);
  const path = join(SHOTS_DIR, name);
  await page.screenshot({ path });
  log(step, `截图 ${name}`, note);
}

async function visibleText(locator, max = 700) {
  try {
    return oneLine(await locator.innerText({ timeout: 3_000 }), max);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const serverLog = [];
  const mockLog = [];
  const pageErrors = [];
  const server = startDevServer(serverLog);
  let browser;
  try {
    log('00', '启动 dev server', `${BASE}（port ${PORT}，strictPort）`);
    await waitForServer(`${BASE}/`);
    log('00', 'dev server 就绪');

    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    log('00', '启动 chrome-headless-shell', CHROME);

    // 手机视口为主（390×844），截图 2x 便于阅读
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
    });

    // 假 LLM 设置：应用加载前写入（zustand persist 格式）
    await context.addInitScript(() => {
      localStorage.setItem(
        'myliterature.llm-settings',
        JSON.stringify({
          state: {
            presetId: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-demo-fake-key-for-ux-sandbox',
            model: 'deepseek-flash',
            strongModel: 'deepseek-v4-pro',
            capabilities: {
              jsonSchema: false,
              thinkingToggle: true,
              reasoningEffort: true,
              streamUsage: true,
            },
          },
          version: 0,
        }),
      );
    });

    const page = await context.newPage();
    page.on('pageerror', (error) => {
      pageErrors.push(String(error));
      log('!!', '页面异常', String(error).slice(0, 300));
    });
    page.on('console', (message) => {
      if (message.type() === 'error') log('console.error', oneLine(message.text(), 300));
    });
    await installModelMock(page, mockLog);

    // 1) 打开应用（此时书架为空，但模块已加载），用页面内 dynamic import 种子数据
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    log('01', '打开应用首页', oneLine(await visibleText(page.locator('body'), 160)));

    const seed = await page.evaluate(async () => {
      const { DexieNovelRepository } = await import('/src/data/dexie/DexieNovelRepository.ts');
      const { db } = await import('/src/data/dexie/db.ts');
      const repo = new DexieNovelRepository(db);
      const novel = await repo.createNovel({
        title: '归墟纪',
        genre: '仙侠',
        pov: 'third-limited',
        oneLiner: '失忆剑客追查灭门案，在渡口被迫与旧敌同船。',
      });
      const categories = await repo.listCategories(novel.id);
      const worldCategory = categories.find((category) => category.kind === 'worldbuilding') ?? categories[0];
      const characterCategory = categories.find((category) => category.kind === 'character') ?? categories[1];

      const shen = await repo.createEntry(novel.id, {
        categoryId: characterCategory.id,
        title: '沈砚',
        aliases: ['小舟'],
        summary: '失忆的流亡剑客，六扇门通缉。',
        fields: {
          identity: '流亡贵族，六扇门通缉。',
          voice: '短句、爱用反问。',
          flaw: '妹妹下落不明——这是他唯一的软肋。',
          relations: '与裴照有旧怨，但说不清旧怨从何而起。',
        },
      });
      const pei = await repo.createEntry(novel.id, {
        categoryId: characterCategory.id,
        title: '裴照',
        summary: '六扇门捕头，冷硬，不轻易交底。',
        fields: {
          identity: '六扇门捕头，负责追查青冥宗灭门案。',
          personality: '冷硬、寡言，习惯先动手再讲理。',
          relations: '与沈砚有旧怨；当年在渡口见过他妹妹。',
        },
      });
      const rule = await repo.createEntry(novel.id, {
        categoryId: worldCategory.id,
        title: '渡口的规矩',
        pinned: true,
        summary: '北方渡口只认官凭；夜渡双倍船资。',
        fields: {
          definition: '渡口是北上唯一通道，官凭是唯一的通行凭证。',
          rules: '无官凭者不得渡河；夜渡加倍收费；船夫不得私放人过河。',
          cost: '贿赂船夫一旦被查，连同船之人一起连坐。',
        },
      });

      const volume = await repo.createOutlineNode(novel.id, {
        title: '第一卷 渡口',
        synopsis: '沈砚在渡口与裴照相遇，被迫接下去北方的差事。',
        targetWords: 30000,
      });
      const secondVolume = await repo.createOutlineNode(novel.id, {
        title: '第二卷 夜渡',
        synopsis: '二人同船北上，各怀心思。',
      });
      const chapterNode = await repo.createOutlineNode(novel.id, {
        title: '第1章 夜渡',
        synopsis: '沈砚与裴照夜渡，船夫的规矩逼他做一次选择。',
        parentId: secondVolume.id,
        targetWords: 6000,
      });
      const chapter = await repo.createChapter(novel.id, {
        title: '夜渡',
        outlineNodeId: chapterNode.id,
      });

      // 边界演示（task-17）：一章「已完成」的章节，用于演示采用截断稿后退回草稿
      const doneVolume = await repo.createOutlineNode(novel.id, {
        title: '第三卷 灯',
        synopsis: '上岸之后。',
      });
      const doneNode = await repo.createOutlineNode(novel.id, {
        title: '第2章 灯',
        synopsis: '岸上那盏灯还亮着。',
        parentId: doneVolume.id,
        targetWords: 3000,
      });
      const doneChapter = await repo.createChapter(novel.id, {
        title: '灯',
        content: '已经写完的一章：岸上那盏灯还亮着。',
        outlineNodeId: doneNode.id,
      });
      await repo.updateChapter(doneChapter.id, { status: 'done' });

      return {
        novelId: novel.id,
        entryIds: { shen: shen.id, pei: pei.id, rule: rule.id },
        outlineIds: {
          volume: volume.id,
          secondVolume: secondVolume.id,
          chapterNode: chapterNode.id,
          doneVolume: doneVolume.id,
          doneNode: doneNode.id,
        },
        chapterId: chapter.id,
        doneChapterId: doneChapter.id,
      };
    });
    log(
      '01',
      '种子数据完成',
      `小说《归墟纪》 条目 3 条（含 pinned 世界观）、卷 3 个、章节点 2 个（6000/3000 字）、章节 2 章（1 草稿 + 1 已完成）`,
    );

    // active novel 写入 localStorage（zustand persist），再进写作页
    await page.evaluate(
      (novelId) =>
        localStorage.setItem(
          'myliterature.active-novel',
          JSON.stringify({ state: { activeNovelId: novelId }, version: 0 }),
        ),
      seed.novelId,
    );
    await page.goto(`${BASE}/write`, { waitUntil: 'load' });
    const volumeButton = page.getByRole('button', { name: '编辑「第一卷 渡口」' });
    await volumeButton.waitFor({ state: 'visible', timeout: 20_000 });
    log('02', '进入写作页', `已选作品《归墟纪》；大纲树可见「第一卷 渡口」`);
    await shot(page, '02', '01-writing-page-mobile.png', '390×844 写作页：大纲树 + 章节正文列表');

    // 2) 点开第一卷抽屉：注入清单（after：术语「本次注入 / 手工关联 / 名字提到」）
    await volumeButton.click();
    const nodeDialog = page.getByRole('dialog', { name: '大纲节点' });
    await nodeDialog.waitFor({ state: 'visible', timeout: 10_000 });
    await waitText(page, '本次注入');
    const injectionText = await visibleText(nodeDialog.getByText('本次注入').locator('xpath=..'), 900);
    log('03', '打开「第一卷 渡口」节点抽屉', `注入清单：${injectionText}`);
    await nodeDialog.getByText('本次注入').scrollIntoViewIfNeeded();
    await shot(page, '03', 'after-01-node-injection-mobile.png', 'after：本次注入（核心 / 手工关联 / 名字提到）');

    // 3) 细化 → 提案（P1：单提案按钮无「（1）」；review 区显示共 N 章细目）
    await page.getByRole('button', { name: '细化这一节点' }).click();
    const acceptAll = page.getByRole('button', { name: '采用这份细目' });
    await acceptAll.waitFor({ state: 'visible', timeout: 20_000 });
    await waitText(page, '共 3 章细目，采用后可继续编辑。');
    const proposalToggle = nodeDialog.getByRole('button', { name: /细化 · 第一卷 渡口/u }).first();
    if ((await proposalToggle.getAttribute('aria-expanded')) === 'false') {
      await proposalToggle.click();
      await page.waitForTimeout(250);
    }
    const proposalText = await visibleText(nodeDialog, 1600);
    log('04', '细化完成，提案待确认（单提案按钮无「（1）」）', proposalText);
    await nodeDialog.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight;
    });
    await shot(page, '04', 'after-02-refine-proposal-mobile.png', 'after：场景卡细目提案（共 3 章，可编辑）');

    // 4) 采用 → 关联确认（P1：没有「全部保留」，直接「确认关联（6 条）」）
    await acceptAll.click();
    const linkDialog = page.getByRole('dialog', { name: '确认自动关联' });
    await linkDialog.waitFor({ state: 'visible', timeout: 20_000 });
    const linkText = await visibleText(linkDialog, 1100);
    log('05', '采用细目后弹出「确认自动关联」', linkText);
    await shot(page, '05', 'after-03-link-confirm-mobile.png', 'after：只剩「全部跳过 / 确认关联（6 条）」+ 关闭不写入说明');
    await linkDialog.getByRole('button', { name: '确认关联（6 条）' }).click();
    await linkDialog.waitFor({ state: 'hidden', timeout: 10_000 });
    log('06', '点击「确认关联（6 条）」', '默认全选，关联已写入；面板关闭');
    await nodeDialog.getByRole('button', { name: '关闭' }).click();
    await nodeDialog.waitFor({ state: 'hidden', timeout: 10_000 });

    // 5) 打开章节编辑器 → 生成本章（P1：具体场景区间）
    await page.getByRole('button', { name: '继续写第 1 章' }).click();
    await page.getByRole('button', { name: '生成本章' }).waitFor({ state: 'visible', timeout: 15_000 });
    log('07', '打开章节编辑器（第 1 章 夜渡）', '点击「生成本章」');
    await page.getByRole('button', { name: '生成本章' }).click();
    await waitText(page, '本次注入');
    const targetLine = await visibleText(page.getByText(/目标字数：\d+ 字（来源：/u).first(), 120);
    const sceneRange = await visibleText(page.getByText(/场景数参考：约/u).first(), 120);
    const injectSheetText = await visibleText(page.getByRole('dialog', { name: '生成本章正文' }), 1000);
    log('08', '生成本章面板打开', `目标来源行：${targetLine}；${sceneRange}；面板：${injectSheetText}`);
    await shot(page, '08', 'after-04-generate-form-mobile.png', 'after：目标字数来源 + 具体场景区间');

    // 6) 开始生成 → 假流式返回截断（P1：X 字 / 目标 N 字）
    const startButton = page.getByRole('button', { name: '开始生成' });
    await startButton.scrollIntoViewIfNeeded();
    await startButton.click({ timeout: 20_000 });
    await waitText(page, '生成被截断', 20_000);
    const truncatedText = await visibleText(page.getByRole('dialog', { name: '生成本章正文' }), 1200);
    log('09', '收到 finish_reason:"length"', truncatedText);
    await shot(page, '09', 'after-05-generation-truncated-mobile.png', 'after：X 字 / 目标 6000 字 + 截断说明');

    // 7) 采用截断稿 → 新二次确认文案 → 编辑器未完成提示（P0）
    await page.getByRole('button', { name: /采用为正文|替换正文/u }).click();
    const confirmDialog = page.getByRole('dialog', { name: '仍要采用不完整内容？' });
    await confirmDialog.waitFor({ state: 'visible', timeout: 10_000 });
    log('10', '点击采用，出现二次确认（新文案）', await visibleText(confirmDialog, 500));
    await shot(page, '10', 'after-06-accept-confirm-mobile.png', 'after：二次确认「采用后本章仍是草稿…」');
    await confirmDialog.getByRole('button', { name: '仍要采用' }).click();
    await confirmDialog.waitFor({ state: 'hidden', timeout: 10_000 });
    await waitText(page, '本章由未完成生成稿采用', 15_000);
    const noticeText = await visibleText(page.getByRole('status').first(), 300);
    log('11', '采用截断稿后回到编辑器（未完成留痕）', noticeText);
    await shot(page, '11', 'after-07-editor-incomplete-notice-mobile.png', 'after：编辑器「未完成生成稿」提示条 + 知道了');
    await page.getByRole('button', { name: '知道了' }).click();
    log('12', '点击「知道了」', '提示条关闭；已生成正文保留');

    // 8) 边界（task-17）：已完成章节采用截断稿 → 退回草稿 + 提示条
    await page.goto(`${BASE}/write`, { waitUntil: 'load' });
    const doneChapterButton = page.getByRole('button', { name: '继续写第 2 章' });
    await doneChapterButton.waitFor({ state: 'visible', timeout: 20_000 });
    await doneChapterButton.click();
    await page.getByRole('button', { name: '生成本章' }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('button', { name: '已完成' }).waitFor({ state: 'visible', timeout: 10_000 });
    log('13', '打开「第 2 章 灯」（已完成）', '状态按钮显示「已完成」');
    await shot(page, '13', 'after-08-done-chapter-before-mobile.png', 'before（边界）：已完成章节');

    await page.getByRole('button', { name: '生成本章' }).click();
    await waitText(page, '本次注入');
    const startSecond = page.getByRole('button', { name: '开始生成' });
    await startSecond.scrollIntoViewIfNeeded();
    await startSecond.click({ timeout: 20_000 });
    await waitText(page, '生成被截断', 20_000);
    await page.getByRole('button', { name: '替换正文' }).click();
    const confirmSecond = page.getByRole('dialog', { name: '仍要采用不完整内容？' });
    await confirmSecond.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmSecond.getByRole('button', { name: '仍要采用' }).click();
    await waitText(page, '本章由未完成生成稿采用', 15_000);
    await page.getByRole('button', { name: '草稿' }).waitFor({ state: 'visible', timeout: 10_000 });
    log('14', '已完成章节采用截断稿', '状态退回「草稿」+ 未完成提示条（task-17 边界）');
    await shot(page, '14', 'after-09-done-chapter-demoted-mobile.png', 'after（边界）：已完成 → 草稿 + 未完成提示');

    // 9) 桌面宽度关键页（1280×800）
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/write`, { waitUntil: 'load' });
    await page.getByRole('button', { name: '编辑「第一卷 渡口」' }).waitFor({ timeout: 20_000 });
    log('15', '切到桌面 1280×800', '写作页');
    await shot(page, '15', 'after-10-writing-page-desktop.png', '1280×800 写作页（细化后 3 个子节点，2 章）');

    await page.getByRole('button', { name: '编辑「第一卷 渡口」' }).click();
    const desktopDialog = page.getByRole('dialog', { name: '大纲节点' });
    await desktopDialog.waitFor({ state: 'visible', timeout: 10_000 });
    await waitText(page, '本次注入');
    log('16', '桌面端打开节点抽屉', '注入清单可见');
    await desktopDialog.getByText('本次注入').scrollIntoViewIfNeeded();
    await shot(page, '16', 'after-11-node-sheet-desktop.png', '1280×800 节点抽屉（右侧抽屉）+ 本次注入');

    // 9) 汇总
    log(
      '14',
      '走查完成',
      `after 截图 11 张；mock 请求 ${mockLog.length} 次（stream: ${mockLog.filter((item) => item.stream).length}）；页面异常 ${pageErrors.length} 个`,
    );

    writeFileSync(join(SHOTS_DIR, 'walkthrough-data.json'), `${JSON.stringify({ seed, mockLog, pageErrors, transcript }, null, 2)}\n`);
    return { ok: pageErrors.length === 0, pageErrors };
  } catch (error) {
    log('!!', '走查中断', String(error?.stack ?? error).slice(0, 1200));
    writeFileSync(join(SHOTS_DIR, 'walkthrough-data.json'), `${JSON.stringify({ mockLog, pageErrors, transcript }, null, 2)}\n`);
    throw error;
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    await stopDevServer(server);
    writeFileSync(join(SHOTS_DIR, 'transcript.txt'), `${transcript.join('\n')}\n`);
    log('99', 'server 已停止', 'transcript 已写入 ux/shots/transcript.txt');
    // 最后再写一次，包含收尾行
    writeFileSync(join(SHOTS_DIR, 'transcript.txt'), `${transcript.join('\n')}\n`);
  }
}

main().then(
  () => {
    console.log('\n✅ 体验沙盒走查完成：截图在 ux/shots/，记录见 transcript.txt');
    process.exit(0);
  },
  (error) => {
    console.error('\n❌ 体验沙盒失败：', error);
    process.exit(1);
  },
);
