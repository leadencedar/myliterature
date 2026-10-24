/**
 * 内置分类的字段模板。
 *
 * 字段的 hint 会进 prompt，直接决定 AI 生成的质量与结构，
 * 所以这里不是随手写的占位文案，而是「告诉模型这一栏该写什么」的指令。
 *
 * mutability 是互动推演里世界线能否改写这一栏：规则、代价、性格、说话方式这类「世界的物理」
 * 与「同一个人的辨识」锁定；身份、关系、局势这类会随剧情变化的可变。只有 key / label / hint
 * 进 prompt，mutability 不进任何现有提示词。
 */
import type { FieldDef, FieldMutability } from './schema';

export const WORLDBUILDING_FIELDS: FieldDef[] = [
  {
    key: 'definition',
    label: '定义',
    type: 'longtext',
    placeholder: '这条设定是什么',
    hint: '用两三句话说清这条设定是什么，避免空泛的形容词。',
    mutability: 'locked',
  },
  {
    key: 'rules',
    label: '运作规则',
    type: 'longtext',
    placeholder: '它如何运作，有哪些明确规则',
    hint: '给出可验证的具体规则，让后续情节有依据、不自相矛盾。',
    mutability: 'locked',
  },
  {
    key: 'cost',
    label: '限制与代价',
    type: 'longtext',
    placeholder: '使用它要付出什么',
    hint: '限制比能力更重要：没有代价的设定会让冲突失重。',
    mutability: 'locked',
  },
  {
    key: 'impact',
    label: '对剧情的影响',
    type: 'longtext',
    placeholder: '它会催生什么冲突',
    hint: '说明这条设定能生出哪些矛盾或转折，而不只是背景装饰。',
    mutability: 'mutable',
  },
];

export const CHARACTER_FIELDS: FieldDef[] = [
  {
    key: 'identity',
    label: '身份',
    type: 'text',
    placeholder: '年龄、出身、社会位置',
    hint: '一行写清年龄、出身与当前处境。',
    mutability: 'mutable',
  },
  {
    key: 'appearance',
    label: '外貌',
    type: 'longtext',
    placeholder: '有辨识度的外形特征',
    hint: '挑一两个有辨识度的特征，避免罗列五官。',
    mutability: 'mutable',
  },
  {
    key: 'personality',
    label: '性格',
    type: 'longtext',
    placeholder: '性格与行为习惯',
    hint: '用行为倾向描述性格，而不是贴形容词标签。',
    mutability: 'locked',
  },
  {
    key: 'goal',
    label: '目标与动机',
    type: 'longtext',
    placeholder: '他想要什么，为什么',
    hint: '写出可推动情节的具体目标，以及背后的动机来源。',
    mutability: 'mutable',
  },
  {
    key: 'flaw',
    label: '软肋与恐惧',
    type: 'longtext',
    placeholder: '他怕什么，弱点在哪',
    hint: '软肋决定人物会在哪里犯错，是制造转折的支点。',
    mutability: 'locked',
  },
  {
    key: 'relations',
    label: '关系网',
    type: 'longtext',
    placeholder: '与其他人物的关系',
    hint: '列出关键关系及其张力，注明对方姓名以便交叉引用。',
    mutability: 'mutable',
  },
  {
    key: 'voice',
    label: '说话方式',
    type: 'longtext',
    placeholder: '口头习惯、语气、用词偏好',
    hint: '写清口吻特征，让对话可辨认出是谁在说话。',
    mutability: 'locked',
  },
  {
    key: 'arc',
    label: '成长弧线',
    type: 'longtext',
    placeholder: '他会如何改变',
    hint: '从初始状态到结局状态的转变方向，可留待剧情推进后补充。',
    mutability: 'mutable',
  },
];

export interface BuiltinCategorySeed {
  name: string;
  kind: 'worldbuilding' | 'character';
  fieldTemplate: FieldDef[];
}

/** 新建小说时自动创建的内置分类 */
export const BUILTIN_CATEGORIES: BuiltinCategorySeed[] = [
  { name: '世界观设定', kind: 'worldbuilding', fieldTemplate: WORLDBUILDING_FIELDS },
  { name: '人物', kind: 'character', fieldTemplate: CHARACTER_FIELDS },
];

