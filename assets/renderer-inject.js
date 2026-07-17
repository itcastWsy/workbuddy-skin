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
  var BG_ID = "wb-skin-bg";
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

  function apply() {
    if (CFG.varsCss) upsertStyle(STYLE_VARS_ID, CFG.varsCss);
    if (CFG.skinCss) upsertStyle(STYLE_MAIN_ID, CFG.skinCss);
    ensureBgLayer();
    markBody();
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
          !document.getElementById(STYLE_MAIN_ID)) {
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
    [STYLE_VARS_ID, STYLE_MAIN_ID, BG_ID].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    if (document.body) document.body.removeAttribute("data-wb-skin");
    try { delete window.__WB_SKIN_CONFIG; } catch (e) { window.__WB_SKIN_CONFIG = undefined; }
    return true;
  };

  // 标记安装状态，供 injector 校验
  window.__wbSkinInstalled = true;
})();
