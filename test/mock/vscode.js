'use strict';
// A small in-memory stand-in for the `vscode` module, good enough to run the extension's
// activation, tree views, commands and webview hosts headlessly in plain Node.

const fs = require('fs');
const path = require('path');

const log = [];
const answers = []; // queued answers for showInformationMessage / showWarningMessage / showQuickPick / showInputBox

class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
  fire(e) { for (const l of [...this.listeners]) { try { l(e); } catch (err) { log.push(['listenerError', err]); console.error(err); } } }
  dispose() { this.listeners.clear(); }
}
const disposable = () => ({ dispose() {} });

class Uri {
  constructor(scheme, p, query = '', fragment = '') { this.scheme = scheme; this.path = p; this.query = query; this.fragment = fragment; }
  static file(p) { return new Uri('file', path.resolve(p).split(path.sep).join('/')); }
  static parse(s) {
    const m = /^([a-z][\w+.-]*):(?:\/\/[^/]*)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(s);
    return m ? new Uri(m[1], m[2], m[3] || '', m[4] || '') : new Uri('file', s);
  }
  static joinPath(u, ...segs) { return new Uri(u.scheme, path.posix.join(u.path, ...segs), u.query); }
  static from(c) { return new Uri(c.scheme, c.path || '', c.query || '', c.fragment || ''); }
  get fsPath() { return this.path.split('/').join(path.sep); }
  with(c) { return new Uri(c.scheme ?? this.scheme, c.path ?? this.path, c.query ?? this.query, c.fragment ?? this.fragment); }
  toString() { return `${this.scheme}://${this.path}${this.query ? '?' + this.query : ''}`; }
  toJSON() { return { scheme: this.scheme, path: this.path, query: this.query }; }
}

class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString {
  constructor(value = '', supportThemeIcons) { this.value = value; this.supportThemeIcons = supportThemeIcons; this.isTrusted = false; }
  appendMarkdown(s) { this.value += s; return this; }
  appendText(s) { this.value += s; return this; }
}
class TreeItem {
  constructor(labelOrUri, collapsibleState = 0) {
    if (labelOrUri instanceof Uri) this.resourceUri = labelOrUri; else this.label = labelOrUri;
    this.collapsibleState = collapsibleState;
  }
}
class FileDecoration { constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); } }
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
class Selection extends Range { get active() { return this.end; } }
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
class Hover { constructor(contents) { this.contents = contents; } }

// ---- configuration -----------------------------------------------------------------------
const configStore = new Map();
const onDidChangeConfiguration = new EventEmitter();
function getConfiguration(section) {
  return {
    get(key, def) { const k = `${section}.${key}`; return configStore.has(k) ? configStore.get(k) : def; },
    async update(key, value) {
      const k = `${section}.${key}`;
      if (value === undefined) configStore.delete(k); else configStore.set(k, value);
      onDidChangeConfiguration.fire({ affectsConfiguration: s => k === s || k.startsWith(s + '.') });
    },
  };
}

