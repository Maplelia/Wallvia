// tests/obsidian-scene-pkg.cjs — full-resolution artwork out of `scene.pkg`.
//
// A scene wallpaper only ships a small square preview.jpg, while the package
// carries the real 3840x2160 PNG. This drives applyWeWallpaper() against a
// synthetic but structurally real scene.pkg (PKGV0022 table + a .tex entry
// holding an uncompressed PNG with mipmaps) and asserts that the artwork is
// preferred, copied byte for byte, and reported, with a clean fallback to the
// preview whenever anything is missing, too small or malformed.
//
// Run standalone: node tests/obsidian-scene-pkg.cjs
const { install } = require("./mock-loader.cjs");
install();

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

// ------------------------------------------------------------------ PNG / PKG

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tag = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([len, tag, data, crc]);
}

/** A genuinely valid RGB PNG, with its IDAT split like Wallpaper Engine's. */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = (x * 7) % 256;
      raw[row + 2 + x * 3] = (y * 5) % 256;
      raw[row + 3 + x * 3] = 90;
    }
  }
  const deflated = zlib.deflateSync(raw);
  const idats = [];
  for (let at = 0; at < deflated.length; at += 8192) {
    idats.push(chunk("IDAT", deflated.subarray(at, at + 8192)));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...idats,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PKGV0022 container: header + name/offset/length table + concatenated data. */
function makePkg(entries) {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(8, 0);
  header.write("PKGV0022", 4, "latin1");
  header.writeUInt32LE(entries.length, 12);
  const table = [];
  const parts = [];
  let cursor = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "latin1");
    const nameLen = Buffer.alloc(4);
    nameLen.writeUInt32LE(name.length);
    const offset = Buffer.alloc(4);
    offset.writeUInt32LE(cursor);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(entry.data.length);
    table.push(Buffer.concat([nameLen, name, offset, length]));
    parts.push(entry.data);
    cursor += entry.data.length;
  }
  return Buffer.concat([header, ...table, ...parts]);
}

/** A .tex entry: opaque header, the base image, then smaller mipmaps. */
function makeTex(basePng, mipmaps = []) {
  return Buffer.concat([
    Buffer.from("TEXV0005 padding padding", "latin1"),
    basePng,
    ...mipmaps,
  ]);
}

// ---------------------------------------------------------------------- setup

