import { describe, expect, it, vi } from 'vitest';
import type { Chapter, Novel, StyleProfile } from '@/domain/schema';
import type { LlmRunner } from '@/llm/useLlm';
import {
  STYLE_ANCHOR_BLOCK_TITLE,
  STYLE_CHECK_SEVERITY_LABELS,
  STYLE_CHECK_TASK,
  StyleCheckSchema,
  buildStyleCheckSystemPrompt,
  buildStyleCheckUserPrompt,
  runStyleCheck,
} from './styleCheck';

const novel = {
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  pov: 'third-limited',
  targetWords: 300000,
  status: 'writing',
  oneLiner: '',
  rollingSummary: '',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
} as unknown as Novel;

const style: StyleProfile = {
  id: 's1',
  novelId: 'n1',
  tradition: 'web',
  subGenre: '仙侠',
  methodology: 'web-rhythm',
  voiceRefs: [{ refId: 'gulong', name: '古龙', weight: 70 }],
  customRubric: null,
  extraInstruction: '对白少用感叹号，打斗不写招式名。',
  createdAt: 0,
  updatedAt: 0,
};

function makeChapter(over: {
  id: string;
  index: number;
  content?: string;
  status?: Chapter['status'];
  sideStoryId?: string | null;
}): Chapter {
  return {
    id: over.id,
    novelId: 'n1',
    outlineNodeId: null,
    index: over.index,
    title: `第${over.index}章`,
    content: over.content ?? '',
    wordCount: (over.content ?? '').length,
    status: over.status ?? 'draft',
    sideStoryId: over.sideStoryId ?? null,
    source: 'manual',
    sourceContent: null,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Chapter;
}

/** 只实现 runStructured 的假 runner：文风检查不该碰流式/仓储 */
function fakeLlm(handler: (task: string, options: unknown) => unknown): LlmRunner {
  return {
    configured: true,
    runStructured: vi.fn((task: string, options: unknown) =>
      Promise.resolve(handler(task, options)),
    ),
  } as unknown as LlmRunner;
}

const EMPTY_RESULT = {
  summary: '整体仍是作者本人的语感，只有两处对话偏了解释。',
  issues: [],
};

describe('style-check schema', () => {
  it('接受整体判断 + 最多 5 条问题', () => {
    const parsed = StyleCheckSchema.parse({
      summary: '整体稳定。',
      issues: [
        {
          dimension: '叙述距离',
          severity: 'high',
          excerpt: '他心中想到，这大概就是命运。',
          basis: '锚点是外部动作叙述，这里改成第三人称心理直述，距离突然拉近。',
          suggestion: '删掉解释，让动作承担信息。',
        },
      ],
    });
    expect(parsed.issues[0]?.severity).toBe('high');
  });

  it('超过 5 条问题或字段缺失都拒绝', () => {
    const issue = {
      dimension: '句式',
      severity: 'low',
      excerpt: '雪落了整夜。',
      basis: '与锚点一致的短句。',
      suggestion: '保持。',
    };
    expect(
      StyleCheckSchema.safeParse({
        summary: '稳定',
        issues: Array.from({ length: 6 }, () => issue),
      }).success,
    ).toBe(false);
    expect(
      StyleCheckSchema.safeParse({
        summary: '稳定',
        issues: [{ ...issue, excerpt: '' }],
      }).success,
    ).toBe(false);
    expect(
      StyleCheckSchema.safeParse({
        summary: '稳定',
        issues: [{ ...issue, severity: 'critical' }],
      }).success,
    ).toBe(false);
    // basis 必填：只给建议不说明差在哪，读起来像判决
    expect(
      StyleCheckSchema.safeParse({ summary: '稳定', issues: [{ ...issue, basis: '' }] }).success,
    ).toBe(false);
  });

  it('severity 用中性差异标签，不用判决口吻', () => {
    expect(STYLE_CHECK_SEVERITY_LABELS).toEqual({
      high: '差异较大',
      medium: '局部差异',
      low: '轻微差异',
    });
  });
});

describe('style-check 提示词', () => {
  it('system 含风格档案与只诊断不改稿的约束', () => {
    const system = buildStyleCheckSystemPrompt(novel, style);
    expect(system).toContain('归墟纪');
    expect(system).toContain(STYLE_CHECK_TASK);
    expect(system).toContain('只诊断，不改稿');
    expect(system).toContain('最多 5 条');
    expect(system).toContain('不要把情节好坏、题材选择、人物三观当成文风问题');
    expect(system).toContain('basis');
    expect(system).toContain('句长、叙述距离、对话密度、意象密度');
  });

  it('user 块顺序：文风锚点 → 本章正文 → 本次要求', () => {
    const anchor = {
      chapterId: 'c1',
      index: 1,
      label: '第 1 章开头',
      text: '雪落了整夜，他背着刀走进渡口。',
    };
    const user = buildStyleCheckUserPrompt({ anchor, content: '  江雾压得很低。  ' });
    const anchorAt = user.indexOf(STYLE_ANCHOR_BLOCK_TITLE);
    const contentAt = user.indexOf('【本章正文】');
    const askAt = user.indexOf('【本次要求】');
    expect(anchorAt).toBeGreaterThanOrEqual(0);
    expect(contentAt).toBeGreaterThan(anchorAt);
    expect(askAt).toBeGreaterThan(contentAt);
    expect(user).toContain(anchor.text);
    expect(user).toContain('江雾压得很低。');
    expect(user).not.toContain('  江雾压得很低。  ');
  });

  it('没有锚点时整块省略', () => {
    const user = buildStyleCheckUserPrompt({ anchor: null, content: '江雾压得很低。' });
    expect(user).not.toContain(STYLE_ANCHOR_BLOCK_TITLE);
    expect(user).toContain('【本章正文】\n江雾压得很低。');
  });
});

describe('runStyleCheck', () => {
  it('一次 style-check 结构化调用；返回结果与对照锚点', async () => {
    const llm = fakeLlm((task, options) => {
      expect(task).toBe('style-check');
      expect(options).toMatchObject({
        schemaName: 'StyleCheck',
        failOnTruncation: true,
      });
      return { data: { summary: '整体稳定。', issues: [] }, attempts: 1 };
    });
    const earlier = makeChapter({
      id: 'c1',
      index: 1,
      status: 'done',
      content: '雪落了整夜。'.repeat(60),
    });
    const target = makeChapter({ id: 'c2', index: 2, content: '江雾压得很低，船夫撑着篙。' });

    const { result, anchor } = await runStyleCheck(
      { llm },
      { novel, style, chapter: target, chapters: [earlier, target], targetChapterId: target.id },
    );

    expect(result.summary).toBe('整体稳定。');
    expect(anchor).toMatchObject({ chapterId: 'c1', label: '第 1 章开头' });
    const options = vi.mocked(llm.runStructured).mock.calls[0]![1] as {
      system: string;
      user: string;
    };
    expect(options.user).toContain(STYLE_ANCHOR_BLOCK_TITLE);
    expect(options.user).toContain('江雾压得很低，船夫撑着篙。');
  });

  it('第一章没有锚点：user 不出现锚点块', async () => {
    const llm = fakeLlm(() => ({ data: { summary: '稳定。', issues: [] }, attempts: 1 }));
    const only = makeChapter({ id: 'c1', index: 1, content: '雪落了整夜。' });
    const { anchor } = await runStyleCheck(
      { llm },
      { novel, style, chapter: only, chapters: [only], targetChapterId: only.id },
    );
    expect(anchor).toBeNull();
    const options = vi.mocked(llm.runStructured).mock.calls[0]![1] as { user: string };
    expect(options.user).not.toContain(STYLE_ANCHOR_BLOCK_TITLE);
  });

  it('外传章用「外传第 N 章开头」标签，且不拿主线章当锚点', async () => {
    const llm = fakeLlm(() => ({ data: { summary: '稳定。', issues: [] }, attempts: 1 }));
    const main = makeChapter({
      id: 'm1',
      index: 1,
      status: 'done',
      content: '主线正文。'.repeat(80),
    });
    const sideEarlier = makeChapter({
      id: 's1',
      index: 1,
      status: 'done',
      sideStoryId: 'story-1',
      content: '外传正文。'.repeat(80),
    });
    const target = makeChapter({
      id: 's2',
      index: 2,
      sideStoryId: 'story-1',
      content: '外传第二章正文。',
    });
    const { anchor } = await runStyleCheck(
      { llm },
      {
        novel,
        style,
        chapter: target,
        chapters: [main, sideEarlier, target],
        targetChapterId: target.id,
      },
    );
    expect(anchor?.label).toBe('外传第 1 章开头');
    expect(anchor?.chapterId).toBe('s1');
  });

  it('空正文直接拒绝，不调用模型', async () => {
    const llm = fakeLlm(() => ({ data: EMPTY_RESULT, attempts: 1 }));
    const empty = makeChapter({ id: 'c1', index: 1, content: '   ' });
    await expect(
      runStyleCheck(
        { llm },
        { novel, style, chapter: empty, chapters: [empty], targetChapterId: empty.id },
      ),
    ).rejects.toThrow('本章还没有正文');
    expect(llm.runStructured).not.toHaveBeenCalled();
  });

  it('模型错误原样透传', async () => {
    const llm = fakeLlm(() => {
      throw new Error('服务暂时不可用');
    });
    const chapter = makeChapter({ id: 'c1', index: 1, content: '雪落了整夜。' });
    await expect(
      runStyleCheck(
        { llm },
        { novel, style, chapter, chapters: [chapter], targetChapterId: chapter.id },
      ),
    ).rejects.toThrow('服务暂时不可用');
  });
});
