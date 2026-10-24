import { describe, expect, it } from 'vitest';
import { CHARACTER_FIELDS, WORLDBUILDING_FIELDS } from '@/domain/defaults';
import {
  CategorySchema,
  NovelSchema,
  StyleProfileSchema,
  WritingNormSchema,
  type Category,
  type Novel,
  type StyleProfile,
  type WritingNorm,
} from '@/domain/schema';
import { composeStylePrefix } from '@/prompt/sections';
import {
  SCALES,
  buildSetupSchema,
  buildSetupSystemPrompt,
  buildSetupUserPrompt,
  findScale,
  toOutlineDrafts,
} from './projectSetup';

const novel: Novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  oneLiner: '失忆剑客发现自己是灭门案凶手。',
  createdAt: 0,
  updatedAt: 0,
});

const style: StyleProfile = StyleProfileSchema.parse({
  id: 's1',
  novelId: 'n1',
  tradition: 'web',
  subGenre: '仙侠',
  methodology: 'web-rhythm',
  createdAt: 0,
  updatedAt: 0,
});

function category(
  name: string,
  kind: Category['kind'],
  fields: Category['fieldTemplate'],
): Category {
  return CategorySchema.parse({
    id: `c-${kind}`,
    novelId: 'n1',
    name,
    kind,
    builtin: true,
    fieldTemplate: fields,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  });
}

const worldCategory = category('世界观设定', 'worldbuilding', WORLDBUILDING_FIELDS);
const characterCategory = category('人物', 'character', CHARACTER_FIELDS);

describe('篇幅规模', () => {
  it('三档规模都有大纲结构要求', () => {
    expect(SCALES.map((scale) => scale.id)).toEqual(['short', 'medium', 'long']);
    for (const scale of SCALES) {
      expect(scale.outlineRequirement.length).toBeGreaterThan(10);
    }
  });

  it('长篇只要求展开前两卷，避免过早细化', () => {
    const long = findScale('long');
    expect(long.outlineRequirement).toContain('前两卷');
    expect(long.outlineRequirement).toContain('随剧情生长');
  });

  it('未知 id 回退到中篇', () => {
    expect(findScale('nope').id).toBe('medium');
  });
});

describe('输出 schema', () => {
  const schema = buildSetupSchema(WORLDBUILDING_FIELDS, CHARACTER_FIELDS);

  function validResult() {
    return {
      worldbuilding: [
        {
          title: '归墟',
          aliases: [],
          summary: '吞噬记忆的深渊',
          core: true,
          fields: Object.fromEntries(WORLDBUILDING_FIELDS.map((f) => [f.key, '内容'])),
        },
        {
          title: '剑冢',
          aliases: ['万剑坑'],
          summary: '埋剑之地',
          core: false,
          fields: Object.fromEntries(WORLDBUILDING_FIELDS.map((f) => [f.key, '内容'])),
        },
      ],
      characters: [
        {
          title: '林越',
          aliases: ['阿越'],
          summary: '失忆剑客',
          core: false,
          fields: Object.fromEntries(CHARACTER_FIELDS.map((f) => [f.key, '内容'])),
        },
        {
          title: '沈清',
          aliases: [],
          summary: '追查真相的女捕',
          core: false,
          fields: Object.fromEntries(CHARACTER_FIELDS.map((f) => [f.key, '内容'])),
        },
      ],
      outline: [
        { title: '第一卷', synopsis: '起', targetWords: 30_000, children: [] },
        { title: '第二卷', synopsis: '承', targetWords: 30_000, children: [] },
        { title: '第三卷', synopsis: '转', targetWords: 30_000, children: [] },
      ],
    };
  }

  it('完整结果通过校验', () => {
    expect(schema.safeParse(validResult()).success).toBe(true);
  });

  it('字段 schema 由分类的字段模板动态生成', () => {
    const custom = buildSetupSchema(
      [{ key: 'onlyOne', label: '唯一栏', type: 'text', placeholder: '', hint: '' }],
      CHARACTER_FIELDS,
    );
    const result = validResult();
    // 世界观条目的 fields 现在只应有 onlyOne
    result.worldbuilding = result.worldbuilding.map((entry) => ({
      ...entry,
      fields: { onlyOne: '内容' },
    }));

    expect(custom.safeParse(result).success).toBe(true);
    // 用原来的字段集反而不通过，证明 schema 真的跟着模板走
    expect(custom.safeParse(validResult()).success).toBe(false);
  });

  it('缺字段时不通过，会触发修复重试', () => {
    const result = validResult();
    result.worldbuilding[0]!.fields = { definition: '只有一栏' };
    expect(schema.safeParse(result).success).toBe(false);
  });

  it('数量下限：世界观与人物各至少 2 条，大纲至少 3 个节点', () => {
    const tooFew = validResult();
    tooFew.worldbuilding = [tooFew.worldbuilding[0]!];
    expect(schema.safeParse(tooFew).success).toBe(false);

    const shortOutline = validResult();
    shortOutline.outline = shortOutline.outline.slice(0, 2);
    expect(schema.safeParse(shortOutline).success).toBe(false);
  });

  it('两层大纲的子节点被接受', () => {
    const result = validResult();
    result.outline[0]!.children = [
      { title: '第1章', synopsis: '开场', targetWords: 3000 },
    ] as never;
    expect(schema.safeParse(result).success).toBe(true);
  });
});

