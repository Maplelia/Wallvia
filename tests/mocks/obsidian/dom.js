// tests/mocks/obsidian/dom.js — the smallest DOM that lets the plugin's
// panel and settings page render outside Obsidian.
//
// Implements only what the plugin touches, including Obsidian's own DOM sugar
// (createDiv/createEl/empty/addClass/setText), which the real app installs on
// HTMLElement. Test fixture only; never shipped.

function applyInfo(el, info) {
  if (!info) return;
  if (info.cls) el.classList.add(...String(info.cls).split(/\s+/).filter(Boolean));
  if (info.text !== undefined) el.textContent = String(info.text);
  if (info.title !== undefined) el.title = String(info.title);
  if (info.type !== undefined) el.type = String(info.type);
  if (info.value !== undefined) el.value = info.value;
  if (info.placeholder !== undefined) el.placeholder = String(info.placeholder);
  if (info.attr) for (const [k, v] of Object.entries(info.attr)) el.setAttribute(k, v);
}

function createMockElement(tag = "div") {
  const classes = new Set();
  const style = {};
  const listeners = new Map();
  const tagName = String(tag).toUpperCase();

  const el = {
    tagName,
    children: [],
    parentEl: null,
    // The real DOM exposes the parent as `parentElement`. The declarative
    // settings rows read it to place a custom element under their own row,
    // so without this the mock would silently exercise only the fallback.
    get parentElement() {
      return el.parentEl;
    },
    textContent: "",
    innerHTML: "",
    title: "",
    type: "",
    value: "",
    placeholder: "",
    checked: false,
    disabled: false,
    hidden: false,
    attributes: {},
    style,

    classList: {
      add: (...c) => c.filter(Boolean).forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    },
    get className() {
      return [...classes].join(" ");
    },
    set className(v) {
      classes.clear();
      String(v)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },

    // --- attributes / events ------------------------------------------------
    setAttribute(k, v) {
      el.attributes[k] = String(v);
    },
    getAttribute(k) {
      return el.attributes[k] ?? null;
    },
    removeAttribute(k) {
      delete el.attributes[k];
    },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(cb);
    },
    removeEventListener(type, cb) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    /** Fire every handler registered for `type` (test-side). */
    dispatch(type, event = {}) {
      for (const cb of [...(listeners.get(type) || [])]) cb(event);
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },

    // --- Obsidian's DOM sugar ----------------------------------------------
    createEl(t, info) {
      const child = createMockElement(t);
      applyInfo(child, info);
      el.appendChild(child);
      return child;
    },
    createDiv(info) {
      return el.createEl("div", info);
    },
    createSpan(info) {
      return el.createEl("span", info);
    },
    createSvg(tag, info) {
      const child = createMockElement(tag);
      applyInfo(child, typeof info === "string" ? { cls: info } : info);
      el.appendChild(child);
      return child;
    },
    empty() {
      for (const child of el.children) child.parentEl = null;
      el.children.length = 0;
      el.textContent = "";
      return el;
    },
    setText(text) {
      el.textContent = String(text);
      el.children.length = 0;
      return el;
    },
    addClass(...c) {
      el.classList.add(...c);
      return el;
    },
    removeClass(...c) {
      el.classList.remove(...c);
      return el;
    },
    toggleClass(c, on) {
      el.classList.toggle(c, on);
      return el;
    },
    appendChild(child) {
      el.children.push(child);
      if (child) child.parentEl = el;
      return child;
    },
    remove() {
      if (!el.parentEl) return;
      const i = el.parentEl.children.indexOf(el);
      if (i >= 0) el.parentEl.children.splice(i, 1);
      el.parentEl = null;
    },

    // --- queries ------------------------------------------------------------
    querySelector(sel) {
      return find(el, sel, true)[0] || null;
    },
    querySelectorAll(sel) {
      return find(el, sel, false);
    },
    getBoundingClientRect() {
      const left = Number.parseFloat(style.left) || 0;
      const top = Number.parseFloat(style.top) || 0;
      return { left, top, width: 40, height: 40, right: left + 40, bottom: top + 40 };
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    blur() {},
    click() {
      el.dispatch("click", {});
    },
  };

  // A `<video>` is only a stub here, but the video-wallpaper layer calls
  // exactly these members: `play()` (returns a promise, like the real one),
  // `pause()`, `load()`, `paused`, and the `poster` property. Without them the
  // layer would throw and the test would be measuring the mock, not the code.
  if (tagName === "VIDEO") {
    let paused = true;
    Object.defineProperties(el, {
      paused: {
        get: () => paused,
        enumerable: true,
      },
      play: {
        value: () => {
          paused = false;
          el.dispatch("play", {});
          return Promise.resolve();
        },
        enumerable: false,
      },
      pause: {
        value: () => {
          paused = true;
          el.dispatch("pause", {});
        },
        enumerable: false,
      },
      load: {
        value: () => el.dispatch("load", {}),
        enumerable: false,
      },
    });
    el.poster = "";
    el.muted = true;
    el.loop = false;
    el.autoplay = false;
    el.playsInline = false;
  }

  // `style.setProperty` must not appear as an own enumerable key of `style`
  // when tests read values, so keep it non-enumerable.
  Object.defineProperties(style, {
    setProperty: {
      value(k, v) {
        style[k] = String(v);
      },
      enumerable: false,
    },
    removeProperty: {
      value(k) {
        delete style[k];
      },
      enumerable: false,
    },
    getPropertyValue: {
      value(k) {
        return style[k] ?? "";
      },
      enumerable: false,
    },
  });

  return el;
}

