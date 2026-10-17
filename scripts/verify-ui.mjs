#!/usr/bin/env node
/**
 * 端到端界面验证：用真实 Chrome 打开搜索页，检查渲染、交互与控制台报错。
 *
 *   npm run serve          # 另开一个终端
 *   npm run verify:ui
 *
 * 需要本机安装 Chrome；若路径不同，用 CHROME_PATH 环境变量覆盖。
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.XCCSE_URL ?? "http://127.0.0.1:8787";
const CHROME =
  process.env.CHROME_PATH ??
  ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
   "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
   "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error("找不到 Chrome，请用 CHROME_PATH 指定可执行文件路径");
  process.exit(1);
}

const SHOT_DIR = path.resolve("artifacts/ui");
fs.mkdirSync(SHOT_DIR, { recursive: true });

let passed = 0;
let failed = 0;
const check = (label, value) => {
  if (value) { passed += 1; console.log(`  \u2713 ${label}`); }
  else { failed += 1; console.log(`  \u2717 ${label}`); }
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];

async function newPage(contextOptions = {}) {
  const ctx = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 940 },
    ...contextOptions,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return page;
}

try {
  console.log(`\n== 初始状态 (${BASE}) ==`);
  let page = await newPage();
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1000);
  check("页脚显示索引统计", /索引：\d+ 个作品/.test(await page.textContent("#foot-stats")));
  check("语言筛选按钮已渲染", (await page.locator("#lang-chips .chip").count()) >= 1);
  check("空态提示可见", await page.locator("#empty").isVisible());
  check("空态下分页条隐藏", !(await page.locator("#pager").isVisible()));
  await page.screenshot({ path: path.join(SHOT_DIR, "01-initial.png") });

  console.log("\n== 中文检索 ==");
  await page.fill("#q", "赛车");
  await page.waitForTimeout(900);
  check("状态栏显示命中数", /找到 \d+ 个作品/.test(await page.textContent("#status")));
  check("结果卡片已渲染", (await page.locator(".card").count()) > 0);
  check("关键词已高亮", (await page.locator(".card-title mark").count()) > 0);
  check("URL 同步查询词", decodeURIComponent(page.url()).includes("q=赛车"));
  check("有结果时空态隐藏", !(await page.locator("#empty").isVisible()));
  await page.screenshot({ path: path.join(SHOT_DIR, "02-search.png") });

  console.log("\n== 拼音检索 ==");
  await page.fill("#q", "saiche");
  await page.waitForTimeout(900);
  check("标注为拼音匹配", (await page.textContent("#status")).includes("拼音匹配"));
  await page.screenshot({ path: path.join(SHOT_DIR, "03-pinyin.png") });

  console.log("\n== 语言筛选 ==");
  await page.fill("#q", "游戏");
  await page.waitForTimeout(800);
  await page.click('#lang-chips .chip[data-lang="python"]');
  await page.waitForTimeout(800);
  const langs = await page.locator(".card .tag-lang").allTextContents();
  check("结果全部为 Python", langs.length > 0 && langs.every((t) => t.includes("Python")));
  check("筛选按钮处于选中态", (await page.getAttribute('#lang-chips .chip[data-lang="python"]', "aria-pressed")) === "true");
  await page.screenshot({ path: path.join(SHOT_DIR, "04-filter.png") });

  console.log("\n== 排序 / 分页 ==");
  await page.click('#lang-chips .chip[data-lang=""]');
  await page.selectOption("#sort", "likes");
  await page.waitForTimeout(800);
  check("切换排序后仍有结果", (await page.locator(".card").count()) > 0);
  check("多页结果时显示分页条", await page.locator("#pager").isVisible());
  check("首页时上一页禁用", await page.locator("#prev").isDisabled());
  const firstTitle = await page.textContent(".card-title");
  await page.click("#next");
  await page.waitForTimeout(800);
  check("翻页后内容变化", (await page.textContent(".card-title")) !== firstTitle);
  check("URL 带 page=2", page.url().includes("page=2"));
  await page.screenshot({ path: path.join(SHOT_DIR, "05-page2.png") });

  console.log("\n== 空结果 ==");
  await page.fill("#q", "zzzz一个绝对不存在的作品名");
  await page.waitForTimeout(900);
  check("显示空结果提示", await page.locator("#empty").isVisible());
  check("空结果时分页条隐藏", !(await page.locator("#pager").isVisible()));
  await page.screenshot({ path: path.join(SHOT_DIR, "06-empty.png") });

  console.log("\n== 快捷键与深链 ==");
  await page.fill("#q", "");
  await page.waitForTimeout(500);
  await page.keyboard.press("/");
  check("按 / 聚焦搜索框", await page.evaluate(() => document.activeElement?.id === "q"));

  await page.goto(`${BASE}/?q=${encodeURIComponent("贪吃蛇")}&lang=python&sort=views`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  check("深链恢复关键词", (await page.inputValue("#q")) === "贪吃蛇");
  check("深链恢复语言筛选", (await page.getAttribute('#lang-chips .chip[data-lang="python"]', "aria-pressed")) === "true");
  check("深链恢复排序", (await page.inputValue("#sort")) === "views");
  check("深链返回结果", (await page.locator(".card").count()) > 0);
  await page.screenshot({ path: path.join(SHOT_DIR, "07-deeplink.png") });

  console.log("\n== 响应式与主题 ==");
  const dark = await newPage({ colorScheme: "dark" });
  await dark.goto(`${BASE}/?q=${encodeURIComponent("飞机大战")}`, { waitUntil: "networkidle" });
  await dark.waitForTimeout(1000);
  check("深色模式渲染结果", (await dark.locator(".card").count()) > 0);
  await dark.screenshot({ path: path.join(SHOT_DIR, "08-dark.png") });

  const mobile = await newPage({ viewport: { width: 420, height: 860 } });
  await mobile.goto(`${BASE}/?q=${encodeURIComponent("我的世界")}`, { waitUntil: "networkidle" });
  await mobile.waitForTimeout(1000);
  check("窄屏渲染结果", (await mobile.locator(".card").count()) > 0);
  await mobile.screenshot({ path: path.join(SHOT_DIR, "09-mobile.png") });

  console.log(`\n控制台错误: ${errors.length}`);
  errors.slice(0, 10).forEach((e) => console.log(`  ! ${e}`));
  check("无控制台错误", errors.length === 0);
} finally {
  await browser.close();
}

console.log(`\n截图目录: ${SHOT_DIR}`);
console.log(`结果: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
