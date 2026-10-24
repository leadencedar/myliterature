import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { mergeGlossary, relevantGlossary, type GlossaryEntry } from '@/domain/glossary';
import { detectLanguage, languageLabel } from '@/domain/language';
import { countWords } from '@/domain/primitives';
import type { Chapter, Novel, StyleProfile } from '@/domain/schema';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import {
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
  isTranslated,
  parseTranslation,
} from './translate';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; text: string }
  | { kind: 'done'; text: string; glossary: GlossaryEntry[] }
  | { kind: 'error'; message: string; detail?: string };

interface TranslateSheetProps {
  open: boolean;
  novel: Novel;
  style: StyleProfile;
  chapter: Chapter;
  /** 编辑器里的最新正文，可能还没落盘 */
  content: string;
  onClose: () => void;
  /** 采用译文。由编辑器负责落盘与撤销栈 */
  onAccept: (translated: string, sourceText: string) => void | Promise<void>;
}

/**
 * 单章翻译。
 *
 * 导入流程里已经有一遍批量翻译，这里补的是「已经导入完了、后来才想翻某一章」
 * 的情况 —— 也包括手动粘进来的外文片段。
 *
 * **不走 Proposal 管道**：三千字译文做字段级 diff 不提供任何信息。
 * 与整章生成同一套交互 —— 可编辑预览 + 采用 / 放弃。
 */
