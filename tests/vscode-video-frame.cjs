// tests/vscode-video-frame.cjs — the VS Code side of video wallpaper frames.
//
// Ported from `tests/we-video-frame.cjs` (the Obsidian half), because the two
// platforms deliberately share both the cache *key* (`path|size|mtime|width`)
// and the cache *folder* (`<temp>/wallvia-stills`), so whichever app decoded a
// width first, the other reuses it. What differs is who decodes: Obsidian decodes
// in-process, VS Code asks the picker's webview (that half needs a real browser
// and is covered by the live check in `vscode-smoke.cjs`).
//
// Run standalone: node tests/vscode-video-frame.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Every test that decodes a frame points the cache at its own scratch folder:
// the production folder is `<temp>/wallvia-stills`, and a synthetic test frame
// landing there is how 23-byte stubs once ended up in the real cache.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-vscode-frames-"));
process.env.WALLVIA_STILLS_DIR = SCRATCH;

const frame = require(path.join(ROOT, "vscode", "src", "video-frame.js"));
const mp4 = require(path.join(ROOT, "vscode", "src", "mp4.js"));

/** A JPEG header carrying real dimensions plus enough payload to look real. */
function jpeg(width, height, padding = 512) {
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
 * A `box := size(4) type(4) payload` builder, plus a structurally real `tkhd`
 * — copied from `tests/mp4-size.cjs`, which pins that exact layout.
 */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

function matrixAndSize(width, height) {
  const fixed = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n * 65536, 0);
    return b;
  };
  return Buffer.concat([Buffer.alloc(36), fixed(width), fixed(height)]);
}

/** A structurally real `tkhd` (92 bytes, version 0). */
function tkhd(width, height) {
  const fixedPart = 4 + 4 + 4 + 4 + 4 + 8;
  const payload = Buffer.alloc(4 + fixedPart + 2 + 2 + 2 + 2 + 36 + 8);
  payload.writeUInt8(0, 0);
  return box(
    "tkhd",
    Buffer.concat([payload.subarray(0, 4 + fixedPart + 8), matrixAndSize(width, height)])
  );
}

/** `moov` holding an audio track (zero size) and one video track. */
function mp4File(file, width, height) {
  const moov = box("moov", Buffer.concat([box("trak", tkhd(0, 0)), box("trak", tkhd(width, height))]));
  fs.writeFileSync(file, Buffer.concat([box("ftyp", Buffer.alloc(24)), moov]));
}

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-vscode-frame-"));
  const clips = [];
  const clip = (name, bytes = 4096) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.alloc(bytes, 0x7a));
    clips.push(file);
    return file;
  };

  try {
    // --- width policy, mirrored from the Obsidian side ---------------------
    assert.equal(frame.frameWidthForCard(0), 960, "the card frame is 960 wide by default");
    assert.equal(frame.frameWidthForCard(480), 480, "a smaller user cap lowers the card frame");
    assert.equal(frame.frameWidthForCard(2560), 2560, "a larger user cap raises the card frame");
    assert.equal(frame.frameWidthForApply(0, 1920), 1920, "the wallpaper frame is the video's own width");
    assert.equal(frame.frameWidthForApply(0, 7680), 2560, "…bounded by the apply maximum");
    assert.equal(frame.frameWidthForApply(1280, 1920), 1280, "an explicit cap wins for the wallpaper");
    assert.equal(frame.frameWidthForApply(0, 0), 2560, "an unreadable container falls back to the maximum");

    // --- a decoded frame round-trips through the cache ---------------------
    const video = clip("clip.mp4");
    assert.equal(frame.readVideoFrame(video, 960), null, "nothing cached yet");

    const bytes = jpeg(960, 540);
    const stored = frame.writeVideoFrame(video, bytes.toString("base64"), 960);
    assert.ok(stored, "the decoded frame is stored");
    assert.deepEqual(
      { w: stored.width, h: stored.height, ext: stored.ext },
      { w: 960, h: 540, ext: "jpg" },
      "the stored frame reports its own size"
    );
    assert.equal(
      path.dirname(stored.file),
      SCRATCH,
      "frames land in the configured scratch folder, never the production one"
    );
    const production = path.join(os.tmpdir(), frame.STILLS_DIR);
    assert.notEqual(path.resolve(SCRATCH), path.resolve(production), "the scratch folder is not the real cache");
    assert.ok(!fs.existsSync(path.join(production, path.basename(stored.file))), "and nothing was written there");

    const read = frame.readVideoFrame(video, 960);
    assert.ok(read, "the second read comes from the cache");
    assert.deepEqual(read.bytes, bytes, "the cached bytes come back verbatim, not re-encoded");

    // --- the width is part of the key, so a card frame never downgrades the
    //     wallpaper frame (and vice versa) ---------------------------------
    assert.equal(frame.readVideoFrame(video, 1920), null, "a different width is a different entry");
    const wide = jpeg(1920, 1080);
    frame.writeVideoFrame(video, wide.toString("base64"), 1920);
    assert.equal(frame.readVideoFrame(video, 1920).width, 1920, "both widths coexist");
    assert.equal(frame.readVideoFrame(video, 960).width, 960, "…and neither overwrote the other");

    // --- the key follows the file's identity, not just its path ------------
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(video, later, later);
    assert.equal(frame.readVideoFrame(video, 960), null, "an updated video gets a fresh key instead of the old frame");

    // --- bad payloads are refused rather than cached -----------------------
    assert.equal(frame.writeVideoFrame(video, "", 960), null, "an empty payload is not stored");
    assert.equal(frame.writeVideoFrame(video, "!!!not base64!!!", 960), null, "a non-image payload is not stored");
    // A header-only JPEG is what a failed canvas encode produces: it parses,
    // which is exactly why it must be rejected on size instead.
    const stub = jpeg(960, 540, 0);
    assert.equal(frame.writeVideoFrame(video, stub.toString("base64"), 960), null, "a header-only stub is not stored");

    // --- a truncated file left on disk is dropped, not served --------------
    fs.utimesSync(video, new Date(), new Date());
    const file = frame.frameCacheFile(video, 960);
    fs.writeFileSync(file, stub);
    assert.equal(frame.readVideoFrame(video, 960), null, "a truncated cache file is not served");
    assert.equal(fs.existsSync(file), false, "…and it is deleted so the next open re-decodes");

    // --- the container's own resolution is readable ------------------------
    const mp4Path = path.join(dir, "sized.mp4");
    mp4File(mp4Path, 1920, 1080);
    assert.deepEqual(mp4.readVideoSize(mp4Path), { width: 1920, height: 1080 }, "tkhd gives the video's size");
    assert.equal(mp4.readVideoSize(path.join(dir, "missing.mp4")), null, "a missing file is not a size");
    assert.equal(mp4.readVideoSize(video), null, "a file that is not a container has no size");

    console.log("VSCODE VIDEO FRAME TEST PASSED");
    console.log("  960 px card frames (raised by maxImageWidth) and native-width");
    console.log("  wallpaper frames coexist in the shared temp cache, bad payloads are");
    console.log("  refused, truncated cache files are dropped, the container's own");
    console.log("  resolution is read from tkhd, and the cache stays out of the real one.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

module.exports = run;
if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error("VSCODE VIDEO FRAME FAILED:", (e && e.message) || e);
    process.exit(1);
  }
}
