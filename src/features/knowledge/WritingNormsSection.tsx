import { useRef, useState } from 'react';
import { formatTokens } from '@/context/tokens';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import type { Novel, WritingNorm } from '@/domain/schema';
import {
  NORMS_TOTAL_TOKEN_WARN,
  NORM_CONTENT_MAX,
  NORM_SCOPES,
  NORM_TITLE_MAX,
  NORM_TOKEN_WARN,
  normalizeNormScopes,
  normsInScope,
} from '@/domain/writingNorm';
import { normTokens } from '@/prompt/sections';
import { Button, IconButton } from '@/ui/Button';
import { Toggle } from '@/ui/Controls';
import { EmptyState, Section } from '@/ui/Page';
import { ArrowDownIcon, ArrowUpIcon } from '@/ui/icons';
import { ACCEPTED_EXTENSIONS, readManuscriptFile } from '../import/readManuscript';
import { WritingNormEditorSheet, fileNotice, type NormFileSeed } from './WritingNormEditorSheet';

/** 文件名去扩展名作标题；截到上限，免得一个长文件名让保存在最后一步失败 */
function titleFromFileName(name: string): string {
  const at = name.lastIndexOf('.');
  return (at > 0 ? name.slice(0, at) : name).slice(0, NORM_TITLE_MAX);
}

/** 按 NORM_SCOPES 的固定顺序渲染，与作者勾选的先后无关；空数组返回 '' */
function scopeText(norm: WritingNorm): string {
  return normalizeNormScopes(norm.scopes)
    .map((scope) => NORM_SCOPES.find((item) => item.id === scope)?.label)
    .filter(Boolean)
    .join('、');
}

/**
 * 知识库页的「写作规范」区块。
 *
 * 放在风格档案之后而不是「管理」区：规范直接影响每次生成，和风格档案同属整本书的底色，
 * 作者需要随时看见启用了哪些。启停与排序直接在列表上做，不必进编辑面板。
 */
