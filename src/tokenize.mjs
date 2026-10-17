import { pinyin } from "pinyin-pro";

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 只保留 FTS5 裸词元安全的字符，这样前缀查询 pyth* 不会踩到语法错误 */
const WORD_RE = /[a-z0-9_]/;

const ALIASES = [
  [/c\+\+/g, "cpp"],
  [/c#/g, "csharp"],
  [/\bpy\b/g, "python"],
  [/\bcplusplus\b/g, "cpp"],
];

/** NFKC 归一化 + 小写；同时展开常见语言别名。 */
export function normalize(input) {
  let text = String(input ?? "").normalize("NFKC").toLowerCase();
  for (const [re, to] of ALIASES) text = text.replace(re, to);
  return text;
}

/** 把文本切成 cjk / word / sep 三类连续片段。 */
export function splitRuns(text) {
  const runs = [];
  for (const ch of text) {
    const type = CJK_RE.test(ch) ? "cjk" : WORD_RE.test(ch) ? "word" : "sep";
    const last = runs[runs.length - 1];
    if (last && last.type === type) last.text += ch;
    else runs.push({ type, text: ch });
  }
  return runs;
}

function pinyinOf(text, pattern) {
  try {
    return pinyin(text, pattern ? { toneType: "none", pattern, type: "array" } : { toneType: "none", type: "array" });
  } catch {
    return [...text];
  }
}

/**
 * 分析一段文本，产出用于 FTS5 的词元。
 *
 * 中文用「相邻二元组 + 单字」双通道：二元组用于短语精确匹配（"赛车" 命中 "会飞的赛车游戏"），
 * 单字用于兜底单字查询。英文/数字按整词索引，支持前缀匹配。
 */
export function analyze(input) {
  const text = normalize(input);
  const cjkBigrams = [];
  const cjkChars = [];
  const words = [];
  const syllables = [];
  const initials = [];

  for (const run of splitRuns(text)) {
    if (run.type === "cjk") {
      const chars = [...run.text];
      cjkChars.push(...chars);
      for (let i = 0; i + 1 < chars.length; i += 1) cjkBigrams.push(chars[i] + chars[i + 1]);
      syllables.push(...pinyinOf(run.text));
      initials.push(...pinyinOf(run.text, "first"));
    } else if (run.type === "word") {
      words.push(run.text);
    }
  }

  return {
    cjkBigrams,
    cjkChars,
    words,
    syllables,
    initials,
    /** 连续拼音串，如 feixiangdesaiche，用于 trigram 子串检索 */
    pinyinConcat: syllables.join(""),
    initialConcat: initials.join(""),
  };
}

function quotePhrase(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * 把用户查询编译成 FTS5 MATCH 表达式。
 * 中文片段编译为 bigram 短语（要求词元连续 = 真实子串语义），英文片段编译为前缀词。
 */
export function buildMatchExpr(rawQuery) {
  const normalized = normalize(rawQuery);
  const runs = splitRuns(normalized);
  const clauses = [];

  for (const run of runs) {
    if (run.type === "cjk") {
      const chars = [...run.text];
      if (chars.length >= 2) {
        const bigrams = [];
        for (let i = 0; i + 1 < chars.length; i += 1) bigrams.push(chars[i] + chars[i + 1]);
        const phrase = quotePhrase(bigrams.join(" "));
        clauses.push(`(t_bi : ${phrase} OR b_bi : ${phrase})`);
      } else {
        const single = quotePhrase(chars[0]);
        clauses.push(`(t_ch : ${single} OR b_ch : ${single})`);
      }
    } else if (run.type === "word") {
      // FTS5 的前缀语法要求词元裸写（"pyth*" 是无效的），词元已限定为 [a-z0-9_]，可安全拼接
      clauses.push(`(t_w : ${run.text}* OR b_w : ${run.text}*)`);
    }
  }

  return { expr: clauses.length ? clauses.join(" AND ") : null };
}

/** 纯字母查询时尝试的拼音表达式；trigram 需要 >= 3 个字符。 */
export function buildPinyinExpr(rawQuery) {
  const text = normalize(rawQuery).trim();
  if (!/^[a-z]+$/.test(text) || text.length < 3) return null;
  const phrase = quotePhrase(text);
  return `(py : ${phrase} OR init : ${phrase})`;
}
