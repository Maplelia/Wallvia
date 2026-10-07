/**
 * codex/src/wallpaper-engine.mjs
 *
 * Read the *currently active* Wallpaper Engine wallpaper(s) so the Codex
 * desktop app can mirror your desktop background (includes the glass-wall
 * treatment). Ported from the approach verified by
 * https://github.com/Senxss19/codex-wallpaper-theme
 *
 * No dependencies: uses child_process for `reg query` and process probing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, sep, resolve } from "node:path";

/**
 * Cached config.json path.
 *
 * Resolving it shells out to powershell.exe / reg.exe, and the keeper calls
 * the resolver on every poll tick — which used to flash a console window every
 * ~1.5 s. The install location does not move while the tool runs, so the
 * resolved path is cached and only re-resolved when it stops existing.
 * @type {string|null|undefined} undefined = not resolved yet
 */
let cachedCfgPath;

/** Forget the cached config path (tests / long-running re-detection). */
export function resetWeConfigCache() {
  cachedCfgPath = undefined;
}

/**
 * Locate Wallpaper Engine's config.json.
 * Priority: WE_CONFIG env → cached → running process → Steam registry →
 * common dirs.
 * @returns {string|null} absolute path to config.json
 */
export function findWeConfig() {
  // An explicit override always wins and costs nothing to check.
  if (process.env.WE_CONFIG && existsSync(process.env.WE_CONFIG)) {
    return process.env.WE_CONFIG;
  }
  // Reuse the previous answer while it is still valid (no subprocess at all).
  if (cachedCfgPath && existsSync(cachedCfgPath)) return cachedCfgPath;

  const found = probeWeConfig();
  cachedCfgPath = found;
  return found;
}

/** The expensive part: process probe, Steam registry, common paths. */
function probeWeConfig() {
  // 1) running process dir. windowsHide matters: without it every call pops a
  //    visible console window.
  try {
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-Command",
      "(Get-Process wallpaper64,wallpaper32 -ErrorAction SilentlyContinue | Select-Object -First 1).Path",
    ], { encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
    if (out) {
      const cfg = join(dirname(out), "config.json");
      if (existsSync(cfg)) return cfg;
    }
  } catch { /* no process */ }
  // 2) Steam registry via `reg.exe`
  for (const hive of ["HKCU", "HKLM"]) {
    try {
      const line = execFileSync("reg.exe", ["query", `${hive}\\Software\\Valve\\Steam`, "/v", "SteamPath"], {
        encoding: "utf8", timeout: 15000, windowsHide: true,
      });
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(line);
      if (m) {
        const cfg = join(m[1].trim(), "steamapps", "common", "wallpaper_engine", "config.json");
        if (existsSync(cfg)) return cfg;
      }
    } catch { /* hive missing */ }
  }
  // 3) common install paths
  const homes = [
    join(process.env.ProgramFiles || "", "(x86)", "Steam", "steamapps", "common", "wallpaper_engine", "config.json"),
    join(process.env.ProgramFiles || "", "Steam", "steamapps", "common", "wallpaper_engine", "config.json"),
    join(process.env.LOCALAPPDATA || "", "Programs", "wallpaper_engine", "config.json"),
  ];
  for (const c of homes) if (existsSync(c)) return c;
  return null;
}

/** Steam app id of Wallpaper Engine: steamapps/workshop/content/<id>/<item>. */
export const WORKSHOP_APP_ID = "431960";

