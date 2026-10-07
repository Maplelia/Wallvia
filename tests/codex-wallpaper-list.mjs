// tests/codex-wallpaper-list.mjs — focused tests for the Codex CLI's
// "downloaded wallpapers" listing (codex/src/wallpaper-engine.mjs).
//
// The fixture is a fake Wallpaper Engine install built in a temp directory, so
// the real machine's install never leaks into the assertions:
//
//   <tmp>/steam/steamapps/common/wallpaper_engine/        ← WE root (config.json)
//   <tmp>/steam/steamapps/workshop/content/431960/<id>/   ← workshop items
//
// and WE_CONFIG points at the fake config.json (both as a real environment
// variable and as an injected env object).
//
// Run: node --test tests/codex-wallpaper-list.mjs
//   (or) node tests/codex-wallpaper-list.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findWeRoot,
  listDownloadedWallpapers,
  resetWallpaperCache,
} from "../codex/src/wallpaper-engine.mjs";

const TMP = mkdtempSync(join(tmpdir(), "wallvia-list-"));
const STEAM = join(TMP, "steam");
const WE = join(STEAM, "steamapps", "common", "wallpaper_engine");
const WORKSHOP = join(STEAM, "steamapps", "workshop", "content", "431960");
const MYPROJECTS = join(WE, "projects", "myprojects");
const DEFAULTS = join(WE, "projects", "defaultprojects");
const CFG = join(WE, "config.json");

