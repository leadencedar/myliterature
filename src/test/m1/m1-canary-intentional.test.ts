/**
 * 零回归独立 canary（有意变更族）：「外科手术式」证明 S3/S7 只改了设计允许的片段。
 *
 * 方法：以 HEAD golden 为基准做定点比对，而不是整体相等/不等。
 * - expandSystem：`【任务】` 之前必须逐字节等于 HEAD；任务段必须保留全部旧约束并含新场景卡约束。
 * - chapterSystem：必须逐字节等于 HEAD（CHAPTER_TASK 不在 M1 变更范围）。
 * - chapterUser / chapterUserDefault：HEAD 里唯一的旧句「本章篇幅约 3000 字，可上下浮动 15%。」
 *   之前与之后的内容必须逐字节不变；只有该句所在区间允许替换成新结构块，且新块必须含设计 §8.4 语义。
 *
 * 这样既能接受 S3/S7 的有意变更，又能抓住「顺手改坏了别的字」的静默重生。
 */
import { describe, expect, it } from 'vitest';
import { buildM1Snapshot } from './fixtures/m1-prompts.fixture';
import golden from './fixtures/head-golden.json';

const snapshot = buildM1Snapshot();

/** HEAD 里被 S7 有意替换的那一句（两处调用点文案相同） */
const HEAD_CHAPTER_REQUIREMENT = '本章篇幅约 3000 字，可上下浮动 15%。';

/** 从 HEAD 文本里切出「旧句之前」与「旧句之后」 */
function splitAtHeadRequirement(headText: string): { prefix: string; suffix: string } {
  const at = headText.indexOf(HEAD_CHAPTER_REQUIREMENT);
  if (at < 0) throw new Error('HEAD golden 里找不到旧的字数要求句');
  return {
    prefix: headText.slice(0, at),
    suffix: headText.slice(at + HEAD_CHAPTER_REQUIREMENT.length),
  };
}

/** 当前字数结构块应有的语义（design §8.4） */
function expectChapterStructureBlock(block: string, words: number, sceneHint: string) {
  expect(block).toContain(`本章目标约 ${words} 字`);
  expect(block).toContain(`场景数供参考：${sceneHint}`);
  expect(block).toContain('以【本章要写的内容】的梗概节拍为准');
  expect(block).toContain('目标—阻碍—转折');
  expect(block).toContain('把一场写深');
  expect(block).toContain('自然收束');
  expect(block).toContain('按时空或视点转移换场');
  expect(block).toContain('结尾收在梗概承诺的钩子上');
  expect(block).toContain('以本节目标为准');
  // 旧文案必须完全消失，不能新旧并存
  expect(block).not.toContain('可上下浮动 15%');
}

describe('有意变更 canary · expandSystem（S3）', () => {
  const head = golden.expandSystem;
  const current = snapshot.expandSystem;
  const marker = '【任务】';

  it('任务段之前（角色 + 风格前缀 + 规范）逐字节等于 HEAD', () => {
    expect(current.slice(0, current.indexOf(marker))).toBe(head.slice(0, head.indexOf(marker)));
  });

  it('旧调用没有 core：任务段之前不出现核心设定块', () => {
    expect(current.slice(0, current.indexOf(marker))).not.toContain('【必须遵守的核心设定】');
  });

  it('任务段保留 HEAD 的全部旧约束（不删旧要求）', () => {
    const headTask = head.slice(head.indexOf(marker));
    const currentTask = current.slice(current.indexOf(marker));
    const oldRequirementLines = headTask
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.trim());
    expect(oldRequirementLines.length).toBeGreaterThanOrEqual(6);
    for (const line of oldRequirementLines) expect(currentTask).toContain(line);
  });

  it('任务段含设计 §4.1 新增的场景卡/设定落地/钩子约束', () => {
    const currentTask = current.slice(current.indexOf(marker));
    for (const phrase of [
      '场景卡',
      '软肋或世界规则的代价上做出一次选择或拒绝',
      '必须改变后文走向',
      '把设定复述进梗概不算「应用设定」',
      '不要为凑关联硬塞无关人物',
      '钩子与信息差',
      'targetWords 之和应接近父节点的目标字数',
      '不凑数拉长',
    ]) {
      expect(currentTask).toContain(phrase);
    }
  });
});

describe('有意变更 canary · chapter prompt（S7）', () => {
  it('chapterSystem 逐字节等于 HEAD（任务说明不在 M1 变更范围）', () => {
    expect(snapshot.chapterSystem).toBe(golden.chapterSystem);
  });

  it('chapterUser（targetWords=3000）：只替换字数要求区间，前后逐字节同 HEAD', () => {
    const { prefix, suffix } = splitAtHeadRequirement(golden.chapterUser);
    expect(snapshot.chapterUser.startsWith(prefix)).toBe(true);
    expect(snapshot.chapterUser.endsWith(suffix)).toBe(true);

    const block = snapshot.chapterUser.slice(
      prefix.length,
      snapshot.chapterUser.length - suffix.length,
    );
    expectChapterStructureBlock(block, 3000, '1–2 场');
  });

  it('chapterUserDefault（targetWords=null → 默认 3000）：同一规则', () => {
    const { prefix, suffix } = splitAtHeadRequirement(golden.chapterUserDefault);
    expect(snapshot.chapterUserDefault.startsWith(prefix)).toBe(true);
    expect(snapshot.chapterUserDefault.endsWith(suffix)).toBe(true);

    const block = snapshot.chapterUserDefault.slice(
      prefix.length,
      snapshot.chapterUserDefault.length - suffix.length,
    );
    expectChapterStructureBlock(block, 3000, '1–2 场');
  });
});
