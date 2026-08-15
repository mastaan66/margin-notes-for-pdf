// Margin Notes for PDF — viewer + notes.
import * as pdfjsLib from "../lib/pdf.mjs";
import { db, notesToMarkdown } from "./db.js";
import { renderMarkdown } from "./markdown.js";
import { InkSurface, buildInkToolbar, inkState, setInkState, onInkStateChange, drawStrokes, strokesToPng, hideInkCursor, icon } from "./ink.js";

const chrome = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = /firefox/i.test(navigator.userAgent);
const LIB = chrome.runtime.getURL("lib/");
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdf.worker.mjs";

const $ = (id) => document.getElementById(id);
const el = {
  toolbar: $("toolbar"), split: $("split"), landing: $("landing"),
  pdfPane: $("pdfPane"), scroll: $("viewerScroll"), pages: $("pages"), splitter: $("splitter"), notesPane: $("notesPane"),
  docTitle: $("docTitle"), pageInput: $("pageInput"), pageCount: $("pageCount"), zoomSelect: $("zoomSelect"),
  findbar: $("findbar"), findInput: $("findInput"), findCount: $("findCount"),
  selBubble: $("selBubble"), loadBar: $("loadBar"),
  noteText: $("noteText"), notePreview: $("notePreview"), npPageLabel: $("npPageLabel"), npPageBtn: $("npPageBtn"),
  npDocBtn: $("npDocBtn"), noteStrip: $("noteStrip"), saveStatus: $("saveStatus"), wordCount: $("wordCount"),
  allList: $("allList"), allFilter: $("allFilter"), allCount: $("allCount"), outline: $("outline"),
  recentList: $("recentList"), fileInput: $("fileInput"), dropZone: $("dropZone"), fileAccessWarn: $("fileAccessWarn"),
  loadError: $("loadError"), menu: $("menu"), toast: $("toast"), shortcuts: $("shortcuts"), hostPermWarn: $("hostPermWarn"),
  noteEditor: $("noteEditor"), sketch: $("sketch"), sketchWrap: $("sketchWrap"), sketchCanvas: $("sketchCanvas"),
  noteInkBar: $("noteInkBar"), pageInkBar: $("pageInkBar"), btnModeText: $("btnModeText"), btnModeInk: $("btnModeInk"),
};

const DEFAULT_SETTINGS = {
  enabled: true, side: "left", splitRatio: 0.58, theme: "system", fontSize: 15, fontFamily: "serif", autoQuote: true,
  defaultZoom: "width", followScroll: true,
  noteMode: "text", paper: "lines", touchDraws: true,
};
let settings = { ...DEFAULT_SETTINGS };

// ---------- state ----------
const S = {
  pdf: null, fp: null, doc: null, url: null, filename: "document.pdf", numPages: 0,
  pages: [],           // {num, div, canvas, textDiv, annotDiv, page(proxy), w, h (pt, unrotated), rendered, renderTask, textLayer, renderScale, visible}
  scale: 1, zoomMode: "width", rotation: 0,
  currentPage: 1, tops: [], heights: [],
  notePage: 1, pinned: false, noteLoadedFor: null, dirty: false, saveTimer: null, notedPages: new Set(), noteCache: new Map(),
  find: { query: "", results: [], perPage: new Map(), cur: -1, textCache: new Map(), token: 0, open: false },
  outlineItems: [], outlinePages: [],
  layoutTimer: null, io: null, sourceData: null,
  ink: new Map(),          // `${target}:${page}` -> strokes[]   (target: note | page)
  inkDirty: new Set(), inkSaveTimer: null, annotating: false, sketchSurface: null, lastInkSurface: null,
};
const SKETCH_UNITS = 600; // logical width of the sketch pad

// ---------- helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function toast(msg, ms = 1800) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (el.toast.hidden = true), ms);
}
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function isEditable(t) { return t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable || t.tagName === "SELECT"); }

// ---------- settings ----------
async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings = { ...DEFAULT_SETTINGS, ...stored };
  applySettings();
}
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.body.dataset.side = settings.side;
  document.documentElement.style.setProperty("--pdf-frac", settings.splitRatio);
  document.documentElement.style.setProperty("--note-size", settings.fontSize + "px");
  document.documentElement.style.setProperty("--font-note", `var(--font-note-${settings.fontFamily || "serif"})`);
  el.sketchCanvas.className = `paper-${settings.paper || "lines"}`;
  scheduleLayout();
  requestAnimationFrame(() => { refreshSketch(); for (const t of inkToolbars) t.refresh(); });
}
const inkToolbars = [];
function saveSetting(patch) {
  Object.assign(settings, patch);
  chrome.storage.sync.set(patch);
  applySettings();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  let touched = false;
  for (const k of Object.keys(changes)) if (k in DEFAULT_SETTINGS) { settings[k] = changes[k].newValue; touched = true; }
  if (touched) applySettings();
});

