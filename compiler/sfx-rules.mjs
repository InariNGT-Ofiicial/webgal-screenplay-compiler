/**
 * compiler / sfx-rules.mjs —— 「文本 → 音效」的**唯一实现**
 * ===========================================================================
 * 一个文件、一份规则，`build-demo.mjs`（编译期）import 它。
 * 纪律同 `bg-rules.mjs`：**同一份规则只能有一处实现**，否则两边迟早漂移。
 *
 * ── 上游机制（读源码得出的硬事实，决定了下面两个常量）───────────────────────
 * ★ `playEffect` 的 content 会被 `packages/parser/src/scriptParser/contentParser.ts` 按
 *   `fileType.vocal` 拼成 `./game/vocal/<name>` —— 上游把「效果音」**复用成了语音目录**
 *   （`assetSetter` 的 `fileType` 枚举里根本没有 effect）。
 *   ⇒ 想让音效住在 `game/effect/`，脚本里必须写 `../effect/xxx.wav`：
 *     `./game/vocal/../effect/x.wav` 会被浏览器（URL 规范化）和 bridge（`path.join`）
 *     双方各自规范化成 `./game/effect/x.wav`。**已验证可行，但这是本项目最脆的一环** ——
 *     编译期会逐条断言解析后的文件真的存在。
 *   ★ 千万别写 `./game/effect/x.wav`：会被拼成 `./game/vocal/./game/effect/x.wav`（404）。
 *
 * ★ `playEffect` 的**两个通道语义**（读 `Core/gameScripts/playEffect.ts`）：
 *   ① 不带 `-id=` ⇒ **单声道一次性音**：发新的一条会 `unmountPerform('effect-sound')`
 *      **掐掉上一条**。所以「砰！砰！砰！」不能靠连发三条指令实现，必须**预先合成为一个音频**。
 *   ② 带 `-id=` ⇒ **循环音**（`isLoop = true`）。同一个 id 再发一次 = 重启。
 *      停它用 `playEffect:none -id=<id>`（源码里 unmount 发生在 `if (!url)` 早退**之前**，
 *      所以 `none` 确实能停掉——这是上游没写进文档的用法）。
 *      ✅ 多个不同 id 的循环音可以**共存**（各自一个 perform）⇒ 环境音分层可行。
 * ★ 音效**没有淡入淡出**（不像 bgm 有 `-enter`）⇒ 环境音切换是硬切，靠场景切点掩盖。
 *
 * ── 为什么规则是「拟声词 + 上下文」双条件 ─────────────────────────────────────
 * ★★ 同一段剧本里的音效拍里，**同一个「砰！」至少是 4 种不同的东西**：
 *      身体砸地 / 枪声 / 板砖砸后脑 / 拳头砸控制台；
 *    「轰」也有 3 种：穹顶炸开（近） / 窗外夜空（远） / 火箭弹命中。
 *    只按拟声词映射必然错配 ⇒ 必须再看**上下文的语义关键词**（前一条的尾 + 后一条的头）。
 *    这两条规则（`咔嚓！咔嚓！咔嚓！`＝上膛 vs `咔嚓……轰隆……`＝书架断裂）尤其依赖顺序。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ═══════════════════════════════════════════════════════════════════════════
//  ① 资产清单（唯一真源 = sfx-catalog.json，Python 侧读同一个文件）
// ═══════════════════════════════════════════════════════════════════════════
export const CATALOG = JSON.parse(readFileSync(path.join(HERE, 'sfx-catalog.json'), 'utf8'));
export const EXT = CATALOG.format.ext;
export const SFX_DIR = path.join(ROOT, 'webgal-tool', 'dist', CATALOG.format.dir);
/** 脚本里写的前缀（见文件头 ★ 说明）—— 不要改成 './game/effect/' */
export const PLAY_PREFIX = '../effect/';

export const BY_ID = new Map(
  [...CATALOG.oneShots, ...CATALOG.ambience].map((x) => [x.id, x]),
);
export const fileOf = (id) => `${id}.${EXT}`;
/** 脚本里那一整条指令的音频参数（音量来自清单，不在规则里写第二遍） */
export const playArgs = (id) => `${PLAY_PREFIX}${fileOf(id)} -volume=${BY_ID.get(id)?.volume ?? 80}`;

