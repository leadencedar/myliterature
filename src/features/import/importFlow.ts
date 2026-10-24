import type { ImportJob } from '@/domain/schema';

/** 导入面板的步骤 */
export type Step = 'paste' | 'split' | 'translate' | 'destination' | 'extract' | 'inbox';

/**
 * 面板加载时对已有任务的处理：恢复到某一步，或者删掉任务。
 * - silent：旧版留下的空任务，本来就什么都没做，静默删掉；
 * - notice：不合阶段表的任务，删掉并告诉用户进度无法恢复（章节不受影响）。
 */
export type ResumeResult = { step: Step } | { discard: 'silent' | 'notice' };

/**
 * 按任务状态决定恢复到哪一步。自上而下匹配，第一条命中即返回。
 *
 * 只接 parse 过的 ImportJob，但仍按全函数写（数组按 `?? []` 读、不抛错）：
 * 迁移时原样留下的行、绕过仓储的写入都可能缺键，这里是读取侧的最后一道兜底。
 *
 * 阶段表（不合即 notice）：
 * | destination     | drafts | chapters | worldviewChunks |
 * | null            | 非空   | 空       | 空              |
 * | main / side     | 空     | 非空     | 空              |
 * | worldview       | 空     | 空       | 非空            |
 */
export function resumeStepOf(job: ImportJob): ResumeResult {
  const loose = job as Partial<ImportJob>;
  const d = loose.destination ?? null;
  const drafts = loose.drafts ?? [];
  const chapters = loose.chapters ?? [];
  const chunks = loose.worldviewChunks ?? [];

  if (d === null && drafts.length === 0 && chapters.length === 0 && chunks.length === 0) {
    return { discard: 'silent' };
  }

  const bad =
    (d === null && (drafts.length === 0 || chapters.length > 0 || chunks.length > 0)) ||
    ((d?.kind === 'main' || d?.kind === 'side') &&
      (chapters.length === 0 || chunks.length > 0 || drafts.length > 0)) ||
    (d?.kind === 'worldview' && (chunks.length === 0 || chapters.length > 0 || drafts.length > 0));
  if (bad) return { discard: 'notice' };

  if (d === null) {
    const untranslated = drafts.some(
      (draft) => draft.translateStatus === 'pending' || draft.translateStatus === 'failed',
    );
    return { step: untranslated ? 'translate' : 'destination' };
  }

  return { step: 'extract' };
}
