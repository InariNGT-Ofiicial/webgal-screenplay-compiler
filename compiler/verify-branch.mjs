/**
 * verify-branch.mjs —— 死亡分支的**真实用户路径**验证
 *
 * 为什么需要它：编译通过 / 静态校验通过 **都不等于**「玩家点得进去」。
 * 项目的纪律是「演示跑通 ≠ 交付可用，必须有模拟真实用户操作的验证路径」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  做法：截取编译产物的**分支段**做调试场景（测的是同一份字节）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  主线到第一个分支点有 1900+ 拍，真点要点两千次。
 *  所以从主线场景文件里抽出 `label:_bp1;` **到文件末尾**，
 *  前面补一行 `label:main_start;`，另存为 `_debug_branch.txt`。
 *  这一段包含了：6 个分支点的部分（BP1 起）+ 全部 8 条 END + 吐槽出口，
 *  也就是**整条分支链的真实代码**。
 *
 *  然后把 start.txt 临时指向它 → 无头浏览器真点 → 验完**还原 start.txt**。
 *
 *  这样验的是：
 *    ① choose 选项真的渲染出来（且条数对）
 *    ② 点「死法选项」真的跳进对应 END（不是贯穿到主线）
 *    ③ END 播完真的进吐槽出口
 *    ④ 全程无控制台致命错误
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { BRANCH_POINTS, ENDS } from './branches.mjs';
import { ROOT, SCENE_DIR, mainlineSceneName } from './paths.mjs';

const MAINLINE_SCENE = mainlineSceneName();
const MAIN = path.join(SCENE_DIR, MAINLINE_SCENE);
const DEBUG = path.join(SCENE_DIR, '_debug_branch.txt');
const START = path.join(SCENE_DIR, 'start.txt');
const OUT = path.join(ROOT, 'compiler', 'demo-shots');

/** 要验的分支点与选项（默认 BP1 的第一个错误选项） */
const TARGET_BP = process.env.BP || 'BP1';
const TARGET_OPT = Number(process.env.OPT || 2); // 1 = 正确选项

// ═══════════════════════════════════════════════════════════════════════════
//  ① 造调试场景
// ═══════════════════════════════════════════════════════════════════════════

// ★ 缺产物时给三步指引，不甩 ENOENT 堆栈（与 build-demo.mjs 同一约定）。
if (!existsSync(MAIN)) {
  console.error('✗ 找不到编译产物，无法验证分支：');
  console.error(`   · ${path.relative(ROOT, MAIN)}`);
  console.error('');
  console.error('  先把它编译出来：node compiler/build-demo.mjs');
  console.error('  若提示缺剧本产物，再往前一步见 README「快速开始」。');
  process.exit(1);
}

const mainTxt = readFileSync(MAIN, 'utf8');
const lines = mainTxt.split('\n');
const bpLabel = `label:${(BRANCH_POINTS.find((b) => b.id === TARGET_BP) || {}).label};`;
const startLine = lines.findIndex((l) => l === bpLabel);
if (startLine < 0) {
  console.error(`✗ 找不到 ${bpLabel}，先跑 node build-demo.mjs`);
  process.exit(1);
}

const debugTxt = ['label:main_start;', ...lines.slice(startLine)].join('\n');
writeFileSync(DEBUG, debugTxt, 'utf8');
console.log(`调试场景：_debug_branch.txt（自第 ${startLine + 1} 行起，${lines.length - startLine} 行）`);

const startBackup = readFileSync(START, 'utf8');
writeFileSync(START, '; 临时调试入口（verify-branch.mjs 生成，验完还原）\nchangeScene:_debug_branch.txt;\n', 'utf8');
console.log('start.txt 已临时指向调试场景');

let restored = false;
function restore() {
  if (restored) return;             // ★ 幂等：退出兜底与 finally 会各调一次
  restored = true;
  writeFileSync(START, startBackup, 'utf8');
  if (existsSync(DEBUG)) {
    // 保留调试场景无妨，但清掉更干净
    try {
      writeFileSync(DEBUG, '; 已还原，可删除\nlabel:main_start;\nend;\n', 'utf8');
    } catch {
      /* ignore */
    }
  }
  console.log('start.txt 已还原');
}

