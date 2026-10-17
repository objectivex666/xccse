import fs from "node:fs";
import path from "node:path";
import { fetchJson, fetchProjectHead, mapLimit } from "./http.mjs";

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const WORKS_FILE = path.join(DATA_DIR, "works.jsonl");
export const USERS_FILE = path.join(DATA_DIR, "users.jsonl");

const PER_PAGE = 20;
const USER_PAGE_LIMIT = 10;

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 站点自己的作品详情地址（由 bundle 里的跳转逻辑还原）。 */
export function detailUrl(work) {
  const lang = work.lang || "scratch";
  const params = new URLSearchParams({
    lang: lang === "scratch" ? "scratch" : "code",
    pid: String(work.id),
    version: work.version || "3.0",
    langType: lang,
  });
  if (lang !== "scratch") params.set("form", lang);
  return `https://code.xueersi.com/home/project/detail?${params.toString()}`;
}

/** 把接口返回的两种作品结构（首页/空间列表 与 社区推荐流）归一成同一条记录。 */
export function normalizeWork(raw) {
  if (!raw || typeof raw !== "object") return null;
  const projectId = Number(raw.project?.id ?? raw.project_id ?? raw.id);
  if (!Number.isFinite(projectId) || projectId <= 0) return null;

  const lang = String(raw.lang ?? raw.project?.lang ?? raw.project_type ?? "");
  const work = {
    id: projectId,
    name: String(raw.name ?? raw.title ?? "").trim(),
    description: String(raw.description ?? raw.content ?? "").trim(),
    lang,
    version: String(raw.version ?? ""),
    category: toNum(raw.category ?? raw.category_id),
    tags: String(raw.tags ?? "").trim(),
    user_id: raw.user_id != null ? Number(raw.user_id) : null,
    username: String(raw.username ?? "").trim(),
    user_avatar: String(raw.user_avatar ?? "").trim(),
    thumbnail: String(raw.thumbnail ?? raw.first_frame ?? "").trim(),
    views: toNum(raw.views),
    likes: toNum(raw.likes),
    unlikes: toNum(raw.unlikes),
    comments: toNum(raw.comments),
    favorites: toNum(raw.favorites),
    source_code_views: toNum(raw.source_code_views),
    published_at: String(raw.published_at ?? ""),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
    type: String(raw.type ?? raw.project_type ?? ""),
  };
  work.url = detailUrl(work);
  return work;
}

/** 增量合并：新数据只覆盖非空字段，重跑爬虫不会抹掉已抓到的简介。 */
export function mergeWork(base, incoming) {
  const out = { ...base };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value === "" && out[key]) continue;
    if (typeof value === "number" && value === 0 && typeof out[key] === "number" && out[key] !== 0 && key !== "category") continue;
    out[key] = value;
  }
  return out;
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.renameSync(tmp, file);
}

function addWork(works, raw) {
  const work = normalizeWork(raw);
  if (!work) return;
  works.set(work.id, mergeWork(works.get(work.id) ?? {}, work));
}

/** 首页 / 社区发现阶段：拿到第一批作品和作者。 */
async function fetchSeeds(works, log) {
  const size = () => works.size;

  try {
    for (const raw of (await fetchJson("/api/index/works/latest_popular")) ?? []) addWork(works, raw);
    log(`  首页最新最热 -> 累计 ${size()}`);
  } catch (err) {
    log(`  首页最新最热失败: ${err.message}`);
  }

  try {
    const modules = (await fetchJson("/api/index/works/modules")) ?? [];
    for (const mod of modules) for (const raw of mod.items ?? []) addWork(works, raw);
    log(`  首页栏目 ${modules.map((m) => m.title).join(" / ")} -> 累计 ${size()}`);
  } catch (err) {
    log(`  首页栏目失败: ${err.message}`);
  }

  for (let page = 1; page <= 20; page += 1) {
    try {
      const res = await fetchJson(`/api/community/v4/recommend?page=${page}&per_page=${PER_PAGE}`);
      const items = res?.data ?? [];
      for (const raw of items) addWork(works, raw);
      if (items.length < PER_PAGE) break;
    } catch (err) {
      log(`  社区推荐第 ${page} 页失败: ${err.message}`);
      break;
    }
  }
  log(`  社区推荐流 -> 累计 ${size()}`);
}

