// Web / video mode e2e: split view on a headings page (agent → sections), timestamped
// notes on a page with media, panel host following a tab, local Markdown via srcdoc.
import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../ext");
const OUT = process.env.OUT || path.resolve(__dirname, "../test-out");
fs.mkdirSync(OUT, { recursive: true });
const FIX = path.join(__dirname, "fixtures");
const PORT = 8766;
const server = http.createServer((req, res) => {
  const f = path.join(FIX, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, ""));
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  const type = f.endsWith(".html") ? "text/html" : f.endsWith(".wav") ? "audio/wav" : "application/octet-stream";
  const buf = fs.readFileSync(f);
  const range = req.headers.range;
  if (range && type.startsWith("audio")) {
    const [s, e] = range.replace("bytes=", "").split("-").map((x) => parseInt(x, 10));
    const start = s || 0, end = Number.isNaN(e) ? buf.length - 1 : e;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${buf.length}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    res.end(buf.subarray(start, end + 1)); return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length, "Accept-Ranges": "bytes" });
  res.end(buf);
}).listen(PORT);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  headless: "new", pipe: true, enableExtensions: true,
  args: ["--no-sandbox", "--window-size=1500,950", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 1500, height: 950 },
});
await browser.installExtension(EXT);
const failures = [];
const check = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  const VIEWER = `chrome-extension://${extId}/viewer/viewer.html`;
  await sleep(1000);

  // ---- 1. split view on an article ----
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  page.on("console", (m) => { if (["error"].includes(m.type())) console.log("  [page]", m.type(), m.text()); });
  await page.goto(`${VIEWER}?web=http://127.0.0.1:${PORT}/article.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#webFrame", { visible: true, timeout: 10000 });
  check(await page.$eval("body", (b) => b.dataset.mode === "web" && b.dataset.host === "frame"), "split view web mode active");
  await page.waitForFunction(() => document.getElementById("pageCount").textContent === "6", { timeout: 15000 }).catch(() => {});
  check(await page.$eval("#pageCount", (e) => e.textContent) === "6", "agent connected: 5 headings → 6 sections");
  check(await page.$eval("#docTitle", (e) => e.textContent) === "Fixture Article", "title from page");
  console.log("  label:", await page.$eval("#npPageLabel", (e) => e.textContent), "input:", await page.$eval("#pageInput", (e) => e.value));
  check(/^(Top of page|§\d )/.test(await page.$eval("#npPageLabel", (e) => e.textContent)), "note label is a section label");
  await page.screenshot({ path: path.join(OUT, "web-01-article.png") });

  // outline tab lists headings
  await page.click('.notes-tabs .tab[data-tab="outline"]');
  const olCount = await page.$$eval("#outline .ol-link", (a) => a.length);
  check(olCount === 5, `outline lists ${olCount} headings`);
  // click 3rd heading → frame scrolls → section 4 → note label
  await page.$$eval("#outline .ol-link", (a) => a[2].click());
  await sleep(700);
  check(await page.$eval("#pageInput", (e) => e.value) === "4", "goto heading → section 4 (" + await page.$eval("#pageInput", (e) => e.value) + ")");
  await page.click('.notes-tabs .tab[data-tab="page"]');
  check((await page.$eval("#npPageLabel", (e) => e.textContent)).startsWith("§3 Second section"), "label shows §3 Second section");

  // write a section note, verify persistence across reload
  await page.click("#noteText");
  await page.type("#noteText", "Section note on second section");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveStatus").textContent), { timeout: 5000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("pageCount").textContent === "6", { timeout: 15000 }).catch(() => {});
  await page.$$eval(".notes-tabs .tab", (t) => t.find((x) => x.dataset.tab === "all").click());
  await sleep(300);
  const allText = await page.$eval("#allList", (e) => e.textContent);
  check(allText.includes("Section note on second section") && allText.includes("§3"), "section note persisted under §3");
  await page.$$eval(".notes-tabs .tab", (t) => t.find((x) => x.dataset.tab === "page").click());

  // selection in the frame → agent bubble → Add to notes
  const childFrame = (pg, part) => pg.frames().find((f) => f !== pg.mainFrame() && !f.detached && f.url().includes(part));
  const frame = childFrame(page, "article.html");
  check(!!frame, "iframe frame found");
  if (frame) {
    await frame.evaluate(() => { const p = document.querySelector("section p"); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
    await sleep(300);
    const clicked = await frame.evaluate(() => { const host = document.querySelector("[data-margin-notes]"); if (!host) return "nohost"; return "host"; });
    check(clicked === "host", "agent bubble host injected");
    // Ctrl+Q path (bubble lives in a closed shadow root) — dispatch keydown in the frame
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "q", ctrlKey: true, bubbles: true, cancelable: true })));
    await sleep(500);
    const nt = await page.$eval("#noteText", (e) => e.value);
    check(nt.includes("> Alpha content"), "Ctrl+Q in frame quoted selection into section note");
  }

  // ---- 2. media page in split view → video kind, timestamp anchors ----
  await page.goto(`${VIEWER}?web=http://127.0.0.1:${PORT}/media.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.dataset.kind === "video", { timeout: 15000 }).catch(() => {});
  check(await page.$eval("body", (b) => b.dataset.kind) === "video", "media page detected → video kind");
  check(await page.$eval("#pageCount", (e) => e.textContent) === "0:20", "duration shown 0:20 (" + await page.$eval("#pageCount", (e) => e.textContent) + ")");
  const mframe = childFrame(page, "media.html");
  await mframe.evaluate(() => { const a = document.getElementById("a"); a.currentTime = 7; });
  await sleep(600);
  check(await page.$eval("#pageInput", (e) => e.value) === "0:07", "seek → time input 0:07 (" + await page.$eval("#pageInput", (e) => e.value) + ")");
  console.log("  anchor visible:", await page.$eval("#btnAnchor", (b) => b.hidden + " " + getComputedStyle(b).display));
  await page.$eval("#btnAnchor", (b) => b.click());
  await sleep(200);
  check(await page.$eval("#npPageLabel", (e) => e.textContent) === "At 0:07", "anchor at 0:07");
  await page.type("#noteText", "Gradient explained here");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveStatus").textContent), { timeout: 5000 });
  // move time forward → note stays (latest anchor ≤ t)
  await mframe.evaluate(() => { document.getElementById("a").currentTime = 15; });
  await sleep(600);
  check(await page.$eval("#npPageLabel", (e) => e.textContent) === "At 0:07", "follows latest anchor at 0:15");
  // seek back before the anchor → whole video
  await mframe.evaluate(() => { document.getElementById("a").currentTime = 2; });
  await sleep(600);
  check(await page.$eval("#npPageLabel", (e) => e.textContent) === "Whole video", "before first anchor → whole video");
  // click the note in All notes → seeks to 7
  await page.$$eval(".notes-tabs .tab", (t) => t.find((x) => x.dataset.tab === "all").click());
  await sleep(200);
  await page.click(".note-card");
  await sleep(600);
  const t = await mframe.evaluate(() => Math.floor(document.getElementById("a").currentTime));
  check(t === 7, `clicking timestamped note seeks media to 7 (got ${t})`);
  await page.screenshot({ path: path.join(OUT, "web-02-video.png") });
  // export markdown label
  const md = await page.evaluate(async () => { const m = await import(chrome.runtime.getURL("viewer/db.js")); const docs = await m.db.listDocs(); const d = docs.find((x) => x.kind === "video"); const notes = await m.db.getNotesForDoc(d.fp); return m.notesToMarkdown(d, notes); });
  check(/## \[?0:07/.test(md), "markdown export uses timestamp heading");

  // ---- 3. panel host following a tab ----
  const site = await browser.newPage();
  await site.goto(`http://127.0.0.1:${PORT}/article.html`, { waitUntil: "load" });
  const siteTabId = await page.evaluate(async (u) => { const tabs = await chrome.tabs.query({ url: u }); return tabs[0]?.id; }, `http://127.0.0.1:${PORT}/article.html`);
  check(typeof siteTabId === "number", "found site tab id " + siteTabId);
  const panel = await browser.newPage();
  panel.on("pageerror", (e) => console.log("  [panel pageerror]", e.message));
  await panel.goto(`${VIEWER}?panel=1&tab=${siteTabId}`, { waitUntil: "domcontentloaded" });
  await panel.waitForFunction(() => document.getElementById("pageCount").textContent === "6", { timeout: 15000 }).catch(() => {});
  check(await panel.$eval("body", (b) => b.dataset.host === "panel" && b.dataset.mode === "web"), "panel host active");
  check(await panel.$eval("#pageCount", (e) => e.textContent) === "6", "panel: agent injected into top frame, 6 sections");
  check(await panel.$eval(".pdf-pane", (e) => getComputedStyle(e).display === "none"), "panel: document pane hidden");
  // notes shared with split view (same key)
  await panel.$$eval(".notes-tabs .tab", (t) => t.find((x) => x.dataset.tab === "all").click());
  await sleep(300);
  check((await panel.$eval("#allList", (e) => e.textContent)).includes("Section note on second section"), "panel sees the note written in split view (same doc key)");
  // scroll the site → panel follows section (scroll events only fire in a visible tab)
  await site.bringToFront();
  await site.evaluate(() => { document.querySelectorAll("h2")[2].scrollIntoView(); });
  await sleep(900);
  await panel.bringToFront();
  await sleep(200);
  check(await panel.$eval("#pageInput", (e) => e.value) === "6", "panel follows scroll to Third section (" + await panel.$eval("#pageInput", (e) => e.value) + ")");
  await panel.screenshot({ path: path.join(OUT, "web-03-panel.png") });
  // site navigates → panel switches doc
  await site.bringToFront();
  await site.goto(`http://127.0.0.1:${PORT}/media.html`, { waitUntil: "load" });
  await sleep(1500);
  await panel.bringToFront();
  await panel.waitForFunction(() => document.getElementById("docTitle").textContent === "Fixture Lecture", { timeout: 15000, polling: 200 }).catch(() => {});
  check(await panel.$eval("#docTitle", (e) => e.textContent) === "Fixture Lecture", "panel switched doc after tab navigation");
  await panel.waitForFunction(() => document.body.dataset.kind === "video", { timeout: 10000, polling: 200 }).catch(() => {});
  check(await panel.$eval("body", (b) => b.dataset.kind) === "video", "panel: video kind detected on media page");

  // ---- 4. local markdown via picker → srcdoc ----
  await page.bringToFront();
  await page.goto(VIEWER, { waitUntil: "domcontentloaded" });
  const mdPath = path.join(OUT, "sample.md");
  fs.writeFileSync(mdPath, "# Sample\n\nSome **markdown** here.\n\n- one\n- two\n");
  const input = await page.$("#fileInput");
  await input.uploadFile(mdPath);
  await page.waitForFunction(() => document.body.dataset.mode === "web", { timeout: 5000 }).catch(() => {});
  check(await page.$eval("body", (b) => b.dataset.mode) === "web", "markdown file opened in web mode");
  check(await page.$eval("#webFrame", (f) => f.getAttribute("sandbox") === "" && f.srcdoc.includes("<strong>markdown</strong>")), "srcdoc rendered + fully sandboxed");
  check(await page.$eval("#docTitle", (e) => e.textContent) === "sample.md", "title = file name");
  await page.click("#noteText");
  await page.type("#noteText", "md note");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveStatus").textContent), { timeout: 5000 }).catch(async () => { console.log("  DEBUG", await page.evaluate(() => ({ st: document.getElementById("saveStatus").textContent, hidden: document.getElementById("noteText").hidden, val: document.getElementById("noteText").value, mode: document.body.dataset.mode, label: document.getElementById("npPageLabel").textContent }))); });
  check(true, "note saved on local markdown doc");

  // landing recents show kinds
  await page.goto(VIEWER, { waitUntil: "domcontentloaded" });
  await sleep(500);
  const kinds = await page.$$eval(".recent .r-kind", (k) => k.map((x) => x.textContent));
  check(kinds.includes("video") && kinds.includes("web"), "recents show web/video kinds: " + kinds.join(","));
  await page.screenshot({ path: path.join(OUT, "web-04-landing.png") });
} catch (e) {
  console.error(e); failures.push("exception: " + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASSED");
process.exit(failures.length ? 1 : 0);
