'use strict';
// Every user-facing Git operation. Each command accepts whatever the UI passes
// (tree node, webview context object, uri, or nothing) and resolves the target itself.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { GitError, friendlyError } = require('./git');
const { getBuiltinGitApi } = require('./repoManager');
const { openRefDiff, openFileAt, gitUri } = require('./diff');
const { githubRemote, web } = require('./github');
const { short, cfg, relTime, basename } = require('./util');
const { openCommitFileDiff } = require('./views/nodes');
const { openPullRequestFileDiff } = require('./views/trees');

class UserError extends Error {}

class Commands {
  /**
   * @param {object} ctx {manager, github, output, views, graph, rebase, guide, blame, extensionUri}
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.manager = ctx.manager;
    this.github = ctx.github;
  }

  register(context) {
    const map = this.table();
    for (const [id, fn] of Object.entries(map)) {
      context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
        try {
          return await fn.apply(this, args);
        } catch (e) {
          this.showError(e);
        }
      }));
    }
    return Object.keys(map);
  }

  table() {
    return {
      // repository
      'gitCompass.refresh': this.refresh,
      'gitCompass.selectRepository': this.selectRepository,
      'gitCompass.init': this.init,
      'gitCompass.clone': this.clone,
      'gitCompass.publishToGitHub': this.publishToGitHub,
      'gitCompass.setIdentity': this.setIdentity,
      'gitCompass.openGuide': this.openGuide,
      'gitCompass.openWalkthrough': this.openWalkthrough,
      'gitCompass.openGraph': this.openGraph,
      'gitCompass.openSettings': () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:radomir-novy.git-compass'),
      'gitCompass.showOutput': () => this.ctx.output.show(),
      'gitCompass.openRepositoryOnGitHub': this.openRepositoryOnGitHub,
      'gitCompass.githubSignIn': this.githubSignIn,
      // sync
      'gitCompass.fetch': this.fetch,
      'gitCompass.pull': this.pull,
      'gitCompass.push': this.push,
      'gitCompass.forcePush': this.forcePush,
      'gitCompass.sync': this.sync,
      'gitCompass.publishBranch': this.publishBranch,
      // changes
      'gitCompass.openChange': this.openChange,
      'gitCompass.openFile': this.openFile,
      'gitCompass.stage': this.stage,
      'gitCompass.unstage': this.unstage,
      'gitCompass.discard': this.discard,
      'gitCompass.stageAll': this.stageAll,
      'gitCompass.unstageAll': this.unstageAll,
      'gitCompass.discardAll': this.discardAll,
      'gitCompass.acceptOurs': this.acceptOurs,
      'gitCompass.acceptTheirs': this.acceptTheirs,
      'gitCompass.markResolved': this.markResolved,
      'gitCompass.openMergeEditor': this.openMergeEditor,
      'gitCompass.addToGitignore': this.addToGitignore,
      'gitCompass.stageSelectedLines': () => vscode.commands.executeCommand('git.stageSelectedRanges'),
      'gitCompass.unstageSelectedLines': () => vscode.commands.executeCommand('git.unstageSelectedRanges'),
      'gitCompass.revertSelectedLines': () => vscode.commands.executeCommand('git.revertSelectedRanges'),
      // commit
      'gitCompass.commit': this.commitCommand,
      'gitCompass.commitAmend': (a) => this.commitCommand({ ...(a || {}), amend: true }),
      'gitCompass.undoLastCommit': this.undoLastCommit,
      'gitCompass.editLastCommitMessage': this.editLastCommitMessage,
      // operation in progress
      'gitCompass.continueOperation': this.continueOperation,
      'gitCompass.abortOperation': this.abortOperation,
      'gitCompass.skipOperation': this.skipOperation,
      // branches
      'gitCompass.createBranch': this.createBranch,
      'gitCompass.switchBranch': this.switchBranch,
      'gitCompass.checkout': this.checkout,
      'gitCompass.merge': this.merge,
      'gitCompass.rebaseOnto': this.rebaseOnto,
      'gitCompass.deleteBranch': this.deleteBranch,
      'gitCompass.renameBranch': this.renameBranch,
      'gitCompass.setUpstream': this.setUpstream,
      'gitCompass.pushBranch': this.pushBranch,
      'gitCompass.compareWithCurrent': this.compareWithCurrent,
      'gitCompass.openBranchOnGitHub': this.openBranchOnGitHub,
      'gitCompass.createPullRequest': this.createPullRequest,
      // worktrees
      'gitCompass.createWorktree': this.createWorktree,
      'gitCompass.openWorktreeNewWindow': (n) => this.openWorktree(n, 'new'),
      'gitCompass.openWorktreeHere': (n) => this.openWorktree(n, 'here'),
      'gitCompass.addWorktreeToWorkspace': (n) => this.openWorktree(n, 'workspace'),
      'gitCompass.revealWorktree': (n) => this.openWorktree(n, 'reveal'),
      'gitCompass.removeWorktree': this.removeWorktree,
      'gitCompass.lockWorktree': this.lockWorktree,
      'gitCompass.unlockWorktree': this.unlockWorktree,
      'gitCompass.pruneWorktrees': this.pruneWorktrees,
      // remotes
      'gitCompass.addRemote': this.addRemote,
      'gitCompass.removeRemote': this.removeRemote,
      'gitCompass.fetchRemote': this.fetchRemote,
      // commits
      'gitCompass.showCommit': this.showCommit,
      'gitCompass.copySha': this.copySha,
      'gitCompass.copyMessage': this.copyMessage,
      'gitCompass.checkoutCommit': this.checkoutCommit,
      'gitCompass.createBranchAt': this.createBranchAt,
      'gitCompass.createTagAt': this.createTagAt,
      'gitCompass.cherryPick': this.cherryPick,
      'gitCompass.revert': this.revert,
      'gitCompass.resetTo': this.resetTo,
      'gitCompass.compareWithHead': this.compareCommitWithHead,
      'gitCompass.compareCommitWithWorkingTree': this.compareCommitWithWorkingTree,
      'gitCompass.openCommitOnGitHub': this.openCommitOnGitHub,
      'gitCompass.interactiveRebase': this.interactiveRebase,
      'gitCompass.openCommitFileDiff': (a) => openCommitFileDiff(this.commitFileArg(a)),
      'gitCompass.openFileAtRevision': this.openFileAtRevision,
      'gitCompass.restoreFileFromCommit': this.restoreFileFromCommit,
      // stashes
      'gitCompass.stash': this.stash,
      'gitCompass.applyStash': this.applyStash,
      'gitCompass.popStash': this.popStash,
      'gitCompass.dropStash': this.dropStash,
      'gitCompass.branchFromStash': this.branchFromStash,
      'gitCompass.clearStashes': this.clearStashes,
      'gitCompass.openStashFileDiff': ({ root, stash, file }) => openRefDiff(root, file, stash.parents[0], stash.sha, { fallbackRef: stash.parents[2] }),
      // tags
      'gitCompass.createTag': this.createTag,
      'gitCompass.deleteTag': this.deleteTag,
      'gitCompass.pushTag': this.pushTag,
      'gitCompass.pushAllTags': this.pushAllTags,
      // file
      'gitCompass.fileHistory': this.fileHistory,
      'gitCompass.openFileHistoryDiff': this.openFileHistoryDiff,
      'gitCompass.compareFileWith': this.compareFileWith,
      'gitCompass.openFileOnGitHub': this.openFileOnGitHub,
      // compare
      'gitCompass.compareRefs': this.compareRefs,
      'gitCompass.compareWithWorkingTree': this.compareWithWorkingTree,
      'gitCompass.swapCompare': () => this.ctx.views.compare.swap(),
      'gitCompass.clearCompare': () => this.ctx.views.compare.clear(),
      'gitCompass.openCompareFileDiff': ({ root, left, right, file }) => openRefDiff(root, file, left, right),
      // reflog
      'gitCompass.restoreToPoint': this.restoreToPoint,
      // pull requests
      'gitCompass.checkoutPullRequest': this.checkoutPullRequest,
      'gitCompass.openPullRequest': (n) => vscode.env.openExternal(vscode.Uri.parse(n.pr.html_url)),
      'gitCompass.copyPullRequestLink': async (n) => { await vscode.env.clipboard.writeText(n.pr.html_url); this.flash('Link copied'); },
      'gitCompass.openPullRequestFileDiff': openPullRequestFileDiff,
      'gitCompass.refreshPullRequests': () => this.ctx.views.pullRequests.refresh(),
      // views
      'gitCompass.loadMore': (key) => this.ctx.views[key] && this.ctx.views[key].loadMore(),
      'gitCompass.toggleViewAsTree': this.toggleViewAsTree,
      'gitCompass.viewAsTree': this.toggleViewAsTree,
      'gitCompass.viewAsList': this.toggleViewAsTree,
      'gitCompass.pinFileHistory': () => { this.ctx.views.fileHistory.pinned = true; vscode.commands.executeCommand('setContext', 'gitCompass.fileHistoryPinned', true); },
      'gitCompass.unpinFileHistory': () => { this.ctx.views.fileHistory.pinned = false; vscode.commands.executeCommand('setContext', 'gitCompass.fileHistoryPinned', false); this.ctx.views.fileHistory.onEditorChanged(vscode.window.activeTextEditor); },
      // blame
      'gitCompass.toggleFileBlame': () => this.ctx.blame.toggleFileBlame(),
      'gitCompass.toggleLineBlame': async () => {
        const c = vscode.workspace.getConfiguration('gitCompass');
        await c.update('blame.currentLine', !c.get('blame.currentLine', true), vscode.ConfigurationTarget.Global);
      },
    };
  }

  // ===========================================================================================
  // helpers
  // ===========================================================================================

  showError(e) {
    if (e instanceof UserError) { vscode.window.showInformationMessage(e.message); return; }
    const msg = e instanceof GitError ? e.friendly : (e && e.stderr ? friendlyError(e.stderr) : (e && e.message) || String(e));
    this.ctx.output.appendLine(`ERROR: ${e && e.stack || e}`);
    if (e && e.stderr) this.ctx.output.appendLine(e.stderr);
    vscode.window.showErrorMessage(msg, 'Show Git Output').then(p => { if (p) this.ctx.output.show(); });
  }

  flash(text) { vscode.window.setStatusBarMessage(`$(check) ${text}`, 4000); }

  /** Resolve the repository a command should act on. */
  modelOf(arg) {
    let m = null;
    if (arg && arg.model) m = arg.model;
    else if (arg && arg.root) m = this.manager.findModel(arg.root);
    else if (arg instanceof vscode.Uri) m = this.manager.modelFor(arg);
    if (!m) m = this.manager.current;
    if (!m) throw new UserError('Open a folder that contains a Git repository first (or use "Initialize Repository").');
    return m;
  }

  async run(model, args, opts = {}) {
    const title = opts.title;
    const exec = () => model.repo.run(args, opts);
    try {
      if (title) {
        return await vscode.window.withProgress(
          { location: opts.notify ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title },
          exec);
      }
      return await exec();
    } finally {
      if (!opts.noRefresh) await model.refresh();
    }
  }

  async confirm(message, detail, action, opts = {}) {
    const items = Array.isArray(action) ? action : [action];
    const r = await vscode.window.showWarningMessage(message, { modal: true, detail }, ...items);
    return Array.isArray(action) ? r : r === action;
  }

