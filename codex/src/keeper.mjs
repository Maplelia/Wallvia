/**
 * codex/src/keeper.mjs — background process that keeps the wallpaper injected
 * into the Codex desktop app.
 *
 * Runtime-injected styles are wiped by window reloads / renderer swaps, and
 * the app does not keep Page.addScriptToEvaluateOnNewDocument across a
 * renderer replacement. So every ~1.5s we poll the CDP endpoint, and for each
 * main window re-inject the wallpaper <style> when its version token changed
 * (either because the window reloaded or because the wallpaper file changed).
 *
 * Exits on its own when the CDP endpoint disappears (app closed) after a
 * short grace period.
 */
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { listTargets, mainTargets, CdpSession, sleep, DEFAULT_PORT } from "./cdp.mjs";
import { buildInjectJs, skinVersion } from "./inject.mjs";
import { resolveWallpaperSource } from "./settings.mjs";

const POLL_MS = 1500;
const GRACE_MS = 60000; // after endpoint disappears, give up
const FIRST_BOOT_GRACE_MS = 90000;

/**
 * @param {number} port
 * @param {{dim:number, glass:number, fit:string}} opts
 * @param {(m:string)=>void} [log]
 */
export async function runKeeper(port, opts = {}, log = console.log) {
  let totalGrace = 0;
  let firstBoot = true;
  const sessions = new Map(); // wsUrl -> CdpSession

  log(`[keeper] watching Codex CDP on :${port} every ${POLL_MS}ms`);

  while (true) {
    let targets = [];
    try {
      targets = mainTargets(await listTargets(port));
      totalGrace = 0;
    } catch {
      // endpoint gone — maybe app closed. Grace before exiting.
      totalGrace += POLL_MS;
      if (totalGrace > GRACE_MS) break;
      if (firstBoot && totalGrace > FIRST_BOOT_GRACE_MS) break;
      await sleep(POLL_MS);
      continue;
    }
    firstBoot = false;

    // current wallpaper: a fixed image from settings wins, otherwise the live
    // Wallpaper Engine wallpaper
    const wp = resolveWallpaperSource();
    if (!wp) {
      log("[keeper] no wallpaper resolved; waiting");
      await sleep(POLL_MS);
      continue;
    }
    // The effective token covers both the wallpaper image and the CSS shape
    // (dim/glass/fit), so an option change or an update to inject.mjs also
    // triggers a rewrite — otherwise the window would keep stale CSS.
    const version = skinVersion(wp.token, opts);
    const js = buildInjectJs(wp.dataUrl, opts, version);

    for (const target of targets) {
      let session = sessions.get(target.webSocketDebuggerUrl);
      if (!session || session.closed) {
        try {
          session = new CdpSession(target.webSocketDebuggerUrl);
          await session.connect();
          sessions.set(target.webSocketDebuggerUrl, session);
        } catch {
          continue;
        }
      }
      try {
        const cur = await session.evaluate(
          `(document.getElementById('wallvia-skin')||{}).dataset?.wallviaVersion||''`
        );
        if (cur !== version) {
          await session.evaluate(js);
          log(`[keeper] injected/re-injected for ${target.id} (v=${version})`);
        }
      } catch {
        session.close();
        sessions.delete(target.webSocketDebuggerUrl);
      }
    }

    // close sessions for targets that disappeared
    for (const [url, s] of sessions) {
      if (!targets.find((t) => t.webSocketDebuggerUrl === url)) {
        s.close();
        sessions.delete(url);
      }
    }

    await sleep(POLL_MS);
  }

  for (const s of sessions.values()) s.close();
  log("[keeper] exiting (endpoint gone)");
}

// ---- standalone entry ----------------------------------------------------
// Spawned as a detached child by `cli.mjs watch`:
//   node keeper.mjs <port> '{"dim":22,"glass":62,"fit":"cover"}'
const selfPath = fileURLToPath(import.meta.url);
const invokedDirectly =
  process.argv[1] &&
  resolvePath(process.argv[1]).toLowerCase() === resolvePath(selfPath).toLowerCase();

if (invokedDirectly) {
  const [portArg, optsJson] = process.argv.slice(2);
  let opts = {};
  try {
    opts = optsJson ? JSON.parse(optsJson) : {};
  } catch {
    console.error("[keeper] ignoring unparsable options:", optsJson);
  }
  runKeeper(Number(portArg) || DEFAULT_PORT, opts)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[keeper] fatal:", e && e.message);
      process.exit(1);
    });
}
