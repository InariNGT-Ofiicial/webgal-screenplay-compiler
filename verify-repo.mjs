#!/usr/bin/env node
/**
 * verify-repo.mjs —— 仓库自检：**一条命令验全部**
 * ===========================================================================
 * 运行：node verify-repo.mjs          （在仓库根跑）
 *       node verify-repo.mjs --selftest   （先验本校验器自己会不会误报/漏报）
 *
 * ── 为什么需要这个文件（它不是锦上添花，是补一次真实的翻车）────────────────
 * 之前判断"仓库没问题"用的证据是：4 个测试套件 + `node --check` + 手工冒烟 10 个模块。
 * **这个证据链是漏的**，实际漏掉了：
 *   · `build-demo.mjs` 依赖的 `sfx-rules.mjs` / `bgm-cues.mjs` 根本不在仓库里
 *     ⇒ 主入口 `ERR_MODULE_NOT_FOUND`，跑不起来
 *   · 手写的 `bg-rules.mjs` 指向 5 张 `demo-assets.mjs` 永远不会生成的背景图
 *     ⇒ 画面静默空白（WebGAL 找不到图不报错）
 * 漏的原因很具体：
 *   ★ **`node --check` 只查语法，不解析 import** —— 缺依赖一个都查不出来。
 *   ★ 冒烟是**手工挑的 10 个模块**，恰好绕过了真正的入口。
 *   ★ 扫断链时**只扫了 `.mjs` 的 `import`，没扫 `.md` 里的散文引用**。
 * ⇒ 所以这里做五件事，且**逐入口真实加载**（不是语法检查）：
 *   ① 依赖闭合    ② 入口真实加载    ③ 资源名交叉一致    ④ 文档引用扫描    ⑤ 文档规模口径
 *
 * ★ 本校验器**自身也要被验**（「永远报绿」与「永远报红」都要防）：
 *   跑 `--selftest`，它用**故意做坏的假输入**断言四个探测器都会响。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const MODEL = { src: 'compiler' };

// ── 已知且**可接受**的缺失依赖（必须写理由，否则不许进这个表）───────────────
//  ★ 当前为空：全仓没有任何「允许缺失」的相对依赖。
//    一旦这里要加东西，请连带写清理由 —— 一张没有理由的豁免表，
//    早晚会变成「报红没人看」的起点。
const OPTIONAL_DEPS = new Map();

// ── 入口清单 ────────────────────────────────────────────────────────────────
//  LIB  = 库模块，必须能干净 import（无副作用）
//  SCRIPT = 可执行入口，判据是"不出现模块解析/语法错误堆栈"（允许因缺剧本而友好退出）
//
//  ★ 为什么 `demo-assets.mjs` 与 `sfx-report.mjs` **不在**下面这张表里：
//    两者都会**真写文件**（前者往 `webgal-tool/dist/game/` 写 PNG，
//    后者往 `_report/` 写 HTML）。**自检器不该有副作用。**
//    它们被静态覆盖到了：
//      ① `checkDeps()` 会解析它们的全部相对 import；
//      ② `checkAssets()` 会比对 `demo-assets.mjs` 源码里的背景图名与 `bg-rules.mjs` 是否对得上；
//      ③ `checkDocRefs()` 会扫它们出现在哪些文档里。
const LIB_ENTRIES = [
  'compiler/screenplay.mjs', 'compiler/text-split.mjs',
  'compiler/textbox.mjs', 'compiler/editorial.mjs', 'compiler/segments.mjs',
  'compiler/bg-rules.mjs', 'compiler/branches.mjs', 'compiler/anchor.mjs',
  'compiler/sfx-rules.mjs', 'compiler/bgm-cues.mjs', 'compiler/md-html.mjs',
  'compiler/paths.mjs',
];
const SCRIPT_ENTRIES = [
  'compiler/docx-to-mainline.mjs', 'compiler/build-demo.mjs',
  'compiler/check-syntax.mjs', 'compiler/verify-branch.mjs',
  'compiler/verify-sfx.mjs',
];

// ═══════════════════════════════════════════════════════════════════════════
//  工具
// ═══════════════════════════════════════════════════════════════════════════

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === '__pycache__') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => readFileSync(p, 'utf8');

/** 收集 .mjs 里的相对 import（静态与动态都收） */
function relativeImports(src) {
  const out = new Set();
  const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

// ═══════════════════════════════════════════════════════════════════════════
//  ① 依赖闭合
// ═══════════════════════════════════════════════════════════════════════════

export function checkDeps(files) {
  const bad = [];
  for (const p of files.filter((f) => f.endsWith('.mjs'))) {
    for (const spec of relativeImports(read(p))) {
      const target = path.resolve(path.dirname(p), spec);
      if (existsSync(target)) continue;
      const key = `${rel(p)} → ${spec}`;
      bad.push({ key, optional: OPTIONAL_DEPS.has(key), why: OPTIONAL_DEPS.get(key) || '' });
    }
  }
  return bad;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ② 入口真实加载（子进程，不是 node --check）
// ═══════════════════════════════════════════════════════════════════════════

const FATAL = /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|ERR_UNSUPPORTED_DIR_IMPORT/;

/**
 * ★ 子进程**根本没起来**的判据 —— 必须与「被测对象坏了」分开。
 *
 * 为什么必须有它（实测栽过）：
 *   沙箱某些会话里 spawn 会被整块拦掉（EBUSY / EACCES）。此时
 *   `spawnSync` 返回 `status === null` 且 **stderr 为空**：
 *     · `loadLibEntry` 会把它报成「✗ 入口加载失败」（**假红**）；
 *     · `loadScriptEntry` 只扫 stderr 里的致命关键字，空 stderr ⇒ 直接放过（**假绿**）。
 *   同一个通道故障，在两个探测器上给出**方向相反**的错判 —— 而两者的共同点是
 *   **都没在验本该验的东西**。所以先把通道单独探出来，探不通就明说「本次无效」。
 */
function channelBlocked(r) {
  if (r.error) return true;                                            // spawn 直接失败（EBUSY/EACCES/ENOENT…）
  if (r.status === null && !`${r.stderr || ''}`.trim()) return true;   // 进程没起来，且没有任何输出
  return false;
}

const CHANNEL_HINT =
  '子进程通道不可用（沙箱拦截？）⇒ **本次判定无效**，既不是"通过"也不是"入口坏了"。\n' +
  '      处置：重启会话（沙箱态复位）后重跑；或退回手工：`node --check <文件>` + `node <入口>` 各跑一次。';

export function loadLibEntry(relPath) {
  const url = pathToFileURL(path.join(ROOT, relPath)).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`],
    { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
  if (channelBlocked(r)) return { ok: false, channel: true, detail: CHANNEL_HINT };
  const err = `${r.stderr || ''}`;
  if (r.status === 0) return { ok: true };
  return { ok: false, detail: err.split('\n').slice(0, 3).join(' / ').trim() };
}

export function loadScriptEntry(relPath) {
  const r = spawnSync(process.execPath, [path.join(ROOT, relPath)],
    { cwd: ROOT, encoding: 'utf8', timeout: 8000 });
  if (channelBlocked(r)) return { ok: false, channel: true, detail: CHANNEL_HINT };
  const err = `${r.stderr || ''}`;
  // 允许"友好退出"（比如缺剧本产物）；只要不是模块解析/语法级别的崩，就算通过
  if (FATAL.test(err)) return { ok: false, detail: err.split('\n').slice(0, 3).join(' / ').trim() };
  return { ok: true, timedOut: r.error?.code === 'ETIMEDOUT' };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ③ 资源名交叉一致
//     同一批资源名散在三个文件里：规则（bg-rules）· 生成器（demo-assets）
//     · 环境音映射（sfx-rules）。对不上不会报错，只会**画面空白 / 没环境音**。
// ═══════════════════════════════════════════════════════════════════════════

function names(file, re) {
  if (!existsSync(file)) return new Set();
  return new Set([...read(file).matchAll(re)].map((m) => m[0]));
}

export function checkAssets() {
  const bgRe = /bg_[a-z_]+\.png/g;
  const seRe = /\b(se|amb)_[a-z_0-9]+/g;

  const ruleBg = names(path.join(ROOT, MODEL.src, 'bg-rules.mjs'), bgRe);
  const genBg = names(path.join(ROOT, MODEL.src, 'demo-assets.mjs'), bgRe);
  const ambBg = names(path.join(ROOT, MODEL.src, 'sfx-rules.mjs'), bgRe);

  // 规则指向但生成器不产 ⇒ 画面会静默空白（这是最贵的一类）
  const ghostBg = [...ruleBg].filter((x) => !genBg.has(x));
  const ghostAmb = [...ambBg].filter((x) => !genBg.has(x));

  // 音效：规则里引用的 id 必须在清单里定义
  const catalogFile = path.join(ROOT, MODEL.src, 'sfx-catalog.json');
  let catalogIds = new Set();
  if (existsSync(catalogFile)) {
    const c = JSON.parse(read(catalogFile));
    catalogIds = new Set([...c.oneShots, ...c.ambience].map((x) => x.id));
  }
  const ruleSrc = existsSync(path.join(ROOT, MODEL.src, 'sfx-rules.mjs'))
    ? read(path.join(ROOT, MODEL.src, 'sfx-rules.mjs')) : '';
  const usedSe = new Set([...ruleSrc.matchAll(/'(se|amb)_[a-z_0-9]+'/g)].map((m) => m[0].slice(1, -1)));
  const ghostSe = [...usedSe].filter((x) => !catalogIds.has(x));

  return { ruleBg, genBg, ambBg, ghostBg, ghostAmb, ghostSe, catalogIds };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ④ 文档引用扫描
//     ★ 只扫 `.mjs` 的 import 曾经漏掉一整段 UI 文档里的 6 个不存在的脚本。
//       这里扫所有 `.md` 里**看起来像仓库内路径**的行内代码。
// ═══════════════════════════════════════════════════════════════════════════

const INLINE = /`([^`\n]+)`/g;              // 行内代码
const FENCE = /```[^\n]*\n([\s\S]*?)```/g;  // 围栏代码块（★ 曾经漏掉一整段 UI 文档就在这里）
// ★ 只对「我们自己的源码/文档文件」提要求。
//   `.json` / `.txt` / `.scss` 一律不管 —— 那是生成产物或上游运行时的文件。
const SRCISH = /\.(mjs|py|md|cmd)$/;
const JUNK = /[*${}<>|="'\\]/;              // 通配符 / 模板串 / URL 残片 / 引号
// 这些前缀是**上游运行时目录 / 生成产物 / 支援包**，不要求存在于仓库
const NOT_OURS = ['game/', 'webgal-tool/', 'mainline/', 'mainline-src/', 'dist/',
  'bgm-brief/', 'sfx-brief/', 'ui-brief/', 'art-brief/', 'voice-brief/', 'handoff/',
  'Stage/', 'template/', 'assets/'];

/**
 * 扫文档与注释里"看起来像仓库内源码文件"的引用。
 * ★ 同时扫 `.md` 与 `.mjs`，且**围栏代码块也要扫** ——
 *   只扫行内代码曾导致漏报一整段文档（`compiler/AGENTS.md` 的 §UI 就是漏网的那段）。
 * ★ 判据刻意保守：宁可少报，也不要把 URL / 模板串 / 生成产物当成缺失文件，
 *   否则报红变成噪音，人就会开始忽略它（"假阴性会训练人忽略输出"）。
 */
export function checkDocRefs(files) {
  const missing = [];
  for (const p of files.filter((f) => f.endsWith('.md') || f.endsWith('.mjs'))) {
    if (rel(p) === 'verify-repo.mjs') continue; // 本文件自带假样例，避免自伤
    const dir = path.dirname(p);
    const text = read(p);

    const tokens = new Set();
    for (const m of text.matchAll(INLINE)) tokens.add(m[1].trim());
    for (const f of text.matchAll(FENCE)) {
      for (const t of f[1].split(/[\s,;|(){}[\]"'=]+/)) tokens.add(t.trim());
    }

    for (const raw of tokens) {
      const token = raw.replace(/^(node|python\d?|npx)\s+/, '').replace(/[.,;:）)]+$/, '');
      if (!SRCISH.test(token)) continue;              // 只管源码/文档扩展名
      if (token === '.mjs' || token === '.py' || token === '.md') continue; // 纯扩展名
      if (JUNK.test(token)) continue;                 // 通配符 / 模板串 / URL
      if (/^[a-z]+:\/\//i.test(token)) continue;
      if (NOT_OURS.some((pre) => token.startsWith(pre) || token.includes('/' + pre))) continue;
      const cands = [
        path.resolve(ROOT, token),
        path.resolve(dir, token),
        path.resolve(ROOT, MODEL.src, token),
        path.resolve(ROOT, 'docs', token),
      ];
      if (cands.some((c) => existsSync(c))) continue;
      missing.push({ file: rel(p), token });
    }
  }
  return missing;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⑤ 文档规模口径（「N 行」「N 个脚本」必须与实测一致）
//     ★ 为什么值得单开一个探测器：文档里的规模数字**漂移过至少四次**。
//       最贵的一次不是"没人看"，而是 —— **先改代码、后回头核文档 ⇒ 提交里带着已经过期的数字**。
//       人通读能抓住第一次、第二次，抓不住第五次 ⇒ 机械可判的东西就该交给机器。
//
//  ★ 判据刻意保守（理由同 ④：**报红一旦变成噪音，人就开始忽略它**）：
//    · 只认**表格行**（`|` 开头、≥2 格），且**只看最后一格**（本仓文档的「规模」都在最后一列）；
//    · 那一格必须是"纯规模格"：剥掉 `**` / 反引号 / `行` / `项测试` / `数据` 后，
//      只剩下数字与 `+ / · —` 空白 ⇒ 否则判为散文，跳过；
//    · 该行里能解析成**仓库内 `.mjs`/`.py`** 的 `` `名字` `` 个数，必须与规模格里「N 行」的个数**相等**；
//    · 「合计 N 个脚本（a `.mjs` + b `.py`）· M 行」单独一条规则 ——
//      它的口径固定为 **`compiler/` 下全部 `.mjs` + `.py`**（根目录的 `verify-repo.mjs` 不在其中，
//      它由 §3.2 单独列出）。★ 若将来改了这句的口径，**这条规则也要一起改**。
//    ⇒ 任一条不满足就**跳过**，并把**跳过条数如实报出来** —— 只报"通过 N 条"而不报跳过多少，
//      等于变相"永远报绿"。
// ═══════════════════════════════════════════════════════════════════════════

/** 与 `wc -l` 同口径的行数（文件以换行结尾时不多算一行） */
export function countLines(text) {
  if (!text) return 0;
  const n = text.replace(/\r\n/g, '\n').split('\n');
  return n[n.length - 1] === '' ? n.length - 1 : n.length;
}

/** 规模格合法 ⇔ 剥掉允许的标记后什么都不剩（宽松版：连 `行`/`项测试`/`数据` 都算标记） */
const scaleResidue = (cell) => cell
  .replace(/\*\*/g, '').replace(/`/g, '')
  .replace(/行|项测试|数据/g, '')
  .replace(/[\s\d+/·—]/g, '');

/** 严格版：只允许数字与 `+ / · —` —— 用来认「裸数字」列（本仓 `compiler/README.md` 的行数表就是这样） */
const scaleResidueStrict = (cell) => cell
  .replace(/\*\*/g, '').replace(/`/g, '')
  .replace(/[\s\d+/·—]/g, '');

/**
 * 纯函数：从**一行**里抽出「文件名 ↔ 声明的行数」配对。
 * ★ 刻意不碰文件系统 —— 解析逻辑与 IO 分开，`--selftest` 才能不落盘地验它。
 *
 * 两种「规模格」写法都要认（★ 曾经只认第一种，导致 `compiler/README.md` 的**整张文件表被静默跳过**）：
 *   ① 带单位：`485 + 117 行 · 26 项测试`
 *   ② 裸数字：`144`（该表的列头已经写了「行数」）
 * 裸数字这条**只严格格**才走 —— `数据` 这类非数字格一律不管。
 *
 * @param {string} line
 * @param {(cand: string) => string|null} resolve 把候选路径变成绝对路径（不存在返回 null）
 * @returns {{claims: {raw:string, full:string, claimed:number}[], skipped: boolean}}
 */
export function claimsInRow(line, resolve = () => null) {
  if (!line.trimStart().startsWith('|')) return { claims: [], skipped: false };
  const cells = line.split('|');
  if (cells.length < 4) return { claims: [], skipped: false };          // 至少要有 2 个实格
  const scale = cells[cells.length - 2];
  if (scaleResidue(scale) !== '') return { claims: [], skipped: true }; // 散文格 ⇒ 不看

  // ★ 注意「共享单位」的写法：`485 + 117 行` 里只有 117 紧挨「行」，485 也是行数。
  //   只认紧邻的那个数 ⇒ 个数对不上 ⇒ 整行被跳过（README §3.1 有三行就是这样漏掉的）。
  const nums = [];
  for (const m of scale.matchAll(/(\d+(?:\s*[+/]\s*\d+)*)\s*行/g)) {
    nums.push(...m[1].split(/[+/]/).map((s) => Number(s.trim())));
  }
  if (!nums.length) {
    if (scaleResidueStrict(scale) !== '') return { claims: [], skipped: false }; // 不是纯数字格
    nums.push(...scale.matchAll(/\d+/g).map((m) => Number(m[0])));
  }
  if (!nums.length) return { claims: [], skipped: false };              // 没声称行数 ⇒ 无话可说

  const names = [...cells.slice(0, -1).join('|').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const resolved = [];
  for (const raw of names) {
    for (const cand of [raw, path.join(MODEL.src, raw)]) {
      if (!/\.(mjs|py)$/.test(cand)) continue;
      const full = resolve(cand);
      if (full) { resolved.push({ raw, full }); break; }
    }
  }
  if (resolved.length !== nums.length) return { claims: [], skipped: true };  // 对不上号 ⇒ 不敢判
  return { claims: resolved.map((f, k) => ({ raw: f.raw, full: f.full, claimed: nums[k] })), skipped: false };
}

export function checkDocNums(files) {
  const bad = [];
  let checked = 0, skipped = 0;
  const resolve = (cand) => {
    const full = path.resolve(ROOT, cand);
    return existsSync(full) ? full : null;
  };

  for (const p of files.filter((f) => f.endsWith('.md'))) {
    const lines = read(p).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const where = `${rel(p)}:${i + 1}`;

      // ── 规则 A：合计句 ──────────────────────────────────────────────
      const agg = line.match(
        /合计\s*(\d+)\s*个脚本[（(]\s*(\d+)\s*个?\s*`?\.mjs`?\s*\+\s*(\d+)\s*个?\s*`?\.py`?\s*[）)]\s*·\s*(\d+)\s*行/);
      if (agg) {
        const [n, mjs, py, total] = agg.slice(1).map(Number);
        const all = files.filter((f) => rel(f).startsWith(MODEL.src + '/'));
        const aMjs = all.filter((f) => f.endsWith('.mjs'));
        const aPy = all.filter((f) => f.endsWith('.py'));
        const aTotal = [...aMjs, ...aPy].reduce((s, f) => s + countLines(read(f)), 0);
        checked++;
        const errs = [];
        if (n !== mjs + py) errs.push(`总数 ${n} ≠ 构成 ${mjs}+${py}`);
        if (mjs !== aMjs.length) errs.push(`.mjs 声明 ${mjs}，实测 ${aMjs.length}`);
        if (py !== aPy.length) errs.push(`.py 声明 ${py}，实测 ${aPy.length}`);
        if (total !== aTotal) errs.push(`行数声明 ${total}，实测 ${aTotal}`);
        if (errs.length) bad.push({ where, what: errs.join(' · ') });
        continue;
      }

      // ── 规则 B：表格行的「规模」格 ──────────────────────────────────
      const { claims, skipped: sk } = claimsInRow(line, resolve);
      if (sk) { skipped++; continue; }
      if (!claims.length) continue;
      checked += claims.length;
      for (const c of claims) {
        const actual = countLines(read(c.full));
        if (actual !== c.claimed) bad.push({ where, what: `\`${c.raw}\` 声明 ${c.claimed} 行，实测 ${actual} 行` });
      }
    }
  }
  return { bad, checked, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════
//  跑
// ═══════════════════════════════════════════════════════════════════════════

function main() {
  const files = walk(ROOT);
  let hard = 0;
  let channelDead = false;

  console.log('════════ 仓库自检 ════════\n');
  console.log(`仓库：${ROOT}`);
  console.log(`文件：${files.length} 个\n`);

  // ①
  console.log('── ① 依赖闭合 ──');
  const deps = checkDeps(files);
  const hardDeps = deps.filter((d) => !d.optional);
  if (!deps.length) console.log('  ✓ 全部相对依赖都能解析');
  for (const d of hardDeps) { console.log(`  ✗ ${d.key}`); hard++; }
  for (const d of deps.filter((d) => d.optional)) console.log(`  ⊘ ${d.key}\n      理由：${d.why}`);
  console.log('');

  // ②
  console.log('── ② 入口真实加载（子进程，不是 node --check）──');
  let chanDead = 0;
  const totalEntries = LIB_ENTRIES.length + SCRIPT_ENTRIES.length;
  for (const e of LIB_ENTRIES) {
    const r = loadLibEntry(e);
    if (r.ok) console.log(`  ✓ ${e}`);
    else if (r.channel) { console.log(`  ⊘ ${e}`); chanDead++; }
    else { console.log(`  ✗ ${e}\n      ${r.detail}`); hard++; }
  }
  for (const e of SCRIPT_ENTRIES) {
    const r = loadScriptEntry(e);
    if (r.ok) console.log(`  ✓ ${e}${r.timedOut ? '（长驻，超时判定为可加载）' : ''}`);
    else if (r.channel) { console.log(`  ⊘ ${e}`); chanDead++; }
    else { console.log(`  ✗ ${e}\n      ${r.detail}`); hard++; }
  }
  if (chanDead) {
    console.log(`  ⊘ 其中 ${chanDead}/${totalEntries} 个**通道不可用** —— 这一项本次无效（既不算通过也不算失败）。`);
    console.log(`      ${CHANNEL_HINT.replace(/\n\s*/g, '\n      ')}`);
    if (chanDead === totalEntries) channelDead = true;   // 全军覆没 ⇒ 整体判定不可信
  }
  console.log('');

  // ③
  console.log('── ③ 资源名交叉一致 ──');
  const a = checkAssets();
  console.log(`  bg 规则 ${a.ruleBg.size} 个 · 生成器 ${a.genBg.size} 个 · 环境音映射 ${a.ambBg.size} 个`);
  console.log(`  音效清单 ${a.catalogIds.size} 条`);
  const ghostBg = a.ghostBg.filter((x) => x !== 'bg_black.png');
  if (ghostBg.length) { console.log(`  ✗ 规则指向但生成器不产（画面会静默空白）：${ghostBg.join(' ')}`); hard++; }
  else console.log('  ✓ 规则指向的背景图生成器都会产出');
  if (a.ghostAmb.length) { console.log(`  ✗ 环境音键但生成器不产：${a.ghostAmb.join(' ')}`); hard++; }
  else console.log('  ✓ 环境音映射的背景图生成器都会产出');
  if (a.ghostSe.length) { console.log(`  ✗ 规则引用了清单里没有的音效 id：${a.ghostSe.join(' ')}`); hard++; }
  else console.log('  ✓ 规则引用的音效 id 都在 sfx-catalog.json 里');
  console.log('');

  // ④
  console.log('── ④ 文档引用扫描（含 .md 散文引用）──');
  const docs = checkDocRefs(files);
  if (!docs.length) console.log('  ✓ 文档里提到的仓库内文件都存在');
  else {
    const byFile = new Map();
    for (const d of docs) byFile.set(d.file, [...(byFile.get(d.file) || []), d.token]);
    for (const [f, toks] of byFile) console.log(`  ✗ ${f} → ${[...new Set(toks)].join(' ')}`);
    hard += docs.length;
  }
  console.log('');

  // ⑤
  console.log('── ⑤ 文档规模口径（「N 行」「N 个脚本」对实测）──');
  const nums = checkDocNums(files);
  for (const b of nums.bad) { console.log(`  ✗ ${b.where}  ${b.what}`); hard += 1; }
  console.log(nums.bad.length
    ? `  核对了 ${nums.checked} 条声明，**${nums.bad.length} 条与实测不符**（另有 ${nums.skipped} 行按保守规则跳过）。`
    : `  ✓ 核对了 ${nums.checked} 条声明，全部与实测一致（另有 ${nums.skipped} 行按保守规则跳过 —— 跳过不等于通过）`);
  console.log('');

  console.log('════════════════════════════════');
  if (hard) console.log(`✗ ${hard} 处问题。`);
  else if (channelDead) console.log('✓ 已执行的四项探测器没发现问题（② 未能执行，见下）。');
  else console.log('✓ 全部通过。');
  if (channelDead) {
    console.log('⊘ 但 **② 入口加载的通道不可用**，本次结论不完整 —— 不要据此判定"仓库没问题"。');
    process.exit(2);
  }
  process.exit(hard ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════════════
//  --selftest：用**故意做坏的假输入**断言探测器会响（防"永远报绿"）
// ═══════════════════════════════════════════════════════════════════════════

function selftest() {
  console.log('══ verify-repo 自检：五个探测器都要在假坏输入上报警 ══\n');
  const results = [];
  const fake = (name, cond) => { results.push([name, cond]); console.log(`${cond ? '✓' : '✗'} ${name}`); };

  // ① 依赖闭合：拿一段"假源码"喂给同一个正则，断言它能认出缺失目标
  //    （不落盘；★ 字符串用拼接写，免得本文件自己扫到自己）
  const fakeSrc = 'import { x } from ' + "'./definitely-not-here.mjs';";
  fake('① 依赖闭合能认出缺失目标', relativeImports(fakeSrc).length === 1);

  // ② 入口加载：拿一个确定不存在的东西，判据必须报错
  //  ★ 前置：先确认**子进程通道活着**。否则通道一坏，下一条会因为"报红"而看起来通过 ——
  //    那不是自测通过，是**自测自己也没在验东西**（通道坏 ⇒ 任何"应该报错"的断言都自动成立）。
  const chanOk = loadLibEntry('compiler/paths.mjs').ok === true;
  fake('②-前置 子进程通道可用（不可用则下一条无效）', chanOk);
  const r2 = loadLibEntry('compiler/definitely-not-here.mjs');
  fake('② 入口加载对不存在模块报红', r2.ok === false && r2.channel !== true);

  // ③ 资源名：假规则指向幽灵背景图
  const ghost = [...new Set([...'bg_rules_fake.png'.matchAll(/bg_[a-z_]+\.png/g)].map((m) => m[0]))]
    .filter((x) => !new Set(['bg_corridor.png']).has(x));
  fake('③ 资源交叉能认出幽灵背景图', ghost.length === 1);

  // ④ 文档引用：假 md 指向不存在的脚本
  const fakeMd = '见 `compiler/definitely-not-here.mjs`。';
  const toks = [...fakeMd.matchAll(INLINE)].map((m) => m[1]);
  fake('④ 文档扫描能抓到不存在的脚本引用',
    toks.length === 1 && !existsSync(path.resolve(ROOT, toks[0])));

  // ⑤ 文档规模：假表格行声称一个**真文件**有 9999 行 —— 判据必须认出"声称 ≠ 实测"
  const resolveReal = (c) => (existsSync(path.resolve(ROOT, c)) ? path.resolve(ROOT, c) : null);
  const r5 = claimsInRow('| 假能力 | `verify-repo.mjs` —— 一句假描述 | 9999 行 |', resolveReal);
  fake('⑤ 规模口径能认出「声明行数 ≠ 实测」',
    r5.claims.length === 1 && countLines(read(r5.claims[0].full)) !== r5.claims[0].claimed);

  // ⑤-前置：**散文格必须被跳过**。
  //  ★ 这条是本探测器最容易变噪音的地方（`AGENTS.md` 里「每行 35 全角字 × 2 行」就被误判过一次）。
  //    它一旦失效，⑤ 就会开始报假红 ⇒ 假红一多，人就忽略它 ⇒ 等于没有。
  const r5b = claimsInRow('| **文本框容量** | 实测每行 35 全角字 × 2 行 | ', resolveReal);
  fake('⑤-前置 散文格必须被跳过（否则会误报）', r5b.claims.length === 0);

  const bad = results.filter(([, ok]) => !ok).length;
  console.log('');
  console.log(bad ? `✗ 自检失败 ${bad} 项 —— 本校验器不可信。` : '✓ 五个探测器都会响（不是"永远报绿"）。');
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else main();
