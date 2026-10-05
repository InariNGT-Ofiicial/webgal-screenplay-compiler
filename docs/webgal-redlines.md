# WebGAL 操作红线

> 每一条都是**实测踩出来的**，读文档读不出来。
> 版本基准：**WebGAL 4.6.5**。

---

## 3.1 必须走 http，不能双击 `index.html`

WebGAL 引擎是 `<script type="module">` 且要 `fetch` 场景文件，
`file://` 下两者都被 CORS 拦掉 —— **页面只剩黑底**。

这不是 bug，是 WebGAL 的设计。用**任意**静态服务器起一个 http 服务即可
（`python -m http.server`、`npx serve webgal-tool/dist` 都行）。

---

## 3.2 语言选择页不在 Redux 里

`Translation` 组件由 `useState` + `localStorage.getItem('lang')` 控制，
`set-component-visibility` 协议**管不到它**。

不预置 `localStorage.lang` 就会一直停在「LANGUAGE SELECT」——
**而此时状态层其实已经演完了，极易误判成注入失败**。

解法是在 `index.html` 的 `<head>` 里注入一段同步脚本预置它 ——
**这是唯一设得进去的地方**，别指望用脚本指令或状态接口把它翻过去。

---

## 3.3 `choose` 不记录玩家选了什么

它只 `jump` 到目标 label，**不写任何变量**。
必须在每个选项 label 处自己 `setVar` 回写，
且**分支末尾必须 `jumpLabel` 跳到汇合点**——WebGAL 是线性执行，不跳会贯穿到下一个分支。

---

## 3.4 自由立绘与固定位是两套机制

- 上场：`changeFigure:xxx.webp -left -id=lin`（`-id` 走自由立绘，不占 3 个固定位）
- 退场：**`changeFigure: -id=lin;`**（content 留空，**不是** `none`）
- **全员退场要逐个带 `-id` 清**：`changeFigure:;` 只清 center 固定位

---

## 3.5 `config.txt` 的两个约束

- **`Game_key` 必须随 `Game_name` 一起改**（它是存档标识，不换会读到旧存档）
- **不要写 `Game_Logo:;`**：`useConfigData` 会 `split('|')` 再拼路径，
  空值会去请求 `./game/background/` —— 一个必然 404 的目录。整行省掉即可。

---

## 3.6 ★ WebGAL 内置「编辑器实时预览协议」，但它不是给玩家用的

上游发行版里就带着这套协议（子协议名 `webgal-editor-preview-sync.v1`，
运行时实现在引擎的 `previewSyncRuntime.ts`）——**不用 fork 任何一行代码**，
只要扮演那个「编辑器」的角色，就能把一段脚本文本推上舞台：

- `preview.command.run-scene-content` —— 把**任意脚本文本**直接解析成当前场景，
  **不要求落盘成文件**。它的实现就是三行：
  ```ts
  resetStage(true);
  WebGAL.sceneManager.sceneData.currentScene = sceneParser(payload.sceneContent, 'temp', './temp.txt');
  setTimeout(() => continueSentence(), 100);
  ```
- `preview.command.set-component-visibility` / `set-effect` / `set-text-read-mode`
  —— 组件可见性与演出开关

**第一个坑：注册方向是「引擎 → 编辑器」，不是反过来。**
引擎连上 WebSocket 后会**主动发**注册请求，你只需要**回 response**。
写反了**不会报协议错**，引擎只回一句「收到未支持的请求」，然后永远进不了已注册态。
（源码依据：`previewSyncRuntime.ts` 的 `registerPreview()`）

**代价是机制决定的，别当 bug 修：** `run-scene-content` 内部会 `resetStage(true)`，
所以每一拍都是一个**全新场景**——前一拍的背景与立绘会被清掉。想用它做连续叙事，
必须自己在外部维护一份「舞台记忆」（记住已下达的 `bg` / `show` / `hide`，每拍先重放再追加）；
即便如此，引擎 `PerformList` 仍会出现重复项，**跨拍回滚做不到**。

⇒ 结论：**技术上跑得通，但它产出的是「预览」，不是「游戏」**——
进不了存档 / 回廊 / 鉴赏 / 流程图，运行时又完全依赖你自己那层代码的稳定性。
**本项目探索过这条路，最终没有采用**（交付形态是编译期落盘的原生场景文件）。
记在这里，是因为它是 WebGAL 上一个真实存在、但很容易踩空的扩展点。

---

## 3.7 ★ 角色语音是 WebGAL **原生**能力

查源码确认：`packages/parser/src/interface/assets.ts` 的 `fileType` 枚举里有 **`vocal`**。

```webgal
say:台词 -speaker=角色 -figureId=角色 -vocal=00_01_角色.wav;
```

- 资源落 **`game/vocal/`**
- 引擎 `playVocal()` **阻塞到语音播完**，并按 **`-figureId` 做口型同步**
  （WebAudio Analyser 实时驱动嘴型）
- 有独立音量通道（设置项 `vocalVolume`），与 BGM 分开

**三条由此推出的红线：**

1. ✅ 语音必须**与台词同处一条 `say`**。拆成独立指令（`playEffect` 等）
   会**丢掉口型同步**，且时序要靠猜。
2. ✅ **`-figureId` 恒挂**，即使这句没配音——挂上没有副作用，
   缺了它口型没地方挂，将来补配音时不用回头改剧本。
