# 配置契约 v1

`examples/demo/project.json` 是可执行示例。顶层使用 `schemaVersion: 1`、显示名 `name`、独立存档键 `gameKey` 和非空 `chapters`。

每章有英文 `id` 和非空 `beats`。每拍有全工程唯一、稳定的英文 `id`，以及单行原生脚本组成的 `lines`。不能把多行脚本藏在一个字符串里。人物、背景、音乐、音效由 `cues` 管理，避免原生舞台指令与组装器争夺状态。

## 原生正文

```json
{"id":"greeting","lines":["say:你好。 -speaker=向导 -figureId=guide;"]}
```

旁白用 `:正文;`。标签、选择与跳转可直接写原生指令；每个 `choose` 或 `jumpLabel` 目标必须在同一章中有唯一 `label`。跨章使用 `changeScene`，目标须为本次生成的文件。章节边界应设在分支汇合处；工具不会擅自删掉错误路线。

工具会保持正文顺序和数量。它不承担 DOCX 提取、LLM 生成、文本框切分或字数体检；这些属于上游叙事编译链。

## 演出事件

| 配置 | 字段 | 行为 |
|---|---|---|
| `backgrounds` | `at`, `file`, 可选 `clearPresence` | 换物理场景；默认清掉现场人物 |
| `presence` | `at`, `enter`, `exit`, `retire` | 显式管理现场人物；`enter` 为 `{id,side}` 数组 |
| `shots` | `from`, `to`, `file`, 可选 `title`, `media` | 显示 CG，暂时隐藏立绘并保留现场记忆 |
| `blackouts` | `from`, `to` | 黑场；默认清现场，结束后须显式重新入场 |
| `music` | `at`, `file`, `volume` | 更新基础配乐 |
| `musicRanges` | `from`, `to`, `file`, `volume` | 暂时覆盖基础配乐，到期恢复 |
| `sounds` | `at`, `file`, `volume` | 发出无 `-id` 的单次音效 |

所有锚点使用 `beat.id`；区间为 `[from,to)`，`to` 可为 `$end`。同类区间不得重叠。相邻 CG 可直接交接。一个锚点可有多个音效；WebGAL 无 `-id` 音效共享通道，连续事件可能互相截断，需混合时先离线合成。

人物左右各一个位置；新人物占用同位时，旧人物从现场和画面退场。`exit` 可以再次进入，`retire` 不能再入场。CG 期间的退场依旧生效，CG 结束只恢复仍在现场的人物。广播、电话或画外音不会因说话人名字自动上场。

`media` 会设置 `_release_news`，便于自定义 CSS；当前通用样式不附带新闻遮罩。`blackoutClearsPresence:false` 可让黑场保留现场记忆。

## 立绘标尺

`characters.<id>` 提供 `file` 和 `profile`：图片高度 `height`、透明顶边 `top`、朝向 `facing`（1 或 -1）、人工校准的 `displayPixelScale`。可选 `framing` 调整 `stageHeight`、`lateral`、`vertical`。

显示比例从同一实测标尺得出，x/y 的绝对缩放相等。朝向只改变 x 的正负；不按年龄、性别或画布宽度给倍率。应测脸宽、肩关节和下颌，以原画比例校准 `displayPixelScale`，不能拿头发或装备外廓当脸宽。

## 显示层修订

默认不删标点、括号或注释。`display.ruby` 为精确的 `{base,note}` 表；例如将 `信标（Beacon）` 转成原生 `[信标](Beacon)`。`display.replace` 只替换精确整句；`display.omit` 只跳过精确整句。

任何变化都会记录到 `assembly-report.json` 的 `displayChanges`，源数据保持原样。这里的正文不变式比较的是经明确显示规则处理后的原文。

## 存档与尾页

`checkpoints:true` 在每章末加入原生阻塞选择，最多八章，对应原生第一页面槽位 1—8。`credits` 是原生脚本行数组，可设置感谢页和结束菜单。原生附加参数或脚本引用的资源须由使用者准备；素材声明检查只涵盖 `cues`、角色、标题图与标题音乐。

生成后的逐拍 `sourceMap` 给出源摘要、场景文件、起止行和舞台预期状态，供真浏览器截图验收使用。
