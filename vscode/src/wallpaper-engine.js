/**
 * @fileoverview Wallvia — Wallpaper Engine discovery (VS Code side).
 *
 * Finds the local Wallpaper Engine installation, lists every wallpaper the
 * user has downloaded (Steam Workshop subscriptions, own projects, built-in
 * ones) and tells us which one is currently active — so the extension can
 * offer "choose one of my Wallpaper Engine wallpapers" instead of only a file
 * dialog.
 *
 * The page-time image is always the wallpaper's *preview* frame: a scene
 * (`.pkg`) or video wallpaper has no still image of its own, and VS Code can
 * only paint a static background. That matches what the Codex/CLI port does.
 *
 * Zero dependencies beyond node builtins; nothing here throws — when Wallpaper
 * Engine is absent every function degrades to null / [].
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** Steam application id of Wallpaper Engine (workshop content folder name). */
const WORKSHOP_APP_ID = "431960";

const IMAGE_EXT = /\.(jpe?g|png|bmp|gif|webp|tiff?)$/i;
/** Preview file names, in the order they should be preferred. */
const PREVIEW_NAMES = ["preview.jpg", "preview.png", "preview.jpeg", "preview.gif", "thumbnail.jpg"];

/** Sort weight per source: subscriptions first, built-ins last. */
const SOURCE_ORDER = { workshop: 0, mine: 1, builtin: 2 };

/** @type {string|null|undefined} undefined = not resolved yet, null = not found */
let rootCache;
/** @type {{at:number,list:Array<object>}|null} */
let listCache = null;
/** The list is re-scanned after this long, so a new subscription shows up. */
const LIST_TTL_MS = 3000;

// ------------------------------------------------------------------- root

/**
 * The Wallpaper Engine install directory, or null.
 * Probed once per process: WE_CONFIG → running process → Steam registry →
 * well-known install dirs.
 * @returns {string|null}
 */
function weRoot() {
  if (rootCache !== undefined) return rootCache;
  rootCache = probeWeRoot();
  return rootCache;
}

/** @returns {string|null} the expensive part, called once */
function probeWeRoot() {
  // 1) explicit override: point this at a config.json (tests, odd installs)
  const override = process.env.WE_CONFIG;
  if (override && fs.existsSync(override)) return path.dirname(override);

  // 2) the running process knows where it lives. windowsHide matters: without
  //    it every probe flashes a console window.
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-Process wallpaper64,wallpaper32 -ErrorAction SilentlyContinue | Select-Object -First 1).Path",
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true }
    ).trim();
    if (out) {
      const dir = path.dirname(out);
      if (fs.existsSync(dir)) return dir;
    }
  } catch {
    /* not running / powershell unavailable */
  }

  // 3) Steam's own record of where it is installed
  const steam = readSteamPath();
  if (steam) {
    const dir = path.join(steam, "steamapps", "common", "wallpaper_engine");
    if (fs.existsSync(dir)) return dir;
  }

  // 4) default install locations
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] || "", "Steam", "steamapps", "common", "wallpaper_engine"),
    path.join(process.env.ProgramFiles || "", "Steam", "steamapps", "common", "wallpaper_engine"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "wallpaper_engine"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Steam install dir from the registry, or null. */
function readSteamPath() {
  try {
    const out = execFileSync("reg.exe", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    //     SteamPath    REG_SZ    D:/Steam
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (!m) return null;
    // Steam writes forward slashes here; normalize for fs use.
    const p = m[1].trim().split("/").join(path.sep);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Steam root inferred from the install dir (…/steamapps/common/<app>). */
function steamRoot(root) {
  return path.resolve(root, "..", "..", "..");
}

// ------------------------------------------------------------ enumeration

/**
 * Every downloaded wallpaper, newest scan cached for a few seconds.
 * @param {boolean} [force] bypass the cache
 * @returns {Array<{id:string,title:string,type:string,source:string,dir:string,preview:string}>}
 */
function listDownloadedWallpapers(force) {
  const now = Date.now();
  if (!force && listCache && now - listCache.at < LIST_TTL_MS) return listCache.list;

  const root = weRoot();
  const found = [];
  if (root) {
    collect(path.join(steamRoot(root), "steamapps", "workshop", "content", WORKSHOP_APP_ID), "workshop", found);
    collect(path.join(root, "projects", "myprojects"), "mine", found);
    collect(path.join(root, "projects", "defaultprojects"), "builtin", found);
  }

  // A workshop copy and a local copy can share an id; the workshop one wins.
  const seen = new Set();
  const list = [];
  for (const w of found) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    list.push(w);
  }
  list.sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
  );

  listCache = { at: now, list };
  return list;
}

/**
 * The file that actually carries the wallpaper.
 *
 * `project.json` names the scene *description* for scene wallpapers
 * (`"file": "scene.json"`), while the artwork lives in the `scene.pkg` next to
 * it — resolving that here is what lets the caller reach the full-resolution
 * mipmaps instead of falling back to the square preview thumbnail.
 *
 * @param {string} dir wallpaper folder
 * @param {string} declared value from project.json / Wallpaper Engine config
 * @returns {string} absolute path, or "" when nothing usable is there
 */
function resolveFile(dir, declared) {
  const pkg = dir ? path.join(dir, "scene.pkg") : "";
  if (pkg && fs.existsSync(pkg)) return pkg;
  const named = declared ? path.resolve(declared.split("/").join(path.sep)) : "";
  if (named && fs.existsSync(named)) return named;
  if (dir && declared) {
    const local = path.join(dir, path.basename(declared));
    if (fs.existsSync(local)) return local;
  }
  return "";
}

/** Add every direct subdirectory of `dir` that holds a project.json. */
function collect(dir, source, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no workshop content / no projects dir
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const itemDir = path.join(dir, e.name);
    if (!fs.existsSync(path.join(itemDir, "project.json"))) continue;
    const proj = readProject(itemDir);
    if (!proj) continue;
    const preview = previewFor(itemDir, proj);
    if (!preview) continue; // nothing paintable → not useful as a background
    const declared = proj.file ? path.join(itemDir, proj.file) : "";
    const file = resolveFile(itemDir, declared) || declared;
    out.push({ id: e.name, title: proj.title, type: proj.type, source, dir: itemDir, preview, file });
  }
}

/** @returns {{title:string,type:string,preview:string,file:string}|null} */
function readProject(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "project.json"), "utf8").replace(/^\uFEFF/, "");
    const j = JSON.parse(raw);
    return {
      title: typeof j.title === "string" && j.title.trim() ? j.title.trim() : path.basename(dir),
      type: typeof j.type === "string" ? j.type : "",
      preview: typeof j.preview === "string" ? j.preview : "",
      file: typeof j.file === "string" ? j.file : "",
    };
  } catch {
    return null;
  }
}

