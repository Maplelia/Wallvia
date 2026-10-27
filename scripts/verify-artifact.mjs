#!/usr/bin/env node
// scripts/verify-artifact.mjs — the artifact↔source consistency guard.
//
// `main.js` is committed because Obsidian's installer, BRAT and the community
// directory all fetch it from the repository root. A committed build artifact
// rots silently the moment someone edits `obsidian/` and forgets to rebuild, so
// this guard rebuilds with the *exact* release options and compares bytes.
//
// It also checks the version trio (manifest.json = package.json =
// versions.json = vscode/package.json) and, when asked, the contents of a
// packaged VSIX, because `vsce` ships `vscode/src/*.js` verbatim and a stale
// VSIX is the same class of bug one directory over.
//
// Usage:
//   node scripts/verify-artifact.mjs            # rebuild + version trio
//   node scripts/verify-artifact.mjs --vsix     # also compare vscode/*.vsix
//   node scripts/verify-artifact.mjs --vsix --strict
//                                               # --vsix drift is non-fatal
//                                               # unless --strict
//
// Exit codes: 0 consistent, 1 drift, 2 prerequisite missing (no esbuild / no
// main.js). CI treats 2 as a failure; a bare local run reports it as a skip.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { REPO_ROOT, buildOptions } from "./build-options.mjs";

const argv = new Set(process.argv.slice(2));
const wantVsix = argv.has("--vsix");
const strictVsix = argv.has("--strict");

const problems = [];
const done = [];

const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join("/");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const kb = (n) => n.toLocaleString("en-US") + " B";

function fail(message) {
  problems.push(message);
}

function pass(message) {
  done.push(message);
}

/** Offset of the first differing byte, or -1 when the buffers are identical. */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** A short ASCII window around `at`, for a diff a human can act on. */
function around(buf, at) {
  const from = Math.max(0, at - 50);
  const to = Math.min(buf.length, at + 50);
  return JSON.stringify(buf.subarray(from, to).toString("utf8"));
}

