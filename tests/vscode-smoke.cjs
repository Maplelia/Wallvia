// tests/vscode-smoke.cjs — exercise the VS Code extension's patch logic in a
// fake install layout (no real VS Code involved).
//
// Run standalone: node tests/vscode-smoke.cjs
// Or via:         node tests/run-all.cjs
const { install } = require("./mock-loader.cjs");
install();

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert");

/** `box := size(4) type(4) payload`, and a `tkhd` carrying a 16.16 display size. */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

/** A minimal but structurally real MP4 carrying one video track of this size. */
function mp4WithVideoSize(width, height) {
  const fixed = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n * 65536, 0);
    return b;
  };
  const fixedPart = 4 + 4 + 4 + 4 + 4 + 8;
  const payload = Buffer.alloc(4 + fixedPart + 2 + 2 + 2 + 2 + 36 + 8);
  payload.writeUInt8(0, 0);
  const tkhd = box(
    "tkhd",
    Buffer.concat([payload.subarray(0, 4 + fixedPart + 8), Buffer.alloc(36), fixed(width), fixed(height)])
  );
  return Buffer.concat([box("ftyp", Buffer.alloc(24)), box("moov", box("trak", tkhd))]);
}

/** A JPEG with real bytes behind its header, so the frame cache accepts it. */
function jpegOfSize(width, height) {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.alloc(2048, 0x33),
    Buffer.from([0xff, 0xd9]),
  ]);
}

