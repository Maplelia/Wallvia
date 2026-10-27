// tests/artifact-consistency.cjs — the "committed artifact must match the
// sources" guard, wired into the zero-dependency suite.
//
// The real work lives in scripts/verify-artifact.mjs (it needs esbuild, so it
// cannot be part of a suite that promises to run without `npm install`). This
// wrapper keeps the suite honest about that: without esbuild it is a SKIP with
// an explicit note, and in CI it is a hard failure, because a skipped guard in
// CI is indistinguishable from a passing one.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "verify-artifact.mjs");

module.exports = async function run() {
  const r = spawnSync(process.execPath, [SCRIPT, "--vsix", ...(process.env.CI ? ["--strict"] : [])], {
    encoding: "utf8",
  });
  const out = (r.stdout || "").trim();
  if (out) console.log(out);
  if (r.stderr && r.stderr.trim()) console.error(r.stderr.trim());

  // 2 = prerequisite missing (no esbuild, no main.js).
  if (r.status === 2) {
    if (process.env.CI) {
      throw new Error(
        "artifact consistency guard could not run in CI (esbuild/main.js missing) — " +
          "the release workflow must `npm install` and `npm run build` first."
      );
    }
    console.log("SKIPPED (needs `npm install` for esbuild; not a pass)");
    return;
  }
  if (r.status !== 0) {
    throw new Error("committed artifacts drifted from the sources (see above)");
  }
};
