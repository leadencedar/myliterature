import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import {
  ImportJobSchema,
  type Category,
  type Chapter,
  type ImportChapterState,
  type ImportDraft,
  type ImportJob,
  type ImportWorldviewChunk,
  type Novel,
  type Proposal,
  type SideStory,
} from '@/domain/schema';
import { relevantGlossary, type GlossaryEntry } from '@/domain/glossary';
import { detectLanguage, needsTranslationToChinese } from '@/domain/language';
import { chapterLabel, chaptersOfTrack, sideStoryLabel } from '@/domain/sideStory';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { buildCreateProposal, buildReplaceProposal, newBatchId } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import { Button, IconButton } from '@/ui/Button';
import { RadioList } from '@/ui/Controls';
import { TextField } from '@/ui/Field';
import { ConfirmDialog } from '@/ui/Sheet';
import { BackIcon, ImportIcon, RefreshIcon, TrashIcon } from '@/ui/icons';
import { formatWordCount } from '@/ui/format';
import { ProposalInbox } from '../proposals/ProposalInbox';
import { mergeOpenThreads, resolveEntryNames } from '../writing/chapterSummary';
import {
  TRANSLATE_SOFT_LIMIT,
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
  parseTranslation,
  translatedTail,
} from '../writing/translate';
import {
  DestinationPicker,
  validateDestination,
  type DestinationChoice,
  type LineCounts,
} from './DestinationPicker';
import {
  ExtractResultSchema,
  accumulateEntryDrafts,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
  findMentionedEntries,
} from './extractSettings';
import {
  MANUSCRIPT_STYLE_SYSTEM,
  MIN_SAMPLE_LENGTH,
  ManuscriptStyleSchema,
  buildManuscriptStyleUserPrompt,
  sampleManuscript,
  toStylePayload,
} from './extractStyle';
import { resumeStepOf, type ResumeResult, type Step } from './importFlow';
import { buildEntryProposal } from './importProposals';
import { ACCEPTED_EXTENSIONS, ENCODING_LABELS, readManuscriptFile } from './readManuscript';
import {
  compileCustomPattern,
  mergeWithPrevious,
  removeChapter,
  renameChapter,
  splitChapters,
  summarizeSplit,
  type ChapterDraft,
  type SplitMode,
} from './splitChapters';
import { packWorldviewChunks } from './worldview';

const SPLIT_OPTIONS: { value: SplitMode; label: string; description: string }[] = [
  {
    value: 'auto',
    label: '自动识别章节标题',
    description: '认「第一章」「第十回」「楔子」「Chapter 3」这类独立成行的标题。',
  },
  {
    value: 'single',
    label: '整篇作为一章',
    description: '适合单章短篇，或想先粗略跑一遍看看效果。',
  },
  {
    value: 'custom',
    label: '自定义正则',
    description: '标题格式特殊时使用，按行匹配。例如 ^◇.+◇$',
  },
];

/** 面板加载时清掉了无法恢复的任务 */
const DISCARD_NOTICE = '上一次导入的进度无法恢复，已清掉；已写入的章节正文都在写作页里';

/** 写入目的地被拒、重读发现这批稿件已经不在了 */
const ABANDONED_ELSEWHERE_NOTICE = '这批稿件已经在别处放弃了，这次没有写入；需要的话重新粘贴导入';

/**
 * 刚跑完的这一轮导入到了哪里。
 *
 * finalize 会把任务删掉，收件箱与「上一批」提示不能再从 job 上读，所以单独记一份。
 * count 取 finalize 开头重读的任务的 chapters.length：分章页的本地 drafts 在刷新续跑后是空的。
 */
type FinishedDestination =
  | { kind: 'main'; count: number }
  | { kind: 'side'; sideStoryId: string; title: string; count: number }
  | { kind: 'worldview' };

/**
 * 草稿阶段的写入（patchImportDrafts）被拒。message 是仓储抛出的原始错误。
 *
 * 多数情况是另一处（新实例、另一个标签页）已经提交了目的地或放弃了这批稿件，
 * 库里的状态才是对的：调用方停下、重读任务，不显示错误。
 * 但配额满、事务中止也会走到这里，所以要靠 resumeAfterRejection 重读后区分（见那里）。
 */
class DraftsRejectedError extends Error {
  constructor(
    message: string,
    /** 写入前任务的 id：重读到的还是同一批草稿，就不是别处提交或放弃 */
    readonly jobId: string | null,
  ) {
    super(message);
  }
}

/** 草稿写入失败、任务仍是同一批草稿时的提示后半句（与分章页保存失败同一说法） */
const STORAGE_HINT = '浏览器存储可能已满，可以先导出备份。';

/** 按线算章数与下一章编号，给 picker 预告「从第几章接着编号」 */
function computeLineCounts(chapters: Chapter[], sideStories: SideStory[]): LineCounts {
  const line = (sideStoryId: string | null) => {
    const rows = chaptersOfTrack(chapters, sideStoryId);
    // 删过章的作品章号有缺口：编号接续用的是最大章号，不是章数
    return { count: rows.length, next: (rows[rows.length - 1]?.index ?? 0) + 1 };
  };
  return {
    main: line(null),
    perSide: new Map(sideStories.map((story) => [story.id, line(story.id)] as const)),
  };
}

/** 所选外传已不在列表里（在别处被删）时，picker 回退到「新建外传」、名称留空 */
function fallbackChoice(choice: DestinationChoice, sideStories: SideStory[]): DestinationChoice {
  if (choice.kind === 'side' && !sideStories.some((story) => story.id === choice.sideStoryId)) {
    return { kind: 'newSide', title: '' };
  }
  return choice;
}

/** 草稿是否外文（或已经译过）：按正文语种判断，「跳过」之后翻译步骤也不会从步骤条上消失 */
function isForeignDraft(draft: Pick<ImportDraft, 'content'> & { sourceContent?: string }): boolean {
  return (draft.sourceContent ?? '') !== '' || needsTranslationToChinese(draft.content);
}

/** 主按钮文案随目的地变化 */
function commitLabel(choice: DestinationChoice, count: number): string {
  if (choice.kind === 'main') return `写入主线 ${count} 章`;
  if (choice.kind === 'worldview') return '提取为世界观设定';
  return `写入外传 ${count} 章`;
}

interface ImportScreenProps {
  novel: Novel;
  categories: Category[];
  onClose: () => void;
}

/**
 * 旧稿导入与反向提取。
 *
 * 面向已经写了几十万字才开始用这个工具的作者：先把稿子切成章节，
 * 再逐章倒推出知识库条目与摘要链，补完之后才有可能接着往下写。
 *
 * 流程：粘贴 → 分章 →（有外文时）翻译 → 导入到 → 提取 → 确认。
 * 选定目的地之前，分章草稿和译文都存在 ImportJob.drafts 上，一章 Chapter 都不写；
 * 目的地在翻译之后选，是因为世界观设定也可能写成故事的形式，翻译之前没法判断。
 *
 * 做成覆盖全屏的面板而不是抽屉：要粘贴整本书、逐章核对切分结果，
 * 抽屉的高度上限在这里完全不够用。
 *
 * 进度落在 IndexedDB 的 ImportJob 里而不是组件状态里 —— 几十章的提取
 * 要跑上十几分钟，移动端切后台、来电、刷新都很常见，进度丢了就得重花一次钱。
 */
