/**
 * obsidian/wallpaper-engine.ts
 *
 * Wallpaper Engine discovery — "which wallpapers are already downloaded on
 * this machine, and which one is active right now?"
 *
 * Desktop/Windows only. `manifest.json` intentionally keeps
 * `isDesktopOnly: false`, so this module must be harmless on mobile: **no**
 * Node built-in is imported at module scope. Every Node API is pulled in
 * lazily inside a function that is guarded by `Platform.isDesktop` and wrapped
 * in try/catch. On mobile (or wherever the require fails) the discovery
 * functions simply report "nothing found" instead of throwing.
 *
 * On-disk layout of a Steam install of Wallpaper Engine:
 *
 *   <steam>/steamapps/common/wallpaper_engine/         <- WE root
 *   <steam>/steamapps/workshop/content/431960/<id>/    <- subscribed workshop items
 *   <we>/projects/myprojects/<id>/                     <- user projects
 *   <we>/projects/defaultprojects/<id>/                <- bundled projects
 *   <we>/config.json                                   <- active wallpaper per monitor
 *
 * Every project directory carries a `project.json`; the image shown to the
 * user is a *preview* file that sits next to it (a `.pkg`/`.mp4`/`scene.json`
 * is not something the vault can display). Algorithm ported from
 * codex/src/wallpaper-engine.mjs, which was verified against a real install.
 */
import { Platform } from "obsidian";
import { embeddedPngLevels } from "./scene-pkg";
import { findVideoTrackSize } from "./mp4";

/** Steam app id of Wallpaper Engine (also the workshop folder name). */
const WORKSHOP_APP_ID = "431960";

/** Probe budget for the one PowerShell/reg.exe call, mirroring the CLI. */
const PROBE_TIMEOUT_MS = 15000;

/** Extensions we are willing to display / copy into the vault. */
const IMAGE_EXT_RE = /\.(jpe?g|png|bmp|gif|webp|tiff?)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mkv|avi|mov)$/i;

/** Preview names tried in order when `project.json.preview` is unusable. */
const PREVIEW_CANDIDATES = [
  "preview.jpg",
  "preview.png",
  "preview.jpeg",
  "preview.gif",
  "thumbnail.jpg",
];

export type WeWallpaperSource = "workshop" | "mine" | "builtin" | "external";
export type WeWallpaperType = "scene" | "video" | "web" | "application";

/** One selectable wallpaper, already resolved to a concrete preview image. */
export interface WeWallpaper {
  /** Project directory name (workshop id, or the folder name for local ones). */
  id: string;
  title: string;
  type: WeWallpaperType;
  source: WeWallpaperSource;
  /** Absolute path of the project directory. */
  dir: string;
  /** Absolute path of an existing image file (never a .pkg/.mp4/scene.json). */
  preview: string;
}

// --------------------------------------------------------------- Node bridge
//
// Minimal structural typings: the real modules are `any` to TypeScript, and
// `any` is not allowed by the repo's lint setup (no-unsafe-*, no-explicit-any).

interface BufferLike {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
}

interface DirentLike {
  name: string;
  isDirectory(): boolean;
}

interface FsLike {
  existsSync(path: string): boolean;
  readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
  readFileSync(path: string): BufferLike;
  readFileSync(path: string, encoding: string): string;
  promises: {
    readFile(path: string): Promise<BufferLike>;
    writeFile(path: string, data: BufferLike): Promise<void>;
    unlink(path: string): Promise<void>;
    stat(path: string): Promise<{ size: number; mtimeMs: number }>;
    open(path: string, flags: string): Promise<FileHandleLike>;
    mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  };
}

