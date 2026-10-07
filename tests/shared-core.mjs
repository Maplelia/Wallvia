// tests/shared-core.mjs — unit tests for the platform-agnostic core
// (codex/src/state.mjs) — the shared core lives inside the Codex port so that
//
// Run: node tests/shared-core.mjs
import assert from "node:assert";
import {
  defaultState,
  sanitizeState,
  isWallpaperActive,
  surfaceShare,
  backdropGeometry,
  clamp,
  dataUrlBytes,
  LIMITS,
  FITS,
  LEGACY_FITS,
} from "../codex/src/state.mjs";

// ---- defaults & sanitizing ---------------------------------------------
const d = defaultState();
assert.equal(d.fit, "cover", "default fit");
assert.equal(d.enabled, true, "enabled by default");
assert.equal(d.image, null, "no image by default");
assert.deepEqual(FITS, ["cover", "fill", "center"], "fit vocabulary (覆盖/填充/居中)");
assert.deepEqual(LEGACY_FITS, ["contain", "tile"], "legacy fit values stay readable");

const s = sanitizeState({
  enabled: true,
  image: "data:image/jpeg;base64,AAAA",
  fit: "fill",
  dim: 999,
  strength: 200,
});
assert.equal(s.dim, LIMITS.DIM_MAX, "dim clamped to the max");
assert.equal(LIMITS.DIM_MAX, 80, "dim max matches the original plugin");
assert.equal(s.strength, 100, "strength clamped to 100");
assert.equal(s.fit, "fill", "valid fit preserved");
assert.ok(isWallpaperActive(s), "active with image + enabled");

// a persisted legacy value must survive (never crash, never silently reset)
assert.equal(sanitizeState({ fit: "contain" }).fit, "contain", "legacy contain preserved");
assert.equal(sanitizeState({ fit: "tile" }).fit, "tile", "legacy tile preserved");
assert.equal(sanitizeState({ fit: "center" }).fit, "center", "center accepted");

assert.equal(sanitizeState({ fit: "bogus" }).fit, "cover", "invalid fit falls back");
assert.equal(sanitizeState({ dim: NaN }).dim, 0, "NaN dim falls back to 0");
assert.equal(sanitizeState({ strength: -5 }).strength, 0, "negative strength clamps up");
assert.equal(sanitizeState(null).fit, "cover", "null → defaults");
assert.equal(sanitizeState("nope").fit, "cover", "non-object → defaults");

const disabled = sanitizeState({ image: "data:image/png;base64,AA", enabled: false });
assert.ok(!isWallpaperActive(disabled), "disabled → inactive");
assert.ok(!isWallpaperActive(sanitizeState({ image: "not-a-data-url" })), "non data: URL rejected");
assert.ok(!isWallpaperActive(sanitizeState({ image: null })), "no image → inactive");

// ---- clamp & geometry ---------------------------------------------------
assert.equal(clamp(5, 0, 3), 3, "clamp high");
assert.equal(clamp(-1, 0, 3), 0, "clamp low");
assert.equal(clamp("2", 0, 3), 2, "numeric string accepted");
assert.equal(clamp(NaN, 7, 9), 7, "NaN falls back to the low bound");
assert.equal(clamp(undefined, 7, 9), 7, "undefined falls back to the low bound");

assert.deepEqual(backdropGeometry("fill"), { size: "100% 100%", repeat: "no-repeat" });
assert.deepEqual(backdropGeometry("center"), { size: "auto", repeat: "no-repeat" });
assert.deepEqual(backdropGeometry("tile"), { size: "360px auto", repeat: "repeat" }, "legacy kept working");
assert.deepEqual(backdropGeometry("contain"), { size: "contain", repeat: "no-repeat" }, "legacy kept working");
assert.deepEqual(backdropGeometry("cover"), { size: "cover", repeat: "no-repeat" });
assert.deepEqual(backdropGeometry("unknown"), { size: "cover", repeat: "no-repeat" }, "unknown → cover");

// ---- glass translucency -------------------------------------------------
// strength 0 → opaque (no glass); strength 100 → the readability floor.
assert.equal(surfaceShare(0, 35), 100, "no glass → fully opaque");
assert.equal(surfaceShare(100, 35), 35, "max glass → the readability floor");
assert.equal(surfaceShare(50, 0), 50, "floor 0 halves at 50% strength");
assert.equal(surfaceShare(62, 88), 100 - 12 * 0.62, "interpolates linearly");
assert.equal(surfaceShare(999, 35), 35, "strength clamped to max glass");
assert.equal(surfaceShare(-5, 35), 100, "negative strength clamps to opaque");

assert.ok(dataUrlBytes("data:image/png;base64,AAAA") > 0, "data url size estimate");
assert.equal(dataUrlBytes(null), 0, "null data url = 0 bytes");

console.log("SHARED CORE TESTS PASSED");
console.log("  defaults, sanitizing/clamping (incl. NaN), fit geometry, surfaceShare — all verified.");
