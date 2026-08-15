// IndexedDB store for notes. Keyed by the PDF's fingerprint so notes follow the
// document even if it is moved, renamed, or opened from a different URL.

const DB_NAME = "margin-notes";
const DB_VERSION = 1;
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
  async exportAll() {
    const docs = await this.listDocs();
    const d = await open();
    const notes = await reqToPromise(d.transaction("notes").objectStore("notes").getAll());
    return { version: 1, exportedAt: new Date().toISOString(), docs, notes };
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
    return n;
  },
};

// Notes as Markdown for one document.
export function notesToMarkdown(doc, notes) {
  const title = doc?.title || doc?.filename || "Untitled PDF";
  const lines = [`# Notes — ${title}`, ""];
  if (doc?.url) lines.push(`Source: ${doc.url}`, "");
  lines.push(`_${notes.length} page note${notes.length === 1 ? "" : "s"}, exported ${new Date().toLocaleString()}_`, "");
  for (const n of notes) {
    lines.push(n.page === 0 ? "## Document notes" : `## Page ${n.page}`, "", n.text.trim(), "");
  }
  return lines.join("\n");
}
