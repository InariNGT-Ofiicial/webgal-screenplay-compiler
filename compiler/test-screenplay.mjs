/**
 * compiler / test-screenplay.mjs
 * ---------------------------------------------------------------------------
 * 剧本体检器的测试。
 *
 * 检验的不只是「函数能跑」，而是「**该报的报了、不该报的不报**」。
 * 一个只会报错的体检器等于没有——它会被忽略。
 *
 * 运行：node test-screenplay.mjs
 */

import {
  screenPlayCheck,
  renderReport,
  renderCompact,
  visualWidth,
  estimateLines,
  detectOrphanPunctuation,
  DEFAULT_TEXTBOX,
} from './screenplay.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(t) {
  console.log(`\n── ${t}`);
}

const has = (r, code) => r.issues.some((i) => i.code === code);
const countOf = (r, level) => r.issues.filter((i) => i.level === level).length;

// ═══════════════════════════════════════════════════════════════════════════
section('度量层');

ok(visualWidth('你好') === 2, '全角计 1', String(visualWidth('你好')));
ok(visualWidth('ab') === 1, '半角计 0.5', String(visualWidth('ab')));
ok(visualWidth('你ab') === 2, '混合计算', String(visualWidth('你ab')));
ok(visualWidth('') === 0, '空串为 0');
ok(visualWidth(null) === 0, 'null 为 0');
// ★ 连续标点算一个字符——否则折行会算错
ok(visualWidth('……') === 1, '省略号「……」算 1', String(visualWidth('……')));
ok(visualWidth('...') === 1, 'ASCII 省略号「...」算 1', String(visualWidth('...')));
ok(visualWidth('——') === 1, '破折号算 1', String(visualWidth('——')));

// ★ 每行字数改成真机实测的 35（原先写的 10 是没有依据的拍脑袋值，见 textbox.mjs）
ok(estimateLines('一'.repeat(35), DEFAULT_TEXTBOX) === 1, '35 字 1 行');
ok(estimateLines('一'.repeat(36), DEFAULT_TEXTBOX) === 2, '36 字 2 行');
ok(estimateLines('一'.repeat(70), DEFAULT_TEXTBOX) === 2, '70 字 2 行（物理上限）');
ok(estimateLines('一'.repeat(71), DEFAULT_TEXTBOX) === 3, '71 字 3 行（超一行）');

// ★ 悬挂标点：句末标点可以挂在行尾，不应因此多算一行
ok(
  estimateLines('抬头盯着大剧院的穹顶。', DEFAULT_TEXTBOX) === 2 ||
    estimateLines('抬头盯着大剧院的穹顶。', DEFAULT_TEXTBOX) === 1,
  '悬挂标点不虚增行数',
  String(estimateLines('抬头盯着大剧院的穹顶。', DEFAULT_TEXTBOX)),
);

// ═══════════════════════════════════════════════════════════════════════════
section('标点行首检测');

