# Privacy policy — Margin Notes

_Last updated: 2026-08-15_

**Margin Notes does not collect, transmit or sell any data.** There is no account, no server, no analytics, no telemetry.

## What is stored, and where

| Data | Where | Leaves your device? |
|---|---|---|
| Your notes and handwriting (per PDF page, web-page section or video timestamp) | IndexedDB in your browser profile, on this device | No |
| Document records (title, URL or file name, page count / duration, section titles, last page) so the library page can list them | IndexedDB, on this device | No |
| Settings (theme, side, font, zoom, drawing options) | `storage.sync` — synced by your browser vendor's account sync if you have that enabled | Only via your own browser sync |

You can export everything as JSON/Markdown and delete all notes from *Settings → Backup*.

## What the extension reads

- **PDFs** you open are rendered locally with pdf.js. The PDF bytes are fetched by the extension from wherever you opened them (URL or file) and never sent anywhere else.
- **Web pages / videos** you take notes on: a small *page agent* is injected only into the tab (or split-view frame) you explicitly opened notes for. It reads the page **title, URL, heading text, the current section, the `<video>` playback time and text you select yourself** so notes can be anchored and quoted. It does not read forms, passwords, cookies or page content beyond that, and it sends nothing off-device.
- Nothing is injected into tabs you have not opened notes for. Turning off "Open PDFs in Margin Notes" stops PDF interception; the side panel only activates when you open it.

## Permissions

`declarativeNetRequest`, `webRequest`, `webNavigation` — redirect PDF navigations into the viewer and detect when an annotated frame has loaded. `scripting` + host access — inject the page agent into the page you are annotating and fetch PDFs. `tabs` — active tab URL/title for the side panel. `sidePanel`/`sidebar_action` — host the notes. `storage`, `unlimitedStorage` — settings and notes. `contextMenus` — right-click entries.

## Third parties

None. No external scripts, fonts or services are loaded by the extension. YouTube split view uses `youtube-nocookie.com`'s embed player, governed by Google's policies, only when you choose split view for a YouTube link.

## Contact

Issues and questions: https://github.com/mastaan66/margin-notes-for-pdf/issues