export function TranslateSheet({
  open,
  novel,
  style,
  chapter,
  content,
  onClose,
  onAccept,
}: TranslateSheetProps) {
  const repository = useRepository();
  const llm = useLlm();

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [edited, setEdited] = useState('');

  const dataRef = useRef({ novel, style, chapter, content });
  dataRef.current = { novel, style, chapter, content };

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPhase({ kind: 'idle' });
      setEdited('');
    }
    wasOpen.current = open;
  }, [open]);

  const language = detectLanguage(content);
  const alreadyTranslated = isTranslated(chapter);

  /**
   * 采用译文时才把本章译名记进作品级译名表。
   *
   * 放弃的译文不该留下约束 —— 用户否掉了这一版，它挑的名字也就不该绑住后面的章节。
   */
  async function accept() {
    if (phase.kind !== 'done') return;
    if (phase.glossary.length > 0) {
      await repository.mergeGlossaryTerms(dataRef.current.novel.id, phase.glossary);
    }
    await onAccept(edited, dataRef.current.content);
  }

  const runRef = useRef(async () => {
    const data = dataRef.current;
    const source = data.content;
    if (!source.trim()) {
      setPhase({ kind: 'error', message: '这一章还没有正文' });
      return;
    }

    setPhase({ kind: 'running', text: '' });
    let streamed = '';
    try {
      /**
       * 沿用这本书已有的译名。
       *
       * 主来源是**作品级译名表**（`glossaries` 表）—— 它和导入时的批量翻译共用
       * 同一份，所以单章补译不会给同一个人另起一个名字。
       *
       * 知识库条目里的拉丁别名作为补充：那也是用户确认过的译名映射，
       * 能兜住「译名表还空着但条目已经建好」的情形（比如从旧备份恢复）。
       * 两者用 mergeGlossary 合并，译名表在前，所以冲突时以它为准。
       */
      const [row, entries] = await Promise.all([
        repository.getGlossary(data.novel.id),
        repository.listEntries(data.novel.id),
      ]);
      const fromEntries: GlossaryEntry[] = entries.flatMap((entry) =>
        entry.aliases
          // 别名里的拉丁文写法就是原文名，条目标题是它的中文译名
          .filter((alias) => detectLanguage(alias) !== 'zh' && /[A-Za-z]/u.test(alias))
          .map((alias) => ({ source: alias, target: entry.title })),
      );
      const glossary = mergeGlossary(row?.terms ?? [], fromEntries);

      const result = await llm.runStream(
        'translate-chapter',
        {
          system: buildTranslateSystemPrompt(data.novel, data.style),
          user: buildTranslateUserPrompt({
            index: data.chapter.index,
            title: data.chapter.title,
            sourceText: source,
            glossary: relevantGlossary(glossary, source),
          }),
        },
        {
          onText: (delta) => {
            streamed += delta;
            setPhase({ kind: 'running', text: parseTranslation(streamed).text });
          },
        },
      );

      const parsed = parseTranslation(result.content || streamed);
      if (!parsed.text.trim()) {
        setPhase({ kind: 'error', message: '模型没有返回译文' });
        return;
      }
      setEdited(parsed.text);
      setPhase({ kind: 'done', text: parsed.text, glossary: parsed.glossary });
    } catch (cause) {
      if (cause instanceof LlmError && cause.kind === 'aborted') {
        setPhase({ kind: 'idle' });
        return;
      }
      const error = cause instanceof LlmError ? cause : undefined;
      setPhase({
        kind: 'error',
        message: error?.message ?? (cause instanceof Error ? cause.message : '翻译失败'),
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  return (
    <Sheet
      open={open}
      title="译成中文"
      description="译文会替换本章正文，原文自动留一份。"
      onClose={onClose}
      footer={
        phase.kind === 'done' ? (
          <>
            <Button variant="secondary" size="lg" block onClick={onClose}>
              放弃
            </Button>
            <Button
              variant="primary"
              size="lg"
              block
              disabled={!edited.trim()}
              onClick={() => void accept()}
            >
              采用译文
            </Button>
          </>
        ) : undefined
      }
    >
      {phase.kind === 'idle' || phase.kind === 'error' ? (
        <>
          <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
            <p className="text-sm text-ink-900">
              本章 {countWords(content)} 字 · 识别为{languageLabel(language)}
            </p>
            {language === 'zh' ? (
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                这一章看起来已经是中文了，通常不需要翻译。
              </p>
            ) : null}
            {alreadyTranslated ? (
              <p className="mt-1 text-xs leading-relaxed text-accent">
                这一章译过一次了。再译一遍会覆盖现有译文，并把当前正文存为新的原文备份。
              </p>
            ) : null}
          </div>

          <p className="text-xs leading-relaxed text-ink-500">
            翻译按字数计费，成本大致相当于让 AI 重写一遍同样长度的文字。
            译文力求忠实，不会增删情节；作品的文体与文风只用来决定措辞。
          </p>

          <Button
            variant="primary"
            size="lg"
            block
            disabled={!llm.configured || !content.trim()}
            onClick={() => void runRef.current()}
          >
            {alreadyTranslated ? '重新翻译本章' : '翻译本章'}
          </Button>

          {!llm.configured ? (
            <p className="text-xs text-ink-500">需要先在「设置」里配置模型。</p>
          ) : null}

          {phase.kind === 'error' ? (
            <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5">
              <p className="text-sm text-seal">{phase.message}</p>
              {phase.detail ? (
                <p className="mt-1 break-words text-xs text-ink-500">{phase.detail}</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {phase.kind === 'running' ? (
        <>
          <p aria-live="polite" className="text-sm text-ink-500">
            正在翻译…
          </p>
          <p className="max-h-[50dvh] overflow-y-auto font-reading text-sm leading-relaxed whitespace-pre-wrap text-ink-700">
            {phase.text || '…'}
          </p>
        </>
      ) : null}

      {phase.kind === 'done' ? (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-700">译文（可直接修改）</span>
            <textarea
              value={edited}
              aria-label="译文（可直接修改）"
              rows={14}
              onChange={(event) => setEdited(event.target.value)}
              className="w-full resize-none rounded-xl border border-ink-100 bg-paper-raised px-3 py-3 font-reading text-[0.9375rem] leading-[1.9] text-ink-900 focus:border-ink-500 focus:outline-none"
            />
          </label>
          <p className="text-xs text-ink-500">译文 {countWords(edited)} 字</p>

          {phase.glossary.length > 0 ? (
            <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
              <p className="text-xs font-medium text-ink-700">本章译名</p>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {phase.glossary.map((entry) => (
                  <li key={entry.source} className="text-xs text-ink-700">
                    {entry.source} → {entry.target}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                采用后会记进作品的译名表，后续章节与以后再导入的素材都会沿用。
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}
