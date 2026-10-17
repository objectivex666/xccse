import { DatabaseSync } from "node:sqlite";
import { buildMatchExpr, buildPinyinExpr } from "./tokenize.mjs";
import { DB_FILE } from "./indexer.mjs";

/** 与 works_fts 的列一一对应：work_id, t_bi, t_ch, t_w, b_bi, b_ch, b_w */
const FTS_WEIGHTS = "0, 14.0, 3.0, 10.0, 3.0, 0.5, 1.5";
const SCAN_CAP = 800;

let cached = null;
export function openDb(file = DB_FILE) {
  if (cached && cached.file === file) return cached.db;
  const db = new DatabaseSync(file);
  cached = { file, db };
  return db;
}

/** 相关性 = BM25 词法得分 + 轻量热度加成，避免搜索结果全是无人问津的条目。 */
function popularityBoost(row) {
  return 0.30 * Math.log1p(row.views) + 0.55 * Math.log1p(row.likes) + 0.20 * Math.log1p(row.favorites);
}

function selectRows(db, table, expr, filterSql, filterParams) {
  const score = table === "works_py" ? "bm25(works_py, 0, 2.0, 1.0)" : `bm25(works_fts, ${FTS_WEIGHTS})`;
  const sql = `
    SELECT w.*, ${score} AS bm
    FROM ${table}
    JOIN works w ON w.id = ${table}.work_id
    WHERE ${table} MATCH ?${filterSql}
    ORDER BY bm
    LIMIT ${SCAN_CAP}`;
  return db.prepare(sql).all(expr, ...filterParams);
}

function collect(db, expr, { table = "works_fts", lang, author, matchedBy }) {
  const filters = [];
  const params = [];
  if (lang) {
    filters.push("w.lang = ?");
    params.push(lang);
  }
  if (author) {
    filters.push("w.user_id = ?");
    params.push(Number(author));
  }
  const filterSql = filters.length ? ` AND ${filters.join(" AND ")}` : "";

  let rows;
  try {
    rows = selectRows(db, table, expr, filterSql, params);
  } catch {
    return [];
  }
  return rows.map((row) => ({
    ...row,
    matched_by: matchedBy,
    score: -row.bm + popularityBoost(row),
  }));
}

function browse(db, { lang, author, sort, limit, offset, page }) {
  const filters = [];
  const params = [];
  if (lang) {
    filters.push("lang = ?");
    params.push(lang);
  }
  if (author) {
    filters.push("user_id = ?");
    params.push(Number(author));
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const orderBy = {
    views: "views DESC",
    likes: "likes DESC",
    newest: "published_at DESC",
  }[sort] ?? "views DESC";

  const total = db.prepare(`SELECT COUNT(*) AS c FROM works ${where}`).get(...params).c;
  const rows = db
    .prepare(`SELECT * FROM works ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, rows: rows.map((r) => ({ ...r, matched_by: "browse", score: 0 })), page };
}

/**
 * 检索入口。
 * 中文查询走 bigram 短语（真实子串语义）；纯拼音查询在主检索无果时回退到 trigram 拼音表。
 */
export function search(db, options = {}) {
  const q = String(options.q ?? "").trim();
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(options.limit) || 20));
  const offset = (page - 1) * limit;
  const sort = options.sort || "relevance";
  const started = performance.now();

  if (!q) {
    const result = browse(db, { lang: options.lang, author: options.author, sort, limit, offset, page });
    return { ...result, query: q, mode: "browse", tookMs: Math.round(performance.now() - started) };
  }

  const { expr } = buildMatchExpr(q);
  let rows = expr ? collect(db, expr, { lang: options.lang, author: options.author, matchedBy: "keyword" }) : [];
  let mode = "keyword";

  if (rows.length < 5) {
    const pinyinExpr = buildPinyinExpr(q);
    if (pinyinExpr) {
      const pyRows = collect(db, pinyinExpr, {
        table: "works_py",
        lang: options.lang,
        author: options.author,
        matchedBy: "pinyin",
      });
      if (pyRows.length) {
        const seen = new Set(rows.map((r) => r.id));
        rows = rows.concat(pyRows.filter((r) => !seen.has(r.id)));
        mode = rows.length > pyRows.length ? "mixed" : "pinyin";
      }
    }
  }

  if (sort === "relevance") {
    rows.sort((a, b) => b.score - a.score || b.views - a.views || a.id - b.id);
  } else {
    const key = { views: "views", likes: "likes", newest: "published_at" }[sort] ?? "views";
    rows.sort((a, b) => (key === "published_at" ? String(b[key]).localeCompare(String(a[key])) : b[key] - a[key]));
    mode = `${mode}+sorted`;
  }

  return {
    query: q,
    mode,
    total: rows.length,
    page,
    limit,
    rows: rows.slice(offset, offset + limit),
    tookMs: Math.round(performance.now() - started),
  };
}

export function stats(db) {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS works, COUNT(DISTINCT user_id) AS authors,
              COALESCE(SUM(views),0) AS views, COALESCE(SUM(likes),0) AS likes
       FROM works`,
    )
    .get();
  const langs = db
    .prepare(`SELECT lang, COUNT(*) AS count FROM works WHERE lang <> '' GROUP BY lang ORDER BY count DESC`)
    .all();
  return { ...totals, langs };
}

export function facets(db) {
  const langs = db
    .prepare(
      `SELECT lang, COUNT(*) AS count FROM works WHERE lang <> '' GROUP BY lang ORDER BY count DESC`,
    )
    .all();
  const authors = db
    .prepare(
      `SELECT w.user_id AS user_id, COALESCE(NULLIF(w.username,''), '匿名') AS name,
              COUNT(*) AS count, COALESCE(SUM(w.views),0) AS views
       FROM works w GROUP BY w.user_id ORDER BY views DESC LIMIT 60`,
    )
    .all();
  const tags = db
    .prepare(`SELECT tags FROM works WHERE tags <> ''`)
    .all()
    .flatMap((r) => r.tags.split(/[,，、|]/).map((t) => t.trim()).filter(Boolean))
    .reduce((acc, tag) => acc.set(tag, (acc.get(tag) ?? 0) + 1), new Map());
  return {
    langs,
    authors,
    tags: [...tags.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
  };
}

export function suggest(db, prefix, limit = 8) {
  const q = String(prefix ?? "").trim();
  if (!q) return [];
  return db
    .prepare(`SELECT id, name FROM works WHERE name LIKE ? ORDER BY views DESC LIMIT ?`)
    .all(`%${q}%`, limit);
}

export function getWork(db, id) {
  return db.prepare(`SELECT * FROM works WHERE id = ?`).get(Number(id)) ?? null;
}
