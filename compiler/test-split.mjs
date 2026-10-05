/**
 * test-split.mjs —— 文本框切分器的测试
 *
 * 从 `docx-to-mainline.mjs` 里把切分器抽成 `text-split.mjs`，
 * **就是为了能跑这个文件** —— 转换脚本 import 就会跑完整转换，埋在里测不了。
 *
 * 触发这次修复的原话（作者 2026-10-03）：
 *   「你切台词的时候至少得一行显示一个完整的句子吧，怎么会有字符孤零零的落在下一页的」
 */

import { splitText, cleanText, MAX_BOX, MIN_BOX, P_MID, P_OPEN, isCleanCut } from './text-split.mjs';
import { visualWidth } from './screenplay.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

// ★ 本仓库不随仓分发剧本文本，所以下面标「全片回归」的两段需要 `compiler/mainline/` 才跑得动。
//   缺产物时**整段跳过** —— 那些断言只有对着真实全片才有意义，拿样本跑等于自欺。
const HAS_MAINLINE = (await import('node:fs'))
  .existsSync(new URL('./mainline/beats.json', import.meta.url));

/**
 * 断言：切完之后每一框都 ≥ MIN_BOX，且全部 ≤ MAX_BOX。
 * ★ 例外：**原文本身**就短于 MIN_BOX 的（`砰！` `轰！！！` `她看见了。`）不算孤字 ——
 *   那是作者的短句，不是切分切出来的。第一版没排除，把 39 条正常的短句报成 bug。
 */
function assertShape(boxes, label) {
  const srcLen = boxes.join('').length;
  const floor = Math.min(MIN_BOX, srcLen);
  const tooLong = boxes.filter((b) => b.length > MAX_BOX);
  const tooShort = boxes.filter((b) => b.length < floor);
  if (tooLong.length) bad(`${label}：有 ${tooLong.length} 框超过 ${MAX_BOX} 字 —— ${JSON.stringify(tooLong)}`);
  else if (tooShort.length) bad(`${label}：有 ${tooShort.length} 框短于 ${MIN_BOX} 字（孤字）—— ${JSON.stringify(tooShort)}`);
  else ok(`${label}：${boxes.length} 框，长度 ${boxes.map((b) => b.length).join('/')}`);
}

/** 断言：切点都落在标点上（即"没断词"）—— 最后不算，它是收尾 */
function assertNoBareCut(boxes, label) {
  const bare = boxes.slice(0, -1).filter((b) => !isCleanCut(b));
  if (bare.length) bad(`${label}：${bare.length} 处断在词中间 —— ${JSON.stringify(bare)}`);
  else ok(`${label}：切口全部落在标点上（无断词）`);
}

console.log('══ ① 作者指出的实例（修复前都会断词）══');

// 起因：唯一的逗号在第 7 字，被老的窗口下界（maxBox*0.4=8）挡掉 ⇒ 硬切 20 ⇒ 「死|寂」
const c1 = '她紧紧攥着话筒，指关节因过度用力而泛起死寂的青白色。';
{
  const b = splitText(c1);
  assertShape(b, '① -1 死寂');
  if (b.join('') !== c1) bad('① -1：切完拼不回原文');
  // ★ 核心断言：绝不能出现「…泛起死」+「寂的青白色。」
  if (b.some((x, i) => b[i + 1] && /死$/.test(x) && /^寂/.test(b[i + 1]))) {
    bad('① -1：「死寂」仍然被劈开 —— 这就是作者报的 bug');
  } else ok('① -1：「死寂」未被劈开');
}

for (const [name, s] of [
  ['疯狂', '活像个提线木偶，与舞台上这出盛大戏剧的疯狂格格不入。'],
  ['出去', '距离最近的示例主角猛地掀飞出去！'],
  ['人间', '雨水汇成瀑布，形成一道连接地狱与人间的浑浊瀑布！'],
]) {
  const b = splitText(s);
  assertShape(b, `① ${name}`);
  if (b.join('') !== s) bad(`① ${name}：拼不回原文`);
  else ok(`① ${name}：可无损还原`);
}