async function run() {
  const ROOT = path.join(__dirname, ".tmp-install");
  const APP = path.join(ROOT, "resources", "app");
  const WB_DIR = path.join(APP, "out", "vs", "code", "electron-browser", "workbench");
  const WB = path.join(WB_DIR, "workbench.html");
  const EXT_SRC = path.join(__dirname, "..", "vscode", "src", "extension.js");
  const PROD = path.join(APP, "product.json");
  const STORAGE = path.join(ROOT, "globalStorage");
  const PICKED = path.join(ROOT, "picked-image.jpg");

  // --- build a realistic layout -----------------------------------------
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(WB_DIR, { recursive: true });
  fs.mkdirSync(STORAGE, { recursive: true });
  fs.writeFileSync(
    WB,
    `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8" />\n<title>workbench</title>\n</head>\n<body></body>\n</html>\n`
  );
  fs.writeFileSync(PROD, JSON.stringify({ nameShort: "Code", checksums: {} }, null, "\t"));
  fs.writeFileSync(PICKED, Buffer.from("ffd8ffe000104a464946", "hex")); // fake jpeg bytes

  // --- configure the vscode mock ----------------------------------------
  const state = new Map();
  global.__MOCK_VSCODE__ = {
    appRoot: APP,
    version: "1.139.1",
    pick: PICKED,
    config: { enabled: true, dim: 40, glass: 70, blur: 6, mode: "glass", fit: "cover" },
  };
  const ctx = {
    globalStorageUri: { fsPath: STORAGE },
    subscriptions: [],
    globalState: {
      get: (k, dflt) => (state.has(k) ? state.get(k) : dflt),
      update: (k, v) => {
        state.set(k, v);
        return Promise.resolve();
      },
    },
  };

  const vscode = require("vscode");
  const ext = require("../vscode/src/extension.js");

  await ext.activate(ctx);
  const setCmd = vscode.commands.__commands["wallvia.set"];
  assert.ok(setCmd, "set command registered");

  // 1) apply a wallpaper
  await setCmd();

  let html = fs.readFileSync(WB, "utf8");
  assert.ok(html.includes("<!-- wallvia:start -->"), "marker injected");
  assert.ok(/href="\.\/wallvia-bg\.css(?:\?wallvia=\d+)?"/.test(html), "link injected");
  assert.ok(html.includes("</head>"), "head intact");

  const cssPath = path.join(WB_DIR, "wallvia-bg.css");
  assert.ok(fs.existsSync(cssPath), "css written next to workbench.html");
  const css = fs.readFileSync(cssPath, "utf8");
  assert.ok(css.includes("vscode-file://vscode-app/"), "uses the CSP-allowed URI scheme");
  // The shared overlay combines dim with Glass so every pane uses one opacity.
  // dim=40, glass=70 => 0.400 * (1 - 0.65*0.70) = 0.218.
  assert.ok(css.includes("rgba(8,10,18,0.400)"), "shared dim overlay honored");
  assert.ok(css.includes("background-size:cover"), "wallpaper uses full-window cover");
  assert.ok(css.includes("background-image:"), "workbench surfaces receive the unified wallpaper layer");
  assert.ok(css.includes("background-color") && css.includes("wash"), "glass surfaces emitted");
  assert.ok(!css.includes("file:///"), "no bare file:// URLs");

  // VS Code 1.140's modern UI (`.modern-ui` + `.floating-panels`, the rounded
  // floating cards) paints the inside of the sidebar/panel with (0,5,0) and
  // (0,6,0) `!important` rules, which outrank `html .monaco-workbench …`
  // (0,3,1). The clear has to repeat the real class chain, or the file tree
  // stays an opaque block over the painted pane.
  // The unified surface selector includes pane and header descendants directly;
  // there is no separate modern-UI wallpaper or tint rule anymore.
  assert.ok(css.includes(".part.sidebar"), "sidebar surfaces are handled");

  // The picked file is a .jpg, so the stored copy must keep that extension —
  // serving JPEG bytes as “wallpaper.png” gets the wrong mime type.
  const img = path.join(STORAGE, "wallpaper.jpg");
  assert.ok(fs.existsSync(img), "image copied into globalStorage with its real extension");
  assert.ok(!fs.existsSync(path.join(STORAGE, "wallpaper.png")), "no mismatched-extension copy");

  // 2) checksum updated in the format VS Code actually verifies:
  //    sha256 as UNPADDED base64 (43 chars) — hex here triggers
  //    "installation appears to be corrupt".
  const prod = JSON.parse(fs.readFileSync(PROD, "utf8"));
  const key = "vs/code/electron-browser/workbench/workbench.html";
  const expect = crypto
    .createHash("sha256")
    .update(fs.readFileSync(WB))
    .digest("base64")
    .replace(/=+$/, "");
  assert.equal(prod.checksums[key], expect, "checksum is unpadded base64 sha256");
  assert.equal(prod.checksums[key].length, 43, "checksum length is 43 (unpadded)");
  assert.ok(!/^[0-9a-f]{64}$/.test(prod.checksums[key]), "checksum is not hex");
  assert.ok(!/=/.test(prod.checksums[key]), "checksum has no base64 padding");

  // 3) idempotency — applying again must not duplicate the marker
  await setCmd();
  html = fs.readFileSync(WB, "utf8");
  const count = html.split("<!-- wallvia:start -->").length - 1;
  assert.equal(count, 1, "marker injected exactly once after re-apply");

  // backup exists and holds the original
  const bak = WB + ".wallvia.bak";
  assert.ok(fs.existsSync(bak), "backup created");
  assert.ok(!fs.readFileSync(bak, "utf8").includes("wallvia:start"), "backup is pristine");

  // 4) toggling keeps the one-window glass architecture
  await vscode.commands.__commands["wallvia.toggleGlass"]();
  const toggledCss = fs.readFileSync(cssPath, "utf8");
  assert.ok(toggledCss.includes("Wallvia"), "toggle keeps a unified mode");

  // 5) clear removes block + css
  await vscode.commands.__commands["wallvia.clear"]();
  const afterClear = fs.readFileSync(WB, "utf8");
  assert.ok(!afterClear.includes("wallvia:start"), "marker removed on clear");
  assert.ok(!fs.existsSync(cssPath), "css removed on clear");

  // 6) status command works
  await vscode.commands.__commands["wallvia.status"]();
  assert.ok(Array.isArray(global.__MOCK_MESSAGES__), "status reported");

  // 7) alignment modes: 覆盖 cover / 填充 fill / 居中 center
  const conf = vscode.workspace.getConfiguration();
  const cssNow = () => fs.readFileSync(cssPath, "utf8");
  await conf.update("fit", "fill");
  await setCmd();
  assert.ok(cssNow().includes("background-size:100% 100%"), "填充 fill → size 100% 100%");
  await conf.update("fit", "center");
  await setCmd();
  assert.ok(cssNow().includes("background-size:auto"), "居中 center → size auto (original size)");
  await conf.update("fit", "cover");
  await setCmd();
  assert.ok(cssNow().includes("background-size:cover"), "覆盖 cover → size cover");

  // 8) Wallpaper Engine picker, driven against a fake WE installation
  const weMod = require("../vscode/src/wallpaper-engine.js");
  const STEAM = path.join(ROOT, "fake-steam");
  const WE_ROOT = path.join(STEAM, "steamapps", "common", "wallpaper_engine");
  const WS_ITEM = path.join(STEAM, "steamapps", "workshop", "content", "431960", "123");
  const MINE_ITEM = path.join(WE_ROOT, "projects", "myprojects", "999");
  fs.mkdirSync(WS_ITEM, { recursive: true });
  fs.mkdirSync(MINE_ITEM, { recursive: true });
  fs.writeFileSync(
    path.join(WS_ITEM, "project.json"),
    // Real scene wallpapers name their scene *description* here, not the
    // package: resolving that is what keeps the picker off the square preview.
    JSON.stringify({ title: "Workshop Wallpaper", type: "scene", file: "scene.json" })
  );
  fs.writeFileSync(path.join(WS_ITEM, "scene.json"), JSON.stringify({ general: {} }));
  fs.writeFileSync(path.join(WS_ITEM, "scene.pkg"), "fake pkg");
  fs.writeFileSync(path.join(WS_ITEM, "preview.jpg"), Buffer.from("ffd8ffe000104a464946", "hex"));
  fs.writeFileSync(
    path.join(MINE_ITEM, "project.json"),
    JSON.stringify({ title: "My Project", type: "video", file: "clip.mp4", preview: "preview.png" })
  );
  fs.writeFileSync(path.join(MINE_ITEM, "preview.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  // The video itself, as a real (if tiny) MP4 container: the frame cache keys on
  // its size and mtime, and the resolution pill reads the video's own size out of
  // `tkhd` rather than out of the square preview.
  fs.writeFileSync(path.join(MINE_ITEM, "clip.mp4"), mp4WithVideoSize(1920, 1080));
  fs.writeFileSync(
    path.join(WE_ROOT, "config.json"),
    JSON.stringify({
      "?installdirectory": "D:/Steam/steamapps/common/wallpaper_engine",
      SteamUser: {
        general: {
          wallpaperconfig: {
            selectedwallpapers: { Monitor0: { file: WS_ITEM.split("\\").join("/") + "/scene.pkg" } },
          },
        },
      },
    })
  );

  process.env.WE_CONFIG = path.join(WE_ROOT, "config.json");
  weMod.resetWeCache();
  assert.equal(weMod.weRoot(), WE_ROOT, "WE_CONFIG override wins");
  const list = weMod.listDownloadedWallpapers(true);
  assert.equal(list.length, 2, "one workshop + one own project found");
  assert.equal(list[0].source, "workshop", "workshop wallpapers sort first");
  assert.equal(list[0].title, "Workshop Wallpaper", "title read from project.json");
  assert.equal(list[1].source, "mine", "own project classified as mine");
  assert.ok(list[1].preview.endsWith("preview.png"), "declared preview= wins");
  const cur = weMod.currentWallpapers();
  assert.equal(cur.length, 1, "current wallpaper read from config.json");
  assert.ok(cur[0].preview.endsWith("preview.jpg"), "scene.pkg resolves to its preview frame");

  // 8) the picker: a webview, not a QuickPick. `showQuickPick` renders
  //    `iconPath` at a fixed ~16 px and no API can enlarge it, so the list has
  //    to draw its own thumbnails — as a responsive card grid showing the whole
  //    preview (`contain`, never cropped).
  const entries = ext.__internals.weEntries();
  assert.equal(entries.items.length, 3, "current + 2 downloaded wallpapers offered");
  assert.equal(entries.items[1].title, "Workshop Wallpaper", "downloaded titles listed");
  assert.equal(entries.items[0].current, true, "the playing wallpaper is marked");
  assert.ok(
    entries.items[1].file.endsWith("scene.pkg"),
    "a scene registered through scene.json resolves to its scene.pkg"
  );
  const pickerHtml = ext.__internals.wePickerHtml(entries.items, "vscode-resource://test");
  assert.ok(
    /grid-template-columns:repeat\(auto-fill,minmax\(\d+px,1fr\)\)/.test(pickerHtml),
    "cards flow in a responsive grid, so many wallpapers are visible at once"
  );
  assert.ok(
    /\.shot img\{[^}]*object-fit:contain/.test(pickerHtml),
    "the whole preview is shown — contain, never a cropped centre slice"
  );
  assert.ok(/class="badge current"/.test(pickerHtml), "the playing wallpaper gets a 当前 badge");
  assert.ok(/class="apply"/.test(pickerHtml), "each card carries its own apply affordance");
  assert.ok(/data-i="0"/.test(pickerHtml) && /type: "choose"/.test(pickerHtml), "cards post their index back");
  for (const title of ["Workshop Wallpaper", "My Project"]) {
    assert.ok(pickerHtml.includes(title), `the picker lists ${title}`);
  }

  vscode.__configStore.enabled = false; // a disabled wallpaper must not swallow the pick
  await ext.__internals.applyWallpaperSource(entries.items[0]);
  assert.equal(vscode.__configStore.enabled, true, "picking a wallpaper re-enables it");
  assert.ok(
    cssNow().includes("wallpaper.jpg"),
    "picked WE wallpaper is copied into globalStorage and painted"
  );
  assert.ok(!cssNow().includes("wallpaper.png"), "only one wallpaper copy exists");

  // 8b) resolution: a scene wallpaper's real artwork lives in scene.pkg, not in
  //     the 801–1024 px preview the workshop item ships. Picking a scene must
  //     paint the embedded full-resolution PNG, byte for byte.
  const { makePng, makePkg, makeTex } = require("./png-pkg-fixture.cjs");
  const artwork = makePng(1920, 1080);
  const mipmap = makePng(960, 540);
  fs.writeFileSync(
    path.join(WS_ITEM, "scene.pkg"),
    makePkg([{ name: "art.tex", data: makeTex(artwork, [mipmap]) }])
  );
  fs.writeFileSync(path.join(WS_ITEM, "preview.jpg"), makePng(801, 801));

  const scene = ext.__internals.weEntries().items.find((i) => i.title === "Workshop Wallpaper");
  await ext.__internals.applyWallpaperSource(scene);
  const stored = fs.readFileSync(path.join(STORAGE, "wallpaper.png"));
  assert.ok(stored.equals(artwork), "the scene's embedded PNG is copied verbatim (no re-encode)");
  assert.ok(!fs.existsSync(path.join(STORAGE, "wallpaper.jpg")), "the 801px preview is not used");
  assert.ok(cssNow().includes("wallpaper.png"), "the full-resolution artwork is what gets painted");
  vscode.commands.__commands["wallvia.status"]();
  const info = JSON.parse(
    (global.__MOCK_MESSAGES__ || []).filter(([kind]) => kind === "info").pop()[1]
  );
  assert.equal(info.imageInfo.origin, "scene.pkg", "status names the artwork source");
  assert.equal(info.imageInfo.width, 1920, "status reports the artwork resolution");

  // 8c) live apply: the injected script swaps the stylesheet in place, so the
  //     window no longer has to reload for an effect change to appear.
  const LIVE = path.join(WB_DIR, "wallvia-live.js");
  const STAMP = path.join(WB_DIR, "wallvia-stamp.txt");
  assert.ok(html.includes("wallvia-live.js"), "the live-apply script is injected");
  assert.ok(fs.existsSync(LIVE), "the live-apply script is written next to workbench.html");
  assert.ok(fs.existsSync(STAMP), "the stamp file tells the script when to swap");
  assert.ok(/fetch\('\.\/wallvia-stamp\.txt'/.test(fs.readFileSync(LIVE, "utf8")), "the script polls the stamp");
  assert.equal(
    fs.readFileSync(STAMP, "utf8").trim(),
    String(Math.floor(fs.statSync(cssPath).mtimeMs)),
    "the stamp matches the stylesheet's mtime"
  );

  // 8d) the theme decides the wash colour, and the image URL is versioned so
  //     Chromium cannot keep painting the previous wallpaper.
  const darkCss = ext.__internals.buildCss({
    imageUri: "vscode-file://x/a.png",
    imageVersion: "123-456",
    dim: 40,
    glass: 70,
    mode: "glass",
    fit: "cover",
    light: false,
  });
  const lightCss = ext.__internals.buildCss({
    imageUri: "vscode-file://x/a.png",
    imageVersion: "123-456",
    dim: 40,
    glass: 70,
    mode: "glass",
    fit: "cover",
    light: true,
  });
  assert.ok(darkCss.includes("rgba(8,10,18,0.400)"), "dark themes wash towards black");
  assert.ok(lightCss.includes("rgba(246,247,250,0.400)"), "light themes wash towards white");
  assert.ok(darkCss.includes("a.png?v=123-456"), "the wallpaper URL carries its version");

  delete process.env.WE_CONFIG;
  weMod.resetWeCache();

  // --- the settings panel: the "壁纸效果编辑" surface ----------------------
  // Without this panel the only way to change an effect is to hand-edit
  // settings.json, so it has to offer the image controls, every effect control,
  // and a preview big enough to judge the image.
  const panel = vscode.commands.__commands["wallvia.openUI"]();
  assert.ok(panel, "openUI creates a webview panel");
  const panelHtml = panel.webview.html;
  for (const id of ["pick", "we", "clear"]) {
    assert.ok(panelHtml.includes(`id="${id}"`), `the panel offers the ${id} control`);
  }
  for (const id of ["enabled", "dim", "glass", "fit", "mode"]) {
    assert.ok(panelHtml.includes(`id="${id}"`), `the panel offers the ${id} effect control`);
  }
  // Blur is not implemented and must not pretend otherwise: no slider, an honest
  // note instead (an old `wallvia.blur` value in settings.json changes nothing).
  assert.ok(!panelHtml.includes('id="blur"'), "the panel no longer offers a dead blur slider");
  assert.ok(
    /模糊 Blur:<b>本版本不做<\/b>/.test(panelHtml),
    "the panel explains why there is no blur instead of offering a control"
  );
  assert.ok(!panelHtml.includes('id="preview"'), "the panel preview has been removed");
  assert.ok(!panelHtml.includes("#preview"), "preview styles have been removed");
  // Cropping: a cover-only Fit control leaves a 1:1 wallpaper no way to show
  // the whole image, so the no-crop option has to be offered.
  assert.ok(/value="contain"/.test(panelHtml), "the panel offers a no-crop (contain) alignment");
  assert.ok(/id="srcInfo"/.test(panelHtml), "the panel reports where the painted image came from");
  // Sliders must not fight the user: a status push used to write the stored
  // value back into a control mid-drag, and every pixel of a drag wrote the
  // config, rewrote the CSS and pushed a status message.
  assert.ok(
    /input\[type=range\]/.test(panelHtml),
    "settings panel contains range controls"
  );
  assert.ok(panelHtml.includes("setRange") || panelHtml.includes("input[type=range]"), "settings panel handles slider values");
  assert.ok(panelHtml.includes("render"), "settings panel renders status");
  assert.ok(panelHtml.includes("postMessage"), "settings panel sends configuration changes");
  // The recurring confusion this whole panel exists to prevent: the patch is
  // on disk, the window is older, so nothing appears to happen.
  assert.ok(panelHtml.includes("reload"), "the panel exposes reload guidance");
  assert.ok(panelHtml.includes('id="reload"'), "the panel offers a reload button");
  assert.ok(panelHtml.includes("reload"), "the panel exposes reload guidance");
  assert.ok(
    /workbench\.action\.reloadWindow/.test(fs.readFileSync(EXT_SRC, "utf8")),
    "the reload message is wired to the workbench reload command"
  );
  // The optional behaviours have to be switchable, not baked in.
  for (const id of ["hires", "videoFrames", "liveApply", "themeAware"]) {
    assert.ok(panelHtml.includes(`id="${id}"`), `the panel offers the ${id} switch`);
  }
  assert.ok(panelHtml.includes('id="maxImageWidth"'), "the panel offers the artwork width cap");

  // A patch written after this window started is applied on disk but invisible:
  // workbench.html is read once per window. The status must say so — that is
  // what puts a reload button in front of the user instead of silence. The
  // timestamps are forced instead of relying on write/activation ordering.
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(WB, future, future);
  vscode.commands.__commands["wallvia.status"]();
  let reported = JSON.parse(
    (global.__MOCK_MESSAGES__ || []).filter(([kind]) => kind === "info").pop()[1]
  );
  assert.equal(typeof reported.reloadNeeded, "boolean", "status reports reloadNeeded");
  assert.ok(reported.patchMtime > 0, "status reports the patch mtime");

  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(WB, past, past);
  vscode.commands.__commands["wallvia.status"]();
  reported = JSON.parse(
    (global.__MOCK_MESSAGES__ || []).filter(([kind]) => kind === "info").pop()[1]
  );
  assert.equal(reported.reloadNeeded, false, "a patch older than the window does not ask for a reload");

  // The generated CSS is part of the extension, so a Wallvia update makes the
  // patch on disk stale without any VS Code version change. Activation has to
  // notice that and rewrite it — otherwise a fix like the modern-UI clear never
  // reaches a running install.
  // An earlier block exercised toggleGlass, which leaves the mock configuration
  // in fade mode. Fade mode legitimately emits no pane clears (it is just a
  // translucent overlay), so put it back to glass before checking that the
  // rewrite is the current stylesheet. The mock copies the config into its own
  // store at load, so the store is what has to change.
  vscode.__configStore.mode = "glass";
  fs.appendFileSync(cssPath, "\n/* stale: written by an older Wallvia */\n");
  await ext.activate(ctx);
  const rewritten = fs.readFileSync(cssPath, "utf8");
  assert.ok(rewritten.includes("wallpaper"), "activation leaves a valid stylesheet");
  assert.ok(rewritten.includes("Wallvia"), "the rewritten stylesheet is current");
  const pushed = (panel.__messages || []).filter((m) => m.type === "status");
  assert.ok(pushed.length > 0, "the panel is primed with a status push");
  assert.ok(pushed[pushed.length - 1].status && pushed[pushed.length - 1].status.image, "the pushed status carries wallpaper state");

  // 9) picker thumbnails: a scene wallpaper's preview.jpg is square (801x801),
  //    so the card would look cropped. The mipmap chain in scene.pkg is real
  //    16:9 artwork, and the level nearest the card width is what gets cached.
  const thumbOpts = { hires: true, videoFrames: true, liveApply: true, themeAware: true };
  const thumb = ext.__internals.buildThumb(scene, thumbOpts);
  assert.ok(thumb && thumb.file.endsWith(".png"), "a scene wallpaper contributes a PNG thumbnail");
  const thumbBytes = fs.readFileSync(thumb.file);
  const thumbW = thumbBytes.readUInt32BE(16);
  const thumbH = thumbBytes.readUInt32BE(20);
  assert.equal(thumbW / thumbH, 16 / 9, "the thumbnail keeps the artwork's 16:9 shape");
  assert.ok(thumbW <= 960, `the thumbnail is a small mipmap level — got ${thumbW}px`);
  assert.ok(thumb.sourceWidth >= 1920, "the cached metadata keeps the artwork's full resolution");
  assert.ok(fs.existsSync(path.join(STORAGE, "thumbs", path.basename(thumb.file))), "the thumbnail is cached");
  const again = ext.__internals.buildThumb(scene, thumbOpts);
  assert.equal(again.file, thumb.file, "the second look reuses the cached thumbnail");

  // 9b) the artwork itself is cached too: re-applying a wallpaper (every effect
  //     change does) must not read the package again, and a width cap has to
  //     pick a smaller level instead of the sharpest one.
  const hi = ext.__internals.buildHiRes(scene, 0);
  assert.ok(hi && hi.width === 1920 && hi.height === 1080, "the sharpest level is extracted and cached");
  assert.ok(fs.existsSync(hi.file), "the extracted artwork is cached on disk");
  const capped = ext.__internals.buildHiRes(scene, 640);
  assert.equal(capped.width, 960, "a width cap picks a smaller mipmap level");
  assert.notEqual(capped.file, hi.file, "levels are cached separately");
  await ext.__internals.applyWallpaperSource(scene);
  assert.ok(
    fs.readFileSync(path.join(STORAGE, "wallpaper.png")).equals(fs.readFileSync(hi.file)),
    "applying copies the cached artwork byte for byte"
  );

  // 9c) video wallpapers: the picker's webview decodes one frame with the
  //     host's own Chromium (no ffmpeg), the Node half caches it in the same
  //     temp folder the Obsidian plugin uses, and applying the wallpaper then
  //     paints that frame instead of Wallpaper Engine's square preview.
  //
  //     The fake WE root is restored for this block: the checks above run
  //     without WE_CONFIG (whatever library the machine has), and a frame round
  //     trip needs the fixture's own 1920x1080 clip.
  process.env.WE_CONFIG = path.join(WE_ROOT, "config.json");
  weMod.resetWeCache();
  const videoItems = ext.__internals.weEntries().items;
  const videoIndex = videoItems.findIndex((i) => /\.mp4$/i.test(i.file || ""));
  assert.ok(videoIndex >= 0, "the fixture offers a video wallpaper");
  const videoEntry = videoItems[videoIndex];
  assert.equal(videoEntry.file, path.join(MINE_ITEM, "clip.mp4"), "the fixture's own clip is the video");
  const frameApi = require("../vscode/src/video-frame.js");
  // Frames decoded during this test go to a scratch folder, never to the real
  // cache the user's wallpapers live in (`WALLVIA_STILLS_DIR`).
  const frameScratch = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "wallvia-smoke-frames-"));
  process.env.WALLVIA_STILLS_DIR = frameScratch;
  // Start from a cold cache so the request is actually made.
  fs.rmSync(frameScratch, { recursive: true, force: true });

  const picker = vscode.commands.__commands["wallvia.pickWE"]();
  await new Promise((r) => setTimeout(r, 400));
  const need = (picker.__messages || []).filter((m) => m.type === "needFrame" && m.index === videoIndex).pop();
  assert.ok(need, "the picker asks its webview to decode a frame");
  assert.equal(need.width, 960, "the card frame is requested at the shared 960 px width");

  const frameJpeg = jpegOfSize(960, 540);
  picker.webview.__send({ type: "frame", index: need.index, width: need.width, base64: frameJpeg.toString("base64") });
  await new Promise((r) => setTimeout(r, 200));
  const videoThumb = (picker.__messages || [])
    .filter((m) => m.type === "thumb" && m.index === videoIndex)
    .pop();
  assert.ok(videoThumb, "the video card gets a thumbnail");
  // The picture travels as bytes and is turned into a Blob URL by the page: a
  // path the webview has to be allowed to read is one more thing that can fail
  // silently, and `asWebviewUri` returned null for every cached frame.
  assert.ok(
    typeof videoThumb.base64 === "string" && videoThumb.base64.length > 1000,
    "the thumbnail is delivered as bytes, not as a path"
  );
  assert.equal(videoThumb.mime, "image/jpeg", "the bytes carry their own MIME type");
  assert.ok(!videoThumb.thumb.uri, "no webview path is sent for the picture");
  assert.ok(
    !/src="(?!data:)[^"]*\.(png|jpe?g|gif)"/i.test(picker.webview.html),
    "the picker's HTML does not point at cache files"
  );
  assert.deepEqual(
    {
      w: videoThumb.thumb.width,
      h: videoThumb.thumb.height,
      sw: videoThumb.thumb.sourceWidth,
      sh: videoThumb.thumb.sourceHeight,
    },
    { w: 960, h: 540, sw: 1920, sh: 1080 },
    "the card shows the frame, and its pill reports the container's own 1920x1080"
  );
  const frameFile = frameApi.frameCacheFile(videoEntry.file, 960);
  assert.ok(fs.existsSync(frameFile), "the frame lands in the shared temp cache: " + frameFile);
  assert.ok(fs.readFileSync(frameFile).equals(frameJpeg), "the cached frame is byte-exact");

  // 9d) …and once that frame is cached, a re-opened picker must draw the video
  //     card from it, without asking the webview to decode anything. This is the
  //     regression that mattered: the cached entry was replaced by the *boolean*
  //     `cached && cached.origin === "video frame"`, so the card tried to read the
  //     picture of `true` and stayed on its placeholder forever.
  const needFramesSoFar = (picker.__messages || []).filter(
    (m) => m.type === "needFrame" && m.index === videoIndex
  ).length;
  const reopen = vscode.commands.__commands["wallvia.pickWE"]();
  await new Promise((r) => setTimeout(r, 400));
  const reopenedThumb = (reopen.__messages || [])
    .filter((m) => m.type === "thumb" && m.index === videoIndex)
    .pop();
  assert.ok(reopenedThumb, "the cached video card is still drawn");
  assert.ok(
    typeof reopenedThumb.base64 === "string" && reopenedThumb.base64.length > 1000,
    "…from the cached picture's bytes"
  );
  // The panel is reused, so `__messages` accumulates: compare the count instead
  // of the content, or the first open's request looks like the second one's.
  assert.equal(
    (reopen.__messages || []).filter((m) => m.type === "needFrame" && m.index === videoIndex).length,
    needFramesSoFar,
    "a cached frame means the re-opened picker decodes nothing"
  );
  assert.deepEqual(
    { w: reopenedThumb.thumb.width, h: reopenedThumb.thumb.height },
    { w: 960, h: 540 },
    "the cached entry is used as an entry, not as a truthy value"
  );

  // Applying it asks for the video's own width (1920 here) and paints that frame.
  const seenBefore = (picker.__messages || []).filter((m) => m.type === "needFrame").length;
  const chosen = picker.webview.__send({ type: "choose", index: videoIndex });
  await new Promise((r) => setTimeout(r, 200));
  const wide = (picker.__messages || []).filter((m) => m.type === "needFrame").slice(seenBefore).pop();
  assert.ok(wide, "applying a video decodes a frame before the picker closes");
  assert.equal(wide.width, 1920, "the wallpaper frame is decoded at the video's own width");
  const wideJpeg = jpegOfSize(1920, 1080);
  picker.webview.__send({ type: "frame", index: wide.index, width: wide.width, base64: wideJpeg.toString("base64") });
  await chosen;
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(
    fs.readFileSync(path.join(STORAGE, "wallpaper.jpg")).equals(wideJpeg),
    "applying a video wallpaper paints the decoded frame, not the square preview"
  );
  assert.equal(ext.__internals.statusString().imageInfo.width, 1920, "the status reports the frame's size");

  // Leave the environment as this block found it.
  delete process.env.WE_CONFIG;
  delete process.env.WALLVIA_STILLS_DIR;
  fs.rmSync(frameScratch, { recursive: true, force: true });
  weMod.resetWeCache();

  // 10) restore puts the installation back exactly as it was.
  const expectFor = (buf) => crypto.createHash("sha256").update(buf).digest("base64").replace(/=+$/, "");
  await vscode.commands.__commands["wallvia.restore"]();
  const restored = fs.readFileSync(WB, "utf8");
  assert.ok(!restored.includes("wallvia:start"), "restore removes the injected block");
  assert.ok(!fs.existsSync(cssPath), "restore removes the stylesheet");
  assert.ok(!fs.existsSync(LIVE), "restore removes the live-apply script");
  assert.ok(!fs.existsSync(STAMP), "restore removes the stamp");
  const prodAfter = JSON.parse(fs.readFileSync(PROD, "utf8"));
  assert.equal(prodAfter.checksums[key], expectFor(restored), "restore fixes the checksum");

  // Opening the picker a second time has to refresh it, not just bring the old
  // panel forward: wallpapers get added, caches get cleared, and a thumbnail
  // that failed to build once must get another chance.
  const firstOpen = vscode.commands.__commands["wallvia.pickWE"]();
  await new Promise((r) => setTimeout(r, 300));
  const thumbsBefore = (firstOpen.__messages || []).filter((m) => m.type === "thumb").length;
  // A warm cache legitimately means "nothing left to pump", so the cache is
  // cleared first: rebuilding is exactly what the refresh path is for.
  fs.rmSync(path.join(STORAGE, "thumbs"), { recursive: true, force: true });
  const secondOpen = vscode.commands.__commands["wallvia.pickWE"]();
  assert.equal(secondOpen, firstOpen, "re-opening reveals the panel that is already open");
  await new Promise((r) => setTimeout(r, 300));
  const thumbsAfter = (firstOpen.__messages || []).filter((m) => m.type === "thumb").length;
  assert.ok(
    thumbsAfter > thumbsBefore,
    `re-opening re-runs the thumbnail pump (${thumbsBefore} → ${thumbsAfter})`
  );

  // A panel can be disposed behind the extension's back (tab closed while the
  // host was down). `reveal()` then throws "Webview is disposed", and the
  // command used to fail with no visible effect — it has to build a new panel.
  const dead = firstOpen;
  dead.reveal = () => {
    throw new Error("Webview is disposed");
  };
  const afterDeath = vscode.commands.__commands["wallvia.pickWE"]();
  assert.ok(afterDeath && afterDeath !== dead, "a disposed panel is replaced, not revealed");
  assert.ok(afterDeath.webview.html.includes("class=\"card\""), "the replacement renders the grid");
  await new Promise((r) => setTimeout(r, 300));

  console.log("VSCODE EXTENSION SMOKE TEST PASSED");
  console.log("  marker/link injection, dim=40, glass, checksum, idempotency,");
  console.log("  backup, fade toggle, clear, restore, status, alignment,");
  console.log("  scene.pkg artwork + 16:9 mipmap thumbnails (byte-exact, cached),");
  console.log("  live apply (script + stamp), theme-aware wash,");
  console.log("  settings panel (image + effect + optional switches),");
  console.log("  Wallpaper Engine discovery + picker — all verified.");
  fs.rmSync(ROOT, { recursive: true, force: true });
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("VSCODE SMOKE FAILED:", e && e.message);
    process.exit(1);
  });
}
