/**
 * 生成 PWA 图标（PNG）与 SVG 图标，不依赖任何第三方图形库。
 *
 * 直接用 zlib 手写最小 PNG 编码器：既避免引入依赖（阶段一要求零第三方脚本、
 * 依赖面尽量小），也保证图标产物可复现。
 *
 * 用法：node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../public');
mkdirSync(publicDir, { recursive: true });

// ---------- 最小 PNG 编码器 ----------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** rgba: Uint8Array，长度 = w * h * 4 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前置 filter byte 0（None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 图形定义（单位坐标系 0..1，便于任意尺寸复用）----------

const INK = [17, 24, 39]; // #111827 背景（墨色）
const PAPER = [248, 250, 252]; // #f8fafc 纸色
const ACCENT = [245, 158, 11]; // #f59e0b 朱砂/落款色

/** 圆角矩形的有向距离（负值表示在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 线段的有向距离 */
function sdSegment(px, py, ax, ay, bx, by, halfWidth) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)));
  return Math.hypot(apx - abx * t, apy - aby * t) - halfWidth;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/**
 * 图标造型：墨色圆角底 + 一撇竖向笔画（书写的「一竖」）+ 两道横画 + 朱砂落款点。
 * 抽象表达「在纸上写字」，不含任何文字字形，避免依赖字体栅格化。
 */
function shadeIcon(x, y) {
  // 背景：圆角方块铺满
  let color = INK;
  let alpha = 1;

  const bg = sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22);
  if (bg > 0) return [0, 0, 0, 0];

  // 竖向主笔画（略带倾斜，模拟运笔）
  const stroke = sdSegment(x, y, 0.38, 0.2, 0.46, 0.8, 0.052);
  // 两道横画
  const bar1 = sdSegment(x, y, 0.3, 0.36, 0.72, 0.33, 0.035);
  const bar2 = sdSegment(x, y, 0.32, 0.58, 0.68, 0.55, 0.035);
  // 朱砂落款
  const seal = sdCircle(x, y, 0.71, 0.74, 0.075);

  const paperShape = Math.min(stroke, bar1, bar2);

  if (seal < 0) {
    color = ACCENT;
    alpha = 1;
  } else if (paperShape < 0) {
    color = PAPER;
    alpha = 1;
  } else {
    return [...INK, 255];
  }

  return [...color, Math.round(alpha * 255)];
}

function render(size) {
  const ss = 3; // 3x3 超采样做抗锯齿
  const rgba = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const [cr, cg, cb, ca] = shadeIcon(x, y);
          const w = ca / 255;
          r += cr * w;
          g += cg * w;
          b += cb * w;
          a += ca;
        }
      }
      const n = ss * ss;
      const aAvg = a / n;
      const wsum = aAvg / 255 || 1;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r / n / wsum);
      rgba[i + 1] = Math.round(g / n / wsum);
      rgba[i + 2] = Math.round(b / n / wsum);
      rgba[i + 3] = Math.round(aAvg);
    }
  }
  return encodePng(size, size, rgba);
}

for (const size of [192, 512]) {
  writeFileSync(resolve(publicDir, `icon-${size}.png`), render(size));
  console.log(`generated public/icon-${size}.png`);
}

// maskable 图标：同造型但留出安全边距（内容缩到 80%），避免被系统裁切
function renderMaskable(size) {
  const ss = 3;
  const rgba = new Uint8Array(size * size * 4);
  const inset = 0.1;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          // 把采样点映射回内容区
          const cx = (x - inset) / (1 - 2 * inset);
          const cy = (y - inset) / (1 - 2 * inset);
          let sample;
          if (cx < 0 || cx > 1 || cy < 0 || cy > 1) {
            sample = [...INK, 255];
          } else {
            const s = shadeIcon(cx, cy);
            sample = s[3] === 0 ? [...INK, 255] : s;
          }
          r += sample[0];
          g += sample[1];
          b += sample[2];
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

writeFileSync(resolve(publicDir, 'icon-maskable-512.png'), renderMaskable(512));
console.log('generated public/icon-maskable-512.png');

// 同造型的 SVG（浏览器标签页用，矢量更清晰）
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#111827"/>
  <g stroke="#f8fafc" stroke-linecap="round" fill="none">
    <path d="M38 20 L46 80" stroke-width="10.4"/>
    <path d="M30 36 L72 33" stroke-width="7"/>
    <path d="M32 58 L68 55" stroke-width="7"/>
  </g>
  <circle cx="71" cy="74" r="7.5" fill="#f59e0b"/>
</svg>
`;
writeFileSync(resolve(publicDir, 'icon.svg'), svg);
console.log('generated public/icon.svg');
