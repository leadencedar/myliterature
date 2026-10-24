import { describe, expect, it } from 'vitest';
import {
  REVISE_ACTIONS,
  applyRevision,
  buildReviseSystemPrompt,
  buildReviseUserPrompt,
  findReviseAction,
  normalizeSelection,
  selectionAtEnd,
  surroundingContext,
  temporaryVoiceSection,
} from './revise';

const CONTINUE = findReviseAction('continue');
const REWRITE = findReviseAction('rewrite');

describe('选区归一化', () => {
  it('剔除选区两端的空白与换行', () => {
    const content = '第一段。\n\n  第二段。  \n\n第三段。';
    // 故意把选区放宽到包含前后的换行与空格
    const raw = content.indexOf('\n\n');
    const selection = normalizeSelection(content, raw, content.indexOf('第三段'));

    expect(selection.text).toBe('第二段。');
    expect(content.slice(selection.start, selection.end)).toBe('第二段。');
  });

  it('选区已经贴合文字时保持不变', () => {
    const content = '林越拔剑。';
    const selection = normalizeSelection(content, 0, 5);
    expect(selection).toEqual({ start: 0, end: 5, text: '林越拔剑。' });
  });

  it('起点在正文最开头', () => {
    const content = '开头就被选中。后面还有。';
    const selection = normalizeSelection(content, 0, 7);
    expect(selection.start).toBe(0);
    expect(selection.text).toBe('开头就被选中。');
  });

  it('终点在正文最末尾', () => {
    const content = '前面。最后一句。';
    const selection = normalizeSelection(content, 3, content.length);
    expect(selection.end).toBe(content.length);
    expect(selection.text).toBe('最后一句。');
  });

  it('跨段落选择时保留中间的换行', () => {
    const content = '第一段。\n\n第二段。';
    const selection = normalizeSelection(content, 0, content.length);
    expect(selection.text).toBe('第一段。\n\n第二段。');
  });

  it('反向拖选（终点在起点之前）也能正确识别', () => {
    const content = '林越拔剑。';
    expect(normalizeSelection(content, 5, 0).text).toBe('林越拔剑。');
  });

  it('全是空白的选区收缩为空选区', () => {
    // 「甲。」占 0–1，三个换行占 2–4，「乙。」占 5–6
    const content = '甲。\n\n\n乙。';
    const selection = normalizeSelection(content, 2, 5);
    expect(selection.text).toBe('');
    expect(selection.start).toBe(selection.end);
  });

  it('越界的下标被裁到正文范围内', () => {
    const content = '短。';
    const selection = normalizeSelection(content, -5, 999);
    expect(selection).toEqual({ start: 0, end: 2, text: '短。' });
  });

  it('空正文返回空选区', () => {
    expect(normalizeSelection('', 0, 0)).toEqual({ start: 0, end: 0, text: '' });
  });
});

describe('默认选区（无选中时续写）', () => {
  it('定位到正文末尾，忽略尾部空白', () => {
    const content = '最后一句。\n\n  ';
    const selection = selectionAtEnd(content);
    expect(selection.start).toBe('最后一句。'.length);
    expect(selection.text).toBe('');
  });

  it('空正文时在开头', () => {
    expect(selectionAtEnd('')).toEqual({ start: 0, end: 0, text: '' });
  });
});

describe('选区上下文', () => {
  it('取前后各一段，并去掉外侧空白', () => {
    const content = '前面的内容。\n\n中间被选中。\n\n后面的内容。';
    const selection = normalizeSelection(
      content,
      content.indexOf('中间'),
      content.indexOf('中间') + 6,
    );
    const { before, after } = surroundingContext(content, selection);

    expect(before).toContain('前面的内容。');
    expect(after).toContain('后面的内容。');
    expect(before.startsWith(' ')).toBe(false);
  });

  it('按半径截断，不会把整章都带上', () => {
    const content = `${'前'.repeat(3000)}选中${'后'.repeat(3000)}`;
    const start = content.indexOf('选中');
    const selection = normalizeSelection(content, start, start + 2);
    const { before, after } = surroundingContext(content, selection, 100);

    expect(before.length).toBeLessThanOrEqual(100);
    expect(after.length).toBeLessThanOrEqual(100);
  });

  it('选区在开头或末尾时另一侧为空', () => {
    const content = '只有这一句。';
    const head = surroundingContext(content, normalizeSelection(content, 0, 3));
    expect(head.before).toBe('');

    const tail = surroundingContext(content, normalizeSelection(content, 3, content.length));
    expect(tail.after).toBe('');
  });
});