// ---------- URL parsing ----------
function parseFileParam() {
  const q = location.search;
  const i = q.indexOf("file=");
  if (i < 0) return null;
  let u = q.slice(i + 5);
  if (/^[a-z][a-z0-9+.-]*%3A/i.test(u)) { try { u = decodeURIComponent(u); } catch { /* keep raw */ } }
  return u || null;
}
function parseHashPage() {
  const m = /(?:^|[#&])page=(\d+)/.exec(location.hash);
  return m ? parseInt(m[1], 10) : null;
}

// ---------- loading ----------
function setLoadProgress(p) {
  const bar = el.loadBar.firstElementChild;
  el.loadBar.classList.remove("done");
  bar.style.width = `${clamp(p, 0, 100)}%`;
  if (p >= 100) el.loadBar.classList.add("done");
}

async function openFromUrl(url) {
  S.url = url;
  S.filename = pdfjsLib.getPdfFilenameFromUrl(url) || "document.pdf";
  showViewer();
  el.docTitle.textContent = S.filename;
  document.title = S.filename;
  try {
    const task = pdfjsLib.getDocument({
      url, withCredentials: true,
      cMapUrl: LIB + "cmaps/", cMapPacked: true, standardFontDataUrl: LIB + "standard_fonts/", wasmUrl: LIB + "wasm/", iccUrl: LIB + "iccs/",
    });
    task.onProgress = ({ loaded, total }) => { if (total) setLoadProgress((loaded / total) * 100); };
    task.onPassword = (cb, reason) => {
      const msg = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? "Wrong password. Try again:" : "This PDF is password protected. Password:";
      const pw = prompt(msg);
      if (pw == null) throw new Error("Password required");
      cb(pw);
    };
    const pdf = await task.promise;
    await onDocumentLoaded(pdf);
  } catch (e) {
    console.error(e);
    await showLoadError(e, url);
  }
}

async function openFromData(data, filename) {
  S.url = null;
  S.filename = filename || "document.pdf";
  S.sourceData = data;
  showViewer();
  el.docTitle.textContent = S.filename;
  document.title = S.filename;
  try {
    const pdf = await pdfjsLib.getDocument({
      data, cMapUrl: LIB + "cmaps/", cMapPacked: true, standardFontDataUrl: LIB + "standard_fonts/", wasmUrl: LIB + "wasm/", iccUrl: LIB + "iccs/",
    }).promise;
    await onDocumentLoaded(pdf);
  } catch (e) {
    console.error(e);
    await showLoadError(e, null);
  }
}

async function showLoadError(e, url) {
  showLanding();
  let msg = `Couldn't open the PDF.\n${e?.message || e}`;
  if (url && /^file:/i.test(url)) {
    const { allowed, firefox } = await chrome.runtime.sendMessage({ type: "getFileAccess" }).catch(() => ({ allowed: true }));
    if (firefox) msg = `Firefox doesn't let extensions read local files (${url}).\n\nDrop the PDF onto this page or use "choose a file" — notes still work.`;
    else if (!allowed) {
      el.fileAccessWarn.hidden = false;
      msg = `Couldn't read ${url}\n\nChrome blocks extensions from reading local files until you enable "Allow access to file URLs" (button above). Alternatively, drop the file onto this page.`;
    }
  } else if (url && /^https?:/i.test(url)) {
    const { granted } = await chrome.runtime.sendMessage({ type: "getHostAccess" }).catch(() => ({ granted: true }));
    if (!granted) { el.hostPermWarn.hidden = false; msg = `Couldn't fetch ${url}\n\nThe extension hasn't been allowed to access websites yet — click "Allow access to websites" above, then reload.`; }
  }
  el.loadError.textContent = msg;
  el.loadError.hidden = false;
}

function showViewer() {
  el.landing.hidden = true; el.toolbar.hidden = false; el.split.hidden = false;
  el.loadError.hidden = true;
}
function showLanding() {
  el.landing.hidden = false; el.toolbar.hidden = true; el.split.hidden = true;
  document.title = "Margin Notes";
  refreshRecents();
  checkFileAccess();
  checkHostAccess();
}
async function checkFileAccess() {
  try {
    const { allowed, firefox } = await chrome.runtime.sendMessage({ type: "getFileAccess" });
    el.fileAccessWarn.hidden = !!allowed || !!firefox;
    $("firefoxFileNote").hidden = !firefox;
  } catch { /* ignore */ }
}
async function checkHostAccess() {
  try {
    const { granted } = await chrome.runtime.sendMessage({ type: "getHostAccess" });
    el.hostPermWarn.hidden = !!granted;
  } catch { /* ignore */ }
}

// ---------- document setup ----------
async function onDocumentLoaded(pdf) {
  setLoadProgress(100);
  await teardown();
  S.pdf = pdf;
  S.numPages = pdf.numPages;
  S.fp = pdf.fingerprints?.[0] || `nofp-${S.filename}-${pdf.numPages}`;
  el.pageCount.textContent = String(S.numPages);

  let title = null;
  try {
    const meta = await pdf.getMetadata();
    title = meta?.info?.Title?.trim() || null;
    if (title && /^(untitled|microsoft word|document)/i.test(title)) title = null;
  } catch { /* ignore */ }
  const displayTitle = title || S.filename;
  el.docTitle.textContent = displayTitle; el.docTitle.title = displayTitle;
  document.title = displayTitle;

  // doc record + notes index
  const prev = await db.getDoc(S.fp);
  S.doc = await db.touchDoc(S.fp, { title: displayTitle, filename: S.filename, url: S.url || prev?.url || null, pageCount: S.numPages });
  const notes = await db.getNotesForDoc(S.fp);
  S.notedPages = new Set(notes.map((n) => n.page));
  S.noteCache = new Map(notes.map((n) => [n.page, n.text]));
  S.ink = new Map();
  for (const rec of await db.getInkForDoc(S.fp)) if (rec.strokes?.length) S.ink.set(`${rec.target}:${rec.page}`, rec.strokes);
  updateAllCount();

  // pages
  const first = await pdf.getPage(1);
  const v1 = first.getViewport({ scale: 1 });
  S.zoomMode = prev?.zoomMode || settings.defaultZoom || "width";
  S.rotation = 0;
  el.pages.textContent = "";
  S.pages = [];
  for (let i = 1; i <= S.numPages; i++) {
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.page = String(i);
    const ph = document.createElement("div");
    ph.className = "placeholder"; ph.textContent = String(i);
    div.appendChild(ph);
    if (S.notedPages.has(i)) div.classList.add("has-note");
    if (S.ink.has(`page:${i}`)) div.classList.add("has-ink");
    el.pages.appendChild(div);
    S.pages.push({ num: i, div, page: i === 1 ? first : null, w: v1.width, h: v1.height, rendered: false, renderTask: null, textLayer: null, renderScale: 0, visible: false, canvas: null, textDiv: null, annotDiv: null });
  }
  setupObserver();
  layout(true);

  // initial page: #page= > lastPage > 1
  const target = parseHashPage() || (prev?.lastPage && prev.lastPage <= S.numPages ? prev.lastPage : 1);
  goToPage(target, { instant: true });
  setNotePage(target, { force: true });
  setNoteMode(settings.noteMode || "text", { persist: false });
  loadOutline();
  prefetchPageSizes();
  el.scroll.focus({ preventScroll: true });
}

async function teardown() {
  await saveNow();
  await saveInkNow();
  setAnnotating(false);
  S.ink = new Map(); S.inkDirty.clear();
  S.sketchSurface?.resetHistory();
  if (S.io) { S.io.disconnect(); S.io = null; }
  for (const p of S.pages) { try { p.renderTask?.cancel(); } catch { /* ignore */ } }
  if (S.pdf) { try { await S.pdf.destroy(); } catch { /* ignore */ } }
  S.pdf = null; S.pages = []; S.find.textCache.clear(); S.find.results = []; S.find.perPage.clear();
  el.pages.textContent = "";
}

// Fetch each page proxy in the background so placeholders get their real size.
async function prefetchPageSizes() {
  const pdf = S.pdf;
  let changed = false;
  for (let i = 2; i <= S.numPages && S.pdf === pdf; i++) {
    const p = S.pages[i - 1];
    if (p.page) continue;
    try {
      p.page = await pdf.getPage(i);
      const v = p.page.getViewport({ scale: 1 });
      if (Math.abs(v.width - p.w) > 0.5 || Math.abs(v.height - p.h) > 0.5) { p.w = v.width; p.h = v.height; changed = true; }
    } catch { /* ignore */ }
    if (i % 25 === 0 && changed) { layout(); changed = false; }
  }
  if (changed && S.pdf === pdf) layout();
}

// ---------- layout / zoom ----------
function pageDims(p) {
  const rot = (S.rotation % 180) !== 0;
  return rot ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}
function computeScale() {
  const availW = Math.max(200, el.scroll.clientWidth - 32);
  const availH = Math.max(200, el.scroll.clientHeight - 32);
  if (S.zoomMode === "width" || S.zoomMode === "page") {
    // use the widest of the first few known pages (docs are usually uniform)
    let maxW = 0, maxH = 0;
    for (const p of S.pages.slice(0, 50)) { const d = pageDims(p); maxW = Math.max(maxW, d.w); maxH = Math.max(maxH, d.h); }
    if (!maxW) return 1;
    if (S.zoomMode === "width") return availW / maxW;
    return Math.min(availW / maxW, availH / maxH);
  }
  return S.scale;
}
function scheduleLayout() {
  clearTimeout(S.layoutTimer);
  S.layoutTimer = setTimeout(() => layout(), 60);
}
function layout(initial = false) {
  if (!S.pdf) return;
  const newScale = computeScale();
  const scaleChanged = Math.abs(newScale - S.scale) > 1e-4;
  // remember position
  let anchor = null;
  if (!initial && S.tops.length) {
    const i = S.currentPage - 1;
    const frac = S.heights[i] ? (el.scroll.scrollTop - S.tops[i]) / S.heights[i] : 0;
    anchor = { i, frac };
  }
  S.scale = newScale;
  for (const p of S.pages) {
    const d = pageDims(p);
    const w = Math.floor(d.w * S.scale), h = Math.floor(d.h * S.scale);
    p.div.style.width = w + "px"; p.div.style.height = h + "px";
    p.div.style.setProperty("--scale-factor", S.scale);
    if (scaleChanged || p.renderRotation !== S.rotation) invalidateRender(p);
  }
  measureTops();
  if (anchor) el.scroll.scrollTop = S.tops[anchor.i] + anchor.frac * S.heights[anchor.i];
  updateZoomSelect();
  for (const p of S.pages) if (p.visible) ensureRendered(p);
  updateCurrentPage();
}
function measureTops() {
  S.tops = S.pages.map((p) => p.div.offsetTop);
  S.heights = S.pages.map((p) => p.div.offsetHeight);
}
function invalidateRender(p) {
  if (p.renderTask) { try { p.renderTask.cancel(); } catch { /* ignore */ } p.renderTask = null; }
  p.rendered = false;
  p.renderScale = 0;
}
function unrender(p) {
  invalidateRender(p);
  p.div.classList.remove("rendered");
  if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
  if (p.textDiv) { p.textDiv.remove(); p.textDiv = null; p.textLayer = null; }
  if (p.annotDiv) { p.annotDiv.remove(); p.annotDiv = null; }
  if (p.inkSurface) { p.inkSurface.destroy(); p.inkSurface = null; }
  if (p.inkCanvas) { p.inkCanvas.width = 0; p.inkCanvas.remove(); p.inkCanvas = null; }
}
function updateZoomSelect() {
  const custom = el.zoomSelect.querySelector('option[value="custom"]');
  if (S.zoomMode === "width" || S.zoomMode === "page") { el.zoomSelect.value = S.zoomMode; custom.hidden = true; return; }
  const pct = Math.round(S.scale * 100);
  const preset = [...el.zoomSelect.options].find((o) => o.value !== "custom" && o.value !== "width" && o.value !== "page" && Math.round(parseFloat(o.value) * 100) === pct);
  if (preset) { el.zoomSelect.value = preset.value; custom.hidden = true; }
  else { custom.hidden = false; custom.textContent = `${pct}%`; el.zoomSelect.value = "custom"; }
}
function setZoom(mode, value) {
  if (mode === "width" || mode === "page") S.zoomMode = mode;
  else { S.zoomMode = "custom"; S.scale = clamp(value, 0.2, 6); }
  layout();
  updateDoc({ zoomMode: S.zoomMode });
}
function zoomBy(f) { setZoom("custom", (S.zoomMode === "custom" ? S.scale : computeScale()) * f); }
function rotate() { S.rotation = (S.rotation + 90) % 360; layout(); }

// ---------- rendering ----------
function setupObserver() {
  if (S.io) S.io.disconnect();
  S.io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = S.pages[parseInt(e.target.dataset.page, 10) - 1];
      if (!p) continue;
      p.visible = e.isIntersecting;
      if (e.isIntersecting) ensureRendered(p); else unrender(p);
    }
  }, { root: el.scroll, rootMargin: "120% 0px 120% 0px", threshold: 0 });
  for (const p of S.pages) S.io.observe(p.div);
}

