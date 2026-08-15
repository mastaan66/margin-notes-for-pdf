// Interception paths beyond the .pdf-suffix DNR rule: content-type sniffing and file://.
import puppeteer from "puppeteer-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../ext");
const PDF = process.env.PDF || "/home/mastan/Berkshire-Letters-1977-2024-Modern.pdf";
const buf = fs.readFileSync(PDF);
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/paper/123")) { res.writeHead(200, { "content-type": "application/pdf", "content-length": buf.length }); res.end(buf); }
  else if (req.url.startsWith("/dl")) { res.writeHead(200, { "content-type": "application/pdf", "content-disposition": "attachment; filename=x.pdf", "content-length": buf.length }); res.end(buf); }
  else { res.writeHead(404); res.end(); }
}).listen(8766);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new", pipe: true, enableExtensions: true, args: ["--no-sandbox"] });
await browser.installExtension(EXT);
const failures = [];
const check = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failures.push(m); };
try {
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  await new Promise((r) => setTimeout(r, 1000));
  const p = await browser.newPage();
  await p.goto("http://127.0.0.1:8766/paper/123", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  check(p.url().startsWith(`chrome-extension://${extId}/viewer/viewer.html?file=http://127.0.0.1:8766/paper/123`), "content-type sniffed PDF redirected: " + p.url());
  await p.waitForFunction(() => document.getElementById("pageCount").textContent !== "–", { timeout: 60000 });
  check(true, "extension-less PDF loaded in viewer");

  const p2 = await browser.newPage();
  await p2.goto("http://127.0.0.1:8766/dl", { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  check(!p2.url().startsWith("chrome-extension://"), "attachment download NOT hijacked: " + p2.url());

  const p3 = await browser.newPage();
  await p3.goto("file://" + PDF, { waitUntil: "domcontentloaded", timeout: 20000 }).catch((e) => console.log("  (file nav) ", e.message));
  await new Promise((r) => setTimeout(r, 1500));
  console.log("  file:// landed at:", p3.url());
  if (p3.url().startsWith("chrome-extension://")) {
    await new Promise((r) => setTimeout(r, 1500));
    const state = await p3.evaluate(() => ({ landing: !document.getElementById("landing").hidden, err: document.getElementById("loadError").textContent.slice(0, 120), warn: !document.getElementById("fileAccessWarn").hidden, pages: document.getElementById("pageCount").textContent }));
    console.log("  file:// viewer state:", JSON.stringify(state));
    check(state.pages !== "–" || state.warn, "file:// either loads or shows the file-access hint");
  } else {
    console.log("  (file:// navigation not observed by extension without file access — expected in headless)");
  }
} catch (e) { console.error(e); failures.push(e.message); }
finally { await browser.close(); server.close(); }
console.log(failures.length ? `${failures.length} FAILURE(S)` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
