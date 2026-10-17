#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { crawl } from "./crawl.mjs";
import { buildIndex } from "./indexer.mjs";
import { openDb, search, stats } from "./search.mjs";
import { startServer } from "./server.mjs";
import { probeConcurrency, probeRate, scanRange } from "./scan.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "max-users": { type: "string", default: "300" },
    concurrency: { type: "string", default: "6" },
    "no-detail": { type: "boolean", default: false },
    "detail-limit": { type: "string", default: "0" },
    port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" },
    lang: { type: "string" },
    sort: { type: "string", default: "relevance" },
    limit: { type: "string", default: "10" },
    json: { type: "boolean", default: false },
    from: { type: "string" },
    to: { type: "string" },
    "max-requests": { type: "string", default: "100" },
    rate: { type: "string", default: "2" },
    probe: { type: "boolean", default: false },
    "probe-concurrency": { type: "boolean", default: false },
    steps: { type: "string", default: "1,2,4,8,16" },
    "per-step": { type: "string", default: "8" },
    "no-resume": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];
const log = (msg) => console.error(msg);

const HELP = `
学而思编程作品搜索引擎 (xccse)

用法:
  xccse crawl [选项]            抓取 code.xueersi.com 公开作品数据
  xccse index                   由抓取结果构建 SQLite FTS5 索引
  xccse serve [选项]            启动搜索服务与网页界面
  xccse search <关键词> [选项]   命令行检索
  xccse stats                   查看索引概览
  xccse scan [选项]             按作品 ID 扫描公开作品 / 测速

选项:
  --max-users <n>     爬虫最多扫描的作者数 (默认 300)
  --concurrency <n>   并发请求数 (默认 6)
  --no-detail         跳过作品详情抓取（更快，但少了简介）
  --detail-limit <n>  最多补全多少个作品的详情 (0 = 不限)
  --port <n>          服务端口 (默认 8787)
  --host <ip>         监听地址 (默认 127.0.0.1)
  --lang <code>       按语言过滤: scratch | python | cpp | webpy
  --sort <mode>       relevance | views | likes | newest (默认 relevance)
  --limit <n>         返回条数 (默认 10)
  --json              以 JSON 输出
  --from <id>         扫描起始作品 ID
  --to <id>           扫描结束作品 ID
  --max-requests <n>  本次最多请求多少个 ID (默认 100)
  --rate <n>          目标请求速率，次/秒 (默认 2)
  --probe             分档提速测试，找出稳定速率上限
  --probe-concurrency 并发档位测试，找出吞吐上限
  --steps <list>      提速档位，逗号分隔 (默认 1,2,4,8,16)
  --per-step <n>      每档请求数 (默认 8)
  --no-resume         忽略断点，从 --from 重新开始

示例:
  xccse crawl --max-users 200
  xccse index
  xccse search 赛车
  xccse search saiche          # 拼音检索
  xccse search 贪吃蛇 --lang python
  xccse serve --port 9000
  xccse scan --from 34529 --max-requests 100 --rate 2
  xccse scan --from 50000 --probe --steps 1,2,4,8
`.trim();

function printResult(result) {
  if (!result.rows.length) {
    console.log(`没有匹配 "${result.query}" 的作品`);
    return;
  }
  console.log(`查询 "${result.query}"  (${result.mode}, ${result.total} 条命中, ${result.tookMs}ms)\n`);
  for (const row of result.rows) {
    const meta = [row.lang || "未知语言", `♥ ${row.likes}`, `👁 ${row.views}`, row.username].filter(Boolean).join("  ");
    console.log(`  ${row.name}`);
    console.log(`    ${meta}`);
    if (row.description) console.log(`    ${row.description.replace(/\s+/g, " ").slice(0, 110)}`);
    console.log(`    ${row.url}\n`);
  }
}

async function main() {
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  if (command === "crawl") {
    await crawl({
      maxUsers: Number(values["max-users"]),
      concurrency: Number(values.concurrency),
      withDetail: !values["no-detail"],
      detailLimit: Number(values["detail-limit"]),
      log,
    });
    return;
  }

  if (command === "index") {
    buildIndex({ log });
    return;
  }

  if (command === "serve") {
    await startServer({ port: Number(values.port), host: values.host, log });
    return;
  }

  if (command === "stats") {
    const db = openDb();
    const s = stats(db);
    console.log(`作品 ${s.works}  作者 ${s.authors}  总浏览 ${s.views}  总点赞 ${s.likes}`);
    console.log(`语言分布: ${s.langs.map((l) => `${l.lang}=${l.count}`).join("  ")}`);
    return;
  }

  if (command === "scan") {
    if (!values.from) {
      console.error("请用 --from 指定起始作品 ID，例如: xccse scan --from 34529");
      process.exitCode = 1;
      return;
    }

    const from = Number(values.from);
    if (!Number.isFinite(from) || from <= 0) {
      console.error("--from 必须是正整数");
      process.exitCode = 1;
      return;
    }

    if (values.probe || values["probe-concurrency"]) {
      const steps = String(values.steps)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (values["probe-concurrency"]) {
        console.error(`并发测速：起始 ID ${from}，档位 ${steps.join("/")}，每档 ${values["per-step"]} 次\n`);
        const result = await probeConcurrency({
          from,
          levels: steps,
          requestsPerLevel: Number(values["per-step"]),
          log,
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.error(`测速：起始 ID ${from}，档位 ${steps.join("/")} req/s，每档 ${values["per-step"]} 次\n`);
      const result = await probeRate({
        from,
        steps,
        requestsPerStep: Number(values["per-step"]),
        log,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const result = await scanRange({
      from,
      to: values.to ? Number(values.to) : undefined,
      maxRequests: Number(values["max-requests"]),
      requestsPerSecond: Number(values.rate),
      resume: !values["no-resume"],
      log,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "search") {
    const query = positionals.slice(1).join(" ");
    if (!query) {
      console.error("请提供关键词，例如: xccse search 赛车");
      process.exitCode = 1;
      return;
    }
    const db = openDb();
    const result = search(db, {
      q: query,
      lang: values.lang,
      sort: values.sort,
      limit: Number(values.limit),
    });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else printResult(result);
    return;
  }

  console.error(`未知命令: ${command}\n`);
  console.log(HELP);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`出错了: ${err.message}`);
    process.exit(1);
  });
}
