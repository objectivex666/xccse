import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, search, stats, facets, suggest, getWork } from "./search.mjs";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

export function createApp({ log = () => {} } = {}) {
  const db = openDb();

  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    try {
      if (url.pathname === "/api/search") {
        const result = search(db, {
          q: url.searchParams.get("q") ?? "",
          lang: url.searchParams.get("lang") || undefined,
          author: url.searchParams.get("author") || undefined,
          sort: url.searchParams.get("sort") || "relevance",
          page: url.searchParams.get("page") ?? 1,
          limit: url.searchParams.get("limit") ?? 20,
        });
        return sendJson(res, 200, result);
      }

      if (url.pathname === "/api/stats") return sendJson(res, 200, stats(db));
      if (url.pathname === "/api/facets") return sendJson(res, 200, facets(db));

      if (url.pathname === "/api/suggest") {
        return sendJson(res, 200, { items: suggest(db, url.searchParams.get("q") ?? "") });
      }

      const workMatch = url.pathname.match(/^\/api\/work\/(\d+)$/);
      if (workMatch) {
        const work = getWork(db, workMatch[1]);
        return work ? sendJson(res, 200, work) : sendJson(res, 404, { error: "not found" });
      }

      if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "unknown endpoint" });

      const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const resolved = path.resolve(WEB_DIR, relative);
      if (!resolved.startsWith(WEB_DIR)) {
        res.writeHead(403).end("403");
        return undefined;
      }
      return sendFile(res, resolved);
    } catch (err) {
      log(`请求失败 ${url.pathname}: ${err.message}`);
      return sendJson(res, 500, { error: err.message });
    }
  });
}

export async function startServer({ port = 8787, host = "127.0.0.1", log = console.error } = {}) {
  const server = createApp({ log });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  log(`学而思编程作品搜索已启动: http://${host}:${port}`);
  return server;
}
