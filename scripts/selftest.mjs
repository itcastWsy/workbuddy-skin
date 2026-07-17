// ============================================================================
// Offline self-test: validates the injection contract without a running app.
//   1. Config build from theme.json + skin.css
//   2. Payload executes cleanly under a minimal DOM shim and produces the
//      background layer, style tags, body marker; and __wbSkinRemove() cleans up.
//   3. Idempotency: running the payload twice yields a single set of nodes.
//
// Run: node scripts/selftest.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, "..", "assets");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  \u2713", msg); }
  else { console.error("  \u2717", msg); failures++; }
}

// ---- minimal DOM shim ------------------------------------------------------
function makeDom() {
  class El {
    constructor(tag) { this.tagName = tag; this.id = ""; this.children = []; this.attrs = {}; this._text = ""; this.parentNode = null; }
    get firstChild() { return this.children[0] || null; }
    get textContent() { return this._text; }
    set textContent(v) { this._text = v; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  }
  const all = [];
  const doc = {
    _els: all,
    documentElement: new El("html"),
    head: new El("head"),
    body: new El("body"),
    createElement(t) { const e = new El(t); all.push(e); return e; },
    getElementById(id) {
      const scan = (node) => {
        for (const c of node.children) {
          if (c.id === id) return c;
          const r = scan(c); if (r) return r;
        }
        return null;
      };
      return scan(doc.documentElement) || scan(doc.body);
    },
    addEventListener() { },
  };
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

function makeWindow(doc) {
  const win = {
    document: doc,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    MutationObserver: class { observe() { } disconnect() { } },
  };
  return win;
}

// ---- reuse injector's config builder (inline mirror) -----------------------
function buildConfig() {
  const theme = JSON.parse(readFileSync(join(ASSETS, "theme.json"), "utf8"));
  const skinCss = readFileSync(join(ASSETS, "skin.css"), "utf8");
  const g = theme.glass || {}, bg = theme.background || {};
  const num = (v, d) => (v == null ? d : Number(v));
  const varsCss = `body[data-wb-skin="on"]{--wb-skin-bg-dark:${bg.dark};--wb-skin-panel:rgba(17,21,40,${num(g.panelOpacityDark, 0.46)});}`;
  return { varsCss, skinCss, marker: "on", themeName: theme.name };
}

function buildPayload(config) {
  const injectSrc = readFileSync(join(ASSETS, "renderer-inject.js"), "utf8");
  return `window.__WB_SKIN_CONFIG=${JSON.stringify(config)};\n${injectSrc}`;
}

function run(payload, win) {
  // Execute payload with window/document in scope (renderer runs in a browser global).
  const fn = new Function("window", "document", "setInterval", "clearInterval", "setTimeout", "MutationObserver", payload);
  fn(win, win.document,
    () => 0, () => { }, (cb) => { return 0; },
    win.MutationObserver);
}

// ---- tests -----------------------------------------------------------------
console.log("1) Config build");
const config = buildConfig();
assert(config.skinCss.includes('data-wb-skin="on"'), "skin.css gated by data-wb-skin marker");
assert(config.skinCss.includes("#wb-skin-bg"), "skin.css defines background layer #wb-skin-bg");
assert(config.varsCss.includes("--wb-skin-bg-dark"), "varsCss injects background var");
assert(config.themeName && config.themeName.length > 0, "theme name resolved: " + config.themeName);

console.log("2) Inject into fresh DOM");
const doc = makeDom();
const win = makeWindow(doc);
run(buildPayload(config), win);
assert(win.__wbSkinInstalled === true, "window.__wbSkinInstalled set");
assert(doc.body.getAttribute("data-wb-skin") === "on", "body marker data-wb-skin=on");
assert(doc.getElementById("wb-skin-bg") !== null, "background layer created");
assert(doc.body.firstChild && doc.body.firstChild.id === "wb-skin-bg", "background layer is body's first child");
assert(doc.getElementById("wb-skin-style") !== null, "main style tag created");
assert(doc.getElementById("wb-skin-vars") !== null, "vars style tag created");

console.log("3) Idempotency (run twice)");
run(buildPayload(config), win);
const countBg = doc._els.filter((e) => e.id === "wb-skin-bg").length;
const countStyle = doc._els.filter((e) => e.id === "wb-skin-style").length;
assert(countBg === 1, "still exactly one #wb-skin-bg after re-run (got " + countBg + ")");
assert(countStyle === 1, "still exactly one #wb-skin-style after re-run (got " + countStyle + ")");

console.log("4) Cleanup via __wbSkinRemove()");
const removed = win.__wbSkinRemove();
assert(removed === true, "__wbSkinRemove returned true");
assert(doc.getElementById("wb-skin-bg") === null, "background layer removed");
assert(doc.getElementById("wb-skin-style") === null, "main style removed");
assert(doc.body.getAttribute("data-wb-skin") === null, "body marker removed");

console.log("");
if (failures) { console.error(`SELFTEST FAILED: ${failures} assertion(s).`); process.exit(1); }
console.log("SELFTEST PASSED.");
