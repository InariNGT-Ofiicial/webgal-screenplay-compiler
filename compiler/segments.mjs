/**
 * segments.mjs —— 按**游戏里实际放映的长度**把剧本文本切成「配乐段落」
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  为什么必须这么切（2026-10-03 作者指正 "效果不行"）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  原来的配乐落点是**一幕一首**。实测下来不成立 —— 幕的长短差一个数量级：
 *    最短 `第1章 第二幕：示例短幕`  47 框 ≈ 1.7 分钟
 *    最长 `第5章 第四幕：示例长幕` 567 框 ≈ 21 分钟
 *  给 21 分钟的一幕配一首 126s 的曲子 = 循环 10 遍，中间所有情绪转折全丢掉。
 *  ⇒ **按放映长度切**，让「一次配乐」的覆盖时长与一首曲子的时长同量级。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  放映时长怎么算（可审计，不靠感觉）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  WebGAL 里**每一个 `:` 旁白 / `say:` 对白都是一个文本框，都要等玩家点一下**
 *  （`beats.json` 的一条 = 演出一框，见 `docx-to-mainline.mjs` 的 MAX_BOX 切分）。
 *  单框时长 ≈ max(打字机耗时, 玩家阅读耗时) + 点击间隔 —— 阅读通常占大头。
 *
 *    打字机：WebGAL 默认 `textSpeed = 50`，
 *            `useTextDelay(50) = 3 + (100-50) × 1.5 = 78 ms/字`
 *            （`hooks/useTextOptions.ts` + `store/userDataReducer.ts`）
 *    阅读：  8 字/秒（典型）；快 12 / 慢 5 —— 8 字/秒 = 125 ms/字 > 78，故阅读主导
 *    点击：  0.4 s
 *
 *  ⇒ 单框 ≈ 字数 ÷ 8 + 0.4（典型）。整本地跑下来是**数小时**量级。
 *  产物里的 `sec` 是 [慢, 典型, 快] 三个值 —— 别只给一个数装作很确定。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  在哪切（自然断点优先，绝不在句子中间切）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  边界强度（在 k 处切 = 把第 k 框作为新段的第一框）：
 *    S3 硬切：章节/分页标记（`_how ∈ {chapter,subtitle,notice}`）、`_src='generated'`、
 *             正文含「时间：/地点：」（剧本里就是场景头）
 *    S2 动作切：`sfx` 音效拍；文本以「——」或「【」开头；段落变了**且**叙述↔对白切换
 *    S1 段落切：源文档段落变了（`_line` 变化 —— 这也是最主要的边界）
 *    S0 不可切：同一源段落内部继续
 *
 *  算法：从段首累积时长，够 MIN 之后在 LOOK 窗口里找**强度最高的边界**（同强度取最早）；
 *        找不到就继续累，到 MAX 强制在最近处切；整幕不足 MIN 就不再切。
 *  然后做一次 **FLOOR 剪枝**：删掉会造成 < FLOOR 秒短段的切点
 *  （硬边界常紧贴前一段，不剪会出现 2 秒一段 —— 为 2 秒过场换配乐是荒谬的）。
 *
 *  参数：MIN 150s / MAX 300s / LOOK 150s / FLOOR 60s
 *  ⇒ 段长落在 2.5–5 分钟，与 OST 单曲时长（1–5 分钟）同量级，一次换曲能真的覆盖住。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bgForText } from './bg-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ML = path.join(ROOT, 'compiler', 'mainline');

export const RUNTIME = {
  typeMsPerChar: 78,      // WebGAL 默认 textSpeed=50 → 3 + (100-50)*1.5
  clickSec: 0.4,
  readCps: { slow: 5, typ: 8, fast: 12 },
  source: 'WebGAL hooks/useTextOptions.ts useTextDelay + store/userDataReducer.ts textSpeed=50',
};

export const SEG_PARAMS = { MIN: 150, MAX: 300, LOOK: 150, FLOOR: 60 };

// ★ 本仓库不含剧本文本。缺产物时**模块仍可被 import**（否则整条编译链的
//   依赖检查、文档工具都会因为这一行而炸），只有真正要用它切分时才报错退出。
const NEED = ['beats.json', 'beats-with-meta.json', 'story.json'].map((f) => path.join(ML, f));
const HAS_MAINLINE = NEED.every((f) => existsSync(f));

function needMainline(what) {
  if (HAS_MAINLINE) return;
  console.error(`✗ segments.mjs 需要剧本产物才能${what}。`);
  console.error('  本仓库不含任何具体作品的剧本文本。先准备你自己的剧本，按顺序跑：');
  console.error('     1) python compiler/extract-docx.py <你的剧本.docx>   # → mainline-src/script.json');
  console.error('     2) node   compiler/docx-to-mainline.mjs              # → mainline/');
  console.error('  详见 README「快速开始」。');
  process.exit(1);
}

const beats = HAS_MAINLINE ? JSON.parse(readFileSync(NEED[0], 'utf8')) : [];
const meta = HAS_MAINLINE ? JSON.parse(readFileSync(NEED[1], 'utf8')) : [];
const story = HAS_MAINLINE ? JSON.parse(readFileSync(NEED[2], 'utf8')) : { characters: [] };
const CHAR_NAME = Object.fromEntries((story.characters || []).map((c) => [c.id, c.name]));
const nameOf = (w) => CHAR_NAME[w] || w;

/** 单框时长（秒），返回 [慢, 典型, 快] */
export function boxSec(text) {
  const n = (text || '').length;
  const ty = (n * RUNTIME.typeMsPerChar) / 1000;
  const mk = (cps) => Math.max(ty, n / cps) + RUNTIME.clickSec;
  const r = RUNTIME.readCps;
  return [mk(r.slow), mk(r.typ), mk(r.fast)];
}