function matches(el, selector) {
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
  return el.tagName === String(selector).toUpperCase();
}

/**
 * Descendant-only selectors (`".a video"`), which the plugin uses to reach the
 * `<video>` inside its layer. The real `querySelector` handles the whole grammar;
 * this covers exactly what the tests ask for, so a new call site that needs more
 * fails loudly here instead of silently returning null.
 */
function matchesChain(el, parts) {
  if (!matches(el, parts[parts.length - 1])) return false;
  let index = parts.length - 2;
  let node = el.parentEl;
  while (index >= 0 && node) {
    if (matches(node, parts[index])) index -= 1;
    node = node.parentEl;
  }
  return index < 0;
}

function find(root, selector, firstOnly) {
  const out = [];
  const parts = String(selector).trim().split(/\s+/).filter(Boolean);
  const walk = (node) => {
    for (const child of node.children || []) {
      if (matchesChain(child, parts)) {
        out.push(child);
        if (firstOnly) return true;
      }
      if (walk(child)) return true;
    }
    return false;
  };
  walk(root);
  return out;
}

/** Every element in the subtree carrying `cls` (order = document order). */
function byClass(root, cls) {
  return find(root, "." + cls, false);
}

/** The single element carrying `cls`, or null. */
function oneByClass(root, cls) {
  return byClass(root, cls)[0] || null;
}

/**
 * Install `document` / `window` globals. Returns the mock `document.body`.
 * Each test gets a fresh tree, so ordering between tests cannot matter.
 */
function installDom() {
  const body = createMockElement("body");
  global.document = {
    body,
    createElement: (tag) => createMockElement(tag),
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
    hasFocus: () => true,
  };
  global.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  };
  return body;
}

/**
 * `document.body` for the suites that drive `apply()`/`onunload()` without
 * rendering any UI: the same fully-featured mock element, so a new class-list
 * or inline-style call in `apply()` cannot break them the way the three
 * hand-written `{ toggle, remove }` stubs did — twice.
 */
function installBodyDom() {
  const body = createMockElement("body");
  global.document = {
    body,
    createElement: (tag) => createMockElement(tag),
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
    hasFocus: () => true,
  };
  global.window = {
    innerWidth: 1280,
    innerHeight: 800,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener() {},
    removeEventListener() {},
  };
  return body;
}

module.exports = { createMockElement, installDom, installBodyDom, byClass, oneByClass };