/** The seekable slice of `fs.promises.open` the MP4 reader needs. */
interface FileHandleLike {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

interface PathLike {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

interface ExecOptions {
  encoding: string;
  timeout: number;
  windowsHide: boolean;
  maxBuffer: number;
}

interface ChildProcessLike {
  execFile(
    file: string,
    args: readonly string[],
    options: ExecOptions,
    callback: (error: Error | null, stdout: string) => void
  ): unknown;
}

interface ProcessLike {
  env: Record<string, string | undefined>;
}

interface NodeApi {
  fs: FsLike;
  path: PathLike;
  cp: ChildProcessLike;
  proc: ProcessLike;
  os: { tmpdir(): string };
  /** Node's Buffer, so the module keeps require()-ing what it uses. */
  Buffer: { from(data: string, encoding: string): BufferLike };
}

let nodeApi: NodeApi | null | undefined;

/**
 * Lazily require the Node built-ins.
 *
 * Guarded by `Platform.isDesktop` (the community lint rules only accept a
 * Node import behind that guard) and wrapped in try/catch so a bundle loaded
 * on mobile never crashes — it just gets `null`.
 */
function loadNodeApi(): NodeApi | null {
  if (!Platform.isDesktop) return null;
  if (nodeApi !== undefined) return nodeApi;
  try {
    // `process` is required rather than used as a global: the plugin is not
    // declared desktop-only, so Node globals are off-limits in the bundle.
    //
    // require() (not import) is the point of this function: the module must be
    // loadable on mobile, where these built-ins do not exist. `no-undef` has to
    // be silenced for the same reason — ESLint does not see @types/node here.
    /* eslint-disable @typescript-eslint/no-require-imports, no-undef -- lazy, Platform.isDesktop-guarded Node built-ins; a static import would break the mobile bundle */
    const fs = require("fs") as FsLike;
    const path = require("path") as PathLike;
    const cp = require("child_process") as ChildProcessLike;
    const proc = require("process") as ProcessLike;
    const os = require("os") as { tmpdir(): string };
    const buffer = require("buffer") as { Buffer: { from(data: string, encoding: string): BufferLike } };
    /* eslint-enable @typescript-eslint/no-require-imports, no-undef -- end of the lazy Node built-in block */
    nodeApi = { fs, path, cp, proc, os, Buffer: buffer.Buffer };
  } catch {
    nodeApi = null;
  }
  return nodeApi;
}

/** True when this build can look inside Wallpaper Engine (Windows desktop). */
export function isWallpaperEngineSupported(): boolean {
  return loadNodeApi() !== null;
}

// ------------------------------------------------------------ root discovery

/** `undefined` = never probed yet, `null` = probed and not found. */
let cachedWeRoot: string | null | undefined;

/**
 * Locate the Wallpaper Engine install directory.
 *
 * Order: running process → Steam registry → well-known install paths.
 * The answer is cached for the lifetime of the renderer. Never throws.
 *
 * @returns absolute directory, or `null` when WE is not installed/not found.
 */
export async function findWeRoot(): Promise<string | null> {
  if (cachedWeRoot !== undefined) return cachedWeRoot;
  const api = loadNodeApi();
  if (!api) {
    cachedWeRoot = null;
    return null;
  }
  let found: string | null = null;
  try {
    found = await probeWeRoot(api);
  } catch {
    found = null;
  }
  cachedWeRoot = found;
  return found;
}

async function probeWeRoot(api: NodeApi): Promise<string | null> {
  // 1) A running wallpaper64.exe / wallpaper32.exe gives the exact folder.
  const out = await runCommand(api, "powershell.exe", [
    "-NoProfile",
    "-Command",
    "(Get-Process wallpaper64,wallpaper32 -ErrorAction SilentlyContinue | Select-Object -First 1).Path",
  ]);
  const firstLine = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) {
    const dir = api.path.dirname(firstLine);
    if (dir && api.fs.existsSync(dir)) return dir;
  }

  // 2) Steam's own registry entry (the path uses forward slashes there).
  const reg = await runCommand(api, "reg.exe", [
    "query",
    "HKCU\\Software\\Valve\\Steam",
    "/v",
    "SteamPath",
  ]);
  const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(reg);
  if (match) {
    const dir = api.path.join(match[1].trim(), "steamapps", "common", "wallpaper_engine");
    if (api.fs.existsSync(dir)) return dir;
  }

  // 3) Well-known install locations.
  const env = api.proc.env;
  const programFilesX86 = env["ProgramFiles(x86)"] || env["ProgramFiles"];
  const programFiles = env["ProgramFiles"];
  const localAppData = env["LOCALAPPDATA"];
  const fallbacks: string[] = [];
  if (programFilesX86) {
    fallbacks.push(api.path.join(programFilesX86, "Steam", "steamapps", "common", "wallpaper_engine"));
  }
  if (programFiles) {
    fallbacks.push(api.path.join(programFiles, "Steam", "steamapps", "common", "wallpaper_engine"));
  }
  if (localAppData) {
    fallbacks.push(api.path.join(localAppData, "Programs", "wallpaper_engine"));
  }
  for (const dir of fallbacks) {
    if (api.fs.existsSync(dir)) return dir;
  }
  return null;
}

/** Run a helper process; resolves to trimmed stdout, or "" on any failure. */
function runCommand(api: NodeApi, file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      api.cp.execFile(
        file,
        args,
        {
          encoding: "utf8",
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 1 << 20,
        },
        (error, stdout) => finish(error ? "" : stdout.trim())
      );
    } catch {
      finish("");
    }
  });
}

