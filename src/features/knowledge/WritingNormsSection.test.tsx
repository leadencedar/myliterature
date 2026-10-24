import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNovel } from '@/app/store/useActiveNovel';
import type { Novel } from '@/domain/schema';
import { useLlmSettings } from '@/llm/settingsStore';
import { jsonResponse, sseResponse, textDeltaEvents } from '@/test/llmFixtures';
import { createTestHarness, type TestHarness } from '@/test/renderWithProviders';
import { KnowledgePage } from './KnowledgePage';
import { NORM_CONDENSE_SYSTEM } from './normCondense';

/**
 * 知识库「写作规范」区块与编辑面板（设计 7.1 / 7.2、测试计划 12.6）。
 * 守的是两件事：作者的原文逐字入库；AI 精简在作者点另存之前什么都不写。
 */

let harness: TestHarness;
let novel: Novel;

beforeEach(async () => {
  harness = await createTestHarness();
  novel = await harness.repository.createNovel({ title: '归墟纪' });
  useActiveNovel.setState({ activeNovelId: novel.id });
  useLlmSettings.getState().applyPreset('deepseek');
  useLlmSettings.getState().update({ apiKey: 'sk-test' });
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

async function renderPage() {
  const user = userEvent.setup();
  harness.renderUI(<KnowledgePage />);
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  return user;
}

function section(): HTMLElement {
  return screen.getByRole('heading', { name: '写作规范' }).closest('section')!;
}

function listNorms() {
  return harness.repository.listWritingNorms(novel.id);
}

function textFile(name: string, content: string): File {
  return new File([new TextEncoder().encode(content)], name, { type: 'text/plain' });
}

function linkLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `- 来源 https://example.com/${i + 1}`).join('\n');
}

async function openEditorOf(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await within(section()).findByRole('button', { name: title }));
  return screen.findByRole('dialog', { name: '编辑写作规范' });
}

describe('新建与上传', () => {
  it('空状态给出两个入口；粘贴新建后库里正文与粘贴内容逐字相同', async () => {
    const user = await renderPage();
    expect(within(section()).getByText('还没有写作规范')).toBeInTheDocument();
    expect(within(section()).getAllByRole('button', { name: '新建规范' })).toHaveLength(1);
    expect(within(section()).getAllByRole('button', { name: '从文件新建' })).toHaveLength(1);

    await user.click(within(section()).getByRole('button', { name: '新建规范' }));
    const dialog = await screen.findByRole('dialog', { name: '新建写作规范' });
    // 首尾空白、## 小标题、空行、作者自己写的结束标记都要原样保存
    const pasted = '  ## 写作规则\n\n- 以本作当前时期为准。\n【规范《X》结束】\n  ';
    await user.type(within(dialog).getByLabelText('标题'), '使用提示');
    await user.click(within(dialog).getByLabelText('正文'));
    await user.paste(pasted);
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(section()).findByRole('button', { name: '使用提示' })).toBeInTheDocument();
    const norms = await listNorms();
    expect(norms).toHaveLength(1);
    expect(norms[0]!.content).toBe(pasted);
    expect(norms[0]!.enabled).toBe(true);
  });

  it('从 .md 新建：预填标题与正文、显示编码，保存后换行统一为 \\n', async () => {
    const user = await renderPage();
    await user.upload(screen.getByLabelText('规范文件'), textFile('规范.md', '# 规范\r\n- 一条'));

    const dialog = await screen.findByRole('dialog', { name: '新建写作规范' });
    expect(within(dialog).getByLabelText('标题')).toHaveValue('规范');
    expect(within(dialog).getByLabelText('正文')).toHaveValue('# 规范\n- 一条');
    expect(within(dialog).getByText('已读入《规范.md》，识别为 UTF-8')).toBeInTheDocument();
    // 读文件不写库，点保存才落库
    expect(await listNorms()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(async () => expect(await listNorms()).toHaveLength(1));
    expect((await listNorms())[0]!.content).toBe('# 规范\n- 一条');
  });

  it('.docx 被拒并提示另存为 .txt，不开面板不写库', async () => {
    await renderPage();
    // applyAccept: false 模拟在系统对话框里选了「所有文件」
    const loose = userEvent.setup({ applyAccept: false });
    await loose.upload(
      screen.getByLabelText('规范文件'),
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], '规范.docx'),
    );
    expect(await within(section()).findByRole('alert')).toHaveTextContent('暂不支持 .docx 文件');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await listNorms()).toHaveLength(0);
  });

  it('解码后超过 60000 字的文件被拒，不开面板不写库', async () => {
    const user = await renderPage();
    await user.upload(screen.getByLabelText('规范文件'), textFile('长.md', '一'.repeat(60001)));
    const alert = await within(section()).findByRole('alert');
    expect(alert).toHaveTextContent('这个文件有 60001 字');
    expect(alert).toHaveTextContent('超过单份规范 60000 字的上限');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await listNorms()).toHaveLength(0);
  });

  it('插入差异说明模板：空规范时填入标题与模板', async () => {
    const user = await renderPage();
    await user.click(within(section()).getByRole('button', { name: '新建' }));
    const dialog = await screen.findByRole('dialog', { name: '新建写作规范' });
    await user.click(within(dialog).getByRole('button', { name: '插入差异说明模板' }));
    expect(within(dialog).getByLabelText('标题')).toHaveValue('本作差异说明');
    expect((within(dialog).getByLabelText('正文') as HTMLTextAreaElement).value).toContain(
      '【本作开场时期】',
    );
  });

  it('上传文件追加：以空行接在正文末尾', async () => {
    await harness.repository.createWritingNorm(novel.id, { title: 'A', content: '原有一条' });
    const user = await renderPage();
    const dialog = await openEditorOf(user, 'A');
    await user.upload(
      within(dialog).getByLabelText('追加的规范文件'),
      textFile('补.txt', '补一条'),
    );
    await waitFor(() =>
      expect(within(dialog).getByLabelText('正文')).toHaveValue('原有一条\n\n补一条'),
    );
  });
});

