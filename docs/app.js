/* Wallpapers gallery — loads docs/index.json and renders the grid.
 * Media is served from GitHub raw URLs (no Pages 1GB limit).
 * Thumbnails are local (served by Pages, same origin).
 *
 * Selection:
 *   - Desktop: right-click on a card, or the check button on the card.
 *   - Touch: tap the check button, or long-press (400ms) a card.
 *   - Plain click (or tap without holding) opens the preview.
 */
"use strict";

const REPO = "leriart/Wallpapers";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const THUMB = (path) => path;

let DATA = null;
let selected = new Set(); // "cat/name"

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const searchEl = $("search");
const categoryEl = $("category");
const kindEl = $("kind");
const filterToggle = $("filter-toggle");
const filterPanel = $("filter-panel");
const filterBadge = $("filter-badge");

// Touch devices: disable hover-play of videos (no hover state)
const IS_TOUCH = window.matchMedia("(hover: none)").matches;

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
  return n;
}

function updateFilterBadge() {
  const n = filterCount();
  filterBadge.textContent = n;
  filterBadge.classList.toggle("hidden", n === 0);
  // keep panel open on touch when user interacts with it
}

function toggleFilters(force) {
  const willShow = force !== undefined ? force : filterPanel.classList.contains("hidden");
  filterPanel.classList.toggle("hidden", !willShow);
  filterToggle.setAttribute("aria-expanded", String(willShow));
  filterToggle.classList.toggle("active", willShow);
}

filterToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleFilters();
});

// Close panel on outside click (desktop)
document.addEventListener("click", (e) => {
  if (!IS_TOUCH && !filterPanel.contains(e.target) && e.target !== filterToggle && !filterToggle.contains(e.target)) {
    if (!filterPanel.classList.contains("hidden")) toggleFilters(false);
  }
});

// Keep panel open while interacting with its controls
filterPanel.addEventListener("click", (e) => e.stopPropagation());

/* ---------- Load ---------- */