const jpg = Buffer.from("ffd8ffe000104a4649460001", "hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

/** Create a project directory: project.json (optional) + arbitrary extra files. */
function project(dir, json, files = []) {
  mkdirSync(dir, { recursive: true });
  if (json !== undefined) {
    writeFileSync(join(dir, "project.json"), typeof json === "string" ? json : JSON.stringify(json));
  }
  for (const f of files) writeFileSync(join(dir, f), f.endsWith(".png") ? png : jpg);
}

// ---- fixture -------------------------------------------------------------
mkdirSync(WE, { recursive: true });
writeFileSync(CFG, JSON.stringify({ "?installdirectory": WE }));

// A) Steam Workshop
project(join(WORKSHOP, "3400000001"), { title: "Workshop Cat", type: "video", preview: "preview.jpg" }, [
  "preview.jpg",
  "scene.pkg",
]);
project(join(WORKSHOP, "3400000002"), { title: "amber waves", type: "scene" }, ["preview.jpg", "scene.pkg"]);
project(join(WORKSHOP, "3400000003"), undefined, ["preview.jpg"]); // no project.json → skipped

// B) your own projects
project(
  join(MYPROJECTS, "zeta"),
  { title: "Zeta Mine", type: "scene", preview: "shot.png" },
  ["preview.png", "shot.png", "scene.pkg"] // explicit preview must win over preview.png
);
project(join(MYPROJECTS, "3400000001"), { title: "Dup Mine", type: "scene" }, ["preview.jpg"]); // dedup
project(join(MYPROJECTS, "nopreview"), { title: "No Preview", type: "scene", file: "scene.pkg" }, [
  "scene.pkg", // no image anywhere → skipped
]);
project(join(MYPROJECTS, "broken"), "{ this is not json", ["preview.jpg"]); // skipped

// C) built-in wallpapers
project(join(DEFAULTS, "Alpha"), { type: "image", file: "park.jpg" }, ["park.jpg"]); // title ← dir name
project(join(DEFAULTS, "beta"), { title: "beta scene", type: "scene" }, ["preview.gif", "scene.pkg"]);
project(join(DEFAULTS, "empty"), undefined, ["preview.jpg"]); // no project.json → skipped

after(() => rmSync(TMP, { recursive: true, force: true }));

// ---- tests ---------------------------------------------------------------
test("resolves title / type / source / preview for every downloaded wallpaper", () => {
  const saved = process.env.WE_CONFIG;
  process.env.WE_CONFIG = CFG;
  resetWallpaperCache();
  try {
    const list = listDownloadedWallpapers();
    assert.equal(list.length, 5, "5 usable projects (3 skipped)");

    const cat = list.find((e) => e.id === "3400000001");
    assert.equal(cat.source, "workshop");
    assert.equal(cat.type, "video");
    assert.equal(cat.title, "Workshop Cat");
    assert.equal(cat.dir, join(WORKSHOP, "3400000001"));
    assert.equal(cat.preview, join(WORKSHOP, "3400000001", "preview.jpg"));

    const mine = list.find((e) => e.id === "zeta");
    assert.equal(mine.source, "mine");
    assert.equal(mine.title, "Zeta Mine");
    assert.equal(mine.preview, join(MYPROJECTS, "zeta", "shot.png"), "project.json.preview wins");

    const amber = list.find((e) => e.id === "3400000002");
    assert.equal(amber.source, "workshop");

    // every entry carries exactly the documented shape
    for (const e of list) {
      assert.deepEqual(
        Object.keys(e).sort(),
        ["dir", "id", "preview", "source", "title", "type"],
        `entry shape for ${e.id}`
      );
      assert.ok(["workshop", "mine", "builtin"].includes(e.source), `source for ${e.id}`);
      assert.ok(e.preview.startsWith(TMP), `preview stays inside the fixture (${e.id})`);
    }
  } finally {
    if (saved === undefined) delete process.env.WE_CONFIG;
    else process.env.WE_CONFIG = saved;
  }
});

test("sorts workshop → mine → builtin, then case-insensitively by title", () => {
  const list = listDownloadedWallpapers({ env: { WE_CONFIG: CFG }, system: false });
  assert.deepEqual(
    list.map((e) => `${e.source}:${e.title}`),
    [
      "workshop:amber waves", // lower-cased compare: "amber waves" < "workshop cat"
      "workshop:Workshop Cat",
      "mine:Zeta Mine",
      "builtin:Alpha", // no title → the directory name
      "builtin:beta scene",
    ]
  );
});

test("skips directories with no project.json, no preview, or broken JSON", () => {
  const ids = listDownloadedWallpapers({ env: { WE_CONFIG: CFG }, system: false }).map((e) => e.id);
  assert.ok(!ids.includes("3400000003"), "workshop item without project.json");
  assert.ok(!ids.includes("nopreview"), "project without any usable preview image");
  assert.ok(!ids.includes("broken"), "unparsable project.json");
  assert.ok(!ids.includes("empty"), "builtin dir without project.json");
});

test("dedupes by id, keeping the workshop copy", () => {
  const dup = listDownloadedWallpapers({ env: { WE_CONFIG: CFG }, system: false }).filter(
    (e) => e.id === "3400000001"
  );
  assert.equal(dup.length, 1, "one entry per id");
  assert.equal(dup[0].source, "workshop", "workshop wins the dedup");
});

test("falls back to project.json.file when it is an image, and reads preview.gif", () => {
  const list = listDownloadedWallpapers({ env: { WE_CONFIG: CFG }, system: false });
  const alpha = list.find((e) => e.id === "Alpha");
  assert.equal(alpha.preview, join(DEFAULTS, "Alpha", "park.jpg"), "image wallpaper = its own file");
  assert.equal(alpha.title, "Alpha", "missing title falls back to the directory name");
  assert.equal(alpha.type, "image");
  const beta = list.find((e) => e.id === "beta");
  assert.equal(beta.preview, join(DEFAULTS, "beta", "preview.gif"), "preview.gif is a valid preview");
});

test("findWeRoot takes the WE_CONFIG directory / the derived candidates", () => {
  assert.equal(findWeRoot({ WE_CONFIG: CFG }, { system: false }), resolve(WE));
  assert.equal(findWeRoot({}, { system: false }), null, "no env, no probing → nothing");
});

test("returns [] when Wallpaper Engine cannot be found", () => {
  assert.deepEqual(listDownloadedWallpapers({ env: {}, system: false }), []);
  // `system:false` keeps this hermetic: the developer's real install (reached
  // through the process probe / Steam registry) must never be consulted.
  assert.deepEqual(
    listDownloadedWallpapers({ env: { WE_CONFIG: join(TMP, "nope", "config.json") }, system: false }),
    [],
    "a dead WE_CONFIG never throws"
  );
  assert.deepEqual(
    listDownloadedWallpapers({ env: { ProgramFiles: join(TMP, "nope") }, system: false }),
    [],
    "common install dirs that do not exist contribute nothing"
  );
});

test("a root with config.json but no projects/ or workshop/ lists nothing", () => {
  const bare = join(TMP, "bare-we");
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, "config.json"), "{}");
  assert.deepEqual(
    listDownloadedWallpapers({ env: { WE_CONFIG: join(bare, "config.json") }, system: false }),
    []
  );
});