// --------------------------------------------------------------- zip reader
// Zero-dependency on purpose: the suite installs nothing, and a VSIX is just a
// stored/deflated ZIP whose central directory is enough to read it.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** name → bytes, for every file entry in the archive. */
function readZip(buf) {
  const limit = Math.min(buf.length, 0xffff + 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - limit; i--) {
    if (buf.length - i >= 22 && buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record (not a ZIP?)");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central header at " + off);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory entry

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("bad local header for " + name);
    const dataStart =
      localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported compression method ${method} for ${name}`);
    if (crc32(data) !== crc) throw new Error("CRC mismatch for " + name);
    entries.set(name, data);
  }
  return entries;
}

// ------------------------------------------------------------------- checks
async function checkBundle() {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    console.log("PREREQ: esbuild is not installed — run `npm install` first.");
    process.exit(2);
  }
  const bundlePath = path.join(REPO_ROOT, "main.js");
  if (!fs.existsSync(bundlePath)) {
    console.log("PREREQ: main.js is missing — run `npm run build`.");
    process.exit(2);
  }
  const tmp = path.join(os.tmpdir(), `wallvia-verify-${process.pid}.js`);
  await esbuild.build(buildOptions({ prod: true, outfile: tmp, logLevel: "silent" }));
  const rebuilt = fs.readFileSync(tmp);
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best effort */
  }
  const committed = fs.readFileSync(bundlePath);

  if (rebuilt.equals(committed)) {
    pass(`main.js ${kb(committed.length)} sha256:${sha256(committed).slice(0, 12)}`);
    return;
  }
  const at = firstDiff(rebuilt, committed);
  fail(
    [
      "DRIFT: main.js does not match obsidian/ sources.",
      `  committed ${kb(committed.length)}  sha256:${sha256(committed).slice(0, 12)}`,
      `  rebuilt   ${kb(rebuilt.length)}  sha256:${sha256(rebuilt).slice(0, 12)}`,
      `  first difference at byte ${at}`,
      `  committed: ${around(committed, at)}`,
      `  rebuilt  : ${around(rebuilt, at)}`,
      "  fix: npm run build && git add main.js",
    ].join("\n")
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"));
}

function checkVersions() {
  const manifest = readJson("manifest.json");
  const pkg = readJson("package.json");
  const versions = readJson("versions.json");
  const vscodePkg = readJson("vscode/package.json");

  if (manifest.version !== pkg.version) {
    fail(`DRIFT: manifest.json version ${manifest.version} != package.json ${pkg.version}`);
  } else {
    pass(`version ${manifest.version} (manifest = package)`);
  }

  const minFor = versions[manifest.version];
  if (minFor === undefined) {
    fail(`DRIFT: versions.json has no entry for ${manifest.version} (Obsidian needs one per release)`);
  } else if (minFor !== manifest.minAppVersion) {
    fail(
      `DRIFT: versions.json["${manifest.version}"] = ${minFor} but manifest.minAppVersion = ${manifest.minAppVersion}`
    );
  } else {
    pass(`minAppVersion ${manifest.minAppVersion} matches versions.json`);
  }

  if (vscodePkg.version !== manifest.version) {
    fail(
      `DRIFT: vscode/package.json version ${vscodePkg.version} != manifest.json ${manifest.version} — ` +
        "the release workflow derives both from one tag, so `node scripts/bump-version.mjs` must bump them together."
    );
  } else {
    pass(`vscode/package.json ${vscodePkg.version} (same tag stream)`);
  }
}

function checkVsix() {
  if (!wantVsix) return;
  const dir = path.join(REPO_ROOT, "vscode");
  const vsixes = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".vsix"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!vsixes.length) {
    console.log("NOTE: no vscode/*.vsix to compare (gitignored build output) — skipped.");
    return;
  }
  const vsix = vsixes[0];
  let entries;
  try {
    entries = readZip(fs.readFileSync(vsix));
  } catch (err) {
    fail(`DRIFT: cannot read ${rel(vsix)}: ${err.message}`);
    return;
  }

  const srcDir = path.join(dir, "src");
  const sources = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith(".js"))
    .sort();
  const drifted = [];
  for (const name of sources) {
    const zipName = "extension/src/" + name;
    const packed = entries.get(zipName);
    if (!packed) {
      drifted.push(`${zipName} is missing from the VSIX`);
      continue;
    }
    const onDisk = fs.readFileSync(path.join(srcDir, name));
    if (!packed.equals(onDisk)) {
      drifted.push(`${zipName} ${kb(packed.length)} inside the VSIX vs ${kb(onDisk.length)} on disk`);
    }
  }
  for (const name of entries.keys()) {
    if (!name.startsWith("extension/src/")) continue;
    if (!sources.includes(name.slice("extension/src/".length))) {
      drifted.push(`${name} is in the VSIX but no longer in vscode/src`);
    }
  }

  const shown = rel(vsix);
  if (!drifted.length) {
    pass(`${shown}: ${sources.length} source file(s) match`);
    return;
  }
  const message = [
    `DRIFT: ${shown} was packaged from different sources than vscode/src:`,
    ...drifted.map((d) => "  - " + d),
    "  fix: cd vscode && npx @vscode/vsce package",
  ].join("\n");
  if (strictVsix) fail(message);
  else console.log("NOTE (non-fatal without --strict):\n" + message);
}

// --------------------------------------------------------------------- main
await checkBundle();
checkVersions();
checkVsix();

for (const line of done) console.log("ok   " + line);
if (problems.length) {
  console.error("");
  for (const line of problems) console.error(line);
  console.error(`\n${problems.length} artifact consistency problem(s).`);
  process.exit(1);
}
console.log(`\nartifacts consistent (${done.length} check(s)).`);
