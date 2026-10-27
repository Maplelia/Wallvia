/**
 * Wallvia — Obsidian plugin.
 *
 * Wallpaper + frosted-glass feature:
 * pick a local image, it becomes the workspace background behind translucent
 * surfaces (frosted glass), with a dim layer for readability.
 *
 * No "setBackground" API exists; the plugin injects CSS and updates CSS
 * variables at runtime (per the research in docs/obsidian-调研报告.md):
 *   - styles.css (auto-loaded) defines the structure + surface selectors
 *   - main.ts writes the dynamic values (image url, opacity, dim, blur)
 *     into CSS variables on document.body.
 * The image is copied into the vault (Wallpapers/) so animated themes and
 * reloads keep working; data.json only stores the vault-relative path.
 *
 * "Choose from Wallpaper Engine" lists the Wallpaper Engine wallpapers already
 * downloaded on this machine (obsidian/wallpaper-engine.ts) and copies the chosen
 * preview image into the vault, so the user does not have to find the file by
 * hand. Windows desktop only; the entry points hide themselves elsewhere.
 */
import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  SettingGroupItem,
  TFile,
  normalizePath,
  requireApiVersion,
} from "obsidian";
import {
  WeSourceSize,
  WeStill,
  WeWallpaper,
  fileExtension,
  findWeRoot,
  getCurrentWeWallpapers,
  isWallpaperEngineSupported,
  listWeWallpapers,
  readImageArrayBuffer,
  readSceneHiResImage,
  readVideoFrame,
  resolveStillAssets,
  resolveSourceSize,
  videoFileOf,
  writeVideoFrame,
} from "./wallpaper-engine";
import { WallpaperPanel, PanelHost } from "./panel";
import { VideoServer } from "./video-server";
import { VideoWallpaperLayer } from "./video-layer";
import {
  DEFAULTS,
  DESCS,
  FIT_CSS,
  FIT_OPTIONS,
  LABELS,
  MAX_IMAGE_WIDTH,
  WASH_OPTIONS,
  WPSettings,
  WPWash,
  clamp,
  embedOpacity,
  glassFill,
  migrateGlass,
  normalizeFit,
  resetEffects,
  washRgb,
} from "./settings";

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

/** Prefix of every file the Wallpaper Engine picker writes into the vault. */
const WE_CACHE_PREFIX = "wallvia-we-";

/**
 * Wallpaper Engine is a proper noun, but the repo's `ui/sentence-case` rule
 * (which cannot be reconfigured from `src/`) wants it lowercased. The strings
 * below are user-visible names that must keep the official spelling, so they
 * live in constants.
 */
const WE_NAME = "Wallpaper Engine";
const WE_COMMAND_NAME = "Choose from Wallpaper Engine";
const WE_PICK_BUTTON = "从 Wallpaper Engine 选择…";
const WE_MISSING_NOTICE = "未检测到 Wallpaper Engine(仅 Windows 桌面端)";
const WE_MODAL_TITLE = "Wallpaper Engine 壁纸";
const WE_MODAL_SEARCH = "搜索壁纸标题…";
const WE_CARD_APPLY = "应用";
const WE_CARD_CURRENT = "当前";
const WE_PICK_DESC = "把 Wallpaper Engine 的预览图复制到 vault 并使用。";

/**
 * Where a wallpaper came from, spelled the way the VS Code port spells it so
 * the two pickers read the same.
 */
const WE_SOURCE_LABEL: Record<string, string> = {
  workshop: "创意工坊",
  mine: "我的项目",
  builtin: "内置",
  external: "外部",
};

/** Longest edge below which a wallpaper stops looking like a wallpaper once it is
 * stretched over a whole window. 1280 is the usual laptop panel width, so
 * anything under it is visibly soft and the picker says so.
 */
const SHARP_ENOUGH = 1280;

/** Cards read the moment the grid opens: roughly its first screenful. */
const EAGER_CARDS = 12;
/** How far outside the grid a card may sit and still be read ahead of time. */
const PREFETCH_MARGIN = 250;

export default class WallpaperPlugin extends Plugin {
  settings: WPSettings = { ...DEFAULTS };
  imageUrl = "";
  private panelInstance: WallpaperPanel | null = null;
  /** Pending coalesced apply, set while the layout event burst is settling. */
  private applyTimer: number | null = null;
  /**
   * Last resolved image: `apply()` runs on every layout change, and each run
   * used to `stat()` the file again. The URL only has to be rebuilt when the
   * path changes or the vault says the file did.
   */
  private resolved: { path: string; url: string } | null = null;

  /**
   * Set by `onunload()`, checked after every `await` in the async paths.
   *
   * Disabling the plugin unregisters its events immediately, but an in-flight
   * scene decode or video seek keeps running. Without this flag it finished by
   * re-adding the classes and CSS variables to `document.body`, so the
   * wallpaper stayed *after* the plugin was disabled — and only a restart could
   * remove it.
   */
  private unloaded = false;

  /**
   * Bumped by every `apply()`. A slower run started earlier must not paint over
   * a newer one (two layout events plus a theme change can overlap).
   */
  private applySeq = 0;

  /**
   * The last swallowed failure, shown on the settings page. Everything that is
   * allowed to fail softly still has to end up somewhere the user can see it:
   * "nothing happened" was the symptom of the old bare `catch {}`.
   */
  lastError: { at: string; message: string; when: number } | null = null;

  /**
   * The playing video, when the current wallpaper is a video and playback is
   * enabled. Created on first use; destroyed on unload and when the wallpaper
   * changes to a still.
   */
  private videoLayer = new VideoWallpaperLayer();
  /**
   * Loopback server for the video file, which lives outside the vault and so
   * cannot be served through `app://`.
   */
  private videoServer = new VideoServer();

  /** Record a non-fatal failure instead of losing it. */
  reportError(at: string, e: unknown): void {
    this.lastError = { at, message: errorMessage(e), when: Date.now() };
    console.debug(`[wallvia] ${at}: ${errorMessage(e)}`);
    this.panelInstance?.refresh();
  }

  /**
   * Remove the stills 1.0.x left in the vault's `Wallpapers/` folder.
   *
   * Only files with our own prefix are touched, and only when the saved cache
   * setting was still the old default — a user who deliberately kept that
   * folder visible keeps it.
   */
  private async clearLegacyCache(dir: string): Promise<void> {
    try {
      const listed = await this.app.vault.adapter.list(dir);
      for (const file of listed.files) {
        const name = file.slice(file.lastIndexOf("/") + 1);
        if (!name.startsWith(WE_CACHE_PREFIX)) continue;
        await this.app.vault.adapter.remove(file);
      }
    } catch {
      // A folder that does not exist is the normal case on a fresh install, so
      // this cleanup stays quiet on purpose — there is nothing to report when
      // there is nothing to clean.
    }
  }

  /**
   * The in-app panel (dsh-web-all's floating button + controls). Built on
   * first use.
   */
  private get panel(): WallpaperPanel {
    if (!this.panelInstance) this.panelInstance = new WallpaperPanel(new PluginPanelHost(this));
    return this.panelInstance;
  }

