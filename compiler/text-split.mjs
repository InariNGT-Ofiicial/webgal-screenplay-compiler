/**
 * text-split.mjs —— 「长文本 → 文本框序列」的唯一实现
 *
 * 从 `docx-to-mainline.mjs` 里抽出来，**为了能单独测**。
 * （原来它埋在转换脚本内部，而那个脚本 import 就会跑完整转换，没法单测。）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  为什么会有这个模块（2026-10-03 作者指出的 bug）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  作者：「你切台词的时候至少得一行显示一个完整的句子吧，怎么会有字符孤零零的
 *         落在下一页的」
 *
 *  实测样例（修复前）：
 *      她紧紧攥着话筒，指关节因过度用力而泛起死 | 寂的青白色。     ← 「死寂」劈开
 *      活像个提线木偶，与舞台上这出盛大戏剧的疯 | 狂格格不入。     ← 「疯狂」劈开
 *      形成一道连接地狱与人间 | 的浑浊瀑布！                       ← 「人间的」
 *      距离最近的示例主角猛地掀飞出 | 去！                         ← 「出去」
 *
 *  全片统计（修复前）：源段落内切口 5465 处，**硬切 846 处（15.5%）**，
 *  另有 **231 个短于 6 字的框**。
 *
 *  根因：老代码在窗口里从后往前找标点，窗口下界写成 `maxBox * 0.4`（=8）：
 *      for (let i = min(len-1, maxBox-1); i > maxBox * 0.4; i--)
 *  于是「她紧紧攥着话筒，指关节…」里**唯一的逗号在第 7 字**被窗口挡掉 ⇒
 *  一个候选都没有 ⇒ 落到硬切 20 ⇒ 断在「死|寂」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  判据（按优先级）—— 2026-10-03 作者两次修正后的最终口径
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  ① **只在句末标点后断**（`。！？…`）。尾巴 ≥ 2 ——
 *     `去！` 是**完整短句**（不算断词），但 1 个字会造出「标点单独成框」的孤字。
 *  ② 窗口里没有句末标点 ⇒ 硬切。防孤字：
 *       · maxBox 之后还剩 ≥ MIN_BOX ⇒ 切 maxBox
 *       · 否则**对半分** —— 20+2 与 10+10 之间，均分最不容易被察觉
 *  ③ 切完再做**边界微调**（`P_LEAD` / `P_OPEN`）：框尾不许是 `，、；：` 或**开引号**，
 *     框首不许是闭引号 —— 一对引号必须同框。
 *
 *  ★ 作者：「一个框孤零零地以 `，` 结尾，看起来像话没说完就被切了」——
 *    这是对的：文本框的单位就是**句子**，逗号只是句内停顿，不该成为框的终点。
 *    ⚠️ 代价要知道：硬切率会上升（窗口里只有一个逗号、没有句末标点的段，只能硬切）。
 *    **这是有意的取舍** —— 断在无标点处的框，玩家不会注意；断出"未完成的句子"，每次都会看见。
 *    换这条判据时**必须重新记基线**，别拿旧数字自我安慰。
 *
 *  ★ 根本认识（没变）：**中文里标点就是词边界 —— 凡在标点后切都不会断词，只有硬切才会。**
 *    所以「能用句末标点就用」优先于「尽量装满」。
 */

/**
 * 单框字数上限 / 下限 —— **从 {./textbox.mjs} 来，不在本文件里拍**。
 *
 * ★ 2026-10-03 作者指正：我之前按「单行 8–10 字 × 2 行 = 20 字」定了 `MAX_BOX = 20`，
 *   而那个「8–10 字」**没有任何依据**。真机测下来一框能放 **70** 个全角字
 *   （内容区 2022×234px，字号 52.48px，字距 5.12px，行高 2.2em ⇒ 刚好 2 行）。
 *   ⇒ 20 字当上限，等于把一句普通长度的句子硬切成两三框。
 *   现在上限 = 物理上限的 80% = **56 字**（95% 的句子一框装得下）。
 */
