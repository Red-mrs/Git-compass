'use strict';
const vscode = require('vscode');
const { Git } = require('./git');
const { RepoManager, getBuiltinGitApi, resetBuiltinGitApi } = require('./repoManager');
const { GitContentProvider, SCHEME } = require('./diff');
const { GitHub, githubRemote } = require('./github');
const { StatusDecorationProvider } = require('./views/nodes');
const trees = require('./views/trees');
const { OverviewProvider } = require('./webviews/overview');
const { GraphPanel, GraphView } = require('./webviews/graph');
const { RebasePanel } = require('./webviews/rebase');
const { GuidePanel } = require('./webviews/guide');
const { BlameController } = require('./blame');
const { Commands } = require('./commands');
const { cfg } = require('./util');

let manager;

async function activate(context) {
  const output = vscode.window.createOutputChannel('Git Compass');
  context.subscriptions.push(output);
  const log = line => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);

  // Make sure VS Code's own Git extension is up: we reuse it for sign-in during push/pull/fetch.
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (ext && !ext.isActive) await ext.activate();
    resetBuiltinGitApi();
  } catch { /* the built-in Git extension may be disabled — we fall back to the git CLI */ }

  let gitPath = cfg('gitPath', '') || '';
  if (!gitPath) {
    try { gitPath = getBuiltinGitApi()?.git?.path || ''; } catch { /* ignore */ }
  }
  const git = new Git({ path: gitPath || 'git', log });
  let gitMissing = false;
  try {
    log(`Using ${await git.version()} (${git.path})`);
  } catch (e) {
    gitMissing = true;
    log(`Git not found: ${e.message}`);
    vscode.window.showErrorMessage('Git Compass: Git is not installed (or not on PATH). Install it from git-scm.com, then reload the window.', 'Download Git')
      .then(p => p && vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads')));
  }

  manager = new RepoManager(git, { appendLine: log });
  context.subscriptions.push(manager);
  const github = new GitHub({ appendLine: log });
  context.subscriptions.push(github);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider(manager, github)),
    vscode.window.registerFileDecorationProvider(new StatusDecorationProvider()),
  );

  // ---- tree views ---------------------------------------------------------------------------
  const views = {
    changes: new trees.ChangesTree(manager),
    commits: new trees.CommitsTree(manager),
    branches: new trees.BranchesTree(manager),
    worktrees: new trees.WorktreesTree(manager),
    stashes: new trees.StashesTree(manager),
    tags: new trees.TagsTree(manager),
    fileHistory: new trees.FileHistoryTree(manager),
    compare: new trees.CompareTree(manager),
    reflog: new trees.ReflogTree(manager),
    pullRequests: new trees.PullRequestsTree(manager, github),
  };
  const treeViews = {};
  for (const [key, provider] of Object.entries(views)) {
    const tv = vscode.window.createTreeView(`gitCompass.${key}`, {
      treeDataProvider: provider,
      showCollapseAll: ['commits', 'branches', 'stashes', 'compare', 'pullRequests'].includes(key),
      canSelectMany: key === 'changes',
    });
    treeViews[key] = tv;
    context.subscriptions.push(tv);
  }

  const ctx = {
    extensionContext: context, extensionUri: context.extensionUri, manager, github, output, views, gitMissing,
  };
  ctx.graph = new GraphPanel(ctx);
  ctx.rebase = new RebasePanel(ctx);
  ctx.guide = new GuidePanel(ctx);
  ctx.blame = new BlameController(manager);
  context.subscriptions.push(ctx.blame);

  const overview = new OverviewProvider(ctx);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('gitCompass.overview', overview, { webviewOptions: { retainContextWhenHidden: true } }));
  ctx.graphView = new GraphView(ctx);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('gitCompass.graphView', ctx.graphView, { webviewOptions: { retainContextWhenHidden: true } }));

  new Commands(ctx).register(context);

  // ---- status bar ---------------------------------------------------------------------------
  const status = vscode.window.createStatusBarItem('gitCompass.status', vscode.StatusBarAlignment.Left, 99);
  status.name = 'Git Compass';
  status.command = 'gitCompass.overview.focus';
  context.subscriptions.push(status);

  // ---- react to repository changes ----------------------------------------------------------
  const updateChrome = () => {
    const m = manager.current;
    const s = m && m.state;
    vscode.commands.executeCommand('setContext', 'gitCompass.hasRepo', !!s);
    vscode.commands.executeCommand('setContext', 'gitCompass.multipleRepos', manager.all.length > 1);
    vscode.commands.executeCommand('setContext', 'gitCompass.operation', s && s.operation ? s.operation.kind : '');
    vscode.commands.executeCommand('setContext', 'gitCompass.hasRemote', !!(s && s.remotes.length));
    vscode.commands.executeCommand('setContext', 'gitCompass.isGitHub', !!(s && githubRemote(s.remotes)));
    if (!s) {
      status.hide();
      treeViews.changes.badge = undefined;
      return;
    }
    const branch = s.detached ? `detached ${String(s.oid || '').slice(0, 7)}` : (s.branch || '');
    const changes = s.staged.length + s.unstaged.length + s.untracked.length + s.conflicts.length;
    treeViews.changes.description = `${m.name} · ${branch}`;
    treeViews.commits.description = branch;
    treeViews.changes.badge = changes ? { value: changes, tooltip: `${changes} uncommitted change(s)` } : undefined;
    treeViews.changes.message = s.conflicts.length ? `⚠ ${s.conflicts.length} file(s) with conflicts — resolve them, then Continue in Overview.` : undefined;
    if (cfg('statusBar', true)) {
      let text = `$(compass) ${branch}`;
      if (s.operation) text += ` $(warning) ${s.operation.kind}`;
      if (s.ahead) text += ` $(arrow-up)${s.ahead}`;
      if (s.behind) text += ` $(arrow-down)${s.behind}`;
      if (changes) text += ` $(edit)${changes}`;
      status.text = text;
      status.tooltip = new vscode.MarkdownString(
        `**Git Compass** — ${m.name}\n\nBranch: \`${branch}\`${s.upstream ? ` → \`${s.upstream}\`` : ''}\n\n` +
        `${s.ahead ? `↑ ${s.ahead} to push  \n` : ''}${s.behind ? `↓ ${s.behind} to pull  \n` : ''}${changes ? `✎ ${changes} uncommitted change(s)  \n` : ''}\nClick to open Git Compass.`);
      status.show();
    } else status.hide();
  };

  context.subscriptions.push(
    manager.onDidChange(e => {
      updateChrome();
      views.changes.refresh();
      if (e.refsChanged || e.switched) {
        views.commits.refresh();
        views.branches.refresh();
        views.worktrees.refresh();
        views.stashes.refresh();
        views.tags.refresh();
        views.reflog.refresh();
        if (views.fileHistory.target) views.fileHistory.refresh();
      }
      if (e.switched) {
        views.pullRequests.refresh();
        if (views.compare.cmp && views.compare.cmp.model !== e.model) views.compare.clear();
      }
    }),
    manager.onDidChangeRepos(updateChrome),
    github.onDidChangeSession(() => views.pullRequests.refresh()),
    vscode.window.onDidChangeActiveTextEditor(e => views.fileHistory.onEditorChanged(e)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('gitCompass.viewAsTree')) {
        vscode.commands.executeCommand('setContext', 'gitCompass.viewAsTree', cfg('viewAsTree', false));
        Object.values(views).forEach(v => v.refresh());
      }
      if (e.affectsConfiguration('gitCompass.statusBar')) updateChrome();
      if (e.affectsConfiguration('gitCompass.autoFetch')) setupAutoFetch();
    }),
  );
  vscode.commands.executeCommand('setContext', 'gitCompass.viewAsTree', cfg('viewAsTree', false));

  // Repositories opened later by VS Code's Git extension (e.g. after cloning)
  try {
    const api = getBuiltinGitApi();
    if (api) context.subscriptions.push(api.onDidOpenRepository(() => manager.discover()));
  } catch { /* ignore */ }

  // ---- auto fetch ---------------------------------------------------------------------------
  let fetchTimer;
  function setupAutoFetch() {
    clearInterval(fetchTimer);
    const minutes = cfg('autoFetch', 10);
    if (!minutes || minutes <= 0) return;
    fetchTimer = setInterval(async () => {
      if (!vscode.window.state.focused) return;
      for (const m of manager.all) {
        if (!m.state || !m.state.remotes.length || m.state.operation) continue;
        try {
          await m.repo.run(['fetch', '--all', '--prune', '--quiet'], { quiet: true });
          await m.refresh();
        } catch { /* offline or needs credentials — silently skip */ }
      }
    }, Math.max(1, minutes) * 60 * 1000);
  }
  setupAutoFetch();
  context.subscriptions.push({ dispose: () => clearInterval(fetchTimer) });

  // ---- go! ----------------------------------------------------------------------------------
  if (!gitMissing) await manager.discover();
  updateChrome();
  views.fileHistory.onEditorChanged(vscode.window.activeTextEditor);

  if (!context.globalState.get('gitCompass.welcomed')) {
    context.globalState.update('gitCompass.welcomed', true);
    vscode.window.showInformationMessage('Welcome to Git Compass! 🧭 Find it in the compass icon on the left. Want a quick tour?', 'Open Guide', 'Take the Tour')
      .then(p => {
        if (p === 'Open Guide') ctx.guide.show();
        else if (p === 'Take the Tour') vscode.commands.executeCommand('gitCompass.openWalkthrough');
      });
  }

  return { manager, views, github }; // exposed for tests
}

function deactivate() {}

module.exports = { activate, deactivate };
