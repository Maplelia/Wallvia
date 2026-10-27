/**
 * Wallvia — a one-file loopback media server for video wallpapers.
 *
 * Why this exists: a Wallpaper Engine video lives **outside** the vault, and
 * Obsidian can only serve bytes it owns (`app://`), so `getResourcePath()` is not
 * available for it. The three alternatives all fail:
 *   - copying the file into the vault: a wallpaper video is routinely hundreds of
 *     megabytes, the copy would be synced by the user's vault sync, and the disk
 *     cost is paid twice for a file that never changes;
 *   - `blob:` URL: the whole file has to be in memory first, and Chromium cannot
 *     range-request a Blob — a 400 MB wallpaper would be 400 MB of RAM;
 *   - `file://`: blocked by the renderer's security policy.
 *
 * So the plugin serves that one file itself, over `127.0.0.1`, with Range
 * support. A `<video>` element can then seek, and the first frame arrives after
 * a few hundred kilobytes instead of after the whole file.
 *
 * Security posture, since this is a listening socket:
 *   - binds to `127.0.0.1` only (never `0.0.0.0`), on an OS-assigned port;
 *   - serves **exactly one registered file** — there is no path parameter to
 *     traverse, so no directory can ever be reached;
 *   - every request must carry a per-session random token, so another local
 *     process cannot enumerate what the user is watching;
 *   - `GET`/`HEAD` only, no directory listings, no uploads.
 */

import { Platform } from "obsidian";

/**
 * Structural stand-ins for the Node types this module touches.
 * They are declared here instead of imported from `node:http`: a `import type`
 * still trips the community lint rule (`obsidianmd/no-nodejs-modules`), and the
 * plugin has to stay loadable on mobile where those modules do not exist. The
 * real objects are required lazily below.
 */
interface IncomingMessage {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface ServerResponse {
  writeHead(status: number, headers?: Record<string, string | number>): ServerResponse;
  write(chunk: unknown): boolean;
  end(chunk?: unknown): void;
  once(event: string, cb: () => void): void;
  destroy(): void;
}
interface Server {
  on(event: string, cb: (...args: unknown[]) => void): void;
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number } | string | null;
  close(): void;
}

/** Node's `http` module, required lazily (the plugin must load on mobile). */
interface HttpLike {
  createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

interface FsLike {
  promises: {
    stat(path: string): Promise<{ size: number; mtimeMs: number }>;
    open(path: string, flags: string): Promise<FileHandleLike>;
  };
}

interface FileHandleLike {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

interface NodeLike {
  http: HttpLike;
  fs: FsLike;
  crypto: { randomBytes(n: number): { toString(encoding: string): string } };
  path: { extname(path: string): string };
  /** Node's `Buffer`, used to hand bytes to `res.write`. */
  Buffer: { from(view: Uint8Array): unknown };
}

/**
 * MIME types a video wallpaper can plausibly be. `mkv`/`avi` are deliberately
 * mapped to their real types rather than `video/mp4`: Chromium sniffs, and
 * lying about the container is what makes a decodable file fail.
 */
const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
};

/** Chunk size for streaming; 256 KB is what Chromium asks for in practice. */
const CHUNK = 256 * 1024;

/**
 * Serves exactly one file at a time.
 *
 * `set()` swaps the file (a new wallpaper); the old URL stops working the moment
 * it does, which is deliberate: a stale `<video>` still pointed at the previous
 * wallpaper would keep its decoder alive.
 */
export class VideoServer {
  private server: Server | null = null;
  private port = 0;
  private token = "";
  /** Absolute path of the only file this server will answer for. */
  private file = "";
  private starting: Promise<boolean> | null = null;

  /** True once a socket is listening. */
  get running(): boolean {
    return !!this.server && this.port > 0;
  }

  /**
   * Publish `absPath` and return a URL a `<video>` can load.
   *
   * The failure modes are reported apart, because they need different answers: a
   * file that is gone is the user's to fix (re-pick the wallpaper), a socket that
   * will not bind is this plugin's problem. The first version collapsed both into
   * "端口不可用或文件已被移动", which told the user nothing they could act on.
   *
   * @returns `{url}` on success, `{reason}` otherwise.
   */
  async set(
    absPath: string
  ): Promise<{ url: string } | { reason: "no-node" | "missing" | "no-socket" }> {
    const node = loadNode();
    if (!node) return { reason: "no-node" };
    let stat: { size: number; mtimeMs: number };
    try {
      stat = await node.fs.promises.stat(absPath);
    } catch {
      return { reason: "missing" };
    }
    if (!(stat.size > 0)) return { reason: "missing" };
    const ok = await this.start();
    if (!ok) return { reason: "no-socket" };
    this.file = absPath;
    // `size + mtime` in the query is what makes a replaced file a *different*
    // URL: without it Chromium keeps serving the bytes it already buffered.
    const version = `${stat.size}-${Math.floor(stat.mtimeMs)}`;
    return { url: `http://127.0.0.1:${this.port}/v?t=${this.token}&v=${version}` };
  }

  /**
   * Stop answering and close the socket.
   *
   * There is deliberately no getter for "the URL this server is currently
   * serving": the caller already holds the URL `set()` returned, and a second
   * way to ask for it was dead code that drifted from the real one.
   */
  stop(): void {
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.file = "";
    this.starting = null;
    closeQuietly(server);
  }

