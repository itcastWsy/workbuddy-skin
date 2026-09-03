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
import { createInterface } from "node:readline";
import * as P from "./platform.mjs";
import { processIntoStore, dominantAccent } from "./image.mjs";

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
// A packaged SEA exe sets process.argv to [exe, exe, ...userArgs], so user args
// start at index 2 exactly like `node bin/...`. One slice covers both.
const CLI_ARGV = process.argv.slice(2);
const args = parseArgs(CLI_ARGV);
const CMD = (args._[0] || (args.version ? "version" : "help")).toLowerCase();
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
  // 默认主题：优先用已 seed 到用户库的文件——这是打包 exe 里唯一真实存在的地方
  // （SEA exe 没有磁盘上的 assets/ 目录，直接返回 bundledThemesDir 路径会 ENOENT）。
  const storeDefault = join(P.themesStoreDir(), "aurora-glass.json");
  if (existsSync(storeDefault)) return storeDefault;
  try { P.ensureSeeded(); } catch { /* ignore */ }
  if (existsSync(storeDefault)) return storeDefault;
  // dev 回退：直接读仓库里的 assets/
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

// Bake wallpaper + portrait overrides into a runtime theme written to the state
// dir. injector.mjs inlines the file:// urls to data URIs to bypass the CSP.
function bakeRuntime(themePath, { bgAbs, portraitAbs, accent } = {}) {
  const obj = JSON.parse(readFileSync(themePath, "utf8").replace(/^\uFEFF/, ""));
  if (bgAbs) {
    if (!obj.background) obj.background = {};
    const url = fileUrlOf(bgAbs);
    // Dark: top bright (sky), bottom slightly darker for input-bar readability.
    obj.background.dark = `linear-gradient(180deg, rgba(8,10,22,0.10) 0%, rgba(8,10,22,0.22) 55%, rgba(8,10,22,0.46) 100%), url('${url}')`;
    // Light: subtle warm-ivory wash mirroring the dark overlay strength (0.10/0.22/0.46),
    // just enough to take the edge off — wallpaper colors must stay clearly visible.
    // Readability is carried by glass cards, not by a full-page veil.
    obj.background.light = `linear-gradient(180deg, rgba(255,248,240,0.04) 0%, rgba(255,246,235,0.10) 55%, rgba(255,238,220,0.20) 100%), url('${url}')`;
  }
  // 由壁纸自动取到的强调色（染玻璃描边/悬停/滚动条）；无则不写，注入器回退默认描边。
  if (accent) obj.accent = accent;
  if (portraitAbs) {
    const slot = Array.isArray(obj.decorations)
      ? obj.decorations.find((d) => d && d.role === "portrait")
      : null;
    if (slot) slot.src = fileUrlOf(portraitAbs);
    else P.warn('This theme has no "portrait" decoration slot; --portrait ignored.');
  }
  const runtime = join(P.stateDir(), "_active-runtime.json");
  writeFileSync(runtime, JSON.stringify(obj, null, 2), "utf8");
  return runtime;
}

function themeHasPortraitSlot(themePath) {
  try {
    const o = JSON.parse(readFileSync(themePath, "utf8").replace(/^\uFEFF/, ""));
    return Array.isArray(o.decorations) && o.decorations.some((d) => d && d.role === "portrait");
  } catch { return false; }
}

// Copy a user image into the persistent wallpapers store; large images are
// auto-compressed (see image.mjs) so the inlined data URI stays under the CSS
// size limit. Returns the stored path.
async function persistWallpaper(imgPath) {
  if (!existsSync(imgPath)) throw new Error(`Background image not found: ${imgPath}`);
  const abs = resolve(imgPath);
  const { dest, resized, bytes, undisplayable } = await processIntoStore(abs, P.wallpapersDir(), { kind: "wallpaper" });
  if (resized) P.ok(`Wallpaper auto-compressed -> ${(bytes / 1024).toFixed(0)} KB`);
  if (undisplayable) P.warn("这张壁纸格式无法压缩、体积偏大，很可能不会显示（详见上面的提示）。建议转成 JPG/PNG 后重试。");
  // 从入库后的壁纸提取强调色（自动主题色）。灰阶/失败返回 null，回退默认描边。
  const accent = await dominantAccent(dest);
  if (accent) P.ok(`Accent color from wallpaper -> ${accent}`);
  return { dest, accent };
}

