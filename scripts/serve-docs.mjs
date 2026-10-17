#!/usr/bin/env node
/** 本地预览 docs/（模拟 GitHub Pages 的子路径行为）。 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("docs");
const port = Number(process.env.PORT ?? 8788);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404");
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    res.end(body);
  })
  .listen(port, "127.0.0.1", () => console.log(`静态预览: http://127.0.0.1:${port}/`));
