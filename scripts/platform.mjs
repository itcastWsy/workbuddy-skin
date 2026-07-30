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

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execSync } from "node:child_process";
import net from "node:net";
import { createRequire } from "node:module";
import { runInjectorMain } from "./injector.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

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
export function portraitsDir() {
  const d = join(stateDir(), "portraits");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
export const bundledThemesDir = join(ASSETS, "themes");

// ---- SEA (single-exe) awareness + built-in theme bundle --------------------
// When packaged as a Node SEA single-file exe, there is no assets/ directory on
// disk: built-in themes are embedded via sea-config.json and read back through
// node:sea getAsset. In dev (plain node) we read the same files from disk. Both
// forms behave identically.
export function isSea() {
  try {
    const sea = _require("node:sea");
    return typeof sea.isSea === "function" && sea.isSea();
  } catch { return false; }
}

// Returns { id: themeObject } for every built-in theme.
export function bundledThemes() {
  const out = {};
  if (isSea()) {
    try {
      const sea = _require("node:sea");
      const bundle = JSON.parse(sea.getAsset("themes-bundle.json", "utf8"));
      for (const [id, obj] of Object.entries(bundle)) out[id] = obj;
    } catch { /* no embedded themes */ }
    return out;
  }
  if (existsSync(bundledThemesDir)) {
    for (const f of readdirSync(bundledThemesDir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/i, "");
      try { out[id] = JSON.parse(readFileSync(join(bundledThemesDir, f), "utf8").replace(/^\uFEFF/, "")); }
      catch { /* skip malformed */ }
    }
  }
  // legacy assets/theme.json as the default aurora-glass when nothing else exists
  if (!out["aurora-glass"]) {
    const legacy = join(ASSETS, "theme.json");
    if (existsSync(legacy)) {
      try { out["aurora-glass"] = JSON.parse(readFileSync(legacy, "utf8").replace(/^\uFEFF/, "")); }
      catch { /* ignore */ }
    }
  }
  return out;
}

// Seed built-in themes into the user store if missing. Idempotent; safe to call
// on every run so the exe works even without an explicit "install" step.
export function ensureSeeded() {
  const store = themesStoreDir();
  let seeded = 0;
  for (const [id, obj] of Object.entries(bundledThemes())) {
    const dest = join(store, `${id}.json`);
    if (!existsSync(dest)) { writeFileSync(dest, JSON.stringify(obj, null, 2), "utf8"); seeded++; }
  }
  return seeded;
}

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

  // Fallbacks: PATH, then a running instance's real path, then a broad scan of
  // every fixed drive's install roots (handles non-C: installs and odd names).
  const viaWhich = whichWorkBuddy();
  if (viaWhich) return viaWhich;

  const running = findRunningWorkBuddy();
  if (running) return running;

  let scanRoots;
  if (IS_WIN) {
    scanRoots = [];
    const la = process.env.LOCALAPPDATA || "";
    if (la) scanRoots.push(join(la, "Programs"));
    for (let code = 67; code <= 90; code++) { // scan C: .. Z:
      const drive = `${String.fromCharCode(code)}:\\`;
      if (!existsSync(drive)) continue;
      scanRoots.push(join(drive, "Program Files"), join(drive, "Program Files (x86)"), join(drive, "WorkBuddy"));
    }
    scanRoots.push(join(home, "Desktop"), join(home, "Downloads"));
  } else if (IS_MAC) {
    scanRoots = ["/Applications", join(home, "Applications"), join(home, "Downloads"), join(home, "Desktop")];
  } else {
    scanRoots = ["/opt", join(home, ".local"), join(home, "Applications"), join(home, "Downloads"), join(home, "Desktop")];
  }
  // Match any executable whose name contains "workbuddy" (but not our own
  // "workbuddy-skin" tool), so a differently-cased/named install still resolves.
  const matches = (nameLower) =>
    nameLower.includes("workbuddy") && !nameLower.includes("skin") &&
    (IS_WIN ? nameLower.endsWith(".exe") : !nameLower.includes("."));
  for (const r of scanRoots) {
    if (!r || !existsSync(r)) continue;
    const hit = scanForWorkBuddy(r, matches, 3);
    if (hit) return hit;
  }
  throw new Error(
    "未找到 WorkBuddy。请确认 WorkBuddy 已安装并（推荐）先把它打开；" +
    "命令行可用 apply --exe \"完整路径\" 指定，双击版请在菜单选「指定 WorkBuddy 位置」。" +
    " (Could not locate WorkBuddy — pass --exe <full path>)"
  );
}

