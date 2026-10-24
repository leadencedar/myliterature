import { WritingNormSchema, type WritingNorm, type WritingNormScope } from './schema';

/**
 * 写作规范的领域函数：作用范围、排序、注入过滤、阈值与模板。
 *
 * 注入过滤与排序只在 normsInScope 一处实现：所有任务的 prompt 都经它取规范，
 * 「无规范时逐字节不变」与「同样的规范得到同样的 prompt」都只靠这一个入口保证。
 */

// ---------------------------------------------------------------- 作用范围

/** 界面上的顺序即存储顺序：同样的选择存成同样的数组，备份 diff 才稳定 */
export const NORM_SCOPES: { id: WritingNormScope; label: string; hint: string }[] = [
  { id: 'writing', label: '写正文', hint: '整章生成、段落续写 / 改写 / 扩写' },
  { id: 'planning', label: '规划', hint: '一句话立项、细化大纲' },
  { id: 'summary', label: '章节摘要', hint: '标记完成后的摘要与伏笔' },
  { id: 'extract', label: '提取设定', hint: '导入旧稿与世界观设定时的反向提取' },
  { id: 'check', label: '检查', hint: '章节编辑器里的「按规范检查」' },
  { id: 'interactive', label: '互动推演', hint: '推演每一步的情节与选项、收尾' },
];

export const ALL_NORM_SCOPES: WritingNormScope[] = NORM_SCOPES.map((scope) => scope.id);

/**
 * 加入互动推演之前（Dexie v6 / 备份 v3）的「全部作用范围」。冻结常量，不随 NORM_SCOPES 变化：
 * 它描述的是旧数据的含义，只给迁移与旧备份导入用
 */
export const ALL_NORM_SCOPES_V6: readonly WritingNormScope[] = Object.freeze([
  'writing',
  'planning',
  'summary',
  'extract',
  'check',
]);

/**
 * 老规范是否补上「互动推演」：恰好是五项全开（不论顺序）且没有 interactive 时返回六项（规范顺序），
 * 否则原样返回。五项全开是默认值，作者没碰过，含义就是「处处适用」；收窄过的是作者的选择，
 * 自动加新范围会违背它。v7 迁移与 v1–v3 备份导入共用这一个函数。全函数，不抛错
 */
export function addInteractiveScopeIfFull(scopes: readonly WritingNormScope[]): WritingNormScope[] {
  const picked = new Set<string>(scopes);
  const full =
    picked.size === ALL_NORM_SCOPES_V6.length &&
    ALL_NORM_SCOPES_V6.every((scope) => picked.has(scope));
  if (!full || picked.has('interactive')) return [...scopes];
  return [...ALL_NORM_SCOPES];
}

/**
 * 去重并按 ALL_NORM_SCOPES 的顺序排列；返回新数组，不改入参。
 * 绕过类型传进来的未知值去重后排在末尾而不是悄悄丢掉：仓储随后 parse 时由 schema 拒绝它，
 * 否则一个拼错的作用范围会被静默吞掉，作者以为勾上了实际没有。
 */
export function normalizeNormScopes(scopes: readonly WritingNormScope[]): WritingNormScope[] {
  const picked = new Set(scopes);
  const known = new Set<string>(ALL_NORM_SCOPES);
  return [
    ...ALL_NORM_SCOPES.filter((scope) => picked.has(scope)),
    ...[...picked].filter((scope) => !known.has(scope)),
  ];
}

// ---------------------------------------------------------------- 排序与过滤

/**
 * 排序键：order → createdAt → id。
 * id 兜底让它成为全序（合并导入后可能出现重复 order 与同一毫秒创建的行）；
 * 按码元比较而不用 localeCompare，避免结果依赖运行环境的区域设置 —— 顺序变了 prompt 就变了。
 */
export function compareNorms(a: WritingNorm, b: WritingNorm): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * 注入过滤的唯一入口：启用 && 作用范围含 scope && 正文非空 && 不在本次排除集合里。
 * 返回排好序的新数组。正文非空在 schema 里已有约束，这里再判一次是因为读取路径不 parse。
 */