export { MAX_BOX, MIN_BOX } from './textbox.mjs';
import { MAX_BOX, MIN_BOX } from './textbox.mjs';

/** 句末标点。★ **不含**右引号 `”’` —— 它们只是「引号闭合」，
 *  末尾跟着 `？` 时（`‘活体招牌’？`）在此切会留下单字符框，还会被左移保护毁掉切口。 */
export const P_END = /[。！？…]/;
/** 次级标点：**不作断点**，也不许出现在框的收尾/开头（见 `pickCut` 与下面的边界调整） */
export const P_MID = /[，、；：]/;
/**
 * **开引号 / 开括号** —— **绝不许出现在框尾**。
 *
 * ★ 作者 2026-10-03 报的开局 bug。源段
 *   `大剧院穹顶的巨大弧面，…由聚光灯精心编织的、名为“示例乐队”的谎言帷幕。`（73 字，必须切）
 *   被切成 `…名为“`（56 字）| `示例乐队”的谎言帷幕。` ——
 *   **开引号挂在框尾、被引的内容翻到下一页**，玩家第一眼看到的是「名为“」再翻页。
 *
 * 根因在 `chooseCut` 是**从 `maxBox` 往下找第一个合法点**：56 正好是 `Ave` 前那个词边界，
 * 于是被选中；而 `“` 既不是 ASCII（`noAscii` 放行），也不在 `P_MID` 里。
 *
 * ⇒ 规则与 `P_MID` 同族：**框尾不许是"未闭合"的标点**（开引号、开括号）。
 *   被引/被括的内容必须与引号同框。
 */