  builtinRepo(model) {
    if (!cfg('useVSCodeGitForNetwork', true)) return null;
    try {
      const api = getBuiltinGitApi();
      return (api && api.getRepository(vscode.Uri.file(model.root))) || null;
    } catch { return null; }
  }

  /** Network operation: use VS Code's Git (handles sign-in) when possible, else the git CLI. */
  async network(model, title, builtinOp, cliArgs) {
    const r = this.builtinRepo(model);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, async () => {
        if (r && builtinOp) await builtinOp(r);
        else await model.repo.run(cliArgs);
      });
    } catch (e) {
      await model.refresh();
      const msg = e instanceof GitError ? e.friendly : friendlyError(e.stderr || e.message || String(e));
      this.ctx.output.appendLine(`ERROR (${title}): ${e.stderr || e.message}`);
      const pick = await vscode.window.showErrorMessage(msg, 'Run in Terminal', 'Show Git Output');
      if (pick === 'Run in Terminal') this.runInTerminal(model, cliArgs);
      else if (pick === 'Show Git Output') this.ctx.output.show();
      return false;
    }
    await model.refresh();
    return true;
  }

  runInTerminal(model, args) {
    const t = vscode.window.createTerminal({ name: 'Git Compass', cwd: model.root });
    t.show();
    t.sendText('git ' + args.map(a => /[\s"'$&|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' '));
  }

  /** After a merge/rebase/cherry-pick/pull failure: explain conflicts if that's what happened. */
  async handleConflicts(model, what) {
    await model.refresh();
    const n = model.state.conflictCount;
    if (!n && !model.state.operation) return false;
    if (!n) return false;
    vscode.commands.executeCommand('gitCompass.changes.focus');
    const pick = await vscode.window.showWarningMessage(
      `${what} paused: ${n} file${n > 1 ? 's have' : ' has'} conflicts. Open each file under "Merge Conflicts", choose what to keep, save, click ✓ (Mark Resolved), then press Continue in the Overview.`,
      'How do I resolve conflicts?', `Abort ${what}`);
    if (pick === 'How do I resolve conflicts?') this.openGuide('conflicts');
    else if (pick && pick.startsWith('Abort')) await this.abortOperation({ model });
    return true;
  }

  async withConflicts(model, what, fn) {
    try {
      return await fn();
    } catch (e) {
      if (await this.handleConflicts(model, what)) return undefined;
      throw e;
    }
  }

  /** Extract {ref, type} from a tree node, webview context object or string. */
  refArg(arg) {
    if (!arg) return null;
    if (typeof arg === 'string') return { ref: arg, type: 'unknown' };
    if (arg.kind === 'branch') return { ref: arg.ref, type: arg.remoteBranch ? 'remote' : 'branch', branch: arg.branch };
    if (arg.kind === 'tag') return { ref: arg.ref, type: 'tag' };
    if (arg.kind === 'commit' || arg.kind === 'reflog') return { ref: (arg.commit && arg.commit.sha) || arg.sha, type: 'commit' };
    if (arg.refType && arg.ref) return { ref: arg.ref, type: arg.refType };
    if (arg.sha) return { ref: arg.sha, type: 'commit' };
    return null;
  }

  shaArg(arg) {
    if (!arg) return null;
    if (typeof arg === 'string') return arg;
    if (arg.commit) return arg.commit.sha;
    if (arg.entry) return arg.entry.sha;
    if (arg.sha) return arg.sha;
    if (arg.tag) return arg.tag.sha;
    if (arg.branch && arg.branch.sha) return arg.branch.sha;
    return null;
  }

  commitFileArg(a) {
    if (a && a.commit && a.file) return { root: a.root || a.model.root, commit: a.commit, file: a.file };
    return a;
  }

  async commitOf(model, arg) {
    if (arg && arg.commit && arg.commit.parents) return arg.commit;
    const sha = this.shaArg(arg);
    if (!sha) throw new UserError('No commit selected.');
    return model.repo.commit(sha);
  }

  /** Selected tree nodes (multi-select aware) → list of nodes. */
  nodesOf(node, selected) {
    if (Array.isArray(selected) && selected.length) return selected;
    if (node) return [node];
    return [];
  }

  async pickRef(model, opts = {}) {
    const { title = 'Select a branch, tag or commit', local = true, remote = true, tags = true, commits = false, exclude = [] } = opts;
    const refs = await model.repo.refs(model.state.remotes.map(r => r.name));
    const items = [];
    if (opts.extra) items.push(...opts.extra);
    if (local && refs.local.length) {
      items.push({ label: 'Local branches', kind: vscode.QuickPickItemKind.Separator });
      for (const b of refs.local.sort((x, y) => (y.current - x.current) || (y.date - x.date))) {
        if (exclude.includes(b.name)) continue;
        items.push({ label: `$(git-branch) ${b.name}`, description: b.current ? 'current branch' : relTime(b.date), detail: b.subject, ref: b.name, type: 'branch' });
      }
    }
    if (remote && refs.remote.length) {
      items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator });
      for (const b of refs.remote) {
        if (exclude.includes(b.name)) continue;
        items.push({ label: `$(cloud) ${b.name}`, description: relTime(b.date), detail: b.subject, ref: b.name, type: 'remote' });
      }
    }
    if (tags && refs.tags.length) {
      items.push({ label: 'Tags', kind: vscode.QuickPickItemKind.Separator });
      for (const t of refs.tags) items.push({ label: `$(tag) ${t.name}`, description: relTime(t.date), ref: t.name, type: 'tag' });
    }
    if (commits) {
      const log = await model.repo.log({ maxCount: 50 });
      items.push({ label: 'Recent commits', kind: vscode.QuickPickItemKind.Separator });
      for (const c of log) items.push({ label: `$(git-commit) ${c.subject}`, description: `${short(c.sha)} · ${c.author}, ${relTime(c.date)}`, ref: c.sha, type: 'commit' });
    }
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: opts.placeHolder || 'Type to search', matchOnDescription: true, matchOnDetail: true });
    return pick || null;
  }

  async askBranchName(model, prompt, value = '') {
    const v = await vscode.window.showInputBox({
      title: prompt,
      prompt: 'Short, descriptive, no spaces. Examples: feature/login, fix-typo, experiment',
      value,
      placeHolder: 'feature/my-change',
      validateInput: async val => {
        if (!val.trim()) return 'Please enter a name.';
        if (/\s/.test(val)) return 'Spaces are not allowed — use "-" instead.';
        try { await model.repo.run(['check-ref-format', '--branch', val], { quiet: true }); } catch { return 'This is not a valid branch name (avoid ~ ^ : ? * [ \\ and "..").'; }
        return null;
      },
    });
    return v && v.trim();
  }

  async ensureIdentity(model) {
    const name = await model.repo.config('user.name');
    const email = await model.repo.config('user.email');
    if (name && email) return true;
    const pick = await vscode.window.showWarningMessage(
      'Before your first commit, Git needs to know your name and email (they are stored in every commit).',
      { modal: true }, 'Set Name & Email');
    if (pick !== 'Set Name & Email') return false;
    return this.setIdentity({ model });
  }

  currentBranchOrThrow(model) {
    const s = model.state;
    if (s.detached) throw new UserError('You are not on a branch (detached HEAD). Create a branch first.');
    if (!s.branch) throw new UserError('No current branch.');
    return s.branch;
  }

  // ===========================================================================================
  // repository
  // ===========================================================================================

  async refresh() {
    await this.manager.discover();
    await this.manager.refreshAll();
    Object.values(this.ctx.views).forEach(v => v.refresh && v.refresh());
  }

  async selectRepository() {
    const items = this.manager.all.map(m => ({ label: `$(repo) ${m.name}`, description: m.state && (m.state.branch || 'detached'), detail: m.root, model: m }));
    if (!items.length) throw new UserError('No Git repositories found in this workspace.');
    const pick = await vscode.window.showQuickPick(items, { title: 'Choose the repository to work with' });
    if (pick) this.manager.setCurrent(pick.model);
  }

  async init(opts) {
    const quiet = !!(opts && opts.quiet);
    const folders = vscode.workspace.workspaceFolders || [];
    let target;
    const items = folders.map(f => ({ label: `$(folder) ${f.name}`, description: f.uri.fsPath, uri: f.uri }));
    items.push({ label: '$(folder-opened) Choose another folder…', uri: null });
    const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: quiet ? 'Which folder should be published to GitHub?' : 'Which folder should become a Git repository?' });
    if (!pick) return;
    if (pick.uri) target = pick.uri;
    else {
      const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Initialize Repository' });
      if (!r) return;
      target = r[0];
    }
    const g = this.manager.git;
    try { await g.exec(target.fsPath, ['init', '-b', 'main']); } catch { await g.exec(target.fsPath, ['init']); }
    await this.manager.discover();
    const m = this.manager.findModel(target.fsPath) || await this.manager.open(target.fsPath);
    this.manager.setCurrent(m);
    if (!quiet) {
      vscode.window.showInformationMessage(`Repository created in ${target.fsPath}. Next: write a commit message in the Overview and make your first commit.`, 'Show Guide')
        .then(p => p && this.openGuide('first-steps'));
    }
    return m;
  }

  async clone() {
    let url;
    const items = [{ label: '$(link) Enter a repository URL…', id: 'url' }];
    const session = await this.github.session(false);
    if (session) {
      try {
        const repos = await this.github.get('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', { createIfNone: false });
        items.push({ label: 'Your GitHub repositories', kind: vscode.QuickPickItemKind.Separator });
        for (const r of repos) items.push({ label: `$(${r.private ? 'lock' : 'repo'}) ${r.full_name}`, description: r.description || '', url: r.clone_url });
      } catch { /* ignore */ }
    } else {
      items.push({ label: '$(github) Sign in to GitHub to pick from your repositories…', id: 'signin' });
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'Clone (download) a repository', matchOnDescription: true });
    if (!pick) return;
    if (pick.id === 'signin') { await this.githubSignIn(); return this.clone(); }
    if (pick.id === 'url') {
      url = await vscode.window.showInputBox({ title: 'Repository URL', placeHolder: 'https://github.com/user/repo.git  or  git@github.com:user/repo.git' });
    } else url = pick.url;
    if (!url) return;
    // Let VS Code's built-in clone handle folder choice, credentials and opening the result.
    await vscode.commands.executeCommand('git.clone', url);
  }

  async githubSignIn() {
    await this.github.session(true);
    this.flash('Signed in to GitHub');
    this.ctx.views.pullRequests.refresh();
  }

  async setIdentity(arg) {
    const m = (() => { try { return this.modelOf(arg); } catch { return null; } })();
    const g = this.manager.git;
    const cwd = m ? m.root : require('os').homedir();
    const curName = (await g.exec(cwd, ['config', '--get', 'user.name'], { okCodes: [1], quiet: true })).stdout.trim();
    const curEmail = (await g.exec(cwd, ['config', '--get', 'user.email'], { okCodes: [1], quiet: true })).stdout.trim();
    const name = await vscode.window.showInputBox({ title: 'Your name (shown on your commits)', value: curName, placeHolder: 'Jane Doe', validateInput: v => v.trim() ? null : 'Required' });
    if (!name) return false;
    const email = await vscode.window.showInputBox({ title: 'Your email (use the one from your GitHub account)', value: curEmail, placeHolder: 'jane@example.com', validateInput: v => /.+@.+/.test(v) ? null : 'Enter an email address' });
    if (!email) return false;
    const scope = await vscode.window.showQuickPick([
      { label: 'For all repositories on this computer', description: 'recommended', flag: '--global' },
      ...(m ? [{ label: `Only for ${m.name}`, flag: '--local' }] : []),
    ], { title: 'Where should this be saved?' });
    if (!scope) return false;
    await g.exec(cwd, ['config', scope.flag, 'user.name', name.trim()]);
    await g.exec(cwd, ['config', scope.flag, 'user.email', email.trim()]);
    this.flash('Name and email saved');
    return true;
  }

  openGuide(section) {
    this.ctx.guide.show(typeof section === 'string' ? section : undefined);
  }

  openWalkthrough() {
    vscode.commands.executeCommand('workbench.action.openWalkthrough', 'radomir-novy.git-compass#gitCompass.welcome', false);
  }

  openGraph(arg) {
    const m = this.modelOf(arg);
    this.ctx.graph.show(m);
  }

  async showCommit(arg) {
    const m = this.modelOf(arg);
    const sha = this.shaArg(arg);
    this.ctx.graph.show(m, sha);
  }

  async openRepositoryOnGitHub(arg) {
    const m = this.modelOf(arg);
    const gh = githubRemote(m.state.remotes);
    if (!gh) throw new UserError('This repository has no GitHub remote.');
    vscode.env.openExternal(vscode.Uri.parse(web.repo(gh)));
  }

  /**
   * Publish to a brand-new GitHub repository. Works from any starting point: a plain folder
   * (initializes Git), nothing committed yet (offers to commit), an existing non-GitHub `origin`.
   */
  async publishToGitHub(arg) {
    let m = null;
    try { m = this.modelOf(arg); } catch { /* no repository yet */ }
    if (!m) {
      m = await this.init({ quiet: true });
      if (!m) return;
    }
    if (githubRemote(m.state.remotes)) {
      const gh = githubRemote(m.state.remotes);
      const pick = await vscode.window.showInformationMessage(`Already connected to GitHub (${gh.owner}/${gh.repo}).`, 'Push', 'Open on GitHub');
      if (pick === 'Push') return this.push({ model: m });
      if (pick === 'Open on GitHub') return this.openRepositoryOnGitHub({ model: m });
      return;
    }
    // 1) make sure there is something committed to upload
    await m.refresh();
    const s = m.state;
    if (s.operation || s.conflictCount) throw new UserError(`Finish the ${s.operation ? s.operation.kind : 'merge'} in progress first.`);
    const pending = s.changeCount + s.stagedCount;
    if (s.initial && !pending) throw new UserError('The folder is empty — add some files first, then publish.');
    if (pending) {
      const detail = `${pending} file(s) will be committed and uploaded.\n\n` +
        'Make sure nothing secret (passwords, .env files, private keys) or huge (build output, node_modules) is included. ' +
        'Exclude such files with right-click → "Add to .gitignore" in the Changes view.';
      const choices = s.initial ? ['Commit All & Publish', 'Review Files First'] : ['Commit All & Publish', 'Publish Without Them', 'Review Files First'];
      const pick = await vscode.window.showWarningMessage(
        s.initial ? 'Nothing is committed yet — the files have to be committed before they can be uploaded.' : `You have ${pending} uncommitted change(s).`,
        { modal: true, detail }, ...choices);
      if (!pick) return;
      if (pick === 'Review Files First') { await vscode.commands.executeCommand('gitCompass.changes.focus'); return; }
      if (pick === 'Commit All & Publish') {
        const msg = await vscode.window.showInputBox({ title: 'Commit message', value: s.initial ? 'Initial commit' : '', validateInput: v => v.trim() ? null : 'Please write a short message' });
        if (!msg) return;
        if (!await this.ensureIdentity(m)) return;
        await m.repo.run(['add', '-A']);
        await this.run(m, ['commit', '-F', '-'], { input: msg.trim(), title: 'Committing…' });
      }
    }
    const branch = this.currentBranchOrThrow(m);

    // 2) create the repository on GitHub (re-ask the name if it is taken)
    let name = m.name.replace(/[^A-Za-z0-9._-]+/g, '-');
    name = await vscode.window.showInputBox({
      title: 'Name of the new GitHub repository', value: name,
      prompt: 'A new, empty repository is created under your GitHub account.',
      validateInput: v => /^[A-Za-z0-9._-]+$/.test(v) ? null : 'Use letters, numbers, ".", "-" or "_"',
    });
    if (!name) return;
    const vis = await vscode.window.showQuickPick([
      { label: '$(lock) Private', description: 'only you (and people you invite) can see it', private: true },
      { label: '$(globe) Public', description: 'anyone on the internet can see it', private: false },
    ], { title: 'Who can see the repository?' });
    if (!vis) return;
    await this.github.session(true);
    let created = null;
    while (!created) {
      try {
        created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating GitHub repository ${name}…` },
          () => this.github.createRepository(name, vis.private));
      } catch (e) {
        if (!/already exists/i.test(e.message)) throw e;
        await vscode.window.showWarningMessage(`You already have a repository called "${name}" on GitHub. Please choose another name.`);
        name = await vscode.window.showInputBox({ title: 'Name of the new GitHub repository', value: `${name}-2`, validateInput: v => /^[A-Za-z0-9._-]+$/.test(v) ? null : 'Use letters, numbers, ".", "-" or "_"' });
        if (!name) return;
      }
    }

    // 3) connect and upload. Keep an existing "origin" (e.g. a school GitLab) untouched.
    const remoteName = m.state.remotes.some(r => r.name === 'origin') ? 'github' : 'origin';
    await this.run(m, ['remote', 'add', remoteName, created.clone_url]);
    const ok = await this.network(m, `Uploading ${branch} to GitHub…`, r => r.push(remoteName, branch, true), ['push', '-u', remoteName, branch]);
    if (!ok) {
      vscode.window.showWarningMessage(`The repository ${created.full_name} was created, but uploading failed. Fix the problem above, then press Push (the connection "${remoteName}" is already set up).`);
      return;
    }

    // 4) optionally the other branches and tags too
    const refs = await m.repo.refs([]);
    const others = refs.local.filter(b => b.name !== branch);
    if (others.length || refs.tags.length) {
      const what = [others.length && `${others.length} other branch(es)`, refs.tags.length && `${refs.tags.length} tag(s)`].filter(Boolean).join(' and ');
      const p = await vscode.window.showInformationMessage(`Uploaded "${branch}". Also upload ${what}?`, 'Upload Them');
      if (p) {
        for (const b of others) {
          await this.network(m, `Uploading ${b.name}…`, r => r.push(remoteName, b.name, true), ['push', '-u', remoteName, b.name]);
        }
        if (refs.tags.length) await this.network(m, 'Uploading tags…', null, ['push', remoteName, '--tags']);
      }
    }
    if (remoteName !== 'origin') {
      vscode.window.showInformationMessage(`Note: your existing remote "origin" was kept; GitHub was added as "${remoteName}".`);
    }
    const pick = await vscode.window.showInformationMessage(`Published to GitHub as ${created.full_name} (${vis.private ? 'private' : 'public'}).`, 'Open on GitHub');
    if (pick) vscode.env.openExternal(vscode.Uri.parse(created.html_url));
    return created.full_name;
  }

  // ===========================================================================================
  // sync
  // ===========================================================================================

  async fetch(arg) {
    const m = this.modelOf(arg);
    if (!m.state.remotes.length) throw new UserError('This repository has no remote to fetch from.');
    const ok = await this.network(m, 'Fetching (checking the remote for new commits)…', r => r.fetch({ all: true, prune: true }), ['fetch', '--all', '--prune']);
    if (ok) {
      const s = m.state;
      this.flash(s.behind ? `Fetched — ${s.behind} new commit(s) to pull` : 'Fetched — you are up to date');
    }
  }

  async fetchRemote(node) {
    const m = this.modelOf(node);
    const remote = node.remote.name;
    await this.network(m, `Fetching ${remote}…`, r => r.fetch({ remote, prune: true }), ['fetch', '--prune', remote]);
  }

  async pull(arg) {
    const m = this.modelOf(arg);
    const s = m.state;
    this.currentBranchOrThrow(m);
    if (!s.upstream) {
      if (!s.remotes.length) throw new UserError('This repository has no remote, so there is nothing to pull.');
      throw new UserError(`Branch "${s.branch}" is not connected to a remote branch yet. Publish it first (Push).`);
    }
    if (s.conflictCount) throw new UserError('Resolve the current conflicts first.');
    const remote = s.upstream.split('/')[0];
    if (!await this.network(m, `Pulling from ${s.upstream}…`, r => r.fetch({ remote }), ['fetch', remote])) return false;
    if (!m.state.behind) { this.flash('Already up to date'); return true; }
    const strategy = cfg('pullStrategy', 'merge');
    const args = strategy === 'rebase' ? ['rebase', '--autostash', '@{u}']
      : strategy === 'ff-only' ? ['merge', '--ff-only', '--autostash', '@{u}']
        : ['merge', '--no-edit', '--autostash', '@{u}'];
    const res = await this.withConflicts(m, 'Pull', () => this.run(m, args, { title: 'Applying pulled commits…' }));
    if (res) this.flash(`Pulled ${s.behind} commit(s)`);
    return !!res;
  }

  async push(arg) {
    const m = this.modelOf(arg);
    const s = m.state;
    const branch = this.currentBranchOrThrow(m);
    if (!s.upstream) return this.publishBranch({ model: m });
    if (s.behind > 0) {
      const pick = await this.confirm(`The remote has ${s.behind} commit(s) you don't have yet.`,
        'Pushing now would be rejected. Sync first: it pulls their commits (combining them with yours) and then pushes.', 'Sync (Pull, then Push)');
      if (pick) return this.sync({ model: m });
      return;
    }
    if (!s.ahead) { this.flash('Nothing to push'); return; }
    const remote = s.upstream.split('/')[0];
    const ok = await this.network(m, `Pushing ${s.ahead} commit(s) to ${s.upstream}…`, r => r.push(), ['push', remote, branch]);
    if (ok) this.flash('Pushed');
  }

  async forcePush(arg) {
    const m = this.modelOf(arg);
    const branch = this.currentBranchOrThrow(m);
    const ok = await this.confirm(`Force push "${branch}"?`,
      'Force push REPLACES the branch on the remote with your version. Commits on the remote that you don\'t have will be removed. ' +
      'Only do this after you rewrote your own history (amend, rebase) and nobody else works on this branch.\n\n' +
      'Git Compass uses the safe variant (--force-with-lease): it refuses if someone pushed in the meantime.', 'Force Push');
    if (!ok) return;
    const remote = (m.state.upstream || 'origin/').split('/')[0] || 'origin';
    await this.network(m, 'Force pushing…', r => r.push(remote, branch, !m.state.upstream, 1 /* ForceWithLease */), ['push', '--force-with-lease', remote, branch]);
  }

  async sync(arg) {
    const m = this.modelOf(arg);
    if (!m.state.upstream) return this.publishBranch({ model: m });
    if (m.state.behind || !m.state.ahead) {
      const pulled = await this.pull({ model: m });
      if (!pulled) return;
    }
    if (m.state.ahead) await this.push({ model: m });
  }

  async publishBranch(arg) {
    const m = this.modelOf(arg);
    const branch = this.currentBranchOrThrow(m);
    const remotes = m.state.remotes;
    if (!remotes.length) {
      const pick = await vscode.window.showInformationMessage('This repository has no remote yet. Where should it be published?', 'Publish to GitHub', 'Add Remote URL…');
      if (pick === 'Publish to GitHub') return this.publishToGitHub({ model: m });
      if (pick === 'Add Remote URL…') { if (await this.addRemote({ model: m })) return this.publishBranch({ model: m }); }
      return;
    }
    let remote = remotes[0].name;
    if (remotes.length > 1) {
      const p = await vscode.window.showQuickPick(remotes.map(r => ({ label: r.name, description: r.fetchUrl })), { title: `Publish "${branch}" to which remote?` });
      if (!p) return;
      remote = p.label;
    }
    const ok = await this.network(m, `Publishing ${branch} to ${remote}…`, r => r.push(remote, branch, true), ['push', '-u', remote, branch]);
    if (ok) this.flash(`Published ${branch}`);
  }

  // ===========================================================================================
  // working tree changes
  // ===========================================================================================

  pathsOf(nodes) {
    const paths = [];
    for (const n of nodes) {
      if (n.kind === 'group') paths.push(...n.files.map(f => f.path));
      else if (n.kind === 'folder') paths.push(n.folderPath);
      else if (n.file) {
        paths.push(n.file.path);
        if (n.file.origPath && n.group === 'staged') paths.push(n.file.origPath);
      } else if (n instanceof vscode.Uri) {
        const m = this.manager.modelFor(n);
        if (m) paths.push(m.repo.toRel(n.fsPath));
      }
    }
    return [...new Set(paths)];
  }

  targetsOf(node, selected) {
    let nodes = this.nodesOf(node, selected);
    if (!nodes.length) {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document.uri.scheme === 'file') nodes = [ed.document.uri];
    }
    if (!nodes.length) throw new UserError('Select a file first.');
    return nodes;
  }

  async openChange(arg) {
    const { root, file, group } = arg;
    if (group === 'conflicts') return this.openFile(arg);
    const m = this.manager.findModel(root);
    if (group === 'staged') {
      return openRefDiff(root, file, m && m.state.initial ? null : 'HEAD', ':', { title: `${basename(file.path)} (HEAD ↔ Staged)` });
    }
    if (file.status === '?') return this.openFile(arg);
    return openRefDiff(root, file, ':', null, { title: `${basename(file.path)} (Staged/HEAD ↔ Working Tree)` });
  }

  async openFile(arg) {
    const root = arg.root || (arg.model && arg.model.root);
    const p = path.join(root, ...arg.file.path.split('/'));
    if (!fs.existsSync(p)) {
      if (arg.commit) return openFileAt(root, arg.file.path, arg.commit.sha);
      throw new UserError('The file was deleted, so it cannot be opened.');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false });
  }

  async stage(node, selected) {
    const nodes = this.targetsOf(node, selected);
    const m = this.modelOf(nodes[0]);
    const conflicted = new Set(m.state.conflicts.map(c => c.path));
    const paths = this.pathsOf(nodes);
    for (const p of paths) {
      if (conflicted.has(p) && await hasConflictMarkers(m, p)) {
        const ok = await this.confirm(`"${p}" still contains conflict markers (<<<<<<< ======= >>>>>>>).`, 'Staging it now would commit those markers. Resolve the conflict first, or continue anyway.', 'Stage Anyway');
        if (!ok) return;
      }
    }
    await this.run(m, ['add', '-A', '--', ...paths]);
  }

  async unstage(node, selected) {
    const nodes = this.targetsOf(node, selected);
    const m = this.modelOf(nodes[0]);
    const paths = this.pathsOf(nodes);
    if (m.state.initial) await this.run(m, ['rm', '--cached', '-r', '-q', '--', ...paths]);
    else await this.run(m, ['restore', '--staged', '--', ...paths]);
  }

  async discard(node, selected) {
    const nodes = this.targetsOf(node, selected);
    const m = this.modelOf(nodes[0]);
    const files = [];
    for (const n of nodes) {
      if (n.kind === 'group') files.push(...n.files);
      else if (n.kind === 'folder') files.push(...[...m.state.unstaged, ...m.state.untracked].filter(f => f.path.startsWith(n.folderPath + '/')));
      else if (n.file) files.push(n.file);
      else if (n instanceof vscode.Uri) {
        const rel = m.repo.toRel(n.fsPath);
        const f = [...m.state.unstaged, ...m.state.untracked].find(x => x.path === rel);
        if (f) files.push(f);
      }
    }
    if (!files.length) throw new UserError('There are no unstaged changes to discard here.');
    const untracked = files.filter(f => f.status === '?');
    const tracked = files.filter(f => f.status !== '?');
    const what = files.length === 1 ? `"${files[0].path}"` : `${files.length} files`;
    const detail = [
      tracked.length ? `${tracked.length} file(s) will go back to their last committed/staged version — your edits are thrown away.` : '',
      untracked.length ? `${untracked.length} new file(s) will be moved to the trash.` : '',
      'Staged changes are not affected.',
    ].filter(Boolean).join('\n');
    if (!await this.confirm(`Discard changes in ${what}?`, detail + '\n\nThis cannot be undone with Git.', 'Discard Changes')) return;
    if (tracked.length) await this.run(m, ['restore', '--worktree', '--', ...tracked.map(f => f.path)], { noRefresh: true });
    for (const f of untracked) {
      await vscode.workspace.fs.delete(vscode.Uri.file(m.repo.toAbs(f.path)), { recursive: true, useTrash: true });
    }
    await m.refresh();
  }

  async stageAll(arg) {
    const m = this.modelOf(arg);
    if (m.state.conflictCount && !await this.confirm('Some files still have conflicts.', 'Stage everything anyway? Make sure all conflict markers are gone.', 'Stage All')) return;
    await this.run(m, ['add', '-A']);
  }

  async unstageAll(arg) {
    const m = this.modelOf(arg);
    if (m.state.initial) await this.run(m, ['rm', '--cached', '-r', '-q', '.']);
    else await this.run(m, ['reset', '-q']);
  }

  async discardAll(arg) {
    const m = this.modelOf(arg);
    const s = m.state;
    const total = s.unstaged.length + s.untracked.length;
    if (!total) throw new UserError('No unstaged changes to discard.');
    if (!await this.confirm(`Discard ALL ${total} unstaged changes?`,
      `Modified files go back to their last version; ${s.untracked.length} new file(s) are moved to the trash. Staged changes are kept.\n\nTip: if you might need these changes later, use Stash instead.`,
      'Discard All')) return;
    if (s.unstaged.length) await this.run(m, ['restore', '--worktree', '--', ...s.unstaged.map(f => f.path)], { noRefresh: true });
    for (const f of s.untracked) {
      await vscode.workspace.fs.delete(vscode.Uri.file(m.repo.toAbs(f.path)), { recursive: true, useTrash: true });
    }
    await m.refresh();
  }

  async acceptOurs(node, selected) { return this.acceptSide(node, selected, 'ours'); }
  async acceptTheirs(node, selected) { return this.acceptSide(node, selected, 'theirs'); }

  async acceptSide(node, selected, side) {
    const nodes = this.targetsOf(node, selected);
    const m = this.modelOf(nodes[0]);
    const op = m.state.operation && m.state.operation.kind;
    // during a rebase "ours" is the branch being rebased onto — explain in terms of current/incoming
    const label = side === 'ours' ? 'Current (your branch)' : 'Incoming';
    for (const p of this.pathsOf(nodes)) {
      try {
        await m.repo.run(['checkout', `--${side}`, '--', p]);
        await m.repo.run(['add', '--', p]);
      } catch {
        // file deleted on that side → resolve by deleting
        await m.repo.run(['rm', '-q', '--', p]);
      }
    }
    await m.refresh();
    this.flash(`Kept ${label} version${op === 'rebase' ? ' (rebase)' : ''}`);
  }

  async markResolved(node, selected) {
    return this.stage(node, selected);
  }

  async openMergeEditor(node) {
    const m = this.modelOf(node);
    const uri = vscode.Uri.file(m.repo.toAbs(node.file.path));
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch {
      await vscode.window.showTextDocument(uri);
    }
  }

  async addToGitignore(node, selected) {
    const nodes = this.targetsOf(node, selected);
    const m = this.modelOf(nodes[0]);
    const paths = this.pathsOf(nodes);
    const first = paths[0];
    const ext = path.posix.extname(first);
    const items = [{ label: paths.length > 1 ? `These ${paths.length} files` : `/${first}`, patterns: paths.map(p => '/' + p) }];
    if (ext && paths.length === 1) items.push({ label: `All *${ext} files`, patterns: [`*${ext}`] });
    const dir = path.posix.dirname(first);
    if (dir !== '.' && paths.length === 1) items.push({ label: `The whole folder /${dir}/`, patterns: [`/${dir}/`] });
    const pick = await vscode.window.showQuickPick(items, { title: 'What should Git ignore from now on?' });
    if (!pick) return;
    const gi = path.join(m.root, '.gitignore');
    let content = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (content && !content.endsWith('\n')) content += '\n';
    content += pick.patterns.join('\n') + '\n';
    fs.writeFileSync(gi, content);
    // already tracked files must be removed from the index to be ignored
    const tracked = (await m.repo.out(['ls-files', '--', ...paths], { quiet: true })).split('\n').filter(Boolean);
    if (tracked.length) {
      const ok = await this.confirm('Some of these files are already tracked by Git.', 'Ignoring only affects untracked files. Stop tracking them (the files stay on your disk)?', 'Stop Tracking');
      if (ok) await m.repo.run(['rm', '--cached', '-r', '-q', '--', ...tracked]);
    }
    await m.refresh();
    this.flash('Added to .gitignore');
  }

  // ===========================================================================================
  // commit
  // ===========================================================================================

  /** Commit from the Overview box or the command palette. Returns true when a commit was made. */
  async commitCommand(arg = {}) {
    const m = this.modelOf(arg.root ? arg : undefined);
    await m.refresh();
    const s = m.state;
    let message = arg.message;
    const amend = !!arg.amend;
    if (s.conflictCount) throw new UserError('Resolve the conflicts first (see "Merge Conflicts" in the Changes view).');
    if (!amend && !s.stagedCount && !s.changeCount && !s.operation) throw new UserError('There is nothing to commit — no files have changed.');
    if (message === undefined || message === null) {
      message = await vscode.window.showInputBox({ title: amend ? 'Amend last commit — new message (leave empty to keep the old one)' : 'Commit message', placeHolder: 'Describe what you changed, e.g. "Add login form"' });
      if (message === undefined) return false;
    }
    message = message.trim();
    if (!message && !amend && !s.operation) throw new UserError('Please write a commit message describing your change.');
    if (!await this.ensureIdentity(m)) return false;

    if (!amend && !s.stagedCount && s.changeCount && !s.operation) {
      const mode = cfg('smartCommit', 'ask');
      if (mode === 'never') throw new UserError('No changes are staged. Stage files with + first.');
      if (mode === 'ask') {
        const pick = await vscode.window.showInformationMessage(
          `No files are staged. Commit all ${s.changeCount} changed file(s)?`,
          { modal: true, detail: 'Staging means choosing which changes go into the commit. You can also stage files individually with the + button.' },
          'Commit All', 'Always Commit All');
        if (!pick) return false;
        if (pick === 'Always Commit All') await vscode.workspace.getConfiguration('gitCompass').update('smartCommit', 'always', vscode.ConfigurationTarget.Global);
      }
      await m.repo.run(['add', '-A']);
    }

    if (amend) {
      if (s.initial) throw new UserError('There is no commit to amend yet.');
      const head = await m.repo.revParse('HEAD');
      if (await m.repo.isPushed(head)) {
        const ok = await this.confirm('The last commit was already pushed.',
          'Amending changes it, so your history will differ from the remote and you will need to Force Push. Avoid this if others use the branch.', 'Amend Anyway');
        if (!ok) return false;
      }
    }

    const args = ['commit'];
    if (amend) args.push('--amend');
    if (message) args.push('-F', '-');
    else args.push('--no-edit');
    await this.run(m, args, { input: message || undefined, title: 'Committing…' });
    this.flash(amend ? 'Commit amended' : 'Committed');
    if (arg.push) await this.sync({ model: m });
    return true;
  }

  async undoLastCommit(arg) {
    const m = this.modelOf(arg);
    if (m.state.initial) throw new UserError('There are no commits to undo.');
    const head = await m.repo.commit('HEAD');
    const pushed = await m.repo.isPushed(head.sha);
    const ok = await this.confirm(`Undo the last commit "${head.subject}"?`,
      'The commit is removed, but nothing is lost: all its changes go back to "Staged Changes" so you can fix them and commit again.' +
      (pushed ? '\n\n⚠ This commit was already pushed. After undoing it you would need to Force Push — avoid this on shared branches (use Revert instead).' : ''),
      'Undo Commit');
    if (!ok) return;
    if (head.parents.length) await this.run(m, ['reset', '--soft', 'HEAD~1']);
    else await this.run(m, ['update-ref', '-d', 'HEAD']);
    this.flash('Last commit undone — changes are staged');
  }

  async editLastCommitMessage(arg) {
    const m = this.modelOf(arg);
    const head = await m.repo.commit('HEAD');
    const msg = await vscode.window.showInputBox({ title: 'Edit the last commit message', value: head.body || head.subject, valueSelection: [0, (head.subject || '').length] });
    if (!msg || msg.trim() === head.body.trim()) return;
    if (await m.repo.isPushed(head.sha) && !await this.confirm('This commit was already pushed.', 'Changing the message rewrites it — you will need to Force Push afterwards.', 'Change Anyway')) return;
    await this.run(m, ['commit', '--amend', '--only', '-F', '-'], { input: msg.trim() });
    this.flash('Commit message changed');
  }

  // ===========================================================================================
  // merge / rebase / cherry-pick in progress
  // ===========================================================================================

  async continueOperation(arg) {
    const m = this.modelOf(arg);
    const op = m.state.operation;
    if (!op) throw new UserError('Nothing to continue.');
    if (m.state.conflictCount) {
      vscode.commands.executeCommand('gitCompass.changes.focus');
      throw new UserError(`${m.state.conflictCount} file(s) still have conflicts. Resolve them and click ✓ (Mark Resolved) first.`);
    }
    if (m.state.unstaged.length && op.kind !== 'rebase') {
      await m.repo.run(['add', '-u']);
    }
    const kind = op.kind === 'bisect' ? null : op.kind;
    if (!kind) throw new UserError('Bisect is in progress; use the terminal to continue it.');
    await this.withConflicts(m, cap(kind), () => this.run(m, [kind, '--continue'], { title: `Continuing ${kind}…` }));
    await m.refresh();
    if (!m.state.operation) this.flash(`${cap(kind)} finished`);
  }

  async abortOperation(arg) {
    const m = this.modelOf(arg);
    const op = m.state.operation;
    if (!op) throw new UserError('Nothing to abort.');
    const ok = await this.confirm(`Abort the ${op.kind}?`, `Everything goes back to how it was before the ${op.kind} started.`, `Abort ${cap(op.kind)}`);
    if (!ok) return;
    await this.run(m, [op.kind === 'bisect' ? 'bisect' : op.kind, op.kind === 'bisect' ? 'reset' : '--abort']);
    this.flash(`${cap(op.kind)} aborted`);
  }

  async skipOperation(arg) {
    const m = this.modelOf(arg);
    const op = m.state.operation;
    if (!op || !['rebase', 'cherry-pick', 'revert'].includes(op.kind)) throw new UserError('Skip is only possible during a rebase, cherry-pick or revert.');
    const ok = await this.confirm('Skip this commit?', 'The commit that caused the conflict will be left out entirely.', 'Skip Commit');
    if (!ok) return;
    await this.withConflicts(m, cap(op.kind), () => this.run(m, [op.kind, '--skip']));
  }

  // ===========================================================================================
  // branches
  // ===========================================================================================

  async createBranch(arg) {
    const m = this.modelOf(arg);
    let start = this.refArg(arg);
    if (!start && arg && arg.pickStart) {
      start = await this.pickRef(m, { title: 'Create the new branch starting from…', commits: true });
      if (!start) return;
    }
    const name = await this.askBranchName(m, start ? `New branch from ${start.type === 'commit' ? short(start.ref) : start.ref}` : `New branch from ${m.state.branch || 'HEAD'}`);
    if (!name) return;
    const sw = cfg('switchToNewBranch', true);
    const args = sw ? ['switch', '-c', name] : ['branch', name];
    if (start) args.push(start.ref);
    if (sw && start && start.type === 'remote') args.push('--track');
    await this.withStashOnConflict(m, `switch to ${name}`, () => this.run(m, args));
    this.flash(sw ? `Created and switched to ${name}` : `Created ${name}`);
  }

  async createBranchAt(arg) { return this.createBranch(arg); }

  /** Run fn; if it fails because local changes would be overwritten, offer to stash them. */
  async withStashOnConflict(m, what, fn) {
    try {
      return await fn();
    } catch (e) {
      if (!/would be overwritten|commit your changes or stash them/i.test(e.stderr || '')) throw e;
      const pick = await vscode.window.showWarningMessage(
        `Can't ${what}: you have uncommitted changes that would be overwritten.`,
        { modal: true, detail: 'Stash them = put them aside in a drawer. You can bring them back later from the Stashes view (Pop).' },
        'Stash Changes & Continue', 'Bring Changes Along (Stash, Switch, Pop)');
      if (!pick) return undefined;
      await m.repo.run(['stash', 'push', '-u', '-m', `Git Compass: before ${what}`]);
      const res = await fn();
      if (pick.startsWith('Bring')) {
        try { await m.repo.run(['stash', 'pop']); } catch {
          await this.handleConflicts(m, 'Stash pop');
        }
      } else this.flash('Your changes are in the Stashes view');
      await m.refresh();
      return res;
    }
  }

  async switchBranch(arg) {
    const m = this.modelOf(arg);
    const extra = [
      { label: '$(add) Create new branch…', action: 'create' },
      { label: '$(add) Create new branch from…', action: 'createFrom' },
    ];
    const pick = await this.pickRef(m, { title: 'Switch to branch', extra, commits: false });
    if (!pick) return;
    if (pick.action === 'create') return this.createBranch({ model: m });
    if (pick.action === 'createFrom') return this.createBranch({ model: m, pickStart: true });
    return this.checkout({ model: m, ref: pick.ref, refType: pick.type });
  }

  async checkout(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    if (!r) return this.switchBranch(arg);
    if (r.type === 'branch' || (r.type === 'unknown' && await m.repo.revParse(`refs/heads/${r.ref}`))) {
      if (r.ref === m.state.branch) { this.flash(`Already on ${r.ref}`); return; }
      if (await this.offerWorktreeForBranch(m, r.ref)) return;
      await this.withStashOnConflict(m, `switch to ${r.ref}`, () => this.run(m, ['switch', r.ref]));
      this.flash(`Switched to ${r.ref}`);
      return;
    }
    if (r.type === 'remote') {
      const remoteNames = m.state.remotes.map(x => x.name).sort((a, b) => b.length - a.length);
      const remote = remoteNames.find(n => r.ref.startsWith(n + '/')) || r.ref.split('/')[0];
      const localName = r.ref.slice(remote.length + 1);
      const exists = await m.repo.revParse(`refs/heads/${localName}`);
      if (exists && await this.offerWorktreeForBranch(m, localName)) return;
      if (exists) {
        await this.withStashOnConflict(m, `switch to ${localName}`, () => this.run(m, ['switch', localName]));
        this.flash(`Switched to existing local branch ${localName}`);
      } else {
        await this.withStashOnConflict(m, `switch to ${localName}`, () => this.run(m, ['switch', '-c', localName, '--track', r.ref]));
        this.flash(`Created local branch ${localName} tracking ${r.ref}`);
      }
      return;
    }
    return this.checkoutCommit(arg);
  }

  async checkoutCommit(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    if (!r) throw new UserError('No commit selected.');
    const label = r.type === 'commit' ? short(r.ref) : r.ref;
    const pick = await this.confirm(`Check out ${label}?`,
      'You will see the project exactly as it was at this point ("detached HEAD" = not on any branch). ' +
      'That\'s fine for looking around or testing. If you want to make commits here, create a branch instead.\n\n' +
      'To come back, just switch to your branch again.', ['Create Branch Here', 'Just Look Around']);
    if (!pick) return;
    if (pick === 'Create Branch Here') return this.createBranch({ model: m, ref: r.ref, refType: r.type });
    await this.withStashOnConflict(m, `check out ${label}`, () => this.run(m, ['switch', '--detach', r.ref]));
  }

  async merge(arg) {
    const m = this.modelOf(arg);
    const cur = this.currentBranchOrThrow(m);
    let r = this.refArg(arg);
    if (!r) {
      r = await this.pickRef(m, { title: `Merge which branch into "${cur}"?`, exclude: [cur] });
      if (!r) return;
    }
    if (r.ref === cur) throw new UserError('You cannot merge a branch into itself.');
    const mode = await vscode.window.showQuickPick([
      { label: '$(git-merge) Merge', description: 'recommended', detail: `Bring all commits from ${r.ref} into ${cur}. If ${cur} has no own new commits, it simply moves forward (fast-forward).`, args: ['merge', '--no-edit'] },
      { label: '$(git-merge) Merge, always create a merge commit', description: '--no-ff', detail: 'Keeps a visible "merge bubble" in the history even when a fast-forward is possible.', args: ['merge', '--no-edit', '--no-ff'] },
      { label: '$(fold) Squash merge', description: '--squash', detail: `Combine all changes from ${r.ref} into staged changes; you then make ONE commit yourself.`, args: ['merge', '--squash'] },
    ], { title: `Merge ${r.ref} into ${cur}` });
    if (!mode) return;
    const res = await this.withConflicts(m, 'Merge', () => this.withStashOnConflict(m, 'merge', () => this.run(m, [...mode.args, r.ref], { title: `Merging ${r.ref}…` })));
    if (res) {
      if (mode.args.includes('--squash')) vscode.window.showInformationMessage(`The changes from ${r.ref} are now staged. Write a commit message and commit.`);
      else this.flash(`Merged ${r.ref} into ${cur}`);
    }
  }

  async rebaseOnto(arg) {
    const m = this.modelOf(arg);
    const cur = this.currentBranchOrThrow(m);
    let r = this.refArg(arg);
    if (!r) {
      r = await this.pickRef(m, { title: `Rebase "${cur}" onto…`, exclude: [cur] });
      if (!r) return;
    }
    const ok = await this.confirm(`Rebase ${cur} onto ${r.ref}?`,
      `Your commits on ${cur} are replayed on top of ${r.ref}, giving a straight, linear history.\n\n` +
      'This rewrites your commits (new IDs). Don\'t rebase commits others already pulled; if this branch was pushed you\'ll need Force Push afterwards.', 'Rebase');
    if (!ok) return;
    const res = await this.withConflicts(m, 'Rebase', () => this.run(m, ['rebase', '--autostash', r.ref], { title: `Rebasing onto ${r.ref}…` }));
    if (res) this.flash(`Rebased ${cur} onto ${r.ref}`);
  }

  async deleteBranch(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg) || await this.pickRef(m, { title: 'Delete which branch?', remote: true, tags: false, exclude: [m.state.branch] });
    if (!r) return;
    if (r.type === 'remote') {
      const remote = m.state.remotes.map(x => x.name).find(n => r.ref.startsWith(n + '/'));
      const name = r.ref.slice(remote.length + 1);
      if (!await this.confirm(`Delete "${name}" on ${remote} (the server)?`, 'The branch is removed from the remote for everyone. Local branches are not affected.', 'Delete Remote Branch')) return;
      await this.network(m, `Deleting ${r.ref}…`, null, ['push', remote, '--delete', name]);
      return;
    }
    const name = r.ref;
    if (name === m.state.branch) throw new UserError('You cannot delete the branch you are on. Switch to another branch first.');
    const b = arg && arg.branch;
    if (!await this.confirm(`Delete branch "${name}"?`, 'Only the branch label is removed. If its commits are merged somewhere they stay there.', 'Delete')) return;
    try {
      await this.run(m, ['branch', '-d', name]);
    } catch (e) {
      if (!/not fully merged/.test(e.stderr || '')) throw e;
      const force = await this.confirm(`"${name}" has commits that are not merged anywhere.`,
        'If you delete it, those commits will only be recoverable through Undo History (reflog) for a while.', 'Delete Anyway');
      if (!force) return;
      await this.run(m, ['branch', '-D', name]);
    }
    this.flash(`Deleted ${name}`);
    if (b && b.upstream && !b.gone) {
      const pick = await vscode.window.showInformationMessage(`Also delete "${b.upstream}" on the remote?`, 'Delete Remote Branch');
      if (pick) await this.deleteBranch({ model: m, ref: b.upstream, refType: 'remote' });
    }
  }

  async renameBranch(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    const old = r ? r.ref : this.currentBranchOrThrow(m);
    const name = await this.askBranchName(m, `Rename branch "${old}" to…`, old);
    if (!name || name === old) return;
    await this.run(m, ['branch', '-m', old, name]);
    this.flash(`Renamed to ${name}`);
  }

  async setUpstream(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    const branch = r ? r.ref : this.currentBranchOrThrow(m);
    const pick = await this.pickRef(m, { title: `Connect "${branch}" to which remote branch?`, local: false, tags: false });
    if (!pick) return;
    await this.run(m, ['branch', `--set-upstream-to=${pick.ref}`, branch]);
    this.flash(`${branch} now tracks ${pick.ref}`);
  }

  async pushBranch(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    if (!r || r.ref === m.state.branch) return this.push({ model: m });
    const b = arg.branch;
    const remote = (b && b.upstreamRemote) || (m.state.remotes[0] && m.state.remotes[0].name);
    if (!remote) throw new UserError('No remote configured.');
    await this.network(m, `Pushing ${r.ref}…`, rr => rr.push(remote, r.ref, !(b && b.upstream)), ['push', ...(b && b.upstream ? [] : ['-u']), remote, r.ref]);
  }

  async compareWithCurrent(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    this.ctx.views.compare.set(m, m.state.branch || 'HEAD', r.ref);
    vscode.commands.executeCommand('gitCompass.compare.focus');
  }

  async openBranchOnGitHub(arg) {
    const m = this.modelOf(arg);
    const gh = githubRemote(m.state.remotes);
    if (!gh) throw new UserError('No GitHub remote.');
    const r = this.refArg(arg);
    let branch = r ? r.ref : m.state.branch;
    if (r && r.type === 'remote') branch = branch.slice(branch.indexOf('/') + 1);
    vscode.env.openExternal(vscode.Uri.parse(web.branch(gh, branch)));
  }

  async createPullRequest(arg) {
    const m = this.modelOf(arg);
    const gh = githubRemote(m.state.remotes);
    if (!gh) throw new UserError('This repository is not on GitHub.');
    const r = this.refArg(arg);
    const branch = r && r.type === 'branch' ? r.ref : this.currentBranchOrThrow(m);
    let s = m.state;
    if (branch === s.branch && (!s.upstream || s.ahead)) {
      const pick = await vscode.window.showInformationMessage(`"${branch}" has commits that are not on GitHub yet. Push them first?`, { modal: true }, 'Push & Continue');
      if (!pick) return;
      if (!s.upstream) await this.publishBranch({ model: m }); else await this.push({ model: m });
      s = m.state;
      if (!s.upstream || s.ahead) return;
    }
    await this.github.session(true);
    const info = await this.github.repoInfo(gh.owner, gh.repo);
    const base = await vscode.window.showQuickPick(
      [info.default_branch, ...(await m.repo.refs([gh.remote])).remote.filter(b => b.remote === gh.remote && b.branch !== info.default_branch && b.branch !== branch).map(b => b.branch)],
      { title: `Pull request: merge "${branch}" into…`, placeHolder: info.default_branch });
    if (!base) return;
    const last = await m.repo.commit(branch);
    const title = await vscode.window.showInputBox({ title: 'Pull request title', value: last.subject });
    if (!title) return;
    const body = await vscode.window.showInputBox({ title: 'Description (optional)', placeHolder: 'What does this change and why?' });
    if (body === undefined) return;
    const how = await vscode.window.showQuickPick([
      { label: '$(git-pull-request) Create pull request', draft: false },
      { label: '$(git-pull-request-draft) Create as draft', description: 'not ready for review yet', draft: true },
    ], { title: 'Create' });
    if (!how) return;
    const pr = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creating pull request…' },
      () => this.github.createPullRequest(gh.owner, gh.repo, { title, body, head: branch, base, draft: how.draft }));
    this.ctx.views.pullRequests.refresh();
    const pick = await vscode.window.showInformationMessage(`Pull request #${pr.number} created.`, 'Open on GitHub');
    if (pick) vscode.env.openExternal(vscode.Uri.parse(pr.html_url));
  }

  async checkoutPullRequest(node) {
    const m = this.modelOf(node);
    const pr = node.pr;
    const gh = node.gh;
    const local = `pr/${pr.number}-${pr.head.ref}`.replace(/[^A-Za-z0-9._/-]/g, '-');
    const sameRepo = pr.head.repo && pr.head.repo.full_name.toLowerCase() === `${gh.owner}/${gh.repo}`.toLowerCase();
    if (sameRepo) {
      const ok = await this.network(m, `Fetching ${pr.head.ref}…`, r => r.fetch({ remote: gh.remote, ref: pr.head.ref }), ['fetch', gh.remote, pr.head.ref]);
      if (!ok) return;
      return this.checkout({ model: m, ref: `${gh.remote}/${pr.head.ref}`, refType: 'remote' });
    }
    const ok = await this.network(m, `Fetching PR #${pr.number}…`, null, ['fetch', gh.remote, `pull/${pr.number}/head:${local}`]);
    if (!ok) return;
    await this.checkout({ model: m, ref: local, refType: 'branch' });
  }

  // ===========================================================================================
  // worktrees
  // ===========================================================================================

  /** If `branch` is checked out in another worktree, explain and offer to open it. Returns true if handled. */
  async offerWorktreeForBranch(m, branch) {
    const wt = (await m.repo.worktrees()).find(w => w.branch === branch && !samePath(w.path, m.root));
    if (!wt) return false;
    const pick = await vscode.window.showWarningMessage(
      `"${branch}" is already checked out in the worktree ${wt.path}.`,
      { modal: true, detail: 'A branch can be active in only one worktree (folder) at a time. Open that folder to work on it — or create a new branch from it here.' },
      'Open Worktree in New Window', 'Create New Branch from It');
    if (pick === 'Open Worktree in New Window') await this.openWorktree({ model: m, worktree: wt }, 'new');
    else if (pick === 'Create New Branch from It') await this.createBranch({ model: m, ref: branch, refType: 'branch' });
    return true;
  }

  async createWorktree(arg) {
    const m = this.modelOf(arg);
    const worktrees = await m.repo.worktrees();
    const used = worktrees.map(w => w.branch).filter(Boolean);
    let r = this.refArg(arg);
    if (!r) {
      r = await this.pickRef(m, {
        title: 'New worktree: which branch should be checked out in the new folder?',
        placeHolder: 'Branches already open in a worktree are not listed',
        exclude: used,
        extra: [{ label: '$(add) New branch…', description: `starting from ${m.state.branch || 'HEAD'}`, type: 'new' }],
      });
      if (!r) return;
    }
    // work out what to check out
    let addArgs; // args after `git worktree add` minus the path, as a function of path
    let label;
    if (r.type === 'new') {
      const name = await this.askBranchName(m, 'Name of the new branch for the worktree');
      if (!name) return;
      addArgs = p => ['-b', name, p, 'HEAD'];
      label = name;
    } else if (r.type === 'branch') {
      if (used.includes(r.ref)) {
        const wt = worktrees.find(w => w.branch === r.ref);
        if (samePath(wt.path, m.root)) throw new UserError(`"${r.ref}" is the branch of this folder. Pick another branch (or create a new one) for the worktree.`);
        return this.offerWorktreeForBranch(m, r.ref);
      }
      addArgs = p => [p, r.ref];
      label = r.ref;
    } else if (r.type === 'remote') {
      const remote = m.state.remotes.map(x => x.name).sort((a, b) => b.length - a.length).find(n => r.ref.startsWith(n + '/')) || r.ref.split('/')[0];
      const local = r.ref.slice(remote.length + 1);
      if (used.includes(local)) return this.offerWorktreeForBranch(m, local);
      addArgs = (await m.repo.revParse(`refs/heads/${local}`)) ? p => [p, local] : p => ['--track', '-b', local, p, r.ref];
      label = local;
    } else {
      // tag / commit → detached worktree
      addArgs = p => ['--detach', p, r.ref];
      label = r.type === 'commit' ? short(r.ref) : r.ref;
    }
    const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    const suggested = path.join(path.dirname(m.root), `${path.basename(m.root)}-${safe}`);
    const target = await vscode.window.showInputBox({
      title: `Folder for the new worktree (${label})`,
      prompt: 'A new folder next to your repository is a good choice. It must not exist yet (or be empty).',
      value: suggested,
      valueSelection: [suggested.length - safe.length, suggested.length],
      validateInput: v => {
        if (!v.trim()) return 'Enter a folder path';
        if (!path.isAbsolute(v.trim())) return 'Use an absolute path';
        try { if (fs.existsSync(v.trim()) && fs.readdirSync(v.trim()).length) return 'This folder already exists and is not empty'; } catch { /* ignore */ }
        return null;
      },
    });
    if (!target) return;
    const p = path.normalize(target.trim());
    await this.run(m, ['worktree', 'add', ...addArgs(p)], { title: 'Creating worktree…' });
    this.ctx.views.worktrees.refresh();
    this.ctx.views.branches.refresh();
    const pick = await vscode.window.showInformationMessage(`Worktree created: ${label} is checked out in ${p}`, 'Open in New Window', 'Add to Workspace');
    const wt = (await m.repo.worktrees()).find(w => samePath(w.path, p)) || { path: p };
    if (pick === 'Open in New Window') await this.openWorktree({ model: m, worktree: wt }, 'new');
    else if (pick === 'Add to Workspace') await this.openWorktree({ model: m, worktree: wt }, 'workspace');
    return p;
  }

  async worktreeArg(node, title, filter = () => true) {
    if (node && node.worktree) return node.worktree;
    const m = this.modelOf(node);
    const list = (await m.repo.worktrees()).filter(w => !w.bare && filter(w, m));
    if (!list.length) throw new UserError('There are no matching worktrees.');
    const pick = await vscode.window.showQuickPick(list.map(w => ({
      label: `$(folder) ${path.basename(w.path)}`, description: w.branch || `detached ${short(w.sha)}`, detail: w.path, w,
    })), { title });
    return pick && pick.w;
  }

  async openWorktree(node, how) {
    const w = await this.worktreeArg(node, 'Open which worktree?', (x, m) => !samePath(x.path, m.root));
    if (!w) return;
    const uri = vscode.Uri.file(w.path);
    if (w.prunable || !fs.existsSync(w.path)) throw new UserError('That worktree folder no longer exists. Use "Prune Worktrees" to clean it up.');
    if (how === 'new') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    else if (how === 'here') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
    else if (how === 'reveal') await vscode.commands.executeCommand('revealFileInOS', uri);
    else if (how === 'workspace') {
      const folders = vscode.workspace.workspaceFolders || [];
      if (folders.some(f => samePath(f.uri.fsPath, w.path))) { this.flash('Already in the workspace'); return; }
      vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: `${path.basename(w.path)} (worktree)` });
    }
  }

  async removeWorktree(node) {
    const m = this.modelOf(node);
    const w = await this.worktreeArg(node, 'Remove which worktree?', (x, mm) => !x.main && !samePath(x.path, mm.root));
    if (!w) return;
    if (w.main) throw new UserError('The main worktree (the original repository folder) cannot be removed.');
    if (samePath(w.path, m.root)) throw new UserError('You are working in this worktree right now. Open another folder first.');
    const ok = await this.confirm(`Remove the worktree "${path.basename(w.path)}"?`,
      `The folder ${w.path} is deleted. Commits and the branch ${w.branch ? `"${w.branch}" ` : ''}are kept — only this extra checkout goes away.` +
      (w.locked ? '\n\nIt is locked — removing it overrides the lock.' : ''),
      'Remove Worktree');
    if (!ok) return;
    const args = ['worktree', 'remove'];
    if (w.locked) args.push('--force', '--force');
    try {
      await this.run(m, [...args, w.path]);
    } catch (e) {
      if (!/modified or untracked|is dirty|use --force|locked/i.test(e.stderr || '')) throw e;
      const force = await this.confirm('This worktree has uncommitted changes.', 'Removing it anyway throws those changes away.', 'Remove Anyway (Discard Changes)');
      if (!force) return;
      await this.run(m, ['worktree', 'remove', '--force', ...(w.locked ? ['--force'] : []), w.path]);
    }
    const folders = vscode.workspace.workspaceFolders || [];
    const idx = folders.findIndex(f => samePath(f.uri.fsPath, w.path));
    if (idx >= 0) vscode.workspace.updateWorkspaceFolders(idx, 1);
    this.ctx.views.worktrees.refresh();
    this.ctx.views.branches.refresh();
    this.flash('Worktree removed');
  }

  async lockWorktree(node) {
    const m = this.modelOf(node);
    const w = await this.worktreeArg(node, 'Lock which worktree?', x => !x.main && !x.locked);
    if (!w) return;
    const reason = await vscode.window.showInputBox({ title: 'Why lock it? (optional)', placeHolder: 'e.g. on a USB drive, long-running experiment' });
    if (reason === undefined) return;
    await this.run(m, ['worktree', 'lock', ...(reason ? ['--reason', reason] : []), w.path]);
    this.ctx.views.worktrees.refresh();
  }

  async unlockWorktree(node) {
    const m = this.modelOf(node);
    const w = await this.worktreeArg(node, 'Unlock which worktree?', x => x.locked);
    if (!w) return;
    await this.run(m, ['worktree', 'unlock', w.path]);
    this.ctx.views.worktrees.refresh();
  }

  async pruneWorktrees(arg) {
    const m = this.modelOf(arg);
    const stale = (await m.repo.worktrees()).filter(w => w.prunable);
    if (!stale.length) { this.flash('Nothing to prune — all worktree folders exist'); return; }
    if (!await this.confirm(`Clean up ${stale.length} missing worktree(s)?`, `These folders were deleted outside Git:\n${stale.map(w => w.path).join('\n')}\n\nGit forgets about them (their branches are kept).`, 'Prune')) return;
    await this.run(m, ['worktree', 'prune']);
    this.ctx.views.worktrees.refresh();
    this.ctx.views.branches.refresh();
  }

  // ===========================================================================================
  // remotes
  // ===========================================================================================

  async addRemote(arg) {
    const m = this.modelOf(arg);
    const url = await vscode.window.showInputBox({ title: 'Remote URL', placeHolder: 'https://github.com/user/repo.git' });
    if (!url) return false;
    const name = await vscode.window.showInputBox({ title: 'Remote name', value: m.state.remotes.length ? 'upstream' : 'origin', prompt: '"origin" is the usual name for your main remote' });
    if (!name) return false;
    await this.run(m, ['remote', 'add', name, url.trim()]);
    this.flash(`Remote ${name} added`);
    if (await vscode.window.showInformationMessage(`Fetch branches from ${name} now?`, 'Fetch')) await this.fetchRemote({ model: m, remote: { name } });
    return true;
  }

  async removeRemote(node) {
    const m = this.modelOf(node);
    const name = node && node.remote ? node.remote.name : (await vscode.window.showQuickPick(m.state.remotes.map(r => r.name), { title: 'Remove which remote?' }));
    if (!name) return;
    if (!await this.confirm(`Remove remote "${name}"?`, 'Only the connection is removed from this repository; nothing is deleted on the server.', 'Remove')) return;
    await this.run(m, ['remote', 'remove', name]);
  }

  // ===========================================================================================
  // commits
  // ===========================================================================================

  async copySha(arg) {
    const sha = this.shaArg(arg);
    await vscode.env.clipboard.writeText(sha);
    this.flash(`Copied ${short(sha)}`);
  }

  async copyMessage(arg) {
    const m = this.modelOf(arg);
    const c = await m.repo.commit(this.shaArg(arg));
    await vscode.env.clipboard.writeText(c.body || c.subject);
    this.flash('Commit message copied');
  }

  async createTagAt(arg) { return this.createTag(arg); }

  async cherryPick(arg) {
    const m = this.modelOf(arg);
    const c = await this.commitOf(m, arg);
    const cur = this.currentBranchOrThrow(m);
    if (!await this.confirm(`Cherry-pick "${c.subject}" onto ${cur}?`,
      `A copy of this commit's changes is applied on top of ${cur} as a new commit. The original commit stays where it is.`, 'Cherry-pick')) return;
    const args = ['cherry-pick'];
    if (c.parents.length > 1) args.push('-m', '1');
    args.push(c.sha);
    const res = await this.withConflicts(m, 'Cherry-pick', () => this.run(m, args));
    if (res) this.flash('Cherry-picked');
  }

  async revert(arg) {
    const m = this.modelOf(arg);
    const c = await this.commitOf(m, arg);
    if (!await this.confirm(`Revert "${c.subject}"?`,
      'Creates a NEW commit that does the exact opposite of this one. History is kept, so this is the safe way to undo something that was already pushed.', 'Revert')) return;
    const args = ['revert', '--no-edit'];
    if (c.parents.length > 1) args.push('-m', '1');
    args.push(c.sha);
    const res = await this.withConflicts(m, 'Revert', () => this.run(m, args));
    if (res) this.flash('Reverted (new commit created)');
  }

  async resetTo(arg) {
    const m = this.modelOf(arg);
    const c = await this.commitOf(m, arg);
    const cur = m.state.branch || 'HEAD';
    const mode = await vscode.window.showQuickPick([
      { label: '$(check) Keep changes as edits', description: 'mixed — recommended', detail: `Move ${cur} back to this commit. Changes from the later commits appear as unstaged edits in your files.`, mode: '--mixed' },
      { label: '$(pass-filled) Keep changes staged', description: 'soft', detail: 'Same, but the changes stay staged — handy to combine several commits into one.', mode: '--soft' },
      { label: '$(warning) Discard everything after it', description: 'hard — dangerous', detail: 'Your files become exactly like this commit. Later commits AND uncommitted changes are thrown away.', mode: '--hard' },
    ], { title: `Reset ${cur} to ${short(c.sha)} "${c.subject}"` });
    if (!mode) return;
    const headPushed = await m.repo.isPushed(m.state.oid || 'HEAD');
    if (mode.mode === '--hard') {
      const ok = await this.confirm(`Hard reset ${cur} to ${short(c.sha)}?`,
        'Uncommitted changes will be lost for good. Removed commits can still be recovered for a while from Undo History.', 'Hard Reset');
      if (!ok) return;
    } else if (headPushed) {
      const ok = await this.confirm('Some of the commits you are removing were already pushed.', 'Your branch will differ from the remote and you will need to Force Push. On shared branches prefer Revert.', 'Reset Anyway');
      if (!ok) return;
    }
    await this.run(m, ['reset', mode.mode, c.sha]);
    this.flash(`Reset to ${short(c.sha)}`);
  }

  async compareCommitWithHead(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    this.ctx.views.compare.set(m, r.type === 'commit' ? short(r.ref) : r.ref, 'HEAD');
    vscode.commands.executeCommand('gitCompass.compare.focus');
  }

  async compareCommitWithWorkingTree(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    this.ctx.views.compare.set(m, r.type === 'commit' ? short(r.ref) : r.ref, null);
    vscode.commands.executeCommand('gitCompass.compare.focus');
  }

  async openCommitOnGitHub(arg) {
    const m = this.modelOf(arg);
    const gh = githubRemote(m.state.remotes);
    if (!gh) throw new UserError('No GitHub remote.');
    vscode.env.openExternal(vscode.Uri.parse(web.commit(gh, this.shaArg(arg))));
  }

  async interactiveRebase(arg) {
    const m = this.modelOf(arg);
    this.currentBranchOrThrow(m);
    let sha = this.shaArg(arg);
    if (!sha) {
      const pick = await this.pickRef(m, { title: 'Edit history: pick the OLDEST commit you want to change', local: false, remote: false, tags: false, commits: true });
      if (!pick) return;
      sha = pick.ref;
    }
    if (m.state.operation) throw new UserError(`A ${m.state.operation.kind} is already in progress.`);
    await this.ctx.rebase.show(m, sha);
  }

  async openFileAtRevision(arg) {
    const m = this.modelOf(arg);
    if (arg && arg.commit && arg.file) return openFileAt(m.root, arg.file.path, arg.commit.sha);
    throw new UserError('Select a file inside a commit.');
  }

  async restoreFileFromCommit(arg) {
    const m = this.modelOf(arg);
    const { commit, file } = arg;
    if (file.status === 'D') {
      if (!await this.confirm(`Restore deleted file "${file.path}"?`, `The version from before commit ${short(commit.sha)} is brought back.`, 'Restore')) return;
      await this.run(m, ['checkout', `${commit.sha}^`, '--', file.path]);
    } else {
      if (!await this.confirm(`Replace "${file.path}" with its version from ${short(commit.sha)}?`, 'Your current version of this file will be overwritten (it shows up as a change you can review/commit).', 'Restore')) return;
      await this.run(m, ['checkout', commit.sha, '--', file.path]);
    }
    this.flash('File restored');
  }

  // ===========================================================================================
  // stashes
  // ===========================================================================================

  async stash(arg) {
    const m = this.modelOf(arg);
    const s = m.state;
    if (!s.changeCount && !s.stagedCount) throw new UserError('No changes to stash.');
    const kind = await vscode.window.showQuickPick([
      { label: '$(archive) Stash all changes', description: 'recommended', detail: 'Including new (untracked) files. Your working folder becomes clean.', args: ['-u'] },
      { label: '$(pass-filled) Stash only staged changes', detail: 'Keep unstaged edits in your files.', args: ['--staged'] },
      { label: '$(edit) Stash changes but keep them staged too', detail: 'Stash everything, but leave the staged changes in place (--keep-index).', args: ['-u', '--keep-index'] },
    ], { title: 'Stash = put your changes aside to get a clean working folder' });
    if (!kind) return;
    const msg = await vscode.window.showInputBox({ title: 'Stash name (optional)', placeHolder: 'e.g. half-done login form' });
    if (msg === undefined) return;
    await this.run(m, ['stash', 'push', ...kind.args, ...(msg ? ['-m', msg] : [])]);
    this.flash('Changes stashed');
  }

  async applyStash(node) {
    const m = this.modelOf(node);
    const st = await this.stashArg(m, node, 'Apply which stash?');
    if (!st) return;
    const res = await this.withConflicts(m, 'Stash apply', () => this.run(m, ['stash', 'apply', st.ref]));
    if (res) this.flash('Stash applied (and kept)');
  }

  async popStash(node) {
    const m = this.modelOf(node);
    const st = await this.stashArg(m, node, 'Pop which stash?');
    if (!st) return;
    const res = await this.withConflicts(m, 'Stash pop', () => this.run(m, ['stash', 'pop', st.ref]));
    if (res) this.flash('Stash applied and removed');
  }

  async dropStash(node) {
    const m = this.modelOf(node);
    const st = await this.stashArg(m, node, 'Delete which stash?');
    if (!st) return;
    if (!await this.confirm(`Delete stash "${st.message}"?`, 'The changes stored in it will be gone.', 'Delete Stash')) return;
    await this.run(m, ['stash', 'drop', st.ref]);
  }

  async branchFromStash(node) {
    const m = this.modelOf(node);
    const st = await this.stashArg(m, node, 'Create a branch from which stash?');
    if (!st) return;
    const name = await this.askBranchName(m, 'New branch for the stashed changes');
    if (!name) return;
    await this.run(m, ['stash', 'branch', name, st.ref]);
  }

  async clearStashes(arg) {
    const m = this.modelOf(arg);
    if (!await this.confirm('Delete ALL stashes?', 'Every stashed change will be gone.', 'Delete All')) return;
    await this.run(m, ['stash', 'clear']);
  }

  async stashArg(m, node, title) {
    if (node && node.stash) return node.stash;
    const list = await m.repo.stashes();
    if (!list.length) throw new UserError('There are no stashes.');
    const pick = await vscode.window.showQuickPick(list.map(s => ({ label: s.message, description: relTime(s.date), st: s })), { title });
    return pick && pick.st;
  }

  // ===========================================================================================
  // tags
  // ===========================================================================================

  async createTag(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    const target = r ? r.ref : 'HEAD';
    const name = await vscode.window.showInputBox({ title: `New tag at ${r && r.type === 'commit' ? short(target) : target}`, placeHolder: 'v1.0.0', validateInput: v => /^[^\s~^:?*[\\]+$/.test(v) ? null : 'Invalid tag name' });
    if (!name) return;
    const msg = await vscode.window.showInputBox({ title: 'Tag message (optional — makes an "annotated" tag)', placeHolder: 'Release 1.0' });
    if (msg === undefined) return;
    await this.run(m, msg ? ['tag', '-a', name, '-m', msg, target] : ['tag', name, target]);
    const pick = await vscode.window.showInformationMessage(`Tag ${name} created. Tags are not pushed automatically.`, 'Push Tag');
    if (pick) await this.pushTag({ model: m, ref: name, refType: 'tag' });
  }

  async deleteTag(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    if (!r) throw new UserError('Select a tag.');
    if (!await this.confirm(`Delete tag "${r.ref}"?`, 'The tag is removed locally. The commit is not affected.', 'Delete')) return;
    await this.run(m, ['tag', '-d', r.ref]);
    if (m.state.remotes.length) {
      const pick = await vscode.window.showInformationMessage(`Also delete tag ${r.ref} on the remote?`, 'Delete on Remote');
      if (pick) await this.network(m, 'Deleting remote tag…', null, ['push', m.state.remotes[0].name, '--delete', `refs/tags/${r.ref}`]);
    }
  }

  async pushTag(arg) {
    const m = this.modelOf(arg);
    const r = this.refArg(arg);
    const remote = m.state.remotes[0] && m.state.remotes[0].name;
    if (!remote) throw new UserError('No remote configured.');
    await this.network(m, `Pushing tag ${r.ref}…`, null, ['push', remote, `refs/tags/${r.ref}`]);
  }

  async pushAllTags(arg) {
    const m = this.modelOf(arg);
    const remote = m.state.remotes[0] && m.state.remotes[0].name;
    if (!remote) throw new UserError('No remote configured.');
    await this.network(m, 'Pushing all tags…', null, ['push', remote, '--tags']);
  }

  // ===========================================================================================
  // files
  // ===========================================================================================

  editorTarget(uri) {
    if (uri && !(uri instanceof vscode.Uri)) {
      if (uri.root && uri.rel) {
        const m = this.manager.findModel(uri.root);
        if (m) return { model: m, rel: uri.rel };
      }
      if (uri.file && (uri.root || uri.model)) return { model: this.modelOf(uri), rel: uri.file.path };
      uri = undefined;
    }
    if (!(uri instanceof vscode.Uri)) {
      const ed = vscode.window.activeTextEditor;
      uri = ed && ed.document.uri;
    }
    if (!uri) throw new UserError('Open a file first.');
    if (uri.scheme === 'gitcompass') {
      const q = JSON.parse(uri.query);
      return { model: this.manager.findModel(q.root), rel: q.rel };
    }
    const m = this.manager.modelFor(uri);
    if (!m) throw new UserError('This file is not inside a Git repository.');
    return { model: m, rel: m.repo.toRel(uri.fsPath) };
  }

  async fileHistory(uri) {
    const { model, rel } = this.editorTarget(uri);
    this.ctx.views.fileHistory.setTarget(model, rel);
    await vscode.commands.executeCommand('gitCompass.fileHistory.focus');
  }

  async openFileHistoryDiff({ root, commit }) {
    const file = { path: commit.filePath, origPath: commit.fileOrigPath, status: commit.fileStatus };
    await openRefDiff(root, file, commit.parents[0] || null, commit.sha);
  }

  async compareFileWith(uri) {
    const { model, rel } = this.editorTarget(uri);
    const pick = await this.pickRef(model, { title: `Compare ${basename(rel)} with…`, commits: true });
    if (!pick) return;
    await openRefDiff(model.root, { path: rel, status: 'M' }, pick.ref, null);
  }

  async openFileOnGitHub(uri) {
    const { model, rel } = this.editorTarget(uri);
    const gh = githubRemote(model.state.remotes);
    if (!gh) throw new UserError('No GitHub remote.');
    const ed = vscode.window.activeTextEditor;
    let from, to;
    if (ed && (!(uri instanceof vscode.Uri) || ed.document.uri.toString() === uri.toString())) {
      from = ed.selection.start.line + 1;
      to = ed.selection.end.line + 1;
    }
    const s = model.state;
    const ref = s.upstream && !s.ahead ? s.upstream.slice(s.upstream.indexOf('/') + 1) : (await model.repo.isPushed(s.oid) ? s.oid : null);
    if (!ref) {
      vscode.window.showWarningMessage('Your latest commits are not pushed, so line numbers on GitHub may differ. Opening the default branch.');
    }
    vscode.env.openExternal(vscode.Uri.parse(web.file(gh, ref || 'HEAD', rel, from, to)));
  }

  // ===========================================================================================
  // compare
  // ===========================================================================================

  async compareRefs(arg) {
    const m = this.modelOf(arg);
    const a = await this.pickRef(m, { title: 'Compare: pick the FIRST (left/older) side', commits: true });
    if (!a) return;
    const b = await this.pickRef(m, { title: `Compare ${a.type === 'commit' ? short(a.ref) : a.ref} with…`, commits: true, extra: [{ label: '$(file-diff) Working Tree (your current files)', ref: null, type: 'worktree' }] });
    if (!b) return;
    this.ctx.views.compare.set(m, a.type === 'commit' ? short(a.ref) : a.ref, b.ref === null ? null : (b.type === 'commit' ? short(b.ref) : b.ref));
    vscode.commands.executeCommand('gitCompass.compare.focus');
  }

  async compareWithWorkingTree(arg) {
    const m = this.modelOf(arg);
    const a = await this.pickRef(m, { title: 'Compare your current files with…', commits: true });
    if (!a) return;
    this.ctx.views.compare.set(m, a.type === 'commit' ? short(a.ref) : a.ref, null);
    vscode.commands.executeCommand('gitCompass.compare.focus');
  }

  // ===========================================================================================
  // reflog
  // ===========================================================================================

  async restoreToPoint(node) {
    const m = this.modelOf(node);
    const sha = this.shaArg(node);
    const cur = m.state.branch || 'HEAD';
    const dirty = m.state.changeCount + m.state.stagedCount > 0;
    const pick = await this.confirm(`Restore ${cur} to this point (${short(sha)})?`,
      `${cur} will point to this state again. Your current state is not lost — it stays in Undo History, so you can return to it.` +
      (dirty ? '\n\nYou have uncommitted changes. "Keep" tries to keep them; "Discard" throws them away.' : ''),
      dirty ? ['Restore & Keep My Changes', 'Restore & Discard Changes'] : ['Restore']);
    if (!pick) return;
    if (pick.includes('Discard')) await this.run(m, ['reset', '--hard', sha]);
    else {
      try { await this.run(m, ['reset', '--keep', sha]); } catch (e) {
        throw new GitError('Your uncommitted changes conflict with that point. Stash or discard them first.', e);
      }
    }
    this.flash(`Restored to ${short(sha)}`);
  }

  // ===========================================================================================
  // views
  // ===========================================================================================

  async toggleViewAsTree() {
    const c = vscode.workspace.getConfiguration('gitCompass');
    await c.update('viewAsTree', !c.get('viewAsTree', false), vscode.ConfigurationTarget.Global);
  }
}

async function hasConflictMarkers(model, rel) {
  try {
    const text = fs.readFileSync(model.repo.toAbs(rel), 'utf8');
    return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
  } catch { return false; }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function samePath(a, b) {
  const n = p => path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

module.exports = { Commands, UserError };