function whichWorkBuddy() {
  try {
    const cmd = IS_WIN ? "where WorkBuddy" : "which workbuddy";
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\r?\n/)[0];
    if (out && existsSync(out)) return out;
  } catch { /* not on PATH */ }
  return null;
}

// Best-effort: if WorkBuddy is already running, read its real executable path.
// This is authoritative and works no matter which drive/folder it lives in.
function findRunningWorkBuddy() {
  try {
    if (IS_WIN) {
      const out = spawnSync("powershell", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath | ConvertTo-Csv -NoTypeInformation"
      ], { encoding: "utf8", windowsHide: true });
      for (const line of (out.stdout || "").split(/\r?\n/)) {
        const m = line.match(/^"([^"]*)","([^"]*)"$/);
        if (!m) continue;
        const name = m[1].toLowerCase(), path = m[2];
        if (name.includes("workbuddy") && !name.includes("skin") && path && existsSync(path)) return path;
      }
    } else {
      const out = spawnSync("ps", ["-Ao", "comm="], { encoding: "utf8" });
      for (const line of (out.stdout || "").split(/\r?\n/)) {
        const p = line.trim();
        if (!p) continue;
        const base = (p.split("/").pop() || "").toLowerCase();
        if (base.includes("workbuddy") && !base.includes("skin") && existsSync(p)) return p;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function scanForWorkBuddy(root, matches, depth) {
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
        if (matches(name.toLowerCase())) return full;
        // macOS: WorkBuddy.app bundle → binary lives under Contents/MacOS
      } else if (st.isDirectory() && d < depth) {
        stack.push({ dir: full, d: d + 1 });
      }
    }
  }
  return null;
}

// ---- process management ----------------------------------------------------
// 新版 WorkBuddy 一个 WorkBuddy.exe 镜像名下同时挂着：GUI 主进程、它派生的
// daemon / sidecar / mcp-app、以及承载 CLI agent 会话的 `--serve` 进程，外加
// --type= 的 Chromium 子进程。换肤只需要重启 *GUI 主进程*，绝不能波及其余的：
// 一个 `taskkill /IM WorkBuddy.exe /T` 会把 daemon/sidecar/CLI-serve 一起带走
// （包括可能正在执行本命令的 agent 自己）。因此下面所有停止逻辑都精确锁定
// GUI 主进程，且从不使用 /T 连带杀子树。

// Windows: 用命令行精确分类。GUI 主进程的命令行去掉 exe 后为空或只剩 `--` flag；
// daemon/sidecar/CLI-serve 在 exe 后跟一个脚本路径；mcp-app 带 --require；
// Chromium 子进程带 --type=。
function winProcesses() {
  if (!IS_WIN) return [];
  try {
    const out = spawnSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"
    ], { encoding: "utf8", windowsHide: true });
    const rows = [];
    for (const line of (out.stdout || "").split(/\r?\n/)) {
      const m = line.match(/^"(\d+)","?(.*?)"?$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!pid) continue;
      const cmd = (m[2] || "").replace(/""/g, '"');
      rows.push({ pid, cmd });
    }
    return rows;
  } catch { return []; }
}