// ------------------------------------------------------------- enumeration

/** Read any `*.json` object (project.json, config.json) without throwing. */
function readJsonObject(api: NodeApi, path: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(api.fs.readFileSync(path, "utf8"));
    const record = asRecord(raw);
    if (record) return record;
  } catch {
    // Missing or malformed file — the caller skips this entry.
  }
  return null;
}

/** Steam root is three levels above the WE install folder. */
function steamRoot(api: NodeApi, weRoot: string): string {
  return api.path.resolve(weRoot, "..", "..", "..");
}

function workshopRoot(api: NodeApi, weRoot: string): string {
  return api.path.join(
    steamRoot(api, weRoot),
    "steamapps",
    "workshop",
    "content",
    WORKSHOP_APP_ID
  );
}

/**
 * Every downloaded wallpaper that has a usable preview image.
 *
 * workshop → user projects → bundled projects, each group sorted by title.
 * Never throws; a missing/unreadable root simply contributes nothing.
 */
export async function listWeWallpapers(): Promise<WeWallpaper[]> {
  const api = loadNodeApi();
  if (!api) return [];
  const weRoot = await findWeRoot();
  if (!weRoot) return [];
  const found: WeWallpaper[] = [];
  try {
    found.push(...scanProjects(api, workshopRoot(api, weRoot), "workshop"));
    found.push(...scanProjects(api, api.path.join(weRoot, "projects", "myprojects"), "mine"));
    found.push(...scanProjects(api, api.path.join(weRoot, "projects", "defaultprojects"), "builtin"));
  } catch {
    // Partial results are still useful; discovery must never take the UI down.
  }
  return dedupeAndSort(found);
}

function scanProjects(api: NodeApi, root: string, source: WeWallpaperSource): WeWallpaper[] {
  const out: WeWallpaper[] = [];
  let entries: DirentLike[];
  try {
    entries = api.fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // directory does not exist
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = api.path.join(root, entry.name);
    const projectPath = api.path.join(dir, "project.json");
    if (!api.fs.existsSync(projectPath)) continue;
    const project = readJsonObject(api, projectPath);
    if (!project) continue;
    const file = typeof project.file === "string" ? project.file : "";
    const declared = typeof project.preview === "string" ? project.preview : "";
    const preview = resolvePreviewImage(api, dir, declared, file);
    if (!preview) continue;
    const title = typeof project.title === "string" && project.title ? project.title : entry.name;
    out.push({
      id: entry.name,
      title,
      type: normalizeType(project.type),
      source,
      dir,
      preview,
    });
  }
  return out;
}

/**
 * Preview resolution, in order:
 *   project.json.preview (when it is an existing image) → preview.jpg →
 *   preview.png → preview.jpeg → preview.gif → thumbnail.jpg →
 *   `file` itself when it already is an image.
 */
function resolvePreviewImage(
  api: NodeApi,
  dir: string,
  declared: string,
  file: string
): string | null {
  if (declared) {
    const candidate = api.path.isAbsolute(declared) ? declared : api.path.join(dir, declared);
    if (IMAGE_EXT_RE.test(candidate) && api.fs.existsSync(candidate)) return candidate;
  }
  for (const name of PREVIEW_CANDIDATES) {
    const candidate = api.path.join(dir, name);
    if (api.fs.existsSync(candidate)) return candidate;
  }
  if (file) {
    const candidate = api.path.isAbsolute(file) ? file : api.path.join(dir, file);
    if (IMAGE_EXT_RE.test(candidate) && api.fs.existsSync(candidate)) return candidate;
    if (VIDEO_EXT_RE.test(candidate) && api.fs.existsSync(candidate)) {
      const still = api.path.join(dir, "preview.jpg");
      if (api.fs.existsSync(still)) return still;
    }
  }
  return null;
}

/**
 * Wallpaper Engine treats a missing `type` as a static scene (the bundled
 * `audiophile` / `sheep` / `techno` projects are written that way), so that is
 * the fallback here too.
 */
function normalizeType(value: unknown): WeWallpaperType {
  if (value === "scene" || value === "video" || value === "web" || value === "application") {
    return value;
  }
  return "scene";
}

const SOURCE_ORDER: Record<WeWallpaperSource, number> = {
  workshop: 0,
  mine: 1,
  builtin: 2,
  external: 3,
};

/** De-duplicate by directory name, then order by source and title. */
function dedupeAndSort(list: WeWallpaper[]): WeWallpaper[] {
  const seen = new Set<string>();
  const out: WeWallpaper[] = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out.sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  );
}

