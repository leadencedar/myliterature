# 分章导出（TXT / MD / RTF / PDF）与整本压缩包技术设计

> 状态：已实现并验证（2026-10-26）。基线：`main` @ 37ee923，typecheck 通过、76 个测试文件 / 1770 个测试通过。
> 最终验证与测试数见 `docs/开发计划.md`「增量：分章导出与整本压缩包」一节的验证结果。
>
> 本文是实现契约。涉及的文件按「写作用域」切分，各自只改自己名下的文件；契约里写死的导出名与行为不要自行改动，发现不合理先找 Lead。

---

## 1. 需求与用户路径

作者写完整本小说后，希望能一次带走整本书：**每一章一个文件**，每章的文件格式按选择决定（TXT / Markdown / RTF / PDF），**整本打包成一个 zip 下载**。

用户路径：写作页 → 章节区右上角「导出」→ 范围选「打包」→ 选默认格式（可逐章覆盖）→ 可选「只导出已完成的章节」「附带外传」→ 点「下载压缩包」→ 得到 `<书名>.zip`。

非目标（本次不做）：

- 不改现有单文件导出（全书 / 单章 / 外传，Markdown / 纯文本）的行为与界面；
- 不做单章 PDF/RTF 文件下载（只经打包导出）；
- 不引入任何 npm 运行时依赖、后端、Web Worker、Service Worker；不碰 `package.json` / lockfile；
- 不改数据库、备份格式、导入链路。

## 2. 文件与写作用域

| 作用域 | 文件（新增 N / 修改 M） | 负责人 |
| --- | --- | --- |
| formats | `src/features/export/gbkCoverage.ts`（N）、`gbkCoverage.test.ts`（N）、`rtf.ts`（N）、`rtf.test.ts`（N）、`pdf.ts`（N）、`pdf.test.ts`（N） | formats-author |
| pack | `src/features/export/zip.ts`（N）、`zip.test.ts`（N）、`chapterPack.ts`（N）、`chapterPack.test.ts`（N） | pack-author |
| ui | `src/features/export/ExportSheet.tsx`（M）、`src/features/export/ExportSheet.pack.test.tsx`（N）、`src/ui/download.ts`（M）、`src/ui/download.test.ts`（N） | Lead |
| docs | `docs/产品文档.md`、`docs/使用说明.md`、`docs/开发计划.md` | docs-author |

工程约束（全仓一致，必须遵守）：

- TypeScript 7 strict 全开，含 `noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters`；**全仓 0 处 `any`**（历史约定），必要时用 `unknown` + 类型守卫。
- Prettier：100 列、单引号、尾逗号、分号（`npx prettier --write <改动的文件>`）。
- 注释写「为什么」，不写「做了什么」；中文注释，与现有模块风格一致。
- 测试：同目录 `*.test.ts` / `*.test.tsx`，vitest + jsdom（`describe/it/expect` 全局可用）。不要写 `test.only`。新测试用中文用例名。
- 新增代码不得读取网络、不得写文件、不得用 `Date.now()` 之外的隐式全局状态；时间可注入的接口按契约注入。
- 每个模块跑 `npx vitest run <自己的测试文件>`；全仓 `npm run typecheck` 由 Lead 在集成后统一跑。

## 3. 共享契约（写死，不得改名/改形）

### 3.1 `gbkCoverage.ts`

```ts
/** 该 Unicode 码位能否用 GBK 编码（0x20..0xFFFF，已生成表） */
export function isGbkCodePoint(codePoint: number): boolean;

/**
 * PDF 文本净化：码位不在 GBK 覆盖表内（含所有非 BMP：emoji、扩展 B 汉字等）时
 * 替换为 '□'（U+25A1，可被 GBK 覆盖）。控制字符（\n 除外）按原样留给上层处理，
 * 本函数不改空白/换行。
 */
export function sanitizeForPdf(text: string): string;
```

表数据：139 段、21887 个码位，生成为一行紧凑字符串常量（下方原样使用，不要手改）：

