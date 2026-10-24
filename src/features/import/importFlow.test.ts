import { describe, expect, it } from 'vitest';
import {
  ImportJobSchema,
  type ImportChapterState,
  type ImportDraft,
  type ImportJob,
  type ImportWorldviewChunk,
} from '@/domain/schema';
import { resumeStepOf } from './importFlow';

function draft(index: number, overrides: Partial<ImportDraft> = {}): ImportDraft {
  return {
    index,
    title: `第${index}章`,
    content: '正文',
    sourceContent: '',
    sourceLanguage: '',
    translateStatus: 'none',
    translateError: '',
    ...overrides,
  };
}

const CHAPTER: ImportChapterState = {
  index: 1,
  title: '离乡',
  chapterId: 'c1',
  status: 'pending',
  error: '',
  translateStatus: 'none',
  translateError: '',
};

const CHUNK: ImportWorldviewChunk = {
  index: 1,
  title: '',
  content: '设定',
  status: 'pending',
  error: '',
};

function job(overrides: Partial<ImportJob> = {}): ImportJob {
  return ImportJobSchema.parse({
    id: 'job1',
    novelId: 'n1',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

const MAIN = { kind: 'main' } as const;
const SIDE = { kind: 'side', sideStoryId: 's1' } as const;
const WORLDVIEW = { kind: 'worldview' } as const;

describe('resumeStepOf：六种返回', () => {
  it('destination 为 null 且三个数组都为空：静默清掉', () => {
    expect(resumeStepOf(job())).toEqual({ discard: 'silent' });
  });

  it('不合阶段表：清掉并提示（与 silent 区分）', () => {
    const result = resumeStepOf(job({ destination: null, chapters: [CHAPTER] }));
    expect(result).toEqual({ discard: 'notice' });
    expect(result).not.toEqual({ discard: 'silent' });
  });

  it('草稿阶段有 pending 或 failed 的翻译：回到翻译步骤', () => {
    expect(
      resumeStepOf(job({ drafts: [draft(1), draft(2, { translateStatus: 'pending' })] })),
    ).toEqual({ step: 'translate' });
    expect(resumeStepOf(job({ drafts: [draft(1, { translateStatus: 'failed' })] }))).toEqual({
      step: 'translate',
    });
  });

  it('草稿阶段其余情况：回到目的地步骤', () => {
    expect(
      resumeStepOf(
        job({ drafts: [draft(1), draft(2, { translateStatus: 'done', sourceContent: 'src' })] }),
      ),
    ).toEqual({ step: 'destination' });
  });

  it('worldview：按段进入提取步骤', () => {
    expect(resumeStepOf(job({ destination: WORLDVIEW, worldviewChunks: [CHUNK] }))).toEqual({
      step: 'extract',
    });
  });

  it('main / side：按章进入提取步骤', () => {
    expect(resumeStepOf(job({ destination: MAIN, chapters: [CHAPTER] }))).toEqual({
      step: 'extract',
    });
    expect(resumeStepOf(job({ destination: SIDE, chapters: [CHAPTER] }))).toEqual({
      step: 'extract',
    });
  });
});

describe('resumeStepOf：不合阶段表的组合一律 notice', () => {
  it.each<[string, Partial<ImportJob>]>([
    ['null + chapters 非空', { destination: null, drafts: [draft(1)], chapters: [CHAPTER] }],
    ['null + chunks 非空', { destination: null, drafts: [draft(1)], worldviewChunks: [CHUNK] }],
    ['main + chapters 为空', { destination: MAIN }],
    ['side + chapters 为空', { destination: SIDE }],
    ['main + chunks 非空', { destination: MAIN, chapters: [CHAPTER], worldviewChunks: [CHUNK] }],
    ['side + chunks 非空', { destination: SIDE, chapters: [CHAPTER], worldviewChunks: [CHUNK] }],
    ['main + drafts 非空', { destination: MAIN, chapters: [CHAPTER], drafts: [draft(1)] }],
    ['side + drafts 非空', { destination: SIDE, chapters: [CHAPTER], drafts: [draft(1)] }],
    ['worldview + chunks 为空', { destination: WORLDVIEW }],
    [
      'worldview + chapters 非空',
      { destination: WORLDVIEW, worldviewChunks: [CHUNK], chapters: [CHAPTER] },
    ],
    [
      'worldview + drafts 非空',
      { destination: WORLDVIEW, worldviewChunks: [CHUNK], drafts: [draft(1)] },
    ],
  ])('%s', (_name, overrides) => {
    expect(resumeStepOf(job(overrides))).toEqual({ discard: 'notice' });
  });
});

describe('resumeStepOf：全函数', () => {
  it('数组字段缺失时不抛错', () => {
    const partial = (value: Record<string, unknown>) => value as unknown as ImportJob;
    expect(() => resumeStepOf(partial({}))).not.toThrow();
    expect(resumeStepOf(partial({}))).toEqual({ discard: 'silent' });
    expect(resumeStepOf(partial({ destination: MAIN }))).toEqual({ discard: 'notice' });
    expect(resumeStepOf(partial({ destination: WORLDVIEW, worldviewChunks: [CHUNK] }))).toEqual({
      step: 'extract',
    });
    expect(resumeStepOf(partial({ destination: null, drafts: [draft(1)] }))).toEqual({
      step: 'destination',
    });
  });
});
