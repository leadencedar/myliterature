import { useRef, type ComponentProps, type ReactNode } from 'react';
import { ChapterEditorScreen, type ChapterEditorHandle } from '../ChapterEditorScreen';
import { WorkbenchShell, type WorkbenchChapter } from './WorkbenchShell';

type EditorProps = ComponentProps<typeof ChapterEditorScreen>;

interface InlineWorkbenchPreviewProps {
  workTitle: string;
  chapters: readonly WorkbenchChapter[];
  railFooter?: ReactNode;
  /** 复用编辑器全部 props；presentation / editorRef 由本组件接管 */
  editor: Omit<EditorProps, 'presentation' | 'editorRef'>;
  onSwitchChapter: (chapterId: string) => void;
}

/**
 * 阶段 2 的开发预览：工作台壳 + 内联编辑器。
 *
 * 只在 `/write?inline-editor=1`（DEV/测试环境）下由 WritingPage 懒加载；
 * 不进入生产 bundle。切章前先让编辑器 flush，保存失败就不切。
 */
export function InlineWorkbenchPreview({
  workTitle,
  chapters,
  railFooter,
  editor,
  onSwitchChapter,
}: InlineWorkbenchPreviewProps) {
  const editorRef = useRef<ChapterEditorHandle | null>(null);

  async function switchChapter(chapterId: string) {
    if (chapterId === editor.chapter.id) return;
    const canLeave = await editorRef.current?.flush();
    if (canLeave === false) return;
    onSwitchChapter(chapterId);
  }

  return (
    <WorkbenchShell
      workTitle={workTitle}
      chapters={chapters}
      railFooter={railFooter}
      onSelectChapter={(chapterId) => void switchChapter(chapterId)}
    >
      <ChapterEditorScreen
        key={editor.chapter.id}
        {...editor}
        presentation="inline"
        editorRef={editorRef}
      />
    </WorkbenchShell>
  );
}
