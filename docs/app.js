/* Wallpapers gallery v2 — touch-first, tag search, series/character filters.
 *
 * Changes vs v1:
 *   - Chunked rendering (rAF batches) so 5k+ cards never block the UI thread
 *     (fixes "unresponsive" feel on iPhone).
 *   - Debounced search that matches name, category, tags, series and
 *     characters, with accent-insensitive normalization.
 *   - New Series dropdown + Sort dropdown + Clear filters.
 *   - Long-press select hardened for iOS (callout suppression + click guard).
 *   - Hover effects only on hover-capable devices.
 *   - Lightbox prev/next (buttons, arrow keys, swipe).
 *
 * Selection:
 *   - Desktop: right-click on a card, or the check button on the card.
 *   - Touch: tap the check button, or long-press (400ms) a card.
 *   - Plain click (or tap without holding) opens the preview.
 */
"use strict";

// If anything unexpected happens, surface it instead of hanging forever.
window.addEventListener("error", (e) => {
  const s = $("stats");
  if (s && s.textContent && s.textContent.includes("Loading catalog")) {
    s.textContent = "Error al cargar: " + (e.message || "algo falló — recarga la página");
  }
});

const REPO = "leriart/Wallpapers";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

let DATA = null;
let selected = new Set();          // "cat/name" — files queued for download
let favorites = new Set();         // "cat/name" — bookmarked wallpapers (localStorage)
let recent = [];                   // [key, key, ...] — recently viewed (localStorage, capped)
let viewList = [];                 // current filtered+sorted [{cat,file}]
let viewIndex = -1;                // lightbox position in viewList
let renderToken = 0;               // invalidates in-flight chunked renders
let lastLongPressAt = 0;           // iOS: suppress click after long-press
let lbMuted = true;                // lightbox videos muted by default (autoplay rules)
let lbLoop = true;                 // lightbox videos loop by default

// Touch devices: disable hover-play of videos (no hover state)
const IS_TOUCH = window.matchMedia("(hover: none)").matches || ("ontouchstart" in window);
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const CHUNK = IS_TOUCH ? 100 : 140; // cards per animation frame
const MAX_ANIMATED = 60;            // only first N cards get entrance animation

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const searchEl = $("search");
const categoryEl = $("category");
const kindEl = $("kind");
const aspectEl = $("aspect");
const seriesEl = $("series");
const sortEl = $("sort");
const filterToggle = $("filter-toggle");
const filterPanel = $("filter-panel");
const filterBadge = $("filter-badge");
const clearBtn = $("clear-filters");
const nsfwToggle = $("nsfw-toggle");

// NSFW content is hidden by default; opt-in via the filters panel.
// Preference persists in localStorage.
let showNSFW = false;
try { showNSFW = localStorage.getItem("wallpapers:nsfw") === "1"; } catch (_) {}
if (nsfwToggle) nsfwToggle.checked = showNSFW;
const wire = (el, evt, fn) => { if (el) el.addEventListener(evt, fn); };

// Screen-reader summary: updated once per render (NOT per chunk, which
// made iOS Safari recompute the a11y tree ~60x per render and feel laggy).
const liveRegion = $("live-region");

/* ---------- helpers ---------- */

// resolve the repo-relative path of a file (videos live in <stem>/ subdirs)
function fileRel(cat, file) {
  return file.path || `${cat}/${file.name}`;
}

function fileURL(cat, file) {
  return `${RAW}/${fileRel(cat, file)}`.replace(/([^:])\/+/g, "$1/");
}

function setProgress(loaded, total) {
  const bar = $("progress-bar");
  if (!bar) return;
  if (!total) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.firstElementChild.style.width = Math.min(100, (loaded / total) * 100) + "%";
}

function hideProgress() {
  const bar = $("progress-bar");
  if (bar) bar.classList.add("hidden");
}

// normalize() + NFD is the single most expensive op on load: it ran once
// per file (~8k × ~300 chars) and froze the main thread for seconds on
// iPhone. Cache results and skip the NFD pass for pure-ASCII strings (the
// vast majority of tags/names).
const normCache = new Map();
function norm(s) {
  let v = normCache.get(s);
  if (v !== undefined) return v;
  v = String(s).toLowerCase();
  if (/[^\x00-\x7F]/.test(v)) v = v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (normCache.size > 200000) normCache.clear();
  normCache.set(s, v);
  return v;
}

function fmtSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function showSkeleton(count) {
  grid.innerHTML = Array.from({ length: count }, () => '<div class="skel"></div>').join("");
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/* ---------- Filters panel ---------- */

function filterCount() {
  let n = 0;
  if (searchEl.value.trim()) n++;
  if (categoryEl.value !== "all") n++;
  if (kindEl.value !== "all") n++;
  if (seriesEl.value !== "all") n++;
  if (aspectEl && aspectEl.value !== "all") n++;
  if (isFavOnly()) n++;
  return n;
}

function updateFilterBadge() {
  const n = filterCount();
  filterBadge.textContent = n;
  filterBadge.classList.toggle("hidden", n === 0);
}

wire(nsfwToggle, "change", () => {
  showNSFW = nsfwToggle.checked;
  try { localStorage.setItem("wallpapers:nsfw", showNSFW ? "1" : "0"); } catch (_) {}
  if (!showNSFW) closeLightbox();
  refreshStats();
  buildCategoryDropdown();
  render();
  toast(showNSFW ? "Showing NSFW wallpapers" : "NSFW wallpapers hidden");
});

function catalogCounts() {
  let total = 0, videos = 0;
  const cats = new Set();
  for (const c of DATA.categories) {
    for (const f of c.files) {
      if (!showNSFW && f.nsfw) continue;
      total++;
      cats.add(c.name);
      if (f.kind === "video") videos++;
    }
  }
  return { total, videos, cats: cats.size };
}

function buildCategoryDropdown() {
  categoryEl.innerHTML = '<option value="all">All categories</option>' +
    DATA.categories
      .filter((c) => showNSFW || c.name !== "NSFW")
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)} &middot; ${c.files.length}</option>`).join("");
}

function buildSeriesDropdown() {
  const seriesCount = new Map();
  for (const c of DATA.categories) {
    for (const f of c.files) {
      if (!showNSFW && f.nsfw) continue;
      for (const s of (f.tags && f.tags.series) || []) seriesCount.set(s, (seriesCount.get(s) || 0) + 1);
    }
  }
  const cur = seriesEl.value;
  seriesEl.innerHTML = '<option value="all">All series</option>' +
    [...seriesCount.entries()].sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `<option value="${esc(s)}">${esc(s)} &middot; ${n}</option>`).join("");
  if (cur && seriesCount.has(cur)) seriesEl.value = cur;
}

function refreshStats() {
  const { total, videos, cats } = catalogCounts();
  $("stats").textContent =
    `${total.toLocaleString()} ${plural(total, "wallpaper", "wallpapers")} · ` +
    `${cats} ${plural(cats, "category", "categories")} · ` +
    `${videos} ${plural(videos, "video", "videos")}`;
  buildSeriesDropdown();
  updateFilterBadge();
}

function toggleFilters(force) {
  const willShow = force !== undefined ? force : filterPanel.classList.contains("hidden");
  filterPanel.classList.toggle("hidden", !willShow);
  filterToggle.setAttribute("aria-expanded", String(willShow));
  filterToggle.classList.toggle("active", willShow);
}

wire(filterToggle, "click", (e) => {
  e.stopPropagation();
  toggleFilters();
});

// Close panel on outside click (desktop only; on touch it stays open)
document.addEventListener("click", (e) => {
  if (!IS_TOUCH && !filterPanel.contains(e.target) && e.target !== filterToggle && !filterToggle.contains(e.target)) {
    if (!filterPanel.classList.contains("hidden")) toggleFilters(false);
  }
});

wire(filterPanel, "click", (e) => e.stopPropagation());

function clearFilters() {
  searchEl.value = "";
  categoryEl.value = "all";
  kindEl.value = "all";
  seriesEl.value = "all";
  if (aspectEl) aspectEl.value = "all";
  sortEl.value = "default";
  updateFilterBadge();
  render();
}
wire(clearBtn, "click", clearFilters);

/* ---------- Load ---------- */

async function loadIndex() {
  // 1) cached catalog → render instantly (no "Loading catalog…" wait)
  let cached = null;
  try {
    const raw = localStorage.getItem("catalog:v2");
    if (raw) cached = JSON.parse(raw);
  } catch (_) {}
  if (cached && cached.categories) {
    DATA = cached;
    afterLoad();
  } else {
    showSkeleton(18);
  }

  // 2) fresh catalog in the background, then re-render + refresh cache
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000); // never hang forever
    const res = await fetch("index.json", { cache: "no-cache", signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error("index.json HTTP " + res.status);
    DATA = await res.json();
    try { localStorage.setItem("catalog:v2", JSON.stringify(DATA)); } catch (_) {}
    afterLoad();
  } catch (err) {
    if (!cached) {
      grid.innerHTML = `<div class="empty">
          <p>Failed to load catalog: ${esc(String(err))}</p>
          <button class="btn ghost" id="retry-load">Retry</button>
        </div>`;
      const b = $("retry-load");
      if (b) b.addEventListener("click", () => { loadIndex(); });
    }
  }
}

function afterLoad() {
  const cats = DATA.categories;

  // Precompute a normalized search haystack per file (fast: ASCII fast-path)
  for (const c of cats) {
    for (const f of c.files) {
      const t = f.tags || {};
      f._search = norm(
        [c.name, f.name, t.series || [], t.characters || [], t.tags || []].flat().join(" ")
      );
    }
  }

  refreshStats();
  buildCategoryDropdown();
  render();
}

/* ---------- Filtering + sorting ---------- */

function visibleFiles() {
  const q = norm(searchEl.value.trim());
  const qTokens = q ? q.split(/\s+/).filter(Boolean) : [];
  const cat = categoryEl.value;
  const kind = kindEl.value;
  const series = seriesEl.value;
  const aspect = aspectEl ? aspectEl.value : "all";
  const favOnly = isFavOnly();
  const out = [];
  for (const c of DATA.categories) {
    if (cat !== "all" && c.name !== cat) continue;
    for (const f of c.files) {
      const key = `${c.name}/${f.name}`;
      if (kind !== "all" && f.kind !== kind) continue;
      if (!showNSFW && f.nsfw) continue;
      if (aspect !== "all" && f.aspect !== aspect) continue;
      if (favOnly && !favorites.has(key)) continue;
      if (series !== "all" && !((f.tags && f.tags.series) || []).includes(series)) continue;
      if (qTokens.length) {
        if (!qTokens.every((tok) => f._search.includes(tok))) continue;
      }
      out.push({ cat: c.name, file: f });
    }
  }
  const sort = sortEl.value;
  if (sort === "name") out.sort((a, b) => a.file.name.localeCompare(b.file.name));
  else if (sort === "size-desc") out.sort((a, b) => b.file.size - a.file.size);
  else if (sort === "size-asc") out.sort((a, b) => a.file.size - b.file.size);
  else if (sort === "random") {
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
  } else if (sort === "favorites") {
    // bubble favorited items to the top while keeping stable order
    out.sort((a, b) => {
      const af = favorites.has(`${a.cat}/${a.file.name}`) ? 0 : 1;
      const bf = favorites.has(`${b.cat}/${b.file.name}`) ? 0 : 1;
      return af - bf;
    });
  }
  return out;
}

/* Chip click → set series/character filter; clicking again clears it. */
function applyChipFilter(kind, value) {
  const dropdown = kind === "series" ? seriesEl : null;
  if (!dropdown) return;
  if (dropdown.value === value) {
    dropdown.value = "all";
  } else {
    dropdown.value = value;
  }
  // ensure filter panel is open so the user sees the change
  toggleFilters(true);
  render();
  toast(dropdown.value === "all" ? `Cleared ${kind} filter` : `Filtering by ${kind}: ${value}`);
}

/* ---------- Selection ---------- */

function toggleSelect(cat, file) {
  const key = `${cat}/${file.name}`;
  if (selected.has(key)) selected.delete(key); else selected.add(key);
  const card = grid.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
  if (card) {
    card.classList.toggle("selected", selected.has(key));
    const btn = card.querySelector(".select-btn");
    if (btn) {
      const isSel = selected.has(key);
      btn.setAttribute("aria-pressed", String(isSel));
      btn.innerHTML = isSel ? '<span class="check">✓</span>' : '<span class="plus">+</span>';
    }
  }
  updateCount();
}

function clearSelection() {
  selected.clear();
  render();
}

/* ---------- Favorites (bookmarks, separate from download selection) ---------- */

function loadFavorites() {
  try {
    const raw = localStorage.getItem("wallpapers:favorites");
    if (raw) favorites = new Set(JSON.parse(raw));
  } catch (_) {}
}

function saveFavorites() {
  try { localStorage.setItem("wallpapers:favorites", JSON.stringify([...favorites])); } catch (_) {}
}

function toggleFavorite(cat, file) {
  const key = `${cat}/${file.name}`;
  if (favorites.has(key)) favorites.delete(key); else favorites.add(key);
  saveFavorites();
  // update the card (if visible) and the lightbox button
  const card = grid.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
  if (card) {
    card.classList.toggle("fav", favorites.has(key));
    const b = card.querySelector(".fav-btn");
    if (b) {
      b.classList.toggle("active", favorites.has(key));
      b.setAttribute("aria-pressed", String(favorites.has(key)));
      b.title = favorites.has(key) ? "Remove from favorites" : "Add to favorites";
    }
  }
  syncLightboxFav();
  updateFavCount();
  renderFavoritesRow();
  // if we're filtering "favorites only", re-render the grid so the change is visible
  if (isFavOnly()) render();
}

function updateFavCount() {
  const c = $("fav-count");
  if (c) c.textContent = favorites.size;
  const b = $("favorites-toggle");
  if (b) b.classList.toggle("active", favorites.size > 0);
}

function isFavOnly() {
  return $("fav-only") && $("fav-only").checked;
}

function syncLightboxFav() {
  const b = $("lb-fav");
  if (!b) return;
  const sel = b._sel || "";
  const on = favorites.has(sel);
  b.classList.toggle("active", on);
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Remove from favorites" : "Add to favorites";
}

function clearFavorites() {
  if (!favorites.size) return;
  favorites.clear();
  saveFavorites();
  render();
}

/* ---------- Recently viewed ---------- */

const RECENT_MAX = 24;
function loadRecent() {
  try {
    const raw = localStorage.getItem("wallpapers:recent");
    if (raw) recent = JSON.parse(raw).filter(Boolean);
  } catch (_) {}
}

function saveRecent() {
  try { localStorage.setItem("wallpapers:recent", JSON.stringify(recent)); } catch (_) {}
}

function pushRecent(cat, file) {
  const key = `${cat}/${file.name}`;
  recent = [key, ...recent.filter((k) => k !== key)].slice(0, RECENT_MAX);
  saveRecent();
  renderRecentRow();
}

function renderRecentRow() {
  const wrap = $("recent-row");
  if (!wrap) return;
  if (!recent.length) { wrap.classList.add("hidden"); wrap.innerHTML = ""; return; }
  const cells = [];
  for (const key of recent.slice(0, 12)) {
    const idx = key.indexOf("/");
    const cat = key.slice(0, idx);
    const name = key.slice(idx + 1);
    const c = DATA && DATA.categories.find((x) => x.name === cat);
    const f = c && c.files.find((x) => x.name === name);
    if (!f) continue;
    cells.push(`<button class="recent-tile" data-key="${esc(key)}" title="${esc(name)}">
      <img loading="lazy" src="${esc(f.thumb)}" alt="">
    </button>`);
  }
  if (!cells.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  wrap.innerHTML = `<div class="recent-head">
      <span>Recently viewed</span>
      <button class="btn ghost" id="recent-clear" type="button">Clear</button>
    </div><div class="recent-tiles">${cells.join("")}</div>`;
  wrap.querySelectorAll(".recent-tile").forEach((b) => {
    b.addEventListener("click", () => {
      const key = b.dataset.key;
      const idx = key.indexOf("/");
      const cat = key.slice(0, idx);
      const name = key.slice(idx + 1);
      const c = DATA.categories.find((x) => x.name === cat);
      const f = c && c.files.find((x) => x.name === name);
      if (f) openLightbox(cat, f, -1);
    });
  });
  const cl = $("recent-clear");
  if (cl) cl.addEventListener("click", () => { recent = []; saveRecent(); renderRecentRow(); });
}

function renderFavoritesRow() {
  const wrap = $("favorites-row");
  if (!wrap || !DATA) return;
  if (!favorites.size) { wrap.classList.add("hidden"); wrap.innerHTML = ""; return; }
  const cells = [];
  for (const key of favorites) {
    const idx = key.indexOf("/");
    const cat = key.slice(0, idx);
    const name = key.slice(idx + 1);
    const c = DATA.categories.find((x) => x.name === cat);
    const f = c && c.files.find((x) => x.name === name);
    if (!f) continue;
    cells.push(`<button class="recent-tile fav-tile" data-key="${esc(key)}" title="${esc(name)}">
      <img loading="lazy" src="${esc(f.thumb)}" alt="">
      <span class="fav-mark" aria-hidden="true">★</span>
    </button>`);
  }
  if (!cells.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  wrap.innerHTML = `<div class="recent-head">
      <span>Favorites (${favorites.size})</span>
      <button class="btn ghost" id="favorites-clear" type="button">Clear all</button>
    </div><div class="recent-tiles">${cells.join("")}</div>`;
  wrap.querySelectorAll(".recent-tile").forEach((b) => {
    b.addEventListener("click", () => {
      const key = b.dataset.key;
      const idx = key.indexOf("/");
      const cat = key.slice(0, idx);
      const name = key.slice(idx + 1);
      const c = DATA.categories.find((x) => x.name === cat);
      const f = c && c.files.find((x) => x.name === name);
      if (f) openLightbox(cat, f, -1);
    });
  });
  const cl = $("favorites-clear");
  if (cl) cl.addEventListener("click", clearFavorites);
}

/* ---------- Card interaction ---------- */

function attachCardEvents(card, cat, file) {
  const selectBtn = card.querySelector(".select-btn");
  selectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleSelect(cat, file);
  });

  // Plain click / tap (no hold) → preview. Guard against the click that iOS
  // can still fire after a long-press even with preventDefault on touchend.
  card.addEventListener("click", (e) => {
    if (e.target.closest(".select-btn")) return;
    if (e.target.closest(".fav-btn")) return;
    if (e.target.closest(".chip")) return;
    if (Date.now() - lastLongPressAt < 700) return;
    const idx = viewList.findIndex((v) => v.cat === cat && v.file === file);
    openLightbox(cat, file, idx >= 0 ? idx : 0);
  });

  // Desktop: right-click toggles selection (unless on a sub-button)
  card.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".fav-btn") || e.target.closest(".chip")) return;
    e.preventDefault();
    toggleSelect(cat, file);
  });

  // Touch: long-press (400ms) toggles selection; scroll cancels it.
  if (IS_TOUCH) {
    let pressTimer = null;
    let startX = 0, startY = 0;
    let longPressFired = false;

    card.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      longPressFired = false;
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        longPressFired = true;
        lastLongPressAt = Date.now();
        toggleSelect(cat, file);
        if (navigator.vibrate) { try { navigator.vibrate(30); } catch (_) {} }
      }, 400);
    }, { passive: true });

    card.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      // movement > 12px = user is scrolling → cancel long-press
      if (Math.abs(t.clientX - startX) > 12 || Math.abs(t.clientY - startY) > 12) {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      }
    }, { passive: true });

    const cancelPress = (e) => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      // Suppress the synthetic click that follows a long-press so the
      // lightbox does not open right after selecting.
      if (longPressFired) {
        e.preventDefault();
        longPressFired = false;
      }
    };
    card.addEventListener("touchend", cancelPress, { passive: false });
    card.addEventListener("touchcancel", cancelPress, { passive: false });
  }
}

/* ---------- Render (chunked) ---------- */

function render() {
  const token = ++renderToken;
  const items = visibleFiles();
  viewList = items;
  updateCount();
  if (liveRegion) liveRegion.textContent =
    `Showing ${items.length.toLocaleString()} wallpapers`;

  if (!items.length) {
    const msg = isFavOnly() && !favorites.size
      ? `<p>You haven't favorited any wallpapers yet.</p>
         <p class="empty-hint">Tap the <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" style="vertical-align:-2px"><path d="M8 1.5l2.06 4.18 4.61.67-3.34 3.25.79 4.6L8 11.99l-4.12 2.17.79-4.6L1.33 6.35l4.61-.67L8 1.5z"/></svg> on any wallpaper to save it here.</p>`
      : `<p>No wallpapers match your filters.</p>`;
    grid.innerHTML = `<div class="empty">${msg}
        <button class="btn ghost" id="empty-clear">Clear filters</button>
      </div>`;
    const b = $("empty-clear");
    if (b) b.addEventListener("click", clearFilters);
    return;
  }

  grid.innerHTML = "";
  let i = 0;

  const build = (idx) => {
    if (token !== renderToken) return; // a newer render superseded us
    const frag = document.createDocumentFragment();
    const end = Math.min(idx + CHUNK, items.length);
    for (; idx < end; idx++) {
      const { cat, file } = items[idx];
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.key = `${cat}/${file.name}`;
      if (idx < MAX_ANIMATED) {
        card.style.animationDelay = `${Math.min(idx, 24) * 18}ms`;
      } else {
        card.style.animation = "none";
      }
      const isSel = selected.has(card.dataset.key);
      if (isSel) card.classList.add("selected");

      const media = file.kind === "video"
        ? `<video src="${esc(fileURL(cat, file))}" poster="${esc(file.thumb)}" preload="none" muted loop playsinline></video>`
        : `<img loading="lazy" src="${esc(file.thumb)}" alt="${esc(file.name)}">`;

      const flag = (file.kind === "video" ? '<span class="kind-flag">video</span>' : "") +
        (file.nsfw ? '<span class="nsfw-flag">NSFW</span>' : "");

      const t = file.tags || {};
      const chips = [];
      for (const s of t.series || []) chips.push(`<button class="chip chip-series" data-filter="series" data-value="${esc(s)}" type="button">${esc(s)}</button>`);
      for (const ch of (t.characters || []).slice(0, 2)) chips.push(`<button class="chip" data-filter="character" data-value="${esc(ch)}" type="button">${esc(ch)}</button>`);
      const chipRow = chips.length ? `<div class="chips">${chips.join("")}</div>` : "";

      const key = `${cat}/${file.name}`;
      const isFav = favorites.has(key);

      card.innerHTML = media +
        flag +
        (isFav ? '<span class="fav-flag" aria-hidden="true">★</span>' : "") +
        `<div class="meta">` +
          `<span class="fname" title="${esc(file.name)}">${esc(file.name)}</span>` +
          `<span class="meta-right">` +
            `<span class="fsize">${fmtSize(file.size)}</span>` +
            `<button class="fav-btn ${isFav ? "active" : ""}" type="button" aria-pressed="${isFav}" aria-label="Favorite ${esc(file.name)}" title="${isFav ? "Remove from favorites" : "Add to favorites"}">` +
              `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5l2.06 4.18 4.61.67-3.34 3.25.79 4.6L8 11.99l-4.12 2.17.79-4.6L1.33 6.35l4.61-.67L8 1.5z"/></svg>` +
            `</button>` +
            `<button class="select-btn" type="button" aria-pressed="${isSel}" aria-label="Select ${esc(file.name)}">` +
              (isSel ? '<span class="check">✓</span>' : '<span class="plus">+</span>') +
            `</button>` +
          `</span>` +
        `</div>` + chipRow;

      if (isFav) card.classList.add("fav");

      const favBtn = card.querySelector(".fav-btn");
      if (favBtn) {
        favBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          toggleFavorite(cat, file);
        });
      }
      card.querySelectorAll(".chip[data-filter]").forEach((b) => {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          applyChipFilter(b.dataset.filter, b.dataset.value);
        });
      });

      // hover play/pause for videos (desktop only)
      if (file.kind === "video" && !IS_TOUCH) {
        const v = card.querySelector("video");
        card.addEventListener("mouseenter", () => { try { v.play(); } catch (_) {} });
        card.addEventListener("mouseleave", () => { v.pause(); v.currentTime = 0; });
      }

      attachCardEvents(card, cat, file);
      frag.appendChild(card);
    }
    grid.appendChild(frag); // paint this batch now (progressive)
    if (end < items.length && token === renderToken) {
      requestAnimationFrame(() => build(end));
    }
  };
  build(0);
}