  private async start(): Promise<boolean> {
    if (this.running) return true;
    if (this.starting) return this.starting;
    const node = loadNode();
    if (!node) return false;
    this.token = node.crypto.randomBytes(12).toString("hex");
    this.starting = new Promise<boolean>((resolve) => {
      let server: Server;
      try {
        server = node.http.createServer((req, res) => {
          void this.handle(node, req, res);
        });
      } catch {
        resolve(false);
        return;
      }
      server.on("error", () => {
        // A port we cannot bind is not fatal for the rest of the plugin: the
        // caller falls back to the still image and reports it.
        closeQuietly(server);
        resolve(false);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        this.port = address && typeof address === "object" ? address.port : 0;
        this.server = this.port > 0 ? server : null;
        if (!this.server) closeQuietly(server);
        resolve(!!this.server);
      });
    });
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }

  private async handle(node: NodeLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    // Token first: everything else about the request is only meaningful for an
    // authorised caller.
    if (url.searchParams.get("t") !== this.token) {
      res.writeHead(403).end();
      return;
    }
    if (url.pathname !== "/v") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const file = this.file;
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    let size = 0;
    try {
      size = (await node.fs.promises.stat(file)).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const type = MIME[node.path.extname(file).toLowerCase()] || "application/octet-stream";
    const range = parseRange(req.headers.range, size);
    const headers: Record<string, string | number> = {
      "Content-Type": type,
      // Range is the whole point: without `Accept-Ranges` a `<video>` cannot
      // seek, and Chromium falls back to buffering the entire file.
      "Accept-Ranges": "bytes",
      // A wallpaper is not a document: no caching layer may keep the bytes
      // after the file changes, and `no-store` also keeps it out of the HTTP
      // cache that survives a reload.
      "Cache-Control": "no-store",
    };
    if (!range) {
      headers["Content-Length"] = size;
      res.writeHead(200, headers);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      await this.pump(node, file, res, 0, size);
      return;
    }
    if (range === "invalid") {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    headers["Content-Length"] = range.end - range.start + 1;
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    res.writeHead(206, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await this.pump(node, file, res, range.start, range.end - range.start + 1);
  }

  /** Copy `length` bytes from `position` into the response, chunk by chunk. */
  private async pump(
    node: NodeLike,
    file: string,
    res: ServerResponse,
    position: number,
    length: number
  ): Promise<void> {
    let handle: FileHandleLike | null = null;
    try {
      handle = await node.fs.promises.open(file, "r");
      const buffer = new Uint8Array(Math.min(CHUNK, Math.max(1, length)));
      let sent = 0;
      while (sent < length) {
        const want = Math.min(buffer.length, length - sent);
        const { bytesRead } = await handle.read(buffer, 0, want, position + sent);
        if (bytesRead <= 0) break;
        // `end: false` keeps the socket open for the next chunk; backpressure is
        // handled by the response's own buffering, and a stalled client simply
        // makes this loop wait rather than buffering the whole file.
        const chunk = node.Buffer.from(buffer.subarray(0, bytesRead));
        if (!res.write(chunk)) {
          await drained(res);
        }
        sent += bytesRead;
      }
      res.end();
    } catch {
      // Client went away mid-stream (`net::ERR_ABORTED` when the wallpaper is
      // replaced) — nothing to report, and the socket is already closed.
      try {
        res.destroy();
      } catch {
        /* already gone */
      }
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* already closed */
        }
      }
    }
  }
}

/**
 * Resolve when the response can take more bytes, or when the client is gone.
 *
 * Waiting only for `drain` leaks: if the peer closes mid-stream the response is
 * destroyed and `drain` never fires, so the await would hang forever holding the
 * open file handle. `close`/`error` are the two events that end it.
 */
function drained(res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

/** `server.close()` that tolerates an already-closed socket. */
function closeQuietly(server: Server | null): void {
  if (!server) return;
  try {
    server.close();
  } catch {
    /* already closed */
  }
}

/**
 * `bytes=start-end` → inclusive bounds, clamped to the file.
 *
 * @returns `null` when the request has no range, `"invalid"` for a range this
 *   file cannot satisfy (the caller answers 416), or the clamped bounds.
 */
function parseRange(
  header: string | string[] | undefined,
  size: number
): { start: number; end: number } | "invalid" | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(raw).trim());
  if (!match) return "invalid";
  const [, startText, endText] = match;
  if (!startText && !endText) return "invalid";
  let start: number;
  let end: number;
  if (!startText) {
    // `bytes=-N`: the last N bytes.
    const suffix = Number(endText);
    if (!(suffix > 0)) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  if (start >= size || start < 0 || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

let cached: NodeLike | null | undefined;

/**
 * Lazily require Node built-ins.
 *
 * Guarded by `Platform.isDesktop` and wrapped in try/catch, exactly like
 * `wallpaper-engine.ts`: the community lint rules only accept a Node import
 * behind that guard, and a bundle loaded on mobile must not crash — it just gets
 * `null` and the video layer stays down.
 */
function loadNode(): NodeLike | null {
  if (cached !== undefined) return cached;
  if (!Platform.isDesktop) return null;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports, no-undef -- lazy Node built-ins; a static import breaks the mobile bundle */
    const http = require("http") as HttpLike;
    const fs = require("fs") as FsLike;
    const crypto = require("crypto") as NodeLike["crypto"];
    const path = require("path") as NodeLike["path"];
    const buffer = require("buffer") as { Buffer: NodeLike["Buffer"] };
    /* eslint-enable @typescript-eslint/no-require-imports, no-undef -- end of the lazy Node built-in block */
    cached = { http, fs, crypto, path, Buffer: buffer.Buffer };
  } catch {
    cached = null;
  }
  return cached;
}