/** 边界强度（在 k 处切） */
export function strengthAt(k) {
  if (k <= 0 || k >= beats.length) return 0;
  const m = meta[k], b = beats[k], p = meta[k - 1];
  const t = b.text || '';
  if (['chapter', 'subtitle', 'notice'].includes(m._how) || m._src === 'generated') return 3;
  if (/时间：|地点：/.test(t)) return 3;
  if (b.t === 'sfx') return 2;
  if (/^——|^【/.test(t)) return 2;
  if (m._line !== p._line && b.t !== beats[k - 1].t) return 2;
  if (m._line !== p._line) return 1;
  return 0;
}

/** 把 [i0,i1) 的框按源段落还原成可读文本（对白带说话人） */
function paragraphs(i0, i1) {
  const out = [];
  let curLine = null, buf = [], who = null;
  const flush = () => { if (buf.length) out.push({ line: curLine, who, text: buf.join('') }); buf = []; };
  for (let i = i0; i < i1; i++) {
    const m = meta[i], b = beats[i];
    if (m._line !== curLine) { flush(); curLine = m._line; who = b.t === 'say' ? nameOf(b.who) : null; }
    buf.push(b.text || '');
  }
  flush();
  return out;
}

/** 抽样摘录：头部 + 尾部（中间省略），控制长度 */
function excerpt(paras, head = 300, tail = 180) {
  const render = (p) => (p.who ? `${p.who}：「${p.text}」` : p.text);
  const full = paras.map(render);
  if (full.join('\n').length <= head + tail + 20) return { text: full.join('\n'), truncated: false };
  let h = '';
  for (const s of full) { if ((h + s).length > head) break; h += s + '\n'; }
  let t = '';
  for (let i = full.length - 1; i >= 0; i--) { const s = full[i]; if ((s + t).length > tail) break; t = s + '\n' + t; }
  return { text: `${h}　　……（中段略）……\n${t}`.trim(), truncated: true };
}

/** 每一幕的框范围（按 script 顺序） */
function acts() {
  const list = [];
  let cur = null;
  for (let i = 0; i < beats.length; i++) {
    const m = meta[i];
    if (!m._scene) continue;
    if (!cur || cur.scene !== m._scene || cur.ch !== m._ch) {
      if (cur) { cur.i1 = i; list.push(cur); }
      cur = { ch: m._ch, scene: m._scene, i0: i, i1: beats.length, part: m._part };
    }
  }
  if (cur) { cur.i1 = beats.length; list.push(cur); }
  return list;
}

const secOf = (i) => boxSec(beats[i].text)[1];
const secRange = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += secOf(i); return s; };

/** 剪掉会造成超短段的切点（只在幕内剪） */
function prune(arr) {
  let c = arr.slice(), changed = true;
  while (changed && c.length > 2) {
    changed = false;
    for (let k = 1; k < c.length - 1; k++) {
      if (secRange(c[k - 1], c[k]) < SEG_PARAMS.FLOOR || secRange(c[k], c[k + 1]) < SEG_PARAMS.FLOOR) {
        c.splice(k, 1); changed = true; break;
      }
    }
  }
  return c;
}

let _avg = 0;
const lookBoxes = () => {
  if (!_avg) { let s = 0; for (const b of beats) s += boxSec(b.text)[1]; _avg = s / beats.length; }
  return Math.max(8, Math.round(SEG_PARAMS.LOOK / _avg));
};

/** 一幕内的切点（返回 [i0, ..., i1]） */
function cutPoints(a) {
  const cuts = [a.i0];
  let i = a.i0;
  while (i < a.i1) {
    let acc = 0, j = i, cut = -1;
    while (j < a.i1) {
      acc += secOf(j); j++;
      if (acc < SEG_PARAMS.MIN) continue;
      let best = -1, bestS = 0;
      for (let k = j; k < Math.min(a.i1, j + lookBoxes()); k++) {
        const s = strengthAt(k);
        if (s > bestS) { bestS = s; best = k; if (s === 3) break; }
      }
      if (best > i) { cut = best; break; }
      if (acc >= SEG_PARAMS.MAX) { cut = j; break; }
    }
    if (cut < 0 || cut >= a.i1) break;
    cuts.push(cut); i = cut;
  }
  cuts.push(a.i1);
  return prune(cuts);
}

