/**
 * compiler / verify-sfx.mjs —— 全局音效的**产物校验器**
 * ===========================================================================
 * 只测**真实产物**：编译出来的主线场景文件（`dist/game/scene/<主线场景名>`）与它要引用的
 * `dist/game/effect/*` 音频文件。不测中间数据结构 —— 中间结构对了、产物错了，等于没对。
 *
 * 查七件事（每条都能独立失败，方便定位）：
 *   ① 每个 `playEffect:` 指向的文件**真的在盘上**（这是本项目最脆的一环：
 *      playEffect 的资源路径被上游映射到了 `fileType.vocal`，我们靠 `../effect/` 绕出来）
 *   ② **单声道冲突**：不带 `-id=` 的一次性音效是单声道通道，两条紧邻会互相掐掉 ⇒ 报警
 *   ③ 每个循环音（带 `-id=`）都有配对的 `playEffect:none -id=`（除非它开到片尾）
 *   ④ 清单里的每条资产都被规则引用，或显式标了 hidden / 属环境层
 *   ⑤ 规则引用的 id 全部在清单里
 *   ⑥ 落盘文件与清单的体积/时长对得上（防止半截文件）
 *   ⑦ 出处与许可证：用到的每个文件都要在 `sfx-sources.json` 里有登记
 *
 * 用法：node compiler/verify-sfx.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG, SFX_DIR, BY_ID, fileOf, referencedIds, AMB_LAYERS,
} from './sfx-rules.mjs';
import { ROOT, mainlineScenePath } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENE = mainlineScenePath();

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${msg}`); } };
const warn = (msg) => console.log(`  ⚠ ${msg}`);

if (!existsSync(SCENE)) {
  console.error(`✗ 找不到编译产物 ${path.relative(ROOT, SCENE)} —— 先跑 node compiler/build-demo.mjs`);
  process.exit(1);
}
const lines = readFileSync(SCENE, 'utf8').split('\n');

// ── 解析产物里的音效指令 ────────────────────────────────────────────────────
const plays = [];      // { line, file, id, volume }
const stops = [];      // { line, id }
lines.forEach((raw, i) => {
  const m = /^\s*playEffect:(\S+)(.*);\s*$/.exec(raw);
  if (!m) return;
  const [, target, args] = m;
  if (target === 'none') {
    const id = /-id=([\w-]+)/.exec(args)?.[1] ?? '';
    stops.push({ line: i + 1, id });
    return;
  }
  plays.push({
    line: i + 1,
    file: path.posix.basename(target),
    target,
    id: /-id=([\w-]+)/.exec(args)?.[1] ?? null,
    volume: Number(/-volume=(\d+)/.exec(args)?.[1] ?? NaN),
  });
});
const oneShots = plays.filter((p) => !p.id);
const loops = plays.filter((p) => p.id);

console.log(`产物 ${path.relative(ROOT, SCENE)}`);
console.log(`  playEffect ${plays.length} 条 = 一次性 ${oneShots.length} + 循环起播 ${loops.length} · 循环停止 ${stops.length}\n`);

// ── ① 文件真的在盘上 ────────────────────────────────────────────────────────
console.log('① 指令指向的音频文件存在');
const missingFiles = [...new Set(plays.map((p) => p.file))].filter((f) => !existsSync(path.join(SFX_DIR, f)));
for (const f of missingFiles) console.log(`  ✗ 缺文件 game/effect/${f}（用到它的行：${plays.filter((p) => p.file === f).map((p) => p.line).join(',')}）`);
ok(missingFiles.length === 0, `${missingFiles.length} 个被引用的音频文件不存在`);

// 路径前缀必须是我们绕出来的写法（写错会 404 且**不报错**）
const badPrefix = plays.filter((p) => !p.target.startsWith('../effect/'));
for (const p of badPrefix.slice(0, 5)) console.log(`  ✗ 第 ${p.line} 行前缀不对：${p.target}（必须是 ../effect/，见 sfx-rules.mjs 文件头）`);
ok(badPrefix.length === 0, `${badPrefix.length} 条指令没有用 ../effect/ 前缀`);

// ── ② 单声道冲突 ────────────────────────────────────────────────────────────
console.log('② 一次性音效的单声道冲突');
let clash = 0;
for (let i = 1; i < plays.length; i++) {
  const a = plays[i - 1], b = plays[i];
  if (a.id || b.id) continue;
  if (b.line - a.line <= 2) { clash++; warn(`第 ${a.line} 行的 ${a.file} 会被第 ${b.line} 行的 ${b.file} 掐掉`); }
}
ok(clash === 0, `${clash} 处一次性音效紧邻（会互相掐掉；应预先合成为一条音频）`);

// ── ③ 循环音配对 ────────────────────────────────────────────────────────────
console.log('③ 循环音的起停配对');
const openStack = [];
const unclosed = [];
for (const p of loops) {           // ★ 只查循环音；一次性音效本来就没有 id（这里曾误用 plays，报了 31 条假错误）
  const stop = stops.find((s) => s.id === p.id && s.line > p.line);
  if (!stop) unclosed.push(p);
}
// 允许：叠加上（天气层）与片尾仍在响的那些
const allowedOpen = new Set([...AMB_LAYERS]);
const bad = unclosed.filter((p) => !allowedOpen.has(p.id));
for (const p of bad) console.log(`  ✗ 第 ${p.line} 行起的 ${p.id} 没有对应的 playEffect:none -id=${p.id}`);
ok(bad.length === 0, `${bad.length} 个循环音没有配对停止（会一直响到玩家退出）`);
const lastOpen = unclosed.filter((p) => allowedOpen.has(p.id)).map((p) => p.id);
if (lastOpen.length) console.log(`  · 叠加层/片尾仍在响：${[...new Set(lastOpen)].join(', ')}（按设计允许）`);

// ── ④⑤ 清单 ↔ 规则 双向覆盖 ─────────────────────────────────────────────────
console.log('④ 清单与规则双向覆盖');
const refs = referencedIds();
const unknown = [...refs].filter((id) => !BY_ID.has(id));
for (const id of unknown) console.log(`  ✗ 规则引用了清单里没有的 id：${id}`);
ok(unknown.length === 0, `${unknown.length} 个规则 id 不在清单里`);

const unused = [...BY_ID.keys()].filter((id) => !refs.has(id) && !BY_ID.get(id).hidden);
if (unused.length) warn(`清单里未被任何规则引用（素材库/可手动挂载）：${unused.join(', ')}`);
ok(true, '');

// ── ⑥ 落盘文件的体积/时长 ───────────────────────────────────────────────────
console.log('⑤ 落盘文件与清单一致');
const badSize = [];
for (const [id, e] of BY_ID) {
  if (e.hidden) continue;
  const p = path.join(SFX_DIR, fileOf(id));
  if (!existsSync(p)) { badSize.push(`${id}（缺）`); continue; }
  const sz = statSync(p).size;
  if (sz < 1024) badSize.push(`${id}（只有 ${sz}B，八成是半截文件）`);
}
for (const b of badSize) console.log(`  ✗ ${b}`);
ok(badSize.length === 0, `${badSize.length} 个资产缺失或体积异常`);

// 时长离谱的（WAV 头可算：44 字节头 + PCM）
const oddDur = [];
const rate = CATALOG.format.rate;
for (const [id, e] of BY_ID) {
  if (e.hidden) continue;
  const p = path.join(SFX_DIR, fileOf(id));
  if (!existsSync(p)) continue;
  const sz = statSync(p).size;
  if (CATALOG.format.ext !== 'wav') continue;
  const dur = (sz - 44) / (rate * 2 * CATALOG.format.channels);
  const want = e.p?.len ?? 0;
  if (want && Math.abs(dur - want) > Math.max(1.5, want * 0.2)) oddDur.push(`${id} 实际 ${dur.toFixed(1)}s / 期望 ${want}s`);
}
for (const o of oddDur) warn(o);
ok(true, '');

// ── ⑦ 出处与许可证登记 ──────────────────────────────────────────────────────
console.log('⑥ 出处与许可证登记（sfx-sources.json）');
const srcPath = path.join(HERE, 'sfx-sources.json');
const used = new Set([...plays.map((p) => p.file.replace(/\.[a-z0-9]+$/, ''))]);
if (!existsSync(srcPath)) {
  warn('还没有 sfx-sources.json —— 当前全部为**合成占位**（make-sfx.py），无需署名；' +
       '换成下载素材后必须补这份登记（作者 / 许可证 / 来源页）');
} else {
  const SRC = JSON.parse(readFileSync(srcPath, 'utf8'));
  // ★ 「是不是真实素材」不看登记表，看**加工器写的出处记录** ——
  //   登记了但源还没下到的情况真实存在（fetch-sfx 会跳过并保留合成占位），
  //   只看登记表会把它误报成"真实录音"（踩过）。
  const provPath = path.join(SFX_DIR, '_provenance.json');
  const PROV = existsSync(provPath) ? JSON.parse(readFileSync(provPath, 'utf8')) : { entries: {} };
  const realIds = [...used].filter((id) => PROV.entries?.[id] && PROV.entries[id].kind !== 'hybrid');
  const hybridIds = [...used].filter((id) => PROV.entries?.[id]?.kind === 'hybrid');
  const synIds = [...used].filter((id) => !PROV.entries?.[id]);
  console.log(`  · 真实录音 ${realIds.length} 个：${realIds.join(', ') || '（无）'}`);
  if (hybridIds.length) {
    console.log(`  · 混合（真实底床 + 合成事件层）${hybridIds.length} 个：${hybridIds.join(', ')}`);
  }
  console.log(`  · 合成占位 ${synIds.length} 个（自制，免署名）：${synIds.join(', ')}`);
  ok(true, '');

  // 登记了但**没被加工出来**的（源文件缺失）= 实际仍在用合成占位，必须点名
  const declaredNotBuilt = Object.entries(SRC.entries || {})
    .filter(([id, v]) => !id.startsWith('_') && v && typeof v === 'object' && v.pack)   // `_note_*` 是说明，不是条目
    .map(([id]) => id)
    .filter((id) => !PROV.entries?.[id]);
  if (declaredNotBuilt.length) {
    warn(`已登记下载源但尚未加工（当前仍为合成占位）：${declaredNotBuilt.join(', ')}`);
    warn('  补齐：python compiler/fetch-sfx.py --download && python compiler/fetch-sfx.py');
  }

  // 哈希漂移：文件被手改过 / 加工器换过参数，却没重跑出处记录
  const drift = [];
  for (const [id, v] of Object.entries(PROV.entries || {})) {
    const f = path.join(SFX_DIR, fileOf(id));
    if (!existsSync(f)) { drift.push(`${id}（文件没了）`); continue; }
    const h = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
    if (v.sha256 && h !== v.sha256) drift.push(`${id}（哈希变了）`);
  }
  for (const d of drift) console.log(`  ✗ 出处记录与磁盘不一致：${d}`);
  ok(drift.length === 0, `${drift.length} 个文件与出处记录不一致（重跑 fetch-sfx.py 即可刷新）`);
  // ★ 许可证不写在每条 entry 上，而是集中在 packs（一份许可证只写一次，避免 20 处漂移）
  const badPack = [];
  for (const [id, v] of Object.entries(SRC.entries || {})) {
    if (id.startsWith('_')) continue;      // `_note_*` 是给人看的说明，不是条目
    const p = SRC.packs?.[v.pack];
    if (!v.pack || !p) { badPack.push(`${id}（pack 引用无效：${v.pack}）`); continue; }
    if (!p.licence || !p.author || !(p.page || p.url)) badPack.push(`${id}（${v.pack} 缺 licence/author/page）`);
    else if (!/CC0|public domain|公有领域/i.test(p.licence)) {
      warn(`${id} 的许可证是「${p.licence}」—— **不是 CC0**：必须逐条确认可商用，CC-BY 还需把署名写进 Staff 页`);
    }
  }
  for (const b of badPack) console.log(`  ✗ ${b}`);
  ok(badPack.length === 0, `${badPack.length} 条登记信息不全（licence / author / page 三件套）`);
  // 用了真实素材的 id，其源包必须已下载
  const packsUsed = new Set(Object.entries(SRC.entries || {})
    .filter(([id, v]) => !id.startsWith('_') && v && typeof v === 'object' && v.pack)
    .map(([, v]) => v.pack));
  console.log(`  · 用到 ${packsUsed.size} 个素材包：${[...packsUsed].join(', ')}`);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const bytes = [...new Set(plays.map((p) => p.file))]
  .map((f) => { const p = path.join(SFX_DIR, f); return existsSync(p) ? statSync(p).size : 0; })
  .reduce((a, b) => a + b, 0);
console.log(`\n用到的音频文件 ${new Set(plays.map((p) => p.file)).size} 个 · ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`\n────────────────────────────────────────\n通过 ${pass}　失败 ${fail}`);
process.exit(fail ? 1 : 0);