// Copy a user portrait image into the persistent portraits store; large images
// are auto-compressed (PNG, alpha preserved). Returns the stored path.
async function persistPortrait(imgPath) {
  if (!existsSync(imgPath)) throw new Error(`Portrait image not found: ${imgPath}`);
  const abs = resolve(imgPath);
  const { dest, resized, bytes } = await processIntoStore(abs, P.portraitsDir(), { kind: "portrait" });
  if (resized) P.ok(`Portrait auto-compressed -> ${(bytes / 1024).toFixed(0)} KB`);
  return dest;
}

// ---- commands --------------------------------------------------------------
function cmdInstall() {
  P.info("Installing WorkBuddy Skin ...");
  P.ok(`Node: ${process.version} (${process.platform})`);
  const exe = P.findExecutable(args.exe && args.exe !== true ? String(args.exe) : undefined);
  P.ok(`WorkBuddy found: ${exe}`);
  // seed built-in themes into the user store (works from disk in dev and from
  // the embedded bundle in the packaged exe)
  const seeded = P.ensureSeeded();
  P.saveState({ exe, activeTheme: "aurora-glass", installedAt: new Date().toISOString(), projectRoot: P.ROOT });
  P.ok(`Install complete. Seeded ${seeded} theme(s) into ${P.themesStoreDir()}`);
  console.log("");
  console.log("Next:");
  console.log("  Apply     : workbuddy-skin apply");
  console.log("  Wallpaper : workbuddy-skin bg set <image>");
  console.log("  Switch    : workbuddy-skin theme use midnight");
  console.log("  Restore   : workbuddy-skin restore");
}

