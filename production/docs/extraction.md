# Codex 阶段提取对应表

本次基于 V9.1 交付工程整理生产工具，不等待前阶段叙事层审计。原始工程和发布版保持原样，开源候选放在独立目录。

| 原始部件 | 通用对应物 | 提取方式 |
|---|---|---|
| assembly/presentation.mjs（来源部件，未分发） | `../src/presentation.mjs` | 将舞台记忆、CG 交接、音乐覆盖和退场约束改为稳定 ID 与配置事件 |
| assembly/presentation-plan.mjs（来源部件，未分发） | `../src/portrait.mjs`、`project.json` | 保留等比校准公式；移除角色、服装、幕号和剧情数据 |
| assembly/assemble-release.mjs（来源部件，未分发） | `../src/assembly.mjs` | 保留原生拆场景、章节档和正文不变式；去掉固定八章及删除支线的特例 |
| assembly/text-notes-v8.mjs（来源部件，未分发） | `formatLine` | 保留精确注音与显示修订；原作术语表不随仓库发布 |
| `dist/game/release-runtime.js` | `runtime/release-runtime.js` | 提取原生菜单与官方快照适配；保留兼容版本边界 |
| `ui-v8.css` | `runtime/native-ui.css` | 保留八槽原生布局；移除原作字体、存档底图与视觉皮肤 |
| `launch.ps1`、`stop.ps1` | 同名脚本 | 改为相对路径和独立本地服务，保留 PID/工程归属检查 |
| package_release.py（来源部件，未分发）、版本化验收脚本 | `../tools/package-game.mjs`、`../tools/verify-game.mjs`、`../tools/e2e.mjs` | 提取完整镜像校验、真实用户点击与读档验收；不复制作品夹具和缓存私径 |

这是一份重新配置化的提取，不是对旧脚本执行人名替换。原工程中的逐幕人工判断仍留在原工程，不能靠换词变成适用于所有作品的算法。

## 未纳入源码包

作品正文和角色表；立绘、背景、CG、音乐、音效录音及字体；配音生成与参考音频；原始验收截图、网页 dump 和含正文的报告；供应商回包、任务日志、私有路径；WebGAL 引擎发行包与源码；前阶段叙事引擎候选仓库。

保留通用工程能力，并以新写的微型观测站示例重新验收。原工程的验收数量、正文规模和素材数量不写成新仓库的能力宣传。

前阶段候选仓库此次暂不合并，其先前复制品也不在本次源码 ZIP 中。
