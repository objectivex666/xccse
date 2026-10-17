const BASE = "https://code.xueersi.com";

export const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://code.xueersi.com/",
};

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 请求站点的公开 JSON 接口。
 * 全站接口统一挂在同源 /api 下，返回 {stat,status,msg,data} 信封。
 */
export async function fetchJson(pathname, { retries = 3, timeout = 20000, signal } = {}) {
  const url = pathname.startsWith("http") ? pathname : BASE + pathname;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: signal ?? controller.signal });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 200));
      const json = JSON.parse(text);
      if (json && typeof json === "object" && "data" in json) return json.data;
      return json;
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) break;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function decodeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/**
 * 只取作品详情的前若干字段。
 *
 * /api/projects/<id> 会把整个作品源码（xml）一起返回，平均 27KB、最大上百 KB，
 * 而我们只需要开头的 description / tags 等字段。这里边读边判，拿到需要的字段就立刻断开连接。
 */
export async function fetchProjectHead(id, { timeout = 15000, maxBytes = 16384 } = {}) {
  const url = `${BASE}/api/projects/${id}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let buffer = "";
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (buffer.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (/"username":/.test(buffer) || buffer.length >= maxBytes) break;
    }
    controller.abort();
  } catch (err) {
    if (!buffer) return null;
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

  return {
    id: Number(id),
    description: pick("description"),
    tags: pick("tags"),
    username: pick("username"),
    user_avatar: pick("user_avatar"),
    thumbnail: pick("thumbnail") || pick("first_frame"),
    lang: pick("lang"),
    version: pick("version"),
    views: num("views"),
    likes: num("likes"),
  };
}

/** 有限并发地跑一批任务，保持对站点的请求节奏克制。 */
export async function mapLimit(items, limit, worker, { delayMs = 0 } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = { __error: err };
      }
      if (delayMs) await sleep(delayMs);
    }
  });
  await Promise.all(runners);
  return results;
}
