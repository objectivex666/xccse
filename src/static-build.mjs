import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyze } from "./tokenize.mjs";
import { WORKS_FILE, mergeWork, normalizeWork, readJsonl } from "./crawl.mjs";
import { SCAN_WORKS_FILE } from "./scan.mjs";

export const DOCS_DIR = path.resolve("docs");

function compact(work) {
  const tokens = analyze(work.name || "");
  return {
    id: work.id,
    n: work.name || "",
    d: (work.description || "").slice(0, 300),
    l: work.lang || "",
    u: work.username || "",
    uid: work.user_id ?? 0,
    v: work.views || 0,
    k: work.likes || 0,
    t: work.thumbnail || "",
    p: work.published_at || "",
    url: work.url || "",
    py: tokens.pinyinConcat,
    ini: tokens.initialConcat,
  };
}

function copyInto(file, target, transform = (s) => s) {
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(target, transform(text));
}

export function buildStatic({ worksFile = WORKS_FILE, outDir = DOCS_DIR, log = console.log } = {}) {
  const byId = new Map();
  for (const work of readJsonl(worksFile)) byId.set(work.id, work);
  for (const work of readJsonl(SCAN_WORKS_FILE)) {
    byId.set(work.id, mergeWork(byId.get(work.id) ?? {}, work));
  }
  const works = [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .map((w) => normalizeWork(w))
    .filter(Boolean)
    .map(compact);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "data"), { recursive: true });

  const payload = JSON.stringify(works);
  fs.writeFileSync(path.join(outDir, "data", "works.json"), payload);
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "");

  copyInto(
    path.resolve("web/index.html"),
    path.join(outDir, "index.html"),
    (html) =>
      html
        .replace('href="/app.css"', 'href="./app.css"')
        .replace('src="/app.js"', 'src="./app.js"')
        .replace('href="/favicon.svg"', 'href="./favicon.svg"'),
  );
  copyInto(path.resolve("web/app.css"), path.join(outDir, "app.css"));
  copyInto(path.resolve("web/favicon.svg"), path.join(outDir, "favicon.svg"));
  copyInto(path.resolve("web/pages/app.js"), path.join(outDir, "app.js"));

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  log(`静态站点已生成：${outDir}`);
  log(`  作品 ${works.length} 条，数据 ${kb(Buffer.byteLength(payload))}`);
  log(`  文件 index.html / app.css / app.js / favicon.svg / data/works.json`);
  return { works: works.length, bytes: Buffer.byteLength(payload) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) buildStatic();
