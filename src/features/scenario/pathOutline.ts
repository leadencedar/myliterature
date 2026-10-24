import { z } from 'zod';
import { normalizeEntryName } from '@/domain/entrySearch';
import type { ScenarioOutlinePlan } from '@/domain/scenario';
import type {
  KnowledgeEntry,
  Novel,
  Scenario,
  ScenarioNode,
  StyleProfile,
  WritingNorm,
} from '@/domain/schema';
import { composeSections, composeStylePrefix, writingNormsSection } from '@/prompt/sections';
import { parseOutlineTree, type OutlineDraft } from '@/proposal/outlineText';
import { promptStepHeading } from './scenarioPrompt';

/**
 * 推演路径 → 大纲（设计 D7.1 / D7.2 / §7.2）。
 *
 * 由模型分组、代码校验、作者在提案里改：模型把一段连续步骤分成卷 / 章，代码校验各章的「对应步骤」
 * 首尾相接地恰好覆盖这次沉淀的范围；结果序列化成一段可编辑的缩进标题文本（与 outlineTree 同一思路），
 * 采用时再解析回来交给仓储。步数一律是路径上的绝对步数（depth + 1），与推演页「第 k 步」同一编号。
 */

// ---------------------------------------------------------------- 步骤覆盖校验

/** 「第 13–24 步」；首尾相同时「第 13 步」 */
function rangeLabel(from: number, to: number): string {
  return from === to ? `第 ${from} 步` : `第 ${from}–${to} 步`;
}

/**
 * 各章的步骤范围是否从 from 起首尾相接、恰好覆盖 [from, to]、不重叠。返回第一处问题（index 是章的序号，
 * 从 0 起）；合法时返回 null。schema 的 superRefine 与采用时的解析共用它，两处文案一致
 */
function checkStepCoverage(
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number,
): { index: number; message: string } | null {
  const scope = `这次沉淀的范围是${rangeLabel(from, to)}`;
  if (ranges.length === 0) return { index: 0, message: `至少要有一章（${scope}）` };
  let expected = from;
  for (const [index, range] of ranges.entries()) {
    const n = index + 1;
    if (range.from > range.to) {
      return {
        index,
        message: `第 ${n} 章的『对应步骤』写反了（${rangeLabel(range.to, range.from)}），${scope}`,
      };
    }
    if (range.from < from || range.to > to) {
      return {
        index,
        message: `第 ${n} 章的『对应步骤』超出这次沉淀的范围（${rangeLabel(from, to)}）`,
      };
    }
    if (range.from !== expected) {
      return {
        index,
        message:
          index === 0
            ? `第 1 章的『对应步骤』要从第 ${from} 步开始（${scope}）`
            : `第 ${n} 章的『对应步骤』要从第 ${expected} 步接着写：各章首尾相接、不重叠（${scope}）`,
      };
    }
    expected = range.to + 1;
  }
  if (expected !== to + 1) {
    return {
      index: ranges.length - 1,
      message: `最后一章的『对应步骤』要写到第 ${to} 步（${scope}）`,
    };
  }
  return null;
}

// ---------------------------------------------------------------- 模型输出

const PathChapterSchema = z.object({
  title: z.string().trim().min(1, '章标题不能为空').max(200),
  synopsis: z.string().trim().min(1, '章梗概不能为空').max(1000),
  keyEvents: z.array(z.string().trim().min(1).max(200)).max(8),
  appearing: z.array(z.string().trim().min(1).max(60)).max(12),
  fromStep: z.number().int(),
  toStep: z.number().int(),
  targetWords: z.number().int().positive().nullable(),
});

const PathVolumeSchema = z.object({
  title: z.string().trim().min(1, '卷标题不能为空').max(200),
  synopsis: z.string().trim().max(1000),
  targetWords: z.number().int().positive().nullable(),
  chapters: z.array(PathChapterSchema).min(1, '每卷至少一章'),
});

/**
 * 按这次的范围动态构造 schema：superRefine 要求各章的 fromStep–toStep 从 from 起首尾相接、恰好覆盖
 * [from, to]、不重叠，不满足进修复重试（错误文案回灌给模型）。from / to 是绝对步数
 */
