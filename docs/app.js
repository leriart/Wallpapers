/* Wallpapers gallery — loads docs/index.json and renders the grid.
 * Media is served from GitHub raw URLs (no Pages 1GB limit).
 * Thumbnails go through images.weserv.nl for fast loading.
 */
"use strict";

const REPO = "leriart/Wallpapers";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const THUMB = (path) => `https://images.weserv.nl/?url=${encodeURIComponent(`${RAW}/${path}`)}&w=420&output=jpg&q=75`;

let DATA = null;
let selected = new Set(); // "cat/name"

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const searchEl = $("search");
const categoryEl = $("category");
const kindEl = $("kind");

function fmtSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2500);
}

async function loadIndex() {
  const res = await fetch("index.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("index.json HTTP " + res.status);
  DATA = await res.json();
  const cats = DATA.categories;
  const total = cats.reduce((a, c) => a + c.files.length, 0);
  const videos = cats.reduce((a, c) => a + c.files.filter((f) => f.kind === "video").length, 0);
  $("stats").textContent = `${total} wallpapers · ${cats.length} categories · ${videos} videos · click to preview, select to download`;

  categoryEl.innerHTML = '<option value="all">All categories</option>' +
    cats.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} (${c.files.length})</option>`).join("");
  render();
}

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

function render() {
  const items = visibleFiles();
  if (!items.length) {
    grid.innerHTML = '<div class="empty">No wallpapers match your filters.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const { cat, file } of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.key = `${cat}/${file.name}`;
    if (selected.has(card.dataset.key)) card.classList.add("selected");

    const media = file.kind === "video"
      ? `<video src="${RAW}/${cat}/${encodeURIComponent(file.name)}" preload="metadata" muted loop></video>`
      : `<img loading="lazy" src="${THUMB(`${cat}/${file.name}`)}" alt="${esc(file.name)}">`;

    card.innerHTML = media +
      (file.char ? `<span class="char-badge">${esc(file.char)}</span>` : "") +
      (file.kind === "video" ? '<span class="video-flag">▶ video</span>' : "") +
      `<span class="check">✓</span>` +
      `<div class="meta">${esc(file.name)} · ${fmtSize(file.size)}</div>`;

    card.addEventListener("click", () => openLightbox(cat, file));
    card.addEventListener("dblclick", (e) => { e.stopPropagation(); toggleSelect(cat, file); });
    frag.appendChild(card);
  }
  grid.innerHTML = "";
  grid.appendChild(frag);
  $("sel-count").textContent = selected.size;
}

function toggleSelect(cat, file) {
  const key = `${cat}/${file.name}`;
  if (selected.has(key)) selected.delete(key); else selected.add(key);
  const card = grid.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
  if (card) card.classList.toggle("selected", selected.has(key));
  $("sel-count").textContent = selected.size;
}

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
  if (!keys.length) return toast("Nothing selected — double-click items to select them.");
  toast(`Downloading ${keys.length} file(s)…`);
  let ok = 0;
  for (const key of keys) {
    const [cat, name] = key.split("/");
    const c = DATA.categories.find((x) => x.name === cat);
    const f = c && c.files.find((x) => x.name === name);
    if (f && (await downloadFile(cat, f))) ok++;
  }
  toast(`Downloaded ${ok}/${keys.length}.`);
}

function openLightbox(cat, file) {
  const url = `${RAW}/${cat}/${encodeURIComponent(file.name)}`;
  const key = `${cat}/${file.name}`;
  $("lb-media").innerHTML = file.kind === "video"
    ? `<video src="${url}" controls autoplay></video>`
    : `<img src="${url}" alt="${esc(file.name)}">`;
  $("lb-info").innerHTML =
    `<strong>${esc(file.name)}</strong> · ${fmtSize(file.size)} · ${esc(cat)}` +
    (file.char ? ` · ⭐ ${esc(file.char)}` : "");
  $("lb-download").href = url;
  $("lb-select").textContent = selected.has(key) ? "Deselect" : "Select";
  $("lb-select").onclick = () => { toggleSelect(cat, file); $("lb-select").textContent = selected.has(key) ? "Deselect" : "Select"; };
  $("lightbox").classList.remove("hidden");
}

function closeLightbox() {
  $("lightbox").classList.add("hidden");
  $("lb-media").innerHTML = "";
}

$("lb-close").addEventListener("click", closeLightbox);
$("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

searchEl.addEventListener("input", render);
categoryEl.addEventListener("change", render);
kindEl.addEventListener("change", render);
$("select-none").addEventListener("click", () => { selected.clear(); render(); });
$("download-selected").addEventListener("click", downloadSelected);

loadIndex().catch((err) => {
  grid.innerHTML = `<div class="empty">Failed to load index.json: ${esc(String(err))}</div>`;
});