async function ensureRendered(p) {
  if (!S.pdf) return;
  if (p.rendered && p.renderScale === S.scale && p.renderRotation === S.rotation) return;
  if (p.renderTask) return; // in flight at current scale (invalidate cancels stale ones)
  const pdf = S.pdf;
  const scale = S.scale, rotation = S.rotation;
  try {
    if (!p.page) {
      p.page = await pdf.getPage(p.num);
      const v = p.page.getViewport({ scale: 1 });
      if (Math.abs(v.width - p.w) > 0.5 || Math.abs(v.height - p.h) > 0.5) { p.w = v.width; p.h = v.height; scheduleLayout(); }
    }
    if (S.pdf !== pdf || scale !== S.scale || rotation !== S.rotation) return;
    const viewport = p.page.getViewport({ scale, rotation });
    // canvas
    const dpr = window.devicePixelRatio || 1;
    const maxPixels = 24e6;
    let outputScale = dpr;
    if (viewport.width * viewport.height * dpr * dpr > maxPixels) outputScale = Math.sqrt(maxPixels / (viewport.width * viewport.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    const ctx = canvas.getContext("2d", { alpha: false });
    const task = p.page.render({ canvasContext: ctx, viewport, transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null });
    p.renderTask = task;
    await task.promise;
    p.renderTask = null;
    if (S.pdf !== pdf || scale !== S.scale || rotation !== S.rotation) { canvas.width = 0; return; }
    if (p.canvas) p.canvas.remove();
    p.canvas = canvas;
    p.div.insertBefore(canvas, p.div.firstChild);
    p.rendered = true; p.renderScale = scale; p.renderRotation = rotation;
    p.div.classList.add("rendered");
    // text layer
    if (p.textDiv) p.textDiv.remove();
    const textDiv = document.createElement("div");
    textDiv.className = "textLayer";
    p.div.appendChild(textDiv);
    p.textDiv = textDiv;
    try {
      const tl = new pdfjsLib.TextLayer({ textContentSource: p.page.streamTextContent({ includeMarkedContent: false }), container: textDiv, viewport });
      p.textLayer = tl;
      await tl.render();
      const eoc = document.createElement("div"); eoc.className = "endOfContent"; textDiv.appendChild(eoc);
      if (S.find.open && S.find.query) highlightPage(p);
    } catch (e) { if (!(e instanceof pdfjsLib.AbortException)) console.warn("text layer", e); }
    // link annotations
    renderLinks(p, viewport).catch(() => {});
    // ink layer (handwriting on the page)
    mountPageInk(p, viewport);
  } catch (e) {
    p.renderTask = null;
    if (!(e instanceof pdfjsLib.RenderingCancelledException)) console.warn("render page", p.num, e);
  }
}

async function renderLinks(p, viewport) {
  const annots = await p.page.getAnnotations({ intent: "display" });
  const links = annots.filter((a) => a.subtype === "Link" && (a.url || a.dest || a.action));
  if (!links.length) return;
  if (p.annotDiv) p.annotDiv.remove();
  const layer = document.createElement("div");
  layer.className = "annotLayer";
  for (const a of links) {
    const r = pdfjsLib.Util.normalizeRect(viewport.convertToViewportRectangle(a.rect));
    const link = document.createElement("a");
    link.style.left = r[0] + "px"; link.style.top = r[1] + "px";
    link.style.width = Math.max(1, r[2] - r[0]) + "px"; link.style.height = Math.max(1, r[3] - r[1]) + "px";
    if (a.url) { link.href = a.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.title = a.url; }
    else if (a.dest) { link.href = "#"; link.title = "Go to destination"; link.addEventListener("click", (ev) => { ev.preventDefault(); navigateToDest(a.dest); }); }
    else if (a.action) { link.href = "#"; link.title = a.action; link.addEventListener("click", (ev) => { ev.preventDefault(); handleNamedAction(a.action); }); }
    layer.appendChild(link);
  }
  p.div.appendChild(layer);
  p.annotDiv = layer;
}
function handleNamedAction(name) {
  switch (name) {
    case "NextPage": goToPage(S.currentPage + 1); break;
    case "PrevPage": goToPage(S.currentPage - 1); break;
    case "FirstPage": goToPage(1); break;
    case "LastPage": goToPage(S.numPages); break;
    case "GoBack": history.back(); break;
    default: break;
  }
}

async function resolveDest(dest) {
  try {
    let d = dest;
    if (typeof d === "string") d = await S.pdf.getDestination(d);
    if (!Array.isArray(d) || !d.length) return null;
    const ref = d[0];
    let pageIndex;
    if (typeof ref === "object" && ref !== null) pageIndex = await S.pdf.getPageIndex(ref);
    else if (typeof ref === "number") pageIndex = ref;
    else return null;
    let top = null;
    const kind = d[1]?.name;
    if ((kind === "XYZ" && typeof d[3] === "number") || (kind === "FitH" && typeof d[2] === "number") || (kind === "FitBH" && typeof d[2] === "number")) {
      top = kind === "XYZ" ? d[3] : d[2];
    }
    return { pageIndex, top };
  } catch { return null; }
}
async function navigateToDest(dest) {
  const r = await resolveDest(dest);
  if (!r) return;
  const p = S.pages[r.pageIndex];
  if (!p) return;
  let offset = 0;
  if (r.top != null && S.rotation === 0) offset = Math.max(0, (p.h - r.top) * S.scale);
  goToPage(r.pageIndex + 1, { offset });
}

// ---------- navigation ----------
function goToPage(n, { instant = false, offset = 0 } = {}) {
  n = clamp(Math.round(n), 1, S.numPages || 1);
  const p = S.pages[n - 1];
  if (!p) return;
  const top = p.div.offsetTop - 12 + offset;
  el.scroll.scrollTo({ top, behavior: instant ? "auto" : "auto" });
  S.currentPage = n;
  onCurrentPageChanged();
}
function updateCurrentPage() {
  if (!S.pages.length) return;
  const st = el.scroll.scrollTop, H = el.scroll.clientHeight, sb = st + H;
  // binary search first page whose bottom > st
  let lo = 0, hi = S.pages.length - 1, first = S.pages.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (S.tops[mid] + S.heights[mid] > st) { first = mid; hi = mid - 1; } else lo = mid + 1; }
  let best = first, bestVis = -1;
  for (let i = first; i < S.pages.length && S.tops[i] < sb; i++) {
    const vis = Math.min(sb, S.tops[i] + S.heights[i]) - Math.max(st, S.tops[i]);
    if (vis > bestVis + 1) { bestVis = vis; best = i; }
  }
  const n = best + 1;
  if (n !== S.currentPage) { S.currentPage = n; onCurrentPageChanged(); }
}
function onCurrentPageChanged() {
  el.pageInput.value = String(S.currentPage);
  for (const d of el.pages.querySelectorAll(".page.current")) d.classList.remove("current");
  S.pages[S.currentPage - 1]?.div.classList.add("current");
  if (!S.pinned && S.notePage !== 0) setNotePage(S.currentPage);
  updateOutlineCurrent();
  persistLastPage();
}
function updateDoc(patch) {
  if (!S.fp) return;
  S.doc = { ...(S.doc || { fp: S.fp, created: Date.now() }), ...patch, fp: S.fp, lastOpened: Date.now() };
  return db.putDoc(S.doc); // single put, no read — survives pagehide
}
let lastPageTimer = null, lastPagePersisted = 0;
function persistLastPage(now = false) {
  clearTimeout(lastPageTimer);
  const write = () => { if (S.fp && lastPagePersisted !== S.currentPage) { lastPagePersisted = S.currentPage; updateDoc({ lastPage: S.currentPage }); } };
  if (now) write(); else lastPageTimer = setTimeout(write, 150);
}

// ---------- notes ----------
function noteLabel(n) { return n === 0 ? "Document notes" : `Page ${n}`; }
function pageHasContent(n) { return S.notedPages.has(n) || S.ink.has(`note:${n}`) || S.ink.has(`page:${n}`); }
function contentPages() {
  const set = new Set(S.notedPages);
  for (const k of S.ink.keys()) set.add(parseInt(k.split(":")[1], 10));
  return set;
}
function updateAllCount() { const n = [...contentPages()].filter((p) => p >= 0).length; el.allCount.textContent = n ? String(n) : ""; }
function updateModeDots() {
  el.btnModeText.classList.toggle("has", !!(S.noteCache.get(S.notePage) || "").trim());
  el.btnModeInk.classList.toggle("has", !!S.ink.get(`note:${S.notePage}`)?.length);
}
async function setNotePage(n, { force = false } = {}) {
  if (!force && n === S.notePage && S.noteLoadedFor === n) return;
  await saveNow();
  S.notePage = n;
  el.npPageLabel.textContent = noteLabel(n);
  el.npDocBtn.classList.toggle("active", n === 0);
  const text = S.noteCache.get(n) || ""; // cache holds every note of this doc (loaded at open, kept in sync on save)
  el.noteText.value = text;
  S.noteLoadedFor = n; S.dirty = false;
  updateWordCount();
  el.saveStatus.textContent = text ? "Saved" : "";
  if (!el.notePreview.hidden) renderPreview();
  renderNoteStrip();
  updateAllListCurrent();
  updateModeDots();
  refreshSketch();
}
function scheduleSave() {
  S.dirty = true;
  el.saveStatus.textContent = "Editing…";
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  clearTimeout(S.saveTimer);
  if (!S.dirty || !S.fp || S.noteLoadedFor == null) return;
  const page = S.noteLoadedFor, text = el.noteText.value;
  S.dirty = false;
  const had = S.notedPages.has(page);
  const has = !!text.trim();
  if (has) { S.notedPages.add(page); S.noteCache.set(page, text); } else { S.notedPages.delete(page); S.noteCache.delete(page); }
  try {
    await db.putNote(S.fp, page, text);
    el.saveStatus.textContent = has ? `Saved ${fmtTime(Date.now())}` : "";
  } catch (e) { el.saveStatus.textContent = "Save failed"; console.error(e); }
  if (had !== has) {
    S.pages[page - 1]?.div.classList.toggle("has-note", has);
    updateAllCount();
    updateDoc({ notesCount: contentPages().size });
    renderNoteStrip();
    updateModeDots();
  }
  if (document.querySelector('.tab-panel[data-panel="all"]').classList.contains("active")) renderAllList();
}
function updateWordCount() {
  const t = el.noteText.value.trim();
  const words = t ? t.split(/\s+/).length : 0;
  el.wordCount.textContent = words ? `${words} word${words === 1 ? "" : "s"}` : "";
}
function emptyEl(text) { const d = document.createElement("div"); d.className = "empty"; d.textContent = text; return d; }
function renderPreview() {
  // renderMarkdown escapes all input before adding its own tags; parse via DOMParser and adopt the nodes.
  const doc = new DOMParser().parseFromString(renderMarkdown(el.noteText.value), "text/html");
  el.notePreview.replaceChildren(...doc.body.childNodes);
}
function togglePreview(force) {
  const show = force != null ? force : el.notePreview.hidden;
  if (show) { renderPreview(); el.notePreview.hidden = false; el.noteText.hidden = true; }
  else { el.notePreview.hidden = true; el.noteText.hidden = false; el.noteText.focus(); }
  $("btnPreview").classList.toggle("active", show);
}
function renderNoteStrip() {
  const N = S.numPages;
  if (!N) { el.noteStrip.textContent = ""; return; }
  const ticks = Math.min(N, 240);
  const per = N / ticks;
  const frag = document.createDocumentFragment();
  for (let t = 0; t < ticks; t++) {
    const from = Math.floor(t * per) + 1, to = Math.max(from, Math.floor((t + 1) * per));
    const i = document.createElement("i");
    let noted = false, firstNoted = 0;
    for (let pg = from; pg <= to; pg++) if (pageHasContent(pg)) { noted = true; firstNoted = pg; break; }
    if (noted) i.classList.add("noted");
    if (S.notePage >= from && S.notePage <= to) i.classList.add("cur");
    i.title = from === to ? `Page ${from}` : `Pages ${from}–${to}`;
    i.dataset.page = String(firstNoted || from);
    frag.appendChild(i);
  }
  el.noteStrip.replaceChildren(frag);
}
function jumpNoted(dir) {
  const pages = [...contentPages()].filter((p) => p > 0).sort((a, b) => a - b);
  if (!pages.length) { toast("No page notes yet"); return; }
  const cur = S.notePage || S.currentPage;
  const next = dir > 0 ? pages.find((p) => p > cur) : [...pages].reverse().find((p) => p < cur);
  if (next == null) { toast(dir > 0 ? "No later notes" : "No earlier notes"); return; }
  goToPage(next);
  if (S.pinned || S.notePage === 0) { S.pinned = false; el.npPageBtn.classList.remove("pinned"); setNotePage(next); }
}
function insertAtCursor(ta, text) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.setRangeText(text, s, e, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}
function wrapSelection(ta, before, after = before) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e);
  ta.setRangeText(before + sel + after, s, e, "select");
  ta.setSelectionRange(s + before.length, s + before.length + sel.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}
