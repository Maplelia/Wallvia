// tests/obsidian-styles.cjs
//
// styles.css carries two load-bearing invariants.
//
// (a) **Exactly one element of a pane's nesting chain may hold the glass
// fill.** Obsidian's own cascade makes those chains different lengths, and each
// fill multiplies the alpha:
//
//   editor with a file open  : .workspace-leaf-content > .view-content >
//                              .markdown-source-view > .cm-editor > .cm-scroller
//   empty tab / sidebar leaf : .workspace-leaf-content > .view-content
//
// These chains are taken from Obsidian's own app.css (extracted from
// resources/obsidian.asar):
//   .workspace-leaf-content .view-content { … }
//   .view-content > .markdown-source-view.mod-cm6 > .cm-editor > .cm-scroller { … }
//   .workspace-split.mod-root .view-content { background-color: var(--background-primary); }
//   .workspace-split.mod-left-split .view-content, …mod-right-split… { height:100%; overflow:auto; }
//
// On 0.2.2 the fill sat on .workspace-leaf-content AND .view-content AND
// .cm-editor, so an open editor stacked three translucent layers (~72% opaque
// at Glass 55) while a sidebar leaf stacked two and an empty tab stacked two:
// that is the reported "left sidebar differs from the right" plus "less
// see-through once a file is open".
//
// (b) **The pane's glass is painted by `.workspace-leaf-content::before`, never
// by `.workspace-leaf-content` itself**, and panes that embed a web view have
// their leaf's containment relaxed. `backdrop-filter` makes its element a
// blending group, so a blurred pane element leaves an embedded frame with the
// pane's fill as its only backdrop (measured: the frame's #161616 page stayed
// rgb(26,26,26) instead of dissolving); on a pseudo-element the glass is a
// sibling of the view rather than its ancestor. The leaf's own
// `contain: strict; isolation: isolate` (Obsidian's app.css) bounds the group
// the same way, so those panes drop `layout`, `paint` and `isolation` — and
// only those, via `:has()`.
//
// Run: node tests/obsidian-styles.cjs [path/to/styles.css]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
/** Overridable so the same assertions can be pointed at an older revision. */
const CSS_PATH = process.argv[2] || process.env.WALLVIA_STYLES || path.join(ROOT, "styles.css");

/** Flatten a flat stylesheet into [{ selectors: string[], body: string }]. */
function parseRules(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    rules.push({
      selectors: m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      body: m[2],
    });
  }
  return rules;
}

