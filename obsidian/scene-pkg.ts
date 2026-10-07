/**
 * Wallpaper Engine scene packages.
 *
 * A scene wallpaper ships `scene.pkg`, an **uncompressed** container holding the
 * scene JSON and its `.tex` textures. Those textures usually wrap a plain,
 * full-resolution PNG — the wallpaper's actual artwork — while the workshop item
 * only ships a small `preview.jpg` (801x801 and 1024x1024 on this machine, so a
 * 2560-wide window upscales a thumbnail 3x). Reading the PNG straight out of the
 * package is what makes the background sharp, and the bytes are copied verbatim
 * so nothing is recompressed.
 *
 * Layout, confirmed against real packages:
 *
 *   [u32 8]["PKGV0022"][u32 fileCount]
 *   per entry: [u32 nameLen][name][u32 dataOffset][u32 dataLength]
 *
 * Entry offsets are relative to the data section, which starts immediately after
 * the table. The table and the PNG chunk headers are read with DataView (no
 * bitwise arithmetic), and this module is pure — no Node imports — so it stays
 * safe in the mobile bundle even though only the desktop can reach it.
 */

export interface ScenePackageEntry {
  name: string;
  /** Absolute byte offset of the entry's data inside the package. */
  offset: number;
  length: number;
}

export interface EmbeddedPng {
  /** Absolute byte offset of the PNG inside the package. */
  start: number;
  /** Exact byte length: the walk stops on IEND, so the slice is a valid file. */
  length: number;
  width: number;
  height: number;
  /** Name of the package entry the image came from. */
  entry: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_ENTRIES = 4096;
const MAX_NAME_LENGTH = 512;
const MIN_IMAGE_SIDE = 8;
const MAX_IMAGE_SIDE = 32768;
const MAX_CHUNKS = 500000;

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function hasPngSignature(bytes: Uint8Array, at: number): boolean {
  if (at + PNG_SIGNATURE.length > bytes.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[at + i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/** True when this looks like a Wallpaper Engine scene/package container. */
export function isScenePackage(bytes: Uint8Array): boolean {
  return bytes.length > 16 && readAscii(bytes, 4, 4) === "PKGV";
}

/**
 * Read the package's file table. Returns null when the bytes are not a package
 * or the table is inconsistent — callers fall back to the preview image.
 */
export function parseScenePackage(bytes: Uint8Array): ScenePackageEntry[] | null {
  if (!isScenePackage(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(12, true);
  if (count <= 0 || count > MAX_ENTRIES) return null;
  let cursor = 16;
  const raw: { name: string; relative: number; length: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor + 4 > bytes.length) return null;
    const nameLength = view.getUint32(cursor, true);
    cursor += 4;
    if (nameLength <= 0 || nameLength > MAX_NAME_LENGTH || cursor + nameLength + 8 > bytes.length) return null;
    const name = readAscii(bytes, cursor, nameLength);
    cursor += nameLength;
    const relative = view.getUint32(cursor, true);
    const length = view.getUint32(cursor + 4, true);
    cursor += 8;
    raw.push({ name, relative, length });
  }
  const dataStart = cursor;
  const entries: ScenePackageEntry[] = [];
  for (const item of raw) {
    const offset = dataStart + item.relative;
    if (offset + item.length > bytes.length) return null;
    entries.push({ name: item.name, offset, length: item.length });
  }
  return entries;
}

/**
 * Walk the PNG chunks that start at `at`, so the returned length is exactly one
 * complete image (a naive "until the next signature" slice truncates it: the
 * compressed data contains byte sequences that look like other signatures).
 */
function readPngAt(bytes: Uint8Array, at: number, limit: number): EmbeddedPng | null {
  if (!hasPngSignature(bytes, at)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = at + PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk += 1) {
    if (cursor + 8 > bytes.length || cursor + 8 > limit) return null;
    const length = view.getUint32(cursor, false);
    const type = readAscii(bytes, cursor + 4, 4);
    if (chunk === 0) {
      if (type !== "IHDR" || length < 13) return null;
      width = view.getUint32(cursor + 8, false);
      height = view.getUint32(cursor + 12, false);
      if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) return null;
      if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return null;
    } else if (!/^[A-Za-z]{4}$/.test(type)) {
      return null;
    }
    cursor += 12 + length;
    if (type === "IEND") {
      return { start: at, length: cursor - at, width, height, entry: "" };
    }
  }
  return null;
}

/** Every complete PNG inside one package entry (a texture's mipmap chain). */
export function findEmbeddedPngs(bytes: Uint8Array, entry: ScenePackageEntry): EmbeddedPng[] {
  const limit = Math.min(entry.offset + entry.length, bytes.length);
  const found: EmbeddedPng[] = [];
  let from = entry.offset;
  while (from < limit) {
    const at = findSignature(bytes, from, limit);
    if (at < 0) break;
    const png = readPngAt(bytes, at, limit);
    if (png) found.push({ ...png, entry: entry.name });
    from = at + PNG_SIGNATURE.length;
  }
  return found;
}

/** Linear search for the PNG signature inside a bounded range. */
function findSignature(bytes: Uint8Array, from: number, to: number): number {
  const end = Math.min(to, bytes.length);
  for (let i = from; i + PNG_SIGNATURE.length <= end; i += 1) {
    if (hasPngSignature(bytes, i)) return i;
  }
  return -1;
}

/**
 * Every embedded PNG of the package, largest first.
 *
 * A `.tex` stores a **mipmap chain**, so the same artwork is available at
 * several sizes (3840x2160 down to a few hundred pixels). Two callers want
 * different levels: the workspace background wants the sharpest one, while a
 * picker thumbnail wants a small landscape level — that is how the cards show
 * the artwork's own 16:9 shape instead of Wallpaper Engine's square preview.
 */
export function embeddedPngLevels(bytes: Uint8Array): EmbeddedPng[] {
  const entries = parseScenePackage(bytes);
  if (!entries) return [];
  const found: EmbeddedPng[] = [];
  for (const entry of entries) {
    // Only textures carry images; the JSON entries are a cheap skip.
    if (!entry.name.toLowerCase().endsWith(".tex")) continue;
    for (const png of findEmbeddedPngs(bytes, entry)) found.push(png);
  }
  found.sort((a, b) => b.width * b.height - a.width * a.height);
  return found;
}
