import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { RequireNovel } from '@/app/RequireNovel';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import type { Chapter, ChapterSummary, Novel, OutlineNode, SideStory } from '@/domain/schema';
import { chaptersOfTrack, sideStoryLabel } from '@/domain/sideStory';
import { Button, IconButton } from '@/ui/Button';
import { EmptyState, Page, Section } from '@/ui/Page';
import { useAnyModalOpen } from '@/ui/Sheet';
import { MoreIcon, PlusIcon } from '@/ui/icons';
import { formatWordCount } from '@/ui/format';
import { planOutlineBackfill } from '../outline/backfillOutline';
import { OutlineBackfillSheet } from '../outline/OutlineBackfillSheet';
import { OutlineContinueSheet } from '../outline/OutlineContinueSheet';
import { OutlineNodeSheet } from '../outline/OutlineNodeSheet';
import { OutlineTreeView } from '../outline/OutlineTreeView';
import { ExportSheet } from '../export/ExportSheet';
import { outlineStats } from '../outline/outlineTree';
import { ProposalInbox } from '../proposals/ProposalInbox';
import { ScenarioEntryCard } from '../scenario/ScenarioEntryCard';
import { ChapterEditorScreen } from './ChapterEditorScreen';
import { ChapterListItem } from './ChapterListItem';
import { SideStorySheet } from './SideStorySheet';

/**
 * 主线最新一份摘要的累计伏笔。
 *
 * 摘要里的 openThreads 本身就是「截至该章仍未收束」的累计值（见 chapterSummary.ts），
 * 所以只需要取主线章节 index 最大的那一份，不用做全书集合运算。
 */
function latestMainlineOpenThreads(chapters: Chapter[], summaries: ChapterSummary[]): string[] {
  const byChapterId = new Map(
    chaptersOfTrack(chapters, null).map((chapter) => [chapter.id, chapter] as const),
  );
  let latest: { index: number; openThreads: string[] } | undefined;
  for (const summary of summaries) {
    const chapter = byChapterId.get(summary.chapterId);
    if (!chapter) continue;
    if (!latest || chapter.index > latest.index) {
      latest = { index: chapter.index, openThreads: summary.openThreads };
    }
  }
  return latest?.openThreads ?? [];
}

export function WritingPage() {
  return <RequireNovel title="写作">{(novel) => <WritingContent novel={novel} />}</RequireNovel>;
}

