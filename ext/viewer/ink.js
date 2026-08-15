// Ink engine: pointer-event drawing (pen / mouse / touch) with pressure, stored as
// vector strokes in a logical coordinate space so they survive zoom and resize.
//
// stroke = { tool: 'pen'|'hl', color, size, points: [[x, y, pressure], ...] }
// Coordinates are logical (caller supplies toLogical / toCanvas mappings and a
// px-per-logical-unit factor for widths).

export const inkState = {
  tool: "pen",       // pen | hl | eraser
  color: "ink",      // 'ink' = theme foreground (black on PDF pages), or a CSS color
  size: 3,           // logical-ish base width in CSS px at 100%
  hlColor: "#ffd60a",
};
const COLORS = [
  ["ink", "Ink"], ["#d62828", "Red"], ["#1d4ed8", "Blue"], ["#15803d", "Green"], ["#c2410c", "Orange"], ["#7e22ce", "Purple"],
];
const SIZES = [[1.5, "Fine"], [3, "Medium"], [6, "Bold"]];
const listeners = new Set();
export function onInkStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setInkState(patch) { Object.assign(inkState, patch); for (const l of listeners) l(inkState); }

function themeInk() {
  return getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() || "#1f1e1b";
}
export function resolveColor(c, onPaper) {
  if (c === "ink") return onPaper ? "#111111" : themeInk();
  return c;
}

// ---------- toolbar ----------
const SVG_NS = "http://www.w3.org/2000/svg";
/** Build a 24x24 stroke icon from path `d` strings (no innerHTML). */
export function icon(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const d of paths) { const p = document.createElementNS(SVG_NS, "path"); p.setAttribute("d", d); svg.appendChild(p); }
  return svg;
}
const ICONS = {
  pen: ["M4 20l4-1 10-10-3-3L5 16z", "M13 7l3 3"],
  hl: ["M9 15l-4 4H3v-2l4-4", "M9 15l8-8 3 3-8 8", "M14 4l6 6"],
  eraser: ["M4 16l8-8 6 6-4 4H8z", "M6 20h14"],
  undo: ["M9 14L4 9l5-5", "M4 9h9a6 6 0 0 1 0 12h-2"],
  redo: ["M15 14l5-5-5-5", "M20 9h-9a6 6 0 0 0 0 12h2"],
  clear: ["M5 7h14M9 7V4h6v3M8 7l1 13h6l1-13"],
};

/** Builds a toolbar into `root`. `actions` = { undo, redo, clear, extra?: [{title, paths, onClick, isActive?}] } */
export function buildInkToolbar(root, actions, { onPaper = false } = {}) {
  root.classList.add("ink-toolbar");
  root.replaceChildren();
  const mk = (cls, title, content, onClick) => {
    const b = document.createElement("button"); b.className = "ink-btn " + cls; b.title = title;
    if (content instanceof Node) b.appendChild(content);
    b.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus/selection
    b.addEventListener("click", onClick); root.appendChild(b); return b;
  };
  const tools = {
    pen: mk("tool", "Pen (P)", icon(ICONS.pen), () => setInkState({ tool: "pen" })),
    hl: mk("tool", "Highlighter (H)", icon(ICONS.hl), () => setInkState({ tool: "hl" })),
    eraser: mk("tool", "Eraser (E) — strokes it touches", icon(ICONS.eraser), () => setInkState({ tool: "eraser" })),
  };
  root.appendChild(sep());
  const colorBtns = COLORS.map(([c, name]) => {
    const b = mk("color", name, null, () => setInkState({ color: c, tool: inkState.tool === "eraser" ? "pen" : inkState.tool }));
    b.dataset.color = c; return b;
  });
  root.appendChild(sep());
  const sizeBtns = SIZES.map(([s, name]) => {
    const dot = document.createElement("i"); dot.style.width = dot.style.height = `${4 + s * 2}px`;
    const b = mk("size", name, dot, () => setInkState({ size: s }));
    b.dataset.size = String(s); return b;
  });
  root.appendChild(sep());
  mk("", "Undo (Ctrl+Z)", icon(ICONS.undo), actions.undo);
  mk("", "Redo (Ctrl+Shift+Z)", icon(ICONS.redo), actions.redo);
  mk("", "Clear this sheet", icon(ICONS.clear), actions.clear);
  for (const x of actions.extra || []) { const b = mk("extra", x.title, icon(x.paths), x.onClick); x.btn = b; }
  const refresh = () => {
    for (const [k, b] of Object.entries(tools)) b.classList.toggle("active", inkState.tool === k);
    for (const b of colorBtns) {
      b.style.setProperty("--c", resolveColor(b.dataset.color, onPaper));
      b.classList.toggle("active", inkState.color === b.dataset.color && inkState.tool !== "eraser");
    }
    for (const b of sizeBtns) b.classList.toggle("active", parseFloat(b.dataset.size) === inkState.size);
    for (const x of actions.extra || []) if (x.isActive) x.btn.classList.toggle("active", !!x.isActive());
  };
  refresh();
  const off = onInkStateChange(refresh);
  return { refresh, destroy: off };
}
function sep() { const s = document.createElement("span"); s.className = "ink-sep"; return s; }

