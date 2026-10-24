import { describe, expect, it } from 'vitest';
import { entryHaystack, matchesKeyword } from './entrySearch';
import { KnowledgeEntrySchema, type KnowledgeEntry } from './schema';

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    id: 'e1',
    novelId: 'n1',
    categoryId: 'c1',
    title: '林越',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

describe('搜索匹配范围', () => {
  it('覆盖标题、摘要、别名与所有字段值', () => {
    const haystack = entryHaystack(
      entry({
        title: '林越',
        summary: '少年剑客',
        aliases: ['阿越'],
        fields: { identity: '流亡贵族', voice: '语气低沉' },
      }),
    );

    expect(haystack).toContain('林越');
    expect(haystack).toContain('少年剑客');
    expect(haystack).toContain('阿越');
    expect(haystack).toContain('流亡贵族');
    expect(haystack).toContain('语气低沉');
  });

  it('命中任意一处即视为匹配', () => {
    const target = entry({ summary: '少年剑客', aliases: ['阿越'], fields: { x: '流亡贵族' } });

    expect(matchesKeyword(target, '林越')).toBe(true);
    expect(matchesKeyword(target, '剑客')).toBe(true);
    expect(matchesKeyword(target, '阿越')).toBe(true);
    expect(matchesKeyword(target, '流亡')).toBe(true);
    expect(matchesKeyword(target, '不存在')).toBe(false);
  });

  it('忽略大小写与首尾空白', () => {
    const target = entry({ title: 'Lin Yue' });
    expect(matchesKeyword(target, '  lin yue  ')).toBe(true);
  });

  it('空关键词匹配全部', () => {
    expect(matchesKeyword(entry(), '')).toBe(true);
    expect(matchesKeyword(entry(), '   ')).toBe(true);
  });
});
