/**
 * codex/src/launcher.mjs — locate the Codex desktop app and (re)launch it with
 * a remote debugging port so the wallpaper can be injected over CDP.
 *
 * Codex ships as an MSIX package (OpenAI.Codex) under WindowsApps. That folder
 * is ACL-protected, so we never patch app files — we attach over the Chrome
 * DevTools Protocol instead. The app is single-instance: launching it with a
 * debugging port while an existing non-debug instance runs is swallowed by the
 * single-instance lock, so that instance has to be closed first.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasPageTarget, sleep } from "./cdp.mjs";

/** Run a PowerShell one-liner and return its trimmed stdout. */
function powershell(command, timeout = 15000) {
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  }).trim();
}

/**
 * Locate the MSIX install.
 * @returns {{exe:string|null, install:string, msix:true}|null}
 */
export function findMsixInstall() {
  try {
    const install = powershell("(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation");
    if (!install || !existsSync(install)) return null;
    for (const c of [join(install, "app", "ChatGPT.exe"), join(install, "ChatGPT.exe")]) {
      if (existsSync(c)) return { exe: c, install, msix: true };
    }
    return { exe: null, install, msix: true };
  } catch {
    return null;
  }
}

/**
 * The MSIX AppUserModelId, e.g. "OpenAI.Codex_2p2nqsd0c76g0!App".
 * PackageFamilyName alone is NOT enough for shell:AppsFolder activation —
 * it must be suffixed with "!<Application Id>". Both parts are read at runtime
 * so app updates (which change the version hash) keep working.
 */
export function msixAppUserModelId() {
  try {
    const aumid = powershell(
      "$p = Get-AppxPackage OpenAI.Codex | Select-Object -First 1; " +
        "if ($p) { $id = ($p | Get-AppxPackageManifest).Package.Applications.Application | " +
        "Select-Object -First 1 -ExpandProperty Id; \"$($p.PackageFamilyName)!$id\" }"
    );
    return aumid || null;
  } catch {
    return null;
  }
}

/** How many Codex/ChatGPT processes are running. */
export function codexProcessCount() {
  try {
    const n = powershell(
      "(Get-Process ChatGPT,codex -ErrorAction SilentlyContinue | Measure-Object).Count",
      10000
    );
    return Number(n) || 0;
  } catch {
    return 0;
  }
}

export function isCodexRunning() {
  return codexProcessCount() > 0;
}

/** Force-close every Codex/ChatGPT process. @returns {number} killed count */
export function killCodex() {
  try {
    const n = powershell(
      "$p = Get-Process ChatGPT,codex -ErrorAction SilentlyContinue; " +
        "if ($p) { $p | Stop-Process -Force }; ($p | Measure-Object).Count"
    );
    return Number(n) || 0;
  } catch {
    return 0;
  }
}

async function waitForDebugPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasPageTarget(port)) return true;
    await sleep(400);
  }
  return false;
}

/**
 * Launch the app with a debugging port: direct exe spawn first, then MSIX
 * shell activation as a fallback.
 * @returns {Promise<boolean>} whether a debug endpoint came up
 */
export async function launchWithCdp(port, log = () => {}) {
  const found = findMsixInstall();
  if (!found || !found.exe) throw new Error("Could not locate the Codex desktop executable.");

  log(`[launch] starting ${found.exe} --remote-debugging-port=${port}`);
  const child = spawn(found.exe, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (await waitForDebugPort(port, 20000)) return true;

  const aumid = msixAppUserModelId();
  if (!aumid) {
    log("[launch] direct spawn produced no debug endpoint and no AppUserModelId was found");
    return false;
  }
  log(`[launch] falling back to shell activation: shell:AppsFolder\\${aumid}`);
  try {
    execFileSync("explorer.exe", [`shell:AppsFolder\\${aumid}`], { windowsHide: true, timeout: 10000 });
  } catch {
    /* explorer often returns non-zero even on success */
  }
  return waitForDebugPort(port, 20000);
}

/**
 * Bring up a debuggable instance.
 *
 * @param {number} port
 * @param {{allowKill?:boolean, log?:(m:string)=>void}} [opts]
 * @returns {Promise<{ok:boolean, killed:number, wasRunning:boolean, reason?:string}>}
 */
export async function ensureCdp(port, opts = {}) {
  const log = opts.log || (() => {});
  if (await hasPageTarget(port)) {
    log(`[cdp] :${port} is already debuggable`);
    return { ok: true, killed: 0, wasRunning: true };
  }

  const wasRunning = isCodexRunning();
  let killed = 0;
  if (wasRunning) {
    if (opts.allowKill === false) {
      return {
        ok: false,
        killed: 0,
        wasRunning: true,
        reason:
          "Codex is already running without a debug port; its single-instance lock would swallow " +
          "the new launch. Close it first, or allow the launcher to close it (--kill).",
      };
    }
    log("[launch] closing the running Codex instance (needed to pass the debug port)…");
    killed = killCodex();
    await sleep(1500);
  }

  const ok = await launchWithCdp(port, log);
  return {
    ok,
    killed,
    wasRunning,
    reason: ok ? undefined : "no debug endpoint appeared after launching Codex",
  };
}
