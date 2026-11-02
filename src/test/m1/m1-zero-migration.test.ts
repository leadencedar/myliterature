/**
 * 迁移基线门禁（原 M1 零迁移验收，UI v2 阶段 3 更新）。
 *
 * M1 当时要求「不新增实体字段、不升 Dexie、不动备份版本」；阶段 3 有意加入
 * `Chapter.note`（作者备忘），因此基线同步为：
 * - DB verno = 8（v8 迁移给旧章节补空串）
 * - 表清单 16 张（不含 internal 表）
 * - BACKUP_VERSION = 5（旧版应用恢复 v5 备份会明确报版本过新，而不是静默丢 memo）
 * - 8 个核心 schema `parse` 后的 key 集合
 *
 * 这个测试仍保留，用于防「再次静默迁移」：任何一项变化都必须同时更新数据库迁移、
 * 备份版本与恢复测试。
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '@/data/dexie/db';
import {
  ChapterSchema,
  ChapterSummarySchema,
  KnowledgeEntrySchema,
  NovelSchema,
  OutlineNodeSchema,
  ProposalSchema,
  SideStorySchema,
  StyleProfileSchema,
} from '@/domain/schema';
import { BACKUP_VERSION } from '@/features/export/backup';

/** HEAD 上 dump 出来的冻结值，永不随实现更新 */
const HEAD_VERNO = 8;
const HEAD_BACKUP_VERSION = 5;
const HEAD_TABLES = [
  'categories',
  'chapterSummaries',
  'chapters',
  'dailyLogs',
  'entries',
  'glossaries',
  'importJobs',
  'novels',
  'outlineNodes',
  'plans',
  'proposals',
  'scenarioNodes',
  'scenarios',
  'sideStories',
  'styleProfiles',
  'writingNorms',
].sort();

const HEAD_SCHEMA_KEYS = {
  ChapterSchema: [
    'content',
    'createdAt',
    'id',
    'index',
    'note',
    'novelId',
    'outlineNodeId',
    'scenarioSource',
    'sideStoryId',
    'source',
    'sourceContent',
    'sourceLanguage',
    'status',
    'title',
    'updatedAt',
    'wordCount',
  ],
  ChapterSummarySchema: [
    'appearingEntryIds',
    'chapterId',
    'createdAt',
    'id',
    'keyEvents',
    'novelId',
    'openThreads',
    'summary',
    'updatedAt',
  ],
  KnowledgeEntrySchema: [
    'aliases',
    'categoryId',
    'createdAt',
    'deletedAt',
    'fieldLocks',
    'fields',
    'id',
    'novelId',
    'pinned',
    'scope',
    'sourceChapterIds',
    'summary',
    'title',
    'updatedAt',
    'version',
  ],
  NovelSchema: [
    'createdAt',
    'deletedAt',
    'genre',
    'id',
    'oneLiner',
    'pov',
    'rollingSummary',
    'status',
    'targetWords',
    'title',
    'updatedAt',
  ],
  OutlineNodeSchema: [
    'createdAt',
    'id',
    'linkedEntryIds',
    'novelId',
    'order',
    'parentId',
    'scenarioSource',
    'status',
    'synopsis',
    'targetWords',
    'title',
    'updatedAt',
  ],
  ProposalSchema: [
    'action',
    'batchId',
    'createdAt',
    'decidedAt',
    'diff',
    'id',
    'label',
    'novelId',
    'order',
    'origin',
    'payload',
    'sourceRef',
    'status',
    'target',
    'targetId',
  ],
  SideStorySchema: [
    'createdAt',
    'id',
    'novelId',
    'order',
    'rollingSummary',
    'scenarioSource',
    'synopsis',
    'title',
    'updatedAt',
  ],
  StyleProfileSchema: [
    'createdAt',
    'customRubric',
    'extraInstruction',
    'id',
    'methodology',
    'novelId',
    'subGenre',
    'tradition',
    'updatedAt',
    'voiceRefs',
  ],
} as const;

let database: AppDatabase | undefined;

afterEach(async () => {
  if (database) {
    database.close();
    await database.delete();
    database = undefined;
  }
});

describe('零迁移 · Dexie 与备份版本', () => {
  it(`架构版本仍是 ${HEAD_VERNO}，表清单与 HEAD 相同`, () => {
    database = new AppDatabase(`test-${crypto.randomUUID()}`);
    expect(database.verno).toBe(HEAD_VERNO);
    expect(database.tables.map((table) => table.name).sort()).toEqual(HEAD_TABLES);
  });

  it(`备份版本仍是 ${HEAD_BACKUP_VERSION}`, () => {
    expect(BACKUP_VERSION).toBe(HEAD_BACKUP_VERSION);
  });
});

describe('零迁移 · 实体 schema 无新增字段', () => {
  it('Chapter / OutlineNode / ChapterSummary / SideStory', () => {
    const chapter = Object.keys(
      ChapterSchema.parse({ id: 'x', novelId: 'n', index: 1, createdAt: 0, updatedAt: 0 }),
    ).sort();
    const outline = Object.keys(
      OutlineNodeSchema.parse({ id: 'x', novelId: 'n', title: 't', createdAt: 0, updatedAt: 0 }),
    ).sort();
    const summary = Object.keys(
      ChapterSummarySchema.parse({
        id: 'x',
        novelId: 'n',
        chapterId: 'c',
        createdAt: 0,
        updatedAt: 0,
      }),
    ).sort();
    const side = Object.keys(
      SideStorySchema.parse({ id: 'x', novelId: 'n', title: 't', createdAt: 0, updatedAt: 0 }),
    ).sort();

    expect(chapter).toEqual([...HEAD_SCHEMA_KEYS.ChapterSchema]);
    expect(outline).toEqual([...HEAD_SCHEMA_KEYS.OutlineNodeSchema]);
    expect(summary).toEqual([...HEAD_SCHEMA_KEYS.ChapterSummarySchema]);
    expect(side).toEqual([...HEAD_SCHEMA_KEYS.SideStorySchema]);
  });

  it('KnowledgeEntry / Novel / Proposal / StyleProfile', () => {
    const entry = Object.keys(
      KnowledgeEntrySchema.parse({
        id: 'x',
        novelId: 'n',
        categoryId: 'c',
        title: 't',
        createdAt: 0,
        updatedAt: 0,
      }),
    ).sort();
    const novel = Object.keys(
      NovelSchema.parse({ id: 'x', title: 't', createdAt: 0, updatedAt: 0 }),
    ).sort();
    const proposal = Object.keys(
      ProposalSchema.parse({
        id: 'x',
        novelId: 'n',
        origin: 'generate',
        target: 'novel',
        action: 'create',
        payload: null,
        createdAt: 0,
      }),
    ).sort();
    const style = Object.keys(
      StyleProfileSchema.parse({ id: 'x', novelId: 'n', createdAt: 0, updatedAt: 0 }),
    ).sort();

    expect(entry).toEqual([...HEAD_SCHEMA_KEYS.KnowledgeEntrySchema]);
    expect(novel).toEqual([...HEAD_SCHEMA_KEYS.NovelSchema]);
    expect(proposal).toEqual([...HEAD_SCHEMA_KEYS.ProposalSchema]);
    expect(style).toEqual([...HEAD_SCHEMA_KEYS.StyleProfileSchema]);
  });
});