/** Is `p` an existing directory? (never throws) */
function dirExists(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Is `p` an existing regular file? (never throws) */
function fileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A directory that looks like a Wallpaper Engine install root. */
function isWeRoot(d) {
  return dirExists(d) && (fileExists(join(d, "config.json")) || dirExists(join(d, "projects")));
}

/**
 * The classic Steam / standalone install locations, derived from `env` so the
 * caller can inject a different environment (tests). Empty variables are
 * skipped — otherwise join("", "Steam", …) would produce a CWD-relative path.
 * @param {Record<string,string|undefined>} env
 * @returns {string[]}
 */
function weRootsFromEnv(env) {
  const out = [];
  const add = (base, ...rest) => {
    if (base) out.push(join(base, ...rest));
  };
  const tail = ["Steam", "steamapps", "common", "wallpaper_engine"];
  add(env["ProgramFiles(x86)"], ...tail);
  add(env.ProgramFiles, "(x86)", ...tail); // keeps the legacy layout working
  add(env.ProgramFiles, ...tail);
  add(env.LOCALAPPDATA, "Programs", "wallpaper_engine");
  return out;
}

/**
 * Locate the Wallpaper Engine **install root** (the directory that holds
 * config.json) — the anchor the downloaded-wallpaper listing needs, since it
 * also has to reach `<steam>/steamapps/workshop/content/431960`.
 *
 * Same priority as findWeConfig() — WE_CONFIG env → running process → Steam
 * registry → common dirs — but it never throws and returns null when nothing
 * is installed.
 *
 * @param {Record<string,string|undefined>} [env] defaults to process.env
 * @param {{system?:boolean}} [opts] `system:false` skips the powershell/reg
 *   probes (used by tests, which must not discover the developer's install)
 * @returns {string|null} absolute install root
 */
export function findWeRoot(env = process.env, opts = {}) {
  try {
    // 1) explicit override: the file's directory is the install root
    if (env.WE_CONFIG) {
      const d = dirname(env.WE_CONFIG);
      if (dirExists(d)) return resolve(d);
    }
  } catch {
    /* unreadable env value — keep looking */
  }
  // 2) the existing resolver (cached: at most one probe per process). It covers
  //    the running wallpaper64/32 process, the Steam registry and the common
  //    install dirs of the *real* process environment.
  if (opts.system !== false) {
    try {
      const cfg = findWeConfig();
      if (cfg) return dirname(cfg);
    } catch {
      /* fall through to the env-derived candidates */
    }
  }
  // 3) common dirs, derived from `env`
  for (const d of weRootsFromEnv(env)) if (isWeRoot(d)) return resolve(d);
  return null;
}

/**
 * Parse config.json → list of active wallpapers.
 *
 * The parsed result is cached per (path, mtime, size): the keeper polls this
 * every 1.5 s, and re-reading + re-parsing a ~50 KB file each tick is pure
 * waste. Wallpaper Engine rewrites config.json when you change the wallpaper,
 * so the mtime check still detects every real change.
 *
 * @returns {Array<{monitor:string, file:string}>} file is the scene.pkg or
 *   image path (absolute, native separators).
 */
export function readActiveWallpapers(cfgPath) {
  let stamp = "missing";
  try {
    const s = statSync(cfgPath);
    stamp = `${Math.round(s.mtimeMs)}-${s.size}`;
  } catch {
    /* fall through: readFileSync will throw below, as before */
  }
  if (cfgCache && cfgCache.path === cfgPath && cfgCache.stamp === stamp) return cfgCache.list;

  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const out = [];
  for (const [key, node] of Object.entries(cfg)) {
    if (key === "?installdirectory") continue;
    if (!node || typeof node !== "object") continue;
    const sw = node.general?.wallpaperconfig?.selectedwallpapers;
    if (!sw) continue;
    for (const [monitor, info] of Object.entries(sw)) {
      if (info && typeof info.file === "string" && info.file) {
        const p = info.file.split("/").join(sep);
        out.push({ monitor, file: resolve(p) });
      }
    }
  }
  cfgCache = { path: cfgPath, stamp, list: out };
  return out;
}

/** @type {{path:string, stamp:string, list:Array<{monitor:string,file:string}>}|null} */
let cfgCache = null;

/** Forget parsed-config caches (tests). */
export function resetWallpaperCache() {
  cfgCache = null;
  cachedCfgPath = undefined;
}

const IMAGE_EXT = /\.(jpe?g|png|bmp|gif|webp|tiff?)$/i;

/**
 * Resolve a wallpaper entry to a concrete image file we can base64-encode.
 * - scene.pkg / project dir → try preview.jpg / preview.png next to it
 * - video/web/gif → same (preview)
 * - image file directly → itself
 * @param {{file:string}} entry
 * @returns {string|null} absolute image path
 */
export function resolvePreviewImage(entry) {
  const f = entry.file;
  if (!f || !existsSync(f)) return null;
  const dir = dirname(f);
  // if the file is already an image, use it directly
  if (IMAGE_EXT.test(f)) return f;
  const candidates = [
    join(dir, "preview.jpg"),
    join(dir, "preview.png"),
    join(dir, "preview.jpeg"),
    join(dir, "thumbnail.jpg"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // fallback: any image in the folder (skip gifs — animated & heavy)
  try {
    if (statSync(dir).isDirectory()) {
      for (const name of readdirSync(dir)) {
        if (IMAGE_EXT.test(name) && !/\.(gif)$/i.test(name)) return join(dir, name);
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Version token for change detection (mtime+size) — lets a keeper know when
 * the wallpaper file changed without re-reading the bytes.
 * @returns {string}
 */
export function fileToken(p) {
  try {
    const s = statSync(p);
    return `${Math.round(s.mtimeMs)}-${s.size}`;
  } catch {
    return "missing";
  }
}

/** Encode an image file to a data URL (base64, mime from extension). */
export function imageToDataUrl(p) {
  const mime = mimeOf(p);
  const b64 = readFileSync(p).toString("base64");
  return `data:${mime};base64,${b64}`;
}

function mimeOf(p) {
  const b = basename(p).toLowerCase();
  if (b.endsWith(".png")) return "image/png";
  if (b.endsWith(".webp")) return "image/webp";
  if (b.endsWith(".bmp")) return "image/bmp";
  if (b.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * The first active wallpaper plus a change token — **without** reading or
 * base64-encoding the image. That work is expensive (a multi-MB data URL) and
 * is the caller's job only when the token actually changed.
 *
 * @returns {{preview:string, pkg:string, token:string, monitor:string}|null}
 */
export function currentWallpaper() {
  const cfg = findWeConfig();
  if (!cfg) return null;
  const active = readActiveWallpapers(cfg);
  if (!active.length) return null;
  const entry = active[0];
  const preview = resolvePreviewImage(entry);
  if (!preview) return null;
  return {
    pkg: entry.file,
    preview,
    monitor: entry.monitor,
    token: fileToken(preview),
  };
}

// ---- downloaded-wallpaper listing ----------------------------------------
//
// Wallpaper Engine keeps every downloaded wallpaper on disk in one of three
// places, and each one is a directory containing a project.json:
//   workshop  <steam>\steamapps\workshop\content\431960\<id>   (Steam Workshop)
//   mine      <we>\projects\myprojects\<id>                    (your own)
//   builtin   <we>\projects\defaultprojects\<id>               (shipped)
// Only the *active* wallpaper is recorded in config.json, so listing what is
// available means walking those three directories.

/** Conventional preview file names, in the order Wallpaper Engine writes them. */
const PROJECT_PREVIEW_FILES = [
  "preview.jpg",
  "preview.png",
  "preview.jpeg",
  "preview.gif",
  "thumbnail.jpg",
];

/** Display order of the three sources (also the dedup priority). */
const SOURCE_RANK = { workshop: 0, mine: 1, builtin: 2 };

/** Sub-directories of `dir` as {id, dir}; missing/unreadable → [] (never throws). */
function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => ({ id: e.name, dir: join(dir, e.name) }));
  } catch {
    return [];
  }
}

/**
 * Preview image of one project directory (absolute path, or null).
 * Order: project.json `preview` → preview.jpg → preview.png → preview.jpeg →
 * preview.gif → thumbnail.jpg → `file` itself when it is an image.
 */
function projectPreview(dir, pj) {
  if (typeof pj.preview === "string" && pj.preview.trim()) {
    const p = resolve(dir, ...pj.preview.split("/"));
    if (fileExists(p)) return p;
  }
  for (const name of PROJECT_PREVIEW_FILES) {
    const p = join(dir, name);
    if (fileExists(p)) return p;
  }
  if (typeof pj.file === "string" && pj.file.trim()) {
    const p = resolve(dir, ...pj.file.split("/"));
    if (IMAGE_EXT.test(p) && fileExists(p)) return p;
  }
  return null;
}

/**
 * Read one project directory into a listing entry.
 * Returns null when it has no project.json, no usable preview, or unreadable
 * JSON — i.e. exactly the directories that must be skipped.
 */
function readProjectDir(dir, id, source) {
  const pjPath = join(dir, "project.json");
  if (!fileExists(pjPath)) return null;
  let pj;
  try {
    pj = JSON.parse(readFileSync(pjPath, "utf8"));
  } catch {
    return null;
  }
  if (!pj || typeof pj !== "object") return null;
  const preview = projectPreview(dir, pj);
  if (!preview) return null;
  return {
    id,
    title: typeof pj.title === "string" && pj.title.trim() ? pj.title : id,
    type: typeof pj.type === "string" && pj.type.trim() ? pj.type : "unknown",
    source,
    dir,
    preview,
  };
}

/** Case-insensitive, locale-independent title ordering. */
function byTitle(a, b) {
  const ta = a.toLowerCase();
  const tb = b.toLowerCase();
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/**
 * List every wallpaper already downloaded on this machine.
 *
 * Never throws: an undetectable install, an unreadable directory or a broken
 * project.json simply contribute nothing.
 *
 * @param {{env?:Record<string,string|undefined>, system?:boolean}} [opts]
 *   `env` defaults to process.env (it must carry WE_CONFIG / ProgramFiles /
 *   LOCALAPPDATA); `system:false` skips the powershell/reg probing.
 * @returns {Array<{id:string, title:string, type:string,
 *   source:"workshop"|"mine"|"builtin", dir:string, preview:string}>}
 *   deduplicated by id, sorted workshop → mine → builtin, then by title.
 */
export function listDownloadedWallpapers(opts = {}) {
  const env = opts.env || process.env;
  const found = [];
  try {
    const root = findWeRoot(env, { system: opts.system !== false });
    if (!root) return [];
    const seen = new Set();
    const collect = (dir, id, source) => {
      if (seen.has(id)) return;
      const entry = readProjectDir(dir, id, source);
      if (!entry) return;
      seen.add(id);
      found.push(entry);
    };
    // A) Steam Workshop subscriptions
    const steam = resolve(root, "..", "..", "..");
    const workshop = join(steam, "steamapps", "workshop", "content", WORKSHOP_APP_ID);
    for (const it of subdirs(workshop)) collect(it.dir, it.id, "workshop");
    // B) your own projects
    for (const it of subdirs(join(root, "projects", "myprojects"))) collect(it.dir, it.id, "mine");
    // C) the wallpapers that ship with Wallpaper Engine
    for (const it of subdirs(join(root, "projects", "defaultprojects"))) {
      collect(it.dir, it.id, "builtin");
    }
  } catch {
    return [];
  }
  found.sort(
    (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || byTitle(a.title, b.title)
  );
  return found;
}