/**
 * docx-to-mainline.mjs —— 从「剧本合订本」生成主线
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  与旧版（novel-to-vn.mjs）的根本区别
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 旧版输入是**小说体**（_novel/*.full.txt）：台词只有引号、没有说话人，
 * 需要靠场景级算法推断 —— 结果 37% 分不出，只能标「？？？」。
 *
 * 新版输入是**已标注剧本**（`examples/script.docx`）：
 * 每行一个说话人，格式 `说话人（类型）：内容`。
 *   - 文档开头写明：「人物台词、旁白及声音按独立行标注；
 *     内心独白、录音、通讯、字幕和音效另作说明。」
 *
 * ⇒ **说话人不需要推断，直接读原文即可。** 那 37% 的问题自然消失。
 *
 * 实测：2750 个正文段，2746 个有前缀，只有 4 行无前缀（格式说明 + 章末标记）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  指令映射
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   `旁白：xxx`              → narrate（★ 作者要求：不带说话人）
 *   `示例主角：xxx`           → say
 *   `示例主角（内心独白）：x`  → say + mode=inner
 *   `示例角色F（录音）：xxx`      → say + mode=vo
 *   `严铁友（对讲机）：xxx`    → say + mode=radio
 *   `字幕（紧急新闻推送）：x`  → narrate + mode=subtitle
 *   `音效：轰！！！`           → sfx
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitText, cleanText, TRACE, SEG_STATS } from './text-split.mjs';
import { editorialReason } from './editorial.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 切分不变式统计（声明必须在最前 —— `chunksOf` 会在模块求值期被调用到）。 */
const splitStats = { calls: 0, lossy: [] };
const SRC = path.join(ROOT, 'compiler', 'mainline-src', 'script.json');
const OUT = path.join(ROOT, 'compiler', 'mainline');

/**
 * 单框字数上限的**唯一真源**已移到 ./textbox.mjs（真机实测的文本框几何）。
 * ★ 这里原来写着「由 32 改成 20，依据是编剧书」—— 那个 20 已经被证伪：
 *   实测文本框内容区 2022×234px、字号 52.48px、行高 2.2em ⇒ 每行约 35 全角字、2 行。
 *   详见 textbox.mjs 文件头。**不要在本文件重新定义上限。**
 */

// ═══════════════════════════════════════════════════════════════════════════
//  §3 主转换
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 被丢弃的**编辑层表述**（预告 / 卷末旗标）。见 ./editorial.mjs。
 * ★ 记录并打印，不静默丢 —— 这条纪律和切分的「无损不变式」是同一个道理。
 */
const droppedEditorial = [];

// ★ 本仓库不含任何具体作品的剧本文本。缺输入时给一条能照做的指引，
//   而不是甩一段 ENOENT 堆栈（堆栈只说明"文件不在"，不说明"我该干什么"）。
if (!existsSync(SRC)) {
  console.error('✗ 缺少中间输入，无法转换主线：');
  console.error(`   · ${path.relative(ROOT, SRC)}`);
  console.error('');
  console.error('  它是上一步的产物 —— 先把你自己的剧本 docx 抽成 JSON：');
  console.error('     python compiler/extract-docx.py <你的剧本.docx>');
  console.error('  然后回到本步：node compiler/docx-to-mainline.mjs');
  console.error('  详见 README「快速开始」。');
  process.exit(1);
}

const src = JSON.parse(readFileSync(SRC, 'utf8'));
if (process.argv.includes('--trace-split')) TRACE.on = true;

/**
 * 主要角色表：`角色名 → [id, 职责, 代表色]`。
 *
 * ★ **这是一张示例表** —— 实际使用时替换成你自己作品的角色即可。
 *   未列入的名字会被 `castOf()` 动态注册成龙套（`v01` 起编号），所以只列主要角色就行。
 *
 * ★★ **代表色一律写十六进制，不要写「金色」「白色」这类中文色名。**
 *   引擎的 `hueFromColor()` 只认 hex；写中文色名会**静默回退**到默认色相，
 *   于是名框 / 占位立绘 / 美术需求包一起拿到错色 —— **不报错，极难察觉**。
 *   **色值只有一处定义：本表。**
 *
 * ★ 这张表曾经丢过一次：把切分器抽成独立模块时误删了本段，而当时**没有版本管理**，
 *   只能从产物 `cast.json` 反推重建。**动这个文件前先提交一次** ——
 *   这是给一个「零依赖、clone 即跑」的项目引入 git 最直接的理由。
 */
