/**
 * obsidian/mp4.ts — video track size out of an MP4/MOV container.
 *
 * Pure byte work with no imports, like `scene-pkg.ts`: the file I/O lives in
 * `wallpaper-engine.ts`, and this half can be unit-tested on buffers.
 *
 * Why it exists: Wallpaper Engine video wallpapers are painted from a still
 * (`preview.gif` is 192x192 on this machine), and the still is the only thing
 * Obsidian can display. The container is the only place that says the video
 * itself is 3840x2160, and the picker shows that next to the still so the
 * difference in sharpness is not a mystery.
 *
 * ffmpeg would also answer this, but the answer is in a header: `moov` holds
 * one `trak` per track and each `trak`'s `tkhd` carries the display size as
 * 16.16 fixed point.
 */

export interface Mp4Size {
  width: number;
  height: number;
}

/** Videos are never larger than this; anything above it is a mis-read. */
const MAX_VIDEO_EDGE = 16384;

/**
 * Display size of the largest video track in `bytes`, or `null`.
 *
 * `bytes` may be a window from anywhere in the file: `moov` is located by its
 * box tag, so a window that starts mid-file is fine as long as the whole
 * `moov` is inside it.
 */
export function findVideoTrackSize(bytes: Uint8Array): Mp4Size | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 4; i + 8 <= bytes.length; i += 1) {
    // "moov"
    if (bytes[i] !== 0x6d || bytes[i + 1] !== 0x6f || bytes[i + 2] !== 0x6f || bytes[i + 3] !== 0x76) {
      continue;
    }
    const start = i - 4;
    const end = start + view.getUint32(start);
    if (end > bytes.length || end - start < 8) continue;
    // Walk the box tree rather than scanning for the `tkhd` tag: a byte scan
    // also matches `mdat` payload, and one real file on this machine reported
    // 30307x13873 that way.
    const size = walkForTkhd(view, bytes, i + 4, end);
    if (size) return size;
  }
  return null;
}

/** Depth-first walk of `[from, to)` keeping the largest sane `tkhd`. */
function walkForTkhd(
  view: DataView,
  bytes: Uint8Array,
  from: number,
  to: number
): Mp4Size | null {
  let best: Mp4Size | null = null;
  let at = from;
  while (at + 8 <= to) {
    const size = view.getUint32(at);
    if (size < 8) break;
    const next = at + size;
    if (next > to) break;
    const tag = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const found =
      tag === "trak"
        ? walkForTkhd(view, bytes, at + 8, next)
        : tag === "tkhd"
          ? readTkhd(view, bytes, at, size)
          : null;
    if (found && (!best || found.width * found.height > best.width * best.height)) best = found;
    at = next;
  }
  return best;
}

/** `tkhd` is 92 bytes (version 0) or 104 (version 1); extra data is tolerated. */
function readTkhd(
  view: DataView,
  bytes: Uint8Array,
  box: number,
  size: number
): Mp4Size | null {
  const version = bytes[box + 8];
  const want = version === 1 ? 104 : 92;
  if (size < want || box + want > bytes.length) return null;
  const at = version === 1 ? box + 96 : box + 84;
  // 16.16 fixed point.
  const width = view.getUint32(at) >>> 16;
  const height = view.getUint32(at + 4) >>> 16;
  if (width < 16 || height < 16) return null;
  if (width > MAX_VIDEO_EDGE || height > MAX_VIDEO_EDGE) return null;
  return { width, height };
}
