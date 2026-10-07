/**
 * codex/src/settings.mjs — persisted settings + wallpaper source resolution,
 * shared by the CLI and the keeper so both agree on which image is active.
 *
 * Precedence: an explicitly configured fixed image wins over the live
 * Wallpaper Engine wallpaper. `clearSettings(["image"])` (i.e. `wallvia
 * follow`) removes it again.
 *
 * The resolved data URL is cached per (path, mtime, size) token. Without that
 * cache the keeper — which polls every 1.5s — would re-read and base64-encode
 * a multi-megabyte image on every tick even though nothing had changed.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { currentWallpaper, imageToDataUrl, fileToken } from "./wallpaper-engine.mjs";

export const DATA_DIR = join(homedir(), ".wallvia");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const KEEPER_PID = join(DATA_DIR, "keeper.pid");

export function loadSettings() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

/**
 * Remove keys from the persisted settings — `saveSettings` can only merge, and
 * `follow` has to *drop* `image` (the "fixed wallpaper" flag) while leaving
 * dim / glass / fit untouched.
 * @param {string[]} keys
 * @returns {object} the settings after removal
 */
export function clearSettings(keys) {
  const next = loadSettings();
  for (const k of keys) delete next[k];
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** @type {{token:string, dataUrl:string, kind:string}|null} */
let cache = null;

/**
 * Resolve the wallpaper to inject, reusing the cached data URL while the
 * source file's mtime/size token is unchanged.
 *
 * @param {object} [settings] defaults to the persisted settings
 * @returns {{dataUrl:string, token:string, kind:"image"|"wallpaper-engine",
 *            pkg?:string, preview?:string}|null}
 */
export function resolveWallpaperSource(settings) {
  const cfg = settings || loadSettings();

  // 1) a fixed image wins
  if (cfg.image && existsSync(cfg.image)) {
    const token = `img:${cfg.image}:${fileToken(cfg.image)}`;
    if (cache && cache.token === token) return cache;
    cache = { dataUrl: imageToDataUrl(cfg.image), token, kind: "image", preview: cfg.image };
    return cache;
  }

  // 2) otherwise the live Wallpaper Engine wallpaper.
  //    currentWallpaper() is cheap (cached config path + cached parse + stat)
  //    and deliberately does NOT encode the image, so the expensive base64
  //    step below only runs when the token actually changed.
  const wp = currentWallpaper();
  if (!wp) return null;
  const token = `we:${wp.preview}:${wp.token}`;
  if (cache && cache.token === token) return cache;
  cache = {
    dataUrl: imageToDataUrl(wp.preview),
    token,
    kind: "wallpaper-engine",
    pkg: wp.pkg,
    preview: wp.preview,
  };
  return cache;
}

/** Drop the cached data URL (used by tests). */
export function resetCache() {
  cache = null;
}
