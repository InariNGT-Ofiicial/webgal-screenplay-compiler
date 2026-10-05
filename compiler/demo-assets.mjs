/**
 * demo-assets.mjs —— 占位背景与立绘（**纯 Node 手写 PNG**）
 *
 * 为什么自己编码 PNG、不启浏览器：本机 Chromium 冷启动 4 分半，十几张图就超时了。
 * 所以这里直接用 `node:zlib` 的 deflateSync 手写 IHDR/IDAT/IEND 分块 + CRC32。
 * 零依赖、零美术资源，且**产物可复现**（任何人跑出来的像素都一样）。
 *
 * 产出（写进 `webgal-tool/dist/game/`）：
 *   背景 17 张 1920x1080 —— 见下面的 `BGS` 表，
 *     ★ **必须与 `bg-rules.mjs` 的目标名同名对齐**，对不上的后果是画面静默空白
 *   立绘 750x1334 —— 角色由 `mainline/cast.json` 决定，一个角色一张（含名牌）
 *
 * ★ 写盘位置在 `webgal-tool/dist/`，那是上游 WebGAL 发行版的地盘；
 *   没放发行版时本脚本会先 mkdir 出来。**别把它的输出当仓库内容提交。**
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_BG = path.join(ROOT, 'webgal-tool', 'dist', 'game', 'background');
const OUT_FIG = path.join(ROOT, 'webgal-tool', 'dist', 'game', 'figure');

// ═══════════════════════════════════════════════════════════════════════════
//  §1 Canvas：软件光栅化 + PNG 编码
// ═══════════════════════════════════════════════════════════════════════════

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 4);
  }
  set(x, y, c, a = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4;
    if (a >= 1) {
      this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2]; this.px[i + 3] = 255;
      return;
    }
    const k = this.px[i + 3] / 255;
    const na = a + k * (1 - a);
    if (na <= 0) return;
    this.px[i] = (c[0] * a + this.px[i] * k * (1 - a)) / na;
    this.px[i + 1] = (c[1] * a + this.px[i + 1] * k * (1 - a)) / na;
    this.px[i + 2] = (c[2] * a + this.px[i + 2] * k * (1 - a)) / na;
    this.px[i + 3] = na * 255;
  }
  rect(x0, y0, w, h, c, a = 1) {
    for (let y = Math.max(0, y0 | 0); y < Math.min(this.h, (y0 + h) | 0); y++) {
      for (let x = Math.max(0, x0 | 0); x < Math.min(this.w, (x0 + w) | 0); x++) this.set(x, y, c, a);
    }
  }
  rectGrad(x0, y0, w, h, cTop, cBot) {
    for (let y = Math.max(0, y0 | 0); y < Math.min(this.h, (y0 + h) | 0); y++) {
      const t = (y - y0) / Math.max(1, h);
      const c = [cTop[0] + (cBot[0] - cTop[0]) * t, cTop[1] + (cBot[1] - cTop[1]) * t, cTop[2] + (cBot[2] - cTop[2]) * t];
      for (let x = Math.max(0, x0 | 0); x < Math.min(this.w, (x0 + w) | 0); x++) this.set(x, y, c);
    }
  }
  ellipse(cx, cy, rx, ry, c, a = 1, rot = 0) {
    const co = Math.cos(-rot), si = Math.sin(-rot);
    const R = Math.ceil(Math.max(rx, ry)) + 2;
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(this.h - 1, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(this.w - 1, Math.ceil(cx + R)); x++) {
        const dx = x - cx, dy = y - cy;
        const lx = dx * co - dy * si, ly = dx * si + dy * co;
        if ((lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1) this.set(x, y, c, a);
      }
    }
  }
  circle(cx, cy, r, c, a = 1) { this.ellipse(cx, cy, r, r, c, a); }
  /** 二次贝塞尔曲线（用折线近似，避免依赖曲率公式） */
  curve(x0, y0, cx1, cy1, x1, y1, c, w = 3, a = 1) {
    const n = Math.ceil(Math.hypot(cx1 - x0, cy1 - y0) * 3) + 8;
    let px = x0, py = y0;
    for (let i = 1; i <= n; i++) {
      const t = i / n, mt = 1 - t;
      const x = mt * mt * x0 + 2 * mt * t * cx1 + t * t * x1;
      const y = mt * mt * y0 + 2 * mt * t * cy1 + t * t * y1;
      this.line(px, py, x, y, c, w, a);
      px = x; py = y;
    }
  }
  line(x0, y0, x1, y1, c, w = 2, a = 1) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    const steps = Math.ceil(len * 2), r = w / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.ellipse(x0 + dx * t, y0 + dy * t, r, r, c, a);
    }
  }
  poly(pts, c, a = 1) {
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(this.h - 1, Math.ceil(maxY)); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a1 = pts[i], b1 = pts[(i + 1) % pts.length];
        if (a1[1] === b1[1]) continue;
        if ((y <= a1[1] && y > b1[1]) || (y <= b1[1] && y > a1[1])) {
          xs.push(a1[0] + ((y - a1[1]) / (b1[1] - a1[1])) * (b1[0] - a1[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.max(0, Math.round(xs[i])); x <= Math.min(this.w - 1, Math.round(xs[i + 1])); x++) this.set(x, y, c, a);
      }
    }
  }
  toPNG() {
    const { w, h, px } = this;
    const stride = w * 4;
    const raw = Buffer.alloc((stride + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (stride + 1)] = 0;
      px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
    ]);
  }
  save(f) { writeFileSync(f, this.toPNG()); return f; }
}

