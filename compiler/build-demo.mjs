/**
 * build-demo.mjs —— 把「主线 + 死亡分支」编译成 WebGAL 原生场景
 *
 * 本文件是本仓库的**主入口**：把主线指令流写成 WebGAL 能吃的**静态场景文件**。
 *   本项目（编译层）负责「把演什么写成文件」· WebGAL（上游，只读）负责「怎么演出来」
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  本版新增：死亡分支接入（6 分支点 / 8 条 END）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  分支数据源：`branches.mjs`
 *
 *  场景文件结构：
 *
 *      label:main_start;
 *      …主线…                        ← 每个分支点插入 label + choose
 *      jumpLabel:_vn_main_end;       ← ★ 跳过下面的 END 区块
 *
 *      label:_END_1; … jumpLabel:_DEATH_HINT;      ← 八条 END
 *      …
 *      label:_DEATH_HINT; … end;                    ← 共享吐槽出口
 *
 *      label:_vn_main_end; setVar:…; end;           ← 主线正常结局
 *
 *  ★ 为什么把 END 区块放在主线之后、并用 jumpLabel 跳过：
 *    WebGAL 是**线性执行**，label 是 no-op。若 END 区块夹在主线中间，
 *    线性流会直接贯穿进去。放在末尾 + 显式跳过，是唯一无歧义的结构。
 *
 *  ★★ 一个必须防的坑：**静默贯穿**
 *    `jumpLabel` 找不到目标时**不报错**，只是不跳，执行继续往下走 ——
 *    结果是玩家在「正确路线」上突然看到 END。
 *    所以本脚本在写盘前做**静态校验**：所有 jumpLabel / choose 的目标
 *    必须在同一文件里有唯一的 `label:`。缺一个就中止编译。
 *
 * ★ 它读什么、写什么
 *   读：`compiler/mainline/{beats,beats-with-meta,story}.json` —— 由 docx-to-mainline.mjs 产出
 *       可选的外部扩展文件（**本仓不含**；有就走增强模式，没有就退规则模式）：
 *         `bgm-brief/answer.json`（配乐回包）· `voice-brief/lines.json`（语音清单）
 *   写：`webgal-tool/dist/game/` —— 上游 WebGAL 发行版的地盘，不是本仓内容
 *
 * ★ 缺产物时不甩 ENOENT 堆栈，而是打印「三步恢复指引」并明确中止。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { escapeText as esc } from '../production/src/script.mjs';
import { BRANCH_POINTS, ENDS, DEATH_HINT } from './branches.mjs';
import { bgForScene } from './bg-rules.mjs';
import {
  classifySfx, ctxOf, ambForBg, playArgs, BY_ID as SFX_BY_ID,
} from './sfx-rules.mjs';
import { indexBeats, resolveAnchor } from './anchor.mjs';
import { editorialReason, EDITORIAL_NOTE } from './editorial.mjs';
import {
  cueForScene, FIXED_CUE, TITLE_CUE, FADE,
  SCENE_CUE, CUE_BY_SCENE, normScene, LIBRARY,
  ANSWER_ACTIVE, ANSWER_PROBLEMS, SEGMENT_CUES, segmentCueAt,
} from './bgm-cues.mjs';
import { ROOT, SCENE_DIR, mainlineSceneName, mainlineScenePath } from './paths.mjs';

const ML = path.join(ROOT, 'compiler', 'mainline');

// ★ 主线产物的文件名从 `paths.mjs` 取（唯一真源）。想改名：`--scene=xxx.txt`。
const MAINLINE_SCENE = mainlineSceneName();

// ★ 本仓库不含剧本文本。缺产物时给一条能照做的指引，而不是甩 ENOENT 堆栈。
{
  const need = ['beats.json', 'beats-with-meta.json', 'story.json'].map((f) => path.join(ML, f));
  const miss = need.filter((f) => !existsSync(f));
  if (miss.length) {
    console.error('✗ 缺少剧本产物，无法编译场景：');
    miss.forEach((f) => console.error('   · ' + path.relative(ROOT, f)));
    console.error('');
    console.error('  本仓库不含任何具体作品的剧本文本。请先准备你自己的剧本，按顺序跑：');
    console.error('     1) python compiler/extract-docx.py <你的剧本.docx>   # → mainline-src/script.json');
    console.error('     2) node   compiler/docx-to-mainline.mjs              # → mainline/');
    console.error('     3) node   compiler/build-demo.mjs                    # → webgal-tool/dist/game/scene/');
    console.error('');
    console.error('  详见 README「快速开始」。');
    process.exit(1);
  }
}

const beats = JSON.parse(readFileSync(path.join(ML, 'beats.json'), 'utf8'));
const meta = JSON.parse(readFileSync(path.join(ML, 'beats-with-meta.json'), 'utf8'));
const story = JSON.parse(readFileSync(path.join(ML, 'story.json'), 'utf8'));

const CHAR_NAME = Object.fromEntries((story.characters || []).map((c) => [c.id, c.name]));

// ═══════════════════════════════════════════════════════════════════════════
//  角色语音挂载（可选 · 默认关闭，不影响现有产物）
// ═══════════════════════════════════════════════════════════════════════════
//
//  读 `voice-brief/lines.json`（配音包清单），把**已出片**的台词挂上
//  WebGAL 原生的 `-vocal=` 字段（资源落 game/vocal/，引擎会阻塞到播完
//  并按 -figureId 做口型同步，见工作区 AGENTS.md §3.7）。
//
//  ★ 为什么默认关闭：
//    配音包可能只出了一部分（全量约 2 小时）。若默认全挂，
//    没出的那些会让引擎去请求不存在的文件 —— WebGAL 侧只 logger.warn，
//    玩家侧表现为「有台词没声音」，而编译日志一切正常，**最难自查**。
//    ⇒ 只挂 `rendered === true` 的，且开关显式打开。
//
//  用法：
//    node compiler/build-demo.mjs                 # 默认不挂（与以前一致）
//    VN_VOCAL=1 node compiler/build-demo.mjs      # 挂上已出片的语音
//
const VOCAL_ON = process.env.VN_VOCAL === '1';
const VOCAL_MAP = new Map();   // beats 下标 → 文件名
//
// ★ beats.json 与 beats-with-meta.json 的**索引完全对齐**，
//   而 voice-brief/lines.json 的 `src` 存的是 **beats-with-meta 的下标**。
//   ⇒ 用 Map 按对象引用查下标即可互查，不需要重新匹配文本。
const beatIdx = new Map(beats.map((b, i) => [b, i]));
if (VOCAL_ON) {
  const lp = path.join(ROOT, 'voice-brief', 'lines.json');
  if (existsSync(lp)) {
    const vdoc = JSON.parse(readFileSync(lp, 'utf8'));
    const lines = vdoc.lines || [];

    // ── ★ 挂载前自检：`src` 必须真的指向「文本与它一致」的那条 say ──
    //
    //   为什么必须检：`sayLine()` 是拿 **beats 下标**去查表的。如果 `src` 存的是
    //   **say 序号**（0,1,2,…）而不是 beats 下标，查表照样"有结果"——
    //   只是挂到了**别人的台词**上。全程不报错，只有进游戏才听得出来。
    //   切分器改动后真实发生过：lines.json 里的条数**一条都对不上**，
    //   且行序还因断框合并整体前移。
    const nSay = beats.filter((b) => b.t === 'say').length;
    const bad = [];
    let nChecked = 0;
    let nSkipped = 0;
    for (const x of lines) {
      // ★ 只检查**将要被挂载**的条目。
      //
      //   为什么：`rendered === false`（或 `src == null`）的条目**根本不会进 VOCAL_MAP**，
      //   它们对渲染没有任何影响 ⇒ 拿它们报错是**假警报**。
      //   2026-10-04 实测：放宽到「包含」后仍剩 23 条报错，
      //   逐条查下来 **全部 rendered=false**（都是「已并入相邻组合并」的片段）。
      if (!x.rendered || x.src == null) { nSkipped++; continue; }
      nChecked++;
      const b = beats[x.src];
      const btxt = (b && b.text) || '';
      const txt = x.text || '';
      // ① 完全相等（常规情况）
      // ② lines 被 say 包含（断框把多句并成 1 句 ⇒ lines 是该 say 的片段）
      // ③ 反向包含且溢出 ≤ 12 字（片段跨 say 接缝，前半在 A 尾、后半在 B 头）
      //    ★ 溢出上限防「一条长文本蒙中多条短 say」的假通过。
      const ok = b && b.t === 'say' && txt && (
        btxt === txt
        || btxt.includes(txt)
        || (btxt && txt.includes(btxt) && txt.length - btxt.length <= 12)
      );
      if (!ok) bad.push(x);
    }
    if (bad.length) {
      console.error(`\n✗ 语音表与当前剧本对不上：${bad.length}/${nChecked} 条（say 框共 ${nSay}，将挂载 ${nChecked} 条）`);
      console.error(`  第一个错的：第 ${bad[0].i} 条`);
      console.error(`    表里写：「${bad[0].text.slice(0, 30)}」`);
      const b0 = beats[bad[0].src];
      console.error(`    src=${bad[0].src} 实际是：${b0 ? `[${b0.t}]「${(b0.text || '').slice(0, 30)}」` : '（越界）'}`);
      console.error('  原因通常是二者之一（都要查）：');
      console.error('    · `src` 存的是 **say 序号** 而不是 beats 下标');
      console.error('    · 断框规则改过（改 text-split.mjs）⇒ 行序跟着变，表已过期');
      console.error('  正解：重新生成你的配音清单（产线不在本仓，见本文件头部「它读什么」）。');
      console.error('  ★ 宁可**不挂语音**，也不要把 A 的语音挂到 B 的台词上（那是静默错配）。\n');
      process.exit(1);
    }

    let n = 0;
    for (const x of lines) {
      if (x.rendered && x.src != null) {
        VOCAL_MAP.set(x.src, x.file);
        n++;
      }
    }
    console.log(`  语音挂载：${n}/${lines.length} 句已出片，将挂 -vocal（自检通过）`);
  } else {
    console.log('  [warn] VN_VOCAL=1 但找不到 voice-brief/lines.json —— 本次不挂语音');
    console.log(`         期望位置: ${lp}`);
  }
}

/**
 * 生成一条 say 语句（含可选的角色语音挂载）。
 * @param {string} text  台词文本（未转义）
 * @param {string} who   角色 id
 * @param {number} idx   该 beat 在 beats 数组里的下标（用于查语音表）
 */
