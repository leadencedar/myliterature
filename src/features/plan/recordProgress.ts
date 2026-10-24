import type { NovelRepository } from '@/data/NovelRepository';
import { toLocalDate } from '@/domain/primitives';

/**
 * 记录当日产出。
 *
 * **只记录正向增量**：`DailyLog.words` 是非负的累计值，如果把删字也算成负数，
 * 一次大改就能把当天的记录抹平甚至变成非法值。删掉的字不是没写过，
 * 只是被改掉了，没有理由从今天的产出里扣回去。
 *
 * 两端都为 0 时不写库 —— 光标移动、只改标题这类保存不该在日志里留下空记录。
 */
export async function recordProgress(
  repository: NovelRepository,
  novelId: string,
  delta: { words?: number; chaptersCompleted?: number },
  date = toLocalDate(),
): Promise<void> {
  const words = Math.max(0, Math.round(delta.words ?? 0));
  const chaptersCompleted = Math.max(0, Math.round(delta.chaptersCompleted ?? 0));
  if (words === 0 && chaptersCompleted === 0) return;
  await repository.addDailyProgress(novelId, date, { words, chaptersCompleted });
}
