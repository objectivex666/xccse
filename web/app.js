const PER_PAGE = 20;

const state = {
  q: "",
  lang: "",
  sort: "relevance",
  page: 1,
  total: 0,
  mode: "browse",
  loading: false,
  requestId: 0,
};

const el = {
  form: document.getElementById("search-form"),
  input: document.getElementById("q"),
  clear: document.getElementById("clear"),
  chips: document.getElementById("lang-chips"),
  sort: document.getElementById("sort"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  empty: document.getElementById("empty"),
  emptyTitle: document.getElementById("empty-title"),
  emptyBody: document.getElementById("empty-body"),
  pager: document.getElementById("pager"),
  pagerInfo: document.getElementById("pager-info"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  hint: document.getElementById("hero-hint"),
  footStats: document.getElementById("foot-stats"),
};

const LANG_LABELS = { scratch: "图形化 Scratch", python: "Python", cpp: "C++", webpy: "Web Python" };
const langLabel = (code) => LANG_LABELS[code] ?? (code ? code.toUpperCase() : "未标注");

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/** 从查询里抽出可高亮的片段：中文串与英文/数字词。 */
function queryTokens(q) {
  const matches = String(q).match(/[\u3400-\u9dbf\uf900-\ufaff]{1,}|[a-zA-Z0-9_+#]{2,}/g) ?? [];
  return [...new Set(matches.map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length);
}

function highlight(text, tokens) {
  const safe = escapeHtml(text);
  if (!tokens.length) return safe;
  const pattern = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return safe;
  return safe.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
}

function formatCount(n) {
  const num = Number(n) || 0;
  if (num >= 10000) return `${(num / 10000).toFixed(num >= 100000 ? 0 : 1)}w`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function showSkeleton(count = 6) {
  el.results.innerHTML = Array.from({ length: count })
    .map(
      () => `<div class="skeleton"><div class="sk-thumb"></div>
        <div class="sk-lines"><div class="sk-line w60"></div><div class="sk-line w90"></div>
        <div class="sk-line w40"></div></div></div>`,
    )
    .join("");
}

function renderCard(row, tokens) {
  const thumb = row.thumbnail
    ? `<img src="${escapeHtml(row.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer"
         onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">
       <span class="fallback" style="display:none" aria-hidden="true">🧩</span>`
    : `<span class="fallback" aria-hidden="true">🧩</span>`;

  const desc = row.description
    ? `<p class="card-desc">${highlight(row.description.replace(/\s+/g, " "), tokens)}</p>`
    : `<p class="card-desc" style="opacity:.55">这个作品还没有写简介</p>`;

  const published = (row.published_at || "").slice(0, 10);

  return `
    <article class="card">
      <a class="card-thumb" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer" aria-hidden="true" tabindex="-1">${thumb}</a>
      <div class="card-body">
        <h3 class="card-title">
          <a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${highlight(row.name || "未命名作品", tokens)}</a>
        </h3>
        ${desc}
        <div class="card-meta">
          <span class="tag-lang" data-lang="${escapeHtml(row.lang)}">${escapeHtml(langLabel(row.lang))}</span>
          <span class="stat" title="点赞">♥ ${formatCount(row.likes)}</span>
          <span class="stat" title="浏览">👁 ${formatCount(row.views)}</span>
          <span class="author" title="${escapeHtml(row.username || "匿名")}">@ ${escapeHtml(row.username || "匿名")}</span>
          ${published ? `<span class="stat">${escapeHtml(published)}</span>` : ""}
          <a class="open" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">打开 ↗</a>
        </div>
      </div>
    </article>`;
}

function setStatus(text) {
  el.status.innerHTML = text;
}

function renderEmpty(title, body, art = "🧩") {
  el.empty.hidden = false;
  el.emptyTitle.textContent = title;
  el.emptyBody.textContent = body;
  el.empty.querySelector(".empty-art").textContent = art;
  el.results.innerHTML = "";
  el.pager.hidden = true;
}

async function runSearch({ pushHistory = true } = {}) {
  const requestId = ++state.requestId;
  state.loading = true;

  if (pushHistory) syncUrl();
  el.clear.hidden = !state.q;

  if (!state.q && !state.lang) {
    setStatus("");
    renderEmpty("开始搜索", "索引覆盖 code.xueersi.com 的公开作品，支持中文与拼音。试试「赛车」「贪吃蛇」或「saiche」。");
    return;
  }

  showSkeleton();
  setStatus("搜索中…");

  const params = new URLSearchParams({ q: state.q, sort: state.sort, page: String(state.page), limit: String(PER_PAGE) });
  if (state.lang) params.set("lang", state.lang);

  let payload;
  try {
    const res = await fetch(`/api/search?${params}`);
    if (!res.ok) throw new Error(`服务返回 ${res.status}`);
    payload = await res.json();
  } catch (err) {
    if (requestId !== state.requestId) return;
    setStatus("");
    renderEmpty("搜索失败", `无法连接到搜索服务：${err.message}`, "⚠️");
    return;
  }
  if (requestId !== state.requestId) return;

  state.total = payload.total;
  state.mode = payload.mode;

  if (!payload.rows.length) {
    const langNote = state.lang ? `（已限定 ${langLabel(state.lang)}）` : "";
    setStatus("");
    renderEmpty("没有找到相关作品", `换个关键词试试${langNote}。中文可以搜两个字以上，也可以用拼音。`, "🔍");
    return;
  }

  const tokens = state.mode.startsWith("browse") ? [] : queryTokens(state.q);
  el.empty.hidden = true;
  el.results.innerHTML = payload.rows.map((row) => renderCard(row, tokens)).join("");

  const badge =
    state.mode.startsWith("pinyin") ? '<span class="badge">拼音匹配</span>' : state.mode.startsWith("mixed") ? '<span class="badge">含拼音匹配</span>' : "";
  const totalShown = Math.min(payload.total, PER_PAGE * 40);
  setStatus(`找到 <b>${payload.total}</b> 个作品${badge}　·　${payload.tookMs}ms${payload.total >= 800 ? "（结果已截断）" : ""}`);

  const pages = Math.ceil(Math.min(payload.total, totalShown) / PER_PAGE);
  el.pager.hidden = pages <= 1;
  el.pagerInfo.textContent = `第 ${state.page} / ${pages} 页`;
  el.prev.disabled = state.page <= 1;
  el.next.disabled = state.page >= pages;
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.lang) params.set("lang", state.lang);
  if (state.sort !== "relevance") params.set("sort", state.sort);
  if (state.page > 1) params.set("page", String(state.page));
  const qs = params.toString();
  history.replaceState(null, "", qs ? `/?${qs}` : "/");
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.q = params.get("q") ?? "";
  state.lang = params.get("lang") ?? "";
  state.sort = params.get("sort") ?? "relevance";
  state.page = Math.max(1, Number(params.get("page")) || 1);
  el.input.value = state.q;
  el.sort.value = state.sort;
}

async function loadFacets() {
  try {
    const res = await fetch("/api/facets");
    const data = await res.json();
    const langs = data.langs ?? [];
    const buttons = [{ value: "", label: "全部" }, ...langs.map((l) => ({ value: l.lang, label: langLabel(l.lang), count: l.count }))];
    el.chips.innerHTML = buttons
      .map(
        (b) => `<button type="button" class="chip" data-lang="${escapeHtml(b.value)}"
          aria-pressed="${state.lang === b.value}">${escapeHtml(b.label)}${
            b.count != null ? `<span class="chip-count">${b.count}</span>` : ""
          }</button>`,
      )
      .join("");
  } catch {
    el.chips.innerHTML = "";
  }
}

async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const s = await res.json();
    el.footStats.textContent = `索引：${s.works} 个作品 · ${s.authors} 位作者 · 共 ${formatCount(s.views)} 次浏览`;
    el.hint.innerHTML = `支持中文与拼音检索 · 已收录 <b>${s.works}</b> 个公开作品 · 按 <kbd>/</kbd> 聚焦搜索框`;
  } catch {
    el.footStats.textContent = "索引未就绪，请先运行 npm run crawl && npm run index";
  }
}

/* ---------- 事件 ---------- */
let debounceTimer;
const debouncedSearch = () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.page = 1;
    runSearch();
  }, 200);
};

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(debounceTimer);
  state.q = el.input.value.trim();
  state.page = 1;
  runSearch();
});

el.input.addEventListener("input", () => {
  state.q = el.input.value.trim();
  el.clear.hidden = !state.q;
  debouncedSearch();
});

el.clear.addEventListener("click", () => {
  el.input.value = "";
  state.q = "";
  state.page = 1;
  el.input.focus();
  runSearch();
});

el.chips.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.lang = chip.dataset.lang;
  state.page = 1;
  [...el.chips.children].forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
  runSearch();
});

el.sort.addEventListener("change", () => {
  state.sort = el.sort.value;
  state.page = 1;
  runSearch();
});

el.prev.addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    runSearch();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

el.next.addEventListener("click", () => {
  state.page += 1;
  runSearch();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== el.input) {
    e.preventDefault();
    el.input.focus();
    el.input.select();
  } else if (e.key === "Escape" && document.activeElement === el.input) {
    el.input.value = "";
    state.q = "";
    runSearch();
  }
});

/* ---------- 启动 ---------- */
readUrl();
loadFacets();
loadStats();
runSearch({ pushHistory: false });
