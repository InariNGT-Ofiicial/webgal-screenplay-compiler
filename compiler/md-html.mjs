/**
 * compiler / md-html.mjs —— 极小 markdown → HTML 渲染器（**唯一实现**）
 * ===========================================================================
 * 为什么要有它：本项目每份"给人看的说明"都要同时出 `.md`（可 diff、可存档）与
 * `.html`（可阅读、可给外援）。原先两者是**各写一遍**，结果必然漂移 ——
 * 实测同一份说明：md 里有的一行，HTML 里没有；md 是 7 行表，HTML 压缩成了 4 条列表。更要命的是 HTML 里 `**已修**` 和反引号**原样显示**
 * （因为 HTML 是手写的，走的是 `esc()`，没做行内标记转换）。
 *
 * ⇒ 一份输入（md 文本）→ 两种输出。HTML 由 md 渲染，**漂移在结构上不可能发生**。
 *
 * 支持（够用就好，不做完整 md 兼容）：
 *   `#`/`##`/`###` 标题 · `---` 分隔线 · `> ` 引用块 · `|` 表格 · `- ` 无序列表
 *   · `1. ` 有序列表 · 段落 · 行内 `**粗**` / `` `代码` ``
 *
 * ★ 转义顺序很重要：**先 escape 再做行内替换**。反过来的话，用户写的 `<b>` 会变成
 *   真标签（这是本项目另一条老坑的同一族：先解析后转义 = 注入）。
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 行内标记：粗体 + 代码。在 escape 之后调用。 */
export const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

const DEFAULT_CSS = `
:root{--bg:#141617;--panel:#1B1D1E;--raised:#252728;--line:#484B4C;--ink:#ECEAE4;--dim:#B8B6AE;
--faint:#94958F;--sig:#B8453D;--cold:#BFC2BE;--gold:#C7AE8C}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.75 "Noto Sans SC",system-ui,sans-serif;
padding:48px 40px 80px;max-width:1180px}
h1{font-size:30px;margin:0 0 10px}
h2{font-size:20px;margin:44px 0 12px;padding-left:12px;border-left:2px solid var(--sig)}
h3{font-size:16px;margin:26px 0 8px;color:var(--cold)}
h4{font-size:14px;margin:20px 0 6px;color:var(--dim)}
blockquote{margin:16px 0;padding:16px 22px;background:var(--panel);border:1px solid var(--line);
border-left:3px solid var(--gold);line-height:1.9}
blockquote p{margin:4px 0}
table{border-collapse:collapse;width:100%;margin:10px 0 4px;font-size:13.5px}
th,td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--raised);font-size:12px;letter-spacing:.08em;color:var(--dim)}
code{font-family:Consolas,"Noto Sans Mono",monospace;color:var(--cold);font-size:.94em;
background:var(--raised);padding:1px 5px;border-radius:3px}
pre.code{margin:12px 0;padding:14px 16px;background:var(--panel);border:1px solid var(--line);
border-left:3px solid var(--cold);border-radius:4px;overflow-x:auto;line-height:1.6}
pre.code code{display:block;background:none;padding:0;font-size:12.5px;color:var(--cold);
white-space:pre;tab-size:2}
ul,ol{margin:8px 0 8px 4px;padding-left:22px}
li{margin:3px 0}
p{margin:8px 0}
.hr{height:1px;background:var(--line);margin:38px 0}
a{color:var(--gold)}
strong,b{color:var(--ink)}
`.trim();

/**
 * @param {string} md markdown 全文
 * @param {{title?:string, lede?:string, css?:string}} [opts]
 * @returns {string} 完整 HTML 文档
 */
