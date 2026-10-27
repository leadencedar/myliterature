/**
 * 代码卫生独立检查（task-10 第 3 点 / 项目纪律：strict TS、无 any、无调试残留）。
 *
 * 只扫 M1 新增与修改的实现文件；扫描器先用一段「故意违规」的样本自测，
 * 证明不是空转（正则写错时用例必须失败）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** M1 新增文件（design §10）；QA2 阶段后几个文件才存在，存在才扫 */
const M1_NEW_FILES = [
  'src/domain/entryMention.ts',
  'src/context/renderEntry.ts',
  'src/context/planningContext.ts',
  'src/features/outline/suggestOutlineLinks.ts',
  'src/features/outline/OutlineLinkConfirmSheet.tsx',
  'src/features/writing/chapterLength.ts',
];

/** M1 修改文件（不扫测试文件；测试里的 vi.fn 等不算调试残留） */
const M1_MODIFIED_FILES = [
  'src/context/SummaryChainContextBuilder.ts',
  'src/data/NovelRepository.ts',
  'src/data/dexie/DexieNovelRepository.ts',
  'src/proposal/apply.ts',
  'src/features/outline/outlineExpand.ts',
  'src/features/outline/OutlineNodeSheet.tsx',
  'src/features/outline/OutlineLinkConfirmSheet.tsx',
  'src/features/writing/WritingPage.tsx',
  'src/features/writing/chapterDraft.ts',
  'src/features/writing/GenerateChapterSheet.tsx',
  'src/llm/types.ts',
  'src/llm/useLlm.ts',
];

const BANNED: { name: string; pattern: RegExp }[] = [
  { name: 'type any（annotation）', pattern: /:\s*any\b/u },
  { name: 'as any', pattern: /\bas\s+any\b/u },
  { name: 'angle-bracket any', pattern: /<any>/u },
  { name: 'console.*', pattern: /\bconsole\.(log|warn|error|debug|info|trace)\b/u },
  { name: 'debugger', pattern: /\bdebugger\b/u },
];

function scan(text: string): string[] {
  const findings: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const banned of BANNED) {
      if (banned.pattern.test(line)) findings.push(`${banned.name} @${index + 1}: ${line.trim()}`);
    }
  });
  return findings;
}

describe('代码卫生 · 扫描器自测（防止正则空转）', () => {
  it('能抓出四种违规写法', () => {
    expect(scan('const x: any = 1;')).toHaveLength(1);
    expect(scan('return value as any;')).toHaveLength(1);
    expect(scan('function f(): Array<any> {}')).toHaveLength(1);
    expect(scan('console.log("x"); debugger;')).toHaveLength(2);
  });

  it('正常代码不误报', () => {
    expect(
      scan('const anything: unknown = 1; // commentary 含 any 的注释不算\nconst anyValue = 2;'),
    ).toEqual([]);
  });
});

describe('代码卫生 · M1 实现文件无 any / console / debugger', () => {
  const existing = [...M1_NEW_FILES, ...M1_MODIFIED_FILES].filter((relative) =>
    existsSync(resolve(process.cwd(), relative)),
  );

  it('至少扫到 QA1 已存在的三个新增文件（不是空扫）', () => {
    expect(existing).toEqual(
      expect.arrayContaining([
        'src/domain/entryMention.ts',
        'src/context/renderEntry.ts',
        'src/context/planningContext.ts',
      ]),
    );
  });

  it.each(existing)('%s 无违规写法', (relative) => {
    const text = readFileSync(resolve(process.cwd(), relative), 'utf8');
    expect(scan(text)).toEqual([]);
  });
});
