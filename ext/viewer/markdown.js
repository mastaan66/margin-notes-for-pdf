// Tiny, safe Markdown subset for note previews. Escapes HTML first, then applies
// a handful of block + inline rules. Enough for headings, lists, quotes, code,
// emphasis, links, and task boxes; intentionally not a full spec.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PH_OPEN = "";
const PH_CLOSE = "";

function inline(s) {
  // code spans first so their contents aren't touched
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `${PH_OPEN}${codes.push(`<code>${c}</code>`) - 1}${PH_CLOSE}`);
  s = s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/==(.+?)==/g, "<mark>$1</mark>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|#p(?:age)?=?\d+)\)/g, (_, t, u) => {
      const m = /^#p(?:age)?=?(\d+)$/.exec(u);
      if (m) return `<a href="#" data-page="${m[1]}">${t}</a>`;
      return `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    })
    .replace(/(^|\s)(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    // "p.12" / "page 12" jump links
    .replace(/(^|[\s(])((?:p\.|page )(\d{1,4}))\b/gi, (m, pre, whole, num) => `${pre}<a href="#" data-page="${num}" class="pref">${whole}</a>`);
  return s.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"), (_, i) => codes[i]);
}

export function renderMarkdown(src) {
  const lines = esc(src || "").split(/\r?\n/);
  const out = [];
  let i = 0;
  let listType = null; // 'ul' | 'ol'
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    if (/^```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      closeList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
    } else if ((m = /^&gt;\s?(.*)$/.exec(line))) {
      closeList();
      const buf = [m[1]];
      while (i + 1 < lines.length && /^&gt;\s?/.test(lines[i + 1])) buf.push(lines[++i].replace(/^&gt;\s?/, ""));
      out.push(`<blockquote>${buf.map(inline).join("<br>")}</blockquote>`);
    } else if ((m = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line))) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        out.push('<ul class="tasks">');
      }
      const done = m[1] !== " ";
      out.push(`<li class="task${done ? " done" : ""}"><input type="checkbox" disabled${done ? " checked" : ""}> ${inline(m[2])}</li>`);
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        out.push("<ul>");
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        out.push("<ol>");
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      // paragraph: merge consecutive text lines
      const buf = [line];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() !== "" &&
        !/^(#{1,6}\s|&gt;|\s*[-*+]\s|\s*\d+[.)]\s|```)/.test(lines[i + 1])
      ) {
        buf.push(lines[++i]);
      }
      out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
    }
    i++;
  }
  closeList();
  return out.join("\n");
}
