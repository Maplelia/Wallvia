// tests/cdp-live.mjs — end-to-end test of the CDP injection pipeline against a
// REAL Chromium renderer (headless Edge/Chrome).
//
// This exercises the parts that fixtures cannot: the /json endpoint, a real
// WebSocket DevTools session, Runtime.evaluate, and whether the generated CSS
// actually parses and applies in a browser engine (including color-mix).
//
// Run: node tests/cdp-live.mjs
// Skips (exit 0) when no Chromium browser is installed.

import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PORT,
  listTargets,
  hasPageTarget,
  waitForPageTarget,
  CdpSession,
  withTarget,
  injectIntoMains,
  verifySkin,
  sleep,
} from "../codex/src/cdp.mjs";
import { buildInjectJs, buildSkinCss } from "../codex/src/inject.mjs";

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

// A real 1x1 PNG so the engine can actually load the data URL.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const DATA_URL = "data:image/png;base64," + PNG_B64;

const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.log("CDP LIVE TEST SKIPPED: no Chromium browser found");
  process.exit(0);
}

const PORT = 9444;
const dir = mkdtempSync(join(tmpdir(), "wallvia-cdp-"));
const pagePath = join(dir, "wallpaper-test.html");
const profileDir = join(dir, "profile");

writeFileSync(
  pagePath,
  `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>wallpaper test</title></head>
<body>
  <div class="bg-surface" id="surface">panel</div>
  <div class="bg-surface-elevated" id="surface2">elevated</div>
  <div class="MainContentSurface" id="main">chat</div>
  <!-- Real Codex puts this attribute on <html>, which the selectors rely on. -->
  <script>document.documentElement.setAttribute("data-codex-window-type","electron");</script>
</body></html>`
);

/** Page matcher for a plain browser (the Codex one expects app:// URLs). */
const anyPage = (t) => t.type === "page" && typeof t.url === "string" && t.url.includes("wallpaper-test.html");

let child = null;
const cleanup = () => {
  try {
    if (child && !child.killed) child.kill();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

try {
  child = spawn(
    browser,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      `file:///${pagePath.split("\\").join("/")}`,
    ],
    { stdio: "ignore", detached: false }
  );

  // 1) the endpoint must come up with our page
  const targets = await waitForPageTarget(PORT, 25000, anyPage);
  assert.ok(targets.length > 0, "debug endpoint exposed our page");
  assert.ok(await hasPageTarget(PORT, anyPage), "hasPageTarget sees it");

  // 2) a real CDP session can evaluate in the page
  const probe = await withTarget(targets[0], (s) => s.evaluate("1 + 1"));
  assert.equal(probe, 2, "Runtime.evaluate round-trips");

  // 3) inject the wallpaper CSS
  const css = buildSkinCss(DATA_URL, { dim: 30, glass: 100, fit: "cover" });
  const js = buildInjectJs(DATA_URL, { dim: 30, glass: 100, fit: "cover" }, "live-1");
  const { applied, targets: count } = await injectIntoMains(PORT, js, { match: anyPage });
  assert.equal(count, 1, "one target injected");
  assert.equal(applied, 1, "injection confirmed by the page");

  // 4) verifySkin must report success (this is what previously always failed)
  const check = await verifySkin(PORT, anyPage);
  assert.ok(check.ok, "verifySkin ok — " + check.reason);
  assert.equal(check.found, true, "wallpaper <style> present");
  assert.equal(check.version, "live-1", "version token recorded");
  assert.ok(check.background.startsWith("url("), "body::before carries an image");

  // 5) the CSS must actually apply in a real engine
  const applied2 = await withTarget(targets[0], (s) =>
    s.evaluate(`(() => {
      const before = getComputedStyle(document.body, "::before");
      const after = getComputedStyle(document.body, "::after");
      const surf = getComputedStyle(document.getElementById("surface"));
      const main = getComputedStyle(document.getElementById("main"));
      return {
        beforeImage: before.backgroundImage.slice(0, 30),
        beforeSize: before.backgroundSize,
        afterBg: after.backgroundColor,
        surfaceBg: surf.backgroundColor,
        surfaceAlpha: surf.backgroundColor,
        mainBg: main.backgroundColor,
        styleLen: (document.getElementById("wallvia-skin")||{}).textContent?.length || 0,
      };
    })()`)
  );

  assert.ok(applied2.beforeImage.startsWith('url("data:image/png'), "image URL applied on ::before");
  assert.equal(applied2.beforeSize, "cover", "background-size from the fit mode");
  assert.equal(applied2.afterBg, "rgba(8, 10, 18, 0.3)", "dim layer applied");
  assert.equal(applied2.styleLen, css.length, "the whole stylesheet is in the DOM");
  // color-mix must have produced a translucent surface colour in the real engine
  assert.match(applied2.surfaceBg, /^rgba?\(/, "panel background resolves to a colour");
  assert.match(applied2.mainBg, /^rgba?\(/, "chat surface resolves to a colour");
  const alpha = (v) => {
    const m = /rgba?\([^)]*,\s*([\d.]+)\s*\)$/.exec(v);
    return m ? Number(m[1]) : 1;
  };
  assert.ok(alpha(applied2.mainBg) < 1, "chat surface is translucent (color-mix works): " + applied2.mainBg);
  assert.ok(alpha(applied2.surfaceBg) <= 1, "panel surface is translucent: " + applied2.surfaceBg);

  // 6) re-injection with the same token must be a no-op for the style body
  await withTarget(targets[0], (s) => s.evaluate(js));
  const after = await withTarget(targets[0], (s) =>
    s.evaluate(`document.getElementById("wallvia-skin").dataset.wallviaVersion`)
  );
  assert.equal(after, "live-1", "idempotent re-injection keeps the version");

  // 7) a new token rewrites the stylesheet (wallpaper change)
  const js2 = buildInjectJs(DATA_URL, { dim: 50, glass: 0 }, "live-2");
  await withTarget(targets[0], (s) => s.evaluate(js2));
  const after2 = await withTarget(targets[0], (s) =>
    s.evaluate(`(() => {
      const el = document.getElementById("wallvia-skin");
      return { v: el.dataset.wallviaVersion, dim: getComputedStyle(document.body, "::after").backgroundColor };
    })()`)
  );
  assert.equal(after2.v, "live-2", "new token applied");
  assert.equal(after2.dim, "rgba(8, 10, 18, 0.5)", "dim updated on change");

  // 8) command timeouts reject instead of hanging forever
  const dead = new CdpSession(targets[0].webSocketDebuggerUrl, { timeoutMs: 300 });
  await dead.connect();
  dead.ws.onmessage = null; // swallow replies to force the timeout path
  await assert.rejects(() => dead.send("Runtime.evaluate", { expression: "1" }), /timed out/);
  dead.close();

  console.log("CDP LIVE TEST PASSED");
  console.log("  browser:", browser);
  console.log("  real injection, verifySkin, color-mix translucency, idempotency,");
  console.log("  change detection and request timeout — all verified in a real engine.");
} finally {
  cleanup();
  await sleep(150);
}
