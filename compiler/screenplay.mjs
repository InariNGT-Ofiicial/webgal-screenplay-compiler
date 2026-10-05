/**
 * compiler / screenplay.mjs
 * ---------------------------------------------------------------------------
 * 剧本体检：把 AVG 编剧规范变成可执行检查。
 *
 * 为什么需要这个：
 *   引擎能校验指令的**合法性**（类型、字段、枚举），但校验不了**写得好不好**。
 *   而「对白太多旁白太多」「一个框塞太多字」「描述了立绘已有的表情」这类问题，
 *   LLM 几乎必然会犯，而且**不会自我察觉**——它没有「文本框装不下」这个感知。
 *
 *   所以必须由外部给它一把尺子。
 *
 * 规范来源见 vn-knowledge/AVG编剧与分镜.md。此处只实现可机械判定的部分，
 * 不可机械判定的（潜台词、人物一致性、节奏感）不进体检——宁可少报，
 * 也不要让体检器变成噪音源而被忽略。
 *
 * 本文件不含任何 import，可在 Node / Worker / <script type=module> 直接使用。
 */

import { TEXTBOX, TEXTBOX_SPEC } from './textbox.mjs';
export const CHECKER_VERSION = '1.0.0';

// ═══════════════════════════════════════════════════════════════════════════
//  §1 文本框规格
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 文本框的显示规格。
 *
 * 关键认知：**没有度量就没有规范**。写手无法遵守「一行 10 字」，
 * 除非引擎告诉他框是几行几列。所以这个对象必须是引擎对外暴露的一等信息，
 * 而不是藏在代码里的常量。
 */
export const DEFAULT_TEXTBOX = {
  cols: TEXTBOX.lines.medium,            // 2 行
  maxCharsPerLine: TEXTBOX.charsPerLine, // 35 全角字/行（真机实测，见 textbox.mjs）
  maxLinesTotal: TEXTBOX.lines.medium,   // 单个框最多 2 行
  /**
   * 触发「过长」告警的阈值。
   *
   * ★ 2026-10-03 改：之前是 `warnChars: 20 / hardChars: 32`，来源是
   *   「2 行 × 10 字」和「×1.6」—— 那个「10 字/行」**是我拍的，没有依据**。
   *   真机实测每行 35 全角字、2 行 ⇒ **物理上限 70 字**。
   *   现在：`warn = 切框上限 56`（我们的设计线），`hard = 70`（**超过必定丢字**）。
   *   详见 `compiler/textbox.mjs` 的测量记录。
   */
  warnChars: TEXTBOX_SPEC.warnChars,
  hardChars: TEXTBOX_SPEC.hardChars,
};

