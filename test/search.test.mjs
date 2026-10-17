import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/indexer.mjs";
import { openDb, search, facets, stats, suggest } from "../src/search.mjs";

const FIXTURE_WORKS = [
  {
    id: 1, name: "飞翔的赛车", description: "左右键控制的小车，空格行驶", lang: "scratch",
    version: "3.0", category: 1, tags: "游戏", user_id: 100, username: "小明",
    thumbnail: "https://example.com/1.png", views: 103302, likes: 6444, comments: 69, favorites: 30,
    source_code_views: 13344, published_at: "2020-02-07 13:56:25", updated_at: "2026-10-02 15:40:00",
    url: "https://code.xueersi.com/home/project/detail?pid=1",
  },
  {
    id: 2, name: "贪吃蛇", description: "python 写的经典贪吃蛇，方向键控制", lang: "python",
    version: "1.0", category: 1, tags: "游戏", user_id: 101, username: "小红",
    thumbnail: "", views: 5000, likes: 200, comments: 3, favorites: 9, source_code_views: 100,
    published_at: "2021-01-01 10:00:00", updated_at: "2021-02-01 10:00:00",
    url: "https://code.xueersi.com/home/project/detail?pid=2",
  },
  {
    id: 3, name: "我的世界3D", description: "沙盒建造，资源收集", lang: "cpp",
    version: "1.0", category: 2, tags: "沙盒专区", user_id: 102, username: "小刚",
    thumbnail: "", views: 900, likes: 10, comments: 0, favorites: 1, source_code_views: 5,
    published_at: "2022-05-05 08:00:00", updated_at: "2022-05-05 08:00:00",
    url: "https://code.xueersi.com/home/project/detail?pid=3",
  },
  {
    id: 4, name: "Scratch3.0", description: "", lang: "scratch", version: "3.0", category: 1, tags: "",
    user_id: 100, username: "小明", thumbnail: "", views: 18, likes: 0, comments: 0, favorites: 0,
    source_code_views: 1, published_at: "2020-02-09 21:08:00", updated_at: "2025-12-07 17:45:00",
    url: "https://code.xueersi.com/home/project/detail?pid=4",
  },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xccse-test-"));
const dbFile = path.join(tmp, "test.db");
const worksFile = path.join(tmp, "works.jsonl");
const usersFile = path.join(tmp, "users.jsonl");

fs.writeFileSync(worksFile, FIXTURE_WORKS.map((w) => JSON.stringify(w)).join("\n") + "\n");
fs.writeFileSync(
  usersFile,
  [JSON.stringify({ user_id: 100, username: "小明", fans: 45, follows: 0, avatar: "", signature: "" }), "\n",
   JSON.stringify({ user_id: 101, username: "小红", fans: 3, follows: 1, avatar: "", signature: "" }), "\n"].join(""),
);

buildIndex({ worksFile, usersFile, scanWorksFile: null, dbFile, log: () => {} });
const db = openDb(dbFile);
const ids = (result) => result.rows.map((r) => r.id);

test("中文两字查询命中作品（bigram 短语）", () => {
  const result = search(db, { q: "赛车" });
  assert.deepEqual(ids(result), [1]);
  assert.equal(result.mode, "keyword");
});

test("中文查询是真实子串语义，不会跨词命中", () => {
  assert.deepEqual(ids(search(db, { q: "赛车游戏" })), []);
  assert.deepEqual(ids(search(db, { q: "翔的赛车" })), [1]);
});

test("单字中文查询可用", () => {
  assert.deepEqual(ids(search(db, { q: "蛇" })), [2]);
});

test("英文词可搜，且支持前缀", () => {
  assert.deepEqual(ids(search(db, { q: "python" })), [2]);
  assert.deepEqual(ids(search(db, { q: "pyth" })), [2]);
});

test("C++ 别名可搜到 cpp 作品", () => {
  assert.deepEqual(ids(search(db, { q: "c++" })), [3]);
});

test("拼音全拼可搜到对应中文作品", () => {
  const result = search(db, { q: "saiche" });
  assert.deepEqual(ids(result), [1]);
  assert.equal(result.mode, "pinyin");
});

test("拼音首字母可搜到对应中文作品", () => {
  const result = search(db, { q: "fxds" });
  assert.deepEqual(ids(result), [1]);
  assert.equal(result.mode, "pinyin");
});

test("无匹配时返回空结果而不是报错", () => {
  const result = search(db, { q: "完全不存在的作品名" });
  assert.equal(result.total, 0);
  assert.deepEqual(result.rows, []);
});

test("语言筛选生效", () => {
  assert.deepEqual(ids(search(db, { q: "游戏", lang: "python" })), [2]);
  assert.deepEqual(ids(search(db, { q: "赛车", lang: "python" })), []);
});

test("空查询进入浏览模式，按浏览量倒序", () => {
  const result = search(db, { q: "" });
  assert.equal(result.mode, "browse");
  assert.deepEqual(ids(result), [1, 2, 3, 4]);
});

test("可切换排序方式", () => {
  assert.deepEqual(ids(search(db, { q: "", sort: "likes" })), [1, 2, 3, 4]);
  assert.deepEqual(ids(search(db, { q: "", sort: "newest" })), [3, 2, 4, 1]);
});

test("分页参数生效", () => {
  const first = search(db, { q: "", limit: 2, page: 1 });
  const second = search(db, { q: "", limit: 2, page: 2 });
  assert.deepEqual(ids(first), [1, 2]);
  assert.deepEqual(ids(second), [3, 4]);
});

test("作者筛选生效", () => {
  assert.deepEqual(ids(search(db, { q: "", author: 101 })), [2]);
});

test("统计与分面数据正确", () => {
  const s = stats(db);
  assert.equal(s.works, 4);
  assert.equal(s.authors, 3);
  assert.equal(s.views, 103302 + 5000 + 900 + 18);

  const f = facets(db);
  assert.deepEqual(f.langs.map((l) => l.lang).sort(), ["cpp", "python", "scratch"]);
  assert.ok(f.tags.some((t) => t.value === "游戏"));
});

test("标题联想可用", () => {
  assert.deepEqual(suggest(db, "赛").map((r) => r.id), [1]);
});

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
