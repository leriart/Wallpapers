/* Wallpapers gallery — loads docs/index.json and renders the grid.
 * Media is served from GitHub raw URLs (no Pages 1GB limit).
 * Thumbnails go through images.weserv.nl for fast loading.
 */
"use strict";

const REPO = "leriart/Wallpapers";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
// Thumbnails are local (served by Pages, same origin, no third-party proxy).
const THUMB = (path) => path;

let DATA = null;
let selected = new Set(); // "cat/name"

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const searchEl = $("search");
const categoryEl = $("category");
const kindEl = $("kind");

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
      if (q && !`${f.name} ${f.char}`.toLowerCase().includes(q)) continue;
      out.push({ cat: c.name, file: f });
    }
  }
  return out;
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
  for (const { cat, file } of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.key = `${cat}/${file.name}`;
    if (selected.has(card.dataset.key)) card.classList.add("selected");

    const media = file.kind === "video"
      ? `<video src="${RAW}/${cat}/${encodeURIComponent(file.name)}" poster="${esc(file.thumb)}" preload="none" muted loop></video>`
      : `<img loading="lazy" src="${esc(file.thumb)}" alt="${esc(file.name)}">`;

    card.innerHTML = media +
      (file.char ? `<span class="badge">${esc(file.char)}</span>` : "") +
      (file.kind === "video" ? '<span class="kind-flag">video</span>' : "") +
      `<span class="check">✓</span>` +
      `<div class="meta"><span class="fname" title="${esc(file.name)}">${esc(file.name)}</span><span class="fsize">${fmtSize(file.size)}</span></div>`;

    // hover play/pause for videos (desktop only)
    if (file.kind === "video" && !IS_TOUCH) {
      const v = card.querySelector("video");
      card.addEventListener("mouseenter", () => { try { v.play(); } catch (_) {} });
      card.addEventListener("mouseleave", () => { v.pause(); v.currentTime = 0; });
    }

    card.addEventListener("click", () => openLightbox(cat, file));
    card.addEventListener("dblclick", (e) => { e.stopPropagation(); toggleSelect(cat, file); });
    frag.appendChild(card);
  }
  grid.innerHTML = "";
  grid.appendChild(frag);
  updateCount();
}

function updateCount() {
  $("sel-count").textContent = selected.size;
  const items = visibleFiles();
  $("stats").textContent = $("stats").textContent.split(" · showing")[0] +
    (searchEl.value || categoryEl.value !== "all" || kindEl.value !== "all"
      ? ` · showing ${items.length}`
      : "");
}

/* ---------- Selection ---------- */

function toggleSelect(cat, file) {
  const key = `${cat}/${file.name}`;
  if (selected.has(key)) selected.delete(key); else selected.add(key);
  const card = grid.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
  if (card) card.classList.toggle("selected", selected.has(key));
  updateCount();
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
  if (!keys.length) return toast("Nothing selected. Double-click a wallpaper to select it.");
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
    `<strong>${esc(file.name)}</strong> &middot; ${fmtSize(file.size)} &middot; ${esc(cat)}` +
    (file.char ? `<span class="char-tag">${esc(file.char)}</span>` : "");
  $("lb-download").href = url;
  $("lb-select").textContent = selected.has(key) ? "Deselect" : "Select";
  $("lb-select").onclick = () => {
    toggleSelect(cat, file);
    $("lb-select").textContent = selected.has(key) ? "Deselect" : "Select";
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
});

searchEl.addEventListener("input", render);
categoryEl.addEventListener("change", render);
kindEl.addEventListener("change", render);
$("select-none").addEventListener("click", () => { selected.clear(); render(); });
$("download-selected").addEventListener("click", downloadSelected);

loadIndex().catch((err) => {
  grid.innerHTML = `<div class="empty">Failed to load catalog: ${esc(String(err))}</div>`;
});