const FILL = /color-mix\(\s*in srgb/;
const TRANSPARENT = /background-color:\s*transparent/;

function run() {
  const css = fs.readFileSync(CSS_PATH, "utf8");
  const rules = parseRules(css);
  assert.ok(rules.length > 10, "styles.css parsed into rules — got " + rules.length);

  // A pane's fill may live on the element (older revisions) or on its
  // ::before (current) — both count as "this element is the filled one".
  const fills = (selector) =>
    rules.filter(
      (r) =>
        r.selectors.some((s) => s.endsWith(selector) || s.endsWith(selector + "::before")) &&
        FILL.test(r.body)
    );
  const clears = (selector) =>
    rules.filter((r) => r.selectors.some((s) => s.endsWith(selector)) && TRANSPARENT.test(r.body));

  // --- 1) one fill layer per pane, whatever the chain length -------------
  const CHAINS = {
    "editor with a file open": [
      ".workspace",
      ".workspace-split",
      ".workspace-tabs",
      ".workspace-leaf",
      ".workspace-leaf-content",
      ".view-content",
      ".markdown-source-view",
      ".cm-editor",
      ".cm-scroller",
    ],
    "editor tab with no file open": [
      ".workspace",
      ".workspace-split",
      ".workspace-tabs",
      ".workspace-leaf",
      ".workspace-leaf-content",
      ".view-content",
    ],
    "left sidebar leaf (file explorer)": [
      ".workspace",
      ".workspace-split",
      ".workspace-tabs",
      ".workspace-leaf",
      ".workspace-leaf-content",
      ".view-content",
      ".nav-files-container",
    ],
    "right sidebar leaf": [
      ".workspace",
      ".workspace-split",
      ".workspace-tabs",
      ".workspace-leaf",
      ".workspace-leaf-content",
      ".view-content",
    ],
  };

  for (const [name, chain] of Object.entries(CHAINS)) {
    const filled = chain.filter((sel) => fills(sel).length > 0);
    assert.equal(
      filled.length,
      1,
      `${name}: exactly one filled element in the chain — filled: ${filled.join(", ") || "none"}`
    );
    // Everything else in the chain must be explicitly cleared, or a theme
    // background could reappear underneath and change the effective opacity.
    for (const sel of chain) {
      if (sel === filled[0]) continue;
      assert.ok(
        clears(sel).length > 0,
        `${name}: ${sel} must be cleared to transparent (it is inside the filled pane)`
      );
    }
  }

  // --- 2) all three areas are filled by the *same* declaration ------------
  // Only pane/chrome fills count here. The button's own translucent background
  // is UI chrome, not a glass level, so it is not part of this comparison.
  const fillRules = rules.filter(
    (r) => FILL.test(r.body) && r.selectors.some((s) => /\.workspace|\.status-bar/.test(s))
  );
  assert.ok(fillRules.length >= 1, "the glass fill exists");
  const declaration = (body) =>
    // Up to the terminating `)` of the value, not the first one inside a
    // var(...) — the declaration is multi-line in styles.css.
    (body.match(/color-mix\([^;]*\)/) || [""])[0].replace(/\s+/g, " ").trim();
  const values = new Set(fillRules.map((r) => declaration(r.body)));
  assert.equal(
    values.size,
    1,
    "every fill uses the identical color-mix value — got: " + [...values].join(" || ")
  );
  assert.ok(
    [...values][0].includes("var(--wallvia-glass"),
    "the shared fill is driven by --wallvia-glass — got: " + [...values][0]
  );

  // Panes must not be filled per split, or left/right/main could diverge again.
  for (const pane of [".mod-root", ".mod-left-split", ".mod-right-split"]) {
    assert.equal(
      fills(pane).length,
      0,
      `${pane} must not carry its own fill (panes are filled by one shared selector)`
    );
  }

  // One fill rule per element: two rules on the same element would stack too.
  for (const sel of [
    ".workspace-leaf-content",
    ".workspace-ribbon",
    ".workspace-tab-header-container",
    ".status-bar",
  ]) {
    assert.equal(fills(sel).length, 1, `${sel} is filled by exactly one rule`);
  }

  // --- 3) sidebar-only chrome gets the same fill, not a different one ----
  for (const sel of [
    ".workspace-ribbon.mod-left::before",
    ".workspace-sidedock-vault-profile",
    ".workspace-tab-header-container",
    ".status-bar",
  ]) {
    assert.equal(
      fills(sel).length,
      1,
      `${sel} (Obsidian paints this itself) must use the shared glass fill`
    );
  }

  // --- 3b) the ribbon is filled but must NOT be blurred ------------------
  // `backdrop-filter` (like `filter`) makes an element a containing block for
  // its absolutely positioned descendants. Obsidian anchors two pieces of
  // chrome against a HIGHER ancestor than the ribbon — from its own app.css:
  //
  //   .workspace-ribbon .sidebar-toggle-button { position: absolute; top: 0; left: 0; width: var(--ribbon-width); }
  //   .workspace-ribbon.mod-left:before        { position: absolute; top: 0; left: 0; width: var(--ribbon-width); }
  //
  // while `.workspace-ribbon`'s own rule (width/flex/overflow/background/
  // z-index/padding/gap/border) declares no `position` at all. Blurring the
  // ribbon therefore pulls the sidebar toggle (展开/收起) out of the window's
  // top-left corner and into the icon column, where it covers the first icon.
  const blurredRules = rules.filter((r) => /(^|[;\s])(backdrop-)?filter\s*:/m.test(r.body));
  const ribbonBlur = blurredRules.filter((r) =>
    r.selectors.some((s) => s.trim().endsWith(".workspace-ribbon"))
  );
  assert.equal(
    ribbonBlur.length,
    0,
    "no rule may blur .workspace-ribbon itself — it re-anchors Obsidian's sidebar toggle: " +
      ribbonBlur.map((r) => r.selectors.join(" + ")).join(" | ")
  );
  assert.equal(
    blurredRules.some((r) =>
      r.selectors.some((s) => s.trim().endsWith(".workspace-leaf-content::before"))
    ),
    true,
    "the panes are still blurred — the fix must not drop the glass blur entirely"
  );

  // --- 3c) the blur must NOT sit on the pane element itself --------------
  // `backdrop-filter` makes its element a blending group for its descendants.
  // An embedded web view (rule 6) is a descendant of .workspace-leaf-content,
  // so a blurred pane leaves the frame with the pane's own fill as its only
  // backdrop and the frame stays an opaque slab. Measured in Chromium with the
  // real opencode page in the frame, adding the plugin's rules back one at a
  // time: everything dissolves up to the blur rule and stops at it.
  assert.equal(
    blurredRules.filter((r) =>
      r.selectors.some((s) => s.trim().endsWith(".workspace-leaf-content"))
    ).length,
    0,
    "no rule may blur .workspace-leaf-content itself — it would group an embedded web view " +
      "(the pane's blur lives on .workspace-leaf-content::before)"
  );
  assert.ok(
    clears(".workspace-leaf-content").length > 0,
    "the pane element itself is transparent, so its ::before is the only glass layer"
  );

  // --- 3d) the glass layer is painted behind the pane's content ----------
  const paneGlass = rules.filter((r) =>
    r.selectors.some((s) => s.trim().endsWith(".workspace-leaf-content::before"))
  );
  assert.equal(paneGlass.length, 1, "the pane glass is a single ::before layer");
  assert.match(paneGlass[0].body, /position:\s*absolute/, "the glass layer is positioned");
  assert.match(paneGlass[0].body, /inset:\s*0/, "the glass layer covers the pane");
  assert.match(paneGlass[0].body, /z-index:\s*-1/, "the glass layer sits behind the content");
  assert.match(
    paneGlass[0].body,
    /pointer-events:\s*none/,
    "the glass layer never swallows clicks"
  );

  // --- 4) previews show the WHOLE image --------------------------------
  for (const sel of [".wallvia-preview", ".wallvia-panel-preview"]) {
    const preview = rules.filter((r) => r.selectors.includes(sel));
    assert.equal(preview.length, 1, `${sel} has exactly one rule`);
    assert.match(
      preview[0].body,
      /background-size:\s*contain/,
      `${sel} shows the whole image (background-size: contain)`
    );
    assert.ok(
      !/background-size:\s*cover/.test(preview[0].body),
      `${sel} must not crop with cover`
    );
  }

  // --- 5) the floating button must not rest on a plugin view as a solid disc
  // It is a fixed overlay in the bottom-right corner, which is where a
  // full-pane plugin view (opencode's iframe, a Base's table) keeps its own
  // controls, so it stays see-through until it is actually used.
  const fabRules = rules.filter((r) => r.selectors.includes(".wallvia-fab"));
  assert.equal(fabRules.length, 1, ".wallvia-fab has exactly one base rule");
  const fab = fabRules[0].body;
  assert.match(fab, /opacity:\s*0?\.\d+/, "the resting button is see-through (opacity < 1)");
  assert.ok(
    /color-mix\([^;]*transparent/.test(fab),
    "the resting button background is translucent, not a solid --background-secondary"
  );
  assert.ok(
    !/box-shadow:\s*0\s+8px/.test(fab),
    "the resting button drops the drop shadow that made it read as a solid disc"
  );
  assert.equal(
    rules.filter(
      (r) => r.selectors.some((s) => s.includes(".wallvia-fab-open")) && /opacity:\s*1\b/.test(r.body)
    ).length,
    1,
    "the button turns fully opaque while the panel is open (.wallvia-fab-open)"
  );

  // --- 6) a Base and opencode's view must not be opaque slabs -------------
  // The structural half first: a plugin view root is cleared by structure, so
  // a plugin nobody has heard of yet is covered without a code change.
  assert.ok(
    rules.some(
      (r) =>
        r.selectors.some((s) => s.trim().endsWith(".view-content > *")) &&
        /background-color:\s*transparent/.test(r.body)
    ),
    "a plugin view root is cleared structurally (.view-content > *)"
  );
  for (const sel of [".bases-table-container", ".bases-thead .bases-td", ".bases-table-footer"]) {
    assert.ok(
      rules.some(
        (r) =>
          r.selectors.some((s) => s.trim().endsWith(sel)) &&
          /background-color:\s*transparent/.test(r.body)
      ),
      `${sel} is cleared, so a Base (数据库) shows the wallpaper like other panes`
    );
  }
  // The header strip is chrome, not a pane — the plugin paints it with
  // --background-secondary, so it is cleared like the rest of the view; its own
  // 1px border-bottom still separates it from the frame.
  for (const sel of [".opencode-iframe", ".opencode-container", ".opencode-header"]) {
    assert.ok(
      rules.some(
        (r) =>
          r.selectors.some((s) => s.trim().endsWith(sel)) &&
          /background-color:\s*transparent/.test(r.body)
      ),
      `${sel} is cleared, so the opencode view (and its header strip) is not an opaque fill`
    );
  }

  // --- 7) an embedded plugin page is composited, not fought with ---------
  // Clearing backgrounds cannot reach a cross-origin frame's inner document,
  // so the frame element is composited instead: `lighten` in a dark theme
  // (the embedded page's own dark background is the darkest thing on screen and
  // drops out, its light text survives), `darken` in a light theme.
  const embed = rules.filter((r) =>
    r.selectors.some((s) => s.trim().endsWith(".view-content iframe"))
  );
  assert.equal(
    embed.filter((r) => /opacity:\s*var\(--wallvia-embed-opacity/.test(r.body)).length,
    1,
    "the embedded frame is composited with the manual --wallvia-embed-opacity lever"
  );
  for (const [theme, mode] of [["theme-dark", "lighten"], ["theme-light", "darken"]]) {
    assert.ok(
      embed.some(
        (r) =>
          r.selectors.some((s) => s.includes("body." + theme)) &&
          new RegExp("mix-blend-mode:\\s*" + mode).test(r.body)
      ),
      `a ${theme} app blends an embedded page with ${mode}, so the frame's own background dissolves`
    );
  }

  // --- 7a) the pane stops isolating its own blending group ---------------
  // The frame's blend backdrop is bounded by the nearest grouping ancestor:
  // Obsidian's `.workspace-leaf { contain: strict; isolation: isolate }` cuts
  // the wallpaper out of it, so panes holding a web view drop exactly the two
  // grouping halves of `contain` (layout, paint) plus `isolation`, and keep
  // size/style containment (Obsidian's performance guard). Scoped with :has()
  // so no other pane changes behaviour.
  const leafOverride = rules.filter((r) =>
    r.selectors.some((s) => s.includes(":has(.view-content iframe)"))
  );
  assert.equal(
    leafOverride.length,
    1,
    "exactly one rule relaxes the blend group of panes that embed a web view"
  );
  assert.match(
    leafOverride[0].body,
    /contain:\s*size style/,
    "such a pane keeps size/style containment and drops layout/paint"
  );
  assert.ok(
    !/contain:[^;]*\b(layout|paint|strict)\b/.test(leafOverride[0].body),
    "layout/paint containment (the grouping halves) must not come back"
  );
  assert.match(
    leafOverride[0].body,
    /isolation:\s*auto/,
    "such a pane stops isolating its blend group"
  );

  for (const sel of [".markdown-source-view iframe", ".markdown-preview-view iframe"]) {
    const reset = rules.filter((r) => r.selectors.some((s) => s.trim().endsWith(sel)));
    assert.ok(
      reset.some((r) => /opacity:\s*1\b/.test(r.body)),
      `${sel} gets opacity 1 back (a note embed is not a plugin view)`
    );
    assert.ok(
      reset.some((r) => /mix-blend-mode:\s*normal/.test(r.body)),
      `${sel} gets its blending back (a YouTube embed must look like a YouTube embed)`
    );
  }

  console.log("OBSIDIAN STYLES TEST PASSED");
  console.log("  one glass fill per pane chain (editor, empty tab, both sidebars),");
  console.log("  identical color-mix value everywhere, sidebar chrome included,");
  console.log("  the pane's glass on a ::before (never on the pane element, so an");
  console.log("  embedded web view can blend with the wallpaper), and both previews");
  console.log("  show the whole image (contain).");
}

module.exports = run;
if (require.main === module) {
  // run() is synchronous here; Promise.resolve().then() still routes a thrown
  // assertion through the same failure path as the async suites.
  Promise.resolve()
    .then(run)
    .catch((e) => {
      console.error("OBSIDIAN STYLES FAILED: " + (e && e.message));
      process.exit(1);
    });
}
