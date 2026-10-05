/**
 * textbox.mjs —— 文本框几何（**唯一真源**）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  为什么单独一个文件
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 有两处必须知道「一框能放多少字」：
 *   ① `text-split.mjs` —— 切框时的上限
 *   ② `screenplay.mjs` —— 体检时判「过长」
 * 常量写两份必然漂移（本项目已因「同一规则两处实现」炸过一次：分支锚点）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★★ 这些数字是**真机测出来的**，不是从 SCSS 推的（2026-10-03 作者指出）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 作者原话：「我怀疑你是不是不知道文本框可以调字号，完全塞得下大多数句子」。
 * 是的 —— 我之前按「单行 8–10 字 × 2 行 = 20 字」拍了个 `MAX_BOX = 20`，
 * 那个 8–10 字**没有任何依据**，实际容量是它的 3.5 倍。
 *
 * **第一版从 `src/` 的 SCSS 推算，全错** —— 产物实际用的主题是
 * `game/template/template.json` 里的 **"WebGAL Refine 2026"**，
 * 与源码里 legacy 的 `TextBox_main` 样式**根本不是一套**。
 * ⇒ 教训：**「源码怎么写」不等于「跑起来什么样」**，能用真机量就别读代码猜。
 *
 * 测量方式：无头 Chromium 进游戏 → 读文本框的 computed style / `clientWidth`。
 *
 * | 量 | 值 | 出处 |
 * |---|---|---|
 * | 画布 | **2560×1440** | `Core/util/constants.scss` 的 `$screenWidth/$screenHeight` |
 * | 舞台缩放 | `transform: scale()` | 1280 窗口 → `scale(0.5)`，1920 → `0.75`（实测） |
 * | ⇒ **容量与窗口尺寸无关** | | 缩放是按画布整体做的，字号与盒子同比 |
 * | 盒子内容区 | **2022 × 234 px** | `clientWidth/Height − padding`（实测） |
 * | 正文字号 | **52.48 px** | `#root` 25.6px（body 16 × 160%）× 205%（medium 档） |
 * | 字距 | **5.12 px** | `letter-spacing: 0.2em` |
 * | 行高 | **2.2 em = 115.5 px** | medium 档；small/large 为 2em |
 * | 实装行数 | **2** | 234 ÷ 115.5 = 2.03 —— **刚好 2 行**，这也解释了默认上限为什么是 2 |
 *
 * 字号三档（`UI/getTextSize.ts`）：`small 155% / medium 205% / large 230%`，
 * 且 `getTextLineLimit` 给 small **3 行**、medium/large 2 行。
 * `say` 指令支持逐行 `-fontSize=small|medium|large`；行数上限还可用
 * `config.txt` 的 `Max_line` 覆盖（填进 `globalGameVar`）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★★ 超上限的后果比「难看」严重得多
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Stage/TextBox/concatTextLines.ts` 最后一行是 `textArray.slice(0, lineLimit)` ——
 * **超出上限的文本不是被裁切，是根本不渲染（静默丢字）**。
 * 所以 `hardChars` 是**硬底线**，不是审美建议。
 */

/** 文本框几何（真机实测，见文件头） */
export const TEXTBOX = {
  canvas: { w: 2560, h: 1440 },
  /** 盒子内容区（px） */
  content: { w: 2022, h: 234 },
  font: {
    /** 基准字号：body 16px × #root 160% */
    rootPx: 25.6,
    /** 三档百分比（`UI/getTextSize.ts`） */
    sizePct: { small: 155, medium: 205, large: 230 },
    /** 字距 0.2em */
    letterSpacingEm: 0.2,
    /** 行高（em；small/large 为 2，medium 为 2.2） */
    lineHeightEm: { small: 2, medium: 2.2, large: 2 },
    /** medium 档的实际字号 px */
    mediumPx: 52.48,
  },
  /** 各档允许的**实装行数**（`hooks/useTextOptions.ts` 的默认值） */
  lines: { small: 3, medium: 2, large: 2 },
  /**
   * 每行能放多少个**全角**字。
   *
   * 理论值 = 2022 ÷（52.48 × 字宽比 + 5.12）。实测单字宽 ≈ 47px（≈0.896em）
   * ⇒ 2022 ÷ 52.12 ≈ **38.8**。这里取 **35**，留 ~10% 余量：
   * 字体回退、标点挤压、行末 `letter-spacing` 都会让实际字宽有浮动，
   * 而**超行数的代价是整段不渲染**，所以宁可保守。
   */
  charsPerLine: 35,
};

/** 两行能放的全角字数 = **物理上限**（超过它 WebGAL 直接丢字） */
export const CAPACITY = TEXTBOX.charsPerLine * TEXTBOX.lines.medium; // 70

/**
 * 切框上限：物理上限再留 20% 余量。
 *
 * 为什么留这么多：`charsPerLine = 35` 已经是保守值，但**行数**没有余地 ——
 * 内容高 234px、行高 115.5px，2 行 = 231px，只剩 3px。
 * 一旦某行的实际字宽比预期大一点，就会出现第 3 行 ⇒ 直接被丢掉。
 * 56 字 = 2 行 × 28 字，即使每行只放得下 28 字（比理论的 38 少 26%）也安全。
 *
 * 覆盖面（实测全片 5653 句）：**56 字 ⇒ 95% 的句子一框装下**，全篇 7706 → 3700 框。
 */
export const MAX_BOX = Math.floor(CAPACITY * 0.8); // 56

/** 单框字数下限：防孤字（切出一个 2 字的尾巴比留一个长框更难看） */
export const MIN_BOX = 6;

/** 体检用的 spec（`screenplay.mjs` 消费；口径与本文件一致） */
export const TEXTBOX_SPEC = {
  cols: TEXTBOX.lines.medium,
  maxCharsPerLine: TEXTBOX.charsPerLine,
  maxLinesTotal: TEXTBOX.lines.medium,
  /** 超过我们的设计上限 → 建议拆（warn） */
  warnChars: MAX_BOX,
  /** 超过物理上限 → **一定会丢字**（error） */
  hardChars: CAPACITY,
};

/** 全角字数上限 70 ⇒ 两行 35；给人工看的容量摘要 */
export function capacityLine() {
  const t = TEXTBOX;
  return `内容区 ${t.content.w}×${t.content.h}px · 每行 ${t.charsPerLine} 全角字 · 实装 ${t.lines.medium} 行 `
    + `⇒ 物理上限 ${CAPACITY} 字（切框上限取 ${MAX_BOX}）`;
}