// ★ 兜底：**任何**退出路径都必须还原 start.txt —— 含未捕获异常与 process.exit。
//   只靠下面那个 try/finally 有一个窗口：从 `writeFileSync(START…)` 到 `try` 之间若抛异常，
//   finally 根本不执行 ⇒ **调试入口被留在交付物里**（本文件最不该出现的残留）。
process.on('exit', () => { try { restore(); } catch { /* ignore */ } });

// ═══════════════════════════════════════════════════════════════════════════
//  ② 无头浏览器
// ═══════════════════════════════════════════════════════════════════════════

const BASE = 'http://127.0.0.1:8890';

/**
 * ★ 为什么不能直接拼路径（原先的写法）：
 *   · `LOCALAPPDATA` **只有 Windows 有**；Linux/macOS 上是 `undefined`
 *     ⇒ `undefined + '\\npm-cache\\_npx'` 拼出一串垃圾，`readdirSync` 抛裸 ENOENT，
 *       而那时 `start.txt` 已被改成调试入口、`try` 还没开始 ⇒ 交付物被污染。
 *   · headless shell 的目录名自带**构建号**（`…_shell-1243`），Playwright 一升级就变。
 * ⇒ 所以：候选路径一律**先判存在再读**，二进制**扫目录找**而不是写死；
 *   全找不到时的结论是「**这一项在本机没法验**」，不是「验证失败」——
 *   与沙箱通道坏掉时同一个口径（见 verify-repo.mjs 的 ⊘ 判据）。
 */
const SHELL_NAMES = [
  'chrome-headless-shell.exe', 'chrome-headless-shell',
  'headless_shell.exe', 'headless_shell',
];

function findPlaywright() {
  // ── playwright-core ──
  let core = null;
  try {
    const req = createRequire(import.meta.url);
    core = path.dirname(req.resolve('playwright-core/package.json'));
  } catch { /* 没装在仓里，继续找 npx 缓存 */ }

  if (!core) {
    const npxDirs = [
      process.env.npm_config_cache,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm-cache'),
      process.env.HOME && path.join(process.env.HOME, '.npm'),
      process.env.HOME && path.join(process.env.HOME, 'Library', 'Caches'),
    ].filter(Boolean).map((c) => path.join(c, '_npx')).filter((c) => existsSync(c));

    for (const npx of npxDirs) {
      for (const d of readdirSync(npx)) {
        const p = path.join(npx, d, 'node_modules', 'playwright-core');
        if (existsSync(path.join(p, 'index.mjs'))) { core = p; break; }
      }
      if (core) break;
    }
  }

  // ── headless shell（目录名带构建号 ⇒ 扫）──
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    process.env.HOME && path.join(process.env.HOME, '.cache', 'ms-playwright'),
    process.env.HOME && path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright'),
  ].filter((r) => r && existsSync(r));

  let shell = null;
  outer:
  for (const root of roots) {
    for (const d of readdirSync(root)) {
      if (!d.startsWith('chromium_headless_shell')) continue;
      const base = path.join(root, d);
      for (const sub of readdirSync(base)) {
        for (const name of SHELL_NAMES) {
          const exe = path.join(base, sub, name);
          if (existsSync(exe)) { shell = exe; break outer; }
        }
      }
    }
  }
  return { core, shell };
}

const { core: CORE, shell: SHELL } = findPlaywright();
if (!CORE || !SHELL) {
  console.error('⊘ 找不到无头浏览器 —— **这一项在本机没法验**（≠ 验证失败）：');
  console.error(`   playwright-core ：${CORE || '未找到'}`);
  console.error(`   headless shell  ：${SHELL || '未找到'}`);
  console.error('');
  console.error('   想跑这一项：npx playwright@latest install chromium-headless-shell');
  console.error('   分支正确性另有编译期覆盖：branches.mjs 的悬空跳转检查（verify-repo.mjs ③）。');
  console.error('   start.txt 会由退出兜底还原，不会把调试入口留在交付物里。');
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(path.join(CORE, 'index.mjs')).href);

