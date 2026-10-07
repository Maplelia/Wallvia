// tests/codex-cli-follow.mjs — the `use` / `image` → `follow` round trip.
//
// `use` and `image` persist a fixed image in ~/.wallvia/config.json, which wins
// over the live Wallpaper Engine wallpaper; `follow` must clear exactly that
// key (leaving dim / glass / fit alone) and go back to following WE.
//
// The CLI is spawned as a child process with a throwaway USERPROFILE, so the
// developer's real ~/.wallvia/config.json is never touched, and with a dead
// CDP port (--port 1) so nothing is ever injected into a running Codex.
//
// Run: node --test tests/codex-cli-follow.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "codex", "src", "cli.mjs");
// NOTE: the prefix must not contain the word "follow" — the fixture paths are
// echoed by the CLI, and a substring check on the output would then pass for
// the wrong reason.
const TMP = mkdtempSync(join(tmpdir(), "wallvia-cli-"));
const HOME = join(TMP, "home");
const WE = join(TMP, "we");
const DEMO = join(WE, "projects", "myprojects", "demo");
const CFG = join(WE, "config.json");
const PREVIEW = join(DEMO, "preview.jpg");
const SCENE = join(DEMO, "scene.pkg");
const SETTINGS = join(HOME, ".wallvia", "config.json");

/** A port nothing listens on: hasPageTarget() fails → the CLI only persists. */
const DEAD_PORT = "1";

// ---- fixture: a fake WE install (one myproject, selected as the active one) --
mkdirSync(DEMO, { recursive: true });
writeFileSync(
  join(DEMO, "preview.jpg"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64"
  )
);
writeFileSync(SCENE, Buffer.from("pkg"));
writeFileSync(join(DEMO, "project.json"), JSON.stringify({ title: "Demo WP", type: "scene" }));
writeFileSync(
  CFG,
  JSON.stringify({
    "?installdirectory": WE,
    tester: {
      general: { wallpaperconfig: { selectedwallpapers: { Monitor0: { file: SCENE } } } },
    },
  })
);

after(() => rmSync(TMP, { recursive: true, force: true }));

// ---- helpers -------------------------------------------------------------
function seedSettings(obj) {
  mkdirSync(join(HOME, ".wallvia"), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(obj, null, 2));
}

function runCli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, USERPROFILE: HOME, WE_CONFIG: CFG },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function readSettings() {
  return JSON.parse(readFileSync(SETTINGS, "utf8"));
}

// ---- tests ---------------------------------------------------------------
test("use persists a fixed image and follow clears only that key", () => {
  seedSettings({ dim: 30, glass: 80, fit: "fill" });

  const used = runCli("use", "1", "--port", DEAD_PORT);
  assert.equal(used.code, 0, `use should succeed:\n${used.out}`);
  assert.ok(used.out.includes(PREVIEW), "use reports the chosen preview image");
  assert.ok(
    used.out.includes("想回到跟随模式用 `wallvia follow`"),
    "use points at `wallvia follow` as the undo"
  );

  const afterUse = readSettings();
  assert.equal(afterUse.image, PREVIEW, "use persists the fixed image");
  assert.equal(afterUse.dim, 30, "use keeps dim");
  assert.equal(afterUse.glass, 80, "use keeps glass");
  assert.equal(afterUse.fit, "fill", "use keeps fit");

  const followed = runCli("follow", "--port", DEAD_PORT);
  assert.equal(followed.code, 0, `follow should succeed:\n${followed.out}`);
  assert.ok(followed.out.includes("[follow] 已清除固定图片"), "follow says what it cleared");
  assert.ok(followed.out.includes("跟随中的 WE 壁纸"), "follow resolves the live WE wallpaper");
  assert.ok(followed.out.includes(PREVIEW), "…and it is the fixture's preview image");
  assert.ok(followed.out.includes(`CDP :${DEAD_PORT} 未开启`), "follow hints when CDP is down");
  assert.ok(followed.out.includes("wallvia watch"), "…naming the command that applies it");

  const afterFollow = readSettings();
  assert.ok(!("image" in afterFollow), "follow removed the fixed image");
  assert.deepEqual(
    afterFollow,
    { dim: 30, glass: 80, fit: "fill" },
    "follow left every other setting untouched"
  );
});

test("follow also undoes a fixed image set with `image`", () => {
  seedSettings({ dim: 22, glass: 75, fit: "cover" });

  const set = runCli("image", PREVIEW);
  assert.equal(set.code, 0, `image should succeed:\n${set.out}`);
  assert.equal(readSettings().image, PREVIEW, "image persists the fixed image");

  const followed = runCli("follow", "--port", DEAD_PORT);
  assert.equal(followed.code, 0, `follow should succeed:\n${followed.out}`);
  assert.deepEqual(readSettings(), { dim: 22, glass: 75, fit: "cover" });
});

test("follow without a fixed image reports the mode and does not fail", () => {
  const seed = { dim: 22, glass: 75, fit: "center" };
  seedSettings(seed);

  const followed = runCli("follow", "--port", DEAD_PORT);
  assert.equal(followed.code, 0, "no fixed image is not an error");
  assert.ok(followed.out.includes("当前已经是跟随模式"), "it says the mode is already follow");
  assert.deepEqual(readSettings(), seed, "settings are left exactly as they were");
});

test("help and list advertise follow", () => {
  const help = runCli("--help");
  assert.equal(help.code, 0);
  assert.ok(help.out.includes("wallvia follow"), "--help lists the follow command");
  assert.ok(help.out.includes("undo with `wallvia follow`"), "--help ties use to follow");

  const list = runCli("list", "--port", DEAD_PORT);
  assert.equal(list.code, 0, `list should succeed:\n${list.out}`);
  assert.ok(list.out.includes("想回到跟随模式用 `wallvia follow`"), "list footer mentions follow");
});