// Set while the interactive menu is active (see interactiveMenu). Lets apply-time
// prompts (e.g. "restart WorkBuddy?") run in-menu instead of exiting the process.
let MENU_RL = null;

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
  let bgAccent = null;
  let bgArg = args.bg && args.bg !== true ? String(args.bg) : null;
  if (!bgArg && state && state.background && existsSync(state.background)) {
    bgStored = state.background;
    bgAccent = state.accent || null;
    P.info(`Reusing saved wallpaper: ${bgStored}`);
  } else if (bgArg) {
    const w = await persistWallpaper(bgArg);
    bgStored = w.dest;
    bgAccent = w.accent;
    P.ok(`Wallpaper stored -> ${bgStored}`);
  }

  // portrait: explicit --portrait, else reuse persisted one (only if theme has a slot)
  let portraitStored = null;
  let portraitArg = args.portrait && args.portrait !== true ? String(args.portrait) : null;
  if (portraitArg) {
    portraitStored = await persistPortrait(portraitArg);
    P.ok(`Portrait stored -> ${portraitStored}`);
  } else if (state && state.portrait && existsSync(state.portrait) && themeHasPortraitSlot(themePath)) {
    portraitStored = state.portrait;
    P.info(`Reusing saved portrait: ${portraitStored}`);
  }

  if (bgStored || portraitStored) {
    themePath = bakeRuntime(themePath, { bgAbs: bgStored, portraitAbs: portraitStored, accent: bgAccent });
  }

  // resolve port + detect existing debug session
  // 优先级：显式 --port > 持久化环境变量端口 > state 记录的活端口 > 自动从 9345 找空。
  let port = Number(args.port || 0);
  if (port <= 0) {
    const envPort = P.readPersistedCdpPort();
    if (envPort && await P.isPortReachable(envPort)) port = envPort;
    else if (envPort) port = envPort;
    else if (state && state.port && await P.isPortReachable(Number(state.port))) port = Number(state.port);
    else port = await P.findFreePort(9345);
  }
  const debugLive = await P.isPortReachable(port);
  const running = P.listProcesses();
  const envAttached = P.readPersistedCdpPort() === port;

  if (!noLaunch) {
    if (debugLive) {
      P.info(`Existing debug session on port ${port}; re-injecting without restart.`);
    } else if (running.length) {
      // WorkBuddy 正在跑但端口没开。首选：持久化官方环境变量，只重启 GUI 主进程
      // （不波及 daemon/sidecar/CLI agent）。这一步自动修好了旧版的自毁行为。
      let doRestart = !!args.restart;
      if (!doRestart && MENU_RL) {
        const ans = (await ask(MENU_RL, "\n检测到 WorkBuddy 正在运行，但没有开启调试端口。现在重启主窗口并应用吗？（仅重启界面，不影响后台任务）(y/n)：")).toLowerCase();
        doRestart = ans === "y" || ans === "yes" || ans === "是";
      }
      if (!doRestart) {
        if (MENU_RL) {
          P.warn("已取消：WorkBuddy 未重启，皮肤未应用。");
          P.info("推荐先用菜单「6) 开启持久换肤」写入环境变量，之后重开 WorkBuddy 就会自带调试端口，无需每次重启。");
          return;
        }
        P.warn("WorkBuddy is running WITHOUT a debug port; the GUI window must restart to apply the skin.");
        P.info(`推荐：先跑 "workbuddy-skin enable-cdp" 写入环境变量，重开 WorkBuddy 后换肤就会热生效、不需重启。`);
        P.warn("或重新运行并加 --restart 自动重启 GUI 主窗口（不会影响后台 daemon/CLI）。");
        process.exit(3);
      }
      P.stopProcesses();
      if (!(await P.isPortFree(port))) port = await P.findFreePort(port);
      // 用官方环境变量方式拉起（不受单实例锁影响）；若已持久化相同端口则普通启动即可。
      if (envAttached) P.launchNormal(exe); else P.launchDebugViaEnv(exe, port);
    } else {
      if (!(await P.isPortFree(port))) port = await P.findFreePort(port);
      if (envAttached) P.launchNormal(exe); else P.launchDebugViaEnv(exe, port);
    }
  }

  // inject
  P.info(`Injecting skin via CDP on port ${port} ...`);
  const r = await P.runInjector(["apply", "--port", String(port), "--theme", themePath]);
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
    accent: bgAccent || (state && state.accent) || null,
    portrait: portraitStored || (state && state.portrait) || null,
    watchPid,
    appliedAt: new Date().toISOString(),
    projectRoot: P.ROOT,
  });

  await P.sleep(800);
  const v = await P.runInjector(["verify", "--port", String(port)]);
  if (v.status === 0) P.ok("Skin applied. Enjoy your WorkBuddy.");
  else P.warn("Verify did not confirm yet; it may still be loading. Re-run apply if needed.");

  // 换肤是运行时注入、不落地：WorkBuddy 重启/自更新后会消失。给双击版用户一句持久化提示。
  if (MENU_RL && v.status === 0) {
    const st = P.readState();
    if (!(st && st.autostart)) {
      if (P.IS_WIN) P.info("提示：WorkBuddy 重启或自动更新后皮肤会消失。想每次自动生效，请在菜单选「6) 开启持久换肤」。");
      else P.info("提示：WorkBuddy 重启或自动更新后皮肤会消失，重新打开后再运行一次「应用皮肤」即可。");
    }
  }
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
    try { await P.runInjector(["remove", "--port", String(port)]); } catch { /* ignore */ }
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
  // built-in themes (embedded in the exe, or from assets/ in dev)
  for (const [id, obj] of Object.entries(P.bundledThemes())) {
    seen.set(id, (obj && obj.name) || id);
  }
  // user store overrides / additions
  const store = P.themesStoreDir();
  if (existsSync(store)) {
    for (const f of readdirSync(store)) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/i, "");
      let name = id;
      try { name = (JSON.parse(readFileSync(join(store, f), "utf8").replace(/^\uFEFF/, "")).name) || id; } catch { /* keep id */ }
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
    P.saveState({ background: null, accent: null });
    P.ok("Wallpaper cleared. Re-applying with the theme gradient ...");
    return cmdApply();
  }
  throw new Error('Usage: bg set <image> | bg clear');
}

function cmdPortrait() {
  const action = (SUB || "").toLowerCase();
  if (action === "set") {
    const img = args._[2];
    if (!img) throw new Error("Usage: portrait set <image>");
    args.portrait = img;
    return cmdApply();
  }
  if (action === "clear") {
    P.saveState({ portrait: null });
    P.ok("Portrait cleared. Re-applying ...");
    return cmdApply();
  }
  throw new Error('Usage: portrait set <image> | portrait clear');
}

