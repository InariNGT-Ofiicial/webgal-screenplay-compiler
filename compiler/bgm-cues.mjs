/**
 * bgm-cues.mjs —— 「剧幕 → 配乐落点」的**唯一实现**
 * ===========================================================================
 * 产物 = WebGAL 场景里的 `bgm:<file> -volume= -enter=;` 指令。
 *
 * ★★ 本文件是**示例版**。曲库与落点表都是占位，请换成你自己作品的：
 *    ① 改 `LIBRARY`（曲目清单）
 *    ② 改 `SLOT_PROFILE`（槽位画像：一类情绪配什么气质的曲子）
 *    ③ 填 `SCENE_CUE`（哪一幕用哪个槽位）—— **不填编译会中止**，见下
 *    **机制部分（分槽 / 复音策略 / 人声政策 / 音量归一）直接沿用即可。**
 *
 * ── 为什么落点表要跟编译期强绑 ─────────────────────────────────────────────
 * ★ WebGAL **没有 bgm 不会报错，只会静音** —— 跟「jumpLabel 悬空」同一类静默故障。
 *   少落一幕，玩家不会觉得"坏了"，只会觉得"这里怪怪的"。
 *   ⇒ `build-demo.mjs` 在编译期逐幕核对：查不到就**中止编译**并把幕名打出来。
 *
 * ── 两条重要的设计取舍（原项目踩出来的，不是偏好）─────────────────────────
 * ★ ① **复音策略**：`'per-slot'` 让同一个槽位在全篇复用同一首（建立听觉语汇）；
 *      `'per-scene'` 按幕轮换候选池（变化多但削弱动机联想，也更吃体积）。
 *      标准 VN 的 BGM 本来就只有 10~20 首，**重复不是偷懒，是语汇**。
 * ★ ② **人声政策**：背景配乐**一律不用带人声的曲子**。三条硬约束：
 *      ① 歌词与旁白**同时占据语言通道**，玩家会漏读；
 *      ② 人声会把叙事往"情绪片"拉，与政治惊悚的调门冲突；
 *      ③ 若曲子设定为"剧中乐队的歌"，放错场景就变成**叙事错误**
 *         （玩家会以为台上真有人在唱）。
 *      唯一例外 = **叙事内音乐（diegetic music）**：剧本明确写了"有人在唱/在哼"的地方，
 *      这时不出人声反而是错的 ⇒ 只有 `song_that_one` 槽位 `allowVocal: true`。
 *
 * ── 没随仓提供的部分（诚实说明）───────────────────────────────────────────
 * 原实现还有**第二种落点模式**：把「哪一段用哪首」外包给模型/人工，回包落在
 * `bgm-brief/answer.json`，按**放映段落**（而非剧幕）落点，并带一整套回包校验。
 * 那条线属于内容生产线，**本示例版不提供** ⇒ `ANSWER_ACTIVE` 恒为 `false`，
 * `build-demo.mjs` 里对应的分支不会被走到（文件内已标注）。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ═══════════════════════════════════════════════════════════════════════════
//  ① 曲库（占位）
//     真实使用时把 `file` 换成你落在 `game/bgm/` 下的文件名即可 ——
//     **命名即契约**：同名覆盖，零代码改动。
// ═══════════════════════════════════════════════════════════════════════════

/** 曲目字段：id / title / file / group（气质分类）/ bpm / cen（谱心，对数域 Hz）/ vocal */
export const LIBRARY = [
  { id: 't01', title: '示例曲 01 · 静',   file: 'bgm_calm.mp3',    group: 'calm',    bpm: 70,  cen: 700,  vocal: false },
  { id: 't02', title: '示例曲 02 · 日常', file: 'bgm_daily.mp3',   group: 'daily',   bpm: 96,  cen: 1200, vocal: false },
  { id: 't03', title: '示例曲 03 · 紧张', file: 'bgm_tension.mp3', group: 'tension', bpm: 112, cen: 1700, vocal: false },
  { id: 't04', title: '示例曲 04 · 追击', file: 'bgm_action.mp3',  group: 'action',  bpm: 138, cen: 2100, vocal: false },
  { id: 't05', title: '示例曲 05 · 悲',   file: 'bgm_sorrow.mp3',  group: 'sorrow',  bpm: 62,  cen: 600,  vocal: false },
  { id: 't06', title: '示例曲 06 · 仪式', file: 'bgm_ritual.mp3',  group: 'ritual',  bpm: 84,  cen: 1000, vocal: false },
  { id: 't07', title: '示例曲 07 · 终局', file: 'bgm_end.mp3',     group: 'end',     bpm: 58,  cen: 520,  vocal: false },
  { id: 't08', title: '示例曲 08 · 剧中曲', file: 'bgm_song.mp3',  group: 'diegetic', bpm: 104, cen: 1400, vocal: true  },
];

