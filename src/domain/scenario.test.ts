import { describe, expect, it } from 'vitest';
import {
  ScenarioSetupSchema,
  emptyDelta,
  type ArrivedBy,
  type Chapter,
  type OutlineNode,
  type Scenario,
  type ScenarioNode,
  type SideStory,
} from './schema';
import {
  ACTION_SIMILARITY_THRESHOLD,
  SCENARIO_MESSAGES,
  actionSimilarity,
  arrivalKey,
  checkpointSegment,
  checkpointsToFill,
  childrenOf,
  clampExpectedSteps,
  contextGap,
  forkNodeOf,
  isOnMainPath,
  lastSedimentedNodeOf,
  latestLeafOf,
  mainPath,
  normalizeAction,
  pathTo,
  sedimentCoverage,
  sedimentRange,
  validateFreeAction,
  validateScenarioSetup,
  walkedChoices,
  type ScenarioSetupDraft,
} from './scenario';

function node(
  id: string,
  parentId: string | null,
  depth: number,
  overrides: Partial<ScenarioNode> = {},
): ScenarioNode {
  return {
    id,
    novelId: 'n1',
    scenarioId: 'S',
    parentId,
    depth,
    arrivedBy:
      parentId === null ? { kind: 'start' } : { kind: 'option', optionId: `o-${id}`, text: id },
    plot: `${id} 的情节`,
    challenge: '',
    options: [],
    delta: emptyDelta(),
    notices: [],
    progress: { reachedMilestoneIds: [], note: '' },
    ending: null,
    pathSummary: null,
    deltaEditedAt: null,
    createdAt: depth,
    updatedAt: depth,
    ...overrides,
  };
}

/** 一条直线路径 depth 0 … length-1，id 为 `${prefix}${depth}` */
function chain(prefix: string, length: number, from: ScenarioNode | null = null): ScenarioNode[] {
  const out: ScenarioNode[] = [];
  let parent = from;
  for (let i = 0; i < length; i += 1) {
    const depth = parent ? parent.depth + 1 : 0;
    const current = node(`${prefix}${depth}`, parent?.id ?? null, depth);
    out.push(current);
    parent = current;
  }
  return out;
}

