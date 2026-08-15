// Margin Notes — service worker.
// Jobs: (1) make sure any PDF the user opens in a tab lands in our viewer instead of
// Chrome's built-in one, unless the user asked to bypass or turned us off; (2) let the
// viewer dock ordinary web pages / HTML / text / images next to notes ("web mode").

// Firefox exposes promise-based APIs on `browser`; Chrome on `chrome`. Use one name.
const chrome = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent);
const VIEWER = chrome.runtime.getURL("viewer/viewer.html");
const RULE_HTTP_PDF = 1;
const BYPASS_TTL_MS = 30_000;
const bypass = new Map(); // url -> expiry timestamp

const PDF_URL_RE = /^(https?|file):\/\/[^?#]+\.pdf([?#].*)?$/i;
// Only these schemes may be docked in the viewer. Everything else (javascript:, data:,
// chrome:, about:, blob:, ftp:, extension pages…) is refused — see openTarget().
const DOCKABLE_RE = /^(https?|file):\/\//i;

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  enabled: true,
  side: "left",         // pdf side: left|right
  splitRatio: 0.58,     // fraction of width taken by the PDF
  theme: "system",      // system|light|dark
  fontSize: 15,
  autoQuote: true,      // show "add to notes" bubble on text selection
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ---------- DNR: fast path for http(s) *.pdf navigations ----------
async function syncRules() {
  const { enabled } = await getSettings();
  const addRules = enabled
    ? [
        {
          id: RULE_HTTP_PDF,
          priority: 1,
          action: {
            type: "redirect",
            redirect: { regexSubstitution: `${VIEWER}?file=\\0` },
          },
          condition: {
            regexFilter: "^https?://[^?#]+\\.pdf([?#].*)?$",
            isUrlFilterCaseSensitive: false,
            resourceTypes: ["main_frame"],
          },
        },
      ]
    : [];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_HTTP_PDF], addRules });
  } catch (e) {
    // Firefox: DNR redirect rules need host access, which the user may not have granted yet.
    console.warn("DNR rule update failed", e);
  }
}

function viewerUrlFor(url) {
  // Keep the original URL raw after `?file=`; the viewer parses everything after it.
  return `${VIEWER}?file=${url}`;
}
// Route any URL to the right viewer mode: PDFs to the PDF viewer, everything else to web mode.
// Returns null for URLs we refuse to dock (privileged / script schemes).
function openTarget(url) {
  if (!url || typeof url !== "string" || !DOCKABLE_RE.test(url)) return null;
  if (url.startsWith(chrome.runtime.getURL(""))) return null;
  return PDF_URL_RE.test(url) ? viewerUrlFor(url) : `${VIEWER}?web=${url}`;
}

function isBypassed(url) {
  const t = bypass.get(url);
  if (!t) return false;
  if (Date.now() > t) {
    bypass.delete(url);
    return false;
  }
  return true;
}

// Let a URL through to Chrome's own viewer once (used by "Open in Chrome viewer").
async function bypassOnce(url, tabId) {
  bypass.set(url, Date.now() + BYPASS_TTL_MS);
  const ruleId = 1000 + (Math.floor(Math.random() * 1e6) | 0);
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: ruleId,
          priority: 10,
          action: { type: "allow" },
          condition: { regexFilter: `^${escaped}$`, resourceTypes: ["main_frame"] },
        },
      ],
    });
  } catch (e) {
    console.warn("bypass rule failed", e);
  }
  if (tabId != null) await chrome.tabs.update(tabId, { url });
  else await chrome.tabs.create({ url });
  setTimeout(() => {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
  }, BYPASS_TTL_MS);
}

async function redirectTab(tabId, url) {
  const { enabled } = await getSettings();
  if (!enabled || isBypassed(url)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && tab.url.startsWith(VIEWER)) return;
    await chrome.tabs.update(tabId, { url: viewerUrlFor(url) });
  } catch (e) {
    /* tab gone */
  }
}

