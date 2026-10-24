import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLlmSettings } from '@/llm/settingsStore';
import { jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { SettingsPage } from './SettingsPage';

let harness: TestHarness;

/** 备份区要用仓储，所以设置页也得包在 Provider 里 */
function render(ui: React.ReactNode) {
  return harness.renderUI(ui);
}

beforeEach(async () => {
  harness = await createTestHarness();
  localStorage.clear();
  // 配置 store 是持久化单例，用例之间必须重置
  useLlmSettings.getState().applyPreset('deepseek');
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

/** 填好一份可用配置 */
function configure() {
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
}

describe('设置页 · 模型配置', () => {
  it('默认预置 DeepSeek 的接口地址与模型', () => {
    render(<SettingsPage />);

    expect(screen.getByLabelText('接口地址')).toHaveValue('https://api.deepseek.com');
    expect(screen.getByLabelText('常规模型')).toHaveValue('deepseek-flash');
    expect(screen.getByLabelText('重点任务模型')).toHaveValue('deepseek-v4-pro');
  });

  it('API Key 默认遮蔽，可切换显示', async () => {
    const user = userEvent.setup();
    configure();
    render(<SettingsPage />);

    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: '显示' }));
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'text');
  });

  it('切换服务商会重置地址、模型并清空密钥', async () => {
    const user = userEvent.setup();
    configure();
    render(<SettingsPage />);

    await user.selectOptions(screen.getByLabelText('服务商'), 'openai');

    expect(screen.getByLabelText('接口地址')).toHaveValue('https://api.openai.com/v1');
    // 换服务商后旧 Key 不再适用，留着只是风险
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(useLlmSettings.getState().capabilities.jsonSchema).toBe(true);
  });

  it('可以清除密钥', async () => {
    const user = userEvent.setup();
    configure();
    render(<SettingsPage />);

    await user.click(screen.getByRole('button', { name: '清除密钥' }));

    expect(useLlmSettings.getState().apiKey).toBe('');
  });

  it('模型分工区展示每个任务实际使用的模型与思维链开关', () => {
    render(<SettingsPage />);

    const setup = screen.getByText('生成世界观与大纲').closest('li');
    // 立项走重点任务模型且开思维链
    expect(setup).toHaveTextContent('deepseek-v4-pro');
    expect(setup).toHaveTextContent('开启思维链');

    const draft = screen.getByText('生成章节正文').closest('li');
    expect(draft).toHaveTextContent('deepseek-flash');
    expect(draft).toHaveTextContent('关闭思维链');
  });
});

describe('设置页 · 连通性测试', () => {
  it('未填密钥时禁用按钮并说明原因', () => {
    render(<SettingsPage />);

    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
    expect(screen.getByText(/请先填写接口地址、API Key 与模型名/u)).toBeInTheDocument();
  });

  it('流式输出逐步显示，并汇报 token 用量与缓存命中', async () => {
    const user = userEvent.setup();
    configure();
    const usageEvent = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 42, completion_tokens: 12, prompt_cache_hit_tokens: 30 },
    })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(textDeltaEvents(['雨敲', '旧书'], [usageEvent])))),
    );

    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    expect(await screen.findByText('雨敲旧书')).toBeInTheDocument();
    await waitFor(() => {
      const note = screen.getByText(/缓存命中/u);
      expect(note).toHaveTextContent('输入 42 token');
      // 缓存命中数是验证 prompt 稳定前缀策略的关键指标，必须回显
      expect(note).toHaveTextContent('缓存命中 30');
      expect(note).toHaveTextContent('输出 12 token');
    });
  });

  it('请求体按 DeepSeek 能力关闭思维链', async () => {
    const user = userEvent.setup();
    configure();
    const fetchSpy = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(sseResponse(textDeltaEvents(['好']))),
    );
    vi.stubGlobal('fetch', fetchSpy);

    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await screen.findByText('好');

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'disabled' },
    });
  });

  it('密钥无效时给出可操作的提示', async () => {
    const user = userEvent.setup();
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: { message: 'Invalid token' } }, 401))),
    );

    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('API Key 无效');
    // 保留服务端原文便于排查
    expect(alert).toHaveTextContent('Invalid token');
  });

  it('余额不足时提示充值', async () => {
    const user = userEvent.setup();
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({}, 402))),
    );

    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('余额不足');
  });

  it('网络不通时提示检查白名单', async () => {
    const user = userEvent.setup();
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('白名单');
  });
});