export function buildPathOutlineSchema(from: number, to: number) {
  return z
    .object({
      /** 外传名称：只在沉淀为新外传时有用，其余情形填空串 */
      sideTitle: z.string().trim().max(40, '外传名称不能超过 40 字'),
      sideSynopsis: z.string().trim().max(2000, '外传简介不能超过 2000 字'),
      volumes: z.array(PathVolumeSchema).min(1, '至少要有一卷'),
    })
    .superRefine((value, ctx) => {
      const positions: { volume: number; chapter: number }[] = [];
      const ranges: { from: number; to: number }[] = [];
      value.volumes.forEach((volume, v) =>
        volume.chapters.forEach((chapter, c) => {
          positions.push({ volume: v, chapter: c });
          ranges.push({ from: chapter.fromStep, to: chapter.toStep });
        }),
      );
      const problem = checkStepCoverage(ranges, from, to);
      if (!problem) return;
      const at = positions[problem.index];
      ctx.addIssue({
        code: 'custom',
        path: at ? ['volumes', at.volume, 'chapters', at.chapter, 'fromStep'] : ['volumes'],
        message: problem.message,
      });
    });
}

export type PathOutline = z.infer<ReturnType<typeof buildPathOutlineSchema>>;

// ---------------------------------------------------------------- 提示词

const PATH_OUTLINE_OPENER =
  '你是一位资深的小说策划编辑。作者用互动推演玩出了一段故事，你要把这段经过整理成可以直接开写的小说大纲。';

const PATH_OUTLINE_TASK = [
  '【任务】',
  '把下面这段互动推演的经过整理成卷 / 章两层的大纲：每章写梗概、关键事件、出场人物，并注明对应推演的第几步到第几步。',
  '',
  '要求：',
  '- 只整理给出的这几步：不要补写没有发生的情节，也不要改动已经发生的事。',
  '- 每章覆盖连续的若干步（建议 3–6 步，约 3000 字一章），按场景与节奏切分，不要机械地按步数平均分。',
  '- fromStep / toStep 用经过里标注的「第 k 步」编号：从这次范围的第一步起首尾相接，恰好覆盖到最后一步，不重叠、不遗漏。',
  '- 每卷对应一个里程碑段或约 10 章。卷标题与章标题带序号（如「第一卷 渡口」「第1章 雾里的船」），接着本书已有的卷往下编。',
  '- 梗概写清这一章谁想做什么、遇到什么阻碍、结果如何；keyEvents 列这一章的关键事件；appearing 列出场人物，用经过里出现的正式名称。',
  '- targetWords 给出预估字数；无法判断时填 null。',
  '- 沉淀为新外传时，sideTitle 写外传名称（不超过 40 字，不带「外传」二字），sideSynopsis 写外传简介（讲什么、从哪里与主线分开）；其余情形两者都填空串。',
].join('\n');

export interface PathOutlinePromptInput {
  novel: Novel;
  style: StyleProfile;
  norms: readonly WritingNorm[];
  scenario: Pick<Scenario, 'title'>;
  castName: string;
  mode: 'main' | 'side';
  /** 追加到已有外传时为那部外传；其余为 null */
  appendTo: { title: string } | null;
  /** 这次沉淀的步骤，按路径顺序 */
  steps: readonly ScenarioNode[];
  /** 本书已有的顶层卷名，便于续接卷名编号（只有主线模式用得上） */
  existingVolumeTitles: readonly string[];
  /** 外传模式的分叉前情（forkPreludeText）；主线模式传空串 */
  prelude: string;
}

/**
 * system = 开场白 + 作品与文风 + 规范（作用范围「规划」：产出的是本书大纲，与细化大纲一致）+ 任务说明；
 * user = 这次沉淀的说明 + 已有顶层卷名 + 外传的分叉前情 + 范围内各步的行动与情节原文
 */