```
20-7F,A4-A4,A7-A8,B0-B1,B7-B7,D7-D7,E0-E1,E8-EA,EC-ED,F2-F3,F7-F7,F9-FA,FC-FC,101-101,113-113,11B-11B,12B-12B,144-144,148-148,14D-14D,16B-16B,1CE-1CE,1D0-1D0,1D2-1D2,1D4-1D4,1D6-1D6,1D8-1D8,1DA-1DA,1DC-1DC,251-251,261-261,2C7-2C7,2C9-2CB,2D9-2D9,391-3A1,3A3-3A9,3B1-3C1,3C3-3C9,401-401,410-44F,451-451,2010-2010,2013-2016,2018-2019,201C-201D,2025-2026,2030-2030,2032-2033,2035-2035,203B-203B,2103-2103,2105-2105,2109-2109,2116-2116,2121-2121,2160-216B,2170-2179,2190-2193,2196-2199,2208-2208,220F-220F,2211-2211,2215-2215,221A-221A,221D-2220,2223-2223,2225-2225,2227-222B,222E-222E,2234-2237,223D-223D,2248-2248,224C-224C,2252-2252,2260-2261,2264-2267,226E-226F,2295-2295,2299-2299,22A5-22A5,22BF-22BF,2312-2312,2460-2469,2474-249B,2500-254B,2550-2573,2581-258F,2593-2595,25A0-25A1,25B2-25B3,25BC-25BD,25C6-25C7,25CB-25CB,25CE-25CF,25E2-25E5,2605-2606,2609-2609,2640-2640,2642-2642,3000-3003,3005-3017,301D-301E,3021-3029,3041-3093,309B-309E,30A1-30F6,30FC-30FE,3105-3129,3220-3229,3231-3231,32A3-32A3,338E-338F,339C-339E,33A1-33A1,33C4-33C4,33CE-33CE,33D1-33D2,33D5-33D5,4E00-9FA5,F92C-F92C,F979-F979,F995-F995,F9E7-F9E7,F9F1-F9F1,FA0C-FA0F,FA11-FA11,FA13-FA14,FA18-FA18,FA1F-FA21,FA23-FA24,FA27-FA29,FE30-FE31,FE33-FE44,FE49-FE52,FE54-FE57,FE59-FE66,FE68-FE6B,FF01-FF5E,FFE0-FFE5
```

生成方式（可复跑核对，Python 3.13）：`chr(cp).encode('gbk')` 对 `cp in range(0x20, 0x10000)` 成功即收录。文件头注释要写明「生成物，不要手改；生成自 CP936/GBK 编码表；用途见 pdf.ts」。

### 3.2 `rtf.ts`

```ts
export interface RtfDocument {
  /** 章节标题，如「第 3 章 灵潮」，必填 */
  title: string;
  /** 书名之类的副标题，可选；空串当作没有 */
  subtitle?: string;
  /** 正文段落；空行用空字符串表示。渲染时逐段输出，不做额外折行 */
  paragraphs: string[];
}

/** 生成一份可直接给 Word / WPS / RTF 阅读器打开的 RTF 文本（纯 ASCII） */
export function renderRtfDocument(doc: RtfDocument): string;

/** 文本 → RTF 转义（导出的纯函数，供测试与 renderRtfDocument 使用） */
export function escapeRtf(text: string): string;
```

排版要求：

- 输出必须是**纯 ASCII**（所有非 ASCII 都以 `\uN?` 转义），这样编码问题彻底消失；`\uN` 的 N 是**有符号 16 位十进制**（>32767 时减 65536），代理对用相邻两个 `\uN?` 表示。
- 文件结构：`{\rtf1\ansi\ansicpg936\deff0\deflang2052\uc1` + 字体表（`{\fonttbl{\f0\fnil\fcharset134 SimSun;}}`）+ 正文 + `}`。
- 标题 18pt（`\fs36`）、加粗、居中；副标题 10pt（`\fs20`）、居中；正文 12pt（`\fs24`）、1.5 倍行距（`\sl360\slmult1`）、两端对齐（`\qj`）。段前段后按需给一点间距（标题段后 `\sa240`）。
- 转义：`\` → `\\`，`{` → `\{`，`}` → `\}`；`\t` → `\tab`；其它控制字符丢弃；换行由段落结构表达，不要输出裸 CR/LF 正文。
- 空行照常输出空段落。
- **必须能过自己家的提取器**：`extractRtfText(renderRtfDocument(doc)).text` 应等于 `[title, subtitle, ...paragraphs].filter(非空).join('\n')` 的等价文本（提取器的 `\par` 会变 `\n`，具体以单测固定）。这条往返测试是硬要求（`src/features/import/rtf.ts` 的 `extractRtfText`）。

### 3.3 `pdf.ts`

```ts
export interface PdfDocument {
  /** 章节标题，必填 */
  title: string;
  /** 副标题（书名），可选；空串当作没有 */
  subtitle?: string;
  /** 正文段落；空字符串表示一个空行 */
  paragraphs: string[];
}