const MAIN_CAST = {
  // ── 主要角色：id 用英文小写，代表色取 hex ──
  '示例主角': ['hero', '主角', '#7799CC'],
  '示例同伴': ['ally', '主角的同伴', '#779977'],
  '示例对手': ['rival', '对立阵营', '#BB9955'],
  '示例师长': ['mentor', '引路人', '#335566'],
  // ── 叙事性「声音」：只作说话人标签，不立绘 ──
  '电视声音': ['tv', '电视新闻播报', '#8A8A90'],
  '广播声音': ['radio', '广播', '#8A8A90'],
  // ── 非角色：保留语义标签，不立绘、不配音 ──
  '未知声音': ['unknown', '无法辨识身份的说话者', '剪影'],
  '字幕': ['subtitle', '屏幕文字（不发声）', '字幕'],
  '音效': ['sfx', '音效（不发声）', '音效'],
};

/** 动态角色注册表：name → {id, role, color} */
const cast = new Map();
for (const [name, [id, role, color]] of Object.entries(MAIN_CAST)) {
  cast.set(name, { id, name, role, color, main: true });
}
let extraSeq = 0;
function castOf(name) {
  if (cast.has(name)) return cast.get(name);
  const id = 'v' + String(++extraSeq).padStart(2, '0');
  const rec = { id, name, role: '次要角色 / 龙套', color: '#8A8A90', main: false };
  cast.set(name, rec);
  return rec;
}

/** 硬编码的静音前缀（不是角色） */
const SILENT = new Set(['旁白', '音效', '字幕']);

/**
 * 「说话人类型」→ 配音 `_mode`。
 *
 * ★ 这个函数也是 2026-10-03 误删后**从产物反推重建**的：
 *   把 `_bak_splitfix/beats-with-meta.json` 里 `(_type, _mode)` 的全部组合统计出来
 *   （68 种类型 / 11 个 mode），再归纳成下面这张有序规则表。
 *   验证方式：重跑转换后与备份逐条比对 `_mode`（见 test-split.mjs ③ 之后的回归段）。
 *
 * `_mode` 决定**配音的出片策略**（内心独白 / 窄带无线电 / 播音 / 人群…），
 * 漏用它 ⇒「内心独白」和「出声台词」听起来一模一样，玩家分不清在想还是在说。
 *
 * 顺序有意义 —— 越特殊的越靠前：
 *   · 「通讯提示」要在「通讯」之前（同族但走字幕）
 *   · 「加密通讯」走 radio，而「加密消息」走 subtitle ⇒ 只能按完整词匹配
 *   · 「韩军联合参谋本部命令」靠 `命令$` 命中 subtitle
 */
const MODE_RULES = [
  [/内心独白/, 'inner'],
  [/另一人格|人格切换/, 'alter'],   // ★ 示例：同一具身体里的第二人格，走独立声线
  [/回响|回忆/, 'memory'],
  [/通讯提示/, 'subtitle'],                                     // ★ 特例，必须早于 通讯
  [/加密消息|项目资料|匿名论坛|系统提示|实验记录|新闻推送|快讯|银行账户备注|U盘笔记|命令$|资料/, 'subtitle'],
  [/电视|警报系统|扬声器|扩音器|插播|声明/, 'media'],
  [/通讯|对讲机|无线电|耳机/, 'radio'],
  [/录音|遗稿/, 'vo'],
  [/视频通话|手机消息|通话窃听|群聊/, 'call'],
  [/同时|齐声|战场呼喊|观众席|人群|口号/, 'crowd'],
  [/档案库幸存者|监听报告|监视报告|扫描报告/, 'document'],
];

function modeOf(typeStr) {
  const t = typeStr || '';
  if (!t) return 'normal';
  for (const [re, mode] of MODE_RULES) if (re.test(t)) return mode;
  return 'normal';
}