export function normsInScope(
  norms: readonly WritingNorm[],
  scope: WritingNormScope,
  excludedIds?: ReadonlySet<string>,
): WritingNorm[] {
  return norms
    .filter(
      (norm) =>
        norm.enabled &&
        norm.scopes.includes(scope) &&
        norm.content.trim().length > 0 &&
        !excludedIds?.has(norm.id),
    )
    .sort(compareNorms);
}

// ---------------------------------------------------------------- 阈值

/** 单份规范超过时提示「较长，每次生成都会带上，可以试试 AI 精简」 */
export const NORM_TOKEN_WARN = 2000;
/** 「写正文」作用范围内启用规范的合计超过时，区块顶部提示 */
export const NORMS_TOTAL_TOKEN_WARN = 6000;
/** 正文里链接数超过时提示：来源表通常不必进提示词 */
export const NORM_LINK_WARN = 5;
/** 单份正文上限（与 schema 字面量同值）：约 48k tokens，只拦误传整本书 */
export const NORM_CONTENT_MAX = 60_000;
/** 标题上限（与 schema 字面量同值） */
export const NORM_TITLE_MAX = 60;

/** 正文里的链接数，用于「来源表」提示 */
export function countLinks(content: string): number {
  return content.match(/https?:\/\/\S+/gu)?.length ?? 0;
}

// ---------------------------------------------------------------- 标题与预检

/**
 * AI 精简另存时的标题。按 UTF-16 码元计长度，与 schema 的 z.string().max(60) 口径一致，
 * 保证拼上后缀后仍能通过校验，不会让另存在最后一步失败。
 */
export function condensedTitle(title: string): string {
  const suffix = '（精简）';
  return title.length + suffix.length <= NORM_TITLE_MAX
    ? title + suffix
    : title.slice(0, NORM_TITLE_MAX - suffix.length) + suffix;
}

const NormDraftSchema = WritingNormSchema.pick({ title: true, content: true });

/**
 * 保存前预检，返回第一条中文错误；合法时返回 undefined。
 * 直接复用 schema 的规则与文案：UI 预检与仓储兜底永远一致，
 * 也不会把 ZodError 的 JSON message 显示给作者。
 */
export function validateNormDraft(draft: { title: string; content: string }): string | undefined {
  const result = NormDraftSchema.safeParse(draft);
  return result.success ? undefined : result.error.issues[0]?.message;
}

// ---------------------------------------------------------------- 差异说明模板

export const DIFF_NOTE_TITLE = '本作差异说明';

/**
 * 同人 / 改编作品的差异说明骨架。只是提示结构的文字，作者可自由增删；
 * 不做成结构化字段，是因为本期没有任何代码按字段做判断（见设计 1.6）。
 * 刻意不含任何特定作品的专名。
 */
export const DIFF_NOTE_TEMPLATE = [
  '【原作版本】以哪个版本的原作为基线（漫画 / 动画 / 小说，或具体到某条路线）。',
  '【本作开场时期】故事从原作的哪个阶段开始。这一时期之后才出现的人物、组织、装备与信息一律冻结，角色不能提前使用或认识。',
  '【与原作分叉的第一个事件】从哪件事开始和原作不同；没有分叉就写「无，沿原作推进」。',
  '【保留的底层规则】本作不改动的世界规则。',
  '【明确改动的事实】逐条写出与原作不同的事实。每条都写明它影响哪些后续事件、人物和势力。',
  '【主角身份与信息来源】主角是谁、知道什么、从哪里知道。区分作者全知的事实、公开常识、阵营内部的秘密、角色亲历的信息。',
  '【当前不可用的资源】在本作当前时期还不存在或拿不到的能力、装备、组织与人脉。',
  '【后续原作事件是否仍发生】分叉之后原作里的大事件：照常发生 / 改变 / 取消，各自写明原因。',
  '【关系进度】主要人物之间目前处在什么阶段，哪些人尚未见面。',
  '',
  '改动必须带出后续因果：改了一件事，就要写清它会让哪些后续线随之改变。',
].join('\n');