/** 生成一份单章 PDF 的字节。纯同步、无 DOM、无网络 */
export function renderChapterPdf(doc: PdfDocument): Uint8Array;
```

PDF 技术方案（已做渲染验证，见第 4 节，不要改成嵌入字体或位图方案）：

- A4：`595.28 × 841.89 pt`；左右边距 70pt，上边距 78pt，下边距 72pt。
- 页脚页码 9pt 居中：`第 N 页 / 共 M 页`（先排版得到总页数，再生成内容流）。
- 标题 20pt、居中、伪粗体（`2 Tr` + `0.5 w` 描边再 `0 Tr` 复位）；副标题 10pt 居中；正文 12pt、行高 20pt。
- 字体：**非嵌入** Type0 CID 字体，`/BaseFont /STSong-Light`，`/Encoding /UniGB-UTF16-H`，后代字体 `/Subtype /CIDFontType0`、`/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >>`、`/DW 1000`。
- 文本统一为 UTF-16BE 十六进制串（`<...> Tj`）；先对全文 `sanitizeForPdf`（GBK 覆盖外的字和全部非 BMP 字符替换为 `□`），因此内容流里不会出现代理对。
- 折行：CJK / 全角按 1 em、ASCII 按 0.65 em 估算宽度（**刻意取宽**，宁可提前换行也不越界）；行宽 = `595.28 - 140` pt，正文每行字数按 `行宽 / 12` 折算成 em 单位。逐字符 + 拉丁词整体换行：拉丁串（字母数字及常见半角符号）不拆开，CJK 可任意断行；超长拉丁串再硬断。空字符串段落占一行高度。
- 必含：可复制的文本层（`/ToUnicode` CMap，对实际用到的字符做恒等映射；连续码位用 `beginbfrange` 压行）、`/Info` 里的 `/Title`（UTF-16BE + BOM 的十六进制串）与 `/Producer (WenMo)`、正确的 `xref` 偏移。`startxref` 必须能被解析器定位（结构性测试会按偏移找到每个 `N 0 obj`）。
- 全 PDF 输出是 ASCII 字符串 → `TextEncoder.encode` 成 `Uint8Array`（所有动态内容只有十六进制数字与 ASCII 数字，别塞未转义中文）；对象编号、字节偏移必须自洽。
- 纯同步实现：不引用 `CompressionStream`（zip 层会整体压缩），不在 PDF 内做 Flate。
- 边界：空正文只有标题页（1 页）；超长单章自动分页（测试至少覆盖 3 页）；标题超宽自动折行居中。

### 3.4 `zip.ts`

```ts
export interface ZipEntry {
  /** zip 内路径，用 / 分隔，UTF-8；不含开头的 / */
  path: string;
  data: string | Uint8Array;
}

export interface ZipOptions {
  /** 文件时间（DOS 时间戳），默认 new Date()；测试传固定值保证字节确定性 */
  now?: Date;
  /** 传 false 强制 store（不压缩），测试兜底路径用 */
  compress?: boolean;
}

/** 打包成 zip 字节。字符串按 UTF-8 编码 */
export function createZip(entries: ZipEntry[], options?: ZipOptions): Promise<Uint8Array>;

/** 标准 CRC-32（IEEE，反射多项式 0xEDB88320），返回无符号 32 位整数 */
export function crc32(data: Uint8Array): number;
```

格式要求：

- 经典 ZIP（local file header + central directory + EOCD），**不写 ZIP64**（分章导出远小于 4 GB；单文件超限直接抛错即可）。
- 文件名在 local 与 central header 都打 UTF-8 标志位（general purpose bit 11 = `0x0800`），中文路径不能乱码。
- 压缩优先用浏览器/Node 标准能力 `CompressionStream('deflate-raw')`（method 8，ZIP 的 raw deflate 无 zlib 头）；环境没有 `CompressionStream` 或 `options.compress === false` 时回退 store（method 0）。**不要引入压缩库**。
- 每个条目的 CRC 按**原始数据**算；local header 与 central directory 的大小字段对应正确；空数据也要合法。
- DOS 时间/日期由 `now` 换算（年份夹到 1980–2107）；同一目录内条目顺序 = 传入顺序。
- 没有显式目录条目（解压器会按路径建目录）；允许条目 `path` 含 `/`。

### 3.5 `chapterPack.ts`

```ts
export type PackFormat = 'markdown' | 'txt' | 'rtf' | 'pdf';

