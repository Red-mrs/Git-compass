'use strict';
// Discovers repositories in the workspace, keeps their state fresh, and tells the views
// when something changed.

const vscode = require('vscode');
const path = require('path');
const { Repository } = require('./git');
const { cfg } = require('./util');

class RepoModel {
  constructor(manager, repo) {
    this.manager = manager;
    this.repo = repo;
    this.root = repo.root;
    this.name = path.basename(repo.root);
    this.state = null;
    this.refsSig = null;
    this._timer = null;
    this._running = null;
    this._again = false;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this.disposables = [];
    this._watch();
  }

  _watch() {
    const onEvent = uri => {
      const p = uri.fsPath;
      if (/[\\/]\.git[\\/](objects|lfs|modules)[\\/]/.test(p) || p.endsWith('.lock')) return;
      this.scheduleRefresh();
    };
    const add = pattern => {
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      w.onDidChange(onEvent); w.onDidCreate(onEvent); w.onDidDelete(onEvent);
      this.disposables.push(w);
    };
    add(new vscode.RelativePattern(vscode.Uri.file(this.root), '**'));
    // The git dir may live outside the work tree (worktrees, submodules) – watch it explicitly.
    const g = this.repo.gitDir;
    if (g) {
      add(new vscode.RelativePattern(vscode.Uri.file(g), '{HEAD,index,ORIG_HEAD,MERGE_HEAD,FETCH_HEAD,packed-refs,refs/**,rebase-merge/**,rebase-apply/**,CHERRY_PICK_HEAD,REVERT_HEAD,worktrees/*/HEAD,worktrees/*/locked}'));
      if (this.repo.commonDir && this.repo.commonDir !== g) {
        add(new vscode.RelativePattern(vscode.Uri.file(this.repo.commonDir), '{packed-refs,refs/**,worktrees/*/HEAD,worktrees/*/locked}'));
      }
    }
  }

  scheduleRefresh(delay = 300) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), delay);
  }

  async refresh() {
    if (this._running) { this._again = true; return this._running; }
    this._running = this._doRefresh().finally(() => {
      this._running = null;
      if (this._again) { this._again = false; this.refresh(); }
    });
    return this._running;
  }

  async _doRefresh() {
    try {
      const repo = this.repo;
      const [status, remotes, sig, stashes] = await Promise.all([
        repo.status(),
        repo.remotes().catch(() => []),
        repo.refsSignature().catch(() => ''),
        repo.stashes().catch(() => []),
      ]);
      const operation = repo.operation();
      const refsChanged = sig !== this.refsSig;
      this.refsSig = sig;
      const prev = this.state;
      this.state = {
        ...status,
        remotes,
        stashCount: stashes.length,
        operation,
        changeCount: status.unstaged.length + status.untracked.length,
        stagedCount: status.staged.length,
        conflictCount: status.conflicts.length,
      };
      const changed = !prev || refsChanged || JSON.stringify(prev) !== JSON.stringify(this.state);
      if (changed) this._onDidChange.fire({ model: this, refsChanged });
    } catch (e) {
      this.manager.log(`Refresh failed for ${this.root}: ${e.message}`);
    }
  }

  dispose() {
    clearTimeout(this._timer);
    this.disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }
}