export function buildPathOutlinePrompt(input: PathOutlinePromptInput): {
  system: string;
  user: string;
} {
  const system = composeSections([
    PATH_OUTLINE_OPENER,
    composeStylePrefix(input.novel, input.style),
    writingNormsSection(input.norms, 'planning'),
    PATH_OUTLINE_TASK,
  ]);

  const first = input.steps[0];
  const last = input.steps[input.steps.length - 1];
  const range = first && last ? rangeLabel(first.depth + 1, last.depth + 1) : '';
  const destination =
    input.mode === 'main'
      ? '沉淀为本书主线大纲（追加在已有大纲之后）。'
      : input.appendTo
        ? `追加到外传《${input.appendTo.title}》的末尾（接着它已有的章节往下写，sideTitle 与 sideSynopsis 填空串）。`
        : '沉淀为一部新的外传。';
  const parts = [
    [
      '【这次沉淀】',
      `推演《${input.scenario.title}》，主角：${input.castName || '（未知）'}。`,
      destination,
      `范围：${range}，共 ${input.steps.length} 步。`,
    ].join('\n'),
  ];
  if (input.mode === 'main' && input.existingVolumeTitles.length > 0) {
    parts.push(
      ['【本书已有的卷】', ...input.existingVolumeTitles.map((title) => `- ${title}`)].join('\n'),
    );
  }
  if (input.mode === 'side' && input.prelude.trim()) {
    parts.push(['【分叉之前的经过（与主线共用，不要写进大纲）】', input.prelude.trim()].join('\n'));
  }
  parts.push(
    [
      '【推演经过】',
      ...input.steps.map((node) => `${promptStepHeading(node)}\n${node.plot.trim()}`),
    ].join('\n\n'),
  );
  return { system, user: composeSections(parts) };
}

/**
 * 某一步之前（含这一步）的前情：路径上这一步或之前最近的有摘要的检查点 + 之后到这一步的简写原文；
 * 没有任何摘要时是从开局起的全部原文。外传的分叉前情与「写这一章」的【分叉之前的经过】共用。
 * 来源是推演树而不是主线章节摘要：主线可能没沉淀、或被作者改写过，树上的才是这条线分叉前的事实（D8.2）
 */