let CRC = null;
function crc32(buf) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

// ═══════════════════════════════════════════════════════════════════════════
//  §2 背景 1920x1080
// ═══════════════════════════════════════════════════════════════════════════

const BW = 1920, BH = 1080;

function label(c, x, y, w, h) {
  c.rect(x, y, w, h, hex('#000000'), 0.45);
  c.rect(x + 30, y + h / 2 - 11, w * 0.4, 22, hex('#ffffff'), 0.8);
  c.rect(x + 30 + w * 0.4 + 18, y + h / 2 - 11, w * 0.22, 22, hex('#ffffff'), 0.55);
}

function bgHospital() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 760, hex('#c8d4d8'), hex('#e4eaea'));
  c.rectGrad(0, 760, BW, 320, hex('#b8bcbe'), hex('#9aa0a4'));
  // 输液架与监护仪
  c.rect(1420, 300, 14, 460, hex('#8898a0'));
  c.rect(1370, 760, 130, 26, hex('#8898a0'));
  c.rect(1330, 700, 180, 60, hex('#2c3a42'));
  c.rect(1342, 712, 60, 36, hex('#5ad0a0'));
  c.curve(1434, 320, 1500, 380, 1430, 500, hex('#cfd8dc'), 5);
  // 病床
  c.rect(1180, 700, 420, 130, hex('#e8ecee'));
  c.rect(1180, 830, 420, 40, hex('#b0b8bc'));
  c.rect(1200, 640, 380, 62, hex('#f4f6f8'));
  label(c, 60, 960, 420, 90);
  return c;
}

function bgHall() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 700, hex('#1a1418'), hex('#2a1e24'));
  // 观众席
  for (let r = 0; r < 5; r++) {
    c.rect(0, 700 + r * 76, BW, 60, hex('#241a20'), 0.7);
  }
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 26; i++) {
      c.circle(40 + i * 74 + (r % 2) * 30, 730 + r * 76, 20, hex('#3a2a32'), 0.55);
    }
  }
  // 舞台与桁架
  c.rect(0, 380, BW, 130, hex('#3a2c34'));
  c.rect(0, 500, BW, 16, hex('#54424c'));
  for (let i = 0; i < 10; i++) {
    c.rect(120 + i * 190, 180, 26, 210, hex('#4a3a44'));
    c.circle(133 + i * 190, 170, 26, hex('#f0e6d0'), 0.85);
  }
  // 穹顶裂口
  c.poly([[820, 0], [1180, 0], [1080, 150], [920, 130]], hex('#0a0810'));
  c.poly([[860, 20], [960, 30], [900, 120]], hex('#3a2a20'), 0.6);
  label(c, 60, 940, 400, 90);
  return c;
}

function bgSafeHouse() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 780, hex('#2a2f36'), hex('#1a1e24'));
  c.rectGrad(0, 780, BW, 300, hex('#22262c'), hex('#15181c'));
  // 混凝土墙纹理
  for (let i = 0; i < 7; i++) c.line(0, 120 + i * 96, BW, 120 + i * 96, hex('#20242a'), 3, 0.5);
  // 服务器架
  for (let k = 0; k < 3; k++) {
    const x = 180 + k * 200;
    c.rect(x, 380, 150, 400, hex('#1a1e22'));
    c.rect(x + 8, 390, 134, 380, hex('#14171a'));
    for (let i = 0; i < 9; i++) {
      c.rect(x + 16, 400 + i * 42, 118, 30, hex('#22262b'));
      c.circle(x + 26, 415 + i * 42, 5, hex('#5ad0a0'), 0.9);
      c.rect(x + 40, 408 + i * 42, 70, 14, hex('#2a3038'), 0.8);
    }
  }
  // 应急灯
  c.rect(880, 120, 160, 16, hex('#3a4048'));
  c.rect(890, 136, 140, 60, hex('#f0d8a0'), 0.16);
  // 折叠桌与地图
  c.rect(1080, 720, 620, 40, hex('#4a4038'));
  c.rect(1120, 660, 520, 60, hex('#2a3a44'));
  c.rect(1130, 668, 500, 44, hex('#3a5060'));
  label(c, 60, 940, 400, 90);
  return c;
}

