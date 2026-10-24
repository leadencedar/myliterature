import { describe, expect, it } from 'vitest';
import {
  dedupeGlossary,
  findGlossaryDrift,
  mergeGlossary,
  normalizeGlossarySource,
  relevantGlossary,
  removeGlossaryEntry,
  setGlossaryEntry,
  type GlossaryCheckChapter,
  type GlossaryEntry,
} from './glossary';

const ASHFORD: GlossaryEntry = { source: 'Ashford', target: '阿什福德' };
const GREYMOOR: GlossaryEntry = { source: 'Greymoor', target: '灰沼' };

describe('原文名归一化', () => {
  it('忽略大小写与首尾空白', () => {
    // 英文专名在稿子里的大小写写法常常不统一
    expect(normalizeGlossarySource('  ASHFORD ')).toBe('ashford');
  });
});

describe('去重', () => {
  it('同一个原文名只留第一条', () => {
    expect(dedupeGlossary([ASHFORD, { source: 'ashford', target: '艾许佛' }])).toEqual([ASHFORD]);
  });

  it('顺手清掉首尾空白', () => {
    expect(dedupeGlossary([{ source: ' Ashford ', target: ' 阿什福德 ' }])).toEqual([ASHFORD]);
  });

  it('缺原文名或缺译名的条目丢掉', () => {
    expect(
      dedupeGlossary([
        { source: '', target: '阿什福德' },
        { source: 'Greymoor', target: '   ' },
        ASHFORD,
      ]),
    ).toEqual([ASHFORD]);
  });
});

describe('合并模型新产出：先到先得', () => {
  it('已经定下的译名不被后来的输出推翻', () => {
    // 同一个人在第五章换个名字，读者会以为是两个人
    expect(mergeGlossary([ASHFORD], [{ source: 'Ashford', target: '艾许佛' }])).toEqual([ASHFORD]);
  });

  it('大小写不同也视为同一个名字', () => {
    expect(mergeGlossary([ASHFORD], [{ source: 'ASHFORD', target: '艾许佛' }])).toEqual([ASHFORD]);
  });

  it('新名字追加在后面', () => {
    expect(mergeGlossary([ASHFORD], [GREYMOOR])).toEqual([ASHFORD, GREYMOOR]);
  });

  it('空表与空输入都安全', () => {
    expect(mergeGlossary([], [])).toEqual([]);
    expect(mergeGlossary([ASHFORD], [])).toEqual([ASHFORD]);
    expect(mergeGlossary([], [ASHFORD])).toEqual([ASHFORD]);
  });

  it('不修改传入的数组', () => {
    const previous = [ASHFORD];
    const snapshot = JSON.parse(JSON.stringify(previous));
    mergeGlossary(previous, [GREYMOOR]);
    expect(previous).toEqual(snapshot);
  });

  it('同一批输入里的重复也收敛', () => {
    expect(mergeGlossary([], [ASHFORD, { source: 'ashford', target: '艾许佛' }, GREYMOOR])).toEqual(
      [ASHFORD, GREYMOOR],
    );
  });
});

describe('用户显式改译名：覆盖', () => {
  it('作者说这个名字该怎么译，就覆盖已有的', () => {
    // 与合并的先到先得刻意相反 —— 这是作者的决定
    expect(setGlossaryEntry([ASHFORD], 'Ashford', '艾许佛')).toEqual([
      { source: 'Ashford', target: '艾许佛' },
    ]);
  });

  it('保留原来的原文写法，只换译名', () => {
    // 原文名是从稿件里来的，不该被输入框里的大小写改掉
    expect(setGlossaryEntry([ASHFORD], 'ashford', '艾许佛')[0]?.source).toBe('Ashford');
  });

  it('不存在就追加在末尾', () => {
    expect(setGlossaryEntry([ASHFORD], 'Greymoor', '灰沼')).toEqual([ASHFORD, GREYMOOR]);
  });

  it('译名为空时不动表 —— 清空译名等于没有译法，那是删除的语义', () => {
    expect(setGlossaryEntry([ASHFORD], 'Ashford', '   ')).toEqual([ASHFORD]);
  });

  it('不修改传入的数组', () => {
    const entries = [ASHFORD];
    setGlossaryEntry(entries, 'Ashford', '艾许佛');
    expect(entries).toEqual([ASHFORD]);
  });
});

describe('删除译名', () => {
  it('按原文名删，忽略大小写', () => {
    expect(removeGlossaryEntry([ASHFORD, GREYMOOR], 'ashford')).toEqual([GREYMOOR]);
  });

  it('删不存在的不报错', () => {
    expect(removeGlossaryEntry([ASHFORD], 'Nobody')).toEqual([ASHFORD]);
  });
});

