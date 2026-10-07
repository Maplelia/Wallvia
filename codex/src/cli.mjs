#!/usr/bin/env node
/**
 * codex/src/cli.mjs — command-line entry for the Codex desktop wallpaper.
 *
 * Mirrors the Wallpaper Engine wallpaper into the Codex desktop app: it reads the
 * currently active Wallpaper Engine wallpaper (or a fixed image) and injects
 * it into the Codex renderer over CDP with the frosted-glass treatment.
 *
 * Usage:
 *   node cli.mjs status                 show WE wallpaper + CDP reachability
 *   node cli.mjs list [--json]          list downloaded WE wallpapers
 *   node cli.mjs use <#|id>             apply one of them (its preview image)
 *   node cli.mjs follow                 undo a fixed image, follow WE again
 *   node cli.mjs apply [--port N]       inject once (needs CDP endpoint up)
 *   node cli.mjs watch [--port N]       launch Codex w/ CDP, inject, keep it
 *   node cli.mjs stop                   stop the keeper (and its pid file)
 *   node cli.mjs image <path>           set a fixed image path (persisted)
 *   node cli.mjs --help                 usage
 *
 * Requires Node >= 22 (global WebSocket).
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, hasPageTarget, waitForPageTarget } from "./cdp.mjs";
import { ensureCdp, isCodexRunning } from "./launcher.mjs";
import { buildInjectJs, skinVersion } from "./inject.mjs";
import { injectIntoMains, verifySkin } from "./cdp.mjs";
import {
  currentWallpaper,
  findWeConfig,
  findWeRoot,
  listDownloadedWallpapers,
} from "./wallpaper-engine.mjs";
import { FITS, LEGACY_FITS } from "./state.mjs";
import {
  KEEPER_PID,
  loadSettings,
  saveSettings,
  clearSettings,
  resolveWallpaperSource,
} from "./settings.mjs";

// Path to the keeper entry next to this file (fileURLToPath handles Windows
// drive letters and spaces correctly; URL.pathname would give "/E:/my%20dir").
const KEEPER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "keeper.mjs");

async function cmdStatus() {
  const cfg = loadSettings();
  const cfgPath = findWeConfig();
  console.log("[status] Wallpaper Engine config:", cfgPath || "not found");
  const wp = currentWallpaper();
  if (wp) console.log("[status] active WE wallpaper:", wp.pkg, "->", wp.preview);
  else if (cfg.image && existsSync(cfg.image)) console.log("[status] fixed image:", cfg.image);
  else console.log("[status] no wallpaper resolved.");
  console.log(
    "[status] CDP :" + DEFAULT_PORT + " -> " + ((await hasPageTarget(DEFAULT_PORT)) ? "up" : "down")
  );
  console.log("[status] codex running:", isCodexRunning());
}

async function cmdApply(port, opts) {
  if (!(await hasPageTarget(port))) {
    console.error("[apply] CDP endpoint is not up. Use `watch` to launch Codex with the debug port.");
    process.exit(2);
  }
  const resolved = resolveWallpaperSource();
  if (!resolved) {
    console.error("[apply] no wallpaper resolved (Wallpaper Engine not running or no image set).");
    process.exit(2);
  }
  const version = skinVersion(resolved.token, opts);
  const js = buildInjectJs(resolved.dataUrl, opts, version);
  const { applied, targets } = await injectIntoMains(port, js, { log: console.log });
  const check = await verifySkin(port);
  console.log(`[apply] injected into ${applied}/${targets} window(s)`);
  console.log(
    `[apply] verify: ${check.ok ? "OK" : "FAILED"} (version=${check.version || "n/a"})` +
      (check.reason ? " — " + check.reason : "")
  );
  process.exit(check.ok ? 0 : 1);
}

async function cmdWatch(port, opts, flags) {
  const res = await ensureCdp(port, {
    allowKill: flags["no-kill"] ? false : true,
    log: (m) => console.log(m),
  });
  if (!res.ok) {
    console.error("[watch] could not bring up the CDP endpoint: " + (res.reason || "unknown reason"));
    process.exit(1);
  }
  await waitForPageTarget(port, 30000);

  // Running watch twice used to leave an orphan keeper behind (the pid file
  // only ever recorded the newest one, so `stop` could not clean them all) —
  // very easy to hit from a double-click launcher. Replace instead of stack.
  const replaced = stopKeepers();
  if (replaced.length) console.log(`[watch] replaced ${replaced.length} previous keeper(s)`);

  saveSettings({ dim: opts.dim, glass: opts.glass, fit: opts.fit });
  const child = spawn(process.execPath, [KEEPER_ENTRY, String(port), JSON.stringify(opts)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(KEEPER_PID, String(child.pid));
  console.log(`[watch] keeper started (pid ${child.pid}) — wallpaper is now kept in sync.`);
  console.log("[watch] stop it with: node src/cli.mjs stop");
}

/**
 * Kill every running keeper, including orphans the pid file no longer knows
 * about (matched by command line), and clear the pid file.
 * @returns {number[]} pids that were stopped
 */