// ---------------------------------------------------------- active wallpaper

/**
 * The wallpaper(s) selected in Wallpaper Engine right now.
 *
 * One entry per monitor; the first one is "the current wallpaper".
 *
 * @param known already-enumerated list, used to reuse the correct title/type
 *              for a wallpaper that is also in the download list.
 */
export async function getCurrentWeWallpapers(known?: WeWallpaper[]): Promise<WeWallpaper[]> {
  const api = loadNodeApi();
  if (!api) return [];
  const weRoot = await findWeRoot();
  if (!weRoot) return [];
  const configPath = api.path.join(weRoot, "config.json");
  const config = readJsonObject(api, configPath);
  if (!config) return [];
  const selected = readSelectedWallpapers(config);

  const byDir = new Map<string, WeWallpaper>();
  for (const item of known ?? []) byDir.set(normalizeKey(item.dir), item);

  const out: WeWallpaper[] = [];
  const seenDirs = new Set<string>();
  for (const entry of selected) {
    // config.json stores POSIX separators regardless of the platform.
    const absolute = api.path.resolve(entry.file.split("/").join(api.path.sep));
    const dir = api.path.dirname(absolute);
    const key = normalizeKey(dir);
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);

    const matching = byDir.get(key);
    if (matching) {
      out.push(matching);
      continue;
    }
    const project = readJsonObject(api, api.path.join(dir, "project.json"));
    const preview = resolvePreviewImage(
      api,
      dir,
      project && typeof project.preview === "string" ? project.preview : "",
      absolute
    );
    if (!preview) continue;
    const name = api.path.basename(dir);
    const title = project && typeof project.title === "string" && project.title ? project.title : name;
    out.push({
      id: name,
      title,
      type: normalizeType(project ? project.type : undefined),
      source: classifySource(api, weRoot, dir),
      dir,
      preview,
    });
  }
  return out;
}

