# 验收方法

本页命令在 `production/` 内运行；根目录入口 `npm test` 和 `npm run check` 会同时验证文字剧本编译链与生产层。

离线回归验证正文与章节边界、CG 期间退场、永久退役、黑场、左右槽互斥、相邻 CG、等比镜像、配乐恢复、原生脚本转义和悬空跳转。故意坏样本验证语法检查通道和发布审计通道能报错。

```sh
npm test
npm run check
npm run demo
```

原生场景静态检查与文件校验：

```sh
node tools/verify-game.mjs webgal/dist build/game-verification.json
```

浏览器验收是可选开发依赖；可以本地安装 `playwright`，或用 `PLAYWRIGHT_MODULE` 指定模块文件，并用 `BROWSER_PATH` 指定已安装的 Chromium。工具不寻找某个用户的缓存目录，不自动下载浏览器。

```sh
node tools/e2e.mjs webgal/dist build/e2e
```

脚本使用真实鼠标点击放行音频，等待官方快照和原生菜单；验证两章自动档、八槽可见、原生预览、读入章节档后重写与覆盖，以及真实音频播放、浏览器错误和资源请求。结果为 `verification.json`，截图为原生画面证据。

额外的受控失败测试在适配器点击存档槽的边界故意抛错，验证失败提示、可信输入阻断与关闭故障后的原生重试。它不替换渲染器或存档实现。

浏览器 E2E 针对本仓库提供的示例，不是任意作品的全路线测试器。自己的游戏须从 `sourceMap` 中选择稳定演出点，覆盖 CG 交接、角色退场、各分支和存档边界。静态检查不能证明画面或音频正确，截图也不能代替读档测试。

发布审计读取暂存内容：

```sh
git add .
node tools/audit-source.mjs
```

可传入本地 JSON 字符串数组作为额外的私有关键词清单。此清单不应提交。输出只给出文件、行号和类别，避免再次打印可疑凭据。