function stopKeepers() {
  const killed = new Set();

  // 1) the process recorded in the pid file
  try {
    if (existsSync(KEEPER_PID)) {
      const pid = Number(readFileSync(KEEPER_PID, "utf8"));
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid);
          killed.add(pid);
        } catch {
          /* already gone */
        }
      }
      unlinkSync(KEEPER_PID);
    }
  } catch {
    /* ignore */
  }

  // 2) any node process still running our keeper entry (catches orphans)
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
          `Where-Object { $_.CommandLine -like '*${KEEPER_ENTRY}*' } | ` +
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }",
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true }
    );
    for (const line of out.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isFinite(pid) && pid > 0) killed.add(pid);
    }
  } catch {
    /* no stray keepers / powershell unavailable */
  }

  return [...killed];
}

async function cmdStop() {
  const killed = stopKeepers();
  if (killed.length) console.log(`[stop] stopped keeper(s): ${killed.join(", ")}`);
  else console.log("[stop] no keeper was running.");
}

async function cmdImage(path) {
  if (!path) {
    console.error("[image] usage: node cli.mjs image <path-to-image>");
    process.exit(1);
  }
  const abs = resolve(path);
  if (!existsSync(abs)) {
    console.error("[image] file not found:", abs);
    process.exit(1);
  }
  saveSettings({ image: abs });
  console.log("[image] fixed wallpaper set:", abs);
  console.log("[image] (it now wins over the live Wallpaper Engine wallpaper)");
}

// ---- downloaded wallpapers: list / use -----------------------------------

