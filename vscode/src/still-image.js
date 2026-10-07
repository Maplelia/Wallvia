/**
 * @fileoverview Wallvia — get the *best* still image for a wallpaper.
 *
 * A scene wallpaper ships `scene.pkg`, an uncompressed container holding the
 * scene JSON and its `.tex` textures. Those textures wrap a plain,
 * full-resolution PNG — the actual artwork (3840x2160 and larger on real
 * packages) — while the workshop item only ships a small square `preview.jpg`
 * (801x801 / 1024x1024 on this machine). Painting the preview across a wide
 * window is what made the background look cropped and compressed; the bytes
 * read here are copied verbatim, so nothing is re-encoded.
 *
 * A video wallpaper has no still image at all: one frame is decoded by the
 * picker's own Chromium (see `video-frame.js`), and this module never touches it.
 *
 * Zero dependencies beyond node builtins; every function degrades to null /
 * false instead of throwing.
 *
 * Layout of a scene package, confirmed against real packages:
 *   [u32 8]["PKGV0022"][u32 fileCount]
 *   per entry: [u32 nameLen][name][u32 dataOffset][u32 dataLength]
 * Entry offsets are relative to the data section, which starts right after the
 * table.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ENTRIES = 4096;
const MAX_NAME_LENGTH = 512;
const MIN_IMAGE_SIDE = 8;
const MAX_IMAGE_SIDE = 32768;
const MAX_CHUNKS = 500000;

const VIDEO_EXT = /\.(mp4|webm|mkv|avi|mov|m4v|wmv|flv)$/i;
/** Still-image formats a webview or a background layer can paint. */
const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|webp|tiff?)$/i;

// ------------------------------------------------------------- scene.pkg

function hasPngSignature(buf, at) {
  if (at + PNG_SIGNATURE.length > buf.length) return false;
  return buf.compare(PNG_SIGNATURE, 0, PNG_SIGNATURE.length, at, at + PNG_SIGNATURE.length) === 0;
}

/** True when these bytes look like a Wallpaper Engine package container. */
function isScenePackage(buf) {
  return buf.length > 16 && buf.toString("ascii", 4, 8) === "PKGV";
}

/**
 * Read the package's file table. Returns null when the bytes are not a package
 * or the table is inconsistent — callers then fall back to the preview image.
 */
function parseScenePackage(buf) {
  if (!isScenePackage(buf)) return null;
  const count = buf.readUInt32LE(12);
  if (count <= 0 || count > MAX_ENTRIES) return null;
  let cursor = 16;
  const raw = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor + 4 > buf.length) return null;
    const nameLength = buf.readUInt32LE(cursor);
    cursor += 4;
    if (nameLength <= 0 || nameLength > MAX_NAME_LENGTH || cursor + nameLength + 8 > buf.length) {
      return null;
    }
    const name = buf.toString("ascii", cursor, cursor + nameLength);
    cursor += nameLength;
    const relative = buf.readUInt32LE(cursor);
    const length = buf.readUInt32LE(cursor + 4);
    cursor += 8;
    raw.push({ name, relative, length });
  }
  const dataStart = cursor;
  const entries = [];
  for (const item of raw) {
    const offset = dataStart + item.relative;
    if (offset + item.length > buf.length) return null;
    entries.push({ name: item.name, offset, length: item.length });
  }
  return entries;
}

/**
 * Walk the PNG chunks starting at `at`, so the returned length covers exactly
 * one complete image. A naive "until the next signature" slice truncates it:
 * compressed data contains byte sequences that look like other signatures.
 */
