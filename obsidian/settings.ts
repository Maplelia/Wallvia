/**
 * Wallvia — shared settings shape, defaults and pure helpers.
 *
 * Kept apart from `main.ts` so the floating panel (`panel.ts`) can use the same
 * types without importing the plugin (which imports the panel).
 *
 * The numbers follow the DSH `dsh-web-all` wallpaper plugin and the VS Code
 * port, so the same picture looks the same on every target:
 *
 *   dsh-web-all        Wallvia (VS Code)      Wallvia (Obsidian)
 *   Fit  cover/…       wallvia.fit            fit
 *   Dim  0-70%         wallvia.dim 0-80        dim   0-1
 *   Glass 0-100%       wallvia.glass 0-100     glass 0-100
 */

/** cover/fill/center replace the older cover/contain/fill/tile. */
export type WPFit = "cover" | "fill" | "center";

/**
 * Colour of the readability wash painted over the wallpaper.
 * `auto` follows the theme, `dark`/`light` pin it, `custom` uses `washColor`.
 */
export type WPWash = "auto" | "dark" | "light" | "custom";

export interface WPSettings {
  image: string; // vault-relative path, e.g. "Wallpapers/wall.png"
  opacity: number; // background layer opacity 0-1
  dim: number; // dim overlay strength 0-1
  blur: number; // glass blur radius (px)
  glass: number; // translucent surface strength 0-100 (dsh-web-all "Glass")
  /**
   * Transparency applied to an embedded plugin web view (an <iframe> a plugin
   * puts in a pane, e.g. opencode-obsidian). 0 leaves the frame untouched.
   */
  embed: number;
  fit: WPFit;
  enabled: boolean;
  wash: WPWash;
  /** `#rrggbb`, only read when `wash` is "custom". */
  washColor: string;
  /**
   * Prefer the artwork inside `scene.pkg` (or an unpacked project's own files)
   * over Wallpaper Engine's square `preview.*`. Off means the preview is used
   * everywhere — never a blank card.
   */
  hires: boolean;
  /** Decode one frame of a video wallpaper instead of using its square preview. */
  videoFrames: boolean;
  /**
   * Upper bound, in pixels, on the width of any artwork taken out of a package.
   * `0` = no bound (the sharpest level). Only ever picks a smaller mipmap level;
   * nothing is ever resampled.
   */
  maxImageWidth: number;
  weCacheDir: string; // vault folder for copied Wallpaper Engine previews
  /** Draggable button position in px; undefined = the default bottom-right. */
  fabLeft?: number;
  fabTop?: number;
  /** Legacy 0.2.1 on/off switch; read once during migration, never written. */
  glassEditors?: boolean;
}

export const DEFAULTS: WPSettings = {
  image: "",
  opacity: 0.6,
  dim: 0.35,
  blur: 10,
  glass: 55,
  embed: 0,
  fit: "cover",
  enabled: true,
  wash: "auto",
  washColor: "#080a12",
  hires: true,
  videoFrames: true,
  maxImageWidth: 0,
  weCacheDir: "Wallpapers",
};

/** Bounds of the "maximum source width" setting, matching the VS Code port. */
export const MAX_IMAGE_WIDTH = { min: 0, max: 7680, step: 160 };

/**
 * `--wallvia-fit` feeds `background-size` directly; centering is already
 * handled by the layer's `background-position: center`, so `center` means
 * "natural size, no scaling".
 */
export const FIT_CSS: Record<WPFit, string> = {
  cover: "cover",
  fill: "100% 100%",
  center: "auto",
};

/**
 * User-visible control names, shared by the settings tab and the in-app panel
 * so the two surfaces cannot drift apart. They live in a constant because the
 * community lint rule (`ui/sentence-case`) would otherwise demand lowercasing
 * the proper nouns in them.
 */
export const LABELS = {
  enable: "启用 Enabled",
  image: "背景图片",
  fit: "对齐方式 Fit",
  dim: "压暗 Dim",
  glass: "通透 Glass",
  embed: "嵌入面板透明度",
  blur: "模糊 Blur",
  opacity: "图片不透明度",
  wash: "压暗颜色 Wash",
  hires: "场景包取原图",
  videoFrames: "视频抽帧",
  maxImageWidth: "最大图源宽度",
};

/**
 * One-line explanations, shared by the settings tab and the in-app panel. The
 * two surfaces used to carry their own abbreviated copies and drifted apart;
 * both now read these.
 */
