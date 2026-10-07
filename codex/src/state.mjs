/**
 * codex/src/state.mjs — platform-agnostic wallpaper state model.
 *
 * A wallpaper is: a data-URL image + enabled flag + fit mode + dim (darken
 * overlay) + glass strength (how translucent chat surfaces become). Position
 * (left/top) only matters for apps with a draggable FAB and is kept for
 * compatibility.
 *
 * Pure module: no DOM, no storage. Consumed by the VSCode / Obsidian / Codex
 * ports, which plug in their own storage.
 */

/**
 * The fit vocabulary offered to users: 覆盖 / 填充 / 居中.
 *   cover  → background-size: cover
 *   fill   → background-size: 100% 100%
 *   center → background-size: auto (原图尺寸,居中)
 */
export const FITS = ["cover", "fill", "center"];

/**
 * Older persisted values. They were part of FITS before the vocabulary was
 * unified, so they are still accepted when read (and still rendered) — a
 * stored "contain" / "tile" must never break a running port.
 */
export const LEGACY_FITS = ["contain", "tile"];

export const LIMITS = {
  /** Downscale long edge, keeping aspect ratio (original plugin value). */
  MAX_IMAGE_EDGE: 2000,
  /** Storage budget for the encoded data URL (~4 MB). */
  MAX_DATA_URL: 4.2 * 1024 * 1024,
  /** dim is a 0..80 % darkening overlay (original plugin value). */
  DIM_MAX: 80,
  /** strength is 0..100 % of glass (surface translucency). */
  STRENGTH_MAX: 100,
};

export function defaultState() {
  return {
    enabled: true,
    image: null, // data URL
    fit: "cover", // cover | fill | center (legacy: contain | tile)
    dim: 22,
    strength: 62,
    left: null, // FAB position (optional, per-app)
    top: null,
  };
}

/** Parse/validate a raw persisted value into a full valid state. */
export function sanitizeState(raw) {
  const s = defaultState();
  if (!raw || typeof raw !== "object") return s;
  if (typeof raw.enabled === "boolean") s.enabled = raw.enabled;
  if (typeof raw.image === "string" && raw.image.startsWith("data:")) s.image = raw.image;
  if (FITS.includes(raw.fit) || LEGACY_FITS.includes(raw.fit)) s.fit = raw.fit;
  if (typeof raw.dim === "number") s.dim = clamp(raw.dim, 0, LIMITS.DIM_MAX);
  if (typeof raw.strength === "number") s.strength = clamp(raw.strength, 0, LIMITS.STRENGTH_MAX);
  if (typeof raw.left === "number") s.left = raw.left;
  if (typeof raw.top === "number") s.top = raw.top;
  return s;
}

export function isWallpaperActive(state) {
  return !!state && !!state.image && state.enabled;
}

/** Data-URL byte-ish length → friendly size label. */
export function dataUrlBytes(uri) {
  if (!uri || typeof uri !== "string") return 0;
  const comma = uri.indexOf(",");
  const b64 = comma >= 0 ? uri.slice(comma + 1) : uri;
  // base64 → bytes (approx; whitespace-free)
  return Math.floor((b64.length * 3) / 4);
}

/** Clamp to [lo, hi]; non-finite input falls back to `lo`. */
export function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** Background-size / repeat derived from the fit mode. */
export function backdropGeometry(fit) {
  switch (fit) {
    case "fill":
      return { size: "100% 100%", repeat: "no-repeat" };
    case "center":
      // 原图尺寸 + 居中 (the container centres it; see inject.mjs)
      return { size: "auto", repeat: "no-repeat" };
    case "contain": // legacy: letterboxed
      return { size: "contain", repeat: "no-repeat" };
    case "tile": // legacy: repeated at a fixed tile width
      return { size: "360px auto", repeat: "repeat" };
    case "cover":
    default:
      return { size: "cover", repeat: "no-repeat" };
  }
}

/**
 * Opacity % a surface should keep at the given glass strength.
 *
 * `floor` is the opacity that remains at *maximum* glass — a readability
 * floor, so text never floats on a fully transparent pane.
 *
 *   strength = 0    → 100 %  (opaque: no glass effect at all)
 *   strength = 100  → floor  (maximum see-through)
 *
 * NOTE: this is a deliberate correction of the original plugin. Its
 * client.js computes `min + (100 - min) * strength`, which makes the
 * "Glass / 通透度" slider behave *inversely* to its own label and to the
 * comment above its SURFACES table ("surface share while glass is maxed"):
 * at 100 % the surfaces became fully opaque. The ports use the intended
 * direction instead.
 */
export function surfaceShare(strength, floor) {
  const t = clamp(strength, 0, LIMITS.STRENGTH_MAX) / 100;
  return 100 - (100 - floor) * t;
}