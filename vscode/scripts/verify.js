"use strict";
/**
 * scripts/verify.js — static sanity checks run at publish time.
 * Does not require any devDependency (keeps the extension installable with
 * just VS Code). Ensures the entry file exists and the manifest is valid JSON.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const main = path.join(root, pkg.main || "src/extension.js");
if (!fs.existsSync(main)) {
  console.error("ERROR: entry file missing: " + main);
  process.exit(1);
}
// Ensure the referenced commands are all declared.
const declared = (pkg.contributes && pkg.contributes.commands || []).map((c) => c.command);
const src = fs.readFileSync(main, "utf8");
const registered = [...src.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((m) => m[1]);
const missing = registered.filter((c) => !declared.includes(c));
if (missing.length) {
  console.error("ERROR: commands registered but not declared in package.json:", missing);
  process.exit(1);
}
console.log("OK: extension entry and manifests verified.");
