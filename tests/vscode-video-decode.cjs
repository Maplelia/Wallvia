// tests/vscode-video-decode.cjs — the half Node cannot test: does a *real*
// Chromium bucket actually turn a Wallpaper Engine video into a 16:9 frame?
//
// The extension hands `decodeFrame` to the picker's webview and the webview
// answers with a JPEG payload; everything after that (cache, card, pill,
// apply) is covered by `vscode-video-frame.cjs` and `vscode-smoke.cjs`. This
// test runs the shipped function itself — extracted from `extension.js` by
// brace matching, so it cannot drift from what ships — inside a real headless
// Chromium against a real wallpaper from this machine's WE library.
//
// It also pins the two things a user notices: the frame keeps the video's
// aspect ratio (never the square preview's) and it carries real pixels.
//
// Skips (exit 0) when no Chromium or no WE video is available.
//
// Run standalone: node tests/vscode-video-decode.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** The project's CDP client, loaded lazily — this file is CommonJS. */
let CdpSession = null;

const ROOT = path.join(__dirname, "..");

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** The shipped `decodeFrame`, straight out of the extension source. */
function shippedDecodeFrame() {
  const source = fs.readFileSync(path.join(ROOT, "vscode", "src", "extension.js"), "utf8");
  const start = source.indexOf("async function decodeFrame(url, width) {");
  assert.ok(start >= 0, "the picker still defines decodeFrame");
  let depth = 0;
  let i = source.indexOf("{", start);
  const from = i;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unterminated decodeFrame at " + from);
}

/**
 * The picker page's own Content-Security-Policy, from the shipped template.
 *
 * This is the half that broke in the field: without `media-src` the webview
 * refuses to load the video at all, the decode fails, and every video card sits
 * on its placeholder — so the probe page below is written with this exact policy
 * rather than a permissive one.
 */
function shippedPickerCsp() {
  const source = fs.readFileSync(path.join(ROOT, "vscode", "src", "extension.js"), "utf8");
  // The content itself contains `${cspSource || ""}`, so the match has to run to
  // the closing quote-plus-slash rather than to the next quote.
  const metas = [...source.matchAll(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)"\s*\/>/g)];
  assert.ok(metas.length, "the picker still declares a CSP");
  const picker = metas.map((m) => m[1]).find((c) => /img-src/.test(c));
  assert.ok(picker, "the picker's CSP is the one that allows images");
  assert.ok(
    /media-src/.test(picker),
    "the picker's CSP must allow media-src, or no video can load: " + picker
  );
  // The template's `${cspSource || ""}` only exists at runtime; for a local page
  // the file: scheme stands in for it.
  return picker.replace(/\$\{cspSource \|\| ""\}/g, "file:");
}

/** A real video wallpaper from the machine's Wallpaper Engine library. */
function findWeVideo() {
  const roots = [
    "D:/Steam/steamapps/workshop/content/431960",
    "C:/Program Files (x86)/Steam/steamapps/workshop/content/431960",
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      let project;
      try {
        project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
      } catch {
        continue;
      }
      if (!project.file || !/\.(mp4|webm|mov|mkv)$/i.test(project.file)) continue;
      const file = path.join(dir, project.file);
      if (fs.existsSync(file)) return { file, title: String(project.title || id) };
    }
  }
  return null;
}

/** JPEG dimensions from the SOF marker. */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

