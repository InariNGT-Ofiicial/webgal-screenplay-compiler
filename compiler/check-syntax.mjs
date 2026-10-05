/**
 * compiler / check-syntax.mjs —— 全仓脚本语法体检
 * ===========================================================================
 * 为什么要有它（**被真事故逼出来的**）：
 *   2026-10-03 给某生成器的 README 模板里补规格表时，写进了**裸反引号** ——
 *   那个 README 是一整个模板字符串（`` `…` ``），裸反引号会直接把字符串**提前闭合**，
 *   后面所有中文都变成待解析的代码 ⇒ `SyntaxError: missing ) after argument list`。
 *   问题是：**当时没有跑那个生成器**（只跑了另一个），
 *   于是产物照旧、无人察觉，直到下一轮想重生成才发现 —— 而且**产物看起来完全正常**
 *   （它只是"旧"），属本项目反复吃亏的那一类：「不报错、只是没做该做的事」。
 *
 * ⇒ 结论：**改了生成器就要能一条命令验全部脚本**，而不是"等它下次被跑"。
 *
 * 用法：
 *   node compiler/check-syntax.mjs          # 检查 compiler/ 下全部 .mjs / .js / .py
 *   node compiler/check-syntax.mjs --all    # 再加仓库根目录（含 verify-repo.mjs）
 * 退出码：0 = 全部通过；1 = 有文件语法错；2 / 3 = **校验器自身通道不可用**（不是被打分文件的问题）
 *
 * ★ `.py` 走 `ast.parse`（**纯解析，不执行、不落 __pycache__**），与 JS 侧同理。
 * ★ 找不到 python 解释器时**明确报「通道缺失」并跳过**，而不是当作通过
 *   —— 「先查通道，再信结论」：分不清「没查」和「查过了没问题」的校验器没有用。
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DIRS = ['compiler'];
if (process.argv.includes('--all')) DIRS.push('.');

const SKIP = new Set(['node_modules', '.git', '__pycache__', 'webgal-tool', '_sfx-src', 'dist', '.tmp-selftest']);

const JS_EXT = ['.mjs', '.js'];
const PY_EXT = ['.py'];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const full = path.join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (JS_EXT.some((x) => e.endsWith(x)) || PY_EXT.some((x) => e.endsWith(x))) out.push(full);
  }
  return out;
}

const all = [...new Set(DIRS.flatMap((d) => walk(path.join(ROOT, d))))].sort();
const files = all.filter((f) => JS_EXT.some((x) => f.endsWith(x)));      // JS 族
const pyFiles = all.filter((f) => PY_EXT.some((x) => f.endsWith(x)));     // Python 族
const bad = [];

// ───────────────────────────────────────────────────────────────────────────
// ★ 首选：`node --check` 子进程（最权威，但**依赖能 spawn 子进程**）。
// ★ 沙箱现实：某些会话里 spawn 子进程会被拦（症状 = status:null / "spawnSync ... EBUSY"），
//   此时**每一条都会"失败"且 stderr 为空** ⇒ 校验器静默退化成"永远报红"。
//   （这与"永远报绿"同样是失效模式，见 铁律 #9：校验器自身也得被验。）
// ⇒ 降级通道：worker 线程 + `--experimental-vm-modules` 开 `vm.SourceTextModule`，
//   它是**纯解析、不执行模块**（这一点很关键 —— 用动态 import() 会**真跑**代码，
//   实测把 diagnose.mjs 的顶层 await/fetch 也执行了，那不是语法检查该干的事）。
//   ★ 再兜底：若 SourceTextModule 仍不可用，**明确报"无法校验"并退出非 0**，
//     绝不返回"全部通过"（宁可报红，不可假绿）。
// ───────────────────────────────────────────────────────────────────────────

function spawnWorks() {
  try {
    execFileSync(process.execPath, ['--check', '--input-type=module', '-e', ''], { stdio: 'pipe' });
    return true;
  } catch (err) {
    return !(err.status === null && !err.stderr);   // status:null + 无 stderr = 通道被拦
  }
}

const PARSER_WORKER = `
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
const { src, id } = workerData;
if (typeof vm.SourceTextModule !== 'function') {
  parentPort.postMessage({ ok: false, unavailable: true });
} else {
  try {
    new vm.SourceTextModule(src, { identifier: id });   // ★ 只解析，不 link、不 evaluate
    parentPort.postMessage({ ok: true });
  } catch (e) {
    parentPort.postMessage({ ok: false, msg: String((e && e.message) || e) });
  }
}
`;

function checkInWorker(f) {
  return new Promise((resolve) => {
    const src = readFileSync(f, 'utf8');
    const w = new Worker(PARSER_WORKER, {
      eval: true,
      type: 'module',
      execArgv: ['--experimental-vm-modules', '--no-warnings'],   // 关掉 ExperimentalWarning 刷屏
      workerData: { src, id: f },
    });
    w.on('message', (m) => { w.terminate(); resolve(m); });
    w.on('error', (e) => { w.terminate(); resolve({ ok: false, msg: e.message }); });
  });
}

const useSpawn = spawnWorks();
for (const f of files) {
  try {
    if (useSpawn) {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } else {
      const r = await checkInWorker(f);
      if (r.unavailable) {
        console.log('✗ 降级通道不可用：worker 内 vm.SourceTextModule 仍拿不到。');
        console.log('  ⇒ 本机沙箱既拦子进程、又不给 VM Modules。**无法校验，不做假绿**。');
        console.log('  ⇒ 处置：重启会话（沙箱态复位）后重跑，或用 node --check 逐文件手验。');
        process.exit(2);
      }
      if (!r.ok) throw new Error(r.msg);
    }
  } catch (err) {
    const msg = String(err.stderr || err.stdout || err.message)
      .split('\n').filter((l) => /Error|:\d+/.test(l)).slice(0, 3).join(' · ') || String(err.message || err);
    bad.push([path.relative(ROOT, f), msg]);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ★ 反向自测（铁律 #9）：拿一个**故意写坏的样本**跑一遍通道，**必须被判失败**。
//   否则这个校验器可能静默退化成"永远报绿"（历史上正是这么栽的）。
// ───────────────────────────────────────────────────────────────────────────
const SELFTEST_BAD = 'const a = (1 + 2; export default a;\n';  // 括号不闭合
const SELFTEST_GOOD = 'export const a = 1;\n';
{
  let goodOk, badCaught;
  if (useSpawn) {
    const tmpDir = path.join(ROOT, '.tmp-selftest');
    try {
      execFileSync(process.execPath, ['--version'], { stdio: 'pipe' });
      const fsMod = await import('node:fs');
      fsMod.mkdirSync(tmpDir, { recursive: true });
      fsMod.writeFileSync(path.join(tmpDir, 'good.mjs'), SELFTEST_GOOD);
      fsMod.writeFileSync(path.join(tmpDir, 'bad.mjs'), SELFTEST_BAD);
      try { execFileSync(process.execPath, ['--check', path.join(tmpDir, 'good.mjs')], { stdio: 'pipe' }); goodOk = true; } catch { goodOk = false; }
      try { execFileSync(process.execPath, ['--check', path.join(tmpDir, 'bad.mjs')], { stdio: 'pipe' }); badCaught = false; } catch { badCaught = true; }
      fsMod.rmSync(tmpDir, { recursive: true, force: true });
    } catch { goodOk = false; badCaught = false; }
  } else {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const tmpDir = path.join(ROOT, '.tmp-selftest');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'good.mjs'), SELFTEST_GOOD);
    writeFileSync(path.join(tmpDir, 'bad.mjs'), SELFTEST_BAD);
    goodOk = (await checkInWorker(path.join(tmpDir, 'good.mjs'))).ok === true;
    badCaught = (await checkInWorker(path.join(tmpDir, 'bad.mjs'))).ok === false;
    rmSync(tmpDir, { recursive: true, force: true });
  }
  const pass = goodOk && badCaught;
  console.log(`  · 反向自测：${pass ? '✓ 通过' : '✗ 失败'}（好样本应过=${goodOk} · 坏样本应抓=${badCaught}）`);
  if (!pass) {
    console.log('  ✗ 校验器自身失效（不是被打分文件的问题）—— 结果不可信，退出。');
    process.exit(3);
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  Python 侧：`ast.parse` —— **纯解析**，与 JS 侧同理
//  ★ 源码走 stdin，**不写 __pycache__**（校验器不该有副作用）
//  ★ 通道缺失（没有解释器 / spawn 被拦）⇒ 明确报「**未校验**」，不报「通过」
//    —— 分不清「没查」和「查过了没问题」的校验器没有用（铁律 #9）。
//  ★ 新通道同样要**反向自测**：故意写坏的 .py 必须被判失败，
//    否则就是给「永远报绿」又开了一个口子。
// ───────────────────────────────────────────────────────────────────────────
const PY_PARSE = 'import ast,sys; ast.parse(sys.stdin.read())';
const pyBad = [];
let pyInterp = null;
for (const c of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
  try { execFileSync(c, ['-c', 'import ast'], { stdio: 'pipe' }); pyInterp = c; break; } catch { /* 试下一个 */ }
}
const pyRun = (src) => {
  try {
    execFileSync(pyInterp, ['-c', PY_PARSE], {
      input: src, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    return { ok: true };
  } catch (err) {
    const msg = String(err.stderr || err.message).split('\n')
      .map((l) => l.trim()).filter(Boolean).slice(-3).join(' · ');
    return { ok: false, msg };
  }
};

let pyPass = true;
if (pyInterp && pyFiles.length) {
  for (const f of pyFiles) {
    const r = pyRun(readFileSync(f, 'utf8'));
    if (!r.ok) pyBad.push([path.relative(ROOT, f), r.msg]);
  }
  // ★ 反向自测（不落任何文件：源码直接喂 stdin）
  const goodOk = pyRun('def f():\n    return 1\n').ok === true;
  const badCaught = pyRun('def f(:\n    return 1\n').ok === false;
  pyPass = goodOk && badCaught;
  console.log(`  · Python 反向自测：${pyPass ? '✓ 通过' : '✗ 失败'}（好样本应过=${goodOk} · 坏样本应抓=${badCaught}）`);
  if (!pyPass) {
    console.log('  ✗ Python 侧校验器自身失效（不是被打分文件的问题）—— 结果不可信，退出。');
    process.exit(3);
  }
}

const badAll = [...bad, ...pyBad];
const jsPass = files.length - bad.length;
const pyPassN = pyFiles.length - pyBad.length;

console.log(
  `语法体检：JS ${files.length} 个 · 通过 ${jsPass} · 失败 ${bad.length}` +
  (pyFiles.length
    ? pyInterp
      ? ` ｜ Python ${pyFiles.length} 个 · 通过 ${pyPassN} · 失败 ${pyBad.length}`
      : ` ｜ Python ${pyFiles.length} 个 · **未校验**（无解释器）`
    : ''),
);
console.log(`  · JS 通道：${useSpawn ? 'node --check 子进程' : 'worker 线程 + vm.SourceTextModule 纯解析（沙箱子进程被拦，已降级）'}`);
console.log(
  pyFiles.length
    ? (pyInterp
      ? `  · Python 通道：${pyInterp} -c ast.parse（纯解析，不落 __pycache__）`
      : '  · Python 通道：⊘ **未找到解释器 ⇒ .py 一个都没查**（通道缺失 ≠ 通过）。'
        + ' 设 `PYTHON=<解释器路径>` 后重跑，或在 CI 里装 python。')
    : '  · Python 通道：（本次范围无 .py）',
);
for (const [f, m] of badAll) console.log(`  ✗ ${f}\n      ${m}`);

if (badAll.length) {
  console.log('\n★ 提示：模板字符串里写裸反引号 / 单引号串里写 ${} —— 本仓库已栽过三次，');
  console.log('  症状都是「产物照旧、无人察觉」。改完生成器**先跑这条**，再去重生成产物。');
  process.exit(1);
}