function updateCount() {
  $("sel-count").textContent = selected.size;
  updateFilterBadge();
  const items = viewList.length;
  const base = $("stats").textContent.split(" · showing")[0];
  const n = filterCount();
  $("stats").textContent = base + (n > 0 ? ` · showing ${items}` : "");
}

/* ---------- Download ---------- */

// iOS Safari ignores the `download` attribute on cross-origin URLs, so we
// open blob URLs in a new tab there (Safari shows the viewer + save/share).
// Android/desktop (Chrome & Firefox): blob URL + download attribute works.
const blobCache = new Map(); // key -> { url, blob }

async function getBlobUrl(cat, file) {
  const key = `${cat}/${file.name}`;
  const cached = blobCache.get(key);
  if (cached) return cached;
  const url = fileURL(cat, file);
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  const obj = { url: URL.createObjectURL(blob), blob };
  blobCache.set(key, obj);
  return obj;
}

function triggerBlobDownload(obj, filename) {
  const a = document.createElement("a");
  a.href = obj.url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// iOS: native share sheet is the only reliable save path. Needs a user
// gesture, so we pre-fetch blobs (e.g. when the lightbox opens) and share
// with File objects within the tap.
async function shareOnIOS(items) {
  if (!navigator.share || !navigator.canShare) return false;
  const files = items.map(({ cat, file, obj }) =>
    new File([obj.blob], file.name, { type: obj.blob.type || "application/octet-stream" })
  );
  const shareData = { files };
  if (!navigator.canShare(shareData)) return false;
  try {
    await navigator.share(shareData);
    return true;
  } catch (err) {
    if (err && err.name === "AbortError") return true; // user dismissed = fine
    console.error(err);
    return false;
  }
}

async function downloadFile(cat, file) {
  try {
    const obj = await getBlobUrl(cat, file);
    if (IS_IOS) {
      const shared = await shareOnIOS([{ cat, file, obj }]);
      if (!shared) openOnIOS(obj); // fallback: open blob in new tab
      return true;
    }
    triggerBlobDownload(obj, file.name);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function openOnIOS(obj) {
  const win = window.open(obj.url, "_blank");
  if (!win) {
    const a = document.createElement("a");
    a.href = obj.url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// Pre-fetch a single file's blob (no gesture needed) so a later tap can
// share/download it synchronously — required for iOS.
function prefetchBlob(cat, file) {
  getBlobUrl(cat, file).catch(() => {});
}

async function downloadSelected() {
  const keys = [...selected];
  if (!keys.length) return toast("Nothing selected. Tap the + on a wallpaper to select it.");
  toast(`Preparing ${keys.length} ${plural(keys.length, "file", "files")}…`);

  const jobs = [];
  for (const key of keys) {
    const idx = key.indexOf("/");
    const cat = key.slice(0, idx);
    const name = key.slice(idx + 1);
    const c = DATA.categories.find((x) => x.name === cat);
    const f = c && c.files.find((x) => x.name === name);
    if (f) jobs.push({ cat, file: f });
  }

  if (IS_IOS) {
    // Fetch all blobs first, then share the whole set in ONE gesture.
    const prepared = [];
    for (const { cat, file } of jobs) {
      try {
        const obj = await getBlobUrl(cat, file);
        prepared.push({ cat, file, obj });
      } catch (_) { /* skip */ }
    }
    if (!prepared.length) return toast("Could not fetch the selected files.");
    const shared = await shareOnIOS(prepared);
    toast(shared
      ? `Share sheet opened with ${prepared.length} ${plural(prepared.length, "file", "files")}.`
      : "Sharing not available — open each file from its preview.");
    return;
  }

  let ok = 0;
  for (const { cat, file } of jobs) {
    try {
      const obj = await getBlobUrl(cat, file);
      triggerBlobDownload(obj, file.name);
      ok++;
      await new Promise((r) => setTimeout(r, 350));
    } catch (_) { /* keep going */ }
  }
  toast(`Started ${ok} of ${jobs.length} ${plural(jobs.length, "download", "downloads")}.`);
}

/* ---------- Lightbox ---------- */

function openLightbox(cat, file, idx) {
  const url = fileURL(cat, file);
  const key = `${cat}/${file.name}`;
  viewIndex = idx >= 0 ? idx : viewList.findIndex((v) => v.cat === cat && v.file === file);

  const isVideo = file.kind === "video";
  $("lb-media").innerHTML = isVideo
    ? `<video id="lb-video" src="${esc(url)}" poster="${esc(file.thumb || "")}" controls autoplay ${lbMuted ? "muted" : ""} ${lbLoop ? "loop" : ""} playsinline></video>`
    : `<img src="${esc(url)}" alt="${esc(file.name)}">`;

  const t = file.tags || {};
  const tagStr = [t.series, t.characters, t.tags].flat().filter(Boolean).map(esc).join(" · ");
  $("lb-info").innerHTML =
    `<strong>${esc(file.name)}</strong> &middot; ${fmtSize(file.size)} &middot; ${esc(cat)}` +
    (tagStr ? `<br><span class="lb-tags">${tagStr}</span>` : "");

  // video-only controls (mute / loop)
  $("lb-video-controls").classList.toggle("hidden", !isVideo);
  if (isVideo) {
    const muteBtn = $("lb-mute");
    muteBtn.classList.toggle("active", !lbMuted);
    muteBtn.setAttribute("aria-pressed", String(!lbMuted));
    muteBtn.title = lbMuted ? "Unmute (m)" : "Mute (m)";
    muteBtn.querySelector(".lb-mute-on").classList.toggle("hidden", lbMuted);
    muteBtn.querySelector(".lb-mute-off").classList.toggle("hidden", !lbMuted);
    const loopBtn = $("lb-loop");
    loopBtn.classList.toggle("active", lbLoop);
    loopBtn.setAttribute("aria-pressed", String(lbLoop));
    loopBtn.title = lbLoop ? "Disable loop (l)" : "Enable loop (l)";
  }

  // Pre-fetch the blob so Download can act within the user gesture (iOS).
  prefetchBlob(cat, file);
  $("lb-download").href = url;
  $("lb-download").onclick = (e) => {
    e.preventDefault();
    downloadFile(cat, file);
  };
  const isSel = selected.has(key);
  $("lb-select").textContent = isSel ? "Deselect" : "Select";
  $("lb-select").classList.toggle("active", isSel);
  $("lb-select").onclick = () => {
    toggleSelect(cat, file);
    const nowSel = selected.has(key);
    $("lb-select").textContent = nowSel ? "Deselect" : "Select";
    $("lb-select").classList.toggle("active", nowSel);
  };

  // favorite button (lightbox)
  const lbFav = $("lb-fav");
  lbFav._sel = key;
  lbFav.title = favorites.has(key) ? "Remove from favorites" : "Add to favorites";
  lbFav.classList.toggle("active", favorites.has(key));
  lbFav.setAttribute("aria-pressed", String(favorites.has(key)));
  lbFav.onclick = () => toggleFavorite(cat, file);

  // prev/next
  $("lb-prev").classList.toggle("hidden", viewList.length < 2 || viewIndex <= 0);
  $("lb-next").classList.toggle("hidden", viewList.length < 2 || viewIndex >= viewList.length - 1);
  $("lb-count").textContent = viewList.length ? `${viewIndex + 1} / ${viewList.length}` : "";

  $("lightbox").classList.remove("hidden");
  pushRecent(cat, file);
}

function lbStep(dir) {
  if (!viewList.length) return;
  const ni = viewIndex + dir;
  if (ni < 0 || ni >= viewList.length) return;
  const { cat, file } = viewList[ni];
  openLightbox(cat, file, ni);
}

function closeLightbox() {
  $("lightbox").classList.add("hidden");
  $("lb-media").innerHTML = "";
  viewIndex = -1;
}

wire($("lb-close"), "click", closeLightbox);
wire($("lb-prev"), "click", () => lbStep(-1));
wire($("lb-next"), "click", () => lbStep(1));
wire($("lightbox"), "click", (e) => { if (e.target === $("lightbox")) closeLightbox(); });
document.addEventListener("keydown", (e) => {
  const typing = document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);

  // ESC closes lightbox OR shortcuts overlay
  if (e.key === "Escape") {
    if (!$("shortcuts-overlay").classList.contains("hidden")) { hideShortcuts(); return; }
    if (!$("lightbox").classList.contains("hidden")) { closeLightbox(); return; }
  }

  // inside lightbox
  if (!$("lightbox").classList.contains("hidden")) {
    if (e.key === "ArrowLeft") lbStep(-1);
    else if (e.key === "ArrowRight") lbStep(1);
    else if (e.key === "m" || e.key === "M") toggleLbMute();
    else if (e.key === "l" || e.key === "L") toggleLbLoop();
    else if (e.key === " " || e.key === "Spacebar") {
      const v = getLbVideo();
      if (v) { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
    }
    return;
  }

  // global shortcuts (skip when typing)
  if (e.key === "/" && !typing) { e.preventDefault(); searchEl.focus(); return; }
  if (e.key === "?" && !typing) { e.preventDefault(); showShortcuts(); return; }
  if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !typing) { e.preventDefault(); toggleFilters(); return; }
  if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !typing) { e.preventDefault(); openRandom(); return; }
  if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !typing) { e.preventDefault(); toggleTheme(); return; }
  if ((e.key === "g" || e.key === "G") && !e.ctrlKey && !e.metaKey && !typing) { e.preventDefault(); toggleDensity(); return; }
});

// Swipe left/right in the lightbox (touch)
let swipeX = 0, swipeY = 0;
$("lb-media").addEventListener("touchstart", (e) => {
  swipeX = e.touches[0].clientX;
  swipeY = e.touches[0].clientY;
}, { passive: true });
$("lb-media").addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - swipeX;
  const dy = e.changedTouches[0].clientY - swipeY;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    lbStep(dx < 0 ? 1 : -1);
  }
}, { passive: true });

