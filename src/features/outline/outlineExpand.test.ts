import { describe, expect, it } from 'vitest';
import {
  NovelSchema,
  StyleProfileSchema,
  WritingNormSchema,
  type WritingNorm,
} from '@/domain/schema';
import { composeStylePrefix } from '@/prompt/sections';
import { buildExpandSystemPrompt } from './outlineExpand';

const novel = NovelSchema.parse({
  id: 'n1',
  title: '归墟纪',
  genre: '仙侠',
  createdAt: 0,
  updatedAt: 0,
});

const style = StyleProfileSchema.parse({
  id: 's1',
  novelId: 'n1',
  tradition: 'web',
  methodology: 'snowflake',
  createdAt: 0,
  updatedAt: 0,
});

function norm(overrides: Partial<WritingNorm> = {}): WritingNorm {
  return WritingNormSchema.parse({
    id: 'norm-1',
    novelId: 'n1',
    title: '使用提示',
    content: '- 分叉之后按新因果续写。【标记 E】',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

describe('细化大纲的系统提示 · 写作规范', () => {
  it('作用范围含规划时带上，位于稳定前缀之后、任务说明之前', () => {
    const prompt = buildExpandSystemPrompt(novel, style, [norm()]);
    const prefix = composeStylePrefix(novel, style);
    const at = prompt.indexOf('【作者的写作规范】');

    expect(prompt).toContain('【标记 E】');
    expect(prompt).toContain('规范本身不是需要生成的设定');
    expect(prompt.indexOf(prefix)).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThanOrEqual(prompt.indexOf(prefix) + prefix.length);
    expect(at).toBeLessThan(prompt.indexOf('【任务】'));
  });

  it('作用范围不含规划或已停用时不带，与不传完全相同', () => {
    const base = buildExpandSystemPrompt(novel, style);

    expect(buildExpandSystemPrompt(novel, style, [])).toBe(base);
    expect(buildExpandSystemPrompt(novel, style, [norm({ scopes: ['writing', 'check'] })])).toBe(
      base,
    );
    expect(buildExpandSystemPrompt(novel, style, [norm({ enabled: false })])).toBe(base);
  });

  it('两次调用逐字节相同', () => {
    const norms = [norm(), norm({ id: 'norm-2', title: '差异说明', order: 1 })];
    expect(buildExpandSystemPrompt(novel, style, norms)).toBe(
      buildExpandSystemPrompt(novel, style, norms),
    );
  });
});
