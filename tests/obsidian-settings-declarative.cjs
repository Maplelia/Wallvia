// tests/obsidian-settings-declarative.cjs — the Obsidian 1.13+ settings page.
//
// 1.13.0 replaced the imperative PluginSettingTab.display() with a declarative
// getSettingDefinitions(). That path only runs on 1.13+, and the shared mock
// reports an older app on purpose, so the rest of the suite would never touch
// it. This test drives the definitions directly, checks that they cover every
// control the imperative page renders, and then executes the `render` rows for
// real to see the DOM they build.
//
// Run: node tests/obsidian-settings-declarative.cjs
const { install } = require("./mock-loader.cjs");
install();

const assert = require("node:assert");
const { installDom, oneByClass } = require("./mocks/obsidian/dom.js");

function flatten(items, out = [], groups = []) {
  for (const item of items || []) {
    if (!item) continue;
    if (item.type === "group" || item.type === "list" || item.type === "page") {
      groups.push(item.heading ?? item.name);
      flatten(item.items, out, groups);
      continue;
    }
    out.push(item);
  }
  return { defs: out, groups };
}

// Every control key the imperative page builds, with the shape it must keep.
const EXPECTED = {
  enabled: ["toggle", null],
  fit: ["dropdown", null],
  dim: ["slider", { min: 0, max: 1, step: 0.05 }],
  glass: ["slider", { min: 0, max: 100, step: 1 }],
  embed: ["slider", { min: 0, max: 100, step: 1 }],
  blur: ["slider", { min: 0, max: 40, step: 1 }],
  opacity: ["slider", { min: 0, max: 1, step: 0.05 }],
  weCacheDir: ["text", null],
  hires: ["toggle", null],
  videoFrames: ["toggle", null],
  maxImageWidth: ["slider", { min: 0, max: 7680, step: 160 }],
};

async function run() {
  installDom();
  const obsidian = require("obsidian");
  const realIsDesktop = obsidian.Platform.isDesktop;
  obsidian.Platform.isDesktop = false;

  const mod = require("../main.js");
  const Plugin = mod && mod.default ? mod.default : mod;
  const proto = Plugin.prototype;

  let tab = null;
  const realAddSettingTab = proto.addSettingTab;
  proto.addSettingTab = function (instance) {
    tab = instance;
    return realAddSettingTab.call(this, instance);
  };

  const app = {
    workspace: { on: () => ({}), onLayoutReady: (cb) => cb(), containerEl: {} },
    vault: {
      getFiles: () => [{ path: "Wallpapers/a.png" }],
      on: () => ({}),
      getAbstractFileByPath: () => {
        const f = new obsidian.TFile();
        f.path = "Wallpapers/a.png";
        return f;
      },
      getResourcePath: () => "app://vault/Wallpapers/a.png",
      adapter: {
        stat: async () => ({ type: "file", mtime: 7 }),
        getResourcePath: () => "app://vault/Wallpapers/a.png",
      },
    },
  };

  const plugin = new Plugin(app, { id: "wallvia" });
  plugin.loadData = async () => ({ image: "Wallpapers/a.png", opacity: 0.6, glass: 55 });
  await plugin.onload();
  assert.ok(tab, "the plugin registers its setting tab");
  try {
    // ---- no desktop API: the whole Wallpaper Engine section is absent ----
    let { defs, groups } = flatten(tab.getSettingDefinitions());
    let byKey = new Map(defs.filter((d) => d.control).map((d) => [d.control.key, d]));
    assert.ok(
      !byKey.has("hires") && !byKey.has("weCacheDir"),
      "no Wallpaper Engine controls when the desktop API is missing"
    );

    // ---- desktop API present: the full page ----------------------------
    obsidian.Platform.isDesktop = true;
    ({ defs, groups } = flatten(tab.getSettingDefinitions()));
    byKey = new Map(defs.filter((d) => d.control).map((d) => [d.control.key, d]));

    for (const [key, [type, limits]] of Object.entries(EXPECTED)) {
      const def = byKey.get(key);
      assert.ok(def, `definition for key "${key}" exists`);
      assert.equal(def.control.type, type, `"${key}" is a ${type}`);
      if (limits) {
        assert.deepEqual(
          { min: def.control.min, max: def.control.max, step: def.control.step },
          limits,
          `"${key}" limits`
        );
      }
    }
    assert.deepEqual(
      byKey.get("fit").control.options,
      { cover: "覆盖 Cover", fill: "填充 Fill", center: "居中 Center" },
      "Fit options"
    );
    assert.deepEqual(groups, ["Wallpaper Engine", "可选行为"], "two sibling headings");

    const names = defs.map((d) => d.name);
    for (const row of ["背景图片", "压暗颜色 Wash", "选择已下载的壁纸", "恢复默认效果"]) {
      assert.ok(names.some((n) => n === row), `row "${row}" exists`);
    }
    assert.ok(defs.find((d) => d.name === "恢复默认效果").action, "the reset row is an action");

    // ---- execute the render rows for real ------------------------------
    // `control` binds exactly one control per row, so the rows that hold two
    // (the image buttons, the wash pair) or a custom element (the preview, the
    // async status line) use the `render` escape hatch.
    const host = tab.containerEl;
    const renderRows = defs.filter((d) => d.render);
    assert.equal(renderRows.length, 3, "three rows use the render escape hatch");
    for (const def of renderRows) {
      def.render(new obsidian.Setting(host), { listEl: host });
    }

    const preview = oneByClass(host, "wallvia-preview");
    assert.ok(preview, "the image row's render() builds the preview");
    assert.ok(
      String(preview.style.backgroundImage).includes("app://vault/Wallpapers/a.png"),
      "the preview points at the current image"
    );

    const buttons = host.children
      .map((c) => c.__setting)
      .filter(Boolean)
      .flatMap((s) => s.controls.filter((c) => c.type === "button"));
    assert.deepEqual(
      buttons.map((b) => b.text),
      ["选择图片…", "清除", "从 Wallpaper Engine 选择…"],
      "both image buttons and the Wallpaper Engine picker are real buttons"
    );

    const washRow = host.children
      .map((c) => c.__setting)
      .filter(Boolean)
      .find((s) => {
        return (
          s.controls.some((c) => c.type === "dropdown") &&
          s.controls.some((c) => c.type === "color")
        );
      });
    assert.ok(washRow, "the wash row still holds a dropdown *and* a colour picker");
    assert.ok(oneByClass(host, "wallvia-we-status"), "the async status line is rendered");

    console.log("OBSIDIAN DECLARATIVE SETTINGS TEST PASSED");
    console.log("  every imperative control has a declarative definition (key, type,");
    console.log("  slider limits, dropdown options, group headings), and all three");
    console.log("  render rows build the preview, both image buttons, the wash");
    console.log("  dropdown + colour picker and the async Wallpaper Engine status line.");
  } finally {
    proto.addSettingTab = realAddSettingTab;
    // Shared mock state: leave the platform flag as the other tests expect it.
    obsidian.Platform.isDesktop = realIsDesktop;
  }
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("TEST FAILED:", e && e.message);
    process.exit(1);
  });
}
