// bump-version.mjs — one version for the whole monorepo.
//
//   node scripts/bump-version.mjs 0.2.0
//
// The Obsidian community directory requires the git tag to equal the version in
// manifest.json, and this repository ships the Obsidian plugin, the VS Code
// extension and the npm CLI from a single tag, so all three must move together:
//
//   manifest.json          version + versions.json entry  (Obsidian reads these)
//   vscode/package.json    version                        (VSIX + Marketplace)
//   codex/package.json     version                        (the `wallvia` npm package)
//   package.json           version                        (private root manifest, kept in step)
//
// Run it with no argument to just print the current versions.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const write = (p, data) => writeFileSync(join(ROOT, p), JSON.stringify(data, null, 2) + "\n", "utf8");

const manifest = read("manifest.json");
const vscode = read("vscode/package.json");
const codex = read("codex/package.json");
const root = read("package.json");

const next = process.argv[2];
if (!next) {
  console.log("current versions");
  console.log("  manifest.json       ", manifest.version);
  console.log("  vscode/package.json ", vscode.version);
  console.log("  codex/package.json  ", codex.version);
  console.log("  package.json (root) ", root.version);
  console.log("\nusage: node scripts/bump-version.mjs <x.y.z>");
  process.exit(0);
}

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`"${next}" is not x.y.z — Obsidian only accepts that format.`);
  process.exit(1);
}
if (
  next === manifest.version &&
  next === vscode.version &&
  next === codex.version &&
  next === root.version
) {
  console.error(`everything is already at ${next}; nothing to do.`);
  process.exit(1);
}

const minAppVersion = manifest.minAppVersion ?? "1.4.0";
const versions = read("versions.json");
const previous = manifest.version;

manifest.version = next;
versions[next] = minAppVersion;
vscode.version = next;
codex.version = next;
root.version = next;

write("manifest.json", manifest);
write("versions.json", versions);
write("vscode/package.json", vscode);
write("codex/package.json", codex);
write("package.json", root);

console.log(`bumped ${previous} -> ${next}`);
console.log("  manifest.json + versions.json (minAppVersion " + minAppVersion + ")");
console.log("  vscode/package.json, codex/package.json, package.json");
console.log("\nnext steps");
console.log(`  git commit -am "Release ${next}"`);
console.log(`  git tag -a ${next} -m "${next}" && git push origin main ${next}`);
console.log("  the tag then releases the plugin + VSIX and publishes the npm CLI");
