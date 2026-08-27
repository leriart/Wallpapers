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
let selected = new Set();          // "cat/name"
let viewList = [];                 // current filtered+sorted [{cat,file}]
let viewIndex = -1;                // lightbox position in viewList
let renderToken = 0;               // invalidates in-flight chunked renders
let lastLongPressAt = 0;           // iOS: suppress click after long-press
const CHUNK = 140;                 // cards per animation frame
const MAX_ANIMATED = 60;           // only first N cards get entrance animation

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

// Touch devices: disable hover-play of videos (no hover state)
const IS_TOUCH = window.matchMedia("(hover: none)").matches || ("ontouchstart" in window);
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/* ---------- helpers ---------- */

const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

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

  // Precompute a normalized search haystack per file
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
  const out = [];
  for (const c of DATA.categories) {
    if (cat !== "all" && c.name !== cat) continue;
    for (const f of c.files) {
      if (kind !== "all" && f.kind !== kind) continue;
      if (!showNSFW && f.nsfw) continue;
      if (aspect !== "all" && f.aspect !== aspect) continue;
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
  }
  return out;
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
    if (Date.now() - lastLongPressAt < 700) return;
    const idx = viewList.findIndex((v) => v.cat === cat && v.file === file);
    openLightbox(cat, file, idx >= 0 ? idx : 0);
  });

  // Desktop: right-click toggles selection
  card.addEventListener("contextmenu", (e) => {
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

  if (!items.length) {
    grid.innerHTML = `<div class="empty">
        <p>No wallpapers match your filters.</p>
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
        ? `<video src="${RAW}/${cat}/${encodeURIComponent(file.name)}" poster="${esc(file.thumb)}" preload="none" muted loop></video>`
        : `<img loading="lazy" src="${esc(file.thumb)}" alt="${esc(file.name)}">`;

      const flag = (file.kind === "video" ? '<span class="kind-flag">video</span>' : "") +
        (file.nsfw ? '<span class="nsfw-flag">NSFW</span>' : "");

      const t = file.tags || {};
      const chips = [];
      for (const s of t.series || []) chips.push(`<span class="chip chip-series">${esc(s)}</span>`);
      for (const ch of (t.characters || []).slice(0, 2)) chips.push(`<span class="chip">${esc(ch)}</span>`);
      const chipRow = chips.length ? `<div class="chips">${chips.join("")}</div>` : "";

      card.innerHTML = media +
        flag +
        `<div class="meta">` +
          `<span class="fname" title="${esc(file.name)}">${esc(file.name)}</span>` +
          `<span class="meta-right">` +
            `<span class="fsize">${fmtSize(file.size)}</span>` +
            `<button class="select-btn" type="button" aria-pressed="${isSel}" aria-label="Select ${esc(file.name)}">` +
              (isSel ? '<span class="check">✓</span>' : '<span class="plus">+</span>') +
            `</button>` +
          `</span>` +
        `</div>` + chipRow;

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
  const url = `${RAW}/${cat}/${encodeURIComponent(file.name)}`;
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
  const url = `${RAW}/${cat}/${encodeURIComponent(file.name)}`;
  const key = `${cat}/${file.name}`;
  viewIndex = idx >= 0 ? idx : viewList.findIndex((v) => v.cat === cat && v.file === file);

  $("lb-media").innerHTML = file.kind === "video"
    ? `<video src="${url}" controls autoplay></video>`
    : `<img src="${url}" alt="${esc(file.name)}">`;

  const t = file.tags || {};
  const tagStr = [t.series, t.characters, t.tags].flat().filter(Boolean).map(esc).join(" · ");
  $("lb-info").innerHTML =
    `<strong>${esc(file.name)}</strong> &middot; ${fmtSize(file.size)} &middot; ${esc(cat)}` +
    (tagStr ? `<br><span class="lb-tags">${tagStr}</span>` : "");

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

  // prev/next
  $("lb-prev").classList.toggle("hidden", viewList.length < 2 || viewIndex <= 0);
  $("lb-next").classList.toggle("hidden", viewList.length < 2 || viewIndex >= viewList.length - 1);
  $("lb-count").textContent = viewList.length ? `${viewIndex + 1} / ${viewList.length}` : "";

  $("lightbox").classList.remove("hidden");
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
  if (e.key === "Escape") closeLightbox();
  const typing = document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === "ArrowLeft" && !$("lightbox").classList.contains("hidden")) lbStep(-1);
  if (e.key === "ArrowRight" && !$("lightbox").classList.contains("hidden")) lbStep(1);
  if (e.key === "/" && !typing) { e.preventDefault(); searchEl.focus(); }
  if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !typing) { e.preventDefault(); toggleFilters(); }
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

/* ---------- Events ---------- */

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
wire($("select-none"), "click", clearSelection);
wire($("download-selected"), "click", downloadSelected);

loadIndex().catch((err) => {
  grid.innerHTML = `<div class="empty">Failed to load catalog: ${esc(String(err))}</div>`;
});
