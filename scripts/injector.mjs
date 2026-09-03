// ============================================================================
// WorkBuddy Skin — CDP 注入器 (零依赖, 需 Node 18+ 的 fetch / Node 21+ 的全局 WebSocket)
//
// 命令:
//   node injector.mjs apply  --port 9345 [--theme <theme.json>] [--assets <dir>]
//   node injector.mjs watch  --port 9345 ...     # 常驻, 处理刷新/导航后重注入
//   node injector.mjs remove --port 9345         # 实时清理 (还原时配合重启)
//   node injector.mjs verify --port 9345         # 校验皮肤是否生效, 退出码 0/1
//
// 只绑定 127.0.0.1 回环。不修改任何官方文件。
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DEFAULT = resolve(__dirname, "..", "assets");
const _require = createRequire(import.meta.url);

// 读取内置资源（skin.css / renderer-inject.js）。打包成 SEA 单文件 exe 后从内嵌
// asset 读取；开发/未打包时回退到磁盘的 assets 目录。两种形态都可用。
function loadAsset(name) {
  try {
    const sea = _require("node:sea");
    if (sea && typeof sea.isSea === "function" && sea.isSea()) {
      return sea.getAsset(name, "utf8");
    }
  } catch { /* 非 SEA 运行时，走磁盘 */ }
  return readFileSync(join(ASSETS, name), "utf8");
}

// ---- 参数解析 --------------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { a[key] = true; }
      else { a[key] = next; i++; }
    } else { a._.push(t); }
  }
  return a;
}

let args = { _: [] };
let COMMAND = "apply";
let PORT = 9345;
let ASSETS = ASSETS_DEFAULT;
let THEME_PATH = join(ASSETS, "theme.json");
let TIMEOUT = 15000;
const HOST = "127.0.0.1";
const MARKER = "on";

// 用一组注入参数初始化模块级状态。in-process 调用（打包后主进程直接调）与
// 独立进程（开发期 node injector.mjs）都通过它设置，因此可重复调用。
function initInjectorArgs(argv) {
  args = parseArgs(argv);
  COMMAND = args._[0] || "apply";
  PORT = Number(args.port || 9345);
  ASSETS = args.assets ? resolve(String(args.assets)) : ASSETS_DEFAULT;
  THEME_PATH = args.theme ? resolve(String(args.theme)) : join(ASSETS, "theme.json");
  TIMEOUT = Number(args.timeout || 15000);
}

function log(...m) { console.log("[wb-skin]", ...m); }
function warn(...m) { console.warn("[wb-skin]", ...m); }

// data URI 体积软上限。正常路径下图片已在 CLI 侧（image.mjs）被自动压缩；这里只是
// 兜底：万一有超大图（例如手改主题里塞了 file://），base64 过长会被浏览器判为无效
// CSS 值直接丢弃、静默回退默认渐变。超过则明确告警，绝不假装成功。
const DATAURI_WARN_BYTES = 1.8 * 1024 * 1024;

function warnIfHuge(base64Len, label) {
  if (base64Len > DATAURI_WARN_BYTES) {
    warn(`${label} 内联后约 ${(base64Len / 1024 / 1024).toFixed(1)}MB，可能超出 CSS 值上限而不生效。` +
      `请用 "bg set" / "portrait set" 重新入库（会自动压缩），或换更小的图。`);
  }
}

