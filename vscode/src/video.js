/**
 * @fileoverview Wallvia — the video wallpaper: a `<video>` behind the workbench.
 *
 * Why this exists: every other layer in this extension is a CSS
 * `background-image`, and CSS cannot play a video. A video wallpaper was
 * therefore flattened to one decoded frame — sharp and completely still. This
 * module injects a real `<video>` element into `workbench.html` and feeds it the
 * wallpaper file, keeping the decoded frame as its `poster` so the screen never
 * goes empty between "the still is gone" and "frame 1 arrived".
 *
 * Why the element is injected into the HTML instead of created by a script:
 *   - the workbench CSP is `default-src 'none'` plus a short allow-list; a
 *     `<video src="vscode-file://…">` is covered by `media-src 'self'` only when
 *     it is part of the document, and a `<script>` is allowed by `script-src
 *     'self'` — but only from the same folder as the patched page, which is why
 *     `wallvia-live.js` already lives there;
 *   - `workbench.html` is read once per window, so the element must exist in the
 *     file. A script that creates it at runtime would still work, but then the
 *     first frame would wait for the script, and a CSP change would silently
 *     break it.
 *
 * The generated `wallvia-live.js` already polls a stamp file every two seconds;
 * it is the natural place to drive the video (play/pause on visibility, swap
 * `src` when the wallpaper changes). Doing it there means one script, one poll,
 * and no second mechanism to keep in sync.
 */

"use strict";

const { LIVE_FILENAME, STAMP_FILENAME } = require("./constants");

/** The id of the injected element, used by both the HTML and the script. */
const VIDEO_ID = "wallvia-video";

/**
 * The markup for the video layer.
 *
 * `preload="auto"` is deliberate: these files usually have `moov` at the end, so
 * the demuxer stops after the metadata and never starts fetching frames until
 * `play()`. `auto` makes the element fetch as soon as it is created, which is
 * what makes the first frame appear at once instead of after the first paint.
 *
 * `poster` is the decoded still — the same picture the `::before` layer shows.
 * Without it the first paint of a video wallpaper is **black**, which is exactly
 * the gap the Obsidian side avoids; it also means a refused autoplay leaves the
 * still visible instead of a black rectangle.
 *
 * `muted` + `playsinline` + `autoplay` are what make autoplay legal and what
 * start playback even when `liveApply` is off and the driver script is absent.
 * `loop` is what makes it a wallpaper. `aria-hidden` + `tabindex="-1"` keep a
 * background element out of the tab order — a focusable `<video>` behind the
 * editor would swallow Tab.
 *
 * `src` is written straight into the markup, not only assigned by the driver.
 * With `liveApply` off there is no driver script at all (it lives in
 * `wallvia-live.js`), so a layer without `src` would sit there forever showing
 * only its poster — the video silently never played in exactly the configuration
 * where the user asked for no live updates.
 *
 * @param {{posterUrl?: string, videoUrl?: string, muted?: boolean}} [urls]
 */
function videoMarkup(urls) {
  const posterUrl = urls && urls.posterUrl;
  const videoUrl = urls && urls.videoUrl;
  // `muted` is an attribute here, not only element state: with `liveApply` off
  // there is no driver script, so this is the only place the setting can land.
  const muted = urls && urls.muted === false ? "" : " muted";
  const poster = posterUrl ? ' poster="' + escapeAttr(posterUrl) + '"' : "";
  const src = videoUrl ? ' src="' + escapeAttr(videoUrl) + '"' : "";
  return (
    '<div id="wallvia-video-layer" aria-hidden="true">' +
    '<video id="' +
    VIDEO_ID +
    '"' +
    muted +
    ' loop autoplay playsinline preload="auto" tabindex="-1"' +
    src +
    poster +
    " disablepictureinpicture disableremoteplayback></video>" +
    "</div>"
  );
}

/** Escape a value for a double-quoted HTML attribute. */
function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The script body that drives the video.
 *
 * Runs inside the workbench page, so it may only use what that page has: no
 * modules, no imports, and no network beyond the same folder (the CSP allows
 * `connect-src 'self'`). It therefore polls the same stamp file `wallvia-live.js`
 * already polls, and reads the video URL out of it.
 *
 * The stamp file is four lines:
 *
 *   `<css stamp>`       ← the stylesheet swap
 *   `<video url>`       ← this driver ("" = no video)
 *   `muted` / `sound`   ← `wallvia.videoMuted`
 *   `pause` / `keep`    ← `wallvia.videoPauseUnfocused`
 *
 * The last two exist because a `<video>` that is already in the document cannot
 * be reconfigured from the Node half: muting and focus-pausing are element state,
 * not markup, so they have to travel through the only channel the page reads.
 */
function videoDriverScript() {
  return (
    "(function(){" +
    'var v=document.getElementById("' +
    VIDEO_ID +
    '");' +
    "if(!v)return;" +
    "var cur='',muted=true,pauseUnfocused=true;" +
    // Autoplay can still be refused (the workbench is not a user gesture). A
    // refusal leaves the poster showing, which is the still image — acceptable,
    // and better than an empty layer.
    "function kick(){" +
    "try{" +
    "if(pauseUnfocused&&(!document.hasFocus||!document.hasFocus()))return;" +
    "var p=v.play();if(p&&p.catch)p.catch(function(){});" +
    "}catch(e){}" +
    "}" +
    "function apply(url){" +
    "if(!url){" +
    // No video: take the layer down and drop the class, so the `::before` still
    // comes back. Leaving the class on would hide the wallpaper entirely.
    "try{v.pause();v.removeAttribute('src');v.load();}catch(e){}" +
    "document.body.classList.remove('wallvia-video-on');" +
    "return;" +
    "}" +
    "v.src=url;v.load();v.muted=muted;" +
    // The class is what drops the `::before` still underneath: while the video
    // paints, compositing the same picture twice is a wasted full-screen layer.
    "document.body.classList.add('wallvia-video-on');" +
    "kick();" +
    "}" +
    "function check(){" +
    "if(document.hidden)return;" +
    "fetch('./" +
    STAMP_FILENAME +
    "',{cache:'no-store'})" +
    ".then(function(r){return r.ok?r.text():'';})" +
    ".then(function(s){" +
    "var lines=String(s||'').split('\\n');" +
    "var url=(lines[1]||'').trim();" +
    "muted=String(lines[2]||'').trim()!=='sound';" +
    "pauseUnfocused=String(lines[3]||'').trim()!=='keep';" +
    "v.muted=muted;" +
    "if(url===cur)return;" +
    "cur=url;" +
    "apply(url);" +
    "})" +
    ".catch(function(){});" +
    "}" +
    // Pause while hidden or unfocused: a wallpaper that keeps decoding in the
    // background costs a core and a GPU queue for a picture nobody can see.
    "document.addEventListener('visibilitychange',function(){try{if(document.hidden)v.pause();else kick();}catch(e){}});" +
    "window.addEventListener('focus',kick);" +
    "window.addEventListener('blur',function(){if(pauseUnfocused){try{v.pause();}catch(e){}}});" +
    "setInterval(check,2000);" +
    "check();" +
    "})();"
  );
}

/**
 * CSS for the layer.
 *
 * The rules live in `css.js` (it owns the generated stylesheet); this module only
 * exports the markup and the driver. Keeping the styles in one place is what
 * makes `buildCss` testable as pure string building.
 */

module.exports = { VIDEO_ID, videoMarkup, videoDriverScript };
