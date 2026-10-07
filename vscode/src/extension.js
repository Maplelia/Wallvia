/**
 * @fileoverview Wallvia — VS Code extension.
 *
 * Static wallpaper behind a transparent workbench:
 *   1. The picked image is copied into the extension's globalStorage dir.
 *   2. A `wallvia-bg.css` file is generated next to `workbench.html`:
 *      one `body::before` wallpaper layer, one `body::after` dim wash, and
 *      explicit transparency for the structural workbench surfaces.
 *   3. `workbench.html` gets an idempotent `<link>` injection
 *      (marked <!-- wallvia:start/end -->, cache-busted by css mtime).
 *   4. `product.json` checksums are updated so VS Code does not warn about
 *      a "corrupt" installation.
 *   5. On activate, if the patch on disk is from another VS Code version or
 *      an older CSS build, it is re-applied automatically.
 *
 * Design rules (learned the hard way):
 *   - NO `backdrop-filter` / `blur()` anywhere under the workbench: Chromium
 *     repaints every editor/list on each frame → severe lag.
 *   - NO universal `.monaco-workbench *` transparency: it also strips quick
 *     input, menus and dialogs → text overlaps the page underneath.
 *   - Only static images (jpg/png/bmp); animated content repaints forever.
 *   - workbench.html is read once per window, so a fresh patch always needs
 *     a window reload; `statusString().reloadNeeded` says when.
 */
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const still = require("./still-image");
const video = require("./video-frame");
const mp4 = require("./mp4");

const MARK_START = "<!-- wallvia:start -->";
const MARK_END = "<!-- wallvia:end -->";
const CSS_FILENAME = "wallvia-bg.css";
const LIVE_FILENAME = "wallvia-live.js";
const STAMP_FILENAME = "wallvia-stamp.txt";
const THUMB_DIRNAME = "thumbs";
const CSS_BUILD = "wallvia-css-v5";
const CONFIG_KEY = "wallvia";
/** Picker cards are ~212 px wide; this covers a 2x display. */
const THUMB_TARGET_WIDTH = 640;
/**
 * How long the picker's webview gets to decode a video frame. The decode itself
 * takes well under a second; this only has to cover a stalled element.
 */
const FRAME_TIMEOUT_MS = 20000;
/** Pause before the single retry, so a large file has time to open. */
const FRAME_RETRY_DELAY_MS = 700;

/** @type {import('vscode').ExtensionContext} */
let ctx = null;
/** When this window's extension host came up — the reload-needed baseline. */
let activatedAt = 0;

/** @type {import('vscode').OutputChannel|null} */
let channel = null;

/**
 * Record what the picker could not do.
 *
 * A card that fails to fill in looks identical whether the cache missed, the
 * decode failed or the picture was unreadable, and none of that is visible from
 * the outside — the grid just keeps its placeholder. Failures go to the
 * "Wallvia" output channel instead of being swallowed, which is what turned a
 * five-round guessing game into a one-line answer.
 */
function log(...parts) {
  const line = new Date().toISOString().slice(11, 23) + " " + parts.join(" ");
  try {
    if (channel) channel.appendLine(line);
  } catch {
    /* logging must never break the wallpaper */
  }
}

/**
 * The user-facing switches, read once per operation.
 * @returns {{hires:boolean, videoFrames:boolean, liveApply:boolean, themeAware:boolean}}
 */
function options() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  return {
    // Take the artwork out of scene.pkg instead of using the square preview.
    hires: cfg.get("hires", true),
    // Decode one frame of a video wallpaper (in the picker's Chromium).
    videoFrames: cfg.get("videoFrames", true),
    // Swap the stylesheet in place instead of reloading the whole window.
    liveApply: cfg.get("liveApply", true),
    // Pick the dim colour from the active theme (dark → near black).
    themeAware: cfg.get("themeAware", true),
    // Widest artwork level to paint with; 0 keeps the sharpest one. A smaller
    // value trades a little sharpness on huge displays for a much smaller
    // decode (a 3840x2160 PNG is ~33 MB of pixels once Chromium decodes it).
    maxImageWidth: Math.max(0, Number(cfg.get("maxImageWidth", 0)) || 0),
  };
}

function clamp(n, min, max, dflt) {
  n = n == null ? dflt : Number(n);
  if (!Number.isFinite(n)) n = dflt;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------- geometry

/**
 * background-size / repeat for an alignment mode.
 * 覆盖 cover / 填充 fill / 居中 center; contain/tile are legacy values that
 * keep rendering so an old settings.json does not break.
 */
function geometry(fit) {
  switch (fit) {
    case "fill":
      return { size: "100% 100%", repeat: "no-repeat" };
    case "center":
      return { size: "auto", repeat: "no-repeat" };
    case "contain": // legacy
      return { size: "contain", repeat: "no-repeat" };
    case "tile": // legacy
      return { size: "360px auto", repeat: "repeat" };
    case "cover":
    default:
      return { size: "cover", repeat: "no-repeat" };
  }
}

// ------------------------------------------------------------------- css

/**
 * Build the wallpaper CSS. The image must be referenced via
 * vscode-file://vscode-app/<abs> (CSP allows it; bare file:// is blocked).
 *
 * Layering (no pseudo-elements inside .monaco-workbench, no negative
 * z-index — both get clipped by VS Code's own stacking contexts):
 *   body::before  z-index 0  wallpaper
 *   body::after   z-index 1  dim wash
 *   workbench     z-index 2  transparent surfaces on top
 */
function buildCss({ imageUri, imageVersion, dim, glass, mode, fit, light }) {
  const g = geometry(fit);
  const dimPct = clamp(dim, 0, 80, 45);
  const glassPct = clamp(glass, 0, 100, 55);
  // `wallvia.blur` is deliberately ignored: any backdrop-filter under the
  // workbench makes Chromium repaint every editor and list on each frame.
  // The wash follows the theme: a near-black veil on dark themes, a light one
  // on light themes, instead of darkening a light workbench into mud.
  const washRgb = light ? "246,247,250" : "8,10,18";
  // The letterbox a `contain` wallpaper leaves visible gets the same tone.
  const backdrop = light ? "#f2f3f6" : "#0b0d12";

  // One dim wash over the whole window. fade mode = the same wash, softer.
  const washA = ((mode === "fade" ? dimPct * 0.45 : dimPct) / 100).toFixed(3);
  // Editor tint: glass=100 → fully clear editors, glass=0 → 85% theme color.
  const tintPct = Math.round((100 - glassPct) * 0.85);

  // Structural surfaces only — never a universal descendant selector.
  const surfaces = [
    ".monaco-workbench",
    ".monaco-workbench .monaco-grid-view",
    ".monaco-workbench .part.activitybar",
    ".monaco-workbench .part.sidebar",
    ".monaco-workbench .part.auxiliarybar",
    ".monaco-workbench .part.panel",
    ".monaco-workbench .part.editor",
    ".monaco-workbench .part.titlebar",
    ".monaco-workbench .part.statusbar",
    ".monaco-workbench .part.editor>.content",
    ".monaco-workbench .part.editor .editor-group-container",
    ".monaco-workbench .part.editor .editor-container",
    ".monaco-workbench .part.editor .tabs-and-actions-container",
    ".monaco-workbench .part.editor .monaco-editor",
    ".monaco-workbench .monaco-editor .overflow-guard",
    ".monaco-workbench .monaco-editor .monaco-scrollable-element",
    ".monaco-workbench .monaco-editor .monaco-editor-background",
    ".monaco-workbench .monaco-editor .margin",
    ".monaco-workbench .monaco-pane-view",
    ".monaco-workbench .monaco-pane-view .pane",
    ".monaco-workbench .monaco-pane-view .pane>.pane-header",
    ".monaco-workbench .part.sidebar>.content",
    ".monaco-workbench .part.auxiliarybar>.content",
    ".monaco-workbench .part.panel>.content",
    ".monaco-workbench .part.sidebar .pane-body",
    ".monaco-workbench .part.auxiliarybar .pane-body",
    ".monaco-workbench .part.panel .pane-body",
    ".monaco-workbench .part.sidebar .monaco-list",
    ".monaco-workbench .part.sidebar .monaco-list-rows",
    ".monaco-workbench .part.auxiliarybar .monaco-list",
    ".monaco-workbench .part.panel .monaco-list",
    ".monaco-workbench .split-view-view",
  ]
    .map((s) => "html body " + s)
    .join(",");

  const rules = [
    "/* Wallvia " + CSS_BUILD + ": one wallpaper layer, one dim wash, transparent workbench surfaces. */",
    "html,html body{background:transparent!important}",
    "html body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;" +
      // The backing colour fills the area a "contain" wallpaper leaves empty,
      // so the letterbox is a flat tone instead of the window's void.
      "background-color:" + backdrop + ";" +
      // `?v=` is the stored image's identity: without it Chromium keeps
      // painting the previous wallpaper after the file is replaced.
      "background-image:url('" + imageUri + (imageVersion ? "?v=" + imageVersion : "") + "');" +
      "background-size:" + g.size + ";background-position:center;background-repeat:" + g.repeat + "}",
    "html body::after{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;background:rgba(" + washRgb + "," + washA + ")}",
    "html body .monaco-workbench{position:relative;z-index:2;background:transparent!important}",
    // Components that paint through theme variables: make those variables
    // transparent so nothing has to fight per-component !important rules.
    "html body .monaco-workbench{" +
      "--vscode-editor-background:transparent;" +
      "--vscode-sideBar-background:transparent;" +
      "--vscode-sideBarSectionHeader-background:transparent;" +
      "--vscode-panel-background:transparent;" +
      "--vscode-activityBar-background:transparent;" +
      "--vscode-titleBar-activeBackground:transparent;" +
      "--vscode-titleBar-inactiveBackground:transparent;" +
      "--vscode-statusBar-background:transparent;" +
      "--vscode-tab-activeBackground:transparent;" +
      "--vscode-tab-inactiveBackground:transparent;" +
      "--vscode-editorGroupHeader-tabsBackground:transparent;" +
      // The Output view paints its own editor background (0,5,0 rule), so the
      // variable has to be neutralised or the panel shows an opaque block.
      "--vscode-outputView-background:transparent;" +
      // 1.141 modern UI: the floating sidebar/panel cards paint with
      // `var(--vscode-surface-background)!important` and the shell paints with
      // `var(--modern-ui-shell-background, ...)`. Neutralising the variables
      // kills both without touching menus or the quick input.
      "--vscode-surface-background:transparent;" +
      "--modern-ui-shell-background:transparent;" +
      "--vscode-modernUI-shellBackground:transparent}",
    surfaces + "{background:transparent!important;background-color:transparent!important;background-image:none!important}",
    // VS Code 1.140+ `floating-panels` rules are (0,3,0) `!important` rules
    // (`.monaco-workbench.floating-panels .part.sidebar`), so the clear above
    // — two classes — loses to them and the sidebar stays an opaque card.
    // Repeat the real chain to outrank them.
    [
      ".monaco-workbench.floating-panels",
      ".monaco-workbench.floating-panels>.monaco-grid-view",
      ".monaco-workbench.floating-panels .part.sidebar",
      ".monaco-workbench.floating-panels .part.auxiliarybar",
      ".monaco-workbench.floating-panels .part.panel",
      ".monaco-workbench.floating-panels .part.editor",
      ".monaco-workbench.floating-panels .part.editor>.content",
      ".monaco-workbench.floating-panels .webview-overlay-content",
      ".monaco-workbench.floating-panels .part.titlebar",
      ".monaco-workbench.floating-panels .part.statusbar",
      ".monaco-workbench.floating-panels .part.activitybar",
      ".monaco-workbench.floating-panels .monaco-pane-view .pane",
      ".monaco-workbench.floating-panels .pane-body",
      ".monaco-workbench.floating-panels .monaco-list",
      ".monaco-workbench.floating-panels .monaco-list-rows",
    ]
      .map((s) => "html body " + s)
      .join(",") +
      "{background-color:transparent!important;background-image:none!important}",
    ".monaco-editor .scroll-decoration{box-shadow:none!important}",
  ];

  if (tintPct > 0) {
    // Slightly more specific than the clear above, so it wins for editors.
    rules.push(
      "html body .monaco-workbench .part.editor .monaco-editor .monaco-editor-background," +
        "html body .monaco-workbench .part.editor .monaco-editor .margin{" +
        "background-color:color-mix(in srgb,var(--vscode-editorWidget-background,#141821) " +
        tintPct +
        "%,transparent)!important}"
    );
  }

  // Floating widgets keep an opaque theme background: text must never show
  // the page underneath (the old universal selector caused exactly that).
  rules.push(
    ".quick-input-widget,.quick-input-container,.monaco-dialog,.monaco-dialog-box," +
      ".monaco-menu-container,.context-view,.notifications-toasts{" +
      "background-color:var(--vscode-editorWidget-background,#25272e)!important;background-image:none!important}"
  );

  return rules.join("\n");
}

// ----------------------------------------------------------------- thumbs

/**
 * Where an entry's artwork comes from.
 *
 * Two shapes have to be covered:
 *   - a packaged scene: `scene.pkg` holds the mipmap chain (the common case);
 *   - an unpacked project: Wallpaper Engine's built-ins and `web` wallpapers
 *     ship `materials/`, `images/` and the like, with no package at all.
 *
 * Deciding by folder rather than by file name is deliberate: Wallpaper Engine
 * registers a scene through its `scene.json` description, so an entry can look
 * like a JSON wallpaper while the paintable package sits next to it.
 *
 * @returns {{dir:string, pkg:string|null}|null}
 */
function artworkSource(entry) {
  const dirs = [];
  if (entry.file && /\.pkg$/i.test(entry.file)) dirs.push(path.dirname(entry.file));
  if (entry.dir) dirs.push(entry.dir);
  for (const dir of dirs) {
    const pkg = path.join(dir, "scene.pkg");
    if (fs.existsSync(pkg)) return { dir, pkg };
  }
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, "project.json"))) return { dir, pkg: null };
    } catch {
      /* unreadable folder */
    }
  }
  return null;
}