export const P_OPEN = /[“‘「『【《（(]/;
/**
 * 「单字虚词」—— 单独成词时**不能收尾、也不能起头**的字。
 *
 * ★ 作者 2026-10-03 第二轮的「切句问题」：全片实测 97 处（8.5%）切口落在这些字上，
 *   典型是 **`……的 ⟂ 名词`**（`以及她的 ⟂ 巨幅照片` / `匆忙经过的 ⟂ 回廊倒影`）
 *   与 **`…让 ⟂ 她想起`** / `…压向 ⟂ 台前`。
 *
 * ★★ **必须配 `isOneCharWord` 一起用，不能只看单字。**
 *   逐字匹配分不清 `是` 和 `但是`、`个` 和 `一个`、`更` 和 `更高`
 *   —— 而「但是 / 一个 / 更高」收尾完全正常。
 *   ⇒ 判据是「**这个字自己就是一个词**」（用分词器的词边界判），
 *     这样 `永远`(2字) 不触发、`远` 单独成词才触发。
 *
 * ★★ **只作「无遗憾改进」的判据，绝不单独强制。** 原因：
 *   这批切口**大多是"框尾不许 `，、；：`"这条硬规则的代价** ——
 *   中文里 `、` 本来就是并列项的自然断点，禁掉它之后，最靠右的合法词边界
 *   往往正好落在 `的` 后面。实测 `…鲜花、哭泣的人群、以及她的巨幅照片…`：
 *   往左找，`、` 两侧全被 `noMid` 挡掉（尾不行、首也不行），
 *   于是 `的` 之后就是唯一可用的点。
 *   ⇒ 所以规则设计成：**只有当"更靠左的合法切口恰好零瑕疵"时才改用它**，
 *     否则保持原状（宁可保留原有小瑕疵，也不换来一个更糟的）。
 *   ⇒ 换句话说：这条规则**只可能变好，不可能变坏**。
 */
export const P_FN = /[的地得着了过与和及为把被由对向从据按以给让使跟同比在是个种些更最而则却但若或之其此]/;

/**
 * `p` 处收尾的那个字，是不是**单独成词**（1 字词）。
 * `starts` 是该段的词首位置集合（绝对位置），`base` 是 `rest` 在段内的起点。
 * 没有分词器时返回 `false` —— 那样这条偏好整个不生效（宁可不动，也不乱动）。
 */
function isOneCharTail(rest, p, starts, base) {
  if (!starts) return false;
  return starts.has(base + p - 1) && starts.has(base + p);
}

/** 下一框首字是不是**单独成词**（同上） */
function isOneCharHead(rest, p, starts, base) {
  if (!starts) return false;
  return starts.has(base + p) && starts.has(base + p + 1);
}

/** 切口的「瑕疵分」：0 = 框尾和下一框开头都不是单字虚词 */
export const badness = (rest, p, starts = null, base = 0) => {
  const t = P_FN.test(rest.charAt(p - 1)) && isOneCharTail(rest, p, starts, base) ? 1 : 0;
  const h = P_FN.test(rest.charAt(p)) && isOneCharHead(rest, p, starts, base) ? 1 : 0;
  return t + h;
};
/** 所有"能在其后断"的标点 —— 现在**只剩句末标点** */
export const P_CUT = /[。！？…]/;
/**
 * 续框若以这些开头，挪回上一框末尾（中文排版允许标点悬挂）。
 *
 * ★ **不含 `，、；：`** —— 它们挪回来就变成「框尾是逗号」，正是要避免的；
 *   宁可让它们留在**下一框的内部**（`chooseCut` 会把切口往左挪一位做到这点）。
 * ★ **必须含空白** —— 这不是排版问题，是**丢字符**问题：
 *   罗马字之间的空格（`M72 LAW` / `But the ‘silent wall’ is building`）
 *   一旦落在框边界上，就会被吃掉 ⇒ 屏幕上印出 `M72LAW`。
 */
export const P_LEAD = /^[。！？…—」』》】”’）\s]+/;

/**
 * ★ 「一框合法结尾」的字符集 —— 用于**度量断词率**，不参与切分。
 *
 * 为什么要单独一个集合：`》` `」` `）` `”` `’` 这些**右闭合符**本身不是断句符，
 * 但它们**跟在**标点后面时（`恐袭！》` / `罹难”`），框以它们结尾是完全正常的。
 * 第一版的度量没算这类，把 `…遭遇恐袭！》` 这种正常切口也算成"硬切"，
 * 于是把断词率高估了 —— **度量口径错了，会让人去修不存在的问题。**
 */
export const P_TAIL_OK = /[。！？…”’」』）》]/;

/**
 * 框的结尾是否算"干净切口"：以句末标点（或紧跟其后的右闭合符）收尾。
 *
 * ★ **不再把 `，、；：` 算作干净**（作者 2026-10-03）——
 *   `一框 = 一个完整句子`，以逗号结尾的框在玩家眼里就是「话没说完」。
 *   这条判据同时是**度量口径**，所以它一变，硬切率的分母/分子都会变；
 *   换口径时**必须重新记基线**，别拿旧数字对比。
 */
export const isCleanCut = (box) => P_TAIL_OK.test(box.slice(-1));

/**
 * 框尾**绝不允许**是这些 —— 独立成条，好写测试与自检。
 *
 * 两类同族毛病：
 *   · **次级标点** `，、；：` —— 读起来像「话没说完就被切了」
 *   · **开引号 / 开括号** `“‘「『【《（(` —— 读起来像「引号没闭合就被切了」（被引的内容翻页）
 * 注意是**逐项**判，别用一条 `[，、；：“‘]` 混着写：两者的理由不同，测试要能分别断言。
 */
export const hasBadTail = (box) => P_MID.test(box.slice(-1)) || P_OPEN.test(box.slice(-1));

/**
 * 调试用埋点。`TRACE.on = true` 后，`splitText` 会把每一次切点决策记进 `TRACE.log`。
 *
 * ★ 为什么要有它：想统计"硬切里有多少是**本可以靠标点避免**的"，
 *   靠**从产物反推原文**是行不通的 —— 产物里的框已经被 cleanText 处理过，
 *   而且重建出来的"源段落"未必等于切分器真正吃到的字符串。
 *   实测吃过这个亏：反推出来的口径说"555 处有标点却没切"，
 *   但切分逻辑上那不可能（pickCut 有标点就一定用）。**要量内部行为，就得在内部埋点，别在外面猜。**
 */
export const TRACE = { on: false, log: [] };

// ═══════════════════════════════════════════════════════════════════════════
//  中文分词（可选依赖）—— 硬切时把切点**吸附到词边界**
// ═══════════════════════════════════════════════════════════════════════════
//
//  ★ 为什么需要它：作者要「框尾不许是 `，、；：`」⇒ 逗号不能再当断点。
//    但**逗号本来充当了"词边界代理"** —— 中文里逗号出现在词与词之间，
//    所以在逗号后切天然不会断词。断点一撤，硬切从 13% 涨到 68%，
//    **断词率从 11.7% 飙到 33%**（一次独立的断词率实测，jieba 口径）。
//
//  ⇒ 唯一出路是给切分器**真正的词边界**。用 `segmentit`（纯 JS 中文分词，带词典，
//    无原生编译、无跨语言构建步骤）。**fail-soft**：找不到就退化为纯硬切并**大声警告**
//    —— 不许静默降级（静默降级正是本项目最贵的一类 bug）。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let SEG;
let segWarned = false;
function loadSegmenter() {
  if (SEG !== undefined) return SEG;
  SEG = null;
  const cands = [
    process.env.VN_SEGMENTER,
    path.join(ROOT, 'node_modules', 'segmentit'),
    path.join(HERE, 'node_modules', 'segmentit'),
  ].filter(Boolean);
  const require = createRequire(import.meta.url);
  for (const c of cands) {
    try {
      const { Segment, useDefault } = require(c);
      SEG = useDefault(new Segment());
      break;
    } catch { /* 试下一个候选路径 */ }
  }
  if (!SEG && !segWarned) {
    segWarned = true;
    console.warn('⚠ 找不到中文分词器 segmentit ⇒ 硬切**无法吸附词边界**，断词率会明显变高。');
    console.warn('  安装（任选其一）：npm i --prefix "' + ROOT + '" segmentit');
    console.warn('  或用环境变量 VN_SEGMENTER 指定 segmentit 目录。');
  }
  return SEG;
}

/** 分词覆盖率自检。`gapText` 记下**被分词器吞掉的非空白字符**（真错位才算问题）。 */
export const SEG_STATS = { segs: 0, spaceGaps: 0, realGaps: 0, gapSample: [] };

/**
 * 返回 `t` 里所有「词首」位置的集合（切口只能落在这些位置）。
 *
 * ★ **必须逐字符对齐，不能假设 token 首尾相接。** 实测 segmentit 有两种偏差：
 *   ① **吞空格**：`Example Band` → `['Example','Band']`，位置表从第一个空格起整体前移
 *      （70 段中招，最多差 21 字）；
 *   ② **跨空格合并**：`李成韩 则` → 单个 token `李成韩则`，`indexOf` 直接找不到。
 *   ⇒ 做法：游标在原文上走，逐字符比；原文里的空白跳过（各自也算合法切点）。
 *   真对不上（非空白）的字符才记进 `realGaps` —— 那说明吸附用的是**错位**的边界，
 *   调用方（`docx-to-mainline.mjs`）会直接中止编译。
 */
function tokenStarts(seg, t) {
  const set = new Set([0]);
  let p = 0;
  let gap = '';
  for (const raw of seg.doSegment(t, { simple: true })) {
    const w = String(raw);
    if (!w) continue;
    while (p < t.length && /\s/.test(t[p])) { set.add(p); gap += t[p]; p++; }   // 原文空白：各自可切
    set.add(p);                                                    // ← 词首（唯一合法切口）
    for (let k = 0; k < w.length; k++) {
      if (t[p] === w[k]) { p++; continue; }
      let q = p;
      while (q < t.length && /\s/.test(t[q])) q++;                 // 原文这里插了空白
      if (t[q] === w[k]) { gap += t.slice(p, q); p = q + 1; continue; }
      gap += w[k];                                                 // 真对不上
    }
  }
  while (p < t.length) { set.add(p); p++; }

  SEG_STATS.segs++;
  const real = [...gap].filter((c) => !/\s/.test(c)).length;
  if (real) {
    SEG_STATS.realGaps++;
    if (SEG_STATS.gapSample.length < 5) SEG_STATS.gapSample.push(gap.slice(0, 24));
  } else if (gap) {
    SEG_STATS.spaceGaps++;
  }
  return set;
}

/**
 * **自测**：全片的切口里，有多少比例落在分词器认定的词边界上。
 *
 * ★ 口径自洽（用切分器**自己那个**分词器量自己），所以它衡量的是
 *   「吸附逻辑有没有生效」，而不是「两个分词器同不同意」。
 *   跨分词器的对比要另做一次实测（jieba 口径，更严格的下限）。
 *
 * @param {Map<any, string[]>} groups  源段落 → 该段的框
 * @returns {number|null} 命中率（0–1）；没有分词器时返回 null
 */
export function wordBoundaryHitRate(groups) {
  const seg = loadSegmenter();
  if (!seg) return null;
  let cuts = 0;
  let hit = 0;
  for (const boxes of groups.values()) {
    const t = boxes.join('');
    if (!t) continue;
    const starts = tokenStarts(seg, t);
    let pos = 0;
    for (let j = 0; j < boxes.length; j++) {
      pos += boxes[j].length;
      if (j === boxes.length - 1) continue;   // 段落末框不算切口
      cuts++;
      if (starts.has(pos)) hit++;
    }
  }
  return cuts ? hit / cuts : null;
}

/**
 * 全片统计：切口里有多少「框尾 / 下一框首是**单字虚词**」（`P_FN` + `isOneCharTail/Head`）。
 *
 * ★ 与 `wordBoundaryHitRate` 同样输出**自洽口径**（用切分器自己那个分词器量自己）。
 *   给测试用 —— 断言写在测试里，统计逻辑留在这里，两处各写一份必然漂移。
 *
 * @param {Map<any, string[]>} groups 源段落 → 该段的框
 * @returns {{cuts:number, tail:number, head:number}|null} 没有分词器时返回 null
 */
export function fnCutStats(groups) {
  const seg = loadSegmenter();
  if (!seg) return null;
  let cuts = 0;
  let tail = 0;
  let head = 0;
  for (const boxes of groups.values()) {
    const t = boxes.join('');
    if (!t) continue;
    const starts = tokenStarts(seg, t);
    let pos = 0;
    for (let j = 0; j < boxes.length - 1; j++) {
      pos += boxes[j].length;
      cuts++;
      if (P_FN.test(t.charAt(pos - 1)) && starts.has(pos - 1) && starts.has(pos)) tail++;
      if (P_FN.test(t.charAt(pos)) && starts.has(pos) && starts.has(pos + 1)) head++;
    }
  }
  return { cuts, tail, head };
}

export const cleanText = (s) =>
  String(s ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u180E\u00AD]/g, '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();

/**
 * 选切点 = **单一决策函数**（返回切点下标 = 本框长度）。
 *
 * ★ 为什么合成一个函数：约束之间会互相破坏。第一版是「`pickCut` 选点 → `adjustCut` 修边界 →
 *   吸附词边界」，结果吸附**最后**跑，`adjustCut` 刚修好的位置又被吸附挪回词内 ——
 *   实测断词 33% → 14%（该到 ~1%）。**多个"修补"步骤串联时，顺序本身就是 bug 来源。**
 *
 * 优先级（从高到低，同级取**最靠右**＝装得最满）：
 *
 *  ① **句末标点后**（`。！？…`，尾 ≥ 2）—— 一框 = 一个完整句子，最理想。
 *  ② **词边界 + 不压次级标点 + 不劈拉丁串** —— 硬切里的最优解。
 *  ③ **不压次级标点 + 不劈拉丁串**（放弃词边界）—— 作者明确说框尾不许是 `，、；：`，
 *     所以这条约束**优先于**不断词。
 *  ④ 兜底：`maxBox`（尾巴够长）或**对半分**。
 *
 * ★ `starts` 是**全段**的词首位置集合（绝对位置），`base` 是 `rest` 在段内的起点；
 *   传 `null` 表示没有分词器可用（那就只剩 ③④，断词会变多 —— 调用方会警告）。
 */
export function chooseCut(rest, { maxBox = MAX_BOX, minBox = MIN_BOX, starts = null, base = 0 } = {}) {
  const n = rest.length;
  const noMid = (p) => !P_MID.test(rest.charAt(p - 1)) && !P_MID.test(rest.charAt(p));
  const noAscii = (p) => !(isAsciiWord(rest.charAt(p - 1)) && isAsciiWord(rest.charAt(p)));
  const atWord = (p) => !starts || starts.has(base + p);
  // ★ 「防孤字」：硬切时**尾巴必须够长**，否则宁可对半分。
  //   不加这条会切出 `。` 这种 1 字框 —— 那正是作者最早指出的毛病。
  //   （① 不受此限：句末标点后的短尾巴是**完整短句**，不是孤字。）
  const tailOk = (p) => n - p >= minBox;

  // ① 句末标点后
  for (let p = maxBox; p >= minBox; p--) {
    if (P_END.test(rest.charAt(p - 1)) && n - p >= 2 && noMid(p)) return p;
  }
  // ② 词边界 + 边界干净 + 尾巴够长
  let primary = -1;
  for (let p = maxBox; p >= minBox; p--) if (tailOk(p) && noMid(p) && noAscii(p) && atWord(p)) { primary = p; break; }
  // ★★ 「无遗憾改进」：② 选出的点若**框尾或下一框首是单字虚词**，
  //    就看**更靠左**还有没有**同样干净且零瑕疵**的点。有则用（框稍短，但读起来完整）；
  //    没有就保持原状 —— 这条规则**只可能变好**。理由详见 `P_FN` 的注释。
  if (primary > 0 && badness(rest, primary, starts, base)) {
    for (let p = primary - 1; p >= minBox; p--) {
      if (tailOk(p) && noMid(p) && noAscii(p) && atWord(p) && !badness(rest, p, starts, base)) return p;
    }
    return primary;
  }
  if (primary > 0) return primary;
  // ③ 放弃词边界，但边界仍要干净、尾巴够长
  for (let p = maxBox; p >= minBox; p--) if (tailOk(p) && noMid(p) && noAscii(p)) return p;
  // ④ 兜底
  return n - maxBox >= minBox ? maxBox : Math.max(minBox, Math.round(n / 2));
}

/** 拉丁字母/数字（用于「不许把 `Example Band` 这样的词劈开」） */
export const isAsciiWord = (ch) => /[0-9A-Za-z]/.test(ch);

/** 兼容薄封装：只问「句末标点优先 + 兜底」，不带词边界与边界干净约束。
 *  仅用于测试与探查；**生产路径一律走 `chooseCut`**。 */
export const pickCut = (rest, maxBox = MAX_BOX, minBox = MIN_BOX) =>
  chooseCut(rest, { maxBox, minBox });

/**
 * 按 maxBox 切分长文本，只在**句末标点**后断，并**保证不出现孤字框**。
 *
 * ★ **不变式 ①（无损）：`splitText(t).join('') === cleanText(t)`。**
 *   第一版每个框都过一遍 `cleanText`（含 `.trim()`），于是**落在框边界上的空白被吃掉了**：
 *       `M72 LAW 66mm火箭筒` → `M72LAW 66mm火箭筒`   ← 屏幕上真的会这么印
 *   现在只在**开头整体清一次**（归一化零宽字符 + 折叠空白 + 去首尾），
 *   切出来的框**不再 trim**，靠 `P_LEAD` 把边界空白/标点挂到上一框末尾。
 *
 * ★ **不变式 ②（框尾）：除原文段落自身结尾外，框尾不得是 `，、；：`，
 *   也不得是开引号 / 开括号（`P_OPEN`）。**
 *   由 `chooseCut` 的边界判据 + `P_OPEN` 挪位共同保证。测试里对全片逐框扫一遍。
 *
 * ★ **不变式 ③（框首）：框首不得是多余的闭合符**（由 `P_LEAD` 挪回上一框）。
 */
export function splitText(text, maxBox = MAX_BOX, minBox = MIN_BOX) {
  const t = cleanText(text);
  if (!t) return [];
  if (t.length <= maxBox) return [t];

  const seg = loadSegmenter();
  const starts = seg ? tokenStarts(seg, t) : null;

  const out = [];
  let rest = t;
  let base = 0;                       // rest === t.slice(base)
  while (rest.length > maxBox) {
    const cut = chooseCut(rest, { maxBox, minBox, starts, base });
    if (TRACE.on) {
      const head = rest.slice(0, cut);
      const clean = isCleanCut(head);
      // 窗口里到底有没有**句末**标点（有却被弃用 = 被"尾巴够长"这条判据挡掉）
      const pInWin = [...rest.slice(minBox - 1, maxBox)].some((ch) => P_END.test(ch));
      TRACE.log.push({ n: rest.length, cut, clean, pInWin,
        reason: clean ? '句末标点' : (pInWin ? '句末标点被尾巴判据挡掉' : '硬切(已吸附词边界)') });
    }
    // ★ **不再左移切点**。老代码这里有一段「若切点右侧紧跟标点则 cut--」的 guard，
    //   本意是防标点落行首 —— 但它已被下面的 P_LEAD 完全覆盖，而且做法更好：
    //   P_LEAD 是**把标点挪进上一框**（切口保持语义位置），guard 是**把切口往前挪**
    //   （会把词切断）。实测 `所以需要一具新鲜的、会喘气的‘活体招牌’？`：
    //   pickCut 正确返回 20（在 `’` 后），guard 见下一个字是 `？` 就连退两格到 18
    //   ⇒ 正好切在「招|牌」中间。**保护措施自己成了 bug 源。**
    // ★ 也不 trim（见函数头的不变式）。
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    // ★ 兜底：续框若以标点/空白开头，挪到上一框末尾（中文排版允许标点悬挂）
    //   —— 保字符、且不让行首出现标点或空格。
    if (out.length) {
      const leadM = rest.match(P_LEAD);
      if (leadM && rest.length > leadM[0].length) {
        out[out.length - 1] += leadM[0];
        rest = rest.slice(leadM[0].length);
      }
    }
    // ★ 不变式：**框尾不许是开引号 / 开括号**（见 `P_OPEN`）。与上面那条**方向相反**：
    //   上面把**闭**合符挪回上一框，这里把**开**引号挪给下一框 —— 一对引号必须同框。
    //   挪而不删 ⇒ 无损不变式（`join === 输入`）仍成立。
    //
    //  ★ 为什么不在 `chooseCut` 里加判据：那里是**从 `maxBox` 往下找第一个合法点**，
    //    加判据只会让切点**退到更早的词边界**（框更短）；而把引号挪过去，
    //    框只少 1 字 —— 正好等于我们本来想要的那个切口。
    //    实测开局那句：加判据 → 退到 40 字（退到 `，` 之后，还要再退）；挪引号 → 55 字。
    //    ★★ 这与「别加冗余防御」不冲突：那条说的是**互相矛盾的**两道防线
    //      （老的 `guard` 会把切口往前挪，和决策函数打架）；这条是**唯一的**实现。
    if (out.length) {
      const box = out[out.length - 1];
      const openM = box.match(/[“‘「『【《（(]+$/);
      if (openM && box.length > openM[0].length) {
        out[out.length - 1] = box.slice(0, -openM[0].length);
        rest = openM[0] + rest;
      }
    }
    base = t.length - rest.length;
  }
  if (rest) out.push(rest);

  // ★ 收尾再兜一次孤字：末框太短、而上一框还装得下 ⇒ 合并
  if (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.length < minBox && prev.length + last.length <= maxBox) {
      out.splice(out.length - 2, 2, prev + last);
    }
  }
  return out.filter((b) => b.length > 0);
}
