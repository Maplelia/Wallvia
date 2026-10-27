/**
 * @fileoverview Wallvia — writing the patch: locate workbench.html, inject the block,
 * keep `product.json`'s checksum honest, and put everything back.
 *
 * Everything that touches the VS Code installation directory lives here, so
 * there is exactly one place to audit for "this extension writes to Program Files".
 * Split out of extension.js; behaviour is identical, this is a pure move.
 */
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeFileAtomic } = require("./atomic-write");
const {
  MARK_START,
  MARK_END,
  MARK_LAYER_START,
  MARK_LAYER_END,
  CSS_FILENAME,
  LIVE_FILENAME,
  STAMP_FILENAME,
  CONFIG_KEY,
} = require("./constants");
const cssGen = require("./css");
const videoLayer = require("./video");

/**
 * Remove both of Wallvia's blocks, leaving every other byte of the file alone.
 *
 * Two blocks exist because a `<div>` is not legal in `<head>`; both are ours, so
 * every path that edits `workbench.html` has to drop both — otherwise
 * "uninstall" would leave the video layer behind.
 */
function stripWallvia(html) {
  return String(html)
    .replace(/<!-- wallvia:layer:start -->[\s\S]*?<!-- wallvia:layer:end -->\s*/g, "")
    .replace(/<!-- wallvia:start -->[\s\S]*?<!-- wallvia:end -->\s*/g, "");
}

/**
 * Injected by extension.js at load time. Getters, so the context can be assigned
 * in activate() without this module holding a stale copy.
 */
let deps = {
  getCtx: () => null,
  options: () => ({}),
  log: () => {},
};

function init(next) {
  deps = next;
}

// -------------------------------------------------------------- patching

/** Paths to probe for workbench.html under appRoot (out/...), newest first. */
function workbenchHtmlCandidates(appRoot) {
  return [
    path.join(appRoot, "out", "vs", "code", "electron-browser", "workbench", "workbench.html"),
    path.join(appRoot, "out", "vs", "code", "electron-sandbox", "workbench", "workbench.html"),
    path.join(appRoot, "out", "vs", "workbench", "workbench.html"),
  ];
}

function findWorkbenchHtml(appRoot) {
  for (const p of workbenchHtmlCandidates(appRoot)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** checksums key inside product.json is relative to out/. */
function checksumKeyFor(htmlPath, appRoot) {
  return path.relative(path.join(appRoot, "out"), htmlPath).split(path.sep).join("/");
}

/**
 * The stored wallpaper file name, self-healing when the recorded name is gone.
 * The extension name can legitimately change between runs — a scene package's
 * artwork is stored as `wallpaper.png` while a preview stays `wallpaper.jpg` —
 * so a stale record must never leave the window with no wallpaper at all.
 * @returns {string|null}
 */
function resolveStoredImage() {
  const dir = deps.getCtx().globalStorageUri.fsPath;
  const recorded = deps.getCtx().globalState.get("image", null);
  if (recorded && fs.existsSync(path.join(dir, recorded))) return recorded;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^wallpaper\./i.test(f)) return f;
    }
  } catch {
    /* storage dir does not exist yet */
  }
  return null;
}