// 把 CSS background 值里的本地 file:// 图片内联为 data URI，绕过渲染进程 CSP 对 file: 的拦截。
function inlineFileUrls(cssValue) {
  if (!cssValue || typeof cssValue !== "string") return cssValue;
  return cssValue.replace(/url\(\s*(['"]?)(file:\/\/\/?[^'")]+)\1\s*\)/gi, (m, _q, u) => {
    try {
      const p = decodeURI(u.replace(/^file:\/\/\/?/i, ""));
      const buf = readFileSync(p);
      const ext = (p.split(".").pop() || "").toLowerCase();
      const mime = ext === "png" ? "image/png"
        : ext === "webp" ? "image/webp"
          : ext === "gif" ? "image/gif"
            : ext === "svg" ? "image/svg+xml"
              : "image/jpeg";
      log(`内联壁纸: ${p} (${(buf.length / 1024).toFixed(0)} KB)`);
      const b64 = buf.toString("base64");
      warnIfHuge(b64.length, "壁纸");
      return `url("data:${mime};base64,${b64}")`;
    } catch (e) {
      warn("内联壁纸失败, 保留原 url:", e.message);
      return m;
    }
  });
}

// 把一个本地图片路径（file:// 或普通路径）读成 data URI，供装饰层 <img> 用（绕过 CSP）。
function fileToDataUri(src) {
  const p0 = String(src).replace(/^file:\/\/\/?/i, "");
  const p = decodeURI(p0);
  const abs = resolve(p);
  const buf = readFileSync(abs);
  const ext = (abs.split(".").pop() || "").toLowerCase();
  const mime = ext === "png" ? "image/png"
    : ext === "webp" ? "image/webp"
      : ext === "gif" ? "image/gif"
        : ext === "svg" ? "image/svg+xml"
          : "image/jpeg";
  return { uri: `data:${mime};base64,${buf.toString("base64")}`, kb: buf.length / 1024 };
}

// 校验装饰图内联后是否过大（供 prepDeco 调用告警）。
function decoWarnIfHuge(uri, label) {
  const i = uri.indexOf(",");
  warnIfHuge(i >= 0 ? uri.length - i - 1 : uri.length, label);
}

// 预处理一个装饰项：image 类型内联 src；其余原样返回。失败则丢弃 src（渲染层会退回占位框）。
function prepDeco(d) {
  if (!d || typeof d !== "object") return null;
  if (d.type === "image" && d.src && d.src !== true) {
    try {
      const { uri, kb } = fileToDataUri(d.src);
      log(`内联装饰图: ${d.id || d.role || "img"} (${kb.toFixed(0)} KB)`);
      decoWarnIfHuge(uri, `装饰图 ${d.id || d.role || "img"}`);
      return { ...d, src: uri };
    } catch (e) {
      warn(`内联装饰图失败(${d.id || d.role || "img"})，改用占位框:`, e.message);
      const { src, ...rest } = d;
      return { ...rest, src: null };
    }
  }
  return { ...d };
}

// 装饰层基础样式：固定浮层、不挡点击；仅首页显示（进入具体任务对话即隐藏，与 scrim 规则一致）。
const DECO_CSS = `
#wb-skin-deco{position:fixed;inset:0;z-index:30;pointer-events:none;overflow:hidden;}
#wb-skin-deco .wb-deco-item{position:absolute;pointer-events:none;user-select:none;}
#wb-skin-deco .wb-deco-item img{display:block;max-width:none;}
#wb-skin-deco .wb-deco-ph{border:2px dashed rgba(120,120,120,0.55);border-radius:16px;display:flex;align-items:center;justify-content:center;text-align:center;color:rgba(90,90,90,0.75);font-size:13px;padding:10px;box-sizing:border-box;background:rgba(255,255,255,0.06);}
body[data-wb-skin="on"]:has(.main-content--chat .chat-container:not(.chat-container--welcome)) #wb-skin-deco .deco--welcome,
body[data-wb-skin="on"]:has(.conversation-shell .cr-message-list) #wb-skin-deco .deco--welcome{display:none;}`.trim();


// ---- 主题 -> 载荷 ----------------------------------------------------------
function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function buildConfig() {
  // 剥掉可能存在的 UTF-8 BOM（PowerShell 5.1 的 Set-Content -Encoding UTF8 会写入 BOM）
  const theme = JSON.parse(readFileSync(THEME_PATH, "utf8").replace(/^\uFEFF/, ""));
  const skinCss = loadAsset("skin.css");

  const g = theme.glass || {};
  const bg = theme.background || {};
  const blur = Number(g.blur ?? 22);
  const sat = Number(g.saturate ?? 1.25);
  // 浅色白纱（半透明白 veil）会把模糊背景的色相冲淡成“默认灰白”，
  // 故浅色模式按 ×1.76 补偿饱和度，让顶栏/侧栏玻璃透出壁纸色调。
  const lightSat = Math.round(sat * 1.76 * 100) / 100;
  const num = (v, d) => (v == null ? d : Number(v));

  // 内联本地壁纸为 data URI（若 background 用的是 file:// 图片）
  const bgDark = inlineFileUrls(bg.dark) || "linear-gradient(140deg,#0b1020,#141033)";
  const bgLight = inlineFileUrls(bg.light) || "linear-gradient(140deg,#eef1ff,#eafaf6)";

  // 装饰层（立绘 / 标题横幅 / 印章 / 贴纸），image 类型的 src 在此内联为 data URI。
  const decorations = Array.isArray(theme.decorations)
    ? theme.decorations.map(prepDeco).filter(Boolean)
    : [];

  // 主题强调色（通常由壁纸自动取色，见 image.mjs / cli 的 bg set）。用 !important 覆盖
  // skin.css 里不带 important 的描边变量：轻上色 = 玻璃描边 / 悬停 / 滚动条跟着壁纸变色，
  // 面板底色与正文对比度不受影响。无强调色时下面两段为空串，走 skin.css 默认描边。
  const acc = hexToRgb(theme.accent);
  const accVars = (a) => acc
    ? `\n  --wb-skin-accent:${theme.accent};\n  --wb-skin-border:rgba(${acc.r},${acc.g},${acc.b},${a[0]}) !important;\n  --wb-skin-border-strong:rgba(${acc.r},${acc.g},${acc.b},${a[1]}) !important;`
    : "";
  const accentDark = accVars([0.30, 0.44]);
  const accentLight = accVars([0.32, 0.48]);

  // 由主题生成的 CSS 变量层, 覆盖 skin.css 里的回退值。明/暗各一套。
  const varsCss = `
:root{--wb-skin-blur:${blur}px;--wb-skin-saturate:${sat};}
body[data-wb-skin="${MARKER}"]{
  --wb-skin-bg-dark:${bgDark};
  --wb-skin-bg-light:${bgLight};
  --wb-skin-panel:rgba(17,21,40,${num(g.panelOpacityDark, 0.46)});
  --wb-skin-card:rgba(20,24,46,${num(g.cardOpacityDark, 0.34)});
  --wb-skin-scrim:rgba(8,10,22,${num(g.chatScrimDark, 0.30)});${accentDark}
}
body[data-wb-skin="${MARKER}"].vscode-light,
body[data-wb-skin="${MARKER}"][data-vscode-theme-kind="vscode-light"]{
  --wb-skin-panel:rgba(255,255,255,${num(g.panelOpacityLight, 0.58)});
  --wb-skin-card:rgba(255,255,255,${num(g.cardOpacityLight, 0.72)});
  --wb-skin-scrim:rgba(255,255,255,${num(g.chatScrimLight, 0.55)});
  --wb-skin-saturate:${lightSat};${accentLight}
}`.trim();

  return { varsCss, skinCss, decoCss: DECO_CSS, decorations, marker: MARKER, themeName: theme.name || theme.id || "skin" };
}

function buildPayload(config, extra = null) {
  const injectSrc = loadAsset("renderer-inject.js");
  const cfg = extra ? { ...config, ...extra } : config;
  return `window.__WB_SKIN_CONFIG=${JSON.stringify(cfg)};\n${injectSrc}`;
}

const REMOVE_PAYLOAD = `(function(){
  if (typeof window.__wbSkinRemove === "function") { try { return window.__wbSkinRemove(); } catch(e){} }
  ["wb-skin-vars","wb-skin-style","wb-skin-deco-style","wb-skin-bg","wb-skin-deco"].forEach(function(id){var el=document.getElementById(id);if(el&&el.parentNode)el.parentNode.removeChild(el);});
  if(document.body)document.body.removeAttribute("data-wb-skin");
  try{if(window.__wbSkinObserver)window.__wbSkinObserver.disconnect();}catch(e){}
  window.__wbSkinObserver=null;window.__wbSkinInstalled=false;
  return true;
})();`;

const VERIFY_PAYLOAD = `(function(){
  return JSON.stringify({
    installed: !!window.__wbSkinInstalled,
    marker: document.body ? document.body.getAttribute("data-wb-skin") : null,
    bg: !!document.getElementById("wb-skin-bg"),
    style: !!document.getElementById("wb-skin-style"),
    app: document.body ? document.body.getAttribute("data-application-name") : null
  });
})();`;

// ---- CDP 目标发现 ----------------------------------------------------------
async function fetchTargets() {
  const url = `http://${HOST}:${PORT}/json`;
  const res = await fetch(url, { headers: { Host: `${HOST}:${PORT}` } });
  if (!res.ok) throw new Error(`CDP /json HTTP ${res.status}`);
  return res.json();
}

function isWorkBuddyRenderer(t) {
  // page = 主窗口文档；iframe = 内嵌远程页（如资料库 space-panel，跨域无法从主文档触达，
  // 但 CDP 将其暴露为独立目标，可单独注入实现内部换肤）。
  if ((t.type !== "page" && t.type !== "iframe") || !t.webSocketDebuggerUrl) return false;
  const hay = `${t.url || ""} ${t.title || ""}`.toLowerCase();
  return (
    hay.includes("app.asar/renderer") ||
    hay.includes("index.html") ||
    hay.includes("workbuddy")
  );
}

async function pickTargets() {
  const targets = await fetchTargets();
  const matched = targets.filter(isWorkBuddyRenderer);
  if (matched.length) return matched;
  // 回退: 若识别不到, 用所有 page 目标 (CSS 已按 data-application-name 收敛)
  return targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

// ---- 极简 CDP 客户端 (基于全局 WebSocket) ----------------------------------
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.ws = null;
  }
  open() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const to = setTimeout(() => rej(new Error("CDP 连接超时")), TIMEOUT);
      ws.addEventListener("open", () => { clearTimeout(to); res(); });
      ws.addEventListener("error", (e) => { clearTimeout(to); rej(new Error("CDP 连接失败: " + (e.message || e.type))); });
      ws.addEventListener("close", () => {
        for (const { rej } of this.pending.values()) rej(new Error("CDP 连接已关闭"));
        this.pending.clear();
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); }
        catch { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        } else if (msg.method) {
          for (const fn of this.listeners) fn(msg.method, msg.params);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} 超时`)); }
      }, TIMEOUT);
    });
  }
  on(fn) { this.listeners.add(fn); }
  close() { try { this.ws && this.ws.close(); } catch { } }
}

// ---- 单目标操作 ------------------------------------------------------------
async function injectInto(target, payload, { persist = true } = {}) {
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.open();
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // 关闭该页 CSP，避免个别版本拦截注入样式/背景资源（仅本机调试会话内生效）
    try { await cdp.send("Page.setBypassCSP", { enabled: true }); } catch (e) { /* 老版本无此域, 忽略 */ }
    if (persist) {
      // 早期载荷: 刷新/导航后在文档创建时即注入
      try { await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: payload }); }
      catch (e) { warn("addScriptToEvaluateOnNewDocument 失败(忽略):", e.message); }
    }
    // 对当前已加载页面立即注入
    const r = await cdp.send("Runtime.evaluate", { expression: payload, includeCommandLineAPI: false, returnByValue: false, awaitPromise: false });
    if (r && r.exceptionDetails) warn("注入异常:", r.exceptionDetails.text);
    return true;
  } finally {
    cdp.close();
  }
}

async function evalInto(target, expression) {
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.open();
  try {
    await cdp.send("Runtime.enable");
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false });
    if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r && r.result ? r.result.value : undefined;
  } finally {
    cdp.close();
  }
}

// ---- 命令 ------------------------------------------------------------------
async function waitForTargets(retries = 40, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const t = await pickTargets();
      if (t.length) return t;
    } catch { }
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`在 ${HOST}:${PORT} 上找不到 WorkBuddy 渲染进程 (调试端口是否开启?)`);
}

async function cmdApply() {
  const config = buildConfig();
  const payload = buildPayload(config);
  // iframe 内没有 .teams-container，清扫器改为以 body 为作用域（见 renderer-inject.js）
  const payloadFrame = buildPayload(config, { sweepBody: true });
  const targets = await waitForTargets();
  log(`主题 "${config.themeName}" -> ${targets.length} 个渲染进程`);
  for (const t of targets) {
    try {
      await injectInto(t, t.type === "iframe" ? payloadFrame : payload);
      log("已注入:", t.title || t.url);
    } catch (e) { warn("注入失败:", t.title || t.url, "-", e.message); }
  }
  log("应用完成。");
}

async function cmdRemove() {
  let targets = [];
  try { targets = await pickTargets(); } catch (e) { warn(e.message); }
  for (const t of targets) {
    try { await evalInto(t, REMOVE_PAYLOAD); log("已清理:", t.title || t.url); }
    catch (e) { warn("清理失败:", t.title || t.url, "-", e.message); }
  }
  log("实时清理完成 (还原脚本会重启 WorkBuddy 以彻底复原)。");
}

async function cmdVerify() {
  const targets = await waitForTargets(10, 400);
  let ok = false;
  for (const t of targets) {
    try {
      const raw = await evalInto(t, VERIFY_PAYLOAD);
      const s = JSON.parse(raw);
      log("校验:", t.title || t.url, JSON.stringify(s));
      if (s.installed && s.marker === MARKER && s.bg && s.style) ok = true;
    } catch (e) { warn("校验失败:", e.message); }
  }
  if (!ok) { console.error("[wb-skin] 校验未通过：皮肤未生效。"); return false; }
  log("校验通过：皮肤已生效。");
  return true;
}

async function cmdShot() {
  const out = args.out ? resolve(String(args.out)) : join(process.cwd(), "wb-skin-shot.png");
  const targets = await waitForTargets(10, 400);
  const t = targets[0];
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.open();
  try {
    await cdp.send("Page.enable");
    const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!r || !r.data) throw new Error("截图为空");
    writeFileSync(out, Buffer.from(r.data, "base64"));
    log("截图已保存:", out, "(目标:", (t.title || t.url) + ")");
  } finally { cdp.close(); }
}

const DIAG_PAYLOAD = `(function(){
  function bgc(el){return el?getComputedStyle(el).backgroundColor:null;}
  var bg=document.getElementById('wb-skin-bg');
  var cs=bg?getComputedStyle(bg):null;
  var rect=bg?bg.getBoundingClientRect():null;
  var info={
    bgExists:!!bg,
    bgRect:rect?{w:Math.round(rect.width),h:Math.round(rect.height)}:null,
    bgImageHead:cs?(cs.backgroundImage||'').slice(0,48):'',
    bgZ:cs?cs.zIndex:null,
    bgVisibility:cs?cs.visibility+'/'+cs.display+'/op:'+cs.opacity:null,
    bodyBg:bgc(document.body),
    rootBg:bgc(document.getElementById('root'))
  };
  var cx=Math.floor(innerWidth*0.5), cy=Math.floor(innerHeight*0.5);
  var el=document.elementFromPoint(cx,cy);
  var chain=[];
  while(el&&chain.length<14){
    var c=getComputedStyle(el);
    chain.push((el.tagName)+'.'+String(el.className||'').replace(/\\s+/g,'.').slice(0,42)+' bg='+c.backgroundColor+' z='+c.zIndex+' pos='+c.position);
    el=el.parentElement;
  }
  info.centerChain=chain;
  return JSON.stringify(info,null,2);
})();`;

async function cmdDiag() {
  const targets = await waitForTargets(10, 400);
  for (const t of targets) {
    const raw = await evalInto(t, DIAG_PAYLOAD);
    log("诊断:", t.title || t.url);
    console.log(raw);
  }
}

// ---- dom: 内置“DevTools 替代”，自助勘察 DOM ----------------------------
// 新版 WorkBuddy 关掉了开发者工具，无法直接看选择器。本命令通过 CDP
// 在渲染进程里跑一段勘察脚本：
//   * 默认：对皮肤关心的选择器做普查（命中数）+ 发现当前页面所有
//     CSS-module 哈希类前缀（如 _grid_lm2jv_）供定位新壳层；
//   * --selector <css>：只看指定选择器，对前几个命中元素 dump
//     tag/id/class/尺寸/背景色/outerHTML 头部。
function buildDomPayload(selector) {
  const CENSUS = [
    "[data-application-name]", "#workbuddy-menubar-container", ".workbuddy-topbar",
    ".workbuddy-window-controls", ".teams-container", ".teams-content-wrapper",
    ".teams-main-content", ".main-content", ".main-content--chat", ".main-content--welcome",
    ".conversation-sidebar", ".conversation-list", ".conversation-list-topbar",
    ".sidebar-next", ".conversation-item", ".conversation-agent-card",
    ".chat-container", ".chat-container--welcome", ".expert-center-page",
    ".plugins-panel", ".welcome-only-wrapper",
    '[class*="_grid_"]', '[class*="_gridView_"]', '[class*="_gridViewItem_"]',
    '[class*="_cbChat_"]', '[class*="_assistantMessageContent_"]',
    '[class*="_userMessageText_"]',
  ];
  const sel = selector ? JSON.stringify(String(selector)) : "null";
  return `(function(){
  var census=${JSON.stringify(CENSUS)};
  function bg(el){try{return getComputedStyle(el).backgroundColor;}catch(e){return null;}}
  var out={version:(document.body&&document.body.getAttribute('data-product-version'))||null,
           app:(document.body&&document.body.getAttribute('data-application-name'))||null};
  out.census=census.map(function(s){
    var n=0; try{n=document.querySelectorAll(s).length;}catch(e){}
    return {selector:s,count:n};
  });
  function bdf(el){try{var c=getComputedStyle(el);return (c.backdropFilter||c.webkitBackdropFilter||'none');}catch(e){return null;}}
  function flt(el){try{return getComputedStyle(el).filter;}catch(e){return null;}}
  var sel=${sel};
  if(sel){
    var hit=[].slice.call(document.querySelectorAll(sel)).slice(0,6);
    out.selector=sel; out.matched=document.querySelectorAll(sel).length;
    out.samples=hit.map(function(el){
      var r=el.getBoundingClientRect();
      return {tag:el.tagName,id:el.id||null,cls:String(el.className||'').slice(0,120),
        bg:bg(el),backdropFilter:bdf(el),filter:flt(el),
        rect:{w:Math.round(r.width),h:Math.round(r.height)},
        html:(el.outerHTML||'').slice(0,200)};
    });
  } else {
    // 发现页面上所有 CSS-module 哈希类前缀，按出现次数降序（防版本升级用）
    var freq={};
    [].forEach.call(document.querySelectorAll('*'),function(el){
      String(el.className||'').split(/\\s+/).forEach(function(c){
        var m=/^(_[A-Za-z]+_)/.exec(c);
        if(m){freq[m[1]]=(freq[m[1]]||0)+1;}
      });
    });
    out.moduleClassPrefixes=Object.keys(freq).map(function(k){return {prefix:k,count:freq[k]};})
      .sort(function(a,b){return b.count-a.count;}).slice(0,40);
    // 主要分栏容器树：从 body 开始浅层遍历有实底色且尺寸大的块
    var tree=[];
    (function walk(el,depth){
      if(depth>4||tree.length>60)return;
      for(var i=0;i<el.children.length;i++){
        var c=el.children[i]; var r=c.getBoundingClientRect();
        if(r.width<120||r.height<80)continue;
        var bgc=bg(c);
        tree.push({d:depth,tag:c.tagName,id:c.id||null,
          cls:String(c.className||'').slice(0,80),
          bg:bgc,w:Math.round(r.width),h:Math.round(r.height)});
        walk(c,depth+1);
      }
    })(document.body,0);
    out.tree=tree;
  }
  return JSON.stringify(out,null,2);
})();`;
}

async function cmdDom() {
  const selector = args.selector && args.selector !== true ? String(args.selector) : null;
  const payload = buildDomPayload(selector);
  const targets = await waitForTargets(10, 400);
  for (const t of targets) {
    log("DOM 勘察:", t.title || t.url);
    try {
      const raw = await evalInto(t, payload);
      console.log(raw);
    } catch (e) { warn("勘察失败:", e.message); }
  }
}

async function cmdWatch() {
  const config = buildConfig();
  const payload = buildPayload(config);
  const payloadFrame = buildPayload(config, { sweepBody: true });
  const seen = new Set();
  log(`watch 模式启动 (端口 ${PORT})，Ctrl+C 退出。`);
  let stopped = false;
  process.on("SIGINT", () => { stopped = true; log("watch 退出。"); process.exit(0); });
  process.on("SIGTERM", () => { stopped = true; process.exit(0); });

  // 首轮等待目标出现
  try { await waitForTargets(); } catch (e) { warn(e.message); }

  while (!stopped) {
    let targets = [];
    try { targets = await pickTargets(); } catch { }
    for (const t of targets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      try { await injectInto(t, t.type === "iframe" ? payloadFrame : payload); log("watch 注入:", t.title || t.url); }
      catch (e) { warn("watch 注入失败:", e.message); seen.delete(t.id); }
    }
    // 清掉已消失目标, 便于重连
    const alive = new Set(targets.map((t) => t.id));
    for (const id of [...seen]) if (!alive.has(id)) seen.delete(id);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---- 入口 ------------------------------------------------------------------
// 供打包后的主进程 in-process 调用（不再 spawn 独立 node）。返回 { status }，
// 不调用 process.exit —— 由调用方决定进程去留。watch 命令会一直循环不返回。
export async function runInjectorMain(argv) {
  initInjectorArgs(argv);
  try {
    switch (COMMAND) {
      case "apply": await cmdApply(); return { status: 0 };
      case "remove": await cmdRemove(); return { status: 0 };
      case "verify": { const ok = await cmdVerify(); return { status: ok ? 0 : 1 }; }
      case "shot": await cmdShot(); return { status: 0 };
      case "diag": await cmdDiag(); return { status: 0 };
      case "dom": case "inspect": await cmdDom(); return { status: 0 };
      case "watch": await cmdWatch(); return { status: 0 };
      default: console.error("未知命令:", COMMAND); return { status: 2 };
    }
  } catch (e) {
    console.error("[wb-skin] 错误:", e.message);
    return { status: 1 };
  }
}

// 开发期直接运行（node scripts/injector.mjs ...）时才自启。打包/被 import 时不触发。
const _direct = (() => {
  try {
    const entry = (process.argv[1] || "").replace(/\\/g, "/");
    return /\/injector\.mjs$/.test(entry);
  } catch { return false; }
})();
if (_direct) {
  runInjectorMain(process.argv.slice(2)).then((r) => process.exit(r.status || 0));
}
