import { z } from 'zod';
import type { NovelRepository } from '@/data/NovelRepository';
import { RepositorySnapshotSchema, type RepositorySnapshot } from '@/domain/schema';
import { addInteractiveScopeIfFull } from '@/domain/writingNorm';

/**
 * 全量备份。
 *
 * 阶段一的数据全在浏览器的 IndexedDB 里，而「清除浏览器数据」「换手机」
 * 「隐私模式清理」都会一次性带走几十万字。备份不是可选功能，是这个架构
 * 必须配的安全带。
 *
 * **备份文件不含 API Key**：它会被丢进网盘、发给自己、传到聊天软件里。
 * 快照本身就不收集设置（见 `RepositorySnapshotSchema`），这里再在文件层
 * 明确一次。
 */

export const BACKUP_APP_ID = 'myliterature';
/**
 * 文件格式版本。
 *
 * v2：加入外传（`sideStories` 与 `Chapter.sideStoryId`）。必须升版本：旧版应用用 `z.object`
 * 解析会悄悄丢掉未知键，外传章节恢复后变成主线章节、章号与主线重复，而且看起来是成功的。
 * v1 文件照常能读：章节经 `default(null)` 都成为主线，`sideStories` 默认为空。
 *
 * v3：加入写作规范（`writingNorms`）。必须升版本，理由与 v2 相同：旧版应用的 `z.object`
 * 会悄悄丢掉未知的 `writingNorms`，恢复「成功」但规范全没了；升版本后旧应用会明确报「来自更新版本」。
 * v1 / v2 文件照常能读，`writingNorms` 默认为空。
 *
 * v4：加入互动推演（`scenarios`、`scenarioNodes`）、条目的作用范围与可变性（`scope`、`fieldLocks`）、
 * 大纲 / 章节 / 外传的推演溯源（`scenarioSource`）、写作规范的 `interactive` 作用范围。必须升版本：
 * 旧版应用的 `z.object` 会悄悄丢掉推演数据，而 `interactive` 作用范围会让旧应用整份拒绝、
 * 却报成「内容不符合预期」。升版本后旧应用明确报「来自更新版本」。
 * v1–v3 文件照常能读：推演为空、条目通用、溯源为 null；五项全开的规范补上「互动推演」（与 v7 迁移同一条规则）。
 */
export const BACKUP_VERSION = 4;

const BACKUP_APP_LITERAL = z.literal(BACKUP_APP_ID, '这不是本应用的备份文件');
/** 文件格式版本，与 IndexedDB 的架构版本无关 */
const BACKUP_VERSION_FIELD = z.number().int().positive();

/** 只看文件头：先认出是不是本应用、是哪个版本，再决定要不要解析正文 */
const BackupHeaderSchema = z
  .object({ app: BACKUP_APP_LITERAL, version: BACKUP_VERSION_FIELD })
  .passthrough();

export const BackupFileSchema = z.object({
  app: BACKUP_APP_LITERAL,
  version: BACKUP_VERSION_FIELD,
  exportedAt: z.number().int().nonnegative(),
  data: RepositorySnapshotSchema,
});
export type BackupFile = z.infer<typeof BackupFileSchema>;

export function buildBackupFile(snapshot: RepositorySnapshot, exportedAt: number): BackupFile {
  return {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt,
    data: snapshot,
  };
}

/** 序列化成可下载的文本。缩进 2 格：出问题时用户能自己打开看一眼 */
export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export interface BackupSummary {
  novels: number;
  chapters: number;
  words: number;
  entries: number;
  exportedAt: number;
}

export function summarizeBackup(file: BackupFile): BackupSummary {
  return {
    novels: file.data.novels.length,
    chapters: file.data.chapters.length,
    words: file.data.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    entries: file.data.entries.length,
    exportedAt: file.exportedAt,
  };
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * 解析备份文件文本。
 *
 * 错误信息要说清「拿错文件」和「文件损坏」的区别 —— 用户最常见的失败
 * 是选错了文件，而不是数据真的坏了。
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError('这个文件不是合法的 JSON，可能选错了文件');
  }

  // 先查文件头与版本，再整份解析：更新版本的文件里可能有当前版本不认识的字段或枚举值，
  // 若先整份解析，用户看到的是「内容不符合预期」，而不是真正的原因「版本太新」
  const header = BackupHeaderSchema.safeParse(raw);
  if (!header.success) throw invalidContent(header.error);

  if (header.data.version > BACKUP_VERSION) {
    throw new BackupError(
      '这份备份来自更新版本的应用，当前版本读不了',
      `文件版本 ${header.data.version}，当前支持到 ${BACKUP_VERSION}`,
    );
  }

  const parsed = BackupFileSchema.safeParse(raw);
  if (!parsed.success) throw invalidContent(parsed.error);

  // v3 及以前没有「互动推演」作用范围：五项全开的老规范按「处处适用」补上，收窄过的不动。
  // v4 文件不做：v4 里五项的规范是作者主动去掉了 interactive
  if (parsed.data.version <= 3) {
    for (const norm of parsed.data.data.writingNorms) {
      norm.scopes = addInteractiveScopeIfFull(norm.scopes);
    }
  }
  return parsed.data;
}

function invalidContent(error: z.ZodError): BackupError {
  const first = error.issues[0];
  const path = first?.path.length ? first.path.join('.') : '(根对象)';
  return new BackupError('备份文件的内容不符合预期', `${path}：${first?.message ?? '未知问题'}`);
}

export async function exportBackup(
  repository: NovelRepository,
  exportedAt = Date.now(),
): Promise<{ file: BackupFile; text: string }> {
  const snapshot = await repository.exportSnapshot();
  const file = buildBackupFile(snapshot, exportedAt);
  return { file, text: serializeBackup(file) };
}

export async function restoreBackup(
  repository: NovelRepository,
  file: BackupFile,
  mode: 'replace' | 'merge',
): Promise<void> {
  await repository.importSnapshot(file.data, mode);
}
