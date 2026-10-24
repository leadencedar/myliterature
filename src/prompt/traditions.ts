import type { Methodology, Tradition } from '@/domain/schema';

/**
 * 文体取向与创作方法论。
 *
 * 这两个维度的文字会直接进 prompt：`guidance` 管「怎么写」，
 * `outlineStructure` 管「大纲长什么样」。把它们集中在这里而不是散落在各处的
 * 提示词模板里，是为了保证立项、大纲扩写、正文生成三个环节说的是同一套话，
 * 不然模型会在不同环节收到互相矛盾的要求。
 */

export interface SubGenreDef {
  id: string;
  label: string;
  /** 该子类的特有约定，追加在文体取向之后 */
  convention: string;
}

export interface TraditionDef {
  id: Tradition;
  label: string;
  tagline: string;
  guidance: string;
  subGenres: SubGenreDef[];
}

export const TRADITIONS: Record<Tradition, TraditionDef> = {
  web: {
    id: 'web',
    label: '网络文学',
    tagline: '强代入、快节奏、每章有钩子',
    guidance: [
      '面向连载阅读：读者在手机上一章一章追，注意力是最稀缺的资源。',
      '遵守「黄金三章」惯例：开篇三章必须立住主角的处境、目标与第一个转机，不要用大段设定铺垫开场。',
      '每章结尾留钩子：悬念、反转或一个新的威胁，让读者想立刻看下一章。',
      '爽点要按节奏给：让主角在付出代价后获得明确的进展，避免长期憋闷。',
      '单章篇幅控制在 2000–3000 字，场景集中，避免一章内频繁切换视角。',
      '对话占比宜高，信息通过冲突与交锋传递，而不是靠叙述交代。',
    ].join('\n'),
    subGenres: [
      {
        id: '都市',
        label: '都市',
        convention:
          '现代都市背景，冲突来自职场、家庭、资本与人际关系，超凡元素若有须克制且有规则。',
      },
      {
        id: '玄幻',
        label: '玄幻',
        convention: '自创世界与力量体系，等级清晰可感知，升级带来的能力变化要具体可见。',
      },
      {
        id: '仙侠',
        label: '仙侠',
        convention: '修真体系与宗门格局，讲道法、机缘与心性，飞升与因果构成长线目标。',
      },
      {
        id: '科幻',
        label: '科幻',
        convention: '技术设定需自洽，一个核心设定贯穿全书，避免为解决困境随手发明新技术。',
      },
      {
        id: '悬疑',
        label: '悬疑',
        convention: '每章抛出新疑点并回收旧疑点，线索对读者公开，真相靠推理而非巧合。',
      },
      {
        id: '言情',
        label: '言情',
        convention: '情感推进有清晰的阶段，误会与和解都要有性格上的必然性，避免无理由的拉扯。',
      },
      {
        id: '历史',
        label: '历史',
        convention: '尊重基本史实框架与器物常识，虚构人物与真实背景要能对得上。',
      },
    ],
  },

  literary: {
    id: 'literary',
    label: '严肃文学',
    tagline: '主题先行，留白与内心',
    guidance: [
      '以主题与人的处境为核心，情节服务于意义的呈现，而不是相反。',
      '允许并鼓励留白：不解释人物动机，让行为与细节自己说话。',
      '允许非线性结构与视角的复杂安排，前提是服务于表达而非炫技。',
      '避免为推动情节而牺牲人物的真实性；人物可以不成长，也可以失败。',
      '结尾不必给出结论，可以停在一个悬置的瞬间。',
      '慎用巧合、反转与强戏剧性场面，情绪强度靠细节累积而非事件冲击。',
    ].join('\n'),
    subGenres: [],
  },

  genre: {
    id: 'genre',
    label: '类型文学',
    tagline: '遵守类型公约，在规则内出彩',
    guidance: [
      '类型小说的乐趣来自「守约而后出新」：先满足这一类型读者的基本期待，再谈突破。',
      '结构工整、因果严密，读者应能在结尾回看时确认一切都有铺垫。',
      '人物服务于类型的核心张力，配角也要有明确的功能与动机。',
      '文笔以清晰有效为先，不为修辞牺牲可读性。',
    ].join('\n'),
    subGenres: [
      {
        id: '推理',
        label: '推理',
        convention:
          '遵守线索公平原则：所有用于解谜的关键线索都必须在揭示前呈现给读者，不靠隐瞒信息制造意外。诡计需可验证，动机需可理解。',
      },
      {
        id: '科幻',
        label: '科幻',
        convention:
          '设定硬度优先：核心设定要有明确边界与代价，故事冲突应由设定本身生出，而非外挂的意外事件。',
      },
      {
        id: '武侠',
        label: '武侠',
        convention: '武学与江湖秩序自成体系，侠义抉择构成道德冲突，胜负要有人情与代价。',
      },
      {
        id: '恐怖',
        label: '恐怖',
        convention: '恐惧来自未知与失控感，节奏上先建立日常再破坏它，解释越少越好但规则要一致。',
      },
      {
        id: '历史',
        label: '历史',
        convention: '史实框架不可违背，虚构处要与时代的制度、器物、语言习惯相容。',
      },
    ],
  },
};

