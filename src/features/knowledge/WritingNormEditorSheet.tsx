import { useEffect, useRef, useState } from 'react';
import { ZodError } from 'zod';
import { formatTokens } from '@/context/tokens';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import type { WritingNorm, WritingNormScope } from '@/domain/schema';
import {
  ALL_NORM_SCOPES,
  DIFF_NOTE_TEMPLATE,
  DIFF_NOTE_TITLE,
  NORM_LINK_WARN,
  NORM_SCOPES,
  NORM_TOKEN_WARN,
  condensedTitle,
  countLinks,
  normalizeNormScopes,
  validateNormDraft,
} from '@/domain/writingNorm';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { normTokens } from '@/prompt/sections';
import { Button } from '@/ui/Button';
import { Toggle } from '@/ui/Controls';
import { TextAreaField, TextField } from '@/ui/Field';
import { ConfirmDialog, Sheet } from '@/ui/Sheet';
import {
  ACCEPTED_EXTENSIONS,
  ENCODING_LABELS,
  readManuscriptFile,
  type ManuscriptReadResult,
} from '../import/readManuscript';
import { NORM_CONDENSE_SYSTEM, buildCondenseUserPrompt } from './normCondense';

/** 「从文件新建」时由区块读好文件再交给面板：读文件失败的提示属于区块，面板只管成功的结果 */
export interface NormFileSeed {
  title: string;
  content: string;
  /** 「已读入《文件名》，识别为 …」 */
  notice: string;
}

interface WritingNormEditorSheetProps {
  open: boolean;
  novelId: string;
  /** 传入为编辑，不传为新建 */
  norm?: WritingNorm | undefined;
  /** 仅新建时有效：从文件新建的预填内容 */
  seed?: NormFileSeed | undefined;
  onClose: () => void;
  /** AI 精简另存成功：面板随即关闭，提示由区块显示（面板关了，提示放在面板里没人看得见） */
  onCondensed: (title: string) => void;
}

interface NormDraft {
  title: string;
  content: string;
  enabled: boolean;
  scopes: WritingNormScope[];
}

type CondenseState =
  | { phase: 'idle' }
  | { phase: 'streaming'; text: string }
  | { phase: 'preview'; text: string; truncated: boolean }
  | { phase: 'error'; message: string };

function draftFrom(norm: WritingNorm | undefined, seed: NormFileSeed | undefined): NormDraft {
  if (norm) {
    return {
      title: norm.title,
      content: norm.content,
      enabled: norm.enabled,
      scopes: [...norm.scopes],
    };
  }
  return {
    title: seed?.title ?? '',
    content: seed?.content ?? '',
    enabled: true,
    scopes: [...ALL_NORM_SCOPES],
  };
}

/** 读入提示行：编码识别结果要让作者看见，GB18030 被当成 UTF-8 时第一眼就能发现 */
export function fileNotice(fileName: string, result: ManuscriptReadResult): string {
  const prefix =
    result.format === 'rtf'
      ? `已读入《${fileName}》，已从 RTF 提取纯文本`
      : `已读入《${fileName}》，识别为 ${ENCODING_LABELS[result.encoding]}`;
  return prefix + (result.lossy ? '。其中少量字符无法识别，已用 � 占位' : '');
}

/** 把异常转成给作者看的中文：ZodError 的 message 是 JSON，绝不能原样显示 */
function messageOf(cause: unknown, fallback: string): string {
  if (cause instanceof ZodError) return cause.issues[0]?.message ?? fallback;
  if (cause instanceof Error) return cause.message;
  return fallback;
}

/**
 * 写作规范的新建 / 编辑面板。
 *
 * 保存路径不碰模型、不进提案管道：规范是作者自己的文字，不是 AI 产出（产品文档 5.1）。
 * 正文就是 textarea 的原值，不 trim、不改写。
 * 唯一经过模型的是「AI 精简」，它的结果走「可编辑预览 → 另存为新规范 / 放弃」，原文不被覆盖。
 */
