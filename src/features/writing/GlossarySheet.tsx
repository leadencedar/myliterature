import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import { findGlossaryDrift, normalizeGlossarySource, type GlossaryEntry } from '@/domain/glossary';
import { chapterLabel } from '@/domain/sideStory';
import { Button, IconButton } from '@/ui/Button';
import { TextField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
import { TrashIcon } from '@/ui/icons';

interface GlossarySheetProps {
  open: boolean;
  novelId: string;
  /** 跳到某一章去处理译名不一致。译名表在知识库，章节正文在写作页，跨页跳转由调用方接线 */
  onOpenChapter: (chapterId: string) => void;
  onClose: () => void;
}

/** 稳定的空数组，免得加载期间每次渲染都让一致性检查重算 */
const NO_TERMS: GlossaryEntry[] = [];

/**
 * 译名表的查看与编辑。
 *
 * 译名表是**作品级的持久数据**，翻译时会强制沿用它 —— 所以必须能改。
 * 「想改译名就去正文里改」是不成立的：改正文不会改译名表，
 * 后面的章节照旧会用回原来的译法。
 *
 * 这里的修改走 `setGlossaryTerm`（覆盖语义），与模型产出走的
 * `mergeGlossaryTerms`（先到先得）刻意不同 —— 作者的决定当然可以推翻已有译名。
 */
export function GlossarySheet({ open, novelId, onOpenChapter, onClose }: GlossarySheetProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const driftHeadingId = useId();

  const { data, loading } = useRepoQuery(
    async (repo) => {
      const [glossary, chapters, sideStories] = await Promise.all([
        repo.getGlossary(novelId),
        repo.listChapters(novelId),
        repo.listSideStories(novelId),
      ]);
      return { glossary, chapters, sideStories };
    },
    [novelId],
  );
  const terms = data?.glossary?.terms ?? NO_TERMS;
  const chapters = data?.chapters;
  const sideStories = data?.sideStories ?? [];

  /** 「第 3 章 标题」/「外传·青冥旧事 第 3 章 标题」。按 drift 的 id 回查完整章节才知道属于哪条线 */
  function driftLabel(id: string, fallback: { index: number; title: string }): string {
    const chapter = chapters?.find((item) => item.id === id) ?? {
      ...fallback,
      sideStoryId: null,
    };
    return `${chapterLabel(chapter, sideStories)}${chapter.title ? ` ${chapter.title}` : ''}`;
  }

  /**
   * 已经译好的正文有没有跟上译名表。
   *
   * 用已保存的译名算，不用 `drafts` —— 正在输入框里改的那一版还没写进库，
   * 更没影响过任何正文，拿它去比对只会在打字过程中疯狂闪烁。
   *
   * 几百条译名 × 几十万字，所以结果缓存起来，别在每次按键重渲染时重算。
   */
  const drifts = useMemo(
    () => (chapters ? findGlossaryDrift(terms, chapters) : []),
    [terms, chapters],
  );
  const driftCounts = new Map(drifts.map((drift) => [drift.source, drift.chapters.length]));

  /** 每个原文名对应的待保存译名，只放被改过的 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newSource, setNewSource] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 只在「关闭 → 打开」时清空，避免后台刷新把用户正在改的输入冲掉
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setDrafts({});
      setNewSource('');
      setNewTarget('');
      setError('');
    }
    wasOpen.current = open;
  }, [open]);

  const dirtyCount = Object.keys(drafts).length;

  function editTarget(source: string, value: string) {
    setDrafts((previous) => {
      const next = { ...previous };
      const original = terms.find((term) => term.source === source)?.target ?? '';
      // 改回原值就不再算改动，免得「保存」按钮一直亮着
      if (value === original) delete next[source];
      else next[source] = value;
      return next;
    });
  }

  async function saveEdits() {
    setError('');
    const pending = Object.entries(drafts).filter(([, target]) => target.trim());
    if (pending.length === 0) {
      setError('译名不能为空。想去掉某一条请用右侧的删除');
      return;
    }
    setBusy(true);
    try {
      for (const [source, target] of pending) {
        await repository.setGlossaryTerm(novelId, source, target);
      }
      invalidate();
      setDrafts({});
    } finally {
      setBusy(false);
    }
  }

  async function addTerm() {
    setError('');
    const source = newSource.trim();
    const target = newTarget.trim();
    if (!source || !target) {
      setError('原文名与译名都要填');
      return;
    }
    if (
      terms.some((term) => normalizeGlossarySource(term.source) === normalizeGlossarySource(source))
    ) {
      setError(`「${source}」已经在表里了，直接改它的译名即可`);
      return;
    }
    setBusy(true);
    try {
      await repository.setGlossaryTerm(novelId, source, target);
      invalidate();
      setNewSource('');
      setNewTarget('');
    } finally {
      setBusy(false);
    }
  }

  async function removeTerm(source: string) {
    setBusy(true);
    try {
      await repository.removeGlossaryTerm(novelId, source);
      invalidate();
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[source];
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      title="译名表"
      description="翻译外文章节时会强制沿用这里的译法，保证同一个名字全书只有一个译名。"
      onClose={onClose}
      footer={
        dirtyCount > 0 ? (
          <>
            <Button variant="secondary" size="lg" block onClick={() => setDrafts({})}>
              放弃改动
            </Button>
            <Button
              variant="primary"
              size="lg"
              block
              disabled={busy}
              onClick={() => void saveEdits()}
            >
              保存 {dirtyCount} 处改动
            </Button>
          </>
        ) : undefined
      }
    >
      {loading ? (
        <p className="py-6 text-center text-sm text-ink-300">加载中…</p>
      ) : (
        <>
          {/* 不一致报告放最前面：译名表跑到后期会有几百行，
              指望用户滚着找哪几行被标了是不现实的 */}
          {drifts.length > 0 ? (
            <section
              aria-labelledby={driftHeadingId}
              className="flex flex-col gap-2 rounded-xl border border-accent/30 bg-accent-soft p-3"
            >
              <h3 id={driftHeadingId} className="text-sm font-medium text-ink-900">
                {drifts.length} 条译名与已有译文不一致
              </h3>
              <p className="text-xs leading-relaxed text-ink-700">
                下面这些章节的原文出现过对应专名，译文里却找不到现在登记的译法 ——
                通常是改了译名之后没有重译。点章节名过去处理。
              </p>
              <ul className="flex flex-col gap-2.5">
                {drifts.map((drift) => (
                  <li key={drift.source} className="flex flex-col gap-1">
                    <p className="text-xs text-ink-700">
                      <span className="text-ink-900">
                        {drift.source} → {drift.target}
                      </span>
                      <span className="ml-1.5 text-accent">{drift.chapters.length} 章未采用</span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {drift.chapters.map((chapter) => (
                        <button
                          key={chapter.id}
                          type="button"
                          onClick={() => onOpenChapter(chapter.id)}
                          className="rounded-lg border border-accent/40 bg-paper-raised px-2 py-1 text-xs text-ink-900 enabled:hover:bg-paper-sunken active:bg-paper-sunken"
                        >
                          {driftLabel(chapter.id, chapter)}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {terms.length === 0 ? (
            <p className="text-sm leading-relaxed text-ink-500">
              还没有译名。翻译外文章节时会自动记下模型采用的专名译法；
              你也可以在这里先把关键人名定下来，翻译时会照着译。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {terms.map((term) => {
                const draft = drafts[term.source];
                const driftCount = driftCounts.get(term.source) ?? 0;
                return (
                  <li
                    key={term.source}
                    className={[
                      'flex flex-col gap-1 rounded-xl border bg-paper-raised px-3 py-2',
                      // 标出来是为了在长列表里能扫到；具体是哪几章看上面的报告
                      driftCount > 0 ? 'border-accent/40' : 'border-ink-100',
                    ].join(' ')}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="min-w-0 flex-1 truncate text-sm text-ink-700"
                        title={term.source}
                      >
                        {term.source}
                      </span>
                      <span aria-hidden="true" className="shrink-0 text-ink-300">
                        →
                      </span>
                      <input
                        value={draft ?? term.target}
                        aria-label={`${term.source} 的译名`}
                        onChange={(event) => editTarget(term.source, event.target.value)}
                        className="min-w-0 flex-1 rounded-lg border border-ink-100 bg-paper px-2 py-1.5 text-sm text-ink-900 focus:border-ink-500 focus:outline-none"
                      />
                      <IconButton
                        label={`删除 ${term.source} 的译名`}
                        disabled={busy}
                        onClick={() => void removeTerm(term.source)}
                      >
                        <TrashIcon className="h-4 w-4" />
                      </IconButton>
                    </div>
                    {driftCount > 0 ? <p className="text-xs text-accent">译文不一致</p> : null}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-col gap-2 rounded-xl bg-paper-sunken p-3">
            <p className="text-sm font-medium text-ink-700">添加译名</p>
            <TextField
              label="原文名"
              value={newSource}
              placeholder="Ashford"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => setNewSource(event.target.value)}
            />
            <TextField
              label="中文译名"
              value={newTarget}
              placeholder="阿什福德"
              onChange={(event) => setNewTarget(event.target.value)}
            />
            <Button
              variant="secondary"
              size="lg"
              block
              disabled={busy}
              onClick={() => void addTerm()}
            >
              添加
            </Button>
          </div>

          {error ? (
            <p role="alert" className="text-xs text-seal">
              {error}
            </p>
          ) : null}

          {terms.length > 0 ? (
            <p className="text-xs leading-relaxed text-ink-500">
              改了译名只影响之后翻译的章节 —— 已经译好的正文不会自动跟着变。
              对不上的章节会列在上面，去那一章点「重译」即可。
            </p>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
