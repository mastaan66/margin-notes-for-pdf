// Margin Notes for PDF — service worker.
// Job: make sure any PDF the user opens in a tab lands in our viewer instead of
// Chrome's built-in one, unless the user asked to bypass or turned us off.

// Firefox exposes promise-based APIs on `browser`; Chrome on `chrome`. Use one name.
const chrome = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent);
const VIEWER = chrome.runtime.getURL("viewer/viewer.html");
const RULE_HTTP_PDF = 1;
const BYPASS_TTL_MS = 30_000;
const bypass = new Map(); // url -> expiry timestamp

const PDF_URL_RE = /^(https?|file):\/\/[^?#]+\.pdf([?#].*)?$/i;

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
      targetUrlPatterns: ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.pdf#*", "*://*/*.PDF", "file:///*.pdf"],
    });
    chrome.contextMenus.create({
      id: "open-page-in-margin-notes",
      title: "Open this page in Margin Notes",
      contexts: ["page"],
      documentUrlPatterns: ["*://*/*", "file:///*"],
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-in-margin-notes" && info.linkUrl) {
    chrome.tabs.create({ url: viewerUrlFor(info.linkUrl), index: tab ? tab.index + 1 : undefined });
  } else if (info.menuItemId === "open-page-in-margin-notes" && info.pageUrl) {
    if (tab?.id != null) chrome.tabs.update(tab.id, { url: viewerUrlFor(info.pageUrl) });
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
        await chrome.tabs.create({ url: msg.url ? viewerUrlFor(msg.url) : VIEWER });
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
