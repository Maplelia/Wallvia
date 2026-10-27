// Deploy Wallvia to the REAL VS Code install using the extension's own
// applyPatch() code path (via the test mock pointed at the real install).
//
// Usage: node tools/deploy-live.cjs
//
// Every path is discovered, not hard-coded. The first version pinned
// `...\07f806f999\resources\app` — a VS Code version directory that no longer
// exists — so the script wrote to a stale tree and reported success against it.
// Same class of bug as the stale `.bak` baseline: a path that is only correct
// until the next update.
const fs = require("node:fs");
const path = require("node:path");
const { install } = require("../tests/mock-loader.cjs");

/** The newest VS Code install that actually has a workbench.html. */
function findAppRoot() {
  const roots = [
    process.env.WALLVIA_VSCODE_APP,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "resources", "app"),
    "C:\\Program Files\\Microsoft VS Code\\resources\\app",
    "C:\\Program Files (x86)\\Microsoft VS Code\\resources\\app",
  ].filter(Boolean);
  for (const root of roots) {
    if (root && fs.existsSync(path.join(root, "product.json"))) return root;
  }
  // A user-level install keeps one directory per version; take the newest.
  const base = path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code");
  if (fs.existsSync(base)) {
    const candidates = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[0-9a-f]{10}$/.test(e.name))
      .map((e) => path.join(base, e.name, "resources", "app"))
      .filter((p) => fs.existsSync(path.join(p, "product.json")))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  return null;
}

const APP_ROOT = findAppRoot();
if (!APP_ROOT) {
  console.error(
    "未找到 VS Code 安装目录。用 WALLVIA_VSCODE_APP 指定 ...\\resources\\app,或确认已安装桌面版 VS Code。"
  );
  process.exit(1);
}

const USER_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, "Code", "User")
  : path.join(require("node:os").homedir(), ".config", "Code", "User");
const STORAGE = path.join(USER_DIR, "globalStorage", "wallvia.wallvia");
const SETTINGS = path.join(USER_DIR, "settings.json");

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
