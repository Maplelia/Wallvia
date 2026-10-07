/**
 * @fileoverview Video wallpaper frames: where they are cached and how they are
 * validated (VS Code side).
 *
 * Ported from the Obsidian plugin's `wallpaper-engine.ts` frame cache so both
 * platforms behave identically — including the cache *location*: frames land in
 * `<system temp>/wallvia-stills/<hash>.jpg`, keyed by
 * `path | size | mtime | frameWidth`, so
 *
 *   - a re-subscribed or updated workshop item re-decodes instead of serving a
 *     frame of the old video, and
 *   - a card frame (960 px) and a wallpaper frame (the video's own width) are
 *     two entries rather than one downgrading the other.
 *
 * Because the key and the directory match the Obsidian side exactly, the two
 * apps share the same cache: whichever one decoded a width first, the other
 * reuses it.
 *
 * The decode itself happens in the host's own Chromium (the picker's webview) —
 * see `extension.js`'s `requestFrame()`. This module is the Node half: it stores
 * what the renderer produced and reads it back. No external binary is involved,
 * which is the whole point of doing it this way.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { imageSizeOfBuffer } = require("./still-image");

/**
 * Frame width for a picker card — the same value the Obsidian side uses.
 *
 * Without a cap a card is drawn at 960 px, which is already 4.5x its CSS width
 * on a 2x display. `maxImageWidth` raises it: someone who set 2560 because their
 * screen is huge and their videos are 4K wants the card sharp too, and the
 * decode never upscales, so a cap above the video's own width costs nothing.
 * The width is part of the cache key, so raising it decodes a new frame instead
 * of quietly reusing the small one.
 */
const CARD_FRAME_WIDTH = 960;
/** Upper bound when a frame becomes the wallpaper itself. */
const APPLY_FRAME_MAX_WIDTH = 2560;
/**
 * Smallest payload that can hold a real picture. A header-only JPEG (SOI, SOF0,
 * EOI — 23 bytes, which a failed canvas encode produces) parses just fine and
 * would otherwise be cached and served as a blank "frame" forever.
 */
const MIN_FRAME_BYTES = 256;

const STILLS_DIR = "wallvia-stills";

/**
 * Where frames are cached: `<temp>/wallvia-stills`, placed by the same key
 * scheme the Obsidian plugin uses, so the two apps share the folder and reuse
 * each other's frames.
 *
 * `WALLVIA_STILLS_DIR` overrides the base directory. The tests set it so a test
 * frame can never be mistaken for one of the user's.
 */
function stillsDir() {
  const override = process.env.WALLVIA_STILLS_DIR;
  return override && override.trim() ? override : path.join(os.tmpdir(), STILLS_DIR);
}

/** Card frame width: 960 by default, raised by a user cap that asks for more. */
function frameWidthForCard(cap) {
  const max = Math.max(0, Number(cap) || 0);
  return max > 0 ? max : CARD_FRAME_WIDTH;
}

/** Wallpaper frame width: the video's own width, capped, never upscaled later. */
function frameWidthForApply(cap, nativeWidth) {
  const max = Math.max(0, Number(cap) || 0);
  if (max > 0) return max;
  return Math.min(Math.max(0, Number(nativeWidth) || 0) || APPLY_FRAME_MAX_WIDTH, APPLY_FRAME_MAX_WIDTH);
}

/** Stable, dependency-free key for a cache file name (djb2, like the Obsidian side). */
function pathHash(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

/** Where one video's frame of one width lives, or null when the video is gone. */
function frameCacheFile(video, width) {
  try {
    const stat = fs.statSync(video);
    const dir = stillsDir();
    fs.mkdirSync(dir, { recursive: true });
    const key = video + "|" + stat.size + "|" + Math.floor(stat.mtimeMs) + "|" + (Number(width) || 0);
    return path.join(dir, pathHash(key) + ".jpg");
  } catch {
    return null;
  }
}

/** The frame decoded earlier for this exact file and width, or null. */
function readVideoFrame(video, width) {
  const file = frameCacheFile(video, width);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const bytes = fs.readFileSync(file);
    const size = imageSizeOfBuffer(bytes);
    if (!size || bytes.length < MIN_FRAME_BYTES) {
      // A truncated frame (or one left behind by an interrupted write) must not
      // be served: drop it so the next open decodes a fresh one.
      try {
        fs.unlinkSync(file);
      } catch {
        /* best effort */
      }
      return null;
    }
    return { file, bytes, width: size.width, height: size.height, ext: "jpg" };
  } catch {
    return null;
  }
}

/**
 * Store a frame the renderer decoded.
 * @param {string} video absolute path of the source video
 * @param {string} base64Jpeg JPEG payload (no `data:` prefix)
 * @param {number} width the frame width the renderer was asked for
 * @returns {{file:string, bytes:Buffer, width:number, height:number, ext:string}|null}
 */
function writeVideoFrame(video, base64Jpeg, width) {
  if (!base64Jpeg) return null;
  const file = frameCacheFile(video, width);
  if (!file) return null;
  let bytes;
  try {
    bytes = Buffer.from(base64Jpeg, "base64");
  } catch {
    return null;
  }
  const size = imageSizeOfBuffer(bytes);
  if (!size || bytes.length < MIN_FRAME_BYTES) return null;
  try {
    fs.writeFileSync(file, bytes);
  } catch {
    return null;
  }
  return { file, bytes, width: size.width, height: size.height, ext: "jpg" };
}

module.exports = {
  STILLS_DIR,
  frameCacheFile,
  frameWidthForApply,
  frameWidthForCard,
  readVideoFrame,
  stillsDir,
  writeVideoFrame,
};
