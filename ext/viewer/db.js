// IndexedDB store for notes. Keyed by the PDF's fingerprint so notes follow the
// document even if it is moved, renamed, or opened from a different URL.

const DB_NAME = "margin-notes";
const DB_VERSION = 2;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) {
        const docs = db.createObjectStore("docs", { keyPath: "fp" });
        docs.createIndex("lastOpened", "lastOpened");
      }
      if (!db.objectStoreNames.contains("notes")) {
        const notes = db.createObjectStore("notes", { keyPath: "key" }); // key = `${fp}:${page}`
        notes.createIndex("fp", "fp");
        notes.createIndex("updated", "updated");
      }
      if (!db.objectStoreNames.contains("ink")) {
        // key = `${fp}:${target}:${page}`; target = 'note' (sketch pad) | 'page' (drawn on the PDF page)
        const ink = db.createObjectStore("ink", { keyPath: "key" });
        ink.createIndex("fp", "fp");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        try {
          result = fn(s);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result && "result" in result ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async getDoc(fp) {
    const d = await open();
    return reqToPromise(d.transaction("docs").objectStore("docs").get(fp));
  },
  async putDoc(doc) {
    return tx("docs", "readwrite", (s) => s.put(doc));
  },
  async touchDoc(fp, patch) {
    const existing = (await this.getDoc(fp)) || { fp, created: Date.now() };
    const doc = { ...existing, ...patch, fp, lastOpened: Date.now() };
    await this.putDoc(doc);
    return doc;
  },
  async deleteDoc(fp) {
    const notes = await this.getNotesForDoc(fp);
    await tx("notes", "readwrite", (s) => {
      for (const n of notes) s.delete(n.key);
    });
    const ink = await this.getInkForDoc(fp);
    await tx("ink", "readwrite", (s) => {
      for (const i of ink) s.delete(i.key);
    });
    await tx("docs", "readwrite", (s) => s.delete(fp));
  },
  async listDocs() {
    const d = await open();
    const all = await reqToPromise(d.transaction("docs").objectStore("docs").getAll());
    return all.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  },
  async getNote(fp, page) {
    const d = await open();
    return reqToPromise(d.transaction("notes").objectStore("notes").get(`${fp}:${page}`));
  },
  async putNote(fp, page, text) {
    const key = `${fp}:${page}`;
    if (!text || !text.trim()) {
      return tx("notes", "readwrite", (s) => s.delete(key));
    }
    return tx("notes", "readwrite", (s) => s.put({ key, fp, page, text, updated: Date.now() }));
  },
  async getNotesForDoc(fp) {
    const d = await open();
    const list = await reqToPromise(d.transaction("notes").objectStore("notes").index("fp").getAll(fp));
    return list.sort((a, b) => a.page - b.page);
  },
  async countNotesForDoc(fp) {
    const d = await open();
    return reqToPromise(d.transaction("notes").objectStore("notes").index("fp").count(fp));
  },
  // ---- ink ----
  async getInkForDoc(fp) {
    const d = await open();
    return reqToPromise(d.transaction("ink").objectStore("ink").index("fp").getAll(fp));
  },
  async putInk(fp, target, page, strokes) {
    const key = `${fp}:${target}:${page}`;
    if (!strokes || !strokes.length) return tx("ink", "readwrite", (s) => s.delete(key));
    return tx("ink", "readwrite", (s) => s.put({ key, fp, target, page, strokes, updated: Date.now() }));
  },
  async countInkForDoc(fp) {
    const d = await open();
    return reqToPromise(d.transaction("ink").objectStore("ink").index("fp").count(fp));
  },
  async exportAll() {
    const docs = await this.listDocs();
    const d = await open();
    const notes = await reqToPromise(d.transaction("notes").objectStore("notes").getAll());
    const ink = await reqToPromise(d.transaction("ink").objectStore("ink").getAll());
    return { version: 2, exportedAt: new Date().toISOString(), docs, notes, ink };
  },
  async importAll(payload) {
    if (!payload || !Array.isArray(payload.notes)) throw new Error("Invalid backup file");
    let n = 0;
    await tx("docs", "readwrite", (s) => {
      for (const doc of payload.docs || []) if (doc.fp) s.put(doc);
    });
    await tx("notes", "readwrite", (s) => {
      for (const note of payload.notes) {
        if (!note.fp || note.page == null) continue;
        const key = `${note.fp}:${note.page}`;
        s.put({ ...note, key });
        n++;
      }
    });
    if (Array.isArray(payload.ink)) {
      await tx("ink", "readwrite", (s) => {
        for (const rec of payload.ink) {
          if (!rec.fp || rec.page == null || !rec.target || !Array.isArray(rec.strokes)) continue;
          s.put({ ...rec, key: `${rec.fp}:${rec.target}:${rec.page}` });
          n++;
        }
      });
    }
    return n;
  },
};

// Notes as Markdown for one document.
function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + String(s).padStart(2, "0");
}
function timeLink(url, sec) {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === "youtu.be") { u.searchParams.set("t", `${sec}s`); return u.toString(); }
    if (/vimeo\.com$/.test(u.hostname)) { u.hash = `t=${sec}s`; return u.toString(); }
    u.hash = `t=${sec}`; return u.toString();
  } catch { return null; }
}
export function pageHeading(doc, pg) {
  if (pg === 0) return doc?.kind === "video" ? "Whole video" : doc?.kind === "web" ? "Whole page" : "Document notes";
  if (doc?.kind === "video") { const link = doc.url ? timeLink(doc.url, pg) : null; return link ? `[${clock(pg)}](${link})` : clock(pg); }
  if (doc?.kind === "web") { if (pg === 1) return doc.sections?.length ? "Top of page" : "Page"; const t = doc.sections?.[pg - 2]; return t ? `§${pg - 1} ${t}` : `§${pg - 1}`; }
  return `Page ${pg}`;
}
export function notesToMarkdown(doc, notes, ink = []) {
  const title = doc?.title || doc?.filename || (doc?.kind ? "Untitled page" : "Untitled PDF");
  const lines = [`# Notes — ${title}`, ""];
  if (doc?.url) lines.push(`Source: ${doc.url}`, "");
  const inkPages = new Set(ink.map((i) => i.page));
  const unit = doc?.kind === "video" ? "timestamped note" : doc?.kind === "web" ? "section note" : "page note";
  lines.push(`_${notes.length} ${unit}${notes.length === 1 ? "" : "s"}${inkPages.size ? `, handwriting on ${inkPages.size}` : ""}, exported ${new Date().toLocaleString()}_`, "");
  const pages = [...new Set([...notes.map((n) => n.page), ...inkPages])].sort((a, b) => a - b);
  const byPage = new Map(notes.map((n) => [n.page, n]));
  for (const pg of pages) {
    lines.push(`## ${pageHeading(doc, pg)}`, "");
    const n = byPage.get(pg);
    if (n) lines.push(n.text.trim(), "");
    const kinds = ink.filter((i) => i.page === pg).map((i) => (i.target === "page" ? "annotations on the page" : "sketch")).join(" + ");
    if (kinds) lines.push(`_(handwritten ${kinds} — see PNG export)_`, "");
  }
  return lines.join("\n");
}