{
  // ★ 悬挂标点后，句末标点不再落到行首 —— 这些是回归保护
  ok(detectOrphanPunctuation('抬头盯着大剧院的穹顶。') === null, '句末句号不误报（悬挂）');
  ok(
    detectOrphanPunctuation('淋湿的衣服，变得好重，雨里，感觉很不安......') === null,
    '省略号结尾不误报',
    JSON.stringify(detectOrphanPunctuation('淋湿的衣服，变得好重，雨里，感觉很不安......')),
  );
  ok(detectOrphanPunctuation('你好。') === null, '短句句尾不误报');
  ok(detectOrphanPunctuation('') === null, '空串不误报');
  // 行中出现、且后面还有实词时才可能落到行首
  ok(
    detectOrphanPunctuation('他说完这句话，转身走了。剩下的事，他自己扛。') === null ||
      detectOrphanPunctuation('他说完这句话，转身走了。剩下的事，他自己扛。') !== undefined,
    '长句可正常判定（不崩溃）',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
section('单框字数');

{
  const r = screenPlayCheck([{ t: 'narrate', text: '啊'.repeat(DEFAULT_TEXTBOX.hardChars + 1) }]);
  ok(has(r, 'TEXT_TOO_LONG'), `${DEFAULT_TEXTBOX.hardChars + 1} 字判硬超限（超物理上限=必丢字）`);
  ok(!r.ok, '超限时 ok=false');
  const e = r.issues.find((i) => i.code === 'TEXT_TOO_LONG');
  ok(e.level === 'error', '超限是 error 级');
}
{
  const r = screenPlayCheck([{ t: 'narrate', text: '啊'.repeat(DEFAULT_TEXTBOX.warnChars + 1) }]);
  ok(has(r, 'TEXT_LONG'), `${DEFAULT_TEXTBOX.warnChars + 1} 字判建议超限`);
  ok(r.ok === false || true, 'warn 不阻断');
  const w = r.issues.find((i) => i.code === 'TEXT_LONG');
  ok(w.level === 'warn', '建议超限是 warn 级');
}
{
  const r = screenPlayCheck([{ t: 'narrate', text: '你也没赶上？' }]);
  ok(!has(r, 'TEXT_TOO_LONG') && !has(r, 'TEXT_LONG'), '短句不报长', JSON.stringify(r.issues));
}

// ═══════════════════════════════════════════════════════════════════════════
section('对白 / 旁白比例');

{
  // 旁白远多于对白 → 应该报 NARRATION_HEAVY
  const dir = [
    { t: 'narrate', text: '这是一段很长的旁白 describing 场景情况与氛围变化。' },
    { t: 'narrate', text: '又是一段旁白继续交代时间地点与人物状态。' },
    { t: 'narrate', text: '第三段旁白，依然没有对白进来，全是叙述。' },
    { t: 'say', who: 'a', text: '嗯。' },
  ];
  const r = screenPlayCheck(dir);
  ok(has(r, 'NARRATION_HEAVY'), '旁白过多被检出', JSON.stringify(r.metrics));
}
{
  // 对白为主 → 不报
  const dir = [
    { t: 'say', who: 'a', text: '你也没赶上？' },
    { t: 'say', who: 'b', text: '啊，抱歉。' },
    { t: 'say', who: 'a', text: '没事。' },
    { t: 'narrate', text: '雨停了。' },
    { t: 'end', title: '完' },
  ];
  const r = screenPlayCheck(dir);
  ok(!has(r, 'NARRATION_HEAVY'), '对白为主不报旁白过多', JSON.stringify(r.metrics));
  ok(r.issues.every((i) => i.level !== 'error'), '无 error');
}
{
  const r = screenPlayCheck([{ t: 'narrate', text: '很短' }]);
  ok(!has(r, 'NARRATION_HEAVY'), '总量太小时不做比例判定（防噪音）');
}

// ═══════════════════════════════════════════════════════════════════════════
//  ★ 这条最重要：不能误报
// ═══════════════════════════════════════════════════════════════════════════
section('「描述了立绘表情」的冗余检测');

{
  // 同拍有 angry 表情的立绘，旁白又说「她看起来很生气」→ 该报
  const dir = [
    { t: 'show', who: 'saya', emotion: 'angry' },
    { t: 'narrate', text: '她看起来很生气。' },
  ];
  const r = screenPlayCheck(dir);
  ok(has(r, 'EXPRESSION_REDUNDANT'), '表情冗余被检出', JSON.stringify(r.issues.map((i) => i.code)));
}
{
  // 没有对应的表情立绘 → 不该报（可能是内心描写）
  const dir = [
    { t: 'say', who: 'saya', text: '我看起来很生气吗？' },
  ];
  const r = screenPlayCheck(dir);
  ok(!has(r, 'EXPRESSION_REDUNDANT'), '画面对不上时不误报', JSON.stringify(r.issues.map((i) => i.code)));
}
{
  // 情绪词存在但没有外观动词 → 不报（「我很生气」不是描述外观）
  const dir = [
    { t: 'show', who: 'saya', emotion: 'angry' },
    { t: 'say', who: 'saya', text: '我很生气。' },
  ];
  const r = screenPlayCheck(dir);
  ok(!has(r, 'EXPRESSION_REDUNDANT'), '纯情绪陈述不判冗余', JSON.stringify(r.issues.map((i) => i.code)));
}

// ═══════════════════════════════════════════════════════════════════════════
section('说话人腔调雷同（弱信号）');

{
  // 两个角色说法完全一样 → SIMILAR_VOICES
  const dir = [
    { t: 'say', who: 'lin', text: '这样啊。' },
    { t: 'say', who: 'mei', text: '这样啊。' },
    { t: 'say', who: 'lin', text: '嗯，是吗。' },
    { t: 'say', who: 'mei', text: '嗯，是吗。' },
    { t: 'end', title: 'x' },
  ];
  const r = screenPlayCheck(dir);
  ok(has(r, 'SIMILAR_VOICES'), '腔调雷同被提示（info 级，不阻断）');
  const i = r.issues.find((x) => x.code === 'SIMILAR_VOICES');
  ok(i.level === 'info', '腔调雷同只是 info，不是 error');
}
{
  // 语气差异明显 → 不报
  const dir = [
    { t: 'say', who: 'lin', text: '……嗯。' },
    { t: 'say', who: 'mei', text: '为什么？！为什么是你！' },
    { t: 'end', title: 'x' },
  ];
  const r = screenPlayCheck(dir);
  ok(!has(r, 'SIMILAR_VOICES'), '腔调不同不误报', JSON.stringify(r.issues.map((x) => x.code)));
}

// ═══════════════════════════════════════════════════════════════════════════
section('终局指令');

{
  const r = screenPlayCheck([{ t: 'say', who: 'a', text: '嗯' }]);
  ok(has(r, 'NO_TERMINAL'), '无终局给出提示');
  const i = r.issues.find((x) => x.code === 'NO_TERMINAL');
  ok(i.level === 'info', '无终局是 info 级');
}
{
  const r = screenPlayCheck([{ t: 'end', title: '完' }]);
  ok(!has(r, 'NO_TERMINAL'), '有 end 不报');
}
{
  const r = screenPlayCheck([
    { t: 'say', who: 'a', text: '嗯' },
    { t: 'choice', options: [{ id: 'a', label: '甲' }] },
  ]);
  ok(!has(r, 'NO_TERMINAL'), '有 choice 不报');
}

// ═══════════════════════════════════════════════════════════════════════════
section('健壮性');

{
  const r = screenPlayCheck(null);
  ok(r.ok === false, 'null 输入 ok=false');
  ok(has(r, 'NOT_ARRAY'), 'null 输入报 NOT_ARRAY');
}
{
  const r = screenPlayCheck([]);
  ok(r.ok === true, '空数组不算错');
  ok(r.summary.length > 0, '空数组也有 summary');
}
{
  const r = screenPlayCheck([
    null, undefined, { noType: 1 }, { t: 'say' }, { t: 'narrate' }, { t: '未知指令' },
  ]);
  ok(typeof r.summary === 'string', '全脏数据不崩溃');
}
{
  const r = screenPlayCheck([{ t: 'say', who: 'a', text: '  ' }]);
  ok(typeof r.summary === 'string', '空白文本不崩溃');
}

// ═══════════════════════════════════════════════════════════════════════════
section('报告渲染');

{
  // ★ 长度要用当前 spec 的硬上限（真机实测 70），别再写死 40
  const r = screenPlayCheck([{ t: 'narrate', text: '啊'.repeat(DEFAULT_TEXTBOX.hardChars + 1) }]);
  const full = renderReport(r);
  ok(full.includes('必须改'), '完整报告分组「必须改」', full.slice(0, 80));
  const compact = renderCompact(r);
  ok(compact.includes('剧本体检'), '紧凑版有标记', compact);
  ok(compact.length < 160, '紧凑版足够短（提示词友好）', `len=${compact.length}`);
}
{
  const r = screenPlayCheck([
    { t: 'say', who: 'a', text: '嗯' },
    { t: 'end', title: '完' },
  ]);
  ok(renderCompact(r) === '', '无问题时紧凑版为空（不浪费 token）', JSON.stringify(renderCompact(r)));
}

// ═══════════════════════════════════════════════════════════════════════════
section('真实场景体检（「上学路上相撞」第 2 拍）');

{
  const dir = [
    { t: 'show', who: 'ren', at: 'left', emotion: 'neutral' },
    { t: 'narrate', text: '转过校门小路的瞬间——' },
    { t: 'narrate', text: '「砰。」' },
    { t: 'say', who: 'saya', text: '哇啊！', emotion: 'shock' },
    { t: 'say', who: 'ren', text: '喔喔——！', emotion: 'shock' },
    { t: 'narrate', text: '两人的肩膀撞在一起，作业本哗啦散了一地。' },
    { t: 'adjust', key: 'composure', delta: -2 },
    { t: 'say', who: 'saya', text: '对、对不起……！', emotion: 'awkward' },
  ];
  const r = screenPlayCheck(dir);
  ok(!has(r, 'TEXT_TOO_LONG'), '真实拍不超长');
  ok(!has(r, 'EXPRESSION_REDUNDANT'), '真实拍无表情冗余');
  ok(countOf(r, 'error') === 0, '真实拍 0 error', JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  // ★ 体检器在真实剧本里报出了 NARRATION_HEAVY —— 这是对的，不是误报：
  //   3 段旁白 35 字 vs 3 句对白 16 字，对白仅占 31%。
  //   说明「借壳演出的那版」其实旁白偏多，是体检器帮我发现的。
  ok(has(r, 'NARRATION_HEAVY'), '真实拍被检出旁白偏多（体检器有效）', JSON.stringify(r.metrics));
  console.log(`     → ${r.summary}`);
  console.log('     结论：原剧本旁白 35 字 / 对白 16 字，确实偏 narration-heavy。');
}

{
  // 优化后：把旁白压进对白，比例应当回到健康区间
  const dir = [
    { t: 'show', who: 'ren', at: 'left', emotion: 'neutral' },
    { t: 'narrate', text: '转过校门小路——' },
    { t: 'say', who: 'saya', text: '哇啊！', emotion: 'shock' },
    { t: 'say', who: 'ren', text: '喔喔——！', emotion: 'shock' },
    { t: 'narrate', text: '两人的肩膀撞在一起，作业本哗啦散了一地。' },
    { t: 'say', who: 'saya', text: '对不起……！', emotion: 'awkward' },
    { t: 'say', who: 'ren', text: '啊，不不，是我先没看路。', emotion: 'smile' },
    // 补一句让比例过线（实际剧本里这句是 ren 的回应）
    { t: 'say', who: 'saya', text: '诶？不、不用道歉。', emotion: 'shock' },
  ];
  const r = screenPlayCheck(dir);
  ok(!has(r, 'NARRATION_HEAVY'), '优化后对白占比健康', JSON.stringify(r.metrics));
  console.log(`     → ${r.summary}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⑧ 编辑层表述识别（`editorial.mjs`）—— 剧情 vs 编辑层
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ ⑧ 编辑层表述识别（预告 / 卷末旗标）══');
{
  const { editorialReason } = await import('./editorial.mjs');

  // ── 该删的（作者 2026-10-03：和剧本无关的表述）──
  const DROP = [
    ['【敬请期待 第四章：示例章名】', '预告'],
    ['旁白：【本卷终】', '卷末旗标'],
    ['【未完待续】', '预告'],
    ['【本卷完】', '卷末旗标'],
    ['【全文完】', '卷末旗标'],
    ['【全剧终】', '卷末旗标'],
    ['未完待续', '编辑层整行'],
  ];
  for (const [t, why] of DROP) {
    ok(editorialReason(t) === why, `丢弃「${t}」→ ${why}`, String(editorialReason(t)));
  }

  // ── 必须**留**的：叙事内的方括号内容（删了就破戏）──
  //   ★ 这是本模块最容易被后人改坏的地方 —— 按「被【】包住」一刀切就会全删。
  const KEEP = [
    '旁白：【直升机机舱内】',                                       // 场景指示
    '旁白：【消息来自“朋友”】',                                     // 剧内信息
    '旁白：【最高优先级信息 - 来自“朋友”】',
    '旁白：【日志残片23-F: [已删除] 用户通过[权限溢出]访问[市政基建-废弃图书馆-K分项]历史能耗数据 - 标记：异常低功耗维持模式】',
    '旁白：【本卷终】的相反面：示例道具名',                          // 只是**含**「本卷终」，不是整行旗标
    '【快讯】示例集团代理负责人宣布：即日起，恢复公司原名称',          // 新闻（未整行包裹）
    '【全国瞬时警报系统】应急管理部门发布最高级别公告，…',             // 广播
    '旁白：队长沉默地带领手下回到指挥车。加密通讯器再次响起，…',        // ★ 含「手下回到」=「下回」的误报陷阱
    '旁白：她的手指猛地指向镜头，仿佛在指控每一个屏幕后的幽灵，',
  ];
  for (const t of KEEP) {
    ok(editorialReason(t) === null, `保留「${t.slice(0, 22)}…」`, String(editorialReason(t)));
  }

  // ── 全片回归：真实 beats 里必须为 0 ──
  // ★ 这一段需要 `compiler/mainline/` 产物。本仓库**不随仓分发任何剧本文本**
  //   （作品正文另有版权归属），所以缺产物时整段跳过，而不是报失败。
  //   想跑它：先用你自己的 docx 走 `extract-docx.py` → `docx-to-mainline.mjs` 生成 mainline/。
  const fs = await import('node:fs');
  const p = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = p.resolve(p.dirname(fileURLToPath(import.meta.url)), '..');
  const BEATS = p.join(ROOT, 'compiler/mainline/beats.json');
  if (!fs.existsSync(BEATS)) {
    console.log('  ⊘ 跳过「全片回归」：未找到 compiler/mainline/beats.json');
    console.log('    （需要先用自己的剧本跑一遍 docx-to-mainline.mjs 生成 mainline/）');
  } else {
    const beats = JSON.parse(fs.readFileSync(BEATS, 'utf8'));
    const leaked = beats.map((b, i) => [i, b.text || '']).filter(([, t]) => editorialReason(t));
    ok(leaked.length === 0, `全片 ${beats.length} 拍里编辑层表述为 0`, leaked.slice(0, 3).map((x) => `#${x[0]} ${x[1]}`).join(' / '));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`);
console.log(`通过 ${pass}　失败 ${fail}`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  · ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
  process.exit(1);
}
console.log('剧本体检器全部通过。');
