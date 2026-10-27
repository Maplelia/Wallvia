/**
 * @fileoverview Wallvia — the generated stylesheet: geometry, transparency and the wash.
 *
 * Kept free of `vscode` on purpose: this is the part that can be reasoned
 * about (and unit-tested) as pure string building.
 * Split out of extension.js; behaviour is identical, this is a pure move.
 */
"use strict";

const { CSS_BUILD } = require("./constants");

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
function buildCss({ imageUri, imageVersion, dim, glass, mode, fit, light, video }) {
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

  // Video wallpaper layer. Emitted only when one is actually playing, so an
  // install with a still image carries no dead rules. It sits at the same
  // z-index as the `::before` wallpaper and after it in document order, so it
  // covers the still while the `::after` wash stays on top of both.
  if (video) {
    rules.push(
      "#wallvia-video-layer{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;contain:strict}",
      "#wallvia-video-layer video{display:block;width:100%;height:100%;object-fit:cover;" +
        "object-position:center;background:transparent}",
      // The still underneath is hidden while the video paints: it is the same
      // picture as the poster, and compositing it twice costs a full-screen
      // layer for nothing.
      "html body.wallvia-video-on::before{background-image:none}"
    );
  }

  return rules.join("\n");
}

module.exports = { clamp, geometry, buildCss };