const beats = [];
const meta = [];
const report = { say: 0, narrate: 0, sfx: 0, subtitle: 0, inner: 0, chapters: 0, scenes: 0, lines: 0, editorial: 0 };

let curPart = '', curChapter = '', curScene = '', curCh = 0;
let lineNo = 0;
/**
 * ★ 原文疏漏兜底：第 7 篇**没有「第七章」标题**，直接从「第7篇」跳到「第一幕」。
 *   若不处理，curCh 会停在第 6 章，整篇 7 的内容被算进第 6 章。
 *   机制：遇到「第N篇」时标记待补标题；若该篇始终没有章标题，
 *   就在它第一个幕之前用篇标题兜底插入。
 */
let partNeedsTitle = false;

/** 插入分区标题（旁白形式） */
function insertPartTitle(text) {
  beats.push({ t: 'narrate', text: `—— ${text} ——` });
  meta.push({
    t: 'narrate', text: `—— ${text} ——`,
    _ch: curCh, _scene: '', _line: 0,
    _src: 'generated', _conf: 'high', _how: 'chapter',
  });
}

const bullet = (who, text, extra) => {
  beats.push({ t: 'say', who, text, ...(extra || {}) });
};

for (const node of src.nodes) {
  const raw = node.text;

  // ── 标题：篇 / 章 / 幕 ──
  if (node.type === 'Heading1' || node.type === 'Heading2') {
    // 「第N篇」
    if (/^第\d+篇/.test(raw)) {
      curPart = raw;
      const n = Number(raw.replace(/[^0-9]/g, ''));
      if (n) curCh = n;
      partNeedsTitle = true;   // 等章标题来清；清不掉就用篇标题兜底
      continue;
    }
    // 「第N章：xxx」
    if (/第.+章/.test(raw)) {
      curChapter = raw;
      const m = raw.match(/第(\d+|[一二三四五六七八九十]+)章/);
      curCh = m ? cn2num(m[1]) : curCh + 1;
      partNeedsTitle = false;  // 有章标题了
      report.chapters++;
      insertPartTitle(raw);
      continue;
    }
    // 「第N幕：xxx」/「序幕：xxx」
    //   注意括号：^ 必须作用于整个交替式，否则「序幕」会匹配任意位置
    if (/^(第.+幕|序幕)/.test(raw)) {
      if (partNeedsTitle) {
        // ★ 兜底：这一篇没有章标题（实测第 7 篇如此），用篇标题代替
        insertPartTitle(curPart || `第${curCh}篇`);
        partNeedsTitle = false;
      }
      curScene = raw;
      report.scenes++;
      continue;
    }
    continue; // 其他标题（Title / 未识别的）忽略
  }

  if (node.type !== 'Paragraph') continue;
  if (!raw) continue;
  // 文档头部的格式说明
  if (raw.startsWith('人物台词、旁白')) continue;
  // 章末标记
  if (/^【第.+章，终】$/.test(raw)) continue;

  // ★ 编辑层表述（预告 / 卷末旗标）—— **不是剧本内容**，直接丢弃，不进 beats。
  //   作者 2026-10-03：「敬请期待 这种和剧本无关的表述删掉，现在交付的是连贯的
  //   剧本不需要画外音」。判据在 ./editorial.mjs（单一实现，编译期校验也用它）。
  //   ★ 这一行**不占 lineNo**（与上面的 `【第.+章，终】` 一致）——
  //     删掉的两处在源文档里分别是第 754 段与**最后一段**，所以行号不会重排，
  //     `line0/line1`（发给配乐外援的源文档行号）依旧可信。
  const editorial = editorialReason(raw);
  if (editorial) {
    droppedEditorial.push({ why: editorial, text: raw });
    continue;
  }

  /**
   * ★ 整行被【】包住的：是**预告 / 卷末标记**，不是台词。
   *   实例：`【敬请期待 第四章：示例章名】`
   *   不拦的话，正则会把「敬请期待 第四章」当说话人、「示例章名」当台词。
   */
  if (/^【.+】$/.test(raw)) {
    const t = raw.replace(/^【|】$/g, '').trim();
    beats.push({ t: 'narrate', text: `—— ${t} ——` });
    meta.push({
      t: 'narrate', text: `—— ${t} ——`,
      _ch: curCh, _scene: curScene, _line: 0,
      _src: 'generated', _conf: 'high', _how: 'notice',
    });
    report.narrate++;
    continue;
  }

  lineNo++;

  // ── 解析 `说话人（类型）：正文` ──
  const m = raw.match(/^([^：:]{1,30}?)(?:[（(]([^）)]{1,30})[）)])?\s*[：:]\s*([\s\S]*)$/);
  if (!m) {
    // 无前缀 → 按旁白处理（实测只有 4 条，已在上面过滤掉）
    beats.push({ t: 'narrate', text: cleanText(raw) });
    meta.push({ t: 'narrate', text: cleanText(raw), _ch: curCh, _scene: curScene, _line: lineNo, _src: 'noprefix', _conf: 'low', _how: 'noprefix' });
    report.narrate++;
    continue;
  }

  const name = cleanText(m[1]);
  const typeStr = m[2] ? cleanText(m[2]) : '';
  const body = cleanText(m[3] || '');
  if (!body) continue;

  const base = { _ch: curCh, _scene: curScene, _line: lineNo, _part: curPart, _type: typeStr };

  // ① 音效
  if (name === '音效') {
    for (const chunk of chunksOf(body, 20)) {
      beats.push({ t: 'sfx', name: 'sfx_' + chunk.slice(0, 8), text: chunk });
      meta.push({ t: 'sfx', name: 'sfx_' + chunk.slice(0, 8), text: chunk, ...base, _src: 'explicit', _conf: 'high', _how: 'sfx' });
      report.sfx++;
    }
    continue;
  }

  // ② 字幕 → narrate（屏幕文字，不发声）
  if (name === '字幕') {
    for (const chunk of chunksOf(body)) {
      beats.push({ t: 'narrate', text: chunk });
      meta.push({ t: 'narrate', text: chunk, ...base, _src: 'explicit', _conf: 'high', _how: 'subtitle', _mode: 'subtitle' });
      report.subtitle++;
      report.narrate++;
    }
    continue;
  }

  // ③ 旁白 → ★ narrate，不带说话人（作者明确要求）
  if (name === '旁白') {
    for (const chunk of chunksOf(body)) {
      beats.push({ t: 'narrate', text: chunk });
      meta.push({ t: 'narrate', text: chunk, ...base, _src: 'explicit', _conf: 'high', _how: 'narrate' });
      report.narrate++;
    }
    continue;
  }

  // ④ 角色台词
  //
  // ★ 三类特殊说话人，美术需求上要区别对待：
  //   ① 群体（`行动队员们` `倒戈警员们` `示例家守卫`）→ 群像，不是个体立绘
  //   ② 双人同说（`示例主角与示例角色C（同时）`）→ 复用两人已有的立绘
  //   ③ 广播/警报（已在 MAIN_CAST 里单独建 id）
  const isGroup = /们$|队员|警察|守卫|护卫|人群|观众|部队|族老们|士兵/.test(name);
  const duo = name.match(/^(.+?)与(.+)$/);

  // 双人同说 → who 取第一个，另一个记在 meta._also
  const primaryName = duo ? duo[1] : name;
  const rec = castOf(primaryName);
  const mode = modeOf(typeStr);
  // 显示名：有类型时保留类型（如「示例角色F（录音）」），信息更完整
  const display = typeStr ? `${name}（${typeStr}）` : name;

  for (const chunk of splitText(body)) {
    beats.push({ t: 'say', who: rec.id, text: chunk });
    meta.push({
      t: 'say', who: rec.id, text: chunk, speaker: display,
      ...base, _src: 'explicit', _conf: 'high', _how: 'labeled', _mode: mode,
      ...(isGroup ? { _group: true } : {}),
      ...(duo ? { _also: castOf(duo[2].replace(/[（(].*$/, '')).id } : {}),
    });
    report.say++;
    if (mode === 'inner') report.inner++;
  }
}