/** The widest still of an artwork source, or null. */
function stillFrom(source, targetWidth) {
  if (source.pkg) {
    const level = still.readSceneLevel(source.dir, Number(targetWidth) || 0);
    if (level) {
      return {
        bytes: level.bytes,
        width: level.width,
        height: level.height,
        // The sharpest level, so callers can report the artwork's real size.
        sourceWidth: level.maxWidth,
        sourceHeight: level.maxHeight,
      };
    }
  }
  const folder = still.bestFolderStill(source.dir, Number(targetWidth) || 0);
  return folder ? { ...folder, sourceWidth: folder.width, sourceHeight: folder.height } : null;
}

/** Where generated picker thumbnails live (persistent cache). */
function thumbCacheDir() {
  const dir = path.join(ctx.globalStorageUri.fsPath, THUMB_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Thumbnail / artwork suffixes, in the order a cache hit should be looked for. */
const CACHE_EXTS = [".png", ".jpg", ".jpeg", ".bmp", ".gif"];

/**
 * A cached file plus its sidecar metadata, or null.
 * Both caches (thumbnails and full-resolution artwork) use the same layout, so
 * they share one reader.
 */
function readCached(cacheDir, base) {
  for (const ext of CACHE_EXTS) {
    const file = path.join(cacheDir, base + ext);
    if (!fs.existsSync(file)) continue;
    const size = still.imageSize(file);
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(cacheDir, base + ".json"), "utf8"));
    } catch {
      /* the sidecar is optional; the header size is a good fallback */
    }
    return { file, width: size ? size.width : null, height: size ? size.height : null, ...meta };
  }
  return null;
}

/** Write a cache entry (image + sidecar) and return it. */
function writeCached(cacheDir, base, ext, bytes, info) {
  const file = path.join(cacheDir, base + ext);
  fs.writeFileSync(file, bytes);
  try {
    fs.writeFileSync(path.join(cacheDir, base + ".json"), JSON.stringify(info));
  } catch {
    /* the sidecar is optional */
  }
  return { file, ...info };
}

/**
 * Cache key for one wallpaper: the source file's identity, not just its path,
 * so a re-subscribed or updated workshop item gets a fresh thumbnail.
 */