export function buildSegments() {
  needMainline('切分配乐段落');
  const out = [];
  let n = 0;
  for (const a of acts()) {
    const cuts = cutPoints(a);
    for (let c = 0; c + 1 < cuts.length; c++) {
      const i0 = cuts[c], i1 = cuts[c + 1];
      const paras = paragraphs(i0, i1);
      let chars = 0;
      const sec = [0, 0, 0];
      const speakers = new Map();
      const sfx = [];
      for (let i = i0; i < i1; i++) {
        const t = beats[i].text || '';
        chars += t.length;
        const s = boxSec(t);
        sec[0] += s[0]; sec[1] += s[1]; sec[2] += s[2];
        if (beats[i].t === 'say' && beats[i].who) {
          const nm = nameOf(beats[i].who);
          speakers.set(nm, (speakers.get(nm) || 0) + 1);
        }
        if (beats[i].t === 'sfx') sfx.push(t.replace(/^〔|〕$/g, ''));
      }
      const ex = excerpt(paras);
      n++;
      out.push({
        id: `S${String(n).padStart(3, '0')}`,
        n, ch: a.ch, part: a.part || '', act: a.scene,
        i0, i1, boxes: i1 - i0, chars,
        // ★ 源文档行号区间：外援拿到段号后可以直接回到 docx/script-readable.txt 看全文
        line0: meta[i0]?._line ?? null,
        line1: meta[i1 - 1]?._line ?? null,
        sec: sec.map((x) => Math.round(x)),
        bg: bgForText(`${a.scene} ${paras.slice(0, 6).map((p) => p.text).join(' ')}`),
        speakers: [...speakers.entries()].sort((x, y) => y[1] - x[1]).map(([who, cnt]) => ({ who, cnt })),
        sfx: [...new Set(sfx)],
        excerpt: ex.text,
        truncated: !!ex.truncated,
        paraCount: paras.length,
      });
    }
  }
  return out;
}

// ── 直接运行 → 写 segments.json 并打印统计 ────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  needMainline('生成 segments.json');
  const segs = buildSegments();
  const actsList = acts();
  const tot = segs.reduce((x, s) => x + s.sec[1], 0);
  const secs = segs.map((s) => s.sec[1]).sort((x, y) => x - y);
  const q = (p) => secs[Math.min(secs.length - 1, Math.floor(secs.length * p))];

  console.log(`框 ${beats.length} · 字 ${beats.reduce((x, b) => x + (b.text || '').length, 0)}`);
  console.log(`幕 ${actsList.length} → 配乐段落 ${segs.length}`);
  console.log(`总放映时长（典型）≈ ${(tot / 3600).toFixed(2)} 小时  ` +
    `（慢 ${(segs.reduce((x, s) => x + s.sec[0], 0) / 3600).toFixed(2)}h / 快 ${(segs.reduce((x, s) => x + s.sec[2], 0) / 3600).toFixed(2)}h）`);
  console.log(`段长 中位 ${q(0.5)}s · p10 ${q(0.1)}s · p25 ${q(0.25)}s · p90 ${q(0.9)}s · 最短 ${secs[0]}s · 最长 ${secs[secs.length - 1]}s\n`);

  console.log('=== 最长的 10 幕（说明"一幕一首"为什么不成立）===');
  const perAct = actsList.map((a) => {
    const ss = segs.filter((s) => s.i0 >= a.i0 && s.i1 <= a.i1);
    return { ...a, sec: ss.reduce((x, s) => x + s.sec[1], 0), seg: ss.length };
  }).sort((x, y) => y.sec - x.sec).slice(0, 10);
  for (const a of perAct) {
    console.log(`  ${String(Math.round(a.sec / 60)).padStart(3)} 分钟 · 切成 ${String(a.seg).padStart(2)} 段 · 第${a.ch}章 ${a.scene}`);
  }
  const byCh = {};
  for (const s of segs) byCh[s.ch] = (byCh[s.ch] || 0) + 1;
  console.log('\n=== 每章段数 ===');
  console.log('  ' + Object.entries(byCh).map(([c, n]) => `第${c}章 ${n} 段`).join(' · '));

  writeFileSync(path.join(ML, 'segments.json'), JSON.stringify({
    model: RUNTIME, params: SEG_PARAMS, generatedBy: 'compiler/segments.mjs',
    totals: {
      boxes: beats.length,
      chars: beats.reduce((x, b) => x + (b.text || '').length, 0),
      acts: actsList.length, segments: segs.length, secTyp: Math.round(tot),
    },
    segments: segs,
  }, null, 2), 'utf8');
  console.log('\n→ mainline/segments.json');
}
