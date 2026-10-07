/**
 * codex/src/cdp.mjs — talk to a Chromium renderer over the loopback Chrome
 * DevTools Protocol; used to inject the wallpaper CSS into the Codex desktop
 * app.
 *
 * Requires Node >= 22 (global WebSocket). The Codex renderer blocks file://
 * images, so the wallpaper is always a data: URL.
 *
 * The target matcher defaults to "Codex main windows" but can be overridden,
 * which is what the test suite uses to exercise the real inject/verify
 * pipeline against a plain Chromium page.
 */

export const DEFAULT_PORT = 9333;

/** Default matcher: Codex main windows (app:// pages, no avatar overlay). */
export function isCodexMainWindow(t) {
  return (
    t.type === "page" &&
    typeof t.url === "string" &&
    t.url.startsWith("app://") &&
    !t.url.includes("avatar-overlay")
  );
}

/**
 * GET http://127.0.0.1:<port>/json — every debuggable target.
 * @returns {Promise<Array<{id:string,type:string,url:string,webSocketDebuggerUrl:string}>>}
 */
export async function listTargets(port = DEFAULT_PORT) {
  const r = await fetch(`http://127.0.0.1:${port}/json`);
  if (!r.ok) throw new Error(`CDP /json -> HTTP ${r.status}`);
  return r.json();
}

/** Filter a target list down to the windows we should paint. */
export function mainTargets(list, match = isCodexMainWindow) {
  return (list || []).filter(match);
}

/** Is a debuggable endpoint with at least one matching window already up? */
export async function hasPageTarget(port = DEFAULT_PORT, match = isCodexMainWindow) {
  try {
    return mainTargets(await listTargets(port), match).length > 0;
  } catch {
    return false;
  }
}

/** Wait up to `timeoutMs` for at least one matching window. */
export async function waitForPageTarget(port = DEFAULT_PORT, timeoutMs = 30000, match = isCodexMainWindow) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const mains = mainTargets(await listTargets(port), match);
      if (mains.length) return mains;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return [];
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One WebSocket-backed CDP session against a target. */
export class CdpSession {
  /**
   * @param {string} wsUrl webSocketDebuggerUrl of the target
   * @param {{timeoutMs?:number}} [opts] per-request timeout (default 10s)
   */
  constructor(wsUrl, opts = {}) {
    this.wsUrl = wsUrl;
    this.timeoutMs = opts.timeoutMs || 10000;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
  }

  async connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws connect timeout")), this.timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("ws connect failed"));
      };
    });
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const entry = msg.id ? this.pending.get(msg.id) : null;
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || "cdp error"));
      else entry.resolve(msg.result);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("cdp closed"));
      }
      this.pending.clear();
    };
    return this;
  }

  /** Send a CDP command. Rejects on error or after `timeoutMs`. */
  send(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error("cdp session closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page; returns the value (or null). */
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res && res.result ? res.result.value : null;
  }

  close() {
    try {
      if (this.ws) this.ws.close();
    } catch {
      /* noop */
    }
    this.closed = true;
  }
}

/** Open a session to a target and run `fn(session)`, always closing it. */
export async function withTarget(target, fn) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  try {
    await session.connect();
    return await fn(session);
  } finally {
    session.close();
  }
}

/**
 * Inject `js` into every matching window.
 * @param {number} port
 * @param {string} js
 * @param {{log?:(m:string)=>void, match?:(t:object)=>boolean}} [opts]
 * @returns {Promise<{applied:number, targets:number}>}
 */
export async function injectIntoMains(port, js, opts = {}) {
  const { log = () => {}, match = isCodexMainWindow } = opts;
  const targets = mainTargets(await listTargets(port), match);
  let applied = 0;
  for (const target of targets) {
    try {
      const r = await withTarget(target, (s) => s.evaluate(js));
      if (r && r.ok) applied++;
      else log(`[cdp] target ${target.id} did not confirm injection`);
    } catch (e) {
      log(`[cdp] inject failed for ${target.id}: ${e.message}`);
    }
  }
  return { applied, targets: targets.length };
}

/**
 * Check whether the wallpaper is actually painted in a window.
 *
 * The CSS paints the image on `body::before`, so checking
 * `getComputedStyle(body).backgroundImage` would always say "none". Instead we
 * look for our own <style> element plus the version it recorded, and confirm
 * the pseudo-element carries a background image.
 *
 * @returns {Promise<{ok:boolean, found:boolean, version:string,
 *                    background:string, reason?:string}>}
 */
export async function verifySkin(port, match = isCodexMainWindow) {
  const result = { ok: false, found: false, version: "", background: "", reason: "" };
  let targets;
  try {
    targets = mainTargets(await listTargets(port), match);
  } catch (e) {
    result.reason = "no debug endpoint: " + e.message;
    return result;
  }
  if (!targets.length) {
    result.reason = "no matching window";
    return result;
  }
  try {
    const probe = await withTarget(targets[0], (s) =>
      s.evaluate(`(() => {
        const el = document.getElementById("wallvia-skin");
        const before = getComputedStyle(document.body, "::before").backgroundImage || "none";
        return {
          found: !!el,
          version: el ? (el.dataset.wallviaVersion || "") : "",
          background: before,
        };
      })()`)
    );
    if (!probe || !probe.found) {
      result.reason = "wallpaper <style> not present";
      return result;
    }
    result.found = true;
    result.version = probe.version || "";
    result.background = probe.background || "none";
    result.ok = result.background.startsWith("url(");
    if (!result.ok) result.reason = "body::before has no background image";
    return result;
  } catch (e) {
    result.reason = "probe failed: " + e.message;
    return result;
  }
}
