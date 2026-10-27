// tests/obsidian-video.cjs — the video wallpaper, end to end through the
// bundled plugin: the loopback media server and the `<video>` layer.
//
// Why these two are tested together: they are one feature. The layer can only
// play a file the server publishes, and the server only matters because a
// `<video>` needs Range requests. Testing either alone would pass while the
// wallpaper stayed a still.
//
// The test drives `plugin.apply()` — not the two modules directly — so the
// wiring in main.ts (which is where "videoPath is set but nothing plays" would
// come from) is covered too.
//
// Run standalone: node tests/obsidian-video.cjs
// Or via:         node tests/run-all.cjs
const { install } = require("./mock-loader.cjs");
install();

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** A file of `size` bytes with a recognisable pattern, outside any vault. */
function makeVideo(size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallvia-video-"));
  const file = path.join(dir, "wallpaper.mp4");
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  fs.writeFileSync(file, bytes);
  return { file, dir, bytes };
}

async function fetchWith(url, init) {
  const res = await fetch(url, init || {});
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}

async function run() {
  const mod = require("../main.js");
  const Plugin = mod && mod.default ? mod.default : mod;
  const { installBodyDom } = require("./mocks/obsidian/dom.js");
  const body = installBodyDom();

  const app = {
    workspace: {
      on: () => ({ evt: {} }),
      onLayoutReady: (cb) => cb(),
      containerEl: {},
    },
    vault: {
      configDir: ".obsidian",
      getFiles: () => [{ path: "Wallpapers/a.png" }],
      getResourcePath: (p) => "app://local/" + encodeURIComponent(p),
      adapter: {
        stat: async () => ({ type: "file", mtime: 123 }),
        getResourcePath: (p) => "app://local/" + encodeURIComponent(p),
        list: async () => ({ files: [], folders: [] }),
        mkdir: async () => undefined,
        writeBinary: async () => undefined,
        remove: async () => undefined,
      },
      on: () => ({ evt: {} }),
    },
  };

  const plugin = new Plugin(app, { id: "wallvia" });
  await plugin.onload();

  const { file, dir, bytes } = makeVideo(1024 * 1024 + 7); // deliberately not round
  plugin.settings.image = "Wallpapers/a.png"; // the decoded frame is the poster
  plugin.settings.videoPath = file;
  plugin.settings.videoWallpaper = true;
  plugin.settings.videoMuted = true;
  await plugin.apply();

  // ------------------------------------------------------------- the layer
  const host = body.querySelector(".wallvia-video-layer");
  assert.ok(host, "apply() puts the video layer behind the workspace");
  const video = host.querySelector("video");
  assert.ok(video, "the layer holds a real <video>, not a background image");
  assert.ok(body.classList.contains("wallvia-video-on"), "body carries the on-class for the css");
  assert.equal(video.muted, true, "starts muted: unmuted autoplay is refused everywhere");
  assert.equal(video.loop, true, "a wallpaper loops");
  assert.equal(video.style.objectFit, "cover", "the fit setting reaches the element");
  assert.ok(
    String(video.poster).includes("a.png"),
    "the decoded still is the poster, so the screen is never empty before frame 1"
  );
  const url = video.src;
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\//.test(url), "the source is the loopback server (the file is outside the vault)");

  // ------------------------------------------------------------ the server
  const bare = url.replace(/[?&]t=[^&]*/, "");
  assert.equal((await fetchWith(bare)).status, 403, "a request without the session token is refused");
  assert.equal(
    (await fetchWith(url.replace("/v?", "/etc/passwd?"))).status,
    404,
    "no other path is reachable: there is no path parameter to traverse"
  );

  const whole = await fetchWith(url);
  assert.equal(whole.status, 200, "a plain GET is 200");
  assert.equal(whole.headers.get("accept-ranges"), "bytes", "Range is advertised, so <video> can seek");
  assert.equal(Number(whole.headers.get("content-length")), bytes.length, "content-length is the file size");
  assert.ok(whole.body.equals(bytes), "the served bytes are the file, byte for byte");
  assert.ok(/no-store/.test(whole.headers.get("cache-control") || ""), "the bytes are not cached");

  const mid = await fetchWith(url, { headers: { Range: "bytes=1000-1099" } });
  assert.equal(mid.status, 206, "a range request is 206");
  assert.ok(mid.body.equals(bytes.subarray(1000, 1100)), "the ranged bytes are the right ones");
  assert.equal(
    mid.headers.get("content-range"),
    `bytes 1000-1099/${bytes.length}`,
    "content-range names the file size"
  );

  const open = await fetchWith(url, { headers: { Range: "bytes=1000000-" } });
  assert.equal(open.status, 206, "an open-ended range is 206");
  assert.ok(open.body.equals(bytes.subarray(1000000)), "an open-ended range runs to EOF");

  const suffix = await fetchWith(url, { headers: { Range: "bytes=-16" } });
  assert.equal(suffix.status, 206, "a suffix range is 206");
  assert.ok(suffix.body.equals(bytes.subarray(bytes.length - 16)), "a suffix range is the last N bytes");

  const past = await fetchWith(url, { headers: { Range: `bytes=${bytes.length + 10}-` } });
  assert.equal(past.status, 416, "a range past EOF is 416, not a crash");

  const head = await fetchWith(url, { method: "HEAD" });
  assert.equal(head.status, 200, "HEAD is answered");
  assert.equal(Number(head.headers.get("content-length")), bytes.length, "HEAD reports the size");
  assert.equal(head.body.byteLength, 0, "HEAD sends no body");

  // ------------------------------------------------- turning it off again
  plugin.settings.videoWallpaper = false;
  await plugin.apply();
  assert.ok(!body.querySelector(".wallvia-video-layer"), "turning playback off removes the layer");
  assert.ok(!body.classList.contains("wallvia-video-on"), "…and the on-class");
  await assert.rejects(fetchWith(url), "…and stops the socket, so the old URL is dead");

  // A still image replaces the video, and the layer must not come back.
  plugin.settings.videoWallpaper = true;
  plugin.settings.videoPath = "";
  await plugin.apply();
  assert.ok(!body.querySelector(".wallvia-video-layer"), "no videoPath means no layer, even with the switch on");

  // -------------------------------------------------------- teardown paths
  plugin.settings.videoPath = file;
  await plugin.apply();
  const liveUrl = body.querySelector(".wallvia-video-layer video").src;
  plugin.onunload();
  assert.ok(!body.querySelector(".wallvia-video-layer"), "onunload() removes the layer");
  await assert.rejects(
    fetchWith(liveUrl),
    "onunload() closes the socket: disabling the plugin must not leave a wallpaper playing"
  );

  // A missing file is reported, not silently a black screen. This needs a fresh
  // plugin: the one above is unloaded, and an unloaded plugin refuses to paint.
  const gone = path.join(dir, "moved-away.mp4");
  const second = new Plugin(app, { id: "wallvia" });
  await second.onload();
  second.settings.image = "Wallpapers/a.png";
  second.settings.videoPath = gone;
  second.lastError = null;
  await second.apply();
  assert.ok(!body.querySelector(".wallvia-video-layer"), "an unreadable video does not create a layer");
  assert.ok(second.lastError, "…and the failure is recorded for the settings page");
  assert.equal(second.lastError.at, "播放视频壁纸", "…under the video-wallpaper label");
  // The message names the actual cause. The first version said "端口不可用或文件
  // 已被移动" for every failure, which is two guesses and no answer.
  assert.ok(
    /视频文件不在了/.test(second.lastError.message),
    "…and says the file is gone, not that the port might be busy"
  );
  assert.ok(
    !/端口/.test(second.lastError.message),
    "…without guessing about the socket it never tried to open"
  );

  // ------------------------------------------- clearing the still stops the video
  // The settings page's 清除 and the panel's 移除 both do exactly this: empty the
  // still. The video has to go with it — the first version left the `<video>`
  // playing behind a workspace that had already dropped its wallpaper class.
  second.settings.videoPath = file;
  await second.apply();
  assert.ok(body.querySelector(".wallvia-video-layer"), "a video is playing again");
  second.settings.image = "";
  await second.apply();
  assert.ok(
    !body.querySelector(".wallvia-video-layer"),
    "clearing the still removes the video layer too"
  );
  assert.ok(!body.classList.contains("wallvia-video-on"), "…and the on-class");
  assert.ok(!body.classList.contains("wallvia-enabled"), "…and the wallpaper class");

  // The same guard covers a caller that forgets to clear `videoPath`: a video
  // with no poster has nothing to show before frame 1, so it must not start.
  second.settings.image = "Wallpapers/a.png";
  second.settings.videoPath = file;
  await second.apply();
  assert.ok(body.querySelector(".wallvia-video-layer"), "restored for the next case");
  second.settings.image = "";
  second.settings.videoPath = file; // deliberately left behind
  await second.apply();
  assert.ok(
    !body.querySelector(".wallvia-video-layer"),
    "a video without a still is not started, even if videoPath is stale"
  );

  second.onunload();

  fs.rmSync(dir, { recursive: true, force: true });

  console.log("OBSIDIAN VIDEO WALLPAPER TEST PASSED");
  console.log(
    "  loopback server: token gate, no other path, byte-exact body, Range/206\n" +
      "  (middle, open-ended, suffix), 416 past EOF, HEAD, no-store — plus the\n" +
      "  <video> layer: poster, muted autoplay, fit, switch-off, and teardown on\n" +
      "  both unload paths."
  );
}

module.exports = run;

if (require.main === module) {
  run().catch((e) => {
    console.error("OBSIDIAN VIDEO TEST FAILED:", e && e.message);
    process.exit(1);
  });
}
