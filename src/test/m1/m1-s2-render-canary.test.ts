/**
 * S2 canary：`renderEntry` / `renderSummary` 从 SummaryChainContextBuilder「原样搬出」的独立证据。
 *
 * 期望值来自改动前的 HEAD（`52e124e`，由 tools/capture-head-golden.test.ts 在 /tmp 的
 * HEAD archive 上生成），不来自开发更新的任何基线文件。断言：
 * 1) 新模块 `@/context/renderEntry` 的输出与 HEAD 逐字节相同（别名、空字段、未知分类等边界）；
 * 2) 原文件 `SummaryChainContextBuilder` 的 re-export 与新模块是同一个函数引用（没有两份实现）。
 */
import { describe, expect, it } from 'vitest';
import { renderEntry, renderSummary } from '@/context/renderEntry';
import {
  renderEntry as renderEntryFromLegacy,
  renderSummary as renderSummaryFromLegacy,
} from '@/context/SummaryChainContextBuilder';
import golden from './fixtures/head-golden.json';
import {
  m1RenderEntryCases as renderEntryCases,
  m1RenderSummaryCases as renderSummaryCases,
  m1Categories as categories,
} from './fixtures/m1-prompts.fixture';

describe('S2 · renderEntry / renderSummary 搬家 canary（HEAD 冻结）', () => {
  it('renderEntry：边界夹具逐字节等于 HEAD', () => {
    for (const [name, expected] of Object.entries(golden.renderEntry)) {
      const entry = renderEntryCases[name];
      if (!entry) throw new Error(`夹具 ${name} 缺失`);
      expect([name, renderEntry(entry, categories)]).toEqual([name, expected]);
    }
  });

  it('renderSummary：完整/最小夹具逐字节等于 HEAD', () => {
    for (const [name, expected] of Object.entries(golden.renderSummary)) {
      const fixture = renderSummaryCases[name];
      if (!fixture) throw new Error(`夹具 ${name} 缺失`);
      expect([name, renderSummary(fixture.chapter, fixture.summary)]).toEqual([name, expected]);
    }
  });

  it('旧路径 re-export 与新模块是同一函数（只有一份实现）', () => {
    expect(renderEntryFromLegacy).toBe(renderEntry);
    expect(renderSummaryFromLegacy).toBe(renderSummary);
  });
});
