// tests/obsidian-settings-tab.cjs — the settings page must expose the image
// preview *and* every effect control.
//
// This is the regression guard for the report "Obsidian 里没有图片设置项(壁纸
// 效果编辑)、也没有图片预览": the preview used to be resolved with a bare
// adapter call before the effect rows, so any failure there aborted display()
// and silently removed everything below it. The last case here makes resource
// resolution throw on purpose and asserts the controls are still rendered.
//
// Run standalone: node tests/obsidian-settings-tab.cjs
const { install } = require("./mock-loader.cjs");
install();

const assert = require("node:assert");
const { installDom, oneByClass } = require("./mocks/obsidian/dom.js");

/** The Setting rows the tab rendered, in order. */
function rows(containerEl) {
  return containerEl.children.map((c) => c.__setting).filter(Boolean);
}

function names(containerEl) {
  return rows(containerEl).map((s) => s.name);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Vault stub; `mode` selects how resource resolution behaves. */
function makeApp(obsidian, mode) {
  const file = new obsidian.TFile();
  file.path = "Wallpapers/a.png";
  return {
    workspace: { on: () => ({}), onLayoutReady: (cb) => cb(), containerEl: {} },
    vault: {
      getFiles: () => [{ path: "Wallpapers/a.png" }, { path: "notes.md" }],
      on: () => ({}),
      getAbstractFileByPath: () => {
        if (mode === "throw-all") throw new Error("no index");
        return mode === "adapter-only" ? null : file;
      },
      getResourcePath: () => {
        if (mode === "throw-all") throw new Error("no resource path");
        return "app://vault/Wallpapers/a.png";
      },
      adapter: {
        stat: async () => ({ type: "file", mtime: 7 }),
        getResourcePath: () => {
          if (mode === "throw-all") throw new Error("adapter has no resource path");
          return "app://vault/Wallpapers/a.png";
        },
      },
    },
  };
}

/** 0.2.1-shaped data.json: a boolean glass switch, no numeric level. */
const LEGACY = {
  image: "Wallpapers/a.png",
  opacity: 0.6,
  dim: 0.35,
  blur: 10,
  fit: "cover",
  enabled: true,
  glassEditors: true,
  weCacheDir: "Wallpapers",
};

const EFFECT_ROWS = [
  "对齐方式 Fit",
  "压暗 Dim",
  "通透 Glass",
  "嵌入面板透明度",
  "模糊 Blur",
  "图片不透明度",
];

async function run() {
  const body = installDom();
  const obsidian = require("obsidian");
  // No Wallpaper Engine scan in this test: the section is desktop-only.
  obsidian.Platform.isDesktop = false;

  const mod = require("../main.js");
  const Plugin = mod && mod.default ? mod.default : mod;
  const proto = Plugin.prototype;

  // Capture the tab the plugin registers (the mock's addSettingTab is a no-op).
  let tab = null;
  const realAddSettingTab = proto.addSettingTab;
  proto.addSettingTab = function (instance) {
    tab = instance;
    return realAddSettingTab.call(this, instance);
  };

  let saves = 0;
  const realSaveData = proto.saveData;
  proto.saveData = async function (data) {
    saves++;
    return realSaveData.call(this, data);
  };

  const app = makeApp(obsidian, "normal");
  const plugin = new Plugin(app, { id: "wallvia" });
  plugin.loadData = async () => LEGACY;
  await plugin.onload();

  assert.ok(tab, "onload() registers the settings tab");
  const normalTab = tab;
  normalTab.display();

  // --- regression first: a failing preview must not truncate the page ----
  // On the pre-0.2.2 code this is where the page died: the preview resolved
  // its URL before the effect rows, so a throw took every control below it
  // with it — the reported "没有图片设置项 / 没有图片预览".
  const broken = new Plugin(makeApp(obsidian, "throw-all"), { id: "wallvia" });
  broken.loadData = async () => LEGACY;
  await broken.onload();
  const brokenTab = tab;
  brokenTab.display();
  const brokenNames = names(brokenTab.containerEl);
  for (const row of EFFECT_ROWS) {
    assert.ok(
      brokenNames.some((n) => n.startsWith(row)),
      `controls survive a failing preview — missing "${row}" in: ${brokenNames.join(" | ")}`
    );
  }
  assert.ok(
    oneByClass(brokenTab.containerEl, "wallvia-preview-missing"),
    "an unresolvable image renders an explanation instead of an empty box"
  );

  // --- the preview on the healthy path ----------------------------------
  const preview = oneByClass(normalTab.containerEl, "wallvia-preview");
  assert.ok(preview, "settings page renders the image preview box");
  assert.ok(
    String(preview.style.backgroundImage).includes("app://vault/Wallpapers/a.png"),
    "preview points at the current image — got: " + preview.style.backgroundImage
  );
  // Same contract as the panel: the stylesheet owns background-size so the
  // whole image is visible (obsidian-styles.cjs asserts the `contain` rule).
  assert.equal(
    String(preview.style.backgroundSize || ""),
    "",
    "the preview leaves background-size to the stylesheet (contain)"
  );

  // --- every effect control from dsh-web-all ----------------------------
  const rendered = names(normalTab.containerEl);
  for (const row of EFFECT_ROWS) {
    assert.ok(
      rendered.some((n) => n.startsWith(row)),
      `settings page has the "${row}" control — rendered: ${rendered.join(" | ")}`
    );
  }

  // --- Glass is a 0-100 level, matching dsh-web-all and the VS Code port -
  const glassRow = rows(normalTab.containerEl).find((s) => s.name.startsWith("通透 Glass"));
  const glass = glassRow.control("slider");
  assert.deepEqual(glass.limits, { min: 0, max: 100, step: 1 }, "Glass is a 0-100 slider");
  assert.equal(glass.value, 55, "Glass defaults to 55, the same default as the VS Code port");

  const before = saves;
  glass.fire(20);
  await tick();
  await tick();
  assert.equal(plugin.settings.glass, 20, "moving the Glass slider updates the setting");
  assert.ok(saves > before, "moving the Glass slider persists data.json");
  assert.equal(
    body.style.getPropertyValue("--wallvia-glass"),
    "87.0%",
    "Glass 20 writes a 87.0% pane fill (0-100 level → surface fill)"
  );

  // --- embedded plugin web views get their own lever --------------------
  // opencode-obsidian iframes a web app served on 127.0.0.1; that document is
  // cross-origin, so its own opaque background cannot be styled away — the
  // frame has to be composited. 0 keeps the old behaviour exactly.
  const embedRow = rows(normalTab.containerEl).find((s) => s.name.startsWith("嵌入面板透明度"));
  const embed = embedRow.control("slider");
  assert.deepEqual(embed.limits, { min: 0, max: 100, step: 1 }, "embedded transparency is 0-100");
  assert.equal(embed.value, 0, "it defaults to 0 — do not touch the plugin's frame");
  embed.fire(65);
  await tick();
  await tick();
  assert.equal(plugin.settings.embed, 65, "moving the slider updates the setting");
  assert.equal(
    body.style.getPropertyValue("--wallvia-embed-opacity"),
    "0.58",
    "65 → 0.58 frame opacity (0 leaves it at 1.00, 100 floors at 0.35)"
  );

  // Fit offers exactly the three documented alignments.
  const fitRow = rows(normalTab.containerEl).find((s) => s.name.startsWith("对齐方式 Fit"));
  assert.deepEqual(
    fitRow.control("dropdown").options.map((o) => o.value),
    ["cover", "fill", "center"],
    "Fit offers 覆盖 / 填充 / 居中 only"
  );

  // --- the wash follows the theme, or is pinned by the user --------------
  // The dim layer used to be pure black in a dark theme and pure white in a
  // light one, hard-coded in the stylesheet. It is a CSS variable now, so the
  // colour choice is testable without a browser.
  const washRow = rows(normalTab.containerEl).find((s) => s.name.startsWith("压暗颜色 Wash"));
  assert.ok(washRow, "settings page offers the wash colour control");
  const washSelect = washRow.control("dropdown");
  assert.deepEqual(
    washSelect.options.map((o) => o.value),
    ["auto", "dark", "light", "custom"],
    "wash offers auto / dark / light / custom"
  );
  assert.equal(washSelect.value, "auto", "wash defaults to following the theme");

  const washProp = () => body.style.getPropertyValue("--wallvia-wash");
  await plugin.apply();
  assert.equal(washProp(), "8 10 18", "auto in a dark theme washes towards the dark tone");
  body.classList.add("theme-light");
  await plugin.apply();
  assert.equal(washProp(), "246 247 250", "auto in a light theme washes towards the light tone");
  body.classList.remove("theme-light");

  washSelect.fire("light");
  await tick();
  await tick();
  assert.equal(washProp(), "246 247 250", "pinning light ignores the dark theme");
  washSelect.fire("dark");
  await tick();
  await tick();
  assert.equal(washProp(), "8 10 18", "pinning dark ignores the theme");

  // The colour picker switches the mode to custom in one gesture, so picking a
  // colour cannot silently do nothing.
  const washColor = washRow.control("color");
  assert.ok(washColor, "the wash row offers a colour picker");
  washColor.fire("#3366cc");
  await tick();
  await tick();
  assert.equal(plugin.settings.wash, "custom", "picking a colour selects custom mode");
  assert.equal(washProp(), "51 102 204", "#3366cc becomes the 51 102 204 triplet");

  plugin.settings.wash = "custom";
  plugin.settings.washColor = "not-a-colour";
  await plugin.apply();
  assert.equal(washProp(), "8 10 18", "an unparsable colour falls back to the theme tone");
  plugin.settings.wash = "auto";
  plugin.settings.washColor = "#080a12";

  // --- the three behaviour switches -------------------------------------
  // They live in the Wallpaper Engine section (they only mean anything for a
  // downloaded wallpaper), so render the tab once more with the desktop API
  // available. The scan they kick off is fire-and-forget.
  obsidian.Platform.isDesktop = true;
  normalTab.display();
  obsidian.Platform.isDesktop = false;

  const switchRow = (label) => rows(normalTab.containerEl).find((s) => s.name.startsWith(label));
  const hires = switchRow("场景包取原图");
  const frames = switchRow("视频抽帧");
  const cap = switchRow("最大图源宽度");

  assert.ok(hires, "the settings page offers the scene-artwork switch");
  assert.ok(frames, "the settings page offers the video-frame switch");
  assert.ok(cap, "the settings page offers the maximum source width");
  assert.equal(hires.control("toggle").value, true, "scene artwork is on by default");
  assert.equal(frames.control("toggle").value, true, "video frames are on by default");
  assert.deepEqual(
    cap.control("slider").limits,
    { min: 0, max: 7680, step: 160 },
    "the width cap runs 0-7680 in steps of 160, matching the VS Code port"
  );
  assert.equal(cap.control("slider").value, 0, "0 means 'the sharpest level', the old behaviour");

  // Flipping them persists and survives a reload of the model.
  hires.control("toggle").fire(false);
  await tick();
  assert.equal(plugin.settings.hires, false, "turning scene artwork off is recorded");
  hires.control("toggle").fire(true);
  await tick();
  assert.equal(plugin.settings.hires, true, "and back on again");

  cap.control("slider").fire(1920);
  await tick();
  assert.equal(plugin.settings.maxImageWidth, 1920, "the cap is recorded");
  cap.control("slider").fire(0);
  await tick();

  // "Restore defaults" must leave the behaviour switches alone: they are not
  // effects, and silently re-enabling 4K artwork would be a surprise.
  plugin.settings.hires = false;
  plugin.settings.maxImageWidth = 1920;
  const resetRow = rows(normalTab.containerEl).find((s) => s.name === "恢复默认效果");
  resetRow.control("button").click();
  await tick();
  await tick();
  assert.equal(plugin.settings.dim, 0.35, "reset still restores the effects");
  assert.equal(plugin.settings.hires, false, "reset leaves the behaviour switches alone");
  assert.equal(plugin.settings.maxImageWidth, 1920, "including the width cap");
  plugin.settings.hires = true;
  plugin.settings.maxImageWidth = 0;

  // --- migration from the 0.2.1 boolean switch --------------------------
  const on = new Plugin(app, { id: "wallvia" });
  on.loadData = async () => LEGACY;
  await on.onload();
  assert.equal(on.settings.glass, 55, "glassEditors:true migrates to Glass 55");
  assert.equal(on.settings.glassEditors, undefined, "the legacy key is dropped from data.json");

  const off = new Plugin(app, { id: "wallvia" });
  off.loadData = async () => ({ ...LEGACY, glassEditors: false });
  await off.onload();
  assert.equal(off.settings.glass, 0, "glassEditors:false migrates to Glass 0 (opaque surfaces)");

  const already = new Plugin(app, { id: "wallvia" });
  already.loadData = async () => ({ ...LEGACY, glass: 12 });
  await already.onload();
  assert.equal(already.settings.glass, 12, "an existing numeric glass level wins over the legacy key");

  proto.addSettingTab = realAddSettingTab;
  proto.saveData = realSaveData;

  console.log("OBSIDIAN SETTINGS TAB TEST PASSED");
  console.log("  preview + Fit/Dim/Glass/Blur/Opacity/Wash and the three behaviour");
  console.log("  switches rendered, Glass is a persisted 0-100 level, the wash follows");
  console.log("  or ignores the theme, and a failing preview no longer hides the controls.");
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("OBSIDIAN SETTINGS TAB FAILED:", e && e.message);
    process.exit(1);
  });
}
