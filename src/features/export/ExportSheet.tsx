import { useEffect, useRef, useState } from 'react';
import type { Chapter, Novel, SideStory } from '@/domain/schema';
import { chapterLabel, chaptersOfTrack, sideStoryLabel } from '@/domain/sideStory';
import { Button } from '@/ui/Button';
import { SegmentedControl, Toggle } from '@/ui/Controls';
import { SelectField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
import { copyText, saveTextFile } from '@/ui/download';
import {
  chapterHeading,
  exportFileName,
  exportStats,
  formatChapter,
  formatNovel,
  formatSideStory,
  type ExportFormat,
} from './exportText';

type Scope = 'novel' | 'chapter' | 'side';

const PREVIEW_LIMIT = 400;

/** 稳定的空数组，免得默认值每次渲染都是新引用 */
const NO_SIDE_STORIES: SideStory[] = [];

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
  if (scope === 'chapter') {
    text = chapter ? formatChapter(chapter, format, chapterSideStory) : '';
  } else if (scope === 'side') {
    text = sideStory
      ? formatSideStory(novel, sideStory, chapters, { format, doneOnly, includeFrontMatter: true })
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

  async function copy() {
    const ok = await copyText(text);
    setToast(ok ? '已复制到剪贴板' : '复制失败，可以改用下载文件');
  }

  function download() {
    saveTextFile(fileName, text, format === 'markdown' ? 'text/markdown;charset=utf-8' : undefined);
    setToast(`已导出 ${fileName}`);
  }

  return (
    <Sheet
      open={open}
      title="导出正文"
      description="导出的是纯文本，随时可以带去任何平台。"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="lg" block disabled={!text} onClick={() => void copy()}>
            复制
          </Button>
          <Button variant="primary" size="lg" block disabled={!text} onClick={download}>
            下载文件
          </Button>
        </>
      }
    >
      <SegmentedControl<Scope>
        label="范围"
        value={scope}
        options={[
          { value: 'novel', label: '全书' },
          { value: 'chapter', label: '单章' },
          ...(sideStories.length > 0 ? [{ value: 'side' as const, label: '外传' }] : []),
        ]}
        onChange={setScope}
      />

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
          { value: 'markdown', label: 'Markdown', description: '书名与章节标题带 # 层级。' },
          { value: 'txt', label: '纯文本', description: '没有标记符号，适合直接贴进编辑器。' },
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

      {toast ? (
        <p aria-live="polite" className="text-xs text-ink-700">
          {toast}
        </p>
      ) : null}
    </Sheet>
  );
}
