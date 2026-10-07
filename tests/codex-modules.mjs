// tests/codex-modules.mjs — validate the Codex port's logic:
// Wallpaper Engine config reading, source caching, and the injected CSS.
//
// Run: node tests/codex-modules.mjs
// Uses a fixture WE config, so Wallpaper Engine need not be installed.
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readActiveWallpapers,
  resolvePreviewImage,
  fileToken,
  currentWallpaper,
  findWeConfig,
  resetWallpaperCache,
} from "../codex/src/wallpaper-engine.mjs";
import { buildInjectJs, buildSkinCss } from "../codex/src/inject.mjs";
import { resolveWallpaperSource, resetCache } from "../codex/src/settings.mjs";

const dir = mkdtempSync(join(tmpdir(), "wallvia-test-"));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

try {
  // ---- fixture: a Wallpaper Engine config.json + a wallpaper folder -------
  const weDir = join(dir, "wallpaper_engine");
  const wpDir = join(dir, "workshop", "431960", "1234567890");
  mkdirSync(weDir, { recursive: true });
  mkdirSync(wpDir, { recursive: true });
  writeFileSync(join(wpDir, "preview.jpg"), png);
  // A real scene.pkg sits next to preview.jpg; the reader requires the entry
  // path to exist before it looks for the preview image.
  writeFileSync(join(wpDir, "scene.pkg"), Buffer.from("pkg"));

  const cfgPath = join(weDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        "?installdirectory": "D:/Steam/steamapps/common/wallpaper_engine",
        Administrator: {
          general: {
            wallpaperconfig: {
              selectedwallpapers: { Monitor0: { file: join(wpDir, "scene.pkg") } },
            },
          },
        },
      },
      null,
      "\t"
    )
  );

  // ---- WE config parsing -------------------------------------------------
  const active = readActiveWallpapers(cfgPath);
  assert.equal(active.length, 1, "one active wallpaper");
  assert.equal(active[0].monitor, "Monitor0", "monitor id");
  assert.ok(active[0].file.endsWith("scene.pkg"), "scene.pkg path");

  // the parse is cached by (path, mtime, size) — a real change must still be
  // picked up (the keeper polls this every 1.5 s)
  const cachedAgain = readActiveWallpapers(cfgPath);
  assert.equal(cachedAgain, active, "unchanged config reuses the cached parse");
  const otherDir = join(dir, "workshop", "431960", "9999999999");
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, "preview.jpg"), png);
  writeFileSync(join(otherDir, "scene.pkg"), Buffer.from("pkg"));
  writeFileSync(
    cfgPath,
    JSON.stringify({
      "?installdirectory": "D:/Steam/steamapps/common/wallpaper_engine",
      Administrator: {
        general: {
          wallpaperconfig: {
            selectedwallpapers: { Monitor0: { file: join(otherDir, "scene.pkg") } },
          },
        },
      },
    })
  );
  const changed = readActiveWallpapers(cfgPath);
  assert.notEqual(changed, cachedAgain, "changed config invalidates the cache");
  assert.ok(changed[0].file.endsWith("9999999999\\scene.pkg"), "re-read the new wallpaper");

  // put the original back so the rest of the test sees the known fixture
  writeFileSync(
    cfgPath,
    JSON.stringify({
      "?installdirectory": "D:/Steam/steamapps/common/wallpaper_engine",
      Administrator: {
        general: {
          wallpaperconfig: {
            selectedwallpapers: { Monitor0: { file: join(wpDir, "scene.pkg") } },
          },
        },
      },
    })
  );

  const preview = resolvePreviewImage({ file: join(wpDir, "scene.pkg") });
  assert.ok(preview && preview.endsWith("preview.jpg"), "preview resolved from the scene dir");
  assert.equal(
    resolvePreviewImage({ file: join(dir, "nope", "scene.pkg") }),
    null,
    "missing entry path → null"
  );

  // ---- currentWallpaper() must stay cheap --------------------------------
  // It used to base64-encode the whole image on every call, so the keeper
  // re-encoded a multi-MB wallpaper every 1.5 s. Encoding is now the caller's
  // job (settings.mjs), done only when the token changes.
  process.env.WE_CONFIG = cfgPath;
  resetWallpaperCache();
  const wp = currentWallpaper();
  assert.ok(wp && wp.preview.endsWith("preview.jpg"), "currentWallpaper resolves the preview");
  assert.match(wp.token, /^\d+-\d+$/, "currentWallpaper exposes the change token");
  assert.ok(!("dataUrl" in wp), "currentWallpaper does NOT encode the image");
  // same path + same environment is answered from the cache
  assert.equal(findWeConfig(), cfgPath, "config path resolves");
  assert.equal(currentWallpaper().preview, wp.preview, "repeat resolution is stable");
  delete process.env.WE_CONFIG;

  const token = fileToken(preview);
  assert.match(token, /^\d+-\d+$/, "file token is mtime-size");
  assert.equal(fileToken(join(dir, "missing.png")), "missing", "missing file token");

  // ---- source resolution + caching ---------------------------------------
  resetCache();
  const first = resolveWallpaperSource({ image: preview });
  assert.ok(first && first.dataUrl.startsWith("data:image/"), "fixed image encoded");
  assert.equal(first.kind, "image", "fixed image wins");
  const second = resolveWallpaperSource({ image: preview });
  assert.equal(first, second, "unchanged file → cached object reused (no re-encode)");

  // change mtime → token changes → re-encode
  const future = new Date(Date.now() + 5000);
  utimesSync(preview, future, future);
  const third = resolveWallpaperSource({ image: preview });
  assert.notEqual(first, third, "changed file → re-encoded");
  assert.notEqual(first.token, third.token, "token reflects the change");

  resetCache();
  const fourth = resolveWallpaperSource({ image: preview });
  assert.notEqual(third, fourth, "resetCache forces a fresh resolution");

  // ---- injected CSS ------------------------------------------------------
  const dataUrl = "data:image/png;base64,AAAA";
  const css = buildSkinCss(dataUrl, { dim: 30, glass: 100, fit: "contain" });
  assert.ok(css.includes("data:image/png;base64,AAAA"), "image inlined as data URL");
  assert.ok(css.includes("rgba(8,10,18,0.300)"), "dim honored");
  assert.ok(css.includes("background-size:contain"), "fit from the shared core");
  assert.ok(!css.includes("file://"), "never uses file:// (the renderer blocks it)");

  // panes: substring selectors (this build uses bg-surface-secondary etc.),
  // theme-branched rgba, and NO dependency on app variables that may not exist
  assert.ok(css.includes('[class*="bg-surface"]'), "panel selector is substring-based");
  assert.ok(css.includes('[class*="MainContentSurface"]'), "chat body selector");
  assert.ok(css.includes('[class*="ComposerLayoutBody"]'), "composer selector");
  assert.ok(css.includes("html[data-theme=light]"), "light theme branch present");
  assert.ok(css.includes("rgba(20,20,20,"), "dark pane colour");
  assert.ok(css.includes("rgba(250,250,250,"), "light pane colour");
  assert.ok(!/var\(--color-surface\)/.test(css), "must not use vars this build lacks");
  // floors at max glass: panels 62 %, chat body 52 %
  assert.ok(css.includes("rgba(20,20,20,0.620)"), "panel alpha at max glass");
  assert.ok(css.includes("rgba(20,20,20,0.520)"), "chat body alpha at max glass");

  // the default glass (75) must be clearly see-through, not near-opaque:
  // panels = 100 - 38 * 0.75 = 71.5 %
  const defaultCss = buildSkinCss(dataUrl, {});
  assert.ok(defaultCss.includes("rgba(20,20,20,0.715)"), "default glass gives ~0.72 panels");

  // clamping comes from codex/src/state.mjs
  const clamped = buildSkinCss(dataUrl, { dim: 999, glass: -5 });
  assert.ok(clamped.includes("rgba(8,10,18,0.800)"), "dim clamped to 80 (shared LIMITS)");
  assert.ok(clamped.includes("rgba(20,20,20,1.000)"), "glass at 0 → fully opaque panes");

  const js = buildInjectJs(dataUrl, { dim: 22, glass: 62 }, "tok-1");
  assert.ok(js.includes("wallvia-skin"), "style element id");
  assert.ok(js.includes("dataset.wallviaVersion"), "version guard for idempotency");
  assert.ok(js.includes("tok-1"), "version token embedded");
  assert.ok(js.trim().startsWith("(() => {"), "wrapped in an IIFE");
  // the CSS must be safely embedded as a JS string literal
  assert.ok(js.includes(JSON.stringify(buildSkinCss(dataUrl, { dim: 22, glass: 62 }))), "css embedded via JSON.stringify");

  console.log("CODEX MODULE TESTS PASSED");
  console.log("  WE config parsing, preview resolution, source caching,");
  console.log("  shared-core clamping, injected CSS — all verified.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
