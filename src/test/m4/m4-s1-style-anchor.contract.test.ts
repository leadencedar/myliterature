/**
 * M4-S1 独立验收：文风锚点选择 + 上下文注入。
 *
 * 覆盖 task-69 要求：选择函数（顺序/仅更早/已完成优先/<300 跳过/600 字截断/确定性）、
 * 生成上下文注入（风格后、规范前；独立 item；第一章无；预算不足 dropped；两次逐字节一致）。
 *
 * 独立于开发测试：用真实仓储夹具 + 真实 SummaryChainContextBuilder，不复用开发断言。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chapter, Novel, StyleProfile, WritingNorm } from '@/domain/schema';
import {
  containsDialogue,
  selectStyleAnchor,
  STYLE_ANCHOR_CHARS,
  STYLE_ANCHOR_MIN_CHARS,
} from '@/context/styleAnchor';
import { SummaryChainContextBuilder } from '@/context/SummaryChainContextBuilder';
import type { ContextRequest } from '@/context/ContextBuilder';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';

// ---------------------------------------------------------------- 纯函数夹具

function chapterFixture(
  index: number,
  overrides: Partial<Chapter> & { sideStoryId?: string | null } = {},
): Chapter {
  return {
    id: `ch-${index}`,
    novelId: 'n1',
    index,
    title: `第${index}章`,
    content: '',
    wordCount: 0,
    status: 'draft',
    outlineNodeId: null,
    sideStoryId: null,
    createdAt: index,
    updatedAt: index,
    ...overrides,
  } as Chapter;
}

function longText(chars: number, prefix = ''): string {
  return `${prefix}${'江雾'.repeat(Math.ceil(chars / 2))}`.slice(0, chars);
}

describe('M4-S1 · selectStyleAnchor 纯函数', () => {
  it('目标章为空/找不到 → 无锚点', () => {
    const chapters = [chapterFixture(1, { content: longText(400), status: 'done' })];
    expect(selectStyleAnchor(chapters, null)).toBeNull();
    expect(selectStyleAnchor(chapters, 'missing')).toBeNull();
  });

  it('只取目标章之前、同一线；顺序取最早', () => {
    const chapters = [
      chapterFixture(1, { content: longText(400), status: 'draft' }),
      chapterFixture(2, { content: longText(400), status: 'draft' }),
      chapterFixture(3, { content: '目标章正文', status: 'draft' }),
      // 更晚的章不算
      chapterFixture(4, { content: longText(400), status: 'done' }),
    ];
    const anchor = selectStyleAnchor(chapters, 'ch-3');
    expect(anchor).toMatchObject({ chapterId: 'ch-1', index: 1, label: '第 1 章开头' });

    // 外传章节与主线互不取锚点
    const mixed = [
      chapterFixture(1, { content: longText(400), status: 'done' }),
      chapterFixture(2, { content: longText(400), status: 'done', sideStoryId: 's1' }),
      chapterFixture(3, { content: '外传目标', sideStoryId: 's1' }),
    ];
    expect(selectStyleAnchor(mixed, 'ch-3')?.chapterId).toBe('ch-2');
  });

  it('已完成优先（即使它更晚）；都是草稿时取最早有正文的一章', () => {
    const chapters = [
      chapterFixture(1, { content: longText(400), status: 'draft' }),
      chapterFixture(2, { content: longText(400), status: 'done' }),
      chapterFixture(3, { content: '目标' }),
    ];
    expect(selectStyleAnchor(chapters, 'ch-3')?.chapterId).toBe('ch-2');

    const allDraft = chapters.map((item) => ({ ...item, status: 'draft' as const }));
    expect(selectStyleAnchor(allDraft, 'ch-3')?.chapterId).toBe('ch-1');
  });

  it(`少于 ${STYLE_ANCHOR_MIN_CHARS} 字跳过；恰好 ${STYLE_ANCHOR_MIN_CHARS} 字接受`, () => {
    const below = [
      chapterFixture(1, { content: longText(STYLE_ANCHOR_MIN_CHARS - 1), status: 'done' }),
      chapterFixture(2, { content: '目标', status: 'draft' }),
    ];
    expect(selectStyleAnchor(below, 'ch-2')).toBeNull();

    const exact = [
      chapterFixture(1, { content: longText(STYLE_ANCHOR_MIN_CHARS), status: 'done' }),
      chapterFixture(2, { content: '目标', status: 'draft' }),
    ];
    const anchor = selectStyleAnchor(exact, 'ch-2');
    expect(anchor).not.toBeNull();
    expect(anchor!.text.length).toBeLessThanOrEqual(STYLE_ANCHOR_CHARS);
  });

  it('超过 600 字按段落边界截断并补「……」；不足 600 字原样返回', () => {
    const paragraphs = ['一段'.repeat(150), '二段'.repeat(150), '三段'.repeat(150)]; // 每段 300 字
    const longContent = paragraphs.join('\n\n');
    const chapters = [
      chapterFixture(1, { content: longContent, status: 'done' }),
      chapterFixture(2, { content: '目标' }),
    ];
    const anchor = selectStyleAnchor(chapters, 'ch-2')!;
    expect(anchor.text.endsWith('……')).toBe(true);
    // 600 上限下：第一段 300 + 空行估算 2 + 第二段 300 = 602 > 600 → 只留第一段
    expect(anchor.text).toBe(`${paragraphs[0]}……`);

    const short = chapterFixture(1, { content: longText(320), status: 'done' });
    const shortAnchor = selectStyleAnchor([short, chapterFixture(2, { content: '目标' })], 'ch-2')!;
    expect(shortAnchor.text).toBe(longText(320));
    expect(shortAnchor.text.endsWith('……')).toBe(false);
  });

  it('无空行的超长正文退回字数硬截，保证锚点非空', () => {
    const chapters = [
      chapterFixture(1, { content: '江'.repeat(900), status: 'done' }),
      chapterFixture(2, { content: '目标' }),
    ];
    const anchor = selectStyleAnchor(chapters, 'ch-2')!;
    expect(anchor.text.startsWith('江')).toBe(true);
    expect(anchor.text.endsWith('……')).toBe(true);
    expect(anchor.text.length).toBeLessThanOrEqual(STYLE_ANCHOR_CHARS + 2);
  });

  it('外传标签用传入的 chapterWord；确定性：同输入两次结果一致', () => {
    const chapters = [
      chapterFixture(1, { content: longText(400), status: 'done', sideStoryId: 's1' }),
      chapterFixture(2, { content: '外传目标', sideStoryId: 's1' }),
    ];
    const first = selectStyleAnchor(chapters, 'ch-2', '外传第');
    expect(first?.label).toBe('外传第 1 章开头');
    expect(selectStyleAnchor(chapters, 'ch-2', '外传第')).toEqual(first);
  });
});

// ---------------------------------------------------------------- M4.1 对白优先

describe('M4.1 · 锚点优先含对白（仅在已完成章里、只看开头节选）', () => {
  const narration = longText(400); // 无对白
  const withDialogue = `「官凭。」\n\n${longText(380)}`; // 开头含对白且总长 ≥300

  it('containsDialogue：中文「」/“” 与英文双引号视为对白', () => {
    expect(containsDialogue('「走吧。」他说。')).toBe(true);
    expect(containsDialogue('她说：“回家。”')).toBe(true);
    expect(containsDialogue('He said "go".')).toBe(true);
    expect(containsDialogue('雪落了整夜，追兵在门外。')).toBe(false);
    expect(containsDialogue(narration)).toBe(false);
  });

  it('首章无对白、次章有对白（均已完成）→ 选次章；label 随之变化', () => {
    const chapters = [
      chapterFixture(1, { content: narration, status: 'done' }),
      chapterFixture(2, { content: withDialogue, status: 'done' }),
      chapterFixture(3, { content: '目标', status: 'draft' }),
    ];
    const anchor = selectStyleAnchor(chapters, 'ch-3');
    expect(anchor).toMatchObject({ chapterId: 'ch-2', index: 2, label: '第 2 章开头' });
    expect(containsDialogue(anchor!.text)).toBe(true);
  });

  it('首章有对白 → 仍选首章（更早且含对白）', () => {
    const chapters = [
      chapterFixture(1, { content: withDialogue, status: 'done' }),
      chapterFixture(2, { content: `「另一段。」\n\n${longText(380)}`, status: 'done' }),
      chapterFixture(3, { content: '目标' }),
    ];
    expect(selectStyleAnchor(chapters, 'ch-3')?.chapterId).toBe('ch-1');
  });

  it('都无对白 → 仍按旧规则取最早的已完成章', () => {
    const chapters = [
      chapterFixture(1, { content: narration, status: 'done' }),
      chapterFixture(2, { content: longText(400), status: 'done' }),
      chapterFixture(3, { content: '目标' }),
    ];
    expect(selectStyleAnchor(chapters, 'ch-3')?.chapterId).toBe('ch-1');
  });

  it('草稿有对白、无已完成章 → 仍按旧规则取最早有正文的一章（草稿不因对白被优先）', () => {
    const chapters = [
      chapterFixture(1, { content: narration, status: 'draft' }),
      chapterFixture(2, { content: withDialogue, status: 'draft' }),
      chapterFixture(3, { content: '目标' }),
    ];
    expect(selectStyleAnchor(chapters, 'ch-3')?.chapterId).toBe('ch-1');
  });

  it('对白只在 600 字之后出现 → 不抢锚点（只对开头节选判断）', () => {
    const lateDialogue = `${'江雾'.repeat(350)}\n\n「后段的对白。」`; // 开头 600 字内无对白
    const chapters = [
      chapterFixture(1, { content: narration, status: 'done' }),
      chapterFixture(2, { content: lateDialogue, status: 'done' }),
      chapterFixture(3, { content: '目标' }),
    ];
    const anchor = selectStyleAnchor(chapters, 'ch-3');
    expect(anchor?.chapterId).toBe('ch-1');
    expect(containsDialogue(anchor!.text)).toBe(false);
  });
});

// ---------------------------------------------------------------- ContextBuilder 集成

let harness: TestHarness;
let novel: Novel;
let style: StyleProfile;
let norm: WritingNorm;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '锚点之书', genre: '仙侠' });
  style = (await harness.repository.getStyleProfile(novel.id))!;
  norm = await harness.repository.createWritingNorm(novel.id, {
    title: '用词',
    content: '不要写招式名。',
  });
});

afterEach(async () => {
  await harness.cleanup();
});

async function makeChapter(
  title: string,
  content: string,
  status: 'draft' | 'done' = 'draft',
): Promise<Chapter> {
  const created = await harness.repository.createChapter(novel.id, { title, content });
  if (status === 'done') await harness.repository.updateChapter(created.id, { status: 'done' });
  return (await harness.repository.listChapters(novel.id)).find((item) => item.id === created.id)!;
}

async function requestFor(targetChapterId: string): Promise<ContextRequest> {
  return {
    novel,
    style,
    categories: await harness.repository.listCategories(novel.id),
    entries: [],
    outline: [],
    chapters: await harness.repository.listChapters(novel.id),
    summaries: [],
    targetNodeId: null,
    targetChapterId,
    writingNorms: [norm],
  };
}

function buildWith(builderRequest: ContextRequest) {
  return new SummaryChainContextBuilder().build(builderRequest);
}

describe('M4-S1 · 上下文注入（真实 builder）', () => {
  it('有更早已完成正文：锚点块在风格后、规范前，独立 item 可见且 token>0', async () => {
    const ch1 = await makeChapter('源头', longText(400), 'done');
    const ch2 = await makeChapter('目标章', '目标章正文。');
    const built = buildWith(await requestFor(ch2.id));

    expect(built.stablePrefix).toContain('【文风锚点 · 第 1 章开头（作者本人原文）】');
    expect(built.stablePrefix).toContain(
      '只用来对齐句式、节奏与叙述距离；不要复述或照搬其中的情节与句子。',
    );
    const styleAt = built.stablePrefix.indexOf('【文体取向】');
    const anchorAt = built.stablePrefix.indexOf('【文风锚点');
    const normAt = built.stablePrefix.indexOf('【作者的写作规范】');
    expect(styleAt).toBeGreaterThan(-1);
    expect(anchorAt).toBeGreaterThan(styleAt);
    expect(anchorAt).toBeLessThan(normAt);

    const anchorItem = built.items.find((item) => item.kind === 'styleAnchor')!;
    expect(anchorItem).toMatchObject({
      id: ch1.id,
      label: '文风锚点 · 第 1 章开头',
      included: true,
    });
    expect(anchorItem.tokens).toBeGreaterThan(0);
    const kinds = built.items.map((item) => item.kind);
    expect(kinds.indexOf('styleAnchor')).toBeGreaterThan(kinds.indexOf('meta'));
    expect(kinds.indexOf('styleAnchor')).toBeLessThan(kinds.indexOf('norm'));
  });

  it('M4.1：完成章里优先含对白的一章，注入 label 随选择变化且顺序不变', async () => {
    await makeChapter('首章叙述', longText(400), 'done'); // 无对白
    await makeChapter('次章对白', `「官凭。」\n\n${longText(380)}`, 'done');
    const target = await makeChapter('目标章', '目标章正文。');
    const built = buildWith(await requestFor(target.id));

    expect(built.stablePrefix).toContain('【文风锚点 · 第 2 章开头（作者本人原文）】');
    const anchorItem = built.items.find((item) => item.kind === 'styleAnchor')!;
    expect(anchorItem.label).toBe('文风锚点 · 第 2 章开头');
    const styleAt = built.stablePrefix.indexOf('【文体取向】');
    const anchorAt = built.stablePrefix.indexOf('【文风锚点');
    const normAt = built.stablePrefix.indexOf('【作者的写作规范】');
    expect(anchorAt).toBeGreaterThan(styleAt);
    expect(anchorAt).toBeLessThan(normAt);
  });

  it('第一章（无更早正文）：无锚点文本、无锚点 item（行为与改动前一致）', async () => {
    const only = await makeChapter('第一章', '第一章正文。');
    const built = buildWith(await requestFor(only.id));
    expect(built.stablePrefix).not.toContain('【文风锚点');
    expect(built.items.some((item) => item.kind === 'styleAnchor')).toBe(false);
  });

  it('预算不足时锚点进 dropped：文本不进前缀、清单可见原因', async () => {
    await makeChapter('源头', longText(400), 'done');
    const ch2 = await makeChapter('目标章', '目标章正文。');
    const request = await requestFor(ch2.id);
    // ch1 内容较短时 budget=1 已能把锚点裁掉；仍保留其它强制块（风格/规范）
    const built = buildWith({ ...request, budget: 1 });
    expect(built.stablePrefix).not.toContain('【文风锚点');
    expect(built.items.find((item) => item.kind === 'styleAnchor')).toMatchObject({
      included: false,
      droppedReason: '超出 token 预算',
    });
  });

  it('确定性：同一请求连续构建两次，前缀与清单逐字节一致', async () => {
    await makeChapter('源头', longText(400), 'done');
    const ch2 = await makeChapter('目标章', '目标章正文。');
    const request = await requestFor(ch2.id);
    const first = buildWith(request);
    const second = buildWith(await requestFor(ch2.id));
    expect(first.stablePrefix).toBe(second.stablePrefix);
    expect(JSON.stringify(first.items)).toBe(JSON.stringify(second.items));
  });

  it('作者编辑早期章节后锚点自动更新（内容变化反映到 prompt）', async () => {
    const ch1 = await makeChapter('源头', longText(400), 'done');
    const ch2 = await makeChapter('目标章', '目标章正文。');
    const before = buildWith(await requestFor(ch2.id)).stablePrefix;
    await harness.repository.updateChapter(ch1.id, {
      content: `改稿后的开头。\n\n${'新江雾'.repeat(120)}`,
    });
    const after = buildWith(await requestFor(ch2.id)).stablePrefix;
    expect(before).not.toBe(after);
    expect(after).toContain('改稿后的开头。');
  });
});
