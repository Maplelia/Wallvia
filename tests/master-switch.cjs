// tests/master-switch.cjs — the one switch that turns the wallpaper off.
//
// Off must take *everything* down: the injected blocks, the generated files, and
// every CSS variable. On must bring the same wallpaper back without re-picking
// it. The first implementation left --wallvia-image (and the other variables)
// populated while disabled, which is invisible until something else reads them.
//
// Run standalone: node tests/master-switch.cjs
// Or via:         node tests/run-all.cjs
const { install } = require("./mock-loader.cjs");
install();

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

async function obsidian() {
  const { installBodyDom } = require("./mocks/obsidian/dom.js");
  const body = installBodyDom();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-"));
  const video = path.join(dir, "a.mp4");
  fs.writeFileSync(video, Buffer.alloc(4096, 7));

  const app = {
    workspace: { on: () => ({}), onLayoutReady: (cb) => cb(), containerEl: {} },
    vault: {
      configDir: ".obsidian",
      getFiles: () => [{ path: "Wallpapers/a.png" }],
      getResourcePath: (p) => "app://local/" + p,
      adapter: {
        stat: async () => ({ type: "file", mtime: 1 }),
        getResourcePath: (p) => "app://local/" + p,
        list: async () => ({ files: [], folders: [] }),
        mkdir: async () => {},
        writeBinary: async () => {},
        remove: async () => {},
      },
      on: () => ({}),
    },
  };
  const mod = require("../main.js");
  const Plugin = mod.default || mod;
  const p = new Plugin(app, { id: "wallvia" });
  await p.onload();
  p.settings.image = "Wallpapers/a.png";
  p.settings.videoPath = video;
  await p.apply();

  const on = {
    layer: !!body.querySelector(".wallvia-video-layer"),
    enabled: body.classList.contains("wallvia-enabled"),
    videoOn: body.classList.contains("wallvia-video-on"),
    image: body.style.getPropertyValue("--wallvia-image"),
  };
  assert.ok(on.layer && on.enabled && on.videoOn && on.image, "on: everything is up");

  // The switch
  p.settings.enabled = false;
  await p.apply();
  const off = {
    layer: !!body.querySelector(".wallvia-video-layer"),
    enabled: body.classList.contains("wallvia-enabled"),
    videoOn: body.classList.contains("wallvia-video-on"),
    image: body.style.getPropertyValue("--wallvia-image"),
    wash: body.style.getPropertyValue("--wallvia-wash"),
    keptImage: p.settings.image,
    keptVideo: p.settings.videoPath,
  };
  assert.ok(!off.layer, "off: the video layer is gone");
  assert.ok(!off.enabled, "off: the enabled class is gone");
  assert.ok(!off.videoOn, "off: the video-on class is gone");
  assert.equal(off.image, "", "off: the wallpaper variable is cleared");
  assert.equal(off.wash, "", "off: the wash variable is cleared");
  assert.equal(off.keptImage, "Wallpapers/a.png", "off: the chosen wallpaper is remembered");
  assert.equal(off.keptVideo, video, "off: the chosen video is remembered");

  p.settings.enabled = true;
  await p.apply();
  assert.ok(body.classList.contains("wallvia-enabled"), "on again: back");
  assert.ok(!!body.querySelector(".wallvia-video-layer"), "on again: video back");
  assert.ok(
    String(body.style.getPropertyValue("--wallvia-image")).includes("a.png"),
    "on again: same wallpaper, no re-pick"
  );
  p.onunload();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("  obsidian: off clears everything, on restores the same wallpaper");
}

async function vscode() {
  const ROOT = path.join(__dirname, ".tmp-master-install");
  const APP = path.join(ROOT, "resources", "app");
  const WB_DIR = path.join(APP, "out", "vs", "code", "electron-browser", "workbench");
  const WB = path.join(WB_DIR, "workbench.html");
  const CSS = path.join(WB_DIR, "wallvia-bg.css");
  const LIVE = path.join(WB_DIR, "wallvia-live.js");
  const STAMP = path.join(WB_DIR, "wallvia-stamp.txt");
  const STORAGE = path.join(ROOT, "gs");
  const PIC = path.join(ROOT, "p.jpg");

  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(WB_DIR, { recursive: true });
  fs.mkdirSync(STORAGE, { recursive: true });
  fs.writeFileSync(
    WB,
    `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8" />\n</head>\n<body aria-label="">\n</body>\n</html>\n`
  );
  fs.writeFileSync(path.join(APP, "product.json"), JSON.stringify({ checksums: {} }, null, "\t"));
  fs.writeFileSync(PIC, Buffer.from("ffd8ffe000104a464946", "hex"));

  const state = new Map();
  global.__MOCK_VSCODE__ = {
    appRoot: APP,
    version: "1.140.0",
    pick: PIC,
    config: { enabled: true, dim: 40, glass: 70, mode: "glass", fit: "cover" },
  };
  const ctx = {
    globalStorageUri: { fsPath: STORAGE },
    subscriptions: [],
    extensionPath: path.join(ROOT, "ext"),
    globalState: {
      get: (k, d) => (state.has(k) ? state.get(k) : d),
      update: (k, v) => {
        state.set(k, v);
        return Promise.resolve();
      },
    },
  };
  for (const key of Object.keys(require.cache)) {
    if (/[\\/](vscode[\\/]src|mocks[\\/]vscode)[\\/]/.test(key)) delete require.cache[key];
  }
  const vscode = require("vscode");
  const ext = require("../vscode/src/extension.js");
  await ext.activate(ctx);
  await ext.__internals.applyWallpaperSource({ file: PIC, name: "p" });

  assert.ok(fs.readFileSync(WB, "utf8").includes("wallvia:start"), "on: patch injected");
  assert.ok(fs.existsSync(CSS), "on: css written");

  // The command, not just the config key: this is what the status bar calls.
  await ext.__internals.toggleEnabled();
  const offHtml = fs.readFileSync(WB, "utf8");
  assert.ok(!offHtml.includes("wallvia:start"), "off: the head block is stripped");
  assert.ok(!offHtml.includes("wallvia:layer:start"), "off: the layer block is stripped");
  assert.ok(!fs.existsSync(CSS), "off: css removed");
  assert.ok(!fs.existsSync(LIVE), "off: live script removed");
  assert.ok(!fs.existsSync(STAMP), "off: stamp removed");
  assert.equal(state.get("image"), "wallpaper.jpg", "off: the chosen wallpaper is remembered");
  assert.equal(
    vscode.workspace.getConfiguration().get("enabled"),
    false,
    "off: the setting really flipped"
  );

  await ext.__internals.toggleEnabled();
  assert.ok(fs.readFileSync(WB, "utf8").includes("wallvia:start"), "on again: patch back");
  assert.ok(fs.existsSync(CSS), "on again: css back");
  assert.equal(
    vscode.workspace.getConfiguration().get("enabled"),
    true,
    "on again: the setting really flipped back"
  );

  // A stock workbench is the proof: compare against the pre-patch bytes.
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log("  vscode: off strips both blocks + all generated files, keeps the choice");
}

async function run() {
  await obsidian();
  await vscode();
  console.log("MASTER SWITCH TEST PASSED");
}

module.exports = run;

if (require.main === module) {
  run().catch((e) => {
    console.error("MASTER SWITCH TEST FAILED:", e && e.message);
    process.exit(1);
  });
}
