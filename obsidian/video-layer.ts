/**
 * Wallvia — the video wallpaper layer.
 *
 * Why this file exists: everything else in the plugin paints a still image
 * through `background-image`, and CSS cannot play a video. A video wallpaper was
 * therefore flattened to one decoded frame — correct, sharp, and completely
 * still. This module puts a real `<video>` element behind the workspace instead,
 * and keeps the decoded frame as its poster, so the screen never shows a gap
 * between "the still is gone" and "the first frame arrived".
 *
 * The layer is a sibling of the `::before` wallpaper, both at `z-index: -1`:
 * `::before` paints first (it is the first generated box), the video layer next,
 * and the wash `::after` last — so the wash still sits on top of the moving
 * picture, exactly as it did on top of the still.
 *
 * Design rules, learned from the DSH plugin (which paid for them):
 *   - Never create a second `<video>`: one element, `src` swapped. Two decoders
 *     fight over the same file and the visible one starves.
 *   - Never leave a video decoding off-screen: pause on `visibilitychange` and
 *     on window blur, resume on return.
 *   - Unload means unload: `pause()` + `removeAttribute("src")` + `load()` is the
 *     only way Chromium releases the decoder and the file handle.
 *   - Autoplay with sound is refused by every browser. Start muted, and only
 *     retry unmuted on an explicit user gesture (the setting).
 */

/** Everything the layer needs to know for one paint. */
export interface VideoWallpaperState {
  /** Vault-relative path of the video file; "" removes the layer. */
  path: string;
  /** `app://` URL for that file (already cache-busted). */
  url: string;
  /** `app://` URL of the still used until the first frame decodes. */
  poster: string;
  /** CSS `object-fit` value for the current fit setting. */
  fit: string;
  /** Layer opacity, 0-1. */
  opacity: number;
  muted: boolean;
  pauseUnfocused: boolean;
}

/**
 * The `<video>` behind the workspace.
 *
 * One instance per plugin, created on first use. Every method is safe to call
 * when the DOM is missing (the unit tests run without a real renderer).
 */
export class VideoWallpaperLayer {
  private host: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  /** The `src` currently loaded, so a re-apply with the same file is a no-op. */
  private loaded = "";
  /** Set by `destroy()`; a late `play()` rejection must not touch a dead layer. */
  private disposed = false;
  private onFocus = () => this.syncPlayback();
  private onVisibility = () => this.syncPlayback();

  /** True when a video is on screen (the caller uses it for `we-live-on`-style classes). */
  get active(): boolean {
    return !!this.video && !!this.loaded;
  }

  /**
   * Paint `state`. Passing `path: ""` removes the layer.
   *
   * @param report receives non-fatal failures (autoplay refused, decode error)
   *   so the settings page can show them instead of a wallpaper that is simply
   *   not moving.
   */
  sync(state: VideoWallpaperState, report?: (at: string, e: unknown) => void): void {
    if (!state.path || !state.url) {
      this.destroy();
      return;
    }
    const el = this.ensure();
    if (!el) return;
    this.disposed = false;

    if (this.loaded !== state.url) {
      // Assign before load(): a `load()` on an empty element emits no events.
      el.src = state.url;
      this.loaded = state.url;
      el.load();
    }
    // The poster is the decoded still. It is what the first paint shows while
    // the demuxer is still reading, and what a paused video keeps showing.
    if (state.poster && el.poster !== state.poster) el.poster = state.poster;
    el.muted = state.muted;
    el.loop = true;
    el.autoplay = true;
    el.playsInline = true;
    el.style.objectFit = state.fit || "cover";
    if (this.host) this.host.style.opacity = String(state.opacity);
    // The class goes on `body`, not on the layer: the stylesheet uses it to
    // drop the still image underneath (the video covers it anyway, and the
    // poster is already showing that same picture).
    document.body?.classList.toggle("wallvia-video-on", true);

    // Autoplay: muted always works. Unmuted needs a gesture, so a rejection is
    // expected — fall back to muted playback rather than a frozen wallpaper.
    void el.play().catch((e: unknown) => {
      if (this.disposed) return;
      if (!el.muted) {
        el.muted = true;
        void el.play().catch((e2: unknown) => report?.("播放视频壁纸", e2 ?? e));
        return;
      }
      report?.("播放视频壁纸", e);
    });
    this.watch(state.pauseUnfocused);
  }

  /** Remove the layer and release the decoder. */
  destroy(): void {
    this.disposed = true;
    this.watching = false;
    this.detach();
    const el = this.video;
    this.video = null;
    this.loaded = "";
    if (el) {
      try {
        el.pause();
        // Order matters: dropping `src` and calling `load()` is what tells
        // Chromium to release the decoder and the open file handle. Just
        // removing the element leaves both alive until the next GC.
        el.removeAttribute("src");
        el.load();
      } catch {
        /* a dead element throws; nothing left to release */
      }
      el.remove();
    }
    this.host?.remove();
    this.host = null;
    if (typeof document !== "undefined") {
      document.body?.classList.remove("wallvia-video-on");
    }
  }

  /** Pause while hidden or unfocused; resume when the user comes back. */
  private syncPlayback(): void {
    const el = this.video;
    if (!el || !this.loaded || this.disposed) return;
    const hidden = typeof document !== "undefined" && document.hidden === true;
    const focused =
      typeof document === "undefined" || typeof document.hasFocus !== "function"
        ? true
        : document.hasFocus();
    if (hidden || !focused) {
      try {
        el.pause();
      } catch {
        /* pause on a released element is not an error worth reporting */
      }
    } else if (el.paused) {
      void el.play().catch(() => undefined);
    }
  }

  private watching = false;

  /**
   * Attach or detach the focus/visibility listeners.
   *
   * `watch` used to call `unwatch` in its disabled branch while `unwatch` guarded
   * on the same flag — two ways to express one transition, and the flag was
   * already flipped by the caller, so the guard made the detach a no-op and the
   * listeners were never removed. One direction per method: `attach` adds,
   * `detach` removes, and the flag records which state we are in.
   */
  private watch(enabled: boolean): void {
    if (enabled === this.watching) return;
    this.watching = enabled;
    if (typeof document === "undefined") return;
    if (enabled) this.attach();
    else this.detach();
  }

  private attach(): void {
    document.addEventListener("visibilitychange", this.onVisibility);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", this.onFocus);
      window.addEventListener("blur", this.onFocus);
    }
    this.syncPlayback();
  }

  private detach(): void {
    if (typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", this.onFocus);
      window.removeEventListener("blur", this.onFocus);
    }
  }

  /** Build the layer (once) and return the `<video>`. */
  private ensure(): HTMLVideoElement | null {
    if (this.video) return this.video;
    if (typeof document === "undefined" || !document.body) return null;
    // Obsidian's own DOM sugar (`createDiv`/`createEl`), not createElement:
    // the community lint rule requires it, and it appends in one call.
    const host = document.body.createDiv({ cls: "wallvia-video-layer" });
    const el = host.createEl("video", { cls: "wallvia-video" });
    el.muted = true;
    el.loop = true;
    el.autoplay = true;
    el.playsInline = true;
    // No controls, no keyboard access: this is a background, and a focusable
    // element behind the workspace would steal Tab from the editor.
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("tabindex", "-1");
    el.setAttribute("disablepictureinpicture", "");
    el.setAttribute("disableremoteplayback", "");
    this.host = host;
    this.video = el;
    return el;
  }
}
