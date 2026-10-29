/**
 * 真实模型抽检（live model check）。
 *
 * 只在设置了 `REAL_LLM_API_KEY` 或 `DEEPSEEK_API_KEY` 时运行；没有 Key 时整个文件 skip，
 * 常规 `npm run test:run` 不受影响、也不会产生任何费用。
 *
 * 目的不是断言「文笔好」，而是回答上线前必须知道的三件事：
 * 1. 生产 prompt + schema 在真实模型上能否稳定吐回合法结构；
 * 2. 归档提取、前沿大纲、整章生成、文风检查的实际耗时与 token 成本；
 * 3. 质量指标（条目数/龙套命名/章数/场景数/伏笔收束/字数/诊断证据）落在什么量级，供人工判断。
 *
 * 硬断言只保 schema 合法、关键内容非空、调用成功；质量项以结构化 console.log 输出，
 * 并写入 `analysis/live-model-report.json`，由人工审阅 —— 文风与节奏不适合用机器阈值卡。
 *
 * 运行：`REAL_LLM_API_KEY=sk-xxx npm run test:live`
 * 产物：`analysis/live-model-report.json`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SummaryChainContextBuilder } from '@/context/SummaryChainContextBuilder';
import { selectStyleAnchor } from '@/context/styleAnchor';
import { selectPlanningEntries } from '@/context/planningContext';
import { countWords } from '@/domain/primitives';
import { chaptersOfTrack } from '@/domain/sideStory';
import type {
  Category,
  Chapter,
  ChapterSummary,
  KnowledgeEntry,
  Novel,
  OutlineNode,
  StyleProfile,
} from '@/domain/schema';
import {
  ExtractResultSchema,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
  findMentionedEntries,
} from '@/features/import/extractSettings';
import {
  FrontierOutlineSchema,
  buildOutlineContinueSystemPrompt,
  buildOutlineContinueUserPrompt,
  buildOutlineTail,
  composeFrontierSynopsis,
  type RecentChapterPoint,
} from '@/features/outline/outlineContinue';
import {
  STYLE_CHECK_SEVERITY_LABELS,
  StyleCheckSchema,
  buildStyleCheckSystemPrompt,
  buildStyleCheckUserPrompt,
} from '@/features/style/styleCheck';
import { ARCHIVE_EXTRACT_EXTRA_REQUIREMENT } from '@/features/writing/archiveChapter';
import { buildChapterSystemPrompt, buildChapterUserPrompt } from '@/features/writing/chapterDraft';
import { chapterMaxOutputTokens } from '@/features/writing/chapterLength';
import { OpenAiCompatibleClient } from '@/llm/OpenAiCompatibleClient';
import { PROVIDER_PRESETS } from '@/llm/presets';
import { generateStructured } from '@/llm/structured';
import { TASK_PROFILES } from '@/llm/taskProfiles';
import type { TokenUsage } from '@/llm/types';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';

const PRESET = PROVIDER_PRESETS.deepseek;
const API_KEY = (process.env.REAL_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '').trim();
const BASE_URL = (process.env.REAL_LLM_BASE_URL ?? PRESET.baseUrl).trim();
const MODEL = (process.env.REAL_LLM_MODEL ?? PRESET.model).trim();
const STRONG_MODEL = (process.env.REAL_LLM_STRONG_MODEL ?? PRESET.strongModel).trim();
const HAS_KEY = API_KEY.length > 0;

/**
 * 与生产 DeepSeek 预置一致的能力位：json_object（非严格 schema）、支持 thinking 开关。
 * 换端点时若服务端不支持这些参数，请用 REAL_LLM_BASE_URL 指向兼容端点并在报告里对照。
 */
const LIVE_CAPABILITIES = PRESET.capabilities;

const describeLive = HAS_KEY ? describe : describe.skip;

// vitest 里 import.meta.url 不是 file: 协议，用项目根目录拼路径（vitest 以项目根为 cwd）
const REPORT_PATH = resolve(process.cwd(), 'analysis/live-model-report.json');

