import type { Rubric } from '@/domain/schema';

/**
 * 内置名家风格库。
 *
 * 三点设计取舍需要讲清楚：
 *
 * 1. **存的是风格特征的结构化描述，不是作品原文**。每一条 rubric 都是对句式、
 *    意象、叙述距离等可观察特征的归纳，不含任何引文。这既避免把他人作品塞进
 *    prompt，也让生成更可控 —— 模型照着特征写，比照着片段模仿更稳定。
 * 2. **范围限定已故经典作家**。文学风格本身不受版权保护，但成品对外不宜宣称
 *    与某位作家的关联，界面上会提示这一点。
 * 3. **rubric 可读可编辑**。用户能看懂每一栏在说什么，也能直接改 ——
 *    风格是最主观的部分，把解释权留给用户比藏起来更好。
 */
export interface VoicePreset {
  id: string;
  name: string;
  /** 一行定位，供选择时快速判断 */
  tagline: string;
  /** 适合的文体取向，用于排序推荐 */
  affinity: ('web' | 'literary' | 'genre')[];
  rubric: Rubric;
}

export const VOICE_LIBRARY: VoicePreset[] = [
  {
    id: 'luxun',
    name: '鲁迅',
    tagline: '冷峻、克制、讽刺锋利',
    affinity: ['literary'],
    rubric: {
      sentenceRhythm:
        '短句为主，句读密集，常以转折词切断语流。段落简短，不作铺排，节奏像一记记落下的凿子。',
      imagery: '偏冷的具体物象：铁屋、灰墙、寒夜、荒冢。意象不作装饰，往往直接承担象征功能。',
      narrativeDistance:
        '叙述者冷眼旁观，与人物保持距离，偶尔以第一人称插入省思但不动声色。不替人物辩解，也不煽情。',
      dialogue: '对话短促，多用方言与口语的粗糙质感，人物常答非所问，言外之意大于字面。',
      rhetoric: '反讽是主干：越是残酷的场面越用平静的语调陈述。善用重复与对照，不用感叹。',
      lexicon: '文白夹杂，保留少量文言虚词与旧式称谓，整体用词朴素、硬、不甜。',
      avoid: '忌抒情长句、忌堆砌形容词、忌为人物的苦难作解释或安慰。',
    },
  },
  {
    id: 'zhangailing',
    name: '张爱玲',
    tagline: '华丽而清醒，世情入骨',
    affinity: ['literary'],
    rubric: {
      sentenceRhythm:
        '长短交错，长句层层修饰后忽然以一记短句收束。节奏绵密但不拖沓，转折常落在句末。',
      imagery:
        '大量日常物象与感官细节：月色、旗袍纹样、油腻的灯光、发霉的气味。以物写情，不直说心事。',
      narrativeDistance:
        '贴着人物写又时刻高出半头，叙述者洞悉人物的自欺并不加揭穿，克制中带着凉意。',
      dialogue: '对白世故、含机锋，人物说的话与想的事常常相反，客套里藏着算计。',
      rhetoric: '比喻精准且出人意料，常把抽象情绪比作具体的家常之物。善用色彩与气味的通感。',
      lexicon: '雅俗并置，既有文气的书面语，也有市井口语与时新的外来词。用词讲究质地与颜色。',
      avoid: '忌空泛的深情告白、忌把人物写成纯粹的善或恶、忌用力过猛的悲壮。',
    },
  },
  {
    id: 'laoshe',
    name: '老舍',
    tagline: '京味白话，幽默里有悲凉',
    affinity: ['literary'],
    rubric: {
      sentenceRhythm: '口语化的中等句长，读来上口，像说书人在讲。段落间常有轻快的过渡句。',
      imagery:
        '市井生活的具体场景：胡同、茶馆、洋车、四合院的天光。细节扎实，有生活的温度与尘土气。',
      narrativeDistance: '与人物同呼吸，语气亲切，时常以叙述者身份对读者插话点评，带笑意也带叹息。',
      dialogue: '北京口语的节奏与词汇，人物一开口就能听出身份。对话推动情节，也承担幽默。',
      rhetoric: '幽默是外衣，底下是同情。夸张与反差用得自然，不刻意求笑。',
      lexicon: '纯熟的白话，大量北京方言词与俗语，避免书卷气过重的词。',
      avoid: '忌欧化长句、忌居高临下地嘲笑小人物、忌为幽默牺牲人物的尊严。',
    },
  },
  {
    id: 'shencongwen',
    name: '沈从文',
    tagline: '清澈、素朴，自然与人一体',
    affinity: ['literary'],
    rubric: {
      sentenceRhythm: '舒缓平稳的中长句，少用复杂从句，语流如水。节奏不急，容许大段写景。',
      imagery: '山水、河流、渡船、吊脚楼、草木与天气。自然不是背景而是叙事的一部分。',
      narrativeDistance: '温厚的旁观者，对人物一视同仁，不评判善恶，苦难也用平静语气叙述。',
      dialogue: '朴素、简短，带湘西口语的质朴。人物话少，情意藏在动作与沉默里。',
      rhetoric: '几乎不用夸饰，比喻取自乡土经验。以白描取胜，力量来自节制。',
      lexicon: '干净的白话，名物具体（树名、船名、地名），少用抽象词与成语。',
      avoid: '忌华丽辞藻、忌激烈的戏剧冲突、忌都市气的机巧与议论。',
    },
  },
  {
    id: 'caoxueqin',
    name: '曹雪芹',
    tagline: '工笔世情，繁华中见虚无',
    affinity: ['literary', 'genre'],
    rubric: {
      sentenceRhythm: '文白相间的中长句，讲究对仗与声调。叙事、写景、对话交替推进，节奏从容。',
      imagery: '器物、衣饰、饮食、园林的精细描摹，节令与花木暗示人物命运。实写之中处处伏笔。',
      narrativeDistance:
        '全知而不点破，视角在人群中自然流转。对人物既怜惜又清醒，繁华场面下始终有一层虚无。',
      dialogue: '对白极有身份感，尊卑亲疏尽在称呼与语气里。机锋、玩笑、暗刺层层叠叠。',
      rhetoric: '善用诗词、谐音与双关埋线。以细节的呼应结构全篇，不靠直接议论。',
      lexicon: '雅致的旧白话，保留大量称谓、礼节与名物专名，语感文气而不僵。',
      avoid: '忌现代口语与外来词、忌直白点明主题、忌粗糙的情节跳跃。',
    },
  },
  {
    id: 'jinyong',
    name: '金庸',
    tagline: '格局开阔，侠义与历史交织',
    affinity: ['genre', 'web'],
    rubric: {
      sentenceRhythm: '中等句长、节奏稳健，叙事与武打交替。打斗段落句子变短，招式清楚，可读性强。',
      imagery: '山川关隘、门派器物、招式名目。以地理与历史坐标撑起世界感。',
      narrativeDistance: '全知视角，说书人的口吻，常插入背景解说与人物评点，把读者领进江湖。',
      dialogue: '半文半白，人物身份决定语气。义气之言与机辩兼有，关键转折常由对话完成。',
      rhetoric: '铺垫扎实，讲因果与人情。武功、性格、命运三者互为隐喻。',
      lexicon: '通俗而有古意的白话，武学与江湖术语自成体系，忌现代词汇。',
      avoid: '忌现代心理分析式独白、忌无来由的力量升级、忌破坏历史与地理的可信度。',
    },
  },
  {
    id: 'gulong',
    name: '古龙',
    tagline: '极短句，孤绝气与格言感',
    affinity: ['genre', 'web'],
    rubric: {
      sentenceRhythm:
        '极短句，一句一段是常态。大量留白与换行，节奏顿挫、逼人。写打斗常只写结果不写过程。',
      imagery: '酒、刀、长街、雨夜、荒漠。意象少而反复出现，形成符号感。',
      narrativeDistance: '贴近人物的孤独感，叙述者常以警句插入对人生的判断，语气笃定。',
      dialogue: '对白是主战场：短、快、带锋刃，常以反问与沉默施压。人物靠一句话立住。',
      rhetoric: '格言式断语、排比、悬念前置。高手之间胜负往往在气势而非招式。',
      lexicon: '现代白话为底，词汇精简，反复使用少数几个有力的字（如「快」「冷」「杀」）。',
      avoid: '忌繁复长句、忌详细的招式拆解、忌拖沓的背景交代。',
    },
  },
  {
    id: 'hemingwei',
    name: '海明威',
    tagline: '冰山之下，动作与对话说话',
    affinity: ['literary', 'genre'],
    rubric: {
      sentenceRhythm: '短句与并列句为主，少用从句与修饰。节奏平直、克制，靠动词推进。',
      imagery: '可触可见的事物：河水、渔线、酒杯、日光。只写看得见的，不写看不见的。',
      narrativeDistance: '摄影机式的外部视角，不进入人物内心，情绪由动作与停顿透露。',
      dialogue: '对白占比高，口语、重复、答非所问。重要的事往往不说出口。',
      rhetoric: '几乎不用比喻与形容词，删掉一切可删之物，力量来自省略。',
      lexicon: '简单具体的词，避免抽象名词与情绪词（如「痛苦」「绝望」）。',
      avoid: '忌心理剖析、忌解释人物动机、忌华丽修辞与总结性议论。',
    },
  },
  {
    id: 'qihefu',
    name: '契诃夫',
    tagline: '平淡日常里的微小溃败',
    affinity: ['literary'],
    rubric: {
      sentenceRhythm: '平稳的中等句长，语气不起波澜。场景切换干净，篇幅紧凑。',
      imagery: '日常细物承担情绪：一件旧外套、窗外的雪、桌上的茶。细节少而准。',
      narrativeDistance: '不评判的旁观，对人物的可笑与可悯同等对待。结尾常不给结论。',
      dialogue: '琐碎、答非所问、互相错过。人物谈论天气，真正的痛苦在话缝里。',
      rhetoric: '拒绝戏剧化。冲突被压在日常之下，高潮往往是一个安静的瞬间。',
      lexicon: '朴素中性的词汇，避免夸张与判断性形容。',
      avoid: '忌强烈的道德判断、忌戏剧性的巧合与反转、忌煽情结尾。',
    },
  },
  {
    id: 'kafuka',
    name: '卡夫卡',
    tagline: '荒诞前提，冷静到底',
    affinity: ['literary'],
    rubric: {
      sentenceRhythm: '绵长的复合句，层层限定与修正，像公文也像辩解。段落长，少分行。',
      imagery: '门、走廊、办公室、无尽的层级与手续。空间常是封闭且逻辑自洽的。',
      narrativeDistance: '紧贴主角的有限视角，读者与主角一样不明所以。荒诞前提被当作理所当然。',
      dialogue: '人物彬彬有礼地讲不通道理，解释越多越糊涂。对白推进的是困境而非信息。',
      rhetoric: '以极端认真的逻辑推演荒谬，绝不点明寓意。不用惊叹，不作解释。',
      lexicon: '精确、略带官僚气的书面语，抽象名词与法律、行政词汇混入日常。',
      avoid: '忌为荒诞提供解释、忌情绪外露、忌明确的象征说明。',
    },
  },
  {
    id: 'maerkesi',
    name: '马尔克斯',
    tagline: '奇迹与日常同处一室',
    affinity: ['literary', 'genre'],
    rubric: {
      sentenceRhythm: '长句奔涌，一句之内跨越数年，从句层叠而不断裂。段落长，气息绵长。',
      imagery: '炎热、雨季、蝴蝶、铁轨、腐烂的甜香。感官饱和，颜色与气味浓烈。',
      narrativeDistance: '家族史式的全知叙述，时间自由前后跳跃，常在开头就预告结局。',
      dialogue: '对白不多，人物以断言式的短句说出惊人之语，语气如陈述事实。',
      rhetoric: '把超自然事件与日常琐事用同一种平静语气并列，这是风格的核心。善用夸张的确切数字。',
      lexicon: '华丽而具体，名物、地名、家族称谓密集，避免抽象说理。',
      avoid: '忌对奇迹表示惊讶或加以解释、忌短平快的现代节奏、忌心理分析。',
    },
  },
];

export function findVoice(id: string): VoicePreset | undefined {
  return VOICE_LIBRARY.find((voice) => voice.id === id);
}

/** rubric 的展示顺序与标签，界面与 prompt 共用以保证一致 */
export const RUBRIC_DIMENSIONS: { key: keyof Rubric; label: string }[] = [
  { key: 'sentenceRhythm', label: '句式节奏' },
  { key: 'imagery', label: '意象偏好' },
  { key: 'narrativeDistance', label: '叙述距离' },
  { key: 'dialogue', label: '对话风格' },
  { key: 'rhetoric', label: '修辞习惯' },
  { key: 'lexicon', label: '词汇色彩' },
  { key: 'avoid', label: '需要避免' },
];