/** Windows paths are case-insensitive; compare them as such. */
function samePath(a, b) {
  if (!a || !b) return false;
  try {
    return resolve(a).toLowerCase() === resolve(b).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Is this listing entry the wallpaper Wallpaper Engine (and therefore Codex) is
 * currently showing? Matched by preview path or by project directory — the
 * directory name *is* the workshop id, which covers the "by id" case too.
 * @param {{id:string,dir:string,preview:string}} entry
 * @param {{pkg:string,preview:string}|null} wp currentWallpaper()
 */
function isCurrentEntry(entry, wp) {
  if (!wp) return false;
  if (samePath(entry.preview, wp.preview)) return true;
  if (wp.pkg) {
    const pkgDir = dirname(wp.pkg);
    if (samePath(entry.dir, pkgDir)) return true;
    if (basename(pkgDir) === entry.id) return true;
  }
  return false;
}

/** The shared "nothing found" explanation (Chinese, per the CLI convention). */
function printNoWeHelp() {
  console.error("未检测到已下载的 Wallpaper Engine 壁纸。");
  console.error(
    "  已按顺序尝试:WE_CONFIG 环境变量 → 运行中的 wallpaper64/wallpaper32 → " +
      "Steam 注册表 → 常见安装目录。"
  );
  console.error("  如果 Wallpaper Engine 装在别处,用 WE_CONFIG 指向它的 config.json,例如:");
  console.error("    set WE_CONFIG=D:\\Steam\\steamapps\\common\\wallpaper_engine\\config.json");
}

/** currentWallpaper() but never fatal (a half-written config.json must not
 *  break the listing — it only costs the `*` marker). */
function tryCurrentWallpaper() {
  try {
    return currentWallpaper();
  } catch {
    return null;
  }
}

async function cmdList(flags) {
  const list = listDownloadedWallpapers();
  if (!list.length) {
    if (flags.json) console.log("[]");
    else printNoWeHelp();
    return;
  }
  const wp = tryCurrentWallpaper();
  const rows = list.map((e, i) => ({ index: i + 1, ...e, active: isCurrentEntry(e, wp) }));

  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const root = findWeRoot();
  console.log(`[list] Wallpaper Engine: ${root || "?"} — 共 ${rows.length} 张已下载壁纸`);
  const numW = String(rows.length).length;
  const titleW = Math.max(5, ...rows.map((r) => r.title.length));
  const typeW = Math.max("[type]".length, ...rows.map((r) => r.type.length + 2));
  const srcW = Math.max("(source)".length, ...rows.map((r) => r.source.length + 2));
  console.log(
    "#".padStart(2 + numW) +
      "  " +
      "title".padEnd(titleW) +
      "  " +
      "[type]".padEnd(typeW) +
      "  " +
      "(source)".padEnd(srcW) +
      "  id"
  );
  for (const r of rows) {
    console.log(
      (r.active ? "*" : " ").padEnd(2) +
        String(r.index).padStart(numW) +
        "  " +
        r.title.padEnd(titleW) +
        "  " +
        `[${r.type}]`.padEnd(typeW) +
        "  " +
        `(${r.source})`.padEnd(srcW) +
        "  " +
        r.id
    );
  }
  console.log("");
  console.log("* = Wallpaper Engine 当前正在使用的那张");
  console.log("用 `wallvia use <编号|id>` 应用其中一张(取静态预览图)。");
  console.log("想回到跟随模式用 `wallvia follow`。");
}

/**
 * `use <#|id>` — apply one downloaded wallpaper to Codex.
 *
 * There is exactly one apply chain in this CLI (`image`: persist a fixed image →
 * resolveWallpaperSource reads + base64-encodes it → CDP inject), so `use`
 * persists the chosen preview and then injects immediately when the CDP
 * endpoint is up.
 */
async function cmdUse(target, port, opts) {
  if (!target) {
    console.error("[use] usage: node cli.mjs use <编号|id>");
    process.exit(1);
  }
  const list = listDownloadedWallpapers();
  if (!list.length) {
    printNoWeHelp();
    process.exit(1);
  }
  // An exact id wins over a numeric position: workshop ids are numbers too.
  let entry = list.find((e) => e.id === target);
  if (!entry && /^\d+$/.test(String(target))) {
    const n = Number(target);
    if (n >= 1 && n <= list.length) entry = list[n - 1];
  }
  if (!entry) {
    console.error(`[use] 找不到壁纸 "${target}" —— 用 \`wallvia list\` 查看编号与 id。`);
    process.exit(1);
  }
  if (!existsSync(entry.preview)) {
    console.error("[use] preview image is missing:", entry.preview);
    process.exit(1);
  }

  saveSettings({ image: entry.preview });
  console.log(`[use] ${entry.title} [${entry.type}] (${entry.source})`);
  console.log(`[use] preview → ${entry.preview}`);
  if (entry.type === "scene" || entry.type === "video") {
    console.log("[use] 注意:scene / video 只能取静态预览帧,WE 的动态内容不会实时注入。");
  }
  console.log("[use] 这会固定这张图(优先于 WE 实时壁纸);想回到跟随模式用 `wallvia follow`。");

  if (!(await hasPageTarget(port))) {
    console.log(
      `[use] Codex 的 CDP :${port} 未开启 —— 已记住该图片,` +
        "启动 `wallvia watch`(或 `wallvia apply`)后生效。"
    );
    return;
  }
  await cmdApply(port, opts); // reads settings.image → data URL → inject + verify
}

/**
 * `follow` — undo a fixed image and go back to mirroring the live Wallpaper
 * Engine wallpaper.
 *
 * `use` / `image` persist `settings.image`, and because a fixed image wins over
 * the live wallpaper that used to be reversible only by hand-editing
 * ~/.wallvia/config.json. This clears it (leaving dim / glass / fit alone) and
 * re-applies the live WE wallpaper when the CDP endpoint is up.
 */
async function cmdFollow(port, opts) {
  const before = loadSettings();
  const hadImage = typeof before.image === "string" && before.image;
  if (hadImage) {
    clearSettings(["image"]);
    console.log("[follow] 已清除固定图片:", before.image);
  } else {
    console.log("[follow] 当前已经是跟随模式(没有固定图片),无需更改。");
  }

  const wp = tryCurrentWallpaper();
  if (!wp) {
    console.log("[follow] 未检测到 Wallpaper Engine 当前壁纸 —— 已回到跟随模式,有壁纸时自动跟随。");
    return;
  }
  console.log("[follow] 跟随中的 WE 壁纸:", wp.pkg, "->", wp.preview);

  if (!(await hasPageTarget(port))) {
    console.log(
      `[follow] Codex 的 CDP :${port} 未开启 —— 启动 \`wallvia watch\`(或 \`wallvia apply\`)后生效。`
    );
    return;
  }
  await cmdApply(port, opts); // no fixed image → resolveWallpaperSource() uses WE
}

// ---- usage ---------------------------------------------------------------
const HELP = `wallvia — mirror a Wallpaper Engine wallpaper into the Codex desktop app.

Usage:
  wallvia status                 show WE wallpaper + CDP reachability
  wallvia list [--json]          list downloaded WE wallpapers (numbered table)
  wallvia use <编号|id>          apply that wallpaper's preview image to Codex
                                 (persists a fixed image — undo with \`wallvia follow\`)
  wallvia follow                 drop the fixed image, follow WE's live wallpaper
  wallvia apply [--port N]       inject once (needs the CDP endpoint up)
  wallvia watch [--port N]       launch Codex w/ CDP, inject, keep it in sync
  wallvia stop                   stop the keeper (and its pid file)
  wallvia image <path>           set a fixed image path (persisted)
  wallvia --help                 this text

Options:
  --port N                CDP port (default ${DEFAULT_PORT})
  --dim 0-80              darkening overlay, higher = more readable (default 22)
  --glass 0-100           panel translucency, 100 = most see-through (default 75)
  --fit cover|fill|center image alignment (default cover)
                          cover  = 覆盖 (background-size: cover)
                          fill   = 填充 (background-size: 100% 100%)
                          center = 居中 (原图尺寸 auto + 居中)
                          legacy contain / tile are still accepted when read
  --json                  (list) print machine-readable JSON
  --no-kill               (watch) refuse to close a running Codex instead

Note: Wallpaper Engine scene / video wallpapers have no frame this tool can
inject live — \`use\` (and the keeper) always take the static preview image
(preview.jpg / preview.png / preview.gif) shipped with the wallpaper.

\`use\` and \`image\` both persist a fixed image, which wins over the live
Wallpaper Engine wallpaper; \`wallvia follow\` clears it again.`;

// ---- arg parsing ---------------------------------------------------------
/** Parse "--key value" / "--flag" pairs. */
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    out[key] = hasValue ? next : true;
    if (hasValue) i++;
  }
  return out;
}

