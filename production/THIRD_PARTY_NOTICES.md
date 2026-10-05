# 第三方说明

本源码包未包含 WebGAL、Live2D、Spine、第三方字体或任何外部音乐、美术素材。

| 部件 | 用途 | 分发情况 |
|---|---|---|
| [WebGAL](https://github.com/OpenWebGAL/WebGAL) | 原生 VN 渲染与存档 | 外部安装；本机检查到其许可证为 Mozilla Public License 2.0 |
| [WebGAL 4.6.5](https://github.com/OpenWebGAL/WebGAL/releases/tag/4.6.5) | 验证用固定发行版 | 不包含在源码 ZIP；游戏打包时保留上游许可 |
| [Playwright](https://github.com/microsoft/playwright) | 可选浏览器验收 | 不附带模块或浏览器；按安装版本许可使用 |
| Node.js / Python | 本地运行与源码导出 | 使用者自行安装 |

本工具自有代码、文档、示例文本以及可复现的几何 PNG 和合成音调采用本仓库 MIT 许可。外部引擎和后来放入游戏目录的资源保留各自许可，不会因本工具使用 MIT 而自动转换许可。

`tools/package-game.mjs` 要求提供上游许可证文件，复制到游戏包的 `licenses/`。该命令无法判断任意艺术资源的授权；使用自己的资产时须随包附正确署名和许可。两项可选 Live2D SDK 不在官方网页版包中，本示例不使用它们。