const { mkdirSync } = await import('node:fs');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (c, n, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); }
};

// ★ 必须 try/finally：验证中途抛异常时，start.txt 也要还原，
//   否则会把调试入口留在交付物里。
let browser = null;
let exitCode = 0;
try {
browser = await chromium.launch({ headless: true, executablePath: SHELL });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 180)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/live2d|\.ogg|\.wav|sfx|\.mp3/i.test(t)) return;
  if (/Failed to load resource/i.test(t)) return;
  errors.push(t.slice(0, 180));
});

/**
 * 归一化：去空白 + 折叠连续重复字符。
 *
 * ★ 为什么要折叠：WebGAL 的文本框是**逐字动画**，一个字渲染成 3 层
 *   （描边/阴影/主体），innerText 读出来是「尖\n尖\n尖\n刀\n刀\n刀…」。
 *   折叠后即得整句。**比对的两侧要用同一个归一化**，否则永远不比中。
 */
const norm = (s) => String(s ?? '').replace(/\s+/g, '').replace(/(.)\1+/g, '$1');

const textBox = () =>
  page.evaluate(() => {
    const clean = (t) => (t || '').replace(/\s+/g, '');
    // ★ 实测（_probe-choose.mjs）：真正持有正文的是 TextBox_Container；
    //   TextBox_main / TextBox_textElement / __enhanced_text 在构建产物里都取不到。
    const cands = [
      '[class*="TextBox_Container"]',
      '[class*="TextBox_main"]',
      '.__enhanced_text',
    ];
    for (const s of cands) {
      const texts = [...document.querySelectorAll(s)].map((e) => clean(e.innerText)).filter(Boolean);
      if (texts.length) return texts.sort((a, b) => b.length - a.length)[0];
    }
    return '';
  });

/**
 * 读当前选项。
 *
 * ★ 实测（_probe-choose.mjs）：选项元素用的是 **emotion 生成的类名**
 *   （`css-1a0qwn0` / `css-191qauy`），**不是** CSS module 的 `Choose_item_*`
 *   —— 后者在构建产物里存在但没被用在游戏内的 choose 上。
 *   所以按 `#chooseContainer` 取「无子元素的 div」，这既稳又跟版本无关。
 */
const chooseOptions = () =>
  page.evaluate(() => {
    const cc = document.getElementById('chooseContainer');
    if (!cc) return [];
    return [...cc.querySelectorAll('div')]
      .filter((e) => e.children.length === 0)
      .map((e) => (e.innerText || '').trim())
      .filter(Boolean);
  });

/** 点选项：先量出目标元素的位置，再用真实鼠标点击（尽量贴近真人操作） */
const clickOption = async (txt) => {
  const box = await page.evaluate((t) => {
    const cc = document.getElementById('chooseContainer');
    if (!cc) return null;
    const el = [...cc.querySelectorAll('div')]
      .filter((e) => e.children.length === 0)
      .find((e) => (e.innerText || '').includes(t));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, txt);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
};

const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });

console.log('');
console.log(`══ 分支验证 · ${TARGET_BP} 的第 ${TARGET_OPT} 个选项 ══`);

const bp = BRANCH_POINTS.find((b) => b.id === TARGET_BP);
const expectedOption = bp.options[TARGET_OPT - 1];
const targetEnd = expectedOption.correct ? null : ENDS.find((e) => e.id === expectedOption.end);

console.log(`  目标选项：「${expectedOption.text}」${expectedOption.correct ? '（正确，应回主线）' : `→ ${targetEnd.id}`}`);
console.log('');

await page.goto(BASE + '/', { waitUntil: 'load' });
await sleep(3000);