/** 归档抽检用的正文：900 字左右，包含具名人物、职务龙套、世界规则与伏笔 */
const ARCHIVE_CHAPTER_CONTENT = `雪落进青冥宗的第三进院落时，林越听见了钟声。
不是活人敲的钟，是风穿过断梁时那种空洞的回响。裴照在门槛前停下，从怀里取出一叠旧信，信封上的火漆已经裂了。他说：「你父亲的字。」林越接过信，手抖得厉害，却一个字也读不进去。他忽然意识到自己害怕的不是真相，而是真相里那些他亲手做过的事。
院墙外传来脚步声，很轻，像踩在雪上的猫。裴照抬手示意他别动。两人退到廊柱后面，看见一个披着蓑衣的人从侧门进来。那人手里提着一盏纸灯，灯光照出他半张脸——是渡口的老船夫，姓周，先前替他们摆过两次渡。老船夫没有看他们，径直走到井边，弯腰把灯放在井沿上，然后从怀里摸出一张纸，就着灯光看了很久。风把纸吹得哗啦响。
「他在等谁？」林越用气声问。
裴照摇头。他盯着老船夫的脚，忽然低声说：「他的鞋是干的。」
林越这才注意到，从侧门到井边这一路雪地上，只有一串很浅的脚印，而且脚印的方向，是朝着院里的。老船夫是倒着走进来的。
那盏纸灯的灯芯忽然爆了一下。老船夫抬起头，冲着他们藏身的廊柱方向，很平静地说：「裴捕头，别躲了。你师父当年也是这么躲在廊下的。」
裴照的手指扣紧了刀柄。林越看见他肩背绷直，像一张拉满的弓。老船夫把那张纸折起来，塞进袖子里，又说：「你父亲的旧案，我这里是最后一笔账。想听，就拿一件事来换。」
「什么事？」裴照问。
「你们带来的那把短刀。刀柄上刻的字，不是给活人看的。」
林越下意识按住了腰间的刀。这一刻他忽然想起一些碎片：火光，雪，还有很多人在喊他的名字。他想不起自己做了什么，但身体记得那种等待审判的冷。
裴照没有立刻回答。雪落在三个人之间，安静得能听见远处山门的风声。老船夫又说：「我这条船，明早天不亮就走。过时不候。」
林越忽然开口：「周伯，我小时候是不是坐过你的船？」
老船夫脚步顿了一下。他没有回头，只把纸灯举高了一点，让灯影落在雪上。「坐过。」他说，「那年你六岁，你爹抱着你，雨下得很大。你一直哭，说水里有人在叫你。」
「水里的人是谁？」
「我要是知道，早就不在这条河上撑船了。」
裴照在旁边一直没有说话。等老船夫的背影快融进雪里，他才很轻地吐出一口气：「他在说谎。你六岁那年，你父亲已经死了。」
他说完，提起纸灯往侧门外走。这一次，他的脚印是正的。`;
/**
 * 整章生成的目标字数。默认 1200（短目标压力测试）；可用 LIVE_TARGET_WORDS 覆盖，
 * 例如 3000 复测默认章长、6000 复测网文长章。
 */
const TARGET_WORDS = (() => {
  const raw = Number.parseInt(process.env.LIVE_TARGET_WORDS ?? '1200', 10);
  return Number.isFinite(raw) && raw >= 200 && raw <= 8000 ? raw : 1200;
})();
const LOONG_TONG_KEYWORDS = [
  '船夫',
  '茶博士',
  '路人',
  '掌柜',
  '小二',
  '侍卫',
  '士兵',
  '丫鬟',
  '车夫',
];

interface CheckRecord {
  name: string;
  ok: boolean;
  durationMs: number;
  metrics?: Record<string, unknown>;
  usage?: TokenUsage;
  /** 供人工审阅的节选（截断），不参与断言 */
  sample?: string;
  error?: string;
}

interface LiveReport {
  generatedAt: string;
  model: string;
  strongModel: string;
  baseUrl: string;
  checks: CheckRecord[];
}

const report: LiveReport = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  strongModel: STRONG_MODEL,
  baseUrl: BASE_URL,
  checks: [],
};

function preview(text: string, limit = 400): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function normalizeForExcerpt(text: string): string {
  return text.replace(/\s+/gu, '').replace(/[.…]+/gu, '');
}