function thumbKey(entry) {
  const parts = [];
  for (const p of [entry.file, entry.preview]) {
    if (!p) continue;
    try {
      const s = fs.statSync(p);
      parts.push(p + ":" + s.size + ":" + Math.floor(s.mtimeMs));
    } catch {
      /* missing file: the key simply ignores it */
    }
  }
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * The full-resolution artwork of a scene wallpaper, cached.
 *
 * Reading a package can cost hundreds of megabytes of I/O, and the same
 * wallpaper is re-applied whenever an effect changes, so the extracted bytes
 * are kept next to the thumbnails and keyed by the source's size and mtime.
 *
 * @param {object} entry picker entry (`file`, `dir`, `preview`)
 * @param {number} [maxWidth] widest acceptable level (0 = sharpest available)
 */
function buildHiRes(entry, maxWidth) {
  const cacheDir = thumbCacheDir();
  const cap = Number(maxWidth) || 0;
  const base = thumbKey(entry) + "-" + cap + ".full";
  const cached = readCached(cacheDir, base);
  if (cached) return cached;
  const source = artworkSource(entry);
  if (!source) return null;
  const art = stillFrom(source, cap);
  if (!art) return null;
  return writeCached(cacheDir, base, ".png", art.bytes, {
    width: art.width,
    height: art.height,
    origin: source.pkg ? "scene.pkg" : "project files",
    source: entry.file,
  });
}

/**
 * A picker thumbnail for one wallpaper.
 *
 * Wallpaper Engine's `preview.jpg` is square (801–1024 px), so painting it made
 * every card look like a cropped 1:1 image. A scene package carries a real 16:9
 * mipmap chain instead (3840x2160 … 240x135), so one of those levels is used —
 * the smallest that still covers a card on a 2x display. Videos fall back to a
 * decoded frame, and anything else to its own preview.
 *
 * The chosen level is copied byte for byte into the cache; the cache key
 * includes the source size/mtime, so nothing is re-decoded on the next open.
 *
 * @returns {{file:string, width:number|null, height:number|null, sourceWidth:number|null, origin:string}|null}
 */
function buildThumb(entry, opts) {
  const cacheDir = thumbCacheDir();
  const key = thumbKey(entry);
  const cached = readCached(cacheDir, key);
  if (cached) return cached;

  const describe = (size, origin) => ({
    width: size ? size.width : null,
    height: size ? size.height : null,
    sourceWidth: size ? size.width : null,
    sourceHeight: size ? size.height : null,
    origin,
  });

  const source = opts.hires === false ? null : artworkSource(entry);
  if (source) {
    const art = stillFrom(source, THUMB_TARGET_WIDTH);
    if (art) {
      return writeCached(cacheDir, key, ".png", art.bytes, {
        width: art.width,
        height: art.height,
        sourceWidth: art.sourceWidth,
        sourceHeight: art.sourceHeight,
        origin: source.pkg ? "scene.pkg" : "project files",
      });
    }
  }

  // A video has no still of its own. The frame is decoded by the picker's
  // webview (Chromium) and cached by the Node half, exactly like the Obsidian
  // side; the resolution pill reports the container's own size, not the frame's,
  // so the difference between "1920x1080 video" and "960px frame" is visible.
  if (opts.videoFrames && still.VIDEO_EXT.test(entry.file || "")) {
    const width = video.frameWidthForCard(opts.maxImageWidth);
    const frame = video.readVideoFrame(entry.file, width);
    if (frame) {
      const native = mp4.readVideoSize(entry.file);
      return writeCached(cacheDir, key, ".jpg", frame.bytes, {
        width: frame.width,
        height: frame.height,
        sourceWidth: native ? native.width : frame.width,
        sourceHeight: native ? native.height : frame.height,
        origin: "video frame",
      });
    }
    // Nothing cached yet: the caller (the picker) can still get one from its
    // webview, so this must not fall through to the square preview — that would
    // silently make the frame path unreachable.
    return null;
  }

  const src = entry.preview && fs.existsSync(entry.preview) ? entry.preview : entry.file;
  if (!src || !fs.existsSync(src)) return null;
  return writeCached(
    cacheDir,
    key,
    path.extname(src).toLowerCase() || ".png",
    fs.readFileSync(src),
    describe(still.imageSize(src), "preview")
  );
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
  const dir = ctx.globalStorageUri.fsPath;
  const recorded = ctx.globalState.get("image", null);
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

  // 1) backup the original once
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(htmlPath, bakPath);
  }

  const opts = options();
  const livePath = path.join(path.dirname(htmlPath), LIVE_FILENAME);
  const stampPath = path.join(path.dirname(htmlPath), STAMP_FILENAME);

  // 2) disabled or no image → remove only our block, keep the backup
  const imageRel = resolveStoredImage();
  if (imageRel && imageRel !== ctx.globalState.get("image", null)) {
    await ctx.globalState.update("image", imageRel); // self-healed record
  }
  if (!imageRel || !cfg.get("enabled", true)) {
    let html = fs.readFileSync(htmlPath, "utf8");
    const cleaned = html.replace(/<!-- wallvia:start -->[\s\S]*?<!-- wallvia:end -->/g, "");
    if (cleaned !== html) {
      fs.writeFileSync(htmlPath, cleaned);
      fixChecksum(prodPath, checksumKeyFor(htmlPath, appRoot), htmlPath);
    }
    for (const f of [cssPath, livePath, stampPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    return true;
  }
  const imageAbs = path.join(ctx.globalStorageUri.fsPath, imageRel);
  if (!fs.existsSync(imageAbs)) {
    throw new Error("Wallpaper image is missing: " + imageAbs);
  }
  // Build the URI through VS Code so it is percent-encoded. Doing it by hand
  // breaks for paths with spaces or non-ASCII characters.
  const imageUri = vscode.Uri.file(imageAbs)
    .with({ scheme: "vscode-file", authority: "vscode-app" })
    .toString();
  const imageStat = fs.statSync(imageAbs);

  // 3) write the css next to workbench.html (skip when unchanged so a
  //    re-apply does not manufacture a bogus "reload needed" state)
  const css = buildCss({
    imageUri,
    imageVersion: Math.floor(imageStat.mtimeMs) + "-" + imageStat.size,
    dim: cfg.get("dim", 45),
    glass: cfg.get("glass", 55),
    mode: cfg.get("mode", "glass"),
    fit: cfg.get("fit", "cover"),
    light: opts.themeAware && isLightTheme(),
  });
  const prevCss = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : null;
  if (prevCss !== css) {
    fs.writeFileSync(cssPath, css);
  }
  const stamp = Math.floor(fs.statSync(cssPath).mtimeMs);
  // The live script polls this file; a change makes it swap the <link> in
  // place, so effects apply without reloading the whole window.
  if (opts.liveApply) {
    if (!fs.existsSync(livePath) || fs.readFileSync(livePath, "utf8") !== LIVE_SCRIPT) {
      fs.writeFileSync(livePath, LIVE_SCRIPT);
    }
    if (!fs.existsSync(stampPath) || fs.readFileSync(stampPath, "utf8").trim() !== String(stamp)) {
      fs.writeFileSync(stampPath, String(stamp));
    }
  }

  // 4) idempotent cache-busted injection, touching only our block
  let html = fs.readFileSync(htmlPath, "utf8");
  const marker =
    MARK_START +
    '<link rel="stylesheet" href="./' + CSS_FILENAME + "?wallvia=" + stamp + '" />' +
    (opts.liveApply
      ? '<script src="./' + LIVE_FILENAME + "?wallvia=" + stamp + '"></script>'
      : "") +
    MARK_END;
  if (!html.includes(marker)) {
    html = html.replace(/<!-- wallvia:start -->[\s\S]*?<!-- wallvia:end -->/g, "");
    html = html.replace("</head>", "  " + marker + "\n</head>");
    fs.writeFileSync(htmlPath, html);
    fixChecksum(prodPath, checksumKeyFor(htmlPath, appRoot), htmlPath);
  }

  // 5) remember which VS Code version this patch was made under
  await ctx.globalState.update("appliedVersion", vscode.version);
  await ctx.globalState.update("appliedImageRel", imageRel);
  return true;
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
        s = String(s).trim();
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
  fs.writeFileSync(prodPath, JSON.stringify(prod, null, "\t"));
}

/** The exact checksum format VS Code expects: sha256, base64, no padding. */
function fileChecksum(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("base64")
    .replace(/=+$/, "");
}

// ------------------------------------------------------------------ cmds

/**
 * Remove every `wallpaper.*` copy so re-picking cannot leave orphans, and
 * return the (created) storage directory.
 */
function clearStoredWallpapers() {
  const dstDir = ctx.globalStorageUri.fsPath;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const f of fs.readdirSync(dstDir)) {
    if (/^wallpaper\./i.test(f)) {
      try {
        fs.unlinkSync(path.join(dstDir, f));
      } catch {
        /* best effort */
      }
    }
  }
  return dstDir;
}

/** Store the choice, patch the workbench and reload so it becomes visible. */
async function storeAndApply(dstDir, imageRel, label, info) {
  await ctx.globalState.update("image", imageRel);
  await ctx.globalState.update("imageInfo", info);

  // Picking a wallpaper means wanting to see it: re-enable if disabled.
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  if (!cfg.get("enabled", true)) {
    await cfg.update("enabled", true, vscode.ConfigurationTarget.Global);
  }

  try {
    await applyPatch();
  } catch (e) {
    vscode.window.showErrorMessage("Wallpaper failed to apply: " + (e && e.message));
    return false;
  }
  const size = info && info.width ? info.width + "×" + info.height + " · " + info.origin + " — " : "";
  vscode.window.showInformationMessage(
    (label ? label + " — " : "") +
      size +
      (options().liveApply ? "applied (live)." : "applied; the window reloads to show it.")
  );
  await settle();
  return true;
}

/**
 * Copy a still image into storage and describe it.
 * The real extension is kept: the file is served with a mime type derived
 * from its name, so storing JPEG bytes as "wallpaper.png" breaks it.
 */
function storeCopy(dstDir, src, origin) {
  const imageRel = "wallpaper" + (path.extname(src).toLowerCase() || ".png");
  fs.copyFileSync(src, path.join(dstDir, imageRel));
  const size = still.imageSize(src);
  return {
    imageRel,
    info: {
      origin,
      source: src,
      width: size ? size.width : null,
      height: size ? size.height : null,
    },
  };
}

/** A user-picked image file. */
async function setImageFromFile(src, label) {
  const dstDir = clearStoredWallpapers();
  const { imageRel, info } = storeCopy(dstDir, src, "file");
  return storeAndApply(dstDir, imageRel, label, info);
}

/**
 * Apply one Wallpaper Engine entry, preferring the sharpest source available:
 *   1. the full-resolution PNG inside a scene wallpaper's `scene.pkg`
 *      (the preview is a 801–1024 px thumbnail and looks cropped + compressed
 *      across a wide window);
 *   2. one decoded frame of a video wallpaper (the picker's Chromium);
 *   3. the preview image, or the wallpaper file itself when it is an image.
 *
 * @param {{file:string, preview?:string, dir?:string, name?:string}} entry
 */
async function applyWallpaperSource(entry) {
  const file = entry.file || entry.preview;
  if (!file || !fs.existsSync(file)) {
    vscode.window.showErrorMessage("Wallpaper file is missing: " + file);
    return false;
  }
  const dstDir = clearStoredWallpapers();
  const opts = options();
  const label = entry.name;

  // 1) scene package → its full-resolution artwork (cached across applies)
  const hi = opts.hires ? buildHiRes(entry, opts.maxImageWidth) : null;
  if (hi) {
    fs.copyFileSync(hi.file, path.join(dstDir, "wallpaper.png"));
    return storeAndApply(dstDir, "wallpaper.png", label, {
      origin: "scene.pkg",
      source: file,
      width: hi.width,
      height: hi.height,
    });
  }

  // 2) video → the frame the picker decoded (cached in the shared temp folder).
  //    The frame's own size is reported, never the square preview's.
  if (opts.videoFrames && still.VIDEO_EXT.test(file)) {
    const native = mp4.readVideoSize(file);
    const width = video.frameWidthForApply(opts.maxImageWidth, native && native.width);
    const frame = video.readVideoFrame(file, width);
    if (frame) {
      fs.writeFileSync(path.join(dstDir, "wallpaper.jpg"), frame.bytes);
      return storeAndApply(dstDir, "wallpaper.jpg", label, {
        origin: "video frame",
        source: file,
        width: frame.width,
        height: frame.height,
      });
    }
  }

  // 3) the still image itself: the preview when there is one, else the file
  const preview = entry.preview && fs.existsSync(entry.preview) ? entry.preview : null;
  const source = preview || file;
  if (!preview && !still.IMAGE_EXT.test(source)) {
    vscode.window.showErrorMessage(
      "无法从该壁纸取出静态图:场景包内没有可用的原图,视频壁纸的这一帧也还没解出来(在选择器里打开一次即可解码)。"
    );
    return false;
  }
  const copied = storeCopy(dstDir, source, preview ? "preview" : "file");
  return storeAndApply(dstDir, copied.imageRel, label, copied.info);
}

/** Choose a static image file from disk. */
async function pickAndApply() {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: false,
    openLabel: "Set as Wallpaper",
    // Static formats only: animated content repaints forever and lags.
    filters: { Images: ["jpg", "jpeg", "png", "bmp"] },
  });
  if (!picked || !picked.length) return;
  await setImageFromFile(picked[0].fsPath);
}

