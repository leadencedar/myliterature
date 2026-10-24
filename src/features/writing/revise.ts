import { composeSections } from '@/prompt/sections';
import { findVoice, RUBRIC_DIMENSIONS } from '@/prompt/voiceLibrary';

/**
 * 段落级续写 / 改写 / 扩写。
 *
 * 选区处理是这里最容易出错的部分：用户在手机上划选很难精确到字，
 * 选中内容前后经常粘上空格或换行。如果直接用原始的 selectionStart/End 做替换，
 * 段落分隔符会被吃掉，正文结构瞬间崩坏。因此所有操作都先把选区**归一化**到
 * 真正的文字边界，再做替换。
 */

export type ReviseAction = 'continue' | 'rewrite' | 'expand';

export interface ReviseActionDef {
  id: ReviseAction;
  label: string;
  hint: string;
  /** 结果是替换选中内容，还是接在其后 */
  placement: 'replace' | 'after';
  /** 是否必须先选中文字 */
  requiresSelection: boolean;
}

export const REVISE_ACTIONS: ReviseActionDef[] = [
  {
    id: 'continue',
    label: '续写',
    hint: '接着选中的内容往下写，另起一段。不选则从正文末尾接着写。',
    placement: 'after',
    requiresSelection: false,
  },
  {
    id: 'rewrite',
    label: '改写',
    hint: '保持情节与信息不变，换一种写法。',
    placement: 'replace',
    requiresSelection: true,
  },
  {
    id: 'expand',
    label: '扩写',
    hint: '在原有基础上加细节与层次，篇幅大致翻倍。',
    placement: 'replace',
    requiresSelection: true,
  },
];

export function findReviseAction(id: ReviseAction): ReviseActionDef {
  return REVISE_ACTIONS.find((action) => action.id === id) ?? REVISE_ACTIONS[0]!;
}

export interface ReviseSelection {
  start: number;
  end: number;
  text: string;
}

/**
 * 把选区收缩到真正的文字边界，剔除两端的空白与换行。
 * 空选区（start === end）会被原样保留，用于「从光标处续写」。
 */
export function normalizeSelection(content: string, start: number, end: number): ReviseSelection {
  const from = Math.max(0, Math.min(start, end, content.length));
  const to = Math.max(0, Math.max(start, end));
  let left = from;
  let right = Math.min(to, content.length);

  while (left < right && /\s/u.test(content[left] ?? '')) left += 1;
  while (right > left && /\s/u.test(content[right - 1] ?? '')) right -= 1;

  return { start: left, end: right, text: content.slice(left, right) };
}

/** 没有选区时的默认目标：正文末尾（用于续写） */
export function selectionAtEnd(content: string): ReviseSelection {
  const trimmed = content.trimEnd();
  return { start: trimmed.length, end: trimmed.length, text: '' };
}

/** 选区前后的上下文，给模型判断语气与衔接 */
export function surroundingContext(
  content: string,
  selection: ReviseSelection,
  radius = 600,
): { before: string; after: string } {
  return {
    before: content.slice(Math.max(0, selection.start - radius), selection.start).trimStart(),
    after: content.slice(selection.end, selection.end + radius).trimEnd(),
  };
}

/**
 * 把生成结果写回正文。
 *
 * `after` 模式（续写）总是另起一段：在选区之后补一个空行再接新内容，
 * 若原文该处已有换行则不重复添加。
 */
export function applyRevision(
  content: string,
  selection: ReviseSelection,
  replacement: string,
  action: ReviseActionDef,
): string {
  const text = replacement.trim();
  if (!text) return content;

  if (action.placement === 'replace') {
    return content.slice(0, selection.start) + text + content.slice(selection.end);
  }

  const head = content.slice(0, selection.end);
  const tail = content.slice(selection.end);
  // 已经以空行结尾就不再加，避免出现三个连续换行
  const separator = /\n\s*\n\s*$/u.test(head) ? '' : head.trim() ? '\n\n' : '';
  const tailSeparator = tail.trim() ? (/^\s*\n/u.test(tail) ? '' : '\n\n') : '';
  return `${head}${separator}${text}${tailSeparator}${tail}`;
}