class RepoManager {
  constructor(git, output) {
    this.git = git;
    this.output = output;
    this.models = new Map(); // root -> RepoModel
    this.current = null;
    this.disposables = [];
    this._onDidChangeRepos = new vscode.EventEmitter();
    this.onDidChangeRepos = this._onDidChangeRepos.event;
    this._onDidChange = new vscode.EventEmitter();
    /** Fires {model, refsChanged, switched} whenever the CURRENT repo changes state or another repo becomes current. */
    this.onDidChange = this._onDidChange.event;

    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()),
      vscode.window.onDidChangeActiveTextEditor(e => this._followEditor(e)),
      vscode.window.onDidChangeWindowState(s => { if (s.focused) this.models.forEach(m => m.scheduleRefresh(100)); }),
      vscode.workspace.onDidSaveTextDocument(doc => {
        const m = this.modelFor(doc.uri);
        if (m) m.scheduleRefresh(150);
      }),
    );
  }

  log(line) { this.output.appendLine(line); }

  get all() { return [...this.models.values()]; }

  async discover() {
    const roots = new Set();
    const folders = vscode.workspace.workspaceFolders || [];
    await Promise.all(folders.map(async f => {
      if (f.uri.scheme !== 'file') return;
      const r = await this.git.findRoot(f.uri.fsPath);
      if (r) roots.add(r);
      // also look one level deep for nested repositories (e.g. a folder with several projects)
      if (cfg('scanNestedRepositories', true)) {
        try {
          const entries = await vscode.workspace.fs.readDirectory(f.uri);
          await Promise.all(entries.filter(([n, t]) => t === vscode.FileType.Directory && !n.startsWith('.') && n !== 'node_modules').slice(0, 50).map(async ([n]) => {
            const sub = vscode.Uri.joinPath(f.uri, n);
            try {
              await vscode.workspace.fs.stat(vscode.Uri.joinPath(sub, '.git'));
              const rr = await this.git.findRoot(sub.fsPath);
              if (rr) roots.add(rr);
            } catch { /* no .git here */ }
          }));
        } catch { /* ignore */ }
      }
    }));
    // repositories the built-in Git extension knows about (covers deeper nesting)
    try {
      const api = getBuiltinGitApi();
      for (const r of api?.repositories || []) roots.add(path.normalize(r.rootUri.fsPath));
    } catch { /* ignore */ }

    for (const root of roots) await this.open(root, false);
    for (const [root, m] of this.models) {
      if (!roots.has(root) && !m.manual) { m.dispose(); this.models.delete(root); }
    }
    if (!this.current || !this.models.has(this.current.root)) {
      const ed = vscode.window.activeTextEditor;
      const fromEditor = ed && this.modelFor(ed.document.uri);
      this.setCurrent(fromEditor || this.all[0] || null);
    }
    this._onDidChangeRepos.fire();
  }

  /** Open (or return already opened) repository at root. */
  async open(root, manual = true) {
    root = path.normalize(root);
    const existing = this.findModel(root);
    if (existing) return existing;
    const repo = await new Repository(this.git, root).init();
    const model = new RepoModel(this, repo);
    model.manual = manual;
    model.onDidChange(e => { if (this.current === model) this._onDidChange.fire({ ...e, switched: false }); });
    this.models.set(root, model);
    await model.refresh();
    if (manual) this._onDidChangeRepos.fire();
    return model;
  }

  findModel(root) {
    root = path.normalize(root);
    for (const [r, m] of this.models) if (samePath(r, root)) return m;
    return null;
  }

  /** Repository containing the given file uri (deepest match). */
  modelFor(uri) {
    if (!uri || uri.scheme !== 'file') {
      if (uri && uri.scheme === 'gitcompass') {
        try { return this.findModel(JSON.parse(uri.query).root); } catch { return null; }
      }
      return null;
    }
    const p = uri.fsPath;
    let best = null;
    for (const m of this.models.values()) {
      if (isInside(p, m.root) && (!best || m.root.length > best.root.length)) best = m;
    }
    return best;
  }

  setCurrent(model) {
    if (this.current === model) return;
    this.current = model;
    vscode.commands.executeCommand('setContext', 'gitCompass.hasRepo', !!model);
    vscode.commands.executeCommand('setContext', 'gitCompass.multipleRepos', this.models.size > 1);
    this._onDidChange.fire({ model, refsChanged: true, switched: true });
  }

  _followEditor(editor) {
    if (!editor || !cfg('followActiveEditor', true)) return;
    const m = this.modelFor(editor.document.uri);
    if (m && m !== this.current) this.setCurrent(m);
  }

  refreshAll() { return Promise.all(this.all.map(m => m.refresh())); }

  dispose() {
    this.models.forEach(m => m.dispose());
    this.disposables.forEach(d => d.dispose());
  }
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(file, root) {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) || samePath(file, root);
}

let _gitApi;
function getBuiltinGitApi() {
  if (_gitApi !== undefined) return _gitApi;
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    _gitApi = ext && ext.isActive ? ext.exports.getAPI(1) : null;
  } catch { _gitApi = null; }
  return _gitApi;
}
function resetBuiltinGitApi() { _gitApi = undefined; }

module.exports = { RepoManager, RepoModel, getBuiltinGitApi, resetBuiltinGitApi, isInside };
