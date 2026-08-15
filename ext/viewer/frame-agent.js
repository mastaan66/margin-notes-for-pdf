// Margin Notes — page agent. Injected on demand (chrome.scripting) into a page the user
// is taking notes on: either the top frame of a normal tab (side-panel host) or the
// iframe inside the split-view viewer. It reports what the viewer needs to anchor notes
// (headings → sections, <video> playback time, text selection) and executes small
// commands (scroll to a heading, seek, zoom). It never reads or sends page content
// beyond heading text, the page title/URL and text the user explicitly selects.
(() => {
  const chrome = globalThis.browser ?? globalThis.chrome;
  if (globalThis.__mnAgent) { globalThis.__mnAgent.hello(); return; }

  const MAX_HEADINGS = 400;
  const A = { headings: [], hEls: [], media: null, curSection: -1, lastUrl: location.href, mediaTimer: null, lastT: -1, bubble: null, zoom: 1 };
  globalThis.__mnAgent = A;

  const send = (msg) => { try { const p = chrome.runtime.sendMessage({ mnAgent: true, ...msg }); if (p?.catch) p.catch(() => {}); } catch { /* extension reloaded */ } };
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && getComputedStyle(el).visibility !== "hidden"; };

  // ---------- headings → sections ----------
  function collectHeadings() {
    const els = [...document.querySelectorAll("h1, h2, h3, h4, [role=heading]")].filter((h) => clean(h.textContent).length >= 2 && visible(h)).slice(0, MAX_HEADINGS);
    A.hEls = els;
    A.headings = els.map((h) => ({ text: clean(h.textContent).slice(0, 120), level: parseInt((h.getAttribute("aria-level") || h.tagName.replace(/\D/g, "") || "2"), 10) || 2 }));
    return A.headings;
  }
  function currentSection() {
    // 1-based index of the last heading whose top is above the reading line; 0 = before the first heading
    const line = Math.min(140, innerHeight * 0.3);
    let cur = 0;
    for (let i = 0; i < A.hEls.length; i++) { const r = A.hEls[i].getBoundingClientRect(); if (r.top <= line) cur = i + 1; else break; }
    return cur;
  }
  function reportSection(force) {
    const s = currentSection();
    if (force || s !== A.curSection) { A.curSection = s; send({ type: "mn:section", index: s }); }
  }

  // ---------- media (video / audio) ----------
  function findMedia() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll("video, audio")) {
      if (!(v.duration > 0) && v.readyState === 0) continue;
      const r = v.getBoundingClientRect(); const area = v.tagName === "AUDIO" ? 1 : r.width * r.height;
      if (area >= bestArea) { best = v; bestArea = area; }
    }
    return best;
  }
  function mediaInfo() {
    const m = A.media; if (!m || !document.contains(m)) return null;
    return { t: m.currentTime || 0, duration: isFinite(m.duration) ? m.duration : 0, paused: m.paused };
  }
  function tickMedia() {
    const info = mediaInfo();
    if (!info) { if (A.media) { A.media = null; send({ type: "mn:media", media: null }); } return; }
    if (Math.abs(info.t - A.lastT) >= 0.4 || info.paused !== A.lastPaused) { A.lastT = info.t; A.lastPaused = info.paused; send({ type: "mn:media", media: info }); }
  }
  function bindMedia() {
    const m = findMedia();
    if (m === A.media) return;
    A.media = m; A.lastT = -1;
    if (m) {
      for (const ev of ["play", "pause", "seeked", "loadedmetadata", "durationchange", "ended"]) m.addEventListener(ev, tickMedia, { passive: true });
      send({ type: "mn:media", media: mediaInfo() });
    }
  }

  // ---------- selection → "Add to notes" bubble ----------
  function ensureBubble() {
    if (A.bubble) return A.bubble;
    const host = document.createElement("div");
    host.setAttribute("data-margin-notes", "");
    Object.assign(host.style, { position: "fixed", zIndex: "2147483647", left: "0", top: "0", pointerEvents: "none" });
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `.b{position:absolute;transform:translate(-50%,-100%);display:flex;gap:2px;padding:3px;border-radius:8px;background:#1f1e1b;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.3);font:13px system-ui,sans-serif;pointer-events:auto;white-space:nowrap}.b button{border:0;background:transparent;color:inherit;padding:5px 9px;border-radius:6px;cursor:pointer;font:inherit}.b button:hover{background:rgba(255,255,255,.15)}.b::after{content:"";position:absolute;left:50%;bottom:-6px;transform:translateX(-50%);border:6px solid transparent;border-top-color:#1f1e1b;border-bottom:0}`;
    const b = document.createElement("div"); b.className = "b"; b.hidden = true;
    const q = document.createElement("button"); q.textContent = "Add to notes";
    const c = document.createElement("button"); c.textContent = "Copy";
    q.addEventListener("mousedown", (e) => e.preventDefault()); c.addEventListener("mousedown", (e) => e.preventDefault());
    q.addEventListener("click", () => { const t = selText(); if (t) send({ type: "mn:quote", text: t, section: currentSection(), media: mediaInfo() }); hideBubble(true); });
    c.addEventListener("click", () => { const t = selText(); if (t) navigator.clipboard?.writeText(t).catch(() => {}); hideBubble(true); });
    b.append(q, c); root.append(style, b);
    (document.body || document.documentElement).appendChild(host);
    A.bubble = { host, b };
    return A.bubble;
  }
  function selText() { return clean(getSelection()?.toString()); }
  function hideBubble(clear) { if (A.bubble) A.bubble.b.hidden = true; if (clear) getSelection()?.removeAllRanges(); }
  function showBubble() {
    if (!A.quoteEnabled) return;
    const sel = getSelection(); const text = selText();
    if (!sel || sel.isCollapsed || !text || !sel.rangeCount) { hideBubble(); return; }
    const rects = sel.getRangeAt(0).getClientRects();
    const r = rects.length ? rects[rects.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { hideBubble(); return; }
    const { b } = ensureBubble();
    b.hidden = false;
    const x = Math.max(70, Math.min(innerWidth - 70, r.left + r.width / 2));
    const y = Math.max(40, r.top - 6);
    b.style.left = x + "px"; b.style.top = y + "px";
  }
  document.addEventListener("mouseup", () => setTimeout(showBubble, 0), true);
  document.addEventListener("keyup", (e) => { if (e.shiftKey || e.key === "Shift") setTimeout(showBubble, 0); }, true);
  document.addEventListener("selectionchange", () => { const s = getSelection(); if (!s || s.isCollapsed) hideBubble(); });
  document.addEventListener("scroll", () => hideBubble(), { passive: true, capture: true });

  // ---------- keyboard: forward viewer shortcuts (Alt+…, Ctrl+Q) ----------
  document.addEventListener("keydown", (e) => {
    const alt = e.altKey && !e.ctrlKey && !e.metaKey;
    const ctrlQ = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "q";
    if (!alt && !ctrlQ) return;
    if (ctrlQ) { const t = selText(); if (!t) return; e.preventDefault(); send({ type: "mn:quote", text: t, section: currentSection(), media: mediaInfo() }); hideBubble(true); return; }
    if (!/^(arrowleft|arrowright|n|s|p|d|t|enter)$/i.test(e.key)) return;
    e.preventDefault();
    send({ type: "mn:key", key: e.key, alt: true, shift: e.shiftKey });
  }, true);

  // ---------- scroll / mutation / SPA navigation ----------
  let scrollT = 0; // setTimeout, not rAF: rAF is paused in background tabs (side-panel host)
  addEventListener("scroll", () => { if (!scrollT) scrollT = setTimeout(() => { scrollT = 0; reportSection(false); }, 80); }, { passive: true });
  let mutT = 0;
  const mo = new MutationObserver(() => { clearTimeout(mutT); mutT = setTimeout(() => { const before = JSON.stringify(A.headings); collectHeadings(); if (JSON.stringify(A.headings) !== before) send({ type: "mn:headings", headings: A.headings }); reportSection(false); bindMedia(); }, 800); });
  try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch { /* ignore */ }
  setInterval(() => {
    if (location.href !== A.lastUrl) { A.lastUrl = location.href; A.curSection = -1; hello(); }
    if (!A.media) bindMedia(); else tickMedia(); // players often attach <video> late or fill it in on first play
  }, 700);
  addEventListener("pagehide", () => send({ type: "mn:bye" }));

  // ---------- commands from the viewer ----------
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("mn:")) return;
    switch (msg.type) {
      case "mn:ping": reply(snapshot()); return;
      case "mn:goto": { const h = A.hEls[msg.index - 1]; if (h) { h.scrollIntoView({ block: "start", behavior: "auto" }); scrollBy(0, -Math.min(80, innerHeight * 0.1)); } else if (msg.index === 0) scrollTo(0, 0); reply({ ok: true }); return; }
      case "mn:seek": { const m = A.media; if (m) { try { m.currentTime = Math.max(0, msg.t); if (msg.play) m.play?.().catch?.(() => {}); } catch { /* ignore */ } tickMedia(); } reply({ ok: !!m }); return; }
      case "mn:toggle": { const m = A.media; if (m) { if (m.paused) m.play?.().catch?.(() => {}); else m.pause(); } reply({ ok: !!m }); return; }
      case "mn:zoom": { A.zoom = msg.z || 1; document.documentElement.style.zoom = A.zoom === 1 ? "" : String(A.zoom); reply({ ok: true }); return; }
      case "mn:quoteEnabled": A.quoteEnabled = !!msg.on; if (!A.quoteEnabled) hideBubble(); reply({ ok: true }); return;
      case "mn:clearSelection": hideBubble(true); reply({ ok: true }); return;
      case "mn:top": scrollTo(0, 0); reply({ ok: true }); return;
      default: return;
    }
  });

  function snapshot() {
    collectHeadings(); bindMedia();
    return { ok: true, url: location.href, title: clean(document.title) || location.hostname, headings: A.headings, media: mediaInfo(), section: currentSection() };
  }
  function hello() { send({ type: "mn:init", ...snapshot() }); A.curSection = -1; reportSection(true); }
  A.hello = hello;
  A.quoteEnabled = true;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hello, { once: true }); else hello();
  // late-loading media / SPA shells
  setTimeout(() => { bindMedia(); collectHeadings(); }, 1500);
})();