// ---- dom / inspect: 内置 DevTools 替代——自助勘察当前 WorkBuddy 的 DOM --------
// 新版关了开发者工具，用本命令隔着 CDP 看选择器是否还在、发现新壳层。
//   workbuddy-skin dom                 # 选择器普查 + 发现哈希类前缀 + 容器树
//   workbuddy-skin dom --selector ".chat-container"   # 只看指定选择器
async function cmdDom() {
  const state = P.readState();
  let port = Number(args.port || 0);
  if (port <= 0) {
    port = P.readPersistedCdpPort() || Number(state && state.port) || 0;
  }
  if (port <= 0) { P.err("未知调试端口。先跑 apply / enable-cdp，或用 --port <n> 指定。"); process.exit(1); }
  if (!(await P.isPortReachable(port))) {
    P.err(`端口 ${port} 没有监听——WorkBuddy 未开调试端口。先跑 "workbuddy-skin enable-cdp" 并重开 WorkBuddy。`);
    process.exit(3);
  }
  const injArgs = ["dom", "--port", String(port)];
  if (args.selector && args.selector !== true) injArgs.push("--selector", String(args.selector));
  await P.runInjector(injArgs);
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
  console.log(`  Accent     : ${state.accent || "(theme default)"}`);
  console.log(`  Portrait   : ${state.portrait || "(none)"}`);
  console.log(`  Autostart  : ${state.autostart ? `on (port ${state.autostartPort || state.port || 9345})` : "off"}`);
  console.log(`  Port       : ${state.port || "(none)"}`);
  if (state.port) {
    const live = await P.isPortReachable(Number(state.port));
    console.log(`  Debug live : ${live ? "yes" : "no"}`);
    if (live) await P.runInjector(["verify", "--port", String(state.port)]);
  }
}

// ---- enable-cdp: 持久化官方调试端口环境变量（新版首选附着方式）-------
// setx WORKBUDDY_REMOTE_DEBUGGING_PORT=<port>。一次写入永久生效：之后任何方式
// （开始菜单/托盘/快捷方式）启动的 WorkBuddy 都会自带回环调试端口，换肤热注入
// 无需重启；不改官方文件、不改快捷方式、不受自更新影响。
async function cmdEnableCdp() {
  const undo = args.undo === true || (SUB && ["undo", "off", "disable"].includes(String(SUB).toLowerCase()));
  const state = P.readState();

  if (undo) {
    const res = P.clearPersistedCdpPort();
    P.saveState({ autostart: false });
    if (res.supported) {
      P.ok(`已关闭持久换肤：移除环境变量 ${P.CDP_ENV_VAR}。`);
      P.info("已打开的 WorkBuddy 仍保留当前端口；下次完全重开后不再自带调试端口。");
    } else {
      P.warn(`当前系统需手动移除：`);
      console.log(`    ${res.hint}`);
    }
    return;
  }

  let port = Number(args.port || (state && state.port) || 0);
  if (port <= 0) port = P.readPersistedCdpPort() || 9345;

  let res;
  try { res = P.persistCdpPort(port); }
  catch (e) { P.err(`写入环境变量失败：${e.message}`); process.exit(1); }

  if (res.supported) {
    P.saveState({ autostart: true, autostartPort: port, port });
    P.ok(`已开启持久换肤：${P.CDP_ENV_VAR}=${port}（已写入用户环境变量）。`);
    const live = await P.isPortReachable(port);
    if (live) {
      P.info(`端口 ${port} 已在监听——当前 WorkBuddy 已可直接换肤：跑 "workbuddy-skin apply"。`);
    } else {
      P.info("注意：环境变量对“新启动”的进程才生效。请完整退出并重开一次 WorkBuddy（托盘右键退出），之后换肤就会热生效。");
      P.info(`重开后跑：workbuddy-skin apply`);
    }
  } else {
    P.warn(`当前系统（${process.platform}）需手动写入以下环境变量，然后重开 WorkBuddy：`);
    console.log(`    ${res.hint}`);
  }
}