function quoteSelectionIntoNotes() {
  const sel = window.getSelection();
  const text = sel?.toString().replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  if (!text) { toast("Select some text in the PDF first"); return; }
  const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  const pageDiv = node?.closest?.(".page");
  const page = pageDiv ? parseInt(pageDiv.dataset.page, 10) : S.currentPage;
  const doInsert = () => {
    const ta = el.noteText;
    if (S.notePage !== 0 && S.notePage !== page) return;
    const prefix = ta.value.length && !ta.value.endsWith("\n") ? (ta.value.endsWith("\n\n") ? "" : "\n\n") : ta.value.length ? "\n" : "";
    const quote = `> ${text}${S.notePage === 0 ? ` (p.${page})` : ""}\n\n`;
    ta.setRangeText(prefix + quote, ta.value.length, ta.value.length, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    if (el.noteText.hidden) togglePreview(false);
    ta.focus();
    ta.scrollTop = ta.scrollHeight;
    toast(`Added to ${noteLabel(S.notePage).toLowerCase()}`);
  };
  if (S.notePage === 0 || S.notePage === page) doInsert();
  else { setNotePage(page).then(doInsert); }
  sel.removeAllRanges();
  el.selBubble.hidden = true;
}

// All-notes tab
function renderAllList() {
  const q = el.allFilter.value.trim().toLowerCase();
  const entries = [...contentPages()].sort((a, b) => a - b).map((pg) => [pg, S.noteCache.get(pg) || ""]).filter(([, t]) => !q || t.toLowerCase().includes(q));
  if (!entries.length) { el.allList.replaceChildren(emptyEl(q ? "No notes match." : "No notes yet. Start typing on the Page notes tab.")); return; }
  const frag = document.createDocumentFragment();
  for (const [page, text] of entries) {
    const card = document.createElement("div");
    card.className = "note-card" + (page === S.notePage ? " cur" : "");
    card.dataset.page = String(page);
    const head = document.createElement("div"); head.className = "nc-head";
    const b = document.createElement("b"); b.textContent = noteLabel(page);
    if (S.ink.has(`note:${page}`)) { const t = document.createElement("span"); t.className = "nc-tag"; t.textContent = "✎ sketch"; b.appendChild(t); }
    if (S.ink.has(`page:${page}`)) { const t = document.createElement("span"); t.className = "nc-tag"; t.textContent = "✎ on page"; b.appendChild(t); }
    const w = document.createElement("span"); const wc = text.trim() ? text.trim().split(/\s+/).length : 0; w.textContent = wc ? `${wc} word${wc === 1 ? "" : "s"}` : "";
    head.append(b, w);
    const body = document.createElement("div"); body.className = "nc-body" + (text.length > 320 || text.split("\n").length > 6 ? " long" : "");
    body.textContent = text ? (text.length > 700 ? text.slice(0, 700) + "…" : text) : "(handwritten only)";
    card.append(head, body);
    card.addEventListener("click", () => {
      if (page > 0) goToPage(page);
      if (S.pinned || page === 0 || S.notePage === 0) { S.pinned = page !== 0 && S.pinned; el.npPageBtn.classList.toggle("pinned", S.pinned); }
      setNotePage(page);
      switchTab("page");
      el.noteText.focus();
    });
    frag.appendChild(card);
  }
  el.allList.replaceChildren(frag);
}
function updateAllListCurrent() {
  for (const c of el.allList.querySelectorAll(".note-card")) c.classList.toggle("cur", parseInt(c.dataset.page, 10) === S.notePage);
}
function switchTab(name) {
  for (const t of document.querySelectorAll(".notes-tabs .tab")) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of document.querySelectorAll(".tab-panel")) p.classList.toggle("active", p.dataset.panel === name);
  if (name === "all") renderAllList();
}

