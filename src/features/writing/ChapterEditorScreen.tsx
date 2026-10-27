import { useEffect, useRef, useState } from 'react';
import type { ContextRequest } from '@/context/ContextBuilder';
import type { NovelRepository } from '@/data/NovelRepository';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import { countWords } from '@/domain/primitives';
import type { Chapter, Proposal, SideStory } from '@/domain/schema';
import { chapterLabel } from '@/domain/sideStory';
import { Button, IconButton } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/Sheet';
import { BackIcon, TrashIcon, UndoIcon } from '@/ui/icons';
import { detectLanguage, needsTranslationToChinese } from '@/domain/language';
import { normsInScope } from '@/domain/writingNorm';
import { useLlm } from '@/llm/useLlm';
import { recordProgress } from '../plan/recordProgress';
import { useScenarioChapterContext } from '../scenario/useScenarioChapterContext';
import { ArchiveInboxSheet } from './ArchiveInboxSheet';
import { archiveChapter, type ArchiveChapterResult } from './archiveChapter';
import { useArchiveSettings } from './archiveSettings';
import { ChapterSummarySheet } from './ChapterSummarySheet';
import { TranslateSheet } from './TranslateSheet';
import { GenerateChapterSheet } from './GenerateChapterSheet';
import { useIncompleteDraft, useIncompleteDrafts } from './incompleteDrafts';
import { NormCheckSheet, type NormCheckSession } from './NormCheckSheet';
import { displayNormTitle, locateQuote, type ResolvedCheckIssue } from './normCheck';
import { ReviseSheet } from './ReviseSheet';
import {
  applyRevision,
  findReviseAction,
  normalizeSelection,
  selectionAtEnd,
  type ReviseAction,
} from './revise';

const AUTOSAVE_DELAY = 800;
/** 「按规范检查」禁用原因的显示时长 */
const CHECK_REASON_MS = 3000;

type SaveState = 'saved' | 'pending' | 'saving' | 'error';

const SAVE_LABELS: Record<SaveState, string> = {
  saved: '已保存',
  pending: '有改动',
  saving: '保存中…',
  error: '保存失败',
};

/**
 * 正在后台跑的归档任务（按章节 id 去重）。
 *
 * 编辑器可能在 React StrictMode 下重复挂载，作者也可能在「完成 → 草稿 → 完成」
 * 之间连点；同一章任何时刻只允许一次付费调用，后来的调用复用同一个 Promise。
 * 放 module 级而不是组件 state：重挂载后 state 会丢，而请求还在飞。
 */
const inFlightArchives = new Map<string, Promise<ArchiveChapterResult>>();

type ArchiveState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | {
      kind: 'done';
      batchId: string;
      pendingCount: number;
      entryCount: number;
      summaryCreated: boolean;
      entriesDegraded: boolean;
    }
  | { kind: 'error'; message: string }
  /** 自动归档被关掉：只提示可手动补摘要，不自动调用 */
  | { kind: 'manual' }
  /** 没配置模型：不自动调用，提示去设置 */
  | { kind: 'unconfigured' };

/** 提案 payload 是 unknown，读字段前先收窄成对象 */
function proposalPayload(proposal: Proposal): Record<string, unknown> | undefined {
  const payload = proposal.payload;
  return payload !== null && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : undefined;
}

/**
 * 本章是否已有待确认的归档提案（design §6.5）：挂载时恢复「待确认」态，不重跑。
 *
 * 归属判定：摘要提案按 `payload.chapterId`；条目提案按 `payload.sourceChapterIds`。
 * 进展 replace 提案是作品级的，没法可靠归属到某一章，只用来数本批条目数。
 */
async function findPendingArchive(
  repository: NovelRepository,
  novelId: string,
  chapterId: string,
): Promise<{ batchId: string; pendingCount: number } | null> {
  const pending = await repository.listProposals(novelId, { status: 'pending' });
  const owned = pending.filter((proposal) => {
    const payload = proposalPayload(proposal);
    if (!payload) return false;
    if (proposal.target === 'chapterSummary') return payload.chapterId === chapterId;
    if (proposal.target === 'knowledgeEntry') {
      const sources = payload.sourceChapterIds;
      return Array.isArray(sources) && sources.includes(chapterId);
    }
    return false;
  });
  const anchor = owned[0];
  if (!anchor?.batchId) return null;
  const pendingCount = pending.filter(
    (proposal) => proposal.target === 'knowledgeEntry' && proposal.batchId === anchor.batchId,
  ).length;
  return { batchId: anchor.batchId, pendingCount };
}