/**
 * 切分的**唯一入口**（带不变式校验）。
 *
 * ★ 为什么不让调用点直接 `splitText`：切分有一条必须成立的不变式 ——
 *   `join(chunks) === 输入`（逐字符无损）。它一旦破了，屏幕上会静默印出
 *   `M72LAW` 这种缺了空格的词，配音也会照着错的文本念，而**整个过程不报任何错**
 *   （实测真的发生过：见 text-split.mjs 文件头）。
 *   所以断言放在唯一入口上，而不是在产物里事后反查 ——
 *   反查要从产物重建"源段落"，而重建出来的未必等于切分器真正吃到的字符串。
 */
function chunksOf(body, maxBox) {
  const chunks = maxBox === undefined ? splitText(body) : splitText(body, maxBox);
  splitStats.calls++;
  const back = chunks.join('');
  if (back !== body) {
    splitStats.lossy.push({ body, back });
    if (splitStats.lossy.length <= 3) {
      console.error(`✗ 切分丢了字符：「${body.slice(0, 44)}」\n               →「${back.slice(0, 44)}」`);
    }
  }
  return chunks;
}

function cn2num(s) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  return map[s] || 0;
}

// ═══════════════════════════════════════════════════════════════════════════
//  §4 story 配置
// ═══════════════════════════════════════════════════════════════════════════

