/* GitHub Pages 静态版：索引随页面一起下发，检索全部在浏览器内完成。 */

const PER_PAGE = 20;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const state = {
  q: "",
  lang: "",
  sort: "relevance",
  page: 1,
  total: 0,
  mode: "browse",
  works: [],
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

function normalize(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 把查询拆成中文片段与英文/数字词，用作 AND 条件。 */
function parseQuery(raw) {
  const text = normalize(raw);
  const cjk = [];
  const words = [];
  let buffer = "";
  let kind = null;

  const flush = () => {
    if (!buffer) return;
    if (kind === "cjk") cjk.push(buffer);
    else words.push(buffer);
    buffer = "";
  };

  for (const ch of text) {
    const next = CJK_RE.test(ch) ? "cjk" : /[a-z0-9]/.test(ch) ? "word" : null;
    if (next !== kind) {
      flush();
      kind = next;
    }
    if (next) buffer += ch;
  }
  flush();
  return { cjk, words };
}

function prepare(work) {
  const name = normalize(work.n);
  const desc = normalize(work.d);
  const author = normalize(work.u);
  return {
    ...work,
    _name: name,
    _desc: desc,
    _author: author,
    _py: work.py ?? "",
    _ini: work.ini ?? "",
  };
}

function boost(work) {
  return 0.5 * Math.log1p(work.v ?? 0) + 1.2 * Math.log1p(work.k ?? 0);
}

/**
 * 中文按真实子串匹配（与 Node 版的 bigram 短语语义一致），
 * 英文按词前缀匹配。全部条件为 AND。
 */
function match(q) {
  const { cjk, words } = parseQuery(q);
  const hasTerms = cjk.length > 0 || words.length > 0;
  const scored = [];

  for (const work of state.works) {
    if (state.lang && work.l !== state.lang) continue;

    if (!hasTerms) {
      scored.push({ work, score: boost(work) });
      continue;
    }

    let score = 0;
    let ok = true;

    for (const run of cjk) {
      const inName = work._name.includes(run);
      const inDesc = work._desc.includes(run);
      const inAuthor = work._author.includes(run);
      if (!inName && !inDesc && !inAuthor) {
        ok = false;
        break;
      }
      score += (inName ? 120 : 0) + (inDesc ? 25 : 0) + (inAuthor ? 10 : 0);
    }
    if (!ok) continue;

    for (const word of words) {
      const hitName = new RegExp(`(^|[^a-z0-9])${word}`).test(work._name);
      const hitDesc = new RegExp(`(^|[^a-z0-9])${word}`).test(work._desc);
      const hitAuthor = work._author.startsWith(word);
      if (!hitName && !hitDesc && !hitAuthor) {
        ok = false;
        break;
      }
      score += (hitName ? 100 : 0) + (hitDesc ? 20 : 0) + (hitAuthor ? 8 : 0);
    }
    if (!ok) continue;

    scored.push({ work, score: score + boost(work) });
  }

  // 英文拼音回退：主检索命中不足时才启用
  if (scored.length < 5 && /^[a-z]{3,}$/.test(q.toLowerCase())) {
    const py = q.toLowerCase();
    const seen = new Set(scored.map((s) => s.work.id));
    for (const work of state.works) {
      if (seen.has(work.id)) continue;
      if (state.lang && work.l !== state.lang) continue;
      if (work._py.includes(py) || work._ini.includes(py)) {
        scored.push({ work, score: 60 + boost(work), pinyin: true });
      }
    }
  }

  return scored;
}

function queryTokens(q) {
  const { cjk, words } = parseQuery(q);
  return [...new Set([...cjk, ...words])].sort((a, b) => b.length - a.length);
}

function highlight(text, tokens) {
  const safe = escapeHtml(text);
  if (!tokens.length) return safe;
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!pattern) return safe;
  return safe.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
}

function formatCount(n) {
  const num = Number(n) || 0;
  if (num >= 10000) return `${(num / 10000).toFixed(num >= 100000 ? 0 : 1)}w`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function renderCard(work, tokens) {
  const thumb = work.t
    ? `<img src="${escapeHtml(work.t)}" alt="" loading="lazy" referrerpolicy="no-referrer"
         onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">
       <span class="fallback" style="display:none" aria-hidden="true">🧩</span>`
    : `<span class="fallback" aria-hidden="true">🧩</span>`;

  const desc = work.d
    ? `<p class="card-desc">${highlight(work.d, tokens)}</p>`
    : `<p class="card-desc" style="opacity:.55">这个作品还没有写简介</p>`;

  return `
    <article class="card">
      <a class="card-thumb" href="${escapeHtml(work.url)}" target="_blank" rel="noopener noreferrer" aria-hidden="true" tabindex="-1">${thumb}</a>
      <div class="card-body">
        <h3 class="card-title">
          <a href="${escapeHtml(work.url)}" target="_blank" rel="noopener noreferrer">${highlight(work.n || "未命名作品", tokens)}</a>
        </h3>
        ${desc}
        <div class="card-meta">
          <span class="tag-lang" data-lang="${escapeHtml(work.l)}">${escapeHtml(langLabel(work.l))}</span>
          <span class="stat" title="点赞">♥ ${formatCount(work.k)}</span>
          <span class="stat" title="浏览">👁 ${formatCount(work.v)}</span>
          <span class="author" title="${escapeHtml(work.u || "匿名")}">@ ${escapeHtml(work.u || "匿名")}</span>
          ${work.p ? `<span class="stat">${escapeHtml(work.p.slice(0, 10))}</span>` : ""}
          <a class="open" href="${escapeHtml(work.url)}" target="_blank" rel="noopener noreferrer">打开 ↗</a>
        </div>
      </div>
    </article>`;
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

function renderEmpty(title, body, art = "🧩") {
  el.empty.hidden = false;
  el.emptyTitle.textContent = title;
  el.emptyBody.textContent = body;
  el.empty.querySelector(".empty-art").textContent = art;
  el.results.innerHTML = "";
  el.pager.hidden = true;
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.lang) params.set("lang", state.lang);
  if (state.sort !== "relevance") params.set("sort", state.sort);
  if (state.page > 1) params.set("page", String(state.page));
  const qs = params.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function runSearch({ pushHistory = true } = {}) {
  if (pushHistory) syncUrl();
  el.clear.hidden = !state.q;

  if (!state.q && !state.lang) {
    el.status.textContent = "";
    renderEmpty("开始搜索", "索引覆盖 code.xueersi.com 的公开作品，支持中文与拼音。试试「赛车」「贪吃蛇」或「saiche」。");
    return;
  }

  showSkeleton();
  el.status.textContent = "搜索中…";

  const started = performance.now();
  const scored = match(state.q);
  const isPinyin = scored.some((s) => s.pinyin);

  if (state.sort === "relevance") {
    scored.sort((a, b) => b.score - a.score || (b.work.v ?? 0) - (a.work.v ?? 0));
  } else if (state.sort === "likes") {
    scored.sort((a, b) => (b.work.k ?? 0) - (a.work.k ?? 0));
  } else if (state.sort === "newest") {
    scored.sort((a, b) => String(b.work.p ?? "").localeCompare(String(a.work.p ?? "")));
  } else {
    scored.sort((a, b) => (b.work.v ?? 0) - (a.work.v ?? 0));
  }

  state.total = scored.length;
  const pages = Math.max(1, Math.ceil(scored.length / PER_PAGE));
  if (state.page > pages) state.page = pages;

  if (!scored.length) {
    el.status.textContent = "";
    renderEmpty("没有找到相关作品", `换个关键词试试${state.lang ? `（已限定 ${langLabel(state.lang)}）` : ""}。中文可以搜两个字以上，也可以用拼音。`, "🔍");
    return;
  }

  const tokens = state.q ? queryTokens(state.q) : [];
  const slice = scored.slice((state.page - 1) * PER_PAGE, state.page * PER_PAGE);
  el.empty.hidden = true;
  el.results.innerHTML = slice.map(({ work }) => renderCard(work, tokens)).join("");

  const took = Math.round(performance.now() - started);
  el.status.innerHTML = `找到 <b>${scored.length}</b> 个作品${isPinyin ? '<span class="badge">含拼音匹配</span>' : ""}　·　${took}ms`;

  el.pager.hidden = pages <= 1;
  el.pagerInfo.textContent = `第 ${state.page} / ${pages} 页`;
  el.prev.disabled = state.page <= 1;
  el.next.disabled = state.page >= pages;
}

function renderChips() {
  const counts = new Map();
  for (const work of state.works) counts.set(work.l, (counts.get(work.l) ?? 0) + 1);
  const items = [{ value: "", label: "全部", count: state.works.length }];
  for (const [value, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    items.push({ value, label: langLabel(value), count });
  }
  el.chips.innerHTML = items
    .map(
      (b) => `<button type="button" class="chip" data-lang="${escapeHtml(b.value)}"
        aria-pressed="${state.lang === b.value}">${escapeHtml(b.label)}<span class="chip-count">${b.count}</span></button>`,
    )
    .join("");
}

function renderFooter() {
  const views = state.works.reduce((a, w) => a + (w.v ?? 0), 0);
  const authors = new Set(state.works.map((w) => w.uid)).size;
  el.footStats.textContent = `索引：${state.works.length} 个作品 · ${authors} 位作者 · 共 ${formatCount(views)} 次浏览`;
  el.hint.innerHTML = `支持中文与拼音检索 · 已收录 <b>${state.works.length}</b> 个公开作品 · 按 <kbd>/</kbd> 聚焦搜索框`;
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

let debounceTimer;
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
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.page = 1;
    runSearch();
  }, 180);
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

async function boot() {
  readUrl();
  showSkeleton();
  try {
    const res = await fetch("./data/works.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    state.works = raw.map(prepare);
    renderChips();
    renderFooter();
    runSearch({ pushHistory: false });
  } catch (err) {
    renderEmpty("索引加载失败", `无法载入作品数据：${err.message}`, "⚠️");
    el.footStats.textContent = "索引未加载";
  }
}

boot();
