// tests/obsidian-smoke.cjs — load the bundled Obsidian plugin with a mocked
// API and drive onload/apply/onunload end to end.
//
// Run standalone: node tests/obsidian-smoke.cjs
// Or via:         node tests/run-all.cjs
const { install } = require("./mock-loader.cjs");
install();

const assert = require("node:assert");

async function run() {
  // esbuild's CJS output puts an `export default` class behind `.default`
  // (with __esModule); Obsidian's loader unwraps that, and so do we.
  const mod = require("../main.js");
  const Plugin = mod && mod.default ? mod.default : mod;
  assert.equal(typeof Plugin, "function", "main.js exposes a plugin constructor");
  assert.ok(new Plugin({}, {}) instanceof require("obsidian").Plugin, "extends obsidian.Plugin");

  // Fake app/workspace/vault so onload() runs end to end.
  const handlers = {};
  const app = {
    workspace: {
      on: (evt, cb) => {
        handlers[evt] = cb;
        return { evt };
      },
      onLayoutReady: (cb) => cb(),
      containerEl: {},
    },
    vault: {
      getFiles: () => [{ path: "Wallpapers/a.png" }, { path: "notes.md" }],
      getResourcePath: (p) => "app://local/" + encodeURIComponent(p),
      adapter: {
        stat: async () => ({ type: "file", mtime: 123 }),
        getResourcePath: (p) => "app://local/" + encodeURIComponent(p),
      },
      on: (evt) => ({ evt }),
    },
  };

  // The plugin's own DOM shim: the same mock element the panel suite renders
  // into, so a new class-list or inline-style call in apply() cannot break it.
  const { installBodyDom } = require("./mocks/obsidian/dom.js");
  const body = installBodyDom();

  const plugin = new Plugin(app, { id: "wallvia" });
  await plugin.onload();
  assert.ok(handlers["css-change"], "css-change handler registered");
  assert.ok(handlers["layout-change"], "layout-change handler registered");
  assert.ok(handlers["active-leaf-change"], "active-leaf-change handler registered");

  await plugin.apply();
  assert.ok(!body.classList.contains("wallvia-enabled"), "no image yet → not enabled");

  // simulate a picked image
  plugin.settings.image = "Wallpapers/a.png";
  await plugin.apply();
  assert.ok(body.classList.contains("wallvia-enabled"), "enabled after image set");
  assert.ok(body.classList.contains("wallvia-glass"), "glass class applied");
  assert.ok(
    String(body.style.getPropertyValue("--wallvia-image")).includes("a.png"),
    "--wallvia-image set"
  );
  assert.equal(body.style.getPropertyValue("--wallvia-fit"), "cover", "fit variable");
  assert.equal(body.style.getPropertyValue("--wallvia-blur"), "10px", "blur variable");
  assert.equal(
    body.style.getPropertyValue("--wallvia-wash"),
    "8 10 18",
    "the wash follows the theme (this body has no theme-light class)"
  );

  // css-change must be safe to fire (theme switching)
  handlers["css-change"]();

  plugin.onunload();
  assert.ok(!body.classList.contains("wallvia-enabled"), "cleanup removes enabled class");
  assert.ok(!body.classList.contains("wallvia-glass"), "cleanup removes glass class");
  assert.equal(Object.keys(body.style).length, 0, "cleanup removes all css variables");

  console.log("OBSIDIAN PLUGIN SMOKE TEST PASSED");
  console.log("  onload events, apply(), css-change, onunload cleanup, theme wash — verified.");
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("OBSIDIAN SMOKE FAILED:", e && e.message);
    process.exit(1);
  });
}