// ---------- rendering ----------
function widthAt(stroke, p, lineScale) {
  const base = stroke.size * lineScale;
  if (stroke.tool === "hl") return base * 4;
  const pr = p == null || p === 0 ? 0.5 : p;
  return base * (0.45 + 1.1 * pr);
}
export function drawStroke(ctx, stroke, toCanvas, lineScale, onPaper) {
  const pts = stroke.points;
  if (!pts.length) return;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (stroke.tool === "hl") { ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = "multiply"; ctx.lineCap = "butt"; }
  ctx.strokeStyle = stroke.tool === "hl" ? stroke.color : resolveColor(stroke.color, onPaper);
  if (pts.length === 1) {
    const [x, y] = toCanvas(pts[0][0], pts[0][1]);
    ctx.beginPath(); ctx.arc(x, y, widthAt(stroke, pts[0][2], lineScale) / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle; ctx.fill(); ctx.restore(); return;
  }
  if (stroke.tool === "hl") {
    ctx.lineWidth = widthAt(stroke, 0.5, lineScale);
    ctx.beginPath();
    let [px, py] = toCanvas(pts[0][0], pts[0][1]); ctx.moveTo(px, py);
    for (let i = 1; i < pts.length; i++) { const [x, y] = toCanvas(pts[i][0], pts[i][1]); ctx.lineTo(x, y); }
    ctx.stroke(); ctx.restore(); return;
  }
  // variable width: segments through midpoints, width per segment
  let [x0, y0] = toCanvas(pts[0][0], pts[0][1]);
  let w0 = widthAt(stroke, pts[0][2], lineScale);
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = toCanvas(pts[i][0], pts[i][1]);
    const w1 = widthAt(stroke, pts[i][2], lineScale);
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    ctx.lineWidth = (w0 + w1) / 2;
    ctx.beginPath();
    if (i === 1) ctx.moveTo(x0, y0); else ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(x0, y0, mx, my);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    x0 = x1; y0 = y1; w0 = w1;
  }
  ctx.restore();
}
export function drawStrokes(ctx, strokes, toCanvas, lineScale, onPaper) {
  for (const s of strokes) drawStroke(ctx, s, toCanvas, lineScale, onPaper);
}

// ---------- software cursor ----------
// Chrome on Wayland (and some tablet drivers) shows no pointer for stylus input, so
// every ink surface drives this shared on-screen cursor: a ring the size of the
// stroke, in the current colour; dashed for the eraser; a translucent bar for the
// highlighter. Native cursor is hidden over ink surfaces via CSS.
let cursorEl = null;
function cursor() {
  if (!cursorEl) { cursorEl = document.createElement("div"); cursorEl.className = "ink-cursor"; cursorEl.hidden = true; document.body.appendChild(cursorEl); }
  return cursorEl;
}
export function hideInkCursor() { if (cursorEl) cursorEl.hidden = true; }
function updateCursor(surface, e) {
  const c = cursor();
  const tool = surface.activeTool && surface.pointerId != null ? surface.activeTool : inkState.tool;
  const ls = surface.o.lineScale();
  let d;
  if (tool === "eraser") d = (inkState.size * 3 + 6) * 2;
  else if (tool === "hl") d = inkState.size * ls * 4;
  else d = Math.max(4, widthAt({ tool: "pen", size: inkState.size }, e.pressure > 0 ? e.pressure : 0.5, ls));
  d = Math.max(6, d);
  c.hidden = false;
  c.dataset.tool = tool;
  c.style.width = d + "px"; c.style.height = d + "px";
  c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px";
  c.style.setProperty("--cur-color", tool === "hl" ? inkState.hlColor : resolveColor(inkState.color, surface.o.onPaper));
  document.body.dataset.pointer = e.pointerType || "mouse";
}

