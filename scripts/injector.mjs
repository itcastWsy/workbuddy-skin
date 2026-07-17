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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DEFAULT = resolve(__dirname, "..", "assets");

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

const args = parseArgs(process.argv.slice(2));
const COMMAND = args._[0] || "apply";
const PORT = Number(args.port || 9345);
const HOST = "127.0.0.1";
const ASSETS = args.assets ? resolve(String(args.assets)) : ASSETS_DEFAULT;
const THEME_PATH = args.theme ? resolve(String(args.theme)) : join(ASSETS, "theme.json");
const TIMEOUT = Number(args.timeout || 15000);
const MARKER = "on";

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
body[data-wb-skin="on"]:has(.main-content--chat .chat-container:not(.chat-container--welcome)) #wb-skin-deco .deco--welcome{display:none;}`.trim();


// ---- 主题 -> 载荷 ----------------------------------------------------------
function buildConfig() {
  // 剥掉可能存在的 UTF-8 BOM（PowerShell 5.1 的 Set-Content -Encoding UTF8 会写入 BOM）
  const theme = JSON.parse(readFileSync(THEME_PATH, "utf8").replace(/^\uFEFF/, ""));
  const skinCss = readFileSync(join(ASSETS, "skin.css"), "utf8");

  const g = theme.glass || {};
  const bg = theme.background || {};
  const blur = Number(g.blur ?? 22);
  const sat = Number(g.saturate ?? 1.25);
  const num = (v, d) => (v == null ? d : Number(v));

  // 内联本地壁纸为 data URI（若 background 用的是 file:// 图片）
  const bgDark = inlineFileUrls(bg.dark) || "linear-gradient(140deg,#0b1020,#141033)";
  const bgLight = inlineFileUrls(bg.light) || "linear-gradient(140deg,#eef1ff,#eafaf6)";

  // 装饰层（立绘 / 标题横幅 / 印章 / 贴纸），image 类型的 src 在此内联为 data URI。
  const decorations = Array.isArray(theme.decorations)
    ? theme.decorations.map(prepDeco).filter(Boolean)
    : [];

  // 由主题生成的 CSS 变量层, 覆盖 skin.css 里的回退值。明/暗各一套。
  const varsCss = `
:root{--wb-skin-blur:${blur}px;--wb-skin-saturate:${sat};}
body[data-wb-skin="${MARKER}"]{
  --wb-skin-bg-dark:${bgDark};
  --wb-skin-bg-light:${bgLight};
  --wb-skin-panel:rgba(17,21,40,${num(g.panelOpacityDark, 0.46)});
  --wb-skin-card:rgba(20,24,46,${num(g.cardOpacityDark, 0.34)});
  --wb-skin-scrim:rgba(8,10,22,${num(g.chatScrimDark, 0.30)});
}
body[data-wb-skin="${MARKER}"].vscode-light,
body[data-wb-skin="${MARKER}"][data-vscode-theme-kind="vscode-light"]{
  --wb-skin-panel:rgba(255,255,255,${num(g.panelOpacityLight, 0.52)});
  --wb-skin-card:rgba(255,255,255,${num(g.cardOpacityLight, 0.62)});
  --wb-skin-scrim:rgba(255,255,255,${num(g.chatScrimLight, 0.24)});
}`.trim();

  return { varsCss, skinCss, decoCss: DECO_CSS, decorations, marker: MARKER, themeName: theme.name || theme.id || "skin" };
}

function buildPayload(config) {
  const injectSrc = readFileSync(join(ASSETS, "renderer-inject.js"), "utf8");
  return `window.__WB_SKIN_CONFIG=${JSON.stringify(config)};\n${injectSrc}`;
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
  if (t.type !== "page" || !t.webSocketDebuggerUrl) return false;
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
  const targets = await waitForTargets();
  log(`主题 "${config.themeName}" -> ${targets.length} 个渲染进程`);
  for (const t of targets) {
    try { await injectInto(t, payload); log("已注入:", t.title || t.url); }
    catch (e) { warn("注入失败:", t.title || t.url, "-", e.message); }
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
  if (!ok) { console.error("[wb-skin] 校验未通过：皮肤未生效。"); process.exit(1); }
  log("校验通过：皮肤已生效。");
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

async function cmdWatch() {
  const config = buildConfig();
  const payload = buildPayload(config);
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
      try { await injectInto(t, payload); log("watch 注入:", t.title || t.url); }
      catch (e) { warn("watch 注入失败:", e.message); seen.delete(t.id); }
    }
    // 清掉已消失目标, 便于重连
    const alive = new Set(targets.map((t) => t.id));
    for (const id of [...seen]) if (!alive.has(id)) seen.delete(id);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---- 入口 ------------------------------------------------------------------
(async () => {
  try {
    switch (COMMAND) {
      case "apply": await cmdApply(); break;
      case "remove": await cmdRemove(); break;
      case "verify": await cmdVerify(); break;
      case "shot": await cmdShot(); break;
      case "diag": await cmdDiag(); break;
      case "watch": await cmdWatch(); break;
      default: console.error("未知命令:", COMMAND); process.exit(2);
    }
  } catch (e) {
    console.error("[wb-skin] 错误:", e.message);
    process.exit(1);
  }
  // fetch() keep-alive sockets to the CDP endpoint can keep the event loop
  // alive; exit explicitly. (watch never reaches here — it loops forever.)
  process.exit(0);
})();
