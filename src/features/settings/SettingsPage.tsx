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
import {
  DEFAULT_APPEARANCE_SETTINGS,
  MAX_PROSE_SIZE,
  MIN_PROSE_SIZE,
  PROSE_FONT_STACKS,
  lineHeightFor,
  useAppearanceSettings,
} from './appearanceSettings';
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
  'outline-continue',
  'chapter-draft',
  'paragraph-revise',
  'chapter-summary',
  'extract-settings',
  'translate-chapter',
  'style-check',
];

export function SettingsPage() {
  const settings = useLlmSettings();
  const llm = useLlm();
  const [showKey, setShowKey] = useState(false);
  const archive = useArchiveSettings();
  const appearance = useAppearanceSettings();
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
    <Page title="设置" subtitle="模型 · 外观 · 数据 · 备份" width="wide">
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
          placeholder="deepseek-chat"
          autoCapitalize="off"
          spellCheck={false}
          hint="用于正文写作、摘要、设定提取等大部分任务。"
          onChange={(event) => settings.update({ model: event.target.value })}
        />

        <TextField
          label="重点任务模型"
          value={settings.strongModel}
          placeholder="deepseek-chat"
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
          label="完成后自动生成本章摘要与设定"
          description="标记章节「已完成」时在后台生成摘要、进展与知识库条目提案（摘要与进展必生成，知识库条目可关），不弹窗、不阻塞写作；在编辑器状态行点「查看」确认。"
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

      <Section
        title="外观与阅读"
        description="正文默认黑体 17px / 1.85；宋体推荐 18px / 2.05。正文宽度按 40 × 字号自动重算，只影响正文，不影响按钮与导航。"
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-900">正文字体</span>
          <div className="flex gap-2" role="group" aria-label="正文字体">
            {(
              [
                { key: 'sans', label: '黑体', note: '默认 · 17/1.85' },
                { key: 'serif', label: '宋体', note: '推荐 18/2.05' },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={appearance.font === option.key}
                onClick={() => appearance.setFont(option.key)}
                className={[
                  'flex flex-1 flex-col items-start rounded-xl border px-3 py-2 text-left transition-colors',
                  appearance.font === option.key
                    ? 'border-ink-900 bg-paper-sunken'
                    : 'border-ink-100 bg-paper-raised hover:bg-paper-sunken',
                ].join(' ')}
              >
                <span className="text-sm font-medium text-ink-900">{option.label}</span>
                <span className="mt-0.5 text-[0.6875rem] text-ink-500">{option.note}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="prose-size" className="text-sm font-medium text-ink-900">
              正文字号
            </label>
            <output htmlFor="prose-size" className="text-sm tabular-nums text-ink-700">
              {appearance.size}px
            </output>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="减小字号"
              disabled={appearance.size <= MIN_PROSE_SIZE}
              onClick={() => appearance.setSize(appearance.size - 1)}
              className="tap-target flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-100 bg-paper-raised text-lg text-ink-700 disabled:opacity-40"
            >
              −
            </button>
            <input
              id="prose-size"
              type="range"
              min={MIN_PROSE_SIZE}
              max={MAX_PROSE_SIZE}
              step={1}
              value={appearance.size}
              onChange={(event) => appearance.setSize(Number(event.target.value))}
              className="min-w-0 flex-1 accent-ink-900"
            />
            <button
              type="button"
              aria-label="增大字号"
              disabled={appearance.size >= MAX_PROSE_SIZE}
              onClick={() => appearance.setSize(appearance.size + 1)}
              className="tap-target flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-100 bg-paper-raised text-lg text-ink-700 disabled:opacity-40"
            >
              ＋
            </button>
          </div>
          <p className="text-xs leading-relaxed text-ink-500">
            正文宽约 {appearance.size * 40}px（40 × 字号）；行高{' '}
            {lineHeightFor(appearance.font).toFixed(2)}。
          </p>
        </div>

        <div
          role="group"
          aria-label="正文预览"
          style={{
            fontFamily: PROSE_FONT_STACKS[appearance.font],
            fontSize: `${appearance.size}px`,
            lineHeight: lineHeightFor(appearance.font),
            maxWidth: `${appearance.size * 40}px`,
          }}
          className="rounded-xl border border-ink-100 bg-paper px-4 py-3 text-ink-900"
        >
          旧城的雨，总比别处下得慢。林照沿着石阶往上走，鞋底带起细碎的水声。
        </div>

        <Button
          size="sm"
          onClick={() => appearance.reset()}
          disabled={
            appearance.font === DEFAULT_APPEARANCE_SETTINGS.font &&
            appearance.size === DEFAULT_APPEARANCE_SETTINGS.size
          }
        >
          恢复默认
        </Button>
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