/* ---------- Mute / loop on lightbox video ---------- */

function getLbVideo() {
  return document.getElementById("lb-video");
}

function toggleLbMute(force) {
  const v = getLbVideo();
  if (!v) return;
  lbMuted = force !== undefined ? !!force : !lbMuted;
  v.muted = lbMuted;
  const btn = $("lb-mute");
  if (btn) {
    btn.classList.toggle("active", !lbMuted);
    btn.setAttribute("aria-pressed", String(!lbMuted));
    btn.title = lbMuted ? "Unmute (m)" : "Mute (m)";
    btn.querySelector(".lb-mute-on").classList.toggle("hidden", lbMuted);
    btn.querySelector(".lb-mute-off").classList.toggle("hidden", !lbMuted);
  }
}

function toggleLbLoop(force) {
  const v = getLbVideo();
  if (!v) return;
  lbLoop = force !== undefined ? !!force : !lbLoop;
  v.loop = lbLoop;
  const btn = $("lb-loop");
  if (btn) {
    btn.classList.toggle("active", lbLoop);
    btn.setAttribute("aria-pressed", String(lbLoop));
    btn.title = lbLoop ? "Disable loop (l)" : "Enable loop (l)";
  }
}

/* ---------- Random wallpaper ---------- */

function openRandom() {
  if (!DATA) return;
  const items = visibleFiles();
  if (!items.length) return toast("No wallpapers match your filters.");
  const pick = items[Math.floor(Math.random() * items.length)];
  const idx = items.indexOf(pick);
  openLightbox(pick.cat, pick.file, idx);
}

