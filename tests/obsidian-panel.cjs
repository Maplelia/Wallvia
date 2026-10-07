// tests/obsidian-panel.cjs — the in-app panel (dsh-web-all parity).
//
// The DSH `dsh-web-all` wallpaper plugin is driven from a floating picture
// button that opens a panel holding the image preview and the effect controls.
// This suite asserts the Obsidian port has the same entry points and the same
// control set, that the controls actually move the wallpaper, and that nothing
// is left behind when the plugin unloads.
//
// Run standalone: node tests/obsidian-panel.cjs
const { install } = require("./mock-loader.cjs");
install();

const assert = require("node:assert");
const { installDom, oneByClass, byClass } = require("./mocks/obsidian/dom.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Setting rows rendered into a container, in order. */
function rows(container) {
  return container.children.map((c) => c.__setting).filter(Boolean);
}

function buttonTexts(container) {
  return byClass(container, "wallvia-btn").map((b) => b.textContent);
}

const SAVED = {
  image: "Wallpapers/a.png",
  opacity: 0.6,
  dim: 0.35,
  blur: 10,
  glass: 55,
  fit: "cover",
  enabled: true,
  weCacheDir: "Wallpapers",
};

const PANEL_ROWS = [
  "启用 Enabled",
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
  // The Wallpaper Engine entries are desktop-only; this suite asserts they are
  // offered, so opt in explicitly (suites run in one process).
  obsidian.Platform.isDesktop = true;
  const mod = require("../main.js");
  const Plugin = mod && mod.default ? mod.default : mod;
  const proto = Plugin.prototype;

  // Capture the entry points onload() registers.
  const commands = [];
  const ribbons = [];
  const realAddCommand = proto.addCommand;
  const realAddRibbonIcon = proto.addRibbonIcon;
  proto.addCommand = function (command) {
    commands.push(command);
    return command;
  };
  proto.addRibbonIcon = function (icon, title, onClick) {
    ribbons.push({ icon, title, onClick });
    return {};
  };
  let saves = 0;
  const realSaveData = proto.saveData;
  proto.saveData = async function (data) {
    saves++;
    return realSaveData.call(this, data);
  };

  const app = {
    workspace: { on: () => ({}), onLayoutReady: (cb) => cb(), containerEl: {} },
    vault: {
      getFiles: () => [{ path: "Wallpapers/a.png" }],
      on: () => ({}),
      getAbstractFileByPath: () => null,
      getResourcePath: () => "app://vault/Wallpapers/a.png",
      adapter: {
        stat: async () => ({ type: "file", mtime: 7 }),
        getResourcePath: (p) => "app://vault/" + p,
      },
    },
  };

  const plugin = new Plugin(app, { id: "wallvia" });
  plugin.loadData = async () => ({ ...SAVED });

  // Capture the settings tab too: the two surfaces share LABELS/DESCS, and the
  // "same text on both" promise is only worth anything if something checks it.
  let tab = null;
  const realAddSettingTab = proto.addSettingTab;
  proto.addSettingTab = function (instance) {
    tab = instance;
    return realAddSettingTab.call(this, instance);
  };

  await plugin.onload();
  await plugin.apply();

  // --- entry points -----------------------------------------------------
  const openCommand = commands.find((c) => c.id === "open-panel");
  assert.ok(openCommand, "onload() registers an 'open-panel' command");
  assert.equal(ribbons.length, 1, "onload() registers exactly one ribbon icon");
  assert.equal(ribbons[0].icon, "image", "the ribbon icon is the picture icon");
  assert.equal(oneByClass(body, "wallvia-fab"), null, "nothing is built before the first open");

  openCommand.callback();
  let fab = oneByClass(body, "wallvia-fab");
  let panel = oneByClass(body, "wallvia-panel");
  assert.ok(fab, "opening creates the floating picture button");
  assert.ok(panel, "opening creates the panel");
  assert.ok(!panel.classList.contains("wallvia-hidden"), "the panel is visible after opening");

  // --- preview ----------------------------------------------------------
  let preview = oneByClass(panel, "wallvia-panel-preview");
  assert.ok(preview, "the panel renders an image preview");
  assert.ok(
    String(preview.style.backgroundImage).includes("app://vault/Wallpapers/a.png"),
    "the preview points at the current image — got: " + preview.style.backgroundImage
  );
  // The preview shows the whole image, so no inline background-size may
  // override the `contain` that styles.css pins (obsidian-styles.cjs asserts
  // that rule). `cover` here used to crop a wide wallpaper to a centre strip.
  assert.equal(
    String(preview.style.backgroundSize || ""),
    "",
    "the preview leaves background-size to the stylesheet (contain)"
  );

  // --- the dsh-web-all control set --------------------------------------
  let names = rows(panel).map((s) => s.name);
  for (const want of PANEL_ROWS) {
    assert.ok(
      names.some((n) => n.startsWith(want)),
      `panel has the "${want}" control — rendered: ${names.join(" | ")}`
    );
  }
  let labels = buttonTexts(panel);
  assert.ok(labels.some((t) => t.includes("更换图片")), "panel offers replacing the image");
  assert.ok(
    labels.some((t) => t.includes("Wallpaper Engine")),
    "panel offers the Wallpaper Engine picker"
  );
  assert.ok(labels.includes("移除"), "panel offers removing the wallpaper");

  // --- Glass drives the surfaces ---------------------------------------
  let glass = rows(panel)
    .find((s) => s.name.startsWith("通透 Glass"))
    .control("slider");
  assert.deepEqual(glass.limits, { min: 0, max: 100, step: 1 }, "Glass is a 0-100 slider");
  assert.equal(glass.value, 55, "Glass defaults to 55 like the VS Code port");

  glass.fire(0);
  await tick();
  await tick();
  assert.equal(plugin.settings.glass, 0, "moving Glass updates the setting");
  assert.equal(body.style.getPropertyValue("--wallvia-glass"), "100.0%", "Glass 0 = opaque panes");
  assert.ok(!body.classList.contains("wallvia-glass"), "Glass 0 switches the glass class off");
  assert.ok(saves > 0, "moving Glass persists data.json");

  glass.fire(100);
  await tick();
  await tick();
  assert.equal(body.style.getPropertyValue("--wallvia-glass"), "35.0%", "Glass 100 = 35% floor");
  assert.ok(body.classList.contains("wallvia-glass"), "Glass above 0 switches the glass class on");

  // --- the embedded-web-view slider drives the frame's opacity ----------
  // A plugin can embed a whole web app (opencode serves one on 127.0.0.1 and
  // iframes it). That document is cross-origin, so fading the frame itself is
  // the only lever; 0 must leave it exactly as the plugin drew it.
  const embedRow = rows(panel).find((s) => s.name.startsWith("嵌入面板透明度"));
  assert.ok(embedRow, "panel offers the embedded-panel transparency slider");
  const embed = embedRow.control("slider");
  assert.deepEqual(embed.limits, { min: 0, max: 100, step: 1 }, "embedded transparency is 0-100");
  assert.equal(embed.value, 0, "it defaults to 0 — the plugin's frame is left alone");
  assert.equal(
    body.style.getPropertyValue("--wallvia-embed-opacity"),
    "1.00",
    "0 writes opacity 1 (no change to the embedded page)"
  );

  embed.fire(100);
  await tick();
  await tick();
  assert.equal(plugin.settings.embed, 100, "moving the slider updates the setting");
  assert.equal(
    body.style.getPropertyValue("--wallvia-embed-opacity"),
    "0.35",
    "100 writes the 0.35 floor (the frame is faded, not erased)"
  );
  assert.ok(saves > 0, "moving it persists data.json");

  // --- Dim / Blur / Opacity are wired too ------------------------------
  panel = oneByClass(body, "wallvia-panel");
  const dimRow = rows(panel).find((s) => s.name.startsWith("压暗 Dim"));
  const blurRow = rows(panel).find((s) => s.name.startsWith("模糊 Blur"));
  const opacityRow = rows(panel).find((s) => s.name.startsWith("图片不透明度"));
  dimRow.control("slider").fire(0.5);
  blurRow.control("slider").fire(22);
  opacityRow.control("slider").fire(0.25);
  await tick();
  await tick();
  assert.equal(body.style.getPropertyValue("--wallvia-dim"), "0.5", "Dim slider reaches the layer");
  assert.equal(body.style.getPropertyValue("--wallvia-blur"), "22px", "Blur slider reaches the layer");
  assert.equal(body.style.getPropertyValue("--wallvia-opacity"), "0.25", "Opacity slider reaches the layer");

  // --- Enabled toggle ---------------------------------------------------
  rows(panel)
    .find((s) => s.name.startsWith("启用 Enabled"))
    .control("toggle")
    .fire(false);
  await tick();
  await tick();
  assert.ok(!body.classList.contains("wallvia-enabled"), "disabling removes the wallpaper layer");

  // --- the remove button clears the image -------------------------------
  panel = oneByClass(body, "wallvia-panel");
  byClass(panel, "wallvia-btn")
    .find((b) => b.textContent === "移除")
    .dispatch("click");
  await tick();
  await tick();
  assert.equal(plugin.settings.image, "", "移除 clears the stored image");
  panel = oneByClass(body, "wallvia-panel");
  assert.ok(
    oneByClass(panel, "wallvia-panel-preview-empty"),
    "with no image the panel shows the empty preview state"
  );

  // --- drag: remembers the position; a plain click toggles --------------
  fab = oneByClass(body, "wallvia-fab");
  fab.dispatch("pointerdown", { clientX: 0, clientY: 0, pointerId: 1, preventDefault() {} });
  fab.dispatch("pointermove", { clientX: 120, clientY: 60, pointerId: 1 });
  fab.dispatch("pointerup", { pointerId: 1 });
  await tick();
  await tick();
  assert.equal(plugin.settings.fabLeft, 120, "dragging remembers the button x position");
  assert.equal(plugin.settings.fabTop, 60, "dragging remembers the button y position");

  const beforeClick = oneByClass(body, "wallvia-panel").classList.contains("wallvia-hidden");
  fab.dispatch("pointerdown", { clientX: 5, clientY: 5, pointerId: 2, preventDefault() {} });
  fab.dispatch("pointerup", { pointerId: 2 });
  await tick();
  assert.equal(
    oneByClass(body, "wallvia-panel").classList.contains("wallvia-hidden"),
    !beforeClick,
    "a click without movement toggles the panel"
  );

  // --- the ribbon icon is the same entry point --------------------------
  panel = oneByClass(body, "wallvia-panel");
  if (!panel.classList.contains("wallvia-hidden")) {
    ribbons[0].onClick();
    await tick();
  }
  ribbons[0].onClick();
  assert.ok(
    !oneByClass(body, "wallvia-panel").classList.contains("wallvia-hidden"),
    "the ribbon icon opens the same panel"
  );

  // --- D2: both surfaces explain a control with the same sentence --------
  // The panel used to carry its own abbreviated copy of every description and
  // drifted away from the settings page. They now read one shared table.
  assert.ok(tab, "onload() registers the settings tab");
  // Render without the Wallpaper Engine section: this suite has no business
  // scanning the real install just to compare two labels.
  obsidian.Platform.isDesktop = false;
  tab.display();
  obsidian.Platform.isDesktop = true;
  const SHARED = [
    "启用 Enabled",
    "对齐方式 Fit",
    "压暗 Dim",
    "通透 Glass",
    "嵌入面板透明度",
    "模糊 Blur",
    "图片不透明度",
  ];
  const panelPanel = oneByClass(body, "wallvia-panel");
  for (const name of SHARED) {
    const panelDesc = rows(panelPanel).find((s) => s.name.startsWith(name))?.desc;
    const tabDesc = rows(tab.containerEl).find((s) => s.name.startsWith(name))?.desc;
    assert.ok(panelDesc, `the panel describes "${name}"`);
    assert.equal(panelDesc, tabDesc, `"${name}" is described identically on both surfaces`);
  }

  // --- D1: reset restores the effects, never the wallpaper ---------------
  plugin.settings.image = "Wallpapers/keep.png";
  plugin.settings.dim = 0.9;
  plugin.settings.glass = 3;
  plugin.settings.blur = 30;
  plugin.settings.opacity = 0.15;
  plugin.settings.embed = 80;
  plugin.settings.weCacheDir = "Custom";
  await plugin.apply();

  const resetButton = byClass(oneByClass(body, "wallvia-panel"), "wallvia-btn").find(
    (b) => b.textContent === "恢复默认效果"
  );
  assert.ok(resetButton, "the panel offers the reset button");
  resetButton.dispatch("click");
  await tick();
  await tick();
  assert.equal(plugin.settings.dim, 0.35, "reset puts Dim back to its default");
  assert.equal(plugin.settings.glass, 55, "reset puts Glass back to its default");
  assert.equal(plugin.settings.blur, 10, "reset puts Blur back to its default");
  assert.equal(plugin.settings.opacity, 0.6, "reset puts Opacity back to its default");
  assert.equal(plugin.settings.embed, 0, "reset puts the embed transparency back to its default");
  assert.equal(plugin.settings.image, "Wallpapers/keep.png", "reset keeps the current wallpaper");
  assert.equal(plugin.settings.weCacheDir, "Custom", "reset keeps the cache folder");

  // The settings page offers the same reset.
  const tabReset = rows(tab.containerEl).find((s) => s.name === "恢复默认效果");
  assert.ok(tabReset, "the settings page offers the reset button");
  assert.equal(tabReset.control("button").text, "恢复默认", "its button is labelled 恢复默认");

  // --- unload leaves no orphan button -----------------------------------
  plugin.onunload();
  assert.equal(oneByClass(body, "wallvia-fab"), null, "unload removes the floating button");
  assert.equal(oneByClass(body, "wallvia-panel"), null, "unload removes the panel");

  proto.addCommand = realAddCommand;
  proto.addRibbonIcon = realAddRibbonIcon;
  proto.saveData = realSaveData;
  proto.addSettingTab = realAddSettingTab;

  console.log("OBSIDIAN PANEL TEST PASSED");
  console.log("  floating button + panel, image preview, the dsh-web-all control set,");
  console.log("  live apply/persist, drag with remembered position, clean unload,");
  console.log("  the reset button on both surfaces, and one shared description table.");
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("OBSIDIAN PANEL FAILED:", e && e.message);
    process.exit(1);
  });
}