async function applyPatch() {
  if (vscode.workspace.isTrusted === false) {
    vscode.window.showWarningMessage(
      "Wallvia: Restricted Mode 窗口不能修改 VS Code 安装文件,壁纸未应用。"
    );
    return false;
  }
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  const appRoot = vscode.env.appRoot; // ...\resources\app
  const htmlPath = findWorkbenchHtml(appRoot);
  if (!htmlPath) {
    throw new Error("Could not locate workbench.html under " + appRoot);
  }
  const prodPath = path.join(appRoot, "product.json");
  const bakPath = htmlPath + ".wallvia.bak";
  const cssPath = path.join(path.dirname(htmlPath), CSS_FILENAME);

  // 1) keep the backup describing *this* install directory's original file.
  //
  // It used to be written once, on the very first run, and never refreshed: a
  // VS Code update installs into a new version directory, so the old `.bak`
  // stayed behind in the abandoned folder and `restore` fell back to stripping
  // the marker out of whatever file happened to be there — which cannot undo
  // anything another tool (or an older Wallvia) had added. Refreshing it costs
  // one comparison per apply, and only writes when the content actually differs.
  const currentHtml = fs.readFileSync(htmlPath, "utf8");
  const pristineHtml = stripWallvia(currentHtml);
  const bakStale = !fs.existsSync(bakPath) || fs.readFileSync(bakPath, "utf8") !== pristineHtml;
  if (bakStale) {
    writeFileAtomic(bakPath, pristineHtml);
  }

  const opts = deps.options();
  const livePath = path.join(path.dirname(htmlPath), LIVE_FILENAME);
  const stampPath = path.join(path.dirname(htmlPath), STAMP_FILENAME);

  // 2) disabled or no image → remove only our block, keep the backup
  const imageRel = resolveStoredImage();
  if (imageRel && imageRel !== deps.getCtx().globalState.get("image", null)) {
    await deps.getCtx().globalState.update("image", imageRel); // self-healed record
  }
  if (!imageRel || !cfg.get("enabled", true)) {
    let html = fs.readFileSync(htmlPath, "utf8");
    const cleaned = stripWallvia(html);
    if (cleaned !== html) {
      writeFileAtomic(htmlPath, cleaned);
      fixChecksum(prodPath, checksumKeyFor(htmlPath, appRoot), htmlPath);
    }
    for (const f of [cssPath, livePath, stampPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    return true;
  }

  const imageAbs = path.join(deps.getCtx().globalStorageUri.fsPath, imageRel);
  if (!fs.existsSync(imageAbs)) {
    throw new Error("Wallpaper image is missing: " + imageAbs);
  }
  // Build the URI through VS Code so it is percent-encoded. Doing it by hand
  // breaks for paths with spaces or non-ASCII characters.
  const imageUri = vscode.Uri.file(imageAbs)
    .with({ scheme: "vscode-file", authority: "vscode-app" })
    .toString();

  // 3) write the css next to workbench.html (skip when unchanged so a
  //    re-apply does not manufacture a bogus "reload needed" state)
  const videoOn = cfg.get("videoWallpaper", true) && !!videoAbs();
  // The still image is the poster: same picture the `::before` layer paints, and
  // what shows while the demuxer reads and if autoplay is refused.
  const posterUrl = imageUri;
  const css = cssGen.buildCss({
    imageUri,
    imageVersion: imageVersionOf(imageAbs),
    dim: cfg.get("dim", 45),
    glass: cfg.get("glass", 55),
    mode: cfg.get("mode", "glass"),
    fit: cfg.get("fit", "cover"),
    light: opts.themeAware && isLightTheme(),
    // The layer only exists in the markup when a video is actually playing;
    // emitting its rules unconditionally would leave dead css in every install.
    video: videoOn,
  });
  const prevCss = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : null;
  if (prevCss !== css) {
    writeFileAtomic(cssPath, css);
  }
  const stamp = Math.floor(fs.statSync(cssPath).mtimeMs);
  // The live script polls this file; a change makes it swap the <link> in
  // place, so effects apply without reloading the whole window.
  //
  // Line 1 is the stylesheet stamp, line 2 the video URL ("" = no video), and
  // lines 3-4 the two element-state switches a `<video>` cannot read from markup.
  // One poll drives all three mechanisms.
  const videoUrl = videoOn ? videoFileUrl() : "";
  const stampBody =
    String(stamp) +
    "\n" +
    videoUrl +
    "\n" +
    (cfg.get("videoMuted", true) ? "muted" : "sound") +
    "\n" +
    (cfg.get("videoPauseUnfocused", true) ? "pause" : "keep") +
    "\n";
  if (opts.liveApply) {
    const live = LIVE_SCRIPT + "\n" + videoLayer.videoDriverScript();
    if (!fs.existsSync(livePath) || fs.readFileSync(livePath, "utf8") !== live) {
      writeFileAtomic(livePath, live);
    }
  } else if (fs.existsSync(livePath)) {
    // Turning live apply off has to take the script with it: it is no longer
    // referenced by the markup, and a leftover copy keeps polling the stamp and
    // swapping the stylesheet behind the user's back.
    fs.unlinkSync(livePath);
  }
  // The stamp is written whenever a video is playing, not only with liveApply:
  // it is also how the *video* learns its url and the two element-state switches
  // (mute, focus-pause). Gating it on liveApply made those three settings dead in
  // exactly the configuration where no live updates were wanted. The stylesheet
  // swap simply ignores the file when its script is absent.
  if (opts.liveApply || videoOn) {
    if (!fs.existsSync(stampPath) || fs.readFileSync(stampPath, "utf8") !== stampBody) {
      writeFileAtomic(stampPath, stampBody);
    }
  }

  // 4) idempotent cache-busted injection, touching only our blocks.
  //
  // Two blocks, each where its content is legal: the stylesheet and the live
  // script go in `<head>`, the video layer goes at the top of `<body>`. A `<div>`
  // inside `<head>` makes the HTML parser close the head and synthesise a body,
  // which put the layer outside the workbench document — the video never showed
  // up and nothing logged an error.
  let html = fs.readFileSync(htmlPath, "utf8");
  const headMarker =
    MARK_START +
    '<link rel="stylesheet" href="./' + CSS_FILENAME + "?wallvia=" + stamp + '" />' +
    (opts.liveApply
      ? '<script src="./' + LIVE_FILENAME + "?wallvia=" + stamp + '"></script>'
      : "") +
    MARK_END;
  const layerMarker =
    MARK_LAYER_START +
    (videoOn
      ? videoLayer.videoMarkup({
          posterUrl,
          videoUrl,
          muted: cfg.get("videoMuted", true),
        })
      : "") +
    MARK_LAYER_END;
  let next = stripWallvia(html);
  next = next.replace("</head>", "  " + headMarker + "\n</head>");
  if (videoOn) {
    // Right after `<body>`, so the layer is the first painted thing behind the
    // workbench and no workbench markup can stack above it.
    next = /<body[^>]*>/.test(next)
      ? next.replace(/<body([^>]*)>/, "<body$1>\n  " + layerMarker)
      : next.replace("</body>", "  " + layerMarker + "\n</body>");
  }
  if (next !== html) {
    writeFileAtomic(htmlPath, next);
    fixChecksum(prodPath, checksumKeyFor(htmlPath, appRoot), htmlPath);
  }

  // 5) remember which VS Code version this patch was made under
  await deps.getCtx().globalState.update("appliedVersion", vscode.version);
  await deps.getCtx().globalState.update("appliedImageRel", imageRel);
  return true;
}

/**
 * The video file behind the current wallpaper, or null.
 *
 * Recorded by `applyWallpaperSource` when the chosen entry is a video; kept
 * separately from `image` because the image is the *poster* — the still that
 * shows before the first frame. The file lives wherever Wallpaper Engine put it,
 * outside `globalStorage`, so it is stored as an absolute path.
 */
function videoAbs() {
  try {
    const p = deps.getCtx().globalState.get("videoPath", null);
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * A `vscode-file://` URL for the video, which is what `media-src 'self'` allows.
 *
 * Same scheme as the wallpaper image: `Uri.file(...).with({scheme:"vscode-file",
 * authority:"vscode-app"})` percent-encodes the path, which hand-building gets
 * wrong for spaces and non-ASCII folder names.
 */
function videoFileUrl() {
  const abs = videoAbs();
  if (!abs) return "";
  try {
    return vscode.Uri.file(abs).with({ scheme: "vscode-file", authority: "vscode-app" }).toString();
  } catch {
    return "";
  }
}

/**
 * A cache-busting token for the wallpaper file: a hash of its bytes.
 *
 * The token used to be the file's mtime + size, which is wrong here for a
 * Windows-specific reason: `fs.copyFileSync` **preserves the source's
 * timestamps**, so re-applying a wallpaper whose cached artwork is unchanged
 * produced a byte-identical URL — and the renderer reused the bitmap it already
 * had, making a real change look like nothing happened. A hash changes exactly
 * when the pixels do, and never otherwise.
 */
function imageVersionOf(file) {
  try {
    return "h" + crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    const stat = fs.statSync(file);
    return Math.floor(stat.mtimeMs) + "-" + stat.size;
  }
}

/**
 * The stylesheet swap used for live apply.
 *
 * The workbench loads its CSS once at startup, so an effect change used to
 * require a full window reload. This script — served from the same folder as
 * the stylesheet and therefore allowed by `script-src 'self'` — polls a tiny
 * stamp file and repoints the <link> when it changes, which re-reads the CSS
 * without touching the rest of the window.
 *
 * `require-trusted-types-for 'script'` is why this uses fetch + href instead of
 * injecting a new <script> element: only the former is allowed under the
 * workbench CSP.
 *
 * The stamp file is two lines (`<css stamp>\n<video url>`), so this reads the
 * **first** line only. The first version used `s.trim()` on the whole body,
 * which embedded a newline in the stylesheet URL the moment a video wallpaper
 * was active — the link swap then silently stopped matching and every effect
 * change needed a full window reload.
 */
const LIVE_SCRIPT = `/* Wallvia live apply — swaps the stylesheet when the stamp changes. */
(function () {
  var link = document.querySelector('link[href*="wallvia-bg.css"]');
  if (!link) return;
  var current = link.getAttribute('href');
  var base = current.split('?')[0];
  function check() {
    if (document.hidden) return;
    fetch('./wallvia-stamp.txt', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (s) {
        s = String(s).split('\\n')[0].trim();
        if (!s) return;
        var href = base + '?wallvia=' + s;
        if (href !== current) { current = href; link.setAttribute('href', href); }
      })
      .catch(function () {});
  }
  setInterval(check, 2000);
  document.addEventListener('visibilitychange', check);
})();
`;

/** Whether the active theme is a light one (drives the wash colour). */
function isLightTheme() {
  try {
    const kind = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind;
    // ColorThemeKind: 1 = Light, 2 = Dark, 3 = HighContrast, 4 = HC Light.
    return kind === 1 || kind === 4;
  } catch {
    return false;
  }
}

function fixChecksum(prodPath, key, htmlPath) {
  const prod = JSON.parse(fs.readFileSync(prodPath, "utf8"));
  prod.checksums = prod.checksums || {};
  // VS Code stores sha256 as *unpadded* base64 (43 chars); writing hex makes
  // every startup show "Your Code installation appears to be corrupt."
  prod.checksums[key] = fileChecksum(htmlPath);
  writeFileAtomic(prodPath, JSON.stringify(prod, null, "\t"));
}

/** The exact checksum format VS Code expects: sha256, base64, no padding. */
function fileChecksum(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("base64")
    .replace(/=+$/, "");
}


/**
 * Restore the original workbench.html from the backup Wallvia keeps.
 *
 * The escape hatch for "I want my install back": it also drops the generated
 * stylesheet, the live-apply script and the stamp file so nothing of ours is
 * left behind, and fixes the checksum on the restored file.
 *
 * @param {{quiet?: boolean}} [opts] `quiet` skips the confirmation message; the
 *   uninstall cleanup path has nobody to talk to (the window is going away).
 */
async function restoreWorkbench(opts = {}) {
  const quiet = opts && opts.quiet === true;
  const appRoot = vscode.env.appRoot;
  const htmlPath = findWorkbenchHtml(appRoot);
  if (!htmlPath) {
    if (!quiet) vscode.window.showErrorMessage("Wallvia: could not locate workbench.html.");
    return false;
  }
  const bakPath = htmlPath + ".wallvia.bak";
  const dir = path.dirname(htmlPath);
  if (fs.existsSync(bakPath)) {
    // copyFileSync truncates the target first; write atomically so a crash
    // mid-restore cannot leave a truncated workbench.html behind.
    writeFileAtomic(htmlPath, fs.readFileSync(bakPath));
  } else {
    const html = fs.readFileSync(htmlPath, "utf8");
    const cleaned = stripWallvia(html);
    if (cleaned !== html) writeFileAtomic(htmlPath, cleaned);
  }
  for (const name of [CSS_FILENAME, LIVE_FILENAME, STAMP_FILENAME]) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  const prodPath = path.join(appRoot, "product.json");
  if (fs.existsSync(prodPath)) {
    fixChecksum(prodPath, checksumKeyFor(htmlPath, appRoot), htmlPath);
  }
  if (!quiet) {
    vscode.window.showInformationMessage(
      "Wallvia: workbench.html 已还原,重载窗口后生效。现在可以安全卸载本扩展。"
    );
  }
  return true;
}

module.exports = {
  init,
  applyPatch,
  restoreWorkbench,
  findWorkbenchHtml,
  workbenchHtmlCandidates,
  checksumKeyFor,
  fixChecksum,
  fileChecksum,
  imageVersionOf,
  resolveStoredImage,
  isLightTheme,
  LIVE_SCRIPT,
};