// ★★ ① -2 **开局第一句**（作者 2026-10-03 报的实例，全片第一个文本框）
//
//   原状：`…由聚光灯精心编织的、名为“示例乐队”的谎言帷幕。`（73 字，超上限必须切）
//         → `…名为“`(56) | `示例乐队”的谎言帷幕。`
//         **开引号挂在框尾、被引的内容翻到下一页** —— 玩家开局第一眼就是「名为“」再翻页。
//   根因：`chooseCut` 从 `maxBox` 往下找，56 正好是 `Ave` 前的词边界，而 `“`
//         既非 ASCII（`noAscii` 放行）也不在 `P_MID` 里 ⇒ 被选中。
//   修法：框尾若是开引号/开括号，**把它挪给下一框**（一对引号必须同框）。
const c_open = '大剧院穹顶的巨大弧面，在今夜仿佛被神明握碎的玻璃罩，万千雨滴化作冰冷的银针，无情刺穿了由聚光灯精心编织的、名为“示例乐队”的谎言帷幕。';
{
  const b = splitText(c_open);
  assertShape(b, '① -2 开局');
  if (b.join('') !== c_open) bad('① -2：切完拼不回原文');
  else ok('① -2：可无损还原');
  // 核心断言：不存在「框尾是开引号」的切口
  const openTail = b.slice(0, -1).filter((x) => P_OPEN.test(x.slice(-1)));
  if (openTail.length) bad(`① -2：仍有框尾是开引号 —— ${JSON.stringify(openTail)}`);
  else ok(`① -2：开引号未挂框尾（${b.map((x) => x.length).join('+')}）`);
  // 更强的一条：开引号必须与它引的内容**同框**
  if (b.some((x) => /“$/.test(x))) bad('① -2：「“」出现在框尾');
  else if (!b.some((x) => x.includes('“') && x.includes('”'))) bad('① -2：引号对被拆到两个框');
  else ok('① -2：「“示例乐队”」整对同框');
}

console.log('\n══ ② 通用不变量（随机原文性质）══');

const samples = [
  '短短一句话。',
  '一二三四五六七八九十。',
  '一二三四五六七八九十一二三四五六七八九十。',           // 正好 20
  '一二三四五六七八九十一二三四五六七八九十一。',         // 21 → 必须切
  '，一二三四五六七八九十一二三四五六七八九十。',         // 以逗号开头
  '这是一句没有任何标点的超长文本它必须被硬切但也不能让最后一个字孤零零地掉到下一页去',
  '「引号里的对话。」他说，「还有第二句。」然后离开了房间。',
  '—— 第一章：示例章节 ——',                              // 源文本自带的破折号（要保留）
  '时间：12月5日，19:00 地点：某某市，某私人医院',
  '！！！',
];
for (const s of samples) {
  const b = splitText(s);
  assertShape(b, `② ${JSON.stringify(s.slice(0, 12))}…`);
  // ★ **严格比对（含空白）**，不再"去掉空白再比"。
  //   老版本的切分是**有损**的：每个框都过一遍 `cleanText`（带 trim），
  //   落在框边界上的空白就被吃掉了 —— 屏幕上真的印出 `M72LAW`。
  //   旧测试用 `replace(/\s/g,'')` 把这条掩盖了：**测试比实现宽松，等于没测。**
  const want = cleanText(s);
  if (b.join('') !== want) {
    bad(`② 内容丢失：${JSON.stringify(want)} → ${JSON.stringify(b)}（拼回 ${JSON.stringify(b.join(''))}）`);
  }
}

