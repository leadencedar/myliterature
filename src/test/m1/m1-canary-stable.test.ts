/**
 * 零回归独立 canary（稳定族）：与改动前 HEAD（`52e124e`）冻结的 golden 逐字节对比。
 *
 * 为什么不直接信 noScenarioBaseline / noNormsBaseline：那两份文件的字面量允许开发
 * 在「有意变更」时更新，更新后就不再是独立证据。这里用 HEAD archive 生成的 golden，
 * 只有本文件（QA 所有）能改，且修法永远是改实现而不是改期望。
 *
 * 稳定族（M1 不允许改变）：
 * - builderMain / builderSide：正文侧上下文（S2 的 renderEntry 搬家不得改字符）
 * - chapterSystem：CHAPTER_TASK 不动
 * - expandUser（旧参数路径）：设计 §4.2 / 指标 6 要求逐字节不变
 * - renderEntry / renderSummary：见 m1-s2-render-canary
 *
 * 有意变更族（S3 的 expandSystem 任务段、S7 的 chapterUser 字数块）不在这里断言，
 * 由 QA2 的 m1-canary-intentional.test.ts 做「外科手术式」证明。
 *
 * 附加：expandSystem 的稳定前缀（【任务】之前的全部内容）必须与 HEAD 逐字节相同
 * —— S3 只允许改任务段；这一条在 S3 完成前后都成立，是缓存前缀不被破坏的证据。
 */
import { describe, expect, it } from 'vitest';
import { buildM1Snapshot } from './fixtures/m1-prompts.fixture';
import golden from './fixtures/head-golden.json';

const snapshot = buildM1Snapshot();

/** 任务段起点；S3 只允许从这里之后的文本变化 */
const TASK_MARKER = '【任务】\n';

describe('独立 canary · 稳定族 prompt 与 HEAD 逐字节一致', () => {
  it('正文上下文 builderMain（stablePrefix / volatileSuffix / items / 预选）', () => {
    expect(snapshot.builderMain).toEqual(golden.builderMain);
  });

  it('正文上下文 builderSide（外传线）', () => {
    expect(snapshot.builderSide).toEqual(golden.builderSide);
  });

  it('chapterSystem（CHAPTER_TASK 不动）', () => {
    expect(snapshot.chapterSystem).toBe(golden.chapterSystem);
  });

  it('expandUser 旧参数路径（related 未传时保持旧「标题：摘要」渲染）', () => {
    expect(snapshot.expandUser).toBe(golden.expandUser);
  });

  it('renderEntry / renderSummary 与 HEAD 一致', () => {
    expect(snapshot.renderEntry).toEqual(golden.renderEntry);
    expect(snapshot.renderSummary).toEqual(golden.renderSummary);
  });

  it('expandSystem 的缓存前缀（【任务】之前）与 HEAD 逐字节相同', () => {
    const headPrefix = golden.expandSystem.slice(0, golden.expandSystem.indexOf(TASK_MARKER));
    const currentPrefix = snapshot.expandSystem.slice(
      0,
      snapshot.expandSystem.indexOf(TASK_MARKER),
    );
    expect(currentPrefix).toBe(headPrefix);
    // 任务段必须存在且非空（防止实现意外丢掉任务说明）
    expect(
      snapshot.expandSystem.slice(snapshot.expandSystem.indexOf(TASK_MARKER)).length,
    ).toBeGreaterThan(100);
  });
});