// ---------- ink: shared ----------
function inkKey(target, page) { return `${target}:${page}`; }
function getInk(target, page) { return S.ink.get(inkKey(target, page)) || []; }
function setInk(target, page, strokes) {
  const key = inkKey(target, page);
  if (strokes && strokes.length) S.ink.set(key, strokes); else S.ink.delete(key);
}
function markInkDirty(target, page) {
  S.inkDirty.add(inkKey(target, page));
  clearTimeout(S.inkSaveTimer);
  S.inkSaveTimer = setTimeout(saveInkNow, 400);
  // indicators
  const has = S.ink.has(inkKey(target, page));
  if (target === "page") S.pages[page - 1]?.div.classList.toggle("has-ink", has);
  updateAllCount(); renderNoteStrip(); updateModeDots();
  updateDoc({ notesCount: contentPages().size });
  if (document.querySelector('.tab-panel[data-panel="all"]').classList.contains("active")) renderAllList();
}
async function saveInkNow() {
  clearTimeout(S.inkSaveTimer);
  if (!S.fp || !S.inkDirty.size) return;
  const keys = [...S.inkDirty]; S.inkDirty.clear();
  for (const k of keys) {
    const [target, pg] = k.split(":");
    try { await db.putInk(S.fp, target, parseInt(pg, 10), S.ink.get(k) || []); } catch (e) { console.error("ink save", e); S.inkDirty.add(k); }
  }
}
function activeInkSurface() {
  if (S.annotating && !(S.noteMode === "ink" && el.notesPane.contains(document.activeElement))) return S.pages[S.currentPage - 1]?.inkSurface || S.lastInkSurface;
  if (S.noteMode === "ink") return S.sketchSurface;
  return S.lastInkSurface;
}
onInkStateChange(() => { document.body.classList.toggle("tool-eraser", inkState.tool === "eraser"); });

// ---------- ink: sketch pad in the notes pane ----------
function sketchUnit() { return Math.max(0.2, el.sketchCanvas.clientWidth / SKETCH_UNITS); }
function setupSketch() {
  const canvas = el.sketchCanvas;
  S.sketchSurface = new InkSurface({
    canvas,
    toLogical: (cx, cy) => { const u = sketchUnit(); return [cx / u, cy / u]; },
    toCanvas: (lx, ly) => { const u = sketchUnit(); return [lx * u, ly * u]; },
    lineScale: () => sketchUnit(),
    getStrokes: () => getInk("note", S.notePage),
    setStrokes: (st) => setInk("note", S.notePage, st),
    onChange: () => { markInkDirty("note", S.notePage); growSketch(); },
    onPaper: false,
    touchDraws: () => settings.touchDraws !== false,
  });
  canvas.addEventListener("pointerdown", () => { S.lastInkSurface = S.sketchSurface; });
  inkToolbars.push(buildInkToolbar(el.noteInkBar, {
    undo: () => S.sketchSurface.undo(), redo: () => S.sketchSurface.redo(),
    clear: () => { if (confirm("Clear this page's sketch?")) S.sketchSurface.clear(); },
    extra: [{
      title: "Paper: lines / grid / dots / blank",
      paths: ["M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M4 10h16M4 14h16"],
      onClick: () => { const order = ["lines", "grid", "dots", "blank"]; saveSetting({ paper: order[(order.indexOf(settings.paper) + 1) % order.length] }); },
    }],
  }));
  new ResizeObserver(() => refreshSketch()).observe(el.sketchWrap);
}
function growSketch() {
  const u = sketchUnit();
  let maxY = 0;
  for (const s of getInk("note", S.notePage)) for (const pt of s.points) if (pt[1] > maxY) maxY = pt[1];
  const need = Math.max(el.sketchWrap.clientHeight, (maxY + 260) * u);
  const cur = parseFloat(el.sketchCanvas.style.height) || 0;
  if (Math.abs(need - cur) > 2) { el.sketchCanvas.style.height = need + "px"; S.sketchSurface.resize(); }
}
function refreshSketch() {
  if (!S.sketchSurface || el.sketch.hidden) return;
  el.sketchCanvas.style.setProperty("--unit", sketchUnit() + "px");
  growSketch();
  S.sketchSurface.resize();
}
function setNoteMode(mode, { persist = true } = {}) {
  S.noteMode = mode;
  const ink = mode === "ink";
  el.noteEditor.hidden = ink; el.sketch.hidden = !ink;
  el.btnModeText.classList.toggle("active", !ink); el.btnModeInk.classList.toggle("active", ink);
  $("btnPreview").hidden = ink;
  if (!ink) hideInkCursor();
  if (ink) { S.sketchSurface?.resetHistory(); requestAnimationFrame(refreshSketch); }
  if (persist) saveSetting({ noteMode: mode });
}

// ---------- ink: drawing on the PDF pages ----------
function mountPageInk(p, viewport) {
  if (p.inkSurface) { p.inkSurface.destroy(); p.inkSurface = null; }
  if (p.inkCanvas) p.inkCanvas.remove();
  const canvas = document.createElement("canvas");
  canvas.className = "inkLayer";
  p.div.appendChild(canvas);
  p.inkCanvas = canvas;
  const num = p.num;
  p.inkSurface = new InkSurface({
    canvas,
    toLogical: (cx, cy) => viewport.convertToPdfPoint(cx, cy),
    toCanvas: (lx, ly) => viewport.convertToViewportPoint(lx, ly),
    lineScale: () => viewport.scale,
    getStrokes: () => getInk("page", num),
    setStrokes: (st) => setInk("page", num, st),
    onChange: () => markInkDirty("page", num),
    onPaper: true,
    isEnabled: () => S.annotating,
    touchDraws: () => settings.touchDraws !== false,
  });
  canvas.addEventListener("pointerdown", () => { S.lastInkSurface = p.inkSurface; });
}
function setAnnotating(on) {
  S.annotating = !!on;
  document.body.classList.toggle("annotating", S.annotating);
  $("btnAnnotate").classList.toggle("active", S.annotating);
  el.pageInkBar.hidden = !S.annotating;
  if (!S.annotating) hideInkCursor();
  if (S.annotating) { el.selBubble.hidden = true; window.getSelection()?.removeAllRanges(); el.scroll.focus(); }
}
function setupPageInkBar() {
  inkToolbars.push(buildInkToolbar(el.pageInkBar, {
    undo: () => S.pages[S.currentPage - 1]?.inkSurface?.undo(),
    redo: () => S.pages[S.currentPage - 1]?.inkSurface?.redo(),
    clear: () => { if (confirm(`Clear handwriting on page ${S.currentPage}?`)) S.pages[S.currentPage - 1]?.inkSurface?.clear(); },
    extra: [{
      title: "Done annotating (A / Esc)",
      paths: ["M5 12l5 5L20 7"],
      onClick: () => setAnnotating(false),
    }],
  }, { onPaper: true }));
}