export function WritingNormsSection({ novel }: { novel: Novel }) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const { data: norms } = useRepoQuery((repo) => repo.listWritingNorms(novel.id), [novel.id]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WritingNorm | undefined>();
  const [seed, setSeed] = useState<NormFileSeed | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resetMessages() {
    setError(undefined);
    setStatus(undefined);
  }

  function openCreate() {
    resetMessages();
    setEditing(undefined);
    setSeed(undefined);
    setEditorOpen(true);
  }

  function openEdit(norm: WritingNorm) {
    resetMessages();
    setEditing(norm);
    setSeed(undefined);
    setEditorOpen(true);
  }

  /** 读好文件才打开面板；此时不写库，作者点保存才落库 */
  async function createFromFile(file: File | undefined) {
    if (!file) return;
    resetMessages();
    try {
      const result = await readManuscriptFile(file);
      if (result.text.length > NORM_CONTENT_MAX) {
        setError(
          `这个文件有 ${result.text.length} 字，超过单份规范 ${NORM_CONTENT_MAX} 字的上限，可以拆成几份`,
        );
        return;
      }
      setEditing(undefined);
      setSeed({
        title: titleFromFileName(file.name),
        content: result.text,
        notice: fileNotice(file.name, result),
      });
      setEditorOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '文件读取失败');
    }
  }

  async function setEnabled(norm: WritingNorm, enabled: boolean) {
    resetMessages();
    try {
      await repository.updateWritingNorm(norm.id, { enabled });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      // 失败也刷新：列表回到库里的真实状态，开关不会停在一个没存上的位置
      invalidate();
    }
  }

  async function move(index: number, delta: -1 | 1) {
    if (!norms) return;
    const target = index + delta;
    if (target < 0 || target >= norms.length) return;
    resetMessages();
    const ids = norms.map((norm) => norm.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    try {
      await repository.reorderWritingNorms(novel.id, ids);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '调整顺序失败');
    } finally {
      invalidate();
    }
  }

  const list = norms ?? [];
  // 合计只算「写正文」：它是每次整章生成、段落加工都要付的那部分
  const writingTotal = normsInScope(list, 'writing').reduce(
    (sum, norm) => sum + normTokens(norm),
    0,
  );

  const fromFileButton = (
    <Button variant="secondary" size="md" onClick={() => fileInputRef.current?.click()}>
      从文件新建
    </Button>
  );

  return (
    <Section
      title="写作规范"
      description="作者给本作定下的创作约束与项目说明：时间截面、与原作的差异、提取规则等。原文保存，按作用范围进入 AI 提示词。"
      action={
        <Button size="md" variant="secondary" onClick={openCreate}>
          新建
        </Button>
      }
    >
      {status ? (
        <p role="status" className="text-xs leading-relaxed text-ink-700">
          {status}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
          {error}
        </p>
      ) : null}

      {norms === undefined ? (
        <p className="text-sm text-ink-300">加载中…</p>
      ) : list.length === 0 ? (
        <EmptyState
          title="还没有写作规范"
          description="设定条目告诉 AI 这个世界有什么；写作规范告诉它这本书选择怎么写。"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" size="md" onClick={openCreate}>
                新建规范
              </Button>
              {fromFileButton}
            </div>
          }
        />
      ) : (
        <>
          {writingTotal > NORMS_TOTAL_TOKEN_WARN ? (
            <p className="text-xs leading-relaxed text-seal">
              启用中的写正文规范合计{formatTokens(writingTotal)}
              ，每次生成都会带上。可以停用不常用的，或试试 AI 精简。
            </p>
          ) : null}

          <ul className="flex flex-col divide-y divide-ink-100">
            {list.map((norm, index) => {
              const tokens = normTokens(norm);
              const scopes = scopeText(norm);
              return (
                <li
                  key={norm.id}
                  // 单套 DOM：窄屏标题区占满一行、控件换到第二行右对齐，md 起同一行
                  className={[
                    'flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0',
                    norm.enabled ? '' : 'text-ink-300',
                  ].join(' ')}
                >
                  <div className="min-w-0 basis-full md:flex-1 md:basis-auto">
                    <button
                      type="button"
                      onClick={() => openEdit(norm)}
                      className={[
                        'tap-target inline-flex items-center text-left text-sm font-medium',
                        norm.enabled ? 'text-ink-900' : 'text-ink-300',
                      ].join(' ')}
                    >
                      {norm.title}
                    </button>
                    <p className={`text-xs ${norm.enabled ? 'text-ink-500' : 'text-ink-300'}`}>
                      {norm.enabled ? '' : '已停用 · '}
                      {formatTokens(tokens)} · {scopes || '未选作用范围，不会进入提示词'}
                      {tokens > NORM_TOKEN_WARN ? (
                        <span className="ml-1.5 text-seal">较长</span>
                      ) : null}
                    </p>
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <Toggle
                      label="启用"
                      ariaLabel={`启用《${norm.title}》`}
                      tapTarget
                      checked={norm.enabled}
                      onChange={(enabled) => void setEnabled(norm, enabled)}
                    />
                    <IconButton
                      label={`上移《${norm.title}》`}
                      disabled={index === 0}
                      onClick={() => void move(index, -1)}
                    >
                      <ArrowUpIcon className="h-5 w-5" />
                    </IconButton>
                    <IconButton
                      label={`下移《${norm.title}》`}
                      disabled={index === list.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      <ArrowDownIcon className="h-5 w-5" />
                    </IconButton>
                  </div>
                </li>
              );
            })}
          </ul>

          <div>{fromFileButton}</div>
        </>
      )}

      {/* 只渲染一份：空状态与列表下方的「从文件新建」都点它 */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(',')}
        aria-label="规范文件"
        className="sr-only"
        onChange={(event) => {
          void createFromFile(event.target.files?.[0]);
          // 清空 value，否则连续选同一个文件不会再触发 change
          event.target.value = '';
        }}
      />

      <WritingNormEditorSheet
        open={editorOpen}
        novelId={novel.id}
        norm={editing}
        seed={seed}
        onClose={() => setEditorOpen(false)}
        onCondensed={(title) => setStatus(`已另存为《${title}》，原规范已停用。`)}
      />
    </Section>
  );
}
