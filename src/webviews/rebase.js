'use strict';
// Visual interactive rebase ("Edit history") editor.

const vscode = require('vscode');
const { webviewHtml, short } = require('../util');

class RebasePanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.panel = null;
    this.model = null;
    this.base = null;
  }

  async show(model, fromSha) {
    this.model = model;
    const from = await model.repo.commit(fromSha);
    this.base = from.parents[0] || null;
    const commits = await model.repo.log({ refs: [this.base ? `${this.base}..HEAD` : 'HEAD'], maxCount: 500, order: 'topo' });
    if (!commits.length) {
      vscode.window.showInformationMessage('That commit is not part of your current branch history.');
      return;
    }
    const hasMerges = commits.some(c => c.parents.length > 1);
    const pushed = await model.repo.isPushed(commits[commits.length - 1].sha);
    const bodies = await Promise.all(commits.map(c => model.repo.commit(c.sha).then(x => x.body).catch(() => c.subject)));
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('gitCompass.rebase', 'Edit History', vscode.ViewColumn.Active, {
        enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
      });
      this.panel.webview.html = webviewHtml(this.panel.webview, this.ctx.extensionUri, {
        title: 'Edit History', scripts: ['icons.js', 'rebase.js'], styles: ['rebase.css'], body: '<div id="app"></div>',
      });
      this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
      this.panel.onDidDispose(() => { this.panel = null; });
      this.ready = new Promise(r => { this._resolveReady = r; });
    } else {
      this.panel.reveal();
    }
    this.payload = {
      type: 'data',
      branch: model.state.branch,
      base: this.base ? short(this.base) : null,
      hasMerges,
      pushed,
      // git order: oldest first
      commits: commits.reverse().map((c, i) => ({
        sha: c.sha, short: short(c.sha), subject: c.subject, body: bodies[commits.length - 1 - i] || c.subject, author: c.author, date: c.date,
      })),
    };
    this.panel.webview.postMessage(this.payload);
  }

  async onMessage(msg) {
    const m = this.model;
    if (msg.type === 'ready') { if (this.payload) this.panel.webview.postMessage(this.payload); return; }
    if (msg.type === 'cancel') { this.panel.dispose(); return; }
    if (msg.type === 'help') { vscode.commands.executeCommand('gitCompass.openGuide', 'rewrite'); return; }
    if (msg.type !== 'start') return;
    const todo = msg.todo;
    const changed = todo.some((t, i) => t.action !== 'pick' || t.sha !== this.payload.commits[i].sha);
    if (!changed) { vscode.window.showInformationMessage('Nothing to do — every commit is set to "pick" in the original order.'); return; }
    if (this.payload.pushed) {
      const ok = await vscode.window.showWarningMessage('Some of these commits were already pushed.', {
        modal: true,
        detail: 'Editing them creates new commits. Afterwards your branch differs from the remote and you have to Force Push. Do this only on branches nobody else uses.',
      }, 'Continue');
      if (ok !== 'Continue') return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rewriting history…' },
        () => m.repo.rebaseInteractive(this.base, todo));
    } catch (e) {
      await m.refresh();
      if (m.state.operation && m.state.operation.kind === 'rebase') {
        if (this.panel) this.panel.dispose();
        vscode.commands.executeCommand('gitCompass.changes.focus');
        vscode.window.showWarningMessage('The rebase paused because of conflicts. Resolve them in "Merge Conflicts", mark them resolved, then press Continue in the Overview (or Abort to undo everything).',
          'How to resolve').then(p => p && vscode.commands.executeCommand('gitCompass.openGuide', 'conflicts'));
        return;
      }
      vscode.window.showErrorMessage(`Rebase failed: ${e.friendly || e.message}`);
      return;
    }
    await m.refresh();
    if (this.panel) this.panel.dispose();
    if (m.state.operation && m.state.operation.kind === 'rebase') {
      vscode.window.showInformationMessage('The rebase stopped at a commit marked "edit". Change files and stage them (or amend), then press Continue in the Overview.');
    } else {
      vscode.window.setStatusBarMessage('$(check) History rewritten', 5000);
      if (this.payload.pushed) {
        const p = await vscode.window.showInformationMessage('History rewritten. Your branch now differs from the remote.', 'Force Push');
        if (p) vscode.commands.executeCommand('gitCompass.forcePush', { root: m.root });
      }
    }
  }
}

module.exports = { RebasePanel };