async function runCheck(
  name: string,
  fn: () => Promise<{ metrics: Record<string, unknown>; usage?: TokenUsage; sample?: string }>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const outcome = await fn();
    const record: CheckRecord = {
      name,
      ok: true,
      durationMs: Date.now() - startedAt,
      ...outcome,
    };
    report.checks.push(record);
    // 结构化摘要直接打出来：跑完不用翻 JSON 也能看质量量级
    console.log(
      `[live] ${name}`,
      JSON.stringify({ durationMs: record.durationMs, ...outcome.metrics }),
    );
  } catch (cause) {
    report.checks.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}

function liveClient(): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    capabilities: LIVE_CAPABILITIES,
  });
}

// ---------------------------------------------------------------- 夹具

interface LiveFixtures {
  novel: Novel;
  style: StyleProfile;
  categories: Category[];
  entries: KnowledgeEntry[];
  outline: OutlineNode[];
  chapters: Chapter[];
  summaries: ChapterSummary[];
  /** 归档/整章生成用的目标章（最后一章，摘要最全） */
  targetChapter: Chapter;
}

const CHAPTER_CONTENT: Record<number, string> = {
  1: `渡口的雾还没散，林越在潮湿的木板上醒来。他记不清自己是谁，只记得火光和一声很长的惨叫。裴照蹲在他面前，把一把没有刀鞘的短刀递过来：「拿着。你昨夜握了一整夜。」林越接过刀，指尖发凉。刀柄上刻着一个他不认识的字，像是被谁用指甲一点点划出来的。远处传来马蹄声，裴照起身，把斗篷盖到他肩上。\n\n第七天夜里下起雪，两个人在废弃的驿站歇脚。裴照把仅剩的干粮分了一半给林越，自己靠在门边擦刀。林越问他为什么肯带自己去青冥宗，裴照没有立刻回答。火堆噼啪响了一声，他才说：「我师父死在那场火里，账总得有人来结。」\n\n林越低头看着自己的手。这双手他一点也不熟悉，虎口却有厚茧，像握了十几年剑。他忽然明白，自己忘掉的也许不只是名字，还有一些不愿意想起来的事。\n\n雪越下越大，驿站的窗纸被风吹得发抖。裴照把地图压在膝上，指了指第三个山口：「过了那里，就没有回头路了。」林越点点头，却发现自己并不想回头。`,
  2: `北上的路走了七天。驿站的人都说青冥宗是十几年前就烧空了的废观，没人愿意带路。裴照不说话，只在晚上把地图摊在桌上，用炭笔圈出第三个山口。林越盯着地图上那个墨点，忽然想起一个词——雪夜。他不知道这个词从哪来，但说出口时，裴照的炭笔停了一瞬。那一刻两个人都清楚：他们找到的方向，也许正是当年那场大火的起点。`,
  3: ARCHIVE_CHAPTER_CONTENT,
};

