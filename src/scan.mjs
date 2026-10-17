import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, detailUrl, mergeWork, normalizeWork, writeJsonl } from "./crawl.mjs";
import { HEADERS, sleep } from "./http.mjs";

export const SCAN_AUDIT_FILE = path.join(DATA_DIR, "scan-audit.jsonl");
export const SCAN_CHECKPOINT_FILE = path.join(DATA_DIR, "scan-checkpoint.json");
export const SCAN_WORKS_FILE = path.join(DATA_DIR, "scan-works.jsonl");

const BASE = "https://code.xueersi.com";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function decodeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/**
 * 读取作品详情的头部，解析出判断「是否公开」所需的字段。
 *
 * 注意：详情响应把完整的作品源码（xml）放在 published 之前，
 * 所以即使只需要 published，也必须收完 xml。这里顺带统计实际下载字节数，
 * 用来量化全 ID 扫描的真实带宽成本。
 */
export async function fetchProjectRecord(id, { timeout = 20000 } = {}) {
  const url = `${BASE}/api/projects/${id}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let buffer = "";
  let status = 0;
  let bytes = 0;
  let truncated = false;
  const startedAt = performance.now();

  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    status = res.status;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { id, status, ok: false, bytes: 0, latencyMs: Math.round(performance.now() - startedAt) };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (buffer.length < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      if (/"username":/.test(buffer)) break;
    }
    truncated = buffer.length >= MAX_BODY_BYTES && !/"username":/.test(buffer);
    controller.abort();
  } catch {
    return {
      id,
      status: status || "ERR",
      ok: false,
      bytes,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(timer);
  }

  const pick = (key) => {
    const m = buffer.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? decodeJsonString(m[1]) : undefined;
  };
  const num = (key) => {
    const m = buffer.match(new RegExp(`"${key}":(\\d+)`));
    return m ? Number(m[1]) : undefined;
  };

  const record = {
    id,
    name: pick("name"),
    description: pick("description") ?? "",
    tags: pick("tags") ?? "",
    lang: pick("lang") ?? "",
    version: pick("version") ?? "",
    type: pick("type") ?? "",
    category: num("category"),
    user_id: num("user_id") ?? null,
    username: pick("username") ?? "",
    user_avatar: pick("user_avatar") ?? "",
    thumbnail: pick("thumbnail") ?? pick("first_frame") ?? "",
    views: num("views") ?? 0,
    likes: num("likes") ?? 0,
    comments: num("comments") ?? 0,
    favorites: num("favorites") ?? 0,
    published: num("published"),
    removed: num("removed"),
    deleted_at: pick("deleted_at") ?? "",
    hidden_code: num("hidden_code"),
    published_at: pick("published_at") ?? "",
    created_at: pick("created_at") ?? "",
    updated_at: pick("updated_at") ?? "",
  };

  return {
    id,
    status,
    ok: true,
    bytes,
    truncated,
    latencyMs: Math.round(performance.now() - startedAt),
    public: isPublicRecord(record),
    record,
  };
}

/** 公开作品判定：已发布、未移除、未删除，且有标题。 */
export function isPublicRecord(record) {
  return record.published === 1 && record.removed === 0 && record.deleted_at === "" && Boolean(record.name);
}

/** 令牌桶限速：全局统一节奏，不靠并发数间接猜测速率。 */
class RateLimiter {
  constructor(requestsPerSecond) {
    this.interval = 1000 / Math.max(0.1, requestsPerSecond);
    this.next = 0;
  }

  async acquire() {
    const now = Date.now();
    const wait = Math.max(0, this.next - now);
    this.next = Math.max(now, this.next) + this.interval;
    if (wait > 0) await sleep(wait);
  }
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function readCheckpoint() {
  try {
    return JSON.parse(fs.readFileSync(SCAN_CHECKPOINT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCheckpoint(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SCAN_CHECKPOINT_FILE, JSON.stringify(data, null, 2));
}

/**
 * 顺序扫描一段作品 ID 区间，并把公开作品写入 scan-works.jsonl。
 * 每处理一条就更新 checkpoint，进程中断后可原地续跑。
 */
export async function scanRange({
  from,
  to = Number.MAX_SAFE_INTEGER,
  maxRequests = 100,
  requestsPerSecond = 2,
  resume = true,
  log = (m) => console.error(m),
} = {}) {
  const checkpoint = resume ? readCheckpoint() : null;
  const startId =
    checkpoint && checkpoint.nextId && checkpoint.nextId >= from && checkpoint.nextId <= to
      ? checkpoint.nextId
      : from;

  if (startId !== from) log(`从断点续跑：${startId}`);

  const limiter = new RateLimiter(requestsPerSecond);
  const collected = new Map();
  for (const work of readJsonlSafe(SCAN_WORKS_FILE)) collected.set(work.id, work);

  const stats = { requests: 0, ok: 0, notFound: 0, failed: 0, public: 0, bytes: 0, latencies: [] };
  let id = startId;

  for (let i = 0; i < maxRequests && id <= to; i += 1) {
    await limiter.acquire();
    const result = await fetchProjectRecord(id);
    stats.requests += 1;
    stats.bytes += result.bytes;
    stats.latencies.push(result.latencyMs);

    if (result.ok) {
      stats.ok += 1;
      if (result.public) {
        stats.public += 1;
        const work = mergeWork(collected.get(result.record.id) ?? {}, normalizeWork(result.record));
        if (!work.url) work.url = detailUrl(work);
        collected.set(work.id, work);
      }
    } else if (result.status === 404) {
      stats.notFound += 1;
    } else {
      stats.failed += 1;
    }

    appendLine(
      SCAN_AUDIT_FILE,
      JSON.stringify({
        id,
        status: result.status,
        public: Boolean(result.public),
        bytes: result.bytes,
        latency_ms: result.latencyMs,
        scanned_at: new Date().toISOString(),
        published: result.record?.published ?? null,
        removed: result.record?.removed ?? null,
      }),
    );

    id += 1;
    writeCheckpoint({ nextId: id, from, to, updatedAt: new Date().toISOString() });

    if (stats.requests % 25 === 0) {
      log(
        `  已扫描 ${stats.requests} 次：存在 ${stats.ok}，公开 ${stats.public}，404 ${stats.notFound}，失败 ${stats.failed}`,
      );
    }
  }

  if (collected.size) writeJsonl(SCAN_WORKS_FILE, [...collected.values()].sort((a, b) => a.id - b.id));

  return {
    ...stats,
    nextId: id,
    avgLatencyMs: stats.latencies.length
      ? Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length)
      : 0,
    p95LatencyMs: percentile(stats.latencies, 95),
    avgBytes: stats.requests ? Math.round(stats.bytes / stats.requests) : 0,
  };
}

function readJsonlSafe(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * 分档提速测试：每个档位固定请求数，记录成功率和延迟。
 * 出现 429、连续超时或错误率过高就立即停止，把上一档作为稳定速率。
 */
export async function probeRate({
  from,
  steps = [1, 2, 4, 8, 16],
  requestsPerStep = 8,
  log = (m) => console.error(m),
} = {}) {
  const results = [];
  let id = from;
  let lastClean = 0;

  for (const rps of steps) {
    const limiter = new RateLimiter(rps);
    const latencies = [];
    let ok = 0;
    let notFound = 0;
    let failed = 0;
    let rateLimited = 0;
    let consecutiveTimeouts = 0;
    const startedAt = performance.now();

    for (let i = 0; i < requestsPerStep; i += 1) {
      await limiter.acquire();
      const result = await fetchProjectRecord(id);
      id += 1;

      if (result.status === 429) rateLimited += 1;
      if (result.ok) {
        ok += 1;
        consecutiveTimeouts = 0;
      } else if (result.status === 404) {
        notFound += 1;
        consecutiveTimeouts = 0;
      } else {
        failed += 1;
        if (result.status === "ERR") consecutiveTimeouts += 1;
      }
      latencies.push(result.latencyMs);

      if (rateLimited > 0 || consecutiveTimeouts >= 3) break;
    }

    const elapsedSec = (performance.now() - startedAt) / 1000;
    const measuredRps = elapsedSec > 0 ? Number((latencies.length / elapsedSec).toFixed(2)) : 0;
    const errorCount = failed + rateLimited;
    const errorRate = latencies.length ? errorCount / latencies.length : 0;
    const step = {
      targetRps: rps,
      requests: latencies.length,
      measuredRps,
      ok,
      notFound,
      failed,
      rateLimited,
      errorRate: Number((errorRate * 100).toFixed(1)),
      p95LatencyMs: percentile(latencies, 95),
    };
    results.push(step);
    log(
      `  ${rps} req/s -> 实测 ${measuredRps}/s，成功 ${ok}，404 ${notFound}，失败 ${failed}，429 ${rateLimited}，p95 ${step.p95LatencyMs}ms`,
    );

    if (rateLimited > 0 || errorRate > 0.25) {
      log(`  在 ${rps} req/s 触发限制或错误率过高，停止提速`);
      break;
    }
    lastClean = rps;
  }

  return { results, lastClean, nextId: id };
}

/**
 * 并发档位测试。
 *
 * 顺序请求时吞吐被单次延迟锁死（实测约 2.5 次/秒），所以真正的速率上限
 * 必须靠并发来测。每档跑固定请求数，记录实测吞吐、错误与延迟。
 */
export async function probeConcurrency({
  from,
  levels = [1, 2, 4, 8, 16],
  requestsPerLevel = 12,
  log = (m) => console.error(m),
} = {}) {
  const results = [];
  let id = from;
  let lastClean = 0;

  for (const concurrency of levels) {
    const ids = Array.from({ length: requestsPerLevel }, () => id++);
    const latencies = [];
    let ok = 0;
    let notFound = 0;
    let failed = 0;
    let rateLimited = 0;
    let cursor = 0;
    const startedAt = performance.now();

    const worker = async () => {
      while (cursor < ids.length) {
        const current = ids[cursor];
        cursor += 1;
        const result = await fetchProjectRecord(current);
        latencies.push(result.latencyMs);
        if (result.status === 429) rateLimited += 1;
        if (result.ok) ok += 1;
        else if (result.status === 404) notFound += 1;
        else failed += 1;
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

    const elapsedSec = (performance.now() - startedAt) / 1000;
    const measuredRps = elapsedSec > 0 ? Number((latencies.length / elapsedSec).toFixed(2)) : 0;
    const errorRate = latencies.length ? (failed + rateLimited) / latencies.length : 0;
    const step = {
      concurrency,
      requests: latencies.length,
      measuredRps,
      ok,
      notFound,
      failed,
      rateLimited,
      errorRate: Number((errorRate * 100).toFixed(1)),
      p95LatencyMs: percentile(latencies, 95),
    };
    results.push(step);
    log(
      `  并发 ${concurrency} -> 实测 ${measuredRps}/s，成功 ${ok}，404 ${notFound}，失败 ${failed}，429 ${rateLimited}，p95 ${step.p95LatencyMs}ms`,
    );

    if (rateLimited > 0 || errorRate > 0.25) {
      log(`  并发 ${concurrency} 触发限制或错误率过高，停止提速`);
      break;
    }
    lastClean = concurrency;
  }

  const best = [...results].sort((a, b) => b.measuredRps - a.measuredRps)[0] ?? null;
  return { results, lastClean, best, nextId: id };
}