function WritingContent({ novel }: { novel: Novel }) {
  const repository = useRepository();
  const invalidate = useInvalidate();

  const { data, loading } = useRepoQuery(
    async (repo) => {
      const [
        outline,
        chapters,
        entries,
        categories,
        style,
        pending,
        summaries,
        sideStories,
        writingNorms,
      ] = await Promise.all([
        repo.listOutline(novel.id),
        repo.listChapters(novel.id),
        repo.listEntries(novel.id),
        repo.listCategories(novel.id),
        repo.getStyleProfile(novel.id),
        repo.listProposals(novel.id, { status: 'pending' }),
        repo.listSummaries(novel.id),
        repo.listSideStories(novel.id),
        // 写作规范随其他数据一起查：知识库里改了规范，invalidate 后生成面板的注入清单随之刷新
        repo.listWritingNorms(novel.id),
      ]);
      return {
        outline,
        chapters,
        entries,
        categories,
        style,
        pending,
        summaries,
        sideStories,
        writingNorms,
      };
    },
    [novel.id],
  );

  /**
   * 知识库的译名表发现某一章的译文没跟上译名，会带着章节 id 跳过来，
   * 直接把那一章的编辑器打开 —— 让用户自己在几十章里翻是把问题丢回给他。
   */
  const location = useLocation();
  const navigate = useNavigate();
  const wantedChapterId =
    (location.state as { openChapterId?: string } | null)?.openChapterId ?? null;

  const [selected, setSelected] = useState<{ node: OutlineNode; depth: number } | null>(null);
  const [editingChapterId, setEditingChapterId] = useState<string | null>(wantedChapterId);
  const [exportOpen, setExportOpen] = useState(false);
  /** 回溯大纲预览抽屉：有章节没大纲时，作者确认后才写库 */
  const [backfillOpen, setBackfillOpen] = useState(false);
  /** 前沿续写抽屉：一次调用产出 3–5 章细纲提案 */
  const [continueOpen, setContinueOpen] = useState(false);
  /** 外传抽屉：null 关闭；'new' 新建；否则为要编辑的外传 id */
  const [sideSheet, setSideSheet] = useState<'new' | string | null>(null);
  const modalOpen = useAnyModalOpen();

  /**
   * 意图只消费一次。
   *
   * 路由 state 会一直挂在这条历史记录上，不清掉的话用户关了编辑器、
   * 在页内点点再回到这里时，它会再次自动弹开。
   */
  const consumedIntent = useRef(false);
  useEffect(() => {
    if (!wantedChapterId || consumedIntent.current) return;
    consumedIntent.current = true;
    setEditingChapterId(wantedChapterId);
    navigate(location.pathname, { replace: true });
  }, [wantedChapterId, location.pathname, navigate]);

  const outline = data?.outline ?? [];
  /** 全部章节（主线 + 外传）：编辑器、导出入口、摘要链都要全量 */
  const chapters = data?.chapters ?? [];
  const sideStories = data?.sideStories ?? [];
  /** 「全书进度」与「章节正文」只算主线，外传不计入 */
  const mainChapters = chaptersOfTrack(chapters, null);
  const stats = outlineStats(outline);
  const writtenWords = mainChapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  /**
   * 回溯大纲计划（M3 S2）：纯确定性 1:1 映射，不调模型。
   * 只有「有主线章节、还没有大纲」的存量作品才用得到；计划为空时入口不出现。
   */
  const backfillPlan = planOutlineBackfill(chapters, data?.summaries ?? []);
  /**
   * 两个自动大纲入口互斥：
   * - 有章节没大纲 → 「按已有章节生成大纲」（1:1 回溯）；
   * - 已有大纲、或没有可回溯的章节但已经在写 → 「规划后续 3–5 章大纲」。
   */
  const showBackfillEntry = outline.length === 0 && backfillPlan.length > 0;
  const showContinueEntry = !showBackfillEntry && (outline.length > 0 || mainChapters.length > 0);

  /** 每个大纲节点已写了多少章 */
  const chapterCountByNode = new Map<string, number>();
  for (const chapter of mainChapters) {
    if (!chapter.outlineNodeId) continue;
    chapterCountByNode.set(
      chapter.outlineNodeId,
      (chapterCountByNode.get(chapter.outlineNodeId) ?? 0) + 1,
    );
  }

  // 选中的节点要从最新数据里取，否则保存后抽屉里显示的还是旧值
  const selectedNode = selected
    ? (outline.find((node) => node.id === selected.node.id) ?? null)
    : null;

  async function addRootNode() {
    const created = await repository.createOutlineNode(novel.id, {
      title: `第 ${outline.filter((node) => node.parentId === null).length + 1} 卷`,
    });
    invalidate();
    setSelected({ node: created, depth: 0 });
  }

  /** 从大纲节点进入写作：已有对应章节就打开它，否则新建一章并挂上关联 */
  async function openChapterForNode(node: OutlineNode) {
    const existing = chapters.find((chapter) => chapter.outlineNodeId === node.id);
    if (existing) {
      setSelected(null);
      setEditingChapterId(existing.id);
      return;
    }
    const created = await repository.createChapter(novel.id, {
      title: node.title,
      outlineNodeId: node.id,
      source: 'manual',
    });
    // 进入写作即把节点标记为「在写」，省掉一次手动操作
    if (node.status === 'planned') {
      await repository.updateOutlineNode(node.id, { status: 'drafting' });
    }
    invalidate();
    setSelected(null);
    setEditingChapterId(created.id);
  }

  /** 外传卡片的「写新一章」：在这部外传里续一章并打开编辑器 */
  async function writeSideChapter(story: SideStory) {
    const created = await repository.createChapter(novel.id, {
      sideStoryId: story.id,
      source: 'manual',
    });
    invalidate();
    setEditingChapterId(created.id);
  }

  const editingChapter = editingChapterId
    ? (chapters.find((chapter) => chapter.id === editingChapterId) ?? null)
    : null;
  const editingSideId = editingChapter?.sideStoryId ?? null;
  const editingSideStory =
    editingSideId === null ? undefined : sideStories.find((story) => story.id === editingSideId);
  /** 外传章节找不到所属外传（刚被删）时不打开编辑器 */
  const editorOrphaned = editingSideId !== null && !editingSideStory;
  useEffect(() => {
    if (editorOrphaned) setEditingChapterId(null);
  }, [editorOrphaned]);

  const sheetStory =
    sideSheet && sideSheet !== 'new'
      ? sideStories.find((story) => story.id === sideSheet)
      : undefined;

  const sideSection = (
    <Section
      title="外传"
      description="独立于主线的番外篇章：各自从第 1 章编号，不进主线的摘要链与进度。"
      action={
        <Button size="sm" onClick={() => setSideSheet('new')}>
          新建外传
        </Button>
      }
    >
      {sideStories.length === 0 ? (
        <p className="text-sm text-ink-300">还没有外传</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sideStories.map((story) => {
            const storyChapters = chaptersOfTrack(chapters, story.id);
            const words = storyChapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
            const label = sideStoryLabel(story);
            return (
              <li key={story.id}>
                <section aria-label={label} className="rounded-xl border border-ink-100 p-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-medium text-ink-900">{label}</h3>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {storyChapters.length} 章 · {formatWordCount(words)}
                      </p>
                    </div>
                    <IconButton
                      label={`编辑外传《${story.title}》`}
                      onClick={() => setSideSheet(story.id)}
                    >
                      <MoreIcon className="h-5 w-5" />
                    </IconButton>
                    <Button size="sm" onClick={() => void writeSideChapter(story)}>
                      写新一章
                    </Button>
                  </div>
                  {storyChapters.length > 0 ? (
                    <ul className="mt-3 flex flex-col gap-2">
                      {storyChapters.map((chapter) => (
                        <ChapterListItem
                          key={chapter.id}
                          chapter={chapter}
                          ariaLabel={`继续写外传《${story.title}》第 ${chapter.index} 章`}
                          onOpen={() => setEditingChapterId(chapter.id)}
                        />
                      ))}
                    </ul>
                  ) : null}
                </section>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );

  return (
    <Page
      title="写作"
      subtitle={novel.title}
      width="wide"
      action={
        <IconButton label="新建大纲节点" onClick={addRootNode} className="text-ink-900">
          <PlusIcon className="h-6 w-6" />
        </IconButton>
      }
    >
      {/* 有弹层打开时不渲染：抽屉里可能已经在确认同一批内容 */}
      {!modalOpen && data && data.pending.length > 0 ? (
        <Section title={`待确认 ${data.pending.length} 项`} description="确认后才会写入大纲。">
          <ProposalInbox novelId={novel.id} />
        </Section>
      ) : null}

      {/* 互动推演入口：在「全书进度」与空作品引导之前，两种情形都渲染（设计 §8.1） */}
      <ScenarioEntryCard novel={novel} />

      {loading ? (
        <p className="py-10 text-center text-sm text-ink-300">加载中…</p>
      ) : outline.length === 0 && mainChapters.length === 0 && sideStories.length === 0 ? (
        /* 只有大纲、主线章节和外传都为空才是真的空。导入旧稿的作品有章节却没有大纲，
           那时把章节列表藏起来等于让用户找不到自己刚导进来的几十万字。
           外传区块仍然渲染在下面，作为新建外传的入口 */
        <>
          <EmptyState
            title="还没有大纲"
            description="可以到「知识库」用一句话立项生成整份大纲，也可以在这里手动加第一个节点。"
            action={
              <Button variant="primary" size="lg" onClick={addRootNode}>
                手动添加第一个节点
              </Button>
            }
          />
          <div className="mt-5 lg:mt-6">{sideSection}</div>
        </>
      ) : (
        <>
          <Section title="全书进度" description={`${stats.total} 个节点，${stats.done} 个已完成`}>
            <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="text-ink-500">已写</dt>
                <dd className="text-ink-900">{formatWordCount(writtenWords)}</dd>
              </div>
              {stats.targetWords > 0 ? (
                <div className="flex gap-2">
                  <dt className="text-ink-500">目标</dt>
                  <dd className="text-ink-900">{formatWordCount(stats.targetWords)}</dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="text-ink-500">章节</dt>
                <dd className="text-ink-900">{mainChapters.length} 章</dd>
              </div>
            </dl>
          </Section>

          <Section
            title="大纲"
            description={
              outline.length > 0
                ? '点节点可编辑梗概、关联设定或用 AI 细化；点右侧把手调整层级与顺序。'
                : '这本书还没有大纲。导入的旧稿可以先不建大纲，想规划后续剧情时再加。'
            }
            action={
              showContinueEntry ? (
                <Button size="sm" onClick={() => setContinueOpen(true)}>
                  规划后续 3–5 章大纲
                </Button>
              ) : undefined
            }
          >
            {outline.length > 0 ? (
              <OutlineTreeView
                nodes={outline}
                chapterCountByNode={chapterCountByNode}
                onSelect={(node, depth) => setSelected({ node, depth })}
              />
            ) : (
              <div className="flex flex-col gap-2">
                {showBackfillEntry ? (
                  <Button variant="primary" size="lg" block onClick={() => setBackfillOpen(true)}>
                    按已有章节生成大纲
                  </Button>
                ) : null}
                <Button
                  variant={showBackfillEntry ? 'secondary' : 'primary'}
                  size="lg"
                  block
                  onClick={addRootNode}
                >
                  添加第一个大纲节点
                </Button>
              </div>
            )}
          </Section>

          <Section
            title={`章节正文 ${mainChapters.length > 0 ? mainChapters.length : ''}`}
            description="点大纲节点里的「写这一章」开始，或点下面已有的章节继续写。"
            action={
              // 按全量章节判断：只有外传的作品也要能找到导出入口
              chapters.length > 0 ? (
                <Button size="sm" onClick={() => setExportOpen(true)}>
                  导出
                </Button>
              ) : undefined
            }
          >
            {mainChapters.length === 0 ? (
              <p className="text-sm text-ink-300">还没有章节</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {mainChapters.map((chapter) => (
                  <ChapterListItem
                    key={chapter.id}
                    chapter={chapter}
                    onOpen={() => setEditingChapterId(chapter.id)}
                  />
                ))}
              </ul>
            )}
          </Section>

          {sideSection}
        </>
      )}

      <OutlineBackfillSheet
        open={backfillOpen}
        novelId={novel.id}
        plan={backfillPlan}
        chapters={chapters}
        onClose={() => setBackfillOpen(false)}
      />

      {data?.style ? (
        <OutlineContinueSheet
          open={continueOpen}
          novel={novel}
          style={data.style}
          outline={outline}
          chapters={chapters}
          summaries={data.summaries}
          entries={data.entries}
          categories={data.categories}
          {...(data.writingNorms ? { writingNorms: data.writingNorms } : {})}
          onClose={() => setContinueOpen(false)}
        />
      ) : null}

      <ExportSheet
        open={exportOpen}
        novel={novel}
        chapters={chapters}
        sideStories={sideStories}
        onClose={() => setExportOpen(false)}
      />

      <SideStorySheet
        open={sideSheet !== null && (sideSheet === 'new' || sheetStory !== undefined)}
        novelId={novel.id}
        sideStory={sheetStory}
        chapters={chapters}
        onClose={() => setSideSheet(null)}
      />

      {selectedNode && data?.style ? (
        <OutlineNodeSheet
          open
          novel={novel}
          style={data.style}
          node={selectedNode}
          nodes={outline}
          entries={data.entries}
          categories={data.categories}
          depth={selected?.depth ?? 0}
          chapters={chapters}
          openThreads={latestMainlineOpenThreads(chapters, data.summaries)}
          rollingSummary={novel.rollingSummary}
          onWrite={openChapterForNode}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {editingChapter && data?.style && !editorOrphaned ? (
        <ChapterEditorScreen
          // 换章节时重新挂载，编辑器内部的草稿状态随之重置
          key={editingChapter.id}
          chapter={editingChapter}
          {...(editingSideStory ? { sideStory: editingSideStory } : {})}
          context={{
            novel,
            style: data.style,
            categories: data.categories,
            entries: data.entries,
            outline,
            chapters,
            summaries: data.summaries,
            sideStories,
            writingNorms: data.writingNorms,
            targetNodeId: editingChapter.outlineNodeId,
          }}
          onClose={() => setEditingChapterId(null)}
        />
      ) : null}
    </Page>
  );
}
