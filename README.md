# Margin Notes (Chrome + Firefox extension)

A personal notebook that sits next to whatever you're reading or watching.

- **PDFs** open **docked to the left or right** of the tab; the free space is a notebook with **one note per page**. Notes follow the page you're reading, autosave as you type, and are keyed to the PDF's fingerprint so they survive renames, moves and re-downloads.
- **Web pages, articles, docs** — click the toolbar icon → *Notes for this tab*: the page stays a normal tab and the notes open in the browser **side panel**, one note per **section** (headings), following you as you scroll.
- **Videos (YouTube, courses, any HTML5 player)** — same side panel, but notes anchor to the **playback time**: press *＋ note here* (Alt+Enter) while watching, and click any note later to jump the video back to that moment.
- **Split view for anything embeddable** — local HTML / Markdown / text / images, pages that allow framing, YouTube via its embed player.

Everything is stored locally in the browser (IndexedDB). No accounts, no servers.

## Install

### Chrome / Edge / Brave (unpacked)
1. Open `chrome://extensions` → turn on **Developer mode** (top right).
2. Click **Load unpacked** → choose the `ext/` folder of this repo (or unzip `dist/margin-notes-chrome-<v>.zip`).
3. On the extension's card click **Details** → enable **Allow access to file URLs** (needed for `file://` PDFs — downloads, local files).
4. Open any PDF (link, address bar, local file). It opens in Margin Notes.

### Firefox (temporary add-on)
1. `npm run build` → produces `build/firefox/` and `dist/margin-notes-firefox-<v>.zip`.
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `build/firefox/manifest.json`.
3. If a banner asks, click **Allow access to websites** on the landing page (Firefox MV3 host permissions are opt-in). Firefox 140+ usually grants them at install.
4. Temporary add-ons are removed on restart. For a permanent install, sign it: `npx web-ext sign --source-dir build/firefox --channel unlisted --api-key … --api-secret …` (free AMO account) and install the resulting `.xpi`.

Firefox differences: extensions can't read `file://`, so local PDFs open in Firefox's own viewer — drop them onto the Margin Notes landing page instead. Everything else (interception, notes, ink) is identical.

Pin the toolbar icon if you want the quick toggle / side switch popup (`Alt+Shift+M`).

## What it does

| Area | Details |
|---|---|
| Interception | `http(s)://…*.pdf` via declarativeNetRequest (no flash); PDFs served without `.pdf` via content-type sniff; `file://` via webNavigation; right-click a link → *Open link in Margin Notes*. Attachment downloads are left alone. Toggle off from the popup or settings. |
| Layout | PDF left or right (`Alt+S`), draggable splitter (double-click resets), notes pane hideable (`Alt+N`), light/dark/system theme, "dim pages" night mode. |
| Viewer | Continuous scroll, fit width/page, zoom (`Ctrl`+wheel, `+`/`-`), rotate, find (`Ctrl+F`, highlights in text layer), text selection, clickable internal/external links, outline (bookmarks) tab, `#page=N` deep links, resumes on last page, password PDFs. Rendering is virtualised (~1 screen ahead/behind), tested on a 1971-page PDF. |
| Notes | One note per page + a document-level note. Follows scroll; **pin** to hold a page. Markdown subset with live preview (`Ctrl+E`): headings, lists, tasks, quotes, code, links, `p.12` auto-links to page 12. List continuation, `Tab` indent, `Ctrl+B/I`. Word count, saved indicator, "pages with notes" strip, prev/next noted page. |
| Handwriting | **Draw mode** in the notes pane: a per-page sketch pad (pen / highlighter / stroke-eraser, 6 colours, 3 widths, pressure-sensitive, ruled/grid/dot/blank paper, grows as you write, undo/redo). **Annotate mode** (`A`): write directly on the PDF pages — strokes are stored in PDF coordinates so they stay put across zoom/rotate and are re-rendered on every page render. Pointer Events: pen, mouse and (optionally) touch; palm rejection while a pen is active; pen barrel/eraser button erases. Export any page's handwriting as PNG (page + ink composited). |
| Quote | Select text in the PDF → *Add to notes* bubble (or `Ctrl+Q`) drops it into that page's note as a `>` quote. Same bubble on web pages (drawn by the page agent). |
| Web pages | **Side panel** (Chrome `sidePanel`, Firefox `sidebar_action`) follows the active tab. A small *page agent* (`viewer/frame-agent.js`, injected on demand with `chrome.scripting`) reports headings → sections, the section you're reading, text you select, and Alt+shortcuts. Notes: page 0 = whole page, 1 = top, n = heading n-1. Outline tab lists the headings; clicking scrolls the page. Notes are keyed by a normalised URL (hash / tracking params stripped) so the same page from a link, bookmark or search shares one notebook. |
| Videos | When the page has a `<video>`/`<audio>` (YouTube, Vimeo, course platforms, any HTML5 player) the panel switches to **time mode**: the toolbar shows `mm:ss / duration`, play/pause, ±10 s. *＋ note here* / `Alt+Enter` anchors a note at the current second; notes follow playback (latest anchor ≤ now, or *Whole video*). Clicking a note, a `12:34` typed in any note, or the note strip seeks the video. Markdown export writes `## [12:34](…&t=754s)` links for YouTube/Vimeo. |
| Split view | Landing page → paste a link → *Open in split view* (or right-click → *Open this page in Margin Notes split view*, or `viewer.html?web=URL`). Frames the page like a PDF; agent injected into the frame gives sections/video/quotes; zoom sends CSS zoom to the frame. YouTube links become the embed player. Sites that forbid embedding are **not** forced (no header stripping): after ~7 s a card offers *Open in a tab + side panel* instead. Picked/dropped HTML, Markdown, text and images render in a **fully sandboxed** `srcdoc` frame (opaque origin, no scripts). |
| Panel host | `viewer.html?panel=1` — same viewer with the document pane hidden. Follows `tabs.onActivated`/`onUpdated`; `&tab=<id>` pins it to a tab (used by tests). |
| All notes | Filterable list of every note in the document; click to jump. |
| Storage | IndexedDB, keyed by PDF fingerprint (`docs` + `notes` stores). Export a document's notes as Markdown/JSON, copy all, back up / restore everything from Settings. |
| Library | Viewer with no file = landing page: drop zone / file picker, recent documents with note counts, export, delete. |
| Escape hatch | ⋯ menu → *Open in Chrome's viewer* (one-shot bypass), Download, Print. |

