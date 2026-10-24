import { useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate } from '@/data/useRepoQuery';
import { Button } from '@/ui/Button';
import { RadioList } from '@/ui/Controls';
import { Section } from '@/ui/Page';
import { ConfirmDialog } from '@/ui/Sheet';
import { formatRelativeTime, formatWordCount } from '@/ui/format';
import { readTextFile, saveTextFile } from '@/ui/download';
import {
  BackupError,
  exportBackup,
  parseBackup,
  restoreBackup,
  summarizeBackup,
  type BackupFile,
} from './backup';
import { useBackupReminder } from './backupReminder';

type RestoreMode = 'replace' | 'merge';

const MODE_OPTIONS: { value: RestoreMode; label: string; description: string }[] = [
  {
    value: 'replace',
    label: '覆盖恢复',
    description: '先清空这台设备上的全部作品，再写入备份内容。用于换设备或清过浏览器数据后恢复。',
  },
  {
    value: 'merge',
    label: '合并导入',
    description:
      '保留现有作品，把备份里的内容并进来；id 相同的记录以备份为准；同一个互动推演整棵分支树以备份为准。',
  },
];

/** 备份文件名带上日期，用户攒一堆备份时能分辨先后 */
function backupFileName(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `myliterature-备份-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate(),
  )}.json`;
}

/**
 * 全量备份与恢复。
 *
 * 放在设置页而不是某本书里：它是整个应用级别的操作，一次带走所有作品。
 */
export function BackupSection() {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const { lastBackupAt, markBackedUp } = useBackupReminder();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [pending, setPending] = useState<BackupFile | null>(null);
  const [mode, setMode] = useState<RestoreMode>('replace');
  const [confirmRestore, setConfirmRestore] = useState(false);

  async function doExport() {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const at = Date.now();
      const { file, text } = await exportBackup(repository, at);
      saveTextFile(backupFileName(at), text, 'application/json;charset=utf-8');
      const summary = summarizeBackup(file);
      markBackedUp(at);
      setMessage(
        `已导出 ${summary.novels} 本作品、${summary.chapters} 章、${formatWordCount(
          summary.words,
        )}。文件里不含 API Key。`,
      );
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : '导出失败' });
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setMessage('');
    try {
      const parsed = parseBackup(await readTextFile(file));
      setPending(parsed);
      setConfirmRestore(true);
    } catch (cause) {
      const backupError = cause instanceof BackupError ? cause : undefined;
      setError({
        message: backupError?.message ?? (cause instanceof Error ? cause.message : '读取失败'),
        ...(backupError?.detail ? { detail: backupError.detail } : {}),
      });
    }
  }

  async function doRestore() {
    if (!pending) return;
    setConfirmRestore(false);
    setBusy(true);
    try {
      await restoreBackup(repository, pending, mode);
      invalidate();
      const summary = summarizeBackup(pending);
      setMessage(
        `已${mode === 'replace' ? '覆盖恢复' : '合并导入'} ${summary.novels} 本作品、${
          summary.chapters
        } 章。`,
      );
      setPending(null);
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : '恢复失败' });
    } finally {
      setBusy(false);
    }
  }

  const summary = pending ? summarizeBackup(pending) : null;

  return (
    <Section
      title="备份与恢复"
      description="作品数据存在这台设备的浏览器里。清除浏览器数据、换手机都会带走它们，定期导出一份最稳妥。"
    >
      <p className="text-xs text-ink-500">
        {lastBackupAt
          ? `上次备份：${formatRelativeTime(lastBackupAt)}`
          : '还没有备份过这台设备上的数据。'}
      </p>

      <Button variant="primary" size="lg" block disabled={busy} onClick={() => void doExport()}>
        导出备份文件
      </Button>

      <RadioList label="恢复方式" value={mode} options={MODE_OPTIONS} onChange={setMode} />

      <Button
        variant="secondary"
        size="lg"
        block
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
      >
        选择备份文件…
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        aria-label="备份文件"
        className="sr-only"
        onChange={(event) => {
          void pickFile(event.target.files?.[0]);
          // 清空 value，否则连续选同一个文件不会触发 change
          event.target.value = '';
        }}
      />

      {message ? (
        <p
          aria-live="polite"
          className="rounded-xl bg-emerald-50 px-3 py-2.5 text-xs leading-relaxed text-emerald-700"
        >
          {message}
        </p>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5">
          <p className="text-sm text-seal">{error.message}</p>
          {error.detail ? (
            <p className="mt-1 break-words text-xs text-ink-500">{error.detail}</p>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmRestore}
        title={mode === 'replace' ? '覆盖恢复？' : '合并导入？'}
        message={
          summary
            ? mode === 'replace'
              ? `这台设备上的全部作品会被清空，然后写入备份里的 ${summary.novels} 本作品、${summary.chapters} 章。此操作无法撤销 —— 如果现有数据还没备份，请先导出一份。`
              : `会把备份里的 ${summary.novels} 本作品、${summary.chapters} 章并入现有数据，id 相同的记录以备份为准；同一个互动推演整棵分支树以备份为准。`
            : ''
        }
        confirmLabel={mode === 'replace' ? '清空并恢复' : '合并导入'}
        destructive={mode === 'replace'}
        onConfirm={() => void doRestore()}
        onCancel={() => {
          setConfirmRestore(false);
          setPending(null);
        }}
      />
    </Section>
  );
}
