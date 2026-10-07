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
  SettingDefinition,
  SettingDefinitionItem,
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
          this.invalidateImage();
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
      name: "Toggle wallpaper",
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        void this.apply();
        void this.saveSettings();
        this.panel.refresh();
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
    } catch {
      // Unreadable or missing: fall through to "no image".
    }
    this.resolved = null;
    this.imageUrl = "";
  }

  async apply() {
    await this.resolveImage();
    const body = document.body;
    const active = this.settings.enabled && !!this.imageUrl;
    body.classList.toggle("wallvia-enabled", active);
    // Glass is a 0-100 level now (dsh-web-all's "Glass" slider); 0 means the
    // surfaces stay opaque, so the class is only applied above 0.
    body.classList.toggle("wallvia-glass", active && this.settings.glass > 0);
    const st = body.style;
    setCss(st, "--wallvia-image", this.imageUrl ? `url("${this.imageUrl}")` : "none");
    setCss(st, "--wallvia-opacity", String(this.settings.opacity));
    setCss(st, "--wallvia-dim", String(this.settings.dim));
    setCss(st, "--wallvia-blur", this.settings.blur + "px");
    setCss(st, "--wallvia-glass", glassFill(this.settings.glass));
    setCss(st, "--wallvia-embed-opacity", embedOpacity(this.settings.embed));
    setCss(st, "--wallvia-fit", FIT_CSS[this.settings.fit]);
    // The wash follows the theme unless the user pinned it; `theme-light` is
    // Obsidian's own class, so a theme switch only needs the css-change event
    // that already calls apply().
    setCss(st, "--wallvia-wash", washRgb(this.settings, body.classList.contains("theme-light")));
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
    const dir = normalizeCacheDir(this.settings.weCacheDir);
    // Ids are workshop numbers or project folder names; keep them filename-safe.
    const id = wallpaper.id.replace(/[^A-Za-z0-9._-]/g, "_");
    const hiRes =
      this.settings.hires && wallpaper.type === "scene"
        ? await readSceneHiResImage(wallpaper.dir, this.settings.maxImageWidth)
        : null;
    // A video has no still of its own, so the frame the picker shows is what
    // gets applied. Without this the wallpaper fell back to Wallpaper Engine's
    // square preview, which a 16:9 window upscales ~3x — the "帧截取没生效" case.
    const frame =
      !hiRes && this.settings.videoFrames && wallpaper.type === "video"
        ? await this.videoStill(wallpaper)
        : null;
    const bytes = hiRes?.bytes ?? frame?.bytes ?? (await readImageArrayBuffer(wallpaper.preview));
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
      new Notice("复制壁纸到 vault 失败:" + errorMessage(e));
      return;
    }
    await pruneWeCache(this.app, dir, target);
    this.settings.image = target;
    // Picking a wallpaper means wanting to see it. Without this, choosing one
    // while the wallpaper is toggled off wrote the file and quietly changed
    // nothing — the "选中后没反应" case.
    this.settings.enabled = true;
    await this.apply();
    await this.saveSettings();
    this.panel.refresh();
    new Notice(
      hiRes
        ? `壁纸已应用:${wallpaper.title}(${hiRes.width}×${hiRes.height} 原始画面)`
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
    if (this.applyTimer !== null) {
      window.clearTimeout(this.applyTimer);
      this.applyTimer = null;
    }
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

/** Vault-relative folder for copied previews; never empty, never rooted. */
function normalizeCacheDir(value: string): string {
  const cleaned = value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim();
  return cleaned || DEFAULTS.weCacheDir;
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

/** Delete previously copied previews so the cache folder holds only one file. */
async function pruneWeCache(app: App, dir: string, keep: string): Promise<void> {
  try {
    const listed = await app.vault.adapter.list(dir);
    for (const file of listed.files) {
      if (file === keep) continue;
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (!name.startsWith(WE_CACHE_PREFIX)) continue;
      try {
        await app.vault.adapter.remove(file);
      } catch {
        // Locked or already gone — not worth interrupting the user.
      }
    }
  } catch {
    // Unreadable cache folder: keep the new file, skip the cleanup.
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
const REBUILD_KEYS: ReadonlySet<string> = new Set(["enabled", "fit", "hires", "videoFrames"]);

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
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const items: SettingDefinitionItem[] = [
      {
        name: LABELS.enable,
        desc: DESCS.enable,
        control: { key: "enabled", type: "toggle" },
      },
      this.imageDefinition(),
      {
        name: LABELS.fit,
        desc: DESCS.fit,
        control: {
          key: "fit",
          type: "dropdown",
          options: dropdownOptions(FIT_OPTIONS),
        },
      },
      this.sliderDefinition(LABELS.dim, DESCS.dim, "dim", 0, 1, 0.05),
      this.sliderDefinition(LABELS.glass, DESCS.glass, "glass", 0, 100, 1),
      this.sliderDefinition(LABELS.embed, DESCS.embed, "embed", 0, 100, 1),
      this.sliderDefinition(LABELS.blur, DESCS.blur, "blur", 0, 40, 1),
      this.sliderDefinition(LABELS.opacity, DESCS.opacity, "opacity", 0, 1, 0.05),
      this.washDefinition(),
      {
        name: "恢复默认效果",
        desc: "把上面的效果项恢复为默认值;当前壁纸、缓存目录和可选行为不会改变。",
        action: () => {
          resetEffects(s);
          void this.commit();
        },
      },
    ];

    // Node APIs are unavailable on mobile, so the whole section is absent
    // there instead of offering a button that can never work. Two sibling
    // top-level groups, because `SettingDefinitionGroup.items` only accepts
    // settings and pages — groups cannot nest.
    if (this.plugin.weAvailable()) {
      items.push({
        type: "group",
        heading: WE_NAME,
        items: [
          this.wePickerDefinition(),
          {
            name: "缓存目录",
            desc: "复制过来的壁纸预览存放的 vault 目录。",
            control: {
              key: "weCacheDir",
              type: "text",
              placeholder: DEFAULTS.weCacheDir,
            },
          },
        ],
      });
      items.push({
        type: "group",
        heading: "可选行为",
        items: [
          {
            name: LABELS.hires,
            desc: DESCS.hires,
            control: { key: "hires", type: "toggle" },
          },
          {
            name: LABELS.videoFrames,
            desc: DESCS.videoFrames,
            control: { key: "videoFrames", type: "toggle" },
          },
          this.sliderDefinition(
            LABELS.maxImageWidth,
            DESCS.maxImageWidth,
            "maxImageWidth",
            MAX_IMAGE_WIDTH.min,
            MAX_IMAGE_WIDTH.max,
            MAX_IMAGE_WIDTH.step
          ),
        ],
      });
    }

    return items;
  }

  private sliderDefinition(
    name: string,
    desc: string,
    key: string,
    min: number,
    max: number,
    step: number
  ): SettingDefinition {
    return { name, desc, control: { key, type: "slider", min, max, step } };
  }

  /**
   * The image row: two buttons in one row plus the preview below it, so it
   * cannot be a single declarative `control`.
   */
  private imageDefinition(): SettingDefinition {
    const s = this.plugin.settings;
    return {
      name: LABELS.image,
      desc: DESCS.image,
      render: (setting) => {
        setting.addButton((b) =>
          b.setButtonText("选择图片…").onClick(() => {
            new ImagePicker(this.app, (p) => {
              s.image = p;
              s.enabled = true;
              void this.commit();
            }).open();
          })
        );
        setting.addButton((b) =>
          b.setButtonText("清除").onClick(() => {
            s.image = "";
            void this.commit();
          })
        );
        // The preview is not a declarative control: it is a custom element
        // whose URL can fail to resolve. It belongs under the row, in the same
        // list the row itself was appended to.
        this.appendPreview(setting.settingEl.parentElement ?? this.containerEl);
      },
    };
  }

  /** The wash row: a dropdown *and* a colour picker, one gesture each. */
  private washDefinition(): SettingDefinition {
    const s = this.plugin.settings;
    return {
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
  private wePickerDefinition(): SettingDefinition {
    return {
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

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName(LABELS.enable)
      .setDesc(DESCS.enable)
      .addToggle((t) =>
        t.setValue(s.enabled).onChange((v) => {
          s.enabled = v;
          void this.commit();
        })
      );

    new Setting(containerEl)
      .setName(LABELS.image)
      .setDesc(DESCS.image)
      .addButton((b) =>
        b.setButtonText("选择图片…").onClick(() => {
          new ImagePicker(this.app, (p) => {
            s.image = p;
            s.enabled = true;
            void this.commit();
          }).open();
        })
      )
      .addButton((b) =>
        b.setButtonText("清除").onClick(() => {
          s.image = "";
          void this.commit();
        })
      );

    this.appendPreview(containerEl);

    new Setting(containerEl)
      .setName(LABELS.fit)
      .setDesc(DESCS.fit)
      .addDropdown((d) => {
        for (const option of FIT_OPTIONS) d.addOption(option.value, option.label);
        return d.setValue(s.fit).onChange((v) => {
          s.fit = normalizeFit(v);
          void this.commit();
        });
      });

    new Setting(containerEl)
      .setName(LABELS.dim)
      .setDesc(DESCS.dim)
      .addSlider((sl) =>
        sl
          .setLimits(0, 1, 0.05)
          .setValue(s.dim)
          .onChange((v) => {
            s.dim = v;
            void this.persist();
          })
      );

    new Setting(containerEl)
      .setName(LABELS.glass)
      .setDesc(DESCS.glass)
      .addSlider((sl) =>
        sl
          .setLimits(0, 100, 1)
          .setValue(s.glass)
          .onChange((v) => {
            s.glass = v;
            void this.persist();
          })
      );

    new Setting(containerEl)
      .setName(LABELS.embed)
      .setDesc(DESCS.embed)
      .addSlider((sl) =>
        sl
          .setLimits(0, 100, 1)
          .setValue(s.embed)
          .onChange((v) => {
            s.embed = v;
            void this.persist();
          })
      );

    new Setting(containerEl)
      .setName(LABELS.blur)
      .setDesc(DESCS.blur)
      .addSlider((sl) =>
        sl
          .setLimits(0, 40, 1)
          .setValue(s.blur)
          .onChange((v) => {
            s.blur = v;
            void this.persist();
          })
      );

    new Setting(containerEl)
      .setName(LABELS.opacity)
      .setDesc(DESCS.opacity)
      .addSlider((sl) =>
        sl
          .setLimits(0, 1, 0.05)
          .setValue(s.opacity)
          .onChange((v) => {
            s.opacity = v;
            void this.persist();
          })
      );

    new Setting(containerEl)
      .setName(LABELS.wash)
      .setDesc(DESCS.wash)
      .addDropdown((d) => {
        for (const option of WASH_OPTIONS) d.addOption(option.value, option.label);
        return d.setValue(s.wash).onChange((v) => {
          s.wash = v as WPWash;
          void this.commit();
        });
      })
      .addColorPicker((p) =>
        p.setValue(s.washColor).onChange((v) => {
          s.washColor = v;
          s.wash = "custom";
          void this.commit();
        })
      );

    new Setting(containerEl)
      .setName("恢复默认效果")
      .setDesc("把上面的效果项恢复为默认值;当前壁纸、缓存目录和可选行为不会改变。")
      .addButton((b) =>
        b.setButtonText("恢复默认").onClick(() => {
          resetEffects(s);
          void this.commit();
        })
      );

    // Node APIs are unavailable on mobile, so the whole section is hidden
    // there instead of offering a button that can never work.
    if (this.plugin.weAvailable()) this.displayWallpaperEngine(containerEl, s);
  }

  /**
   * The three behaviour switches the VS Code port also exposes.
   *
   * `liveApply` is deliberately absent: Obsidian writes its values straight into
   * CSS variables, so a change is already live. `themeAware` is the existing
   * `wash` model above, which has two extra modes over the VS Code one.
   */
  private displayBehaviour(containerEl: HTMLElement, s: WPSettings): void {
    new Setting(containerEl).setName("可选行为").setHeading();

    new Setting(containerEl)
      .setName(LABELS.hires)
      .setDesc(DESCS.hires)
      .addToggle((t) =>
        t.setValue(s.hires).onChange((v) => {
          s.hires = v;
          void this.commit();
        })
      );

    new Setting(containerEl)
      .setName(LABELS.videoFrames)
      .setDesc(DESCS.videoFrames)
      .addToggle((t) =>
        t.setValue(s.videoFrames).onChange((v) => {
          s.videoFrames = v;
          void this.commit();
        })
      );

    new Setting(containerEl)
      .setName(LABELS.maxImageWidth)
      .setDesc(DESCS.maxImageWidth)
      .addSlider((sl) =>
        sl
          .setLimits(MAX_IMAGE_WIDTH.min, MAX_IMAGE_WIDTH.max, MAX_IMAGE_WIDTH.step)
          .setValue(s.maxImageWidth)
          .onChange((v) => {
            s.maxImageWidth = v;
            void this.persist();
          })
      );
  }

  /** "Wallpaper Engine" section: picker button, status line, cache folder. */
  private displayWallpaperEngine(containerEl: HTMLElement, s: WPSettings): void {
    new Setting(containerEl).setName(WE_NAME).setHeading();

    this.displayBehaviour(containerEl, s);

    new Setting(containerEl)
      .setName("选择已下载的壁纸")
      .setDesc(WE_PICK_DESC)
      .addButton((b) =>
        b.setButtonText(WE_PICK_BUTTON).onClick(() => {
          void this.plugin.pickWallpaperEngine();
        })
      );

    const statusEl = containerEl.createDiv({ cls: "wallvia-we-status" });
    statusEl.setText("正在检测已下载的壁纸…");
    void this.showWeStatus(statusEl);

    new Setting(containerEl)
      .setName("缓存目录")
      .setDesc("复制过来的壁纸预览存放的 vault 目录。")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULTS.weCacheDir)
          .setValue(s.weCacheDir)
          .onChange((v) => {
            s.weCacheDir = v;
            void this.persist();
          })
      );
  }

  /** Detect on demand — the count changes while Obsidian stays open. */
  private async showWeStatus(statusEl: HTMLElement): Promise<void> {
    const list = await listWeWallpapers();
    if (!(await findWeRoot())) {
      statusEl.setText(WE_MISSING_NOTICE);
      return;
    }
    const videos = list.filter((w) => w.type === "video").length;
    statusEl.setText(
      videos
        ? `已找到 ${list.length} 张已下载壁纸(其中 ${videos} 张视频壁纸,首帧由 Obsidian 自己解码)`
        : `已找到 ${list.length} 张已下载壁纸`
    );
  }
}