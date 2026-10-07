# Credits

## Wallvia

Wallvia is the collected name for three implementations of the same idea —
a wallpaper with a frosted-glass treatment:

| | |
|---|---|
| `vscode/` | Wallvia for VS Code (extension) |
| `obsidian/` | Wallvia for Obsidian (plugin) |
| `codex/` | Wallvia for the OpenAI Codex desktop app (CLI) |

The idea itself — a background image behind translucent surfaces, with a
dimming layer so text stays readable — was ported from the wallpaper plugin in
the **DeepSeek Harness (DSH)** ecosystem. Two packages are involved, and they
play different roles:

### 1. `@deepseek-ai/dsh-plugin-wallpaper` — the code this port came from

- **License:** MIT (declared in its `package.json`; the package ships no author
  field and no separate LICENSE file, so there is no copyright line to
  reproduce).
- **Role:** the standalone wallpaper plugin — "upload an image and set it as
  the app wallpaper (a glass backdrop visible behind translucent chat
  surfaces)". This is the file that was actually read and ported:
  `lib/client.js`.
- **What was carried forward:** the state model (`enabled` / `image` / `fit` /
  `dim` / `strength`), the surface-transparency technique over the host's
  `--dsw-*` tokens, the per-surface readability floors and the `surfaceShare`
  formula, the image downscale limits (long edge 2000 px, ≤ 4.2 MB) and the
  `dsh.wallpaper.v1` storage key.

### 2. `@linxin666/dsh-web-all` — where the feature is mounted in the DSH Web UI

- **License:** Apache-2.0 ·
  [repository](https://github.com/zhu1090093659/dsh-web)
- **Role:** an aggregation ("bundle") plugin for the DSH Web UI. The wallpaper
  feature that is actually mounted in the UI comes from the **skin-center**
  plugin it bundles (`@linxin666/dsh-client-ui-skin-center`) — the profile entry
  named `skin-wallpaper` that holds the current selection is read by
  skin-center. skin-center carries the same implementation surface as the
  standalone plugin above (`--dsw-*` surface tokens and the `dsh.wallpaper`
  storage key).
- **Note:** no code from this package was copied into Wallvia; it is credited
  because it is the plugin that surfaces the feature inside DSH.

All code in this repository was written for these three targets; only the
technique and the parameters are carried forward.

## Third-party projects

Selectors, build setup and platform quirks were learned from these community
projects, all of which are independent of Wallvia:

**VS Code**

- [shalldie/vscode-background](https://github.com/shalldie/vscode-background) —
  the "patch `workbench.html`" approach and its common issues.
- [subframe7536/vscode-custom-ui-style](https://github.com/subframe7536/vscode-custom-ui-style) —
  which files are safe to patch and how `checksums` interact with them.
- [KatsuteDev/Background](https://github.com/KatsuteDev/Background) — the
  low-maintenance "light overlay" idea behind `fade` mode.

**Obsidian**

- [sean2077/obsidian-dynamic-theme-background](https://github.com/sean2077/obsidian-dynamic-theme-background) —
  `body` class + `::before` layer + CSS-variable structure.
- [Moyf/style-context](https://github.com/Moyf/style-context) — publishing
  runtime values as CSS variables, and why the image may not sit on the text
  container.
- [qiulinfan/obsidian-background](https://github.com/qiulinfan/obsidian-background) —
  `getResourcePath()` caching with `?v=<mtime>`.
- [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) —
  the official esbuild/manifest setup.

**Codex desktop app**

- [Senxss19/codex-wallpaper-theme](https://github.com/Senxss19/codex-wallpaper-theme) —
  the CDP injection approach, the `data:` URL requirement, and the keeper idea.
- [xnydl/codex-dream-skin](https://github.com/xnydl/codex-dream-skin) —
  launching with a debug port and keeping the injection alive.

## Wallpaper Engine

Wallpaper Engine is a product of Kristjan Skutta. Wallvia only *reads*
Wallpaper Engine's local `config.json` to find out which wallpaper is active;
it is not affiliated with or endorsed by Wallpaper Engine.
