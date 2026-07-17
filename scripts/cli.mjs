// ============================================================================
// WorkBuddy Skin — cross-platform CLI (Windows / macOS / Linux)
//
// Replaces install-skin.ps1 / start-skin.ps1 / restore-skin.ps1. One entry,
// one codebase, no PowerShell. Uses injector.mjs as the CDP worker.
//
// Commands:
//   install                    validate + locate WorkBuddy + seed themes
//   apply    [opts]            launch (if needed) + inject skin
//   restore  [--keep-open]     remove skin + relaunch WorkBuddy clean
//            [--uninstall]     also delete local store
//   theme    list              list bundled + user themes
//   theme    use <id|path>     switch active theme (re-injects if live)
//   bg       set <image>       use a local image as wallpaper (persists)
//   bg       clear             back to the theme's gradient
//   status                     show current state + whether skin is live
//   help                       this help
//
// apply options: --theme <id|path> --bg <image> --port <n> --exe <path>
//                --restart  --watch  --no-launch
// ============================================================================

import { existsSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import * as P from "./platform.mjs";

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[key] = true;
      else { a[key] = next; i++; }
    } else a._.push(t);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const CMD = (args._[0] || "help").toLowerCase();
const SUB = args._[1];

// ---- theme resolution ------------------------------------------------------
function resolveThemePath(themeArg, state) {
  if (themeArg && themeArg !== true) {
    const t = String(themeArg);
    // explicit path?
    if (t.includes("/") || t.includes("\\") || t.endsWith(".json")) {
      if (!existsSync(t)) throw new Error(`Theme file not found: ${t}`);
      return resolve(t);
    }
    // treat as id: user store first, then bundled
    const userT = join(P.themesStoreDir(), `${t}.json`);
    if (existsSync(userT)) return userT;
    const bundledT = join(P.bundledThemesDir, `${t}.json`);
    if (existsSync(bundledT)) return bundledT;
    throw new Error(`Unknown theme id: ${t} (try "theme list")`);
  }
  if (state && state.activeTheme) {
    const p = join(P.themesStoreDir(), `${state.activeTheme}.json`);
    if (existsSync(p)) return p;
    const b = join(P.bundledThemesDir, `${state.activeTheme}.json`);
    if (existsSync(b)) return b;
  }
  const def = join(P.ASSETS, "theme.json");
  if (existsSync(def)) return def;
  return join(P.bundledThemesDir, "aurora-glass.json");
}

function themeIdOf(themePath) {
  try {
    const obj = JSON.parse(readFileSync(themePath, "utf8").replace(/^\uFEFF/, ""));
    return obj.id || basename(themePath).replace(/\.json$/i, "");
  } catch { return basename(themePath).replace(/\.json$/i, ""); }
}

function fileUrlOf(absPath) {
  const norm = absPath.replace(/\\/g, "/");
  return P.IS_WIN ? `file:///${norm}` : `file://${norm}`;
}

// Bake a wallpaper into a runtime theme (gradient scrim + url). injector.mjs
// inlines the file:// url to a data URI to bypass the renderer CSP.
function bakeWallpaper(themePath, imgAbs) {
  const obj = JSON.parse(readFileSync(themePath, "utf8").replace(/^\uFEFF/, ""));
  if (!obj.background) obj.background = {};
  const url = fileUrlOf(imgAbs);
  // Dark: top bright (sky), bottom slightly darker for input-bar readability.
  obj.background.dark = `linear-gradient(180deg, rgba(8,10,22,0.10) 0%, rgba(8,10,22,0.22) 55%, rgba(8,10,22,0.46) 100%), url('${url}')`;
  obj.background.light = `linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.16) 100%), url('${url}')`;
  const runtime = join(P.stateDir(), "_active-runtime.json");
  writeFileSync(runtime, JSON.stringify(obj, null, 2), "utf8");
  return runtime;
}

// Copy a user image into the persistent wallpapers store; return stored path.
function persistWallpaper(imgPath) {
  if (!existsSync(imgPath)) throw new Error(`Background image not found: ${imgPath}`);
  const abs = resolve(imgPath);
  const dest = join(P.wallpapersDir(), basename(abs));
  if (resolve(dest) !== abs) copyFileSync(abs, dest);
  return dest;
}

