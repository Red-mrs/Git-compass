'use strict';
// Sidebar "Overview" webview: branch status, sync buttons, next-step suggestion, commit box, quick actions.

const vscode = require('vscode');
const { webviewHtml, short, cfg } = require('../util');
const { githubRemote } = require('../github');

class OverviewProvider {
  constructor(ctx) {
    this.ctx = ctx;
    this.manager = ctx.manager;
    this.view = null;
    this.drafts = ctx.extensionContext.workspaceState.get('gitCompass.drafts', {});
    this._timer = null;
    ctx.extensionContext.subscriptions.push(
      this.manager.onDidChange(() => this.schedule()),
      this.manager.onDidChangeRepos(() => this.schedule()),
    );
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = webviewHtml(view.webview, this.ctx.extensionUri, {
      title: 'Overview', scripts: ['icons.js', 'overview.js'], styles: ['overview.css'], body: '<div id="app"></div>',
    });
    view.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    view.onDidChangeVisibility(() => { if (view.visible) this.schedule(0); });
  }

  schedule(delay = 50) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.post(), delay);
  }

  async post() {
    if (!this.view || !this.view.visible) return;
    try {
      const state = await this.buildState();
      this.view.webview.postMessage({ type: 'state', state });
    } catch (e) {
      this.ctx.output.appendLine(`Overview error: ${e.stack || e}`);
    }
  }

  async buildState() {
    const m = this.manager.current;
    if (!m || !m.state) {
      return {
        kind: 'noRepo',
        hasFolder: !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length),
        gitMissing: this.ctx.gitMissing,
      };
    }
    const s = m.state;
    const [last] = s.initial ? [null] : await m.repo.log({ maxCount: 1 });
    const gh = githubRemote(s.remotes);
    return {
      kind: 'repo',
      root: m.root,
      name: m.name,
      repos: this.manager.all.map(r => ({ root: r.root, name: r.name })),
      branch: s.branch,
      detached: s.detached,
      head: short(s.oid),
      initial: s.initial,
      upstream: s.upstream,
      ahead: s.ahead,
      behind: s.behind,
      staged: s.staged.length,
      unstaged: s.unstaged.length,
      untracked: s.untracked.length,
      conflicts: s.conflicts.length,
      stashes: s.stashCount,
      operation: s.operation,
      hasRemote: s.remotes.length > 0,
      github: gh ? `${gh.owner}/${gh.repo}` : null,
      worktreeOf: m.repo.isLinkedWorktree ? require('path').basename(require('path').dirname(m.repo.commonDir)) : null,
      lastCommit: last ? { subject: last.subject, date: last.date, author: last.author } : null,
      suggestion: suggest(s),
      draft: this.drafts[m.root] || '',
      smartCommit: cfg('smartCommit', 'ask'),
    };
  }

  async onMessage(msg) {
    const m = this.manager.current;
    switch (msg.type) {
      case 'ready':
        this.schedule(0);
        break;
      case 'command': {
        const arg = typeof msg.arg === 'string' ? msg.arg : (m ? { root: m.root, ...(msg.arg || {}) } : msg.arg);
        await vscode.commands.executeCommand(msg.command, arg);
        break;
      }
      case 'selectRepo': {
        const target = this.manager.findModel(msg.root);
        if (target) this.manager.setCurrent(target);
        break;
      }
      case 'draft':
        if (m) {
          this.drafts[m.root] = msg.message;
          this.ctx.extensionContext.workspaceState.update('gitCompass.drafts', this.drafts);
        }
        break;
      case 'commit': {
        if (!m) return;
        const ok = await vscode.commands.executeCommand('gitCompass.commit', { root: m.root, message: msg.message, amend: msg.amend, push: msg.push });
        if (ok) {
          this.drafts[m.root] = '';
          this.ctx.extensionContext.workspaceState.update('gitCompass.drafts', this.drafts);
        }
        this.view.webview.postMessage({ type: 'commitResult', ok: !!ok });
        break;
      }
      case 'lastMessage': {
        if (!m || m.state.initial) return;
        const c = await m.repo.commit('HEAD');
        this.view.webview.postMessage({ type: 'lastMessage', message: c.body || c.subject });
        break;
      }
    }
  }
}

/** The single most useful next step, in plain words. */
function suggest(s) {
  const op = s.operation;
  if (op) {
    const what = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert', bisect: 'bisect' }[op.kind] || op.kind;
    if (s.conflicts.length) {
      return { level: 'warn', text: `A ${what} is paused because ${s.conflicts.length} file(s) have conflicts. Open each file in "Merge Conflicts", choose what to keep, save, mark it resolved (✓), then press Continue.`, action: { label: 'How to resolve', command: 'gitCompass.openGuide', arg: 'conflicts' } };
    }
    if (op.kind === 'rebase') {
      return { level: 'warn', text: `A rebase is paused${op.step ? ` (step ${op.step})` : ''}. Make your edits if you wanted to change this commit, stage them, then press Continue.`, action: { label: 'Continue', command: 'gitCompass.continueOperation' } };
    }
    return { level: 'warn', text: `All conflicts are resolved. Press Continue to finish the ${what}.`, action: { label: 'Continue', command: 'gitCompass.continueOperation' } };
  }
  if (s.detached) {
    return { level: 'warn', text: 'You are not on a branch (detached HEAD) — you are looking at an older snapshot. Switch back to a branch, or create a new branch here if you want to keep working from this point.', action: { label: 'Create branch here', command: 'gitCompass.createBranch' } };
  }
  const changes = s.unstaged.length + s.untracked.length + s.staged.length;
  if (s.initial) {
    if (changes) return { level: 'info', text: 'New repository! Write a short message below and press Commit to save the first snapshot of your files.' };
    return { level: 'info', text: 'New, empty repository. Create or copy some files into the folder, then commit them.' };
  }
  if (changes) {
    if (s.behind) return { level: 'info', text: `You have ${changes} uncommitted change(s), and ${s.behind} new commit(s) are waiting on the remote. Commit your work first, then Sync.` };
    return { level: 'info', text: `You have ${changes} uncommitted change(s). Review them in Changes, write a message and Commit when ready.` };
  }
  if (s.ahead && s.behind) return { level: 'info', text: `Your branch and the remote both have new commits (↑${s.ahead} ↓${s.behind}). Sync will combine them and upload yours.`, action: { label: 'Sync', command: 'gitCompass.sync' } };
  if (s.behind) return { level: 'info', text: `${s.behind} new commit(s) are on the remote. Pull to update your files.`, action: { label: 'Pull', command: 'gitCompass.pull' } };
  if (s.ahead) return { level: 'info', text: `You have ${s.ahead} commit(s) that are only on your computer. Push to upload (back up / share) them.`, action: { label: 'Push', command: 'gitCompass.push' } };
  if (!s.remotes.length) return { level: 'info', text: 'Everything is committed. This repository is only on your computer — publish it to GitHub to back it up.', action: { label: 'Publish to GitHub', command: 'gitCompass.publishToGitHub' } };
  if (!s.upstream) return { level: 'info', text: `Branch "${s.branch}" is not on the remote yet. Publish it to share it.`, action: { label: 'Publish branch', command: 'gitCompass.publishBranch' } };
  return { level: 'ok', text: 'All good — everything is committed and in sync with the remote.' };
}

module.exports = { OverviewProvider, suggest };
