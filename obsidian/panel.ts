/**
 * Wallvia — the in-app floating panel.
 *
 * Ported from the DSH `dsh-web-all` wallpaper plugin (`lib/client.js`), which
 * puts the wallpaper controls *in the app* instead of in a settings page: a
 * draggable picture button in the window corner opens a panel holding the
 * image preview and every effect control.
 *
 * Structure, top to bottom, matches the original:
 *
 *   [✕]  Enabled  |  preview  |  choose / replace  |  Fit  |  Dim  |  Glass
 *
 * plus the two controls this port adds everywhere it runs (Blur, Opacity), and
 * Wallpaper Engine selection, which is this project's whole reason to exist.
 * Every change is applied and saved immediately — no OK button — so the panel
 * can stay open while the wallpaper is tuned.
 */
import { Setting } from "obsidian";
import { DESCS, FIT_OPTIONS, LABELS, WPSettings, clamp, resetEffects } from "./settings";

/** What the panel needs from the plugin; `WallpaperPlugin` satisfies it. */
export interface PanelHost {
  settings: WPSettings;
  /** Resolved `app://` URL of the current image, "" when there is none. */
  imageUrl: string;
  apply(): Promise<void>;
  saveSettings(): Promise<void>;
  pickLocalImage(): void;
  pickWeWallpaper(): void;
  weAvailable(): boolean;
}

const FAB_CLS = "wallvia-fab";
/** Set on the button while the panel is open, so it becomes fully opaque. */
const FAB_OPEN_CLS = "wallvia-fab-open";
const PANEL_CLS = "wallvia-panel";

/**
 * User-visible strings. They live in a constant because the community lint
 * rule (`ui/sentence-case`) would otherwise demand lowercasing proper nouns
 * such as "Wallpaper Engine" — the same reason main.ts keeps the WE_* names.
 */
const T = {
  title: "Wallvia",
  close: "关闭",
  empty: "还没有选择壁纸",
  choose: "选择图片…",
  replace: "更换图片…",
  we: "从 Wallpaper Engine 选择…",
  remove: "移除",
  reset: "恢复默认效果",
};

/** Set several CSS properties at once (no direct style assignment: lint). */
function css(el: HTMLElement, props: Record<string, string>): void {
  for (const [key, value] of Object.entries(props)) el.style.setProperty(key, value);
}

/** The original's glyph — a framed picture — built as SVG, never as HTML. */
function buildIcon(parent: HTMLElement): void {
  const svg = parent.createSvg("svg", {
    attr: {
      viewBox: "0 0 24 24",
      width: "20",
      height: "20",
      "aria-hidden": "true",
      focusable: "false",
    },
  });
  svg.createSvg("path", {
    attr: {
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linejoin": "round",
      d: "M3.5 5.5h17v13h-17zM3.5 15l4.5-4.5 3.5 3.5 3-3 6 6",
    },
  });
  svg.createSvg("circle", { attr: { cx: "8.6", cy: "9.2", r: "1.4", fill: "currentColor" } });
}

export class WallpaperPanel {
  private fab: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private open = false;
  private dragOffset = { left: 0, top: 0 };
  private moved = false;

  constructor(private host: PanelHost) {}

  // ------------------------------------------------------------- lifecycle

  /** Show the panel, creating the button and the panel on first use. */
  openPanel(): void {
    this.ensureChrome();
    this.render();
    this.fab?.addClass(FAB_OPEN_CLS);
    this.panel?.removeClass("wallvia-hidden");
    this.placePanel();
    this.open = true;
  }

  closePanel(): void {
    this.fab?.removeClass(FAB_OPEN_CLS);
    if (this.panel) this.panel.addClass("wallvia-hidden");
    this.open = false;
  }