/** Human labels for where a wallpaper came from. */
const SOURCE_LABEL = { workshop: "创意工坊", mine: "我的项目", builtin: "内置" };

/** Wallpaper Engine install + how many wallpapers are downloaded. */
function weInfo() {
  try {
    const mod = require("./wallpaper-engine");
    const root = mod.weRoot();
    return { root, count: root ? mod.listDownloadedWallpapers().length : 0 };
  } catch {
    return { root: null, count: 0 };
  }
}

/**
 * Every Wallpaper Engine entry the picker offers: the wallpaper(s) playing
 * right now first, then every downloaded wallpaper.
 *
 * The preview file is only a thumbnail (801–1024 px). `file` is the wallpaper
 * itself — `scene.pkg` / video / image — which is what `applyWallpaperSource`
 * needs to reach the full-resolution artwork.
 *
 * @returns {{root:string, count:number, items:Array<object>}|null}
 */
function weEntries() {
  const mod = require("./wallpaper-engine");
  const root = mod.weRoot();
  if (!root) return null;
  const all = mod.listDownloadedWallpapers(true);
  const items = [];

  for (const cur of mod.currentWallpapers()) {
    if (!cur.preview) continue;
    items.push({
      current: true,
      title: path.basename(cur.preview, path.extname(cur.preview)),
      meta: "当前壁纸 · " + cur.monitor,
      detail: cur.file,
      file: cur.file,
      preview: cur.preview,
      dir: cur.dir || path.dirname(cur.file),
      name: "当前壁纸",
    });
  }
  for (const w of all) {
    items.push({
      current: false,
      title: w.title,
      meta: (w.type || "wallpaper") + " · " + (SOURCE_LABEL[w.source] || w.source),
      detail: w.dir,
      file: w.file || w.preview,
      preview: w.preview,
      dir: w.dir,
      name: w.title,
    });
  }
  return { root, count: all.length, items };
}

/**
 * The picker UI.
 *
 * A native `showQuickPick` renders `iconPath` at a fixed ~16 px, which is too
 * small to tell these wallpapers apart, and no API can enlarge it — so the
 * list is drawn as a webview: a responsive card grid, one card per wallpaper,
 * with the whole preview visible (`contain`, never cropped) above a two-line
 * title, the kind/source line and an apply button.
 */