function bgManor() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 720, hex('#1a2420'), hex('#2a3630'));
  c.rectGrad(0, 720, BW, 360, hex('#22282a'), hex('#14181a'));
  // 庄园建筑
  c.rect(320, 260, 1280, 460, hex('#2a3238'));
  c.poly([[280, 270], [960, 90], [1640, 270]], hex('#1c2226'));
  for (let i = 0; i < 7; i++) {
    for (let r = 0; r < 3; r++) {
      const lit = (i * 3 + r) % 4 === 0;
      c.rect(400 + i * 168, 330 + r * 130, 96, 84, lit ? hex('#c8b070') : hex('#141a1e'), lit ? 0.55 : 1);
    }
  }
  c.rect(900, 580, 120, 140, hex('#3a2a20'));
  // 铁艺栅栏
  for (let i = 0; i < 40; i++) {
    c.rect(20 + i * 48, 700, 12, 120, hex('#14181a'));
    c.rect(6 + i * 48, 690, 40, 12, hex('#14181a'));
  }
  label(c, 60, 950, 420, 90);
  return c;
}

function bgUnderground() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, BH, hex('#141a1e'), hex('#0c1014'));
  // 走廊透视
  const vx = 960, vy = 460;
  for (let i = 0; i < 8; i++) {
    const s = i / 8;
    const w2 = 900 * (1 - s * 0.82);
    const h2 = 560 * (1 - s * 0.82);
    c.rect(vx - w2 / 2, vy - h2 / 2, w2, h2, hex('#1a2228'), 0.14 + s * 0.1);
  }
  // 管道
  for (let i = 0; i < 5; i++) {
    const y = 180 + i * 60;
    c.line(0, y, BW, y + (i - 2) * 30, hex('#2a3238'), 14, 0.6);
  }
  // 应急灯
  for (let i = 0; i < 4; i++) {
    const x = 240 + i * 480;
    c.rect(x, 300, 60, 14, hex('#3a444c'));
    c.circle(x + 30, 330, 90, hex('#e8c070'), 0.10);
  }
  c.rect(vx - 130, vy - 130, 260, 260, hex('#1a2228'), 0.6);
  label(c, 60, 950, 420, 90);
  return c;
}

function bgLibrary() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 800, hex('#241f1a'), hex('#16130f'));
  c.rectGrad(0, 800, BW, 280, hex('#1c1814'), hex('#100d0a'));
  // 书架墙
  for (let s = 0; s < 3; s++) {
    const x0 = 80 + s * 620;
    for (let r = 0; r < 6; r++) {
      c.rect(x0, 140 + r * 104, 520, 14, hex('#2e2620'));
      for (let i = 0; i < 26; i++) {
        const h = 60 + ((i * 7) % 30);
        c.rect(x0 + 6 + i * 20, 140 + r * 104 - h, 15, h, hex(['#5a3a30', '#3a4a5a', '#4a4a30', '#5a4a30'][(i + r) % 4]), 0.85);
      }
    }
  }
  // 中央长桌
  c.rect(700, 700, 520, 50, hex('#3a2e26'));
  c.rect(730, 750, 24, 120, hex('#2a221c'));
  c.rect(1166, 750, 24, 120, hex('#2a221c'));
  c.rect(880, 660, 90, 40, hex('#c8b070'), 0.5);
  label(c, 60, 950, 400, 90);
  return c;
}

function bgHelicopter() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, BH, hex('#1a2228'), hex('#0e1418'));
  // 舱内壁
  c.rect(0, 0, BW, 300, hex('#232c34'));
  c.rect(0, 800, BW, 280, hex('#1a2228'));
  // 舷窗
  for (let i = 0; i < 3; i++) {
    c.ellipse(400 + i * 560, 480, 190, 150, hex('#2a3640'));
    c.ellipse(400 + i * 560, 480, 165, 128, hex('#0c1014'), 0.8);
  }
  // 仪表
  c.rect(820, 340, 280, 200, hex('#161c20'));
  c.rect(840, 360, 240, 160, hex('#0a1418'));
  for (let i = 0; i < 12; i++) {
    c.rect(860 + (i % 6) * 36, 380 + Math.floor(i / 6) * 60, 26, 40, hex('#2ad0a0'), 0.5);
  }
  label(c, 60, 950, 400, 90);
  return c;
}

function bgCorridor() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 820, hex('#384048'), hex('#242a30'));
  c.rectGrad(0, 820, BW, 260, hex('#2a3038'), hex('#1a1e24'));
  for (let i = 0; i < 4; i++) {
    const x = 160 + i * 440;
    c.rect(x, 140, 320, 520, hex('#3a4650'));
    c.rect(x + 20, 170, 280, 460, hex('#6a8898'));
  }
  for (let i = 0; i < 4; i++) {
    c.poly([[160 + i * 440, 660], [480 + i * 440, 660], [560 + i * 440, 1080], [80 + i * 440, 1080]], hex('#f0e8d0'), 0.10);
  }
  for (let i = 0; i < 4; i++) c.line(0, 860 + i * 45, BW, 860 + i * 45, hex('#1a1e24'), 2, 0.4);
  label(c, 60, 950, 380, 90);
  return c;
}

