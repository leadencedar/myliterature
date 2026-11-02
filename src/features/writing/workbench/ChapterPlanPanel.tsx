import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Chapter, KnowledgeEntry, OutlineNode } from '@/domain/schema';
import { formatWordCount } from '@/ui/format';

type SectionKey = 'goal' | 'materials' | 'memo' | 'brief';

interface ChapterPlanPanelProps {
  chapter: Chapter;
  /** 主线章节关联的大纲节点；外传/未关联时为空 */
  outlineNode?: OutlineNode;
  /** 已解析的关联资料（linkedEntryIds 对应的条目） */
  linkedEntries: readonly KnowledgeEntry[];
  /** 外传章节的推演细纲；主线为空 */
  sideBrief: string;
  onSaveGoal: (next: string) => Promise<boolean>;
  onSaveNote: (next: string) => Promise<boolean>;
  onClose: () => void;
}

/**
 * 右栏「本章」（Q4=B / Q5=A 上下文检查器）。
 *
 * 只读为主、就地编辑为辅：
 * - 一次只展开一节，默认展开「本章目标」；
 * - 目标和备忘只在编辑时才展示 textarea，保存后回到摘要；
 * - 资料只显示计数 + 前几条，完整列表走知识库；
 * - AI 操作不在这里，固定在编辑器底栏。
 */
