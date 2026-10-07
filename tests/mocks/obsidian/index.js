// tests/mocks/obsidian/index.js
// Minimal mock of the Obsidian plugin API — enough to smoke-load the plugin,
// render its settings tab and drive its floating panel outside the app.
//
// `Setting` keeps a record of every row it was asked to render (`name`,
// `desc` and the controls passed to addSlider/addToggle/…) so tests can assert
// what the settings page actually contains — the bug class where the page
// silently stops rendering halfway. Test fixture only; not shipped.
const { createMockElement, byClass, oneByClass } = require("./dom.js");

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  registerEvent() {}
  addCommand() {}
  addRibbonIcon() {
    return {};
  }
  addSettingTab() {}
  async loadData() {
    return null;
  }
  async saveData() {}
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createMockElement("div");
  }
  display() {}
}

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = createMockElement("div");
  }
  setTitle() { return this; }
  open() { return this; }
  close() { return this; }
}

class FuzzySuggestModal {
  constructor(app) {
    this.app = app;
  }
  setPlaceholder() {
    return this;
  }
  open() {
    return this;
  }
  close() {
    return this;
  }
  getItems() {
    return [];
  }
  getItemText(x) {
    return String(x);
  }
  onChooseItem() {}
}

/** Shared chainable recorder shape for the `add*` control builders. */
function control(type, extra) {
  const rec = {
    type,
    /** Set by `onChange`; `fire()` calls it like the real control would. */
    handler: null,
    setValue(v) {
      rec.value = v;
      return rec;
    },
    setDisabled() {
      return rec;
    },
    setTooltip() {
      return rec;
    },
    onChange(fn) {
      rec.handler = fn;
      return rec;
    },
    /** Test-side: fire the change handler like the real control would. */
    fire(value) {
      rec.value = value;
      if (rec.handler) rec.handler(value);
      return rec;
    },
    ...extra,
  };
  return rec;
}

class Setting {
  constructor(containerEl) {
    this.settingEl = containerEl && containerEl.appendChild ? createMockElement("div") : null;
    if (this.settingEl) {
      this.settingEl.__setting = this;
      containerEl.appendChild(this.settingEl);
    }
    this.name = "";
    this.desc = "";
    this.heading = false;
    this.controls = [];
    this.containerEl = containerEl;
  }
  setName(name) {
    this.name = String(name);
    return this;
  }
  setDesc(desc) {
    this.desc = String(desc);
    return this;
  }
  setHeading() {
    this.heading = true;
    return this;
  }
  setClass(cls) {
    this.cls = cls;
    return this;
  }
  setDisabled() {
    return this;
  }
  add(cb) {
    cb(this);
    return this;
  }
  /** The control the test cares about, by kind. */
  control(type) {
    return this.controls.find((c) => c.type === type);
  }
  addToggle(cb) {
    const rec = control("toggle");
    cb(rec);
    this.controls.push(rec);
    return this;
  }
  addSlider(cb) {
    const rec = control("slider", {
      limits: null,
      dynamic: false,
      setLimits(min, max, step) {
        rec.limits = { min, max, step };
        return rec;
      },
      setDynamicTooltip() {
        rec.dynamic = true;
        return rec;
      },
      setInstant() {
        return rec;
      },
    });
    cb(rec);
    this.controls.push(rec);
    return this;
  }
  addDropdown(cb) {
    const rec = control("dropdown", {
      options: [],
      addOption(value, label) {
        rec.options.push({ value, label });
        return rec;
      },
      addOptions() {
        return rec;
      },
    });
    cb(rec);
    this.controls.push(rec);
    return this;
  }
  addText(cb) {
    const rec = control("text", {
      setPlaceholder(v) {
        rec.placeholder = v;
        return rec;
      },
    });
    cb(rec);
    this.controls.push(rec);
    return this;
  }
  addColorPicker(cb) {
    const rec = control("color", { value: "" });
    cb(rec);
    this.controls.push(rec);
    return this;
  }
  addButton(cb) {
    const rec = control("button", {
      text: "",
      setButtonText(v) {
        rec.text = String(v);
        return rec;
      },
      setCta() {
        return rec;
      },
      setWarning() {
        return rec;
      },
      setIcon() {
        return rec;
      },
      onClick(fn) {
        rec.click = fn;
        return rec;
      },
    });
    cb(rec);
    this.controls.push(rec);
    return this;
  }
}

class Notice {
  constructor(message) {
    this.message = message;
    this.msg = message;
  }
}

class TFile {}

// Minimal surface of the real `Platform` object; the plugin uses only
// `isDesktop` to decide whether Node APIs may be required.
const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
};

// Same normalisation the real helper performs for the cases the plugin hits:
// backslashes to slashes, no leading "./" or "/", no doubled separators.
function normalizePath(p) {
  return String(p)
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/{2,}/g, "/");
}

module.exports = {
  Plugin,
  PluginSettingTab,
  FuzzySuggestModal,
  Modal,
  Setting,
  Notice,
  TFile,
  Platform,
  normalizePath,
  // The declarative settings API is 1.13.0+; this fixture models an older
  // app, so the plugin keeps rendering through display().
  requireApiVersion: () => false,
  // Test helpers (not part of the real API).
  createMockElement,
  byClass,
  oneByClass,
};
