/* ============================================================================
 * WorkBuddy Skin — renderer 注入脚本
 * 由 injector.mjs 通过 CDP 在渲染进程里执行（既作为 addScriptToEvaluateOnNewDocument
 * 的早期载荷，也在已加载页面上即时执行）。幂等：重复执行不会叠加。
 *
 * 读取 window.__WB_SKIN_CONFIG = { varsCss, skinCss, marker }
 *   - varsCss : 由主题生成的 CSS 变量层（背景图 / 玻璃透明度 / 模糊）
 *   - skinCss : assets/skin.css 全文
 *   - marker  : body[data-wb-skin] 的值（通常 "on"）
 *
 * 清理：window.__wbSkinRemove() —— 移除样式、背景层、标记与观察器。
 * ==========================================================================*/
(function () {
  "use strict";

  var CFG = window.__WB_SKIN_CONFIG;
  if (!CFG || typeof CFG !== "object") return;

  var STYLE_VARS_ID = "wb-skin-vars";
  var STYLE_MAIN_ID = "wb-skin-style";
  var DECO_STYLE_ID = "wb-skin-deco-style";
  var FRAME_SCRIM_ID = "wb-skin-frame-scrim";
  var BG_ID = "wb-skin-bg";
  var DECO_ID = "wb-skin-deco";
  var MARKER = CFG.marker || "on";

  function upsertStyle(id, css) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      el.setAttribute("data-wb-skin-managed", "1");
      (document.head || document.documentElement).appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
    return el;
  }

  function ensureBgLayer() {
    if (!document.body) return;
    var bg = document.getElementById(BG_ID);
    if (!bg) {
      bg = document.createElement("div");
      bg.id = BG_ID;
      bg.setAttribute("aria-hidden", "true");
      bg.setAttribute("data-wb-skin-managed", "1");
    }
    // 始终保持为 body 的第一个子节点，稳定处于 #root 之下
    if (document.body.firstChild !== bg) {
      document.body.insertBefore(bg, document.body.firstChild);
    }
  }

  function markBody() {
    if (document.body && document.body.getAttribute("data-wb-skin") !== MARKER) {
      document.body.setAttribute("data-wb-skin", MARKER);
    }
  }

  // ---- 装饰层 --------------------------------------------------------------
  // 立绘 / 标题横幅 / 手写签名 / 印章 / 贴纸。视口锚定，pointer-events:none，
  // 默认只在首页显示（.deco--welcome，进入具体任务对话由 CSS 隐藏）。
  function num(v, d) { return (v == null || isNaN(Number(v))) ? d : Number(v); }
  function sz(v) { return (typeof v === "number") ? (v + "px") : v; }

  function place(el, d) {
    var parts = String(d.anchor || "top-left").split("-");
    var v = parts[0], h = parts[1] || "center";
    var dx = num(d.dx, 0), dy = num(d.dy, 0);
    var tx = "0px", ty = "0px";
    el.style.position = "absolute";
    if (v === "top") { el.style.top = dy + "px"; }
    else if (v === "bottom") { el.style.bottom = dy + "px"; }
    else { el.style.top = "50%"; ty = "calc(-50% + " + dy + "px)"; }
    if (h === "left") { el.style.left = dx + "px"; }
    else if (h === "right") { el.style.right = dx + "px"; }
    else { el.style.left = "50%"; tx = "calc(-50% + " + dx + "px)"; }
    var rot = d.rotate ? (" rotate(" + num(d.rotate, 0) + "deg)") : "";
    el.style.transform = "translate(" + tx + "," + ty + ")" + rot;
    if (d.opacity != null) el.style.opacity = String(d.opacity);
    if (d.z != null) el.style.zIndex = String(d.z);
  }

  function buildDeco(d) {
    var el = document.createElement("div");
    el.className = "wb-deco-item" + ((d.page === "all") ? "" : " deco--welcome");
    if (d.type === "image") {
      if (d.src) {
        var img = document.createElement("img");
        img.src = d.src; img.alt = "";
        if (d.width) img.style.width = sz(d.width);
        if (d.height) img.style.height = sz(d.height);
        if (d.radius != null) img.style.borderRadius = sz(d.radius);
        if (d.shadow) img.style.filter = "drop-shadow(0 20px 44px rgba(0,0,0,0.30))";
        el.appendChild(img);
      } else {
        // 没有提供立绘时的占位框
        el.className += " wb-deco-ph";
        el.style.width = sz(d.width || 220);
        el.style.height = sz(d.height || 300);
        el.style.whiteSpace = "pre-line";
        el.textContent = d.placeholder || "把你的立绘 PNG 放这里\nworkbuddy-skin portrait set <图片>";
      }
    } else if (d.type === "svg") {
      el.innerHTML = d.svg || "";
      if (d.width) el.style.width = sz(d.width);
    } else { // text
      el.textContent = d.text || "";
      el.style.whiteSpace = "pre-line";
      if (d.color) el.style.color = d.color;
      if (d.font) el.style.fontFamily = d.font;
      if (d.size != null) el.style.fontSize = sz(d.size);
      if (d.weight != null) el.style.fontWeight = String(d.weight);
      if (d.letterSpacing != null) el.style.letterSpacing = sz(d.letterSpacing);
      if (d.lineHeight != null) el.style.lineHeight = String(d.lineHeight);
      if (d.italic) el.style.fontStyle = "italic";
      if (d.shadow) el.style.textShadow = "0 2px 12px rgba(0,0,0,0.18)";
      if (d.align) el.style.textAlign = d.align;
      if (d.maxWidth != null) el.style.maxWidth = sz(d.maxWidth);
    }
    place(el, d);
    return el;
  }

  function ensureDecoLayer() {
    if (!document.body) return null;
    var layer = document.getElementById(DECO_ID);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = DECO_ID;
      layer.setAttribute("aria-hidden", "true");
      layer.setAttribute("data-wb-skin-managed", "1");
    }
    // z-index:30 保证浮在 #root(z:1) 之上，无需强制成为末尾节点（避免与 App 抢 DOM 顺序）
    if (!layer.parentNode) document.body.appendChild(layer);
    return layer;
  }

  function renderDecos() {
    var list = CFG.decorations;
    if (!Array.isArray(list) || !list.length) {
      var old = document.getElementById(DECO_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);
      return;
    }
    var layer = ensureDecoLayer();
    if (!layer) return;
    // 签名一致就跳过重建，避免 MutationObserver 频繁触发导致重绘
    var sig = String(list.length) + ":" + (CFG.themeName || "");
    if (layer.getAttribute("data-wb-sig") === sig && layer.childNodes.length) return;
    layer.setAttribute("data-wb-sig", sig);
    layer.innerHTML = "";
    for (var i = 0; i < list.length; i++) {
      try { layer.appendChild(buildDeco(list[i])); } catch (e) { }
    }
  }

  // ---- 通用透明清扫器 ------------------------------------------------------
  // 各页面根容器命名不统一（wb-home-route / conversation-shell / claw-workspace…），
  // 逐个枚举不可持续。这里按“结构特征”通用识别：主布局 .teams-container 内、
  // 大尺寸块级容器、实底(alpha>=0.5)、非浮层语境 -> 置透明。
  // skin.css 中玻璃面板/卡片/输入框规则带 !important，优先级始终高于此处的 inline 样式，
  // 因此已玻璃化的元件不受清扫影响。命中元素打 data-wb-skin-clear 标记防重复处理。
  var SWEEP_MARK = "data-wb-skin-clear";
  var SWEEP_MIN_W = 240, SWEEP_MIN_H = 160;
  var OVERLAY_SEL = '[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"]'
    + ',[class*="modal"],[class*="dialog"],[class*="drawer"],[class*="popover"]'
    + ',[class*="dropdown"],[class*="overlay"],[class*="picker"],[class*="toast"]'
    + ',[class*="tooltip"],[class*="menu"]';

  function inOverlayContext(el) {
    try {
      if (el.matches(OVERLAY_SEL)) return true;
      var p = el.parentElement;
      while (p && !p.classList.contains("teams-container")) {
        if (p.matches(OVERLAY_SEL)) return true;
        p = p.parentElement;
      }
    } catch (e) { }
    return false;
  }

  function sweepTransparent() {
    // 主文档限定 .teams-container（避开 portal 出来的弹层）；跨域 iframe（sweepBody）
    // 没有 .teams-container，退回 body 作用域，靠浮层排除规则兜底。
    var root = document.querySelector(".teams-container")
      || ((CFG.sweepBody && document.body) ? document.body : null);
    if (!root) return;
    var all = root.querySelectorAll("div,main,section,article,aside,header,footer,nav");
    var budget = 600; // 单轮预算，防超大子树卡顿
    for (var i = 0; i < all.length && budget > 0; i++) {
      var el = all[i];
      if (el.hasAttribute(SWEEP_MARK)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < SWEEP_MIN_W || r.height < SWEEP_MIN_H) continue;
      budget--;
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.position === "fixed") continue;
      var m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor || "");
      var alpha = 1;
      if (m) {
        var parts = m[1].split(",");
        if (parts.length >= 4) alpha = parseFloat(parts[3]);
      }
      if (alpha < 0.5) continue;
      if (inOverlayContext(el)) continue;
      el.style.background = "transparent";
      el.setAttribute(SWEEP_MARK, "1");
    }
  }

  var sweepTimer = null;
  function scheduleSweep() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(function () {
      sweepTimer = null;
      try { sweepTransparent(); } catch (e) { }
      // 路由切换可能整体重建 .teams-container，每次清扫后校正观察目标
      try { attachSweepWatcher(); } catch (e) { }
    }, 350);
  }

  // 观察 .teams-container（iframe 模式为 body）子树变化，防抖后重扫。
  // attributes:false -> 我们自己写的 inline style/标记不会再触发观察器，无回环。
  function attachSweepWatcher() {
    var root = document.querySelector(".teams-container")
      || ((CFG.sweepBody && document.body) ? document.body : null);
    if (!root) return;
    if (window.__wbSkinSweepRoot === root) return;
    if (!window.__wbSkinSweepObserver) {
      window.__wbSkinSweepObserver = new MutationObserver(scheduleSweep);
    }
    try { window.__wbSkinSweepObserver.disconnect(); } catch (e) { }
    window.__wbSkinSweepObserver.observe(root, { childList: true, subtree: true });
    window.__wbSkinSweepRoot = root;
  }

  function apply() {
    if (CFG.varsCss) upsertStyle(STYLE_VARS_ID, CFG.varsCss);
    if (CFG.skinCss) upsertStyle(STYLE_MAIN_ID, CFG.skinCss);
    // 装饰层（立绘/印章等）只属于主窗口；跨域 iframe 内不渲染避免重复贴图
    if (CFG.decoCss && window.self === window.top) upsertStyle(DECO_STYLE_ID, CFG.decoCss);
    // iframe 内没有 section 5 的任务页 scrim，给壁纸层加统一可读性遮罩（模糊+scrim，随明暗变量走）
    if (CFG.sweepBody) {
      upsertStyle(FRAME_SCRIM_ID,
        'body[data-wb-skin="on"] #wb-skin-bg::after{content:"";position:absolute;inset:0;'
        + 'background:var(--wb-skin-scrim, rgba(8,10,22,0.35));'
        + '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);}');
    }
    ensureBgLayer();
    markBody();
    if (window.self === window.top) renderDecos();
    try { sweepTransparent(); } catch (e) { }
    try { attachSweepWatcher(); } catch (e) { }
  }

  // ---- 幂等安装 ------------------------------------------------------------
  function boot() {
    apply();

    // 观察 body：App 若重建 body 子树或清掉标记，重新补上（去抖）。
    if (window.__wbSkinObserver) {
      try { window.__wbSkinObserver.disconnect(); } catch (e) { }
    }
    var scheduled = false;
    var obs = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      (window.requestAnimationFrame || setTimeout)(function () {
        scheduled = false;
        if (!document.getElementById(BG_ID) ||
          document.body.getAttribute("data-wb-skin") !== MARKER ||
          !document.getElementById(STYLE_MAIN_ID) ||
          (Array.isArray(CFG.decorations) && CFG.decorations.length && !document.getElementById(DECO_ID))) {
          apply();
        }
      });
    });
    obs.observe(document.documentElement, { childList: true, subtree: false });
    if (document.body) {
      obs.observe(document.body, { childList: true, attributes: true, attributeFilter: ["data-wb-skin"] });
    }
    window.__wbSkinObserver = obs;
  }

  if (document.body) {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
    // 兜底：body 出现前的极早期载荷
    var iv = setInterval(function () {
      if (document.body) { clearInterval(iv); boot(); }
    }, 16);
    setTimeout(function () { clearInterval(iv); }, 8000);
  }

  // ---- 卸载 ----------------------------------------------------------------
  window.__wbSkinRemove = function () {
    try { if (window.__wbSkinObserver) window.__wbSkinObserver.disconnect(); } catch (e) { }
    window.__wbSkinObserver = null;
    try { if (window.__wbSkinSweepObserver) window.__wbSkinSweepObserver.disconnect(); } catch (e) { }
    window.__wbSkinSweepObserver = null;
    window.__wbSkinSweepRoot = null;
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    [STYLE_VARS_ID, STYLE_MAIN_ID, DECO_STYLE_ID, FRAME_SCRIM_ID, BG_ID, DECO_ID].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    if (document.body) document.body.removeAttribute("data-wb-skin");
    // 还原清扫器透明化过的元素：去掉标记并清掉我们写的 inline background
    try {
      var cleared = document.querySelectorAll("[" + SWEEP_MARK + "]");
      for (var i = 0; i < cleared.length; i++) {
        cleared[i].removeAttribute(SWEEP_MARK);
        cleared[i].style.background = "";
      }
    } catch (e) { }
    try { delete window.__WB_SKIN_CONFIG; } catch (e) { window.__WB_SKIN_CONFIG = undefined; }
    return true;
  };

  // 标记安装状态，供 injector 校验
  window.__wbSkinInstalled = true;
})();
