import { useState } from 'react';
import type { StyleAnchor } from '@/context/styleAnchor';
import type { Chapter, Novel, StyleProfile } from '@/domain/schema';
import { useLlm } from '@/llm/useLlm';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import {
  STYLE_CHECK_SEVERITY_LABELS,
  runStyleCheck,
  type StyleCheckResult,
  type StyleCheckSeverity,
} from '@/features/style/styleCheck';

type RunState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: StyleCheckResult; anchor: StyleAnchor | null }
  | { kind: 'error'; message: string };

const SEVERITY_STYLES: Record<StyleCheckSeverity, string> = {
  high: 'bg-seal-soft text-seal',
  medium: 'bg-accent-soft text-accent',
  low: 'bg-paper-sunken text-ink-500',
};

/**
 * 文风漂移检查面板（M4 S2）。
 *
 * 只读诊断：面板不接收任何写正文的回调，也没有「应用建议 / 自动改写」——
 * 这是 D6 的边界：AI 可以指出哪句不像作者，但改不改、怎么改由作者自己动手。
 */
export function StyleCheckSheet({
  open,
  novel,
  style,
  chapter,
  chapters,
  onClose,
}: {
  open: boolean;
  novel: Novel;
  style: StyleProfile;
  /** 当前编辑中的章节快照（content 为编辑器里的最新正文） */
  chapter: Chapter;
  chapters: readonly Chapter[];
  onClose: () => void;
}) {
  const llm = useLlm();
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const hasContent = chapter.content.trim().length > 0;

  async function check() {
    setState({ kind: 'running' });
    try {
      const { result, anchor } = await runStyleCheck(
        { llm },
        {
          novel,
          style,
          chapter,
          chapters,
          targetChapterId: chapter.id,
        },
      );
      setState({ kind: 'done', result, anchor });
    } catch (cause) {
      setState({
        kind: 'error',
        message: cause instanceof Error ? cause.message : '检查失败',
      });
    }
  }

  /** 关闭不写：检查结果只在本次面板会话里，关掉即丢 */
  function close() {
    setState({ kind: 'idle' });
    onClose();
  }

  return (
    <Sheet
      open={open}
      title="检查文风"
      description="只给诊断，不改你的稿子。"
      onClose={close}
      footer={
        state.kind === 'done' ? (
          <Button variant="primary" size="lg" block onClick={close}>
            完成
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!hasContent || !llm.configured || state.kind === 'running'}
            onClick={() => void check()}
          >
            {state.kind === 'running' ? '正在检查…' : state.kind === 'error' ? '重试' : '检查文风'}
          </Button>
        )
      }
    >
      {/* 两个检查的分工：文风看语感，规范看作者定的规矩 —— 避免作者混淆结果该听谁的 */}
      <p className="text-xs leading-relaxed text-ink-500">
        文风检查看语感与叙述距离是否漂移；按规范检查看你定的规矩是否被违反。依据：风格档案 +
        文风锚点。
      </p>

      {state.kind === 'idle' ? (
        <div className="flex flex-col gap-2 rounded-xl bg-paper-sunken px-3 py-2.5">
          <p className="text-sm leading-relaxed text-ink-700">
            对照风格档案与文风锚点，看看本章哪里开始不像你写的。
          </p>
          <p className="text-xs leading-relaxed text-ink-500">
            只给诊断，最多 5 条，每条必须引用原文；不改稿、不生成提案。
          </p>
          {!hasContent ? (
            <p className="text-xs text-ink-500">本章还没有正文，写几段再来检查。</p>
          ) : null}
          {!llm.configured ? (
            <p className="text-xs text-ink-500">需要先在「设置」里配置模型。</p>
          ) : null}
        </div>
      ) : null}

      {state.kind === 'running' ? (
        <p aria-live="polite" className="text-sm text-ink-500">
          正在对照风格档案与文风锚点…
        </p>
      ) : null}

      {state.kind === 'error' ? (
        <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5">
          <p className="text-sm text-seal">{state.message}</p>
        </div>
      ) : null}

      {state.kind === 'done' ? (
        <>
          <div className="flex flex-col gap-1 rounded-xl bg-paper-sunken px-3 py-2.5">
            <p className="text-sm leading-relaxed text-ink-900">{state.result.summary}</p>
            {state.anchor ? (
              <p className="text-xs text-ink-500">对照锚点：{state.anchor.label}</p>
            ) : (
              <p className="text-xs text-ink-500">
                第一章或没有更早正文：本次没有文风锚点，只对照风格档案。
              </p>
            )}
          </div>

          {state.result.issues.length === 0 ? (
            <p className="rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700">
              未发现明显文风漂移。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {state.result.issues.map((issue, index) => (
                <li
                  key={`${index}-${issue.dimension}`}
                  className="flex flex-col gap-1 rounded-xl border border-ink-100 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={[
                        'rounded-full px-2 py-0.5 text-[0.6875rem] font-medium',
                        SEVERITY_STYLES[issue.severity],
                      ].join(' ')}
                    >
                      {STYLE_CHECK_SEVERITY_LABELS[issue.severity]}
                    </span>
                    <span className="text-xs font-medium text-ink-700">{issue.dimension}</span>
                  </div>
                  <p className="rounded-lg bg-paper-sunken px-2.5 py-1.5 text-sm leading-relaxed text-ink-700">
                    <span className="text-xs text-ink-500">原文：</span>
                    <span className="font-reading">「{issue.excerpt}」</span>
                  </p>
                  <p className="text-xs leading-relaxed text-ink-700">
                    <span className="text-ink-500">依据：</span>
                    {issue.basis}
                  </p>
                  <p className="text-xs leading-relaxed text-ink-500">建议：{issue.suggestion}</p>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs leading-relaxed text-ink-500">
            只给诊断，不改稿；是否采纳、怎么改由你决定。
          </p>
        </>
      ) : null}
    </Sheet>
  );
}
