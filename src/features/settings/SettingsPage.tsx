import { useRef, useState } from 'react';
import { LlmError } from '@/llm/errors';
import { PROVIDER_PRESETS, type ProviderPresetId } from '@/llm/presets';
import { isLlmConfigured, useLlmSettings } from '@/llm/settingsStore';
import { TASK_PROFILES, type TaskKind } from '@/llm/taskProfiles';
import { resolveModel, useLlm } from '@/llm/useLlm';
import { Button } from '@/ui/Button';
import { Toggle } from '@/ui/Controls';
import { SelectField, TextField } from '@/ui/Field';
import { Page, Section, SectionGrid } from '@/ui/Page';
import { useArchiveSettings } from '../writing/archiveSettings';
import { BackupSection } from '../export/BackupSection';

type TestState =
  | { phase: 'idle' }
  | { phase: 'running'; text: string }
  | { phase: 'success'; text: string; note: string }
  | { phase: 'error'; message: string; detail?: string };

/** 展示在「模型分工」里的任务顺序 */
const TASK_ORDER: TaskKind[] = [
  'project-setup',
  'outline-expand',
  'chapter-draft',
  'paragraph-revise',
  'chapter-summary',
  'extract-settings',
  'translate-chapter',
];

export function SettingsPage() {
  const settings = useLlmSettings();
  const llm = useLlm();
  const [showKey, setShowKey] = useState(false);
  const archive = useArchiveSettings();
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const preset = PROVIDER_PRESETS[settings.presetId];
  const configured = isLlmConfigured(settings);

  async function runConnectivityTest() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setTest({ phase: 'running', text: '' });

    let streamed = '';
    try {
      const result = await llm.runStream(
        'connectivity-test',
        {
          system: '你是一个中文写作助手。用一句话回应，不要解释。',
          user: '请用一句不超过二十字的话，描述雨夜里的旧书店。',
          signal: controller.signal,
        },
        {
          onText: (delta) => {
            streamed += delta;
            setTest({ phase: 'running', text: streamed });
          },
        },
      );

      const usage = result.usage;
      const note = usage
        ? `输入 ${usage.promptTokens} token${
            usage.cachedPromptTokens ? `（缓存命中 ${usage.cachedPromptTokens}）` : ''
          } · 输出 ${usage.completionTokens} token`
        : '连接正常';
      setTest({ phase: 'success', text: result.content || streamed, note });
    } catch (cause) {
      if (cause instanceof LlmError && cause.kind === 'aborted') {
        setTest({ phase: 'idle' });
        return;
      }
      const error = cause instanceof LlmError ? cause : undefined;
      setTest({
        phase: 'error',
        message: error?.message ?? (cause instanceof Error ? cause.message : '测试失败'),
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  }

  return (
    <Page title="设置" subtitle="模型 · 数据 · 备份" width="wide">
      <Section
        title="模型服务"
        description="本应用不代理任何请求，你的 API Key 只保存在这台设备上，直接与服务商通信。"
      >
        <SelectField
          label="服务商"
          options={Object.values(PROVIDER_PRESETS).map((item) => ({
            value: item.id,
            label: item.label,
          }))}
          value={settings.presetId}
          hint={preset.note}
          onChange={(event) =>
            settings.applyPreset((event.target as HTMLSelectElement).value as ProviderPresetId)
          }
        />

        <TextField
          label="接口地址"
          value={settings.baseUrl}
          placeholder="https://api.deepseek.com"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => settings.update({ baseUrl: event.target.value })}
        />

        <div className="flex flex-col gap-1.5">
          <TextField
            label="API Key"
            type={showKey ? 'text' : 'password'}
            value={settings.apiKey}
            placeholder="sk-…"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => settings.update({ apiKey: event.target.value })}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowKey((value) => !value)}>
              {showKey ? '隐藏' : '显示'}
            </Button>
            {settings.apiKey ? (
              <Button size="sm" variant="ghost" onClick={settings.clearApiKey}>
                清除密钥
              </Button>
            ) : null}
            {preset.consoleUrl ? (
              <a
                href={preset.consoleUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="ml-auto text-xs text-accent underline"
              >
                去申请 Key
              </a>
            ) : null}
          </div>
        </div>

        <TextField
          label="常规模型"
          value={settings.model}
          placeholder="deepseek-flash"
          autoCapitalize="off"
          spellCheck={false}
          hint="用于正文写作、摘要、设定提取等大部分任务。"
          onChange={(event) => settings.update({ model: event.target.value })}
        />

        <TextField
          label="重点任务模型"
          value={settings.strongModel}
          placeholder="deepseek-v4-pro"
          autoCapitalize="off"
          spellCheck={false}
          hint="立项与大纲决定整本书的地基，会优先用这个模型。留空则与常规模型相同。"
          onChange={(event) => settings.update({ strongModel: event.target.value })}
        />
      </Section>

      <Section
        title="写作辅助"
        description="与章节完成相关的自动化设置。AI 产出仍然一律先变成待确认提案，不会自动写入。"
      >
        <Toggle
          label="完成后自动生成本章档案"
          description="标记章节「已完成」时在后台生成摘要、进展与知识库条目提案（摘要与知识库更新，可关条目），不弹窗、不阻塞写作；在编辑器状态行点「查看」确认。"
          checked={archive.autoArchive}
          onChange={(value) => archive.update({ autoArchive: value })}
        />
        <Toggle
          label="归档时提取知识库条目"
          description="关闭后只生成摘要与进展，不再产出条目提案；调用次数不变。"
          checked={archive.extractEntries}
          onChange={(value) => archive.update({ extractEntries: value })}
        />
        <p className="text-xs leading-relaxed text-ink-500">
          成本：每章归档 1 次结构化调用（输入本章正文，输出摘要、进展与条目）。
          摘要与进展是摘要链的来源，必须生成；条目提取可以关闭。
        </p>
      </Section>

      <Section title="连通性测试" description="发一条极短的请求验证配置，费用可忽略。">
        <Button
          variant="primary"
          size="lg"
          block
          disabled={!configured || test.phase === 'running'}
          onClick={runConnectivityTest}
        >
          {test.phase === 'running' ? '正在请求…' : '测试连接'}
        </Button>

        {!configured ? (
          <p className="text-xs text-ink-500">请先填写接口地址、API Key 与模型名。</p>
        ) : null}

        {test.phase === 'running' || test.phase === 'success' ? (
          <div className="rounded-xl bg-paper-sunken px-3 py-2.5">
            <p
              aria-live="polite"
              className="font-reading text-sm leading-relaxed whitespace-pre-wrap text-ink-900"
            >
              {test.text || '…'}
            </p>
            {test.phase === 'success' ? (
              <p className="mt-2 text-xs text-ink-500">✓ {test.note}</p>
            ) : null}
          </div>
        ) : null}

        {test.phase === 'error' ? (
          <div role="alert" className="rounded-xl bg-seal-soft px-3 py-2.5">
            <p className="text-sm text-seal">{test.message}</p>
            {test.detail ? (
              <p className="mt-1 break-words text-xs text-ink-500">{test.detail}</p>
            ) : null}
          </div>
        ) : null}
      </Section>

      <BackupSection />

      {/* 这两块都是只读说明，桌面端并排即可，不必让用户一直往下滚 */}
      <SectionGrid>
        <Section
          title="模型分工"
          description="不同任务对模型的要求不同，应用已按任务预设参数，无需手动调节。"
        >
          <ul className="flex flex-col gap-2.5">
            {TASK_ORDER.map((task) => {
              const profile = TASK_PROFILES[task];
              return (
                <li key={task} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-ink-700">{profile.label}</span>
                  <span className="shrink-0 text-right text-xs text-ink-500">
                    {resolveModel(settings, task) || '未设置'}
                    <br />
                    {profile.thinking ? '开启思维链' : '关闭思维链'} · 温度 {profile.temperature}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="安全说明">
          <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-500">
            <p>
              <span className="font-medium text-ink-700">密钥存放位置。</span>
              API Key 保存在浏览器本地存储中，同一网站的脚本都能读取。本应用不引入任何第三方脚本，
              并通过内容安全策略把出站连接限制在已登记的模型服务商域名内。
            </p>
            <p>
              <span className="font-medium text-ink-700">不会进备份。</span>
              密钥与作品数据分开存放，导出备份文件时不会包含密钥。
            </p>
            <p>
              <span className="font-medium text-ink-700">共用设备请注意。</span>
              如果这台设备他人也会使用，建议用完后点「清除密钥」。
            </p>
          </div>
        </Section>
      </SectionGrid>
    </Page>
  );
}
