import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { RequireNovel } from '@/app/RequireNovel';
import { useRepoQuery } from '@/data/useRepoQuery';
import type { KnowledgeEntry, Novel } from '@/domain/schema';
import { Button, IconButton } from '@/ui/Button';
import { EmptyState, Page, Section } from '@/ui/Page';
import { useAnyModalOpen } from '@/ui/Sheet';
import { FolderIcon, GlossaryIcon, ImportIcon, PlusIcon, TrashIcon } from '@/ui/icons';
import { ImportScreen } from '../import/ImportScreen';
import { GlossarySheet } from '../writing/GlossarySheet';
import { ProposalInbox } from '../proposals/ProposalInbox';
import { SetupSection } from '../setup/SetupSection';
import { StyleSection } from '../style/StyleSection';
import { CategoryManagerSheet } from './CategoryManagerSheet';
import { EntryEditorSheet } from './EntryEditorSheet';
import { EntryList } from './EntryList';
import { TrashSheet } from './TrashSheet';
import { WritingNormsSection } from './WritingNormsSection';

export function KnowledgePage() {
  return (
    <RequireNovel title="知识库">{(novel) => <KnowledgeContent novel={novel} />}</RequireNovel>
  );
}

function KnowledgeContent({ novel }: { novel: Novel }) {
  const navigate = useNavigate();
  const { data, loading } = useRepoQuery(
    async (repo) => {
      const [pending, entries, allEntries, categories, outline, glossary, scenarios] =
        await Promise.all([
          repo.listProposals(novel.id, { status: 'pending' }),
          // 知识库要列出全部条目，含限定到推演的（带徽标）；写作链路仍走默认的通用条目
          repo.listEntries(novel.id, { scope: 'all' }),
          repo.listEntries(novel.id, { includeDeleted: true, scope: 'all' }),
          repo.listCategories(novel.id),
          repo.listOutline(novel.id),
          repo.getGlossary(novel.id),
          // 只为限定条目的徽标「限定 · 推演《X》」取推演名
          repo.listScenarios(novel.id),
        ]);
      return {
        pending,
        entries,
        deletedCount: allEntries.filter((entry) => entry.deletedAt !== null).length,
        categories,
        outline,
        glossaryCount: glossary?.terms.length ?? 0,
        scenarioTitles: new Map(scenarios.map((scenario) => [scenario.id, scenario.title])),
      };
    },
    [novel.id],
  );

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeEntry | undefined>();
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const modalOpen = useAnyModalOpen();

  /**
   * 书架上选了「导入已有稿件」就会带着这个意图跳过来，直接把导入面板打开 ——
   * 让刚建完作品的人再去「管理」区翻一遍是没必要的一步。
   */
  const location = useLocation();
  const wantsImport = (location.state as { openImport?: boolean } | null)?.openImport === true;
  const [importOpen, setImportOpen] = useState(wantsImport);

  /**
   * 意图只消费一次。
   *
   * 路由 state 会一直挂在这条历史记录上，不清掉的话用户关了导入面板、
   * 在页内点点又回到这里时，它会再次自动弹开。
   */
  const consumedIntent = useRef(false);
  useEffect(() => {
    if (!wantsImport || consumedIntent.current) return;
    consumedIntent.current = true;
    setImportOpen(true);
    navigate(location.pathname, { replace: true });
  }, [wantsImport, location.pathname, navigate]);

  const pending = data?.pending ?? [];
  const entries = data?.entries ?? [];
  const categories = data?.categories ?? [];
  const outline = data?.outline ?? [];
  const deletedCount = data?.deletedCount ?? 0;
  const glossaryCount = data?.glossaryCount ?? 0;
  const scenarioTitles = data?.scenarioTitles;
  const isEmpty = entries.length === 0 && outline.length === 0;

  function openCreate() {
    setEditing(undefined);
    setEditorOpen(true);
  }

  function openEdit(entry: KnowledgeEntry) {
    setEditing(entry);
    setEditorOpen(true);
  }

  return (
    <Page
      title="知识库"
      subtitle={novel.title}
      width="wide"
      action={
        <IconButton label="新建条目" onClick={openCreate} className="text-ink-900">
          <PlusIcon className="h-6 w-6" />
        </IconButton>
      }
    >
      {/* 待确认项最优先：这是需要用户马上处理的事。
          但有弹层或导入面板打开时不渲染 —— 它们内部可能正在确认同一批内容，
          两处并存会让同一条内容出现两个确认入口。 */}
      {!modalOpen && !importOpen && pending.length > 0 ? (
        <Section
          title={`待确认 ${pending.length} 项`}
          description="AI 生成的内容不会直接写入知识库，确认后才会保存。可逐项展开修改。"
        >
          <ProposalInbox novelId={novel.id} />
        </Section>
      ) : null}

      {/* 空库时把立项放在最前面，它是这时唯一该做的事 */}
      {isEmpty ? <SetupSection novel={novel} /> : null}

      {loading ? (
        <p className="py-10 text-center text-sm text-ink-300">加载中…</p>
      ) : entries.length > 0 ? (
        <Section title={`设定条目 ${entries.length}`}>
          <EntryList
            entries={entries}
            categories={categories}
            scenarioTitles={scenarioTitles}
            onEdit={openEdit}
          />
        </Section>
      ) : !isEmpty ? (
        <Section title="设定条目">
          <EmptyState
            title="还没有设定条目"
            description="可以手动新建，也可以用立项功能批量生成。"
            action={
              <Button variant="primary" size="lg" onClick={openCreate}>
                新建条目
              </Button>
            }
          />
        </Section>
      ) : null}

      {outline.length > 0 ? (
        <Section
          title={`大纲 ${outline.length} 个节点`}
          description="大纲的查看与编辑在「写作」页。"
        >
          <ul className="flex flex-col gap-1.5">
            {outline
              .filter((node) => node.parentId === null)
              .map((node) => (
                <li key={node.id} className="text-sm text-ink-900">
                  {node.title}
                  <span className="ml-2 text-xs text-ink-500">
                    {outline.filter((child) => child.parentId === node.id).length} 章
                  </span>
                </li>
              ))}
          </ul>
        </Section>
      ) : null}

      <StyleSection novel={novel} />

      {/* 规范与风格档案同属「整本书的底色」，紧挨着放；不进「管理」区那类低频工具 */}
      <WritingNormsSection novel={novel} />

      {/* 已有内容时，立项退到后面作为「重新生成」入口 */}
      {!isEmpty ? <SetupSection novel={novel} /> : null}

      <Section title="管理">
        <div className="flex flex-col gap-2 md:flex-row">
          <Button variant="secondary" size="lg" block onClick={() => setCategoryManagerOpen(true)}>
            <FolderIcon className="h-5 w-5" />
            分类管理（{categories.length}）
          </Button>
          <Button variant="secondary" size="lg" block onClick={() => setImportOpen(true)}>
            <ImportIcon className="h-5 w-5" />
            导入旧稿
          </Button>
          <Button variant="secondary" size="lg" block onClick={() => setGlossaryOpen(true)}>
            <GlossaryIcon className="h-5 w-5" />
            译名表{glossaryCount > 0 ? `（${glossaryCount}）` : ''}
          </Button>
          <Button variant="secondary" size="lg" block onClick={() => setTrashOpen(true)}>
            <TrashIcon className="h-5 w-5" />
            回收站{deletedCount > 0 ? `（${deletedCount}）` : ''}
          </Button>
        </div>
      </Section>

      <EntryEditorSheet
        open={editorOpen}
        novelId={novel.id}
        categories={categories}
        entry={editing}
        onClose={() => setEditorOpen(false)}
      />

      <CategoryManagerSheet
        open={categoryManagerOpen}
        novelId={novel.id}
        categories={categories}
        entries={entries}
        onClose={() => setCategoryManagerOpen(false)}
      />

      <TrashSheet open={trashOpen} novelId={novel.id} onClose={() => setTrashOpen(false)} />

      <GlossarySheet
        open={glossaryOpen}
        novelId={novel.id}
        /* 译名对不上的章节要去写作页改。关掉抽屉再跳，
           免得回来时一个悬着的抽屉盖在另一个页面上 */
        onOpenChapter={(chapterId) => {
          setGlossaryOpen(false);
          navigate('/write', { state: { openChapterId: chapterId } });
        }}
        onClose={() => setGlossaryOpen(false)}
      />

      {importOpen ? (
        <ImportScreen novel={novel} categories={categories} onClose={() => setImportOpen(false)} />
      ) : null}
    </Page>
  );
}