## Layout

```
ext/
  manifest.json         MV3
  background.js         service worker: DNR rules, webRequest sniff, file:// redirect, context menu, messages
  viewer/
    viewer.html/css/js  split-view viewer + notes UI (PDF mode, web/video mode, panel host)
    frame-agent.js      page agent injected into annotated pages (headings, media time, selection, quote bubble)
    panel.html/js       side panel / sidebar entry → viewer.html?panel=1
    db.js               IndexedDB layer + Markdown export
    markdown.js         small safe Markdown renderer
    ink.js              ink engine: pointer-event capture, vector strokes, toolbar, PNG raster
  options/              settings page (sync storage) + backup/import
  popup/                toggle, side switch, open library
  lib/                  pdf.js 6.x (pdf.mjs, worker, cmaps, standard fonts, wasm, iccs)
test/
  e2e.mjs               headless Chrome smoke test (puppeteer-core, uses installExtension)
  e2e-intercept.mjs     content-type sniff / attachment / file:// paths
  e2e-web.mjs           web / video mode: split view + agent, timestamp anchors, panel host, srcdoc files
  e2e-firefox.mjs       Firefox smoke test (temporary install via BiDi) + split-view web mode
  fixtures/             article.html, media.html (+ silence.wav) served by e2e-web on :8766
scripts/build.mjs       browser-specific bundles
```

## Develop / test

```bash
npm install
npm run build             # build/chrome + build/firefox, zips in dist/
npm run lint:firefox      # web-ext lint (AMO validator)
# serve a PDF locally for the http tests (any static server), then:
PDF_URL=http://127.0.0.1:8765/some.pdf npm test          # Chrome e2e (36 checks)
npm run test:intercept                                     # Chrome: sniff / attachment / file://
npm run test:web                                           # Chrome: web / video / panel / srcdoc (34 checks)
npm run test:firefox                                       # Firefox e2e via WebDriver BiDi
```

`ext/` is Chrome-shaped and the source of truth; `scripts/build.mjs` derives the Firefox manifest (event-page background, gecko id, data-collection declaration). Runtime differences are feature-detected (`globalThis.browser ?? chrome`, `IS_FIREFOX`).

Tests use `puppeteer-core` with the system Chrome (`CHROME=/path/to/chrome` to override). Branded Chrome ≥137 ignores `--load-extension`, so tests use `--enable-unsafe-extension-debugging` + `installExtension()`.

## Permissions (why each one)

| Permission | Used for |
|---|---|
| `declarativeNetRequest`, `webRequest`, `webNavigation` | Redirect PDF navigations (by URL, by content-type, `file://`) into the viewer; notice when a framed page has loaded so the agent can be injected. Read-only otherwise. |
| `scripting` + host permission `<all_urls>` | Inject the page agent into the page you're annotating (side panel: the active tab's top frame; split view: the frame) and fetch PDFs from any site. Nothing is injected into tabs you haven't opened notes for. |
| `tabs` | Know the active tab's URL/title for the side panel; open the viewer. |
| `sidePanel` (Chrome) / `sidebar_action` (Firefox) | Host the notes next to a normal tab. |
| `storage`, `unlimitedStorage` | Settings (sync) and notes/handwriting (IndexedDB, local). |
| `contextMenus` | *Take notes on this page*, *Open in split view*, *Open link in Margin Notes*. |

## Notes / limitations

- Notes are stored locally in the browser profile (IndexedDB), not synced. Use *Backup all notes* in Settings.
- Print/“Open in Chrome's viewer” bypasses to Chrome's built-in viewer for that one URL.
- PDF forms and PDF-embedded annotation editing are not supported; handwriting is stored alongside your notes (not written into the PDF file). Use *Export handwriting (PNG)* for a flattened image.
- Web/video notes: sections are heading-index based, so if a page's headings change the notes may shift; timestamps are whole seconds. Handwriting on web pages is the sketch pad only (no ink overlay on the page). Split view can't frame sites that send `X-Frame-Options`/`frame-ancestors` — use the side panel there. Firefox needs the *Allow access to websites* grant for the agent (sections/time tracking); notes work without it.