function bgStage() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 640, hex('#120c14'), hex('#241830'));
  c.rectGrad(0, 640, BW, 440, hex('#1a1420'), hex('#0c0810'));
  // 舞台地板
  c.poly([[400, 700], [1520, 700], [1780, 1080], [140, 1080]], hex('#2a2030'));
  for (let i = 0; i < 10; i++) c.line(400 + i * 112, 700, 140 + i * 164, 1080, hex('#1a1420'), 2, 0.5);
  // 灯架与光柱
  c.rect(0, 60, BW, 26, hex('#0e0a10'));
  for (let i = 0; i < 7; i++) {
    const x = 180 + i * 260;
    c.rect(x - 20, 86, 40, 26, hex('#2a2430'));
    c.poly([[x - 18, 112], [x + 18, 112], [x + 210, 900], [x - 210, 900]], hex('#e0d0f0'), 0.045);
  }
  // 屏幕
  c.rect(660, 180, 600, 340, hex('#0a0810'));
  c.rect(674, 194, 572, 312, hex('#1a1428'));
  label(c, 60, 960, 400, 90);
  return c;
}

/** 城市夜景 —— 商业区 / 跨海大桥 / 夜色 */
function bgCity() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 700, hex('#0e1420'), hex('#1a2436'));
  // 楼群剪影
  const seed = [0.72, 0.88, 0.6, 0.95, 0.78, 1.0, 0.66, 0.9, 0.74, 0.84, 0.62, 0.92];
  for (let i = 0; i < 12; i++) {
    const w = 150, x = i * 160 - 40, h = 700 * seed[i];
    c.rect(x, 700 - h, w, h, hex('#141c2a'));
    // 窗
    for (let r = 0; r < Math.floor(h / 46); r++) {
      for (let k = 0; k < 4; k++) {
        if ((i * 7 + r * 3 + k) % 5 === 0) continue;
        c.rect(x + 16 + k * 34, 700 - h + 20 + r * 46, 20, 28, hex('#e8d090'), 0.35 + ((i + r) % 3) * 0.15);
      }
    }
  }
  // 道路与车流
  c.rectGrad(0, 700, BW, 380, hex('#1e2836'), hex('#0c1018'));
  for (let i = 0; i < 5; i++) c.line(0, 750 + i * 70, BW, 730 + i * 70, hex('#2a3648'), 3, 0.6);
  for (let i = 0; i < 22; i++) {
    const x = (i * 91) % BW, y = 760 + (i % 5) * 70;
    c.rect(x, y, 46, 12, i % 3 === 0 ? hex('#e05a5a') : hex('#f0e0a0'), 0.55);
  }
  // 霓虹灯牌
  for (let i = 0; i < 6; i++) {
    const x = 120 + i * 300, y = 480 + (i % 3) * 70;
    c.rect(x, y, 90, 26, hex(['#e0508a', '#50c8e0', '#e0c050', '#8a50e0'][i % 4]), 0.5);
  }
  label(c, 60, 960, 400, 90);
  return c;
}

/** 废墟 / 残骸 —— 恐袭现场、坍塌建筑、战后 */
function bgRuin() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 620, hex('#2a1e1a'), hex('#3a2a22'));
  c.rectGrad(0, 620, BW, 460, hex('#241a16'), hex('#140e0c'));
  // 断裂柱
  for (let i = 0; i < 7; i++) {
    const x = 90 + i * 280, h = 260 + ((i * 37) % 160);
    c.poly([[x, 620], [x + 90, 620], [x + 84, 620 - h], [x + 40, 620 - h - 40], [x, 620 - h + 20]], hex('#3a2e28'));
    c.poly([[x + 40, 620 - h - 40], [x + 84, 620 - h], [x + 60, 620 - h + 30]], hex('#2a201c'));
  }
  // 瓦砾堆
  for (let i = 0; i < 60; i++) {
    const x = (i * 137) % BW, y = 640 + ((i * 83) % 300);
    c.ellipse(x, y, 16 + (i % 3) * 8, 9 + (i % 2) * 5, hex(['#3e322a', '#4a3c32', '#322821'][i % 3]), 0.85);
  }
  // 倾斜钢梁
  c.line(180, 620, 620, 300, hex('#4a4038'), 12, 0.8);
  c.line(1400, 620, 980, 260, hex('#4a4038'), 10, 0.8);
  // 烟尘
  for (let i = 0; i < 5; i++) {
    c.ellipse(300 + i * 340, 420 - (i % 2) * 90, 200, 110, hex('#5a4a3e'), 0.07);
  }
  // 应急灯
  c.circle(1520, 300, 120, hex('#e8b050'), 0.09);
  label(c, 60, 950, 400, 90);
  return c;
}

/**
 * ★ 背景文件名用**正式命名**（`bg_*`），不用 `ph2_*` 占位前缀。
 *   这样美术出图后直接同名覆盖即可生效，零代码改动。
 */