/** 供用户一键添加的常用自定义分类模板 */
export const SUGGESTED_CATEGORIES: { name: string; fieldTemplate: FieldDef[] }[] = [
  {
    name: '势力',
    fieldTemplate: [
      {
        key: 'definition',
        label: '简介',
        type: 'longtext',
        placeholder: '',
        hint: '这个势力是什么，规模与性质。',
        mutability: 'locked',
      },
      {
        key: 'goal',
        label: '诉求',
        type: 'longtext',
        placeholder: '',
        hint: '它想达成什么，与主角的关系是敌是友。',
        mutability: 'mutable',
      },
      {
        key: 'power',
        label: '实力与手段',
        type: 'longtext',
        placeholder: '',
        hint: '掌握的资源与惯用手段。',
        mutability: 'mutable',
      },
      {
        key: 'weakness',
        label: '弱点',
        type: 'longtext',
        placeholder: '',
        hint: '可被利用的破口。',
        mutability: 'mutable',
      },
    ],
  },
  {
    name: '地点',
    fieldTemplate: [
      {
        key: 'definition',
        label: '简介',
        type: 'longtext',
        placeholder: '',
        hint: '这是什么地方，在世界中的位置。',
        mutability: 'locked',
      },
      {
        key: 'atmosphere',
        label: '氛围',
        type: 'longtext',
        placeholder: '',
        hint: '感官细节：光线、声音、气味。',
        mutability: 'mutable',
      },
      {
        key: 'function',
        label: '叙事作用',
        type: 'longtext',
        placeholder: '',
        hint: '哪些情节会在这里发生。',
        mutability: 'mutable',
      },
    ],
  },
  {
    name: '道具',
    fieldTemplate: [
      {
        key: 'definition',
        label: '简介',
        type: 'longtext',
        placeholder: '',
        hint: '它是什么，从哪来。',
        mutability: 'locked',
      },
      {
        key: 'rules',
        label: '能力与规则',
        type: 'longtext',
        placeholder: '',
        hint: '能做什么，明确边界。',
        mutability: 'locked',
      },
      {
        key: 'cost',
        label: '代价',
        type: 'longtext',
        placeholder: '',
        hint: '使用的限制与副作用。',
        mutability: 'locked',
      },
    ],
  },
  {
    name: '伏笔',
    fieldTemplate: [
      {
        key: 'definition',
        label: '埋设内容',
        type: 'longtext',
        placeholder: '',
        hint: '埋了什么，在第几章埋的。',
        mutability: 'locked',
      },
      {
        key: 'payoff',
        label: '预期收束',
        type: 'longtext',
        placeholder: '',
        hint: '打算怎么回收，大致在什么位置。',
        mutability: 'mutable',
      },
      {
        key: 'status',
        label: '状态',
        type: 'text',
        placeholder: '未收束 / 已收束',
        hint: '当前是否已经回收。',
        mutability: 'mutable',
      },
    ],
  },
  {
    name: '时间线',
    fieldTemplate: [
      {
        key: 'when',
        label: '时间',
        type: 'text',
        placeholder: '',
        hint: '事件发生的时间点或时期。',
        mutability: 'locked',
      },
      {
        key: 'what',
        label: '事件',
        type: 'longtext',
        placeholder: '',
        hint: '发生了什么，涉及哪些人物。',
        mutability: 'locked',
      },
      {
        key: 'impact',
        label: '后果',
        type: 'longtext',
        placeholder: '',
        hint: '对当下剧情的影响。',
        mutability: 'mutable',
      },
    ],
  },
];

/**
 * 内置默认可变性：旧分类没有存 mutability 时的第三级解析（条目 → 模板 → 这里 → 可变）。
 *
 * - worldbuilding / character：查 BUILTIN_CATEGORIES 里同 kind 的模板，键在模板里就取它的值；
 * - custom：**只有**分类名与某个建议分类完全相同、且键在那个模板里时才取值，否则 undefined。
 *   建议分类落库后都是 custom，只按 kind + 键查会找不到它们，或者把作者自建分类里恰好叫
 *   rules / definition 的键误判为锁定。名称 + 键双重匹配只在「这就是一键添加的那个分类」时生效；
 *   作者把「道具」改了名，就回到「不知道语义 → 可变」。
 */
export function builtinMutability(
  category: { kind: 'worldbuilding' | 'character' | 'custom'; name: string },
  key: string,
): FieldMutability | undefined {
  const template =
    category.kind === 'custom'
      ? SUGGESTED_CATEGORIES.find((item) => item.name === category.name)?.fieldTemplate
      : BUILTIN_CATEGORIES.find((item) => item.kind === category.kind)?.fieldTemplate;
  return template?.find((field) => field.key === key)?.mutability;
}
