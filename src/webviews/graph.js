'use strict';
// Commit Graph: the same webview is shown as a big editor tab (GraphPanel) and as a compact
// sidebar view (GraphView). GraphHost holds the shared logic for one webview.

const vscode = require('vscode');
const { webviewHtml, cfg } = require('../util');
const { computeGraph } = require('../graphLayout');
const { openRefDiff, openFileAt } = require('../diff');
const { githubRemote } = require('../github');

class GraphHost {
  /**
   * @param {object} ctx extension context bag
   * @param {{compact: boolean, followCurrent: boolean}} opts
   */
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.manager = ctx.manager;
    this.compact = opts.compact;
    this.followCurrent = opts.followCurrent;
    this.webview = null;
    this.model = null;
    this.limit = this.pageSize();
    this.showAll = true;
    this.pendingSelect = null;
    this.isVisible = () => true;
    this.dirty = false;
    this._timer = null;
    ctx.extensionContext.subscriptions.push(this.manager.onDidChange(e => {
      if (!this.webview) return;
      if (e.switched && (this.followCurrent || e.model)) this.model = this.followCurrent ? this.manager.current : e.model;
      this.schedule();
    }));
  }

  pageSize() { return this.compact ? cfg('graph.sidebarPageSize', 150) : cfg('graph.pageSize', 400); }

  attach(webview) {
    this.webview = webview;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    webview.html = webviewHtml(webview, this.ctx.extensionUri, {
      title: 'Commit Graph', scripts: ['icons.js', 'graph.js'], styles: ['graph.css'],
      body: `<div id="app"${this.compact ? ' data-mode="sidebar"' : ''}></div>`,
    });
    webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.ctx.output.appendLine(`Graph error: ${e.stack || e}`)));
  }

  detach() { this.webview = null; }

  schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.load(), 300);
  }

  post(msg) { if (this.webview) this.webview.postMessage(msg); }

  async load() {
    if (this.followCurrent) this.model = this.manager.current;
    const m = this.model;
    if (!m || !m.state || !this.webview) return;
    if (!this.isVisible()) { this.dirty = true; return; }
    this.dirty = false;
    const s = m.state;
    if (this.onTitle) this.onTitle(m);
    const commits = s.initial ? [] : await m.repo.log({ all: this.showAll, refs: ['HEAD'], maxCount: this.limit + 1, order: 'date' });
    const hasMore = commits.length > this.limit;
    if (hasMore) commits.length = this.limit;
    const unpushed = s.remotes.length ? await m.repo.unpushed(!!s.upstream) : new Set();
    const wipCount = s.staged.length + s.unstaged.length + s.untracked.length + s.conflicts.length;
    const list = [...commits];
    if (wipCount && s.oid) list.unshift({ sha: 'WORKING', parents: [s.oid], subject: '', refs: [], wip: true });
    const { rows, width } = computeGraph(list);
    const gh = githubRemote(s.remotes);
    this.post({
      type: 'data',
      root: m.root,
      repoName: m.name,
      branch: s.branch,
      head: s.oid,
      width,
      hasMore,
      showAll: this.showAll,
      github: !!gh,
      wip: wipCount ? { staged: s.staged.length, changed: s.unstaged.length + s.untracked.length, conflicts: s.conflicts.length } : null,
      rows: list.map((c, i) => ({
        sha: c.sha,
        parents: c.parents,
        subject: c.subject,
        author: c.author,
        email: c.email,
        date: c.date,
        refs: c.refs,
        wip: !!c.wip,
        unpushed: unpushed.has(c.sha),
        col: rows[i].col,
        lines: rows[i].lines,
        merge: rows[i].merge,
      })),
      select: this.pendingSelect,
    });
    this.pendingSelect = null;
  }

  async onMessage(msg) {
    if (this.followCurrent) this.model = this.manager.current;
    const m = this.model;
    if (!m) return;
    switch (msg.type) {
      case 'ready': return this.load();
      case 'loadMore': this.limit += this.pageSize(); return this.load();
      case 'toggleAll': this.showAll = !!msg.value; return this.load();
      case 'refresh': await m.refresh(); return this.load();
      case 'details': {
        const c = await m.repo.commit(msg.sha);
        const files = await m.repo.commitFiles(c.sha, c.parents);
        const containedIn = await m.repo.out(['branch', '-a', '--contains', c.sha, '--format=%(refname:short)'], { quiet: true }).catch(() => '');
        this.post({ type: 'details', commit: c, files, branches: containedIn.split('\n').filter(Boolean).slice(0, 20) });
        return;
      }
      case 'openFile': return openRefDiff(m.root, msg.file, msg.parent || null, msg.sha);
      case 'openFileAt': return openFileAt(m.root, msg.path, msg.sha);
      case 'command': return vscode.commands.executeCommand(msg.command, { root: m.root, ...(msg.arg || {}) });
      case 'search': {
        // server-side search for things not visible in the list (changed text, file path)
        const opts = { all: this.showAll, refs: ['HEAD'], maxCount: 1000, order: 'date' };
        if (msg.mode === 'content') opts.content = msg.text;
        else if (msg.mode === 'file') { opts.file = msg.text; opts.follow = false; }
        else if (msg.mode === 'message') opts.grep = msg.text;
        else if (msg.mode === 'author') opts.author = msg.text;
        let shas = [];
        try { shas = (await m.repo.log(opts)).map(c => c.sha); } catch { /* invalid input */ }
        this.post({ type: 'searchResult', shas, text: msg.text, mode: msg.mode });
        return;
      }
      case 'focusChanges': return vscode.commands.executeCommand('gitCompass.changes.focus');
    }
  }
}

/** Big graph in an editor tab. */
class GraphPanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.panel = null;
    this.host = new GraphHost(ctx, { compact: false, followCurrent: false });
    this.host.onTitle = m => { if (this.panel && this.panel.title !== `Graph: ${m.name}`) this.panel.title = `Graph: ${m.name}`; };
  }

  show(model, sha) {
    this.host.model = model;
    this.host.pendingSelect = sha || null;
    if (this.panel) {
      this.panel.reveal(undefined, false);
      this.host.load();
      return;
    }
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('gitCompass.graph', `Graph: ${model.name}`, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media], enableFindWidget: true,
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'graph-icon.svg');
    this.host.attach(this.panel.webview);
    this.panel.onDidDispose(() => { this.panel = null; this.host.detach(); });
  }
}

/** Compact graph in the Git Compass sidebar; always shows the current repository. */
class GraphView {
  constructor(ctx) {
    this.host = new GraphHost(ctx, { compact: true, followCurrent: true });
    this.view = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    this.host.isVisible = () => !!(this.view && this.view.visible);
    this.host.attach(view.webview);
    view.onDidChangeVisibility(() => { if (view.visible && this.host.dirty) this.host.load(); });
    view.onDidDispose && view.onDidDispose(() => { this.view = null; this.host.detach(); });
  }
}

module.exports = { GraphPanel, GraphView, GraphHost };