/** 废弃仓库 / 水产加工厂 —— 「巨兽的尸骸」 */
function bgWarehouse() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 700, hex('#1e2428'), hex('#141a1c'));
  c.rectGrad(0, 700, BW, 380, hex('#1a1e22'), hex('#0e1114'));
  // 屋顶桁架
  for (let i = 0; i < 6; i++) {
    c.poly([[i * 340, 0], [i * 340 + 40, 0], [960, 300], [920, 300]], hex('#2a3034'), 0.7);
  }
  c.rect(0, 280, BW, 22, hex('#2a3034'));
  // 冷库门与锈蚀设备
  for (let k = 0; k < 2; k++) {
    const x = 200 + k * 900;
    c.rect(x, 380, 320, 340, hex('#2e3438'));
    c.rect(x + 24, 400, 272, 300, hex('#3a4246'));
    for (let i = 0; i < 4; i++) c.rect(x + 40, 430 + i * 70, 240, 12, hex('#4a5256'), 0.6);
  }
  // 锈蚀管线
  for (let i = 0; i < 4; i++) {
    c.line(0, 200 + i * 40, BW, 190 + i * 40, hex('#3a3028'), 12, 0.7);
  }
  // 地面积水
  c.ellipse(900, 940, 460, 90, hex('#2a3a40'), 0.4);
  c.ellipse(400, 1010, 300, 60, hex('#2a3a40'), 0.3);
  // 侧窗冷光
  for (let i = 0; i < 3; i++) {
    c.poly([[1100 + i * 240, 320], [1250 + i * 240, 320], [1300 + i * 240, 560], [1140 + i * 240, 560]], hex('#7a9aa8'), 0.12);
  }
  label(c, 60, 950, 420, 90);
  return c;
}

/** 日式住宅客厅 —— 示例角色F的家 */
function bgLivingroom() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 820, hex('#4a3c30'), hex('#332a22'));
  c.rectGrad(0, 820, BW, 260, hex('#3a2e24'), hex('#241c16'));
  // 大窗 + 雨
  c.rect(1050, 120, 700, 520, hex('#2a3038'));
  c.rect(1075, 145, 650, 470, hex('#1a2630'));
  for (let i = 0; i < 90; i++) {
    const x = 1080 + ((i * 71) % 640);
    const y = 150 + ((i * 137) % 450);
    c.line(x, y, x - 6, y + 26, hex('#8ab0c8'), 1.5, 0.32);
  }
  c.rect(1390, 120, 14, 520, hex('#4a3c30'));
  // 沙发
  c.rect(180, 660, 640, 200, hex('#5a4a58'));
  c.rect(200, 620, 600, 70, hex('#6a5a68'));
  c.rect(180, 840, 640, 40, hex('#3a2e38'));
  // 矮桌
  c.rect(880, 780, 320, 26, hex('#6a5240'));
  c.rect(900, 806, 20, 110, hex('#4a3a2c'));
  c.rect(1160, 806, 20, 110, hex('#4a3a2c'));
  // 电视
  c.rect(280, 300, 300, 200, hex('#1a1a1e'));
  c.rect(300, 320, 260, 160, hex('#2a3a44'));
  c.rect(310, 330, 240, 140, hex('#4a6a7a'), 0.35);
  // 暖灯
  c.circle(760, 60, 200, hex('#e8c880'), 0.08);
  label(c, 60, 950, 420, 90);
  return c;
}

/** 豪华公寓 / 游戏室 —— 示例角色K */
function bgApartment() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 860, hex('#2a2438'), hex('#1a1628'));
  c.rectGrad(0, 860, BW, 220, hex('#4a3a2a'), hex('#2a2018'));
  // 落地窗 + 港区夜景
  c.rect(0, 80, BW, 700, hex('#0e1420'));
  const seed = [0.7, 0.9, 0.62, 0.85, 0.75, 0.95, 0.68, 0.88, 0.72, 0.92, 0.66, 0.8];
  for (let i = 0; i < 12; i++) {
    const w = 150, x = i * 160, h = 620 * seed[i];
    c.rect(x, 780 - h, w - 20, h, hex('#141c2a'), 0.9);
    for (let r = 0; r < Math.floor(h / 50); r++) {
      for (let k = 0; k < 4; k++) {
        if ((i * 5 + r * 3 + k) % 4 === 0) continue;
        c.rect(x + 12 + k * 32, 780 - h + 18 + r * 50, 18, 26, hex('#e8d090'), 0.4);
      }
    }
  }
  // 窗框
  for (let i = 0; i <= 6; i++) c.rect(i * 320 - 8, 80, 16, 700, hex('#3a3050'));
  c.rect(0, 60, BW, 30, hex('#3a3050'));
  c.rect(0, 750, BW, 24, hex('#3a3050'));
  // 华丽吊灯
  c.circle(960, 40, 120, hex('#f0d890'), 0.16);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    c.circle(960 + Math.cos(a) * 90, 90 + Math.sin(a) * 34, 15, hex('#f0e0a0'), 0.6);
  }
  // 巨型棋盘（地面）
  c.poly([[560, 1080], [1360, 1080], [1520, 860], [400, 860]], hex('#3a3048'));
  for (let i = 0; i < 8; i++) {
    for (let k = 0; k < 4; k++) {
      if ((i + k) % 2) continue;
      const t0 = i / 8, t1 = (i + 1) / 8;
      const u0 = k / 4, u1 = (k + 1) / 4;
      const px = (t, u) => 400 + t * (1520 - 400) * (1 - u * 0.16) + u * (1120 * 0.16);
      const py = (u) => 1080 - u * 220;
      c.poly([[px(t0, u0), py(u0)], [px(t1, u0), py(u0)], [px(t1, u1), py(u1)], [px(t0, u1), py(u1)]], hex('#6a5a88'), 0.5);
    }
  }
  label(c, 60, 950, 420, 90);
  return c;
}