// ═══════════════════════════════════════════════════════════════════════════
//  ② 一次性音效规则：`[拟声词, 上下文, 音效 id, 说明]` —— **顺序有意义**
// ═══════════════════════════════════════════════════════════════════════════
//
// `拟声词` 匹配音效拍本身的文本；`上下文` = 前一条的尾部 + 后一条的头部（见 ctxOf）。
// `上下文` 为 null = 不设限（该拟声词只有一种含义时用）。
// id 为 null = **不发声**（该"音效"是节拍标记，不是声音）。
export const SFX_RULES = [
  // ── ★ 先钉「咔嚓」家族：必须在「轰」的兜底之前 ──
  //    反例：`咔嚓……轰隆……`（书架断裂）里**同时**含「咔嚓」和「轰」，
  //    若把 `[/轰/, null, se_explosion]` 这条兜底排在前面，它会被抢先判成爆炸（实测踩过）。
  [/咔嚓/, /上膛|枪械|枪口|队员/, 'se_bolt_seq', '一连串枪械上膛'],
  [/咔嚓/, /木材|书架|断裂|锁具/, 'se_wood_break', '木材断裂 → 整面书架坍塌'],

  // ── 「砰」家族：4 种含义，必须先按上下文分开 ──
  [/砰/, /气浪|砸在地板|重重砸|身体.*砸|倒地/, 'se_body_fall', '被气浪吹倒、身体砸地'],
  [/砰/, /板砖|后脑/, 'se_blunt_hit', '板砖砸后脑'],
  [/砰/, /一拳|砸在控制台|拳/, 'se_console_hit', '一拳砸控制台'],
  [/砰/, /消音|步枪|沉闷/, 'se_gunshot_supp_x2', '装消音器的步枪两声'],
  [/砰/, /擦过|火光|子弹|突击/, 'se_gunfire_burst', '三发连射贴墙掠过'],
  [/砰/, /枪声|密闭空间|震耳/, 'se_gunshot', '室内枪响'],
  [/砰/, null, 'se_gunshot', '★ 兜底：默认按枪声（会进 report 提醒复核）'],

  // ── 「轰」家族：近 / 远 ──
  [/轰/, /窗外|夜空|远处|天际|闪光/, 'se_explosion_far', '窗外夜空被闪光撕裂（远端）'],
  [/轰/, /火箭弹|M72|命中|引擎盖|车辆|爆炸/, 'se_explosion', '火箭弹命中越野车'],
  [/轰/, /穹顶|炸开|金属扭曲|向内/, 'se_explosion', '会场穹顶向内炸开'],
  [/轰/, null, 'se_explosion', '★ 兜底：默认按近端爆炸'],
  [/爆炸/, null, 'se_explosion', '直接写「爆炸」'],

  // ── 其余，逐条钉死 ──
  [/嘭/, /扳机|扣动|枪|处决/, 'se_gunshot', '处决者扣动扳机（剧本用「嘭」写枪响）'],
  [/哐当/, /托盘|器械|坠落|脱力/, 'se_metal_tray', '金属托盘脱手坠地 + 器械散落'],
  [/当啷/, /金属|样品盒|卡扣|撞击/, 'se_metal_clink', '金属样品盒脱落撞地'],
  [/咚/, /杖|顿在|地板|长老/, 'se_staff_thud', '手杖重重顿在地板上'],
  [/咻/, null, 'se_whoosh_bullet', '子弹破空掠过'],
  [/噗/, null, 'se_impact_soft', '命中（闷）'],
  [/哗啦/, /玻璃|瓶|回收箱|倒塌/, 'se_glass_crash', '整排玻璃瓶回收箱被拽倒'],
  [/嗡/, /琴|弦|指尖|低鸣/, 'se_string_hum', '指尖压弦的极低共鸣'],
  [/嗡/, null, 'se_string_hum', '兜底按弦鸣（本示例里「嗡」只出现在这一处语义下）'],
  [/嘀/, /通讯器|提示音|加密/, 'se_comm_beep', '加密通讯器提示音'],
  [/鸣响|警报/, null, 'se_alarm_jalert', '国家安全警报'],
  [/呜—|呜——/, null, 'se_alarm_jalert', '警报长音'],
  [/空响/, null, 'se_dryfire', '空仓击发（分支）'],
  [/闷响/, null, 'se_blunt_hit', '闷响（分支）'],
  [/脚步/, null, 'se_footsteps', '脚步（分支）'],
  [/低吼/, null, 'se_growl', '低吼（分支）'],
  [/呜咽/, null, 'se_whimper', '很低很低的呜咽（分支）'],
  [/枪声|一枪/, null, 'se_gunshot', '分支里的枪声'],
  [/雨声/, null, '@amb:amb_rain', '雨声 → 打开天气层（不是一次性音）'],

  // ── 不是声音的「音效拍」──
  [/^就在这时/, null, null, '★ 节拍标记：下一条才是真正的爆炸，这里必须静默'],
];

/** 判断用的上下文窗口（前一条尾部 + 后一条头部） */
export const CTX_TAIL = 90;
export const CTX_HEAD = 90;

/**
 * 判定一条音效拍。
 * @param {string} text 音效拍文本（如 `砰！`）
 * @param {string} ctx  上下文（调用方拼好；测试时可只给 text）
 * @returns {{id: string|null, amb: string|null, rule: string|null, matched: boolean, fallback?: boolean}}
 */
export function classifySfx(text, ctx = '') {
  const t = String(text || '');
  for (const [wordRe, ctxRe, id, note] of SFX_RULES) {
    if (!wordRe.test(t)) continue;
    if (ctxRe && !ctxRe.test(ctx)) continue;
    const fallback = /★ 兜底/.test(note || '');
    if (typeof id === 'string' && id.startsWith('@amb:')) {
      return { id: null, amb: id.slice(5), rule: note, matched: true, fallback };
    }
    return { id: id ?? null, amb: null, rule: note, matched: true, fallback };
  }
  return { id: null, amb: null, rule: null, matched: false };
}