describe('替换回正文', () => {
  it('改写：就地替换选中片段', () => {
    const content = '第一段。\n\n旧的第二段。\n\n第三段。';
    const selection = normalizeSelection(
      content,
      content.indexOf('旧的第二段。'),
      content.indexOf('旧的第二段。') + 6,
    );

    expect(applyRevision(content, selection, '新的第二段。', REWRITE)).toBe(
      '第一段。\n\n新的第二段。\n\n第三段。',
    );
  });

  it('改写：替换开头片段不破坏后面的结构', () => {
    const content = '开头。\n\n后面。';
    const selection = normalizeSelection(content, 0, 3);
    expect(applyRevision(content, selection, '新开头。', REWRITE)).toBe('新开头。\n\n后面。');
  });

  it('改写：替换末尾片段', () => {
    const content = '前面。\n\n结尾。';
    const selection = normalizeSelection(content, content.indexOf('结尾。'), content.length);
    expect(applyRevision(content, selection, '新结尾。', REWRITE)).toBe('前面。\n\n新结尾。');
  });

  it('改写：跨段落替换', () => {
    const content = '甲。\n\n乙。\n\n丙。';
    const selection = normalizeSelection(content, 0, content.indexOf('丙。') - 2);
    expect(applyRevision(content, selection, '合并后的一段。', REWRITE)).toBe(
      '合并后的一段。\n\n丙。',
    );
  });

  it('续写：在选区之后另起一段', () => {
    const content = '第一段。\n\n第二段。';
    const selection = normalizeSelection(content, 0, 4);

    expect(applyRevision(content, selection, '插入的新段。', CONTINUE)).toBe(
      '第一段。\n\n插入的新段。\n\n第二段。',
    );
  });

  it('续写：接在正文末尾', () => {
    const content = '已有的结尾。';
    expect(applyRevision(content, selectionAtEnd(content), '续写的内容。', CONTINUE)).toBe(
      '已有的结尾。\n\n续写的内容。',
    );
  });

  it('续写：原处已有空行时不再重复加', () => {
    const content = '第一段。\n\n';
    const selection = { start: content.length, end: content.length, text: '' };
    // 不应出现三个以上连续换行
    expect(applyRevision(content, selection, '新段。', CONTINUE)).toBe('第一段。\n\n新段。');
  });

  it('续写：空正文时不产生前导空行', () => {
    expect(applyRevision('', selectionAtEnd(''), '开篇第一句。', CONTINUE)).toBe('开篇第一句。');
  });

  it('生成结果为空白时原文不变', () => {
    const content = '原文不动。';
    const selection = normalizeSelection(content, 0, 5);
    expect(applyRevision(content, selection, '   \n ', REWRITE)).toBe(content);
  });

  it('结果两端的空白会被修掉', () => {
    const content = '甲。';
    const selection = normalizeSelection(content, 0, 2);
    expect(applyRevision(content, selection, '  乙。\n\n ', REWRITE)).toBe('乙。');
  });
});

describe('操作定义', () => {
  it('三种操作的放置方式与选区要求各不相同', () => {
    expect(REVISE_ACTIONS.map((action) => action.id)).toEqual(['continue', 'rewrite', 'expand']);
    expect(findReviseAction('continue')).toMatchObject({
      placement: 'after',
      requiresSelection: false,
    });
    expect(findReviseAction('rewrite')).toMatchObject({
      placement: 'replace',
      requiresSelection: true,
    });
    expect(findReviseAction('expand').requiresSelection).toBe(true);
  });
});

describe('提示词', () => {
  it('系统提示按操作给出不同任务，并带上通用约束', () => {
    const rewrite = buildReviseSystemPrompt('稳定前缀', 'rewrite');
    expect(rewrite).toContain('稳定前缀');
    expect(rewrite).toContain('情节、信息与人物行为保持不变');
    expect(rewrite).toContain('人物口吻不得变样');

    const expand = buildReviseSystemPrompt('稳定前缀', 'expand');
    expect(expand).toContain('大致为原片段的两倍');
    expect(expand).toContain('不要引入新的情节转折');

    const cont = buildReviseSystemPrompt('稳定前缀', 'continue');
    expect(cont).toContain('只输出新写的内容，不要重复已有的文字');
  });

  it('用户提示按顺序给出前文、待处理片段与后文', () => {
    const prompt = buildReviseUserPrompt({
      volatileSuffix: '【本章要写的内容】\n梗概',
      selection: { start: 0, end: 3, text: '选中的片段' },
      before: '前面的内容',
      after: '后面的内容',
    });

    const order = ['【本章要写的内容】', '【前文】', '【待处理片段】', '【后文'].map((marker) =>
      prompt.indexOf(marker),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain('不要写进去，但要能接上');
  });

  it('没有选中内容时明确告知从前文结尾继续', () => {
    const prompt = buildReviseUserPrompt({
      volatileSuffix: '',
      selection: { start: 0, end: 0, text: '' },
      before: '前面的内容',
      after: '',
    });
    expect(prompt).toContain('（无，请从前文结尾处继续）');
  });

  it('前文或后文为空时不产生空标题', () => {
    const prompt = buildReviseUserPrompt({
      volatileSuffix: '',
      selection: { start: 0, end: 2, text: '片段' },
      before: '',
      after: '',
    });
    expect(prompt).not.toContain('【前文】');
    expect(prompt).not.toContain('【后文');
  });

  it('额外要求会带上', () => {
    const prompt = buildReviseUserPrompt({
      volatileSuffix: '',
      selection: { start: 0, end: 2, text: '片段' },
      before: '',
      after: '',
      instruction: '多用短句',
    });
    expect(prompt).toContain('多用短句');
  });
});

describe('临时文风', () => {
  it('展开该作家的全部风格维度，并声明只影响本次', () => {
    const section = temporaryVoiceSection('gulong');

    expect(section).toContain('古龙');
    expect(section).toContain('句式节奏');
    expect(section).toContain('不改变作品既有的文风设定');
  });

  it('未指定或 id 不存在时返回空串', () => {
    expect(temporaryVoiceSection(null)).toBe('');
    expect(temporaryVoiceSection('不存在的作家')).toBe('');
  });

  it('指定临时文风后会出现在用户提示里', () => {
    const prompt = buildReviseUserPrompt({
      volatileSuffix: '',
      selection: { start: 0, end: 2, text: '片段' },
      before: '',
      after: '',
      temporaryVoiceId: 'luxun',
    });
    expect(prompt).toContain('【本次临时文风】');
    expect(prompt).toContain('鲁迅');
  });
});
