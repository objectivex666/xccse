import test from "node:test";
import assert from "node:assert/strict";
import { isPublicRecord } from "../src/scan.mjs";

const base = {
  name: "飞翔的赛车",
  published: 1,
  removed: 0,
  deleted_at: "",
};

test("已发布、未移除、未删除且有标题的作品算公开", () => {
  assert.equal(isPublicRecord(base), true);
});

test("未发布的作品不算公开", () => {
  assert.equal(isPublicRecord({ ...base, published: 0 }), false);
});

test("已移除的作品不算公开", () => {
  assert.equal(isPublicRecord({ ...base, removed: 1 }), false);
});

test("有删除时间的作品不算公开", () => {
  assert.equal(isPublicRecord({ ...base, deleted_at: "2024-01-01 00:00:00" }), false);
});

test("没有标题的作品不算公开", () => {
  assert.equal(isPublicRecord({ ...base, name: "" }), false);
});

test("字段缺失时按非公开处理", () => {
  assert.equal(isPublicRecord({}), false);
});
