/**
 * codex/src/inject.mjs — build the runtime injection CSS for the Codex desktop
 * app.
 *
 * The Codex renderer refuses file:// images, so the wallpaper is always a
 * data: URL. The CSS is injected over CDP, survives until the window reloads,
 * and is re-injected by the keeper. Selectors target Codex's current DOM
 * (class-name based and therefore fragile across app updates).
 *
 * Shared geometry/clamping comes from the platform-agnostic core, so the
 * fit/dim/strength semantics match the other ports.
 */
import { clamp, backdropGeometry, surfaceShare, LIMITS } from "./state.mjs";

/**
 * The version token stored on the injected <style> element.
 *
 * It combines the wallpaper source token (path + mtime + size, so a new
 * wallpaper re-injects) with a hash of the CSS *shape* for the given options.
 * Hashing the shape means a change to dim/glass/fit — or to this module's CSS
 * itself, e.g. after a Codex update — also produces a new token, so the keeper
 * rewrites the stylesheet instead of silently keeping the stale one.
 *
 * @param {string} sourceToken token of the resolved wallpaper image
 * @param {{dim?:number, glass?:number, fit?:string}} opts
 */
export function skinVersion(sourceToken, opts = {}) {
  return `${sourceToken}#${hash32(buildSkinCss("", opts))}`;
}

/** FNV-1a 32-bit, base36 — small, fast, dependency-free. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Build the self-contained injection script: it installs a
 * <style id="wallvia-skin"> element and paints the wallpaper. Idempotent — the
 * body is only rewritten when the version token changes.
 *
 * @param {string} dataUrl base64 data URL of the wallpaper image
 * @param {{dim?:number, glass?:number, fit?:string}} opts
 * @param {string} version change-detection token (use skinVersion())
 * @returns {string} JavaScript source for Runtime.evaluate
 */
export function buildInjectJs(dataUrl, opts = {}, version = "v1") {
  const css = buildSkinCss(dataUrl, opts);
  const token = JSON.stringify(version);
  return `(() => {
  let el = document.getElementById("wallvia-skin");
  if (!el) {
    el = document.createElement("style");
    el.id = "wallvia-skin";
    (document.head || document.documentElement).appendChild(el);
  }
  if (el.dataset.wallviaVersion !== ${token}) {
    el.textContent = ${JSON.stringify(css)};
    el.dataset.wallviaVersion = ${token};
  }
  return { ok: true, version: ${token} };
})()`;
}

/**
 * The wallpaper CSS for Codex.
 *
 * Verified selectors (from the codex-wallpaper-theme findings):
 *   - [data-codex-window-type=electron] body for the background/dim layers
 *   - .bg-surface* for the panels
 *   - [class*=MainContentSurface] / [class*=ComposerLayoutBody] for the chat
 *     body and composer, which are otherwise fully opaque
 */
export function buildSkinCss(dataUrl, opts = {}) {
  const dim = clamp(opts.dim ?? 22, 0, LIMITS.DIM_MAX);
  const glass = clamp(opts.glass ?? 75, 0, LIMITS.STRENGTH_MAX);
  const { size, repeat } = backdropGeometry(opts.fit ?? "cover");
  const root = "[data-codex-window-type=electron]";
  // Pane opacity: 1.0 (opaque) at glass 0, down to a readability floor at
  // glass 100. Panels keep more of their base colour than the chat body.
  //
  // The floors are deliberately lower than the original plugin's values: this app
  // paints its own panes at ~0.93 opacity, so a high floor leaves the wallpaper
  // almost invisible. 62/52 keeps text readable over the dim layer while
  // making the wallpaper clearly present (verified by screenshot).
  const paneAlpha = (surfaceShare(glass, 62) / 100).toFixed(3);
  const mainAlpha = (surfaceShare(glass, 52) / 100).toFixed(3);

  // Selectors are substring matches because this build uses Tailwind-style
  // tokens (bg-surface, bg-surface-secondary, …) rather than one exact class.
  const paneSelectors = [
    '[class*="bg-surface"]',
    '[class*="MainContentSurface"]',
    '[class*="ComposerLayoutBody"]',
    '[class*="app-shell-left-panel"]',
    '[class*="app-shell-main-surface"]',
  ].join(",");

  // The pane colour is a theme-aware neutral rgba rather than the app's own
  // surface variable: this build does not define --color-surface at all, and a
  // color-mix() over an undefined var would become invalid-at-computed-value
  // time (i.e. fully transparent) instead of falling back. The app exposes its
  // theme on <html data-theme>, which is stable across builds.
  const paneRule = (selector, alpha, dark, light) =>
    `${selector}{background-color:${dark}!important}\n` +
    `html[data-theme=light] ${selector}{background-color:${light}!important}`;

  return [
    "/* Wallvia — runtime injected */",
    `${root} body{background-color:#000!important}`,
    `${root} body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;` +
      `background-image:url(${JSON.stringify(dataUrl)});` +
      `background-size:${size};background-position:center;background-repeat:${repeat};` +
      `background-attachment:fixed}`,
    `${root} body::after{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;` +
      `background-color:rgba(8,10,18,${(dim / 100).toFixed(3)})}`,
    paneRule(paneSelectors, paneAlpha, `rgba(20,20,20,${paneAlpha})`, `rgba(250,250,250,${paneAlpha})`),
    paneRule(
      `${root} [class*="MainContentSurface"],${root} [class*="ComposerLayoutBody"]`,
      mainAlpha,
      `rgba(20,20,20,${mainAlpha})`,
      `rgba(250,250,250,${mainAlpha})`
    ),
    `${root}.electron-opaque,${root}.electron-opaque body{background-color:transparent!important}`,
  ].join("\n");
}
