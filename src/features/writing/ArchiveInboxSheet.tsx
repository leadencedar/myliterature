import { Sheet } from '@/ui/Sheet';
import { ProposalInbox } from '../proposals/ProposalInbox';

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
  return (
    <Sheet
      open={open}
      title="本章摘要与设定待确认"
      description="摘要、进展与知识库条目都在这里确认，采用前不会写入。"
      onClose={onClose}
    >
      {batchId ? (
        <ProposalInbox
          novelId={novelId}
          batchId={batchId}
          acceptAllLabel="采用本批"
          defaultExpandFirst={false}
          onSettled={onSettled}
        />
      ) : (
        <p className="text-sm text-ink-500">这一批摘要与设定已经处理完了。</p>
      )}
    </Sheet>
  );
}
