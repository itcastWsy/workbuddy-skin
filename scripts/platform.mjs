// ============================================================================
// WorkBuddy Skin — cross-platform helpers (Windows / macOS / Linux)
//
// Replaces the old common.ps1. Pure Node (no external deps). Handles:
//   - state / theme / wallpaper directories (per-OS conventions)
//   - WorkBuddy executable discovery
//   - process listing / stopping
//   - debug-port probing + free-port search
//   - launching WorkBuddy (with or without the loopback debug port)
//
// Only 127.0.0.1 is ever used for CDP. No official files are modified.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execSync } from "node:child_process";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(__dirname, "..");
export const ASSETS = join(ROOT, "assets");
export const INJECTOR = join(__dirname, "injector.mjs");
export const OS = platform(); // 'win32' | 'darwin' | 'linux'
export const IS_WIN = OS === "win32";
export const IS_MAC = OS === "darwin";

// ---- pretty logging --------------------------------------------------------
const C = { cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m", reset: "\x1b[0m" };
const tag = (c, m) => `${c}[wb-skin]${C.reset} ${m}`;
export const info = (m) => console.log(tag(C.cyan, m));
export const ok = (m) => console.log(tag(C.green, m));
export const warn = (m) => console.warn(tag(C.yellow, m));
export const err = (m) => console.error(tag(C.red, m));

// ---- directories (per-OS) --------------------------------------------------
// Keep Windows at %LOCALAPPDATA%\WorkBuddySkin for continuity with the old
// PowerShell version's state/theme store.
export function stateDir() {
  let base;
  if (IS_WIN) base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  else if (IS_MAC) base = join(homedir(), "Library", "Application Support");
  else base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const dir = join(base, "WorkBuddySkin");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
export function themesStoreDir() {
  const d = join(stateDir(), "themes");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
export function wallpapersDir() {
  const d = join(stateDir(), "wallpapers");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
export const bundledThemesDir = join(ASSETS, "themes");

// ---- state (clean UTF-8, no BOM — Node writes it correctly) ----------------
export function readState() {
  const f = join(stateDir(), "state.json");
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8").replace(/^\uFEFF/, "")); }
  catch { return null; }
}
export function saveState(patch) {
  const f = join(stateDir(), "state.json");
  const cur = readState() || {};
  const next = { ...cur, ...patch };
  writeFileSync(f, JSON.stringify(next, null, 2), "utf8");
  return next;
}

// ---- WorkBuddy executable discovery ----------------------------------------
export function findExecutable(override) {
  if (override) {
    if (existsSync(override)) return resolve(override);
    throw new Error(`Provided WorkBuddy path does not exist: ${override}`);
  }
  const home = homedir();
  let candidates = [];
  if (IS_WIN) {
    const LA = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    const PF = process.env["ProgramFiles"] || "C:\\Program Files";
    const PF86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    candidates = [
      join(LA, "Programs", "WorkBuddy", "WorkBuddy.exe"),
      join(PF, "WorkBuddy", "WorkBuddy.exe"),
      join(PF86, "WorkBuddy", "WorkBuddy.exe"),
    ];
  } else if (IS_MAC) {
    candidates = [
      "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy",
      join(home, "Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy"),
    ];
  } else {
    candidates = [
      "/opt/WorkBuddy/workbuddy",
      "/opt/WorkBuddy/WorkBuddy",
      "/usr/lib/workbuddy/workbuddy",
      "/usr/bin/workbuddy",
      "/usr/local/bin/workbuddy",
      join(home, ".local/bin/workbuddy"),
    ];
  }
  for (const c of candidates) if (c && existsSync(c)) return c;

  // Fallbacks: `which`/`where`, then a shallow scan of common install roots.
  const viaWhich = whichWorkBuddy();
  if (viaWhich) return viaWhich;

  const scanRoots = IS_WIN
    ? [join(process.env.LOCALAPPDATA || "", "Programs"), process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]]
    : IS_MAC
      ? ["/Applications", join(home, "Applications")]
      : ["/opt", join(home, ".local"), join(home, "Applications"), join(home, "Downloads")];
  const exeName = IS_WIN ? "workbuddy.exe" : "workbuddy";
  for (const r of scanRoots) {
    if (!r || !existsSync(r)) continue;
    const hit = shallowFind(r, exeName, 3);
    if (hit) return hit;
  }
  throw new Error("Could not locate WorkBuddy. Pass --exe <full path> explicitly.");
}

function whichWorkBuddy() {
  try {
    const cmd = IS_WIN ? "where WorkBuddy" : "which workbuddy";
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\r?\n/)[0];
    if (out && existsSync(out)) return out;
  } catch { /* not on PATH */ }
  return null;
}

function shallowFind(root, targetLower, depth) {
  const stack = [{ dir: root, d: 0 }];
  while (stack.length) {
    const { dir, d } = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isFile()) {
        if (name.toLowerCase() === targetLower) return full;
        // macOS: WorkBuddy.app bundle → binary lives under Contents/MacOS
      } else if (st.isDirectory() && d < depth) {
        stack.push({ dir: full, d: d + 1 });
      }
    }
  }
  return null;
}

// ---- process management ----------------------------------------------------
export function listProcesses() {
  try {
    if (IS_WIN) {
      const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq WorkBuddy.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
      const lines = (out.stdout || "").split(/\r?\n/).filter((l) => /WorkBuddy\.exe/i.test(l));
      return lines.map((l) => {
        const m = l.split('","');
        return { pid: Number((m[1] || "").replace(/\D/g, "")) };
      }).filter((p) => p.pid);
    } else {
      const out = spawnSync("pgrep", ["-x", "WorkBuddy"], { encoding: "utf8" });
      return (out.stdout || "").split(/\s+/).filter(Boolean).map((pid) => ({ pid: Number(pid) }));
    }
  } catch { return []; }
}

export function stopProcesses() {
  const procs = listProcesses();
  if (!procs.length) return;
  info(`Stopping running WorkBuddy (${procs.length} process(es))...`);
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/IM", "WorkBuddy.exe", "/T"], { stdio: "ignore" });
    } else {
      spawnSync("pkill", ["-x", "WorkBuddy"], { stdio: "ignore" });
    }
  } catch { /* ignore */ }
  // give it a moment, then force if needed
  const deadline = Date.now() + 4000;
  while (listProcesses().length && Date.now() < deadline) { sleepSync(200); }
  if (listProcesses().length) {
    try {
      if (IS_WIN) spawnSync("taskkill", ["/IM", "WorkBuddy.exe", "/F", "/T"], { stdio: "ignore" });
      else spawnSync("pkill", ["-9", "-x", "WorkBuddy"], { stdio: "ignore" });
    } catch { /* ignore */ }
    sleepSync(300);
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait, short */ }
}

// ---- port helpers ----------------------------------------------------------
export async function isPortReachable(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

export function isPortFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export async function findFreePort(preferred = 9345, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const p = preferred + i;
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free debugging port near ${preferred}.`);
}

// ---- launch ----------------------------------------------------------------
export function launchDebug(exe, port) {
  info(`Launching WorkBuddy with remote debugging on 127.0.0.1:${port} ...`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ];
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export function launchNormal(exe) {
  info("Launching WorkBuddy normally (no debug port)...");
  const child = spawn(exe, [], { detached: true, stdio: "ignore" });
  child.unref();
}

// ---- spawn injector as the CDP worker (preserves tested behavior) ----------
export function runInjector(argv, { inherit = true } = {}) {
  const r = spawnSync(process.execPath, [INJECTOR, ...argv], {
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return r;
}

export function spawnInjectorDetached(argv) {
  const child = spawn(process.execPath, [INJECTOR, ...argv], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