// ---- documents & editors -----------------------------------------------------------------
const contentProviders = new Map();
function makeDoc(uri, text) {
  const lines = text.split('\n');
  return {
    uri, version: 1, isDirty: false, languageId: 'plaintext',
    getText: () => text,
    get lineCount() { return lines.length; },
    lineAt: i => ({ text: lines[i], range: new Range(i, 0, i, (lines[i] || '').length) }),
  };
}
async function openTextDocument(arg) {
  const uri = typeof arg === 'string' ? Uri.file(arg) : arg;
  if (uri.scheme !== 'file') {
    const p = contentProviders.get(uri.scheme);
    if (!p) throw new Error(`No content provider for ${uri.scheme}`);
    return makeDoc(uri, await p.provideTextDocumentContent(uri));
  }
  return makeDoc(uri, fs.readFileSync(uri.fsPath, 'utf8'));
}
const onDidChangeActiveTextEditor = new EventEmitter();
const window = {
  activeTextEditor: undefined,
  state: { focused: true },
  onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
  onDidChangeTextEditorSelection: new EventEmitter().event,
  onDidChangeWindowState: new EventEmitter().event,
  createOutputChannel: (name) => ({ name, lines: [], appendLine(l) { this.lines.push(l); if (process.env.MOCK_DEBUG) console.log('[out]', l); }, show() {}, dispose() {} }),
  createTreeView: (id, opts) => ({ id, ...opts, dispose() {} }),
  registerWebviewViewProvider: (id, provider) => { webviewViews.set(id, provider); return disposable(); },
  registerFileDecorationProvider: () => disposable(),
  createStatusBarItem: () => ({ text: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
  createTextEditorDecorationType: () => ({ dispose() {} }),
  setStatusBarMessage: (t) => { log.push(['status', t]); return disposable(); },
  withProgress: async (opts, fn) => fn({ report() {} }, { isCancellationRequested: false }),
  async showTextDocument(docOrUri) {
    const doc = docOrUri.getText ? docOrUri : await openTextDocument(docOrUri);
    const sel = new Selection(0, 0, 0, 0);
    this.activeTextEditor = { document: doc, selection: sel, selections: [sel], setDecorations() {} };
    onDidChangeActiveTextEditor.fire(this.activeTextEditor);
    return this.activeTextEditor;
  },
  createWebviewPanel: (viewType, title) => {
    const panel = { viewType, title, webview: makeWebview(), reveal() {}, _dispose: new EventEmitter() };
    panel.onDidDispose = panel._dispose.event;
    panel.dispose = () => panel._dispose.fire();
    panels.push(panel);
    return panel;
  },
  createTerminal: () => ({ show() {}, sendText(t) { log.push(['terminal', t]); } }),
};
for (const kind of ['Information', 'Warning', 'Error']) {
  window[`show${kind}Message`] = async (msg, ...items) => {
    log.push([kind.toLowerCase(), msg]);
    if (process.env.MOCK_DEBUG) console.log(`[${kind}]`, msg);
    const flat = items.filter(i => typeof i === 'string');
    if (answers.length && flat.includes(answers[0])) return answers.shift();
    return undefined;
  };
}
window.showQuickPick = async (items) => {
  const list = await items;
  if (!answers.length) return undefined;
  const a = answers.shift();
  return typeof a === 'function' ? list.find(a) : list.find(i => (i.label || i) === a);
};
window.showInputBox = async () => (answers.length ? answers.shift() : undefined);
window.showOpenDialog = async () => undefined;

const panels = [];
const webviewViews = new Map();
function makeWebview() {
  const em = new EventEmitter();
  return {
    options: {}, html: '', cspSource: 'mock-csp', posted: [],
    asWebviewUri: u => u,
    postMessage(m) { this.posted.push(m); return Promise.resolve(true); },
    onDidReceiveMessage: em.event,
    _send: (m) => em.fire(m),
  };
}

// ---- commands ------------------------------------------------------------------------------
const registry = new Map();
const contextKeys = new Map();
const commands = {
  registerCommand(id, fn) { registry.set(id, fn); return { dispose: () => registry.delete(id) }; },
  async executeCommand(id, ...args) {
    if (id === 'setContext') { contextKeys.set(args[0], args[1]); return; }
    log.push(['command', id]);
    if (registry.has(id)) return registry.get(id)(...args);
    const viewId = id.endsWith('.focus') && id.slice(0, -6);
    if (viewId && webviewViews.has(viewId) && !resolvedViews.has(viewId)) {
      const view = { webview: makeWebview(), visible: true, onDidChangeVisibility: () => disposable() };
      webviewViews.get(viewId).resolveWebviewView(view);
      resolvedViews.set(viewId, view);
      if (viewId === 'gitCompass.overview') overviewView.current = view;
    }
    return undefined;
  },
};
const overviewView = { current: null };
const resolvedViews = new Map();

// ---- workspace -------------------------------------------------------------------------------
const workspace = {
  workspaceFolders: [],
  getConfiguration,
  onDidChangeConfiguration: onDidChangeConfiguration.event,
  onDidChangeWorkspaceFolders: new EventEmitter().event,
  onDidSaveTextDocument: new EventEmitter().event,
  onDidChangeTextDocument: new EventEmitter().event,
  onDidCloseTextDocument: new EventEmitter().event,
  createFileSystemWatcher: () => ({ onDidChange: () => disposable(), onDidCreate: () => disposable(), onDidDelete: () => disposable(), dispose() {} }),
  registerTextDocumentContentProvider: (scheme, p) => { contentProviders.set(scheme, p); return disposable(); },
  openTextDocument,
  updateWorkspaceFolders(start, del, ...add) { this.workspaceFolders.splice(start, del, ...add.map((f, i) => ({ uri: f.uri, name: f.name, index: start + i }))); return true; },
  fs: {
    async readDirectory(u) { return fs.readdirSync(u.fsPath, { withFileTypes: true }).map(d => [d.name, d.isDirectory() ? 2 : 1]); },
    async stat(u) { const s = fs.statSync(u.fsPath); return { type: s.isDirectory() ? 2 : 1 }; },
    async delete(u) { fs.rmSync(u.fsPath, { recursive: true, force: true }); },
  },
};

let clipboard = '';
const memento = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); } }; };
let extensionRoot = null;
let activated = null;
const extensions = {
  getExtension(id) {
    if (id === 'radomir-novy.git-compass') {
      return {
        extensionPath: extensionRoot,
        activate: async () => {
          if (!activated) {
            const ctx = { subscriptions: [], extensionUri: Uri.file(extensionRoot), extensionPath: extensionRoot, globalState: memento(), workspaceState: memento() };
            activated = await require(path.join(extensionRoot, 'src/extension.js')).activate(ctx);
          }
          return activated;
        },
      };
    }
    return undefined;
  },
};

module.exports = {
  __mock: { log, answers, panels, webviewViews, overviewView, resolvedViews, contextKeys, setRoot: r => { extensionRoot = r; } },
  EventEmitter, Uri, ThemeIcon, ThemeColor, MarkdownString, TreeItem, FileDecoration, Position, Range, Selection, RelativePattern, Hover,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  window, workspace, commands, extensions,
  authentication: { getSession: async () => undefined, onDidChangeSessions: new EventEmitter().event },
  env: { clipboard: { writeText: async t => { clipboard = t; }, readText: async () => clipboard }, openExternal: async u => { log.push(['open', String(u)]); return true; } },
  languages: { registerHoverProvider: () => disposable() },
};