export function textboxSpec(overrides = {}) {
  return { ...DEFAULT_TEXTBOX, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════
//  §2 度量：数一句话的「视觉行数」
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 估算一段文本的视觉宽度（全角 = 1）。
 *
 * ★ 连续标点要当成**一个**字符算，否则折行会算错：
 *   「不安......」= 6 个 ASCII 句点，若逐个算 0.5 就是 3 个字符宽，
 *   折行时会把它们挤到下一行开头，误报 ORPHAN_PUNCT，
 *   也会把 10 字的短句算成 2-3 行。
 *   实际排版里「……」是当成一个字符的。
 */
export function visualWidth(text) {
  const s = String(text ?? '');
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.codePointAt(i);
    // 省略号：…… / ... / ―― 统一算 1
    if (ch === '…') {
      // 中文省略号「……」是**两个** U+2026，但排版上算一个字符（占一格）
      let n = 1;
      while (s[i + n] === '…') n++;
      w += 1;
      i += n - 1;
      continue;
    }
    if (ch === '.') {
      // 连续 ASCII 句点（... 或 ......）算 1
      let n = 1;
      while (s[i + n] === '.') n++;
      w += 1;
      i += n - 1;
      continue;
    }
    if (ch === '-' || ch === '—' || ch === '－') {
      // 连续破折号同理
      let n = 1;
      while (s[i + n] === '-' || s[i + n] === '—') n++;
      w += 1;
      i += n - 1;
      continue;
    }
    w += c <= 0x7f ? 0.5 : 1;
  }
  return w;
}

/** 可以悬挂到行尾的标点（不允许出现在行首的那些） */
const HANGABLE_PUNCT = new Set(['。', '，', '、', '；', '：', '！', '？', '…', '—', '」', '』', '）', '》']);

/**
 * 切分文本为行，返回 [start, end) 索引对。
 *
 * ★ 中文排版的**悬挂标点**规则：一个句号如果正好落在行末，
 *   允许它「挂」在行尾而不换行（专业排版的常规做法）。
 *   不处理这个，「抬头盯着大剧院的穹顶。」会被算成 2 行，
 *   连带把句号报成 ORPHAN_PUNCT —— 纯误报。
 */
function foldRows(text, perLine) {
  const chars = [...text];
  const rows = [];
  let rowStart = 0;
  let cur = 0;
  for (let i = 0; i < chars.length; i++) {
    const w = visualWidth(chars[i]);
    if (cur + w > perLine && cur > 0) {
      // 悬挂标点：当前字符本身是标点时，允许它挂在本行末尾而不换行
      if (HANGABLE_PUNCT.has(chars[i])) {
        rows.push([rowStart, i + 1]);
        rowStart = i + 1;
        cur = 0;
        continue;
      }
      rows.push([rowStart, i]);
      rowStart = i;
      cur = 0;
    }
    cur += w;
  }
  if (rowStart < chars.length) rows.push([rowStart, chars.length]);
  return { chars, rows };
}

/**
 * 估算一段文本会占几行（按 spec 的每行字数上限折算）。
 *
 * ★ 悬挂标点会让某一行宽度到 perLine+1，这是专业排版的正常现象，
 *   **不算超长**。所以行数判定用 ceil(width/perLine)，
 *   而「超长」判定单独用 > hardChars —— 两件事分开算，不互相牵连。
 */
export function estimateLines(text, spec = DEFAULT_TEXTBOX) {
  const s = String(text ?? '');
  const perLine = spec.maxCharsPerLine;
  const total = visualWidth(s);
  // 只有结尾真的有标点时，才把它算作可悬挂（否则那一格是实义字符，不能挂）
  const hasTailPunct = /[。，、；：！？…—」』）》]+$/u.test(s);
  const effective = hasTailPunct ? total - 0.5 : total;
  return Math.max(1, Math.ceil(effective / perLine));
}

// ═══════════════════════════════════════════════════════════════════════════
//  §3 冗余检测：描述了画面已有的东西
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 「她看起来很生气」这类句子——立绘已经换了愤怒表情，这句是废话。
 *
 * 检测思路：台词/旁白里出现对**外观**的描述词，且同拍有对应的表情指令。
 * 只在能确定「画面对应得上」时才报，避免误报。
 */
const APPEARANCE_VERBS = [
  '看起来', '看上去', '显得', '一脸', '神色', '表情',
];
const EMOTION_WORDS = [
  '生气', '愤怒', '开心', '高兴', '难过', '伤心', '害羞', '尴尬',
  '惊讶', '吃惊', '慌张', '紧张', '害怕', '担心', '兴奋', '失望',
  '冷漠', '平静', '认真', '温柔', '不满', '得意', '沮丧', '困惑',
];

/** 表情指令 → 可能对应的外观词（用于判断画面对不对得上） */
const EMOTION_TO_WORDS = {
  angry: ['生气', '愤怒', '不满', '恼'],
  smile: ['开心', '高兴', '笑'],
  shock: ['惊讶', '吃惊', '震惊'],
  awkward: ['尴尬', '害羞', '不自然'],
  sad: ['难过', '伤心', '失落'],
  neutral: ['平静', '冷漠', '淡然'],
};

function detectAppearanceRedundancy(text, emotion) {
  const s = String(text ?? '');
  if (!APPEARANCE_VERBS.some((v) => s.includes(v))) return null;
  if (!EMOTION_WORDS.some((w) => s.includes(w))) return null;
  // 如果同拍的立绘表情正好对应这些词，那就是确定冗余
  const words = EMOTION_TO_WORDS[emotion] || [];
  if (emotion && words.some((w) => s.includes(w))) {
    return 'EXPRESSION_REDUNDANT';
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  §4 排版病句：标点落在行首
// ═══════════════════════════════════════════════════════════════════════════

const LEADING_PUNCT = new Set(['。', '，', '、', '；', '：', '！', '？', '」', '』', '）', '…', '—']);

/**
 * 估算按 spec 折行后，是否会出现「标点在行首」的情况。
 *
 * 做法：先按视觉宽度把字符切进各行，同时记下每行的起始下标；
 * 再检查每行首个非空白字符是不是标点。
 */
export function detectOrphanPunctuation(text, spec = DEFAULT_TEXTBOX) {
  const { chars, rows } = foldRows(String(text ?? ''), spec.maxCharsPerLine);

  for (const [start, end] of rows) {
    for (let i = start; i < end; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') continue; // 跳过行首空白
      if (LEADING_PUNCT.has(ch)) {
        return { line: rows.findIndex((r) => r[0] === start) + 1, char: ch };
      }
      break; // 只看该行第一个非空白字符
    }
  }
  return null;
}
// ═══════════════════════════════════════════════════════════════════════════
//  §5 情绪化词检测（弱信号，只统计不告警）
// ═══════════════════════════════════════════════════════════════════════════

/** 说话人识别用的语气词密度——用来发现「所有角色说话腔调一样」 */
const STYLE_MARKERS = {
  敬语: ['です', 'ます', 'please', ' respectfully'],
  疑问: ['吗', '呢', '吧', '？', '?', '什么', '为什么', '怎么'],
  感叹: ['！', '!', '哇', '啊'],
  省略号: ['…', '...'],
};

function countStyleMarkers(text) {
  const s = String(text ?? '');
  const out = {};
  for (const [k, marks] of Object.entries(STYLE_MARKERS)) {
    out[k] = marks.filter((m) => m.trim() && s.includes(m)).length;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  §6 主检
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 对一拍指令做编剧规范体检。
 *
 * @param {Array}   directives  一拍指令
 * @param {object}  opts.spec    文本框规格
 * @param {boolean} opts.strict  是否把 warn 也当 error（CI 用）
 * @returns {{ok, metrics, issues, summary}}
 */
export function screenPlayCheck(directives, opts = {}) {
  const spec = opts.spec ? textboxSpec(opts.spec) : DEFAULT_TEXTBOX;
  const issues = [];
  const metrics = {
    dialogueCount: 0,
    narrationCount: 0,
    dialogueChars: 0,
    narrationChars: 0,
    terminalCount: 0,
    figureShows: 0,
    // 风格指纹：按说话人统计
    voices: {},
  };

  if (!Array.isArray(directives)) {
    return {
      ok: false,
      metrics,
      issues: [{ level: 'error', code: 'NOT_ARRAY', message: '指令不是数组' }],
      summary: '输入非法',
    };
  }

  // 记录本拍出现过的立绘及其表情，供冗余检测用
  const emotionByWho = new Map();
  for (const d of directives) {
    if (d?.t === 'show' && d.who) emotionByWho.set(String(d.who), String(d.emotion ?? 'neutral'));
  }

  directives.forEach((d, i) => {
    if (!d || typeof d.t !== 'string') return;
    const isDialogue = d.t === 'say';
    const isNarration = d.t === 'narrate';
    if (d.t === 'choice' || d.t === 'end') metrics.terminalCount++;
    if (d.t === 'show') metrics.figureShows++;

    const text = isDialogue ? d.text : isNarration ? d.text : null;
    if (text == null) return;

    const where = `${isDialogue ? `say#${i}(${d.who})` : `narrate#${i}`}`;

    if (isDialogue) {
      metrics.dialogueCount++;
      metrics.dialogueChars += visualWidth(text);
      const v = (metrics.voices[d.who] ||= { count: 0, chars: 0, markers: {} });
      v.count++;
      v.chars += visualWidth(text);
      for (const [k, n] of Object.entries(countStyleMarkers(text))) v.markers[k] = (v.markers[k] || 0) + n;
    } else {
      metrics.narrationCount++;
      metrics.narrationChars += visualWidth(text);
    }

    // ── 检查 1：单框字数 ──
    const w = visualWidth(text);
    if (w > spec.hardChars) {
      issues.push({
        level: 'error',
        code: 'TEXT_TOO_LONG',
        at: where,
        chars: w,
        limit: spec.hardChars,
        message: `文本 ${w} 字，超过单框硬上限 ${spec.hardChars}。请拆成多框——这不是限制，是节奏工具。`,
      });
    } else if (w > spec.warnChars) {
      issues.push({
        level: 'warn',
        code: 'TEXT_LONG',
        at: where,
        chars: w,
        limit: spec.warnChars,
        message: `文本 ${w} 字，超过建议上限 ${spec.warnChars}。考虑断成两句。`,
      });
    }

    // ── 检查 2：行数 ──
    const lines = estimateLines(text, spec);
    if (lines > spec.maxLinesTotal) {
      issues.push({
        level: 'warn',
        code: 'TOO_MANY_LINES',
        at: where,
        lines,
        limit: spec.maxLinesTotal,
        message: `折行后约 ${lines} 行（上限 ${spec.maxLinesTotal}）。玩家眼睛扫视成本会上升。`,
      });
    }

    // ── 检查 3：标点行首 ──
    const orphan = detectOrphanPunctuation(text, spec);
    if (orphan) {
      issues.push({
        level: 'warn',
        code: 'ORPHAN_PUNCT',
        at: where,
        line: orphan.line,
        char: orphan.char,
        message: `第 ${orphan.line} 行以「${orphan.char}」开头。改写以避免标点落在行首。`,
      });
    }

    // ── 检查 4：描述了立绘已有的表情 ──
    if (isNarration || isDialogue) {
      const emotion = d.who ? emotionByWho.get(String(d.who)) : [...emotionByWho.values()][0];
      const code = detectAppearanceRedundancy(text, emotion);
      if (code) {
        issues.push({
          level: 'warn',
          code,
          at: where,
          message: '文本在描述外观表情，而同拍已有对应表情的立绘指令。信任美术——文字要补画面画不出的东西。',
        });
      }
    }
  });

  // ── 检查 5：对白 / 旁白比例 ──
  //
  // 资料给的参考区间是 7:3 ~ 8:2（对白占七到八成），但那是**整部作品**的平均值。
  // 单拍会因内容而异：动作/场景描写多的镜头对白天然偏低。
  // 所以这里的下限放宽到 45%，只拦「明显失衡」——
  // 体检器一旦误报就会被忽略，宁可漏过也不能成噪音源。
  const totalChars = metrics.dialogueChars + metrics.narrationChars;
  if (totalChars > 30) {
    const ratio = metrics.dialogueChars / totalChars;
    if (ratio < 0.45) {
      issues.push({
        level: 'warn',
        code: 'NARRATION_HEAVY',
        ratio: Number(ratio.toFixed(2)),
        message: `对白仅占 ${(ratio * 100).toFixed(0)}%（单拍下限 45%，作品级参考 70%）。` +
          `考虑把部分旁白改成角色对话——让角色自己说出来。`,
      });
    } else if (ratio > 0.95) {
      issues.push({
        level: 'info',
        code: 'NO_NARRATION',
        ratio: Number(ratio.toFixed(2)),
        message: '本拍没有旁白。留意是否缺少必要的时/地/交代。',
      });
    }
  }

  // ── 检查 6：说话人腔调是否雷同（弱信号） ──
  const voices = Object.entries(metrics.voices);
  if (voices.length >= 2) {
    const fingerprints = voices.map(([who, v]) => {
      const total = Object.values(v.markers).reduce((a, b) => a + b, 0);
      // 标记密度 = 总标记数 / 台词数
      return { who, density: total / Math.max(1, v.count) };
    });
    const ds = fingerprints.map((f) => f.density);
    const spread = Math.max(...ds) - Math.min(...ds);
    if (spread < 0.15 && ds.length >= 2) {
      issues.push({
        level: 'info',
        code: 'SIMILAR_VOICES',
        detail: fingerprints,
        message: '不同角色的语气词密度几乎一致，读起来可能「谁都在说话」。给每个人一个专属的说话特征。',
      });
    }
  }

  // ── 检查 7：无终局指令 ──
  if (metrics.terminalCount === 0) {
    issues.push({
      level: 'info',
      code: 'NO_TERMINAL',
      message: '本拍没有终局指令（choice/ask/end），引擎将自动续演下一拍。',
    });
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warns = issues.filter((i) => i.level === 'warn').length;
  const infos = issues.filter((i) => i.level === 'info').length;

  return {
    ok: errors === 0 && (!opts.strict || warns === 0),
    metrics,
    issues,
    summary: `${metrics.dialogueCount} 句对白 / ${metrics.narrationCount} 段旁白，` +
      `对白占比 ${totalChars ? ((metrics.dialogueChars / totalChars) * 100).toFixed(0) : 0}%；` +
      `${errors} 错 / ${warns} 警 / ${infos} 提示`,
  };
}

/**
 * 把体检报告渲染成给 LLM 看的文字。
 * 体检的价值在于**能反馈给模型**，否则只是让人看的。
 */
export function renderReport(report) {
  if (!report.issues.length) return `剧本体检：${report.summary}（无问题）`;
  const lines = [`剧本体检：${report.summary}`, ''];
  const groups = { error: [], warn: [], info: [] };
  for (const i of report.issues) groups[i.level].push(i);
  for (const lv of ['error', 'warn', 'info']) {
    if (!groups[lv].length) continue;
    lines.push(`【${lv === 'error' ? '必须改' : lv === 'warn' ? '建议改' : '注意'}】`);
    for (const i of groups[lv]) {
      lines.push(`  · ${i.at ? i.at + ' ' : ''}${i.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 一行版摘要，适合塞进 LLM 提示词（token 敏感）。
 */
export function renderCompact(report) {
  const must = report.issues.filter((i) => i.level === 'error').length;
  const warn = report.issues.filter((i) => i.level === 'warn').length;
  if (!must && !warn) return '';
  const first = report.issues.find((i) => i.level === 'error') || report.issues.find((i) => i.level === 'warn');
  return `（剧本体检：${must} 错 ${warn} 警。首要问题：${first.message}）`;
}
