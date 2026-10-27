// esbuild.config.mjs — dev watch / production bundle for the Obsidian plugin.
//
// The options themselves live in `scripts/build-options.mjs` so the artifact
// consistency guard can rebuild byte-identically (see
// `scripts/verify-artifact.mjs`).
import esbuild from "esbuild";
import process from "process";
import { buildOptions } from "./scripts/build-options.mjs";

const prod = process.argv[2] === "production";

// The Obsidian plugin's TypeScript lives in obsidian/, beside the vscode/ and
// codex/ ports; the bundle still lands at the repository root, where Obsidian
// loads it from.
const context = await esbuild.context(buildOptions({ prod }));

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
