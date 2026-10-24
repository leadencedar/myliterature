import { describe, expect, it } from 'vitest';
import { sedimentRange, sideSedimentOverlaps } from '@/domain/scenario';
import {
  StyleProfileSchema,
  emptyDelta,
  type Chapter,
  type KnowledgeEntry,
  type Novel,
  type Scenario,
  type ScenarioNode,
  type SideStory,
  type WritingNorm,
} from '@/domain/schema';
import {
  ScenarioOutlinePayloadSchema,
  buildPathOutlinePrompt,
  buildPathOutlineSchema,
  forkPreludeText,
  parseScenarioOutline,
  serializeScenarioOutline,
  toScenarioOutlinePlan,
  type PathOutline,
} from './pathOutline';

// ---------------------------------------------------------------- 夹具

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
      parentId === null
        ? { kind: 'start' }
        : { kind: 'option', optionId: `o-${id}`, text: `选${id}` },
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

/** depth 0 … length-1 的直线，id 为 `${prefix}${depth}` */
function chain(prefix: string, length: number): ScenarioNode[] {
  const out: ScenarioNode[] = [];
  for (let depth = 0; depth < length; depth += 1) {
    out.push(node(`${prefix}${depth}`, depth === 0 ? null : `${prefix}${depth - 1}`, depth));
  }
  return out;
}

function chapter(
  from: number,
  to: number,
  overrides: Partial<PathOutline['volumes'][number]['chapters'][number]> = {},
) {
  return {
    title: `第${from}章`,
    synopsis: `第 ${from} 到 ${to} 步的事。`,
    keyEvents: ['发现空船', '捡到钥匙'],
    appearing: ['沈砚', '裴照'],
    fromStep: from,
    toStep: to,
    targetWords: 3000,
    ...overrides,
  };
}

function outlineOf(...chapters: ReturnType<typeof chapter>[]): PathOutline {
  return {
    sideTitle: '',
    sideSynopsis: '',
    volumes: [{ title: '第一卷 渡口', synopsis: '渡口的事。', targetWords: null, chapters }],
  };
}

function entry(id: string, title: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id,
    novelId: 'n1',
    categoryId: 'c-char',
    title,
    aliases: [],
    summary: '',
    fields: {},
    pinned: false,
    sourceChapterIds: [],
    version: 1,
    deletedAt: null,
    scope: { kind: 'universal' },
    fieldLocks: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as KnowledgeEntry;
}

const entries: KnowledgeEntry[] = [
  entry('e-pei', '裴照', { aliases: ['裴七'] }),
  // 限定条目与已删除条目即便同名也不关联：限定条目不在写作链路里，关联了也注入不进去
  entry('e-shen', '沈砚', {
    scope: { kind: 'limited', targets: [{ scenarioId: 'S', fromNodeId: null, revealHint: '' }] },
  }),
  entry('e-gone', '阿七', { deletedAt: 5 }),
];

// ---------------------------------------------------------------- schema