  async onload() {
    const saved = (await this.loadData()) as Partial<WPSettings> | null;
    this.settings = Object.assign({}, DEFAULTS, saved ?? {});
    // Migrations: old data.json may still say "contain"/"tile", and 0.2.1
    // stored the boolean glassEditors switch that became the 0-100 Glass
    // level.
    this.settings.fit = normalizeFit(this.settings.fit);
    this.settings.glass = migrateGlass(saved);
    delete this.settings.glassEditors;
    // 1.0.x copied stills into `Wallpapers/` at the vault root, which the file
    // explorer lists. The default is now the plugin's private cache folder, so
    // a saved value that is exactly the old default means "never touched" —
    // migrate it and drop the files it left behind (only our own prefix).
    if (saved?.weCacheDir === "Wallpapers") {
      this.settings.weCacheDir = "";
      void this.clearLegacyCache("Wallpapers");
    }

    this.registerEvent(this.app.workspace.on("css-change", () => this.scheduleApply()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleApply()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleApply()));

    // Keep the stored path in sync if the user renames/moves the image, and
    // drop the cached URL whenever the file itself changes.
    this.registerEvent(
      this.app.vault.on("modify", (f: TFile) => {
        if (f.path === this.settings.image) this.invalidateImage();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (f: TFile, oldPath: string) => {
        if (oldPath === this.settings.image) {
          this.settings.image = f.path;
          this.invalidateImage();
          void this.saveSettings();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (f: TFile) => {
        if (f.path === this.settings.image) {
          this.settings.image = "";
          // The poster is gone; the moving layer has nothing to fall back on and
          // must go too, or it keeps playing behind a blank workspace.
          this.settings.videoPath = "";
          this.invalidateImage();
          void this.apply();
          void this.saveSettings();
        }
      })
    );

    this.addSettingTab(new WallpaperSettingTab(this.app, this));
    this.addCommand({
      id: "open-panel",
      name: "Open wallpaper panel",
      callback: () => this.panel.openPanel(),
    });
    this.addCommand({
      id: "toggle-wallpaper",
      name: "Toggle wallpaper (master switch)",
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        void this.apply();
        void this.saveSettings();
        this.panel.refresh();
        // Without this the command looked like it did nothing: the wallpaper is
        // behind everything, so "off" and "the command failed" were the same
        // picture. Naming what was kept matters too — people assume toggling off
        // throws the choice away.
        new Notice(
          this.settings.enabled
            ? "Wallvia: 壁纸已启用"
            : "Wallvia: 壁纸已停用(选择的壁纸仍保留)"
        );
      },
    });
    this.addCommand({
      id: "pick-wallpaper",
      name: "Pick wallpaper image",
      callback: () => this.pickLocalImage(),
    });
    this.addCommand({
      id: "pick-wallpaper-engine",
      name: WE_COMMAND_NAME,
      callback: () => {
        void this.pickWallpaperEngine();
      },
    });
    // The ribbon icon is the same entry point dsh-web-all pins to the window
    // corner: it opens the panel (preview + effects), not a bare file picker.
    this.addRibbonIcon("image", "Wallvia", () => this.panel.toggle());

    this.app.workspace.onLayoutReady(() => {
      void this.apply();
    });
  }

  /** Vault image picker; picking one always turns the wallpaper on. */
  pickLocalImage(): void {
    new ImagePicker(this.app, (p) => {
      this.settings.image = p;
      // A still image replaces any playing video: keeping the old `videoPath`
      // would leave a video behind a picture the user just chose.
      this.settings.videoPath = "";
      this.settings.enabled = true;
      void this.apply();
      void this.saveSettings();
      this.panel.refresh();
      new Notice("Wallpaper set.");
    }).open();
  }

  /**
   * Coalesce the burst of layout events Obsidian fires while a pane opens or a
   * tab changes: one apply per quiet window instead of one per event.
   */
  private scheduleApply(): void {
    if (this.applyTimer !== null) return;
    this.applyTimer = window.setTimeout(() => {
      this.applyTimer = null;
      void this.apply();
    }, 50);
  }

  /** Forget the resolved URL (the path or the file behind it changed). */
  private invalidateImage(): void {
    this.resolved = null;
  }

  async resolveImage() {
    const path = this.settings.image;
    if (!path) {
      this.imageUrl = "";
      this.resolved = null;
      return;
    }
    if (this.resolved?.path === path) {
      this.imageUrl = this.resolved.url;
      return;
    }
    try {
      const stat = await this.app.vault.adapter.stat(path);
      if (stat?.type === "file") {
        // Obsidian regenerates resource URLs on every reload; resolve at
        // runtime and bust the cache with ?v=<mtime>.
        const url = this.app.vault.adapter.getResourcePath(path) + `?v=${stat.mtime}`;
        this.resolved = { path, url };
        this.imageUrl = url;
        return;
      }
    } catch (e) {
      // Unreadable or missing: fall through to "no image", but say why — a
      // silently empty wallpaper is indistinguishable from a broken setting.
      this.reportError("读取壁纸文件", e);
    }
    this.resolved = null;
    this.imageUrl = "";
  }

  async apply() {
    const seq = ++this.applySeq;
    await this.resolveImage();
    // Disabled while we were waiting, or a newer apply() has taken over.
    if (this.unloaded || seq !== this.applySeq) return;
    const body = document.body;
    const active = this.settings.enabled && !!this.imageUrl;
    body.classList.toggle("wallvia-enabled", active);
    // Glass is a 0-100 level now (dsh-web-all's "Glass" slider); 0 means the
    // surfaces stay opaque, so the class is only applied above 0.
    body.classList.toggle("wallvia-glass", active && this.settings.glass > 0);
    const st = body.style;
    // `active`, not `imageUrl`: with the master switch off the picture must stop
    // being referenced at all. Writing the url anyway left `--wallvia-image`
    // populated while disabled, so anything reading the variable (a theme, a
    // snippet, a future selector not keyed on the class) still painted it — the
    // switch looked like it did nothing for those cases.
    setCss(st, "--wallvia-image", active ? `url("${this.imageUrl}")` : "none");
    // Every variable is gated on `active`, not just the image: leaving them set
    // while disabled meant the page kept carrying a full wallpaper configuration
    // (opacity, wash colour, glass level) with nothing painted — invisible until
    // some other stylesheet read one of them.
    setCss(st, "--wallvia-opacity", active ? String(this.settings.opacity) : "");
    setCss(st, "--wallvia-dim", active ? String(this.settings.dim) : "");
    setCss(st, "--wallvia-blur", active ? this.settings.blur + "px" : "");
    setCss(st, "--wallvia-glass", active ? glassFill(this.settings.glass) : "");
    setCss(st, "--wallvia-embed-opacity", active ? embedOpacity(this.settings.embed) : "");
    setCss(st, "--wallvia-fit", active ? FIT_CSS[this.settings.fit] : "");
    // The wash follows the theme unless the user pinned it; `theme-light` is
    // Obsidian's own class, so a theme switch only needs the css-change event
    // that already calls apply().
    setCss(
      st,
      "--wallvia-wash",
      active ? washRgb(this.settings, body.classList.contains("theme-light")) : ""
    );
    // The moving layer, last: it reads `enabled`/`fit`/`opacity` from the same
    // settings the still image just wrote, and its own failure path must not
    // stop the still from painting.
    await this.syncVideoLayer(seq);
  }

  /**
   * Put the video layer in sync with the current wallpaper, or take it down.
   *
   * Runs after the still has been painted, so a video that fails to start
   * leaves the still (or its decoded frame) on screen instead of a hole. Every
   * exit re-checks `unloaded`/`applySeq`: a slow `stat()` or a stalled loopback
   * request must not add a `<video>` to a plugin that is being torn down.
   */
  private async syncVideoLayer(seq: number): Promise<void> {
    // The still is the poster, so a video with no still is not a wallpaper we can
    // present: the first frame would be a black screen. Requiring both is also
    // what makes "清除图片" take the video down even if a caller forgets
    // `videoPath`.
    const wantsVideo =
      this.settings.enabled &&
      this.settings.videoWallpaper &&
      !!this.settings.videoPath &&
      !!this.imageUrl;
    if (!wantsVideo) {
      this.videoLayer.destroy();
      this.videoServer.stop();
      return;
    }
    let result: { url: string } | { reason: "no-node" | "missing" | "no-socket" } | null = null;
    try {
      result = await this.videoServer.set(this.settings.videoPath);
    } catch (e) {
      this.reportError("启动视频服务", e);
    }
    if (this.unloaded || seq !== this.applySeq) return;
    if (!result || !("url" in result)) {
      // No loopback server means no video. The still and the decoded frame stay
      // up, and the settings page says *which* of the three causes it was.
      this.videoLayer.destroy();
      const reason = result && "reason" in result ? result.reason : "no-socket";
      this.reportError("播放视频壁纸", new Error(VIDEO_FAILURE[reason]));
      return;
    }
    const url = result.url;
    this.videoLayer.sync(
      {
        path: this.settings.videoPath,
        url,
        poster: this.imageUrl,
        fit: FIT_CSS[this.settings.fit],
        opacity: this.settings.opacity,
        muted: this.settings.videoMuted,
        pauseUnfocused: this.settings.videoPauseUnfocused,
      },
      (at, e) => this.reportError(at, e)
    );
  }

  // -------------------------------------------------- Wallpaper Engine

  /** True when Node APIs are reachable (Windows/Linux/macOS desktop app). */
  weAvailable(): boolean {
    return isWallpaperEngineSupported();
  }

  /**
   * Open the Wallpaper Engine picker: the active wallpaper(s) first, then
   * every downloaded one that has a usable preview image.
   */
  async pickWallpaperEngine(): Promise<void> {
    if (!this.weAvailable()) {
      new Notice(WE_MISSING_NOTICE);
      return;
    }
    const downloaded = await listWeWallpapers();
    const current = await getCurrentWeWallpapers(downloaded);
    const currentDirs = new Set(current.map((w) => weDirKey(w.dir)));
    const items: WeChoice[] = [];
    for (const w of current) items.push({ wallpaper: w, current: true });
    for (const w of downloaded) {
      if (currentDirs.has(weDirKey(w.dir))) continue;
      items.push({ wallpaper: w, current: false });
    }
    if (items.length === 0) {
      new Notice(
        (await findWeRoot())
          ? "Wallpaper Engine 里没有可选的壁纸(没有找到预览图)"
          : WE_MISSING_NOTICE
      );
      return;
    }
    new WeWallpaperGridModal(
      this.app,
      items,
      this.settings,
      (choice) => {
        void this.applyWeWallpaper(choice.wallpaper);
      }
    ).open();
  }

  /**
   * Copy the chosen wallpaper's image into the vault (Obsidian can only display
   * files inside the vault) and make it the background.
   *
   * For a scene wallpaper the preview is a small square thumbnail, so the
   * full-resolution artwork is taken out of `scene.pkg` whenever it is available
 * — that is the difference between a sharp background and an upscaled 801 px
   * JPEG. Anything unexpected falls back to the preview.
   */
  async applyWeWallpaper(wallpaper: WeWallpaper): Promise<void> {
    const dir = cacheDirFor(this.app, this.settings.weCacheDir);
    // Ids are workshop numbers or project folder names; keep them filename-safe.
    const id = wallpaper.id.replace(/[^A-Za-z0-9._-]/g, "_");
    const hiRes =
      this.settings.hires && wallpaper.type === "scene"
        ? await readSceneHiResImage(wallpaper.dir, this.settings.maxImageWidth)
        : null;
    if (this.unloaded) return;
    // A video has no still of its own, so the frame the picker shows is what
    // gets applied. Without this the wallpaper fell back to Wallpaper Engine's
    // square preview, which a 16:9 window upscales ~3x — the "帧截取没生效" case.
    const frame =
      !hiRes && this.settings.videoFrames && wallpaper.type === "video"
        ? await this.videoStill(wallpaper)
        : null;
    if (this.unloaded) return;
    const bytes = hiRes?.bytes ?? frame?.bytes ?? (await readImageArrayBuffer(wallpaper.preview));
    if (this.unloaded) return;
    const ext = hiRes?.ext ?? frame?.ext ?? (fileExtension(wallpaper.preview) || "jpg");
    const target = normalizePath(`${dir}/${WE_CACHE_PREFIX}${id}.${ext}`);
    if (!bytes) {
      new Notice("读取壁纸预览图失败:" + wallpaper.preview);
      return;
    }
    try {
      await ensureVaultDir(this.app, dir);
      await this.app.vault.adapter.writeBinary(target, bytes);
    } catch (e) {
      new Notice("复制壁纸到缓存目录失败:" + errorMessage(e));
      this.reportError("写入壁纸缓存", e);
      return;
    }
    if (this.unloaded) return;
    await pruneWeCache(this.app, dir, target, (e) => this.reportError("清理旧缓存", e));
    this.settings.image = target;
    // A video wallpaper also gets a moving layer; the still above becomes its
    // poster. Stored as an absolute native path because the file lives in the
    // Wallpaper Engine library, outside the vault.
    this.settings.videoPath =
      this.settings.videoWallpaper && wallpaper.type === "video"
        ? videoFileOf(wallpaper) ?? ""
        : "";
    // Picking a wallpaper means wanting to see it. Without this, choosing one
    // while the wallpaper is toggled off wrote the file and quietly changed
    // nothing — the "选中后没反应" case.
    this.settings.enabled = true;
    await this.apply();
    await this.saveSettings();
    this.panel.refresh();
    const moving = this.settings.videoPath && this.videoLayer.active;
    new Notice(
      hiRes
        ? `壁纸已应用:${wallpaper.title}(${hiRes.width}×${hiRes.height} 原始画面)`
        : moving
          ? `壁纸已应用:${wallpaper.title}(视频播放中,抽帧作封面)`
          : frame
            ? `壁纸已应用:${wallpaper.title}(${frame.width}×${frame.height} 视频帧)`
            : "壁纸已应用:" + wallpaper.title
    );
  }

  /**
   * The frame that becomes the wallpaper, at the video's own width.
   *
   * The card frame is 960 px wide, which is far too soft for a wide window, so
   * the applied frame is decoded at the source width (bounded by
   * `APPLY_FRAME_WIDTH`). `maxImageWidth` still wins when the user set it.
   */
  private async videoStill(wallpaper: WeWallpaper): Promise<WeStill | null> {
    const file = videoFileOf(wallpaper);
    if (!file) return null;
    const cap = this.settings.maxImageWidth;
    let width = cap;
    if (!(width > 0)) {
      const size = await resolveSourceSize(wallpaper);
      width = Math.min(size.video?.width || APPLY_FRAME_WIDTH, APPLY_FRAME_WIDTH);
    }
    return await loadVideoFrame(this.app, file, width);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    // First, before anything else: every in-flight async path re-checks this
    // after its next `await` and bails out instead of repainting a plugin that
    // is being torn down.
    this.unloaded = true;
    this.applySeq++;
    if (this.applyTimer !== null) {
      window.clearTimeout(this.applyTimer);
      this.applyTimer = null;
    }
    // A playing video holds a decoder and a file handle, and the loopback
    // server holds a listening socket: disabling the plugin has to release all
    // three, or the wallpaper keeps playing after the plugin is off.
    this.videoLayer.destroy();
    this.videoServer.stop();
    this.panelInstance?.destroy();
    document.body.classList.remove("wallvia-enabled");
    document.body.classList.remove("wallvia-glass");
    const st = document.body.style;
    for (const k of [
      "--wallvia-image",
      "--wallvia-opacity",
      "--wallvia-dim",
      "--wallvia-blur",
      "--wallvia-glass",
      "--wallvia-embed-opacity",
      "--wallvia-fit",
      "--wallvia-wash",
    ]) {
      st.removeProperty(k);
    }
  }
}

/**
 * Adapts the plugin to the panel's host interface. A class (not an object
 * literal) keeps `this` meaningful and the promise return types honest.
 */
class PluginPanelHost implements PanelHost {
  constructor(private plugin: WallpaperPlugin) {}

  get settings(): WPSettings {
    return this.plugin.settings;
  }

  get imageUrl(): string {
    return this.plugin.imageUrl;
  }

  apply(): Promise<void> {
    return this.plugin.apply();
  }

  saveSettings(): Promise<void> {
    return this.plugin.saveSettings();
  }

  pickLocalImage(): void {
    this.plugin.pickLocalImage();
  }

  pickWeWallpaper(): void {
    void this.plugin.pickWallpaperEngine();
  }

  weAvailable(): boolean {
    return this.plugin.weAvailable();
  }
}

function setCss(st: CSSStyleDeclaration, k: string, v: string) {
  if (v && v !== "none") st.setProperty(k, v);
  else st.removeProperty(k);
}

/** Why a video wallpaper could not be played, in the user's terms. */
const VIDEO_FAILURE: Record<"no-node" | "missing" | "no-socket", string> = {
  "no-node": "这台设备没有可用的本地文件接口(仅桌面端支持视频壁纸)",
  missing: "视频文件不在了(被移动或删除),请重新选择壁纸",
  "no-socket": "无法启动本地播放服务(端口被占用),视频未播放",
};

// ------------------------------------------------- Wallpaper Engine helpers

interface WeChoice {
  wallpaper: WeWallpaper;
  current: boolean;
}

/**
 * `DataAdapter.mkdir` is typed with a single argument, but the desktop
 * FileSystemAdapter takes an optional `recursive` flag — which is what we want
 * for a nested cache folder.
 */
interface RecursiveMkdirAdapter {
  mkdir(path: string, recursive?: boolean): Promise<void>;
}

/** Vault-relative folder for copied stills; `""` means "the private cache". */
function normalizeCacheDir(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim();
}

/** The plugin's own id, so the private cache path matches the loaded folder. */
const PLUGIN_ID = "wallvia";

/**
 * Where copied stills live.
 *
 * Obsidian can only paint files it can serve, so the bytes do have to live
 * inside the vault — but not in the user's note tree. An empty `weCacheDir`
 * (the default) resolves to `<configDir>/plugins/wallvia/cache/`: a dot-folder
 * the file explorer never lists, so applying a wallpaper no longer drops a
 * `Wallpapers/` folder full of PNGs next to someone's notes. A non-empty value
 * is honoured as-is: that is the user explicitly asking for a visible folder.
 */
function cacheDirFor(app: App, preferred: string): string {
  const custom = normalizeCacheDir(preferred);
  if (custom) return custom;
  return normalizePath(`${app.vault.configDir}/plugins/${PLUGIN_ID}/cache`);
}

/** Comparison key for a native directory path. */
function weDirKey(dir: string): string {
  return dir.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

/**
 * Make sure a vault folder exists. `mkdir(dir, true)` already covers the
 * recursive case; the explicit walk is a fallback for adapters that ignore the
 * second argument, and every failure there means "it already exists".
 */
async function ensureVaultDir(app: App, dir: string): Promise<void> {
  const adapter = app.vault.adapter as unknown as RecursiveMkdirAdapter;
  try {
    await adapter.mkdir(dir, true);
    return;
  } catch {
    // Already present — ignore, like the picker promises.
  }
  let current = "";
  for (const part of dir.split("/")) {
    if (!part) continue;
    current = current ? `${current}/${part}` : part;
    try {
      await adapter.mkdir(current, true);
    } catch {
      // Already present.
    }
  }
}

/**
 * Delete previously copied stills so the cache folder holds only one file.
 *
 * `onError` is how a failure here becomes visible: the cleanup is best-effort,
 * but "the folder keeps growing and nobody says why" is exactly the kind of
 * silent failure the settings page's status line exists for.
 */
async function pruneWeCache(
  app: App,
  dir: string,
  keep: string,
  onError?: (e: unknown) => void
): Promise<void> {
  try {
    const listed = await app.vault.adapter.list(dir);
    for (const file of listed.files) {
      if (file === keep) continue;
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (!name.startsWith(WE_CACHE_PREFIX)) continue;
      try {
        await app.vault.adapter.remove(file);
      } catch (e) {
        // Locked or already gone — not worth interrupting the user, but worth
        // recording: a file the adapter refuses to delete is a real anomaly.
        onError?.(e);
      }
    }
  } catch (e) {
    // Unreadable cache folder: keep the new file, skip the cleanup.
    onError?.(e);
  }
}

// ------------------------------------------------------------------ picker

class ImagePicker extends FuzzySuggestModal<string> {
  constructor(app: App, private onPick: (p: string) => void) {
    super(app);
    this.setPlaceholder("Choose a wallpaper image in your vault");
  }
  getItems(): string[] {
    return this.app.vault
      .getFiles()
      .filter((f) => IMAGE_RE.test(f.path))
      .map((f) => f.path);
  }
  getItemText(p: string) {
    return p;
  }
  onChooseItem(p: string) {
    this.onPick(p);
  }
}

/** One rendered card, kept addressable for search and lazy image loading. */
interface WeCard {
  choice: WeChoice;
  /** Card element, for hiding on a non-match. */
  el: HTMLElement;
  /** The still, shown whole inside the preview stage. */
  image: HTMLImageElement;
  /** Resolution caption under the preview. */
  res: HTMLElement;
  meta: HTMLElement;
  /** "scene · workshop" — also the prefix of the failure message. */
  label: string;
  /** Lowercased title, so the search box does not re-lowercase per keystroke. */
  needle: string;
  /** The preview file has already been requested. */
  requested: boolean;
  /** What the file system says the real assets are; null until asked for. */
  source: WeSourceSize | null;
}

/**
 * Grid of every downloaded Wallpaper Engine wallpaper.
 *
 * Obsidian refuses `file://` images, so each preview is read through Node and
 * handed to the renderer as a `blob:` URL — the URLs are revoked again on
 * close. Previews are read only once a card scrolls into view: a library with
 * hundreds of wallpapers would otherwise read and decode every one of them
 * before the grid could paint.
 *
 * The tile is 16:9 because Wallpaper Engine's stills are square and a square
 * tile does not read as a wallpaper. The still is shown whole (`contain`) on
 * top of a blurred copy of itself, so nothing is cropped and there are no
 * black bars.
 */
class WeWallpaperGridModal extends Modal {
  private previewUrls: string[] = [];
  private cards: WeCard[] = [];
  /** Cards currently passing the search filter, in display order. */
  private visible: WeCard[] = [];
  /** Serialises the card lookups so only one package is read at a time. */
  private fillQueue: Promise<void> = Promise.resolve();
  private cursor = 0;
  private grid: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  /** Set once the modal closes, so a late file read cannot leak its URL. */
  private closed = false;

  constructor(
    app: App,
    private choices: WeChoice[],
    /** Read live, so a switch flipped while the grid is open still applies. */
    private settings: WPSettings,
    private onApply: (choice: WeChoice) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(WE_MODAL_TITLE);
    this.modalEl.addClass("wallvia-we-grid-modal-host");
    this.contentEl.empty();
    this.contentEl.setAttr("aria-label", "Wallpaper Engine wallpapers");
    this.contentEl.addClass("wallvia-we-grid-modal");

    const search = this.contentEl.createEl("input", {
      cls: "wallvia-we-search",
      attr: { type: "search", placeholder: WE_MODAL_SEARCH, "aria-label": WE_MODAL_SEARCH },
    });
    search.addEventListener("input", () => this.applyFilter(search.value));

    this.grid = this.contentEl.createDiv({
      cls: "wallvia-we-grid",
      attr: { tabindex: "0", "aria-label": "壁纸列表" },
    });
    for (const choice of this.choices) this.cards.push(this.buildCard(choice));
    this.emptyEl = this.contentEl.createDiv({
      cls: "wallvia-we-empty wallvia-hidden",
      text: "没有匹配的壁纸",
    });

    this.visible = this.cards.slice();
    this.paintCursor();
    this.contentEl.addEventListener("keydown", (e: KeyboardEvent) => this.onKey(e));

    // The first screenful is read at once — no observer tick to wait for — and
    // everything below it follows the scroll position.
    for (const card of this.cards.slice(0, EAGER_CARDS)) this.queueCard(card);
    this.grid.addEventListener("scroll", () => this.queueNearby());
    window.setTimeout(() => this.queueNearby(), 0);

    // Searching is the first thing a long list needs; arrows still reach the
    // grid through the content-level handler below.
    search.focus();
  }

  // ---------------------------------------------------------------- cards

  private buildCard(choice: WeChoice): WeCard {
    const w = choice.wallpaper;
    const label = `${capitalize(w.type)} · ${WE_SOURCE_LABEL[w.source] ?? w.source}`;
    const el = this.grid!.createDiv({ cls: "wallvia-we-card" });
    const shot = el.createDiv({ cls: "wallvia-we-shot" });
    const image = shot.createEl("img", {
      cls: "wallvia-we-thumb",
      attr: { alt: w.title },
    });
    if (choice.current) shot.createDiv({ cls: "wallvia-we-current", text: WE_CARD_CURRENT });
    // A play glyph on the preview, not just "视频" in the meta line: the meta is
    // small grey text, and "this one moves" is the single fact a user needs
    // before applying. Same corner as the "current" badge, opposite side.
    if (w.type === "video") {
      shot.createDiv({ cls: "wallvia-we-play", text: "▶", attr: { "aria-label": "视频壁纸" } });
    }
    // The artwork's own resolution, so a wallpaper that would render soft is
    // obvious before it is applied. Sits over the preview's bottom-left corner.
    const res = shot.createDiv({ cls: "wallvia-we-px" });
    el.createDiv({ cls: "wallvia-we-card-title", text: w.title });
    const meta = el.createDiv({ cls: "wallvia-we-card-meta", text: label });
    el.createEl("button", { cls: "wallvia-we-apply", text: WE_CARD_APPLY }).addEventListener(
      "click",
      () => {
        this.onApply(choice);
        this.close();
      }
    );

    const card: WeCard = {
      choice,
      el,
      image,
      res,
      meta,
      label,
      needle: `${w.title} ${label}`.toLowerCase(),
      requested: false,
      source: null,
    };
    return card;
  }

  /**
   * Reveal-once fill over the grid.
   *
   * Deliberately **not** an `IntersectionObserver`: its callbacks are delivered
   * during rendering frames, and Chromium produces none while the window is
   * occluded — the grid then sat empty until the user clicked it. Rects are
   * computed from layout, which happens regardless, so the first screen is read
   * eagerly and the rest follows the scroll position.
   */
  private queueNearby(): void {
    const grid = this.grid;
    if (!grid) return;
    const view = grid.getBoundingClientRect();
    for (const card of this.cards) {
      if (card.requested || card.el.classList.contains("wallvia-hidden")) continue;
      const box = card.el.getBoundingClientRect();
      // Cards keep their order, so the first one past the band ends the scan.
      if (box.top > view.bottom + PREFETCH_MARGIN) break;
      if (box.bottom >= view.top - PREFETCH_MARGIN) this.queueCard(card);
    }
  }

  /** One card at a time: each may read a multi-megabyte `scene.pkg`. */
  private queueCard(card: WeCard): void {
    if (card.requested) return;
    card.requested = true;
    // A failure must not poison the chain, or every later card would wait on a
    // rejected promise forever.
    this.fillQueue = this.fillQueue.then(() => this.fillCard(card)).catch(() => undefined);
  }

  /**
   * Everything a card needs from disk, in one serialised pass: the picture and
   * its resolution.
   *
   * A scene wallpaper is drawn from a **mipmap level of its own artwork** rather
   * than Wallpaper Engine's square `preview.jpg`, which is why the cards show
   * the artwork's 16:9 shape and fill the frame. A video has no still of its
   * own, so one frame is decoded by Chromium (see `videoFrame`).
   */
  private async fillCard(card: WeCard): Promise<void> {
    const w = card.choice.wallpaper;
    const s = this.settings;
    // Any still on disk: a scene's package, or an unpacked project's own files.
    const scene = w.type !== "video" && s.hires ? await resolveStillAssets(w.dir, s.maxImageWidth) : null;
    if (this.closed) return;
    try {
      card.source = await resolveSourceSize(w);
    } catch {
      card.source = {};
    }
    if (this.closed) return;
    this.paintResolution(card);

    const video =
      w.type === "video" && s.videoFrames && !scene?.still ? await this.videoFrame(w) : null;
    const still = scene?.still ?? video;
    const bytes = still?.bytes ?? (await readImageArrayBuffer(w.preview));
    if (this.closed) return;
    if (!bytes) {
      card.meta.setText(`${card.label} · 预览无法读取`);
      return;
    }
    const type = still ? `image/${still.ext}` : previewMime(w.preview);
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    if (this.closed) {
      URL.revokeObjectURL(url);
      return;
    }
    this.previewUrls.push(url);
    card.image.src = url;
    card.image.addEventListener("error", () =>
      card.meta.setText(`${card.label} · 预览无法读取`)
    );
  }

  /**
   * One frame of a video wallpaper for the **card**: from the on-disk cache when
   * it is there, otherwise decoded by Chromium and cached for next time.
   *
   * `null` on any failure, and the caller then keeps Wallpaper Engine's square
   * preview — a missing frame must never leave a blank card.
   */
  private async videoFrame(wallpaper: WeWallpaper): Promise<WeStill | null> {
    const file = videoFileOf(wallpaper);
    if (!file) return null;
    const cap = this.settings.maxImageWidth;
    // `maxImageWidth` raises the card frame as well: someone who set 2560 for a
    // huge screen wants a sharp card too, and the decode never upscales, so a
    // cap above the video's own width costs nothing. The width is part of the
    // frame cache key, so raising it decodes a new frame instead of reusing the
    // small one.
    const width = cap > 0 ? cap : VIDEO_FRAME_WIDTH;
    let still = await loadVideoFrame(this.app, file, width);
    if (!still && !this.closed) {
      // A large file can still be opening when the first request arrives, and
      // the fallback is Wallpaper Engine's square preview — exactly what this
      // path exists to avoid. One retry, then the caller's `still ?? preview`.
      await new Promise((resolve) => window.setTimeout(resolve, FRAME_RETRY_DELAY_MS));
      still = await loadVideoFrame(this.app, file, width);
    }
    if (!still) {
      // Surfaced in Obsidian's developer console: without it a failed decode is
      // indistinguishable from a wallpaper that simply has no frame.
      console.debug(`[wallvia] 视频帧解码失败,回退到预览图:${file}`);
    }
    return this.closed ? null : still;
  }

  /** `app://` URL for any file on this machine, inside the vault or not. */
  private localResourceUrl(absolutePath: string): string {
    return resourceUrlFor(this.app, absolutePath);
  }

  /**
   * The **original** resolution: the `scene.pkg` artwork a scene will be
 * painted from, or the video's own frame size — not the square thumbnail the
   * card itself is drawn from. Cards with no larger asset stay blank.
   */
  private paintResolution(card: WeCard): void {
    const original = card.source?.package ?? card.source?.video;
    if (!original) return;
    card.res.setText(`${original.width}×${original.height}`);
    card.res.classList.toggle(
      "wallvia-we-px-low",
      Math.max(original.width, original.height) < SHARP_ENOUGH
    );
  }

  // ------------------------------------------------- search and keyboard

  private applyFilter(query: string): void {
    const needle = query.trim().toLowerCase();
    this.visible = [];
    for (const card of this.cards) {
      const match = !needle || card.needle.includes(needle);
      card.el.classList.toggle("wallvia-hidden", !match);
      if (match) this.visible.push(card);
    }
    this.emptyEl?.classList.toggle("wallvia-hidden", this.visible.length > 0);
    this.cursor = 0;
    this.paintCursor();
  }

  private paintCursor(): void {
    for (const card of this.cards) card.el.classList.remove("wallvia-we-card-selected");
    const card = this.visible[this.cursor];
    if (!card) return;
    card.el.classList.add("wallvia-we-card-selected");
    card.el.scrollIntoView({ block: "nearest" });
  }

  /**
   * How many cards sit on one row, so Up/Down move by a whole row.
   *
   * Counted from the laid-out cards rather than from
   * `grid-template-columns`: the grid is `auto-fill`, and its computed track
   * list also contains the empty tracks of a half-filled last row.
   */
  private columnCount(): number {
    const first = this.visible[0]?.el;
    if (!first) return 1;
    const top = first.offsetTop;
    let count = 0;
    for (const card of this.visible) {
      if (card.el.offsetTop !== top) break;
      count += 1;
    }
    return Math.max(1, count);
  }

  private onKey(e: KeyboardEvent): void {
    // Inside the search box the left/right arrows belong to the text caret and
    // Enter must not silently apply a wallpaper.
    const inSearch = e.target instanceof HTMLInputElement;
    const step = this.columnCount();
    const move = (delta: number) => {
      e.preventDefault();
      const next = this.cursor + delta;
      this.cursor = clamp(next, 0, Math.max(0, this.visible.length - 1));
      this.paintCursor();
    };
    switch (e.key) {
      case "ArrowDown":
        return move(step);
      case "ArrowUp":
        return move(-step);
      case "ArrowRight":
        if (!inSearch) move(1);
        return;
      case "ArrowLeft":
        if (!inSearch) move(-1);
        return;
      case "Enter": {
        if (inSearch) return;
        const card = this.visible[this.cursor];
        if (!card) return;
        e.preventDefault();
        this.onApply(card.choice);
        this.close();
        return;
      }
      default:
    }
  }

  onClose(): void {
    this.closed = true;
    for (const url of this.previewUrls) URL.revokeObjectURL(url);
    this.previewUrls = [];
    this.cards = [];
    this.visible = [];
    this.grid = null;
    this.emptyEl = null;
  }
}

/** `scene` → `Scene`, for the "kind · source" line. */
function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/** How far into a video the card's frame is taken. */
const VIDEO_FRAME_SECONDS = 2;
/** Frame width handed to the card; the artwork is scaled down to this. */
const VIDEO_FRAME_WIDTH = 960;
/**
 * Frame width when the frame *becomes* the wallpaper.
 *
 * 960 px is right for a card and far too soft for a 1440p window, so the applied
 * frame is decoded at the video's own width, bounded by this. The cache key
 * includes the width, so the card frame and the wallpaper frame never share an
 * entry (a shared one would silently downgrade the wallpaper to the card size).
 */
const APPLY_FRAME_WIDTH = 2560;
/** A decode that has not produced a frame by then is treated as a failure. */
const VIDEO_FRAME_TIMEOUT_MS = 6000;
/** Pause before the single retry, so a large file has time to open. */
const FRAME_RETRY_DELAY_MS = 700;

/**
 * `app://` URL for any file on this machine, inside the vault or not.
 *
 * Obsidian's adapter prepends the vault root, which is wrong for Wallpaper
 * Engine's folders, but its protocol handler resolves everything after the
 * vault id as an absolute path — verified against a 54 MB video outside the
 * vault, which `file://` refuses ("rejected by URL safety check").
 */
function resourceUrlFor(app: App, absolutePath: string): string {
  try {
    const id = app.vault.adapter.getResourcePath("x").split("/")[2];
    if (!id) return "";
    const path = absolutePath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
    return `app://${id}/${path}`;
  } catch {
    return "";
  }
}

/**
 * A frame of `video`, from the disk cache when it is there, otherwise decoded by
 * the renderer and cached for next time.
 *
 * `width` is the frame width to decode at *and* the cache key, so callers must
 * pass the same value they expect to read back. `null` on any failure: the
 * caller then keeps Wallpaper Engine's square preview, because a missing frame
 * must never leave a blank card — or a blank wallpaper.
 */
async function loadVideoFrame(app: App, video: string, width: number): Promise<WeStill | null> {
  const cached = await readVideoFrame(video, width);
  if (cached) return cached;
  const url = resourceUrlFor(app, video);
  if (!url) return null;
  const base64 = await decodeVideoFrame(url, width);
  if (!base64) return null;
  return await writeVideoFrame(video, base64, width);
}

/**
 * One frame of a video, decoded by the host's own Chromium.
 *
 * Every target of this plugin is Chromium, which already decodes H.264/VP9, so
 * no ffmpeg and no WASM decoder is needed. Returns the JPEG's base64 payload
 * (without the `data:` prefix), or `null`.
 *
 * The element is off-screen but **in the document**: a detached one never
 * decodes. Progress is driven by `loadeddata` / `seeked` rather than by
 * `requestAnimationFrame`, because a hidden element is throttled and rAF may
 * never run while those events still do.
 */
async function decodeVideoFrame(url: string, width: number): Promise<string | null> {
  const video = document.body.createEl("video");
  video.muted = true;
  video.preload = "auto";
  video.addClass("wallvia-video-probe");
  try {
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), VIDEO_FRAME_TIMEOUT_MS);
      const done = (ok: boolean) => {
        window.clearTimeout(timer);
        resolve(ok);
      };
      video.addEventListener("loadeddata", () => done(true), { once: true });
      video.addEventListener("error", () => done(false), { once: true });
      video.src = url;
    });
    if (!loaded || !video.videoWidth || !video.videoHeight) return null;