/** 货轮船舱 —— 远洋 */
function bgCabin() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 700, hex('#2a2620'), hex('#181512'));
  c.rectGrad(0, 700, BW, 380, hex('#242018'), hex('#100e0c'));
  // 肋骨式舱壁
  for (let i = 0; i < 9; i++) {
    const x = 40 + i * 230;
    c.rect(x, 120, 30, 640, hex('#3a342a'));
    c.rect(x - 8, 118, 46, 22, hex('#4a4234'));
  }
  // 管道
  for (let i = 0; i < 5; i++) {
    c.line(0, 200 + i * 52, BW, 190 + i * 52, hex('#4a3e30'), 16, 0.75);
  }
  // 舱顶灯
  for (let i = 0; i < 4; i++) {
    const x = 240 + i * 500;
    c.rect(x - 70, 60, 140, 22, hex('#3a342a'));
    c.circle(x, 100, 110, hex('#e8d0a0'), 0.10);
  }
  // 机械剪影
  for (let i = 0; i < 3; i++) {
    const x = 300 + i * 620;
    c.rect(x, 560, 200, 240, hex('#2e281e'));
    c.rect(x + 20, 580, 160, 60, hex('#3a3428'));
    c.ellipse(x + 100, 560, 74, 26, hex('#3e382c'));
  }
  // 锈迹
  for (let i = 0; i < 30; i++) {
    c.ellipse((i * 191) % BW, 300 + ((i * 97) % 400), 30 + (i % 4) * 14, 16, hex('#4a3424'), 0.28);
  }
  label(c, 60, 950, 400, 90);
  return c;
}

/** 破旧租赁屋 —— 清告的榻榻米房间 */
function bgRoom() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, 780, hex('#3a3228'), hex('#241e18'));
  c.rectGrad(0, 780, BW, 300, hex('#4a4030'), hex('#2a241a'));
  // 榻榻米格纹
  for (let i = 0; i < 8; i++) c.line(0, 800 + i * 35, BW, 800 + i * 35, hex('#3a3224'), 3, 0.6);
  for (let i = 0; i < 12; i++) c.line(i * 170, 780, i * 170 + 40, 1080, hex('#3a3224'), 3, 0.5);
  // 渗水霉斑天花板
  c.ellipse(700, 120, 220, 130, hex('#2a2418'), 0.5);
  c.ellipse(760, 150, 140, 80, hex('#3a3224'), 0.4);
  // 旧电视
  c.rect(1350, 620, 300, 220, hex('#1a1a1e'));
  c.rect(1370, 640, 260, 170, hex('#2a3a44'));
  for (let i = 0; i < 4; i++) c.rect(1380 + i * 62, 700 + (i % 2) * 40, 50, 30, hex('#8ab0c0'), 0.18);
  // 散落酒瓶
  for (let i = 0; i < 5; i++) {
    const x = 300 + i * 90, y = 900 + (i % 3) * 40;
    c.poly([[x, y], [x + 34, y], [x + 34, y + 90], [x, y + 90]], hex('#3a4a3a'), 0.8);
    c.rect(x + 10, y - 40, 14, 44, hex('#3a4a3a'), 0.8);
  }
  // 门
  c.rect(120, 420, 260, 380, hex('#2a2418'));
  c.rect(140, 440, 220, 340, hex('#5a5240'), 0.7);
  label(c, 60, 950, 400, 90);
  return c;
}

/** 黑屏 —— 死亡分支收束用（END 标记） */
function bgBlack() {
  const c = new Canvas(BW, BH);
  c.rectGrad(0, 0, BW, BH, hex('#07070a'), hex('#000000'));
  return c;
}

const BGS = [
  ['bg_black.png', bgBlack],
  ['bg_hospital.png', bgHospital],
  ['bg_hall.png', bgHall],
  ['bg_safehouse.png', bgSafeHouse],
  ['bg_manor.png', bgManor],
  ['bg_underground.png', bgUnderground],
  ['bg_library.png', bgLibrary],
  ['bg_helicopter.png', bgHelicopter],
  ['bg_corridor.png', bgCorridor],
  ['bg_stage.png', bgStage],
  ['bg_city.png', bgCity],
  ['bg_ruin.png', bgRuin],
  ['bg_warehouse.png', bgWarehouse],
  ['bg_room.png', bgRoom],
  ['bg_livingroom.png', bgLivingroom],
  ['bg_apartment.png', bgApartment],
  ['bg_cabin.png', bgCabin],
];

// ═══════════════════════════════════════════════════════════════════════════
//  §3 立绘 750x1334
// ═══════════════════════════════════════════════════════════════════════════

const FW = 750, FH = 1334;

/**
 * 角色立绘。按角色特征定制发型与配色（占位但可辨）。
 * 姓名用色块条表示——不依赖字体渲染。
 */
