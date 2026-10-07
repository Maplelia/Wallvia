// tests/run-all.cjs — run every test in this folder in one process.
//
// Run: node tests/run-all.cjs
(async () => {
  console.log("== json manifests ==");
  await require("./validate-json.cjs");
  console.log("\n== shared core ==");
  await import("./shared-core.mjs");
  console.log("\n== codex modules ==");
  await import("./codex-modules.mjs");
  // Those suites use node:test, which runs tests on its own once registered —
  // `await import()` would not wait for them. Run them in a child process with
  // the test runner so the exit code (and the output) is properly sequenced.
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const runNodeTest = (file) => {
    console.log(`\n== ${file} (node:test) ==`);
    const r = spawnSync(process.execPath, ["--test", path.join(__dirname, file)], { stdio: "inherit" });
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
  console.log("\n== mp4 video track size ==");
  await require("./mp4-size.cjs")();
  console.log("\n== wallpaper engine folder still ==");
  await require("./we-folder-still.cjs")();
  console.log("\n== wallpaper engine video frame ==");
  await require("./we-video-frame.cjs")();
  console.log("\n== wallpaper engine level cap ==");
  await require("./we-level-cap.cjs")();
  console.log("\n== obsidian stylesheet invariants ==");
  await require("./obsidian-styles.cjs")();
  console.log("\n== obsidian settings tab ==");
  await require("./obsidian-settings-tab.cjs")();
  console.log("\n== obsidian in-app panel ==");
  await require("./obsidian-panel.cjs")();
  console.log("\n== vscode extension ==");
  await require("./vscode-smoke.cjs")();
  console.log("\n== vscode video frame cache ==");
  await require("./vscode-video-frame.cjs")();
  console.log("\n== vscode video decode (real Chromium) ==");
  await require("./vscode-video-decode.cjs")();
  console.log("\n== vscode CSS weights (real VS Code stylesheet) ==");
  await require("./vscode-css-weight.cjs").run();
  console.log("\n== cdp live (real Chromium) ==");
  await import("./cdp-live.mjs");
  console.log("\nALL TESTS PASSED");
})().catch((e) => {
  console.error("\nTEST RUN FAILED:", e && e.message);
  process.exit(1);
});
