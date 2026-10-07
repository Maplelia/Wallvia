<div align="center">

# Wallvia for VS Code

**Bring your Wallpaper Engine everywhere.**

Pick one image as the background of the whole workbench: the editor and the panels turn into translucent frosted glass while the text stays crisp.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.80-007ACC)
![Dependencies](https://img.shields.io/badge/dependencies-none-3c873a)

English · [中文](README.zh.md)

</div>

<img src="images/vscode-wallpaper-settings.jpg" alt="VS Code in practice: the wallpaper fills the window and the Wallvia settings panel shows the injection status and the local wallpaper library" width="100%">

<sub>VS Code in practice: the wallpaper fills the window, the activity bar / title bar / status bar are transparent and the editor is translucent; on the right is the Wallvia settings panel (injection status, local wallpaper library, effect sliders and toggles).</sub>

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Settings reference](#settings-reference)
- [How it works](#how-it-works)
- [Uninstall and restore](#uninstall-and-restore)
- [Verification](#verification)
- [Known limitations](#known-limitations)
- [Repository layout](#repository-layout)
- [Credits](#credits)

## Features

| Feature | Detail |
|:--|:--|
| **Pick a Wallpaper Engine wallpaper directly** | A card grid lists the wallpapers **downloaded** on this machine (Workshop + My Projects + built-in), with large 16:9 artwork + a **resolution badge** + a search box; the one in use is marked "current" |
| **Native artwork, not a square preview** | A scene wallpaper takes its real image from the `scene.pkg` mipmap chain (measured at 3840×2160 / 7680×4320) instead of the 801–1024 square preview; built-in / web projects are scanned for wide images under `materials/` and `images/` |
| **One real frame from a video wallpaper too** | Decoded by the editor's own Chromium (offscreen `<video>` + canvas), with **no ffmpeg install and no dependency at all** |
| **Four alignments** | **Cover** / **Contain** (the whole image, uncropped, with a margin) / **Fill** / **Center** |
| **Dim layer** | `dim` keeps the text legible on a busy wallpaper and can **follow the theme's light/dark setting** (near-black on dark, near-white on light) |
| **Transparency** | `glass` 0-100: 100 = the wallpaper shows through the editor almost completely, 0 = close to opaque. The sidebar and the panels are always transparent; legibility is guaranteed by `dim` |
| **Live apply** | Changing a setting / swapping the wallpaper does not reload the window: an injected script polls a stamp file and **replaces the stylesheet in place** (can be turned off) |
| **Graphical settings panel** | Sliders + toggles + live status (whether the patch is injected, how many wallpapers were found, the resolution and origin of the current source artwork) |
| **Automatic re-patch after an update** | A VS Code upgrade wipes the patch; the extension checks the version on startup and rewrites it automatically |
| **Idempotent + backed up + one-command restore** | Touches only its own marked block, keeps a backup of the original file, and restores the installation directory with a single command |

## Requirements

| Item | Requirement |
|:--|:--|
| VS Code | **1.80+** (desktop) |
| Installation directory | Write access to the VS Code **installation directory**; whether administrator rights are needed is in the table below |
| External programs | None required: no ffmpeg, no npm dependency, no build step |

| Install location | Administrator needed? |
|:--|:--|
| `%LOCALAPPDATA%\Programs\Microsoft VS Code` (user-level install) | No |
| A custom directory outside Program Files (such as `D:\Microsoft VS Code`) | No (verified writable) |
| `C:\Program Files\...` | Usually yes |

> ⚠️ **Works on the desktop build on this machine only.** The extension produces the background image by modifying
> the `workbench.html` in the installation directory, so installing it in vscode.dev / the web version / Remote-SSH / Dev Containers has no effect either.

## Installation

| Option | Entry point | Best for |
|:--|:--|:--|
| **A** | One-line download and install | The least effort; all three lines take the latest release automatically |
| **B** | Install the local package when the repository is already cloned | You already have the `.vsix` in hand |
| **C** | Package from source | You want to build the package yourself |
| **D** | Debug in development mode | You change the code and press <kbd>F5</kbd> to start the debug host |
| **E** | Drop it into the extensions folder by hand | You would rather skip the command line |

### Option A: one-line download and install (easiest)

```powershell
$r = irm https://api.github.com/repos/Maplelia/Wallvia/releases/latest
$u = ($r.assets | Where-Object name -like '*.vsix').browser_download_url
irm $u -OutFile "$env:TEMP\wallvia.vsix"; code --install-extension "$env:TEMP\wallvia.vsix"
```

All three lines take the **latest release** automatically (no hard-coded version number, so a future release will not 404). To pin a version, specify it directly, for example:
`https://github.com/Maplelia/Wallvia/releases/download/v<version>/wallvia-<version>.vsix`

### Option B: install the local package when the repository is already cloned

```powershell
code --install-extension (Get-ChildItem *.vsix | Select-Object -Last 1).FullName
```

### Option C: package from source

```powershell
npx @vscode/vsce package --allow-missing-repository
code --install-extension .\wallvia-<version>.vsix   # see package.json for the version number
```

### Option D: debug in development mode

This directory ships a `.vscode/launch.json`; just press <kbd>F5</kbd> in VS Code.

### Option E: drop it into the extensions folder by hand

Copy this directory to `%USERPROFILE%\.vscode\extensions\wallvia.wallvia-<version>\` and restart.

> After installing, **reload the window once** (command palette → `Developer: Reload Window`): the
> extension writes the patch on first activation, and `workbench.html` is read only once, at window startup.

## Usage

In the command palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) type **`wallvia`** — every command starts with `Wallvia:`, so searching the brand name always hits; searching `wallpaper engine` also finds the picker entry.

| Command | What it does |
|:--|:--|
| **Wallvia: Choose Wallpaper Engine Wallpaper…** | Opens the card grid picker (**preferred**) |
| **Wallvia: Choose Image File…** | Picks a local still image (JPG / PNG / BMP) and applies it |
| **Wallvia: Open Settings Panel** | The graphical panel: effect sliders + four optional toggles + source artwork width cap |
| **Wallvia: Toggle Glass Effect** | Switches `glass` ↔ `fade` |
| **Wallvia: Remove Wallpaper** | Removes the wallpaper (and deletes the copied image) |
| **Wallvia: Show Status** | Prints the status JSON (for troubleshooting, including the current source artwork and its resolution) |
| **Wallvia: Restore Original workbench.html** | Restores the installation directory from the backup and deletes the generated CSS / script / stamp |

> Historical note: in 0.1.x the commands were named `Wallpaper: Pick Image…` and so on, and sat under the
> `Glass Wallpaper` category; since 0.2.0 they all use the `Wallvia:` prefix.

### Wallpaper Engine wallpaper picker

<img src="images/vscode-picker.jpg" alt="Wallpaper Engine wallpaper picker" width="100%">

<sub>The Wallpaper Engine picker: a card grid with resolution badges (in the screenshot, a 3840×2160 scene and 3200×1756 / 2560×1440 / 3830×2160 video frames); "current" is the one in effect, and clicking a card applies it.</sub>

## Settings reference

| Setting | Value | Default | Description |
|:--|:--|:--|:--|
| `wallvia.enabled` | boolean | `true` | Whether the wallpaper is enabled |
| `wallvia.dim` | 0-80 | `45` | Dim layer strength (%). 40-60 is recommended for bright images |
| `wallvia.glass` | 0-100 | `55` | Transparency (%). At 100 the editor background is at its faintest, at 0 it is close to opaque |
| `wallvia.mode` | `glass` \| `fade` | `glass` | `fade` keeps only a fainter wash layer; the most stable option |
| `wallvia.fit` | `cover` \| `contain` \| `fill` \| `center` | `cover` | **cover** fills the screen (may crop the edges) / **contain** keeps the whole image uncropped (with dark bars) / **fill** stretches / **center** keeps the native size |
| `wallvia.hires` | boolean | `true` | Takes the native-resolution artwork from the scene package; turn it off to use only the 801–1024 preview image |
| `wallvia.videoFrames` | boolean | `true` | Grabs one frame from a video wallpaper as the thumbnail / background (decoded by Chromium, no ffmpeg needed) |
| `wallvia.liveApply` | boolean | `true` | Changes apply live; when off, a change needs a manual window reload |
| `wallvia.themeAware` | boolean | `true` | The dim layer color follows the theme's light/dark setting |
| `wallvia.maxImageWidth` | 0-7680 | `0` | Source artwork width cap. `0` = scenes take the sharpest level and video card frames are 960; setting 1920/2560 noticeably cuts VRAM and decoding cost, while a large value also sharpens the video card frames |
| `wallvia.autoReapply` | boolean | `true` | Re-applies the patch automatically after a VS Code update |
| `wallvia.blur` | 0-12 | `0` | **Disabled** (the key is kept only so that old configurations do not error): any `backdrop-filter` makes Chromium repaint the whole window every frame, so it is always treated as 0 internally |

### Graphical settings panel

<img src="images/vscode-settings.png" alt="The Wallvia graphical settings panel" width="100%">

<sub>The settings panel: the badge in the top-left shows whether the patch is injected, and lists the number of Wallpaper Engine wallpapers detected along with the **current source artwork** (resolution + origin); the lower half holds the four optional toggles and the source artwork width cap.</sub>

## How it works

VS Code has **no official API** for setting a background image across the whole workbench
([#134317](https://github.com/microsoft/vscode/issues/134317),
[#6007](https://github.com/microsoft/vscode/issues/6007) have gone unimplemented for years),
and every background extension in the community takes the same route: modifying a file in the
installation directory. Here is what this extension does:

1. The image is copied into the extension's `globalStorage` (**keeping its real extension**, so that the mime type cannot disagree with the content);
2. `wallvia-bg.css` is generated next to `workbench.html` (plus `wallvia-live.js` and `wallvia-stamp.txt` when needed);
3. A marked `<link>` is injected into `<head>` (idempotent: only its own marked block is touched);
4. `product.json`'s `checksums` is kept in sync, avoiding the "installation is corrupt" warning;
5. The original file is backed up as `workbench.html.wallvia.bak`.

### Render model: one wallpaper layer, one wash layer, transparent surfaces

```css
html body::before  { position:fixed; inset:0; z-index:0; background-image:url(wallpaper) }  /* the only wallpaper layer */
html body::after   { position:fixed; inset:0; z-index:1; background:rgba(8,10,18,dim) }     /* the only dim layer */
html body .monaco-workbench { position:relative; z-index:2; background:transparent }        /* every surface transparent */
```

The wallpaper is **never** painted on the sidebar's or a panel's own `background-image`: that would paint it once per surface, decoding it repeatedly and producing seams whenever the window is resized (early versions did exactly that, and it was dropped).

<img src="images/vscode-surfaces.jpg" alt="The wallpaper is continuous across the sidebar / editor / terminal panel" width="100%">

<sub>With the sidebar, the editor and the terminal panel open at the same time, the wallpaper is **continuous** across the four areas — the sidebar is not an opaque card.</sub>

### Three details that must be right (all verified in a real workbench)

| Detail | What getting it wrong causes |
|:--|:--|
| `checksums` must be the **base64 of the sha256, with the `=` padding removed** (43 characters) | Writing hex → *"Your Code installation appears to be corrupt"* on every launch |
| The image URI must be **percent-encoded**, using `vscode.Uri.file(p).with({scheme:'vscode-file',authority:'vscode-app'})` | When the path contains a space or Chinese characters (extremely common on Windows) the renderer refuses to load it |
| The wallpaper layers use **positive 0 / 1 / 2 z-index values**, never negative | A negative `z-index` is clipped away by `.monaco-workbench`'s own stacking context → **the wallpaper does not show at all** |

### Two "clearing" mechanisms (both are required)

Surfaces inside the workbench get their color in two ways, and each has to be dealt with separately:

1. **Selectors with `!important`** — override them with a more specific rule that is also `!important`.
   Always copy VS Code's real class chain verbatim, for example the floating cards of the modern UI (1.140+):

   ```css
   .monaco-workbench.floating-panels .part.sidebar { background-color: var(--vscode-surface-background) !important }
   ```

   That is a specificity of **(0,4,0)**. Written as `html body .monaco-workbench .part.sidebar` it is only (0,3,2) and
   **loses** — the symptom being "the wallpaper fills the whole window, but the sidebar is still an opaque card".

2. **Theme variables** — a great many surfaces are colored through theme variables (`--vscode-tab-inactiveBackground`
   and the like); setting those variables to `transparent` on `.monaco-workbench` saves you from writing a rule per surface:

   ```css
   html body .monaco-workbench { --vscode-editor-background: transparent; --vscode-sideBar-background: transparent;
                                 --vscode-surface-background: transparent; --modern-ui-shell-background: transparent; … }
   ```

`tests/vscode-css-weight.cjs` parses the **`workbench.desktop.main.css` from the real installation directory** and
checks rule by rule whether every "rule that colors a structural surface" is covered by one of those two mechanisms,
so a new VS Code version or a renamed class warns you immediately, instead of waiting for you to notice that the sidebar
has gone opaque again.

### Live apply (no window reload)

`workbench.html` is read only once, at window startup, so early versions reloaded the whole window for every settings
change. `applyPatch()` now also writes:

- `wallvia-live.js` — a small script that runs `fetch('./wallvia-stamp.txt')` every 2 seconds;
- `wallvia-stamp.txt` — the CSS mtime stamp.

When the stamp changes, the `<link href>` is **rewritten in place**, the browser re-reads the stylesheet and nothing else in the window moves at all.
(The workbench CSP has `require-trusted-types-for 'script'`, so inserting a `<script>` dynamically is not an option —
only `fetch` + changing `href`; `connect-src 'self'` allows that fetch.)

## Uninstall and restore

One command is enough:

```
Wallvia: Restore Original workbench.html
```

It copies the backup back, deletes `wallvia-bg.css`, `wallvia-live.js` and `wallvia-stamp.txt`, and recomputes
`product.json` → `checksums`.

The manual steps (equivalent):

1. Overwrite `workbench.html` with `workbench.html.wallvia.bak`;
2. Delete the `<!-- wallvia:start -->` … `<!-- wallvia:end -->` marked block;
3. Delete `wallvia-bg.css` / `wallvia-live.js` / `wallvia-stamp.txt` from the same directory;
4. Recompute `product.json` → `checksums["vs/code/electron-browser/workbench/workbench.html"]`;
5. Uninstall the extension (the cache directories `globalStorage/wallvia.wallvia/` and `%TEMP%\wallvia-stills\` can be deleted along with it).

## Verification

```powershell
node tests/run-all.cjs             # the whole suite (run from the repository root)
node tests/vscode-smoke.cjs        # VS Code extension: injection / checksums / picker / video-frame round trip (mock installation directory)
node tests/vscode-video-frame.cjs  # frame cache, width policy, bad payload rejection
node tests/vscode-video-decode.cjs # real Chromium + a real video: the frame-grab function itself (SKIP when no browser is available)
node tests/vscode-css-weight.cjs   # validate the surface-clearing specificity against the real VS Code stylesheet (SKIP when VS Code is not installed)
```

| Command | Coverage |
|:--|:--|
| `node tests/run-all.cjs` | The whole suite, run from the repository root |
| `node tests/vscode-smoke.cjs` | Injection / checksums / picker / video-frame round trip (mock installation directory) |
| `node tests/vscode-video-frame.cjs` | Frame cache, width policy, bad payload rejection |
| `node tests/vscode-video-decode.cjs` | Real Chromium + a real video: the frame-grab function itself (SKIP when no browser is available) |
| `node tests/vscode-css-weight.cjs` | Validates the surface-clearing specificity against the real VS Code stylesheet (SKIP when VS Code is not installed) |

## Known limitations

- Desktop only; not applicable to Remote / Web.
- **The Wallpaper Engine picker is Windows desktop only**: it is located through a running WE process → the Steam
  registry → common installation directories (you can also force it with the `WE_CONFIG` environment variable pointing
  at `config.json`).
- **Animated content does not run**: VS Code can only paint a static background. A scene wallpaper contributes the
  native artwork inside the package and a video wallpaper a single frame; the DXT/TGA textures of the built-in default
  project cannot be decoded, so only WE's own square preview image can be used.
- When WE is not installed, the command says so clearly and you can fall back to "Choose Image File".
- A VS Code update overwrites the patch, so this relies on the automatic re-patch at extension startup.
- **The editor area's opacity is decided by `glass`**: Monaco paints `--vscode-editor-background` on both the
  `.monaco-editor` and the `.monaco-editor-background` layer, and both have to be handled, otherwise the editor is a
  solid black block the moment you open a file (an empty editor shows no problem, because Monaco has not painted any
  widget then). To see the wallpaper more clearly, set `wallvia.glass` to 100.
- `glass` mode depends on DOM structures such as `.part.*`; after a major update a few selectors may stop matching,
  in which case switch to `fade` (or run the specificity test to locate them). The "floating cards" modern UI of 1.140
  has been specifically supported.
- **No optical blur**: any `backdrop-filter` makes Chromium repaint the whole window every frame, a cost far
  outweighing the benefit, so the glass is made of "transparent + wash" only; `wallvia.blur` is kept but always
  inactive.
- A 4K source artwork takes about 33 MB of VRAM once decoded; if that matters, cap it at 1920/2560 with
  `wallvia.maxImageWidth`.
- Modifying the installation directory is a hack by nature — assess the risk yourself; the extension makes the
  smallest change it can and keeps a backup.

## Repository layout

```
.
├── package.json             # command and settings declarations
├── src/extension.js         # the extension itself: patching / CSS generation / picker and settings panel (plain CJS, no build)
├── src/wallpaper-engine.js  # Wallpaper Engine discovery + enumeration of downloaded wallpapers
├── src/still-image.js       # picks the most suitable still image out of the scene.pkg .tex files / loose project images
├── src/video-frame.js       # video-frame cache: the cache key, width policy, bad payload validation (shares one directory with Obsidian)
├── src/mp4.js               # pure-byte parsing of the MP4 tkhd to read the video's own resolution
├── scripts/verify.js        # pre-release consistency check (called by vsce's prepublish)
├── images/                  # README screenshots
├── LICENSE
├── README.md
└── README.zh.md
```

Generated inside the VS Code installation directory at runtime (deleted on uninstall / restore):

```
resources/app/out/.../workbench/wallvia-bg.css      # wallpaper + wash + surface clearing
resources/app/out/.../workbench/wallvia-live.js     # live-apply script
resources/app/out/.../workbench/wallvia-stamp.txt   # stylesheet version stamp
```

## Credits

The CSS selectors and platform behavior were informed by community background extensions:
[shalldie/vscode-background](https://github.com/shalldie/vscode-background),
[subframe7536/vscode-custom-ui-style](https://github.com/subframe7536/vscode-custom-ui-style),
[KatsuteDev/Background](https://github.com/KatsuteDev/Background).
The glass-wallpaper idea comes from an upstream wallpaper plugin under the MIT license.

[MIT](LICENSE) © 2026 Wallvia contributors