// ---- commands --------------------------------------------------------------
function cmdInstall() {
  P.info("Installing WorkBuddy Skin ...");
  P.ok(`Node: ${process.version} (${process.platform})`);
  const exe = P.findExecutable(args.exe && args.exe !== true ? String(args.exe) : undefined);
  P.ok(`WorkBuddy found: ${exe}`);
  // seed bundled themes into the user store
  let seeded = 0;
  if (existsSync(P.bundledThemesDir)) {
    for (const f of readdirSync(P.bundledThemesDir)) {
      if (f.endsWith(".json")) { copyFileSync(join(P.bundledThemesDir, f), join(P.themesStoreDir(), f)); seeded++; }
    }
  }
  // also seed the legacy assets/theme.json as aurora-glass if no bundled themes
  const legacy = join(P.ASSETS, "theme.json");
  if (seeded === 0 && existsSync(legacy)) {
    copyFileSync(legacy, join(P.themesStoreDir(), "aurora-glass.json")); seeded = 1;
  }
  P.saveState({ exe, activeTheme: "aurora-glass", installedAt: new Date().toISOString(), projectRoot: P.ROOT });
  P.ok(`Install complete. Seeded ${seeded} theme(s) into ${P.themesStoreDir()}`);
  console.log("");
  console.log("Next:");
  console.log("  Apply     : workbuddy-skin apply");
  console.log("  Wallpaper : workbuddy-skin bg set <image>");
  console.log("  Switch    : workbuddy-skin theme use midnight");
  console.log("  Restore   : workbuddy-skin restore");
}

async function cmdApply() {
  const state = P.readState();
  const noLaunch = !!args["no-launch"];

  // resolve exe
  let exe = null;
  if (!noLaunch) {
    if (args.exe && args.exe !== true) exe = P.findExecutable(String(args.exe));
    else if (state && state.exe && existsSync(state.exe)) exe = state.exe;
    else exe = P.findExecutable();
  }

  // resolve theme
  let themePath = resolveThemePath(args.theme, state);
  P.info(`Theme: ${themePath}`);

  // wallpaper: explicit --bg, else reuse persisted one
  let bgStored = null;
  let bgArg = args.bg && args.bg !== true ? String(args.bg) : null;
  if (!bgArg && state && state.background && existsSync(state.background)) {
    bgStored = state.background;
    P.info(`Reusing saved wallpaper: ${bgStored}`);
  } else if (bgArg) {
    bgStored = persistWallpaper(bgArg);
    P.ok(`Wallpaper stored -> ${bgStored}`);
  }
  if (bgStored) { themePath = bakeWallpaper(themePath, bgStored); }

  // resolve port + detect existing debug session
  let port = Number(args.port || 0);
  if (port <= 0) {
    if (state && state.port && await P.isPortReachable(Number(state.port))) port = Number(state.port);
    else port = await P.findFreePort(9345);
  }
  const debugLive = await P.isPortReachable(port);
  const running = P.listProcesses();

  if (!noLaunch) {
    if (debugLive) {
      P.info(`Existing debug session on port ${port}; re-injecting without restart.`);
    } else if (running.length) {
      if (!args.restart) {
        P.warn("WorkBuddy is running WITHOUT a debug port; it must restart to apply the skin.");
        P.warn("Re-run with --restart to restart automatically.");
        process.exit(3);
      }
      P.stopProcesses();
      if (!(await P.isPortFree(port))) port = await P.findFreePort(port);
      P.launchDebug(exe, port);
    } else {
      if (!(await P.isPortFree(port))) port = await P.findFreePort(port);
      P.launchDebug(exe, port);
    }
  }

  // inject
  P.info(`Injecting skin via CDP on port ${port} ...`);
  const r = P.runInjector(["apply", "--port", String(port), "--theme", themePath]);
  if (r.status !== 0) { P.err(`Injection failed (exit ${r.status}).`); process.exit(r.status || 1); }

  // optional watch daemon
  let watchPid = null;
  if (args.watch) {
    P.info("Starting watch daemon (re-injects after reload/navigation) ...");
    watchPid = P.spawnInjectorDetached(["watch", "--port", String(port), "--theme", themePath]);
    P.ok(`Watch daemon PID: ${watchPid}`);
  }

  // persist state
  P.saveState({
    exe: exe || (state && state.exe) || null,
    port,
    activeTheme: themeIdOf(themePath === join(P.stateDir(), "_active-runtime.json") ? resolveThemePath(args.theme, state) : themePath),
    background: bgStored || (state && state.background) || null,
    watchPid,
    appliedAt: new Date().toISOString(),
    projectRoot: P.ROOT,
  });

  await P.sleep(800);
  const v = P.runInjector(["verify", "--port", String(port)]);
  if (v.status === 0) P.ok("Skin applied. Enjoy your WorkBuddy.");
  else P.warn("Verify did not confirm yet; it may still be loading. Re-run apply if needed.");
}

async function cmdRestore() {
  const state = P.readState();
  // stop watch daemon
  if (state && state.watchPid) {
    try { process.kill(Number(state.watchPid)); P.info(`Stopped watch daemon PID ${state.watchPid}.`); } catch { /* gone */ }
  }
  // best-effort live cleanup
  let port = Number(args.port || 0);
  if (port <= 0 && state && state.port) port = Number(state.port);
  if (port > 0) {
    try { P.runInjector(["remove", "--port", String(port)]); } catch { /* ignore */ }
  }
  // resolve exe then relaunch clean
  let exe = null;
  if (state && state.exe && existsSync(state.exe)) exe = state.exe;
  else { try { exe = P.findExecutable(); } catch { P.warn("WorkBuddy exe not found; will not relaunch."); } }

  P.stopProcesses();
  if (!args["keep-open"] && exe) { await P.sleep(500); P.launchNormal(exe); }

  if (args.uninstall) {
    const dir = P.stateDir();
    try {
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
      P.ok(`Removed local store: ${dir}`);
    } catch (e) { P.warn(`Could not remove store: ${e.message}`); }
  } else if (state) {
    P.saveState({ port: 0, watchPid: null, restoredAt: new Date().toISOString() });
  }
  P.ok("Restore complete. WorkBuddy is back to its official appearance.");
}

