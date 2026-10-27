/**
 * @fileoverview Wallvia — the file names and build tags both halves of the patch agree on.
 *
 * `CSS_BUILD` is a behaviour fingerprint, not a version: bumping it is how an
 * extension update makes every patched install look stale and re-apply.
 * Split out of extension.js; behaviour is identical, this is a pure move.
 */
"use strict";

const MARK_START = "<!-- wallvia:start -->";
const MARK_END = "<!-- wallvia:end -->";
/**
 * The video layer needs its own marker pair, and it cannot live in `<head>`.
 *
 * The first version put the whole block — link, `<div><video>`, script — before
 * `</head>`. A `<div>` there makes the parser close `<head>` early and synthesise
 * a `<body>`, so the layer ended up outside the document the workbench builds
 * and the video never appeared. Two markers, each in the only place its content
 * is legal, is the honest structure.
 */
const MARK_LAYER_START = "<!-- wallvia:layer:start -->";
const MARK_LAYER_END = "<!-- wallvia:layer:end -->";
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

module.exports = {
  MARK_START,
  MARK_END,
  MARK_LAYER_START,
  MARK_LAYER_END,
  CSS_FILENAME,
  LIVE_FILENAME,
  STAMP_FILENAME,
  THUMB_DIRNAME,
  CSS_BUILD,
  CONFIG_KEY,
  THUMB_TARGET_WIDTH,
  FRAME_TIMEOUT_MS,
  FRAME_RETRY_DELAY_MS,
};