// ---------------------------------------------------------------- 提示词

const REVISE_TASKS: Record<ReviseAction, string> = {
  continue: [
    '【任务】',
    '接着「待处理片段」往下写新的内容。',
    '',
    '要求：',
    '- 只输出新写的内容，不要重复已有的文字。',
    '- 从已有内容的语气、节奏与场景自然接续，不要重新交代已交代过的信息。',
    '- 篇幅控制在 200–500 字，写完一个完整的小节奏就停，不要草草收尾也不要拖长。',
  ].join('\n'),
  rewrite: [
    '【任务】',
    '改写「待处理片段」：情节、信息与人物行为保持不变，换一种写法。',
    '',
    '要求：',
    '- 只输出改写后的片段，不要输出前后文，不要任何解释。',
    '- 不要增加或删减情节事实，也不要改变人物的决定。',
    '- 篇幅与原片段大致相当，上下浮动不超过 30%。',
  ].join('\n'),
  expand: [
    '【任务】',
    '扩写「待处理片段」：在原有内容基础上增加细节与层次。',
    '',
    '要求：',
    '- 只输出扩写后的片段，不要输出前后文，不要任何解释。',
    '- 保留原片段的全部情节与信息，在其间补充感官细节、动作、心理与对话。',
    '- 不要引入新的情节转折或新人物。',
    '- 篇幅大致为原片段的两倍。',
  ].join('\n'),
};

const COMMON_RULES = [
  '',
  '通用约束：',
  '- 直接输出正文，不要 Markdown 标记、不要引号包裹、不要加标题。',
  '- 严格遵守上文的核心设定与人物档案，人物口吻不得变样。',
].join('\n');

/**
 * 临时风格：只影响这一次操作，不写入风格档案。
 * 用于「这一段想换个笔法试试」，试完不满意直接放弃即可。
 */
export function temporaryVoiceSection(voiceId: string | null): string {
  if (!voiceId) return '';
  const preset = findVoice(voiceId);
  if (!preset) return '';

  const lines = [
    '【本次临时文风】',
    `这一次请按「${preset.name}」的笔法来写（${preset.tagline}），其特征如下：`,
  ];
  for (const dimension of RUBRIC_DIMENSIONS) {
    const value = preset.rubric[dimension.key]?.trim();
    if (value) lines.push(`- ${dimension.label}：${value}`);
  }
  lines.push('这只是本次的临时要求，不改变作品既有的文风设定。');
  return lines.join('\n');
}

export function buildReviseSystemPrompt(stablePrefix: string, action: ReviseAction): string {
  return composeSections([
    '你是一位职业小说作者，正在对一段已有正文做局部加工。',
    stablePrefix,
    `${REVISE_TASKS[action]}${COMMON_RULES}`,
  ]);
}

export function buildReviseUserPrompt(params: {
  volatileSuffix: string;
  selection: ReviseSelection;
  before: string;
  after: string;
  temporaryVoiceId?: string | null;
  instruction?: string;
}): string {
  const blocks: string[] = [];
  if (params.volatileSuffix.trim()) blocks.push(params.volatileSuffix);

  const voice = temporaryVoiceSection(params.temporaryVoiceId ?? null);
  if (voice) blocks.push(voice);

  if (params.before.trim()) {
    blocks.push(`【前文】\n${params.before.trim()}`);
  }

  blocks.push(
    params.selection.text.trim()
      ? `【待处理片段】\n${params.selection.text.trim()}`
      : '【待处理片段】\n（无，请从前文结尾处继续）',
  );

  if (params.after.trim()) {
    blocks.push(`【后文（不要写进去，但要能接上）】\n${params.after.trim()}`);
  }

  if (params.instruction?.trim()) {
    blocks.push(`【本次额外要求】\n${params.instruction.trim()}`);
  }

  return composeSections(blocks);
}
