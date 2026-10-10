// tests/mocks/vscode/index.js
// Minimal `vscode` mock for smoke-testing the extension outside VS Code.
// The test configures it via global.__MOCK_VSCODE__.
// Test fixture only; never shipped with the extension.
const cfg = global.__MOCK_VSCODE__ || {};

const commands = {};
const configStore = Object.assign({}, cfg.config || {});

/**
 * Faithful-enough Uri: percent-encodes each path segment (including a Windows
 * drive letter, as "c%3A") so tests exercise the same encoded form the real
 * VS Code Uri produces.
 */
function makeUri(scheme, authority, fsPath) {
  const segments = String(fsPath).split("\\").join("/").split("/").filter(Boolean);
  const encoded = segments
    .map((seg, i) =>
      i === 0 && /^[a-zA-Z]:$/.test(seg) ? seg[0].toLowerCase() + "%3A" : encodeURIComponent(seg)
    )
    .join("/");
  return {
    scheme,
    authority,
    fsPath,
    path: "/" + encoded,
    with(changes) {
      return makeUri(changes.scheme || scheme, changes.authority ?? authority, fsPath);
    },
    toString() {
      return `${scheme}://${authority}/${encoded}`;
    },
  };
}

module.exports = {
  version: cfg.version || "1.139.1",
  env: { appRoot: cfg.appRoot },
  /** Live configuration store the extension writes through; tests assert on it. */
  __configStore: configStore,
  Uri: { file: (p) => makeUri("file", "", p) },
  ConfigurationTarget: { Global: 1 },
  commands: {
    registerCommand(name, cb) {
      commands[name] = cb;
      return { dispose() {} };
    },
    executeCommand(name) {
      // Recorded so a test can prove the extension asked for a window reload.
      (global.__MOCK_EXECUTED__ = global.__MOCK_EXECUTED__ || []).push(name);
      if (commands[name]) return commands[name]();
      return Promise.resolve();
    },
    __commands: commands,
  },
  workspace: {
    /**
     * VS Code's Restricted Mode flag. `ensureTrusted()` refuses to patch an
     * untrusted window, so the default here has to be trusted; set
     * global.__MOCK_VSCODE__.isTrusted = false to exercise the refusal path.
     */
    isTrusted: cfg.isTrusted !== false,
    getConfiguration() {
      return {
        get(key, dflt) {
          return key in configStore ? configStore[key] : dflt;
        },
        update(key, value) {
          configStore[key] = value;
          return Promise.resolve();
        },
      };
    },
  },
  window: {
    /**
     * Output channel stub: the extension logs what the picker decided, and the
     * test reads those lines back through `global.__MOCK_LOG__`.
     */
    createOutputChannel: (name) => ({
      name,
      appendLine(line) {
        (global.__MOCK_LOG__ = global.__MOCK_LOG__ || []).push(line);
      },
      dispose() {},
    }),
    /** The extension announces the auto-reload here; recorded for tests. */
    setStatusBarMessage: (text) => {
      (global.__MOCK_STATUS__ = global.__MOCK_STATUS__ || []).push(text);
      return { dispose() {} };
    },
    showOpenDialog: () => Promise.resolve(cfg.pick ? [{ fsPath: cfg.pick }] : []),
    /**
     * QuickPick stub: records the offered items (global.__MOCK_QUICKPICK__)
     * and returns one of them. global.__MOCK_VSCODE__.quickPickIndex picks
     * which (default 0 = the first item); -1 simulates the user cancelling.
     */
    showQuickPick: (items) => {
      const list = Array.isArray(items) ? items : [];
      global.__MOCK_QUICKPICK__ = list;
      const idx = typeof cfg.quickPickIndex === "number" ? cfg.quickPickIndex : 0;
      return Promise.resolve(idx >= 0 ? list[idx] : undefined);
    },
    showInformationMessage: (m) => {
      (global.__MOCK_MESSAGES__ = global.__MOCK_MESSAGES__ || []).push(["info", m]);
      return Promise.resolve();
    },
    showErrorMessage: (m) => {
      (global.__MOCK_MESSAGES__ = global.__MOCK_MESSAGES__ || []).push(["error", m]);
      return Promise.resolve();
    },
    /**
     * `ensureTrusted()` asks this when a window is in Restricted Mode. Default
     * = dismissed (resolves undefined); set global.__MOCK_VSCODE__.warningChoice
     * to answer with a button title.
     */
    showWarningMessage: (m) => {
      (global.__MOCK_MESSAGES__ = global.__MOCK_MESSAGES__ || []).push(["warn", m]);
      return Promise.resolve(cfg.warningChoice);
    },
    /**
     * Records every created panel (global.__MOCK_PANELS__) so a test can read
     * the HTML the extension assigns and the status messages it pushes.
     * `reveal()` exists so the "panel is already open" path can be exercised,
     * and `webview.__send()` lets a test play the webview: that is how the
     * video-frame round trip (request → decode → reply) is covered without a
     * browser.
     */
    createWebviewPanel: (viewType, title) => {
      const panel = {
        viewType,
        title,
        __messages: [],
        __reveals: 0,
        reveal() {
          panel.__reveals += 1;
        },
        webview: {
          html: "",
          cspSource: "vscode-resource://test",
          asWebviewUri: (uri) => uri,
          __handler: null,
          onDidReceiveMessage(handler) {
            panel.webview.__handler = handler;
            return { dispose() {} };
          },
          /** Play the page: hand a message to the extension's handler. */
          __send(msg) {
            return panel.webview.__handler ? panel.webview.__handler(msg) : undefined;
          },
          postMessage(msg) {
            panel.__messages.push(msg);
          },
        },
        dispose() {},
      };
      (global.__MOCK_PANELS__ = global.__MOCK_PANELS__ || []).push(panel);
      return panel;
    },
  },
  ViewColumn: { Beside: 2, Active: -1 },
};
