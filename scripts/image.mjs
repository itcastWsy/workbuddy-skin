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

  // 需要压缩：交给 jimp 解码。无法解码（非常规图片）时回退原样拷贝并告警。
  let img;
  try {
    img = await Jimp.read(srcAbs);
  } catch (e) {
    const dest = join(destDir, srcBase);
    copyFileSync(srcAbs, dest);
    console.warn("[wb-skin] 无法解码该图片进行压缩，原样使用:", e.message);
    return { dest, resized: false, bytes: srcBytes };
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
