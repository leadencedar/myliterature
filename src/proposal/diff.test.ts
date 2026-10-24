import { describe, expect, it } from 'vitest';
import { buildCreateProposal, buildMergeProposal, buildReplaceProposal } from './build';
import {
  applyEdits,
  computeDiff,
  hasSubstantiveChange,
  mergeEntities,
  summarizeDiff,
} from './diff';
import type { FieldSpec } from './fields';

const SPECS: FieldSpec[] = [
  { path: 'title', label: '名称', kind: 'text' },
  { path: 'aliases', label: '别名', kind: 'list' },
  { path: 'summary', label: '摘要', kind: 'longtext' },
  { path: 'fields.identity', label: '身份', kind: 'text' },
];

describe('计算差异', () => {
  it('没有原值时全部标为新增', () => {
    const diffs = computeDiff(SPECS, { title: '林越', summary: '少年剑客' });

    expect(diffs.map((d) => [d.field, d.kind])).toEqual([
      ['title', 'added'],
      ['summary', 'added'],
    ]);
    expect(diffs[0]?.before).toBeNull();
  });

  it('两边都空的字段不进 diff', () => {
    const diffs = computeDiff(SPECS, { title: '林越' }, { title: '林越' });
    expect(diffs).toHaveLength(1);
  });

  it('区分新增、改动与未变', () => {
    const diffs = computeDiff(
      SPECS,
      { title: '林越', summary: '改写后的摘要', fields: { identity: '流亡贵族' } },
      { title: '林越', summary: '原摘要' },
    );
    const byField = new Map(diffs.map((d) => [d.field, d]));

    expect(byField.get('title')?.kind).toBe('unchanged');
    expect(byField.get('summary')?.kind).toBe('changed');
    expect(byField.get('summary')?.before).toBe('原摘要');
    expect(byField.get('fields.identity')?.kind).toBe('added');
  });

  it('新值为空时视作保持原值，不当成删除', () => {
    // 模型没提到某字段不等于该字段应被清空，这是反向提取最容易造成数据损失的地方
    const diffs = computeDiff(
      SPECS,
      { title: '林越', summary: '' },
      { title: '林越', summary: '原摘要' },
    );
    const summary = diffs.find((d) => d.field === 'summary');

    expect(summary?.kind).toBe('unchanged');
    expect(summary?.after).toBe('原摘要');
  });
});

describe('差异摘要', () => {
  it('分别统计新增与改动', () => {
    const diffs = computeDiff(
      SPECS,
      { title: '新名', summary: '新摘要', fields: { identity: '身份' } },
      { title: '旧名', summary: '' },
    );
    expect(summarizeDiff(diffs)).toBe('2 项新增 · 1 项改动');
  });

  it('无变化时给出明确文案', () => {
    const diffs = computeDiff(SPECS, { title: '林越' }, { title: '林越' });
    expect(summarizeDiff(diffs)).toBe('无变化');
    expect(hasSubstantiveChange(diffs)).toBe(false);
  });
});

describe('合并实体', () => {
  it('列表字段取并集并去重（忽略大小写）', () => {
    const merged = mergeEntities(
      SPECS,
      { aliases: ['阿越', 'Lin'] },
      { aliases: ['越哥', 'lin'] },
    ) as { aliases: string[] };

    expect(merged.aliases).toEqual(['阿越', 'Lin', '越哥']);
  });

  it('原值为空时采用新值', () => {
    const merged = mergeEntities(SPECS, { title: '林越', summary: '' }, { summary: '少年剑客' });
    expect(merged).toMatchObject({ title: '林越', summary: '少年剑客' });
  });

  it('新值为空时保留原值', () => {
    const merged = mergeEntities(SPECS, { summary: '原摘要' }, { summary: '' });
    expect(merged).toMatchObject({ summary: '原摘要' });
  });

  it('两边都有值时采用新值（模型输出的是整合后的完整字段）', () => {
    const merged = mergeEntities(SPECS, { summary: '原摘要' }, { summary: '整合后的摘要' });
    expect(merged).toMatchObject({ summary: '整合后的摘要' });
  });

  it('保留原实体中不在字段规格内的属性', () => {
    const merged = mergeEntities(
      SPECS,
      { id: 'e1', pinned: true, title: '林越' },
      { title: '林越' },
    );
    expect(merged).toMatchObject({ id: 'e1', pinned: true });
  });
});

describe('应用行内编辑', () => {
  it('把编辑值写回 payload', () => {
    const next = applyEdits(SPECS, { title: '旧名' }, { title: '新名', 'fields.identity': '剑客' });
    expect(next).toEqual({ title: '新名', fields: { identity: '剑客' } });
  });

  it('忽略不在规格内的字段，避免写入脏数据', () => {
    const next = applyEdits(SPECS, { title: '林越' }, { hacked: 'x' });
    expect(next).toEqual({ title: '林越' });
  });
});

describe('构造提案', () => {
  const common = {
    novelId: 'n1',
    origin: 'generate' as const,
    target: 'knowledgeEntry' as const,
    label: '人物 · 林越',
    specs: SPECS,
  };

  it('新建提案的 diff 全为新增，targetId 为空', () => {
    const proposal = buildCreateProposal({ ...common, payload: { title: '林越' } });

    expect(proposal.action).toBe('create');
    expect(proposal.targetId).toBeNull();
    expect(proposal.status).toBe('pending');
    expect(proposal.diff.every((d) => d.kind === 'added')).toBe(true);
  });

  it('合并提案的 payload 是合并结果，diff 相对原值', () => {
    const proposal = buildMergeProposal({
      ...common,
      targetId: 'e1',
      current: { id: 'e1', title: '林越', aliases: ['阿越'], summary: '原摘要' },
      incoming: { aliases: ['越哥'], summary: '新摘要' },
      sourceRef: '第 3 章',
    });

    expect(proposal.action).toBe('merge');
    expect(proposal.targetId).toBe('e1');
    expect(proposal.sourceRef).toBe('第 3 章');
    expect(proposal.payload).toMatchObject({
      title: '林越',
      aliases: ['阿越', '越哥'],
      summary: '新摘要',
    });
    expect(proposal.diff.find((d) => d.field === 'summary')?.before).toBe('原摘要');
  });

  it('替换提案不做合并，直接用给定 payload', () => {
    const proposal = buildReplaceProposal({
      ...common,
      target: 'chapter',
      targetId: 'c1',
      current: { title: '旧标题', content: '旧正文' },
      payload: { title: '新标题', content: '新正文' },
      specs: [
        { path: 'title', label: '标题', kind: 'text' },
        { path: 'content', label: '正文', kind: 'longtext' },
      ],
    });

    expect(proposal.action).toBe('replace');
    expect(proposal.payload).toEqual({ title: '新标题', content: '新正文' });
    expect(proposal.diff.every((d) => d.kind === 'changed')).toBe(true);
  });

  it('同批次提案共享 batchId', () => {
    const batchId = 'batch-1';
    const a = buildCreateProposal({ ...common, batchId, payload: { title: '甲' } });
    const b = buildCreateProposal({ ...common, batchId, payload: { title: '乙' } });

    expect(a.batchId).toBe(batchId);
    expect(b.batchId).toBe(batchId);
    expect(a.id).not.toBe(b.id);
  });
});