3. ❌ **别拿 `playEffect` 当语音通道**：它没有 `figureId` 概念、不做口型。

**语音文件名必须带「哪一拍的哪一句」**（`00_01_saya.wav`）。
只用角色 id 会被后生成的**覆盖** ⇒ 所有台词变成最后一句的声音，
而表现是「配音听着全是同一句」，极难联想到文件覆盖。

⇒ **语音资源请自备**（本仓库不含任何音频），按上述命名规则放进 `game/vocal/` 即可。

---

## 3.8 ★ 分支结构：`jumpLabel` 找不到目标时**不报错**（静默贯穿）

`jumpToLabel` 扫不到目标就返回 `false`，而 `jumpLabel` 的 perform 是 `createNonePerform()`
—— **不抛异常、不打日志，执行继续往下走**。

后果是：**玩家在「正确路线」上突然看到别人的 END。**

⇒ 三条硬纪律：

1. **END / 分支区块放在文件末尾**，主线末尾用 `jumpLabel:_vn_main_end;` 显式跳过
   （WebGAL 是线性执行，`label` 是 no-op，夹在中间必被贯穿）
2. **编译期静态校验**：所有 `jumpLabel` / `choose` 的目标，必须在同一文件里有
   **唯一**的 `label:`（重复也算错——`jumpToLabel` 取**最后一个**匹配，语义歧义）
3. **别让「正确选项」的目标紧邻另一个 label**，它后面必须紧跟真实内容

同族教训在本项目已出现三次：切分器的 `tail` 逻辑写成 no-op、入口守卫保留旧指向、
以及这条。**共同特征都是「不报错、只是不做该做的事」——最贵的一类 bug。**

---

## 3.9 ★ 无头验证 WebGAL 时，两个选择器必须这么写

实测定下来：

| 目标 | 正确写法 | 错的写法（会静默返回空） |
|---|---|---|
| 正文 | `[class*="TextBox_Container"]` | `#text-box`（**不存在**）· `TextBox_textElement`（取不到） |
| 选项 | `#chooseContainer` 下**无子元素的 div** | `[class*="Choose_item"]`（**是另一套构建的类名，游戏内 choose 不用它**） |

- **`#chooseContainer` 是稳定的**（写在 JSX 里的 `id`，不是 hash 类名）；
  游戏内的选项元素用的是 **emotion 生成的类名**，
  `dist/assets/*.css` 里那些 `Choose_item_*` 是另一套组件留下的，**选了必空**。
- **正文是逐字 3 层渲染**：`innerText` 读出来是「尖\n尖\n尖\n刀\n刀\n刀…」。
  必须**去空白 + 折叠连续重复字符**才能得到整句；比对的两侧要用**同一个归一化**。

⇒ 教训同 3.8：**验证脚本自己报「空」，先怀疑选择器，别急着怀疑引擎。**
脚本的假阴性会训练人去忽略它的输出。

---

## 3.10 ★ 无头验证音频/交互时，点击必须是**真实鼠标事件**

`page.evaluate(() => el.click())` —— JS 里调 `HTMLElement.click()`
**不产生 user activation**，Chrome 的自动播放策略因此不放行音频。

症状很有欺骗性：`<audio>` 元素在、`src` 完全正确、`duration` 也解出来了，
但 **`paused` 一直是 true / `currentTime` 一直为 0** ——
看起来像「配乐没接上」，实际是验证脚本没制造用户手势。

⇒ 一律用 `page.locator(sel).click()` 或取 `boundingBox()` 后 `page.mouse.click(x, y)`。

---

## 3.11 ★ 文本进脚本前必须转义 6 个特殊字符

WebGAL 的脚本层里，这 6 个字符**有语法含义**。它们出现在台词或路径里时，
必须**反斜杠前置**转义，否则会被当成语法：

- `\` —— 转义符本身，必须**第一个**处理，否则二次转义（`\;` 先被加成 `\\;`）
- `;` —— 之后整段被当成**注释** ⇒ 台词看着「少了一半」
- `:` —— 被当成**字段分隔符** ⇒ 后半句变成指令参数
- `|` —— 被当成**选项分隔符** ⇒ 台词里解析出多余分支
- `{` `}` —— 被当成**变量插值** ⇒ `{name}` 会被求值，求不到就变成空

判据来自引擎源码本身：它用的是**负向后顾**，即**只看前一个字符是不是 `\`**——
`choose` 里是 `split(/(?<!\\)\|/)`，脚本执行器里是 `/(?<!\\)\{(.*?)\}/`。
⇒ 转义只有「反斜杠前置」这一个约定，两边必须一致；写多一层或少一层都会**静默**改变语义。

> **唯一的实现是 `compiler/build-demo.mjs` 里的那个转义函数，不要另写一份。**
> 两份转义表漂移起来的症状是「某几句台词莫名被截断」，
> 而这个症状**不会指向转义层**——你会先去查切分、查编码、查素材。

---

## 3.12 `changeBg` 只接受图片，不吃颜色

`changeBg` 的参数会被当成**资源路径**。传 `#101018` 这类颜色值**不会报错**，
只会找不到图 ⇒ **画面静默空白**（同 §3.8、§3.9 那一族：不报错，只是不做该做的事）。

要纯色底，只能自己生成一张纯色 PNG 走图片通道 ——
`compiler/demo-assets.mjs` 就是**纯 Node 手写 PNG**（自己编码 zlib + CRC），
不依赖任何图形库，2 秒出全套占位图。