  toggle(): void {
    if (this.open) this.closePanel();
    else this.openPanel();
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Re-render while open (the image changed from a picker elsewhere). */
  refresh(): void {
    if (this.open) this.render();
  }

  /** Remove both elements from the DOM (plugin unload / disable). */
  destroy(): void {
    this.fab?.remove();
    this.panel?.remove();
    this.fab = null;
    this.panel = null;
    this.open = false;
  }

  // ----------------------------------------------------------------- chrome

  private ensureChrome(): void {
    if (!this.fab) {
      this.fab = document.body.createDiv({ cls: FAB_CLS });
      this.fab.setAttribute("role", "button");
      this.fab.setAttribute("tabindex", "0");
      this.fab.setAttribute("aria-label", T.title);
      this.fab.title = T.title;
      buildIcon(this.fab);
      this.applyFabPosition();
      this.wireDrag();
      this.fab.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.toggle();
        }
      });
    }
    if (!this.panel) {
      this.panel = document.body.createDiv({ cls: PANEL_CLS + " wallvia-hidden" });
      this.panel.setAttribute("role", "dialog");
      this.panel.setAttribute("aria-label", "Wallvia");
      // The panel follows the button, so a dragged button keeps its panel.
      this.panel.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape") this.closePanel();
      });
    }
  }

  /** Restore a dragged position, else the default bottom-right corner. */
  private applyFabPosition(): void {
    if (!this.fab) return;
    const { fabLeft, fabTop } = this.host.settings;
    if (typeof fabLeft === "number" && typeof fabTop === "number") {
      this.placeFab(fabLeft, fabTop);
      return;
    }
    css(this.fab, { left: "auto", top: "auto", right: "18px", bottom: "48px" });
  }

  private static readonly SIZE = 40;
  private static readonly PANEL_W = 320;
  private static readonly PANEL_H = 460;

  /** Absolute button placement, clamped so it can never be dragged away. */
  private placeFab(left: number, top: number): void {
    if (!this.fab) return;
    const size = WallpaperPanel.SIZE;
    const l = clamp(left, 0, Math.max(0, window.innerWidth - size));
    const t = clamp(top, 0, Math.max(0, window.innerHeight - size));
    css(this.fab, { left: l + "px", top: t + "px", right: "auto", bottom: "auto" });
    this.dragOffset = { left: l, top: t };
    this.placePanel();
  }

  /**
   * The panel opens next to the button. With no dragged position it keeps the
   * stylesheet default (bottom-right, above the button).
   */
  private placePanel(): void {
    const panel = this.panel;
    if (!panel) return;
    const { fabLeft, fabTop } = this.host.settings;
    if (typeof fabLeft !== "number" || typeof fabTop !== "number") {
      css(panel, { left: "auto", top: "auto", right: "18px", bottom: "96px" });
      return;
    }
    const above = fabTop > WallpaperPanel.PANEL_H;
    css(panel, {
      left: clamp(fabLeft, 0, Math.max(0, window.innerWidth - WallpaperPanel.PANEL_W)) + "px",
      right: "auto",
      top: above ? "auto" : fabTop + WallpaperPanel.SIZE + 8 + "px",
      bottom: above ? window.innerHeight - fabTop + 8 + "px" : "auto",
    });
  }

  /** Pointer drag with a click threshold, like the original. */
  private wireDrag(): void {
    const fab = this.fab;
    if (!fab) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    fab.addEventListener("pointerdown", (e: PointerEvent) => {
      dragging = true;
      this.moved = false;
      const rect = fab.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      fab.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    fab.addEventListener("pointermove", (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!this.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      this.moved = true;
      this.placeFab(originLeft + dx, originTop + dy);
    });

    const end = () => {
      if (!dragging) return;
      dragging = false;
      if (!this.moved) {
        this.toggle();
        return;
      }
      // Remember where the user put it (the original persists this too).
      this.host.settings.fabLeft = Math.round(this.dragOffset.left);
      this.host.settings.fabTop = Math.round(this.dragOffset.top);
      void this.host.saveSettings();
    };
    fab.addEventListener("pointerup", end);
    fab.addEventListener("pointercancel", () => {
      dragging = false;
    });
  }

  // ------------------------------------------------------------- rendering

  /** Rebuild the panel body from the current settings. */
  private render(): void {
    const panel = this.panel;
    if (!panel) return;
    const s = this.host.settings;
    panel.empty();

    const head = panel.createDiv({ cls: "wallvia-panel-head" });
    head.createDiv({ cls: "wallvia-panel-title", text: T.title });
    const close = head.createEl("button", {
      cls: "wallvia-panel-close",
      attr: { type: "button", "aria-label": T.close },
      text: "✕",
    });
    close.addEventListener("click", () => this.closePanel());

    // 1) Enable — the original puts this above the preview.
    new Setting(panel)
      .setName(LABELS.enable)
      .setDesc(DESCS.enable)
      .addToggle((t) =>
        t.setValue(s.enabled).onChange((v) => {
          s.enabled = v;
          this.commit(true);
        })
      );

    // 2) Preview — the same preview box as the original's `.wp-preview`, but
    //    `contain` (from styles.css) so the whole image is visible instead of
    //    a cropped centre strip. The wallpaper's own fit still applies to the
    //    real background.
    const preview = panel.createDiv({ cls: "wallvia-panel-preview" });
    if (this.host.imageUrl) {
      preview.style.backgroundImage = `url("${this.host.imageUrl}")`;
      preview.style.opacity = String(clamp(s.opacity, 0, 1));
    } else {
      preview.addClass("wallvia-panel-preview-empty");
      preview.setText(T.empty);
    }

    // 3) Choose / replace / remove.
    const actions = panel.createDiv({ cls: "wallvia-panel-actions" });
    const pick = actions.createEl("button", {
      cls: "wallvia-btn",
      text: this.host.imageUrl ? T.replace : T.choose,
    });
    pick.addEventListener("click", () => this.host.pickLocalImage());
    if (this.host.weAvailable()) {
      const we = actions.createEl("button", { cls: "wallvia-btn", text: T.we });
      we.addEventListener("click", () => this.host.pickWeWallpaper());
    }
    if (this.host.imageUrl) {
      const remove = actions.createEl("button", {
        cls: "wallvia-btn wallvia-btn-danger",
        text: T.remove,
      });
      remove.addEventListener("click", () => {
        s.image = "";
        this.commit(true);
      });
    }
    const reset = actions.createEl("button", { cls: "wallvia-btn", text: T.reset });
    reset.addEventListener("click", () => {
      resetEffects(s);
      this.commit(true);
    });

    // 4) Effects — Fit, then the sliders (original order: Dim, Glass).
    new Setting(panel)
      .setName(LABELS.fit)
      .setDesc(DESCS.fit)
      .addDropdown((d) => {
        for (const option of FIT_OPTIONS) d.addOption(option.value, option.label);
        return d.setValue(s.fit).onChange((v) => {
          s.fit = v as WPSettings["fit"];
          this.commit(true);
        });
      });

    this.slider(panel, LABELS.dim, DESCS.dim, s.dim, 0, 1, 0.05, "", (v) => {
      s.dim = v;
    });
    this.slider(panel, LABELS.glass, DESCS.glass, s.glass, 0, 100, 1, "%", (v) => {
      s.glass = v;
    });
    this.slider(panel, LABELS.embed, DESCS.embed, s.embed, 0, 100, 1, "%", (v) => {
      s.embed = v;
    });
    this.slider(panel, LABELS.blur, DESCS.blur, s.blur, 0, 40, 1, "px", (v) => {
      s.blur = v;
    });
    this.slider(panel, LABELS.opacity, DESCS.opacity, s.opacity, 0, 1, 0.05, "", (v) => {
      s.opacity = v;
    });
  }

  /**
   * One effect row. Sliders persist on every change but never re-render the
   * panel (that would drop the control mid-drag); only the read-out label and
   * the preview follow.
   */
  private slider(
    parent: HTMLElement,
    name: string,
    desc: string,
    value: number,
    min: number,
    max: number,
    step: number,
    unit: string,
    assign: (v: number) => void
  ): void {
    const label = (v: number) => `${name} — ${format(v, step)}${unit}`;
    const setting = new Setting(parent).setName(label(value)).setDesc(desc);
    setting.addSlider((sl) =>
      sl
        .setLimits(min, max, step)
        .setValue(value)
        .onChange((v) => {
          assign(v);
          setting.setName(label(v));
          this.commit(false);
        })
    );
  }

  /** Apply + save, updating the preview only when it actually changed. */
  private commit(previewChanged: boolean): void {
    void this.host.apply();
    void this.host.saveSettings();
    if (previewChanged) this.render();
    else this.refreshPreview();
  }

  private refreshPreview(): void {
    const box = this.panel?.querySelector<HTMLElement>(".wallvia-panel-preview");
    const s = this.host.settings;
    if (!box || !this.host.imageUrl) return;
    box.style.opacity = String(clamp(s.opacity, 0, 1));
  }
}

/** Integers for the coarse rows, two decimals for the 0-1 rows. */
function format(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  return value.toFixed(2);
}