function wePickerHtml(items, cspSource, opts) {
  const options_ = opts || options();
  const cards = items
    .map((item, i) => {
      const thumb = item.thumb && item.thumb.uri;
      // The picture always arrives as bytes (see `fill()`), so a card starts on
      // its placeholder and is replaced by a Blob URL — the same way the
      // Obsidian plugin draws a card. `data-i` lets the page report a failure
      // back by card.
      const shot = `<span class="thumb pending" data-i="${i}">…</span>`;
      // The artwork's own resolution, so a wallpaper that would render soft is
      // obvious before it is applied.
      const pixels =
        item.thumb && item.thumb.sourceWidth
          ? `<span class="px">${item.thumb.sourceWidth}×${item.thumb.sourceHeight}</span>`
          : "";
      return (
        `<button class="card" data-i="${i}" data-key="${escapeHtml(
          (item.title + " " + item.meta + " " + item.detail).toLowerCase()
        )}"${item.videoUri ? ` data-video="${escapeHtml(item.videoUri)}"` : ""} title="${escapeHtml(item.detail)}">` +
        `<span class="shot">${shot}${item.current ? '<span class="badge current">当前</span>' : ""}${pixels}</span>` +
        `<span class="title">${escapeHtml(item.title)}</span>` +
        `<span class="meta">${escapeHtml(item.meta)}</span>` +
        `<span class="apply">应用</span>` +
        `</button>`
      );
    })
    .join("\n");

  const flags = [
    options_.hires ? "场景包取原图" : "仅用预览图",
    options_.videoFrames ? "视频抽帧" : "视频用预览",
  ].join(" · ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource || ""} data: blob:; media-src ${cspSource || ""} blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${cspSource || ""};" />
<style>
  ${panelBaseCss()}
  body{max-width:none}
  header{display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:2;padding:2px 0 8px;
    background:var(--vscode-editor-background,transparent)}
  input[type=search]{flex:1;min-width:0;padding:6px 10px;border-radius:6px;border:1px solid var(--vscode-input-border,transparent);
    background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-family:inherit;font-size:13px}
  #count{font-size:12px;color:var(--vscode-descriptionForeground);white-space:nowrap}
  /* Responsive grid: as many whole-image cards as the panel width allows. */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(212px,1fr));gap:12px;margin-top:4px}
  .card{display:flex;flex-direction:column;gap:7px;padding:10px;margin:0;cursor:pointer;text-align:left;
    border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:10px;
    background:var(--vscode-editorWidget-background,rgba(127,127,127,.07));color:var(--vscode-foreground);font-family:inherit}
  .card:hover{border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground)}
  .card:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
  .shot{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:16/9;
    border-radius:8px;overflow:hidden;background:#0b0d12}
  /* contain, not cover: the artwork keeps its own aspect ratio instead of
     being cropped into a square (Wallpaper Engine's preview is 1:1). */
  .shot img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block}
  .thumb.pending{font-size:16px;color:var(--vscode-descriptionForeground)}
  .thumb.missing{font-size:11px;color:var(--vscode-descriptionForeground);text-align:center;padding:0 8px}
  .badge.current{position:absolute;top:6px;right:6px;margin:0;padding:1px 7px;border-radius:999px;
    font-size:10px;background:var(--vscode-badge-background,#c33);color:var(--vscode-badge-foreground,#fff)}
  .px{position:absolute;left:6px;bottom:6px;padding:1px 6px;border-radius:999px;font-size:10px;
    background:rgba(0,0,0,.55);color:#fff}
  .title{font-size:13px;font-weight:600;line-height:1.4;overflow:hidden;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .meta{font-size:11.5px;line-height:1.3;color:var(--vscode-descriptionForeground);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .apply{margin-top:auto;padding:5px 0;border-radius:6px;text-align:center;font-size:12px;
    background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  .card:hover .apply{background:var(--vscode-button-hoverBackground,var(--vscode-button-background))}
  .hidden{display:none}
  /* The element a video frame is decoded through. It must stay *in the
     document* (a detached <video> never decodes) and out of the way: off the
     left edge rather than display:none, which would stop the decode. */
  .wallvia-video-probe{position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none}
  #empty{padding:24px 4px;color:var(--vscode-descriptionForeground);font-size:13px;display:none}
</style>
</head>
<body>
  <header>
    <input id="q" type="search" placeholder="搜索标题 / 类型 / 路径…" autofocus />
    <span id="count"></span>
    <button id="pickFile">选择本地图片…</button>
  </header>
  <p class="hint" id="tip">${flags};点卡片即应用,缩略图在后台逐张生成。</p>
  <div class="grid" id="grid">
${cards}
  </div>
  <p id="empty">没有匹配的壁纸。</p>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const cards = [...document.querySelectorAll(".card")];

  function filter() {
    const q = $("q").value.trim().toLowerCase();
    let shown = 0;
    for (const el of cards) {
      const hit = !q || el.dataset.key.includes(q);
      el.classList.toggle("hidden", !hit);
      if (hit) shown += 1;
    }
    $("count").textContent = shown + " / " + cards.length;
    $("empty").style.display = shown ? "none" : "block";
    $("tip").style.display = q ? "none" : "block";
  }

  for (const el of cards) {
    el.addEventListener("click", () => vscode.postMessage({ type: "choose", index: Number(el.dataset.i) }));
  }

  // Video frames are decoded here, in the host's Chromium — the same trick the
  // Obsidian plugin uses. The element is off screen but *in the document*: a
  // detached one never decodes. Progress is driven by loadeddata/seeked rather
  // than requestAnimationFrame, because a hidden element is throttled and rAF
  // may never run while those events still fire.
  async function decodeFrame(url, width) {
    const el = document.createElement("video");
    el.muted = true;
    el.preload = "auto";
    el.className = "wallvia-video-probe";
    document.body.appendChild(el);
    try {
      const loaded = await new Promise((resolve) => {
        // A local video reports loadeddata in well under a second. This only has
        // to cover a stall, and it is deliberately short: the caller retries, and
        // every extra second is a card sitting on its placeholder.
        const timer = setTimeout(() => resolve(false), 6000);
        const done = (ok) => { clearTimeout(timer); resolve(ok); };
        el.addEventListener("loadeddata", () => done(true), { once: true });
        el.addEventListener("error", () => done(false), { once: true });
        el.src = url;
      });
      if (!loaded || !el.videoWidth || !el.videoHeight) return null;
      // A frame at the very start is often a fade-in or a title card.
      const target = Math.min(2, Math.max(0, (el.duration || 0) - 0.1));
      if (target > 0) {
        const seeked = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 6000);
          el.addEventListener("seeked", () => { clearTimeout(timer); resolve(true); }, { once: true });
          el.currentTime = target;
        });
        if (!seeked) return null;
      }
      // Never upscale: a small video keeps its own size.
      const scale = Math.min(1, width / el.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      // JPEG, not PNG: a 1080p frame is ~0.3 MB against several MB.
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      const comma = dataUrl.indexOf(",");
      return comma < 0 ? null : dataUrl.slice(comma + 1);
    } catch {
      return null;
    } finally {
      el.remove();
    }
  }

  window.addEventListener("message", async (e) => {
    const msg = e.data;
    if (msg.type === "needFrame") {
      const card = cards[msg.index];
      const url = card && card.dataset.video;
      const base64 = url ? await decodeFrame(url, msg.width) : null;
      vscode.postMessage({ type: "frame", index: msg.index, width: msg.width, base64 });
      return;
    }
    if (msg.type !== "thumb") return;
    const card = cards[msg.index];
    if (!card) return;
    const shot = card.querySelector(".shot");
    // Never leave a card at "…": a picture that cannot be turned into an image
    // is a failure to show, not a reason to look like it is still working.
    const fail = (text) => {
      const span = document.createElement("span");
      span.className = "thumb missing";
      span.textContent = text;
      const old = shot.querySelector(".thumb");
      if (old) old.replaceWith(span); else shot.prepend(span);
      // Tell the extension so it can drop the bad cache entry and try again.
      vscode.postMessage({ type: "thumbFailed", index: msg.index });
    };
    let url = null;
    if (msg.base64) {
      try {
        const binary = atob(msg.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        url = URL.createObjectURL(new Blob([bytes], { type: msg.mime || "image/jpeg" }));
      } catch {
        url = null;
      }
    }
    if (!url && msg.thumb && msg.thumb.uri) url = msg.thumb.uri;
    if (!url) {
      fail("预览不可用");
      return;
    }
    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    img.setAttribute("data-i", String(msg.index));
    img.addEventListener("error", () => fail("预览无法读取"));
    img.src = url;
    const old = shot.querySelector(".thumb");
    if (old) {
      // Release the previous Blob so a re-opened picker does not pile them up.
      const previous = old.tagName === "IMG" ? old.getAttribute("src") : "";
      if (previous && previous.startsWith("blob:")) URL.revokeObjectURL(previous);
      old.replaceWith(img);
    } else {
      shot.prepend(img);
    }
    if (msg.thumb && msg.thumb.sourceWidth) {
      const px = document.createElement("span");
      px.className = "px";
      px.textContent = msg.thumb.sourceWidth + "×" + msg.thumb.sourceHeight;
      shot.appendChild(px);
    }
  });

  // Release the Blob URLs when the picker goes away.
  window.addEventListener("unload", () => {
    for (const img of document.querySelectorAll("img.thumb")) {
      const src = img.getAttribute("src") || "";
      if (src.startsWith("blob:")) URL.revokeObjectURL(src);
    }
  });

  $("q").addEventListener("input", filter);
  $("q").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = cards.find((el) => !el.classList.contains("hidden"));
    if (first) vscode.postMessage({ type: "choose", index: Number(first.dataset.i) });
  });
  $("pickFile").onclick = () => vscode.postMessage({ type: "pickFile" });
  filter();
  $("q").focus();
</script>
</body>
</html>`;
}

/** The MIME type for a cached picture, from its extension. */
function mimeFor(file) {
  switch (path.extname(String(file || "")).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".avif":
      return "image/avif";
    default:
      return "image/jpeg";
  }
}

/** Escape text that goes into the picker's HTML. */
function escapeHtml(s) {  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function clearWallpaper() {
  await ctx.globalState.update("image", null);
  await ctx.globalState.update("imageInfo", null);
  // Drop the stored copy as well: "remove" must leave nothing behind, and a
  // leftover file would otherwise be re-adopted by the self-healing lookup.
  clearStoredWallpapers();
  try {
    await applyPatch();
    vscode.window.showInformationMessage("Wallpaper removed; the window reloads.");
  } catch (e) {
    vscode.window.showErrorMessage("Failed to remove wallpaper: " + (e && e.message));
  }
  await settle();
}

async function toggleGlass() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  const mode = cfg.get("mode", "glass");
  await cfg.update("mode", mode === "glass" ? "fade" : "glass", vscode.ConfigurationTarget.Global);
  await applyPatch();
  await settle();
}

function maybeReload() {
  // workbench.html is read once per window; only a reload picks up the css.
  return vscode.commands.executeCommand("workbench.action.reloadWindow").then(
    () => undefined,
    () => undefined
  );
}

/**
 * Make a fresh patch visible.
 *
 * With live apply on, the injected script swaps the stylesheet about two
 * seconds later, so the window is left alone (no interruption, no lost panel
 * state). Fall back to a real reload, which is the only other way.
 */
function settle() {
  return options().liveApply ? Promise.resolve() : maybeReload();
}

// ---------------------------------------------------------------- status

function statusString() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  const htmlPath = findWorkbenchHtml(vscode.env.appRoot);
  let patched = false;
  let patchMtime = 0;
  if (htmlPath && fs.existsSync(htmlPath)) {
    try {
      patched = fs.readFileSync(htmlPath, "utf8").includes(MARK_START);
      patchMtime = fs.statSync(htmlPath).mtimeMs;
    } catch {
      /* best effort */
    }
  }
  const imageRel = ctx.globalState.get("image", null);
  const imageAbs = imageRel ? path.join(ctx.globalStorageUri.fsPath, imageRel) : null;
  const info = ctx.globalState.get("imageInfo", null);
  return {
    enabled: cfg.get("enabled", true),
    patched,
    appliedVersion: ctx.globalState.get("appliedVersion", null),
    version: vscode.version,
    image: imageAbs && fs.existsSync(imageAbs) ? imageAbs : null,
    // Where the painted image came from: the full-resolution artwork inside a
    // scene package, a decoded video frame, a preview thumbnail or a file.
    imageInfo: info || (imageAbs && fs.existsSync(imageAbs) ? { origin: "unknown", source: imageAbs } : null),
    config: {
      enabled: cfg.get("enabled", true),
      dim: cfg.get("dim", 45),
      glass: cfg.get("glass", 55),
      // `blur` is deliberately absent: it is a deprecated key that changes
      // nothing, so the panel is not told about it at all.
      mode: cfg.get("mode", "glass"),
      fit: cfg.get("fit", "cover"),
      hires: cfg.get("hires", true),
      videoFrames: cfg.get("videoFrames", true),
      liveApply: cfg.get("liveApply", true),
      themeAware: cfg.get("themeAware", true),
      maxImageWidth: cfg.get("maxImageWidth", 0),
    },
    we: weInfo(),
    // A patch written after this window's extension host came up is on disk
    // but invisible until the window reloads.
    reloadNeeded: activatedAt > 0 && patchMtime > activatedAt,
    patchMtime,
  };
}

// ------------------------------------------------------------------ panel

/**
 * Styling shared by both panels (settings + picker): one type scale, one card
 * and control look, so the two surfaces cannot drift apart.
 */
function panelBaseCss() {
  return `
  :root{--thumb-w:148px;--thumb-h:83px}
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:14px 16px;
    max-width:560px;min-width:420px;min-height:320px;box-sizing:border-box}
  h1{font-size:15px;font-weight:600;margin:0 0 4px}
  p.hint{color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.5;margin:0 0 14px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0}
  .row label{font-size:12px;min-width:110px}
  input[type=range]{flex:1}
  .val{font-size:12px;min-width:46px;text-align:right;color:var(--vscode-descriptionForeground)}
  button{padding:6px 12px;margin:4px 6px 4px 0;cursor:pointer;border-radius:6px;
    border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground,transparent);
    color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));font-family:inherit;font-size:12px}
  button:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(127,127,127,.2))}
  .card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:12px;margin:10px 0}
  .badge{font-size:11px;padding:2px 8px;border-radius:999px;margin-left:8px}
  .badge.ok{background:#1f8f4d33;color:#2ea043}
  .badge.no{background:#f8514933;color:#f85149}
  #reloadNote{color:var(--vscode-editorWarning-foreground,#cca700)}`;
}

/**
 * Settle a panel exactly once: reveal it when it is already open, otherwise
 * create it. Returns null when the caller should reuse the open panel.
 *
 * `reveal()` is allowed to fail: a panel kept in the slot can have been
 * disposed behind our back (the tab was closed while the extension host was
 * down, or the window reloaded), and VS Code then throws "Webview is disposed".
 * Treating that as "no usable panel" is what keeps the command working instead
 * of failing with no visible effect.
 */
function claimPanel(slot, viewType, title, options) {
  const existing = slot.get();
  if (existing) {
    try {
      if (typeof existing.reveal === "function") {
        existing.reveal();
        return null;
      }
    } catch {
      /* disposed: fall through and build a fresh panel */
    }
    slot.set(null);
  }
  const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active || 1, {
    enableScripts: true,
    retainContextWhenHidden: true,
    ...options,
  });
  slot.set(panel);
  if (typeof panel.onDidDispose === "function") {
    panel.onDidDispose(() => {
      if (slot.get() === panel) slot.set(null);
    });
  }
  return panel;
}