// ---------- web mode: page agent ----------
// Inject the page agent (headings, <video> time, selection → viewer) into a page the
// user is taking notes on: the top frame of a normal tab (side-panel host) or the
// iframe inside a split-view viewer tab. Sites that forbid embedding are simply not
// framed — the split view notices the agent never checked in and offers the side panel.
async function injectAgent(tabId, frameId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (frameId === 0) { if (!DOCKABLE_RE.test(tab?.url || "")) return false; }
    else if (!tab?.url?.startsWith(VIEWER)) return false;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["viewer/frame-agent.js"] });
    return true;
  } catch (e) { return false; }
}
// Frames inside split-view tabs get the agent automatically as they load.
chrome.webNavigation.onDOMContentLoaded.addListener((d) => {
  if (d.frameId === 0 || d.parentFrameId !== 0 || d.tabId < 0) return;
  if (!DOCKABLE_RE.test(d.url)) return;
  injectAgent(d.tabId, d.frameId);
});

// Side panel (Chrome) / sidebar (Firefox): notes next to any normal tab.
const HAS_SIDE_PANEL = !!chrome.sidePanel;
const HAS_SIDEBAR = !!chrome.sidebarAction;
async function openNotesPanel(tab) {
  try {
    if (HAS_SIDE_PANEL) { await chrome.sidePanel.open({ windowId: tab.windowId }); return true; }
    if (HAS_SIDEBAR) { await chrome.sidebarAction.open(); return true; }
  } catch (e) { console.warn("side panel", e); }
  return false;
}
if (HAS_SIDE_PANEL) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// ---------- file:// PDFs (DNR can't touch these) ----------
// Firefox extensions cannot read file:// at all, so leave those to Firefox's own viewer there.
if (!IS_FIREFOX) {
  chrome.webNavigation.onBeforeNavigate.addListener(
    (d) => {
      if (d.frameId !== 0) return;
      if (PDF_URL_RE.test(d.url)) redirectTab(d.tabId, d.url);
    },
    { url: [{ schemes: ["file"] }] }
  );
  // Belt and braces: catches file:// URLs typed/dropped when onBeforeNavigate misses.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url && /^file:/i.test(info.url) && PDF_URL_RE.test(info.url)) {
      redirectTab(tabId, info.url);
    }
  });
}

// ---------- PDFs served without a .pdf extension (content-type sniff) ----------
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.frameId !== 0 || d.tabId < 0) return;
    if (PDF_URL_RE.test(d.url)) return; // DNR already handled it
    if (d.url.startsWith(VIEWER)) return;
    let isPdf = false;
    let isAttachment = false;
    for (const h of d.responseHeaders || []) {
      const n = h.name.toLowerCase();
      if (n === "content-type" && /application\/(x-)?pdf/i.test(h.value || "")) isPdf = true;
      if (n === "content-disposition" && /^\s*attachment/i.test(h.value || "")) isAttachment = true;
    }
    if (isPdf && !isAttachment) redirectTab(d.tabId, d.url);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);

// ---------- context menu ----------
function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "open-in-margin-notes",
      title: "Open link in Margin Notes",
      contexts: ["link"],
      targetUrlPatterns: ["*://*/*", "file:///*"],
    });
    chrome.contextMenus.create({
      id: "notes-panel",
      title: "Take notes on this page (side panel)",
      contexts: ["page", "video", "audio", "selection", "frame"],
      documentUrlPatterns: ["*://*/*", "file:///*"],
    });
    chrome.contextMenus.create({
      id: "open-page-in-margin-notes",
      title: "Open this page in Margin Notes split view",
      contexts: ["page", "video", "audio", "frame"],
      documentUrlPatterns: ["*://*/*", "file:///*"],
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-in-margin-notes" && info.linkUrl) {
    const t = openTarget(info.linkUrl);
    if (t) chrome.tabs.create({ url: t, index: tab ? tab.index + 1 : undefined });
  } else if (info.menuItemId === "notes-panel" && tab) {
    openNotesPanel(tab).then((ok) => { if (ok && tab.id != null) setTimeout(() => injectAgent(tab.id, 0), 300); });
  } else if (info.menuItemId === "open-page-in-margin-notes" && info.pageUrl) {
    const t = openTarget(info.pageUrl);
    if (t && tab?.id != null) chrome.tabs.update(tab.id, { url: t });
  }
});

