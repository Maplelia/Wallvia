// tests/encoding.cjs — no tracked text file may contain UTF-8-read-as-GBK damage.
//
// Why this exists: the 1.0.1 release commit rewrote two Chinese READMEs with
// PowerShell's `[System.IO.File]::WriteAllText`, which defaults to the system
// code page on Windows. The files came back as valid UTF-8 holding the GBK
// misinterpretation of their own bytes — Chinese words rendered as unrelated CJK
// glyphs — so nothing failed. The docs were simply unreadable, and it took a
// human to notice.
//
// A byte-level check catches that class of damage before it is committed:
//   · the U+FFFD replacement character
//   · the canonical double-decode artifact (three specific characters)
//   · UTF-8 punctuation and emoji read as GBK
//   · three-character CJK runs that never occur in real Chinese prose
//
// The patterns are built from escape sequences rather than written literally:
// this file is scanned by the test too, and a literal sample would match itself.
//
// Run standalone: node tests/encoding.cjs
// Or via:         node tests/run-all.cjs
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".vscode"]);
const TEXT_EXT = /\.(md|css|json|ts|js|cjs|mjs|yml|yaml|html)$/;

/**
 * Artifacts that only appear when UTF-8 bytes were decoded as GBK.
 *
 * Built from code points, never written literally: this file is scanned by the
 * test too, so a literal sample in a comment would make it fail on itself.
 * (That is exactly what happened on the first attempt.)
 */
const DAMAGE = new RegExp(
  [
    "\\uFFFD", // the replacement character
    "\u951F\u65A4\u62F7", // the canonical double-decode artifact
    "\u9225", // em dash read as GBK
    "\u8133", // multiplication sign read as GBK
    "\u9983", // first half of a mangled emoji
    "\u6D93\u6783", // 中文 read as GBK
    "\u95B2\u5C98\u5F51", // a common three-character run
    "\u9535\u5267\u5E16", // "picture" read as GBK
    "\u93BE\u65C1", // "play" read as GBK
  ].join("|"),
  "g"
);

/** Files the scan must never walk into (generated, or intentionally binary). */
const SKIP_FILES = new Set([
  "package-lock.json",
  // This file necessarily contains the damage patterns it searches for, in the
  // form of escape sequences that JS evaluates at parse time.
  "encoding.cjs",
]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (TEXT_EXT.test(entry.name) && !SKIP_FILES.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function run() {
  const files = walk(ROOT, []);
  const bad = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const hits = text.match(DAMAGE);
    if (hits) bad.push({ file: path.relative(ROOT, file), hits: hits.slice(0, 5) });
  }

  assertClean(files, bad);

  console.log("TEXT ENCODING TEST PASSED");
  console.log(
    "  " +
      files.length +
      " text files scanned: no replacement characters, no double-decode\n" +
      "  artifacts, no GBK-misread punctuation or emoji, and no CJK runs that\n" +
      "  never occur in real prose — the shape the 1.0.1 release commit produced\n" +
      "  by writing UTF-8 with the system code page."
  );
}

function assertClean(files, bad) {
  if (!bad.length) return;
  const detail = bad
    .map((b) => "  " + b.file + "  →  " + b.hits.join(" "))
    .join("\n");
  throw new Error(
    bad.length +
      " file(s) contain GBK-misread UTF-8 (write with an explicit UTF-8 encoder):\n" +
      detail
  );
}

module.exports = run;

if (require.main === module) {
  run().catch((e) => {
    console.error("TEXT ENCODING TEST FAILED:", e && e.message);
    process.exit(1);
  });
}