export function ImportScreen({ novel, categories, onClose }: ImportScreenProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const llm = useLlm();

  const [step, setStep] = useState<Step>('paste');
  const [loadingJob, setLoadingJob] = useState(true);

  const [text, setText] = useState('');
  const [mode, setMode] = useState<SplitMode>('auto');
  const [customPattern, setCustomPattern] = useState('');
  const [drafts, setDrafts] = useState<ChapterDraft[]>([]);
  const [finishedDestination, setFinishedDestination] = useState<FinishedDestination | null>(null);

  /** 已读入的文件名，按读入顺序 */
  const [sources, setSources] = useState<string[]>([]);
  const [fileNote, setFileNote] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 正在流式产出的译文，只用于让用户看见进展 */
  const [streamed, setStreamed] = useState('');
  /** 上一章译文的结尾，交给下一章接住语感 */
  const previousTailRef = useRef('');
  /** 进行中那一章翻译请求的中止器；每章新建，卸载时 abort，少付一章的钱 */
  const translateAbortRef = useRef<AbortController | null>(null);

  /**
   * 作品级译名表的本地副本。
   *
   * 权威副本在数据库里（`glossaries` 表），这里只是为了显示与注入 prompt。
   * 每次合并都以仓储的返回值为准回写，避免本地算一遍、库里算一遍。
   */
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const glossaryRef = useRef<GlossaryEntry[]>([]);

  const [job, setJob] = useState<ImportJob | null>(null);
  const [running, setRunning] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [note, setNote] = useState('');
  /** 需要用户知道、但不是错误的说明（role="note"） */
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  /** 目的地选择（picker 的值）。连着导下一批时预选上一批的目的地 */
  const [choice, setChoice] = useState<DestinationChoice>({ kind: 'main' });
  /**
   * 收尾时要不要顺带归纳这部作品的文风。默认值随目的地：主线勾上，外传不勾。
   * 用户手动改过之后（touched），切换目的地不再覆盖他的选择；连着导下一批时也保留。
   */
  const [withStyle, setWithStyle] = useState(true);
  const [withStyleTouched, setWithStyleTouched] = useState(false);
  /** 文风归纳被跳过的原因，为空表示没跳过 */
  const [styleSkipped, setStyleSkipped] = useState('');

  /**
   * 作品已有的外传与按线计数，只给 picker 和编号提示用。
   * 提取循环和收尾一律不读它：commit 之后同一个 handler 里立刻开跑时，这里还是旧列表。
   */
  const [sideStories, setSideStories] = useState<SideStory[]>([]);
  const [lineCounts, setLineCounts] = useState<LineCounts>({
    main: { count: 0, next: 1 },
    perSide: new Map(),
  });
  /** 上一轮导入的结果，只在连着导下一批时显示 */
  const [lastRound, setLastRound] = useState<FinishedDestination | null>(null);

  /**
   * 任务的权威副本。
   * 提取循环要在多次 await 之间读到最新进度，而 state 在同一轮事件循环里
   * 不会更新，靠 state 驱动循环会用到过期的章节列表。
   */
  const jobRef = useRef<ImportJob | null>(null);
  /** 翻译勾选还在写入中的章：index → 最近一次点击要的值（true 为要译） */
  const requestedTranslateRef = useRef(new Map<number, boolean>());
  const loopRef = useRef(false);
  const stopRef = useRef(false);
  const aliveRef = useRef(true);
  /**
   * 本任务所属外传（循环和事件 handler 用）。activeSideStory 是只用于渲染的同一份值，
   * 两者只经 rememberSideStory 一起写入。
   */
  const sideStoryRef = useRef<SideStory | null>(null);
  const [activeSideStory, setActiveSideStory] = useState<SideStory | null>(null);

  function rememberSideStory(story: SideStory | null) {
    sideStoryRef.current = story;
    if (aliveRef.current) setActiveSideStory(story);
  }

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // 卸载后不要再发起下一章：用户已经离开，继续烧 token 没有意义
      stopRef.current = true;
      // 进行中的那一章也中止掉；来不及中止的，写回也会经 patchImportDrafts 合并到最新行
      translateAbortRef.current?.abort();
    };
  }, []);

  /** 写入任务的权威副本；组件已卸载时只写 ref */
  function adoptJob(next: ImportJob | null) {
    jobRef.current = next;
    if (aliveRef.current) setJob(next);
  }

  /**
   * 重新加载章节与外传，重算按线计数。返回最新的外传列表，读不出来时为 null。
   * 时机只有：面板挂载、连着导下一批、commit 被拒之后。
   */
  async function reloadLines(): Promise<SideStory[] | null> {
    try {
      const [rows, stories] = await Promise.all([
        repository.listChapters(novel.id),
        repository.listSideStories(novel.id),
      ]);
      if (aliveRef.current) {
        setSideStories(stories);
        setLineCounts(computeLineCounts(rows, stories));
      }
      return stories;
    } catch {
      /* 只用于提示「接在第几章之后」，读不出来不该挡住整个面板 */
      return null;
    }
  }

  /**
   * 按 design 4.6 的加载规则恢复任务：safeParse + resumeStepOf。
   * 清掉或没有任务时回到粘贴步骤并返回 null；否则返回恢复出的任务。
   */
  async function resumeFrom(raw: ImportJob | undefined): Promise<ImportJob | null> {
    if (!raw) {
      adoptJob(null);
      rememberSideStory(null);
      if (aliveRef.current) setStep('paste');
      return null;
    }
    const parsed = ImportJobSchema.safeParse(raw);
    const result: ResumeResult = parsed.success ? resumeStepOf(parsed.data) : { discard: 'notice' };
    if ('discard' in result || !parsed.success) {
      try {
        await repository.deleteImportJob(novel.id);
      } catch {
        /* 删不掉也照常进粘贴步骤；残留的坏行会被下一次 saveImportDrafts 直接覆盖 */
      }
      adoptJob(null);
      rememberSideStory(null);
      if (!aliveRef.current) return null;
      if ('discard' in result && result.discard === 'notice') setNotice(DISCARD_NOTICE);
      setStep('paste');
      return null;
    }
    const restored = parsed.data;
    adoptJob(restored);
    if (restored.destination?.kind === 'side') {
      rememberSideStory((await repository.getSideStory(restored.destination.sideStoryId)) ?? null);
    } else {
      rememberSideStory(null);
    }
    if (aliveRef.current) setStep(result.step);
    return restored;
  }

  /**
   * 草稿写入被拒之后：重读任务、重新定步骤。组件已卸载时什么都不做。
   *
   * 返回 true 表示重读到的仍是写入前那一批草稿（`destination === null`、id 不变）：
   * 被拒的原因不是别处提交或放弃，而是存储本身写不进去（配额满、事务中止），
   * 调用方要显示 alert，否则付过钱的译文丢了界面上也看不出来。
   */
  async function resumeAfterRejection(rejected: DraftsRejectedError): Promise<boolean> {
    if (!aliveRef.current) return false;
    let raw: ImportJob | undefined;
    try {
      raw = await repository.getImportJob(novel.id);
    } catch {
      raw = undefined;
    }
    if (!aliveRef.current) return false;
    const restored = await resumeFrom(raw);
    return (
      aliveRef.current &&
      restored !== null &&
      restored.destination === null &&
      restored.id === rejected.jobId
    );
  }

  // 有未完成的任务就直接回到对应步骤，而不是让用户重新粘贴一遍
  useEffect(() => {
    let alive = true;
    void repository
      .getGlossary(novel.id)
      .then((row) => {
        if (!alive) return;
        // 第二批外文素材必须沿用第一批定下的译名，所以开工前先把已有的读进来
        glossaryRef.current = row?.terms ?? [];
        setGlossary(row?.terms ?? []);
      })
      .catch(() => {
        /* 译名表读不出来不该挡住整个面板，最坏情况是这一批重新定译名 */
      });

    void reloadLines();

    void repository
      .getImportJob(novel.id)
      .then(async (raw) => {
        if (!alive || !raw) return;
        await resumeFrom(raw);
      })
      .catch(() => {
        /* 读不出任务就留在粘贴步骤；真有别处的草稿，分章页提交时会被仓储挡下 */
      })
      .finally(() => {
        if (alive) setLoadingJob(false);
      });
    return () => {
      alive = false;
    };
    // 只在挂载与换作品时加载；reloadLines / resumeFrom 每次渲染都是新函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository, novel.id]);

  async function persistJob(patch: Partial<ImportJob>): Promise<ImportJob> {
    const saved = await repository.upsertImportJob(novel.id, patch);
    adoptJob(saved);
    return saved;
  }

  /** 草稿阶段的逐章修改一律经这里：合并到库里最新那一行，被拒时抛 DraftsRejectedError */
  async function patchDrafts(
    patches: Parameters<typeof repository.patchImportDrafts>[1],
  ): Promise<ImportJob> {
    const jobId = jobRef.current?.id ?? null;
    let saved: ImportJob;
    try {
      saved = await repository.patchImportDrafts(novel.id, patches);
    } catch (cause) {
      throw new DraftsRejectedError(cause instanceof Error ? cause.message : '写入被拒', jobId);
    }
    adoptJob(saved);
    return saved;
  }

  // ------------------------------------------------------------ 读入稿件文件

  /**
   * 读入一个稿件文件。
   *
   * **追加而不是覆盖**：不少作者是一章一个文件存的，而按文件名排序在中文里
   * 根本不可靠（「第十章」的字典序排在「第二章」前面）。与其自作聪明地排序、
   * 把一本书悄悄打乱，不如让用户按顺序一个个选，每次追加到末尾 ——
   * 顺序由他掌握，出错也看得见。
   */
  async function loadFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setFileNote('');
    try {
      const result = await readManuscriptFile(file);
      setText((previous) =>
        previous.trim() ? `${previous.trimEnd()}\n\n${result.text}` : result.text,
      );
      setSources((previous) => [...previous, file.name]);

      const notes = [`已读入《${file.name}》，识别为 ${ENCODING_LABELS[result.encoding]}`];
      if (result.lossy) {
        // 不因为几个坏字节拒绝整本书，但必须说清楚，否则用户会以为是自己当年写错了
        notes.push('其中少量字符无法识别，已用 � 占位，可以在下一步或正文里改掉');
      }
      setFileNote(`${notes.join('；')}。`);
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : '文件读取失败',
      });
    }
  }

  function clearText() {
    setText('');
    setSources([]);
    setFileNote('');
    setError(null);
  }

  /**
   * 跑完一轮后接着导下一批。
   *
   * 不必关掉面板再从「管理 → 导入旧稿」重新进一次 —— 一章一个文件、
   * 或者正文与番外分开存的作者，一次导入很少就够。
   *
   * 只重置**本轮**的临时状态。刻意保留这些：
   * - `glossary`：作品级译名表，第二批外文素材必须沿用第一批定下的译法；
   * - `mode` / `customPattern`：同一批素材的标题格式通常一致，重置等于让用户再选一遍；
   * - `withStyle`：用户上一轮的选择；
   * - 目的地：分批导入的稿子绝大多数是同一类素材接着导，所以预选上一批的目的地。
   *   上一批是「新建外传」的，此时已有 id，预选这部已有外传，免得再填一遍名字撞上重名。
   *
   * 上一批还没确认的提案不会丢 —— 它们已经落库，会出现在「知识库」页的待确认区。
   */
  function continueImport() {
    const finished = finishedDestination;
    setLastRound(finished);
    if (finished?.kind === 'main') setChoice({ kind: 'main' });
    else if (finished?.kind === 'worldview') setChoice({ kind: 'worldview' });
    else if (finished?.kind === 'side') {
      setChoice({ kind: 'side', sideStoryId: finished.sideStoryId });
    }
    setText('');
    setSources([]);
    setFileNote('');
    setDrafts([]);
    setStreamed('');
    previousTailRef.current = '';
    setNote('');
    setNotice('');
    setError(null);
    setStyleSkipped('');
    setBatchId(null);
    rememberSideStory(null);
    setStep('paste');
    // 上一批新建的外传要出现在下拉框里；中途被删的，预选回退到「新建」
    void reloadLines().then((stories) => {
      if (stories && aliveRef.current) setChoice((current) => fallbackChoice(current, stories));
    });
  }

  // ------------------------------------------------------------ 分章

  function recompute(nextMode: SplitMode, nextPattern: string) {
    setDrafts(splitChapters(text, { mode: nextMode, customPattern: nextPattern }));
  }

  function goToSplit() {
    setDrafts(splitChapters(text, { mode, customPattern }));
    setStep('split');
  }

  // ------------------------------------------------------------ 目的地

  function changeWithStyle(checked: boolean, touched: boolean) {
    setWithStyle(checked);
    if (touched) setWithStyleTouched(true);
  }

  /**
   * 分章确认：把草稿存进任务（saveImportDrafts）。
   *
   * 被拒（另一处已有一批稿件）时不覆盖：重读任务，落到那批稿件对应的步骤，
   * 并说明这次的分章结果没有保存 —— 不能悄悄丢掉。
   */
  async function createDraftJob(): Promise<boolean> {
    const payload: ImportDraft[] = drafts.map((draft) => ({
      index: draft.index,
      title: draft.title,
      content: draft.content,
      sourceContent: '',
      sourceLanguage: '',
      // 按章独立判定：导入的稿子常常部分章节外文、部分中文
      translateStatus: needsTranslationToChinese(draft.content) ? 'pending' : 'none',
      translateError: '',
    }));
    const expectedJobId = jobRef.current?.id ?? null;
    try {
      const saved = await repository.saveImportDrafts(novel.id, {
        // 批次号在建任务时就定下：逐章的摘要提案与最后的条目提案要进同一个收件箱
        batchId: newBatchId(),
        drafts: payload,
        expectedJobId,
      });
      adoptJob(saved);
      rememberSideStory(null);
      return true;
    } catch (cause) {
      let raw: ImportJob | undefined;
      try {
        raw = await repository.getImportJob(novel.id);
      } catch {
        raw = undefined;
      }
      const parsed = raw ? ImportJobSchema.safeParse(raw) : undefined;
      const other =
        parsed?.success && (parsed.data.destination !== null || parsed.data.id !== expectedJobId)
          ? parsed.data
          : null;
      if (other) {
        const restored = await resumeFrom(other);
        if (restored && aliveRef.current) {
          setNotice(
            `另一处已经有一批稿件在${
              restored.destination !== null ? '提取中' : '处理中'
            }，这次的分章结果没有保存；处理完那一批再导入`,
          );
        }
        return false;
      }
      if (aliveRef.current) {
        const message = cause instanceof Error ? cause.message : '未知错误';
        setError({
          message: `保存分章结果失败：${message}。浏览器存储可能已满，可以先导出备份。`,
        });
      }
      return false;
    }
  }

  /** 分章页主按钮：外文稿存草稿后去翻译；纯中文稿在同一个 handler 里紧接着写入目的地 */
  async function confirmSplit() {
    setError(null);
    setNotice('');
    setCommitting(true);
    try {
      if (!(await createDraftJob())) return;
      if (drafts.some((draft) => needsTranslationToChinese(draft.content))) {
        /**
         * 有外语章节：先去翻译步骤，**并且不自动开始**。
         *
         * 翻译是整个流程里唯一一次大规模输出 token 的操作，也是最贵的一步。
         * 提取可以自动跑（输入为主、单章几分钱），翻译必须让用户先看清
         * 要译哪几章、大概多少字，再自己按下开始。
         */
        setStep('translate');
        return;
      }
      // 纯中文稿的流程一步不多：第二步失败时草稿已经落盘，会落到目的地步骤，改选后重试即可
      await commitDestination();
    } finally {
      if (aliveRef.current) setCommitting(false);
    }
  }

  /**
   * 写入目的地：主线 / 外传走 commitImportChapters（一个事务写章节、推进任务），
   * 世界观走 commitImportWorldview（只改任务这一行，从头到尾不碰 Chapter 表）。
   *
   * 被拒时**不按错误类型或文案区分**：重读任务，库里已经写入过（另一个标签页或上一次点击）
   * 就直接进入提取步骤、不显示错误；否则留在目的地步骤显示 alert，并重新加载外传列表 ——
   * 所选外传在别处被删时 picker 回退到「新建外传」，免得对着不存在的选项反复重试。
   */
  async function commitDestination() {
    const current = jobRef.current;
    if (!current) return;
    setError(null);
    setCommitting(true);
    try {
      if (choice.kind === 'worldview') {
        const saved = await repository.commitImportWorldview(novel.id, {
          chunks: packWorldviewChunks(current.drafts),
        });
        adoptJob(saved);
        rememberSideStory(null);
      } else {
        const target =
          choice.kind === 'main'
            ? ({ kind: 'main' } as const)
            : choice.kind === 'side'
              ? ({ kind: 'side', sideStoryId: choice.sideStoryId } as const)
              : ({ kind: 'newSide', title: choice.title } as const);
        const { job: saved, sideStory } = await repository.commitImportChapters(novel.id, {
          target,
          withStyle,
        });
        adoptJob(saved);
        rememberSideStory(sideStory);
      }
      invalidate();
      if (!aliveRef.current) return;
      setStep('extract');
      startLoop();
    } catch (cause) {
      await handleCommitRejected(cause);
    } finally {
      if (aliveRef.current) setCommitting(false);
    }
  }

  async function handleCommitRejected(cause: unknown) {
    const message = cause instanceof Error ? cause.message : '写入失败';
    let latest: ImportJob | null = null;
    try {
      const raw = await repository.getImportJob(novel.id);
      const parsed = raw ? ImportJobSchema.safeParse(raw) : undefined;
      if (!parsed?.success) {
        // 任务已经不在（别处放弃了）或读出来是坏行：留在目的地步骤只会对着空列表、
        // 主按钮永远禁用。按加载规则回到粘贴步骤；坏行由 resumeFrom 清掉并说明
        if (!aliveRef.current) return;
        await resumeFrom(raw);
        if (!raw && aliveRef.current) setNotice(ABANDONED_ELSEWHERE_NOTICE);
        return;
      }
      latest = parsed.data;
    } catch {
      // 读取本身失败：不知道库里是什么状态，保留原来的做法，留在目的地步骤显示错误
      latest = null;
    }
    if (!aliveRef.current) return;
    if (latest && latest.destination !== null) {
      // 已经写入过：库里的状态才是对的，直接接着提取，不显示错误
      await resumeFrom(latest);
      invalidate();
      return;
    }
    if (latest) adoptJob(latest);
    setStep('destination');
    setError({ message });
    const stories = await reloadLines();
    if (stories && aliveRef.current)
      setChoice((currentChoice) => fallbackChoice(currentChoice, stories));
  }

  // ------------------------------------------------------------ 逐章翻译（草稿上）

  /**
   * 勾选 / 取消某一章的翻译。已经译完的不允许再改，避免重复付费（仓储层同样忽略）。
   *
   * 取反的依据是「最近一次点击想要的值」（requestedTranslateRef），不是 jobRef：
   * jobRef 要等写入返回才更新，连点两下时两次读到的都是旧值，第二下会丢。
   * 受控复选框的 event.target.checked 在这期间同样停在旧值上，也不能用。
   * 两次写入按发起顺序在 IndexedDB 里串行执行，最后落盘的就是最后一次点击的值。
   */
  async function toggleTranslate(index: number) {
    const draft = jobRef.current?.drafts.find((item) => item.index === index);
    if (!draft || draft.translateStatus === 'done') return;
    const requested = requestedTranslateRef.current;
    const wanted = !(requested.get(index) ?? draft.translateStatus !== 'none');
    requested.set(index, wanted);
    try {
      await patchDrafts([
        {
          index,
          patch: { translateStatus: wanted ? 'pending' : 'none', translateError: '' },
        },
      ]);
    } catch (cause) {
      requested.delete(index);
      if (!(cause instanceof DraftsRejectedError)) throw cause;
      if (await resumeAfterRejection(cause)) {
        setError({ message: `第 ${index} 章的翻译设置没存上：${cause.message}。${STORAGE_HINT}` });
      }
      return;
    }
    // 后面还有一次点击在写的话，留着它的值
    if (requested.get(index) === wanted) requested.delete(index);
  }

  async function translateOne(draft: ImportDraft): Promise<void> {
    const source = draft.content;
    setNote(`正在翻译第 ${draft.index} 章…`);
    setStreamed('');

    /**
     * 译文要和后续的中文续写读起来像同一本书，所以带上作品的风格档案。
     * 理论上建作品时就会建好它；真缺了就现建一份默认的，
     * 而不是在一个花钱的循环里抛错中断。
     */
    const style =
      (await repository.getStyleProfile(novel.id)) ??
      (await repository.upsertStyleProfile(novel.id, {}));

    const controller = new AbortController();
    translateAbortRef.current = controller;
    let streamedText = '';
    const result = await llm.runStream(
      'translate-chapter',
      {
        system: buildTranslateSystemPrompt(novel, style),
        user: buildTranslateUserPrompt({
          index: draft.index,
          title: draft.title,
          sourceText: source,
          // 只给本章用得上的译名，几百条全量注入既贵又稀释注意力
          glossary: relevantGlossary(glossaryRef.current, source),
          ...(previousTailRef.current ? { previousTranslatedTail: previousTailRef.current } : {}),
        }),
        signal: controller.signal,
      },
      {
        onText: (delta) => {
          streamedText += delta;
          if (aliveRef.current) setStreamed(streamedText);
        },
      },
    );

    /**
     * 撞上输出上限的半截译文照样能过 parseTranslation。标成已译的话，世界观提交时会清空
     * drafts、原文就此消失；写成章节也是一章没有任何提示的半截正文。所以当失败处理，不写回。
     */
    if (result.finishReason === 'length') {
      throw new LlmError('parse', '译文超出单次输出上限被截断了', {
        detail: '这一章太长，回到分章页把它切小一些再译',
      });
    }

    const parsed = parseTranslation(result.content || streamedText);
    if (!parsed.text.trim()) {
      throw new LlmError('parse', '模型没有返回译文');
    }

    // 译文是付了钱的，必须先落盘；原文存进 sourceContent，翻译不可逆，原句必须留得住
    await patchDrafts([
      {
        index: draft.index,
        patch: {
          content: parsed.text,
          sourceContent: source,
          sourceLanguage: detectLanguage(source),
          translateStatus: 'done',
          translateError: '',
        },
      },
    ]);
    previousTailRef.current = translatedTail(parsed.text);

    /**
     * 译名写回**作品级**译名表，不是写回导入任务。
     *
     * 任务跑完就会被删掉，译名存在那里等于下一批外文素材从零开始，
     * 同一个人名会换个译法。合并规则（先到先得）在仓储里执行。
     * 合并失败不算这一章失败：译文已经落盘了。
     */
    if (parsed.glossary.length > 0) {
      try {
        const saved = await repository.mergeGlossaryTerms(novel.id, parsed.glossary);
        glossaryRef.current = saved.terms;
        if (aliveRef.current) setGlossary(saved.terms);
        invalidate();
      } catch {
        if (aliveRef.current) setNotice('译名表没存上，下一章可能换个译法');
      }
    }

    if (aliveRef.current) setStreamed('');
  }

  async function markTranslate(
    index: number,
    status: ImportDraft['translateStatus'],
    message: string,
  ) {
    await patchDrafts([{ index, patch: { translateStatus: status, translateError: message } }]);
  }

  function startTranslateLoop() {
    void runTranslateLoop().catch((cause: unknown) => {
      if (!aliveRef.current) return;
      setRunning(false);
      setNote('');
      setStreamed('');
      setError({ message: cause instanceof Error ? cause.message : '翻译中断' });
    });
  }

  /** 刷新后上一章译文的结尾丢了：从下一个待译草稿之前、最近一个已译草稿里补回来 */
  function seedPreviousTail() {
    if (previousTailRef.current) return;
    const all = jobRef.current?.drafts ?? [];
    const next = all.find((item) => item.translateStatus === 'pending');
    if (!next) return;
    const previous = all
      .filter((item) => item.index < next.index && item.translateStatus === 'done')
      .sort((a, b) => b.index - a.index)[0];
    if (previous) previousTailRef.current = translatedTail(previous.content);
  }

  async function runTranslateLoop() {
    if (loopRef.current) return;
    loopRef.current = true;
    stopRef.current = false;
    setRunning(true);
    setError(null);

    try {
      seedPreviousTail();
      for (;;) {
        if (stopRef.current) break;
        const next = jobRef.current?.drafts.find((item) => item.translateStatus === 'pending');
        if (!next) break;
        try {
          await translateOne(next);
        } catch (cause) {
          // 已卸载（含 abort 掉的请求）：不标失败，这一章在库里仍是 pending，下次打开接着译
          if (!aliveRef.current) return;
          if (cause instanceof DraftsRejectedError) {
            // translateOne 里唯一的草稿写入就是译文写回：这一章在库里仍是待译
            stopRef.current = true;
            if (await resumeAfterRejection(cause)) {
              setError({
                message: `第 ${next.index} 章的译文没存上：${cause.message}。${STORAGE_HINT}`,
              });
            }
            break;
          }
          const llmError = cause instanceof LlmError ? cause : undefined;
          const message =
            llmError?.message ?? (cause instanceof Error ? cause.message : '翻译失败');
          try {
            await markTranslate(next.index, 'failed', message);
          } catch (markCause) {
            if (!(markCause instanceof DraftsRejectedError)) throw markCause;
            stopRef.current = true;
            if (await resumeAfterRejection(markCause)) {
              setError({
                message: `第 ${next.index} 章翻译失败：${message}；失败状态也没存上：${markCause.message}。${STORAGE_HINT}`,
                ...(llmError?.detail ? { detail: llmError.detail } : {}),
              });
            }
            break;
          }
          if (aliveRef.current) {
            setError({
              message: `第 ${next.index} 章翻译失败：${message}`,
              ...(llmError?.detail ? { detail: llmError.detail } : {}),
            });
          }
          // 与提取同理：一章失败多半是 Key、余额或网络，继续只会把错误重复几十遍
          break;
        }
      }
    } finally {
      loopRef.current = false;
      translateAbortRef.current = null;
      if (aliveRef.current) {
        setRunning(false);
        setNote('');
        setStreamed('');
      }
    }
  }

  async function retryTranslate(index: number) {
    try {
      await markTranslate(index, 'pending', '');
    } catch (cause) {
      if (cause instanceof DraftsRejectedError) {
        if (await resumeAfterRejection(cause)) {
          setError({
            message: `第 ${index} 章没能重新排进待译：${cause.message}。${STORAGE_HINT}`,
          });
        }
        return;
      }
      throw cause;
    }
    startTranslateLoop();
  }

  /**
   * 翻译之后选目的地。还没译的（待译与失败的）一并改成「不译」，按原文写入或提取，
   * 用一次 patch 落盘：刷新后会落在目的地步骤，不会被弹回翻译步骤。
   */
  async function goToDestination() {
    stopRef.current = true;
    setError(null);
    const patches = (jobRef.current?.drafts ?? [])
      .filter((item) => item.translateStatus === 'pending' || item.translateStatus === 'failed')
      .map((item) => ({
        index: item.index,
        patch: { translateStatus: 'none' as const, translateError: '' },
      }));
    if (patches.length > 0) {
      try {
        await patchDrafts(patches);
      } catch (cause) {
        if (cause instanceof DraftsRejectedError) {
          if (await resumeAfterRejection(cause)) {
            setError({ message: `跳过剩下的章节没存上：${cause.message}。${STORAGE_HINT}` });
          }
          return;
        }
        throw cause;
      }
    }
    if (aliveRef.current) setStep('destination');
  }

  // ------------------------------------------------------------ 逐章提取

  /** 循环与事件 handler 用的章节标签：「第 3 章」/「外传·X 第 3 章」 */
  function labelOf(index: number): string {
    const destination = jobRef.current?.destination;
    if (destination?.kind !== 'side') return `第 ${index} 章`;
    const story = sideStoryRef.current;
    return chapterLabel({ sideStoryId: destination.sideStoryId, index }, story ? [story] : []);
  }

  async function extractOne(state: ImportChapterState): Promise<void> {
    const chapter = await repository.getChapter(state.chapterId);
    if (!chapter) {
      // 抛出而不是标失败后返回：runLoop 只在抛错时停，否则会把后面每一章都静默标成失败
      throw new Error('章节已不存在，可能已被删除');
    }

    const destination = jobRef.current?.destination;
    // 每章都重读条目：用户可能在提取途中就确认了前几章的提案。
    // 外传也每章重读：用户可能在提取途中到写作页改了外传名或简介。
    // 规范同理：作者在提取途中改了规范，下一章就按新规范；没改时前缀不变，缓存照常命中
    const [entries, story, norms] = await Promise.all([
      repository.listEntries(novel.id),
      destination?.kind === 'side'
        ? repository.getSideStory(destination.sideStoryId)
        : Promise.resolve(undefined),
      repository.listWritingNorms(novel.id),
    ]);
    if (destination?.kind === 'side') {
      if (!story) throw new Error('这部外传已不存在，可能已被删除');
      rememberSideStory(story);
    }
    const label = story ? chapterLabel(chapter, [story]) : `第 ${state.index} 章`;

    const mentioned = findMentionedEntries(chapter.content, entries);
    const mentionedIds = new Set(mentioned.map((entry) => entry.id));
    const current = jobRef.current;

    setNote(`正在提取${label}…`);

    const result = await llm.runStructured('extract-settings', {
      schema: ExtractResultSchema,
      schemaName: 'ChapterExtraction',
      system: buildExtractSystemPrompt(novel, categories, norms),
      user: buildExtractUserPrompt({
        chapter,
        mentionedEntries: mentioned,
        categories,
        otherEntryNames: entries
          .filter((entry) => !mentionedIds.has(entry.id))
          .map((entry) => entry.title),
        openThreads: current?.openThreads ?? [],
        // 链的起点已在 commit 时按线写进任务；不回落到主线进展，外传任务那样会串线
        rollingSummary: current?.rollingSummary ?? '',
        ...(story ? { sideStory: { title: story.title, synopsis: story.synopsis } } : {}),
      }),
      onAttempt: ({ repairing }) =>
        setNote(repairing ? `${label}的输出格式有偏差，正在请模型修正…` : `正在提取${label}…`),
    });

    const latest = jobRef.current;
    const openThreads = mergeOpenThreads(
      latest?.openThreads ?? [],
      result.data.resolvedThreads,
      result.data.newOpenThreads,
    );

    /**
     * 摘要提案逐章即时创建 —— 它是「这一章」的产物，攒到最后反而看不出对应关系。
     * 条目草稿相反，先累计进任务，跑完再一次性 materialize。
     */
    if (latest?.withSummaries !== false) {
      await repository.createProposals([
        buildCreateProposal({
          novelId: novel.id,
          batchId: latest?.batchId || null,
          order: state.index,
          origin: 'extract',
          target: 'chapterSummary',
          label: `${label}摘要`,
          specs: fieldSpecsFor('chapterSummary'),
          sourceRef: label,
          payload: {
            chapterId: chapter.id,
            summary: result.data.summary,
            keyEvents: result.data.keyEvents,
            // 只能解析出已在库里的条目；本次新提取的条目还没有 id
            appearingEntryIds: resolveEntryNames(entries, result.data.appearingEntries),
            openThreads,
          },
        }),
      ]);
    }

    const chapters = (jobRef.current?.chapters ?? []).map((item) =>
      item.chapterId === state.chapterId ? { ...item, status: 'done' as const, error: '' } : item,
    );

    await persistJob({
      chapters,
      entryDrafts: accumulateEntryDrafts(
        jobRef.current?.entryDrafts ?? [],
        result.data.entries,
        categories,
        chapter.id,
      ),
      openThreads,
      rollingSummary: result.data.rollingSummary,
    });
    invalidate();
  }

  async function markChapter(
    chapterId: string,
    status: ImportChapterState['status'],
    message: string,
  ) {
    const chapters = (jobRef.current?.chapters ?? []).map((item) =>
      item.chapterId === chapterId ? { ...item, status, error: message } : item,
    );
    await persistJob({ chapters });
  }

  // ------------------------------------------------------------ 世界观逐段提取

  /**
   * 提取一段设定文本。
   *
   * 复用章节提取的同一个任务与输出 schema，只是正文块标成「设定文本」，
   * 也不带伏笔与全书进展 —— 设定不是故事的一部分。模型照 schema 仍会给出
   * summary / rollingSummary 等字段，这里直接丢弃，只累计条目草稿。
   */
  async function extractWorldviewChunk(chunk: ImportWorldviewChunk): Promise<void> {
    const total = jobRef.current?.worldviewChunks.length ?? 1;
    // 段标题来自分章结果；没有标题（整篇作为一章、旧版任务）时与原来的标签逐字一致
    const sourceLabel = chunk.title
      ? `世界观设定 · ${chunk.title}`
      : total > 1
        ? `世界观设定 第 ${chunk.index}/${total} 段`
        : '世界观设定';

    // 每段都重读条目：前一段刚提出的同名条目可能已经被用户确认入库；规范同样每段重读，理由同逐章提取
    const [entries, norms] = await Promise.all([
      repository.listEntries(novel.id),
      repository.listWritingNorms(novel.id),
    ]);
    const mentioned = findMentionedEntries(chunk.content, entries);
    const mentionedIds = new Set(mentioned.map((entry) => entry.id));

    setNote(`正在从设定文本中提取第 ${chunk.index} / ${total} 段…`);

    const result = await llm.runStructured('extract-settings', {
      schema: ExtractResultSchema,
      schemaName: 'ChapterExtraction',
      system: buildExtractSystemPrompt(novel, categories, norms),
      user: buildExtractUserPrompt({
        // 仅在内存里的章节形状对象，不落库
        chapter: { index: chunk.index, title: '', content: chunk.content },
        sourceLabel,
        mentionedEntries: mentioned,
        categories,
        otherEntryNames: entries
          .filter((entry) => !mentionedIds.has(entry.id))
          .map((entry) => entry.title),
        openThreads: [],
        rollingSummary: '',
      }),
      onAttempt: ({ repairing }) =>
        setNote(
          repairing
            ? `第 ${chunk.index} 段的输出格式有偏差，正在请模型修正…`
            : `正在从设定文本中提取第 ${chunk.index} / ${total} 段…`,
        ),
    });

    const worldviewChunks = (jobRef.current?.worldviewChunks ?? []).map((item) =>
      item.index === chunk.index ? { ...item, status: 'done' as const, error: '' } : item,
    );
    await persistJob({
      worldviewChunks,
      // 来源不是章节，不记溯源章节 id
      entryDrafts: accumulateEntryDrafts(
        jobRef.current?.entryDrafts ?? [],
        result.data.entries,
        categories,
        null,
      ),
    });
  }

  async function markChunk(index: number, status: ImportWorldviewChunk['status'], message: string) {
    const worldviewChunks = (jobRef.current?.worldviewChunks ?? []).map((item) =>
      item.index === index ? { ...item, status, error: message } : item,
    );
    await persistJob({ worldviewChunks });
  }

  async function retryChunk(index: number) {
    await markChunk(index, 'pending', '');
    startLoop();
  }

  /**
   * 启动提取循环。
   *
   * 循环是「发出去就不管」的后台任务，必须自己兜住异常 —— 否则库被关掉、
   * 页面被卸载这类收尾期的失败会变成无人接管的 rejection。
   */
  function startLoop() {
    void runLoop().catch((cause: unknown) => {
      if (!aliveRef.current) return;
      setRunning(false);
      setNote('');
      setError({ message: cause instanceof Error ? cause.message : '提取中断' });
    });
  }

  async function runLoop() {
    if (loopRef.current) return;
    loopRef.current = true;
    stopRef.current = false;
    setRunning(true);
    setError(null);
    await persistJob({ status: 'running' });

    try {
      for (;;) {
        if (stopRef.current) break;
        if (jobRef.current?.destination?.kind === 'worldview') {
          const chunk = (jobRef.current.worldviewChunks ?? []).find(
            (item) => item.status === 'pending',
          );
          if (!chunk) break;
          try {
            await extractWorldviewChunk(chunk);
          } catch (cause) {
            const llmError = cause instanceof LlmError ? cause : undefined;
            const message =
              llmError?.message ?? (cause instanceof Error ? cause.message : '提取失败');
            await markChunk(chunk.index, 'failed', message);
            if (aliveRef.current) {
              setError({
                message: `第 ${chunk.index} 段提取失败：${message}`,
                ...(llmError?.detail ? { detail: llmError.detail } : {}),
              });
            }
            break;
          }
          continue;
        }
        const next = jobRef.current?.chapters.find((item) => item.status === 'pending');
        if (!next) break;
        try {
          await extractOne(next);
        } catch (cause) {
          const llmError = cause instanceof LlmError ? cause : undefined;
          const message =
            llmError?.message ?? (cause instanceof Error ? cause.message : '提取失败');
          await markChapter(next.chapterId, 'failed', message);
          if (aliveRef.current) {
            setError({
              message: `${labelOf(next.index)}提取失败：${message}`,
              ...(llmError?.detail ? { detail: llmError.detail } : {}),
            });
          }
          // 一章失败往往是 Key、余额或网络的问题，继续跑只会把错误重复几十遍
          break;
        }
      }
    } finally {
      loopRef.current = false;
      if (aliveRef.current) {
        setRunning(false);
        setNote('');
      }
      await persistJob({ status: 'paused' });
    }

    const remaining: { status: string }[] =
      jobRef.current?.destination?.kind === 'worldview'
        ? (jobRef.current.worldviewChunks ?? [])
        : (jobRef.current?.chapters ?? []);
    const allSettled = remaining.every((item) => item.status === 'done');
    if (allSettled && remaining.length > 0 && aliveRef.current) {
      await finalize();
    }
  }

  function pause() {
    stopRef.current = true;
    setNote(
      jobRef.current?.destination?.kind === 'worldview'
        ? '正在停在本段结束处…'
        : '正在停在本章结束处…',
    );
  }

  async function retry(chapterId: string) {
    await markChapter(chapterId, 'pending', '');
    startLoop();
  }

  // ------------------------------------------------------------ 收尾：文风归纳

  /**
   * 从这次导入的稿件归纳文风，产出一条待确认的风格档案提案。
   *
   * 放在收尾而不是单开一个步骤，有三个理由：
   * - 取样必须在翻译**之后**，否则归纳出的是英文的句式节奏；
   * - 提取刻意不带文风，所以风格档案落在它后面对提取没有任何影响；
   * - 共用同一个 batchId，用户在一个收件箱里连着确认，而不是多一道关卡。
   *
   * 返回 null 表示这次不产出（关掉了、模型没配、样本不够、或者调用失败）。
   * **失败绝不能带崩 finalize** —— 条目提案是十几分钟提取的成果，
   * 不能因为一次附带的风格调用出错就丢掉。
   */
  async function buildStyleProposal(
    current: ImportJob,
    batch: string,
    order: number,
  ): Promise<Proposal | null> {
    if (current.withStyle === false) return null;
    if (!llm.configured) {
      setStyleSkipped('没有配置模型，这次没有归纳文风。可以到「知识库 → 风格档案」手动设置。');
      return null;
    }

    // 只取本批导入的章节，不会混入主线或别的外传
    const imported = new Set(current.chapters.map((item) => item.chapterId));
    const all = await repository.listChapters(novel.id);
    const mine = all
      .filter((chapter) => imported.has(chapter.id))
      .sort((a, b) => a.index - b.index);

    const sample = sampleManuscript(mine);
    if (sample.trim().length < MIN_SAMPLE_LENGTH) {
      setStyleSkipped('稿件篇幅太短，归纳不出可靠的文风，这次跳过了。');
      return null;
    }

    setNote('正在归纳这部作品的文风…');
    try {
      const result = await llm.runStructured('style-sample', {
        schema: ManuscriptStyleSchema,
        schemaName: 'ManuscriptStyle',
        system: MANUSCRIPT_STYLE_SYSTEM,
        user: buildManuscriptStyleUserPrompt(sample),
      });

      const style = await repository.getStyleProfile(novel.id);
      return buildReplaceProposal({
        novelId: novel.id,
        batchId: batch,
        order,
        origin: 'extract',
        target: 'styleProfile',
        label: '文风与文体',
        specs: fieldSpecsFor('styleProfile'),
        sourceRef: `导入 ${current.chapters.length} 章`,
        targetId: novel.id,
        current: style
          ? {
              tradition: style.tradition,
              subGenre: style.subGenre,
              customRubric: style.customRubric,
            }
          : undefined,
        payload: toStylePayload(result.data),
      });
    } catch (cause) {
      setStyleSkipped(
        `文风归纳失败：${cause instanceof Error ? cause.message : '未知错误'}。其余内容不受影响，可以到「知识库 → 风格档案」手动设置。`,
      );
      return null;
    }
  }

  // ------------------------------------------------------------ 收尾：条目提案

  async function finalize() {
    if (!jobRef.current) return;
    setNote('正在整理提取到的人物与设定…');

    try {
      // 开头重读任务：jobRef 是本实例的副本，库里的才是最新的
      let current = jobRef.current;
      const raw = await repository.getImportJob(novel.id);
      const parsed = raw ? ImportJobSchema.safeParse(raw) : undefined;
      if (parsed?.success) current = parsed.data;

      const destination = current.destination;
      if (destination?.kind === 'worldview') {
        await finalizeWorldview(current);
        return;
      }

      // 外传同样重读：标题进提案的 sourceRef 与「上一批」提示，进展摘要用来比较
      let story: SideStory | null = null;
      if (destination?.kind === 'side') {
        story = (await repository.getSideStory(destination.sideStoryId)) ?? null;
        rememberSideStory(story);
      }

      const batch = current.batchId || newBatchId();
      const chapterIndexById = new Map(
        current.chapters.map((item) => [item.chapterId, item.index] as const),
      );
      const proposals: Proposal[] = [];
      // 摘要提案用章节序号做 order，条目提案排在它们之后
      const orderBase = current.chapters.length + 1;
      const sourcePrefix =
        destination?.kind === 'side' ? (story ? sideStoryLabel(story) : '外传') : undefined;

      for (const [position, draft] of current.entryDrafts.entries()) {
        const proposal = await buildEntryProposal({
          draft,
          novelId: novel.id,
          batch,
          order: orderBase + position,
          categories,
          chapterIndexById,
          ...(sourcePrefix ? { sourcePrefix } : {}),
          findExisting: (name) => repository.findEntryByName(novel.id, name),
        });
        if (proposal) proposals.push(proposal);
      }

      const progress = current.rollingSummary.trim();
      if (destination?.kind === 'side') {
        /**
         * 外传的进展写进外传自己，主线的 rollingSummary 一个字都不碰。
         * 外传已经被删时跳过这条：提案落库会失败，留着只会让用户困惑。
         */
        if (story && progress && progress !== story.rollingSummary.trim()) {
          proposals.push(
            buildReplaceProposal({
              novelId: novel.id,
              batchId: batch,
              order: orderBase + proposals.length,
              origin: 'extract',
              target: 'sideStory',
              label: '外传进展摘要',
              specs: fieldSpecsFor('sideStory'),
              sourceRef: `${sideStoryLabel(story)} 导入 ${current.chapters.length} 章`,
              targetId: story.id,
              current: { rollingSummary: story.rollingSummary },
              payload: { rollingSummary: current.rollingSummary },
            }),
          );
        }
      } else if (progress && progress !== novel.rollingSummary.trim()) {
        proposals.push(
          buildReplaceProposal({
            novelId: novel.id,
            batchId: batch,
            order: orderBase + proposals.length,
            origin: 'extract',
            target: 'novel',
            label: '全书进展摘要',
            specs: fieldSpecsFor('novel'),
            sourceRef: `导入 ${current.chapters.length} 章`,
            targetId: novel.id,
            current: { rollingSummary: novel.rollingSummary },
            payload: { rollingSummary: current.rollingSummary },
          }),
        );
      }

      const styleProposal = await buildStyleProposal(current, batch, orderBase + proposals.length);
      if (styleProposal) proposals.push(styleProposal);

      if (proposals.length > 0) await repository.createProposals(proposals);

      // 任务的使命（断点续跑）到此结束；提案已经落库，不再需要它
      await repository.deleteImportJob(novel.id);
      jobRef.current = null;
      invalidate();

      if (!aliveRef.current) return;
      const count = current.chapters.length;
      setFinishedDestination(
        destination?.kind === 'side'
          ? { kind: 'side', sideStoryId: destination.sideStoryId, title: story?.title ?? '', count }
          : { kind: 'main', count },
      );
      setJob(null);
      setBatchId(batch);
      setNote('');
      setStep('inbox');
    } catch (cause) {
      if (!aliveRef.current) return;
      setError({ message: cause instanceof Error ? cause.message : '整理提案失败' });
      setNote('');
    }
  }

  /**
   * 世界观导入的收尾：只把条目草稿 materialize 成提案。
   *
   * 不出章节摘要、不出全书进展、不归纳文风 —— 设定文本不是故事正文，
   * 拿它更新进展摘要或归纳文风都会把作品档案带偏。
   */
  async function finalizeWorldview(current: ImportJob) {
    const batch = current.batchId || newBatchId();
    const proposals: Proposal[] = [];
    for (const [position, draft] of current.entryDrafts.entries()) {
      const proposal = await buildEntryProposal({
        draft,
        novelId: novel.id,
        batch,
        order: position,
        categories,
        chapterIndexById: new Map(),
        fallbackSourceRef: '世界观设定导入',
        findExisting: (name) => repository.findEntryByName(novel.id, name),
      });
      if (proposal) proposals.push(proposal);
    }
    if (proposals.length > 0) await repository.createProposals(proposals);

    await repository.deleteImportJob(novel.id);
    jobRef.current = null;
    invalidate();

    if (!aliveRef.current) return;
    setFinishedDestination({ kind: 'worldview' });
    setJob(null);
    setBatchId(batch);
    setNote('');
    setStep('inbox');
  }

  async function abandon() {
    stopRef.current = true;
    await repository.deleteImportJob(novel.id);
    jobRef.current = null;
    rememberSideStory(null);
    invalidate();
    setConfirmAbandon(false);
    onClose();
  }

  // ------------------------------------------------------------ 渲染

  const splitSummary = summarizeSplit(drafts);
  const patternInvalid =
    mode === 'custom' &&
    customPattern.trim().length > 0 &&
    compileCustomPattern(customPattern) === undefined;
  /** 分章页的本地草稿里要翻译的章数；为 0 时目的地直接在分章页选 */
  const splitForeignCount = drafts.filter((draft) =>
    needsTranslationToChinese(draft.content),
  ).length;

  const jobDrafts = job?.drafts ?? [];
  /** 有任务时按任务上的草稿算，没有任务时按分章页的本地草稿算 */
  const hasForeign = job ? jobDrafts.some(isForeignDraft) : splitForeignCount > 0;

  const destination = job?.destination ?? null;
  const chapters = job?.chapters ?? [];
  const doneCount = chapters.filter((item) => item.status === 'done').length;
  const failedCount = chapters.filter((item) => item.status === 'failed').length;
  const pendingCount = chapters.filter((item) => item.status === 'pending').length;

  /** 参与翻译的章节：待译 + 已译 + 失败，不含用户取消勾选的 */
  const translateTargets = jobDrafts.filter((item) => item.translateStatus !== 'none');
  const translatePending = jobDrafts.filter((item) => item.translateStatus === 'pending');
  const translateDone = jobDrafts.filter((item) => item.translateStatus === 'done');
  const translateFailed = jobDrafts.filter((item) => item.translateStatus === 'failed');

  const worldviewJob = destination?.kind === 'worldview';
  const worldviewChunks = worldviewJob ? (job?.worldviewChunks ?? []) : [];
  const chunkDone = worldviewChunks.filter((item) => item.status === 'done').length;
  const chunkFailed = worldviewChunks.filter((item) => item.status === 'failed').length;
  const chunkPending = worldviewChunks.filter((item) => item.status === 'pending').length;

  /** 旧版章节任务：直接在 Chapter 上翻译的进度没法续跑，只能按原文提取 */
  const legacyUntranslated =
    destination?.kind === 'main' || destination?.kind === 'side'
      ? chapters.filter(
          (item) => item.translateStatus === 'pending' || item.translateStatus === 'failed',
        ).length
      : 0;

  const validity = validateDestination(choice, sideStories, llm.configured);
  const jobSideStoryId = destination?.kind === 'side' ? destination.sideStoryId : null;
  const labelStories = activeSideStory ? [activeSideStory] : [];

  let abandonMessage: string;
  if (!job || job.destination === null) {
    const translated = translateDone.length;
    abandonMessage =
      translated > 0
        ? `分章结果和已经译好的 ${translated} 章译文会被清空，需要重新粘贴；译名表保存在作品上，不受影响。还没有写入任何章节。`
        : '分章结果会被清空，需要重新粘贴；译名表保存在作品上，不受影响。还没有写入任何章节。';
  } else if (job.destination.kind === 'worldview') {
    abandonMessage = '已经提取的进度会被清空，下次要重新粘贴设定文本。';
  } else {
    abandonMessage =
      '已经提取的进度会被清空，下次要从第一章重新跑。已经写入的章节正文会保留，不会被删除。';
  }

  const stepItems: (readonly [Step, string])[] = [
    ['paste', '粘贴'],
    ['split', '分章'],
    // 纯中文稿看不到这两步，流程一步不多
    ...(hasForeign ? [['translate', '翻译'] as const] : []),
    // 纯中文稿在分章页提交失败、刷新后会恢复到目的地步骤：当前步骤在步骤条上要始终看得见
    ...(hasForeign || step === 'destination' ? [['destination', '导入到'] as const] : []),
    ['extract', '提取'],
    ['inbox', '确认'],
  ];

  const picker = (
    <DestinationPicker
      value={choice}
      onChange={setChoice}
      sideStories={sideStories}
      lineCounts={lineCounts}
      withStyle={withStyle}
      withStyleTouched={withStyleTouched}
      onWithStyleChange={changeWithStyle}
      llmConfigured={llm.configured}
    />
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="导入旧稿"
      className="fixed inset-0 z-50 flex flex-col bg-paper"
    >
      <header className="safe-top shrink-0 border-b border-ink-100 bg-paper/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-1 px-2 py-2">
          <IconButton label="返回" onClick={onClose}>
            <BackIcon className="h-6 w-6" />
          </IconButton>
          <h2 className="min-w-0 flex-1 truncate px-1 font-medium text-ink-900">导入旧稿</h2>
          {step === 'translate' || step === 'destination' || step === 'extract' ? (
            <IconButton label="放弃这次导入" onClick={() => setConfirmAbandon(true)}>
              <TrashIcon className="h-5 w-5" />
            </IconButton>
          ) : null}
        </div>
        <ol className="mx-auto flex w-full max-w-4xl gap-1 px-3 pb-2 text-[0.6875rem] text-ink-500 lg:text-xs">
          {stepItems.map(([key, label], position) => (
            <li
              key={key}
              aria-current={step === key ? 'step' : undefined}
              className={step === key ? 'font-medium text-ink-900' : undefined}
            >
              {position > 0 ? <span className="mr-1 text-ink-300">›</span> : null}
              {label}
            </li>
          ))}
        </ol>
      </header>

      {/* 居中限宽：粘贴整本书的文本框铺满 1920px 会宽到没法校对 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-4 lg:px-6 lg:py-6">
          {loadingJob ? <p className="py-10 text-center text-sm text-ink-300">加载中…</p> : null}

          {!loadingJob && notice ? (
            <p
              role="note"
              className="mb-3 rounded-xl bg-paper-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-700"
            >
              {notice}
            </p>
          ) : null}

          {!loadingJob && step === 'paste' ? (
            <div className="flex flex-col gap-3">
              {lastRound ? (
                <p
                  aria-live="polite"
                  className="rounded-xl bg-emerald-50 px-3 py-2.5 text-sm leading-relaxed text-emerald-700"
                >
                  {lastRound.kind === 'worldview' ? (
                    <>上一份设定已经处理完。接着导下一批吧 —— 已有设定会沿用，同名条目会走合并。</>
                  ) : lastRound.kind === 'side' ? (
                    `上一批 ${lastRound.count} 章${
                      lastRound.title ? `外传·${lastRound.title} ` : '外传'
                    }已经处理完。接着导下一批吧 —— 译名表和已有设定都会沿用。`
                  ) : (
                    <>
                      上一批 {lastRound.count} 章已经处理完。接着导下一批吧 ——
                      译名表和已有设定都会沿用，同一个人物不会被重复建条目。
                    </>
                  )}
                </p>
              ) : null}

              <p className="text-sm leading-relaxed text-ink-500">
                上传稿件文件，或把文字整段贴进来。下一步会切成章节供你核对，确认后才会写入作品。
              </p>

              {/* 上传区。几十万字靠剪贴板粘贴在手机上根本做不到，文件才是主路径 */}
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  void loadFile(event.dataTransfer.files[0]);
                }}
                className={[
                  'flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-5 text-center transition-colors',
                  dragging ? 'border-seal bg-seal-soft' : 'border-ink-100 bg-paper-raised',
                ].join(' ')}
              >
                <Button variant="secondary" size="lg" onClick={() => fileInputRef.current?.click()}>
                  <ImportIcon className="h-5 w-5" />
                  选择稿件文件
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_EXTENSIONS.join(',')}
                  aria-label="稿件文件"
                  className="sr-only"
                  onChange={(event) => {
                    void loadFile(event.target.files?.[0]);
                    // 清空 value，否则连续选同一个文件不会再触发 change
                    event.target.value = '';
                  }}
                />
                <p className="text-xs leading-relaxed text-ink-500">
                  支持 .txt 与 .md，自动识别 UTF-8 与 GB18030 编码
                  <span className="hidden lg:inline"> · 也可以直接把文件拖进来</span>
                </p>
                <p className="text-xs leading-relaxed text-ink-300">
                  一章一个文件的话，按顺序一个个选，会依次接在后面
                </p>
              </div>

              {sources.length > 0 ? (
                <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
                  <p className="text-xs font-medium text-ink-700">已读入 {sources.length} 个文件</p>
                  <ol className="mt-1 flex flex-col gap-0.5">
                    {sources.map((name, position) => (
                      <li key={`${name}-${position}`} className="truncate text-xs text-ink-500">
                        {position + 1}. {name}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {fileNote ? (
                <p aria-live="polite" className="text-xs leading-relaxed text-ink-700">
                  {fileNote}
                </p>
              ) : null}

              <textarea
                value={text}
                aria-label="旧稿正文"
                placeholder="也可以在此直接粘贴全文…"
                onChange={(event) => setText(event.target.value)}
                className="min-h-[36dvh] w-full resize-none lg:min-h-[32dvh] rounded-xl border border-ink-100 bg-paper-raised px-3 py-3 font-reading text-[0.9375rem] leading-[1.9] text-ink-900 placeholder:text-ink-300 focus:border-ink-500 focus:outline-none"
              />

              <div className="flex items-center gap-3">
                <p className="text-xs text-ink-500">共 {text.trim().length} 字</p>
                {text ? (
                  <Button size="sm" variant="ghost" onClick={clearText}>
                    清空重来
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {!loadingJob && step === 'split' ? (
            <div className="flex flex-col gap-4">
              <RadioList
                label="分章方式"
                value={mode}
                options={SPLIT_OPTIONS}
                onChange={(next) => {
                  setMode(next);
                  recompute(next, customPattern);
                }}
              />

              {mode === 'custom' ? (
                <div className="flex flex-col gap-2">
                  <TextField
                    label="标题正则"
                    value={customPattern}
                    placeholder="^第.+节$"
                    hint="按行匹配，不需要写首尾斜杠。"
                    {...(patternInvalid ? { error: '这个正则无法使用，请检查写法' } : {})}
                    onChange={(event) => setCustomPattern(event.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="lg"
                    block
                    disabled={patternInvalid}
                    onClick={() => recompute('custom', customPattern)}
                  >
                    <RefreshIcon className="h-5 w-5" />
                    按此规则切分
                  </Button>
                </div>
              ) : null}

              <p className="text-sm text-ink-700">
                切出 {splitSummary.chapterCount} 章，共 {formatWordCount(splitSummary.totalWords)}
              </p>

              {splitSummary.suspiciousCount > 0 ? (
                <p
                  role="alert"
                  className="rounded-xl bg-accent-soft px-3 py-2.5 text-xs leading-relaxed text-accent"
                >
                  有 {splitSummary.suspiciousCount} 章明显偏短，可能把目录或卷标题切成了章节。
                  可以直接删掉它们，或换一种分章方式。
                </p>
              ) : null}

              <ul className="grid gap-2 lg:grid-cols-2">
                {drafts.map((draft) => (
                  <li
                    key={draft.index}
                    className="rounded-xl border border-ink-100 bg-paper-raised p-3"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 text-xs text-ink-500">第 {draft.index} 章</span>
                      <span className="ml-auto shrink-0 text-xs text-ink-300">
                        {draft.wordCount} 字
                      </span>
                    </div>
                    <input
                      value={draft.title}
                      aria-label={`第 ${draft.index} 章标题`}
                      placeholder="（无标题）"
                      onChange={(event) =>
                        setDrafts((prev) => renameChapter(prev, draft.index, event.target.value))
                      }
                      className="mt-1 w-full bg-transparent text-sm font-medium text-ink-900 placeholder:text-ink-300 focus:outline-none"
                    />
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">
                      {draft.content.slice(0, 120)}
                    </p>
                    {needsTranslationToChinese(draft.content) &&
                    draft.content.length > TRANSLATE_SOFT_LIMIT ? (
                      // 这是用户唯一能改切分的地方；翻译之后再提示就晚了
                      <p role="note" className="mt-1 text-xs leading-relaxed text-accent">
                        这一章较长，单次翻译可能被截断，建议换一种分章方式或用自定义正则切小
                      </p>
                    ) : null}
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        disabled={draft.index === 1}
                        onClick={() => setDrafts((prev) => mergeWithPrevious(prev, draft.index))}
                      >
                        并入上一章
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setDrafts((prev) => removeChapter(prev, draft.index))}
                      >
                        删除
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>

              {/* 纯中文稿不加步骤：目的地直接在分章页选；有外文时翻译之后再选 */}
              {splitForeignCount === 0 && drafts.length > 0 ? picker : null}
            </div>
          ) : null}

          {!loadingJob && step === 'translate' ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
                <p aria-live="polite" className="text-sm text-ink-900">
                  已翻译 {translateDone.length} / {translateTargets.length} 章
                  {translateFailed.length > 0 ? `，${translateFailed.length} 章失败` : ''}
                </p>
                {note ? <p className="mt-1 text-xs text-ink-500">{note}</p> : null}
                <p className="mt-1 text-xs leading-relaxed text-ink-500">
                  译文会覆盖正文，原文自动留一份，随时可以回头核对。之后的设定提取与续写都基于中文。
                </p>
              </div>

              {/* 翻译是整个流程里唯一一次大规模输出，也是最贵的一步，必须先讲清楚 */}
              <p className="rounded-xl bg-accent-soft px-3 py-2.5 text-xs leading-relaxed text-accent">
                翻译按字数计费，是导入流程里最贵的一步 —— 大致相当于让 AI 重写一遍同样长度的文字。
                待译 {translatePending.length} 章，可以先取消勾选不需要的章节。
              </p>

              {!llm.configured ? (
                <p className="text-xs text-ink-500">需要先在「设置」里配置模型才能翻译。</p>
              ) : null}

              <div className="flex gap-2">
                {running ? (
                  <Button variant="secondary" size="lg" block onClick={pause}>
                    暂停
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="lg"
                    block
                    disabled={!llm.configured || translatePending.length === 0}
                    onClick={startTranslateLoop}
                  >
                    {translateDone.length > 0
                      ? '继续翻译'
                      : `开始翻译（${translatePending.length} 章）`}
                  </Button>
                )}
              </div>

              {/* 运行中不渲染：进行中的一章要先落盘，不能在目的地提交之后才写回草稿 */}
              {!running ? (
                <Button variant="secondary" size="lg" block onClick={() => void goToDestination()}>
                  {translatePending.length + translateFailed.length > 0
                    ? '跳过剩下的，选择导入方式'
                    : '下一步：选择导入方式'}
                </Button>
              ) : null}

              {streamed ? (
                <div className="rounded-xl border border-ink-100 bg-paper-raised px-3 py-2.5">
                  <p className="mb-1 text-xs font-medium text-ink-700">正在译出</p>
                  <p className="max-h-40 overflow-y-auto font-reading text-sm leading-relaxed whitespace-pre-wrap text-ink-700">
                    {streamed}
                  </p>
                </div>
              ) : null}

              <ul className="flex flex-col gap-1.5">
                {jobDrafts.map((item) => {
                  const skipped = item.translateStatus === 'none';
                  return (
                    <li
                      key={item.index}
                      className="flex items-center gap-2 rounded-xl border border-ink-100 bg-paper-raised px-3 py-2.5"
                    >
                      <input
                        type="checkbox"
                        aria-label={`翻译第 ${item.index} 章`}
                        checked={!skipped}
                        disabled={running || item.translateStatus === 'done'}
                        onChange={() => void toggleTranslate(item.index)}
                        className="h-4 w-4 shrink-0 accent-ink-900"
                      />
                      <span className="shrink-0 text-xs text-ink-500">第 {item.index} 章</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                        {item.title || '（无标题）'}
                      </span>
                      {item.translateStatus === 'done' ? (
                        <span className="shrink-0 text-xs text-emerald-700">已译</span>
                      ) : item.translateStatus === 'failed' ? (
                        <Button
                          size="sm"
                          disabled={running}
                          onClick={() => void retryTranslate(item.index)}
                        >
                          重试
                        </Button>
                      ) : skipped ? (
                        <span className="shrink-0 text-xs text-ink-300">不译</span>
                      ) : (
                        <span className="shrink-0 text-xs text-ink-300">待译</span>
                      )}
                    </li>
                  );
                })}
              </ul>

              {glossary.length > 0 ? (
                <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
                  <p className="text-xs font-medium text-ink-700">已定译名 {glossary.length} 条</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-500">
                    存在作品上，后面的章节与以后再导入的素材都会沿用。 想改某个译名，去「知识库 →
                    管理 → 译名表」。
                  </p>
                  <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {glossary.slice(0, 20).map((entry) => (
                      <li key={entry.source} className="text-xs text-ink-700">
                        {entry.source} → {entry.target}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {!loadingJob && step === 'destination' ? (
            <div className="flex flex-col gap-4">{picker}</div>
          ) : null}

          {!loadingJob && step === 'extract' && worldviewJob ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
                <p aria-live="polite" className="text-sm text-ink-900">
                  已提取 {chunkDone} / {worldviewChunks.length} 段
                  {chunkFailed > 0 ? `，${chunkFailed} 段失败` : ''}
                </p>
                {note ? <p className="mt-1 text-xs text-ink-500">{note}</p> : null}
                {!running && chunkPending > 0 ? (
                  <p className="mt-1 text-xs text-ink-500">
                    还有 {chunkPending} 段未提取。中途离开也没关系，进度已经保存。
                  </p>
                ) : null}
              </div>

              {!llm.configured ? (
                <p className="text-xs text-ink-500">需要先在「设置」里配置模型才能提取。</p>
              ) : null}

              <div className="flex gap-2">
                {running ? (
                  <Button variant="secondary" size="lg" block onClick={pause}>
                    暂停
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="lg"
                    block
                    disabled={!llm.configured || chunkPending === 0}
                    onClick={startLoop}
                  >
                    {chunkDone > 0 || chunkFailed > 0 ? '继续提取' : '开始提取'}
                  </Button>
                )}
              </div>

              {!running && chunkPending === 0 && chunkFailed > 0 ? (
                <Button variant="secondary" size="lg" block onClick={() => void finalize()}>
                  跳过失败段落，直接整理提案
                </Button>
              ) : null}

              <ul className="grid gap-1.5 lg:grid-cols-2">
                {worldviewChunks.map((item) => (
                  <li
                    key={item.index}
                    className="flex items-center gap-2 rounded-xl border border-ink-100 bg-paper-raised px-3 py-2.5"
                  >
                    <span className="shrink-0 text-xs text-ink-500">第 {item.index} 段</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                      {item.title || item.content.slice(0, 40)}
                    </span>
                    {item.status === 'done' ? (
                      <span className="shrink-0 text-xs text-emerald-700">已提取</span>
                    ) : item.status === 'failed' ? (
                      <Button
                        size="sm"
                        disabled={running}
                        onClick={() => void retryChunk(item.index)}
                      >
                        重试
                      </Button>
                    ) : (
                      <span className="shrink-0 text-xs text-ink-300">待提取</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {!loadingJob && step === 'extract' && !worldviewJob ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
                <p aria-live="polite" className="text-sm text-ink-900">
                  已提取 {doneCount} / {chapters.length} 章
                  {failedCount > 0 ? `，${failedCount} 章失败` : ''}
                </p>
                {note ? <p className="mt-1 text-xs text-ink-500">{note}</p> : null}
                {!running && pendingCount > 0 ? (
                  <p className="mt-1 text-xs text-ink-500">
                    还有 {pendingCount} 章未提取。中途离开也没关系，进度已经保存。
                  </p>
                ) : null}
              </div>

              {legacyUntranslated > 0 ? (
                <p
                  role="note"
                  className="rounded-xl bg-paper-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-700"
                >
                  这次导入是旧版本留下的，翻译进度无法接着跑。已写入的 {chapters.length}{' '}
                  章都在，未译的 {legacyUntranslated}{' '}
                  章会按原文提取；想先翻译的话，可以到写作页逐章『译成中文』后再开始提取，或放弃这次导入（章节会保留）。
                </p>
              ) : null}

              {!llm.configured ? (
                <p className="text-xs text-ink-500">需要先在「设置」里配置模型才能提取。</p>
              ) : null}

              <div className="flex gap-2">
                {running ? (
                  <Button variant="secondary" size="lg" block onClick={pause}>
                    暂停
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="lg"
                    block
                    disabled={!llm.configured || pendingCount === 0}
                    onClick={startLoop}
                  >
                    {doneCount > 0 ? '继续提取' : '开始提取'}
                  </Button>
                )}
              </div>

              {!running && pendingCount === 0 && failedCount > 0 ? (
                <Button variant="secondary" size="lg" block onClick={() => void finalize()}>
                  跳过失败章节，直接整理提案
                </Button>
              ) : null}

              <ul className="grid gap-1.5 lg:grid-cols-2">
                {chapters.map((item) => (
                  <li
                    key={item.chapterId}
                    className="flex items-center gap-2 rounded-xl border border-ink-100 bg-paper-raised px-3 py-2.5"
                  >
                    <span className="shrink-0 text-xs text-ink-500">
                      {chapterLabel(
                        { sideStoryId: jobSideStoryId, index: item.index },
                        labelStories,
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                      {item.title || '（无标题）'}
                    </span>
                    {item.status === 'done' ? (
                      <span className="shrink-0 text-xs text-emerald-700">已提取</span>
                    ) : item.status === 'failed' ? (
                      <Button
                        size="sm"
                        disabled={running}
                        onClick={() => void retry(item.chapterId)}
                      >
                        重试
                      </Button>
                    ) : (
                      <span className="shrink-0 text-xs text-ink-300">待提取</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {!loadingJob && step === 'inbox' ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm leading-relaxed text-ink-500">
                {finishedDestination?.kind === 'worldview'
                  ? '提取完成。下面是从设定文本中读出的世界观与人物条目，确认后才会写入知识库，不会创建任何章节。已有同名条目的会显示字段级改动。'
                  : '提取完成。下面是从旧稿里读出的章节摘要、人物与设定，确认后才会写入知识库。已有同名条目的会显示字段级改动。'}
              </p>

              {styleSkipped ? (
                // 用户勾了「归纳文风」却没拿到，必须说一声 —— 静默跳过会让他以为功能坏了
                <p className="rounded-xl bg-paper-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-500">
                  {styleSkipped}
                </p>
              ) : null}
              {batchId ? (
                // 长列表默认全部折叠：几十条提案全展开根本没法扫读
                <ProposalInbox
                  novelId={novel.id}
                  batchId={batchId}
                  acceptAllLabel="全部写入知识库"
                  defaultExpandFirst={false}
                />
              ) : null}

              {/* 一次导入很少就够：一章一个文件、正文与番外分开存都很常见 */}
              <div className="mt-2 flex flex-col gap-1.5 border-t border-ink-100 pt-4">
                <Button variant="secondary" size="lg" block onClick={continueImport}>
                  <ImportIcon className="h-5 w-5" />
                  继续导入下一批素材
                </Button>
                <p className="text-xs leading-relaxed text-ink-500">
                  回到第一步，译名表与已有设定都会沿用。
                  上面还没处理的待确认项不会丢，它们会留在「知识库」页的待确认区。
                </p>
              </div>
            </div>
          ) : null}

          {error ? (
            <div role="alert" className="mt-4 rounded-xl bg-seal-soft px-3 py-2.5">
              <p className="text-sm text-seal">{error.message}</p>
              {error.detail ? (
                <p className="mt-1 break-words text-xs text-ink-500">{error.detail}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {!loadingJob && step === 'paste' ? (
        <footer className="safe-bottom shrink-0 border-t border-ink-100 bg-paper-raised px-3 py-2 lg:pb-3">
          <div className="mx-auto w-full max-w-4xl lg:px-3">
            <Button variant="primary" size="lg" block disabled={!text.trim()} onClick={goToSplit}>
              下一步：切分章节
            </Button>
          </div>
        </footer>
      ) : null}

      {!loadingJob && step === 'split' ? (
        <footer className="safe-bottom shrink-0 border-t border-ink-100 bg-paper-raised px-3 py-2 lg:pb-3">
          <div className="mx-auto flex w-full max-w-4xl gap-2 lg:px-3">
            <Button variant="secondary" size="lg" block onClick={() => setStep('paste')}>
              返回修改
            </Button>
            <Button
              variant="primary"
              size="lg"
              block
              disabled={
                drafts.length === 0 || committing || (splitForeignCount === 0 && !validity.ok)
              }
              onClick={() => void confirmSplit()}
            >
              {splitForeignCount > 0
                ? `下一步：翻译（${splitForeignCount} 章）`
                : commitLabel(choice, drafts.length)}
            </Button>
          </div>
        </footer>
      ) : null}

      {!loadingJob && step === 'destination' ? (
        <footer className="safe-bottom shrink-0 border-t border-ink-100 bg-paper-raised px-3 py-2 lg:pb-3">
          <div className="mx-auto flex w-full max-w-4xl gap-2 lg:px-3">
            {/* 纯中文稿恢复到这一步时不提供返回：分章页的本地状态刷新后已经没了 */}
            {hasForeign ? (
              <Button variant="secondary" size="lg" block onClick={() => setStep('translate')}>
                返回翻译
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="lg"
              block
              disabled={!validity.ok || committing || jobDrafts.length === 0}
              onClick={() => void commitDestination()}
            >
              {commitLabel(choice, jobDrafts.length)}
            </Button>
          </div>
        </footer>
      ) : null}

      <ConfirmDialog
        open={confirmAbandon}
        title="放弃这次导入？"
        message={abandonMessage}
        confirmLabel="放弃进度"
        destructive
        onConfirm={abandon}
        onCancel={() => setConfirmAbandon(false)}
      />
    </div>
  );
}