describe('buildPathOutlineSchema', () => {
  it('各章首尾相接、恰好覆盖时通过', () => {
    const schema = buildPathOutlineSchema(1, 8);
    expect(schema.safeParse(outlineOf(chapter(1, 4), chapter(5, 8))).success).toBe(true);
    // 跨卷也算首尾相接
    const twoVolumes: PathOutline = {
      ...outlineOf(chapter(1, 4)),
      volumes: [
        { title: '第一卷', synopsis: '', targetWords: null, chapters: [chapter(1, 4)] },
        { title: '第二卷', synopsis: '', targetWords: null, chapters: [chapter(5, 8)] },
      ],
    };
    expect(schema.safeParse(twoVolumes).success).toBe(true);
  });

  it('有洞、重叠、没覆盖到最后一步、越界都被拒，文案带这次的范围', () => {
    const schema = buildPathOutlineSchema(1, 8);
    const cases = [
      outlineOf(chapter(1, 3), chapter(5, 8)),
      outlineOf(chapter(1, 4), chapter(4, 8)),
      outlineOf(chapter(1, 4), chapter(5, 7)),
      outlineOf(chapter(1, 4), chapter(5, 9)),
      outlineOf(chapter(1, 4), chapter(6, 5)),
    ];
    for (const value of cases) {
      const result = schema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.message).toContain('第 1–8 步');
    }
  });

  it('from = 13 时从第 1 步起的分组被拒', () => {
    const schema = buildPathOutlineSchema(13, 24);
    const result = schema.safeParse(outlineOf(chapter(1, 12), chapter(13, 24)));
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toContain('第 13–24 步');
    expect(schema.safeParse(outlineOf(chapter(13, 18), chapter(19, 24))).success).toBe(true);
  });

  it('外传名称超过 40 字被拒', () => {
    const schema = buildPathOutlineSchema(1, 4);
    expect(
      schema.safeParse({ ...outlineOf(chapter(1, 4)), sideTitle: '名'.repeat(41) }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- 序列化 / 解析

describe('serializeScenarioOutline ↔ parseScenarioOutline', () => {
  it('主线格式与 D7.2 一致', () => {
    const text = serializeScenarioOutline(
      outlineOf(chapter(1, 4, { title: '第1章 雾里的船' })),
      'main',
    );
    expect(text).toBe(
      [
        '# 第一卷 渡口',
        '渡口的事。',
        '',
        '## 第1章 雾里的船（约 3000 字）',
        '第 1 到 4 步的事。',
        '关键事件：发现空船；捡到钥匙',
        '出场：沈砚、裴照',
        '对应步骤：1–4',
      ].join('\n'),
    );
  });

  it('续沉淀第 13–24 步往返：nodeIds 是路径上 depth 12–23 的节点', () => {
    const path = chain('m', 30);
    const span = path.slice(12, 24).map((item) => item.id);
    const text = serializeScenarioOutline(
      outlineOf(chapter(13, 16), chapter(17, 20), chapter(21, 24)),
      'main',
    );
    const parsed = parseScenarioOutline(text, { from: 13, to: 24, pathNodeIds: span, entries });
    const chapters = parsed.groups.flatMap((group) => group.chapters);
    expect(chapters.map((item) => [item.fromStep, item.toStep])).toEqual([
      [13, 16],
      [17, 20],
      [21, 24],
    ]);
    expect(chapters[0]!.nodeIds).toEqual(['m12', 'm13', 'm14', 'm15']);
    expect(chapters.flatMap((item) => item.nodeIds)).toEqual(span);
    expect(parsed.groups[0]!.volume).toEqual({
      title: '第一卷 渡口',
      synopsis: '渡口的事。',
      targetWords: null,
    });
    expect(chapters[0]!.targetWords).toBe(3000);
  });

  it('只剥「对应步骤」一行：梗概仍含关键事件与出场', () => {
    const text = serializeScenarioOutline(outlineOf(chapter(1, 4)), 'main');
    const parsed = parseScenarioOutline(text, {
      from: 1,
      to: 4,
      pathNodeIds: ['a', 'b', 'c', 'd'],
      entries,
    });
    const synopsis = parsed.groups[0]!.chapters[0]!.synopsis;
    expect(synopsis).toContain('关键事件：发现空船；捡到钥匙');
    expect(synopsis).toContain('出场：沈砚、裴照');
    expect(synopsis).not.toContain('对应步骤');
  });

  it('「出场」只解析出通用、未删除的条目（名称或别名）', () => {
    const text = serializeScenarioOutline(
      outlineOf(chapter(1, 4, { appearing: ['沈砚', '裴七', '阿七', '无名氏'] })),
      'main',
    );
    const parsed = parseScenarioOutline(text, {
      from: 1,
      to: 4,
      pathNodeIds: ['a', 'b', 'c', 'd'],
      entries,
    });
    expect(parsed.groups[0]!.chapters[0]!.linkedEntryIds).toEqual(['e-pei']);
  });

  it('「对应步骤」越界抛错，文案含这次的范围', () => {
    const text = serializeScenarioOutline(outlineOf(chapter(13, 18), chapter(19, 26)), 'main');
    const span = chain('m', 30)
      .slice(12, 24)
      .map((item) => item.id);
    expect(() =>
      parseScenarioOutline(text, { from: 13, to: 24, pathNodeIds: span, entries }),
    ).toThrow('第 2 章的『对应步骤』超出这次沉淀的范围（第 13–24 步）');
  });

  it('缺「对应步骤」、写法不对、不首尾相接都抛错', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(() =>
      parseScenarioOutline('# 卷\n## 第1章\n梗概', { from: 1, to: 4, pathNodeIds: ids, entries }),
    ).toThrow('第 1 章缺少『对应步骤』一行');
    expect(() =>
      parseScenarioOutline('# 卷\n## 第1章\n对应步骤：一到四', {
        from: 1,
        to: 4,
        pathNodeIds: ids,
        entries,
      }),
    ).toThrow('写法不对');
    expect(() =>
      parseScenarioOutline('# 卷\n## 第1章\n对应步骤：1-2\n## 第2章\n对应步骤：2-4', {
        from: 1,
        to: 4,
        pathNodeIds: ids,
        entries,
      }),
    ).toThrow('第 2 章的『对应步骤』要从第 3 步接着写');
    expect(() => parseScenarioOutline('', { from: 1, to: 4, pathNodeIds: ids, entries })).toThrow(
      '大纲内容为空',
    );
  });

  it('外传格式只有章；顶层的章解析成 volume 为 null 的组', () => {
    const text = serializeScenarioOutline(
      { ...outlineOf(chapter(3, 4), chapter(5, 6)), sideTitle: '雾中', sideSynopsis: '另一条线' },
      'side',
    );
    expect(text).not.toContain('# 第一卷');
    expect(text.startsWith('## 第3章')).toBe(true);
    const parsed = parseScenarioOutline(text, {
      from: 3,
      to: 6,
      pathNodeIds: ['c', 'd', 'e', 'f'],
      entries,
    });
    expect(parsed.groups.map((group) => group.volume)).toEqual([null, null]);
    expect(parsed.groups.flatMap((group) => group.chapters.map((item) => item.nodeIds))).toEqual([
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });
});

describe('toScenarioOutlinePlan', () => {
  const base = {
    scenarioId: 'S',
    range: { from: 1, to: 4 },
    nodeIds: ['a', 'b', 'c', 'd'],
    sideTitle: '',
    sideSynopsis: '',
  };

  it('主线：卷 / 章两层，章带 nodeIds 与 linkedEntryIds', () => {
    const outlineText = serializeScenarioOutline(outlineOf(chapter(1, 2), chapter(3, 4)), 'main');
    const payload = ScenarioOutlinePayloadSchema.parse({
      ...base,
      mode: 'main',
      forkNodeId: null,
      appendToSideStoryId: null,
      outlineText,
    });
    const plan = toScenarioOutlinePlan(
      payload,
      parseScenarioOutline(outlineText, {
        ...payload.range,
        pathNodeIds: payload.nodeIds,
        entries,
      }),
    );
    expect(plan).toMatchObject({
      mode: 'main',
      volumes: [
        {
          title: '第一卷 渡口',
          chapters: [{ nodeIds: ['a', 'b'], linkedEntryIds: ['e-pei'] }, { nodeIds: ['c', 'd'] }],
        },
      ],
    });
  });

  it('主线大纲里的章不在卷下面时拒绝', () => {
    const outlineText = '## 第1章\n对应步骤：1–4';
    const payload = ScenarioOutlinePayloadSchema.parse({
      ...base,
      mode: 'main',
      forkNodeId: null,
      appendToSideStoryId: null,
      outlineText,
    });
    expect(() =>
      toScenarioOutlinePlan(
        payload,
        parseScenarioOutline(outlineText, {
          ...payload.range,
          pathNodeIds: payload.nodeIds,
          entries,
        }),
      ),
    ).toThrow('主线大纲的章要放在卷下面');
  });

  it('外传：章的细纲 = 梗概（含关键事件与出场），新建要有名称与分叉点', () => {
    const outlineText = serializeScenarioOutline(outlineOf(chapter(1, 4)), 'side');
    const parse = (payload: ReturnType<typeof ScenarioOutlinePayloadSchema.parse>) =>
      toScenarioOutlinePlan(
        payload,
        parseScenarioOutline(outlineText, {
          ...payload.range,
          pathNodeIds: payload.nodeIds,
          entries,
        }),
      );
    const plan = parse(
      ScenarioOutlinePayloadSchema.parse({
        ...base,
        mode: 'side',
        forkNodeId: 'f',
        appendToSideStoryId: null,
        sideTitle: '雾中',
        sideSynopsis: '另一条线',
        outlineText,
      }),
    );
    expect(plan).toMatchObject({
      mode: 'side',
      title: '雾中',
      synopsis: '另一条线',
      forkNodeId: 'f',
      appendToSideStoryId: null,
    });
    if (plan.mode !== 'side') throw new Error('应是外传');
    expect(plan.chapters[0]!.brief).toContain('出场：沈砚、裴照');
    expect(() =>
      parse(
        ScenarioOutlinePayloadSchema.parse({
          ...base,
          mode: 'side',
          forkNodeId: 'f',
          appendToSideStoryId: null,
          outlineText,
        }),
      ),
    ).toThrow('外传名称不能为空');
  });
});

// ---------------------------------------------------------------- 提示词与前情

describe('buildPathOutlinePrompt / forkPreludeText', () => {
  const novel = {
    id: 'n1',
    title: '归墟纪',
    genre: '仙侠',
    oneLiner: '',
    rollingSummary: '',
  } as Novel;
  const style = StyleProfileSchema.parse({ id: 's1', novelId: 'n1', createdAt: 0, updatedAt: 0 });
  const norm = (scopes: WritingNorm['scopes']) =>
    ({
      id: `w-${scopes.join()}`,
      novelId: 'n1',
      title: `规范${scopes.join()}`,
      content: '只用短句。',
      enabled: true,
      scopes,
      order: 0,
      createdAt: 0,
      updatedAt: 0,
    }) as WritingNorm;

  it('步骤用绝对步数标注；规划作用范围的规范进 system，其余不进', () => {
    const path = chain('m', 16);
    const { system, user } = buildPathOutlinePrompt({
      novel,
      style,
      norms: [norm(['planning']), norm(['writing'])],
      scenario: { title: '雾中渡' },
      castName: '沈砚',
      mode: 'main',
      appendTo: null,
      steps: path.slice(12, 16),
      existingVolumeTitles: ['第一卷 渡口'],
      prelude: '',
    });
    expect(system).toContain('规范planning');
    expect(system).not.toContain('规范writing');
    expect(system).toContain('归墟纪');
    expect(user).toContain('范围：第 13–16 步，共 4 步。');
    expect(user).toContain('第 13 步 · 主角选择：选m12\nm12 的情节');
    expect(user).toContain('- 第一卷 渡口');
    expect(user).toContain('主角：沈砚');
  });

  it('外传前情 = 最近的检查点摘要 + 之后到分叉点的原文', () => {
    const path = chain('m', 10).map((item) =>
      item.depth === 4 ? { ...item, pathSummary: { text: '沈砚上了船。', openThreads: [] } } : item,
    );
    const prelude = forkPreludeText(path, 'm6');
    expect(prelude).toContain('（到第 5 步为止的前情）沈砚上了船。');
    expect(prelude).toContain('m5 的情节');
    expect(prelude).toContain('m6 的情节');
    expect(prelude).not.toContain('m4 的情节');
    expect(prelude).not.toContain('m7 的情节');
    // 没有摘要时从开局写起
    expect(forkPreludeText(chain('m', 3), 'm1')).toContain('m0 的情节');
  });
});

// ---------------------------------------------------------------- 外传追加的「最后一章」（design-addendum 第 3 条）

describe('sedimentRange：外传末尾是手写章节', () => {
  it('L 取最后一个带溯源的章节，当前节点在 L 的子树里时仍能追加', () => {
    const main = chain('m', 4);
    const side = [
      node('b1', 'm0', 1),
      node('b2', 'b1', 2),
      node('b3', 'b2', 3),
      node('b4', 'b3', 4),
    ];
    const scenario = { id: 'S', mainNodeId: 'm3' } as Scenario;
    const story = {
      id: 'X',
      scenarioSource: { scenarioId: 'S', forkNodeId: 'm0' },
      createdAt: 0,
    } as SideStory;
    const chapters = [
      {
        id: 'x1',
        sideStoryId: 'X',
        index: 1,
        scenarioSource: { scenarioId: 'S', nodeIds: ['b1', 'b2'], brief: '' },
      },
      { id: 'x2', sideStoryId: 'X', index: 2, scenarioSource: null },
    ] as Chapter[];
    const range = sedimentRange({
      scenario,
      nodes: [...main, ...side],
      currentNodeId: 'b4',
      outline: [],
      sideStories: [story],
      chapters,
    });
    expect(range).toMatchObject({
      mode: 'side',
      forkNodeId: 'm0',
      append: { sideStoryId: 'X', span: { from: 4, to: 5, nodeIds: ['b3', 'b4'] } },
    });
  });
});

// ---------------------------------------------------------------- 已沉淀为外传后又成了主线（设计 §11）

describe('sideSedimentOverlaps', () => {
  it('主线范围里已沉淀进本推演外传的步骤给出首尾步数；别的推演与清空的溯源不算', () => {
    const main = chain('m', 6);
    const scenario = { id: 'S', mainNodeId: 'm5' } as Scenario;
    const stories = [
      {
        id: 'X',
        title: '雾中',
        scenarioSource: { scenarioId: 'S', forkNodeId: 'm1' },
        createdAt: 0,
      },
      { id: 'Y', title: '别处', scenarioSource: null, createdAt: 0 },
    ] as SideStory[];
    const chapters = [
      {
        id: 'x1',
        sideStoryId: 'X',
        index: 1,
        scenarioSource: { scenarioId: 'S', nodeIds: ['m2', 'm3'], brief: '' },
      },
      { id: 'x2', sideStoryId: 'X', index: 2, scenarioSource: null },
      {
        id: 'y1',
        sideStoryId: 'Y',
        index: 1,
        scenarioSource: { scenarioId: 'T', nodeIds: ['m4'], brief: '' },
      },
    ] as Chapter[];
    const range = sedimentRange({
      scenario,
      nodes: main,
      currentNodeId: 'm5',
      outline: [],
      sideStories: stories,
      chapters,
    });
    expect(range).toMatchObject({ mode: 'main', span: { from: 1, to: 6 } });
    const overlaps = sideSedimentOverlaps({
      scenarioId: 'S',
      span: range!.span!,
      nodes: main,
      sideStories: stories,
      chapters,
    });
    expect(overlaps.map(({ sideStory, from, to }) => [sideStory.id, from, to])).toEqual([
      ['X', 3, 4],
    ]);
    // 范围不含那些步骤时没有提示
    expect(
      sideSedimentOverlaps({
        scenarioId: 'S',
        span: { from: 5, to: 6, nodeIds: ['m4', 'm5'] },
        nodes: main,
        sideStories: stories,
        chapters,
      }),
    ).toEqual([]);
  });
});
