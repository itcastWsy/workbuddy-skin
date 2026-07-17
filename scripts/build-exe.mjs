// ============================================================================
// WorkBuddy Skin — single-file executable builder (Node SEA)
//
// Produces a self-contained double-click executable for the CURRENT platform
// using Node's official Single Executable Applications feature. No downloads:
// the running node binary is used as the base, so this works offline and on CI
// runners for Windows / macOS / Linux alike (one artifact per OS).
//
//   node scripts/build-exe.mjs
//   -> dist/workbuddy-skin(.exe)
//
// Pipeline: bundle (esbuild -> single CJS) -> SEA blob -> copy node -> postject.
// Built-in assets (skin.css, renderer-inject.js, themes) are embedded in the
// blob and read back at runtime via node:sea getAsset.
// ============================================================================

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync,
  existsSync, readdirSync, rmSync, chmodSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const ASSETS = join(ROOT, "assets");

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";
const EXE_NAME = IS_WIN ? "workbuddy-skin.exe" : "workbuddy-skin";
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const log = (m) => console.log(`[build] ${m}`);
const run = (args, opts = {}) => execFileSync(process.execPath, args, { stdio: "inherit", ...opts });

async function main() {
  log(`node ${process.version} on ${platform()} -> ${EXE_NAME}`);

  // 1. clean dist
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // 2. build themes-bundle.json (all built-in themes -> { id: themeObject })
  const themes = {};
  const themesDir = join(ASSETS, "themes");
  if (existsSync(themesDir)) {
    for (const f of readdirSync(themesDir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/i, "");
      themes[id] = JSON.parse(readFileSync(join(themesDir, f), "utf8").replace(/^\uFEFF/, ""));
    }
  }
  const legacy = join(ASSETS, "theme.json");
  if (!themes["aurora-glass"] && existsSync(legacy)) {
    themes["aurora-glass"] = JSON.parse(readFileSync(legacy, "utf8").replace(/^\uFEFF/, ""));
  }
  const bundlePath = join(DIST, "themes-bundle.json");
  writeFileSync(bundlePath, JSON.stringify(themes));
  log(`themes-bundle.json: ${Object.keys(themes).join(", ")}`);

  // 3. bundle the CLI into a single CommonJS file (SEA only runs CJS)
  // SEA runs the bundle as CommonJS, where `import.meta.url` is unavailable.
  // Reconstruct it from __filename (the exe path inside a SEA) so createRequire
  // + node:sea getAsset keep working.
  const bundlePathJs = join(DIST, "bundle.cjs");
  await build({
    entryPoints: [join(ROOT, "scripts", "cli.mjs")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: bundlePathJs,
    logLevel: "info",
    define: { "import.meta.url": "__wb_import_meta_url" },
    banner: {
      js: [
        "// WorkBuddy Skin — bundled single-file entry (do not edit)",
        "const __wb_import_meta_url = require('node:url').pathToFileURL(__filename).href;",
      ].join("\n"),
    },
  });
  log("esbuild bundle done");

  // 4. generate the SEA blob (embeds bundle + assets)
  const seaConfig = {
    main: bundlePathJs,
    output: join(DIST, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: {
      "skin.css": join(ASSETS, "skin.css"),
      "renderer-inject.js": join(ASSETS, "renderer-inject.js"),
      "themes-bundle.json": bundlePath,
    },
  };
  const seaConfigPath = join(DIST, "sea-config.json");
  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
  run(["--experimental-sea-config", seaConfigPath]);
  log("SEA blob done");

  // 5. copy the running node binary as our exe base
  const exePath = join(DIST, EXE_NAME);
  copyFileSync(process.execPath, exePath);
  if (!IS_WIN) chmodSync(exePath, 0o755);

  // macOS: signatures must be stripped before postject, re-signed after
  if (IS_MAC) {
    try { execFileSync("codesign", ["--remove-signature", exePath], { stdio: "inherit" }); }
    catch { /* unsigned already */ }
  }

  // 6. inject the blob with postject
  const postject = join(ROOT, "node_modules", "postject", "dist", "cli.js");
  const injectArgs = [
    postject, exePath, "NODE_SEA_BLOB", join(DIST, "sea-prep.blob"),
    "--sentinel-fuse", FUSE,
  ];
  if (IS_MAC) injectArgs.push("--macho-segment-name", "NODE_SEA");
  run(injectArgs);

  // macOS: ad-hoc re-sign so Gatekeeper lets it run
  if (IS_MAC) {
    try { execFileSync("codesign", ["--sign", "-", exePath], { stdio: "inherit" }); }
    catch { /* best effort */ }
  }

  log(`DONE -> ${exePath}`);
}

main().catch((e) => { console.error("[build] FAILED:", e); process.exit(1); });