// ---------- ink: export ----------
async function pageInkPng(num, { withPage = true } = {}) {
  const p = S.pages[num - 1];
  const strokes = getInk("page", num);
  if (!p.page) p.page = await S.pdf.getPage(num);
  const scale = 2;
  const vp = p.page.getViewport({ scale });
  const c = document.createElement("canvas"); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext("2d");
  if (withPage) await p.page.render({ canvasContext: ctx, viewport: vp }).promise;
  else { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
  drawStrokes(ctx, strokes, (x, y) => vp.convertToViewportPoint(x, y), scale, true);
  return new Promise((r) => c.toBlob(r, "image/png"));
}
async function sketchPng(page) {
  const strokes = getInk("note", page);
  let maxY = 0; for (const s of strokes) for (const pt of s.points) maxY = Math.max(maxY, pt[1]);
  const u = 2; // 2 px per unit → 1200px wide
  return strokesToPng(strokes, { width: SKETCH_UNITS * u, height: Math.ceil((maxY + 40) * u), toCanvas: (x, y) => [x * u, y * u], lineScale: u, background: "#ffffff", onPaper: true });
}
function downloadBlob(name, blob) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function exportInk(pages) {
  const base = safeName(S.doc?.title || S.filename);
  let n = 0;
  for (const pg of pages) {
    if (S.ink.has(`page:${pg}`)) { downloadBlob(`${base}-p${pg}-annotated.png`, await pageInkPng(pg)); n++; await new Promise((r) => setTimeout(r, 250)); }
    if (S.ink.has(`note:${pg}`)) { downloadBlob(`${base}-p${pg}-sketch.png`, await sketchPng(pg)); n++; await new Promise((r) => setTimeout(r, 250)); }
  }
  toast(n ? `Exported ${n} PNG${n === 1 ? "" : "s"}` : "No handwriting to export");
}

// ---------- outline ----------
async function loadOutline() {
  el.outline.replaceChildren(emptyEl("No outline in this document."));
  S.outlineItems = []; S.outlinePages = [];
  let outline = null;
  try { outline = await S.pdf.getOutline(); } catch { /* ignore */ }
  if (!outline || !outline.length) return;
  const root = document.createElement("ul");
  const build = (items, parent, depth) => {
    for (const it of items) {
      const li = document.createElement("li");
      const row = document.createElement("div"); row.className = "ol-row";
      const tog = document.createElement("button"); tog.className = "ol-toggle" + (it.items?.length ? "" : " leaf");
      tog.appendChild(icon(["M6 9l6 6 6-6"]));
      tog.addEventListener("click", () => li.classList.toggle("collapsed"));
      const btn = document.createElement("button"); btn.className = "ol-link"; btn.textContent = it.title || "(untitled)";
      const idx = S.outlineItems.length;
      S.outlineItems.push({ item: it, btn });
      btn.addEventListener("click", () => { if (it.url) window.open(it.url, "_blank", "noopener"); else if (it.dest) navigateToDest(it.dest); });
      row.append(tog, btn); li.appendChild(row);
      if (it.items?.length) { const ul = document.createElement("ul"); build(it.items, ul, depth + 1); li.appendChild(ul); if (depth >= 1) li.classList.add("collapsed"); }
      parent.appendChild(li);
      void idx;
    }
  };
  build(outline, root, 0);
  el.outline.replaceChildren(root);
  // resolve pages in background for "current section" highlighting
  const pdf = S.pdf;
  for (let i = 0; i < S.outlineItems.length && S.pdf === pdf; i++) {
    const { item } = S.outlineItems[i];
    const r = item.dest ? await resolveDest(item.dest) : null;
    S.outlinePages[i] = r ? r.pageIndex + 1 : null;
  }
  updateOutlineCurrent();
}
function updateOutlineCurrent() {
  if (!S.outlineItems.length) return;
  let best = -1;
  for (let i = 0; i < S.outlineItems.length; i++) { const pg = S.outlinePages[i]; if (pg != null && pg <= S.currentPage) best = i; }
  S.outlineItems.forEach((o, i) => o.btn.classList.toggle("cur", i === best));
}

// ---------- find ----------
async function pageText(n) {
  const cache = S.find.textCache;
  if (cache.has(n)) return cache.get(n);
  const p = S.pages[n - 1];
  if (!p.page) p.page = await S.pdf.getPage(n);
  const tc = await p.page.getTextContent();
  const items = tc.items.map((it) => it.str + (it.hasEOL ? "\n" : ""));
  const raw = items.join("");
  const rec = { raw, items: tc.items.map((it) => it.str), norm: raw.toLowerCase() };
  cache.set(n, rec);
  return rec;
}
function openFind() {
  S.find.open = true; el.findbar.hidden = false; el.findInput.focus(); el.findInput.select();
  $("btnFind").classList.add("active");
}
function closeFind() {
  S.find.open = false; el.findbar.hidden = true; $("btnFind").classList.remove("active");
  clearHighlights(); el.scroll.focus();
}
function clearHighlights() { for (const s of el.pages.querySelectorAll(".textLayer span.hl")) s.classList.remove("hl", "hl-active"); }
function highlightPage(p, activeIdx = -1) {
  if (!p.textDiv || !S.find.query) return;
  const q = S.find.query.toLowerCase();
  let k = 0;
  for (const span of p.textDiv.querySelectorAll("span")) {
    if (span.classList.contains("hl")) span.classList.remove("hl", "hl-active");
    if (span.textContent.toLowerCase().includes(q)) {
      span.classList.add("hl");
      if (k === activeIdx) span.classList.add("hl-active");
      k++;
    }
  }
}
const runFind = debounce(async () => {
  const q = el.findInput.value.trim();
  const token = ++S.find.token;
  S.find.query = q; S.find.results = []; S.find.perPage.clear(); S.find.cur = -1;
  clearHighlights();
  if (q.length < 2) { el.findCount.textContent = ""; return; }
  el.findCount.textContent = "Searching…";
  const nq = q.toLowerCase();
  const start = S.currentPage;
  const order = [];
  for (let i = 0; i < S.numPages; i++) order.push(((start - 1 + i) % S.numPages) + 1);
  let done = 0;
  for (const n of order) {
    if (token !== S.find.token) return;
    let rec; try { rec = await pageText(n); } catch { continue; }
    let idx = rec.norm.indexOf(nq), c = 0;
    while (idx !== -1) { S.find.results.push({ page: n, index: idx, k: c++ }); idx = rec.norm.indexOf(nq, idx + nq.length); }
    if (c) S.find.perPage.set(n, c);
    done++;
    if (done % 8 === 0) { el.findCount.textContent = `${S.find.results.length}…`; if (S.find.results.length && S.find.cur === -1) gotoMatch(0); await new Promise((r) => setTimeout(r, 0)); }
  }
  if (token !== S.find.token) return;
  S.find.results.sort((a, b) => a.page - b.page || a.index - b.index);
  if (!S.find.results.length) el.findCount.textContent = "No matches";
  else if (S.find.cur === -1) gotoMatch(0);
  else { const cur = S.find.results.findIndex((r) => r.page === S.find.curPage && r.k === S.find.curK); S.find.cur = Math.max(0, cur); updateFindCount(); }
  for (const p of S.pages) if (p.textDiv) highlightPage(p, p.num === S.find.curPage ? S.find.curK : -1);
}, 250);
function updateFindCount() { el.findCount.textContent = S.find.results.length ? `${S.find.cur + 1} of ${S.find.results.length}` : "No matches"; }
function gotoMatch(i) {
  const R = S.find.results;
  if (!R.length) return;
  S.find.cur = ((i % R.length) + R.length) % R.length;
  const m = R[S.find.cur];
  S.find.curPage = m.page; S.find.curK = m.k;
  const p = S.pages[m.page - 1];
  // scroll to page, then to span if we can find it
  if (S.currentPage !== m.page || !p.textDiv) goToPage(m.page);
  updateFindCount();
  const tryScroll = (attempt = 0) => {
    for (const q of S.pages) if (q.textDiv) highlightPage(q, q.num === m.page ? m.k : -1);
    const active = p.textDiv?.querySelector("span.hl-active");
    if (active) {
      const r = active.getBoundingClientRect(), sr = el.scroll.getBoundingClientRect();
      if (r.top < sr.top + 40 || r.bottom > sr.bottom - 40) el.scroll.scrollTop += r.top - sr.top - sr.height / 3;
    } else if (attempt < 8) setTimeout(() => tryScroll(attempt + 1), 120);
  };
  tryScroll();
}

// ---------- selection bubble ----------
function positionBubble() {
  if (!settings.autoQuote) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { el.selBubble.hidden = true; return; }
  const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  if (!node?.closest?.(".textLayer")) { el.selBubble.hidden = true; return; }
  const text = sel.toString().trim();
  if (!text) { el.selBubble.hidden = true; return; }
  const rects = sel.getRangeAt(0).getClientRects();
  const r = rects.length ? rects[rects.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
  const pr = el.pdfPane.getBoundingClientRect();
  el.selBubble.hidden = false;
  const bw = el.selBubble.offsetWidth;
  const x = clamp(r.left + r.width / 2 - pr.left, bw / 2 + 6, pr.width - bw / 2 - 6);
  const y = clamp(r.top - pr.top, 44, pr.height);
  el.selBubble.style.left = x + "px";
  el.selBubble.style.top = y + "px";
}

// ---------- recents (landing) ----------
async function refreshRecents() {
  const docs = await db.listDocs();
  if (!docs.length) { el.recentList.replaceChildren(emptyEl("Nothing yet.")); return; }
  const frag = document.createDocumentFragment();
  for (const d of docs.slice(0, 40)) {
    const row = document.createElement("div"); row.className = "recent";
    const main = document.createElement("div"); main.className = "r-main";
    const t = document.createElement("div"); t.className = "r-title"; t.textContent = d.title || d.filename || "Untitled";
    const m = document.createElement("div"); m.className = "r-meta";
    const cnt = await db.countNotesForDoc(d.fp);
    m.textContent = `${cnt} note${cnt === 1 ? "" : "s"} · ${d.pageCount || "?"} pages · last opened ${new Date(d.lastOpened || 0).toLocaleDateString()}${d.url ? " · " + d.url : " · (opened from local file picker)"}`;
    main.append(t, m);
    const acts = document.createElement("div"); acts.className = "r-actions";
    if (d.url) { const b = document.createElement("button"); b.textContent = "Open"; b.addEventListener("click", () => { location.href = `${location.pathname}?file=${d.url}`; }); acts.appendChild(b); }
    const ex = document.createElement("button"); ex.textContent = "Export .md";
    ex.addEventListener("click", async () => { const notes = await db.getNotesForDoc(d.fp); downloadText(`${safeName(d.title || d.filename)}-notes.md`, notesToMarkdown(d, notes)); });
    const del = document.createElement("button"); del.textContent = "Delete notes"; del.className = "danger";
    del.addEventListener("click", async () => { if (confirm(`Delete all notes for “${d.title || d.filename}”? This cannot be undone.`)) { await db.deleteDoc(d.fp); refreshRecents(); } });
    acts.append(ex, del);
    row.append(main, acts);
    frag.appendChild(row);
  }
  el.recentList.replaceChildren(frag);
}
function safeName(s) { return (s || "notes").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80); }
function downloadText(name, text, type = "text/markdown") {
  const blob = new Blob([text], { type: type + ";charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- menu actions ----------
async function menuAction(act) {
  el.menu.hidden = true;
  switch (act) {
    case "exportMd": { await saveNow(); await saveInkNow(); const notes = await db.getNotesForDoc(S.fp); const ink = await db.getInkForDoc(S.fp); downloadText(`${safeName(S.doc?.title || S.filename)}-notes.md`, notesToMarkdown(S.doc, notes, ink)); break; }
    case "exportJson": { await saveNow(); await saveInkNow(); const notes = await db.getNotesForDoc(S.fp); const ink = await db.getInkForDoc(S.fp); downloadText(`${safeName(S.doc?.title || S.filename)}-notes.json`, JSON.stringify({ version: 2, docs: [S.doc], notes, ink }, null, 2), "application/json"); break; }
    case "copyAll": { await saveNow(); const notes = await db.getNotesForDoc(S.fp); await navigator.clipboard.writeText(notesToMarkdown(S.doc, notes)); toast("Copied all notes as Markdown"); break; }
    case "download": {
      try {
        let blob;
        if (S.sourceData) blob = new Blob([S.sourceData], { type: "application/pdf" });
        else { const data = await S.pdf.getData(); blob = new Blob([data], { type: "application/pdf" }); }
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = S.filename; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (e) { toast("Download failed: " + e.message); }
      break;
    }
    case "chromeViewer": {
      if (!S.url) { toast("This PDF was opened from a local file picker; open it from its location instead."); break; }
      await saveNow();
      chrome.runtime.sendMessage({ type: "bypass", url: S.url });
      break;
    }
    case "print": {
      if (S.url) { chrome.runtime.sendMessage({ type: "bypass", url: S.url }); toast("Opening in Chrome's viewer — press Ctrl+P there"); }
      else toast("Download the PDF and print it from Chrome's viewer.");
      break;
    }
    case "exportInkPage": await saveInkNow(); await exportInk([S.notePage || S.currentPage]); break;
    case "exportInkAll": { await saveInkNow(); const pages = [...new Set([...S.ink.keys()].map((k) => parseInt(k.split(":")[1], 10)))].sort((a, b) => a - b); await exportInk(pages); break; }
    case "shortcuts": el.shortcuts.hidden = false; break;
    case "options": chrome.runtime.sendMessage({ type: "openOptions" }); break;
  }
}

// ---------- events ----------
function wireEvents() {
  // toolbar
  $("btnHome").addEventListener("click", async () => { await saveNow(); location.href = location.pathname; });
  $("btnPrev").addEventListener("click", () => goToPage(S.currentPage - 1));
  $("btnNext").addEventListener("click", () => goToPage(S.currentPage + 1));
  el.pageInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { const n = parseInt(el.pageInput.value, 10); if (n) goToPage(n); el.scroll.focus(); } if (e.key === "Escape") { el.pageInput.value = String(S.currentPage); el.scroll.focus(); } });
  el.pageInput.addEventListener("focus", () => el.pageInput.select());
  el.pageInput.addEventListener("blur", () => { el.pageInput.value = String(S.currentPage); });
  $("btnZoomIn").addEventListener("click", () => zoomBy(1.15));
  $("btnZoomOut").addEventListener("click", () => zoomBy(1 / 1.15));
  el.zoomSelect.addEventListener("change", () => { const v = el.zoomSelect.value; if (v === "width" || v === "page") setZoom(v); else if (v !== "custom") setZoom("custom", parseFloat(v)); el.scroll.focus(); });
  $("btnRotate").addEventListener("click", rotate);
  $("btnFind").addEventListener("click", () => (S.find.open ? closeFind() : openFind()));
  $("btnAnnotate").addEventListener("click", () => setAnnotating(!S.annotating));
  el.btnModeText.addEventListener("click", () => setNoteMode("text"));
  el.btnModeInk.addEventListener("click", () => setNoteMode("ink"));
  $("btnNight").addEventListener("click", () => { document.body.classList.toggle("night"); $("btnNight").classList.toggle("active", document.body.classList.contains("night")); });
  $("btnSide").addEventListener("click", () => saveSetting({ side: settings.side === "left" ? "right" : "left" }));
  $("btnNotesToggle").addEventListener("click", toggleNotes);
  $("btnTheme").addEventListener("click", () => { const order = ["system", "light", "dark"]; saveSetting({ theme: order[(order.indexOf(settings.theme) + 1) % 3] }); toast(`Theme: ${settings.theme}`); });
  $("btnMenu").addEventListener("click", (e) => { e.stopPropagation(); el.menu.hidden = !el.menu.hidden; });
  el.menu.addEventListener("click", (e) => { const b = e.target.closest("button[data-act]"); if (b) menuAction(b.dataset.act); });
  document.addEventListener("click", (e) => { if (!el.menu.hidden && !e.target.closest(".menu-wrap")) el.menu.hidden = true; });
  $("shortcutsClose").addEventListener("click", () => (el.shortcuts.hidden = true));
  el.shortcuts.addEventListener("click", (e) => { if (e.target === el.shortcuts) el.shortcuts.hidden = true; });

  // find
  el.findInput.addEventListener("input", runFind);
  el.findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); gotoMatch(S.find.cur + (e.shiftKey ? -1 : 1)); }
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  $("findNext").addEventListener("click", () => gotoMatch(S.find.cur + 1));
  $("findPrev").addEventListener("click", () => gotoMatch(S.find.cur - 1));
  $("findClose").addEventListener("click", closeFind);

  // scroll / resize
  let ticking = false;
  el.scroll.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; updateCurrentPage(); }); }
    if (!el.selBubble.hidden) el.selBubble.hidden = true;
  }, { passive: true });
  new ResizeObserver(() => { if (S.zoomMode === "width" || S.zoomMode === "page") scheduleLayout(); else measureTops(); }).observe(el.scroll);
  el.scroll.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  // text selection → bubble
  el.pages.addEventListener("mousedown", (e) => { const tl = e.target.closest(".textLayer"); if (tl) tl.classList.add("selecting"); });
  document.addEventListener("mouseup", () => {
    for (const t of el.pages.querySelectorAll(".textLayer.selecting")) t.classList.remove("selecting");
    setTimeout(positionBubble, 0);
  });
  document.addEventListener("selectionchange", () => { const s = window.getSelection(); if (!s || s.isCollapsed) el.selBubble.hidden = true; });
  $("selQuote").addEventListener("mousedown", (e) => e.preventDefault());
  $("selQuote").addEventListener("click", quoteSelectionIntoNotes);
  $("selCopy").addEventListener("mousedown", (e) => e.preventDefault());
  $("selCopy").addEventListener("click", async () => { const t = window.getSelection()?.toString(); if (t) { await navigator.clipboard.writeText(t); toast("Copied"); } el.selBubble.hidden = true; });

  // splitter
  el.splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const rect = el.split.getBoundingClientRect();
    const move = (ev) => {
      let frac = (ev.clientX - rect.left) / rect.width;
      if (settings.side === "right") frac = 1 - frac;
      frac = clamp(frac, 0.25, 0.85);
      settings.splitRatio = frac;
      document.documentElement.style.setProperty("--pdf-frac", frac);
    };
    const up = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      chrome.storage.sync.set({ splitRatio: settings.splitRatio });
      scheduleLayout();
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  });
  el.splitter.addEventListener("dblclick", () => saveSetting({ splitRatio: DEFAULT_SETTINGS.splitRatio }));

  // notes
  el.noteText.addEventListener("input", () => { scheduleSave(); updateWordCount(); });
  el.noteText.addEventListener("blur", () => saveNow());
  el.noteText.addEventListener("keydown", onNoteKeydown);
  el.notePreview.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-page]");
    if (a) { e.preventDefault(); goToPage(parseInt(a.dataset.page, 10)); }
  });
  el.npPageBtn.addEventListener("click", togglePin);
  el.npDocBtn.addEventListener("click", () => { if (S.notePage === 0) { setNotePage(S.currentPage); } else setNotePage(0); el.noteText.focus(); });
  $("btnPreview").addEventListener("click", () => togglePreview());
  $("btnPrevNoted").addEventListener("click", () => jumpNoted(-1));
  $("btnNextNoted").addEventListener("click", () => jumpNoted(1));
  el.noteStrip.addEventListener("click", (e) => { const i = e.target.closest("i"); if (i) { const pg = parseInt(i.dataset.page, 10); goToPage(pg); if (S.pinned || S.notePage === 0) { S.pinned = false; el.npPageBtn.classList.remove("pinned"); setNotePage(pg); } } });
  for (const t of document.querySelectorAll(".notes-tabs .tab")) t.addEventListener("click", () => switchTab(t.dataset.tab));
  el.allFilter.addEventListener("input", debounce(renderAllList, 120));

  // landing
  el.fileInput.addEventListener("change", () => { const f = el.fileInput.files?.[0]; if (f) openFile(f); el.fileInput.value = ""; });
  $("btnOpenExtPage").addEventListener("click", () => chrome.runtime.sendMessage({ type: "openExtensionsPage" }));
  $("btnGrantHost").addEventListener("click", async () => {
    // must run inside the click handler (user gesture)
    let ok = false;
    try { ok = await chrome.permissions.request({ origins: ["<all_urls>"] }); } catch (e) { console.warn(e); }
    if (ok) { el.hostPermWarn.hidden = true; chrome.runtime.sendMessage({ type: "syncRules" }); toast("Access granted — PDFs will now open here"); const u = parseFileParam(); if (u) location.reload(); }
    else toast("Permission not granted");
  });
  $("btnLibraryExport").addEventListener("click", async () => { const all = await db.exportAll(); downloadText(`margin-notes-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(all, null, 2), "application/json"); });
  for (const evt of ["dragenter", "dragover"]) document.addEventListener(evt, (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); el.dropZone.classList.add("over"); } });
  for (const evt of ["dragleave", "drop"]) document.addEventListener(evt, () => el.dropZone.classList.remove("over"));
  document.addEventListener("drop", (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (f) { e.preventDefault(); openFile(f); }
  });

  // global keys
  document.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("hashchange", () => { const p = parseHashPage(); if (p) goToPage(p); });
  window.addEventListener("pagehide", () => { persistLastPage(true); saveNow(); saveInkNow(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { persistLastPage(true); saveNow(); saveInkNow(); } });
}

function toggleNotes() {
  document.body.classList.toggle("notes-hidden");
  $("btnNotesToggle").classList.toggle("active", !document.body.classList.contains("notes-hidden"));
  scheduleLayout();
}
function togglePin() {
  S.pinned = !S.pinned;
  el.npPageBtn.classList.toggle("pinned", S.pinned);
  el.npPageBtn.title = S.pinned ? `Pinned to ${noteLabel(S.notePage)}. Click to follow the page you're reading.` : "Notes follow the page you're reading. Click to pin.";
  if (!S.pinned && S.notePage !== 0) setNotePage(S.currentPage);
  toast(S.pinned ? `Pinned notes to ${noteLabel(S.notePage).toLowerCase()}` : "Notes follow scrolling");
}
async function openFile(file) {
  const buf = await file.arrayBuffer();
  history.replaceState(null, "", location.pathname);
  await openFromData(new Uint8Array(buf), file.name);
}

function onNoteKeydown(e) {
  const ta = el.noteText;
  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) {
      const s = ta.selectionStart; const ls = ta.value.lastIndexOf("\n", s - 1) + 1;
      if (ta.value.startsWith("  ", ls)) { ta.setRangeText("", ls, ls + 2, "end"); ta.setSelectionRange(Math.max(ls, s - 2), Math.max(ls, s - 2)); ta.dispatchEvent(new Event("input", { bubbles: true })); }
    } else insertAtCursor(ta, "  ");
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
    const s = ta.selectionStart; const ls = ta.value.lastIndexOf("\n", s - 1) + 1;
    const line = ta.value.slice(ls, s);
    const m = /^(\s*)([-*+]\s(?:\[[ xX]\]\s)?|\d+[.)]\s|>\s?)(.*)$/.exec(line);
    if (m) {
      e.preventDefault();
      if (!m[3].trim()) { ta.setRangeText("", ls, s, "end"); ta.dispatchEvent(new Event("input", { bubbles: true })); return; } // empty item → end list
      let marker = m[2];
      const num = /^(\d+)([.)])\s$/.exec(marker);
      if (num) marker = `${parseInt(num[1], 10) + 1}${num[2]} `;
      if (/\[[xX]\]/.test(marker)) marker = marker.replace(/\[[xX]\]/, "[ ]");
      insertAtCursor(ta, "\n" + m[1] + marker);
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); wrapSelection(ta, "**"); }
    else if (k === "i") { e.preventDefault(); wrapSelection(ta, "*"); }
    else if (k === "e") { e.preventDefault(); togglePreview(); }
    else if (k === "s") { e.preventDefault(); saveNow().then(() => toast("Saved")); }
    else if (k === ";") { e.preventDefault(); insertAtCursor(ta, new Date().toLocaleString()); }
  }
  if (e.key === "Escape") { ta.blur(); el.scroll.focus(); }
}

