import { useEffect, useState } from 'react';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import type { ChildLinkSuggestion } from './suggestOutlineLinks';

/**
 * 采用细化结果后的「确认自动关联」面板。
 *
 * 产品底线（D1）：关联只建议、不静默写回。面板出现前一条 links 都不写；
 * 点「全部跳过」或关掉面板也不写。默认全选，让绝大多数人一眼确认即可，
 * 只有想改的时候才需要动。
 *
 * 呈现用抽屉而不是全屏 modal：作者刚确认完一批提案，这里只是补一个可选动作，
 * 不应该再拦一次心流（移动端底部抽屉，桌面端右侧抽屉，与其它面板一致）。
 */

export interface LinkConfirmResult {
  /** 子节点 → 选中的条目 id */
  selectedByChild: { childId: string; entryIds: string[] }[];
  /** 本面板里被取消/跳过的 (子节点, 条目)，调用方记入会话内抑制集 */
  suppressed: { childId: string; entryId: string }[];
}

export function OutlineLinkConfirmSheet({
  open,
  suggestions,
  busy = false,
  onConfirm,
  onSkip,
  onClose,
}: {
  open: boolean;
  suggestions: readonly ChildLinkSuggestion[];
  busy?: boolean;
  onConfirm: (result: LinkConfirmResult) => void | Promise<void>;
  onSkip: (result: LinkConfirmResult) => void | Promise<void>;
  onClose: () => void;
}) {
  /** 只记「被取消」的，默认空集 = 全选，省掉一份与建议同步的 selected 初始化 */
  const [deselected, setDeselected] = useState<Set<string>>(new Set());

  // 每次重新出现（新的细化批次）都回到默认全选，不继承上一批的取消记忆
  useEffect(() => {
    if (open) setDeselected(new Set());
  }, [open, suggestions]);

  const allPairs = suggestions.flatMap(({ child, suggestions: links }) =>
    links.map((link) => ({ childId: child.id, entryId: link.entry.id })),
  );
  const pairKey = (pair: { childId: string; entryId: string }) => `${pair.childId}:${pair.entryId}`;
  const selectedCount = allPairs.filter((pair) => !deselected.has(pairKey(pair))).length;

  function toggle(key: string) {
    setDeselected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectedByChild() {
    return suggestions.map(({ child, suggestions: links }) => ({
      childId: child.id,
      entryIds: links
        .filter((link) => !deselected.has(`${child.id}:${link.entry.id}`))
        .map((link) => link.entry.id),
    }));
  }

  function confirmSelected() {
    const pairs = allPairs.filter((pair) => deselected.has(pairKey(pair)));
    return onConfirm({ selectedByChild: selectedByChild(), suppressed: pairs });
  }

  function skipAll() {
    return onSkip({ selectedByChild: [], suppressed: allPairs });
  }

  return (
    <Sheet
      open={open}
      title="确认自动关联"
      description="只写入你勾选的条目；不勾 = 不关联。关闭面板不会写入任何关联；取消的条目在本次打开节点抽屉期间不再建议。父节点原有手工关联只对新子节点继承，不改父节点。"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            size="lg"
            block
            disabled={busy || allPairs.length === 0}
            onClick={() => void skipAll()}
          >
            全部跳过
          </Button>
          <Button
            variant="primary"
            size="lg"
            block
            disabled={busy || selectedCount === 0}
            onClick={() => void confirmSelected()}
          >
            {busy ? '写入中…' : `确认关联（${selectedCount} 条）`}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-ink-500">
        标「继承」的是父节点的手工关联；标「名字提到」的是子节点标题/梗概里出现的名字。
      </p>
      <ul className="flex flex-col gap-3">
        {suggestions.map(({ child, suggestions: links }) => (
          <li key={child.id} className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-ink-700">{child.title}</p>
            <div className="flex flex-wrap gap-2">
              {links.map((link) => {
                const key = `${child.id}:${link.entry.id}`;
                const active = !deselected.has(key);
                // 命中名与条目标题相同时不再重复写一遍（评审：「沈砚 提到 · 沈砚」）
                const sourceLabel =
                  link.reason === 'inherited'
                    ? '继承'
                    : link.matchedName && link.matchedName !== link.entry.title
                      ? `名字提到 · ${link.matchedName}`
                      : '名字提到';
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    aria-label={`关联建议：${child.title} · ${link.entry.title}（${sourceLabel}）`}
                    onClick={() => toggle(key)}
                    className={[
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
                      active
                        ? 'border-ink-900 bg-ink-900 text-paper'
                        : 'border-ink-100 bg-paper-raised text-ink-300 line-through',
                    ].join(' ')}
                  >
                    <span>{link.entry.title}</span>
                    <span className={active ? 'text-paper/70' : 'text-ink-300'}>{sourceLabel}</span>
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      {suggestions.length === 0 ? (
        <p className="text-sm text-ink-300">这次没有可关联的建议。</p>
      ) : null}
    </Sheet>
  );
}