/* ---------- Back to top ---------- */

function wireBackToTop() {
  const b = $("back-top");
  if (!b) return;
  const onScroll = () => b.classList.toggle("visible", window.scrollY > 600);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  b.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}

/* ---------- Theme (light/dark) ---------- */

const THEME_KEY = "wallpapers:theme";
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const b = $("theme-toggle");
  if (b) {
    b.setAttribute("aria-pressed", String(theme === "light"));
    b.title = theme === "light" ? "Switch to dark" : "Switch to light";
    b.querySelector(".theme-dark").classList.toggle("hidden", theme === "light");
    b.querySelector(".theme-light").classList.toggle("hidden", theme !== "light");
  }
}

function initTheme() {
  let theme = "dark";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") theme = saved;
  } catch (_) {}
  applyTheme(theme);
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const next = cur === "light" ? "dark" : "light";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
}

/* ---------- Grid density ---------- */

const DENSITY_KEY = "wallpapers:density";
function applyDensity(d) {
  document.documentElement.dataset.density = d;
  const b = $("density-toggle");
  if (b) {
    b.setAttribute("aria-pressed", String(d === "compact"));
    b.title = d === "compact" ? "Larger cards" : "Compact cards";
    b.querySelector(".density-comfortable").classList.toggle("hidden", d === "compact");
    b.querySelector(".density-compact").classList.toggle("hidden", d !== "compact");
  }
}

