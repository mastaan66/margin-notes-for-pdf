# Margin Notes for PDF (Chrome extension)

Opens every PDF you land on **docked to the left or right** of the tab, and turns the free space into a **notebook with one note per page**. Notes follow the page you're reading, autosave as you type, and are keyed to the PDF's fingerprint so they survive renames, moves and re-downloads.

## Install (unpacked)

1. Open `chrome://extensions` → turn on **Developer mode** (top right).
2. Click **Load unpacked** → choose the `ext/` folder of this repo.
3. On the extension's card click **Details** → enable **Allow access to file URLs** (needed for `file://` PDFs — downloads, local files).
4. Open any PDF (link, address bar, local file). It opens in Margin Notes.

Pin the toolbar icon if you want the quick toggle / side switch popup (`Alt+Shift+M`).

## What it does

| Area | Details |
|---|---|
| Interception | `http(s)://…*.pdf` via declarativeNetRequest (no flash); PDFs served without `.pdf` via content-type sniff; `file://` via webNavigation; right-click a link → *Open link in Margin Notes*. Attachment downloads are left alone. Toggle off from the popup or settings. |
| Layout | PDF left or right (`Alt+S`), draggable splitter (double-click resets), notes pane hideable (`Alt+N`), light/dark/system theme, "dim pages" night mode. |
| Viewer | Continuous scroll, fit width/page, zoom (`Ctrl`+wheel, `+`/`-`), rotate, find (`Ctrl+F`, highlights in text layer), text selection, clickable internal/external links, outline (bookmarks) tab, `#page=N` deep links, resumes on last page, password PDFs. Rendering is virtualised (~1 screen ahead/behind), tested on a 1971-page PDF. |
| Notes | One note per page + a document-level note. Follows scroll; **pin** to hold a page. Markdown subset with live preview (`Ctrl+E`): headings, lists, tasks, quotes, code, links, `p.12` auto-links to page 12. List continuation, `Tab` indent, `Ctrl+B/I`. Word count, saved indicator, "pages with notes" strip, prev/next noted page. |
| Handwriting | **Draw mode** in the notes pane: a per-page sketch pad (pen / highlighter / stroke-eraser, 6 colours, 3 widths, pressure-sensitive, ruled/grid/dot/blank paper, grows as you write, undo/redo). **Annotate mode** (`A`): write directly on the PDF pages — strokes are stored in PDF coordinates so they stay put across zoom/rotate and are re-rendered on every page render. Pointer Events: pen, mouse and (optionally) touch; palm rejection while a pen is active; pen barrel/eraser button erases. Export any page's handwriting as PNG (page + ink composited). |
| Quote | Select text in the PDF → *Add to notes* bubble (or `Ctrl+Q`) drops it into that page's note as a `>` quote. |
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
    viewer.html/css/js  split-view viewer + notes UI
    db.js               IndexedDB layer + Markdown export
    markdown.js         small safe Markdown renderer
    ink.js              ink engine: pointer-event capture, vector strokes, toolbar, PNG raster
  options/              settings page (sync storage) + backup/import
  popup/                toggle, side switch, open library
  lib/                  pdf.js 6.x (pdf.mjs, worker, cmaps, standard fonts, wasm, iccs)
test/
  e2e.mjs               headless Chrome smoke test (puppeteer-core, uses installExtension)
  e2e-intercept.mjs     content-type sniff / attachment / file:// paths
```

## Develop / test

```bash
npm install
# serve a PDF locally for the http test (any static server), then:
PDF_URL=http://127.0.0.1:8765/some.pdf npm test
npm run test:intercept
npm run pack        # → dist/margin-notes-<version>.zip
```

Tests use `puppeteer-core` with the system Chrome (`CHROME=/path/to/chrome` to override). Branded Chrome ≥137 ignores `--load-extension`, so tests use `--enable-unsafe-extension-debugging` + `installExtension()`.

## Notes / limitations

- Notes are stored locally in the browser profile (IndexedDB), not synced. Use *Backup all notes* in Settings.
- Print/“Open in Chrome's viewer” bypasses to Chrome's built-in viewer for that one URL.
- PDF forms and PDF-embedded annotation editing are not supported; handwriting is stored alongside your notes (not written into the PDF file). Use *Export handwriting (PNG)* for a flattened image.
