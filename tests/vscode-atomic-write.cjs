// tests/vscode-atomic-write.cjs — the failure modes `writeFileAtomic` exists for.
//
// The helper is the one place that makes "a crash cannot leave a truncated
// workbench.html behind" true, so its *failure* paths are what matter: a plain
// write test would pass against the old `writeFileSync` code too. These cases
// patch `fs.writeFileSync` / `fs.renameSync` to fail on purpose and assert that
// the original file is untouched and no temp file is left lying around — which
// is exactly what a reader (VS Code's next start) would see.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");
const { writeFileAtomic } = require("../vscode/src/atomic-write.js");

const realWrite = fs.writeFileSync;
const realRename = fs.renameSync;

/** Temp files `writeFileAtomic` may leave behind when it fails. */
function residue(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes(".tmp"));
}

module.exports = async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-atomic-"));
  const target = path.join(dir, "workbench.html");

  try {
    // 1) a new file appears complete, with nothing left beside it
    writeFileAtomic(target, "<html>one</html>");
    assert.equal(fs.readFileSync(target, "utf8"), "<html>one</html>");
    assert.deepEqual(residue(dir), [], "no temp file after a successful write");

    // 2) a write that dies halfway must not damage the existing file
    fs.writeFileSync(target, "<html>before</html>");
    fs.writeFileSync = function (fd, data, ...rest) {
      // Write a stub, then fail the way a full disk would.
      realWrite.call(fs, fd, "<htm", ...rest);
      throw new Error("ENOSPC: no space left on device");
    };
    let threw = false;
    try {
      writeFileAtomic(target, "<html>after</html>");
    } catch {
      threw = true;
    }
    fs.writeFileSync = realWrite;
    assert.ok(threw, "a partial write must throw");
    assert.equal(fs.readFileSync(target, "utf8"), "<html>before</html>", "old bytes survived");
    assert.deepEqual(residue(dir), [], "no temp file after a failed write");

    // 3) a rename that never succeeds (antivirus holding the file) is retried,
    //    then reported — without ever publishing a partial file
    let attempts = 0;
    fs.renameSync = function () {
      attempts++;
      const err = new Error("EPERM: operation not permitted, rename");
      err.code = "EPERM";
      throw err;
    };
    threw = false;
    try {
      writeFileAtomic(target, "<html>blocked</html>");
    } catch {
      threw = true;
    }
    fs.renameSync = realRename;
    assert.ok(threw, "a rename that keeps failing must throw");
    assert.equal(attempts, 4, "the rename is retried (4 attempts total), got " + attempts);
    assert.equal(fs.readFileSync(target, "utf8"), "<html>before</html>", "old bytes survived");
    assert.deepEqual(residue(dir), [], "no temp file after an exhausted rename");

    // 4) a transient lock (the common Windows case) is survived by retrying
    let locks = 2;
    fs.renameSync = function (from, to) {
      if (locks-- > 0) {
        const err = new Error("EPERM: operation not permitted, rename");
        err.code = "EPERM";
        throw err;
      }
      return realRename.call(fs, from, to);
    };
    writeFileAtomic(target, "<html>retried</html>");
    fs.renameSync = realRename;
    assert.equal(fs.readFileSync(target, "utf8"), "<html>retried</html>", "retry published the new bytes");
    assert.deepEqual(residue(dir), [], "no temp file after a retried rename");

    // 5) permissions of an existing file are preserved (POSIX only: Windows has
    //    no meaningful file mode to compare here)
    if (process.platform !== "win32") {
      fs.chmodSync(target, 0o640);
      writeFileAtomic(target, "<html>mode</html>");
      assert.equal(fs.statSync(target).mode & 0o777, 0o640, "mode preserved");
    }

    // 6) the same name written twice in a row is still fine (no stale temp wins)
    writeFileAtomic(target, "<html>a</html>");
    writeFileAtomic(target, "<html>b</html>");
    assert.equal(fs.readFileSync(target, "utf8"), "<html>b</html>");
    assert.deepEqual(residue(dir), [], "no temp file after repeated writes");
  } finally {
    fs.writeFileSync = realWrite;
    fs.renameSync = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("ATOMIC WRITE TEST PASSED");
  console.log("  new file, partial write, exhausted rename, transient lock,");
  console.log("  preserved mode and repeated writes — the target never holds");
  console.log("  a half-written file, and no .tmp is ever left behind.");
};