// ---------- lifecycle ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  await syncRules();
  installContextMenu();
  if (details.reason === "install") {
    chrome.tabs.create({ url: `${VIEWER}?welcome=1` });
  }
});
chrome.runtime.onStartup.addListener(() => {
  syncRules();
  installContextMenu();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.enabled) syncRules();
});
chrome.permissions?.onAdded?.addListener(() => syncRules());

// ---------- messages from viewer / popup / options ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.mnAgent) return false; // page-agent traffic is for the viewer / panel, not us
  (async () => {
    switch (msg?.type) {
      case "bypass": {
        await bypassOnce(msg.url, sender.tab?.id ?? msg.tabId ?? null);
        return { ok: true };
      }
      case "getFileAccess": {
        if (IS_FIREFOX) return { allowed: false, firefox: true };
        const allowed = await new Promise((r) => { const p = chrome.extension.isAllowedFileSchemeAccess(r); if (p?.then) p.then(r); });
        return { allowed, firefox: false };
      }
      case "getHostAccess": {
        try { return { granted: await chrome.permissions.contains({ origins: ["<all_urls>"] }), firefox: IS_FIREFOX }; }
        catch { return { granted: true, firefox: IS_FIREFOX }; }
      }
      case "openExtensionsPage": {
        if (IS_FIREFOX) return { ok: false, hint: "about:addons" }; // privileged URL, can't be opened by extensions
        await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
        return { ok: true };
      }
      case "openOptions": {
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      }
      case "openViewer": {
        const t = msg.url ? openTarget(msg.url) : VIEWER;
        if (!t) return { ok: false, error: "That kind of URL can't be opened in Margin Notes." };
        if (msg.tabId != null) await chrome.tabs.update(msg.tabId, { url: t }); else await chrome.tabs.create({ url: t });
        return { ok: true };
      }
      case "openTarget": {
        // Resolve without navigating (used by popup / viewer to build links).
        return { url: openTarget(msg.url) };
      }
      case "injectAgent": {
        // Panel host: {tabId, frameId: 0}. Split view: no args → every direct sub-frame of the sender's tab
        // (fallback for when webNavigation missed the frame, e.g. bfcache / same-document navigation).
        if (msg.tabId != null) return { ok: await injectAgent(msg.tabId, msg.frameId || 0) };
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: false };
        let frames = [];
        try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch { /* ignore */ }
        let n = 0;
        for (const f of frames) if (f.frameId !== 0 && f.parentFrameId === 0 && DOCKABLE_RE.test(f.url || "")) { if (await injectAgent(tabId, f.frameId)) n++; }
        return { ok: true, injected: n };
      }
      case "openPanel": {
        // Must be triggered from a user gesture in the caller (popup / landing click).
        let tab = null;
        try { tab = msg.tabId != null ? await chrome.tabs.get(msg.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; } catch { /* ignore */ }
        if (!tab) return { ok: false };
        const ok = await openNotesPanel(tab);
        if (ok) setTimeout(() => injectAgent(tab.id, 0), 300);
        return { ok, supported: HAS_SIDE_PANEL || HAS_SIDEBAR };
      }
      case "panelSupported": return { supported: HAS_SIDE_PANEL || HAS_SIDEBAR };
      case "getActiveTab": {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return t ? { id: t.id, url: t.url, title: t.title, windowId: t.windowId } : {};
      }
      case "openInTab": {
        if (!DOCKABLE_RE.test(msg.url || "")) return { ok: false };
        await chrome.tabs.create({ url: msg.url, index: sender.tab ? sender.tab.index + 1 : undefined });
        return { ok: true };
      }
      case "syncRules": {
        await syncRules();
        return { ok: true };
      }
      case "getSettings": {
        return await getSettings();
      }
      default:
        return { error: "unknown message" };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // async
});

// Make sure rules exist even if the worker was restarted without events firing.
syncRules().catch(() => {});
