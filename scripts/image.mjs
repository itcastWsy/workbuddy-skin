// ============================================================================
// WorkBuddy Skin — 图片入库处理（自动压缩）
//
// 壁纸 / 立绘会被内联成 data URI 塞进 CSS，过大的字符串会被浏览器判为无效值直接
// 丢弃（回退默认渐变，静默失败）。这里在图片"入库"时就把它压到安全体积：
//   - wallpaper：最长边 2560px，JPEG（不透明，体积小）
//   - portrait ：最长边 1400px，PNG（保留 alpha 透明）
// 已在阈值内的小图直接原样拷贝，保持无损、格式不变。
// ============================================================================

import { Jimp, JimpMime } from "jimp";
import { copyFileSync, writeFileSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";

// 编码后字节上限。base64 约为字节数的 1.37 倍；900KB → ~1.2MB base64，
// 远低于实测会导致 CSS 变量被丢弃的 ~3.2MB。
export const IMAGE_CAP_BYTES = 900 * 1024;

const PRESET = {
  wallpaper: { maxDim: 2560, format: "jpeg", ext: "jpg" },
  portrait: { maxDim: 1400, format: "png", ext: "png" },
};

function fileSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

// 把源图片处理并写入 destDir，返回实际写入的路径（png→jpg 时扩展名会变）。
export async function processIntoStore(srcAbs, destDir, { kind = "wallpaper" } = {}) {
  const preset = PRESET[kind] || PRESET.wallpaper;
  const srcBase = basename(srcAbs);

  // 短路：已经足够小 → 原样拷贝，保留原始格式与画质。
  const srcBytes = fileSize(srcAbs);
  if (srcBytes > 0 && srcBytes <= IMAGE_CAP_BYTES) {
    const dest = join(destDir, srcBase);
    copyFileSync(srcAbs, dest);
    return { dest, resized: false, bytes: srcBytes };
  }

  // 需要压缩：交给 jimp 解码。无法解码（webp/heic/heif/avif 等 jimp 不支持的格式，
  // 或损坏文件）时——注意此分支只在图片已超过体积上限时才会走到——原样拷贝会因为内联后
  // 过大而被浏览器丢弃、静默没壁纸。所以这里给出明确、可执行的中文告警，并标记 undisplayable。
  let img;
  try {
    img = await Jimp.read(srcAbs);
  } catch (e) {
    const dest = join(destDir, srcBase);
    copyFileSync(srcAbs, dest);
    const ext = (extname(srcBase).slice(1) || "").toLowerCase();
    const unsupported = ["webp", "heic", "heif", "avif"].includes(ext);
    console.warn(
      `[wb-skin] 这张图（${srcBase}，约 ${(srcBytes / 1024).toFixed(0)} KB）无法压缩` +
      (unsupported ? `：不支持 ${ext.toUpperCase()} 格式的自动压缩。` : `：无法解码（可能已损坏）。`) +
      `图片偏大，直接内联很可能超出浏览器 CSS 上限而不显示。` +
      `请先转成 JPG 或 PNG（或换一张更小的图）再设为壁纸/立绘。`
    );
    return { dest, resized: false, bytes: srcBytes, undisplayable: true };
  }

  // 缩放到最长边不超过 maxDim（保持宽高比）。
  if (Math.max(img.width, img.height) > preset.maxDim) {
    img.scaleToFit({ w: preset.maxDim, h: preset.maxDim });
  }

  let buf;
  if (preset.format === "jpeg") {
    let q = 82;
    buf = await img.getBuffer(JimpMime.jpeg, { quality: q });
    // 先降质量
    while (buf.length > IMAGE_CAP_BYTES && q > 55) {
      q -= 8;
      buf = await img.getBuffer(JimpMime.jpeg, { quality: q });
    }
    // 仍超限则再缩尺寸
    let dim = preset.maxDim;
    while (buf.length > IMAGE_CAP_BYTES && dim > 1280) {
      dim = Math.round(dim * 0.8);
      img.scaleToFit({ w: dim, h: dim });
      buf = await img.getBuffer(JimpMime.jpeg, { quality: 72 });
    }
  } else {
    // PNG：保留透明。PNG 无质量参数，超限则逐步缩尺寸。
    buf = await img.getBuffer(JimpMime.png);
    let dim = preset.maxDim;
    while (buf.length > IMAGE_CAP_BYTES && dim > 700) {
      dim = Math.round(dim * 0.8);
      img.scaleToFit({ w: dim, h: dim });
      buf = await img.getBuffer(JimpMime.png);
    }
  }

  const outName = basename(srcBase, extname(srcBase)) + "." + preset.ext;
  const dest = join(destDir, outName);
  writeFileSync(dest, buf);
  return { dest, resized: true, bytes: buf.length };
}

// ============================================================================
// 主题色提取
//
// 从壁纸里取一个"代表色"作为皮肤强调色：缩略图 -> 按色相分桶 -> 取最鲜艳的一桶
// 的加权均值 -> 归一化到中等明度 / 较高饱和度，保证在明色和暗色玻璃上都读得出来。
// 纯灰阶或无法解码时返回 null（调用方回退到默认描边色）。
// ============================================================================
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const dd = max - min;
  if (dd > 1e-6) {
    s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
    if (max === r) h = (g - b) / dd + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / dd + 2;
    else h = (r - g) / dd + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  if (s <= 1e-6) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue(h + 1 / 3) * 255),
    g: Math.round(hue(h) * 255),
    b: Math.round(hue(h - 1 / 3) * 255),
  };
}

function toHex({ r, g, b }) {
  return "#" + [r, g, b]
    .map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0"))
    .join("");
}

// 返回归一化后的强调色 hex（如 "#3aa6a6"），或 null（灰阶 / 解码失败）。
export async function dominantAccent(srcAbs) {
  let img;
  try { img = await Jimp.read(srcAbs); } catch { return null; }
  img.scaleToFit({ w: 96, h: 96 }); // 采样够用又快

  const d = img.bitmap.data;
  const N = 24; // 15° 一桶
  const bins = Array.from({ length: N }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue; // 跳过透明像素
    const { h, s, l } = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (l < 0.12 || l > 0.9 || s < 0.18) continue; // 跳过近黑 / 近白 / 灰
    const w = s * (1 - Math.abs(l - 0.5) * 0.6); // 偏好鲜艳的中间调
    const bin = Math.min(N - 1, Math.floor(h * N));
    bins[bin].w += w;
    bins[bin].r += d[i] * w; bins[bin].g += d[i + 1] * w; bins[bin].b += d[i + 2] * w;
  }

  let best = bins[0];
  for (const b of bins) if (b.w > best.w) best = b;
  if (best.w <= 0) return null; // 纯灰阶壁纸：不取色

  let { h, s, l } = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
  s = Math.min(0.85, Math.max(0.5, s));  // 归一化：够艳但不刺眼
  l = Math.min(0.62, Math.max(0.48, l)); // 归一化：中等明度，明暗玻璃都读得出
  return toHex(hslToRgb(h, s, l));
}