console.log('\n══ ③ 全片回归（真实 beats）══');
if (!HAS_MAINLINE) {
  console.log('  ⊘ 跳过：未找到 compiler/mainline/beats.json');
  console.log('    先用你自己的剧本跑 docx-to-mainline.mjs 生成 mainline/，再回来执行本段。');
}
if (HAS_MAINLINE) {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const B = JSON.parse(readFileSync(path.join(ROOT, 'compiler/mainline/beats.json'), 'utf8'));
  const M = JSON.parse(readFileSync(path.join(ROOT, 'compiler/mainline/beats-with-meta.json'), 'utf8'));

  // 按源段落分组 → 才能区分「切出来的框」与「源段落末框」
  const groups = new Map();
  for (let i = 0; i < B.length; i++) {
    if (M[i]._src === 'generated') continue;
    const k = M[i]._line;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(B[i].text || '');
  }

  let cuts = 0, openTail = 0, hard = 0, badTail = 0, lone = 0, shortBox = 0;
  const tailEx = [], loneEx = [], openEx = [];
  for (const [k, boxes] of groups) {
    for (let j = 0; j < boxes.length; j++) {
      const t = boxes[j];
      if (t.length < MIN_BOX && j > 0) shortBox++;
      if (j === boxes.length - 1) continue;      // 源段落末框：作者自己的结尾，不算切口
      cuts++;
      if (P_MID.test(t.slice(-1))) {             // ★ 作者新规：框尾不许是 ，、；：
        badTail++;
        if (tailEx.length < 6) tailEx.push(`L${k} …${t.slice(-14)}`);
      } else if (P_OPEN.test(t.slice(-1))) {     // ★ 框尾不许是开引号/开括号（2026-10-03 开局 bug）
        openTail++;
        if (openEx.length < 6) openEx.push(`L${k} 「…${t.slice(-14)}」→ 下一框「${(boxes[j + 1] || '').slice(0, 12)}」`);
      } else if (!isCleanCut(t)) hard++;
      // ★ 孤字：**短到看不出是个句子/词组**的框（< 3 字），且上一框不是干净切口
      if (t.length < 3 && j >= 0) {
        lone++;
        if (loneEx.length < 6) loneEx.push(`L${k} 上一框「…${(boxes[j - 1] || '').slice(-10)}」→ 本框「${t}」`);
      }
    }
  }
  console.log(`  源段落 ${groups.size} 段 · 切口 ${cuts} · 句末收尾 ${(100 - hard / Math.max(cuts, 1) * 100).toFixed(0)}% · 硬切 ${(hard / cuts * 100).toFixed(1)}% · <${MIN_BOX}字框 ${shortBox}`);

  if (badTail === 0) ok('③ 切出来的框尾没有 ，、；：（作者 2026-10-03 的要求）');
  else { bad(`③ 仍有 ${badTail} 个切口以次级标点结尾`); tailEx.forEach((e) => console.log('     ' + e)); }

  // ★★ 2026-10-03 作者报的**开局 bug**：源段
  //   `…由聚光灯精心编织的、名为“示例乐队”的谎言帷幕。`（73 字）
  //   被切成 `…名为“`(56) | `示例乐队”的谎言帷幕。` —— 开引号挂框尾，引的内容翻页。
  //   规则与「框尾不许逗号」同族：**一对引号必须同框**。
  if (openTail === 0) ok('③ 框尾没有开引号/开括号（一对引号同框）');
  else { bad(`③ 仍有 ${openTail} 个切口以开引号/开括号结尾`); openEx.forEach((e) => console.log('     ' + e)); }

  if (lone === 0) ok('③ 孤字框（<3 字）归零');
  else { bad(`③ 仍有 ${lone} 个孤字框`); loneEx.forEach((e) => console.log('     ' + e)); }

  // ★ 断词率：拿切分器**自己用的**分词器自测（自洽口径；跨分词器对比见 measure-split.py）
  const { wordBoundaryHitRate } = await import('./text-split.mjs');
  const wr = wordBoundaryHitRate(groups);
  if (wr === null) bad('③ 没有分词器可用 ⇒ 断词率无法度量（wordBoundaryHitRate 返回 null）');
  else if (wr >= 0.99) ok(`③ 切口落在词边界上 ${(wr * 100).toFixed(2)}%（无分词器时约 60%）`);
  else bad(`③ 切口词边界命中率只有 ${(wr * 100).toFixed(2)}%`);

  // ★★ 2026-10-03 第二轮「切句问题」：框尾 / 下一框首**不许是单字虚词**。
  //   实测改前 88 / 81，改后 3 / 49。规则设计成「无遗憾改进」——
  //   只有存在**同样干净且零瑕疵**的更靠左切口时才改用它，所以只可能变好。
  //   残留的 3 处是「往左全被 `、` 堵死」的句子，确实没有更优选（见 text-split.mjs 的 P_FN 注释）。
  {
    const { fnCutStats } = await import('./text-split.mjs');
    const st = fnCutStats(groups);
    if (!st) bad('③ 没有分词器 ⇒ 单字虚词无法度量（fnCutStats 返回 null）');
    else if (st.tail <= 5) ok(`③ 框尾是单字虚词的切口 ${st.tail} / ${st.cuts}（改前 88）`);
    else bad(`③ 框尾是单字虚词的切口仍有 ${st.tail}（改前 88，阈值 5）`);
    if (st) console.log(`     （下一框首是单字虚词：${st.head} —— 多为句末标点后的新句首，属正常）`);
  }

  // ★★ 容量不变式：每一框都必须能装进文本框的实装行数。
  //   为什么是**硬性**的：`concatTextLines` 里 `textArray.slice(0, lineLimit)` ——
  //   超行数的文本**整段不渲染**（静默丢字），不是裁切。
  //   几何来自 textbox.mjs（真机实测），所以这条断言等价于「上屏不会丢字」。
  {
    const { estimateLines } = await import('./screenplay.mjs');
    const { DEFAULT_TEXTBOX } = await import('./screenplay.mjs');
    const { MAX_BOX, CAPACITY } = await import('./textbox.mjs');
    let over = 0, overHard = 0, maxW = 0;
    const ex = [];
    for (const [k, boxes] of groups) {
      for (const b of boxes) {
        const w = visualWidth(b);
        maxW = Math.max(maxW, w);
        const lines = estimateLines(b, DEFAULT_TEXTBOX);
        if (lines > DEFAULT_TEXTBOX.maxLinesTotal) {
          over++;
          if (ex.length < 4) ex.push(`L${k} ${lines} 行 ${w} 字：「${b.slice(0, 30)}…」`);
        }
        if (w > CAPACITY) overHard++;
      }
    }
    console.log(`  最宽一框 ${maxW} 全角字（切框上限 ${MAX_BOX} / 物理上限 ${CAPACITY}）`);
    if (over === 0 && overHard === 0) ok(`③ 全部装得进 ${DEFAULT_TEXTBOX.maxLinesTotal} 行（上屏不会丢字）`);
    else { bad(`③ 有 ${over} 框超过 ${DEFAULT_TEXTBOX.maxLinesTotal} 行（超物理上限 ${overHard} 框）`); ex.forEach((e) => console.log('     ' + e)); }
  }
}