export function WritingNormEditorSheet({
  open,
  novelId,
  norm,
  seed,
  onClose,
  onCondensed,
}: WritingNormEditorSheetProps) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const llm = useLlm();

  const [draft, setDraft] = useState<NormDraft>(() => draftFrom(norm, seed));
  const [notice, setNotice] = useState<string | undefined>(seed?.notice);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [condense, setCondense] = useState<CondenseState>({ phase: 'idle' });
  const [condenseError, setCondenseError] = useState<string | undefined>();
  const [condenseSaving, setCondenseSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const appendInputRef = useRef<HTMLInputElement>(null);

  // 只在「关闭 → 打开」这一刻重置草稿，与 StyleSheet 同样的防冲刷写法：
  // 列表在后台刷新时 norm 是新对象引用，拿它当依赖会冲掉正在输入的内容
  const seedRef = useRef({ norm, seed });
  seedRef.current = { norm, seed };
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const current = seedRef.current;
      setDraft(draftFrom(current.norm, current.seed));
      setNotice(current.norm ? undefined : current.seed?.notice);
      setError(undefined);
      setCondense({ phase: 'idle' });
      setCondenseError(undefined);
    }
    // 关闭面板即取消进行中的精简：什么都不写，与整章生成一致
    if (!open && wasOpen.current) {
      abortRef.current?.abort();
      abortRef.current = null;
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * 精简进行中或预览时锁住草稿：精简的对象是库里那份，这时再改草稿，
   * 作者会以为精简的是改过的内容；另存后原文停用，改了的草稿也无处可去。
   */
  const locked = condense.phase === 'streaming' || condense.phase === 'preview';

  /** 有未保存修改时不让精简：精简的必须是库里真实存在的内容（遗留 #2） */
  const dirty =
    norm !== undefined &&
    (draft.title !== norm.title ||
      draft.content !== norm.content ||
      draft.enabled !== norm.enabled ||
      normalizeNormScopes(draft.scopes).join() !== normalizeNormScopes(norm.scopes).join());

  // 与列表、注入清单同一口径（normTokens），保存后数字不会跳
  const draftTokens = normTokens({ title: draft.title, content: draft.content });
  const linkCount = countLinks(draft.content);

  function patch(next: Partial<NormDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  function toggleScope(scope: WritingNormScope) {
    setDraft((current) => ({
      ...current,
      scopes: normalizeNormScopes(
        current.scopes.includes(scope)
          ? current.scopes.filter((item) => item !== scope)
          : [...current.scopes, scope],
      ),
    }));
  }

  /** 追加到末尾而不是光标处：手机上光标位置不可靠，追加更可预期（与导入页多文件追加相同） */
  function appendText(text: string) {
    setDraft((current) => ({
      ...current,
      content: current.content ? `${current.content}\n\n${text}` : text,
    }));
  }

  async function appendFile(file: File | undefined) {
    if (!file) return;
    setError(undefined);
    try {
      const result = await readManuscriptFile(file);
      appendText(result.text);
      setNotice(fileNotice(file.name, result));
    } catch (cause) {
      setError(messageOf(cause, '文件读取失败'));
    }
  }

  function insertTemplate() {
    setDraft((current) =>
      current.content.trim() === ''
        ? {
            ...current,
            content: DIFF_NOTE_TEMPLATE,
            title: current.title.trim() === '' ? DIFF_NOTE_TITLE : current.title,
          }
        : { ...current, content: `${current.content}\n\n${DIFF_NOTE_TEMPLATE}` },
    );
  }

  async function save() {
    const problem = validateNormDraft({ title: draft.title, content: draft.content });
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      // content 就是 textarea 的原值：作者的文字，存什么就是什么
      const input = {
        title: draft.title,
        content: draft.content,
        enabled: draft.enabled,
        scopes: draft.scopes,
      };
      if (norm) await repository.updateWritingNorm(norm.id, input);
      else await repository.createWritingNorm(novelId, input);
      invalidate();
      onClose();
    } catch (cause) {
      // 失败保持打开、草稿不丢
      setError(messageOf(cause, '保存失败'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!norm) return;
    try {
      await repository.deleteWritingNorm(norm.id);
    } catch (cause) {
      // 与 save() 一致：失败要让作者看见。先关确认框，提示才不会被它挡住；面板保持打开
      setConfirmDelete(false);
      setError(messageOf(cause, '删除失败'));
      return;
    }
    invalidate();
    setConfirmDelete(false);
    onClose();
  }

  async function startCondense() {
    if (!norm) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCondense({ phase: 'streaming', text: '' });
    setCondenseError(undefined);

    let streamed = '';
    try {
      const result = await llm.runStream(
        'norm-condense',
        {
          system: NORM_CONDENSE_SYSTEM,
          // 精简库里那份而不是草稿：dirty 时按钮已禁用，两者此时相同
          user: buildCondenseUserPrompt(norm),
          signal: controller.signal,
        },
        {
          onText: (delta) => {
            streamed += delta;
            setCondense({ phase: 'streaming', text: streamed });
          },
        },
      );
      if (abortRef.current !== controller) return;
      const text = result.content || streamed;
      if (!text.trim()) {
        setCondense({ phase: 'error', message: '模型没有返回内容，可以再试一次' });
        return;
      }
      setCondense({ phase: 'preview', text, truncated: result.finishReason === 'length' });
    } catch (cause) {
      // 面板已关或已重新开始：这次的结果不再属于任何人
      if (abortRef.current !== controller) return;
      if (cause instanceof LlmError && cause.kind === 'aborted') {
        // 作者点了停止：已经流出的内容进预览（与整章生成一致），为空就回到编辑态
        setCondense(
          streamed.trim()
            ? { phase: 'preview', text: streamed, truncated: false }
            : { phase: 'idle' },
        );
        return;
      }
      setCondense({ phase: 'error', message: messageOf(cause, '精简失败') });
    }
  }

  async function saveCondensed() {
    if (!norm || condense.phase !== 'preview') return;
    const title = condensedTitle(norm.title);
    // 另存前先预检（遗留 #3）：有错就在预览下方显示中文文案，不调仓储
    const problem = validateNormDraft({ title, content: condense.text });
    if (problem) {
      setCondenseError(problem);
      return;
    }
    setCondenseSaving(true);
    setCondenseError(undefined);
    try {
      const saved = await repository.saveCondensedWritingNorm(norm.id, {
        title,
        content: condense.text,
      });
      invalidate();
      onCondensed(saved.title);
      onClose();
    } catch (cause) {
      // 失败保留面板与预览，作者改过的精简结果不丢（遗留 #1）
      setCondenseError(messageOf(cause, '另存失败'));
    } finally {
      setCondenseSaving(false);
    }
  }

  const condenseDisabledReason = !llm.configured
    ? '需要先在「设置」里配置模型。'
    : dirty
      ? '先保存再精简。'
      : undefined;

  return (
    <>
      <Sheet
        open={open}
        title={norm ? '编辑写作规范' : '新建写作规范'}
        onClose={onClose}
        footer={
          <Button variant="primary" size="lg" block disabled={saving || locked} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </Button>
        }
      >
        {notice ? <p className="text-xs leading-relaxed text-ink-500">{notice}</p> : null}

        <TextField
          label="标题"
          value={draft.title}
          maxLength={60}
          disabled={locked}
          onChange={(event) => patch({ title: event.target.value })}
        />

        <TextAreaField
          label="正文"
          rows={12}
          value={draft.content}
          disabled={locked}
          placeholder="粘贴或写下这本书的创作约束：时间截面、与原作的差异、提取与写作规则等。"
          hint={
            <>
              <span className="block">{formatTokens(draftTokens)}</span>
              {draftTokens > NORM_TOKEN_WARN ? (
                <span className="block text-seal">较长，每次生成都会带上，可以试试 AI 精简。</span>
              ) : null}
              {linkCount > NORM_LINK_WARN ? (
                <span className="block text-seal">
                  {`其中有 ${linkCount} 个链接。来源表通常不必进提示词，可以删掉或试试 AI 精简。`}
                </span>
              ) : null}
            </>
          }
          onChange={(event) => patch({ content: event.target.value })}
        />

        {/* md 而不是 sm：sm 只有 36px，触控目标须不小于 44px（NFR7） */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="md"
            disabled={locked}
            onClick={() => appendInputRef.current?.click()}
          >
            上传文件追加
          </Button>
          <input
            ref={appendInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(',')}
            aria-label="追加的规范文件"
            className="sr-only"
            disabled={locked}
            onChange={(event) => {
              void appendFile(event.target.files?.[0]);
              // 清空 value，否则连续选同一个文件不会再触发 change
              event.target.value = '';
            }}
          />
          <Button variant="secondary" size="md" disabled={locked} onClick={insertTemplate}>
            插入差异说明模板
          </Button>
        </div>

        {/* 不用共享的 ChipGroup：它的按钮约 32px 高，改它会影响所有现有用处；
            这里照它的结构写一份本地的，按钮加 tap-target 满足 44px 触控 */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-ink-700">作用范围</legend>
          <p className="text-xs leading-relaxed text-ink-500">
            {NORM_SCOPES.map((scope) => `${scope.label}：${scope.hint}`).join(' · ')}
          </p>
          <div className="flex flex-wrap gap-2">
            {NORM_SCOPES.map((scope) => {
              const active = draft.scopes.includes(scope.id);
              return (
                <button
                  key={scope.id}
                  type="button"
                  aria-pressed={active}
                  disabled={locked}
                  onClick={() => toggleScope(scope.id)}
                  className={[
                    'tap-target inline-flex items-center rounded-full border px-3 py-1.5 text-sm transition-colors',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                    active
                      ? 'border-ink-900 bg-ink-900 text-paper'
                      : 'border-ink-100 bg-paper-raised text-ink-700',
                  ].join(' ')}
                >
                  {scope.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Toggle 没有 disabled 选项；用原生 fieldset[disabled] 锁住它，
            不为这一处再给共享控件加 prop */}
        <fieldset disabled={locked} className="min-w-0">
          <Toggle
            label="启用"
            description="停用后不进入任何提示词，内容保留。"
            checked={draft.enabled}
            onChange={(enabled) => patch({ enabled })}
          />
        </fieldset>

        {error ? (
          <p role="alert" className="rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
            {error}
          </p>
        ) : null}

        {norm ? (
          <div className="flex flex-col gap-3 rounded-xl border border-ink-100 p-3">
            <div>
              <h3 className="text-sm font-medium text-ink-700">AI 精简</h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                把长文压成约束条目，去掉来源链接等不需要进提示词的内容。结果确认后另存为新规范，原文保留并停用。
              </p>
            </div>

            {condense.phase === 'idle' || condense.phase === 'error' ? (
              <>
                <Button
                  variant="secondary"
                  size="md"
                  block
                  disabled={condenseDisabledReason !== undefined}
                  onClick={startCondense}
                >
                  AI 精简
                </Button>
                {condenseDisabledReason ? (
                  <p className="text-xs text-ink-500">{condenseDisabledReason}</p>
                ) : null}
                {condense.phase === 'error' ? (
                  <p role="alert" className="rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
                    {condense.message}
                  </p>
                ) : null}
              </>
            ) : null}

            {condense.phase === 'streaming' ? (
              <>
                <p
                  aria-live="polite"
                  className="max-h-[40dvh] overflow-y-auto rounded-xl bg-paper-sunken px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-ink-900"
                >
                  {condense.text || '…'}
                </p>
                <Button
                  variant="secondary"
                  size="md"
                  block
                  onClick={() => abortRef.current?.abort()}
                >
                  停止
                </Button>
              </>
            ) : null}

            {condense.phase === 'preview' ? (
              <>
                {condense.truncated ? (
                  <p className="text-xs text-seal">结果可能被截断，请核对结尾。</p>
                ) : null}
                <TextAreaField
                  label="精简结果（可直接修改）"
                  rows={12}
                  value={condense.text}
                  hint={`原文 ${formatTokens(normTokens(norm))} → 精简后 ${formatTokens(
                    normTokens({ title: condensedTitle(norm.title), content: condense.text }),
                  )}`}
                  onChange={(event) => {
                    const text = event.target.value;
                    setCondense((current) =>
                      current.phase === 'preview' ? { ...current, text } : current,
                    );
                  }}
                />
                {condenseError ? (
                  <p role="alert" className="rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
                    {condenseError}
                  </p>
                ) : null}
                <Button
                  variant="primary"
                  size="md"
                  block
                  // 只剩空白时另存没有意义，直接禁用而不是等仓储报错（遗留 #3）
                  disabled={condenseSaving || condense.text.trim() === ''}
                  onClick={saveCondensed}
                >
                  {condenseSaving ? '保存中…' : '另存为新规范（原文自动停用）'}
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  block
                  disabled={condenseSaving}
                  onClick={() => {
                    setCondense({ phase: 'idle' });
                    setCondenseError(undefined);
                  }}
                >
                  放弃
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        {norm ? (
          <Button variant="ghost" size="md" block onClick={() => setConfirmDelete(true)}>
            删除这份规范
          </Button>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title="删除这份规范？"
        message="删除后无法恢复。只删除这份规范，不影响已经写好的章节。"
        confirmLabel="删除"
        destructive
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
