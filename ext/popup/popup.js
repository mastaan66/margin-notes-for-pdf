const chrome = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
async function init() {
  const s = await chrome.storage.sync.get({ enabled: true, side: "left" });
  $("enabled").checked = s.enabled;
  paintSide(s.side);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  if (/^(https?|file):/.test(url) && !url.startsWith(chrome.runtime.getURL(""))) {
    const isPdf = /^(https?|file):\/\/[^?#]+\.pdf([?#].*)?$/i.test(url);
    const panelOk = !!(chrome.sidePanel || chrome.sidebarAction);
    if (panelOk && !isPdf) {
      $("openPanel").hidden = false;
      $("openPanel").addEventListener("click", async () => {
        // sidePanel.open / sidebarAction.open must run inside the user gesture → call it here, not in the worker.
        try {
          if (chrome.sidePanel) await chrome.sidePanel.open({ windowId: tab.windowId });
          else await chrome.sidebarAction.open();
        } catch (e) { console.warn(e); }
        chrome.runtime.sendMessage({ type: "injectAgent", tabId: tab.id, frameId: 0 });
        window.close();
      });
    }
    $("openThis").hidden = false;
    $("openThis").textContent = isPdf ? "Open this PDF in Margin Notes" : "Open this tab in split view";
    $("openThis").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "openViewer", url, tabId: tab.id });
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
