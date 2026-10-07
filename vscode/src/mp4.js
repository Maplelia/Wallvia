/**
 * @fileoverview Video track size out of an MP4/MOV container (VS Code side).
 *
 * Ported from `obsidian/mp4.ts` so both platforms answer the same question the
 * same way. Why it exists: a video wallpaper ships no still of its own — only
 * Wallpaper Engine's square `preview.gif` — so the picker reports the
 * *container's* resolution next to the extracted frame, and that number has to
 * come from the file rather than from the thumbnail.
 *
 * ffmpeg would also answer it, but the answer is in a header: `moov` holds one
 * `trak` per track and each `trak`'s `tkhd` carries the display size as 16.16
 * fixed point. Scanning the bytes for the `tkhd` tag is not enough — it also
 * matches `mdat` payload (one real wallpaper reported 30307x13873 that way), so
 * the box tree is walked instead.
 *
 * Pure byte work plus one seekable read; nothing here throws.
 */
"use strict";

const fs = require("fs");

/** Videos are never larger than this; anything above it is a mis-read. */
const MAX_VIDEO_EDGE = 16384;
/** How much of each end of the file is scanned for `moov`. */
const MP4_WINDOW = 4 * 1024 * 1024;

/**
 * Display size of the largest video track in `buf`, or null.
 *
 * `buf` may be a window from anywhere in the file: `moov` is located by its box
 * tag, so a window that starts mid-file is fine as long as the whole `moov` is
 * inside it.
 *
 * @param {Buffer} buf
 * @returns {{width:number, height:number}|null}
 */
function findVideoTrackSize(buf) {
  if (!buf || buf.length < 16) return null;
  for (let i = 4; i + 8 <= buf.length; i += 1) {
    // "moov"
    if (buf[i] !== 0x6d || buf[i + 1] !== 0x6f || buf[i + 2] !== 0x6f || buf[i + 3] !== 0x76) {
      continue;
    }
    const start = i - 4;
    const end = start + buf.readUInt32BE(start);
    if (end > buf.length || end - start < 8) continue;
    const size = walkForTkhd(buf, i + 4, end);
    if (size) return size;
  }
  return null;
}

/** Depth-first walk of `[from, to)` keeping the largest sane `tkhd`. */
function walkForTkhd(buf, from, to) {
  let best = null;
  let at = from;
  while (at + 8 <= to) {
    const size = buf.readUInt32BE(at);
    if (size < 8) break;
    const next = at + size;
    if (next > to) break;
    const tag = buf.toString("latin1", at + 4, at + 8);
    const found =
      tag === "trak"
        ? walkForTkhd(buf, at + 8, next)
        : tag === "tkhd"
          ? readTkhd(buf, at, size)
          : null;
    if (found && (!best || found.width * found.height > best.width * best.height)) best = found;
    at = next;
  }
  return best;
}

/** `tkhd` is 92 bytes (version 0) or 104 (version 1); extra data is tolerated. */
function readTkhd(buf, box, size) {
  const version = buf[box + 8];
  const want = version === 1 ? 104 : 92;
  if (size < want || box + want > buf.length) return null;
  const at = version === 1 ? box + 96 : box + 84;
  // 16.16 fixed point.
  const width = buf.readUInt32BE(at) >>> 16;
  const height = buf.readUInt32BE(at + 4) >>> 16;
  if (width < 16 || height < 16) return null;
  if (width > MAX_VIDEO_EDGE || height > MAX_VIDEO_EDGE) return null;
  return { width, height };
}

/**
 * The video's own resolution, read from either end of the file (`moov` sits at
 * the start for some writers and at the end for others).
 * @param {string} file absolute path
 * @returns {{width:number, height:number}|null}
 */
function readVideoSize(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const window = Math.min(size, MP4_WINDOW);
    const head = readWindow(fd, 0, window);
    if (head) return head;
    if (size > window) return readWindow(fd, size - window, window);
    return null;
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

function readWindow(fd, position, length) {
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, position);
  return findVideoTrackSize(buf.subarray(0, read));
}

module.exports = { MAX_VIDEO_EDGE, MP4_WINDOW, findVideoTrackSize, readVideoSize };
