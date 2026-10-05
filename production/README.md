# WebGAL Production Kit · 生产层

已接入 `webgal-screenplay-compiler`，仓库根统一入口见 [接驳说明](../docs/production-integration.md)。本页命令在 `production/` 内执行。

将 WebGAL 原生剧本组装为可交付游戏的生产工具。由 Codex 阶段的演出、封装与验收工具提取，使用数据配置替代原工程中固定的角色、章节和素材编号。

包含 CG 与立绘的舞台记忆、等比立绘校准、章节拆场景、原生八槽章节存档、文件镜像校验和可回退安装。渲染、对白、菜单和存档格式由 WebGAL 提供。

Node.js 22 或更新版本；生产工具无 npm 运行依赖。兼容目标为 **WebGAL 4.6.5、中文原生 UI**。Python 3 仅用于导出源码 ZIP，Playwright 仅用于可选浏览器验收。

## 五分钟验证

```sh
npm test
npm run check
npm run demo
```

演示包含两个章节、八段原创对白与旁白、两个人物几何占位图、CG、广播音效和两种合成配乐。占位素材由 Node 生成，无须 API key、第三方素材或 WebGAL 即可完成编译与离线测试。

生成目录：`build/demo/game/`。`assembly-report.json` 提供正文不变式、素材清单、场景图和逐拍源码映射；`anchors.lock.json` 用正文摘要防止锚点漂移。

## 在 WebGAL 中运行

从 [WebGAL 官方 4.6.5 Release](https://github.com/OpenWebGAL/WebGAL/releases/tag/4.6.5) 下载网页版发行包，解压后让 `webgal/dist/index.html` 存在，再执行：

```sh
node tools/install.mjs build/demo webgal/dist
node tools/serve.mjs webgal/dist
```

打开 `http://127.0.0.1:8895/`，点击开始游戏。第一、二章结束时，工具通过官方舞台快照识别章节边界，打开原生存档菜单，在槽位 1、2 保存并恢复演出。其余六槽可手动保存。

Windows 可双击 `launch.cmd`；`stop.cmd` 只停止本目录记录且健康检查匹配的进程。首次启动仍需安装 Node 与 WebGAL，并执行上述编译、安装命令。

回退安装：

```sh
node tools/install.mjs build/demo webgal/dist --restore
```

安装器备份所覆盖的项目文件；不改引擎 bundle。重复安装前先回退，避免备份被新产物覆盖。`webgal/` 与备份目录不提交到源码仓库。

## 用自己的工程

复制 `examples/demo/project.json`，将原生剧本按稳定的 `beat.id` 分组，配置背景、人物进退场、CG 区间、音乐和音效。素材根目录分为 `background/`、`figure/`、`cg/`、`bgm/`、`effect/`。

```sh
node tools/build.mjs my-project/project.json --out build/my-game --assets my-project/assets
node tools/install.mjs build/my-game webgal/dist
node tools/verify-game.mjs webgal/dist build/game-verification.json
```

`--assets` 会在写盘前检查本工具声明的素材；省略它可只编译剧本。素材路径使用相对路径和英文文件名。正文中的原生语音、动画等附加参数由使用者准备对应资源。

正文变化后旧锁会阻止重建。核对正文和演出配置后，使用 `--accept-anchors` 接受新锁。修改正文时须给项目换 `gameKey`，避免旧原生存档指向新的剧本行。

详见 [配置契约](docs/project-contract.md)、[运行时与兼容边界](docs/runtime.md) 和 [验收方法](docs/verification.md)。

## 交付与开源

游戏打包采用全量校验清单，并要求新目标目录，避免留下上次版本已删除的素材：

```sh
node tools/package-game.mjs webgal/dist releases/my-game path/to/WebGAL-LICENSE.txt
```

此命令会复制引擎与当前 `dist` 中的素材；分发前请补齐这些素材的许可和署名。源码发布与游戏发布是两种不同的交付物。

源码导出严格读取 Git 索引：

```sh
cd ..
git add .
npm run audit
python production/tools/export-source.py ../webgal-screenplay-compiler-0.2.0-source.zip
```

ZIP 包附带逐文件 SHA-256 清单，包外附总校验和。扫描通过后仍需通读新增示例、注释和文档；机械扫描不能证明所有作品内容或凭据均已排除。

## 范围与许可

本仓库包含 Codex 阶段提取的生产工具与新编写的通用示例，采用 [MIT](LICENSE)。WebGAL 是外部引擎，保留其独立许可；参见 [第三方说明](THIRD_PARTY_NOTICES.md)。

原游戏正文、角色设定、美术、OST、配音实验、实机截图、旧验收报告和个人工作记录均未纳入源码包。现有文字剧本编译链已通过原生 `game/` 目录接入；LLM 叙事决策与在线注入服务不属于本仓范围。[提取对应表](docs/extraction.md) 说明本次保留的能力及其来源。

新提取工具的验证结果见 [发布验证记录](docs/release-verification.json)。原工程曾通过的验收数字不等于本仓库通过的测试数量。