/** 库内序号（1 起）→ 稳定文件名。同一首被多段引用也只占一个文件。 */
export function fileForTrack(track) {
  const idx = LIBRARY.findIndex((x) => x.file === track.file) + 1;
  if (!idx) throw new Error(`曲目不在库中：${track.title}`);
  return `bgm_tk_${String(idx).padStart(2, '0')}.mp3`;
}

/** 判定"是否带人声"。示例版按显式字段判；真实曲库若没有这个字段，可按曲名标记判。 */
export const isVocal = (track) => Boolean(track.vocal);

// ═══════════════════════════════════════════════════════════════════════════
//  ② 槽位画像 —— 一类情绪配什么气质的曲子
//     scene = 气质分类（对应 LIBRARY 的 group）
//     bpm/cen = 目标（BPM 八度容忍 / 谱心对数域，用于挑候选）
//     vol     = WebGAL `-volume`（**艺术加减**，不是响度补偿 ——
//               响度应在离线阶段统一拉平，别指望这里对齐）
//     allowVocal = 只有"叙事内音乐"才配 true
// ═══════════════════════════════════════════════════════════════════════════

export const SLOT_PROFILE = {
  title:          { group: 'ritual',  bpm: 84,  cen: 1000, vol: 100, allowVocal: false,
                    use: '标题画面', want: '纪念碑式、暗、能循环 —— 给全作定调，不要剧透情绪' },
  opening:        { group: 'action',  bpm: 138, cen: 2100, vol: 92,  allowVocal: false,
                    use: '开场强拍', want: '一上来就把气势立住' },
  main:           { group: 'daily',   bpm: 96,  cen: 1200, vol: 82,  allowVocal: false,
                    use: '日常推进', want: '不抢戏，能长时间铺着' },
  quiet:          { group: 'calm',    bpm: 70,  cen: 700,  vol: 76,  allowVocal: false,
                    use: '静场 / 独白', want: '留白，让文字自己说话' },
  tension:        { group: 'tension', bpm: 112, cen: 1700, vol: 86,  allowVocal: false,
                    use: '对峙 / 悬疑', want: '压迫感，但别提前爆' },
  action:         { group: 'action',  bpm: 138, cen: 2100, vol: 92,  allowVocal: false,
                    use: '冲突 / 追逐', want: '推进力强' },
  sorrow:         { group: 'sorrow',  bpm: 62,  cen: 600,  vol: 78,  allowVocal: false,
                    use: '别离 / 失去', want: '克制，不要煽' },
  end:            { group: 'end',     bpm: 58,  cen: 520,  vol: 88,  allowVocal: false,
                    use: 'END 结局', want: '收束感，能挂住尾巴' },
  hint:           { group: 'calm',    bpm: 70,  cen: 700,  vol: 70,  allowVocal: false,
                    use: '吐槽出口 / 提示', want: '轻，随时可切走' },
  song_that_one:  { group: 'diegetic', bpm: 104, cen: 1400, vol: 96, allowVocal: true,
                    use: '叙事内音乐（剧中有乐队在唱/在哼）', want: '★ 唯一允许人声的槽位' },
};

/** 槽位顺序 = 报告与落盘清单的顺序，也让"决策"可复现 */
export const SLOTS = Object.keys(SLOT_PROFILE);

// ═══════════════════════════════════════════════════════════════════════════
//  ③ 选曲：从候选池里按 BPM / 谱心挑最近的一首
// ═══════════════════════════════════════════════════════════════════════════

/** BPM 八度容忍距离（60 与 120 视作同族，避免"慢版"永远输给"快版"） */
export function bpmDistance(bpm, target) {
  const d = Math.abs(Math.log2(bpm / target));
  return Math.min(d, Math.abs(Math.log2((bpm * 2) / target)), Math.abs(Math.log2(bpm / (target * 2))));
}

/** 谱心距离（对数域，越近越像） */
export function foldBpm(cen, target) {
  return Math.abs(Math.log2(cen / target));
}

/**
 * 选曲：优先同 group；同 group 里再按 BPM+谱心距离挑。
 * `prefer` 可给一个曲名，命中即直接采用（用于导演想亲自点名的场合）。
 */
