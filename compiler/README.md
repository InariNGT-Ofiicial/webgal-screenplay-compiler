# compiler · 编译链

> **文字剧本编译目录。** 它把一份文字剧本编译成 **WebGAL 原生场景文件**——
> 产物丢进未修改的上游 WebGAL 就能玩，默认运行时仅使用 WebGAL。生产交付与可选章节存档扩展见 [`../docs/production-integration.md`](../docs/production-integration.md)。

- 完整架构与设计取舍 → [`../docs/architecture.md`](../docs/architecture.md)
- 改这个目录前的不变量与红线 → [`AGENTS.md`](AGENTS.md)
- WebGAL 的操作红线（实测踩出来的） → [`../docs/webgal-redlines.md`](../docs/webgal-redlines.md)

---

## 跑一遍

```bash
python extract-docx.py 你的剧本.docx    # ① docx → 结构化 JSON
node   docx-to-mainline.mjs             # ② → 主线指令流（beats.json）
node   demo-assets.mjs                  # ③ 占位背景与立绘（纯 Node 手写 PNG）
python make-sfx.py                      # ④ 42 条占位音效（纯合成，需 numpy+scipy，可跳过）
node   build-demo.mjs                   # ⑤ → WebGAL 原生场景文件
node   verify-sfx.mjs                   # ⑥ 音效产物校验（可跳过）

node   test-screenplay.mjs              # 剧本规范体检器测试（70 项）
node   test-split.mjs                   # 断框切分测试（26 项）
```

> ⚠️ **`bgm-cues.mjs` 的 `SCENE_CUE` 出厂是空的。** 不填时 `build-demo.mjs`
> 会**明确报错并列出「哪些场景没有配乐」**，而不是默默让全场静音——这是设计。
>
> ★ **音效不需要下载任何东西。** `make-sfx.py` 是**合成器**：读 `sfx-catalog.json`
> 的参数现场生成，零第三方权利。想换更真实的声音再走 `fetch-sfx.py`
> 拉 **CC0** 素材替换（出处逐条登记在 `sfx-sources.json`）——两条路产出同一批文件名。

---

## 数据流

```
剧本文本 .docx
   │  extract-docx.py          zipfile 解析 → script.json { meta, nodes[] }
   ▼
结构化剧本
   │  docx-to-mainline.mjs     角色表 + 模式规则 + 断框切分 + 丢弃编辑层表述
   ▼
mainline/beats.json            可渲染的一拍一拍
   │
   │  build-demo.mjs           调用下面几个规则模块，产出 WebGAL 场景文件
   ├── bg-rules.mjs            场景 → 背景图
   ├── sfx-rules.mjs           文本 → 音效（读 sfx-catalog.json）
   ├── bgm-cues.mjs            场景 → 配乐落点（读 segments.mjs 的段落）
   ├── paths.mjs               产物路径与文件名（唯一真源）
   └── demo-assets.mjs         占位图（与 bg-rules 的目标名对齐）
   ▼
webgal-tool/dist/game/         WebGAL 原生场景文件 + config.txt
   ▲
   └── make-sfx.py             音效：读 sfx-catalog.json 现场合成 → effect/*.wav
       └── fetch-sfx.py        可选：拉 CC0 素材替换（登记在 sfx-sources.json）
```

**链序不能乱。** 中间任何一步改了切分或编号，下游全部失效且**不一定报错**。

---

## 每个文件管什么

