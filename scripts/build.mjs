// Builds browser-specific bundles: build/chrome and build/firefox (+ zips in dist/).
// Source of truth is ext/ (Chrome-shaped manifest); Firefox needs an event-page
// background, a gecko id (required for storage.sync), and no Chrome-only keys.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const src = path.join(root, "ext");
const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
const version = manifest.version;
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });

function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: (p) => !p.endsWith(".map") });
}
function zip(dir, out) {
  fs.rmSync(out, { force: true });
  execSync(`cd "${dir}" && zip -qr "${out}" .`, { stdio: "inherit" });
  console.log("wrote", path.relative(root, out), (fs.statSync(out).size / 1e6).toFixed(1) + " MB");
}

// ---- Chrome ----
const chromeDir = path.join(root, "build", "chrome");
copyTree(src, chromeDir);
zip(chromeDir, path.join(dist, `margin-notes-chrome-${version}.zip`));

// ---- Firefox ----
const ffDir = path.join(root, "build", "firefox");
copyTree(src, ffDir);
const ff = structuredClone(manifest);
delete ff.minimum_chrome_version;
ff.background = { scripts: ["background.js"], type: "module" };
ff.browser_specific_settings = {
  gecko: { id: "margin-notes@lumenar.dev", strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } },
};
// Firefox: `commands._execute_action` is fine; `web_accessible_resources` same shape.
// unlimitedStorage + contextMenus + webNavigation + webRequest + declarativeNetRequest all exist in Firefox MV3.
fs.writeFileSync(path.join(ffDir, "manifest.json"), JSON.stringify(ff, null, 2) + "\n");
zip(ffDir, path.join(dist, `margin-notes-firefox-${version}.zip`));
console.log("done: build/chrome, build/firefox");