async function seedFixtures(harness: TestHarness): Promise<LiveFixtures> {
  const repository = harness.repository;
  const novel = await repository.createNovel({
    title: '归墟纪',
    genre: '仙侠',
    oneLiner: '失忆剑客发现自己可能是灭门案的凶手。',
  });
  await repository.updateNovel(novel.id, {
    rollingSummary: '林越在渡口醒来，随裴照北上调查青冥宗灭门案。',
  });
  const style = (await repository.getStyleProfile(novel.id))!;
  const categories = await repository.listCategories(novel.id);
  const world = categories.find((category) => category.kind === 'worldbuilding')!;
  const character = categories.find((category) => category.kind === 'character')!;

  await repository.createEntry(novel.id, {
    categoryId: character.id,
    title: '林越',
    aliases: ['阿越'],
    summary: '失忆的流亡剑客',
    fields: {
      identity: '二十余岁，流亡剑客，自渡口醒来后失忆',
      personality: '沉默寡言，习惯把疑问咽回去，靠观察别人活着',
      goal: '查清青冥宗灭门案与自己失去的记忆',
      flaw: '失忆让他不敢相信自己，越接近真相越想逃',
      voice: '短句，极少反问；情绪上来时会突然沉默',
    },
  });
  await repository.createEntry(novel.id, {
    categoryId: character.id,
    title: '裴照',
    summary: '冷面捕头，带林越北上',
    fields: {
      identity: '三十岁上下，六扇门捕头',
      goal: '查清师父当年经手的旧案',
      flaw: '习惯独自承担，不肯向人求证',
      relations: '林越——名义上的向导，实际的看守',
    },
  });
  await repository.createEntry(novel.id, {
    categoryId: world.id,
    title: '灵气',
    summary: '天地间的可借之力',
    pinned: true,
    fields: {
      rules: '灵力来自血脉，借力会留下反噬；越接近本源，反噬越重',
      cost: '每次强行借力都会折损寿元，且会在雪夜发作',
      impact: '人物在绝境中必须选择「借力活下来」还是「保留寿元」',
    },
  });

  const chapters: Chapter[] = [];
  for (let index = 1; index <= 3; index += 1) {
    chapters.push(
      await repository.createChapter(novel.id, {
        title: `第${index}章 ${['渡口', '北上', '雪夜'][index - 1]}`,
        content: CHAPTER_CONTENT[index]!,
      }),
    );
  }
  await repository.upsertSummary(novel.id, chapters[0]!.id, {
    summary: '林越在渡口醒来，被裴照带走，刀柄刻着陌生的字。',
    keyEvents: ['林越醒来', '裴照递刀', '追兵逼近'],
    openThreads: ['刀的来历', '阿越的身世'],
  });
  await repository.upsertSummary(novel.id, chapters[1]!.id, {
    summary: '两人北上七日，裴照在地图上圈出雪山山口；林越说出「雪夜」。',
    keyEvents: ['北上', '地图上的墨点', '林越说出雪夜'],
    openThreads: ['刀的来历', '阿越的身世', '裴照师父的旧案'],
  });
  await repository.upsertSummary(novel.id, chapters[2]!.id, {
    summary: '雪夜抵达青冥宗，老船夫倒着脚印出现，以旧案账单换短刀。',
    keyEvents: ['抵达青冥宗', '父亲的旧信', '老船夫现身'],
    openThreads: ['刀的来历', '阿越的身世', '旧信的内容', '老船夫要换什么'],
  });

  const volume = await repository.createOutlineNode(novel.id, {
    title: '第一卷 风起',
    synopsis: '林越被卷入青冥宗灭门案，随裴照北上。',
    targetWords: 30000,
  });
  await repository.createOutlineNode(novel.id, {
    title: '第1章 渡口',
    synopsis: '林越在雾中醒来，裴照递刀，追兵逼近。',
    parentId: volume.id,
    targetWords: 3000,
  });
  await repository.createOutlineNode(novel.id, {
    title: '第2章 北上',
    synopsis: '北上七日，地图、雪夜与旧案的线索浮出。',
    parentId: volume.id,
    targetWords: 3000,
  });
  await repository.createOutlineNode(novel.id, {
    title: '第3章 雪夜',
    synopsis: '雪夜入青冥宗，父亲的旧信与倒着走来的老船夫。',
    parentId: volume.id,
    targetWords: 3000,
  });

  return {
    novel,
    style,
    categories,
    entries: await repository.listEntries(novel.id),
    outline: await repository.listOutline(novel.id),
    chapters: await repository.listChapters(novel.id),
    summaries: await repository.listSummaries(novel.id),
    targetChapter: chapters[2]!,
  };
}

// ---------------------------------------------------------------- 抽检