export const PACK_FORMAT_EXTENSIONS: Record<PackFormat, string>;
// markdown:'md', txt:'txt', rtf:'rtf', pdf:'pdf'

export interface PackOptions {
  defaultFormat: PackFormat;
  /** chapterId → 该章覆盖默认格式；没有的章用 defaultFormat */
  formats?: Readonly<Record<string, PackFormat>>;
  /** 只导出已完成的章节（默认 false） */
  doneOnly?: boolean;
  /** 附带外传（默认 false）；外传章节各进自己的子文件夹 */
  includeSideStories?: boolean;
}

export interface PackFile {
  /** 稳定键 = chapter.id */
  chapterId: string;
  /** 文件名（不含文件夹），如「第001章 离乡.txt」 */
  name: string;
  /** zip 内完整路径（含书名文件夹），如「归墟纪/第001章 离乡.txt」 */
  path: string;
  format: PackFormat;
  /** 章节正文字符数（content.trim().length） */
  chars: number;
}

export interface PackPlan {
  /** 净化后的书名，用作 zip 根文件夹名；空书名回退「未命名作品」 */
  bookTitle: string;
  /** 下载文件名，如「归墟纪.zip」 */
  zipFileName: string;
  /** 主线条目在前（按 index 升序），外传在后（按外传顺序，各自按 index 升序） */
  files: PackFile[];
  /** files 的正文字符数合计 */
  totalChars: number;
  /** 被跳过的章节数（草稿被 doneOnly 排除 + 空章节） */
  skipped: number;
}

/** 只做计划：不生成文件内容，供导出面板即时渲染（同步、快） */
export function planChapterPack(
  novel: Novel,
  chapters: Chapter[],
  sideStories: SideStory[],
  options: PackOptions,
): PackPlan;

/** 按计划生成各章内容并打包 zip（异步：zip 压缩是异步的） */
export function buildChapterPackZip(plan: PackPlan, now?: Date): Promise<Uint8Array>;
```

命名与目录规则（写死）：

- zip 根文件夹 = `bookTitle`；主线的章直接放在根下：`归墟纪/第001章 离乡.txt`。
- 外传各一个子文件夹：`归墟纪/外传·青冥旧事/第001章 拜师.pdf`（文件夹名用 `sideStoryLabel(story)`，空标题回退 `外传`）。
- 章号补零：每条线内按**实际导出的最大 index** 取 `max(3, 位数)` 位补零，如 `第001章`、`第0123章`，保证字典序 = 章序；同一线内 index 唯一，不会撞名。
- 标题为空时文件名就是 `第001章.txt`；标题需要净化：去掉 `\ / : * ? " < > |` 与 CR/LF/制表/其它控制字符，trim 掉首尾空白与结尾的 `.`（Windows 兼容），超过 40 个字符截断。
- 扩展名只由该章格式决定，四条线各自可以不同。
- 跳过规则与现有导出保持一致：`content.trim() === ''` 的章节一律不导出（即使 `doneOnly` 为 false）；`doneOnly` 为 true 时 `status !== 'done'` 也跳过；两类都计入 `skipped`。
- 没有可导出章节时 `files` 为空、`zipFileName` 仍按书名生成，UI 禁用按钮。
- `buildChapterPackZip` 内容：
  - `txt` / `markdown`：直接复用 `exportText.ts` 的 `formatChapter(chapter, 'txt' | 'markdown', sideStory)`（外传章节标题带「外传·X」前缀，与现有单章导出一致）。
  - `rtf` / `pdf`：`{ title: chapterHeading(chapter, sideStory), subtitle: novel.title.trim(), paragraphs: content.trim().split(/\r?\n/u) }`（空正文给空数组）。`rtf` 走 `renderRtfDocument`，`pdf` 走 `renderChapterPdf`。
  - 交给 `createZip` 的条目顺序 = `plan.files` 顺序（所以 UI 列表看到的顺序就是压缩包内顺序）。
  - 注意 `PackPlan` 里只有 `chapterId`/`name`/`path`/`format`/`chars`，**内容生成时按 `chapterId` 回查**：因此 `planChapterPack` 之外还需要拿到章节与外传（build 直接接收的是 plan，没有章节对象）。实现方式自定，但契约不变：`buildChapterPackZip(plan)` 必须能生成内容。建议 `PackPlan` 内部持有 `files: PackFile[]` 之外再加一个不导出到 UI 的私有快照（用模块内 WeakMap 或 `PackPlan` 增加可选字段都可以，注意导出类型整洁）。**推荐**：`PackPlan` 增加一个可选 `readonly source?: { novel: Novel; chaptersById: ReadonlyMap<string, Chapter>; sideStoriesById: ReadonlyMap<string, SideStory> }`，`planChapterPack` 填上，`buildChapterPackZip` 用它；UI 不读它。