/** Subscribe a webview message handler and keep it disposable. */
function onPanelMessage(panel, handler) {
  const disposable = panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      await handler(msg);
    } catch (e) {
      vscode.window.showErrorMessage("Wallvia: " + (e && e.message));
    }
  });
  if (disposable && typeof disposable.dispose === "function") {
    ctx.subscriptions.push(disposable);
  }
  return disposable || null;
}

/**
 * One message handler per panel.
 *
 * A panel can be re-initialised (re-opened after a reload, or refreshed when
 * the wallpaper list changed). Registering a second handler would leave the
 * first one alive with its stale item list, so the previous subscription is
 * dropped instead.
 */
const panelHandlers = new WeakMap();

function subscribePanel(panel, handler) {
  const previous = panelHandlers.get(panel);
  if (previous && typeof previous.dispose === "function") previous.dispose();
  const disposable = onPanelMessage(panel, handler);
  if (disposable) panelHandlers.set(panel, disposable);
}

/** Holder for a single-instance panel (the test double has no `reveal`). */
function panelSlot() {
  let panel = null;
  return {
    get: () => panel,
    set: (value) => {
      panel = value;
    },
  };
}

const settingsSlot = panelSlot();
const pickerSlot = panelSlot();

/**
 * The folders a webview must be allowed to read: the Wallpaper Engine root
 * (workshop + own projects), the extension's own storage, the folder of every
 * preview, the folder of every video, and the shared video-frame cache.
 *
 * Missing any of them does not throw — the image simply never loads, which is
 * how a whole grid of video cards once sat at "…" forever.
 */
function pickerRoots(info) {
  const roots = new Map();
  const add = (p) => {
    if (!p) return;
    try {
      roots.set(p.toLowerCase(), vscode.Uri.file(p));
    } catch {
      /* a path that cannot be turned into a Uri is simply not offered */
    }
  };
  add(ctx.globalStorageUri.fsPath);
  add(info.root);
  // Decoded frames live outside the extension storage (and are shared with the
  // Obsidian plugin), so the frame folder has to be offered explicitly.
  add(video.stillsDir());
  for (const item of info.items) {
    if (item.preview) add(path.dirname(item.preview));
    // A video card loads the video itself (that is where the frame is decoded),
    // so its folder has to be readable by the webview as well.
    if (item.file && still.VIDEO_EXT.test(item.file)) add(path.dirname(item.file));
  }
  return [...roots.values()];
}

/** Pick one of the wallpapers Wallpaper Engine has already downloaded. */
function createWePicker() {
  const info = weEntries();
  if (!info) {
    vscode.window.showErrorMessage(
      "未检测到 Wallpaper Engine(仅 Windows 桌面端)。可以改用 “Wallvia: Choose Image File…”。"
    );
    return null;
  }
  const panel = claimPanel(pickerSlot, "wallviaPicker", "Wallvia · 选择壁纸", {
    // Without these roots a webview may not load a single one of the
    // thumbnails: by default only the extension folder is allowed, and the
    // previews live in the Steam workshop / projects folders.
    localResourceRoots: pickerRoots(info),
  });
  // `claimPanel` returns null when the panel was already open: refresh it
  // instead of leaving the list as it was (a wallpaper added since, a cache
  // that was cleared, a thumbnail that failed to build).
  return initPickerPanel(panel || pickerSlot.get(), info);
}

/**
 * Render the picker into `panel`, then fill its thumbnails in the background.
 *
 * Extracting a scene package's mipmap takes a few dozen milliseconds and the
 * packages can be hundreds of megabytes, so the grid paints first with whatever
 * is already cached and every remaining card is filled in one at a time: the
 * panel stays responsive and the results persist in the cache.
 */
function initPickerPanel(panel, info) {
  const webview = panel.webview;
  const opts = options();
  const toUri = (file) => {
    try {
      return typeof webview.asWebviewUri === "function"
        ? String(webview.asWebviewUri(vscode.Uri.file(file)))
        : null;
    } catch {
      return null;
    }
  };

  const items = info.items.map((item) => {
    const cached = cachedThumb(item);
    const isVideo = still.VIDEO_EXT.test(item.file || "");
    const wantsFrame = isVideo && opts.videoFrames;
    // A video card has to show a decoded 16:9 frame with the video's own
    // resolution — exactly what a scene card does with its artwork. A thumb
    // cached by an earlier version came from Wallpaper Engine's square preview,
    // so it is ignored (and the picker decodes a frame instead); only a
    // frame-origin thumb is good enough.
    //
    // `cached` itself, not the comparison: `cached && cached.origin === "video
    // frame"` evaluates to a *boolean*, and a boolean in place of the entry made
    // every video card try to read the picture of `true` — which is why they sat
    // on their placeholder while every other card filled in.
    const usable = wantsFrame ? (cached && cached.origin === "video frame" ? cached : null) : cached;
    return {
      ...item,
      // A video card needs the webview to be able to load the *video* itself:
      // that is where the frame gets decoded, and a video is far too large to
      // send over `postMessage`.
      videoUri: wantsFrame ? toUri(item.file) : null,
      // The card's picture is sent as bytes by `fill()`, so the entry is only
      // metadata for the resolution pill until then. Bytes rather than a path to
      // the picture, which is how the Obsidian plugin draws a card: one less
      // thing (a resource root, a webview URL) that can fail on its own.
      thumb: usable,
    };
  });
  webview.html = wePickerHtml(items, webview.cspSource, opts);
  log(
    `picker: ${items.length} wallpapers, ${items.filter((i) => !i.thumb).length} without a cached picture`
  );

  const fill = async (index) => {
    const item = items[index];
    if (!item) return;
    const native = item.file ? mp4.readVideoSize(item.file) : null;
    // A cached picture is reused as it is; only a missing one is built.
    let thumb = item.thumb;
    // Guard the shape, not just the truthiness: a boolean (or any object without
    // a path) used to slip through here and produce "picture unreadable" cards.
    if (thumb && typeof thumb.file !== "string") {
      log(`picker: card ${index} cached entry has no path (${typeof thumb}) — rebuilding`);
      thumb = null;
      item.thumb = null;
    }
    if (!thumb) {
      try {
        thumb = buildThumb(item, opts);
      } catch (e) {
        log(`picker: card ${index} build failed: ${(e && e.message) || e}`);
      }
    }
    if (!thumb && item.videoUri) {
      // No cached frame: ask the webview's Chromium to decode one, then store it
      // exactly like the Obsidian side does.
      const width = video.frameWidthForCard(opts.maxImageWidth);
      const stored = await decodeCardFrame(panel, index, width, item.file);
      if (stored) {
        thumb = { ...stored, sourceWidth: native ? native.width : stored.width, sourceHeight: native ? native.height : stored.height };
      } else {
        // The decode failed (codec, unreadable file, dead panel): keep the square
        // preview rather than an empty card, but report the video's own size —
        // the resolution never falls back to the preview's.
        const fallback = buildThumb(item, { ...opts, videoFrames: false });
        log(`picker: card ${index} frame decode failed -> preview fallback ${fallback ? "ok" : "none"}`);
        if (fallback) {
          thumb = {
            ...fallback,
            sourceWidth: native ? native.width : fallback.sourceWidth,
            sourceHeight: native ? native.height : fallback.sourceHeight,
          };
        }
      }
    }
    if (!thumb) {
      log(`picker: card ${index} has no thumbnail`);
      return;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(thumb.file);
    } catch (e) {
      log(`picker: card ${index} picture unreadable: ${(e && e.message) || e}`);
      return;
    }
    item.thumb = thumb;
    try {
      // Bytes, not a path — the same thing the Obsidian plugin hands its
      // renderer, and the reason this cannot be blocked by a resource root.
      webview.postMessage({
        type: "thumb",
        index,
        thumb: {
          width: thumb.width,
          height: thumb.height,
          sourceWidth: thumb.sourceWidth,
          sourceHeight: thumb.sourceHeight,
        },
        base64: bytes.toString("base64"),
        mime: mimeFor(thumb.file),
      });
    } catch {
      /* the panel is gone */
    }
  };

  // Every card is drawn from bytes the extension sends, so every card is filled
  // — a cache hit only skips the work of building the picture again.
  const pending = items.slice();
  const pump = () => {
    const item = pending.shift();
    if (!item) return;
    void fill(items.indexOf(item)).finally(() => setTimeout(pump, 0));
  };
  if (pending.length) setTimeout(pump, 0);

  subscribePanel(panel, async (msg) => {
    if (msg.type === "frame") {
      const settle = pendingFrames.get(msg.index + "|" + msg.width);
      if (settle) settle(msg);
      return;
    }
    if (msg.type === "thumbFailed") {
      const index = Number(msg.index);
      const item = items[index];
      log(`picker: card ${index} image failed to display`);
      // An image the webview cannot show means the cache entry is unusable, so
      // it is dropped and the card is built once more (a fresh decode for a
      // video) instead of leaving a broken box behind. One retry per card.
      if (item && !item.retried) {
        item.retried = true;
        dropCachedThumb(item);
        item.thumb = null;
        await fill(index);
      }
      return;
    }
    if (msg.type === "choose") {
      const chosen = items[Number(msg.index)];
      if (!chosen) return;
      // Decode before disposing: the webview is the decoder, and it is only
      // alive while the picker is on screen.
      if (chosen.videoUri && opts.videoFrames) {
        const file = chosen.file;
        const native = mp4.readVideoSize(file);
        const width = video.frameWidthForApply(opts.maxImageWidth, native && native.width);
        if (!video.readVideoFrame(file, width)) {
          const frame = await requestFrame(panel, Number(msg.index), width);
          if (frame) video.writeVideoFrame(file, frame.base64, frame.width);
        }
      }
      if (typeof panel.dispose === "function") panel.dispose();
      await applyWallpaperSource(chosen);
    } else if (msg.type === "pickFile") {
      if (typeof panel.dispose === "function") panel.dispose();
      await pickAndApply();
    }
  });
  return panel;
}