function figure(cfg) {
  const c = new Canvas(FW, FH);
  const cx = 375;
  const skin = hex(cfg.skin), hair = hex(cfg.hair), hairD = hex(cfg.hairDark);
  const uni = hex(cfg.uni), accent = hex(cfg.accent), eye = hex(cfg.eye);

  // ★ 剪影角色（未知声音）：纯黑轮廓 + 问号，明确「不知道是谁」
  if (cfg.silhouette) {
    c.poly([[128, FH], [162, 1000], [300, 936], [cx, 920], [450, 936], [588, 1000], [622, FH]], hex('#0a0a0e'));
    c.ellipse(375, 700, 158, 182, hex('#0a0a0e'));
    c.ellipse(375, 692, 178, 206, hex('#0a0a0e'));
    // 问号
    c.rect(cx - 34, 620, 68, 14, hex('#5a5a68'), 0.85);
    c.rect(cx + 20, 620, 14, 60, hex('#5a5a68'), 0.85);
    c.rect(cx - 6, 674, 14, 56, hex('#5a5a68'), 0.85);
    c.rect(cx - 6, 726, 14, 14, hex('#5a5a68'), 0.85);
    // 肩部轮廓线
    c.line(170, 1010, 300, 946, hex('#2a2a34'), 4, 0.6);
    c.line(580, 1010, 450, 946, hex('#2a2a34'), 4, 0.6);
    c.rect(232, 1190, 286, 62, hex('#000000'), 0.6);
    c.rect(cx - 26, 1210, 52, 12, hex('#5a5a68'), 0.8);
    return c;
  }

  // 身体（按角色裁剪的制服）
  c.poly([[128, FH], [162, 1000], [300, 936], [cx, 920], [450, 936], [588, 1000], [622, FH]], uni);
  c.poly([[128, FH], [162, 1000], [252, 952], [214, FH]], accent, 0.16);
  c.poly([[622, FH], [588, 1000], [498, 952], [536, FH]], accent, 0.16);
  c.poly([[300, 934], [cx, 1000], [450, 934], [420, 918], [cx, 960], [330, 918]], hex('#f4f4f6'));
  // 领饰
  c.poly([[cx, 1000], [336, 1032], [cx, 1054], [414, 1032]], accent);
  if (cfg.longHair) {
    // 长发角色：加两侧长发
    c.poly([[214, 640], [248, 690], [250, 980], [210, 1080], [190, 900]], hairD);
    c.poly([[536, 640], [502, 690], [500, 980], [540, 1080], [560, 900]], hairD);
  }
  // 脖子
  c.rect(342, 790, 66, 140, skin);
  c.ellipse(375, 926, 44, 24, skin);
  // 后发 + 脸
  c.ellipse(375, 692, 174, 202, hairD);
  c.ellipse(375, 700, 152, 178, skin);
  c.poly([[220, 656], [252, 690], [254, 812], [220, 884], [204, 796]], hairD);
  c.poly([[530, 656], [498, 690], [496, 812], [530, 884], [546, 796]], hairD);
  // 刘海（按 cfg.bang 换形）
  if (cfg.bang === 'long') {
    c.poly([[222, 626], [280, 520], [375, 500], [470, 520], [528, 626], [460, 596], [375, 616], [290, 596]], hair);
  } else if (cfg.bang === 'short') {
    c.poly([[230, 616], [310, 528], [375, 542], [440, 528], [520, 616], [462, 592], [375, 600], [288, 592]], hair);
  } else {
    c.poly([[226, 620], [300, 530], [375, 544], [450, 530], [524, 620], [470, 598], [420, 608], [375, 590], [330, 608], [280, 598]], hair);
  }
  c.poly([[226, 620], [375, 590], [300, 530]], hairD, 0.3);
  c.ellipse(332, 562, 56, 24, hex('#ffffff'), 0.15);
  // 眉（按 cfg.brow 表达性格）
  const brow = cfg.brow ?? 0;
  const by = 654 - brow;
  c.curve(292, by, 312, by - 9, 332, by + 2, hairD, 8);
  c.curve(458, by, 438, by - 9, 418, by + 2, hairD, 8);
  // 眼（按 cfg.eyeShape 变化）
  for (const ex of [312, 438]) {
    const dir = ex < cx ? 1 : -1;
    if (cfg.eyeShape === 'sharp') {
      c.poly([[ex - 28, 706], [ex + 28, 700], [ex + 24, 716], [ex - 24, 718]], hex('#ffffff'));
      c.circle(ex, 708, 15, eye);
    } else if (cfg.eyeShape === 'closed') {
      c.curve(ex - 26, 710, ex, 700, ex + 26, 710, hex('#3a2a30'), 6);
    } else {
      c.ellipse(ex, 708, 30, 30, hex('#ffffff'));
      c.circle(ex + dir * 2, 711, 16, eye);
      c.circle(ex - dir * 4, 702, 6, hex('#ffffff'), 0.92);
    }
  }
  // 腮红
  c.ellipse(272, 766, 32, 18, hex('#f49090'), 0.32);
  c.ellipse(478, 766, 32, 18, hex('#f49090'), 0.32);
  // 嘴
  c.curve(354, 794, 375, 800, 396, 794, hex('#8a4a48'), 7);
  // 名牌条
  c.rect(232, 1190, 286, 62, hex('#000000'), 0.55);
  for (let i = 0; i < 5; i++) c.rect(268 + i * 42, 1212, 30, 18, accent, 0.92);
  return c;
}