function sayLine(text, who, idx) {
  const spk = esc(CHAR_NAME[who] || who);
  // ★ -figureId 恒挂：挂上没副作用，缺了它口型动画没地方挂
  let extra = ` -figureId=${esc(who)}`;
  if (VOCAL_ON) {
    const f = VOCAL_MAP.get(idx);
    if (f) extra += ` -vocal=${esc(f)}`;
  }
  return `say:${esc(text)} -speaker=${spk}${extra};`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  场景标题 → 背景
// ═══════════════════════════════════════════════════════════════════════════

// 背景规则已抽到 ./bg-rules.mjs（单一来源：build-demo 与 segments.mjs 共用）

// ═══════════════════════════════════════════════════════════════════════════
//  转义
// ═══════════════════════════════════════════════════════════════════════════

/** WebGAL 场景脚本的转义：冒号/分号/花括号/竖线 */
// Shared with the production layer; imported above without compiler side effects.

// ═══════════════════════════════════════════════════════════════════════════
//  分支锚点校验（锚点必须唯一命中，否则玩家可能在错的地方看到选项）
// ═══════════════════════════════════════════════════════════════════════════

const anchorAt = new Map(); // beatIndex -> branchPoint

/**
 * ★ 锚点匹配必须**按内容、不能按框边界**。
 *
 * 老实现是 `b.text === bp.anchor` —— **逐框精确相等**。这等于把分支点
 * 钉死在"文本框怎么切"上：2026-10-03 修了切分器的孤字问题，
 * 框边界一变，BP1 的锚点「小队的风险系数最高。」就不再等于任何一框 ⇒ 编译中止。
 *
 * 而 `branches.mjs` 里写锚点的本意是「**这一刻的剧情位置**」，与排版无关。
 * ⇒ 正解：把全文拼成一条字符串按**子串**找位置，再定位到该位置所属的框。
 *   （同族教训见 AGENTS.md：「下标对齐很脆 ⇒ 用内容对齐」。锚点本来就是内容，
 *     只是之前被匹配在了错误的粒度上。）
 */
const _idx = indexBeats(beats);

for (const bp of BRANCH_POINTS) {
  const hits = resolveAnchor(_idx, bp.anchor);
  if (hits.length !== 1) {
    console.error(`✗ 分支点 ${bp.id} 的锚点命中 ${hits.length} 处（必须恰好 1 处）`);
    console.error(`  锚点文本：「${bp.anchor}」`);
    console.error('  锚点不唯一 ⇒ 选项可能出现在错误的位置。中止编译。');
    process.exit(1);
  }
  anchorAt.set(hits[0], bp);
}
console.log(`✓ 分支锚点全部命中（按内容子串匹配，不依赖断框）：${BRANCH_POINTS.map((b) => b.id).join(' ')}`);

/**
 * ★ 交付边界：剧本里**不允许**出现编辑层表述（预告 / 卷末旗标）。
 *
 * 转换器（`docx-to-mainline.mjs`）已经丢了这两处；这里再拦一道，因为
 * 「漏一处在场景里」的症状是**静默多印一句话** —— 玩家读到「敬请期待 第四章」
 * 只会觉得出戏，不会知道是编译漏了。这类"不报错、只是不该出现"的 bug 在本项目
 * 已经吃过多次（见 AGENTS.md）。
 *
 * ★ 判定用**同一个** `editorial.mjs`，不在这里重抄词表 —— 两处各写一份必然漂移。
 */
{
  const leaked = beats.map((b, i) => [i, b.text || '']).filter(([, t]) => editorialReason(t));
  if (leaked.length) {
    console.error(`✗ 剧本里有 ${leaked.length} 处编辑层表述（预告 / 卷末旗标）—— 不该进场景：`);
    for (const [i, t] of leaked) console.error(`   · beat#${i} 「${t}」`);
    console.error(`  ${EDITORIAL_NOTE}`);
    console.error('  正解：修 `compiler/docx-to-mainline.mjs`（它负责丢弃），再重跑转换。中止编译。');
    process.exit(1);
  }
  console.log('✓ 无编辑层表述（预告 / 卷末旗标已在转换期丢弃）');
}

// ═══════════════════════════════════════════════════════════════════════════
//  编译
// ═══════════════════════════════════════════════════════════════════════════

const out = [];
const stats = {
  say: 0, narrate: 0, sfx: 0, bg: 0, show: 0, chapter: 0, bgm: 0, card: 0, amb: 0,
  bp: 0, options: 0, ends: 0, endBeats: 0, hintBeats: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
//  ★ BGM 落点校验：正片里出现的**每一幕**都必须能在 bgm-cues.mjs 里查到配乐。
//
//  为什么要在编译期拦：WebGAL 没有 bgm 就**静音**，不报错、不留日志 ——
//  跟"jumpLabel 悬空"是同一类静默故障。少落一幕，玩家只会觉得"这里怪怪的"。
//  查不到就中止编译，把剧幕名打出来。
// ═══════════════════════════════════════════════════════════════════════════

{
  // ★ 两种落点模式：
  //   ① 回包模式（bgm-brief/answer.json 存在）：按**放映段落**落点（105 段），
  //      段落由 compiler/segments.mjs 按真实放映时长 + 自然断点切出
  //   ② 规则模式：按**幕**落点，选曲由 bgm-cues.mjs 的规则算出
  if (ANSWER_ACTIVE) {
    const hard = ANSWER_PROBLEMS.filter((p) => !p.startsWith('（统计）'));
    if (hard.length) {
      console.error('✗ bgm-brief/answer.json 有问题，先修回包（或删掉该文件回退规则模式）：');
      hard.slice(0, 12).forEach((p) => console.error('   · ' + p));
      if (hard.length > 12) console.error(`   …另有 ${hard.length - 12} 处`);
      console.error('   详情：node compiler/bgm-cues.mjs --check-answer');
      process.exit(1);
    }
    console.log(`✓ 配乐回包已接入：${SEGMENT_CUES.size} 个放映段落（模式 per-segment）`);
    console.log(`  ${ANSWER_PROBLEMS.find((p) => p.startsWith('（统计）'))?.replace('（统计）', '').trim()}`);
  } else {
    const scenes = new Map(); // normKey -> 原始幕名
    meta.forEach((m) => {
      if (m && m._scene) scenes.set(normScene(m._ch, m._scene), `第${m._ch}章 ${m._scene}`);
    });
    const missing = [...scenes].filter(([k]) => !CUE_BY_SCENE[k]);
    // ★ 反向也要**归一化后**比，否则带空格的幕名（ch7/ch8）会全被误报成"没对应剧幕"
    const unused = Object.keys(SCENE_CUE).filter((k) => {
      const [ch, ...rest] = k.split('|');
      return !scenes.has(normScene(ch, rest.join('|')));
    });
    if (missing.length) {
      console.error('✗ 以下剧幕在 bgm-cues.mjs 里查不到配乐（会导致这一幕静音）：');
      missing.forEach(([, label]) => console.error('   · ' + label));
      console.error('  请在 compiler/bgm-cues.mjs 的 SCENE_CUE 里补上。中止编译。');
      process.exit(1);
    }
    if (unused.length) {
      console.warn('⚠ bgm-cues.mjs 里有 ' + unused.length + ' 条落点没有对应剧幕（可能是幕名改了）：');
      unused.forEach((k) => console.warn('   · ' + k));
    }
    console.log(`✓ BGM 落点已覆盖全部 ${scenes.size} 幕（曲库 ${LIBRARY.length} 首）`);
  }
}

out.push('; ══════════════════════════════════════════════════════');
out.push('; 《示例剧作》主线 + 死亡分支 · WebGAL 原生场景');
out.push(';');
out.push('; 由 compiler/build-demo.mjs 从 mainline/beats.json + branches.mjs 编译生成。');
out.push('; 主线文本来自「examples/script.docx」（已标注说话人）。');
out.push('; 死亡分支来自 AVG剧情分支设计.md（6 分支点 / 8 条 END）。');
out.push('; 立绘与背景为占位图（纯 Node 手写 PNG 生成），非真实美术资源。');
out.push(';');
out.push('; ★ 分支结构：分支点用 choose 跳转；正确选项回到主线，错误选项跳 END 区块。');
out.push(';   END 区块在文件末尾，由主线的 jumpLabel 跳过（WebGAL 是线性执行）。');
out.push('; ══════════════════════════════════════════════════════');
out.push('');
out.push('label:main_start;');
out.push('changeBg:bg_hall.png;');
out.push('setVar:_vn_chapter=1;');
out.push('');

// ── 配乐发射器 ──
// ★ WebGAL 的每条 `:` 旁白/对白**都要等玩家点击**才往下走。所以如果 `bgm:` 落在
//   第一条旁白之后（第一版就是这样），玩家不点第一下就**没有音乐** —— 开场是静的。
//   ⇒ 首幕/首段的 BGM 必须**提前到入口**（label:main_start 之后立刻发）。
//
// ★ `dedupe` 只给**主线**用：`bgm:` 是"重新起播"，若相邻段落沿用同一首（回包里的
//   `keep_prev`）却又发一次 `bgm:`，曲子会从头重放 —— 恰恰破坏 keep_prev 的意义。
//   ★ 但 END / 吐槽 / BP4 区块**绝不能去重**：它们是编译期顺序生成的，
//     8 条 END 用同一首 death，去重会把后 7 个的 `bgm:` 全吞掉 ⇒
//     运行时走到第 5 条 END，放的会是上一幕的场景配乐（**静默错配**）。
let curBgmFile = null;
function emitBgm(cue, fade, note, dedupe = false) {
  if (!cue) return;
  if (dedupe && curBgmFile === cue.file) return; // 同一首不重发
  if (note) out.push(`; ♪ ${note} · ${cue.title}（${cue.group} ${cue.bpm}bpm/谱心${cue.cen}）`);
  out.push(`bgm:${cue.file} -volume=${cue.volume} -enter=${fade};`);
  curBgmFile = cue.file;
  stats.bgm++;
}
/** 首段/首幕的 BGM 要在入口处提前发（WebGAL 每条旁白都要等点击，晚了开场就没音乐） */
const FIRST_CUE = (() => {
  if (ANSWER_ACTIVE) {
    const first = [...SEGMENT_CUES.values()].sort((a, b) => a.i0 - b.i0)[0];
    return first ? { when: first.i0, cue: first, label: `首段 ${first.segId} ${first.seg.act}` } : null;
  }
  const f = meta.find((m) => m && m._scene);
  return f ? { when: normScene(f._ch, f._scene), cue: cueForScene(f._ch, f._scene), label: `首幕 ${f._scene}` } : null;
})();
if (FIRST_CUE?.cue) {
  emitBgm(FIRST_CUE.cue, FADE.scene, `${FIRST_CUE.label}（提前到入口，否则要等玩家点一下才响）`, true);
}

let curBg = 'bg_hall.png';
let onStage = new Set();
let lastCh = null;
let lastScene = null;

// ═══════════════════════════════════════════════════════════════════════════
//  全局音效：两层通道
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 机制（读上游源码得出，见 sfx-rules.mjs 文件头）：
//   · **一次性音效**：`playEffect:<file> -volume=N`，**单声道** —— 发新的一条会掐掉上一条。
//     所以「砰！砰！砰！」必须是一条预先合成的音频，不能连发三条指令。
//   · **环境音床**：带 `-id=` 就是循环，多个不同 id 可以共存；
//     停它用 `playEffect:none -id=<id>`（unmount 发生在源码里 `if (!url)` 早退之前）。
//   · 效果音**没有淡入淡出** ⇒ 环境音是硬切，只能靠场景切点掩盖。
//
// ★ 环境音 = 两层：**场景层**（随 bg 走，换场景即换）+ **叠加层**（天气等，不随场景关）。
let curAmb = null;          // 当前场景环境音 id
const ambLayers = new Set(); // 当前开着的叠加层

// ★ 开场就必须有环境音：第一幕的 bg 与初值相同 ⇒ `setBg` 不会触发，
//   若不管，整场第一章都是"干"的（只有 BGM 没有空间感）。
setAmb(ambForBg(curBg));

/** 只发环境音的指令，不碰 bg */
function setAmb(next) {
  if (next === curAmb) return;        // 同一床不重发（重发 = 从头起播，会听到断点）
  if (curAmb) out.push(`playEffect:none -id=${curAmb};`);
  curAmb = next || null;
  if (curAmb) {
    out.push(`playEffect:${playArgs(curAmb)} -id=${curAmb};`);
    stats.amb = (stats.amb || 0) + 1;
  }
}

/** 叠加层开关（天气） */
function setLayer(id, on) {
  if (on === ambLayers.has(id)) return;
  if (on) {
    ambLayers.add(id);
    out.push(`playEffect:${playArgs(id)} -id=${id};`);
  } else {
    ambLayers.delete(id);
    out.push(`playEffect:none -id=${id};`);
  }
  stats.amb = (stats.amb || 0) + 1;
}

/**
 * 换背景 + 顺带换环境音（**唯一入口**）。
 * ★ 六个原先各自 `out.push('changeBg:…')` 的地方全部改走这里 ——
 *   否则"换背景"与"换环境音"迟早漂移（本项目纪律：同一份规则只能有一处实现）。
 * ★ 这里**不负责清台**：主线与分支区块的清台时机不同（分支区块进块前已自己清过），
 *   统一在这里清会把分支区块里正在场的角色抹掉。清台仍由各自调用点负责。
 */
function setBg(bg, note) {
  if (!bg || bg === curBg) return;
  if (note) out.push(`; ▣ ${note}`);
  out.push(`changeBg:${esc(bg)};`);
  curBg = bg;
  stats.bg++;
  setAmb(ambForBg(bg));
}

/** 该分支点被触发时的舞台快照（供 END 区块精确清台用） */
const bpOnStage = new Map();

/** 站位轮转：同一个场景内多角色对话，分配到 left / center / right */
const SLOT_CYCLE = ['center', 'left', 'right'];

const slotArg = (slot) => (slot && slot !== 'center' ? ` -${slot}` : '');

function showFigure(who, slot) {
  out.push(`changeFigure:${esc(who)}.png${slotArg(slot)} -id=${esc(who)};`);
}

function hideFigure(who) {
  out.push(`changeFigure: -id=${esc(who)};`);
}

function clearStage(set) {
  out.push('changeFigure:;');
  for (const w of set) out.push(`changeFigure: -id=${esc(w)};`);
}

/**
 * 音效拍 → 指令（主线 / 分支**共用这一处实现**）。
 *
 * ★ 三层判定（规则在 sfx-rules.mjs，唯一真源）：
 *   ① 判成「环境层」（如剧本里的「雨声」）→ 开叠加层，不占文本框；
 *   ② 判到一次性音效 → 发 `playEffect:`，**不再写文本框**：
 *      拟声词现在由**声音**承担；留在文本框里会让玩家为一次枪响多点一下，把节奏打断。
 *   ③ 判成「静默节拍」（如「就在这时——」，真正的爆炸在下一拍）或**资产缺失**（会 404）
 *      → 回退成原来的〔演出文本〕。**绝不静默丢演出信息**（本项目纪律）。
 */
function emitSfx(b, beatsArr, idx) {
  const ctx = beatsArr ? ctxOf(beatsArr, idx) : '';
  const c = classifySfx(b.text, ctx);
  stats.sfx++;
  if (c.amb) {
    setLayer(c.amb, true);
    out.push(`; ♪ [音效] ${c.rule}`);
    return;
  }
  if (c.id && SFX_BY_ID.has(c.id)) {
    out.push(`; ♪ [音效] ${c.rule}`);
    out.push(`playEffect:${playArgs(c.id)};`);
    return;
  }
  if (c.id && !SFX_BY_ID.has(c.id)) {
    console.warn(`⚠ 音效 id 不在清单里：${c.id} —— 回退为演出文本`);
  } else if (c.matched) {
    out.push(`; ♪ [音效] 静默节拍：${c.rule}`);
    return;
  }
  out.push(`:${esc('〔' + (b.text || '') + '〕')};`);
}

/**
 * 主线的单条指令。
 */
// ═══════════════════════════════════════════════════════════════════════════
//  章节卡（作者 2026-10-03：章不该写在文本框里）
// ═══════════════════════════════════════════════════════════════════════════
//
// 原来章标题是**一行旁白**（`—— 第一章：示例章节 ——`），跟台词一起推进。
// 作者要求改成「**切片动画**」⇒ 用 WebGAL 原生的 `intro:`（全屏卡片演出），
//   它自带 `-animation=` 选项，其中 `revealAnimation` 正是 **clip-path 从左侧切片揭开**
//   （见 `Stage/FullScreenPerform/fullScreenPerform.module.scss` 的 `@keyframes revealAnimation`）。
//
// ★ **幕标题（`【第一幕：xxx】`）是直接删掉**，不做卡 —— 作者明确说「直接删掉」。
//   幕/章的身份并没有丢失：每个拍上都有 `_ch` / `_scene` 元数据，下游（配乐分段、
//   美术分包、落点表）都读元数据，不读这行文本。
//
// ★ 将来美术出了章节卡图，**同名丢进 `game/background/` 即可**（`ch_1.png`…），
//   本函数会自动挂 `-backgroundImage=` —— 与立绘/背景同一套「同名覆盖、零代码改动」约定。
const CARD_DIR = path.join(ROOT, 'webgal-tool', 'dist', 'game', 'background');

/** 章标题 → 卡片文本（去掉作者用来包边的 `—— … ——`） */
function cardTitle(text) {
  return (text || '').replace(/^\s*——\s*/, '').replace(/\s*——\s*$/, '').trim();
}

/** 章标题 → 背景图 id（如 `第一章：示例章节` → `ch_1`）；有图才挂 */
function cardBg(ch) {
  const f = `ch_${ch}.png`;
  return existsSync(path.join(CARD_DIR, f)) ? f : '';
}

function emitChapterCard(m, title) {
  const bg = cardBg(m._ch);
  // ★ 底色改成**冷色径向渐变**而非纯黑 —— 2026-10-03 改。
  //   理由（真机量出来的，不是审美偏好）：纯黑卡 + `revealAnimation` 的**打字机半途状态**
  //   会被**误认为黑屏**（实测：舞台中位亮度 15、
  //   高对比仅 26）。加渐变 + 视觉锚后这一帧明显"是章卡"。
  //   判据只能是**像素**，且只看稳态帧：量舞台中位亮度与大对比度，
  //   别拿「控制台没报错」当结论（那正是这一类坑骗人的地方）。
  //   ★ `-backgroundColor=` 的值被源码**直接赋给 style.backgroundColor**，
  //     所以这里可以写**任意合法 CSS**（含渐变），不必去 CSS 里用 !important 硬压行内样式。
  //   ★ 美术出图后 `-backgroundImage=` 会盖住它，这层只是"没图时"的兜底。
  const opts = [
    '-animation=revealAnimation',   // ★ 切片揭示
    '-fontSize=large',
    '-delayTime=3000',              // 卡片停留 ≈ 4s（含 1s 收尾等待）
    '-backgroundColor=radial-gradient(120% 90% at 50% 42%, #232a31 0%, #161b20 48%, #0b0e11 100%)',
    '-fontColor=rgba(238,241,244,1)',
    bg ? `-backgroundImage=${bg}` : '',
  ].filter(Boolean).join(' ');
  out.push(`; ── 章节卡 ${m._ch}${bg ? `（背景 ${bg}）` : ''} ──`);
  out.push(`intro:${esc(title)} ${opts};`);
  stats.card++;
}

function emitBeat(b, m, beatsArr, idx) {
  // ★ 章标题 → 全屏切片卡，**不进文本框**
  if (m && m._src === 'generated' && m._how === 'chapter') {
    emitChapterCard(m, cardTitle(b.text));
    return;
  }
  // ★ 「敬请期待 第N章…」这种预告：若紧邻的章标题与它重复，就不再单独出一张卡
  if (m && m._src === 'generated' && m._how === 'notice') {
    const dup = beats.some((x, k) => meta[k] && meta[k]._how === 'chapter'
      && Math.abs(k - beatIdx.get(b)) <= 2 && cardTitle(b.text).includes(cardTitle(x.text)));
    if (dup) {
      out.push(`; （跳过与紧随其后的章标题重复的预告：${cardTitle(b.text)}）`);
      return;
    }
    emitChapterCard(m, cardTitle(b.text));
    return;
  }
  if (b.t === 'narrate') {
    out.push(`:${esc(b.text)};`);
    stats.narrate++;
    return;
  }
  if (b.t === 'sfx') {
    emitSfx(b, beatsArr, idx);
    return;
  }
  if (b.t === 'say') {
    const who = b.who;
    if (!who || who === 'narrator') {
      out.push(`:${esc(b.text)};`);
      stats.narrate++;
      return;
    }
    if (!onStage.has(who)) {
      const slot = SLOT_CYCLE[onStage.size % SLOT_CYCLE.length];
      showFigure(who, slot);
      onStage.add(who);
      stats.show++;
    } else {
      const slot = SLOT_CYCLE[[...onStage].indexOf(who) % SLOT_CYCLE.length];
      showFigure(who, slot);
    }
    if (VOCAL_ON) {
      out.push(sayLine(b.text, who, beatIdx.get(b)));
    } else {
      out.push(`say:${esc(b.text)} -speaker=${esc(CHAR_NAME[who] || who)};`);
    }
    stats.say++;
  }
}

for (let i = 0; i < beats.length; i++) {
  const b = beats[i];
  const m = meta[i] || {};

  // ── 配乐落点 —— ★ 必须放在"换幕"块**外面** ──
  //   段落边界**不保证**落在幕边界上（一个 21 分钟的幕会被切成 6 段，中间几段都在幕内），
  //   所以段落命中检查不能塞进 `if (m._scene !== lastScene)` 里 —— 那样只有幕首那一段会生效。
  if (ANSWER_ACTIVE) {
    const c = segmentCueAt(i);
    if (c && c.i0 !== FIRST_CUE?.cue?.i0) {
      emitBgm(c, FADE.scene, `${c.segId} ${c.seg.act}（放映 ${Math.round(c.seg.sec[1])}s）`, true);
    }
  }

  // ── 换章 / 换场景 → 换背景 + 打场景标题（规则模式下也在这里换 BGM）──
  if (m._scene && m._scene !== lastScene) {
    let sample = '';
    for (let k = i; k < Math.min(i + 10, beats.length); k++) sample += (beats[k].text || '') + ' ';
    const bg = bgForScene(m._scene, sample);
    if (bg !== curBg) {
      clearStage(onStage);
      onStage.clear();
      setBg(bg);
    }
    if (!ANSWER_ACTIVE) {
      const cue = cueForScene(m._ch, m._scene);
      if (!cue) {
        console.error(`✗ 剧幕无配乐：第${m._ch}章 ${m._scene}（本该被上游校验拦住）`);
        process.exit(1);
      }
      // 首幕的配乐已在 main_start 处提前发过，这里不重复（否则同一首会重启，有突兀的起播）
      if (normScene(m._ch, m._scene) !== FIRST_CUE?.when) {
        emitBgm(cue, FADE.scene, `${cue.slot}#${cue.variant}`, true);
      }
    }
    if (m._ch && m._ch !== lastCh) lastCh = m._ch;
    // ★ 幕标题**不再写进文本框**（作者 2026-10-03：「xx幕不要写在文本框里直接删掉」）。
    //   幕的身份没丢：`m._scene` 仍在每个拍上，下游按元数据取。
    //   `lastScene` 仍要更新 —— 它驱动"换幕时换背景"。
    lastScene = m._scene;
  }

  // ── 指令 ──
  emitBeat(b, m, beats, i);

  // ── 分支点：本条之后插入 choose ──
  const bp = anchorAt.get(i);
  if (bp) {
    bpOnStage.set(bp.id, new Set(onStage));
    stats.bp++;

    out.push('');
    out.push(`; ──────────────── 分支点 ${bp.id} · ${bp.title} ────────────────`);
    out.push(`label:${bp.label};`);

    // ★ BP4「那首歌」是**叙事内音乐**：角色在掩体后真的哼出了那首歌 ——
    //   这里换一轨示例乐队的歌，与全篇的"背景配乐"刻意区分开。
    if (bp.id === 'BP4') {
      emitBgm(FIXED_CUE.song_that_one, FADE.song, '叙事内音乐（那首歌）');
    }

    // 分镜：确认背景（与主线猜测比对，不同才换）
    setBg(bp.bg);

    // 分镜：战术事实回显（全部取自原文）
    const setupArr = bp.setup || [];
    for (let k = 0; k < setupArr.length; k++) emitBranchBeat(setupArr[k], { onStageLocal: onStage, bp, arr: setupArr, k });

    // 选项
    const opts = bp.options.map((o) => {
      const target = o.correct ? `${bp.label}_ok` : (ENDS.find((e) => e.id === o.end) || {}).label;
      if (!target) {
        console.error(`✗ 分支点 ${bp.id} 的选项「${o.text}」找不到目标 END：${o.end}`);
        process.exit(1);
      }
      stats.options++;
      return `${esc(o.text)}:${target}`;
    });
    out.push(`choose:${opts.join('|')};`);
    out.push(`label:${bp.label}_ok;`);
    out.push(`setVar:_vn_choice_${bp.id.toLowerCase()}=ok;`);
    out.push('');
  }
}

// ── 主线结尾：跳过 END 区块 ──
out.push('');
out.push('; ── 主线正常结局（真 END）──');
out.push('jumpLabel:_vn_main_end;');

// ── END 区块 ──
out.push('');
out.push('; ══════════════════════════════════════════════════════');
out.push(';  死亡分支 · 八条 END');
out.push(';  ★ 只有示例主角会死。每条 END 的五段：');
out.push(';    ②③ 第一后果 → ④ 死因 → ⑤ 死后的那一拍（世界继续运转）');
out.push('; ══════════════════════════════════════════════════════');

const endFinalStage = new Map(); // endId -> Set（留给吐槽出口清台用）

for (const e of ENDS) {
  stats.ends++;
  const snap = bpOnStage.get(e.from) || new Set();
  const castIds = e.cast.map(([w]) => w);
  const toHide = new Set([...snap, ...castIds]);

  out.push('');
  out.push(`; ── ${e.title} · 死因：${e.cause} ──`);
  out.push(`label:${e.label};`);
  out.push(`setVar:_vn_ending=${e.id};`);
  out.push(`setVar:_vn_choice_${e.from.toLowerCase()}=death;`);
  out.push('filmMode:on;');
  clearStage(toHide);
  setBg(e.bg);
  out.push(`; ── END 统一配乐（刻意不选哀乐，走"讽刺/荒诞"而不是"煽情"）──`);
  emitBgm(FIXED_CUE.death, FADE.end, 'END');

  const stage = new Set();
  for (const [w, slot] of e.cast) {
    showFigure(w, slot);
    stage.add(w);
  }

  for (let k = 0; k < e.beats.length; k++) {
    emitBranchBeat(e.beats[k], { onStageLocal: stage, end: e, arr: e.beats, k });
    stats.endBeats++;
  }

  out.push('filmMode:none;');
  out.push(`jumpLabel:${DEATH_HINT.label};`);
  endFinalStage.set(e.id, new Set(stage));
}

// ── 共享吐槽出口 ──
out.push('');
out.push('; ── 共享吐槽出口（对标 FSN「老虎道场」）──');
out.push('; 不让玩家觉得「我杀死了她」，让另一个角色替玩家表达不解');
out.push(`label:${DEATH_HINT.label};`);

const hintHide = new Set([
  ...DEATH_HINT.cast.map(([w]) => w),
  ...ENDS.flatMap((e) => e.cast.map(([w]) => w)),
]);
clearStage(hintHide);
setBg(DEATH_HINT.bg);
out.push(`; ── 吐槽出口换音色：与 END 的低谱心刻意错开 ＝ 提示"已经出戏了" ──`);
emitBgm(FIXED_CUE.hint, FADE.hint, '吐槽出口');
const hintStage = new Set();
for (const [w, slot] of DEATH_HINT.cast) {
  showFigure(w, slot);
  hintStage.add(w);
}
const hintArr = [...DEATH_HINT.beats, ...DEATH_HINT.closing];
for (let k = 0; k < hintArr.length; k++) {
  emitBranchBeat(hintArr[k], { onStageLocal: hintStage, hint: true, arr: hintArr, k });
  stats.hintBeats++;
}
out.push('end;');

// ── 主线正常结局 ──
out.push('');
out.push('label:_vn_main_end;');
out.push('setVar:_vn_ending=TRUE_END;');
out.push('end;');
out.push('');

/**
 * 分支区块（END / 吐槽出口 / 分支点 setup）的单条指令。
 *
 * 与主线 emitBeat 的区别：**舞台状态是区块私有的** ——
 * 进入区块前已清台，区块自己维护 onStageLocal，不污染主线的 onStage。
 */
function emitBranchBeat(b, ctx) {
  const stage = ctx.onStageLocal;

  if (b.t === 'clear') {
    clearStage(new Set(stage));
    stage.clear();
    return;
  }
  if (b.t === 'bg') {
    setBg(b.name);
    return;
  }
  if (b.t === 'show') {
    showFigure(b.who, b.slot);
    stage.add(b.who);
    stats.show++;
    return;
  }
  if (b.t === 'hide') {
    hideFigure(b.who);
    stage.delete(b.who);
    return;
  }
  if (b.t === 'wait') {
    out.push(`wait:${Number(b.ms) || 800};`);
    return;
  }
  if (b.t === 'sfx') {
    emitSfx(b, ctx.arr, ctx.k);
    return;
  }
  if (b.t === 'narrate') {
    out.push(`:${esc(b.text)};`);
    stats.narrate++;
    return;
  }
  if (b.t === 'say') {
    const who = b.who;
    if (!who || who === 'narrator') {
      out.push(`:${esc(b.text)};`);
      stats.narrate++;
      return;
    }
    if (!stage.has(who)) {
      showFigure(who, 'center');
      stage.add(who);
      stats.show++;
    }
    if (VOCAL_ON) {
      // ★ 分支台词不在主线 beats 数组里（来自 branches.mjs 的新增内容），
      //   beatIdx.get(b) 会是 undefined ⇒ 本次不挂语音。
      //   分支语音要单独出一批（本仓不含配音产线，需要时自行补）。
      out.push(sayLine(b.text, who, beatIdx.get(b)));
    } else {
      out.push(`say:${esc(b.text)} -speaker=${esc(CHAR_NAME[who] || who)};`);
    }
    stats.say++;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ★ 静态校验：所有 jumpLabel / choose 的目标必须有唯一 label
//
//  为什么必须做：jumpLabel 找不到目标时**不报错**，执行会继续往下 ——
//  玩家在「正确路线」上会突然看到 END。这是静默污染，必须编译期拦住。
// ═══════════════════════════════════════════════════════════════════════════

const labelCount = new Map();
for (const l of out) {
  const m = l.match(/^label:(.+);$/);
  if (m) labelCount.set(m[1], (labelCount.get(m[1]) || 0) + 1);
}

const problems = [];
for (const [name, n] of labelCount) {
  if (n > 1) problems.push(`label 重复 ${n} 次：${name}（jumpToLabel 取最后一个，语义歧义）`);
}

const defined = new Set(labelCount.keys());
for (const l of out) {
  let m = l.match(/^jumpLabel:(.+);$/);
  if (m) {
    if (!defined.has(m[1])) problems.push(`jumpLabel 悬空：${m[1]}`);
    continue;
  }
  m = l.match(/^choose:(.+);$/);
  if (m) {
    for (const opt of m[1].split(/(?<!\\)\|/)) {
      const parts = opt.split(/(?<!\\):/g);
      const target = parts[1];
      if (!target) problems.push(`choose 选项缺少跳转目标：「${parts[0]}」`);
      else if (!defined.has(target)) problems.push(`choose 跳转悬空：${target}（选项「${parts[0]}」）`);
    }
  }
}

if (problems.length) {
  console.error('✗ 分支结构校验失败（会导致静默贯穿）：');
  problems.forEach((p) => console.error('   · ' + p));
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
//  写文件
// ═══════════════════════════════════════════════════════════════════════════

const scenePath = mainlineScenePath();
writeFileSync(scenePath, out.join('\n'), 'utf8');

// 分支数据落盘（给验收/后续工具用）
const branchesArtifact = {
  generatedFrom: ['mainline/beats.json', 'branches.mjs'],
  counts: {
    branchPoints: BRANCH_POINTS.length,
    endings: ENDS.length,
    options: BRANCH_POINTS.reduce((a, b) => a + b.options.length, 0),
  },
  branchPoints: BRANCH_POINTS.map((b) => ({
    id: b.id,
    title: b.title,
    chapter: b.ch,
    scene: b.scene,
    anchor: b.anchor,
    anchorIndex: beats.findIndex((x) => x.text === b.anchor),
    bg: b.bg,
    cast: b.stage,
    options: b.options,
  })),
  endings: ENDS.map((e) => ({
    id: e.id,
    title: e.title,
    from: e.from,
    cause: e.cause,
    bg: e.bg,
    cast: e.cast,
    beatCount: e.beats.length,
  })),
  hint: { label: DEATH_HINT.label, bg: DEATH_HINT.bg, cast: DEATH_HINT.cast },
};
writeFileSync(path.join(ML, 'branches.json'), JSON.stringify(branchesArtifact, null, 2), 'utf8');

// 入口指向它（无条件覆盖）
// ★ 编译器的职责就是产出**确定**的入口，不该有「看起来对就跳过」的判断。
//   （曾经有个守卫「若入口已指向某个旧场景就跳过」，结果是保留了旧指向。）
const startPath = path.join(SCENE_DIR, 'start.txt');
const START_BODY =
  '; 入口场景 —— 《示例剧作》主线\n' +
  ';\n' +
  '; 由 compiler/build-demo.mjs 接管，每次编译都会重写本文件。\n' +
  `changeScene:${MAINLINE_SCENE};\n`;

writeFileSync(startPath, START_BODY, 'utf8');
// ★ 另存一份「官方入口」：给 preview-branch.mjs 做开关用
//   （它把 start.txt 临时指向分支预览场景，关掉时从这里还原 —— 单一来源，不重复写字符串）
writeFileSync(path.join(SCENE_DIR, '_start_official.txt'), START_BODY, 'utf8');

// 标题配置
const cfgPath = path.join(ROOT, 'webgal-tool', 'dist', 'game', 'config.txt');
writeFileSync(
  cfgPath,
  [
    '; 《示例剧作》主线 · 配置',
    '; ★ Game_key 是存档标识，改 Game_name 时必须一并改',
    'Game_name:示例剧作;',
    'Game_key:example-vn-mainline;',
    'Title_img:ph_title.png;',
    `Title_bgm:${TITLE_CUE.file};`,
    'Enable_Appreciation:true;',
    'Enable_Continue:true;',
    'Enable_flowchart:true;',
    '',
  ].join('\n'),
  'utf8',
);

console.log('✓ 场景已生成：', path.relative(ROOT, scenePath));
console.log(
  `  ${out.length} 行 · 对白 ${stats.say} / 旁白 ${stats.narrate} / 音效 ${stats.sfx} / 背景切换 ${stats.bg} / 立绘上场 ${stats.show} / 章节卡 ${stats.card}`,
);
console.log(`✓ 配乐已接入：${stats.bgm} 处 bgm 指令` +
  (ANSWER_ACTIVE
    ? `（回包模式：${SEGMENT_CUES.size} 个放映段落，去重后实际换曲 ${stats.bgm - ENDS.length - 1 - 1} 次 + END/吐槽/那首歌固定落点）`
    : `（规则模式：每幕一首 + END/吐槽/那首歌固定落点）`));
console.log(`  标题画面 Title_bgm = ${TITLE_CUE.file}（${TITLE_CUE.title}）`);
console.log(`  曲目来源：你自己的曲库目录（本仓不含任何配乐，见 compiler/bgm-cues.mjs 的 LIBRARY）`);
console.log('');
console.log(`✓ 分支已接入：${stats.bp} 个分支点 · ${stats.options} 个选项 · ${stats.ends} 条 END`);
console.log(`  END 正文 ${stats.endBeats} 拍 + 吐槽出口 ${stats.hintBeats} 拍`);
const allLabels = [...labelCount.keys()];
console.log(`✓ 结构校验通过：${allLabels.length} 个 label，${stats.bp + stats.ends} 处跳转全部命中`);
console.log('');

// ── 章节卡样式（`intro` 默认是**左上角**，标题卡需要居中）──
//
// ★ 写在 `game/userStyleSheet.css`（WebGAL 官方的用户样式钩子，启动时加载）。
//   用**标记块**管理：只替换本块，用户在文件里写的其他规则一律不动。
//   ⇒ 幂等：重复编译不会堆叠，也不会误删作者的样式。
{
  const CSS_PATH = path.join(ROOT, 'webgal-tool', 'dist', 'game', 'userStyleSheet.css');
  const BEGIN = '/* === 章节卡（由 compiler/build-demo.mjs 维护，勿手工改本块）=== */';
  const END = '/* === /章节卡 === */';
  const BLOCK = [
    BEGIN,
    '/* intro 的容器本身不居中（源码里只有 padding），这里把它掰成标题卡 */',
    '#introContainer > div { display: flex; align-items: center; justify-content: center; }',
    '#introContainer > div > div { text-align: center; }',
    '/* 卡片上的字用衬线体更「章回」一些；缺字体时回落系统衬线 */',
    '#introContainer > div > div > div { font-family: "资源圆体", "Songti SC", "SimSun", serif; letter-spacing: 0.15em; }',
    '/* ★ 2026-10-03：章卡视觉锚 —— 让"打字机半途"的任何一帧都看得出这是章卡、不是黑屏。',
    ' *   真机量过：纯色底 + 少量白字时，',
    ' *   舞台中位亮度 15 / 高对比仅 26 ⇒ 观感就是"卡在黑屏里"。',
    ' *   加冷光刻度条 + 细横线 + 底色渐变后，高对比显著抬升，且与全片冷色基调一致。',
    ' *   ★ 底色本体在 build-demo 的 intro 指令里（近黑冷灰 #0d1013，非纯黑）。',
    ' *   本块是普通 CSS（userStyleSheet.css），伪元素可用。 */',
    '#introContainer > div {',
    '  background: radial-gradient(120% 90% at 50% 42%, #232a31 0%, #161b20 48%, #0b0e11 100%) !important;',
    '}',
    '#introContainer > div > div > div { position: relative; }',
    '#introContainer > div > div > div::before {',
    '  content: ""; display: block; width: 72px; height: 3px;',
    '  margin: 0 auto 1em; background: #9AA3AB; box-shadow: 0 0 12px rgba(154,163,171,0.55);',
    '}',
    '#introContainer > div > div > div::after {',
    '  content: ""; display: block; width: 210px; height: 1px;',
    '  margin: 1em auto 0;',
    '  background: linear-gradient(90deg, transparent, rgba(154,163,171,0.6), transparent);',
    '}',
    END,
  ].join('\n');
  const cur = existsSync(CSS_PATH) ? readFileSync(CSS_PATH, 'utf8') : '';
  let next;
  if (cur.includes(BEGIN) && cur.includes(END)) {
    next = cur.slice(0, cur.indexOf(BEGIN)) + BLOCK + cur.slice(cur.indexOf(END) + END.length);
  } else {
    next = (cur.trim() ? cur.replace(/\s*$/, '\n\n') : '') + BLOCK + '\n';
  }
  if (next !== cur) {
    writeFileSync(CSS_PATH, next, 'utf8');
    console.log('✓ 章节卡样式已写入 game/userStyleSheet.css');
  }
}

console.log('✓ 分支数据：mainline/branches.json');
console.log(`✓ 入口已更新：start.txt → ${MAINLINE_SCENE}`);
console.log('');
console.log('下一步：用任意静态服务器把 webgal-tool/dist 起成 http（file:// 会黑屏，见 docs/webgal-redlines.md §3.1）');
console.log('       例：npx serve webgal-tool/dist   或   python -m http.server -d webgal-tool/dist 8080');