/** 沿作者维度做 BFS，把公开作品池尽可能铺开。 */
async function expandByAuthors(works, users, { maxUsers, concurrency }, log) {
  const visitedUsers = new Set();
  const queue = [...new Set([...works.values()].map((w) => w.user_id).filter(Boolean))];

  while (queue.length && visitedUsers.size < maxUsers) {
    const batch = queue.splice(0, Math.min(concurrency * 3, maxUsers - visitedUsers.size));
    if (!batch.length) break;

    const results = await mapLimit(
      batch,
      3,
      async (userId) => {
        if (visitedUsers.has(userId)) return null;
        visitedUsers.add(userId);

        const profile = await fetchJson(`/api/space/profile?user_id=${userId}`).catch(() => null);
        const collected = [];
        for (let page = 1; page <= USER_PAGE_LIMIT; page += 1) {
          const res = await fetchJson(`/api/space/works?user_id=${userId}&page=${page}&per_page=${PER_PAGE}`).catch(() => null);
          if (!res) break;
          const items = res.data ?? [];
          collected.push(...items);
          if (collected.length >= toNum(res.total) || items.length < (toNum(res.per_page) || PER_PAGE)) break;
        }
        return { userId, profile, works: collected };
      },
      { delayMs: 100 },
    );

    for (const entry of results) {
      if (!entry || entry.__error) continue;

      if (entry.profile) {
        users.set(entry.userId, {
          ...(users.get(entry.userId) ?? {}),
          user_id: entry.userId,
          username: entry.profile.realname || users.get(entry.userId)?.username || "",
          avatar: entry.profile.avatar_path || users.get(entry.userId)?.avatar || "",
          signature: entry.profile.signature || users.get(entry.userId)?.signature || "",
          fans: toNum(entry.profile.fans),
          follows: toNum(entry.profile.follows),
        });
      }

      for (const raw of entry.works) {
        addWork(works, raw);
        const work = normalizeWork(raw);
        if (!work) continue;
        if (work.username) {
          users.set(entry.userId, { ...(users.get(entry.userId) ?? { user_id: entry.userId }), username: work.username, avatar: work.user_avatar || users.get(entry.userId)?.avatar || "" });
        }
        if (work.user_id && !visitedUsers.has(work.user_id)) queue.push(work.user_id);
      }
    }

    log(`  已扫描 ${visitedUsers.size} 位作者，作品累计 ${works.size}`);
  }
}

/** 补全简介/标签：流式读取详情头部，拿到需要的字段立刻断开。 */
async function enrichDetails(works, { concurrency, detailLimit }, log) {
  const targets = [...works.values()].filter((w) => !w.description || !w.tags);
  const limited = detailLimit > 0 ? targets.slice(0, detailLimit) : targets;
  if (!limited.length) {
    log("  所有作品都已有简介，跳过");
    return;
  }

  let done = 0;
  let filled = 0;
  await mapLimit(
    limited,
    concurrency,
    async (work) => {
      const head = await fetchProjectHead(work.id).catch(() => null);
      if (head) {
        const merged = mergeWork(work, Object.fromEntries(Object.entries(head).filter(([, v]) => v !== undefined)));
        works.set(work.id, merged);
        if (head.description) filled += 1;
      }
      done += 1;
      if (done % 200 === 0) log(`  详情补全 ${done}/${limited.length}（其中 ${filled} 条含简介）`);
    },
    { delayMs: 40 },
  );
  log(`  详情补全完成 ${done}/${limited.length}（${filled} 条含简介）`);
}

export async function crawl(options = {}) {
  const {
    maxUsers = 500,
    concurrency = 6,
    withDetail = true,
    detailLimit = 0,
    log = (msg) => console.error(msg),
  } = options;

  const works = new Map();
  const users = new Map();

  const existingWorks = readJsonl(WORKS_FILE);
  const existingUsers = readJsonl(USERS_FILE);
  for (const w of existingWorks) works.set(w.id, w);
  for (const u of existingUsers) users.set(u.user_id, u);
  if (works.size) log(`复用已有数据：${works.size} 个作品、${users.size} 位作者\n`);

  log("发现阶段：首页与社区推荐流");
  await fetchSeeds(works, log);

  log(`\n扩展阶段：沿作者维度 BFS（上限 ${maxUsers} 位作者）`);
  await expandByAuthors(works, users, { maxUsers, concurrency }, log);

  if (withDetail) {
    log("\n补全阶段：抓取作品简介（流式截断，只读需要的字段）");
    await enrichDetails(works, { concurrency, detailLimit }, log);
  }

  const workList = [...works.values()].sort((a, b) => a.id - b.id);
  for (const author of users.values()) author.works = workList.filter((w) => w.user_id === author.user_id).length;
  const userList = [...users.values()].sort((a, b) => a.user_id - b.user_id);

  writeJsonl(WORKS_FILE, workList);
  writeJsonl(USERS_FILE, userList);

  const withDesc = workList.filter((w) => w.description).length;
  log(`\n完成：${workList.length} 个作品（${withDesc} 条含简介），${userList.length} 位作者`);
  return { works: workList, users: userList };
}