/**
 * A video card's frame: decode it in the webview, retry once after a pause, and
 * store it in the shared cache.
 *
 * The retry exists because a large file can still be opening when the first
 * request arrives, and falling back to Wallpaper Engine's square preview is
 * exactly what this path exists to avoid. `null` when both attempts fail.
 *
 * @param {string} videoPath absolute path of the video being shown
 * @returns {Promise<{file:string, bytes:Buffer, width:number, height:number, ext:string}|null>}
 */
async function decodeCardFrame(panel, index, width, videoPath) {
  let decoded = await requestFrame(panel, index, width);
  if (!decoded) {
    await new Promise((resolve) => setTimeout(resolve, FRAME_RETRY_DELAY_MS));
    decoded = await requestFrame(panel, index, width);
  }
  return decoded ? video.writeVideoFrame(videoPath, decoded.base64, decoded.width) : null;
}

/**
 * Ask the picker's webview to decode one video frame.
 *
 * The reply arrives as a `frame` message; this resolves with it, or with null
 * when the webview answers with a failure or stays silent past `timeoutMs`
 * (a codec the build lacks, a file the webview may not read, a dead panel).
 *
 * @returns {Promise<{base64:string, width:number}|null>}
 */
function requestFrame(panel, index, width) {
  const key = index + "|" + width;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingFrames.delete(key);
      resolve(null);
    }, FRAME_TIMEOUT_MS);
    pendingFrames.set(key, (msg) => {
      clearTimeout(timer);
      pendingFrames.delete(key);
      resolve(msg && msg.base64 ? { base64: msg.base64, width: Number(msg.width) || width } : null);
    });
    try {
      panel.webview.postMessage({ type: "needFrame", index, width });
    } catch {
      clearTimeout(timer);
      pendingFrames.delete(key);
      resolve(null);
    }
  });
}

/** Frames the extension is waiting for, keyed by `index|width`. */
const pendingFrames = new Map();

/** A thumbnail already in the cache — no package is opened just to look. */
function cachedThumb(entry) {
  return readCached(thumbCacheDir(), thumbKey(entry));
}

/**
 * Remove one wallpaper's cached thumbnail (image + sidecar).
 *
 * Used when the webview reports that the image cannot be loaded: the entry is
 * unusable, and keeping it would make the card fail the same way forever.
 */
function dropCachedThumb(entry) {
  const dir = thumbCacheDir();
  const base = thumbKey(entry);
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(base)) continue;
      fs.rmSync(path.join(dir, name), { force: true });
      removed += 1;
    }
  } catch {
    /* nothing to drop */
  }
  log(`picker: dropped ${removed} cached file(s) for ${path.basename(entry.file || "?")}`);
}

/**
 * Drop cache entries nothing has looked at for two months.
 *
 * Every wallpaper a user tries leaves a thumbnail and possibly a full-size
 * artwork behind, and the key changes whenever the source does (a re-resolved
 * file, an updated workshop item), so without this the cache only grows.
 */
function pruneThumbCache(maxAgeDays = 60) {
  const dir = path.join(ctx.globalStorageUri.fsPath, THUMB_DIRNAME);
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs >= cutoff) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      /* a file that cannot be removed is not worth failing activation over */
    }
  }
  return removed;
}

function createPanel() {
  const panel = claimPanel(settingsSlot, "wallviaSettings", "Wallvia 壁纸设置");
  if (!panel) return settingsSlot.get();
  return initSettingsPanel(panel);
}

/** Render the settings panel into `panel` and subscribe its messages. */
function initSettingsPanel(panel) {
  panel.webview.html = panelHtml(panel.webview.cspSource);

  const sendStatus = () => {
    try {
      panel.webview.postMessage({ type: "status", status: statusString() });
    } catch {
      /* panel gone */
    }
  };

  subscribePanel(panel, async (msg) => {
    if (msg.type === "pick") {
      await pickAndApply();
      sendStatus();
    } else if (msg.type === "we") {
      createWePicker();
    } else if (msg.type === "clear") {
      await clearWallpaper();
      sendStatus();
    } else if (msg.type === "config") {
      const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
      await cfg.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
      await applyPatch().catch(() => undefined);
      sendStatus();
    } else if (msg.type === "reload") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } else if (msg.type === "status") {
      sendStatus();
    }
  });
  sendStatus();
  return panel;
}

function panelHtml(cspSource) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${cspSource || ""};" />
<style>
  ${panelBaseCss()}
