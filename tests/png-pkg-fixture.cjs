// tests/png-pkg-fixture.cjs — build a structurally real scene.pkg in memory.
//
// Shared by the Obsidian and VS Code smoke tests: a PKGV0022 container whose
// `.tex` entry holds a genuine PNG (plus optional mipmaps), i.e. exactly the
// shape Wallpaper Engine ships.
const zlib = require("node:zlib");

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
  return Buffer.concat([Buffer.from("TEXV0005 padding padding", "latin1"), basePng, ...mipmaps]);
}

module.exports = { crc32, chunk, makePng, makePkg, makeTex };