// ---- autostart: 兼容旧版“打补丁到快捷方式”的自启方式（Windows only）--------
async function cmdAutostart() {
  const undo = args.undo === true || (SUB && ["undo", "off"].includes(String(SUB).toLowerCase()));
  const state = P.readState();
  let exe;
  try { exe = P.findExecutable(args.exe && args.exe !== true ? String(args.exe) : (state && state.exe) || undefined); }
  catch (e) { P.err(e.message); process.exit(1); }
  let port = Number(args.port || (state && state.port) || 0);
  if (port <= 0) port = 9345;

  const res = P.patchAutostart({ exe, port, undo });
  if (!res.supported) {
    P.warn(`autostart is automated on Windows only for now (current OS: ${res.os}).`);
    P.info("Launch WorkBuddy with these flags so it always exposes the loopback debug port:");
    console.log(`    ${res.flag}`);
    P.info('Or just run "workbuddy-skin apply" — it opens WorkBuddy with the port already set.');
    return;
  }

  const items = res.items || [];
  if (!items.length) {
    P.warn(`No WorkBuddy shortcuts found pointing to:\n    ${exe}`);
    P.info('Pin/create a shortcut first, or use "apply --restart" once — the port stays up until WorkBuddy fully exits.');
    if (undo) P.saveState({ autostart: false });
    return;
  }
  for (const i of items) {
    const mark = i.status === "patched" ? "+" : i.status === "unpatched" ? "-" : i.status === "error" ? "x" : ".";
    console.log(`  ${mark} [${i.status}] ${i.path}`);
  }
  const errors = items.filter((i) => i.status === "error").length;

  if (undo) {
    const n = items.filter((i) => i.status === "unpatched").length;
    P.saveState({ autostart: false });
    P.ok(`Autostart disabled. Removed the debug flag from ${n} shortcut(s).`);
    P.info("Newly opened WorkBuddy windows will no longer expose the debug port.");
  } else {
    const n = items.filter((i) => i.status === "patched").length;
    P.saveState({ autostart: true, autostartPort: port });
    P.ok(`Autostart enabled on port ${port}. Patched ${n} shortcut(s); ${items.length - n} already OK.`);
    P.info(`WorkBuddy launched from those shortcuts now self-exposes 127.0.0.1:${port} — skinning hot-injects, no restart.`);
    P.info("Tip: fully close & reopen WorkBuddy once so the new flag takes effect.");
  }
  if (errors) P.warn(`${errors} shortcut(s) could not be updated (all-users scope likely needs admin). Re-run in an elevated terminal to include them.`);
}

// Version: injected at build time via esbuild `define` (__WB_VERSION__ becomes a
// string literal in the packaged exe); in dev (plain node) it's undeclared, so
// fall back to reading package.json from the project root.
function appVersion() {
  if (typeof __WB_VERSION__ !== "undefined") return __WB_VERSION__;
  try { return JSON.parse(readFileSync(join(P.ROOT, "package.json"), "utf8")).version || "unknown"; }
  catch { return "unknown"; }
}

