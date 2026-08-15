const chrome = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
async function init() {
  const s = await chrome.storage.sync.get({ enabled: true, side: "left" });
  $("enabled").checked = s.enabled;
  paintSide(s.side);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^(https?|file):/.test(tab.url) && !tab.url.startsWith(chrome.runtime.getURL(""))) {
    $("openThis").hidden = false;
    $("openThis").addEventListener("click", () => {
      chrome.tabs.update(tab.id, { url: chrome.runtime.getURL("viewer/viewer.html") + "?file=" + tab.url });
      window.close();
    });
  }
}
function paintSide(side) {
  $("sideLeft").classList.toggle("on", side === "left");
  $("sideRight").classList.toggle("on", side === "right");
}
$("enabled").addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: $("enabled").checked });
  chrome.runtime.sendMessage({ type: "syncRules" });
});
for (const b of document.querySelectorAll("[data-side]")) b.addEventListener("click", () => { chrome.storage.sync.set({ side: b.dataset.side }); paintSide(b.dataset.side); });
$("openLibrary").addEventListener("click", () => { chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html") }); window.close(); });
$("options").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });
init();