export function forkPreludeText(path: readonly ScenarioNode[], uptoNodeId: string): string {
  const upto = path.findIndex((node) => node.id === uptoNodeId);
  if (upto < 0) return '';
  let start = 0;
  let summary = '';
  for (let i = upto; i >= 0; i -= 1) {
    const text = path[i]!.pathSummary?.text.trim() ?? '';
    if (text) {
      summary = `（到第 ${path[i]!.depth + 1} 步为止的前情）${text}`;
      start = i + 1;
      break;
    }
  }
  const steps = path
    .slice(start, upto + 1)
    .map((node) => `${promptStepHeading(node)}\n${node.plot.trim()}`);
  return [summary, ...steps].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- 序列化 / 解析

const STEPS_LINE = /^对应步骤\s*[:：]/u;
const STEPS_VALUE =
  /^对应步骤\s*[:：]\s*第?\s*(\d+)\s*(?:(?:[–—\-~～至到]|－)\s*第?\s*(\d+))?\s*步?\s*$/u;
const APPEARING_LINE = /^出场\s*[:：]\s*(.*)$/u;

function titleLine(depth: number, title: string, targetWords: number | null): string {
  return `${'#'.repeat(depth)} ${title}${targetWords ? `（约 ${targetWords} 字）` : ''}`;
}

function stepsLine(from: number, to: number): string {
  return `对应步骤：${from === to ? from : `${from}–${to}`}`;
}

function chapterLines(chapter: PathOutline['volumes'][number]['chapters'][number]): string[] {
  const lines = [titleLine(2, chapter.title, chapter.targetWords), chapter.synopsis.trim()];
  if (chapter.keyEvents.length > 0) lines.push(`关键事件：${chapter.keyEvents.join('；')}`);
  if (chapter.appearing.length > 0) lines.push(`出场：${chapter.appearing.join('、')}`);
  lines.push(stepsLine(chapter.fromStep, chapter.toStep));
  return lines;
}

/**
 * 模型结果 → 提案里可编辑的大纲文本（D7.2 格式）。主线：# 卷 / ## 章；外传不挂大纲树，只有 ## 章
 */
export function serializeScenarioOutline(outline: PathOutline, mode: 'main' | 'side'): string {
  const blocks: string[] = [];
  for (const volume of outline.volumes) {
    if (mode === 'main') {
      blocks.push(
        [titleLine(1, volume.title, volume.targetWords), volume.synopsis.trim()]
          .filter(Boolean)
          .join('\n'),
      );
    }
    for (const chapter of volume.chapters)
      blocks.push(chapterLines(chapter).filter(Boolean).join('\n'));
  }
  return blocks.join('\n\n');
}

export interface ParsedScenarioChapter {
  title: string;
  /** 梗概：保留「关键事件：」「出场：」两行，只去掉「对应步骤：」 */
  synopsis: string;
  targetWords: number | null;
  /** 「出场：」里能对上的通用条目 */
  linkedEntryIds: string[];
  nodeIds: string[];
  fromStep: number;
  toStep: number;
}

export interface ParsedScenarioOutline {
  /** 顶层每个标题一组：卷（volume 非空）及其下的章；或直接写在顶层的章（volume 为 null，外传的写法） */
  groups: {
    volume: { title: string; synopsis: string; targetWords: number | null } | null;
    chapters: ParsedScenarioChapter[];
  }[];
}

function hasStepsLine(draft: OutlineDraft): boolean {
  return draft.synopsis.split('\n').some((line) => STEPS_LINE.test(line.trim()));
}

/** 「出场：沈砚、阿七」→ 能对上的通用条目 id（名称或别名，与 findEntryByName 同一归一化口径） */
function appearingEntryIds(names: string, entries: readonly KnowledgeEntry[]): string[] {
  const wanted = names
    .split(/[、，,；;／/\s]+/u)
    .map(normalizeEntryName)
    .filter(Boolean);
  const ids: string[] = [];
  for (const name of wanted) {
    const hit = entries.find(
      (entry) =>
        (entry.deletedAt ?? null) === null &&
        (entry.scope?.kind ?? 'universal') === 'universal' &&
        [entry.title, ...entry.aliases].some((value) => normalizeEntryName(value) === name),
    );
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

/**
 * 提案里的大纲文本 → 结构。在 parseOutlineTree 的结果上只把「对应步骤：」一行剥出来换成 nodeIds；
 * 「关键事件：」「出场：」留在梗概里（梗概会进整章 prompt，模型能看到），「出场：」另解析出通用条目 id。
 * 步骤范围不合法时抛错（含「第 a–b 步」），提案留在待确认里让作者改 —— 宁可让作者改一下，
 * 也不把章节挂到错误的步骤上。
 *
 * pathNodeIds = 这次沉淀范围内的节点 id，按路径顺序：pathNodeIds[0] 是第 from 步
 */
export function parseScenarioOutline(
  outlineText: string,
  options: {
    from: number;
    to: number;
    pathNodeIds: readonly string[];
    entries: readonly KnowledgeEntry[];
  },
): ParsedScenarioOutline {
  const { from, to, pathNodeIds, entries } = options;
  if (pathNodeIds.length !== to - from + 1) throw new Error('沉淀范围与来源步骤对不上，请重新沉淀');
  const tree = parseOutlineTree(outlineText);
  if (tree.length === 0) throw new Error('大纲内容为空，或没有以 # 开头的标题行');

  const groups: { volume: OutlineDraft | null; chapters: OutlineDraft[] }[] = [];
  for (const root of tree) {
    if (hasStepsLine(root)) {
      if (root.children.length > 0)
        throw new Error(`大纲只支持卷、章两层：「${root.title}」下面不能再分节`);
      groups.push({ volume: null, chapters: [root] });
      continue;
    }
    if (root.children.length === 0) {
      throw new Error(
        `「${root.title}」缺少『对应步骤』一行；如果它是卷，下面要有章（章用 ## 开头）`,
      );
    }
    for (const chapter of root.children) {
      if (chapter.children.length > 0)
        throw new Error(`大纲只支持卷、章两层：「${chapter.title}」下面不能再分节`);
    }
    groups.push({ volume: root, chapters: root.children });
  }

  const ranges: { from: number; to: number }[] = [];
  const parsed = groups.map((group) => ({
    volume: group.volume
      ? {
          title: group.volume.title,
          synopsis: group.volume.synopsis.trim(),
          targetWords: group.volume.targetWords,
        }
      : null,
    chapters: group.chapters.map((chapter) => {
      const n = ranges.length + 1;
      const lines = chapter.synopsis.split('\n');
      const stepLines = lines.filter((line) => STEPS_LINE.test(line.trim()));
      if (stepLines.length === 0) throw new Error(`第 ${n} 章缺少『对应步骤』一行`);
      if (stepLines.length > 1) throw new Error(`第 ${n} 章写了不止一行『对应步骤』`);
      const match = STEPS_VALUE.exec(stepLines[0]!.trim());
      if (!match)
        throw new Error(`第 ${n} 章的『对应步骤』写法不对，应写成「对应步骤：${from}–${to}」这样`);
      const range = { from: Number(match[1]), to: Number(match[2] ?? match[1]) };
      ranges.push(range);
      const synopsis = lines
        .filter((line) => !STEPS_LINE.test(line.trim()))
        .join('\n')
        .trim();
      const appearing = lines.map((line) => APPEARING_LINE.exec(line.trim())).find(Boolean);
      return {
        title: chapter.title,
        synopsis,
        targetWords: chapter.targetWords,
        linkedEntryIds: appearing ? appearingEntryIds(appearing[1]!, entries) : [],
        nodeIds: [] as string[],
        fromStep: range.from,
        toStep: range.to,
      };
    }),
  }));

  const problem = checkStepCoverage(ranges, from, to);
  if (problem) throw new Error(problem.message);
  for (const group of parsed) {
    for (const chapter of group.chapters) {
      chapter.nodeIds = pathNodeIds.slice(chapter.fromStep - from, chapter.toStep - from + 1);
    }
  }
  return { groups: parsed };
}

// ---------------------------------------------------------------- 提案 payload 与落库计划

/** 沉淀提案的 payload（设计 §7.2 第 5 步）。采用时重新校验：它经过了作者的行内编辑 */
export const ScenarioOutlinePayloadSchema = z.object({
  scenarioId: z.string().min(1),
  mode: z.enum(['main', 'side']),
  range: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }),
  nodeIds: z.array(z.string().min(1)).min(1),
  forkNodeId: z.string().min(1).nullable(),
  /** 只在「追加到外传」时非空 */
  appendToSideStoryId: z.string().min(1).nullable(),
  sideTitle: z.string().default(''),
  sideSynopsis: z.string().default(''),
  outlineText: z.string().min(1, '大纲内容不能为空'),
});
export type ScenarioOutlinePayload = z.infer<typeof ScenarioOutlinePayloadSchema>;

/** 外传章节细纲的上限，与 Chapter.scenarioSource.brief 一致 */
const BRIEF_LIMIT = 3000;

/** 解析结果 + payload → 交给 repo.commitScenarioOutline 的落库计划 */
export function toScenarioOutlinePlan(
  payload: ScenarioOutlinePayload,
  parsed: ParsedScenarioOutline,
): ScenarioOutlinePlan {
  if (payload.mode === 'main') {
    return {
      scenarioId: payload.scenarioId,
      mode: 'main',
      volumes: parsed.groups.map((group) => {
        if (!group.volume) throw new Error('主线大纲的章要放在卷下面（卷用 # 开头，章用 ## 开头）');
        return {
          ...group.volume,
          chapters: group.chapters.map((chapter) => ({
            title: chapter.title,
            synopsis: chapter.synopsis,
            targetWords: chapter.targetWords,
            linkedEntryIds: chapter.linkedEntryIds,
            nodeIds: chapter.nodeIds,
          })),
        };
      }),
    };
  }

  const chapters = parsed.groups.flatMap((group) => group.chapters);
  chapters.forEach((chapter, index) => {
    if (chapter.synopsis.length > BRIEF_LIMIT) {
      throw new Error(`第 ${index + 1} 章的细纲超过 ${BRIEF_LIMIT} 字，请精简后再采用`);
    }
  });
  const appending = payload.appendToSideStoryId;
  if (!appending) {
    if (!payload.sideTitle.trim()) throw new Error('外传名称不能为空');
    if (!payload.forkNodeId) throw new Error('缺少分叉点，请重新沉淀');
  }
  return {
    scenarioId: payload.scenarioId,
    mode: 'side',
    appendToSideStoryId: appending,
    title: payload.sideTitle.trim(),
    synopsis: payload.sideSynopsis.trim(),
    // 追加时仓储不看它（不改已有外传的分叉点）
    forkNodeId: payload.forkNodeId ?? '',
    chapters: chapters.map((chapter) => ({
      title: chapter.title,
      nodeIds: chapter.nodeIds,
      brief: chapter.synopsis,
    })),
  };
}
