// tests/we-level-cap.cjs — "maximum source width" picks a mipmap level.
//
// The setting must never resample: it only chooses which level of the chain is
// copied out of `scene.pkg`, so the bytes stay exactly what Wallpaper Engine
// shipped. It also has to reach every consumer — the card thumbnail, the
// background artwork and a decoded video frame — and the cache keys must
// include it, or a cap of 1920 and a cap of 0 would read each other's copy.
//
// Run standalone: node tests/we-level-cap.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");

// The video-frame half of this test writes into the frame cache; point it at a
// scratch folder so it can never land next to the user's real frames.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-level-cap-"));
process.env.WALLVIA_STILLS_DIR = SCRATCH;

function loadEngine() {
  const esbuild = require("esbuild");
  const file = path.join(ROOT, "tests", ".tmp-engine.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, "obsidian", "wallpaper-engine.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { obsidian: path.join(ROOT, "tests", "mocks", "obsidian", "index.js") },
    outfile: file,
    logLevel: "error",
  });
  return require(file);
}

const { makePng, makePkg, makeTex } = require("./png-pkg-fixture.cjs");

/** A scene package whose texture carries a 3840/1920/960/480 mipmap chain. */
function sceneWithChain(dir) {
  const levels = [
    makePng(3840, 2160),
    makePng(1920, 1080),
    makePng(960, 540),
    makePng(480, 270),
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ type: "scene", file: "scene.json", preview: "preview.jpg" })
  );
  fs.writeFileSync(path.join(dir, "preview.jpg"), makePng(801, 801));
  fs.writeFileSync(
    path.join(dir, "scene.pkg"),
    makePkg([{ name: "art.tex", data: makeTex(levels[0], levels.slice(1)) }])
  );
  return dir;
}

async function run() {
  const engine = loadEngine();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-cap-"));
  const scene = sceneWithChain(path.join(root, "scene"));

  try {
    // --- the background honours the cap, level by level -------------------
    const sharpest = await engine.readSceneHiResImage(scene, 0);
    assert.equal(sharpest.width, 3840, "cap 0 takes the sharpest level");

    const capped = await engine.readSceneHiResImage(scene, 1920);
    assert.equal(
      capped.width,
      1920,
      "cap 1920 takes the smallest level that still covers it, not the 3840 one"
    );
    assert.equal(capped.height, 1080, "the level's own height comes with it");

    const small = await engine.readSceneHiResImage(scene, 500);
    assert.equal(small.width, 960, "cap 500 skips the 480 level, which is too small");

    const huge = await engine.readSceneHiResImage(scene, 7680);
    assert.equal(huge.width, 3840, "a cap larger than the chain falls back to the biggest level");

    // Bytes are copied, never re-encoded.
    assert.deepEqual(
      Buffer.from(capped.bytes),
      makePng(1920, 1080),
      "the chosen level is copied verbatim"
    );

    // --- the card thumbnail respects it too -------------------------------
    const still4k = await engine.resolveStillAssets(scene, 0);
    assert.ok(still4k.still.width <= 960, "the card gets a small level, never the 4K one");
    assert.deepEqual(
      still4k.max,
      { width: 3840, height: 2160 },
      "the resolution pill still reports the artwork's real size"
    );

    const stillSmall = await engine.resolveStillAssets(scene, 160);
    assert.ok(
      stillSmall.still.width <= 160 || stillSmall.still.width === 480,
      "a cap below the smallest level still returns something"
    );

    // --- cache entries do not cross between caps --------------------------
    const a = await engine.resolveStillAssets(scene, 0);
    const b = await engine.resolveStillAssets(scene, 1920);
    assert.notEqual(a, b, "cap 0 and cap 1920 resolve through separate cache entries");

    // --- and the video frame cache keys on the width ----------------------
    const video = path.join(root, "clip.mp4");
    fs.writeFileSync(video, Buffer.from("not really a video"));
    const frame = (() => {
      const sof = Buffer.alloc(19);
      sof.writeUInt16BE(0xffc0, 0);
      sof.writeUInt16BE(17, 2);
      sof[4] = 8;
      sof.writeUInt16BE(540, 5);
      sof.writeUInt16BE(960, 7);
      sof[9] = 3;
      // Real payload behind the header: a frame with only a header (23 bytes) is
      // refused by the size guard, because it renders as nothing.
      return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        sof,
        Buffer.alloc(1024, 0x21),
        Buffer.from([0xff, 0xd9]),
      ]);
    })();

    await engine.writeVideoFrame(video, frame.toString("base64"), 0);
    assert.ok(await engine.readVideoFrame(video, 0), "the uncapped frame is cached");
    assert.equal(
      await engine.readVideoFrame(video, 1920),
      null,
      "a different cap must not read the uncapped frame"
    );

    console.log("WE LEVEL CAP TEST PASSED");
    console.log("  the cap selects a mipmap level (never resamples), reaches the card");
    console.log("  and the background, and is part of both cache keys.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "tests", ".tmp-engine.cjs"), { force: true });
  }
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("WE LEVEL CAP FAILED: " + ((e && e.message) || e));
    process.exit(1);
  });
}