function listThemes() {
  const seen = new Map();
  for (const dir of [P.bundledThemesDir, P.themesStoreDir()]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/i, "");
      let name = id;
      try { name = (JSON.parse(readFileSync(join(dir, f), "utf8").replace(/^\uFEFF/, "")).name) || id; } catch { /* keep id */ }
      seen.set(id, name);
    }
  }
  return [...seen.entries()];
}

function cmdTheme() {
  const action = (SUB || "list").toLowerCase();
  if (action === "list") {
    const state = P.readState();
    const active = state && state.activeTheme;
    P.info("Available themes:");
    for (const [id, name] of listThemes()) {
      const mark = id === active ? " *" : "  ";
      console.log(`${mark} ${id.padEnd(16)} ${name}`);
    }
    console.log("");
    console.log('Switch with: workbuddy-skin theme use <id>');
    return;
  }
  if (action === "use") {
    const id = args._[2];
    if (!id) throw new Error('Usage: theme use <id|path>');
    // validate resolvable, then delegate to apply so it re-injects if live
    resolveThemePath(id, P.readState());
    args.theme = id;
    return cmdApply();
  }
  throw new Error(`Unknown theme action: ${action}`);
}

function cmdBg() {
  const action = (SUB || "").toLowerCase();
  if (action === "set") {
    const img = args._[2];
    if (!img) throw new Error("Usage: bg set <image>");
    args.bg = img;
    return cmdApply();
  }
  if (action === "clear") {
    P.saveState({ background: null });
    P.ok("Wallpaper cleared. Re-applying with the theme gradient ...");
    return cmdApply();
  }
  throw new Error('Usage: bg set <image> | bg clear');
}

async function cmdStatus() {
  const state = P.readState();
  console.log("WorkBuddy Skin — status");
  console.log(`  OS         : ${process.platform}`);
  console.log(`  State dir  : ${P.stateDir()}`);
  if (!state) { console.log("  (not installed yet — run: workbuddy-skin install)"); return; }
  console.log(`  Executable : ${state.exe || "(unknown)"}`);
  console.log(`  Theme      : ${state.activeTheme || "(default)"}`);
  console.log(`  Wallpaper  : ${state.background || "(gradient)"}`);
  console.log(`  Port       : ${state.port || "(none)"}`);
  if (state.port) {
    const live = await P.isPortReachable(Number(state.port));
    console.log(`  Debug live : ${live ? "yes" : "no"}`);
    if (live) P.runInjector(["verify", "--port", String(state.port)]);
  }
}

function cmdHelp() {
  console.log(`WorkBuddy Skin — background + glass skin via loopback CDP (no official files changed)

Usage: workbuddy-skin <command> [options]

Commands:
  install                      validate Node/WorkBuddy, seed themes
  apply                        launch (if needed) + inject the skin
  restore [--keep-open]        remove skin + relaunch clean
          [--uninstall]        also delete the local store
  theme list                   list available themes
  theme use <id|path>          switch active theme (re-injects if live)
  bg set <image>               use a local image as wallpaper (persists)
  bg clear                     back to the theme's gradient
  status                       show current state
  help                         this message

apply options:
  --theme <id|path>            theme to use
  --bg <image>                 wallpaper image (also persisted)
  --port <n>                   debug port (default: auto from 9345)
  --exe <path>                 explicit WorkBuddy path
  --restart                    restart a running WorkBuddy without prompting
  --watch                      keep a daemon that re-injects after reload
  --no-launch                  only inject into an existing debug session

Examples:
  workbuddy-skin apply --bg ~/Pictures/beach.jpg --watch
  workbuddy-skin theme use midnight
  workbuddy-skin restore`);
}

// ---- dispatch --------------------------------------------------------------
(async () => {
  try {
    switch (CMD) {
      case "install": cmdInstall(); break;
      case "apply": case "start": await cmdApply(); break;
      case "restore": await cmdRestore(); break;
      case "theme": await cmdTheme(); break;
      case "bg": case "background": await cmdBg(); break;
      case "status": await cmdStatus(); break;
      case "help": case "--help": case "-h": cmdHelp(); break;
      default: P.err(`Unknown command: ${CMD}`); cmdHelp(); process.exit(2);
    }
  } catch (e) {
    P.err(e.message);
    process.exit(1);
  }
  // fetch() keep-alive sockets to the debug endpoint can hold the event loop
  // open; exit explicitly once the command has completed (watch runs detached).
  process.exit(0);
})();