    // A frame at the very start is often a fade-in or a title card.
    const target = Math.min(VIDEO_FRAME_SECONDS, Math.max(0, (video.duration || 0) - 0.1));
    if (target > 0) {
      const seeked = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => resolve(false), VIDEO_FRAME_TIMEOUT_MS);
        video.addEventListener(
          "seeked",
          () => {
            window.clearTimeout(timer);
            resolve(true);
          },
          { once: true }
        );
        video.currentTime = target;
      });
      if (!seeked) return null;
    }

    const scale = Math.min(1, width / video.videoWidth);
    const canvas = document.body.createEl("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // JPEG, not PNG: a 1080p frame is ~0.3 MB against several MB.
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    const comma = dataUrl.indexOf(",");
    return comma < 0 ? null : dataUrl.slice(comma + 1);
  } catch {
    // A tainted canvas or a codec the build lacks — the caller falls back.
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}

/** MIME type for a preview file (`image/jpeg` for the `.jpg`/`.jpeg` pair). */
function previewMime(path: string): string {
  const ext = fileExtension(path);
  return `image/${ext === "jpg" ? "jpeg" : ext || "png"}`;
}

// ---------------------------------------------------------------- settings


/**
 * Control keys whose change must rebuild the tab, matching the imperative rows
 * that used to call `commit()`. The rest only persist — a slider must not
 * re-render mid-drag.
 */