export function pickTrack(slot) {
  const prof = SLOT_PROFILE[slot];
  if (!prof) return null;
  const pool = LIBRARY.filter((t) => t.group === prof.group && (prof.allowVocal || !isVocal(t)));
  const usable = pool.length ? pool : LIBRARY.filter((t) => prof.allowVocal || !isVocal(t));
  if (!usable.length) return null;
  return usable
    .slice()
    .sort((a, b) =>
      (bpmDistance(a.bpm, prof.bpm) + foldBpm(a.cen, prof.cen)) -
      (bpmDistance(b.bpm, prof.bpm) + foldBpm(b.cen, prof.cen)))[0];
}

function toCue(slot, variant = 1) {
  const prof = SLOT_PROFILE[slot];
  const track = pickTrack(slot);
  if (!prof || !track) return null;
  return {
    slot, variant,
    title: track.title,
    file: track.file,
    group: track.group,
    bpm: track.bpm,
    cen: track.cen,
    volume: prof.vol,
    allowVocal: prof.allowVocal,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ④ 落点表 —— **这一份要你自己填**
//
//  键 = `normScene(章号, 幕名)`；值 = 槽位名（见 SLOT_PROFILE）。
//  ★ 键**不写空格**：`normScene` 会去掉幕名里的空白，手写时别带空格。
//  ★ build-demo 会逐幕核对，漏一幕就中止编译 —— 这是**故意的**：
//    WebGAL 缺 bgm 只静音不报错，编译期不拦就没人拦得住。
// ═══════════════════════════════════════════════════════════════════════════

export const SCENE_CUE = {
  // 示例（换成你自己剧本的「章|幕」）：
  // '1|序幕':        'opening',
  // '1|日常的早晨':  'main',
  // '2|对峙':        'tension',
  // '2|独白':        'quiet',
  // '3|诀别':        'sorrow',
};

/** END / 吐槽出口 / 叙事内音乐 —— 不按幕走，由编译期显式发射 */
export const FIXED_CUE = {
  death:          toCue('end'),
  hint:           toCue('hint'),
  song_that_one:  toCue('song_that_one'),
};

export const TITLE_CUE = toCue('title');

/** 转场淡入时长（秒）。分场景 / 结局 / 提示 / 剧中曲四档。 */
export const FADE = { scene: 1, end: 2, hint: 2, song: 3 };

/** 复音策略：'per-slot'（同槽复用，建立语汇）| 'per-scene'（按幕轮换） */
export const REPEAT_MODE = 'per-slot';

/** 变奏表（同一槽位的第 N 变奏）。示例版留空。 */
export const VARIANTS = {};

// ═══════════════════════════════════════════════════════════════════════════
//  ⑤ 派生视图 —— build-demo 只用这几个
// ═══════════════════════════════════════════════════════════════════════════

/** 归一化幕名：`章|幕`，去掉幕名里所有空白（否则带空格的幕名会全被误判为"没落点"） */
export const normScene = (ch, scene) => `${ch}|${String(scene || '').replace(/\s+/g, '')}`;

/** normKey → cue。build-demo 用它做"每一幕都有配乐"的核对 */
export const CUE_BY_SCENE = Object.fromEntries(
  Object.entries(SCENE_CUE).map(([k, slot]) => [k, toCue(slot)]),
);

/** 查一幕的配乐。查不到返回 null（编译期会先拦下，不会走到这里） */
export function cueForScene(ch, scene) {
  return CUE_BY_SCENE[normScene(ch, scene)] || null;
}

/** 去重后的落盘清单（报告用） */
export function allCueFiles() {
  return [...new Set([...Object.values(CUE_BY_SCENE), TITLE_CUE, ...Object.values(FIXED_CUE)]
    .filter(Boolean).map((c) => c.file))];
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⑥ 回包模式占位（本示例版不提供，见文件头「没随仓提供的部分」）
// ═══════════════════════════════════════════════════════════════════════════

const ANSWER_PATH = path.join(ROOT, 'bgm-brief', 'answer.json');
/** 恒为 false：回包模式的实现未随仓提供 ⇒ build-demo 里那条分支不会被走到 */
export const ANSWER_ACTIVE = existsSync(ANSWER_PATH) && false;
export const ANSWER_PROBLEMS = [];
export const SEGMENT_CUES = new Map();
export const segmentCueAt = (i) => SEGMENT_CUES.get(i) ?? null;