async function loadIndex() {
  showSkeleton(18);
  const res = await fetch("index.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("index.json HTTP " + res.status);
  DATA = await res.json();
  const cats = DATA.categories;
  const total = cats.reduce((a, c) => a + c.files.length, 0);
  const videos = cats.reduce((a, c) => a + c.files.filter((f) => f.kind === "video").length, 0);
  $("stats").textContent =
    `${total.toLocaleString()} ${plural(total, "wallpaper", "wallpapers")} · ` +
    `${cats.length} ${plural(cats.length, "category", "categories")} · ` +
    `${videos} ${plural(videos, "video", "videos")}`;

  categoryEl.innerHTML = '<option value="all">All categories</option>' +
    cats.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} &middot; ${c.files.length}</option>`).join("");
  render();
}

/* ---------- Filtering ---------- */

function visibleFiles() {
  const q = searchEl.value.trim().toLowerCase();
  const cat = categoryEl.value;
  const kind = kindEl.value;
  const out = [];
  for (const c of DATA.categories) {
    if (cat !== "all" && c.name !== cat) continue;
    for (const f of c.files) {
      if (kind !== "all" && f.kind !== kind) continue;
      if (q && !f.name.toLowerCase().includes(q)) continue;
      out.push({ cat: c.name, file: f });
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
    if (btn) btn.setAttribute("aria-pressed", String(selected.has(key)));
  }
  updateCount();
}

function clearSelection() {
  selected.clear();
  render();
}

/* ---------- Card interaction ---------- */

function attachCardEvents(card, cat, file) {
  // Explicit select button: works on every device with a plain tap/click.
  const selectBtn = card.querySelector(".select-btn");
  selectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleSelect(cat, file);
  });

  // Plain click / tap (no hold) → preview
  card.addEventListener("click", (e) => {
    if (e.target.closest(".select-btn")) return;
    openLightbox(cat, file);
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

/* ---------- Render ---------- */

function render() {
  const items = visibleFiles();
  if (!items.length) {
    grid.innerHTML = '<div class="empty">No wallpapers match your filters.</div>';
    updateCount();
    return;
  }
  const frag = document.createDocumentFragment();
  for (let idx = 0; idx < items.length; idx++) {
    const { cat, file } = items[idx];
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.key = `${cat}/${file.name}`;
    // Staggered entrance: cap the delay so long lists stay snappy
    const delay = Math.min(idx, 24) * 18;
    card.style.animationDelay = `${delay}ms`;
    const isSel = selected.has(card.dataset.key);
    if (isSel) card.classList.add("selected");

    const media = file.kind === "video"
      ? `<video src="${RAW}/${cat}/${encodeURIComponent(file.name)}" poster="${esc(file.thumb)}" preload="none" muted loop></video>`
      : `<img loading="lazy" src="${esc(file.thumb)}" alt="${esc(file.name)}">`;

    card.innerHTML = media +
      (file.kind === "video" ? '<span class="kind-flag">video</span>' : "") +
      `<div class="meta">` +
        `<span class="fname" title="${esc(file.name)}">${esc(file.name)}</span>` +
        `<span class="meta-right">` +
          `<span class="fsize">${fmtSize(file.size)}</span>` +
          `<button class="select-btn" aria-pressed="${isSel}" aria-label="Select ${esc(file.name)}"><span class="check">✓</span></button>` +
        `</span>` +
      `</div>`;

    // hover play/pause for videos (desktop only)
    if (file.kind === "video" && !IS_TOUCH) {
      const v = card.querySelector("video");
      card.addEventListener("mouseenter", () => { try { v.play(); } catch (_) {} });
      card.addEventListener("mouseleave", () => { v.pause(); v.currentTime = 0; });
    }

    attachCardEvents(card, cat, file);
    frag.appendChild(card);
  }
  grid.innerHTML = "";
  grid.appendChild(frag);
  updateCount();
}

function updateCount() {
  $("sel-count").textContent = selected.size;
  updateFilterBadge();
  const items = visibleFiles();
  const base = $("stats").textContent.split(" · showing")[0];
  const n = filterCount();
  $("stats").textContent = base + (n > 0 ? ` · showing ${items.length}` : "");
}

/* ---------- Download ---------- */

async function downloadFile(cat, file) {
  const url = `${RAW}/${cat}/${encodeURIComponent(file.name)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

async function downloadSelected() {
  const keys = [...selected];
  if (!keys.length) return toast("Nothing selected. Tap the check on a wallpaper to select it.");
  toast(`Downloading ${keys.length} ${plural(keys.length, "file", "files")}…`);
  let ok = 0;
  for (const key of keys) {
    const idx = key.indexOf("/");
    const cat = key.slice(0, idx);
    const name = key.slice(idx + 1);
    const c = DATA.categories.find((x) => x.name === cat);
    const f = c && c.files.find((x) => x.name === name);
    if (f && (await downloadFile(cat, f))) ok++;
  }
  toast(`Downloaded ${ok} of ${keys.length} ${plural(keys.length, "file", "files")}.`);
}

/* ---------- Lightbox ---------- */

function openLightbox(cat, file) {
  const url = `${RAW}/${cat}/${encodeURIComponent(file.name)}`;
  const key = `${cat}/${file.name}`;
  $("lb-media").innerHTML = file.kind === "video"
    ? `<video src="${url}" controls autoplay></video>`
    : `<img src="${url}" alt="${esc(file.name)}">`;
  $("lb-info").innerHTML =
    `<strong>${esc(file.name)}</strong> &middot; ${fmtSize(file.size)} &middot; ${esc(cat)}`;
  $("lb-download").href = url;
  const isSel = selected.has(key);
  $("lb-select").textContent = isSel ? "Deselect" : "Select";
  $("lb-select").classList.toggle("active", isSel);
  $("lb-select").onclick = () => {
    toggleSelect(cat, file);
    const nowSel = selected.has(key);
    $("lb-select").textContent = nowSel ? "Deselect" : "Select";
    $("lb-select").classList.toggle("active", nowSel);
  };
  $("lightbox").classList.remove("hidden");
}

function closeLightbox() {
  $("lightbox").classList.add("hidden");
  $("lb-media").innerHTML = "";
}

$("lb-close").addEventListener("click", closeLightbox);
$("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) closeLightbox(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLightbox();
  if (e.key === "/" && document.activeElement !== searchEl) { e.preventDefault(); searchEl.focus(); }
  if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleFilters(); }
});

searchEl.addEventListener("input", () => { render(); updateFilterBadge(); });
categoryEl.addEventListener("change", () => { render(); updateFilterBadge(); });
kindEl.addEventListener("change", () => { render(); updateFilterBadge(); });
$("select-none").addEventListener("click", clearSelection);
$("download-selected").addEventListener("click", downloadSelected);

loadIndex().catch((err) => {
  grid.innerHTML = `<div class="empty">Failed to load catalog: ${esc(String(err))}</div>`;
});
