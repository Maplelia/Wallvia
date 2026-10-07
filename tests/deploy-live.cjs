// Deploy Wallvia to the REAL VS Code install using the extension's own
// applyPatch() code path (via the test mock pointed at the real install).
// Usage: node tests/deploy-live.cjs
const fs = require("node:fs");
const path = require("node:path");
const { install } = require("./mock-loader.cjs");

const APP_ROOT = "D:\\Microsoft VS Code\\07f806f999\\resources\\app";
const STORAGE = "C:\\Users\\Administrator\\AppData\\Roaming\\Code\\User\\globalStorage\\wallvia.wallvia";
const SETTINGS = "C:\\Users\\Administrator\\AppData\\Roaming\\Code\\User\\settings.json";

const raw = fs
  .readFileSync(SETTINGS, "utf8")
  .replace(/^\s*\/\/.*$/gm, "") // line comments
  .replace(/,(\s*[}\]])/g, "$1"); // trailing commas (JSONC)
const s = JSON.parse(raw);

global.__MOCK_VSCODE__ = {
  appRoot: APP_ROOT,
  version: "1.140.0",
  config: {
    enabled: s["wallvia.enabled"] !== false,
    dim: s["wallvia.dim"] ?? 45,
    glass: s["wallvia.glass"] ?? 55,
    blur: 0,
    mode: s["wallvia.mode"] || "glass",
    fit: s["wallvia.fit"] || "cover",
    autoReapply: true,
  },
};
install();

const imageFile = fs.readdirSync(STORAGE).find((f) => /^wallpaper\./i.test(f));
if (!imageFile) throw new Error("no wallpaper.* in " + STORAGE);

const state = new Map([["image", imageFile]]);
const ctx = {
  globalStorageUri: { fsPath: STORAGE },
  subscriptions: [],
  globalState: {
    get: (k, d) => (state.has(k) ? state.get(k) : d),
    update: (k, v) => (state.set(k, v), Promise.resolve()),
  },
};

(async () => {
  const ext = require("../vscode/src/extension.js");
  await ext.activate(ctx);

  // Re-apply the wallpaper Wallpaper Engine is showing right now, through the
  // real code path, so a scene package contributes its full-resolution
  // artwork instead of the small preview thumbnail.
  const we = require("../vscode/src/wallpaper-engine.js");
  const current = we.currentWallpapers()[0];
  if (current) {
    console.log("re-applying current WE wallpaper:", current.file);
    await ext.__internals.applyWallpaperSource({
      file: current.file,
      preview: current.preview,
      dir: current.dir || require("node:path").dirname(current.file),
      name: "当前壁纸",
    });
  } else {
    await ext.__internals.applyPatch();
  }

  const status = ext.__internals.statusString();
  console.log(JSON.stringify(status, null, 2));
  if (!status.patched) throw new Error("patch was not applied");
})();
