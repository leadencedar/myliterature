import { describe, expect, it } from 'vitest';
import { WritingNormSchema, type WritingNorm } from './schema';
import {
  ALL_NORM_SCOPES,
  ALL_NORM_SCOPES_V6,
  DIFF_NOTE_TEMPLATE,
  DIFF_NOTE_TITLE,
  NORM_CONTENT_MAX,
  NORM_LINK_WARN,
  NORM_SCOPES,
  NORM_TITLE_MAX,
  NORM_TOKEN_WARN,
  NORMS_TOTAL_TOKEN_WARN,
  addInteractiveScopeIfFull,
  compareNorms,
  condensedTitle,
  countLinks,
  normalizeNormScopes,
  normsInScope,
  validateNormDraft,
} from './writingNorm';

function norm(id: string, overrides: Partial<WritingNorm> = {}): WritingNorm {
  return WritingNormSchema.parse({
    id,
    novelId: 'n1',
    title: id,
    content: `${id} 的正文`,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function parseWith(overrides: Partial<WritingNorm>) {
  return WritingNormSchema.safeParse({
    id: 'x',
    novelId: 'n1',
    title: '标题',
    content: '正文',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

describe('作用范围', () => {
  it('六项按固定顺序，默认值与 schema 一致', () => {
    expect(ALL_NORM_SCOPES).toEqual([
      'writing',
      'planning',
      'summary',
      'extract',
      'check',
      'interactive',
    ]);
    expect(NORM_SCOPES.map((scope) => scope.label)).toEqual([
      '写正文',
      '规划',
      '章节摘要',
      '提取设定',
      '检查',
      '互动推演',
    ]);
    expect(norm('a').scopes).toEqual(ALL_NORM_SCOPES);
  });

  it('normalizeNormScopes 去重并按固定顺序排列，不改入参', () => {
    const input = ['check', 'writing', 'writing', 'summary'] as const;
    expect(normalizeNormScopes(input)).toEqual(['writing', 'summary', 'check']);
    expect(input).toEqual(['check', 'writing', 'writing', 'summary']);
    expect(normalizeNormScopes([])).toEqual([]);
  });

  it('未知值保留在末尾，交给 schema 拒绝而不是悄悄丢掉', () => {
    const input = ['bogus', 'check', 'bogus'] as unknown as WritingNorm['scopes'];
    expect(normalizeNormScopes(input)).toEqual(['check', 'bogus']);
  });

  it('addInteractiveScopeIfFull：只有五项全开的老规范补上互动推演', () => {
    expect(ALL_NORM_SCOPES_V6).toEqual(['writing', 'planning', 'summary', 'extract', 'check']);
    expect(Object.isFrozen(ALL_NORM_SCOPES_V6)).toBe(true);
    // 五项乱序 → 六项、规范顺序
    expect(
      addInteractiveScopeIfFull(['check', 'extract', 'writing', 'summary', 'planning']),
    ).toEqual(ALL_NORM_SCOPES);
    expect(addInteractiveScopeIfFull(ALL_NORM_SCOPES_V6)).toEqual(ALL_NORM_SCOPES);
    // 收窄过的、已含 interactive 的、空数组：原样
    expect(addInteractiveScopeIfFull(['writing', 'planning', 'summary', 'extract'])).toEqual([
      'writing',
      'planning',
      'summary',
      'extract',
    ]);
    expect(addInteractiveScopeIfFull(['writing', 'interactive'])).toEqual([
      'writing',
      'interactive',
    ]);
    expect(addInteractiveScopeIfFull(ALL_NORM_SCOPES)).toEqual(ALL_NORM_SCOPES);
    expect(addInteractiveScopeIfFull([])).toEqual([]);
    // 不改入参
    const input: WritingNorm['scopes'] = ['check', 'extract', 'writing', 'summary', 'planning'];
    addInteractiveScopeIfFull(input);
    expect(input).toEqual(['check', 'extract', 'writing', 'summary', 'planning']);
  });

  it('非法作用范围被 schema 拒绝', () => {
    expect(parseWith({ scopes: ['translate'] as unknown as WritingNorm['scopes'] }).success).toBe(
      false,
    );
  });
});

describe('排序与过滤', () => {
  it('compareNorms 按 order → createdAt → id', () => {
    const rows = [
      norm('b', { order: 1, createdAt: 5 }),
      norm('c', { order: 0, createdAt: 9 }),
      norm('a', { order: 1, createdAt: 5 }),
      norm('d', { order: 0, createdAt: 3 }),
    ];
    expect([...rows].sort(compareNorms).map((row) => row.id)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('normsInScope 滤掉停用、作用范围外、排除集合里的规范，乱序输入排好序输出', () => {
    const rows = [
      norm('late', { order: 2 }),
      norm('disabled', { order: 0, enabled: false }),
      norm('extractOnly', { order: 0, scopes: ['extract'] }),
      norm('excluded', { order: 0 }),
      norm('early', { order: 1 }),
      norm('noScope', { order: 0, scopes: [] }),
    ];
    const result = normsInScope(rows, 'writing', new Set(['excluded']));
    expect(result.map((row) => row.id)).toEqual(['early', 'late']);
    // 返回新数组，不改入参顺序
    expect(rows[0]?.id).toBe('late');
    expect(normsInScope(rows, 'extract').map((row) => row.id)).toEqual([
      'excluded',
      'extractOnly',
      'early',
      'late',
    ]);
  });

  it('读取路径不 parse，正文只有空白的行也不注入', () => {
    const blank = { ...norm('blank'), content: '  \n ' };
    expect(normsInScope([blank], 'writing')).toEqual([]);
  });
});

describe('链接计数', () => {
  it('只数 http / https 链接', () => {
    expect(countLinks('')).toBe(0);
    expect(countLinks('见 https://a.example/x 与 http://b.example，另有 ftp://c.example')).toBe(2);
    expect(
      countLinks(Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`).join('\n')),
    ).toBe(6);
  });
});

describe('精简版标题', () => {
  it('56 字标题直接加后缀，正好 60 字', () => {
    const title = '规'.repeat(56);
    expect(condensedTitle(title)).toBe(`${title}（精简）`);
    expect(condensedTitle(title)).toHaveLength(60);
  });

  it('57 字与 60 字标题截成 56 字再加后缀', () => {
    expect(condensedTitle('规'.repeat(57))).toBe(`${'规'.repeat(56)}（精简）`);
    expect(condensedTitle('规'.repeat(60))).toBe(`${'规'.repeat(56)}（精简）`);
  });

  it('结果都能通过 schema 的标题校验', () => {
    for (const length of [1, 56, 57, 60]) {
      expect(parseWith({ title: condensedTitle('规'.repeat(length)) }).success).toBe(true);
    }
  });
});

describe('保存前预检', () => {
  it('合法时返回 undefined', () => {
    expect(
      validateNormDraft({ title: '使用提示', content: '## 写作规则\n- 一条' }),
    ).toBeUndefined();
  });

  it('返回中文错误而不是 ZodError JSON', () => {
    expect(validateNormDraft({ title: '  ', content: '正文' })).toBe('规范标题不能为空');
    expect(validateNormDraft({ title: '规'.repeat(61), content: '正文' })).toBe(
      '规范标题不能超过 60 字',
    );
    expect(validateNormDraft({ title: '标题', content: '  \n ' })).toBe('规范正文不能为空');
    expect(validateNormDraft({ title: '标题', content: '一'.repeat(60_001) })).toBe(
      '单份规范不能超过 60000 字',
    );
  });
});

describe('常量与 schema 一致', () => {
  it('标题边界 59 / 60 / 61', () => {
    expect(NORM_TITLE_MAX).toBe(60);
    expect(parseWith({ title: '规'.repeat(NORM_TITLE_MAX - 1) }).success).toBe(true);
    expect(parseWith({ title: '规'.repeat(NORM_TITLE_MAX) }).success).toBe(true);
    expect(parseWith({ title: '规'.repeat(NORM_TITLE_MAX + 1) }).success).toBe(false);
  });

  it('正文边界 60000 / 60001', () => {
    expect(NORM_CONTENT_MAX).toBe(60_000);
    expect(parseWith({ content: '一'.repeat(NORM_CONTENT_MAX) }).success).toBe(true);
    expect(parseWith({ content: '一'.repeat(NORM_CONTENT_MAX + 1) }).success).toBe(false);
  });

  it('提示阈值', () => {
    expect(NORM_TOKEN_WARN).toBe(2000);
    expect(NORMS_TOTAL_TOKEN_WARN).toBe(6000);
    expect(NORM_LINK_WARN).toBe(5);
  });

  it('正文不 trim：首尾空白原样保留', () => {
    const parsed = parseWith({ content: '\n  ## 标题\n\n- 一条  \n' });
    expect(parsed.success && parsed.data.content).toBe('\n  ## 标题\n\n- 一条  \n');
  });
});

describe('差异说明模板', () => {
  it('含九个【】字段', () => {
    const fields = DIFF_NOTE_TEMPLATE.match(/^【[^】]+】/gmu) ?? [];
    expect(fields).toEqual([
      '【原作版本】',
      '【本作开场时期】',
      '【与原作分叉的第一个事件】',
      '【保留的底层规则】',
      '【明确改动的事实】',
      '【主角身份与信息来源】',
      '【当前不可用的资源】',
      '【后续原作事件是否仍发生】',
      '【关系进度】',
    ]);
    expect(DIFF_NOTE_TITLE).toBe('本作差异说明');
  });

  it('不含特定作品的专名', () => {
    for (const name of ['喰种', 'CCG', '金木']) {
      expect(DIFF_NOTE_TEMPLATE).not.toContain(name);
    }
  });

  it('模板本身是一份合法的规范正文', () => {
    expect(
      validateNormDraft({ title: DIFF_NOTE_TITLE, content: DIFF_NOTE_TEMPLATE }),
    ).toBeUndefined();
  });
});
