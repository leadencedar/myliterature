import { describe, expect, it } from 'vitest';
import {
  buildOutlineDrafts,
  countOutlineNodes,
  parseOutlineTree,
  serializeOutlineTree,
  sumOutlineTargetWords,
  type OutlineDraft,
} from './outlineText';

function node(
  title: string,
  synopsis = '',
  targetWords: number | null = null,
  children: OutlineDraft[] = [],
): OutlineDraft {
  return { title, synopsis, targetWords, children };
}

const TREE: OutlineDraft[] = [
  node('第一卷 风起', '主角被追杀，逃入雪山。', 30_000, [
    node('第1章 雪夜', '追兵临门，主角负伤。', 3000),
    node('第2章 旧识', '雪山木屋遇到故人。', 3000),
  ]),
  node('第二卷 潮落', '真相浮现。', 30_000, [node('第3章 灰烬', '发现灭门案的线索。', 3000)]),
];

describe('序列化', () => {
  it('用 # 层级表示卷与章，字数写在标题后', () => {
    const text = serializeOutlineTree(TREE);

    expect(text).toContain('# 第一卷 风起（约 30000 字）');
    expect(text).toContain('## 第1章 雪夜（约 3000 字）');
    expect(text).toContain('追兵临门，主角负伤。');
  });

  it('没有字数标注时不写括号', () => {
    expect(serializeOutlineTree([node('第一幕')])).toBe('# 第一幕');
  });

  it('没有梗概时不产生空行', () => {
    const text = serializeOutlineTree([node('甲'), node('乙')]);
    expect(text).toBe('# 甲\n\n# 乙');
  });
});

describe('解析', () => {
  it('还原层级、标题、梗概与字数', () => {
    const parsed = parseOutlineTree(serializeOutlineTree(TREE));
    expect(parsed).toEqual(TREE);
  });

  it('序列化与解析可往返（改动后再往返仍稳定）', () => {
    const once = serializeOutlineTree(TREE);
    const twice = serializeOutlineTree(parseOutlineTree(once));
    expect(twice).toBe(once);
  });

  it('多行梗概按行合并', () => {
    const parsed = parseOutlineTree('# 第一卷\n第一行。\n第二行。');
    expect(parsed[0]?.synopsis).toBe('第一行。\n第二行。');
  });

  it('容忍层级跳跃：# 之后直接出现 ###', () => {
    const parsed = parseOutlineTree('# 卷一\n### 章一');

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.children).toHaveLength(1);
    expect(parsed[0]?.children[0]?.title).toBe('章一');
  });

  it('容忍开头就是深层标题', () => {
    const parsed = parseOutlineTree('## 章一\n## 章二');
    expect(parsed.map((item) => item.title)).toEqual(['章一', '章二']);
  });

  it('层级回退时正确归位', () => {
    const parsed = parseOutlineTree('# 卷一\n## 章一\n## 章二\n# 卷二\n## 章三');

    expect(parsed.map((item) => item.title)).toEqual(['卷一', '卷二']);
    expect(parsed[0]?.children.map((item) => item.title)).toEqual(['章一', '章二']);
    expect(parsed[1]?.children.map((item) => item.title)).toEqual(['章三']);
  });

  it('忽略第一个标题之前的杂散文字', () => {
    const parsed = parseOutlineTree('随手写的备注\n\n# 卷一\n梗概');

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.synopsis).toBe('梗概');
  });

  it('忽略空行与纯空白行', () => {
    expect(parseOutlineTree('\n\n# 卷一\n\n\n梗概\n\n')).toEqual([node('卷一', '梗概')]);
  });

  it('标题为空的行被跳过', () => {
    expect(parseOutlineTree('#\n## \n# 卷一')).toEqual([node('卷一')]);
  });

  it('兼容半角括号与带千分位的字数', () => {
    const parsed = parseOutlineTree('# 卷一(约 30,000 字)\n## 章一（3000字）');

    expect(parsed[0]?.targetWords).toBe(30_000);
    expect(parsed[0]?.children[0]?.targetWords).toBe(3000);
  });

  it('字数标注里的非法数字不影响标题', () => {
    const parsed = parseOutlineTree('# 卷一（约 很多 字）');
    expect(parsed[0]?.title).toBe('卷一（约 很多 字）');
    expect(parsed[0]?.targetWords).toBeNull();
  });

  it('空文本返回空数组', () => {
    expect(parseOutlineTree('')).toEqual([]);
    expect(parseOutlineTree('   \n  ')).toEqual([]);
  });
});

describe('扁平节点转树', () => {
  it('按 parentId 与 order 还原结构', () => {
    const flat = [
      { id: 'b', parentId: null, order: 1, title: '卷二', synopsis: '', targetWords: null },
      { id: 'a', parentId: null, order: 0, title: '卷一', synopsis: '梗概', targetWords: 30_000 },
      { id: 'a2', parentId: 'a', order: 1, title: '章二', synopsis: '', targetWords: null },
      { id: 'a1', parentId: 'a', order: 0, title: '章一', synopsis: '', targetWords: 3000 },
    ];

    const tree = buildOutlineDrafts(flat);

    expect(tree.map((item) => item.title)).toEqual(['卷一', '卷二']);
    expect(tree[0]?.children.map((item) => item.title)).toEqual(['章一', '章二']);
    expect(tree[0]?.targetWords).toBe(30_000);
  });

  it('指定挂载点时只取该节点的子树，含孙节点', () => {
    const flat = [
      { id: 'a', parentId: null, order: 0, title: '卷一', synopsis: '', targetWords: null },
      { id: 'a1', parentId: 'a', order: 0, title: '章一', synopsis: '梗概', targetWords: 3000 },
      { id: 'a1x', parentId: 'a1', order: 0, title: '节一', synopsis: '', targetWords: null },
      { id: 'b', parentId: null, order: 1, title: '卷二', synopsis: '', targetWords: null },
    ];

    const subtree = buildOutlineDrafts(flat, 'a');

    expect(subtree.map((item) => item.title)).toEqual(['章一']);
    // 孙节点必须跟着来，否则替换类提案的原值会丢内容
    expect(subtree[0]?.children.map((item) => item.title)).toEqual(['节一']);
  });

  it('挂载点不存在时返回空数组', () => {
    expect(buildOutlineDrafts([], 'ghost')).toEqual([]);
  });

  it('空输入返回空数组', () => {
    expect(buildOutlineDrafts([])).toEqual([]);
  });
});

describe('统计', () => {
  it('节点总数含所有层级', () => {
    expect(countOutlineNodes(TREE)).toBe(5);
  });

  it('目标字数以子节点合计为准，避免父子重复计数', () => {
    // 两卷各标 30000，但子章节合计是 6000 + 3000
    expect(sumOutlineTargetWords(TREE)).toBe(9000);
  });

  it('没有子节点时用自身字数', () => {
    expect(sumOutlineTargetWords([node('甲', '', 5000)])).toBe(5000);
  });
});