// 判定一条命令行是否属于 GUI 主进程（唯一可安全重启的目标）。
function isGuiMainCmd(cmd) {
  if (!cmd) return false;
  if (/--type=/.test(cmd)) return false;          // Chromium 子进程
  if (/--require\b/.test(cmd)) return false;       // mcp-app
  if (/--serve\b/.test(cmd)) return false;         // CLI agent 会话
  // 去掉开头的 exe（带引号或不带），看剩余是否还有一个非 -- 开头的位置参数
  // （daemon/sidecar/CLI 在 exe 后跟脚本路径），有则不是 GUI 主进程。
  const rest = cmd.replace(/^\s*("[^"]*"|\S+)\s*/, "");
  const positional = rest.split(/\s+/).filter((t) => t && !t.startsWith("--"));
  return positional.length === 0;
}

export function listProcesses() {
  try {
    if (IS_WIN) {
      return winProcesses().map((p) => ({ pid: p.pid }));
    } else {
      const out = spawnSync("pgrep", ["-x", "WorkBuddy"], { encoding: "utf8" });
      return (out.stdout || "").split(/\s+/).filter(Boolean).map((pid) => ({ pid: Number(pid) }));
    }
  } catch { return []; }
}

// 只返回 GUI 主进程 PID。这是唯一允许停止/重启的进程。
export function listMainGuiProcesses() {
  if (IS_WIN) {
    return winProcesses().filter((p) => isGuiMainCmd(p.cmd)).map((p) => ({ pid: p.pid }));
  }
  // mac/linux: `WorkBuddy` 主进程与 Helper 分属不同进程名，pgrep -x 已排除 Helper。
  try {
    const out = spawnSync("pgrep", ["-x", "WorkBuddy"], { encoding: "utf8" });
    return (out.stdout || "").split(/\s+/).filter(Boolean).map((pid) => ({ pid: Number(pid) }));
  } catch { return []; }
}

// 只停止 GUI 主进程，逐个按 PID 结束，绝不使用 /T（否则连带杀 daemon/sidecar/
// CLI-serve 子树，会把正在跑本命令的 agent 一起杀掉）。
export function stopProcesses() {
  const mains = listMainGuiProcesses();
  if (!mains.length) return;
  info(`Stopping WorkBuddy GUI main process only (${mains.length}); daemon/CLI/sidecar left untouched...`);
  for (const { pid } of mains) {
    try {
      if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); // 注意：无 /T
      else process.kill(pid);
    } catch { /* ignore */ }
  }
  const deadline = Date.now() + 4000;
  while (listMainGuiProcesses().length && Date.now() < deadline) { sleepSync(200); }
  if (listMainGuiProcesses().length) {
    for (const { pid } of listMainGuiProcesses()) {
      try {
        if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" }); // 仍无 /T
        else process.kill(pid, "SIGKILL");
      } catch { /* ignore */ }
    }
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
// The two flags that expose a loopback-only CDP endpoint. Shared by launchDebug
// and by the autostart shortcut patcher so both stay in sync.
export function debugArgs(port) {
  return [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ];
}

// ---- CDP 附着：官方内置环境变量（新版首选方式）----------------------------
// 新版 WorkBuddy 主进程内置了开关：设置 WORKBUDDY_REMOTE_DEBUGGING_PORT=<port>
// 后，它会在 app.whenReady() 之前自行 appendSwitch("remote-debugging-port") +
// ("remote-allow-origins", "*")，暴露一个回环 CDP 端点。相比改快捷方式 .lnk，
// 这种方式：跨平台、扛得住 WorkBuddy 自更新覆盖、不受单实例锁影响、无需管理员。
// 唯一代价：设置后需要用户完整退出并重开一次 WorkBuddy 才生效。
export const CDP_ENV_VAR = "WORKBUDDY_REMOTE_DEBUGGING_PORT";

// 读取当前用户级持久化的 CDP 端口环境变量（跨会话）。未设置返回 null。
export function readPersistedCdpPort() {
  if (IS_WIN) {
    try {
      const out = spawnSync("powershell", ["-NoProfile", "-Command",
        `[Environment]::GetEnvironmentVariable('${CDP_ENV_VAR}','User')`
      ], { encoding: "utf8", windowsHide: true });
      const v = (out.stdout || "").trim();
      return /^\d+$/.test(v) ? Number(v) : null;
    } catch { return null; }
  }
  // mac/linux: 读进程可见的环境变量（由 shell rc / launchd plist 提供）
  const v = (process.env[CDP_ENV_VAR] || "").trim();
  return /^\d+$/.test(v) ? Number(v) : null;
}

// 把 CDP 端口写成用户级持久化环境变量。Windows 用 setx（写注册表 HKCU\Environment，
// 无需管理员，新开的进程可见）。mac/linux 无统一持久化机制，返回 shell 片段让用户自行写入。
export function persistCdpPort(port) {
  if (IS_WIN) {
    // setx 有 1024 字符限制且会追加换行到 stdout；这里值很短无碍。
    const r = spawnSync("setx", [CDP_ENV_VAR, String(port)], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`setx 写入失败：${(r.stderr || r.stdout || "").trim()}`);
    // 让本进程后续读取也能立即看到
    process.env[CDP_ENV_VAR] = String(port);
    return { supported: true, persisted: true, port };
  }
  const line = IS_MAC
    ? `launchctl setenv ${CDP_ENV_VAR} ${port}   # 或写入 ~/.zshrc: export ${CDP_ENV_VAR}=${port}`
    : `export ${CDP_ENV_VAR}=${port}   # 写入 ~/.bashrc 或 ~/.profile`;
  return { supported: false, persisted: false, port, hint: line };
}

// 清除持久化的 CDP 端口环境变量（还原用）。
export function clearPersistedCdpPort() {
  if (IS_WIN) {
    // setx 无法删除，只能用 REG delete 移除 HKCU\Environment 下的值。
    const r = spawnSync("reg", ["delete", "HKCU\\Environment", "/F", "/V", CDP_ENV_VAR], { encoding: "utf8", windowsHide: true });
    delete process.env[CDP_ENV_VAR];
    // 值本就不存在时 reg 返回非 0，视为已清除，不报错。
    return { supported: true, cleared: true };
  }
  const line = IS_MAC
    ? `launchctl unsetenv ${CDP_ENV_VAR}   # 并从 ~/.zshrc 移除对应 export`
    : `从 ~/.bashrc / ~/.profile 移除 export ${CDP_ENV_VAR}`;
  return { supported: false, cleared: false, hint: line };
}

// 启动前校验：自动定位（尤其是全盘扫描/Administrator 账户）可能落到一个并不是
// 真正 WorkBuddy.exe、甚至根本不可执行的路径上，直接 spawn 会抛看不懂的 EFTYPE。
// 这里先把明显不合法的路径挡掉，给出一句能照做的中文引导。
function assertLaunchable(exe) {
  const hint = '请用菜单「7) 指定 WorkBuddy 位置」重新指定真正的 WorkBuddy 程序，' +
    '或命令行加 --exe "完整路径"。';
  if (!exe || typeof exe !== "string") {
    throw new Error(`没拿到 WorkBuddy 程序路径。${hint}`);
  }
  if (!existsSync(exe)) {
    throw new Error(`WorkBuddy 程序不存在：${exe}\n${hint}`);
  }
  let st;
  try { st = statSync(exe); } catch { st = null; }
  if (!st || !st.isFile()) {
    throw new Error(`这不是一个可启动的程序文件（可能是文件夹或快捷方式）：${exe}\n${hint}`);
  }
  if (IS_WIN && !/\.exe$/i.test(exe)) {
    throw new Error(`这不是一个 .exe 程序：${exe}\n${hint}`);
  }
}

// 实际 spawn；把同步/异步的启动失败都翻成中文。detached+unref 让 WorkBuddy 脱离
// 本进程独立存活，因此额外挂一个 'error' 监听，避免异步失败变成未捕获异常直接崩溃。
function launchGuarded(exe, extraArgs, extraEnv = null) {
  assertLaunchable(exe);
  const hint = '请用菜单「7) 指定 WorkBuddy 位置」重新指定真正的 WorkBuddy 程序，' +
    '或命令行加 --exe "完整路径"。';
  const explain = (e) => {
    const code = e && e.code ? ` (${e.code})` : "";
    if (e && (e.code === "EFTYPE" || e.code === "ENOEXEC")) {
      return `无法启动 WorkBuddy：这个文件不是有效的可执行程序${code}。\n    ${exe}\n${hint}`;
    }
    if (e && e.code === "EACCES") {
      return `无法启动 WorkBuddy：没有权限运行该程序${code}。\n    ${exe}\n${hint}`;
    }
    if (e && e.code === "ENOENT") {
      return `无法启动 WorkBuddy：程序路径已失效${code}。\n    ${exe}\n${hint}`;
    }
    return `无法启动 WorkBuddy${code}：${e && e.message ? e.message : e}\n${hint}`;
  };
  try {
    const opts = { detached: true, stdio: "ignore" };
    if (extraEnv) opts.env = { ...process.env, ...extraEnv };
    const child = spawn(exe, extraArgs, opts);
    child.on("error", (e) => { err(explain(e)); }); // 异步失败：不让它变成未捕获异常
    child.unref();
  } catch (e) {
    throw new Error(explain(e)); // 同步失败（如 EFTYPE）：抛出中文提示，交给上层菜单展示
  }
}

export function launchDebug(exe, port) {
  info(`Launching WorkBuddy with remote debugging on 127.0.0.1:${port} ...`);
  launchGuarded(exe, debugArgs(port));
}

// 用官方环境变量开端口的方式启动（不依赖命令行 flag，不受单实例锁影响）。
// 用于 apply 需要主动拉起 WorkBuddy 的场景；持久化附着则交给 persistCdpPort。
export function launchDebugViaEnv(exe, port) {
  info(`Launching WorkBuddy with ${CDP_ENV_VAR}=${port} (official env switch) ...`);
  launchGuarded(exe, [], { [CDP_ENV_VAR]: String(port) });
}

export function launchNormal(exe) {
  info("Launching WorkBuddy normally (no debug port)...");
  launchGuarded(exe, []);
}

// ---- run the CDP injector --------------------------------------------------
// In-process: the injector logic runs inside this same process (no child node,
// no separate .mjs file — required once packaged as a single-file exe). Returns
// { status } to match the previous spawnSync-based contract.
export async function runInjector(argv) {
  const r = await runInjectorMain(argv);
  return { status: r && typeof r.status === "number" ? r.status : 0 };
}

// The watch daemon must outlive this command, so it needs its own long-lived
// process. We re-exec ourselves with a hidden "__inject" first arg that routes
// straight to the injector. SEA: exec the exe directly; dev: exec node + entry.
export function spawnInjectorDetached(argv) {
  const full = isSea()
    ? ["__inject", ...argv]
    : [process.argv[1], "__inject", ...argv];
  const child = spawn(process.execPath, full, { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

// ---- autostart: patch WorkBuddy shortcuts to self-expose the debug port ----
// Windows only for now. Scans Desktop / Start Menu / pinned-taskbar shortcuts,
// and for any .lnk whose target is the WorkBuddy exe, appends (or, with undo,
// strips) the loopback debug flags in its Arguments. Idempotent; user-scope
// shortcuts patch without admin, machine-scope ones may report "error".
export function patchAutostart({ exe, port, undo = false }) {
  if (!IS_WIN) {
    return { supported: false, os: OS, port, flag: debugArgs(port).join(" ") };
  }
  const ps = [
    "param([string]$Exe,[int]$Port,[switch]$Undo)",
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$flag = '--remote-debugging-port=' + $Port",
    "$origin = '--remote-allow-origins=http://127.0.0.1:' + $Port",
    "$debug = $flag + ' ' + $origin",
    "$dirs = @(",
    "  [Environment]::GetFolderPath('Desktop'),",
    "  [Environment]::GetFolderPath('CommonDesktopDirectory'),",
    "  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),",
    "  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'),",
    "  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')",
    ") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique",
    "$sh = New-Object -ComObject WScript.Shell",
    "foreach ($dir in $dirs) {",
    "  $files = Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue",
    "  foreach ($f in $files) {",
    "    $lnk = $sh.CreateShortcut($f.FullName)",
    "    $tp = [string]$lnk.TargetPath",
    "    if (-not $tp) { continue }",
    "    if ($tp.ToLower() -ne $Exe.ToLower()) { continue }",
    "    $cur = [string]$lnk.Arguments",
    "    $new = $cur",
    "    $status = 'skipped'",
    "    if ($Undo) {",
    "      $new = [regex]::Replace($new, '--remote-allow-origins=http://127\\.0\\.0\\.1:\\d+', '')",
    "      $new = [regex]::Replace($new, '--remote-debugging-port=\\d+', '')",
    "      $new = ([regex]::Replace($new, '\\s+', ' ')).Trim()",
    "      if ($new -ne $cur) {",
    "        $lnk.Arguments = $new",
    "        try { $lnk.Save(); $status = 'unpatched' } catch { $status = 'error' }",
    "      }",
    "    } else {",
    "      if ($cur -notmatch '--remote-debugging-port') {",
    "        $new = ($cur + ' ' + $debug).Trim()",
    "        $lnk.Arguments = $new",
    "        try { $lnk.Save(); $status = 'patched' } catch { $status = 'error' }",
    "      }",
    "    }",
    "    $o = [pscustomobject]@{ path = $f.FullName; status = $status; args = ([string]$lnk.Arguments) }",
    "    Write-Output ($o | ConvertTo-Json -Compress)",
    "  }",
    "}",
  ].join("\n");

  const tmp = join(stateDir(), "wb-autostart.ps1");
  writeFileSync(tmp, ps, "utf8");
  try {
    const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp, "-Exe", exe, "-Port", String(port)];
    if (undo) psArgs.push("-Undo");
    const r = spawnSync("powershell", psArgs, { encoding: "utf8" });
    const items = [];
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try { items.push(JSON.parse(s)); } catch { /* ignore non-JSON noise */ }
    }
    return { supported: true, port, items, stderr: (r.stderr || "").trim() };
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