function initDensity() {
  let d = "comfortable";
  try {
    const saved = localStorage.getItem(DENSITY_KEY);
    if (saved === "compact" || saved === "comfortable") d = saved;
  } catch (_) {}
  applyDensity(d);
}

function toggleDensity() {
  const cur = document.documentElement.dataset.density === "compact" ? "compact" : "comfortable";
  const next = cur === "compact" ? "comfortable" : "compact";
  applyDensity(next);
  try { localStorage.setItem(DENSITY_KEY, next); } catch (_) {}
}

/* ---------- Keyboard shortcuts ---------- */

function showShortcuts() {
  const ov = $("shortcuts-overlay");
  if (!ov) return;
  ov.classList.remove("hidden");
}

function hideShortcuts() {
  const ov = $("shortcuts-overlay");
  if (ov) ov.classList.add("hidden");
}

wire($("lb-mute"), "click", () => toggleLbMute());
wire($("lb-loop"), "click", () => toggleLbLoop());

let searchTimer = null;
wire(searchEl, "input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { render(); updateFilterBadge(); }, 180);
});
wire(categoryEl, "change", () => { render(); updateFilterBadge(); });
wire(kindEl, "change", () => { render(); updateFilterBadge(); });
wire(aspectEl, "change", () => { render(); updateFilterBadge(); });
wire(seriesEl, "change", () => { render(); updateFilterBadge(); });
wire(sortEl, "change", render);
wire($("fav-only"), "change", () => { render(); updateFilterBadge(); });
wire($("select-none"), "click", clearSelection);
wire($("download-selected"), "click", downloadSelected);
wire($("random-btn"), "click", openRandom);
wire($("theme-toggle"), "click", toggleTheme);
wire($("density-toggle"), "click", toggleDensity);
wire($("back-top"), "click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
wire($("shortcuts-close"), "click", hideShortcuts);
wire($("shortcuts-overlay"), "click", (e) => { if (e.target === $("shortcuts-overlay")) hideShortcuts(); });

/* ---------- Boot ---------- */

loadFavorites();
loadRecent();
initTheme();
initDensity();
wireBackToTop();

loadIndex().then(() => {
  // now DATA is loaded → safe to render dependent rows
  updateFavCount();
  renderRecentRow();
  renderFavoritesRow();
}).catch((err) => {
  grid.innerHTML = `<div class="empty">Failed to load catalog: ${esc(String(err))}</div>`;
});