interface ChapterEditorScreenProps {
  chapter: Chapter;
  /** 构建生成上下文所需的数据；targetChapterId 由本组件补上 */
  // excludedNormIds 是生成 / 加工面板各自的本次状态，编辑器不持有
  context: Omit<
    ContextRequest,
    'selectedEntryIds' | 'recentSummaryCount' | 'targetChapterId' | 'excludedNormIds'
  >;
  /** 外传章节所属的外传；主线章节不传 */
  sideStory?: SideStory;
  onClose: () => void;
}

/**
 * 章节编辑器。
 *
 * 做成覆盖全屏的面板而不是底部抽屉：写作需要尽可能大的可视区域，
 * 抽屉的圆角、遮罩和留白在三千字的正文面前都是浪费。
 *
 * 保存采用防抖自动保存 —— 移动端随时可能被来电或切后台打断，
 * 指望用户记得按保存是不现实的。标题栏实时显示保存状态，让用户对
 * 「我的字有没有丢」始终有把握。
 */
export function ChapterEditorScreen({
  chapter,
  context,
  sideStory,
  onClose,
}: ChapterEditorScreenProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  // 只用来判断「按规范检查」入口是否可用；真正的检查请求在面板里发
  const llm = useLlm();

  // 采用了截断/中断稿的会话内留痕（P0）：只放内存，切「已完成」或完整采用时清除
  const incompleteDraft = useIncompleteDraft(chapter.id);
  const markIncomplete = useIncompleteDrafts((state) => state.markIncomplete);
  const clearIncomplete = useIncompleteDrafts((state) => state.clearIncomplete);

  // 初值只在挂载时取。调用方用 key={chapter.id} 保证换章节时重新挂载
  const [title, setTitle] = useState(chapter.title);
  const [content, setContent] = useState(chapter.content);
  const [status, setStatus] = useState<Chapter['status']>(chapter.status);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [generateOpen, setGenerateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [reviseOpen, setReviseOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  /**
   * 翻译前的原文备份。
   *
   * 与 `chapter.sourceContent` 同源，但**以本地 state 为准**：`chapter` 是父级
   * 查询的快照，采用译文后要等它刷新回来才会带上原文，这中间「重译」入口会闪一下不见。
   * 本地 state 立即生效，也就不必依赖上游刷新的时机。
   */
  const [sourceBackup, setSourceBackup] = useState(chapter.sourceContent);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [selectionRange, setSelectionRange] = useState({ start: 0, end: 0 });
  /** 后台归档的会话内状态（design §3）：不阻塞编辑，不打开 Sheet */
  const [archiveState, setArchiveState] = useState<ArchiveState>({ kind: 'idle' });
  const [archiveInboxOpen, setArchiveInboxOpen] = useState(false);
  const archiveSettings = useArchiveSettings();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 「按规范检查」的会话状态：只存在编辑器这次挂载里，离开或换章即丢。
   * 不落库：检查便宜可重跑，而正文一改结果就过期，库里留一份过期判断只会误导
   */
  const [normCheckOpen, setNormCheckOpen] = useState(false);
  const [normCheck, setNormCheck] = useState<NormCheckSession | null>(null);
  const [ignoredKeys, setIgnoredKeys] = useState<string[]>([]);
  const [checkReason, setCheckReason] = useState<string | null>(null);
  /** 禁用原因的计时器放 ref：再次点击与卸载时要能清掉，避免卸载后还 setState（遗留 #7） */
  const checkReasonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 段落加工面板的预填值。由编辑器持有而不是面板：「按建议改写」设置它，
   * 底栏「加工这一段」与面板关闭时清空，之后的普通加工就不会带上旧建议
   */
  const [reviseSeed, setReviseSeed] = useState<{
    action: ReviseAction;
    instruction: string;
  } | null>(null);

  /**
   * 挂载时恢复本章的归档状态（design §6.5）：只查 pending、不重跑。
   * 这样重新打开一个「已完成但还没确认档案」的章节时，作者仍然看得到入口；
   * React StrictMode 下 effect 跑两遍也只是两次只读查询。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const pending = await findPendingArchive(repository, context.novel.id, chapter.id);
        if (!cancelled && pending) {
          // 只在还没有状态时恢复：查询期间作者可能刚触发归档，别用旧 pending 覆盖新状态
          setArchiveState((current) =>
            current.kind === 'idle'
              ? {
                  kind: 'done',
                  ...pending,
                  entryCount: 0,
                  summaryCreated: true,
                  entriesDegraded: false,
                }
              : current,
          );
        }
      } catch {
        // 只是恢复提示；查询失败不影响写作，下次标完成会重新归档
      }
    })();
    return () => {
      cancelled = true;
    };
    // chapter.id 变化由调用方 key 保证重新挂载；novelId 不变
  }, [repository, context.novel.id, chapter.id]);

  const hasSummary = context.summaries.some((item) => item.chapterId === chapter.id);
  /** 已完成但没有摘要：摘要链在这里断了，需要提醒 */
  const needsSummary = status === 'done' && !hasSummary;

  /**
   * 大纲节点完成提示（design §3）：本章与同节点下的所有章节都已完成、
   * 且节点本身还没标完成时才提示。只提示，点击才写 —— 不自动改大纲状态。
   */
  const outlineNode = chapter.outlineNodeId
    ? context.outline.find((item) => item.id === chapter.outlineNodeId)
    : undefined;
  /** 本次会话内已处理（标完成或点「知道了」）后不再提示；不写任何状态 */
  const [outlinePromptDismissed, setOutlinePromptDismissed] = useState(false);
  const outlineChapters = chapter.outlineNodeId
    ? context.chapters.filter((item) => item.outlineNodeId === chapter.outlineNodeId)
    : [];
  const allOutlineChaptersDone =
    outlineChapters.length > 0 &&
    outlineChapters.every((item) =>
      item.id === chapter.id ? status === 'done' : item.status === 'done',
    );
  const canMarkOutlineDone =
    status === 'done' &&
    !outlinePromptDismissed &&
    outlineNode !== undefined &&
    outlineNode.status !== 'done' &&
    allOutlineChaptersDone;

  async function markOutlineDone() {
    if (!outlineNode) return;
    try {
      await repository.updateOutlineNode(outlineNode.id, { status: 'done' });
      setOutlinePromptDismissed(true);
      invalidate();
    } catch {
      // 写失败就保持提示，作者可以再点一次
    }
  }

  /**
   * 撤销栈。
   *
   * 自己维护而不是靠浏览器：程序化修改 value 会清掉 textarea 的原生撤销历史，
   * 而 AI 改写恰恰是最需要「一键还原」的操作 —— 用户敢不敢试，取决于能不能退回来。
   */
  const historyRef = useRef<string[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 待保存的内容。放 ref 里以便离场时立即冲刷 */
  const pendingRef = useRef<Partial<Chapter> | null>(null);

  /**
   * 已计入当日产出的字数基准，以及本章是否已计过「完成一章」。
   *
   * 进度记录挂在保存动作上而不是单独的按钮：写作计划要有意义，就必须
   * 自动统计，指望用户每天手动汇报产出等于这个功能不存在。
   * 完成计数在编辑器的一次挂载周期内只记一次，避免反复切换状态刷进度。
   */
  const recordedWordsRef = useRef(countWords(chapter.content));
  const countedDoneRef = useRef(chapter.status === 'done');

  const flush = useRef(async () => {
    const patch = pendingRef.current;
    if (!patch) return;
    pendingRef.current = null;
    setSaveState('saving');
    try {
      const saved = await repository.updateChapter(chapter.id, patch);
      const justCompleted = saved.status === 'done' && !countedDoneRef.current;
      if (justCompleted) countedDoneRef.current = true;
      await recordProgress(repository, saved.novelId, {
        words: saved.wordCount - recordedWordsRef.current,
        chaptersCompleted: justCompleted ? 1 : 0,
      });
      recordedWordsRef.current = saved.wordCount;
      invalidate();
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  });

  function scheduleSave(patch: Partial<Chapter>) {
    pendingRef.current = { ...pendingRef.current, ...patch };
    setSaveState('pending');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flush.current(), AUTOSAVE_DELAY);
  }

  useEffect(
    () => () => {
      if (checkReasonTimerRef.current) clearTimeout(checkReasonTimerRef.current);
    },
    [],
  );

  // 卸载时把未落盘的改动立刻写出去，别等防抖
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void flush.current();
    },
    [],
  );

  /** 立即落盘，不等防抖 */
  function saveNow() {
    if (timerRef.current) clearTimeout(timerRef.current);
    void flush.current();
  }

  /**
   * 后台归档当前章节（design §3 / §6.5）。
   *
   * 用编辑器里的最新正文，不等防抖保存 —— 作者刚打完最后一句就点完成时，
   * 库里的版本可能还差这 800ms。失败只更新状态行，不弹窗、不打断写作；
   * 归档服务「失败不写任何提案」，所以重试是安全的。
   */
  async function runArchive() {
    const chapterSnapshot: Chapter = { ...chapter, title, content, status: 'done' };
    let task = inFlightArchives.get(chapter.id);
    if (!task) {
      const settings = useArchiveSettings.getState();
      task = archiveChapter(
        { repository, llm },
        {
          novel: context.novel,
          chapter: chapterSnapshot,
          chapters: context.chapters,
          summaries: context.summaries,
          entries: context.entries,
          categories: context.categories,
          ...(sideStory ? { sideStory } : {}),
          ...(context.writingNorms ? { writingNorms: context.writingNorms } : {}),
          options: { extractEntries: settings.extractEntries },
        },
      ).finally(() => {
        inFlightArchives.delete(chapter.id);
      });
      inFlightArchives.set(chapter.id, task);
    }
    setArchiveState({ kind: 'running' });
    try {
      const result = await task;
      // 新提案要尽快出现在页面「待确认」里，也保证 [查看] 能查到
      invalidate();
      setArchiveState({ kind: 'done', ...result });
    } catch (cause) {
      setArchiveState({
        kind: 'error',
        message: cause instanceof Error ? cause.message : '归档失败',
      });
    }
  }

  /**
   * 标记完成时的归档入口。
   * 只在本次会话的 draft→done 转换里调用；打开一个已完成的旧章节不会走到这里。
   */
  function handleMarkedDone() {
    if (!archiveSettings.autoArchive) {
      setArchiveState({ kind: 'manual' });
      return;
    }
    if (!llm.configured) {
      setArchiveState({ kind: 'unconfigured' });
      return;
    }
    void runArchive();
  }

  /**
   * Cmd/Ctrl+S 立即保存。
   *
   * 内容本来就在自动保存，这个快捷键的价值不在于「保住数据」，而在于
   * 桌面端写作者会条件反射地按它 —— 拦不住的话浏览器会弹出「保存网页」对话框，
   * 那才是真的打断。所以要 preventDefault 并顺手把待写内容冲刷掉。
   *
   * **刻意不绑 Esc 关闭编辑器**：中文输入法用 Esc 取消候选词，
   * 写中文的人一分钟能按好几次。这里绑上就等于随机退出编辑器。
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      saveNow();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // saveNow 只经由 ref 访问最新状态，因此挂一次就够
  }, []);

  async function closeWithFlush() {
    if (timerRef.current) clearTimeout(timerRef.current);
    await flush.current();
    onClose();
  }

  /**
   * 写入正文并立即落盘；同时把改动前的内容压入撤销栈。
   * patch 用来把同一次确认动作里的其它字段（如状态退回草稿）并进同一次写库，
   * 不留「正文已替换、状态还是已完成」的中间态。
   */
  async function commitContent(next: string, patch: Partial<Chapter> = {}) {
    historyRef.current.push(content);
    setCanUndo(true);
    setContent(next);
    // 用户明确确认过的动作，不等防抖
    pendingRef.current = { ...pendingRef.current, content: next, ...patch };
    if (timerRef.current) clearTimeout(timerRef.current);
    await flush.current();
  }

  /**
   * 采用译文。
   *
   * 除了换掉正文，还要把原文存进 `sourceContent` —— 翻译不可逆，
   * 而机器译文一定有需要回头核对原句的地方。同时压入撤销栈，
   * 万一译得不对，一键就能退回外文原稿。
   */
  async function applyTranslation(translated: string, sourceText: string) {
    historyRef.current.push(content);
    setCanUndo(true);
    setContent(translated);
    setSourceBackup(sourceText);
    pendingRef.current = {
      ...pendingRef.current,
      content: translated,
      sourceContent: sourceText,
      sourceLanguage: detectLanguage(sourceText),
    };
    saveNow();
    setTranslateOpen(false);
  }

  async function applyGenerated(
    text: string,
    mode: 'replace' | 'append',
    meta?: { incomplete?: 'truncated' | 'aborted' },
  ) {
    const next = mode === 'append' ? `${content.trimEnd()}\n\n${text.trim()}` : text.trim();
    // 与确认文案「采用后本章仍是草稿」一致：已完成章节不能留半章当定稿。
    // 状态与正文放进同一次写库；摘要等作者重新标完成时再生成，这里不自动触发
    const demoteToDraft = Boolean(meta?.incomplete) && status === 'done';
    await commitContent(next, demoteToDraft ? { status: 'draft' } : {});
    if (demoteToDraft) setStatus('draft');
    // 不完整稿的采用事实跟着这次写入走：留在标题栏下方，提醒作者补完再标完成。
    // 完整采用则清掉之前的提醒（作者可能已经补写或重新生成了完整稿）
    if (meta?.incomplete) markIncomplete(chapter.id);
    else clearIncomplete(chapter.id);
  }

  async function applyRevised(replacement: string, action: ReviseAction) {
    const actionDef = findReviseAction(action);
    const selection = actionDef.requiresSelection
      ? normalizeSelection(content, selectionRange.start, selectionRange.end)
      : normalizeSelection(content, selectionRange.start, selectionRange.end).text.trim()
        ? normalizeSelection(content, selectionRange.start, selectionRange.end)
        : selectionAtEnd(content);
    await commitContent(applyRevision(content, selection, replacement, actionDef));
  }

  async function undo() {
    const previous = historyRef.current.pop();
    if (previous === undefined) return;
    setCanUndo(historyRef.current.length > 0);
    setContent(previous);
    pendingRef.current = { ...pendingRef.current, content: previous };

    /**
     * 撤销的正好是那次翻译：把原文备份一并清掉。
     * 否则这一章会同时是「正文为原文」和「译过一次」，
     * 界面上会挂着一个「重译」按钮，而它其实什么都没译过。
     */
    if (sourceBackup.trim() && previous === sourceBackup) {
      setSourceBackup('');
      pendingRef.current = { ...pendingRef.current, sourceContent: '', sourceLanguage: '' };
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    await flush.current();
  }

  /** 记录选区，供段落级操作使用 */
  function captureSelection() {
    const element = textareaRef.current;
    if (!element) return;
    setSelectionRange({ start: element.selectionStart, end: element.selectionEnd });
  }

  async function remove() {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = null;
    await repository.deleteChapter(chapter.id);
    invalidate();
    setConfirmDelete(false);
    onClose();
  }

  /**
   * 由推演沉淀的章节：主线看大纲节点的溯源，外传看章节自己的。推演材料只合进整章生成的 context
   * （见下面的 GenerateChapterSheet），共享的 context 不带它，段落加工等面板拿不到
   */
  const chapterSource =
    chapter.sideStoryId === null
      ? (context.outline.find((node) => node.id === chapter.outlineNodeId)?.scenarioSource ?? null)
      : (chapter.scenarioSource ?? null);
  const scenarioChapter = useScenarioChapterContext({
    novelId: context.novel.id,
    source: chapterSource,
    forkNodeId: sideStory?.scenarioSource?.forkNodeId ?? null,
  });
  const scenarioContext = scenarioChapter?.context ?? undefined;
  const sideBrief = chapter.scenarioSource?.brief.trim() ?? '';

  const wordCount = countWords(content);
  /** 「第 3 章」/「外传·青冥旧事 第 3 章」 */
  const label = chapterLabel(chapter, sideStory ? [sideStory] : (context.sideStories ?? []));

  /** 入口不可用的原因；null 表示可以检查 */
  const checkBlocked =
    normsInScope(context.writingNorms ?? [], 'check').length === 0
      ? '先在知识库添加写作规范（并勾选「检查」作用范围）'
      : !llm.configured
        ? '需要先在「设置」里配置模型'
        : !content.trim()
          ? '本章还没有正文'
          : null;
  const openIssueCount = normCheck
    ? normCheck.issues.filter((issue) => !ignoredKeys.includes(issue.key)).length
    : 0;

  /**
   * 不可用时不用原生 disabled：触屏点下去要能看到原因。
   * 原因 3 秒后消失，再次点击也消失
   */
  function openNormCheck() {
    if (checkReasonTimerRef.current) {
      clearTimeout(checkReasonTimerRef.current);
      checkReasonTimerRef.current = null;
    }
    if (checkBlocked) {
      if (checkReason) {
        setCheckReason(null);
        return;
      }
      setCheckReason(checkBlocked);
      checkReasonTimerRef.current = setTimeout(() => {
        checkReasonTimerRef.current = null;
        setCheckReason(null);
      }, CHECK_REASON_MS);
      return;
    }
    setCheckReason(null);
    setNormCheckOpen(true);
  }

  /**
   * 用当前正文重新定位并选中原句。面板已先用当前正文判断过能否定位，
   * 这里再算一次是为了拿到区间；找不到时什么都不做
   */
  function selectIssueQuote(issue: ResolvedCheckIssue): boolean {
    const range = locateQuote(content, issue.quote);
    if (!range) return false;
    setNormCheckOpen(false);
    const element = textareaRef.current;
    if (element) {
      // focus 之后再设选区，浏览器会把光标滚进视野
      element.focus();
      element.setSelectionRange(range.start, range.end);
    }
    // 同步选区 state：接着点「加工这一段」就是这一句
    setSelectionRange(range);
    return true;
  }

  /** 按建议改写：先定位，再打开段落加工并预填。写入正文仍要作者在加工面板里确认 */
  function reviseIssue(issue: ResolvedCheckIssue) {
    if (!selectIssueQuote(issue)) return;
    setReviseSeed({
      action: 'rewrite',
      instruction: `按写作规范《${displayNormTitle(issue.normTitle)}》修改：${issue.suggestion}`,
    });
    setReviseOpen(true);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={
        sideStory
          ? `编辑外传《${sideStory.title}》第 ${chapter.index} 章`
          : `编辑第 ${chapter.index} 章`
      }
      className="fixed inset-0 z-50 flex flex-col bg-paper"
    >
      {/* 头尾都收进与正文同宽的阅读列：桌面端把返回按钮甩到 1920px 最左边、
          正文却居中在中间，眼睛要来回横跨整个屏幕 */}
      <header className="safe-top shrink-0 border-b border-ink-100 bg-paper/95 backdrop-blur">
        <div className="reading-column flex items-center gap-1 px-2 py-2 lg:px-0">
          <IconButton label="返回" onClick={closeWithFlush}>
            <BackIcon className="h-6 w-6" />
          </IconButton>

          <input
            value={title}
            aria-label="章节标题"
            placeholder={label}
            onChange={(event) => {
              setTitle(event.target.value);
              scheduleSave({ title: event.target.value });
            }}
            className="min-w-0 flex-1 bg-transparent px-1 py-1.5 font-medium text-ink-900 placeholder:text-ink-300 focus:outline-none"
          />

          <IconButton label="删除本章" onClick={() => setConfirmDelete(true)}>
            <TrashIcon className="h-5 w-5" />
          </IconButton>
        </div>

        {/* flex-wrap：多了「按规范检查」后 375px 宽放不下，换行而不是溢出 */}
        <div className="reading-column flex flex-wrap items-center gap-3 gap-y-1.5 px-3 pb-2 text-xs text-ink-500 lg:px-1">
          <span>{label}</span>
          <span>{wordCount} 字</span>
          <span aria-live="polite" className={saveState === 'error' ? 'text-seal' : 'text-ink-300'}>
            {SAVE_LABELS[saveState]}
          </span>
          {/* 桌面端提示快捷键。窄屏没有物理键盘，显示它只是占地方 */}
          <span className="hidden text-ink-300 lg:inline">⌘/Ctrl + S 保存</span>
          {canUndo ? (
            <button
              type="button"
              onClick={undo}
              className="inline-flex items-center gap-1 rounded-full bg-paper-sunken px-2 py-1 text-[0.6875rem] text-ink-700"
            >
              <UndoIcon className="h-3.5 w-3.5" />
              撤销 AI 改动
            </button>
          ) : null}
          {/* 只在这一章确实需要翻译、或已经译过时出现。
              用 needsTranslationToChinese 而不是 `!== 'zh'`：空白新章节的语种是
              unknown，后者会让每一个刚建的章节都挂着一个翻译按钮 */}
          {needsTranslationToChinese(content) || sourceBackup.trim() ? (
            <button
              type="button"
              onClick={() => setTranslateOpen(true)}
              className="rounded-full bg-accent-soft px-2.5 py-1 text-[0.6875rem] font-medium text-accent"
            >
              {sourceBackup.trim() ? '重译' : '译成中文'}
            </button>
          ) : null}

          {/* 主线与外传章节都显示：外传用同一套规范，前情取外传内此前最近一份摘要。
              ml-auto 从摘要按钮移到这里，让右侧这组按钮仍然靠右 */}
          <button
            type="button"
            aria-disabled={checkBlocked ? 'true' : undefined}
            onClick={openNormCheck}
            className={[
              'ml-auto tap-target inline-flex items-center justify-center rounded-full px-2.5 py-1 text-[0.6875rem] font-medium transition-colors',
              openIssueCount > 0 ? 'bg-accent-soft text-accent' : 'bg-paper-sunken text-ink-500',
              checkBlocked ? 'opacity-60' : '',
            ].join(' ')}
          >
            {openIssueCount > 0 ? `检查结果 ${openIssueCount}` : '按规范检查'}
          </button>

          <button
            type="button"
            onClick={() => setSummaryOpen(true)}
            className={[
              'rounded-full px-2.5 py-1 text-[0.6875rem] font-medium transition-colors',
              needsSummary ? 'bg-accent-soft text-accent' : 'bg-paper-sunken text-ink-500',
            ].join(' ')}
          >
            {needsSummary ? '补摘要' : hasSummary ? '摘要' : '写摘要'}
          </button>

          <button
            type="button"
            onClick={() => {
              const next = status === 'done' ? 'draft' : 'done';
              setStatus(next);
              scheduleSave({ status: next });
              // 标完成代表作者认可这是定稿：未完成稿的提醒到此为止
              if (next === 'done') {
                clearIncomplete(chapter.id);
                // design §6.6：不再自动弹摘要面板；改为后台生成档案，不打断收工。
                // 正文为空时不做无意义的付费调用
                if (content.trim()) handleMarkedDone();
                else setArchiveState({ kind: 'idle' });
              } else {
                // 退回草稿：归档状态行不再适用（已产生的 pending 提案仍在，重开会恢复）
                setArchiveState({ kind: 'idle' });
              }
            }}
            className={[
              'rounded-full px-2.5 py-1 text-[0.6875rem] font-medium transition-colors',
              status === 'done' ? 'bg-emerald-50 text-emerald-700' : 'bg-paper-sunken text-ink-500',
            ].join(' ')}
          >
            {status === 'done' ? '已完成' : '草稿'}
          </button>
        </div>
        {/* 后台归档状态行（design §3）：不打开 Sheet、不阻塞编辑 */}
        {archiveState.kind !== 'idle' ? (
          <div role="status" className="reading-column px-3 pb-2 lg:px-1">
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-paper-sunken px-3 py-2 text-xs leading-relaxed text-ink-700">
              {archiveState.kind === 'running' ? (
                <span>正在生成本章摘要与设定…（后台运行，可继续编辑）</span>
              ) : archiveState.kind === 'done' ? (
                <>
                  <span className="flex-1">
                    本章摘要与设定已生成：
                    {archiveState.pendingCount > 0
                      ? `${archiveState.pendingCount} 条知识库更新待确认`
                      : '待确认'}
                    {archiveState.entriesDegraded ? '（知识库条目本轮未生成）' : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => setArchiveInboxOpen(true)}
                    className="shrink-0 rounded-full bg-ink-900 px-2.5 py-1 text-[0.6875rem] font-medium text-paper"
                  >
                    查看
                  </button>
                </>
              ) : archiveState.kind === 'error' ? (
                <>
                  <span className="flex-1 text-seal">
                    本章摘要与设定生成失败：{archiveState.message}
                  </span>
                  <button
                    type="button"
                    onClick={() => void runArchive()}
                    className="shrink-0 rounded-full bg-paper-raised px-2.5 py-1 text-[0.6875rem] font-medium text-ink-700"
                  >
                    重试
                  </button>
                </>
              ) : archiveState.kind === 'manual' ? (
                <span>自动归档已关闭；可手动补摘要（点上方「补摘要」）。</span>
              ) : (
                <span>未配置模型，无法自动生成本章摘要与设定；请先到「设置」填写 API Key。</span>
              )}
            </div>
          </div>
        ) : null}
        {canMarkOutlineDone ? (
          <div className="reading-column px-3 pb-2 lg:px-1">
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-paper-sunken px-3 py-2 text-xs leading-relaxed text-ink-700">
              <span className="flex-1">大纲节点「{outlineNode.title}」可以标为完成。</span>
              <button
                type="button"
                onClick={() => void markOutlineDone()}
                className="shrink-0 rounded-full bg-paper-raised px-2.5 py-1 text-[0.6875rem] font-medium text-ink-700"
              >
                标记完成
              </button>
              <button
                type="button"
                onClick={() => setOutlinePromptDismissed(true)}
                className="shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium text-ink-500"
              >
                知道了
              </button>
            </div>
          </div>
        ) : null}
        {/* P0：截断/中断稿采用后必须在编辑器里留痕，否则半章会被当成定稿 */}
        {incompleteDraft ? (
          <div role="status" className="reading-column px-3 pb-2 lg:px-1">
            <div className="flex items-start gap-2 rounded-lg bg-accent-soft px-3 py-2">
              <p className="flex-1 text-xs leading-relaxed text-accent">
                本章由未完成生成稿采用，可能缺少结尾；补写后再标「已完成」
              </p>
              <button
                type="button"
                onClick={() => clearIncomplete(chapter.id)}
                className="shrink-0 rounded-full bg-paper-raised px-2.5 py-1 text-[0.6875rem] font-medium text-ink-700"
              >
                知道了
              </button>
            </div>
          </div>
        ) : null}
        {checkReason ? (
          <p role="status" className="reading-column px-3 pb-2 text-xs text-accent lg:px-1">
            {checkReason}
          </p>
        ) : null}
        {/* 推演章节的两条提示：生成面板不改，提示放在编辑器头部，打开「生成本章」之前就能看到 */}
        {scenarioChapter?.sourceGone ? (
          <p className="reading-column px-3 pb-2 text-xs text-ink-500 lg:px-1">
            来源推演已不存在，本章只按大纲生成
          </p>
        ) : null}
        {scenarioChapter?.castInTrash ? (
          <p className="reading-column px-3 pb-2 text-xs text-ink-500 lg:px-1">
            推演主角「{scenarioChapter.castInTrash}」在回收站里，本章不会带上他的档案
          </p>
        ) : null}
        {/* 外传章节没有大纲节点，逐章细纲挂在章节上，这里只读显示（设计 D7.6） */}
        {sideBrief ? (
          <details className="reading-column px-3 pb-2 text-xs text-ink-500 lg:px-1">
            <summary className="cursor-pointer">本章细纲</summary>
            <p className="mt-1 leading-relaxed whitespace-pre-wrap text-ink-700">{sideBrief}</p>
          </details>
        ) : null}
      </header>

      <textarea
        ref={textareaRef}
        value={content}
        aria-label="章节正文"
        placeholder="从这里开始写，或者用下面的「生成本章」让 AI 先出一稿。"
        onChange={(event) => {
          setContent(event.target.value);
          scheduleSave({ content: event.target.value });
        }}
        // 选区变化的来源在移动端与桌面端不同，几个事件都挂上最稳
        onSelect={captureSelection}
        onKeyUp={captureSelection}
        onMouseUp={captureSelection}
        onTouchEnd={captureSelection}
        className={[
          'reading-column min-h-0 flex-1 resize-none bg-paper text-ink-900',
          'px-4 py-4 lg:px-1 lg:py-8',
          // 桌面端屏幕远，字号与行距都要比手机上松一档
          'font-reading text-[1.0625rem] leading-[1.9] lg:text-[1.1875rem] lg:leading-[2.1]',
          'placeholder:text-ink-300 focus:outline-none',
        ].join(' ')}
      />

      <footer className="safe-bottom shrink-0 border-t border-ink-100 bg-paper-raised px-3 py-2 lg:pb-3">
        <div className="reading-column flex gap-2 lg:px-1">
          <Button
            variant="secondary"
            size="lg"
            block
            onClick={() => {
              captureSelection();
              // 普通加工不带「按建议改写」留下的预填
              setReviseSeed(null);
              setReviseOpen(true);
            }}
          >
            加工这一段
          </Button>
          <Button variant="primary" size="lg" block onClick={() => setGenerateOpen(true)}>
            生成本章
          </Button>
        </div>
      </footer>

      <GenerateChapterSheet
        open={generateOpen}
        context={{
          ...context,
          targetChapterId: chapter.id,
          ...(scenarioContext ? { scenarioContext } : {}),
        }}
        existingContent={content}
        onClose={() => setGenerateOpen(false)}
        onAccept={applyGenerated}
      />

      <ReviseSheet
        open={reviseOpen}
        content={content}
        selection={normalizeSelection(content, selectionRange.start, selectionRange.end)}
        context={{ ...context, targetChapterId: chapter.id }}
        onClose={() => {
          setReviseOpen(false);
          setReviseSeed(null);
        }}
        onAccept={applyRevised}
        {...(reviseSeed
          ? { initialAction: reviseSeed.action, initialInstruction: reviseSeed.instruction }
          : {})}
      />

      <NormCheckSheet
        open={normCheckOpen}
        label={label}
        content={content}
        context={{
          novel: context.novel,
          categories: context.categories,
          entries: context.entries,
          chapters: context.chapters,
          summaries: context.summaries,
          writingNorms: context.writingNorms ?? [],
        }}
        chapterId={chapter.id}
        result={normCheck}
        ignoredKeys={ignoredKeys}
        onResult={(next) => {
          setNormCheck(next);
          // 重新检查时清空忽略：新结果的 key 与旧结果无关
          setIgnoredKeys([]);
        }}
        onIgnore={(key) => setIgnoredKeys((current) => [...current, key])}
        onLocate={(issue) => void selectIssueQuote(issue)}
        onRevise={reviseIssue}
        onClose={() => setNormCheckOpen(false)}
      />

      <TranslateSheet
        open={translateOpen}
        novel={context.novel}
        style={context.style}
        chapter={{ ...chapter, sourceContent: sourceBackup }}
        content={content}
        onClose={() => setTranslateOpen(false)}
        onAccept={applyTranslation}
      />

      <ChapterSummarySheet
        open={summaryOpen}
        novel={context.novel}
        // 用编辑器里的最新正文，而不是可能还没落盘的库中版本
        chapter={{ ...chapter, content, title, status }}
        chapters={context.chapters}
        summaries={context.summaries}
        entries={context.entries}
        {...(sideStory ? { sideStory } : {})}
        autoStart={false}
        onClose={() => setSummaryOpen(false)}
      />

      <ArchiveInboxSheet
        open={archiveInboxOpen && archiveState.kind === 'done'}
        novelId={context.novel.id}
        batchId={archiveState.kind === 'done' ? archiveState.batchId : null}
        onClose={() => setArchiveInboxOpen(false)}
        onSettled={() => {
          invalidate();
          setArchiveInboxOpen(false);
          setArchiveState({ kind: 'idle' });
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="删除本章？"
        message={`${label}的正文（${wordCount} 字）会被永久删除，无法恢复。`}
        confirmLabel="永久删除"
        destructive
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
