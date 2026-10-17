import test from "node:test";
import assert from "node:assert/strict";
import { analyze, buildMatchExpr, buildPinyinExpr, normalize, splitRuns } from "../src/tokenize.mjs";

test("normalize 会归一化大小写与全角，并展开语言别名", () => {
  assert.equal(normalize("C++"), "cpp");
  assert.equal(normalize("C#"), "csharp");
  assert.equal(normalize("Ｓｃｒａｔｃｈ"), "scratch");
});

test("analyze 产出中文相邻二元组与单字双通道", () => {
  const result = analyze("会飞的赛车游戏");
  assert.deepEqual(result.cjkBigrams, ["会飞", "飞的", "的赛", "赛车", "车游", "游戏"]);
  assert.ok(result.cjkChars.includes("赛"));
  assert.equal(result.cjkBigrams.join("").includes("车游"), true);
});

test("analyze 会切出英文词并保留拼音", () => {
  const result = analyze("python贪吃蛇");
  assert.deepEqual(result.words, ["python"]);
  assert.equal(result.pinyinConcat, "tanchishe");
  assert.ok(result.cjkBigrams.includes("贪吃"));
});

test("超过两个字的中文查询编译成连续短语（真实子串语义）", () => {
  const { expr } = buildMatchExpr("赛车游戏");
  assert.equal(expr, '(t_bi : "赛车 车游 游戏" OR b_bi : "赛车 车游 游戏")');
});

test("单字中文查询走单字通道", () => {
  const { expr } = buildMatchExpr("蛇");
  assert.equal(expr, '(t_ch : "蛇" OR b_ch : "蛇")');
});

test("英文查询编译成前缀匹配", () => {
  const { expr } = buildMatchExpr("pyth");
  assert.equal(expr, '(t_w : pyth* OR b_w : pyth*)');
});

test("中英混合查询用 AND 连接", () => {
  const { expr } = buildMatchExpr("python贪吃蛇");
  assert.equal(
    expr,
    '(t_w : python* OR b_w : python*) AND (t_bi : "贪吃 吃蛇" OR b_bi : "贪吃 吃蛇")',
  );
});

test("空查询不产生表达式", () => {
  assert.equal(buildMatchExpr("").expr, null);
});

test("拼音表达式只对纯字母且长度 >= 3 的查询生效", () => {
  assert.equal(buildPinyinExpr("saiche"), '(py : "saiche" OR init : "saiche")');
  assert.equal(buildPinyinExpr("ab"), null);
  assert.equal(buildPinyinExpr("赛车"), null);
});

test("splitRuns 区分中文、单词与分隔符", () => {
  const runs = splitRuns("赛车 abc-1");
  assert.deepEqual(
    runs.map((r) => [r.type, r.text]),
    [["cjk", "赛车"], ["sep", " "], ["word", "abc"], ["sep", "-"], ["word", "1"]],
  );
});