describe('列表', () => {
  it('两份规范时开关与上下移的无障碍名按《标题》区分，每个控件只渲染一份', async () => {
    await harness.repository.createWritingNorm(novel.id, { title: 'A', content: '甲' });
    await harness.repository.createWritingNorm(novel.id, { title: 'B', content: '乙' });
    const user = await renderPage();
    const box = section();
    await within(box).findByRole('button', { name: 'A' });

    for (const title of ['A', 'B']) {
      expect(within(box).getAllByRole('checkbox', { name: `启用《${title}》` })).toHaveLength(1);
      expect(within(box).getAllByRole('button', { name: `上移《${title}》` })).toHaveLength(1);
      expect(within(box).getAllByRole('button', { name: `下移《${title}》` })).toHaveLength(1);
    }
    expect(within(box).getByRole('button', { name: '上移《A》' })).toBeDisabled();
    expect(within(box).getByRole('button', { name: '下移《B》' })).toBeDisabled();
    expect(within(box).getAllByRole('button', { name: '新建' })).toHaveLength(1);
    expect(within(box).getAllByRole('button', { name: '从文件新建' })).toHaveLength(1);
    expect(screen.getAllByLabelText('规范文件')).toHaveLength(1);

    // 编辑面板的作用范围默认六项全开
    const dialog = await openEditorOf(user, 'A');
    expect(within(dialog).getAllByRole('button', { pressed: true })).toHaveLength(6);
  });

  it('元信息按固定顺序列出作用范围，与勾选先后无关', async () => {
    await harness.repository.createWritingNorm(novel.id, { title: 'A', content: '甲' });
    const user = await renderPage();
    expect(
      await within(section()).findByText(/· 写正文、规划、章节摘要、提取设定、检查、互动推演$/u),
    ).toBeInTheDocument();

    const dialog = await openEditorOf(user, 'A');
    for (const label of ['规划', '章节摘要', '检查', '写正文']) {
      await user.click(within(dialog).getByRole('button', { name: label }));
    }
    // 最后再勾回「写正文」：草稿里它排在「提取设定」之后，显示与存储仍按固定顺序
    await user.click(within(dialog).getByRole('button', { name: '写正文' }));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(
      await within(section()).findByText(/· 写正文、提取设定、互动推演$/u),
    ).toBeInTheDocument();
    expect((await listNorms())[0]!.scopes).toEqual(['writing', 'extract', 'interactive']);
  });

  it('编辑标题与正文后保存', async () => {
    await harness.repository.createWritingNorm(novel.id, { title: 'A', content: '甲' });
    const user = await renderPage();
    const dialog = await openEditorOf(user, 'A');
    const title = within(dialog).getByLabelText('标题');
    await user.clear(title);
    await user.type(title, 'A2');
    await user.type(within(dialog).getByLabelText('正文'), '乙');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await within(section()).findByRole('button', { name: 'A2' })).toBeInTheDocument();
    const [norm] = await listNorms();
    expect(norm!.title).toBe('A2');
    expect(norm!.content).toBe('甲乙');
  });

  it('列表上的启用开关直接停用，元信息标「已停用」', async () => {
    await harness.repository.createWritingNorm(novel.id, { title: 'A', content: '甲' });
    const user = await renderPage();
    const toggle = await within(section()).findByRole('checkbox', { name: '启用《A》' });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(async () => expect((await listNorms())[0]!.enabled).toBe(false));
    expect(await within(section()).findByText(/^已停用 · /u)).toBeInTheDocument();
    expect(within(section()).getByRole('checkbox', { name: '启用《A》' })).not.toBeChecked();
  });

  it('上移 / 下移改变顺序', async () => {
    await harness.repository.createWritingNorm(novel.id, { title: 'A', content: '甲' });
    await harness.repository.createWritingNorm(novel.id, { title: 'B', content: '乙' });
    const user = await renderPage();
    await user.click(await within(section()).findByRole('button', { name: '下移《A》' }));
    await waitFor(async () =>
      expect((await listNorms()).map((norm) => norm.title)).toEqual(['B', 'A']),
    );
    await waitFor(() =>
      expect(within(section()).getByRole('button', { name: '上移《B》' })).toBeDisabled(),
    );

    await user.click(within(section()).getByRole('button', { name: '上移《A》' }));
    await waitFor(async () =>
      expect((await listNorms()).map((norm) => norm.title)).toEqual(['A', 'B']),
    );
  });

  it('删除：取消不删，确认后删', async () => {
    await harness.repository.createWritingNorm(novel.id, { title: 'A', content: '甲' });
    const user = await renderPage();
    let dialog = await openEditorOf(user, 'A');

    await user.click(within(dialog).getByRole('button', { name: '删除这份规范' }));
    let confirm = await screen.findByRole('dialog', { name: '删除这份规范？' });
    expect(confirm).toHaveTextContent('删除后无法恢复。只删除这份规范，不影响已经写好的章节。');
    await user.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(await listNorms()).toHaveLength(1);

    dialog = screen.getByRole('dialog', { name: '编辑写作规范' });
    await user.click(within(dialog).getByRole('button', { name: '删除这份规范' }));
    confirm = await screen.findByRole('dialog', { name: '删除这份规范？' });
    await user.click(within(confirm).getByRole('button', { name: '删除' }));

    await waitFor(async () => expect(await listNorms()).toHaveLength(0));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(section()).findByText('还没有写作规范')).toBeInTheDocument();
  });

  it('删除失败：确认框关闭，面板内提示原因，库里不变', async () => {
    await harness.repository.createWritingNorm(novel.id, { title: 'A', content: '甲' });
    vi.spyOn(harness.repository, 'deleteWritingNorm').mockRejectedValueOnce(new Error('磁盘已满'));
    const user = await renderPage();
    const dialog = await openEditorOf(user, 'A');

    await user.click(within(dialog).getByRole('button', { name: '删除这份规范' }));
    const confirm = await screen.findByRole('dialog', { name: '删除这份规范？' });
    await user.click(within(confirm).getByRole('button', { name: '删除' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('磁盘已满');
    expect(screen.queryByRole('dialog', { name: '删除这份规范？' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '编辑写作规范' })).toBeInTheDocument();
    expect(await listNorms()).toHaveLength(1);
  });
});

describe('成本提示', () => {
  it('链接超过 5 个时提示来源表，5 个时不提示', async () => {
    const user = await renderPage();
    await user.click(within(section()).getByRole('button', { name: '新建' }));
    const dialog = await screen.findByRole('dialog', { name: '新建写作规范' });
    const body = within(dialog).getByLabelText('正文');

    await user.click(body);
    await user.paste(linkLines(5));
    expect(within(dialog).queryByText(/来源表通常不必进提示词/u)).not.toBeInTheDocument();

    await user.clear(body);
    await user.paste(linkLines(6));
    const hint = within(dialog).getByText(/来源表通常不必进提示词/u);
    expect(hint).toHaveTextContent(
      '其中有 6 个链接。来源表通常不必进提示词，可以删掉或试试 AI 精简。',
    );
  });

  it('单份超过阈值时列表与面板提示较长；写正文合计超过阈值时区块提示', async () => {
    for (const title of ['A', 'B', 'C']) {
      await harness.repository.createWritingNorm(novel.id, { title, content: '一'.repeat(3000) });
    }
    const user = await renderPage();
    await within(section()).findByRole('button', { name: 'A' });
    expect(within(section()).getAllByText('较长')).toHaveLength(3);
    expect(
      within(section()).getByText(/^启用中的写正文规范合计约 7\.\dk tokens，每次生成都会带上/u),
    ).toBeInTheDocument();

    const dialog = await openEditorOf(user, 'A');
    expect(within(dialog).getByText(/较长，每次生成都会带上/u)).toBeInTheDocument();
  });

  it('合计不超过阈值时没有区块提示', async () => {
    await harness.repository.createWritingNorm(novel.id, { title: 'A', content: '甲' });
    await renderPage();
    await within(section()).findByRole('button', { name: 'A' });
    expect(within(section()).queryByText(/启用中的写正文规范合计/u)).not.toBeInTheDocument();
    expect(within(section()).queryByText('较长')).not.toBeInTheDocument();
  });
});

describe('AI 精简', () => {
  const ORIGINAL = '## 写作规则\n- 以本作当前时期为准。\n\n## 来源\n- https://example.com/1';
  const CONDENSED = '## 写作规则\n- 以本作当前时期为准。';

  function stubStream(deltas: string[], extra: string[] = []) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(sseResponse(textDeltaEvents(deltas, extra))));
  }

  async function seedAndOpen() {
    await harness.repository.createWritingNorm(novel.id, { title: '使用提示', content: ORIGINAL });
    const user = await renderPage();
    const dialog = await openEditorOf(user, '使用提示');
    return { user, dialog };
  }

  it('预览阶段库里不变且草稿被锁；另存后新规范排在原规范后、原规范停用、面板关闭并提示', async () => {
    const spy = stubStream(['## 写作规则\n', '- 以本作当前时期为准。']);
    const { user, dialog } = await seedAndOpen();

    await user.click(within(dialog).getByRole('button', { name: 'AI 精简' }));
    const preview = await within(dialog).findByLabelText('精简结果（可直接修改）');
    expect(preview).toHaveValue(CONDENSED);

    const body = JSON.parse(String(spy.mock.calls[0]?.[1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages[0]).toEqual({ role: 'system', content: NORM_CONDENSE_SYSTEM });
    expect(body.messages[1]!.content).toBe(`【规范标题】\n使用提示\n\n【规范原文】\n${ORIGINAL}`);

    // 预览时什么都没写
    expect(await listNorms()).toHaveLength(1);
    expect(within(dialog).getByLabelText('正文')).toBeDisabled();
    expect(within(dialog).getByLabelText('标题')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '上传文件追加' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '插入差异说明模板' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '写正文' })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: '启用' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: '另存为新规范（原文自动停用）' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(section()).findByRole('status')).toHaveTextContent(
      '已另存为《使用提示（精简）》，原规范已停用。',
    );
    const norms = await listNorms();
    expect(norms.map((norm) => norm.title)).toEqual(['使用提示', '使用提示（精简）']);
    expect(norms[0]!.enabled).toBe(false);
    expect(norms[0]!.content).toBe(ORIGINAL);
    expect(norms[1]!.enabled).toBe(true);
    expect(norms[1]!.content).toBe(CONDENSED);
    expect(norms[1]!.scopes).toEqual(norms[0]!.scopes);

    // 重开原规范，「启用」未勾选
    const reopened = await openEditorOf(user, '使用提示');
    expect(within(reopened).getByRole('checkbox', { name: '启用' })).not.toBeChecked();
  });

  it('预览可编辑，另存的是改过的内容', async () => {
    stubStream([CONDENSED]);
    const { user, dialog } = await seedAndOpen();
    await user.click(within(dialog).getByRole('button', { name: 'AI 精简' }));
    const preview = await within(dialog).findByLabelText('精简结果（可直接修改）');
    await user.type(preview, '\n- 补一条。');
    await user.click(within(dialog).getByRole('button', { name: '另存为新规范（原文自动停用）' }));
    await waitFor(async () => expect(await listNorms()).toHaveLength(2));
    expect((await listNorms())[1]!.content).toBe(`${CONDENSED}\n- 补一条。`);
  });

  it('放弃后库里无变化，回到可编辑状态', async () => {
    stubStream([CONDENSED]);
    const { user, dialog } = await seedAndOpen();
    await user.click(within(dialog).getByRole('button', { name: 'AI 精简' }));
    await within(dialog).findByLabelText('精简结果（可直接修改）');
    await user.click(within(dialog).getByRole('button', { name: '放弃' }));

    expect(within(dialog).queryByLabelText('精简结果（可直接修改）')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('正文')).toBeEnabled();
    const norms = await listNorms();
    expect(norms).toHaveLength(1);
    expect(norms[0]!.enabled).toBe(true);
    expect(norms[0]!.content).toBe(ORIGINAL);
  });

  it('模型调用失败时显示错误，库里无变化', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'boom' } }, 500),
    );
    const { user, dialog } = await seedAndOpen();
    await user.click(within(dialog).getByRole('button', { name: 'AI 精简' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('模型服务暂时不可用');
    expect(within(dialog).getByLabelText('正文')).toBeEnabled();
    const norms = await listNorms();
    expect(norms).toHaveLength(1);
    expect(norms[0]!.enabled).toBe(true);
  });

  it('输出被截断时提示核对结尾；空输出提示重试', async () => {
    stubStream(
      [CONDENSED],
      [`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`],
    );
    const { user, dialog } = await seedAndOpen();
    await user.click(within(dialog).getByRole('button', { name: 'AI 精简' }));
    expect(await within(dialog).findByText('结果可能被截断，请核对结尾。')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '放弃' }));
    vi.restoreAllMocks();
    stubStream(['  ']);
    await user.click(within(dialog).getByRole('button', { name: 'AI 精简' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '模型没有返回内容，可以再试一次',
    );
    expect(await listNorms()).toHaveLength(1);
  });

  it('预览只剩空白时另存禁用；超长时预检报中文错误且不写库', async () => {
    stubStream(['一'.repeat(60001)]);
    const { user, dialog } = await seedAndOpen();
    await user.click(within(dialog).getByRole('button', { name: 'AI 精简' }));
    const preview = await within(dialog).findByLabelText('精简结果（可直接修改）');
    const saveCopy = within(dialog).getByRole('button', { name: '另存为新规范（原文自动停用）' });

    await user.click(saveCopy);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('单份规范不能超过 60000 字');
    expect(within(dialog).getByRole('alert')).not.toHaveTextContent('{');
    expect(await listNorms()).toHaveLength(1);
    // 失败保留面板与预览
    expect(preview).toBeInTheDocument();

    await user.clear(preview);
    await user.type(preview, '   ');
    expect(saveCopy).toBeDisabled();
  });

  it('有未保存的修改时禁用并提示先保存', async () => {
    const { user, dialog } = await seedAndOpen();
    expect(within(dialog).getByRole('button', { name: 'AI 精简' })).toBeEnabled();
    await user.type(within(dialog).getByLabelText('标题'), '改');
    expect(within(dialog).getByRole('button', { name: 'AI 精简' })).toBeDisabled();
    expect(within(dialog).getByText('先保存再精简。')).toBeInTheDocument();
  });

  it('作用范围只改了勾选先后不算未保存修改', async () => {
    const { user, dialog } = await seedAndOpen();
    await user.click(within(dialog).getByRole('button', { name: '写正文' }));
    expect(within(dialog).getByRole('button', { name: 'AI 精简' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: '写正文' }));
    expect(within(dialog).getByRole('button', { name: 'AI 精简' })).toBeEnabled();
  });

  it('未配置模型时禁用并说明原因', async () => {
    useLlmSettings.getState().update({ apiKey: '' });
    const { dialog } = await seedAndOpen();
    expect(within(dialog).getByRole('button', { name: 'AI 精简' })).toBeDisabled();
    expect(within(dialog).getByText('需要先在「设置」里配置模型。')).toBeInTheDocument();
  });

  it('新建面板不显示 AI 精简', async () => {
    const user = await renderPage();
    await user.click(within(section()).getByRole('button', { name: '新建' }));
    const dialog = await screen.findByRole('dialog', { name: '新建写作规范' });
    expect(within(dialog).queryByRole('button', { name: 'AI 精简' })).not.toBeInTheDocument();
  });
});
