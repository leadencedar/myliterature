import { describe, expect, it } from 'vitest';
import { CHARACTER_FIELDS } from '@/domain/defaults';
import type { Category } from '@/domain/schema';
import {
  entryFieldSpecs,
  fieldSpecsFor,
  getFieldValue,
  setFieldValue,
  type FieldSpec,
} from './fields';

const TEXT: FieldSpec = { path: 'title', label: '名称', kind: 'text' };
const NESTED: FieldSpec = { path: 'fields.identity', label: '身份', kind: 'text' };
const LIST: FieldSpec = { path: 'aliases', label: '别名', kind: 'list' };
const NUMBER: FieldSpec = { path: 'targetWords', label: '目标字数', kind: 'number' };

describe('取值', () => {
  it('读取顶层与嵌套字段', () => {
    const payload = { title: '林越', fields: { identity: '流亡贵族' } };
    expect(getFieldValue(payload, TEXT)).toBe('林越');
    expect(getFieldValue(payload, NESTED)).toBe('流亡贵族');
  });

  it('数组字段按行拼接，并剔除空项', () => {
    expect(getFieldValue({ aliases: ['阿越', '  ', '越哥'] }, LIST)).toBe('阿越\n越哥');
  });

  it('缺失、null 与非对象输入都返回空串', () => {
    expect(getFieldValue({}, TEXT)).toBe('');
    expect(getFieldValue({ title: null }, TEXT)).toBe('');
    expect(getFieldValue({ fields: null }, NESTED)).toBe('');
    expect(getFieldValue(null, TEXT)).toBe('');
    expect(getFieldValue('字符串', TEXT)).toBe('');
  });

  it('数字转成字符串展示', () => {
    expect(getFieldValue({ targetWords: 3000 }, NUMBER)).toBe('3000');
  });
});

describe('写值', () => {
  it('不修改原对象', () => {
    const original = { title: '旧名' };
    const next = setFieldValue(original, TEXT, '新名');

    expect(original.title).toBe('旧名');
    expect(next).toEqual({ title: '新名' });
  });

  it('写入嵌套字段时保留同级其他字段', () => {
    const payload = { title: '林越', fields: { identity: '旧身份', voice: '低沉' } };
    const next = setFieldValue(payload, NESTED, '新身份') as typeof payload;

    expect(next.fields).toEqual({ identity: '新身份', voice: '低沉' });
    expect(next.title).toBe('林越');
  });

  it('父级字段不存在时自动创建', () => {
    expect(setFieldValue({}, NESTED, '身份')).toEqual({ fields: { identity: '身份' } });
  });

  it('列表字段按行拆分并去除空行与首尾空白', () => {
    const next = setFieldValue({}, LIST, ' 阿越 \n\n越哥\n') as { aliases: string[] };
    expect(next.aliases).toEqual(['阿越', '越哥']);
  });

  it('数字字段解析为整数，空值与非法输入变成 null', () => {
    expect(setFieldValue({}, NUMBER, '2500')).toEqual({ targetWords: 2500 });
    expect(setFieldValue({}, NUMBER, '2500.6')).toEqual({ targetWords: 2501 });
    expect(setFieldValue({}, NUMBER, '  ')).toEqual({ targetWords: null });
    expect(setFieldValue({}, NUMBER, '很多')).toEqual({ targetWords: null });
  });
});

describe('字段规格生成', () => {
  const category: Category = {
    id: 'c1',
    novelId: 'n1',
    name: '人物',
    kind: 'character',
    builtin: true,
    fieldTemplate: CHARACTER_FIELDS,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  };

  it('知识条目 = 固定字段 + 分类字段模板', () => {
    const specs = entryFieldSpecs(category);

    expect(specs.slice(0, 3).map((s) => s.path)).toEqual(['title', 'aliases', 'summary']);
    expect(specs.some((s) => s.path === 'fields.identity')).toBe(true);
    // 字段模板里的 hint 要带上，后续会进 prompt
    expect(specs.find((s) => s.path === 'fields.goal')?.hint).toBeTruthy();
  });

  it('分类缺失时只有固定字段，不抛错', () => {
    expect(entryFieldSpecs(undefined)).toHaveLength(3);
  });

  it('把分类字段的类型映射到编辑控件类型', () => {
    const specs = entryFieldSpecs({
      ...category,
      fieldTemplate: [
        { key: 'a', label: 'A', type: 'text', placeholder: '', hint: '' },
        { key: 'b', label: 'B', type: 'longtext', placeholder: '', hint: '' },
        { key: 'c', label: 'C', type: 'list', placeholder: '', hint: '' },
      ],
    });

    expect(specs.find((s) => s.path === 'fields.a')?.kind).toBe('text');
    expect(specs.find((s) => s.path === 'fields.b')?.kind).toBe('longtext');
    expect(specs.find((s) => s.path === 'fields.c')?.kind).toBe('list');
  });

  it('按目标类型取到对应规格', () => {
    expect(fieldSpecsFor('outlineNode').map((s) => s.path)).toEqual([
      'title',
      'synopsis',
      'targetWords',
    ]);
    expect(fieldSpecsFor('chapter').map((s) => s.path)).toEqual(['title', 'content']);
    expect(fieldSpecsFor('chapterSummary').some((s) => s.path === 'openThreads')).toBe(true);
    expect(fieldSpecsFor('knowledgeEntry', category).length).toBeGreaterThan(3);
  });

  it('外传只有一个字段：外传进展摘要', () => {
    expect(fieldSpecsFor('sideStory')).toEqual([
      { path: 'rollingSummary', label: '外传进展摘要', kind: 'longtext' },
    ]);
  });
  it('推演沉淀三栏：外传名称、外传简介、大纲内容', () => {
    const specs = fieldSpecsFor('scenarioOutline');
    expect(specs.map((s) => [s.path, s.label, s.kind])).toEqual([
      ['sideTitle', '外传名称', 'text'],
      ['sideSynopsis', '外传简介', 'longtext'],
      ['outlineText', '大纲内容', 'longtext'],
    ]);
    expect(specs[2]!.hint).toContain('对应步骤');
  });
});