describeLive('真实模型抽检（4 次调用）', () => {
  let harness: TestHarness;
  let fixtures: LiveFixtures;

  beforeAll(async () => {
    harness = await createTestHarness();
    fixtures = await seedFixtures(harness);
  }, 60_000);

  afterAll(async () => {
    await harness.cleanup();
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`[live] 报告已写入 ${REPORT_PATH}`);
  });

  it('A 归档提取：一次 extract-settings 产出摘要与条目', async () => {
    await runCheck('archive-extract', async () => {
      const previousSummary = fixtures.summaries.find(
        (summary) => summary.chapterId === fixtures.chapters[1]!.id,
      );
      const mentioned = findMentionedEntries(fixtures.targetChapter.content, fixtures.entries);
      const mentionedIds = new Set(mentioned.map((entry) => entry.id));
      const system = buildExtractSystemPrompt(fixtures.novel, fixtures.categories);
      const userPrompt = buildExtractUserPrompt({
        chapter: fixtures.targetChapter,
        mentionedEntries: mentioned,
        categories: fixtures.categories,
        otherEntryNames: fixtures.entries
          .filter((entry) => !mentionedIds.has(entry.id))
          .map((entry) => entry.title),
        openThreads: previousSummary?.openThreads ?? [],
        rollingSummary: fixtures.novel.rollingSummary,
      });
      // 与归档路径一致：提取 prompt 末尾追加归档专属条目门槛
      const user = `${userPrompt}\n\n${ARCHIVE_EXTRACT_EXTRA_REQUIREMENT}`;
      const profile = TASK_PROFILES['extract-settings'];

      const result = await generateStructured({
        client: liveClient(),
        model: MODEL,
        schema: ExtractResultSchema,
        schemaName: 'ChapterArchive',
        system,
        user,
        temperature: profile.temperature,
        thinking: profile.thinking,
        ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
        failOnTruncation: true,
      });
      const data = result.data;

      // 硬断言：schema 已由 generateStructured 校验，这里再保「关键内容非空」
      expect(data.summary.trim().length).toBeGreaterThan(0);
      expect(data.rollingSummary.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(data.entries)).toBe(true);

      const entryTitles = data.entries.map((entry) => entry.title.trim()).filter(Boolean);
      // 文学顾问 P1：职务龙套不应被建人物条目。只记录候选，供人工复核（不硬断言）
      const loongTongViolations = data.entries
        .filter((entry) => {
          const isCharacter = fixtures.categories.some(
            (category) => category.name === entry.categoryName && category.kind === 'character',
          );
          if (!isCharacter) return false;
          return LOONG_TONG_KEYWORDS.some((keyword) => entry.title.includes(keyword));
        })
        .map((entry) => entry.title);

      return {
        metrics: {
          chapterChars: fixtures.targetChapter.content.length,
          chapterWords: countWords(fixtures.targetChapter.content),
          entryCount: data.entries.length,
          entryTitles,
          summaryChars: data.summary.length,
          keyEvents: data.keyEvents.length,
          appearingEntries: data.appearingEntries.length,
          newThreads: data.newOpenThreads,
          resolvedThreads: data.resolvedThreads,
          loongTongViolations,
          attempts: result.attempts,
        },
        usage: result.usage,
        sample: preview(`摘要：${data.summary}\n条目：${entryTitles.join('、')}`),
      };
    });
  }, 180_000);

  it('B 前沿大纲：一次 outline-continue 规划 3 章', async () => {
    await runCheck('frontier-outline', async () => {
      const outlineTail = buildOutlineTail(fixtures.outline);
      const summaryByChapter = new Map(
        fixtures.summaries.map((summary) => [summary.chapterId, summary] as const),
      );
      const recentSummaries: RecentChapterPoint[] = fixtures.chapters
        .slice(-3)
        .flatMap((chapter) => {
          const summary = summaryByChapter.get(chapter.id);
          return summary
            ? [
                {
                  label: chapter.title.trim() || `第 ${chapter.index} 章`,
                  summary: summary.summary,
                  keyEvents: summary.keyEvents,
                },
              ]
            : [];
        });
      const latestSummary = summaryByChapter.get(
        fixtures.chapters[fixtures.chapters.length - 1]!.id,
      );
      const openThreads = latestSummary?.openThreads ?? [];
      const selection = selectPlanningEntries({
        texts: [
          outlineTail.map((entry) => `${entry.title}\n${entry.synopsis}`).join('\n'),
          fixtures.novel.rollingSummary,
          ...recentSummaries.map((point) => `${point.label}\n${point.summary}`),
          ...openThreads,
        ],
        entries: fixtures.entries,
        categories: fixtures.categories,
        linkedEntryIds: [],
      });
      const system = buildOutlineContinueSystemPrompt(
        fixtures.novel,
        fixtures.style,
        undefined,
        selection.core,
      );
      const user = buildOutlineContinueUserPrompt({
        outlineTail,
        rollingSummary: fixtures.novel.rollingSummary,
        recentSummaries,
        openThreads,
        relatedBlocks: selection.related,
        count: 3,
      });
      const profile = TASK_PROFILES['outline-continue'];

      const result = await generateStructured({
        client: liveClient(),
        model: STRONG_MODEL,
        schema: FrontierOutlineSchema,
        schemaName: 'FrontierOutline',
        system,
        user,
        temperature: profile.temperature,
        thinking: profile.thinking,
        ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
        failOnTruncation: true,
      });
      const data = result.data;
      const composed = data.chapters.map((chapter) => composeFrontierSynopsis(chapter));

      // 硬断言：章数/场景数/钩子非空由 schema 保证，这里再保「每章有可读梗概」
      expect(data.chapters.length).toBeGreaterThanOrEqual(3);
      expect(composed.every((text) => text.trim().length > 0)).toBe(true);

      const threadSet = new Set(openThreads);
      const chapters = data.chapters.map((chapter) => ({
        title: chapter.title,
        sceneCount: chapter.scenes.length,
        conflict: chapter.conflict,
        hook: chapter.hook,
        resolvesThreads: chapter.resolvesThreads,
        plantsThreads: chapter.plantsThreads,
        usesEntries: chapter.usesEntries,
        // 「显式点名收束」：本章 resolves 里是否真的写了现存伏笔里的某一条
        resolvesFromOpenThreads: chapter.resolvesThreads.filter((thread) => threadSet.has(thread)),
      }));

      return {
        metrics: {
          chapterCount: chapters.length,
          chapters,
          totalScenes: chapters.reduce((sum, chapter) => sum + chapter.sceneCount, 0),
          resolvesFromOpenThreads: chapters.reduce(
            (sum, chapter) => sum + chapter.resolvesFromOpenThreads.length,
            0,
          ),
          openThreads,
          synopsisChars: composed.reduce((sum, text) => sum + text.length, 0),
          attempts: result.attempts,
        },
        usage: result.usage,
        sample: preview(composed[0] ?? ''),
      };
    });
  }, 180_000);

  it(`C 整章 ${TARGET_WORDS} 字：一次 chapter-draft 流式生成`, async () => {
    await runCheck(`chapter-draft-${TARGET_WORDS}`, async () => {
      const targetNode = fixtures.outline.find((node) => node.title === '第3章 雪夜')!;
      const builder = new SummaryChainContextBuilder();
      const built = builder.build({
        novel: fixtures.novel,
        style: fixtures.style,
        categories: fixtures.categories,
        entries: fixtures.entries,
        outline: fixtures.outline,
        chapters: fixtures.chapters,
        summaries: fixtures.summaries,
        targetNodeId: targetNode.id,
        targetChapterId: fixtures.targetChapter.id,
        recentSummaryCount: 2,
      });
      const system = buildChapterSystemPrompt(built.stablePrefix);
      const user = buildChapterUserPrompt({
        volatileSuffix: built.volatileSuffix,
        targetWords: TARGET_WORDS,
      });
      const profile = TASK_PROFILES['chapter-draft'];

      let streamed = '';
      const result = await liveClient().streamChat(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: profile.temperature,
          thinking: profile.thinking,
          maxTokens: chapterMaxOutputTokens(TARGET_WORDS),
        },
        {
          onText: (delta) => {
            streamed += delta;
          },
        },
      );
      const content = (result.content || streamed).trim();

      // 硬断言：调用成功且真的写出了内容（字数只记录，不设质量阈值）
      expect(content.length).toBeGreaterThan(0);

      const generatedWords = countWords(content);
      return {
        metrics: {
          targetWords: TARGET_WORDS,
          charCount: content.length,
          wordCount: generatedWords,
          ratioToTarget: Number((generatedWords / TARGET_WORDS).toFixed(2)),
          // T1 收尾关心的口径：是否明显短于目标（<85%）
          shortfallBelow85: generatedWords < TARGET_WORDS * 0.85,
          finishReason: result.finishReason,
          promptChars: system.length + user.length,
          maxTokens: chapterMaxOutputTokens(TARGET_WORDS),
        },
        usage: result.usage,
        sample: preview(content),
      };
    });
  }, 240_000);

  it('D 文风检查：一次 style-check 诊断第 3 章（含第 1 章锚点）', async () => {
    await runCheck('style-check', async () => {
      const targetChapter = fixtures.targetChapter;
      const sameTrack = chaptersOfTrack(fixtures.chapters, targetChapter.sideStoryId ?? null);
      const anchor = selectStyleAnchor(sameTrack, targetChapter.id, '第');
      if (!anchor) throw new Error('夹具异常：第 3 章之前应有可用的文风锚点');

      const system = buildStyleCheckSystemPrompt(fixtures.novel, fixtures.style);
      const user = buildStyleCheckUserPrompt({ anchor, content: targetChapter.content });
      const profile = TASK_PROFILES['style-check'];

      const result = await generateStructured({
        client: liveClient(),
        model: STRONG_MODEL,
        schema: StyleCheckSchema,
        schemaName: 'StyleCheck',
        system,
        user,
        temperature: profile.temperature,
        thinking: profile.thinking,
        ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
        failOnTruncation: true,
      });
      const data = result.data;
      // 硬断言：schema 已校验；这里再保整体判断非空
      expect(data.summary.trim().length).toBeGreaterThan(0);

      const chapterText = targetChapter.content;
      const normalizedChapter = normalizeForExcerpt(chapterText);
      const issues = data.issues.map((issue) => {
        const excerpt = issue.excerpt.trim();
        const normalizedExcerpt = normalizeForExcerpt(excerpt);
        return {
          dimension: issue.dimension,
          severity: issue.severity,
          severityLabel: STYLE_CHECK_SEVERITY_LABELS[issue.severity],
          excerpt: preview(excerpt, 120),
          // 主指标：原文证据是否逐字出现在本章正文里（精确子串）
          excerptVerbatim: excerpt.length > 0 && chapterText.includes(excerpt),
          // 辅助指标：忽略空白与省略号后是否仍能对上（方便人工判断是排版差异还是编造）
          excerptNormalized:
            normalizedExcerpt.length > 0 && normalizedChapter.includes(normalizedExcerpt),
          basis: preview(issue.basis, 120),
          basisNonEmpty: issue.basis.trim().length > 0,
          suggestion: preview(issue.suggestion, 120),
          suggestionNonEmpty: issue.suggestion.trim().length > 0,
        };
      });

      const severityCounts = { low: 0, medium: 0, high: 0 };
      for (const issue of data.issues) severityCounts[issue.severity] += 1;
      const verbatimCount = issues.filter((issue) => issue.excerptVerbatim).length;
      // 全部 excerpt 都找不到 = 模型可能在编原文证据：这是质量问题，标成严重但不硬失败
      const allExcerptsMissed = issues.length > 0 && verbatimCount === 0;
      if (allExcerptsMissed) {
        console.warn('[live] style-check：所有 excerpt 都不在本章正文中，可能编造了原文证据');
      }

      const usage = result.usage;
      const promptTokens = usage?.promptTokens ?? 0;
      const cachedPromptTokens = usage?.cachedPromptTokens ?? 0;

      return {
        metrics: {
          targetChapterIndex: targetChapter.index,
          anchorLabel: anchor.label,
          anchorChars: anchor.text.length,
          chapterChars: chapterText.length,
          summary: data.summary,
          issueCount: data.issues.length,
          issues,
          issueDimensions: data.issues.map((issue) => issue.dimension),
          severityCounts,
          excerptsVerbatim: verbatimCount,
          excerptsNormalized: issues.filter((issue) => issue.excerptNormalized).length,
          // 全部证据都不在正文 → 标严重问题（人工复核模型是否编造证据）
          allExcerptsMissed,
          severeWarning: allExcerptsMissed
            ? '所有 excerpt 都不在本章正文中（可能编造原文证据）'
            : null,
          basisAllNonEmpty: issues.every((issue) => issue.basisNonEmpty),
          suggestionAllNonEmpty: issues.every((issue) => issue.suggestionNonEmpty),
          promptTokens,
          completionTokens: usage?.completionTokens ?? 0,
          cachedPromptTokens,
          cacheHitRatio:
            promptTokens > 0 ? Number((cachedPromptTokens / promptTokens).toFixed(3)) : null,
          attempts: result.attempts,
        },
        usage,
        sample: preview(
          `${data.summary}\n${issues
            .map((issue) => `[${issue.severityLabel}] ${issue.dimension}：${issue.excerpt}`)
            .join('\n')}`,
        ),
      };
    });
  }, 180_000);
});

// 没有 Key 时也给出一条可见的提示，避免「为什么全 skip」找错方向
if (!HAS_KEY) {
  describe('真实模型抽检（已跳过）', () => {
    it('未设置 REAL_LLM_API_KEY / DEEPSEEK_API_KEY：见 .agents/tasks/real-device-live-check/README.md', () => {});
  });
}
