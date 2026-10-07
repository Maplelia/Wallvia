// tests/we-video-frame.cjs — the video wallpaper frame cache.
//
// A video wallpaper ships no still at all (only Wallpaper Engine's square
// `preview.gif`), so the renderer decodes one frame with the host's own
// Chromium and hands the JPEG back to Node to store. This covers the Node half:
// which file counts as the video, and the cache key that has to follow the
// source's size and mtime so a re-subscribed workshop item re-decodes.
//
// The decode itself needs a real browser and is not covered here; `main.ts`'s
// `decodeVideoFrame` is exercised live instead, and the frame it produces is
// what these functions store and read back.
//
// Run standalone: node tests/we-video-frame.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Frames are cached in `<temp>/wallvia-stills` — the folder the VS Code extension
// writes to as well. A test must not drop its synthetic frames in there, so it
// points the cache at its own scratch folder instead.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-we-frames-"));
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

/** A JPEG carrying real dimensions and real payload — a frame the cache may keep. */
function jpeg(width, height, padding = 1024) {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.alloc(padding, 0x21),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * A header-only JPEG: SOI, SOF0 (claiming real dimensions), EOI — 23 bytes, which
 * is what a failed canvas encode produces. It parses perfectly, so only the size
 * guard can tell it apart from a real frame.
 */
function stub(width, height) {
  return jpeg(width, height, 0);
}

/**
 * Where the engine keeps one video's frame of one width: djb2 over
 * `path|size|mtime|width` inside the configured folder. The test needs the path
 * itself only to prove that a file planted there is dropped.
 */
function frameCachePath(video, width) {
  const stat = fs.statSync(video);
  const key = `${video}|${stat.size}|${Math.floor(stat.mtimeMs)}|${width}`;
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
  return path.join(SCRATCH, hash.toString(16) + ".jpg");
}

/** A throwaway Wallpaper Engine project folder. */
function project({ id, type, file, preview }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wallvia-${id}-`));
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ type, file, preview: preview || "preview.gif" })
  );
  if (file) fs.writeFileSync(path.join(dir, file), Buffer.from("not really a video"));
  return dir;
}

async function run() {
  const engine = loadEngine();
  const dirs = [];
  const make = (spec) => {
    const dir = project(spec);
    dirs.push(dir);
    return dir;
  };
  // How many frames the real cache held before this test touched anything.
  const productionDir = path.join(os.tmpdir(), "wallvia-stills");
  const productionBefore = fs.existsSync(productionDir) ? fs.readdirSync(productionDir).length : 0;

  try {
    // --- only a video project yields a video file -------------------------
    const videoDir = make({ id: "vid", type: "video", file: "clip.mp4" });
    const video = engine.videoFileOf({ id: "vid", type: "video", dir: videoDir, preview: "" });
    assert.equal(video, path.join(videoDir, "clip.mp4"), "the project's own mp4 is the video");

    const sceneDir = make({ id: "scene", type: "scene", file: "scene.json" });
    assert.equal(
      engine.videoFileOf({ id: "scene", type: "scene", dir: sceneDir, preview: "" }),
      null,
      "a scene's `file` is scene.json, so it is never mistaken for a video"
    );

    const brokenDir = make({ id: "gone", type: "video", file: "missing.mp4" });
    fs.rmSync(path.join(brokenDir, "missing.mp4"));
    assert.equal(
      engine.videoFileOf({ id: "gone", type: "video", dir: brokenDir, preview: "" }),
      null,
      "a video that is not on disk is not a source"
    );

    // --- a decoded frame round-trips through the cache --------------------
    assert.equal(await engine.readVideoFrame(video), null, "nothing cached yet");

    const frame = jpeg(960, 540);
    const stored = await engine.writeVideoFrame(video, frame.toString("base64"));
    assert.ok(stored, "the decoded frame is stored");
    assert.deepEqual(
      { w: stored.width, h: stored.height, ext: stored.ext },
      { w: 960, h: 540, ext: "jpg" },
      "the stored frame reports its own size, which is what the badge would use"
    );

    const read = await engine.readVideoFrame(video);
    assert.ok(read, "the second read comes from the cache");
    assert.equal(read.width, 960, "cached size is right");
    // The point of the scratch folder: a synthetic test frame must never land
    // next to the user's real ones.
    assert.ok(fs.readdirSync(SCRATCH).length > 0, "the frame was written to the scratch folder");
    const after = fs.existsSync(productionDir) ? fs.readdirSync(productionDir).length : 0;
    assert.equal(after, productionBefore, "nothing was added to the real frame cache");
    assert.deepEqual(
      Buffer.from(read.bytes),
      frame,
      "the cached bytes are returned verbatim, not re-encoded"
    );

    // --- the cache follows the file's identity, not just its path --------
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(videoDir, "clip.mp4"), later, later);
    assert.equal(
      await engine.readVideoFrame(video),
      null,
      "a re-subscribed or updated video gets a fresh key instead of the old frame"
    );

    // --- and a missing source is simply uncacheable ----------------------
    assert.equal(await engine.writeVideoFrame(video, ""), null, "an empty payload is not stored");
    assert.equal(
      await engine.writeVideoFrame(video, "!!!not base64!!!"),
      null,
      "a payload that is not an image is not stored"
    );

    // --- a header-only stub is refused, and a planted one is dropped -----
    // A failed canvas encode yields SOI + SOF0 + EOI (23 bytes). It parses as a
    // perfect 960x540 JPEG, so it once sat in this cache being served as a blank
    // "frame" — the size guard and the self-healing read are what stop that.
    assert.equal(
      await engine.writeVideoFrame(video, stub(960, 540).toString("base64")),
      null,
      "a header-only stub is not stored"
    );

    const keyed = await engine.readVideoFrame(video, 1920);
    assert.equal(keyed, null, "a width nothing was stored for is a miss");
    // Plant a stub where a real frame would live, then read it back.
    const frame2 = jpeg(1920, 1080);
    await engine.writeVideoFrame(video, frame2.toString("base64"), 1920);
    const cachedPath = frameCachePath(video, 1920);
    assert.ok(fs.existsSync(cachedPath), "the cached frame is on disk");
    fs.writeFileSync(cachedPath, stub(1920, 1080));
    assert.equal(
      await engine.readVideoFrame(video, 1920),
      null,
      "a truncated cache entry is never served"
    );
    assert.equal(fs.existsSync(cachedPath), false, "…and it is deleted so the next open re-decodes");

    console.log("WE VIDEO FRAME TEST PASSED");
    console.log("  only a video project yields a source, the frame round-trips");
    console.log("  through the cache, the key follows size+mtime, and a header-only");
    console.log("  stub is refused instead of being served as a blank frame.");
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "tests", ".tmp-engine.cjs"), { force: true });
  }
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("WE VIDEO FRAME FAILED: " + ((e && e.message) || e));
    process.exit(1);
  });
}