console.log('\n══ ④ 空白必须留住（旧切分把框边界的空格吃掉了）══');
{
  // 全片实测中招的原文（罗马字词之间的空格）
  const cases = [
    ['美制“标枪”反坦克导弹和M72 LAW火箭筒，以及墙上挂着的US Army ISS。', 'M72 LAW'],
    ['肩上扛着的竟然是M72 LAW 66mm火箭筒，一发就能把装甲车掀翻。', 'LAW 66mm'],
    ['Tokyo is noise? But the ‘silent wall’ is building? My favorite ‘Muse’ channel.', 'silent wall'],
    ['唯有大腿枪套中的那支西格 绍尔 P226手枪，冰冷地贴着肌肤。', '西格 绍尔'],
  ];
  for (const [src, must] of cases) {
    const b = splitText(src);
    const back = b.join('');
    if (back !== cleanText(src)) bad(`④ 「${must}」丢字符：${JSON.stringify(b)}`);
    else if (!back.includes(must)) bad(`④ 「${must}」的空格没保住：${JSON.stringify(back)}`);
    else ok(`④ 「${must}」完整保留（${b.length} 框）`);
  }
}

console.log('\n══ ⑤ 全片回归（真实 beats：无损 + 幂等）══');
if (!HAS_MAINLINE) {
  console.log('  ⊘ 跳过：未找到 compiler/mainline/beats.json');
  console.log('    先用你自己的剧本跑 docx-to-mainline.mjs 生成 mainline/，再回来执行本段。');
}
if (HAS_MAINLINE) {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const M = JSON.parse(readFileSync(path.join(ROOT, 'compiler/mainline/beats-with-meta.json'), 'utf8'));

  // 按源段落把框拼回"整段"，再切一遍：
  //   ① 再切必须**一字不差**（无损）
  //   ② 再切必须得到**同样的框**（幂等 —— 否则每次重跑转换产物都在抖）
  const groups = new Map();
  for (let i = 0; i < M.length; i++) {
    if (M[i]._src === 'generated') continue;
    const k = M[i]._line;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(M[i].text || '');
  }
  let lossy = 0, unstable = 0, n = 0;
  const ex = [];
  for (const [k, boxes] of groups) {
    const full = boxes.join('');
    if (!full) continue;
    n++;
    const b2 = splitText(full);
    if (b2.join('') !== full) {
      lossy++;
      if (ex.length < 3) ex.push(`L${k}: ${JSON.stringify(full.slice(0, 30))} → ${JSON.stringify(b2.join('').slice(0, 30))}`);
    } else if (b2.join('\u0000') !== boxes.join('\u0000')) {
      unstable++;
      if (ex.length < 3) ex.push(`L${k} 不幂等: ${JSON.stringify(boxes)} → ${JSON.stringify(b2)}`);
    }
  }
  console.log(`  源段落 ${n} 段 · 无损校验 · 幂等校验`);
  if (lossy === 0 && unstable === 0) ok(`⑤ ${n} 段全部无损且幂等`);
  else bad(`⑤ 无损失败 ${lossy} · 幂等失败 ${unstable}`);
  ex.forEach((e) => console.log('    ' + e));
}

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