async function main() {
  ({ CdpSession } = await import("../codex/src/cdp.mjs"));
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  if (!browser) {
    console.log("VSCODE VIDEO DECODE TEST SKIPPED: no Chromium browser found");
    return;
  }
  const video = findWeVideo();
  if (!video) {
    console.log("VSCODE VIDEO DECODE TEST SKIPPED: no Wallpaper Engine video on this machine");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-decode-"));
  // The same page twice: with the picker's real CSP, and with `media-src`
  // stripped. The second one is what shipped by accident and left a whole grid
  // of video cards on their placeholder forever, so it is pinned here.
  const pages = {
    good: path.join(dir, "probe.html"),
    noMedia: path.join(dir, "probe-no-media.html"),
  };
  const csp = shippedPickerCsp();
  const decodeFrameSource = shippedDecodeFrame();
  const pageHtml = (policy) =>
    `<!DOCTYPE html><html><head><meta charset="utf-8">
     <meta http-equiv="Content-Security-Policy" content="${policy}">
     </head><body>
     <script>${decodeFrameSource}</script>
     </body></html>`;
  fs.writeFileSync(pages.good, pageHtml(csp));
  // The negative page gets a policy built from scratch rather than the shipped
  // one with a directive cut out: editing the string can leave something
  // Chromium parses as invalid, and an unparsable policy blocks nothing.
  fs.writeFileSync(
    pages.noMedia,
    pageHtml("default-src 'none'; img-src data:; script-src 'unsafe-inline';")
  );

  const videoUrl =
    "file:///" + video.file.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");

  let launched = null;
  const cleanup = async () => {
    try {
      if (launched && !launched.killed) launched.kill();
    } catch {
      /* ignore */
    }
    // The browser keeps its profile directory open for a moment after the kill
    // signal; removing it before then fails with EPERM on Windows.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        /* still held — retry */
      }
    }
  };

  /**
   * Open one page in a fresh browser and run the shipped decoder in it.
   *
   * The video is outside the page's origin, so `--allow-file-access-from-files`
   * stands in for what `localResourceRoots` + `asWebviewUri` do in a webview.
   */
  const decodeOn = async (pagePath, port) => {
    launched = spawn(
      browser,
      [
        `--remote-debugging-port=${port}`,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--allow-file-access-from-files",
        `--user-data-dir=${path.join(dir, "profile-" + port)}`,
        "file:///" + pagePath.replace(/\\/g, "/"),
      ],
      { stdio: "ignore" }
    );
    const ws = await waitForProbe(port, 20000, path.basename(pagePath));
    const session = new CdpSession(ws.url, { timeoutMs: 60000 });
    await session.connect();
    await session.send("Runtime.enable");
    const out = await session.evaluate(
      `(async () => await decodeFrame(${JSON.stringify(videoUrl)}, 960))()`
    );
    session.close();
    try {
      launched.kill();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 500));
    return out;
  };

  try {
    const frame = await decodeOn(pages.good, 9457);
    const blocked = await decodeOn(pages.noMedia, 9458);
    assert.equal(blocked, null, "without media-src the video cannot be loaded at all");

    assert.ok(frame, "a real Chromium decoded a frame from " + path.basename(video.file));
    const bytes = Buffer.from(frame, "base64");
    const size = jpegSize(bytes);
    assert.ok(size, "the payload is a JPEG");
    assert.equal(size.width, 960, "the frame is decoded at the requested width");
    assert.ok(bytes.length > 20000, `the frame carries real pixels (${bytes.length} bytes)`);
    assert.ok(
      Math.abs(size.width / size.height - 16 / 9) < 0.05,
      `the frame keeps the video's 16:9 shape (got ${size.width}x${size.height})`
    );

    console.log("VSCODE VIDEO DECODE TEST PASSED");
    console.log(`  real Chromium, real wallpaper: ${video.title}`);
    console.log(
      `  ${path.basename(video.file)} -> ${size.width}x${size.height} JPEG, ${Math.round(bytes.length / 1024)} KB`
    );
    console.log("  …and under the picker's own CSP, without which it returns nothing.");
  } finally {
    await cleanup();
  }
}

/** `/json` polling without the Codex-specific page matcher. */
async function waitForProbe(port, timeoutMs, pageName) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      const hit = list.find((t) => t.type === "page" && (t.url || "").includes(pageName));
      if (hit && hit.webSocketDebuggerUrl) return { url: hit.webSocketDebuggerUrl };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the probe page never appeared on the debug port");
}

module.exports = main;
if (require.main === module) {
  main().catch((e) => {
    console.error("VSCODE VIDEO DECODE FAILED: " + ((e && e.message) || e));
    process.exit(1);
  });
}
