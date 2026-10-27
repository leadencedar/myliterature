/**
 * 从「改动前的 HEAD」生成 M1 独立 canary 的 golden（`fixtures/head-golden.json`）。
 *
 * 正常测试套件里这个文件被 skip；只在 /tmp 的 HEAD archive 上手动执行：
 *
 *   rm -rf /tmp/m1-head && mkdir -p /tmp/m1-head
 *   git archive 52e124eaee097a47bc7d578ed7596d8599061615 | tar -x -C /tmp/m1-head
 *   ln -s "$PWD/node_modules" /tmp/m1-head/node_modules
 *   mkdir -p /tmp/m1-head/src/test/m1
 *   cp -R src/test/m1/fixtures src/test/m1/tools /tmp/m1-head/src/test/m1/
 *   (cd /tmp/m1-head && M1_CAPTURE=1 npx vitest run src/test/m1/tools/capture-head-golden.test.ts)
 *   cp /tmp/m1-head/src/test/m1/fixtures/head-golden.json src/test/m1/fixtures/
 *   rm -rf /tmp/m1-head
 *
 * golden 一旦生成不得手改；修法永远是改实现或按设计记录有意变更。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildM1Snapshot } from '../fixtures/m1-prompts.fixture';

const CAPTURE = process.env.M1_CAPTURE === '1';

describe.skipIf(!CAPTURE)('生成 HEAD golden（仅手动执行）', () => {
  it('写出 fixtures/head-golden.json', () => {
    const json = `${JSON.stringify(buildM1Snapshot(), null, 2)}\n`;
    const target = resolve(process.cwd(), 'src/test/m1/fixtures/head-golden.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, json, 'utf8');
    expect(json.length).toBeGreaterThan(1000);
  });
});
