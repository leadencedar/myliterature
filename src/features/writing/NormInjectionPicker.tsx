import { formatTokens } from '@/context/tokens';
import type { WritingNorm } from '@/domain/schema';
import { normTokens } from '@/prompt/sections';

interface NormInjectionPickerProps {
  /** 调用方已按作用范围过滤（写正文面板传 'writing'，检查面板传 'check'） */
  norms: WritingNorm[];
  excludedIds: string[];
  onToggle: (id: string) => void;
  /** 默认「写作规范」；检查面板传「参与检查的规范」 */
  legend?: string;
}

/**
 * 「本次注入」的写作规范临时取消。
 *
 * 只改面板里的本地状态，不写库：作者想这一次不带某份规范时不必去知识库停用它，
 * 下次打开面板又会全部带上。要长期不带，去知识库停用或收窄作用范围。
 * 不接收 scope：过滤由调用方用 normsInScope 完成，这里只负责展示与切换，
 * 写正文面板与检查面板因此能共用同一个组件。
 */
export function NormInjectionPicker({
  norms,
  excludedIds,
  onToggle,
  legend = '写作规范',
}: NormInjectionPickerProps) {
  // 没有可注入的规范时整块不渲染，面板与没有这个功能时一致
  if (norms.length === 0) return null;

  const included = norms.filter((norm) => !excludedIds.includes(norm.id)).length;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-ink-700">
        {legend}（本次带上 {included} / {norms.length} 份）
      </legend>
      <p className="text-xs leading-relaxed text-ink-500">
        取消只影响这一次，不改知识库里的启用状态。
      </p>
      <div className="flex flex-wrap gap-2">
        {norms.map((norm) => {
          const active = !excludedIds.includes(norm.id);
          return (
            <button
              key={norm.id}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(norm.id)}
              // 沿用条目 chip 的视觉；额外的 tap-target 是因为原 chip 约 28px 高，触控不达标
              className={[
                'tap-target inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors',
                active
                  ? 'border-ink-900 bg-ink-900 text-paper'
                  : 'border-ink-100 bg-paper-raised text-ink-700',
              ].join(' ')}
            >
              {norm.title}（{formatTokens(normTokens(norm))}）
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
