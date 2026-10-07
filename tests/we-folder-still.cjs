// tests/we-folder-still.cjs — the thumbnail for an *unpacked* wallpaper.
//
// Wallpaper Engine's built-in wallpapers ship no `scene.pkg`; their artwork sits
// loose in `materials/` / `images/`, next to the square `preview.jpg` that made
// every picker card look like a cropped 1:1 picture. This drives the shipped
// engine (`obsidian/wallpaper-engine.ts`, bundled with the Obsidian mock aliased in)
// against a synthetic project folder and asserts which file wins.
//
// Run standalone: node tests/we-folder-still.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");

/** Minimal but genuinely valid PNG of the requested size. */
function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const tag = Buffer.from(type, "latin1");
    const crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
    let crc = -1;
    for (const byte of Buffer.concat([tag, data])) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const out = Buffer.alloc(4);
    out.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([len, tag, data, out]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The engine half of the plugin, bundled against the test's Obsidian mock. */
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

/** A throwaway unpacked project folder. */
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-loose-"));
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ type: "scene", file: "scene.json", preview: "preview.jpg" })
  );
  for (const [rel, data] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
  return dir;
}

async function run() {
  const engine = loadEngine();
  const dirs = [];
  const make = (files) => {
    const dir = project(files);
    dirs.push(dir);
    return dir;
  };

  try {
    // --- the wallpaper's own 16:9 artwork wins over a square extra ---------
    const landscape = make({
      "preview.jpg": png(801, 801),
      "materials/sky.png": png(1920, 1080),
      "materials/tile.png": png(1024, 1024),
    });
    const picked = await engine.resolveStillAssets(landscape);
    assert.ok(picked.still, "a loose 16:9 still is found");
    assert.deepEqual(
      { w: picked.still.width, h: picked.still.height },
      { w: 1920, h: 1080 },
      "the 16:9 material wins over the square one, not the largest"
    );
    assert.equal(picked.still.ext, "png", "the extension follows the chosen file");
    assert.deepEqual(
      picked.max,
      { width: 1920, height: 1080 },
      "the resolution pill reports the still it will actually paint"
    );

    // --- preview.jpg is never a candidate ---------------------------------
    const previewOnly = make({ "preview.jpg": png(801, 801), "images/logo.png": png(900, 900) });
    const none = await engine.resolveStillAssets(previewOnly);
    assert.equal(
      none.still,
      null,
      "nothing landscape: the square preview is the honest fallback, not a 1:1 crop"
    );

    // --- a wide logo must not beat a real wallpaper -----------------------
    const withLogo = make({
      "materials/banner.png": png(1000, 252), // ratio 3.97
      "images/background.png": png(1600, 900), // ratio 1.78
    });
    const best = await engine.resolveStillAssets(withLogo);
    assert.deepEqual(
      { w: best.still.width, h: best.still.height },
      { w: 1600, h: 900 },
      "the closest-to-16:9 candidate wins, not the widest"
    );

    // --- only deep folders are searched -----------------------------------
    const nested = make({ "materials/a/b/deep.png": png(1920, 1080) });
    assert.equal(
      (await engine.resolveStillAssets(nested)).still,
      null,
      "the scan stays one level inside the known art folders"
    );

    // --- a package still wins over loose files ----------------------------
    const both = make({ "materials/loose.png": png(1920, 1080) });
    // A package with only a square texture: no PNG levels, so the folder wins.
    const pkgOnly = Buffer.concat([
      Buffer.from([0, 0, 0, 8]),
      Buffer.from("PKGV0021", "ascii"),
      Buffer.from([0, 0, 0, 0]),
    ]);
    fs.writeFileSync(path.join(both, "scene.pkg"), pkgOnly);
    const fallback = await engine.resolveStillAssets(both);
    assert.ok(fallback.still, "an unusable package falls through to the project files");
    assert.equal(fallback.still.width, 1920, "and finds the loose artwork");

    console.log("WE FOLDER STILL TEST PASSED");
    console.log("  16:9 material preferred over a square one, preview.jpg skipped,");
    console.log("  a wide logo rejected, the scan kept shallow, and a package with");
    console.log("  no usable PNG falling through to the project's own files.");
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "tests", ".tmp-engine.cjs"), { force: true });
  }
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("WE FOLDER STILL FAILED: " + ((e && e.message) || e));
    process.exit(1);
  });
}
