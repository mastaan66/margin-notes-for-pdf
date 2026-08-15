import { db, notesToMarkdown } from "../viewer/db.js";
const chrome = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = { enabled: true, side: "left", splitRatio: 0.58, theme: "system", fontSize: 15, fontFamily: "serif", autoQuote: true, defaultZoom: "width", touchDraws: true, paper: "lines" };
const $ = (id) => document.getElementById(id);
const status = (m) => { $("status").textContent = m; setTimeout(() => { if ($("status").textContent === m) $("status").textContent = ""; }, 4000); };

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  document.documentElement.dataset.theme = s.theme;
  $("enabled").checked = s.enabled; $("side").value = s.side; $("splitRatio").value = Math.round(s.splitRatio * 100);
  $("splitVal").textContent = `${Math.round(s.splitRatio * 100)}%`;
  $("defaultZoom").value = s.defaultZoom; $("theme").value = s.theme; $("fontFamily").value = s.fontFamily; $("fontSize").value = s.fontSize; $("autoQuote").checked = s.autoQuote; $("autoQuoteWeb").checked = s.autoQuote; $("touchDraws").checked = s.touchDraws; $("paper").value = s.paper;
}
function bind(id, key, get) {
  $(id).addEventListener("change", async () => {
    const v = get($(id));
    await chrome.storage.sync.set({ [key]: v });
    if (key === "enabled") chrome.runtime.sendMessage({ type: "syncRules" });
    if (key === "theme") document.documentElement.dataset.theme = v;
    status("Saved");
  });
}
bind("enabled", "enabled", (e) => e.checked);
bind("side", "side", (e) => e.value);
bind("defaultZoom", "defaultZoom", (e) => e.value);
bind("theme", "theme", (e) => e.value);
bind("fontFamily", "fontFamily", (e) => e.value);
bind("fontSize", "fontSize", (e) => Math.max(11, Math.min(24, parseInt(e.value, 10) || 15)));
bind("autoQuote", "autoQuote", (e) => e.checked);
bind("autoQuoteWeb", "autoQuote", (e) => e.checked);
$("autoQuote").addEventListener("change", () => { $("autoQuoteWeb").checked = $("autoQuote").checked; });
$("autoQuoteWeb").addEventListener("change", () => { $("autoQuote").checked = $("autoQuoteWeb").checked; });
bind("touchDraws", "touchDraws", (e) => e.checked);
bind("paper", "paper", (e) => e.value);
$("splitRatio").addEventListener("input", () => { $("splitVal").textContent = `${$("splitRatio").value}%`; });
bind("splitRatio", "splitRatio", (e) => parseInt(e.value, 10) / 100);

$("fileAccess").addEventListener("click", async () => {
  const { allowed } = await chrome.runtime.sendMessage({ type: "getFileAccess" });
  if (allowed) status("Local file access is enabled.");
  else { status("Not enabled — opening the extension page; toggle “Allow access to file URLs”."); chrome.runtime.sendMessage({ type: "openExtensionsPage" }); }
});
function download(name, text, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$("exportAll").addEventListener("click", async () => {
  const all = await db.exportAll();
  download(`margin-notes-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(all, null, 2), "application/json");
  status(`Exported ${all.notes.length} notes across ${all.docs.length} documents.`);
});
$("exportMd").addEventListener("click", async () => {
  const docs = await db.listDocs();
  const parts = [];
  for (const d of docs) { const notes = await db.getNotesForDoc(d.fp); if (notes.length) parts.push(notesToMarkdown(d, notes)); }
  download(`margin-notes-${new Date().toISOString().slice(0, 10)}.md`, parts.join("\n\n---\n\n"), "text/markdown");
  status(`Exported notes from ${parts.length} documents.`);
});
$("importFile").addEventListener("change", async () => {
  const f = $("importFile").files?.[0]; if (!f) return;
  try { const n = await db.importAll(JSON.parse(await f.text())); status(`Imported ${n} notes.`); }
  catch (e) { status("Import failed: " + e.message); }
  $("importFile").value = "";
});
$("wipe").addEventListener("click", async () => {
  if (!confirm("Delete ALL notes for ALL documents? This cannot be undone. Export a backup first.")) return;
  const docs = await db.listDocs();
  for (const d of docs) await db.deleteDoc(d.fp);
  status("All notes deleted.");
});
load();
