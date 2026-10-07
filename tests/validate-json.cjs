// tests/validate-json.cjs — assert every shipped JSON file parses.
const fs = require("node:fs");
const path = require("node:path");
const files = [
  "manifest.json",
  "package.json",
  "obsidian/tsconfig.json",
  "vscode/package.json",
  "vscode/.vscode/launch.json",
  "vscode/.vscode/tasks.json",
  "codex/package.json",
];
let bad = 0;
const root = path.join(__dirname, "..");
for (const f of files) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
    console.log("OK   " + f);
  } catch (e) {
    console.log("FAIL " + f + " : " + e.message);
    bad++;
  }
}
if (bad) process.exit(1);
console.log("ALL JSON VALID");