export const DESCS = {
  enable: "在工作区后面显示壁纸。",
  image: "选择 vault 里的本地图片;选择后会复制一份到缓存目录。",
  fit: "图片如何铺满工作区。",
  dim: "遮罩强度,数值越大文字越清晰(0-1)。",
  glass: "编辑器表面的透明程度(0-100);0 = 完全不透明,100 = 最通透。",
  embed: "插件嵌入网页面板时(opencode 等),给那个网页加一层整体透明度;0 = 保持原样。",
  blur: "毛玻璃模糊半径(px);0 = 不模糊。",
  opacity: "背景图片自身的不透明度(0-1),不影响文字。",
  wash: "遮罩层用什么颜色压暗壁纸;auto 跟随主题(暗色偏黑、亮色偏白)。",
  hires: "优先使用 scene.pkg 里的原图,而不是 Wallpaper Engine 那张方形预览图;关掉后壁纸会变糊,但不会变成空白。",
  videoFrames: "视频壁纸取视频里的一帧当预览;关掉后改用它的方形预览图。已缓存的帧不会被删除。",
  maxImageWidth:
    "取原图 / 视频帧的最大宽度(px);0 = 用最清晰的一级(4K 图约 33MB 显存),视频卡片帧 960。只挑更小的 mipmap 级,不缩放;填大值会让视频卡片帧一起变清晰。",
};

/** Fit choices, so the dropdown cannot differ between the two surfaces. */
export const FIT_OPTIONS: ReadonlyArray<{ value: WPFit; label: string }> = [
  { value: "cover", label: "覆盖 Cover" },
  { value: "fill", label: "填充 Fill" },
  { value: "center", label: "居中 Center" },
];

/** Wash choices; `custom` reveals the colour picker. */
export const WASH_OPTIONS: ReadonlyArray<{ value: WPWash; label: string }> = [
  { value: "auto", label: "跟随主题 Auto" },
  { value: "dark", label: "深色 Dark" },
  { value: "light", label: "浅色 Light" },
  { value: "custom", label: "自定义 Custom" },
];

/**
 * The wash colours already used by the VS Code port, so the same picture looks
 * the same on every target. They are deliberately not pure black/white: a hard
 * #000 wash crushes the wallpaper and #fff blows it out.
 */
const WASH_DARK = "8 10 18";
const WASH_LIGHT = "246 247 250";

/**
 * `R G B` triplet for the wash, ready for `rgb(var(--wallvia-wash) / alpha)`.
 * `lightTheme` only matters for `auto`; the pinned choices ignore it.
 */
export function washRgb(
  settings: Pick<WPSettings, "wash" | "washColor">,
  lightTheme: boolean
): string {
  const fallback = lightTheme ? WASH_LIGHT : WASH_DARK;
  switch (settings.wash) {
    case "dark":
      return WASH_DARK;
    case "light":
      return WASH_LIGHT;
    case "custom":
      return hexTriplet(settings.washColor) ?? fallback;
    default:
      return fallback;
  }
}

/** `#rrggbb` → `"r g b"`; `null` for anything that is not a plain hex colour. */
function hexTriplet(value: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/**
 * Reset every *effect* back to its default while keeping what identifies the
 * current setup: the wallpaper itself, the cache folder, the panel button
 * position, and the three behaviour switches (which are not effects).
 */
export function resetEffects(settings: WPSettings): void {
  Object.assign(settings, DEFAULTS, {
    image: settings.image,
    weCacheDir: settings.weCacheDir,
    fabLeft: settings.fabLeft,
    fabTop: settings.fabTop,
    hires: settings.hires,
    videoFrames: settings.videoFrames,
    maxImageWidth: settings.maxImageWidth,
  });
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Accept legacy data.json values (contain/tile) without crashing. */
export function normalizeFit(value: unknown): WPFit {
  if (value === "cover" || value === "fill" || value === "center") return value;
  if (value === "contain") return "center";
  if (value === "tile") return "fill";
  return "cover";
}

/**
 * Pane fill for a Glass level: 0 keeps surfaces opaque, 100 is the maximum
 * translucency. A 35% floor stays so text keeps a readable seat — the same
 * floor `dsh-web-all` uses for its base surface and the VS Code port writes.
 */
export function glassFill(level: number): string {
  return (35 + (100 - clamp(level, 0, 100)) * 0.65).toFixed(1) + "%";
}

/**
 * Opacity for an embedded plugin web view. A plugin can put a whole web app in
 * an <iframe> (opencode-obsidian serves opencode on http://127.0.0.1:14096 and
 * embeds it, passing `--cors app://obsidian.md` — which is itself proof the
 * frame is cross-origin). That inner document paints its own opaque background
 * and no stylesheet here can reach it, so compositing the frame is the only
 * lever: `opacity` on the element fades the embedded page, background and text
 * together, and the wallpaper shows through.
 *
 * 0 leaves the frame exactly as the plugin drew it. 100 is the most
 * see-through, with the same 0.35 floor as the pane fill: past that the
 * embedded UI stops being readable, and the point of the setting is a
 * see-through panel, not an unusable one.
 */
export function embedOpacity(level: number): string {
  return (1 - (clamp(level, 0, 100) / 100) * 0.65).toFixed(2);
}

/**
 * 0.2.1 stored `glassEditors: boolean`; map it onto the 0-100 level so an
 * existing install keeps roughly the look it had.
 */
export function migrateGlass(saved: Partial<WPSettings> | null | undefined): number {
  const level = saved?.glass;
  if (typeof level === "number" && Number.isFinite(level)) return clamp(level, 0, 100);
  if (typeof saved?.glassEditors === "boolean") {
    return saved.glassEditors ? DEFAULTS.glass : 0;
  }
  return DEFAULTS.glass;
}