async function run() {
  const obsidian = require("obsidian");
  const notices = [];
  const RealNotice = obsidian.Notice;
  obsidian.Notice = class extends RealNotice {
    constructor(message) {
      super(message);
      notices.push(message);
    }
  };

  const mod = require("../main.js");
  const Plugin = mod && mod.default ? mod.default : mod;
  const proto = Plugin.prototype;
  proto.addCommand = function (command) {
    return command;
  };

  const writes = [];
  const app = {
    workspace: {
      on: (evt) => ({ evt }),
      onLayoutReady: (cb) => cb(),
      containerEl: {},
    },
    vault: {
      getFiles: () => [],
      on: (evt) => ({ evt }),
      adapter: {
        stat: async () => ({ type: "file", mtime: 1 }),
        getResourcePath: (p) => "app://local/" + encodeURIComponent(p),
        mkdir: async () => {},
        writeBinary: async (target, data) => {
          writes.push([target, data]);
        },
        list: async () => ({ files: [], folders: [] }),
        remove: async () => {},
      },
    },
  };

  require("./mocks/obsidian/dom.js").installBodyDom();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-pkg-"));
  process.on("exit", () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp folder is not worth failing a run over.
    }
  });
  const previewFile = path.join(tmp, "preview.jpg");
  // The bytes never matter for the extension — the filename decides it — so a
  // .jpg here is what marks "the small preview was used".
  fs.writeFileSync(previewFile, Buffer.from("not really a jpeg"));

  const plugin = new Plugin(app, { id: "wallvia" });
  await plugin.onload();

  const artwork = makePng(2000, 1000);
  const mip = makePng(1000, 500);
  const tiny = makePng(320, 240);

  // --- 1. a real scene package: prefer the 2000x1000 artwork ---------------
  const withArt = path.join(tmp, "with-art");
  fs.mkdirSync(withArt);
  fs.writeFileSync(
    path.join(withArt, "scene.pkg"),
    makePkg([
      { name: "scene.json", data: Buffer.from('{"objects":[]}', "latin1") },
      { name: "materials/a.tex", data: makeTex(artwork, [mip, tiny]) },
      { name: "shaders/effect.frag", data: Buffer.from("void main(){}", "latin1") },
    ])
  );

  notices.length = 0;
  await plugin.applyWeWallpaper({
    id: "9999000001",
    title: "Synthetic scene",
    type: "scene",
    source: "workshop",
    dir: withArt,
    preview: previewFile,
  });

  assert.equal(writes.length, 1, "exactly one file written for the scene package");
  assert.equal(
    writes[0][0],
    "Wallpapers/wallvia-we-9999000001.png",
    "the vault file is named after the artwork's real type"
  );
  const written = Buffer.from(writes[0][1]);
  assert.ok(written.equals(artwork), "the 2000x1000 PNG is copied byte for byte (no re-encoding)");
  assert.ok(notices.some((n) => n.includes("2000×1000")), "the notice reports the source resolution");
  assert.equal(plugin.settings.image, "Wallpapers/wallvia-we-9999000001.png", "the artwork becomes the background");

  // --- 2. the PNG must be sliced at IEND, not at the next signature -------
  assert.equal(written.length, artwork.length, "no mipmap bytes leak into the file");
  assert.equal(written.readUInt32BE(written.length - 12), 0, "the file ends with an empty IEND chunk");
  assert.equal(written.toString("latin1", written.length - 8, written.length - 4), "IEND", "…and that last chunk really is IEND");

  // --- 3. nothing large enough inside: fall back to the preview -----------
  const smallOnly = path.join(tmp, "small-only");
  fs.mkdirSync(smallOnly);
  fs.writeFileSync(
    path.join(smallOnly, "scene.pkg"),
    makePkg([{ name: "materials/small.tex", data: makeTex(tiny) }])
  );
  writes.length = 0;
  await plugin.applyWeWallpaper({
    id: "9999000002",
    title: "Too small",
    type: "scene",
    source: "workshop",
    dir: smallOnly,
    preview: previewFile,
  });
  assert.equal(writes[0][0], "Wallpapers/wallvia-we-9999000002.jpg", "a 320px texture is not worth preferring");

  // --- 4. corrupt package: still falls back instead of throwing -----------
  const broken = path.join(tmp, "broken");
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, "scene.pkg"), Buffer.from("NOPE0000 garbage", "latin1"));
  writes.length = 0;
  await plugin.applyWeWallpaper({
    id: "9999000003",
    title: "Broken",
    type: "scene",
    source: "workshop",
    dir: broken,
    preview: previewFile,
  });
  assert.equal(writes[0][0], "Wallpapers/wallvia-we-9999000003.jpg", "a corrupt package falls back to the preview");

  // --- 5. a truncated table must not be trusted ---------------------------
  const truncated = path.join(tmp, "truncated");
  fs.mkdirSync(truncated);
  const pkg = makePkg([{ name: "materials/a.tex", data: makeTex(artwork) }]);
  fs.writeFileSync(path.join(truncated, "scene.pkg"), pkg.subarray(0, pkg.length - 100));
  writes.length = 0;
  await plugin.applyWeWallpaper({
    id: "9999000004",
    title: "Truncated",
    type: "scene",
    source: "workshop",
    dir: truncated,
    preview: previewFile,
  });
  assert.equal(writes[0][0], "Wallpapers/wallvia-we-9999000004.jpg", "a truncated entry falls back instead of reading garbage");

  // --- 6. no scene.pkg at all (video/web wallpapers) ---------------------
  writes.length = 0;
  await plugin.applyWeWallpaper({
    id: "9999000005",
    title: "Video wallpaper",
    type: "video",
    source: "workshop",
    dir: tmp,
    preview: previewFile,
  });
  assert.equal(writes[0][0], "Wallpapers/wallvia-we-9999000005.jpg", "non-scene wallpapers keep using the preview");

  // --- 7. against a wallpaper really installed on this machine ------------
  // Skipped when Wallpaper Engine is absent, so the suite stays portable. Some
  // real packages genuinely carry no usable PNG (one of the 17 installed here
  // does not), so every candidate is tried and the first hit is asserted on.
  const workshop = "D:/Steam/steamapps/workshop/content/431960";
  const candidates = [];
  try {
    for (const name of fs.readdirSync(workshop)) {
      if (fs.existsSync(path.join(workshop, name, "scene.pkg"))) {
        candidates.push(path.join(workshop, name));
      }
    }
  } catch {
    // No Steam install on this machine.
  }
  let extracted = null;
  for (const dir of candidates) {
    writes.length = 0;
    await plugin.applyWeWallpaper({
      id: "9999000006",
      title: "Installed wallpaper",
      type: "scene",
      source: "workshop",
      dir,
      preview: previewFile,
    });
    if (writes.length && String(writes[0][0]).endsWith(".png")) {
      extracted = { dir, bytes: Buffer.from(writes[0][1]) };
      break;
    }
  }
  if (extracted) {
    assert.ok(
      extracted.bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      "the extracted artwork really is a PNG"
    );
    const width = extracted.bytes.readUInt32BE(16);
    const height = extracted.bytes.readUInt32BE(20);
    assert.ok(width >= 1920 && height >= 1080, `…at full resolution (got ${width}x${height})`);
    assert.ok(extracted.bytes.length > 500000, "…with the full-size payload, not a thumbnail");
    console.log(
      `  real package: ${path.basename(extracted.dir)} -> ${width}x${height}, ` +
        `${Math.round(extracted.bytes.length / 1024)} KB of ${candidates.length} installed`
    );
  } else {
    console.log(`  (no usable installed package found among ${candidates.length} — real-package case skipped)`);
  }

  console.log("OBSIDIAN SCENE PACKAGE TEST PASSED");
  console.log("  PKGV0022 table, IEND-exact slice, byte-for-byte copy, resolution notice,");
  console.log("  and the fallbacks: too small, corrupt magic, truncated entry, non-scene.");
}

module.exports = run;
if (require.main === module) {
  run().catch((e) => {
    console.error("SCENE PACKAGE TEST FAILED:", (e && e.message) || e);
    process.exit(1);
  });
}
