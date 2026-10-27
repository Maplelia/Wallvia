// tests/run-all-ci.cjs — the subset of the suite that a bare CI runner can run.
//
// Why a separate entry point instead of a flag on run-all.cjs: the excluded
// files need a *machine*, not a flag. They read a real VS Code install
// (vscode-css-weight), a real Wallpaper Engine library (vscode-smoke's picker
// half, we-*), or a real browser (cdp-live, vscode-video-decode). On a runner
// without them the failures are about the environment, and a red badge that
// means "this box has no Wallpaper Engine" trains people to ignore CI.
//
// Everything here is deterministic on a clean windows-latest:
//   - manifest / artifact consistency (needs `npm install`, which CI does)
//   - the shared core, the Obsidian plugin and its stylesheet invariants
//   - pure byte parsers (mp4, scene.pkg) and the frame-cache logic that does not
//     require a decodable source
//   - the VS Code patch/atomic-write/video-layer modules, driven through mocks
//
// Run: node tests/run-all-ci.cjs
(async () => {
  console.log("== json manifests ==");
  await require("./validate-json.cjs");
  console.log("\n== committed artifacts vs sources ==");
  await require("./artifact-consistency.cjs")();
  console.log("\n== shared core ==");
  await import("./shared-core.mjs");
  console.log("\n== codex modules ==");
  await import("./codex-modules.mjs");

  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const runNodeTest = (file) => {
    console.log(`\n== ${file} (node:test) ==`);
    const r = spawnSync(process.execPath, ["--test", path.join(__dirname, file)], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(file + " failed");
  };
  runNodeTest("codex-wallpaper-list.mjs");
  runNodeTest("codex-cli-follow.mjs");

  console.log("\n== obsidian plugin ==");
  await require("./obsidian-smoke.cjs")();
  console.log("\n== obsidian wallpaper-engine picker ==");
  await require("./obsidian-we-picker.cjs")();
  console.log("\n== obsidian scene.pkg artwork ==");
  await require("./obsidian-scene-pkg.cjs")();
  console.log("\n== obsidian stylesheet invariants ==");
  await require("./obsidian-styles.cjs")();
  console.log("\n== obsidian settings tab ==");
  await require("./obsidian-settings-tab.cjs")();
  console.log("\n== obsidian declarative settings (1.13+) ==");
  await require("./obsidian-settings-declarative.cjs")();
  console.log("\n== obsidian in-app panel ==");
  await require("./obsidian-panel.cjs")();
  console.log("\n== obsidian video wallpaper ==");
  await require("./obsidian-video.cjs")();

  console.log("\n== vscode atomic writes ==");
  await require("./vscode-atomic-write.cjs")();
  console.log("\n== vscode video wallpaper ==");
  await require("./vscode-video.cjs")();

  console.log("\n== mp4 video track size ==");
  await require("./mp4-size.cjs")();
  console.log("\n== wallpaper engine video frame ==");
  await require("./we-video-frame.cjs")();
  console.log("\n== wallpaper engine level cap ==");
  await require("./we-level-cap.cjs")();
  console.log("\n== master switch (both platforms) ==");
  await require("./master-switch.cjs")();

  console.log("\nALL CI TESTS PASSED");
})().catch((e) => {
  console.error("\nCI TEST RUN FAILED:", e && e.message);
  process.exit(1);
});