export interface MethodologyDef {
  id: Methodology;
  label: string;
  tagline: string;
  /** 大纲的组织方式，立项与大纲扩写据此产出结构 */
  outlineStructure: string;
}

export const METHODOLOGIES: Record<Methodology, MethodologyDef> = {
  'web-rhythm': {
    id: 'web-rhythm',
    label: '网文节奏结构',
    tagline: '黄金三章 + 单元副本 + 阶段爆点',
    outlineStructure: [
      '按「卷」划分，每卷是一个相对完整的单元（一个副本、一个对手、一个阶段目标）。',
      '第一卷开头三章为黄金三章：第 1 章立处境与危机，第 2 章给出主角的独特手段，第 3 章完成第一次小胜或第一个大钩子。',
      '每卷内部按 8–15 章规划，卷末安排一次阶段爆点（实力跃升、身份揭露或重大反转）。',
      '每卷要留至少一条通向下一卷的悬念线。',
    ].join('\n'),
  },
  'three-act': {
    id: 'three-act',
    label: '三幕式',
    tagline: '建置 · 对抗 · 解决',
    outlineStructure: [
      '分为三幕：第一幕建置（约 25%），第二幕对抗（约 50%），第三幕解决（约 25%）。',
      '第一幕末设置「不可回头点」，主角被迫踏入主线冲突。',
      '第二幕中点安排一次重大反转，把主角从被动转为主动（或相反）。',
      '第二幕末是最低谷，主角失去最重要的依靠。',
      '第三幕高潮解决核心冲突，并回应第一幕提出的问题。',
    ].join('\n'),
  },
  snowflake: {
    id: 'snowflake',
    label: '雪花法',
    tagline: '从一句话逐层细化',
    outlineStructure: [
      '自顶向下逐层展开：先一句话概括全书，再扩成一段，再扩成每幕的段落，最后细化到场景。',
      '本次只输出当前层级，保证同一层级的颗粒度一致，不要有的节点很细有的很粗。',
      '每个节点都应能独立成句地说明「谁想做什么、遇到什么阻碍、结果如何」。',
    ].join('\n'),
  },
  'hero-journey': {
    id: 'hero-journey',
    label: '英雄之旅',
    tagline: '启程 · 启蒙 · 回归',
    outlineStructure: [
      '按启程、启蒙、回归三大段组织，覆盖平凡世界、冒险召唤、拒绝召唤、导师、跨越门槛、试炼与盟友、接近核心、至暗时刻、奖赏、归途、复活、携宝而归等阶段。',
      '不必生搬每个阶段，但要保证「跨越门槛」「至暗时刻」「复活」三处有明确对应的章节。',
      '主角的内在转变要与外在旅程同步推进。',
    ].join('\n'),
  },
  qichengzhuanhe: {
    id: 'qichengzhuanhe',
    label: '起承转合 / 章回体',
    tagline: '中式叙事节奏',
    outlineStructure: [
      '按起、承、转、合四段组织全书，每段可包含若干回。',
      '每回自成段落、有头有尾，回末以悬念收束（「且听下回分解」的现代化处理）。',
      '回目标题宜工整，用对句或短语概括本回要事。',
      '「转」处安排全局性的局势翻转，「合」处收束所有主要线索。',
    ].join('\n'),
  },
};

/** 取某个文体取向下可选的子类 */
export function subGenresOf(tradition: Tradition): SubGenreDef[] {
  return TRADITIONS[tradition].subGenres;
}

export function findSubGenre(tradition: Tradition, id: string): SubGenreDef | undefined {
  return TRADITIONS[tradition].subGenres.find((item) => item.id === id);
}
