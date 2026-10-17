import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { analyze } from "./tokenize.mjs";
import { DATA_DIR, WORKS_FILE, USERS_FILE, mergeWork, readJsonl } from "./crawl.mjs";
import { SCAN_WORKS_FILE } from "./scan.mjs";

export const DB_FILE = path.join(DATA_DIR, "xccse.db");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

DROP TABLE IF EXISTS works;
DROP TABLE IF EXISTS authors;
DROP TABLE IF EXISTS works_fts;
DROP TABLE IF EXISTS works_py;

CREATE TABLE works (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  lang               TEXT NOT NULL DEFAULT '',
  version            TEXT NOT NULL DEFAULT '',
  category           INTEGER NOT NULL DEFAULT 0,
  tags               TEXT NOT NULL DEFAULT '',
  user_id            INTEGER,
  username           TEXT NOT NULL DEFAULT '',
  user_avatar        TEXT NOT NULL DEFAULT '',
  thumbnail          TEXT NOT NULL DEFAULT '',
  views              INTEGER NOT NULL DEFAULT 0,
  likes              INTEGER NOT NULL DEFAULT 0,
  comments           INTEGER NOT NULL DEFAULT 0,
  favorites          INTEGER NOT NULL DEFAULT 0,
  source_code_views  INTEGER NOT NULL DEFAULT 0,
  published_at       TEXT NOT NULL DEFAULT '',
  updated_at         TEXT NOT NULL DEFAULT '',
  url                TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_works_lang  ON works(lang);
CREATE INDEX idx_works_user  ON works(user_id);
CREATE INDEX idx_works_views ON works(views DESC);
CREATE INDEX idx_works_likes ON works(likes DESC);
CREATE INDEX idx_works_pub   ON works(published_at DESC);

CREATE TABLE authors (
  user_id   INTEGER PRIMARY KEY,
  username  TEXT NOT NULL DEFAULT '',
  avatar    TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  fans      INTEGER NOT NULL DEFAULT 0,
  follows   INTEGER NOT NULL DEFAULT 0,
  works     INTEGER NOT NULL DEFAULT 0
);

-- 中文二元组 + 单字 + 英文词；标题列权重远高于正文列
CREATE VIRTUAL TABLE works_fts USING fts5(
  work_id UNINDEXED,
  t_bi, t_ch, t_w,
  b_bi, b_ch, b_w,
  tokenize = 'unicode61'
);

-- 拼音 trigram：支持 "saiche" / "fxds" 这类模糊音检索
CREATE VIRTUAL TABLE works_py USING fts5(
  work_id UNINDEXED,
  py,
  init,
  tokenize = 'trigram'
);
`;

function bodyText(work) {
  return [work.description, work.username, work.lang, work.tags].filter(Boolean).join(" \n ");
}

export function buildIndex({
  worksFile = WORKS_FILE,
  usersFile = USERS_FILE,
  scanWorksFile = SCAN_WORKS_FILE,
  dbFile = DB_FILE,
  log = (m) => console.error(m),
} = {}) {
  // 主数据 + ID 扫描得到的公开作品，按 id 合并
  const byId = new Map();
  for (const work of readJsonl(worksFile)) byId.set(work.id, work);
  if (scanWorksFile) {
    for (const work of readJsonl(scanWorksFile)) {
      byId.set(work.id, mergeWork(byId.get(work.id) ?? {}, work));
    }
  }
  const works = [...byId.values()].sort((a, b) => a.id - b.id);
  const authors = readJsonl(usersFile);
  if (!works.length) throw new Error(`没有可索引的数据，请先运行 crawl（${worksFile}）`);

  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = dbFile + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }

  const db = new DatabaseSync(dbFile);
  db.exec(SCHEMA);

  const insertWork = db.prepare(`INSERT INTO works (
    id, name, description, lang, version, category, tags, user_id, username, user_avatar,
    thumbnail, views, likes, comments, favorites, source_code_views, published_at, updated_at, url
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const insertFts = db.prepare(
    `INSERT INTO works_fts (work_id, t_bi, t_ch, t_w, b_bi, b_ch, b_w) VALUES (?,?,?,?,?,?,?)`,
  );
  const insertPy = db.prepare(`INSERT INTO works_py (work_id, py, init) VALUES (?,?,?)`);

  db.exec("BEGIN");
  for (const work of works) {
    insertWork.run(
      work.id,
      work.name || "",
      work.description || "",
      work.lang || "",
      work.version || "",
      work.category || 0,
      work.tags || "",
      work.user_id ?? null,
      work.username || "",
      work.user_avatar || "",
      work.thumbnail || "",
      work.views || 0,
      work.likes || 0,
      work.comments || 0,
      work.favorites || 0,
      work.source_code_views || 0,
      work.published_at || "",
      work.updated_at || "",
      work.url || "",
    );

    const title = analyze(work.name || "");
    const body = analyze(bodyText(work));
    insertFts.run(
      work.id,
      title.cjkBigrams.join(" "),
      title.cjkChars.join(" "),
      title.words.join(" "),
      body.cjkBigrams.join(" "),
      body.cjkChars.join(" "),
      body.words.join(" "),
    );
    insertPy.run(work.id, title.pinyinConcat, title.initialConcat);
  }

  const insertAuthor = db.prepare(
    `INSERT OR REPLACE INTO authors (user_id, username, avatar, signature, fans, follows, works) VALUES (?,?,?,?,?,?,?)`,
  );
  const workCount = db.prepare("SELECT COUNT(*) AS c FROM works WHERE user_id = ?");
  for (const author of authors) {
    insertAuthor.run(
      author.user_id,
      author.username || "",
      author.avatar || "",
      author.signature || "",
      author.fans || 0,
      author.follows || 0,
      workCount.get(author.user_id)?.c ?? 0,
    );
  }
  db.exec("COMMIT");

  db.exec("INSERT INTO works_fts(works_fts) VALUES('optimize')");
  db.exec("INSERT INTO works_py(works_py) VALUES('optimize')");
  db.exec("ANALYZE");
  db.close();

  const size = fs.statSync(dbFile).size;
  log(`索引完成：${works.length} 个作品，${authors.length} 位作者，${(size / 1024 / 1024).toFixed(2)} MB`);
  log(`  ${dbFile}`);
  return { works: works.length, authors: authors.length, bytes: size };
}