function cmdHelp() {
  console.log(`WorkBuddy Skin v${appVersion()} — background + glass skin via loopback CDP (no official files changed)

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
  portrait set <image>         put a portrait cutout into a portrait theme (persists)
  portrait clear               remove the portrait slot image
  enable-cdp [undo]            persist WORKBUDDY_REMOTE_DEBUGGING_PORT so every
                               WorkBuddy launch self-opens the loopback debug
                               port (recommended; survives app self-updates)
  autostart [undo]             (legacy) patch WorkBuddy shortcuts to self-open
                               the debug port; prefer enable-cdp instead
  status                       show current state
  dom [--selector <css>]       inspect the live WorkBuddy DOM via CDP (a built-in
                               DevTools substitute: selector census + new-shell
                               discovery; --selector to dump specific nodes)
  help                         this message

apply options:
  --theme <id|path>            theme to use
  --bg <image>                 wallpaper image (also persisted)
  --portrait <image>           portrait cutout for a portrait theme (also persisted)
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

// ---- interactive menu (double-click friendly) ------------------------------
// When the exe is double-clicked there are no CLI args, so we drive a tiny text
// menu instead of dumping --help. Non-technical users never touch a terminal.
function ask(rl, q) { return new Promise((res) => rl.question(q, (a) => res(a.trim()))); }

// Make sure we know where WorkBuddy is before an apply. Uses the saved/auto-found
// path; if discovery fails, ask the user to point at it and remember the choice.
async function ensureExeInteractive(rl) {
  const state = P.readState();
  if (state && state.exe && existsSync(state.exe)) return true;
  try { const exe = P.findExecutable(); P.saveState({ exe }); return true; }
  catch { return await setExeInteractive(rl); }
}

// Prompt for the WorkBuddy executable and persist it to state.
async function setExeInteractive(rl) {
  console.log("\n[wb-skin] 需要 WorkBuddy 的程序位置。");
  console.log("把 WorkBuddy 的程序文件（Windows 上是 WorkBuddy.exe）拖进本窗口，或粘贴完整路径后回车（直接回车取消）：");
  for (let i = 0; i < 3; i++) {
    const p = (await ask(rl, "WorkBuddy 路径：")).replace(/^["']|["']$/g, "");
    if (!p) { console.log("已取消。"); return false; }
    if (existsSync(p)) { P.saveState({ exe: p }); P.ok(`已记住 WorkBuddy 位置：${p}`); return true; }
    console.log("路径无效或文件不存在，请重试。");
  }
  P.err("多次输入无效，已取消。");
  return false;
}

async function interactiveMenu() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  MENU_RL = rl;
  const pause = async () => { await ask(rl, "\n按回车键返回菜单..."); };
  try {
    for (; ;) {
      console.log("\n============================================");
      console.log(`   WorkBuddy 换肤工具  v${appVersion()}`);
      console.log("============================================");
      console.log("  1) 应用皮肤（自动启动 WorkBuddy 并换肤）");
      console.log("  2) 选择主题");
      console.log("  3) 设置壁纸（输入本地图片路径）");
      console.log("  4) 清除壁纸（恢复主题渐变）");
      console.log("  5) 还原为官方外观");
      if (P.IS_WIN) console.log("  6) 开启持久换肤（写入环境变量，无需重启即可换肤）");
      console.log("  7) 指定 WorkBuddy 位置（自动找不到时手动指定）");
      console.log("  0) 退出");
      const c = await ask(rl, "\n请输入序号后回车：");
      try {
        if (c === "1") { if (await ensureExeInteractive(rl)) await cmdApply(); await pause(); }
        else if (c === "2") {
          console.log("");
          const list = listThemes();
          list.forEach(([id, name], i) => console.log(`  ${i + 1}) ${id.padEnd(16)} ${name}`));
          const pick = await ask(rl, "\n选择主题序号（回车跳过）：");
          const idx = Number(pick) - 1;
          if (list[idx]) { args.theme = list[idx][0]; if (await ensureExeInteractive(rl)) await cmdApply(); }
          await pause();
        }
        else if (c === "3") {
          const p = await ask(rl, "\n拖入或粘贴图片路径后回车：");
          const clean = p.replace(/^["']|["']$/g, "");
          if (clean) { args.bg = clean; if (await ensureExeInteractive(rl)) await cmdApply(); }
          await pause();
        }
        else if (c === "4") { if (await ensureExeInteractive(rl)) { P.saveState({ background: null, accent: null }); await cmdApply(); } await pause(); }
        else if (c === "5") { await cmdRestore(); await pause(); }
        else if (c === "6" && P.IS_WIN) { await cmdEnableCdp(); await pause(); }
        else if (c === "7") { await setExeInteractive(rl); await pause(); }
        else if (c === "0" || c.toLowerCase() === "q") { break; }
        else { console.log("无效的选项。"); }
      } catch (e) { P.err(e.message); await pause(); }
    }
  } finally { MENU_RL = null; rl.close(); }
}

// ---- dispatch --------------------------------------------------------------
// Wind down fetch/undici keep-alive sockets before exiting. Otherwise the process
// is force-exited while a socket handle is still closing, which on Windows prints a
// harmless libuv teardown assertion (async.c) to stderr — scary-looking but benign.
async function softExit(code) {
  try {
    const disp = globalThis[Symbol.for("undici.globalDispatcher.1")];
    if (disp && typeof disp.close === "function") await disp.close();
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 40));
  process.exit(code);
}

(async () => {
  // hidden route: the self-exec'd watch daemon (see spawnInjectorDetached)
  if (CLI_ARGV[0] === "__inject") {
    const { runInjectorMain } = await import("./injector.mjs");
    const r = await runInjectorMain(CLI_ARGV.slice(1));
    process.exit((r && r.status) || 0);
  }

  // make built-in themes available even without an explicit "install" step so
  // a freshly-downloaded exe just works on first run
  try { P.ensureSeeded(); } catch { /* non-fatal */ }

  // no args (e.g. double-clicked exe, or bare `workbuddy-skin`) → menu
  if (CLI_ARGV.length === 0) { await interactiveMenu(); await softExit(0); }

  try {
    switch (CMD) {
      case "install": cmdInstall(); break;
      case "apply": case "start": await cmdApply(); break;
      case "restore": await cmdRestore(); break;
      case "theme": await cmdTheme(); break;
      case "bg": case "background": await cmdBg(); break;
      case "portrait": await cmdPortrait(); break;
      case "enable-cdp": case "cdp": await cmdEnableCdp(); break;
      case "dom": case "inspect": await cmdDom(); break;
      case "autostart": await cmdAutostart(); break;
      case "status": await cmdStatus(); break;
      case "help": case "--help": case "-h": cmdHelp(); break;
      case "version": case "--version": case "-v": console.log(appVersion()); break;
      default: P.err(`Unknown command: ${CMD}`); cmdHelp(); process.exit(2);
    }
  } catch (e) {
    P.err(e.message);
    process.exit(1);
  }
  // fetch() keep-alive sockets to the debug endpoint can hold the event loop
  // open; exit explicitly once the command has completed (watch runs detached).
  await softExit(0);
})();