const characters = [...cast.values()].map((c) => ({
  id: c.id, name: c.name, role: c.role, color: c.color, main: c.main,
  emotions: ['neutral'],
}));
// 加上特殊角色（narrator 不需要，因为旁白不带 who）
characters.push({ id: 'narrator', name: '旁白', role: '幕外音', color: '—', main: false, emotions: ['neutral'] });

const story = {
  id: 'example-vn',
  title: '示例剧作',
  // ★★ 以下四项是**故事元信息**，会原样进入 LLM 的系统提示词。
  //    实际使用时替换成你自己作品的设定 —— 它们决定了模型「即兴发挥」的方向。
  world: '（示例世界观：在此一句话交代故事的时空与核心冲突）',
  tone: '（示例基调：用几个形容词约定叙述的语气，例如「冷静、克制，情感只在裂缝里出现」）',
  genre: '剧情 / 悬疑 AVG',
  characters,
  backgrounds: [
    '#1a1418', '#c8d4d8', '#2a2f36', '#243028',
    '#141a1e', '#241f1a', '#1a2228', '#384048', '#120c14',
  ],
  variables: {
    'trust.hero': { type: 'number', initial: 0, desc: '主角的信任' },
    'resolve': { type: 'number', initial: 0, desc: '面对真相的决心' },
  },
  startChapter: '第一章：示例章节',
  startBg: '#1a1418',
  contentGuard: '涉及现实政治实体时保持中性叙述，不做煽动性表达。',
  source: {
    file: 'examples/script.docx',
    format: '说话人（类型）：内容',
    note: '说话人由原文直接标注，无推断成分。旁白按作者要求不带说话人。',
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  §5 输出
// ═══════════════════════════════════════════════════════════════════════════

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// ★ 章节数按**实际出现的章号**统计，不用计数器累加 ——
//   有些篇没有规整的「第 N 章」标题（只有「第 N 篇」），是靠兜底进来的，
//   计数器会漏掉它 ⇒ 章数报少一个。
report.chapters = new Set(meta.map((m) => m._ch).filter(Boolean)).size;
report.scenes = new Set(meta.map((m) => m._ch + '§' + m._scene).filter((k) => !k.endsWith('§'))).size;
report.editorial = droppedEditorial.length;

writeFileSync(path.join(OUT, 'beats.json'), JSON.stringify(beats, null, 2), 'utf8');
writeFileSync(path.join(OUT, 'beats-with-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
writeFileSync(path.join(OUT, 'story.json'), JSON.stringify(story, null, 2), 'utf8');
writeFileSync(path.join(OUT, 'convert-report.json'), JSON.stringify(report, null, 2), 'utf8');

// 角色清单（供立绘生成）
writeFileSync(path.join(OUT, 'cast.json'), JSON.stringify(characters, null, 2), 'utf8');

console.log('✓ 主线已生成\n');

// ── 切分不变式报告（每次转换都印，不依赖 --trace-split）──────────────
if (splitStats.lossy.length) {
  console.error(`✗ 切分损失字符：${splitStats.lossy.length} / ${splitStats.calls} 次调用 —— 见 text-split.mjs 文件头的不变式。`);
  for (const x of splitStats.lossy.slice(0, 8)) {
    const i = [...x.body].findIndex((c, k) => c !== [...x.back][k]);
    console.error(`   第 ${i} 字处：源「${x.body.slice(Math.max(0, i - 14), i + 14)}」→ 产物「${x.back.slice(Math.max(0, i - 14), i + 14)}」`);
  }
  process.exit(1);
}
console.log(`✓ 切分无损校验通过：${splitStats.calls} 次切分，join 后与源文本一字不差`);

// ── 编辑层表述（预告 / 卷末旗标）—— 丢弃清单，每次都印 ──────────────
if (droppedEditorial.length) {
  console.log(`✓ 已丢弃编辑层表述 ${droppedEditorial.length} 处（不是剧本内容，不进场景）：`);
  for (const d of droppedEditorial) console.log(`    · [${d.why}] ${d.text}`);
  console.log('  ⇒ 判定词表见 compiler/editorial.mjs；编译期还会再拦一道（build-demo）。\n');
} else {
  console.log('· 编辑层表述：0 处（源文档干净）\n');
}

// ── 分词吸附自检（★ 静默降级是最贵的一类 bug，所以每次都报）──
if (SEG_STATS.realGaps) {
  console.error(`✗ 分词器吐出的 token 与原文对不上：${SEG_STATS.realGaps}/${SEG_STATS.segs} 段（吸附的"词边界"是错位的）`);
  SEG_STATS.gapSample.forEach((g) => console.error(`   例：${JSON.stringify(g)}`));
  process.exit(1);
}
if (!SEG_STATS.segs) {
  console.error('✗ 没有可用的中文分词器 ⇒ 硬切无法吸附词边界，断词会明显变多。');
  console.error('  安装：npm i --prefix "' + ROOT + '" segmentit');
  process.exit(1);
}
console.log(
  `✓ 分词吸附：${SEG_STATS.segs} 段 · 词边界对齐` +
  (SEG_STATS.spaceGaps ? ` · ${SEG_STATS.spaceGaps} 段含空格（分词器会吞空格，已按原文逐个 token 定位修正）` : '') +
  '\n',
);

// ── 切分器埋点统计（`--trace-split`）──
if (TRACE.on) {
  const L = TRACE.log;
  const hard = L.filter((x) => !x.clean);
  const byReason = {};
  for (const x of hard) byReason[x.reason] = (byReason[x.reason] || 0) + 1;
  console.log('── 切分器埋点（每处切口一条）──');
  console.log(`  切口总数 ${L.length}`);
  console.log(`  ✅ 在标点后切（不断词）: ${L.length - hard.length}`);
  console.log(`  ❌ 硬切（可能断词）    : ${hard.length}`);
  for (const [k, v] of Object.entries(byReason)) console.log(`       ${k}: ${v}`);
  const rescue = hard.filter((x) => x.pInWin).length;
  console.log(`  ⇒ 其中「窗口内有标点、被"尾巴够长"挡掉」= ${rescue}（放宽 maxBox 或尾巴判据可救）`);
  console.log(`  ⇒ 剩余 ${hard.length - rescue} 处是 **20 字上限下的物理下限**（窗口内真没标点）`);
  console.log('');
}
console.log('  指令总数 :', beats.length);
console.log('    对白   :', report.say, '（其中内心独白', report.inner, '）');
console.log('    旁白   :', report.narrate, '（其中字幕', report.subtitle, '）');
console.log('    音效   :', report.sfx);
console.log('    编辑层丢弃 :', report.editorial, '（预告 / 卷末旗标 —— 不属于剧本）');
console.log('  章节 :', report.chapters, '· 场景（幕）:', report.scenes);
console.log('  角色 :', characters.length, '（主要', characters.filter((c) => c.main).length, '+ 龙套', characters.filter((c) => !c.main && c.id !== 'narrator').length, '）');
console.log('');
console.log('  说话人分布（前 15）：');
const byWho = {};
for (const b of beats) if (b.t === 'say') byWho[b.who] = (byWho[b.who] || 0) + 1;
const nameOf = (id) => characters.find((c) => c.id === id)?.name || id;
Object.entries(byWho).sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([k, v]) => console.log('    ' + String(v).padStart(5) + '  ' + nameOf(k)));