const REBUILD_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "fit",
  "hires",
  "videoFrames",
  "videoWallpaper",
]);

/** `[{value,label}]` → the plain map the declarative dropdown wants. */
function dropdownOptions(
  list: ReadonlyArray<{ value: string; label: string }>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const option of list) out[option.value] = option.label;
  return out;
}

class WallpaperSettingTab extends PluginSettingTab {
  plugin: WallpaperPlugin;


  constructor(app: App, plugin: WallpaperPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ----------------------------------------------------------- persistence

  /** Persist the change; sliders must not re-render mid-drag. */
  private async persist(): Promise<void> {
    await this.plugin.apply();
    await this.plugin.saveSettings();
  }

  /** Persist and refresh the tab (for controls whose preview changes). */
  private async commit(): Promise<void> {
    await this.persist();
    this.refresh();
  }

  /**
   * Re-render through whichever API this app version offers. On 1.13+ the
   * framework owns the page, so `update()` is the refresh entry point; before
   * 1.13 `display()` was. The 1.13 typings mark `display()` deprecated, so it
   * is reached through a locally declared, non-deprecated view of the same
   * method rather than through an eslint suppression.
   */
  private refresh(): void {
    // The test has to be this exact shape: `obsidianmd/no-unsupported-api`
    // only recognises a literal `requireApiVersion("1.13.0")` in the same
    // statement (an if-test, a ternary consequent, or the left of `&&`), and
    // reports `update()` as unavailable API for anything else.
    if (requireApiVersion("1.13.0")) {
      this.update();
      return;
    }
    (this as unknown as { display(): void }).display();
  }

  // ------------------------------------------ declarative settings (1.13+)

  /** Read a control's value out of the plugin's settings. */
  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /** Persist a control change, plus the side effects its row used to carry. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    s[key] = key === "fit" ? normalizeFit(value) : value;
    await this.persist();
    if (REBUILD_KEYS.has(key)) this.refresh();
  }

  /**
   * Every row of the page, declaratively. Obsidian 1.13+ renders this instead
   * of `display()`; older builds never call it. Rows that hold more than one
   * control (the image picker, the wash pair) or a custom element (the preview,
   * the async status line) use the `render` escape hatch, because
   * `SettingDefinitionControl` binds exactly one `control` per row.
   */
  /**
   * The page, described once.
   *
   * `getSettingDefinitions()` maps this onto the 1.13+ declarative API and
   * `display()` builds `Setting` rows from it on older builds. Two hand-written
   * copies of the same 20 rows is how a setting ends up in one page and not the
   * other; the copies this replaces had already drifted apart in labels,
   * sections and change callbacks.
   */
  private rows(): SettingsRow[] {
    const s = this.plugin.settings;
    const rows: SettingsRow[] = [
      controlRow(LABELS.enable, DESCS.enable, "enabled", { type: "toggle" }),
      this.imageRow(),
      controlRow(LABELS.fit, DESCS.fit, "fit", { type: "dropdown", options: FIT_OPTIONS }),
      controlRow(LABELS.dim, DESCS.dim, "dim", { type: "slider", min: 0, max: 1, step: 0.05 }),
      controlRow(LABELS.glass, DESCS.glass, "glass", { type: "slider", min: 0, max: 100, step: 1 }),
      controlRow(LABELS.embed, DESCS.embed, "embed", { type: "slider", min: 0, max: 100, step: 1 }),
      controlRow(LABELS.blur, DESCS.blur, "blur", { type: "slider", min: 0, max: 40, step: 1 }),
      controlRow(LABELS.opacity, DESCS.opacity, "opacity", { type: "slider", min: 0, max: 1, step: 0.05 }),
      this.washRow(),
      {
        kind: "action",
        name: "恢复默认效果",
        desc: "把上面的效果项恢复为默认值;当前壁纸、缓存目录和可选行为不会改变。",
        label: "恢复默认",
        run: () => {
          resetEffects(s);
          void this.commit();
        },
      },
    ];
    // Only when there is something to say: a permanent empty row would train
    // the user to ignore the one time it matters.
    if (this.plugin.lastError) rows.push(this.lastErrorRow());

    // Node APIs are unavailable on mobile, so the whole section is absent there
    // instead of offering a button that can never work. Two sibling top-level
    // groups, because `SettingDefinitionGroup.items` only accepts settings and
    // pages — groups cannot nest.
    if (this.plugin.weAvailable()) {
      rows.push({
        kind: "group",
        heading: WE_NAME,
        rows: [this.wePickerRow(), this.cacheDirRow()],
      });
      // Video playback is not an "optional behaviour" like the two extraction
      // switches: it changes what the wallpaper *is* (a moving picture instead of
      // a still), and its two sub-switches only mean anything when it is on. Its
      // own group makes that hierarchy visible instead of flattening six toggles
      // into one list.
      rows.push({
        kind: "group",
        heading: "视频壁纸",
        rows: [
          controlRow(LABELS.videoWallpaper, DESCS.videoWallpaper, "videoWallpaper", { type: "toggle" }),
          this.videoSubRow("videoMuted", LABELS.videoMuted, DESCS.videoMuted),
          this.videoSubRow("videoPauseUnfocused", LABELS.videoPauseUnfocused, DESCS.videoPauseUnfocused),
        ],
      });
      rows.push({
        kind: "group",
        heading: "可选行为",
        rows: [
          controlRow(LABELS.hires, DESCS.hires, "hires", { type: "toggle" }),
          controlRow(LABELS.videoFrames, DESCS.videoFrames, "videoFrames", { type: "toggle" }),
          controlRow(LABELS.maxImageWidth, DESCS.maxImageWidth, "maxImageWidth", {
            type: "slider",
            min: MAX_IMAGE_WIDTH.min,
            max: MAX_IMAGE_WIDTH.max,
            step: MAX_IMAGE_WIDTH.step,
          }),
        ],
      });
    }
    return rows;
  }

  /**
   * One of the two switches that only apply while video playback is on.
   *
   * Disabled rather than hidden: a row that disappears when you flip the switch
   * above it makes the page jump and looks like a bug. A greyed row plus a desc
   * that says why is the honest version.
   */
  private videoSubRow(key: string, name: string, desc: string): ControlRow {
    const on = this.plugin.settings.videoWallpaper;
    const isVideo = !!this.plugin.settings.videoPath;
    const suffix = !on
      ? "(先打开上面的「视频壁纸播放」)"
      : !isVideo
        ? "(当前壁纸不是视频,选了视频壁纸后生效)"
        : "";
    return {
      kind: "control",
      name,
      desc: desc + suffix,
      key,
      control: { type: "toggle" },
      disabled: !on,
    };
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.rows().map(rowToDefinition);
  }

  /** The image row: two buttons, plus the preview element under them. */
  private imageRow(): RenderRow {
    const s = this.plugin.settings;
    return {
      kind: "render",
      name: LABELS.image,
      desc: DESCS.image,
      render: (setting) => {
        setting.addButton((b) =>
          b.setButtonText("选择图片…").onClick(() => {
            new ImagePicker(this.app, (p) => {
              s.image = p;
              // A still image replaces any playing video; keeping the old
              // `videoPath` would leave a video behind the picture just chosen.
              s.videoPath = "";
              s.enabled = true;
              void this.commit();
            }).open();
          })
        );
        setting.addButton((b) =>
          b.setButtonText("清除").onClick(() => {
            s.image = "";
            // Both halves: the still *and* the moving layer. Clearing only the
            // still left the `<video>` playing with no wallpaper class — the
            // plugin looked disabled while the video kept running.
            s.videoPath = "";
            void this.commit();
          })
        );
        // The preview is not a control: it is a custom element whose URL can
        // fail to resolve. It belongs under the row, in the same list.
        this.appendPreview(setting.settingEl.parentElement ?? this.containerEl);
      },
    };
  }

  /** The wash row: a dropdown *and* a colour picker, one gesture each. */
  private washRow(): RenderRow {
    const s = this.plugin.settings;
    return {
      kind: "render",
      name: LABELS.wash,
      desc: DESCS.wash,
      render: (setting) => {
        setting.addDropdown((d) => {
          for (const option of WASH_OPTIONS) d.addOption(option.value, option.label);
          return d.setValue(s.wash).onChange((v) => {
            s.wash = v as WPWash;
            void this.commit();
          });
        });
        setting.addColorPicker((p) =>
          p.setValue(s.washColor).onChange((v) => {
            // Picking a colour is also choosing custom mode, so the gesture
            // cannot silently do nothing.
            s.washColor = v;
            s.wash = "custom";
            void this.commit();
          })
        );
      },
    };
  }

  /** The Wallpaper Engine picker button plus the async status line under it. */
  private wePickerRow(): RenderRow {
    return {
      kind: "render",
      name: "选择已下载的壁纸",
      desc: WE_PICK_DESC,
      render: (setting) => {
        setting.addButton((b) =>
          b.setButtonText(WE_PICK_BUTTON).onClick(() => {
            void this.plugin.pickWallpaperEngine();
          })
        );
        const host = setting.settingEl.parentElement ?? this.containerEl;
        const statusEl = host.createDiv({ cls: "wallvia-we-status" });
        statusEl.setText("正在检测已下载的壁纸…");
        void this.showWeStatus(statusEl);
      },
    };
  }

  private cacheDirRow(): ControlRow {
    return controlRow(
      "缓存目录",
      "复制过来的壁纸画面存放的 vault 目录。留空则用插件私有缓存目录,不会出现在文件列表里。",
      "weCacheDir",
      { type: "text", placeholder: "留空 = 插件私有缓存" }
    );
  }

  /**
   * The last non-fatal failure, as a row the user can actually read.
   *
   * This is the other half of replacing the bare `catch {}` blocks: recording
   * the error without showing it would still be a silent failure.
   */
  private lastErrorRow(): RenderRow {
    const failure = this.plugin.lastError;
    const when = failure ? new Date(failure.when).toLocaleTimeString() : "";
    return {
      kind: "render",
      name: "上次失败",
      desc: failure ? `${failure.at}:${failure.message}(${when})` : "",
      render: (setting) => {
        setting.settingEl.addClass("wallvia-error-row");
        setting.addButton((b) =>
          b.setButtonText("忽略").onClick(() => {
            this.plugin.lastError = null;
            this.refresh();
          })
        );
      },
    };
  }
  /**
   * The preview under the image row. Resolution is defensive on purpose: the
   * effect controls *below* the preview are what the preview is for, so a
   * failure here must never end up hiding them.
   */
  private appendPreview(host: HTMLElement): void {
    const s = this.plugin.settings;
    const resource = this.resourceUrl(s.image);
    if (resource) {
      const el = host.createDiv({ cls: "wallvia-preview" });
      el.style.backgroundImage = `url("${resource}")`;
      // No inline background-size: styles.css pins the preview to `contain` so
      // the whole image is visible whatever the wallpaper's own fit is.
      el.style.opacity = String(s.opacity);
      // Say what the preview is, not just what it looks like: the same still is
      // either a wallpaper or the poster of a moving one, and there was no way
      // to tell which from this page.
      if (s.videoPath) {
        host.createDiv({
          cls: "wallvia-preview-note",
          text: s.videoWallpaper ? "视频壁纸 · 播放中(上图是封面)" : "视频壁纸 · 已关闭播放(只显示封面)",
        });
      }
    } else if (s.image) {
      host.createDiv({
        cls: "wallvia-preview wallvia-preview-missing",
        text: "找不到图片:" + s.image,
      });
    }
  }

  /**
   * `app://` URL for a vault-relative image path, or "" when it cannot be
   * resolved. `vault.getResourcePath(file)` is the documented API; the adapter
   * overload stays as a fallback. Every failure mode is swallowed so the
   * settings page always finishes rendering.
   */
  private resourceUrl(path: string): string {
    if (!path) return "";
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) return this.app.vault.getResourcePath(file);
    } catch {
      // Fall through to the adapter overload.
    }
    try {
      return this.app.vault.adapter.getResourcePath(path);
    } catch {
      return "";
    }
  }

  // --------------------------------- imperative fallback (Obsidian < 1.13)

  /**
   * The same page for builds before 1.13: walk the shared row list and build
   * `Setting` rows from it.
   *
   * Values and side effects go through the same `getControlValue` /
   * `setControlValue` pair the declarative path uses, so the two renderers
   * cannot disagree about what a control reads, what it writes, or which
   * changes re-render the page.
   */
  display() {
    const { containerEl } = this;
    containerEl.empty();
    this.renderLegacy(containerEl, this.rows());
  }

  private renderLegacy(host: HTMLElement, rows: SettingsRow[]): void {
    for (const row of rows) {
      if (row.kind === "group") {
        new Setting(host).setName(row.heading).setHeading();
        this.renderLegacy(host, row.rows);
        continue;
      }
      if (row.kind === "render") {
        // The declarative host renders name/desc from the definition; the
        // imperative row has to carry them itself or the row is untitled.
        row.render(new Setting(host).setName(row.name).setDesc(row.desc));
        continue;
      }
      if (row.kind === "action") {
        new Setting(host)
          .setName(row.name)
          .setDesc(row.desc)
          .addButton((b) => b.setButtonText(row.label).onClick(row.run));
        continue;
      }
      const setting = new Setting(host).setName(row.name).setDesc(row.desc);
      // `disabled` is only expressible here: the declarative API (1.13+) has no
      // per-item flag, so its rows carry the same fact in `desc` instead.
      if (row.disabled) setting.setDisabled(true);
      const key = row.key;
      const write = (value: unknown): void => {
        void this.setControlValue(key, value);
      };
      const control = row.control;
      if (control.type === "slider") {
        setting.addSlider((sl) =>
          sl
            .setLimits(control.min, control.max, control.step)
            .setValue(Number(this.getControlValue(key)))
            .onChange(write)
        );
      } else if (control.type === "dropdown") {
        setting.addDropdown((d) => {
          for (const option of control.options) d.addOption(option.value, option.label);
          return d.setValue(String(this.getControlValue(key))).onChange(write);
        });
      } else if (control.type === "text") {
        setting.addText((t) => {
          if (control.placeholder) t.setPlaceholder(control.placeholder);
          const current = this.getControlValue(key);
          return t.setValue(typeof current === "string" ? current : "").onChange(write);
        });
      } else {
        setting.addToggle((t) =>
          t.setValue(Boolean(this.getControlValue(key))).onChange(write)
        );
      }
    }
  }
  /** Detect on demand — the count changes while Obsidian stays open. */
  private async showWeStatus(statusEl: HTMLElement): Promise<void> {
    const list = await listWeWallpapers();
    if (!(await findWeRoot())) {
      statusEl.setText(WE_MISSING_NOTICE);
      return;
    }
    const videos = list.filter((w) => w.type === "video").length;
    // "首帧由 Obsidian 自己解码" described the old still-only behaviour. Videos
    // play now, so the line says what actually happens; the frame is only the
    // poster.
    statusEl.setText(
      videos
        ? this.plugin.settings.videoWallpaper
          ? `已找到 ${list.length} 张已下载壁纸(其中 ${videos} 张视频壁纸,会直接播放;抽帧只作封面)`
          : `已找到 ${list.length} 张已下载壁纸(其中 ${videos} 张视频壁纸,已关闭播放,只取一帧)`
        : `已找到 ${list.length} 张已下载壁纸`
    );
  }
}
// ------------------------------------------------------------- settings rows

