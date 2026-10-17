#!/usr/bin/env node
/**
 * 跨年代抽样：在不同 ID 区间各取一段连续 ID 扫描，估算全量扫描的
 * 有效率、命中密度、带宽与耗时。
 *
 *   node scripts/sample.mjs --ranges 5000000,20000000,40000000,60000000 --per-range 75 --concurrency 8
 */
import fs from "node:fs";
import path from "node:path";
import { fetchProjectRecord } from "../src/scan.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map((chunk) => {
      const [key, ...rest] = chunk.trim().split(/\s+/);
      return [key, rest.join(" ") || "true"];
    }),
);

const ranges = String(args.ranges ?? "5000000,20000000,40000000,60000000")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const perRange = Number(args["per-range"] ?? 75);
const concurrency = Math.max(1, Math.min(16, Number(args.concurrency ?? 8)));
const maxId = Number(args["max-id"] ?? 70125611);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function sampleRange(from, count) {
  const ids = Array.from({ length: count }, (_, i) => from + i);
  const latencies = [];
  const results = [];
  let cursor = 0;
  const startedAt = performance.now();

  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor];
      cursor += 1;
      const r = await fetchProjectRecord(id);
      latencies.push(r.latencyMs);
      results.push(r);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

  const elapsedSec = (performance.now() - startedAt) / 1000;
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const bytes = results.reduce((a, r) => a + r.bytes, 0);
  const publicWorks = results.filter((r) => r.public);

  return {
    from,
    to: from + count - 1,
    requests: count,
    http200: results.filter((r) => r.status === 200).length,
    notFound: results.filter((r) => r.status === 404).length,
    publicWorks: publicWorks.length,
    publicRate: Number(((publicWorks.length / count) * 100).toFixed(2)),
    existsRate: Number(((results.filter((r) => r.status === 200).length / count) * 100).toFixed(2)),
    bytesMB: Number((bytes / 1048576).toFixed(2)),
    avgBytes: Math.round(bytes / count),
    elapsedSec: Number(elapsedSec.toFixed(1)),
    throughput: Number((count / elapsedSec).toFixed(1)),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    byStatus,
    samples: publicWorks.slice(0, 10).map((r) => ({
      id: r.id,
      name: r.record.name,
      lang: r.record.lang,
      views: r.record.views,
      published_at: r.record.published_at?.slice(0, 10),
    })),
  };
}

const report = { sampledAt: new Date().toISOString(), perRange, concurrency, maxId, ranges: [] };

for (const from of ranges) {
  process.stderr.write(`抽样 ${from} 起 ${perRange} 次 ...\n`);
  const result = await sampleRange(from, perRange);
  report.ranges.push(result);
  process.stderr.write(
    `  200=${result.http200} 404=${result.notFound} 公开=${result.publicWorks} (${result.publicRate}%) 平均 ${(result.avgBytes / 1024).toFixed(1)}KB\n`,
  );
}

const totalRequests = report.ranges.reduce((a, r) => a + r.requests, 0);
const totalPublic = report.ranges.reduce((a, r) => a + r.publicWorks, 0);
const totalExists = report.ranges.reduce((a, r) => a + r.http200, 0);
const totalBytes = report.ranges.reduce((a, r) => a + r.bytesMB, 0);
const weightedPublicRate = (totalPublic / totalRequests) * 100;
const weightedExistsRate = (totalExists / totalRequests) * 100;
const totalElapsed = report.ranges.reduce((a, r) => a + r.elapsedSec, 0);

const projections = [8, 16, 24].map((rps) => ({
  rps,
  days: Number((maxId / rps / 86400).toFixed(1)),
  publicWorks: Math.round((weightedPublicRate / 100) * maxId),
}));

const avgKB = (totalBytes * 1024) / totalRequests;

report.summary = {
  totalRequests,
  totalPublic,
  weightedPublicRate: Number(weightedPublicRate.toFixed(2)),
  weightedExistsRate: Number(weightedExistsRate.toFixed(2)),
  avgKBPerRequest: Number(avgKB.toFixed(1)),
  projectedGB: Math.round((maxId * avgKB) / 1024 / 1024),
  observedThroughput: Number((totalRequests / totalElapsed).toFixed(1)),
  projections,
};

const out = path.resolve("data/sample-report.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
console.log(`\n完整报告: ${out}`);
