// tests/obsidian-we-picker.cjs — the Wallpaper Engine → vault copy path.
//
// Loads the bundled plugin with the mocked Obsidian API, points a fake
// "Wallpaper Engine wallpaper" at a real temporary image file and drives
// applyWeWallpaper() end to end: mkdir, writeBinary, stale-file cleanup,
// settings update. Also checks the fit mapping and the legacy fit migration.
// No Wallpaper Engine install is required.
//
// Run standalone: node tests/obsidian-we-picker.cjs
const { install } = require("./mock-loader.cjs");
install();

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 1x1 transparent PNG. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

async function run() {
  const obsidian = require("obsidian");
  const notices = [];
  const RealNotice = obsidian.Notice;
  obsidian.Notice = class extends RealNotice {
    constructor(message) {
      super(message);
      notices.push(message);
    }
  };

  const mod = require("../main.js");
  const Plugin = mod && mod.default ? mod.default : mod;
  const proto = Plugin.prototype;

  // Capture the command registrations made by onload().
  const commands = [];
  proto.addCommand = function (command) {
    commands.push(command);
    return command;
  };

  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-we-")), "preview.png");
  fs.writeFileSync(tmpFile, PNG_BYTES);

  const mkdirCalls = [];
  const writes = [];
  const removed = [];
  const app = {
    workspace: {
      on: (evt) => ({ evt }),
      onLayoutReady: (cb) => cb(),
      containerEl: {},
    },
    vault: {
      getFiles: () => [],
      on: (evt) => ({ evt }),
      adapter: {
        stat: async () => ({ type: "file", mtime: 1 }),
        getResourcePath: (p) => "app://local/" + encodeURIComponent(p),
        mkdir: async (dir, recursive) => {
          mkdirCalls.push([dir, recursive]);
        },
        writeBinary: async (target, data) => {
          writes.push([target, data]);
        },
        list: async () => ({
          files: ["Wallpapers/wallvia-we-stale.jpg", "Wallpapers/keep-me.md"],
          folders: [],
        }),
        remove: async (target) => {
          removed.push(target);
        },
      },
    },
  };

  const { installBodyDom } = require("./mocks/obsidian/dom.js");
  const body = installBodyDom();
  const props = {
    get: (k) => body.style.getPropertyValue(k),
    set: (k, v) => body.style.setProperty(k, v),
    delete: (k) => body.style.removeProperty(k),
  };

  try {
    const plugin = new Plugin(app, { id: "wallvia" });
    await plugin.onload();

    const weCommand = commands.find((c) => c.id === "pick-wallpaper-engine");
    assert.ok(weCommand, "pick-wallpaper-engine command is registered");
    assert.equal(weCommand.name, "Choose from Wallpaper Engine", "command name");
    assert.equal(plugin.settings.weCacheDir, "Wallpapers", "default cache dir");

    // --- fit mapping (cover | fill | center) -----------------------------
    plugin.settings.image = "Wallpapers/a.png";
    plugin.settings.fit = "fill";
    await plugin.apply();
    assert.equal(props.get("--wallvia-fit"), "100% 100%", "fill maps to 100% 100%");
    plugin.settings.fit = "center";
    await plugin.apply();
    assert.equal(props.get("--wallvia-fit"), "auto", "center maps to auto");
    plugin.settings.fit = "cover";
    await plugin.apply();
    assert.equal(props.get("--wallvia-fit"), "cover", "cover maps to cover");

    // --- legacy data.json values must not crash --------------------------
    proto.loadData = async () => ({ fit: "contain" });
    const legacyContain = new Plugin(app, { id: "wallvia" });
    await legacyContain.onload();
    assert.equal(legacyContain.settings.fit, "center", "legacy contain → center");
    proto.loadData = async () => ({ fit: "tile" });
    const legacyTile = new Plugin(app, { id: "wallvia" });
    await legacyTile.onload();
    assert.equal(legacyTile.settings.fit, "fill", "legacy tile → fill");
    proto.loadData = async () => ({ fit: "nonsense" });
    const legacyBogus = new Plugin(app, { id: "wallvia" });
    await legacyBogus.onload();
    assert.equal(legacyBogus.settings.fit, "cover", "unknown fit → cover");
    delete proto.loadData;

    // --- copy a Wallpaper Engine preview into the vault ------------------
    plugin.settings.image = "";
    plugin.settings.enabled = false; // picking a wallpaper must turn it back on
    await plugin.applyWeWallpaper({
      id: "3536645955",
      title: "Test wallpaper",
      type: "scene",
      source: "workshop",
      // Deliberately a directory that does not exist: this suite pins the
      // *preview* copy path, while tests/obsidian-scene-pkg.cjs covers the
      // full-resolution artwork a real scene.pkg provides.
      dir: path.join(os.tmpdir(), "wallvia-no-scene-package"),
      preview: tmpFile,
    });

    assert.deepEqual(
      mkdirCalls[0],
      ["Wallpapers", true],
      "cache dir is created recursively before writing"
    );
    assert.equal(writes.length, 1, "exactly one file is written");
    assert.equal(
      writes[0][0],
      "Wallpapers/wallvia-we-3536645955.png",
      "file name is wallvia-we-<id>.<ext>"
    );
    assert.ok(writes[0][1] instanceof ArrayBuffer, "writeBinary receives an ArrayBuffer");
    assert.equal(writes[0][1].byteLength, PNG_BYTES.length, "byte length is preserved");
    assert.deepEqual(Buffer.from(writes[0][1]), PNG_BYTES, "bytes are identical");
    assert.deepEqual(
      removed,
      ["Wallpapers/wallvia-we-stale.jpg"],
      "only stale wallvia-we-* files are removed"
    );
    assert.equal(plugin.settings.image, "Wallpapers/wallvia-we-3536645955.png", "settings updated");
    assert.equal(plugin.settings.enabled, true, "picking a wallpaper re-enables it");
    assert.equal(
      props.get("--wallvia-image").includes("wallvia-we-3536645955.png"),
      true,
      "background points at the copied file"
    );
    assert.ok(notices.includes("壁纸已应用:Test wallpaper"), "success notice shown");

    // --- a nested cache folder is created segment by segment -------------
    mkdirCalls.length = 0;
    writes.length = 0;
    removed.length = 0;
    plugin.settings.weCacheDir = "/My/Deep/";
    await plugin.applyWeWallpaper({
      id: "arsenal",
      title: "Arsenal",
      type: "scene",
      source: "builtin",
      dir: path.join(os.tmpdir(), "wallvia-no-scene-package-2"),
      preview: tmpFile,
    });
    assert.equal(mkdirCalls[0][0], "My/Deep", "leading/trailing slashes are normalised");
    assert.equal(mkdirCalls[0][1], true, "recursive mkdir is requested");
    assert.equal(writes[0][0], "My/Deep/wallvia-we-arsenal.png", "nested target path");

    // --- an unreadable preview must not touch the vault or the settings --
    plugin.settings.image = "Wallpapers/keep.png";
    writes.length = 0;
    removed.length = 0;
    await plugin.applyWeWallpaper({
      id: "gone",
      title: "Missing",
      type: "scene",
      source: "workshop",
      dir: "D:/nope",
      preview: path.join(os.tmpdir(), "wallvia-does-not-exist.png"),
    });
    assert.equal(writes.length, 0, "no write when the preview cannot be read");
    assert.equal(removed.length, 0, "no cleanup when the copy failed");
    assert.equal(plugin.settings.image, "Wallpapers/keep.png", "settings unchanged on failure");
  } finally {
    delete proto.addCommand;
    delete proto.loadData;
    obsidian.Notice = RealNotice;
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  }

  console.log("OBSIDIAN WALLPAPER-ENGINE PICKER TEST PASSED");
  console.log("  command, fit mapping, legacy fit, mkdir/writeBinary/cleanup, failure path.");
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("WE PICKER TEST FAILED:", (e && e.message) || e);
    process.exit(1);
  });
}