export function ChapterPlanPanel({
  chapter,
  outlineNode,
  linkedEntries,
  sideBrief,
  onSaveGoal,
  onSaveNote,
  onClose,
}: ChapterPlanPanelProps) {
  const [openSection, setOpenSection] = useState<SectionKey>(outlineNode ? 'goal' : 'memo');
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState(outlineNode?.synopsis ?? '');
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(chapter.note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 切章时重置展开/编辑/草稿状态（面板本身复用时也必须清干净）
  useEffect(() => {
    setOpenSection(outlineNode ? 'goal' : 'memo');
    setEditingGoal(false);
    setGoalDraft(outlineNode?.synopsis ?? '');
    setEditingNote(false);
    setNoteDraft(chapter.note ?? '');
    setError(null);
  }, [chapter.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 外部数据（保存后回写 / 刷新）同步草稿；保存成功时父级会带来新值
  useEffect(() => {
    setGoalDraft(outlineNode?.synopsis ?? '');
  }, [outlineNode?.synopsis]);

  useEffect(() => {
    setNoteDraft(chapter.note ?? '');
  }, [chapter.note]);

  async function saveGoal() {
    setSaving(true);
    setError(null);
    const saved = await onSaveGoal(goalDraft.trim());
    setSaving(false);
    if (saved) setEditingGoal(false);
    else setError('本章目标保存失败，请重试。');
  }

  async function saveNote() {
    setSaving(true);
    setError(null);
    const saved = await onSaveNote(noteDraft);
    setSaving(false);
    if (saved) setEditingNote(false);
    else setError('作者备忘保存失败，请重试。');
  }

  function toggleSection(key: SectionKey) {
    if (openSection === key) return;
    setOpenSection(key);
    setEditingGoal(false);
    setEditingNote(false);
    setError(null);
  }

  function sectionProps(key: SectionKey) {
    return {
      'aria-expanded': openSection === key,
      'aria-controls': `wb-panel-${key}`,
    } as const;
  }

  return (
    <div className="flex h-full flex-col" data-testid="chapter-plan-panel">
      <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-900">本章</h2>
          <p className="mt-0.5 truncate text-[0.6875rem] text-ink-500">
            {chapter.title || `第 ${chapter.index} 章`} · {formatWordCount(chapter.wordCount)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭本章面板"
          className="tap-target shrink-0 rounded-lg px-2 py-1 text-xs text-ink-500 hover:bg-paper-sunken"
        >
          关闭
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {error ? (
          <p
            role="alert"
            className="mb-2 rounded-lg bg-accent-soft px-2.5 py-2 text-xs text-accent"
          >
            {error}
          </p>
        ) : null}

        {/* 本章目标 */}
        <section className="border-b border-ink-100 py-2.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={() => toggleSection('goal')}
            {...sectionProps('goal')}
          >
            <span className="text-xs font-medium text-ink-900">本章目标</span>
            <span className="text-[0.625rem] text-ink-500">
              {outlineNode ? '大纲梗概' : '未关联大纲'}
            </span>
            <span className="ml-auto text-[0.625rem] text-ink-300">
              {openSection === 'goal' ? '收起' : '展开'}
            </span>
          </button>
          <div id="wb-panel-goal" hidden={openSection !== 'goal'}>
            {outlineNode ? (
              editingGoal ? (
                <div className="mt-2">
                  <textarea
                    aria-label="本章目标"
                    value={goalDraft}
                    onChange={(event) => setGoalDraft(event.target.value)}
                    rows={4}
                    className="w-full resize-y rounded-lg border border-ink-100 bg-paper px-2.5 py-2 text-xs leading-relaxed text-ink-900 focus:border-ink-500 focus:outline-none"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void saveGoal()}
                      className="rounded-lg bg-ink-900 px-2.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50"
                    >
                      {saving ? '保存中…' : '保存'}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setGoalDraft(outlineNode.synopsis);
                        setEditingGoal(false);
                        setError(null);
                      }}
                      className="rounded-lg border border-ink-100 px-2.5 py-1.5 text-xs text-ink-500"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-700">
                    {goalDraft || '还没有写本章目标。'}
                  </p>
                  <div className="mt-1 flex items-center gap-3 text-[0.625rem] text-ink-500">
                    <button
                      type="button"
                      onClick={() => setEditingGoal(true)}
                      className="text-accent"
                    >
                      编辑
                    </button>
                    {outlineNode.targetWords ? (
                      <span>目标 {formatWordCount(outlineNode.targetWords)}</span>
                    ) : null}
                  </div>
                </>
              )
            ) : (
              <p className="mt-1 text-[0.6875rem] leading-relaxed text-ink-500">
                本章没有关联大纲节点，目标可先写在大纲节点里；外传章节请看「本章细纲」。
              </p>
            )}
          </div>
        </section>

        {/* 资料 */}
        <section className="border-b border-ink-100 py-2.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={() => toggleSection('materials')}
            {...sectionProps('materials')}
          >
            <span className="text-xs font-medium text-ink-900">资料</span>
            <span className="text-[0.625rem] text-ink-500">{linkedEntries.length} 条</span>
            <span className="ml-auto text-[0.625rem] text-ink-300">
              {openSection === 'materials' ? '收起' : '展开'}
            </span>
          </button>
          <div id="wb-panel-materials" hidden={openSection !== 'materials'}>
            {linkedEntries.length === 0 ? (
              <p className="mt-1 text-[0.6875rem] text-ink-500">还没有关联资料。</p>
            ) : (
              <>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {linkedEntries.slice(0, 5).map((entry) => (
                    <li
                      key={entry.id}
                      className="rounded-full border border-ink-100 px-2 py-0.5 text-[0.625rem] text-ink-700"
                    >
                      {entry.title}
                    </li>
                  ))}
                </ul>
                <Link
                  to="/knowledge"
                  className="mt-2 inline-block text-[0.625rem] text-accent hover:underline"
                >
                  查看全部资料 →
                </Link>
              </>
            )}
          </div>
        </section>

        {/* 作者备忘 */}
        <section className="border-b border-ink-100 py-2.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={() => toggleSection('memo')}
            {...sectionProps('memo')}
          >
            <span className="text-xs font-medium text-ink-900">作者备忘</span>
            <span className="text-[0.625rem] text-ink-500">
              {noteDraft.trim() ? '有内容' : '空'}
            </span>
            <span className="ml-auto text-[0.625rem] text-ink-300">
              {openSection === 'memo' ? '收起' : '展开'}
            </span>
          </button>
          <div id="wb-panel-memo" hidden={openSection !== 'memo'}>
            {editingNote ? (
              <div className="mt-2">
                <textarea
                  aria-label="作者备忘"
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  rows={4}
                  maxLength={5000}
                  placeholder="待改点、下一步想法…只给自己看，不进入 AI 或导出。"
                  className="w-full resize-y rounded-lg border border-ink-100 bg-paper px-2.5 py-2 text-xs leading-relaxed text-ink-900 focus:border-ink-500 focus:outline-none"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveNote()}
                    className="rounded-lg bg-ink-900 px-2.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50"
                  >
                    {saving ? '保存中…' : '保存'}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setNoteDraft(chapter.note ?? '');
                      setEditingNote(false);
                      setError(null);
                    }}
                    className="rounded-lg border border-ink-100 px-2.5 py-1.5 text-xs text-ink-500"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-ink-700">
                  {noteDraft.trim() || '还没有备忘。'}
                </p>
                <button
                  type="button"
                  onClick={() => setEditingNote(true)}
                  className="mt-1 text-[0.625rem] text-accent"
                >
                  编辑
                </button>
              </>
            )}
          </div>
        </section>

        {/* 本章细纲（外传） */}
        {sideBrief ? (
          <section className="py-2.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left"
              onClick={() => toggleSection('brief')}
              {...sectionProps('brief')}
            >
              <span className="text-xs font-medium text-ink-900">本章细纲</span>
              <span className="text-[0.625rem] text-ink-500">外传</span>
              <span className="ml-auto text-[0.625rem] text-ink-300">
                {openSection === 'brief' ? '收起' : '展开'}
              </span>
            </button>
            <div id="wb-panel-brief" hidden={openSection !== 'brief'}>
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-paper px-2.5 py-2 text-[0.6875rem] leading-relaxed text-ink-700">
                {sideBrief}
              </p>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