- 生成失败（如 PDF 布局异常）应让 Promise reject，由 UI 提示重试；不要静默吞掉。

## 4. PDF 方案验证记录（为什么是这套）

本机实测（macOS CoreGraphics `sips` 渲染 + pdfium `pypdfium2` 渲染，均为 2026-10 在本仓库外做的原型）：

1. **非嵌入 CID 字体可用**：`STSong-Light` + `UniGB-UCS2-H` / `UniGB-UTF16-H` 的 PDF 在本机 CoreGraphics 与 pdfium 上中文都能正常显示，文本也能被 MuPDF 正确提取。
2. **但 GBK 覆盖范围外的字会被阅读器替换成错误字形**：`㵘`（U+3D58，Adobe-GB1 有 CID 但跨 supplement）在 macOS 上显示为「獒」，`䶮`、`㛃` 等同理；非 BMP 字符（`𠀀`、emoji）会显示成两个随机汉字或空白。**因此必须按 GBK 覆盖表把范围外的字替换为 `□`**，不能只处理非 BMP。
3. **嵌入字体 / 位图两条路都排除**：嵌入开源中文字体要给仓库加数 MB 字体文件并自己实现 TTF/CFF 子集化，还要处理缺字回退；整页位图会把一本 30 万字的书画成几十 MB 的 zip。GBK 覆盖表 1.3 KB、PDF 单章约 5–15 KB，收益/成本最优。
4. 已知限制（文档要如实写）：PDF 里超出 GBK 的扩展区生僻字与 emoji 显示为 `□`；要原样保留请选 TXT / MD / RTF。PDF 的字体由阅读器自备，排版观感（宋体/黑体替换）随阅读器而定。
5. **`CompressionStream('deflate-raw')` 在 Node 22.18（测试环境）与目标浏览器可用**；老浏览器回退 store。

## 5. 导出面板（`ExportSheet.tsx`）行为契约

现有单文件导出保持原样。新增「打包」范围：

- 「范围」分段控件选项变成：`全书 / 单章 / 外传? / 打包`（外传仅在有外传时出现；顺序按此）。
- 选中「打包」时：
  - `默认格式` 分段控件：`Markdown / 纯文本 / RTF / PDF`，默认 **纯文本**（`'txt'`）。切换默认格式只影响没被单独改过的章。
  - 「只导出已完成的章节」（复用现有 `doneOnly`）与「附带外传」（复用现有 `withSideStories`，仅在有外传时出现）。
  - 文件列表（`max-h` 可滚动）：每行 = 文件相对路径去掉书名前缀（主线 `第001章 离乡`，外传 `外传·青冥旧事/第001章 拜师`）+ 一个原生 `<select aria-label="{行名} 格式">`，选项 `Markdown / 纯文本 / RTF / PDF`；改动即写 `formats[chapterId]` 覆盖。任何覆盖存在时显示一个次要按钮「全部改用默认格式」清空覆盖。
  - 统计行：`共 N 个文件 · 约 M 字`；`skipped > 0` 时再显示 `另有 K 章未包含（草稿或空章节）`。
  - 若列表里任一文件是 PDF，显示提示：`PDF 使用阅读器自带字体，超出 GBK 的生僻字与 emoji 会显示为 □；要原样保留请选 TXT/MD/RTF。`
  - 底部按钮只剩一个主按钮 `下载压缩包`；构建中禁用并显示 `正在打包…`；成功后 toast `已导出 {zipFileName}`，失败 `打包失败，请重试`。打包模式下不显示「复制」按钮（zip 无法复制）。
  - 没有可导出章节时显示 `没有可导出的章节。`，按钮禁用。
- 面板 `description` 按范围切换：打包模式为 `每章一个文件，格式逐个可选，下载时打包成 zip。`，其它保持原文案。
- 面板打开时的默认范围逻辑保持现状（指定单章 → 单章；主线有章 → 全书；只有外传 → 外传），不要默认进「打包」。
- 状态都留在组件内；`ExportSheet` 的 props 不变。