/** 从 beats 数组里取某条音效拍的上下文（前一条尾 + 后一条头） */
export function ctxOf(beats, i) {
  const tail = String(beats[i - 1]?.text || '').slice(-CTX_TAIL);
  const head = String(beats[i + 1]?.text || '').slice(0, CTX_HEAD);
  return `${tail} ${head}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ③ 环境音床：**与背景图一一对应**（起点同源 = bg-rules.mjs 判出来的 bg 文件名）
// ═══════════════════════════════════════════════════════════════════════════
//
// 按 bg 挂环境音的三个好处：① 唯一真源已经在 bg-rules 里判过了，不用第二套场景判据；
// ② 画面与声音天然同调；③ 换场景 = 换 bg = 换环境音，一个钩子搞定。
export const AMB_BY_BG = {
  'bg_city.png': 'amb_city',
  'bg_hospital.png': 'amb_hospital',
  'bg_safehouse.png': 'amb_safehouse',
  'bg_underground.png': 'amb_underground',
  'bg_warehouse.png': 'amb_warehouse',
  'bg_room.png': 'amb_room',
  'bg_livingroom.png': 'amb_livingroom',
  'bg_apartment.png': 'amb_apartment',
  'bg_cabin.png': 'amb_cabin',
  'bg_helicopter.png': 'amb_helicopter',
  'bg_library.png': 'amb_library',
  'bg_manor.png': 'amb_manor',
  'bg_hall.png': 'amb_hall',
  'bg_stage.png': 'amb_stage',
  'bg_corridor.png': 'amb_corridor',
  'bg_ruin.png': 'amb_ruin',
};

/** 环境音是**叠加层**（不随场景关）：天气等 */
export const AMB_LAYERS = new Set(['amb_rain']);

export function ambForBg(bg) {
  return AMB_BY_BG[bg] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ④ 自检 / 报告
// ═══════════════════════════════════════════════════════════════════════════

/** 规则里引用到的全部 id（含环境层），供 verify 比对清单 */
export function referencedIds() {
  const out = new Set();
  for (const [, , id] of SFX_RULES) {
    if (typeof id !== 'string') continue;
    out.add(id.startsWith('@amb:') ? id.slice(5) : id);
  }
  for (const id of Object.values(AMB_BY_BG)) out.add(id);
  return out;
}

/** 跑一遍主线+分支的判定，打印逐条结果（给主人复核用） */
export function report(beats, label = '主线') {
  const rows = [];
  for (let i = 0; i < beats.length; i++) {
    if (beats[i].t !== 'sfx') continue;
    const ctx = ctxOf(beats, i);
    const c = classifySfx(beats[i].text, ctx);
    rows.push({ i, text: beats[i].text, ...c });
  }
  console.log(`\n【${label}】音效 ${rows.length} 条`);
  let miss = 0, fb = 0;
  for (const r of rows) {
    const to = r.amb ? `→ 环境层 ${r.amb}` : r.id ? `→ ${fileOf(r.id)}` : '→ 静默';
    const flag = r.matched ? (r.fallback ? '⚠兜底' : '  ') : '✗未命中';
    if (!r.matched) miss++;
    if (r.fallback) fb++;
    console.log(`  ${String(r.i).padStart(5)} 「${r.text}」 ${flag} ${to.padEnd(30)} ${r.rule || ''}`);
  }
  console.log(`  未命中 ${miss} · 兜底 ${fb}`);
  return { rows, miss, fb };
}

// ── CLI ──
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const ML = path.join(HERE, 'mainline');
  const mainline = JSON.parse(readFileSync(path.join(ML, 'beats-with-meta.json'), 'utf8'));
  report(mainline, '主线');

  // 分支：branches.mjs 里的 BRANCH_POINTS[].setup / ENDS[].beats / DEATH_HINT.beats
  const { BRANCH_POINTS = [], ENDS = [], DEATH_HINT } = await import('./branches.mjs');
  const collect = (arr) => (Array.isArray(arr) ? arr.filter((b) => b && b.t === 'sfx') : []);
  const bBeats = [
    ...BRANCH_POINTS.flatMap((bp) => collect(bp.setup)),
    ...ENDS.flatMap((e) => collect(e.beats)),
    ...collect(DEATH_HINT?.beats),
  ];
  if (bBeats.length) report(bBeats, '分支（分支点 setup / END / 死亡提示）');

  const refs = referencedIds();
  const unknown = [...refs].filter((id) => !BY_ID.has(id));
  const unused = [...BY_ID.keys()].filter((id) => !refs.has(id) && !BY_ID.get(id).hidden);
  console.log(`\n清单 ${BY_ID.size} 条 · 规则引用 ${refs.size} 条`);
  if (unknown.length) console.log(`  ✗ 规则引用了清单里没有的 id：${unknown.join(', ')}`);
  if (unused.length) console.log(`  · 清单里未被规则引用（隐藏件/素材库）：${unused.join(', ')}`);
  console.log(`  音效目录 ${SFX_DIR}${existsSync(SFX_DIR) ? '（已存在）' : '（★ 还没生成，跑 make-sfx.py）'}`);
}