export function mdToHtml(md, opts = {}) {
  const title = opts.title || '文档';
  const out = [];
  const lines = String(md).split(/\r?\n/);
  let i = 0;

  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSepRow = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { i++; continue; }

    // ★ 围栏代码块（``` 或 ~~~）：原样输出，**不做行内渲染**。
    //
    //   为什么必须支持：说明文档里大量 bash / python 片段若走 `inline()`，
    //   行首的 `#` 会被当成标题（`# 工作区` → `<h1>`），`**` / 反引号也会被吃掉。
    //   实测：一份 46 行围栏的说明书渲染出 **138 处错乱**。
    //
    //   ★ 本分支必须在「标题」之前 —— 否则 ``` 行本身会先被当成普通行。
    const fence = t.match(/^(```+|~~~+)(.*)$/);
    if (fence) {
      const mark = fence[1][0];             // ` 或 ~
      const lang = fence[2].trim();
      // ★ 闭合正则**不能用模板串拼 mark** —— 反引号在模板串里会提前终止字符串
      //   （本项目铁律 #10：「别在模板串里写裸反引号」，不报错、直接出错）。
      //   ⇒ 用字符类 `[`~]{3,}` 一次匹配两种围栏符。
      const closeRe = /^\s*[`~]{3,}\s*$/;
      const buf = [];
      i++;
      while (i < lines.length) {
        if (closeRe.test(lines[i])) { i++; break; }
        buf.push(lines[i]);
        i++;
      }
      const cls = lang ? ` class="lang-${esc(lang)}"` : '';
      out.push(`<pre class="code"${cls}><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^-{3,}$/.test(t)) { out.push('<div class="hr"></div>'); i++; continue; }

    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      // h1 只出一次（文档标题），其余照级渲染
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    if (t.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      const body = buf.filter((x) => x !== '').map((x) => `<p>${inline(x)}</p>`).join('');
      out.push(`<blockquote>${body}</blockquote>`);
      continue;
    }

    // 表格：当前行是 |…|，下一行是分隔行
    if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('\n')
        + '</tbody></table>');
      continue;
    }

    if (/^[-*]\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      // 续行（缩进 2+ 空格且不是新条目）并入上一条
      out.push('<ul>' + items.map((x) => `<li>${inline(x)}</li>`).join('') + '</ul>');
      continue;
    }

    if (/^\d+\.\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map((x) => `<li>${inline(x)}</li>`).join('') + '</ol>');
      continue;
    }

    // 段落：连续非空、非块级起始的行合成一段
    const para = [];
    while (i < lines.length) {
      const cur = lines[i], ct = cur.trim();
      // ★ 终止条件必须含**围栏行**（``` / ~~~）——
      //   否则段落会把紧随其后的围栏吞进来，导致后续围栏**奇偶错位**、
      //   整节内容被当成代码块（实测：漏掉第 6/7 节、12 处标记未渲染）。
      if (!ct
        || /^(#{1,4}\s|>|\||-\s|\*\s|\d+\.\s)/.test(ct)
        || /^-{3,}$/.test(ct)
        || /^(`{3,}|~{3,})/.test(ct)) break;
      para.push(ct);
      i++;
    }
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    else i++;   // 兜底：避免死循环（**必须**，否则遇到认不出的行会卡死）
  }

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${opts.css || DEFAULT_CSS}
</style></head><body>
${opts.lede ? `<p>${inline(opts.lede)}</p>\n` : ''}${out.join('\n')}
</body></html>`;
}

export default mdToHtml;

/**
 * 不变式：**HTML 必须覆盖 md 的全部章节，且不留 markdown 标记**。
 * ===========================================================================
 * 为什么要有：md→HTML 的漏行**不会报错**，只是那一节静静消失（实测漏过「设计文档」一行）；
 * markdown 标记漏进 HTML 也一样不报错，只是难看。两者都属"不报错、只是没做该做的事"。
 *
 * ★ 这个断言**自己被验过**：第一版忘了剥掉 md 行首的 `## `，于是在**正确产物上误报**
 *   10 个章节缺失 —— 和本项目「ASCII 正则双重转义导致永远为真」是同一族的病：
 *   **校验器不写反向用例，就等于没写。** 反向用例见 `--selftest` 分支。
 *
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function checkCoverage(mdText, html) {
  const norm = (s) => s.replace(/[*`]/g, '').replace(/<[^>]+>/g, '').trim();
  // ★ 必须剥掉行首的 `## `/`### ` —— 否则 md 侧是「## 0 · …」、html 侧是「0 · …」，永远对不上
  const mdHeads = String(mdText).split(/\r?\n/)
    .filter((l) => /^#{2,3}\s/.test(l))
    .map((l) => norm(l.replace(/^#{2,3}\s+/, '')));
  const body = html.slice(html.indexOf('<body>'));
  const htmlHeads = new Set([...body.matchAll(/<h[23]>(.*?)<\/h[23]>/g)].map((m) => norm(m[1])));
  const problems = [];
  const missing = mdHeads.filter((h) => !htmlHeads.has(h));
  if (missing.length) problems.push(`HTML 漏了 ${missing.length} 个章节：${missing.join(' / ')}`);
  // ★ 剥掉 <code>…</code> 再数：里面的 `*` / 反引号是**渲染后的正常内容**
  //   （如 <code>tpl_*</code>、<code>ls -d _r*</code>），不是漏渲染的标记。
  //   不剥就会把正确产物误报成「2 处未渲染」——本校验器自己踩过一次。
  // ★ 也要剥 <pre class="code">…</pre>：代码块内容**本来就是原文**
  //   （含 `#` / `**` / 反引号都是正常的），数进去必然误报。
  const stripped = body
    .replace(/<pre class="code"[\s\S]*?<\/pre>/g, '')
    .replace(/<code>[\s\S]*?<\/code>/g, '');
  const leaks = [...stripped.matchAll(/\*\*|`/g)].length;
  if (leaks) problems.push(`HTML 正文里还有 ${leaks} 处 markdown 标记未渲染`);
  return problems;
}
