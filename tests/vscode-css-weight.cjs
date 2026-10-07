// tests/vscode-css-weight.cjs — guard the workbench transparency against the
// selectors VS Code actually ships.
//
// The bug this exists for: VS Code 1.140 added `.monaco-workbench.floating-panels
// .part.sidebar{background-color:var(--vscode-surface-background)!important}`.
// That is a (0,3,0) rule, and Wallvia's `html body .monaco-workbench
// .part.sidebar` was only (0,2,2) — so the sidebar silently stayed an opaque
// card over the wallpaper, on a machine where every unit test still passed.
//
// The test parses the real `workbench.desktop.main.css` from the local VS Code
// install, collects every rule that paints a background on a structural surface,
// and requires Wallvia's generated CSS to outrank each of them with
// `!important`. Without a local VS Code it prints SKIPPED and exits 0.
//
// Run: node tests/vscode-css-weight.cjs
//      VSCODE_CSS=<path to workbench.desktop.main.css> node tests/vscode-css-weight.cjs
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert");
const { install } = require("./mock-loader.cjs");

/** Surfaces that must end up transparent for the wallpaper to show through. */
const SURFACES = [
  ".part.sidebar",
  ".part.auxiliarybar",
  ".part.panel",
  ".part.editor",
  ".part.titlebar",
  ".part.statusbar",
  ".part.activitybar",
  ".monaco-grid-view",
];

/**
 * Containers directly inside a surface that Wallvia also clears. A rule whose
 * *subject* is one of these decides whether the wallpaper shows through; rules
 * about deeper decoration (tab borders, icons, badges) are none of our
 * business and keep their own colours.
 */
const CONTAINERS = [
  ".content",
  ".editor-group-container",
  ".editor-container",
  ".tabs-and-actions-container",
  ".monaco-editor",
  ".monaco-editor-background",
  ".margin",
  ".pane-body",
  ".monaco-list",
  ".monaco-list-rows",
  ".split-view-view",
  ".pane",
  ".pane-header",
];

/** The compound selector a rule actually applies to (its rightmost part). */
function subject(selector) {
  const parts = selector.replace(/\s*[>+~]\s*/g, " ").trim().split(/\s+/);
  return parts[parts.length - 1] || "";
}

/** The class a rule really applies to, ignoring pseudo-classes/elements. */
function subjectClass(selector) {
  const bare = subject(selector).replace(/::?[\w-]+(\([^)]*\))?/g, "");
  const classes = bare.match(/\.[\w-]+/g) || [];
  return classes.length ? classes[classes.length - 1] : bare;
}

/** Whether this rule decides the paint of a surface or a surface container. */
function isSurfaceRule(sel) {
  const cls = subjectClass(sel);
  return SURFACES.includes(cls) || CONTAINERS.includes(cls);
}

/** Where a VS Code install may keep its workbench stylesheet. */
function candidateCssFiles() {
  const out = [];
  if (process.env.VSCODE_CSS) out.push(process.env.VSCODE_CSS);
  const roots = [
    "D:\\Microsoft VS Code",
    "C:\\Microsoft VS Code",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code"),
    "C:\\Program Files\\Microsoft VS Code",
    "C:\\Program Files (x86)\\Microsoft VS Code",
    "/usr/share/code",
    "/Applications/Visual Studio Code.app/Contents/Resources/app",
  ];
  const tail = path.join("resources", "app", "out", "vs", "workbench", "workbench.desktop.main.css");
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    // Versioned layouts nest the app one level down (…/<hash>/resources/app/…).
    out.push(path.join(root, tail));
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      /* unreadable root */
    }
    for (const e of entries) {
      if (e.isDirectory() && /^[0-9a-f]{8,}$/i.test(e.name)) out.push(path.join(root, e.name, tail));
    }
  }
  return out.filter((p) => p && fs.existsSync(p));
}

/** CSS specificity as a comparable tuple: id, class, element. */
function specificity(selector) {
  const sel = selector.replace(/\s*[>+~]\s*/g, " ").trim();
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const attrs = (sel.match(/\[[^\]]*\]/g) || []).length;
  const classes = (sel.match(/\.[\w-]+/g) || []).length + attrs + (sel.match(/:(?!:)[\w-]+/g) || []).length;
  const pseudoElements = (sel.match(/::[\w-]+/g) || []).length;
  const elements =
    (sel.match(/(^|[\s,])[a-zA-Z][\w-]*/g) || []).length + pseudoElements;
  return [ids, classes, elements];
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Every `selector{body}` pair in a stylesheet. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith("@")) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

/**
 * Variables Wallvia deliberately leaves opaque.
 *
 * These paint *content* editors — an embedded editor inside a walkthrough, for
 * instance. Turning them transparent would put the wallpaper behind text that
 * belongs to a document, which is a readability problem, not a wallpaper one.
 */
const CONTENT_VARIABLES = [
  "--vscode-walkThrough-embeddedEditorBackground",
  "--vscode-notebook-editorBackground",
  "--vscode-notebook-cellEditorBackground",
];

/** Background values that paint nothing at all. */
const NO_PAINT = /^(inherit|initial|unset|revert|none|transparent|currentcolor)$/i;

function paintsBackground(body) {
  return /(^|[;\s])(background|background-color)\s*:/.test(body);
}