describe('只挑出这段原文里出现过的', () => {
  const all = [ASHFORD, GREYMOOR, { source: 'Eastwick', target: '东威克' }];

  it('没出现的专名不进 prompt', () => {
    // 跑到后期译名表会有几百条，全量注入既贵又稀释注意力
    expect(relevantGlossary(all, 'Ashford walked into Greymoor.')).toEqual([ASHFORD, GREYMOOR]);
  });

  it('匹配忽略大小写', () => {
    expect(relevantGlossary(all, 'ashford left.')).toEqual([ASHFORD]);
  });

  it('一个都没命中就返回空', () => {
    expect(relevantGlossary(all, 'Nobody was there.')).toEqual([]);
  });
});

describe('找出译文没跟上译名表的章节', () => {
  function chapter(
    id: string,
    index: number,
    content: string,
    sourceContent: string,
    title = '',
  ): GlossaryCheckChapter {
    return { id, index, title, content, sourceContent };
  }

  it('原文出现过这个专名、译文里却没有当前译名，就算不一致', () => {
    // 用户把 Ashford 改成了「艾许佛」，但第一章还是旧译法
    const drifts = findGlossaryDrift(
      [{ source: 'Ashford', target: '艾许佛' }],
      [chapter('c1', 1, '阿什福德走进门。', 'Ashford walked in.', '归乡')],
    );
    expect(drifts).toEqual([
      {
        source: 'Ashford',
        target: '艾许佛',
        chapters: [{ id: 'c1', index: 1, title: '归乡' }],
      },
    ]);
  });

  it('译文里已经用了当前译名就不报', () => {
    expect(
      findGlossaryDrift([ASHFORD], [chapter('c1', 1, '阿什福德走进门。', 'Ashford walked in.')]),
    ).toEqual([]);
  });

  it('原文里没出现过的专名不牵连这一章', () => {
    // 译文里没有「灰沼」很正常 —— 这一章原文压根没提 Greymoor
    expect(
      findGlossaryDrift([GREYMOOR], [chapter('c1', 1, '阿什福德走进门。', 'Ashford walked in.')]),
    ).toEqual([]);
  });

  it('原文匹配忽略大小写', () => {
    const drifts = findGlossaryDrift(
      [{ source: 'Ashford', target: '艾许佛' }],
      [chapter('c1', 1, '他走进门。', 'ASHFORD walked in.')],
    );
    expect(drifts[0]?.chapters).toHaveLength(1);
  });

  it('没翻译过的章节不参与 —— 中文原创章节没有原文可以对齐', () => {
    // 正文里写着旧译名，但没有 sourceContent，无从判定它是不是同一个人
    expect(
      findGlossaryDrift(
        [{ source: 'Ashford', target: '艾许佛' }],
        [chapter('c1', 1, '阿什福德走进门。', ''), chapter('c2', 2, '阿什福德又走了。', '   ')],
      ),
    ).toEqual([]);
  });

  it('一条译名可以命中多章，按章节传入的顺序列出', () => {
    const drifts = findGlossaryDrift(
      [{ source: 'Ashford', target: '艾许佛' }],
      [
        chapter('c1', 1, '阿什福德走进门。', 'Ashford walked in.'),
        chapter('c2', 2, '艾许佛坐下。', 'Ashford sat down.'),
        chapter('c3', 3, '阿什福德离开。', 'Ashford left.'),
      ],
    );
    expect(drifts[0]?.chapters.map((item) => item.id)).toEqual(['c1', 'c3']);
  });

  it('多条译名各自成组', () => {
    const drifts = findGlossaryDrift(
      [
        { source: 'Ashford', target: '艾许佛' },
        { source: 'Greymoor', target: '灰泽' },
      ],
      [chapter('c1', 1, '阿什福德到了灰沼。', 'Ashford reached Greymoor.')],
    );
    expect(drifts.map((drift) => drift.source)).toEqual(['Ashford', 'Greymoor']);
  });

  it('译文里出现过一次就算通过', () => {
    // 长章节里代词、简称满地都是，要求处处都写全名的话几乎每章都会被标红
    expect(
      findGlossaryDrift(
        [ASHFORD],
        [
          chapter(
            'c1',
            1,
            '阿什福德走进门。他坐下。那人又站起来。',
            'Ashford walked in. He sat. He rose.',
          ),
        ],
      ),
    ).toEqual([]);
  });

  it('空译名表、空章节列表都返回空', () => {
    expect(findGlossaryDrift([], [chapter('c1', 1, 'a', 'b')])).toEqual([]);
    expect(findGlossaryDrift([ASHFORD], [])).toEqual([]);
  });

  it('残缺的译名条目不参与检查', () => {
    expect(
      findGlossaryDrift(
        [{ source: 'Ashford', target: '  ' }],
        [chapter('c1', 1, '他走进门。', 'Ashford walked in.')],
      ),
    ).toEqual([]);
  });
});
