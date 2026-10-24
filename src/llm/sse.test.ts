import { describe, expect, it } from 'vitest';
import { streamFromChunks } from '@/test/llmFixtures';
import { parseChunk, parseSseStream } from './sse';

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of parseSseStream(streamFromChunks(chunks))) {
    out.push(payload);
  }
  return out;
}

describe('SSE 解析', () => {
  it('解析单个事件', async () => {
    expect(await collect(['data: {"a":1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('一个网络分块里包含多个事件', async () => {
    expect(await collect(['data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n'])).toEqual([
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
    ]);
  });

  it('单个事件被切成多个网络分块', async () => {
    // 这是流式最容易踩的坑：JSON 被拦腰截断
    expect(await collect(['data: {"conte', 'nt":"你好', '世界"}\n\n'])).toEqual([
      '{"content":"你好世界"}',
    ]);
  });

  it('分块边界正好落在换行符上', async () => {
    expect(await collect(['data: {"a":1}\n', '\ndata: {"a":2}\n\n'])).toEqual([
      '{"a":1}',
      '{"a":2}',
    ]);
  });

  it('兼容 CRLF 行尾', async () => {
    expect(await collect(['data: {"a":1}\r\n\r\n'])).toEqual(['{"a":1}']);
  });

  it('忽略注释形式的心跳行', async () => {
    expect(await collect([': keep-alive\n\ndata: {"a":1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('忽略非 data 字段', async () => {
    expect(await collect(['event: message\nid: 7\ndata: {"a":1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('遇到 [DONE] 即结束，之后的内容不再产出', async () => {
    expect(await collect(['data: {"a":1}\n\ndata: [DONE]\n\ndata: {"a":2}\n\n'])).toEqual([
      '{"a":1}',
    ]);
  });

  it('流结束时没有换行收尾也能取到最后一条', async () => {
    expect(await collect(['data: {"a":1}'])).toEqual(['{"a":1}']);
  });

  it('空流返回空结果', async () => {
    expect(await collect([])).toEqual([]);
    expect(await collect(['\n\n'])).toEqual([]);
  });
});

describe('chunk 解析', () => {
  it('解析合法 JSON', () => {
    expect(parseChunk('{"choices":[{"delta":{"content":"x"}}]}')).toEqual({
      choices: [{ delta: { content: 'x' } }],
    });
  });

  it('遇到坏 chunk 返回 undefined 而不是抛错', () => {
    // 一条坏 chunk 不该让整次生成失败
    expect(parseChunk('not json')).toBeUndefined();
  });
});