/** The first background value a rule sets. */
function backgroundValue(body) {
  const m = /(?:^|[;\s])background(?:-color)?\s*:\s*([^;}]+)/i.exec(body);
  return m ? m[1].trim() : "";
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wallvia clears the workbench through two mechanisms: an `!important`
 * transparent clear on the surface itself, and neutralising the theme
 * variables those surfaces paint with (`--vscode-tab-inactiveBackground:
 * transparent`). A rule whose colour comes from a variable we neutralise
 * cannot paint anything, whatever its specificity.
 */
function neutralisedByVariables(value, ourCss) {
  const vars = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
  if (!vars.length) return false;
  if (vars.some((v) => CONTENT_VARIABLES.includes(v))) return true; // exempt by design
  return vars.some((v) => new RegExp(escapeRe(v) + "\\s*:\\s*transparent", "i").test(ourCss));
}

/**
 * Every VS Code rule that paints a structural surface, and whether Wallvia's
 * stylesheet outranks it with an `!important` transparent clear.
 * Exported so the failure path itself can be tested.
 */
function audit(ourCss, vsCss) {
  // A rule's selector list must be compared selector by selector: taking the
  // whole comma-joined string as one selector inflates its specificity and
  // makes the weakest entry look unbeatable.
  const ourSelectors = [];
  for (const rule of rules(ourCss)) {
    for (const sel of rule.selector.split(",")) {
      ourSelectors.push({ selector: sel.trim(), body: rule.body });
    }
  }

  let checked = 0;
  let exempt = 0;
  const failures = [];
  for (const rule of rules(vsCss)) {
    if (!paintsBackground(rule.body)) continue;
    for (const raw of rule.selector.split(",")) {
      const sel = raw.trim();
      const surface = SURFACES.find((s) => sel.includes(s));
      if (!surface || !isSurfaceRule(sel)) continue;
      // A painted line (`:before`/`:after`) is chrome decoration: it should
      // stay visible, and it covers no wallpaper area.
      if (/::?(before|after)\b/.test(subject(sel))) continue;
      const value = backgroundValue(rule.body);
      if (NO_PAINT.test(value)) continue;
      checked += 1;
      if (neutralisedByVariables(value, ourCss)) {
        exempt += 1;
        continue;
      }
      const theirs = specificity(sel);
      const stronger = ourSelectors.filter(
        (r) =>
          r.selector.includes(surface) &&
          /!important/.test(r.body) &&
          compare(specificity(r.selector), theirs) >= 0 &&
          /background(-color|-image)?\s*:\s*(transparent|none)/.test(r.body.replace(/\s+/g, " "))
      );
      if (!stronger.length) {
        failures.push({
          selector: sel,
          specificity: theirs.join(","),
          value: value.slice(0, 60),
          important: /!important/.test(rule.body),
        });
      }
    }
  }
  return { checked, exempt, failures };
}

function run() {
  const files = candidateCssFiles();
  if (!files.length) {
    console.log("VSCODE CSS WEIGHT TEST SKIPPED (no local VS Code stylesheet found)");
    return;
  }
  const cssFile = files[0];

  install();
  global.__MOCK_VSCODE__ = { appRoot: os.tmpdir(), version: "1.140.0", config: {} };
  const ext = require("../vscode/src/extension.js");
  const ours = ext.__internals.buildCss({
    imageUri: "vscode-file://x/a.png",
    imageVersion: "1-1",
    dim: 45,
    glass: 55,
    mode: "glass",
    fit: "cover",
    light: false,
  });

  const { checked, exempt, failures } = audit(ours, fs.readFileSync(cssFile, "utf8"));

  if (!checked) {
    console.log("VSCODE CSS WEIGHT TEST SKIPPED (no background rule found for a workbench surface)");
    return;
  }
  assert.equal(
    failures.length,
    0,
    "Wallvia's CSS does not outrank these VS Code rules, so those surfaces would stay opaque:\n" +
      failures
        .slice(0, 12)
        .map(
          (f) =>
            `  ${f.selector}  (specificity ${f.specificity}, paints ${f.value}${
              f.important ? ", !important" : ""
            })`
        )
        .join("\n")
  );

  // The exact rule behind the "wallpaper is invisible" report, pinned by hand:
  // VS Code's modern-UI floating card paints the sidebar with
  // `.monaco-workbench.floating-panels .part.sidebar` (0,4,0), and Wallvia's
  // generic clear is only (0,3,2). The override chain has to stay in the CSS.
  const bugRule = ".monaco-workbench.floating-panels .part.sidebar";
  const ourChain = /html body \.monaco-workbench\.floating-panels[^{,]*\.part\.sidebar/.exec(ours);
  assert.ok(ourChain, "the floating-panels sidebar override is present");
  assert.ok(
    compare(specificity(ourChain[0]), specificity(bugRule)) > 0,
    `the override (${specificity(ourChain[0]).join(",")}) must beat VS Code's rule (${specificity(bugRule).join(",")})`
  );

  console.log("VSCODE CSS WEIGHT TEST PASSED");
  console.log(`  ${checked} VS Code rules paint a workbench surface (${path.basename(cssFile)}):`);
  console.log(`  ${exempt} cleared by neutralised theme variables, ${checked - exempt} by a stronger !important clear,`);
  console.log("  the floating-panels override still outranks VS Code's own card paint,");
  console.log("  so no structural surface can go opaque and hide the wallpaper.");
}

module.exports = { audit, run, specificity };
if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error("VSCODE CSS WEIGHT FAILED:", e && e.message);
    process.exit(1);
  }
}