function readPngAt(buf, at, limit) {
  if (!hasPngSignature(buf, at)) return null;
  let cursor = at + PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk += 1) {
    if (cursor + 8 > buf.length || cursor + 8 > limit) return null;
    const length = buf.readUInt32BE(cursor);
    const type = buf.toString("ascii", cursor + 4, cursor + 8);
    if (chunk === 0) {
      if (type !== "IHDR" || length < 13) return null;
      width = buf.readUInt32BE(cursor + 8);
      height = buf.readUInt32BE(cursor + 12);
      if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) return null;
      if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return null;
    } else if (!/^[A-Za-z]{4}$/.test(type)) {
      return null;
    }
    cursor += 12 + length;
    if (type === "IEND") return { start: at, length: cursor - at, width, height };
  }
  return null;
}

/** Every complete PNG inside one package entry (a texture's mipmap chain). */
function findEmbeddedPngs(buf, entry) {
  const limit = Math.min(entry.offset + entry.length, buf.length);
  const found = [];
  let from = entry.offset;
  while (from < limit) {
    const at = buf.indexOf(PNG_SIGNATURE, from);
    if (at < 0 || at + PNG_SIGNATURE.length > limit) break;
    const png = readPngAt(buf, at, limit);
    if (png) found.push({ ...png, entry: entry.name });
    from = at + PNG_SIGNATURE.length;
  }
  return found;
}

/**
 * Every embedded PNG of the package, largest first.
 *
 * A Wallpaper Engine `.tex` stores a mipmap chain, so the same artwork is
 * available at several sizes (3840x2160 down to a few hundred pixels). Two
 * callers need different levels: the workbench background wants the sharpest
 * one, a picker thumbnail wants a small 16:9 level instead of Wallpaper
 * Engine's square `preview.jpg`.
 *
 * @returns {Array<{start:number,length:number,width:number,height:number,entry:string}>}
 */
function embeddedLevels(buf) {
  const entries = parseScenePackage(buf);
  if (!entries) return [];
  const found = [];
  for (const entry of entries) {
    // Only textures carry images; skipping the rest keeps this cheap.
    if (!entry.name.toLowerCase().endsWith(".tex")) continue;
    for (const png of findEmbeddedPngs(buf, entry)) found.push(png);
  }
  found.sort((a, b) => b.width * b.height - a.width * a.height);
  return found;
}

/**
 * One mipmap level of a scene wallpaper's artwork.
 *
 * The level closest to — but not below — `targetWidth` is preferred: it keeps
 * the drawn size sharp without handing Chromium a 33 MB full-resolution frame
 * for a 300 px thumbnail. Falls back to the largest level available.
 *
 * @param {string} dir wallpaper folder
 * @param {number} [targetWidth] wanted pixel width (default: the largest level)
 * @returns {{bytes:Buffer, width:number, height:number, levels:number}|null}
 */
function readSceneLevel(dir, targetWidth) {
  try {
    const pkg = path.join(dir, "scene.pkg");
    if (!fs.existsSync(pkg)) return null;
    const buf = fs.readFileSync(pkg);
    const levels = embeddedLevels(buf);
    if (!levels.length) return null;
    const wanted = Number(targetWidth) || 0;
    let chosen = null;
    if (wanted > 0) {
      // levels are largest-first: walk up from the smallest and stop at the
      // first one that still covers the target, so no oversized frame is used.
      for (let i = levels.length - 1; i >= 0; i -= 1) {
        if (levels[i].width >= wanted) {
          chosen = levels[i];
          break;
        }
      }
    }
    if (!chosen) chosen = levels[0];
    return {
      bytes: Buffer.from(buf.subarray(chosen.start, chosen.start + chosen.length)),
      width: chosen.width,
      height: chosen.height,
      levels: levels.length,
      // The sharpest level, so callers can report the artwork's real size.
      maxWidth: levels[0].width,
      maxHeight: levels[0].height,
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------- unpacked project folders

/** Sub-folders where an unpacked Wallpaper Engine project keeps its artwork. */
const ART_DIRS = /^(materials|images|img|textures|pictures)$/i;

/**
 * Every still image inside a project folder.
 *
 * Wallpaper Engine's built-in wallpapers (and its `web` ones) are *unpacked*:
 * there is no `scene.pkg`, the artwork sits in `materials/*.tex`, `images/` or
 * right next to `project.json`. The square `preview.*` is skipped on purpose —
 * it is exactly what this is looking for an alternative to.
 *
 * @returns {Array<{bytes?:Buffer, file?:string, width:number, height:number}>}
 */
function imageCandidates(dir) {
  const out = [];
  const visit = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 1 && ART_DIRS.test(e.name)) visit(p, depth + 1);
        continue;
      }
      if (/^preview\./i.test(e.name) || /^thumbnail\./i.test(e.name)) continue;
      if (/\.tex$/i.test(e.name)) {
        try {
          const buf = fs.readFileSync(p);
          for (const level of embeddedLevels(buf)) {
            out.push({
              bytes: Buffer.from(buf.subarray(level.start, level.start + level.length)),
              width: level.width,
              height: level.height,
            });
          }
        } catch {
          /* an unreadable texture is simply not a candidate */
        }
      } else if (IMAGE_EXT.test(e.name)) {
        const size = imageSize(p);
        if (size) out.push({ file: p, width: size.width, height: size.height });
      }
    }
  };
  visit(dir, 0);
  return out;
}

