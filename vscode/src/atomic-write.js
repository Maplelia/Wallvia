/**
 * @fileoverview Atomic file writes.
 *
 * `workbench.html` and `product.json` are opened by VS Code on the very next
 * start, and they used to be written with plain `writeFileSync` twice in a
 * row: a crash, a full disk or an antivirus lock between those two calls left a
 * truncated file behind — a blank window, or an installation that refuses to
 * start at all. Writing a sibling temp file, fsyncing it and renaming means the
 * target path only ever points at complete bytes; `rename` is atomic on NTFS
 * and POSIX alike, so a reader sees the old file or the new one, never a mix.
 *
 * Extracted into its own module (rather than a private helper) so the failure
 * paths below can be tested directly: `tests/vscode-atomic-write.cjs` patches
 * `fs.renameSync` and `fs.writeFileSync` to fail on purpose and asserts the
 * original file is untouched.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** Blocking sleep; only the rename retry uses it. */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * Write `file` so no reader can ever observe it half-written.
 *
 * The rename is retried a few times because on Windows an antivirus scanner
 * commonly holds a freshly closed file open for a few milliseconds.
 *
 * @param {string} file target path
 * @param {string|Buffer} data bytes to write
 */
function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    "." + path.basename(file) + ".wallvia-" + process.pid + "-" + Date.now().toString(36) + ".tmp"
  );
  let mode;
  try {
    mode = fs.statSync(file).mode & 0o777; // keep the original permissions
  } catch {
    mode = undefined; // new file: let the umask decide
  }
  let fd;
  try {
    fd = fs.openSync(tmp, "w", mode === undefined ? 0o666 : mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  fs.closeSync(fd);
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 4) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
        throw err;
      }
      sleepSync(20);
    }
  }
}

module.exports = { writeFileAtomic };