describe('大纲结果转树', () => {
  it('保留两层结构与字数', () => {
    const tree = toOutlineDrafts([
      {
        title: '第一卷',
        synopsis: '起',
        targetWords: 30_000,
        children: [{ title: '第1章', synopsis: '开场', targetWords: 3000 }],
      },
    ]);

    expect(tree[0]?.children[0]).toEqual({
      title: '第1章',
      synopsis: '开场',
      targetWords: 3000,
      children: [],
    });
  });

  it('children 缺失时按空数组处理', () => {
    const tree = toOutlineDrafts([{ title: '第一卷', synopsis: '', targetWords: null } as never]);
    expect(tree[0]?.children).toEqual([]);
  });
});

describe('系统提示', () => {
  const prompt = buildSetupSystemPrompt(novel, style, worldCategory, characterCategory);

  it('包含稳定前缀的四个段落', () => {
    expect(prompt).toContain('【作品信息】');
    expect(prompt).toContain('【文体取向】');
    expect(prompt).toContain('【结构方法】');
    // 未设定文风时【文风】段为空，不应出现空标题
    expect(prompt).not.toContain('【文风】');
  });

  it('带上分类名与每个字段的写作指引', () => {
    expect(prompt).toContain('分类「世界观设定」');
    expect(prompt).toContain('分类「人物」');
    for (const field of WORLDBUILDING_FIELDS) {
      expect(prompt).toContain(`${field.key}（${field.label}）`);
    }
    expect(prompt).toContain(WORLDBUILDING_FIELDS[0]!.hint);
  });

  it('要求设定与人物互相咬合，而不是各写一堆', () => {
    expect(prompt).toContain('彼此咬合');
    expect(prompt).toContain('不要另起一个故事');
  });

  it('说明 core 标记的判定标准', () => {
    expect(prompt).toContain('core');
    expect(prompt).toContain('通常 1–2 条');
  });

  it('两次调用逐字节相同（prompt 缓存前提）', () => {
    expect(buildSetupSystemPrompt(novel, style, worldCategory, characterCategory)).toBe(prompt);
  });
});

describe('用户提示', () => {
  it('带上故事内核、篇幅与大纲要求', () => {
    const prompt = buildSetupUserPrompt({
      oneLiner: '失忆剑客的复仇。',
      scale: findScale('medium'),
    });

    expect(prompt).toContain('失忆剑客的复仇。');
    expect(prompt).toContain('中篇');
    expect(prompt).toContain('分 3–5 个卷');
  });

  it('额外要求存在时才出现该段', () => {
    const withExtra = buildSetupUserPrompt({
      oneLiner: 'x',
      scale: findScale('short'),
      extra: '女主视角',
    });
    expect(withExtra).toContain('【用户额外要求】');
    expect(withExtra).toContain('女主视角');

    const withoutExtra = buildSetupUserPrompt({ oneLiner: 'x', scale: findScale('short') });
    expect(withoutExtra).not.toContain('【用户额外要求】');
  });

  it('空白的额外要求不产生空段', () => {
    const prompt = buildSetupUserPrompt({
      oneLiner: 'x',
      scale: findScale('short'),
      extra: '   ',
    });
    expect(prompt).not.toContain('【用户额外要求】');
  });
});

describe('写作规范', () => {
  function norm(overrides: Partial<WritingNorm> = {}): WritingNorm {
    return WritingNormSchema.parse({
      id: 'norm-1',
      novelId: 'n1',
      title: '使用提示',
      content: '- 新增能力须写明来源与代价。【标记 P】',
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    });
  }

  it('作用范围含规划时带上，位于稳定前缀之后、任务说明之前', () => {
    const prompt = buildSetupSystemPrompt(novel, style, worldCategory, characterCategory, [norm()]);
    const prefix = composeStylePrefix(novel, style);
    const at = prompt.indexOf('【作者的写作规范】');

    expect(prompt).toContain('【标记 P】');
    expect(at).toBeGreaterThan(prompt.indexOf(prefix) + prefix.length - 1);
    expect(at).toBeLessThan(prompt.indexOf('【任务】'));
  });

  it('作用范围不含规划或已停用时不带，与不传完全相同', () => {
    const base = buildSetupSystemPrompt(novel, style, worldCategory, characterCategory);
    expect(
      buildSetupSystemPrompt(novel, style, worldCategory, characterCategory, [
        norm({ scopes: ['writing'] }),
      ]),
    ).toBe(base);
    expect(
      buildSetupSystemPrompt(novel, style, worldCategory, characterCategory, [
        norm({ enabled: false }),
      ]),
    ).toBe(base);
  });
});
