// tests/mock-loader.cjs — redirect bare `obsidian` / `vscode` requires to the
// local test fixtures, so the plugin/extension sources can be loaded outside
// their host apps without polluting node_modules.
const Module = require("node:module");
const path = require("node:path");

const originalLoad = Module._load;

function mockPath(name) {
  return path.join(__dirname, "mocks", name, "index.js");
}

function install() {
  Module._load = function (request, parent, isMain) {
    if (request === "obsidian") return originalLoad.call(this, mockPath("obsidian"), parent, isMain);
    if (request === "vscode") return originalLoad.call(this, mockPath("vscode"), parent, isMain);
    return originalLoad.apply(this, arguments);
  };
}

module.exports = { install };
