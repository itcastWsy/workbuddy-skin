// ============================================================================
// Offline self-test: validates the injection contract without a running app.
//   1. Config build from theme.json + skin.css
//   2. Payload executes cleanly under a minimal DOM shim and produces the
//      background layer, style tags, body marker; and __wbSkinRemove() cleans up.
//   3. Idempotency: running the payload twice yields a single set of nodes.
//
// Run: node scripts/selftest.mjs
// ============================================================================
import { readFileSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Jimp, JimpMime } from "jimp";
import { processIntoStore, IMAGE_CAP_BYTES, dominantAccent } from "./image.mjs";

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

console.log("5) Auto-resize on import (image.mjs)");
{
  const tmp = mkdtempSync(join(tmpdir(), "wbskin-"));

  // 5a. Small file short-circuits: copied verbatim, no re-encode.
  const smallSrc = join(tmp, "small.png");
  writeFileSync(smallSrc, Buffer.alloc(2048, 7)); // 2KB, well under the cap
  const small = await processIntoStore(smallSrc, tmp, { kind: "wallpaper" });
  assert(small.resized === false, "small source copied as-is (no re-encode)");
  assert(small.bytes === 2048, "small source bytes unchanged");

  // Build one oversized, poorly-compressible source (LCG pseudo-noise PNG).
  const N = 2000;
  const noisy = new Jimp({ width: N, height: N, color: 0x000000ff });
  const d = noisy.bitmap.data;
  let s = 123456789;
  for (let i = 0; i < d.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = s & 255; d[i + 1] = (s >> 8) & 255; d[i + 2] = (s >> 16) & 255; d[i + 3] = 255;
  }
  const bigSrc = join(tmp, "big.png");
  writeFileSync(bigSrc, await noisy.getBuffer(JimpMime.png));
  const bigBytes = statSync(bigSrc).size;
  assert(bigBytes > IMAGE_CAP_BYTES, `test source exceeds cap (${(bigBytes / 1024 / 1024).toFixed(1)}MB)`);

  // 5b. Oversized wallpaper -> re-encoded to a smaller JPEG.
  const w = await processIntoStore(bigSrc, tmp, { kind: "wallpaper" });
  assert(w.resized === true, "oversized wallpaper was re-encoded");
  assert(w.dest.endsWith(".jpg"), "wallpaper stored as .jpg");
  assert(w.bytes < bigBytes, `wallpaper shrank (${(w.bytes / 1024).toFixed(0)}KB < source)`);

  // 5c. Oversized portrait -> stays PNG (alpha preserved), downscaled smaller.
  const p = await processIntoStore(bigSrc, tmp, { kind: "portrait" });
  assert(p.dest.endsWith(".png"), "portrait stored as .png (alpha preserved)");
  assert(p.bytes < bigBytes, `portrait shrank (${(p.bytes / 1024).toFixed(0)}KB < source)`);
}

console.log("6) Accent color extraction (image.mjs)");
{
  const tmp = mkdtempSync(join(tmpdir(), "wbskin-acc-"));

  // Vivid teal-dominant image (+ mild jitter) -> accent hue should read teal-ish.
  const W = 200;
  const teal = new Jimp({ width: W, height: W, color: 0x00a0a0ff });
  const td = teal.bitmap.data;
  let s = 42;
  for (let i = 0; i < td.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    td[i] = Math.max(0, Math.min(255, td[i] + ((s & 15) - 7)));
    td[i + 1] = Math.max(0, Math.min(255, td[i + 1] + (((s >> 4) & 15) - 7)));
    td[i + 2] = Math.max(0, Math.min(255, td[i + 2] + (((s >> 8) & 15) - 7)));
  }
  const tealSrc = join(tmp, "teal.png");
  writeFileSync(tealSrc, await teal.getBuffer(JimpMime.png));
  const acc = await dominantAccent(tealSrc);
  assert(typeof acc === "string" && /^#[0-9a-f]{6}$/i.test(acc), "accent is a hex string (" + acc + ")");
  const R = parseInt(acc.slice(1, 3), 16), G = parseInt(acc.slice(3, 5), 16), B = parseInt(acc.slice(5, 7), 16);
  assert(G > R && B > R && Math.abs(G - B) < 45, `accent reads teal-ish (${acc})`);

  // Pure grayscale wallpaper -> no accent (returns null, falls back to default border).
  const gray = new Jimp({ width: 64, height: 64, color: 0x808080ff });
  const graySrc = join(tmp, "gray.png");
  writeFileSync(graySrc, await gray.getBuffer(JimpMime.png));
  const none = await dominantAccent(graySrc);
  assert(none === null, "grayscale wallpaper yields no accent (null)");
}

console.log("");
if (failures) { console.error(`SELFTEST FAILED: ${failures} assertion(s).`); process.exit(1); }
console.log("SELFTEST PASSED.");