/** One control slot in a row: the shape both renderers agree on. */
type SettingsControl =
  | { type: "toggle" }
  | { type: "slider"; min: number; max: number; step: number }
  | { type: "dropdown"; options: ReadonlyArray<{ value: string; label: string }> }
  | { type: "text"; placeholder?: string };

interface ControlRow {
  kind: "control";
  name: string;
  desc: string;
  key: string;
  control: SettingsControl;
  /**
   * Only honoured by the legacy `Setting` renderer (the declarative API has no
   * per-item disabled flag). The desc carries the same information for 1.13+,
   * so neither surface silently offers a switch that does nothing.
   */
  disabled?: boolean;
}
interface RenderRow {
  kind: "render";
  name: string;
  desc: string;
  render: (setting: Setting) => void;
}
interface ActionRow {
  kind: "action";
  name: string;
  desc: string;
  label: string;
  run: () => void;
}
interface GroupRow {
  kind: "group";
  heading: string;
  rows: SettingsRow[];
}
type SettingsRow = ControlRow | RenderRow | ActionRow | GroupRow;

function controlRow(
  name: string,
  desc: string,
  key: string,
  control: SettingsControl
): ControlRow {
  return { kind: "control", name, desc, key, control };
}

/** One row of the shared description as a 1.13+ declarative item. */
function rowToDefinition(row: SettingsRow): SettingDefinitionItem<string> {
  if (row.kind === "group") {
    // `SettingDefinitionGroup.items` only accepts settings and pages — groups
    // cannot nest, and this table is one level deep by construction.
    const items: SettingGroupItem<string>[] = [];
    for (const child of row.rows) {
      if (child.kind === "group") throw new Error("settings groups cannot nest");
      items.push(rowToLeaf(child));
    }
    return { type: "group", heading: row.heading, items };
  }
  return rowToLeaf(row);
}

/** A leaf row (anything but a group) as a declarative item or page item. */
function rowToLeaf(row: Exclude<SettingsRow, GroupRow>): SettingGroupItem<string> {
  if (row.kind === "action") return { name: row.name, desc: row.desc, action: row.run };
  if (row.kind === "render") return { name: row.name, desc: row.desc, render: row.render };
  const control = row.control;
  if (control.type === "dropdown") {
    return {
      name: row.name,
      desc: row.desc,
      control: {
        key: row.key,
        type: "dropdown",
        options: dropdownOptions(control.options),
      },
    };
  }
  if (control.type === "slider") {
    return {
      name: row.name,
      desc: row.desc,
      control: { key: row.key, type: "slider", min: control.min, max: control.max, step: control.step },
    };
  }
  if (control.type === "text") {
    return {
      name: row.name,
      desc: row.desc,
      control: { key: row.key, type: "text", placeholder: control.placeholder },
    };
  }
  return { name: row.name, desc: row.desc, control: { key: row.key, type: "toggle" } };
}