</style>
</head>
<body>
  <h1>Wallvia <span id="badge"></span></h1>
  <p class="hint">静态壁纸(JPG/PNG/BMP),画在整个窗口底层;更改写入 wallvia-bg.css,重载窗口后生效。</p>

  <div class="card">
    <div class="row"><button id="pick">选择本地图片…</button><button id="we">从 Wallpaper Engine 选择…</button><button id="clear">移除</button></div>
    <p class="hint" id="weInfo"></p>
    <p class="hint" id="srcInfo"></p>
  </div>

  <div class="card">
    <div class="row"><label for="enabled">Enabled</label><input type="checkbox" id="enabled" /></div>
    <div class="row"><label for="dim">压暗 Deep</label><input type="range" id="dim" min="0" max="80" step="1" /><span class="val" id="dimVal"></span></div>
    <div class="row"><label for="glass">通透 Glass</label><input type="range" id="glass" min="0" max="100" step="1" /><span class="val" id="glassVal"></span></div>
    <p class="hint">模糊 Blur:<b>本版本不做</b>。任何 <code>backdrop-filter</code> 都会让 Chromium 每帧重绘整个窗口
      (实测明显卡顿),所以毛玻璃只由「透明 + 洗色」构成,没有光学模糊。老的 <code>wallvia.blur</code> 配置会被忽略。</p>
    <div class="row"><label for="fit">Fit</label>
      <select id="fit"><option value="cover">覆盖 Cover(填满,可能裁边)</option><option value="contain">包含 Contain(不裁剪,留边)</option><option value="fill">填充 Fill(拉伸)</option><option value="center">居中 Center(原始大小)</option></select></div>
    <div class="row"><label for="mode">Mode</label>
      <select id="mode"><option value="glass">Glass (translucent)</option><option value="fade">Fade (light overlay)</option></select></div>
  </div>

  <div class="card">
    <div class="row"><label for="hires">场景包取原图</label><input type="checkbox" id="hires" /></div>
    <div class="row"><label for="videoFrames">视频抽帧</label><input type="checkbox" id="videoFrames" /></div>
    <div class="row"><label for="liveApply">改完即时生效</label><input type="checkbox" id="liveApply" /></div>
    <div class="row"><label for="themeAware">跟随主题明暗</label><input type="checkbox" id="themeAware" /></div>
    <div class="row"><label for="maxImageWidth">最大图源宽度</label><input type="number" id="maxImageWidth" min="0" max="7680" step="160" /><span class="val">px</span></div>
    <p class="hint">关闭"即时生效"后,改动需要点下面的按钮重载窗口才会出现。最大图源宽度 0 = 用最清晰的一级(显存占用最大,4K 图约 33MB)。</p>
  </div>
  <p class="hint" id="reloadNote">更改已写入磁盘 — 需要重载窗口才能看到。</p>
  <button id="reload">立即重载窗口</button>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  function setRange(id, v, unit) {
    const el = $(id + "Val");
    if (el) el.textContent = v + unit;
  }

  function render(s) {
    const cfg = s.config;
    $("badge").textContent = s.patched ? "已注入" : "未注入";
    $("badge").className = "badge " + (s.patched ? "ok" : "no");
    for (const key of ["enabled", "hires", "videoFrames", "liveApply", "themeAware"]) {
      $(key).checked = cfg[key] !== false;
    }
    $("dim").value = cfg.dim; setRange("dim", cfg.dim, "%");
    $("glass").value = cfg.glass; setRange("glass", cfg.glass, "%");
    $("fit").value = cfg.fit;
    $("mode").value = cfg.mode;
    $("maxImageWidth").value = cfg.maxImageWidth || 0;
    $("weInfo").textContent = s.we && s.we.root
      ? "Wallpaper Engine: 已找到 " + s.we.count + " 张已下载壁纸"
      : "未检测到 Wallpaper Engine(仅 Windows 桌面端可用)";
    const info = s.imageInfo;
    $("srcInfo").textContent = info
      ? "当前图源:" + (info.width ? info.width + "×" + info.height + " · " : "") + (info.origin || "?") +
        (info.width && info.width < 1920 ? " — 分辨率偏低,场景包内大图未能取出" : "")
      : "";
    $("reloadNote").style.display = s.reloadNeeded ? "" : "none";
  }

  $("reload").onclick = () => vscode.postMessage({ type: "reload" });
  $("pick").onclick = () => vscode.postMessage({ type: "pick" });
  $("we").onclick = () => vscode.postMessage({ type: "we" });
  $("clear").onclick = () => vscode.postMessage({ type: "clear" });
  // Commit on "change", not "input": dragging a slider must not rewrite the
  // config + css for every pixel of the drag.
  const wire = (id, key) => $(id).addEventListener("change", (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked
      : (key === "fit" || key === "mode" ? e.target.value : Number(e.target.value));
    vscode.postMessage({ type: "config", key, value: v });
  });
  wire("enabled", "enabled");
  wire("dim", "dim");
  wire("glass", "glass");
  // No blur wiring: the setting is deprecated, and the panel says so instead of
  // offering a slider that would change nothing.
  wire("fit", "fit");
  wire("mode", "mode");
  wire("hires", "hires");
  wire("videoFrames", "videoFrames");
  wire("liveApply", "liveApply");
  wire("themeAware", "themeAware");
  wire("maxImageWidth", "maxImageWidth");

  window.addEventListener("message", (e) => { if (e.data.type === "status") render(e.data.status); });
  vscode.postMessage({ type: "status" });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------- activate

/**
 * Restore the original workbench.html from the backup Wallvia keeps.
 *
 * The escape hatch for "I want my install back": it also drops the generated
 * stylesheet, the live-apply script and the stamp file so nothing of ours is
 * left behind, and fixes the checksum on the restored file.
 */
async function restoreWorkbench() {
  const appRoot = vscode.env.appRoot;
  const htmlPath = findWorkbenchHtml(appRoot);
  if (!htmlPath) {
    vscode.window.showErrorMessage("Wallvia: could not locate workbench.html.");
    return false;
  }
  const bakPath = htmlPath + ".wallvia.bak";
  const dir = path.dirname(htmlPath);
  if (fs.existsSync(bakPath)) {
    fs.copyFileSync(bakPath, htmlPath);
  } else {
    const html = fs.readFileSync(htmlPath, "utf8");
    const cleaned = html.replace(/<!-- wallvia:start -->[\s\S]*?<!-- wallvia:end -->/g, "");
    if (cleaned !== html) fs.writeFileSync(htmlPath, cleaned);
  }
  for (const name of [CSS_FILENAME, LIVE_FILENAME, STAMP_FILENAME]) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  const prodPath = path.join(appRoot, "product.json");
  if (fs.existsSync(prodPath)) {
    fixChecksum(prodPath, checksumKeyFor(htmlPath, appRoot), htmlPath);
  }
  vscode.window.showInformationMessage("Wallvia: workbench.html 已还原,重载窗口后生效。");
  return true;
}

/**
 * Warn once when another wallpaper extension is configured at the same time:
 * two of them patch the same surfaces and overwrite each other.
 */
function warnAboutConflicts() {
  try {
    const other =
      vscode.extensions && typeof vscode.extensions.getExtension === "function"
        ? vscode.extensions.getExtension("katsute.code-background")
        : null;
    if (!other) return;
    const cfg = vscode.workspace.getConfiguration("background");
    const list = cfg && typeof cfg.get === "function" ? cfg.get("windowBackgrounds", []) : [];
    if (!Array.isArray(list) || !list.length) return;
    vscode.window.showWarningMessage(
      "Wallvia: 检测到 code-background 也在设置窗口背景,两个壁纸插件会互相覆盖,建议只保留一个。",
      "知道了"
    );
  } catch {
    /* the check is advisory */
  }
}

/** @param {import('vscode').ExtensionContext} context */
async function activate(context) {
  ctx = context;
  activatedAt = Date.now();
  try {
    channel = vscode.window.createOutputChannel("Wallvia");
    context.subscriptions.push(channel);
  } catch {
    /* the log file still gets everything */
  }
  log(`activate: extension ${context.extension && context.extension.packageJSON ? context.extension.packageJSON.version : "?"}`);
  context.subscriptions.push(
    vscode.commands.registerCommand("wallvia.set", pickAndApply),
    vscode.commands.registerCommand("wallvia.pickWE", createWePicker),
    vscode.commands.registerCommand("wallvia.clear", clearWallpaper),
    vscode.commands.registerCommand("wallvia.toggleGlass", toggleGlass),
    vscode.commands.registerCommand("wallvia.openUI", createPanel),
    vscode.commands.registerCommand("wallvia.restore", restoreWorkbench),
    vscode.commands.registerCommand("wallvia.status", () =>
      vscode.window.showInformationMessage(JSON.stringify(statusString(), null, 2))
    )
  );

  // settings.json edits apply too (the test double has no event API).
  if (typeof vscode.workspace.onDidChangeConfiguration === "function") {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e || typeof e.affectsConfiguration !== "function" || e.affectsConfiguration(CONFIG_KEY)) {
          applyPatch().catch(() => undefined);
        }
      })
    );
  }

  // Panels survive a window reload only when they can rebuild themselves.
  if (typeof vscode.window.registerWebviewPanelSerializer === "function") {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer("wallviaSettings", {
        deserializeWebviewPanel: async (panel) => {
          settingsSlot.set(panel);
          initSettingsPanel(panel);
        },
      }),
      vscode.window.registerWebviewPanelSerializer("wallviaPicker", {
        deserializeWebviewPanel: async (panel) => {
          pickerSlot.set(panel);
          const info = weEntries();
          if (info) initPickerPanel(panel, info);
        },
      })
    );
  }

  warnAboutConflicts();
  pruneThumbCache();

  // Auto re-apply when the patch on disk is stale: a VS Code update wipes it,
  // and an extension update changes the generated css itself.
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  if (cfg.get("autoReapply", true) && ctx.globalState.get("image", null)) {
    let stale = ctx.globalState.get("appliedVersion", null) !== vscode.version;
    if (!stale) {
      const htmlPath = findWorkbenchHtml(vscode.env.appRoot);
      const cssPath = htmlPath ? path.join(path.dirname(htmlPath), CSS_FILENAME) : null;
      const cur = cssPath && fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : "";
      stale = !cur.includes(CSS_BUILD);
    }
    if (stale) {
      try {
        await applyPatch();
      } catch (e) {
        console.warn("wallvia re-apply failed:", e && e.message);
      }
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
// Test/deployment hooks (ignored by VS Code).
module.exports.__internals = {
  buildCss,
  geometry,
  statusString,
  applyPatch: () => applyPatch(),
  applyWallpaperSource,
  setImageFromFile,
  weEntries,
  wePickerHtml,
  buildThumb,
  cachedThumb,
  buildHiRes,
};
