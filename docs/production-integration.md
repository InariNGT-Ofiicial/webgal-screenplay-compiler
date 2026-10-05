# Codex 生产线接驳

仓库现有 `compiler/` 负责文字剧本编译；`production/` 负责演出组装、可回退安装和交付验收。接驳点是原生 `game/` 目录，而不是重新转换 `beats.json`。双方共享 `production/src/script.mjs` 的转义函数，保留原有切分、内容锚点与配乐规则的唯一实现。

## 先跑离线示例

Node.js 22 或更新版本；Python 3 用于全仓语法检查与源码导出。无须 npm install、API key、自己的作品或 WebGAL 即可执行：

```sh
npm test
npm run check
npm run demo
node production/tools/import-game.mjs --game production/build/demo/game --out build/import-demo
```

生产示例在 `production/build/demo/`。最后一条命令验证产物接驳，生成 `owned-files.json` 和 `assembly-report.json`；示例已包含显式启用的章节存档扩展。资源由 Node 现场生成，不提交图片、音频或原作品正文。

## 接已有编译器产物

先按根目录 README 完成自己的剧本编译，配置 `SCENE_CUE`、分支和素材，运行 `compiler/build-demo.mjs`。编译默认输出位置仍由 `compiler/paths.mjs` 管理。

```sh
npm run import:compiler
```

默认读取 `webgal-tool/dist/game/`，写入 `build/production/`。可使用 `--game` 和 `--out` 指定其他目录。导入前检查可达场景、标签和常用原生资源引用；缺失时中止。导入默认保留整个 `game/` 的原始字节，包括正文、分支 END、BGM、语音、CSS 和模板，不推断章节、不新增客户端脚本。

`assembly-report.json` 记录原文件摘要、输出摘要、场景图和正文不变式。重建只移除上一次清单中已删除的文件；不接受非托管输出目录、越界路径和符号链接。

资源预检覆盖 `changeBg`、`changeFigure`、`bgm`、`playEffect`、`playVideo`、`unlockCg`、`-vocal`、`-backgroundImage` 与标题配置。主题内部资源和其他原生扩展字段会完整复制，仍须在浏览器中检查加载与许可。导入不重写现有分支，也不把单个主线文件自动拆成多个场景。

## 安装、试玩、回退

从 [WebGAL 4.6.5 官方 Release](https://github.com/OpenWebGAL/WebGAL/releases/tag/4.6.5) 下载网页版，解压到另一份 `production/webgal/dist/`，确保存在 `index.html`。然后在仓库根运行：

```sh
node production/tools/install.mjs build/production production/webgal/dist
node production/tools/serve.mjs production/webgal/dist
```

打开 `http://127.0.0.1:8895/`。Windows 可以在 `production/` 双击 `launch.cmd`；`stop.cmd` 根据工程根目录与 PID 停止对应服务。直接体验生产示例时，将安装命令的 `build/production` 换成 `production/build/demo`。

```sh
node production/tools/install.mjs build/production production/webgal/dist --restore
```

安装器备份所覆盖的游戏文件、不改引擎 bundle。已安装时必须先回退再安装，避免覆盖原始备份。回退保留备份副本。默认原生产物无需本项目的客户端代码；服务只有在游戏包含 `release-runtime.js` 时才在响应的 HTML 中加载它，磁盘上的引擎 HTML 保持原样。

## 显式启用章节自动存档

为现有编译器产物新建一份本地 JSON 数组。每个 `after` 是场景里完整、唯一的一行原生脚本，插入发生在其后。选择实际会经过的章末边界；不要放在 `end` 或跳离场景的指令之后。

```json
[
  { "scene": "mainline.txt", "after": ":第一段结束。;", "slot": 1 },
  { "scene": "mainline.txt", "after": ":第二段结束。;", "slot": 2 }
]
```

```sh
node production/tools/import-game.mjs --checkpoints my-checkpoints.json --game-key my-game-checkpoints-v2 --out build/checkpoints
```

锚点必须恰好命中一次，槽位为互不重复的 1—8。必须更换 `Game_key`，避免旧存档行号指向新增指令。此模式保留原 CSS 并追加原生八槽布局，插入原生阻塞选择，通过中文原生菜单保存、确认覆盖和恢复。保存失败会阻断继续并提供重试按钮。

版本边界为 **WebGAL 4.6.5 中文原生 UI**，需使用本工具的本地服务提供官方舞台快照连接。原生手动存档格式仍由 WebGAL 管理。DOM 主题、语言和版本更换后要重新实机验收；详见 [运行时说明](../production/docs/runtime.md)。

## 验收与交付

离线测试包含真实 `build-demo.mjs` 编译 → 导入 → 安装 → 回退，以及分支、资源缺失、存档锚点漂移和文件越界的负向验证。该编译测试使用临时公开示例与占位文件，验证文件衔接；浏览器测试使用生成的 PNG/WAV 验证实际播放和存档。

```sh
node production/tools/verify-game.mjs production/webgal/dist build/game-verification.json
node production/tools/e2e.mjs production/webgal/dist build/e2e
node production/tools/package-game.mjs production/webgal/dist releases/my-game path/to/WebGAL-LICENSE.txt
```

E2E 需另装 Playwright 与浏览器，仅适用于安装了生产示例的目录；可用 `PLAYWRIGHT_MODULE`、`BROWSER_PATH` 指向已有安装。打包要求新的目标目录和上游许可，逐文件核对镜像摘要。作品资源的权利与署名由使用者补齐。

```sh
git add .
npm run audit
python production/tools/export-source.py ../webgal-screenplay-compiler-0.2.0-source.zip
```

源码审计与导出读取整个仓库的 Git 索引。包中不包含 WebGAL、生成素材、运行目录、个人路径或作品正文。`production/LICENSE` 保留提取工具的 MIT 声明；上游 WebGAL 和使用者素材保留各自许可。此前独立工具包的验证记录保留在生产目录，本次接驳记录见 [集成验证记录](integration-verification.json)。
