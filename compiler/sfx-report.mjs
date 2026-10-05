/**
 * compiler / sfx-report.mjs —— 生成《全局音效清单》HTML（给人看的复核件）
 * ===========================================================================
 * 三张表：
 *   ① 逐条音效 —— 剧本原文 / 上下文判据 / 落在哪个音效 / 时长 / 来源（真实素材 or 合成占位）
 *   ② 环境音床 —— 每个场景 bg 对应哪一床 / 在产物里开关几次
 *   ③ 出处与许可证 —— 从 sfx-sources.json 读
 *
 * 数据全部来自**真实产物**：`dist/game/scene/<主线场景名>` + `dist/game/effect/`。
 * 用法：node compiler/sfx-report.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG, BY_ID, fileOf, SFX_DIR, AMB_BY_BG, classifySfx, ctxOf,
} from './sfx-rules.mjs';
import { ROOT, mainlineScenePath } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ★ 报告写到哪：默认 repo 根的 `_report/`（临时产物目录，见 .gitignore）。
//   要换：环境变量 `SFX_REPORT_DIR=<目录>`。
const OUT_DIR = process.env.SFX_REPORT_DIR || path.join(ROOT, '_report');
const SCENE = mainlineScenePath();

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── 来源判定：真实素材（在 sfx-sources.json 里）还是合成占位 ──
const SRC_PATH = path.join(HERE, 'sfx-sources.json');
const SRC = existsSync(SRC_PATH) ? JSON.parse(readFileSync(SRC_PATH, 'utf8')) : { entries: {}, packs: {} };
// ★ 真伪以**加工器的产出记录**为准，不以登记表为准：登记了但源没下到的，实际还在用合成占位。
const PROV_PATH = path.join(SFX_DIR, '_provenance.json');
const PROV = existsSync(PROV_PATH) ? JSON.parse(readFileSync(PROV_PATH, 'utf8')) : { entries: {} };
const realIds = new Set(Object.keys(PROV.entries || {}));
const packOf = (id) => SRC.packs?.[SRC.entries[id]?.pack]?.author ?? '—';

// ── 逐条音效：主线 + 分支 ──
const beats = JSON.parse(readFileSync(path.join(HERE, 'mainline', 'beats-with-meta.json'), 'utf8'));
const { BRANCH_POINTS = [], ENDS = [], DEATH_HINT } = await import('./branches.mjs');

const rows = [];
beats.forEach((b, i) => {
  if (b.t !== 'sfx') return;
  const c = classifySfx(b.text, ctxOf(beats, i));
  rows.push({ where: `第${b._ch}章 ${b._scene || ''}`.trim(), text: b.text, ...c, scope: '主线' });
});
const pushBranch = (arr, where, scope) => (arr || []).forEach((b, i) => {
  if (b.t !== 'sfx') return;
  rows.push({ where, text: b.text, ...classifySfx(b.text, ctxOf(arr, i)), scope });
});
for (const bp of BRANCH_POINTS) pushBranch(bp.setup, `分支点 ${bp.id}`, '分支');
for (const e of ENDS) pushBranch(e.beats, `END ${e.id}`, 'END');
pushBranch(DEATH_HINT?.beats, '死亡提示', 'END');

const dur = (id) => {
  const p = path.join(SFX_DIR, fileOf(id));
  if (!existsSync(p)) return null;
  if (CATALOG.format.ext === 'wav') {
    return (statSync(p).size - 44) / (CATALOG.format.rate * 2 * CATALOG.format.channels);
  }
  return null;
};

// ── 产物里的环境音开关次数 ──
const sceneTxt = existsSync(SCENE) ? readFileSync(SCENE, 'utf8') : '';
const ambStarts = {};
for (const m of sceneTxt.matchAll(/^playEffect:\S*\/?(amb_[a-z_]+)\.\w+ -volume=/gm)) {
  ambStarts[m[1]] = (ambStarts[m[1]] || 0) + 1;
}
const ambStops = {};
for (const m of sceneTxt.matchAll(/^playEffect:none -id=(amb_[a-z_]+);/gm)) {
  ambStops[m[1]] = (ambStops[m[1]] || 0) + 1;
}

const sfxTable = rows.map((r) => {
  const chip = r.amb
    ? `<span class="c-amb">环境层</span>`
    : r.id
      ? `<span class="c-se">${esc(r.id)}</span>`
      : `<span class="c-sil">静默</span>`;
  const srcTag = r.id
    ? (realIds.has(r.id) ? `<span class="c-real">真实录音 · ${esc(packOf(r.id))}</span>` : `<span class="c-syn">合成占位</span>`)
    : '';
  const d = r.id ? dur(r.id) : null;
  return `<tr><td class="mono dim">${esc(r.scope)}</td><td>${esc(r.where)}</td>
    <td class="q">「${esc(r.text)}」</td><td class="dim">${esc(r.rule || '（未命中规则）')}</td>
    <td>${chip} ${srcTag}</td><td class="mono">${d ? d.toFixed(2) + 's' : '—'}</td></tr>`;
}).join('\n');

const ambTable = Object.entries(AMB_BY_BG).map(([bg, id]) => {
  const e = BY_ID.get(id) || {};
  const n = ambStarts[id] || 0;
  const real = realIds.has(id);
  return `<tr><td class="mono">${esc(bg)}</td><td>${esc(id)}</td><td>${esc(e.desc || '')}</td>
    <td class="mono">${n}</td><td class="mono">${e.volume ?? '—'}</td>
    <td>${real ? '<span class="c-real">真实录音</span>' : '<span class="c-syn">合成占位</span>'}</td></tr>`;
}).join('\n');

const licTable = Object.entries(SRC.packs || {}).map(([k, p]) =>
  `<tr><td class="mono">${esc(k)}</td><td>${esc(p.author)}</td><td><span class="c-real">${esc(p.licence)}</span></td>
   <td class="mono dim"><a href="${esc(p.page)}">${esc(p.page)}</a></td></tr>`).join('\n');

const nReal = rows.filter((r) => r.id && realIds.has(r.id)).length;
const nSyn = rows.filter((r) => r.id && !realIds.has(r.id)).length;
const nAmb = rows.filter((r) => r.amb).length;
const nSil = rows.filter((r) => !r.id && !r.amb).length;
const ambReal = Object.values(AMB_BY_BG).filter((i) => realIds.has(i)).length;

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>全局音效清单</title>
<style>
:root{--bg:#0E1114;--panel:#161B21;--raised:#1F262E;--line:#2E3742;--ink:#E6E4DE;--dim:#9AA3AC;
--faint:#5C6670;--sig:#C8382E;--cold:#8E959C;--gold:#C9A227;--real:#7FB069}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Noto Sans SC",system-ui,sans-serif;padding:48px 40px 80px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:.02em}
h2{font-size:19px;margin:46px 0 12px;padding-left:12px;border-left:2px solid var(--sig)}
.lede{color:var(--dim);max-width:960px;margin:0 0 8px}
.kpi{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0 8px}
.kpi div{background:var(--panel);border:1px solid var(--line);border-radius:2px;padding:10px 16px;min-width:132px}
.kpi b{display:block;font:700 24px/1.2 "IBM Plex Mono",monospace;color:var(--cold)}
.kpi span{font-size:12px;color:var(--faint);letter-spacing:.08em}
table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13.5px}
th,td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--raised);font-size:12px;letter-spacing:.1em;color:var(--dim);font-weight:600}
td.mono,th.mono{font-family:"IBM Plex Mono",monospace}
.dim{color:var(--dim)}.q{color:var(--ink)}
.c-se{color:var(--gold);font-family:"IBM Plex Mono",monospace}
.c-amb{color:var(--cold);font-family:"IBM Plex Mono",monospace}
.c-sil{color:var(--faint)}
.c-real{color:var(--real);font-size:12px}
.c-syn{color:var(--faint);font-size:12px;font-style:italic}
a{color:var(--cold);text-decoration:none}
.note{background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--gold);
padding:14px 18px;margin:18px 0;color:var(--dim);font-size:13.5px;max-width:1000px}
code{font-family:"IBM Plex Mono",monospace;color:var(--cold)}
</style></head><body>
<h1>全局音效清单</h1>
<p class="lede">由 <code>compiler/sfx-report.mjs</code> 从<b>编译产物</b>反推生成 ——
剧本每一处音效拍、判到哪个音效、用的是真实录音还是合成占位，以及环境音床与场景的对应关系。</p>

<div class="kpi">
  <div><b>${rows.length}</b><span>音效拍（主线+分支）</span></div>
  <div><b>${nReal}</b><span>真实录音</span></div>
  <div><b>${nSyn}</b><span>合成占位</span></div>
  <div><b>${nAmb}</b><span>环境层触发</span></div>
  <div><b>${nSil}</b><span>静默节拍</span></div>
  <div><b>${Object.keys(AMB_BY_BG).length}</b><span>环境音床</span></div>
</div>

<div class="note"><b>★ 为什么同一个拟声词要判到不同的音效：</b>
全片 22 条主线音效里，「砰！」至少是 <b>4 种不同的东西</b> —— 身体砸地 / 枪声 / 板砖砸后脑 / 拳头砸控制台；
「轰」有 3 种（穹顶炸开 / 窗外夜空 / 火箭弹命中）；「咔嚓」有 2 种（枪械上膛 / 书架断裂）。
只按拟声词映射必然错配，所以判定规则是<b>「拟声词 + 上下文语义」双条件</b>（见 <code>compiler/sfx-rules.mjs</code>）。<br>
<b>★ 环境音是两层：</b>场景层（随背景图切换）× 叠加层（天气等，不随场景关）。
若某条音效在剧本里只是<b>节拍标记</b>（如「就在这时——」，真正的爆炸在下一拍），判为<b>静默</b>，不发声音也不占文本框。</div>

<h2>① 逐条音效</h2>
<table><thead><tr><th class="mono">范围</th><th>位置</th><th>剧本原文</th><th>判定依据</th><th>音效 / 来源</th><th class="mono">时长</th></tr></thead>
<tbody>
${sfxTable}
</tbody></table>

<h2>② 环境音床 ↔ 场景</h2>
<p class="lede">环境音与背景图<b>同源</b>（都由 <code>bg-rules.mjs</code> 判定）—— 画面与声场天然同调，
换场景 = 换背景 = 换环境音，一个钩子搞定。「起播次数」是编译产物里的实际值。</p>
<table><thead><tr><th class="mono">背景图</th><th>环境音 id</th><th>设计</th><th class="mono">起播</th><th class="mono">音量</th><th>来源</th></tr></thead>
<tbody>
${ambTable}
</tbody></table>
<p class="lede dim">当前 ${ambReal}/${Object.keys(AMB_BY_BG).length} 床为真实录音，其余为合成占位（房间底噪类用合成反而更干净、更可控）。</p>

<h2>③ 素材出处与许可证</h2>
<table><thead><tr><th class="mono">素材包</th><th>作者</th><th>许可证</th><th class="mono">来源页</th></tr></thead>
<tbody>
${licTable}
</tbody></table>
<p class="lede dim">全部为 <b>CC0 1.0（公有领域）</b>：可商用、可修改、无需署名。随游戏交付的完整登记见
<code>game/effect/CREDITS.md</code>；若将来引入 CC-BY 或限教育用途的素材，必须登记并把署名写进 Staff 页。</p>
</body></html>`;

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, '音效清单.html');
writeFileSync(out, html, 'utf8');
console.log(`✓ ${path.relative(ROOT, out)}（音效拍 ${rows.length} · 真实 ${nReal} / 合成 ${nSyn} · 环境层 ${nAmb} · 静默 ${nSil}）`);