await page.evaluate(() => document.querySelector('.html-body__title-enter')?.click());
await sleep(1800);
const started = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(
    (e) => e.children.length === 0 && e.textContent?.trim() === '开始游戏',
  );
  if (!el) return false;
  el.click();
  return true;
});
ok(started, '点开始游戏');
await sleep(2500);

// 推进到选项出现
let opts = [];
let clicks = 0;
for (; clicks < 40; clicks++) {
  opts = await chooseOptions();
  if (opts.length) break;
  await page.mouse.click(640, 620);
  await sleep(350);
}
await shot(`br-${TARGET_BP}-choose`);

ok(opts.length === bp.options.length, `选项渲染出 ${bp.options.length} 条`, `实为 ${opts.length}: ${JSON.stringify(opts)}`);
ok(
  bp.options.every((o, i) => opts[i] && opts[i].includes(o.text.slice(0, 4))),
  '选项文字与数据一致',
  JSON.stringify(opts),
);
console.log(`    实际选项：${JSON.stringify(opts)}`);

// 点目标选项（真实鼠标点击）
const clicked = await clickOption(expectedOption.text.slice(0, 6));
ok(clicked, '点中目标选项', expectedOption.text.slice(0, 6));
await sleep(1600);
await shot(`br-${TARGET_BP}-picked`);

// 收集后续文本
const seen = [];
for (let i = 0; i < 120; i++) {
  const t = await textBox();
  if (t && seen[seen.length - 1] !== t) seen.push(t);
  const stillChoosing = (await chooseOptions()).length > 0;
  if (stillChoosing) break;
  await page.mouse.click(640, 620);
  await sleep(170);
}
const joined = seen.join('\n');
const joinedN = norm(joined);

if (targetEnd) {
  // 死法路径：必须看到 END 独有的句子，且看到吐槽出口
  const probe = targetEnd.beats[targetEnd.beats.length - 1].text;
  ok(joinedN.includes(norm(probe)), `进入 ${targetEnd.id}（末句「${probe}」）`,
    `已见 ${seen.length} 句：${JSON.stringify(seen.slice(-3).map((x) => x.slice(0, 30)))}`);
  // 不能出现主线后续内容（防贯穿）
  const leak = '队伍中传来一丝极其细微的骚动';
  ok(!joinedN.includes(norm(leak)) || TARGET_OPT === 1, '未贯穿回主线内容',
    joinedN.includes(norm(leak)) ? '出现了主线后续' : '');
  const hintOk = joinedN.includes(norm('她会回来的。'));
  ok(hintOk, '进入吐槽出口（FSN 老虎道场式）',
    JSON.stringify(seen.slice(-6).map((x) => x.slice(0, 24))));
  await shot(`br-${targetEnd.id}-end`);
} else {
  // 正确路径：应继续演主线紧随其后的原句
  ok(joined.length > 0, '正确选项后继续演主线', JSON.stringify(seen.slice(0, 3)));
  await shot(`br-${TARGET_BP}-ok`);
}

  console.log('');
  console.log('  采样（已归一化）：');
  seen.slice(0, 4).forEach((t) => console.log('    ' + JSON.stringify(norm(t).slice(0, 44))));
  console.log('    …');
  seen.slice(-4).forEach((t) => console.log('    ' + JSON.stringify(norm(t).slice(0, 44))));

const real = [...new Set(errors)];
if (real.length) {
  console.log('');
  real.slice(0, 6).forEach((e) => console.log('    · ' + e));
}
ok(real.length === 0, '无控制台致命错误', real.join(' | '));

} catch (e) {
  console.error('验证异常：', e);
  exitCode = 1;
} finally {
  if (browser) await Promise.race([browser.close(), sleep(6000)]).catch(() => {});
  restore();
}

console.log('');
console.log('════════════════════════════════════════');
console.log(`  通过 ${pass} · 失败 ${fail}`);
console.log('════════════════════════════════════════');
process.exit(fail ? 1 : exitCode);