function onGlobalKeydown(e) {
  if (!S.pdf) return;
  const inEdit = isEditable(e.target);
  const mod = e.ctrlKey || e.metaKey;
  // works everywhere
  if (e.altKey && !mod) {
    if (e.key === "ArrowRight") { e.preventDefault(); goToPage(S.currentPage + 1); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); goToPage(S.currentPage - 1); return; }
    const k = e.key.toLowerCase();
    if (k === "n") { e.preventDefault(); if (document.body.classList.contains("notes-hidden")) toggleNotes(); if (document.activeElement === el.noteText) { el.noteText.blur(); el.scroll.focus(); } else { switchTab("page"); el.noteText.focus(); } return; }
    if (k === "s") { e.preventDefault(); saveSetting({ side: settings.side === "left" ? "right" : "left" }); return; }
    if (k === "p") { e.preventDefault(); togglePin(); return; }
    if (k === "d") { e.preventDefault(); if (document.body.classList.contains("notes-hidden")) toggleNotes(); switchTab("page"); setNoteMode("ink"); return; }
    if (k === "t") { e.preventDefault(); if (document.body.classList.contains("notes-hidden")) toggleNotes(); switchTab("page"); setNoteMode("text"); el.noteText.focus(); return; }
  }
  if (mod && !inEdit && e.key.toLowerCase() === "z") {
    const surf = activeInkSurface();
    if (surf) { e.preventDefault(); if (e.shiftKey) surf.redo(); else surf.undo(); return; }
  }
  if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); openFind(); return; }
  if (mod && e.key.toLowerCase() === "q") { e.preventDefault(); quoteSelectionIntoNotes(); return; }
  if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomBy(1.15); return; }
  if (mod && e.key === "-") { e.preventDefault(); zoomBy(1 / 1.15); return; }
  if (mod && e.key === "0") { e.preventDefault(); setZoom("width"); return; }
  if (mod && e.key.toLowerCase() === "e" && !inEdit) { e.preventDefault(); togglePreview(); return; }
  if (e.key === "Escape") {
    if (!el.shortcuts.hidden) { el.shortcuts.hidden = true; return; }
    if (S.find.open) { closeFind(); return; }
    if (S.annotating) { setAnnotating(false); return; }
    if (!el.menu.hidden) { el.menu.hidden = true; return; }
    el.selBubble.hidden = true;
    return;
  }
  if (inEdit || mod || e.altKey) return;
  switch (e.key) {
    case "j": e.preventDefault(); goToPage(S.currentPage + 1); break;
    case "k": e.preventDefault(); goToPage(S.currentPage - 1); break;
    case "g": e.preventDefault(); el.pageInput.focus(); break;
    case "n": e.preventDefault(); switchTab("page"); el.noteText.focus(); break;
    case "+": case "=": e.preventDefault(); zoomBy(1.15); break;
    case "-": e.preventDefault(); zoomBy(1 / 1.15); break;
    case "0": e.preventDefault(); setZoom("width"); break;
    case "r": e.preventDefault(); rotate(); break;
    case "a": e.preventDefault(); setAnnotating(!S.annotating); break;
    case "p": if (S.annotating || S.noteMode === "ink") { e.preventDefault(); setInkState({ tool: "pen" }); } break;
    case "h": if (S.annotating || S.noteMode === "ink") { e.preventDefault(); setInkState({ tool: "hl" }); } break;
    case "e": if (S.annotating || S.noteMode === "ink") { e.preventDefault(); setInkState({ tool: "eraser" }); } break;
    case "/": e.preventDefault(); openFind(); break;
    case "?": e.preventDefault(); el.shortcuts.hidden = false; break;
    case "Home": if (e.target === el.scroll || e.target === document.body) { e.preventDefault(); goToPage(1); } break;
    case "End": if (e.target === el.scroll || e.target === document.body) { e.preventDefault(); goToPage(S.numPages); } break;
  }
}

// ---------- boot ----------
(async function main() {
  await loadSettings();
  wireEvents();
  setupSketch();
  setupPageInkBar();
  $("btnNotesToggle").classList.add("active");
  const url = parseFileParam();
  if (url) await openFromUrl(url);
  else showLanding();
})();