| 文件 | 作用 | 行数 |
|---|---|---|
| `extract-docx.py` | docx → 结构化 JSON（走 `zipfile`，比 python-docx 可靠） | 144 |
| `docx-to-mainline.mjs` | 结构化 JSON → 主线指令流 | 503 |
| `text-split.mjs` | **文本框切分器的唯一实现** | 483 |
| `textbox.mjs` | **文本框几何的唯一真源**（真机实测） | 117 |
| `editorial.mjs` | **「编辑层表述」的唯一识别实现**（预告 / 卷末旗标） | 70 |
| `anchor.mjs` | 剧情锚点的唯一解析实现（按内容子串匹配，不依赖断框） | 53 |
| `branches.mjs` | 分支数据源（**示例**，换成你自己的） | 125 |
| `verify-branch.mjs` | 分支悬空跳转体检（无头浏览器，需 WebGAL 发行版；**找不到浏览器时明确报「没法验」而不是崩**） | 378 |
| `bg-rules.mjs` | 场景 → 背景图规则 | 53 |
| `sfx-rules.mjs` | 文本 → 音效判定 | 235 |
| `sfx-catalog.json` | **音效资产定义的唯一真源**（42 条：25 单发 + 17 环境床） | 数据 |
| `sfx-sources.json` | **音效出处与许可证登记的唯一真源**（只收 CC0） | 数据 |
| `make-sfx.py` | ★ **音效离线合成器**（numpy+scipy，零下载、零第三方权利） | 817 |
| `fetch-sfx.py` | 可选：按登记拉 CC0 真实素材，替换合成件（并生成素材出处清单） | 330 |
| `verify-sfx.mjs` | 音效**产物**校验 7 类（文件在不在 / 单声道冲突 / 循环配对 / 许可登记…） | 215 |
| `sfx-report.mjs` | 音效清单报告（逐条音效 / 环境床 / 出处许可三张表） | 186 |
| `bgm-cues.mjs` | 场景 → 配乐落点（**`SCENE_CUE` 出厂为空**） | 222 |
| `segments.mjs` | 按实际放映时长切「配乐段落」+ 时长模型 | 286 |
| `paths.mjs` | ★ **产物路径与文件名的唯一真源**（主线场景名改一处，四个脚本跟着动） | 61 |
| `build-demo.mjs` | 主线 → WebGAL 原生场景（章节卡 / 分支跳转 / 配乐落点 / `config.txt`） | 1017 |
| `demo-assets.mjs` | 占位背景与立绘（**纯 Node 手写 PNG**，零美术依赖） | 816 |
| `check-syntax.mjs` | 全仓语法体检（**JS + Python 双侧**，各带反向自测） | 243 |
| `screenplay.mjs` | **剧本规范体检器**：把 AVG 编剧规范变成可执行检查（7 类） | 473 |
| `md-html.mjs` | markdown → HTML 渲染（供可读版产物） | 224 |
| `test-screenplay.mjs` | 体检器测试（70 项） | 379 |
| `test-split.mjs` | 切分器测试（26 项） | 291 |

**合计 24 个脚本（21 `.mjs` + 3 `.py`）· 7721 行。**（另有 2 个 JSON 数据文件，不计入行数）
> ★ 这行数字**由 `node verify-repo.mjs` 的探测器 ⑤ 对着实测核**（口径 = 本目录下全部 `.mjs` + `.py`）。
> 改了代码就把这里一起改 —— 忘了的话它会报红，不会静默漂移。

> ★ **测试项数口径**：上面标的是**本仓库默认运行时实际执行**的项数。
> `test-split.mjs` 里有两段「全片回归」，断言的是「整部剧的每一框都不丢字」。
> 那两段只有对着真实全片才有意义 —— 本仓库不含剧本文本，
> 所以缺 `mainline/` 时**整段跳过**，而不是降级跑样本（那等于自欺）。

---

## 已知边界

- **需要你自己的剧本**才能跑完整条链。仓库不含剧本文本，也不含编译产物。
  缺产物时脚本给的是**三步恢复指引**，不是 ENOENT 堆栈。
- **`SCENE_CUE` 必须先填**（见上）。
- **产物依赖上游 WebGAL 的版本行为。** 换大版本请重跑根目录的
  `node verify-repo.mjs` 与产物体检。
- **剧情在编译期确定。** 本项目不提供「运行时让模型现写剧情」——
  理由与代价见 [`../docs/architecture.md`](../docs/architecture.md) §二。
