#!/usr/bin/env node
// scripts/checksums.mjs — pins what the release ships.
//
// The three files an Obsidian user drops into their vault and the VSIX a VS Code
// user installs are all fetched from GitHub Releases, where nothing verifies the
// bytes for them. `SHA256SUMS.txt` is attached to every release so they can:
//
//   Get-FileHash main.js -Algorithm SHA256          # Windows
//   sha256sum -c SHA256SUMS.txt                     # macOS / Linux
//   node scripts/checksums.mjs --verify             # from a checkout
//
// The workflow runs this after packaging, so the published hashes always
// describe the artifacts built from the tagged sources (and
// `scripts/verify-artifact.mjs` has already proven those sources match the
// committed main.js).
//
// Usage:
//   node scripts/checksums.mjs            # write SHA256SUMS.txt
//   node scripts/checksums.mjs --verify   # verify every file in SHA256SUMS.txt
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { REPO_ROOT } from "./build-options.mjs";

const SUMS_FILE = path.join(REPO_ROOT, "SHA256SUMS.txt");

/** Files the release workflow uploads, in a stable order. */
function releaseAssets() {
  const fixed = ["main.js", "manifest.json", "styles.css"];
  const vscodeDir = path.join(REPO_ROOT, "vscode");
  const vsixes = fs.existsSync(vscodeDir)
    ? fs
        .readdirSync(vscodeDir)
        .filter((f) => f.toLowerCase().endsWith(".vsix"))
        .sort()
        // POSIX separators in the manifest: `sha256sum -c` on macOS/Linux must
        // resolve the path, and a Windows-style backslash is literal there.
        .map((f) => "vscode/" + f)
    : [];
  return [...fixed, ...vsixes];
}

const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function write() {
  const lines = [];
  const rows = [];
  for (const rel of releaseAssets()) {
    const absolute = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(absolute)) {
      console.log(`NOTE: ${rel} does not exist yet — not listed (package it first).`);
      continue;
    }
    const hash = sha256(absolute);
    lines.push(`${hash}  ${rel}`);
    rows.push([hash.slice(0, 16) + "…", rel, fs.statSync(absolute).size.toLocaleString("en-US") + " B"]);
  }
  if (!lines.length) {
    console.error("nothing to checksum");
    process.exit(1);
  }
  fs.writeFileSync(SUMS_FILE, lines.join("\n") + "\n", "utf8");
  const width = Math.max(...rows.map((r) => r[2].length));
  for (const [hash, rel, size] of rows) console.log(`  ${hash}  ${rel.padEnd(28)} ${size.padStart(width)}`);
  console.log(`\nwrote ${path.relative(REPO_ROOT, SUMS_FILE)} (${lines.length} file(s))`);
}

function verify() {
  if (!fs.existsSync(SUMS_FILE)) {
    console.error("SHA256SUMS.txt does not exist — run without --verify first.");
    process.exit(1);
  }
  const entries = fs
    .readFileSync(SUMS_FILE, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
      return match ? { expected: match[1].toLowerCase(), file: match[2].trim() } : null;
    })
    .filter(Boolean);

  let bad = 0;
  for (const { expected, file } of entries) {
    const absolute = path.join(REPO_ROOT, file);
    if (!fs.existsSync(absolute)) {
      console.log(`MISSING  ${file}`);
      bad++;
      continue;
    }
    const actual = sha256(absolute);
    if (actual !== expected) {
      console.log(`MISMATCH ${file}\n         expected ${expected}\n         actual   ${actual}`);
      bad++;
    } else {
      console.log(`ok       ${file}`);
    }
  }
  if (bad) {
    console.error(`\n${bad} file(s) did not match SHA256SUMS.txt`);
    process.exit(1);
  }
  console.log(`\n${entries.length} file(s) verified against SHA256SUMS.txt`);
}

if (process.argv.includes("--verify")) verify();
else write();