/** First bare (non-flag) argument, skipping "--key value" pairs. */
function positional(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
    return argv[i];
  }
  return undefined;
}

/** A numeric flag with a safe fallback (guards `--dim` with no value). */
function numFlag(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const args = process.argv.slice(2);
const cmd = args[0];
const flags = parseFlags(args.slice(1));

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) {
  console.log(HELP);
  process.exit(0);
}

const port = numFlag(flags.port, DEFAULT_PORT);
const opts = {
  dim: numFlag(flags.dim, 22),
  glass: numFlag(flags.glass, 75),
  fit: fitFlag(flags.fit),
};

/** Validate --fit against the unified vocabulary (plus the legacy values). */
function fitFlag(value) {
  if (typeof value !== "string") return "cover";
  const v = value.toLowerCase();
  if (FITS.includes(v) || LEGACY_FITS.includes(v)) return v;
  console.error(`[fit] unknown value "${value}" — using cover (覆盖).`);
  return "cover";
}

const run = {
  status: cmdStatus,
  list: () => cmdList(flags),
  use: () => cmdUse(positional(args.slice(1)), port, opts),
  follow: () => cmdFollow(port, opts),
  apply: () => cmdApply(port, opts),
  watch: () => cmdWatch(port, opts, flags),
  stop: cmdStop,
  image: () => cmdImage(typeof flags.image === "string" ? flags.image : positional(args.slice(1))),
}[cmd];

if (!run) {
  console.log(
    `Unknown command "${cmd}". Use: status | list | use <#|id> | follow | apply | watch | stop | image <path>\n` +
      `Options: --port N --dim 0-80 --glass 0-100 --fit cover|fill|center [--json] [--no-kill]` +
      `\nSee \`wallvia --help\` for details.`
  );
  process.exit(1);
}
await run();