## 6. 测试要求

- **gbkCoverage**：常见字/标点/全角/拼音字母保留；`㵘`、`䶮`、`✔`、emoji、`𠮷` 替换为 `□`；换行/空白不动；覆盖表边界段（每段首尾码位）判定正确；非 BMP 一律替换。
- **rtf**：纯 ASCII 输出；以 `{\rtf1` 开头、`}` 结尾；标题加粗居中；特殊字符转义；`\uN` 正负号规则（如 U+4E00 → `\u19968?`，U+FFFD(65533) → `\u-3?`）；代理对输出两个 `\uN?`；空行；**与 `extractRtfText` 的往返**（标题/副标题/多段/空行/中英文数字混排）。
- **pdf**：文件头 `%PDF-`、结尾 `%%EOF`；解析 `xref` 每个偏移确实指向对应 `N 0 obj`；`/Count` 等于页对象数；每页有 `MediaBox`；正文十六进制解码后包含标题与首段；非 GBK 字符变成 `□`；长章（如 3000 字）至少 2 页；空正文 1 页；标题超宽折行；`/ToUnicode` 存在；内容流与 `/Length` 一致。测试里自己写几十行轻量解析（不要把 PDF 再交给外部库）。
- **zip**：local/central 签名与字段；UTF-8 标志位；CRC32 与标准向量一致（`'123456789'` → `0xCBF43926`）；中文路径；store 与 deflate 两条路径都用 `DecompressionStream`（测试环境可用）解回原数据；固定 `now` 后字节确定性；空数据；条目顺序。
- **chapterPack**：主线/外传顺序与补零（含 >999 章用 4 位）；标题净化/截断/空标题；`doneOnly` 与空章节跳过计数；外传开关；逐章格式覆盖；空文件列表；`zipFileName`/`bookTitle` 回退「未命名作品」；生成 zip 后解压回读（用 DecompressionStream + 自带解析）验证每个文件内容含正确标题/正文、扩展名与格式一致；txt/md 与现有 `formatChapter` 输出一致；rtf 可被 `extractRtfText` 解回。
- **ExportSheet.pack.test.tsx**：切到打包默认纯文本、默认格式切换影响未覆盖章、逐章 select 覆盖只改那一章、重置覆盖、附带外传/只导出完成、空列表禁用、下载时拿到以 `PK` 开头的字节（现有测试文件用 anchor click + data URL 的方式拦截，沿用它）与正确文件名、打包中状态、失败提示（可 mock `buildChapterPackZip` 模块）。不要改动现有 `ExportSheet.test.tsx` 的既有用例。
- **download.test.ts**：`saveBinaryFile` 的 blob 路径（mock `URL.createObjectURL`）与 `data:...;base64` 回退路径、MIME、文件名；`saveTextFile` 原行为不回归。

## 7. 文档计划

- `docs/产品文档.md` 6.7：正文导出补「分章打包」一段（范围/默认格式/逐章格式/附带外传/zip 结构与文件名规则/跳过规则），以及一段「为什么 PDF 用阅读器字体、超出 GBK 显示 □」的产品解释。
- `docs/使用说明.md` 8.1：操作步骤、四种格式各自适合什么、zip 内部结构示例（代码块）、逐章改格式怎么改、PDF 限制与建议。
- `docs/开发计划.md` 末尾追加「增量：分章导出与整本压缩包」：需求、文件改动表、关键实现决定（零依赖 zip、非嵌入 CID 字体、GBK 净化、补零与目录规则、逐章格式覆盖）、验证结果（typecheck / 测试数 / 构建 / 手工渲染验证）。测试数等 Lead 在最终验证后补。
- 三份文档都要与实际实现/界面文案一致；不写没实现的东西。

## 8. 验收标准

1. `npm run typecheck` 通过；`npm run test:run` 全绿（预期新增 ≥ 120 条测试）；`npm run build` 通过。
2. 手工产物验证：用脚本生成 3 章样例（txt/md/rtf/pdf 混合 + 外传）→ zip 用系统 `unzip -t` 校验；PDF 用 pdfium/CoreGraphics 渲成 PNG 目视检查中文、分页、页码、标题；RTF 能被 `extractRtfText` 读回。
3. 现有导出/备份/导入测试全部不回归；git diff 只含本设计列出的文件与文档。
4. 界面文案、文档、实现三者一致；面板在窄屏（28rem 抽屉）下可用。