// ---------- surface ----------
/**
 * opts: {
 *   canvas, toLogical(cx, cy) -> [lx, ly], toCanvas(lx, ly) -> [cx, cy], lineScale() -> px per unit,
 *   getStrokes() -> array, setStrokes(array), onChange(), onPaper (bool), touchDraws() -> bool,
 *   isEnabled() -> bool
 * }
 */
export class InkSurface {
  constructor(opts) {
    this.o = opts;
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext("2d");
    this.undoStack = []; this.redoStack = [];
    this.live = null;       // stroke being drawn
    this.erased = null;     // strokes removed during current eraser drag
    this.penSeenAt = 0;
    this._down = this.onDown.bind(this); this._move = this.onMove.bind(this); this._up = this.onUp.bind(this);
    this._hover = (e) => { if (this.o.isEnabled && !this.o.isEnabled()) return; if (e.pointerType === "touch") return; updateCursor(this, e); };
    this._leave = (e) => { if (this.pointerId == null || e.pointerId === this.pointerId) hideInkCursor(); };
    this.canvas.addEventListener("pointerdown", this._down);
    this.canvas.addEventListener("pointermove", this._move);
    this.canvas.addEventListener("pointerup", this._up);
    this.canvas.addEventListener("pointercancel", this._up);
    this.canvas.addEventListener("pointerenter", this._hover);
    this.canvas.addEventListener("pointermove", this._hover);
    this.canvas.addEventListener("pointerleave", this._leave);
    this.canvas.addEventListener("pointerout", this._leave);
    this.canvas.addEventListener("contextmenu", (e) => { if (this.o.isEnabled?.() !== false) e.preventDefault(); });
    this.resize();
  }
  destroy() {
    this.canvas.removeEventListener("pointerdown", this._down);
    this.canvas.removeEventListener("pointermove", this._move);
    this.canvas.removeEventListener("pointerup", this._up);
    this.canvas.removeEventListener("pointercancel", this._up);
    this.canvas.removeEventListener("pointerenter", this._hover);
    this.canvas.removeEventListener("pointermove", this._hover);
    this.canvas.removeEventListener("pointerleave", this._leave);
    this.canvas.removeEventListener("pointerout", this._leave);
    hideInkCursor();
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.dpr = dpr;
    this.redraw();
  }
  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr || 1, 0, 0, this.dpr || 1, 0, 0);
    drawStrokes(ctx, this.o.getStrokes(), this.o.toCanvas, this.o.lineScale(), this.o.onPaper);
    if (this.live) drawStroke(ctx, this.live, this.o.toCanvas, this.o.lineScale(), this.o.onPaper);
  }
  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.o.toLogical(e.clientX - r.left, e.clientY - r.top);
  }
  accepts(e) {
    if (this.o.isEnabled && !this.o.isEnabled()) return false;
    if (e.pointerType === "pen") { this.penSeenAt = performance.now(); return true; }
    if (e.pointerType === "touch") {
      if (performance.now() - this.penSeenAt < 1500) return false; // palm while pen in use
      return this.o.touchDraws ? this.o.touchDraws() : true;
    }
    return e.button === 0 || e.buttons === 1; // mouse: primary only
  }
  onDown(e) {
    if (this.pointerId != null) return; // one pointer at a time
    if (!this.accepts(e)) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const [x, y] = this.local(e);
    // pen barrel button (buttons & 32) or eraser end (button 5) → erase
    const eraseGesture = e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32));
    const tool = eraseGesture ? "eraser" : inkState.tool;
    this.activeTool = tool;
    if (tool === "eraser") { this.erased = []; this.eraseAt(x, y); return; }
    this.live = { tool, color: tool === "hl" ? inkState.hlColor : inkState.color, size: inkState.size, points: [[r3(x), r3(y), r2(e.pressure)]] };
    this.redraw();
  }
  onMove(e) {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (this.activeTool === "eraser") { for (const ev of evs) { const [x, y] = this.local(ev); this.eraseAt(x, y); } return; }
    if (!this.live) return;
    const pts = this.live.points;
    for (const ev of evs) {
      const [x, y] = this.local(ev);
      const last = pts[pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < 0.35 / this.o.lineScale()) continue; // dedupe
      pts.push([r3(x), r3(y), r2(ev.pressure)]);
    }
    // incremental draw of the tail for responsiveness
    const ctx = this.ctx; const n = pts.length;
    if (n >= 2) {
      const tail = { ...this.live, points: pts.slice(Math.max(0, n - 3)) };
      drawStroke(ctx, tail, this.o.toCanvas, this.o.lineScale(), this.o.onPaper);
    }
  }
  onUp(e) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.activeTool === "eraser") {
      if (this.erased?.length) { this.undoStack.push({ type: "remove", strokes: this.erased }); this.redoStack = []; this.o.onChange(); }
      this.erased = null; return;
    }
    if (!this.live) return;
    const stroke = this.live; this.live = null;
    const strokes = this.o.getStrokes().slice(); strokes.push(stroke);
    this.o.setStrokes(strokes);
    this.undoStack.push({ type: "add", stroke }); this.redoStack = [];
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redraw(); this.o.onChange();
  }
  eraseAt(x, y) {
    const strokes = this.o.getStrokes();
    const radius = (inkState.size * 3 + 6) / this.o.lineScale();
    const keep = [], gone = [];
    for (const s of strokes) (hits(s, x, y, radius) ? gone : keep).push(s);
    if (gone.length) { this.o.setStrokes(keep); this.erased.push(...gone); this.redraw(); }
  }
  undo() {
    const a = this.undoStack.pop(); if (!a) return;
    let strokes = this.o.getStrokes().slice();
    if (a.type === "add") strokes = strokes.filter((s) => s !== a.stroke);
    else if (a.type === "remove") strokes.push(...a.strokes);
    else if (a.type === "clear") strokes = a.strokes.slice();
    this.o.setStrokes(strokes); this.redoStack.push(a); this.redraw(); this.o.onChange();
  }
  redo() {
    const a = this.redoStack.pop(); if (!a) return;
    let strokes = this.o.getStrokes().slice();
    if (a.type === "add") strokes.push(a.stroke);
    else if (a.type === "remove") strokes = strokes.filter((s) => !a.strokes.includes(s));
    else if (a.type === "clear") strokes = [];
    this.o.setStrokes(strokes); this.undoStack.push(a); this.redraw(); this.o.onChange();
  }
  clear() {
    const strokes = this.o.getStrokes();
    if (!strokes.length) return;
    this.undoStack.push({ type: "clear", strokes: strokes.slice() }); this.redoStack = [];
    this.o.setStrokes([]); this.redraw(); this.o.onChange();
  }
  resetHistory() { this.undoStack = []; this.redoStack = []; }
}
function hits(stroke, x, y, r) {
  const pts = stroke.points; const r2v = r * r;
  if (pts.length === 1) return dist2(pts[0][0], pts[0][1], x, y) <= r2v;
  for (let i = 1; i < pts.length; i++) if (segDist2(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], x, y) <= r2v) return true;
  return false;
}
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function segDist2(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy;
  if (!l2) return dist2(ax, ay, px, py);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2; t = Math.max(0, Math.min(1, t));
  return dist2(ax + t * dx, ay + t * dy, px, py);
}
const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round((v || 0) * 100) / 100;

/** Rasterise strokes to a PNG blob (for export). */
export function strokesToPng(strokes, { width, height, toCanvas, lineScale, background = "#ffffff", onPaper = true }) {
  const c = document.createElement("canvas"); c.width = width; c.height = height;
  const ctx = c.getContext("2d");
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, width, height); }
  drawStrokes(ctx, strokes, toCanvas, lineScale, onPaper);
  return new Promise((res) => c.toBlob(res, "image/png"));
}
