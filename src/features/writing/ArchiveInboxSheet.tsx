import { useMemo } from 'react';
import { Sheet } from '@/ui/Sheet';
import { ProposalInbox } from '../proposals/ProposalInbox';
import { readArchiveAudit } from './archiveAudit';

/**
 * 「本章档案待确认」抽屉。
 *
 * 只做一件事：按归档批次打开 ProposalInbox。摘要、进展、知识库条目都在这里
 * 逐条确认，关闭不写任何东西 —— 后台归档只产生提案，绝不自作主张落库（D3）。
 */
export function ArchiveInboxSheet({
  open,
  novelId,
  batchId,
  onClose,
  onSettled,
}: {
  open: boolean;
  novelId: string;
  /** 要展示的归档批次；null 时抽屉不渲染内容 */
  batchId: string | null;
  onClose: () => void;
  /** 本批处理完毕（全部采用或全部忽略）后回调；调用方负责失效刷新 */
  onSettled?: () => void;
}) {
  // 打开/换批时读一次伏笔流水（localStorage 同步读，归档成功后下次打开即可见）。
  // 按章序号排序：写入顺序在「同章重跑原地替换」时会变，序号才是稳定的阅读顺序。
  const auditChapters = useMemo(() => {
    if (!batchId) return [];
    return [...readArchiveAudit(batchId).chapters].sort((a, b) => a.index - b.index);
  }, [batchId]);

  return (
    <Sheet
      open={open}
      title="本章摘要与设定待确认"
      description="摘要、进展与知识库条目都在这里确认，采用前不会写入。"
      onClose={onClose}
    >
      {batchId ? (
        <>
          {/* 伏笔流水（M2.1）：让作者核对本章新埋/收束/现存，误收束可在摘要里加回 */}
          {auditChapters.length > 0 ? (
            <div className="flex flex-col gap-1.5 rounded-xl bg-paper-sunken px-3 py-2.5">
              <p className="text-xs font-medium text-ink-700">本批伏笔流水</p>
              <ul className="flex flex-col gap-1.5">
                {auditChapters.map((chapter) => {
                  // 无历史伏笔时（open 与 opened 完全相同且没有收束），「现存」就是本章新埋的重复：
                  // 明细只写新埋，计数行注明，减少一眼扫过去的噪音
                  const existingMatchesOpened =
                    chapter.resolved.length === 0 &&
                    chapter.open.length > 0 &&
                    chapter.open.length === chapter.opened.length &&
                    chapter.open.every((thread, index) => thread === chapter.opened[index]);
                  const detail = [
                    chapter.opened.length > 0 ? `新埋：${chapter.opened.join('、')}` : '',
                    chapter.resolved.length > 0 ? `收束：${chapter.resolved.join('、')}` : '',
                    !existingMatchesOpened && chapter.open.length > 0
                      ? `现存：${chapter.open.join('、')}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join('；');
                  return (
                    <li key={chapter.chapterId} className="text-xs leading-relaxed text-ink-700">
                      <p>
                        第 {chapter.index} 章：新埋 {chapter.opened.length} / 收束{' '}
                        {chapter.resolved.length} / 现存 {chapter.open.length}
                        {existingMatchesOpened ? '（现存均为本章新埋）' : ''}
                      </p>
                      {detail ? <p className="mt-0.5 text-ink-500">{detail}</p> : null}
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs leading-relaxed text-ink-500">
                若误收束，在摘要的「未收束伏笔」里加回（展开摘要提案编辑即可）。
              </p>
            </div>
          ) : (
            <p className="text-xs text-ink-500">本批没有伏笔流水记录。</p>
          )}

          <ProposalInbox
            novelId={novelId}
            batchId={batchId}
            acceptAllLabel="采用本批"
            defaultExpandFirst={false}
            defaultIgnoreEntryOverwrites
            safetyNotice
            onSettled={onSettled}
          />
        </>
      ) : (
        <p className="text-sm text-ink-500">这一批摘要与设定已经处理完了。</p>
      )}
    </Sheet>
  );
}
