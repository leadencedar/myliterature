import { describe, expect, it } from 'vitest';
import {
  ChapterSchema,
  NovelSchema,
  SideStorySchema,
  type Chapter,
  type Novel,
  type SideStory,
} from '@/domain/schema';
import { extractRtfText } from '@/features/import/rtf';
import {
  PACK_FORMAT_EXTENSIONS,
  buildChapterPackZip,
  planChapterPack,
  type PackFormat,
  type PackOptions,
  type PackPlan,
} from './chapterPack';
import { formatChapter } from './exportText';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const UTF8_FLAG = 0x0800;
const FIXED_NOW = new Date(2026, 9, 26, 3, 20, 8);

function novel(overrides: Partial<Novel> = {}): Novel {
  return NovelSchema.parse({
    id: 'n1',
    title: '归墟纪',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

/** schema 要求书名非空，测试空书名时绕过 parse 直接造对象 */
function novelWithTitle(title: string): Novel {
  return { ...novel(), title };
}

function chapter(index: number, overrides: Partial<Chapter> = {}): Chapter {
  return ChapterSchema.parse({
    id: `ch${index}`,
    novelId: 'n1',
    index,
    content: `第 ${index} 章的正文。`,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function sideStory(id: string, title: string, order = 0): SideStory {
  return SideStorySchema.parse({
    id,
    novelId: 'n1',
    title,
    order,
    createdAt: 0,
    updatedAt: 0,
  });
}

function options(overrides: Partial<PackOptions> = {}): PackOptions {
  return { defaultFormat: 'txt', ...overrides };
}

function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return (async () => {
    const reader = readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const output = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      output.set(chunk, at);
      at += chunk.length;
    }
    return output;
  })();
}

async function inflateRaw(payload: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const inflated = collect(stream.readable);
  const written = (async () => {
    const writer = stream.writable.getWriter();
    // 与 createZip 内部同理：Writer 只收普通 ArrayBuffer 支撑的视图
    await writer.write(new Uint8Array(payload));
    await writer.close();
  })();
  const [output] = await Promise.all([inflated, written]);
  return output;
}

interface UnpackedZip {
  /** local header 顺序 = 打包时的条目顺序 */
  paths: string[];
  files: Map<string, Uint8Array>;
}

/** 测试里只解自己写的经典 zip：顺序读 local header，读到 central 签名即止 */
async function unpackZip(bytes: Uint8Array): Promise<UnpackedZip> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const paths: string[] = [];
  const files = new Map<string, Uint8Array>();
  let at = 0;
  while (view.getUint32(at, true) === LOCAL_SIGNATURE) {
    const flags = view.getUint16(at + 6, true);
    const method = view.getUint16(at + 8, true);
    const compressedSize = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const nameStart = at + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const path = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const payload = bytes.subarray(dataStart, dataStart + compressedSize);
    expect(flags, `${path} 应带 UTF-8 文件名标志位`).toBe(UTF8_FLAG);
    files.set(path, method === 0 ? payload : await inflateRaw(payload));
    paths.push(path);
    at = dataStart + compressedSize;
  }
  expect(view.getUint32(at, true), 'local 区域后应是 central directory').toBe(CENTRAL_SIGNATURE);
  return { paths, files };
}

function textOf(files: Map<string, Uint8Array>, path: string): string {
  const data = files.get(path);
  if (!data) throw new Error(`解压结果里没有 ${path}`);
  return decoder.decode(data);
}

describe('格式与扩展名', () => {
  it('四种格式的扩展名固定', () => {
    expect(PACK_FORMAT_EXTENSIONS).toEqual({
      markdown: 'md',
      txt: 'txt',
      rtf: 'rtf',
      pdf: 'pdf',
    });
  });
});

describe('打包计划：主线', () => {
  const chapters = [
    chapter(2, { id: 'ch2', title: '渡口', content: '雨下了三天。', status: 'done' }),
    chapter(1, { id: 'ch1', title: '离乡', content: '天还没亮。', status: 'done' }),
    chapter(3, { id: 'ch3', title: '灵潮', content: '子夜翻涌。', status: 'draft' }),
  ];

  it('按 index 升序、放在书名根下、默认 3 位补零', () => {
    const plan = planChapterPack(novel(), chapters, [], options());
    expect(plan.bookTitle).toBe('归墟纪');
    expect(plan.zipFileName).toBe('归墟纪.zip');
    expect(plan.files).toEqual([
      {
        chapterId: 'ch1',
        name: '第001章 离乡.txt',
        path: '归墟纪/第001章 离乡.txt',
        format: 'txt',
        chars: 5,
      },
      {
        chapterId: 'ch2',
        name: '第002章 渡口.txt',
        path: '归墟纪/第002章 渡口.txt',
        format: 'txt',
        chars: 6,
      },
      {
        chapterId: 'ch3',
        name: '第003章 灵潮.txt',
        path: '归墟纪/第003章 灵潮.txt',
        format: 'txt',
        chars: 5,
      },
    ]);
    expect(plan.totalChars).toBe(16);
    expect(plan.skipped).toBe(0);
  });

  it('每条线按实际导出的最大 index 决定补零位数：超过 999 章整条线变 4 位', () => {
    const long = [
      chapter(5, { id: 'ch5', title: '五' }),
      chapter(1234, { id: 'ch1234', title: '大章' }),
    ];
    const plan = planChapterPack(novel(), long, [], options());
    expect(plan.files.map((file) => file.name)).toEqual(['第0005章 五.txt', '第1234章 大章.txt']);
  });

  it('空标题的文件名只剩章号', () => {
    const plan = planChapterPack(
      novel(),
      [chapter(1, { title: '' }), chapter(2, { title: '   ' })],
      [],
      options(),
    );
    expect(plan.files.map((file) => file.name)).toEqual(['第001章.txt', '第002章.txt']);
  });

  it('标题净化：去掉文件系统敏感字符与控制字符', () => {
    const plan = planChapterPack(
      novel(),
      [chapter(1, { title: ' 离乡/渡口:夜?*"<>|  ' }), chapter(2, { title: '上\r\n下\t篇' })],
      [],
      options(),
    );
    expect(plan.files[0]!.name).toBe('第001章 离乡渡口夜.txt');
    expect(plan.files[1]!.name).toBe('第002章 上下篇.txt');
  });

  it('标题按字符截到 40 个，结尾句点去掉', () => {
    const plan = planChapterPack(
      novel(),
      [chapter(1, { title: `${'离'.repeat(45)}...` })],
      [],
      options(),
    );
    const expected = `第001章 ${'离'.repeat(40)}.txt`;
    expect(plan.files[0]!.name).toBe(expected);
  });

  it('chars 与 totalChars 按 trim 后的正文字数算', () => {
    const plan = planChapterPack(
      novel(),
      [chapter(1, { content: '  天还没亮。  ' }), chapter(2, { content: '雨下了三天。\n' })],
      [],
      options(),
    );
    expect(plan.files.map((file) => file.chars)).toEqual([5, 6]);
    expect(plan.totalChars).toBe(11);
  });
});

describe('打包计划：外传', () => {
  const storyA = sideStory('sa', '青冥旧事', 1);
  const storyB = sideStory('sb', '渡口夜话', 2);
  const chapters = [
    chapter(1, { id: 'm1', title: '离乡', content: '天还没亮。' }),
    chapter(1, { id: 'a1', sideStoryId: 'sa', title: '拜师', content: '青冥第一章。' }),
    chapter(2, { id: 'a2', sideStoryId: 'sa', title: '', content: '青冥第二章。' }),
    chapter(1, { id: 'b1', sideStoryId: 'sb', title: '夜渡', content: '渡口夜色。' }),
  ];

  it('默认不带外传，也不把外传章节算进 skipped', () => {
    const plan = planChapterPack(novel(), chapters, [storyA, storyB], options());
    expect(plan.files.map((file) => file.path)).toEqual(['归墟纪/第001章 离乡.txt']);
    expect(plan.skipped).toBe(0);
  });

  it('附带外传时按「外传顺序」各进子文件夹，主线在前', () => {
    const plain = planChapterPack(novel(), chapters, [storyA, storyB], options());
    const plan = planChapterPack(
      novel(),
      chapters,
      [storyA, storyB],
      options({ includeSideStories: true }),
    );
    expect(plan.files.map((file) => file.path)).toEqual([
      '归墟纪/第001章 离乡.txt',
      '归墟纪/外传·青冥旧事/第001章 拜师.txt',
      '归墟纪/外传·青冥旧事/第002章.txt',
      '归墟纪/外传·渡口夜话/第001章 夜渡.txt',
    ]);
    // 主线的部分逐字节不受附带外传影响
    expect(plan.files[0]).toEqual(plain.files[0]);
  });

  it('外传按 SideStory.order 排，与传入数组顺序无关', () => {
    const plan = planChapterPack(
      novel(),
      chapters,
      [storyB, storyA],
      options({ includeSideStories: true }),
    );
    expect(plan.files.map((file) => file.path)).toEqual([
      '归墟纪/第001章 离乡.txt',
      '归墟纪/外传·青冥旧事/第001章 拜师.txt',
      '归墟纪/外传·青冥旧事/第002章.txt',
      '归墟纪/外传·渡口夜话/第001章 夜渡.txt',
    ]);
  });

  it('补零位数按每条线各算：外传章号长不影响主线', () => {
    const plan = planChapterPack(
      novel(),
      [
        chapter(1, { id: 'm1', title: '离乡' }),
        chapter(1234, { id: 'a-long', sideStoryId: 'sa', title: '长外传' }),
      ],
      [storyA],
      options({ includeSideStories: true }),
    );
    expect(plan.files.map((file) => file.name)).toEqual([
      '第001章 离乡.txt',
      '第1234章 长外传.txt',
    ]);
  });

  it('外传标题净化；空标题回退「外传」', () => {
    const dirty = sideStory('sc', '青冥/旧事:上?*"<>|', 0);
    const untitled = { ...sideStory('sd', '占位', 1), title: '' };
    const plan = planChapterPack(
      novel(),
      [
        chapter(1, { id: 'c1', sideStoryId: 'sc', title: '甲', content: '甲。' }),
        chapter(1, { id: 'd1', sideStoryId: 'sd', title: '乙', content: '乙。' }),
      ],
      [dirty, untitled],
      options({ includeSideStories: true }),
    );
    expect(plan.files.map((file) => file.path)).toEqual([
      '归墟纪/外传·青冥旧事上/第001章 甲.txt',
      '归墟纪/外传/第001章 乙.txt',
    ]);
  });
});

describe('打包计划：跳过规则', () => {
  const chapters = [
    chapter(1, { id: 'done-full', title: '完成有字', content: '正文。', status: 'done' }),
    chapter(2, { id: 'draft-full', title: '草稿有字', content: '正文。', status: 'draft' }),
    chapter(3, { id: 'done-empty', title: '完成空章', content: '   \n\t ', status: 'done' }),
    chapter(4, { id: 'draft-empty', title: '草稿空章', content: '', status: 'draft' }),
  ];

  it('空章节一律不导出，草稿只有 doneOnly 时跳过', () => {
    const all = planChapterPack(novel(), chapters, [], options());
    expect(all.files.map((file) => file.chapterId)).toEqual(['done-full', 'draft-full']);
    expect(all.skipped).toBe(2);

    const done = planChapterPack(novel(), chapters, [], options({ doneOnly: true }));
    expect(done.files.map((file) => file.chapterId)).toEqual(['done-full']);
    expect(done.skipped).toBe(3);
  });

  it('附带外传时，外传里被跳过的章节同样计数', () => {
    const story = sideStory('sa', '青冥旧事');
    const plan = planChapterPack(
      novel(),
      [...chapters, chapter(1, { id: 'side-empty', sideStoryId: 'sa', title: '空', content: ' ' })],
      [story],
      options({ includeSideStories: true }),
    );
    expect(plan.skipped).toBe(3);
  });

  it('没有可导出章节时 files 为空，文件名仍按书名生成', () => {
    const plan = planChapterPack(
      novel(),
      [chapter(1, { content: '' }), chapter(2, { content: '  ', status: 'draft' })],
      [],
      options(),
    );
    expect(plan.files).toEqual([]);
    expect(plan.totalChars).toBe(0);
    expect(plan.skipped).toBe(2);
    expect(plan.zipFileName).toBe('归墟纪.zip');
  });
});

describe('打包计划：逐章格式覆盖', () => {
  it('formats 只改点名的章，其余用默认格式', () => {
    const plan = planChapterPack(
      novel(),
      [
        chapter(1, { id: 'c1', title: '离乡' }),
        chapter(2, { id: 'c2', title: '渡口' }),
        chapter(3, { id: 'c3', title: '灵潮' }),
      ],
      [],
      options({
        defaultFormat: 'txt',
        formats: { c2: 'pdf', c3: 'markdown' } satisfies Record<string, PackFormat>,
      }),
    );
    expect(plan.files.map((file) => [file.format, file.name])).toEqual([
      ['txt', '第001章 离乡.txt'],
      ['pdf', '第002章 渡口.pdf'],
      ['markdown', '第003章 灵潮.md'],
    ]);
  });
});

describe('打包计划：书名回退与净化', () => {
  it('书名只有敏感字符时回退「未命名作品」', () => {
    const plan = planChapterPack(novelWithTitle('///'), [chapter(1, { title: '' })], [], options());
    expect(plan.bookTitle).toBe('未命名作品');
    expect(plan.zipFileName).toBe('未命名作品.zip');
    expect(plan.files[0]!.path).toBe('未命名作品/第001章.txt');
  });

  it('书名去掉敏感字符与结尾句点', () => {
    const plan = planChapterPack(novelWithTitle(' 归/墟:纪. '), [], [], options());
    expect(plan.bookTitle).toBe('归墟纪');
    expect(plan.zipFileName).toBe('归墟纪.zip');
  });

  it('超长书名截到 40 个字符，zip 根文件夹名不超文件系统单级名字上限', () => {
    const plan = planChapterPack(
      novelWithTitle('长'.repeat(120)),
      [chapter(1, { title: '' })],
      [],
      options(),
    );
    // 120 个汉字 ≈ 360 UTF-8 字节，超过常见文件系统 255 字节上限，必须截
    expect(plan.bookTitle).toBe('长'.repeat(40));
    expect(plan.bookTitle.length).toBe(40);
    expect(encoder.encode(plan.bookTitle).length).toBeLessThanOrEqual(255);
    expect(plan.zipFileName).toBe(`${plan.bookTitle}.zip`);
    expect(plan.zipFileName.endsWith('.zip')).toBe(true);
    // 文件名（不含根文件夹）也应是短名，解压器建文件不会超限
    expect(plan.files[0]!.name).toBe('第001章.txt');
    expect(encoder.encode(plan.files[0]!.name).length).toBeLessThanOrEqual(255);
  });
});

describe('按计划生成 zip', () => {
  const story = sideStory('sa', '青冥旧事');
  const chapters = [
    chapter(1, {
      id: 'c1',
      title: '离乡',
      content: '天还没亮，他就走了。\n雨下了三天。',
    }),
    chapter(2, { id: 'c2', title: '渡口', content: '雨停了。' }),
    chapter(1, { id: 's1', sideStoryId: 'sa', title: '拜师', content: '青冥山下。' }),
  ];

  it('条目顺序 = 计划顺序，txt/md 与 formatChapter 输出一致', async () => {
    const plan = planChapterPack(novel(), chapters, [story], {
      defaultFormat: 'txt',
      formats: { c1: 'markdown' },
      includeSideStories: true,
    });
    const bytes = await buildChapterPackZip(plan, FIXED_NOW);
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'

    const { paths, files } = await unpackZip(bytes);
    expect(paths).toEqual(plan.files.map((file) => file.path));

    expect(textOf(files, '归墟纪/第001章 离乡.md')).toBe(formatChapter(chapters[0]!, 'markdown'));
    expect(textOf(files, '归墟纪/第002章 渡口.txt')).toBe(formatChapter(chapters[1]!, 'txt'));
    expect(textOf(files, '归墟纪/外传·青冥旧事/第001章 拜师.txt')).toBe(
      formatChapter(chapters[2]!, 'txt', story),
    );
  });

  it('rtf 条目可被自家提取器解回标题与正文', async () => {
    const plan = planChapterPack(novel(), [chapters[2]!], [story], {
      defaultFormat: 'rtf',
      includeSideStories: true,
    });
    const { files } = await unpackZip(await buildChapterPackZip(plan, FIXED_NOW));
    const rtf = textOf(files, '归墟纪/外传·青冥旧事/第001章 拜师.rtf');
    expect(rtf.startsWith('{\\rtf1')).toBe(true);
    const extracted = extractRtfText(rtf);
    expect(extracted.text).toContain('拜师');
    expect(extracted.text).toContain('青冥山下。');
  });

  it('pdf 条目是真正的 PDF 字节', async () => {
    const plan = planChapterPack(novel(), [chapters[0]!], [], { defaultFormat: 'pdf' });
    const { files } = await unpackZip(await buildChapterPackZip(plan, FIXED_NOW));
    const pdf = files.get('归墟纪/第001章 离乡.pdf');
    if (!pdf) throw new Error('解压结果里没有 pdf 条目');
    expect(decoder.decode(pdf.subarray(0, 5))).toBe('%PDF-');
    expect(decoder.decode(pdf).trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('固定 now 后同一计划生成字节确定', async () => {
    const plan = planChapterPack(novel(), [chapters[1]!], [], options());
    const first = await buildChapterPackZip(plan, FIXED_NOW);
    const second = await buildChapterPackZip(plan, FIXED_NOW);
    expect(second).toEqual(first);
  });

  it('计划缺少章节来源或章节已删除时 reject，由 UI 提示重试', async () => {
    const bare: PackPlan = {
      bookTitle: '归墟纪',
      zipFileName: '归墟纪.zip',
      files: [],
      totalChars: 0,
      skipped: 0,
    };
    await expect(buildChapterPackZip(bare, FIXED_NOW)).rejects.toThrow('缺少章节来源');

    const plan = planChapterPack(novel(), [chapters[0]!], [], options());
    const stale: PackPlan = {
      ...plan,
      files: [{ chapterId: 'gone', name: 'x.txt', path: '归墟纪/x.txt', format: 'txt', chars: 1 }],
    };
    await expect(buildChapterPackZip(stale, FIXED_NOW)).rejects.toThrow('已不存在');
  });
});