/**
 * The best still image of an unpacked project folder.
 *
 * A wallpaper fills a wide window, so a landscape picture wins over a square
 * one: candidates are scored by how close they are to 16:9, preferring those
 * that can still cover `targetWidth`. Portraits and logos only win when the
 * folder holds nothing landscape, and then null is returned instead — the
 * square preview is the more honest fallback.
 *
 * @param {string} dir project folder
 * @param {number} [targetWidth] width the caller wants to paint at
 */
function bestFolderStill(dir, targetWidth) {
  const want = 16 / 9;
  const candidates = imageCandidates(dir).filter((c) => c.width >= 320 && c.height >= 180);
  if (!candidates.length) return null;
  const score = (c) => {
    const ratio = c.width / c.height;
    if (ratio < 1.2) return 100; // portrait/square: never a wallpaper still
    return Math.abs(ratio - want) + (targetWidth && c.width < targetWidth ? 5 : 0);
  };
  candidates.sort((a, b) => score(a) - score(b) || b.width * b.height - a.width * a.height);
  const best = candidates[0];
  if (score(best) >= 100) return null;
  if (best.bytes) return { bytes: best.bytes, width: best.width, height: best.height };
  return { bytes: fs.readFileSync(best.file), width: best.width, height: best.height };
}

// --------------------------------------------------------------- stills

/**
 * Pixel size of a still image, read from its header (no decoding).
 * Supports PNG, JPEG, BMP and GIF; anything else returns null.
 *
 * The buffer form exists for the video-frame cache, which stores and validates
 * frames in memory before they ever reach the disk.
 *
 * @param {Buffer} buf
 * @returns {{width:number, height:number}|null}
 */
function imageSizeOfBuffer(buf) {
  if (!buf || buf.length < 4) return null;
  try {
    if (hasPngSignature(buf, 0) && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let cursor = 2;
      while (cursor + 9 < buf.length) {
        if (buf[cursor] !== 0xff) {
          cursor += 1;
          continue;
        }
        const marker = buf[cursor + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          cursor += 2;
          continue;
        }
        const length = buf.readUInt16BE(cursor + 2);
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          return { height: buf.readUInt16BE(cursor + 5), width: buf.readUInt16BE(cursor + 7) };
        }
        cursor += 2 + length;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pixel size of a still image on disk (reads only the header).
 * @param {string} file
 * @returns {{width:number, height:number}|null}
 */
function imageSize(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    const head = Buffer.alloc(Math.min(stat.size, 512 * 1024));
    fd = fs.openSync(file, "r");
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return imageSizeOfBuffer(head.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

module.exports = {
  IMAGE_EXT,
  VIDEO_EXT,
  bestFolderStill,
  imageSize,
  imageSizeOfBuffer,
  readSceneLevel,
};