/**
 * ★ 立绘配置：从 mainline/cast.json 动态生成。
 *
 * 旧版是硬编码角色表；合订本动辄几十个说话人，硬编码不可维护。
 *
 * 配色由剧本转换时标注的 `color` 字段决定（在 docx-to-mainline.mjs 的 MAIN_CAST 里）。
 * ★ 2026-10-03 起 `color` 是**十六进制**（BD 既有角色用官方代表色），下面这张中文色名表
 *   只作为**旧标签的兜底**保留；两者都能吃，避免哪天又混用。
 * 发型 / 眼型 / 眉毛由 id 的字符和哈希决定，保证同色角色之间也有区分度。
 */
const COLOR_PAIRS = {
  金: ['#e8c86a', '#b89a3e'], 绿: ['#6ac88a', '#3e8a5a'], 灰: ['#8a8a90', '#6a6a70'],
  棕: ['#6a4a2a', '#3a2418'], 粉: ['#e8a0b8', '#c07090'], 紫: ['#6a4a7a', '#482f56'],
  白: ['#e8e0d0', '#b8b0a0'], 茶: ['#a08868', '#7a6448'], 黑: ['#4a4a52', '#2e2e34'],
  粉金: ['#e8c0a0', '#c09878'], 银: ['#c8c8d0', '#a0a0a8'], 深灰: ['#3a3a42', '#22222a'],
  军绿: ['#4a5a3a', '#2e3a24'], 灰蓝: ['#5a6a7a', '#3a4652'], 深蓝: ['#2a3a5a', '#1a2438'],
  藏蓝: ['#202a44', '#141a2c'], 红: ['#8a2a2a', '#5a1a1a'], 深绿: ['#2a4a3a', '#1a3024'],
};

/** hex → [底色, 暗部]。0.77 系数与原 COLOR_PAIRS 的明暗关系一致（占位图观感不变）。 */
function pairFromHex(hex) {
  const s = String(hex).replace('#', '');
  const r = parseInt(s.slice(0, 2), 16), g = parseInt(s.slice(2, 4), 16), b = parseInt(s.slice(4, 6), 16);
  const dim = (v) => Math.max(0, Math.round(v * 0.77)).toString(16).padStart(2, '0');
  return [`#${s.toLowerCase()}`, `#${dim(r)}${dim(g)}${dim(b)}`];
}

const castJson = JSON.parse(
  readFileSync(path.join(ROOT, 'compiler', 'mainline', 'cast.json'), 'utf8'),
);

const CAST = {};
for (const c of castJson) {
  // 旁白 / 音效 / 字幕不立绘（它们不发声或不是角色）
  if (c.id === 'narrator' || c.id === 'sfx' || c.id === 'subtitle') continue;

  // 未知声音 → 剪影 + 问号，必须与具名角色一眼区分
  if (c.id === 'unknown') {
    CAST[c.id] = {
      name: c.name, silhouette: true,
      hair: '#1c1c22', hairDark: '#0e0e12', skin: '#2a2a30',
      uni: '#141418', accent: '#3a3a44', eye: '#6a6a78',
    };
    continue;
  }

  // hex（BD 官方代表色）优先；旧的中文色名标签兜底
  const [hair, hairDark] = /^#[0-9a-fA-F]{6}$/.test(c.color || '')
    ? pairFromHex(c.color)
    : (COLOR_PAIRS[c.color] || COLOR_PAIRS['灰']);
  const h = [...c.id].reduce((a, ch) => a + ch.codePointAt(0), 0);
  CAST[c.id] = {
    name: c.name,
    hair, hairDark,
    skin: c.main ? '#ffe0d0' : '#e8d8c8',
    uni: c.main ? '#f4f4f8' : '#3a4048',
    accent: hairDark,
    eye: hairDark,
    longHair: h % 2 === 0,
    bang: h % 3 === 0 ? 'long' : 'short',
    brow: (h % 9) - 4,
    eyeShape: h % 5 === 0 ? 'sharp' : (h % 7 === 0 ? 'closed' : 'normal'),
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  §4 输出
// ═══════════════════════════════════════════════════════════════════════════

function main() {
  for (const d of [OUT_BG, OUT_FIG]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

  console.log('背景 1920x1080：');
  for (const [name, fn] of BGS) {
    const f = fn().save(path.join(OUT_BG, name));
    console.log('  ', name);
  }

  console.log('立绘 750x1334：');
  for (const [id, cfg] of Object.entries(CAST)) {
    figure(cfg).save(path.join(OUT_FIG, `${id}.png`));
    console.log(`   ${id}.png  ${cfg.name}`);
  }
  console.log('\n完成。角色名与背景对照见 SCENE-DEMO.md');
}

main();
