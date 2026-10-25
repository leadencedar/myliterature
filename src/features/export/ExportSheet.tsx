import { useEffect, useRef, useState } from 'react';
import type { Chapter, Novel, SideStory } from '@/domain/schema';
import { chapterLabel, chaptersOfTrack, sideStoryLabel } from '@/domain/sideStory';
import { Button } from '@/ui/Button';
import { SegmentedControl, Toggle } from '@/ui/Controls';
import { SelectField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
import { copyText, saveBinaryFile, saveTextFile } from '@/ui/download';
import { buildChapterPackZip, planChapterPack, type PackFormat } from './chapterPack';
import {
  chapterHeading,
  exportFileName,
  exportStats,
  formatChapter,
  formatNovel,
  formatSideStory,
  type ExportFormat,
} from './exportText';

type Scope = 'novel' | 'chapter' | 'side' | 'pack';

const PREVIEW_LIMIT = 400;

/** 稳定的空数组，免得默认值每次渲染都是新引用 */
const NO_SIDE_STORIES: SideStory[] = [];

/**
 * 打包导出的四种格式。
 *
 * 默认纯文本：作者的下一站几乎总是「逐章贴进某个平台」，那里不认 Markdown，
 * 也不收 PDF；RTF / PDF 是给存档、阅读和打印的，按需再切。
 */
const PACK_FORMATS: { value: PackFormat; label: string; description: string }[] = [
  {
    value: 'txt',
    label: '纯文本',
    description: '每章一个 .txt：标题一行、空行、正文，贴进任何平台都不会带上排版。',
  },
  {
    value: 'markdown',
    label: 'Markdown',
    description: '每章一个 .md，章节标题带 ## 层级，适合投稿与排版工具。',
  },
  {
    value: 'rtf',
    label: 'RTF',
    description: '每章一个 .rtf，Word / WPS 直接打开，标题加粗、行距已经排好。',
  },
  {
    value: 'pdf',
    label: 'PDF',
    description: '每章一个 .pdf，A4 排版、带页码，适合阅读与打印。',
  },
];

function isPackFormat(value: string): value is PackFormat {
  return PACK_FORMATS.some((item) => item.value === value);
}

interface ExportSheetProps {
  open: boolean;
  novel: Novel;
  /** 全部章节（主线 + 外传） */
  chapters: Chapter[];
  /** 作品的外传；有外传时范围里才出现「外传」 */
  sideStories?: SideStory[];
  /** 打开时默认导出这一章 */
  defaultChapterId?: string;
  onClose: () => void;
}

/**
 * 正文导出。
 *
 * 复制到剪贴板与下载文件并列，不分主次：移动端浏览器对下载的处理差异很大，
 * 而「贴进平台编辑器」本来就是最常见的去向。
 *
 * 「打包」范围是另一条路：整本书每章一个文件、格式逐章可选，下载一个 zip。
 * 它不取代单文件导出 —— 想贴一章时下载一个文件仍然最快。
 */
export function ExportSheet({
  open,
  novel,
  chapters,
  sideStories = NO_SIDE_STORIES,
  defaultChapterId,
  onClose,
}: ExportSheetProps) {
  const [scope, setScope] = useState<Scope>('novel');
  const [chapterId, setChapterId] = useState('');
  const [sideStoryId, setSideStoryId] = useState('');
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [doneOnly, setDoneOnly] = useState(false);
  const [withSideStories, setWithSideStories] = useState(false);
  /** 打包的默认格式；逐章覆盖放在 chapterFormats，未覆盖的章跟着默认走 */
  const [packFormat, setPackFormat] = useState<PackFormat>('txt');
  const [chapterFormats, setChapterFormats] = useState<Record<string, PackFormat>>({});
  const [packing, setPacking] = useState(false);
  const [toast, setToast] = useState('');

  /** 单章下拉：先主线，再按外传依次列出 */
  const mainChapters = chaptersOfTrack(chapters, null);
  const sorted = [
    ...mainChapters,
    ...sideStories.flatMap((story) => chaptersOfTrack(chapters, story.id)),
  ];

  const defaultRef = useRef(defaultChapterId);
  defaultRef.current = defaultChapterId;
  const firstId = sorted[0]?.id ?? '';
  const hasMain = mainChapters.length > 0;
  /** 只有外传的作品打开时默认导出那部有章节的外传 */
  const firstSideId =
    sideStories.find((story) => chaptersOfTrack(chapters, story.id).length > 0)?.id ??
    sideStories[0]?.id ??
    '';
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const preferred = defaultRef.current;
      // 有指定章节就单章；否则主线有章就全书；否则外传 —— 免得一打开就是只有书名的全书导出
      setScope(preferred ? 'chapter' : hasMain || !firstSideId ? 'novel' : 'side');
      setChapterId(preferred ?? firstId);
      setSideStoryId(firstSideId);
      setToast('');
    }
    wasOpen.current = open;
  }, [open, firstId, firstSideId, hasMain]);

  const chapter = sorted.find((item) => item.id === chapterId);
  const chapterSideStory =
    chapter && chapter.sideStoryId !== null
      ? sideStories.find((story) => story.id === chapter.sideStoryId)
      : undefined;
  const sideStory = sideStories.find((story) => story.id === sideStoryId);

  let text = '';
  if (scope !== 'pack') {
    if (scope === 'chapter') {
      text = chapter ? formatChapter(chapter, format, chapterSideStory) : '';
    } else if (scope === 'side') {
      text = sideStory
        ? formatSideStory(novel, sideStory, chapters, {
            format,
            doneOnly,
            includeFrontMatter: true,
          })
        : '';
    } else {
      text = formatNovel(novel, chapters, {
        format,
        doneOnly,
        includeFrontMatter: true,
        ...(withSideStories
          ? {
              sideStories: sideStories.map((story) => ({
                story,
                chapters: chaptersOfTrack(chapters, story.id),
              })),
            }
          : {}),
      });
    }
  }
  const stats = exportStats(text);
  const fileName = exportFileName(
    novel,
    scope === 'chapter' && chapter
      ? { kind: 'chapter', chapter, ...(chapterSideStory ? { sideStory: chapterSideStory } : {}) }
      : scope === 'side' && sideStory
        ? { kind: 'side', story: sideStory }
        : { kind: 'novel' },
    format,
  );

  /** 打包计划是同步纯计算，列表本身就是预览，不需要另外生成一遍内容 */
  const packPlan =
    scope === 'pack'
      ? planChapterPack(novel, chapters, sideStories, {
          defaultFormat: packFormat,
          formats: chapterFormats,
          doneOnly,
          includeSideStories: withSideStories,
        })
      : null;
  const hasOverrides = Object.keys(chapterFormats).length > 0;
  const hasPdfInPack = packPlan?.files.some((file) => file.format === 'pdf') ?? false;

  async function copy() {
    const ok = await copyText(text);
    setToast(ok ? '已复制到剪贴板' : '复制失败，可以改用下载文件');
  }

  function download() {
    saveTextFile(fileName, text, format === 'markdown' ? 'text/markdown;charset=utf-8' : undefined);
    setToast(`已导出 ${fileName}`);
  }

  async function downloadPack() {
    if (!packPlan || packPlan.files.length === 0 || packing) return;
    setPacking(true);
    setToast('');
    try {
      const bytes = await buildChapterPackZip(packPlan);
      saveBinaryFile(packPlan.zipFileName, bytes, 'application/zip');
      setToast(`已导出 ${packPlan.zipFileName}`);
    } catch {
      setToast('打包失败，请重试');
    } finally {
      setPacking(false);
    }
  }

  return (
    <Sheet
      open={open}
      title="导出正文"
      description={
        scope === 'pack'
          ? '每章一个文件，格式逐个可选，下载时打包成 zip。'
          : '导出的是纯文本，随时可以带去任何平台。'
      }
      onClose={onClose}
      footer={
        scope === 'pack' ? (
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!packPlan || packPlan.files.length === 0 || packing}
            onClick={() => void downloadPack()}
          >
            {packing ? '正在打包…' : '下载压缩包'}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="lg"
              block
              disabled={!text}
              onClick={() => void copy()}
            >
              复制
            </Button>
            <Button variant="primary" size="lg" block disabled={!text} onClick={download}>
              下载文件
            </Button>
          </>
        )
      }
    >
      <SegmentedControl<Scope>
        label="范围"
        value={scope}
        options={[
          // 「打包」是整本带走的主路径，放最前；单文件导出按「用的频率」排在后面
          { value: 'pack', label: '打包' },
          { value: 'chapter', label: '单章' },
          ...(sideStories.length > 0 ? [{ value: 'side' as const, label: '外传' }] : []),
          { value: 'novel', label: '全书' },
        ]}
        onChange={(next) => {
          // 只有外传的作品切到打包时，主线一个文件都列不出来 —— 直接把外传打开
          if (next === 'pack' && !hasMain && sideStories.length > 0) setWithSideStories(true);
          setScope(next);
        }}
      />

      {scope === 'pack' ? (
        <>
          <Toggle
            label="只导出已完成的章节"
            description="草稿状态的章节会被跳过。"
            checked={doneOnly}
            onChange={setDoneOnly}
          />
          {sideStories.length > 0 ? (
            <Toggle
              label="附带外传"
              description="外传各进一个「外传·X」子文件夹。"
              checked={withSideStories}
              onChange={setWithSideStories}
            />
          ) : null}

          <SegmentedControl<PackFormat>
            label="默认格式"
            value={packFormat}
            options={PACK_FORMATS}
            onChange={setPackFormat}
          />

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-ink-700">文件列表</p>
            {packPlan && packPlan.files.length > 0 ? (
              <>
                <ul
                  aria-label="分章文件列表"
                  className="flex max-h-64 flex-col gap-1 overflow-auto rounded-xl bg-paper-sunken px-2 py-2"
                >
                  {packPlan.files.map((file) => {
                    const prefix = `${packPlan.bookTitle}/`;
                    const relative = file.path.startsWith(prefix)
                      ? file.path.slice(prefix.length)
                      : file.path;
                    return (
                      <li key={file.chapterId} className="flex items-center justify-between gap-2">
                        <span
                          className="min-w-0 flex-1 truncate text-xs leading-relaxed text-ink-700"
                          title={relative}
                        >
                          {relative}
                        </span>
                        <select
                          aria-label={`${relative} 格式`}
                          value={file.format}
                          onChange={(event) => {
                            const next = event.target.value;
                            if (!isPackFormat(next)) return;
                            setChapterFormats((current) => ({
                              ...current,
                              [file.chapterId]: next,
                            }));
                          }}
                          className="shrink-0 rounded-lg border border-ink-100 bg-paper-raised px-1.5 py-1 text-xs text-ink-900 focus:border-ink-500 focus:outline-none"
                        >
                          {PACK_FORMATS.map((item) => (
                            <option key={item.value} value={item.value}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs text-ink-500">
                  共 {packPlan.files.length} 个文件 · 约 {packPlan.totalChars} 字
                  {packPlan.skipped > 0
                    ? ` · 另有 ${packPlan.skipped} 章未包含（草稿或空章节）`
                    : ''}
                </p>
                {hasPdfInPack ? (
                  <p className="text-xs leading-relaxed text-ink-500">
                    PDF 使用阅读器自带字体，超出 GBK 的生僻字与 emoji 会显示为 □；要原样保留请选
                    TXT/MD/RTF。
                  </p>
                ) : null}
                {hasOverrides ? (
                  <button
                    type="button"
                    className="self-start text-xs text-ink-500 underline"
                    onClick={() => setChapterFormats({})}
                  >
                    全部改用默认格式
                  </button>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-ink-500">没有可导出的章节。</p>
            )}
          </div>
        </>
      ) : (
        <>
          {scope === 'chapter' ? (
            sorted.length > 0 ? (
              <SelectField
                label="选择章节"
                value={chapterId}
                options={sorted.map((item) => ({
                  value: item.id,
                  label:
                    item.sideStoryId === null
                      ? `第 ${item.index} 章 ${chapterHeading(item)}`
                      : `${chapterLabel(item, sideStories)}${item.title.trim() ? ` ${item.title.trim()}` : ''}`,
                }))}
                onChange={(event) => setChapterId((event.target as HTMLSelectElement).value)}
              />
            ) : (
              <p className="text-sm text-ink-500">还没有章节可导出。</p>
            )
          ) : (
            <>
              {scope === 'side' ? (
                <SelectField
                  label="选择外传"
                  value={sideStoryId}
                  options={sideStories.map((story) => ({
                    value: story.id,
                    label: sideStoryLabel(story),
                  }))}
                  onChange={(event) => setSideStoryId((event.target as HTMLSelectElement).value)}
                />
              ) : null}
              <Toggle
                label="只导出已完成的章节"
                description="草稿状态的章节会被跳过。"
                checked={doneOnly}
                onChange={setDoneOnly}
              />
              {scope === 'novel' && sideStories.length > 0 ? (
                <Toggle
                  label="附带外传"
                  description="外传排在主线之后，每部一个「外传·X」标题。"
                  checked={withSideStories}
                  onChange={setWithSideStories}
                />
              ) : null}
            </>
          )}

          <SegmentedControl<ExportFormat>
            label="格式"
            value={format}
            options={[
              {
                value: 'markdown',
                label: 'Markdown',
                description: '书名与章节标题带 # 层级。',
              },
              {
                value: 'txt',
                label: '纯文本',
                description: '没有标记符号，适合直接贴进编辑器。',
              },
            ]}
            onChange={setFormat}
          />

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-ink-700">预览</p>
            <p className="text-xs text-ink-500">
              {stats.chars > 0 ? `共 ${stats.chars} 字符 · 文件名 ${fileName}` : '没有可导出的内容'}
            </p>
            {stats.chars > 0 ? (
              <pre className="max-h-48 overflow-auto rounded-xl bg-paper-sunken px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-ink-700">
                {text.slice(0, PREVIEW_LIMIT)}
                {text.length > PREVIEW_LIMIT ? '\n…' : ''}
              </pre>
            ) : null}
          </div>
        </>
      )}

      {toast ? (
        <p aria-live="polite" className="text-xs text-ink-700">
          {toast}
        </p>
      ) : null}
    </Sheet>
  );
}
