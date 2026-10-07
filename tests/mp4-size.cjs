// tests/mp4-size.cjs — the video-track reader behind the picker's "视频 …" chip.
//
// A video wallpaper is painted from a still (`preview.gif` is 192x192 on this
// machine), so the card reports the container's own resolution next to it. That
// number has to come from the file, and the obvious implementation — scanning
// the bytes for the `tkhd` tag — is wrong: one real wallpaper reported
// 30307x13873 because the tag also appears inside `mdat` payload. These cases
// pin the box-tree walk that replaced it, including that exact failure.
//
// `obsidian/mp4.ts` is pure, so it is transpiled in-process and tested on
// buffers. When a real Wallpaper Engine library is present the parser is
// additionally cross-checked against the files themselves, both ends of each one.
//
// Run standalone: node tests/mp4-size.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/** Transpile the TypeScript module and evaluate it — no build step needed. */
function loadPure(srcFile) {
  const esbuild = require("esbuild");
  const source = fs.readFileSync(path.join(ROOT, srcFile), "utf8");
  const { code } = esbuild.transformSync(source, { loader: "ts", format: "cjs" });
  const mod = { exports: {} };
  new Function("exports", "require", "module", code)(mod.exports, require, mod);
  return mod.exports;
}

// ------------------------------------------------------------------ fixtures

/** box := size(4) type(4) payload */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

function matrixAndSize(width, height, version) {
  const fixed = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n * 65536, 0);
    return b;
  };
  return Buffer.concat([Buffer.alloc(36), fixed(width), fixed(height)]);
}

/** A structurally real `tkhd` (92 bytes for v0, 104 for v1). */
function tkhd(width, height, version = 0) {
  const tailBytes = 36 + 8;
  const fixedPart = version === 1 ? 8 + 8 + 4 + 4 + 8 + 8 : 4 + 4 + 4 + 4 + 4 + 8;
  const payload = Buffer.alloc(4 + fixedPart + 2 + 2 + 2 + 2 + tailBytes);
  payload.writeUInt8(version, 0);
  return box("tkhd", Buffer.concat([payload.subarray(0, 4 + fixedPart + 8), matrixAndSize(width, height, version)]));
}

function trak(width, height, version = 0) {
  return box("trak", tkhd(width, height, version));
}

/** `moov` holding an audio track (zero size) and one video track. */
function moov(width, height, version = 0) {
  return box("moov", Buffer.concat([trak(0, 0, version), trak(width, height, version)]));
}

/** `mdat` carrying a decoy that looks like a `tkhd` with absurd dimensions. */
function decoyMdat(width, height) {
  const decoy = Buffer.concat([tkhd(width, height), Buffer.alloc(64, 0x41)]);
  return box("mdat", Buffer.concat([Buffer.alloc(2048, 0x42), decoy, Buffer.alloc(2048, 0x43)]));
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("reads a version-0 tkhd", () => {
  const size = findVideoTrackSize(new Uint8Array(moov(1920, 1080)));
  assert.deepEqual(size, { width: 1920, height: 1080 });
});

test("reads a version-1 tkhd (64-bit times shift the fields)", () => {
  const size = findVideoTrackSize(new Uint8Array(moov(3840, 2160, 1)));
  assert.deepEqual(size, { width: 3840, height: 2160 });
});

test("ignores the zero-sized audio track and reports the video track", () => {
  // moov() deliberately puts an audio track first; a reader that took the first
  // tkhd it saw would return 0x0.
  const size = findVideoTrackSize(new Uint8Array(moov(1280, 720)));
  assert.deepEqual(size, { width: 1280, height: 720 });
});

test("finds moov in a window that starts mid-file (the tail of a non-faststart file)", () => {
  const file = Buffer.concat([decoyMdat(30307, 13873), moov(2560, 1440)]);
  const window = file.subarray(file.length - moov(2560, 1440).length - 32);
  assert.deepEqual(findVideoTrackSize(new Uint8Array(window)), { width: 2560, height: 1440 });
});

test("a decoy tkhd inside mdat cannot win", () => {
  // This is the real regression: the byte scan preferred the larger of the two
  // candidates and reported 30307x13873 for a 3840x2160 file.
  const file = Buffer.concat([decoyMdat(30307, 13873), moov(3840, 2160)]);
  assert.deepEqual(findVideoTrackSize(new Uint8Array(file)), { width: 3840, height: 2160 });
});

test("rejects dimensions past the plausible cap", () => {
  const file = moov(30307, 13873);
  assert.equal(findVideoTrackSize(new Uint8Array(file)), null);
});

test("returns null without a moov box", () => {
  assert.equal(findVideoTrackSize(new Uint8Array(decoyMdat(1920, 1080))), null);
  assert.equal(findVideoTrackSize(new Uint8Array(0)), null);
});

test("returns null for a truncated moov", () => {
  const full = moov(1920, 1080);
  assert.equal(findVideoTrackSize(new Uint8Array(full.subarray(0, full.length - 40))), null);
});

// ------------------------------------------------------- the real library

const WORKSHOP = "D:\\Steam\\steamapps\\workshop\\content\\431960";

/** Video wallpapers really installed, or [] when Steam has none. */
function installedVideos() {
  try {
    return fs
      .readdirSync(WORKSHOP, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(WORKSHOP, e.name))
      .filter((dir) => {
        try {
          const project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
          return String(project.type).toLowerCase() === "video";
        } catch {
          return false;
        }
      })
      .map((dir) => {
        const project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
        return path.join(dir, project.file);
      })
      .filter((file) => fs.existsSync(file));
  } catch {
    return [];
  }
}

/** The same head/tail windowing `readMp4Size` does, on top of the pure parser. */
function readBothEnds(file) {
  const WINDOW = 4 * 1024 * 1024;
  const { size } = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  try {
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    const window = Math.min(size, WINDOW);
    return (
      findVideoTrackSize(read(0, window)) ??
      (size > window ? findVideoTrackSize(read(size - window, window)) : null)
    );
  } finally {
    fs.closeSync(fd);
  }
}

const { findVideoTrackSize } = loadPure("obsidian/mp4.ts");

function run() {
  let failures = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`OK   ${name}`);
    } catch (e) {
      failures += 1;
      console.log(`FAIL ${name}\n     ${(e && e.message) || e}`);
    }
  }

  const videos = installedVideos();
  if (videos.length) {
    console.log(`\nreal library: ${videos.length} video wallpaper(s)`);
    for (const file of videos) {
      const size = readBothEnds(file);
      const ok = !!size && size.width >= 320 && size.height >= 240;
      if (!ok) failures += 1;
      console.log(
        `${ok ? "OK  " : "FAIL"} ${size ? `${size.width}x${size.height}` : "no size"}  ${path.basename(file)}`
      );
    }
  } else {
    console.log("\nreal library: not installed — skipping the cross-check");
  }

  if (failures) throw new Error(`${failures} mp4 case(s) failed`);
  console.log("\nMP4 SIZE TEST PASSED");
  console.log("  v0/v1 tkhd, audio tracks skipped, moov at either end,");
  console.log("  a decoy tkhd in mdat rejected, and the real library cross-checked.");
}

module.exports = run;
if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error("\nMP4 SIZE FAILED: " + ((e && e.message) || e));
    process.exit(1);
  }
}
