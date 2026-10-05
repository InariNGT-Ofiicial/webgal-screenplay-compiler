/**
 * anchor.mjs —— 分支点锚点的**唯一**解析实现
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  为什么单独一个文件（2026-10-03 切的）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  锚点匹配原先在**两处**各写了一遍：`build-demo.mjs`（编译期校验）
 *  与一个独立的测试脚本（测试期再验一遍；该脚本未随仓提供）。两处都是 `b.text === bp.anchor`
 *  —— **逐框精确相等**。
 *
 *  于是修了切分器的孤字问题、框边界一变，两边同时炸：
 *  `BP1 锚点命中 0 处`。而锚点的本意是「**这一刻的剧情位置**」，与排版无关。
 *
 *  ⇒ 抽到一处，并按**内容**匹配：
 *     把全部框拼成一条字符串 → 按子串找锚点 → 再定位到它所属的框。
 *  同族教训见 AGENTS.md：「下标对齐很脆 ⇒ 用内容对齐」。锚点本来就是内容，
 *  只是之前被匹配在了错误的粒度（框）上。
 */

/** 给全部框建全文索引 */
export function indexBeats(beats) {
  const full = beats.map((b) => b.text || '').join('');
  const starts = [];
  let acc = 0;
  for (const b of beats) { starts.push(acc); acc += (b.text || '').length; }
  /** 全局字符偏移 → 落在第几个框（二分） */
  const boxAt = (offset) => {
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };
  return { full, starts, boxAt };
}

/**
 * 解析一个锚点 → 命中的框下标数组（调用方自己要求"必须恰好 1 个"）。
 *
 * 取「锚点**最后一个字**所在的框」：分支点要插在锚点文本**演完之后**。
 * 锚点若跨越了框边界，这样会自动落到最后一个框上 ——
 * 与老实现语义一致（老实现里锚点恰好等于一框，首尾同框）。
 */
export function resolveAnchor(index, anchor) {
  const boxes = new Set();
  let p = -1;
  while ((p = index.full.indexOf(anchor, p + 1)) >= 0) {
    boxes.add(index.boxAt(p + anchor.length - 1));
  }
  return [...boxes].sort((a, b) => a - b);
}