const baseScenario: Scenario = {
  id: 'S',
  novelId: 'n1',
  title: '雾中渡',
  setup: ScenarioSetupSchema.parse({
    cast: [{ id: 'cast1', entryId: 'oc' }],
    start: { situation: '醒来' },
    goals: [{ id: 'g1', kind: 'good', description: '找到船夫' }],
  }),
  mainNodeId: null,
  cursorNodeId: null,
  lastAdvancedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

describe('树与路径', () => {
  const root = node('r', null, 0, { options: [] });
  const a = node('a', 'r', 1, {
    arrivedBy: { kind: 'option', optionId: 'oa', text: '拔刀' },
    createdAt: 2,
  });
  const b = node('b', 'r', 1, { arrivedBy: { kind: 'free', text: '跳进江里。' }, createdAt: 1 });
  const a2 = node('a2', 'a', 2);
  const nodes = [root, a, b, a2];

  it('pathTo 根 → 节点；节点不存在或链条断开时为空', () => {
    expect(pathTo(nodes, 'a2').map((n) => n.id)).toEqual(['r', 'a', 'a2']);
    expect(pathTo(nodes, 'ghost')).toEqual([]);
    expect(pathTo([a, a2], 'a2')).toEqual([]);
    expect(pathTo(nodes, null)).toEqual([]);
  });

  it('mainPath / isOnMainPath 跟着 mainNodeId', () => {
    const scenario = { ...baseScenario, mainNodeId: 'a2' };
    expect(mainPath(scenario, nodes).map((n) => n.id)).toEqual(['r', 'a', 'a2']);
    expect(isOnMainPath(scenario, nodes, 'a')).toBe(true);
    expect(isOnMainPath(scenario, nodes, 'b')).toBe(false);
  });

  it('childrenOf 按创建时间排序', () => {
    expect(childrenOf(nodes, 'r').map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('walkedChoices：选项与自由输入都从子节点现算', () => {
    const walked = walkedChoices(root, childrenOf(nodes, 'r'));
    expect([...walked.options.keys()]).toEqual(['oa']);
    expect(walked.options.get('oa')?.id).toBe('a');
    expect(walked.free).toEqual([{ text: '跳进江里。', key: '跳进江里', child: b }]);
    expect(walked.wrapUp).toBeNull();
    const ending = node('end', 'a2', 3, { arrivedBy: { kind: 'wrap-up', goalId: null, note: '' } });
    expect(walkedChoices(a2, [ending]).wrapUp?.id).toBe('end');
  });

  it('latestLeafOf：深度优先于创建时间，同深同时间按 id', () => {
    const deepButOld = node('deep', 'a2', 3, { createdAt: 0 });
    const shallowNew = node('new', 'b', 2, { createdAt: 99 });
    expect(latestLeafOf([...nodes, deepButOld, shallowNew], 'r')?.id).toBe('deep');
    const x = node('x', 'r', 1, { createdAt: 5 });
    const y = node('y', 'r', 1, { createdAt: 5 });
    expect(latestLeafOf([root, x, y], 'r')?.id).toBe('y');
    expect(latestLeafOf(nodes, 'b')?.id).toBe('b');
  });

  it('forkNodeOf：与主线最深的公共节点', () => {
    const main = pathTo(nodes, 'a2');
    expect(forkNodeOf(pathTo(nodes, 'b'), main)).toBe('r');
    expect(forkNodeOf(main, main)).toBe('a2');
    expect(forkNodeOf([], main)).toBeNull();
  });

  it('arrivalKey：自由输入按规范化后的文本', () => {
    const free: ArrivedBy = { kind: 'free', text: ' 跳进 江里！ ' };
    expect(arrivalKey(free)).toBe('free:跳进江里');
    expect(arrivalKey({ kind: 'option', optionId: 'o1', text: '' })).toBe('option:o1');
    expect(arrivalKey({ kind: 'wrap-up', goalId: null, note: '' })).toBe('wrap-up');
    expect(arrivalKey({ kind: 'start' })).toBe('start');
  });
});

describe('主线跟随规则（T4，纯函数序列）', () => {
  /** 推进：新节点成为主线与落点（仓储 appendScenarioNode 的语义） */
  function advance(
    state: { scenario: Scenario; nodes: ScenarioNode[] },
    parentId: string,
    id: string,
  ) {
    const parent = state.nodes.find((n) => n.id === parentId)!;
    const child = node(id, parentId, parent.depth + 1, { createdAt: state.nodes.length });
    state.nodes.push(child);
    state.scenario = { ...state.scenario, mainNodeId: id, cursorNodeId: id };
  }
  /** 只查看：只改落点 */
  function view(state: { scenario: Scenario; nodes: ScenarioNode[] }, id: string) {
    state.scenario = { ...state.scenario, cursorNodeId: id };
  }
  const onMain = (state: { scenario: Scenario; nodes: ScenarioNode[] }) =>
    isOnMainPath(state.scenario, state.nodes, state.scenario.cursorNodeId!);

  it('a 推 3 步 → 回根走 b → 切回 a 只看 → 在 a 上推进', () => {
    const state = {
      scenario: { ...baseScenario, mainNodeId: 'r', cursorNodeId: 'r' },
      nodes: [node('r', null, 0)],
    };
    advance(state, 'r', 'a1');
    advance(state, 'a1', 'a2');
    advance(state, 'a2', 'a3');
    expect(state.scenario.mainNodeId).toBe('a3');
    expect(mainPath(state.scenario, state.nodes)).toHaveLength(4);
    expect(onMain(state)).toBe(true);

    view(state, 'r');
    expect(state.scenario.mainNodeId).toBe('a3');
    advance(state, 'r', 'b1');
    expect(state.scenario.mainNodeId).toBe('b1');
    expect(onMain(state)).toBe(true);

    view(state, 'a3');
    expect(state.scenario.mainNodeId).toBe('b1');
    expect(onMain(state)).toBe(false);

    advance(state, 'a3', 'a4');
    expect(state.scenario.mainNodeId).toBe('a4');
    expect(mainPath(state.scenario, state.nodes).map((n) => n.id)).toEqual([
      'r',
      'a1',
      'a2',
      'a3',
      'a4',
    ]);
    expect(onMain(state)).toBe(true);
    view(state, 'b1');
    expect(onMain(state)).toBe(false);
  });
});

describe('行动的等价判定', () => {
  it('normalizeAction：全角 / 半角、空白、末尾标点', () => {
    expect(normalizeAction('拔刀！')).toBe('拔刀');
    expect(normalizeAction('  拔 刀 ...')).toBe('拔刀');
    expect(normalizeAction('ＡＢＣ　走？！')).toBe('ABC走');
    expect(normalizeAction('等等～')).toBe('等等');
    expect(normalizeAction('问：为什么？好')).toBe('问:为什么?好');
  });

  it('actionSimilarity：阈值两侧各一例', () => {
    const near = actionSimilarity(
      '我拔刀砍向黑衣人的左肩然后后退',
      '我拔刀砍向黑衣人的右肩然后后退',
    );
    expect(near).toBeGreaterThanOrEqual(ACTION_SIMILARITY_THRESHOLD);
    const far = actionSimilarity('我拔刀', '我拔刀砍他');
    expect(far).toBeLessThan(ACTION_SIMILARITY_THRESHOLD);
    expect(actionSimilarity('拔刀。', '拔刀')).toBe(1);
    expect(actionSimilarity('', '')).toBe(0);
  });
});

describe('前情检查点', () => {
  it('checkpointsToFill 四例', () => {
    const path = chain('d', 12); // depth 0–11
    const withSummary = (depths: number[]) =>
      path.map((n) =>
        depths.includes(n.depth)
          ? { ...n, pathSummary: { text: `到第 ${n.depth + 1} 步`, openThreads: [] } }
          : n,
      );
    // 第 5 步有摘要（第 10 步也有）→ 无需补
    expect(checkpointsToFill(withSummary([4, 9]), 11)).toEqual([]);
    // 第 5、10 步都缺 → 依次 depth 4、9
    expect(checkpointsToFill(path, 11).map((n) => n.depth)).toEqual([4, 9]);
    // 第 5 步有、第 10 步缺 → depth 9，其输入段为第 6–10 步
    const partial = withSummary([4]);
    const fill = checkpointsToFill(partial, 11);
    expect(fill.map((n) => n.depth)).toEqual([9]);
    const segment = checkpointSegment(partial, fill[0]!.id);
    expect(segment.previous).toEqual({ text: '到第 5 步', openThreads: [] });
    expect(segment.steps.map((n) => n.depth + 1)).toEqual([6, 7, 8, 9, 10]);
    // depth > parentDepth 的检查点不返回
    expect(checkpointsToFill(path, 8).map((n) => n.depth)).toEqual([4]);
  });

  it('checkpointSegment 没有已有摘要的祖先时从开局写起', () => {
    const path = chain('d', 10);
    const segment = checkpointSegment(path, 'd4');
    expect(segment.previous).toBeNull();
    expect(segment.steps.map((n) => n.depth)).toEqual([0, 1, 2, 3, 4]);
  });

  it('contextGap：12 步、第 5 步缺摘要时 gap = 9；有摘要时 gap = 4', () => {
    const path = chain('d', 12);
    const missing = contextGap(path);
    expect(missing.recent.map((n) => n.depth)).toEqual([9, 10, 11]);
    expect(missing.checkpoint).toBeNull();
    expect(missing.gap).toHaveLength(9);
    const filled = contextGap(
      path.map((n) => (n.depth === 4 ? { ...n, pathSummary: { text: 's', openThreads: [] } } : n)),
    );
    expect(filled.checkpoint?.depth).toBe(4);
    expect(filled.gap.map((n) => n.depth)).toEqual([5, 6, 7, 8]);
    expect(contextGap(path.slice(0, 2))).toEqual({
      recent: path.slice(0, 2),
      checkpoint: null,
      gap: [],
    });
  });
});

// ---------------------------------------------------------------- 沉淀

function outlineNode(id: string, nodeIds: string[] | null, scenarioId = 'S'): OutlineNode {
  return {
    id,
    novelId: 'n1',
    parentId: null,
    order: 0,
    title: id,
    synopsis: '',
    targetWords: null,
    status: 'planned',
    linkedEntryIds: [],
    scenarioSource: nodeIds ? { scenarioId, nodeIds } : null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function side(id: string, forkNodeId: string, createdAt = 0): SideStory {
  return {
    id,
    novelId: 'n1',
    title: id,
    synopsis: '',
    rollingSummary: '',
    order: 0,
    scenarioSource: { scenarioId: 'S', forkNodeId },
    createdAt,
    updatedAt: 0,
  };
}

function sideChapter(
  id: string,
  sideStoryId: string,
  index: number,
  nodeIds: string[] | null,
): Chapter {
  return {
    id,
    novelId: 'n1',
    outlineNodeId: null,
    index,
    title: id,
    content: '',
    sourceContent: '',
    sourceLanguage: '',
    wordCount: 0,
    status: 'draft',
    source: 'manual',
    sideStoryId,
    scenarioSource: nodeIds ? { scenarioId: 'S', nodeIds, brief: '' } : null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('sedimentCoverage / sedimentRange', () => {
  const main = chain('m', 20); // 第 1–20 步
  const ids = (from: number, to: number) => main.slice(from - 1, to).map((n) => n.id);
  const scenario = { ...baseScenario, mainNodeId: 'm19' };

  it('主线续沉淀：没有大纲时从第 1 步到当前', () => {
    const range = sedimentRange({
      scenario,
      nodes: main,
      currentNodeId: 'm19',
      outline: [],
      sideStories: [],
      chapters: [],
    });
    expect(range).toEqual({
      mode: 'main',
      span: { from: 1, to: 20, nodeIds: ids(1, 20) },
      fillsHole: false,
    });
  });

  it('有洞：1–4、9–12 已覆盖 → [5, 8]；补上后 → [13, 20]；卷节点与过期节点不算覆盖', () => {
    const outline = [
      outlineNode('vol', null),
      outlineNode('c1', ids(1, 4)),
      outlineNode('c3', ids(9, 12)),
      outlineNode('other', ids(5, 8), 'T'),
    ];
    const first = sedimentRange({
      scenario,
      nodes: main,
      currentNodeId: 'm19',
      outline,
      sideStories: [],
      chapters: [],
    });
    expect(first).toEqual({
      mode: 'main',
      span: { from: 5, to: 8, nodeIds: ids(5, 8) },
      fillsHole: true,
    });
    const second = sedimentRange({
      scenario,
      nodes: main,
      currentNodeId: 'm19',
      outline: [...outline, outlineNode('c2', ids(5, 8))],
      sideStories: [],
      chapters: [],
    });
    expect(second?.mode === 'main' && second.span).toEqual({
      from: 13,
      to: 20,
      nodeIds: ids(13, 20),
    });

    // 过期：nodeIds 有一步不在当前主线上
    const branch = node('x5', 'm4', 5);
    const stale = outlineNode('stale', ['m0', 'x5']);
    const coverage = sedimentCoverage({
      scenario,
      nodes: [...main, branch],
      outline: [stale, outlineNode('c1', ids(1, 4))],
    });
    expect(coverage.stale.map((n) => n.id)).toEqual(['stale']);
    expect([...coverage.covered]).toEqual(ids(1, 4));
  });

  it('全部沉淀后范围为空', () => {
    const range = sedimentRange({
      scenario,
      nodes: main,
      currentNodeId: 'm19',
      outline: [outlineNode('all', ids(1, 20))],
      sideStories: [],
      chapters: [],
    });
    expect(range).toEqual({ mode: 'main', span: null, fillsHole: false });
  });

  describe('外传', () => {
    // 主线 m0–m19；分支从 m4 分出：b5 → b6 → … → b9
    const branch = chain('b', 5, main[4]!);
    const nodes = [...main, ...branch];

    it('外传从分叉点之后起；没有可追加的外传', () => {
      const range = sedimentRange({
        scenario,
        nodes,
        currentNodeId: 'b9',
        outline: [],
        sideStories: [],
        chapters: [],
      });
      expect(range).toEqual({
        mode: 'side',
        forkNodeId: 'm4',
        span: { from: 6, to: 10, nodeIds: ['b5', 'b6', 'b7', 'b8', 'b9'] },
        append: null,
      });
    });

    it('当前节点在外传最后一步的子树里 → 追加，范围从最后一步之后起；就是最后一步时不追加', () => {
      const story = side('X', 'm4');
      const chapters = [sideChapter('x1', 'X', 1, ['b5', 'b6'])];
      const range = sedimentRange({
        scenario,
        nodes,
        currentNodeId: 'b9',
        outline: [],
        sideStories: [story],
        chapters,
      });
      expect(range?.mode === 'side' && range.append).toEqual({
        sideStoryId: 'X',
        span: { from: 8, to: 10, nodeIds: ['b7', 'b8', 'b9'] },
      });
      const atLast = sedimentRange({
        scenario,
        nodes,
        currentNodeId: 'b6',
        outline: [],
        sideStories: [story],
        chapters,
      });
      expect(atLast?.mode === 'side' && atLast.append).toBeNull();
    });

    it('当前节点不在外传最后一步的子树里（从中途另开分支）→ 只能另建', () => {
      const fork = node('c7', 'b6', 7);
      const story = side('X', 'm4');
      const chapters = [sideChapter('x1', 'X', 1, ['b5', 'b6', 'b7', 'b8'])];
      const range = sedimentRange({
        scenario,
        nodes: [...nodes, fork],
        currentNodeId: 'c7',
        outline: [],
        sideStories: [story],
        chapters,
      });
      expect(range?.mode === 'side' && range.append).toBeNull();
    });

    it('主线换了、分叉点重新算出来不再是 F，仍按最后一步追加；两部都满足时取最后一步更深的', () => {
      // 主线换到分支 b 上的另一条：b9 之外从 b6 分出 n7 作为新主线 → 分叉点变成 b6
      const newMain = chain('n', 3, branch[1]!); // n7, n8, n9
      const switched = { ...baseScenario, mainNodeId: 'n9' };
      const all = [...nodes, ...newMain];
      const X = side('X', 'm4', 1);
      const Y = side('Y', 'm4', 2);
      const chapters = [
        sideChapter('x1', 'X', 1, ['b5', 'b6', 'b7']),
        sideChapter('y1', 'Y', 1, ['b5']),
      ];
      const range = sedimentRange({
        scenario: switched,
        nodes: all,
        currentNodeId: 'b9',
        outline: [],
        sideStories: [Y, X],
        chapters,
      });
      expect(range?.mode).toBe('side');
      if (range?.mode !== 'side') return;
      expect(range.forkNodeId).toBe('b6');
      expect(range.append).toEqual({
        sideStoryId: 'X',
        span: { from: 9, to: 10, nodeIds: ['b8', 'b9'] },
      });
    });

    it('外传末尾一章手写（scenarioSource = null）仍能追加：L 取最后一个带溯源的章节（addendum 3）', () => {
      const story = side('X', 'm4');
      const chapters = [sideChapter('x1', 'X', 1, ['b5', 'b6']), sideChapter('x2', 'X', 2, null)];
      expect(lastSedimentedNodeOf('X', 'S', chapters)).toBe('b6');
      const range = sedimentRange({
        scenario,
        nodes,
        currentNodeId: 'b9',
        outline: [],
        sideStories: [story],
        chapters,
      });
      expect(range?.mode === 'side' && range.append?.span.from).toBe(8);
      // 一章带溯源的都没有：不参与追加判定
      expect(lastSedimentedNodeOf('X', 'S', [sideChapter('x2', 'X', 2, null)])).toBeNull();
      const none = sedimentRange({
        scenario,
        nodes,
        currentNodeId: 'b9',
        outline: [],
        sideStories: [story],
        chapters: [sideChapter('x2', 'X', 2, null)],
      });
      expect(none?.mode === 'side' && none.append).toBeNull();
    });
  });
});

// ---------------------------------------------------------------- 预检

describe('开局与自由输入的预检', () => {
  const valid: ScenarioSetupDraft = {
    title: '雾中渡',
    protagonist: { kind: 'new', title: '沈砚', fields: [{ label: '身份', value: '船夫' }] },
    start: { time: '', place: '', situation: '在渡口醒来' },
    goals: [{ kind: 'good', description: '找到船夫' }],
    milestones: [],
    tone: '',
  };

  it('合法时返回 undefined', () => {
    expect(validateScenarioSetup(valid)).toBeUndefined();
    expect(
      validateScenarioSetup({ ...valid, protagonist: { kind: 'existing', entryId: 'e1' } }),
    ).toBeUndefined();
  });

  it('返回第一条中文错误', () => {
    expect(validateScenarioSetup({ ...valid, title: '  ' })).toBe('推演名称不能为空');
    expect(validateScenarioSetup({ ...valid, title: '名'.repeat(41) })).toBe(
      '推演名称不能超过 40 字',
    );
    expect(validateScenarioSetup({ ...valid, protagonist: null })).toBe('请选择或新建一位主角');
    expect(
      validateScenarioSetup({ ...valid, protagonist: { kind: 'new', title: '', fields: [] } }),
    ).toBe('主角名称不能为空');
    expect(
      validateScenarioSetup({
        ...valid,
        protagonist: {
          kind: 'new',
          title: '沈砚',
          fields: [{ label: '性格', value: '字'.repeat(2001) }],
        },
      }),
    ).toBe('主角的「性格」不能超过 2000 字');
    expect(validateScenarioSetup({ ...valid, start: { ...valid.start, situation: '' } })).toBe(
      '请写出主角的处境',
    );
    expect(validateScenarioSetup({ ...valid, goals: [] })).toBe('至少设定一个结局目标');
    expect(
      validateScenarioSetup({ ...valid, goals: Array.from({ length: 7 }, () => valid.goals[0]!) }),
    ).toBe('结局目标最多 6 个');
    expect(validateScenarioSetup({ ...valid, milestones: [{ description: ' ' }] })).toBe(
      '里程碑不能为空',
    );
    expect(validateScenarioSetup({ ...valid, tone: '调'.repeat(201) })).toBe('基调不能超过 200 字');
  });

  it('schema 与预检用同一份文案', () => {
    const result = ScenarioSetupSchema.safeParse({
      cast: [{ id: 'c', entryId: 'e' }],
      start: { situation: ' ' },
      goals: [{ id: 'g', kind: 'good', description: 'x' }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(SCENARIO_MESSAGES.situationRequired);
  });

  it('预计步数钳到 5–200', () => {
    expect(clampExpectedSteps(1)).toBe(5);
    expect(clampExpectedSteps(500)).toBe(200);
    expect(clampExpectedSteps(30.4)).toBe(30);
    expect(clampExpectedSteps(Number.NaN)).toBe(30);
  });

  it('validateFreeAction：必填、≤ 200 字', () => {
    expect(validateFreeAction('  ')).toBe('请写下主角要做的事');
    expect(validateFreeAction('字'.repeat(201))).toBe('一次只写一个行动，不能超过 200 字');
    expect(validateFreeAction('拔刀')).toBeUndefined();
  });
});
