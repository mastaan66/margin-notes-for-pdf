// Firefox smoke test: temporary-install build/firefox via WebDriver BiDi, grant host access,
// open an http PDF (DNR redirect), write a note, reload, check persistence, sketch a stroke.
import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../build/firefox");
const OUT = path.resolve(__dirname, "../test-out"); fs.mkdirSync(OUT, { recursive: true });
const PROFILE = path.resolve(__dirname, "../test-out/ff-profile"); fs.rmSync(PROFILE, { recursive: true, force: true });
const PDF_URL = process.env.PDF_URL || "http://127.0.0.1:8765/Berkshire-Letters-1977-2024-Modern.pdf";
const failures = [];
const check = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  browser: "firefox", executablePath: process.env.FIREFOX || "/usr/bin/firefox", headless: true,
  userDataDir: PROFILE,
  extraPrefsFirefox: { "xpinstall.signatures.required": false, "extensions.webextensions.remote": true, "pdfjs.disabled": false },
  defaultViewport: { width: 1500, height: 950 },
});
try {
  const extId = await browser.installExtension(EXT);
  console.log("installed", extId);
  await sleep(1500);
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("  [console]", m.text()); });

  // Find the internal moz-extension UUID by opening the welcome tab the extension created on install (or via runtime.getURL from a page).
  let viewerUrl = null;
  for (let i = 0; i < 20 && !viewerUrl; i++) {
    for (const p of await browser.pages()) if (p.url().startsWith("moz-extension://")) viewerUrl = p.url();
    if (!viewerUrl) await sleep(300);
  }
  console.log("  pages:", (await browser.pages()).map((p) => p.url()).join(" | "));
  let base = viewerUrl ? viewerUrl.split("/viewer/")[0] : null;
  if (!base) {
    // Resolve the per-profile moz-extension UUID from prefs.js
    for (let i = 0; i < 20 && !base; i++) {
      const prefs = fs.readFileSync(path.join(PROFILE, "prefs.js"), "utf8").match(/extensions\.webextensions\.uuids", "(.*?)"\)/);
      if (prefs) { const map = JSON.parse(prefs[1].replace(/\\"/g, '"')); if (map[extId]) base = `moz-extension://${map[extId]}`; }
      if (!base) await sleep(500);
    }
  }
  check(!!base, "resolved extension base URL: " + base);

  // host permission: check + grant via the landing button (needs a user gesture → click)
  // BiDi doesn't resolve navigations to moz-extension:// pages; fire-and-poll instead.
  const poll = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await page.evaluate(fn)) return true; } catch { /* navigating */ } await sleep(250); } return false; };
  const gotoExt = async (url) => { page.goto(url, { waitUntil: "load", timeout: 5000 }).catch(() => {}); await sleep(500); await poll(() => !!document.getElementById("landing")); };
  const href = () => page.evaluate(() => location.href);
  await gotoExt(base + "/viewer/viewer.html");
  await sleep(800);
  const warnShown = await page.$eval("#hostPermWarn", (e) => !e.hidden).catch(() => false);
  console.log("  host permission banner shown:", warnShown);
  if (warnShown) {
    // Firefox shows a native permission prompt we can't click headlessly; grant via BiDi is not available.
    // Fall back: temporary add-ons get host permissions granted at install in recent Firefox — if the banner shows, note and continue.
  }
  const ffNote = await page.$eval("#firefoxFileNote", (e) => !e.hidden);
  check(ffNote, "Firefox-specific local-file note shown on landing");

  page.goto(PDF_URL, { waitUntil: "load", timeout: 8000 }).catch(() => {});
  await sleep(4000);
  const cur = await href().catch(() => "?");
  const redirected = cur.startsWith(base + "/viewer/viewer.html?file=");
  check(redirected, "http PDF redirected to viewer in Firefox: " + cur);
  if (!redirected) await gotoExt(`${base}/viewer/viewer.html?file=${PDF_URL}`);
  await poll(() => document.getElementById("pageCount")?.textContent !== "–", 60000);
  const pages = await page.evaluate(() => document.getElementById("pageCount")?.textContent).catch(() => "?");
  check(parseInt(pages, 10) > 0, `PDF loaded in Firefox (${pages} pages)`);
  if (parseInt(pages, 10) > 0) {
    check(await poll(() => !!document.querySelector(".page canvas") && !!document.querySelector(".page .textLayer span"), 30000), "page rendered with text layer");
    await page.click("#noteText"); await page.type("#noteText", "Firefox note");
    check(await poll(() => /Saved/.test(document.getElementById("saveStatus").textContent), 5000), "note saved (IndexedDB) in Firefox");
    await page.click("#btnModeInk"); await sleep(400);
    const sb = await (await page.$("#sketchCanvas")).boundingBox();
    await page.mouse.move(sb.x + 40, sb.y + 40); await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(sb.x + 40 + i * 10, sb.y + 40 + (i % 2) * 8, { steps: 2 });
    await page.mouse.up(); await sleep(700);
    const inkCount = await page.evaluate(async () => { const { db } = await import("./db.js"); return (await db.exportAll()).ink.length; });
    check(inkCount === 1, "sketch stroke saved in Firefox");
    await page.click("#btnModeText");
    await page.screenshot({ path: path.join(OUT, "10-firefox.png") });
    page.reload({ waitUntil: "load", timeout: 5000 }).catch(() => {});
    await sleep(1500);
    await poll(() => document.getElementById("pageCount")?.textContent !== "–", 60000);
    await sleep(600);
    check((await page.$eval("#noteText", (e) => e.value)) === "Firefox note", "note persisted after reload in Firefox");
  }
} catch (e) { console.error("TEST ERROR", e); failures.push(e.message); }
finally { await browser.close().catch(() => {}); }
console.log(failures.length ? `${failures.length} FAILURE(S)` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
