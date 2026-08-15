// Store screenshots (1280×800): PDF split view, YouTube + side panel, article split view, library.
// Needs: a PDF at PDF_URL (default http://127.0.0.1:8765/Berkshire-Letters-1977-2024-Modern.pdf), network for YouTube.
import puppeteer from "puppeteer-core";
import path from "node:path"; import fs from "node:fs"; import http from "node:http";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "store", "screenshots"); fs.mkdirSync(OUT, { recursive: true });
const PDF_URL = process.env.PDF_URL || "http://127.0.0.1:8765/Berkshire-Letters-1977-2024-Modern.pdf";
const YT = process.env.YT || "https://www.youtube.com/watch?v=aircAruvnKk";
const FIX = path.join(ROOT, "test", "fixtures");
const server = http.createServer((req, res) => { const f = path.join(FIX, new URL(req.url, "http://x").pathname); if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(f)); }).listen(8767);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new", pipe: true, enableExtensions: true, args: ["--no-sandbox", "--window-size=1280,800", "--autoplay-policy=no-user-gesture-required", "--lang=en-US"], defaultViewport: { width: 1280, height: 800 } });
await browser.installExtension(path.join(ROOT, "ext"));
const sw = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 }); const extId = new URL(sw.url()).host;
const VIEWER = `chrome-extension://${extId}/viewer/viewer.html`;
await sleep(1000);
try {
  // 1. PDF
  const p = await browser.newPage();
  await p.goto(`${VIEWER}?file=${PDF_URL}#page=3`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => document.querySelector(".page.rendered canvas"), { timeout: 60000 });
  await p.click("#noteText");
  await p.type("#noteText", "# 1977 letter — key ideas\n\n- Operating earnings, not per-share numbers, are the yardstick\n- [ ] Re-read the insurance section\n\n> We select our marketable equity securities in much the same way we would evaluate a business for acquisition\n\nSee p.5 for the textile discussion.");
  await sleep(700);
  await p.screenshot({ path: path.join(OUT, "01-pdf.png") });
  // 2. YouTube + panel: composite by placing panel page at 400px wide next to a 880px site shot
  const site = await browser.newPage(); await site.setViewport({ width: 880, height: 800 });
  await site.goto(YT, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  await sleep(4000);
  await site.evaluate(() => { const v = document.querySelector("video"); if (v) { v.currentTime = 95; v.play().catch(() => {}); } });
  await sleep(1500);
  const tabId = await p.evaluate(async () => (await chrome.tabs.query({ url: "*://www.youtube.com/*" }))[0]?.id);
  const panel = await browser.newPage(); await panel.setViewport({ width: 400, height: 800 });
  await panel.goto(`${VIEWER}?panel=1&tab=${tabId}`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await panel.evaluate(() => document.getElementById("btnAnchor").click());
  await sleep(300);
  await panel.type("#noteText", "Neurons = things that hold a number 0–1 (activation).\n\n784 input neurons for 28×28 pixels → 10 output digits.");
  await sleep(600);
  await site.bringToFront(); await site.evaluate(() => document.querySelector("video")?.pause());
  await sleep(500);
  const siteShot = await site.screenshot({ encoding: "binary" });
  await panel.bringToFront();
  const panelShot = await panel.screenshot({ encoding: "binary" });
  // stitch with a canvas in the viewer page
  const composite = await p.evaluate(async (a, b) => {
    const load = (buf) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + buf; });
    const [A, B] = await Promise.all([load(a), load(b)]);
    const c = document.createElement("canvas"); c.width = 1280; c.height = 800; const ctx = c.getContext("2d");
    ctx.drawImage(A, 0, 0); ctx.drawImage(B, 880, 0);
    ctx.fillStyle = "#3a3a44"; ctx.fillRect(879, 0, 2, 800);
    return c.toDataURL("image/png").split(",")[1];
  }, siteShot.toString("base64"), panelShot.toString("base64"));
  fs.writeFileSync(path.join(OUT, "02-video.png"), Buffer.from(composite, "base64"));
  await site.close(); await panel.close();
  // 3. article split view
  const ARTICLE = process.env.ARTICLE || "https://en.wikipedia.org/wiki/Marginalia";
  await p.goto(`${VIEWER}?web=${ARTICLE}`, { waitUntil: "domcontentloaded" });
  let ok = await p.waitForFunction(() => parseInt(document.getElementById("pageCount").textContent, 10) > 2, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!ok) { await p.goto(`${VIEWER}?web=http://127.0.0.1:8767/article.html`, { waitUntil: "domcontentloaded" }); await p.waitForFunction(() => document.getElementById("pageCount").textContent === "6", { timeout: 15000 }).catch(() => {}); }
  await sleep(1500);
  await p.evaluate(() => document.querySelectorAll("#outline .ol-link")[1]?.click()); await sleep(800);
  await p.click('.notes-tabs .tab[data-tab="page"]');
  await p.click("#noteText"); await p.type("#noteText", "Section notes follow the heading you're reading.\n\n- Outline tab lists every heading\nSelect text on the page → *Add to notes*");
  await sleep(600);
  await p.screenshot({ path: path.join(OUT, "03-article.png") });
  // 4. library
  await p.goto(VIEWER, { waitUntil: "domcontentloaded" }); await sleep(800);
  await p.screenshot({ path: path.join(OUT, "04-library.png") });
  console.log("wrote", fs.readdirSync(OUT));
} catch (e) { console.error(e); }
finally { await browser.close(); server.close(); }
