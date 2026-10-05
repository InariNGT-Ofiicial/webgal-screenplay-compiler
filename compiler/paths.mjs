/**
 * paths.mjs —— 编译产物的**路径与文件名**的唯一真源
 *
 * 为什么单独一个文件：
 *   「主线场景叫什么」这件事，至少四个脚本都要知道 ——
 *   `build-demo.mjs`（写）、`verify-branch.mjs`（读）、`verify-sfx.mjs`（读）、
 *   `sfx-report.mjs`（读）。散在四处 ⇒ 改名时**必然漏一处**，而漏了**不一定报错**
 *   （读不到就是静默跳过 / 报一个和真因无关的错）。
 *   ⇒ 全部从这里 import，一处改名，四处跟着动。
 *
 * 为什么产物名不带具体作品痕迹：
 *   本仓库**不含任何具体作品的剧本文本**（见 README §一）。产物名同理 ——
 *   留一个中性默认值，想改就用 `--scene=<文件名>` 或环境变量 `SCENE`。
 *
 * ★ 它**不导入任何兄弟模块**，所以可以放心被任何脚本 import（不会形成环）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件在 `compiler/` 下）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 上游 WebGAL 发行版的地盘（本仓不入库，见 .gitignore）。 */
export const WEBGAL_DIST = path.join(ROOT, 'webgal-tool', 'dist');

/** WebGAL 的场景目录 —— 编译产物落这里。 */
export const SCENE_DIR = path.join(WEBGAL_DIST, 'game', 'scene');

/** 主线场景的**默认文件名**。 */
export const DEFAULT_MAINLINE = 'mainline.txt';

/**
 * 解析主线场景文件名。
 *   优先级：`--scene=<名>` > 环境变量 `SCENE` > `DEFAULT_MAINLINE`。
 *   只接受**裸文件名**（不接受路径）—— 产物必须落在 `SCENE_DIR` 里，
 *   否则 WebGAL 的 `changeScene` 找不到它，而这是**不报错**的那类故障。
 *
 * @param {string[]} [argv] 命令行参数（默认取 process.argv 去掉前两项）
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 文件名，如 `mainline.txt`
 */
export function mainlineSceneName(argv, env = process.env) {
  const args = argv ?? process.argv.slice(2);
  const hit = args.find((a) => a.startsWith('--scene='));
  const name = (hit ? hit.slice('--scene='.length) : '') || env.SCENE || DEFAULT_MAINLINE;
  if (!/^[A-Za-z0-9_.-]+\.txt$/.test(name)) {
    console.error(
      '✗ --scene 只接受裸文件名：字母 / 数字 / _ / - / . ，且以 .txt 结尾\n' +
      `  收到：${name || '(空)'}\n` +
      '  例：--scene=mainline.txt',
    );
    process.exit(1);
  }
  return name;
}

/** 主线场景的绝对路径。 */
export function mainlineScenePath(argv, env) {
  return path.join(SCENE_DIR, mainlineSceneName(argv, env));
}