/** Skip the config's own metadata key and walk every other top-level object. */
function readSelectedWallpapers(
  config: Record<string, unknown>
): Array<{ monitor: string; file: string }> {
  const out: Array<{ monitor: string; file: string }> = [];
  for (const [key, node] of Object.entries(config)) {
    if (key === "?installdirectory") continue;
    const general = asRecord(asRecord(node)?.general);
    const wallpaperConfig = asRecord(general?.wallpaperconfig);
    const selected = asRecord(wallpaperConfig?.selectedwallpapers);
    if (!selected) continue;
    for (const [monitor, info] of Object.entries(selected)) {
      const file = asRecord(info)?.file;
      if (typeof file === "string" && file) out.push({ monitor, file });
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Which bucket a directory belongs to (used only for synthesized entries). */
function classifySource(api: NodeApi, weRoot: string, dir: string): WeWallpaperSource {
  const key = normalizeKey(dir);
  if (key.startsWith(normalizeKey(workshopRoot(api, weRoot)) + api.path.sep)) return "workshop";
  if (key.startsWith(normalizeKey(api.path.join(weRoot, "projects", "myprojects")) + api.path.sep)) {
    return "mine";
  }
  if (
    key.startsWith(normalizeKey(api.path.join(weRoot, "projects", "defaultprojects")) + api.path.sep)
  ) {
    return "builtin";
  }
  return "external";
}

function normalizeKey(dir: string): string {
  return dir.replace(/\//g, "\\").toLowerCase();
}

// ------------------------------------------------------------------- helpers

/**
 * Read an image from anywhere on disk as an ArrayBuffer.
 *
 * The vault adapter can only read inside the vault, and Wallpaper Engine's
 * previews live outside it — hence Node fs. Returns `null` when unavailable.
 *
 * Asynchronous on purpose: the picker renders a whole grid of previews, and a
 * synchronous read per card stalls the renderer while the disk catches up.
 */
export async function readImageArrayBuffer(path: string): Promise<ArrayBuffer | null> {
  const api = loadNodeApi();
  if (!api) return null;
  try {
    const buffer = await api.fs.promises.readFile(path);
    // A Node Buffer is a view into a shared pool: slice out exactly its bytes.
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  } catch {
    return null;
  }
}

/** Lowercase file extension without the dot ("" when there is none). */
export function fileExtension(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Smallest embedded artwork we are willing to prefer over the preview. */
const HIRES_MIN_WIDTH = 1920;

/**
 * Pick a mipmap level: the sharpest one, or — when `maxWidth` is set — the
 * smallest level that is still at least that wide, falling back to the largest
 * when nothing is big enough.
 *
 * Only ever selects; nothing is resampled, so the bytes copied into the vault
 * stay exactly the bytes Wallpaper Engine shipped.
 */
function pickLevel<T extends { width: number }>(levels: T[], maxWidth: number): T {
  const cap = Number(maxWidth) || 0;
  if (cap <= 0) return levels[0];
  for (let i = levels.length - 1; i >= 0; i -= 1) {
    if (levels[i].width >= cap) return levels[i];
  }
  return levels[0];
}

/**
 * The full-resolution artwork inside a scene wallpaper's `scene.pkg`.
 *
 * Wallpaper Engine ships only a small square `preview.jpg` for a scene (481-1024
 * px on the machine this was verified against), while the package carries the
 * real artwork — 3840x2160 PNGs, and 5336x4008 for a few — as an uncompressed
 * PNG inside its `.tex` textures. Rendering the preview across a wide window is
 * what made the background look low-resolution and over-compressed; the bytes
 * returned here are copied verbatim, so nothing is re-encoded.
 *
 * `maxWidth` caps which level is taken (0 = the sharpest). Returns null when
 * there is no package, when no embedded PNG is convincingly large, or when
 * anything at all goes wrong — the caller then uses the preview.
 */
export async function readSceneHiResImage(
  dir: string,
  maxWidth = 0
): Promise<WeStill | null> {
  const api = loadNodeApi();
  if (!api) return null;
  try {
    const pkg = api.path.join(dir, "scene.pkg");
    if (!api.fs.existsSync(pkg)) return null;
    const buffer = await api.fs.promises.readFile(pkg);
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const levels = embeddedPngLevels(bytes);
    if (!levels.length) return null;
    const png = pickLevel(levels, maxWidth);
    // A deliberate cap is honoured even below the "worth preferring" width; an
    // uncapped read still refuses to prefer a thumbnail-sized texture.
    if (maxWidth <= 0 && png.width < HIRES_MIN_WIDTH) return null;
    const slice = bytes.subarray(png.start, png.start + png.length);
    return {
      // Copy out of the Node Buffer's shared pool, as readImageArrayBuffer does.
      bytes: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
      ext: "png",
      width: png.width,
      height: png.height,
    };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- stills

/** A still image taken out of a wallpaper's own assets. */
export interface WeStill {
  bytes: ArrayBuffer;
  ext: string;
  width: number;
  height: number;
}

/** What one pass over a wallpaper's own assets can tell the picker. */
export interface WeStillAssets {
  /** A still sized for a card thumbnail — landscape artwork, small. */
  still: WeStill | null;
  /** The sharpest asset behind it: what the workspace background is painted from. */
  max: WeResolution | null;
}

/**
 * Card thumbnails aim at this width. Wallpaper Engine's preview still is
 * 801-1024 px *square*; a package's own mipmap chain holds the real artwork at
 * 16:9, and a ~480 px level draws a 200 px card crisply on a 2x display without
 * handing Chromium a 33 MB frame.
 */
const THUMB_TARGET_WIDTH = 480;

const stillAssetCache = new Map<string, Promise<WeStillAssets>>();

/**
 * The still a card should show, plus the resolution behind it.
 *
 * A scene wallpaper carries a whole mipmap chain, so the thumbnail is taken
 * verbatim from it — nothing is rescaled. Wallpaper Engine's own built-ins ship
 * no package at all, so their project folder is scanned instead. Both the
 * thumbnail and the resolution pill come out of this one call, which is why a
 * card costs a single read.
 *
 * `maxWidth` is an upper bound on the width of what is decoded (0 = no bound).
 * It is part of the cache key: a cap of 1920 and a cap of 0 must never read each
 * other's level.
 */
export function resolveStillAssets(dir: string, maxWidth = 0): Promise<WeStillAssets> {
  const cap = Number(maxWidth) || 0;
  const key = `${normalizeKey(dir)}|${cap}`;
  const cached = stillAssetCache.get(key);
  if (cached) return cached;
  const pending = computeStillAssets(dir, cap);
  stillAssetCache.set(key, pending);
  return pending;
}

async function computeStillAssets(dir: string, maxWidth: number): Promise<WeStillAssets> {
  const api = loadNodeApi();
  if (!api) return { still: null, max: null };
  const packed = await packageStill(api, dir, maxWidth);
  if (packed) return packed;
  // No package (Wallpaper Engine's built-in wallpapers are unpacked), so the
  // artwork — if there is any — sits loose in the project folder.
  const loose = await folderStill(api, dir, maxWidth);
  if (!loose) return { still: null, max: null };
  return { still: loose, max: { width: loose.width, height: loose.height } };
}

/** A thumbnail from `scene.pkg`'s mipmap chain, or null when it has no PNG. */
async function packageStill(
  api: NodeApi,
  dir: string,
  maxWidth: number
): Promise<WeStillAssets | null> {
  try {
    const pkg = api.path.join(dir, "scene.pkg");
    if (!api.fs.existsSync(pkg)) return null;
    const buffer = await api.fs.promises.readFile(pkg);
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const levels = embeddedPngLevels(bytes);
    if (!levels.length) return null;

    // The card wants a small landscape level; the cap only ever lowers that.
    const target = maxWidth > 0 ? Math.min(maxWidth, THUMB_TARGET_WIDTH) : THUMB_TARGET_WIDTH;
    const chosen = pickLevel(levels, target);
    const slice = bytes.subarray(chosen.start, chosen.start + chosen.length);
    return {
      still: {
        bytes: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        ext: "png",
        width: chosen.width,
        height: chosen.height,
      },
      // The sharpest level, so the resolution pill reports the real artwork.
      max: { width: levels[0].width, height: levels[0].height },
    };
  } catch {
    return null;
  }
}

/** Sub-folders where an unpacked Wallpaper Engine project keeps its artwork. */
const ART_DIRS = /^(materials|images|img|textures|pictures)$/i;
const STILL_EXT_RE = /\.(png|jpe?g|bmp|gif|webp|tiff?)$/i;
/** Thumbnails are skipped: they are the square picture this replaces. */
const PREVIEW_RE = /^(preview|thumbnail)\./i;

/**
 * A landscape still from an *unpacked* project folder.
 *
 * Wallpaper Engine's built-in wallpapers ship no `scene.pkg`: the artwork sits
 * loose in `materials/`, `images/` and friends. Candidates are scored by how
 * close they are to 16:9 and anything squarer than 1.2:1 is rejected, so a
 * portrait texture or a wide logo never wins over the actual wallpaper. Same
 * rule the VS Code port uses.
 *
 * `maxWidth` caps the chosen still; nothing is resampled, so a file wider than
 * the cap is simply not eligible once a narrower one exists.
 *
 * Standalone `.tex` files are deliberately not opened: a `.tex` is not a PKGV
 * package, so no PNG can be pulled out of one (checked against the packages on
 * this machine).
 */
async function folderStill(api: NodeApi, dir: string, maxWidth: number): Promise<WeStill | null> {
  const candidates: { file: string; width: number; height: number }[] = [];
  const visit = async (at: string, depth: number): Promise<void> => {
    let entries: DirentLike[];
    try {
      entries = api.fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = api.path.join(at, entry.name);
      if (entry.isDirectory()) {
        if (depth < 1 && ART_DIRS.test(entry.name)) await visit(full, depth + 1);
        continue;
      }
      if (PREVIEW_RE.test(entry.name) || !STILL_EXT_RE.test(entry.name)) continue;
      const size = await fileImageSize(api, full);
      if (size) candidates.push({ file: full, ...size });
    }
  };
  await visit(dir, 0);

  const target = 16 / 9;
  const cap = maxWidth > 0 ? maxWidth : Infinity;
  const usable = candidates.filter(
    (c) =>
      c.width >= MIN_STILL_WIDTH &&
      c.height >= MIN_STILL_HEIGHT &&
      c.width / c.height >= 1.2 &&
      c.width <= cap
  );
  if (!usable.length) return null;
  usable.sort(
    (a, b) => Math.abs(a.width / a.height - target) - Math.abs(b.width / b.height - target)
  );
  const best = usable[0];
  try {
    const buffer = await api.fs.promises.readFile(best.file);
    return {
      bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      ext: fileExtension(best.file) || "png",
      width: best.width,
      height: best.height,
    };
  } catch {
    return null;
  }
}

const MIN_STILL_WIDTH = 320;
const MIN_STILL_HEIGHT = 180;

/** Pixel size of a still image, from the first bytes of its header only. */
async function fileImageSize(api: NodeApi, file: string): Promise<WeResolution | null> {
  let handle: FileHandleLike | null = null;
  try {
    handle = await api.fs.promises.open(file, "r");
    const head = new Uint8Array(256 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return imageSize({ buffer: head.buffer, byteOffset: 0, byteLength: bytesRead });
  } catch {
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Best effort: a handle we only read from is allowed to fail closing.
      }
    }
  }
}

// ------------------------------------------------------------- source sizes

/** A plain pixel size. */
export interface WeResolution {
  width: number;
  height: number;
}

/** What the picker can learn about a wallpaper's real assets on disk. */
export interface WeSourceSize {
  /** Artwork inside `scene.pkg`; what a scene is painted from. */
  package?: WeResolution;
  /** The project's own video resolution (video wallpapers). */
  video?: WeResolution;
}

/**
 * Session cache, keyed by project directory + type.
 *
 * Reading a `scene.pkg` (7-10 MB on this machine) or an MP4 header is far too
 * expensive to repeat for every repaint, and the picker asks for every card, so
 * the promise itself is cached — concurrent callers share one read.
 */
const sizeCache = new Map<string, Promise<WeSourceSize>>();

/** Resolution of the assets a wallpaper would actually be painted from. */
export function resolveSourceSize(wallpaper: WeWallpaper): Promise<WeSourceSize> {
  const key = `${normalizeKey(wallpaper.dir)}|${wallpaper.type}`;
  const cached = sizeCache.get(key);
  if (cached) return cached;
  const pending = computeSourceSize(wallpaper);
  sizeCache.set(key, pending);
  return pending;
}

async function computeSourceSize(wallpaper: WeWallpaper): Promise<WeSourceSize> {
  const api = loadNodeApi();
  if (!api) return {};
  if (wallpaper.type !== "video") {
    // Cap 0: the pill reports the artwork's real resolution, not a capped one.
    const assets = await resolveStillAssets(wallpaper.dir, 0);
    return assets.max ? { package: assets.max } : {};
  }
  const file = projectFilePath(api, wallpaper.dir);
  if (!file) return {};
  const video = await readMp4Size(file);
  return video ? { video } : {};
}

/**
 * The file a project's `project.json` points at, resolved to an absolute path
 * and confirmed to exist. `null` for a missing or unreadable project.
 */
function projectFilePath(api: NodeApi, dir: string): string | null {
  const project = readJsonObject(api, api.path.join(dir, "project.json"));
  const file = project && typeof project.file === "string" ? project.file : "";
  if (!file) return null;
  const full = api.path.isAbsolute(file) ? file : api.path.join(dir, file);
  return api.fs.existsSync(full) ? full : null;
}

// ------------------------------------------------------------------- MP4

/**
 * Resolution of an MP4/MOV's video track, without ffmpeg and without decoding
 * anything.
 *
 * Wallpaper Engine ships non-faststart files, so `moov` sits at the *end*; both
 * ends of the file are tried. The parsing itself is in `mp4.ts`, which needs no
 * file system and is unit-tested on buffers.
 */
async function readMp4Size(path: string): Promise<WeResolution | null> {
  const api = loadNodeApi();
  if (!api) return null;
  let handle: FileHandleLike | null = null;
  try {
    handle = await api.fs.promises.open(path, "r");
    const { size } = await handle.stat();
    const window = Math.min(size, MP4_WINDOW);
    const head = await scanForVideoSize(handle, 0, window);
    if (head) return head;
    if (size > window) return await scanForVideoSize(handle, size - window, window);
    return null;
  } catch {
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Closing a file we are only reading is allowed to fail silently.
      }
    }
  }
}

/** How much of each end of the file is scanned for `moov`. */
const MP4_WINDOW = 4 * 1024 * 1024;

async function scanForVideoSize(
  handle: FileHandleLike,
  position: number,
  length: number
): Promise<WeResolution | null> {
  const buffer = new Uint8Array(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return findVideoTrackSize(buffer.subarray(0, bytesRead));
}

// ------------------------------------------------------------ video frames

/**
 * The video file a wallpaper is built from, or null.
 *
 * Resolved through the project's own `project.json`, so an entry whose `file`
 * points at `scene.json` (a scene) never matches.
 */
export function videoFileOf(wallpaper: WeWallpaper): string | null {
  const api = loadNodeApi();
  if (!api) return null;
  const file = projectFilePath(api, wallpaper.dir);
  return file && VIDEO_EXT_RE.test(file) ? file : null;
}

/**
 * A frame of a video wallpaper, decoded by the host's own Chromium and cached.
 *
 * A video wallpaper ships no still at all — only Wallpaper Engine's square
 * `preview.gif` (192x192 here). Every target of this plugin is Chromium, which
 * already decodes H.264/VP9, so the frame is grabbed from a hidden `<video>`
 * and a canvas in the renderer — no ffmpeg, no WASM decoder, no new dependency.
 * The renderer cannot write files, hence the two halves below.
 *
 * Frames land in the system temp folder rather than the vault: they are a
 * cache, and the vault's `Wallpapers/` folder is pruned by the picker.
 */

/**
 * Where one video's extracted frame lives; the key follows the file's identity.
 *
 * `WALLVIA_STILLS_DIR` overrides the base folder: the tests point it at their
 * own scratch directory so a synthetic test frame can never be mistaken for one
 * of the user's. In normal use the folder is `<temp>/wallvia-stills`, which the
 * VS Code extension writes to as well — same folder, same key, so the two apps
 * reuse each other's frames.
 */
async function frameCacheFile(api: NodeApi, video: string, maxWidth: number): Promise<string | null> {
  try {
    const stat = await api.fs.promises.stat(video);
    const override = api.proc.env.WALLVIA_STILLS_DIR;
    const dir =
      override && override.trim() ? override : api.path.join(api.os.tmpdir(), "wallvia-stills");
    await api.fs.promises.mkdir(dir, { recursive: true });
    // Keyed by size and mtime too, not just the path: a re-subscribed workshop
    // item must not keep serving a frame from the old video. The width is part
    // of it as well, so a capped decode never reads an uncapped one.
    const key = `${video}|${stat.size}|${Math.floor(stat.mtimeMs)}|${Number(maxWidth) || 0}`;
    return api.path.join(dir, `${pathHash(key)}.jpg`);
  } catch {
    return null;
  }
}

/**
 * The frame decoded earlier for this exact file, or null.
 *
 * A cache entry that cannot be displayed is deleted rather than served: the same
 * key would otherwise keep handing back a broken image forever.
 */
export async function readVideoFrame(video: string, maxWidth = 0): Promise<WeStill | null> {
  const api = loadNodeApi();
  if (!api) return null;
  const file = await frameCacheFile(api, video, maxWidth);
  if (!file || !api.fs.existsSync(file)) return null;
  return stillFromFile(api, file, "jpg");
}

/** Store a frame the renderer decoded, so the next open is instant. */
export async function writeVideoFrame(
  video: string,
  base64Jpeg: string,
  maxWidth = 0
): Promise<WeStill | null> {
  const api = loadNodeApi();
  if (!api || !base64Jpeg) return null;
  const file = await frameCacheFile(api, video, maxWidth);
  if (!file) return null;
  let bytes: BufferLike;
  try {
    bytes = api.Buffer.from(base64Jpeg, "base64");
  } catch {
    return null;
  }
  const still = stillFromBytes(bytes, "jpg");
  if (!still) {
    // Validate before writing, not after: a failed canvas encode produces a
    // header-only JPEG that parses but renders as nothing, and one of those sat
    // in this cache being served as a "frame" until it was found by hand.
    await discard(api, file);
    return null;
  }
  try {
    await api.fs.promises.writeFile(file, bytes);
  } catch {
    return null;
  }
  return still;
}

/**
 * Smallest payload that can hold a real picture. A header-only JPEG (SOI, SOF0,
 * EOI — 23 bytes, which a failed canvas encode produces) reads as a perfectly
 * valid 960x540 image to any header parser, so it has to be rejected by size.
 */
const MIN_FRAME_BYTES = 256;

/** A still built from an in-memory frame, or null when it is not displayable. */
function stillFromBytes(bytes: BufferLike, ext: string): WeStill | null {
  if (bytes.byteLength < MIN_FRAME_BYTES) return null;
  const size = imageSize(bytes);
  if (!size) return null;
  return {
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ext,
    width: size.width,
    height: size.height,
  };
}

/** Read a still off disk and report its header size. */
async function stillFromFile(api: NodeApi, file: string, ext: string): Promise<WeStill | null> {
  try {
    const buffer = await api.fs.promises.readFile(file);
    const still = stillFromBytes(buffer, ext);
    if (!still) await discard(api, file);
    return still;
  } catch {
    return null;
  }
}

/** Remove a frame that cannot be displayed, so the next open decodes a new one. */
async function discard(api: NodeApi, file: string): Promise<void> {
  try {
    await api.fs.promises.unlink(file);
  } catch {
    /* best effort: a file we cannot remove is simply ignored on read */
  }
}

/** Stable, dependency-free key for a cache file name. */
function pathHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

/** Pixel size of a PNG or JPEG, read from its header (no decoding). */
function imageSize(buffer: BufferLike): WeResolution | null {
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return { height: view.getUint16(at + 5, false), width: view.getUint16(at + 7, false) };
      }
      at += 2 + view.getUint16(at + 2, false);
    }
  }
  return null;
}
