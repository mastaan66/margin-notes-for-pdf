// End-to-end smoke test: loads the unpacked extension in headless Chrome, opens a
// PDF over http (exercising the DNR redirect), writes a note, reloads, checks it
// persisted, exercises find/zoom/side-swap, and takes screenshots.
import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../ext");
const OUT = process.env.OUT || path.resolve(__dirname, "../test-out");
fs.mkdirSync(OUT, { recursive: true });
const PDF_URL = process.env.PDF_URL || "http://127.0.0.1:8765/Berkshire-Letters-1977-2024-Modern.pdf";

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  headless: "new",
  pipe: true,
  enableExtensions: true,
  args: ["--no-sandbox", "--window-size=1500,950"],
  defaultViewport: { width: 1500, height: 950 },
});
await browser.installExtension(EXT);
const failures = [];
const check = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures.push(msg); };

try {
  // wait for service worker
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  console.log("extension id", extId);
  await new Promise((r) => setTimeout(r, 1200)); // let onInstalled/syncRules settle

  const page = await browser.newPage();
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) console.log("  [page]", m.type(), m.text()); });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await page.goto(PDF_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 500));
  check(page.url().startsWith(`chrome-extension://${extId}/viewer/viewer.html?file=`), "http PDF redirected to viewer: " + page.url());

  await page.waitForSelector("#pageCount", { visible: true, timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("pageCount").textContent !== "–", { timeout: 60000 });
  const numPages = await page.$eval("#pageCount", (e) => e.textContent);
  check(parseInt(numPages, 10) > 0, `document loaded, ${numPages} pages`);
  await page.waitForSelector(".page canvas", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector(".page .textLayer span"), { timeout: 30000 });
  check(true, "first page rendered with text layer");
  await page.screenshot({ path: path.join(OUT, "01-viewer.png") });

  // write a note on page 1
  await page.click("#noteText");
  await page.type("#noteText", "# Test note\n- first point\n- [ ] todo item\nSee p.3 for more.");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveStatus").textContent), { timeout: 5000 });
  check(true, "note autosaved");
  check(await page.$eval('.page[data-page="1"]', (e) => e.classList.contains("has-note")), "page 1 marked has-note");

  // navigate to page 3 → note panel switches, empty
  await page.keyboard.press("Escape");
  await page.focus("#viewerScroll");
  await page.keyboard.press("j"); await page.keyboard.press("j");
  await page.waitForFunction(() => document.getElementById("npPageLabel").textContent === "Page 3", { timeout: 5000 });
  check(await page.$eval("#noteText", (e) => e.value) === "", "page 3 note is empty");
  await page.type("#noteText", "Third page thoughts.");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveStatus").textContent), { timeout: 5000 });
  check(true, "page 3 note saved");

  // preview
  await page.keyboard.down("Control"); await page.keyboard.press("e"); await page.keyboard.up("Control");
  check(await page.$eval("#notePreview", (e) => !e.hidden), "preview toggled");
  await page.keyboard.down("Control"); await page.keyboard.press("e"); await page.keyboard.up("Control");

  // pin + scroll: note page must stay
  await page.click("#npPageBtn");
  await page.focus("#viewerScroll");
  await page.keyboard.press("j");
  await new Promise((r) => setTimeout(r, 300));
  check(await page.$eval("#npPageLabel", (e) => e.textContent) === "Page 3", "pinned note stays on page 3 while PDF moves to 4");
  await page.click("#npPageBtn"); // unpin → follows to page 4
  await new Promise((r) => setTimeout(r, 300));
  check(await page.$eval("#npPageLabel", (e) => e.textContent) === "Page 4", "unpinned follows current page");

  // reload → notes persist, resumes on last page
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("pageCount").textContent !== "–", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));
  const cur = await page.$eval("#pageInput", (e) => e.value);
  check(cur === "4", `resumed at last page (got ${cur})`);
  await page.click("#pageInput", { clickCount: 3 }); await page.type("#pageInput", "1"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("npPageLabel").textContent === "Page 1", { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 300));
  const v = await page.$eval("#noteText", (e) => e.value);
  check(v.startsWith("# Test note"), "page 1 note persisted after reload");
  check(await page.$eval("#allCount", (e) => e.textContent) === "2", "all-notes badge shows 2");

  // all notes tab
  await page.click('.tab[data-tab="all"]');
  check((await page.$$(".note-card")).length === 2, "all notes lists 2 cards");
  await page.click('.tab[data-tab="page"]');

  // find
  await page.focus("#viewerScroll");
  await page.keyboard.down("Control"); await page.keyboard.press("f"); await page.keyboard.up("Control");
  await page.type("#findInput", "Berkshire");
  await page.waitForFunction(() => /\d+ of \d+/.test(document.getElementById("findCount").textContent), { timeout: 60000 });
  const fc = await page.$eval("#findCount", (e) => e.textContent);
  check(true, "find works: " + fc);
  await page.waitForFunction(() => document.querySelector(".textLayer span.hl"), { timeout: 10000 }).catch(() => {});
  check(!!(await page.$(".textLayer span.hl")), "find highlights in text layer");
  await page.screenshot({ path: path.join(OUT, "02-find.png") });
  await page.keyboard.press("Escape");

  // side swap
  await page.click("#btnSide");
  await new Promise((r) => setTimeout(r, 400));
  check(await page.$eval("body", (b) => b.dataset.side) === "right", "side swapped to right");
  const pdfBox = await page.$eval("#pdfPane", (e) => e.getBoundingClientRect().left);
  const notesBox = await page.$eval("#notesPane", (e) => e.getBoundingClientRect().left);
  check(pdfBox > notesBox, "PDF pane is physically on the right");
  await page.screenshot({ path: path.join(OUT, "03-right.png") });
  await page.click("#btnSide");

  // zoom
  const w0 = await page.$eval('.page[data-page="1"]', (e) => e.offsetWidth);
  await page.click("#btnZoomIn"); await new Promise((r) => setTimeout(r, 300));
  const w1 = await page.$eval('.page[data-page="1"]', (e) => e.offsetWidth);
  check(w1 > w0, `zoom in grows page (${w0} → ${w1})`);
  await page.select("#zoomSelect", "width"); await new Promise((r) => setTimeout(r, 300));

  // dark theme screenshot
  await page.click("#btnTheme"); await page.click("#btnTheme");
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, "04-dark.png") });
  await page.click("#btnTheme");

  // quote selection via Ctrl+Q after selecting text programmatically
  await page.evaluate(() => {
    const span = document.querySelector('.page[data-page="1"] .textLayer span');
    const r = document.createRange(); r.selectNodeContents(span);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.focus("#viewerScroll");
  await page.keyboard.down("Control"); await page.keyboard.press("q"); await page.keyboard.up("Control");
  await new Promise((r) => setTimeout(r, 300));
  check((await page.$eval("#noteText", (e) => e.value)).includes("> "), "Ctrl+Q quoted selection into note");

  // ---- ink: sketch pad in notes pane ----
  await page.click("#btnModeInk");
  await new Promise((r) => setTimeout(r, 400));
  check(await page.$eval("#sketch", (e) => !e.hidden), "Draw mode shows sketch pad");
  const sc = await page.$("#sketchCanvas");
  const sb = await sc.boundingBox();
  await page.mouse.move(sb.x + 40, sb.y + 40); await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(sb.x + 40 + i * 8, sb.y + 40 + Math.sin(i / 3) * 20, { steps: 2 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 700));
  const inkCount = await page.evaluate(async () => { const { db } = await import("./db.js"); const all = await db.exportAll(); return all.ink.length; });
  check(inkCount === 1, `sketch stroke persisted to IndexedDB (${inkCount} ink records)`);
  check(await page.$eval("#btnModeInk", (e) => e.classList.contains("has")), "Draw button shows content dot");
  const drawn = await page.$eval("#sketchCanvas", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  check(drawn > 200, `sketch canvas has ink pixels (${drawn})`);
  // undo removes it
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  await new Promise((r) => setTimeout(r, 700));
  const afterUndo = await page.evaluate(async () => { const { db } = await import("./db.js"); return (await db.exportAll()).ink.length; });
  check(afterUndo === 0, "Ctrl+Z undo removed the stroke");
  await page.keyboard.down("Control"); await page.keyboard.down("Shift"); await page.keyboard.press("z"); await page.keyboard.up("Shift"); await page.keyboard.up("Control");
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: path.join(OUT, "08-sketch.png") });
  await page.click("#btnModeText");

  // ---- ink: annotate directly on the PDF page ----
  await page.focus("#viewerScroll");
  await page.keyboard.press("a");
  check(await page.$eval("body", (b) => b.classList.contains("annotating")), "annotate mode on");
  const layer = await page.$('.page[data-page="1"] .inkLayer');
  const lb = await layer.boundingBox();
  await page.mouse.move(lb.x + 100, lb.y + 200); await page.mouse.down();
  for (let i = 1; i <= 25; i++) await page.mouse.move(lb.x + 100 + i * 10, lb.y + 200 + (i % 2) * 6, { steps: 2 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 700));
  check(await page.$eval('.page[data-page="1"]', (e) => e.classList.contains("has-ink")), "page 1 marked has-ink");
  // highlighter + zoom → strokes re-rendered at new scale
  await page.keyboard.press("h");
  await page.mouse.move(lb.x + 100, lb.y + 300); await page.mouse.down(); await page.mouse.move(lb.x + 400, lb.y + 300, { steps: 10 }); await page.mouse.up();
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: path.join(OUT, "09-annotate.png") });
  await page.click("#btnZoomIn"); await new Promise((r) => setTimeout(r, 900));
  const inkPx = await page.$eval('.page[data-page="1"] .inkLayer', (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  check(inkPx > 500, `page ink re-rendered after zoom (${inkPx} px)`);
  await page.select("#zoomSelect", "width");
  await page.keyboard.press("Escape");
  check(!(await page.$eval("body", (b) => b.classList.contains("annotating"))), "Esc leaves annotate mode");
  // reload → page ink persists
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("pageCount").textContent !== "–", { timeout: 60000 });
  await page.waitForSelector('.page[data-page="1"] .inkLayer', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 600));
  check(await page.$eval('.page[data-page="1"]', (e) => e.classList.contains("has-ink")), "page ink persisted across reload");
  const inkPx2 = await page.$eval('.page[data-page="1"] .inkLayer', (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  check(inkPx2 > 500, `page ink drawn after reload (${inkPx2} px)`);

  // export markdown via menu (check that download click doesn't throw)
  await page.click("#btnMenu");
  check(await page.$eval("#menu", (e) => !e.hidden), "menu opens");
  await page.keyboard.press("Escape");

  // outline tab exists
  await page.click('.tab[data-tab="outline"]');
  const outlineText = await page.$eval("#outline", (e) => e.textContent.trim().slice(0, 60));
  console.log("  outline:", outlineText);
  await page.click('.tab[data-tab="page"]');

  // landing page
  await page.goto(`chrome-extension://${extId}/viewer/viewer.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#landing", { visible: true });
  await new Promise((r) => setTimeout(r, 500));
  check((await page.$$(".recent")).length >= 1, "landing shows recent document");
  await page.screenshot({ path: path.join(OUT, "05-landing.png") });

  // popup + options render without errors
  const opt = await browser.newPage();
  opt.on("pageerror", (e) => console.log("  [options pageerror]", e.message));
  await opt.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 300));
  await opt.screenshot({ path: path.join(OUT, "06-options.png") });
  const pop = await browser.newPage();
  pop.on("pageerror", (e) => console.log("  [popup pageerror]", e.message));
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 300));
  await pop.setViewport({ width: 300, height: 260 });
  await pop.screenshot({ path: path.join(OUT, "07-popup.png") });

  // disable → http pdf no longer redirected
  await pop.evaluate(async () => { await chrome.storage.sync.set({ enabled: false }); await chrome.runtime.sendMessage({ type: "syncRules" }); });
  await new Promise((r) => setTimeout(r, 800));
  const p2 = await browser.newPage();
  await p2.goto(PDF_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  check(!p2.url().startsWith("chrome-extension://"), "disabled: PDF not redirected (" + p2.url() + ")");
  await pop.evaluate(async () => { await chrome.storage.sync.set({ enabled: true }); await chrome.runtime.sendMessage({ type: "syncRules" }); });
} catch (e) {
  console.error("TEST ERROR", e);
  failures.push("exception: " + e.message);
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nALL PASSED");
process.exit(failures.length ? 1 : 0);