/**
 * The still image for a wallpaper folder: the declared preview, then the
 * conventional preview names, then the wallpaper file itself when it is an
 * image.
 * @returns {string|null} absolute path
 */
function previewFor(dir, proj) {
  if (proj.preview) {
    const declared = path.join(dir, proj.preview);
    if (IMAGE_EXT.test(declared) && fs.existsSync(declared)) return declared;
  }
  for (const name of PREVIEW_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  if (proj.file && IMAGE_EXT.test(proj.file)) {
    const p = path.join(dir, proj.file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * The wallpaper(s) Wallpaper Engine is showing right now, one entry per
 * monitor. Wallpaper Engine rewrites config.json whenever the wallpaper
 * changes, so this is always current.
 * @returns {Array<{monitor:string,file:string,preview:string|null}>}
 */
function currentWallpapers() {
  const root = weRoot();
  if (!root) return [];
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const [key, node] of Object.entries(cfg)) {
    if (key === "?installdirectory") continue;
    if (!node || typeof node !== "object") continue;
    const selected = node.general && node.general.wallpaperconfig && node.general.wallpaperconfig.selectedwallpapers;
    if (!selected) continue;
    for (const [monitor, info] of Object.entries(selected)) {
      if (!info || typeof info.file !== "string" || !info.file) continue;
      const abs = path.resolve(info.file.split("/").join(path.sep));
      const dir = path.dirname(abs);
      const preview = previewFor(dir, { preview: "", file: path.basename(abs) });
      // The config names scene.pkg itself, but resolving keeps video/image
      // wallpapers and renamed packages on the same path.
      out.push({ monitor, file: resolveFile(dir, abs) || abs, dir, preview });
    }
  }
  return out;
}

/** Forget every cache (tests, or after installing Wallpaper Engine). */
function resetWeCache() {
  rootCache = undefined;
  listCache = null;
}

module.exports = {
  IMAGE_EXT,
  WORKSHOP_APP_ID,
  currentWallpapers,
  listDownloadedWallpapers,
  resetWeCache,
  resolveFile,
  weRoot,
};
