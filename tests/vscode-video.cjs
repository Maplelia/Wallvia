// tests/vscode-video.cjs — the video wallpaper in VS Code: the injected
// `<video>` layer, the driver script and the four-line stamp file that feeds it.
//
// The interesting failure modes are all "silently still", so the assertions are
// about the *contract between the generated files*:
//   - workbench.html carries the layer **inside <body>**, never in <head> (a
//     `<div>` in the head makes the parser close it early and synthesise a body,
//     which put the layer outside the workbench document — the first version did
//     exactly that and the video never appeared);
//   - the element carries a `poster`, so the first paint is the still and not a
//     black rectangle;
//   - wallvia-stamp.txt is `<stamp>\n<url>\n<muted|sound>\n<pause|keep>\n`, and
//     the *stylesheet* script reads only line 1 while the *video* driver reads
//     the rest.
//
// Run standalone: node tests/vscode-video.cjs
// Or via:         node tests/run-all.cjs
const { install } = require("./mock-loader.cjs");
install();

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

async function run() {
  const ROOT = path.join(__dirname, ".tmp-video-install");
  const APP = path.join(ROOT, "resources", "app");
  const WB_DIR = path.join(APP, "out", "vs", "code", "electron-browser", "workbench");
  const WB = path.join(WB_DIR, "workbench.html");
  const CSS = path.join(WB_DIR, "wallvia-bg.css");
  const LIVE = path.join(WB_DIR, "wallvia-live.js");
  const STAMP = path.join(WB_DIR, "wallvia-stamp.txt");
  const PROD = path.join(APP, "product.json");
  const STORAGE = path.join(ROOT, "globalStorage");
  const VIDEO_DIR = path.join(ROOT, "we-library");
  const VIDEO = path.join(VIDEO_DIR, "wallpaper.mp4");
  const PICKED = path.join(ROOT, "picked.jpg");

  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(WB_DIR, { recursive: true });
  fs.mkdirSync(STORAGE, { recursive: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  fs.writeFileSync(
    WB,
    `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8" />\n<title>workbench</title>\n</head>\n<body aria-label="">\n</body>\n</html>\n`
  );
  fs.writeFileSync(PROD, JSON.stringify({ checksums: {} }, null, "\t"));
  fs.writeFileSync(PICKED, Buffer.from("ffd8ffe000104a464946", "hex"));
  fs.writeFileSync(VIDEO, Buffer.alloc(4096, 0x41));

  const state = new Map();
  global.__MOCK_VSCODE__ = {
    appRoot: APP,
    version: "1.140.0",
    pick: PICKED,
    config: { enabled: true, dim: 40, glass: 70, mode: "glass", fit: "cover" },
  };
  const ctx = {
    globalStorageUri: { fsPath: STORAGE },
    subscriptions: [],
    extensionPath: path.join(ROOT, "ext"),
    globalState: {
      get: (k, dflt) => (state.has(k) ? state.get(k) : dflt),
      update: (k, v) => {
        state.set(k, v);
        return Promise.resolve();
      },
    },
  };

  // run-all.cjs runs every suite in one process: the extension module and the
  // `vscode` mock are already cached from the previous suite, and both captured
  // the old `appRoot`/config at load time. Drop them so this suite drives its
  // own install tree.
  for (const key of Object.keys(require.cache)) {
    if (/[\\/](vscode[\\/]src|mocks[\\/]vscode)[\\/]/.test(key)) delete require.cache[key];
  }

  const ext = require("../vscode/src/extension.js");
  const video = require("../vscode/src/video.js");
  const vscode = require("vscode");
  await ext.activate(ctx);

  /** The region between `<body` and `</body>`, i.e. where a div is legal. */
  const bodyOf = (html) => {
    const start = html.indexOf("<body");
    const end = html.indexOf("</body>");
    return start < 0 || end < 0 ? "" : html.slice(start, end);
  };

  // ------------------------------------------------- still: no layer at all
  await ext.__internals.applyWallpaperSource({ file: PICKED, name: "picked" });
  let html = fs.readFileSync(WB, "utf8");
  assert.ok(!html.includes("wallvia-video-layer"), "a still wallpaper injects no video layer");
  assert.ok(!fs.readFileSync(CSS, "utf8").includes("wallvia-video-layer"), "…and no video css");
  assert.ok(
    !fs.readFileSync(STAMP, "utf8").split("\n")[1],
    "line 2 of the stamp is empty for a still"
  );

  // ------------------------------------------------------ video: the layer
  await ext.__internals.applyWallpaperSource({
    file: VIDEO,
    preview: PICKED,
    name: "a video",
    dir: VIDEO_DIR,
  });
  html = fs.readFileSync(WB, "utf8");
  assert.ok(html.includes('id="wallvia-video"'), "a video wallpaper injects the <video> element");
  assert.ok(
    html.includes('muted loop autoplay playsinline preload="auto"'),
    "…muted/loop/autoplay/inline/auto are all there: autoplay legality, no gesture needed, early first frame"
  );
  assert.ok(html.includes('tabindex="-1"'), "…and it stays out of the tab order");
  assert.ok(
    /poster="vscode-file:\/\/vscode-app\/[^"]*wallpaper\.jpg"/.test(html),
    "…and carries the decoded still as its poster, so the first paint is not black"
  );

  // The head/body split is the whole point of the second marker pair.
  const inBody = bodyOf(html);
  assert.ok(
    inBody.includes('id="wallvia-video"'),
    "the layer is inside <body>, where a <div> is legal"
  );
  assert.ok(
    !html.slice(0, html.indexOf("</head>")).includes("wallvia-video-layer"),
    "…and never inside <head>, which would make the parser close it early"
  );
  assert.ok(
    html.includes("<!-- wallvia:layer:start -->") && html.includes("<!-- wallvia:layer:end -->"),
    "the layer has its own marker pair, so it can be updated and removed on its own"
  );
  assert.ok(
    html.slice(0, html.indexOf("</head>")).includes("wallvia-bg.css"),
    "the stylesheet link stays in the head, where it belongs"
  );

  const css = fs.readFileSync(CSS, "utf8");
  assert.ok(css.includes("#wallvia-video-layer{"), "the layer css is emitted");
  assert.ok(css.includes("object-fit:cover"), "…with the fit behaviour");
  assert.ok(
    /wallvia-video-on::before\{background-image:none\}/.test(css),
    "…and the still underneath is dropped while the video paints"
  );

  // The driver is appended to the same script the stylesheet swap uses: one
  // poll, one script, nothing extra to keep in sync.
  const live = fs.readFileSync(LIVE, "utf8");
  assert.ok(live.includes("wallvia-bg.css"), "the live script still swaps the stylesheet");
  assert.ok(live.includes('getElementById("wallvia-video")'), "…and now also drives the video");
  assert.ok(live.includes("visibilitychange"), "it pauses on visibility change");
  assert.ok(live.includes("v.removeAttribute('src')"), "an empty url releases the decoder");
  assert.ok(
    live.includes("wallvia-video-on"),
    "it sets the class the css keys on (the first version never did, so the still stayed composited)"
  );

  // The stamp file is the only channel between the Node half and the page.
  const lines = fs.readFileSync(STAMP, "utf8").split("\n");
  assert.equal(lines.length, 5, "stamp is four lines plus the trailing newline");
  assert.ok(/^\d+$/.test(lines[0]), "line 1 is the numeric css stamp");
  assert.ok(
    /^vscode-file:\/\/vscode-app\//.test(lines[1]),
    "line 2 is a vscode-file:// url, which is what media-src 'self' allows"
  );
  assert.ok(
    lines[1].includes(encodeURIComponent("wallpaper.mp4")),
    "the url is percent-encoded through Uri.file, not hand-built"
  );
  assert.equal(lines[2], "muted", "line 3 is the mute state (default: muted)");
  assert.equal(lines[3], "pause", "line 4 is the focus-pause state (default: pause)");

  // Re-applying must be idempotent: exactly one layer, one marker pair.
  await ext.__internals.applyWallpaperSource({
    file: VIDEO,
    preview: PICKED,
    name: "a video",
    dir: VIDEO_DIR,
  });
  html = fs.readFileSync(WB, "utf8");
  assert.equal(
    html.split('id="wallvia-video"').length - 1,
    1,
    "re-applying does not stack a second <video>"
  );
  assert.equal(
    html.split("wallvia:layer:start").length - 1,
    1,
    "…nor a second layer marker"
  );

  // ---------------------------------------------- the two element-state switches
  const conf = vscode.workspace.getConfiguration();
  await conf.update("videoMuted", false);
  await conf.update("videoPauseUnfocused", false);
  await ext.__internals.applyWallpaperSource({
    file: VIDEO,
    preview: PICKED,
    name: "a video",
    dir: VIDEO_DIR,
  });
  const switched = fs.readFileSync(STAMP, "utf8").split("\n");
  assert.equal(switched[2], "sound", "videoMuted=false travels to the page as `sound`");
  assert.equal(switched[3], "keep", "videoPauseUnfocused=false travels as `keep`");
  await conf.update("videoMuted", true);
  await conf.update("videoPauseUnfocused", true);

  // ------------------------------------------- turning the feature off again
  await conf.update("videoWallpaper", false);
  await ext.__internals.applyWallpaperSource({
    file: VIDEO,
    preview: PICKED,
    name: "a video",
    dir: VIDEO_DIR,
  });
  html = fs.readFileSync(WB, "utf8");
  assert.ok(!html.includes("wallvia-video-layer"), "switching the feature off removes the layer");
  assert.ok(
    !html.includes("wallvia:layer:start"),
    "…and the layer marker, so nothing empty is left behind"
  );
  assert.ok(
    !fs.readFileSync(CSS, "utf8").includes("wallvia-video-layer"),
    "…and its css (no dead rules left behind)"
  );
  assert.ok(
    !fs.readFileSync(STAMP, "utf8").split("\n")[1],
    "…and the video url is cleared from the stamp"
  );
  assert.ok(
    fs.readFileSync(WB, "utf8").includes("wallvia:start"),
    "…while the stylesheet block survives"
  );

  // ---- liveApply off: no driver script, so the layer carries its own state
  // The driver lives inside wallvia-live.js, which is not written with liveApply
  // off. Everything the video needs must therefore be in the markup, or the
  // wallpaper shows its poster and never plays — and the mute switch silently
  // does nothing, in exactly the configuration where the user asked for no live
  // updates.
  await conf.update("liveApply", false);
  await conf.update("videoWallpaper", true);
  await conf.update("videoMuted", true);
  await ext.__internals.applyWallpaperSource({
    file: VIDEO,
    preview: PICKED,
    name: "a video",
    dir: VIDEO_DIR,
  });
  let offHtml = fs.readFileSync(WB, "utf8");
  assert.ok(
    !fs.existsSync(LIVE),
    "with liveApply off there is no driver script at all (that is the premise)"
  );
  assert.ok(
    /<video[^>]*\ssrc="vscode-file:\/\/vscode-app\//.test(offHtml),
    "…so the element carries its own src, or the video would never load"
  );
  assert.ok(
    /<video[^>]*\smuted[\s>]/.test(offHtml),
    "…and its own muted attribute (the switch is not dead without the driver)"
  );
  assert.ok(
    /\sposter="vscode-file:\/\/vscode-app\//.test(offHtml),
    "…and the poster, so the first paint is still the still"
  );
  const offStamp = fs.readFileSync(STAMP, "utf8").split("\n");
  assert.ok(
    /^vscode-file:\/\/vscode-app\//.test(offStamp[1]),
    "the stamp is written even with liveApply off: it is also the video's channel"
  );
  assert.equal(offStamp[2], "muted", "…including the mute state");

  // Unmuting without the driver must reach the markup too.
  await conf.update("videoMuted", false);
  await ext.__internals.applyWallpaperSource({
    file: VIDEO,
    preview: PICKED,
    name: "a video",
    dir: VIDEO_DIR,
  });
  offHtml = fs.readFileSync(WB, "utf8");
  assert.ok(
    !/<video[^>]*\smuted[\s>]/.test(offHtml),
    "videoMuted=false drops the muted attribute from the markup"
  );
  assert.equal(
    fs.readFileSync(STAMP, "utf8").split("\n")[2],
    "sound",
    "…and is still reported to the driver, for when liveApply comes back"
  );

  await conf.update("liveApply", true);
  await conf.update("videoMuted", true);

  // A still picked afterwards must not resurrect the old video.
  await conf.update("videoWallpaper", true);
  await ext.__internals.applyWallpaperSource({ file: PICKED, name: "picked" });
  assert.ok(
    !fs.readFileSync(WB, "utf8").includes("wallvia-video-layer"),
    "a still after a video leaves no layer behind"
  );

  // ------------------------------------------------ clear removes everything
  await ext.__internals.applyWallpaperSource({
    file: VIDEO,
    preview: PICKED,
    name: "a video",
    dir: VIDEO_DIR,
  });
  await vscode.commands.__commands["wallvia.clear"]();
  const cleared = fs.readFileSync(WB, "utf8");
  assert.ok(!cleared.includes("wallvia:start"), "clear removes the stylesheet block");
  assert.ok(!cleared.includes("wallvia:layer:start"), "…and the video layer");
  assert.ok(!fs.existsSync(CSS) && !fs.existsSync(LIVE) && !fs.existsSync(STAMP), "…and the generated files");
  assert.equal(state.get("videoPath"), null, "…and the recorded video path");

  // ------------------------------------------------------- markup contracts
  const markup = video.videoMarkup({ posterUrl: "vscode-file://vscode-app/a%20b.jpg" });
  assert.ok(markup.startsWith('<div id="wallvia-video-layer"'), "the layer wraps the element");
  assert.ok(
    markup.includes('poster="vscode-file://vscode-app/a%20b.jpg"'),
    "the poster url is emitted as given"
  );
  assert.ok(
    video.videoMarkup({ videoUrl: "vscode-file://vscode-app/a.mp4" }).includes('src="vscode-file://vscode-app/a.mp4"'),
    "the video url is emitted into the markup, not only assigned by the driver"
  );
  assert.ok(
    video.videoMarkup({ muted: false }).includes('id="wallvia-video" loop'),
    "muted:false drops the attribute entirely"
  );
  assert.ok(!/\son\w+=/i.test(markup), "no inline event handlers (the CSP forbids them)");
  const quoted = video.videoMarkup({ posterUrl: 'x"y' });
  assert.ok(quoted.includes("&quot;"), "a poster url cannot break out of its attribute");
  const driver = video.videoDriverScript();
  assert.ok(!/\bimport\b|\brequire\(/.test(driver), "the driver is a classic script, not a module");
  assert.ok(driver.includes("setInterval"), "it polls the stamp file");
  assert.ok(!/fetch\(['"]http/.test(driver), "it never fetches off-origin (connect-src 'self')");

  fs.rmSync(ROOT, { recursive: true, force: true });

  console.log("VSCODE VIDEO WALLPAPER TEST PASSED");
  console.log(
    "  the layer is injected inside <body> only for a video (one element, one marker\n" +
      "  pair, muted/loop/autoplay/inline/auto, poster, out of the tab order), its css\n" +
      "  is emitted with it and dropped with it, the driver rides along in\n" +
      "  wallvia-live.js and sets wallvia-video-on, the stamp file is\n" +
      "  `<stamp>\\n<url>\\n<muted|sound>\\n<pause|keep>`, and clear() takes it all down."
  );
}

module.exports = run;

if (require.main === module) {
  run().catch((e) => {
    console.error("VSCODE VIDEO TEST FAILED:", e && e.message);
    process.exit(1);
  });
}
